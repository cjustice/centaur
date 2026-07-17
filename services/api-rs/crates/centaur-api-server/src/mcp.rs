use std::{
    collections::BTreeMap,
    env, fs,
    path::PathBuf,
    str::FromStr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

#[cfg(test)]
use std::sync::LazyLock;

use axum::{
    Json,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use base64::{Engine as _, engine::general_purpose};
use centaur_session_core::{
    ExecutionStatus, HarnessType, MessageRole, SessionMessageInput, ThreadKey,
};
use centaur_session_runtime::{
    ExecuteSessionInput, HarnessConflictPolicy, SessionRuntime, SessionRuntimeError,
    ToolHostCallInput,
};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::{
    ApiError,
    api_jwt::jwt_signing_secret,
    routes::{AppState, header_value},
    tool_discovery::{DiscoveredTool, ToolDiscoveryConfig, discover_tool_catalog},
};

const MCP_AGENT_DEFAULT_MAX_DURATION_MS: u64 = 30 * 60 * 1_000;
const MCP_AGENT_MAX_DURATION_MS: u64 = 24 * 60 * 60 * 1_000;
const MCP_AGENT_IDEMPOTENCY_KEY_MAX_BYTES: usize = 256;
const MCP_AGENT_EVENTS_MAX_JSONRPC_RESPONSE_BYTES: usize = 64 * 1024;
const MCP_AGENT_EVENTS_RESPONSE_ENVELOPE_BYTES: usize = 8 * 1024;
const MCP_AGENT_EVENTS_MAX_RESPONSE_BYTES: usize =
    MCP_AGENT_EVENTS_MAX_JSONRPC_RESPONSE_BYTES - MCP_AGENT_EVENTS_RESPONSE_ENVELOPE_BYTES;
const MCP_JSON_RPC_ID_MAX_BYTES: usize = 1024;
const MCP_AGENT_SCOPE: &str = "agents:execute";

pub(crate) async fn mcp_get() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        Json(json!({
            "ok": false,
            "error": "MCP Streamable HTTP requests must use POST for this endpoint",
        })),
    )
        .into_response()
}

pub(crate) async fn mcp_protected_resource_metadata(headers: HeaderMap) -> Json<Value> {
    let authorization_servers = mcp_authorization_server_url()
        .into_iter()
        .collect::<Vec<_>>();
    Json(json!({
        "resource": mcp_resource_url(&headers),
        "authorization_servers": authorization_servers,
        "bearer_methods_supported": ["header"],
        "scopes_supported": ["mcp:tools", MCP_AGENT_SCOPE],
    }))
}

#[derive(Debug, Deserialize)]
pub(crate) struct McpJsonRpcRequest {
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Deserialize)]
struct McpToolCallParams {
    name: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct CentaurToolMcpArguments {
    method: String,
    #[serde(default)]
    arguments: Value,
}

#[derive(Debug, Deserialize)]
struct McpAgentStartArguments {
    prompt: String,
    idempotency_key: String,
    #[serde(default)]
    harness: Option<String>,
    #[serde(default)]
    persona_id: Option<String>,
    #[serde(default)]
    thread_key: Option<String>,
    #[serde(default)]
    idle_timeout_ms: Option<u64>,
    #[serde(default)]
    max_duration_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct McpAgentEventsArguments {
    execution_id: String,
    #[serde(default)]
    after_event_id: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct McpAgentCancelArguments {
    execution_id: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct McpPrincipal {
    token_id: String,
    principal_id: String,
    name: String,
    scopes: Vec<String>,
    expires_at: Option<OffsetDateTime>,
    user_sub: Option<String>,
    email: Option<String>,
}

pub(crate) async fn mcp_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<McpJsonRpcRequest>,
) -> Result<Response, ApiError> {
    let Some(principal) = authenticate_mcp_bearer(&headers)? else {
        return Ok(mcp_unauthorized(&headers));
    };
    if !ensure_mcp_principal_active(&state.pool()?, &principal).await? {
        return Ok(mcp_unauthorized(&headers));
    }
    if request.jsonrpc.as_deref().unwrap_or("2.0") != "2.0" {
        return Ok(mcp_json_error(
            request.id.unwrap_or(Value::Null),
            -32600,
            "invalid JSON-RPC version",
        ));
    }
    let Some(id) = request.id.clone() else {
        return Ok(StatusCode::NO_CONTENT.into_response());
    };
    if serde_json::to_vec(&id)?.len() > MCP_JSON_RPC_ID_MAX_BYTES {
        return Ok(mcp_json_error(
            Value::Null,
            -32600,
            "JSON-RPC id is too large",
        ));
    }

    let result = match request.method.as_str() {
        "initialize" => json!({
            "protocolVersion": requested_mcp_protocol_version(&request.params),
            "capabilities": {
                "tools": {
                    "listChanged": false,
                },
            },
            "serverInfo": {
                "name": "centaur",
                "version": env!("CARGO_PKG_VERSION"),
            },
        }),
        "ping" => json!({}),
        "tools/list" => {
            ensure_mcp_scope(&principal.scopes, "mcp:tools")?;
            let mut tools = vec![mcp_whoami_tool()];
            if has_scope(&principal.scopes, MCP_AGENT_SCOPE, "agents:*") {
                tools.extend(mcp_agent_tool_entries());
            }
            tools.extend(mcp_centaur_tool_entries()?);
            json!({
                "tools": tools,
            })
        }
        "tools/call" => {
            ensure_mcp_scope(&principal.scopes, "mcp:tools")?;
            let params = serde_json::from_value::<McpToolCallParams>(request.params.clone())
                .map_err(|error| ApiError::BadRequest(error.to_string()))?;
            if params.name == "centaur_whoami" {
                mcp_whoami_result(&principal, params.arguments)?
            } else if params.name == "centaur_agent_start" {
                ensure_scope(&principal.scopes, MCP_AGENT_SCOPE, "agents:*")?;
                match mcp_agent_start_result(&state, &principal, params.arguments).await {
                    Ok(result) => result,
                    Err(error) => mcp_agent_domain_error_result(error)?,
                }
            } else if params.name == "centaur_agent_events" {
                ensure_scope(&principal.scopes, MCP_AGENT_SCOPE, "agents:*")?;
                match mcp_agent_events_result(&state, &principal, params.arguments).await {
                    Ok(result) => result,
                    Err(error) => mcp_agent_domain_error_result(error)?,
                }
            } else if params.name == "centaur_agent_cancel" {
                ensure_scope(&principal.scopes, MCP_AGENT_SCOPE, "agents:*")?;
                match mcp_agent_cancel_result(&state, &principal, params.arguments).await {
                    Ok(result) => result,
                    Err(error) => mcp_agent_domain_error_result(error)?,
                }
            } else {
                let Some(tool) = mcp_find_centaur_tool(&params.name)? else {
                    return Ok(mcp_json_error(id, -32602, "unknown tool"));
                };
                mcp_centaur_tool_result(&state, &principal, tool, params.arguments).await?
            }
        }
        _ => return Ok(mcp_json_error(id, -32601, "method not found")),
    };

    Ok(Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    }))
    .into_response())
}

fn mcp_whoami_tool() -> Value {
    json!({
        "name": "centaur_whoami",
        "description": "Show the authenticated Centaur MCP principal and token metadata.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": false,
        },
    })
}

fn mcp_agent_tool_entries() -> Vec<Value> {
    vec![
        json!({
            "name": "centaur_agent_start",
            "description": "Start or continue a durable Centaur coding-agent execution. The execution is owned by the authenticated principal, not by the current OAuth access token; use centaur_agent_events to read progress after reconnecting or refreshing credentials.",
            "inputSchema": {
                "type": "object",
                "required": ["prompt", "idempotency_key"],
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "Instruction to run in the sub-agent sandbox."
                    },
                    "idempotency_key": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MCP_AGENT_IDEMPOTENCY_KEY_MAX_BYTES,
                        "description": "Caller-generated key identifying this start request. Retrying the same key returns the same thread and execution without submitting the prompt again."
                    },
                    "harness": {
                        "type": "string",
                        "description": "Harness to run: codex, amp, or claudecode. New threads default to the deployment harness; existing threads keep their current harness."
                    },
                    "persona_id": {
                        "type": "string",
                        "description": "Optional Centaur persona id."
                    },
                    "thread_key": {
                        "type": "string",
                        "description": "Optional existing agent thread key returned by centaur_agent_start."
                    },
                    "idle_timeout_ms": {
                        "type": "integer",
                        "minimum": 1
                    },
                    "max_duration_ms": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MCP_AGENT_MAX_DURATION_MS,
                        "description": "Maximum execution duration. Defaults to 30 minutes and cannot exceed 24 hours; execution lifetime is independent of the OAuth access-token lifetime."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "centaur_agent_events",
            "description": "Read one bounded page of durable events for an exact Centaur coding-agent execution.",
            "inputSchema": {
                "type": "object",
                "required": ["execution_id"],
                "properties": {
                    "execution_id": {
                        "type": "string",
                        "description": "Execution id returned by centaur_agent_start."
                    },
                    "after_event_id": {
                        "type": "integer",
                        "description": "Only return events with event_id greater than this value."
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 500,
                        "description": "Maximum events to return. Defaults to 100. Continue immediately while has_more is true, passing next_after_event_id as after_event_id."
                    }
                },
                "additionalProperties": false
            }
        }),
        json!({
            "name": "centaur_agent_cancel",
            "description": "Ask one exact active Centaur coding-agent execution to stop. A delayed request cannot affect a later execution on the same thread.",
            "inputSchema": {
                "type": "object",
                "required": ["execution_id"],
                "properties": {
                    "execution_id": {
                        "type": "string",
                        "description": "Execution id returned by centaur_agent_start."
                    },
                    "reason": {
                        "type": "string",
                        "description": "Optional cancellation reason."
                    }
                },
                "additionalProperties": false
            }
        }),
    ]
}

