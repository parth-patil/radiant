# Radiant autoresearch: rendering efficiency

A loop in the style of Andrej Karpathy's autoresearch: one fixed benchmark, many small experiments, each kept only if the measured numbers improve. Everything tried is logged here, including what failed.

## Goal

Make complex mind maps cheaper to rebuild and draw, especially large maps (5,000 to 50,000 nodes) and the dimensional branch materials (Soft clay, Lifted arcs, Rope, Paper quilling), without changing what the user sees.

## Rules of the loop

1. **The benchmark is fixed.** `bench/measure.py` and `bench/visual.py` define the metric. An experiment may not edit them. If an experiment restructures internals, it keeps the `window.__radiantBench` adapter working instead.
2. **One hypothesis per experiment.** Each lives in its own git worktree and branch (`ar/NN-name`), started from the current baseline commit.
3. **Measured against the baseline, interleaved.** The official number comes from `measure.py --tree BASE --tree2 CANDIDATE` run by the lead on a quiet machine: production builds, rounds alternated A, B, A, B. Numbers an experiment's own agent reports are provisional.
4. **Keep or discard.** Keep when the headline score, or a targeted sub-score, improves beyond the noise band and nothing else regresses beyond it, the visual guard shows no unintended change, and the project gates pass (`bun run check`, `node tools/check-boundaries.mjs`, `uv run tools/check-browser.py`). Otherwise discard, and record why.
5. **Kept experiments are merged one at a time** and the merged result becomes the new baseline, re-measured.
6. **Everything is recorded.** One row per experiment in `results.tsv`; one folder per experiment in `experiments/` with the hypothesis, the raw measurement JSON, and notes.

## Files

- `bench/`: the harness and its README.
- `research/`: profiling and feasibility studies that feed the experiment list.
- `experiments/NN-name/`: `notes.md`, `compare.json` (official A/B), `visual/` when the look could change.
- `results.tsv`: the ledger.
- `REPORT.md` and `report.html`: the final write-up.
