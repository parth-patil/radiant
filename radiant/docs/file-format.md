# Radiant file format

A `.radiant` file is a SQLite database. Identify it by `PRAGMA application_id = 0x52444e54` (RDNT). New files use SQLite `user_version = 3`. Radiant reads v1 and v2 without modifying them. Opening either for editing takes a SQLite snapshot and migrates that snapshot in a single transaction. Radiant opens a separate `(migrated).radiant` sibling, adding a number when that name is occupied. The embedded editable JSON still uses `version: 1`.

## Reading a saved map

Read `doc.json` at `id = 1` inside a read transaction. Its UTF-8 JSON contains ordered root IDs, root positions and layouts, a node dictionary, cross-connections, theme, seed and timestamps. Children are an ordered list of IDs. A root has a null parent. Every child points back to the parent that lists it. Optional fields carry notes, tags, tasks, images, sketches, alias groups, generated styles, permanent job IDs and layout preferences. Two optional top-level fields follow `modified`: `presentations` and `canvas` (described below). A map that uses neither has no such keys. The field-by-field contract is in the [editable map schema](../src/lib/core/io/radiant-map.schema.json).

| Table | Contents |
|---|---|
| `meta` | Format and app versions, document ID, title and save timestamp. |
| `doc` | One complete editable JSON snapshot. |
| `nodes` | One row per node, with its parent, fractional sibling order key, text, and node JSON excluding the `children` field. |
| `edges` | A child edge is keyed by the child ID, points from parent to child and carries an empty JSON object. A cross-connection has kind `link`, its permanent ID and its full link object. |
| `styles` | Per-node entries use kinds `node`, `generated` or `art`. Document entries use the empty owner ID and kinds `theme`, `theme_settings`, `art_theme` or `tag_colors`. Values use JSON encoding, including quotes around a theme ID. |
| `ai_jobs` | Permanent job ID and job object, including the supplied generation instructions and provenance when available. |
| `assets` | Lowercase SHA-256 content hash, MIME type, original bytes, provenance, dimensions and optional binary ThumbHash. The same bytes occupy one row regardless of reference count. The optional `generation_json` stores additional generation parameters and source metadata. |
| `operation_log` | Ordered sequence, operation JSON and lowercase SHA-256 of the exact resulting UTF-8 `doc.json` string. A newly created file may have an empty log. |

### Presentations and canvas elements

`presentations` is a non-empty list of saved storylines in list order. Each has an `id`, a `name`, ordered `steps` and optional `reveal`, `context`, `dimOpacity` (0 to 1), `motion` and `targetMinutes`. A step has an `id` unique within its presentation and names what it shows by ID: `focus` nodes, plus optional `reveal`, `hide` and canvas `elements`. It never stores camera coordinates. Steps keep IDs of nodes that were deleted, so that undoing the delete repairs them; a player ignores missing IDs and skips a step with nothing left to focus.

`canvas` holds free drawing beside the maps: `elements`, optional `bookmarks` (named views `{cx, cy, zoom}`) and an optional `grid` (`size`, `snap`). The field is absent when the canvas holds nothing. Element geometry follows Excalidraw: `x` and `y` are the top-left corner, `w` and `h` the size, `angle` is in radians about the centre, and `seed`, `roughness` and `fillStyle` fix the sketch. `kind` is one of `rect`, `ellipse`, `diamond`, `line`, `arrow`, `draw`, `text`, `note`, `frame` or `image`. Line, arrow and freehand points are a flat list relative to `(x, y)`. Array order is the stacking order inside each band; `band` places an element under (`back`) or over (`front`) the maps. An arrow end binds to a node or another element by ID. Colours are six-digit hex. An image element's `asset` is a content hash in the `assets` table. `source` keeps fields of an imported `.excalidraw` element that Radiant does not use.

A document holds at most 20,000 elements. A freehand stroke has at most 4,096 points and element text at most 8,000 UTF-8 bytes. On reading, Radiant drops elements of an unknown kind, replaces non-finite numbers, drops colours that are not six-digit hex, and clears bindings and frame references whose target is missing. Each repair is reported.

Neither field has indexed rows. Both live only in `doc.json`.

