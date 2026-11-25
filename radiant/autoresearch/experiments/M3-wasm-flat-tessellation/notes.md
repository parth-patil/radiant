# M3: flat tessellation and packing in Rust compiled to WebAssembly, in the layout worker

This is the experiment that answers "would Rust and WebAssembly make it much more efficient". Short answer, measured:
the kernel is 2x faster in isolation, but in the app it saves about 35 ms of a 1,000 ms 50k rebuild in Chrome and
nothing measurable in WebKit (the shipping engine), and it costs 217 MB of WebAssembly memory in the worker that is
never given back. Discarded.

## Hypothesis
Study 03 measured a faithful Rust port of flat `tessellateBatch` + `packMeshVertices` at 91 -> 33 ms (Chrome) and 67 ->
32 ms (WebKit) for 50k branches, in isolation and before copying the results out of wasm memory. Integrated for real
(inside the layout worker's compute step, packing into the buffer that is transferred, TypeScript fallback), load_ms and
rebuild_ms for flat themes at 20-50k should drop by the kernel saving minus the copy-out.

## What changed (reverted in the next commit; screened as 5741e7e, the same code without these notes)
- `radiant/crates/tessellate/`: the study's crate (no dependencies, no wasm-bindgen, zero-import cdylib except four
  Math functions), with three changes: sin, cos, acos and hypot are imported from the host's `Math` (module "math"), so
  the output is bit-identical to the TypeScript path in each engine, including the f64 positions (the study's port
  differed by up to 1.1e-13 there because Rust's libm and the engines' Math differ in the last bit); a per-branch
  `starts` output (first vertex, which BranchMeshCache needs for later reuse); a `release` export. `build.sh` rebuilds
  `src/lib/ui/wasm/radiant_tess.wasm` (37,016 bytes after wasm-opt -O3), which is committed, so `bun run build` needs no
  Rust toolchain. `check.ts` is the equality check (below).
- `src/lib/ui/tessellate-wasm-kernel.ts`: encodes specs straight into wasm memory (32 f64 per spec), runs, and copies the
  mesh (positions, colours, indices, bounds, ends, starts) and the packed vertex buffer out with one slice each; the packed
  slice becomes `mesh.gpuVertices`, the buffer that is transferred to the main thread. It lives in ui/ because the
  architecture check counts WebAssembly as a platform API, not allowed in core.
- `src/lib/ui/tessellate-wasm.ts`: loads the module in the worker (`instantiateStreaming`, falling back to
  `instantiate`), installs it with `setFlatKernel`, falls back to TypeScript for good if WebAssembly is missing (Lockdown
  Mode) or a call throws. Sets a performance mark so a probe can see from the worker that the module is in use.
- `src/lib/core/geometry/tessellate.ts`: `FlatKernel` type and `setFlatKernel()`; `BranchMeshCache.build` now finds
  its reusable branches in a first pass (`hits`), and when the material is flat and fewer than half of the branches can
  be reused it takes the whole batch from the kernel; otherwise the TypeScript reuse path (M2) runs as before.
