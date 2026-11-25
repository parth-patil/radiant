use super::{blocking, read_doc_json, StoreError};
use serde::Serialize;
use std::{fs, time::UNIX_EPOCH};

#[derive(Serialize)]
pub struct FolderMap {
    path: String,
    name: String,
    modified: Option<u64>,
}

#[tauri::command]
pub async fn list_map_folder(folder: String) -> Result<Vec<FolderMap>, String> {
    blocking(move || {
        let entries = fs::read_dir(&folder)
            .map_err(|source| StoreError::Io { path: folder, source })?;
        let mut maps = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|error| StoreError::Msg(error.to_string()))?;
            let path = entry.path();
            if !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("radiant")) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else { continue };
            if !meta.is_file() { continue; }
            maps.push(FolderMap {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                modified: meta.modified().ok().and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                    .and_then(|v| v.as_millis().try_into().ok()),
            });
        }
        maps.sort_by_key(|map| map.name.to_lowercase());
        Ok(maps)
    }).await
}

#[tauri::command]
pub async fn preview_map_json(path: String) -> Result<String, String> {
    blocking(move || read_doc_json(&path)).await
}
