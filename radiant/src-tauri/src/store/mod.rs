//! Document files, autosave, crash recovery and the asset store. Owner: host agent.
//!
//! File format: a `.radiant` file is a SQLite database (application_id 0x52444E54 "RDNT", user_version =
//! format version), with indexed document, artwork and operation tables. Referenced assets are embedded so a
//! file is self-contained. Saves are atomic (temporary file in the same directory, then rename).
pub mod bundle;
pub mod capture;
pub mod mindnode;
pub mod browser;

mod asset_meta;
mod journal;
mod projection;
mod rank;

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{App, Manager, State};

/// SQLite application_id for Radiant files ("RDNT").
const APPLICATION_ID: i64 = 0x5244_4E54;
/// Current document file format version (stored in user_version and meta).
const FORMAT_VERSION: i64 = 3;
const FIRST_FORMAT_VERSION: i64 = 1;
const INDEXED_FORMAT_VERSION: i64 = 2;
/// Known asset file extensions, in lookup order.
const EXTENSIONS: &[&str] = &["png", "jpg", "webp", "gif", "svg", "bin"];

#[derive(Default)]
pub struct StoreState {
    baselines: Mutex<HashMap<(String, String), String>>,
    window_io: Mutex<HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
}

impl StoreState {
    fn window_io(&self, label: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
        self.window_io.lock().unwrap().entry(label.to_owned()).or_default().clone()
    }

    fn expected(&self, window: &str, path: &str) -> Option<String> {
        self.baselines.lock().unwrap().get(&(window.to_string(), path.to_string())).cloned()
    }

    fn remember(&self, window: &str, path: String, revision: String) {
        self.baselines.lock().unwrap().insert((window.to_string(), path), revision);
    }

    pub(crate) fn forget(&self, window: &str) {
        self.baselines.lock().unwrap().retain(|(owner, _), _| owner != window);
        self.window_io.lock().unwrap().remove(window);
    }
}

fn document_digest(json: &str) -> String {
    hex::encode(Sha256::digest(json))
}


#[derive(Debug, thiserror::Error)]
pub(crate) enum StoreError {
    #[error("{0}")]
    Msg(String),
    #[error("Could not access {path}: {source}")]
    Io { path: String, source: std::io::Error },
    #[error("Database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("The document is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
}

type Res<T> = Result<T, StoreError>;

fn msg<T>(s: impl Into<String>) -> Res<T> {
    Err(StoreError::Msg(s.into()))
}

fn io<T>(path: &Path, r: std::io::Result<T>) -> Res<T> {
    r.map_err(|source| StoreError::Io { path: path.display().to_string(), source })
}

struct Paths {
    assets: PathBuf,
    autosave: PathBuf,
}

static PATHS: OnceLock<Paths> = OnceLock::new();

fn paths() -> Res<&'static Paths> {
    PATHS.get().ok_or_else(|| StoreError::Msg("The store is not initialised yet".into()))
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(debug_assertions)]
    if std::env::args().any(|a| a == "--store-selftest") {
        let base = std::env::temp_dir().join(format!("radiant-store-selftest-{}", uuid::Uuid::new_v4().simple()));
        let p = Paths { assets: base.join("assets"), autosave: base.join("autosave") };
        fs::create_dir_all(&p.assets)?;
        fs::create_dir_all(&p.autosave)?;
        let _ = PATHS.set(p);
        let code = if selftest::run(&base) { 0 } else { 1 };
        let _ = fs::remove_dir_all(&base);
        std::process::exit(code);
    }
    let base = app.path().app_data_dir()?;
    let p = Paths { assets: base.join("assets"), autosave: base.join("autosave") };
    fs::create_dir_all(&p.assets)?;
    fs::create_dir_all(&p.autosave)?;
    open_index(&p.assets)?;
    let _ = PATHS.set(p);
    Ok(())
}

// ------------------------------------------------------------------ helpers

fn now_iso() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    iso_from_secs(secs)
}

fn iso_from_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
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

fn valid_hash(h: &str) -> bool {
    !h.is_empty() && h.len() <= 128 && h.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_doc_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/svg+xml" => "svg",
        _ => "bin",
    }
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// Write authoritative bytes to `path` atomically and durably.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Res<()> {
    write_replacement(path, bytes, true)
}

