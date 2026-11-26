# Radiant rendering autoresearch: report

25 November 2026. Baseline `9992500`, final `132bfd2` (branch `autoresearch-final`). The final branch was merged into the working branch on 26 November (`b79fd76`); the public repository was started from a single fresh commit, so the commit ids in this report refer to the original local history.

## Summary

The loop ran 40 experiments in two rounds on top of five studies; 26 were kept and merged, 7 were built and discarded, 4 were dropped before building because a measurement showed they could not pay, and 3 were measured but not merged. Against the baseline, on the fixed benchmark (production builds, three interleaved rounds, both engines):

| | Chrome | WebKit |
|---|---|---|
| Overall score (geometric mean of the headline metrics, ms; lower is better) | 68.9 → 37.6 (0.55x) | 70.8 → 34.3 (0.48x) |
| Rebuild path (load, theme switch) | 0.70x | 0.52x |
| Interaction (edit, fold) | 0.46x | 0.41x |
| Frame cost (script and GPU per frame) | 0.51x | 0.53x |
| Dimensional materials only | 0.61x | 0.52x |

The noise band of the score is 2 to 4% (measured by comparing a build with itself), and two commits that changed no code measured 1.00 to 1.02, so these differences are far outside noise.

The three results that matter most:

- **An edit on a 50,000-node map takes about a third of the time it did**: 809 → 289 ms in Chrome and 894 → 266 ms in WebKit. At 20,000 nodes it is 300 → 121 ms and 340 → 121 ms.
- **Panning with the whole 50,000-node map in view costs a fifth of the script time**: 3.8 → 0.8 ms per frame in Chrome, 1.9 → 0.4 ms in WebKit.
- **Memory fell sharply for flat, Soft clay and Rope maps**: the JS heap after loading 50,000 nodes went from 275 to 75 MB, and WebGL buffers from 104–183 MB to 5–6 MB (plus a 6 to 12 MB record texture the benchmark does not count).

## Final numbers, baseline → final

