//! Print-mode text turns through the Claude Code CLI (`claude -p`) and the Antigravity CLI (`agy`). They share the
//! job, scheduler, cancellation, timeout, usage and trace machinery of the Codex route and emit the same events:
//! started {route "stream", model, engine} -> delta* -> done | error | cancelled. One child process per turn runs in the
//! job's own empty working directory, reads the prompt on stdin, and is killed with its whole process group on cancel,
//! timeout or shutdown.
//!
//! Claude Code runs with no tools (only WebSearch when the turn asks for web search), no MCP servers, no settings
//! files, plugins, hooks, skills, memory or CLAUDE.md (`--safe-mode`, `--setting-sources ""`), no saved session, and
//! Radiant's instructions as the whole system prompt.
//!
//! Antigravity has no switch that removes its tools: files, commands, browser, MCP, sub-agents and web search stay
//! listed even with `--sandbox`. Each job directory therefore carries a workspace hook that denies every tool call
//! before it runs, `--settings` turns off access outside the workspace, and the host stops the turn if a tool ever
//! completes anyway. Antigravity still saves each turn in its own conversation history.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

use super::{AiError, AiTurnRequest, Inner, Job, STALL_WARN, Terminal, rpc, text_timeout, trace};

/// Effort levels of the host contract, lowest first.
pub(super) const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_MODELS: [(&str, &str); 4] = [("fable", "Fable"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")];
const CLAUDE_DEFAULT: (&str, &str) = ("sonnet", "low");
const AGY_DEFAULT: (&str, &str) = ("gemini-3.8-flash", "low");
const PROBE_TTL: Duration = Duration::from_secs(60);
const MODELS_TTL: Duration = Duration::from_secs(300);
const MODELS_RETRY: Duration = Duration::from_secs(15);
/// Instructions up to this size go into the job's GEMINI.md rule file (24,000 bytes is Antigravity's per-file cap).
const AGY_RULES_LIMIT: usize = 20_000;
const MAX_TOOL_ATTEMPTS: usize = 6;
/// Variables a parent Claude Code session sets for its own children; a child CLI must not think it is one of them.
const SESSION_VARS: &[&str] = &[
    "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_PID",
    "CLAUDE_CODE_CHILD_NOTES_DIR", "CLAUDE_EFFORT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_EXPERIMENTAL_CODE_MODE",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "AI_AGENT",
];

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) enum Engine {
    Claude,
    Antigravity,
}

impl Engine {
    pub(super) const ALL: [Engine; 2] = [Engine::Claude, Engine::Antigravity];

    pub(super) fn parse(value: &str) -> Option<Engine> {
        match value {
            "claude" => Some(Engine::Claude),
            "antigravity" => Some(Engine::Antigravity),
            _ => None,
        }
    }

    pub(super) fn id(self) -> &'static str {
        match self { Engine::Claude => "claude", Engine::Antigravity => "antigravity" }
    }

    pub(super) fn label(self) -> &'static str {
        match self { Engine::Claude => "Claude Code", Engine::Antigravity => "Antigravity" }
    }

    fn binary(self) -> &'static str {
        match self { Engine::Claude => "claude", Engine::Antigravity => "agy" }
    }

    fn extra_dirs(self) -> Vec<PathBuf> {
        let home = dirs::home_dir();
        match self {
            Engine::Claude => home.map(|home| vec![home.join(".claude/local")]).unwrap_or_default(),
            Engine::Antigravity => Vec::new(),
        }
    }

    fn not_installed(self, configured: bool) -> AiError {
        AiError::new("not_installed", match (self, configured) {
            (Engine::Claude, true) => "The Claude Code CLI named by CLAUDE_BIN was not found. Install Claude Code or update CLAUDE_BIN.",
            (Engine::Claude, false) => "Claude Code was not found. Install it (curl -fsSL https://claude.ai/install.sh | bash), then sign in with `claude auth login`.",
            (Engine::Antigravity, true) => "The Antigravity CLI named by AGY_BIN was not found. Install the Antigravity CLI or update AGY_BIN.",
            (Engine::Antigravity, false) => "The Antigravity CLI (agy) was not found. Install it from antigravity.google, then run `agy` in a terminal to sign in.",
        })
    }

    pub(super) fn not_logged_in(self) -> AiError {
        AiError::new("not_logged_in", match self {
            Engine::Claude => "Not signed in to Claude Code. Run `claude auth login` in a terminal, then try again.",
            Engine::Antigravity => "Not signed in to Antigravity. Run `agy` in a terminal and sign in, then try again.",
        })
    }

    /// Options Radiant relies on; an older CLI without them is refused rather than run half-isolated.
    fn required_flags(self) -> &'static [&'static str] {
        match self {
            Engine::Claude => &[
                "--print", "--output-format", "--include-partial-messages", "--verbose", "--model", "--effort", "--tools",
                "--allowedTools", "--strict-mcp-config", "--setting-sources", "--safe-mode", "--disable-slash-commands",
                "--no-session-persistence", "--permission-prompts", "--system-prompt",
            ],
            Engine::Antigravity => &[
                "--output-format", "--model", "--effort", "--sandbox", "--settings", "--disable-slash-commands", "--print-timeout",
            ],
        }
    }
}

