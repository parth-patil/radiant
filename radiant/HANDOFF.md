# Radiant: handoff for the next session

Written 17 November 2026 (late evening) by the coordinating Claude session. Read this whole file before doing
anything, then `ARCHITECTURE.md`. Everything here was true at the time of writing; verify file contents before
relying on any detail.

---

## Latest verified implementation · 18 November 2026

For a new implementation session, start with the [current agent handoff](docs/Radiant-Implementation-Handoff_2026-11-18.md). The [timestamped feature guide](docs/Radiant-Feature-Guide_2026-11-18_07-30-36_IST.html) includes workflows and all 341 acceptance records.

The row-level audits cover all 341 numbered requirements in the HTML sources. At this checkpoint 267 have direct acceptance evidence, 0 are implemented with acceptance still unverified, 69 are partial, 4 are open, and 1 is deferred. See the [functional audit](requirements/features.md), [AI and artwork audit](requirements/ai-art.md), and [engine and quality audit](requirements/engine-quality.md).

The 13:44 IST Apple silicon test build includes the correction for regenerating a 40-shape SVG group with a clipping definition. A fresh large-map export check found all 300 pictures in both the SVG and PDF. The new guide comparison shows the same branch in the canvas and both exports. [Build and remaining work](docs/Radiant-Implementation-Handoff_2026-11-18.md)

SVG generation checks the direction and boundary of each connector. Regenerating one group preserved both neighboring groups byte for byte through native save and reopen, including migration of an older map. Failed repairs, interrupted picture jobs and unreadable assets kept the affected nodes editable. Native thumbnail generation handled 24.2-megapixel PNG and JPEG files and a 37,000-path SVG. Chromium and packaged WebKit each drew 240 image-specific placeholders in one draw call while bitmap decoding was held. Large SVGs above the preview parsing limits retain their original bytes. [Artwork acceptance](requirements/ai-art.md)

Picture requests with identical inputs now share a generated asset while keeping each node’s anchors. Native macOS cut out an opaque photo on-device and saved the original, the RGBA cutout and the thumbnail in the map. Picture and SVG folds kept the parent selectable on 5,000-node maps. A separate offline native run edited and exported a mixed-art map, then reopened both artwork hashes. [Artwork acceptance](requirements/ai-art.md)

The native reference benchmark opens the 200-, 5,000- and 50,000-node SQLite fixtures. The CPU gate accepted a clean Chromium run and rejected a deliberate 12 ms draw delay. A packaged public-WebKit build saved and reopened an edit with the private high-refresh switch removed. Physical native timings and the first hosted CI runs are outstanding. [Performance measurements](requirements/reference-performance.md) · [Quality acceptance](requirements/engine-quality.md)

Picture batches default to one active node job, with two available in the inspector. Cancelling either configuration interrupted every active native turn within 2.3 ms in offline replay and retained finished pictures. A 15-node illustrated map kept every image hash when its live label was edited. [Artwork acceptance](requirements/ai-art.md)

Picture generation pauses twice. A 15-node native replay submitted one style reference, two samples after reference approval and the remaining 13 pictures after sample approval. All 15 retained the approved reference after reopening. Regenerating artwork on a 5,000-node map preserved every node’s bounds. [Artwork acceptance](requirements/ai-art.md)

The offline macOS editor saved and reopened edits. An interrupted generation retained both complete nodes, and retry opened a fresh job. At 150% interface scale, both Chromium and macOS WebKit kept the outline and inspector usable together in a 720 × 480 window. [Reliability and accessibility acceptance](requirements/engine-quality.md)

The native keyboard audit reached 73 menu entries. A keyboard-only Chromium run created a map, generated branches, edited a node and exported its new label to Markdown. Colour-vision checks covered seven built-in themes in both appearances. Native asset exports preserved the original PNG bytes and the same provenance displayed in the Inspector. [Accessibility and provenance acceptance](requirements/engine-quality.md)

New maps use SQLite format v3. Inserting between 1,000 siblings writes one node row. The native gate opens specimens from all three development formats and checks that older originals retain their exact bytes. A 200-node reference map also survived 24 journal edits while a second connection repeatedly reopened it. [File format](docs/file-format.md) · [Compatibility gate](tools/fixtures/formats/README.md)

History captures the map before AI expansion, refinement and grouped artwork changes as well as map generation. Restoring the pre-generation snapshot recovered every field of a styled, cross-linked map. Reducing motion during a fold or zoom now completes the movement at its destination. [Quality acceptance](requirements/engine-quality.md)

The outline now inserts rows before, after or inside another row and can move a branch up multiple levels in one drag. Native interchange checks exercised Markdown, OPML, FreeMind, JSON and JSON Canvas. Mixed-art exports preserved live SVG text, embedded raster artwork, and branch selection across export formats. [Functional acceptance](requirements/features.md)

The Buzan strict preset exposes 12 independent switches. Its checklist includes folded descendants when assessing colour inheritance and branch geometry. Personal themes retain a selected branch’s inherited palette and typography across file export and import. Study checks covered individual picture and SVG reveals, two documents’ due entries and continued inline typing through timer expiry. [Theme and study checks](requirements/features.md)

An isolated macOS run killed a streaming Codex process and froze a replacement. Retrying from saved provenance opened a fresh connection and retained the acknowledged nodes. Grouped Undo and Redo reproduced the complete document after interleaved user edits and reopening. [AI acceptance](requirements/ai-art.md) · [Native reliability checks](requirements/engine-quality.md)

A 385-cut simulation discarded unflushed writes in a private SQLite filesystem and reopened every snapshot with its expected data and journal. The native storage self-check passed with the updated SQLite dependency. The distribution audit currently reports one outstanding npm advisory for Picomatch 4.0.7. Public signing, notarization and the signed update round trip are also pending. [Filesystem simulation](docs/journal-fsync-acceptance.md) · [Dependency report](requirements/dependencies.md)

