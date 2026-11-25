//! A path- and window-bound local agent session. The editor supplies snapshots and owns writes.
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum Edit {
    Add { parent: String, text: String },
    Rename { id: String, text: String },
    SetNote { id: String, note: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantInfo {
    id: String,
    socket: String,
    token: String,
    expires_at: u64,
    /// The grant ends this long after its last request.
    idle_ms: u64,
    path: String,
}

/// An agent's request for access, shown to the user as a prompt in the window that owns the map.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConsentRequest {
    id: String,
    client: String,
    access: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    id: String,
    document_id: String,
    #[serde(flatten)]
    action: Action,
}

/// Work for the web side. The host checks who may ask (token, document, path, tier, size, rate); the web side
/// validates and compiles agent op batches with the shared schema in core/model/agent-ops.ts.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Action {
    Read,
    Edit { edits: Vec<Edit> },
    Ops {
        batch: serde_json::Value,
        destructive: bool,
    },
    Undo { tx: String },
    /// Selection and camera only: never a document change, so the read tier may ask for it.
    View { command: serde_json::Value },
}

#[cfg(unix)]
mod socket {
    use super::{Action, ConsentRequest, Edit, GrantInfo, Work};
    use tauri::{Emitter, Manager};
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::collections::VecDeque;
    use std::fs::{self, DirBuilder};
    use std::io::{Read, Write};
    use std::os::unix::{
        fs::DirBuilderExt,
        net::{UnixListener, UnixStream},
    };
    use std::path::{Path, PathBuf};
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::thread;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use uuid::Uuid;

    /// A grant ends this long after its last request.
    const TTL: Duration = Duration::from_secs(15 * 60);
    /// How long an access prompt waits for the user.
    const CONSENT_TIMEOUT: Duration = Duration::from_secs(60);
    const MAX_CONTROL_FRAME: usize = 4096;
    /// Unix socket paths are limited to about 104 bytes on macOS.
    const MAX_SOCKET_PATH: usize = 100;
    const MAX_FRAME: usize = 8 * 1024 * 1024;
    /// The original three-edit message keeps its 64 KiB limit.
    const MAX_EDIT_FRAME: usize = 64 * 1024;
    const MAX_SNAPSHOT: usize = 16 * 1024 * 1024;
    const MAX_RESULT: usize = 1024 * 1024;
    /// Requests accepted per grant in any one-second window.
    const RATE_LIMIT: usize = 20;
    const IO_TIMEOUT: Duration = Duration::from_secs(3);
    const APPLY_TIMEOUT: Duration = Duration::from_secs(12);

    #[derive(Default)]
    pub struct AgentAccess {
        current: Mutex<Option<Arc<Grant>>>,
        consent: Mutex<Option<Consent>>,
    }

    /// One access prompt waiting for the user's answer in a window.
    struct Consent {
        id: String,
        owner: String,
        reply: mpsc::Sender<Result<Value, String>>,
    }

    struct Grant {
        id: String,
        token: String,
        socket: String,
        document_id: String,
        path: String,
        owner: String,
        writable: bool,
        destructive: bool,
        expires: Mutex<Instant>,
        enabled: AtomicBool,
        pending: Mutex<Option<Pending>>,
        recent: Mutex<VecDeque<Instant>>,
    }

    /// What the web side returned for one request.
    struct Done {
        payload: Option<String>,
        revision: Option<String>,
    }

    struct Pending {
        work: Work,
        delivered: bool,
        result: mpsc::Sender<Result<Done, String>>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Request {
        token: String,
        document_id: String,
        path: String,
        #[serde(default)]
        read: bool,
        edits: Option<Vec<Edit>>,
        /// An agent op batch, passed through to the web side after the host's checks.
        ops: Option<Value>,
        /// The client's declaration that the batch deletes something; the web side verifies it.
        #[serde(default)]
        destructive: bool,
        /// Undo the named agent transaction if it is the latest change.
        undo: Option<String>,
        /// Change the selection or the camera, or report them.
        view: Option<Value>,
    }

    /// A request on the control socket, before any grant exists.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ControlRequest {
        #[serde(default)]
        status: bool,
        connect: Option<Connect>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Connect {
        client: String,
        access: String,
    }

