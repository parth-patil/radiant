# M1: faster flat vertex packing

## Hypothesis
`packMeshVertices` (flat branch meshes, run in the layout worker after every rebuild) spends most of its time converting
four float colour channels per vertex with Math.round/min/max and four byte stores. A branch's colour is constant along
most of its vertices, so building the 32-bit colour word only when the colour changes and writing it with one u32 store
should cut packing from about 21-27 ms to about 14-18 ms at 50,000 nodes, byte-identical. Metrics that should move:
rebuild_ms, load_ms, edit_ms, fold_ms for flat themes (clean), by a few ms out of 100-1500 ms, i.e. well under the
benchmark's noise. The dimensional (relief) packer was checked for the same waste.

## What changed
- `src/lib/render/mesh-vertices.ts` `packMeshVertices`: colour word cached per run of equal colours, written through a
  Uint32Array view (little-endian, so the same bytes as the four Uint8 stores). New helper `unorm8` with exactly the old
  rounding/clamping. NaN channels still become 0 (NaN | x).
- Relief packer (`packReliefVertices`): it already copies the colour, normal and shadow words as 32-bit words (the relief
  tessellator emits packed rgba). It does not have the same waste. I tried a variant without per-vertex branches (separate
  loops for rope / non-rope, narrow meshes with shadows): no change in either engine (mins equal within 3 %), so it was
  dropped and the relief packer is unchanged.

## Correctness
- Kernel check (scratch harness, real modules bundled from the baseline pin and this tree, captured specs from the app at
  5k and 50k for clean, rope, soft-clay and paper-quilling): packed buffers are bit-identical (every u32 word, origin and
  wide flag) in Chrome and WebKit, for fresh tessellation, all-reuse and one-insert cache builds.
- bun run check: 0 errors, 0 warnings. check-boundaries: pass. check-browser (dev server :1434): all PASS.
- Visual guard (Chrome, 18 scenes, baseline 9992500 vs this): 18 scenes, worst map60-clean-light-fit 0.0000 % over threshold 8; (all 18 scenes: 0 differing pixels, max difference 0)

## Kernel numbers (scratch harness `scratchpad/ar/mesh/kbench`, A = baseline, B = this; 2 rounds, interleaved A/B in one page, gc() between samples in Chrome; ms median/min). Raw: kernel.json
| engine | size | theme | A med/min | B med/min |
|---|---|---|---|---|
| chrome | 5k | clean | 2.46/2.36, 2.50/2.43 | 2.01/1.94, 2.09/2.00 |
| chrome | 50k | clean | 71.6/27.2, 71.1/27.4 | 17.9/17.6, 17.9/17.4 |
| webkit | 5k | clean | 2.34/2.18, 2.36/2.20 | 1.60/1.46, 1.52/1.38 |
| webkit | 50k | clean | 58.2/22.7, 21.2/20.6 | 24.3/14.6, 13.9/13.4 |
Relief themes (rope, soft-clay, paper-quilling) are unchanged code; their A/B ratios scattered 0.8-2.4 on medians with mins
equal, which shows the harness noise on this shared machine (load average 6-8).
Chrome's old packer had a bimodal median (71 ms against a 27 ms min) after forced GCs; I did not investigate why.
Saving: about 10 ms (Chrome) and 7 ms (WebKit) per 50k flat rebuild, 0.4-0.8 ms at 5k, in the worker.

## Screening (measure.py --quick, chrome + webkit, 1 round; raw quick.json)
```
=== chrome  (quick, 1 rounds, GPU timer: True)
metric                                               A         B    B/A  verdict
load_ms@5k                                      120.84    137.88  1.141  ?slower
load_ms@50k                                       1025      1017  0.992  ~
rebuild_ms@5k/rope                              158.07    173.29  1.096  ~
rebuild_ms@5k/clean                             120.10    109.38  0.911  ~
rebuild_ms@50k/rope                               1304      1298  0.995  ~
rebuild_ms@50k/clean                              1460      1183  0.810  ?faster
edit_ms@5k                                      100.30     91.45  0.912  ~
edit_ms@50k                                       1131    825.74  0.730  ?faster
fold_ms@5k                                      193.03    176.28  0.913  ~
fold_ms@50k                                       2485      1614  0.649  ?faster
pan_cpu_mean@50k/rope                             1.93      1.93  1.005  ~
pan_cpu_mean@50k/clean                            1.50      1.56  1.036  ~
REBUILD                                         405.98    399.69  0.985  ~
INTERACTION                                     482.96    382.86  0.793  ?faster
FRAME                                             1.72      1.86  1.086  ~
DIMENSIONAL                                      10.27     11.05  1.076  ~
SCORE                                            69.55     65.81  0.946  ~
=== webkit  (quick, 1 rounds, GPU timer: False)
metric                                               A         B    B/A  verdict
load_ms@5k                                      136.20    190.64  1.400  ?slower
load_ms@50k                                       1431      1879  1.313  ?slower
rebuild_ms@5k/rope                              160.86    450.06  2.798  ?slower
rebuild_ms@5k/clean                             153.62    167.98  1.093  ~
rebuild_ms@50k/rope                               1914      3136  1.638  ?slower
rebuild_ms@50k/clean                              2912      2214  0.760  ?faster
edit_ms@5k                                      124.70    139.32  1.117  ?slower
edit_ms@50k                                       1619      1681  1.038  ~
fold_ms@5k                                      261.64    198.65  0.759  ?faster
fold_ms@50k                                       3253      2836  0.872  ?faster
pan_cpu_mean@50k/rope                             1.86      2.35  1.262  ?slower
pan_cpu_mean@50k/clean                            2.92      5.52  1.889  ?slower
REBUILD                                         547.22    756.90  1.383  ?slower
INTERACTION                                     643.88    602.71  0.936  ~
FRAME                                             1.91      2.40  1.256  ?slower
DIMENSIONAL                                      24.16     40.22  1.665  ?slower
SCORE                                            87.66    103.08  1.176  ?slower
```
The quick run cannot resolve a 10 ms change in a 1-3 s metric. WebKit's numbers in this run are dominated by noise: rope
metrics, which this change does not touch at all, came out 1.6-2.8x slower, and clean rebuild at 50k 0.76x. Chrome's
INTERACTION 0.79 is also far more than packing could explain (10 ms out of 800-2500 ms). Treat every metric here as
unproven noise.

## Verdict
keep (small, byte-identical, measured in isolation: packing 1.5x faster in Chrome and WebKit; end-to-end effect is under
1 % of a 50k rebuild and not visible in the quick benchmark).