- Chromium added 50 varied labels without an overlap. A growing root and an edge-overlap during drag exposed two layout defects, both fixed. Edits left all 27 boxes in unrelated branches exactly in place, and three reopens retained every saved box. The inspector now offers Up, Compact and indented Outline layouts. [Layout acceptance](requirements/features.md)
- On a mixed-layout 5,000-node map, native WebKit decoded 300 pictures and SVGs. Every node kept its exact coordinates and dimensions in both the main-thread and worker layouts. In Chromium, a ten-picture batch remained editable while its placeholders were replaced one at a time. The 5,000-node picking probe took at most 0.10 ms, and visible-set construction took at most 0.90 ms across 122 camera positions. [Engine acceptance](requirements/engine-quality.md)
- Single-node picture and SVG prompts can be edited. Native save and reopen preserved whitespace and Unicode through an SVG repair turn. Two instructions can produce identical bytes. The embedded asset row now records the generation used in the document, and older maps retain their full imported style metadata. A separate ten-node map stored exactly one copy of each shared asset. [Artwork acceptance](requirements/ai-art.md)
- The native AI queue enforces cross-window concurrency. Offline replay recovered complete nodes after an interruption with an empty final-items list and discarded the trailing fragment. A declined single-image or batch confirmation sent zero requests, and a usage-limit error paused the picture queue while retaining accepted work. [AI acceptance](requirements/ai-art.md)
- Vector, picture and SVG switches preserved all 2,736 bytes of a 50-node Markdown outline through three individual Undo actions on Chromium and native macOS. Search and the outline accessibility tree exposed a multiword illustrated node in both artwork modes. Keyboard navigation and Undo kept the selected node visible at the original zoom with both side panels open. [Functional acceptance](requirements/features.md)
- Chromium and macOS WebKit kept curved labels upright across 360 branch directions. Ten Arabic and Devanagari strings stayed horizontal at every angle. The same renderers kept five cursor anchors fixed through the full zoom range and reproduced one-device-pixel pans exactly at 100,000 world units from the origin. [Engine acceptance](requirements/engine-quality.md)
- The 5,000-node disk-open fixture preserved the complete map and all 300 embedded pictures. On an empty cache the disk-load IPC fell from 2,788 ms to 64 ms. The locked display prevented a first-presented-frame measurement. [Disk-open benchmark](requirements/disk-open.md)
- Map generation, refinement and artwork use versioned prompt templates. A template-only change reached the next generated map and survived reopening. The HTML stream example produced five nodes without rejections. Three expansion jobs inherited branch styling while leaving every pre-existing node outside the target unchanged. Native fallback rejected an invalid second row before applying either node.
- Generated maps retain validation warnings. Chromium reopened all seven stored answers on a 20-node study map, and a palette edit recoloured every branch in its fixture without another provider call. Live CLI and MCP reads also saw an editor change before disk acknowledgement under a path-specific grant.
- Four macOS force-quits during offline AI generation recovered all acknowledged nodes and showed the count saved from the unfinished job. The native Quick Look provider rendered a saved map's root, child and embedded artwork. Finder's Space gesture still needs an installed-build check.
- LibreOffice Writer pasted the normal image at 2,092 × 504 pixels and preserved the original SVG with Copy vector image. The exported vector PDF retained selectable labels. The native memory gate passed a separate six-repeat run on this Mac. Its 50,000-node fixture used the synchronous layout fallback. [Memory measurements](requirements/memory-budget.md)
- Print preview and PDF export support five paper sizes, margins, orientation and tiling. The browser printed to six A5 landscape pages and one Letter portrait page with the expected margin clearance and selectable text. Import and export now report omissions before and after the operation.
- The editor retains the full live Undo and Redo stacks. A 2,200-edit run restored exact documents in both directions. Chromium verified every intermediate state of ten different edits, including grouped AI generation, an outline import, styling and a representation switch. The on-disk history keeps the most recent 1,000 steps per stack.
- Rebuild from Memory now opens an independent editable canvas and overlays the attempt on the saved geometry. A native five-topic exercise retained the original 73,728 SQLite bytes and Undo history. Exported PDFs keep words selectable around unsupported emoji and symbols.
- Drag previews show the automatic position. Ctrl+Cmd+R, branch reset and whole-map reset passed in Chromium. Growing a sibling previously displaced a parent without its manually offset child. After the fix the child moved with its parent through a 170-unit change, browser save/reopen and position reset.
- Key-node emphasis, the per-map marker legend and deterministic Hand-drawn node outlines passed browser checks. A 5,000-node overview kept a collapsed title legible at 0.94% zoom. Optional artwork review showed the exact prompt and attachments before dispatch in offline Chromium replay.
- The four additional root layouts passed native save, reopen and undo checks. Branch boundaries and dimensional labels passed canvas and export checks. Chromium highlighted a word across three main branches and created a separate saved map from that word. Apple Reminders completion sync passed an isolated two-way check. A signed app connected to a real test account still needs verification.
- The map folder browser shows searchable thumbnails. A ten-document browser fixture exercised filtering and opening a result. The desktop folder reader opens SQLite metadata read-only.
- Generated trees retain their own editable palettes, typography and branch styling. The Inspector can change one tree without regenerating its artwork or changing another tree. Node notes now preview inline and display LaTeX using bundled fonts. The browser check verified accessible MathML, literal currency and exact preservation of the source note.
- The Outline exposes keyboard tree navigation and selection state. Interface scaling persists separately from canvas zoom. A colour calculation across 888 theme and fill combinations produced a minimum text contrast ratio of 4.50.
- Large maps move layout, mesh preparation and spatial indexing to a worker. On this Mac an isolated WKWebView completed the warm 5,000-node worker pass in a median 11 ms. Chromium completed the 50,000-node worker pass in 324 ms. Those durations measure worker execution. End-to-end input-to-display latency remains open.
- AI jobs now carry provenance through save, reopen, Undo, clipboard transfers and branch extraction. The offline model smoke verified prompt, model, effort and usage retention.
- Named maps now gate queued edits on durable acknowledgement. A native check withheld the first acknowledgement, queued five edits, retried a rejected write, switched documents and verified undo after restart. SQLite v2 stores indexed nodes, edges, styles and AI jobs and migrates v1 on the next write.
- A packaged macOS fixture opened a note and SVG artwork containing external references, typeset its equation and loaded a layout worker. A request monitor saw zero hits; the WebView blocked direct remote fetch and image requests. A browser check verified safe Markdown formatting, inert raw HTML and remote images, visible link destinations, and user-activated web and mail links. AI labels keep the editable source.
- An Anki text export supports individual selected nodes or the whole map. Anki imported the downloaded file with the expected multiline answer, literal markup and Unicode study answer. A separate import retained cards with duplicate labels.
- Warm-cache startup to a working Inspector click passed on this Mac in all 20 fresh process launches. After the SQLite and SvelteKit upgrades the median was 363.4 ms, p95 373.9 ms and maximum 434.8 ms. The earlier 20-run batch had median 465.9 ms and maximum 648.5 ms. Run `python3 tools/check-startup.py` to repeat. First launch after reboot and physical input-to-display timing remain open.
- The real canvas workflow drew 5,000 nodes in 109.6 ms from the fixture load request, then expanded a branch through offline replay. The 50,000-node Chromium relayout kept its longest observed frame to 16.8 ms by transferring data in chunks. The full handoff took about 552 ms. Native disk-open timing at that size remains open.
- The Inspector previews and exports category-only local diagnostics. Fixtures checked log rotation, error handling and exclusion of planted map text and credentials. The production build enforces the core, renderer, shell and provider boundaries.
- Offline import checks covered 19 Classic v7/v9 and eight Next v1 vendor maps (2,326 nodes and 170 attachment placements). Next styles, tags, connections, collapse state and built-in stickers remain partial, as do exact Classic layout, rich text and PDF vector fidelity.
- Editable sketches retain pressure samples through native SQLite reopen. Browser checks covered drawing, erasing, undo and visual exports. Synced aliases share label, note, study answer, task, tags and link, with independent placement, children and appearance. Menu-bar Quick Capture supports closed and open maps, with native Undo and Redo verified for both routes. The tray click and physical pen input still need a hands-on check.
- At revision `3d6d56e`, 1,000 isolated host interruptions and 1,000 separate WebView interruptions all reopened clean. Every map retained all acknowledged edits and passed SQLite integrity and journal checks. Host seed 87 had 99 commits awaiting acknowledgement; WebView seed 88 had 607. The full-scale checks used scripted named maps on this Mac. Cross-platform validation and physical input latency remain open.
- The documented SQL example built a SQLite v2 file independently of the app and opened in a packaged native window. The CLI and MCP reader now handle both SQLite versions. The distributable Radiant skill was used to find a parent, add a branch with an active native grant, then validate and read it back.

