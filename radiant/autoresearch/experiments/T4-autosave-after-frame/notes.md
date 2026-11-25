# T4: write autosave and journal copies after the next frame

Parent: f21b243 (T3). Track: transport.

## Hypothesis

Two save paths serialise the whole document on the main thread on the edit path:
- Browser host (the benchmark's): `queueAutosave` -> `persistRecovery` waits for the layout, then, in a microtask
  right after the flush that adopted it (before the frame that shows the edit is drawn), runs `serializeDoc` with the
  placements, hashes the string (`revisionKey`, FNV) and writes. Study 01: about 70 ms per edit at 50k in Chrome.
- Desktop host (Tauri, `docCommit`): the editor's commit barrier calls `journalChange` in a microtask right after
  the edit; it runs `serializeDoc` before the next animation frame, i.e. before the layout request is even posted.
Waiting for the next frame first takes this off the path between the edit and the frame that shows it (browser host)
and lets the layout request go out first so the worker computes while the main thread serialises (desktop host).

## Change

`ui/controller.svelte.ts`: `afterNextFrame()` (rAF then a 0 ms timeout, with a 100 ms fallback for a window that
draws no frames while hidden). `persistRecovery` awaits it after the layout has settled and re-checks that the
document and revision are unchanged (a newer edit queues its own autosave, as before). `journalChange` awaits it
before serialising: the editor holds later edits until the commit is written (`waitingForCommit`), so the document
cannot change in between and every edit is still journalled, in order; each commit starts up to one frame later.

## Correctness

bun run check 0/0, check-boundaries OK, check-browser PASS (includes save/reopen). `autosave.py` (dev server,
3,000 nodes, 3 edits): browser host autosaved after each edit (3 docAutosave calls, "Autosaved"); emulated journal
path (docCommit stub + commit barrier) committed each edit (3 commits, dirty false). Visual guard (Chrome, 18 scenes):
0 differing pixels.

## Screening (quick, 1 round; raw: quick.json; parent = T3) - browser host path

```
== chrome score A 55.48 B 53.09
  edit_ms@50k                           603.58    528.93  0.876
  edit_ms@5k                             84.63     85.33  1.008
  fold_ms@50k                          1201.44   1036.20  0.862
  fold_ms@5k                            152.80    139.72  0.914
  heap_mb@50k                           167.51    167.51  1.000
  heap_mb@5k                             22.83     22.83  1.000
  load_ms@50k                           911.59    899.14  0.986
  load_ms@5k                            120.54    120.50  1.000
  pan_cpu_mean@50k/clean                  1.34      1.33  0.990
  pan_cpu_mean@50k/rope                   1.66      1.64  0.985
  rebuild_ms@50k/clean                  850.25    844.83  0.994
  rebuild_ms@50k/rope                   976.56    888.85  0.910
  rebuild_ms@5k/clean                   120.10    116.75  0.972
  rebuild_ms@5k/rope                    144.42    146.25  1.013
  stream_block_max_ms@50k/clean         162.31    105.76  0.652
  stream_block_max_ms@5k/clean           21.62     14.62  0.676
  stream_longtask_max_ms@50k/clean       86.00     81.00  0.942
  stream_longtask_max_ms@5k/clean         0.00      0.00  nan
== webkit score A 54.94 B 52.26
  edit_ms@50k                           534.52    525.24  0.983
  edit_ms@5k                            107.44    118.08  1.099
  fold_ms@50k                          2028.48   1104.22  0.544
  fold_ms@5k                            139.18    137.58  0.989
  load_ms@50k                           828.06    852.54  1.030
  load_ms@5k                            122.28    121.84  0.996
  pan_cpu_mean@50k/clean                  1.39      1.42  1.020
  pan_cpu_mean@50k/rope                   1.49      1.47  0.986
  rebuild_ms@50k/clean                  977.98   1001.18  1.024
  rebuild_ms@50k/rope                   969.88    927.86  0.957
  rebuild_ms@5k/clean                   134.88    135.18  1.002
  rebuild_ms@5k/rope                    143.08    125.36  0.876
  stream_block_max_ms@50k/clean          60.66     50.52  0.833
  stream_block_max_ms@5k/clean           14.30     12.80  0.895
```

## Journal path (not exercised by the benchmark): own probe, probe-journal.json

probe.py --journal installs a `docCommit` stub that resolves immediately and the editor's commit barrier
(`journalChange`) in a production bench build; 50k and 5k clean, 4 adds, 2 rounds, interleaved, both engines.
Medians parent/candidate, add-child to settled: 50k Chrome 629/583 ms (-7 %), WebKit 531/475 ms (-11 %);
5k Chrome 93.1/92.9, WebKit 84.3/85.4 (no change). The real Tauri IPC write is not modelled (the stub costs nothing).

## Verdict

Keep. Chrome score 0.957 (edit@50k -12 %, fold@50k -14 %, stream_block_max -35 %), WebKit 0.951 (edit@50k -2 %;
fold@50k 2028 -> 1104 is mostly an outlier in the parent's single round). One round: treat single metrics as unproven.
