# L2: rasterise a frame's labels on one staging strip and upload them as a batch

## Hypothesis
In WebKit, drawing a label costs 0.43 to 0.61 ms (Chrome 0.01 ms) because each label is drawn on an accelerated 2D
canvas and copied with `texSubImage2D(canvas)`, which makes WebKit read the canvas back from the GPU on every call
(study 02, section 3 and proposal 4). If all labels rasterised in a frame are drawn side by side on one staging canvas
and copied afterwards, WebKit pays the readback once per batch. Metrics that should move: WebKit zoomed-in panning
(`pan_cpu_mean@*/z0.35`, `/z1.0`) and the number of frames text takes to fill in; Chrome should not get slower.

## What I tried first, and why this design
Study 02 proposed a CPU canvas (`willReadFrequently`) + `getImageData` + byte upload, chosen per engine by timing.
I measured it (`scratchpad/ar/labels/pixeq.js`): it is not pixel-identical. CPU and GPU canvases rasterise glyph edges
1 to 3 levels apart, and the getImageData un-premultiply/premultiply round trip adds more: 1,277 to 9,264 differing
channel values per label image (max 2/255 WebKit, 3/255 Chrome). The batch keeps the GPU canvas and the canvas upload
path, so the texels are the same; `batcheq.js` checked 60 labels (italic, bold, emoji, fractional positions, 7 sizes):
0 differing bytes in both engines. It also needs no engine detection: one path, both engines.
Micro-benchmark (`upl.js`, 120 labels, ms per label including a final readPixels): per-label canvas upload
Chrome 0.22 to 0.53, WebKit 0.32 to 1.79; batched canvas upload Chrome 0.04 to 0.12, WebKit 0.05 to 0.13.
`stripsize.js` showed WebKit's readback reads the whole staging canvas: about 0.4 ms + 1 ms per MB (2048x512: 2.2 ms per
flush even for 3 labels; 512x128: 0.6 ms). So the strip size is chosen per batch.

## Change (src/lib/render/text.ts only)
- `LabelAtlas.rasterize` draws into a cell of a staging strip (clipped to the cell, translated to it) instead of a
  per-label staging canvas, and queues an upload record; the slot is created as before.
- `flush()` uploads the queued cells with `UNPACK_SKIP_PIXELS/ROWS` (reset to 0 afterwards), grouped by page, then clears
  the used part of the strip. `process()` flushes once at the end of the frame's batch (and mid-batch when the strip is full).
- Three strip sizes (512x128, 1024x256, 2048x512, created lazily); each batch uses the smallest that holds the queued
  cells with 40 % slack; a label bigger than all of them gets its own strip.
- The time budget keeps back the expected upload cost (running average per strip size, at most half the budget), since
  the upload now happens after the drawing loop.
First version (one 2048x512 strip, no reserve) filled text in 4 frames in WebKit but overshot the 4 ms budget to 6.6 ms;
second version (reserve per label) made it 27 frames (the readback is a fixed cost, not per label). Raw: L2-sweep.json,
L2-sweep2.json in scratchpad/ar/labels.

## Targeted probe (abprobe.py + sweep.js on production bench builds, parent a8a3a00 vs candidate, interleaved, 2 rounds)
20,000 nodes, clean, 60 Hz budget (4 ms). "Sweep": zoom 0.15 -> 2.0 over 90 frames on the densest area (127 nodes at zoom 1);
"jump": move to a fresh area at zoom 0.35 (483 nodes) and render until no label work is left. Per-frame ms of render().

| | Chrome A | Chrome B | WebKit A | WebKit B |
|---|---|---|---|---|
| sweep mean ms | 0.825, 0.864 | 0.635, 0.704 | 3.515, 3.340 | 1.584, 1.783 |
| sweep p95 ms | 4.41, 4.33 | 3.53, 3.76 | 4.80, 4.48 | 5.58, 5.24 |
| sweep max ms | 4.6, 4.8 | 5.2, 5.8 | 5.8, 5.8 | 7.6, 12.7 |
| jump: frames until all text | 3, 3 | 3, 3 | 53, 52 | 6, 6 |
| jump: total ms | 10.9, 11.3 | 10.1, 10.7 | 224, 220 | 27.4, 25.1 |

WebKit: text appears in 6 frames instead of 52 to 53 (about 0.1 s instead of 0.9 s at 60 Hz), with 8x less total main-thread
time. Costs: p95 of the zoom sweep goes up in WebKit (5.2 to 5.6 ms against 4.5 to 4.8) and single frames reach 7.6 to 12.7 ms:
the upload estimate is a running average and a batch can cost more than it predicts. Raw: L2-sweep3.json.

## Screening (quick, 1 round, parent = a8a3a00 (L1a); raw: quick.json)
| metric | Chrome A -> B | ratio | WebKit A -> B | ratio |
|---|---|---|---|---|
| pan_cpu_mean@50k/clean/z0.35 | 0.459 -> 0.514 | 1.12 | 1.428 -> 0.820 | 0.57 |
| pan_cpu_mean@50k/rope/z0.35 | 0.507 -> 0.533 | 1.05 | 1.378 -> 0.876 | 0.64 |
| pan_cpu_mean@50k/clean/z1.0 | 0.343 -> 0.390 | 1.14 | 0.747 -> 0.659 | 0.88 |
| pan_cpu_mean@50k/clean (pooled) | 1.42 -> 1.57 | 1.10 ?slower | 1.33 -> 1.12 | 0.84 ?faster |
| pan_cpu_mean@50k/rope (pooled) | 1.66 -> 1.85 | 1.12 ?slower | 1.39 -> 1.19 | 0.85 ?faster |
| pan_cpu_mean@50k/clean/fit (no label is rasterised here) | 3.455 -> 3.796 | 1.10 | 1.827 -> 1.882 | 1.03 |
| FRAME sub-score | 1.54 -> 1.83 | 1.19 ?slower | 1.28 -> 1.21 | 0.94 |
| SCORE | 58.64 -> 63.69 | 1.09 ~ | 58.66 -> 56.10 | 0.96 ~ |

Chrome's "?slower" is not credible as an effect of this change: at fit no label is rasterised (all are below 0.65 px and
skipped before the atlas is touched) and the code path is identical, yet fit got 10 % slower too, and Chrome's GPU time went
up 27 to 80 % on every scenario, which no text change can cause; the B half of the Chrome run evidently ran on a busier
machine (the lock queue had other agents' runs on both sides). The interleaved Chrome probe above (2 rounds) shows Chrome
sweep frames getting cheaper (mean 0.84 -> 0.67 ms, p95 4.4 -> 3.6 ms). Needs the lead's 3-round run to settle Chrome.

## Visual guard
`visual.py` against a8a3a00: Chrome 18 scenes and WebKit 18 scenes, 0 differing pixels, max difference 0, "any" 0.000 %
(`scratchpad/ar/labels/visual-L2`, `visual-L2-webkit`).

## Verdict
Keep. A large WebKit win where it matters (zoomed-in views, text pop-in 52 -> 6 frames), pixel-identical, no engine
sniffing. Open question: Chrome's quick-run frame numbers (believed noise, see above).
