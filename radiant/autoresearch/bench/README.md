# Radiant rendering benchmark (autoresearch harness)

The fixed benchmark every autoresearch experiment is judged by. It builds a checkout for production, serves it,
drives it in headless Chrome and Playwright WebKit through one small adapter, and reports a score per engine
(geometric mean of fixed latency and frame-cost metrics in ms; lower is better). `visual.py` is the correctness
guard: pixel diffs of fixed scenes between two builds.

## Commands

Run from `radiant/` (any checkout; `--tree` and `--tree2` are radiant directories).

```sh
# Baseline of one checkout (Chrome, 3 rounds, about 5 minutes)
uv run autoresearch/bench/measure.py --tree . --label baseline --out autoresearch/results/baseline.json

# A/B: two checkouts, interleaved (Chrome, 3 rounds: about 10 minutes)
uv run autoresearch/bench/measure.py --tree . --tree2 /path/to/experiment/radiant --label exp-07 --out .../exp-07.json

# Screening run: 5k and 50k nodes, clean and rope, one round (about 40 s per build and engine)
uv run autoresearch/bench/measure.py --tree . --tree2 B --label exp-07-quick --out .../q.json --quick

# Both engines (WebKit is JavaScriptCore, the engine the shipping app runs on)
uv run autoresearch/bench/measure.py --tree . --label base --out base.json --engines chrome,webkit

# Correctness guard (about 45 s for 18 scenes in Chrome)
uv run autoresearch/bench/visual.py --tree . --tree2 B --out /path/to/visual-out
```

Options: `--rounds N` (default 3; 1 with `--quick`), `--engines chrome,webkit` (default chrome), `--rebuild`
(ignore the build cache). `visual.py`: `--engine webkit`, `--threshold 8`, `--only SUBSTRING`.

The JSON written to `--out` holds every round's raw metrics, medians, spreads, scores per round, the headline
list used, per-scenario diagnostics (layout, geometry and mesh ms from the worker, adoption ms, first-frame draw
ms, triangles, camera zoom and items on screen, GPU samples), the build keys and commits, and any problems.

## What a run does

1. Takes an exclusive `fcntl` lock on `scratchpad/ar/bench.lock` for the whole run (measure.py and visual.py),
   so two measurements never overlap. A second run waits and says who holds the lock. Note that other agents'
   own browsers and builds are not covered by the lock; see Noise.
2. Builds each tree for production with `VITE_RADIANT_BENCH=1` (`bun run build`). The front-end sources (all of
   radiant/ except node_modules, build, .svelte-kit, target, docs, requirements, autoresearch, dot directories,
   and all of src-tauri except `tauri.conf.json`) are copied to `scratchpad/ar/bench-builds/<key>/` and built
   there with the tree's node_modules linked in, so the checkout's own `build/` and `.svelte-kit/` are never
   touched and the owner's dev server is not disturbed. `<key>` is a hash of those files, so an unchanged tree is
   not rebuilt (a build takes about 6 s; the 16 most recent are kept). A tree without node_modules (a fresh
   worktree) gets `bun install --frozen-lockfile` first. If an experiment adds a build step (a WASM crate, say),
   it must be part of `bun run build` and its sources must live inside radiant/ outside the skipped paths.
3. Serves each build on a free port with a small static server: SPA fallback, `.wasm` MIME type, no caching, and
   COOP/COEP headers so the page is cross-origin isolated. Isolation is what makes `performance.now()` usable:
   measured here, Chrome's resolution goes from 100 us to 5 us and WebKit's from 1 ms to 20 us. Side effect: the
   page has `SharedArrayBuffer`; an experiment must not rely on it unless the Tauri shell sends the same headers.
4. Launches Chrome (`channel="chrome"`, `--use-angle=metal --enable-gpu --enable-precise-memory-info
   --js-flags=--expose-gc`) and/or Playwright WebKit (Playwright 1.65.2, pinned to match the installed
   webkit-2388 build), one discarded warm-up page per build and engine, then the rounds.
5. Each map size runs in a fresh browser context: viewport 1728 x 1117 at device scale factor 2 (canvas 3456 x 2234
   px), light colour scheme, `prefers-reduced-motion: reduce` (so latency metrics measure work, not the 0.3 s
   fold/layout animations; the app honours this setting). With two trees the sizes are interleaved
   A B, B A, A B ... so the two halves of each pair are measured within about a minute of each other.

