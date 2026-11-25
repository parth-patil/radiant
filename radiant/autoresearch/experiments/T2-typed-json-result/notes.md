# T2: send the layout result as typed boxes and JSON record lists

Parent: d7e2342 (T1). Track: transport.

## Hypothesis

After T1 the result message is still mostly object graphs: 5k/50k node boxes (Map), placement records, branch specs,
label draws. A same-thread probe (`scratchpad/ar/transport/micro.py`, adopted result of the real app, rope) measured
structured clone (serialise + deserialise) against alternatives:

| part, 50k rope | Chrome clone | Chrome JSON (stringify + clone + parse) | WebKit clone | WebKit JSON |
|---|---:|---:|---:|---:|
| branch specs | 99.7 | 23.7 + 4.2 + 42.0 | 162.4 | 19.0 + 2.2 + 27.7 |
| labels | 50.0 | 12.4 + 2.7 + 17.6 | 84.0 | 10.1 + 1.2 + 22.1 |
| placements | 52.3 | 25.3 + 1.6 + 17.6 | 54.5 | 5.2 + 0.3 + 12.3 |
| boxes (Map) | 31.2 | typed columns: 1.0 + 3.5 + 2.2 | 39.1 | 1.0 + 7.0 + 1.9 |

A generic columnar codec in JS (`codec-proto.js`) was no better than structured clone for specs and labels (encode
50-70 ms at 50k), so it was dropped. JSON is several times cheaper, most of all in JavaScriptCore.
Expected: less worker serialise and main deserialise time, lower 50k edit/fold/load latency, mainly in WebKit.

## Change

- `ui/layout-transport.ts`: `packLayoutResult` / `unpackLayoutResult`. Boxes go as typed columns (id list,
  x/y/w/h f64, depth, mainBranch, side, flow) and are rebuilt into the same Map (same key order as core/layout).
  Branch specs, labels, rects and placements go as JSON text (`toWire`/`fromWire`). JSON cannot carry NaN or
  Infinity (they become null) and drops undefined-valued keys (readers see the same thing): a list whose JSON has a
  null in a value position beyond those its type holds by design (`"parent":null` of root placements) is sent as
  itself, cloned as before. `drawnBranches` that is the same array as `layoutBranches` is sent once.
- `ui/layout.worker.ts` packs; `ui/controller.svelte.ts` unpacks when the reply (or the assembled stream) arrives.

## Correctness

Round trip on real results (`fidelity.py`, dev server, 3,000 and 13,000 nodes in all five themes): boxes, placements
(also byte-identical JSON), specs, labels, rects deep-equal to a structured clone; every part took the JSON path.
bun run check 0/0, check-boundaries OK, check-browser PASS. Visual guard (Chrome, 18 scenes, parent T1 pin vs T2 pin):
0 differing pixels, max difference 0 (`scratchpad/ar/transport/visual-T2`).

## Screening (quick, 1 round; raw: quick.json; parent = T1)

```
== chrome score A 62.35 B 60.22
  edit_ms@50k                           788.81    713.96  0.905
  edit_ms@5k                            101.25    101.44  1.002
  fold_ms@50k                          1493.30   1430.77  0.958
  fold_ms@5k                            176.00    169.78  0.965
  heap_mb@50k                           173.47    167.50  0.966
  heap_mb@5k                             23.51     22.83  0.971
  load_ms@50k                          1035.32    937.79  0.906
  load_ms@5k                            120.90    120.98  1.001
  pan_cpu_mean@50k/clean                  1.54      1.43  0.924
  pan_cpu_mean@50k/rope                   1.81      1.62  0.897
  rebuild_ms@50k/clean                 1050.74   1026.66  0.977
  rebuild_ms@50k/rope                  1208.55   1156.59  0.957
  rebuild_ms@5k/clean                   111.34    120.79  1.085
  rebuild_ms@5k/rope                    150.19    164.58  1.096
  stream_block_max_ms@50k/clean         117.58    164.73  1.401
  stream_block_max_ms@5k/clean           28.28     21.64  0.765
  stream_longtask_max_ms@50k/clean       90.00     88.00  0.978
  stream_longtask_max_ms@5k/clean         0.00      0.00  nan
== webkit score A 59.56 B 56.44
  edit_ms@50k                           811.02    660.70  0.815
  edit_ms@5k                            102.22    119.20  1.166
  fold_ms@50k                          1761.41   1348.88  0.766
  fold_ms@5k                            169.13    159.09  0.941
  load_ms@50k                           985.72    852.70  0.865
  load_ms@5k                            120.92    120.74  0.999
  pan_cpu_mean@50k/clean                  1.43      1.47  1.025
  pan_cpu_mean@50k/rope                   1.37      1.40  1.026
  rebuild_ms@50k/clean                 1270.08   1201.24  0.946
  rebuild_ms@50k/rope                  1222.46   1103.48  0.903
  rebuild_ms@5k/clean                   136.36    136.48  1.001
  rebuild_ms@5k/rope                    160.10    143.80  0.898
  stream_block_max_ms@50k/clean          68.00     55.14  0.811
  stream_block_max_ms@5k/clean           15.66     12.86  0.821
```

## Transport stages (probe.py, baseline 9992500 vs T6 head, 2 rounds, medians)

Per-experiment probes were not run for T2 alone; the cumulative probe (`scratchpad/ar/transport/probe-base-T6.json`)
shows worker serialise for a 50k add going from 112 ms to 10.5 ms (Chrome) and 194 to 12 ms (WebKit), most of which is
T1 + T2. See the T6 notes for the full table.

## What surprised me

JSON.stringify/parse beating structured clone by 2-6x on plain record lists, and JSC's structured clone of objects
being much slower than V8's (specs 162 vs 100 ms) while its JSON is faster.

## Verdict

Keep. Chrome score 0.966, WebKit 0.948 (one round); WebKit edit@50k -18 %, fold@50k -23 %, load@50k -13 %; Chrome
edit/load@50k -9 to -10 %. WebKit edit@5k +17 % (102 -> 119 ms) is one round and looks like a one-frame step; unproven.