#[derive(Clone)]
struct Probe {
    bin: PathBuf,
    version: String,
    checked: Instant,
    flags: Result<(), AiError>,
}

/// One Antigravity model family: "gemini-3.8-flash" with the efforts its listed ids carry ("-low", "-medium", ...).
#[derive(Clone, Debug)]
struct Family {
    id: String,
    label: String,
    efforts: Vec<&'static str>,
    plain: bool,
}

type Listing = Option<(Instant, Result<Vec<Family>, AiError>)>;

#[derive(Default)]
pub(super) struct CliState {
    probes: tokio::sync::Mutex<HashMap<Engine, Probe>>,
    agy_models: tokio::sync::Mutex<Listing>,
}

fn command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    cmd.env("PATH", rpc::child_path(bin)).kill_on_drop(true);
    for var in SESSION_VARS {
        cmd.env_remove(var);
    }
    cmd
}

/// Runs a short helper command (help, sign-in check, model list) and returns its exit success and combined output.
async fn quick(bin: &Path, args: &[&str], cwd: Option<&Path>, limit: Duration) -> Result<(bool, String), AiError> {
    let mut cmd = command(bin);
    cmd.args(args).stdin(Stdio::null());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let name = bin.file_name().and_then(|name| name.to_str()).unwrap_or("cli");
    let output = tokio::time::timeout(limit, cmd.output()).await
        .map_err(|_| AiError::new("timeout", format!("`{name} {}` did not answer in time.", args.join(" "))))?
        .map_err(|e| AiError::new("process_exited", format!("Could not run {name}: {e}")))?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.success(), text))
}

async fn probe(state: &CliState, engine: Engine) -> Result<Probe, AiError> {
    let mut probes = state.probes.lock().await;
    if let Some(probe) = probes.get(&engine).filter(|probe| probe.checked.elapsed() < PROBE_TTL) {
        return Ok(probe.clone());
    }
    probes.remove(&engine);
    let env = match engine { Engine::Claude => "CLAUDE_BIN", Engine::Antigravity => "AGY_BIN" };
    let bin = match rpc::find_binary(engine.binary(), env, &engine.extra_dirs()).await {
        Ok(Some(bin)) => bin,
        Ok(None) => return Err(engine.not_installed(false)),
        Err(()) => return Err(engine.not_installed(true)),
    };
    let raw = rpc::read_version(&bin).await?;
    let raw = raw.lines().next().unwrap_or_default().trim().to_string();
    let version = if raw.chars().any(char::is_alphabetic) { raw } else { format!("{} {raw}", engine.binary()) };
    let flags = match quick(&bin, &["--help"], None, Duration::from_secs(10)).await {
        Ok((_, help)) => {
            let missing: Vec<_> = engine.required_flags().iter().copied()
                .filter(|flag| !help.split(|c: char| c.is_whitespace() || c == ',').any(|word| word == *flag)).collect();
            if missing.is_empty() { Ok(()) } else {
                Err(AiError::new("protocol", format!(
                    "{} {version} lacks options Radiant needs ({}). Update {}.", engine.label(), missing.join(", "), engine.label()
                )))
            }
        }
        Err(error) => Err(error),
    };
    let probe = Probe { bin, version, checked: Instant::now(), flags };
    probes.insert(engine, probe.clone());
    Ok(probe)
}

// ------------------------------------------------------------------ sign-in and models

/// `claude auth status` answers from local credentials without calling a model.
async fn claude_logged_in(bin: &Path) -> Result<bool, AiError> {
    let (success, text) = quick(bin, &["auth", "status", "--json"], None, Duration::from_secs(15)).await?;
    let start = text.find('{').unwrap_or(text.len());
    let parsed = serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>().next().and_then(Result::ok);
    match parsed.as_ref().and_then(|status| status["loggedIn"].as_bool()) {
        Some(logged_in) => Ok(logged_in),
        None if success => Ok(true),
        None => Err(AiError::new("other", "Could not check the Claude Code sign-in.")),
    }
}

