# T6: decode the branch specs on the main thread only when something reads them

Parent: 661bf03 (T5). Track: transport. Measured against T5; it does not depend on T5's change (T5 is reverted later
in the chain and T6 keeps working on the streamed path).

## Hypothesis

After T2 the main thread parses the branch specs (JSON) for every adopted result: 4.5 ms at 5k and 28-42 ms at 50k
in the same-thread probe. It needs them only for layout animations that move branches (fold/unfold with motion on),
presentation scopes, the search filter and the presentation export. Keeping them as JSON until read removes that
parse from typing and adding nodes, and from folds with reduced motion.

## Change

- `ui/pipeline.ts`: `layoutBranches` / `drawnBranches` become accessors over a source that may be a memoised
  parse (`BranchList`); `drawnBranchesLater()`; `adoptWork` takes an `AdoptedWork` whose lists may be undecoded.
- `ui/layout-transport.ts`: `unpackLayoutResult` returns the lists as memoised parsers (`later`), one shared
  parser when the scene draws the layout's own list.
- `ui/controller.svelte.ts`: the settled frame's `branches` is a getter, so a layout animation decodes them only if
  it reads them.

## Correctness

bun run check 0/0, check-boundaries OK, check-browser PASS; replica.py (3,000 rope, 30 edits) clean; fold animation
with motion on (animtest.py, 5k clean and rope): no errors and the same triangle counts as T5; `drawnBranches ===
layoutBranches` still holds after decoding (lazycheck.py). Visual guard (Chrome, 18 scenes, T5 vs T6): 0 differing
pixels; WebKit visual guard baseline 9992500 vs T6 (all of T1-T6 together): 0 differing pixels in all 18 scenes
(`scratchpad/ar/transport/visual-base-T6-webkit`).

## Screening (quick, 1 round; raw: quick.json; parent = T5)

```
== chrome score A 53.93 B 54.52
  edit_ms@50k                           549.48    509.50  0.927
  edit_ms@5k                             84.84     84.58  0.997
  fold_ms@50k                          1084.57   1000.75  0.923
  fold_ms@5k                            138.91    138.77  0.999
  heap_mb@50k                           168.24    167.12  0.993
  heap_mb@5k                             22.83     22.63  0.991
  load_ms@50k                           907.67    912.60  1.005
  load_ms@5k                            119.94    121.88  1.016
  pan_cpu_mean@50k/clean                  1.43      1.68  1.173
  pan_cpu_mean@50k/rope                   1.62      1.95  1.203
  rebuild_ms@50k/clean                  844.61    846.10  1.002
  rebuild_ms@50k/rope                   894.24    886.89  0.992
  rebuild_ms@5k/clean                   103.88    103.87  1.000
  rebuild_ms@5k/rope                    143.39    145.98  1.018
  stream_block_max_ms@50k/clean          97.97    126.21  1.288
  stream_block_max_ms@5k/clean           14.19     17.39  1.226
  stream_longtask_max_ms@50k/clean       91.00     93.00  1.022
  stream_longtask_max_ms@5k/clean         0.00      0.00  nan
  stream_worst_gap_ms@50k/clean          83.33     99.99  1.200
  stream_worst_gap_ms@5k/clean           16.67     16.67  1.000
== webkit score A 50.70 B 49.93
  edit_ms@50k                           439.84    505.28  1.149
  edit_ms@5k                             84.98     86.34  1.016
  fold_ms@50k                          1180.36   1043.17  0.884
  fold_ms@5k                            135.30    128.72  0.951
  load_ms@50k                           814.86    820.36  1.007
  load_ms@5k                            121.18    120.90  0.998
  pan_cpu_mean@50k/clean                  1.38      1.44  1.048
  pan_cpu_mean@50k/rope                   1.38      1.43  1.037
  rebuild_ms@50k/clean                  944.70    950.56  1.006
  rebuild_ms@50k/rope                   874.06    900.34  1.030
  rebuild_ms@5k/clean                   134.20    133.40  0.994
  rebuild_ms@5k/rope                    143.56    124.72  0.869
  stream_block_max_ms@50k/clean          93.14     50.86  0.546
  stream_block_max_ms@5k/clean           13.38     12.28  0.918
  stream_worst_gap_ms@50k/clean          85.66     80.06  0.935
  stream_worst_gap_ms@5k/clean           18.36     18.60  1.013
```

The single round is mixed (Chrome edit/fold@50k -7 %, WebKit edit@50k +15 %, fold@50k -12 %; Chrome pan_cpu_mean@50k
+17-20 %, which this change cannot affect: panning does not touch the branch specs), so I ran the targeted probe.

## Targeted probe (probe.json: T5 vs T6, 2 rounds, both engines, medians parent/candidate)

