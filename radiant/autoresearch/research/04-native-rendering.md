# 04 Native rendering spike: GPUI, wgpu, and native computation

Date: 2026-11-25. Author: native-rendering agent of the autoresearch run. Status: measured spike; nothing in `radiant/src` or `radiant/src-tauri` was changed; nothing committed.

## Answer first

**Recommendation: stay in the WebView.** Do not move to full native rendering, and do not build a hybrid native canvas now.

- **At 5,000 nodes there is nothing to win.** Native wgpu spends 0.2 to 0.7 ms of CPU per frame on the same scene with labels. The WebGL renderer spends 0.26 to 0.95 ms of script per frame (headless Chrome and WKWebView). Both are far under the 4 ms budget, and GPU time is about 1 ms in both.
- **At 50,000 nodes the one bad case is fixable in WebGL.** The whole-map view costs 8 to 12 ms of script in Chrome, 4.2 to 4.3 ms in WKWebView, and WKWebView runs at 43 to 64 fps instead of 120. The cause is algorithmic, and it is the same in native code.
  - Each frame, the renderer copies the visible branch indices into a new index buffer and uploads it: about 30 to 45 MB per frame at 50,000 nodes (`Renderer.visibleMesh` followed by `bufferData`).
  - A faithful wgpu port that does the same costs 3.4 to 4.1 ms CPU per frame.
  - Drawing the contiguous visible runs straight from the resident index buffer brings it to 0.31 to 0.34 ms. That takes 8 to 15 draw calls, because visible spans form few runs.
  - WebGL2 can do the same with `drawElements(..., offset)` per run. This is the actionable result of this spike.