| Metric | Chrome | WebKit |
|---|---|---|
| Load, 5,000 nodes | 121 ms → 109 ms (0.91x) | 137 ms → 110 ms (0.80x) |
| Load, 20,000 nodes | 417 ms → 301 ms (0.72x) | 444 ms → 314 ms (0.71x) |
| Load, 50,000 nodes | 1022 ms → 734 ms (0.72x) | 1003 ms → 746 ms (0.74x) |
| Edit (add a node), 5,000 | 101 ms → 67.7 ms (0.67x) | 102 ms → 67.7 ms (0.66x) |
| Edit, 20,000 | 300 ms → 121 ms (0.40x) | 340 ms → 121 ms (0.36x) |
| Edit, 50,000 | 809 ms → 289 ms (0.36x) | 894 ms → 266 ms (0.30x) |
| Fold and unfold, 5,000 | 213 ms → 129 ms (0.61x) | 220 ms → 137 ms (0.62x) |
| Fold and unfold, 20,000 | 571 ms → 247 ms (0.43x) | 680 ms → 234 ms (0.34x) |
| Fold and unfold, 50,000 | 1546 ms → 563 ms (0.36x) | 1779 ms → 570 ms (0.32x) |
| Full rebuild (theme switch), flat, 5,000 | 111 ms → 85.9 ms (0.77x) | 151 ms → 86.8 ms (0.58x) |
| Full rebuild, flat, 50,000 | 1059 ms → 513 ms (0.48x) | 1353 ms → 486 ms (0.36x) |
| Full rebuild, Rope, 5,000 | 154 ms → 102 ms (0.67x) | 236 ms → 102 ms (0.43x) |
| Full rebuild, Rope, 50,000 | 1161 ms → 615 ms (0.53x) | 1653 ms → 539 ms (0.33x) |
| Full rebuild, Soft clay, 50,000 | 1117 ms → 702 ms (0.63x) | 1156 ms → 644 ms (0.56x) |
| Full rebuild, Lifted arcs, 50,000 | 1185 ms → 761 ms (0.64x) | 1238 ms → 657 ms (0.53x) |
| Full rebuild, Paper quilling, 50,000 | 1112 ms → 694 ms (0.62x) | 1752 ms → 672 ms (0.38x) |
| Script per frame, whole map, flat, 50,000 | 3.83 ms → 0.80 ms (0.21x) | 1.90 ms → 0.38 ms (0.20x) |
| Script per frame, whole map, Rope, 50,000 | 4.89 ms → 0.80 ms (0.16x) | 2.05 ms → 0.41 ms (0.20x) |
| Script per frame, whole map, Soft clay, 50,000 | 5.77 ms → 1.30 ms (0.23x) | 3.44 ms → 1.04 ms (0.30x) |
| Script per frame, zoom 1, flat, 50,000 | 0.34 ms → 0.30 ms (0.90x) | 0.75 ms → 0.59 ms (0.78x) |
| Script per frame, all zooms, flat, 5,000 | 0.41 ms → 0.30 ms (0.74x) | 0.47 ms → 0.37 ms (0.79x) |
| GPU per frame, flat, 50,000 (Chrome only) | 4.04 ms → 1.31 ms (0.32x) | n/a |
| GPU per frame, Rope, 50,000 (Chrome only) | 3.24 ms → 3.55 ms (1.10x) | n/a |
| GPU per frame, Soft clay, 50,000 (Chrome only) | 3.72 ms → 3.47 ms (0.93x) | n/a |
| GPU per frame, flat, 5,000 (Chrome only) | 1.34 ms → 0.46 ms (0.34x) | n/a |
| JS heap after load, 50,000 (Chrome only) | 275 MB → 75 MB (0.27x) | n/a |
| WebGL buffers, flat, 50,000 | 104 MB → 5 MB (0.05x) | 104 MB → 5 MB (0.05x) |
| WebGL buffers, Rope, 50,000 | 183 MB → 6 MB (0.03x) | 183 MB → 6 MB (0.03x) |
| WebGL buffers, Paper quilling, 50,000 | 153 MB → 152 MB (0.99x) | 153 MB → 152 MB (0.99x) |
| Longest main-thread task while editing and panning, 50,000 (Chrome only) | 91.0 ms → 87.0 ms (0.96x) | n/a |

What did not improve, or got worse:

- **GPU time per frame for Rope at 50,000 nodes rose about 10%** (3.24 → 3.55 ms in Chrome). Rope is now expanded in the vertex shader, which trades a little GPU time per frame for a much cheaper rebuild and far less memory.
- **Lifted arcs and Paper quilling still use the CPU-built mesh**, so their GPU memory is unchanged (153 MB for Paper quilling at 50,000 nodes). Their rebuilds are faster only through the shared work.
- **The longest main-thread task while editing a 50,000-node map is unchanged** at about 87 to 91 ms. It is now the autosave that runs after the frame (serialising the document and hashing it), which no kept experiment moved off the main thread.
- **Panning zoomed in on a 5,000-node map** was already cheap (0.3 to 0.5 ms of script per frame) and moved only slightly.

## After round 1 only

For reference, the merged round-1 result (`b30896c`) measured against the baseline in its own official run:

| | Chrome | WebKit |
|---|---|---|
| Overall score | 68.2 → 44.8 (0.66x) | 68.9 → 42.5 (0.62x) |
| Rebuild path | 0.82x | 0.72x |
| Interaction | 0.70x | 0.61x |
| Frame cost | 0.49x | 0.53x |
| Edit, 50,000 nodes | 787 ms → 457 ms (0.58x) | 891 ms → 442 ms (0.50x) |

Round 2 took the score from about 0.66 / 0.62 of the baseline to 0.55 / 0.48.

## Answers to the questions asked

**Rust and WebAssembly.** Tested twice. In isolation, a faithful Rust port of flat tessellation ran 2x faster than the TypeScript with bit-identical output (study S3). Built into the app and measured end to end (M3), it gave nothing: the official ratio was 1.03 in Chrome and 1.02 in WebKit, the same as a commit with no code change. Tessellation was only 10 to 20% of a rebuild, about 15 ms of the WebAssembly time went on copying results out of its memory, and it held 217 MB that is never released. It was discarded. Two things beat it: a typed-array rewrite of the layout kernel in plain TypeScript (M5), and not tessellating on the CPU at all (G1 to G5).

