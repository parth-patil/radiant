# M2: make the branch-mesh reuse cache cheaper than a rebuild

## Hypothesis
`BranchMeshCache` reuses the geometry of unchanged branches, but it copies each reused branch on its own: five or six
`subarray()` views and `set()` calls per branch (positions, colours or the relief arrays, indices, bounds), plus a
per-index rebase loop. At 50k that is a few hundred thousand small typed-array objects per edit, so (study 03) an
all-reuse build cost 41-53 ms against 30-34 ms for tessellating everything. Copying runs of consecutive reused branches
(consecutive in the new spec list and in the previous batch) with one `set()` per array should make reuse clearly
cheaper than a rebuild. Metrics that should move: edit_ms and fold_ms, mostly at 50k, through the worker's
`branchMeshMs`. The field-by-field `sameSpec` test was kept (a hash would still have to read every field).

## What changed
`src/lib/core/geometry/tessellate.ts`: new `reuseRun()` copies branches c0..c1 of the previous batch in one go per
per-vertex array ("lanes"), rebases indices once for the run, copies the run's bounds, and writes the run's `starts` and
`ends`. `tessellateBatch` (flat) and `reliefBatch` (all four dimensional materials) extend a pending run while hits
stay consecutive and flush it before any branch is tessellated afresh and at the end. Output is unchanged.

(Screened as 927fc55, the same code without these notes.)

## Correctness
- Scratch kernel check (`scratchpad/ar/mesh/kbench`, real modules from the parent pin and this tree, specs captured from
  the app for clean, soft-clay, lifted-arcs, rope and paper-quilling at 5k and 50k): fresh build, all-reuse build and a
  one-insert edit build give identical positions, indices, bounds, ends and packed vertex buffers to the parent, and the
  edit build equals a fresh tessellation of the edited specs, in Chrome and WebKit. (The first version had a bug: after a
  flush the run end was not reset, so a hit right after a miss was dropped. The edit check caught it.)
- bun run check 0/0; check-boundaries pass; check-browser all PASS (dev server on :1434).
- Visual guard, Chrome, parent ebf490a vs this: 18/18 scenes 0 differing pixels, max difference 0, any-difference 0.

## Kernel numbers (ms median/min, parent -> this; 1 round, interleaved in one page; raw kernel.json)
| engine | 50k theme | all-reuse build | one-insert edit build |
|---|---|---|---|
| chrome | clean | 34.6/32.7 -> 25.8/23.7 | 34.4/32.6 -> 22.6/21.5 |
| chrome | rope | 64.6/60.8 -> 36.7/36.1 | 64.0/60.8 -> 39.6/37.7 |
| chrome | soft-clay | 39.3/36.1 -> 24.6/23.5 | 38.3/35.2 -> 23.3/22.1 |
| chrome | lifted-arcs | 40.7/37.0 -> 25.8/21.0 | 47.4/41.4 -> 29.3/25.8 |
| chrome | paper-quilling | 48.1/44.9 -> 32.0/29.3 | 52.9/48.5 -> 37.5/30.5 |
| webkit | clean | 217/68.5 -> 63.7/31.6 | 97.2/63.6 -> 95.7/31.3 |
| webkit | rope | 299/94.1 -> 118/69.2 | 175/109 -> 73.3/42.7 |
| webkit | soft-clay | 204/83.6 -> 103/57.8 | 160/88.5 -> 60.4/33.3 |
| webkit | lifted-arcs | 238/55.8 -> 113/35.5 | 203/103 -> 63.6/28.6 |
| webkit | paper-quilling | 348/96.7 -> 135/63.3 | 226/108 -> 89.0/43.3 |
WebKit medians in this run were inflated by machine load (load average 6-8); the mins agree with the medians' direction.
A run with the two builds swapped in the page (kernel-swapped.json) gave the same direction for reuse and edit (Chrome
clean edit 34.0 -> 22.9, WebKit 62.2 -> 28.6). It also showed that the harness's "fresh tessellation" numbers have an
order artefact in Chrome (whichever module runs second is about 35 % faster), so ignore the fresh-tessellation column of
kernel.json; this experiment does not change that path.
At 5k the edit build went from 3.0-3.3 to 1.3-2.2 ms (Chrome) and 5.4-6.6 to 1.7-2.1 ms (WebKit).
After the change, all-reuse is cheaper than a fresh tessellation in both engines (Chrome clean 50k: 24 vs 29 ms).

