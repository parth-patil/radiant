# 03 — Rust/WebAssembly and Web Workers for Radiant's core: measured

Status: research only. No app source was changed, nothing was committed. All code, inputs and raw results are in the scratch folder listed at the end. Author: wasm/workers research agent, 2026-11-25.

## Verdicts in one table

| Question | Verdict | Why (one line) |
|---|---|---|
| Flat branch tessellation (+ vertex packing) in WebAssembly | **Not now.** Do two TS fixes first; keep the port on the shelf | The port is exact and the kernel runs about 2× faster than TS in both engines, but it saves at most 15–45 ms of a ~430 ms 50k rebuild. After a 20-line TS packing fix, JavaScriptCore's TS path (~47 ms) is within a few ms of wasm once results are copied out (~45 ms) |
| Tree layout (tidyTree) in WebAssembly | **No** | wasm is 3.1–3.4× faster than the current kernel, but a struct-of-arrays TS rewrite already gets 2–2.7× of that. The kernel is only 12–20% of settleLayout, so wasm would add about 1 ms more at 50k |
| Struct-of-arrays TypeScript (tidyTree) | **Yes, cheap win** | 6.3→3.1 ms (V8) and 6.8→2.6 ms (JSC) warm at 50k, cold first call 75→10 ms in V8; output bit-identical |
| More Web Workers for tessellation | **Not for JS. For wasm, only if tessellation becomes a bottleneck** | JS workers lose because they have to structured-clone the spec objects: 24–37 ms in V8 and **78–113 ms in JSC** at 50k. wasm workers in "chunk" mode scale 2.5× by 8 workers (≈21 ms at 50k), with most of the gain by 4 |
| SharedArrayBuffer | **No** | Reported not to work on macOS Tauri's tauri:// scheme (WebKit skips COOP for custom-scheme loads). Measured benefit is nil anyway: one-round chunked output with transfers beats merging into a shared buffer |

The biggest levers this work turned up are not WebAssembly. They are listed under "Findings outside the brief": the TS vertex packer, the branch-mesh reuse cache, and structured-clone cost in JavaScriptCore.

## 1. Where the time goes today (context for every number below)

These are the real app's numbers, measured in headless Chrome against the dev server on :1420 with `?demo=big&n=N` and the default theme 'clean'. I re-ran the main-thread pipeline 5 times per size by calling the Pipeline methods directly (scripts/breakdown.py). The machine was shared and the load average was 21–27 on 14 cores, so read these as ranges.

| step (ms) | 5,000 nodes | 50,000 nodes |
|---|---|---|
| computeSizes (text measurement) | 1.6–6.3 | 161–175 |
| settleLayout (layout + placements) | 5.2–18.7 | 72–128 |
| branchSpecs | 3.9–7.5 | 49–72 |
| BranchMeshCache.build (flat tessellation, fresh cache) | 4.0–9.9 | 35–64 |
| BranchMeshCache.build again with identical specs (all reuse) | 3.1–5.7 | 36–62 |
| fullScene | 2.2–6.4 | 32–44 |
| worker-reported lastLayoutMs (in situ, 1 sample) | 45.7 | 434 |

packMeshVertices runs in the worker after these timers stop, so it is not in lastLayoutMs. It adds 2.5–3.4 ms at 5k and 28–45 ms at 50k (section 3).

The tessellation kernel that a wasm port would replace is therefore about 10–20% of a 50k rebuild. Sizes, settleLayout and branchSpecs are much larger.

## 2. Method

- Machine: Apple M4 Pro, macOS 26.5.1. Engines: headless Chrome 158 (V8) launched as Playwright channel "chrome"; Playwright WebKit 27.2 (JavaScriptCore, Playwright 1.65.2); bun 1.4 (JSC); node 24.13 (V8); native Rust 1.99 (aarch64, release).
- Playwright WebKit stands in for WKWebView. It is a newer WebKit build than the system framework the app uses, and it was not run inside Tauri.
- Inputs were captured from the running dev app (scratch `data/`):
  - `pipeline.branchSpecs()` and the layout input (doc tree with collapsed, side, offset and branchLayout per node; measured sizes; levelGap and siblingGap) for synthetic maps of 5,000 and 50,000 nodes in theme 'clean'.
  - 5,000-node spec sets for buzan (organic), studio (rounded, round caps both ends, tip dots, start tangents), boardroom (angular, tip dots), sorbet and ink (line).
  - A synthetic "mutated" set that mixes every style with v and r flows, fades, underline bends, start tangents, round caps, tip dots and degenerate horizontal or vertical limbs. It covers code paths the captured themes do not reach.
- The TypeScript under test is the real module: `bun build` of an entry that re-exports `tessellateBranches`, `BranchMeshCache` and `packMeshVertices` from src (`bench/real.js`).
- Timing protocol:
  - Each implementation runs in a fresh browser context or process.
  - "Cold" is the first call in that context. For wasm it is reported separately from compile and instantiate.
  - Warm runs: 5 warm-up and 20 timed calls at 5k; 3 warm-up and 10 timed calls at 50k.
  - 3 rounds in Chrome and WebKit, 2 in bun and node.
  - Tables show the median of the per-round medians and the min–max over all samples.
- **Noise caveat:** other agents were running throughout (load average 12–27 on 14 cores). Max values and some 50k medians are badly inflated, especially anything that allocates ~200 MB per call. Mins and medians agree on every conclusion below, but treat single numbers as ±20%.

## 3. Kernel (a): flat branch tessellation + vertex packing

### The port

