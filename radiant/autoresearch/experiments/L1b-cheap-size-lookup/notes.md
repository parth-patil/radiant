# L1b: cheap per-node size lookup when text and style did not change (dropped, not implemented)

## Hypothesis
`Pipeline.computeSizes` builds a key string per node on every pass (text, depth, `JSON.stringify(style)`, a ~150-character
theme key) and resolves each node's theme through `treeThemes`; study 01 put it at 45 to 61 ms per edit at 50,000 nodes.
Comparing fields instead of building strings, and carrying the inherited theme down the traversal, should make an
unchanged node cost almost nothing.

## Measurement before deciding (stage probe, sizes.js / switch.js in scratchpad/ar/labels, dev build of L1a, one machine
busy with other agents; medians of 7 passes)
At 50,000 nodes, clean, a pass where nothing changed (doc structured-cloned, as the worker receives it):
- `computeSizes` total: Chrome 26 ms (spread 23 to 50), WebKit 36 ms (23 to 85)
- of which `treeThemes` over all nodes: Chrome 8.9 ms, WebKit 8 ms
- of which building and comparing the key strings: Chrome 10.5 ms, WebKit 15 ms
A theme switch with the L1a cache warm (every key changes, every node re-sized, measure hits): Chrome 38 to 46 ms,
WebKit 38 to 49 ms per pass; `measureLabel` itself 11 to 16 ms of that.
The 45 to 61 ms in study 01 included a cache that thrashed (fixed by L1a) and a noisier machine.

## Why dropped
The most this can remove is the key building plus the theme walk, about 20 to 25 ms per pass at 50,000 nodes and about 2 ms
at 5,000: 2 to 3 % of `edit_ms@50k` (about 800 ms) and under 2 % of `edit_ms@5k` (about 90 ms). The benchmark's noise floor
is 6 to 7 % per metric (10 % for a one-round screen), so the change could not be shown to help, while it adds a
second source of truth for what invalidates a size (style, sticker, depth, numbering, picture frame, local theme), which is
exactly the kind of bug that changes layouts silently. Worth revisiting only after the larger per-edit costs (settleLayout,
branch specs, scene build, transport; other tracks) are gone and `computeSizes` becomes a visible share.