fn mcp_centaur_tool_entries() -> Result<Vec<Value>, ApiError> {
    let mut entries = Vec::new();
    for tool in mcp_centaur_tool_catalog()? {
        let methods = mcp_tool_methods(&tool);
        let signatures = methods
            .iter()
            .map(|method| method.signature.as_str())
            .collect::<Vec<_>>();
        let names = methods
            .iter()
            .map(|method| method.name.as_str())
            .collect::<Vec<_>>();
        let mut description = tool
            .description
            .clone()
            .unwrap_or_else(|| format!("Centaur tool package {}", tool.package));
        if !methods.is_empty() {
            description.push_str(" Available methods: ");
            description.push_str(&signatures.join(", "));
            description.push_str(". Pass keyword arguments matching the method signature; call method=help for this list.");
        }
        let mut method_schema = json!({
            "type": "string",
            "description": "Public method on the tool client to call. Use help to list available methods.",
        });
        if !methods.is_empty() {
            method_schema["enum"] = json!(names);
        }
        entries.push(json!({
            "name": tool.name,
            "description": description,
            "inputSchema": {
                "type": "object",
                "required": ["method"],
                "properties": {
                    "method": method_schema,
                    "arguments": {
                        "type": "object",
                        "description": "Keyword arguments passed to the selected method.",
                        "additionalProperties": true,
                    },
                },
                "additionalProperties": false,
            },
        }));
    }
    Ok(entries)
}

struct McpToolMethod {
    name: String,
    signature: String,
}

fn mcp_tool_methods(tool: &DiscoveredTool) -> Vec<McpToolMethod> {
    let mut methods = BTreeMap::from([("help".to_owned(), "help()".to_owned())]);
    let path = tool.project_dir.join(&tool.client_module);
    if let Ok(contents) = fs::read_to_string(&path) {
        for line in contents.lines() {
            let indent = line.chars().take_while(|ch| *ch == ' ').count();
            if indent != 0 && indent != 4 {
                continue;
            }
            let trimmed = line.trim_start();
            let definition = trimmed
                .strip_prefix("def ")
                .or_else(|| trimmed.strip_prefix("async def "));
            let Some(definition) = definition else {
                continue;
            };
            let Some((name, params)) = definition.split_once('(') else {
                continue;
            };
            let name = name.trim();
            if name.is_empty() || name.starts_with('_') {
                continue;
            }
            methods.insert(name.to_owned(), mcp_method_signature(name, params));
        }
    }
    methods
        .into_iter()
        .map(|(name, signature)| McpToolMethod { name, signature })
        .collect()
}

/// Render `name(params)` from the text after the opening paren of a `def`
/// line, dropping a leading `self`. Multi-line parameter lists fall back to
/// `name(...)`.
fn mcp_method_signature(name: &str, params: &str) -> String {
    let mut depth = 1usize;
    let Some(end) = params.find(|ch| {
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            _ => {}
        }
        depth == 0
    }) else {
        return format!("{name}(...)");
    };
    let mut params = params[..end].trim();
    if let Some(rest) = params.strip_prefix("self") {
        params = rest.trim_start().trim_start_matches(',').trim_start();
    }
    format!("{name}({params})")
}

fn mcp_tool_help_result(
    tool: &DiscoveredTool,
    methods: &[McpToolMethod],
) -> Result<Value, ApiError> {
    Ok(mcp_text_result(
        serde_json::to_string_pretty(&json!({
            "tool": tool.name,
            "description": tool.description,
            "methods": methods
                .iter()
                .map(|method| method.signature.as_str())
                .collect::<Vec<_>>(),
            "usage": "Call this tool with {\"method\": \"<name>\", \"arguments\": {<keyword arguments matching the signature>}}.",
        }))?,
        false,
    ))
}

fn mcp_centaur_tool_catalog() -> Result<Vec<DiscoveredTool>, ApiError> {
    // Discovery scans the tool dirs and parses package metadata on every
    // call; reuse a recent result so each MCP request does not redo that
    // I/O while still picking up newly synced tools quickly. Tests point
    // the discovery env vars at per-case temp dirs, so they read live.
    const CATALOG_TTL: Duration = Duration::from_secs(10);
    static CATALOG_CACHE: Mutex<Option<(Instant, Vec<DiscoveredTool>)>> = Mutex::new(None);
    if !cfg!(test)
        && let Some((discovered_at, tools)) = CATALOG_CACHE.lock().unwrap().as_ref()
        && discovered_at.elapsed() < CATALOG_TTL
    {
        return Ok(tools.clone());
    }

    let dirs = ToolDiscoveryConfig {
        tool_dirs: env::var("TOOL_DIRS").ok(),
        public_tool_dirs: env::var("KUBERNETES_PUBLIC_TOOL_DIRS").ok(),
        tools_path: env::var("TOOLS_PATH").ok().map(PathBuf::from),
        tools_overlay_path: env::var("TOOLS_OVERLAY_PATH").ok().map(PathBuf::from),
        plugins_dir: env::var("PLUGINS_DIR").ok().map(PathBuf::from),
        tools_config: env::var("TOOLS_CONFIG").ok().map(PathBuf::from),
    }
    .resolve_tool_dirs()
    .map_err(|error| ApiError::Internal(error.to_string()))?;
    let tools = discover_tool_catalog(&dirs)
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .tools;
    if !cfg!(test) {
        *CATALOG_CACHE.lock().unwrap() = Some((Instant::now(), tools.clone()));
    }
    Ok(tools)
}

fn mcp_find_centaur_tool(name: &str) -> Result<Option<DiscoveredTool>, ApiError> {
    Ok(mcp_centaur_tool_catalog()?
        .into_iter()
        .find(|tool| tool.name == name))
}

fn mcp_whoami_result(principal: &McpPrincipal, arguments: Value) -> Result<Value, ApiError> {
    if !arguments.is_null() && !arguments.as_object().is_some_and(serde_json::Map::is_empty) {
        return Err(ApiError::BadRequest(
            "centaur_whoami does not accept arguments".to_owned(),
        ));
    }
    Ok(mcp_text_result(
        serde_json::to_string_pretty(&json!({
            "principal_id": principal.principal_id,
            "token_id": principal.token_id,
            "token_name": principal.name,
            "scopes": principal.scopes,
            "expires_at": principal
                .expires_at
                .map(|value| value.format(&time::format_description::well_known::Rfc3339))
                .transpose()
                .map_err(|error| ApiError::Internal(error.to_string()))?,
        }))?,
        false,
    ))
}

async fn mcp_agent_start_result(
    state: &AppState,
    principal: &McpPrincipal,
    arguments: Value,
) -> Result<Value, ApiError> {
    let params = serde_json::from_value::<McpAgentStartArguments>(arguments)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let prompt = params.prompt.trim().to_owned();
    if prompt.is_empty() {
        return Err(ApiError::BadRequest("prompt is required".to_owned()));
    }
    let idempotency_key = params.idempotency_key.trim().to_owned();
    if idempotency_key.is_empty() {
        return Err(ApiError::BadRequest(
            "idempotency_key is required".to_owned(),
        ));
    }
    if idempotency_key.len() > MCP_AGENT_IDEMPOTENCY_KEY_MAX_BYTES {
        return Err(ApiError::BadRequest(format!(
            "idempotency_key cannot exceed {MCP_AGENT_IDEMPOTENCY_KEY_MAX_BYTES} bytes"
        )));
    }
    let max_duration_ms =
        mcp_agent_duration_options(params.idle_timeout_ms, params.max_duration_ms)?;
    let thread_key = match params.thread_key.as_deref() {
        Some(thread_key) => mcp_validate_agent_thread_key(principal, thread_key)?,
        None => mcp_generate_agent_thread_key(principal, &idempotency_key)?,
    };
    let runtime = state.runtime()?;
    let harness = match params.harness.as_deref() {
        Some(harness) if !harness.trim().is_empty() => mcp_parse_agent_harness(harness)?,
        _ if params.thread_key.is_some() => runtime.session(&thread_key).await?.harness_type,
        _ => runtime.default_harness(),
    };
    let metadata = mcp_agent_session_metadata(principal);
    let request_fingerprint = mcp_agent_request_fingerprint(
        &prompt,
        &harness,
        params.persona_id.as_deref(),
        params.idle_timeout_ms,
        max_duration_ms,
    )?;
    let execution_metadata = mcp_agent_execution_metadata(principal, &request_fingerprint);
    let session = runtime
        .create_or_get_external_session(
            &thread_key,
            &harness,
            params.persona_id.as_deref(),
            Some(metadata.clone()),
            HarnessConflictPolicy::Reject,
            &principal.principal_id,
        )
        .await?;
    let input_line = mcp_agent_input_line(&thread_key, &prompt, &execution_metadata)?;
    let execution = runtime
        .execute_external_session_with_messages(
            &thread_key,
            ExecuteSessionInput {
                idempotency_key: Some(idempotency_key.clone()),
                metadata: Some(execution_metadata),
                input_lines: vec![input_line],
                idle_timeout_ms: params.idle_timeout_ms,
                max_duration_ms: Some(max_duration_ms),
            },
            &[SessionMessageInput {
                client_message_id: Some(idempotency_key),
                role: MessageRole::User,
                parts: vec![json!({
                    "type": "text",
                    "text": prompt,
                })],
                metadata: metadata.clone(),
            }],
            &principal.principal_id,
        )
        .await?;
    mcp_json_result(json!({
        "thread_key": thread_key,
        "execution_id": execution.execution_id,
        "status": execution.status,
        "harness": session.session.harness_type,
        "harness_switched": session.harness_switched,
    }))
}

