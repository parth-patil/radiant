use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::Path;

use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use super::{Res, StoreError, io, msg};

const CONTENT_LIMIT: u64 = 16 * 1024 * 1024;
const RESOURCE_LIMIT: u64 = 12 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 50 * 1024 * 1024;
const MAX_ENTRIES: usize = 2048;

fn zip_error(error: zip::result::ZipError) -> StoreError {
    StoreError::Msg(format!("Could not read the MindNode package: {error}"))
}

fn package_entry(root: &Path, path: &Path, limit: u64) -> Res<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return io(path, Err(error)),
    };
    if !metadata.is_file() || metadata.len() > limit {
        return Ok(None);
    }
    let target = io(path, fs::canonicalize(path))?;
    if !target.starts_with(root) {
        return Ok(None);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    let file = io(&target, fs::File::open(&target))?;
    io(&target, file.take(limit + 1).read_to_end(&mut bytes))?;
    Ok((bytes.len() as u64 <= limit).then_some(bytes))
}

/// Return only the recognized document payload and direct regular attachments from the package.
pub(super) fn read_package(path: &Path) -> Res<Vec<u8>> {
    let root = io(path, fs::canonicalize(path))?;
    let classic = package_entry(&root, &root.join("contents.xml"), CONTENT_LIMIT)?;
    let mut content = Vec::new();
    let folder;
    if let Some(bytes) = classic {
        content.push(("contents.xml", bytes));
        folder = "resources";
    } else {
        for (filename, limit) in [("Metadata.json", 65_536), ("Contents.data", CONTENT_LIMIT)] {
            let Some(bytes) = package_entry(&root, &root.join(filename), limit)? else {
                return msg("The MindNode package has no readable document payload.");
            };
            content.push((filename, bytes));
        }
        folder = "Assets";
    }

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let mut total = 0u64;
    for (name, bytes) in content {
        total += bytes.len() as u64;
        zip.start_file(name, options).map_err(zip_error)?;
        io(path, zip.write_all(&bytes))?;
    }

    let resources = root.join(folder);
    if fs::symlink_metadata(&resources).is_ok_and(|meta| meta.is_dir()) {
        for (count, entry) in io(&resources, fs::read_dir(&resources))?.enumerate() {
            if count >= MAX_ENTRIES {
                return msg("The MindNode package contains too many files.");
            }
            let entry = io(&resources, entry)?;
            let name = entry.file_name();
            let Some(name) = name
                .to_str()
                .filter(|name| !name.contains(['\\', '/']) && !name.chars().any(char::is_control))
            else {
                continue;
            };
            let Some(bytes) = package_entry(&root, &entry.path(), RESOURCE_LIMIT)? else {
                continue;
            };
            total += bytes.len() as u64;
            if total > TOTAL_LIMIT {
                return msg("The MindNode package exceeds the 50 MB import limit.");
            }
            zip.start_file(format!("{folder}/{name}"), options)
                .map_err(zip_error)?;
            io(path, zip.write_all(&bytes))?;
        }
    }
    zip.finish()
        .map(|file| file.into_inner())
        .map_err(zip_error)
}

#[cfg(target_os = "macos")]
async fn rasterize_pdf(data: &[u8]) -> Result<Vec<u8>, String> {
    use std::process::Stdio;
    use std::time::Duration;
    struct Scratch(std::path::PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    if !data.starts_with(b"%PDF-") || data.len() as u64 > RESOURCE_LIMIT {
        return Err("The attachment is not a supported PDF.".into());
    }
    let temp = std::env::temp_dir().join(format!("radiant-attachment-{}", uuid::Uuid::new_v4()));
    let mut options = fs::DirBuilder::new();
    use std::os::unix::fs::DirBuilderExt;
    options.mode(0o700);
    options.create(&temp).map_err(|e| e.to_string())?;
    let temp = Scratch(temp);
    let input = temp.0.join("attachment.pdf");
    let output = temp.0.join("preview.png");
    tokio::fs::write(&input, data)
        .await
        .map_err(|e| e.to_string())?;
    let mut process = tokio::process::Command::new("/usr/bin/sips");
    process
        .args(["-s", "format", "png", "-Z", "512"])
        .arg(&input)
        .arg("--out")
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(5), process.status())
        .await
        .map_err(|_| "Rendering the PDF attachment timed out.".to_string())?
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("This PDF attachment could not be rendered.".into());
    }
    let metadata = tokio::fs::metadata(&output)
        .await
        .map_err(|e| e.to_string())?;
    if metadata.len() > RESOURCE_LIMIT {
        return Err("The PDF preview exceeds the attachment limit.".into());
    }
    tokio::fs::read(&output).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rasterize_imported_pdf(
    bytes_base64: String,
    tint: Option<String>,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use base64::{Engine, engine::general_purpose::STANDARD};
        if bytes_base64.len() as u64 > RESOURCE_LIMIT.div_ceil(3) * 4 {
            return Err("The PDF attachment exceeds the import limit.".into());
        }
        let bytes = STANDARD.decode(bytes_base64).map_err(|e| e.to_string())?;
        let png = rasterize_pdf(&bytes).await?;
        let color = tint
            .as_deref()
            .and_then(|hex| hex.strip_prefix('#'))
            .and_then(|hex| u32::from_str_radix(hex, 16).ok())
            .filter(|color| *color <= 0xffffff);
        if let Some(color) = color {
            let mut preview = image::load_from_memory_with_format(&png, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?
                .into_rgba8();
            let rgb = [(color >> 16) as u8, (color >> 8) as u8, color as u8];
            for pixel in preview.pixels_mut() {
                pixel.0[..3].copy_from_slice(&rgb);
            }
            let mut encoded = Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(preview)
                .write_to(&mut encoded, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            return Ok(STANDARD.encode(encoded.into_inner()));
        }
        Ok(STANDARD.encode(png))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (bytes_base64, tint);
        Err("PDF attachment previews require macOS.".into())
    }
}