- `crate/src/lib.rs`, about 420 lines, is a line-by-line port of `tessellateBatch` (with no reuse cache) and `packMeshVertices`. It covers all five styles; h, v and r flows; organic wobble (the mulberry32 RNG, ported with u32 wrapping arithmetic); fades; round caps at the start or both ends; tip dots; straight and bent underlines; start tangents; and angular elbows.
- Input: one f64 record of 32 slots per BranchSpec (`bench/encode.js`), encoded straight into wasm linear memory.
- Output, in linear memory: positions (f64), colors (f32), indices (u32), per-branch bounds and ends, and the packed GPU vertex buffer (3 or 5 words per vertex, same layout as packMeshVertices).
- `rebase(vb, ib)` and `pack_with(ox, oy, wide)` serve the multi-worker experiments.
- The JS loader is hand-written (`bench/tess-wasm.js`, about 60 lines). No wasm-bindgen; the module has zero imports.

### Correctness (bench/check.mjs; bun and node, scalar and simd-opt builds)

Every set matched: the five captured themes, 5k and 50k 'clean', and the mutated set.

- Vertex count, index count, every index, every branch end, every packed colour byte and the packed origin are identical.
- The largest f64 position difference is 1.1e-13, from transcendental functions in organic and bent paths. Packed float32 positions differ by 0.

### Results (ms; "view" = results left in wasm memory, zero-copy typed-array views; "copy" = `.slice()` of every output array, needed to post results to another thread)

| engine | size | impl | warm median (min-max) ms | parts (median) | cold first call ms median [min-max] | notes |
|---|---|---|---|---|---|---|
| chrome | 5000 | TS (tessellateBranches + packMeshVertices) | 8.07 (6.36-14.9) | tess 4.67 + pack 3.35 | 17.3 [17.1-19.0] | app BranchMeshCache.build: all-miss 5.25, all-hit 4.28 |
| chrome | 5000 | wasm scalar | view 3.82 (3.46-4.74); copy 6.01 (4.89-15.2) | encode 0.09 + compute 3.70 (min 3.37) + out view 0.01 / copy 2.23 | 13.6 [13.0-15.5] (+compile 0.40, instantiate 0.07) | call 3.16 ns; mem 25.2 MB; 58449 B |
| chrome | 5000 | wasm simd | view 3.77 (3.44-6.29); copy 5.63 (4.76-8.57) | encode 0.07 + compute 3.65 (min 3.37) + out view 0.01 / copy 1.97 | 13.0 [12.8-14.0] (+compile 0.70, instantiate 0.09) | call 3.50 ns; mem 25.2 MB; 58109 B |
| chrome | 5000 | wasm scalar-opt | view 3.66 (3.48-4.54); copy 5.85 (4.95-8.27) | encode 0.07 + compute 3.58 (min 3.40) + out view 0.01 / copy 2.14 | 13.8 [13.7-13.9] (+compile 0.32, instantiate 0.07) | call 3.86 ns; mem 25.2 MB; 46113 B |
| chrome | 5000 | wasm simd-opt | view 3.71 (3.31-4.21); copy 5.68 (4.80-8.63) | encode 0.07 + compute 3.63 (min 3.24) + out view 0.01 / copy 1.95 | 13.2 [12.4-13.5] (+compile 0.60, instantiate 0.07) | call 3.16 ns; mem 25.2 MB; 45828 B |
| chrome | 50000 | TS (tessellateBranches + packMeshVertices) | 91.3 (66.2-297.9) | tess 40.6 + pack 45.5 | 104.7 [95.0-120.7] | app BranchMeshCache.build: all-miss 57.1, all-hit 47.0 |
| chrome | 50000 | wasm scalar | view 34.2 (32.3-36.5); copy 55.5 (46.9-168.2) | encode 0.93 + compute 33.3 (min 31.4) + out view 0.01 / copy 20.7 | 117.6 [113.5-126.8] (+compile 0.32, instantiate 0.07) | call 3.05 ns; mem 217.2 MB; 58449 B |
| chrome | 50000 | wasm simd | view 34.2 (32.2-37.4); copy 50.5 (47.7-116.6) | encode 0.92 + compute 33.3 (min 31.4) + out view 0.01 / copy 16.9 | 142.6 [110.1-156.0] (+compile 0.38, instantiate 0.09) | call 3.85 ns; mem 217.2 MB; 58109 B |
| chrome | 50000 | wasm scalar-opt | view 33.7 (32.0-80.9); copy 74.5 (46.3-202.2) | encode 0.99 + compute 32.7 (min 30.9) + out view 0.01 / copy 40.5 | 110.8 [107.9-113.2] (+compile 0.36, instantiate 0.08) | call 2.85 ns; mem 217.2 MB; 46113 B |
| chrome | 50000 | wasm simd-opt | view 32.9 (31.8-35.5); copy 48.9 (45.4-91.3) | encode 0.88 + compute 31.9 (min 30.9) + out view 0.01 / copy 15.4 | 109.6 [100.4-110.1] (+compile 0.40, instantiate 0.09) | call 4.26 ns; mem 217.2 MB; 45828 B |
| webkit | 5000 | TS (tessellateBranches + packMeshVertices) | 6.62 (5.48-10.9) | tess 3.84 + pack 2.70 | 25.6 [24.3-46.6] | app BranchMeshCache.build: all-miss 7.58, all-hit 4.84 |
| webkit | 5000 | wasm scalar | view 3.54 (3.32-4.08); copy 5.12 (3.72-6.26) | encode 0.10 + compute 3.44 (min 3.20) + out view 0.02 / copy 1.50 | 11.8 [11.6-12.4] (+compile 0.88, instantiate 0.16) | call 4.22 ns; mem 25.2 MB; 58449 B |
| webkit | 5000 | wasm simd | view 3.60 (3.36-4.00); copy 4.92 (4.12-5.98) | encode 0.10 + compute 3.46 (min 3.20) + out view 0.02 / copy 1.46 | 13.3 [13.2-13.4] (+compile 0.80, instantiate 0.18) | call 3.06 ns; mem 25.2 MB; 58109 B |
| webkit | 5000 | wasm scalar-opt | view 3.62 (3.32-4.08); copy 5.18 (4.26-7.06) | encode 0.10 + compute 3.48 (min 3.24) + out view 0.02 / copy 1.50 | 11.9 [11.5-12.0] (+compile 0.66, instantiate 0.18) | call 3.08 ns; mem 25.2 MB; 46113 B |
| webkit | 5000 | wasm simd-opt | view 3.72 (3.28-4.66); copy 5.98 (4.08-14.6) | encode 0.12 + compute 3.48 (min 3.20) + out view 0.02 / copy 2.24 | 12.4 [11.7-13.8] (+compile 0.76, instantiate 0.18) | call 3.86 ns; mem 25.2 MB; 45828 B |
| webkit | 50000 | TS (tessellateBranches + packMeshVertices) | 66.8 (54.1-127.4) | tess 30.9 + pack 35.0 | 95.2 [94.2-107.8] | app BranchMeshCache.build: all-miss 167.9, all-hit 71.8 |
| webkit | 50000 | wasm scalar | view 31.8 (30.9-40.5); copy 45.6 (35.6-69.9) | encode 0.88 + compute 30.8 (min 30.1) + out view 0.02 / copy 14.1 | 64.7 [61.2-68.1] (+compile 1.00, instantiate 0.20) | call 3.92 ns; mem 217.2 MB; 58449 B |
| webkit | 50000 | wasm simd | view 32.1 (30.2-39.4); copy 45.3 (35.5-240.7) | encode 0.80 + compute 31.1 (min 29.5) + out view 0.04 / copy 14.3 | 63.5 [55.9-138.8] (+compile 0.72, instantiate 0.22) | call 4.04 ns; mem 217.2 MB; 58109 B |
| webkit | 50000 | wasm scalar-opt | view 32.7 (31.3-36.3); copy 43.5 (35.9-85.3) | encode 0.82 + compute 31.9 (min 30.4) + out view 0.02 / copy 12.3 | 55.3 [52.6-55.4] (+compile 0.62, instantiate 0.16) | call 4.22 ns; mem 217.2 MB; 46113 B |
| webkit | 50000 | wasm simd-opt | view 31.9 (31.0-38.6); copy 47.1 (37.8-90.2) | encode 0.90 + compute 31.0 (min 29.9) + out view 0.02 / copy 15.3 | 61.5 [60.1-62.7] (+compile 0.68, instantiate 0.20) | call 3.70 ns; mem 217.2 MB; 45828 B |

