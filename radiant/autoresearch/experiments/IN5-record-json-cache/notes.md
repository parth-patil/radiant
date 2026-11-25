# IN5: stringify each layout record once (per-record JSON cache in the worker's result packing)

Track: incremental (round 2). Parent: 9d636f3 (IN4). This is the "whatever the profile shows next" slot.

## Hypothesis

After IN1-IN4 the worker's relayout + scene for a one-node edit at 50,000 nodes is ~110-150 ms (stage harness), but
`packLayoutResult` (ui/layout-transport.ts, round 1's T2 codec) then `JSON.stringify`s every placement record, branch
spec, label and rect of the map: 94-112 ms per edit at 50k in the stage harness, as much as all of the compute. IN2-IN4
now hand over the same record objects for everything an edit did not change, and nothing changes a record once built,
so each record's JSON text can be kept by object (WeakMap) and the list texts assembled from the parts. The wire text is
byte-identical. Expected: packing at 50k ~100 -> ~25 ms per edit; worker handling of an edit -60 to -80 ms.

## Change

- `ui/layout-transport.ts`: `recordJson` (WeakMap object -> { json, count of nulls beyond the allowed ones });
  `listWire` for specs, labels, rects ('[' + parts.join(',') + ']', falling back to `toWire` for a non-object item);
  `placementsWire` for { roots, nodes } (roots stringified each time, node records by `for...in` in the same key order
  JSON.stringify uses; any other shape falls back to `toWire`). Same rule as `toWire` for unexpected nulls (NaN,
  Infinity): such a list goes as a cloned value.

## Correctness

The harness `check` now also packs the incremental and the fresh result and requires identical wire text for
placements, specs, drawn specs, labels and rects after every random edit (with prepared and unprepared scenes, edited
labels, curved-label theme hand-drawn): 5,000 x clean, rope, hand-drawn, paper-quilling x 60 and 20,000 x clean, rope
x 50: identical. `e2e.py` through the worker (5k, 20k x clean, hand-drawn): identical after forced resync. `bun run
check` 0/0, boundaries OK. Relies on the invariant that no record is changed in place after packing (true today in the
worker: specs are copy-on-write since IN3, labels are only mutated before packing and in passes where the scene memo
is off); a future in-place mutation would send stale text. Pictures are not covered by any check.

## Memory (the cost)

The cache keeps one JSON string per live record: measured in a page (Chrome heap after GC, `mem.py`), +8 MB at 5,000
nodes, +36 MB at 20,000, +89 MB (clean) / +94 MB (rope) at 50,000. In the app this is worker heap, which the benchmark's
heap_mb (main thread) does not see.

## Visual guard

Chrome, 18 scenes, IN4 vs IN5: 0 differing pixels in every scene.

## Screening

Quick benchmark, 1 round, parent = IN4 (raw: `quick.json`). Very noisy this round (other agents' runs):

```
=== chrome  (quick, 1 rounds, GPU timer: True)
load_ms@5k                                      104.23    121.19  1.163  ?slower
load_ms@50k                                     827.88    951.61  1.149  ?slower
rebuild_ms@5k/rope                              146.19    146.99  1.005  ~
rebuild_ms@5k/clean                             118.60    117.58  0.991  ~
rebuild_ms@50k/rope                             889.79      1159  1.302  ?slower
rebuild_ms@50k/clean                            897.03      1309  1.459  ?slower
edit_ms@5k                                       68.79     68.31  0.993  ~
edit_ms@50k                                     488.22    344.07  0.705  ?faster
fold_ms@5k                                      113.03    104.26  0.922  ~
fold_ms@50k                                       1101    825.24  0.750  ?faster
pan_cpu_mean@50k/rope                             0.57      0.51  0.892  ?faster
pan_cpu_mean@50k/clean                            0.63      0.49  0.773  ?faster
REBUILD                                         325.72    380.26  1.167  ?slower
INTERACTION                                     254.25    212.06  0.834  ?faster
FRAME                                             0.73      0.71  0.978  ~
SCORE                                            39.17     38.54  0.984  ~
=== webkit  (quick, 1 rounds, GPU timer: False)
load_ms@5k                                      121.30    122.44  1.009  ~
load_ms@50k                                     899.30    824.22  0.917  ~
rebuild_ms@5k/rope                              143.92    160.80  1.117  ?slower
rebuild_ms@5k/clean                             170.12    119.54  0.703  ?faster
rebuild_ms@50k/rope                               1223    957.32  0.783  ?faster
rebuild_ms@50k/clean                              1513      1248  0.825  ?faster
edit_ms@5k                                       85.46     68.90  0.806  ?faster
edit_ms@50k                                     355.46    686.84  1.932  ?slower
fold_ms@5k                                      113.99     91.95  0.807  ?faster
fold_ms@50k                                     750.81    588.07  0.783  ?faster
pan_cpu_mean@50k/rope                             1.05      1.08  1.031  ~
pan_cpu_mean@50k/clean                            0.91      0.94  1.040  ~
REBUILD                                         412.72    363.80  0.881  ?faster
INTERACTION                                     225.81    224.91  0.996  ~
FRAME                                             1.00      1.01  1.002  ~
SCORE                                            45.41     43.51  0.958  ~```


Targeted probe (`probe.json`, production builds, interleaved, 2 rounds, medians in ms):

| op | engine, size, theme | settled A -> B | worker handler A -> B |
|---|---|---|---|
| add | chrome 20k clean | 180 -> 147 | 130 -> 102 |
| fold | chrome 20k clean | 194 -> 166 | 110 -> 81 |
| unfold | chrome 20k clean | 151 -> 133 | 101 -> 81 |
| add | chrome 20k rope | 182 -> 163 | 117 -> 102 |
| fold | chrome 20k rope | 206 -> 171 | 127 -> 97 |
| unfold | chrome 20k rope | 177 -> 150 | 122 -> 95 |
| add | chrome 50k clean | 409 -> 378 | 298 -> 258 |
| fold | chrome 50k clean | 467 -> 438 | 266 -> 235 |
| unfold | chrome 50k clean | 360 -> 342 | 265 -> 234 |
| add | chrome 50k rope | 476 -> 369 | 323 -> 253 |
| fold | chrome 50k rope | 535 -> 563 | 356 -> 359 |
| unfold | chrome 50k rope | 506 -> 404 | 385 -> 270 |
| add | webkit 20k clean | 139 -> 120 | 91 -> 64 |
| fold | webkit 20k clean | 160 -> 141 | 92 -> 70 |
| unfold | webkit 20k clean | 131 -> 115 | 90 -> 61 |
| add | webkit 20k rope | 148 -> 131 | 104 -> 75 |
| fold | webkit 20k rope | 194 -> 172 | 122 -> 90 |
| unfold | webkit 20k rope | 166 -> 142 | 121 -> 94 |
| add | webkit 50k clean | 318 -> 246 | 233 -> 161 |
| fold | webkit 50k clean | 384 -> 335 | 241 -> 186 |
| unfold | webkit 50k clean | 323 -> 272 | 242 -> 183 |
| add | webkit 50k rope | 383 -> 324 | 281 -> 206 |
| fold | webkit 50k rope | 497 -> 424 | 324 -> 265 |
| unfold | webkit 50k rope | 407 -> 356 | 316 -> 239 |

Whole-document passes in the same probe (50k; settled ms and worker handler ms, A -> B):
Chrome load clean 810 -> 890 (handler 588 -> 659), load rope 836 -> 862, retheme rope 739 -> 819, theme rope 937 -> 960;
WebKit load clean 839 -> 837, load rope 856 -> 816, retheme clean 910 -> 949, retheme rope 721 -> 761. The worker's
post time rises by ~8 ms in Chrome (joined strings).

Stage harness (Chrome, 50k): packLayoutResult per edit 94-112 ms -> 24-31 ms.

## What surprised me

- WebKit gains the most on edits (50k add 318 -> 246 ms settled, worker handler 233 -> 161 ms; 20k -13 to -14 %).
- Whole-document passes get slower in Chrome (+3 to +11 % in the probe, +30 to +46 % for rebuild@50k in the single quick
  round): on a load or theme switch every record is new, so the cache only adds work (150,000 WeakMap insertions and
  string joins) and the WeakMap's ephemeron entries add GC work in V8.
- The quick run's WebKit edit_ms@50k 355 -> 687 contradicts the probe (8 measurements, all faster); treated as noise.

## Verdict

Discarded (committed for the record, then reverted). Edits and folds are clearly faster (probe: -7 to -23 % settled at
50k, worker handling -10 to -31 %), but the price is ~90 MB of retained strings in the worker at 50,000 nodes and slower
loads and theme switches in Chrome. Worth retrying in a form that does not pay on full passes or hold the text: skip the
cache on whole-document passes, or better, send only the changed records (a delta wire, so the main thread also stops
re-parsing 40 MB of JSON per edit at 50k; its handler is ~35-50 ms per edit).