fn parse_models(text: &str) -> Vec<Family> {
    let mut families: Vec<Family> = Vec::new();
    for line in text.lines() {
        let Some((id, label)) = line.split_once('\t') else { continue };
        let (id, label) = (id.trim(), label.trim());
        if !safe_value(id) || label.is_empty() {
            continue;
        }
        let effort = EFFORTS.iter().copied().find(|effort| {
            id.len() > effort.len() + 1 && id.ends_with(effort) && id.as_bytes()[id.len() - effort.len() - 1] == b'-'
        });
        let family = effort.map_or(id, |effort| &id[..id.len() - effort.len() - 1]);
        let label = match effort {
            Some(_) => label.rsplit_once(" (").map_or(label, |(head, _)| head),
            None => label,
        };
        match families.iter_mut().find(|known| known.id == family) {
            Some(known) => match effort {
                Some(effort) if !known.efforts.contains(&effort) => known.efforts.push(effort),
                Some(_) => {}
                None => known.plain = true,
            },
            None => families.push(Family { id: family.into(), label: label.into(), efforts: effort.into_iter().collect(), plain: effort.is_none() }),
        }
    }
    for family in &mut families {
        family.efforts.sort_by_key(|effort| EFFORTS.iter().position(|known| known == effort));
    }
    families
}

fn agy_error(text: &str, status: Option<&str>) -> AiError {
    let lower = text.to_lowercase();
    let status = status.unwrap_or_default();
    let code = if status == "UNAUTHENTICATED" || lower.contains("sign in") || lower.contains("log in") || lower.contains("authentication") {
        "not_logged_in"
    } else if lower.contains("credit") && (lower.contains("depleted") || lower.contains("insufficient") || lower.contains("balance")) {
        "credits_depleted"
    } else if status == "RESOURCE_EXHAUSTED" || lower.contains("quota") || lower.contains("rate limit") || lower.contains("429") {
        if lower.contains("plan") || lower.contains("credits") { "usage_exhausted" } else { "rate_limited" }
    } else if status == "UNAVAILABLE" || lower.contains("timed out waiting for available models") || lower.contains("connection refused")
        || lower.contains("no such host") || lower.contains("network is unreachable") || lower.contains("dial tcp") {
        "offline"
    } else if status == "DEADLINE_EXCEEDED" || lower.contains("print timeout") || lower.contains("deadline exceeded") {
        "timeout"
    } else {
        "other"
    };
    match code {
        "not_logged_in" => Engine::Antigravity.not_logged_in(),
        "offline" => AiError::new(code, "Antigravity cannot reach its service. Check the internet connection, then try again."),
        "rate_limited" => AiError::new(code, "Antigravity is rate limited for this model. Wait a little, or choose another model."),
        "usage_exhausted" => AiError::new(code, "Your Antigravity plan has no quota left for this model. Choose another model or wait for the quota to reset."),
        "credits_depleted" => AiError::new(code, "Your Antigravity credits are used up."),
        _ => AiError::new(code, format!("Antigravity: {}", short(text))),
    }
}

/// `agy models` asks the service for the account's models (no model call). Also the sign-in check for Antigravity.
async fn agy_models(state: &CliState, bin: &Path) -> Result<Vec<Family>, AiError> {
    let mut cache = state.agy_models.lock().await;
    if let Some((at, result)) = cache.as_ref() {
        let ttl = if result.is_ok() { MODELS_TTL } else { MODELS_RETRY };
        if at.elapsed() < ttl {
            return result.clone();
        }
    }
    let cwd = std::env::temp_dir();
    let result = match quick(bin, &["models"], Some(&cwd), Duration::from_secs(30)).await {
        Ok((true, text)) => {
            let families = parse_models(&text);
            if families.is_empty() { Err(AiError::new("protocol", "Antigravity listed no models.")) } else { Ok(families) }
        }
        Ok((false, text)) => {
            let reason = text.lines().map(str::trim).rfind(|line| !line.is_empty() && !line.starts_with("Fetching")).unwrap_or("agy models failed");
            Err(agy_error(reason.trim_start_matches("Error:").trim(), None))
        }
        Err(error) => Err(error),
    };
    *cache = Some((Instant::now(), result.clone()));
    result
}

fn models_json(engine: Engine, families: &[Family]) -> Value {
    match engine {
        Engine::Claude => CLAUDE_MODELS.iter().map(|(id, label)| json!({"id": id, "label": label, "efforts": EFFORTS})).collect(),
        Engine::Antigravity => families.iter().map(|family| json!({"id": family.id, "label": family.label, "efforts": family.efforts})).collect(),
    }
}

/// `ai_status` for Claude Code or Antigravity. `images` reports Codex, which draws every picture whatever the engine.
pub(super) async fn status(inner: &Arc<Inner>, engine: Engine) -> Value {
    let (images, checked) = tokio::join!(super::codex_draws_images(inner), check(inner, engine));
    let mut v = json!({"available": false, "provider": engine.id(), "capabilities": {"streaming": false, "images": images, "rateLimits": false}});
    let (version, result) = checked;
    if let Some(version) = version {
        v["version"] = json!(version);
    }
    match result {
        Ok(_) => {
            v["available"] = json!(true);
            v["capabilities"]["streaming"] = json!(true);
        }
        Err(error) => {
            v["error"] = json!(error.message);
            v["errorCode"] = json!(error.code);
        }
    }
    v
}

