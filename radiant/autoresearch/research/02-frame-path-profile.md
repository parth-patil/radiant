# 02. Frame path profile: what every drawn frame costs, and what to try

Author: frame-path research agent. Date: 2026-11-25. Read-only study: no source file was changed.
Measured against the main working tree as served by the Vite dev server at 127.0.0.1:1420 (HEAD 5450267; the only
uncommitted change in `src/lib/render` during the runs was a new `Renderer.idle` getter, which does not touch the draw path).

Scripts and raw data: `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame-path/`
(`bench.py` + `bench-page.js` main matrix, `ab.py` GPU A/B, `proto.py` in-page prototype of proposal 1, `overdraw.py`,
`sweep.py` zoom sweep, `tight.py`, `textmicro.py`, `profile.py`, `wkgpu.swift`; every `*.json` holds the full per-run data).

## How this was measured

- Headless Chrome 158 (channel chrome, `--use-angle=metal --enable-gpu`, renderer string "ANGLE Metal Renderer: Apple M4 Pro"),
  viewport 1728 x 1117 CSS px, device scale factor 2 (canvas 3456 x 2234) unless stated. Pages were made cross-origin
  isolated by adding COOP/COEP headers through Playwright routing, which gives `performance.now()` 5 us resolution instead of 100 us.
- Playwright WebKit (WebKit 27.2 build, JavaScriptCore) for the engine-specific checks. It has no WebGL timer query and only 1 ms
  timer resolution, so WebKit numbers are means of many frames or tight loops and are coarser. Playwright WebKit is not WKWebView;
  feature checks on the real WKWebView were done with a 30-line Swift program (`wkgpu.swift`, default WKWebViewConfiguration).
- Maps: `?demo=big&n=5000|20000|50000` (`loadSynthetic`). Themes clean, soft-clay, lifted-arcs, rope, paper-quilling.
  Zooms: whole map in view (fit, 0.0023 to 0.0136), 0.35, 1, 2.5. For the fixed zooms the camera is centred on the node box (from
  `pipeline.canvasLayout.boxes`) with the most boxes inside the viewport out of 40 evenly spaced candidates ("nodes in view" column).
- A frame = `renderer.setCamera(p)` + `renderer.render()` inside requestAnimationFrame, the camera moving on a 150 CSS px circle
  (40 px at fit). Per combination: 40 warm-up frames (label raster), 3 x 120 timed frames (script = performance.now() around render(),
  equal to `stats.cpuMs`), 120 frames with an `EXT_disjoint_timer_query_webgl2` TIME_ELAPSED query around each render() (GPU),
  60 instrumented frames (every WebGL call counted, render() sub-methods timed exclusively), and 120 "app" frames that move the real
  app camera (`__radiant.camera.set`) with CDP `Performance.getMetrics` ScriptDuration/TaskDuration deltas (includes Svelte overlays).
- Other agents used this machine (and its GPU) at the same time. Script timings repeat well (spread shown). GPU timings are noisier:
  the clean theme has no shadow layer, so its "shadow layer off" column is the identical configuration measured again, and it differs
  from the first measurement by up to 0.5 to 1 ms. Treat single GPU numbers as +-0.5 ms; the interleaved A/B runs (ABAB, 3 rounds,
  median of medians) are the reliable GPU evidence.
- Synthetic maps carry no pictures, so `images.ts` costs were not exercised (0.002 to 0.011 ms/frame, the empty loop).
- The synthetic map is tall and has a few nodes with thousands of "Extra" children. That shape drives the fan overdraw found below;
  real maps with wide fan-outs will see it, maps without will see less.

## 1. Frame cost by size, theme and zoom (Chrome, DPR 2)

Script = renderer.render() only. App = whole main thread per frame while the real camera moves (ScriptDuration / TaskDuration).
Triangles drawn counts every draw (shadow layer and lit pass both count the branch triangles; each instance counts 2).