async fn mcp_agent_events_result(
    state: &AppState,
    principal: &McpPrincipal,
    arguments: Value,
) -> Result<Value, ApiError> {
    let params = serde_json::from_value::<McpAgentEventsArguments>(arguments)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let execution_id = params.execution_id.trim();
    if execution_id.is_empty() {
        return Err(ApiError::BadRequest("execution_id is required".to_owned()));
    }
    let after_event_id = params.after_event_id.unwrap_or(0);
    if after_event_id < 0 {
        return Err(ApiError::BadRequest(
            "after_event_id must be greater than or equal to zero".to_owned(),
        ));
    }
    let limit = params.limit.unwrap_or(100);
    if !(1..=500).contains(&limit) {
        return Err(ApiError::BadRequest(
            "limit must be between 1 and 500".to_owned(),
        ));
    }
    let runtime = state.runtime()?;
    let execution = runtime
        .external_execution(execution_id, &principal.principal_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("execution not found".to_owned()))?;
    let thread_key = execution.thread_key;
    let events = runtime
        .list_external_events(
            &thread_key,
            after_event_id,
            Some(execution_id),
            limit + 1,
            &principal.principal_id,
        )
        .await?;
    let page = mcp_agent_event_page(events, limit as usize, MCP_AGENT_EVENTS_MAX_RESPONSE_BYTES)?;
    let last_event_id = page.last_event_id;
    let next_after_event_id = last_event_id.unwrap_or(after_event_id);
    let execution_status = runtime
        .external_execution_status(&thread_key, execution_id, &principal.principal_id)
        .await?;
    let terminal_status = mcp_terminal_status_from_execution_status(execution_status.as_ref());
    let terminal_event_observed = match execution_status.as_ref() {
        Some(status) => {
            mcp_terminal_event_visible_in_values(&page.events, execution_id, status)
                || runtime
                    .external_terminal_event_observed_after(
                        &thread_key,
                        execution_id,
                        status,
                        after_event_id,
                        &principal.principal_id,
                    )
                    .await?
        }
        None => false,
    };
    let result = json!({
        "thread_key": thread_key,
        "execution_id": execution_id,
        "events": page.events,
        "last_event_id": last_event_id,
        "next_after_event_id": next_after_event_id,
        "status": execution_status,
        "terminal_status": terminal_status,
        "terminal_event_observed": terminal_event_observed,
        "has_more": page.has_more,
        "byte_budget": page.byte_budget,
        "serialized_event_bytes": page.serialized_event_bytes,
    });
    mcp_json_result_with_text(
        result,
        format!(
            "agent events page: {} event(s), last_event_id={}, has_more={}, serialized_event_bytes={}/{}; see structuredContent for event payloads",
            page.event_count,
            last_event_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "none".to_owned()),
            page.has_more,
            page.serialized_event_bytes,
            page.byte_budget
        ),
    )
}

async fn mcp_agent_cancel_result(
    state: &AppState,
    principal: &McpPrincipal,
    arguments: Value,
) -> Result<Value, ApiError> {
    let params = serde_json::from_value::<McpAgentCancelArguments>(arguments)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let execution_id = params.execution_id.trim();
    if execution_id.is_empty() {
        return Err(ApiError::BadRequest("execution_id is required".to_owned()));
    }
    let runtime = state.runtime()?;
    let execution = runtime
        .external_execution(execution_id, &principal.principal_id)
        .await?
        .ok_or_else(|| ApiError::NotFound("execution not found".to_owned()))?;
    let reason = params
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Interrupted from MCP");
    let outcome = runtime
        .interrupt_external_execution(
            &execution.thread_key,
            execution_id,
            reason,
            &principal.principal_id,
        )
        .await?;
    mcp_json_result(json!({
        "thread_key": execution.thread_key,
        "interrupted": outcome.interrupted,
        "execution_id": outcome.execution_id,
    }))
}

fn mcp_agent_input_line(
    thread_key: &ThreadKey,
    prompt: &str,
    trace_metadata: &Value,
) -> Result<String, ApiError> {
    Ok(serde_json::to_string(&json!({
        "type": "user",
        "thread_key": thread_key,
        "trace_metadata": trace_metadata,
        "message": {
            "role": "user",
            "content": [{
                "type": "text",
                "text": prompt,
            }],
        },
    }))?)
}

fn mcp_parse_agent_harness(value: &str) -> Result<HarnessType, ApiError> {
    let value = value.trim();
    HarnessType::from_str(value)
        .map_err(|_| ApiError::BadRequest(format!("unsupported harness {value:?}")))
}

fn mcp_generate_agent_thread_key(
    principal: &McpPrincipal,
    idempotency_key: &str,
) -> Result<ThreadKey, ApiError> {
    let digest = Sha256::digest(idempotency_key.as_bytes());
    ThreadKey::parse(format!(
        "{}{}",
        mcp_agent_thread_prefix(principal),
        hex::encode(&digest[..16])
    ))
    .map_err(Into::into)
}

fn mcp_validate_agent_thread_key(
    principal: &McpPrincipal,
    value: &str,
) -> Result<ThreadKey, ApiError> {
    let thread_key = ThreadKey::parse(value.trim().to_owned())?;
    let prefix = mcp_agent_thread_prefix(principal);
    if !thread_key.as_str().starts_with(&prefix) {
        return Err(ApiError::Forbidden(
            "agent thread_key does not belong to this principal".to_owned(),
        ));
    }
    Ok(thread_key)
}

fn mcp_agent_thread_prefix(principal: &McpPrincipal) -> String {
    let digest = Sha256::digest(principal.principal_id.as_bytes());
    format!("agent:{}:", hex::encode(&digest[..12]))
}

fn mcp_agent_session_metadata(principal: &McpPrincipal) -> Value {
    json!({
        "agent_api": true,
        "agent_principal_id": principal.principal_id,
    })
}

fn mcp_agent_execution_metadata(principal: &McpPrincipal, request_fingerprint: &str) -> Value {
    json!({
        "agent_api": true,
        "agent_principal_id": principal.principal_id,
        "agent_request_fingerprint": request_fingerprint,
    })
}

fn mcp_terminal_status_from_execution_status(
    status: Option<&ExecutionStatus>,
) -> Option<&'static str> {
    match status {
        Some(ExecutionStatus::Completed) => Some("completed"),
        Some(ExecutionStatus::Failed) => Some("failed"),
        Some(ExecutionStatus::Cancelled) => Some("cancelled"),
        Some(ExecutionStatus::Queued | ExecutionStatus::Running) | None => None,
    }
}

#[cfg(test)]
fn mcp_terminal_event_visible_in_events(
    events: &[centaur_session_core::SessionEvent],
    execution_id: &str,
    status: &ExecutionStatus,
) -> bool {
    let Some(event_type) = mcp_terminal_event_type_for_status(status) else {
        return false;
    };
    events.iter().any(|event| {
        event.execution_id.as_deref() == Some(execution_id) && event.event_type == event_type
    })
}

fn mcp_terminal_event_visible_in_values(
    events: &[Value],
    execution_id: &str,
    status: &ExecutionStatus,
) -> bool {
    let Some(event_type) = mcp_terminal_event_type_for_status(status) else {
        return false;
    };
    events.iter().any(|event| {
        event.get("execution_id").and_then(Value::as_str) == Some(execution_id)
            && event.get("event_type").and_then(Value::as_str) == Some(event_type)
    })
}

#[derive(Debug, PartialEq)]
struct McpAgentEventPage {
    events: Vec<Value>,
    event_count: usize,
    last_event_id: Option<i64>,
    has_more: bool,
    byte_budget: usize,
    serialized_event_bytes: usize,
}

fn mcp_agent_event_page(
    events: Vec<centaur_session_core::SessionEvent>,
    limit: usize,
    byte_budget: usize,
) -> Result<McpAgentEventPage, ApiError> {
    let total_events = events.len();
    let mut selected = Vec::new();
    let mut selected_bytes = 0usize;
    let mut last_event_id = None;
    let mut has_more = total_events > limit;

    for (index, event) in events.into_iter().take(limit + 1).enumerate() {
        if index >= limit {
            has_more = true;
            break;
        }

        let serialized = serde_json::to_vec(&event)?;
        if serialized.len() > byte_budget {
            if selected.is_empty() {
                let summary = mcp_oversized_event_summary(&event, serialized.len());
                let summary_bytes = serde_json::to_vec(&summary)?.len();
                selected_bytes = summary_bytes.min(byte_budget);
                last_event_id = Some(event.event_id);
                selected.push(summary);
                has_more = total_events > 1;
            } else {
                has_more = true;
            }
            break;
        }
        if selected_bytes + serialized.len() > byte_budget {
            has_more = true;
            break;
        }

        let value = serde_json::from_slice(&serialized)?;
        selected_bytes += serialized.len();
        last_event_id = Some(event.event_id);
        selected.push(value);
    }

    Ok(McpAgentEventPage {
        event_count: selected.len(),
        events: selected,
        last_event_id,
        has_more,
        byte_budget,
        serialized_event_bytes: selected_bytes,
    })
}