bun and node, for reference (same harness):

| engine | size | impl | warm median (min-max) ms | parts (median) | cold first call ms median [min-max] | notes |
|---|---|---|---|---|---|---|
| bun | 5000 | TS (tessellateBranches + packMeshVertices) | 4.62 (3.71-7.28) | tess 2.43 + pack 2.07 | 26.3 [26.3-29.1] | app BranchMeshCache.build: all-miss 6.63, all-hit 4.03 |
| bun | 5000 | wasm scalar | view 3.45 (3.35-4.36); copy 5.18 (3.82-7.73) | encode 0.10 + compute 3.31 (min 3.21) + out view 0.01 / copy 1.66 | 16.4 [16.4-16.5] (+compile 0.56, instantiate 0.16) | call 3.48 ns; mem 25.2 MB; 57644 B |
| bun | 5000 | wasm simd | view 3.50 (3.36-4.14); copy 4.98 (3.84-6.60) | encode 0.10 + compute 3.38 (min 3.28) + out view 0.01 / copy 1.51 | 15.5 [15.5-17.0] (+compile 0.50, instantiate 0.15) | call 3.40 ns; mem 25.2 MB; 57496 B |
| bun | 5000 | wasm scalar-opt | view 3.61 (3.37-7.70); copy 5.13 (4.17-9.38) | encode 0.11 + compute 3.43 (min 3.27) + out view 0.01 / copy 1.54 | 15.8 [15.8-19.2] (+compile 0.60, instantiate 0.18) | call 3.07 ns; mem 25.2 MB; 45354 B |
| bun | 5000 | wasm simd-opt | view 3.41 (3.26-4.98); copy 4.81 (3.71-7.59) | encode 0.09 + compute 3.30 (min 3.16) + out view 0.01 / copy 1.45 | 15.4 [15.4-18.8] (+compile 0.58, instantiate 0.18) | call 3.79 ns; mem 25.2 MB; 45252 B |
| bun | 50000 | TS (tessellateBranches + packMeshVertices) | 49.6 (40.5-233.6) | tess 28.5 + pack 22.9 | 97.0 [97.0-149.4] | app BranchMeshCache.build: all-miss 44.4, all-hit 51.7 |
| bun | 50000 | wasm scalar | view 39.4 (33.8-95.1); copy 57.8 (49.7-122.7) | encode 1.05 + compute 38.6 (min 32.9) + out view 0.02 / copy 19.4 | 69.8 [69.8-94.3] (+compile 0.72, instantiate 0.19) | call 3.89 ns; mem 217.2 MB; 57644 B |
| bun | 50000 | wasm simd | view 35.9 (33.3-77.4); copy 70.6 (49.2-199.5) | encode 1.13 + compute 34.6 (min 32.4) + out view 0.02 / copy 35.7 | 54.1 [54.1-80.8] (+compile 0.71, instantiate 0.23) | call 3.76 ns; mem 217.2 MB; 57496 B |
| bun | 50000 | wasm scalar-opt | view 35.1 (32.7-53.1); copy 61.3 (44.6-195.0) | encode 0.87 + compute 34.3 (min 31.3) + out view 0.01 / copy 22.3 | 65.0 [65.0-88.2] (+compile 0.45, instantiate 0.19) | call 3.78 ns; mem 217.2 MB; 45354 B |
| bun | 50000 | wasm simd-opt | view 43.3 (32.6-129.9); copy 80.7 (50.3-197.0) | encode 1.06 + compute 40.3 (min 31.7) + out view 0.02 / copy 28.7 | 72.1 [72.1-90.5] (+compile 0.61, instantiate 0.18) | call 3.63 ns; mem 217.2 MB; 45252 B |
| node | 5000 | TS (tessellateBranches + packMeshVertices) | 6.43 (4.99-55.7) | tess 4.21 + pack 2.18 | 36.2 [36.2-48.5] | app BranchMeshCache.build: all-miss 5.15, all-hit 2.69 |
| node | 5000 | wasm scalar | view 4.13 (3.76-13.0); copy 6.09 (4.25-68.4) | encode 0.08 + compute 4.04 (min 3.69) + out view 0.01 / copy 1.26 | 16.0 [16.0-23.7] (+compile 0.23, instantiate 0.05) | call 6.04 ns; mem 25.2 MB; 57644 B |
| node | 5000 | wasm simd | view 3.78 (3.69-7.90); copy 5.20 (4.18-12.4) | encode 0.07 + compute 3.69 (min 3.60) + out view 0.01 / copy 0.89 | 13.2 [13.2-15.2] (+compile 0.66, instantiate 0.05) | call 2.67 ns; mem 25.2 MB; 57496 B |
| node | 5000 | wasm scalar-opt | view 4.58 (3.71-11.0); copy 5.65 (4.21-22.0) | encode 0.09 + compute 4.38 (min 3.63) + out view 0.01 / copy 1.23 | 13.1 [13.1-13.5] (+compile 0.24, instantiate 0.05) | call 3.14 ns; mem 25.2 MB; 45354 B |
| node | 5000 | wasm simd-opt | view 3.81 (3.64-8.70); copy 5.39 (4.27-16.2) | encode 0.08 + compute 3.69 (min 3.57) + out view 0.01 / copy 1.17 | 14.3 [14.3-17.8] (+compile 0.27, instantiate 0.07) | call 2.58 ns; mem 25.2 MB; 45252 B |
| node | 50000 | TS (tessellateBranches + packMeshVertices) | 74.6 (65.6-174.0) | tess 50.2 + pack 24.9 | 117.9 [117.9-169.1] | app BranchMeshCache.build: all-miss 69.8, all-hit 46.5 |
| node | 50000 | wasm scalar | view 39.2 (35.1-51.5); copy 47.3 (42.4-128.8) | encode 0.94 + compute 38.4 (min 34.0) + out view 0.01 / copy 7.85 | 100.4 [100.4-112.4] (+compile 5.94, instantiate 0.10) | call 2.52 ns; mem 217.2 MB; 57644 B |
| node | 50000 | wasm simd | view 35.5 (33.7-82.8); copy 43.8 (41.4-88.1) | encode 0.83 + compute 34.4 (min 33.0) + out view 0.01 / copy 8.35 | 100.9 [100.9-210.0] (+compile 3.83, instantiate 0.08) | call 2.69 ns; mem 217.2 MB; 57496 B |
| node | 50000 | wasm scalar-opt | view 34.8 (33.4-127.2); copy 42.3 (40.1-450.6) | encode 0.83 + compute 33.8 (min 32.3) + out view 0.01 / copy 7.55 | 109.4 [109.4-118.9] (+compile 5.17, instantiate 0.07) | call 2.58 ns; mem 217.2 MB; 45354 B |
| node | 50000 | wasm simd-opt | view 36.9 (33.5-118.1); copy 44.5 (39.9-264.4) | encode 1.22 + compute 35.8 (min 32.7) + out view 0.01 / copy 9.67 | 115.3 [115.3-253.6] (+compile 2.99, instantiate 0.08) | call 2.62 ns; mem 217.2 MB; 45252 B |

