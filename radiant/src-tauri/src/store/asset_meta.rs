use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, ImageReader};
use resvg::{tiny_skia, usvg};
use rusqlite::Connection;
use serde_json::{Value, json};

use super::{AssetMeta, Res, valid_hash};

#[derive(Default)]
pub struct Geometry {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub thumb_hash: Option<Vec<u8>>,
    pub previews: BTreeMap<u32, Vec<u8>>,
}

pub const PREVIEW_SIZES: [u32; 4] = [32, 64, 128, 160];
// Vector source size and XML node count are independent of the pixel budget.
const MAX_SVG_PREVIEW_BYTES: usize = 8 * 1024 * 1024;
const MAX_SVG_PREVIEW_NODES: u32 = 100_000;

pub fn preview_path(asset_dir: &Path, hash: &str, size: u32) -> PathBuf {
    let suffix = if size == 160 { "pm.png".to_string() } else { format!("pm.{size}.png") };
    asset_dir.join("previews").join(format!("{hash}.{suffix}"))
}

pub fn preview_paths(asset_dir: &Path, hash: &str) -> BTreeMap<u32, PathBuf> {
    PREVIEW_SIZES.into_iter().filter_map(|size| {
        let path = preview_path(asset_dir, hash, size);
        path.is_file().then_some((size, path))
    }).collect()
}

pub fn geometry(bytes: &[u8], mime: &str) -> Geometry {
    if mime == "image/svg+xml" {
        return vector_geometry(bytes).unwrap_or_default();
    }
    let Ok(reader) = ImageReader::new(Cursor::new(bytes)).with_guessed_format() else {
        return Geometry::default();
    };
    let format = reader.format();
    let Ok((width, height)) = reader.into_dimensions() else {
        return Geometry::default();
    };
    let mut geometry = Geometry {
        width: Some(width),
        height: Some(height),
        ..Default::default()
    };
    if width == 0 || height == 0 {
        return geometry;
    }
    let Some(format) = format else {
        return geometry;
    };
    if u64::from(width) * u64::from(height) > 24_000_000 {
        #[cfg(target_os = "macos")]
        set_native_preview(&mut geometry, bytes);
        return geometry;
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(width);
    limits.max_image_height = Some(height);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    if let Ok(image) = reader.decode() {
        set_previews(&mut geometry, image);
    } else {
        #[cfg(target_os = "macos")]
        set_native_preview(&mut geometry, bytes);
    }
    geometry
}

#[cfg(target_os = "macos")]
fn set_native_preview(geometry: &mut Geometry, bytes: &[u8]) {
    unsafe extern "C" {
        fn radiant_image_preview(bytes: *const u8, length: usize, side: usize,
            pixels: *mut u8, width: *mut usize, height: *mut usize) -> bool;
    }
    let side = *PREVIEW_SIZES.last().unwrap() as usize;
    let mut pixels = vec![0; side * side * 4];
    let (mut w, mut h) = (0, 0);
    // Both buffers remain valid for this synchronous call. ImageIO writes at most side² pixels.
    if unsafe { radiant_image_preview(bytes.as_ptr(), bytes.len(), side, pixels.as_mut_ptr(), &mut w, &mut h) } {
        pixels.truncate(w * h * 4);
        if let Some(rgba) = image::RgbaImage::from_raw(w as u32, h as u32, pixels) {
            set_premultiplied_previews(geometry, rgba);
        }
    }
}

fn set_previews(geometry: &mut Geometry, image: DynamicImage) {
    let mut rgba = image.into_rgba8();
    // The thumbnail filter averages each channel separately. Preweight color
    // before filtering so invisible RGB cannot tint the soft edge.
    for pixel in rgba.as_mut().chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        for component in &mut pixel[..3] {
            *component = ((u16::from(*component) * alpha + 127) / 255) as u8;
        }
    }
    set_premultiplied_previews(geometry, rgba);
}

fn set_premultiplied_previews(geometry: &mut Geometry, rgba: image::RgbaImage) {
    let image = DynamicImage::ImageRgba8(rgba);
    let preview = |size| {
        let mut pixels = image.thumbnail(size, size).into_rgba8();
        unpremultiply(pixels.as_mut());
        pixels
    };
    let pixels = preview(100);
    geometry.thumb_hash = Some(thumbhash::rgba_to_thumb_hash(
        pixels.width() as usize, pixels.height() as usize, pixels.as_raw(),
    ));
    for size in PREVIEW_SIZES {
        let mut png = Cursor::new(Vec::new());
        if preview(size).write_to(&mut png, ImageFormat::Png).is_ok() {
            geometry.previews.insert(size, png.into_inner());
        }
    }
}

fn unpremultiply(rgba: &mut [u8]) {
    for pixel in rgba.chunks_exact_mut(4) {
        let alpha = u16::from(pixel[3]);
        if alpha > 0 && alpha < 255 {
            for component in &mut pixel[..3] {
                *component = ((u16::from(*component) * 255 + alpha / 2) / alpha).min(255) as u8;
            }
        }
    }
}