| nodes | theme | zoom | nodes in view | script ms mean (spread of 3 runs) | script p95 | app script+task ms/frame | GPU ms median | GPU p95 | draws | triangles drawn | instances | KB uploaded/frame (of which indices) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5000 | clean | 1 | 45 | 0.096 (0.09–0.10) | 0.12 | 0.22 / 0.40 | 0.72 | 1.45 | 3 | 4,289 | 54 | 52 (49) |
| 5000 | clean | whole map (0.0136) | all | 0.409 (0.39–0.41) | 0.43 | 0.57 / 0.76 | 1.50 | 1.61 | 3 | 342,850 | 3 | 0 (0) |
| 5000 | clean | 0.35 | 243 | 0.149 (0.15–0.16) | 0.17 | 0.27 / 0.47 | 1.45 | 3.11 | 3 | 20,238 | 271 | 244 (231) |
| 5000 | clean | 2.5 | 19 | 0.081 (0.08–0.09) | 0.10 | 0.21 / 0.40 | 1.45 | 2.26 | 3 | 1,451 | 27 | 18 (16) |
| 5000 | soft-clay | 1 | 45 | 0.147 (0.14–0.23) | 0.19 | 0.29 / 0.53 | 1.73 | 5.40 | 7 | 9,721 | 156 | 64 (55) |
| 5000 | soft-clay | whole map (0.0136) | all | 0.691 (0.69–0.70) | 0.75 | 0.79 / 1.05 | 2.54 | 3.03 | 4 | 419,758 | 10,002 | 625 (0) |
| 5000 | soft-clay | 0.35 | 243 | 0.193 (0.19–0.19) | 0.23 | 0.36 / 0.60 | 3.00 | 5.27 | 7 | 46,908 | 804 | 311 (265) |
| 5000 | soft-clay | 2.5 | 19 | 0.135 (0.13–0.15) | 0.19 | 0.27 / 0.54 | 2.27 | 5.95 | 7 | 3,251 | 75 | 22 (18) |
| 5000 | lifted-arcs | 1 | 39 | 0.111 (0.11–0.11) | 0.13 | 0.27 / 0.51 | 1.41 | 2.51 | 7 | 7,945 | 131 | 53 (45) |
| 5000 | lifted-arcs | whole map (0.0112) | all | 0.739 (0.73–0.77) | 0.88 | 0.79 / 0.98 | 2.56 | 5.39 | 4 | 412,996 | 10,002 | 625 (0) |
| 5000 | lifted-arcs | 0.35 | 202 | 0.161 (0.16–0.18) | 0.19 | 0.28 / 0.46 | 1.59 | 3.42 | 7 | 39,125 | 666 | 260 (221) |
| 5000 | lifted-arcs | 2.5 | 15 | 0.148 (0.14–0.15) | 0.41 | 0.25 / 0.47 | 1.46 | 2.39 | 7 | 3,276 | 55 | 22 (19) |
| 5000 | rope | 1 | 42 | 0.103 (0.10–0.11) | 0.13 | 0.25 / 0.46 | 1.88 | 5.49 | 5 | 10,696 | 52 | 65 (62) |
| 5000 | rope | whole map (0.0129) | all | 0.463 (0.45–0.47) | 0.63 | 0.80 / 1.65 | 1.35 | 2.43 | 4 | 451,208 | 4 | 0 (0) |
| 5000 | rope | 0.35 | 231 | 0.168 (0.16–0.20) | 0.20 | 0.30 / 0.51 | 1.37 | 1.90 | 5 | 49,164 | 257 | 297 (285) |
| 5000 | rope | 2.5 | 18 | 0.094 (0.09–0.10) | 0.11 | 0.21 / 0.40 | 1.30 | 2.73 | 5 | 4,275 | 23 | 26 (25) |
| 5000 | paper-quilling | 1 | 42 | 0.157 (0.12–0.17) | 0.27 | 0.23 / 0.42 | 1.55 | 2.86 | 5 | 16,521 | 52 | 99 (96) |
| 5000 | paper-quilling | whole map (0.0129) | all | 0.415 (0.41–0.42) | 0.44 | 0.50 / 0.68 | 0.82 | 2.61 | 4 | 548,604 | 4 | 0 (0) |
| 5000 | paper-quilling | 0.35 | 231 | 0.147 (0.15–0.15) | 0.16 | 0.30 / 0.60 | 1.64 | 3.68 | 5 | 65,317 | 257 | 392 (380) |
| 5000 | paper-quilling | 2.5 | 18 | 0.099 (0.10–0.10) | 0.12 | 0.22 / 0.38 | 1.41 | 2.88 | 5 | 6,670 | 23 | 40 (39) |
| 20000 | clean | 1 | 127 | 0.233 (0.20–0.23) | 0.39 | 0.34 / 0.59 | 2.61 | 4.19 | 3 | 74,290 | 180 | 875 (866) |
| 20000 | clean | whole map (0.0056) | all | 1.125 (1.12–1.15) | 1.27 | 1.30 / 1.55 | 1.02 | 1.25 | 3 | 1,255,014 | 3 | 0 (0) |
| 20000 | clean | 0.35 | 516 | 0.408 (0.32–0.50) | 0.50 | 0.42 / 0.66 | 2.27 | 4.11 | 3 | 93,083 | 572 | 1104 (1077) |
| 20000 | clean | 2.5 | 40 | 0.133 (0.13–0.17) | 0.20 | 0.43 / 0.87 | 1.03 | 2.26 | 4 | 24,541 | 51 | 289 (286) |
| 20000 | soft-clay | 1 | 127 | 0.407 (0.36–0.42) | 0.70 | 0.64 / 0.97 | 3.61 | 6.12 | 9 | 153,171 | 535 | 922 (891) |
| 20000 | soft-clay | whole map (0.0056) | all | 2.157 (2.15–2.19) | 2.38 | 2.57 / 2.92 | 2.88 | 4.57 | 4 | 1,445,815 | 40,002 | 2500 (0) |
| 20000 | soft-clay | 0.35 | 516 | 0.472 (0.46–0.48) | 0.78 | 1.00 / 1.37 | 2.77 | 4.93 | 7 | 193,278 | 1,709 | 1210 (1112) |
| 20000 | soft-clay | 2.5 | 40 | 0.169 (0.16–0.19) | 0.31 | 0.33 / 0.58 | 2.86 | 5.14 | 8 | 24,322 | 148 | 149 (141) |
| 20000 | lifted-arcs | 1 | 90 | 0.260 (0.20–0.26) | 0.41 | 0.44 / 0.70 | 1.76 | 2.91 | 7 | 68,669 | 301 | 416 (399) |
| 20000 | lifted-arcs | whole map (0.0047) | all | 2.191 (2.15–2.31) | 2.40 | 2.76 / 3.20 | 3.02 | 4.95 | 4 | 1,549,766 | 40,002 | 2500 (0) |
| 20000 | lifted-arcs | 0.35 | 432 | 0.755 (0.72–0.80) | 1.35 | 0.58 / 0.84 | 2.24 | 4.47 | 7 | 182,278 | 1,459 | 1135 (1051) |
| 20000 | lifted-arcs | 2.5 | 24 | 0.148 (0.14–0.18) | 0.25 | 0.30 / 0.54 | 1.55 | 2.27 | 9 | 2,859 | 117 | 22 (15) |
| 20000 | rope | 1 | 126 | 0.340 (0.30–0.76) | 0.63 | 0.57 / 0.93 | 2.79 | 5.82 | 5 | 158,872 | 167 | 937 (929) |
| 20000 | rope | whole map (0.0054) | all | 1.231 (1.22–1.24) | 1.38 | 1.35 / 1.62 | 1.22 | 1.60 | 4 | 1,620,742 | 4 | 0 (0) |
| 20000 | rope | 0.35 | 495 | 0.409 (0.40–0.48) | 0.63 | 0.49 / 0.73 | 2.41 | 3.81 | 5 | 199,326 | 564 | 1188 (1161) |
| 20000 | rope | 2.5 | 40 | 0.155 (0.14–0.16) | 0.25 | 0.29 / 0.55 | 1.68 | 2.57 | 5 | 53,409 | 50 | 315 (312) |
| 20000 | paper-quilling | 1 | 126 | 0.239 (0.22–0.27) | 0.31 | 0.42 / 0.69 | 2.57 | 3.70 | 7 | 161,156 | 167 | 950 (942) |
| 20000 | paper-quilling | whole map (0.0054) | all | 1.237 (1.23–1.25) | 1.51 | 1.37 / 1.90 | 1.28 | 1.98 | 4 | 1,658,618 | 4 | 0 (0) |
| 20000 | paper-quilling | 0.35 | 495 | 0.361 (0.36–0.48) | 0.48 | 0.53 / 0.80 | 2.47 | 3.99 | 5 | 192,790 | 564 | 1149 (1123) |
| 20000 | paper-quilling | 2.5 | 40 | 0.192 (0.17–0.21) | 0.32 | 0.31 / 0.58 | 1.74 | 2.45 | 7 | 49,623 | 50 | 293 (290) |
| 50000 | clean | 1 | 117 | 0.241 (0.24–0.28) | 0.40 | 0.53 / 0.81 | 4.29 | 6.91 | 3 | 185,926 | 161 | 2183 (2175) |
| 50000 | clean | whole map (0.0026) | all | 2.476 (2.46–2.50) | 2.84 | 2.69 / 2.98 | 1.72 | 3.06 | 3 | 3,021,330 | 3 | 0 (0) |
| 50000 | clean | 0.35 | 536 | 0.590 (0.34–0.72) | 0.90 | 0.49 / 0.75 | 2.86 | 5.53 | 3 | 121,833 | 590 | 1442 (1414) |
| 50000 | clean | 2.5 | 38 | 0.149 (0.14–0.18) | 0.34 | 0.27 / 0.49 | 0.83 | 1.78 | 4 | 49,563 | 51 | 582 (580) |
| 50000 | soft-clay | 1 | 117 | 0.303 (0.29–0.31) | 0.49 | 0.41 / 0.63 | 5.66 | 7.32 | 9 | 381,771 | 479 | 2259 (2231) |
| 50000 | soft-clay | whole map (0.0026) | all | 4.403 (4.36–4.60) | 4.59 | 4.57 / 4.77 | 5.55 | 8.00 | 4 | 3,391,188 | 87,486 | 5468 (0) |
| 50000 | soft-clay | 0.35 | 536 | 0.373 (0.36–0.41) | 0.46 | 0.53 / 0.76 | 3.10 | 5.53 | 7 | 252,381 | 1,764 | 1559 (1458) |
| 50000 | soft-clay | 2.5 | 38 | 0.141 (0.14–0.14) | 0.19 | 0.28 / 0.49 | 2.51 | 4.76 | 9 | 2,509 | 147 | 21 (13) |
| 50000 | lifted-arcs | 1 | 92 | 0.274 (0.27–0.35) | 0.39 | 0.36 / 0.55 | 4.18 | 6.12 | 8 | 280,376 | 311 | 1657 (1639) |
| 50000 | lifted-arcs | whole map (0.0023) | all | 4.357 (4.30–4.52) | 4.75 | 5.25 / 5.46 | 4.58 | 6.91 | 4 | 3,719,664 | 80,004 | 5000 (0) |
| 50000 | lifted-arcs | 0.35 | 470 | 0.404 (0.39–0.42) | 0.70 | 0.57 / 0.80 | 3.36 | 6.33 | 7 | 253,486 | 1,539 | 1555 (1467) |
| 50000 | lifted-arcs | 2.5 | 24 | 0.136 (0.13–0.14) | 0.15 | 0.28 / 0.49 | 1.38 | 1.56 | 7 | 3,118 | 105 | 23 (17) |
| 50000 | rope | 1 | 125 | 0.291 (0.27–0.35) | 0.50 | 0.61 / 0.93 | 4.05 | 6.58 | 5 | 326,043 | 150 | 1916 (1909) |
| 50000 | rope | whole map (0.0026) | all | 2.443 (2.36–2.50) | 2.63 | 2.54 / 2.76 | 1.63 | 1.88 | 4 | 3,883,456 | 4 | 0 (0) |
| 50000 | rope | 0.35 | 542 | 0.326 (0.33–0.36) | 0.41 | 0.47 / 0.68 | 3.71 | 4.54 | 9 | 334,460 | 600 | 1981 (1953) |
| 50000 | rope | 2.5 | 38 | 0.167 (0.12–0.17) | 0.25 | 0.29 / 0.51 | 1.46 | 3.31 | 7 | 3,929 | 48 | 25 (22) |
| 50000 | paper-quilling | 1 | 125 | 0.296 (0.29–0.32) | 0.45 | 0.42 / 0.61 | 4.29 | 6.62 | 5 | 353,684 | 150 | 2078 (2071) |
| 50000 | paper-quilling | whole map (0.0026) | all | 2.662 (2.63–2.74) | 3.07 | 2.45 / 2.66 | 2.68 | 5.47 | 4 | 3,773,846 | 4 | 0 (0) |
| 50000 | paper-quilling | 0.35 | 542 | 0.413 (0.40–0.45) | 0.58 | 0.57 / 0.78 | 4.09 | 6.73 | 5 | 388,466 | 600 | 2297 (2269) |
| 50000 | paper-quilling | 2.5 | 38 | 0.124 (0.12–0.14) | 0.16 | 0.24 / 0.42 | 1.39 | 2.88 | 6 | 17,223 | 48 | 103 (100) |