    impl Grant {
        fn active(&self) -> bool {
            self.enabled.load(Ordering::Acquire)
                && self.expires.lock().is_ok_and(|expires| Instant::now() < *expires)
        }

        /// Each accepted request keeps the grant alive for another idle period.
        fn touch(&self) {
            if let Ok(mut expires) = self.expires.lock() {
                *expires = Instant::now() + TTL;
            }
        }

        fn disable(&self) {
            self.enabled.store(false, Ordering::Release);
            if let Some(pending) = self.pending.lock().unwrap().take() {
                let _ = pending
                    .result
                    .send(Err("The app revoked this grant.".into()));
            }
        }
    }

    impl AgentAccess {
        pub fn grant(
            &self,
            document_id: String,
            path: String,
            owner: String,
            writable: bool,
            destructive: bool,
        ) -> Result<GrantInfo, String> {
            if !valid_id(&document_id) {
                return Err("Invalid document identifier.".into());
            }
            let mut current = self.current.lock().map_err(|_| "Agent access lock failed")?;
            let id = Uuid::new_v4().simple().to_string();
            // Keep the socket path short enough for Unix domain socket path limits.
            let directory = std::env::temp_dir().join(format!("radiant-agent-{}", &id[..16]));
            DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .map_err(|e| e.to_string())?;
            let socket = directory.join("write.sock");
            let listener = match bind(&socket) {
                Ok(listener) => listener,
                Err(error) => {
                    cleanup(&directory);
                    return Err(error.to_string());
                }
            };
            let token = Uuid::new_v4().simple().to_string();
            let grant = Arc::new(Grant {
                id: id.clone(),
                token: token.clone(),
                socket: socket.to_string_lossy().into_owned(),
                document_id,
                path: path.clone(),
                owner,
                writable,
                destructive: writable && destructive,
                expires: Mutex::new(Instant::now() + TTL),
                enabled: AtomicBool::new(true),
                pending: Mutex::new(None),
                recent: Mutex::new(VecDeque::new()),
            });
            let receiver = grant.clone();
            let cleanup_dir = directory.clone();
            if let Err(error) = thread::Builder::new()
                .name("radiant-agent".into())
                .spawn(move || serve(listener, receiver, cleanup_dir))
            {
                cleanup(&directory);
                return Err(error.to_string());
            }
            if let Some(old) = current.replace(grant) {
                old.disable();
            }
            let expires_at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
                + TTL.as_millis() as u64;
            Ok(GrantInfo {
                id,
                socket: socket.to_string_lossy().into_owned(),
                token,
                expires_at,
                idle_ms: TTL.as_millis() as u64,
                path,
            })
        }

        /// The window's answer to an access prompt: the grant it issued, or none for a refusal.
        pub fn resolve_consent(&self, id: &str, owner: &str, grant_id: Option<&str>, title: Option<String>) {
            let Ok(mut consent) = self.consent.lock() else { return };
            if !consent.as_ref().is_some_and(|pending| pending.id == id && pending.owner == owner) {
                return;
            }
            let pending = consent.take().unwrap();
            let granted = grant_id.and_then(|grant_id| {
                let current = self.current.lock().ok()?;
                let grant = current
                    .as_ref()
                    .filter(|grant| grant.id == grant_id && grant.owner == owner && grant.active())?;
                Some(json!({
                    "socket": grant.socket,
                    "token": grant.token,
                    "documentId": grant.document_id,
                    "path": grant.path,
                    "writable": grant.writable,
                    "destructive": grant.destructive,
                    "idleMs": TTL.as_millis() as u64,
                    "title": title.filter(|t| valid_text(t, 200)).unwrap_or_default(),
                }))
            });
            let _ = pending.reply.send(granted.ok_or_else(|| "The request was declined in Radiant.".to_string()));
        }

        pub fn revoke(&self, id: &str, owner: &str) {
            let mut current = self.current.lock().unwrap();
            if current
                .as_ref()
                .is_some_and(|grant| grant.id == id && grant.owner == owner)
            {
                current.take().unwrap().disable();
            }
        }

