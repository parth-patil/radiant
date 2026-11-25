//! One-shot map generation. Nothing is emitted until the entire result is validated.
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

use super::{AiError, AiTurnRequest, Inner, Job, MapLimits, Terminal, rpc, text_timeout};

const SCHEMA: &str = include_str!("map.schema.json");
const MAX_OUTPUT: u64 = 2 * 1024 * 1024;
const MAX_NODES: usize = 400;
const DEFAULT_LIMITS: MapLimits = MapLimits { max_depth: 3, max_children: 5 };

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Map {
    nodes: Vec<Node>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Node {
    id: String,
    parent_id: Value,
    title: String,
    note: Value,
    // Required by the output schema, even when the model supplies null.
    #[serde(deserialize_with = "Deserialize::deserialize")]
    source_heading: Option<String>,
}

fn protocol(message: impl Into<String>) -> AiError {
    AiError::new("protocol", message)
}

fn to_node_lines(result: &[u8], limits: MapLimits) -> Result<String, AiError> {
    let map: Map = serde_json::from_slice(result).map_err(|_| protocol("Codex returned a map that failed its output schema"))?;
    if map.nodes.is_empty() || map.nodes.len() > MAX_NODES {
        return Err(protocol("Codex returned an empty or oversized map"));
    }
    let mut depths = HashMap::<&str, usize>::new();
    let mut children = HashMap::<&str, usize>::new();
    let mut lines = String::new();
    for (index, node) in map.nodes.iter().enumerate() {
        if let Some(parent) = node.parent_id.as_str() {
            let count = children.entry(parent).or_default();
            *count += 1;
            if *count > limits.max_children {
                return Err(protocol(format!("Codex exceeded the requested breadth at row {}", index + 1)));
            }
        }
        let depth = if index == 0 && node.parent_id.is_null() {
            Some(0)
        } else {
            node.parent_id.as_str().and_then(|parent| depths.get(parent)).map(|depth| depth + 1)
        };
        let note_valid = node.note.is_null() || node.note.as_str().is_some_and(|note| note.encode_utf16().count() <= 2000);
        let Some(depth) = depth.filter(|depth| *depth <= limits.max_depth) else {
            return Err(protocol(format!("Codex returned an invalid map parent or depth at row {}", index + 1)));
        };
        if node.id.is_empty() || node.id.len() > 128 || node.id.trim() != node.id
            || node.title.trim().is_empty() || node.title.encode_utf16().count() > 200
            || !note_valid || depths.insert(node.id.as_str(), depth).is_some()
        {
            return Err(protocol(format!("Codex returned an invalid map node at row {}", index + 1)));
        }
        // StreamApplier accepts the same parent-before-child convention as the JSON Lines route.
        lines.push_str(&json!({"id": node.id, "parent": node.parent_id, "title": node.title, "note": node.note, "sourceHeading": node.source_heading.as_deref().filter(|heading| heading.encode_utf16().count() <= 240)}).to_string());
        lines.push('\n');
    }
    Ok(lines)
}

pub(super) async fn available(bin: &Path) -> bool {
    let mut cmd = Command::new(bin);
    cmd.args(["exec", "--help"]).env("PATH", rpc::child_path(bin)).stdin(Stdio::null()).kill_on_drop(true);
    let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(3), cmd.output()).await else { return false };
    let help = String::from_utf8_lossy(&output.stdout);
    output.status.success() && ["--output-schema", "--output-last-message", "--ignore-user-config", "--ignore-rules", "--ephemeral",
        "--sandbox", "--skip-git-repo-check", "--disable", "--config", "--json"].iter().all(|flag| help.contains(flag))
}