Budget check: script stays far under 4 ms everywhere except the whole-map view of 50,000 nodes (2.4 to 4.4 ms renderer,
2.5 to 5.3 ms whole main thread; soft-clay and lifted-arcs exceed 4 ms) and 20,000-node soft-clay/lifted-arcs whole map (2.2 ms).
GPU is now the larger cost at DPR 2: 50,000 nodes at zoom 1 takes 4 to 5.7 ms of GPU per frame (p95 6 to 7.3 ms), close to the 8.3 ms frame.

### Fill versus vertex: DPR 1 against DPR 2 (same CSS viewport, same camera)

| nodes | theme | zoom | GPU ms DPR 1 | GPU ms DPR 2 | ratio 2/1 | GPU DPR 2, shadow layer off | script ms DPR 1 | script ms DPR 2 |
|---|---|---|---|---|---|---|---|---|
| 5000 | clean | 1 | 0.52 | 0.72 | 1.4 | 1.22 | 0.177 | 0.096 |
| 5000 | clean | whole map (0.0136) | 0.33 | 1.50 | 4.6 | 0.88 | 0.530 | 0.409 |
| 5000 | clean | 0.35 | 0.71 | 1.45 | 2.0 | 0.96 | 0.221 | 0.149 |
| 5000 | clean | 2.5 | 0.21 | 1.45 | 6.8 | 1.45 | 0.098 | 0.081 |
| 5000 | soft-clay | 1 | 0.64 | 1.73 | 2.7 | 1.63 | 0.151 | 0.147 |
| 5000 | soft-clay | whole map (0.0136) | 0.65 | 2.54 | 3.9 | 2.46 | 0.774 | 0.691 |
| 5000 | soft-clay | 0.35 | 0.44 | 3.00 | 6.8 | 2.09 | 0.199 | 0.193 |
| 5000 | soft-clay | 2.5 | 0.38 | 2.27 | 6.0 | 1.93 | 0.109 | 0.135 |
| 5000 | lifted-arcs | 1 | 0.37 | 1.41 | 3.9 | 0.84 | 0.136 | 0.111 |
| 5000 | lifted-arcs | whole map (0.0112) | 0.39 | 2.56 | 6.6 | 1.77 | 0.746 | 0.739 |
| 5000 | lifted-arcs | 0.35 | 0.45 | 1.59 | 3.6 | 1.31 | 0.197 | 0.161 |
| 5000 | lifted-arcs | 2.5 | 0.44 | 1.46 | 3.3 | 0.87 | 0.115 | 0.148 |
| 5000 | rope | 1 | 0.38 | 1.88 | 4.9 | 0.74 | 0.116 | 0.103 |
| 5000 | rope | whole map (0.0129) | 0.46 | 1.35 | 3.0 | 0.97 | 0.442 | 0.463 |
| 5000 | rope | 0.35 | 0.45 | 1.37 | 3.0 | 0.83 | 0.162 | 0.168 |
| 5000 | rope | 2.5 | 0.36 | 1.30 | 3.6 | 0.80 | 0.103 | 0.094 |
| 5000 | paper-quilling | 1 | 0.86 | 1.55 | 1.8 | 0.68 | 0.109 | 0.157 |
| 5000 | paper-quilling | whole map (0.0129) | 0.31 | 0.82 | 2.7 | 0.96 | 0.458 | 0.415 |
| 5000 | paper-quilling | 0.35 | 0.38 | 1.64 | 4.4 | 1.41 | 0.167 | 0.147 |
| 5000 | paper-quilling | 2.5 | 0.57 | 1.41 | 2.5 | 0.77 | 0.130 | 0.099 |
| 50000 | clean | 1 | 1.50 | 4.29 | 2.9 | 5.26 | 0.259 | 0.241 |
| 50000 | clean | whole map (0.0026) | 1.25 | 1.72 | 1.4 | 1.61 | 3.572 | 2.476 |
| 50000 | clean | 0.35 | 0.95 | 2.86 | 3.0 | 2.81 | 0.391 | 0.590 |
| 50000 | clean | 2.5 | 0.23 | 0.83 | 3.6 | 0.76 | 0.123 | 0.149 |
| 50000 | soft-clay | 1 | 2.60 | 5.66 | 2.2 | 4.53 | 0.269 | 0.303 |
| 50000 | soft-clay | whole map (0.0026) | 4.24 | 5.55 | 1.3 | 5.11 | 4.582 | 4.403 |
| 50000 | soft-clay | 0.35 | 2.28 | 3.10 | 1.4 | 2.82 | 0.438 | 0.373 |
| 50000 | soft-clay | 2.5 | 0.71 | 2.51 | 3.6 | 0.85 | 0.133 | 0.141 |
| 50000 | lifted-arcs | 1 | 2.25 | 4.18 | 1.9 | 3.37 | 0.315 | 0.274 |
| 50000 | lifted-arcs | whole map (0.0023) | 4.56 | 4.58 | 1.0 | 4.48 | 4.608 | 4.357 |
| 50000 | lifted-arcs | 0.35 | 2.30 | 3.36 | 1.5 | 2.61 | 0.448 | 0.404 |
| 50000 | lifted-arcs | 2.5 | 1.42 | 1.38 | 1.0 | 0.77 | 0.163 | 0.136 |
| 50000 | rope | 1 | 1.49 | 4.05 | 2.7 | 3.69 | 0.247 | 0.291 |
| 50000 | rope | whole map (0.0026) | 1.78 | 1.63 | 0.9 | 1.66 | 2.594 | 2.443 |
| 50000 | rope | 0.35 | 2.02 | 3.71 | 1.8 | 3.05 | 0.394 | 0.326 |
| 50000 | rope | 2.5 | 0.41 | 1.46 | 3.6 | 0.85 | 0.119 | 0.167 |
| 50000 | paper-quilling | 1 | 1.64 | 4.29 | 2.6 | 4.00 | 0.318 | 0.296 |
| 50000 | paper-quilling | whole map (0.0026) | 1.40 | 2.68 | 1.9 | 2.88 | 2.689 | 2.662 |
| 50000 | paper-quilling | 0.35 | 2.02 | 4.09 | 2.0 | 3.90 | 0.445 | 0.413 |
| 50000 | paper-quilling | 2.5 | 0.78 | 1.39 | 1.8 | 1.51 | 0.123 | 0.124 |

