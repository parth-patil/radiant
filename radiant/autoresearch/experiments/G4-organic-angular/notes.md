# G4: GPU-expanded branches for the remaining flat styles (organic, angular)

Parent: 5f1eaec (G3). Track: gpu.

## Hypothesis
After G1-G3 only 'tapered', 'rounded' and 'line' maps took the GPU path; a map with any 'organic' (Buzan strict, Buzan
relaxed, Hand-drawn) or 'angular' (Plain outline, Boardroom) branch kept the CPU mesh for all its branches. Both styles
are small additions to the strip: 'organic' is the cubic with seeded control points (already in the record, from
`curveOf`) and a width variation 1 + amp sin(pi t) sin(2 pi freq t + phase) (3 more record words); 'angular' is a
3-segment elbow polyline derived from p1 and the flow, with tangents from the signs of both legs and mitred inner
corners, as tessellateBatch draws it. Expected: the same rebuild and memory gains as G1 for these themes, same pixels.
The benchmark's themes (clean and the dimensional ones) do not use these styles, so its metrics should not move.

## What changed
- `core/geometry/branch-instances.ts`: `gpuBranch` accepts all five flat styles; flags ORGANIC, ELBOW, ELBOW_V; record
  words 28-30 (organic phase, frequency, amplitude); start/end tangents of an elbow; bounds widened by the organic
  amplitude; `instanceStrip` mirrors both.
- `render/shaders.ts BRANCH_INSTANCE_VS`: elbow corners, sign tangents and mitre; organic width (reads texel 7 only for
  organic records).
- Coarse level: an elbow's 3 segments coarsen to its two end points, as F4's `coarsenSpan` does (checked below).

## Correctness
- `bun run check` 0/0, boundaries OK, `check-browser.py` all PASS.
- Geometry (`probe/parity.ts`, bun, branch specs dumped from 300-node maps in buzan, hand-drawn (213 bent underlines),
  outline, boardroom (214 tip dots), clean, studio, ink, each also with flow 'v' and 'r' variants): sampled coverage of
  the strip vs `tessellateBranches(zoom 4)` and vs F4's coarsened indices: 0 mismatches, area equal within 1e-7, bounds
  contain the CPU bounds for every branch. Organic limbs never join their underline (the wobble tilts the end tangent;
  the CPU mesh has the same notch there), so they keep their break points.
- Pixels (`probe/swap_ab.py`, `swap-G4.json`): `visual.py` has no organic or angular scene, and organic maps cannot be
  compared across two page loads (the wobble is seeded by node ids, which `loadSynthetic` makes random), so the check
  is in one page: same document and camera, the frame drawn from the GPU-expanded branches, then the scene's branches
  swapped for `tessellateBranches(specs, zoom 4)` (what BranchMeshCache built before) and drawn again. Chrome, dev
  server, 300 nodes, fit / zoom 0.5 / zoom 2: buzan 1 / 2 / 17 pixels over threshold (max 49), hand-drawn 1 / 4 / 7
  (max 48), outline 0 / 0 / 0, boardroom 0 / 0 / 1 (max 54); clean as the control 0 / 0 / 9 (max 63). Single edge
  samples, as in G1. WebKit not checked.

## Screening
- `measure.py --quick` (G3 pin vs G4): queued at 22:21 behind another agent's lock (still waiting at commit time,
  22:24); the benchmark's themes do not use organic or angular branches, so it can only show that clean and the
  dimensional themes did not move. Not available for this commit.
- Targeted probe (G2's `g2probe.py`, theme buzan (organic), Chrome, 2 rounds interleaved, A = G3 build (organic on the
  CPU mesh), B = G4 production build; raw `probe-buzan-chrome.json`):

| | 5k G3 | 5k G4 | 20k G3 | 20k G4 |
|---|---:|---:|---:|---:|
| worker branch mesh, load (ms) | 13.2 | 5.0 | 30.4 | 8.4 |
| worker branch mesh, one edit (ms) | 4.9 | 1.6 | 15.3 | 6.5 |
| edit to settled (ms) | 132 | 132 | 298 | 231 |
| load to settled (ms) | 166 | 159 | 404 | 352 |
| WebGL buffers (MB) (+ record texture) | 12.3 | 0.19 (+0.63) | 45.3 | 0.55 (+2.47) |
| GPU ms/frame fit | 0.43 | 0.48 | 0.63 | 0.85 |
| GPU ms/frame zoom 0.05 | 0.69 | 0.79 | 0.85 | 0.95 |
| GPU ms/frame zoom 0.35 / 1 / 4 | 0.38 / 0.36 / 0.35 | 0.39 / 0.37 / 0.36 | 0.43 / 0.43 / 0.51 | 0.49 / 0.48 / 0.55 |

## What I learned
- The rebuild gain carries over to organic maps (worker mesh -62 to -72 %, -22 % edit at 20k).
- Organic frames cost more on the GPU than clean ones did after G3 (+11 to +35 % at fit, +2 to +14 % elsewhere, 20k
  more than 5k): organic limbs never join their underline, so every branch keeps two break points and an extra
  underline point, and its organic width reads one more texel per vertex. Absolute numbers stay under 1 ms.
- Organic maps must be compared in one page: random node ids reseed the wobble.

## Verdict
Keep (same trade as G1/G3: large rebuild and memory gains, a small GPU cost per frame), pending the quick screen
and the lead's official run, which cannot see organic/angular themes; 50k organic and angular frame costs and WebKit
were not measured.