Native Rust, same code and inputs: `target/release/native_bench`, which allocates fresh output vectors on every call, 3 runs:

| size | 1 thread | 2 threads | 4 threads | 8 threads (tessellate + pack only, no merge) |
|---|---|---|---|---|
| 5,000 | 2.65 ms (min 2.55) | 1.74 | 1.24 | 0.82 |
| 50,000 | 24.3 ms (min 23.5) | 16.5 | 12.9 | 10.2 |

### What the numbers say

- **wasm against the current TS (warm, results left in wasm memory):**
  - 5k: Chrome 8.1 → 3.7 ms (2.2×); WebKit 6.6 → 3.6 ms (1.8×).
  - 50k: Chrome 91 → 33 ms (2.8×); WebKit 67 → 32 ms (2.1×).
  - In bun (JSC) the 50k gap is smaller: 50 → 35–43 ms.
- **The copy-out costs 1.5–2.2 ms at 5k and 12–40 ms at 50k** (about 200 MB of output), and it is what eats the gain:
  - wasm with copies is 4.9–6.0 ms at 5k and 43–75 ms at 50k.
  - In the app that copy replaces an existing one, because the worker already structured-clones positions, colors and indices to the main thread (layout.worker.ts keeps the CPU batch on the worker and sends a copy). So the fair comparison is "TS + today's clone" against "wasm view + one slice, then a transfer".
- **Encoding the spec objects into wasm memory is cheap:** 0.07–0.12 ms at 5k and 0.8–1.2 ms at 50k. A JS→wasm call costs **2.5–6 ns** (1e6 calls to a no-op export, both engines). The interface can be as fine as per-branch calls with numeric arguments; marshalling objects is what costs.
- **simd128 and wasm-opt -O3 make no measurable difference.**
  - rustc auto-vectorises a little: 64 v128 instructions, all in fills and copies.
  - wasm-opt shrinks the module from 58 KB to 46 KB.
  - The kernel is scalar control flow with branchy fan and cap code, so SIMD would need a hand-written restructure to matter.