/// Installed, version and signed in; for Antigravity also the model families (one request serves both).
async fn check(inner: &Inner, engine: Engine) -> (Option<String>, Result<Vec<Family>, AiError>) {
    let probe = match probe(&inner.cli, engine).await {
        Ok(probe) => probe,
        Err(error) => return (None, Err(error)),
    };
    let version = Some(probe.version.clone());
    if let Err(error) = &probe.flags {
        return (version, Err(error.clone()));
    }
    let result = match engine {
        Engine::Claude => match claude_logged_in(&probe.bin).await {
            Ok(true) => Ok(Vec::new()),
            Ok(false) => Err(engine.not_logged_in()),
            Err(error) => Err(error),
        },
        Engine::Antigravity => agy_models(&inner.cli, &probe.bin).await,
    };
    (version, result)
}

/// One `AiEngineInfo` (ai_engines). Antigravity: tool calls are denied by a workspace hook, not removed (see the module
/// docs); a CLI update that stopped honouring that hook would leave its tools reachable until Radiant notices one finish.
pub(super) async fn engine_info(inner: &Inner, engine: Engine) -> Value {
    let (version, result) = check(inner, engine).await;
    let installed = version.is_some() || result.as_ref().is_err_and(|error| error.code != "not_installed");
    let mut v = json!({"engine": engine.id(), "label": engine.label(), "installed": installed, "models": [], "customModels": engine == Engine::Claude});
    if let Some(version) = version {
        v["version"] = json!(version);
    }
    let families = match (&result, engine) {
        (Ok(families), _) => families.clone(),
        (Err(_), Engine::Claude) => Vec::new(),
        (Err(_), Engine::Antigravity) => inner.cli.agy_models.lock().await.as_ref()
            .and_then(|(_, cached)| cached.as_ref().ok().cloned()).unwrap_or_default(),
    };
    if engine == Engine::Claude || !families.is_empty() {
        v["models"] = models_json(engine, &families);
        let (model, effort) = match engine {
            Engine::Claude => (CLAUDE_DEFAULT.0.to_string(), Some(CLAUDE_DEFAULT.1)),
            Engine::Antigravity => {
                let family = families.iter().find(|family| family.id == AGY_DEFAULT.0).or(families.first());
                let family = family.expect("families is not empty");
                (family.id.clone(), pick_effort(&family.efforts, AGY_DEFAULT.1))
            }
        };
        v["defaultModel"] = json!(model);
        if let Some(effort) = effort {
            v["defaultEffort"] = json!(effort);
        }
    }
    if let Err(error) = result {
        v["error"] = json!(error.message);
        v["errorCode"] = json!(error.code);
    }
    v
}

// ------------------------------------------------------------------ turns

/// Model and effort strings become command-line values: no leading dash, no spaces or control characters.
pub(super) fn safe_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && !value.starts_with('-')
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-[]/@".contains(&b))
}

