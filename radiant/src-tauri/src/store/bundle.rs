//! Bounded I/O for a map bundle's plain JSON and content-addressed assets directory.
use super::{Res, StoreError, blocking, io, msg};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::Path;

const LIMIT: u64 = 48 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub struct BundleEntry {
    name: String,
    data: String,
}

fn asset_name(name: &str) -> bool {
    name.split_once('.').is_some_and(|(hash, ext)| {
        hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            && matches!(ext, "png" | "jpg" | "webp" | "gif" | "svg" | "bin")
    })
}

fn file_limit(name: &str) -> Option<u64> {
    match name {
        "manifest.json" => Some(4096),
        "map.json" => Some(20 * 1024 * 1024),
        _ => name.strip_prefix("assets/").filter(|name| asset_name(name)).map(|_| LIMIT),
    }
}

fn read_one(root: &Path, name: &str, remaining: &mut u64) -> Res<BundleEntry> {
    let path = root.join(name);
    let limit = file_limit(name).unwrap_or(0).min(*remaining);
    let metadata = io(&path, fs::symlink_metadata(&path))?;
    if !metadata.is_file() || metadata.len() > limit {
        return msg(format!("Invalid or oversized bundle file: {name}"));
    }
    let mut bytes = Vec::new();
    io(&path, io(&path, fs::File::open(&path))?.take(limit + 1).read_to_end(&mut bytes))?;
    if bytes.len() as u64 > limit {
        return msg(format!("Bundle file changed or exceeds the size limit: {name}"));
    }
    *remaining -= bytes.len() as u64;
    Ok(BundleEntry { name: name.into(), data: base64::engine::general_purpose::STANDARD.encode(bytes) })
}

#[tauri::command]
pub async fn bundle_read_directory(path: String) -> Result<Vec<BundleEntry>, String> {
    blocking(move || {
        let root = Path::new(&path);
        let mut remaining = LIMIT;
        let mut entries = vec![read_one(root, "manifest.json", &mut remaining)?, read_one(root, "map.json", &mut remaining)?];
        let assets = root.join("assets");
        match fs::symlink_metadata(&assets) {
            Ok(meta) if meta.is_dir() => {
                for entry in io(&assets, fs::read_dir(&assets))? {
                    let entry = io(&assets, entry)?;
                    if let Some(name) = entry.file_name().to_str().filter(|name| asset_name(name)) {
                        entries.push(read_one(root, &format!("assets/{name}"), &mut remaining)?);
                    }
                }
            }
            Ok(_) => return msg("The portable map assets directory is invalid."),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return io(&assets, Err(err)),
        }
        Ok(entries)
    }).await
}

#[tauri::command]
pub async fn bundle_write_directory(parent: String, name: String, files: Vec<BundleEntry>) -> Result<(), String> {
    blocking(move || {
        if name.trim().is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) || name.chars().any(char::is_control) {
            return msg("Invalid portable map folder name.");
        }
        let root = Path::new(&parent).join(name);
        let mut seen = HashSet::new();
        let mut remaining = LIMIT;
        let mut decoded = Vec::new();
        for file in files {
            let Some(limit) = file_limit(&file.name) else { return msg("Invalid portable map file name.") };
            let limit = limit.min(remaining);
            if file.data.len() as u64 > (limit / 3 + 1) * 4 || !seen.insert(file.name.clone()) {
                return msg("The portable map has an oversized or duplicate file.");
            }
            let data = base64::engine::general_purpose::STANDARD.decode(file.data)
                .map_err(|err| StoreError::Msg(format!("Invalid bundle data: {err}")))?;
            if data.len() as u64 > limit {
                return msg("The portable map exceeds the export size limit.");
            }
            remaining -= data.len() as u64;
            decoded.push((file.name, data));
        }
        if !seen.contains("manifest.json") || !seen.contains("map.json") {
            return msg("The portable map must include manifest.json and map.json.");
        }
        // An exclusive directory avoids replacing existing data. The manifest appears only after the assets and map.
        io(&root, fs::create_dir(&root))?;
        let assets = root.join("assets");
        let mut created = Vec::new();
        let result = (|| -> Res<()> {
            io(&assets, fs::create_dir(&assets))?;
            decoded.sort_by_key(|(name, _)| name == "manifest.json");
            for (name, data) in decoded {
                let path = root.join(name);
                let mut file = io(&path, fs::OpenOptions::new().write(true).create_new(true).open(&path))?;
                created.push(path.clone());
                io(&path, file.write_all(&data))?;
                io(&path, file.sync_all())?;
            }
            Ok(())
        })();
        if result.is_err() {
            for path in created { let _ = fs::remove_file(path); }
            let _ = fs::remove_dir(assets);
            let _ = fs::remove_dir(root);
        }
        result
    }).await
}