## Blueprint implementation update · 18 November 2026

- **Editing and outline.** Keyboard entry supports root creation, sibling insertion, splitting labels, parent insertion and child promotion. The Outline supports ancestor-preserving search, splitting and merging at the caret, an outline-only view and selection export. Chromium checks exercised modifier keys, conflict detection and the persisted MindNode keymap, rich clipboard transfers between windows, grouped tag changes, insertion between siblings, and find-and-replace with an undoable preview.
- **Artwork and layout.** Picture and SVG folds interpolate geometry with reduced-motion support. Five layout families retained coordinates across repeated reopen checks. Local pictures support drop, paste, resizing and descriptions. Verification of these UI paths used Chromium and the offline provider.
- **Study.** Initial generated study maps can contain blanks. Recall strength appears on the canvas. Learned maps can prompt for review on open. An opt-in reminder operates while the desktop application runs. The delivery path was checked with a simulated notification host.
- **Interchange.** MindNode Classic version 9 import was checked against three first-party examples. Editable JSON with referenced assets can be read and written as a folder or ZIP. Maps can link to a specific node and an extracted branch has a backlink. MindNode Next and full Classic style and attachment fidelity remain open.
- **Desktop.** Native smoke checks verified two document windows, path-scoped recovery for matching document IDs, Open Recent and session restoration. The quit flow advances through dirty windows one at a time. An isolated follow-up exercised native window close, the menu quit handler and programmatic exit. Cancelling each kept the dirty fixture open.
- **File safety.** After an acknowledged autosave, a separate SQLite writer changed the saved map. Radiant rejected the subsequent Save and preserved the file byte-for-byte. A forced host kill and relaunch recovered the local edit and its Undo step as a separate map. Native loads refused newer and truncated fixtures and left their hashes unchanged. One warm development WebView loaded and laid out 5,000 synthetic nodes in 113 ms. The harness could not observe its first animation frame.
- **SQLite edit journal.** A named map stores each edit and its reversible operation record in one transaction. The v1 file format remains readable. A native smoke run wrote three UI edits, including an explicit note deletion, followed by a checkpoint. After a host kill and relaunch, the map reopened with the committed content and Undo history and had no pending recovery copy.
- **Native edit acceptance.** A desktop WebView smoke withheld the first journal acknowledgement while dispatching rapid text changes, a child insertion and Undo. Later edits waited and all five writes finished in order. An injected write rejection paused the queue until Save retried successfully. The window switched maps, and a force-kill and relaunch reopened the document with its final text and Undo history. A separate external SQLite write triggered recovery. Save As kept the latest queued edit in a separate file, and both files passed SQLite integrity checks.
- **Storage crash gate.** `tools/verify-journal-crashes.sh` compiles the production journal module into a standalone worker. In 1,000 forced interruptions, 757 maps reopened at the last acknowledged edit and 243 at one durable edit beyond the last acknowledgement. Every file passed SQLite integrity checks, and the last journal digest matched its materialized document. The worker run took 46.2 seconds on this Mac.
- **Release checks still open.** See the newer interruption and filesystem results above. Native disk-open first-frame timing, macOS signing and notarization, and cross-platform release checks remain open.