fn mcp_oversized_event_summary(
    event: &centaur_session_core::SessionEvent,
    original_serialized_bytes: usize,
) -> Value {
    json!({
        "event_id": event.event_id,
        "thread_key": event.thread_key,
        "execution_id": event.execution_id,
        "event_type": event.event_type,
        "created_at": event.created_at,
        "payload": {
            "centaur_mcp_truncated": true,
            "reason": "event exceeded MCP response byte budget",
            "original_serialized_bytes": original_serialized_bytes,
        },
    })
}

fn mcp_terminal_event_type_for_status(status: &ExecutionStatus) -> Option<&'static str> {
    match status {
        ExecutionStatus::Completed => Some("session.execution_completed"),
        ExecutionStatus::Failed => Some("session.execution_failed"),
        ExecutionStatus::Cancelled => Some("session.execution_cancelled"),
        ExecutionStatus::Queued | ExecutionStatus::Running => None,
    }
}

fn mcp_agent_duration_options(
    idle_timeout_ms: Option<u64>,
    max_duration_ms: Option<u64>,
) -> Result<u64, ApiError> {
    let max_duration_ms = max_duration_ms.unwrap_or(MCP_AGENT_DEFAULT_MAX_DURATION_MS);
    if max_duration_ms == 0 {
        return Err(ApiError::BadRequest(
            "max_duration_ms must be greater than zero".to_owned(),
        ));
    }
    if max_duration_ms > MCP_AGENT_MAX_DURATION_MS {
        return Err(ApiError::BadRequest(format!(
            "max_duration_ms cannot exceed {MCP_AGENT_MAX_DURATION_MS}"
        )));
    }
    if idle_timeout_ms == Some(0) {
        return Err(ApiError::BadRequest(
            "idle_timeout_ms must be greater than zero".to_owned(),
        ));
    }
    if idle_timeout_ms.is_some_and(|idle_timeout_ms| idle_timeout_ms > max_duration_ms) {
        return Err(ApiError::BadRequest(
            "idle_timeout_ms must be less than or equal to max_duration_ms".to_owned(),
        ));
    }
    Ok(max_duration_ms)
}

fn mcp_agent_request_fingerprint(
    prompt: &str,
    harness: &HarnessType,
    persona_id: Option<&str>,
    idle_timeout_ms: Option<u64>,
    max_duration_ms: u64,
) -> Result<String, ApiError> {
    let encoded = serde_json::to_vec(&json!({
        "prompt": prompt,
        "harness": harness,
        "persona_id": persona_id,
        "idle_timeout_ms": idle_timeout_ms,
        "max_duration_ms": max_duration_ms,
    }))?;
    Ok(hex::encode(Sha256::digest(encoded)))
}

async fn mcp_centaur_tool_result(
    state: &AppState,
    principal: &McpPrincipal,
    tool: DiscoveredTool,
    arguments: Value,
) -> Result<Value, ApiError> {
    let params = serde_json::from_value::<CentaurToolMcpArguments>(arguments)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    if params.method.trim().is_empty() {
        return Err(ApiError::BadRequest("method is required".to_owned()));
    }
    let method = params.method.trim().to_owned();
    let methods = mcp_tool_methods(&tool);
    if method == "help" {
        return mcp_tool_help_result(&tool, &methods);
    }
    if !methods.iter().any(|candidate| candidate.name == method) {
        return Ok(mcp_text_result(
            format!(
                "centaur tool {} has no method {method}. Available methods: {}",
                tool.name,
                methods
                    .iter()
                    .map(|method| method.signature.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            true,
        ));
    }
    run_tool_host_centaur_tool(
        state.runtime()?,
        principal,
        &tool,
        &method,
        params.arguments,
    )
    .await
}

async fn run_tool_host_centaur_tool(
    runtime: SessionRuntime,
    principal: &McpPrincipal,
    tool: &DiscoveredTool,
    method: &str,
    arguments: Value,
) -> Result<Value, ApiError> {
    let output = runtime
        .run_tool_host_call(ToolHostCallInput {
            principal_id: principal.principal_id.clone(),
            token_id: Some(principal.token_id.clone()),
            tool_name: tool.name.clone(),
            method: method.to_owned(),
            arguments,
            timeout: Duration::from_secs(120),
        })
        .await?;
    if output.timed_out {
        return Ok(mcp_text_result(
            format!(
                "centaur tool {}.{method} timed out in sandbox {}: {}",
                tool.name, output.sandbox_id, output.stderr
            ),
            true,
        ));
    }
    if output.exit_status != Some(0) {
        let raw = if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        };
        let detail = mcp_tool_failure_detail(raw);
        return Ok(mcp_text_result(
            format!(
                "centaur tool {}.{method} failed in sandbox {} with status {:?}: {detail}\n\nCall the {} tool with method \"help\" to list available methods and their signatures.",
                tool.name, output.sandbox_id, output.exit_status, tool.name
            ),
            true,
        ));
    }
    let stdout = output.stdout.trim();
    if stdout.is_empty() {
        return Ok(mcp_text_result("null".to_owned(), false));
    }
    match serde_json::from_str::<Value>(stdout) {
        Ok(value) => Ok(mcp_text_result(
            serde_json::to_string_pretty(&value)?,
            false,
        )),
        Err(error) => Ok(mcp_text_result(
            format!(
                "centaur tool {}.{method} returned non-json output in sandbox {}: {error}: {stdout}",
                tool.name, output.sandbox_id
            ),
            true,
        )),
    }
}

/// Reduce a Python traceback to its final exception message: agents act on
/// the error line, not on stack frames or build noise, so keep everything
/// from the last traceback's exception message to the end.
fn mcp_tool_failure_detail(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(index) = trimmed.rfind("Traceback (most recent call last):") else {
        return trimmed.to_owned();
    };
    let lines = trimmed[index..].lines().collect::<Vec<_>>();
    let message_start = lines
        .iter()
        .skip(1)
        .position(|line| !line.is_empty() && !line.starts_with(char::is_whitespace));
    match message_start {
        Some(position) => lines[position + 1..].join("\n"),
        None => trimmed.to_owned(),
    }
}

fn mcp_text_result(text: String, is_error: bool) -> Value {
    json!({
        "content": [
            {
                "type": "text",
                "text": text,
            },
        ],
        "isError": is_error,
    })
}

fn mcp_json_result(value: Value) -> Result<Value, ApiError> {
    let text = format!(
        "structured JSON result ({} bytes); see structuredContent",
        serde_json::to_vec(&value)?.len()
    );
    mcp_json_result_with_text(value, text)
}

fn mcp_json_result_with_text(value: Value, text: String) -> Result<Value, ApiError> {
    Ok(json!({
        "content": [{
            "type": "text",
            "text": text,
        }],
        "structuredContent": value,
        "isError": false,
    }))
}

fn mcp_agent_domain_error_result(error: ApiError) -> Result<Value, ApiError> {
    let is_domain_error = matches!(
        &error,
        ApiError::BadRequest(_) | ApiError::Forbidden(_) | ApiError::NotFound(_)
    ) || matches!(
        &error,
        ApiError::Runtime(SessionRuntimeError::BadRequest(_))
            | ApiError::Runtime(SessionRuntimeError::CapacityExceeded { .. })
            | ApiError::Runtime(SessionRuntimeError::Store(
                centaur_session_sqlx::SessionStoreError::NotFound { .. }
                    | centaur_session_sqlx::SessionStoreError::HarnessConflict { .. }
                    | centaur_session_sqlx::SessionStoreError::PersonaConflict { .. }
            ))
    );
    if is_domain_error {
        return Ok(mcp_text_result(error.to_string(), true));
    }
    Err(error)
}

fn authenticate_mcp_bearer(headers: &HeaderMap) -> Result<Option<McpPrincipal>, ApiError> {
    let Some(token) = bearer_token(headers) else {
        return Ok(None);
    };
    verify_mcp_jwt(&token)
}

async fn ensure_mcp_principal_active(
    pool: &sqlx::PgPool,
    principal: &McpPrincipal,
) -> Result<bool, ApiError> {
    let Some(email) = principal
        .email
        .as_deref()
        .map(str::trim)
        .filter(|email| !email.is_empty())
    else {
        return Ok(false);
    };
    if principal
        .user_sub
        .as_deref()
        .map(str::trim)
        .filter(|sub| sub.starts_with("usr_"))
        .is_none()
    {
        return Ok(false);
    }

    // Console access tokens put the console user oid in `sub`, but that oid is
    // Sqids-derived and not stored in public.users. The signed `email` claim is
    // minted by the console from users.email after cryptographic JWT validation,
    // and users.email is unique, so it is the non-request-spoofable account key
    // this Rust service can verify directly against the shared Postgres data.
    Ok(mcp_console_user_status(pool, email).await?.as_deref() == Some("active"))
}

const MCP_ACTIVE_USER_STATUS_SQL: &str =
    "select status from public.users where lower(email) = lower($1) limit 1";

async fn mcp_console_user_status(
    pool: &sqlx::PgPool,
    email: &str,
) -> Result<Option<String>, ApiError> {
    if let Some(status) = mcp_test_console_user_status(email) {
        return Ok(status);
    }
    sqlx::query_scalar::<_, String>(MCP_ACTIVE_USER_STATUS_SQL)
        .bind(email)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::from)
}

