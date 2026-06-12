use std::env;
use std::io::{self, BufRead, Write};
use std::process::{Child, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;

use codex_app_server_protocol::UserInput;
use serde_json::{Value, json};

use crate::server::{BlocksCommand, BlocksState, parse_blocks_line_with_state, write_blocks_error};
use crate::util::write_value;
use crate::{AppServerRuntime, HarnessServerError, Result};

#[derive(Debug, Default)]
pub struct CodexHarnessServer;

impl AppServerRuntime for CodexHarnessServer {
    fn run_stdio(&self) -> Result<()> {
        let bin = codex_bin();
        let mut child = ProcessCommand::new(&bin)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| HarnessServerError::SpawnCodex {
                bin: bin.clone(),
                source,
            })?;

        let mut child_stdin = child
            .stdin
            .take()
            .ok_or(HarnessServerError::CodexStdinUnavailable)?;
        let _stdin_thread = thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            io::copy(&mut stdin, &mut child_stdin)
        });

        let mut child_stderr = child
            .stderr
            .take()
            .ok_or(HarnessServerError::CodexStderrUnavailable)?;
        let stderr_thread = thread::spawn(move || {
            let mut stderr = io::stderr().lock();
            io::copy(&mut child_stderr, &mut stderr)
        });

        let mut child_stdout = child
            .stdout
            .take()
            .ok_or(HarnessServerError::CodexStdoutUnavailable)?;
        {
            let mut stdout = io::stdout().lock();
            io::copy(&mut child_stdout, &mut stdout)?;
            stdout.flush()?;
        }

        let status = child.wait()?;
        let _ = stderr_thread.join();
        if !status.success() {
            return Err(HarnessServerError::CodexExited { status });
        }
        Ok(())
    }
}

pub(crate) fn run_codex_blocks_server() -> Result<()> {
    let mut stdout = io::stdout().lock();
    let mut request_id = 1_i64;
    let mut thread_id: Option<String> = None;
    let mut blocks_state = BlocksState::default();
    // The codex app-server child is spawned lazily on the first turn so the
    // Slack thread env (below) is exported *before* the child exists — the
    // child captures the environment at spawn and passes it to the tool
    // subprocesses it runs (e.g. slack-upload).
    let mut codex: Option<CodexJsonRpcChild> = None;

    let stdin = io::stdin();
    for raw in stdin.lock().lines() {
        let line = raw?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Until the codex child is spawned (lazily, on the first turn), export
        // the Slack thread env from each line's thread_key so the child — and
        // the tools it runs (e.g. slack-upload) — inherit it. The thread_key is
        // constant for the process, so re-exporting before spawn is idempotent.
        if codex.is_none()
            && let Some(thread_key) = thread_key_from_blocks_line(trimmed)
        {
            export_slack_thread_env(&thread_key);
        }

        match parse_blocks_line_with_state(trimmed, &mut blocks_state) {
            Ok(BlocksCommand::User {
                input,
                client_user_message_id,
                model,
            }) => {
                let codex = match codex {
                    Some(ref mut codex) => codex,
                    None => codex.insert(spawn_codex_app_server(&mut stdout, &mut request_id)?),
                };
                if let Err(error) = run_codex_user_turn(
                    codex,
                    &mut stdout,
                    &mut request_id,
                    &mut thread_id,
                    input,
                    client_user_message_id,
                    model,
                ) {
                    let fallback_thread_id = thread_id.as_deref().unwrap_or("codex");
                    eprintln!("Codex blocks turn failed: {error:#}");
                    write_blocks_error(&mut stdout, fallback_thread_id, "turn", error.to_string())?;
                }
            }
            Ok(BlocksCommand::Interrupt) => {
                eprintln!(
                    "Codex blocks interrupt ignored: no active stdin reader while a turn runs"
                );
            }
            Ok(BlocksCommand::AttachmentChunk) => {}
            Err(error) => {
                eprintln!("invalid Codex blocks input: {error:#}");
                write_blocks_error(
                    &mut stdout,
                    thread_id.as_deref().unwrap_or("codex"),
                    "input",
                    error.to_string(),
                )?;
            }
        }
    }

    Ok(())
}