**Web Workers.** The app already did its heavy pass in one worker. More workers were studied (S3) and not built (M4): splitting plain JavaScript across workers is slower in WebKit because the inputs must be copied to each worker (78 to 113 ms at 50,000 nodes), and the best case for a WebAssembly pool was about 25 ms out of a 1,000 ms rebuild. The large win was in how the one worker talks to the main thread (T1 to T6).

**Native rendering (GPUI, wgpu).** One spike was done before the decision to stay web-based (S4). GPUI could not draw the 50,000-node map with its public API. wgpu was fast, but its advantage came from not re-uploading index data every frame, which experiment F1 then fixed in WebGL. No further native work was done.

**Moving work to the GPU.** This was the most effective advanced idea. Branches are now sent as one small record each and expanded into ribbons by the vertex shader, for the flat styles and for Soft clay and Rope.

## Everything that was tried

"Official score ratio" is the candidate divided by its parent on the fixed benchmark; below 1 is better. "Short run" means 5,000 and 50,000 nodes in flat and Rope only, three rounds. A dash means the experiment has no official per-commit run: the queue was cut short by the time limit, so the evidence is the experiment agent's own screening (one benchmark round or its own interleaved probe, taken while other agents were using the machine). Every kept experiment is included in the final merged measurement above.

### Studies

| ID | What was tried | Outcome | Official score ratio (Chrome / WebKit) | Evidence from the experiment’s own measurements | Commit |
|---|---|---|---|---|---|
| S1 | Profile of the rebuild path | study | — | Every edit redid work for the whole map; moving data cost about as much as computing it. One-node edit: 71–84 ms at 5k, 290–340 ms at 20k, 0.9–1.8 s at 50k. |  |
| S2 | Profile of the frame path and GPU | study | — | Panning cheap except whole-map view at 50k (2.4–4.4 ms script). GPU cost dominated by blended overdraw and 4x multisampling. WebKit ~40x slower per label raster. |  |
| S3 | Rust/WebAssembly and workers, measured in isolation | study | — | Flat tessellation kernel 2x faster in wasm (50k: 91→33 ms Chrome, 67→32 ms WebKit), bit-identical; copy-out costs 12–40 ms. Layout: typed-array TypeScript gets most of the wasm gain. JS worker pool slower in WebKit; wasm pool 2.5x at 8 workers. SharedArrayBuffer not practical in Tauri on macOS. |  |
| S4 | Native rendering spike: GPUI and wgpu | study (closed: owner chose web-only) | — | GPUI 0.2.2 cannot draw the 50k map (no custom shaders or retained buffers; 36 ms/frame at 5k). wgpu matches WebGL once WebGL stops re-uploading indices each frame. Screen was locked, so real 120 Hz presentation was not measured. |  |

### Round 1

