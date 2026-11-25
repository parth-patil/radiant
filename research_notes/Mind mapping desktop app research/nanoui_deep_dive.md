# nanoui (justrach/nanoui) deep dive: fit for a canvas-heavy, 120 Hz mind-mapping app (as of 2026-11-17)

Method: I read the repo through the GitHub REST API and raw.githubusercontent.com (main branch, 2026-11-17). I did not clone, build or run anything. Labels: **[source]** = confirmed in code or docs I read (file path given); **[README]** = claimed in README or docs only; **[not found]** = I looked and did not find it; **[inference]** = my judgement or arithmetic. Repo text was treated as data. Raw files are under `https://raw.githubusercontent.com/justrach/nanoui/main/<path>`. Paths below are relative to that.

I did not read the full text of `src/ui/text.zig`, `textfield.zig`, `context.zig` or the web-mode IPC internals. Claims in those areas are limited to what I list.

## 1. Identity and vital signs

### Takeaway
Identity confirmed: `justrach/nanoui` is the only Zig project of that name with traction. It is a 4-week-old, MIT, 0.x framework with very fast releases (27 tags in 28 days). A single maintainer wrote most of it, using visible AI-agent tooling. Zig 0.17.0 is required. The API is explicitly unstable between minor versions.

### Cited Findings
- Repo description is "Desktop apps in Zig, with native UI drawn on the GPU or a web frontend". 908 stars, 49 forks, MIT, created 2026-10-18, last push 2026-11-16, default branch `main`, no topics. — [GitHub API](https://api.github.com/repos/justrach/nanoui)
- The README banner reads "Desktop and mobile apps in Zig". It lists macOS, iOS, Android, Linux and Windows, and says "Built in Zig 0.17" and "You need Zig 0.17.0". — [README](https://github.com/justrach/nanoui)
- 27 releases in 28 days: v0.1.0 on 2026-10-19 through v0.14.6 on 2026-11-15. Recent tags: 0.14.0 on 11-09, 0.14.1 on 11-12, 0.14.2, 0.14.3 and 0.14.4 on 11-13, 0.14.5 and 0.14.6 on 11-15. — [Releases API](https://api.github.com/repos/justrach/nanoui/releases?per_page=40)
- Versioning policy: "While nanoui is 0.x, a minor release may change the API; a patch release won't." — [README](https://github.com/justrach/nanoui)
- 20 contributors by commit count: justrach 591, jhodges10 80, zcg 22, KercyDing 11, theprimeradiant 11, mabrahamsen 7, j0x3n 6, `cursoragent` 5, gstohl 5, xingguang2024 5, and 10 more. `claude` also appears with 1 commit. — [Contributors API](https://api.github.com/repos/justrach/nanoui/contributors?per_page=30)
- About 76% of commits are from the author (591 of the ~775 counted). Real outside contributors fix Windows, Linux and IME issues. Recent outside PRs from jhodges10 add video textures, colour management and a GPU hook. — [Contributors API](https://api.github.com/repos/justrach/nanoui/contributors?per_page=30), [Issues/PRs API](https://api.github.com/repos/justrach/nanoui/issues?state=all&per_page=60)
- Maintainer: GitHub user `justrach` ("Rach"), an individual account created 2019-08-25 with 234 public repos and 415 followers. No company is stated. I found no funding or sponsorship statement and no roadmap document in the repo root. — [GitHub users API](https://api.github.com/users/justrach), [repo root listing](https://api.github.com/repos/justrach/nanoui/contents)
- Same author's showcase apps: nanolight (405 stars), nanomon (102), nanoterm (43), nanodocs, nanostudio, nanofly, plus `apps/nanobrowser` (a browser engine in Zig) and `apps/nanocua`. A third-party app, nanomail, is by gstohl. Small third-party apps exist (`lax`, `popzlip`, `nanoview`). — [GitHub search](https://api.github.com/search/repositories?q=nanoui+zig+in:name,description), [README](https://github.com/justrach/nanoui)
- Origin: "nanoui began as a port of its core to Zig" from `egoist/mygo` (a Go framework). The UI style comes from Zed's GPUI, the motion from gpui-motion, and the component kit from Longbridge's GPUI Kit. — [README Credits](https://github.com/justrach/nanoui)
- Agent-driven development, confirmed in source:
  - `AGENTS.md` is in the root, with `.agents/`, `hillclimb/`, `lean-proofs/` and `.githooks/`.
  - AGENTS.md rules include "Every file is at most 600 lines", "Never show windows on the developer's screen" and "Never drive the real screen".
  - The `nui` CLI is for "people and for coding agents alike" and scaffolds an AGENTS.md into each new app.
  - Bot accounts `cursoragent` and `claude` appear among contributors.
  — [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md), [README](https://github.com/justrach/nanoui)
- Review and CI: v0.14.4 notes say "green macOS, Linux and Windows CI; Android and iOS platform builds; native/portable tests; existing Lean proofs; and paired headless performance checks". Release 0.14.4 "integrates all eight open PRs". — [v0.14.4 release](https://github.com/justrach/nanoui/releases/tag/v0.14.4)
- Open items on 2026-11-16: 3 PRs (#202 colour-managed textures, #203 Windows input starvation, #204 EDR textures) and issues #201 (macOS: Dock-icon click does not restore a minimized window) and #199 (`ui.text` and tooltips draw whatever replaced a string that does not outlive the view call, a dangling-string bug). The API reports `open_issues_count` as 6. There were 204 issues and PRs in 29 days. — [Issues API](https://api.github.com/repos/justrach/nanoui/issues?state=all&per_page=60)
- Other "Nano UI" projects:
  - `KevinKelley/nanoui` is an old Rust NanoVG-based UI, unrelated (from the first pass).
  - GitHub search for nanoui, nano-ui and Zig returns only `justrach`-ecosystem repos plus `mabrahamsen/nanoui-controls` (0 stars).
  - The Codeberg search endpoint returned non-JSON and I could not check Codeberg. I also did not check the Zig-specific `zig-nanoui` spelling beyond the GitHub name search.
  — [GitHub search](https://api.github.com/search/repositories?q=nano-ui+OR+nanoui+language:Zig&per_page=8)

### Inferences
- Pace is the headline risk. The release notes contain no breaking-change lists, so I could not extract any from the changelog. Per the README, every minor bump (0.11 to 0.14 in 12 days) "may change the API".
- Review quality looks CI-heavy (cross-OS builds, pixel-parity tests, Lean specs) but there is very little independent human review. The author merges his own PRs. A bug like #199 (dangling string lifetime) is the kind of memory-safety risk that fast agent-written Zig carries.
- Bus factor is about 1, with a healthy number of drive-by contributors.

### Gaps
- No stated funding or roadmap. No Codeberg check. No breaking-change inventory, because the release notes are PR lists only.

## 2. Architecture

### Takeaway
nanoui is an immediate-mode UI. The view is a function of your state, run on each event, with flexbox layout and GPUI-style builders. It renders to a single instanced Metal draw call per frame on macOS, redraws only on demand, and paces frames with CADisplayLink at up to 120 Hz. There is no retained scene graph, and shapes live for one frame.

### Cited Findings
- "Views are immediate mode: a function of your state, run on every event. Widgets answer from the previous frame's layout. When an interaction changes state, the frame is built again before it's drawn." State is yours, held in a struct passed by pointer (`View.init(&state, Counter.view)`), with no message or update loop framework. Small per-widget state sits in `Context.state`. — [README](https://github.com/justrach/nanoui)
- Nothing polls: "Frames are drawn on input, resize, or while an animation runs; an idle app uses no CPU." — [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md)
- Pacing: `src/ui/pacing.zig` asks CADisplayLink for the screen's fastest rate. `range(0, 120)` returns min 60, max 120, preferred 120, "a ProMotion display's 120", or a fixed fps when asked. Scroll deltas are batched and applied once per display-link frame. Surface docs say "Paces animation frames at the display's refresh (CADisplayLink)". — [src/ui/pacing.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/pacing.zig), [src/ui/surface.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/surface.zig)
- nanodocs claims "120 Hz transaction-synced live resize". nanomon has a task titled "proof-backed-120hz". — [README](https://github.com/justrach/nanoui), [commit list](https://api.github.com/repos/justrach/nanoui/commits?per_page=30)
- Threading: "AppKit, WebKit and the UI run on the main thread. Work from other threads reaches it through `objc.dispatchMain`." v0.14.0 added "frames asked for from any thread" (a `redraw()` callable from workers, with `surface_thread_wake.zig`). `App.after(ms, ctx, fn)` is a timer, and `App.onMain` queues a call. `http.zig` has a "worker-thread-safe synchronous send()". — [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md), [v0.14.0](https://github.com/justrach/nanoui/releases/tag/v0.14.0), [v0.14.1](https://github.com/justrach/nanoui/releases/tag/v0.14.1)
- Renderers (README platform table):

  | Platform | Rendering | Text | Shown in README |
  |---|---|---|---|
  | macOS and iOS | Metal | CoreText | |
  | Linux | OpenGL 3.3 or ES 3 in a GtkGLArea. The window closes if GL is unavailable unless `NANOUI_RENDERER=cpu` | nanoui's own TrueType reader (`src/ui/tt/`) | GTK 4, else GTK 3, loaded with `dlopen` |
  | Windows | CPU rasteriser shown through a Direct3D 11 flip swap chain | the same own TrueType reader (DirectWrite files also exist: `dwrite.zig`) | |
  | Android | OpenGL ES 3 or CPU | own TrueType | |

  No Vulkan, no wgpu and no WebGPU. The same README says "The CPU renderer matches the Metal one pixel for pixel, and a test compares them". — [README Platforms](https://github.com/justrach/nanoui). Note the README table says Windows uses the CPU renderer presented by D3D11, but `src/ui/d3d11.zig` (27 KB) and `shader.hlsl` exist and the README summary says "Direct3D 11" renders. The first pass's "D3D11 landed in 0.14.0" probably refers to the D3D11 texture path. I did not resolve which of the two is the Windows main path today.
- Metal renderer: `src/ui/gpu.zig` defines one `Instance` struct (192 bytes, asserted at comptime). It is a quad with rect, colour, border, uv, clip, radius, a 2×3 affine (`m`, `mt`), rotation `xf`, a pulse and a 3D turn. Kinds are quad, text, shadow, image, glass, shadow_out, segment (line), triangle, texture, layer_begin/end/composite and hole. `src/ui/metal.zig` uses a "ring of instance buffers" and one `drawPrimitives:...instanceCount:` call. — [src/ui/gpu.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/gpu.zig), [src/ui/metal.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/metal.zig)
- Text: CoreText on macOS, with glyphs rasterised once into an atlas. `src/ui/shaper.zig` has an "exact fast path for printable ASCII". `ui.registerFont` and `TextStyle.family` handle bundled fonts and font stacks. CJK line breaking and UAX #29 grapheme selection landed in 0.14.4 and 0.14.5. `docs/desktop-parity.md` shows `wrap_rule`, `glyph_snap` and `baseline_rule` knobs. — [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md), [README](https://github.com/justrach/nanoui), [docs/desktop-parity.md](https://raw.githubusercontent.com/justrach/nanoui/main/docs/desktop-parity.md), [v0.14.6](https://github.com/justrach/nanoui/releases/tag/v0.14.6)
- HiDPI: the CPU canvas, the image atlas and SVG are all described "at the screen's density". `Frame` carries `scale`. — [README](https://github.com/justrach/nanoui), [src/ui/canvas.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/canvas.zig)
- Scroll retention: `src/ui/retain.zig` lets a scroll that "only moved its offset" draw "the last scene shifted, instead of building, measuring and painting the window again". It does not apply when rows are omitted (`ui.list`) or the tree has nested clips. This is the only frame-to-frame scene reuse I found. — [src/ui/retain.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/retain.zig)

### Inferences
- A mind-map frame that pans, zooms or animates rebuilds the whole instance list on the CPU every frame. Every drawable becomes one 192-byte `Instance`. There is no persistent geometry.
- Bidi, complex shaping and emoji: CoreText gives them on macOS. I did not verify the portable TrueType path (Linux and Windows), and its shaper is custom. Weak there for Arabic or Indic scripts. [not found] in what I read.

### Gaps
- I did not read `text.zig` for per-glyph or arbitrary-transform text, `context.zig`, or the Windows renderer decision. I did not verify the ProMotion behaviour on a real device.

## 3. The canvas API (`ui.canvas`)

### Takeaway
`ui.canvas` is a small, per-frame, CPU-built set of lines, triangles and polygons, all emitted as instances. It has no Bezier curves, no stroked or filled paths, no gradients, no clipping API of its own, no retained geometry, no variable-width strokes and no text-on-curve. It cannot carry the branch workload as-is. The one real escape hatch for a custom canvas is a GPU hook (`before_encode`) that renders into your own MTLTexture, which nanoui then composites (`ui.texture`).

### Cited Findings
- Header: "A box to draw in (`ui.canvas`): lines, filled triangles and polygons, circles and rounded rectangles, at points within the box. They are drawn as the frame paints the box, clipped to it, and kept only for the frame". — [src/ui/draw.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/draw.zig). Note `src/ui/canvas.zig` is a different thing: the CPU renderer's pixel buffer for Linux and Windows windows, not the user-facing `ui.canvas`.
- Complete primitive list, from `draw.zig`:
  - `line(a, b, Stroke)` with round ends and an optional dash.
  - `polyline(points, Stroke)`, a chain of `line` calls.
  - `triangle(a, b, p, color, smooth)`, where `smooth` is a bitmask of which edges are anti-aliased.
  - `mesh(points, tris, color)` for pre-triangulated geometry.
  - `fill(points, color)`, which runs `triangulate` on the CPU each call ("its outline once round, either way; no holes").
  - `circle`, `rect(r, color, radius)` and `ring`.
  - `Stroke = { width, color, dash }`, with a single constant width and a solid colour.
  - Each call appends one `gpu.Instance` to `shapes`.
  — [src/ui/draw.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/draw.zig)
- No Bezier method exists in the canvas API: [not found] in `draw.zig`. Beziers would have to be flattened by the app. dvui's `Path.Builder` has `addQuadBezier` and `addCubicBezier` (flattened to 0.5 px). — [dvui Path.zig](https://raw.githubusercontent.com/david-vanderson/dvui/main/src/Path.zig)
- Anti-aliasing is analytic, per instance, in the fragment shader, with no MSAA: `line_color` computes distance to the segment and `smoothstep` over `fwidth`. `triangle_color` computes per-edge signed distance for the edges named in `smooth`, so shared edges are left unsmoothed to avoid seams. Overlapping translucent segments in a polyline will double-blend at the round joints. — [src/ui/shader.metal](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/shader.metal)
- Each triangle instance covers its bounding rect (quad), and the line quad covers the segment's box. A long diagonal sliver costs fragment-shader area proportional to its bounding box. [inference from the vertex code, which emits the rect quad but clips by SDF]
- Transforms: `Style.transform` (an `Affine`) moves a subtree's instances after they are made ("keeps layout, painting and culling unaware of it"). The Metal shader also takes a separate rotation (`xf`), a pulse scale and a 3D turn per instance. Clips stay axis-aligned rectangles ("each clip stays a rectangle of the window"). There is no clip path. — [src/ui/paint_xform.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/paint_xform.zig), [src/ui/gpu.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/gpu.zig)
- Fills and blending: solid colours, vertical two-colour gradient (`Style.gradient`), many-stop gradient (`gradient_stops`), Gaussian shadows, Liquid Glass. Opacity is baked into per-instance colour alpha. Blend is premultiplied-over only. [not found]: other blend modes, radial or angular gradients on canvas shapes. — [src/ui/gpu.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/gpu.zig)
- Offscreen: the Tester and snapshot path render offscreen (`metal_offscreen.zig`). Layers (`layer_begin/end/composite`) exist for scroll fades and masks. [not found]: a public user-level render-target API for caching a drawn subtree. — [src/ui/gpu.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/gpu.zig), [README](https://github.com/justrach/nanoui)
- Raw GPU access, confirmed in source:
  - `ui.metalDevice()` returns the device nanoui draws with.
  - `Surface.before_encode` takes a `BeforeEncode{ctx, func(ctx, cmd_buffer)}`. The app gets the frame's `MTLCommandBuffer` before nanoui encodes into it, so it can encode its own compute or render passes.
  - `ui.texture(c, style, Texture, uv, opacity)` and `ui.textureAffine` draw an app texture, where `Texture.mtl_texture` is an app MTLTexture ("A float or sRGB one holds linear light"). `Texture.bgra` is a CPU path.
  - A test, `src/ui/tests_gpu_hook.zig`, encodes a Metal compute kernel in `before_encode` that fills an RGBA16Float texture which the same frame shows.
  - `Surface.after_frame` and `Surface.nativeHandle()` (the NSView) also exist.
  - This landed in 0.14.0 ("Video textures through the colour stage, LUTs, a GPU hook, cursors and many-stop gradients", PR #146, by an outside contributor).
  — [src/ui/gpu.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/gpu.zig), [src/ui/metal_app.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/metal_app.zig), [src/ui/tests_gpu_hook.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/tests_gpu_hook.zig), [src/ui/surface.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/surface.zig), [v0.14.0](https://github.com/justrach/nanoui/releases/tag/v0.14.0)
- The `examples/map` "map" example is not a vector canvas. It is a MapKit view (iOS: "MapKit under the UI on iOS, a placeholder elsewhere") with pins and a route line, plus a card list. It draws no canvas primitives. `nanofly` reportedly uses `ui.canvas` for night-side, radar and plane markers, but I did not read nanofly's source. — [examples/map/main.zig](https://raw.githubusercontent.com/justrach/nanoui/main/examples/map/main.zig), [src/nanoui.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/nanoui.zig), [README](https://github.com/justrach/nanoui)
- Published benchmark scenes (hillclimb): boxes (600 shadowed boxes), text (300 labels), scroll (1000 rows), list (100,000-row virtual list), dashboard (12 cards). Median frame CPU 0.015 to 0.315 ms on M3 Ultra, headless. They compare against `mygo` and Clay only. No path, line, triangle or canvas scene is listed. — [README Performance](https://github.com/justrach/nanoui), [hillclimb/README.md](https://raw.githubusercontent.com/justrach/nanoui/main/hillclimb/README.md)

### Inferences (my arithmetic, labelled)
- A cubic branch flattened to about 20 to 30 segments costs 20 to 30 `Instance`s (192 B each) if drawn as `line`s. A tapered filled ribbon is about 40 to 60 triangles, so about 8 to 12 KB per branch. For 5,000 branches that is roughly 100,000 to 300,000 instances, or about 20 to 55 MB of instance data built and uploaded each frame. At 120 Hz that is roughly 2.3 to 6.6 GB/s of CPU-written memory, plus CPU re-triangulation if `fill` is used. That is not realistic without app-side culling to the visible set. Culling plus LOD could cut it by an order of magnitude, but the architecture is still the wrong shape for "thousands of cached Beziers".
- Tapered strokes: a chain of `line` instances with varying `Stroke.width` and round ends approximates a taper. A true filled outline needs pre-made triangles through `mesh`, with per-triangle instance cost.
- Text along a curve: [not found] as an API. In principle each glyph could be a transformed box (`Style.transform` rotates instances). Atlas glyph sharpness under rotation and scale is not documented, and I did not verify it.
- The correct way to use nanoui for the canvas is to not use `ui.canvas`. Use `before_encode` plus `ui.texture` to composite your own Metal render pass output. The texture is drawn as one quad and "blended" over nanoui content. Hit-testing and gestures would have to be done by you from `input.zoom`/`input.pan` and pointer events.

### Gaps
- Whether a custom pass can be drawn directly into the drawable (versus into an offscreen texture then composited, with an extra pass and memory) is unclear. Whether `before_encode` is public on the macOS `App` path is verified only via the field on `Surface` and the test.
- No way found to embed a CAMetalLayer or custom NSView inside the layout (see section 7). Docked pages exist, so the reverse (a WKWebView inside the native window) does.

## 4. Images and SVG

### Takeaway
Images go into a single BGRA atlas, downscaled to at most 1024 px on the long side by default, with no mipmaps and a linear sampler. That is fine for thumbnails and wrong for a deep-zoom canvas of hundreds of images. SVG is a real in-house parser and rasteriser that targets icon-class documents. It rasterises to a pixel size, not to vectors. It has no text, filters, patterns or images, so it would not render arbitrary LLM-generated illustrations fully.

### Cited Findings
- Images: "pictures decoded once from encoded bytes, or copied once from caller-held pixels, scaled to the pixels a box needs, at most `Limits.picture_side`, and packed into one BGRA atlas the renderers sample (premultiplied). ... when full, pictures no longer drawn leave and the rest are packed again, the frame painted again". Defaults: atlas 2048, `max_side` 1024, decoded cache 12 MiB, refused above 64 megapixels. `Limits` can raise `picture_side`, `atlas_side` (the atlas doubles when needed) and `decoded_bytes`. — [src/ui/images.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/images.zig)
- Formats: ImageIO on Apple platforms (`image.zig`); own PNG, JPEG (baseline and progressive) and GIF-first-frame decoders elsewhere. A MIME allowlist includes png, jpeg, gif, svg and, in a second list, webp, heic, heif, avif, tiff, bmp and ico (probably the ImageIO-only formats, which I did not verify). EXIF orientation support landed in 0.14.5/0.14.6. Alpha is premultiplied BGRA. — [src/ui/images.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/images.zig), [v0.14.6](https://github.com/justrach/nanoui/releases/tag/v0.14.6)
- No mipmaps: the atlas texture is made with `texture2DDescriptorWithPixelFormat:...mipmapped:` set to NO, and the shader samples with `constexpr sampler s(filter::linear, address::clamp_to_edge)`. Plain linear minification will alias on heavy downscales. Atlas eviction is "reset and repack" (`resets` counter, `reset_during_frame`) rather than per-image LRU. — [src/ui/metal.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/metal.zig), [src/ui/shader.metal](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/shader.metal), [src/ui/images.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/images.zig)
- Async loading: [not found] in `images.zig`. Decode happens when a picture is first requested in the view. The README says nanomail loads web pictures "only when you ask", and `--nanoui-wait` lets "what an app loads as it draws (pictures, a map's tiles, replies)" arrive. `nanoui.http` offers a worker-thread-safe `send()`. An app would do its own background decode and then hand over `.pixels`.
- Custom textures, as an alternative path: `ui.texture` accepts BGRA CPU bytes or an app MTLTexture, so an app could run its own image streaming, mip generation and virtual texturing.
- SVG (`src/ui/svg.zig`): supports `svg` (nested, viewBox, preserveAspectRatio), `g`, `use`, `symbol`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`; fills (nonzero, evenodd), strokes (width, caps, joins, miter limit, dashes), linear and radial gradients, group opacity, clip paths and masks, `transform`, `style` and `<style>`, CSS colours, `var()` and `currentColor`. "What it doesn't draw: text, `image`, patterns, markers, filters and `foreignObject`." `render()` returns premultiplied BGRA of a given pixel `width` × `height`, up to 8192×8192. `ui.svg` is documented for "icons and marks ... drawn by nanoui at the screen's density on every platform". — [src/ui/svg.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/svg.zig), [README](https://github.com/justrach/nanoui)

### Inferences
- The SVG renderer is the most directly reusable piece for the app. It is a pure-Zig `svg.render(gpa, bytes, .{width, height})` function that could be called on its own to rasterise SVG subtrees into textures at zoom thresholds. Gaps versus LLM-made SVG: no text, no filters, no patterns, no markers, so those elements would silently disappear.
- Memory for hundreds of images: the 2048² to 4096² BGRA atlas (16 to 64 MB) holds only what one frame shows, at ≤1024 px each. At deep zoom, images would look soft or alias unless you raise `picture_side`, which then forces atlas growth. Your own mip chain and textures through `ui.texture` are likely better.

### Gaps
- No evidence about async decode scheduling inside nanoui, or any maximum texture size beyond the 64 MP cap.

## 5. Input, text editing, platform integration

### Takeaway
Input coverage on macOS is unusually good for a Zig library: real NSTextInputClient IME, pinch zoom, momentum-phase scroll, drag-and-drop of files, native menu bar and context menus, open/save panels, clipboard, VoiceOver for built-in controls. There is no undo framework, no window state restoration and no custom NSView embedding. The Objective-C runtime is exposed (`nanoui.objc`), so you can call AppKit directly.

### Cited Findings
- Pinch and pan: `magnifyWithEvent:` is handled in `src/ui/surface_events.zig`, feeding `input.zoom` (a multiplicative factor "about the pointer") and `input.pan`. Magnify events faster than the refresh are coalesced. `input.zoom` and `input.pan` also come from iOS two-finger gestures. `scrollWheel` reads `scrollingDeltaX/Y`, `phase` and `momentumPhase`, sets `in.scroll_phase` (began, changed, momentum, ended) and `precise`. [not found]: `smartMagnifyWithEvent:` or rotate gestures. — [src/ui/surface_events.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/surface_events.zig), [src/ui/input.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/input.zig)
- Keyboard: shortcut accelerators in menus ("CmdOrCtrl+N"); v0.14.0 "every key offered as a shortcut, unshifted; menu key equivalents held back"; v0.14.1 reports key release, auto-repeat and release-on-focus-loss; `keymap_emacs.zig` and `keymap_vim.zig` exist. `focusNext` and "focusable boxes" exist. — [src/menu.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/menu.zig), [v0.14.0](https://github.com/justrach/nanoui/releases/tag/v0.14.0), [v0.14.1](https://github.com/justrach/nanoui/releases/tag/v0.14.1)
- Text fields: `ui.textField`, multiline with wrapping, selection, composition and clipboard (`textfield.zig`, `textfield_lines.zig`). A test describes "a multiline text field, as Harness's composer: text wraps ... Shift-Return starts a line ... a click lands on the line under it ... past its most lines the field scrolls". The IME is a real NSTextInputClient implemented on a runtime-created class: `setMarkedText:selectedRange:replacementRange:`, `selectedRange`, `attributedSubstringForProposedRange:`, `firstRectForCharacterRange:`. — [src/ui/tests_multiline.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/tests_multiline.zig), [src/ui/textinput.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/textinput.zig), [src/ui/surface.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/surface.zig)
- Text-field IME status elsewhere: README says IME on macOS, iOS and Linux (GTK input method). Windows and Android are "not yet" in the README table. But `docs/windows-ime.md` documents a Windows IME implementation in `src/windows/ime.zig` with an unresolved bug ("the candidate list never showed", and Doubao could not type). The README table is therefore stale or optimistic for Windows. — [README Platforms](https://github.com/justrach/nanoui), [docs/windows-ime.md](https://raw.githubusercontent.com/justrach/nanoui/main/docs/windows-ime.md)
- Rich text editing inside a node (spans with per-range styling, an inline editor in a rich label): [not found]. `ui.richText` and spans are display and selection only; the field is a plain-text buffer (`ui.TextBuffer`).
- Selection: text "can be selected and copied like a terminal's"; UAX #29 grapheme selection landed in 0.14.5. — [README](https://github.com/justrach/nanoui), [v0.14.6](https://github.com/justrach/nanoui/releases/tag/v0.14.6)
- Drag and drop: `c.acceptDrop(box.index)` then `c.dropAt(box.index)` returns file URLs ("A drop's URLs last for its frame"). It is files only as far as the example shows. `drag_payload.zig` and `Drop` per HDROP on Windows exist. Dragging items out of the app: [not found]. — [examples/drop/main.zig](https://raw.githubusercontent.com/justrach/nanoui/main/examples/drop/main.zig), [v0.12.0](https://github.com/justrach/nanoui/releases/tag/v0.12.0)
- Menus: `app.setMenu` takes templates with roles (`.app_menu`, `.edit_menu`, `.window_menu`), accelerators and checkboxes. The same module drives "the menu bar, context menus and the menus of tray icons". — [src/menu.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/menu.zig)
- File dialogs: `dialog.open`, `dialog.save`, `dialog.message` (NSOpenPanel and friends, with filters). Clipboard through `nanoui.clipboard` and `desktop.zig`. Shell open, reveal and trash. Recent documents (`app_extras.zig`). — [src/dialog.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/dialog.zig), [src/nanoui.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/nanoui.zig), [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md)
- Multiple windows: `app.newWindow` can be called repeatedly. iPad multi-window exists. Window state restoration and document-based app (NSDocument) support: [not found].
- Dark mode and appearance: follows the system, plus Increase Contrast and Reduce Motion. — [README](https://github.com/justrach/nanoui)
- Accessibility: VoiceOver on macOS and iOS reads "the same tree as iOS (`ui.access`): controls, text, headings, boxes that take clicks, `nanoui.kit`". README says accessibility is "only on iOS and macOS's built-in controls". Linux, Windows and Android: "not yet". A custom canvas would expose nothing to VoiceOver unless you add `ui.access` nodes per mind-map node. — [README](https://github.com/justrach/nanoui), [examples/access](https://github.com/justrach/nanoui/tree/main/examples/access)
- Objective-C escape hatch: `pub const objc = ... @import("objc.zig")` is exported from `src/nanoui.zig`. It is nanoui's own runtime binding (`objc.msg` builds `objc_msgSend` prototypes at comptime, runtime classes, blocks, libdispatch). The AGENTS.md rule is "No C shims ... No `@cImport`, no `.c`/`.m`". So no zig-objc is needed, and the no-`@cImport` approach is already compatible with Zig 0.17's `@cImport` removal. `Surface.nativeHandle()` returns the NSView, and `Window.dockPage` lets you place a WKWebView in a native window. — [src/nanoui.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/nanoui.zig), [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md), [src/ui/surface.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/surface.zig)
- Embedding a nanoui view in an existing NSWindow, or hosting an app-owned NSView or CAMetalLayer inside the nanoui layout: [not found] as an API. The surface owns its NSView and sets `setWantsLayer:` with `contentsGravity` `topLeft`. Using `nativeHandle` you could in principle add a sibling subview via raw ObjC calls, but z-order and layout coordination would be unsupported. [inference]

### Inferences
- For the mind-map, nanoui gives you real IME-capable plain-text editing, menus, dialogs, clipboard, dark mode and pinch input on macOS. That is a larger share of the "boring" native surface than any other Zig option, and comparable in count to a basic AppKit shell.
- Not provided: undo and redo, rich-text editing in nodes, window restoration, NSDocument, drag-out, outline-tree widget (only a virtualised `ui.list` and kit accordions), inspector widgets beyond the kit's forms.

### Gaps
- Contents of `textfield.zig` (e.g. per-node floating editors, IME rect placement under transforms) were not read.

## 6. Web mode (zig-hosted WKWebView) versus Tauri 2

### Takeaway
Web mode is a thin, well-built shell with typed RPC, but it is much smaller than Tauri. IPC is JSON through a script message handler. Assets come from a custom URL scheme. There is no dev server or hot reload story in what I read, and no updater beyond macOS GitHub releases. The WKWebView 120 Hz limit from the first pass applies equally to Tauri.

### Cited Findings
- Mechanism: `WKUserContentController addScriptMessageHandler:name:` named "nanoui", plus `setURLSchemeHandler:forURLScheme:` for `nanoui://`. JS calls `window.webkit.messageHandlers.nanoui.postMessage(JSON.stringify(m))` on WKWebView and `chrome.webview.postMessage` on WebView2. Native-to-page goes through `evaluateJavaScript`, batched in "a batched outbox (one evaluation per main-loop turn)". `inspectable` (Safari Web Inspector) is an option. — [src/page_webkit.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/page_webkit.zig), [src/bridge.js](https://raw.githubusercontent.com/justrach/nanoui/main/src/bridge.js), [README Credits](https://github.com/justrach/nanoui)
- Typed client: `app.bind(&service)` exposes struct methods. `nanoui_params` names parameters. `registerEvent(Tick)` makes a typed event. `zig build gen` writes `nanoui.d.ts` and `nanoui.js`. Methods may return error unions, which reject the promise with the error name. "Bound methods run on the main thread." — [README Web pages](https://github.com/justrach/nanoui)
- Assets are served "from the `nanoui://localhost/` scheme" from an `assets` table. Whether the scheme handler can stream dynamic binary data (images from the Zig side) is [not found]; the API shown is a static asset list. The IPC itself is JSON text, so binary through IPC means base64.
- IPC speed: 5000 sequential JS-to-native calls took 493 ms (about 0.1 ms per call), on M3 Ultra in the author's harness. — [README Performance](https://github.com/justrach/nanoui)
- Platforms for pages: WKWebView (macOS, and iOS from 0.13), WebView2 (Windows), WebKitGTK (Linux, loaded with `dlopen`, `docs/linux-pages.md`). Pages can also be docked inside a native-UI window (`Window.dockPage`, several per window since 0.14.0). — [README Platforms](https://github.com/justrach/nanoui), [v0.14.0](https://github.com/justrach/nanoui/releases/tag/v0.14.0)
- Updates: "Apps update themselves from GitHub releases on macOS, even restarting unseen (`nanoui.Updater`)", via `src/update.zig` ("check, verify, swap the bundle"). — [README](https://github.com/justrach/nanoui), [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md)
- Packaging: "bundling is only for iOS and Android" in the README's last paragraph. A macOS `.app`, signing and notarisation tooling for desktop: [not found]. The showcase apps ship `.dmg` files (e.g. `nanoterm-macos-arm64.dmg`), so the authors do something, but it is in their own repos and I did not read it. Binary sizes are 0.7 MB (ReleaseFast) and 0.4 MB (ReleaseSmall) for a counter. — [README](https://github.com/justrach/nanoui)
- Sidecars and permissions: README lists "no notifications, channels or plugins yet". A child process is just `std.process`, with no permission or scoping model. [not found]
- Hot reload: the native `--watch` build mode is shown for iOS (`zig build ... --watch`) and the README quotes 0.56 s for a rebuild after a one-line edit. A web-asset dev server with HMR: [not found]. — [README Build times](https://github.com/justrach/nanoui)

### Inferences
- Compared with Tauri 2 (not re-verified here; known from general knowledge, which may be out of date): Tauri has a plugin system, a permissions or capability model, sidecar management, an updater with signatures, and bundlers with notarisation, all mature. nanoui web mode has typed RPC, a scheme handler, an updater and a very small footprint, and is missing the rest.
- The first pass's WKWebView 60 Hz rAF cap applies to any webview shell, so option 3 does not help the 120 Hz goal. Neither nanoui nor Tauri changes that.

### Gaps
- I did not read `page.zig` or `ipc.zig` for the exact scheme-handler capabilities, and did not check macOS 26 WKWebView frame rates.

## 7. Child processes and async

### Takeaway
nanoui offers no task or effect system. You spawn the child with Zig's `std.process`, read on a worker thread, and wake the UI thread with `redraw()` or `App.onMain`. That works and is simple, but you own all the plumbing. I did not test `std.process.Child` on 0.17.

### Cited Findings
- Worker-to-UI path: "frames asked for from any thread" (v0.14.0), `App.onMain` "reports whether the call was queued" (0.14.0 PR #152), `objc.dispatchMain` (AGENTS.md rule), `surface_thread_wake.zig`. The map example calls `w.redraw()` from a timer callback. — [v0.14.0](https://github.com/justrach/nanoui/releases/tag/v0.14.0), [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md), [examples/map/main.zig](https://raw.githubusercontent.com/justrach/nanoui/main/examples/map/main.zig)
- Evidence that a streamed child process works: `nanoterm` is "a terminal of blocks ... with a coding agent (graff or Claude Code) over ACP" and a `nanocua` MCP app also ships, so a process-spawning and JSON-streaming Zig app on nanoui exists. I did not read nanoterm's code. — [README Apps](https://github.com/justrach/nanoui)
- Zig 0.16/0.17 I/O: `std.process.Init` and `std.Io` are used directly by nanoui (`pub fn main(init: std.process.Init)`; `std.Io.Threaded.global_single_threaded.io()` in `pacing.zig`). — [README](https://github.com/justrach/nanoui), [src/ui/pacing.zig](https://raw.githubusercontent.com/justrach/nanoui/main/src/ui/pacing.zig)

### Inferences
- A Codex JSONL reader is a few hundred lines of Zig plus a lock-protected queue and `redraw()`. The risk is not nanoui but Zig's still-moving `std.Io` and `std.process` API.

### Gaps
- No example in the repo of an app spawning a child and streaming JSONL that I read; no verification of `std.process.Child` on 0.17.

## 8. Stability, toolchain and docs

### Takeaway
Fast, heavily tested (pixel-parity, Lean models, cross-OS CI) but unstable by policy. Docs are accurate in places and stale in others, and the README is a thin spec. The Zig 0.17 toolchain risks from the first pass apply fully.

### Cited Findings
- CI and tests: the README and release notes mention macOS, Linux and Windows CI, Linux tests in a container (`tools/linux.Dockerfile`), Android and iOS build checks, 200 or more test files under `src/ui/tests_*.zig`, Lean 4 proofs (`lean-proofs/`) and a benchmark harness. A `zig build lines` 600-line limit is enforced. — [README Development](https://github.com/justrach/nanoui), [repo tree](https://api.github.com/repos/justrach/nanoui/git/trees/main?recursive=1)
- Documentation: README plus `docs/` (android, ios, linux-pages, linux-perf, windows-ime, windows-pages, motion, kit-timeline, desktop-parity, git-hooks, caret-lifecycle). There is no API reference or book. `AGENTS.md`'s file map lags the code (it describes Windows as CPU-only while `d3d11*.zig` exist). Examples: access, basics, board, browser, counter, drop, duo, gallery, hello, map, ruler, scenes, sgbus (a large transit app), todo, turn. — [repo tree](https://api.github.com/repos/justrach/nanoui/git/trees/main?recursive=1), [AGENTS.md](https://raw.githubusercontent.com/justrach/nanoui/main/AGENTS.md)
- Memory-safety bugs open or recent: #199 (strings that do not outlive the view call are drawn after being freed) and #198 (password text visible to screen readers). A macOS focus bug #201 is open. — [Issues API](https://api.github.com/repos/justrach/nanoui/issues?state=all&per_page=60)
- Zig 0.17 workaround in-repo: `tools/ios/zig-lib.sh` patches a line of Zig 0.17's `std` so iOS builds work ("nothing, once Zig is fixed"). This shows nanoui already hits stdlib bugs. — [README iOS](https://github.com/justrach/nanoui)
- First-pass toolchain facts, still true as far as I know: ZLS does not yet work with 0.17.0, and incremental compilation on aarch64-macos is not yet available. nanoui's build is made fast by splitting a prebuilt runtime lib (`src/rt.zig` to `libnanoui-rt.a`) so an app edit relinks in about 0.56 s. — [zig_stack_evaluation.md](file:///Users/parth/projects/general/mind_maps/research_notes/Mind%20mapping%20desktop%20app%20research/zig_stack_evaluation.md), [README Build times](https://github.com/justrach/nanoui)

### Inferences
- Breaking changes are probable at each minor release. Pin a tag (`zig fetch --save git+https://github.com/justrach/nanoui#v0.14.6`) and vendor it. Treat any upgrade as a porting task.

### Gaps
- No inventory of breaking changes. Release notes are PR title lists only.

## 9. Comparable options (brief)

### Takeaway
dvui has a more suitable low-level draw API for custom geometry (Beziers, arbitrary triangles, textures). nanoui has the better native-macOS integration. NanoVG-zig remains the simplest drop-in vector canvas beside any shell, but it is OpenGL or WebGL oriented.

### Cited Findings
- dvui: `Path.Builder` has `addPoint`, `addRect`, `addArc`, `addQuadBezier` and `addCubicBezier` ("flattened ... within 0.5 physical-pixel deviation"). `Triangles.Builder` takes vertices and indices, and `dvui.renderTriangles` accepts a texture. There is a `Texture.zig` with a cache and render targets (`Target.create`), `Gradient.zig`, `BlurBackdrop.zig`, and render-to-texture. Backends in `src/backends`: sdl (SDL2 and 3), sdl3gpu, raylib, glfw, dx11, pugl, wio, web. Release names were not retrievable (the releases request failed). — [Path.zig](https://raw.githubusercontent.com/david-vanderson/dvui/main/src/Path.zig), [Triangles.zig](https://raw.githubusercontent.com/david-vanderson/dvui/main/src/Triangles.zig), [Texture.zig](https://raw.githubusercontent.com/david-vanderson/dvui/main/src/Texture.zig), [backends listing](https://api.github.com/repos/david-vanderson/dvui/contents/src/backends)
- nanovg-zig: 248 stars, canvas-style API with Beziers, strokes with joins and caps, gradients, image patterns and clip paths, last push 2026-01-29. It has no native Metal backend and does not provide widgets or text input (from the first pass). — [nanovg-zig README](https://github.com/fabioarnold/nanovg-zig)
- dvui IME on macOS: only through SDL and web per the first pass; I did not re-verify. — [dvui README](https://github.com/david-vanderson/dvui)

### Gaps
- No benchmark or app known for dvui at 5,000 curves. I did not verify dvui's macOS IME in code.

## 10. Verdicts for the three usage modes

I give these as judgement, built from the cited facts above.

### (1) nanoui native mode for the whole app: not recommended
- The canvas is the project's whole reason to exist. `ui.canvas` is a per-frame line, triangle and polygon emitter with no Beziers, no retained geometry, no clip paths, no text-on-curve and no variable-width strokes. At 5,000 tapered branches it is the wrong data structure (about 20 to 55 MB of instances rebuilt per frame, my arithmetic).
- The image atlas has no mipmaps and scales to at most 1024 px by default. SVG is icon-grade with no text or filters.
- To make it work you would write a custom renderer anyway, which is option 2.
- The text-editing story is plain-text only (no rich spans in the editor), with no undo. You would need to build them.
- Strongest case for: macOS-native feel from a single 0.7 MB binary, real IME, menus, dialogs, drag-drop, clipboard, ProMotion pacing, Liquid Glass look for panels, and a path to Linux, Windows and iOS. Zero JS.
- Strongest case against: 4 weeks old, one author, minor releases may break the API, memory-safety issues, Linux and Windows text and IME and accessibility lag, and an agent-written codebase that is hard for an outsider to audit.

### (2) nanoui for panels, your own Metal canvas composited into it: the only viable nanoui mode, but still a high-risk bet
- Viable path: `ui.metalDevice()`, `Surface.before_encode` (an MTLCommandBuffer callback), `ui.texture` with `Texture.mtl_texture`, `ui.access` for VoiceOver nodes, and input from `input.zoom`, `input.pan` and pointer events. Your canvas would be Metal code (or Zig calling Metal through `nanoui.objc`) with cached tessellated meshes, instanced glyphs and your own mipmapped textures. nanoui provides the window, menus, panels, dialogs and text fields.
- Costs:
  - The canvas is rendered to a texture and composited, with an extra pass.
  - You write hit-testing and in-node text editing yourself.
  - The canvas's text editor cannot reuse nanoui's text field easily.
  - The GPU hook is two weeks old (v0.14.0), came from one outside contributor and has one test.
  - The windows and widgets come with nanoui churn.
- Compared with the obvious alternative, a Swift/AppKit shell with an `MTKView` or `CAMetalLayer` subview: AppKit gives a first-class, documented embedding, NSTextView or NSTextInputClient for rich text, NSDocument, undo, restoration, outline views, inspector controls, full accessibility and multi-platform-agnostic Metal. nanoui replaces those with a smaller, younger, custom set but a single-language Zig codebase. The first pass's Ghostty precedent (Zig core plus native shell) favours the AppKit shell.

### (3) nanoui web mode as a Zig WebView shell: not recommended over Tauri
- Typed IPC, a custom scheme handler, an updater and tiny binaries are real. But there is no plugin or permission or sidecar system, no desktop bundling or notarisation tooling in the repo, JSON-only IPC, and no dev-server or HMR story that I found.
- The canvas would be WebGL or WebGPU in a webview, which is capped by WKWebView's refresh behaviour (see the first pass) exactly as with Tauri.
- Tauri 2 is more mature on every shell concern that matters for a signed, notarised, auto-updating app with a child-process sidecar (Codex CLI).

### Overall
nanoui is impressive scope for its age and a good fit for small utility apps. It is not a fit as the foundation of a canvas-heavy, 120 Hz mind map. If Zig is a firm requirement, the better-evidenced route is the first pass's architecture C: a Zig core (document model, layout, spatial index, tessellation) with a Swift/AppKit shell and a Metal view. nanoui's one reusable asset in that setup is `src/ui/svg.zig`, a self-contained Zig SVG rasteriser, and the Zig-only ObjC runtime pattern. Re-evaluate in 3 to 6 months if the project adds a retained path or mesh primitive, mipmapped textures and a stable API.

### Gaps
- I did not benchmark or build anything. I did not read nanofly, nanoterm or nanodocs source (nanodocs claims 120 Hz live resize on a Metal text renderer; that might hold a useful data point on frame times). A direct test of how many `ui.canvas` instances nanoui sustains per frame is the single measurement that would settle the path-heavy question.
