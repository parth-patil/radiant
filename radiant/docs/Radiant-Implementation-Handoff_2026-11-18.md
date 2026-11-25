# Radiant implementation handoff

Updated on 18 November 2026 after the independent review. Branch `master`. **Application source checkpoint `307a44a`.** The 13:44 IST test build includes the SVG regeneration correction. The guide and audit record subsequent verification separately.

## Start here

Radiant is a local-first macOS mind-map editor. It uses Svelte and TypeScript for the editor, a custom WebGL2 renderer, a Rust/Tauri host and single-file SQLite documents. A browser host supports offline editing and scripted provider replay. The current app can create, style, study, generate, illustrate, save and export maps. The largest outstanding group is engine and quality acceptance. Several tasks depend on hardware, a signed distribution environment or live provider evidence.

| Area | Verified | Partial | Open | Deferred | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Editing, layouts, study, files and agent access | 134 | 8 | 0 | 0 | 142 |
| AI and artwork | 84 | 11 | 0 | 0 | 95 |
| Engine and quality | 49 | 50 | 4 | 1 | 104 |
| **All numbered requirements** | **267** | **69** | **4** | **1** | **341** |

**Where to read.** The timestamped guide explains the product with eight workflows, default shortcuts, a format guide and searchable entries for all 341 requirements. Its implementation record and scope fields come from the row audits. The HTML blueprint supplies the original acceptance text. The historical handoff records experiments and earlier stopping points. Its older “no commits” and “next steps” sections describe November 17. Use this document and the current audits for restart planning. [Feature guide](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html) · [Original blueprint](../../radiant-mind-map-blueprint.html) · [Historical handoff](../HANDOFF.md)

**Working agreement.** The owner requested frequent, focused local commits by `Parth Patil`, parallel GPT-6.2 Sol agents for implementation where appropriate, and no new unit tests. Use app-level acceptance, existing browser workflows, native fixtures and builds. Make user-facing claims at the level of the evidence. An offline provider replay, a packaged WebView run and a physical display measurement answer different questions. The local repo had no configured remote at this checkpoint.

## Run the test build

The delivered ZIP contains an optimized Apple silicon Radiant 0.1.0 app and its Finder Quick Look extension. It uses a local ad-hoc signature. The extracted app and its Quick Look extension passed signature verification. Open the timestamped copy to distinguish it from older local builds. The source tree ignores Cargo build products, so a fresh checkout should use the rebuild command below.

- [Test app](../src-tauri/target/test-builds/2026-11-18_13-44-52_IST/Radiant.app) · [ZIP](../src-tauri/target/test-builds/2026-11-18_13-44-52_IST/Radiant-macOS-arm64.zip)
- ZIP SHA-256 is `b3b0e3219e6f9aa8c5a380a398ebdb39075fe67842d9a959ba454498c9f894c0`. The archive passed an integrity check. Its extracted executable is arm64 and its Quick Look extension is universal.
- Build host was arm64, macOS 26.5.1 (25F80), Bun 1.4.0, Cargo and rustc 1.99.0. This local run established neither the minimum supported macOS version nor public notarization.

From the repository root, the baseline commands are:

```sh
git status --short --branch
git log -8 --oneline
cd radiant
bun install --frozen-lockfile
bun run check
node tools/check-boundaries.mjs
bun run test
cargo build --locked --offline --manifest-path src-tauri/Cargo.toml --bin radiant
src-tauri/target/debug/radiant --store-selftest
APPLE_SIGNING_IDENTITY=- bun run tauri build --bundles app
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Radiant.app
```

The offline Cargo command assumes the locked dependencies are already cached. The macOS bundle hook needs the macOS SDK and Swift compiler to build the Quick Look extension. `--store-selftest` is a **debug-only** entry point. The optimized binary follows the normal application launch path. The normal app build uses the guarded high-refresh WebKit feature. The public-WebKit edition is available with `bun run tauri build --features public-webkit --bundles app`. Developer ID signing, notarization and updater publishing are separate release activities. [Build and distribution notes](../README.md)

## Where changes belong