Reading: at DPR 2 there is a floor of about 1 to 1.3 ms of GPU time even when almost nothing is drawn (5,000 clean at zoom 2.5:
1,451 triangles, 0.21 ms at DPR 1, 1.45 ms at DPR 2). Zoomed-in views scale 2 to 4x with pixel count, so they are fill bound.
Whole-map views at 50,000 nodes barely change with DPR (ratio 0.9 to 1.9): they are vertex/primitive bound (3 to 3.9 million triangles,
every one under half a pixel, see section 5). The A/B in section 4 shows the DPR 2 floor and most of the fill cost is 4x MSAA plus
blended overdraw.

## 2. Where script time goes inside a frame

Exclusive time per frame from the instrumented run (Chrome; instrumentation adds a little, compare the last row):

| part of render() (exclusive ms per frame, instrumented run) | 50000 clean fit | 50000 soft-clay fit | 50000 clean 0.35 | 50000 rope 1 | 50000 paper-quilling 0.35 | 20000 lifted-arcs 0.35 | 5000 clean 1 |
|---|---|---|---|---|---|---|---|
| viewport queries (rects, labels, images) | 1.115 | 2.203 | 0.031 | 0.022 | 0.026 | 0.051 | 0.010 |
| branch culling + index packing | 0.987 | 0.978 | 0.082 | 0.113 | 0.143 | 0.067 | 0.011 |
| render() own code: rect/shadow instance writes, clears, uploads | 0.072 | 1.122 | 0.046 | 0.041 | 0.032 | 0.085 | 0.032 |
| rect shadow draw (+upload) | 0.000 | 0.069 | 0.000 | 0.000 | 0.001 | 0.029 | 0.001 |
| rect draw (+upload) | 0.038 | 0.056 | 0.004 | 0.004 | 0.004 | 0.008 | 0.004 |
| branch mesh draw (+culled index upload) | 0.009 | 0.009 | 0.079 | 0.006 | 0.005 | 0.006 | 0.023 |
| dimensional shadow layer pass | – | 0.001 | – | 0.119 | 0.080 | 0.078 | – |
| shadow composite | – | – | – | 0.009 | 0.009 | 0.007 | – |
| label loop (decide, quads) | 0.340 | 0.281 | 0.153 | 0.072 | 0.151 | 0.242 | 0.027 |
| greek/placeholder bars | – | – | – | – | – | – | – |
| label rasterisation | 0.001 | 0.001 | 0.001 | 0.001 | 0.001 | 0.001 | 0.000 |
| label text layout | – | – | – | – | – | – | – |
| bar draw | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 | 0.000 |
| images | 0.005 | 0.004 | 0.007 | 0.004 | 0.003 | 0.011 | 0.002 |
| total of the above | 2.568 | 4.725 | 0.404 | 0.391 | 0.456 | 0.584 | 0.110 |
| uninstrumented mean (for comparison) | 2.476 | 4.403 | 0.590 | 0.291 | 0.413 | 0.755 | 0.096 |


Why each cost exists (from the code):

- **Viewport queries** (`render/scene-viewport.ts` `SceneViewport.query` -> `core/geometry/grid.ts` `GridIndex.query`): three uniform-grid
  queries per frame (rects, labels, images), each visiting every overlapping cell, de-duplicating with a stamp array, then
  `res.sort()` so draw order is kept. When the whole map is in view this visits and sorts every item: 1.1 ms (clean) and 2.2 ms (soft-clay,
  whose rect boxes are padded by their shadows) at 50,000 nodes. The CPU profile of a 50,000 whole-map pan puts 514 ms of 696 ms
  non-idle self time in `grid.ts query`.
- **Branch culling** (`renderer.ts` `visibleMesh` -> `visibleBranchSpans` -> `branchIndex(mesh).query`): the same grid query over one
  bounding box per branch, every frame, then the visible spans' indices are copied into `culledIndices` run by run and re-uploaded
  with `bufferData(ELEMENT_ARRAY_BUFFER, STREAM_DRAW)` in `drawMesh` (the shadow layer reuses that upload). About 1 ms at 50,000 whole map
  (when every span is visible the query result is thrown away and the static index buffer is drawn), 0.07 to 0.15 ms zoomed in.
  Granularity is one box per branch, so long fan branches pass: at 50,000 zoom 1, 185,830 triangles are submitted and 14,273 of them
  touch the screen (7.7 %); at zoom 0.35, 120,796 submitted, 24,967 on screen. That is 0.9 to 2.3 MB of indices re-sent per frame.
- **Rect instance writing** (inline loop in `render()`, `writeRect`/`writeShadow`, then `drawShadows`/`drawRects`): every visible rect
  (and its soft shadow) is written camera-relative into a Float32 instance buffer (64 bytes each) and uploaded with `bufferData` every frame.
  Clean has one rect (the root); soft-clay and lifted-arcs draw every node as a rect with a shadow: 87,486 instances, 5.4 MB per frame
  at the 50,000 whole map, 1.1 ms of writes plus the upload.
- **Labels** (`drawLabels`, `render/text.ts` `LabelAtlas`): see section 3. Steady state 0.03 to 0.34 ms; the whole-map cost (0.28 to 0.34 ms at
  50,000) is the loop visiting all 50,000 labels only to skip each one as smaller than 0.65 px.
- **Dimensional shadow layer** (`drawShadowLayer` + `compositeShadowLayer`): CPU 0.08 to 0.12 ms (state changes, a second draw of the same
  culled indices into a half-resolution R8 target with MAX blending, one full-screen composite). Its GPU cost is in section 4.
- **The rest of the app**: moving the real camera also bumps `camTick`, which Svelte overlays (NodeBadges, EdgePointers, StatusBar) react to.
  App script per frame minus renderer script is 0.1 to 0.3 ms; TaskDuration adds another 0.2 to 0.3 ms. Not a bottleneck.