## Implementation follow-up · 18 November 2026

The November 17 sections below describe the original baseline. Subsequent commits added picture and SVG subtree modes, branch-level mixed layouts, curve-following labels, review scheduling, AI refinement, local agent access, import and export formats, and persistent attributed Undo/Redo. The Inspector exposes these workflows. Recent files, named snapshots, Finder open requests and close-time save prompts are wired into the desktop app.

- Browser checks exercised mock art generation and retry, review scheduling across reload, scoped editing, persisted history, connections, tasks, theme editing and restoring a snapshot as a copy. New AI flows used the offline provider. The earlier two real generation and expansion calls remain the native subscription evidence.
- The SQLite store self-checks passed. An Electron spike reached 120 Hz with 5,000 branches on this Mac. Physical input-to-display latency still needs measurement.
- The local signed-updater integration needs a release endpoint and signing material for a published update. Apple distribution signing, notarization, direct MindNode import, and cross-platform release validation remain open. These milestones cover multiple workflows, and the blueprint still contains additional acceptance criteria and later features.

## Integration follow-up · 17 November 2026

Sections 6–10 below record the original handoff. The M1/M2 integration and native smoke pass have since been carried out. Resume with section 8, step 3.

- Browser checks covered keyboard and pointer editing, outline and inspector controls, AI generation/expansion/cancellation and grouped undo, imports, clipboard Markdown, image paste, autosave and recovery. Fixes include preserving edits during save, preventing in-flight AI from changing a replacement document, and keeping newer recovery snapshots within the same second.
- Headless Chrome screenshots covered the empty map, prompt, generated map, inline editing, both panels, Buzan, Midnight and a 5,000-node map. Zoom to fit now includes the whole large map. Selection and hover reuse renderer caches. All five layouts had zero overlapping node boxes on the 20-node sample.
- Native Tauri on macOS used two real Codex calls. Generation produced 17 nodes and expansion added four children to a leaf. Saving and reopening yielded an identical 21-node document. The native check supplied a scratch file path in place of interacting with Finder dialogs. The native outline menu shortcut worked.
- On the built-in display, the native high-refresh flag was enabled. Panning a fitted 5,000-node synthetic map over 600 frame intervals measured 119.98 Hz, with a 9 ms p95 interval. This measures frame cadence. Input-to-display latency remains an open spike.
- Final verification passed: Svelte check (zero errors and warnings), production frontend build, Rust debug build and all 30 store self-test checks. Native Finder drag-and-drop and manual file-picker interaction still need a hands-on check.

---

## 1. What Radiant is

A fast, local, organic-looking desktop mind-mapping app for macOS (Windows and Linux later without a rewrite).

- An AI drafts a mind map from a topic and a requested style. The AI engine is the owner's existing ChatGPT
  subscription, driven through the locally installed OpenAI Codex CLI (`codex app-server`), with no API key.