- **Cold first call:**
  - wasm is 12–14 ms at 5k against 17 ms (V8) and 26 ms (JSC) for TS.
  - At 50k in V8, the first wasm call is **slower** than TS: 110–143 ms against 105 ms. At 50k in JSC wasm is faster: 55–65 ms against 95 ms.
  - My inference for V8 is that the first call runs in the Liftoff baseline tier while linear memory grows to 217 MB. I did not profile it.
  - Compile plus instantiate is 0.3–1.2 ms for this 46–58 KB module (6 ms in node).
- **wasm against native:** wasm is about 1.35× native at 5k and about 1.3× at 50k. Native allocates fresh vectors on each call, so the true gap is a little larger. Little headroom is left in a WebAssembly build.
- **Memory:** wasm linear memory grows to **217 MB at 50k and never shrinks**. A port has to recreate the instance or cap it. The TS path allocates and frees similar amounts through the GC.
- **The V8 versus JSC split matters:** on the shipping engine (JSC) the TS baseline is already 25–35% faster than in V8, so wasm gains less there.

### Findings outside the brief (pure TypeScript, same output)

- **1. The vertex packer is half of the TS cost.** `packMeshVertices` takes as long as tessellation itself: 28–45 ms at 50k.
  - `bench/pack-fast.js` builds each vertex's colour word only when the colour changes (it is constant along a branch) and writes it as one u32. Its output is **byte-identical** (checked in both engines).
  - It runs **28.8 → 18.8 ms (V8) and ~30 → 15.6 ms (JSC) at 50k**, and 2.6 → 2.2 / 2.9 → 1.6 ms at 5k. Data: `results/exp-pack.json`, 2 rounds per engine with all five operations interleaved.
  - With it, the JSC TS path is about 31 + 16 ≈ 47 ms at 50k, roughly level with wasm plus copy-out. This is the main reason the wasm verdict is "not now".
  - Going further, tessellateBatch could write the u32 colour (or the packed buffer) directly and skip the float32 colours array. I did not measure that.
- **2. The branch-mesh reuse cache costs more than it saves at 50k.** Measured in the same interleaved runs:

  | 50k | tessellate from scratch | `BranchMeshCache.build` (fresh cache, all miss) | `BranchMeshCache.build` again (identical specs, all reuse) |
  |---|---|---|---|
  | V8 | 31–34 ms | 42–48 ms | 41–44 ms |
  | JSC | 30–33 ms | 37–38 ms | **53 ms** |

  - The reuse path runs `sameSpec` (about 40 field compares) on every spec, does two Map operations per spec keyed by string ids, makes a `set()` per branch for positions and colours, and runs an index-rebase loop.
  - So a one-node edit on a 50k map pays more for "reuse" than a full rebuild would. Comparing a per-spec hash, and copying contiguous runs of reused branches with one `set()`, are obvious follow-ups (not measured).
- **3. Structured clone of many small objects is 3× slower in JSC.** Posting 50k BranchSpec objects to workers took 24–37 ms in V8 and **78–113 ms in JSC**.
  - Every snapshot the app posts to or from its layout worker (doc, Maps of boxes, placements) pays this kind of cost in WKWebView.
  - This is a likely large and invisible cost in the shipping app, worth measuring separately.

## 4. Kernel (b): tidy-tree layout

Done by a sub-agent: same captured inputs, same engines. Full tables are in `layout/results/results.md`.

- **What was ported:** `tidyTree` with the mindmap balancing it calls back into, on struct-of-arrays inputs that mirror layoutRootBoxes step 1.
  - (i) existing TidyNode code;
  - (ii) a struct-of-arrays TypeScript rewrite (`layout/tidy-soa.ts`: typed arrays, integer contour threads);
  - (iii) a Rust port of (ii) compiled to wasm (plain, simd128, wasm-opt);
  - (iv) the same Rust natively.
- **Correctness:** every implementation is **bit-identical** to the existing tidyTree in every engine (maximum difference 0, sides equal).

| warm median ms (cold) | Chrome V8 | WebKit JSC | native |
|---|---|---|---|
| 50k existing tidyTree | 6.28 (cold 74.7) | 6.76 (cold 16.0) | |
| 50k SoA TypeScript | 3.09 (cold 9.9) | 2.58 (cold 8.8) | |
| 50k wasm incl. copy in/out | 2.04 (cold 5.5) | 1.99 (cold 5.5) | 1.78 |
| 50k layoutDoc (whole, real code) | 14.7 | 21.6 | |
| 50k settleLayout (real code, no previous placements) | 36.9 (cold 97) | 57.6 (cold 97) | |
| 5k existing / SoA TS / wasm | 0.287 / 0.187 / 0.105 | 0.286 / 0.146 / 0.098 | 0.083 |

- tidyTree is 31–46% of layoutDoc and **12–20% of settleLayout**.
- The rest is Map and object work: `collect()`, NodeBox objects, placement records, Occupancy. Building the struct-of-arrays input from the doc and the sizes Map alone takes 3.6–6.9 ms at 50k, which is more than the whole wasm kernel.
- Copying data in and out of wasm costs 15–40 µs at 50k, so it is irrelevant here.
- simd128 and wasm-opt made no difference.
- **Most of the gain comes from the data layout.** SoA TS takes 2–2.7× off the kernel; wasm adds 1.2–1.5× on top, which is about 1 ms at 50k. In V8 SoA also removes a 75 ms cold first call (to 10 ms), which matters when a big map is first opened.

## 5. Workers (tessellation, 50,000 and 5,000 nodes)

Harness: `bench/workers.js`, `bench/tess.worker.js`, `bench/workers.html`.

- A persistent pool of module workers, created and warmed before timing. For wasm, the compiled WebAssembly.Module is posted to each worker at init.
- Specs are split into k equal contiguous ranges.
- Wall time runs from dispatch until every output is available on the coordinating thread, including transfers and any merge.
- Every configuration's output was checked against single-threaded TS. All matched; in chunk mode the indices match after rebasing.

