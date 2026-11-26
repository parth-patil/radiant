//! The `ai_*` commands: AI turns through the Codex app-server, or through the Claude Code or Antigravity CLI.
//! Owner: AI agent.
//!
//! Codex: one long-lived `codex app-server --listen stdio://` child is started lazily on first use (`ai_status` or
//! `ai_start_turn`), initialised, and supervised: if it exits it is restarted on the next demand with
//! exponential backoff. Every job gets its own ephemeral thread and its own empty working directory.
//!
//! Claude Code and Antigravity (`cli`): a text turn whose request names `engine: "claude" | "antigravity"` runs as
//! one print-mode CLI process in its own empty working directory, through the same queue, cancellation, timeout,
//! usage and traces. Image turns always go to Codex, whatever the request names. These engines get no map-repair
//! round: a turn with `repairMap` ends with `done` and never emits `mapRoundDone`.
//!
//! Event sequence emitted on the `"ai-event"` channel for one job:
//!   started -> delta* (text, in order) [-> image] -> done {usage}
//! or ... -> error {code, message}  or  ... -> cancelled. Exactly one terminal event per job.
//! `rateLimits` events (jobId "") are emitted whenever Codex reports `account/rateLimits/updated`.
//!
//! Commands: `ai_status {refreshLimits, engine?}`, `ai_engines {}` (codex, claude, antigravity in that order),
//! `ai_start_turn {req}`, `ai_cancel`, `ai_resolve_map_round`, `ai_queue`.
//!
//! Debug builds only: `cargo run -- --ai-selftest[=text|schema|tools|image|cancel|status|engines] [--ai-engine=claude]`
//! runs one real turn without starting the app, prints every event with timings to stderr and exits (see `selftest`).
mod cli;
mod exec;
mod protocol_types;
mod rpc;
mod trace;

use base64::Engine as _;
use rpc::{AiError, Client, Handler, Incoming};
mod scheduler;

use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::{App, Emitter, Manager, State};
use tokio::sync::{Notify, mpsc, oneshot};

/// Fast model at low effort for map generation (verified: first delta in ~3 s). Used only if the account lists it.
const PREFERRED_MODELS: &[&str] = &["gpt-6-luna", "gpt-6.1-terra"];
const TESTED_CODEX_VERSION: &str = "codex-cli 0.167.0";
const DEFAULT_EFFORT: &str = "low";
fn configured_limit(name: &str, default: u64, min: u64, max: u64) -> u64 {
    std::env::var(name).ok().and_then(|value| value.parse().ok())
        .filter(|value| (min..=max).contains(value)).unwrap_or(default)
}

fn text_timeout() -> Duration {
    Duration::from_secs(configured_limit("RADIANT_AI_TEXT_TIMEOUT_SECONDS", 120, 15, 600))
}
const IMAGE_TIMEOUT: Duration = Duration::from_secs(180);
const STALL_WARN: Duration = Duration::from_secs(15);
const CANCEL_GRACE: Duration = Duration::from_secs(3);

// ------------------------------------------------------------------ public types

#[derive(Default)]
pub struct CodexState {
    inner: Arc<Inner>,
}

/// Mirrors `AiTurnRequest` in src/lib/host/types.ts.
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiTurnRequest {
    pub kind: String,
    #[serde(default)]
    pub web_search: bool,
    #[serde(default)]
    pub instructions: String,
    pub prompt: String,
    /// "claude" or "antigravity" for a text turn through that CLI; absent or "codex" for Codex.
    pub engine: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub output_schema: Option<Value>,
    pub exec_fallback_prompt: Option<String>,
    map_limits: Option<MapLimits>,
    #[serde(default)]
    prefer_exec_fallback: bool,
    #[serde(default)]
    repair_map: bool,
    pub template_version: Option<String>,
    #[serde(default)]
    pub ref_images: Vec<String>,
}

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct MapLimits {
    max_depth: usize,
    max_children: usize,
}

type EventSink = Arc<dyn Fn(&str, Option<&str>, &Value) + Send + Sync>;

struct Paths {
    assets: PathBuf,
    jobs: PathBuf,
}

struct Slot {
    client: Option<Arc<Client>>,
    bin: Option<PathBuf>,
    version: Option<String>,
    failures: u32,
    retry_at: Option<Instant>,
    last_error: Option<AiError>,
    logged_in: Option<bool>,
}

#[derive(Default)]
struct ReceivedText {
    chunks: Vec<String>,
    bytes: usize,
}

struct Job {
    received: Mutex<ReceivedText>,
    cancelled: AtomicBool,
    notify: Notify,
    usage: Mutex<Option<Value>>,
    trace: Mutex<Option<trace::Trace>>,
    owner: Option<String>,
    map_round: Mutex<Option<tokio::sync::oneshot::Sender<Option<String>>>>,
}

impl Job {
    fn receive_text(&self, chunk: &str) -> Result<(), AiError> {
        let mut received = self.received.lock()
            .map_err(|_| AiError::new("other", "The response buffer is unavailable."))?;
        if received.bytes.saturating_add(chunk.len()) > 4 * 1024 * 1024 || received.chunks.len() >= 32_768 {
            return Err(AiError::new("protocol", "The response exceeded its size limit."));
        }
        received.bytes += chunk.len();
        received.chunks.push(chunk.to_owned());
        Ok(())
    }

    fn has_received_text(&self) -> bool {
        self.received.lock().map_or(true, |received| received.bytes > 0)
    }

    fn record_usage(&self, input: Option<u64>, output: Option<u64>, prior: Option<&Value>) {
        let mut reported = serde_json::Map::new();
        for (field, source) in [("inputTokens", input), ("outputTokens", output)] {
            match (source, prior.and_then(|previous| previous[field].as_u64())) {
                (Some(count), previous) => { reported.insert(field.into(), json!(count.saturating_add(previous.unwrap_or(0)))); }
                (None, Some(previous)) => { reported.insert(field.into(), json!(previous)); }
                _ => {}
            }
        }
        if !reported.is_empty() && let Ok(mut usage) = self.usage.lock() {
            *usage = Some(Value::Object(reported));
        }
    }
}

#[derive(Default)]
struct Isolation {
    mcp_disabled: Vec<String>,
    default_model: Option<String>,
    /// `model/list` in the host contract's `AiModel` shape, for `ai_engines`.
    models: Vec<Value>,
}

type ThreadRoutes = HashMap<(uuid::Uuid, String), mpsc::UnboundedSender<(String, Value)>>;

struct Inner {
    emitter: OnceLock<EventSink>,
    paths: OnceLock<Paths>,
    slot: tokio::sync::Mutex<Slot>,
    routes: Mutex<ThreadRoutes>,
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    scheduler: Mutex<scheduler::Scheduler>,
    shutting_down: AtomicBool,
    trace_rotation: Mutex<()>,
    active_client: Mutex<Option<Weak<Client>>>,
    rate: Mutex<Option<Value>>,
    iso: Mutex<Isolation>,
    cli: cli::CliState,
}

impl Default for Inner {
    fn default() -> Self {
        Inner {
            emitter: OnceLock::new(),
            paths: OnceLock::new(),
            slot: tokio::sync::Mutex::new(Slot {
                client: None,
                bin: None,
                version: None,
                failures: 0,
                retry_at: None,
                last_error: None,
                logged_in: None,
            }),
            routes: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            scheduler: Mutex::new(scheduler::Scheduler::new(configured_limit("RADIANT_AI_CONCURRENCY", 2, 1, 4) as usize)),
            shutting_down: AtomicBool::new(false),
            trace_rotation: Mutex::new(()),
            active_client: Mutex::new(None),
            rate: Mutex::new(None),
            iso: Mutex::new(Isolation::default()),
            cli: cli::CliState::default(),
        }
    }
}

impl Inner {
    fn emit(&self, v: Value) {
        let job = v["jobId"].as_str().filter(|id| !id.is_empty())
            .and_then(|id| self.jobs.lock().ok().and_then(|jobs| jobs.get(id).cloned()));
        if let Some(job) = &job
            && let Ok(mut trace) = job.trace.lock()
            && let Some(trace) = trace.as_mut()
        {
            trace.event(&v);
        }
        if let Some(emit) = self.emitter.get() {
            emit("ai-event", job.as_ref().and_then(|job| job.owner.as_deref()), &v);
        }
    }

    fn emit_queue(&self, scheduler: &scheduler::Scheduler) {
        if let Some(emit) = self.emitter.get() {
            emit("ai-queue", None, &scheduler.snapshot());
        }
    }