/// Spawn the codex app-server child and complete the `initialize` handshake.
///
/// Deferred until the first user turn so that any Slack thread environment
/// (`SLACK_CHANNEL`/`SLACK_THREAD_TS`) is exported before the child — and the
/// tool subprocesses it spawns — capture the environment.
fn spawn_codex_app_server<W: Write>(
    stdout: &mut W,
    request_id: &mut i64,
) -> Result<CodexJsonRpcChild> {
    let mut codex = CodexJsonRpcChild::spawn()?;
    let initialize_id = next_request_id(request_id);
    codex.send_request(
        initialize_id,
        "initialize",
        json!({
            "clientInfo": {
                "name": "centaur-harness-server",
                "title": null,
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": null,
        }),
    )?;
    codex.read_response_or_forward(initialize_id, stdout)?;
    Ok(codex)
}

/// Derive `SLACK_CHANNEL`/`SLACK_THREAD_TS` from a Slack thread key and export
/// them so sandbox tools such as `slack-upload` can target the originating
/// thread. No-op for non-Slack threads.
///
/// Must be called before the codex app-server child is spawned (and thus while
/// the process is still single-threaded), so the variables are inherited by the
/// agent's tool subprocesses.
fn export_slack_thread_env(thread_key: &str) {
    let Some((channel, thread_ts)) = slack_channel_and_thread(thread_key) else {
        return;
    };
    // SAFETY: called from `run_codex_blocks_server` before the codex child or
    // its stdout reader thread is spawned, so no other thread is concurrently
    // reading or writing the process environment.
    unsafe {
        env::set_var("SLACK_CHANNEL", channel);
        env::set_var("SLACK_THREAD_TS", thread_ts);
    }
}

/// Parse the `(channel, thread_ts)` pair out of a Slack thread key, supporting
/// both the api-rs shape `slack:<channel>:<thread_ts>` and the legacy api shape
/// `slack:<team>:<channel>:<thread_ts>`. Returns `None` for non-Slack keys,
/// unexpected arities, or empty components.
fn slack_channel_and_thread(thread_key: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = thread_key.split(':').collect();
    if parts.first() != Some(&"slack") || !matches!(parts.len(), 3 | 4) {
        return None;
    }
    let channel = parts[parts.len() - 2];
    let thread_ts = parts[parts.len() - 1];
    if channel.is_empty() || thread_ts.is_empty() {
        return None;
    }
    Some((channel.to_string(), thread_ts.to_string()))
}

/// Pull the `thread_key` field out of a raw blocks input line without consuming
/// the richer `parse_blocks_line_with_state` parse. Returns `None` when the
/// field is absent, blank, or the line is not valid JSON.
fn thread_key_from_blocks_line(line: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct ThreadKeyProbe {
        #[serde(default)]
        thread_key: Option<String>,
    }
    let probe: ThreadKeyProbe = serde_json::from_str(line).ok()?;
    let key = probe.thread_key?;
    let trimmed = key.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn run_codex_user_turn<W: Write>(
    codex: &mut CodexJsonRpcChild,
    stdout: &mut W,
    request_id: &mut i64,
    thread_id: &mut Option<String>,
    input: Vec<UserInput>,
    client_user_message_id: Option<String>,
    model: Option<String>,
) -> Result<()> {
    if thread_id.is_none() {
        *thread_id = Some(start_or_resume_thread(codex, stdout, request_id)?);
    }
    let current_thread_id = thread_id
        .as_ref()
        .expect("thread id was initialized")
        .clone();

    let mut params = json!({
        "threadId": current_thread_id,
        "input": input,
    });
    if let Some(client_user_message_id) = client_user_message_id {
        params["clientUserMessageId"] = Value::String(client_user_message_id);
    }
    if let Some(model) = model {
        params["model"] = Value::String(model);
    }

    let turn_request_id = next_request_id(request_id);
    codex.send_request(turn_request_id, "turn/start", params)?;
    let result = codex.read_response_or_forward(turn_request_id, stdout)?;
    let turn_id = result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HarnessServerError::Protocol("turn/start response missing turn.id".to_string())
        })?
        .to_string();
    codex.read_until_turn_terminal(stdout, thread_id.as_deref().unwrap_or_default(), &turn_id)
}