async fn execute(bin: &Path, cwd: &Path, req: &AiTurnRequest, prompt: &str, job: &Job) -> Result<String, AiError> {
    let schema_path = cwd.join("output-schema.json");
    let output_path = cwd.join("map.json");
    tokio::fs::create_dir_all(cwd).await.map_err(|e| AiError::new("other", format!("working directory: {e}")))?;
    tokio::fs::write(&schema_path, SCHEMA).await.map_err(|e| AiError::new("other", format!("output schema: {e}")))?;

    let mut cmd = Command::new(bin);
    cmd.args([
        "exec", "--json", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox", "read-only",
        "--skip-git-repo-check", "-c", "approval_policy=\"never\"",
    ]);
    let search = if req.web_search { "live" } else { "disabled" };
    cmd.args(["-c", &format!("web_search=\"{search}\"")]);
    for feature in rpc::DISABLED_FEATURES.iter().copied().chain(["shell_tool", "image_generation", "view_image"]) {
        cmd.args(["--disable", feature]);
    }
    if let Some(model) = &req.model {
        cmd.args(["--model", model]);
    }
    if let Some(effort @ ("low" | "medium" | "high")) = req.effort.as_deref() {
        cmd.args(["-c", &format!("model_reasoning_effort=\"{effort}\"")]);
    }
    cmd.arg("--output-schema").arg(&schema_path).arg("--output-last-message").arg(&output_path).arg("--").arg(prompt);
    cmd.env("PATH", rpc::child_path(bin)).current_dir(cwd)
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| AiError::new("process_exited", format!("Could not start Codex's JSON fallback: {e}")))?;
    let stdout = child.stdout.take().ok_or_else(|| protocol("Could not read the Codex fallback events"))?;
    let mut lines = BufReader::new(stdout).lines();
    let mut failure = None;
    while let Some(line) = lines.next_line().await.map_err(|_| protocol("Could not read a Codex fallback event"))? {
        let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
        match event["type"].as_str() {
            Some("turn.completed" | "turn.failed") => {
                job.record_usage(event["usage"]["input_tokens"].as_u64(), event["usage"]["output_tokens"].as_u64(), None);
                if event["type"] == "turn.failed" {
                    failure = Some(super::map_turn_error(&event["error"]));
                }
            }
            _ => {}
        }
    }
    let status = child.wait().await.map_err(|e| AiError::new("process_exited", format!("Codex JSON fallback failed: {e}")))?;
    if let Some(failure) = failure { return Err(failure); }
    if !status.success() {
        return Err(AiError::new("process_exited", format!("Codex JSON fallback exited with {status}")));
    }
    let file = tokio::fs::File::open(output_path).await.map_err(|_| protocol("Codex returned no JSON map"))?;
    let mut bytes = Vec::new();
    file.take(MAX_OUTPUT + 1).read_to_end(&mut bytes).await.map_err(|e| protocol(format!("Could not read the JSON map: {e}")))?;
    if bytes.len() as u64 > MAX_OUTPUT {
        return Err(protocol("Codex returned an oversized JSON map"));
    }
    to_node_lines(&bytes, req.map_limits.unwrap_or(DEFAULT_LIMITS))
}

pub(super) async fn run(inner: &Inner, bin: &Path, id: &str, job: &Job, req: &AiTurnRequest, cwd: &Path, prompt: &str) -> Terminal {
    if job.cancelled.load(Ordering::SeqCst) {
        return Terminal::Cancelled;
    }
    inner.emit(json!({"jobId": id, "kind": "started", "route": "exec", "templateVersion": req.template_version, "model": req.model}));
    tokio::select! {
        biased;
        _ = job.notify.notified() => Terminal::Cancelled,
        result = tokio::time::timeout(text_timeout(), execute(bin, cwd, req, prompt, job)) => match result {
            Ok(Ok(text)) => {
                if job.cancelled.load(Ordering::SeqCst) { return Terminal::Cancelled; }
                match job.receive_text(&text) {
                    Ok(()) => {
                        inner.emit(json!({"jobId": id, "kind": "delta", "text": text}));
                        Terminal::Done
                    }
                    Err(error) => Terminal::Error(error),
                }
            }
            Ok(Err(error)) => Terminal::Error(error),
            Err(_) => Terminal::Error(AiError::new("timeout", "Codex's JSON fallback timed out")),
        }
    }
}
