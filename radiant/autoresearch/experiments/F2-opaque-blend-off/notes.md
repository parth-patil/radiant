# F2: draw fully opaque branch meshes with blending off

Commit b3ab144 (parent 270ddf3). Verdict: **keep**.

## Hypothesis
Branch meshes are drawn with premultiplied blending (ONE, ONE_MINUS_SRC_ALPHA) although almost all are opaque; blending stops the Apple GPU's hidden-surface removal, and fan branches stack up to 3.5 screens of overdraw at 50k zoom 1 (study 02 section 4). With every fragment at alpha exactly 1, blend-on and blend-off give the same pixel (src + dst * 0), so turning blending off for such meshes should cut GPU time at zoom 0.35 to 1 with identical pixels. Metrics: `pan_gpu_mean` (Chrome) at 20k/50k for clean, rope, soft-clay, lifted-arcs; WebKit has no GPU timer so only wall time could show it.

## Exact condition (when a mesh is opaque)
`opaque = every vertex's alpha byte is 255` (byte 11 of each vertex in both the flat and the dimensional packed layouts, see mesh-vertices.ts), checked once at upload (`opaqueVertices` in renderer.ts, early exit on the first non-opaque vertex), **and** the material is not paper-quilling. Why that is exact:
- MESH_FS writes v_col; RELIEF_FS and ROPE_FS write alpha = v_col.a and clamp rgb to it. Interpolating a constant 1.0 gives 1.0, so alpha is 1 everywhere.
- QUILL_FS returns alpha 0 outside the scrolls and scales by a smoothstep at their edges, so quilling keeps blending.
- Dimmed branches: scene.ts `dimOpaque` mixes opaque colours toward the background and keeps alpha 1, so they stay opaque; translucent colours keep their alpha < 1, so the scan marks those meshes non-opaque. Animated, overlay and canvas-element meshes get the same scan, so a fading or translucent mesh keeps blending.
- The dimensional shadow layer is a separate pass (MAX blending into its own target) and is untouched; rect shadows and rects are untouched.

## What changed
`src/lib/render/renderer.ts`: `MeshGPU.opaque`, set in `uploadMesh`/`uploadRelief`; `drawMesh` disables BLEND around the draw when it is set.

## Numbers
Probe after F2 (F1 + F2), 50k, script mean ms / GPU median ms; compare with the F1 probe in F1's notes:

| theme | opaque | fit | zoom 0.35 | zoom 1 |
|---|---|---|---|---|
| clean | yes | 0.68 / 1.40 | 0.70 / 1.22 (F1: 3.39) | 0.21 / 1.12 (F1: 3.77) |
| rope | yes | 0.49 / 2.15 | 0.28 / 2.19 (F1: 3.18) | 0.14 / 2.20 (F1: 4.40) |
| soft-clay | yes | 1.44 / 6.12 | 0.33 / 2.09 | 0.15 / 2.18 |
| lifted-arcs | yes | 1.45 / 4.99 | 0.27 / 1.89 | 0.15 / 2.08 |
| paper-quilling | no (blending kept) | 0.38 / 1.55 | 0.23 / 3.94 | 0.11 / 4.14 |

GPU at zoom 0.35 to 1 falls by about half to two thirds for the four opaque themes (single runs, no interleaving; study 02's interleaved A/B gave the same direction: clean zoom 1 3.8 -> 1.6 ms). Whole-map views do not change (no overdraw there). The upload scan was not timed separately; it is one strided byte loop with early exit.

Official A/B by the lead (full, 3 rounds, both engines, 270ddf3 vs b3ab144; `radiant/autoresearch/official/F2-b3ab144.json` in the main tree), medians A -> B (ratio):
- Chrome: score 59.92 -> 59.25 (0.99), frame 1.27 -> 1.21 (0.95), dimensional 8.46 -> 8.20 (0.97), rebuild 1.01, interaction 1.00. GPU per frame at zoom 1 / 0.35: 50k clean 3.51 -> 1.24 (0.35) / 3.67 -> 1.35 (0.37); 50k rope 3.44 -> 1.98 (0.58) / 3.35 -> 2.75 (0.82); 50k soft-clay 3.25 -> 2.27 (0.70) / 2.90 -> 2.42 (0.83); 20k clean 2.49 -> 1.52 (0.61); 20k rope and soft-clay within noise (0.83 to 1.10). paper-quilling, which this commit does not touch, moved 0.79 at 50k: that is the size of the GPU noise.
- WebKit: score 1.01, frame 1.02 (no GPU timer in WebKit; blending is GPU work, so no CPU change was expected).
- Reading: a real GPU win where the benchmark's camera sits on fanned overdraw (50k clean and rope at zoom 1), smaller than my "densest view" probe suggested, and invisible in the headline score because the frame score pools CPU and GPU over three positions. Kept because it is pixel-identical and costs nothing measurable.

My own screening run: not done (killed by the pause).

Probe method: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/probe.py`, headless Chrome (Metal ANGLE), DPR 2, 1728 x 1117, against my own Vite dev server on port 1431 serving the worktree at that point; `?demo=big&n=50000`; per theme three camera positions (fit, densest view at zoom 0.35, densest at zoom 1); 30 warm-up + 60 measured frames each, camera on a circle; script = performance.now() around `renderer.render()` (dev page not cross-origin isolated: 0.1 ms clock, so only means are usable), GPU = median EXT_disjoint_timer_query time per frame. One run each with other agents active: treat a single GPU number as +-30 %. Output was printed, not saved; values copied from the session log.

## Visual guard
`visual.py` 270ddf3 vs b3ab144, Chrome: 18/18 scenes 0.0000 % over threshold, max 0, any 0.000 % (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F2/visual.json`). Extra scenes (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-extra.py`, same capture and diff code, Chrome): 5k soft-clay/lifted-arcs/paper-quilling at zoom 0.35, 5k soft-clay zoom 1, 20k clean and rope zoom 1: all 0.0000 %, max 0, any 0.000 % (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F2-extra/visual.json`). WebKit visual guard: not run (killed by the pause).

## Surprises
Identical pixels including the "any difference" column, so the interpolated alpha really is 1.0 on this GPU.
