# D2: a relief tessellator the engines optimise on its first build

## Hypothesis
D1 found that the dimensional mesh step is dominated by JIT warm-up, not by arithmetic or garbage collection: the first
build of a material after a theme switch (the only build a theme switch does) runs 3 to 11 times slower than the same
build warm, worst for rope in JavaScriptCore (WebKit 50k: 545-559 ms cold against 35-50 ms warm under bun).
`reliefBatch` was one 450-line function with two loops over all branches and closures (`lit`, `cap`, `disk`, `flush`)
that captured and mutated its locals (`vp`, `ip`, the strength bytes, the reuse run), so those locals lived in a
heap scope, and the engines kept leaving optimised code on paths they had not profiled yet. Splitting the per-branch
work into small top-level functions that write through one sink object should let both engines optimise within the
first few hundred branches. Output must stay bit-identical. Metrics that should move: `rebuild_ms` for soft-clay,
lifted-arcs, rope and paper-quilling (most in WebKit), `load_ms` not at all (clean), edits and folds a little (one
branch rebuilt, but the reuse path runs through the same code).

## What changed
`src/lib/core/geometry/tessellate.ts` only, the dimensional path (`reliefBatch` and below; flat `tessellateBatch`,
`BranchMeshCache`, the spec format and the mesh format are unchanged):
- `ReliefSink`: one object per build holding the output arrays, the write cursor (`vp`, `ip`) and the strength bytes
  of the branch being written. It also satisfies `QuillSink`, so quilled walls write through the same object (before,
  a second object literal with a copied cursor).
- Top-level functions taking the sink instead of closures: `lit`, `reliefCap`, `reliefDisk`, `stripIndices`,
  `reliefRibbon` (one clay, arcs or rope branch: limb, plugs or caps, underline, whipping, tip dot), `reliefUnderline`,
  `reliefWhip`, `reliefBounds`, `reliefReuse` (the reuse-run flush), `elbowOf`.
- `reliefBatch` keeps the counting pass and becomes a short loop: reuse runs, then one call per branch.
- Every arithmetic expression is the original one in the original order (the bounds' shadow margin is applied in the
  store instead of a separate subtraction, same operations). The always-true `if (normals)` / `if (shadow)` checks of
  the old code (the relief arrays always exist in `reliefBatch`) are gone.

## Correctness
- Kernel equality (`D1-materials-profile/tools`: `check.py` + `kbc.html`, the real modules of the parent and this
  tree bundled side by side): fresh build, all-reuse build, one-insert edit build, and the edit build against a fresh
  tessellation, compared on positions, indices, bounds, ends and the packed GPU buffer (which holds the colour, normal,
  strength, across, shadow-offset and twist words). Captured app specs, all five themes, at 5k and 20k in Chrome and
  WebKit, at 50k in Chrome (dimensional themes), and a mutated 5k set in both engines (every 5th to 41st spec given
  angular/line/organic styles, h/v/r flows, start and both round caps, tip dots, fades, no start plug, bent and wide
  underlines, zero-length limbs, start tangents, dimming and extra rope whippings): 0 mismatches.
- `bun run check` 0 errors 0 warnings; `node tools/check-boundaries.mjs` exit 0; `uv run tools/check-browser.py --url
  http://127.0.0.1:1443` all PASS.
- Visual guard, parent e2d9186 (code-identical to D1) against this tree: Chrome 18/18 and WebKit 18/18 scenes 0 differing
  pixels, max difference 0, any-difference 0.000 % (`visual-chrome.json`, `visual-webkit.json`).

## Numbers
Targeted probe (the cold kernel of D1: a fresh page per run, one build per theme in the benchmark order, parent and
this tree alternated, 3 runs each; mesh + pack ms; raw `cold-*.json`):

| 50k | soft-clay | lifted-arcs | rope | paper-quilling | clean (unchanged code) |
|---|---|---|---|---|---|
| WebKit parent | 97-100 | 194-198 | 534-569 | 152-157 | 54-56 |
| WebKit D2 | 74-76 | 84-92 | **156-163** | 72-76 | 53-58 |
| Chrome parent | 58-61 | 89-95 | 134-139 | 115-118 | 47-52 |
| Chrome D2 | 55-58 | 70-71 | 103-104 | 85-91 | 50-54 |

Packing is unchanged (not touched). Under bun (JSC), `bun-cold.txt`: rope first build 258 -> 151 ms, second 64 -> 38;
in the benchmark order rope 421 -> 191, lifted-arcs 159 -> 103. JSC's compile log for a cold rope build now shows the
small functions reaching FTL within the build (reliefRibbon still recompiles twice in DFG and twice in FTL, so there is
some warm-up left: rope cold 151 against 38 warm).

In the app (worker `branchMeshMs` from the quick run's diagnostics, parent -> D2): Chrome rope 5k 37 -> 22, 50k 141 ->
115; WebKit rope 5k 38 -> 27, 50k 232 -> 141. (In the quick run rope is the first dimensional theme after a clean load,
so its parent numbers are lower than in the full run's order, where WebKit's rope step was 334-338 ms after soft-clay
and lifted-arcs; the full run's order is where the probe above says the gain is largest.)

Screening, `measure.py --quick --engines chrome,webkit`, 1 round (raw `quick.json`; lock wait 18 minutes):
```
chrome                              A         B    B/A
rebuild_ms@5k/rope             146.50    131.11  0.895  ?faster
rebuild_ms@50k/rope            854.85    889.45  1.040  ~
rebuild_ms@5k/clean            117.42    116.84  0.995  ~
rebuild_ms@50k/clean           823.25    873.35  1.061  ~
edit_ms@50k / fold_ms@50k      502 / 1009   486 / 994   0.97 / 0.99
DIMENSIONAL                      5.49      5.41  0.986  ~
SCORE (REBUILD/INTERACTION/FRAME) 0.996 / 0.975 / 0.980
webkit
rebuild_ms@5k/rope             176.82    127.20  0.719  ?faster
rebuild_ms@50k/rope            915.28    823.66  0.900  ?faster
rebuild_ms@5k/clean            119.82    135.42  1.130  ?slower   (code not touched: noise)
rebuild_ms@50k/clean           953.40      1053  1.104  ?slower   (code not touched: noise)
DIMENSIONAL                     16.11     14.75  0.915  ~
SCORE                           43.30     45.30  1.046  ~
```
One round: rope gets faster in both engines at 5k and in WebKit at 50k, by about what the worker's mesh step lost; the
clean ?slower flags are on code this change does not run (clean uses `tessellateBatch`), i.e. the noise band of a single
round is at least 10-13 % here. The quick run does not exercise soft-clay, lifted-arcs or paper-quilling; a full
WebKit A/B against pinned checkouts is queued behind the lock and will be reported with D3.

## What surprised me
- Garbage collection was not the problem (2-5 % of a warm build); the shape of the code was. The same arithmetic
  runs 3.5x faster on its first call in JSC once it lives in small functions.
- Chrome's quick run hides a 26 ms mesh gain inside 850-890 ms of settled time.

## Verdict
keep: bit-identical output, mesh step of a cold dimensional rebuild 1.3-3.5x faster (largest for rope and lifted-arcs in
WebKit, the shipping engine), no regression seen.