/// A derived cache can be rebuilt from the checked embedded bytes after a crash.
fn write_replacement(path: &Path, bytes: &[u8], durable: bool) -> Res<()> {
    use std::io::Write;
    let tmp = tmp_sibling(path);
    let result = (|| -> Res<()> {
        let mut f = io(&tmp, fs::File::create(&tmp))?;
        io(&tmp, f.write_all(bytes))?;
        if durable {
            io(&tmp, f.sync_all())?;
            rename_durably(&tmp, path)
        } else {
            io(path, fs::rename(&tmp, path))
        }
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

fn sync_parent(target: &Path) -> Res<()> {
    #[cfg(unix)]
    if let Some(folder) = target.parent().filter(|path| !path.as_os_str().is_empty()) {
        io(folder, fs::File::open(folder).and_then(|directory| directory.sync_all()))?;
    }
    #[cfg(not(unix))]
    let _ = target;
    Ok(())
}

fn rename_durably(source: &Path, target: &Path) -> Res<()> {
    io(target, fs::rename(source, target))?;
    sync_parent(target)
}

fn tmp_sibling(path: &Path) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    path.with_file_name(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()))
}

// ------------------------------------------------------------------ asset store

fn open_index(assets: &Path) -> Res<Connection> {
    let c = Connection::open(assets.join("index.sqlite"))?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS assets(
            hash TEXT PRIMARY KEY, mime TEXT, prompt TEXT, model TEXT, revised_prompt TEXT,
            created_by TEXT, created_at TEXT, width INTEGER, height INTEGER, thumb_hash BLOB, generation_json TEXT);",
    )?;
    if !asset_meta::has_columns(&c)? {
        let tx = rusqlite::Transaction::new_unchecked(&c, rusqlite::TransactionBehavior::Immediate)?;
        asset_meta::migrate(&tx)?;
        tx.commit()?;
    }
    Ok(c)
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMeta {
    pub prompt: Option<String>,
    pub model: Option<String>,
    pub revised_prompt: Option<String>,
    pub instructions: Option<String>,
    pub effort: Option<String>,
    pub original_asset: Option<String>,
    pub created_by: Option<String>,
    pub seed: Option<i64>,
    pub svg_seed: Option<i64>,
    pub style_version: Option<u32>,
    pub template_version: Option<String>,
    pub generated_at: Option<String>,
    pub input_hash: Option<String>,
    pub style_snapshot: Option<Value>,
    pub parent_asset: Option<String>,
}

fn find_asset_file(hash: &str) -> Res<Option<PathBuf>> {
    if !valid_hash(hash) {
        return msg(format!("Invalid asset hash \"{hash}\""));
    }
    let dir = &paths()?.assets;
    Ok(EXTENSIONS.iter().map(|e| dir.join(format!("{hash}.{e}"))).find(|p| p.is_file()))
}

#[derive(Default)]
struct AssetRow {
    mime: Option<String>,
    meta: AssetMeta,
    created_at: Option<String>,
    geometry: asset_meta::Geometry,
    generation: Option<Value>,
}

impl AssetRow {
    /// The bytes can have been generated more than once. Embed the provenance of
    /// the artwork used in this document, even if the global cache knows another job.
    fn use_document_generation(&mut self, record: Option<&Value>) {
        let Some(record) = record else { return };
        // Early documents kept a compact style description next to the node.
        // A matching ingestion record can carry its full style, seed and model.
        let cached = self.generation.take();
        let same_job = cached.as_ref().is_some_and(|item| {
            item["prompt"] == record["prompt"] && (item["generatedAt"].is_null()
                || record["generatedAt"].is_null() || item["generatedAt"] == record["generatedAt"])
        });
        self.generation = if same_job {
            asset_meta::combine_generation(cached, Some(record))
        } else {
            asset_meta::combine_generation(Some(record.clone()), cached.as_ref())
        };
        if let Some(generation) = self.generation.as_ref() {
            self.meta.prompt = generation["prompt"].as_str().map(str::to_owned);
            self.meta.model = generation["model"].as_str().map(str::to_owned);
            self.meta.revised_prompt = generation["revisedPrompt"].as_str().map(str::to_owned);
            self.meta.created_by = Some("ai".into());
        }
    }
}

const ASSET_FIELDS: &str = "mime, prompt, model, revised_prompt, created_by, created_at, width, height, thumb_hash, generation_json";
const LEGACY_ASSET_FIELDS: &str = "mime, prompt, model, revised_prompt, created_by, created_at, NULL, NULL, NULL, NULL";

fn read_asset(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<AssetRow> {
    let generation: Option<String> = row.get(offset + 9)?;
    Ok(AssetRow {
        mime: row.get(offset)?,
        meta: AssetMeta {
            prompt: row.get(offset + 1)?, model: row.get(offset + 2)?,
            revised_prompt: row.get(offset + 3)?, created_by: row.get(offset + 4)?,
            ..Default::default()
        },
        created_at: row.get(offset + 5)?,
        geometry: asset_meta::Geometry {
            width: row.get(offset + 6)?, height: row.get(offset + 7)?, thumb_hash: row.get(offset + 8)?,
            ..Default::default()
        },
        generation: generation.and_then(|text| serde_json::from_str(&text).ok()).filter(Value::is_object),
    })
}

fn get_asset(connection: &Connection, hash: &str) -> Res<Option<AssetRow>> {
    let mut query = connection.prepare_cached(&format!("SELECT {ASSET_FIELDS} FROM assets WHERE hash=?1"))?;
    let mut asset = query.query_row([hash], |row| read_asset(row, 0)).optional()?;
    if let Some(asset) = asset.as_mut() && asset.generation.is_none() {
        asset.generation = asset_meta::generation(hash, &asset.meta);
    }
    Ok(asset)
}

fn index_asset_row(connection: &Connection, hash: &str, asset: &AssetRow) -> Res<()> {
    connection.prepare_cached(
        "INSERT INTO assets(hash,mime,prompt,model,revised_prompt,created_by,created_at,width,height,thumb_hash,generation_json)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(hash) DO UPDATE SET
           mime=COALESCE(assets.mime,excluded.mime),
           prompt=COALESCE(assets.prompt,excluded.prompt),
           model=COALESCE(assets.model,excluded.model),
           revised_prompt=COALESCE(assets.revised_prompt,excluded.revised_prompt),
           created_by=COALESCE(assets.created_by,excluded.created_by),
           width=COALESCE(assets.width,excluded.width), height=COALESCE(assets.height,excluded.height),
           thumb_hash=COALESCE(assets.thumb_hash,excluded.thumb_hash),
           generation_json=COALESCE(excluded.generation_json,assets.generation_json)
         WHERE (assets.mime IS NULL AND excluded.mime IS NOT NULL)
            OR (assets.prompt IS NULL AND excluded.prompt IS NOT NULL)
            OR (assets.model IS NULL AND excluded.model IS NOT NULL)
            OR (assets.revised_prompt IS NULL AND excluded.revised_prompt IS NOT NULL)
            OR (assets.created_by IS NULL AND excluded.created_by IS NOT NULL)
            OR (assets.width IS NULL AND excluded.width IS NOT NULL)
            OR (assets.height IS NULL AND excluded.height IS NOT NULL)
            OR (assets.thumb_hash IS NULL AND excluded.thumb_hash IS NOT NULL)
            OR (excluded.generation_json IS NOT NULL AND assets.generation_json IS NOT excluded.generation_json)"
    )?.execute(
        params![hash, asset.mime, asset.meta.prompt, asset.meta.model, asset.meta.revised_prompt, asset.meta.created_by,
                asset.created_at.clone().unwrap_or_else(now_iso), asset.geometry.width, asset.geometry.height,
                asset.geometry.thumb_hash, asset.generation.as_ref().map(Value::to_string)]
    )?;
    Ok(())
}

fn put_asset_bytes(bytes: &[u8], mime: &str, meta: &AssetMeta) -> Res<String> {
    let hash = hex::encode(Sha256::digest(bytes));
    let dir = &paths()?.assets;
    if find_asset_file(&hash)?.is_none() {
        atomic_write(&dir.join(format!("{hash}.{}", ext_for_mime(mime))), bytes)?;
    }
    index_asset_bytes(&hash, bytes, mime, meta)?;
    Ok(hash)
}

fn index_asset_bytes(hash: &str, bytes: &[u8], mime: &str, meta: &AssetMeta) -> Res<()> {
    index_asset(hash, mime, meta, || Ok(std::borrow::Cow::Borrowed(bytes)))
}

fn index_asset<'a>(
    hash: &str,
    mime: &str,
    meta: &AssetMeta,
    read_original: impl FnOnce() -> Res<std::borrow::Cow<'a, [u8]>>,
) -> Res<()> {
    let asset_dir = &paths()?.assets;
    let mut index = open_index(asset_dir)?;
    let known = get_asset(&index, hash)?.is_some_and(|asset| asset.geometry.thumb_hash.is_some());
    let existing = asset_meta::preview_paths(asset_dir, hash);
    let mut decoded = if !known || existing.len() < asset_meta::PREVIEW_SIZES.len() {
        // A legacy native cache can supply smaller levels without decoding the full asset again.
        let legacy = known.then(|| existing.get(&160)).flatten().and_then(|file| fs::read(file).ok());
        let from_legacy = legacy.as_deref().map(|png| asset_meta::geometry(png, "image/png")).unwrap_or_default();
        if from_legacy.previews.len() == asset_meta::PREVIEW_SIZES.len() {
            // Preserve metadata computed from the original art, including its dimensions and hash.
            asset_meta::Geometry { previews: from_legacy.previews, ..Default::default() }
        } else {
            asset_meta::geometry(&read_original()?, mime)
        }
    } else {
        asset_meta::Geometry::default()
    };
    for (size, png) in std::mem::take(&mut decoded.previews) {
        if existing.contains_key(&size) { continue; }
        let file = asset_meta::preview_path(asset_dir, hash, size);
        let parent = file.parent().expect("preview path has a directory");
        io(parent, fs::create_dir_all(parent))?;
        write_replacement(&file, &png, false)?;
    }
    let index = index.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let old = get_asset(&index, hash)?.unwrap_or_default();
    let generation = asset_meta::combine_generation(old.generation, asset_meta::generation(hash, meta).as_ref());
    let geometry = if decoded.thumb_hash.is_some() || old.geometry.thumb_hash.is_none() { decoded } else { old.geometry };
    let info = AssetRow {
        mime: Some(mime.to_string()), meta: meta.clone(), geometry, generation, ..Default::default()
    };
    index_asset_row(&index, hash, &info)?;
    index.commit()?;
    Ok(())
}

// ------------------------------------------------------------------ document file

/// Collect `imageAsset` hashes from the doc's nodes.
fn referenced_assets(doc: &Value) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    if let Some(nodes) = doc.get("nodes").and_then(Value::as_object) {
        for n in nodes.values() {
            for h in [n.get("imageAsset"), n.pointer("/pictureArt/assetHash"), n.pointer("/pictureArt/thumbnailHash"), n.pointer("/pictureArt/originalAsset"), n.pointer("/svgArt/assetHash"), n.pointer("/svgArt/svgRegion/assetHash"), n.pointer("/artReference/assetHash")].into_iter().flatten().filter_map(Value::as_str) {
                if valid_hash(h) {
                    out.insert(h.to_string());
                }
            }
        }
    }
    out
}