## The adapter: `src/lib/ui/bench-hooks.ts` (window.__radiantBench)

Installed only in builds made with `VITE_RADIANT_BENCH=1` (App.svelte; the flag also installs the dev hooks of
`debug.ts`, `window.__radiant`). Normal production builds drop both. The page-side driver `bench.js` uses
nothing but this adapter, so experiments that restructure internals (WASM core, more workers, rendering in a
worker, WebGPU) keep the harness working by keeping the adapter's contract, documented at the top of the file:
`loadSynthetic`, `loadOutline`, `setTheme`, `setDark`, `nodeCount`, `bounds`, `box`, `nodeAtDepth`,
`nodeWithSubtreeNear`, `shape`, `addChild`, `toggleFold`, `camera`, `setCamera`, `fit`, `frames`,
`layoutGeneration`, `idle`, `onFrame`, `gpuTimer`, `gpuSamples`, `memory`, `diagnostics`.
The three that carry the timing semantics:

- `onFrame(fn)`: called after every drawn frame with the time its draw calls were issued and the main-thread ms
  the draw took. If rendering moves off the main thread, report the main-thread cost the frame still causes.
- `idle()`: true only when nothing is on its way to the screen (no pending or in-flight layout, scheduled flush,
  animation, requested frame, or outstanding label/picture work). Backed by `AppController.frameWorkPending`
  and `Renderer.idle`.
- `layoutGeneration()`: increases when a new layout result is adopted for display.

GPU timing and buffer accounting live in `src/lib/render/bench-probe.ts` (GPU APIs must stay in render/).

## Scenarios and metrics

Map: `loadSynthetic(n)` (fixed-seed LCG, so the tree is identical every run; node ids are random but do not
affect layout or pixels, see visual A/A). Sizes 5,000, 20,000, 50,000 (`--quick`: 5,000 and 50,000). After loading
in `clean`, the themes are switched in this order: soft-clay, lifted-arcs, rope, paper-quilling, clean
(`--quick`: rope, clean).

"Settled" below means: from the action to the end of the last frame drawn before `idle()` held for two
consecutive animation frames (so label rasterisation spread over several frames is included). The first frame
that shows the new layout is recorded too (`firstMs` in the diagnostics); with reduced motion they are usually
the same frame.

| metric | definition |
|---|---|
| `load_ms@S` | `loadSynthetic(S)` (builds the doc on the main thread, then the normal layout path) to settled. |
| `rebuild_ms@S/T` | `setTheme(T)` (a full relayout, remeasure and retessellation) to settled. |
| `edit_ms@S` | add one child to the middle depth-3 node (camera at zoom 1 on it) to settled; median of 3 adds. |
| `fold_ms@S` | fold, then unfold, the node whose subtree is closest to 300 descendants (287 at 5k), camera at fit; sum of both settled times; median of 2. |
| `pan_cpu_mean@S/T`, `pan_cpu_p95@S/T` | main-thread script per frame while panning and zooming (sinusoidal path, zoom +-8 %), pooled over three positions: the whole map (fit), zoom 0.35 and zoom 1.0 centred on the middle depth-2 node; 10 warm-up + 45 measured frames each. Per frame = the camera change including the microtask in which the app's reactive UI runs, plus the main-thread draw of the frame it causes. Per-position values are in the JSON (`.../fit`, `.../z0.35`, `.../z1.0`). The run warns if fewer than 20 items are drawn at zoom 0.35 or 1 (camera not over the map); measured: 250-410 items at 0.35, 56-112 at 1.0. |
| `pan_gpu_mean@S/T` | GPU ms per frame from EXT_disjoint_timer_query_webgl2 during the same frames (Chrome only). |
| `stream_*@S/T` | animations on; pan for 165 frames while 20 children are added one every 6 frames to a depth-3 node, then settle. `block_max_ms`: longest main-thread stall seen by a chained setTimeout(0) probe (works in both engines); `block_total_ms`: sum of stalls beyond 50 ms (TBT-like); `longtask_max_ms` (Chrome Long Tasks API); `worst_gap_ms`, `missed_frames` (rAF interval > 25 ms, i.e. at least one 60 Hz frame missed), `over33`. |
| `heap_mb@S` | JS heap after load and two forced GCs (Chrome; `performance.memory` and `gc()` do not exist in WebKit). Main thread only; the worker's heap is not included. |
| `gpu_buffer_mb@S/T` | bytes in WebGL buffers allocated through `bufferData` (textures not counted). |

