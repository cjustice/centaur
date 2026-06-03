use std::{
    collections::BTreeMap,
    convert::{Infallible, TryFrom},
    fs,
    path::{Path as FsPath, PathBuf},
};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    response::{
        Sse,
        sse::{Event, KeepAlive},
    },
    routing::{get, post},
};
use centaur_session_core::{Session, ThreadKey};
use centaur_session_runtime::{ExecuteSessionInput, SandboxRuntime, SessionRuntime};
use centaur_session_sqlx::PgSessionStore;
use futures_util::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::{
    ApiError,
    types::{
        AppendMessagesRequest, AppendMessagesResponse, CreateSessionRequest, EventLogQuery,
        EventsQuery, ExecuteSessionRequest, ExecuteSessionResponse, ListEventsResponse,
        ListMessagesResponse, ListPersonasResponse, PersonaRecord, SessionSseEvent,
        SetSessionTitleRequest, SetSessionTitleResponse, stream_error_sse,
    },
};

#[derive(Clone)]
pub struct AppState {
    runtime: SessionRuntime,
}

pub fn build_router_with_runtime(store: PgSessionStore, sandbox_runtime: SandboxRuntime) -> Router {
    build_router_with_session_runtime(SessionRuntime::new(store, sandbox_runtime))
}

pub fn build_router_with_session_runtime(runtime: SessionRuntime) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/api/personas", get(list_personas))
        .route(
            "/api/session/{thread_key}",
            get(get_session).post(create_or_get_session),
        )
        .route(
            "/api/session/{thread_key}/messages",
            get(list_messages).post(append_messages),
        )
        .route("/api/session/{thread_key}/execute", post(execute_session))
        .route("/api/session/{thread_key}/event-log", get(list_events))
        .route("/api/session/{thread_key}/events", get(stream_events))
        .route("/api/session/{thread_key}/title", post(set_session_title))
        .route("/api/sandboxes/drain", post(drain_sandboxes))
        .with_state(AppState { runtime })
}

async fn healthz() -> Json<Value> {
    Json(json!({"ok": true}))
}

async fn list_personas() -> Json<ListPersonasResponse> {
    Json(discover_personas())
}

async fn create_or_get_session(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
    Json(request): Json<CreateSessionRequest>,
) -> Result<Json<Session>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let session = state
        .runtime
        .create_or_get_session(
            &thread_key,
            &request.harness_type,
            request.persona_id.as_deref(),
            request.metadata,
        )
        .await?;
    Ok(Json(session))
}

async fn get_session(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
) -> Result<Json<Session>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let session = state.runtime.get_session(&thread_key).await?;
    Ok(Json(session))
}

async fn append_messages(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
    Json(request): Json<AppendMessagesRequest>,
) -> Result<Json<AppendMessagesResponse>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let message_ids = state
        .runtime
        .append_messages(&thread_key, &request.messages)
        .await?;
    Ok(Json(AppendMessagesResponse {
        ok: true,
        message_ids,
    }))
}

async fn list_messages(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
) -> Result<Json<ListMessagesResponse>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let messages = state.runtime.list_messages(&thread_key).await?;
    Ok(Json(ListMessagesResponse { messages }))
}

async fn execute_session(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
    Json(request): Json<ExecuteSessionRequest>,
) -> Result<Json<ExecuteSessionResponse>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let execution = state
        .runtime
        .execute_session(
            &thread_key,
            ExecuteSessionInput {
                idempotency_key: request.idempotency_key,
                metadata: request.metadata,
                input_lines: request.input_lines,
                idle_timeout_ms: request.idle_timeout_ms,
                max_duration_ms: request.max_duration_ms,
            },
        )
        .await?;
    Ok(Json(ExecuteSessionResponse {
        ok: true,
        execution_id: execution.execution_id,
        thread_key: execution.thread_key,
        status: execution.status.to_string(),
    }))
}

async fn set_session_title(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
    Json(request): Json<SetSessionTitleRequest>,
) -> Result<Json<SetSessionTitleResponse>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let event = state
        .runtime
        .append_thread_title_update(&thread_key, &request.title, request.metadata)
        .await?;
    Ok(Json(SetSessionTitleResponse { ok: true, event }))
}