| Concern | Primary files or directories | Contract to preserve |
| --- | --- | --- |
| Tree model, editing and history | `src/lib/core/model/`, `src/lib/core/types.ts` | Stable IDs, document ownership, grouped undo/redo and durable operations for named maps. |
| Layout, geometry and picking | `src/lib/core/layout/`, `src/lib/core/geometry/` | Deterministic positions, manual offsets, branch shapes and hit-testing must agree. The core stays independent of DOM and Tauri. |
| Scene assembly and editing UI | `src/lib/ui/pipeline.ts`, `controller.svelte.ts`, `App.svelte`, inspector and outline components | Canvas, outline, keyboard, export and saved model refer to the same editable document. |
| Rendering and image residency | `src/lib/render/renderer.ts`, `images.ts`, `shaders.ts`, `coarse-blur.ts` | WebGL ownership, bounded decoding and upload work, image draw order, premultiplied alpha and zoom-dependent resolution. |
| Generation and SVG validation | `src/lib/core/ai/`, `src/lib/core/art/`, `src/lib/ui/artWorkflow.svelte.ts` | Accepted operations remain scoped and undoable. Stored SVG regions and regenerated groups retain their peer context. |
| Browser and native host adapters | `src/lib/host/`, `src-tauri/src/codex/` | Preserve capability checks, typed job events, cancellations, offline replay and the native transport boundary. |
| Save/open, assets and recovery | `src-tauri/src/store/`, `src-tauri/src/open_files.rs`, `src/lib/core/io/` | Existing SQLite maps, journal acknowledgements, embedded original assets and legacy migrations must continue to work. |
| Desktop integration and gates | `src-tauri/src/menu.rs`, `platform/`, `reminders/`, `tools/` | Keep commands consistent across menus and keyboard. Capture platform and fixture details with measurement results. |

Paths in this table are relative to `radiant/`. During parallel work, have the coordinator own changes to shared interfaces, Cargo manifests and the aggregate handoff. Each agent can own a disjoint implementation area and its direct acceptance evidence. [Architecture](../ARCHITECTURE.md) · [File-format contract](file-format.md)

## Changes most likely to affect the next implementation

| Area | What was delivered and checked | Relevant commits |
| --- | --- | --- |
| SVG connector direction | Checks cover the appropriate group boundary, nearest parent/child direction, transformed ellipses and coincident anchors. The editor accepted 12 groups across three regions after repairing an intentionally invalid pair. | `c949cef`, `5067805` |
| Regenerating one SVG group | The saved source is retained alongside node assets. Regeneration splices one group and validates the complete region. Two peer group substrings and their standalone bytes survived native save/reopen unchanged. A legacy file migrated on its first replacement. | `54a3237`, `c9e53b5`, `34c8fe3`, `a007730`, `afa5833`, `530d2aa` |
| SVG drawing limits during regeneration | A clipped replacement with 40 rendered shapes now passes whole-region validation. Clip definitions count toward the 400-shape region cap. An offline editor run accepted a single rendered shape with 40 clipping shapes in one turn, kept both peers identical and retained the accepted artwork after rejecting 41 rendered shapes or 401 region-wide shapes. A definitions-only control also failed. | `307a44a` |
| Failed or missing artwork | Two failed repairs leave a marked editable vector. Missing/corrupt bytes, interrupted jobs and paused queues preserve healthy siblings. Retry can restore the picture. A map with corrupt embedded art opened; after removing the bad reference it saved and reopened. | `f3fca5c`, `4a3c867`, `0836ce6`, `dc260dc`, `7e13111`, `5cf4969` |
| Large images and crowded frames | Native ImageIO produced four preview levels for 24.2 MP PNG and JPEG sources with embedded 23-byte hashes. A 2.24 MB SVG with 37,000 paths also produced four levels. Chromium and packaged WebKit each drew 240 image-specific placeholders in one draw call with full decode held. Native SVG preview parsing still has byte and node limits. | `7c5f93c`, `96db89c`, `4665624`, `3965d5c` |
| Optimized macOS linking | The Vision availability guard requires the macOS Clang runtime when Rust links with `-nodefaultlibs`. The release build locates and links the active compiler’s runtime archive. Native bundle signing and ZIP verification passed. | `0ebf1d2` |

## Suggested first work on resumption

These are independently actionable starting points. The full outstanding register follows.

