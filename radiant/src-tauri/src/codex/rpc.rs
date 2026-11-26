//! Low-level pieces of the Codex client: binary discovery, the long-lived `codex app-server` child and its
//! newline-delimited JSON-RPC connection (request ids, pending-response map, reader task).
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Notify, oneshot, watch};

/// An error already mapped to one of the `AiErrorCode` strings of the host contract.
#[derive(Clone, Debug)]
pub struct AiError {
    pub code: &'static str,
    pub message: String,
}

impl AiError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// What the reader task hands to the dispatcher.
pub enum Incoming {
    Notification { method: String, params: Value },
    /// The child's stdout closed (process exited or crashed).
    Exited,
}

pub type Handler = Arc<dyn Fn(Incoming) + Send + Sync>;

// ------------------------------------------------------------------ binary discovery

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// Extra directories that usually hold `codex` (and `node`, which the npm install's launcher needs).
fn common_dirs() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = vec!["/opt/homebrew/bin".into(), "/usr/local/bin".into(), "/usr/bin".into()];
    if let Some(h) = dirs::home_dir() {
        for d in [".local/bin", ".npm-global/bin", ".bun/bin", ".volta/bin", ".cargo/bin", ".codex/bin"] {
            v.push(h.join(d));
        }
        // nvm installs: ~/.nvm/versions/node/<version>/bin (newest first)
        if let Ok(rd) = std::fs::read_dir(h.join(".nvm/versions/node")) {
            let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            vers.sort();
            vers.reverse();
            v.extend(vers);
        }
    }
    v
}

/// Finds `name`: `$<env>`, PATH, common install locations and `extra`, then a login shell. `Err` when `$<env>` names
/// something that is not an executable file.
pub(super) async fn find_binary(name: &str, env: &str, extra: &[PathBuf]) -> Result<Option<PathBuf>, ()> {
    if let Ok(p) = std::env::var(env) {
        let p = PathBuf::from(p);
        return if is_executable(&p) { Ok(Some(p)) } else { Err(()) };
    }
    let mut dirs_to_try: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs_to_try.extend(common_dirs());
    dirs_to_try.extend(extra.iter().cloned());
    for d in dirs_to_try {
        let c = d.join(name);
        if is_executable(&c) {
            return Ok(Some(c));
        }
    }
    // Login shell: picks up PATH changes made in ~/.zprofile / ~/.zshrc.
    for shell in ["/bin/zsh", "/bin/bash"] {
        if !Path::new(shell).exists() {
            continue;
        }
        let out = tokio::time::timeout(
            Duration::from_secs(6),
            Command::new(shell).args(["-lc", &format!("command -v {name}")]).stdin(Stdio::null()).stderr(Stdio::null()).output(),
        )
        .await;
        if let Ok(Ok(o)) = out {
            let s = String::from_utf8_lossy(&o.stdout);
            if let Some(line) = s.lines().rev().find(|l| l.starts_with('/')) {
                let p = PathBuf::from(line.trim());
                if is_executable(&p) {
                    return Ok(Some(p));
                }
            }
        }
    }
    Ok(None)
}

/// Finds the `codex` binary: `$CODEX_BIN`, PATH, common install locations, then a login shell.
pub async fn locate_codex() -> Result<PathBuf, AiError> {
    match find_binary("codex", "CODEX_BIN", &[]).await {
        Ok(Some(p)) => Ok(p),
        Err(()) => Err(AiError::new("not_installed", "The configured Codex CLI was not found. Install Codex (npm i -g @openai/codex) or update CODEX_BIN.")),
        Ok(None) => Err(AiError::new(
            "not_installed",
            "The Codex CLI was not found. Install it (npm i -g @openai/codex) and sign in with `codex login`.",
        )),
    }
}

/// PATH for the child: the binary's own directory first (so its `#!/usr/bin/env node` finds node), then the
/// inherited PATH, then the common directories.
pub(super) fn child_path(bin: &Path) -> std::ffi::OsString {
    let mut parts: Vec<PathBuf> = Vec::new();
    if let Some(d) = bin.parent() {
        parts.push(d.to_path_buf());
    }
    if let Some(p) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&p));
    }
    parts.extend(common_dirs());
    std::env::join_paths(parts).unwrap_or_default()
}

