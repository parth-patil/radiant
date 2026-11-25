# L3: skip the label loop when every label is too small, and make stats.labelsPending true

## Hypothesis
At the whole-map view of a big map every label is in the visible set and every one is below the 0.65 px skip size, yet
`drawLabels` visits all of them each frame (0.3 ms at 50,000 nodes, study 02). Knowing the largest font size in the scene
lets the renderer skip the loop in one comparison. Metric: `pan_cpu_mean@50k/*/fit` (and @5k/fit, where labels are also
below 0.65 px). Second part: `stats.labelsPending` was always 0 because `LabelAtlas.process` empties its queue before
`render()` read `pendingCount`.

## Change (src/lib/render/renderer.ts, label section and the stats lines of render())
- When the scene's label arrays change (`sceneDirty`), record the largest `fontSize` and whether any label is an overview
  title or picture title (those are drawn at a fixed screen size, so they cannot be skipped this way).
- `drawLabels` returns at once when there is no such label and `maxFont * zoom < 0.65`: exactly the case in which the old
  loop skipped every label, so nothing drawn changes.
- `stats.labelsPending` is reset at the start of each frame and counts what `process()` left in the queue plus labels that
  missed their layout deadline (drawn as placeholder bars). `LabelAtlas.pendingCount` is no longer read.

## Why fixing labelsPending does not change the benchmark's timings
`Renderer.idle` (read by `__radiantBench.idle()`) is `!raf && labelsPending === 0 && imagesLoading === 0`. Whenever the new
count is above 0, `drawLabels` also returned `more = true`, so `render()` called `requestFrame()` and `raf` is non-zero:
idle is false in both versions. When the count is 0 the two expressions are the same. So idle() is true on exactly the same
frames as before; only the stat itself is now truthful (probe: after a jump in WebKit it reads 347, 180, 28, 0 over the frames
where text fills in, where it read 0, 0, 0, 0 before). The one case where the count stays 0 although labels are missing is
unchanged from before: the atlas is full (`process` returns 0 and stops trying for the frame).

## Targeted probe (abprobe.py + fitlabels.js, production builds, parent c64371a vs candidate, interleaved, 2 rounds)
50,000 nodes, clean, whole map in view (zoom 0.0026), 120 frames moving the camera on a small circle:

| | Chrome A | Chrome B | WebKit A | WebKit B |
|---|---|---|---|---|
| drawLabels ms per frame | 0.251, 0.381 | 0.0007, 0.0003 | 0.353, 0.385 | 0.0014, 0.0020 |
| render() mean ms | 2.61, 2.79 | 2.45, 2.37 | 1.25, 1.36 | 0.95, 1.06 |

Raw: scratchpad/ar/labels/L3-fit.json.

## Screening (quick, 1 round, parent = c64371a (L2); raw: quick.json)
| metric | Chrome A -> B | ratio | WebKit A -> B | ratio |
|---|---|---|---|---|
| pan_cpu_mean@50k/clean/fit | 3.544 -> 3.289 | 0.93 | 1.849 -> 1.720 | 0.93 |
| pan_cpu_mean@50k/rope/fit | 4.568 -> 3.532 | 0.77 | 2.085 -> 1.729 | 0.83 |
| pan_cpu_mean@5k/clean/fit | 0.712 -> 0.572 | 0.80 | 0.468 -> 0.400 | 0.85 |
| pan_cpu_mean@5k/rope/fit | 0.647 -> 0.554 | 0.86 | 0.596 -> 0.508 | 0.85 |
| pan_cpu_mean@50k/clean/z0.35 (code not exercised) | 0.451 -> 0.462 | 1.02 | 0.738 -> 1.029 | 1.39 |
| FRAME sub-score | 1.90 -> 1.61 | 0.85 ?faster | 1.23 -> 1.13 | 0.92 ~ |
| SCORE | 63.13 -> 59.64 | 0.94 ~ | 57.43 -> 55.52 | 0.97 ~ |

The fit improvements match the probe (0.25 to 0.38 ms removed per frame); the 50k rope/fit drop in Chrome (1 ms) is more than
the change can explain and is partly noise. WebKit z0.35 +39 % is noise: that path is unchanged (labels there are 5 px and
take the normal loop). One round; unproven single metrics.

## Visual guard
`visual.py` Chrome against c64371a: 18 scenes, 0 differing pixels, max 0 (`scratchpad/ar/labels/visual-L3`). Not run in
WebKit (the change is engine-independent JavaScript and does not touch what is drawn).

## What I did not do
"Spend the budget better": after L2, text fills in within 3 frames (Chrome) and 6 frames (WebKit) after a jump at 60 Hz;
I found nothing cheap that would beat that without exceeding the frame budget, so the budget is unchanged.
The whole-map view still pays for `viewport.query` returning all 50,000 label indices (about 1 ms at 50k, study 02); that is
in scene-viewport.ts, shared with rects and images (frame track), so I left it.

## Verdict
Keep. Small, exact, removes 0.25 to 0.4 ms per whole-map frame at 50k in both engines and fixes a misleading stat.