fn start_or_resume_thread<W: Write>(
    codex: &mut CodexJsonRpcChild,
    stdout: &mut W,
    request_id: &mut i64,
) -> Result<String> {
    let cwd = env::current_dir()?.display().to_string();
    let resume = env::var("CODEX_CONTINUE_THREAD_ID")
        .or_else(|_| env::var("AMP_CONTINUE_THREAD_ID"))
        .unwrap_or_default();
    let (method, params) = if resume.trim().is_empty() {
        (
            "thread/start",
            json!({
                "cwd": cwd,
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": "danger-full-access",
            }),
        )
    } else {
        (
            "thread/resume",
            json!({
                "threadId": resume.trim(),
                "cwd": cwd,
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": "danger-full-access",
                "excludeTurns": false,
            }),
        )
    };

    let id = next_request_id(request_id);
    codex.send_request(id, method, params)?;
    let result = codex.read_response_or_forward(id, stdout)?;
    result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| HarnessServerError::Protocol(format!("{method} response missing thread.id")))
}

struct CodexJsonRpcChild {
    child: Child,
    stdin: ChildStdin,
    stdout: Receiver<io::Result<String>>,
}

impl CodexJsonRpcChild {
    fn spawn() -> Result<Self> {
        let bin = codex_bin();
        let mut child = ProcessCommand::new(&bin)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| HarnessServerError::SpawnCodex {
                bin: bin.clone(),
                source,
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or(HarnessServerError::CodexStdinUnavailable)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(HarnessServerError::CodexStdoutUnavailable)?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or(HarnessServerError::CodexStderrUnavailable)?;
        thread::spawn(move || {
            let mut parent_stderr = io::stderr().lock();
            let _ = io::copy(&mut stderr, &mut parent_stderr);
        });

        let (stdout_tx, stdout_rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = io::BufReader::new(stdout);
            for raw in reader.lines() {
                let should_stop = raw.is_err();
                if stdout_tx.send(raw).is_err() || should_stop {
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout: stdout_rx,
        })
    }

    fn send_request(&mut self, id: i64, method: &str, params: Value) -> Result<()> {
        self.write_value(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))
    }

    fn send_error_response(&mut self, request: &Value) -> Result<()> {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        self.write_value(&json!({
            "id": id,
            "error": {
                "code": -32000,
                "message": "Centaur blocks mode cannot service app-server client requests",
                "data": null,
            },
        }))
    }

    fn write_value(&mut self, value: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.stdin, value)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn read_response_or_forward<W: Write>(
        &mut self,
        expected_id: i64,
        stdout: &mut W,
    ) -> Result<Value> {
        loop {
            let value = self.read_value()?;
            if is_server_request(&value) {
                self.send_error_response(&value)?;
                continue;
            }
            if response_id(&value) == Some(expected_id) {
                if let Some(error) = value.get("error") {
                    return Err(HarnessServerError::Protocol(format!(
                        "Codex app-server request {expected_id} failed: {error}"
                    )));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            if notification_method(&value).is_some() {
                write_value(stdout, &value)?;
            }
        }
    }

    fn read_until_turn_terminal<W: Write>(
        &mut self,
        stdout: &mut W,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<()> {
        loop {
            let value = self.read_value()?;
            if is_server_request(&value) {
                self.send_error_response(&value)?;
                continue;
            }
            if notification_method(&value).is_some() {
                let terminal = is_terminal_notification(&value, thread_id, turn_id);
                write_value(stdout, &value)?;
                if terminal {
                    break;
                }
            }
        }
        Ok(())
    }

    fn read_value(&mut self) -> Result<Value> {
        loop {
            let line = match self.stdout.recv() {
                Ok(line) => line?,
                Err(_) => {
                    let status = self.child.wait()?;
                    return Err(HarnessServerError::CodexExited { status });
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Ok(serde_json::from_str(trimmed)?);
        }
    }
}

impl Drop for CodexJsonRpcChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn is_server_request(value: &Value) -> bool {
    value.get("id").is_some() && value.get("method").is_some()
}

fn response_id(value: &Value) -> Option<i64> {
    value.get("id").and_then(Value::as_i64)
}

fn notification_method(value: &Value) -> Option<&str> {
    if value.get("id").is_some() {
        return None;
    }
    value.get("method").and_then(Value::as_str)
}

fn is_terminal_notification(value: &Value, thread_id: &str, turn_id: &str) -> bool {
    match notification_method(value) {
        Some("turn/completed") | Some("turn/failed") => {
            let notification_thread = value
                .pointer("/params/threadId")
                .and_then(Value::as_str)
                .unwrap_or(thread_id);
            let notification_turn = value
                .pointer("/params/turn/id")
                .or_else(|| value.pointer("/params/turnId"))
                .and_then(Value::as_str)
                .unwrap_or(turn_id);
            notification_thread == thread_id && notification_turn == turn_id
        }
        Some("error") => true,
        _ => false,
    }
}

fn next_request_id(request_id: &mut i64) -> i64 {
    let id = *request_id;
    *request_id += 1;
    id
}

fn codex_bin() -> String {
    if let Ok(bin) = env::var("CODEX_BIN") {
        return bin;
    }

    let candidates = ["codex", "/Applications/Codex.app/Contents/Resources/codex"];
    candidates
        .iter()
        .find(|bin| codex_supports_stdio_listen(bin))
        .copied()
        .unwrap_or("codex")
        .to_string()
}

fn codex_supports_stdio_listen(bin: &str) -> bool {
    let Ok(output) = ProcessCommand::new(bin)
        .args(["app-server", "--help"])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout.contains("--listen") || stderr.contains("--listen")
}

#[cfg(test)]
mod tests {
    use super::{slack_channel_and_thread, thread_key_from_blocks_line};

    #[test]
    fn slack_channel_and_thread_parses_api_rs_three_part_key() {
        assert_eq!(
            slack_channel_and_thread("slack:C123:123.456"),
            Some(("C123".to_string(), "123.456".to_string()))
        );
    }

    #[test]
    fn slack_channel_and_thread_parses_legacy_four_part_key() {
        assert_eq!(
            slack_channel_and_thread("slack:T999:C123:123.456"),
            Some(("C123".to_string(), "123.456".to_string()))
        );
    }

    #[test]
    fn slack_channel_and_thread_ignores_non_slack_keys() {
        assert_eq!(slack_channel_and_thread("web:t1"), None);
    }

    #[test]
    fn slack_channel_and_thread_ignores_unexpected_arity() {
        assert_eq!(slack_channel_and_thread("slack:C123"), None);
        assert_eq!(slack_channel_and_thread("slack:T:C:1.2:extra"), None);
    }

    #[test]
    fn slack_channel_and_thread_rejects_empty_components() {
        assert_eq!(slack_channel_and_thread("slack::123.456"), None);
        assert_eq!(slack_channel_and_thread("slack:C123:"), None);
    }

    #[test]
    fn thread_key_from_blocks_line_extracts_key_from_user_turn() {
        let line = r#"{"type":"user","thread_key":"slack:C123:123.456","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        assert_eq!(
            thread_key_from_blocks_line(line).as_deref(),
            Some("slack:C123:123.456")
        );
    }

    #[test]
    fn thread_key_from_blocks_line_is_none_when_absent_or_blank() {
        assert_eq!(
            thread_key_from_blocks_line(r#"{"type":"user","text":"hi"}"#),
            None
        );
        assert_eq!(
            thread_key_from_blocks_line(r#"{"type":"user","thread_key":"   "}"#),
            None
        );
    }

    #[test]
    fn thread_key_from_blocks_line_is_none_for_invalid_json() {
        assert_eq!(thread_key_from_blocks_line("not json"), None);
    }
}