Three ways to deliver results:

- **transfer**:
  - Round 1: each worker tessellates its range and returns counts and extent.
  - Round 2: the coordinator sends vertex and index offsets plus the global origin. Workers rebase indices, pack against the global origin and transfer their arrays.
  - The coordinator then merges with `TypedArray.set`.
  - The output is identical to today's single mesh.
- **shared**: the same two rounds, but workers write straight into SharedArrayBuffer result arrays, so there is no merge. This needs cross-origin isolation; the test server sent COOP and COEP.
- **chunks**: one round.
  - The coordinator picks the packing origin up front, from spec endpoints.
  - Each worker returns its own chunk with chunk-local indices, packed and transferred. There is no merge.
  - The renderer would draw k buffers (k draw calls) and picking would walk k chunks.
  - The packed buffer differs from today's only by the choice of origin.

Results (ms, median over 2 rounds of 8 timed runs each; min in brackets):

| engine | size | kind | mode | k=1 | k=2 | k=4 | k=8 | all outputs match |
|---|---|---|---|---|---|---|---|---|
| chrome | 5000 | js | transfer | 15.9 (min 13.6) | 10.7 (min 8.68) | 8.07 (min 7.20) | 8.69 (min 6.52) | true |
| chrome | 5000 | wasm | transfer | 6.77 (min 5.68) | 6.62 (min 5.52) | 5.16 (min 4.18) | 4.42 (min 3.48) | true |
| chrome | 5000 | js | shared | 18.3 (min 15.3) | 13.1 (min 9.33) | 10.8 (min 6.73) | 8.62 (min 7.37) | true |
| chrome | 5000 | wasm | shared | 6.60 (min 5.82) | 4.07 (min 3.70) | 2.93 (min 2.46) | 2.39 (min 2.05) | true |
| chrome | 5000 | js | chunks | 13.2 (min 12.1) | 9.33 (min 6.93) | 6.66 (min 4.48) | 5.24 (min 4.00) | true |
| chrome | 5000 | wasm | chunks | 6.35 (min 5.51) | 4.22 (min 3.35) | 3.08 (min 2.20) | 3.49 (min 1.50) | true |
| chrome | 50000 | js | transfer | 163.6 (min 140.4) | 126.2 (min 103.6) | 95.5 (min 83.4) | 77.7 (min 58.4) | true |
| chrome | 50000 | wasm | transfer | 50.0 (min 48.6) | 65.9 (min 61.9) | 59.3 (min 51.1) | 61.5 (min 48.0) | true |
| chrome | 50000 | js | shared | 202.2 (min 180.3) | 128.6 (min 115.1) | 101.8 (min 80.9) | 91.8 (min 82.4) | true |
| chrome | 50000 | wasm | shared | 53.5 (min 50.5) | 60.6 (min 35.1) | 45.4 (min 29.5) | 66.1 (min 36.3) | true |
| chrome | 50000 | js | chunks | 155.5 (min 131.6) | 89.9 (min 72.5) | 63.7 (min 51.1) | 61.6 (min 34.5) | true |
| chrome | 50000 | wasm | chunks | 54.7 (min 50.1) | 39.7 (min 35.8) | 27.1 (min 25.0) | 21.6 (min 18.9) | true |
| webkit | 5000 | js | transfer | 23.2 (min 17.9) | 17.9 (min 16.5) | 15.1 (min 12.9) | 14.0 (min 12.0) | true |
| webkit | 5000 | wasm | transfer | 7.84 (min 6.16) | 9.70 (min 4.94) | 8.56 (min 3.96) | 6.88 (min 3.66) | true |
| webkit | 5000 | js | shared | 21.2 (min 17.6) | 15.9 (min 14.3) | 13.5 (min 12.3) | 11.6 (min 9.98) | true |
| webkit | 5000 | wasm | shared | 5.98 (min 5.52) | 4.58 (min 3.64) | 4.34 (min 2.82) | 3.58 (min 3.04) | true |
| webkit | 5000 | js | chunks | 24.8 (min 19.6) | 12.9 (min 12.7) | 10.1 (min 10.0) | 8.86 (min 8.48) | true |
| webkit | 5000 | wasm | chunks | 6.10 (min 5.22) | 3.72 (min 3.22) | 2.22 (min 1.96) | 1.88 (min 1.16) | true |
| webkit | 50000 | js | transfer | 182.4 (min 173.1) | 179.1 (min 165.0) | 146.1 (min 143.0) | 133.9 (min 125.0) | true |
| webkit | 50000 | wasm | transfer | 49.5 (min 41.1) | 60.3 (min 44.4) | 42.7 (min 35.9) | 48.0 (min 34.3) | true |
| webkit | 50000 | js | shared | 214.0 (min 198.5) | 182.3 (min 152.9) | 155.3 (min 132.5) | 123.2 (min 116.8) | true |
| webkit | 50000 | wasm | shared | 58.4 (min 50.2) | 45.0 (min 40.8) | 47.0 (min 33.0) | 43.2 (min 30.3) | true |
| webkit | 50000 | js | chunks | 193.3 (min 187.8) | 161.8 (min 139.7) | 112.4 (min 102.0) | 92.2 (min 87.3) | true |
| webkit | 50000 | wasm | chunks | 52.0 (min 41.2) | 44.3 (min 30.4) | 23.1 (min 21.5) | 20.7 (min 17.6) | true |


Baselines on one thread, from section 3, at 50k: TS tess + pack is 91 ms (V8) and 67 ms (JSC); wasm with results left in memory is 33 and 32 ms.

- **JS workers do not pay off in JSC.**
  - Even 8 JS workers (92–134 ms at 50k) are slower than one in-thread TS call (67 ms), because of the 78–113 ms spec clone.
  - In V8, 8 workers in chunk mode reach about 62 ms against 91 ms on one thread, a 1.5× gain from 8 cores.