const SCHEMA: &str = "
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE doc(id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE assets(hash TEXT PRIMARY KEY, mime TEXT, bytes BLOB, prompt TEXT, model TEXT,
                    revised_prompt TEXT, created_by TEXT, created_at TEXT,
                    width INTEGER, height INTEGER, thumb_hash BLOB, generation_json TEXT);";

fn sync_doc_meta(tx: &rusqlite::Transaction<'_>, doc: &Value) -> Res<()> {
    let str_field = |k: &str| doc.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    for (k, v) in [
        ("format_version", FORMAT_VERSION.to_string()),
        ("app_version", env!("CARGO_PKG_VERSION").to_string()),
        ("doc_id", str_field("id")),
        ("title", str_field("title")),
        ("saved_at", now_iso()),
    ] {
        tx.execute("INSERT INTO meta(key,value) VALUES(?1,?2)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![k, v])?;
    }
    Ok(())
}

fn write_doc_file(tmp: &Path, doc: &Value, doc_json: &str, ranks: Option<&projection::RankSeed>) -> Res<()> {
    let c = Connection::open(tmp)?;
    c.pragma_update(None, "journal_mode", "DELETE")?;
    c.pragma_update(None, "synchronous", "EXTRA")?;
    #[cfg(target_os = "macos")]
    c.pragma_update(None, "fullfsync", true)?;
    c.pragma_update(None, "application_id", APPLICATION_ID)?;
    c.pragma_update(None, "user_version", FORMAT_VERSION)?;
    c.execute_batch(SCHEMA)?;
    let tx = c.unchecked_transaction()?;
    sync_doc_meta(&tx, doc)?;
    tx.execute("INSERT INTO doc(id, json) VALUES(1, ?1)", params![doc_json])?;

    projection::materialize(&tx, doc, None, ranks)?;
    tx.execute_batch(journal::SCHEMA)?;
    embed_assets(&tx, doc)?;
    tx.commit()?;
    c.close().map_err(|(_, e)| StoreError::Db(e))?;
    Ok(())
}

fn embed_assets(tx: &rusqlite::Transaction<'_>, doc: &Value) -> Res<()> {
    let mut index = open_index(&paths()?.assets)?;
    let index = index.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let generations = asset_meta::generations_from_document(doc);
    for hash in referenced_assets(doc) {
        let document_generation = generations.get(&hash);
        if let Some(mut existing) = get_asset(tx, &hash)? {
            if existing.geometry.thumb_hash.is_some() && document_generation.is_none() {
                continue;
            }
            let index = get_asset(&index, &hash)?;
            existing.generation = asset_meta::combine_generation(existing.generation, index.as_ref().and_then(|i| i.generation.as_ref()));
            existing.use_document_generation(document_generation);
            let geometry = if existing.geometry.thumb_hash.is_none() {
                if let Some(info) = index.filter(|info| info.geometry.thumb_hash.is_some()) {
                    info.geometry
                } else {
                    let bytes: Vec<u8> = tx.query_row("SELECT bytes FROM assets WHERE hash=?1", [&hash], |row| row.get(0))?;
                    asset_meta::geometry(&bytes, existing.mime.as_deref().unwrap_or(""))
                }
            } else { existing.geometry };
            if existing.generation.is_some() || geometry.width.is_some() {
                let encoded = existing.generation.as_ref().map(Value::to_string);
                tx.execute("UPDATE assets SET width=?2,height=?3,thumb_hash=?4,generation_json=?5,prompt=?6,model=?7,revised_prompt=?8,created_by=?9
                    WHERE hash=?1 AND (width IS NOT ?2 OR height IS NOT ?3 OR thumb_hash IS NOT ?4 OR generation_json IS NOT ?5
                    OR prompt IS NOT ?6 OR model IS NOT ?7 OR revised_prompt IS NOT ?8 OR created_by IS NOT ?9)",
                    params![hash, geometry.width, geometry.height, geometry.thumb_hash, encoded, existing.meta.prompt,
                        existing.meta.model, existing.meta.revised_prompt, existing.meta.created_by])?;
            }
            continue;
        }
        let Some(file) = find_asset_file(&hash)? else {
            return msg(format!("Artwork {hash} is missing. Restore the asset or remove its reference before saving."));
        };
        let bytes = io(&file, fs::read(&file))?;
        if hex::encode(Sha256::digest(&bytes)) != hash {
            return msg(format!("Artwork {hash} failed its integrity check."));
        }
        let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("bin");
        let mut info = get_asset(&index, &hash)?.unwrap_or_default();
        let mime = info.mime.get_or_insert_with(|| mime_for_ext(ext).to_string());
        if info.geometry.thumb_hash.is_none() {
            info.geometry = asset_meta::geometry(&bytes, mime);
        }
        index_asset_row(&index, &hash, &info)?;
        info.use_document_generation(document_generation);
        tx.execute(
            "INSERT INTO assets(hash,mime,bytes,prompt,model,revised_prompt,created_by,created_at,width,height,thumb_hash,generation_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![hash, info.mime, bytes, info.meta.prompt, info.meta.model, info.meta.revised_prompt, info.meta.created_by,
                    info.created_at.unwrap_or_else(now_iso), info.geometry.width, info.geometry.height, info.geometry.thumb_hash,
                    info.generation.as_ref().map(Value::to_string)],
        )?;
    }
    index.commit()?;
    Ok(())
}

fn commit_edit(path: &str, expected: &str, doc_json: &str, operation_json: &str) -> Res<bool> {
    let p = Path::new(path);
    if file_format(p) != Some(FORMAT_VERSION) { return Ok(false); }
    let mut connection = Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    journal::configure(&connection)?;
    let tx = journal::begin(&mut connection)?;
    let app_id: i64 = tx.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let version: i64 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if app_id != APPLICATION_ID || version != FORMAT_VERSION { return Ok(false); }
    let triggers: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'trigger')", [], |row| row.get(0))?;
    if triggers { return Ok(false); }
    let current: String = tx.query_row("SELECT json FROM doc WHERE id = 1", [], |row| row.get(0))?;
    if document_digest(&current) != expected { return Ok(false); }
    let doc: Value = serde_json::from_str(doc_json)?;
    if !doc.is_object() { return msg("Expected a map document."); }
    let previous = serde_json::from_str(&current)?;
    projection::materialize(&tx, &doc, Some(&previous), None)?;
    embed_assets(&tx, &doc)?;
    sync_doc_meta(&tx, &doc)?;
    journal::materialize(&tx, doc_json, operation_json, &document_digest(doc_json))?;
    tx.commit()?;
    Ok(true)
}

