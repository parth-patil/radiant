# radiant command reference

`radiant COMMAND [ARGS] [--json] [--help]`. With `--json` each command writes one envelope to stdout; diagnostics go to stderr only without `--json`. `radiant COMMAND --help --json` describes arguments and flags.

| Group | Command | Does |
|---|---|---|
| Author | `build SPEC -o OUT.radiant.zip` | Build a portable bundle from a spec. `--dry-run`, `--strict`, `--replace`, `--root DIR`, `--now ISO`, `--allow-geometry`, `--assets-from MAP`. SPEC `-` reads stdin. |
| Author | `import FILE -o OUT.radiant.zip` | Markdown, text, OPML, FreeMind, JSON Canvas, Xmind, MindNode, Excalidraw, bundle or Radiant JSON; reports skipped content. |
| Author | `import FILE.excalidraw --into MAP` | Adds a drawing's elements to MAP's canvas (live, `--in-place` or `-o`). |
| Author | `export MAP --format spec\|spec-json\|json\|md\|opml\|freemind\|excalidraw [-o FILE]` | Lists what the format cannot carry; `excalidraw` writes the canvas elements. |
| Author | `apply SPEC MAP [--at NODE] [--mode merge\|replace]` | Makes the map (or a branch) match the spec by ids, as one batch. `--dry-run --show-ops` shows the plan. |
| Read | `list [DIR] [--recursive] [--long]` | Maps with title, nodes, modified time, format version. |
| Read | `get MAP [--node ID] [--depth N] [--format …] [--fields …]` | Outline with ids (default), spec, spec JSON or stored JSON. Bounded; see `truncated` and `continue`. |
| Read | `find MAP [TEXT] [--regex] [--where K=V]… [--limit N]` | Filters: task=open\|done, tag=X, has=image\|note\|link\|tags\|task\|sticker\|children\|style\|art, depth<=N, origin=ai\|user, side, folded, id, sticker. |
| Read | `node MAP ID` | Path, children, note, resolved style, stored layout box. |
| Read | `stats MAP` | Counts and shape. |
| Read | `history MAP [--source user\|ai\|agent]` | Operation-log entries, newest first. |
| Check | `validate MAP\|SPEC [--strict]` | Map structure, or spec diagnostics with line and column. |
| Check | `layout MAP\|SPEC [--node ID] [--all]` | Boxes of visible nodes and canvas elements, bounds, sides; `metrics: "approximate"`. |
| Check | `lint MAP\|SPEC [--fail-on error\|warn\|info] [--presentation NAME] [--max-edge PX]` | Document and layout lint rules; see lint-rules.md. |
| Learn | `capabilities`, `schema [spec\|ops\|doc\|report\|envelope]`, `themes [ID]`, `examples [NAME]` | The tool describes itself. |
| Edit | `edit MAP [--dry-run] [--in-place\|-o OUT] [--allow-destructive] < batch.json` | One atomic batch of ops (ops.md); one Undo step. `--ops FILE` reads the batch from a file. |
| Edit | `undo MAP --tx TX` | Reverts your own latest batch on the open, granted map. |
| Share | `mcp [--write] MAP…`, `skill-pack OUT.zip` | MCP stdio server; this skill as a ZIP. |

MAP can be a `.radiant` file, a portable bundle, a Radiant JSON export or a spec. The earlier names `markdown`, `json` and `search` still work.

## Envelope

```json
{ "ok": true, "schemaVersion": 1, "type": "build.result", "data": { "nodes": 27, "warnings": [] } }
{ "ok": false, "schemaVersion": 1, "error": { "code": "unknown_node", "exit": 3, "message": "No node \"expresso\" in …", "suggestions": ["espresso"], "hint": "radiant find … expresso" } }
```

Spec errors carry `error.diagnostics`: `{ severity, code, message, line, column, suggestions }`.

## Writing files

Files are written only where the command line names them, or under `--root`. An existing file is replaced only with `--replace`, atomically; symbolic links are refused. Reads never change a file.

Changing a map at rest: a portable bundle or Radiant JSON file changes with `--in-place` (the write flag; the file must still hold the revision that was read), or into a new file with `-o`. Deletes need `--allow-destructive`. A `.radiant` file is never written by the tool: edit it through the open app with a grant (the reply says `backend: "live"`), or write a copy with `-o`.
