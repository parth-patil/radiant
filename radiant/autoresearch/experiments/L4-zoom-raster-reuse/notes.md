# L4: reuse a label raster one zoom bucket away while the zoom is changing

## Hypothesis
Labels are rasterised per zoom bucket (powers of sqrt 2 in texels per world unit). During a zoom gesture every bucket
crossing re-rasterises the whole visible set, which brings back a 4 to 5 ms frame every few frames (study 02, zoom sweep).
If, while the zoom is changing, a label that already has a raster one bucket away draws that raster scaled, the gesture
re-rasterises half as often; the exact raster is made on the first frame after the zoom stops. Metric: frame time during a
zoom sweep (targeted probe). The benchmark's pan path only zooms +-8 % (a bucket is 41 %), so it should barely move.

## Change (src/lib/render/renderer.ts, drawLabels only)
- `drawLabels` keeps the zoom of the previous frame and the direction it changed in this frame (once per frame; the first
  frame after construction counts as not zooming).
- While the zoom changes, a label without a raster at the wanted bucket but with one at most one bucket away does not
  request a new raster; it is drawn from the nearest one (the existing `best()` fallback, which prefers the larger raster)
  and `more` is set so one more frame is drawn. On that frame the zoom has not changed, the exact bucket is requested and
  rasterised under the normal budget. Overview titles are unchanged. With no zoom change (panning, edits, theme switches,
  the first frame after a jump) behaviour is exactly as before.

## What the user sees
During a zoom gesture, labels whose raster is one step off are shown scaled by up to sqrt 2: up to 1.41x enlarged (slightly
soft) when zooming in, or shrunk (slightly thinner, crisper anti-aliasing) when zooming out, for as long as the zoom keeps
moving within that step. Labels more than one step off are re-rasterised as before. One frame after the zoom stops (about
8 to 17 ms), every label is redrawn from an exact raster, so at rest the image is identical to before. Before this change the
same scaled rasters were already shown during zooms whenever the 4 ms budget ran out, so the kind of artefact is not new;
it is now chosen rather than incidental.

## A first variant that was rejected (on record)
Variant 1 also rasterised missing labels one bucket ahead in the zoom's direction (so a raster serves three buckets).
Sweep probe: Chrome p95 3.55 -> 1.40 ms, WebKit mean 1.71 -> 1.18 ms. But the visual guard showed at-rest differences: 1 to 91
pixels per scene with max 1 to 14 (Chrome 9 scenes, WebKit 4; scratchpad/ar/labels/visual-L4, visual-L4-webkit), because the
ahead rasters change the atlas packing and a label quad's edge then samples a different neighbour (one stray dot 14/255
next to a label in map60-rope-dark-zoom2; crop-AB.png there). So the ahead request was removed; this commit is variant 2.
That stray dot is a pre-existing hazard (atlas edge bleed that depends on packing), not caused by the label code itself.

## Targeted probe (abprobe.py + sweep.js, production builds, parent 3ca6847 vs candidate, interleaved, 2 rounds)
20,000 nodes, clean, 60 Hz budget; zoom 0.15 -> 2.0 over 90 frames, render() ms per frame:

| | Chrome A | Chrome B | WebKit A | WebKit B |
|---|---|---|---|---|
| sweep mean | 0.632, 0.624 | 0.536, 0.529 | 1.465, 1.672 | 1.248, 1.158 |
| sweep p95 | 3.64, 3.44 | 1.82, 1.77 | 5.20, 5.02 | 4.50, 5.20 |
| sweep max | 5.82, 5.85 | 5.87, 5.77 | 7.0, 16.1 | 15.4, 8.0 |
| frames to settle after the sweep | 1, 1 | 1, 1 | 1, 1 | 1, 1 |
| jump to a new area: frames until all text | 2, 2 | 2, 2 | 5, 5 | 5, 5 |

Chrome: the frames that re-rasterise during a zoom are halved (p95 3.5 -> 1.8 ms, mean -15 %). WebKit: mean -24 %, p95 and
max unchanged within noise (after L2 the WebKit batch costs are dominated by the per-batch readback, which still happens
on the crossings that do rasterise). Raw: scratchpad/ar/labels/L4b-sweep.json (variant 1: L4-sweep.json).

## Screening (quick, 1 round, parent = 3ca6847 (L3); raw: quick.json = L4b-quick.json)
| metric | Chrome A -> B | ratio | WebKit A -> B | ratio |
|---|---|---|---|---|
| pan_cpu_mean@50k/clean/z0.35 | 0.461 -> 0.438 | 0.95 | 0.852 -> 0.807 | 0.95 |
| pan_cpu_mean@50k/clean/z1.0 | 0.356 -> 0.365 | 1.03 | 0.776 -> 0.653 | 0.84 |
| pan_cpu_mean@5k/clean/z1.0 | 0.254 -> 0.293 | 1.15 | 0.327 -> 0.395 | 1.21 |
| FRAME | 1.74 -> 1.66 | 0.96 ~ | 1.17 -> 1.14 | 0.97 ~ |
| SCORE | 65.69 -> 64.94 | 0.99 ~ | 59.16 -> 56.88 | 0.96 ~ |

As expected the benchmark does not exercise this (its +-8 % zoom rarely crosses a bucket); all differences are within the
one-round noise, in both directions (edit_ms@50k: Chrome 1.24x slower, WebKit 0.65x faster, same code path: noise).

## Visual guard
Variant 2 against 3ca6847: Chrome and WebKit, 18 scenes each, 0 differing pixels, max difference 0 in every scene
(`scratchpad/ar/labels/visual-L4b`, `visual-L4b-webkit`). The guard captures at rest; the during-zoom look described above
is not captured by it.

## Verdict
Keep, on the targeted probe only (the benchmark is neutral by construction). It is a visual trade-off during zoom gestures,
described above; if the owner prefers exact text at every zoom frame, discard it.