- Infinite, zoomable canvas. Very high performance is a core goal (120 Hz on the owner's MacBook).
- MindNode-like editing (the owner uses MindNode today).
- Tony Buzan's ideas as defaults: tapered curved branches, one colour per main branch, word on the line, images.
- **Signature feature, not built yet:** any subtree can switch to a *picture* representation (every node is a
  generated image) or an *SVG* representation (the subtree is drawn as generated SVG artwork). It stays connected
  to its parent branch, stays collapsible, and can always switch back to plain nodes.

"Radiant" is a working name.

### The requirements live in a big report

`/Users/parth/projects/general/mind_maps/radiant-mind-map-blueprint.html` is a single-file, 21-page report.
Its page sources are easier to grep: `/Users/parth/projects/general/mind_maps/report/src/pages/*.html`.

| Page source | Contents |
|---|---|
| `features.html` | 142 functional requirements: FR-CAN, FR-EDT, FR-LAY, FR-STY, FR-OUT, FR-ORG, FR-MEM, FR-IO, FR-AGT |
| `ai-engine.html` | 45 FR-AI requirements: generation, streaming, refinement, engine management |
| `art-subtrees.html` | 50 FR-ART requirements: picture and SVG subtrees, the SVG contract, the style sheet |
| `engine.html` | 40 ENG requirements: layout, branches, text, canvas, pictures, SVG, data model, file format |
| `quality.html` | 64 NFR requirements: performance budgets, reliability, security, accessibility, platform |
| `stack.html`, `other-stacks.html`, `zig.html`, `codex.html` | The stack decision and its evidence |
| `roadmap.html` | Milestones M0 to M7 and the risks |
| `buzan.html`, `science.html`, `practice.html` | Buzan's laws and the learning evidence behind the style and recall features |

The research notes behind the report are in `/Users/parth/projects/general/mind_maps/research_notes/`.

---

## 2. The owner and their standing instructions

- An experienced Elixir/Phoenix developer, interested in Zig, open to Rust. They chose **Rust + Tauri + custom WebGL**.
- **"Use many subagents but they should not step on each other's work."** Every path has exactly one owner
  (see `ARCHITECTURE.md`); shared contracts are edited only by the coordinator.
- **"Don't write unit tests."** Verify with `bun run check`, `cargo build`, debug self-test flags, headless
  screenshots and throwaway scripts kept outside the repository.
- They went to sleep with "make the best decisions on my behalf". They have not seen any of the code yet.
- No git commits have been made. Commit only if the owner asks. The repository is initialised and most files are
  staged (`git add -A` was run once early on), nothing is committed.
- Answers the owner gave earlier: MindNode is the reference app; macOS first, other platforms later; a personal
  tool first, maybe shared later; "best app, fastest path" wins stack trade-offs.

---

## 3. Hard rules for any agent working here

1. **Never read, print or copy Codex credentials** (`~/.codex/auth.json`, keyring entries, tokens). Do not
   modify the owner's Codex config.
2. **Real Codex calls spend the owner's subscription.** Use `MockHost` (plain browser) for UI work. Make real
   calls only to verify the Codex client, a handful at most, with trivial prompts and low effort.
3. Do not leave processes running (`bun run dev`, `tauri dev`, the app, `codex app-server`). Kill only what you started.
4. One owner per path. When running several agents in parallel, assign disjoint directories and keep
   `src/lib/core/types.ts`, `src/lib/host/types.ts`, `src-tauri/src/lib.rs`, `src-tauri/src/menu.rs`,
   `Cargo.toml`, `tauri.conf.json`, `package.json` with the coordinator.
5. No `any` in exported TypeScript APIs. Pure modules under `src/lib/core/` must not import DOM, WebGL or Tauri.
6. Use the scratch folder for throwaway files, never the repo:
   `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/e978aa9d-83bf-4c61-9197-231fbb959d27/scratchpad/`
   (a new session will have a different scratch folder; use whichever the system prompt names).

---

## 4. Environment

| Item | Value |
|---|---|
| Machine | Apple M4 Pro, macOS 26.5.1, built-in 120 Hz ProMotion display plus an external 60 Hz monitor |
| Project | `/Users/parth/projects/general/mind_maps/radiant` |
| Front end | SvelteKit 2 (SPA, `ssr = false`, adapter-static), Svelte 5, TypeScript ~6.0, Vite 8, bun 1.4 |
| Host | Tauri 2.12.x, Rust 1.99 (edition 2024) |
| Codex | `codex-cli 0.167.0`, installed under the owner's nvm directory (not on the GUI PATH; the client finds it) |
| Tauri CLI | via the npm package: `bun run tauri dev` / `bun run tauri build` (no global cargo-tauri) |
| Other tools present | Zig 0.17.0, Elixir 1.18, Node 24, Swift 6.2, Google Chrome (used headless for screenshots) |

### Commands

```sh
cd /Users/parth/projects/general/mind_maps/radiant
bun install                      # already done
bun run check                    # svelte-check: must stay at 0 errors
bun run dev                      # front end in a browser at http://localhost:1420 (uses MockHost)
bun run tauri dev                # the real app (Rust host + WebView)
cd src-tauri && cargo build      # host only

# Debug-build self-tests (exit when done; a window may flash)
cargo run -- --store-selftest                 # 30 checks of files, autosave, recovery, assets: all pass
cargo run -- --ai-selftest=status             # Codex discovery and handshake, no model call
cargo run -- --ai-selftest=text               # ONE real model call: streamed JSON-lines map
cargo run -- --ai-selftest=cancel|tools|image # each ONE real call (image ~17 s)
```

Renderer performance demo: `bun run dev`, then open `http://localhost:1420/dev/render` (5,000 nodes, 5,000
labels, 300 images; has a "Run 5 s pan + zoom test" button; `?autobench` runs it automatically).

---

## 5. Architecture in one picture

```
user input / AI stream
      │  Transaction (ops)
      ▼
core/model ── DocChange ──► core/layout ──► core/geometry ──► ui/pipeline (Scene) ──► render (WebGL2)
 (Doc, undo)                (NodeBox map)    (branch mesh,                              (canvas)
                                              spatial index)
host/ (only code that imports @tauri-apps/*)  ◄──►  Rust: codex/, store/, platform/, menu.rs
```

Key decisions (full list D-01 … D-20 on the report's stack page and in the decisions brief):

- **D-01 Shell:** Tauri 2. The front end reaches the host only through the `Host` interface
  (`src/lib/host/types.ts`), so Electron could replace Tauri in days.
- **D-02 Frame rate:** a default WKWebView is capped at 60 fps. Radiant switches off the private WebKit feature
  `PreferPageRenderingUpdatesNear60FPSEnabled` at start-up (in `platform/mod.rs`) to get 120 fps. It must be
  applied in `setup`, before the first page commits; applying it later did not work. Falls back to 60 silently.
  Rules out the Mac App Store.
- **D-04 Renderer:** custom WebGL2, a handful of batched draw calls. WebGPU later.
- **D-05 Engine core** is pure TypeScript (model, layout, geometry), portable to a Worker or WebAssembly.
- **D-07 AI:** one long-lived `codex app-server` child (JSON-RPC over stdio), lazily started.
- **D-08 Stream format:** the model writes one JSON object per line: `{"id":"n1","parent":null,"title":"…"}`,
  children reference parent ids; optional `note`, `imageHint`; optional first line `{"style":{…}}`.
  The engine does all layout; the model never positions anything.
- **D-09** The tree is the single source of truth; vector, picture and SVG are representations of it.
- **D-11 SVG subtrees:** layout first, then the model draws SVG into the computed boxes under a contract:
  one `<g id="node-ID" data-anchor-in data-anchor-out>` per node, no connectors, no text, no scripts, palette only.
- **D-14 Files:** one SQLite `.radiant` file per map, assets embedded.
- **D-15/D-16:** no Elixir and no Zig in version 1 (reasons on the report's stack page).

---

## 6. Module status

All modules below were built by separate agents and verified by type checks plus throwaway scripts or self-tests.
"Verified" means what is stated, nothing more.

### 6.1 `src/lib/core/types.ts` and `src/lib/host/types.ts` (coordinator)
Shared contracts. Doc/MapNode/Op/Transaction/DocChange/Theme/LayoutResult/NodeBox/BranchSpec/Mesh/Scene/
LabelDraw/RectDraw/ImageDraw/CameraState/StreamNode/StyleSheet/OutlineNode, and the `Host` interface with AI,
document, asset, dialog, menu and text-file methods. Conventions: world coordinates y-down, 1 unit = 1 CSS px at
zoom 1, node boxes are centre + size. **Every RGBA in a Scene or Mesh is premultiplied.**

### 6.2 `src/lib/core/model/` (done)
`newId`, `createDoc`, `cloneDoc`, `validateDoc`, `serializeDoc`, `parseDoc` (repairs damage), `applyOp` (returns
exact inverse), `Editor` (undo/redo, text-edit coalescing within 1 s, `subscribe`, `batch`,
`beginGroup(label, source) → { end, abort }` so a whole AI generation is one undo step), command builders that
return `Edit { tx, focus?, created? }` (addChild, addSibling, addParent, deleteSubtree, moveSubtree, reorder,
detach, setText, setNote, toggleCollapsed, expandAll, collapseToDepth, setStyle, setSide, setOffset, clearOffset,
addLink, removeLink, insertOutline, duplicateSubtree), navigation helpers, outline conversion
(`docFromOutline`, `outlineFromDoc`, `parseIndentedText`, `toIndentedText`), themes `clean` (default), `buzan`,
`midnight`, `ink`. Verified: full undo round trip of every command; 50,000-node doc built in ~70 ms.
Caveats: `set` uses `undefined` to delete keys, which JSON drops (matters only if op logs are persisted later);
undoing an `unlink` re-appends the link at the end.

### 6.3 `src/lib/core/layout/` (done)
`layoutDoc(doc, sizes, opts, cache)`, `layoutRootOnly`, `subtreeBounds`, `LayoutCache` (with
`invalidateTouched(doc, touched)` and a size-signature check). Non-layered tidy tree with true geometric contours
(variable node sizes), layouts `mindmap` (two-sided), `right`, `left`, `down`, `radial`. Manual offsets move a
node and its subtree. Verified: 0 overlaps on random and adversarial trees; 5,000 nodes in ~2.5–3.2 ms,
50,000 in ~22 ms. Mind-map side rule: pinned `side` wins, otherwise in order, right unless right is heavier.

### 6.4 `src/lib/core/geometry/` (done)
`nodeSize`, `resolveNodeStyle` / `createStyleResolver`, `buildBranchSpecs`, `tessellateBranches` (tapered and
organic curves plus the underline bars, one mesh), `buildScene`, `SpatialIndex` (`hitTest`, `query`,
`nearestInDirection`), `visibleRect`, `cullScene`, `parseColor`. Verified: 5,000 branches tessellate in ~2.7 ms;
50,000-box index in ~1.7 ms. Attachment conventions are documented at the top of `branches.ts`.

### 6.5 `src/lib/render/` and `src/routes/dev/render/` (done)
`Camera` (zoomAt, panBy, fitState, animateTo), `CameraController` (macOS trackpad conventions: two-finger pan,
pinch zoom, space/middle drag), `Renderer` (WebGL2, on-demand frames, culling, rect SDF shader, branch mesh,
images with mipmaps and LRU, labels), `LabelAtlas` (browser-shaped text rasterised into atlas pages per √2 zoom
bucket, 4 ms per-frame budget, greeking below 4 px), `measureLabel` (same wrapping as drawing). Verified in
headless Chrome on the real GPU: 5,000 nodes / 5,000 labels / 300 images held 60 fps (headless is capped at 60)
with CPU mean 0.5–0.7 ms per frame. Not verified: 120 Hz in the app, Safari gesture events, the far-origin mode.

### 6.6 `src/lib/core/ai/` and `src-tauri/src/codex/` (done)
Rust: `codex app-server` supervisor and JSON-RPC client (`codex/mod.rs`, `codex/rpc.rs`), lazy start, binary
discovery (PATH, common dirs incl. nvm, login shell), isolation (connectors, plugins, web search, multi-agent and
other features disabled; the owner's own MCP servers disabled by name per thread; read-only sandbox; approval
policy never; empty per-job working dir), concurrency 2 with a queue, timeouts 120 s text / 180 s image,
cancel via `turn/interrupt`, rate-limit forwarding, image items saved to `<app data>/assets/<sha256>.png`.
Default model `gpt-6-luna` at low effort (fallback `gpt-6.1-terra`). TypeScript: `buildGenerateMapPrompt`,
`buildExpandPrompt` (needs `nodeId`), `buildRephrasePrompt`, `NodeLineParser` (`push`, `end`, `discard`),
`StreamApplier` (StreamNodes → Ops; 400-node and depth-6 caps), job reducer. Verified with real calls: first
delta 2.8 s, 8-node map done 5.1 s, cancel acknowledged in 5 ms, image in ~17 s. Not verified live: rate-limit,
usage-exhausted, logged-out and timeout error paths. Could not remove: the model still sees a shell tool and some
built-in collaboration tools; the read-only sandbox and approval policy are the real guard.

### 6.7 `src/lib/core/art/` (done; not wired into the UI)
Groundwork for picture and SVG subtrees: `ArtStyleSheet` with six presets, `describeStyle`, `resolvePalette`;
`buildNodeImageBrief`, `buildStyleReferencePrompt`, `planPictureBatch`, `IMAGE_INSTRUCTIONS`, pixel helpers
(`alphaBounds`, `trimAndPad`, `defaultAnchors`, `decodeToPixels`); `buildSvgSubtreePrompt`, `extractSvg`,
`parseSvg`, `validateSvg`, `sanitizeSvg`, `buildSvgRepairPrompt`. Verified: the validator correctly flags the
spike's sample SVG (connector group, coinciding anchors). No model calls were made for this module.

### 6.8 `src/lib/core/io/` and `src/lib/host/` (done)
Markdown, OPML and FreeMind import/export on `OutlineNode` (own tolerant XML parser). `getHost()` returns
`TauriHost` inside Tauri and `MockHost` in a browser. `MockHost` keeps documents in localStorage and streams a
canned map for any topic, so the UI can be developed without spending the subscription.

### 6.9 `src-tauri/src/store/`, `platform/`, `menu.rs` (done)
`.radiant` = SQLite with `application_id` 0x52444E54 and `user_version` 1; tables `meta`, `doc` (whole Doc JSON),
`assets` (embedded bytes + prompt/model metadata). Atomic saves (temp file + rename). Autosave to
`<app data>/autosave/<docId>.json`; recovery lists autosaves newer than their file. Asset folder
`~/Library/Application Support/app.radiant.mindmap/assets/` with an index database. `text_read`/`text_write`.
Verified: 30/30 store self-test checks pass. The 120 Hz flag was verified at 120 fps in a debug build when the
window sat on the built-in display (61 fps without it). Native menu (File, Edit, Map, View, Window) emits a
`menu` event with the item id; Cut/Copy/Paste/Select All are native so text fields work.

### 6.10 `src/lib/ui/` and `src/routes/+page.svelte` (IN PROGRESS when stopped; see section 7)

---

## 7. Where the integration stopped

The integration agent was stopped at the owner's request (about 23:30, 17 November 2026). By then it had written
the whole UI layer, but it had **not finished its own verification pass**. What exists in `src/lib/ui/`:

| File | Lines | Role |
|---|---|---|
| `controller.svelte.ts` | ~2,000 | `AppController`: editor, selection, keyboard map, pointer handling, inline editing, AI generation and expansion, files, autosave, recovery, menu handling, camera follow |
| `pipeline.ts` | ~230 | Doc change → sizes → layout → branch mesh → spatial index → Scene |
| `util.ts`, `debug.ts` | ~115 | Helpers; dev-only hooks (`window.__radiant`, `?demo=generate&topic=…`, `?demo=big&n=5000`, `?demo=prompt`, `&theme=buzan`, `&outline=1`, `&inspector=1`, `&stats=1`, `&dark=1`) |
| `App.svelte`, `TopBar.svelte`, `PromptPanel.svelte`, `OutlinePanel.svelte`, `Inspector.svelte`, `StatusBar.svelte`, `Dialog.svelte`, `Icon.svelte`, `app.css` | ~1,200 | The interface |

`src/routes/+page.svelte` mounts `App.svelte`.

**Checked by the coordinator after stopping (browser + MockHost, headless Chrome, real GPU):**
- `bun run check`: 0 errors, 3 accessibility warnings in `PromptPanel.svelte` (a `<section role="dialog">` and two
  labels without controls). `cargo build`: clean.
- The empty start state renders: centred "Central topic" root with hints (`docs/handoff/2026-11-17-start.png`).
- `?demo=generate&topic=Photosynthesis` streams the canned MockHost map into a clean two-sided layout with tapered
  branches, one colour per main branch, words on the line, autosave indicator and status line
  (`docs/handoff/2026-11-17-generated.png`).

**Not yet checked by anyone:** keyboard editing and navigation, inline editing, drag and drop, outline and inspector
panels, themes other than `clean`, the 5,000-node demo, file open/save/recovery flows, import/export, picture
drop, and **anything inside the real Tauri app** (native menu events, real Codex generation, 120 Hz). The agent's
own final report was lost when it was stopped, so treat every feature as unverified until you try it.

## 8. Next steps, in order

### Step 1: verify and finish the integration (milestones M1 + M2)
The UI layer exists (section 7). Read `src/lib/ui/*`, then go through the list below, testing each item in the
browser (MockHost) and fixing what fails. This was the integration brief; most items are believed implemented:

1. App shell: full-window canvas; slim top bar (title, undo/redo, layout and theme pickers, Generate, zoom);
   generation panel (topic, style text with suggestions, depth 2–4, breadth 3–7, Generate/Cancel, live status);
   left outline panel (synchronised tree); right inspector (note, branch colour, shape, branch style, emphasis,
   root layout); status line (AI availability and rate limits, autosave state, optional renderer stats).
   Calm macOS styling, light/dark following the OS.
2. Pipeline: Editor change → re-measure changed nodes (cache sizes) → `layoutDoc` with `LayoutCache` →
   `buildBranchSpecs` + `tessellateBranches` only when layout changed → `SpatialIndex` → `buildScene` (also on
   selection/hover/editing) → `renderer.setScene`. Keep the same Mesh object when only selection changes.
   Await `document.fonts.ready` before measuring.
3. Keyboard (MindNode): Tab child, Return sibling after, Shift+Return sibling before, Shift+Tab outdent,
   Space/F2/double-click edit, typing replaces text, Escape ends editing then clears selection, Delete removes
   subtree, arrows navigate (by side; fallback `nearestInDirection`), Cmd+↑/↓ reorder, Cmd+. fold.
   Under Tauri the native menu owns accelerators (menu events); in a browser handle the same keys directly.
   When a text field is focused, menu undo/redo go to the field (`document.execCommand`).
4. Inline editing with an auto-growing HTML textarea over the node (font, size × zoom, colour, wrap width);
   hide that node's label via `buildScene({ editing })`; box grows live; commit on blur.
5. Pointer: click select, Shift/Cmd multi-select, click empty to clear, double-click empty for a floating node,
   drag to reparent (drop indicator; reject own descendants), drop on empty space sets an offset (roots move),
   hover, click collapsed badge to expand, camera follows focus.
6. AI: Cmd+G panel; generate into the empty root or a new root to the right; stream inside
   `editor.beginGroup(...)` so it is one undo step; throttled camera fit; Cancel keeps nodes; Cmd+Shift+E
   expands the selected node; clear error messages (not installed, not logged in, rate limited).
7. Files: new (in-app confirm dialog), open, save / save as, debounced autosave (~2 s), recovery banner on
   start-up, import Markdown/OPML/FreeMind, Copy Map as Markdown, zoom to fit (Cmd+0) and selection (Cmd+1).
8. Pictures v0: drop or paste an image onto a node → `assetPut` → `imageAsset` → shown via `buildScene({ images })`.
9. Dev hooks (dev builds only): `window.__radiant`, `?demo=generate&topic=…` (MockHost stream), `?demo=big`
   (5,000 nodes).

**Verify visually.** Run `bun run dev` and screenshot with headless Chrome:
`"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --use-angle=metal --window-size=1440,900 --virtual-time-budget=8000 --screenshot=<scratch>/x.png "http://localhost:1420/?demo=generate&topic=Photosynthesis"`.
Check the empty state, a generated map, editing, both panels, the `buzan` and `midnight` themes, and the big map.
Fix overlaps, misaligned underlines, branches not meeting nodes, clipped text. Then `cargo build` and run
`bun run tauri dev` once to confirm the real app starts (and quit it).

### Step 2: run it for real once
In the app: generate one small map with real Codex (one call), expand one node (one call), save, reopen,
check `platformInfo().highRefreshEnabled` and that frame pacing feels like 120 Hz on the built-in display.

### Step 3: milestones after that (from the report's roadmap page)
- **M0 spikes still open:** input latency; Electron at 120 Hz without private APIs; a 12-picture batch for
  style consistency and cost; SVG contract pass rate at 5, 12 and 25 nodes.
- **M3 organic style and outline:** text along curved branches; the Buzan preset with optional hints from his
  laws; radial/top-down per main branch polish; outline-first editing; JSON Canvas export; PNG/SVG/PDF export.
- **M4 picture subtrees:** representation switch on a subtree; style sheet + reference image; batch generation with
  placeholders (`planPictureBatch`, ~12–20 s per image, concurrency 2, confirm above 10); transparent cut-outs and
  anchors (`trimAndPad`, `defaultAnchors`); branches ending under the picture; stale-art marking; provenance.
- **M5 SVG subtrees:** layout first, `buildSvgSubtreePrompt` → `extractSvg` → `sanitizeSvg` → `validateSvg`
  → at most two repair rounds → render the sanitised SVG (rasterised per zoom bucket); collapse by hiding groups.
- **M6 recall and review:** collapse-and-recall, hidden labels, rebuild-from-memory, spaced review.
- **M7 packaging:** signing, notarisation, updater, agent interface (CLI + read-only MCP server).

---

## 9. Known issues and open questions

- The UI is written but mostly unverified (section 7). Only the start state and a MockHost generation have been
  seen working, in a browser. Nothing has been run inside the real Tauri app since the UI was added.
- `PromptPanel.svelte` has 3 accessibility warnings from svelte-check.
- Layout side balancing can flip later unpinned siblings when an earlier branch grows; pin `side` after first layout
  if this annoys.
- `MockHost` dialogs use `window.prompt`, which is fine in a browser but irrelevant in the app.
- The 120 Hz setting is private API; it may stop working after a macOS update. Electron is the fallback (unmeasured).
- Codex `app-server` is labelled experimental; regenerate its schema after Codex updates
  (`codex app-server generate-json-schema --out <dir>`).
- Policy: no OpenAI text was found that permits or forbids an app driving the owner's own Codex login. Fine for
  personal use; check before distributing.
- Open owner decisions (report roadmap page): App Store or not (assumed not), default look (clean, Buzan one click
  away), learning vs planning emphasis, Windows/Linux priority, open source vs paid.

---

## 10. State at the moment of stopping

- **Agents:** none running. All seven worker agents had finished; the integration agent was stopped mid-way.
- **Processes:** no Radiant, vite, Tauri or Codex processes started by this session are running. Still running and
  NOT ours (leave them alone): the ChatGPT desktop app's own `codex app-server` daemon (version 0.169) and a
  headless Chrome started by a Playwright tool on 14 November.
- **Builds:** `bun run check` 0 errors / 3 warnings; `cargo build` clean; store self-test 30/30.
- **Git:** repository initialised, files staged, no commits. `HANDOFF.md`, `docs/handoff/` and several newer
  files are untracked or modified since staging; run `git status` to see.
- **Real Codex calls made during the build:** 6 by the AI agent (text, tools, cancel, three image runs, two of them
  killed). Plus 10 during the earlier research. The owner's weekly usage meter read 1% at the last check.
- **Size:** ~14,000 lines of TypeScript, Svelte and Rust.

### Suggested first prompt for the next session

> Read `/Users/parth/projects/general/mind_maps/radiant/HANDOFF.md` and `ARCHITECTURE.md`. Then verify and finish
> step 1 of section 8 using parallel subagents with disjoint file ownership, no unit tests, MockHost for UI work,
> and headless Chrome screenshots to check each feature. When the browser version works, run the real app once
> (`bun run tauri dev`) and do step 2 with at most two real Codex calls.