#[cfg(debug_assertions)]
fn save_doc(path: &str, doc_json: &str) -> Res<()> {
    save_doc_at(path, doc_json, None)
}

fn save_doc_at(path: &str, doc_json: &str, expected: Option<&str>) -> Res<()> {
    let doc: Value = serde_json::from_str(doc_json)?;
    if !doc.is_object() {
        return msg("The document must be a JSON object");
    }
    let target = PathBuf::from(path);
    let Some(dir) = target.parent().filter(|d| !d.as_os_str().is_empty()) else {
        return msg(format!("\"{path}\" is not a valid file path"));
    };
    if !dir.is_dir() {
        return msg(format!("The folder {} does not exist", dir.display()));
    }
    reject_cross_version_replacement(&target)?;
    let ranks = if file_format(&target) == Some(FORMAT_VERSION) {
        checkpoint_ranks(path, &doc).ok().flatten()
    } else {
        None
    };
    let tmp = tmp_sibling(&target);
    let result = write_doc_file(&tmp, &doc, doc_json, ranks.as_ref())
        .and_then(|_| io(&tmp, fs::File::open(&tmp).and_then(|file| file.sync_all())))
        .and_then(|_| {
            reject_cross_version_replacement(&target)?;
            if let Some(expected) = expected {
                let unchanged = read_doc_json(path).is_ok_and(|saved| document_digest(&saved) == expected);
                if !unchanged {
                    return msg("The saved map changed outside Radiant. Use Save As to keep your edits in a separate map.");
                }
            }
            rename_durably(&tmp, &target)
        });
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    if let Some(id) = doc.get("id").and_then(Value::as_str).filter(|i| valid_doc_id(i)) {
        let _ = discard_recovery(&recovery_file_id(id, Some(path)));
    }
    Ok(())
}

fn checkpoint_ranks(path: &str, doc: &Value) -> Res<Option<projection::RankSeed>> {
    let mut connection = open_doc_connection(path, false)?;
    let snapshot = connection.transaction()?;
    let prior: Value = serde_json::from_str(&read_snapshot(&snapshot, path)?)?;
    if doc["id"] != prior["id"] {
        return Ok(None);
    }
    projection::read_keys(&snapshot).map(Some)
}

fn file_format(path: &Path) -> Option<i64> {
    use std::io::Read;
    let mut header = [0; 72];
    fs::File::open(path).ok()?.read_exact(&mut header).ok()?;
    if header[..16] != *b"SQLite format 3\0"
        || i64::from(u32::from_be_bytes(header[68..72].try_into().ok()?)) != APPLICATION_ID
    {
        return None;
    }
    Some(i64::from(u32::from_be_bytes(header[60..64].try_into().ok()?)))
}

