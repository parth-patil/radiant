// Injected only into an isolated archived native build by check-format-compat.py.
use super::*;
use std::path::Path;

pub(super) fn run(root: &Path, specimen: &Path, mode: &str) -> Result<(), Box<dyn std::error::Error>> {
    let paths = Paths { assets: root.join("assets"), autosave: root.join("autosave") };
    fs::create_dir_all(&paths.assets)?;
    fs::create_dir_all(&paths.autosave)?;
    PATHS.set(paths).map_err(|_| "Scratch storage was already initialized")?;
    if mode == "generate" {
        generate(specimen)?;
        return Ok(());
    }
    Err("This archived writer only creates specimens".into())
}

fn generate(path: &Path) -> Res<()> {
    let png = include_bytes!("../../icons/32x32.png");
    let hash = put_asset_bytes(png, "image/png", &AssetMeta {
        prompt: Some("Historic specimen artwork".into()),
        model: Some("Compatibility fixture".into()),
        created_by: Some("user".into()),
        ..Default::default()
    })?;
    let doc = serde_json::json!({
        "version":1, "id":"history-format-corpus", "title":"Historic field guide",
        "themeId":"ocean", "seed":47231,
        "created":"2026-01-01T00:00:00Z", "modified":"2026-01-01T00:00:00Z",
        "roots":["root"], "rootInfo":{"root":{"layout":"mindmap","position":{"x":31,"y":-58}}},
        "nodes":{
            "root":{"id":"root","parent":null,"children":["photo","notes"],"text":"Historic field guide","representation":"vector"},
            "photo":{"id":"photo","parent":"root","children":[],"text":"Picture","representation":"picture",
                "imageAsset":hash,"imageAlt":"Original palette","offset":{"x":24,"y":-15},"style":{"color":"#237290","bold":true}},
            "notes":{"id":"notes","parent":"root","children":[],"text":"Journal Δ","note":"Two lines\nfor native round trips."}
        },
        "links":[{"id":"observation","from":"photo","to":"notes","label":"evidence"}]
    });
    let json = doc.to_string();
    save_doc(path.to_str().unwrap(), &json)?;
    // GENERATE_JOURNAL
    Ok(())
}