/// The listed effort, or the nearest lower one, or the lowest the family has.
fn pick_effort(efforts: &[&'static str], wanted: &str) -> Option<&'static str> {
    let rank = |effort: &str| EFFORTS.iter().position(|known| *known == effort).unwrap_or(0);
    efforts.iter().copied().find(|effort| *effort == wanted)
        .or_else(|| efforts.iter().copied().rfind(|effort| rank(effort) < rank(wanted)))
        .or_else(|| efforts.first().copied())
}

/// The `--model` (and possibly `--effort`) values for Antigravity, and a warning when the effort had to change.
fn agy_model(families: &[Family], model: Option<&str>, effort: Option<&str>) -> Result<(Vec<String>, Option<String>), AiError> {
    let wanted = effort.unwrap_or(AGY_DEFAULT.1);
    let family = match model {
        Some(model) => families.iter().find(|family| family.id == model),
        None => families.iter().find(|family| family.id == AGY_DEFAULT.0).or(families.first()),
    };
    let Some(family) = family else {
        let model = model.unwrap_or(AGY_DEFAULT.0);
        let listed = families.iter().any(|family| family.efforts.iter().any(|effort| format!("{}-{effort}", family.id) == model));
        if !families.is_empty() && !listed {
            return Err(AiError::new("other", format!("Antigravity does not offer the model {model}. Choose another model.")));
        }
        // A full listed id carries its own effort; anything else goes to agy as family and effort, and agy checks it.
        return Ok(if listed || EFFORTS.iter().any(|effort| model.ends_with(&format!("-{effort}"))) {
            (vec![format!("--model={model}")], None)
        } else {
            (vec![format!("--model={model}"), format!("--effort={wanted}")], None)
        });
    };
    if family.efforts.is_empty() || (effort.is_none() && family.plain) {
        return Ok((vec![format!("--model={}", family.id)], None));
    }
    let chosen = pick_effort(&family.efforts, wanted).unwrap_or(wanted);
    let warning = (effort.is_some() && chosen != wanted)
        .then(|| format!("Antigravity's {} has no {wanted} effort; using {chosen}.", family.label));
    Ok((vec![format!("--model={}-{chosen}", family.id)], warning))
}

struct Launch {
    args: Vec<String>,
    stdin: String,
    model: String,
    warning: Option<String>,
}

fn claude_launch(req: &AiTurnRequest) -> Launch {
    let model = req.model.clone().unwrap_or_else(|| CLAUDE_DEFAULT.0.into());
    let effort = req.effort.clone().unwrap_or_else(|| CLAUDE_DEFAULT.1.into());
    let mut args: Vec<String> = [
        "-p", "--output-format=stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config",
        "--setting-sources=", "--safe-mode", "--disable-slash-commands", "--no-session-persistence", "--permission-prompts=none",
    ].iter().map(|arg| arg.to_string()).collect();
    args.push(format!("--model={model}"));
    args.push(format!("--effort={effort}"));
    if req.web_search {
        args.extend(["--tools=WebSearch".into(), "--allowedTools=WebSearch".into()]);
    } else {
        args.push("--tools=".into());
    }
    let instructions = if req.instructions.trim().is_empty() { "Follow the user's request." } else { req.instructions.as_str() };
    args.push(format!("--system-prompt={instructions}"));
    Launch { args, stdin: req.prompt.clone(), model, warning: None }
}

async fn agy_launch(inner: &Inner, bin: &Path, req: &AiTurnRequest, cwd: &Path) -> Result<Launch, AiError> {
    let families = match agy_models(&inner.cli, bin).await {
        Ok(families) => families,
        // Without its model list agy cannot start a turn either; say why instead of a confusing model error.
        Err(error) if matches!(error.code, "offline" | "not_logged_in") => return Err(error),
        Err(_) => Vec::new(),
    };
    let (model_args, warning) = agy_model(&families, req.model.as_deref(), req.effort.as_deref())?;
    let model = model_args[0].trim_start_matches("--model=").to_string();
    // Every tool call is denied before it runs. The hook reads its input so the CLI never blocks writing it.
    let deny = json!({"radiant-no-tools": {"PreToolUse": [{"matcher": "*", "hooks": [{
        "type": "command", "timeout": 10,
        "command": "cat >/dev/null; printf '%s\\n' '{\"decision\":\"deny\",\"reason\":\"Radiant does not allow tools in this conversation.\"}'"
    }]}]}});
    let agents = cwd.join(".agents");
    tokio::fs::create_dir_all(&agents).await.map_err(|e| AiError::new("other", format!("working directory: {e}")))?;
    tokio::fs::write(agents.join("hooks.json"), deny.to_string()).await
        .map_err(|e| AiError::new("other", format!("tool hook: {e}")))?;
    let instructions = req.instructions.trim();
    let stdin = if instructions.is_empty() {
        req.prompt.clone()
    } else if instructions.len() <= AGY_RULES_LIMIT {
        // There is no system-prompt option; a GEMINI.md rule in the working directory is the closest equivalent.
        tokio::fs::write(cwd.join("GEMINI.md"), instructions).await
            .map_err(|e| AiError::new("other", format!("instructions file: {e}")))?;
        req.prompt.clone()
    } else {
        format!("{instructions}\n\n{}", req.prompt)
    };
    let mut args: Vec<String> = ["--output-format=stream-json", "--sandbox", "--disable-slash-commands"].iter().map(|arg| arg.to_string()).collect();
    args.extend(model_args);
    args.push(format!("--print-timeout={}s", text_timeout().as_secs() + 15));
    args.push(format!("--settings={}", json!({"allowNonWorkspaceAccess": false, "permissions": {"allow": []}})));
    Ok(Launch { args, stdin, model, warning })
}

fn short(text: &str) -> String {
    let text = text.trim();
    match text.char_indices().nth(300) {
        Some((cut, _)) => format!("{}…", &text[..cut]),
        None => text.to_string(),
    }
}

enum Step {
    Started(Option<String>),
    Text(String),
    Warn(String),
    Fail(AiError),
    Finished,
}

/// Reads one CLI's stream-json lines into steps, and decides the terminal result.
#[derive(Default)]
struct Reader {
    claude: bool,
    started: bool,
    text_seen: bool,
    text_seen_logged: bool,
    warned_retry: bool,
    rejected: bool,
    tool_steps: Vec<u64>,
    result: Option<Result<(), AiError>>,
    note: Option<String>,
    agy_status: Option<String>,
    usage: Option<(Option<u64>, Option<u64>)>,
}

impl Reader {
    fn line(&mut self, line: &str) -> Vec<Step> {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            let line = line.trim();
            if let Some(detail) = line.strip_prefix("AGY_ERROR:") {
                let detail: Value = serde_json::from_str(detail.trim()).unwrap_or_default();
                self.agy_status = detail["status"].as_str().map(String::from);
                if let Some(error) = detail["short_error"].as_str() {
                    self.note = Some(error.to_string());
                }
            } else if !line.is_empty() {
                self.note = Some(line.trim_start_matches("error:").trim_start_matches("Error:").trim().to_string());
            }
            return Vec::new();
        };
        let mut steps = Vec::new();
        if !self.started && (v["type"] == "system" && v["subtype"] == "init" || v["event"] == "init") {
            self.started = true;
            let model = v["model"].as_str().or(v["init"]["model"].as_str()).filter(|model| !model.is_empty()).map(String::from);
            steps.push(Step::Started(model));
        }
        if self.claude { self.claude_line(&v, &mut steps) } else { self.agy_line(&v, &mut steps) }
        steps
    }

    fn claude_line(&mut self, v: &Value, steps: &mut Vec<Step>) {
        match v["type"].as_str() {
            Some("stream_event") => {
                let event = &v["event"];
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                    && let Some(text) = event["delta"]["text"].as_str().filter(|text| !text.is_empty())
                {
                    self.text_seen = true;
                    steps.push(Step::Text(text.to_string()));
                }
            }
            Some("system") if v["subtype"] == "api_retry" => {
                let status = v["error_status"].as_u64();
                let attempt = v["attempt"].as_u64().unwrap_or(1);
                match status {
                    Some(401 | 403) => steps.push(Step::Fail(Engine::Claude.not_logged_in())),
                    None if attempt >= 4 && !self.text_seen => steps.push(Step::Fail(AiError::new(
                        "offline", "Claude Code cannot reach its service. Check the internet connection, then try again.",
                    ))),
                    Some(429) if attempt >= 3 && !self.text_seen => steps.push(Step::Fail(AiError::new(
                        "rate_limited", "Claude Code is rate limited. Wait a little, then try again.",
                    ))),
                    _ if !self.warned_retry => {
                        self.warned_retry = true;
                        steps.push(Step::Warn(match status {
                            None => "Claude Code cannot reach its service. Retrying.".into(),
                            Some(429) => "Claude Code is rate limited. Retrying.".into(),
                            Some(_) => "Claude Code reports that the service is busy. Retrying.".into(),
                        }));
                    }
                    _ => {}
                }
            }
            Some("rate_limit_event") if v["rate_limit_info"]["status"] == "rejected" => self.rejected = true,
            Some("assistant") if v["message"]["model"] == "<synthetic>" => {
                self.note = v["message"]["content"][0]["text"].as_str().map(String::from);
            }
            Some("result") => {
                let usage = &v["usage"];
                let input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].iter()
                    .filter_map(|field| usage[*field].as_u64()).reduce(|a, b| a + b);
                self.usage = Some((input, usage["output_tokens"].as_u64()));
                let failed = v["is_error"] == true || v["subtype"].as_str().is_some_and(|subtype| subtype != "success");
                self.result = Some(if failed {
                    let text = v["result"].as_str().map(String::from)
                        .or_else(|| v["errors"].as_array().map(|errors| errors.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("; ")))
                        .filter(|text| !text.trim().is_empty())
                        .or_else(|| self.note.clone())
                        .unwrap_or_else(|| v["subtype"].as_str().unwrap_or("error").replace('_', " "));
                    Err(claude_error(&text, v["api_error_status"].as_u64(), self.rejected))
                } else {
                    Ok(())
                });
                steps.push(Step::Finished);
            }
            _ => {}
        }
    }

    fn agy_line(&mut self, v: &Value, steps: &mut Vec<Step>) {
        if v["event"] == "step_update" {
            let step = &v["step_update"];
            let kind = step["step_type"].as_str().unwrap_or_default();
            if kind == "agent_response" {
                if let Some(text) = step["text_delta"].as_str().filter(|text| !text.is_empty()) {
                    self.text_seen = true;
                    steps.push(Step::Text(text.to_string()));
                }
            } else if step.get("tool_name").is_some() || matches!(kind, "tool" | "subagent") {
                let tool = step["tool_name"].as_str().unwrap_or(kind);
                if step["state"] == "DONE" {
                    // The deny hook did not hold: stop before the model can use what the tool returned.
                    steps.push(Step::Fail(AiError::new("protocol", format!(
                        "Antigravity ran a tool ({tool}), which Radiant does not allow, so the request was stopped."
                    ))));
                    return;
                }
                let index = step["step_index"].as_u64().unwrap_or(u64::MAX);
                if !self.tool_steps.contains(&index) {
                    self.tool_steps.push(index);
                }
                if self.tool_steps.len() > MAX_TOOL_ATTEMPTS {
                    steps.push(Step::Fail(AiError::new("protocol", "Antigravity kept trying to use tools, which Radiant does not allow, so the request was stopped.")));
                }
            }
        } else if v["event"] == "result" {
            let result = &v["result"];
            let usage = &result["usage"];
            self.usage = Some((usage["input_tokens"].as_u64(), usage["output_tokens"].as_u64()));
            self.result = Some(if result["status"] == "SUCCESS" {
                if self.text_seen || result["response"].as_str().is_some_and(|text| !text.trim().is_empty()) {
                    Ok(())
                } else {
                    Err(AiError::new("other", match self.note.as_deref() {
                        Some(note) => format!("Antigravity returned no text: {}", short(note)),
                        None => "Antigravity returned no text.".into(),
                    }))
                }
            } else {
                let text = result["error"].as_str().map(String::from).or_else(|| self.note.clone())
                    .unwrap_or_else(|| "The request failed.".into());
                Err(agy_error(&text, self.agy_status.as_deref()))
            });
            steps.push(Step::Finished);
        }
    }

    /// The terminal result once the process has ended.
    fn finish(&mut self, engine: Engine, exit: Option<std::process::ExitStatus>, stderr: &str) -> Terminal {
        if let Some(result) = self.result.take() {
            return match result { Ok(()) => Terminal::Done, Err(error) => Terminal::Error(error) };
        }
        let detail = stderr.lines().map(str::trim).rfind(|line| !line.is_empty()).map(String::from).or_else(|| self.note.clone());
        let error = match (engine, detail) {
            (Engine::Claude, Some(detail)) => claude_error(&detail, None, self.rejected),
            (Engine::Antigravity, Some(detail)) => agy_error(&detail, self.agy_status.as_deref()),
            (_, None) => AiError::new("process_exited", match exit {
                Some(status) => format!("{} exited ({status}) before it finished.", engine.label()),
                None => format!("{} stopped before it finished.", engine.label()),
            }),
        };
        Terminal::Error(error)
    }
}

