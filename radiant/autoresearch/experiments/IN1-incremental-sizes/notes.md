# IN1: incremental sizes (computeSizes keys only what an edit can have changed)

Track: incremental (round 2). Parent: e2d9186 (merged round 1). Branch ar/incremental.

## Hypothesis

`Pipeline.computeSizes` builds a size-cache key string for every visible node on every pass (node text, depth,
`JSON.stringify(style)`, a ~150-character theme key, and a `treeThemes` parent walk per node), although after a
one-node edit only the edited nodes can have a new size. Keeping, per node, what its key was built from besides the
node itself (depth, local theme object, main-branch number, picture frame) and re-keying only the nodes an edit
touched, or whose context changed, should cut computeSizes from ~25 ms to a few ms per edit at 50,000 nodes.
Metrics that should move: the worker's layout time (diagnostics `layoutMs`) on edit and fold; edit_ms / fold_ms
only by a few percent (computeSizes is ~5 % of a 50k edit).

L1b check: branch ar/labels recorded "L1b (cheap size lookup)" as dropped (00df927), so there was nothing to build on.

## Change

- `ui/layout.worker.ts`: `sync()` applies the edit ops with a `ChangeTrack` and passes `track.touched` to
  `computeWork`; a whole document (load, resync) passes nothing, which means "everything changed".
- `ui/pipeline.ts`:
  - `computeWork(work, changed?)` and `relayout(doc, theme, anchor?, changed?)`; the main thread's own relayout calls
    pass nothing and behave exactly as before.
  - An equal theme (same JSON) keeps the previous pass's theme object, so "theme changed" is an identity test.
  - `computeSizes(changed)`: iterative walk with parallel stacks; the local theme comes from a new top-down
    `themeScopes` (same resolution as `treeThemes`, O(1) per node, a node without its own generated style or art
    preset shares its parent's scope object). Per node `sizeContext` = { depth, local theme, number, frame w/h };
    a node not in `changed` with an identical context skips the key; otherwise the key is built and compared as
    before (re-measure only when it differs). Contexts are dropped for touched nodes, for nodes with a theme of their
    own, and all of them when the theme, pictures, art preset or generated-artwork setting change.
  - Records `resized` (nodes whose size changed), used by IN2.
- `core/model/generated-style.ts`: `themeScopes(doc, base)`.
- Bug fixed on the way (found by the check script, pre-existing, not caused by this change): `computeWork` updated
  its copy of the document with `Object.assign`, so a document field the edit removed (for example the document's
  art preset, `docMeta { artStyleId: undefined }`) stayed on the worker's copy and the map kept the old look until
  a reload. It now drops fields the incoming document no longer has. A second bug in my first version (a node whose
  theme went from its own back to the map's could reuse a context recorded before) was caught by the same script and
  fixed before this commit.

## Correctness

`autoresearch/experiments/incremental-tools/harness.py` (`check` mode): drives `ui/pipeline.ts` directly in a dev
page; after every random edit (30 kinds: add, sibling, type, rename, delete, move, duplicate, fold of any node and
of main branches, style colour/width/shape, sticker, pin, offset, side, reorder, branch layout, generated style,
node and document art preset, detach to a new root, root move, theme switch, undo, redo) the persistent pipeline's
result is compared with a fresh `Pipeline` on a copy of the document: boxes (order and every field), placements,
branch specs, label curves, scene labels, rects, images, picture maps, mesh arrays and spatial ids must be equal.
Runs: 5,000 and 20,000 nodes x clean, rope x seeds 1-2 x 60 steps; 5,000 x clean, rope, paper-quilling, hand-drawn
and 20,000 x clean x seed 5 x 60 steps (with the art-preset kinds): 0 differences. Removing the invalidation of
touched nodes makes it fail at the second step (it does detect stale sizes).
`e2e.py` (through the real worker): 50 random editor edits, then a forced whole-document resync; boxes, placements,
specs, labels and rects identical (5,000 and 20,000 x clean, rope x 2 seeds).
`bun run check` 0/0, `check-boundaries` OK, `check-browser.py` PASS.

## Visual guard

Chrome, 18 scenes, e2d9186 vs this: 0 differing pixels, max difference 0 in every scene.

## Screening

Quick benchmark, 1 round, both engines (raw: `quick.json`). The run overlapped with my own check script for its first
minutes (Chrome part), so the Chrome numbers are noisier than usual.

| metric | Chrome A | Chrome B | B/A | WebKit A | WebKit B | B/A |
|---|---:|---:|---:|---:|---:|---:|
| edit_ms@5k | 86.0 | 85.3 | 0.99 | 102.0 | 69.6 | 0.68 |
| edit_ms@50k | 601 | 615 | 1.02 | 467 | 463 | 0.99 |
| fold_ms@5k | 139 | 139 | 0.99 | 139 | 118 | 0.85 |
| fold_ms@50k | 1091 | 1064 | 0.98 | 1013 | 1004 | 0.99 |
| load_ms@50k | 830 | 975 | 1.17 | 891 | 873 | 0.98 |
| rebuild_ms@50k/rope | 904 | 1071 | 1.19 | 928 | 912 | 0.98 |
| SCORE | 41.65 | 42.83 | 1.03 | 44.33 | 44.30 | 1.00 |

Nothing here is outside one-round noise (the 5k WebKit gains and the Chrome 50k load/rope losses go in opposite
directions in the two engines and are not explained by the change: a load is a whole document, which takes the
old path).

Targeted probe (`probe.json`, `probe.py` = the transport track's probe plus the worker's layout/geometry/mesh
timers; production bench builds, interleaved, 2 rounds, 4 adds and 2 fold/unfold cycles per page; medians in ms;
the probe builds predate the two fixes above, which do not change the work on these maps):

| op | engine | size/theme | settled A -> B | worker relayout A -> B |
|---|---|---|---|---|
| add | Chrome | 20k clean | 230 -> 212 | 86.5 -> 74.0 |
| add | Chrome | 50k clean | 546 -> 546 | 227 -> 211 |
| add | Chrome | 50k rope | 627 -> 616 | 277 -> 258 |
| fold | Chrome | 50k clean | 554 -> 537 | 214 -> 198 |
| add | WebKit | 20k clean | 178 -> 173 | 63.6 -> 63.6 |
| add | WebKit | 50k clean | 416 -> 431 | 173 -> 168 |
| add | WebKit | 50k rope | 502 -> 521 | 227 -> 220 |
| fold | WebKit | 50k clean | 476 -> 458 | 194 -> 175 |

Stage harness (main thread of a dev page, Chrome, 50k, 6 adds, 6 types, 12 fold/unfold): computeSizes per edit
23-26 ms -> 9-13 ms (clean and rope).

## What surprised me

- computeSizes was already only ~25 ms (the study measured 45-61 ms before round 1); what remains after this change
  (~10 ms) is the walk itself: 50,000 dictionary lookups in `doc.nodes`, Map lookups and the picture checks.
- The end-to-end edit at 50k (420-700 ms) is only ~40 % worker relayout; the rest is the scene, packing, transport
  and the main thread.
- The worker's copy of the document never dropped removed document fields (see Change).

## Verdict

Keep, as a small, targeted gain: worker relayout per edit/fold -3 % to -14 % (Chrome) and 0 % to -10 % (WebKit),
computeSizes -55 %; the headline metrics do not resolve a change this size in one round. It also lays the plumbing
(`changed`, `resized`) the next experiments use. Cost to watch: on a theme switch every node now also stores a small
context object (~50k allocations at 50k nodes); not visible in rebuild_ms here, but a candidate for removal if IN3's
dirty-subtree set makes it redundant.
