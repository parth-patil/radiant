# Incremental track tools (round 2)

Run with `uv run` from this folder. `harness.py`/`e2e.py` need a dev server of the tree under test (default
http://127.0.0.1:1441/); `probe.py` builds and serves production bench builds itself and takes the benchmark lock.

- `harness.py` + `harness.js`: drives `ui/pipeline.ts` `computeWork` directly in a dev page with real edit ops and the
  ChangeTrack the worker passes. `check` mode compares the persistent (incremental) pipeline with a fresh one after
  every random edit (boxes, placements, specs, label curves, scene labels/rects/images, picture maps, mesh arrays,
  spatial ids must be equal). `time` mode reports per-stage medians (computeSizes, settleLayout, branchSpecs, mesh,
  fullScene). Usage: `harness.py URL chrome|webkit sizes themes steps seeds check|time [kinds]`.
- `e2e.py`: random edits through the editor and the real layout worker, then a forced whole-document resync; the
  incremental result must equal the resynced one (derived from the transport track's replica.py).
- `probe.py` (+ `probe-init.js`, `probe-worker.js`): the transport track's per-operation probe, plus the worker's
  layout/geometry/mesh timers from `__radiantBench.diagnostics()`.
- `prof.py`, `agg.py`, `lines.py`: CDP CPU profile of the harness's timed edits, aggregated by function and line.
