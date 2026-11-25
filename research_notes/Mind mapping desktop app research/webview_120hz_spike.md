# WKWebView 120 Hz canvas viability: hands-on spike on macOS 26.5.1 plus web findings

## Headline conclusion (read this first)

**Measured on this machine:** a default `WKWebView` caps `requestAnimationFrame` at 60 fps on macOS 26.5.1 (Apple M4 Pro, built-in 120 Hz Liquid Retina XDR display). macOS 26 does NOT lift the cap by default. This contradicts the `tauri-plugin-macos-fps` README, which says Apple removed the cap in macOS 26 (see Q3).

**Measured:** flipping the *private* WebKit feature `PreferPageRenderingUpdatesNear60FPSEnabled` to `false` on the `WKPreferences` of the same WKWebView gives a steady 120 fps (mean frame interval 8.33 ms). Every workload I tested then held 120 fps, and the heavy ones had large headroom:
- Canvas2D: 5,000 filled tapered Beziers + 2,000 labels + 300 images, culled and unculled.
- WebGL2: up to 100,000 tapered branches (2.4 M triangles) plus the same labels and images.
- WebGPU: 10,000 instanced quads.

**Viability verdict:** WKWebView is viable for a 120 Hz canvas on this OS only on a private-API route. There is no public API (public `WKPreferences`/`WKWebViewConfiguration`). I found none, and the WebKit request for one (bug 294338) is still open. The route is fragile (private selectors, App Store review risk, may break in any macOS update). Conditions:
1. The window must be on a 120 Hz display (the 60 Hz external monitor here caps at 60 regardless).
2. The private flag must be set before/at WebView creation; the app must tolerate it disappearing (fall back to 60 fps).
3. GPU-batched rendering (WebGL2 or WebGPU) has much more headroom than Canvas2D. Canvas2D is plausible at 120 Hz at 5,000 branches (see caveats), but it was not pushed to its limit.

## Part 1: Measured on this machine

### Hardware and session facts
- **CPU/SoC:** `sysctl -n machdep.cpu.brand_string` = `Apple M4 Pro`. GPU: Apple M4 Pro, 20 cores, Metal 4.
- **OS:** macOS 26.5.1 (build 25F80), Swift 6.2.1, arm64.
- **Displays** (`system_profiler SPDisplaysDataType`, plus `NSScreen.maximumFramesPerSecond`):
  - Built-in Liquid Retina XDR, 3456x2234 Retina (UI 1728x1117, backing scale 2). `NSScreen.maximumFramesPerSecond` = **120** (ProMotion).
  - External "SA272U E" 2560x1440 @ **60.00 Hz** (`maximumFramesPerSecond` = 60).
  - **Caveat, stated prominently:** `NSScreen.main` was the 60 Hz external monitor (reports 60), but the test window opened on the built-in display (`win.screen` = "Built-in Retina Display", max 120). All measurements below are for the window on the built-in 120 Hz panel. A GUI session was present and window creation worked every time.
