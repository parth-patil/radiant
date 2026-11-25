# 01 — Rebuild-path CPU profile (sizes → layout → tessellation → transport → adoption → upload)

Author: rebuild-path profiler agent. Read-only study; no source file was changed. Date: 2026-11-25.
Code profiled: commit `5450267` (HEAD of `themes-presentation-canvas-agents`), served from an isolated copy (see Method).
All raw data, scripts and `.cpuprofile` files: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/rebuild-profiler/` (`runs/` holds the JSON; open the `.cpuprofile` files in Chrome DevTools).

## 1. Summary

- **Every edit is O(n) end to end.** Adding one child, typing one character or folding 300 nodes redoes the whole map: sizes are re-keyed for every node, `settleLayout` walks and rebuilds a placement record for every node, every branch spec is rebuilt and compared, the whole branch mesh is re-assembled into new arrays, re-packed, sent, and re-uploaded with `bufferData`, and the whole scene (one label per node) is rebuilt and sent. Fitted scaling exponents for one-node edits are 1.1 to 1.4 (first frame) and 1.2 to 1.5 for the object-heavy stages: linear-to-mildly-superlinear, never constant.
- **One-node edit latency (edit → first frame showing it), headless Chrome, medians:** 5,000 nodes: 71 to 84 ms; 20,000: 290 to 340 ms; 50,000: 0.88 to 1.8 s. Theme switch at 50,000: 1.6 to 2.2 s.
- **Transport is as big as compute.** At 5,000 nodes a one-character edit spends ~23 ms computing in the worker but ~35 ms moving data (post 3, worker deserialise 7, worker serialise 10, main deserialise 16): posting the whole document (634 KB as JSON) and the previous placements to the worker, and structured-cloning back a result that holds 5,000 boxes, 5,000 placement records, 4,999 branch specs, 5,000 label draws and **16 MB of CPU mesh arrays** (positions f64, colours f32, indices u32) on top of a 7.5 MB transferred GPU buffer. At 50,000 the cloned mesh is 142 MB (clean) / 186 MB (rope) per edit.
- **Main thread per edit:** at 5,000 nodes ~28 to 33 ms of main-thread work per edit, the longest single task 16 to 19 ms (deserialising the result message: Chrome deserialises lazily on first `event.data` access, inside the controller's `onmessage`). That is a dropped frame at 60 Hz and two at 120 Hz on every keystroke. At 50,000: 250 to 480 ms of main-thread work per edit, longest task 30 to 200 ms (whole-mesh GPU upload or header deserialisation), plus ~70 ms of autosave serialisation per edit seen in the CPU profile (`serializeDoc` + `revisionKey`).
- **Pure number crunching is a small share.** The tidy-tree solver is ~2 ms per edit at 50,000 nodes; spatial index build 1 to 6 ms; fresh tessellation of all 50,000 flat branches is 36 ms (rope 74 ms). The time goes to object allocation, string keys, Map/dictionary lookups, style resolution, copying and structured cloning. This decides which radical options pay (see §7).
- **Ranking is the same in JavaScriptCore** (Playwright WebKit) within ±30% per stage; JSC clones typed arrays 3 to 4× faster and object graphs ~1.5× slower than V8, so in WKWebView the object part of the payload matters even more than in Chrome.
- **Top proposals** (details in §6): (1) stop cloning the CPU mesh and the object graphs back to the main thread (send typed arrays, transfer, or keep in the worker); (2) persistent, patchable branch-mesh buffers with `bufferSubData` instead of rebuild + pack + full upload; (3) keep a document replica in the worker and send op diffs; (4) make `settleLayout`, `computeSizes`, `branchSpecs` and `fullScene` incremental over dirty main branches; (5) raise or LRU the 30,000-entry text-layout cache that thrashes above 30k labels; (6) debounce / move autosave serialisation off the main thread. WASM, multi-worker tessellation and GPU tessellation are discussed with honest gains.

## 2. Method

**Isolation.** The shared dev server at :1420 hot-reloaded during my first run (other agents were editing `renderer.ts`, `App.svelte`, `controller.svelte.ts` and adding `bench-hooks.ts` in the main tree; the page reported `[vite] Failed to reload /src/lib/ui/App.svelte` and a failed dynamic import mid-run). Those numbers were discarded. I exported HEAD (`git archive HEAD radiant`) to `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/rebuild-profiler/head/`, symlinked `node_modules`, and ran a second Vite on port 1520 with `cacheDir` pointed at my scratch folder. **Incident:** my first start of that server, before I set `cacheDir`, re-optimised dependencies into the shared `radiant/node_modules/.vite` (timestamp 15:10 IST). I stopped it within ~10 s and loaded :1420 afterwards in headless Chrome: it loaded with no console errors and `window.__radiant` present. If the owner's open tab shows an "outdated optimize dep" error on its next reload, that is the cause; a reload of the page fixes it. Nothing under `src-tauri` was touched; the app was never started.

**Machine.** M4 Pro, macOS, load average 4.6 to 5.1 throughout (other agents running). **All timings are provisional**: I report medians of 5 repetitions (10 for typing) with ranges; ranges at 50,000 nodes are wide (e.g. rope add-child 1.19 to 3.08 s).

**End-to-end harness** (`harness.py`, Playwright + Chrome, `--use-angle=metal`). An init script wraps `Worker.prototype.postMessage` and the `onmessage` setter (timing the first `event.data` access separately, which is where Chrome deserialises), and instance methods `pipeline.adoptWork/fullScene/withOverlay/relayout/work`, `renderer.render/uploadMesh`, `renderer.viewport.update` and `c.flush`. The layout worker is reached through the browser CDP session (`Target.attachToTarget`, non-flattened, `Target.sendMessageToTarget`); a script evaluated there wraps `self.onmessage`/`self.postMessage` the same way and reads the stage timers the pipeline already returns (`lastLayoutMs`, `lastGeometryMs`, `lastBranchMeshMs`, `lastBranchesRebuilt`). Clocks are `performance.timeOrigin + performance.now()` in both threads. Operations per configuration ({clean, rope} × {5k, 20k, 50k}): load (clean: `c.loadSynthetic(n)`; rope: `c.loadDoc` of a rope copy without placements), theme switch both ways, `addChildOf(leaf at depth ≥ 3)` then `endEdit()` (which undoes the empty child), `toggleFoldOf` on a ~300-node subtree (288 to 305 nodes, depth 2) and back, and typing one character at a time via `textarea.value += 'x'; onEditInput()` into a depth-3 node. "First frame" = from the call to the end of the first `renderer.render` after `adoptWork`. A separate pass with the CDP sampling profiler (250 µs) on both the page and the worker produced the `.cpuprofile` files and the per-function/per-line aggregates.

**Stage harness** (`micro.py` + `micro.js`). Imports `ui/pipeline.ts` and the core modules straight from Vite into a page, builds the same synthetic tree, wraps `Pipeline.prototype.computeSizes/branchSpecs/fullScene`, `SpatialIndex.prototype.update`, `BranchMeshCache.prototype.build` and the `measure` callback, and runs `computeWork(structuredClone(work))` exactly as the worker does: cold pass, then per repetition (×3) no-change, add child, remove it, type one char, fold, unfold, theme away, theme back, applying real ops with `applyOps`. It also times `packVertices` and `structuredClone` of the request and of the result and of each part of the result. Run in Chrome (V8) and Playwright WebKit 27.2 (JSC; not WKWebView itself, and on the main thread rather than in a worker). `structuredClone` measures serialise + deserialise in one thread.

## 3. Where the time goes (end to end, Chrome)

Columns: medians in ms with share of first-frame latency. "Worker: compute" is `computeWork` plus `packVertices` and building the reply (for ≥12,000 nodes also `splitLayoutPayload`). "relayout" is `lastLayoutMs` (sizes + `settleLayout` + specs + branch mesh + spatial). "Main: deserialize" includes assembling streamed chunks. "First render" is the first `renderer.render` after adoption with, in brackets, the sum of `uploadMesh` during the op (fold/unfold animate and re-upload several times). "Unaccounted" is latency between those steps: rAF waits, message queueing and, at ≥12,000 nodes, the ~290 pull/part round trips of the streaming protocol.

| Theme | Operation | n | First frame ms (median, range) | Main: request (call+post) | Worker: deserialize request | Worker: compute | of which pipeline.relayout (sizes+layout+specs+mesh) | settleLayout | branch mesh | Worker: serialize result | Main: deserialize + chunk assembly | Main: first render (of which GPU upload) | Unaccounted (queueing, rAF, task turns) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| clean | Initial load | 5,000 | 83 (82-92) | 9 (11%) | 4 (5%) | 37 (45%) | 20 | 5 | 6 | 13 (16%) | 18 (22%) | 2 (1) | 0 (0%) |
| clean | Initial load | 20,000 | 339 (336-386) | 36 (10%) | 7 (2%) | 141 (42%) | 98 | 30 | 24 | 45 (13%) | 66 (19%) | 10 (7) | 35 (10%) |
| clean | Initial load | 50,000 | 1680 (1094-1911) | 121 (7%) | 30 (2%) | 956 (57%) | 784 | 165 | 72 | 151 (9%) | 185 (11%) | 60 (53) | 176 (10%) |
| clean | Theme switch to rope | 5,000 | 107 (100-161) | 3 (3%) | 4 (4%) | 40 (38%) | 30 | 7 | 15 | 16 (15%) | 18 (17%) | 4 (4) | 21 (20%) |
| clean | Theme switch to rope | 20,000 | 402 (386-608) | 14 (3%) | 14 (3%) | 191 (47%) | 147 | 43 | 61 | 50 (13%) | 67 (17%) | 20 (18) | 47 (12%) |
| clean | Theme switch to rope | 50,000 | 1952 (1713-2512) | 54 (3%) | 42 (2%) | 1243 (64%) | 932 | 261 | 144 | 210 (11%) | 195 (10%) | 202 (195) | 7 (0%) |
| clean | Theme switch to clean | 5,000 | 98 (88-116) | 3 (3%) | 8 (8%) | 30 (31%) | 23 | 9 | 6 | 12 (12%) | 16 (16%) | 2 (1) | 27 (28%) |
| clean | Theme switch to clean | 20,000 | 324 (307-393) | 14 (4%) | 13 (4%) | 128 (39%) | 91 | 37 | 21 | 37 (12%) | 61 (19%) | 10 (8) | 61 (19%) |
| clean | Theme switch to clean | 50,000 | 1932 (1453-2408) | 52 (3%) | 49 (3%) | 1195 (62%) | 890 | 256 | 96 | 178 (9%) | 181 (9%) | 62 (55) | 216 (11%) |
| clean | Add one child | 5,000 | 73 (69-92) | 7 (10%) | 4 (5%) | 24 (33%) | 17 | 6 | 5 | 12 (17%) | 16 (22%) | 2 (1) | 8 (10%) |
| clean | Add one child | 20,000 | 290 (273-310) | 18 (6%) | 13 (5%) | 103 (35%) | 65 | 24 | 12 | 39 (13%) | 64 (22%) | 10 (8) | 44 (15%) |
| clean | Add one child | 50,000 | 1134 (909-1823) | 63 (6%) | 41 (4%) | 556 (49%) | 393 | 151 | 63 | 136 (12%) | 157 (14%) | 30 (25) | 151 (13%) |
| clean | Fold ~300-node subtree | 5,000 | 92 (83-111) | 3 (4%) | 6 (6%) | 24 (26%) | 15 | 4 | 5 | 13 (14%) | 20 (22%) | 2 (3) | 25 (27%) |
| clean | Fold ~300-node subtree | 20,000 | 312 (290-339) | 14 (4%) | 13 (4%) | 105 (34%) | 66 | 20 | 15 | 36 (12%) | 79 (25%) | 11 (9) | 55 (18%) |
| clean | Fold ~300-node subtree | 50,000 | 913 (855-986) | 39 (4%) | 34 (4%) | 379 (42%) | 261 | 101 | 47 | 109 (12%) | 199 (22%) | 30 (23) | 123 (13%) |
| clean | Unfold it | 5,000 | 94 (90-118) | 3 (3%) | 8 (8%) | 24 (25%) | 17 | 5 | 5 | 12 (12%) | 21 (23%) | 2 (4) | 26 (27%) |
| clean | Unfold it | 20,000 | 321 (292-329) | 14 (4%) | 14 (4%) | 106 (33%) | 69 | 23 | 16 | 38 (12%) | 85 (27%) | 12 (13) | 52 (16%) |
| clean | Unfold it | 50,000 | 925 (846-998) | 40 (4%) | 34 (4%) | 386 (42%) | 270 | 94 | 53 | 107 (12%) | 218 (24%) | 27 (32) | 115 (12%) |
| clean | Type one character | 5,000 | 71 (64-92) | 6 (9%) | 7 (9%) | 23 (33%) | 17 | 6 | 4 | 10 (14%) | 16 (22%) | 2 (1) | 7 (10%) |
| clean | Type one character | 20,000 | 294 (280-314) | 18 (6%) | 14 (5%) | 103 (35%) | 66 | 23 | 14 | 38 (13%) | 61 (21%) | 11 (7) | 49 (17%) |
| clean | Type one character | 50,000 | 878 (830-984) | 58 (7%) | 35 (4%) | 373 (42%) | 253 | 98 | 46 | 111 (13%) | 155 (18%) | 30 (20) | 117 (13%) |
| rope | Initial load | 5,000 | 84 (82-128) | 7 (8%) | 4 (5%) | 35 (41%) | 23 | 6 | 9 | 12 (15%) | 18 (22%) | 4 (3) | 4 (5%) |
| rope | Initial load | 20,000 | 306 (302-423) | 22 (7%) | 7 (2%) | 127 (41%) | 87 | 25 | 25 | 42 (14%) | 68 (22%) | 10 (9) | 29 (10%) |
| rope | Initial load | 50,000 | 1303 (1040-1407) | 74 (6%) | 17 (1%) | 630 (48%) | 421 | 129 | 101 | 168 (13%) | 208 (16%) | 77 (72) | 128 (10%) |
| rope | Theme switch to rope | 5,000 | 134 (119-161) | 3 (2%) | 8 (6%) | 65 (48%) | 52 | 6 | 36 | 13 (10%) | 18 (13%) | 3 (3) | 25 (18%) |
| rope | Theme switch to rope | 20,000 | 363 (344-401) | 14 (4%) | 13 (4%) | 149 (41%) | 109 | 35 | 38 | 43 (12%) | 65 (18%) | 15 (13) | 64 (18%) |
| rope | Theme switch to rope | 50,000 | 1638 (1580-2622) | 56 (3%) | 38 (2%) | 914 (56%) | 748 | 215 | 115 | 187 (11%) | 194 (12%) | 100 (93) | 149 (9%) |
| rope | Theme switch to clean | 5,000 | 99 (88-133) | 3 (3%) | 4 (4%) | 39 (39%) | 30 | 7 | 15 | 11 (11%) | 17 (17%) | 2 (1) | 23 (23%) |
| rope | Theme switch to clean | 20,000 | 322 (302-356) | 14 (4%) | 13 (4%) | 120 (37%) | 87 | 32 | 23 | 35 (11%) | 60 (19%) | 8 (6) | 71 (22%) |
| rope | Theme switch to clean | 50,000 | 2155 (1383-2523) | 53 (2%) | 37 (2%) | 1181 (55%) | 1006 | 308 | 67 | 171 (8%) | 187 (9%) | 139 (134) | 388 (18%) |
| rope | Add one child | 5,000 | 84 (81-89) | 7 (8%) | 4 (5%) | 27 (32%) | 21 | 5 | 8 | 14 (16%) | 19 (22%) | 3 (3) | 10 (12%) |
| rope | Add one child | 20,000 | 337 (336-358) | 18 (5%) | 13 (4%) | 122 (36%) | 86 | 22 | 24 | 46 (14%) | 68 (20%) | 19 (18) | 51 (15%) |
| rope | Add one child | 50,000 | 1822 (1194-3078) | 63 (3%) | 41 (2%) | 749 (41%) | 562 | 162 | 154 | 217 (12%) | 217 (12%) | 189 (183) | 346 (19%) |
| rope | Fold ~300-node subtree | 5,000 | 105 (90-116) | 3 (3%) | 6 (6%) | 28 (27%) | 22 | 4 | 9 | 13 (12%) | 22 (21%) | 4 (5) | 29 (27%) |
| rope | Fold ~300-node subtree | 20,000 | 404 (343-452) | 15 (4%) | 14 (3%) | 155 (38%) | 107 | 33 | 29 | 56 (14%) | 85 (21%) | 20 (19) | 60 (15%) |
| rope | Fold ~300-node subtree | 50,000 | 1171 (1111-1349) | 46 (4%) | 33 (3%) | 532 (45%) | 404 | 122 | 87 | 134 (11%) | 215 (18%) | 44 (37) | 167 (14%) |
| rope | Unfold it | 5,000 | 110 (103-124) | 3 (3%) | 8 (7%) | 30 (27%) | 23 | 5 | 9 | 13 (12%) | 26 (23%) | 4 (8) | 26 (23%) |
| rope | Unfold it | 20,000 | 390 (372-565) | 15 (4%) | 14 (3%) | 139 (36%) | 93 | 26 | 32 | 53 (13%) | 97 (25%) | 26 (31) | 47 (12%) |
| rope | Unfold it | 50,000 | 1206 (1081-1287) | 46 (4%) | 34 (3%) | 516 (43%) | 372 | 124 | 75 | 134 (11%) | 233 (19%) | 49 (63) | 194 (16%) |
| rope | Type one character | 5,000 | 84 (79-90) | 7 (8%) | 7 (8%) | 29 (34%) | 21 | 6 | 7 | 12 (14%) | 17 (21%) | 3 (2) | 9 (11%) |
| rope | Type one character | 20,000 | 329 (310-366) | 18 (5%) | 13 (4%) | 119 (36%) | 82 | 24 | 21 | 43 (13%) | 65 (20%) | 11 (7) | 59 (18%) |
| rope | Type one character | 50,000 | 1070 (1009-1179) | 57 (5%) | 34 (3%) | 511 (48%) | 377 | 120 | 70 | 130 (12%) | 165 (15%) | 32 (22) | 142 (13%) |

**Scaling exponents** (least-squares slope of log time vs log n over 5k, 20k, 50k; 1.0 = linear):

| Theme | Operation | First frame | Main request | Worker compute | relayout | settleLayout | branch mesh | Worker serialize | Main deserialize | First render |
|---|---|---|---|---|---|---|---|---|---|---|
| clean | Initial load | 1.28 | 1.13 | 1.38 | 1.55 | 1.48 | 1.05 | 1.05 | 1.00 | 1.45 |
| clean | Theme switch to rope | 1.24 | 1.20 | 1.46 | 1.47 | 1.56 | 0.98 | 1.11 | 1.02 | 1.61 |
| clean | Theme switch to clean | 1.26 | 1.17 | 1.55 | 1.55 | 1.44 | 1.18 | 1.14 | 1.06 | 1.44 |
| clean | Add one child | 1.17 | 0.93 | 1.33 | 1.33 | 1.37 | 1.08 | 1.03 | 0.98 | 1.20 |
| clean | Fold ~300-node subtree | 0.99 | 1.07 | 1.19 | 1.22 | 1.36 | 0.98 | 0.92 | 1.00 | 1.18 |
| clean | Unfold it | 0.98 | 1.09 | 1.20 | 1.19 | 1.27 | 0.98 | 0.96 | 1.01 | 1.25 |
| clean | Type one character | 1.09 | 0.96 | 1.19 | 1.16 | 1.17 | 1.01 | 1.03 | 0.99 | 1.21 |
| rope | Initial load | 1.17 | 1.02 | 1.24 | 1.23 | 1.30 | 1.03 | 1.12 | 1.05 | 1.28 |
| rope | Theme switch to rope | 1.06 | 1.24 | 1.11 | 1.11 | 1.50 | 0.47 | 1.14 | 1.03 | 1.47 |
| rope | Theme switch to clean | 1.30 | 1.22 | 1.43 | 1.47 | 1.58 | 0.62 | 1.15 | 1.04 | 1.69 |
| rope | Add one child | 1.31 | 0.93 | 1.41 | 1.40 | 1.45 | 1.22 | 1.18 | 1.05 | 1.73 |
| rope | Fold ~300-node subtree | 1.04 | 1.16 | 1.27 | 1.25 | 1.45 | 1.00 | 1.02 | 0.99 | 1.06 |
| rope | Unfold it | 1.03 | 1.14 | 1.22 | 1.19 | 1.42 | 0.94 | 1.00 | 0.96 | 1.13 |
| rope | Type one character | 1.09 | 0.92 | 1.23 | 1.23 | 1.27 | 0.98 | 1.03 | 0.98 | 0.96 |

**Main-thread cost per operation** (sum of the instrumented main-thread tasks, and the longest one; medians, ms). This undercounts: Svelte reactivity, autosave and GC are not in it.

| n | clean: busy / longest task (type, add, fold) | rope: busy / longest task (type, add, fold) |
|---|---|---|
| 5,000 | 28/16, 28/16, 52/20 | 31/17, 32/19, 59/22 |
| 20,000 | 94/11, 93/10, 166/20 | 98/11, 110/19, 181/20 |
| 50,000 | 253/30, 275/30, 377/48 | 266/32, 483/189, 401/54 |

**Payload and memory** (after load):

| | 5k clean | 5k rope | 20k clean | 20k rope | 50k clean | 50k rope |
|---|---|---|---|---|---|---|
| Document as JSON (sent to the worker on every edit) | 634 KB | 634 KB | 2.6 MB | 2.6 MB | 6.5 MB | 6.5 MB |
| Branch-mesh vertices / indices | 373k / 1.03M | 498k / 1.35M | 1.38M / 3.77M | 1.81M / 4.86M | 3.32M / 9.06M | 4.36M / 11.65M |
| Vertices per branch | 75 | 100 | 69 | 91 | 66 | 87 |
| CPU mesh arrays cloned to main per edit | 16 MB | 21 MB | 59 MB | 77 MB | 142 MB | 186 MB |
| Packed GPU buffer transferred (and fully re-uploaded) per edit | 7.5 MB | 15.9 MB | 27.5 MB | 58 MB | 66 MB | 140 MB |
| JS heap used, main / worker | 16 / 30 MB | 17 / 20 MB | 66 / 95 MB | 76 / 148 MB | 175 / 197 MB | 183 / 241 MB |
| Backing store (typed arrays), main / worker | 110 / 35 MB | 89 / 45 MB | 193 / 182 MB | 290 / 315 MB | 447 / 291 MB | 681 / 571 MB |

(The flat 5k mesh is "wide": its extent exceeds 65,536 world units, so it uses the 20-byte stride.)

## 4. Stage breakdown (stage harness; Chrome V8 / WebKit JSC, medians, ms)

| Config | Pass | computeWork total | computeSizes | (text measure) | settleLayout | branchSpecs | branch mesh | fullScene | packVertices | clone request | clone result | (mesh arrays) | (branch specs) | (placements) | (boxes) | (scene labels+rects) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| clean-5000 | cold first pass | 150 / 55 | 27 / 6 | 20 / 3 | 37 / 14 | 17 / 10 | 62 / 16 | 5 / 6 | 5 / 10 | 21 / 7 | 28 / 33 | 6 / 4 | 7 / 11 | 6 / 5 | 7 / 2 | 5 / 5 |
| clean-5000 | type 1 char | 26 / 29 | 2 / 2 | 0 / 0 | 9 / 6 | 7 / 5 | 5 / 10 | 3 / 3 | 3 / 4 | 8 / 10 | 25 / 26 | 4 / 1 | 7 / 11 | 4 / 5 | 3 / 3 | 4 / 6 |
| clean-5000 | add child | 27 / 25 | 2 / 3 | 0 / 0 | 7 / 6 | 9 / 6 | 4 / 6 | 5 / 3 | 3 / 3 | 8 / 11 | 26 / 28 | 6 / 3 | 7 / 11 | 7 / 4 | 5 / 3 | 5 / 6 |
| clean-5000 | fold ~300 | 26 / 30 | 2 / 3 | 0 / 0 | 4 / 4 | 9 / 5 | 7 / 12 | 4 / 4 | 4 / 3 | 8 / 11 | 26 / 32 | 4 / 2 | 6 / 9 | 4 / 5 | 3 / 3 | 4 / 6 |
| clean-5000 | theme switch | 72 / 56 | 6 / 8 | 1 / 4 | 12 / 10 | 13 / 9 | 37 / 23 | 5 / 4 | 7 / 9 | 8 / 10 | 27 / 38 | 7 / 5 | 9 / 14 | 7 / 4 | 8 / 4 | 5 / 6 |
| clean-5000 | no change | 25 / 26 | 3 / 3 | 0 / 0 | 5 / 4 | 8 / 8 | 5 / 8 | 4 / 4 | 3 / 4 | 8 / 11 | 33 / 29 | 5 / 4 | 7 / 11 | 4 / 5 | 3 / 3 | 5 / 6 |
| rope-5000 | cold first pass | 104 / 85 | 12 / 9 | 6 / 4 | 19 / 14 | 16 / 14 | 51 / 41 | 4 / 4 | 6 / 9 | 7 / 7 | 32 / 38 | 9 / 4 | 9 / 12 | 6 / 5 | 8 / 3 | 5 / 7 |
| rope-5000 | type 1 char | 40 / 34 | 2 / 2 | 0 / 0 | 9 / 6 | 12 / 9 | 10 / 14 | 4 / 3 | 4 / 4 | 8 / 10 | 30 / 32 | 6 / 4 | 9 / 13 | 7 / 5 | 9 / 3 | 5 / 6 |
| rope-5000 | add child | 35 / 31 | 3 / 3 | 0 / 0 | 7 / 6 | 14 / 11 | 6 / 9 | 5 / 3 | 5 / 6 | 8 / 10 | 27 / 37 | 8 / 3 | 9 / 13 | 8 / 5 | 7 / 3 | 5 / 6 |
| rope-5000 | fold ~300 | 32 / 46 | 2 / 2 | 0 / 0 | 4 / 4 | 13 / 9 | 7 / 26 | 5 / 4 | 4 / 4 | 8 / 10 | 29 / 35 | 9 / 4 | 8 / 12 | 8 / 5 | 6 / 3 | 4 / 6 |
| rope-5000 | theme switch | 51 / 40 | 5 / 5 | 1 / 0 | 14 / 10 | 9 / 8 | 14 / 12 | 6 / 5 | 9 / 7 | 9 / 10 | 26 / 28 | 5 / 2 | 7 / 10 | 5 / 5 | 3 / 3 | 6 / 7 |
| rope-5000 | no change | 30 / 31 | 2 / 2 | 0 / 0 | 5 / 5 | 12 / 10 | 6 / 10 | 4 / 4 | 6 / 4 | 8 / 11 | 42 / 39 | 8 / 3 | 9 / 13 | 7 / 5 | 3 / 3 | 5 / 6 |
| clean-20000 | cold first pass | 269 / 277 | 79 / 86 | 52 / 56 | 88 / 58 | 46 / 44 | 34 / 47 | 18 / 36 | 17 / 21 | 22 / 35 | 128 / 177 | 32 / 14 | 30 / 53 | 28 / 24 | 23 / 15 | 21 / 35 |
| clean-20000 | type 1 char | 140 / 137 | 12 / 16 | 0 / 0 | 45 / 33 | 30 / 37 | 19 / 26 | 29 / 22 | 13 / 15 | 39 / 57 | 134 / 143 | 26 / 5 | 30 / 51 | 19 / 22 | 15 / 14 | 22 / 36 |
| clean-20000 | add child | 154 / 170 | 12 / 15 | 0 / 0 | 44 / 39 | 41 / 39 | 24 / 37 | 31 / 19 | 11 / 16 | 42 / 60 | 119 / 136 | 21 / 10 | 31 / 48 | 22 / 20 | 14 / 13 | 21 / 33 |
| clean-20000 | fold ~300 | 129 / 144 | 11 / 18 | 0 / 0 | 30 / 23 | 35 / 35 | 22 / 38 | 29 / 20 | 11 / 27 | 43 / 59 | 113 / 152 | 21 / 12 | 29 / 51 | 18 / 23 | 14 / 14 | 22 / 35 |
| clean-20000 | theme switch | 281 / 348 | 27 / 44 | 7 / 11 | 67 / 65 | 57 / 61 | 114 / 118 | 28 / 23 | 21 / 22 | 45 / 56 | 137 / 169 | 33 / 15 | 42 / 64 | 19 / 20 | 14 / 14 | 21 / 34 |
| clean-20000 | no change | 132 / 134 | 13 / 15 | 0 / 0 | 35 / 24 | 38 / 36 | 21 / 28 | 25 / 21 | 14 / 16 | 44 / 63 | 121 / 137 | 25 / 16 | 29 / 49 | 29 / 21 | 29 / 14 | 20 / 34 |
| rope-20000 | cold first pass | 546 / 378 | 128 / 72 | 104 / 49 | 123 / 53 | 93 / 76 | 175 / 141 | 22 / 30 | 34 / 28 | 26 / 36 | 274 / 305 | 51 / 17 | 58 / 60 | 23 / 21 | 14 / 19 | 39 / 32 |
| rope-20000 | type 1 char | 200 / 180 | 18 / 15 | 0 / 0 | 49 / 31 | 67 / 60 | 33 / 40 | 31 / 18 | 16 / 14 | 37 / 54 | 136 / 147 | 27 / 11 | 40 / 69 | 26 / 22 | 26 / 14 | 22 / 37 |
| rope-20000 | add child | 241 / 193 | 23 / 15 | 0 / 0 | 60 / 31 | 68 / 63 | 54 / 52 | 31 / 17 | 17 / 16 | 41 / 54 | 136 / 159 | 31 / 9 | 41 / 62 | 28 / 20 | 32 / 14 | 24 / 35 |
| rope-20000 | fold ~300 | 167 / 190 | 16 / 14 | 0 / 0 | 34 / 28 | 53 / 57 | 35 / 60 | 26 / 24 | 16 / 14 | 40 / 55 | 132 / 156 | 26 / 22 | 40 / 61 | 26 / 21 | 24 / 14 | 23 / 33 |
| rope-20000 | theme switch | 215 / 182 | 39 / 29 | 14 / 8 | 75 / 57 | 37 / 43 | 27 / 32 | 30 / 21 | 16 / 17 | 42 / 65 | 111 / 148 | 24 / 13 | 36 / 52 | 21 / 21 | 13 / 15 | 37 / 35 |
| rope-20000 | no change | 188 / 200 | 19 / 19 | 0 / 0 | 37 / 25 | 65 / 65 | 34 / 61 | 28 / 28 | 16 / 20 | 41 / 64 | 133 / 191 | 28 / 13 | 42 / 62 | 27 / 20 | 27 / 14 | 23 / 31 |
| clean-50000 | cold first pass | 722 / 623 | 259 / 228 | 191 / 180 | 216 / 125 | 110 / 125 | 53 / 70 | 77 / 69 | 48 / 34 | 56 / 98 | 507 / 380 | 76 / 18 | 166 / 133 | 57 / 58 | 43 / 41 | 61 / 90 |
| clean-50000 | type 1 char | 573 / 376 | 61 / 45 | 0 / 1 | 192 / 117 | 124 / 101 | 54 / 73 | 103 / 57 | 35 / 28 | 145 / 154 | 376 / 339 | 71 / 18 | 84 / 126 | 64 / 54 | 46 / 34 | 60 / 81 |
| clean-50000 | add child | 509 / 389 | 52 / 42 | 0 / 0 | 185 / 95 | 130 / 108 | 53 / 65 | 83 / 59 | 31 / 32 | 146 / 146 | 374 / 365 | 95 / 24 | 85 / 123 | 75 / 55 | 78 / 36 | 61 / 85 |
| clean-50000 | fold ~300 | 428 / 363 | 56 / 40 | 0 / 0 | 140 / 69 | 102 / 91 | 54 / 93 | 71 / 60 | 39 / 36 | 119 / 148 | 381 / 360 | 77 / 57 | 83 / 124 | 71 / 51 | 63 / 43 | 60 / 83 |
| clean-50000 | theme switch | 984 / 1623 | 279 / 249 | 170 / 161 | 256 / 267 | 198 / 437 | 149 / 180 | 69 / 213 | 56 / 51 | 125 / 164 | 381 / 1121 | 65 / 64 | 143 / 169 | 67 / 59 | 41 / 48 | 67 / 92 |
| clean-50000 | no change | 578 / 352 | 132 / 60 | 0 / 0 | 143 / 73 | 116 / 101 | 67 / 57 | 64 / 60 | 37 / 25 | 147 / 156 | 362 / 368 | 86 / 21 | 91 / 128 | 76 / 53 | 59 / 38 | 63 / 88 |
| rope-50000 | cold first pass | 795 / 866 | 231 / 157 | 156 / 103 | 187 / 157 | 176 / 208 | 130 / 266 | 62 / 71 | 49 / 39 | 63 / 94 | 396 / 654 | 79 / 50 | 114 / 165 | 72 / 57 | 72 / 42 | 57 / 90 |
| rope-50000 | type 1 char | 540 / 638 | 49 / 82 | 0 / 1 | 180 / 129 | 147 / 217 | 84 / 125 | 84 / 81 | 63 / 50 | 140 / 183 | 557 / 529 | 76 / 82 | 128 / 193 | 54 / 64 | 39 / 45 | 61 / 101 |
| rope-50000 | add child | 653 / 523 | 55 / 42 | 2 / 2 | 183 / 100 | 202 / 175 | 108 / 134 | 103 / 69 | 114 / 36 | 145 / 153 | 540 / 474 | 84 / 67 | 118 / 183 | 66 / 57 | 38 / 45 | 95 / 88 |
| rope-50000 | fold ~300 | 523 / 788 | 58 / 74 | 0 / 0 | 131 / 140 | 159 / 229 | 104 / 173 | 77 / 86 | 41 / 34 | 125 / 228 | 442 / 495 | 73 / 74 | 122 / 178 | 72 / 63 | 49 / 41 | 59 / 95 |
| rope-50000 | theme switch | 841 / 725 | 257 / 242 | 181 / 146 | 232 / 187 | 108 / 157 | 63 / 71 | 79 / 66 | 75 / 36 | 121 / 146 | 427 / 428 | 52 / 25 | 91 / 138 | 71 / 60 | 40 / 40 | 65 / 93 |
| rope-50000 | no change | 929 / 608 | 65 / 46 | 0 / 0 | 130 / 89 | 251 / 267 | 393 / 106 | 71 / 80 | 75 / 42 | 125 / 175 | 542 / 444 | 175 / 38 | 133 / 167 | 73 / 57 | 41 / 41 | 88 / 91 |

Notes: "clone request/result" is a same-thread `structuredClone` (serialise + deserialise); the bracketed columns clone each part alone. The V8 "cold" pass at 5k also pays first-run JIT warm-up. "no change" re-runs the pipeline on an identical document: it costs as much as an edit, so there is no early-out.

Stage exponents (one-char edit and theme switch):

| Stage | V8 type-1-char clean | V8 type-1-char rope | JSC type-1-char clean | JSC type-1-char rope | V8 theme switch clean | JSC theme switch clean |
|---|---|---|---|---|---|---|
| computeWork total | 1.34 | 1.13 | 1.11 | 1.27 | 1.12 | 1.45 |
| computeSizes | 1.52 | 1.46 | 1.36 | 1.60 | 1.65 | 1.47 |
| settleLayout | 1.33 | 1.31 | 1.29 | 1.32 | 1.31 | 1.42 |
| branchSpecs | 1.25 | 1.09 | 1.32 | 1.38 | 1.17 | 1.66 |
| branch mesh | 1.05 | 0.92 | 0.85 | 0.94 | 0.62 | 0.92 |
| fullScene | 1.53 | 1.38 | 1.29 | 1.42 | 1.20 | 1.69 |
| packVertices | 1.04 | 1.18 | 0.85 | 1.08 | 0.93 | 0.74 |
| clone request | 1.26 | 1.23 | 1.19 | 1.26 | 1.22 | 1.22 |
| clone result | 1.17 | 1.26 | 1.12 | 1.21 | 1.15 | 1.44 |

## 5. Hot spots and why they are hot

Line numbers are from the CDP line ticks of the worker profile for 4 one-char edits at 50k (clean), mapped onto the Vite-transformed files; the numbers are per 4 edits unless stated.

1. **Structured clone of the result (worker `self.postMessage` 454 ms self / 4 edits ≈ 113 ms each at 50k; main deserialisation 125 to 155 ms per edit).** `layout.worker.ts compute()` transfers only the packed GPU buffer and the spatial typed arrays. It clones `result.mesh.positions/colors/indices` on purpose ("Keep the CPU branch batch intact on the worker for its next edit"), so the worker keeps one copy, the main thread gets another, and the GPU a third. It also clones `layout.boxes` (Map of 50k objects), `placements` (object with 50k records), `layoutBranches` (50k `BranchSpec` objects with nested p0/p1/colour/fade objects; `drawnBranches` is the same array, deduplicated by the clone), `labelCurves`, `baseScene` (50k `LabelDraw` + rects) and the spatial index's `ids` array. In the stage harness the branch specs are the single most expensive part to clone (84 to 166 ms at 50k in V8, 123 to 193 ms in JSC), then mesh arrays (V8 71 to 95 ms, JSC 18 to 82), placements (54 to 76), scene (57 to 101), boxes (34 to 78).
2. **Request clone (main `Worker.postMessage` + chunking 46 to 58 ms per edit at 50k; worker 34 to 41 ms to deserialise).** `Pipeline.work()` sends `{...doc, layoutPlacements: undefined}` — the whole document every time — plus `placements` (the main thread's last accepted copy of 50k records, which the worker produced in the first place). The worker then throws away its layout cache (`computeWork` calls `this.cache.invalidateAll()`).
3. **Streaming transport at ≥12,000 nodes.** `splitLayoutPayload` cuts every container over 1,400 entries into chunks and the receiver pulls them one message at a time (~290 messages per edit at 50k, each a task turn via `MessageChannel`). `applyLayoutChunk` rebuilds records with `Object.defineProperty` per key (`layout-transport.ts:86`: 110 to 120 ms self per 4 edits in each thread at 50k ≈ 28 ms per edit per thread). The protocol keeps the main-thread longest task short (good) but adds 115 to 390 ms of "unaccounted" latency per edit at 50k.
4. **`settleLayout` (placement.ts; 98 to 192 ms per edit at 50k, 6 to 9 ms at 5k).** For every root it `collect`s all visible nodes into fresh objects with a `...sizeOf(id)` spread (line 35), checks every main-branch group for changes (198), rebuilds `oldBox` objects for the clean groups (208), then writes a new `saved[id]` placement record with three conditional spreads for every visible node (337), and finally iterates `Object.entries(previous.nodes)` over all 50k previous placements (356-357) to carry forward hidden nodes. `previous.nodes` and `saved` are 50k-key objects in dictionary mode. Each one-node edit therefore allocates ~150k objects here. The tidy layout itself (`layoutMainBranch` for the one dirty main branch, `tidyTree`) is only ~2 to 7 ms per edit.
5. **`computeSizes` (pipeline.ts; 45 to 61 ms per edit at 50k with only one label re-measured).** For every node it builds a cache key string: a template string with the node text, depth, `JSON.stringify(node.style)`, a ~150-character `themeSizeKey` and, for non-default local themes, another joined key (484), plus `treeThemes(...)`'s per-node `themeFor` walk (`generated-style.ts:51`, 51 to 103 ms self per 4 ops) and `doc.nodes[id]` dictionary lookups (442). Measuring is cached by that key, so the cost is the keys, not the text.
6. **Text measurement cache thrash above 30,000 labels.** `render/text.ts layoutLabel` clears its whole `layoutCache` when it passes 30,000 entries. With 50,000 distinct labels every theme switch and every load re-measures all labels: `measureText` 160 to 200 ms per pass at 50k in both engines, versus 7 to 14 ms for a warm theme switch at 20k. (`measureText` is native; it shows up as 297 ms self on 2 loads and 446 ms on 4 theme switches in the worker profile.)
7. **Branch specs (`buildBranchSpecs` in branches.ts + `Pipeline.branchSpecs`; 100 to 200 ms per edit at 50k).** Per branch: two style resolutions (`res.get` for child and parent, branches.ts:166-168, with `colorOf`, `branchOf`, `readableInk`, `branchWidthAt`), `parseColor` of a CSS string, `nodePadding`, a new spec object with nested points; then `Pipeline.branchSpecs` walks all specs again for picture anchors and curved-label checks (`styleResolver.themeFor` per spec, pipeline.ts:643). Nothing is reused across passes.
8. **Branch mesh (`BranchMeshCache.build`; 46 to 154 ms per edit at 50k even when 1 to 5 branches changed).** The cache reuses unchanged branches by copying them out of the previous batch into brand-new full-size arrays one branch at a time (`tessellate.ts` 410-414: `positions.set(previous.positions.subarray(...))` ×3 per branch) after a 40-field `sameSpec` comparison per branch. For flat branches this is not faster than starting over: tessellating all 50k clean branches from scratch takes 33 to 44 ms (`lod.py`), the "reuse" path 46 to 54 ms.
9. **`packVertices` (28 to 113 ms per edit at 50k).** Re-packs every vertex into the interleaved GPU layout after every edit (`packMeshVertices` loops with `Math.round` + clamps per colour channel).
10. **GPU upload (`renderer.uploadMesh`; 20 to 195 ms per edit at 50k, 1 to 3 ms at 5k).** `setScene` sees a new `scene.branches` object and the next `render` deletes and recreates the VAO and both buffers with `bufferData`: 66 to 140 MB of vertices plus 36 to 47 MB of indices per edit. `branchIndex` and `viewport.update` add 1 to 20 ms.
11. **`fullScene`/`buildScene` in the worker (57 to 103 ms per edit at 50k).** One `LabelDraw` and rect per node every pass, plus two full scans of `canvasLayout.boxes` for generation-failed badges and sketches even when no node has them (pipeline.ts `fullScene`, the `!this.theme.lean` loops). The result is then cloned (item 1).
12. **Main-thread side effects of each edit (CPU profile, 50k, 4 one-char edits): `serializeDoc` 209 ms, `docAutosave` (mock host, dev only) 110 ms, `revisionKey` 68 ms, `NodeBadges.svelte:29` 33 ms, `subtreeBounds` 23 ms.** `queueAutosave` runs `persistRecovery` after every edit once layout settles: it serialises the whole document to JSON and hashes the string with FNV for the undo sidecar on the main thread (~50 + 17 ms per edit at 50k, ~3 + 2 ms at 5k). The mock host's localStorage write is dev-only; the Tauri path sends the same multi-MB string over IPC instead (not measured).

**Direct answers to the questions in the brief**

- *How big is the request, is the whole document sent every edit?* Yes: the whole document (634 KB JSON at 5k, 6.5 MB at 50k) plus the previous placements, every edit, every keystroke. Request clone 8 to 11 ms at 5k, 120 to 230 ms at 50k (same-thread `structuredClone`, V8 and JSC).
- *Which buffers are transferred, which cloned?* Transferred: `mesh.gpuVertices` (packed), `baseScene.overlayMesh` arrays, the spatial index's typed arrays. Cloned: the CPU branch mesh (positions/colours/indices, relief arrays and branch spans), and every object graph listed in hot spot 1. Note that transferring the spatial arrays detaches them in the worker, so the worker rebuilds its spatial index on every pass (cheap: 1 to 6 ms at 50k).
- *How long does the result take to arrive and deserialise?* Worker serialise 10 to 16 ms at 5k, 110 to 220 ms at 50k; main deserialise 15 to 19 ms at 5k in one task, 120 to 180 ms at 50k spread over ~290 tasks (largest: the header with the mesh, 17 to 23 ms).
- *Adoption on the main thread?* `adoptWork` itself is < 1 ms (`Object.assign` + `spatial.adopt`), and the scene arrives prebuilt, so `fullScene` on the main thread is 0 in these runs. The main-thread cost is deserialisation plus the first render's upload.
- *Does a one-node edit redo work for the whole map?* Text measurement: no (1 label re-measured, but all 50k keys rebuilt). Layout of every subtree: no for the tidy solve (only the dirty main branch is re-solved by `layoutMainBranch`), yes for placement bookkeeping. Tessellation of every branch: no (1 to 71 branches re-tessellated) but every vertex of every branch is copied, re-packed, re-sent and re-uploaded. Scene: yes, rebuilt for all nodes.

## 6. Ranked experiments

Gains are for the metric named; evidence is from §3 to §5. "Independent" means it touches files no other proposal in the same group touches, so it can run in its own worktree without merge conflicts. Several proposals touch `ui/pipeline.ts` or `ui/layout.worker.ts`; I mark those conflicts.

### E1. Stop cloning the CPU branch mesh back to the main thread
- Hypothesis: the main thread needs the branch mesh only for `pickBranch` (branch-index.ts), culling (`renderer.visibleMesh` uses `indices` + `branchSpans`) and fold animation (`layout-animation.ts`). It can use the transferred packed buffer (positions are its first two floats + origin) and a transferred index buffer, so the f64 positions and f32 colours need not cross at all.
- Change: `ui/layout.worker.ts compute()` (transfer `indices` and `branchSpans` from a copy, stop sending `positions`/`colors`/`relief` arrays); `core/geometry/branch-index.ts pickBranch` and `ui/layout-animation.ts` read positions from `gpuVertices` (stride 3/5 floats flat, `reliefStride` for relief); `render/renderer.ts uploadMesh/uploadRelief` unchanged.
- Expected: removes 16 MB (5k) / 142 to 186 MB (50k) from every edit. Same-thread clone of the mesh part: 4 to 9 ms at 5k, 71 to 95 ms at 50k (V8), 18 to 82 ms (JSC). Main-thread memory −16 MB to −186 MB. Latency at 5k maybe −5 to −8 ms.
- Risk: low to medium (picking precision with relative float32 coordinates is what the GPU already draws; culling needs the index buffer on the CPU, so transfer a copy rather than drop it). Effort: small. Independent: touches layout.worker.ts (conflicts with E2, E3, E9).

### E2. Compact, typed transport for the layout result (boxes, placements, specs, labels)
- Hypothesis: most of the result cost is object graphs, not bytes. Send boxes as SoA typed arrays (x, y, w, h f64; depth, side, flow, mainBranch int8/int32) indexed by a dense node index, with the id list sent only when the visible set changes; do not send `layoutBranches`/`drawnBranches` at all unless a consumer needs them (main uses them for presentation scope, filtered dimming and fold animation; those could ask the worker or rebuild from boxes); send placements only when the main thread needs them (save, undo snapshot) or as typed arrays.
- Change: `ui/pipeline.ts computeWork/adoptWork` (and the shape of `LayoutResult`), `ui/layout.worker.ts`, `ui/controller.svelte.ts` (fields consumed after adopt), `ui/layout-animation.ts`, consumers of `pipeline.layout.boxes` keep a `Map` facade or are moved to index-based access.
- Expected: worker serialise + main deserialise for a one-char edit: 26 ms → ~5 ms at 5k (the 16 ms main-thread long task becomes ~2 to 4 ms); 266 to 295 ms → ~40 ms at 50k. Evidence: same-thread clone of specs + placements + boxes + scene is 18 to 30 ms at 5k and 250 to 400 ms at 50k (§4, V8 and JSC), typed arrays transfer for free.
- Risk: medium (many readers of `layout.boxes` and `placements` on the main thread). Effort: medium to large. Independence: conflicts with E1, E3, E8 on pipeline.ts / layout.worker.ts; best done as one track with E1.

### E3. Worker-side document replica; send op diffs instead of the whole document
- Hypothesis: `Pipeline.work()` sends the whole doc and the placements each edit, and the worker discards its layout cache each time. A replica updated with the same `Op` list (`applyOps`, pure core code) removes the request clone and lets the worker keep caches between edits.
- Change: `ui/controller.svelte.ts` (`onChange` collects `c.edit.forward`; `requestLargeLayout` posts ops + a sequence number; full snapshot on load, undo across a load, or mismatch), `ui/layout.worker.ts` (replica + resync), `ui/pipeline.ts computeWork` (no `invalidateAll`; use `invalidateTouched`).
- Expected: request side per edit: post 3 ms + worker deserialise 4 to 8 ms at 5k → < 1 ms; at 50k 46 to 58 ms main + 34 to 41 ms worker → < 1 ms, and the 115 to 390 ms of streaming round trips mostly disappear when combined with E1/E2. Main-thread time per edit at 50k −50 ms.
- Risk: medium to high (replica divergence; placements are owned by the worker after this, so saving needs them from the worker or from E2's stream). Effort: medium. Independence: conflicts with E2 on layout.worker.ts/pipeline.ts; does not touch core.

### E4. Persistent, patchable branch-mesh buffers (incremental tessellation + `bufferSubData`)
- Hypothesis: one-node edits re-tessellate 1 to 71 branches but copy all 3.3 to 4.4M vertices into new arrays, re-pack them, ship them and re-upload them. Allocate per-branch vertex/index slots in a persistent buffer (free list, or one chunk per main branch so only touched chunks are rebuilt), patch changed branches in place, ship only changed ranges, and update the GPU with `bufferSubData`.
- Change: `core/geometry/tessellate.ts BranchMeshCache` (and `reliefBatch`/`tessellateBatch` writing into slots), `render/mesh-vertices.ts` (pack per range), `render/renderer.ts uploadMesh/uploadRelief/visibleMesh` (sub-range updates, index rebasing), `ui/layout.worker.ts` (send ranges), `core/geometry/branch-index.ts`.
- Expected: per one-node edit at 50k: mesh 46 to 154 ms + pack 28 to 113 ms + upload 20 to 195 ms → a few ms; at 5k: 4 to 10 + 3 to 5 + 1 to 3 ms → < 1 ms. Also removes the whole-mesh header message that is the largest main-thread deserialisation task. Evidence: hot spots 8 to 10. A cheaper first step is per-main-branch chunks: `settleLayout` already leaves untouched main branches in place, so most edits dirty one chunk of ~1/9 of the mesh in these maps.
- Risk: medium (relief materials share one buffer between lit and shadow draws; culling spans; fold animation). Effort: large (chunk variant: medium). Independence: core/geometry + render; conflicts with E10 (GPU tessellation replaces it) and lightly with E1 on layout.worker.ts.

### E5. Incremental `settleLayout`
- Hypothesis: for clean main branches the function rebuilds boxes, placement records and the final carry-over pass for all nodes. Reuse previous `saved` records and boxes untouched when the root did not move; keep hidden-node placements in a separate structure so the closing `Object.entries(previous.nodes)` pass is not needed; replace the dictionary objects with Maps or index arrays.
- Change: `core/layout/placement.ts settleLayout/collect/oldBox`; maybe `core/types.ts LayoutPlacements` (coordinator-owned contract).
- Expected: 98 to 192 ms → ~20 to 40 ms per one-node edit at 50k; 6 to 9 ms → 1 to 2 ms at 5k (V8; JSC is already ~40% faster here: 95 to 129 ms at 50k).
- Risk: medium (placement semantics are subtle: folds, pins, variants). Effort: medium. Independence: high (core/layout only).

### E6. Incremental sizes: per-node dirty flags instead of per-node key strings
- Hypothesis: `computeSizes` costs 45 to 61 ms per edit at 50k building ~50k key strings (with `JSON.stringify(style)`) and walking `treeThemes`. With touched ids from the edit (E3 gives them to the worker; today the main pipeline already gets `c.touched`), only touched nodes and descendants whose depth or inherited theme changed need re-keying; theme switches invalidate all.
- Change: `ui/pipeline.ts computeSizes` (and `core/model/generated-style.ts treeThemes` memoised per pass for unchanged subtrees).
- Expected: −40 to −55 ms per edit at 50k; −2 ms at 5k. Risk: low to medium (stale sizes if a key input is missed: style, sticker, depth, numbering, picture frame). Effort: small to medium. Independence: pipeline.ts (conflicts with E2/E3/E8 in the same file but different functions; mergeable).

### E7. Text-layout cache sized to the map (or LRU)
- Hypothesis: `layoutLabel` clears its 30,000-entry cache, so above 30k labels every load and theme switch re-measures everything.
- Change: `render/text.ts layoutLabel` (cap ≥ 2× node count, or a two-generation LRU; optionally key unwrapped labels without `maxWidth`).
- Expected: theme switch / warm reload at 50k: −160 to −200 ms (both engines); no change at ≤ 20k. Memory: a TextLayout per label (~100 to 200 B). Risk: low. Effort: small. Independence: high.

### E8. Incremental branch specs (+ cheaper style resolution)
- Hypothesis: specs for branches whose two boxes, styles and theme did not change are identical; reuse them (which also makes `sameSpec` an identity check in the mesh cache). Cache parsed colours per style string; avoid the second full pass in `Pipeline.branchSpecs` when no pictures and no curved labels exist.
- Change: `core/geometry/branches.ts buildBranchSpecs`, `core/geometry/style.ts` (`createStyleResolver` caching), `ui/pipeline.ts branchSpecs`, `core/geometry/tessellate.ts sameSpec` (fast path on identity).
- Expected: 100 to 200 ms → 10 to 30 ms per one-node edit at 50k; 7 to 14 ms → 1 to 3 ms at 5k. Risk: medium (fan joins, timeline paths, rope leaf counts and quilling rings depend on siblings or whole subtrees: invalidate the parent's children and ancestors for those materials). Effort: medium. Independence: core/geometry; conflicts with E4 on tessellate.ts only at `sameSpec`.

### E9. Incremental scene, or labels built from boxes on the main thread
- Hypothesis: `fullScene` rebuilds and the transport ships 50k `LabelDraw` objects every edit (57 to 103 ms build, 57 to 101 ms clone at 50k). Either patch the label/rect arrays for dirty nodes in the worker and ship deltas, or ship nothing and let the main thread derive labels lazily per visible tile from boxes + doc (the renderer culls anyway).
- Change: `ui/pipeline.ts fullScene`, `core/geometry/scene.ts buildScene`, `render/renderer.ts`/`scene-viewport` (accept stable arrays with dirty ranges). Also a trivial win: skip the two full scans for failure badges and ink unless some node has `svgArtError`/`pictureArtError`/`sketch` (track sets).
- Expected: −50 to −150 ms per edit at 50k, −5 to −10 ms at 5k. Risk: medium (renderer caches keyed on array identity: `sceneDirty`, `labelEntries`). Effort: medium (badge/ink skip: small). Independence: conflicts with E2 on pipeline.ts; the renderer part conflicts with E4.

### E10. GPU-expanded branches (one instance per branch, geometry in the vertex shader)
- Hypothesis: a branch is a tapered cubic ribbon with caps; 66 to 100 vertices per branch (3.3 to 4.4M at 50k) could be generated from ~16 to 24 floats per branch (p0, two control points, p1, w0, w1, colour, fade, flags, seed) with instanced drawing and a fixed or LOD-bucketed segment count. That removes tessellation, packing, mesh transport and most of the upload: instance data at 50k ~5 MB instead of 66 to 140 MB + 36 to 47 MB of indices.
- Change: `render/shaders.ts` (new branch VS per material), `render/renderer.ts` (instanced draw, culling by per-instance bounds), `core/geometry/tessellate.ts` kept for export/headless and hit tests or replaced by analytic curve distance in `branch-index.ts`.
- Expected: per edit at 50k −100 to −300 ms (mesh + pack + mesh clone + upload, §5 items 8 to 10, E1); at 5k −10 to −20 ms. GPU memory −100 to −190 MB at 50k. Frame cost: the vertex shader evaluates the cubic per vertex; with ~3M generated vertices per frame this is not free, but it is what the GPU already draws now (not measured).
- Evidence caveat: tessellation itself is cheap when done from scratch (36 ms flat / 74 ms rope at 50k); the gain is in what follows it. Lowering `MESH_DETAIL_ZOOM` from 4 to 1 only cuts vertices by 16 to 36% (`lod.json`), so GPU expansion, not coarser CPU meshes, is the lever on vertex volume.
- Risk: high for the dimensional materials (rope twist and ply, quilling walls and scroll rings, arcs plugs and lift, clay shadow spread, whips, round caps, tip dots, curved underlines, organic wobble) and for exact visual parity; medium for flat styles. Effort: large (flat styles first: medium to large). Independence: render + shaders; conflicts with E4 (alternative to it).

### E11. Autosave off the edit path
- Hypothesis: every edit serialises the whole document and FNV-hashes it on the main thread once layout settles (~67 ms per edit at 50k, ~5 ms at 5k, plus the host write).
- Change: `ui/controller.svelte.ts queueAutosave/persistRecovery` (debounce to idle, e.g. 1 to 2 s after the last edit), `ui/undo-storage.ts revisionKey` (hash in the worker or hash fewer bytes), optionally serialise in the worker replica (E3).
- Expected: main-thread −60 to −70 ms per keystroke at 50k, −5 ms at 5k; no change in recovery semantics beyond the debounce window. Risk: low. Effort: small. Independence: high (controller autosave section only). Not strictly rendering, but it is the largest main-thread item in the 50k typing profile after deserialisation.

### E12. Cheaper streaming protocol (until E1 to E3 make it unnecessary)
- Hypothesis: `applyLayoutChunk` uses `Object.defineProperty` per key on dictionary objects, and each 1,400-entry chunk costs a message round trip.
- Change: `ui/layout-transport.ts` (plain assignment into `Object.create(null)` targets; chunk by bytes, e.g. 1 to 2 MB, not by entry count; push chunks instead of pull when the main thread is idle).
- Expected: −20 to −30 ms per edit per thread at 50k from `applyLayoutChunk`; −50 to −150 ms of round-trip latency at 50k; nothing below 12,000 nodes. Risk: low. Effort: small. Independence: high (one file).

### E13. Parallel tessellation across workers (cold builds only)
- Hypothesis: on load and theme switch the mesh phase is 50 to 180 ms at 50k (plus 35 to 75 ms packing); splitting specs by main branch across 3 to 4 workers that return transferable buffers could cut that phase ~3×.
- Change: `ui/layout.worker.ts` (fan-out), new tessellation worker module, `core/geometry/tessellate.ts` (build per range).
- Expected: −50 to −150 ms on load/theme switch at 50k; ≤ 10 ms at 5k; nothing for one-node edits (they re-tessellate 1 to 71 branches). Risk: low to medium (deterministic ordering of indices). Effort: medium. Independence: medium.

### E14. Rust to WebAssembly for numeric kernels
- Which kernels are pure number crunching: `tessellateBatch`/`reliefBatch`/`emitQuill` (curve sampling, normals, caps), `packMeshVertices`/`packReliefVertices`, `tidyTree`, `SpatialIndex.build`, `Occupancy`. Their share of a one-char edit at 50k: tessellate+copy ~28 ms, pack ~28 ms, tidy ~2 ms, spatial ~1.5 ms; of a cold theme switch at 50k: mesh 63 to 180 ms, pack 36 to 75 ms.
- Which are object/string work and would not gain: `computeSizes` keys, style resolution, `buildBranchSpecs`, `settleLayout` bookkeeping, `buildScene`, structured clone. Moving them to WASM would add marshalling of JS objects in and out.
- Honest assessment: the JS kernels already use typed arrays and monomorphic loops; a 1.5 to 3× gain on tessellation/packing is plausible, i.e. ~20 to 40 ms per edit at 50k and ~50 to 150 ms on a cold 50k theme switch, but the specs would have to be marshalled into a flat buffer first (50k × ~25 fields), which eats part of it, and E4 or E10 remove most of the same work outright. Worth it only after E1 to E4, and only if the inputs are already SoA (E2). Risk: medium (toolchain, two implementations of every material until parity). Effort: large. Independence: high (new crate + glue in core/geometry).

### E15. Not needed / low value as currently measured
- **Spatial index:** 1 to 6 ms per pass at 50k; leave it.
- **Lower `MESH_DETAIL_ZOOM`:** −16 to −36% vertices only (see E10). Small, risky for close-up quality.
- **Tidy solver rewrite (in any language):** ~2 ms per edit at 50k.

### Suggested order and parallel tracks
Track A (transport): E1 → E2 → E3 → E12 (same files; one worktree). Track B (layout): E5 + E6 (core/layout and `computeSizes`). Track C (geometry): E8 then E4 (or E10 as the radical alternative). Independent quick wins in their own worktrees: E7, E11, the E9 badge/ink skip. E13 and E14 last, re-measured after A to C.

## 7. What the profile does not support

- **Rewriting layout in Rust/WASM for speed.** The layout math is a few ms at 50k; the cost is bookkeeping and allocation around it (§5 item 4).
- **WASM for sizes, specs, scene or placement.** These are dominated by strings, objects and Map/dictionary lookups; WASM would add marshalling.
- **More workers as the main fix for edits.** One-node edits re-tessellate 1 to 71 branches; parallelism helps only cold builds (E13), and every extra worker adds the same transport problem.
- **WebGPU or native rendering (GPUI/wgpu) to fix the rebuild path.** The rebuild path is CPU and transport bound; frame rendering was not in scope and was not measured here. A native renderer would remove structured clone between threads (shared memory), which is a real gain, but E1 to E3 get most of that inside the WebView.
- **Reducing mesh detail as a main lever** (−16 to −36% vertices).
- **Panning cost** was not re-measured; nothing here suggests it is the bottleneck at 5k.

## 8. Not verified, caveats

- WebKit numbers come from Playwright's WebKit 27.2 build on the main thread of a page, not from WKWebView inside Tauri, and not inside a worker. The Tauri host's autosave IPC path was not measured (the dev browser uses the mock host).
- E2E profiles at 250 µs sampling slow the code they measure; timings in §3 come from runs without the profiler, function rankings from runs with it.
- Synthetic maps only: 9 main branches, depth ≤ 6 plus "Extra N" leaves, one root, no pictures, no notes, no cross-links, no canvas elements. Real maps with fewer, larger main branches would make per-main-branch incremental schemes (E4 chunk variant, E5) less effective.
- The fold test toggles a depth-2 node (288 to 305 nodes); folding a main branch or the root's children would take the `rebuild`/`natural()` path, which recomputes the full layout (`layoutDoc`) because the worker invalidates the layout cache every pass. Not measured.
- GPU time was not measured; "upload" is CPU time inside `bufferData` on the main thread.
- Estimated gains are from component timings, not from implemented changes.

## 9. Artifacts

- Scripts: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/rebuild-profiler/harness.py`, `init.js`, `worker-inject.js`, `micro.py`, `micro.js`, `lod.py`, `lod.js`.
- Raw runs: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/rebuild-profiler/runs/timing-*.json` (E2E events), `prof-*.json` (aggregated profiles), `prof-main-*.cpuprofile` and `prof-worker-*.cpuprofile` (open in DevTools), `micro-chrome-v1.json`, `micro-webkit-v1.json`, `lod.json`, `summary-e2e.json`, `summary-micro.json`, `tables.md`.
- Isolated server source: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/rebuild-profiler/head/radiant` (HEAD 5450267, `vite.config.js` edited only there to set `cacheDir`).