1. **Refine the large-map export comparison (ENG-40).** Chromium exported the 5,000-node fixture to SVG and PDF, including all 300 raster pictures. Matched-scale crops cover the root, a raster branch and an SVG branch. Inspect the remaining edge and text differences before claiming pixel parity. [Engine audit](../requirements/engine-quality.md)
2. **Exercise edit and streaming frame budgets (NFR-PERF-08/09).** The standard large-map harness already measures pan and zoom. Add the specified edit sequence and a 1,000-node offline stream during pan. Capture mean and tail frames, active display mode, worker timings and raw reports. Native acceptance needs a visible, unlocked reference display at the requested refresh rate. [Reference measurements](../requirements/reference-performance.md)
3. **Resolve the remaining preview policy (FR-ART-27).** Native SVG inputs over 8 MiB or 100,000 XML nodes can retain original bytes without derived previews. Evaluate a bounded preview path for these accepted originals. Keep existing external-resource restrictions and the memory limits while checking first-frame output and reopened assets. The crowded-frame and 24.2 MP raster cases already have evidence. [Artwork audit](../requirements/ai-art.md)
4. **Collect physical and provider evidence in batches.** A Finder drop, real trackpad gesture, actual notification, supported macOS versions, live provider latency and clean-machine signing each need a suitable environment. Record the exact version, app build, display settings, corpus and result. The hardware and release rows can stay open while independent implementation proceeds. [Functional audit](../requirements/features.md) · [Quality audit](../requirements/engine-quality.md)

The review also identified a coverage difference in **FR-ART-37**. Generated art passes through the artwork validator before storage. Imported or older local SVGs take the asset and canvas decode path. Verify the resource policy on those paths independently while preserving valid local artwork. The existing generated-art acceptance result covers only its documented path. [Artwork audit](../requirements/ai-art.md)

## Verification routes

| Question | Route and expected evidence |
| --- | --- |
| Does the normal editor still work? | `bun run test` from `radiant/` starts a temporary browser host. It checks editing, undo/redo, find, picture upload, save/reopen, Markdown export, offline AI replay, worker layout and WebGL. This suite passed on the final feature tree. |
| Is the source consistent with architectural boundaries? | `bun run check` and `node tools/check-boundaries.mjs`. The Svelte check reported zero errors and warnings for the preview changes. |
| Does the native store continue to read and write maps? | Build the debug binary and use its store self-test. The baseline passed, including historical format, pasteboard, SQLite and failed-save cases. Additional gates live in `tools/check-format-compat.py` and `tools/check-disk-open.py`. |
| How can AI and artwork changes be checked offline? | Use the built-in browser replay, `bun tools/check-svg-contract.ts` and `python3 tools/check-codex-replay.py --help`. The latest connector work passed 32 SVG contract fixtures. Native scripted generation is distinguishable from a live account call. |
| How are display performance claims made? | From the repository root, run `python3 radiant/tools/check-reference-performance.py --hz 60 --report /tmp/radiant-60hz.json` on a matching unlocked display. Use `--hz 120` after selecting the corresponding real display mode. The report supports `--table`. The local workflow references self-hosted runners; hosted baselines remain outstanding. |
| What evidence supports durability? | The journal, crash and private filesystem gates are checked in. The filesystem report describes the cut points and model used. Read the file-format and crash reports before changing journal or asset recovery. [Journal persistence report](journal-fsync-acceptance.md) |
| How do I update progress? | Compare the IDs in the five HTML source pages with the three audit tables. Update the relevant row’s evidence and limits with the exact exercised path, reconcile the count in the current handoff header, and commit the implementation and evidence in logical increments. Avoid treating a code inspection or a successful build as proof of a hardware target. |

## Open and deferred requirements

- **NFR-PERF-07** needs external pointer-to-pixel measurements for pan, zoom, drag and typing on the large map.
- **NFR-SEC-12** needs a Developer ID hardened, notarized and stapled build assessed on a clean Mac. The local ad-hoc package is available for testing now.
- **NFR-PLAT-01** needs an exercised matrix covering all supported macOS versions and a matching release note.
- **NFR-MAINT-02** requests a display-free golden unit-test suite for layouts and geometry. The owner currently asks for no new unit tests. Keep this open unless that direction changes. Existing integration gates remain available.
- **ENG-35** defers collaboration-ready operation semantics, including positional indices and computed positions.

## Complete outstanding register

The following 69 partial rows retain a concrete gap or a narrower scope. The linked feature record gives the full implementation evidence and original acceptance criterion. The five open/deferred items above bring the outstanding count to 74.


### Canvas & navigation

- **[FR-CAN-02](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-CAN-02) · Trackpad and mouse conventions.** The physical trackpad and mouse check remains open.
- **[FR-CAN-10](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-CAN-10) · Level of detail the user can see.** The automation window was hidden, so the native run did not measure display cadence. Chromium’s separate 200-folded-root fixture capped dense overview titles at 48. Per-branch pixel legibility in dense areas remains unverified.

