# D1: profile of the dimensional materials (rebuild path and frame path)

No code change: this commit records the measurements the materials track (D2 to D6) is built on. Code profiled:
e2d9186 (merged round 1). All numbers are provisional: other agents ran browsers and benchmarks on the machine at the
same time.

## Method
- **Kernel, warm, Chrome** (`tools/prof.py` + `prof.html`): the real `BranchMeshCache.build` (fresh cache) and
  `packVertices` bundled from the tree (`tools/build.sh`), run on the specs the app produced (captured from the dev
  server, `tools/capture.py`; 5k/50k from round 1's mesh track, 20k captured here), 3 warm-up runs, then 6 runs under
  the CDP sampling profiler (100 us). Raw: `kernel-profile-chrome-50k.json`.
- **Kernel, cold** (`tools/cold.py` + `cold.html`): a fresh page per run, then one build per theme in the benchmark's
  order (clean, soft-clay, lifted-arcs, rope, paper-quilling, clean), as the layout worker sees them on theme switches.
  Chrome and Playwright WebKit, main thread. Raw: `cold-*.json`. Also under bun (JavaScriptCore, `tools/cold-bun.mjs`)
  and node 24 (V8), several orders: `cold-bun-node-50k.txt`.
- **In the app**: the worker diagnostics (`branchMeshMs`, `layoutMs`, first-frame `drawMs`) that the lead's
  official F4 run (3 rounds, both engines) recorded for every rebuild.
- **GPU per render pass** (`tools/gpuattr.py`): production bench build of e2d9186, 20k nodes, the benchmark's own
  pan path (`__benchRun.pan`) at fit, zoom 0.35 and 1.0, once normally and once with one pass switched off by patching the
  renderer instance (no shadow layer, no branch mesh, no rectangles, no labels). Chrome GPU timer. One round only, so
  each value is +-30 % or worse. Raw: `gpu-attribution-20k-chrome.json`.

## Rebuild path: what a dimensional theme switch costs beyond clean
In-app worker mesh step (`branchMeshMs`, ms; official F4 run, B side, 3 rounds):

| | clean | soft-clay | lifted-arcs | rope | paper-quilling |
|---|---|---|---|---|---|
| Chrome 20k | 22-24 | 35-37 | 52-53 | 82-84 | 66-67 |
| Chrome 50k | 51-67 | 51-61 | 80-85 | 128-168 | 86-105 |
| WebKit 20k | 26-30 | 54-55 | 68-69 | **214-218** | 73-74 |
| WebKit 50k | 63-67 | 95-96 | 118-119 | **334-338** | 155-161 |

Packing (`packVertices` in the worker's `shipMesh`) is not in `branchMeshMs`; it is in the kernel numbers below.
`rebuild_ms` (settled) for the same switches: WebKit 20k rope 738-769 against clean 502-520; WebKit 50k rope
1553-1675 against clean 1315-1319. The rope premium in WebKit (about 250 ms at 20k, 300 ms at 50k) is almost all mesh.

Cold kernel (fresh page, benchmark order; mesh + pack, ms, 2-3 runs each):

| | clean | soft-clay | lifted-arcs | rope | paper-quilling |
|---|---|---|---|---|---|
| Chrome 20k | 24+14 | 32+13 | 54-57+13 | 84-87+43 | 68-69+19 |
| Chrome 50k | 53-58+30-37 | 59-66+29-35 | 90-96+33-42 | 135-149+98-107 | 113-121+38-41 |
| WebKit 20k | 37-38+15 | 56-57+12 | 69-71+8-9 | 118-120+17-19 | 72-73+23 |
| WebKit 50k | 62-74+32-34 | 98-105+25-30 | 199-207+20-33 | **545-559+38-40** | 156-168+39-46 |

The decisive finding is **JIT warm-up, not arithmetic and not garbage collection**. Under bun (JavaScriptCore) at 50k
the first rope build takes 250-290 ms and the second, identical one 35-50 ms (`cold-bun-node-50k.txt`), whatever came
before it; soft-clay after three other materials takes 195 ms against 90-100 ms the first time. JSC's compile log
(`BUN_JSC_reportCompileTimes=1`) shows `reliefBatch` compiled with DFG four times and FTL twice (33 and 43 ms of
compile) during one cold rope build: the function is one 450-line body with two loops over every branch and closures
(`lit`, `cap`, `disk`) that capture and mutate its locals (`vp`, `ip`, the strength bytes), so the engine keeps
exiting optimised code on paths it has not profiled yet and runs most of the first build in its lower tiers. The flat
path has the same shape but one material, so it suffers less (cold 60, warm 20-30 ms).

Warm kernel profile (Chrome, 50k, per build, ms; self time): garbage collection is 2-5 % (clean 3.5, soft-clay 2.3,
arcs 4.5, rope 8.3 of 147, quilling 2.3). Packing is as large as tessellation in V8: rope tessellation 93 ms
(reliefBatch 41, lit 15, cap 8, find 6) and packing 54 ms (packReliefVertices 53); quilling: walls 41, pack 39. In JSC
packing is cheap (13-23 ms warm). Round 1's "15 % GC" for rope was not reproduced in the kernel; in the app the
worker's heap is larger, which this kernel does not model.

## Frame path: where dimensional GPU time goes (Chrome, 20k, one round, ms GPU per pan frame)
| theme / view | all passes | no shadow layer | no branch mesh | no rects | no labels |
|---|---|---|---|---|---|
| soft-clay fit | 1.54 | 2.22 | 2.04 | **0.34** | 1.36 |
| soft-clay 0.35 | 0.99 | **0.61** | 0.99 | 0.46 | 0.84 |
| soft-clay 1.0 | 1.65 | **0.51** | 0.96 | 1.07 | 1.33 |
| lifted-arcs fit | 0.86 | 1.22 | 1.25 | **0.42** | 1.13 |
| lifted-arcs 0.35 | 1.05 | **0.45** | 0.48 | 0.39 | 0.58 |
| rope 0.35 / 1.0 | 0.72 / 0.75 | 0.41 / 0.31 | 0.41 / 0.61 | 0.50 / 0.55 | 0.60 / 0.43 |
| paper-quilling 0.35 / 1.0 | 1.22 / 0.89 | 0.62 / 0.60 | 0.58 / 0.36 | 0.71 / 0.96 | 0.96 / 0.97 |
| clean 0.35 / 1.0 | 0.31 / 0.46 | 0.21 / 0.42 | 0.25 / 0.37 | 0.31 / 0.28 | 0.47 / 0.23 |

Single round and noisy (clean "no shadow layer" moves although clean has none), but two things stand out: zoomed in,
the half-resolution shadow layer is the largest dimensional pass (0.3-1.1 ms); at the whole-map view, soft-clay's and
lifted-arcs' rectangles (their node shadows and clay tablets) are most of the frame. The official F4 run agrees on
the size of the gap: pan_gpu at 50k z1.0 soft-clay 2.55, quilling 3.50, clean 0.70 ms. Script per frame for the
dimensional themes is within 0.1-0.4 ms of clean (0.3-1.5 ms), so CPU per frame is not where they cost.

## What this means for the track
1. D2 should restructure the relief tessellator so it optimises on its first build (small top-level functions over one
   sink object, no captured mutable locals), with output bit-identical; allocation is a minor part.
2. Packing in V8 (rope 54 ms warm, about 100 ms cold at 50k) and the bytes it writes are the next item (D3: narrower
   vertices, or writing the GPU layout directly).
3. GPU: the shadow layer when zoomed in (D4), rectangles at the whole-map view for soft-clay and lifted-arcs (frame
   track territory for plain rects; the raised-rect program is ours).

## Verdict
Profile only (no code change). Keep as the record.
