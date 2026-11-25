#!/usr/bin/env python3
"""Generate archived-format specimens or verify them with Radiant's native storage paths."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parents[1]
CORPUS = TOOLS / "fixtures/formats"
SOURCES = {
    "v1-initial.radiant": "b636b3e",
    "v1-journal.radiant": "74edc12",
    "v2-indexed.radiant": "5c92d30",
    "v3-fractional.radiant": "2f4b0b6",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build(work, revision, target, generating):
    tree = Path(tempfile.mkdtemp(prefix="tree-", dir=work))
    archive = git("archive", revision, "radiant")
    with tarfile.open(fileobj=io.BytesIO(archive)) as entries:
        entries.extractall(tree, filter="data")
    native = tree / "radiant/src-tauri"
    (native / "dist").mkdir(exist_ok=True)
    store = native / "src/store/mod.rs"
    driver = (TOOLS / "format-compat-gate.rs").read_text()
    if not generating:
        driver = driver.replace('    Err("This archived writer only creates specimens".into())',
                                "    verify(root, specimen, mode)")
        driver += (TOOLS / "format-compat-verify.rs").read_text()
    journal = ""
    if generating and revision == git("rev-parse", "74edc12").decode().strip():
        journal = '''let updated = json.replace("Journal Δ", "Journal Δ (historical edit)");
    if !commit_edit(path.to_str().unwrap(), &document_digest(&json), &updated, r#"{"version":1,"kind":"apply","label":"Historical edit"}"#)? {
        return msg("The archived writer refused its own journal edit.");
    }'''
    (store.parent / "compat_gate.rs").write_text(driver.replace("// GENERATE_JOURNAL", journal))
    store.write_text(store.read_text() + """
mod compat_gate;
pub(crate) fn run_compat_gate() {
    let args: Vec<_> = std::env::args_os().collect();
    let root = std::path::Path::new(&args[2]);
    let specimen = std::path::Path::new(&args[3]);
    if let Err(error) = compat_gate::run(root, specimen, &args[1].to_string_lossy()) {
        eprintln!("Compatibility gate failed: {error}");
        std::process::exit(1);
    }
}
""")
    lib = native / "src/lib.rs"
    lib.write_text(lib.read_text() + "\npub fn run_compat_gate() { store::run_compat_gate(); }\n")
    (native / "src/main.rs").write_text("fn main() { radiant_lib::run_compat_gate() }\n")
    with (tree / "build.log").open("w") as output:
        result = subprocess.run(
            ["cargo", "build", "--offline", "--locked", "--bin", "radiant", "--manifest-path", native / "Cargo.toml"],
            env={**os.environ, "CARGO_TARGET_DIR": str(target), "CARGO_PROFILE_DEV_DEBUG": "0"},
            stdout=output, stderr=subprocess.STDOUT, check=False,
        )
    if result.returncode:
        raise RuntimeError(f"Native build failed. Read {tree / 'build.log'}")
    return target / ("debug/radiant.exe" if os.name == "nt" else "debug/radiant")


def run(binary, work, specimen, mode):
    root = Path(tempfile.mkdtemp(prefix=mode + "-", dir=work))
    path = root / specimen.name
    if mode != "generate":
        shutil.copyfile(specimen, path)
    subprocess.run([binary, mode, root, path], check=True)
    return path


def schema(path):
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
        app = db.execute("PRAGMA application_id").fetchone()[0]
        version = db.execute("PRAGMA user_version").fetchone()[0]
    if app != 0x52444E54:
        raise RuntimeError(f"{path.name} has the wrong SQLite application identifier")
    return version


def generate(work, target, output):
    if output.exists():
        raise RuntimeError("Choose an unused output directory")
    output.mkdir()
    rows = []
    for name, ref in SOURCES.items():
        revision = git("rev-parse", ref).decode().strip()
        binary = build(work, revision, target, generating=True)
        path = run(binary, work, Path(name), "generate")
        specimen = output / name
        shutil.copyfile(path, specimen)
        rows.append({"file": name, "schema": schema(specimen), "source": revision, "sha256": digest(specimen)})
        print(f"Generated {name} with {revision[:8]}", flush=True)
    (output / "manifest.json").write_text(json.dumps(rows, indent=2) + "\n")


def verify(work, target, revision, small_map):
    binary = build(work, revision, target, generating=False)
    rows = json.loads((CORPUS / "manifest.json").read_text())
    for item in rows:
        specimen = CORPUS / item["file"]
        if schema(specimen) != item["schema"] or digest(specimen) != item["sha256"]:
            raise RuntimeError(f"Corpus specimen changed: {specimen.name}")
        run(binary, work, specimen, "verify")
        print(f"Verified read-only hash, editing target, round trip and artwork: {specimen.name}", flush=True)
    latest = max(rows, key=lambda row: row["schema"])
    future = work / "future.radiant"
    shutil.copyfile(CORPUS / latest["file"], future)
    with sqlite3.connect(future) as db:
        db.execute(f"PRAGMA user_version={latest['schema'] + 100}")
    refused = run(binary, work, future, "future")
    if digest(refused) != digest(future):
        raise RuntimeError("The future specimen hash changed")
    print("Verified future-format refusal and source hash", flush=True)

    foreign = work / "wrong-application.radiant"
    shutil.copyfile(CORPUS / latest["file"], foreign)
    with sqlite3.connect(foreign) as db:
        db.execute("PRAGMA application_id=42")
    run(binary, work, foreign, "foreign")

    damaged = work / "damaged.radiant"
    shutil.copyfile(CORPUS / latest["file"], damaged)
    with sqlite3.connect(damaged) as db:
        page = db.execute("SELECT rootpage FROM sqlite_schema WHERE name='doc'").fetchone()[0]
        page_size = db.execute("PRAGMA page_size").fetchone()[0]
    # Keep the Radiant header intact and damage the document table's B-tree page.
    with damaged.open("r+b") as output:
        output.seek((page - 1) * page_size)
        output.write(b"\x00")
    run(binary, work, damaged, "damaged")
    print("Verified wrong-application and damaged-page refusals and unchanged bytes", flush=True)

    if small_map:
        run(binary, work, small_map.resolve(strict=True), "small")
        print("Verified the 200-node reference round trip and concurrent journal reads", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generate", type=Path, help="Write freshly generated historic specimens to a new directory")
    parser.add_argument("--revision", default="HEAD", help="Tracked app revision to verify")
    parser.add_argument("--target", type=Path, help="Existing dedicated Cargo target for this gate")
    parser.add_argument("--small-map", type=Path, help="Also exercise the 200-node saved reference from check-memory.py")
    args = parser.parse_args()
    work = Path(tempfile.mkdtemp(prefix="radiant-format-compat-"))
    print("Artifacts:", work, flush=True)
    target = args.target.resolve() if args.target else work / "target"
    if args.generate:
        generate(work, target, args.generate.resolve())
    else:
        verify(work, target, git("rev-parse", args.revision).decode().strip(), args.small_map)


if __name__ == "__main__":
    main()