What is re-sent to the GPU on a frame where only the camera moved: rect and shadow instances (all visible ones), label quads (48 bytes each),
greeking bars, and the culled branch index list. Measured 0.2 KB (whole map, clean: nothing culled, one rect) to 5.4 MB (50,000 soft-clay
whole map). The branch vertex buffer and the full index buffer are never re-sent. Draw calls are 3 to 9 per frame in every combination.

## 3. Labels: how they are drawn and what happens under the time budget

- One Canvas 2D rasterisation per label (all its lines) at a zoom bucket (powers of sqrt 2 in texels per world unit), copied into a
  2048 x 2048 RGBA atlas page with `texSubImage2D(..., canvas)` from an OffscreenCanvas staging surface. Up to 8 pages (128 MB).
  Drawing is one instanced quad per label (not per glyph), one draw call per atlas page. Text layout (`layoutLabel`, measureText) is cached
  by font, width and text.
- Below 4 screen px a label is "greeked" into one bar per line (rect instances); below 0.65 px it is skipped, but still visited.
  Overview titles (the `overviewTitle` flag) get a fixed 11 px with a collision grid; the synthetic maps have none.
- Budget: `min(labelBudgetMs = 4, 0.24 x measured refresh interval)`, so 4 ms at 60 Hz and 2 ms at 120 Hz, shared by layout and raster.
  Labels whose layout misses the deadline draw as faint bars; labels with layout but no slot at the wanted bucket draw the nearest bucket
  they have (blurry or over-sharp), else a bar; the frame then requests another frame.
- Measured pop-in after jumping to a new view (frame time ms / labels drawn as text):
  50,000 clean at 0.35: `7.48/1 5.25/12 5.13/266 4.75/553 1.54/592 1.04/592 1.63/594 1.5/590 1.36/582 1.08/586 1.02/588 0.56/584 1.01/587 0.5/583`; 50,000 rope at 0.35: `4.36/111 4.18/576 1.44/599 1.56/603 0.99/602 0.74/599 1.02/599 2.7/598 0.81/598 0.62/596 0.52/597 0.44/596 0.5/595 0.48/594`. So text fills in over 3 to 4 frames at 60 Hz
  (twice as many at 120 Hz) with frames of 4 to 7.5 ms, then a tail of 1 to 1.6 ms frames while missing buckets are rasterised.
- Zoom sweep 0.15 -> 2.0 over 90 frames at 20,000 nodes (`sweep.py`): each sqrt 2 bucket crossing re-rasterises the whole visible set
  (130 to 216 labels), so a 4 to 5 ms frame recurs every ~6 frames in Chrome (mean 0.93 ms, p95 4.5 ms at a 60 Hz budget; mean 0.46,
  p95 1.0 ms at 120 Hz).
- **WebKit is very different.** Per-label raster cost inside the app: Chrome 0.010 to 0.014 ms, WebKit 0.43 to 0.61 ms (sum of
  per-call time over 333 to 718 rasterisations). The same zoom sweep in WebKit spends its whole budget on almost every frame: mean 3.9 ms
  per frame at a 60 Hz budget, 2.5 ms at 120 Hz, and draws far fewer labels per frame. A micro-benchmark (`textmicro.py`, 200 labels,
  3 runs, ending with a readPixels so uploads are complete) isolates the cause: drawing the text costs about 0.005 ms; uploading
  from an accelerated canvas costs 0.28 to 0.6 ms per label in WebKit (0.21 to 0.31 ms in Chrome when forced to complete), while a
  `willReadFrequently: true` canvas + `getImageData` + `texSubImage2D(Uint8Array)` costs 0.05 to 0.07 ms in WebKit (0.03 to 0.04 in Chrome).
- Side finding: `stats.labelsPending` is always 0 after a frame, because `LabelAtlas.process` empties the queue before `render()` reads
  `pendingCount`. The renderer itself relies on `more`/`raf`, so drawing is unaffected, but anything that treats `labelsPending === 0` as
  "done" (the new `Renderer.idle` getter, benchmarks) is only right because it also checks `raf`.

## 4. GPU: MSAA, blending/overdraw and the shadow layer (interleaved A/B, 50,000 nodes, DPR 2)

`ab.py` renders the same scene with: the app's renderer (base); base with blending disabled for the static branch mesh draw only
(blendoff); a second Renderer instance on a second canvas whose WebGL2 context was created with `antialias: false` (noaa); both; and the
shadow layer skipped (noshadow). Three interleaved rounds of 90 frames, GPU ms medians per round:

| theme / zoom | base | blend off (branch mesh) | no MSAA | no MSAA + blend off | shadow layer off |
|---|---|---|---|---|---|
| clean / whole map | 1.95, 3.14, 2.24 | 3.36, 1.57, 1.55 | 1.38, 2.96, 1.08 | 0.72, 1.20, 2.96 | 1.31, 1.40, 3.11 |
| clean / 0.35 | 3.84, 2.73, 2.43 | 3.49, 1.77, 1.49 | 1.31, 1.20, 0.68 | 0.82, 0.48, 0.75 | 3.38, 2.72, 2.70 |
| clean / 1 | 3.93, 3.82, 3.75 | 1.48, 2.54, 1.59 | 1.84, 1.39, 0.63 | 0.88, 0.44, 1.00 | 3.87, 3.62, 3.54 |
| clean / 2.5 | 1.03, 0.80, 0.81 | 0.94, 0.73, 0.76 | 0.41, 0.39, 0.39 | 0.38, 0.21, 0.27 | 1.05, 0.80, 0.91 |
| rope / whole map | 1.63, 1.54, 1.59 | 1.74, 1.63, 1.55 | 1.48, 1.82, 0.96 | 1.30, 1.27, 0.96 | 1.62, 2.16, 1.53 |
| rope / 0.35 | 3.05, 2.94, 2.80 | 2.22, 1.69, 1.84 | 1.22, 0.72, 0.63 | 1.16, 0.60, 1.82 | 3.00, 2.58, 2.61 |
| rope / 1 | 4.31, 4.40, 3.71 | 1.96, 1.94, 1.93 | 1.42, 1.54, 2.28 | 0.90, 1.04, 1.10 | 3.38, 3.47, 3.83 |
| rope / 2.5 | 1.49, 2.11, 1.35 | 1.44, 1.37, 1.48 | 0.53, 0.60, 1.06 | 0.59, 0.57, 1.12 | 0.81, 0.75, 1.19 |
| soft-clay / whole map | 4.11, 5.06, 5.03 | 4.69, 5.27, 4.93 | 2.41, 2.45, 2.25 | 3.69, 2.50, 2.43 | 4.65, 4.64, 5.52 |
| soft-clay / 0.35 | 3.25, 3.09, 3.26 | 1.60, 1.82, 1.78 | 1.37, 1.43, 0.83 | 1.61, 1.08, 0.85 | 3.49, 3.15, 3.12 |
| soft-clay / 1 | 5.59, 4.84, 5.31 | 3.94, 2.22, 2.23 | 3.80, 1.80, 1.65 | 1.88, 1.72, 1.88 | 5.23, 4.77, 4.75 |
| soft-clay / 2.5 | 1.56, 1.45, 1.84 | 1.52, 1.79, 2.62 | 0.69, 1.54, 1.65 | 0.67, 0.93, 1.27 | 1.21, 2.56, 1.29 |

The same A/B in Playwright WebKit (no timer query, so wall time of render() plus a 1-pixel readPixels before and after, which includes
0.2 to 0.4 ms of script; means of 3 x 90 frames):