fn claude_error(text: &str, status: Option<u64>, rejected: bool) -> AiError {
    let lower = text.to_lowercase();
    let code = if matches!(status, Some(401 | 403)) || lower.contains("not logged in") || lower.contains("/login")
        || lower.contains("invalid api key") || lower.contains("oauth token") || lower.contains("auth login") {
        "not_logged_in"
    } else if lower.contains("credit balance") {
        "credits_depleted"
    } else if lower.contains("usage limit") || lower.contains("hit your limit") || (rejected && status != Some(429)) {
        "usage_exhausted"
    } else if status == Some(429) || lower.contains("rate limit") {
        "rate_limited"
    } else if lower.contains("overloaded") || matches!(status, Some(500..=599)) {
        "transient"
    } else if lower.contains("connection error") || lower.contains("fetch failed") || lower.contains("enotfound") || lower.contains("econnrefused") {
        "offline"
    } else {
        "other"
    };
    match code {
        "not_logged_in" => Engine::Claude.not_logged_in(),
        "usage_exhausted" => AiError::new(code, format!("Your Claude plan's usage limit is reached. {}", short(text))),
        "credits_depleted" => AiError::new(code, "Your Claude credit balance is too low."),
        "rate_limited" => AiError::new(code, "Claude Code is rate limited. Wait a little, then try again."),
        "offline" => AiError::new(code, "Claude Code cannot reach its service. Check the internet connection, then try again."),
        "transient" => AiError::new(code, "Claude Code reports that the service is busy. Try again shortly."),
        _ => AiError::new(code, format!("Claude Code: {}", short(text))),
    }
}