        pub fn take(&self, id: &str, owner: &str, owns: impl FnOnce(&str) -> bool) -> Option<Work> {
            let current = self.current.lock().ok()?;
            let grant = current
                .as_ref()
                .filter(|grant| grant.id == id && grant.owner == owner && grant.active())?;
            if !owns(&grant.path) {
                grant.disable();
                return None;
            }
            let mut guard = grant.pending.lock().ok()?;
            let pending = guard.as_mut().filter(|pending| !pending.delivered)?;
            pending.delivered = true;
            Some(pending.work.clone())
        }

        pub fn finish(
            &self,
            grant_id: &str,
            owner: &str,
            request_id: &str,
            error: Option<String>,
            snapshot: Option<String>,
            revision: Option<String>,
            owns: impl FnOnce(&str) -> bool,
        ) {
            let Ok(current) = self.current.lock() else { return };
            let Some(grant) = current
                .as_ref()
                .filter(|grant| grant.id == grant_id && grant.owner == owner)
            else {
                return;
            };
            if !owns(&grant.path) {
                grant.disable();
                return;
            }
            let Ok(mut guard) = grant.pending.lock() else {
                return;
            };
            if guard
                .as_ref()
                .is_some_and(|pending| pending.delivered && pending.work.id == request_id)
            {
                let pending = guard.take().unwrap();
                let revision = revision.filter(|r| r.len() <= 80 && r.is_ascii());
                let result = if let Some(error) = error {
                    Err(error)
                } else {
                    match (&pending.work.action, snapshot) {
                        (Action::Read, Some(json)) if json.len() <= MAX_SNAPSHOT => Ok(Done {
                            payload: Some(json),
                            revision,
                        }),
                        (Action::Read, _) => {
                            Err("The live map exceeded the snapshot limit.".into())
                        }
                        (Action::Edit { .. }, None) => Ok(Done {
                            payload: None,
                            revision,
                        }),
                        (Action::Ops { .. } | Action::Undo { .. } | Action::View { .. }, Some(json))
                            if json.len() <= MAX_RESULT
                                && serde_json::from_str::<Value>(&json).is_ok() =>
                        {
                            Ok(Done {
                                payload: Some(json),
                                revision,
                            })
                        }
                        _ => Err("Unexpected local agent response.".into()),
                    }
                };
                let _ = pending.result.send(result);
            }
        }
    }

    fn bind(path: &Path) -> std::io::Result<UnixListener> {
        let listener = UnixListener::bind(path)?;
        listener.set_nonblocking(true)?;
        Ok(listener)
    }

    fn cleanup(directory: &Path) {
        let _ = fs::remove_file(directory.join("write.sock"));
        let _ = fs::remove_dir(directory);
    }

    fn valid_id(value: &str) -> bool {
        let mut bytes = value.bytes();
        value.len() <= 128
            && bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
            && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }

    fn valid_text(value: &str, limit: usize) -> bool {
        value.len() <= limit
            && !value
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    }

    fn valid_edit(edit: &Edit) -> bool {
        match edit {
            Edit::Add { parent, text } => {
                valid_id(parent) && valid_text(text, 1_000) && !text.trim().is_empty()
            }
            Edit::Rename { id, text } => {
                valid_id(id) && valid_text(text, 1_000) && !text.trim().is_empty()
            }
            Edit::SetNote { id, note } => valid_id(id) && valid_text(note, 8_000),
        }
    }

