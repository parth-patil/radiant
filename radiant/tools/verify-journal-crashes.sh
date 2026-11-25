#!/bin/sh
# Compile the application journal module in a scratch worker and interrupt real SQLite transactions.
set -eu

trials=${1:-1000}
case "$trials" in
  ''|*[!0-9]*|0) echo 'Provide a positive trial count.' >&2; exit 2 ;;
esac
project_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/radiant-journal-check.XXXXXX")
trap 'rm -rf -- "$work_dir"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$work_dir/src" "$work_dir/fixtures"
cp "$project_root/src-tauri/src/store/journal.rs" "$work_dir/src/journal.rs"
cp "$project_root/tools/journal-crash-gate.rs" "$work_dir/src/main.rs"

cat > "$work_dir/Cargo.toml" <<'TOML'
[package]
name = "radiant-journal-gate"
version = "0.1.0"
edition = "2024"

[dependencies]
rusqlite = { version = "0.41", features = ["bundled"] }
sha2 = "0.10"
hex = "0.4"
serde_json = "1"
TOML

cargo run --quiet --manifest-path "$work_dir/Cargo.toml" -- "$work_dir/fixtures" "$trials"
