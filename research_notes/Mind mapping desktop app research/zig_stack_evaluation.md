# Zig Stack Evaluation for a High-Performance Desktop Mind-Mapping App (as of 2026-11-17)

Method note: GitHub star/push dates below were read from the GitHub API on 2026-11-17 (source column "GitHub API" = https://api.github.com/repos/OWNER/REPO, e.g. https://api.github.com/repos/justrach/nanoui). Local machine: `zig version` = 0.17.0 (Homebrew, /opt/homebrew/Cellar/zig/0.17.0). I did not benchmark anything myself. Effort estimates are my judgement, labelled as such. Research budget was limited (~20 calls), so several items are flagged as gaps.

## 1. What is "Nano UI for Zig"?

### Takeaway
A project literally named **nanoui** for Zig exists: github.com/justrach/nanoui ("Desktop apps in Zig, with native UI drawn on the GPU or a web frontend"). It is the most probable match. It is also the user's own two architectures in one library (native GPU UI, or system-webview frontend). But it is only ~1 month old (created 2026-10-18), pre-1.0, fast-moving, apparently heavily AI-agent-developed, and not designed for a pan/zoom Bezier canvas with thousands of nodes. NanoVG (and fabioarnold/nanovg-zig) is the secondary candidate for the vector-canvas part.

### Cited Findings
- nanoui: 908 stars, MIT, repo created 2026-10-18, last push 2026-11-16, 775 commits, 20 contributors, first release v0.1.0 on 2026-10-19; latest release 0.14.6 (15 Nov). — [GitHub API](https://api.github.com/repos/justrach/nanoui), [Releases](https://github.com/justrach/nanoui/releases)
- Requires Zig 0.17.0; "While nanoui is 0.x, a minor release may change the API; a patch release won't." Release cadence is extreme: 0.11.0 (3 Nov) to 0.14.6 (15 Nov). — [README](https://github.com/justrach/nanoui), [Releases](https://github.com/justrach/nanoui/releases)
- Two window content kinds: native UI (Zig only, immediate mode, flexbox layout, glyph-atlas text, animation, offscreen-testable) or a web page in system webview (WKWebView / WebView2 / WebKitGTK) calling Zig through a generated JS client with TypeScript declarations. — [README](https://github.com/justrach/nanoui)
- Renderers: Metal + CoreText on macOS/iOS ("one instanced draw call per frame"), OpenGL or CPU on Linux/Android, Direct3D 11 on Windows (D3D11 landed in 0.14.0, 9 Nov). No WebGPU. — [README](https://github.com/justrach/nanoui), [Releases](https://github.com/justrach/nanoui/releases)
- Widgets: buttons, checkboxes, toggles, sliders, progress, segmented controls, badges, text fields (IME on macOS, iOS, Linux; not Windows/Android), virtualized list, rich text spans, selection, truncation; `ui.svg` draws SVG paths/shapes/fills/strokes/transforms (used for icons); images decoded once and packed into an atlas; `ui.canvas` exists (used for the nanofly map); trackpad `input.zoom`/`input.pan` events exposed. Accessibility only for macOS/iOS built-in controls; no native menus/notifications/plugins listed as gaps. — [README](https://github.com/justrach/nanoui)
- Repo contains `AGENTS.md`, `.agents`, `hillclimb/`, `lean-proofs/`; release notes mention "600-line limits" git hooks and agent setup; `nui` CLI is designed "for people and for coding agents alike". Indicates agent-driven development. — [repo listing via GitHub API](https://api.github.com/repos/justrach/nanoui/contents), [README](https://github.com/justrach/nanoui)
- Self-published benchmarks (M3 Ultra, headless, own harness vs author's Go framework "mygo"): 600 shadowed boxes 0.061 ms CPU / 0.140 ms GPU per frame; 300 changing labels 0.108 ms CPU; release binary ~0.7 MB; idle apps use no CPU. Not independently verified, and not a Bezier/zoom workload. — [README Performance section](https://github.com/justrach/nanoui)
- Showcase apps by the same author/ecosystem: nanoterm, nanomon, nanostudio, nanofly (map with pinch zoom via `ui.canvas`), nanomail, nanolight, nanodocs, nanobrowser. — [README](https://github.com/justrach/nanoui)
- Other "nanoui" hits are unrelated: KevinKelley/nanoui is a Rust vector-graphics UI library built on NanoVG. — [search result](https://github.com/KevinKelley/nanoui)
- NanoVG-Zig (fabioarnold/nanovg-zig): rewrite of NanoVG in Zig, 248 stars, last push 2026-01-29; canvas-like API, bezier paths with holes, strokes with caps/joins, gradients, text with line breaks, image patterns, plus clip paths; WebGL/wasm and GLFW+OpenGL examples. No native Metal backend mentioned; no widgets/text input. — [README](https://github.com/fabioarnold/nanovg-zig), [GitHub API](https://api.github.com/repos/fabioarnold/nanovg-zig)
- No NanoGUI (Wenzel Jakob) Zig binding turned up in my searches (not exhaustively checked). — search results above ([nanoui search](https://github.com/justrach/nanoui/wiki))

### Inferences
- The user's "Nano UI for Zig" is almost certainly justrach/nanoui (name match, Zig, recent, and the webview option the user also mentioned). Probability judgement: high.
- It is promising but a bet on a one-month-old, single-maintainer-led, agent-generated codebase whose API is explicitly unstable. Its text path (CoreText on Mac) is good quality on macOS; rich-text editing (selection across spans, inline editing in a canvas node) is unproven.
- For the mind-map canvas, nanoui's `ui.canvas`/`ui.svg` are unproven at 5,000 tapered Beziers + 500 mipmapped textures; the "one instanced draw call" design is oriented to UI rects/glyphs, not curve tessellation. You would still write your own Bezier renderer.

### Gaps
- Could not read nanoui's `ui.canvas` source/API, whether textures support mipmaps, or whether images/SVG nodes can be scaled over huge zoom ranges.
- No third-party reviews/user reports of nanoui found (it is too new).

## 2. Zig-native GUI and rendering ecosystem (late 2026)

### Takeaway
No Zig GUI toolkit is production-grade for a rich-text, IME-capable, accessible, multi-panel desktop app. dvui is the most active/mature; sokol-zig and zig-gamedev (zgpu/zglfw/zgui) are solid low-level foundations; Capy and Mach's GUI story are stale. SVG/vector quality would come from C/C++ libraries (ThorVG, Skia, Blend2D) via Zig's C interop rather than Zig-native libs.

### Cited Findings
- **dvui** (immediate mode): 1.8k stars, last push 2026-11-17, 4,356 commits; tested with Zig 0.17.0 on main; tag v0.5.0 for Zig 0.16.0 (v0.4.0/branch zig15 for 0.15). Backends: SDL3 (+SDL3GPU), SDL2, raylib, DX11, GLFW, wio, pugl, Web. Single/multi-line text entry; IME only in SDL and Web backends; AccessKit screen-reader support optional (`-Daccesskit`); text is one glyph per codepoint (no grapheme clusters, RTL, mixed direction); no direct SVG (icons via TinyVG; SVG-to-TinyVG converter); raster via stb_image; no API stability statement; multi-OS-window not documented. — [dvui README](https://github.com/david-vanderson/dvui), [GitHub API](https://api.github.com/repos/david-vanderson/dvui)
- dvui was the most endorsed library in a June 2026 Ziggit thread on a Markdown notes app; IME and rich-text quality were not discussed; a Feb 2026 thread "GUI library for rich text?" and "Dvui: Problem with displaying unicode characters" exist. — [Ziggit recommendation thread](https://ziggit.dev/t/recommended-gui-library-framework-for-a-markdown-note-taking-application/), [Ziggit GUI tag](https://ziggit.dev/tag/gui)
- Newer entrants on Ziggit: Knots (Oct 2026), Quark (Jun 2026), Slint-zig bindings (May 2026; Slint licensing caused one user to drop it), AMP music player (Nov 2026). Unvetted. — [Ziggit GUI tag](https://ziggit.dev/tag/gui), [thread](https://ziggit.dev/t/recommended-gui-library-framework-for-a-markdown-note-taking-application/)
- **Capy** (native widgets): 2.7k stars, last push 2025-12-25, latest release v0.5.0 on 2026-10-13 (observed via API), README says it targets Zig 0.14.1 and plans to return to nominated versions; macOS listed as in-progress. Judged lagging. — [GitHub API](https://api.github.com/repos/capy-ui/capy), [README](https://github.com/capy-ui/capy)
- **Mach**: GitHub is a mirror (code.hexops.com is primary), 4.9k stars, last mirror push 2026-05-23; latest GitHub release tag v0.3.0 (2023-02-12), pitched as "game engine & graphics toolkit... desktop/mobile GUI apps"; mach-core last pushed 2024-03-06. — [GitHub API mach](https://api.github.com/repos/hexops/mach), [mach-core](https://api.github.com/repos/hexops/mach-core)
- **zig-gamedev**: zgui (Dear ImGui bindings) 173 stars pushed 2026-09-26; zgpu (Dawn WebGPU) 102 stars pushed 2026-10-23; zglfw pushed 2026-10-21; umbrella repo 2.9k stars pushed 2026-10-25. — [zgui](https://api.github.com/repos/zig-gamedev/zgui), [zgpu](https://api.github.com/repos/zig-gamedev/zgpu), [zglfw](https://api.github.com/repos/zig-gamedev/zglfw)
- **sokol-zig**: 743 stars, pushed 2026-11-10, README says "For Zig version >= 0.16.0"; (sokol_app/sokol_gfx give window + Metal/GL/D3D11/WebGPU abstraction; I did not verify IME/multi-window). — [GitHub API](https://api.github.com/repos/floooh/sokol-zig), [README](https://github.com/floooh/sokol-zig)
- **raylib-zig**: Not-Nik/raylib-zig is archived (last push 2025-08-07); raylib itself very active (35.7k stars, push 2026-11-17); dvui consumes raylib via C and raylib-zig bindings. — [GitHub API](https://api.github.com/repos/Not-Nik/raylib-zig), [raylib](https://api.github.com/repos/raysan5/raylib)
- **SDL3**: very active C library (17k stars, push 2026-11-17); the Zig wrapper Beyley/zig-sdl3 shows 0 stars, last push 2025-08-13 (a different wrapper may be canonical; not resolved). dvui uses SDL3 directly. — [SDL](https://api.github.com/repos/libsdl-org/SDL), [dvui README](https://github.com/david-vanderson/dvui)
- **Clay Zig bindings**: Gota7/zig-clay last push 2025-01-19 (22 stars); ssttevee/zig-clay 2025-07-12 (3 stars). Stale. — [search via GitHub API](https://api.github.com/search/repositories?q=zig+clay)
- **ThorVG** (C++; SVG + Lottie; WebGPU backend): 1.9k stars, pushed 2026-11-17. Zig bindings: Hato1125/thorvg-zig (1 star, 2026-10-03), SuperAuguste/thorvg-zig-example (2024). Usable through C API (`thorvg_capi`) with Zig's C interop. — [ThorVG](https://api.github.com/repos/thorvg/thorvg), [bindings search](https://api.github.com/search/repositories?q=thorvg+zig)
- **allyourcodebase/freetype** (FreeType via zig build): 20 stars, pushed 2026-10-28; Ghostty also maintains Zig packaging of FreeType/HarfBuzz-style deps (not verified in detail). — [GitHub API](https://api.github.com/repos/allyourcodebase/freetype)
- **nanovg-zig**: see section 1 (248 stars, Jan 2026).
- **zig-objc** (Mitchell Hashimoto): Objective-C runtime bindings, 361 stars, pushed 2026-10-20; supports calling ObjC, passing blocks. — [GitHub API](https://api.github.com/repos/mitchellh/zig-objc), [README](https://github.com/mitchellh/zig-objc)
- A Ziggit "Microui reimplementation in Zig" (Sep 2025) exists; microui is minimal (no text editing/IME beyond basics). — [Ziggit GUI tag](https://ziggit.dev/tag/gui)

### Inferences
- Feature matrix (my judgement from above): Text IME: nanoui (mac/Linux) and dvui (SDL/Web) only. Accessibility: nanoui (mac controls only) and dvui (AccessKit optional). Native menus: nanoui (macOS AppKit shell, mentioned fixes to macOS menus in 0.14.0) is the only Zig-native option indicated; dvui/sokol/raylib/GLFW need custom menus or ObjC glue via zig-objc. Multi-window: nanoui (iPad windows, `newWindow`) yes; dvui unclear. HiDPI: all SDL/GLFW/sokol-based stacks support it (standard), not individually verified.
- Rendering of rich text and SVG would have to be assembled from C libraries (HarfBuzz/FreeType or CoreText; ThorVG/resvg/Skia) regardless of which Zig GUI is chosen.

### Gaps
- Did not verify zgui/sokol/raylib IME or multi-window; did not locate a definitive Zig Skia binding (none surfaced); Blend2D/Vello/resvg Zig integration not researched; Clay/plutovg/lunasvg/NanoSVG not individually checked; zig-webui feature set not read.

## 3. 2D vector rendering for the canvas (5,000 tapered Bezier branches + text + 500 textures at 120 Hz)

### Takeaway
Nothing in the Zig ecosystem is proven for this workload; it is achievable on Apple Silicon only with a custom GPU path (tessellate tapered branch ribbons into triangle strips on CPU/GPU cache, instanced glyph quads, texture atlas/virtual texturing), and the effort is the same regardless of language. This part is language-agnostic; Zig's advantage is cheap data-oriented layout and C interop. Limited evidence found; mostly judgement.

### Cited Findings
- NanoVG is "aimed at scalable user interfaces or real time visualizations", canvas-style API; the Zig port provides bezier paths, caps/joins, gradients, image patterns, clip paths. — [nanovg-zig README](https://github.com/fabioarnold/nanovg-zig)
- ThorVG advertises SVG and Lottie with WebGPU backend, actively developed. — [ThorVG](https://api.github.com/repos/thorvg/thorvg)
- nanoui's own measurements cover boxes/text/lists only (0.06-0.3 ms CPU frame times for ~600-1000 element scenes on M3 Ultra), not path rendering. — [nanoui README](https://github.com/justrach/nanoui)

### Inferences (judgement, unverified numbers)
- NanoVG stencil-and-cover re-tessellates every frame on CPU: ~5,000 curves each frame is feasible only if static geometry is cached; 120 Hz (8.3 ms budget) is tight with a naive immediate-mode redraw; cache branch meshes per node and only retessellate on edit/collapse animation.
- Tapered variable-width strokes are not native NanoVG strokes; build them as filled polygons (offset curves) in either approach.
- Best-fitting plan: custom Metal (or sokol_gfx/wgpu) renderer with cached triangle-strip meshes + SDF/atlas glyphs + LOD textures. SVG subtrees: rasterize with ThorVG/resvg at zoom thresholds into textures (cached), not live per frame.

### Gaps
- No published benchmark found for any library on "5,000 tapered Beziers at 120 Hz". Vello/Blend2D/Skia via C ABI from Zig not evaluated here.

## 4. Case studies: serious Zig applications

### Takeaway
Ghostty is the flagship, and it deliberately does NOT use a Zig GUI toolkit: Zig core exported as a C library (libghostty) with native Swift/AppKit on macOS and GTK4 on Linux. That is Architecture C and is the strongest evidence for what works. I found no shipping, widely used rich-text/editor-style GUI app built on a Zig-native GUI toolkit.

### Cited Findings
- Ghostty: 64k stars, active (push 2026-11-17). Core libghostty in Zig with C-compatible API; macOS app in Swift (AppKit/SwiftUI); Linux uses GTK4 C API. — [Ghostty about](https://ghostty.org/docs/about), [GitHub API](https://api.github.com/repos/ghostty-org/ghostty)
- Hashimoto: ~93% of repo is Zig/C business logic, ~4% macOS Swift GUI; native GUI per platform because truly native macOS needs Swift, Windows needs C++/C#; Objective-C was impractical; build pipeline uses static lib + libtool + lipo + XCFramework; "Zig is still changing" (he used 0.11 nightly then). — [mitchellh.com/writing/zig-and-swiftui](https://mitchellh.com/writing/zig-and-swiftui)
- Hashimoto said Ghostty's GUI was written five times (GLFW, SwiftUI, AppKit+SwiftUI, GTK...), and that Zig's lazy analysis helps platform-specific code. (Secondhand summary of a 2025 interview; treat with care.) — [Ghostty GTK rewrite post](https://mitchellh.com/writing/ghostty-gtk-rewrite), [Terminal Trove interview](https://terminaltrove.com/feed/blog/terminal-trove-talks-with-mitchell-hashimoto-ghostty/)
- Electrobun (TypeScript desktop framework): 13.1k stars, pushed 2026-11-15; platform layer is Zig + Objective-C + C++ with Bun runtime; official macOS 14+, Windows 11, Ubuntu 24.04. — [GitHub](https://github.com/blackboardsh/electrobun)
- nanoui showcase apps (nanoterm, nanomon, nanolight, nanomail...) are all very recent and small-user-base. — [nanoui README](https://github.com/justrach/nanoui)
- A Ziggit user reports "Fizzy" is built with dvui. — [Ziggit thread](https://ziggit.dev/t/recommended-gui-library-framework-for-a-markdown-note-taking-application/)

### Inferences
- Lesson: even the most prominent Zig GUI-adjacent project concluded native UI per platform + Zig core. For rich text editing with IME and menus, that avoids rebuilding AppKit.
- Bun, TigerBeetle, River not researched in detail (not GUI).

### Gaps
- Did not verify Bun/TigerBeetle/River/Flow details; no evidence found of a dvui/Capy app with commercial-scale usage.

## 5. Architecture A: Pure Zig native UI + custom GPU canvas

### Takeaway
Feasible for the canvas, high risk and high effort for everything around it. Verdict (judgement): not recommended as the primary path unless the user wants this as a long-term craft project; nanoui lowers the bar on macOS but is a one-month-old moving target.

### Cited Findings
- dvui: IME only SDL/Web; no RTL/graphemes; no direct SVG; no stability promise. — [dvui README](https://github.com/david-vanderson/dvui)
- nanoui: no native menus/notifications/plugins listed yet; accessibility limited to macOS/iOS built-ins; text field IME on macOS present. — [nanoui README](https://github.com/justrach/nanoui)
- Zig 0.16 removed or reworked many APIs; 0.17 changed build system and removed `@cImport` (details in section 8) — churn flows through every dependency (e.g. Capy still on Zig 0.14.1). — [0.17 notes](https://ziglang.org/download/0.17.0/release-notes.html), [Capy README](https://github.com/capy-ui/capy)

### Inferences (judgement)
- Must build/own: infinite canvas camera, spatial index, tapered Bezier renderer, text layout (shaping via CoreText on mac / HarfBuzz elsewhere), rich-text inline editor with IME marked text/selection/undo, SVG rasterization (ThorVG/resvg C lib), image decode/mip/lazy streaming (stb_image / ImageIO), inspector/toolbar widgets (dvui or nanoui), native menus/file dialogs/drag-drop/clipboard (AppKit via zig-objc or nanoui).
- Effort estimate (single experienced dev, my rough guess): MVP canvas + text labels 3-4 months; polished text editing/IME/accessibility/SVG/images 6-12 more months. Risk: High (framework churn, text editing correctness, accessibility gaps).

### Gaps
- No real-world effort data for Zig GUI apps found.

## 6. Architecture B: Zig shell embedding system WebView

### Takeaway
Technically possible (webui, webview C lib, zig-objc + WKWebView, nanoui's web pages, Electrobun), but for a Zig-hosted WKWebView canvas the 120 Hz requirement is the blocker on macOS: WKWebView requestAnimationFrame appears still capped at 60 Hz as of the latest evidence I found (2025). Zig buys little over Tauri here; Tauri is far more mature. Verdict: weakest of the three for the stated performance goal.

### Cited Findings
- WKWebView rAF is throttled to 60 Hz by default; Safari's 120 Hz flag does not apply to WKWebView; Apple forum thread (FB16411517, Jan-May 2025) has no Apple response; WebKit bug 173434 open since 2017, 2025 duplicate bug 294338 requests an opt-in for hybrid apps. I found no evidence this is fixed in 2026; not confirmed either way. — [Apple forums](https://developer.apple.com/forums/thread/773222), [WebKit bug 294338](https://bugs.webkit.org/show_bug.cgi?id=294338), [WebKit bug 173434](https://bugs.webkit.org/show_bug.cgi?id=173434)
- Electrobun: system webview by default (WebKit/WebView2/WebKitGTK), optional bundled CEF (Chromium); ~12 MB bundles; v1 in Feb 2026; v1.15.1 added WGPU surfaces inside webviews; `bundleWGPU` lets Bun drive a native GPU surface, and `<electrobun-wgpu>` composites native GPU surfaces into UIs; v1.18.x by May 2026; supports Zig/Rust/Go/Odin apps but Bun/TypeScript is the primary model. — [Electrobun GitHub](https://github.com/blackboardsh/electrobun), [compat page](https://framework.blackboard.sh/electrobun/guides/compatability/), [v1.18.0 changelog](https://framework.blackboard.sh/electrobun/guides/changelog/v1-18-0/)
- zig-webui (webui-dev): 845 stars, pushed 2026-11-14 (webui is a "any browser or WebView" library; backend in Zig). thechampagne/webview-zig: 199 stars, last push 2025-12-27; the official `webview/webview` C library is active (14.3k stars, pushed 2026-10-22). happystraw/zig-webview 12 stars pushed 2026-10-08. — [zig-webui](https://api.github.com/repos/webui-dev/zig-webui), [webview-zig](https://api.github.com/repos/thechampagne/webview-zig), [webview](https://api.github.com/repos/webview/webview)
- nanoui web mode: WKWebView etc., Zig methods exposed via generated JS client; 5000 sequential IPC calls took 493 ms (~0.1 ms/call); iOS/Android pages not yet; bound methods run on the main thread. — [nanoui README](https://github.com/justrach/nanoui)
- zig-objc supports calling ObjC and blocks, so hosting a WKWebView directly from Zig is possible. — [zig-objc README](https://github.com/mitchellh/zig-objc)

### Inferences (judgement)
- IPC options: custom URL scheme handler (WKURLSchemeHandler) is the efficient route for large binary images (stream bytes without base64); script message handlers for small JSON; localhost WebSocket is simplest but adds a server and CORS/ATS concerns. Not verified in sources here.
- WebGPU in WKWebView: unverified; at 60 Hz cap, the web layer cannot meet "120 Hz". A possible workaround is the Electrobun WGPU-surface-in-window approach or a native Metal layer under/over the webview (hybrid), which defeats much of the point.
- Zig vs Tauri: Tauri (Rust) gives mature plugins (dialogs, updater, signing), whereas Zig gives smaller binaries and C interop; for a webview-hosted canvas the shell is thin, so Zig's performance advantage is irrelevant; the canvas bottleneck is the webview. Effort: 2-4 months for MVP; risk: High for the 120 Hz goal, Medium otherwise.

### Gaps
- Did not verify Tauri/Wails details, WebGPU frame pacing in WKWebView, WKWebView behaviour on macOS 26, or Saucer. Existence of a 2026 fix for WKWebView 120 Hz could not be confirmed or ruled out.

## 7. Architecture C: Zig core + thin native shell per OS (Ghostty-style)

### Takeaway
This is the best-evidenced Zig architecture: Zig for document model, layout, spatial index, tessellation and (optionally) wasm; Swift/AppKit shell with a Metal view (CAMetalLayer, ProMotion via CADisplayLink) on macOS. It gets real native text editing, IME, menus, accessibility, and 120 Hz for free. The cost is two languages and the Swift/Zig boundary. Verdict (judgement): the Zig option I would recommend if Zig is a hard requirement.

### Cited Findings
- Ghostty uses exactly this pattern with a C ABI library, and its author reports it held up for over a year through macOS updates, while noting Zig changes. — [Hashimoto](https://mitchellh.com/writing/zig-and-swiftui), [Ghostty about](https://ghostty.org/docs/about)
- Hashimoto says the pattern works with any C-ABI language including Rust. — [same post](https://mitchellh.com/writing/zig-and-swiftui)
- nanovg-zig demonstrates a Zig vector renderer compiling to WebGL via `-Dtarget=wasm32-freestanding`, i.e. Zig-to-wasm for a later web build is demonstrated. — [nanovg-zig README](https://github.com/fabioarnold/nanovg-zig)
- Zig 0.17 Tier 2 for aarch64-macos (Tier 1 targets listed include x86_64-linux). — [0.17 notes](https://ziglang.org/download/0.17.0/release-notes.html), [0.16 notes](https://ziglang.org/download/0.16.0/release-notes.html)

### Inferences (judgement)
- Effort: MVP 3-5 months for a dev comfortable in Swift + Zig; rendering in Metal from Swift while Zig produces vertex/instance buffers (shared memory) is the cleanest split. Risk: Medium. Cross-platform later costs a new shell per OS (GTK/Win32), as Ghostty did.
- Honest alternative: the same architecture with Rust core is equally valid; Zig's edge is build/C interop, Rust's is ecosystem (lyon, Vello, wgpu).

### Gaps
- No published example of a Zig core driving a Metal canvas at 120 Hz with thousands of curves; effort numbers are my estimates.

## 8. Zig language/toolchain maturity and risk

### Takeaway
Zig is still pre-1.0 with large breaking releases roughly every 5-8 months; 0.16 (April 2026) rewrote I/O, 0.17 (Oct 2026) rewrote the build system and removed `@cImport`. Core tooling is good but ZLS is currently broken on 0.17. Budget real maintenance time every release.

### Cited Findings
- Local install: Zig 0.17.0 (Homebrew). — local `zig version`
- Zig 0.16.0 (April 2026; 8 months, 244 contributors, 1,183 commits): "I/O as an Interface" (all I/O needs an `Io` instance; `Io.Threaded` feature-complete; Evented/io_uring/Kqueue/Dispatch experimental; Evented lacks networking), `@Type` replaced, `@cImport` deprecated, removal of GenericWriter/AnyWriter/Thread.Pool/SegmentedList, many std.posix removals, build changes. — [0.16 notes](https://ziglang.org/download/0.16.0/release-notes.html), [Ziggit 0.16 released](https://ziggit.dev/t/0-16-0-released/14930)
- Zig 0.17.0 (reported 2026-10-01 by secondary sources; official notes: 5 months, 206 contributors, 925 commits): `@cImport` removed (translate-c is now an external package at codeberg.org/ziglang/translate-c), `zig build` split into configurer/maker processes, build runner overriding removed, many `add*Arg` renames, `@bitCast` redefined, `@enumFromInt`/`@intFromEnum` replaced, `std.zon.parse` reworked, DebugAllocator deprecated, incremental compilation usable for most x86_64-linux projects (`-fincremental --watch`); Mach-O linker and aarch64 backend with incremental support are future work (so no incremental on Apple Silicon yet). — [0.17 notes](https://ziglang.org/download/0.17.0/release-notes.html), [Linuxiac](https://linuxiac.com/zig-0-17-programming-language-lands-with-reworked-build-system/)
- ZLS cannot work with 0.17.0 yet; Zig and ZLS teams are extending the Build Server Protocol. ZLS repo itself active (pushed 2026-11-16). — [0.17 notes](https://ziglang.org/download/0.17.0/release-notes.html), [ZLS](https://api.github.com/repos/zigtools/zls)
- 1.0 roadmap (nine items, including complete language, aarch64 backend, eliminate LLD, build system/package management, std audit); "some major decisions remain". No 1.0 date. — [0.17 notes](https://ziglang.org/download/0.17.0/release-notes.html)
- Main repo is on Codeberg (ziglang/zig): latest master commit 2026-11-17, 937 open issues, 343 PRs. (GitHub ziglang/zig last push 2025-11-27 = mirror frozen.) — [Codeberg](https://codeberg.org/ziglang/zig), [GitHub API](https://api.github.com/repos/ziglang/zig)
- Ecosystem lag examples: Capy on 0.14.1; dvui tags per Zig version (v0.4.0 for 0.15, v0.5.0 for 0.16, main for 0.17); sokol-zig requires >= 0.16; nanoui requires exactly 0.17. — [Capy](https://github.com/capy-ui/capy), [dvui](https://github.com/david-vanderson/dvui), [sokol-zig](https://github.com/floooh/sokol-zig), [nanoui](https://github.com/justrach/nanoui)
- Hashimoto's own note that Zig changes and code needs updates. — [Hashimoto](https://mitchellh.com/writing/zig-and-swiftui)

### Inferences (judgement)
- Expect at least 1-3 days of migration work per Zig minor release for a mid-sized app, more with many dependencies (each dependency must have caught up). Pinning a Zig version and vendoring dependencies mitigates this.
- Strengths: excellent C interop (now via build-system translate-c package), cross-compilation, small binaries. Weakness: Objective-C interop is manual (zig-objc), tooling currently degraded (ZLS), hiring pool tiny.

### Gaps
- Official 0.17 release date not stated in the notes I read (secondary sources say Oct 1, 2026); package-manager details, compile-time numbers for large apps, and community size statistics not gathered.

## 9. JSON streaming, child processes, HTTP in Zig std (for driving Codex CLI)

### Takeaway
Adequate but with churn: 0.16's `Io` redesign changes process/IO APIs, so code written against 0.15 will need rewriting. For a JSONL-emitting child process, `std.process.Child` plus a reader loop and `std.json` is straightforward.

### Cited Findings
- All I/O now requires an `Io` instance; `Io.Threaded` is described as feature-complete and suitable for CLI/desktop apps; `std.process.Init` gives `main` the default `Io`. — [0.16 notes](https://ziglang.org/download/0.16.0/release-notes.html), search summary at [Ziggit std.Io overview](https://ziggit.dev/t/std-io-overview/14994)
- Codeberg master shows ongoing `Io.Threaded` networking work (e.g. commit "Io.Threaded.netConnectIpWindows can timeout", 2026-11-17). — [Codeberg](https://codeberg.org/ziglang/zig)

### Inferences (judgement)
- Spawning Codex, reading stdout lines, and parsing each with `std.json` is a small task (hundreds of lines). A GUI app will want the read loop on a worker thread posting events to the UI thread. HTTP client in std exists but TLS/HTTP2 maturity not verified; not needed if only the CLI is driven.

### Gaps
- I did not test `std.process.Child` on 0.17 nor verify exact 0.17 JSON/Child APIs.

## 10. Rough performance expectations (binary size, startup, memory)

### Takeaway
Zig-native stacks produce very small binaries; webview shells are also small relative to Electron; published numbers are from authors' own claims.

### Cited Findings
- nanoui: ~0.7 MB ReleaseFast / 0.4 MB ReleaseSmall binary, idle uses no CPU, cold build of counter ~4.8-6.3 s on M3 Ultra, incremental rebuild 0.12 s (no change) / 0.56 s (one-line edit). — [nanoui README](https://github.com/justrach/nanoui)
- Electrobun: ~12 MB bundle with system webview (mostly Bun runtime). — [BetterStack/summary via search](https://betterstack.com/community/guides/scaling-nodejs/electrobun-desktop-apps-typescript/)
- nanoui IPC: 5000 sequential JS-to-native calls in 493 ms. — [nanoui README](https://github.com/justrach/nanoui)

### Gaps
- No published startup time or memory figures for dvui, Zig+WKWebView, or Tauri found in my searches; no memory-per-texture data.

## Verdicts (judgement, summarising above)

| Architecture | Verdict | Effort (my estimate) | Key risks |
|---|---|---|---|
| A: pure Zig (dvui or nanoui + custom renderer) | Possible, not recommended for a text-heavy product; nanoui is the most compelling but is ~1 month old, pre-1.0, agent-generated | 9-15+ months to polished | Text editing/IME/accessibility gaps, framework churn, Zig upgrades (0.16, 0.17 each broke things) |
| B: Zig shell + WKWebView | Weakest for 120 Hz goal: WKWebView rAF capped at 60 Hz (as of latest evidence, 2025); Tauri is more mature; Zig adds little | 2-4 months MVP | 60 Hz cap, WebGPU pacing unverified, thin Zig webview bindings (webview-zig last push Dec 2025) |
| C: Zig core + Swift/AppKit + Metal shell (Ghostty model) | Best Zig architecture; real native text/IME/menus and ProMotion | 3-5 months MVP; later per-OS shells | Two-language boundary, Zig churn confined to core, per-OS shell cost |

Overall: if the user's priority is the 120 Hz canvas plus polished native text, C is the defensible Zig choice; consider a Rust core with the same shell (covered by another researcher). Watch justrach/nanoui for maturity over the next 3-6 months rather than building on it now.