#[cfg(test)]
fn mcp_test_console_user_status(email: &str) -> Option<Option<String>> {
    MCP_TEST_USER_STATUSES
        .lock()
        .unwrap()
        .as_ref()
        .map(|statuses| statuses.get(&email.to_ascii_lowercase()).cloned().flatten())
}

#[cfg(not(test))]
fn mcp_test_console_user_status(_email: &str) -> Option<Option<String>> {
    None
}

#[cfg(test)]
type McpTestUserStatuses = BTreeMap<String, Option<String>>;

#[cfg(test)]
static MCP_TEST_USER_STATUSES: LazyLock<Mutex<Option<McpTestUserStatuses>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Deserialize)]
struct McpJwtHeader {
    alg: String,
}

#[derive(Debug, Deserialize)]
struct McpJwtClaims {
    aud: Value,
    exp: i64,
    #[serde(default)]
    iat: Option<i64>,
    iss: String,
    #[serde(default)]
    jti: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    nbf: Option<i64>,
    principal_id: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    scopes: Option<Vec<String>>,
    #[serde(default)]
    sub: Option<String>,
}

fn verify_mcp_jwt(token: &str) -> Result<Option<McpPrincipal>, ApiError> {
    let secret = jwt_signing_secret()
        .filter(|secret| !secret.trim().is_empty())
        .ok_or_else(|| {
            ApiError::ServiceUnavailable("CENTAUR_JWT_SIGNING_SECRET is not configured".to_owned())
        })?;

    let parts = token.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Ok(None);
    }
    let Some(header) = decode_base64url_json::<McpJwtHeader>(parts[0]) else {
        return Ok(None);
    };
    if header.alg != "HS256" {
        return Ok(None);
    }

    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).map_err(|_| {
        ApiError::Internal("CENTAUR_JWT_SIGNING_SECRET is not valid HMAC key material".to_owned())
    })?;
    mac.update(signing_input.as_bytes());
    let expected = mac.finalize().into_bytes();
    let Some(presented) = decode_base64url(parts[2]) else {
        return Ok(None);
    };
    if !constant_time_eq(&presented, expected.as_slice()) {
        return Ok(None);
    }

    let Some(claims) = decode_base64url_json::<McpJwtClaims>(parts[1]) else {
        return Ok(None);
    };
    let now = OffsetDateTime::now_utc().unix_timestamp();
    if claims.exp <= now {
        return Ok(None);
    }
    if claims.nbf.is_some_and(|nbf| nbf > now + 30) {
        return Ok(None);
    }
    if claims.iat.is_some_and(|iat| iat > now + 30) {
        return Ok(None);
    }
    let Some(issuer) = mcp_authorization_server_url() else {
        return Ok(None);
    };
    if !same_url(&claims.iss, &issuer) {
        return Ok(None);
    }
    let Some(resource) = canonical_mcp_resource_url() else {
        return Ok(None);
    };
    if !audience_contains(&claims.aud, &resource) {
        return Ok(None);
    }
    if claims.principal_id.trim().is_empty() {
        return Ok(None);
    }

    let mut scopes = claims.scopes.unwrap_or_default();
    if let Some(scope) = claims.scope {
        scopes.extend(scope.split_whitespace().map(ToOwned::to_owned));
    }
    scopes = normalize_scope_list(scopes);
    if scopes.is_empty() {
        return Ok(None);
    }
    let expires_at = OffsetDateTime::from_unix_timestamp(claims.exp).ok();
    let token_id = claims.jti.unwrap_or_else(|| {
        let digest = Sha256::digest(token.as_bytes());
        format!("mcp_jwt_{}", hex::encode(&digest[..12]))
    });
    let sub = claims.sub;
    let email = claims.email;
    let name = first_non_empty_owned([
        claims.name,
        email.clone(),
        sub.clone(),
        Some(claims.principal_id.clone()),
    ])
    .unwrap_or_else(|| claims.principal_id.clone());

    Ok(Some(McpPrincipal {
        token_id,
        principal_id: claims.principal_id,
        name,
        scopes,
        expires_at,
        user_sub: sub,
        email,
    }))
}

fn decode_base64url_json<T: for<'de> Deserialize<'de>>(value: &str) -> Option<T> {
    let decoded = decode_base64url(value)?;
    serde_json::from_slice(&decoded).ok()
}

fn decode_base64url(value: &str) -> Option<Vec<u8>> {
    general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .or_else(|_| general_purpose::URL_SAFE.decode(value))
        .ok()
}

fn normalize_scope_list(scopes: Vec<String>) -> Vec<String> {
    let mut scopes = scopes
        .into_iter()
        .map(|scope| scope.trim().to_owned())
        .filter(|scope| !scope.is_empty())
        .collect::<Vec<_>>();
    scopes.sort();
    scopes.dedup();
    scopes
}

fn first_non_empty_owned(values: impl IntoIterator<Item = Option<String>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_owned())
        .find(|value| !value.is_empty())
}

fn audience_contains(audience: &Value, resource: &str) -> bool {
    match audience {
        Value::String(value) => same_url(value, resource),
        Value::Array(values) => values
            .iter()
            .filter_map(Value::as_str)
            .any(|value| same_url(value, resource)),
        _ => false,
    }
}

fn same_url(left: &str, right: &str) -> bool {
    normalize_public_url(left)
        .is_some_and(|left| normalize_public_url(right).is_some_and(|right| left == right))
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = header_value(headers, "Authorization")?;
    let token = value
        .strip_prefix("Bearer ")
        .or_else(|| value.strip_prefix("bearer "))
        .unwrap_or(value.as_str())
        .trim();
    (!token.is_empty()).then(|| token.to_owned())
}

fn has_scope(scopes: &[String], required: &str, wildcard: &str) -> bool {
    scopes
        .iter()
        .any(|scope| scope == "*" || scope == required || scope == wildcard)
}

fn ensure_scope(scopes: &[String], required: &str, wildcard: &str) -> Result<(), ApiError> {
    if has_scope(scopes, required, wildcard) {
        Ok(())
    } else {
        Err(ApiError::Forbidden(format!(
            "missing required scope {required}"
        )))
    }
}

fn ensure_mcp_scope(scopes: &[String], required: &str) -> Result<(), ApiError> {
    ensure_scope(scopes, required, "mcp:*")
}

fn requested_mcp_protocol_version(params: &Value) -> &'static str {
    const DEFAULT_PROTOCOL_VERSION: &str = "2025-06-18";
    match params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .filter(|version| !version.trim().is_empty())
    {
        Some("2025-11-25") => "2025-11-25",
        Some("2025-06-18") => "2025-06-18",
        _ => DEFAULT_PROTOCOL_VERSION,
    }
}

fn mcp_json_error(id: Value, code: i64, message: &str) -> Response {
    Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        },
    }))
    .into_response()
}

fn mcp_unauthorized(headers: &HeaderMap) -> Response {
    let metadata = format!(
        "{}/.well-known/oauth-protected-resource/mcp",
        mcp_public_base_url(headers)
    );
    let challenge =
        format!(r#"Bearer resource_metadata="{metadata}", scope="mcp:tools {MCP_AGENT_SCOPE}""#);
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": "missing or invalid MCP bearer token",
        })),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&challenge) {
        response.headers_mut().insert("WWW-Authenticate", value);
    }
    response
}

fn canonical_mcp_resource_url() -> Option<String> {
    mcp_public_url_env()
        .as_deref()
        .and_then(normalize_mcp_endpoint_url)
}

fn mcp_resource_url(headers: &HeaderMap) -> String {
    canonical_mcp_resource_url().unwrap_or_else(|| format!("{}/mcp", request_base_url(headers)))
}

fn mcp_authorization_server_url() -> Option<String> {
    [console_public_url_env(), iron_control_public_url_env()]
        .into_iter()
        .find_map(|url| url.as_deref().and_then(normalize_public_url))
}

fn mcp_public_base_url(headers: &HeaderMap) -> String {
    if let Some(url) = mcp_public_url_env()
        .as_deref()
        .and_then(normalize_public_url)
    {
        return url.strip_suffix("/mcp").unwrap_or(&url).to_owned();
    }
    request_base_url(headers)
}

// The variables below are static deployment configuration, so each is resolved
// once per process. Tests mutate them per-case, so cfg!(test) reads live.
fn static_env(cell: &'static OnceLock<Option<String>>, name: &str) -> Option<String> {
    if cfg!(test) {
        return env::var(name).ok();
    }
    cell.get_or_init(|| env::var(name).ok()).clone()
}

fn mcp_public_url_env() -> Option<String> {
    static CELL: OnceLock<Option<String>> = OnceLock::new();
    static_env(&CELL, "CENTAUR_MCP_PUBLIC_URL")
}

fn console_public_url_env() -> Option<String> {
    static CELL: OnceLock<Option<String>> = OnceLock::new();
    static_env(&CELL, "CENTAUR_CONSOLE_PUBLIC_URL")
}