- **wasm workers scale, and flatten at about 4.**
  - Chunk mode at 50k: V8 54.7 → 39.7 → 27.1 → 21.6 ms; JSC 52.0 → 44.3 → 23.1 → 20.7 ms (k = 1, 2, 4, 8).
  - That is about 2.5× at k = 8, with most of it by k = 4. Per-worker compute drops from about 22 ms to 9–11 ms at k = 8. What is left is copying about 200 MB out of wasm memory and transferring it.
  - At 5k, chunk mode goes from 6.1–6.4 to 1.9–3.5 ms; the absolute saving is 3–4 ms.
- **The two-round merge designs scale badly.** The merge (`set()` of about 200 MB) costs 17–55 ms at 50k and wipes out the parallel gain. Transfer mode does not improve past k = 1 in V8. Shared mode helps somewhat (V8 k = 4: 45 ms), but round 2 stays bandwidth-bound.
- **Nested workers work** in both Chrome and Playwright WebKit (checked: a module worker spawning a module worker). The layout worker could therefore own a tessellation pool itself, with no hop through the main thread.

## 6. SharedArrayBuffer and cross-origin isolation

- **Measured.** With COOP: same-origin and COEP: require-corp on plain HTTP:
  - Chrome and Playwright WebKit both report `crossOriginIsolated` true, and SharedArrayBuffer, shared WebAssembly.Memory and simd128 are all available.
  - Without the headers there is no SharedArrayBuffer.
  - Data: `results/csp-and-features.json`.