| ID | What was tried | Outcome | Official score ratio (Chrome / WebKit) | Evidence from the experiment’s own measurements | Commit |
|---|---|---|---|---|---|
| F1 | Draw visible branch runs from the resident index buffer; skip culling when the whole map is in view | kept | 0.84 / 0.91 | Script per frame, 50k whole map: clean 3.47→0.94 ms, rope 4.10→0.92 (Chrome); 1.92→0.75 (WebKit). | `270ddf3` |
| F2 | Blending off for fully opaque branch meshes | kept | 0.99 / 1.01 | GPU per frame at 50k zoom 1 (Chrome): clean 3.51→1.24 ms, rope 3.44→1.98. Within noise on the overall score. | `b3ab144` |
| F3 | Rect and shadow instances stay on the GPU at whole-map view | kept | 1.00 / 0.97 | Script per frame at whole map: 50k soft-clay 1.96→1.44 (Chrome), 2.14→1.35 (WebKit). GPU buffers +6% for soft-clay. | `9e9b2a6` |
| F5 | No multisampling while the camera moves; full 4x frame 120 ms after it stops | kept | 0.97 / 1.03 | Probe (Chrome GPU, moving frames, 50k): soft-clay whole map 6.16→2.17 ms, rope zoom 1 2.20→1.07. Resting frames bit-identical in both engines. Edges stair-step while moving. | `a1823d8` |
| F4 | Coarse index buffer for the branch mesh below zoom 0.02 | kept (visual trade-off) | 1.00 / 0.99 | Probe (Chrome GPU, 50k whole map): clean ~1.1→~0.45 ms; triangles 3.0M→0.57M. 0.005–0.05% of pixels change at that zoom. | `4440c91` |
| F6 | Quarter-resolution shadow layer while the camera moves | discarded | — | At most 0.1–0.25 ms GPU, rounds overlap; visibly softer shadows. Reverted in 74f9878. | `726e12e` |
| L1a | Text-layout cache sized to the map | kept | run not usable | Screening: rebuild at 50k clean 1123→995 ms (Chrome), 1338→1068 (WebKit). The official run for this commit is not usable (taken while the machine was busiest; rounds disagree). | `a8a3a00` |
| L1b | Cheap per-node size lookup | dropped (not built) | — | Measured ceiling 20–25 ms of an ~800 ms edit at 50k; below the noise floor. |  |
| L2 | Rasterise a frame’s labels on one staging strip and upload as a batch | kept | 1.03 / 0.98 (short run) | WebKit script per frame, 50k zoom 0.35: clean 1.43→0.82 ms. Text in a newly reached view fills in within 6 frames instead of 52 (WebKit). Byte-identical glyphs. | `c64371a` |
| L3 | Skip the label loop when no label is large enough to draw; truthful pending-label count | kept | 1.01 / 0.97 (short run) | Whole-map frames: 0.25–0.38 ms saved per frame at 50k in both engines. | `3ca6847` |
| L4 | While zooming, draw a label raster one size step off instead of re-rasterising | kept (visual trade-off) | — | Probe (20k): Chrome zoom-sweep p95 3.5→1.8 ms; WebKit mean −24%. Labels are slightly soft or thin during a zoom gesture, exact one frame after it stops. | `6f308f2` |
| T1 | Stop cloning the CPU branch mesh to the main thread | kept | — | Chrome heap −33% at 5k, −37% at 50k. Latency within noise. | `d7e2342` |
| T2 | Layout result as typed boxes plus JSON record lists | kept | 0.96 / 0.96 (short run) | Screening score 0.966 / 0.948; edit at 50k 0.91 / 0.82. JSON was 2–6x cheaper than structured clone. | `8497d47` |
| T3 | Document replica in the worker; edits sent as ops | kept | — | Screening score 0.929 / 0.928; edit at 5k 0.83 / 0.72. One message per edit instead of 218. | `f21b243` |
| T4 | Autosave and journal serialisation after the next frame | kept | — | Screening score 0.957 / 0.951. Journal-path probe: add at 50k 629→583 ms (Chrome), 531→475 (WebKit). | `687e539` |
| T5 | Result in one message instead of pulled chunks | discarded | — | Latency within noise; longest main-thread task at 50k 75→84 ms. Reverted in 0b03056. | `661bf03` |
| T6 | Decode branch specs on the main thread only when read | kept | — | Main-thread result handling at 50k: 74–93→37–49 ms (Chrome), 50–69→32–34 ms (WebKit). | `a677ae6` |
| T7 | Decode adopted placements only when read | discarded | — | No gain; Chrome longest task 76→99 ms. Reverted in 4825198. | `77fd707` |
| M1 | Flat vertex packing: one 32-bit colour write per run | kept | 1.01 / 1.02 (short run) | Packer alone at 50k: 27→17.5 ms (Chrome), 21–23→13.4–14.6 ms (WebKit). Byte-identical. | `ebf490a` |
| M2 | Copy reused branch meshes in runs | kept | 1.00 / 0.98 (short run) | Worker mesh step per edit at 50k: 35–47→24–32 ms (Chrome), 58–66→28–39 ms (WebKit). | `ca40639` |
| M3 | Rust→WebAssembly flat tessellation and packing inside the layout worker | discarded | 1.03 / 1.02 (short run) | In-app, 50k theme switch: 999→964 ms (Chrome), 1089→1081 ms (WebKit). Holds 217 MB of wasm memory that is never released. Bit-identical output. Reverted in 17a8fb1. | `310dfc6` |
| M4 | Worker pool for tessellation | skipped (not built) | 1.00 / 1.02 (no code changed: a noise control) | Best case about 25 ms of a 1,000–1,500 ms rebuild; JS-only variant loses in WebKit (sending specs costs 78–113 ms). |  |
| M5 | Typed-array tidy-tree layout kernel (plain TypeScript) | kept | 0.97 / 0.98 (short run) | Warm layout 1.25x faster in both engines; Chrome first 50k call 71→34 ms. Bit-identical in 48 cases. | `7566c1f` |

