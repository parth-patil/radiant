# Native resident-memory gate

Run from the `radiant` directory on macOS with Bun, Cargo and Python 3.10 or newer. Install the locked dependencies first. The gate reuses the local frontend install and makes no AI calls.

```sh
python3 tools/check-memory.py
uv run tools/check-performance.py --native-memory
```

The second command adds the native gate to the existing performance workflow, which expects the dev server on port 1420. The [nightly workflow](../../.github/workflows/reference-performance.yml) runs the native gate with `--visible --report reports/memory.json` on the labelled macOS runner. `--measure-only` collects observations without applying the checked-in limits, and `--prepared PATH` reuses a scratch build and fixture created by this command. Retain `memory-report.json` from the printed artifact directory for per-phase process attribution, revision, environment and pass/fail details. Use distinct ports for concurrent runs.

The gate builds an optimized Rust host from the selected Git revision and serves the production frontend bundle over loopback. An isolated process first creates the three native SQLite fixtures. A fresh host measures the 200-node map, the 5,000-node map with 300 distinct 480×320 PNGs, 12 additional large-map cycles, then the 50,000-node map. Each cycle opens a new native document window, waits for layout and render, makes a durable root-title edit, destroys the clean window, and verifies native session removal before taking the close sample. The large fixture requires the layout worker and at least one resident picture texture in its initial viewport. The default offscreen run uses synchronous layout for the 50,000-node fixture. The visible run requires the streamed worker layout to complete before it samples memory.

Samples use macOS `ps` RSS. The host and exact WebContent identities come from the scratch native IPC, and process start identity checks guard against PID reuse. The sum deduplicates shared process identities and includes any surviving former document WebContent processes. Shared memory pages can still be counted in more than one process. Web workers are accounted for inside their WebContent process. The gate excludes GPU and network helpers, which it cannot assign reliably to individual document windows. Samples are settled observations after a one-second wait and cannot detect brief peaks between phases. Figures apply to the synthetic vector and PNG fixtures and Apple Silicon configuration described below. The fixtures have no SVG subtrees.

The repeat checks cap the largest excess above the empty host baseline, the change from the first three to the last three close samples, and the slope after the first two repeats. Those measures allow allocator warm-up and still gate sustained growth. The 50,000-node case runs last so its allocator growth does not affect the large-map repeat checks.

## Calibration

The 12-repeat run used revision `9be697ef` on Mac16,7 (Apple Silicon, 24 GiB RAM) with macOS 26.5.1 (25F80). Figures are MiB. Each RSS column is the largest settled observation for that role during open or edit, so column maxima can come from different phases. The total is the largest simultaneous summed observation.

| Fixture | Host | Launcher WebContent | Document WebContent | Total observed | Gate ceiling |
| --- | ---: | ---: | ---: | ---: | ---: |
| 200 nodes | 113.44 | 60.61 | 73.56 | 247.61 | 325 |
| 5,000 nodes with 300 pictures | 161.19 | 60.55 | 363.33 | 584.52 | 700 |
| 50,000 nodes, synchronous fallback | 356.66 | 60.41 | 830.14 | 1,247.20 | 1,500 |

The empty baseline was 170.28 MiB. The 12 repeated close samples ranged from 208.14 to 221.61 MiB, with a maximum 51.33 MiB above the baseline and a 7.05 MiB rise between the early and late medians. The fitted trend after the first two repeats was +1.345 MiB per cycle, and the final five close samples increased by 0.86 MiB in total. The thresholds are 100 MiB above baseline, 30 MiB between medians and +4 MiB per cycle. The working-set ceilings add 20–31% headroom to the observations. This finite run verifies growth stayed inside the configured tolerance.

A separate native process run with six repeats passed all limits. The three observed totals were 247.75, 583.31 and 1,291.92 MiB. The maximum repeated close was 53.19 MiB above baseline, the median increase was 4.73 MiB, and the fitted change was +1.074 MiB per cycle.

A hidden-window run on revision `7461aa2` checked the report-export path and six additional large-map cycles. All limits passed. Peak totals were 222.88, 585.06 and 1,280.12 MiB for the small, large and stress maps. Physical visible-window results are pending.
