# Native (non-WebView) UI and rendering stacks for a mind-mapping app: pass 2 (as of 2026-11-17)

Method note: about 38 tool calls. Version and date facts for Rust crates were read from the crates.io API on 2026-11-17 (`https://crates.io/api/v1/crates/<name>`, `.../versions`). GitHub release facts came from `https://api.github.com/repos/<owner>/<repo>/releases/latest`. Nothing was benchmarked by me. The searches returned thin evidence for several items (Swift apps' internals, egui/iced IME, Makepad, Avalonia, Core Text), and these are listed as Gaps. Items labelled "Inferences" are judgement or background knowledge and are not sourced. Scores in section 12 are judgement.

## 1. Swift/AppKit native and the Swift shell + portable core pattern

### Takeaway
No source gave a published frame-time comparison for a Swift/Metal canvas at this workload, and no source gave internals for MindNode, Freeform, OmniGraffle or Sketch. The evidence for the "native shell + C-ABI core" pattern is Ghostty (from pass 1) plus a small amount of tooling evidence. Rust-to-Swift bridging via UniFFI is mature enough to be used in shipping products. swift-bridge is still 0.1.x.

### Cited Findings
- MindNode's site says it uses AppKit, UIKit and SwiftUI together and calls itself 100% native. A third-party dependency scanner lists Lottie, SwiftUI Introspect and Swift Composable Architecture in the Mac build. That scan is automated, so it is indicative only. — [mindnode.com/apple](https://mindnode.com/apple); [desktopinsights.com/apps/mindnode](https://desktopinsights.com/apps/mindnode)
- MindNode 6 coverage says the core architecture was rewritten for responsiveness. The article gives no design detail. — [thesweetsetup.com](https://thesweetsetup.com/mindnode-6-brings-speed-and-performance-refinements-to-our-favorite-mind-mapping-app/)
- Eclectic Light (Apr 2026): apps commonly still drop to AppKit for tasks SwiftUI cannot do. — [eclecticlight.co](https://eclecticlight.co/2026/04/04/explainer-appkit-and-swiftui/)
- SwiftUI `Canvas`: only anecdotal evidence. Apple Developer Forum threads report slow `Canvas` with heavy per-frame drawing, and `drawingGroup()` is the usual workaround (it flattens to a Metal-backed texture). No numbers for thousands of paths. — [Apple forums 683293](https://developer.apple.com/forums/thread/683293); [Jacob's Tech Tavern](https://blog.jacobstechtavern.com/p/real-engineers-use-metal); [Medium AsyncCanvas](https://medium.com/@adurymanov/asynccanvas-in-swiftui-a80deea7f1b9)
- Independent same-app comparison on an M2 Pro, macOS 26.5 (process explorer, one app per stack): Swift/SwiftUI + Rust launched in about 1 s, 200-240 MB RSS, 10 MB DMG. Flutter + Rust: about 200 ms, 200-230 MB, 27 MB. Compose Desktop + Rust: 2-3 s, 480-520 MB, 73 MB (author suspects a leak). The author reports random SwiftUI async-update crashes until moving to ObservableObject, and calls Swift's native feel the best on macOS. These are small, single-author measurements of a table-like UI, not a canvas. — [devmil.de](https://devmil.de/2026/06/30/2026-06-30-Desktop-framework-comparison/)
- UniFFI 0.32.2 (2026-09-23) is used heavily by Mozilla in Firefox and generates Swift packages. `cargo-swift` packages Rust as a Swift package/xcframework and runs only on macOS. iroh and XMTP ship Rust cores to Swift this way. — [crates.io uniffi](https://crates.io/crates/uniffi); [lib.rs cargo-swift](https://lib.rs/crates/cargo-swift); [docs.iroh.computer](https://docs.iroh.computer/languages/swift); [mintlify xmtp](https://www.mintlify.com/xmtp/libxmtp/bindings/swift)
- swift-bridge is 0.1.59 (2026-01-06), still 0.1.x. cbindgen is 0.29.4 (2026-06-09). The one macOS swift-bridge example I found (Moltis) calls itself a POC. — [crates.io swift-bridge](https://crates.io/crates/swift-bridge); [crates.io cbindgen](https://crates.io/crates/cbindgen); [docs.moltis.org](https://docs.moltis.org/macos-app-ffi-bridge.html)
- Ghostty (from pass 1): Zig core as a C library, Swift/AppKit shell on macOS, GTK4 on Linux; static lib + XCFramework. Hashimoto says any C-ABI language, including Rust, works. — [mitchellh.com/writing/zig-and-swiftui](https://mitchellh.com/writing/zig-and-swiftui)
- Sparkle 2.10.1 was released 2026-10-25. — [github.com/sparkle-project/Sparkle](https://github.com/sparkle-project/Sparkle/releases)

### Inferences (not sourced, background knowledge)
- Swift custom canvas: `MTKView` or `CAMetalLayer` with `CADisplayLink` for ProMotion, one `NSView` hosting the Metal layer, and a hidden `NSTextView`/TextKit 2 field (or `NSTextInputClient` on the canvas view) for inline editing with IME. Core Text (`CTLine` glyph runs, positions) plus your own path measure gives text along curves. All of this is first-party and stable, but the Metal tessellation and glyph pipeline is yours to write.
- Tapered strokes: Core Graphics `CGPath.copy(strokingWithWidth:)` gives only constant-width strokes, so tapered ribbons would be built as polygons from offset curves in either Swift or a Rust/Zig core.
- A Rust or Zig core keeps the model, layout, spatial index and tessellation reusable on Windows/Linux, with a new native shell per OS (the Ghostty route) or a wgpu window driven from the core.
- Rough effort (my estimate, not sourced): 3-5 months to a good macOS MVP for a developer new to Swift/Metal, more for Windows/Linux shells.

### Gaps
- No source on how Freeform, OmniGraffle or Sketch are built (Sketch is understood to use Core Animation/Metal, but I did not verify). No measured TextKit 2 over Metal case study. No published SwiftUI Canvas vs Metal numbers.
- Notarisation, universal-binary and app-size specifics for Swift apps were not researched; background knowledge only (Xcode handles them; Sparkle is the standard updater).

## 2. GPUI (Zed's UI framework)

### Takeaway
GPUI is now a real crate on crates.io (`gpui` 0.2.2, Apache-2.0), but it is explicitly pre-1.0 with frequent breaking changes. It builds for macOS (Metal), Linux (Wayland/X11) and Windows (Win32/DirectWrite). It has an IME-capable input trait, a `canvas` element with lyon-backed `PathBuilder`, an `svg` element and an AccessKit-based accessibility topic. The gpui-component library is active (0.10.0 on 2026-11-16). Nothing I found measures thousands of Bezier paths in GPUI.

### Cited Findings
- crates.io `gpui` 0.2.2 is dated 2025-10-22 (version list), Apache-2.0, authored by Nathan Sobo, "Zed's GPU-accelerated UI framework". Crates.io shows a more recent metadata update (2026-10-30), but the latest published version is still 0.2.2. This corrects pass 1, which could not tell whether a stable crate existed. — [crates.io/gpui](https://crates.io/crates/gpui); [gpui Cargo.toml](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/Cargo.toml)
- README: "hybrid immediate and retained mode, GPU accelerated", "still pre-1.0. There will often be breaking changes between versions", and needs latest stable Rust. A separate `gpui_platform` crate is used with features: macOS needs `font-kit` for glyphs (Metal always on), Linux needs `wayland` and/or `x11`, Windows uses Win32 and DirectWrite with no features. The README links an "Accessibility" topic. — [gpui README](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md)
- Zed itself is at v1.28.1 (2026-11-11), so GPUI is exercised by a shipping editor on all three OSes. — [GitHub releases](https://github.com/zed-industries/zed/releases)
- Source facts: `elements/canvas.rs` offers `canvas(prepaint, paint)` for "low level paint API"; `path_builder.rs` builds paths on `lyon_path` with fill and stroke options (width, cap, join, miter limit); `elements/svg.rs` provides an `svg()` element from a path or bytes; `input.rs` defines `EntityInputHandler` with UTF-16 ranges, marked-text and bounds methods for native text services (IME). — [canvas.rs](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/src/elements/canvas.rs); [path_builder.rs](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/src/path_builder.rs); [svg.rs](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/src/elements/svg.rs); [input.rs](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/src/input.rs)
- `gpui-component` 0.10.0 (2026-11-16, Apache-2.0), with releases roughly weekly (0.9.0 on 2026-11-02, 0.9.1 on 2026-11-09). Its README (now branded "GPUI Kit") claims 75+ components, AccessKit accessibility, WebAssembly, virtualised tables, dock layout, code editor, Markdown/HTML rendering and that it is used in the shipping Longbridge Pro app. Marketing claims, not independently verified. The repo URL answered "Moved Permanently" on the GitHub API (renamed). — [crates.io/gpui-component](https://crates.io/crates/gpui-component); [README](https://raw.githubusercontent.com/longbridge/gpui-component/main/README.md)
- Zed's own numbers (pass 1): stable 120 FPS on M1 ProMotion, render under 4 ms. — [zed.dev/blog/120fps](https://zed.dev/blog/120fps)
- Warp built its own Rust UI framework (WarpUI) instead of using Electron/Flutter, and reports that Rust's ownership model makes tree UIs hard, that it uses RefCell with occasional borrow-panic crashes, and that there is no hot reload. A secondary source claims Warp's framework forked from GPUI; Warp's own blog does not say so. Warp's client is reported open-sourced in April 2026 (GitHub shows 66k stars, AGPL-3.0). — [warp.dev blog](https://www.warp.dev/blog/why-is-building-a-ui-in-rust-so-hard); [github.com/warpdotdev/Warp](https://github.com/warpdotdev/Warp); [secondary summary](https://www.besthub.dev/articles/warp-open-sources-its-ai-terminal-gpu-accelerated-ui-agentic-development-50k-stars-e33d9611216b)

### Inferences
- Custom `canvas` painting with `PathBuilder` tessellates through lyon on each paint call, so thousands of tapered branches would need cached `Path` objects or your own pipeline. I did not verify GPUI's retained-path behaviour, image texture caching or zoom behaviour. Treat the canvas ceiling as unproven, not as a "5".
- GPUI is the most complete native-Rust option for ordinary app chrome (text input with IME hooks, menus per Zed, accessibility). The API churn risk is high: a 0.x crate that changes with Zed's needs.

### Gaps
- No source on GPUI image caching, mipmapping, `paint_path` batching, or an infinite-canvas example.
- No list of non-Zed apps beyond Longbridge Pro and (reportedly) Warp.
- Whether GPUI menus and file dialogs are native on Windows/Linux was not checked.

## 3. egui/eframe, iced, Slint, Makepad, Freya, Floem, Xilem/Masonry, Dioxus native

### Takeaway
egui is the most adopted, has a permissive licence and wgpu paint callbacks, and ships with AccessKit by default. Its weaknesses for this app are immediate-mode CPU/power cost and winit-level macOS limitations. iced and Floem are stagnant relative to the others. Slint is the most polished toolkit, but its licence is the constraint. Xilem/Masonry is still experimental. Makepad and Freya lack evidence I could find on text editing.

### Cited Findings (versions from crates.io on 2026-11-17)
- egui and eframe 0.37.0 (2026-10-15), MIT OR Apache-2.0, about 32M and 25M downloads. eframe default features include `accesskit` and `wgpu` (wgpu ^30.0). Its feature page says nothing about IME. — [crates.io/egui](https://crates.io/crates/egui); [docs.rs eframe features](https://docs.rs/crate/eframe/0.37.0/features)
- A real-world egui app (Tritium, a legal desktop app) reports: immediate mode rebuilds the UI every frame, costing power on laptops; business logic leaks into UI code; winit issue #4458 blocks access to the native macOS `NSApplication` delegate (open-with, URL handlers), fixed only in winit 0.31 (still beta: 0.31.0-beta.4, 2026-10-24); they abandoned a 45%-complete migration to Slint after four weeks because Slint also uses winit and the document pipeline would need a rewrite. The post says nothing on IME or accessibility. — [tritium.legal/blog/desktop](https://tritium.legal/blog/desktop); [crates.io winit](https://crates.io/crates/winit)
- winit macOS IME: winit has a preedit-aware IME API for macOS/Wayland/X11. A Korean-composition bug fix PR (#4478) was still open when searched, and a downstream project forked winit to carry it. egui IME-related PRs and issues exist. I found no clean statement of egui's current IME quality. — [winit #1497](https://github.com/rust-windowing/winit/issues/1497); [winit #4478](https://github.com/rust-windowing/winit/pull/4478); [egui #4362](https://www.Github.com/emilk/egui/pull/4362)
- iced 0.14.0 (2025-12-07; nothing newer in 11 months), MIT, 32k stars. `iced_core` 0.14 has an `input_method` module with preedit state; a third-party crate says there is no public API to inject IME composition into text_input. A Tessl guide recommends `Canvas` for 2D, `Shader` (wgpu) for dense rendering, and the advanced Widget API for custom events. — [crates.io/iced](https://crates.io/crates/iced); [iced_core input_method.rs](https://docs.rs/crate/iced_core/0.14.0/source/src/input_method.rs); [docs.rs oxiui-iced](https://docs.rs/oxiui-iced)
- Slint 1.19.0 (2026-11-16). Licence expression on crates.io: `GPL-3.0-only OR LicenseRef-Slint-Royalty-free-2.0 OR LicenseRef-Slint-Software-3.0`. So free use is GPL-3, or a "Royalty-free" licence (terms not read by me), or paid. A Ziggit user dropped Slint over licensing (pass 2 Zig notes). — [crates.io/slint](https://crates.io/crates/slint)
- Makepad: `makepad-widgets` 1.0.0 on crates.io dated 2025-05-13 (about 20k downloads); GitHub repo 7.6k stars, MIT, pushed 2026-11-16; third-party pages say Makepad 2.0 with a runtime "Splash" scripting language released 2026-02-12 (unverified, from skill-catalogue pages). Nothing found on IME or accessibility. — [crates.io](https://crates.io/crates/makepad-widgets); [GitHub API](https://api.github.com/repos/makepad/makepad)
- Freya (Skia-based): 0.5.2 stable, 0.6.0-alpha.1 on 2026-11-15, about 50k downloads. — [crates.io/freya](https://crates.io/crates/freya)
- Floem 0.2.0 dated 2024-11-14 (nothing newer on crates.io, so the crates.io release is two years stale). Lapce (built on Floem) latest release v0.4.6, 2026-01-21, 39k stars. — [crates.io/floem](https://crates.io/crates/floem); [GitHub API lapce](https://api.github.com/repos/lapce/lapce)
- Xilem and Masonry 0.4.0 on crates.io (2025-10-29, no newer release). Xilem's own README calls it "an experimental high-level architecture". It uses Parley/Fontique for text and AccessKit for accessibility. — [crates.io/xilem](https://crates.io/crates/xilem); [xilem README](https://raw.githubusercontent.com/linebender/xilem/main/README.md)
- Dioxus native: `dioxus-native` 0.7.10 (2026-10-16), 0.8.0-alpha.3 also out. Blitz renderer, experimental per pass 1. — [crates.io/dioxus-native](https://crates.io/crates/dioxus-native)
- Rerun's viewer is built on egui plus a custom wgpu renderer (`re_renderer`) integrated through eframe paint-callback resources. Rerun 0.43.2 was released 2026-11-13. This is the clearest "egui panels + custom wgpu viewport" case study, and its ARCHITECTURE doc says the whole GUI is laid out from scratch every frame. No source gave effort numbers. — [Rerun ARCHITECTURE.md](https://github.com/rerun-io/rerun/blob/main/ARCHITECTURE.md); [re_renderer README](https://docs.rs/crate/re_renderer/0.30.2/source/README.md); [GitHub API rerun](https://api.github.com/repos/rerun-io/rerun/releases/latest)
- Rnote (GTK4 + Rust vector notes with infinite canvas) and Lapce/Floem exist, but no performance numbers found. A GNOME Discourse dev claimed all mature Rust-native UI libraries "don't scale well" (anecdotal). — [github.com/flxzt/rnote](https://github.com/flxzt/rnote); [GNOME Discourse](https://discourse.gnome.org/t/deciding-what-ui-toolkit-i-should-use-for-my-daw/11285)
- Graphite: reported as a Rust editor with a desktop build in release-candidate stage in early 2026, with CEF used for the outer UI and the viewport run natively, rendering with wgpu and Vello. The sources conflict on Tauri vs CEF and are secondary. — [itsfoss](https://itsfoss.com/graphite-graphics-editor/); [openapps.pro](https://openapps.pro/apps/graphite)
- No 2026 Rust GUI survey found. Secondary comparison posts agree on egui for tools, iced for Elm-style, Slint for declarative/embedded, Xilem as experimental. — [pistack.xyz](https://www.pistack.xyz/posts/2026-08-25-rust-gui-frameworks-egui-iced-slint-comparison/)

### Inferences
- Can the canvas live inside it? egui: yes via an `egui_wgpu` paint callback, with the canvas being your own renderer (the Rerun pattern). iced: via `Shader` widget, but IME and focus are uncertain. Slint: custom rendering is possible but awkward, and the licence is a gating question. Makepad: GPU shader drawing is its core, but I found no text-editing evidence. Xilem/Masonry: has a Canvas widget (pass 1), but is experimental and has had no crates.io release since Oct 2025.
- For rich text editing in egui, you would likely use its `TextEdit` for plain fields; node text with inline rich formatting would be custom (Parley or cosmic-text) and IME marked-text would be your work.

### Gaps
- Could not verify egui's current macOS IME quality or AccessKit coverage of `TextEdit`. No evidence on Freya/Floem/Makepad text editing or IME. No measured large-scene egui results.
- Slint's Royalty-free licence terms were not read.

## 4. "Game-engine style": winit + wgpu + Vello (+ egui panels)

### Takeaway
This gives the highest ceiling and cross-platform reach, but the building blocks are in uneven states. wgpu is on 30.x, Vello 0.12.0 just released, and the GPU Vello renderer is now split into several variants of differing maturity. The toolchain is in motion, so budget for version churn.

### Cited Findings
- wgpu 30.0.2 (2026-11-12). winit 0.30.13 stable, 0.31.0-beta.4 (2026-10-24). — [crates.io wgpu](https://crates.io/crates/wgpu); [crates.io winit](https://crates.io/crates/winit)
- Vello crate 0.12.0 (2026-11-11). Its README: `vello_cpu` is "the most mature choice" (CPU, SIMD, multithreaded); `vello_gpu` preprocesses on CPU and rasterises/composites on GPU, supports wgpu and WebGL2, does not require compute shaders, and is "intended to become the primary production GPU renderer" but "less mature"; the original compute-shader `vello` is experimental and now under `research/`. `glifo` provides glyph-run/text support for both. MSRV 1.89. `vello_cpu` 0.4.0 (2026-11-11), `vello_hybrid` 0.2.0 (2026-08-07), `vello_svg` 0.11.0 (2026-09-10). Note: pass 1 reported vello_cpu 0.0.5 and vello_hybrid 0.0.6, which is stale. — [vello README](https://raw.githubusercontent.com/linebender/vello/main/README.md); [crates.io vello](https://crates.io/crates/vello); [crates.io vello_cpu](https://crates.io/crates/vello_cpu); [crates.io vello_hybrid](https://crates.io/crates/vello_hybrid); [crates.io vello_svg](https://crates.io/crates/vello_svg)
- Linebender's public benchmark of vello_cpu (Jul 2025, M1 Pro) compared Blend2D, Agg, tiny-skia, Cairo, Skia, JUCE using a fork of the Blend2D harness. I did not get the numbers. The authors noted tiny-skia is relatively worse on ARM. — [linebender.org tmil-19](https://linebender.org/blog/tmil-19/)
- The only Vello-vs-Skia statement I found is a Chromium blog saying the Skia team wants GPU compute path rasterisation ideas in Skia. No published Vello vs Skia Graphite/Ganesh frame times found. — [blog.google Chromium Graphite](https://blog.google/chromium/introducing-skia-graphite-chromes/)
- Linebender blog index shows latest items: Q1 2026 update (2026-04-19), "Fearless SIMD v1.0" (2026-09-22), "JIT bitmap text rendering for microcontrollers" (2026-11-07). — [linebender.org/blog](https://linebender.org/blog/)
- Building blocks, from crates.io 2026-11-17:

| Crate | Latest | Date | Notes |
|---|---|---|---|
| kurbo | 0.13.1 | 2026-05-13 | has `stroke`/`stroke_with` ("expand a stroke into a fill"), `offset` module for cubic offset curves, `flatten`, nearest-point, arclength. No variable-width stroke listed (per docs.rs) |
| lyon | 1.0.19 | 2026-03-08 | used inside GPUI; tessellation |
| tiny-skia | 0.12.0 | 2026-02-02 | CPU |
| skia-safe | 0.157.0 | 2026-11-03 | Skia bindings |
| resvg / usvg | 0.50.0 | 2026-11-11 | SVG |
| parley | 0.13.0 | 2026-11-12 | text layout; has `PlainEditor` with IME compose-range tracking |
| cosmic-text | 0.19.0 | 2026-04-22 | |
| swash | 0.2.10 | 2026-07-17 | |
| image | 0.25.10 | 2026-03-10 | |
| zune-image | 0.5.0 | 2026-01-24 | |
| rstar | 0.14.0 | 2026-11-01 | R-tree |
| taffy | 0.15.1 | 2026-10-25 | layout |
| accesskit | 0.25.2 | 2026-10-25 | |
| muda | 0.21.2 | 2026-10-08 | native menus |
| rfd | 0.18.0 | 2026-11-07 | file dialogs |
| arboard | 3.7.0 | 2026-10-15 | clipboard |
| rusqlite | 0.43.0 | 2026-11-15 | |
| loro | 1.18.0 | 2026-11-16 | CRDT |
| automerge | 0.12.0 | 2026-09-16 | CRDT |
| yrs | 0.28.1 | 2026-11-04 | CRDT |

  Sources: [crates.io API](https://crates.io/api/v1/crates/kurbo) (and the same URL pattern per crate); kurbo features from [docs.rs/kurbo](https://docs.rs/kurbo/latest/kurbo/); Parley editor from [docs.rs parley editor.rs](https://docs.rs/crate/parley/0.9.0/source/src/editing/editor.rs) (0.9.0 snapshot, older than current).
- Not verified: resvg/usvg SVG coverage and text handling, tokio/async-process and serde_json streaming (background knowledge: both are mature).

### Inferences
- Custom tapered branches: compute a centreline with kurbo, build offset curves for left/right edges per width profile, and fill the resulting closed path with Vello or lyon. Variable width is your own code on top of kurbo's offset support. Not a one-liner.
- Text along a curve: shape with Parley, then place each glyph with a per-glyph transform from arclength/tangent (kurbo gives arclength and nearest point). Vello glyph runs take transforms, but I did not verify per-glyph rotation. Arabic/cursive scripts would break per-glyph placement in any engine.
- Effort: a renderer plus camera, culling, glyph cache and image textures is a multi-month build; text editing with IME is extra on top.

### Gaps
- No Vello vs Skia frame-time numbers for path-heavy scenes; no Zed/GPUI vs Skia numbers; Blend2D benchmark numbers not extracted.
- vello_gpu has no crate version I could confirm (crates list `vello` 0.12.0 and `vello_hybrid` 0.2.0; the README's "vello_gpu" naming may not match a published crate).

## 5. Flutter, Qt, Compose Multiplatform, Avalonia

### Takeaway
Flutter 3.47 made Impeller the default on macOS, Windows and Linux. Flutter is the strongest non-Swift option with measured launch time and memory close to Swift in the one comparison found. Qt is the only stack that has a new vector-focused canvas API, but it is Technology Preview and GPL/commercial. Compose Desktop measured heavier. Avalonia has little evidence here.

### Cited Findings
- Flutter docs: Impeller is enabled by default on macOS, Linux and Windows as of Flutter 3.47; the opt-out will be removed in a future release. — [docs.flutter.dev/perf/impeller](https://docs.flutter.dev/perf/impeller)
- Secondary coverage dates the 3.47 desktop switch to Aug 2026 (Metal on macOS). — [startdebugging.net](https://startdebugging.net/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/)
- Same-app comparison (section 1): Flutter + Rust had about 200 ms launch, 200-230 MB RSS and a 27 MB DMG, versus Swift 1 s, 200-240 MB, 10 MB. The author found default Material look dated and in-window context menus. — [devmil.de](https://devmil.de/2026/06/30/2026-06-30-Desktop-framework-comparison/)
- I found no CustomPainter benchmark for thousands of paths under Impeller. Marketing posts with unsourced numbers were discarded. — search results only; see [Flutter docs](https://docs.flutter.dev/perf/impeller)
- Qt 6.11 introduced Qt Canvas Painter (Technology Preview, excluded from compatibility promises). It is based on the HTML Canvas 2D model, uses QRhi, bundles NanoVG (zlib), and is documented as available under commercial licence or GPLv3. Qt says it graduates to a supported module in 6.12. Its blog claims QCanvasPath uses about 60% less memory than QPainterPath, cached paths render a million line segments smoothly, and path groups map to GPU vertex buffers. Text and image APIs are not described there. — [doc.qt.io/qt-6.11/qtcanvaspainter-index.html](https://doc.qt.io/qt-6.11/qtcanvaspainter-index.html); [qt.io blog](https://www.qt.io/blog/qt-canvas-painter-accelerated-performance-using-paths); [Qt 6.11 licences](https://doc.qt.io/qt-6.11/licenses-used-in-qt.html)
- A FreeBSD package lists Canvas Painter as LGPL21, which conflicts with Qt's own docs (GPLv3/commercial). I trust Qt's docs. — [freshports](https://freshports.org/x11-toolkits/qt6-canvaspainter/)
- Compose Multiplatform 1.12.2 (2026-10-15); Skiko is on Skia milestone 150; macOS Metal renderer exists; known macOS `SwingPanel` bug in 1.11 alpha. — [GitHub releases](https://github.com/JetBrains/compose-multiplatform/releases); [kotlinlang.org what's new 1.12](https://kotlinlang.org/docs/multiplatform/whats-new-compose-112.html)
- Avalonia 12.1.6 (2026-11-09). I found no canvas performance or text-editing evidence for it. — [GitHub releases](https://github.com/AvaloniaUI/Avalonia/releases)
- Skia text on a curve: `SkPathMeasure::getPosTan` yields position and tangent, `SkRSXform` per glyph, then `SkTextBlob::MakeFromRSXform`. A skia-discuss thread says connected scripts such as Arabic break with per-glyph RSXform. `skia-safe` 0.157.0 exposes the blob API. Compose Desktop has a documented text-on-path write-up using Skia. — [Skia Path_addRRect_2 example](https://skia.googlesource.com/skia/+/main/docs/examples/Path_addRRect_2.cpp); [skia-discuss Arabic](https://groups.google.com/g/skia-discuss/c/7t5uBnhpq8U); [pushing-pixels.org](https://www.pushing-pixels.org/?p=18478)

### Inferences
- Flutter: `CustomPainter` runs Skia/Impeller paths with `Path.computeMetrics()` for text-on-path, and FFI to Rust is well-trodden (flutter_rust_bridge, background knowledge, not sourced). Text editing is Flutter's own widget layer (mature) but inline rich-text editing on a zooming canvas is custom work. Dart is a third language for this developer.
- Qt: a decisive advantage is the full mature widget/text/IME/menu/accessibility toolkit; the cost is C++/QML plus GPL-or-commercial terms. Qt Canvas Painter is NanoVG-derived, so it carries NanoVG's re-tessellation limits (see Zig notes).
- No stack here shows a decisive canvas advantage over a Metal/wgpu custom renderer. Their value is in the non-canvas UI.

### Gaps
- No Flutter CustomPainter, Qt Quick, Avalonia or Compose frame times for thousands of paths. Avalonia not researched beyond version.
- Qt LGPL status of Qt Quick/Widgets in 6.11 was not confirmed on the page I fetched (it only listed third-party components); the common understanding is LGPL for most modules, but I have not sourced it.

## 6. Elixir with a native shell

### Takeaway
Keeping Elixir is technically possible as a sidecar over stdio or a Unix socket, but I found no measured idle memory or startup number for an embedded BEAM release, and Burrito sources do not discuss them. A reported OTP 27/28 boot time of 5-10 s is a secondary claim that needs checking.

### Cited Findings
- No 2025-2026 measurement of idle RSS or startup for a Burrito or Mix release was found. An Elixir Forum post reports 48 MB code memory in embedded mode vs about 23 MB interactive (old thread). A DevBytes post claims Erlang 27/28 boots in 5-10 s and is a "major pain point" (unverified secondary). — [elixirforum](https://elixirforum.com/t/code-memory-size-different-from-dev-to-prod/61952); [devbytes.co.in](https://devbytes.co.in/news/erlang-27-28-slow-boot-times-5-10s-is-a-major-pain-point)
- Pass 1 already covers ElixirKit + Tauri, Burrito 1.6.0 and its signing caveats. The ElixirKit docs say it targets desktop OSes and the Livebook desktop app is built on it. — [elixirkit.hexdocs.pm/tauri](https://elixirkit.hexdocs.pm/tauri.html)

### Inferences
- A Swift or Rust shell can spawn a BEAM release as a child process and talk JSON lines over stdio (which fits Codex JSONL), or a Unix socket. Rustler NIFs only matter if Rust is hosted inside the BEAM, which inverts the architecture and is not needed here.
- Spawning Codex, reading JSONL and restarting on failure is a few hundred lines in Swift (`Process` + async streams) or Rust (tokio). So Elixir's marginal value is supervision and the developer's fluency, not capability. For a native shell, carrying the BEAM adds a second runtime plus separate signing and notarisation for the embedded release (per ElixirKit docs). I would not carry it unless the AI-orchestration logic becomes large.

### Gaps
- Burrito/Mix release idle memory, startup, and size numbers: not found.

## 7. Distribution on macOS

### Takeaway
Little sourced evidence beyond Sparkle's version and ElixirKit's signing notes. The rest is background knowledge.

### Cited Findings
- Sparkle 2.10.1 (2026-10-25). — [GitHub](https://github.com/sparkle-project/Sparkle/releases)
- ElixirKit: embedded Elixir release must be signed separately; Tauri signs only the Rust side; notarisation needs a paid Apple Developer account. — [elixirkit.hexdocs.pm/tauri](https://elixirkit.hexdocs.pm/tauri.html)
- Same-app DMG sizes: Swift 10 MB, Flutter 27 MB, Compose 73 MB (JRE about 70 MB per a Medium comparison). — [devmil.de](https://devmil.de/2026/06/30/2026-06-30-Desktop-framework-comparison/); [Medium](https://medium.com/@zhuravl321/swift-vs-compose-multiplatform-a-real-world-performance-comparison-dff90b0f8522)

### Inferences (background knowledge)
- Swift, Rust, Zig, and Flutter binaries are signed and notarised with standard Apple tooling; Sparkle fits Swift shells and can update a Rust/Zig-based app too; universal binaries come from building both aarch64 and x86_64 and `lipo`. I did not verify any of this in sources this pass.

### Gaps
- No sourced notarisation, auto-update or universal-binary detail for GPUI, egui, Flutter or Qt.

## 8. Text editing, IME, accessibility, menus: completeness by stack (evidence level noted)

| Stack | Text input / IME | Accessibility | Native menus | Evidence |
|---|---|---|---|---|
| AppKit/TextKit | native (not sourced) | native (not sourced) | native | background |
| GPUI | `EntityInputHandler` trait with UTF-16 ranges for native text services | AccessKit topic in README, gpui-component claims AccessKit | not verified | source code read |
| egui | `TextEdit` plus winit IME; macOS Korean bug open in winit | AccessKit is a default eframe feature | via `muda` (separate crate 0.21.2) | partial |
| iced | IME plumbing in core; `text_input` completeness unverified | not verified | not verified | weak |
| Slint | not verified | not verified | not verified | none |
| Xilem/Masonry | Parley `PlainEditor` tracks IME compose range | AccessKit | not verified | partial |
| Makepad | not found | not found | not found | none |
| Qt | mature (background) | mature (background) | native | background |
| Flutter | mature (background) | present (background) | in-window context menus; plugins for native menus | [devmil.de](https://devmil.de/2026/06/30/2026-06-30-Desktop-framework-comparison/) for menus only |

## 9. Case studies: what they say about effort

### Takeaway
Evidence is thin and mostly negative on effort: Warp called its custom framework "a big investment", Tritium abandoned a UI migration, Ghostty rewrote its GUI several times. None gave person-months.

### Cited Findings
- Warp: "very tricky" and "a big investment"; chose a custom GPU framework because Electron/Flutter would make terminal performance hard. — [warp.dev blog](https://www.warp.dev/blog/why-is-building-a-ui-in-rust-so-hard)
- Rerun: egui panels with a custom wgpu renderer is a shipping pattern (0.43.2 on 2026-11-13). — [Rerun ARCHITECTURE.md](https://github.com/rerun-io/rerun/blob/main/ARCHITECTURE.md)
- Tritium: egui to Slint migration stopped at 45% after four weeks; macOS delegate bug in winit. — [tritium.legal/blog/desktop](https://tritium.legal/blog/desktop)
- Graphite: native viewport with CEF chrome (secondary, conflicting). — [itsfoss](https://itsfoss.com/graphite-graphics-editor/)
- Zed: GPUI shipping on Metal at 120 FPS. — [zed.dev/blog/120fps](https://zed.dev/blog/120fps)

### Gaps
- Lapce, Rnote and Zed effort reports not found.

## 10. Frame-time comparisons: Skia vs Vello vs Core Graphics vs Canvas2D

### Takeaway
I found no credible published frame-time comparison for a path-heavy 2D scene across these renderers. Treat all "X is faster" claims as unproven for this workload.

### Cited Findings
- Linebender's CPU renderer benchmark vs Blend2D/Skia/tiny-skia exists (Jul 2025, M1 Pro) but I did not extract numbers. — [linebender.org tmil-19](https://linebender.org/blog/tmil-19/)
- Vello has a MotionMark 1.2 path-test adaptation on a branch. Numbers not found. — [Vello mmark branch (Skia mirror)](https://skia.googlesource.com/external/github.com/linebender/vello/+/refs/heads/mmark)
- Qt claims smooth rendering of a million cached line segments. A vendor claim for its own QRhi path. — [qt.io blog](https://www.qt.io/blog/qt-canvas-painter-accelerated-performance-using-paths)
- nanoui and Zed numbers are in the earlier notes and do not cover Bezier paths.

### Gaps
- Everything else: you need a spike (5,000 tapered paths + 300 textures) on the target stack.

## 11. Architecture options for portability

### Inferences (judgement)
- Ghostty-style: Swift shell on macOS + Rust or Zig core, with a second shell later (WinUI/GTK), or the core drives its own wgpu window on other platforms. Rust is a better core language than Zig for this developer's needs because the Rust building blocks (kurbo, lyon, rstar, parley, rusqlite, loro) are current and active (section 4), while Zig churned twice in 2026 (zig notes).
- Render path in the Swift shell: either Metal drawing from vertex buffers produced by the core (best macOS result, new renderer per platform), or the core renders with wgpu/Vello into a surface that the shell hosts (one renderer, but Vello GPU variants are still maturing).
- Bridging: UniFFI for the model/command API (mature), plus raw C ABI/shared memory for per-frame draw lists.

## 12. Comparison matrix (1-5, higher is better; judgement from the cited facts above)

| Stack | Canvas ceiling | UI/text completeness | Speed to first good version (for this developer) | Maturity/risk | Cross-platform reach | Footprint | Long-term maintainability |
|---|---|---|---|---|---|---|---|
| Swift/AppKit + Metal (pure Swift) | 5: Metal, ProMotion, no webview cap | 5: AppKit/TextKit/IME/menus native | 3: new language and Metal pipeline, but no bridging | 5: stable first-party APIs | 1: macOS only | 5: 10 MB DMG in comparable app | 4: stable APIs, lock-in |
| Swift shell + Rust core | 5: same Metal, core builds geometry | 5: native shell | 3: two languages, UniFFI is mature | 4: UniFFI 0.32, Rust crates active | 3: core reusable, new shells needed | 5 | 4: clean split, bridge upkeep |
| Swift shell + Zig core | 5 | 5 | 2: Zig 0.16 and 0.17 both broke APIs, ZLS broken on 0.17 | 3: Zig pre-1.0 | 3: Ghostty proves it, shells needed | 5 | 3: churn confined to core |
| GPUI (Rust) | 3: unproven for thousands of paths; Zed shows 120 FPS UI | 4: IME trait, accessibility, 75+ components | 3: Rust and GPUI idioms, pre-1.0 API | 2: pre-1.0, breaking changes | 4: macOS, Linux, Windows listed | 5 | 2: tracks Zed's churn |
| winit + wgpu + Vello + egui | 5: own renderer, Rerun precedent | 3: egui widgets, custom IME/rich text, winit macOS gaps | 2: renderer + text + glyph work is yours | 3: wgpu 30 and egui 0.37 are active, Vello GPU is evolving | 5 | 5 | 3: churn in several crates |
| egui only (painter) | 3: CPU-tessellated painter, per-frame cost | 3: TextEdit, AccessKit default | 4: fastest Rust route to something | 4: widely used, 0.37 | 4 | 5 | 3: immediate-mode logic creep (Tritium) |
| Flutter | 4: Impeller default on desktop, unmeasured on this workload | 4: mature text, dated look, in-window menus | 3: Dart is a third language, canvas custom | 4: 3.47 | 5 | 4: 27 MB DMG, 200-230 MB RSS in one test | 4 |
| Qt | 4: Canvas Painter is TP and NanoVG-based; custom QSG possible | 5: full toolkit (background) | 2: C++/QML | 4: mature core, Canvas Painter new | 5 | 3 | 3: GPL or commercial licence |
| Tauri + web canvas (pass 1) | 3: WKWebView rAF 60 FPS cap on macOS 13-15 | 5: DOM text/IME | 5: web tooling, Elixir sidecar possible | 4: Tauri 2.11 | 4 | 5 | 4 |
| Electron + web canvas (pass 1) | 4: Chromium | 5 | 5 | 5 | 5 | 1: about 245-325 MB | 4 |
| Zig nanoui/dvui (pass 1) | 2: unproven for paths | 2: dvui lacks RTL/graphemes; nanoui macOS IME only | 1 | 1: nanoui is one month old | 3 | 5 | 1 |

Scoring notes: "Canvas ceiling" is the highest the stack could reach with enough work, discounted where my sources show unmeasured or capped behaviour. No row is backed by a measurement for this workload.

## 13. Updated overall ranking (judgement)

1. Swift shell (AppKit + Metal) + Rust core. Choose it if macOS quality and 120 Hz matter most, Windows/Linux are "later, maybe", and you accept a second language. Best fit for the stated priority (best app, fastest path to excellent performance) because text, IME, menus, accessibility and updates are first-party and the Rust core keeps geometry and model portable.
2. Tauri + web canvas (WebGL2/WebGPU), with Elixir or Rust orchestration. Choose it if time-to-first-version and Elixir reuse matter more than a hard 120 Hz guarantee. Check on macOS 26 first, because the 60 FPS cap evidence is for macOS 13-15.
3. Pure Swift/AppKit + Metal. Choose it if you will never leave macOS and want the fewest moving parts. It ranks just under #1 only because the core is not reusable.
4. Flutter. Choose it if cross-platform from day one matters and you will accept Dart. It had the fastest launch of the three native stacks measured in one test, but nobody published path-heavy canvas numbers.
5. Electron + web canvas. Choose it if consistent rendering across OSes and WebGPU matter more than size.
6. winit + wgpu + Vello + egui. Choose it if you want one Rust codebase on all OSes and are willing to build text input and rich text yourself. Highest ceiling but the longest road.
7. GPUI. Choose it if you want one Rust codebase and good chrome, and can absorb API churn. Re-evaluate once a canvas spike on it passes.
8. Qt. Choose it if you want a complete toolkit and accept C++/QML and GPL or commercial terms.
9. egui only. Fine for a throwaway prototype of the canvas.
10. Swift shell + Zig core, then Zig nanoui/dvui. Choose Zig only if learning Zig is itself a goal.

The one piece of missing evidence stays the same as in pass 1: a day-long spike with 5,000 tapered paths and 300 textures on the shortlisted stacks (Metal from Swift, Tauri WKWebView, Flutter CustomPainter), measured on the developer's own Mac.

## Gaps (cross-cutting)
- No published internals for MindNode, Freeform, OmniGraffle or Sketch.
- No measured frame times for any stack on the target workload.
- egui and iced IME quality on macOS, Slint and Makepad text editing: not verified.
- GPUI image caching, path caching and infinite-canvas behaviour: not verified.
- Burrito/BEAM idle memory and startup: not found.
- macOS signing, notarisation and universal-binary details beyond Sparkle's version: background knowledge only.
- Qt Quick/Widgets LGPL status for 6.11: not confirmed on the pages I fetched.
