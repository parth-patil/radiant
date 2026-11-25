# T5: send the layout result in one message instead of pulled chunks

Parent: 687e539 (T4). Track: transport. Commit 661bf03, reverted on top of the chain (T6 and T7 were committed
before this verdict was in; T6 does not depend on T5, see below).

## Hypothesis

At 12,000+ nodes the worker splits the result into ~1,400-entry chunks that the main thread pulls one message (and
one task) at a time: ~218 messages per 50k edit at the baseline, 110 after T2. After T1 and T2 the result is mostly
transferred typed arrays and JSON text, so one message should be cheap to clone and the round trips are pure latency.
Expected: lower 50k edit/fold/rebuild latency; the main-thread unpack is already one task since T2.

## Change

`ui/layout.worker.ts` always posts `{ sequence, result }`; the pull/part result protocol is removed from the worker
and `ui/controller.svelte.ts` (the streamed whole-document request path is kept).

## Correctness

bun run check 0/0, check-boundaries OK, check-browser PASS, replica.py at 13,000 nodes clean; visual guard (Chrome,
18 scenes): 0 differing pixels.

## Screening (quick, 1 round; raw: quick.json; parent = T4)

```
== chrome score A 54.13 B 56.32
  edit_ms@50k                           518.85    526.62  1.015
  edit_ms@5k                             84.65     84.75  1.001
  fold_ms@50k                          1066.97   1132.85  1.062
  fold_ms@5k                            139.17    139.25  1.001
  heap_mb@50k                           167.51    168.24  1.004
  heap_mb@5k                             22.83     22.83  1.000
  load_ms@50k                           918.29    932.65  1.016
  load_ms@5k                            119.50    121.05  1.013
  pan_cpu_mean@50k/clean                  1.44      1.47  1.022
  pan_cpu_mean@50k/rope                   1.69      1.73  1.022
  rebuild_ms@50k/clean                  857.98    904.51  1.054
  rebuild_ms@50k/rope                   928.72    962.50  1.036
  rebuild_ms@5k/clean                   103.56    103.55  1.000
  rebuild_ms@5k/rope                    144.50    145.56  1.007
  stream_block_max_ms@50k/clean         103.43     98.12  0.949
  stream_block_max_ms@5k/clean           14.72     15.10  1.026
  stream_longtask_max_ms@50k/clean       77.00     87.00  1.130
  stream_longtask_max_ms@5k/clean         0.00      0.00  nan
  stream_worst_gap_ms@50k/clean          83.33     66.66  0.800
  stream_worst_gap_ms@5k/clean           16.67     16.67  1.000
== webkit score A 51.69 B 50.49
  edit_ms@50k                           502.94    460.26  0.915
  edit_ms@5k                             85.24     86.86  1.019
  fold_ms@50k                          1160.36   1154.72  0.995
  fold_ms@5k                            138.17    137.89  0.998
  load_ms@50k                           838.38    834.86  0.996
  load_ms@5k                            121.72    121.82  1.001
  pan_cpu_mean@50k/clean                  1.36      1.41  1.040
  pan_cpu_mean@50k/rope                   1.44      1.42  0.985
  rebuild_ms@50k/clean                  951.24    970.56  1.020
  rebuild_ms@50k/rope                   924.46    906.08  0.980
  rebuild_ms@5k/clean                   136.12    138.20  1.015
  rebuild_ms@5k/rope                    143.68    124.72  0.868
  stream_block_max_ms@50k/clean          68.06     66.16  0.972
  stream_block_max_ms@5k/clean           13.60     11.60  0.853
  stream_worst_gap_ms@50k/clean          77.60     73.24  0.944
  stream_worst_gap_ms@5k/clean           18.46     19.42  1.052
```

Probe (probe.json; 50k, 2 rounds, medians parent/candidate; main_msgs 110 -> 1):

```
chrome  50000 clean  add     ms=575.3/584.2 worker_post=8.0/9.1 main_handler=76.1/75.4 main_max_task=74.6/84.1 maings=110.0/1.0
chrome  50000 clean  fold    ms=666.7/663.8 worker_post=8.3/9.6 main_handler=74.5/76.6 main_max_task=73.8/84.3 maings=110.0/1.0
chrome  50000 clean  unfold  ms=559.9/535.0 worker_post=8.6/11.1 main_handler=78.3/75.2 main_max_task=75.3/83.6 maings=110.0/1.0
chrome  50000 rope   add     ms=629.3/630.7 worker_post=9.4/11.3 main_handler=91.3/89.5 main_max_task=89.5/100.7 maings=110.0/1.0
chrome  50000 rope   fold    ms=715.9/730.0 worker_post=8.0/10.6 main_handler=86.1/90.2 main_max_task=85.4/99.1 maings=110.0/1.0
chrome  50000 rope   unfold  ms=688.7/667.5 worker_post=8.7/10.3 main_handler=88.7/90.8 main_max_task=86.7/99.8 maings=110.0/1.0
webkit  50000 clean  add     ms=467.0/445.0 worker_post=15.9/10.9 main_handler=51.9/51.0 main_max_task=50.5/51.0 maings=110.0/1.0
webkit  50000 clean  fold    ms=598.3/587.6 worker_post=14.6/8.6 main_handler=50.5/49.8 main_max_task=49.3/49.8 maings=110.0/1.0
webkit  50000 clean  unfold  ms=531.0/505.0 worker_post=29.5/9.3 main_handler=57.3/48.8 main_max_task=55.7/48.8 maings=110.0/1.0
webkit  50000 rope   add     ms=597.4/577.1 worker_post=16.6/12.5 main_handler=58.2/58.3 main_max_task=56.1/58.3 maings=110.0/1.0
webkit  50000 rope   fold    ms=747.9/719.6 worker_post=18.5/13.8 main_handler=59.4/59.5 main_max_task=57.8/59.5 maings=110.0/1.0
webkit  50000 rope   unfold  ms=641.4/617.3 worker_post=16.6/12.3 main_handler=58.7/55.2 main_max_task=57.4/55.2 maings=110.0/1.0
```

## Verdict

Discard (reverted in the next commit). Latency moved within noise in both directions (Chrome add 575/584, fold
667/664; WebKit add 467/445, fold 598/588), the benchmark scores went 1.040 (Chrome, worse) and 0.977 (WebKit), and
the longest main-thread task got ~10 ms longer in Chrome at 50k (75 -> 84 ms): without the chunk turns the clone of
the 50k id arrays lands in the same task as the unpack. The 110 remaining round trips cost less than expected (each
chunk is tiny after T2). Worth revisiting only together with a smaller id payload (boxes ids and spatial ids are the
same 50k strings, sent twice).

The revert keeps T6 (lazy branch specs) working on the streamed path: `unpackLayoutResult` runs on the assembled
snapshot as before; replica.py at 13,000 nodes and check-browser pass after the revert.