### Round 2

| ID | What was tried | Outcome | Official score ratio (Chrome / WebKit) | Evidence from the experiment’s own measurements | Commit |
|---|---|---|---|---|---|
| G1 | GPU-expanded branches: one record per branch, ribbon built in the vertex shader (flat tapered, rounded, line) | kept | 0.92 / 0.92 (short run) | Screening: rebuild at 50k 0.90 / 0.82, edit 0.93 / 0.73; WebGL buffers at 50k 98→1.6 MB plus a 6.4 MB record texture; heap 167→75 MB. Whole-map GPU +0.35 ms. | `3d0f7f4` |
| G3 | Each GPU branch as one continuous strip | kept | — | Whole-map GPU at 50k (Chrome): 2.17→1.22 ms (CPU-mesh parent: 1.07). Pixels identical to G1. | `5f1eaec` |
| G4 | Organic and angular branch styles on the GPU | kept | — | Chrome probe: worker mesh −62 to −72%; edit at 20k 298→231 ms. GPU +11 to +35% at whole map. | `516a64d` |
| G5 | Soft clay and Rope materials on the GPU | kept (prototype) | — | Rope, Chrome, 2 rounds: load at 50k 1,498→943 ms; worker mesh 617→71 ms; buffers 189→2.2 MB plus 12.2 MB texture. Whole-map GPU +0.3 to +1.0 ms. | `4e6a0a1` |
| D1 | Profile of the four dimensional materials | study | 1.01 / 1.03 (no code changed: a noise control) | Their rebuild cost is cold compiled code (a theme switch builds the mesh exactly once), not arithmetic or garbage collection. | `0ea9548` |
| D2 | Dimensional meshes built through small functions over one output object | kept | — | Cold build at 50k in WebKit: rope 534–569→156–163 ms, lifted-arcs 194–198→84–92, paper-quilling 152–157→72–76. Bit-identical. | `e6a0aae` |
| D3 | Narrower dimensional vertex format | dropped (not built) | — | No pixel-identical gain left; packing is bound by allocation, not the loop. |  |
| D4 | Reuse the shadow layer on resting frames | discarded | — | No gain; slower in 7 of 8 cases. Reverted in 272ad6a. | `dd0639f` |
| D5 | Far-zoom level of detail for dimensional meshes | dropped (covered by F4) | — | The coarse index buffer already applies to every material. |  |
| IN1 | Incremental node sizes | kept | — | computeSizes per edit at 50k: 23–26→9–13 ms. Found and fixed a pre-existing bug (the worker replica kept a removed document field). | `ca304ac` |
| IN2 | Incremental layout bookkeeping: untouched main branches keep their boxes and placements | kept | — | settleLayout at 50k: 79–89→40–48 ms (Chrome), 59–64→35–37 ms (WebKit). Screening edit at 50k −9% / −20%. | `62651b6` |
| IN3 | Incremental branch specs | kept | — | Screening: interaction −11% in both engines; edit at 5k −20%. Worker relayout at 50k −25 to −33%. | `aa88cd3` |
| IN4 | Incremental scene; skip empty badge and sketch scans | kept | — | Screening: fold at 50k −12% / −14%. Worker compute for a one-node edit at 50k: ~260–300→~110–160 ms across IN1–IN4. | `9d636f3` |
| IN5 | Cache each record’s JSON when packing the result | discarded | — | Edits at 50k −7 to −23%, but Chrome loads and theme switches +3 to +11% and +90 MB in the worker. Reverted in 64f2d3c. | `8b15820` |
| U1 | Persistent, patchable branch-mesh buffers | measured, not merged | — | Edit probe: Chrome −7 to −24% (50k clean 523→452 ms), WebKit −4 to −14%. Pixel-identical. Conflicts with the GPU-expanded design, which was chosen. | `a982d12` |
| U2 | Ship the mesh ahead of its result and upload in slices | measured, not merged | — | Dev probe: the frame showing a 50k theme switch draws in 14–20 ms instead of 61–66 ms. | `28a9fd6` |
| U3 | Decode large results in 8 ms slices | discarded | — | No visible change; the longest task is the autosave after the frame (85–120 ms at 50k). Reverted in 48b4e01. | `1800d80` |
| U4 | Packed vertices kept only on the GPU | measured, not merged | — | Dev heap after loading 50k: clean 187→119 MB, rope 274→132 MB. | `c935dfc` |

