//! Native desktop clipboard, staged file drag-out and PDF viewer handoff.
use base64::Engine as _;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{Manager, WebviewWindow};

const MAX_BYTES: usize = 50 * 1024 * 1024;
const EXPIRY: Duration = Duration::from_secs(30 * 60);
const PREVIEW: &[u8] = include_bytes!("../icons/32x32.png");

fn decode(value: String) -> Result<Vec<u8>, String> {
    if value.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("The export is larger than 50 MB.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|err| err.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("The export is empty or larger than 50 MB.".into());
    }
    Ok(bytes)
}

fn drag_root(window: &WebviewWindow) -> Result<PathBuf, String> {
    let cache = window
        .app_handle()
        .path()
        .app_cache_dir()
        .map_err(|err| err.to_string())?;
    Ok(cache.join("drag-exports").join(window.label()))
}

#[tauri::command]
pub async fn prepare_drag_file(
    window: WebviewWindow,
    name: String,
    bytes_base64: String,
) -> Result<String, String> {
    stage_file(drag_root(&window)?, name, bytes_base64, false).await
}

async fn stage_file(base: PathBuf, name: String, bytes_base64: String, pdf: bool) -> Result<String, String> {
    if name.trim().is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name.contains(['/', '\\'])
        || name.chars().any(char::is_control)
    {
        return Err("Choose a valid export file name.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode(bytes_base64)?;
        if pdf && (!name.to_ascii_lowercase().ends_with(".pdf") || !bytes.starts_with(b"%PDF-")) {
            return Err("Prepare a PDF before opening it for printing.".into());
        }
        fs::create_dir_all(&base).map_err(|err| err.to_string())?;
        if let Ok(entries) = fs::read_dir(&base) {
            for entry in entries.flatten() {
                if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err() {
                    continue;
                }
                let expired = entry
                    .metadata()
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|updated| updated.elapsed().ok())
                    .is_some_and(|age| age > EXPIRY);
                if expired {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        let dir = base.join(&token);
        fs::create_dir(&dir).map_err(|err| err.to_string())?;
        if let Err(err) = fs::write(dir.join(name), bytes) {
            let _ = fs::remove_dir_all(dir);
            return Err(err.to_string());
        }
        Ok(token)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn open_pdf_for_print(window: WebviewWindow, name: String, bytes_base64: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let base = drag_root(&window)?;
    let token = stage_file(base.clone(), name.clone(), bytes_base64, true).await?;
    let path = base.join(token).join(name);
    window.opener().open_path(path.to_string_lossy().into_owned(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn start_drag_file(window: WebviewWindow, token: String) -> Result<(), String> {
    let token = uuid::Uuid::parse_str(&token)
        .map_err(|_| "Prepare an export before dragging it.".to_string())?;
    let dir = drag_root(&window)?.join(token.to_string());
    let path = fs::read_dir(dir)
        .ok()
        .and_then(|entries| {
            entries
                .flatten()
                .find(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        })
        .ok_or_else(|| "Prepare this export again before dragging it.".to_string())?
        .path();
    let path = path.canonicalize().map_err(|err| err.to_string())?;

    let (send, reply) = tokio::sync::oneshot::channel();
    let drag_window = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                #[cfg(target_os = "linux")]
                let native = drag_window.gtk_window().map_err(|err| err.to_string())?;
                #[cfg(target_os = "linux")]
                let target = &native;
                #[cfg(not(target_os = "linux"))]
                let target = &drag_window;
                drag::start_drag(
                    target,
                    drag::DragItem::Files(vec![path]),
                    drag::Image::Raw(PREVIEW.to_vec()),
                    |_, _| {},
                    drag::Options::default(),
                )
                .map_err(|err| err.to_string())
            })();
            let _ = send.send(result);
        })
        .map_err(|err| err.to_string())?;
    reply.await.map_err(|err| err.to_string())?
}

#[cfg(target_os = "macos")]
fn copy_to_pasteboard(
    pasteboard: &objc2_app_kit::NSPasteboard,
    png: Option<&[u8]>,
    svg: &[u8],
    html: Option<&str>,
) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSData, NSString};

    let item = NSPasteboardItem::new();
    for (mime, bytes) in [
        ("public.svg-image", Some(svg)),
        ("public.png", png),
        ("public.html", html.map(str::as_bytes)),
    ] {
        if let Some(bytes) = bytes {
            if !item.setData_forType(&NSData::with_bytes(bytes), &NSString::from_str(mime)) {
                return Err("Could not build the image clipboard item.".into());
            }
        }
    }
    let item: Retained<ProtocolObject<dyn NSPasteboardWriting>> =
        ProtocolObject::from_retained(item);
    pasteboard.clearContents();
    if !pasteboard.writeObjects(&NSArray::from_retained_slice(&[item])) {
        return Err("Could not write the image to the system clipboard.".into());
    }
    Ok(())
}

#[cfg(all(target_os = "macos", debug_assertions))]
pub(crate) fn verify_image_clipboard(png: &[u8], svg: &[u8]) -> Result<(), String> {
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::NSString;
    let pasteboard = NSPasteboard::pasteboardWithUniqueName();
    copy_to_pasteboard(&pasteboard, Some(png), svg, None)?;
    for (format, expected) in [("public.png", png), ("public.svg-image", svg)] {
        let name = NSString::from_str(format);
        if !pasteboard
            .dataForType(&name)
            .is_some_and(|data| data.to_vec() == expected)
        {
            return Err(format!(
                "The private native pasteboard did not preserve {format}."
            ));
        }
    }
    let html = vector_clipboard_html(svg);
    copy_to_pasteboard(&pasteboard, None, svg, Some(&html))?;
    let vector_html = NSString::from_str("public.html");
    if !pasteboard
        .dataForType(&vector_html)
        .is_some_and(|data| data.to_vec() == html.as_bytes())
        || pasteboard.dataForType(&NSString::from_str("public.png")).is_some()
    {
        return Err("The private vector clipboard did not retain HTML without PNG.".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn write_image_clipboard(
    window: WebviewWindow,
    png_base64: String,
    svg_base64: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, png_base64, svg_base64);
        Err("Native PNG and SVG clipboard support is available on macOS.".into())
    }
    #[cfg(target_os = "macos")]
    {
        let png = decode(png_base64)?;
        let svg = decode(svg_base64)?;
        if !png.starts_with(b"\x89PNG\r\n\x1a\n") || !svg.starts_with(b"<svg ") {
            return Err("The image export is not a PNG and SVG pair.".into());
        }
        write_system_image(window, Some(png), svg, None).await
    }
}


#[cfg(target_os = "macos")]
fn vector_clipboard_html(svg: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(svg);
    format!(r#"<html><body><img alt="Radiant map branch" src="data:image/svg+xml;base64,{encoded}"></body></html>"#)
}

#[tauri::command]
pub async fn write_vector_clipboard(window: WebviewWindow, svg_base64: String) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, svg_base64);
        Err("Native vector clipboard support is available on macOS.".into())
    }
    #[cfg(target_os = "macos")]
    {
        let svg = decode(svg_base64)?;
        if !svg.starts_with(b"<svg ") {
            return Err("The image export is not an SVG.".into());
        }
        let html = vector_clipboard_html(&svg);
        write_system_image(window, None, svg, Some(html)).await
    }
}


#[cfg(target_os = "macos")]
async fn write_system_image(
    window: WebviewWindow,
    png: Option<Vec<u8>>,
    svg: Vec<u8>,
    html: Option<String>,
) -> Result<(), String> {
    let (send, reply) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let pasteboard = objc2_app_kit::NSPasteboard::generalPasteboard();
            let _ = send.send(copy_to_pasteboard(&pasteboard, png.as_deref(), &svg, html.as_deref()));
        })
        .map_err(|err| err.to_string())?;
    reply.await.map_err(|err| err.to_string())?
}