pub async fn read_version(bin: &Path) -> Result<String, AiError> {
    let name = bin.file_name().and_then(|name| name.to_str()).unwrap_or("codex");
    let out = tokio::time::timeout(
        Duration::from_secs(10),
        Command::new(bin).arg("--version").env("PATH", child_path(bin)).stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .map_err(|_| AiError::new("other", format!("`{name} --version` timed out")))?
    .map_err(|e| AiError::new("other", format!("could not run {}: {e}", bin.display())))?;
    if !out.status.success() {
        return Err(AiError::new("other", format!("`{name} --version` failed")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub async fn login_status(bin: &Path) -> Result<bool, AiError> {
    let mut cmd = Command::new(bin);
    cmd.args(["login", "status"]).env("PATH", child_path(bin))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(10), cmd.status()).await
        .map_err(|_| AiError::new("timeout", "Checking Codex login timed out"))?
        .map(|status| status.success())
        .map_err(|_| AiError::new("process_exited", "Could not check Codex login"))
}

// ------------------------------------------------------------------ JSON-RPC client

/// Feature flags switched off for every app-server process (connectors/apps, plugins, sub-agents, browser and
/// computer use, goals, memories, hooks). Verified in the research notes to leave zero MCP servers together with
/// the per-server disables sent in `thread/start.config`.
pub(super) const DISABLED_FEATURES: &[&str] = &[
    "apps", "plugins", "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external", "computer_use",
    "in_app_browser", "goals", "memories", "hooks",
];

pub(super) async fn check_app_server_flags(bin: &Path) -> Result<(), AiError> {
    let mut cmd = Command::new(bin);
    cmd.args(["app-server", "--help"]).env("PATH", child_path(bin))
        .stdin(Stdio::null()).kill_on_drop(true);
    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(4), cmd.output()).await else {
        return Err(AiError::new("protocol", "Could not check Codex app-server options. Update the Codex CLI."));
    };
    if !output.status.success() {
        return Err(AiError::new("protocol", "This Codex CLI does not support app-server. Update the Codex CLI."));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let missing: Vec<_> = ["--listen", "--config", "--disable"].into_iter()
        .filter(|flag| !stdout.split_whitespace().any(|word| word == *flag)).collect();
    if !missing.is_empty() {
        return Err(AiError::new("protocol", format!(
            "Codex app-server is missing required options: {}. Update the Codex CLI.", missing.join(", ")
        )));
    }
    Ok(())
}

pub struct Client {
    pub(super) id: uuid::Uuid,
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, AiError>>>>,
    next_id: AtomicI64,
    alive: AtomicBool,
    pub started_at: Instant,
    stop: Notify,
    terminated: watch::Sender<bool>,
}

impl Client {
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// Spawns `codex app-server` with the isolation flags and starts the reader tasks.
    pub fn spawn(bin: &Path, cwd: &Path, id: uuid::Uuid, handler: Handler) -> Result<Arc<Client>, AiError> {
        let mut cmd = Command::new(bin);
        cmd.args(["app-server", "--listen", "stdio://", "-c", "web_search=disabled"]);
        for f in DISABLED_FEATURES {
            cmd.args(["--disable", f]);
        }
        cmd.current_dir(cwd)
            .env("PATH", child_path(bin))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| AiError::new("process_exited", format!("could not start codex: {e}")))?;
        let stdin = child.stdin.take().ok_or_else(|| AiError::new("other", "no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| AiError::new("other", "no stdout"))?;
        #[cfg(unix)]
        let group = child.id().and_then(|pid| i32::try_from(pid).ok());
        let client = Arc::new(Client {
            id,
            stdin: tokio::sync::Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            alive: AtomicBool::new(true),
            started_at: Instant::now(),
            stop: Notify::new(),
            terminated: watch::channel(false).0,
        });

        let process = client.clone();
        tauri::async_runtime::spawn(async move {
            // Wait for the process independently of stdout. A descendant can inherit the pipe.
            let stop = tokio::select! {
                _ = process.stop.notified() => true,
                _ = child.wait() => false,
            };
            #[cfg(unix)]
            if let Some(group) = group.filter(|group| *group > 0) {
                // SAFETY: the subprocess was started as the leader of this dedicated process group.
                unsafe { libc::kill(-group, libc::SIGKILL); }
            }
            if stop {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
            process.terminated.send_replace(true);
        });

        let c = client.clone();
        tauri::async_runtime::spawn(async move {
            let mut rd = BufReader::with_capacity(1 << 20, stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match rd.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                let Ok(m) = serde_json::from_str::<Value>(t) else {
                    log::warn!("codex: non-JSON line ({} bytes)", t.len());
                    continue;
                };
                c.route(m, &handler).await;
            }
            c.alive.store(false, Ordering::Relaxed);
            c.stop.notify_one();
            let drained: Vec<_> = c.pending.lock().map(|mut p| p.drain().collect()).unwrap_or_default();
            for (_, tx) in drained {
                let _ = tx.send(Err(AiError::new("process_exited", "The Codex process exited")));
            }
            handler(Incoming::Exited);
        });
        Ok(client)
    }

    async fn route(&self, mut m: Value, handler: &Handler) {
        let id = m.get("id").cloned();
        let method = m.get("method").and_then(|v| v.as_str()).map(String::from);
        match (id, method) {
            // server -> client request (approvals, elicitation): we never approve anything
            (Some(id), Some(method)) => {
                log::warn!("codex server request {method} declined");
                let reply = if method.ends_with("requestApproval") {
                    json!({"id": id, "result": {"decision": "decline"}})
                } else {
                    json!({"id": id, "error": {"code": -32601, "message": "not supported by this client"}})
                };
                let _ = self.write(&reply).await;
            }
            // response
            (Some(id), None) => {
                let Some(n) = id.as_i64() else { return };
                let tx = self.pending.lock().ok().and_then(|mut p| p.remove(&n));
                if let Some(tx) = tx {
                    let r = if let Some(e) = m.get("error") {
                        let mapped = super::map_turn_error(e);
                        let code = match mapped.code {
                            "rate_limited" | "usage_exhausted" | "not_logged_in" | "transient" => mapped.code,
                            _ => "protocol",
                        };
                        let message = e["message"].as_str().unwrap_or("request failed");
                        Err(AiError::new(code, message))
                    } else {
                        Ok(m.get_mut("result").map(Value::take).unwrap_or(Value::Null))
                    };
                    let _ = tx.send(r);
                }
            }
            // notification
            (None, Some(method)) => {
                let params = m.get_mut("params").map(Value::take).unwrap_or(Value::Null);
                handler(Incoming::Notification { method, params });
            }
            _ => {}
        }
    }

    async fn write(&self, v: &Value) -> Result<(), AiError> {
        let mut s = serde_json::to_string(v).map_err(|e| AiError::new("protocol", e.to_string()))?;
        s.push('\n');
        let mut w = self.stdin.lock().await;
        w.write_all(s.as_bytes()).await.map_err(|_| AiError::new("process_exited", "The Codex process is not accepting input"))?;
        w.flush().await.map_err(|_| AiError::new("process_exited", "The Codex process is not accepting input"))
    }

    pub async fn notify(&self, method: &str) -> Result<(), AiError> {
        self.write(&json!({"method": method})).await
    }

    pub async fn request(&self, method: &str, params: impl serde::Serialize, timeout: Duration) -> Result<Value, AiError> {
        if !self.is_alive() {
            return Err(AiError::new("process_exited", "The Codex process is not running"));
        }
        let params = serde_json::to_value(params).map_err(|error| AiError::new("protocol", error.to_string()))?;
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
        if let Err(e) = self.write(&json!({"method": method, "id": id, "params": params})).await {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err(AiError::new("process_exited", "The Codex process exited")),
            Err(_) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                Err(AiError::new("timeout", format!("{method} timed out")))
            }
        }
    }

    /// Control requests must answer even when a model turn is slow. Retire an unresponsive server.
    pub async fn control(&self, method: &str, params: impl serde::Serialize, timeout: Duration) -> Result<Value, AiError> {
        if let Ok(result) = tokio::time::timeout(timeout, self.request(method, params, timeout)).await
            && !matches!(&result, Err(error) if error.code == "timeout")
        {
            return result;
        }
        log::warn!("codex app-server did not answer {method}; stopping the process");
        self.kill().await;
        Err(AiError::new("process_exited", "The Codex process stopped responding"))
    }

    pub async fn wait_for_exit(&self) {
        let _ = self.terminated.subscribe().wait_for(|done| *done).await;
    }

    /// Stops and reaps the dedicated app-server process.
    pub async fn kill(&self) {
        self.alive.store(false, Ordering::Relaxed);
        self.stop.notify_one();
        let _ = tokio::time::timeout(Duration::from_secs(2), self.wait_for_exit()).await;
    }
}
