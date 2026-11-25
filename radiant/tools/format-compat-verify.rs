fn check(condition: bool, message: &str) -> Result<(), Box<dyn std::error::Error>> {
    if condition { Ok(()) } else { Err(message.into()) }
}

type Asset = (String, Option<String>, Vec<u8>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>);

fn assets(path: &str) -> Res<Vec<Asset>> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut query = db.prepare(
        "SELECT hash,mime,bytes,prompt,model,revised_prompt,created_by,created_at FROM assets ORDER BY hash"
    )?;
    let rows = query.query_map([], |row| Ok((
        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?,
    )))?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn journal_entries(path: &str) -> Res<i64> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='operation_log')",
        [], |row| row.get(0),
    )?;
    if !exists { return Ok(0); }
    Ok(db.query_row("SELECT COUNT(*) FROM operation_log", [], |row| row.get(0))?)
}

fn verify(root: &Path, source: &Path, mode: &str) -> Result<(), Box<dyn std::error::Error>> {
    let path = source.to_str().ok_or("Invalid source path")?;
    let original = fs::read(source)?;
    if mode == "small" {
        return verify_small_map(root, path);
    }
    if let Some(reason) = match mode {
        "foreign" => Some("not a Radiant document"),
        "damaged" => Some("damaged"),
        _ => None,
    } {
        for error in [read_doc_json(path).err(), open_for_editing(path).err()] {
            let message = error.ok_or("Invalid specimen unexpectedly opened")?.to_string();
            check(message.contains(reason), &format!("Unexpected refusal: {message}"))?;
        }
        return check(fs::read(source)? == original, "Rejected source bytes changed");
    }
    let version = file_format(source).ok_or("Missing Radiant file identifier/version")?;
    let digest = document_digest(&hex::encode(&original));
    if mode == "future" {
        check(read_doc_json(path).is_err_and(|error| error.to_string().contains("newer version")), "Future read did not refuse the version")?;
        check(open_for_editing(path).is_err_and(|error| error.to_string().contains("newer version")), "Future editable open did not explain the refusal")?;
        check(!commit_edit(path, &digest, "{}", "{}")?, "A journal edit accepted a future format")?;
        check(save_doc_at(path, "{}", None).is_err(), "Save As overwrote a future document")?;
        return check(fs::read(source)? == original, "Future source bytes changed");
    }

    let initial = read_doc_json(path)?;
    let expected_assets = assets(path)?;
    let expected_journal = journal_entries(path)?;
    check(!expected_assets.is_empty(), "The specimen has no embedded artwork")?;
    check(load_doc(path)? == initial, "Read-only open changed the editable document")?;
    check(fs::read(source)? == original, "A read-only open changed source bytes")?;
    if version < FORMAT_VERSION {
        check(!commit_edit(path, &document_digest(&initial), &initial, "{}")?, "A journal edit modified the older source")?;
        check(save_doc_at(path, &initial, None).is_err(), "Save As replaced the older source")?;
        let mut unsaved: Value = serde_json::from_str(&initial)?;
        unsaved["title"] = serde_json::json!("Unsaved legacy title");
        autosave_doc_at("history-format-corpus", &unsaved.to_string(), Some(path.into()), Some(document_digest(&initial)))?;
        check(recover_docs()?.iter().any(|entry| entry.path.as_deref() == Some(path)
            && entry.conflict == Some("older-format")), "Legacy recovery would write to the original")?;
        let occupied = source.with_file_name(format!("{} (migrated).radiant", source.file_stem().unwrap().to_string_lossy()));
        fs::write(&occupied, b"Existing destination")?;
    }
    let opened = open_for_editing(path)?;
    check(opened.json == initial, "Migration changed the editable JSON")?;
    check(journal_entries(&opened.path)? == expected_journal, "Migration changed the prior operation count")?;
    check(opened.migrated == (version < FORMAT_VERSION), "Migration did not use the expected mode")?;
    check((opened.path != path) == opened.migrated, "Migration did not open a distinct path")?;
    check(file_format(Path::new(&opened.path)) == Some(FORMAT_VERSION), "The editing target format is wrong")?;
    check(fs::read(source)? == original, "Opening the editable target changed the source")?;
    if version < FORMAT_VERSION {
        let occupied = source.with_file_name(format!("{} (migrated).radiant", source.file_stem().unwrap().to_string_lossy()));
        check(fs::read(occupied)? == b"Existing destination", "Migration clobbered an existing file")?;
    }

    let mut doc: Value = serde_json::from_str(&opened.json)?;
    doc["nodes"]["notes"]["text"] = serde_json::json!("Journal entry after re-open");
    let edited = doc.to_string();
    check(commit_edit(&opened.path, &document_digest(&opened.json), &edited,
        r#"{"version":1,"kind":"apply","label":"Edit compatibility fixture"}"#)?, "The editing target rejected a journal edit")?;
    check(load_doc(&opened.path)? == edited, "Reopen did not preserve the journal edit")?;
    check(journal_entries(&opened.path)? == expected_journal + 1, "The edit did not append exactly one operation")?;
    if opened.migrated {
        check(fs::read(source)? == original, "Editing the migrated copy changed the older source")?;
    }
    let destination = root.join("roundtrip.radiant");
    let destination = destination.to_str().ok_or("Invalid destination")?;
    save_doc_at(destination, &edited, None)?;
    check(load_doc(destination)? == edited, "An explicit save/reopen changed the edited document")?;
    for path in [&opened.path, destination] {
        check(assets(path)? == expected_assets, "Embedded artwork or its provenance changed")?;
        let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let integrity: String = db.pragma_query_value(None, "integrity_check", |row| row.get(0))?;
        check(integrity == "ok", "SQLite integrity check failed")?;
    }
    Ok(())
}

fn verify_small_map(root: &Path, source: &str) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::Barrier;
    let initial = open_for_editing(source)?.json;
    let mut doc: Value = serde_json::from_str(&initial)?;
    let nodes = doc["nodes"].as_object().ok_or("Missing node collection")?;
    check(nodes.len() == 200 && referenced_assets(&doc).is_empty(), "Expected the 200-node reference with no pictures")?;
    let root_id = doc["roots"][0].as_str().ok_or("Missing root")?.to_owned();
    let copy = root.join("small-roundtrip.radiant");
    let path = copy.to_str().ok_or("Invalid destination")?;
    save_doc_at(path, &initial, None)?;
    check(load_doc(path)? == initial, "Small map changed on its first round trip")?;

    let mut revisions = vec![initial];
    for i in 1..=24 {
        doc["nodes"][&root_id]["text"] = serde_json::json!(format!("Field survey revision {i}"));
        revisions.push(doc.to_string());
    }
    // WAL permits a writer to commit while the native reader is still validating a snapshot.
    let db = Connection::open(path)?;
    db.pragma_update(None, "journal_mode", "WAL")?;
    drop(db);
    let start = Barrier::new(2);
    std::thread::scope(|scope| -> Result<(), Box<dyn std::error::Error>> {
        let writer = scope.spawn(|| -> Result<(), String> {
            start.wait();
            for pair in revisions.windows(2) {
                let saved = commit_edit(path, &document_digest(&pair[0]), &pair[1], "{}")
                    .map_err(|error| error.to_string())?;
                if !saved { return Err("Journal edit was refused".into()); }
            }
            Ok(())
        });
        start.wait();
        let mut reads = 0;
        while reads < 24 || !writer.is_finished() {
            let reopened = load_doc(path)?;
            check(revisions.contains(&reopened), "Reader observed an incomplete revision")?;
            reads += 1;
        }
        writer.join().map_err(|_| "Fixture writer stopped unexpectedly")??;
        println!("Validated {reads} complete opens against 24 concurrent journal commits");
        Ok(())
    })?;
    check(load_doc(path)? == *revisions.last().unwrap(), "Final journal revision was lost")
}
