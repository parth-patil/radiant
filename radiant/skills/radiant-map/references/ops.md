# Edit ops

`radiant edit MAP < batch.json` (and `apply`, and the live app) take one batch: `{ "label", "ifRevision", "dryRun", "client", "ops": [ … ] }`, or a bare array of ops. Bold fields are required. Any id field takes an existing id or `"@name"` for something an earlier op of the same batch created with `"ref": "name"`. `radiant schema ops --json` prints the JSON Schema generated from the same table the tool validates with.

| Op | Fields | Tier | Does |
|---|---|---|---|
| add | **parent**, **text**, index, ref, id, note, style, sticker, tags, task, link, side, folded | write | Add a child node. |
| add-tree | **parent**, index, ref, **spec** | write | Insert a branch written as a spec fragment (Markdown outline with attributes, or nested JSON nodes). |
| add-root | **text**, layout, spacing, organic, position, ref, id, note, style | write | Add a root (a new map on the canvas). |
| set-text | **id**, **text** | write | Change a label. |
| set-note | **id**, **note** | write | Set or clear a note. |
| set-style | **ids**, **style** | write | Merge a style patch into nodes (null clears a key). |
| set | **id**, **patch** | write | Set node fields: sticker, tags, task, link, collapsed, side, branchLayout, image, alt, scale, offset. |
| move | **id**, **parent**, index | write | Move a node and its subtree under another parent. |
| reorder | **id**, delta, index | write | Move a node among its siblings by delta or to an index. |
| delete | **ids** | destructive | Delete whole subtrees, leaves first. |
| duplicate | **id**, ref | write | Copy a subtree next to the original. |
| fold | **ids**, folded, depth, all | write | Fold or unfold nodes, or show a number of levels below them. |
| link | **from**, **to**, label, dash, arrows, color, ref, id | write | Add a cross-link. |
| unlink | **id** | destructive | Remove a cross-link. |
| link-style | **id**, dash, arrows, color, bend | write | Change a cross-link's dash, arrows, colour or bend (null clears). |
| link-label | **id**, **label** | write | Set or clear a cross-link label. |
| set-root | **id**, layout, spacing, organic, position | write | Change a root's layout, spacing, organic look or position. |
| doc | title, theme, themeSettings, tagColors, seed | write | Change the title, theme, theme settings, tag colours or seed. |
| presentation-set | id, ref, name, reveal, context, dimOpacity, motion, targetMinutes, steps, auto, addSteps, at | write | Create a presentation or change one: name, options, all steps, or steps to insert. |
| presentation-delete | **id** | destructive | Delete a presentation. |
| canvas-add | **element**, ref, index | write | Add a canvas element (shape, note, text, frame, line, arrow, drawing or picture). |
| canvas-set | **id**, **patch** | write | Change a canvas element's fields (null clears; id and kind never change). |
| canvas-order | **ids**, to, band | write | Restack canvas elements, or move them to the band under or over the maps. |
| canvas-delete | **ids** | destructive | Delete canvas elements. |

Details:

- **style** (add, add-root, set-style): NodeStyle fields or their spec names: `color`, `textColor`/`text`, `fillColor`/`fill`, `fontFamily`/`font`, `alignment`/`align`, `branchWidth`/`width`, `fontSize`/`size`, `bold`, `italic`, `curvedLabel`/`curved`, `branchBoundary`/`boundary`, `extrudedLabel`/`extruded`, `shape`, `branch`, `emphasis`. `null` clears a key.
- **set.patch**: `sticker`, `tags`, `task` (open, done), `link`/`href`, `collapsed`/`folded`, `side` (main branches), `branchLayout`/`layout` (main branches), `image` (hash of a picture already in the map), `alt`, `scale`, `offset` ({x, y}). `null` clears a key.
- **add-tree.spec**: a Markdown outline with attributes (`"- Kenya {#kenya}\n  - Nyeri"`), a JSON node, an array of nodes or `{"roots": [...]}`. Explicit `{#id}` ids are kept and usable by later ops.
- **fold**: `folded: true|false`; with `depth: N` shows N levels below each node; `folded: false, all: true` unfolds whole subtrees.
- **presentation-set**: without `id` (or with an unused one) it creates a presentation. `steps` replaces every step, `addSteps` inserts at `at`, `auto` (branches, levels, nodes) computes a tour. A step is a step line (`"origins, @aero : Title {build=each}"`) or an object `{ "focus": [ids], "title", "reveal", "elements", "frame", "build", "dim", "caption", "note", "seconds" }`.
- **canvas-add.element**: a canvas line (`"note at=500,0 size=180x120 : Grinder settings"`, `"arrow from=@n3 to=espresso : try"`) or an object with CanvasElement fields (`kind`, `x`, `y`, `w`, `h`, …, `from`, `to`). Pictures use `"image": "<sha256 of a picture already in the map>"`.
- **canvas-set.patch**: CanvasElement fields; also `at: [x, y]`, `size: [w, h]`, `from` and `to`. `null` clears; `id` and `kind` never change.

The reply: `status` (applied, dry_run), `tx` (`agent:<client>:<id>`), `tier`, `applied` (agent ops), `ops` (document changes), `created` (ref or op index to id), `links`, `elements`, `presentations`, `touched`, `revision`, `previousRevision`, `warnings`. An error names `op` (the failing index), `code`, `suggestions` and, for a revision conflict, `currentRevision`; `applied` is always 0.

Limits: 2,000 ops and 20,000 inserted nodes per batch, labels 1,000 bytes, notes 64 KiB, 8 MiB per request to the app. Ids generated for new nodes, links, steps and elements are derived from the batch, so the same batch on the same map gives the same ids on every back end.