- **GPUI (Zed's framework) is not viable.** GPUI 0.2.2 on crates.io has no custom shaders, no retained vertex buffers and no camera transform. Paths are rebuilt and copied on the CPU every frame, and a 256 MiB per-frame instance buffer cap drops whole frames. The 50,000-node whole-map view drew nothing (frames dropped). The 5,000-node whole-map view took 36 to 47 ms per frame.
- **wgpu works well and is not the obstacle.** Leaving the WebView means rebuilding the rest of the application: about 54k lines of TypeScript and Svelte, text input with IME, Markdown and KaTeX notes, accessibility, export, drag and drop, and every shader in WGSL. That is a cost of many months for no measured gain at 5,000 nodes. The 50,000-node gain is available inside WebGL for about a day of work.
- **Native computation helps only modestly.** Rust tessellates and packs the 50,000-node flat map in 30 to 53 ms on one thread, against 65 to 85 ms in TS (V8 or JSC). With rayon it is about 10 ms.
  - Moving the result (about 100 MB) into WKWebView through a custom URL scheme costs about 25 ms, which eats most of the rayon gain.
  - WASM on one thread already gets 40 ms with no IPC.
  - If the rebuild path at 50,000 nodes matters, WASM in the existing worker beats a Tauri command.

## Conditions (read before the numbers)

- **The macOS session was locked for the whole spike** (`ioreg` shows `CGSSessionScreenIsLocked = true`), so no native window could present a frame.
  - wgpu returns `Occluded` from `get_current_texture` (wgpu-hal 30 `metal/surface.rs` checks `NSWindow.occlusionState`).
  - GPUI stops its display link.
  - WKWebView only ran with the private `_setWindowOcclusionDetectionEnabled:NO`.
  - **So presented frame rate, and whether 120 Hz ProMotion is reached on the panel, was not measured for any engine.**
  - All native numbers come from offscreen rendering (wgpu: a 2880 x 1800 `Bgra8Unorm` texture, paced to 120 Hz by a timer) or from a timer-driven redraw into an occluded window (GPUI).
- The machine was shared with other agents. Load average was 5 to 27 on 14 cores, and memory was under pressure during the GPUI runs. Every timing is provisional. Each cell is 3 runs of 5 s; I report the median of the run means, with the lowest and highest run mean in brackets, then the median p95.
- Headless Chrome is V8 capped at 60 Hz, not the shipping engine. WKWebView (JavaScriptCore) is the shipping engine. It ran through a Swift harness with the app's own 120 Hz preference (`PreferPageRenderingUpdatesNear60FPSEnabled = false`), and rAF did run at 8.3 ms. Playwright WebKit is a third, non-shipping WebKit build at 60 Hz.
- The dev server serves the main working tree. Other agents were editing `renderer.ts` and `controller.svelte.ts` during the session, so the WebGL baseline may include their in-progress changes. The export was taken at 09:34 and the WebGL runs at about 09:45 to 10:10.

## Workload

Exported from the running app (dev server, headless Chrome, 1440 x 900 at 2x) with `native-spike/scripts/export.py`. It saves exactly what `renderer.scene` holds:
- the packed vertex buffer as uploaded, indices, branch-span bounds and ends;
- rects, and labels (text, position, size, font, colour, wrap width, alignment);
- the cameras.

| dataset | vertices | triangles | vertex MB | index MB | labels | rects |
|---|---|---|---|---|---|---|
| 5000-clean | 372,838 | 342,844 | 7.1 (20 B/vertex) | 3.9 | 5,000 | 1 |
| 5000-rope | 497,155 | 450,734 | 15.2 (32 B/vertex) | 5.2 | 5,000 | 1 |
| 50000-clean | 3,321,318 | 3,021,324 | 63.3 | 34.6 | 50,000 | 1 |
| 50000-rope | 4,326,201 | 3,847,496 | 132.0 | 44.0 | 50,000 | 1 |

- Both themes draw every node as text over an underline; only the root has a rect, so rect cost is negligible in this workload.
- The synthetic map is very tall (5,000 nodes: 1,520 x 76,000 world units; 50,000: 3,800 x 400,000), so the whole-map zoom is 0.012 and 0.0022.

**Camera path** (`native-spike/results/camera-path.json`, shared by every engine), with t in seconds and T = 5 s:
- zoom(t) = z0 · 2^(0.5 sin 2πt/T)
- cx(t) = cx0 + (400/z0) sin 2πt/T
- cy(t) = cy0 + (250/z0) sin 4πt/T

Three scenarios per dataset, each held for 1 s at the base camera (labels settle) and then 5 s timed:
- fit: whole map;
- z035: zoom 0.35 at the densest region;
- z1: zoom 1.0 at the densest region.

## What was built

### wgpu + winit (`native-spike/`, `src/main.rs` and `src/shaders.wgsl`)

wgpu 30.0.2 (Metal), winit 0.30, cosmic-text 0.19. About 880 lines of Rust and 170 of WGSL.

- **Branches:** the exported packed vertex buffer is uploaded unchanged as one vertex buffer, with one index buffer. WGSL ports of `MESH_VS/FS`, `ROPE_VS/FS` (ply shading and whipping), `RELIEF_SHADOW_VS/FS` and `RELIEF_COMPOSITE_FS`. That includes the same high/low float precision trick and the half-resolution R8 shadow layer with MAX blending.
  - WGSL's uniformity rules forced the `fwidth`/`dpdx` calls out of the branches; the values computed are the same.
  - Rope renders indistinguishably from WebGL at zoom 1 by eye. Captures are in the scratch `wgpu/shots/` folder; the WebGL equivalents are `webgl-5000-*.png` there.
  - The one visible difference: the rope's ground shadow looks lighter in the wgpu capture. I did not chase it; it does not change the pass structure or cost.
- **Culling:** span bounds against the view plus 48 px, as `visibleBranchSpans`. Two modes:
  - `copy`: what WebGL does today, copy the visible index ranges into a new array and upload it.
  - `ranges`: draw each contiguous visible run from the resident index buffer.
- **Rects:** instanced SDF rounded rectangles (port of `RECT_VS/FS`, without wobble).
- **Labels:** cosmic-text shapes each label once (system San Francisco, wrap at `maxWidth`, line height 1.25, alignment).
  - Glyphs are rasterised with swash into a 4096² R8 atlas at zoom buckets of √2, like `LabelAtlas`, and drawn as instanced quads.
  - Same rules as the WebGL renderer: skip below 0.65 px, greek bars below 4 px, a 4 ms raster budget with faint bars for labels still pending.
  - Visible labels come from a uniform grid plus a per-label extent test.
  - Label counts per frame match the WebGL renderer: 201 against 203 at 5000 z035, and 43 against 40 at 5000 z1.
- **Not ported:** clay, arcs and quilling shaders, raised rects, images, overlays, canvas elements, curved labels, the overview titles.
- **Timing points:**
  - `cpu` is everything on the render thread from frame start to submit: visible set, index culling, rect/bar/glyph instances, buffer writes, wgpu encoding and validation, submit.
  - `gpu` is submit-to-completion wall time with the GPU otherwise idle, an upper bound. wgpu pass timestamps on Metal returned a stale end-of-pass sample (always the previous use of the query slot), so I could not use them.

### GPUI (`native-spike/gpui/`, by a sub-agent)

gpui 0.2.2, the newest on crates.io.
- Branches: one `Path` per (span, colour), built from the exported triangles with `push_triangle` every frame.
- Rects: `paint_quad`.
- Labels: `shape_line` cached per size step.
- Rope is drawn flat: there is no custom shader.
- This machine has no Metal compiler (Command Line Tools only), so GPUI needs its `runtime_shaders` feature.

## Side-by-side: per-frame cost while panning and zooming (ms)

Cells are: mean (lowest–highest run mean) / p95. "fps" for GPUI is frames completed per second under a 120 Hz timer, not presented frames.

**What each column measures:**
- **WebGL script** is `render()` plus the rAF callback (`camera.set`, synchronous subscribers, microtasks). It excludes the browser compositor and the GPU-process work.
- **WebGL GPU** comes from `EXT_disjoint_timer_query_webgl2`, Chrome only.
- **wgpu cpu** covers the whole render thread up to submit.
- **GPUI** is main-thread CPU for the whole frame, including Metal encoding and present.

| dataset / scenario | WebGL, Chrome: script | WebGL, Chrome: GPU (mean / p95) | WebGL, WKWebView: script | WKWebView: rAF interval (median / p95) | WebGL, Playwright WebKit: script | GPUI: main-thread CPU | wgpu cpu, `copy` culling (as WebGL) | wgpu cpu, `ranges` culling | wgpu GPU, `copy` (mean / p95) | wgpu GPU, `ranges` (mean / p95) | labels / triangles drawn (wgpu) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 5000-clean fit | 0.61 (0.57–0.73) / 0.75 | 0.86 / 1.62 | 0.78 (0.76–0.94) / 1.14 | 8.32 / 10.0 | 0.70 (0.68–1.15) / 1.04 | 36.5 (28.4–39.8) / 53.8; 17.9 fps | 0.57 (0.57–0.59) / 0.97 | 0.20 (0.20–0.21) / 0.33 | 0.86 / 2.07 | 0.71 / 1.39 | 0 / 327k |
| 5000-clean z035 | 0.32 (0.31–0.35) / 0.43 | 0.75 / 1.56 | 0.56 (0.44–0.78) / 2.00 | 8.30 / 10.2 | 0.62 (0.50–1.07) / 1.58 | 2.10 (1.88–2.14) / 3.08 | 0.28 (0.28–0.28) / 0.44 | 0.24 (0.23–0.25) / 0.43 | 0.66 / 1.46 | 0.63 / 1.39 | 201 / 16k |
| 5000-clean z1 | 0.26 (0.24–0.45) / 0.40 | 0.73 / 1.46 | 0.43 (0.29–0.53) / 0.72 | 8.32 / 11.3 | 0.43 (0.40–0.60) / 1.00 | 1.03 (0.93–1.06) / 1.61 | 0.23 (0.23–0.23) / 0.40 | 0.20 (0.19–0.20) / 0.29 | 0.58 / 1.26 | 0.66 / 1.67 | 43 / 4k |
| 5000-rope fit | 0.82 (0.71–0.90) / 1.05 | 1.46 / 3.64 | 0.95 (0.90–0.98) / 1.48 | 8.32 / 10.5 | 0.82 (0.75–2.19) / 1.30 | 46.6 (42.1–51.7) / 64.5; 18.5 fps (flat) | 0.70 (0.69–0.71) / 1.13 | 0.21 (0.20–0.21) / 0.34 | 0.88 / 2.18 | 0.83 / 1.65 | 0 / 430k |
| 5000-rope z035 | 0.40 (0.37–0.61) / 0.59 | 1.31 / 2.83 | 0.59 (0.48–0.80) / 1.48 | 8.30 / 10.1 | 0.64 (0.57–0.96) / 1.80 | 2.30 / 3.32 (flat) | 0.31 (0.29–0.31) / 0.47 | 0.25 (0.24–0.26) / 0.42 | 0.73 / 2.05 | 0.67 / 1.57 | 201 / 20k |
| 5000-rope z1 | 0.34 (0.30–0.35) / 0.49 | 1.28 / 2.27 | 0.34 (0.30–0.56) / 0.44 | 8.31 / 10.2 | 0.38 (0.37–0.62) / 0.52 | 0.93 / 1.33 (flat) | 0.26 (0.24–0.28) / 0.46 | 0.22 (0.21–0.23) / 0.35 | 0.75 / 1.88 | 0.74 / 1.67 | 43 / 5k |
| 50000-clean fit | **8.31 (5.59–11.1) / 19.3** | 2.13 / 3.57 | 4.18 (3.63–4.93) / 6.94 | **19.0 / 27.4** | 3.71 (3.45–4.43) / 5.82 | **633 (582–677) / 1118; nothing drawn** | 3.35 (3.09–3.39) / 5.37 | 0.31 (0.31–0.35) / 0.53 | 1.83 / 3.21 | 1.37 / 2.53 | 0 / 2901k |
| 50000-clean z035 | 0.65 (0.65–0.77) / 1.17 | 3.67 / 7.18 | 2.14 (1.78–3.73) / 3.46 | 8.28 / 10.4 | 3.58 (2.55–5.65) / 5.74 | 19.9 (18.8–20.9) / 26.6; 47 fps | 0.56 (0.55–0.57) / 0.82 | 0.33 (0.32–0.34) / 0.57 | 0.90 / 1.71 | 0.78 / 1.57 | 429 / 140k |
| 50000-clean z1 | 0.40 (0.39–0.41) / 0.71 | 1.67 / 4.53 | 1.49 (1.00–2.27) / 3.36 | 8.28 / 10.7 | 1.36 (1.21–2.17) / 4.44 | 6.12 (5.43–6.18) / 13.3; 100 fps | 0.45 (0.39–0.46) / 0.65 | 0.32 (0.29–0.38) / 0.49 | 0.73 / 1.70 | 0.68 / 1.33 | 99 / 22k |
| 50000-rope fit | **11.8 (10.5–16.8) / 24.3** | 2.24 / 4.11 | 4.31 (4.10–5.66) / 7.18 | **20.8 / 36.2** | 4.23 (3.67–4.36) / 6.54 | **1416 (1401–1552) / 1682; nothing drawn** | 4.09 (3.99–4.23) / 6.43 | 0.34 (0.31–0.35) / 0.58 | 2.00 / 3.01 | 1.82 / 3.00 | 0 / 3681k |
| 50000-rope z035 | 0.71 (0.60–0.86) / 1.13 | 3.66 / 6.89 | 2.05 (2.03–3.08) / 3.78 | 8.28 / 10.6 | 2.65 (2.30–3.32) / 4.98 | 18.6 / 24.8; 49 fps (flat) | 0.61 (0.58–0.65) / 0.89 | 0.35 (0.30–0.35) / 0.56 | 1.43 / 3.13 | 1.27 / 2.63 | 428 / 154k |
| 50000-rope z1 | 0.50 (0.48–0.64) / 1.04 | 2.66 / 5.49 | 1.10 (1.04–1.38) / 3.06 | 8.28 / 10.6 | 1.40 (1.29–2.70) / 4.86 | 6.47 / 15.5; 95 fps (flat) | 0.52 (0.44–0.52) / 0.81 | 0.31 (0.31–0.36) / 0.51 | 0.97 / 2.15 | 1.29 / 2.97 | 100 / 25k |

**Reading the table:**
- **5,000 nodes:** every engine except GPUI is under 1 ms per frame. Native wgpu with the same culling is within ±0.2 ms of WebGL. The wgpu GPU time is a synchronous upper bound; Chrome's comes from a timer query. Both are about 1 ms or less. No user-visible difference is plausible.
- **50,000, whole map:** this is the only cell where WebGL misses the 120 Hz target. Chrome's script is 8 to 12 ms, and WKWebView's rAF interval is 19 to 21 ms with only about 4 ms of script, so the time goes elsewhere (most likely the index upload through WebKit's GPU process; not verified).
  - The faithful wgpu port pays the same culled-index upload: 3.4 to 4.1 ms CPU, of which 2.4 to 3.2 ms is buffer writing.
  - `ranges` removes it: 0.31 to 0.34 ms CPU, and also 10 to 25% less GPU time.
  - So most of the "native is faster" margin here is a WebGL-portable algorithm change, not the language or the API.
- **50,000 zoomed in:** WKWebView script is 1.1 to 2.1 ms against 0.4 to 0.7 ms in Chrome, and wgpu is 0.3 to 0.6 ms. Something on the label or visible-set path is about 3x slower in JSC at 50,000 nodes. That is worth a profile in WebKit, but it is still within budget.
- **Chrome's GPU time at 50,000 z035** (3.7 ms) is 4 to 5x the wgpu figure (0.8 to 1.4 ms) for the same triangles and labels. I did not determine why; ANGLE's translation and the per-frame index upload inside the timed region are candidates.

### Text cost in the native renderer

wgpu `copy` mode, one run each, with labels drawn as glyph quads and with labels off:

| dataset / scenario | with labels: cpu mean / p95 | labels off: cpu mean / p95 | text drawn |
|---|---|---|---|
| 5000-clean fit | 0.57 / 0.97 | 0.57 / 1.01 | 0 labels, 0 glyph quads |
| 5000-clean z035 | 0.28 / 0.44 | 0.24 / 0.39 | 201 labels, 1206 glyph quads |
| 5000-clean z1 | 0.23 / 0.40 | 0.20 / 0.34 | 43 labels, 258 glyph quads |
| 5000-rope fit | 0.70 / 1.13 | 0.64 / 1.03 | 0 labels, 0 glyph quads |
| 5000-rope z035 | 0.31 / 0.47 | 0.24 / 0.37 | 201 labels, 1206 glyph quads |
| 5000-rope z1 | 0.26 / 0.46 | 0.22 / 0.34 | 43 labels, 258 glyph quads |
| 50000-clean fit | 3.35 / 5.37 | 2.84 / 4.57 | 0 labels, 0 glyph quads |
| 50000-clean z035 | 0.56 / 0.82 | 0.43 / 0.59 | 429 labels, 4290 glyph quads |
| 50000-clean z1 | 0.45 / 0.65 | 0.33 / 0.58 | 99 labels, 990 glyph quads |
| 50000-rope fit | 4.09 / 6.43 | 3.76 / 5.84 | 0 labels, 0 glyph quads |
| 50000-rope z035 | 0.61 / 0.89 | 0.51 / 0.81 | 428 labels, 4280 glyph quads |
| 50000-rope z1 | 0.52 / 0.81 | 0.37 / 0.66 | 100 labels, 1000 glyph quads |

- After the 1 s settle, text costs 0.04 to 0.15 ms per frame natively. Shaping and rasterising happen once per label and zoom bucket.
- The expensive part of text is first rasterisation (WebGL: Canvas2D per label; wgpu: swash per glyph). Neither renderer pays it in the timed window, because both settle first. I did not measure a cold, unsettled zoom.

### Presentation

- Not measured in any engine (locked screen).
- What is known:
  - WKWebView's rAF runs at 8.3 ms with the app's 120 Hz preference and at 16.7 ms without it.
  - The wgpu spike reported the built-in panel at 120,000 mHz through winit.
  - The wgpu offscreen loop held its 120 Hz pacing in every cell: median interval 8.3 to 8.9 ms, where the 0.5 ms excess is my timer, not frame cost.
- Whether a native CAMetalLayer or WKWebView actually presents at 120 Hz on the ProMotion panel needs a run with the screen unlocked.

## Load, upload, memory, binary size, build time

### wgpu spike

Median (lowest–highest) of 6 runs. Times are ms; MB is the sum of vertex and index buffers.

| dataset | MB uploaded | read .bin | parse scene.json | GPU buffer create + upload + wait | device + surface | font system (fontdb scan) | process start → first frame | macOS footprint, MB | max RSS, MB |
|---|---|---|---|---|---|---|---|---|---|
| 5000-clean | 11.0 | 3.01 (1.36–3.87) | 2.57 (2.11–2.91) | 4.07 (3.38–5.30) | 47.6 (43.5–50.3) | 38.3 (10.8–66.9) | 178 (149–202) | 332 (330–333) | 115 (114–115) |
| 5000-rope | 20.3 | 6.21 (2.15–8.17) | 2.71 (1.97–4.56) | 7.01 (5.17–7.75) | 47.3 (45.8–50.1) | 45.1 (12.8–74.9) | 195 (152–228) | 357 (354–359) | 134 (134–135) |
| 50000-clean | 97.9 | 25.9 (12.9–26.8) | 23.7 (20.9–24.9) | 21.1 (18.6–23.7) | 46.5 (45.3–52.2) | 13.7 (9.20–34.8) | 223 (195–247) | 581 (564–599) | 346 (345–346) |
| 50000-rope | 176 | 44.5 (19.9–46.9) | 23.1 (21.0–23.2) | 34.2 (27.2–107) | 45.3 (44.6–48.9) | 15.2 (8.93–19.6) | 253 (213–347) | 757 (733–779) | 511 (509–511) |

**wgpu spike binary:** 9.46 MB release (7.45 MB stripped); 152 crates. Clean release build: 25.3 s wall, 164 s user, with dependencies downloaded (load average 6 to 16 during the build).

**GPUI spike:**
- Binary 5.88 MB (4.54 MB stripped), 554 lines in `cargo tree`. Clean release build 92 s wall while the machine was loaded.
- First paint 150 to 650 ms (5,000) and 720 to 1,336 ms (50,000); this includes startup shader compilation.
- Peak RSS 2.4 to 6.2 GB in every config with the fit view, from per-frame vertex buffer churn.

**WebGL app, for comparison.** These numbers are **not comparable** to the native rows above: they include the whole app (model, layout worker, Svelte UI), while the spike is a renderer only.

| | 5000 clean | 5000 rope | 50000 clean | 50000 rope |
|---|---|---|---|---|
| Chrome, renderer + GPU process footprint, MB | 219 + 495 | 342 + 516 | 895 + 821 | 1444 + 847 |
| WKWebView, WebContent + GPU process footprint, MB | 350 + 241 | 395 + 242 | 1170 + 241 | 2030 + 245 |
| `loadSynthetic` → first frame with mesh, ms (Chrome / WKWebView) | 155–177 / 170–217 | (same map) | 1074–1161 / 1395–2384 | (same map) |
| theme clean → rope drawn, ms (Chrome / WKWebView) | 173 / 197 | | 1322 / 1824 | |

- WebGL's load includes layout and tessellation in the worker. The wgpu spike reads prebuilt buffers.
- The comparable upload step: wgpu creates and uploads 98 to 176 MB of GPU buffers in 21 to 34 ms (50,000) and 4 to 7 ms (5,000).

## Native computation ceiling: flat tessellation (`native-spike/tess/`, by a sub-agent)

**What was ported:** the whole flat `tessellateBatch` path plus `packMeshVertices`, ported to Rust.
- **Parity:** bit-identical output (SHA-256 of packed vertices, indices, span bounds and span ends equal to TS and to the app's own worker buffer), with 372,838 / 1,028,532 and 3,321,318 / 9,063,972 vertices / indices.
- **Coverage:** the synthetic map uses only `tapered` limbs with flow `h` and an underline. The other styles were ported but not checked against data.
- **Timing:** median of 15 builds, repeated 3 times (each run's median shown), under load.

| ms | 5k tess | 5k pack | 50k tess | 50k pack | 50k tess + pack |
|---|---|---|---|---|---|
| TS, Chrome V8 (main thread) | 5.2 / 5.3 / 5.4 | 3.6 / 3.9 / 3.8 | 38.9 / 51.0 / 45.0 | 26.1 / 35.8 / 33.7 | about 65–85 |
| TS, WKWebView JSC (warm) | 2.9 / 2.4 / 4.1 | 2.1 / 2.0 / 2.6 | 36.3 / 46.6 / 35.5 | 23.4 / 27.2 / 26.4 | about 60–74 |
| WASM, 1 thread, in Chrome | 1.9 / 2.0 / 2.1 | – | 18.6 / 18.1 / 19.4 | – | 40.0 / 38.5 / 41.0 |
| Rust, 1 thread | 1.59 / 1.62 / 1.63 | 1.67 / 1.67 / 1.68 | 22.0 / 15.6 / 18.3 | 26.9 / 18.6 / 16.0 | 52.8 / 36.6 / 30.5 |
| Rust + rayon, 10 threads | 1.10 / 0.62 / 0.66 | 0.99 / 1.14 / 0.48 | 5.2 / 7.2 / 7.4 | 4.7 / 5.3 / 4.1 | 10.3 / 10.1 / 9.6 |

- The first (cold JIT) TS build is 15 to 19 ms at 5,000 and 51 to 71 ms at 50,000.
- At 50,000 the work is memory-bound: about 210 MB written per rebuild.
- WASM's pack step was slow (about 21 of the 40 ms) and was not investigated.

**Moving the result into the WebView (measured).** A Swift WKWebView with a `WKURLSchemeHandler` serves N bytes (the way wry/Tauri 2 deliver raw IPC responses), timed from JS `fetch()` to `arrayBuffer()`. Batch means, 3 repeats. This is not real Tauri IPC, so it is a lower bound.

| ms per message | 16 B | 4 MB | 16 MB | 64 MB |
|---|---|---|---|---|
| WKWebView custom scheme → `fetch().arrayBuffer()` | 0.10–0.12 | 0.90–0.98 | 3.5–4.7 | 14.5–16.8 |
| Chrome Worker → page, transferred | 0.01–0.02 | 0.02–0.04 | 0.13–0.43 | 0.03–0.26 |
| Chrome Worker → page, structured clone | 0.02 | 0.66–0.82 | 3.3–4.0 | 14.2–16.9 |
| WKWebView Worker → page, structured clone | 0.02–0.04 | 0.32–0.38 | 1.25–1.38 | 5.0–5.9 |

- About 4.3 GB/s, so a 50,000-node flat mesh (66 MB vertices plus 36 MB indices) costs about 25 ms to deliver. Rayon's 10 ms plus 25 ms transfer is about 35 ms, against 65 to 85 ms in TS today, plus a second implementation of the geometry in Rust.
- **Side finding:** `layout.worker.ts` transfers only the packed `gpuVertices`. The main mesh's `positions`, `colors` and `indices` are structured-cloned on purpose, so the worker keeps its branch cache. At 50,000 nodes that is about 142 MB copied per rebuild: roughly 35 ms in V8 and about 14 ms in JSC at the measured clone rates. This is worth revisiting independently of native work.

## What a full native migration would have to rebuild

The WebView currently provides all of the following, and a native renderer (wgpu, or GPUI, or AppKit plus Metal) would need each one rebuilt:

- **The application core.** `src/lib/core` is about 21k lines of TS (model, undo, layout, geometry, themes, IO for nine formats). `src/lib/ui` is about 23k lines plus 67 Svelte components (about 10k lines).
  - Native rendering alone still needs the TS core. Either keep it in a JS engine (a WebView or an embedded JSC/QuickJS) and send scenes across a bridge every rebuild (25 ms per 100 MB as measured), or port it to Rust.
- **Label editing:** text input, selection, IME composition (CJK), spell check and autocorrect. The app relies on browser inputs and `contenteditable`; about 135 lines with an input, a textarea or contenteditable appear in `src/lib/ui/*.svelte`.
  - wgpu and winit give raw IME events only.
  - GPUI has an editor stack, but it is Zed's, with no stable public widget library.
- **Notes:** Markdown (markdown-it) and KaTeX rendered as HTML.
  - A native app needs its own Markdown layout and a math typesetter. There is no mature Rust KaTeX equivalent that renders to a GPU surface.
- **Panels:** every Svelte panel (inspector, theme settings, AI panels, presentation, finder, outline and so on) needs a native UI toolkit.
  - There is no mature Rust toolkit with native macOS look and accessibility. GPUI is closest but unstable (0.2.x) and Zed-shaped.
- **Accessibility:** 64 source files under `src` use ARIA roles or attributes today. A native canvas needs an accessibility tree by hand (AccessKit) for nodes, panels and dialogs.
- **Export to SVG and PDF:** `export-visual.ts`, `svg2pdf.js`, `jspdf` and print layout. Today's exporters reuse DOM and SVG; native needs its own SVG writer and PDF backend (for example krilla or printpdf) with identical text layout.
- **Drag and drop, clipboard formats, image decoding (all formats WebKit decodes), SVG art rasterisation** (today the browser rasterises SVG), and ThumbHash and picture textures.
- **Shaders and themes.**
  - 13 GLSL programs (about 500 lines) need rewriting in WGSL: mesh, five materials (flat, clay, arcs, rope, quilling), shadow layer and composite, rects and raised rects, soft shadows, surface, grid, textures and blur.
  - This spike ported 6 of them in a few hours, so this part is the cheap part.
  - The 60 themes are data in `core/model/themes.ts` and would carry over as data, once the core runs natively.
- **Hot reload and dev tooling:** Vite and Svelte dev loops, the `__radiant` hooks, and Playwright-based checks would be replaced by Rust rebuilds (25 s clean for the spike; incremental 3 to 10 s).

## Hybrid options considered

1. **Native wgpu surface under a transparent WKWebView, canvas only.**
   - Technically possible on macOS: a CAMetalLayer-backed NSView below a WKWebView with a transparent background.
   - Costs:
     - Camera and scene state cross the JS–Rust boundary every frame. Round-trip latency is 0.1 ms or more for a tiny message, and scene rebuilds are about 25 ms per 100 MB.
     - The WebView's own layers (labels, if left in HTML; selection overlays) and the Metal layer present independently, so they can drift by a frame during pans.
     - Input hit-testing has to be split between the two, plus resizing and DPI changes.
   - Today's numbers show WebGL is not the bottleneck at 5,000 nodes. At 50,000 nodes the bottleneck is an algorithm that WebGL can fix. **Not justified now.**
2. **Native computation, WebGL drawing** (a Tauri command returns packed buffers).
   - Saves about 30 to 50 ms per full 50,000-node rebuild in the best case (rayon) after transfer.
   - Costs a second geometry implementation, or a full move of geometry to Rust.
   - Edits already reuse unchanged branches through `BranchMeshCache`, so a full rebuild is rarer.
   - **WASM in the existing worker** gets about half of the gain (40 ms against 65 to 85 ms) with no IPC and no src-tauri change. It is the better first step if rebuild time at 50,000 nodes becomes a priority.
3. **WebGPU inside the WebView.** Not evaluated here. WKWebView WebGPU availability on the target macOS was not checked.

## Actionable items this spike produced for the WebGL app

All are untested in the app itself. The wgpu measurements show the size of the first one.

1. **Stop rebuilding the culled index buffer every frame.**
   - Keep the full index buffer resident and issue one `drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, startByteOffset)` per contiguous visible run of spans. Fall back to the copy only if the run count is large: there were 5 to 15 runs in every cell measured.
   - Apply it to the shadow layer too, since it draws the same indices.
   - In the wgpu port this cut 50,000-node whole-map CPU from 3.35 to 0.31 ms (clean) and from 4.09 to 0.34 ms (rope), and GPU time by 10 to 25%.
   - It most likely also fixes WKWebView's 43 to 64 fps at 50,000 nodes (not verified).
2. **Level of detail at far zoom.** At the 50,000-node whole-map zoom (0.0022) the renderer submits 2.7 to 3.7 M triangles, almost all sub-pixel. That costs 1.4 to 2.4 ms GPU natively and 2.1 to 2.2 ms in Chrome. Skipping spans under a pixel, or drawing a coarse polyline set, would cut both.
3. **The structured clone of positions, colours and indices** from the layout worker (about 142 MB at 50,000) is measured at about 4 GB/s in Chrome. It deserves its own experiment, for example transferring a copy made in the worker in place of cloning on post.
4. **JSC is about 3x slower than V8** on the zoomed-in 50,000-node frame (1.1 to 2.1 ms against 0.4 to 0.7 ms). A WebKit profile of `drawLabels` and `viewport.query` would show where.

## What I could not measure or did not verify

- Presented frame interval and 120 Hz on the ProMotion panel, for any engine (the screen was locked).
- A comparable GPU time:
  - wgpu: synchronous wall time, an upper bound; Metal pass timestamps were unusable in wgpu 30.
  - GPUI: none.
  - WebGL: Chrome only, through the timer-query extension, not available in WebKit.
- Memory on equal terms: the native spikes are renderers only; the WebView numbers are the whole app.
- Clay, arcs and quilling materials, images, canvas elements and overlays in the native port; the cold (unsettled) label rasterisation cost.
- Real Tauri IPC (the transfer numbers use a bare `WKURLSchemeHandler`), and WebGPU in WKWebView.
- Whether the per-frame index upload is really what holds WKWebView to 43 to 64 fps at 50,000 nodes (inferred from the wgpu measurement, not profiled in WebKit).

## Files

In the repository:
- `radiant/autoresearch/native-spike/`
  - wgpu spike: `Cargo.toml` (empty `[workspace]`), `src/main.rs`, `src/shaders.wgsl`, `.gitignore`.
  - `gpui/`: GPUI spike, its own crate.
  - `tess/`: Rust tessellation port and benchmark, its own crate.
  - `scripts/`: `export.py` (scene export), `webgl_shot.py` (WebGL captures), `EXPORT-FORMAT.txt`.
  - `results/`: `wgpu-summary.json`, `gpui-summary.json`, `gpui-frames-summary.csv`, `tess-summary.json`, `webgl-summary.json` and `webgl-summary.txt`, `camera-path.json`.

Raw per-frame data, harnesses and captures, in the session scratch folder `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/native/` (temporary):
- `export/` (datasets);
- `wgpu/runs` (36 runs) and `wgpu/shots`;
- `gpui/` (runs, captures, notes);
- `tess/` (specs, Swift transfer benchmark);
- `webgl/` (runs, memory, Swift WKWebView harness, Playwright drivers).

How to rerun the wgpu cells:
```
cd radiant/autoresearch/native-spike && cargo build --release
target/release/wgpu-spike --data <scratch>/export/50000-rope --cams <scratch>/export/camera-path.json --size 50000 \
  --offscreen 1 --cullmode ranges --gpusync 1 --dur 5 --warm 1 --out run.json [--labels 0] [--shot prefix]
```
Drop `--offscreen 1` to present to a window, when the screen is unlocked.