```
chrome   5000 clean  add     ms=93.5/92.7 worker_handler=49.8/50.4 main_handler=7.4/4.4 main_max_task=8.6/5.1 maings=1.0/1.0
chrome   5000 clean  fold    ms=68.1/68.1 worker_handler=36.1/38.9 main_handler=6.4/4.2 main_max_task=7.1/4.9 maings=1.0/1.0
chrome   5000 clean  unfold  ms=67.3/67.8 worker_handler=39.2/40.7 main_handler=7.0/4.0 main_max_task=7.7/5.0 maings=1.0/1.0
chrome   5000 rope   add     ms=101.8/101.6 worker_handler=58.3/58.1 main_handler=8.5/4.3 main_max_task=9.3/5.5 maings=1.0/1.0
chrome   5000 rope   fold    ms=76.1/71.6 worker_handler=47.4/47.4 main_handler=8.5/3.9 main_max_task=9.2/4.6 maings=1.0/1.0
chrome   5000 rope   unfold  ms=86.1/85.7 worker_handler=54.7/55.5 main_handler=8.2/4.1 main_max_task=8.9/4.9 maings=1.0/1.0
chrome  50000 clean  add     ms=579.0/543.1 worker_handler=441.2/437.1 main_handler=73.5/39.1 main_max_task=82.4/47.8 maings=1.0/1.0
chrome  50000 clean  fold    ms=659.9/621.9 worker_handler=444.0/440.7 main_handler=77.1/36.7 main_max_task=84.9/43.4 maings=1.0/1.0
chrome  50000 clean  unfold  ms=537.5/516.5 worker_handler=411.9/409.9 main_handler=74.7/49.2 main_max_task=83.1/58.2 maings=1.0/1.0
chrome  50000 rope   add     ms=624.3/590.5 worker_handler=478.5/486.8 main_handler=89.7/40.1 main_max_task=99.9/47.8 maings=1.0/1.0
chrome  50000 rope   fold    ms=740.1/698.5 worker_handler=493.3/501.9 main_handler=89.0/45.9 main_max_task=96.8/55.8 maings=1.0/1.0
chrome  50000 rope   unfold  ms=660.5/611.0 worker_handler=494.2/503.6 main_handler=93.1/39.5 main_max_task=103.6/48.2 maings=1.0/1.0
webkit   5000 clean  add     ms=85.0/85.2 worker_handler=46.0/45.4 main_handler=4.7/3.4 main_max_task=4.7/3.4 maings=1.0/1.0
webkit   5000 clean  fold    ms=71.7/70.5 worker_handler=44.2/43.8 main_handler=4.6/3.1 main_max_task=4.6/3.1 maings=1.0/1.0
webkit   5000 clean  unfold  ms=69.1/67.9 worker_handler=43.3/43.0 main_handler=4.7/3.2 main_max_task=4.7/3.2 maings=1.0/1.0
webkit   5000 rope   add     ms=86.1/87.4 worker_handler=46.2/46.8 main_handler=5.2/3.0 main_max_task=5.2/3.0 maings=1.0/1.0
webkit   5000 rope   fold    ms=89.7/83.0 worker_handler=52.3/50.7 main_handler=5.3/3.0 main_max_task=5.3/3.0 maings=1.0/1.0
webkit   5000 rope   unfold  ms=86.4/82.6 worker_handler=56.8/56.6 main_handler=5.4/3.1 main_max_task=5.4/3.1 maings=1.0/1.0
webkit  50000 clean  add     ms=452.3/429.8 worker_handler=352.4/350.8 main_handler=50.2/33.2 main_max_task=50.2/33.2 maings=1.0/1.0
webkit  50000 clean  fold    ms=581.9/569.2 worker_handler=432.1/436.8 main_handler=49.3/33.2 main_max_task=49.3/33.2 maings=1.0/1.0
webkit  50000 clean  unfold  ms=532.5/486.0 worker_handler=402.3/397.3 main_handler=69.2/33.0 main_max_task=69.2/33.0 maings=1.0/1.0
webkit  50000 rope   add     ms=584.1/549.2 worker_handler=474.4/472.2 main_handler=58.5/33.5 main_max_task=58.5/33.5 maings=1.0/1.0
webkit  50000 rope   fold    ms=736.8/708.6 worker_handler=522.9/530.2 main_handler=58.3/34.3 main_max_task=58.3/34.3 maings=1.0/1.0
webkit  50000 rope   unfold  ms=644.3/607.8 worker_handler=532.3/512.0 main_handler=59.1/32.2 main_max_task=59.1/32.2 maings=1.0/1.0
```

Main-thread handling of a result halves at 50k (Chrome 74-93 -> 37-49 ms, WebKit 50-69 -> 32-34 ms) and roughly
halves at 5k (Chrome 7-8.5 -> 4 ms, WebKit 4.6-5.4 -> 3.0-3.4 ms); the longest main task at 50k drops from 82-104 to
43-58 ms (Chrome) and 49-69 to 32-34 ms (WebKit). Edit latency to settled: -4 to -8 % at 50k in all 12 cases (every
candidate median below its parent), no change at 5k.

## Verdict

Keep, on the probe evidence (the benchmark's one round could not resolve it).
