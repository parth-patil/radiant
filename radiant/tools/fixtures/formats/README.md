# Native SQLite compatibility corpus

These four synthetic maps were saved by the actual Rust storage writer at the commits in `manifest.json`. The tracked Git repository contains no release tags or recorded released specimen. The maps cover all three SQLite schema versions in the development history and can serve as a baseline for adding specimens from future shipped versions.

| Specimen | Archived writer | Coverage |
|---|---|---|
| `v1-initial.radiant` | `b636b3e2` | Original three-table store |
| `v1-journal.radiant` | `74edc126` | Schema v1 with a real archived journal edit |
| `v2-indexed.radiant` | `5c92d308` | First indexed schema v2 writer |
| `v3-fractional.radiant` | `2f4b0b6` | First fractional sibling-order v3 writer |

Each file includes an ordered tree, styled and manually positioned artwork, an embedded PNG with provenance, a cross-link and a multiline note. All artwork is synthetic project material. The manifest fixes the UUID-free file names and the digests of these specific archives. The writer records actual save times, so regenerated files can have different digests.

From `radiant`, run `python3 tools/check-format-compat.py` with Python 3.12 or later and the locked Cargo dependencies installed. The script builds a scratch native binary from the selected Git revision and invokes its production store directly. It checks the manifest and copies each specimen to an isolated directory. It verifies original bytes after read and legacy migration, protected Save As, collision-safe copy naming, recovery as a separate map, preservation of prior journal entries, a new journal edit, a second save and reopen, embedded bytes and provenance, and SQLite integrity. A synthetic newer-schema case confirms refusal and exact source bytes after read, edit and save attempts.

Use `python3 tools/check-format-compat.py --generate /path/to/new-directory` to regenerate with the original writers. The command builds each pinned commit in a separate source tree, injects only the minimal fixture entry point, and shares a scratch Cargo target across those builds. The gate exercises native storage without launching the desktop UI.

The gate passed on macOS 26.5.1 at `507d7ac`. All four specimens reopened and round-tripped with their artwork. The future-format, foreign application ID and damaged-page cases retained their exact bytes after refusal.

The compatibility gate also checks a database with the wrong application ID and a Radiant database with a damaged document B-tree page. Both read and editable open must explain the refusal and preserve the original file bytes.

Pass `--small-map /path/to/rss-profile/small.radiant` to include the 200-node, zero-picture reference created by `check-memory.py`. The gate copies the file, saves and reopens it, and compares the exact editable JSON. It then switches the disposable copy to SQLite WAL mode so a journal writer can commit while a reader is validating it. At revision `59f6070` all 70 opens returned complete revisions during 24 edits. The same command against the parent commit reported a mismatch between the snapshot and the operation journal.
