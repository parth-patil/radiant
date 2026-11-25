# F5: no multisampling while the camera keeps moving; a full 4x MSAA frame once it stops

Commit a1823d8 (parent 9e9b2a6). Verdict: **keep** (resting picture identical in Chrome; moving frames lose antialiasing by design; WebKit resting picture identical too).

## Hypothesis
At DPR 2 the implicit 4x MSAA of the canvas (`antialias: true`) sets a GPU floor of about 1 ms and multiplies every fragment (study 02: up to 60 % less GPU without it, at the price of slightly jagged edges). If frames drawn while the camera keeps moving skip MSAA and a full-quality frame is drawn as soon as it stops, panning gets cheaper on the GPU while the resting picture stays exactly what it was. Metric: `pan_gpu_mean` (Chrome; WebKit has no GPU timer). Pan CPU should not change; latency metrics should not change (a single camera jump keeps full quality, see below).

## What changed
`src/lib/render/renderer.ts`:
- The context is created with `antialias: false`; multisampling is our own 4-sample RGB8 renderbuffer (`ensureMsaa`, `min(4, MAX_SAMPLES)` samples, canvas size), resolved into the canvas with `blitFramebuffer` at the end of each full-quality frame. RGB8 because the canvas is `alpha: false` and a multisampled blit needs identical formats.
- `setCamera`: a change within `MOVING_MS` = 120 ms of the previous one marks the camera as moving. A single jump (fit, go to node, the benchmark's `setCamera` before an action) is drawn at full quality right away.
- A moving frame draws straight into the canvas without MSAA and arms a 120 ms timer; when it fires (no camera change in between) one full-quality frame is drawn. `idle` is false while the timer is armed, so benchmarks and `__radiantBench.idle()` wait for that frame.
- The dimensional shadow layer pass rebinds the frame's target instead of the canvas.

## What the user sees differently, and when
- At rest: intended to be identical (same 4 samples, box resolve). See the guard.
- While the camera keeps moving (pan, zoom gesture, animated camera): no antialiasing, so curve edges and text-quad edges stair-step at device-pixel scale (study 02 measured 0.1 to 0.4 % of pixels differing by up to 130/255 at 50k without MSAA). Up to 120 ms after the last camera change the last moving frame stays on screen, then the antialiased frame replaces it (a subtle edge "settle").

## Numbers
Probe of moving frames after F5, 50k, script mean ms / GPU median ms, compared with the F2/F3 probes:

| theme | fit | zoom 0.35 | zoom 1 |
|---|---|---|---|
| clean | 0.69 / 1.12 (F2: 1.40) | 0.49 / 0.57 (F2: 1.22) | 0.22 / 0.75 (F2: 1.12) |
| rope | 0.64 / 1.16 (F2: 2.15) | 0.35 / 1.48 (F2: 2.19) | 0.20 / 1.07 (F2: 2.20) |
| soft-clay | 0.36 / 2.17 (F3: 6.16) | 0.29 / 0.61 (F3: 2.51) | 0.18 / 0.73 (F3: 2.20) |

These were measured on the first version of this commit, whose full-quality frames were black (see Surprises); the moving frames, which are what the probe times, drew to the canvas the same way as in the final version. The resting-frame cost (explicit MSAA target plus blit versus the browser's implicit one) was not measured.

Benchmark screening: not done (killed by the pause; the lead measures the commit officially).

Probe method: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/probe.py`, headless Chrome (Metal ANGLE), DPR 2, 1728 x 1117, against my own Vite dev server on port 1431 serving the worktree at that point; `?demo=big&n=50000`; per theme three camera positions (fit, densest view at zoom 0.35, densest at zoom 1); 30 warm-up + 60 measured frames each, camera on a circle; script = performance.now() around `renderer.render()` (dev page not cross-origin isolated: 0.1 ms clock, so only means are usable), GPU = median EXT_disjoint_timer_query time per frame. One run each with other agents active: treat a single GPU number as +-30 %. Output was printed, not saved; values copied from the session log.

## Visual guard
`visual.py` 9e9b2a6 vs a1823d8 (final version, RGB8 target), Chrome: 18/18 scenes 0.0000 % over threshold, max 0, any 0.000 % (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F5/visual.json`). visual.py captures after `idle()`, i.e. the full-quality frame: so the explicit 4-sample target plus blit resolve reproduces the browser's implicit MSAA bit for bit in Chrome. Moving frames are not captured by visual.py; their difference (no antialiasing) is by design and was described above, not measured on this commit. WebKit (`--engine webkit`): 18/18 scenes 0.0000 %, max 0, any 0.000 % as well (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F5-webkit/visual.json`).

## Surprises
- My first version allocated the multisampled renderbuffer as RGBA8. Against the `alpha: false` canvas the resolve blit is INVALID_OPERATION, so every resting frame stayed black: `visual.py` showed 93 to 98 % of pixels differing in all 18 scenes (that run's output was deleted when I re-ran the guard; the black capture is kept as `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/f5B.png`). My dev-server probe had not caught it because it times moving frames and never read pixels. Switching to RGB8 fixed it, checked with `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/blitcheck.py` (no GL error, correct pixel, in Chrome and Playwright WebKit), and the fix was folded into this commit before anything else was measured.
- `preserveDrawingBuffer` is false; the resolve happens inside the same task as the draw, so compositing sees the resolved frame.