async fn list_events(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
    Query(query): Query<EventLogQuery>,
) -> Result<Json<ListEventsResponse>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let limit = query.limit.unwrap_or(500).clamp(1, 2_000);
    let events = state
        .runtime
        .list_events_after(&thread_key, query.after_event_id.unwrap_or(0), limit)
        .await?;
    Ok(Json(ListEventsResponse { events }))
}

async fn drain_sandboxes(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let report = state.runtime.drain().await?;
    let failed = report
        .failed
        .iter()
        .map(|failure| json!({ "sandbox_id": failure.sandbox_id, "error": failure.error }))
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "ok": report.failed.is_empty(),
        "stopped_count": report.stopped.len(),
        "stopped": report.stopped,
        "failed": failed,
    })))
}

async fn stream_events(
    State(state): State<AppState>,
    Path(raw_thread_key): Path<String>,
    Query(query): Query<EventsQuery>,
) -> Result<Sse<impl Stream<Item = Result<Event, Infallible>>>, ApiError> {
    let thread_key = ThreadKey::try_from(raw_thread_key)?;
    let events = state
        .runtime
        .stream_events(&thread_key, query.after_event_id.unwrap_or(0))
        .await?;
    let stream = events.map(|result| {
        let sse = match result {
            Ok(event) => SessionSseEvent::try_from(event)
                .map(Event::from)
                .unwrap_or_else(|error| stream_error_sse(error.to_string())),
            Err(error) => stream_error_sse(error.to_string()),
        };
        Ok(sse)
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn discover_personas() -> ListPersonasResponse {
    let mut personas = BTreeMap::new();
    for root in persona_roots() {
        collect_personas(&root, &mut personas);
    }
    personas
}

fn persona_roots() -> Vec<PathBuf> {
    if let Ok(root) = std::env::var("CENTAUR_PERSONAS_ROOT") {
        return vec![PathBuf::from(root)];
    }
    vec![PathBuf::from("tools"), PathBuf::from("/app/tools")]
}

fn collect_personas(root: &FsPath, personas: &mut ListPersonasResponse) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !is_visible_dir(&path) {
            continue;
        }
        if path.join("pyproject.toml").exists() {
            insert_persona(&path, personas);
            continue;
        }
        let Ok(children) = fs::read_dir(path) else {
            continue;
        };
        for child in children.flatten() {
            let candidate = child.path();
            if is_visible_dir(&candidate) && candidate.join("pyproject.toml").exists() {
                insert_persona(&candidate, personas);
            }
        }
    }
}

fn insert_persona(path: &FsPath, personas: &mut ListPersonasResponse) {
    let Some((name, persona)) = load_persona(path) else {
        return;
    };
    personas.insert(name, persona);
}

fn load_persona(path: &FsPath) -> Option<(String, PersonaRecord)> {
    let pyproject = fs::read_to_string(path.join("pyproject.toml")).ok()?;
    let pyproject: toml::Value = pyproject.parse().ok()?;
    let project = pyproject.get("project");
    let centaur = pyproject.get("tool")?.get("centaur")?;
    if centaur.get("type")?.as_str()? != "persona" {
        return None;
    }
    let name = path.file_name()?.to_str()?.to_owned();
    let description = project
        .and_then(|value| value.get("description"))
        .and_then(toml::Value::as_str)
        .unwrap_or("")
        .to_owned();
    let engine = centaur
        .get("engine")
        .and_then(toml::Value::as_str)
        .unwrap_or("amp")
        .to_owned();
    let default_repo = centaur
        .get("default_repo")
        .and_then(toml::Value::as_str)
        .map(ToOwned::to_owned);

    Some((
        name,
        PersonaRecord {
            description,
            engine,
            default_repo,
            has_custom_executor: path.join("run.py").exists(),
        },
    ))
}

fn is_visible_dir(path: &FsPath) -> bool {
    if !path.is_dir() {
        return false;
    }
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| !name.starts_with('.') && !name.starts_with('_'))
}
