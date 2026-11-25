# Transport track tools (round 1)

Measurement and check scripts used by T1-T7 (copied from the scratch folder; run with `uv run` from this folder,
paths to the bench harness are absolute to the main checkout).

- `probe.py` (+ `probe-init.js`, `probe-worker.js`): per-operation transport breakdown between the layout worker
  and the main thread in production bench builds (worker serialise/deserialise, main post/deserialise/handler,
  longest main task, message count), A/B interleaved, both engines; `--journal` emulates the desktop journal path.
  Takes the benchmark lock. `probe-baseline-vs-T6.json`: baseline 9992500 against T6, 2 rounds.
- `micro.py` + `codec-proto.js`: same-thread cost of structured clone vs JSON vs a columnar codec for each part of a
  real adopted result.
- `fidelity.py`, `replica.py`, `picktest.py`, `animtest.py`, `autosave.py`, `lazycheck.py`: correctness checks
  (dev server on :1433 or production builds), described in the experiment notes.
- `cmp.py`: prints A/B medians of a measure.py JSON.
