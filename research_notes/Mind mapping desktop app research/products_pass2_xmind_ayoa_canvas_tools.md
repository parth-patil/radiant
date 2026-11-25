# Pass 2: Xmind, Ayoa, canvas tools, open-source mappers, conventions (as of 17 Nov 2026)

Method note: about 40 tool calls. Many pages returned only partial content (fetch summaries), so several items are search-summary level. Items tagged "(background, unsourced)" are model memory and must be verified. Vendor pages are marked as marketing. Not repeated from the two earlier files (MindNode detail; Mapify/Xmind Make Image/Miro AI/MindMeister/NotebookLM/Whimsical/EdrawMind/Mymap/MindMap AI/tldraw 4.4/Figma WebGPU).

## 1. Xmind in depth

### Takeaway
Xmind is a cross-platform (Win/macOS/Linux/iOS/Android) mapper with nine structures that can be mixed per branch, a one-click hand-drawn style, Pitch (slides) mode, ZEN mode, an outliner, LaTeX and a native `.xmind` file with a CLI/skill for agents. Official pricing in Nov 2026 is cheap ($4.92 Pro, $8.25 Premium per month, apparently yearly billing) and AI/text-to-map and image generation sit on Premium. Performance complaints are old (Xmind 8 / 2020-21) and no 2025-26 complaints were found.

