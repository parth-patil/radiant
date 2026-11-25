# Reference map performance

The native gate opens a saved SQLite document in a fresh window for each trial. The small, large and stress maps contain 200, 5,000 and 50,000 nodes respectively. The large map embeds 300 distinct raster pictures and an SVG. The gate records elapsed time from the native open command to a display callback after the first map draw, worker layout and mesh times, visible-set queries, ten seconds of pan and zoom, and ten seconds of idle draws on the large map. It samples GPU time when WebGL exposes timer queries.

From the repository root on an unlocked Mac, run the command for the current display mode. The default is three trials per map. The runner needs Python 3.10 or later, Node, Bun, the Rust toolchain, the macOS build tools, and the installed frontend dependencies.

```sh
python3 radiant/tools/check-reference-performance.py --hz 60 --report reports/60hz.json
```

Repeat at 120 Hz with `--hz 120 --report reports/120hz.json`. One command prints both tables.

```sh
python3 radiant/tools/check-reference-performance.py --table reports/60hz.json reports/120hz.json
```

The GitHub Actions workflow assigns each rate to a labelled, unlocked Apple silicon runner. It keeps reports for each commit and compares each passing configuration to its first passing baseline. Mean script time has a 10% tolerance. The other metrics use the larger of 10% and the observed range across baseline trials. Absolute budgets still apply. A manually dispatched run can establish a new baseline after a runner or monitor changes. The nightly job uses the 60 Hz runner for repeated native open, edit and close memory checks. This repository has no configured Git remote at this checkpoint. The hosted jobs have not run. [Workflow](../../.github/workflows/reference-performance.yml)

## Browser control on 18 November 2026

The production renderer and the same three map fixtures ran in headless Chromium at a measured 60 Hz on an M4 Pro. Each map panned and zoomed for ten seconds. The browser loaded serialized documents in memory. A separate native run confirmed the SQLite fixtures contained all expected nodes and that the large map embedded 301 assets. The locked Mac display prevented native presentation timing. [Raw control and slowdown reports](reference-performance-controls.zip)

| Map | Mean frame interval | Mean script time | p95 script time | Layout |
|---|---:|---:|---:|---:|
| Small | 16.67 ms | 0.28 ms | 0.60 ms | 3.1 ms |
| Large | 16.67 ms | 0.46 ms | 1.00 ms | 41.5 ms |
| Stress | 16.67 ms | 0.42 ms | 0.90 ms | 520.5 ms |

The large map used its worker and submitted zero idle draws. The gate accepted the clean report. Adding a 12 ms busy loop to each draw raised large-map mean script time to 12.11 ms and produced a failing exit status. The archive contains the individual frame intervals, script samples and available GPU samples from both runs. Unzip it and pass either JSON file to `--check-report` to repeat the gate decision.