Radiant writes the snapshot, its indexed rows, asset changes and the operation record together. An edit records its kind, source, label, optional group, and forward and inverse operations. A set operation that clears an optional field carries its key in the wrapper's `deleted` list. The same applies to `docMeta` and `canvasMeta`. A `presentation` or `canvas` operation inserts or replaces the entry with its `id`, optionally at `index`; with no `value` it deletes that entry. A checkpoint can have only the journal version and kind. To verify an existing log, compare the latest result digest with the exact snapshot bytes before parsing or reformatting them. Reopen with the desktop app for full indexed-row consistency validation. For external edits, use the app's granted editing interface to keep the snapshot and its indexes consistent.

Query siblings with `WHERE parent_id = ? ORDER BY order_key` and roots with `WHERE parent_id IS NULL ORDER BY order_key`. Keys are nonempty BLOBs ordered lexicographically by unsigned bytes. Each key ends in a nonzero byte and is unique within its sibling list. Treat keys as opaque values. Inserts retain existing keys, and reorders reuse as many keys as their new order allows. Opening a v2 map rebuilds the node projection from the ordered snapshot. The saved document JSON and embedded artwork retain their earlier format.

## Standalone example

Run the SQL below on a **new empty SQLite database** with a `.radiant` extension. It creates a one-node map that opens directly in Radiant. The example uses SQLite's JSON functions.

```sql
PRAGMA application_id = 0x52444e54;
PRAGMA user_version = 3;
BEGIN IMMEDIATE;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE doc(id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
CREATE TABLE assets(hash TEXT PRIMARY KEY, mime TEXT, bytes BLOB, prompt TEXT, model TEXT,
                    revised_prompt TEXT, created_by TEXT, created_at TEXT,
                    width INTEGER, height INTEGER, thumb_hash BLOB, generation_json TEXT);
CREATE TABLE IF NOT EXISTS nodes(
    id TEXT PRIMARY KEY NOT NULL, parent_id TEXT, order_key BLOB NOT NULL, text TEXT NOT NULL,
    node_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nodes_by_parent ON nodes(parent_id, order_key);
CREATE TABLE IF NOT EXISTS edges(
    kind TEXT NOT NULL CHECK (kind IN ('child', 'link')),
    id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
    edge_json TEXT NOT NULL, PRIMARY KEY(kind, id));
CREATE INDEX IF NOT EXISTS edges_by_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS edges_by_to ON edges(to_id);
CREATE TABLE IF NOT EXISTS styles(
    kind TEXT NOT NULL, owner_id TEXT NOT NULL, style_json TEXT NOT NULL,
    PRIMARY KEY(kind, owner_id));
CREATE TABLE IF NOT EXISTS ai_jobs(
    id TEXT PRIMARY KEY NOT NULL, job_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operation_log(
    sequence INTEGER PRIMARY KEY,
    operation_json TEXT NOT NULL,
    result_json_hash TEXT NOT NULL
);
INSERT INTO meta VALUES ('format_version','3'),('app_version','0.1.0'),
    ('doc_id','ExampleMap'),('title','Example map'),('saved_at','2026-01-01T00:00:00Z');
INSERT INTO doc VALUES (1, '{"version":1,"id":"ExampleMap","title":"Example map","roots":["root"],"rootInfo":{"root":{"position":{"x":0,"y":0},"layout":"mindmap"}},"nodes":{"root":{"id":"root","parent":null,"children":[],"text":"Example map","origin":{"by":"user"}}},"links":[],"themeId":"buzan","seed":7,"created":"2026-01-01T00:00:00Z","modified":"2026-01-01T00:00:00Z"}');
INSERT INTO nodes SELECT 'root', NULL, X'80', 'Example map', json_remove(json_extract(json,'$.nodes.root'), '$.children') FROM doc;
INSERT INTO styles VALUES ('theme','','"buzan"');
COMMIT;
```

## JSON export and portable bundles

A whole-map JSON export serializes the editable snapshot. Asset fields refer to hashes. For a self-contained transfer, export a Radiant portable folder or ZIP. Its root contains `manifest.json` with `{"format":"radiant-bundle","version":1}`, `map.json` with the snapshot, and `assets/<sha256>.<extension>` for each referenced asset, including the images of canvas elements. The importer verifies the hashes and reference set when reading the bundle.