- **From documentation and issue trackers** (via a research sub-agent; not verified in the real app):
  - Tauri 2.1+ can set these headers through `app.security.headers` in tauri.conf.json, but they only apply to built assets, not to the Vite dev server ([Tauri docs](https://v2.tauri.app/security/http-headers/), [PR #11485](https://github.com/tauri-apps/tauri/pull/11485)).
  - Several independent reports from Oct–Nov 2026 say that on macOS 26 the `tauri://localhost` custom scheme still gives `crossOriginIsolated` false and no SharedArrayBuffer, while the same headers over loopback HTTP work. A WebKit change merged on 2026-10-03 confirms that custom URL scheme handler loads "skip COOP enforcement" ([WebKit PR 51027](https://github.com/WebKit/WebKit/pull/51027); reports: pdfcraft #201, niho-photo #173).
  - COEP require-corp would also affect `asset:` images: Tauri's asset protocol sends no CORP header.
- **Verdict:** not practical for Radiant on macOS. The only workaround is serving the UI over loopback HTTP (tauri-plugin-localhost), which opens a local port. And the measurements show no need: chunk mode without shared memory was the fastest design.

## 7. Platform facts for any future WebAssembly use

- **Feature support** (webassembly.org features table and WebKit release notes, via the research sub-agent):
  - Safari/WKWebView has SIMD since 16.4, threads and atomics since 14.1, bulk memory since 15, tail calls since 18.2, and JS String Builtins since 26.2.
  - Relaxed SIMD and memory64 are behind flags.
  - WKWebView uses the system WebKit, so the app gets the same features.
  - Safari 18.4+ can run wasm without JIT. Lockdown Mode disables JIT, and one report says wasm is unavailable in a Lockdown WKWebView. **Any wasm path therefore needs a JS fallback,** which means two implementations to keep identical.
- **CSP, measured:** with the app's own policy (`script-src 'self'`), `WebAssembly.compile` and `instantiateStreaming` are **blocked on the page** in both Chrome and WebKit, and adding `'wasm-unsafe-eval'` allows them.
  - A module worker whose script response carries no CSP header compiled wasm even when the page's CSP blocked it.
  - Per Tauri's source, CSP headers are attached only to .html assets, so a wasm-in-worker design might work unchanged in the built app. That is relying on a gap: add `'wasm-unsafe-eval'` to `script-src` explicitly.
  - That edit is in `src-tauri/tauri.conf.json`, which the coordinator owns. `vite.config.js` passes the same directives to SvelteKit with quotes stripped; I did not verify that SvelteKit accepts the `wasm-unsafe-eval` keyword there.
  - Not verified inside Tauri.
- **Bundling:**
  - A no-import cdylib is 46 KB after wasm-opt. Load it inside the worker with `import url from './x.wasm?url'` and `WebAssembly.instantiateStreaming(fetch(url))`, falling back to `instantiate(arrayBuffer)`. Tauri serves `.wasm` as application/wasm.
  - Vite's `worker.format` must be 'es' for module workers that import it.
  - No vite-plugin-wasm or wasm-bindgen is needed.
- **Per-call cost:** 2.5–6 ns per call to a trivial export in V8 and JSC (measured), so call granularity is not a constraint; object marshalling is.

## 8. Toolchain (what was installed, how long builds take)

- **Installed:**
  - `rustup target add wasm32-unknown-unknown` (about 6 s).
  - `brew install binaryen`: wasm-opt version 133, about 20 s from a bottle.
  - Playwright WebKit: `uv run --with playwright playwright install webkit`, about 30 s.
  - wasm-pack and wasm-bindgen were **not** installed or needed.
- **Build:**
  - The crate has no dependencies; release profile: opt-level 3, lto, codegen-units 1, panic abort.
  - Clean wasm32 build: 0.3–0.6 s. Native release build: 2.7 s.
  - `wasm-opt -O3`: 0.26–0.36 s. `bun build` of the TS bundle: about 10 ms.
- **Commands** (from the crate folder):
  - `cargo build --release --target wasm32-unknown-unknown --lib --target-dir target-scalar`
  - The same with `RUSTFLAGS="-C target-feature=+simd128"` and `--target-dir target-simd`.
  - Then `wasm-opt -O3 [--enable-simd] in.wasm -o out.wasm`.

## 9. Plans for follow-up agents

1. **(Do now, TS) Faster vertex packing.**
   - Replace the colour loop in `src/lib/render/mesh-vertices.ts` `packMeshVertices` with the run-cached u32 write in `bench/pack-fast.js`. Its output is byte-identical; verify by comparing buffers on the captured inputs with `bench/exp-pack.html`.
   - Expected saving: 10–15 ms per 50k rebuild in the worker, 0.4–1.3 ms at 5k.
   - Optional next step: have tessellateBatch emit u32 colours directly.
2. **(Do now, TS) Make BranchMeshCache's reuse path cheaper than a rebuild.**
   - In `src/lib/core/geometry/tessellate.ts`, replace the per-spec `sameSpec` field walk with a numeric hash computed when specs are built, and bulk-copy contiguous runs of reused branches.
   - Measure the all-reuse rebuild at 50k against tessellate-from-scratch with `bench/exp-pack.html`.
   - Target: well below 31 ms (it is 41–53 ms today).
3. **(Do now, TS) Struct-of-arrays tidyTree.**
   - Port `layout/tidy-soa.ts` into `src/lib/core/layout/tidy.ts`, keeping the `tidyTree` signature. It is already bit-identical on the captured inputs; re-check with the sub-agent's `layout/run-all.sh`.
   - Then attack the Map/object work in `settleLayout` and `layoutRootBoxes`, which is 80–88% of layout time.
4. **(Measure next) Structured-clone cost of the layout worker's own traffic in WKWebView.**
   - The work snapshot posted to the worker and the Map-heavy result posted back are object graphs. JSC cloned 50k small objects about 3× slower than V8 here.
   - Instrument `src/lib/ui/layout.worker.ts` and `layout-transport.ts` round trips in Playwright WebKit at 50k.
5. **(Shelve) wasm tessellation.** If dimensional or flat tessellation later becomes a real bottleneck (for example 50k-node maps in a relief material, which I did not measure), the shelf plan is:
   - Put the crate at `src-wasm/tessellate` in the repo, outside src-tauri, so the app is not rebuilt.
   - Have `branchSpecs()` write the 32-slot f64 records directly, or encode them (1 ms at 50k).
   - Run the module inside the layout worker. Results go out with one `slice()` per array and are transferred, replacing today's structured clone.
   - For ≥20k nodes, add a pool of 4 nested workers in chunk mode (one draw per chunk, origin from layout bounds).
   - Keep the TS path as the fallback for Lockdown Mode and for themes the port does not cover. Check equality in CI-less scripts with `bench/check.mjs`.
   - Add `'wasm-unsafe-eval'` to the CSP (coordinator file). Cap or recreate the instance to release its 217 MB of linear memory.
   - Expected gain over TS with the packing fix: about 15–25 ms per 50k rebuild on one thread, about 45 ms with 4 workers.
6. **(Don't) SharedArrayBuffer, JS-object workers, wasm tidyTree.** Reasons are in sections 4–6.

## 10. Not verified / limitations

- **Engines and app:**
  - Nothing ran in the real Tauri WKWebView. Playwright WebKit 27.2 is a newer engine than the macOS 26 system WebKit, and it was not run under the app's custom scheme. In particular, CSP behaviour for worker scripts and SharedArrayBuffer on tauri:// come from documentation and issue reports, not from my tests.
- **Coverage:**
  - Only the flat tessellation path was ported. The dimensional materials (relief, rope, quilling; `reliefBatch`) are heavier and might gain more from wasm, but they were not measured.
  - The worker experiments used the bench harness, not the app's layout worker. Draw-call and picking changes needed for chunk mode were not prototyped.
- **Noise:**
  - Timings were taken on a heavily shared machine (load average 12–27). 50k maxima and some medians are inflated by contention and by ~200 MB allocations per call.
  - Section 1's in-app numbers are Chrome only, 5 runs.
  - The in-app "fresh cache" and "all reuse" numbers in section 1 differ from the cleaner interleaved runs in section 3. Trust the interleaved ones.
- **Cold-start cause:** the V8 cold-call explanation for wasm (Liftoff tier plus memory growth) is an inference, not a profile.

## Files (all reusable)

Scratch root: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/wasm/`

- `data/`: captured inputs.
  - `input-5000.json`, `input-50000.json` (doc, sizes, specs, theme gaps), plus the themed variants.
  - `specs-*.json`; `flat-*.f64` (encoded records for native runs).
- `crate/`: Rust crate. `src/lib.rs` is the tessellation port with its C ABI; `src/bin/native_bench.rs` is the native benchmark (args: flat file, reps, threads).
- `bench/`:
  - `real.js` (bundled real TS), `entry.ts`, `encode.js`, `tess-wasm.js` (loader), `compare.js`, `check.mjs` (correctness).
  - `bench.js`, `bench.html`, `drive_browser.py`, `run_cli.mjs`, `drive_cli.mjs` (kernel benchmarks).
  - `workers.js`, `tess.worker.js`, `workers.html`, `drive_workers.py` (worker benchmarks).
  - `pack-fast.js`, `exp-pack.html`, `drive_exp.py` (packing and cache experiment).
  - `csp-test.*`, `drive_csp.py` (CSP, SharedArrayBuffer and feature probes); `serve.py` (static server with optional COOP/COEP/CSP); `summarize.mjs`; `wasm/*.wasm` (built modules).
- `results/`: raw JSON for every run.
  - `tess-{chrome,webkit,bun,node}.json`, `workers-{chrome,webkit}.json`, `exp-pack.json`, `csp-and-features.json`.
  - `summary.json` and `tables.md`.
- `layout/`: the sub-agent's tidy-tree study. Crate, `tidy-soa.ts`, `build.sh`, `run-all.sh`, and `results/results.md` with the full tables.
- `scripts/`: `capture.py` (input capture from the dev app), `breakdown.py` (in-app pipeline breakdown).
