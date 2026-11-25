# F4: coarse level of detail for the branch mesh below zoom 0.02

Commit 4440c91 (parent a1823d8). Verdict: **keep as a visual trade-off, for the lead to confirm**: not pixel-identical (0.005 to 0.05 % of pixels at the whole-map view differ, isolated pixels); see "What the user sees".

## Hypothesis
The whole-map view at 20k to 50k nodes submits 3 to 3.9 million branch triangles, all under half a pixel (study 02), so those frames are vertex bound. Drawing the same vertices through a coarser index buffer at far zoom should cut that GPU work several-fold without a visible change, because the mesh is sampled for zoom 4 (`MESH_DETAIL_ZOOM`, a quarter pixel of chord error there) and at zoom 0.02 a merged run of 8 segments is still well under a pixel off. Metric: `pan_gpu_mean@*/fit` (Chrome) at 20k and 50k, and so `pan_gpu_mean` overall; `gpu_buffer_mb` up (a second index buffer once a far frame has been drawn).

## What changed
`src/lib/render/renderer.ts` only (no new vertices, no change in core or the worker):
- `coarsenSpan` rewrites one branch span's indices: ribbon quads (q, q+1, q+2), (q+1, q+3, q+2) with q stepping by 2 (the layout tessellate.ts emits) become one quad per `LOD_STEP` = 8 segments; fans (c, c+1+k, c+2+k: caps, tip dots) keep every other step; anything else is copied.
- `buildCoarse` runs it span by span in `setTimeout` slices of at most 3 ms (never inside a frame), starting on the first frame below `LOD_ZOOM` = 0.02 after a mesh change, then uploads the coarse index buffer and per-span ends. Until it is ready the full mesh is drawn. Completion does not request a frame (the picture is meant to be the same).
- Below zoom 0.02, `visibleMesh`/`drawRuns` use the coarse buffer and its span ends (culling still works). Static branch mesh only; applies to every material (the lit programs see the same vertices).
- Error bound used to choose the threshold: 8^2 x 0.25 px x 0.02 / 4 = 0.08 px of chord error at zoom 0.02, less below it. The whole map is at zoom 0.0136 (5k), 0.0056 (20k), 0.0026 (50k), so all three fit views take the coarse path.

## What the user sees differently, and when
Below zoom 0.02 only (the whole-map view of maps above roughly 3,000 nodes), once the coarse buffer is ready: a few isolated pixels inside the sub-pixel "speckle" of branch fragments and around the root's fanned start caps change value. Measured with the committed code (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/lodcheck.py`: dev server in my worktree at 74f9878, Chrome, DPR 2, whole-map view, resting MSAA frame read back full-size with the coarse buffer and again with it removed):

| map | clean | soft-clay | lifted-arcs | rope | paper-quilling |
|---|---|---|---|---|---|
| 5k (zoom 0.0136), % pixels > 8/255 (max diff) | 0.025 (125) | 0.012 (78) | 0.029 (111) | 0.028 (154) | 0.048 (118; any 0.126) |
| 50k (zoom 0.0026) | 0.005 (125) | - | - | 0.005 (52) | 0.013 (109; any 0.031) |

That is about 400 to 3,700 of 7.7 million device pixels. The 5k clean differences lie in a 40-device-pixel-wide column (x 1708 to 1747, the map's vertical trunk) as isolated dots among the sub-pixel branch fragments and a few pixels around the root's caps; at 1:1 the two images have the same texture (crops: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/lod-shots/crop-5000-clean.png`: coarse | full | difference in red, 4x nearest-neighbour). When it changes: (a) on the first frame drawn after the coarse buffer finishes (a few timer slices after the first frame below 0.02, so when the camera moves next; nothing redraws on completion), and (b) when zooming across 0.02. Both are a flip of those isolated pixels, not a visible shape change at normal viewing distance; I did not look at it on a real display. Not checked in WebKit.

## Numbers
In-page prototype before implementing (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/lodproto.py` + `lodproto.js`, dev server at F5, Chrome, 50k fit, three interleaved rounds of 60 moving frames, GPU median ms per round; full-resolution readback of a still frame drawn both ways):

| theme | triangles full -> coarse | coarse build (one pass, main thread) | GPU full | GPU coarse | pixels differing (> 8 / any) |
|---|---|---|---|---|---|
| clean | 3.02 M -> 0.57 M | 9.9 ms | 1.39, 1.28, 0.77 | 0.59, 0.43, 0.43 | 0 / 0 |
| rope | 3.85 M -> 1.03 M | 11.7 ms | 1.70, 1.08, 1.05 | 0.49, 0.83, 0.53 | 0 / 0 |
| soft-clay | 3.22 M -> 0.60 M | 13.1 ms | 2.25, 2.06, 3.23 | 1.79, 1.55, 2.48 | 0 / 0 |

Probe after F4 (moving frames, 50k fit): clean 0.83 ms script / 0.62 ms GPU (F5 probe: 1.12), rope 0.39 / 1.32 (F5 probe: 1.16, i.e. no gain seen in that single run), paper-quilling 0.39 / 0.45 (coarse path taken in all three). Single runs; the interleaved prototype above is the better evidence.

The 10 to 13 ms of coarsening at 50k is paid once per mesh change, in up to 3 ms timer slices after the first far frame; it is not inside the "settled" time the benchmark waits for (it does not keep `idle()` false), but it is real main-thread work that can delay input by up to 3 ms per slice.

Benchmark screening: not done (killed by the pause; the lead measures the commit officially).

Probe method: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/probe.py`, headless Chrome (Metal ANGLE), DPR 2, 1728 x 1117, against my own Vite dev server on port 1431 serving the worktree at that point; `?demo=big&n=50000`; per theme three camera positions (fit, densest view at zoom 0.35, densest at zoom 1); 30 warm-up + 60 measured frames each, camera on a circle; script = performance.now() around `renderer.render()` (dev page not cross-origin isolated: 0.1 ms clock, so only means are usable), GPU = median EXT_disjoint_timer_query time per frame. One run each with other agents active: treat a single GPU number as +-30 %. Output was printed, not saved; values copied from the session log.

## Visual guard
`visual.py` a1823d8 vs 4440c91, Chrome: 18/18 scenes 0.0000 %, max 0, any 0.000 % (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F4/visual.json`). **This does not show that F4 is pixel-identical**: visual.py captures right after `idle()`, and the coarse buffer is built in timer slices after the first far frame and is only drawn on the next frame, which a still camera never requests, so the big5k fit captures almost certainly show the full mesh. The targeted check above is the real guard and shows small differences. My earlier in-page prototype (table above) reported 0 differing pixels at 50k; it swapped the index buffer by hand and its still frame was read differently, so I trust the committed-code check over it.