    fn paths(&self) -> Paths {
        match self.paths.get() {
            Some(p) => Paths { assets: p.assets.clone(), jobs: p.jobs.clone() },
            None => {
                let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("radiant");
                let data = dirs::data_dir().unwrap_or_else(std::env::temp_dir).join("radiant");
                Paths { assets: data.join("assets"), jobs: base.join("ai-jobs") }
            }
        }
    }

    /// Latest rate-limit snapshot in the host-contract shape.
    fn rate_limits(&self) -> Option<Value> {
        self.rate.lock().ok().and_then(|r| r.clone()).map(|raw| rate_limits_json(&raw))
    }

    fn update_rate_limits(&self, snapshot: &Value, replace: bool) {
        if let Ok(mut r) = self.rate.lock() {
            if replace {
                *r = Some(snapshot.clone());
            } else if let Some(src) = snapshot.as_object() {
                let merged = r.get_or_insert_with(|| json!({}));
                for (key, value) in src.iter().filter(|(_, value)| !value.is_null()) {
                    if let (Some(prior), Some(update)) = (merged[key].as_object_mut(), value.as_object()) {
                        prior.extend(update.iter().filter(|(_, value)| !value.is_null()).map(|(k, v)| (k.clone(), v.clone())));
                    } else {
                        merged[key] = value.clone();
                    }
                }
            }
        }
        if let Some(rl) = self.rate_limits() {
            self.emit(json!({"jobId": "", "kind": "rateLimits", "rateLimits": rl}));
        }
    }
}

// ------------------------------------------------------------------ setup

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<CodexState>();
    let inner = state.inner.clone();
    let data = app.path().app_data_dir()?;
    let cache = app.path().app_cache_dir()?;
    let jobs = cache.join("ai-jobs").join(uuid::Uuid::new_v4().to_string());
    let _ = inner.paths.set(Paths { assets: data.join("assets"), jobs });

    let handle = app.handle().clone();
    let emitter: EventSink = Arc::new(move |event, owner, v| {
        if let Some(window) = owner {
            let _ = handle.emit_to(window, event, v);
        } else {
            let _ = handle.emit(event, v);
        }
    });
    let _ = inner.emitter.set(emitter);
    Ok(())
}

pub fn cancel_window(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<CodexState>();
    if let Ok(jobs) = state.inner.jobs.lock() {
        for job in jobs.values().filter(|job| job.owner.as_deref() == Some(label)) {
            request_cancel(job);
        }
    }
}

