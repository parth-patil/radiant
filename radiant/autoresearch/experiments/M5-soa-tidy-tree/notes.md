# M5: struct-of-arrays tidy-tree layout kernel

## Hypothesis
`tidyTree` (src/lib/core/layout/tidy.ts) builds one `TidyNode` object per node with object references for contours and
threads, plus a linked list of low siblings per sibling group. Study 03 measured a typed-array rewrite at 6.3 -> 3.1 ms
(V8) and 6.8 -> 2.6 ms (JSC) warm at 50k, and a first call of 75 -> 10 ms in V8. The kernel is only 12-20 % of
settleLayout, so the warm gain is small; the cold first call should show in load_ms@50k in Chrome. This is also the
"plain TypeScript with a better data layout" comparison point for the WebAssembly question.

## What changed
`src/lib/core/layout/tidy.ts`, same exported signature (`tidyTree(childStart, childCount, boxMain, boxCross, levelGap,
spacing, rootGroups)`), same arithmetic in the same order: every per-node field is a Float64Array or Int32Array indexed by
the breadth-first index, contour threads are indices (-1 = none), the low-siblings stack is two typed arrays, sibling
lists are slices of an identity order (children are contiguous) or the root group's own Int32Array, and the iterative
traversals use one typed-array stack. Unlike the study's prototype it keeps the generic `spacing` and `rootGroups`
callbacks, so layout.ts is untouched.

## Order note
M5 was screened as cf2d519 on top of M3 (parent 5741e7e) because M3's screening was still queued behind the benchmark lock.
On the branch it now sits after M3's revert and M4's notes, so its parent has M2's mesh code; tidy.ts is independent of
the mesh code, so the comparison holds, but the official A/B against the final parent is the one to trust.

## Correctness
- Scratch check (`check.mjs` here; bundles layoutDoc from the parent pin and from this tree): the captured 5k and 50k
  docs, each in layouts mindmap, left, right, down, up and compact, balance extent and alternate, with and without a
  `spacing` callback, with every third main branch pinned to a side: 48 cases, every box's x, y and side bit-identical,
  in bun (JavaScriptCore) and node (V8). Not covered: per-node `branchLayout` overrides, `fixedSides`.
- bun run check 0/0, check-boundaries pass, check-browser all PASS.
- Visual guard (Chrome, parent M3 vs this): 18/18 scenes 0 differing pixels, max difference 0.

## Kernel numbers (scratch `scratchpad/ar/mesh/m5`; fresh page per sample, 4 rounds alternating order; median [min-max];
raw kernel.json). `cold` = first layoutDoc call in the page; `layoutDoc` warm median of 15; `settle` = settleLayout warm.
| engine | size | cold old -> new | layoutDoc warm old -> new | settleLayout warm old -> new |
|---|---|---|---|---|
| chrome | 5k | 9.1 [9.0-9.5] -> 6.6 [6.2-6.8] | 1.37 -> 1.03 | 3.84 -> 2.84 |
| chrome | 50k | 70.8 [66.7-76.2] -> 34.4 [31.0-45.1] | 18.5 [17.3-19.2] -> 14.3 [13.4-15.0] | 44.6 -> 43.0 |
| webkit | 5k | 5.1 [5.0-6.1] -> 4.8 [4.8-5.3] | 1.55 -> 1.44 | 3.41 -> 3.23 |
| webkit | 50k | 32.9 [31.0-34.1] -> 27.9 [26.6-28.7] | 19.3 [18.2-21.6] -> 15.2 [14.6-16.6] | 38.6 -> 37.0 |

## In the app (quick benchmark worker diagnostics, `geometryMs` = settleLayout, parent -> this, one sample each)
Chrome load@50k (the first, cold layout of the page): 148 -> 84 ms. Every other entry is within its own spread
(Chrome rebuild 50k 137-152 vs 140-142; WebKit load 84 -> 81). WebKit edit@50k came out 67-71 -> 74-84 in this one round,
against the kernel's warm 19.3 -> 15.2 ms for the whole layoutDoc; I read that as noise but did not re-run it.

## Screening (measure.py --quick, chrome + webkit, 1 round; raw quick.json)
```
=== chrome  (quick, 1 rounds, GPU timer: True)
metric                                               A         B    B/A  verdict
load_ms@5k                                      126.06    120.64  0.957  ~
load_ms@50k                                       1000    949.37  0.949  ~
rebuild_ms@5k/rope                              158.06    167.38  1.059  ~
rebuild_ms@5k/clean                             119.05    120.35  1.011  ~
rebuild_ms@50k/rope                               1156      1162  1.006  ~
rebuild_ms@50k/clean                              1062      1047  0.986  ~
edit_ms@5k                                       91.05     90.59  0.995  ~
edit_ms@50k                                     730.88    713.33  0.976  ~
fold_ms@5k                                      172.67    167.28  0.969  ~
fold_ms@50k                                       1445      1427  0.988  ~
pan_cpu_mean@50k/rope                             1.58      1.52  0.966  ~
pan_cpu_mean@50k/clean                            1.45      1.42  0.977  ~
REBUILD                                         377.90    375.58  0.994  ~
INTERACTION                                     358.94    352.40  0.982  ~
FRAME                                             1.65      1.67  1.014  ~
DIMENSIONAL                                       9.28      9.57  1.031  ~
SCORE                                            60.72     60.51  0.997  ~
=== webkit  (quick, 1 rounds, GPU timer: False)
metric                                               A         B    B/A  verdict
load_ms@5k                                      136.44    120.50  0.883  ?faster
load_ms@50k                                     951.78    989.68  1.040  ~
rebuild_ms@5k/rope                              161.30    141.80  0.879  ?faster
rebuild_ms@5k/clean                             152.64    152.98  1.002  ~
rebuild_ms@50k/rope                               1246      1255  1.007  ~
rebuild_ms@50k/clean                              1270      1304  1.027  ~
edit_ms@5k                                       85.34    100.90  1.182  ?slower
edit_ms@50k                                     750.72    808.24  1.077  ~
fold_ms@5k                                      153.40    156.38  1.019  ~
fold_ms@50k                                       1550      1547  0.998  ~
pan_cpu_mean@50k/rope                             1.43      1.46  1.019  ~
pan_cpu_mean@50k/clean                            1.35      1.47  1.084  ~
REBUILD                                         414.37    402.23  0.971  ~
INTERACTION                                     351.30    374.78  1.067  ~
FRAME                                             1.38      1.39  1.005  ~
DIMENSIONAL                                      20.14     19.73  0.980  ~
SCORE                                            58.62     59.40  1.013  ~
```
Chrome load_ms@50k 0.949 matches the cold-layout saving above (about 60 ms of 1,000) but is inside the 10 % band. No
metric moved beyond noise in either direction except WebKit edit_ms@5k 1.18 ?slower and load_ms@5k / rebuild rope 5k
0.88 ?faster, which point in opposite directions on the same code path at the same size: noise.

## Verdict
keep: bit-identical, warm layoutDoc about 1.25x faster in both engines, and the first layout of a big map in Chrome about
60 ms cheaper. The end-to-end effect is small; settleLayout's other 80-90 % (Maps, NodeBox objects, placements) is where
the layout time is.
