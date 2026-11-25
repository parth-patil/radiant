# D4: reuse the dimensional shadow layer on frames at rest

## Hypothesis
The half-resolution shadow layer (clear, all visible branch shadows drawn with MAX blending, one composite) is redrawn on
every frame. Frames drawn with the camera still (the multisampled frame after every movement, label rasterisation over
several frames, hover and selection redraws) draw exactly the same shadows, so keeping the layer when the camera, view,
static and animated meshes and their drawn index counts are unchanged should save the shadow pass (0.3-1.1 ms of GPU in
D1's attribution) on those frames, with identical pixels. The other two D4 items in the brief were already in place:
the layer only draws the visible (culled) runs, and it is skipped below the zoom where it fades out (alpha <= 0).
Benchmark metrics: none expected (every pan frame moves the camera); a targeted probe of frames at rest instead.

## What changed (reverted in the next commit)
`src/lib/render/renderer.ts`: the shadow layer remembers what it was drawn for (`ShadowLayerKey`: camera, CSS view size,
static mesh object and its coarse-LOD flag, index counts drawn, animated mesh object); `drawShadowLayer` returns early
when they match; resizing or recreating the layer forgets it.

## Correctness
- bun run check 0/0, check-boundaries exit 0, check-browser all PASS (dev server :1443).
- `tools/d4check.py` (dev server, 5k, Chrome and WebKit, four dimensional themes, zoom 0.35/1/2): after a 12-frame pan
  that ends where it started, the resting frame (layer reused) and a frame with the layer forced to redraw read back
  byte-identical (0 differing bytes in all 24 cases).
- visual.py was queued but not run before the deadline (lock queue); killed when the experiment was discarded.

## Numbers
`tools/d4gain.py`: dev server, Chrome, 20k, 40 frames at rest per sample drawn with `renderer.render()` at a fixed
camera, GPU time per frame (EXT_disjoint_timer_query) with the layer reused vs forced to redraw, alternated, 3 samples
each (`rest-gpu-chrome-20k.txt`):

| theme / zoom | reuse (D4) | redraw (before) |
|---|---|---|
| soft-clay 0.35 | 2.89, 3.08, 3.47 | 2.49, 2.53, 2.04 |
| soft-clay 1.0 | 3.00, 3.28, 2.85 | 2.71, 2.68, 3.14 |
| lifted-arcs 0.35 | 3.32, 3.16, 3.35 | 1.92, 2.03, 1.98 |
| lifted-arcs 1.0 | 3.52, 2.99, 3.50 | 4.34, 2.32, 2.82 |
| rope 0.35 | 4.82, 5.50, 5.41 | 2.45, 2.45, 4.38 |
| rope 1.0 | 4.44, 5.81, 5.33 | 4.18, 2.09, 4.02 |
| paper-quilling 0.35 | 3.75, 3.66, 4.00 | 2.63, 3.60, 2.72 |
| paper-quilling 1.0 | 3.74, 3.36, 3.67 | 2.55, 3.45, 3.92 |

Skipping the shadow pass did not make resting frames cheaper on the GPU timer; in most rows they measured slower. I did
not find out why in the time left (a guess, not verified: with the separate pass gone, the frame's single render pass
starts while the previous frame's work is still in flight and the timer query spans the wait). Either way the premise,
that the shadow pass is a cost worth caching, is not supported by this measurement. Not measured: WebKit (no GPU timer).
measure.py was not run (no expected effect on its scenarios; lock queue of 20-40 minutes).

## D5 checked and dropped (no code)
`tools/lodcheck.py` (dev server, 20k, Chrome, whole-map view after the coarse buffer is built): round 1's far-zoom
coarse index buffer (F4) already covers every dimensional mesh, because ribbons, quilled walls and their fans use the
same index patterns it parses: triangles drawn coarse/full clean 237k/1.26M, soft-clay 250k/1.37M, lifted-arcs
327k/1.47M, rope 428k/1.62M, paper-quilling 266k/1.66M; ribbons are under 0.1 px wide there, so the flat program draws
them (quilling uses its own program with u_far). D1's attribution puts the whole-map dimensional GPU cost in the
rectangles (node shadows and clay tablets), not the branch mesh (rope fit 0.46 ms vs clean 0.41 ms). Not worth an
experiment.

## Verdict
discard: identical pixels, but no GPU saving measured on resting frames (if anything a loss), and nothing the benchmark
measures. Reverted in the next commit.