pub fn shutdown(app: &tauri::AppHandle) {
    let inner = app.state::<CodexState>().inner.clone();
    inner.shutting_down.store(true, Ordering::SeqCst);
    if let Ok(jobs) = inner.jobs.lock() {
        for job in jobs.values() {
            job.cancelled.store(true, Ordering::SeqCst);
            job.notify.notify_one();
        }
    }
    tauri::async_runtime::block_on(async move {
        let client = inner.active_client.lock().ok().and_then(|client| client.as_ref().and_then(Weak::upgrade));
        if let Some(client) = client {
            client.kill().await;
        }
        let _ = tokio::time::timeout(Duration::from_millis(750), async {
            while inner.jobs.lock().is_ok_and(|jobs| !jobs.is_empty()) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await;
    });
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub async fn ai_status(refresh_limits: Option<bool>, engine: Option<String>, state: State<'_, CodexState>) -> Result<Value, String> {
    match engine.as_deref() {
        None | Some("codex") => Ok(status(&state.inner, refresh_limits.unwrap_or(false)).await),
        Some(name) => match cli::Engine::parse(name) {
            Some(engine) => Ok(cli::status(&state.inner, engine).await),
            None => Err(format!("unknown AI engine '{name}'")),
        },
    }
}

/// Every engine with what is installed and which models it offers, in the order codex, claude, antigravity.
#[tauri::command]
pub async fn ai_engines(state: State<'_, CodexState>) -> Result<Value, String> {
    Ok(engines(&state.inner).await)
}

async fn engines(inner: &Arc<Inner>) -> Value {
    let (codex, claude, antigravity) = tokio::join!(
        codex_engine(inner),
        cli::engine_info(inner, cli::Engine::ALL[0]),
        cli::engine_info(inner, cli::Engine::ALL[1]),
    );
    json!([codex, claude, antigravity])
}

async fn codex_engine(inner: &Arc<Inner>) -> Value {
    let started = tokio::time::timeout(Duration::from_secs(30), get_client(inner)).await;
    let (bin, version, logged_in) = {
        let slot = inner.slot.lock().await;
        (slot.bin.clone(), slot.version.clone(), slot.logged_in)
    };
    let mut v = json!({"engine": "codex", "label": "Codex", "installed": bin.is_some(), "models": [], "customModels": false, "defaultEffort": DEFAULT_EFFORT});
    if let Some(version) = version {
        v["version"] = json!(version);
    }
    let error = match started {
        Ok(Ok(_)) => {
            if let Ok(iso) = inner.iso.lock() {
                v["models"] = json!(iso.models);
                let fallback = iso.models.iter().find(|model| model["isDefault"] == true).or(iso.models.first()).and_then(|model| model["id"].as_str());
                if let Some(model) = iso.default_model.as_deref().or(fallback) {
                    v["defaultModel"] = json!(model);
                }
            }
            if let Some(models) = v["models"].as_array_mut() {
                models.iter_mut().filter_map(Value::as_object_mut).for_each(|model| { model.remove("isDefault"); });
            }
            (logged_in == Some(false)).then(|| AiError::new("not_logged_in", "Not signed in to Codex. Run `codex login` in a terminal, then try again."))
        }
        Ok(Err(error)) => Some(error),
        Err(_) => Some(AiError::new("timeout", "Codex did not start in time.")),
    };
    if let Some(error) = error {
        v["error"] = json!(error.message);
        v["errorCode"] = json!(error.code);
    }
    v
}

/// Whether Codex is ready to draw pictures; bounded so a slow Codex start never holds up another engine's status.
async fn codex_draws_images(inner: &Arc<Inner>) -> bool {
    matches!(tokio::time::timeout(Duration::from_secs(10), get_client(inner)).await, Ok(Ok(_)))
        && inner.slot.lock().await.logged_in != Some(false)
}

#[tauri::command]
pub fn ai_queue(state: State<'_, CodexState>) -> Result<Value, String> {
    Ok(state.inner.scheduler.lock().map_err(|e| e.to_string())?.snapshot())
}

#[tauri::command]
pub async fn ai_start_turn(req: AiTurnRequest, window: tauri::WebviewWindow, state: State<'_, CodexState>) -> Result<String, String> {
    start_turn(&state.inner, req, Some(window.label().to_owned()))
}

#[tauri::command]
pub async fn ai_resolve_map_round(
    job_id: String, prompt: Option<String>, window: tauri::WebviewWindow, state: State<'_, CodexState>,
) -> Result<(), String> {
    if prompt.as_ref().is_some_and(|p| p.trim().is_empty() || p.len() > 32_000) {
        return Err("Invalid map repair prompt.".into());
    }
    let job = state.inner.jobs.lock().ok().and_then(|jobs| jobs.get(&job_id).cloned())
        .filter(|job| job.owner.as_deref() == Some(window.label()))
        .ok_or("This map generation job is no longer active.")?;
    let response = job.map_round.lock().ok().and_then(|mut round| round.take())
        .ok_or("The generation job is not awaiting a repair decision.")?;
    response.send(prompt).map_err(|_| "The generation job stopped waiting.".into())
}

#[tauri::command]
pub async fn ai_cancel(job_id: String, window: tauri::WebviewWindow, state: State<'_, CodexState>) -> Result<(), String> {
    let job = state.inner.jobs.lock().map_err(|e| e.to_string())?.get(&job_id).cloned();
    if let Some(job) = job {
        if job.owner.as_deref() != Some(window.label()) {
            return Err("This job belongs to another window.".into());
        }
        request_cancel(&job);
    }
    Ok(())
}

async fn status(inner: &Arc<Inner>, refresh_limits: bool) -> Value {
    match get_client(inner).await {
        Ok(client) => {
            let (version, logged_in, bin) = {
                let s = inner.slot.lock().await;
                (s.version.clone(), s.logged_in, s.bin.clone())
            };
            // Re-check login each time the UI asks (cheap request); the user may have run `codex login` meanwhile.
            let logged_in = match check_login(&client).await {
                Ok(b) => {
                    inner.slot.lock().await.logged_in = Some(b);
                    b
                }
                Err(_) => logged_in.unwrap_or(true),
            };
            let mut v = json!({"available": logged_in, "provider": "codex", "capabilities": {"streaming": true, "images": true, "rateLimits": true}});
            if let Some(ver) = version {
                if ver != TESTED_CODEX_VERSION {
                    v["versionWarning"] = json!(format!("{ver} differs from the model-tested CLI version {TESTED_CODEX_VERSION}."));
                    if let Some(bin) = bin {
                        v["fallbackAvailable"] = json!(logged_in && exec::available(&bin).await);
                    }
                }
                v["version"] = json!(ver);
            }
            if !logged_in {
                v["error"] = json!("Not signed in to Codex. Run `codex login` in a terminal, then try again.");
                v["errorCode"] = json!("not_logged_in");
            }
            if refresh_limits && logged_in {
                refresh_rate_limits(inner, &client).await;
            }
            if let Some(rl) = inner.rate_limits() {
                v["rateLimits"] = rl;
            }
            v
        }
        Err(e) => {
            let (version, bin) = {
                let slot = inner.slot.lock().await;
                (slot.version.clone(), slot.bin.clone())
            };
            let fallback_available = if startup_error(&e) {
                if let Some(bin) = bin { exec::available(&bin).await } else { false }
            } else { false };
            let mut v = json!({"available": false, "fallbackAvailable": fallback_available, "provider": "codex", "capabilities": {"streaming": false, "images": false, "rateLimits": false}, "error": e.message, "errorCode": e.code});
            if let Some(ver) = version {
                v["version"] = json!(ver);
            }
            v
        }
    }
}

fn start_turn(inner: &Arc<Inner>, req: AiTurnRequest, owner: Option<String>) -> Result<String, String> {
    if inner.shutting_down.load(Ordering::SeqCst) {
        return Err("Radiant is closing.".into());
    }
    if req.kind != "text" && req.kind != "image" {
        return Err(format!("unknown turn kind '{}'", req.kind));
    }
    if req.prompt.trim().is_empty() {
        return Err("empty prompt".into());
    }
    let engine = match req.engine.as_deref() {
        None | Some("codex") => None,
        Some(name) => Some(cli::Engine::parse(name).ok_or_else(|| format!("unknown AI engine '{name}'"))?),
    };
    if req.model.as_deref().is_some_and(|model| !cli::safe_value(model)) {
        return Err("invalid model name".into());
    }
    if let Some(effort) = req.effort.as_deref()
        && (!cli::safe_value(effort) || engine.is_some() && !cli::EFFORTS.contains(&effort))
    {
        return Err("invalid effort level".into());
    }
    let job_id = uuid::Uuid::new_v4().to_string();
    let job = Arc::new(Job { received: Mutex::default(), cancelled: AtomicBool::new(false), notify: Notify::new(), usage: Mutex::new(None), trace: Mutex::new(None), owner: owner.clone(), map_round: Mutex::new(None) });
    let activity = match req.template_version.as_deref().and_then(|template| template.split('/').next()) {
        Some("map") => "generate",
        Some("expand") => "expand",
        Some("refine" | "rephrase") => "refine",
        Some("svg" | "svg-repair") => "svg",
        _ if req.kind == "image" => "picture",
        _ => "text",
    };
    let admission = {
        let mut scheduler = inner.scheduler.lock().map_err(|e| e.to_string())?;
        if inner.shutting_down.load(Ordering::SeqCst) {
            return Err("Radiant is closing.".into());
        }
        inner.jobs.lock().map_err(|e| e.to_string())?.insert(job_id.clone(), job.clone());
        let admission = scheduler.submit(job_id.clone(), owner, activity);
        inner.emit_queue(&scheduler);
        admission
    };
    let inner2 = inner.clone();
    let id2 = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = run_job(&inner2, &id2, &job, &req, admission).await;
        let mut ev = match outcome {
            Terminal::Done => json!({"jobId": id2, "kind": "done"}),
            Terminal::Cancelled => json!({"jobId": id2, "kind": "cancelled"}),
            Terminal::Error(err) => json!({"jobId": id2, "kind": "error", "code": err.code, "message": err.message}),
        };
        if let Ok(mut usage) = job.usage.lock()
            && let Some(value) = usage.take()
        {
            ev["usage"] = value;
        }
        inner2.emit(ev);
        let client = inner2.slot.lock().await.client.clone();
        if let Some(client) = client.filter(|client| client.is_alive() && cli_engine(&req).is_none()) {
            refresh_rate_limits(&inner2, &client).await;
        }
        if let Ok(mut scheduler) = inner2.scheduler.lock() {
            scheduler.complete(&id2, inner2.shutting_down.load(Ordering::SeqCst));
            inner2.emit_queue(&scheduler);
        }
        if let Ok(mut j) = inner2.jobs.lock() {
            j.remove(&id2);
        }
    });
    Ok(job_id)
}

#[cfg(debug_assertions)]
fn cancel(inner: &Arc<Inner>, job_id: &str) {
    let job = inner.jobs.lock().ok().and_then(|j| j.get(job_id).cloned());
    if let Some(job) = job {
        request_cancel(&job);
    }
}

fn request_cancel(job: &Job) {
    job.cancelled.store(true, Ordering::SeqCst);
    job.notify.notify_one();
}

// ------------------------------------------------------------------ process supervision

fn backoff(failures: u32) -> Duration {
    Duration::from_millis((500u64 << failures.saturating_sub(1).min(6)).min(30_000))
}

/// Returns a live, initialised client, starting (or restarting) the app-server if needed.
async fn get_client(inner: &Arc<Inner>) -> Result<Arc<Client>, AiError> {
    let mut slot = inner.slot.lock().await;
    if inner.shutting_down.load(Ordering::SeqCst) {
        return Err(AiError::new("other", "Radiant is closing."));
    }
    if let Some(client) = slot.client.clone() {
        if client.is_alive() {
            let same_version = if let Some(bin) = &slot.bin {
                rpc::read_version(bin).await.ok().as_ref().is_some_and(|version| Some(version) == slot.version.as_ref())
            } else {
                false
            };
            if same_version { return Ok(client); }
            log::info!("Codex installation changed; reconnecting");
            client.kill().await;
            slot.bin = None;
            slot.version = None;
            slot.failures = 0;
        } else {
            // Retry immediately after the first crash. Repeated quick deaths back off.
            slot.failures = if client.started_at.elapsed() < Duration::from_secs(10) { slot.failures + 1 } else { 1 };
            let wait = if slot.failures == 1 { Duration::ZERO } else { backoff(slot.failures - 1) };
            log::warn!("codex app-server exited; restarting after {wait:?}");
            if !wait.is_zero() { tokio::time::sleep(wait).await; }
        }
        slot.client = None;
    }
    if let (Some(t), Some(e)) = (slot.retry_at, slot.last_error.clone()) {
        if Instant::now() < t {
            return Err(e);
        }
    }
    match start_client(inner, &mut slot).await {
        Ok(c) => {
            slot.client = Some(c.clone());
            slot.retry_at = None;
            slot.last_error = None;
            Ok(c)
        }
        Err(e) => {
            slot.failures += 1;
            let wait = if e.code == "not_installed" { Duration::from_secs(2) } else { backoff(slot.failures) };
            slot.retry_at = Some(Instant::now() + wait);
            slot.last_error = Some(e.clone());
            Err(e)
        }
    }
}

fn cli_version(value: &str) -> Option<[u64; 3]> {
    let mut parts = value.split_whitespace().last()?.split('-').next()?.split('.');
    let version = [parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?];
    parts.next().is_none().then_some(version)
}

async fn start_client(inner: &Arc<Inner>, slot: &mut Slot) -> Result<Arc<Client>, AiError> {
    let bin = rpc::locate_codex().await?;
    let version = rpc::read_version(&bin).await?;
    slot.bin = Some(bin.clone());
    slot.version = Some(version.clone());
    log::info!("codex binary {} ({version})", bin.display());
    if !rpc::login_status(&bin).await? {
        return Err(AiError::new("not_logged_in", "Not signed in to Codex. Run `codex login` in a terminal, then try again."));
    }
    if !matches!((cli_version(&version), cli_version(TESTED_CODEX_VERSION)), (Some(installed), Some(tested)) if installed >= tested) {
        return Err(AiError::new("protocol", format!(
            "Radiant needs {TESTED_CODEX_VERSION} or newer for streaming. Installed: {version}. Update the Codex CLI."
        )));
    }
    rpc::check_app_server_flags(&bin).await?;
    let jobs_dir = inner.paths().jobs;
    tokio::fs::create_dir_all(&jobs_dir).await.map_err(|e| AiError::new("other", format!("cache dir: {e}")))?;

    let id = uuid::Uuid::new_v4();
    let weak: Weak<Inner> = Arc::downgrade(inner);
    let handler: Handler = Arc::new(move |msg| {
        if let Some(inner) = weak.upgrade() {
            dispatch(&inner, id, msg);
        }
    });
    let client = {
        let mut current = inner.active_client.lock()
            .map_err(|_| AiError::new("other", "The Codex process supervisor is unavailable."))?;
        if inner.shutting_down.load(Ordering::SeqCst) {
            return Err(AiError::new("other", "Radiant is closing."));
        }
        let client = Client::spawn(&bin, &jobs_dir, id, handler)?;
        *current = Some(Arc::downgrade(&client));
        client
    };

    let handshake = async {
        let reply = client
            .request(
                "initialize",
                protocol_types::InitializeParams {
                    client_info: protocol_types::ClientInfo {
                        name: "radiant".into(), title: Some("Radiant".into()),
                        version: env!("CARGO_PKG_VERSION").into(),
                    },
                    capabilities: Some(protocol_types::InitializeCapabilities {
                        experimental_api: Some(false), request_attestation: Some(false),
                    }),
                },
                Duration::from_secs(20),
            )
            .await.map_err(|_| AiError::new("protocol", "Codex app-server could not initialize. Update the Codex CLI."))?;
        let failed = || AiError::new("protocol", "Codex returned an incompatible initialize response. Update the Codex CLI.");
        let reply: protocol_types::InitializeResponse = serde_json::from_value(reply).map_err(|_| failed())?;
        if reply.user_agent.is_empty() {
            return Err(failed());
        }
        client.notify("initialized").await?;
        Ok::<(), AiError>(())
    };
    if let Err(e) = handshake.await {
        client.kill().await;
        return Err(e);
    }

    // Discover the user's own MCP server names (they are disabled per thread; there is no flag that does it
    // globally). `config/read` returns the effective config; only the names are used.
    let config = client.request("config/read", protocol_types::ConfigReadParams { include_layers: Some(false) }, Duration::from_secs(10)).await
        .ok().and_then(|reply| protocol_types::ConfigReadResponse::deserialize(reply).ok())
        .map(|reply| reply.config).filter(Value::is_object);
    let Some(config) = config else {
        client.kill().await;
        return Err(AiError::new("protocol", "Could not verify Codex tool isolation for the app server."));
    };
    let names = config["mcp_servers"].as_object()
        .map(|servers| servers.keys().cloned().collect()).unwrap_or_default();
    if let Ok(mut iso) = inner.iso.lock() {
        iso.mcp_disabled = names;
    }
    if let Ok(reply) = client.request("model/list", protocol_types::ModelListParams { limit: Some(100) }, Duration::from_secs(10)).await
        && let Ok(models) = protocol_types::ModelListResponse::deserialize(&reply)
    {
        let pick = PREFERRED_MODELS.iter().find(|p| models.data.iter().any(|model| model.id == **p)).map(|s| s.to_string());
        let listed = reply["data"].as_array().map(|data| data.iter().filter(|model| model["hidden"] != true).filter_map(codex_model).collect()).unwrap_or_default();
        if let Ok(mut iso) = inner.iso.lock() {
            iso.default_model = pick;
            iso.models = listed;
        }
    }
    match check_login(&client).await {
        Ok(b) => slot.logged_in = Some(b),
        Err(error) => {
            client.kill().await;
            return Err(error);
        }
    }
    refresh_rate_limits(inner, &client).await;
    Ok(client)
}

/// One `model/list` entry as an `AiModel` (plus `isDefault`, dropped before it leaves the host). Efforts outside the
/// host contract are left out; a model that lists none is offered low, medium and high.
fn codex_model(model: &Value) -> Option<Value> {
    let id = model["id"].as_str().filter(|id| cli::safe_value(id))?;
    let efforts: Vec<&str> = match model["supportedReasoningEfforts"].as_array() {
        Some(listed) => cli::EFFORTS.iter().copied()
            .filter(|effort| listed.iter().any(|option| option["reasoningEffort"] == *effort || option == effort)).collect(),
        None => vec!["low", "medium", "high"],
    };
    let label = model["displayName"].as_str().filter(|label| !label.trim().is_empty()).unwrap_or(id);
    Some(json!({"id": id, "label": label, "efforts": efforts, "isDefault": model["isDefault"] == true}))
}

async fn refresh_rate_limits(inner: &Inner, client: &Client) {
    if let Ok(reply) = client.request("account/rateLimits/read", protocol_types::GetAccountRateLimitsParams {}, Duration::from_secs(5)).await
        && let Ok(reply) = protocol_types::GetAccountRateLimitsResponse::deserialize(reply)
        && reply.rate_limits.is_object()
    {
        inner.update_rate_limits(&reply.rate_limits, true);
    }
}

async fn check_login(client: &Client) -> Result<bool, AiError> {
    let r = client.request("account/read", protocol_types::GetAccountParams { refresh_token: Some(false) }, Duration::from_secs(10)).await?;
    let reply: protocol_types::GetAccountResponse = serde_json::from_value(r)
        .map_err(|_| AiError::new("protocol", "Codex returned an incompatible account response. Update the Codex CLI."))?;
    Ok(reply.account.is_some_and(|account| account.is_object()) || !reply.requires_openai_auth)
}

/// Runs on the reader task: routes thread-scoped notifications to the owning job, handles account-level ones.
fn dispatch(inner: &Arc<Inner>, client_id: uuid::Uuid, msg: Incoming) {
    match msg {
        Incoming::Exited => {
            if let Ok(routes) = inner.routes.lock() {
                for (_, tx) in routes.iter().filter(|((id, _), _)| *id == client_id) {
                    let _ = tx.send(("__exited".into(), Value::Null));
                }
            }
        }
        Incoming::Notification { method, params } => {
            if method == "account/rateLimits/updated" {
                if let Ok(update) = protocol_types::AccountRateLimitsUpdatedNotification::deserialize(params) {
                    inner.update_rate_limits(&update.rate_limits, false);
                }
                return;
            }
            if let Ok(route) = protocol_types::ThreadRoute::deserialize(&params) {
                if let Ok(routes) = inner.routes.lock() {
                    if let Some(tx) = routes.get(&(client_id, route.thread_id)) {
                        let _ = tx.send((method, params));
                    }
                }
            }
        }
    }
}

// ------------------------------------------------------------------ jobs

enum Terminal {
    Done,
    Cancelled,
    Error(AiError),
}

/// The CLI a turn runs through, or None for Codex. Pictures always use Codex.
fn cli_engine(req: &AiTurnRequest) -> Option<cli::Engine> {
    req.engine.as_deref().filter(|_| req.kind == "text").and_then(cli::Engine::parse)
}

fn startup_error(e: &AiError) -> bool {
    matches!(e.code, "protocol" | "process_exited" | "timeout")
}

async fn run_job(
    inner: &Arc<Inner>, job_id: &str, job: &Arc<Job>, req: &AiTurnRequest, admission: oneshot::Receiver<()>,
) -> Terminal {
    tokio::select! {
        ready = admission => if ready.is_err() {
            return Terminal::Error(AiError::new("other", "scheduler closed"));
        },
        _ = job.notify.notified() => return Terminal::Cancelled,
    }
    if job.cancelled.load(Ordering::SeqCst) {
        return Terminal::Cancelled;
    }
    let engine = cli_engine(req);
    if engine.is_none() && let Some(error) = inner.rate.lock().ok().and_then(|rate| rate.as_ref().and_then(allowance_error)) {
        return Terminal::Error(error);
    }
    let jobs = inner.paths().jobs;
    let logs = jobs.parent().unwrap_or(&jobs).with_file_name("ai-protocol-logs");
    if let Ok(mut entry) = job.trace.lock() && let Ok(rotation) = inner.trace_rotation.lock() {
        *entry = trace::Trace::open(&logs, job_id, rotation);
        if let Some(trace) = entry.as_mut() {
            trace.write(json!({
                "kind": "configuration", "templateVersion": req.template_version,
                "engine": engine.map_or("codex", cli::Engine::id),
                "web_search": if req.web_search && req.kind == "text" && engine != Some(cli::Engine::Antigravity) { "live" } else { "disabled" }
            }));
        }
    }
    let cwd = jobs.join(job_id);
    if let Some(engine) = engine {
        let result = cli::run(inner, engine, job_id, job, req, &cwd).await;
        let _ = tokio::fs::remove_dir_all(&cwd).await;
        return result;
    }
    if req.prefer_exec_fallback && req.kind == "text"
        && let Some(prompt) = req.exec_fallback_prompt.as_deref().filter(|prompt| !prompt.trim().is_empty())
    {
        let result = async {
            let bin = rpc::locate_codex().await?;
            rpc::read_version(&bin).await?;
            if !rpc::login_status(&bin).await? {
                return Err(AiError::new("not_logged_in", "Sign in to Codex first."));
            }
            if !exec::available(&bin).await {
                return Err(AiError::new("protocol", "This Codex version does not support the JSON fallback."));
            }
            Ok(exec::run(inner, &bin, job_id, job, req, &cwd, prompt).await)
        }.await.unwrap_or_else(Terminal::Error);
        let _ = tokio::fs::remove_dir_all(&cwd).await;
        return result;
    }
    let mut dispatched_turn = false;
    let mut result = run_attempt(inner, job_id, job, req, &cwd, &mut dispatched_turn).await;
    if matches!(&result, Terminal::Error(error) if error.code == "transient")
        && !job.cancelled.load(Ordering::SeqCst)
        && req.kind == "text"
        && !job.has_received_text()
    {
        inner.emit(json!({"jobId": job_id, "kind": "warning", "message": "Codex reported a temporary connection or capacity problem. Retrying once."}));
        let retry_cwd = cwd.join("retry");
        // Once any attempt is dispatched, this job must never fall back to another provider route.
        result = run_attempt(inner, job_id, job, req, &retry_cwd, &mut dispatched_turn).await;
    }
    if !dispatched_turn && req.kind == "text"
        && matches!(&result, Terminal::Error(error) if startup_error(error))
        && let Some(prompt) = req.exec_fallback_prompt.as_deref().filter(|p| !p.trim().is_empty())
    {
        let bin = inner.slot.lock().await.bin.clone();
        if let Some(bin) = bin
            && matches!(rpc::login_status(&bin).await, Ok(true))
            && exec::available(&bin).await
        {
            result = exec::run(inner, &bin, job_id, job, req, &cwd, prompt).await;
        }
    }
    let _ = tokio::fs::remove_dir_all(&cwd).await;
    result
}

async fn run_attempt(
    inner: &Arc<Inner>, job_id: &str, job: &Arc<Job>, req: &AiTurnRequest, cwd: &Path,
    dispatched_turn: &mut bool,
) -> Terminal {
    let mut thread_id = None;
    let result = run_turn(inner, job_id, job, req, cwd, &mut thread_id, dispatched_turn).await;
    if let Some((client, tid)) = thread_id {
        if let Ok(mut routes) = inner.routes.lock() {
            routes.remove(&(client.id, tid.clone()));
        }
        if client.is_alive() {
            tauri::async_runtime::spawn(async move {
                let _ = client.request("thread/unsubscribe", protocol_types::ThreadUnsubscribeParams { thread_id: tid }, Duration::from_secs(3)).await;
            });
        }
    }
    result
}

fn mcp_and_feature_config(inner: &Inner, image: bool, web_search: bool) -> Value {
    let mut cfg = serde_json::Map::new();
    if let Ok(iso) = inner.iso.lock() {
        for n in &iso.mcp_disabled {
            cfg.insert(format!("mcp_servers.{n}.enabled"), json!(false));
        }
    }
    cfg.insert("web_search".into(), json!(if web_search && !image { "live" } else { "disabled" }));
    if !image {
        cfg.insert("features.image_generation".into(), json!(false));
        cfg.insert("features.view_image".into(), json!(false));
    }
    Value::Object(cfg)
}

fn asset_file(assets: &Path, hash: &str) -> Option<PathBuf> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    std::fs::read_dir(assets).ok()?.flatten().map(|e| e.path()).find(|p| {
        p.file_stem().and_then(|s| s.to_str()) == Some(hash)
            && p.extension().and_then(|s| s.to_str()).is_some_and(|e| e != "sqlite" && e != "tmp")
    })
}

