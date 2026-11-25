# G5: GPU-expanded branches for the 'clay' and 'rope' materials (prototype, screened by probe only)

Parent: 516a64d (G4). Track: gpu. Written under the owner's time limit: screened with my own probe and an in-page pixel
check; `measure.py --quick` and `visual.py` could not get the benchmark lock in time and were **not run**.

## Hypothesis
Dimensional meshes are the largest (rope: 189 MB of WebGL buffers at 50k) and 3-4x slower to tessellate than flat
ones. Reading reliefBatch: 'clay' and 'rope' use exactly the flat strip (ribbon, cap, underline, end cap, dot), and every
extra per-vertex attribute is an analytic function of the point: unit normal +-(-ty, tx), strength (colour alpha x dim;
rope: 1/15 steps with the ply count above), across +-1, the shadow offset SHADOW_FALL * (1.1 hw + 1) +- normal *
(0.5 hw + 2) of the local half width, the rope twist (turn0 + t * limb / lay), and one whipping quad per divided bundle.
So the same records (64 words) and one more vertex shader variant per pass can replace the CPU mesh. Expected: rope
and soft-clay rebuild/load/edit down as for flat, memory down ~95 %; frame cost: the shadow pass runs the heavy shader
too, and caps stay fans (the dome's shading needs its centre vertex), so G3's compaction does not apply to caps.

## What changed
- `core/geometry/branch-instances.ts`: rewritten piece logic for six pieces (start cap, ribbon, underline, whipping,
  end cap, dot) with per-piece break rules; FANS records ('clay', 'rope'): caps and dots as centre fans; RELIEF_WORDS =
  64 (strengths, twist start, limb, lay, underline span, whipping centre, direction, half width, reach, colour);
  `gpuRelief` (clay, rope; 'arcs' and 'quilling' keep the CPU mesh); `instanceVertices` mirrors positions and all
  lighting attributes; bounds include the shadow reach as reliefBatch's. Flat records are unchanged in layout and look.
- `render/shaders.ts`: one body compiled four ways with #define: flat, lit (RELIEF_FS), rope (ROPE_FS: v_twist,
  v_plies) and shadow layer (RELIEF_SHADOW_FS, vertex moved by its shadow offset); attributes quantised exactly as the
  CPU arrays store them (int8 / 127 truncated, shadow offsets int16 / 128).
- `render/renderer.ts`: per-mesh record stride; instanced meshes carry MeshRelief, so the existing shading decision
  (maxWidth x zoom >= 1.5 px), the shadow layer and the composite apply unchanged; four instanced programs.
- `core/geometry/tessellate.ts` (exports LAY, plyCount, branchLength, clayFall, claySpread; BranchMeshCache takes the GPU
  path for clay and rope), `core/types.ts` (`BranchInstances.words`), picking, animation subset and transport pass the
  stride / material through.

## Correctness
- `bun run check` 0/0, boundaries OK, `check-browser.py` all PASS.
- Attribute parity (`probe/parity-relief.ts`, bun): clay and rope variants of the dumped specs of clean, studio,
  hand-drawn, boardroom (random widths, twist, whippings on 30 %, round caps, dimming): 180,000 CPU vertices, every one
  matched by position by an instanced vertex whose normal, strength, across, shadow offset (all quantised), twist (1e-3)
  and colour agree within one step; same number of non-degenerate triangles. Coverage at full and coarse level
  (`probe/parity-relief-coarse.ts`): 0 mismatches, bounds contain the CPU bounds. Flat parity re-run after the rewrite
  (`probe/parity-flat.ts`): unchanged, 0 mismatches.
- Pixels (`swap_ab.py` from G4, same page, GPU frame vs the CPU mesh of the same specs, Chrome, 300 nodes): soft-clay
  5 / 2 / 11 pixels over threshold at fit / zoom 0.5 / zoom 2 (max 68), rope 1 / 1 / 6 (max 54; at zoom 2 9,738 pixels
  differ by up to 8 levels: the ply pattern inside the ropes, float32 twist and shading differences, looked at: no
  visible change), clean control 0 / 0 / 9. Raw `swap-G5.json`. The benchmark's visual guard was not run.

## Screening: my probe only (`g2probe.py`, theme rope, Chrome, **2 rounds**, interleaved; A = G4 build (rope on the CPU
mesh), B = G5 build; raw `probe-rope-chrome.json`)
| | 5k A | 5k B | 20k A | 20k B | 50k A | 50k B |
|---|---:|---:|---:|---:|---:|---:|
| worker branch mesh, load (ms) | 72 | 21 | 253 | 35 | 617 | 71 |
| worker branch mesh, one edit (ms) | 12.3 | 4.8 | 49.9 | 8.8 | 47.4 | 18.1 |
| load to settled (ms) | 236 | 454 (rounds 454, 158) | 773 | 437 | 1,498 | 943 |
| edit to settled (ms) | 166 | 149 | 447 | 280 | 797 | 664 |
| WebGL buffers (MB) (+ record texture) | 21.8 | 0.30 (+1.25) | 78.8 | 0.94 (+4.9) | 189 | 2.2 (+12.2) |
| GPU ms/frame fit | 0.50 | 0.78 | 0.39 | 0.85 | 0.73 | 1.71 |
| GPU ms/frame zoom 0.05 / 0.35 / 1 / 4 | 0.77 / 0.95 / 0.90 / 0.91 | 0.89 / 0.82 / 0.54 / 0.89 | 0.74 / 1.09 / 0.73 / 1.46 | 0.97 / 1.18 / 1.26 / 0.87 | 0.74 / 1.18 / 1.84 / 1.81 | 0.91 / 0.98 / 0.94 / 2.96 |

Two rounds with large spreads at the closer cameras (A at 50k zoom 1: 1.84 and 0.90): treat those as unresolved. The
fit view is consistently 1.6-2.3x more GPU (+0.3 to +1.0 ms): fans and break points at the coarse level. The 5k load
B median is an outlier pair (the other round: 158 ms).

## Verdict
Keep as a prototype for the lead to measure officially (both engines, full benchmark, which covers soft-clay and rope at
20k as well): rope load at 20k/50k -43 % / -37 %, edit -37 % / -17 %, buffers -99 %, pictures matched; the frame cost at
the whole-map view rises by up to 1 ms. Not done: WebKit, visual.py, quick screen, 'arcs' (lift wave, sheared spine,
plugs: analytic, feasible the same way) and 'quilling' (multi-strip walls, scrolls, root rings: a different generator,
the hardest).
