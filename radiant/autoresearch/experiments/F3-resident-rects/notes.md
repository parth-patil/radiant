# F3: keep rect and shadow instances on the GPU while the whole map is in view

Commit 9e9b2a6 (parent b3ab144). Verdict: **keep**.

## Hypothesis
Every frame the renderer rewrote each visible rectangle and its soft shadow camera-relative into a Float32 instance buffer and uploaded it (study 02: 87,486 instances, 5.4 MB and about 1.1 ms of writes per frame at the 50k whole-map view in soft-clay and lifted-arcs, which draw every node as a rect with a shadow). If the instances stay resident in world space and the camera arrives as a uniform, a whole-map frame re-sends nothing. Metrics: `pan_cpu_mean`/`pan_cpu_p95` at the fit position for soft-clay and lifted-arcs at 20k and 50k (not covered by `--quick`, which runs clean and rope only); `gpu_buffer_mb` up by the resident lists in those themes.

## What changed
- `src/lib/render/shaders.ts`: RECT_VS and SHADOW_VS (and so RECT_RAISED, which reuses RECT_VS) take `u_off` + `u_off_low` (origin - camera, split in double precision on the CPU, as MESH_VS does), a per-instance float32 residual `a_low` (location 5) and `u_min`: boxes smaller than u_min both ways are dropped in the vertex shader, which reproduces the CPU rule "skip rects under a quarter pixel" (and their shadows). Per-frame instances (labels' greeking bars, overlays, partial views) pass 0 for all three and are computed exactly as before (x + 0 + 0 + 0).
- `src/lib/render/renderer.ts`: when the rect query returns every rect (whole map in view, the F1 identity case), `buildResident` uploads all rects, over-branch rects and shadows once (stride 18 floats, positions relative to the centre of their extent, in scene order) and draws them with one instanced call each; built lazily on the first such frame and freed when the scene's rect/label/image arrays change. `stats.rectsDrawn` stays exact: a sorted float32 array of each rect's larger side gives the count of rects the shader keeps by binary search. Partial views keep the old per-frame path (a few hundred instances, already cheap).

## Numbers
Probe after F3 (F1 + F2 + F3), 50k, script mean ms / GPU median ms, compared with the F2 probe:

| theme | fit (F2 -> F3) | zoom 0.35 | zoom 1 |
|---|---|---|---|
| soft-clay | 1.44 / 6.12 -> 0.30 / 6.16 | 0.33 -> 0.35 | 0.15 -> 0.20 |
| lifted-arcs | 1.45 / 4.99 -> 0.33 / 4.85 | 0.27 -> 0.29 | 0.15 -> 0.17 |

Whole-map renderer script falls about 4.5x in both themes; zoomed views are unchanged within the 0.1 ms clock (they do not take the resident path). GPU unchanged, as expected. One-off cost: building the resident lists on the first whole-map frame after a scene change (not timed separately; one pass over the rects plus a 50k-element float sort).

Official A/B by the lead (full, 3 rounds, both engines, b3ab144 vs 9e9b2a6; `radiant/autoresearch/official/F3-9e9b2a6.json` in the main tree), medians A -> B (ratio):
- Chrome: score 57.53 -> 57.52 (1.00), frame 0.99, dimensional 0.99, rebuild 1.02, interaction 0.99. pan_cpu_mean at fit: 20k soft-clay 1.24 -> 0.77 (0.62), 20k lifted-arcs 1.45 -> 0.78 (0.54), 50k soft-clay 1.96 -> 1.44 (0.74), 50k lifted-arcs 1.31 -> 1.22 (0.93). pan_cpu_p95@50k soft-clay 4.50 -> 4.86 (1.08), lifted-arcs 3.61 -> 3.82 (1.06), unexplained, possibly noise (README: p95 sd up to 17 %). gpu_buffer_mb@50k/soft-clay 132 -> 139 (1.06).
- WebKit: score 62.46 -> 60.61 (0.97), frame 0.94, dimensional 0.92. pan_cpu_mean at fit: 20k soft-clay 0.57x, 20k lifted-arcs 0.46x, 50k soft-clay 2.14 -> 1.35 (0.63), 50k lifted-arcs 0.69x.
- Reading: a clear cut of the whole-map frame in the two themes that draw every node as a rect, smaller than my renderer-only probe because the benchmark's per-frame number also counts the camera change and the app's reactive UI, and because F1 had already removed the grid walk. No effect on scores outside the dimensional sub-score.

My own screening run: not done (killed by the pause).

Probe method: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/probe.py`, headless Chrome (Metal ANGLE), DPR 2, 1728 x 1117, against my own Vite dev server on port 1431 serving the worktree at that point; `?demo=big&n=50000`; per theme three camera positions (fit, densest view at zoom 0.35, densest at zoom 1); 30 warm-up + 60 measured frames each, camera on a circle; script = performance.now() around `renderer.render()` (dev page not cross-origin isolated: 0.1 ms clock, so only means are usable), GPU = median EXT_disjoint_timer_query time per frame. One run each with other agents active: treat a single GPU number as +-30 %. Output was printed, not saved; values copied from the session log.

## Visual guard
`visual.py` b3ab144 vs 9e9b2a6, Chrome: 18/18 scenes 0.0000 % over threshold, max 0, any 0.000 % (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F3/visual.json`). The map60 fit scenes in soft-clay and lifted-arcs (every node a rect with a shadow, whole map in view) take the resident path, so the new placement maths is exercised and gives bit-identical pixels there. Not covered: soft-clay and lifted-arcs at 5k to 50k whole-map views (the big maps visual.py renders are clean and rope, which have a single rect). An extra-scene run for those (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-extra.py`) was queued twice and cut off both times (the pause, then I stopped it to free the bench lock); not verified.

## Risks / notes
- Positions at rest go through a different float path (origin-relative + uniform offset instead of camera-relative float32); the residual keeps them within float32 rounding of the old values, but sub-pixel rounding could differ by a unit in edge pixels at extreme zooms. See the guard result above.
- GPU memory: + 72 bytes per rect and per shadow while a whole-map frame has been drawn (about 7 MB at 50k soft-clay).
- RECT_VS gained uniforms: any new caller of the rect program must set u_off, u_off_low and u_min (`usePlaced` does it).
