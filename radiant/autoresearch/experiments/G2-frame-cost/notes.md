# G2: what GPU-expanded branches cost per frame, and what they save per rebuild (measurement of G1)

Commit: notes, probe scripts and raw data only (no code). Measures G1 (3d0f7f4) against its parent e2d9186.

## Method
`probe/g2probe.py` + `probe/g2page.js`: serves the two production builds that `visual.py` made (VITE_RADIANT_BENCH=1,
copied to `scratchpad/ar/gpu/builds/{parent,g1}`) with COOP/COEP headers, one fresh browser context per run, viewport
1728 x 1117 at DPR 2, reduced motion; 3 rounds, sizes 5k/20k/50k, builds interleaved A B / B A per size and round
(18 runs per engine). Per run: `loadSynthetic(n, 'clean')` to settled; one `addChild` on the middle depth-3 node to
settled; then at four cameras (fit; zoom 0.35, 1 and 4 centred on the middle depth-2 node) 10 warm-up and 60 measured
frames, each `renderer.setCamera` (a small circle) + `renderer.render()` + `gl.readPixels(1 px)`. Reported per frame:
GPU time from EXT_disjoint_timer_query_webgl2 (Chrome only, via the bench adapter's gpuTimer), wall time from before
render() to after the 1-pixel readPixels (both engines: WebKit has no GPU timer, so this is its GPU-inclusive number; it
also includes the readback round trip), and main-thread script. Frames back to back are "moving" frames (no MSAA, F5).
Values are the median over the 3 rounds of each round's median; per-round values are in the JSON. Other agents used
the machine meanwhile (two `measure.py` runs held the lock before and after), so spreads of 5-15 % are expected.

## Results, Chrome (GPU timer)
| | 5k parent | 5k G1 | 20k parent | 20k G1 | 50k parent | 50k G1 |
|---|---:|---:|---:|---:|---:|---:|
| worker branch mesh, load (ms) | 10.4 | 4.0 | 21.5 | 6.8 | 52.5 | 11.7 |
| worker branch mesh, one edit (ms) | 6.9 | 2.2 | 25.4 | 6.6 | 93.0 | 10.0 |
| edit to settled (ms) | 149 | 132 | 313 | 248 | 795 | 580 |
| load to settled (ms) | 165 | 149 | 398 | 364 | 915 | 782 |
| WebGL buffers (MB) | 11.8 | 0.22 | 43.4 | 0.65 | 104.6 | 1.50 |
| + record texture (MB, not in the line above) | - | 0.63 | - | 2.47 | - | 6.13 |
| GPU ms/frame, fit | 0.41 | 0.52 | 0.61 | 1.08 | 1.08 | 2.17 |
| GPU ms/frame, zoom 0.35 | 0.37 | 0.39 | 0.43 | 0.44 | 0.56 | 0.59 |
| GPU ms/frame, zoom 1 | 0.35 | 0.36 | 0.43 | 0.43 | 0.57 | 0.58 |
| GPU ms/frame, zoom 4 | 0.34 | 0.35 | 0.48 | 0.48 | 0.77 | 0.79 |
| triangles submitted, fit | 65 k | 169 k | 237 k | 688 k | 574 k | 1,723 k |
| triangles submitted, zoom 1 | 8.3 k | 10.8 k | 30.8 k | 36.8 k | 89 k | 103 k |
| main-thread ms/frame (render()), fit | 0.12 | 0.16 | 0.16 | 0.16 | 0.20 | 0.19 |

## Results, WebKit (readPixels-synchronised wall ms per frame; no GPU timer)
| | 5k parent | 5k G1 | 20k parent | 20k G1 | 50k parent | 50k G1 |
|---|---:|---:|---:|---:|---:|---:|
| worker branch mesh, load (ms) | 15.2 | 4.7 | 36.7 | 12.7 | 65.5 | 21.0 |
| worker branch mesh, one edit (ms) | 6.3 | 2.8 | 15.7 | 6.6 | 32.8 | 10.7 |
| edit to settled (ms) | 132 | 132 | 250 | 232 | 615 | 479 |
| load to settled (ms) | 166 | 150 | 416 | 366 | 945 | 840 |
| wall ms/frame, fit | 0.90 | 1.10 | 1.40 | 1.78 | 1.84 | 3.02 |
| wall ms/frame, zoom 0.35 | 0.92 | 1.04 | 1.22 | 1.14 | 1.36 | 1.38 |
| wall ms/frame, zoom 1 | 0.92 | 0.86 | 1.08 | 0.98 | 1.18 | 1.18 |
| wall ms/frame, zoom 4 | 0.94 | 0.88 | 1.18 | 1.14 | 1.28 | 1.44 |

## Reading
- Rebuild side, as hoped: the worker's branch-mesh step is 3-9x cheaper (it now only fills records), nothing is packed,
  the transfer is ~6 MB instead of ~100 MB at 50k, the upload is a texture of 128 B per branch, and WebGL buffer memory
  drops from 105 MB to 1.5 MB (+ 6.1 MB texture) at 50k. Edit to settled at 50k: -27 % (Chrome), -22 % (WebKit).
- Frame side: at zoom 0.35, 1 and 4 the GPU path costs the same as the static mesh within noise (Chrome GPU +1 to +5 %,
  WebKit wall time -10 to +13 % with no consistent sign). The vertex shader's work (7 texel fetches, a cubic and a
  normalise per vertex) is not what limits these frames.
- The loss is at the whole-map view: 1.3x (5k) to 2.0x (50k) GPU time in Chrome, +0.2 to +1.2 ms wall in WebKit. Cause:
  below zoom 0.02 the strips are coarse (F4's rules) but the fixed pieces are not: each branch still has a 5-point fan
  cap, an underline and 4 break points, so a typical coarse branch is 13 quads = 2 chunks of 8 = 32 triangles, against
  ~11 triangles in F4's coarse index buffer (3.0x the triangles at 50k). At full detail the same overhead is +13 to
  +30 % triangles (start cap as a fan with an empty triangle per step, breaks, chunk padding).
- Segment count: G1 keeps the CPU rule (chord error 0.25 px at zoom 4, the same n as the CPU mesh, 7-96 segments per
  branch, mean 27-31) so the pictures match. At close zoom only a few hundred branches are visible, and zoom 4 costs
  the same as the static mesh, so choosing more segments by zoom would not be expensive, and fewer by zoom only matters
  where many branches are visible (far zoom, already coarse). The lever is the per-branch overhead, not N: see G3.
- Not measured: mid zooms (0.02-0.3) at 50k, where every branch is drawn at full detail; animations (fold with motion
  on uses CPU-tessellated animation frames, unchanged); the record texture is not in `gpu_buffer_mb`.

## Verdict
G1's trade is real on both sides: large rebuild/edit and memory gains on flat maps; per-frame cost unchanged at working
zooms and up to 2x GPU at the whole-map view of big maps (still 2.2 ms at 50k in Chrome, well inside the 8.3 ms frame).
Next (G3): make the fixed pieces part of the strip so the whole-map view stops paying for them.