| theme / zoom | base | blend off | no MSAA | both | shadow off |
|---|---|---|---|---|---|
| clean / 0.35 | 3.94, 3.74, 2.68 | 2.08, 2.14, 1.62 | 2.29, 1.54, 1.51 | 1.46, 1.36, 1.14 | 3.69, 3.06, 3.00 |
| clean / 1 | 5.89, 4.91, 5.93 | 2.62, 2.51, 2.47 | 3.24, 2.06, 2.79 | 2.63, 2.18, 2.16 | 4.69, 5.12, 5.28 |
| clean / 2.5 | 1.44, 1.51, 1.37 | 1.12, 1.63, 1.33 | 0.91, 0.84, 0.93 | 0.92, 0.73, 0.73 | 1.22, 1.18, 1.26 |
| rope / 0.35 | 3.66, 3.39, 3.20 | 2.10, 2.40, 2.03 | 3.57, 1.99, 1.96 | 1.72, 1.70, 1.84 | 4.69, 2.81, 2.83 |
| rope / 1 | 5.57, 5.73, 5.18 | 2.69, 3.19, 3.48 | 3.56, 3.74, 4.76 | 2.02, 2.53, 2.93 | 5.73, 4.83, 5.78 |
| rope / 2.5 | 1.27, 1.28, 1.40 | 1.68, 1.23, 1.43 | 1.22, 0.99, 1.20 | 0.94, 0.98, 1.12 | 1.47, 1.53, 1.33 |

Visual check (`visual.py`, 5,000 nodes, full-canvas readPixels compared, zoom 1 and 2.5): blend off is pixel-identical (0 pixels
differ by more than 8/255) for clean, rope and soft-clay. It is NOT identical for paper-quilling (0.7 to 1.3 % of pixels, up to 249/255),
because the quill scroll shader returns alpha below 1 (and 0 outside the spiral). No MSAA changes 0.1 to 0.4 % of pixels by up to
130/255: curve edges show slight stair-stepping when viewed at 1:1 device pixels (crops `vis-*-noaa.png` vs `vis-*-base.png`).

Why: branch meshes are opaque but drawn with blending on (one global `blendFunc(ONE, ONE_MINUS_SRC_ALPHA)`), which stops the Apple GPU's
hidden-surface removal from discarding covered fragments. And the fan overdraw is large: at 50,000 nodes zoom 1 the on-screen area of the
submitted branch triangles is 3.5 times the screen (rope 2.1x; at 0.35: 0.6x and 0.4x; at 5,000 nodes 0.03x), because hundreds of sibling
ribbons share one vertical trunk (`shot-50000-clean-1.png`). The 4x MSAA default framebuffer at 3456 x 2234 is the fixed DPR 2 floor and
multiplies every fragment. The dimensional shadow layer costs about 0.3 to 1.1 ms at DPR 2 when it is drawn (it fades in from 2.5 px
of shadow reach, so not at whole-map zoom).

## 5. First frame after a scene change, and the frame while a relayout result arrives

Theme switch (a full relayout through the worker), first render after the new scene is set:

| engine | nodes | theme switched to | scene arrives after (ms) | first frame ms | MB sent to GPU in that frame | of which uploadMesh ms | branch triangles | vertex buffer MB | longest frame interval during switch (ms) | long tasks (ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| Chrome | 5000 | soft-clay | 157 | 30.1 | 16 | 17.1 | 399,754 | 8 | 33 | none over 50 |
| Chrome | 5000 | lifted-arcs | 187 | 10.2 | 15 | 5.6 | 392,992 | 8 | 43 | none over 50 |
| Chrome | 5000 | rope | 179 | 7.0 | 20 | 5.8 | 451,200 | 11 | 31 | none over 50 |
| Chrome | 5000 | paper-quilling | 197 | 34.4 | 21 | 33.5 | 548,596 | 11 | 50 | none over 50 |
| Chrome | 20000 | soft-clay | 1786 | 93.9 | 54 | 78.9 | 1,365,811 | 28 | 95 | 94 |
| Chrome | 20000 | lifted-arcs | 605 | 36.3 | 58 | 30.4 | 1,469,762 | 29 | 47 | none over 50 |
| Chrome | 20000 | rope | 586 | 33.4 | 74 | 31.1 | 1,620,734 | 41 | 44 | none over 50 |
| Chrome | 20000 | paper-quilling | 866 | 110.9 | 65 | 108.5 | 1,658,610 | 33 | 111 | 111 |
| Chrome | 50000 | soft-clay | 1294 | 83.3 | 128 | 70.8 | 3,216,216 | 65 | 117 | 116, 83 |
| Chrome | 50000 | lifted-arcs | 1277 | 51.9 | 141 | 41.5 | 3,559,656 | 71 | 102 | 102, 52 |
| Chrome | 50000 | rope | 1600 | 103.0 | 178 | 93.3 | 3,883,448 | 100 | 128 | 127, 103 |
| Chrome | 50000 | paper-quilling | 1370 | 40.5 | 148 | 34.3 | 3,773,838 | 75 | 112 | 111 |
| WebKit | 5000 | rope | 148 | 103.0 | 20 | 102.0 | 450,734 | 11 | 109 | none over 50 |
| WebKit | 5000 | soft-clay | 147 | 15.0 | 16 | 2.0 | 399,754 | 8 | 20 | none over 50 |
| WebKit | 50000 | rope | 1271 | 28.0 | 178 | 23.0 | 3,847,496 | 99 | 57 | none over 50 |
| WebKit | 50000 | soft-clay | 1299 | 34.0 | 130 | 13.0 | 3,216,216 | 65 | 59 | none over 50 |

- The cost is `uploadMesh`: `bufferData` of the whole branch vertex buffer (12 bytes per vertex flat, 20 to 24 relief) and a 32-bit index
  buffer, plus `branchIndex` (grid build over spans) and `viewport.update` (three grid builds, `estimateExtent` per label). The mesh is about
  3 KB per branch (2 KB vertices, 0.9 KB indices): 128 to 178 MB go to the GPU in one frame at 50,000 nodes.
- WebKit was erratic: two runs of the same 50,000 rope switch gave a first frame of 28 ms and 187 ms (uploadMesh 23 vs 180 ms); 5,000 rope
  gave 103 ms in one run and 10 ms in another. I did not find the cause; large `bufferData` calls in WebKit sometimes take ~1 GB/s.
- Long animation frame entries at 50,000 nodes in Chrome: 110 to 128 ms, the whole of it one requestAnimationFrame callback (flush, scene
  adoption, first render). Separately, the CPU profile of a 50,000 switch shows 143 ms of self time in the worker `onmessage` handler (structured
  clone deserialisation of the chunked layout messages, spread over several tasks), 47 ms `serializeDoc`, 23 ms `docAutosave` and 21 ms
  `revisionKey` (dev mock host autosave and undo storage), 29 ms `bufferData`. `adoptWork` itself is under 1 ms.
- So yes, there is a main-thread stall when a 50,000-node result arrives: one frame of 100 to 130 ms in Chrome, and at 20,000 nodes 44 to
  111 ms. At 5,000 nodes 31 to 50 ms (two or three dropped frames).
- Whole-map views: every one of the 3.0 to 3.9 million branch triangles at 50,000 nodes covers less than half a pixel (`overdraw.json`),
  which is why those views are vertex bound and LOD pays.

## 6. Platform facts checked here

- Chrome 158 headless: `navigator.gpu` present, adapter "apple / metal-3" with timestamp-query, shader-f16, subgroups.
  WebGL2 has EXT_disjoint_timer_query_webgl2 and WEBGL_multi_draw.
- Playwright WebKit: no `navigator.gpu`, no WebGL timer query, WEBGL_multi_draw present, OffscreenCanvas WebGL2 present.
- System WKWebView on macOS 26.5.1 (default configuration, via Swift): `navigator.gpu` present, adapter architecture "apple", features
  include timestamp-query, shader-f16, indirect-first-instance, float32-filterable; maxBufferSize 2 GB. WebGL2 has no timer query.
  OffscreenCanvas with a WebGL2 context works inside a Worker. Not checked: whether Tauri's WKWebView configuration changes any of this.

## 7. Ranked experiments

Ranked by expected gain on the owner's budgets times confidence, over effort. "Independent" means it can be tried and kept on its own.

1. **Skip culling when everything is in view, and skip the label loop when every label is below 0.65 px.**
   Hypothesis: at the whole-map view the grid queries and sorts are pure overhead.
   Change: `core/geometry/grid.ts` `GridIndex` (keep the build extent and an identity index array; `query` returns it when the query rect
   contains the extent); `render/scene-viewport.ts` `SceneViewport.query`; `render/renderer.ts` `visibleMesh` (test the mesh extent before
   `visibleBranchSpans`), `drawLabels` (largest font size x zoom < 0.65 -> return; keep overview titles), largest font computed in `SceneViewport.update`.
   Evidence: in-page prototype (`proto.py`), pixel-identical output, 50,000 whole map, 3 interleaved runs each:
   Chrome clean 2.58 to 2.99 -> 0.05 to 0.08 ms, rope 2.40 to 2.43 -> 0.07, soft-clay 4.59 to 4.89 -> 1.25 to 1.42;
   WebKit clean 1.07 to 1.17 -> 0.01 to 0.13, rope 1.38 to 1.83 -> 0.08 to 0.19, soft-clay 3.71 to 5.79 -> 2.31 to 3.80.
   Also worth trying in the same change: replace the typed-array `sort` in `GridIndex.query` with a bitmap scan when the hit count is a large
   fraction of n. Visual risk: none. Effort: small. Independent.

2. **Draw opaque branch meshes with blending off.**
   Hypothesis: blending defeats the GPU's hidden-surface removal; with it off, stacked fan ribbons stop costing fill.
   Change: `render/renderer.ts` `drawMesh` (disable BLEND for meshes known to be opaque, re-enable after); mark meshes opaque where they are built
   (`core/geometry/tessellate.ts` / `relief.ts` set a flag when every colour alpha is 1, or check in `uploadMesh`). Exclude paper-quilling, or make
   `QUILL_FS` use `discard` instead of alpha 0 and keep blending only for its scroll fragments.
   Evidence: section 4. 50,000 at zoom 1, Chrome GPU clean ~3.8 -> ~1.6 ms, rope ~4.3 -> 1.9 ms, soft-clay ~5.2 -> 2.2 ms; zoom 0.35 rope 2.9 -> 1.8,
   soft-clay 3.2 -> 1.7. WebKit wall time clean zoom 1 5.6 -> 2.5 ms, rope 5.5 -> 3.1 ms. No change at whole map or 2.5 (no overdraw there).
   Pixel-identical for clean, rope, soft-clay. Visual risk: low except quilling. Effort: small. Independent.

3. **Stop paying 4x MSAA at DPR 2 on every frame.**
   Hypothesis: the default-framebuffer MSAA resolve is the ~1 ms DPR 2 floor and multiplies fill.
   Options, cheapest first: (a) render interaction frames (camera moving) without MSAA and one MSAA frame when the camera settles (needs two
   framebuffers: an MSAA renderbuffer FBO blitted to an `antialias: false` canvas); (b) a 2-sample MSAA FBO; (c) analytic edge AA in the mesh
   shaders (relief meshes already carry the across coordinate; flat meshes would need it), then `antialias: false`.
   Change: `render/renderer.ts` `initGL` (context attributes), an FBO + `blitFramebuffer` path, `render()`.
   Evidence: section 4, no MSAA alone: clean zoom 1 3.8 -> 1.4 ms, zoom 2.5 0.81 -> 0.39, soft-clay whole map 5.0 -> 2.4; with blend off as well
   0.9 to 1.0 ms at zoom 1 (-75 %). WebKit clean zoom 1 5.6 -> 2.7. Also DPR 1 vs 2 table. Visual risk: medium for (a) and (c) (edge aliasing
   measured on 0.1 to 0.4 % of pixels), low for (b). Effort: small (a, b) to medium (c). Independent of 2; the gains overlap partly.

4. **Rasterise labels on a CPU-backed canvas and upload bytes (WebKit).**
   Hypothesis: `texSubImage2D` from an accelerated canvas forces a GPU readback per label in WebKit.
   Change: `render/text.ts` `make2D` (pass `{ willReadFrequently: true }` for the staging context) and `LabelAtlas.rasterize` (upload
   `getImageData` bytes; keep `UNPACK_PREMULTIPLY_ALPHA_WEBGL`, which applies to ArrayBufferView too). Better still: pack all labels
   rasterised this frame into one staging strip and upload once.
   Evidence: section 3. WebKit 0.43 to 0.61 ms per label in the app; micro-benchmark 0.28 to 0.6 -> 0.05 to 0.07 ms. Expected: about 8x more
   labels per budget in WebKit, zoom-gesture frames from ~3.9 ms toward 1 ms, pop-in shortened from many frames to a few. Chrome: neutral to
   slightly better (its canvas upload is deferred, 0.01 ms per label in the app). Visual risk: none expected (check premultiplied edges).
   Effort: small. Independent. Must be verified in WebKit, not Chrome.

5. **Static instance buffers for rects and shadows.**
   Hypothesis: re-writing and re-uploading every visible rect each frame is avoidable; the camera can be a uniform.
   Change: `render/renderer.ts` rect loop in `render()`, `writeRect`/`writeShadow`, `drawRects`/`drawShadows` (build world-space instance
   buffers in `sceneDirty`, draw all when most are visible, else upload only the visible ones as today); `render/shaders.ts` `RECT_VS`/`SHADOW_VS`
   get the high/low offset uniforms that `MESH_VS` already uses for precision.
   Evidence: 50,000 soft-clay/lifted-arcs whole map: 87,486 instances, 5.4 MB per frame; after proposal 1 the remaining renderer time is 1.25 to
   1.42 ms (Chrome) and 2.3 to 3.8 ms (WebKit), almost all of it this. Expected: under 0.2 ms. Visual risk: low (precision handled as for meshes).
   Effort: medium. Independent; do after 1.

6. **Spread the branch upload over frames and swap atomically.**
   Hypothesis: the 50,000-node stall is dominated by one 128 to 178 MB `bufferData`.
   Change: `render/renderer.ts` `setScene`/`uploadMesh`/`uploadRelief` (allocate with `bufferData(size)`, fill with `bufferSubData` slices of
   8 to 16 MB per frame while the previous mesh, labels and rects stay on screen, then swap everything together).
   Evidence: section 5: first frame 35 to 103 ms (Chrome), 28 to 187 ms (WebKit) at 50,000; uploadMesh is 70 to 90 % of it.
   Expected: no upload frame over ~16 ms; the new map appears 3 to 10 frames later. Visual risk: low if the swap is atomic. Effort: small to medium.
   Independent (superseded by 9 if that lands).

7. **Overview level of detail for branches.**
   Hypothesis: at whole-map zoom 3 to 3.9 million sub-half-pixel triangles are vertex work for nothing.
   Change: `core/geometry/tessellate.ts` (and relief/quill) emit a coarse mesh (a few segments per branch, no caps/forks detail), transported with
   the fine one; `render/renderer.ts` `drawMesh` picks it when maxWidth x zoom is below ~1 px.
   Evidence: whole-map GPU 1.6 to 5.5 ms at DPR 2 and 1.25 to 4.6 ms at DPR 1 (not fill bound); `overdraw.json`. Expected: whole-map GPU below 1 ms
   for flat themes; soft-clay/lifted-arcs whole map also needs 5 (their 87k rect + shadow instances). Visual risk: low (sub-pixel). Effort: medium.
   Memory +5 to 10 %. Independent; overlaps 9.

8. **Tighter branch culling without per-frame index uploads.**
   Hypothesis: one bounding box per branch admits 13x more triangles than are on screen at 50,000 zoom 1, and the culled list is re-sent each frame.
   Change: split `branchSpans` into sub-spans of ~32 to 64 triangles with their own boxes where the spans are built (`core/geometry/tessellate.ts`,
   `relief.ts`, `quill.ts`; `branch-index.ts` and `pickBranch` keep a sub-span -> branch id map), and draw the visible runs with
   `WEBGL_multi_draw` `multiDrawElementsWEBGL` straight from the static index buffer (present in Chrome and WKWebView) instead of
   `culledIndices` + `bufferData`.
   Evidence: 185,830 submitted vs 14,273 on screen (50,000 zoom 1); 0.9 to 2.3 MB of indices per frame; `bufferData` 0.08 ms per frame in the Chrome profile.
   Expected: CPU and upload small wins (0.1 to 0.2 ms), vertex work cut ~8x; little fill gain once 2 is in. Visual risk: none. Effort: medium.
   Independent; lower value after 2.

9. **Branches as GPU instances expanded in the vertex shader.**
   Hypothesis: a branch is a curve with a width profile and a material; sending ~64 to 96 bytes per branch instead of ~3 KB of tessellated mesh
   removes most of the transport, upload and memory cost, and gives per-zoom LOD for free (segment count from screen length).
   Change: `core/geometry/tessellate.ts`, `relief.ts`, `quill.ts` (move the ribbon maths into `render/shaders.ts`), `render/mesh-vertices.ts`,
   `render/renderer.ts` upload/draw, `core/geometry/branch-index.ts` and picking (analytic curve hit test), the worker transport.
   Evidence: 128 to 178 MB uploaded and 65 to 100 MB of vertex buffer at 50,000 nodes (section 5); ~40x less data expected. Visual risk: high
   (forks, organic taper, caps, rope plies and quill scrolls must match exactly). Effort: large. Not independent: supersedes 6, 7, 8.

10. **Avoid re-rasterising every visible label at each sqrt 2 zoom step.**
    Change: `render/text.ts` `LabelAtlas` (rasterise one bucket above and sample with mipmaps: `generateMipmap` per page after uploads, or keep a
    per-label slot that is reused while it is within 2x), `renderer.ts` `drawLabels` bucket choice. SDF/MSDF glyphs would remove re-rasterising
    altogether but need per-glyph shaping and quads (large effort, risk for complex scripts and emoji).
    Evidence: zoom sweep, 130 to 216 labels re-rasterised per bucket crossing, 4 to 5 ms frames every ~6 frames (Chrome, 60 Hz budget); WebKit at
    budget nearly every frame. Expected: zoom gestures at label-dense views mostly under 1 ms of label work. Visual risk: low (mip) to medium (SDF).
    Effort: medium. Do 4 first; re-measure.

11. **Cheaper dimensional shadow layer while moving.**
    Change: `render/renderer.ts` `ensureShadowLayer` (quarter resolution), or reuse the last shadow layer while only the camera pans by whole
    pixels and redraw on settle. Evidence: 0.3 to 1.1 ms GPU at DPR 2 (A/B shadow off; rope zoom 2.5 1.49 -> 0.81, rope zoom 1 ~4.1 -> 3.6).
    Visual risk: low to medium (softer or lagging shadow). Effort: small. Independent.

12. **Rendering in a worker with OffscreenCanvas.**
    Hypothesis: moving uploads and drawing off the main thread removes the adoption stall from input handling.
    Evidence for: OffscreenCanvas WebGL2 works in a worker in WKWebView (checked); the 50,000-node stall is 110 to 128 ms. Evidence against:
    steady-state main-thread cost per frame is 0.1 to 0.6 ms at normal zooms (whole main thread under 1 ms), so there is nothing to win per frame;
    the stall is better attacked by 6 plus transferable typed arrays in the layout transport (143 ms of the stall-side work is structured-clone
    deserialisation). Costs: DOM overlays positioned from the camera on the main thread can lag the canvas by a frame, fonts must be loaded inside
    the worker, camera input crosses threads. Effort: large. Rank low until 1 to 6 are done.

Measurements do NOT support:

- **WebGPU instead of WebGL2.** Draw calls are 3 to 9 per frame and the measured cost of the draw methods themselves is 0.005 to 0.08 ms per frame, so WebGPU's lower API
  overhead buys nothing measurable. The real costs (MSAA, blended overdraw, sub-pixel triangles, big uploads, CPU culling at whole-map) are all
  fixable in WebGL2 (proposals 1 to 8). WebGPU is available in WKWebView on this macOS and would add compute culling/LOD and timestamp queries
  (the only way to time the GPU in the shipping engine), but it is a full rewrite of renderer.ts and shaders.ts. Worth revisiting only for
  proposal 9 if storage buffers make the instanced-branch shader much simpler.
- **Rust/WASM for the frame path.** The only multi-millisecond script cost per frame (whole-map culling, 1 to 3 ms) disappears with a 20-line
  algorithmic change (proposal 1, prototyped). Everything else is under 0.6 ms and much of it is WebGL calls that WASM cannot make cheaper.
- **Native GPUI/wgpu for the frame path.** It would draw the same triangles with the same fill; the GPU numbers would not change by moving the
  renderer out of the WebView. Any case for native has to come from the rebuild path, which this profile does not cover.
- **More Web Workers for per-frame work.** There is no per-frame work big enough to split.
- **Caching the static scene in a texture or tiles while the camera moves.** After 2 and 3 the GPU cost of a zoom-1 frame at 50,000 nodes is about
  1 ms; tiles would cost 31 MB per screenful at DPR 2, need re-rendering on every zoom change and complicate crisp text. Not worth it on these numbers.

## 8. What I did not verify

- Nothing was measured inside the real Tauri app (WKWebView) except feature presence; WebKit timings come from Playwright WebKit with a 1 ms clock.
- GPU timings in WebKit are wall times with a readPixels sync, not GPU timer queries.
- Proposals 2 and 3 were measured by monkey-patching in the page (blend toggled around the branch draw) and by a second Renderer instance with
  `antialias: false`; the second canvas was composited by the browser underneath the first, which may add compositor cost not counted in its GPU time.
- Proposal 1 was prototyped in the page (pixel-identical); the others are estimates from the measurements named.
- Edit latency (adding a node, folding) on big maps and the worker side of a relayout were not profiled here (other studies cover the rebuild path).
- The CDP trace of the theme switch did not yield per-task data (thread metadata did not match); LoAF entries and the CPU profile were used instead.