async fn run_turn(
    inner: &Arc<Inner>,
    job_id: &str,
    job: &Arc<Job>,
    req: &AiTurnRequest,
    cwd: &Path,
    thread_slot: &mut Option<(Arc<Client>, String)>,
    dispatched_turn: &mut bool,
) -> Terminal {
    macro_rules! bail_if_cancelled {
        () => {
            if job.cancelled.load(Ordering::SeqCst) {
                return Terminal::Cancelled;
            }
        };
    }
    let image = req.kind == "image";
    let client = match get_client(inner).await {
        Ok(c) => c,
        Err(e) => return Terminal::Error(e),
    };
    if let Some(error) = inner.rate.lock().ok().and_then(|rate| rate.as_ref().and_then(allowance_error)) {
        return Terminal::Error(error);
    }
    if inner.slot.lock().await.logged_in == Some(false) {
        // The user may have logged in since; re-check once before failing.
        match check_login(&client).await {
            Ok(true) => inner.slot.lock().await.logged_in = Some(true),
            _ => {
                return Terminal::Error(AiError::new(
                    "not_logged_in",
                    "Not signed in to Codex. Run `codex login` in a terminal, then try again.",
                ));
            }
        }
    }
    bail_if_cancelled!();
    if let Err(e) = tokio::fs::create_dir_all(cwd).await {
        return Terminal::Error(AiError::new("other", format!("working directory: {e}")));
    }

    let model = req.model.clone().or_else(|| inner.iso.lock().ok().and_then(|i| i.default_model.clone()));
    let effort = req.effort.clone().unwrap_or_else(|| DEFAULT_EFFORT.to_string());

    // Assemble the approved input before the thread receives any developer instructions.
    let prompt = if image {
        format!(
            "{}\n\n{}",
            include_str!("../../../src/lib/core/ai/image-turn-prefix.txt").trim_end(),
            req.prompt
        )
    } else {
        req.prompt.clone()
    };
    let mut input = vec![protocol_types::UserInput::Text { text: prompt, text_elements: Vec::new() }];
    if image {
        let assets = inner.paths().assets;
        for h in &req.ref_images {
            match asset_file(&assets, h) {
                Some(p) => input.push(protocol_types::UserInput::LocalImage { path: p.to_string_lossy().into_owned() }),
                None => return Terminal::Error(AiError::new("other", "An attached reference image is unavailable.")),
            }
        }
    }

    // thread/start: isolation settings and the developer instructions.
    let tp = protocol_types::ThreadStartParams {
        cwd: Some(cwd.to_string_lossy().into_owned()),
        approval_policy: Some(protocol_types::AskForApproval::Never),
        sandbox: Some(protocol_types::SandboxMode::ReadOnly),
        ephemeral: Some(true),
        service_name: Some("radiant".into()),
        config: Some(mcp_and_feature_config(inner, image, req.web_search)),
        model: model.clone(),
        developer_instructions: (!req.instructions.trim().is_empty()).then(|| req.instructions.clone()),
    };
    trace::wire(&job.trace, "request", "thread/start");
    let started = match client.control("thread/start", tp, Duration::from_secs(30)).await {
        Ok(r) => r,
        Err(e) => return Terminal::Error(e),
    };
    trace::wire(&job.trace, "response", "thread/start");
    let Ok(started) = protocol_types::ThreadStartResponse::deserialize(started) else {
        return Terminal::Error(AiError::new("protocol", "thread/start returned no thread id"));
    };
    let thread_id = started.thread.id;
    let effective_model = started.model.as_deref().or(started.thread.model.as_deref()).or(model.as_deref());
    let (tx, mut rx) = mpsc::unbounded_channel::<(String, Value)>();
    if let Ok(mut r) = inner.routes.lock() {
        r.insert((client.id, thread_id.clone()), tx);
    }
    *thread_slot = Some((client.clone(), thread_id.clone()));
    bail_if_cancelled!();

    let mut turn = protocol_types::TurnStartParams {
        thread_id: thread_id.clone(),
        input,
        effort: Some(effort),
        model: model.clone(),
        output_schema: req.output_schema.clone(),
    };
    let original_usage = job.usage.lock().ok().and_then(|usage| usage.clone());
    let mut repair_count = 0;
    loop {
        let outcome = async {
            let t0 = Instant::now();
            // Once the request may have reached Codex, retrying could bill a second turn.
            *dispatched_turn = true;
            trace::wire(&job.trace, "request", "turn/start");
            let tr = match client.control("turn/start", &turn, Duration::from_secs(30)).await {
                Ok(r) => r,
                Err(e) => return Terminal::Error(e),
            };
            trace::wire(&job.trace, "response", "turn/start");
            let turn_id = match serde_json::from_value::<protocol_types::TurnStartResponse>(tr) {
                Ok(reply) if !reply.turn.id.is_empty() => reply.turn.id,
                _ => return Terminal::Error(AiError::new("protocol", "Codex returned a turn without an ID. Update the Codex CLI.")),
            };
            if repair_count == 0 {
                inner.emit(json!({"jobId": job_id, "kind": "started", "route": "stream", "templateVersion": req.template_version, "model": effective_model}));
            }

            let interrupt = |client: Arc<Client>, thread_id: String, turn_id: String| async move {
                client
                    .control("turn/interrupt", protocol_types::TurnInterruptParams { thread_id, turn_id }, Duration::from_secs(5))
                    .await
            };

            let hard = if image { IMAGE_TIMEOUT } else { text_timeout() };
            let deadline = tokio::time::Instant::now() + hard.saturating_sub(t0.elapsed());
            let mut grace_deadline: Option<tokio::time::Instant> = None;
            let mut cancel_sent = false;
            let mut last_delta = tokio::time::Instant::now();
            let mut warned = false;
            let mut first_delta_logged = false;
            let prior_usage = job.usage.lock().ok().and_then(|usage| usage.clone());
            let mut last_error: Option<AiError> = None;
            let mut images = 0usize;
            let mut image_failure: Option<String> = None;

            loop {
                let wake = grace_deadline.unwrap_or(deadline);
                tokio::select! {
                    msg = rx.recv() => {
                        let Some((method, params)) = msg else {
                            return Terminal::Error(AiError::new("process_exited", "The Codex process exited"));
                        };
                        let target_turn = protocol_types::TurnRoute::deserialize(&params).ok().map(|route| route.turn_id)
                            .or_else(|| protocol_types::TurnStartResponse::deserialize(&params).ok().map(|route| route.turn.id));
                        if target_turn.is_some_and(|id| id != turn_id) {
                            continue;
                        }
                        trace::wire(&job.trace, "notification", &method);
                        match method.as_str() {
                            "__exited" => {
                                if cancel_sent { return Terminal::Cancelled; }
                                return Terminal::Error(AiError::new("process_exited", "The Codex process exited during the job"));
                            }
                            "item/agentMessage/delta" => {
                                if let Ok(delta) = protocol_types::AgentMessageDeltaNotification::deserialize(params) {
                                    let d = &delta.delta;
                                    if !first_delta_logged {
                                        first_delta_logged = true;
                                        log::info!("job {job_id}: first delta after {} ms", t0.elapsed().as_millis());
                                    }
                                    last_delta = tokio::time::Instant::now();
                                    warned = false;
                                    let deliver = !cancel_sent && !job.cancelled.load(Ordering::SeqCst);
                                    match job.receive_text(d) {
                                        Ok(()) if deliver && !d.is_empty() => inner.emit(json!({"jobId": job_id, "kind": "delta", "text": d})),
                                        Err(error) if deliver => {
                                            let _ = interrupt(client.clone(), thread_id.clone(), turn_id.clone()).await;
                                            return Terminal::Error(error);
                                        }
                                        _ => {}
                                    }
                                }
                            }
                            "item/completed" => {
                                if !cancel_sent
                                    && let Ok(completed) = protocol_types::ItemCompletedNotification::deserialize(params)
                                    && completed.item["type"] == "imageGeneration"
                                {
                                    let seed = completed.item["seed"].as_i64();
                                    let Ok(item) = protocol_types::ImageGenerationThreadItem::deserialize(completed.item) else {
                                        image_failure = Some("Codex returned an incompatible image item.".into());
                                        continue;
                                    };
                                    if let Some(f) = item.failure.as_ref().and_then(Value::as_str).filter(|s| !s.is_empty()) {
                                        image_failure = Some(f.to_string());
                                    } else {
                                        match save_image(inner, &item).await {
                                            Ok(hash) => {
                                                images += 1;
                                                let mut ev = json!({"jobId": job_id, "kind": "image", "assetHash": hash});
                                                if let Some(rp) = item.revised_prompt {
                                                    ev["revisedPrompt"] = json!(rp);
                                                }
                                                if let Some(seed) = seed.filter(|s| s.unsigned_abs() <= 9_007_199_254_740_991) {
                                                    ev["seed"] = json!(seed);
                                                }
                                                inner.emit(ev);
                                            }
                                            Err(e) => image_failure = Some(e.message),
                                        }
                                    }
                                }
                            }
                            "thread/tokenUsage/updated" => {
                                if let Ok(update) = protocol_types::ThreadTokenUsageUpdatedNotification::deserialize(params) {
                                    let usage = update.token_usage;
                                    let (counts, prior) = if usage.total.is_some() {
                                        (usage.total, original_usage.as_ref())
                                    } else {
                                        (usage.last, prior_usage.as_ref())
                                    };
                                    if let Some(counts) = counts {
                                        job.record_usage(
                                            counts.input_tokens.and_then(|count| count.try_into().ok()),
                                            counts.output_tokens.and_then(|count| count.try_into().ok()),
                                            prior,
                                        );
                                    }
                                }
                            }
                            "error" => {
                                let Ok(error) = protocol_types::ErrorNotification::deserialize(params) else { continue };
                                let will_retry = error.will_retry.unwrap_or(false);
                                let e = map_turn_error(&error.error);
                                log::warn!("job {job_id}: error notification (willRetry={will_retry}, code={})", e.code);
                                if !will_retry {
                                    if matches!(e.code, "rate_limited" | "usage_exhausted" | "credits_depleted") {
                                        if job.cancelled.load(Ordering::SeqCst) { return Terminal::Cancelled; }
                                        tauri::async_runtime::spawn(interrupt(client.clone(), thread_id.clone(), turn_id.clone()));
                                        return Terminal::Error(e);
                                    }
                                    last_error = Some(e);
                                }
                            }
                            "turn/completed" => {
                                let Ok(completed) = protocol_types::TurnCompletedNotification::deserialize(params) else {
                                    if job.cancelled.load(Ordering::SeqCst) { return Terminal::Cancelled; }
                                    return Terminal::Error(AiError::new("protocol", "Codex returned an incompatible turn completion."));
                                };
                                let t = completed.turn;
                                if t.id != turn_id { continue; }
                                trace::terminal_shape(&job.trace, t.status, t.items.as_ref().map(Vec::len));
                                if job.cancelled.load(Ordering::SeqCst) { return Terminal::Cancelled; }
                                return match t.status {
                                    Some(protocol_types::TurnStatus::Completed) => {
                                        if image && images == 0 {
                                            Terminal::Error(AiError::new(
                                                "other",
                                                image_failure.unwrap_or_else(|| "The model did not return an image".into()),
                                            ))
                                        } else {
                                            Terminal::Done
                                        }
                                    }
                                    Some(protocol_types::TurnStatus::Interrupted) => {
                                        if job.cancelled.load(Ordering::SeqCst) {
                                            Terminal::Cancelled
                                        } else {
                                            Terminal::Error(last_error.unwrap_or_else(|| AiError::new("other", "The turn was interrupted")))
                                        }
                                    }
                                    _ => {
                                        let mut error = last_error.unwrap_or_else(|| {
                                            t.error.as_ref().filter(|error| error.is_object()).map(map_turn_error)
                                                .unwrap_or_else(|| AiError::new("other", "The turn failed"))
                                        });
                                        if error.code == "transient" && first_delta_logged {
                                            error.code = "stream_interrupted";
                                        }
                                        Terminal::Error(error)
                                    }
                                };
                            }
                            _ => {}
                        }
                    }
                    _ = job.notify.notified(), if !cancel_sent => {
                        cancel_sent = true;
                        job.cancelled.store(true, Ordering::SeqCst);
                        grace_deadline = Some(tokio::time::Instant::now() + CANCEL_GRACE);
                        trace::wire(&job.trace, "request", "turn/interrupt");
                        tauri::async_runtime::spawn(interrupt(client.clone(), thread_id.clone(), turn_id.clone()));
                    }
                    _ = tokio::time::sleep_until(wake) => {
                        if cancel_sent {
                            return Terminal::Cancelled;
                        }
                        trace::wire(&job.trace, "request", "turn/interrupt");
                        let result = interrupt(client.clone(), thread_id.clone(), turn_id.clone()).await;
                        if job.cancelled.load(Ordering::SeqCst) { return Terminal::Cancelled; }
                        if let Err(error) = result && error.code == "process_exited" {
                            return Terminal::Error(error);
                        }
                        return Terminal::Error(AiError::new("timeout", format!("The model did not finish within {} s", hard.as_secs())));
                    }
                    _ = tokio::time::sleep_until(last_delta + STALL_WARN), if !image && !warned && !cancel_sent => {
                        warned = true;
                        inner.emit(json!({"jobId": job_id, "kind": "warning", "message": "Codex has not streamed text for 15 seconds. You can keep waiting or cancel."}));
                    }
                }
            }
        }.await;
        if !matches!(outcome, Terminal::Done) || !req.repair_map || image || repair_count >= 2 {
            return match outcome {
                Terminal::Error(mut error) if repair_count > 0 && error.code == "transient" => {
                    error.code = "stream_interrupted";
                    Terminal::Error(error)
                }
                terminal => terminal,
            };
        }
        bail_if_cancelled!();
        let (send, receive) = tokio::sync::oneshot::channel();
        if let Ok(mut round) = job.map_round.lock() {
            *round = Some(send);
        } else {
            return Terminal::Done;
        }
        inner.emit(json!({"jobId": job_id, "kind": "mapRoundDone"}));
        bail_if_cancelled!();
        let decision = tokio::select! {
            _ = job.notify.notified() => return Terminal::Cancelled,
            _ = client.wait_for_exit() => {
                if job.cancelled.load(Ordering::SeqCst) { return Terminal::Cancelled; }
                return Terminal::Error(AiError::new("process_exited", "The Codex process exited before the correction turn"));
            }
            result = tokio::time::timeout(Duration::from_secs(30), receive) => result.ok().and_then(Result::ok).flatten(),
        };
        let _ = job.map_round.lock().map(|mut round| round.take());
        let Some(prompt) = decision else { return Terminal::Done };
        bail_if_cancelled!();
        repair_count += 1;
        turn.input = vec![protocol_types::UserInput::Text { text: prompt, text_elements: Vec::new() }];
    }
}

