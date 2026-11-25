//! Debug-only self-test: `cargo run -- --store-selftest`. Uses a temporary directory; prints to stderr.
use super::*;

pub fn run(base: &Path) -> bool {
    let mut failed = 0;
    let mut check = |name: &str, ok: bool, detail: String| {
        eprintln!("[store-selftest] {} {name}{}", if ok { "PASS" } else { "FAIL" }, if ok { String::new() } else { format!(": {detail}") });
        if !ok {
            failed += 1;
        }
    };
    let example = (|| -> Res<()> {
        let format = include_str!("../../../docs/file-format.md");
        let sql = format.split_once("```sql\n").and_then(|(_, block)| block.split_once("\n```"))
            .map(|(sql, _)| sql).ok_or_else(|| StoreError::Msg("Missing documented SQL example".into()))?;
        let path = base.join("Documented example.radiant");
        let database = Connection::open(&path)?;
        database.execute_batch(sql)?;
        drop(database);
        let json = load_doc(&path.to_string_lossy())?;
        let doc: Value = serde_json::from_str(&json)?;
        if doc["nodes"]["root"]["text"] != "Example map" { return msg("Documented example lost its root"); }
        Ok(())
    })();
    check("open the published SQLite format example", example.is_ok(),
          example.err().map(|e| e.to_string()).unwrap_or_default());
    let png = |tag: u8| -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&[tag; 32]);
        v
    };
    let h1 = put_asset_bytes(&png(1), "image/png", &AssetMeta { prompt: Some("a cat".into()), created_by: Some("ai".into()), ..Default::default() });
    let h2 = put_asset_bytes(&png(2), "image/png", &AssetMeta::default());
    let (Ok(h1), Ok(h2)) = (h1, h2) else {
        eprintln!("[store-selftest] FAIL asset_put");
        return false;
    };
    check("asset_put returns 64 hex chars", h1.len() == 64 && valid_hash(&h1) && h1 != h2, h1.clone());
    check("asset_put is idempotent", put_asset_bytes(&png(1), "image/png", &AssetMeta::default()).ok().as_deref() == Some(h1.as_str()), String::new());
    check("invalid hash rejected", find_asset_file("../etc/passwd").is_err(), String::new());

    let doc = serde_json::json!({
        "version": 1, "id": "doc-abc_1", "title": "Self test", "roots": ["a"], "rootInfo": {}, "links": [],
        "nodes": {
            "a": {"id": "a", "parent": null, "children": ["b"], "text": "Root", "imageAsset": h1},
            "b": {"id": "b", "parent": "a", "children": [], "text": "Child", "imageAsset": h2}
        }
    });
    let doc_json = doc.to_string();
    let file = base.join("test.radiant");
    let fp = file.display().to_string();

    // autosave and recovery (before the save, so the file does not exist yet)
    check("autosave writes", autosave_doc("doc-abc_1", &doc_json, Some(fp.clone())).is_ok(), String::new());
    let rec = recover_docs().unwrap_or_default();
    check("recover lists the autosave", rec.len() == 1 && rec[0].doc_id == "doc-abc_1" && rec[0].doc_json == doc_json, format!("{} entries", rec.len()));

    let r = save_doc(&fp, &doc_json);
    check("save", r.is_ok(), format!("{:?}", r.err().map(|e| e.to_string())));
    check("autosave removed after save", !paths().unwrap().autosave.join("doc-abc_1.json").exists(), String::new());
    check("recover empty after save", recover_docs().map(|v| v.is_empty()).unwrap_or(false), String::new());
    let leftovers = fs::read_dir(base).map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".tmp")).count()).unwrap_or(99);
    check("no temp files left", leftovers == 0, leftovers.to_string());

    // pragmas and tables
    if let Ok(c) = Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        let aid: i64 = c.pragma_query_value(None, "application_id", |r| r.get(0)).unwrap_or(-1);
        let uv: i64 = c.pragma_query_value(None, "user_version", |r| r.get(0)).unwrap_or(-1);
        check("application_id", aid == APPLICATION_ID, aid.to_string());
        check("user_version", uv == FORMAT_VERSION, uv.to_string());
        let n: i64 = c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0)).unwrap_or(-1);
        check("two assets embedded", n == 2, n.to_string());
        let title: String = c.query_row("SELECT value FROM meta WHERE key='title'", [], |r| r.get(0)).unwrap_or_default();
        check("meta title", title == "Self test", title);
    } else {
        check("open saved file", false, "cannot open".into());
    }

    // load, compare
    match load_doc(&fp) {
        Ok(j) => check("load returns identical JSON", j == doc_json, j),
        Err(e) => check("load", false, e.to_string()),
    }

    // delete one asset and reload: it must be re-extracted
    let victim = find_asset_file(&h1).ok().flatten();
    if let Some(v) = &victim {
        let _ = fs::remove_file(v);
    }
    check("asset deleted", find_asset_file(&h1).ok().flatten().is_none(), String::new());
    let r = load_doc(&fp);
    check("load after delete", r.is_ok(), format!("{:?}", r.err().map(|e| e.to_string())));
    let restored = find_asset_file(&h1).ok().flatten();
    check("asset re-extracted", restored.as_ref().is_some_and(|p| fs::read(p).ok().as_deref() == Some(&png(1)[..])), format!("{restored:?}"));
    // re-saving after a load keeps metadata
    if let Ok(c) = open_index(&paths().unwrap().assets) {
        let p: Option<String> = c.query_row("SELECT prompt FROM assets WHERE hash=?1", params![h1], |r| r.get(0)).ok().flatten();
        check("asset metadata survives", p.as_deref() == Some("a cat"), format!("{p:?}"));
    }

    // lazily indexed file written directly into the folder
    let raw = png(9);
    let h3 = hex::encode(Sha256::digest(&raw));
    let _ = fs::write(paths().unwrap().assets.join(format!("{h3}.png")), &raw);
    let doc3 = serde_json::json!({
        "version": 1, "id": "d3", "title": "Lazy asset", "roots": ["a"],
        "rootInfo": {"a": {"position": {"x": 0, "y": 0}, "layout": "mindmap"}},
        "links": [], "themeId": "clean", "seed": 1,
        "created": "2026-01-01T00:00:00Z", "modified": "2026-01-01T00:00:00Z",
        "nodes": {"a": {"id": "a", "parent": null, "children": [], "text": "Root", "imageAsset": h3}}
    }).to_string();
    let f3 = base.join("lazy.radiant").display().to_string();
    let result = save_doc(&f3, &doc3);
    check("save with un-indexed asset", result.is_ok(), result.err().map(|e| e.to_string()).unwrap_or_default());
    let n: i64 = Connection::open(&f3).and_then(|c| c.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get(0))).unwrap_or(-1);
    check("un-indexed asset embedded", n == 1, n.to_string());

    // Real raster and vector artwork referenced through the representation metadata.
    let raster = include_bytes!("../../icons/32x32.png");
    let vector = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60"><g id="node-b"><circle cx="40" cy="30" r="25" fill="#26a49c"/></g></svg>"##;
    let raster_hash = put_asset_bytes(raster, "image/png", &AssetMeta {
        prompt: Some("Raster fixture".into()), model: Some("Fixture model".into()),
        created_by: Some("ai".into()), seed: Some(42),
        style_snapshot: Some(serde_json::json!({"palette":["#26a49c"]})),
        ..Default::default()
    }).unwrap();
    let svg_hash = put_asset_bytes(vector, "image/svg+xml", &AssetMeta { prompt: Some("SVG fixture".into()), ..Default::default() }).unwrap();
    let mut mixed_doc = serde_json::json!({
        "version": 1, "id": "mixed-artwork", "title": "Mixed artwork", "roots": ["a"],
        "rootInfo": {"a": {"position": {"x": 0, "y": 0}, "layout": "mindmap"}},
        "links": [{"id":"connection","from":"a","to":"b","label":"illustrates"}],
        "themeId": "clean", "aiJobs": {"fixture-job": {"kind":"generate","status":"done","prompt":"Fixture topic","created":"2026-01-01T00:00:00Z"}},
        "nodes": {
            "a": {"id":"a","parent":null,"children":["b"],"text":"Photo","representation":"picture","style":{"color":"#26a49c"},"pictureArt":{"assetHash":raster_hash,"prompt":"Raster fixture"}},
            "b": {"id":"b","parent":"a","children":[],"text":"Vector","representation":"svg","svgArt":{"assetHash":svg_hash,"prompt":"SVG fixture"}}
        }
    });
    for n in 1..10 {
        let id = format!("same-picture-{n}");
        mixed_doc["nodes"]["a"]["children"].as_array_mut().unwrap().push(serde_json::json!(id));
        mixed_doc["nodes"][&id] = serde_json::json!({
            "id":id,"parent":"a","children":[],"text":"Duplicate asset","imageAsset":raster_hash
        });
    }
    let mixed = mixed_doc.to_string();
    let mixed_path = base.join("mixed-artwork.radiant").display().to_string();
    check("save real mixed artwork", save_doc(&mixed_path, &mixed).is_ok(), String::new());
    for asset in [&raster_hash, &svg_hash] {
        if let Ok(Some(path)) = find_asset_file(asset) {
            let _ = fs::remove_file(path);
        }
    }
    check("reopen bundled mixed map", load_doc(&mixed_path).ok().as_deref() == Some(&mixed), String::new());
    for (hash, original) in [(&raster_hash, raster.as_slice()), (&svg_hash, vector.as_slice())] {
        let restored = find_asset_file(hash).ok().flatten().and_then(|path| fs::read(path).ok());
        check("restored real artwork matches its original bytes", restored.as_deref() == Some(original), hash.clone());
    }
    if let Ok(c) = Connection::open(&mixed_path) {
        let counts = c.query_row("SELECT (SELECT COUNT(*) FROM nodes),(SELECT COUNT(*) FROM edges),
            (SELECT COUNT(*) FROM styles),(SELECT COUNT(*) FROM ai_jobs),(SELECT COUNT(*) FROM assets)",
            [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?, row.get::<_, i64>(4)?))).ok();
        check("normalized rows and ten shared pictures use one raster asset", counts == Some((11, 11, 2, 1, 2)), format!("{counts:?}"));
        for (hash, size) in [(&raster_hash, (32, 32)), (&svg_hash, (80, 60))] {
            let row = get_asset(&c, hash).ok().flatten();
            check("asset stores dimensions, a valid ThumbHash and generation record",
                row.is_some_and(|asset| asset.geometry.width.zip(asset.geometry.height) == Some(size)
                    && asset.geometry.thumb_hash.is_some_and(|thumb| thumbhash::thumb_hash_to_rgba(&thumb).is_ok())
                    && asset.generation.is_some_and(|value| value["prompt"].is_string() &&
                        (hash == &svg_hash || value["seed"] == 42 &&
                            value["model"] == "Fixture model" && value["styleSnapshot"]["palette"][0] == "#26a49c"))),
                hash.clone());
        }
    }
    let legacy = base.join("legacy-v1.radiant");
    let legacy_path = legacy.to_string_lossy();
    let legacy_ok = fs::copy(&mixed_path, &legacy).is_ok() && Connection::open(&legacy).is_ok_and(|c|
        c.execute_batch("DROP TABLE nodes; DROP TABLE edges; DROP TABLE styles; DROP TABLE ai_jobs;
            ALTER TABLE assets RENAME TO v2_assets;
            CREATE TABLE assets(hash TEXT PRIMARY KEY, mime TEXT, bytes BLOB, prompt TEXT, model TEXT,
                revised_prompt TEXT, created_by TEXT, created_at TEXT);
            INSERT INTO assets SELECT hash,mime,bytes,prompt,model,revised_prompt,created_by,created_at FROM v2_assets;
            DROP TABLE v2_assets; PRAGMA user_version=1;
            UPDATE meta SET value='1' WHERE key='format_version';").is_ok());
    check("legacy v1 map opens unchanged", legacy_ok && load_doc(&legacy_path).ok().as_deref() == Some(&mixed), String::new());
    let original = fs::read(&legacy);
    let opened = open_for_editing(&legacy_path);
    mixed_doc["title"] = serde_json::json!("Migrated title");
    mixed_doc["nodes"]["a"]["text"] = serde_json::json!("Edited");
    let updated = mixed_doc.to_string();
    check("legacy original cannot receive an edit", matches!(
        commit_edit(&legacy_path, &document_digest(&mixed), &updated, "{}"), Ok(false)), String::new());
    if let Ok(opened) = opened {
        let advance = commit_edit(&opened.path, &document_digest(&mixed), &updated, "{}");
        check("legacy copy migrates intact and journals one operation", opened.migrated && opened.json == mixed &&
            advance.as_ref().is_ok_and(|saved| *saved) &&
            original.ok().is_some_and(|bytes| fs::read(&legacy).ok() == Some(bytes)) &&
            load_doc(&opened.path).ok().as_deref() == Some(&updated) &&
            Connection::open(&opened.path).is_ok_and(|c| {
                let row = c.query_row("SELECT (SELECT text FROM nodes WHERE id='a'),
                    (SELECT value FROM meta WHERE key='title'), (SELECT COUNT(*) FROM operation_log)",
                    [], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)));
                row.ok() == Some(("Edited".into(), "Migrated title".into(), 1))
            }), format!("{advance:?}"));
        let tampered = Connection::open(&opened.path).is_ok_and(|c| c.execute("UPDATE nodes SET text='tampered' WHERE id='a'", []).is_ok());
        check("inconsistent indexed node is rejected", tampered && load_doc(&opened.path).is_err(), String::new());
        let future = Connection::open(&opened.path).is_ok_and(|c| c.pragma_update(None, "user_version", FORMAT_VERSION + 1).is_ok());
        check("future format rejected", future && load_doc(&opened.path).is_err_and(|error| error.to_string().contains("newer version")), String::new());
    } else {
        check("legacy copy migrates intact and journals one operation", false, opened.err().unwrap().to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let clipboard = crate::native_interop::verify_image_clipboard(raster, vector);
        check("native pasteboard retains PNG and SVG", clipboard.is_ok(), clipboard.err().unwrap_or_default());
    }

    let package = base.join("fixture.mindnode");
    let resources = package.join("resources");
    let package_initialized = fs::create_dir_all(&resources).is_ok()
        && fs::write(package.join("contents.xml"), b"fixture-content").is_ok()
        && fs::write(resources.join("picture.png"), raster).is_ok();
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(base.join("test.radiant"), resources.join("outside.png"));
    let package_ok = package_initialized && mindnode::read_package(&package).is_ok_and(|bytes| {
        let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(bytes)) else { return false };
        if archive.len() != 2 || archive.by_name("contents.xml").is_err() { return false; }
        let Ok(mut attachment) = archive.by_name("resources/picture.png") else { return false };
        use std::io::Read;
        let mut extracted = Vec::new();
        attachment.read_to_end(&mut extracted).is_ok() && extracted == raster
    });
    check("native MindNode package keeps embedded image bytes and ignores symlinks", package_ok, String::new());

    // non-Radiant files
    let other = base.join("other.radiant");
    if let Ok(c) = Connection::open(&other) {
        let _ = c.execute_batch("CREATE TABLE t(x);");
    }
    let e = load_doc(&other.display().to_string()).err().map(|e| e.to_string()).unwrap_or_default();
    check("foreign SQLite rejected", e.contains("not a Radiant document"), e);
    let txt = base.join("plain.radiant");
    let _ = fs::write(&txt, "hello, I am not a database, just some text that is long enough to look odd");
    let e = load_doc(&txt.display().to_string()).err().map(|e| e.to_string()).unwrap_or_default();
    check("text file rejected", e.contains("not a Radiant document"), e);
    let e = load_doc(&base.join("missing.radiant").display().to_string()).err().map(|e| e.to_string()).unwrap_or_default();
    check("missing file message", e.contains("does not exist"), e);
    let e = save_doc(&base.join("nodir/x.radiant").display().to_string(), &doc_json).err().map(|e| e.to_string()).unwrap_or_default();
    check("save into missing folder message", e.contains("does not exist"), e);
    let e = save_doc(&fp, "{not json").err().map(|e| e.to_string()).unwrap_or_default();
    check("invalid JSON rejected", e.contains("not valid JSON"), e);
    check("failed save keeps old file", load_doc(&fp).is_ok(), String::new());

    // text files
    let t = base.join("t.md").display().to_string();
    let body = "# Héllo\n- 日本語\n".to_string();
    check("text_write", write_text(t.clone(), body.clone()).is_ok(), String::new());
    check("text round trip", read_text(t.clone()).ok().as_deref() == Some(body.as_str()), String::new());
    let bad = base.join("bad.txt");
    let _ = fs::write(&bad, [0xff, 0xfe, 0x00, 0x80]);
    let e = read_text(bad.display().to_string()).err().map(|e| e.to_string()).unwrap_or_default();
    check("non-UTF-8 read error", e.contains("UTF-8"), e);
    let e = read_text(base.display().to_string()).err().map(|e| e.to_string()).unwrap_or_default();
    check("directory refused", e.contains("folder"), e);

    eprintln!("[store-selftest] {}", if failed == 0 { "ALL PASSED".to_string() } else { format!("{failed} FAILED") });
    failed == 0
}