The ">16.7 ms" frame count asked for in the brief is not reported as a headline: headless Chrome's rAF interval
jitters around 16.67 ms (16.66-16.70), so about half of perfectly smooth frames exceed 16.7. `missed_frames` uses
25 ms (1.5 refresh intervals) instead; the raw count is kept in the JSON as `over16_7`.

## Score

The list lives in one place: `headline()` in measure.py.

- rebuild = geomean of `load_ms` (each size) and `rebuild_ms` (each size x theme)
- interaction = geomean of `edit_ms` and `fold_ms` (each size)
- frame = geomean of `pan_cpu_mean`, `pan_cpu_p95` and, where the engine has a GPU timer, `pan_gpu_mean` (each size x theme)
- dimensional = geomean of `rebuild_ms`, `pan_cpu_mean` (and `pan_gpu_mean`) for the four dimensional themes; reported, not scored
- **score = geomean(rebuild, interaction, frame)**; equal weight per category, whatever the number of metrics in it

Scores are only comparable between runs of the same mode (full or quick) and engine. Chrome's frame score
includes GPU time; WebKit's does not (no timer query in WebKit). Heap, GPU bytes and the stream metrics are
reported but not scored (see Noise for why the stream metrics are not).

## Noise rule (A/B verdict)

Per metric, A and B each have one value per round. The comparison prints the two medians, the ratio B/A and a
verdict. **faster/slower** only when (1) the A and B round values do not overlap at all, and (2) the change of
medians exceeds both twice the pooled round-to-round spread (sample sd of the ln values within each build) and
3 % (`FLOOR`). Otherwise `~` (within noise). With one round there is no spread: changes over 10 % are shown as
`?faster`/`?slower` (unverified). The same rule is applied to the per-round scores. With 3 rounds, complete
separation alone happens by chance 10 % of the time, hence the second condition; on the A/A runs this rule
flagged 4 of 69 single metrics and none of the scores (details below). Use the score and the sub-scores to
decide; treat single-metric verdicts as pointers, and rerun with `--rounds 5` when a decision hinges on one.

## Validation (2026-11-25, M4 Pro, other agents active)

Two full A/A runs, Chrome and WebKit, 3 rounds, main tree against a `git worktree` of the same commit with the
same working changes. Raw JSON in `results/`. Everything here is provisional: other agents were running their own
browsers and builds at the same time (one was running WebKit and Chrome benchmarks during both runs).

**Run 1** (builds interleaved per whole round, no warm-up; `results/aa-2026-11-25-first.json`): round 1 was
about 40 % slower than rounds 2-3 in both engines (score 97 vs 68-70 in Chrome), so per-metric spread was 15-45 %
and the paired A/B ratios of single rounds ranged 0.47-2.0. Rounds 2-3 alone had a mean per-metric sd of about 7 %.
That led to the two changes now in measure.py: a discarded warm-up page per build and engine, and interleaving
per map size (A B, B A, ...) instead of per round.

**Run 2** (final harness; `results/aa-2026-11-25-final.json`): 19.1 minutes for both engines, 2 builds,
3 rounds (Chrome about 89 s and WebKit about 100 s per build per round, so one build in one engine at 3 rounds is
about 4.5-5 minutes plus about 20 s of warm-up; `--quick` A/B in Chrome took 73 s). Builds: 6 s each, cached.

| | Chrome median | Chrome sd | WebKit median | WebKit sd |
|---|---:|---:|---:|---:|
| **score** | 67.93 | 2.3% | 70.55 | 3.8% |
| **rebuild** | 396 | 2.4% | 493 | 3.7% |
| **interaction** | 411 | 3.0% | 452 | 4.8% |
| **frame** | 1.89 | 2.1% | 1.55 | 4.0% |
| **dimensional** | 9.81 | 1.0% | 22.49 | 3.4% |