fn reject_cross_version_replacement(path: &Path) -> Res<()> {
    if file_format(path).is_some_and(|version| version != FORMAT_VERSION) {
        return msg("Choose a new file name. This map uses a different format and its original is kept.");
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    path: String,
    json: String,
    migrated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    original_json: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    unavailable_assets: Vec<String>,
}

fn open_for_editing(path: &str) -> Res<OpenedDocument> {
    let source = Path::new(path);
    if !file_format(source).is_some_and(|version| (FIRST_FORMAT_VERSION..FORMAT_VERSION).contains(&version)) {
        let (json, unavailable_assets) = load_doc_with_artwork(path)?;
        return Ok(OpenedDocument { path: path.into(), json, migrated: false, original_json: None, unavailable_assets });
    }

    let temporary = source.with_file_name(format!(".radiant-migration-{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| -> Res<OpenedDocument> {
        let original = open_doc_connection(path, false)?;
        read_snapshot(&original, path)?;
        // A transactional SQLite snapshot preserves legacy tables and asset metadata.
        let temporary_path = temporary.to_str().ok_or_else(|| StoreError::Msg("Invalid migration file name.".into()))?;
        original.execute("VACUUM INTO ?1", [temporary_path])?;
        let (json, unavailable_assets) = load_doc_with_artwork(temporary_path)?;
        let doc: Value = serde_json::from_str(&json)?;
        let mut copy = Connection::open_with_flags(&temporary, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        journal::configure(&copy)?;
        let tx = journal::begin(&mut copy)?;
        asset_meta::migrate(&tx)?;
        // Formats before v3 stored a dense ordinal and duplicate child lists.
        tx.execute_batch("DROP TABLE IF EXISTS nodes;")?;
        projection::materialize(&tx, &doc, None, None)?;
        embed_assets(&tx, &doc)?;
        sync_doc_meta(&tx, &doc)?;
        tx.execute_batch(journal::SCHEMA)?;
        tx.pragma_update(None, "user_version", FORMAT_VERSION)?;
        tx.commit()?;
        copy.close().map_err(|(_, error)| error)?;
        io(&temporary, fs::File::open(&temporary).and_then(|file| file.sync_all()))?;

        let stem: String = source.file_stem().and_then(|stem| stem.to_str())
            .unwrap_or("Map").chars().take(50).collect();
        for copy_number in 1..=1000 {
            let number = if copy_number == 1 { String::new() } else { format!(" {copy_number}") };
            let candidate = source.with_file_name(format!("{stem} (migrated{number}).radiant"));
            let candidate_path = candidate.to_str().ok_or_else(|| StoreError::Msg("Invalid migration file name.".into()))?;
            match fs::hard_link(&temporary, &candidate) {
                Ok(()) => {
                    if let Err(error) = sync_parent(&candidate) {
                        let _ = fs::remove_file(&candidate);
                        return Err(error);
                    }
                    return Ok(OpenedDocument {
                        path: candidate_path.into(), original_json: Some(json.clone()), json, migrated: true, unavailable_assets
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return io(&candidate, Err(error)),
            }
        }
        msg("Could not choose a name for the migrated map. Move the older map to another folder.")
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn open_doc_connection(path: &str, recover: bool) -> Res<Connection> {
    let p = Path::new(path);
    if !p.is_file() {
        return msg(format!("The file {path} does not exist"));
    }
    let c = if recover {
        journal::open_for_recovery(p, APPLICATION_ID, FORMAT_VERSION)
    } else {
        Connection::open_with_flags(p, OpenFlags::SQLITE_OPEN_READ_ONLY)
    }.map_err(|e| StoreError::Msg(format!("{path} is not a Radiant document ({e})")))?;
    c.execute_batch("PRAGMA trusted_schema=OFF")?;
    Ok(c)
}

fn read_snapshot(c: &Connection, path: &str) -> Res<String> {
    let app_id: i64 = c
        .pragma_query_value(None, "application_id", |r| r.get(0))
        .map_err(|e| StoreError::Msg(format!("{path} is not a Radiant document ({e})")))?;
    if app_id != APPLICATION_ID {
        return msg(format!("{path} is not a Radiant document"));
    }
    let version: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if version > FORMAT_VERSION {
        return msg(format!(
            "This document was saved by a newer version of Radiant (format {version}); this version reads up to format {FORMAT_VERSION}"
        ));
    }
    if version < FIRST_FORMAT_VERSION {
        return msg(format!("Unsupported Radiant file format {version}."));
    }
    let json: String = c
        .query_row("SELECT json FROM doc WHERE id = 1", [], |r| r.get(0))
        .map_err(|e| StoreError::Msg(format!("The document {path} is damaged: {e}")))?;

    Ok(json)
}

fn read_doc_json(path: &str) -> Res<String> {
    let mut connection = open_doc_connection(path, false)?;
    let snapshot = connection.transaction()?;
    read_snapshot(&snapshot, path)
}

// Extracted files are disposable, so a later open rechecks their content hash
// and restores any entry that was lost or interrupted before reaching disk.
fn cache_has_asset(path: &Path, hash: &str) -> bool {
    let Ok(mut file) = fs::File::open(path) else { return false };
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest).is_ok() && hex::encode(digest.finalize()) == hash
}

fn load_doc(path: &str) -> Res<String> {
    load_doc_with_artwork(path).map(|(json, _)| json)
}

fn load_doc_with_artwork(path: &str) -> Res<(String, Vec<String>)> {
    let mut connection = open_doc_connection(path, true)?;
    // Keep indexed rows, journal and artwork on the same revision as the editable JSON.
    let c = connection.transaction()?;
    let json = read_snapshot(&c, path)?;
    let integrity: String = c.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|error| StoreError::Msg(format!("The document {path} failed its integrity check: {error}")))?;
    if integrity != "ok" {
        return msg(format!("The document {path} is damaged. Restore a recent snapshot if one is available."));
    }
    let version: i64 = c.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let doc: Value = serde_json::from_str(&json)?;
    if version >= INDEXED_FORMAT_VERSION {
        projection::verify(&c, &doc, version == FORMAT_VERSION)?;
        let latest = c.query_row("SELECT result_json_hash FROM operation_log ORDER BY sequence DESC LIMIT 1",
            [], |row| row.get::<_, String>(0)).optional()?;
        if latest.is_some_and(|hash| hash != document_digest(&json)) {
            return msg("The document's operation journal disagrees with the saved snapshot.");
        }
        if !asset_meta::has_columns(&c)? { return msg("The document's artwork tables are missing metadata columns."); }
    }
    // Restore embedded bytes when the content-addressed cache misses or fails validation.
    let dir = &paths()?.assets;
    let mut index = open_index(dir)?;
    let index = index.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let fields = if version == FIRST_FORMAT_VERSION { LEGACY_ASSET_FIELDS } else { ASSET_FIELDS };
    let mut stmt = c.prepare(&format!("SELECT hash,{fields} FROM assets"))?;
    let mut unavailable = Vec::new();
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, read_asset(row, 1)?)))?;
    for row in rows {
        let (hash, mut info) = row?;
        if !valid_hash(&hash) { return msg("The document contains an invalid artwork hash."); }
        let cached = find_asset_file(&hash)?;
        let intact = cached.as_deref().is_some_and(|path| cache_has_asset(path, &hash));
        if !intact {
            let bytes: Vec<u8> = c.query_row("SELECT bytes FROM assets WHERE hash=?1", [&hash], |row| row.get(0))?;
            if hex::encode(Sha256::digest(&bytes)) != hash {
                // The cache contains derived files. Evict the corrupt entry without
                // changing the original document or suppressing its editable snapshot.
                if let Some(path) = cached {
                    if let Err(error) = fs::remove_file(path) {
                        log::warn!("Could not evict an unavailable artwork cache entry: {}", error.kind());
                    }
                }
                unavailable.push(hash);
                continue;
            }
            let mime = info.mime.get_or_insert_with(|| "application/octet-stream".into());
            let target = cached.unwrap_or_else(|| dir.join(format!("{hash}.{}", ext_for_mime(mime))));
            write_replacement(&target, &bytes, false)?;
        }
        let old = get_asset(&index, &hash)?.and_then(|row| row.generation);
        let generation = info.generation.or_else(|| asset_meta::generation(&hash, &info.meta));
        info.generation = asset_meta::combine_generation(old, generation.as_ref());
        index_asset_row(&index, &hash, &info)?;
    }
    index.commit()?;
    Ok((json, unavailable))
}

// ------------------------------------------------------------------ autosave and recovery

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutosaveFile {
    doc_id: String,
    path: Option<String>,
    saved_at: String,
    doc_json: String,
    #[serde(default)]
    base_revision: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveredDoc {
    pub recovery_key: Option<String>,
    pub doc_id: String,
    pub path: Option<String>,
    pub doc_json: String,
    pub saved_at: String,
    pub base_revision: Option<String>,
    pub conflict: Option<&'static str>,
}

pub(crate) fn recovery_file_id(doc_id: &str, path: Option<&str>) -> String {
    let Some(path) = path else { return doc_id.to_owned() };
    let canonical = crate::open_files::canonical_path(Path::new(path)).unwrap_or_else(|_| path.to_owned());
    let mut digest = Sha256::new();
    digest.update(doc_id);
    digest.update([0]);
    digest.update(canonical);
    format!("file-{}", hex::encode(digest.finalize()))
}

#[cfg(debug_assertions)]
fn autosave_doc(doc_id: &str, doc_json: &str, path: Option<String>) -> Res<()> {
    let base = path.as_deref().and_then(|path| read_doc_json(path).ok()).map(|json| document_digest(&json));
    autosave_doc_at(doc_id, doc_json, path, base)
}

fn autosave_doc_at(doc_id: &str, doc_json: &str, path: Option<String>, base_revision: Option<String>) -> Res<()> {
    if !valid_doc_id(doc_id) {
        return msg(format!("Invalid document id \"{doc_id}\""));
    }
    let key = recovery_file_id(doc_id, path.as_deref());
    let f = AutosaveFile { doc_id: doc_id.into(), path, saved_at: now_iso(), doc_json: doc_json.into(), base_revision };
    atomic_write(&paths()?.autosave.join(format!("{key}.json")), &serde_json::to_vec(&f)?)
}

fn recover_docs() -> Res<Vec<RecoveredDoc>> {
    let dir = &paths()?.autosave;
    let mut out = Vec::new();
    for entry in io(dir, fs::read_dir(dir))?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = fs::read(&p) else { continue };
        let Ok(a) = serde_json::from_slice::<AutosaveFile>(&bytes) else {
            log::warn!("ignoring unreadable autosave {}", p.display());
            continue;
        };
        let conflict = if let Some(path) = a.path.as_deref() {
            match read_doc_json(path) {
                Ok(saved) if saved == a.doc_json => {
                    let _ = fs::remove_file(&p);
                    continue;
                }
                Ok(_) if file_format(Path::new(path)).is_some_and(|version| version < FORMAT_VERSION) => Some("older-format"),
                Ok(saved) if a.base_revision.as_deref() == Some(document_digest(&saved).as_str()) => None,
                Ok(_) => Some("changed"),
                Err(_) if !Path::new(path).exists() => Some("missing"),
                Err(_) => Some("unreadable"),
            }
        } else {
            None
        };
        out.push(RecoveredDoc {
            recovery_key: p.file_stem().and_then(|name| name.to_str()).filter(|name| valid_doc_id(name)).map(str::to_owned),
            doc_id: a.doc_id, path: a.path, doc_json: a.doc_json, saved_at: a.saved_at,
            base_revision: a.base_revision, conflict,
        });
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

fn discard_recovery(doc_id: &str) -> Res<()> {
    if !valid_doc_id(doc_id) {
        return msg(format!("Invalid document id \"{doc_id}\""));
    }
    let p = paths()?.autosave.join(format!("{doc_id}.json"));
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => io(&p, Err(e)),
    }
}

pub(crate) fn discard_closed_window_recovery(key: &str) {
    if let Err(error) = discard_recovery(key) { log::warn!("Could not remove recovery for a closed window: {error}"); }
}

// ------------------------------------------------------------------ commands

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Result<T, String> {
    match tokio::task::spawn_blocking(f).await {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(e) => Err(format!("Internal error: {e}")),
    }
}

#[tauri::command]
pub async fn doc_save(
    window: tauri::WebviewWindow,
    desktop: State<'_, crate::open_files::OpenFiles>,
    state: State<'_, StoreState>,
    path: String,
    doc_json: String,
) -> Result<String, String> {
    // A newly reloaded WebView must wait for its predecessor's in-flight write.
    let io = state.window_io(window.label());
    let _guard = io.lock().await;
    let path = desktop.reserve(window.label(), &path)?;
    let destination = path.clone();
    let expected = state.expected(window.label(), &path);
    let owned = desktop.owns(window.label(), &path);
    let revision = document_digest(&doc_json);
    let result = blocking(move || {
        if owned {
            if let Some(expected) = expected.as_deref() {
                return match commit_edit(&destination, expected, &doc_json, r#"{"version":1,"kind":"checkpoint"}"#) {
                    Ok(true) => {
                        if let Some(id) = serde_json::from_str::<Value>(&doc_json)?.get("id").and_then(Value::as_str).filter(|id| valid_doc_id(id)) {
                            let _ = discard_recovery(&recovery_file_id(id, Some(&destination)));
                        }
                        Ok(())
                    }
                    Ok(false) => msg("The saved map changed outside Radiant. Use Save As to keep your edits in a separate map."),
                    Err(error) => Err(error),
                };
            }
        }
        save_doc_at(&destination, &doc_json, expected.as_deref())
    }).await;
    desktop.finish_save(window.app_handle(), window.label(), &path, result.is_ok());
    if result.is_ok() { state.remember(window.label(), path.clone(), revision); }
    result.map(|_| path)
}

#[tauri::command]
pub async fn doc_exists(path: String) -> Result<bool, String> {
    blocking(move || {
        let path = Path::new(&path);
        Ok(path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("radiant")) && path.is_file())
    }).await
}

/// Writes a new map without changing the source window's owned path or replacing an existing file.
#[tauri::command]
pub async fn doc_create(
    window: tauri::WebviewWindow,
    desktop: State<'_, crate::open_files::OpenFiles>,
    path: String,
    doc_json: String,
) -> Result<(), String> {
    let path = desktop.reserve(window.label(), &path)?;
    let output = path.clone();
    let result = blocking(move || {
        let target = Path::new(&output);
        if target.symlink_metadata().is_ok() {
            return msg("Choose a new file name for the linked branch.");
        }
        let tmp = tmp_sibling(target);
        let doc: Value = serde_json::from_str(&doc_json)?;
        if !doc.is_object() {
            return msg("The document must be a JSON object.");
        }
        let result = write_doc_file(&tmp, &doc, &doc_json, None)
            .and_then(|_| io(&tmp, fs::File::open(&tmp).and_then(|file| file.sync_all())))
            .and_then(|_| io(target, fs::hard_link(&tmp, target)))
            .and_then(|_| sync_parent(target));
        let _ = fs::remove_file(tmp);
        result
    }).await;
    desktop.finish_save(window.app_handle(), window.label(), &path, false);
    result
}

#[tauri::command]
pub async fn doc_load(window: tauri::WebviewWindow, path: String, track_base: Option<bool>, state: State<'_, StoreState>) -> Result<String, String> {
    // A newly reloaded WebView must wait for its predecessor's in-flight write.
    let io = state.window_io(window.label());
    let _guard = io.lock().await;
    let target = path.clone();
    let json = blocking(move || load_doc(&target)).await?;
    if track_base.unwrap_or(false) {
        let canonical = crate::open_files::canonical_path(Path::new(&path)).unwrap_or(path);
        state.remember(window.label(), canonical, document_digest(&json));
    }
    Ok(json)
}

#[tauri::command]
pub async fn doc_open(window: tauri::WebviewWindow, path: String, state: State<'_, StoreState>) -> Result<OpenedDocument, String> {
    let io = state.window_io(window.label());
    let _guard = io.lock().await;
    let canonical = crate::open_files::canonical_path(Path::new(&path))?;
    let opened = blocking(move || open_for_editing(&canonical)).await?;
    state.remember(window.label(), opened.path.clone(), document_digest(&opened.json));
    Ok(opened)
}

#[tauri::command]
pub fn expect_recovery_revision(window: tauri::WebviewWindow, path: String, revision: String, state: State<'_, StoreState>) -> Result<(), String> {
    if revision.len() != 64 || !valid_hash(&revision) { return Err("Invalid saved-map revision.".into()); }
    let canonical = crate::open_files::canonical_path(Path::new(&path))?;
    state.remember(window.label(), canonical, revision);
    Ok(())
}

#[tauri::command]
pub async fn doc_autosave(
    window: tauri::WebviewWindow,
    doc_id: String,
    doc_json: String,
    path: Option<String>,
    state: State<'_, StoreState>,
) -> Result<(), String> {
    let base = path.as_deref().and_then(|path| state.expected(window.label(), path));
    blocking(move || autosave_doc_at(&doc_id, &doc_json, path, base)).await
}

#[tauri::command]
pub async fn doc_commit(
    window: tauri::WebviewWindow,
    desktop: State<'_, crate::open_files::OpenFiles>,
    state: State<'_, StoreState>,
    doc_id: String,
    doc_json: String,
    path: Option<String>,
    operation_json: String,
) -> Result<bool, String> {
    if !valid_doc_id(&doc_id) { return Err("Invalid document id.".into()); }
    if serde_json::from_str::<Value>(&operation_json).ok().filter(Value::is_object).is_none() {
        return Err("Invalid edit record.".into());
    }
    // A newly reloaded WebView must wait for its predecessor's in-flight write.
    let io = state.window_io(window.label());
    let _guard = io.lock().await;
    let path = path.as_deref()
        .and_then(|path| crate::open_files::canonical_path(Path::new(path)).ok()).or(path);
    let base = path.as_deref().and_then(|path| state.expected(window.label(), path));
    let owned = path.as_deref().is_some_and(|path| desktop.owns(window.label(), path));
    let target = path.clone();
    let revision = document_digest(&doc_json);
    let committed = blocking(move || {
        if owned {
            if let (Some(path), Some(expected)) = (path.as_deref(), base.as_deref()) {
                match commit_edit(path, expected, &doc_json, &operation_json) {
                    Ok(true) => {
                        let _ = discard_recovery(&recovery_file_id(&doc_id, Some(path)));
                        return Ok(true);
                    }
                    Ok(false) => {}
                    Err(error) => log::warn!("Could not write the document journal: {error}"),
                }
            }
        }
        autosave_doc_at(&doc_id, &doc_json, path, base)?;
        Ok(false)
    }).await?;
    if committed {
        if let Some(target) = target { state.remember(window.label(), target, revision); }
    }
    Ok(committed)
}

#[tauri::command]
pub async fn doc_recover(_state: State<'_, StoreState>) -> Result<Vec<RecoveredDoc>, String> {
    blocking(recover_docs).await
}

#[tauri::command]
pub async fn doc_discard_recovery(doc_id: String, path: Option<String>, _state: State<'_, StoreState>) -> Result<(), String> {
    if !valid_doc_id(&doc_id) { return Err("Invalid document id.".into()); }
    blocking(move || discard_recovery(&recovery_file_id(&doc_id, path.as_deref()))).await
}

#[tauri::command]
pub async fn asset_put(
    bytes_base64: String,
    mime: String,
    meta: Option<AssetMeta>,
    _state: State<'_, StoreState>,
) -> Result<String, String> {
    blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(bytes_base64.trim())
            .map_err(|e| StoreError::Msg(format!("The image data is not valid base64: {e}")))?;
        put_asset_bytes(&bytes, &mime, &meta.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn asset_record(hash: String, meta: AssetMeta, _state: State<'_, StoreState>) -> Result<(), String> {
    blocking(move || {
        let Some(file) = find_asset_file(&hash)? else {
            return msg("The generated asset was not found.");
        };
        let bytes = io(&file, fs::read(&file))?;
        if hex::encode(Sha256::digest(&bytes)) != hash {
            return msg("The generated asset failed its integrity check.");
        }
        let mime = mime_for_ext(file.extension().and_then(|ext| ext.to_str()).unwrap_or(""));
        index_asset_bytes(&hash, &bytes, mime, &meta)
    })
    .await
}

#[tauri::command]
pub async fn asset_path(hash: String, _state: State<'_, StoreState>) -> Result<String, String> {
    blocking(move || match find_asset_file(&hash)? {
        Some(p) => {
            // Files written straight into the folder (for example by the AI module) are indexed lazily.
            if let Ok(c) = open_index(&paths()?.assets) {
                let known = c.query_row("SELECT 1 FROM assets WHERE hash = ?1", params![hash], |_| Ok(())).is_ok();
                if !known {
                    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("bin");
                    let mime = mime_for_ext(ext);
                    let info = AssetRow { mime: Some(mime.to_string()), ..Default::default() };
                    let _ = index_asset_row(&c, &hash, &info);
                }
            }
            Ok(p.display().to_string())
        }
        None => msg(format!("Asset {hash} was not found in the asset folder")),
    })
    .await
}

/// Return an 8-bit alpha mask in source-pixel coordinates, or no bytes when Vision has no subject.
#[tauri::command]
pub async fn asset_foreground_mask(hash: String, width: u32, height: u32) -> Result<tauri::ipc::Response, String> {
    #[cfg(target_os = "macos")]
    let bytes = blocking(move || {
        unsafe extern "C" {
            fn radiant_foreground_alpha(path: *const std::ffi::c_char, width: usize, height: usize, out: *mut u8) -> bool;
        }
        let count = u64::from(width) * u64::from(height);
        if count == 0 || count > 24_000_000 { return Ok(Vec::new()); }
        let Some(file) = find_asset_file(&hash)? else { return msg("The picture asset was not found."); };
        let path = std::ffi::CString::new(file.as_os_str().as_encoded_bytes())
            .map_err(|_| StoreError::Msg("Invalid asset path.".into()))?;
        let mut alpha = vec![0; count as usize];
        // The synchronous bridge writes at most one byte per source pixel and retains no pointers.
        if !unsafe { radiant_foreground_alpha(path.as_ptr(), width as usize, height as usize, alpha.as_mut_ptr()) } {
            alpha.clear();
        }
        Ok(alpha)
    }).await?;
    #[cfg(not(target_os = "macos"))]
    let bytes = { let _ = (hash, width, height); Vec::<u8>::new() };
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn asset_image_info(hash: String, _state: State<'_, StoreState>) -> Result<Value, String> {
    blocking(move || {
        let file = find_asset_file(&hash)?.ok_or_else(|| StoreError::Msg("The image asset was not found.".into()))?;
        let dir = &paths()?.assets;
        let mut previews = asset_meta::preview_paths(dir, &hash);
        let mime = mime_for_ext(file.extension().and_then(|ext| ext.to_str()).unwrap_or(""));
        let index = open_index(dir)?;
        let mut row = get_asset(&index, &hash)?;
        if mime.starts_with("image/") && (previews.len() < asset_meta::PREVIEW_SIZES.len() || !row.as_ref().is_some_and(|asset| asset.geometry.thumb_hash.is_some())) {
            index_asset(&hash, mime, &AssetMeta::default(), || {
                io(&file, fs::read(&file)).map(std::borrow::Cow::Owned)
            })?;
            row = get_asset(&index, &hash)?;
            previews = asset_meta::preview_paths(dir, &hash);
        }
        let geometry = row.unwrap_or_default().geometry;
        Ok(serde_json::json!({
            "path": file,
            "thumbnail": previews.get(&160),
            "thumbnails": previews,
            "thumbHash": geometry.thumb_hash.map(|hash| base64::engine::general_purpose::STANDARD.encode(hash)),
            "width": geometry.width,
            "height": geometry.height,
            "mime": mime,
        }))
    })
    .await
}

// ------------------------------------------------------------------ plain text files (import and export)

const MAX_TEXT_BYTES: u64 = 50 * 1024 * 1024;

#[cfg(debug_assertions)]
mod selftest;

fn read_text(path: String) -> Res<String> {
    {
        let p = Path::new(&path);
        if p.is_dir() {
            return msg(format!("{path} is a folder, not a file"));
        }
        let len = io(p, fs::metadata(p))?.len();
        if len > MAX_TEXT_BYTES {
            return msg(format!("{path} is too large to import ({} MB; the limit is 50 MB)", len / 1_048_576));
        }
        let bytes = io(p, fs::read(p))?;
        String::from_utf8(bytes).map_err(|_| StoreError::Msg(format!("{path} is not a UTF-8 text file")))
    }
}

#[tauri::command]
pub async fn text_read(path: String) -> Result<String, String> {
    blocking(move || read_text(path)).await
}

fn write_text(path: String, text: String) -> Res<()> {
    {
        let p = Path::new(&path);
        if p.is_dir() {
            return msg(format!("{path} is a folder, not a file"));
        }
        if text.len() as u64 > MAX_TEXT_BYTES {
            return msg("The text is too large to write (limit 50 MB)");
        }
        match p.parent() {
            Some(d) if !d.as_os_str().is_empty() && !d.is_dir() => {
                return msg(format!("The folder {} does not exist", d.display()))
            }
            _ => {}
        }
        atomic_write(p, text.as_bytes())
    }
}

#[tauri::command]
pub async fn text_write(path: String, text: String) -> Result<(), String> {
    blocking(move || write_text(path, text)).await
}

#[tauri::command]
pub async fn export_write(path: String, bytes_base64: String) -> Result<(), String> {
    blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD.decode(bytes_base64)
            .map_err(|e| StoreError::Msg(e.to_string()))?;
        atomic_write(Path::new(&path), &bytes)
    }).await
}

#[tauri::command]
pub async fn binary_read(path: String) -> Result<String, String> {
    blocking(move || {
        let input = Path::new(&path);
        let metadata = io(input, fs::metadata(input))?;
        if metadata.is_dir() && input.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("mindnode")) {
            return Ok(base64::engine::general_purpose::STANDARD.encode(mindnode::read_package(input)?));
        }
        let p = input;
        let metadata = io(p, fs::metadata(p))?;
        if !metadata.is_file() || metadata.len() > MAX_TEXT_BYTES {
            return msg("Select an import file no larger than 50 MB");
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(io(p, fs::read(p))?))
    }).await
}
