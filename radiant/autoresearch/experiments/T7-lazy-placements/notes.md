# T7: decode adopted placements on the main thread only when something reads them

Parent: a677ae6 (T6). Track: transport. Added by me (not in the brief's list): after T6 the probe showed the single
result task on the main thread at 50k is ~35-55 ms, of which JSON.parse of the placements is 12-18 ms.

## Hypothesis

The main thread reads the adopted placements only to save them (autosave, which T4 already moved after the frame),
for fold animations, layout tools (tidy, arrange, balance) and to detect a fold in `onChange`. Keeping them as JSON
until read takes the parse out of the task that adopts a layout, and in the desktop journal path (which saves the
document without placements) out of typing altogether. Expected: shorter longest main-thread task per edit at 50k,
small or no change in edit latency in the benchmark (its browser host autosaves with placements after each edit).

## Change

- `ui/pipeline.ts`: `placements` becomes an accessor over a source that may be a memoised parse; `placementsResult`
  remembers the worker result the placements came from while unchanged (any assignment clears it) and replaces T3's
  identity check (`kept`) for `{ result }` requests; `placementsLater()`.
- `ui/layout-transport.ts`: placements unpacked lazily.
- `ui/controller.svelte.ts`: settled frames and `artworkPlacements` hold a reader instead of the object; the fold
  detection in `onChange` reads the placements only when the edit has a `set` op that changes `collapsed` (before,
  any non-cosmetic edit compared every touched node with its placement; an edit that does not set `collapsed` but
  touches a node folded by an earlier, not yet laid out edit no longer counts as a fold: only the animation anchor
  can differ).

## Correctness

bun run check 0/0, check-boundaries OK, check-browser PASS; replica.py (3,000 and 13,000 rope, 40 edits) clean;
autosave.py: both the browser autosave and an emulated journal path still save after every edit; fold animation with
motion on (animtest.py) unchanged; visual guard (Chrome, 18 scenes): 0 differing pixels.

## Screening (quick, 1 round; raw: quick.json; parent = T6)

```
== chrome score A 52.16 B 51.95
  edit_ms@50k                           488.84    485.00  0.992
  edit_ms@5k                             84.85     86.28  1.017
  fold_ms@50k                           990.87    960.83  0.970
  fold_ms@5k                            137.21    137.05  0.999
  heap_mb@50k                           167.12    167.65  1.003
  heap_mb@5k                             22.63     22.73  1.005
  load_ms@50k                           879.23    859.06  0.977
  load_ms@5k                            120.64    120.27  0.997
  pan_cpu_mean@50k/clean                  1.41      1.53  1.080
  pan_cpu_mean@50k/rope                   1.67      1.78  1.070
  rebuild_ms@50k/clean                  816.09    784.57  0.961
  rebuild_ms@50k/rope                   843.29    829.37  0.983
  rebuild_ms@5k/clean                   117.10    117.62  1.004
  rebuild_ms@5k/rope                    145.51    146.52  1.007
  stream_block_max_ms@50k/clean         100.40    123.68  1.232
  stream_block_max_ms@5k/clean           14.33     16.37  1.142
  stream_longtask_max_ms@50k/clean       76.00     99.00  1.303
  stream_longtask_max_ms@5k/clean         0.00      0.00  nan
== webkit score A 49.65 B 49.81
  edit_ms@50k                           429.14    437.10  1.019
  edit_ms@5k                            101.46     85.20  0.840
  fold_ms@50k                          1075.93   1063.92  0.989
  fold_ms@5k                            137.69    136.25  0.990
  load_ms@50k                           793.40    800.48  1.009
  load_ms@5k                            120.44    120.64  1.002
  pan_cpu_mean@50k/clean                  1.32      1.36  1.024
  pan_cpu_mean@50k/rope                   1.39      1.50  1.078
  rebuild_ms@50k/clean                  937.54    947.38  1.010
  rebuild_ms@50k/rope                   848.90    841.92  0.992
  rebuild_ms@5k/clean                   134.16    136.12  1.015
  rebuild_ms@5k/rope                    142.96    142.90  1.000
  stream_block_max_ms@50k/clean          57.68     67.64  1.173
  stream_block_max_ms@5k/clean           13.10     15.56  1.188
```

Probe (probe.json, 50k clean, 2 rounds, medians, parent/candidate): main-thread handling of the result
39/23 ms (add), 46/23 (fold), 53/30 (load) in Chrome; 34/25, 37/25, 35/26 in WebKit. Longest main task in that window
46/32, 55/31, 63/40 (Chrome); 34/25, 37/25, 35/26 (WebKit). Edit latency unchanged (543/518, 434/450 ms).

## Verdict

Discard (reverted). The benchmark shows no latency gain (scores 0.996 / 1.003) because its browser host decodes the
placements for the autosave anyway, just after the frame; Chrome's stream_longtask_max@50k went 76 -> 99 ms in this
one round (the autosave task now includes the parse), the opposite of the goal. The adopt task does shrink by 10-15 ms
at 50k (probe), and the desktop journal path, which the benchmark does not exercise, would never parse the placements
while typing: worth re-trying together with a change that makes the autosave cheaper (e.g. serialising in the worker).