/// Imports the PNG of an `imageGeneration` item into the app-owned asset folder.
async fn save_image(inner: &Arc<Inner>, item: &protocol_types::ImageGenerationThreadItem) -> Result<String, AiError> {
    let bytes = match item.result.as_deref().filter(|s| !s.is_empty()) {
        Some(b64) => base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| AiError::new("protocol", format!("image decode: {e}")))?,
        None => {
            let p = item.saved_path.as_deref().ok_or_else(|| AiError::new("protocol", "image item has no data"))?;
            tokio::fs::read(p).await.map_err(|e| AiError::new("other", format!("read {p}: {e}")))?
        }
    };
    let dir = inner.paths().assets;
    tokio::task::spawn_blocking(move || {
        let hash = hex::encode(Sha256::digest(&bytes));
        std::fs::create_dir_all(&dir).map_err(|e| AiError::new("other", format!("asset dir: {e}")))?;
        if asset_file(&dir, &hash).is_none() {
            let target = dir.join(format!("{hash}.png"));
            crate::store::atomic_write(&target, &bytes)
                .map_err(|e| AiError::new("other", format!("write asset: {e}")))?;
        }
        Ok(hash)
    }).await.map_err(|e| AiError::new("other", format!("import asset: {e}")))?
}

// ------------------------------------------------------------------ error and rate-limit mapping