fn iron_control_public_url_env() -> Option<String> {
    static CELL: OnceLock<Option<String>> = OnceLock::new();
    static_env(&CELL, "IRON_CONTROL_PUBLIC_URL")
}

fn normalize_mcp_endpoint_url(value: &str) -> Option<String> {
    let mut url = normalize_public_url(value)?;
    if !url.ends_with("/mcp") {
        url.push_str("/mcp");
    }
    Some(url)
}

fn normalize_public_url(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let uri = Uri::from_str(trimmed).ok()?;
    match (uri.scheme_str(), uri.authority()) {
        (Some("http" | "https"), Some(_)) => Some(trimmed.to_owned()),
        _ => None,
    }
}

fn request_base_url(headers: &HeaderMap) -> String {
    let proto = header_value(headers, "X-Forwarded-Proto").unwrap_or_else(|| "http".to_owned());
    let host = header_value(headers, "X-Forwarded-Host")
        .or_else(|| header_value(headers, "Host"))
        .unwrap_or_else(|| "127.0.0.1:8080".to_owned());
    format!("{}://{}", proto.trim(), host.trim())
}

/// Compare two byte strings in constant time (modulo length, which is not
/// secret here).
fn constant_time_eq(actual: &[u8], expected: &[u8]) -> bool {
    use subtle::ConstantTimeEq;

    actual.ct_eq(expected).into()
}

#[cfg(test)]
mod mcp_tests {
    use std::{
        sync::Mutex,
        time::{SystemTime, UNIX_EPOCH},
    };

    use futures_util::FutureExt;

    use super::*;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        saved: Vec<(&'static str, Option<String>)>,
    }

    impl EnvGuard {
        fn set(vars: &[(&'static str, &'static str)]) -> Self {
            let saved = vars
                .iter()
                .map(|(name, _)| (*name, env::var(name).ok()))
                .collect();
            for (name, value) in vars {
                // SAFETY: tests that mutate process env hold ENV_LOCK for the
                // duration of the guard, so concurrent tests in this module
                // cannot observe partial mutations.
                unsafe {
                    env::set_var(name, value);
                }
            }
            Self { saved }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (name, value) in self.saved.drain(..) {
                // SAFETY: see EnvGuard::set; the lock outlives the guard.
                unsafe {
                    if let Some(value) = value {
                        env::set_var(name, value);
                    } else {
                        env::remove_var(name);
                    }
                }
            }
        }
    }