### Writing & editing

- **[FR-EDT-21](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-EDT-21) · Paste or drop an image onto a node.** A physical native file-manager drag onto the node and empty canvas still needs a hands-on check.

### Layout & placement

- **[FR-LAY-09](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-LAY-09) · Organic layout.** Pixel equality was measured at the same zoom on one Mac. The two-machine comparison is outstanding.

### Organization & tasks

- **[FR-ORG-13](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-ORG-13) · Reminders and to-do app sync.** Validate permission and completion with a test Reminders account and signed macOS app. Things and OmniFocus remain outside this implementation.

### Study & recall

- **[FR-MEM-06](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-MEM-06) · Review queue.** The notification host was simulated. Physical macOS notification display and delivery timing remain unverified.

### Files, import & export

- **[FR-IO-01](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-IO-01) · One document file per map.** Physical Finder double-click and Finder icon display remain unverified. Explicit-app launches left the default handler unchanged.
- **[FR-IO-02](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-IO-02) · Lossless save and load.** Run the timed first-frame check on an unlocked native display and confirm it stays below 500 ms.

### AI generation & refinement

- **[FR-AI-01](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-01) · Generate a map from a topic in one action.** Repeat on a fresh native launch with the live provider.
- **[FR-AI-02](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-02) · Nodes appear on the canvas as they stream.** First animated frames arrived 365–424 ms after start. The slowest arrival-to-visible delay was 98 ms in the measured replay. A live native provider recording is still needed for the six-second budget.
- **[FR-AI-06](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-06) · Source material.** Live heading extraction and model-specific context sizing remain unverified. The input budget reserves room conservatively without a provider tokenizer.
- **[FR-AI-32](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-32) · Prompt regression set.** Replace nine synthetic outputs with independent model recordings and recapture after a template change to measure model quality.
- **[FR-AI-35](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-35) · Isolation settings and a working directory per job.** Recheck zero MCP servers, exec stdin enforcement and temporary-directory cleanup on success, failure and interruption in current builds.
- **[FR-AI-39](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-39) · Never touch credentials.** Trace file access across a full session and scan every application log for tokens. Bundle privacy alone does not prove trace or process privacy.
- **[FR-AI-40](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-40) · Logging and provenance.** A current native trace replay through the production parser and applier reproduced both nodes and their parent relationship. Default logs store wire methods and timestamps with redacted bodies. Unpinned Codex exec still reports no resolved model in its JSON stream.
- **[FR-AI-41](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-AI-41) · One-shot exec fallback.** The current lifecycle check used a scripted CLI. Verify the current installed CLI with a real model call.

### Pictures & SVG artwork