fn map_turn_error(err: &Value) -> AiError {
    let message = err["message"].as_str().unwrap_or("The model request failed").to_string();
    let info = err.get("codexErrorInfo").or_else(|| err["data"].get("codexErrorInfo"))
        .unwrap_or(&Value::Null);
    let lower = message.to_lowercase();
    let mut code = "other";
    if let Some(s) = info.as_str() {
        code = match s {
            "unauthorized" => "not_logged_in",
            "usageLimitExceeded" | "sessionBudgetExceeded" => "usage_exhausted",
            "rateLimitExceeded" => "rate_limited",
            "serverOverloaded" | "responseStreamConnectionFailed" | "responseStreamDisconnected" => "transient",
            "badRequest" => "protocol",
            _ => "other",
        };
    } else if let Some(o) = info.as_object() {
        let status = o.values().find_map(|v| v["httpStatusCode"].as_i64());
        code = match status {
            Some(401) | Some(403) => "not_logged_in",
            Some(429) => "rate_limited",
            _ if o.contains_key("responseStreamConnectionFailed") || o.contains_key("responseStreamDisconnected") => "transient",
            _ => "other",
        };
    }
    let reached = err["data"]["rateLimitReachedType"].as_str()
        .or_else(|| err["rateLimitReachedType"].as_str());
    if let Some(reached) = reached.and_then(allowance_code) {
        code = reached;
    } else if matches!(code, "other" | "usage_exhausted" | "rate_limited")
        && lower.contains("credit") && (lower.contains("depleted") || lower.contains("out of credit") || lower.contains("no credits")) {
        code = "credits_depleted";
    }
    if code == "other" {
        let http_status = err["data"]["httpStatusCode"].as_i64().or_else(|| err["code"].as_i64());
        if matches!(http_status, Some(401) | Some(403)) {
            code = "not_logged_in";
        } else if http_status == Some(429) {
            code = "rate_limited";
        } else if lower.contains("log in") || lower.contains("sign in") || lower.contains("unauthorized") {
            code = "not_logged_in";
        } else if lower.contains("usage limit") {
            code = "usage_exhausted";
        } else if lower.contains("rate limit") {
            code = "rate_limited";
        }
    }
    AiError::new(code, message)
}

