# F6: quarter-resolution dimensional shadow layer while the camera keeps moving

Commit 726e12e (parent 4440c91), reverted by 74f9878. Verdict: **discard**.

## Hypothesis
The dimensional shadow layer (half-resolution R8 target, MAX blending, one composite) cost 0.3 to 1.1 ms of GPU at DPR 2 in study 02. Drawing it at quarter resolution only on frames where the camera keeps moving (the frames F5 already draws without MSAA), and at half resolution at rest, should save GPU time while panning in rope, soft-clay and lifted-arcs, with the resting image unchanged. Metric: `pan_gpu_mean` for the dimensional themes (Chrome).

## What changed (reverted)
`src/lib/render/renderer.ts`: two shadow layers (half and quarter resolution), `ensureShadowLayer(quick)` picks the quarter one when the frame's target is the canvas (moving frame, F5). The composite samples by normalised screen position, so it needed no change.

## Numbers
Targeted in-page A/B (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/ab-shadow.py`): 20k nodes, Chrome, dev server on port 1431 at F4 + F6, densest views at zoom 0.35, 1 and 2.5; per view three rounds alternating "half" (old behaviour forced by patching `ensureShadowLayer`) and "quarter", 60 moving frames each; GPU median ms per round:

| theme / zoom | half (old) | quarter (F6) |
|---|---|---|
| rope 0.35 | 1.21, 0.55, 0.50 | 0.78, 0.77, 0.53 |
| rope 1 | 0.81, 0.86, 0.86 | 0.62, 0.62, 1.09 |
| rope 2.5 | 0.70, 0.65, 0.60 | 0.57, 0.55, 0.54 |
| soft-clay 0.35 | 1.20, 1.66, 1.66 | 0.88, 1.50, 0.74 |
| soft-clay 1 | 2.04, 1.05, 0.90 | 0.71, 1.96, 2.22 |
| soft-clay 2.5 | 2.59, 2.57, 2.60 | 2.58, 1.66, 2.64 |
| lifted-arcs 0.35 | 0.74, 0.83, 0.83 | 0.49, 0.59, 0.55 |
| lifted-arcs 1 | 1.45, 1.44, 1.04 | 1.40, 0.89, 1.39 |
| lifted-arcs 2.5 | 1.26, 1.21, 1.96 | 1.16, 1.52, 0.98 |

At most about 0.1 to 0.25 ms, and in most rows the rounds overlap. Once F5 removed MSAA from moving frames the shadow layer is a small part of the GPU frame, so there is little left to win.

## Why discarded
No gain beyond the noise in the targeted A/B, and it costs something visible: the shadow under every dimensional branch gets blurrier during a pan and sharpens when the camera stops (a quality change while moving, for nothing measurable). I did not run measure.py or visual.py on it: the targeted A/B already showed no gain, and the bench lock was saturated.