- **[FR-ART-05](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-ART-05) · Engine-owned elements.** Raster generation prompts exclude connectors and text. There is no corresponding pixel-level check for arbitrary provider images.
- **[FR-ART-27](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-ART-27) · Thumbnails and placeholders.** Native SQLite embedded both 5,500 × 4,400 raster originals and their 23-byte hashes. Both produced four correctly oriented thumbnail levels. A 2.24 MB SVG with 37,000 paths produced the same four levels. With all bitmap decodes held and the frame budget exhausted, Chromium and packaged WebKit each drew 240 image-specific gradients in one draw call. Native SVGs beyond 8 MiB or 100,000 XML nodes still keep their originals without a generated preview.
- **[FR-ART-37](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#FR-ART-37) · Allow-list sanitising.** Inject script, external embedded image and event attribute into one fixture and verify issue-by-issue rejection before any render. CSP evidence alone does not cover sanitization.

### Layout, rendering & storage internals

- **[ENG-01](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-01) · Pure engine core.** The parity fixture was an acceptance run. A maintained core test suite is still outstanding.
- **[ENG-03](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-03) · Heavy work off the main thread.** Measure main-thread script at most 4 ms/frame and total within 8.3 ms in the ten-second native large-map pan/zoom.
- **[ENG-05](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-05) · Layout time budget.** Publish a ten-run 5,000-node median on the specified rig and native main-thread/frame instrumentation during 50,000-node layout.
- **[ENG-07](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-07) · Stable, animated edits.** Measure zero unaffected branch displacement, subpixel anchor drift and frame intervals at both refresh rates during edit.
- **[ENG-12](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-12) · Seeded organic treatment.** Compare outline hashes across two machines, inspect for unseeded randomness and demonstrate seed changes.
- **[ENG-16](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-16) · Crisp GPU labels at every zoom.** Capture DPR-2 label quality, minimum shader pixel range and 2,000-label performance with the full scene.
- **[ENG-18](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-18) · Inline editing through a real text field.** Verify real CJK composition and VoiceOver, and measure field alignment at three zoom levels.
- **[ENG-22](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-22) · Level of detail and semantic zoom.** The native window was hidden and measured synchronous CPU submission. Foreground native frame pacing and dense title readability remain open.
- **[ENG-23](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-23) · Render on demand and pace to the display.** Native WKWebView reported a 120 Hz display and confirmed the private preference changed from enabled to disabled. Its hidden test window could not verify application cadence at 120 Hz or with the flag unavailable.
- **[ENG-24](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-24) · Permanent benchmark harness on real content.** Capture native tables from unlocked 60 and 120 Hz displays. The workflow enforces the 10% mean-script regression against a stable baseline for each configuration.
- **[ENG-25](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-25) · Off-thread decoding with placeholders.** Five Chromium callbacks and eight WKWebView frames exceeded 4 ms. Chromium CDP measured animation callback p95 1.84 ms and max 13.79 ms, including fixture callbacks.
- **[ENG-29](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-29) · Allowlist sanitiser for generated SVG.** Run and record the full malicious corpus including external use, style import and cap cases with zero external requests.
- **[ENG-30](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-30) · Zoom-bucket rasterisation with live inspection.** Measure end-to-end frame intervals at physical 120 Hz. Live inspection displays the selected node’s SVG asset.
- **[ENG-38](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-38) · Open the large map quickly.** Measure command to first presented native frame from disk on the M4 Pro with all 5,000 nodes and 300 pictures.
- **[ENG-40](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#ENG-40) · Single-file SVG and PDF export of mixed maps.** At matched scale across root, raster and SVG viewports, 98.74–99.73% of SVG pixels and 96.14–98.72% of PDF pixels were within 20/255 per channel of the canvas. Some edge and text details exceeded a two-pixel neighborhood tolerance. Exact visual fidelity remains partial.

### Performance & scale

- **[NFR-PERF-01](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-01) · 120 frames per second on a 120 Hz display.** Measure 8.3–8.4 ms mean on real native large-map pan/zoom on the built-in display.
- **[NFR-PERF-02](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-02) · 60 frames per second floor and automatic fallback.** Measure 16.7 ms on the large map and move its window between two physical displays. The fixture window was hidden.
- **[NFR-PERF-03](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-03) · Frame-time tail.** Capture full tail percentiles and zero intervals above 1.5× mean at both native rates.
- **[NFR-PERF-04](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-04) · Script time per frame at most 4 ms.** Record large-map native mean script ≤4 ms and p95 in the same rig.
- **[NFR-PERF-06](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-06) · Engine budgets are tested in the same rig.** Run the visible native gate to measure the 500 ms disk-open budget and all engine limits together. Browser control open times measure deserialization and presentation in the browser.
- **[NFR-PERF-08](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-08) · Edits do not stall the frame.** Record frame intervals for the 100 adds, 1,000-descendant collapse/expand and subtree move script.
- **[NFR-PERF-09](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-09) · Streaming generation never drops frames.** Run 1,000 streamed additions during continuous native pan and check mean and tail budgets.
- **[NFR-PERF-10](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-10) · Time to first streamed node.** Measure first visible node within a frame with immediate stub, plus model/application split on a live run.
- **[NFR-PERF-11](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-11) · Memory budgets set by measurement.** Capture that visible worker run on a configured runner. The current report-export path passed nine hidden-window open/edit/close trials with six additional large-map cycles. Its stress map used the synchronous fallback and peaked at 1,280.12 MiB.
- **[NFR-PERF-12](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-12) · Picture memory on the GPU stays bounded.** Measure tail under a fraction-sized texture budget and confirm bounds with 3,000 pictures.
- **[NFR-PERF-13](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-13) · Near-zero idle use and low energy cost.** Count 60 seconds of idle callbacks, record OS CPU/energy, establish budget and compare MindNode.
- **[NFR-PERF-14](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-14) · Scaling and graceful degradation on the stress map.** Record scripted stress-map mean frame interval on reference native hardware and its 120 Hz result.
- **[NFR-PERF-15](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PERF-15) · Performance regression gate.** Native CI still requires registered, unlocked 60 and 120 Hz runners and their first passing baseline reports.

### Recovery & reliability

- **[NFR-REL-05](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-REL-05) · Rate limits and plan exhaustion are handled in the interface.** The real recorded account snapshots and scripted rate, plan and credit refusals produced distinct native messages while editing remained available. Native refresh ran after each turn. In the two-running/two-queued fixture, the queued jobs reported depleted credits without starting provider turns. Live exhaustion records are still unavailable.
- **[NFR-REL-09](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-REL-09) · Document format versioning and migration.** The available specimens cover archived development writers. Add a specimen from every shipped schema as formal releases become available.
- **[NFR-REL-11](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-REL-11) · Corrupt or hostile files are handled safely.** Fuzz SQLite plus Markdown, OPML, FreeMind and JSON Canvas with crash and timeout detection.

### Privacy, provenance & distribution

- **[NFR-SEC-01](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-01) · Local-first storage.** Monitor all app processes during full non-AI usage with optional updater accounted for.
- **[NFR-SEC-03](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-03) · Never read or copy Codex credentials.** Record full-session file-access trace for no credential files/keychain reads in addition to code audit.
- **[NFR-SEC-04](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-04) · Isolate AI calls from the user's Codex configuration.** Re-run the dummy user MCP fixture against the current packaged launcher and fallback.
- **[NFR-SEC-05](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-05) · Read-only sandbox and approval policy never.** Exercise outside-job write refusal and unexpected approval request logging with the current host.
- **[NFR-SEC-06](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-06) · A working directory per job.** Verify cleanup, copied assets and generated-images removal after ten real image jobs.
- **[NFR-SEC-07](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-07) · All model output is untrusted: SVG.** Record hostile fixture rejection reasons for all specified cases, including element cap and zero network requests.
- **[NFR-SEC-11](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-11) · Disclose the private WebKit flag.** Measure 60 Hz presentation on an unlocked display. The functional native run used a hidden window on a 120 Hz-capable panel.
- **[NFR-SEC-13](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-SEC-13) · Update integrity.** Validate wrong signature, older and truncated updates while app remains functional.

### Accessibility & input

- **[NFR-A11Y-01](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-A11Y-01) · The outline is the accessible form of the map.** Complete screen-reader-only read/add/move/collapse/delete and compare canvas/outline counts on all reference maps.
- **[NFR-A11Y-02](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-A11Y-02) · Every function is reachable from the keyboard.** The specified manual keyboard walkthrough remains. The recorded end-to-end run used automated keypresses.
- **[NFR-A11Y-03](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-A11Y-03) · Screen readers get node text and picture labels.** VoiceOver reading levels/states and labelled pictures plus streamed announcements without focus theft.
- **[NFR-A11Y-07](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-A11Y-07) · Input methods in every text field.** Real CJK IME walkthrough in label, note and search fields including Undo.

### macOS integration

- **[NFR-PLAT-02](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PLAT-02) · Apple Silicon first and the hardware range.** Run same benchmark across support hardware range and match support statement to measured results.
- **[NFR-PLAT-03](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PLAT-03) · Native menus, shortcuts, dialogs and drag and drop.** Complete standard-commands checklist and live Finder/browser drop and native drag-out checks in release build.
- **[NFR-PLAT-04](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PLAT-04) · Dark mode, multiple windows and full screen.** Chromium applied an emulated system appearance change to the open editor and canvas in 3.5 ms. Three browser windows kept independent budgets with controlled platform reports. Repeat across physical displays in native macOS.
- **[NFR-PLAT-05](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PLAT-05) · File icon and Quick Look preview.** Verify the Finder Space gesture with an installed build.
- **[NFR-PLAT-06](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PLAT-06) · Distribution outside the App Store with automatic updates.** Publish signed endpoint and exercise an older installed build updating/relaunching with documents intact.
- **[NFR-PLAT-08](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-PLAT-08) · Plan for per-platform WebViews and the Electron route.** Archive equivalent reports for every released platform/shell and constrain support to those that pass.

### Diagnostics & maintenance

- **[NFR-MAINT-04](Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html#NFR-MAINT-04) · Protocol tests against recorded Codex sessions.** All 19 offline cases passed. Recorded text, schema, interrupted, and SVG sessions were replayed. Interruption sent turn/interrupt and reproduced zero final items. The recorder accepts a Codex binary in one command. Picture and failure cases use scripted messages. Real wire recordings for those cases are still needed.