    fn temp_dir(prefix: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("{prefix}-{}-{suffix}", std::process::id()))
    }

    fn test_tool(project_dir: PathBuf) -> DiscoveredTool {
        DiscoveredTool {
            name: "demo".to_owned(),
            package: "demo".to_owned(),
            description: Some("Demo tool".to_owned()),
            client_module: "client.py".to_owned(),
            project_dir,
        }
    }

    fn test_jwt(secret: &str, claims: Value) -> String {
        let header = general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&json!({"alg": "HS256", "typ": "JWT"})).unwrap());
        let payload = general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap());
        let signing_input = format!("{header}.{payload}");
        let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
        mac.update(signing_input.as_bytes());
        let signature = general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        format!("{signing_input}.{signature}")
    }

    fn mcp_auth_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {token}")).unwrap(),
        );
        headers
    }

    fn test_principal(id: &str) -> McpPrincipal {
        McpPrincipal {
            token_id: "mcp_tok_test".to_owned(),
            principal_id: id.to_owned(),
            name: "Test User".to_owned(),
            scopes: vec!["mcp:tools".to_owned(), MCP_AGENT_SCOPE.to_owned()],
            expires_at: None,
            user_sub: Some("usr_test".to_owned()),
            email: Some("test@example.com".to_owned()),
        }
    }

    fn test_event(event_id: i64, payload: Value) -> centaur_session_core::SessionEvent {
        centaur_session_core::SessionEvent {
            event_id,
            thread_key: ThreadKey::parse("agent:principal:request").unwrap(),
            execution_id: Some("exec-1".to_owned()),
            event_type: "session.output.line".to_owned(),
            payload,
            created_at: OffsetDateTime::now_utc(),
        }
    }

    #[test]
    fn mcp_agent_tools_are_listed_as_builtin_tools() {
        let tools = mcp_agent_tool_entries();
        let names = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec![
                "centaur_agent_start",
                "centaur_agent_events",
                "centaur_agent_cancel"
            ]
        );
        assert_eq!(
            tools[0]["inputSchema"]["properties"]["max_duration_ms"]["maximum"],
            MCP_AGENT_MAX_DURATION_MS
        );
        assert_eq!(
            tools[0]["inputSchema"]["required"],
            json!(["prompt", "idempotency_key"])
        );
        assert_eq!(tools[2]["inputSchema"]["required"], json!(["execution_id"]));
    }

    #[test]
    fn mcp_agent_input_uses_harness_user_message_shape() {
        let thread_key = ThreadKey::parse("agent:principal:request").unwrap();
        let line = mcp_agent_input_line(
            &thread_key,
            "inspect the failure",
            &json!({"source": "mcp"}),
        )
        .unwrap();
        let input: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(input["type"], "user");
        assert_eq!(input["thread_key"], thread_key.as_str());
        assert_eq!(input["trace_metadata"], json!({"source": "mcp"}));
        assert_eq!(input["message"]["role"], "user");
        assert_eq!(
            input["message"]["content"],
            json!([{"type": "text", "text": "inspect the failure"}])
        );
        assert!(input.get("text").is_none());
    }

    #[test]
    fn mcp_agent_thread_keys_are_scoped_to_principal() {
        let ada = test_principal("principal-ada");
        let grace = test_principal("principal-grace");
        let thread_key = mcp_generate_agent_thread_key(&ada, "request-1").unwrap();

        assert!(
            thread_key
                .as_str()
                .starts_with(&mcp_agent_thread_prefix(&ada))
        );
        assert_eq!(
            thread_key,
            mcp_generate_agent_thread_key(&ada, "request-1").unwrap()
        );
        assert_ne!(
            thread_key,
            mcp_generate_agent_thread_key(&ada, "request-2").unwrap()
        );
        assert!(mcp_validate_agent_thread_key(&ada, thread_key.as_str()).is_ok());
        assert!(mcp_validate_agent_thread_key(&grace, thread_key.as_str()).is_err());
    }

    #[test]
    fn mcp_agent_harness_uses_canonical_values() {
        assert_eq!(
            mcp_parse_agent_harness("claudecode").unwrap(),
            HarnessType::ClaudeCode
        );
        assert!(mcp_parse_agent_harness("claude-code").is_err());
        assert!(mcp_parse_agent_harness("claude_code").is_err());
        assert!(mcp_parse_agent_harness("unknown").is_err());
    }

    #[test]
    fn mcp_agent_execution_metadata_survives_token_rotation() {
        let mut first = test_principal("principal-ada");
        first.token_id = "token-before-refresh".to_owned();
        first.expires_at = Some(OffsetDateTime::now_utc() + time::Duration::minutes(1));
        let mut refreshed = test_principal("principal-ada");
        refreshed.token_id = "token-after-refresh".to_owned();
        refreshed.expires_at = Some(OffsetDateTime::now_utc() + time::Duration::hours(1));

        let first_metadata = mcp_agent_execution_metadata(&first, "fingerprint-1");
        let refreshed_metadata = mcp_agent_execution_metadata(&refreshed, "fingerprint-1");

        assert_eq!(first_metadata, refreshed_metadata);
        assert_eq!(first_metadata["agent_principal_id"], "principal-ada");
        assert_eq!(first_metadata["agent_request_fingerprint"], "fingerprint-1");
        assert!(first_metadata.get("mcp_token_id").is_none());
        assert!(first_metadata.get("expires_at").is_none());
    }

    #[test]
    fn mcp_terminal_status_uses_execution_status_and_tracks_visible_event() {
        let thread_key = ThreadKey::parse("agent:principal:request").unwrap();
        let completed = centaur_session_core::SessionEvent {
            event_id: 10,
            thread_key: thread_key.clone(),
            execution_id: Some("exec-1".to_owned()),
            event_type: "session.execution_completed".to_owned(),
            payload: json!({"execution_id": "exec-1"}),
            created_at: OffsetDateTime::now_utc(),
        };
        let output = centaur_session_core::SessionEvent {
            event_id: 9,
            thread_key,
            execution_id: Some("exec-1".to_owned()),
            event_type: "session.output.line".to_owned(),
            payload: json!("done"),
            created_at: OffsetDateTime::now_utc(),
        };

        assert_eq!(
            mcp_terminal_status_from_execution_status(Some(&ExecutionStatus::Completed)),
            Some("completed")
        );
        assert!(!mcp_terminal_event_visible_in_events(
            &[output],
            "exec-1",
            &ExecutionStatus::Completed,
        ));
        assert!(mcp_terminal_event_visible_in_events(
            &[completed],
            "exec-1",
            &ExecutionStatus::Completed,
        ));
    }

    #[test]
    fn mcp_protocol_negotiation_defaults_older_structured_content_versions() {
        assert_eq!(
            requested_mcp_protocol_version(&json!({"protocolVersion": "2025-03-26"})),
            "2025-06-18"
        );
        assert_eq!(
            requested_mcp_protocol_version(&json!({"protocolVersion": "2025-06-18"})),
            "2025-06-18"
        );
        assert_eq!(
            requested_mcp_protocol_version(&json!({"protocolVersion": "2025-11-25"})),
            "2025-11-25"
        );
    }
    #[test]
    fn mcp_json_results_include_structured_content_without_duplicating_payload_text() {
        let value = json!({"execution_id": "exe_1", "large": "x".repeat(2048), "has_more": false});
        let result = mcp_json_result(value.clone()).unwrap();

        assert_eq!(result["structuredContent"], value);
        assert_eq!(result["isError"], false);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("structured JSON result"));
        assert!(!text.contains(&"x".repeat(128)));
    }

    #[test]
    fn mcp_agent_event_page_respects_row_and_byte_budget() {
        let events = vec![
            test_event(1, json!({"text": "small-1"})),
            test_event(2, json!({"text": "x".repeat(2048)})),
            test_event(3, json!({"text": "small-3"})),
        ];

        let page = mcp_agent_event_page(events, 10, 700).unwrap();

        assert_eq!(page.events.len(), 1);
        assert_eq!(page.last_event_id, Some(1));
        assert!(page.has_more);
        assert!(page.serialized_event_bytes <= page.byte_budget);
    }

    #[test]
    fn mcp_agent_event_page_summarizes_oversized_first_event_and_advances_cursor() {
        let page = mcp_agent_event_page(
            vec![
                test_event(41, json!({"text": "x".repeat(4096)})),
                test_event(42, json!({"text": "next"})),
            ],
            10,
            700,
        )
        .unwrap();

        assert_eq!(page.events.len(), 1);
        assert_eq!(page.last_event_id, Some(41));
        assert!(page.has_more);
        assert_eq!(page.events[0]["event_id"], 41);
        assert_eq!(page.events[0]["payload"]["centaur_mcp_truncated"], true);
        assert!(
            page.events[0]["payload"]["original_serialized_bytes"]
                .as_u64()
                .is_some_and(|bytes| bytes > 700)
        );
    }

    #[test]
    fn mcp_agent_event_page_summarizes_oversized_final_event_without_false_has_more() {
        let page = mcp_agent_event_page(
            vec![test_event(51, json!({"text": "x".repeat(4096)}))],
            10,
            700,
        )
        .unwrap();

        assert_eq!(page.events.len(), 1);
        assert_eq!(page.last_event_id, Some(51));
        assert!(!page.has_more);
        assert_eq!(page.events[0]["payload"]["centaur_mcp_truncated"], true);
    }

    #[test]
    fn mcp_agent_event_page_full_jsonrpc_envelope_fits_response_budget() {
        let events = (1..=500)
            .map(|event_id| test_event(event_id, json!({"text": "x".repeat(1024)})))
            .collect::<Vec<_>>();
        let page = mcp_agent_event_page(events, 500, MCP_AGENT_EVENTS_MAX_RESPONSE_BYTES).unwrap();
        let last_event_id = page.last_event_id;
        let result = json!({
            "thread_key": "agent:principal:request",
            "execution_id": "exec-1",
            "events": page.events,
            "last_event_id": last_event_id,
            "next_after_event_id": last_event_id.unwrap_or(0),
            "status": null,
            "terminal_status": null,
            "terminal_event_observed": false,
            "has_more": page.has_more,
            "byte_budget": page.byte_budget,
            "serialized_event_bytes": page.serialized_event_bytes,
        });
        let tool_result = mcp_json_result_with_text(
            result,
            "agent events page: representative bounded summary".to_owned(),
        )
        .unwrap();
        let envelope = json!({
            "jsonrpc": "2.0",
            "id": "evt",
            "result": tool_result,
        });

        assert!(
            serde_json::to_vec(&envelope).unwrap().len()
                <= MCP_AGENT_EVENTS_MAX_JSONRPC_RESPONSE_BYTES
        );
    }

    #[test]
    fn mcp_agent_event_page_cursor_is_last_included_event() {
        let page = mcp_agent_event_page(
            vec![
                test_event(7, json!({"text": "a"})),
                test_event(9, json!({"text": "b"})),
                test_event(11, json!({"text": "c"})),
            ],
            2,
            4096,
        )
        .unwrap();

        assert_eq!(page.events.len(), 2);
        assert_eq!(page.last_event_id, Some(9));
        assert!(page.has_more);
    }

    #[test]
    fn mcp_agent_durations_are_validated_before_start() {
        assert!(mcp_agent_duration_options(Some(0), None).is_err());
        assert!(mcp_agent_duration_options(None, Some(0)).is_err());
        assert!(mcp_agent_duration_options(None, Some(MCP_AGENT_MAX_DURATION_MS + 1)).is_err());
        assert!(mcp_agent_duration_options(Some(2), Some(1)).is_err());
        assert_eq!(
            mcp_agent_duration_options(None, None).unwrap(),
            MCP_AGENT_DEFAULT_MAX_DURATION_MS
        );
        assert!(
            mcp_agent_duration_options(None, Some(MCP_AGENT_DEFAULT_MAX_DURATION_MS + 1)).is_ok()
        );
    }

    #[test]
    fn mcp_tool_method_names_include_public_client_methods_and_help() {
        let temp = temp_dir("centaur-api-rs-mcp-methods");
        fs::create_dir_all(&temp).unwrap();
        fs::write(
            temp.join("client.py"),
            r#"
def search(query, limit=20):
    return []

def _hidden():
    return None

class DemoClient:
    def list_channels(self, limit=200):
        def nested_helper():
            return None
        return []

    async def search_messages(self, query):
        return []
"#,
        )
        .unwrap();

        let parsed = mcp_tool_methods(&test_tool(temp.clone()));
        let methods = parsed
            .iter()
            .map(|method| method.name.clone())
            .collect::<Vec<_>>();

        assert!(methods.contains(&"help".to_owned()));
        assert!(methods.contains(&"search".to_owned()));
        assert!(methods.contains(&"list_channels".to_owned()));
        assert!(methods.contains(&"search_messages".to_owned()));
        assert!(!methods.contains(&"_hidden".to_owned()));
        assert!(!methods.contains(&"nested_helper".to_owned()));

        let signatures = parsed
            .into_iter()
            .map(|method| method.signature)
            .collect::<Vec<_>>();
        assert!(signatures.contains(&"search(query, limit=20)".to_owned()));
        assert!(signatures.contains(&"list_channels(limit=200)".to_owned()));
        assert!(signatures.contains(&"search_messages(query)".to_owned()));
        assert!(signatures.contains(&"help()".to_owned()));

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn mcp_tool_failure_detail_keeps_final_exception_from_chained_traceback() {
        let stderr = r#"Building twitter @ file:///tools/comms/twitter
Installed 16 packages in 66ms
Traceback (most recent call last):
  File "/tools/comms/twitter/client.py", line 53, in _request
    response.raise_for_status()
httpx.HTTPStatusError: Client error '401 Unauthorized' for url 'https://api.x.com/2/tweets/search/recent'

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File "<string>", line 45, in <module>
  File "/tools/comms/twitter/client.py", line 229, in search_tweets
    tweets, meta, includes = self._paged(
RuntimeError: X API error: 401 - {
  "title": "Unauthorized",
  "status": 401
}"#;

        let detail = mcp_tool_failure_detail(stderr);

        assert!(detail.starts_with("RuntimeError: X API error: 401"));
        assert!(detail.contains("\"title\": \"Unauthorized\""));
        assert!(!detail.contains("Traceback"));
        assert!(!detail.contains("Installed 16 packages"));

        let plain = "invalid arguments for search_tweets(query, limit=10): got an unexpected keyword argument 'max_results'";
        assert_eq!(mcp_tool_failure_detail(plain), plain);
    }

    #[tokio::test]
    async fn mcp_unknown_method_returns_available_methods_without_running_tool() {
        let temp = temp_dir("centaur-api-rs-mcp-unknown-method");
        fs::create_dir_all(&temp).unwrap();
        fs::write(
            temp.join("client.py"),
            r#"
def search(query, limit=20):
    return []
"#,
        )
        .unwrap();

        let result = mcp_centaur_tool_result(
            &AppState::unready(),
            &McpPrincipal {
                principal_id: "mcp:test".to_owned(),
                token_id: "mcp_tok_test".to_owned(),
                name: "test".to_owned(),
                scopes: vec!["mcp:tools".to_owned()],
                expires_at: None,
                user_sub: Some("usr_test".to_owned()),
                email: Some("test@example.com".to_owned()),
            },
            test_tool(temp.clone()),
            json!({"method": "missing", "arguments": {}}),
        )
        .await
        .unwrap();

        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("has no method missing"));
        assert!(text.contains("search"));

        let _ = fs::remove_dir_all(temp);
    }

    #[tokio::test]
    async fn mcp_unknown_method_is_rejected_when_tool_has_no_public_methods() {
        let temp = temp_dir("centaur-api-rs-mcp-no-methods");
        fs::create_dir_all(&temp).unwrap();
        fs::write(temp.join("client.py"), "def _hidden():\n    return None\n").unwrap();

        let result = mcp_centaur_tool_result(
            &AppState::unready(),
            &McpPrincipal {
                principal_id: "mcp:test".to_owned(),
                token_id: "mcp_tok_test".to_owned(),
                name: "test".to_owned(),
                scopes: vec!["mcp:tools".to_owned()],
                expires_at: None,
                user_sub: Some("usr_test".to_owned()),
                email: Some("test@example.com".to_owned()),
            },
            test_tool(temp.clone()),
            json!({"method": "missing", "arguments": {}}),
        )
        .await
        .unwrap();

        assert_eq!(result["isError"], true);
        let text = result["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("has no method missing"));

        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn mcp_jwt_authenticates_console_principal() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("CENTAUR_MCP_PUBLIC_URL", "http://localhost:3000/mcp"),
            ("CENTAUR_CONSOLE_PUBLIC_URL", "http://localhost:3001"),
        ]);
        let token = test_jwt(
            "test-secret",
            json!({
                "iss": "http://localhost:3001",
                "sub": "usr_test",
                "aud": "http://localhost:3000/mcp",
                "exp": OffsetDateTime::now_utc().unix_timestamp() + 3600,
                "iat": OffsetDateTime::now_utc().unix_timestamp(),
                "jti": "mcpjwt_test",
                "scope": "mcp:tools",
                "principal_id": "prn_test",
                "email": "test@example.com",
            }),
        );

        let principal = authenticate_mcp_bearer(&mcp_auth_headers(&token))
            .unwrap()
            .unwrap();

        assert_eq!(principal.token_id, "mcpjwt_test");
        assert_eq!(principal.principal_id, "prn_test");
        assert_eq!(principal.name, "test@example.com");
        assert_eq!(principal.scopes, vec!["mcp:tools"]);
        assert!(principal.expires_at.is_some());
    }

    #[test]
    fn mcp_jwt_rejects_hostile_forwarded_audience() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("CENTAUR_MCP_PUBLIC_URL", "http://canonical.example/mcp"),
            ("CENTAUR_CONSOLE_PUBLIC_URL", "http://localhost:3001"),
        ]);
        let token = test_jwt(
            "test-secret",
            json!({
                "iss": "http://localhost:3001",
                "sub": "usr_test",
                "aud": "https://evil.example/mcp",
                "exp": OffsetDateTime::now_utc().unix_timestamp() + 3600,
                "principal_id": "prn_test",
                "email": "test@example.com",
                "scope": "mcp:tools",
            }),
        );
        let mut headers = mcp_auth_headers(&token);
        headers.insert("X-Forwarded-Proto", HeaderValue::from_static("https"));
        headers.insert("X-Forwarded-Host", HeaderValue::from_static("evil.example"));

        assert!(authenticate_mcp_bearer(&headers).unwrap().is_none());
    }

    #[test]
    fn mcp_jwt_rejects_missing_or_invalid_canonical_audience_config() {
        for public_url in ["", "not a url"] {
            let _lock = ENV_LOCK.lock().unwrap();
            let _env = EnvGuard::set(&[
                ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
                ("CENTAUR_MCP_PUBLIC_URL", public_url),
                ("CENTAUR_CONSOLE_PUBLIC_URL", "http://localhost:3001"),
            ]);
            let token = test_jwt(
                "test-secret",
                json!({
                    "iss": "http://localhost:3001",
                    "sub": "usr_test",
                    "aud": "http://localhost:3000/mcp",
                    "exp": OffsetDateTime::now_utc().unix_timestamp() + 3600,
                    "principal_id": "prn_test",
                    "email": "test@example.com",
                    "scope": "mcp:tools",
                }),
            );

            assert!(
                authenticate_mcp_bearer(&mcp_auth_headers(&token))
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn mcp_jwt_active_user_admission_checks_active_disabled_and_deleted() {
        let principal = McpPrincipal {
            email: Some("test@example.com".to_owned()),
            ..test_principal("prn_test")
        };
        let pool =
            sqlx::PgPool::connect_lazy("postgres://postgres:postgres@localhost/centaur_test")
                .unwrap();

        {
            let mut statuses = BTreeMap::new();
            statuses.insert("test@example.com".to_owned(), Some("active".to_owned()));
            *MCP_TEST_USER_STATUSES.lock().unwrap() = Some(statuses);
        }
        assert!(
            ensure_mcp_principal_active(&pool, &principal)
                .await
                .unwrap()
        );

        {
            let mut statuses = BTreeMap::new();
            statuses.insert("test@example.com".to_owned(), Some("disabled".to_owned()));
            *MCP_TEST_USER_STATUSES.lock().unwrap() = Some(statuses);
        }
        assert!(
            !ensure_mcp_principal_active(&pool, &principal)
                .await
                .unwrap()
        );

        {
            let mut statuses = BTreeMap::new();
            statuses.insert("test@example.com".to_owned(), None);
            *MCP_TEST_USER_STATUSES.lock().unwrap() = Some(statuses);
        }
        assert!(
            !ensure_mcp_principal_active(&pool, &principal)
                .await
                .unwrap()
        );
        *MCP_TEST_USER_STATUSES.lock().unwrap() = None;
    }

    #[test]
    fn mcp_active_user_query_uses_signed_email_status_lookup() {
        assert_eq!(
            MCP_ACTIVE_USER_STATUS_SQL,
            "select status from public.users where lower(email) = lower($1) limit 1"
        );
    }

    #[test]
    fn mcp_jwt_rejects_wrong_audience() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("CENTAUR_MCP_PUBLIC_URL", "http://localhost:3000/mcp"),
            ("CENTAUR_CONSOLE_PUBLIC_URL", "http://localhost:3001"),
        ]);
        let token = test_jwt(
            "test-secret",
            json!({
                "iss": "http://localhost:3001",
                "aud": "http://other.example/mcp",
                "exp": OffsetDateTime::now_utc().unix_timestamp() + 3600,
                "principal_id": "prn_test",
                "scope": "mcp:tools",
            }),
        );

        assert!(
            authenticate_mcp_bearer(&mcp_auth_headers(&token))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn mcp_jwt_rejects_issued_at_in_the_future() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("CENTAUR_MCP_PUBLIC_URL", "http://localhost:3000/mcp"),
            ("CENTAUR_CONSOLE_PUBLIC_URL", "http://localhost:3001"),
        ]);
        let token = test_jwt(
            "test-secret",
            json!({
                "iss": "http://localhost:3001",
                "aud": "http://localhost:3000/mcp",
                "exp": OffsetDateTime::now_utc().unix_timestamp() + 3600,
                "iat": OffsetDateTime::now_utc().unix_timestamp() + 600,
                "principal_id": "prn_test",
                "scope": "mcp:tools",
            }),
        );

        assert!(
            authenticate_mcp_bearer(&mcp_auth_headers(&token))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn mcp_jwt_rejects_internal_console_control_plane_issuer() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[
            ("CENTAUR_JWT_SIGNING_SECRET", "test-secret"),
            ("CENTAUR_MCP_PUBLIC_URL", "http://localhost:3000/mcp"),
            ("CENTAUR_CONSOLE_PUBLIC_URL", ""),
            ("IRON_CONTROL_PUBLIC_URL", ""),
            ("CENTAUR_CONSOLE_URL", "http://centaur-console:3000"),
            ("IRON_CONTROL_URL", "http://centaur-console:3000"),
        ]);
        let token = test_jwt(
            "test-secret",
            json!({
                "iss": "http://centaur-console:3000",
                "aud": "http://localhost:3000/mcp",
                "exp": OffsetDateTime::now_utc().unix_timestamp() + 3600,
                "principal_id": "prn_test",
                "scope": "mcp:tools",
            }),
        );

        assert!(
            authenticate_mcp_bearer(&mcp_auth_headers(&token))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn mcp_non_jwt_bearer_values_are_not_accepted() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[("CENTAUR_JWT_SIGNING_SECRET", "test-secret")]);

        assert!(
            authenticate_mcp_bearer(&mcp_auth_headers("not-a-jwt-token"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn mcp_protected_resource_metadata_uses_configured_urls() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[
            ("CENTAUR_MCP_PUBLIC_URL", "http://localhost:3000"),
            ("CENTAUR_CONSOLE_PUBLIC_URL", "http://localhost:3001"),
        ]);

        let Json(metadata) = mcp_protected_resource_metadata(HeaderMap::new())
            .now_or_never()
            .unwrap();

        assert_eq!(metadata["resource"], "http://localhost:3000/mcp");
        assert_eq!(
            metadata["authorization_servers"][0],
            "http://localhost:3001"
        );
    }

    #[test]
    fn mcp_protected_resource_metadata_ignores_internal_console_control_plane_url() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[
            ("CENTAUR_CONSOLE_PUBLIC_URL", ""),
            ("IRON_CONTROL_PUBLIC_URL", ""),
            ("CENTAUR_CONSOLE_URL", "http://centaur-console:3000"),
            ("IRON_CONTROL_URL", "http://centaur-console:3000"),
        ]);
        let Json(metadata) = mcp_protected_resource_metadata(HeaderMap::new())
            .now_or_never()
            .unwrap();

        assert_eq!(metadata["authorization_servers"], json!([]));
    }

    #[test]
    fn mcp_unauthorized_challenge_uses_public_metadata_url() {
        let _lock = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(&[("CENTAUR_MCP_PUBLIC_URL", "http://localhost:3000/mcp")]);

        let response = mcp_unauthorized(&HeaderMap::new());
        let challenge = response
            .headers()
            .get("WWW-Authenticate")
            .unwrap()
            .to_str()
            .unwrap();

        assert!(challenge.contains(
            r#"resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp""#
        ));
        assert!(!challenge.contains("/mcp/.well-known"));
    }
}