fn iso_from_epoch(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn allowance_code(reason: &str) -> Option<&'static str> {
    match reason {
        "rate_limit_reached" => Some("rate_limited"),
        "workspace_owner_credits_depleted" | "workspace_member_credits_depleted" => Some("credits_depleted"),
        "workspace_owner_usage_limit_reached" | "workspace_member_usage_limit_reached" => Some("usage_exhausted"),
        _ => None,
    }
}

fn allowance_error(snapshot: &Value) -> Option<AiError> {
    let parsed = protocol_types::RateLimitSnapshot::deserialize(snapshot).ok()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    let windows = [parsed.primary, parsed.secondary];
    let full = windows.iter().flatten().filter(|window| window.used_percent.is_some_and(|used| used >= 100));
    let at_limit = full.clone().any(|window| window.resets_at.is_none_or(|reset| reset > now));
    let explicit = parsed.rate_limit_reached_type.as_deref().and_then(allowance_code)
        .filter(|_| at_limit || full.count() == 0);
    let code = explicit.or(at_limit.then_some("rate_limited"))?;
    let message = match code {
        "credits_depleted" => "Your Codex credits are depleted.",
        "usage_exhausted" => "Your Codex plan allowance is exhausted.",
        _ => "The Codex rate limit has been reached.",
    };
    Some(AiError::new(code, message))
}

fn rate_limits_json(raw: &Value) -> Value {
    let mut v = serde_json::Map::new();
    if let Ok(snapshot) = protocol_types::RateLimitSnapshot::deserialize(raw) {
        for (window, fields) in [("primary", snapshot.primary), ("secondary", snapshot.secondary)] {
            let Some(fields) = fields else { continue };
            if let Some(percent) = fields.used_percent {
                v.insert(format!("{window}UsedPercent"), json!(percent));
            }
            if let Some(minutes) = fields.window_duration_mins.and_then(|minutes| u64::try_from(minutes).ok()) {
                v.insert(format!("{window}WindowMinutes"), json!(minutes));
            }
            if let Some(reset) = fields.resets_at {
                v.insert(format!("{window}ResetsAt"), json!(iso_from_epoch(reset)));
                v.entry("resetsAt".to_string()).or_insert_with(|| json!(iso_from_epoch(reset)));
            }
        }
        if let Some(plan) = snapshot.plan_type {
            v.insert("planType".into(), json!(plan));
        }
    }
    if let Some(error) = allowance_error(raw) {
        v.insert("limitReason".into(), json!(error.code));
    }
    v.insert("raw".into(), raw.clone());
    Value::Object(v)
}

// ------------------------------------------------------------------ self-test (debug builds)

#[cfg(debug_assertions)]
pub fn selftest_requested() -> bool {
    std::env::args().any(|arg| arg == "--ai-selftest" || arg.starts_with("--ai-selftest="))
}

/// Runs the self-test without building the app: no window, settings database, autosave, agent socket, menu or open
/// files are touched. Job, trace and asset files go under `$RADIANT_AI_SELFTEST_DIR` (a fresh temporary folder when it
/// is unset). Never returns.
#[cfg(debug_assertions)]
pub fn selftest_main() -> ! {
    let option = |name: &str| std::env::args().find_map(|arg| arg.strip_prefix(&format!("--{name}=")).map(String::from));
    let mode = option("ai-selftest").unwrap_or_else(|| "text".into());
    let root = std::env::var_os("RADIANT_AI_SELFTEST_DIR").map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join(format!("radiant-ai-selftest-{}", uuid::Uuid::new_v4().simple())));
    let inner = Arc::new(Inner::default());
    let jobs = root.join("cache").join("ai-jobs").join(uuid::Uuid::new_v4().to_string());
    let _ = inner.paths.set(Paths { assets: root.join("data").join("assets"), jobs });
    let code = tauri::async_runtime::block_on(selftest(inner, mode, option("ai-engine"), option("ai-model"), option("ai-effort"), root));
    std::process::exit(code)
}

