# Non-Zig stacks for a high-performance desktop mind-mapping app (Rust, Elixir/LiveView, others), as of Nov 2026

Research scope note: roughly 20 tool calls. Coverage is partial. Several sub-questions (Qt, Avalonia, Flutter numbers, resvg coverage, Swift/AppKit, Rive, CanvasKit, Miro/Rnote/Graphite/Warp case studies, Burrito startup time and size, Codex JSONL handling) were not researched or returned nothing citable. They are listed under Gaps. They are NOT filled in from memory as facts. Where I give a judgement from general background knowledge, it is under Inferences and marked as unverified.

## 1. Elixir: LiveView as a desktop app (Burrito, ElixirKit/Tauri, elixir-desktop, ExTauri)

### Takeaway
Packaging a Phoenix app for desktop is viable and has an official path (ElixirKit + Tauri, used by the Livebook team). Burrito is actively maintained (1.6.0, 24 Jul 2026), but it only produces a single executable. It does not draw a window, so you need a webview shell such as Tauri around it. The canvas must live in client-side JS, so Elixir's role is orchestration and persistence, not rendering.

### Cited Findings
- Burrito latest is 1.6.0, last updated Jul 24 2026. It has 12 versions, about 305k all-time downloads, and an MIT licence. It is described as packaging an Elixir app as a self-contained single-file executable for macOS, Linux and Windows. — [hex.pm/packages/burrito](https://hex.pm/packages/burrito)
- The Tinfoil helper (publishes Burrito archives to GitHub Releases/Homebrew) states signing and notarization are out of its scope. — [readme.hex.pm/tinfoil](https://readme.hex.pm/tinfoil/0.2.18)
- Burrito's own pages (as seen in search snippets) did not mention code signing or notarization. I found no Burrito-native notarization support. — [hex.pm/packages/burrito/1.6.0](https://hex.pm/packages/burrito/1.6.0)
- A community write-up runs the Burrito executable as a Tauri sidecar and opens a native webview at `localhost:4000`. Targets are macOS ARM64, Linux x86_64 and Windows x86_64. Windows builds from Linux use cargo-xwin and Zig via ZVM. Caveats: the window can open before the backend is ready (it polls up to 60 times at 1 s), migrations need manual handling, and macOS needs code signing. It gives no size, startup or memory numbers. — [mrpopov.com](https://mrpopov.com/posts/elixir-liveview-single-binary)
- ElixirKit is the Livebook team's toolkit for starting an Elixir app from Rust and talking to it. The Livebook desktop app uses ElixirKit and is not Electron. It is "focused on desktop OSes only". — [elixirkit.hexdocs.pm/tauri](https://elixirkit.hexdocs.pm/tauri.html); [Livebook blog](https://livebook.dev/blog/introducing-the-livebook-desktop-app)
- ElixirKit + Tauri 2 flow: Rust starts a local TCP PubSub listener and launches the Elixir release with `ELIXIRKIT_PUBSUB` set. Elixir sends `ready`, and Rust then opens a window pointed at the local Phoenix server. The release is built into `src-tauri/target/rel` and bundled as a Tauri resource. — [elixirkit.hexdocs.pm/tauri](https://elixirkit.hexdocs.pm/tauri.html)
- ElixirKit signing on macOS: the embedded release must be signed separately because Tauri signs only the Rust side. `ElixirKit.Release.codesign/1` and an entitlements file are provided. Notarization uses the `APPLE_*` env vars with `cargo tauri build` and needs a paid Apple Developer account. It is v0.1.0, and the macOS and Windows OTP builds are self-contained. Linux OTP links OpenSSL dynamically, so you need per-distro builds or an AppImage. — [elixirkit.hexdocs.pm/tauri](https://elixirkit.hexdocs.pm/tauri.html)
- Livebook desktop is available for Mac and Windows with no Elixir install required. The page gives no size, startup or signing detail. — [livebook.dev blog](https://livebook.dev/blog/introducing-the-livebook-desktop-app)
- Elixir Desktop (`desktop` on Hex, latest seen 1.5.3) runs the Phoenix server in-process and shows it in the OS webview. It targets Windows, macOS, Linux, iOS and Android. It requires switching the endpoint to `Desktop.Endpoint`. Star counts conflict between sources (about 1.7k in Jan 2026 vs about 1.8k in Aug 2026). — [hex.pm/packages/desktop/1.5.3](https://hex.pm/packages/desktop/1.5.3/files); [readme.hex.pm/desktop](https://readme.hex.pm/desktop/1.5.3)
- ExTauri (`ex_tauri`) wraps Tauri for LiveView, and the app must bind to an injected port. It is described as a proof of concept. — [github.com/Exadra37/ex_tauri](https://github.com/Exadra37/ex_tauri); [Elixir Forum](https://elixirforum.com/t/ex-tauri-desktop-applications-using-elixir/75991)
- A Tauri + Phoenix sidecar guide skips the sidecar in debug builds, so you run `mix phx.server` by hand during development. — [dev.to/davidteren](https://dev.to/davidteren/building-a-phoenix-liveview-desktop-app-with-tauri-a-step-by-step-guide-jn9)

### Inferences
- A Burrito binary has no window of its own. The viable shapes are (a) Burrito or an OTP release as a sidecar inside Tauri, (b) ElixirKit + Tauri, or (c) elixir-desktop's in-process webview. ElixirKit/Tauri is the best-documented route with signing guidance.
- (Unverified background knowledge) Per-frame server round-trips over a WebSocket cannot hit 120 Hz (8.3 ms per frame) once serialization, diffing and scheduling are included, even on localhost. Pan, zoom and drag must be client-side JS. I found no source stating this, so treat it as engineering judgement.
- The real question is whether the BEAM earns its place. The cited sources show the packaging cost: a separate signing step, a Tauri or webview shell anyway, and Linux OpenSSL caveats. The genuine gains (supervising the flaky Codex child process, concurrent image jobs, fast iteration for an Elixir-fluent developer) are judgement, not measured.

### Gaps
- No measured Burrito startup time, binary size or idle BEAM memory found. The ~60-100 MB figure in the brief is unverified.
- No source on Burrito notarization specifics, or on whether Bakeware is deprecated.
- Status of LiveView Native in 2026 not found.
- No whiteboard/canvas-on-LiveView case study found. The search returned only general Tauri + Phoenix guides.
- I did not verify how Livebook's Swift/C# launchers work. The sources say only that it uses ElixirKit.

## 2. Rust: Tauri 2, native GUI frameworks, building blocks, case studies

### Takeaway
Tauri 2 is small and mature (2.11, Jul 2026) but inherits WKWebView limits. On macOS 13-15, `requestAnimationFrame` is capped near 60 fps, with only a private-API workaround. A native-Rust canvas (GPUI-style or custom wgpu/Vello) has the highest ceiling, but the UI, text-editing and IME work is far larger. Zed shows what is possible on Metal.

### Cited Findings
- Tauri 2.11 shipped in July 2026. Electron 44 went stable on Aug 25 2026 (Chromium M152). — [Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)
- WKWebView caps `requestAnimationFrame` near 60 fps via the WebKit preference `PreferPageRenderingUpdatesNear60FPSEnabled`, which is on by default. The community plugin `tauri-plugin-macos-fps` 0.1.0 turns it off through a private `_features` API on macOS 13-15. On macOS 26 the plugin reports no cap, though one report says testufo still showed 60 fps. Tauri issue #13978 was closed "not planned", and WebKit bug 294338 asks for a supported way to get 120 Hz. — [docs.rs/tauri-plugin-macos-fps](https://docs.rs/crate/tauri-plugin-macos-fps/0.1.0/source/README.md); [WebKit bug 294338](https://www2.webkit.org/show_bug.cgi?id=294338); [Apple forum](https://developer.apple.com/forums/thread/773222)
- A Babylon.js forum thread discusses a performance gap between Safari and Tauri's WKWebView. I did not read its details. — [forum.babylonjs.com](https://forum.babylonjs.com/t/performance-between-safari-and-wkwebview-tauri/60811)
- Tauri vs Electron figures are inconsistent across sources. Hopp: bundle 8.6 MiB vs 244 MiB, memory about 172 MB vs 409 MB with six windows. Better Stack (Jul 2026): bundle 57 MB vs 323 MB, idle 109 MB vs 128 MB, Tauri startup 311 ms. Tech-insider: cold start 380 ms vs 1,420 ms. Another tutorial: idle about 80 MB vs 160 MB. The sources are vendor-adjacent or single-author, so treat them as indicative only. — [dev.to/gethopp](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4); [Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/); [tech-insider](https://tech-insider.org/tauri-vs-electron-2026/)
- Zed's GPUI hit a stable 120 FPS on an M1 MacBook ProMotion display. Render time was under 4 ms, and dropped frames came from ProMotion downclocking, not render cost. The fixes were a display-link callback, presenting every frame for 1 s after the last input, and a triple-buffered instance-buffer pool. `present_drawable` before `commit`, with `presentsWithTransaction` disabled, gave a stable 120. — [zed.dev/blog/120fps](https://zed.dev/blog/120fps)
- GPUI's design is "video-game style" GPU rendering of UI primitives. Shadows use Evan Wallace's technique. — [zed.dev/blog/videogame](https://zed.dev/blog/videogame)
- GPUI crates.io status is unclear. A Zed commit says a 0.2.0-test.4 prerelease was published to crates.io, and older READMEs said to use git. Community forks exist (gpui-ce, gpui-box, gpui-pre). `gpui-component` (longbridge) still shows git dependencies in its README. `gpui-base` 0.6.0 is dated 2026-09-03. — [git.secluded.site (Zed commit)](https://git.secluded.site/zed/commit/0f0974f10588f0b9e2223c99104f3727b9614e2e); [gpui-ce docs.rs](https://docs.rs/crate/gpui-ce/0.3.2); [github.com/longbridge/gpui-component](https://github.com/longbridge/gpui-component); [docs.rs gpui-base](https://docs.rs/crate/gpui-base/0.6.0)
- Vello: vello_cpu 0.0.5 (2026-01-08) and vello_hybrid 0.0.6 (2026-01-15) are still 0.0.x. Linebender calls vello_cpu the most mature CPU-only option. The Dec 2025 update reports a roughly 30% speedup in one image test from removing overdraw for opaque image fills. Xilem gained a `Canvas` widget and was split into `xilem_masonry`. Parley text analysis moved to ICU4X. The only text-editing and accessibility mentions are small fixes. — [linebender.org/blog/tmil-24](https://linebender.org/blog/tmil-24/); [lib.rs/vello_hybrid](https://lib.rs/crates/vello_hybrid)
- Dioxus 0.7 has an experimental WGPU-based native renderer (Blitz). `dioxus-native` is at 0.7.8, with AccessKit-backed accessibility behind a feature flag. — [docs.rs/dioxus-native](https://docs.rs/crate/dioxus-native/0.7.8/source/src/lib.rs)
- The most recent Rust GUI survey I found is boringcactus's April 2025 one (43 crates). Dioxus, egui, Slint, Floem and Xilem did well on a trivial label+input task. By one reviewer's reading, fewer than about 10% of crates met a development-readiness bar. I found no 2026 survey. — [boringcactus.com](https://boringcactus.com/2025/04/13/2025-survey-of-rust-gui-libraries.html); [areweguiyet.com](https://areweguiyet.com/)
- Figma moved its renderer from a WebGL-shaped interface to WebGPU. It redesigned the graphics interface for explicit draw-call state, and the motivations were compute shaders and avoiding WebGL global state. It reports gains on some devices and neutral results on others. I read this only via third-party summaries. — [figma.com/blog/figma-rendering-powered-by-webgpu](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)

### Inferences
- For a 120 Hz target on macOS, Tauri is acceptable only if you test on macOS 26 (Tahoe) and treat 13-15 as possibly 60 fps. If the user's dev machine is on Tahoe, this may not bite locally but will for users on older macOS.
- Tauri is the Rust option that costs the least: the same web canvas code runs inside it and Elixir can sit behind it. A native-Rust canvas is the "only if there is a good reason" case, and the good reason would be 120 Hz guaranteed plus a very large, image-heavy canvas.
- GPUI is a bad fit for external adopters right now: no clearly stable crates.io release, so you track Zed's git, and I did not verify its text input or IME for non-code UIs. Vello CPU/hybrid are 0.0.x, and Vello is a renderer, not a UI toolkit.

### Gaps
- Not researched or not found: egui custom-painting performance and IME, iced 0.14, Slint, Makepad, Freya, Floem, Bevy UI. Also resvg/usvg coverage, lyon, cosmic-text vs Parley maturity, rstar, taffy, and CRDT crates (automerge/loro/yrs).
- Tauri IPC raw binary and custom-protocol throughput, sidecar and plugin ecosystem specifics, and tauri-mobile status were not verified.
- No numbers for "5,000 tapered Beziers at 120 Hz" in any Rust renderer. Vello vs Skia vs Canvas2D frame-time comparisons were not found.
- Rust case studies (Rnote, Graphite, Lapce, Warp, Pax, Makepad apps) were not researched.
- Whether GPUI standalone on macOS handles 100s of mipmapped textures well was not verified.

## 3. Other stacks and web-canvas technology inside a webview

### Takeaway
Within a webview, the practical approach is WebGL2 or WebGPU (via PixiJS or custom) for nodes and images, with Canvas2D for simple parts. WebGPU shipped in Safari 26, but 120 Hz inside WKWebView is the main risk on older macOS. Electron avoids both webview issues at a large size cost. Native Swift, Qt, Flutter, Avalonia and the like were not researched here.

### Cited Findings
- WebGPU shipped in Safari 26 (macOS Tahoe 26, iOS 26 and others) and WebKit describes it as superseding WebGL. — [web.dev](https://web.dev/blog/webgpu-supported-major-browsers); [WebKit blog Safari 26.1](https://webkit.org/blog/17541/webkit-features-for-safari-26-1/)
- A WebKit Bugzilla report describes WebGPU canvas flicker on Safari 26, possibly still reproducing in 26.2. Its status is unclear because it was marked as a duplicate. — [bugs.webkit.org/show_bug.cgi?id=301627](https://bugs.webkit.org/show_bug.cgi?id=301627)
- I could not confirm that WebGPU is exposed inside embedded WKWebView (as opposed to Safari) on macOS. This needs a direct test.
- PixiJS v8 official numbers (2024): the 100k-sprite Bunnymark's CPU time for moving sprites dropped from about 50 ms to about 15 ms, and GPU time from about 9 ms to about 2 ms. v8.16.0 added an experimental Canvas renderer. The default `autoDetectRenderer` order is WebGL, then WebGPU, then Canvas (per a 2026 guide on 8.22.0). — [pixijs.com/blog/pixi-v8-beta](https://pixijs.com/blog/pixi-v8-beta); [pixijs.com/blog/8.16.0](https://pixijs.com/blog/8.16.0); [issoh.co.jp guide](https://www.issoh.co.jp/md/tech/9180)
- tldraw's docs: it culls off-screen shapes (10,000 shapes may render about 50). The default max is 4,000 shapes per page, and debounced zoom starts above 500 shapes. It simplifies geometry at low zoom. In v4.4, selection and hover indicators moved from SVG to 2D canvas (up to 25x faster in some cases), and shape queries use an R-tree. — [tldraw.dev/sdk-features/performance](https://tldraw.dev/sdk-features/performance); [tldraw.dev/sdk-features/options](https://tldraw.dev/sdk-features/options); [tldraw v4.4](https://tldraw.dev/releases/v4.4.0)
- Electrobun's own claims are about 14 MB bundles and under 50 ms startup (system webview). A Better Stack test (Jul 2026) measured Electrobun at 418 MB with 208 MB idle, probably with bundled Chromium. Deno Desktop measured 111 MB bundle and 98 MB idle. — [blackboard.sh/electrobun](https://blackboard.sh/electrobun/docs/guides/what-is-electrobun); [Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)
- Hoppscotch's Tauri move cut its bundle from 165 MB to 8 MB (reported secondhand). — [Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)
- A "js-game-rendering-benchmark" repo and a PixiJS rendering-comparison repo (Chrome 120, M2 MacBook Pro) exist. I did not extract numbers from them. — [github.com/Shirajuki/js-game-rendering-benchmark](https://github.com/Shirajuki/js-game-rendering-benchmark); [github.com/etowahadams/pixijs-rendering-comparison](https://github.com/etowahadams/pixijs-rendering-comparison)

### Inferences
- (Unverified background knowledge) A tapered-branch mind map is mostly a few thousand filled paths plus textures. A WebGL2 renderer that tessellates branches once into cached meshes, uses atlas or per-image textures with mipmaps, and culls via a spatial index should be well within budget. Canvas2D redrawing thousands of complex paths per frame is the likely first bottleneck. Treat as hypothesis and prototype.
- tldraw's lessons transfer: cull, level-of-detail at low zoom, an R-tree for hit-testing, and avoid per-frame React renders. Its DOM/SVG approach is its limit, which a WebGL canvas avoids.
- Electron is the safe rendering baseline (Chromium, consistent 120 Hz, WebGPU) but the cited sizes (about 245-325 MB) and 2-4x idle memory are the cost. Electron would pair naturally with a Node or Elixir sidecar.

### Gaps
- Not researched: Swift/AppKit/Metal, Qt 6, Flutter (Impeller, CustomPainter), Compose Multiplatform, Avalonia, Wails, Neutralino, Godot, Dear ImGui and Skia C++. No numbers gathered for them.
- Not researched: CanvasKit/Skia-WASM, Rive, Konva, Fabric, Two.js, React Flow, markmap, OffscreenCanvas/workers, createImageBitmap, SVG-to-texture rasterization practice.
- No published "how many nodes at 60/120 fps" per library was found.
- Flutter and Qt startup/memory benchmarks and the Elanis web-to-desktop framework comparison repo were not read.

## 4. Synthesis: comparison matrix, ranking, architecture

### Takeaway
On the evidence gathered, the best-supported plan is a client-side GPU canvas (WebGL2/WebGPU) in a system-webview shell, with orchestration in either Elixir or Rust. This is hypothesis-heavy because several rivals (native Swift, Flutter, Qt) were not measured. Scores below are judgement based on the cited findings plus unverified background knowledge, and should be validated with a spike.

### Cited Findings (inputs to the matrix)
- Tauri: small bundle, WKWebView 60 fps cap on macOS 13-15, 2.11 current. Sources in section 2.
- Electron: large bundle and memory, consistent Chromium. Sources in section 2/3.
- GPUI: proven 120 fps on ProMotion but unstable distribution story. Sources in section 2.
- ElixirKit/Tauri: documented path with separate signing step. Sources in section 1.

### Matrix (1-5, higher is better; judgement, not measurement)
| Architecture | Canvas ceiling | UI/text/IME | Dev speed (Elixir-fluent user) | Maturity/risk | Size | Memory | Startup | Cross-platform | Codex supervision | Raster+SVG hybrid | Maintainability |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tauri + web canvas (WebGL2/WebGPU) + Rust core | 4 (60 fps cap risk on macOS 13-15) | 5 (DOM) | 3 | 4 | 5 | 4 | 4 | 4 (WebKitGTK unverified) | 4 (tokio) | 4 | 4 |
| Tauri + web canvas + Elixir sidecar (ElixirKit) | 4 | 5 | 5 | 3 | 3 (adds ERTS, size unmeasured) | 3 | 3 (unmeasured) | 3 | 5 (OTP) | 4 | 3 |
| Electron + web canvas (+ Node or Elixir sidecar) | 4-5 (Chromium) | 5 | 4 | 5 | 1 | 2 | 2 | 5 | 3 | 4 | 4 |
| Phoenix LiveView + Burrito + webview shell (no Rust) | 4 (JS canvas) | 5 | 5 | 2 | 3 | 3 | 3 | 3 | 5 | 4 | 3 |
| elixir-desktop (in-process webview) | 4 | 5 | 4 | 2-3 | 3 | 3 | 3 | 4 | 5 | 4 | 2 |
| Native Rust custom (winit + wgpu/Vello) | 5 | 1 | 1 | 2 | 5 | 5 | 5 | 4 | 4 | 3 | 3 |
| GPUI (Rust native) | 5 | 3 | 2 | 2 (distribution unclear) | 5 | 5 | 5 | 3 | 4 | 3 | 2 |
| Native Swift (AppKit + Metal/CoreGraphics) | 5 | 5 | 2 | 5 | 5 | 5 | 5 | 1 | 3 | 5 | 4 |
| Flutter / Qt / Compose / Avalonia | not researched | not researched | | | | | | | | | |
| Zig native / Zig + WebView | covered by another researcher | | | | | | | | | | |

Note: Swift and the native-Rust rows rest on background knowledge, not on sources gathered here. The Flutter/Qt/Compose/Avalonia rows are left unscored on purpose.

### Inferences (ranking and conditions; judgement)
1. Rank 1: Tauri + client-side WebGL2/WebGPU canvas, with the Codex/image/persistence core in either Elixir (ElixirKit) or Rust. Choose the Elixir core if development speed and OTP supervision of the Codex child outweigh the extra signing and size cost. Choose the Rust core if you want one fewer runtime.
2. Rank 2: Electron + the same web canvas. Choose it instead if 120 Hz on macOS 13-15 matters and cannot be tested around, or if WebGL/WebGPU differences across system webviews cause trouble. The cost is the cited size and memory.
3. Rank 3: native renderer (Swift/Metal if macOS-only, or Rust wgpu/Vello/GPUI if cross-platform). Choose it instead if the spike shows the webview cannot hold 120 Hz with real image counts, and you accept a much larger UI and text-editing build.
- Recommended internal architecture (keeps the shell swappable): (a) a pure document model (tree plus node attributes, command-based undo, serialized to files or SQLite) with no UI dependency; (b) a layout engine in a portable core (JS/TS or a Rust crate compiled to WASM); (c) a renderer behind a narrow interface that takes culled draw lists, with cached tapered-branch meshes, an LOD policy and a spatial index (tldraw's lessons); (d) an AI orchestration process that spawns Codex, parses JSONL and emits typed events over a local IPC boundary, so it can be Elixir, Rust or Node without changing the UI; (e) the image cache as content-addressed files served by a custom protocol or local HTTP.
- Before committing: build a one-day spike with 5,000 tapered paths plus 300 textures in WKWebView on the user's macOS version, and measure frame time. This is the single piece of evidence missing from all sources found.

### Gaps
- No frame-time evidence for the target workload on any stack.
- Codex CLI JSONL streaming behaviour and process-handling comparisons (Ports vs tokio) were not researched.
- The ranking would need re-testing if Flutter, Qt or Swift measurements change the picture.