async fn stop(child: &mut Child, group: Option<i32>) {
    #[cfg(unix)]
    if let Some(group) = group.filter(|group| *group > 0) {
        // SAFETY: the CLI was started as the leader of its own process group.
        unsafe { libc::kill(-group, libc::SIGKILL); }
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
}

/// Runs one text turn through `engine` in `cwd` (created here, removed by the caller).
pub(super) async fn run(inner: &Inner, engine: Engine, id: &str, job: &Job, req: &AiTurnRequest, cwd: &Path) -> Terminal {
    if job.cancelled.load(Ordering::SeqCst) {
        return Terminal::Cancelled;
    }
    let t0 = tokio::time::Instant::now();
    let probe = match probe(&inner.cli, engine).await {
        Ok(probe) => probe,
        Err(error) => return Terminal::Error(error),
    };
    if let Err(error) = probe.flags {
        return Terminal::Error(error);
    }
    if let Err(e) = tokio::fs::create_dir_all(cwd).await {
        return Terminal::Error(AiError::new("other", format!("working directory: {e}")));
    }
    let launch = match engine {
        Engine::Claude => claude_launch(req),
        Engine::Antigravity => match agy_launch(inner, &probe.bin, req, cwd).await {
            Ok(launch) => launch,
            Err(error) => return Terminal::Error(error),
        },
    };
    if job.cancelled.load(Ordering::SeqCst) {
        return Terminal::Cancelled;
    }
    let mut cmd = command(&probe.bin);
    cmd.args(&launch.args).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    trace::wire(&job.trace, "request", &format!("{} print", engine.binary()));
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => return Terminal::Error(AiError::new("process_exited", format!("Could not start {}: {e}", engine.label()))),
    };
    let group = child.id().and_then(|pid| i32::try_from(pid).ok());
    if let Some(mut stdin) = child.stdin.take() {
        let prompt = launch.stdin;
        tauri::async_runtime::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let errors = Arc::new(Mutex::new(String::new()));
    if let Some(stderr) = child.stderr.take() {
        let errors = errors.clone();
        tauri::async_runtime::spawn(async move {
            let mut stderr = stderr;
            let mut buffer = [0u8; 4096];
            while let Ok(read) = stderr.read(&mut buffer).await {
                if read == 0 { break; }
                if let Ok(mut errors) = errors.lock() && errors.len() < 16 * 1024 {
                    errors.push_str(&String::from_utf8_lossy(&buffer[..read]));
                }
            }
        });
    }
    let Some(stdout) = child.stdout.take() else {
        stop(&mut child, group).await;
        return Terminal::Error(AiError::new("other", format!("Could not read {}'s output.", engine.label())));
    };
    let mut lines = BufReader::with_capacity(1 << 20, stdout).lines();
    let mut reader = Reader { claude: engine == Engine::Claude, ..Reader::default() };
    let hard = text_timeout();
    let deadline = t0 + hard;
    let mut last_text = tokio::time::Instant::now();
    let mut warned = false;
    if let Some(warning) = launch.warning {
        inner.emit(json!({"jobId": id, "kind": "warning", "message": warning}));
    }
    let failure = loop {
        tokio::select! {
            biased;
            _ = job.notify.notified() => {
                job.cancelled.store(true, Ordering::SeqCst);
                stop(&mut child, group).await;
                return Terminal::Cancelled;
            }
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break None };
                let (mut failure, mut finished) = (None, false);
                for step in reader.line(&line) {
                    match step {
                        Step::Started(model) => {
                            trace::wire(&job.trace, "notification", "init");
                            inner.emit(json!({"jobId": id, "kind": "started", "route": "stream", "templateVersion": req.template_version,
                                "model": model.unwrap_or_else(|| launch.model.clone()), "engine": engine.id()}));
                        }
                        Step::Text(text) => {
                            if !reader.started {
                                reader.started = true;
                                inner.emit(json!({"jobId": id, "kind": "started", "route": "stream", "templateVersion": req.template_version, "model": launch.model, "engine": engine.id()}));
                            }
                            if !reader.text_seen_logged {
                                reader.text_seen_logged = true;
                                log::info!("job {id}: first {} delta after {} ms", engine.binary(), t0.elapsed().as_millis());
                            }
                            last_text = tokio::time::Instant::now();
                            warned = false;
                            if job.cancelled.load(Ordering::SeqCst) { continue; }
                            match job.receive_text(&text) {
                                Ok(()) => inner.emit(json!({"jobId": id, "kind": "delta", "text": text})),
                                Err(error) => { failure = Some(error); break; }
                            }
                        }
                        Step::Warn(message) => inner.emit(json!({"jobId": id, "kind": "warning", "message": message})),
                        Step::Fail(error) => { failure = Some(error); break; }
                        Step::Finished => {
                            trace::wire(&job.trace, "notification", "result");
                            finished = true;
                        }
                    }
                }
                // The result line is the last one; a helper process holding the pipe open must not delay the end.
                if failure.is_some() || finished { break failure; }
            }
            _ = tokio::time::sleep_until(deadline) => {
                break Some(AiError::new("timeout", format!("The model did not finish within {} s", hard.as_secs())));
            }
            _ = tokio::time::sleep_until(last_text + STALL_WARN), if !warned => {
                warned = true;
                inner.emit(json!({"jobId": id, "kind": "warning", "message": format!("{} has not streamed text for 15 seconds. You can keep waiting or cancel.", engine.label())}));
            }
        }
    };
    if let Some((input, output)) = reader.usage.take() {
        job.record_usage(input, output, None);
    }
    if let Some(error) = failure {
        stop(&mut child, group).await;
        if job.cancelled.load(Ordering::SeqCst) { return Terminal::Cancelled; }
        return Terminal::Error(error);
    }
    // Output ended: give the process a moment to exit, then make sure nothing it started lives on.
    let exit = tokio::select! {
        biased;
        _ = job.notify.notified() => None,
        status = tokio::time::timeout(Duration::from_secs(5), child.wait()) => status.ok().and_then(Result::ok),
    };
    stop(&mut child, group).await;
    if job.cancelled.load(Ordering::SeqCst) {
        return Terminal::Cancelled;
    }
    let stderr = errors.lock().map(|errors| errors.clone()).unwrap_or_default();
    reader.finish(engine, exit, &stderr)
}