## How it was measured

- **Harness:** `radiant/autoresearch/bench/measure.py` builds each checkout for production, serves it, and drives it in headless Chrome (Metal) and Playwright WebKit through one adapter (`window.__radiantBench`). Viewport 1728 × 1117 at device scale factor 2. Maps of 5,000, 20,000 and 50,000 synthetic nodes in the flat theme and the four dimensional materials.
- **Interleaving:** two builds are measured round by round in alternation under a machine-wide lock, so drift hits both.
- **Noise rule:** a difference counts only if the rounds of the two builds do not overlap and the change exceeds both twice the spread and 3%.
- **Correctness:** `bench/visual.py` compares 18 fixed scenes pixel by pixel. Round 1 as merged is identical to the baseline in all 18 scenes in both engines. The incremental track's random-edit check (incremental result must equal a from-scratch result) passed on the final build: 12 runs up to 13,000 nodes, all exact, no resyncs. The project checks (`bun run check`, boundaries, browser check) pass on the final build.
- **Raw data:** `radiant/autoresearch/official/*.json` (official runs), `radiant/autoresearch/experiments/*/` on the final branch (each experiment's notes, screening JSON and probe scripts), `radiant/autoresearch/results.tsv` (the ledger).

## What changes on screen

The final build is not pixel-identical to the baseline. Compared scene by scene:

- **GPU-expanded branches (G1 to G5):** at most a few edge pixels per scene differ beyond a small threshold (0.0002% of pixels or less at normal zoom). Rope shows sub-threshold speckle inside the plies on about 0.2% of pixels; I looked at the captures and could not see a difference.
- **Coarse far-zoom mesh (F4):** below zoom 0.02 the branch mesh is drawn with fewer segments; about 0.02% of pixels differ on the 5,000-node whole-map view.
- **No multisampling while moving (F5):** edges stair-step slightly while the camera moves; the resting frame, drawn 120 ms after it stops, is identical. Since 26 November this applies only to heavy frames (more than 400,000 branch triangles in view, roughly the whole-map view of a 20,000-node map); lighter frames keep 4x multisampling while moving, which costs about 2 to 2.5 ms of GPU time per moving frame at 3456×2234 in Chrome.
- **Label rasters during a zoom (L4):** labels are drawn from a raster one size step off during a zoom gesture, so they look slightly soft or thin until one frame after the zoom stops.

F4, F5 and L4 are deliberate trade-offs and each is a single commit that can be reverted.

## Check in the desktop app (added 26 November)

The same benchmark steps were run inside the desktop app's own WebView, using release builds of the baseline and of the final branch. Two interleaved rounds per build on a 50,000-node map; values are medians.

| Operation, 50,000 nodes | Baseline | Final | Faster by |
|---|---|---|---|
| Edit, flat | 805 ms | 300 ms | 2.7x |
| Edit, Rope | 949 ms | 317 ms | 3.0x |
| Fold and unfold | 1,705 ms | 602 ms | 2.8x |
| Theme switch to flat | 1,169 ms | 408 ms | 2.9x |
| Theme switch to Rope | 1,810 ms | 611 ms | 3.0x |
| Theme switch to Soft clay | 1,160 ms | 670 ms | 1.7x |
| Theme switch to Lifted arcs | 1,220 ms | 654 ms | 1.9x |
| Theme switch to Paper quilling | 1,352 ms | 703 ms | 1.9x |
| Load | 1,005 ms | 751 ms | 1.3x |

- **Whole-map panning.** The baseline missed frames (95th-percentile frame gap 23 ms flat, 29 ms Rope); the final build held the display's 60 Hz (17.5 ms). Script per frame fell from about 2.7 ms to about 0.4 ms; this WebView rounds its clock to 1 ms, so those two values are coarse.
- **Pixels.** Seven captures per build were compared. Flat, Lifted arcs and Paper quilling at zoom 1 are identical. Rope and Soft clay differ in under 0.001% of pixels above the guard threshold, and whole-map views in 0.001%.
- **Limits of this check.** The only active display was a 1920×1080, 60 Hz AirPlay screen at scale 1, so 120 Hz and Retina resolution are still unmeasured. The 5,000-node pass is not reported: the probe window took keyboard focus in that run and stray input reached it.

Raw values: `official/NATIVE-132bfd2.json`.


## What is not verified

- **The real app.** The desktop app's own WebView was checked afterwards at 50,000 nodes on a 60 Hz display (see “Check in the desktop app”); 120 Hz and Retina resolution were not measured. The other WebKit numbers are Playwright WebKit, a newer build than the system one.
- **Realistic maps.** The benchmark's synthetic map has short labels (7 to 11 characters) and very wide fans (at 50,000 nodes each of 9 main branches has about 745 children). Incremental layout reworks one main branch at a time, so maps with fewer, larger main branches will gain less.
- **Maps with pictures.** The incremental caches are switched off for them and no check covers them.
- **Per-experiment official runs.** Only 13 experiment commits have one; the rest rest on screening numbers, as marked in the tables. The official run for L1a was taken under heavy load and is not usable.
- **Soft clay and Rope on the GPU (G5)** is a prototype: measured in the final build and visually compared in both engines, but its own experiment was screened in Chrome only.
- **Agent and AI edit streams** through the worker's document replica were not exercised by the replica checks.
- **The patchable-buffer track (U1, U2, U4)** was measured on its own and not merged, because it and the GPU-expanded design change the same five files in incompatible ways. Its ideas still apply to Lifted arcs and Paper quilling.

## Where the code is

- `autoresearch-final` (`132bfd2`): baseline plus all kept experiments. It starts from the harness commit on the working branch and touches none of the files this report adds, so it merged without conflicts (`b79fd76`, 26 November).
- `ar/frame`, `ar/labels`, `ar/transport`, `ar/mesh`, `ar/gpu`, `ar/materials`, `ar/incremental`, `ar/upload`: one branch per track, one commit per experiment, discarded experiments followed by their revert.
- `radiant/autoresearch/research/`: the four studies. `radiant/autoresearch/native-spike/`: the native spike's sources.

## Suggested next steps

1. Try the merged code in the desktop app on real maps, and decide on the three visual trade-offs.
2. Move autosave serialisation off the main thread; it is now the longest task around every edit on a large map.
3. Send only changed records from the worker (a delta result). After the incremental work, packing the result is about 100 ms per edit at 50,000 nodes, as much as all the remaining compute.
4. Port Lifted arcs to the GPU-expanded path, and bring the patchable buffers (U1) to Paper quilling, which will stay on the CPU mesh.
5. Add a realistic map (long labels, pictures, uneven branches) to the benchmark.