    fn read_frame(mut stream: &UnixStream) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + IO_TIMEOUT;
        let mut frame = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Request timed out.".into());
            }
            stream
                .set_read_timeout(Some(remaining))
                .map_err(|e| e.to_string())?;
            let size = stream.read(&mut chunk).map_err(|e| e.to_string())?;
            if size == 0 || frame.len() + size > MAX_FRAME {
                return Err("Request exceeds the allowed frame size or is incomplete.".into());
            }
            frame.extend_from_slice(&chunk[..size]);
            if let Some(newline) = chunk[..size].iter().position(|b| *b == b'\n') {
                if newline + 1 != size {
                    return Err("Send one request per connection.".into());
                }
                return Ok(frame);
            }
        }
    }

    /// At most RATE_LIMIT requests in any one-second window per grant.
    fn within_rate(grant: &Grant) -> bool {
        let Ok(mut recent) = grant.recent.lock() else {
            return false;
        };
        let now = Instant::now();
        while recent
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(1))
        {
            recent.pop_front();
        }
        if recent.len() >= RATE_LIMIT {
            return false;
        }
        recent.push_back(now);
        true
    }

    fn dispatch(stream: &UnixStream, grant: &Grant) -> Result<(Action, Done), String> {
        let frame = read_frame(stream)?;
        let req: Request = serde_json::from_slice(&frame).map_err(|_| "Invalid request JSON.")?;
        if !grant.active()
            || req.token != grant.token
            || req.document_id != grant.document_id
            || req.path != grant.path
        {
            return Err("No active grant for this document path.".into());
        }
        if !within_rate(grant) {
            return Err("The app is busy: too many requests in one second. Retry shortly.".into());
        }
        let kinds = [req.read, req.edits.is_some(), req.ops.is_some(), req.undo.is_some(), req.view.is_some()];
        if kinds.iter().filter(|k| **k).count() != 1 {
            return Err("Send exactly one of read, edits, ops, undo or view.".into());
        }
        grant.touch();
        let writes = !req.read && req.view.is_none();
        if writes && !grant.writable {
            return Err("This grant allows live reads only.".into());
        }
        let action = if req.read {
            Action::Read
        } else if let Some(command) = req.view {
            if frame.len() > MAX_EDIT_FRAME || !command.is_object() {
                return Err("A view request is a small JSON object.".into());
            }
            Action::View { command }
        } else if let Some(edits) = req.edits {
            if frame.len() > MAX_EDIT_FRAME
                || edits.is_empty()
                || edits.len() > 32
                || !edits.iter().all(valid_edit)
            {
                return Err(
                    "Request a snapshot or submit between 1 and 32 supported edits.".into(),
                );
            }
            Action::Edit { edits }
        } else if let Some(batch) = req.ops {
            if !(batch.is_object() || batch.is_array()) {
                return Err("An op batch is a JSON object or array.".into());
            }
            if req.destructive && !grant.destructive {
                return Err(
                    "This grant does not allow destructive edits (deletes). Ask for a grant with deletes allowed."
                        .into(),
                );
            }
            Action::Ops {
                batch,
                destructive: req.destructive,
            }
        } else {
            let tx = req.undo.unwrap_or_default();
            if tx.is_empty() || tx.len() > 200 || !tx.is_ascii() {
                return Err("Name the agent transaction to undo.".into());
            }
            Action::Undo { tx }
        };
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = grant
                .pending
                .lock()
                .map_err(|_| "Agent queue unavailable")?;
            if !grant.active() {
                return Err("The grant expired.".into());
            }
            *pending = Some(Pending {
                work: Work {
                    id: Uuid::new_v4().simple().to_string(),
                    document_id: req.document_id,
                    action: action.clone(),
                },
                delivered: false,
                result: tx,
            });
        }
        match rx.recv_timeout(APPLY_TIMEOUT) {
            Ok(result) if grant.active() => result.map(|done| (action, done)),
            Ok(_) => Err("The grant expired or was revoked.".into()),
            Err(_) => {
                let mut pending = grant
                    .pending
                    .lock()
                    .map_err(|_| "Agent queue unavailable")?;
                let delivered = pending.take().is_some_and(|item| item.delivered);
                Err(if delivered {
                    "The app did not acknowledge the request. Check the document before trying again."
                } else {
                    "The app was not ready to apply the request."
                }.into())
            }
        }
    }

    /// Listen for agents asking for access. A connection carries one short JSON line; a connect request stays
    /// open while the user answers the prompt. Nothing about a map, and no token, crosses this socket until the
    /// user allows it in the app, and the token is never written to a file.
    pub fn setup(app: &tauri::AppHandle) {
        let Some(path) = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("agent").join("control.sock"))
        else {
            return;
        };
        if path.as_os_str().len() > MAX_SOCKET_PATH {
            log::warn!("Agent requests are off: the control socket path is too long.");
            return;
        }
        let Some(directory) = path.parent() else { return };
        if DirBuilder::new().recursive(true).mode(0o700).create(directory).is_err() {
            return;
        }
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(directory, fs::Permissions::from_mode(0o700));
        }
        if UnixStream::connect(&path).is_ok() {
            log::info!("Another Radiant instance answers agent requests.");
            return;
        }
        let _ = fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(listener) => listener,
            Err(error) => {
                log::warn!("Agent requests are off: {error}");
                return;
            }
        };
        let app = app.clone();
        let busy = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let _ = thread::Builder::new().name("radiant-agent-control".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                // A handful of callers at once: one may be waiting on a prompt while another asks for status.
                if busy.fetch_add(1, Ordering::AcqRel) >= 8 {
                    busy.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
                let (app, busy) = (app.clone(), busy.clone());
                let spawned = thread::Builder::new().name("radiant-agent-request".into()).spawn({
                    let busy = busy.clone();
                    move || {
                        control(&app, stream);
                        busy.fetch_sub(1, Ordering::AcqRel);
                    }
                });
                if spawned.is_err() {
                    busy.fetch_sub(1, Ordering::AcqRel);
                }
            }
        });
    }

    fn control(app: &tauri::AppHandle, mut stream: UnixStream) {
        if stream.set_nonblocking(false).is_err() || stream.set_write_timeout(Some(IO_TIMEOUT)).is_err() {
            return;
        }
        let reply = control_reply(app, &stream).unwrap_or_else(|error| json!({"ok": false, "error": error}));
        let _ = writeln!(stream, "{reply}");
    }

    fn control_reply(app: &tauri::AppHandle, stream: &UnixStream) -> Result<Value, String> {
        let frame = read_frame(stream)?;
        if frame.len() > MAX_CONTROL_FRAME {
            return Err("Request too large.".into());
        }
        let req: ControlRequest = serde_json::from_slice(&frame).map_err(|_| "Invalid request JSON.")?;
        let Some(connect) = req.connect else {
            if !req.status {
                return Err("Send status or connect.".into());
            }
            return Ok(json!({
                "ok": true,
                "app": "Radiant",
                "version": app.package_info().version.to_string(),
                "protocol": 1,
            }));
        };
        let client = connect.client.trim().to_owned();
        if client.is_empty() || !valid_text(&client, 80) || client.contains(['\n', '\r', '\t']) {
            return Err("Name the client in up to 80 characters.".into());
        }
        if !matches!(connect.access.as_str(), "read" | "write" | "destructive") {
            return Err("Ask for read, write or destructive access.".into());
        }
        let window = crate::open_files::focused_window(app)
            .filter(|w| w.label() != crate::capture::WINDOW && w.label() != crate::presenter::WINDOW)
            .ok_or("Open a map in Radiant first.")?;
        let state = app.state::<AgentAccess>();
        let id = Uuid::new_v4().simple().to_string();
        let (tx, rx) = mpsc::channel();
        {
            let mut consent = state.consent.lock().map_err(|_| "Agent access lock failed")?;
            if consent.is_some() {
                return Err("Radiant is already asking about another request.".into());
            }
            *consent = Some(Consent {
                id: id.clone(),
                owner: window.label().to_owned(),
                reply: tx,
            });
        }
        let request = ConsentRequest {
            id: id.clone(),
            client,
            access: connect.access,
        };
        let answer = if app.emit_to(window.label(), "agent-consent", request).is_ok() {
            // The person asked their agent to connect, so the prompt comes to the front.
            let _ = window.unminimize();
            let _ = window.set_focus();
            rx.recv_timeout(CONSENT_TIMEOUT)
                .map_err(|_| "No answer in Radiant before the request expired.".to_string())
                .and_then(|answer| answer)
        } else {
            Err("Radiant could not show the request.".into())
        };
        if let Ok(mut consent) = state.consent.lock() {
            if consent.as_ref().is_some_and(|pending| pending.id == id) {
                consent.take();
            }
        }
        if answer.is_err() {
            let _ = app.emit_to(window.label(), "agent-consent-cancel", id);
        }
        answer.map(|grant| json!({"ok": true, "grant": grant}))
    }

    fn serve(listener: UnixListener, grant: Arc<Grant>, directory: PathBuf) {
        while grant.active() {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    // The listener polls without blocking. Accepted streams use the bounded
                    // read and write deadlines even on platforms that inherit nonblocking mode.
                    if stream.set_nonblocking(false).is_err()
                        || stream.set_write_timeout(Some(IO_TIMEOUT)).is_err()
                    {
                        continue;
                    }
                    let result = dispatch(&stream, &grant);
                    let reply = match result {
                        Ok((Action::Read, done)) => {
                            let mut reply = json!({
                                "ok": true,
                                "snapshot": done.payload.unwrap_or_default(),
                                "writable": grant.writable,
                                "destructive": grant.destructive,
                            });
                            if let Some(revision) = done.revision {
                                reply["revision"] = json!(revision);
                            }
                            reply
                        }
                        Ok((Action::Edit { .. }, _)) => json!({"ok": true}),
                        Ok((_, done)) => {
                            let result = done
                                .payload
                                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                                .unwrap_or(Value::Null);
                            json!({"ok": true, "result": result})
                        }
                        Err(error) => json!({"ok": false, "error": error}),
                    };
                    let _ = writeln!(stream, "{reply}");
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(40))
                }
                Err(_) => break,
            }
        }
        grant.disable();
        cleanup(&directory);
    }
}