- `src/lib/ui/layout.worker.ts` (transport track's file, 3 lines): import and start the loader; `mesh.gpuVertices ??=
  packVertices(mesh)` so a kernel mesh is not packed twice.
- Dimensional materials were not ported. They would need reliefBatch and quill.ts (about 700 lines: relief attributes,
  shadows, rope twist and whippings, arcs lift, quilled walls and scrolls) in Rust, with the same Math imports, and a
  second packed layout. Their mesh step is 3-4x the flat one at 50k (rope: 135-240 ms in the app), so that is where a
  port would have more to gain, but the same copy-out and memory costs apply.

## Correctness
- `bun crates/tessellate/check.ts <dir>` (JavaScriptCore) and the same script bundled for node (V8): for the captured
  specs (clean 5k and 50k from this branch's app; buzan, studio, boardroom, sorbet, ink and clean 5k/50k from study 03)
  and a mutated copy of each (every style, flow, fade, start/both caps, tip dots, bent underlines, underline widths,
  start tangents, degenerate and zero-length limbs): positions, colours, indices, bounds, ends and the packed buffer
  (words, origin, wide flag) bit-identical to tessellateBranches + packMeshVertices; and a BranchMeshCache build over a
  kernel-built batch followed by a one-insert edit equals a fresh TypeScript tessellation of the edited specs, with
  exactly 1 branch rebuilt. 18/18 sets pass in both engines.
- In the browser: the kernel loads and is used in Chrome and Playwright WebKit both on the dev server and in a production
  bench build whose page carries the app's CSP meta tag (`script-src 'self'`, no 'wasm-unsafe-eval'): the worker script
  has no CSP of its own, so compiling wasm there is allowed. Not verified in Tauri's WKWebView; Tauri attaches CSP headers
  to HTML responses only, by study 03's reading of its source. If this is ever revived, add 'wasm-unsafe-eval' to
  script-src in src-tauri/tauri.conf.json (coordinator file) rather than rely on that gap.
- bun run check 0/0, check-boundaries pass, check-browser all PASS.
- Visual guard, parent M2 vs this: Chrome 18/18 and WebKit 18/18 scenes 0 differing pixels, max difference 0.

## Kernel numbers (scratch `scratchpad/ar/mesh/kbench/w.html`, real modules, one page per size and engine, 2 rounds,
ms median/min; raw kernel.json). "TS" = BranchMeshCache.build (fresh) + packVertices, as the worker does it after M1 and
M2; "wasm" = BranchMeshCache.build with the kernel installed: encode, run, copy everything out (packed included).
| engine | size | TS | wasm | of which copy-out | cold first call TS / wasm |
|---|---|---|---|---|---|
| chrome | 5k | 14.8/8.4, 14.3/8.1 | 5.96/5.51, 5.86/5.30 | 1.6-1.8 | 14.4 / 16.1-16.6 |
| chrome | 50k | 99.5/57.4, 100.1/56.2 | 50.1/48.8, 49.6/48.9 | 14.9-15.1 | 73-82 / 126-152 |
| webkit | 5k | 5.08/4.62, 4.42/4.08 | 4.32/3.88, 4.12/3.84 | 0.4-0.6 | 20.7 / 15-18 |
| webkit | 50k | 53.9/45.9, 52.8/40.4 | 52.4/36.8, 45.4/38.1 | 3.7-21 | 80-84 / 63-71 |
Chrome's TS medians are bimodal (median 100, min 56) after forced GCs in this harness; the mins are the fairer
comparison: Chrome 56-57 -> 49 ms, WebKit 40-46 -> 37-38 ms at 50k. The kernel alone (study 03: 33 ms, 32 ms) is about
half of TS, but the copy-out (15 ms in Chrome) and the spec encoding and cache bookkeeping eat most of the difference,
and the TS side got faster in M1 and M2. In Chrome the first wasm call at 50k is about twice as slow as the first TS call
(liftoff tier plus growing memory to 217 MB). Wasm memory: 25 MB at 5k, 217 MB at 50k, never shrinks while the worker
lives.

## In the app
In-app probe (`insitu.py` here; production bench builds of M2 and M3, 50k map, rope -> clean switch repeated 4 times per
page, 4 pages per build and engine, builds alternated, run under the benchmark lock; raw insitu.json), median [min-max]
of 16:
| engine | settled M2 | settled M3 | worker mesh step M2 (no packing) | M3 (with packing) |
|---|---|---|---|---|
| chrome | 999 [964-1232] | 964 [915-1064] | 53.5 [41-58] | 51.6 [48-120] |
| webkit | 1089 [1044-1118] | 1081 [1028-1170] | 55.3 [36-84] | 60.1 [46-121] |
So the kernel with its copies costs what TypeScript tessellation alone costs in the worker, and the saving is the TS
packing pass it replaces (about 15-20 ms): -35 ms (-3.5 %) in Chrome, overlapping ranges, and -8 ms (-0.7 %) in WebKit,
which is nothing.

## Screening (measure.py --quick, chrome + webkit, 1 round; raw quick.json)
```
=== chrome  (quick, 1 rounds, GPU timer: True)
metric                                               A         B    B/A  verdict
load_ms@5k                                      120.29    120.40  1.001  ~
load_ms@50k                                     984.41      1017  1.033  ~
rebuild_ms@5k/rope                              157.58    167.28  1.062  ~
rebuild_ms@5k/clean                             106.04    119.96  1.131  ?slower
rebuild_ms@50k/rope                               1171      1165  0.995  ~
rebuild_ms@50k/clean                              1061      1102  1.038  ~
edit_ms@5k                                       87.45     91.26  1.044  ~
edit_ms@50k                                     753.19    768.98  1.021  ~
fold_ms@5k                                      169.73    167.37  0.986  ~
fold_ms@50k                                       1455      1483  1.019  ~
pan_cpu_mean@50k/rope                             1.71      1.60  0.935  ~
pan_cpu_mean@50k/clean                            1.60      1.40  0.875  ?faster
REBUILD                                         367.42    383.00  1.042  ~
INTERACTION                                     357.11    363.28  1.017  ~
FRAME                                             1.99      1.69  0.849  ?faster
DIMENSIONAL                                      11.10      9.82  0.885  ?faster
SCORE                                            63.88     61.68  0.966  ~
=== webkit  (quick, 1 rounds, GPU timer: False)
metric                                               A         B    B/A  verdict
load_ms@5k                                      120.58    132.74  1.101  ?slower
load_ms@50k                                     974.72    978.88  1.004  ~
rebuild_ms@5k/rope                              160.52    141.34  0.881  ?faster
rebuild_ms@5k/clean                             147.88    151.62  1.025  ~
rebuild_ms@50k/rope                               1219      1283  1.052  ~
rebuild_ms@50k/clean                              1297      1293  0.997  ~
edit_ms@5k                                       85.02     83.72  0.985  ~
edit_ms@50k                                     806.42    760.30  0.943  ~
fold_ms@5k                                      154.96    150.24  0.970  ~
fold_ms@50k                                       1551      1568  1.010  ~
pan_cpu_mean@50k/rope                             1.45      1.55  1.074  ~
pan_cpu_mean@50k/clean                            1.35      1.50  1.112  ?slower
REBUILD                                         404.98    408.07  1.008  ~
INTERACTION                                     358.31    349.91  0.977  ~
FRAME                                             1.31      1.43  1.089  ~
DIMENSIONAL                                      19.67     19.99  1.016  ~
SCORE                                            57.47     58.82  1.023  ~
```
All "~" on the rebuild and interaction metrics. In the quick run's own diagnostics Chrome's rebuild@50k/clean mesh step
was 57 (A) vs 122 ms (B) once; the in-app probe above (16 samples) does not reproduce a loss of that size, so I take it
as one outlier.

## Verdict
discard. Bit-identical and working, with a TypeScript fallback, but on the shipping engine it changes nothing measurable,
in Chrome it saves about 3 %, and it adds a Rust crate, a committed binary, a second implementation to keep identical,
a CSP question in Tauri, and 217 MB of resident WebAssembly memory in the worker after a 50k map (the TypeScript path's
arrays are garbage-collected). The kernel's isolated 2x is real; the end-to-end number is what counts, and the time of a
50k rebuild is elsewhere: about 450-600 ms of layout in the worker, and most of the rest of the 1,000 ms in getting the
result to the main thread and adopting it.