### Cited Findings
- Nine structures named by Xmind and the App Store: Mind Map, Logic Chart, Brace Map, Org Chart, Fishbone, Timeline, Tree Chart, Tree Table, Matrix; one-click switching; multiple structures can be combined on the same map. — [search summary of Xmind guide/App Store](https://xmind.com/blog/the-ultimate-guide-to-mind-mapping-with-xmind), [App Store](https://apps.apple.com/in/app/id1286983622)
- Tree Table is the newest structure: topics sit in nested rectangles, aimed at comparison and multidimensional lists. — [Xmind blog](https://xmind.com/blog/introducing-tree-table-new-structure-in-xmind)
- Mixing per branch: "each branch can be a unique structure"; select a subtopic, Format panel, Structure; the main topic keeps its structure and only that branch changes; example mixes org chart, matrix and logic chart in one map (article dated 27 Jul 2020, so the mechanism is long-standing). — [Xmind blog](https://xmind.com/blog/how-to-combine-different-structures-in-xmind-and-why)
- Hand-drawn style and Pitch Panel with real-time preview, Smart Color Theme, 30 templates, 400+ stickers and 40 illustrations came with Xmind 2022; hand-drawn is a one-click switch of the whole map look. — [Xmind Academy 2022](https://xmind.com/academy/xmind-2022-release), [Xmind 2022 release](https://xmind.com/blog/xmind2022-release), [features page via search](https://xmind.app/features)
- Pitch mode turns a map into a slide show with smooth transitions and generated layouts; later additions include fishbone/timeline layouts, "Thank You" page and rich-text notes in Pitch (undated). ZEN mode is full-screen with panels hidden; a later release added Light/Dark/Ultra Light/Ultra Dark appearance in Zen. — [App Store](https://apps.apple.com/dk/app/id1286983622), [desktop release notes via search](https://xmind.app/desktop/release-notes/)
- May 2026 newsletter lists AI image-to-editable-map and "pitch video" (theme, duration, music, downloadable). iOS 26.02.04102 added image-to-map; App Store lists "Draw to Map" for sketches. — [May 2026 newsletter](https://xmind.app/newsletter/may-2026-xmind-blog-sharing-a-pro), [App Store](https://apps.apple.com/dk/app/id1286983622)
- Features page lists LaTeX equations, markers, labels, notes, attachments, custom colour themes, PDF/PNG export. (It did not mention relationships, boundaries or summaries, but Xmind's own shortcut table does list relationship, boundary, note, link.) — [Xmind features](https://xmind.com/features), [shortcuts](https://xmind.com/blog/shortcuts-in-xmind-that-improve-mapping-efficiency)
- Official pricing (fetched 17 Nov 2026): Free $0 (10 online maps, 3 sheets/map, 50 AI credits at sign-up, PNG only); Pro $4.92/mo (50 maps, unlimited pitch slides, PNG/SVG/PDF/Markdown/Office export); Premium $8.25/mo (unlimited maps, real-time collaboration, 30-day history, 500 AI credits per month, text-to-map, summarise, refine, task breakdown, pitch video, image generation). Page shows one price per plan with a yearly-purchase link, so these are probably yearly-billed rates (not stated explicitly). Black Friday offer 11 Nov-2 Dec 2026 (buy 1 year get 6 months). One licence covers 5 desktop and 5 mobile devices; 7-day trial on yearly. — [Xmind pricing](https://xmind.com/pricing)
- Contradiction with earlier pass: pass 1 quoted Pro $10/mo or $59.04/yr from a competitor blog; the official page shows $4.92 and $8.25. Prefer official, but the page does not state billing period explicitly.
- Agent integration: Xmind Skill & CLI (`npm install -g @xmindltd/xmind-cli`, `xmind setup skills`, `xmind auth login`) lets Codex, Claude Code, Cursor and OpenCode create, read, edit and validate native local `.xmind` files; requires Xmind account sign-in; cannot generate new images but can attach existing ones; some options use credits. A separate Xmind MCP works with cloud maps. — [Xmind CLI guide](https://xmind.com/user-guide/xmind-cli)
- Shortcuts (Mac/Win): see section 12 table. Summary and boundary default keys are inconsistent across sources; Xmind says shortcuts are customisable. — [Xmind blog](https://xmind.com/blog/shortcuts-in-xmind-that-improve-mapping-efficiency), [search summary](https://xmind.app/m/236d9a)
- Performance: old reports only, e.g. a 920 MB Xmind 2020/21 map with embedded images and documents took ~1m40s to open on macOS Big Sur; Xmind 8 Pro lag on sheets with many branches; slow save with many attachments. No 2025-26 threads found. — [Xmind forum](https://support.xmind.net/hc/en-us/community/posts/900002371446/comments/4404758445977), [Xmind forum 2](https://support.xmind.net/hc/de/community/posts/900001127466-Xmind-pro-8-Startup-time-and-delay)
- Xmind 2027/Agent/ Make Image already covered in pass 1; a search this pass found no independent source on a "2027" release, so treat it as one Product Hunt/vendor item. — [search result summary](https://apps.apple.com/dk/app/id1286983622)

### Inferences
- Xmind's per-branch structure mixing is the closest shipping analogue to "per-subtree representation". Borrow the UI pattern (Format > Structure applied to the selected branch only).
- Hand-drawn style as a global one-click switch is a cheap on-ramp to the organic look but is a filter on boxes/lines, not Buzan tapered curves (inferred; I did not see the rendering).
- Premium-gated AI + credits is the model the CLI-subscription design avoids.

### Gaps
- Not verified: .xmind internal format (background, unsourced: a zip containing content.json, metadata.json, manifest.json, resources/ for new versions; older files used content.xml), whether free-position toggle exists in current Xmind, floating topics default (shortcut-page source says double-click blank canvas creates a floating topic, [xmind.app/m/LfMF](https://xmind.app/m/LfMF), snippet only), Smart Color Theme mechanics, relationship/summary behaviour details, current ZEN/outliner specifics, 2026 desktop release notes (page 404 on first URL, redirect not retrieved).

## 2. Ayoa (ex iMindMap) in depth

### Takeaway
Ayoa is the only mainstream product positioned on an organic Buzan look: curved branches that taper thick-to-thin, bendable by hand, plus a Freehand drawing mode. It is a cloud/web workspace (web app plus iPhone/iPad/Android), not a desktop app; the older iMindMap desktop product was replaced in 2019. AI (generate map, ideas, images) is Ultimate-only. Most evidence is vendor marketing.

### Cited Findings
- Lineage: iMindMap developed by Chris Griffiths with Tony Buzan 2005-2019; OpenGenius launched Ayoa in 2019 as cloud successor; Ayoa says iMindMap is replaced by Ayoa. — [Ayoa (vendor)](https://www.ayoa.com/?p=2955)
- Organic maps: curved branches that taper from a thick centre to fine tips, bendable, can be drawn freehand; MindMeister is characterised by Ayoa as "clean, tidy". Vendor claim. — [Ayoa comparison via search](https://www.ayoa.com/?p=15228)
- Contradiction: a GetApp listing says thickness of branches cannot be adjusted. — [GetApp](https://www.getapp.co.uk/software/114189/Ayoa)
- TechRadar says freehand drawing is retained from iMindMap and works on mobile or with a stylus. — [TechRadar](https://www.techradar.com/pro/ayoa-review) (body not retrievable; search summary only)
- Pricing page (fetched): free plan 10 maps; 7-day Ultimate trial; Ultimate billed per user monthly/annually/3-yearly; no prices listed; AI mind mapping, idea generation, analysis, AI summaries are Ultimate; web app (app.ayoa.com) plus iPhone/iPad/Android; no desktop app mentioned. — [Ayoa pricing](https://ayoa.com/pricing/)
- A competitor blog cites Ultimate at $13 per user per month billed annually (unverified; earlier pass said ~$10). — [MindMap AI vs Ayoa](https://mindmapai.app/blog/35/mindmap-ai-vs-ayoa)
- AI: "AI Prompt to Mind Map" and "Generate Ideas" exist; AI image generation is documented for the mobile app. Manual images: Add Image to central idea by upload or "Search web" royalty-free. — [Ayoa support](https://support.ayoa.com/ai-images-in-ayoa-mobile), [AI prompt](https://support.ayoa.com/ai-prompt-to-mind-map)
- Mind map modes named on the vendor site include organic, radial and "Smartsway" views; the pricing page lists "multiple modes" without naming them. — [Ayoa Smartsway](https://www.ayoa.com/smartsway) (title only), [pricing](https://ayoa.com/pricing/)

### Inferences
- Whether text follows the branch curve was not confirmed from any source; classic iMindMap put text on the branch (background, unsourced). Treat "text on branch" as a differentiated feature to prototype, not a copy target.
- No source describes the rendering algorithm. A plausible implementation (inferred): each branch is a cubic Bezier spine with width profile, drawn as a filled polygon outline, like perfect-freehand's taper output (section 8).

### Gaps
- Speed-map mode, radial details, image-as-node and branch attachment, performance with images, reviewer opinion on look beyond vendor/TechRadar: not found. Current iMindMap desktop availability: not verified.

## 3. Other mapping and canvas tools

### Takeaway
Most remaining tools are card/graph canvases rather than organic mappers; the visual-mind-map space beyond Ayoa is clean, flat and tidy. Coggle's distinctive trait is auto-arranged colourful branches (not verified as curved). Heptabase and Markmap-family tools show the Markdown/structured-text route.

### Cited Findings
- Coggle: web only; Free (3 private diagrams), Awesome $5/mo, Organisation $8/member/mo, Enterprise; auto-arranged branches; floating text and images outside the tree; drag-drop image upload; export PDF/image/.mm/text/Visio; line style/path controls on paid plan; over 1,600 icons (listing); no AI mentioned; reviewers say limited control over fonts and branch styling. Curved look not confirmed. — [Coggle](https://coggle.it/), [search summary](https://www.capterra.com/p/162678/Coggle/)
- Heptabase: whiteboards of cards and sections; zooming out keeps section titles legible (a form of semantic zoom); recommends a third-layer whiteboard above ~100 cards; v1.112.8 (22 Oct 2026) improved large-whiteboard drag and loading/rendering; v1.114 dotted grid and snap; v1.115 smart guides; v1.117.0 (6 Nov 2026) lets an MCP-connected agent create/organise whiteboards, sections, connections and mind maps with the app open. Shape elements and global undo still on roadmap. — [Heptabase changelog](https://wiki.heptabase.com/changelog), [Sections](https://wiki.heptabase.com/section), [Organize](https://wiki.heptabase.com/organize-knowledge-and-projects), [Roadmap](https://wiki.heptabase.com/roadmap)
- Kinopio: cards and connections on a canvas; Space or middle mouse pans; cmd/ctrl+scroll or slider zooms; Z toggles full zoom-out/in; minimap and table of contents (a later release says "Positional Zoom" replaces minimaps, so check current); boxes and lists; imports/exports JSON Canvas; free to 100 cards. One user says moving connected cards while zoomed out can mess up connections. — [Kinopio help](https://kinopio.club/help/about/), [PKM Diaries](https://pkmdiaries.substack.com/p/taking-a-look-at-kinopioclub)
- Markmap: Markdown headings/lists to mind map; SVG renderer plus a canvas renderer for very large maps; layouts tree, two-sided, org-chart; themes classic/cards/minimal with dark mode; fold via comment; math, images, tasks; CLI exports standalone HTML/SVG/PNG; VS Code preview. — [markmap README](https://github.com/gera2ld/markmap)
- Obsidian: Enhancing Mindmap (~241k downloads, edits mind maps in Markdown, MIT); Mindmap NextGen (~106k downloads, Markmap-based, frontmatter styling, inline `markmap` code blocks, pinned maps). Canvas stores open JSON Canvas files, and a JSON Canvas MCP server can create/read/edit/validate canvases. — [Obsidian stats NextGen](https://www.obsidianstats.com/plugins/obsidian-mindmap-nextgen), [Enhancing Mindmap](https://community.obsidian.md/plugins/obsidian-enhancing-mindmap), [JSON Canvas MCP](https://claudemarketplaces.com/mcp/io.mcpcentral/jsoncanvas)
- Mind Elixir (MIT JS library): keyboard shortcuts, drag/edit, multi-select, undo, summaries and node links, plugin system, SVG/PNG/HTML export; claims large-map optimisation, no benchmarks; rendering approach not stated. — [Mind Elixir](https://github.com/ssshooter/mind-elixir-core)
- wanglin2 mind-map: MIT library, low maintenance; the closed desktop client offers seven structures (mind map, logical, directory org, org chart, timeline, fishbone, table), 100+ themes plus AI-generated themes, hand-drawn style, minimap, rainbow lines, presentation, outline editing, WebDAV sync, AI map generation; exports PNG/XMind/SVG/PDF/Markdown/FreeMind/Mermaid/Xlsx. — [mind-map repo](https://github.com/wanglin2/mind-map)
- Taskade: maps Tab to indent, not child; feature request exists for Tab=child, Enter=sibling in mind-map mode. — [Taskade forum](https://forum.taskade.com/feature-requests/p/key-tab-for-add-child-and-enter-for-sibling-when-mind-mapping-mode)
- Traverse combines infinite-canvas mind map, notes and spaced-repetition flashcards; RemNote links outline notes to flashcards with spaced repetition and image occlusion. — [Outliner thread](https://outlinersoftware.com/topics/viewt/9905), [RemNote](https://www.remnote.com/feature/spaced-repetition)

### Inferences
- Heptabase's section-title-stays-legible behaviour is the only shipping semantic-zoom-like pattern found; it maps to showing a subtree's title/summary card when zoomed out.
- The Markdown-to-map route (Markmap) fits the AI pipeline: LLM emits Markdown outline, app renders.

### Gaps
- Not researched or no usable evidence: Mindomo, GitMind, MindMup (only shortcuts), Bubbl.us, FigJam mind map, Lucidspark, Milanote, Scrintal, Muse, Apple Freeform, Logseq whiteboards, AFFiNE Edgeless, Excalidraw plugin/ExcaliBrain, Advanced Canvas, Mermaid mindmap syntax, Kosmik status, InfraNodus, Albus, Heuristica, Napkin beyond pass 1, Minder/VYM/Heimer/jsMind/KityMinder rendering internals, Lighten, Mindly, Focusplan, Curio. My Mindly/Lighten searches returned nothing; no 2025-26 native Mac newcomer was identified.

## 4. Hand-drawn and organic rendering libraries

### Takeaway
Two reusable building blocks: rough.js (sketchy shapes, canvas/SVG) and perfect-freehand (variable-width stroke polygon with taper). Together they cover a hand-drawn look cheaply; neither is a mind-map branch renderer, and Buzan-style organic branches would need custom tapered Bezier ribbon code.

### Cited Findings
- rough.js: under 9 kB; lines, curves, arcs, polygons, circles, ellipses, SVG paths; canvas and SVG renderers; options roughness, bowing, fillStyle (hachure default, solid, zigzag, cross-hatch, dots, dashed, zigzag-line), fillWeight, hachureGap; roughness 0 gives a perfect shape, wiki default 1. — [rough README](https://github.com/rough-stuff/rough), [search summary of wiki](https://github.com/rough-stuff/rough/wiki)
- Excalidraw: infinite canvas, open `.excalidraw` JSON, hand-drawn look credited to rough.js; a third-party write-up describes static layer plus interactive overlay canvases (unverified against repo). Roughness preset names "Architect/Artist/Cartoonist" could not be verified. — [Excalidraw repo](https://github.com/excalidraw/excalidraw), [One Year of Excalidraw](https://plus.excalidraw.com/blog/one-year-of-excalidraw), [notes](https://notes.dsebastien.net/30+Areas/33+Permanent+notes/33.02+Content/Excalidraw)
- perfect-freehand: `getStroke(points)` returns an outline polygon; simulates pressure from point spacing (or real pressure); options size (8), thinning (0.5), smoothing (0.5), streamline (0.5), separate start/end `taper`, `cap`, `easing`; output rendered by the caller (SVG path or canvas); may self-intersect. — [perfect-freehand](https://github.com/steveruizok/perfect-freehand)
- tldraw uses perfect-freehand for pen and draw-style shapes per its author (later SDK reportedly rewrote the ink algorithm); Make Real starter sends a canvas screenshot to a vision model to generate HTML; current Agent starter kit lets an agent control the canvas. — [GitHub discussion](https://www.github.com/steveruizok/perfect-freehand/discussions/38), [make-real-starter](https://github.com/tldraw/make-real-starter), [tldraw starter kits](https://tldraw.dev/starter-kits/overview)
- Excalidraw MCP servers (community) let agents draw and export to Obsidian `.excalidraw.md`. — [mcp_excalidraw](https://cdn.jsdelivr.net/gh/yctimlin/mcp_excalidraw@main/README.md)

### Inferences
- Organic branch = centreline Bezier + width profile (thick at trunk, taper to tip) emitted as one filled polygon; perfect-freehand's taper/thinning logic is a ready reference, and a deterministic seed (like rough.js seeds, not verified) keeps wobble stable across redraws.

### Gaps
- Which tools draw text along a curved branch: not confirmed for any tool. Image-as-node (borderless picture node) and branch attachment behaviour: not found per tool. Excalidraw performance internals and text-to-diagram specifics: not verified.

## 5. Images in mind maps (per tool)

### Takeaway
Common patterns: drag/paste/upload, sticker/icon library, web image search (Ayoa), AI sticker (Xmind), background removal (MindNode, pass 1). No source states images can be the node itself with text hidden.

### Cited Findings
- Xmind: local images and stickers; 400+ stickers and 40 illustrations (2022); AI image generation Premium; CLI can attach images. — [Xmind 2022](https://xmind.com/academy/xmind-2022-release), [pricing](https://xmind.com/pricing), [CLI](https://xmind.com/user-guide/xmind-cli)
- Ayoa: upload or web search royalty-free; AI images on mobile. — [Ayoa support](https://support.ayoa.com/getting-started-with-mind-maps) (snippet)
- Coggle: drag-and-drop uploads, floating images; high-res on paid. — [Coggle](https://coggle.it/)
- Performance with many images: Xmind 920 MB embedded-media map slow to open (2020/21); MindManager 26 MB file ~29,000 topics, 50 s load, embedded images suspected. — [Xmind forum](https://support.xmind.net/hc/en-us/community/posts/900002371446/comments/4404758445977), [MindManager](https://community.mindmanager.com/comments/4826/vote/toggle)

### Inferences
- Store images as external assets with thumbnails and mip levels rather than embedding blobs; load by viewport.

### Gaps
- Export behaviour of images per tool, hide-text-on-image nodes: not found.

## 6. Auto-layout vs free placement

### Takeaway
Little new sourced evidence beyond pass 1 (MindNode offsets). Reported: MindNode user wanted better re-layout after manual moves; Kinopio users report connection mess when moving zoomed out; Mind Elixir and Markmap are auto-layout only.

### Cited Findings
- Markmap layouts are tree/two-sided/org-chart auto only. — [markmap](https://github.com/gera2ld/markmap)
- Coggle auto-arranges but allows floating labels/images. — [Coggle](https://coggle.it/)
- Kinopio cards free-placed with connections. — [Kinopio help](https://kinopio.club/help/about/)

### Gaps
- Xmind free-position toggle, SimpleMind, Scapple, Miro, Whimsical layout behaviour and user opinions: not retrieved.

## 7. Canvas feel and performance engineering

### Takeaway
Few primary sources found. Confirmed: Heptabase perf work (Oct 2026), Atlassian's WebGL engine, MURAL's canvas rewrite, Kinopio zoom conventions. Miro/FigJam/Freeform/Muse/Excalidraw engineering posts not found.

### Cited Findings
- Atlassian Confluence Whiteboards built a custom WebGL renderer with a multi-phase game-loop pipeline, target 5K elements with 50 collaborators. — [Atlassian](https://www.atlassian.com/engineering/rendering-like-butter-a-confluence-whiteboards-story)
- MURAL moved from DOM-heavy to a custom canvas engine and reports an 80% improvement in share of frames at 30 fps or higher (vendor figure). — [MURAL on DEV](https://dev.to/mural/performant-paintings-building-a-canvas-render-engine-4506)
- A developer's pixi.js infinite canvas reportedly beat a DOM version by ~10x; breaks around 60,000 cards (single anecdote). — [DEV](https://dev.to/alanscodelog/handling-thousands-cards-on-an-infinite-canvas-4gea)
- Kinopio: Space/middle-mouse pan, modifier+scroll zoom, Z full zoom toggle, minimap. — [Kinopio help](https://kinopio.club/help/about/)
- Muse: no Ink & Switch engineering post found; updates page mentions ink rendering fixes only. — [Muse updates](https://museapp.com/updates)

### Gaps
- Zoom-to-cursor, inertial pan, trackpad-vs-wheel conventions, semantic zoom in shipping products (besides Heptabase section titles): no sources.

## 8. Keyboard conventions

(See table in section 12.) Takeaway: Tab = child and Enter = sibling is the de-facto standard in MindNode, Xmind, SimpleMind, Whimsical, Visio, MindMup (orientation dependent); Freeplane differs (Insert child, Enter sibling, F2 edit, Space fold); Miro (reportedly) reverses Enter/Tab; Taskade uses Tab for indent.

### Cited Findings
- Xmind: Return sibling after, Shift+Return before, Tab child, Cmd+Return parent, Shift+Cmd+L relationship, Shift+Cmd+B boundary, Shift+Cmd+N note, Shift+Cmd+K link, Cmd+/ fold. Windows entries for before/parent conflict in source. — [Xmind blog](https://xmind.com/blog/shortcuts-in-xmind-that-improve-mapping-efficiency)
- Whimsical: Tab child, Enter sibling, Cmd+Enter sibling above, Option+Enter parent. — [Whimsical help via search](https://whimsical.com/learn/shortcuts/mac)
- MindMup: Enter child (horizontal) / Tab; Shift+Enter sibling above; Shift+Tab insert parent; Space edit; / or F fold; arrows navigate; Ctrl+Up/Down move; Backspace/Delete; N notes. — [MindMup](https://blog.mindmup.com/tutorials/keyboard.html)
- SimpleMind (Android list): Tab child, Enter sibling, Ctrl+L crosslink, arrows navigate, Shift+Left/Right collapse/expand, Ctrl+E edit, Ctrl+N note. — [SimpleMind](https://simplemind.eu/?p=6094)
- Freeplane: Insert child, Enter sibling, Shift+Enter sibling before, F2 edit, Space fold/unfold (third-party for Insert/F2; official for Space). — [Freeplane docs](https://docs.freeplane.org/user-documentation/hot-keys-and-beyond.html), [search summary](https://alinex.gitlab.io/env/freeplane/)
- Miro mind map: community report (2023) Enter adds right, Tab adds below; Esc exits editing, arrows navigate; official table not retrieved. — [Miro community](https://community.miro.com/ask-the-community-45/mindmap-keyboard-navigation-8610)
- MindNode: from pass 1.

### Gaps
- iThoughts, MindManager, FigJam tables not retrieved.

## 9. Presentation and review

### Cited Findings
- Xmind Pitch (slides from map, free 5 slides, Pro unlimited) and pitch video (Premium). — [pricing](https://xmind.com/pricing), [newsletter](https://xmind.app/newsletter/may-2026-xmind-blog-sharing-a-pro)
- wanglin2 client has presentation mode; Ayoa lists presentation modes (vendor). — [mind-map](https://github.com/wanglin2/mind-map), [Ayoa](https://ayoa.com/pricing/)
- Traverse and RemNote add flashcards/spaced repetition. — see section 3.
### Gaps
- iThoughts presentation, Mindomo quiz/present, MemX: not retrieved.

## 10. MCP / agent integration

### Cited Findings
- Xmind: CLI + skill for local `.xmind` files; separate MCP for cloud maps. — [Xmind CLI](https://xmind.com/user-guide/xmind-cli)
- Heptabase: MCP create/organise whiteboards, sections, connections and mind maps (v1.117.0, 6 Nov 2026; app must be open); pass 1: hosted MCP. — [changelog](https://wiki.heptabase.com/changelog)
- Obsidian Canvas: community JSON Canvas MCP; Excalidraw: community MCP servers; Miro: MCP for reading boards, updating reportedly limited (secondary review); tldraw: Agent starter kit; Markmap: CLI from Markdown. — [Eraser roundup](https://www.eraser.io/guides/best-diagramming-mcp-servers-in-2026), [JSON Canvas MCP](https://claudemarketplaces.com/mcp/io.mcpcentral/jsoncanvas), [tldraw kits](https://tldraw.dev/starter-kits/overview), [markmap](https://github.com/gera2ld/markmap)

### Inferences
- Plain-text/JSON open formats (JSON Canvas, Markdown outline, `.excalidraw`) are what make agent integration easy; a documented JSON map file is itself the agent interface.

## 11. Synthesis A: expanded comparison table (passes 1 and 2)

| Tool | Platform | Organic/hand-drawn look | Per-branch structure/representation | Images | AI | Agent interface | Price (Nov 2026) |
|---|---|---|---|---|---|---|---|
| MindNode (p1) | Apple only | tapered branches (2026.4), rounded/angular | per-main-node layout | stickers/photos, bg removal | on-device Apple Intelligence | MCP (Mac) | free; Plus $2.99/mo |
| Xmind | Win/Mac/Linux/iOS/Android | one-click hand-drawn style | 9 structures, mixable per branch | stickers, illustrations, AI sticker | agent, text-to-map, image-to-map | CLI+skill, cloud MCP | Free; $4.92 / $8.25 mo (official, yearly assumed) |
| Ayoa | web + iOS/iPad/Android | organic tapered, freehand (vendor) | radial/organic modes | upload, web search, AI images (mobile) | map/ideas/images (Ultimate) | none found | per-user; unclear ($13 competitor claim) |
| Coggle | web | flat auto branches | no | upload, floating | none found | none | Free; $5 / $8 |
| Markmap | lib/CLI/VS Code | none | no | images in Markdown | no | CLI | OSS |
| Mind Elixir / wanglin2 | JS libs (+closed client) | hand-drawn style (client) | 7 structures (client) | yes | AI generation (client) | n/a | MIT |
| Heptabase | desktop/web | no | sections | cards | chat | MCP incl. mind maps | not verified |
| Kinopio | web | no | boxes/lists | yes | no | JSON Canvas | free 100 cards |
| Obsidian + plugins | desktop | no | no | via notes | via plugins | JSON Canvas MCP | free core |
| Excalidraw | web/OSS | rough.js sketchy | no | yes | not verified | community MCP | OSS |
| tldraw | SDK | draw style (perfect-freehand) | no | yes | agent kit, Make Real | agent starter | SDK licence |
| Whimsical/Miro/Mapify/MindMeister/GitMind/EdrawMind/Mymap/MindMap AI/NotebookLM | see pass 1 | none | none | limited | yes | Miro read-focused | see pass 1 |

## 12. Synthesis B: keyboard conventions

| Action | MindNode | Xmind (Mac) | Whimsical | SimpleMind | MindMup | Freeplane | Miro | De-facto standard |
|---|---|---|---|---|---|---|---|---|
| Child | Tab | Tab | Tab | Tab | Enter/Tab by layout | Insert | Tab (reported, below) | Tab |
| Sibling after | Return | Return | Enter | Enter | Tab/Enter by layout | Enter | Enter (reported) | Return/Enter |
| Sibling before | Opt+Return | Shift+Return | Cmd+Enter | not listed | Shift+Enter | Shift+Enter | not found | Shift+Enter (Xmind/MindMup/Freeplane) |
| Parent | Opt+Tab | Cmd+Return | Opt+Enter | not listed | Shift+Tab | not found | not found | no standard |
| Edit | Cmd+Return | not listed | not listed | Ctrl+E | Space | F2 | Enter | F2 or Space (split) |
| Fold | Opt+. | Cmd+/ | not listed | Shift+Left/Right | / or F | Space | not found | no standard |
| Navigate | arrows | not listed | not listed | arrows | arrows | arrows | arrows | arrows |
| Move node | Cmd+Arrow | not listed | not listed | not listed | Ctrl+Up/Down | not found | not found | Cmd/Ctrl+arrows |
| Delete | Delete | not listed | not listed | Del | Backspace/Delete | not found | not found | Delete |
| Note | Shift+Cmd+K | Shift+Cmd+N | not listed | Ctrl+N | N | not found | not found | no standard |
| Link/relationship | Cmd+L | Shift+Cmd+L (relationship), Shift+Cmd+K (link) | not listed | Ctrl+L | not found | not found | not found | no standard |
Sources: sections 8 and pass 1. "Not listed" means the retrieved page omitted it, not that the tool lacks it.

## 13. Synthesis C: best ideas to borrow

1. Xmind: per-branch structure switching via Format panel; hand-drawn as global one-click toggle; Pitch mode generating slides from branches.
2. Xmind CLI/skill pattern: agent edits a native local file and validates it, unrelated branches preserved.
3. Ayoa: tapered organic branches with freehand drawing as a first-class mode; "search web" royalty-free image for a node.
4. perfect-freehand: taper/thinning outline polygon for organic branches; rough.js: seeded wobble for hand-drawn strokes.
5. Heptabase: section titles stay legible when zoomed out (semantic zoom precedent); MCP that edits the open app's mind maps; sections as scopes.
6. Kinopio: Space-pan, modifier-scroll zoom, Z toggle for zoom-out/in, JSON Canvas import/export.
7. Markmap: Markdown outline in, canvas renderer fallback for very large maps, standalone HTML export, frontmatter styling (Mindmap NextGen).
8. Obsidian/JSON Canvas: open file format agents can read and write.
9. Traverse/RemNote: flashcards from nodes for memorability.
10. Atlassian/MURAL: custom GPU/canvas engines replaced DOM for large boards.
11. Coggle: floating labels/images outside the tree.
12. Xmind Tree Table / Markmap themes: alternative layouts per subtree.

## Overall gaps
Large parts of the assignment list remain unresearched (see section 3 gaps); budget was spent on Xmind, Ayoa, libraries, shortcuts and agent interfaces. No source found for organic branch rendering internals in Ayoa/iMindMap, text along curved branches, or image-as-node attachment in any tool.