#[cfg(unix)]
pub use socket::{AgentAccess, setup};

#[cfg(not(unix))]
#[derive(Default)]
pub struct AgentAccess;

#[cfg(not(unix))]
pub fn setup(_app: &tauri::AppHandle) {}

/// An unsaved map has no file to bind a grant to; it is bound to its window and document instead.
fn untitled(path: &str) -> bool {
    path.starts_with("untitled:")
}

/// The window's answer to an access prompt. grant_id names the grant it issued; none declines.
#[tauri::command]
pub fn agent_consent(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentAccess>,
    id: String,
    grant_id: Option<String>,
    title: Option<String>,
) {
    #[cfg(unix)]
    state.resolve_consent(&id, window.label(), grant_id.as_deref(), title);
}

#[tauri::command]
pub fn agent_grant(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentAccess>,
    files: tauri::State<'_, crate::open_files::OpenFiles>,
    document_id: String,
    path: String,
    writable: bool,
    destructive: Option<bool>,
) -> Result<GrantInfo, String> {
    #[cfg(unix)]
    {
        let path = if untitled(&path) {
            if path != format!("untitled:{document_id}") {
                return Err("An unsaved map is granted by its document.".into());
            }
            path
        } else {
            let path = crate::open_files::canonical_path(std::path::Path::new(&path))?;
            if !files.owns(window.label(), &path) {
                return Err("The requesting window does not own this map.".into());
            }
            path
        };
        state.grant(
            document_id,
            path,
            window.label().to_owned(),
            writable,
            destructive.unwrap_or(false),
        )
    }
    #[cfg(not(unix))]
    Err("Local agent access needs Unix sockets.".into())
}

#[tauri::command]
pub fn agent_revoke(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentAccess>,
    id: String,
) {
    #[cfg(unix)]
    state.revoke(&id, window.label());
}

#[tauri::command]
pub fn agent_take(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentAccess>,
    files: tauri::State<'_, crate::open_files::OpenFiles>,
    id: String,
) -> Option<Work> {
    #[cfg(unix)]
    return state.take(&id, window.label(), |path| untitled(path) || files.owns(window.label(), path));
    #[cfg(not(unix))]
    return None;
}

#[tauri::command]
pub fn agent_finish(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AgentAccess>,
    files: tauri::State<'_, crate::open_files::OpenFiles>,
    grant_id: String,
    request_id: String,
    error: Option<String>,
    snapshot: Option<String>,
    revision: Option<String>,
) {
    #[cfg(unix)]
    state.finish(
        &grant_id,
        window.label(),
        &request_id,
        error,
        snapshot,
        revision,
        |path| untitled(path) || files.owns(window.label(), path),
    );
}