fn vector_geometry(bytes: &[u8]) -> Option<Geometry> {
    if bytes.len() > MAX_SVG_PREVIEW_BYTES {
        return None;
    }
    let options = usvg::Options {
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: Box::new(|_, _, _| None),
            resolve_string: Box::new(|_, _| None),
        },
        ..Default::default()
    };
    let markup = std::str::from_utf8(bytes)
        .ok()?
        .trim_start_matches('\u{feff}');
    // Parse once with a node limit and without DTDs/entity declarations before resvg sees the tree.
    let xml = roxmltree::Document::parse_with_options(markup, roxmltree::ParsingOptions {
        nodes_limit: MAX_SVG_PREVIEW_NODES,
        ..Default::default()
    }).ok()?;
    let tree = usvg::Tree::from_xmltree(&xml, &options).ok()?;
    let size = tree.size();
    let scale = (160.0 / size.width().max(size.height())).min(1.0);
    let w = (size.width() * scale).round().clamp(1.0, 160.0) as u32;
    let h = (size.height() * scale).round().clamp(1.0, 160.0) as u32;
    let mut pixmap = tiny_skia::Pixmap::new(w, h)?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let mut rgba = pixmap.take();
    unpremultiply(&mut rgba);
    let mut geometry = Geometry {
        width: Some(size.width().round().max(1.0) as u32),
        height: Some(size.height().round().max(1.0) as u32),
        ..Default::default()
    };
    set_previews(&mut geometry, DynamicImage::ImageRgba8(image::RgbaImage::from_raw(w, h, rgba)?));
    Some(geometry)
}

const COLUMNS: &[(&str, &str)] = &[
    ("width", "INTEGER"),
    ("height", "INTEGER"),
    ("thumb_hash", "BLOB"),
    ("generation_json", "TEXT"),
];

pub fn has_columns(connection: &Connection) -> Res<bool> {
    let present = columns(connection)?;
    Ok(COLUMNS.iter().all(|(name, _)| present.contains(*name)))
}

fn columns(connection: &Connection) -> Res<BTreeSet<String>> {
    let mut statement = connection.prepare("PRAGMA table_info(assets)")?;
    let names = statement.query_map([], |row| row.get(1))?;
    Ok(names.collect::<Result<_, _>>()?)
}

pub fn migrate(connection: &Connection) -> Res<()> {
    let present = columns(connection)?;
    for (name, datatype) in COLUMNS {
        if !present.contains(*name) {
            connection.execute(
                &format!("ALTER TABLE assets ADD COLUMN {name} {datatype}"),
                [],
            )?;
        }
    }
    Ok(())
}

pub fn generation(hash: &str, meta: &AssetMeta) -> Option<Value> {
    let prompt = meta
        .prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())?;
    let parent = meta
        .parent_asset
        .as_deref()
        .filter(|parent| *parent != hash && valid_hash(parent));
    Some(json!({
        "prompt": prompt, "model": meta.model, "revisedPrompt": meta.revised_prompt,
        "seed": meta.seed, "svgSeed": meta.svg_seed, "styleVersion": meta.style_version,
        "templateVersion": meta.template_version, "generatedAt": meta.generated_at, "inputHash": meta.input_hash,
        "styleSnapshot": meta.style_snapshot, "parentAsset": parent,
        "instructions": meta.instructions, "effort": meta.effort,
        "originalAsset": meta.original_asset.as_deref().filter(|original| *original != hash && valid_hash(original))
    }))
}

pub fn generations_from_document(doc: &Value) -> BTreeMap<String, Value> {
    let mut records = BTreeMap::new();
    let Some(nodes) = doc["nodes"].as_object() else {
        return records;
    };
    for node in nodes.values() {
        for field in ["pictureArt", "svgArt", "artReference"] {
            let art = &node[field];
            let (Some(hash), Some(prompt)) = (art["assetHash"].as_str(), art["prompt"].as_str())
            else {
                continue;
            };
            if prompt.trim().is_empty() || !valid_hash(hash) {
                continue;
            }
            let snapshot = art.get("styleSnapshot").cloned().unwrap_or_else(|| json!({
                "styleId": art["styleId"], "styleVersion": art["styleVersion"], "overrides": node["artStyleOverrides"]
            }));
            let mut record = json!({
                "prompt": prompt, "model": art["model"], "revisedPrompt": art["revisedPrompt"],
                "seed": art["seed"], "svgSeed": art["svgSeed"], "styleVersion": art["styleVersion"],
                "templateVersion": art["templateVersion"], "generatedAt": art["generatedAt"], "inputHash": art["inputHash"],
                "styleSnapshot": snapshot, "parentAsset": art["parentAsset"],
                "instructions": art["instructions"], "effort": art["effort"], "originalAsset": art["originalAsset"]
            });
            records
                .entry(hash.to_string())
                .or_insert_with(|| record.clone());
            if let Some(original) = art["originalAsset"].as_str().filter(|original| *original != hash && valid_hash(original)) {
                let mut source = record.clone();
                source["originalAsset"] = Value::Null;
                records.entry(original.to_owned()).or_insert(source);
            }
            if let Some(thumb) = art["thumbnailHash"]
                .as_str()
                .filter(|thumb| *thumb != hash && valid_hash(thumb))
            {
                record["parentAsset"] = json!(hash);
                records.entry(thumb.to_owned()).or_insert(record);
            }
        }
    }
    records
}

pub fn combine_generation(preferred: Option<Value>, supplement: Option<&Value>) -> Option<Value> {
    let Some(mut primary) = preferred.filter(Value::is_object) else {
        return supplement.cloned();
    };
    if let Some(fields) = supplement.and_then(Value::as_object) {
        // Equal bytes can result from unrelated jobs. Keep their provenance separate.
        if ["prompt", "generatedAt"].iter().any(|key| {
            fields.get(*key).is_some_and(|value| !value.is_null() && !primary[*key].is_null() && primary[*key] != *value)
        }) {
            return Some(primary);
        }
        for (key, value) in fields {
            if primary[key].is_null() {
                primary[key] = value.clone();
            }
        }
    }
    Some(primary)
}