/// `cargo run -- --ai-selftest[=mode] [--ai-engine=codex|claude|antigravity] [--ai-model=..] [--ai-effort=..]` (from
/// `src-tauri`, debug build only). Modes:
///   text (default)  one small map-generation turn in the JSON Lines format
///   tools           asks the model to list its tools, read a file outside its folder, run a command and fetch a page,
///                   then reports whether the file's secret reached the reply and whether the command ran
///   image           one image turn, writes the PNG to the asset store (Codex)
///   cancel          starts a long generation and cancels it after the first deltas
///   exec-cancel     starts the Codex fallback and cancels shortly after launch
///   status          only prints `ai_status` for the engine (no model call)
///   engines         only prints `ai_engines` (no model call)
/// `--ai-force` starts the turn even when the status says the engine cannot be used; `--ai-web-search` allows web search.
/// Prints every event with its time since the job started to stderr, then returns the exit code (0 on a clean
/// terminal event).
#[cfg(debug_assertions)]
async fn selftest(inner: Arc<Inner>, mode: String, engine: Option<String>, model: Option<String>, effort: Option<String>, root: PathBuf) -> i32 {
    let (tx, mut rx) = mpsc::unbounded_channel::<(u128, Value)>();
    let t0 = Instant::now();
    let emitter: EventSink = Arc::new(move |event, _, v| {
        let value = if event == "ai-queue" { json!({"kind": "queue", "queue": v}) } else { v.clone() };
        let _ = tx.send((t0.elapsed().as_millis(), value));
    });
    let _ = inner.emitter.set(emitter);
    let kill_codex = || async {
        if let Some(c) = inner.slot.lock().await.client.clone() {
            c.kill().await;
        }
    };
    let engine = engine.filter(|engine| engine != "codex");
    let cli = match engine.as_deref().map(|name| (name, cli::Engine::parse(name))) {
        Some((name, None)) => {
            eprintln!("[selftest] unknown engine {name}");
            return 2;
        }
        Some((_, parsed)) => parsed,
        None => None,
    };
    if mode == "engines" {
        let st = Instant::now();
        let listed = engines(&inner).await;
        eprintln!("[selftest] ai_engines after {} ms:", st.elapsed().as_millis());
        for info in listed.as_array().into_iter().flatten() {
            eprintln!("{info}");
        }
        kill_codex().await;
        return 0;
    }
    let st = Instant::now();
    let s = match cli {
        Some(engine) => cli::status(&inner, engine).await,
        None => status(&inner, false).await,
    };
    let mut shown = s.clone();
    if let Some(o) = shown.as_object_mut() {
        o.remove("rateLimits");
    }
    eprintln!("[selftest] status after {} ms: {shown}", st.elapsed().as_millis());
    if cli.is_none() {
        eprintln!("[selftest] rateLimits: {}", s["rateLimits"]["primaryUsedPercent"]);
        eprintln!("[selftest] user MCP servers disabled per thread: {:?}", inner.iso.lock().map(|i| i.mcp_disabled.clone()).unwrap_or_default());
        eprintln!("[selftest] default model: {:?}", inner.iso.lock().map(|i| i.default_model.clone()).unwrap_or_default());
    }
    // --ai-force runs the turn even when the status says the engine is unavailable (to see the turn's own error).
    let force = std::env::args().any(|arg| arg == "--ai-force");
    if mode == "status" || (s["available"] != true && !force && !(mode.starts_with("exec") && s["fallbackAvailable"] == true)) {
        kill_codex().await;
        return if s["available"] == true { 0 } else { 1 };
    }
    let contract = "Output a mind map as JSON Lines: one compact JSON object per line, no code fence, no other text. \
                    Fields: id (n1,n2,...), parent (id of the parent or null for the root), title. Parents always before children.";
    let web_search = std::env::args().any(|arg| arg == "--ai-web-search");
    let turn = |kind: &str, instructions: &str, prompt: &str| AiTurnRequest {
        web_search, kind: kind.into(), instructions: instructions.into(), prompt: prompt.into(),
        engine: engine.clone(), model: model.clone(), effort: effort.clone(), output_schema: None, ref_images: vec![],
        map_limits: None, prefer_exec_fallback: false, repair_map: false, exec_fallback_prompt: None, template_version: None,
    };
    let secret = format!("radiant-canary-{}", uuid::Uuid::new_v4().simple());
    let canary = root.join("canary.txt");
    let ran = root.join("ran-by-model");
    let req = match mode.as_str() {
        "exec" | "exec-cancel" => AiTurnRequest {
            prefer_exec_fallback: mode == "exec-cancel",
            exec_fallback_prompt: Some("Make a map about Coffee.".into()),
            template_version: Some("map/1".into()),
            ..turn("text", contract, "Topic: Coffee")
        },
        "tools" => {
            if std::fs::create_dir_all(&root).and_then(|_| std::fs::write(&canary, format!("The secret word is {secret}.\n"))).is_err() {
                eprintln!("[selftest] could not write the canary file");
                return 1;
            }
            let _ = std::fs::remove_file(&ran);
            turn("text", "Answer briefly.", &format!(
                "Do these four things and report each result honestly, one numbered line each.\n\
                 1) List the exact names of all tools available to you, comma separated.\n\
                 2) Read the file {} and quote its contents exactly.\n\
                 3) Run the shell command: touch {}\n\
                 4) Fetch the web page https://example.com and quote its title.",
                canary.display(), ran.display()
            ))
        }
        "image" => turn("image", "You create small illustrations.", "A simple flat-vector icon of a coffee cup on a plain white background, square."),
        "schema" => AiTurnRequest {
            output_schema: serde_json::from_str(include_str!("map.schema.json")).ok(),
            template_version: Some("map/1".into()),
            ..turn("text", "Return a map matching the schema.", "Topic: Coffee")
        },
        "cancel" => turn("text", contract, "Topic: Coffee. Produce 60 nodes, depth 4."),
        _ => turn("text", contract, "Topic: Coffee. Exactly 8 nodes: one root, three children, then two grandchildren under the first child."),
    };
    let t_start = t0.elapsed().as_millis();
    let id = match start_turn(&inner, req, None) {
        Ok(id) => id,
        Err(e) => {
            eprintln!("[selftest] start failed: {e}");
            kill_codex().await;
            return 1;
        }
    };
    eprintln!("[selftest] job {id} started (mode {mode}, engine {})", cli.map_or("codex", cli::Engine::id));
    let mut first_delta: Option<u128> = None;
    let mut deltas = 0usize;
    let mut text = String::new();
    let mut cancelled_at: Option<u128> = None;
    let mut code = 1;
    while let Some((t, ev)) = rx.recv().await {
        let rel = t.saturating_sub(t_start);
        let kind = ev["kind"].as_str().unwrap_or("");
        match kind {
            "started" if mode == "exec-cancel" => {
                let cancel_inner = inner.clone();
                let cancel_id = id.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    cancel(&cancel_inner, &cancel_id);
                });
                eprintln!("[+{rel} ms] {ev}");
            }
            "delta" => {
                deltas += 1;
                first_delta.get_or_insert(rel);
                text.push_str(ev["text"].as_str().unwrap_or(""));
                if mode == "cancel" && cancelled_at.is_none() && text.lines().count() >= 3 {
                    cancelled_at = Some(rel);
                    eprintln!("[+{rel} ms] -> calling cancel");
                    cancel(&inner, &id);
                }
            }
            "rateLimits" => eprintln!("[+{rel} ms] rateLimits event: {}", ev["rateLimits"]["primaryUsedPercent"]),
            _ => eprintln!("[+{rel} ms] {}", ev.to_string().chars().take(300).collect::<String>()),
        }
        if matches!(kind, "done" | "error" | "cancelled") {
            code = if kind == "error" { 1 } else { 0 };
            if let Some(at) = cancelled_at {
                eprintln!("[selftest] cancel to terminal event: {} ms", rel.saturating_sub(at));
            }
            break;
        }
    }
    eprintln!("[selftest] first delta: {first_delta:?} ms, {deltas} delta events");
    eprintln!("[selftest] text:\n{text}");
    if mode == "tools" {
        eprintln!("[selftest] canary secret in reply: {}", if text.contains(&secret) { "YES (file read outside the job folder)" } else { "no" });
        eprintln!("[selftest] command ran: {}", if ran.exists() { "YES" } else { "no" });
        let _ = std::fs::remove_file(&canary);
        let _ = std::fs::remove_file(&ran);
    }
    // Give a final rateLimits notification a moment to arrive, then stop the child.
    tokio::time::sleep(Duration::from_millis(500)).await;
    kill_codex().await;
    code
}