## In the app (quick benchmark worker diagnostics, `branchMeshMs`, parent -> this)
| | Chrome | WebKit |
|---|---|---|
| edit@50k (3 edits) | 47/38/35 -> 32/26/24 | 66/66/58 -> 34/39/28 |
| fold@50k (fold, unfold x2) | 40/40/45/53 -> 28/30/42/39 | 93/99/123/125 -> 39/37/35/31 |
| edit@5k | 13/6/4 -> 6/3/4 | 12/11/10 -> 7/4/5 |
A probe on the dev server (50k, 8 successive edits, Chrome) showed 1 branch rebuilt per edit and 25-40 ms of mesh time
after warm-up; a fold rebuilt 4,755 branches of 49,700 and unfold 5,057.

## Screening (measure.py --quick, chrome + webkit, 1 round; raw quick.json)
```
=== chrome  (quick, 1 rounds, GPU timer: True)
metric                                               A         B    B/A  verdict
load_ms@5k                                      122.50    121.53  0.992  ~
load_ms@50k                                     999.68    999.51  1.000  ~
rebuild_ms@5k/rope                              161.17    170.38  1.057  ~
rebuild_ms@5k/clean                             120.98    134.60  1.113  ?slower
rebuild_ms@50k/rope                               1193      1181  0.989  ~
rebuild_ms@50k/clean                              1032      1140  1.105  ?slower
edit_ms@5k                                       93.20        89  0.955  ~
edit_ms@50k                                     772.45    757.98  0.981  ~
fold_ms@5k                                      173.19    176.24  1.018  ~
fold_ms@50k                                       1507      1473  0.977  ~
pan_cpu_mean@50k/rope                             1.75      1.91  1.089  ~
pan_cpu_mean@50k/clean                            1.45      1.51  1.042  ~
REBUILD                                         378.51    394.15  1.041  ~
INTERACTION                                     370.24    363.76  0.983  ~
FRAME                                             1.61      1.82  1.132  ?slower
DIMENSIONAL                                       9.04     10.13  1.121  ?slower
SCORE                                            60.84     63.89  1.050  ~
=== webkit  (quick, 1 rounds, GPU timer: False)
metric                                               A         B    B/A  verdict
load_ms@5k                                      121.08    120.58  0.996  ~
load_ms@50k                                     983.14      1128  1.147  ?slower
rebuild_ms@5k/rope                              159.04    160.04  1.006  ~
rebuild_ms@5k/clean                             153.66    150.10  0.977  ~
rebuild_ms@50k/rope                               1250      1408  1.127  ?slower
rebuild_ms@50k/clean                              1299      1267  0.976  ~
edit_ms@5k                                      102.16     82.96  0.812  ?faster
edit_ms@50k                                     870.24    905.32  1.040  ~
fold_ms@5k                                      171.93    152.80  0.889  ?faster
fold_ms@50k                                       1690      1583  0.937  ~
pan_cpu_mean@50k/rope                             1.33      1.35  1.014  ~
pan_cpu_mean@50k/clean                            1.47      1.37  0.929  ~
REBUILD                                         409.60    424.27  1.036  ~
INTERACTION                                     400.93    367.13  0.916  ~
FRAME                                             1.31      1.26  0.961  ~
DIMENSIONAL                                      19.45     19.68  1.012  ~
SCORE                                            59.94     58.11  0.969  ~
```
The settled metrics do not resolve the change: the mesh step is 3-12 % of a 50k edit (740-1,000 ms settled), so the
10-35 ms saved is inside one round's noise. Chrome edit/fold 50k 0.98/0.98, WebKit 1.04/0.94: all "~". The ?slower flags
(Chrome rebuild clean, WebKit load and rope 50k) are on paths that do no reuse at all (theme switch and load build
every branch fresh), so they are noise.

## Verdict
keep: output identical, the mesh step of edits and folds at 50k is about 1.4x (Chrome) and 2-3x (WebKit) cheaper in the
app's own diagnostics; the end-to-end edit and fold times move by less than the quick benchmark can see.