sd = pooled round-to-round sd of ln values within a build (6 values per engine). A vs B score ratio: Chrome 1.01,
WebKit 1.03, both `~`. Single headline metrics: median sd 6.2 % (Chrome, 69 metrics) and 7.1 % (WebKit, 54);
the noise rule flagged 1 of 69 (Chrome, `rebuild_ms@5k/soft-clay`, +8 %) and 1 of 54 (WebKit,
`pan_cpu_p95@5k/lifted-arcs`, +14 %) as different although the code was identical. In run 1 it flagged 4 of 69
and 0 of 54, and no scores.

Too noisy to use as a headline (kept in the JSON as diagnostics, not scored):
- `stream_block_max_ms` / `stream_block_total_ms`: sd 15-90 % at 20k and 50k; `stream_worst_gap_ms`,
  `stream_missed_frames`, `stream_over33` are small integer counts or multiples of 16.7 ms and swing 1.5-5x
  between identical builds. Chrome's `stream_longtask_max_ms@50k` is stable (sd 3-4 %, 87-93 ms) and is the
  jank number to watch.
- `pan_gpu_mean`: sd 7-30 % (the GPU is shared with the other agents' browsers). It stays in Chrome's frame and
  dimensional sub-scores because GPU time is most of a dimensional frame; the sub-scores still came out at sd 1-2 %.
- In WebKit `rebuild_ms@50k/paper-quilling` had one 2x outlier pair (sd 32 %).

Sensitivity check of visual.py: changing one branch colour by 1/255 (`#D55E00` to `#D45E00`) gave 0 % over the
threshold, max difference 1, and 0.3-0.7 % of pixels with some difference, so tiny changes show in the "any"
column and real ones in the "differ" column.

### Baseline (run 2, median of 6 rounds of identical code; sd as above)

Per-position pan values are listed for 50k clean and rope only; the JSON has all of them.

| metric | Chrome median | Chrome sd | WebKit median | WebKit sd |
|---|---:|---:|---:|---:|
| load_ms@5k | 121 | 2% | 132 | 7% |
| load_ms@20k | 436 | 3% | 443 | 3% |
| load_ms@50k | 1023 | 2% | 1012 | 5% |
| rebuild_ms@5k/soft-clay | 151 | 2% | 146 | 4% |
| rebuild_ms@5k/lifted-arcs | 127 | 3% | 153 | 3% |
| rebuild_ms@5k/rope | 152 | 6% | 225 | 4% |
| rebuild_ms@5k/paper-quilling | 121 | 4% | 162 | 5% |
| rebuild_ms@5k/clean | 114 | 2% | 137 | 5% |
| rebuild_ms@20k/soft-clay | 472 | 4% | 479 | 3% |
| rebuild_ms@20k/lifted-arcs | 430 | 3% | 568 | 5% |
| rebuild_ms@20k/rope | 423 | 2% | 786 | 7% |
| rebuild_ms@20k/paper-quilling | 461 | 3% | 578 | 7% |
| rebuild_ms@20k/clean | 345 | 5% | 538 | 7% |
| rebuild_ms@50k/soft-clay | 1108 | 3% | 1191 | 6% |
| rebuild_ms@50k/lifted-arcs | 1128 | 5% | 1273 | 7% |
| rebuild_ms@50k/rope | 1111 | 6% | 1626 | 8% |
| rebuild_ms@50k/paper-quilling | 1192 | 8% | 1557 | 32% |
| rebuild_ms@50k/clean | 1007 | 4% | 1360 | 10% |
| edit_ms@5k | 101 | 0% | 102 | 0% |
| edit_ms@20k | 317 | 5% | 348 | 7% |
| edit_ms@50k | 804 | 5% | 895 | 7% |
| fold_ms@5k | 214 | 0% | 217 | 2% |
| fold_ms@20k | 565 | 6% | 687 | 6% |
| fold_ms@50k | 1545 | 4% | 1783 | 8% |
| pan_cpu_mean@5k/soft-clay | 0.58 | 7% | 0.58 | 8% |
| pan_cpu_p95@5k/soft-clay | 1.14 | 5% | 1.18 | 8% |
| pan_gpu_mean@5k/soft-clay | 1.41 | 14% | - | - |
| pan_cpu_mean@5k/lifted-arcs | 0.52 | 7% | 0.56 | 3% |
| pan_cpu_p95@5k/lifted-arcs | 1.06 | 10% | 1.21 | 4% |
| pan_gpu_mean@5k/lifted-arcs | 1.53 | 20% | - | - |
| pan_cpu_mean@5k/rope | 0.42 | 6% | 0.45 | 8% |
| pan_cpu_p95@5k/rope | 0.75 | 4% | 0.87 | 19% |
| pan_gpu_mean@5k/rope | 1.63 | 18% | - | - |
| pan_cpu_mean@5k/paper-quilling | 0.40 | 13% | 0.48 | 7% |
| pan_cpu_p95@5k/paper-quilling | 0.78 | 10% | 1.00 | 7% |
| pan_gpu_mean@5k/paper-quilling | 1.65 | 27% | - | - |
| pan_cpu_mean@5k/clean | 0.39 | 9% | 0.43 | 9% |
| pan_cpu_p95@5k/clean | 0.74 | 9% | 0.83 | 9% |
| pan_gpu_mean@5k/clean | 1.08 | 19% | - | - |
| pan_cpu_mean@20k/soft-clay | 1.45 | 4% | 1.36 | 8% |
| pan_cpu_p95@20k/soft-clay | 8.00 | 2% | 3.59 | 13% |
| pan_gpu_mean@20k/soft-clay | 2.42 | 7% | - | - |
| pan_cpu_mean@20k/lifted-arcs | 1.27 | 8% | 1.24 | 6% |
| pan_cpu_p95@20k/lifted-arcs | 5.22 | 7% | 3.35 | 5% |
| pan_gpu_mean@20k/lifted-arcs | 2.76 | 23% | - | - |
| pan_cpu_mean@20k/rope | 0.88 | 6% | 0.88 | 7% |
| pan_cpu_p95@20k/rope | 4.04 | 4% | 2.69 | 12% |
| pan_gpu_mean@20k/rope | 2.02 | 20% | - | - |
| pan_cpu_mean@20k/paper-quilling | 0.92 | 8% | 0.97 | 11% |
| pan_cpu_p95@20k/paper-quilling | 4.25 | 13% | 3.26 | 26% |
| pan_gpu_mean@20k/paper-quilling | 2.01 | 27% | - | - |
| pan_cpu_mean@20k/clean | 0.71 | 5% | 0.90 | 8% |
| pan_cpu_p95@20k/clean | 1.75 | 6% | 3.08 | 20% |
| pan_gpu_mean@20k/clean | 1.95 | 20% | - | - |
| pan_cpu_mean@50k/soft-clay | 2.21 | 4% | 1.92 | 9% |
| pan_cpu_p95@50k/soft-clay | 10.44 | 6% | 5.83 | 7% |
| pan_gpu_mean@50k/soft-clay | 3.63 | 8% | - | - |
| pan_cpu_mean@50k/lifted-arcs | 1.92 | 5% | 1.54 | 9% |
| pan_cpu_p95@50k/lifted-arcs | 9.19 | 9% | 5.27 | 8% |
| pan_gpu_mean@50k/lifted-arcs | 2.91 | 16% | - | - |
| pan_cpu_mean@50k/rope | 1.85 | 9% | 1.27 | 5% |
| pan_cpu_p95@50k/rope | 12.05 | 17% | 4.96 | 7% |
| pan_gpu_mean@50k/rope | 3.10 | 10% | - | - |
| pan_cpu_mean@50k/paper-quilling | 1.71 | 7% | 1.46 | 12% |
| pan_cpu_p95@50k/paper-quilling | 9.35 | 15% | 4.81 | 9% |
| pan_gpu_mean@50k/paper-quilling | 3.13 | 19% | - | - |
| pan_cpu_mean@50k/clean | 1.47 | 3% | 1.35 | 10% |
| pan_cpu_p95@50k/clean | 7.52 | 7% | 4.34 | 6% |
| pan_gpu_mean@50k/clean | 3.24 | 30% | - | - |
| pan_cpu_mean@50k/clean/fit | 3.64 | 4% | 2.00 | 7% |
| pan_cpu_mean@50k/clean/z0.35 | 0.43 | 2% | 1.26 | 20% |
| pan_cpu_mean@50k/clean/z1.0 | 0.33 | 7% | 0.78 | 11% |
| pan_cpu_mean@50k/rope/fit | 4.75 | 11% | 2.05 | 4% |
| pan_cpu_mean@50k/rope/z0.35 | 0.46 | 3% | 1.13 | 9% |
| pan_cpu_mean@50k/rope/z1.0 | 0.35 | 3% | 0.70 | 10% |
| gpu_buffer_mb@20k/clean | 45.66 | 0% | 45.73 | 0% |
| gpu_buffer_mb@20k/lifted-arcs | 60.54 | 0% | 60.60 | 0% |
| gpu_buffer_mb@20k/paper-quilling | 69.30 | 0% | 69.37 | 0% |
| gpu_buffer_mb@20k/rope | 78.19 | 0% | 78.26 | 0% |
| gpu_buffer_mb@20k/soft-clay | 56.30 | 0% | 56.35 | 0% |
| gpu_buffer_mb@50k/clean | 104 | 0% | 104 | 0% |
| gpu_buffer_mb@50k/lifted-arcs | 146 | 0% | 146 | 0% |
| gpu_buffer_mb@50k/paper-quilling | 153 | 0% | 153 | 0% |
| gpu_buffer_mb@50k/rope | 183 | 0% | 183 | 0% |
| gpu_buffer_mb@50k/soft-clay | 132 | 0% | 132 | 0% |
| gpu_buffer_mb@5k/clean | 12.37 | 0% | 12.40 | 0% |
| gpu_buffer_mb@5k/lifted-arcs | 16.10 | 0% | 16.16 | 0% |
| gpu_buffer_mb@5k/paper-quilling | 22.61 | 0% | 22.64 | 0% |
| gpu_buffer_mb@5k/rope | 21.47 | 0% | 21.53 | 0% |
| gpu_buffer_mb@5k/soft-clay | 16.35 | 0% | 16.39 | 0% |
| heap_mb@20k | 116 | 0% | - | - |
| heap_mb@50k | 275 | 0% | - | - |
| heap_mb@5k | 34.89 | 0% | - | - |
| stream_block_max_ms@20k/clean | 45.63 | 13% | 38.44 | 29% |
| stream_block_max_ms@20k/rope | 55.77 | 27% | 35.15 | 27% |
| stream_block_max_ms@50k/clean | 115 | 16% | 60.54 | 18% |
| stream_block_max_ms@50k/rope | 136 | 20% | 57.53 | 20% |
| stream_block_max_ms@5k/clean | 30.68 | 1% | 15.58 | 6% |
| stream_block_max_ms@5k/rope | 32.31 | 1% | 16.43 | 7% |
| stream_block_total_ms@20k/clean | 0.00 | - | 0.00 | - |
| stream_block_total_ms@20k/rope | 5.77 | 81% | 0.00 | - |
| stream_block_total_ms@50k/clean | 65.06 | 29% | 10.54 | 66% |
| stream_block_total_ms@50k/rope | 86.84 | 26% | 11.45 | 90% |
| stream_block_total_ms@5k/clean | 0.00 | - | 0.00 | - |
| stream_block_total_ms@5k/rope | 0.00 | - | 0.00 | - |
| stream_longtask_max_ms@20k/clean | 0.00 | - | - | - |
| stream_longtask_max_ms@20k/rope | 0.00 | - | - | - |
| stream_longtask_max_ms@50k/clean | 93.00 | 3% | - | - |
| stream_longtask_max_ms@50k/rope | 89.50 | 4% | - | - |
| stream_longtask_max_ms@5k/clean | 0.00 | - | - | - |
| stream_longtask_max_ms@5k/rope | 0.00 | - | - | - |
| stream_missed_frames@20k/clean | 1.00 | 28% | 2.00 | 75% |
| stream_missed_frames@20k/rope | 1.50 | 53% | 3.00 | 23% |
| stream_missed_frames@50k/clean | 2.00 | 38% | 1.50 | 57% |
| stream_missed_frames@50k/rope | 1.50 | 66% | 1.00 | 0% |
| stream_missed_frames@5k/clean | 0.00 | - | 0.00 | - |
| stream_missed_frames@5k/rope | 0.00 | - | 0.00 | - |
| stream_worst_gap_ms@20k/clean | 33.33 | 0% | 42.84 | 33% |
| stream_worst_gap_ms@20k/rope | 33.33 | 0% | 41.12 | 31% |
| stream_worst_gap_ms@50k/clean | 58.33 | 53% | 41.45 | 72% |
| stream_worst_gap_ms@50k/rope | 33.33 | 54% | 29.75 | 22% |
| stream_worst_gap_ms@5k/clean | 16.67 | 0% | 18.75 | 10% |
| stream_worst_gap_ms@5k/rope | 16.67 | 0% | 23.68 | 5% |

Notable in the baseline (facts, not yet investigated): at 50k, load, rebuild and fold take 1.0-1.9 s and an edit
0.8-0.9 s; the worker diagnostics put layout at 430-840 ms and geometry at 70-200 ms of that. Panning the whole
50k map at fit costs 3.6 ms (clean) and 4.7 ms (rope) of script per frame in Chrome, p95 7-8.5 ms, against about
2.0 ms (p95 4-5.6 ms) in WebKit; at zoom 0.35 and 1.0 it is 0.3-0.6 ms (Chrome) and 0.7-1.5 ms (WebKit). The
main-thread draw of the first frame after a theme switch (which includes the mesh upload) is 2-80 ms, largest at 50k. Dimensional themes hold up to 183 MB in WebGL buffers at 50k, clean 104 MB.


## Synthetic map (what `loadSynthetic` produces)

Deterministic (seed 12345), but not very realistic:

- 5,000: the root's first 7 of 9 planned branches use up the budget; a strict 6-level tree, depth histogram
  1 / 7 / 24 / 85 / 297 / 1,018 / 3,568; every label is "Big d.i" (7 characters); no wrapping, no notes.
- 20,000 and 50,000: the same 6-level tree under 9 branches, then "Extra N" nodes added by random walks that
  stop with 15 % probability per level. Most land near the top: at 50,000 the depth histogram is
  1 / 9 / 6,708 / 10,375 / 10,747 / 9,020 / 9,144 / 2,603 / 940 / 327 / 90 / 29 / 6 / 1, i.e. each of the 9 main
  branches has about 745 direct children. Labels are 7 to 11 characters ("Extra 12345").
- At fit the 50,000 map is drawn at zoom 0.0023 (it is a very tall column).

Proposal (not implemented, so numbers stay comparable): add a second generator, `loadRealistic(n)`, with a
fixed seed, branching drawn from a heavy-tailed distribution (mostly 2-7, occasionally 15-40), depth 3-12 with
some long chains, label lengths drawn from real maps (median about 18 characters, 10 % over 60, a few multi-line
over 120), a few notes, links and folded subtrees, and use it for an extra `realistic` size in the scenarios.
Label length matters: today's maps never exercise wrapping, wide label atlases or long text measurement.

## visual.py

Scenes (18): a 59-node map built in code (short, long and multi-line labels, a 6-level chain, punctuation,
non-ASCII) in clean, soft-clay, lifted-arcs, rope, paper-quilling (light) and clean, rope (dark), each at fit and
at zoom 2 on the first main branch; and the 5,000-node map in clean and rope at fit and at zoom 0.35. Each scene
is captured from both builds in fresh contexts after `idle()`; full viewport PNG at scale 2 (3456 x 2234).
Per scene: `A.png`, `B.png`, `diff.png` (A dimmed; red = channel difference above the threshold, yellow = any
smaller difference), the share of pixels over the threshold (default 8/255 on any channel), the share with any
difference, and the largest difference. A build compared with itself gave 0 differing pixels and max difference 0
in all 18 scenes (Chrome).

## Known limits

- Timings are taken while other agents use the machine; the lock only serialises this harness. See Noise.
- Per-frame script is the camera change plus the draw; style, layout and paint of DOM overlays that react to the
  camera (handles, minimap) run after the frame's script and are not counted.
- "Presented" is approximated by the end of the draw calls; the compositor and GPU completion are not waited for.
- WebKit: no GPU timer (EXT_disjoint_timer_query_webgl2 is not exposed), no heap size, no Long Tasks API; its
  WebGL renderer string is masked ("WebKit WebGL"), so whether Playwright's headless WebKit uses the same Metal
  path as the app's WKWebView is not verified. Playwright WebKit is not WKWebView in Tauri: same engine
  (JavaScriptCore, WebKit 27.2 here), different embedding and process model.
- Headless Chrome runs rAF at 60 Hz, not 120 Hz; frame-gap metrics are in 60 Hz terms.
- `edit_ms` adds the node with a text through the editor (no inline text editor opens, unlike Tab in the app).
- Theme rebuild values depend on the order of the switches (each is the switch from the previous theme).
- GPU buffer bytes count `bufferData` sizes only (no textures, no driver overhead).
