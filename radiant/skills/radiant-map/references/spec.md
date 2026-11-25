# Map spec, version 1

A spec is a Markdown outline with optional front matter, attribute blocks and a links block (`.map.md`). Any outline that Radiant's Markdown import reads is already a valid spec and builds to the same tree and notes. The nested JSON twin (`radiant schema spec`) carries exactly the same information; `radiant get MAP --format spec-json` shows it.

## Structure

- `#` lines are roots, `##` lines main branches, and list items below them deeper levels. Deeper headings and nested lists also work.
- A paragraph under a heading or item is that node's note. Blank lines inside a note are kept.
- `[ ]` or `[x]` at the start of a label makes an open or done task.
- `{…}` at the end of a label holds attributes: `{#id key=value key="value with spaces" flag}`.
- A whole-line `<!-- comment -->` is ignored.
- Escapes: a label that really ends in braces writes `&#123;` for `{`; any character can be written as `&#NN;`.
- Fenced `presentation` and `canvas` blocks are reserved for later versions; they are ignored with a warning. Other fenced blocks stay note text.

## Front matter

Between `---` lines at the top. A restricted YAML subset: `key: value`, nested blocks by indentation, flow values such as `{ a: 1 }` and `[x, y]`, quoted strings.

| Key | Sets | Values |
|---|---|---|
| radiant | spec version | 1 |
| title | map title | text (default: file name) |
| theme | theme | an id from `radiant themes` |
| themeSettings | theme overrides | fields accepted by the app's theme settings; unknown ones are dropped with a warning |
| layout, spacing | every root | mindmap, right, left, down, up, compact, radial, outline, timeline, columns, grid, popcorn; narrow, default, wide |
| seed | organic geometry seed | integer |
| tagColors | tag colours | `{ tag: "#RRGGBB" }` |
| assets | pictures | `name: path/to/file` relative to the spec (PNG, JPEG, WebP, GIF or SVG) |

## Node attributes

| Attribute | Sets | Values |
|---|---|---|
| #id | node id | letters, digits, `_`, `-`; up to 128 characters |
| color, text, fill | branch, text and fill colour | `#RGB` or `#RRGGBB`; color is inherited by the branch |
| shape | node shape | underline, box, rectangle, circle, square, none |
| branch, width | branch style and width | tapered, organic, line, rounded, angular; 0.5 to 64 |
| bold, italic | font style | flags (`bold`, `bold=false`) |
| size, font, align | font size, family, alignment | 6 to 200; CSS family list; left, center, right |
| emphasis | emphasis | 0, 1, 2 |
| curved, boundary, extruded | curved label, branch boundary, extruded label | flags |
| sticker | symbol beside the label | short text such as an emoji |
| tags | tags | comma-separated |
| href | node link | URL or map link (never opened by the tool) |
| folded | folded | flag |
| side | main branch side | left, right (main branches only) |
| layout | root layout, or a main branch's layout | as above (main branches: tree layouts only) |
| spacing, organic | root spacing, organic branches | roots only |
| image, alt, scale | picture | asset name; alt text; 0.1 to 8 |
| note | note | text (alternative to a paragraph) |
| task | task | open, done (alternative to `[ ]`) |

Geometry (`x`, `y`, `w`, `h`, `height`, `position`, `width` above 64) is ignored with a warning: the layout engine places nodes. `offset=x,y` and `pin=x,y` apply only with `--allow-geometry`.

## Ids

Explicit ids are kept. Other nodes get ids derived from the parent id, the label and its position among same-label siblings, so building one spec twice gives the same ids and, with the same time (`--now` or the spec file's time), the same file. `get` writes every id, so a spec read from a map builds back to the same tree.

## Links

````markdown
```links
from-id -> to-id : optional label {dash=dashed arrows=end color=#795275}
```
````

dash: solid, dashed. arrows: none, start, end, both. Both ends must be node ids in the spec.

## Presentations

One fenced block per presentation; one step per line: `ids : title {attributes}`, or the single line `auto levels` (also `auto branches`, `auto nodes`) for a tour computed at build time.

````markdown
```presentation name="Team intro" reveal=progressive opacity=0.22 motion=gentle minutes=10
coffee : Why coffee {frame=map}
origins : Where it comes from {build=each}
brewing, espresso : How we brew {note="Mention the new grinder." elements=n1}
```
````

Block attributes: `name`, `id`, `reveal` (progressive, all), `context` (dim, hide), `opacity` (0 to 1), `motion` (full, gentle, none), `minutes`. Step attributes: `#id`, `frame` (nodes, subtree, map), `build` (all, each), `dim` (others, none), `reveal`, `hide`, `elements` (comma-separated ids), `caption`, `note`, `transition` (glide, cut), `seconds`, `skip`. Every id must exist in the spec. In the JSON twin: `"presentations": [{ "name", "steps": [ "line" | { "focus": [ids], … } ] | "auto levels" }]`.

## Canvas elements

One fenced `canvas` block; one element per line: `kind #id at=x,y size=wxh {attributes} : text`. Arrows and lines bind to nodes or elements with `from=` and `to=`; their ends follow the target when the map moves.

````markdown
```canvas
frame #board at=-600,-300 size=1200x700 : Coffee board
note #n1 at=300,200 size=200x140 {fill=#FFF3BF} : Buy beans on Friday
arrow #a1 from=n1 to=espresso : try this
```
````

Kinds: rect, ellipse, diamond, line, arrow, draw, text, note, frame, image. Attributes are CanvasElement fields: `band` (back, front), `stroke`, `fill`, `fillStyle` (solid, hachure, cross-hatch, zigzag), `strokeWidth`, `strokeStyle` (solid, dashed, dotted), `roughness` (0 to 2), `round`, `opacity`, `seed`, `locked`, `groups`, `frame` (a frame's id), `link`, `fontSize`, `font` (theme, hand, code), `align`, `textColor`, `points` (x0,y0,x1,y1,… relative to `at`), `pressures`, `startHead`/`endHead` (none, arrow, dot, bar), `elbow`, `rotate` (degrees), `from-at`/`to-at` (0..1 point on the target), `from-gap`/`to-gap`, and `image=name` for an asset from the front matter. Ids not given are derived from the line, and the seed from the id, so builds are repeatable. In the JSON twin: `"canvas": [ "line" | { "kind", "x", "y", "w", "h", … } ]`.

`get --format spec` writes both blocks back. Canvas bookmarks, the canvas grid and fields kept from an imported Excalidraw file are listed as omissions.

## Pictures

Declare each file under `assets:` and attach it with `image=name`. Files must sit beside the spec or under `--root`. Pictures are embedded by content hash; SVG is sanitised and the build lists what was removed (scripts, external references). `radiant export MAP --format spec -o out.map.md` writes a map's pictures into `out-assets/`; `get --format spec` refers to them as `sha256:<hash>`, which `build --assets-from MAP` resolves.

## Limits

Labels 1,000 bytes, notes 64 KiB, 20,000 nodes, 5,000 links, spec 8 MiB, pictures 45 MiB. Control characters are rejected.
