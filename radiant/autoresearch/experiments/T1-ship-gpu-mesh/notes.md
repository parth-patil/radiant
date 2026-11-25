# T1: stop cloning the CPU branch mesh to the main thread

Parent: 9992500 (baseline). Track: transport.

## Hypothesis

Every layout result structured-clones the worker's CPU branch mesh (f64 positions, f32 colours, u32 indices, relief
attribute arrays, branch spans) to the main thread, on top of the packed GPU buffer that is already transferred:
16 MB at 5k, 142 to 186 MB at 50k. The main thread needs only the packed buffer (upload), the indices and branch
spans (culling, fold animation) and the relief's scalars; positions only to pick a branch under the pointer.
Expected: lower main-thread heap, less worker serialise and main deserialise time, lower edit latency at 50k.

## Change

- `ui/layout-transport.ts`: `shipMesh(mesh, transfer)` builds the mesh the main thread gets: packed GPU buffer
  (transferred), copies of indices and branch-span bounds/ends (transferred; the worker keeps its own batch for the
  mesh cache), relief scalars with empty attribute arrays, empty positions and colours. `meshPositions(mesh)`
  rebuilds world positions from the packed buffer (x = ox + f32 [+ f32 residual on wide meshes]) the first time a
  branch is picked, and keeps them on the mesh.
- `ui/layout.worker.ts`: uses `shipMesh`; the overlay mesh path is unchanged (fully transferred).
- `ui/pipeline.ts hitBranch`: picks through `meshPositions`.
- `render/renderer.ts uploadRelief`: trusts the given packed buffer when the mesh has no CPU positions (it used to
  compare the buffer size with positions.length).

## Screening (quick, 1 round, other agents active; raw: quick.json)

| metric | Chrome A | Chrome B | B/A | WebKit A | WebKit B | B/A |
|---|---:|---:|---:|---:|---:|---:|
| score | 66.61 | 68.15 | 1.02 | 61.90 | 61.88 | 1.00 |
| heap_mb@5k | 34.9 | 23.5 | **0.67** | - | - | - |
| heap_mb@50k | 274.8 | 173.5 | **0.63** | - | - | - |
| edit_ms@5k | 101.5 | 102.4 | 1.01 | 102.5 | 103.1 | 1.01 |
| edit_ms@50k | 869.6 | 1018.4 | 1.17 | 838.2 | 887.3 | 1.06 |
| fold_ms@50k | 1664 | 2103 | 1.26 | 1772 | 1839 | 1.04 |
| rebuild_ms@50k/rope | 1277 | 1362 | 1.07 | 1391 | 1299 | 0.93 |
| load_ms@50k | 1070 | 1103 | 1.03 | 1106 | 1036 | 0.94 |

One round: every latency change here is inside the 10 % noise band except Chrome edit/fold@50k (+17 %, +26 %),
which point the wrong way and are unproven; see the probe below. The heap drop (main thread only, after GC) is
deterministic: -11 MB at 5k, -101 MB at 50k.

## Branch picking (own probe, picktest.py)

3,000 points along branches, ids mapped to layout order, parent vs candidate: identical hits in clean, rope,
paper-quilling, soft-clay, lifted-arcs at 5k and clean, rope at 50k (0 differing). The first pick after each
layout now pays the unpack: 1.8 to 2.6 ms at 5k, 9.5 to 13 ms at 50k (Chrome); later picks unchanged (~2 us at 5k).

## Correctness

bun run check 0/0, check-boundaries OK, check-browser PASS (dev server :1433). Visual guard (Chrome, 18 scenes):
0 differing pixels, max difference 0 everywhere (`scratchpad/ar/transport/visual-T1`). Fold animation with motion on
(animtest.py, 5k clean/rope/paper-quilling): no page errors, same triangle counts per frame as the parent.

## Verdict

Keep (memory win, no visual change); latency effect unproven at one round. Raw probe numbers for the transport
stages are in the T2 notes (T1 is T2's parent).
