# SQLite filesystem interruption evidence

This check covers the filesystem fault-injection part of [NFR-REL-02](../../report/src/pages/quality.html#NFR-REL-02). Run `tools/verify-journal-fsync.sh` from the Radiant checkout. The wrapper compiles the production [journal module](../src-tauri/src/store/journal.rs) with bundled SQLite and the standalone [fixture VFS](../tools/journal-fsync-gate.rs) in a disposable directory.

The fixture uses separate live and durable bytes for each simulated file. SQLite writes into the live view. A file sync publishes that file's bytes, including the directory entry on the rollback journal's first sync. Deleting the rollback journal publishes its disappearance when SQLite requests a directory sync. Each interruption replays only the durable view into temporary files and reopens them with Radiant's ordinary recovery function and SQLite.

The run checks SQLite's DELETE journal mode and the production `synchronous=EXTRA` setting. On macOS it also checks that production configuration enabled `fullfsync`. Each reopen checks full `PRAGMA integrity_check`, the exact document bytes, the operation sequence and contents, and each expected journal digest. The ten transactions include document updates that grow and shrink substantially.

## Recorded result

18 November 2026 on macOS 26.5.1 arm64. All 385 interruption snapshots reopened successfully. Of those, 365 recovered the previous edit and 20 recovered the new edit.

| Interruption point | Previous edit | New edit |
| --- | ---: | ---: |
| Previous edit acknowledged | 10 | 0 |
| Rollback journal writes before flush | 131 | 0 |
| Immediately before journal sync | 20 | 0 |
| Immediately after journal sync | 20 | 0 |
| Main-file writes before flush | 144 | 0 |
| Immediately before main-file sync | 10 | 0 |
| Immediately after main-file sync | 10 | 0 |
| Immediately before rollback journal unlink | 10 | 0 |
| After unlink while directory change is unflushed | 10 | 0 |
| After rollback journal directory sync | 0 | 10 |
| New edit acknowledged | 0 | 10 |

A separate negative control discarded a main-file flush during the tested transaction. The harness failed at the journal directory sync boundary because the reopened document still contained the previous edit.

The model exercises SQLite's successful file and directory flush contract. It uses a single connection and leaves real device cache behavior, torn sectors and simultaneous filesystem writers outside this result. The separate host and WebView interruption campaigns cover their own process boundaries.
