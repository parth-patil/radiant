# T3: keep a document replica in the layout worker and send edits as ops

Parent: 8497d47 (T2). Track: transport.

## Hypothesis

Every layout request structured-clones the whole document (634 KB as JSON at 5k, 6.5 MB at 50k) plus the previous
placements to the worker; at 12,000+ nodes it is even streamed in ~1,400-entry chunks with a task turn per chunk.
The editor already produces the exact op lists it applied (`EditorChange.edit.forward`, also for undo/redo). Keeping
a copy of the document in the worker and replaying the ops removes the request clone on the main thread and the
deserialisation in the worker; a theme switch (no document change) sends no document at all.
Expected: lower edit, fold and rebuild latency at every size; load unchanged (it still sends the whole document).

## Change

- `ui/controller.svelte.ts`: `workerDoc = { doc, ops }` records a structured copy of every edit's forward ops
  (copies, because later edits mutate objects an op carries). A request sends `edits: { ops, nodes }` when the
  worker mirrors `this.doc`, the whole document otherwise. It is reset to "send whole" on a load, a change without
  an edit, a different document object, a new worker, a backlog over 10,000 ops, a whole-document stream that was cut
  off, or a stream during which an edit happened (chunks read the live document).
- `ui/layout.worker.ts`: `sync()` applies the ops to its replica with the core `applyOps` and checks the node
  count; on any doubt (no replica, an op throws, count differs, placements it no longer has) it answers
  `{ resync: true }` and the main thread resends the document whole.
- Placements: the main thread no longer sends back the placements the worker produced. The request names the result
  (`{ result: sequence }`) whose placements the main thread adopted and still holds unchanged; the worker keeps the
  placements of its last 4 results.
- `ui/pipeline.ts`: `LayoutWork` has `doc?` / `edits?`, `placements` may be `{ result }`; `computeWork` takes the
  resolved document. `computeWork` still calls `cache.invalidateAll()` (the layout cache is per root, so touched-based
  invalidation would not help a one-root map).

## Correctness

`replica.py` (dev server): random seeded sequences of 30-60 edits through the editor (add child, rename, delete
subtree, move subtree, fold, style, duplicate, add sibling, undo, redo, 5-keystroke typing bursts) on 3,000 and 13,000
nodes in clean, rope and paper-quilling; after every step the laid-out node set and label texts match the main
document; at the end a forced whole-document resync gives identical boxes (0 differing). Message counts showed the
edit path in use (e.g. 2 whole documents, 53 edit requests, 0 resyncs). bun run check 0/0, check-boundaries OK,
check-browser PASS. Visual guard (Chrome, 18 scenes, T2 pin vs T3 pin): 0 differing pixels.

Not verified: AI streaming groups and agent ops (they go through the same editor emit path, but were not exercised);
mutations of the document outside the editor other than `layoutPlacements` and `modified` (I found none in ui/;
the node-count check only catches structural divergence, not a changed text).

## Screening (quick, 1 round; raw: quick.json; parent = T2)

```
== chrome score A 59.17 B 54.98
  edit_ms@50k                           678.22    601.72  0.887
  edit_ms@5k                            101.75     84.54  0.831
  fold_ms@50k                          1391.04   1232.41  0.886
  fold_ms@5k                            165.44    149.18  0.902
  heap_mb@50k                           167.50    167.51  1.000
  heap_mb@5k                             22.91     22.83  0.997
  load_ms@50k                           923.87    956.50  1.035
  load_ms@5k                            120.54    120.47  0.999
  pan_cpu_mean@50k/clean                  1.36      1.38  1.016
  pan_cpu_mean@50k/rope                   1.49      1.53  1.027
  rebuild_ms@50k/clean                 1016.60    860.79  0.847
  rebuild_ms@50k/rope                  1113.99   1045.12  0.938
  rebuild_ms@5k/clean                   120.62    103.59  0.859
  rebuild_ms@5k/rope                    160.58    148.84  0.927
  stream_block_max_ms@50k/clean         161.59    164.73  1.019
  stream_block_max_ms@5k/clean           20.66     20.50  0.992
  stream_longtask_max_ms@50k/clean       84.00     85.00  1.012
  stream_longtask_max_ms@5k/clean         0.00      0.00  nan
== webkit score A 55.41 B 51.43
  edit_ms@50k                           657.62    582.62  0.886
  edit_ms@5k                            118.90     85.22  0.717
  fold_ms@50k                          1470.42   1230.08  0.837
  fold_ms@5k                            159.64    138.20  0.866
  load_ms@50k                           833.96    850.50  1.020
  load_ms@5k                            121.48    120.82  0.995
  pan_cpu_mean@50k/clean                  1.29      1.45  1.126
  pan_cpu_mean@50k/rope                   1.41      1.43  1.009
  rebuild_ms@50k/clean                 1054.54    988.50  0.937
  rebuild_ms@50k/rope                  1063.60    958.04  0.901
  rebuild_ms@5k/clean                   137.72    136.24  0.989
  rebuild_ms@5k/rope                    143.22    125.92  0.879
  stream_block_max_ms@50k/clean          55.18     58.68  1.063
  stream_block_max_ms@5k/clean           15.54     17.44  1.122
```

## Verdict

Keep. Score 0.929 (Chrome), 0.928 (WebKit). edit@5k -17 % / -28 %, edit@50k -11 % / -11 %, fold@50k -11 % / -16 %,
rebuild@50k/clean -15 % / -6 %; load unchanged as expected (one round; changes under 10 % unproven).