- Page-side values: `screen.width/height` = 1728x1117, `devicePixelRatio` = 2, window content 1400x900 CSS px (canvas backing store 2800x1800), `isSecureContext` = true (page loaded via `loadHTMLString` with baseURL `http://localhost/`).
- UA string reported by WKWebView: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)` (no version token, as is normal for WKWebView).

### Method and reproducibility
Files (all in `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/e978aa9d-83bf-4c61-9197-231fbb959d27/scratchpad/webview-spike/`):
- `spike.swift`: NSWindow 1400x900 + WKWebView, `WKScriptMessageHandler`, prints JSON, auto-quits (26 s watchdog).
- `spike.html`: all tests. The Swift host injects the mode via a `WKUserScript`.
- `spike`: compiled binary.
- `results/*.json`: raw outputs. Note `results/raf_prefs.json` holds only the final successful private-flag run.

Compile and run:
```
cd /private/tmp/claude-501/-Users-parth-projects-general-mind-maps/e978aa9d-83bf-4c61-9197-231fbb959d27/scratchpad/webview-spike
swiftc -O -swift-version 5 -framework Cocoa -framework WebKit spike.swift -o spike
./spike spike.html raf            # modes: raf | c2d | gl | scale | gpu
./spike spike.html raf prefs      # add "prefs" to apply the PRIVATE feature flag
./spike spike.html scale big prefs   # scale with 100k/200k/400k branches
```
(`-swift-version 5` was added to avoid Swift 6 strict-concurrency errors in top-level code.)

How frames are measured: `performance.now`-independent; intervals are consecutive `requestAnimationFrame` timestamps. The first 10 frames are dropped. Each test lasts 3 to 4 s.

**Important measurement caveat:** WebKit rAF timestamps are quantised to whole milliseconds. Hence "median_ms" prints 17 (60 Hz) or 8 (120 Hz), and "fps_from_median" prints 58.8 or 125. These are quantisation artefacts. Use **mean_ms / fps_from_mean**, which averages the quantisation out (16.67 ms = 60 Hz, 8.33 ms = 120 Hz). The "dropped_gt_1p5x_median" count was 0 in every test; with 1 ms quantisation this is a weak detector for small hitches, so p99/max are more informative. The `intervals_gt_8.4ms` counter is meaningless at 120 Hz because of the 8/9 ms alternation.

What is NOT measured: actual GPU time (`EXT_disjoint_timer_query_webgl2` is not exposed in WKWebView here: `timer_query_ext: false`), presentation latency, power/thermals. JS time per frame is reported but excludes GPU work and raster/compositing.

### Number of runs and variation
12 process launches in total. Each configuration was measured **once**, so there is no repeat-run variance for a given test. Evidence of consistency: across 9+ independent test stages at 60 Hz, the mean interval was 16.657 to 16.671 ms; at 120 Hz it was 8.332 to 8.338 ms (excluding the knee tests). Of the 12 runs, one was wasted by my own argument bug (the "prefs" flag was passed as part of the mode string, so no tests ran) and one was the first private-API attempt, which failed (see below). Runs beyond the "ideally 8" were needed to establish the private-flag result and the knee.

### Test 1: bare rAF cadence (trivial fillRect draw 4 s, then empty rAF 2.5 s)
| Config | Test | mean ms | p95 | p99 | max | fps (mean) |
|---|---|---|---|---|---|---|
| Default | trivial draw | 16.670 | 18 | 18 | 18 | 59.99 |
| Default | empty rAF | 16.671 | 18 | 18 | 18 | 59.98 |
| Private flag off | trivial draw | 8.333 | 9 | 10 | 10 | 120.01 |
| Private flag off | empty rAF | 8.338 | 9 | 11 | 11 | 119.93 |

- **Default = 60 fps on a 120 Hz screen** (screen reports maxFPS 120). This is the cap.
- **Public options:** I found no public `WKPreferences`/`WKWebViewConfiguration` property that raises the rAF rate. I did not find one in the public SDK; I tried none because none exists to try. Web sources agree no public API exists (Q1, Q3).
- **Private API, attempt 1 (failed):** `setValue(false, forKey: "preferPageRenderingUpdatesNear60FPSEnabled")` (guarded by `responds(to: _setPreferPageRenderingUpdatesNear60FPSEnabled:)`). Selector not present, flag not applied, result 60.04 fps (mean 16.657 ms). That raw file was overwritten.
- **Private API, attempt 2 (worked):** the route used by `tauri-plugin-macos-fps`: class method `+[WKPreferences _features]`, find the `_WKFeature` whose `key == "PreferPageRenderingUpdatesNear60FPSEnabled"`, call `-[WKPreferences _setEnabled:forFeature:]` with `false`. Reported before=true, after=false. A related feature key, `WebAnimationsCustomFrameRateEnabled`, also exists (not touched). **Private API; do not treat it as a stable contract.**

### Test 2: Canvas2D (5,000 filled tapered closed Bezier outlines, batched in 8 colours via Path2D; 2,000 fillText labels; 300 drawImage of 256x256 ImageBitmaps; camera pans and zooms continuously; DPR 2 canvas 2800x1800)
Scene is a 2800x2800 world; the viewport shows ~16% at zoom 1. Measured average branches drawn with culling = ~722 of 5,000 (14%), a bit under the 20% target.

| Config | Mode | mean ms | p95 | p99 | max | fps | JS ms/frame mean (p95) | branches drawn |
|---|---|---|---|---|---|---|---|---|
| Default (60 Hz cap) | no culling | 16.667 | 18 | 18 | 18 | 60.00 | 3.72 (5) | 5000 |
| Default | culled | 16.665 | 17 | 18 | 18 | 60.01 | 1.06 (2) | 723 |
| Private flag off | no culling | 8.332 | 9 | 10 | 10 | 120.01 | 3.45 (4) | 5000 |
| Private flag off | culled | 8.333 | 9 | 10 | 10 | 120.01 | 0.82 (1) | 722 |

At 120 Hz with no culling, JS time is 3.5 ms against an 8.33 ms budget. **Caveat:** `js_ms` covers only JS command recording; the Canvas2D work is rasterised by WebKit's GPU process off the JS thread, so completion cost is invisible here. Hitting 120 fps with 0 over-1.5x intervals does show the pipeline kept up, but I did not find the Canvas2D ceiling.

### Test 3: WebGL2 (pre-tessellated branch triangles in one indexed buffer (12 segments, 24 triangles per branch, one drawElements), 300 images as instanced textured quads from a 4096x2048 atlas, 2,000 text labels from a 2048x2048 atlas pre-rasterised at 1x (so slightly soft at DPR 2), camera as uniform, MSAA on)
- Renderer string: `Apple GPU`, `WebGL 2.0`, max texture 16384. `EXT_disjoint_timer_query_webgl2` **not available**, so no GPU-time numbers.
- 5,000 branches, default config: mean 16.665 ms (60.005 fps), p99 18, max 19, JS 0.30 ms/frame.
- 10k/20k/50k default (see Test 5) all 60 fps.

### Test 4: WebGPU
- `navigator.gpu` **exists**; `requestAdapter()` **succeeds**; `requestDevice()` succeeds; `isSecureContext` true. Adapter info: vendor "apple", architecture "apple", device "apple", description "apple". Preferred canvas format `bgra8unorm`. Features include `timestamp-query`, `shader-f16`, `float32-filterable`, `texture-compression-astc/bc/etc2`, `indirect-first-instance`, `depth-clip-control`. `maxTextureDimension2D` 16384, `maxBufferSize` 2,147,483,644.
- Caveat: the page was served with an `http://localhost/` base URL (a secure context). I did not test other origins such as `file://` or custom schemes (`tauri://`).
- 10,000 instanced quads (3 s): default config mean 16.669 ms (59.99 fps); private flag off mean 8.332 ms (120.01 fps), p99 11, max 12.
- `timestamp-query` is advertised, so real GPU timing is possible via WebGPU. I did not use it.

### Test 5: scaling probe (WebGL2 path, all branches drawn every frame, no culling, same labels and images)
| Branches | Triangles | Config | mean ms | p99 | max | fps (mean) |
|---|---|---|---|---|---|---|
| 10,000 | 240 k | default | 16.665 | 18 | 18 | 60.01 |
| 20,000 | 480 k | default | 16.665 | 18 | 18 | 60.01 |
| 50,000 | 1.2 M | default | 16.671 | 18 | 18 | 59.99 |
| 10,000 | 240 k | private off | 8.334 | 10 | 10 | 119.99 |
| 20,000 | 480 k | private off | 8.334 | 10 | 10 | 119.99 |
| 50,000 | 1.2 M | private off | 8.338 | 10 | 11 | 119.93 |
| 100,000 | 2.4 M | private off | 8.332 | 10 | 11 | 120.02 |
| 200,000 | 4.8 M | private off | 9.786 | 11 | 11 | 102.19 |
| 400,000 | 9.6 M | private off | 18.983 | 20 | 20 | 52.68 |

**Knee at the 120 Hz budget (8.33 ms): between 100,000 and 200,000 branches** (2.4 to 4.8 M triangles, drawn in one call, no culling, no LOD). At 200k the interval is 9.79 ms (~102 fps), and at 400k it is ~19 ms (the display drops to the next refresh divisor). Tessellation time (build, not per frame): 7 ms at 10k up to 168 ms at 400k. The 100k/200k/400k stages came from one separate run, and the 10k/20k/50k private-flag numbers from another, so the rows are not from a single process. Only a 1-run sample per row; the knee is bracketed, not pinned. Caveat: the synthetic branches are thin (3 to 8 px wide at 1x, with the taper) and do not reflect real overdraw, MSAA cost with huge fills, or the cost of rebuilding tessellation on edits.

### What was NOT tested
- Real text shaping/layout quality, SVG artwork, interaction/input latency (pointer-to-photon), memory, thermal throttling over minutes, Chromium/Safari comparison (skipped as instructed).
- Public-API frame-rate options: none exist in the SDK I used; I did not test `CAMetalLayer`-level or `CADisableMinimumFrameDurationOnPhone` (iOS-only key, reported not to help in WKWebView by the WebKit bug thread below).
- Non-primary displays: the 60 Hz external monitor was not used for the window.
- Process cleanup: `pgrep spike` returned nothing after every run; no windows or processes were left behind.

## Part 2: Web findings (reported, not measured by me)

### Q1. What do WebKit sources say about 120 Hz rAF in WKWebView, and what changed in macOS 26 / Safari 26?

#### Takeaway
WebKit bug 294338 (WKWebView 120 Hz) is still open and unassigned as of its last update in Sep 2026. Safari itself can reach 120 Hz with the "Prefer Page Rendering Updates near 60fps" setting off, but that setting does not apply to embedders. A commenter who found the internal preference confirmed it unlocks 120 fps in WKWebView, matching my measurement. I found no Safari 26 release-note text lifting the WKWebView cap.

#### Cited Findings
- WebKit bug 294338 filed 2025-06-11: Safari supports 120 Hz on ProMotion when "Prefer Page Rendering Updates Near 60fps" is off, but this does not affect WKWebView. Status NEW, unassigned, last modified 2026-09-17 — [WebKit Bugzilla 294338](https://bugs.webkit.org/show_bug.cgi?id=294338)
- Same bug, 2026-07-21 comment: the internal preference `PreferPageRenderingUpdatesNear60FPSEnabled`, when disabled, makes WKWebView reach 120 fps on a physical device (default stays about 60); the missing piece is a public embedder API. A 2026-07-02 comment notes that Capacitor and Tauri plugins unlock 120 Hz through private WebKit API, "fragile" — [WebKit Bugzilla 294338](https://bugs.webkit.org/show_bug.cgi?id=294338)
- Same bug, 2025-08-18: a commenter reports that on macOS 26 a *web app* stays at 60 fps even with the flag off; another says earlier macOS web apps reached 120 with the flag off while WKWebView stayed at 60. No commenter in the thread confirms WKWebView behaviour on macOS 26 directly (the thread's only WKWebView measurement is the July 2026 one above) — [WebKit Bugzilla 294338](https://bugs.webkit.org/show_bug.cgi?id=294338)
- Older tracking bug 173434 "Support for 120Hz requestAnimationFrame" exists; a WebKit engineer noted that low power mode already changes the frame rate while Chrome and Firefox can run rAF at 120 fps (per a search-result summary; I did not open the bug page) — [WebKit Bugzilla 173434](https://bugs.webkit.org/show_bug.cgi?id=173434)
- WebKit's animation-frame-rate explainer says accelerated (Core Animation) animations already run at 120 Hz on ProMotion, whereas the rest of the page updates at 60 Hz — [WebKit explainer](https://webkit.github.io/explainers/animation-frame-rate)
- Apple Developer Forums: Apple pointed a "WKWebView 120hz Support" thread to bug 294338 as the tracker — [Apple forums thread 773222](https://developer.apple.com/forums/thread/773222)

#### Inferences
- My measurement (default 60, feature off 120, on 26.5.1) is consistent with the 2026-07 bug comment and shows the cap is still in force in macOS 26.5.1 for WKWebView.
- Because the bug is still open, a public opt-in API may or may not arrive; there is no commitment.

#### Gaps
- The Safari 26 / 26.x release notes page fetched returned only the title, so I could not verify release-note text on rAF or frame rate. Bug 173434 and the old setting history were seen only through search snippets.

### Q2. WebGPU in WKWebView on macOS 26

#### Takeaway
WebGPU shipped enabled by default in Safari 26; my test shows it is available inside an embedded WKWebView on 26.5.1 (adapter and device creation succeed). There are reported WebGPU bugs on Safari 26.2.

#### Cited Findings
- Safari 26.0 (released 2025-09-15) enables WebGPU by default on Apple platforms; WebKit says WebGPU supersedes WebGL on macOS/iOS/iPadOS/visionOS and is preferred for new sites — [Safari 26 release notes](https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes.md), [WWDC25 WebKit post summary](https://discuss.privacyguides.net/t/news-from-wwdc25-webkit-in-safari-26-beta/28226)
- GPUWeb implementation-status wiki lists WebKit WebGPU on macOS 26 as enabled by default — [gpuweb Implementation Status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- A WebKit bug reports WebGPU on Safari 26.2 for macOS "completely unusable" for one developer's engine, reportedly fixed in iOS 26.4 beta 1; the report does not say whether the macOS fix shipped — [WebKit Bugzilla 301627](https://bugs.webkit.org/show_bug.cgi?id=301627)

#### Inferences
- My probe (not the web sources) is the evidence for embedders; the web sources only cover Safari. Behaviour could differ for other base URLs or entitlements.

#### Gaps
- No source specifically documenting WebGPU for WKWebView embedders; the WebKit bug 301627 details were seen only via a search snippet.

### Q3. Tauri/wry and Electron on 120 Hz

#### Takeaway
Tauri maintainers say there is nothing they can do (issue closed "not planned"). A third-party plugin unlocks it with private API. The plugin's README claims macOS 26 removed the cap; my measurement on 26.5.1 contradicts that claim.

#### Cited Findings
- Tauri issue #13978 "Runs at only 60fps on macOS", opened 2025-08-10, closed as not planned 2025-08-11; a Tauri member said WKWebView does not expose settings for this and Safari's experimental features cannot be enabled in WKWebView. A user later reported 120 fps on macOS 15.3.1; third-party workarounds were posted — [tauri-apps/tauri#13978](https://github.com/tauri-apps/tauri/issues/13978)
- `tauri-plugin-macos-fps` flips `PreferPageRenderingUpdatesNear60FPSEnabled` through private `+[WKPreferences _features]` and `-[WKPreferences _setEnabled:forFeature:]` (with respondsToSelector guards) — [plugin source](https://docs.rs/crate/tauri-plugin-macos-fps/0.1.0/source/src/macos.rs)
- The same plugin README says the cap applies to macOS 13 to 15, that "Apple removed the 60fps cap entirely in macOS 26", and that on macOS 26.3.1 a 120 Hz display and a 165 Hz external ran at native rate with or without the plugin — [plugin README](https://docs.rs/crate/tauri-plugin-macos-fps/0.1.0/source/README.md). **Contradicted by my measurement** (default WKWebView = 60 fps on macOS 26.5.1, 120 fps only after the private flag). Possible explanations I cannot separate: a different build (26.3.1 vs 26.5.1), a different test method, or a test that did not measure rAF (the issue thread notes CSS animations and scrolling can exceed 60 Hz while rAF is capped).
- Safari "web apps" and WKWebView are treated differently; a macOS 26 Home Screen web app was reported at 60 fps even with the flag off — [WebKit Bugzilla 294338](https://bugs.webkit.org/show_bug.cgi?id=294338)

#### Inferences
- Any Tauri shell would need the same private call (or a patched wry), and would inherit the same fragility.
- Tauri's maintainers referenced a CEF-based alternative runtime as the longer-term route (per the issue comment), which would bring Chromium behaviour; I did not verify its status.

#### Gaps
- Electron/Chromium on ProMotion: my searches found no source directly describing it. I make no claim about Chromium 120 Hz rAF on macOS beyond the WebKit-bug remark that Chrome and Firefox can run rAF at 120 fps (Q1).

### Q4. Published canvas benchmarks, WKWebView vs Chromium

#### Takeaway
I found no rigorous published canvas benchmark. Only general blog comparisons exist.

#### Cited Findings
- A Tauri vs Electron comparison reports about 172 MB vs 409 MB memory for six windows on macOS and negligible startup difference; this is memory, not rendering — [DEV Community comparison](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4)
- Electron's blog says to expect little performance difference between Electron and other Chromium-based renderers (not a WKWebView comparison) — [Electron blog](https://electronjs.org/blog/webview2)

#### Gaps
- No measured canvas or WebGL comparison WKWebView vs Chromium found. Comparing them for this app would need a run of `spike.html` in an Electron/Chromium host, which was out of scope.

## Open risks for the requirements document
1. The 120 fps unlock depends on a private API; there is no public API and no Apple commitment (bug 294338 open).
2. Results are from one Mac (M4 Pro); older/lower-end Apple Silicon or Intel Macs were not tested.
3. The window must be on the ProMotion panel; the Mac's main screen was a 60 Hz external, and the app's rate will follow whichever display it is on.
4. The synthetic scene is not a real mind map. No hit-testing, editing, text layout, or SVG rasterisation was measured.
