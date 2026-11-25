use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    Res, commit_edit, document_digest, load_doc, msg, now_iso, open_doc_connection, read_snapshot, recover_docs,
};

#[derive(Clone, Deserialize, Serialize)]
pub struct Entry {
    label: String,
    source: String,
    time: u64,
    fwd: Vec<Value>,
    inv: Vec<Value>,
}

#[derive(Serialize)]
pub struct Receipt {
    before: String,
    after: String,
    entry: Entry,
}

pub async fn save_reserved(
    app: tauri::AppHandle,
    path: String,
    id: String,
    text: String,
) -> Result<Option<Receipt>, String> {
    use tauri::Manager;
    super::blocking(move || {
        let saved = save(&path, &id, &text);
        app.state::<crate::open_files::OpenFiles>().finish_save(
            &app,
            crate::capture::WINDOW,
            &path,
            false,
        );
        saved
    })
    .await
}

pub async fn load_history(path: String, revision: String) -> Result<Vec<Entry>, String> {
    super::blocking(move || history(&path, &revision)).await
}

/// Called only while the desktop has reserved the closed map for this action.
fn save(path: &str, id: &str, text: &str) -> Res<Option<Receipt>> {
    if super::file_format(std::path::Path::new(path)).is_some_and(|version| version < super::FORMAT_VERSION) {
        return msg("Open this older map in Radiant to create a migrated copy, then select that copy for Quick Capture.");
    }
    let before = load_doc(path)?;
    let mut doc: Value = serde_json::from_str(&before)?;
    let Some(root) = doc["roots"]
        .as_array()
        .and_then(|roots| roots.first())
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return msg("The map has no main topic to capture into.");
    };
    let Some(nodes) = doc.get_mut("nodes").and_then(Value::as_object_mut) else {
        return msg("The map has no editable nodes.");
    };
    if let Some(existing) = nodes.get(id) {
        return if existing["text"] == text {
            Ok(None)
        } else {
            msg("A different node already uses this capture identifier.")
        };
    }
    if recover_docs()?
        .iter()
        .any(|item| item.path.as_deref() == Some(path))
    {
        return msg(
            "This map has unsaved recovery edits. Open it, recover your edits, then try again.",
        );
    }
    let Some(children) = nodes
        .get_mut(&root)
        .and_then(|node| node["children"].as_array_mut())
    else {
        return msg("The main topic has an invalid child list.");
    };
    let index = children.len();
    children.push(json!(id));
    let node = json!({"id":id,"parent":root,"children":[],"text":text,"origin":{"by":"user"}});
    nodes.insert(id.to_owned(), node.clone());
    doc["modified"] = json!(now_iso());
    let after = doc.to_string();
    let entry = Entry {
        label: "Quick Capture".into(),
        source: "user".into(),
        time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        fwd: vec![json!({"t":"insert","node":node,"parent":root,"index":index})],
        inv: vec![json!({"t":"remove","id":id})],
    };
    let operation = json!({
        "version":1, "kind":"apply", "label":entry.label, "source":"user",
        "forward":[{"op":entry.fwd[0]}], "inverse":[{"op":entry.inv[0]}],
        "quickCapture":entry
    });
    if !commit_edit(
        path,
        &document_digest(&before),
        &after,
        &operation.to_string(),
    )? {
        return msg("The map changed during capture. Retry to add the node to the latest version.");
    }
    Ok(Some(Receipt {
        before,
        after,
        entry,
    }))
}

/// Fall back to the portable journal if a capture never reached local browser history storage.
fn history(path: &str, revision: &str) -> Res<Vec<Entry>> {
    let mut database = open_doc_connection(path, false)?;
    let connection = database.transaction()?;
    let current = read_snapshot(&connection, path)?;
    if document_digest(&current) != revision {
        return Ok(vec![]);
    }
    let document: Value = serde_json::from_str(&current)?;
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='operation_log')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(vec![]);
    }
    let head = connection
        .query_row(
            "SELECT result_json_hash FROM operation_log ORDER BY sequence DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if head.as_deref() != Some(revision) {
        return Ok(vec![]);
    }
    let mut query = connection
        .prepare("SELECT operation_json FROM operation_log ORDER BY sequence DESC LIMIT 1000")?;
    let mut rows = query.query([])?;
    let mut entries = Vec::new();
    while let Some(row) = rows.next()? {
        let operation: Value = serde_json::from_str(&row.get::<_, String>(0)?)?;
        let Some(capture) = operation.get("quickCapture") else {
            break;
        };
        let entry: Entry = serde_json::from_value(capture.clone())?;
        if !valid_undo_entry(&document, &entry) {
            return msg("The map contains an invalid quick-capture undo entry.");
        }
        entries.push(entry);
    }
    entries.reverse();
    Ok(entries)
}

fn valid_undo_entry(document: &Value, entry: &Entry) -> bool {
    if entry.label != "Quick Capture"
        || entry.source != "user"
        || entry.fwd.len() != 1
        || entry.inv.len() != 1
    {
        return false;
    }
    let insert = &entry.fwd[0];
    let remove = &entry.inv[0];
    let Some(id) = insert["node"]["id"].as_str() else {
        return false;
    };
    let Some(parent) = insert["parent"].as_str() else {
        return false;
    };
    let Some(index) = insert["index"]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
    else {
        return false;
    };
    let capture_id = id
        .strip_prefix("capture-")
        .is_some_and(|value| uuid::Uuid::parse_str(value).is_ok());
    capture_id
        && insert["t"] == "insert"
        && remove["t"] == "remove"
        && remove["id"] == id
        && document["nodes"][id] == insert["node"]
        && document["nodes"][id]["parent"] == parent
        && document["nodes"][id]["children"]
            .as_array()
            .is_some_and(Vec::is_empty)
        && document["nodes"][parent]["children"]
            .get(index)
            .and_then(Value::as_str)
            == Some(id)
}
