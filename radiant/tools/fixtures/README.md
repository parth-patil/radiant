# Acceptance fixtures

## Codex

Run from the repository root. The replay gate runs the debug desktop binary with
an offline JSON-RPC peer in place of Codex.

```sh
cargo build --manifest-path radiant/src-tauri/Cargo.toml --offline
python3 radiant/tools/check-codex-replay.py
```

The gate reads the archived normal, schema-constrained, interrupted, and SVG
sessions from `spikes/codex-probe/logs`. The peer remaps thread and turn IDs and
compresses the recorded arrival intervals. The picture, failure, usage, process exit,
and protocol drift cases are scripted. Pass case names to select a subset.

To capture a replacement interrupted session with the real installed Codex,
run the following command. Recording requires a configured Codex account and can
consume quota. The optional `--binary` flag selects a different Codex version.

```sh
python3 spikes/codex-probe/appserver_probe.py /tmp/as3.jsonl 'List 100 facts slowly' --interrupt-after-ms 7000
python3 radiant/tools/check-codex-replay.py --recordings-dir /tmp cancel
```

Start the Vite dev server and point Browser Use at a local Chromium session to
run the editor cancellation gate. The runner prints click-to-edit timings for
ten seeded points in the recorded interrupted stream, and for a pending picture.

```sh
RADIANT_BROWSER_URL=http://127.0.0.1:1420/ browser-use < radiant/tools/check-ai-cancellation.py
```

Generate the Rust and TypeScript projections from the installed Codex JSON
schemas offline. The projections cover the messages Radiant sends and handles.
Free-form schemas, configuration, and provider extension fields remain JSON.
Use the supported Codex binary when reviewing a version bump.

```sh
python3 radiant/tools/generate-codex-protocol.py --binary codex
python3 radiant/tools/generate-codex-protocol.py --binary codex --check
```

## Generated SVG

Run the offline SVG contract gate from the repository root. Accepted fixtures
must split into one asset per node. Rejected fixtures must report the stored
error codes and affected node IDs.

```sh
bun radiant/tools/check-svg-contract.ts
```

## Generation failures

Run the offline editor acceptance in a disposable Chromium profile with the
Vite dev server running. The gate saves and reopens five fault fixtures in the
browser host, checks document structure, and edits each reopened map.

```sh
RADIANT_BROWSER_URL=http://127.0.0.1:1420/ browser-use < radiant/tools/check-generation-failures.py
```
