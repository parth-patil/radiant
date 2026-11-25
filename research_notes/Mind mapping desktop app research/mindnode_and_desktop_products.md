# MindNode and established desktop mind-mapping products (as of 17 Nov 2026)

Method note: research ran ~30 tool calls (more than the usual budget because of scope). Everything below is from fetched mindnode.com pages, the App Store listing, or search results. Third-party aggregator pricing is flagged as unreliable. Items marked "(background, unsourced)" come from model memory, not from a fetched page, and must be verified before use. Items marked "(inferred)" are my reasoning.

## 1. MindNode current product state (versions, platforms, pricing, company, 2024-2026 changes, AI)

### Takeaway
MindNode today is the rebuilt app "MindNode: Mind Map & Outline" (formerly "MindNode Next", to be called simply "MindNode"). It runs on Mac, iPhone, iPad, Vision Pro and Apple Watch. Plus costs $2.99/month or $24.99/year. It ships roughly monthly, with latest release 2026.7.2 on 10 Nov 2026. It has on-device Apple Intelligence AI and (Mac only) an MCP server. MindNode Classic still exists and is included with Plus.

### Cited Findings
- Company: IdeasOnCanvas GmbH, "independently crafted in Europe", user-funded, founder-owned, no investors, about 18 years of development. Platforms Mac, iPad, iPhone, Apple Watch, Vision Pro; "Liquid Glass" UI; data in the user's iCloud. — [mindnode.com](https://mindnode.com/)
- Pricing: free tier, MindNode Plus $2.99/month or $24.99/year, free trial, also in Setapp. Free covers mind mapping, import/export. Plus adds outlining, Apple Intelligence, connections/notes/tasks, images/emojis/stickers, Focus Mode and visual tags, styling and themes, collaboration, Apple Watch. Classic is included with any Plus subscription. — [pricing](https://mindnode.com/pricing)
- App Store: version 2026.7.2 (10 Nov 2026); 4.6/5 from 337 ratings; requires iOS 18 / macOS 15 / visionOS 2 / watchOS 11; Plus adds outline editing, notes, tags, connections, tasks, Focus Mode, Shortcuts, document linking, SVG export, AI, full theming; recent updates improved loading/typing/editing/import performance on large documents. — [App Store](https://apps.apple.com/us/app/mindnode-mind-map-outline/id6446116532)
- Naming and architecture: new MindNode ("MindNode Next") is built on a new foundation for conflict-free sync and collaboration; it does not sync with Classic (very different architecture); import works both directions with some feature loss; documents are managed inside the app via iCloud, not as visible files; will be called "simply MindNode". — [Next guide](https://www.mindnode.com/support/guides/mindnode-next)
- Feature parity between Classic and Next is a published roadmap shown only as an SVG mind map (unreadable as text), so which Classic features are still missing in Nov 2026 is UNVERIFIED. — [roadmap](https://www.mindnode.com/article/features-classic-next)
- At Next's launch (about Dec 2024) manual layout and many exporters were missing; the developer called manual layout a priority. Quick Entry was reported missing. — [search summary of Outliner thread/podfeet](https://outlinersoftware.com/topics/viewt/11145), [Podfeet](https://www.podfeet.com/blog/2024/12/mindnode-next/)
- Release timeline (official): 2025.5 (7 Jul 2025) Personal Themes, Reminders sync, image/text resizing; 2025.6 (15 Sep 2025) Liquid Glass, AI Brainstorming and text generation with on-device Apple Intelligence, automatic image background removal; 2025.7 (17 Nov 2025) improved Inspector, MindNode Alias, task export to Things and OmniFocus, theme sync; 2026.1 (10 Feb 2026) Apple Watch app, new unfold actions, search/replace in notes; 2026.2 (30 Mar 2026) Document History on Mac, document linking, task highlighting, enhanced notes and notes sidebar; 2026.3 (27 May 2026) nested folders, widgets, Marked integration, Document History on iOS/visionOS, Outline on Vision Pro; 2026.4 (6 Jul 2026) radial layout, circle and square shapes, tapered branches, LaTeX; 2026.5 (1 Sep 2026) printing options, MCP agent integration, history marks AI/MCP changes; 2026.6 (14 Sep 2026) iOS/macOS 27, Spotlight search for nodes, Siri creates documents; 2026.6.2 (5 Oct) Ukrainian; 2026.7 (21 Oct 2026) iPhone Duo, side-by-side map and outline; 2026.7.2 (10 Nov 2026) iPad keyboard toolbar, iPhone sibling/parent shortcuts, easier cross-connection title formatting. — [releases](https://www.mindnode.com/releases)
- MCP: Mac only; assistants read-only by default, write access must be granted; works with Claude Desktop, Claude Code, ChatGPT for Mac, Codex, Mistral Vibe; example tasks are organising library, restyling maps, translating; specific tools not listed in the post. AI can be disabled in Settings. — [2026.5 post](https://www.mindnode.com/blog/2026.5)
- 2026.3 gave free users extra styling/layout controls, a basic sticker set and an "Important" tag (via search summary; the pricing page still lists many of these under Plus, so exact free/paid split is unclear). — [blog 2026.3](https://www.mindnode.com/blog/2026.3)
- Tapered branches (first-level branches wide-to-narrow), eight node shapes, "d" while dragging detaches a node, improved zoom (2026.4). — [2026.4 post](https://www.mindnode.com/blog/2026.4)
- myMindNode web publishing: new uploads stopped Sep 2024, service ended 28 Mar 2025, data deleted 15 Apr 2025; never found a large audience, development stopped 2017; SVG export suggested as the web alternative. — [shutdown notice](https://www.mindnode.com/blog/mymindnode-web-service-shutdown)
- Subscription switch (Plus) angered some long-time users ("gutted the version I bought", secondhand quote). — [MPU forum thread](https://talk.macpowerusers.com/t/mindnode-switches-to-a-subscription-business-model/14947?page=3)

### Inferences
- MindNode's direction in 2026 is: Apple-native, collaborative (CRDT-like sync, inferred from "conflict-free"), AI-assistive but not AI-generative-first. An AI-generated-map app with a style request is differentiated from MindNode's Apple Intelligence brainstorming.
- MindNode has no Windows/Linux/web app, so a cross-platform fast desktop app has an open lane.

### Gaps
- Exact current Classic-vs-Next parity (Smart Layout, wells, Quick Entry, myMindNode-era features) not verified; roadmap is an image.
- Quick Entry, "wells", Smart Layout, Visual Tags specifics: not documented in the pages I fetched. Background knowledge (unsourced): Classic had Quick Entry (menu-bar capture), Smart Layout (auto layout) and Focus Mode; verify on mindnode.com/support/guides/mindnode-classic before relying.
- No Reddit threads were retrievable; Reddit sentiment is not directly sourced.

## 2. MindNode canvas, nodes, layout, outline, styling (behaviour for re-implementation)

### Takeaway
MindNode Next is an auto-layout tree with relative-offset manual overrides, per-main-node layout (horizontal, vertical, compact, radial), rounded/angular/tapered branches, tasks, notes, stickers/photos, cross connections with labels, and a synced outline. Keyboard model: Tab child, Return sibling.

### Cited Findings
- Keyboard (Mac): Tab child; Option+Tab parent; Return sibling; Option+Return sibling above; Shift+Return new main node; Cmd+Return edit title; Cmd+K link; Shift+Cmd+T task; Ctrl+Cmd+T complete; Space Quick Look; Shift+Cmd+K notes; Shift+Cmd+F focus mode; arrows move selection; Shift+arrow select next in direction; Cmd+R select main node; Cmd+Arrow move node; Shift+Cmd+D detach; Ctrl+Cmd+R reset manual positions; Option+Cmd+B balance; sort children (alphabetical, by task state); Option+. fold; Option+Cmd+. fold with siblings; Ctrl+Option+. unfold one level; Cmd+L cross connection; Cmd+D duplicate; Delete removes node and subtree; Option+Delete removes node and promotes children; Cmd+/-/0 zoom, Cmd+* zoom to fit; Shift+Cmd+8 centre selection; Cmd+F find, Option+Cmd+F replace; Cmd+1 map, Cmd+2 outline; copy/paste style Option+Cmd+C/V. — [shortcuts](https://www.mindnode.com/support/guides/keyboard-shortcuts)
- Layout: set per main node; Horizontal (left/right/both), Vertical (up/down/both), Compact (org chart), Radial (even spread); spacing narrow/default/wide; branch types Rounded or Angular; multiple main nodes per document ("Shift+Return add main node"). — [styling guide](https://www.mindnode.com/support/guides/mind-map-and-canvas-styling)
- Flexible positioning in Next: no manual mode; any node can be dragged and keeps position relative to parent; a shadow shows the snap-back spot; dragging far enough shows an indicator that it will stay at an offset; Option overrides; Organize menu: Balance, Move All Nodes, Reset Position. — [styling guide](https://www.mindnode.com/support/guides/mind-map-and-canvas-styling)
- Cross connections: Cmd+L then click target, or Shift+drag; draggable middle waypoint curves it, double-click straightens; double-click adds a title (label). — [connections](https://www.mindnode.com/support/guides/connections)
- Tasks: checkbox on node; parent shows progress indicator with percent on hover; clicking parent indicator completes all subtasks; Reminders sync two-way for completion, MindNode-to-Reminders for creation only (Reminders-created tasks do not appear); Reminders list named after document; reminders include notes, tags, path and deep link; one-way Things/OmniFocus export. Due dates not mentioned on the page. — [tasks](https://www.mindnode.com/support/guides/tasks)
- Images: stickers (tinted and colour), emojis, photos; attach to selected node or create main node; resize via knobs; Apple Intelligence background removal. — [stickers guide](https://www.mindnode.com/support/guides/stickers-emojis-and-photos)
- Outline: always in sync with map; main nodes in creation order; first-level children follow clockwise map order, deeper levels top to bottom; font size/colour ignored, bold/italic kept; Return splits a node mid-text, Backspace merges; drag line left/right to change hierarchy; tasks on right; show tags/content indicators options; side-by-side map and outline added 21 Oct 2026 (iPhone Duo release notes). — [outlining](https://www.mindnode.com/support/guides/outlining), [releases](https://www.mindnode.com/releases)
- Folding: Option+hover shows fold arrow; indicator to unfold; unfold one level; nested folders added 2026.3. — [folding](https://www.mindnode.com/support/guides/folding)
- Themes: personal themes extract canvas colour, main node, child node, branch style, branch colouring of first-level nodes, connection style and fonts from a document ("one main node, six children, one connection" recommended); hierarchical themes; dynamic themes follow light/dark mode. — [themes](https://www.mindnode.com/support/guides/themes)
- Focus Mode and Visual Tags are listed as Plus features; LaTeX equations added 2026.4. — [pricing](https://mindnode.com/pricing)

### Inferences
- Relative-offset dragging (inferred as storing a delta from the auto-layout position) is a good model: auto layout stays authoritative while manual tweaks survive reflow.
- Overlap avoidance is not documented; (inferred) it is a layout pass that sizes subtrees and spaces siblings, with manual offsets applied afterwards.

### Gaps
- Wells, Smart Layout, Quick Entry, Focus Mode and Visual Tags behaviour details not found in fetched docs. Node border/shape details, tag colours, due dates, stickers library size, typography options were not documented in fetched pages.
- Performance numbers for large MindNode maps: none found beyond the App Store statement of improvements.

## 3. MindNode import/export, sharing, file format

### Takeaway
Import: MindNode Next/Classic, plain/rich text, Word (Mac), Markdown, TextBundle, FreeMind, iThoughts, OPML, XMind. Export: MindNode Next/Classic, PDF, SVG, FreeMind, OPML, PNG, Markdown (TextBundle), text/TaskPaper. Next has no documented user-visible file package; the Classic .mindnode package is reportedly a binary plist.

### Cited Findings
- Import and export lists as above; PDF outline exports can include notes/tags; PNG with transparent or solid background; SVG is editable vector; TaskPaper via the text export; no CSV or MindManager export listed. — [import/export](https://www.mindnode.com/support/guides/import-and-export)
- Third-party mindnode-mcp README claims the Classic .mindnode is a package whose contents.xml is an Apple binary plist, with a recursive node tree at canvas.mindMaps[].mainNode (format version 9) and a resources folder for images. Unverified against MindNode docs. — [claudemarket listing](https://claudemarket.ai/mcp/masamitsu-konya/mindnode-mcp)
- Sync via iCloud (CloudKit); collaboration is live; Next's storage is app-managed. — [Next guide](https://www.mindnode.com/support/guides/mindnode-next)
- MindNode Next documents are not exposed as files, a known user complaint about file locations. — [MPU forum](https://talk.macpowerusers.com/t/mindnode-next-where-are-the-files-stored/39127) (title only; content not fetched)

### Inferences
- For the new app, own the file format as an open package (JSON plus assets folder) and offer OPML, FreeMind .mm, Markdown and SVG/PNG first; these cover what MindNode users already move between.

### Gaps
- Next's internal data format is undocumented; no official .mindnode spec found.

## 4. User sentiment on MindNode

### Takeaway
Praise centres on polish, ease of use, cross-device quality and a calm UI; complaints centre on the subscription change, missing Classic features after the rewrite, limited layout/branch control, and limited advanced diagramming.

### Cited Findings
- The Sweet Setup names MindNode its best mind mapping app and beats iThoughts on ease of use. — [Sweet Setup](https://thesweetsetup.com/apps/best-mind-mapping-app/)
- MacStories MindNode 5 and 6 reviews strongly positive ("finally clicked for me", "refined"). — [MacStories MN5](https://www.macstories.net/?p=52089), [MN6](https://www.macstories.net/?p=59013)
- TechRadar: excellent but lacks customizable templates. — [TechRadar](https://www.techradar.com/pro/mindnode-review)
- No MacSparky review found. — search result summary
- App Store reviewers praise cross-device support; one criticises limited spatial computing; another wanted both branch styles in one map and better layouts when nodes are moved. — [App Store](https://apps.apple.com/us/app/mindnode-mind-map-outline/id6446116532), [AppsHunter reviews](https://appshunter.io/ios/app/1218718027/reviews/3)
- Capterra comparison: fewer advanced diagram types and less granular control for large complex maps than XMind. — [Capterra](https://www.capterra.com/compare/128088-207384/XMind-vs-MindNode)
- MacPowerUsers thread: cumbersome moving/positioning of topics on iOS vs iThoughts (MindNode 6.0.1). — [forum](https://talk.macpowerusers.com/t/mindnode-6-0-1-ios-cumbersome-moving-positioning-of-topics-vs-ithoughts/12138)

### Gaps
- r/mindmapping and r/macapps threads not retrievable; no quantified large-map complaints for MindNode.

## 5. Recommendations per MindNode area (derived from findings above; my judgement)

| Area | Recommendation | Reason |
|---|---|---|
| Tab/Return/Option-variants keyboard model | Adopt as is | Matches cross-tool muscle memory; fast |
| Infinite canvas, multiple main nodes | Adopt as is | Core to the user's goals |
| Auto layout + relative-offset manual override | Adopt with changes | Keep, but make layout incremental for big maps |
| Per-main-node layout (horizontal/vertical/compact/radial) | Adopt with changes | Per-subtree layout also fits image/SVG subtrees |
| Rounded/angular/tapered branches | Adopt with changes | Add true organic/Buzan curves (see Ayoa) |
| Folding (incl. unfold one level) | Adopt as is | Required for collapsible rendered subtrees |
| Cross connections with labels/waypoints | Adopt as is | Cheap, expected |
| Tasks with progress rollup, Reminders | Adopt with changes (rollup yes, Apple sync later) | Rollup is simple; sync is platform-specific |
| Notes/LaTeX | Adopt with changes | Keep notes plain/Markdown first |
| Stickers/photos/background removal | Adopt with changes | Generalise to image and SVG subtrees |
| Outline view synced to map | Adopt as is | Strong; use as AI input/output |
| Focus Mode, visual tags | Adopt with changes | Low cost; cheap filters |
| Themes, personal themes, dark mode | Adopt as is | Extract-style-from-document is a good idea; also drives AI "requested style" |
| Quick Entry menu-bar capture | Adopt with changes (unverified detail) | Useful, later phase |
| Import/export (OPML, FreeMind, Markdown, SVG, PNG, PDF) | Adopt as is | Interop; skip TaskPaper/Things/OmniFocus initially |
| iCloud sync/live collaboration | Skip (initially) | Not in stated goals |
| myMindNode web publishing | Skip | MindNode itself retired it; SVG export replaced it |
| MCP/agent interface | Adopt with changes | Fits Codex CLI plan; MindNode's read-only-by-default is a good pattern |
| Document history | Adopt with changes | Mark AI-generated changes as MindNode does |

## 6. Other desktop tools (profiles)

### Takeaway
Xmind and MindManager are the feature-rich incumbents; SimpleMind and Freeplane are the value/open options; Ayoa is the organic, image-rich leader; iThoughts is dead; TheBrain and Scapple are different paradigms. Large-map performance is a recurring weakness for MindManager and Xmind.

### Cited Findings
- Xmind: desktop for Windows, macOS, Linux; AI map generation; paid tiers range about $3-8/month depending on aggregator (unreliable); Business $10/seat with 800 AI credits; single site claims 15 Jun 2026 image-to-map and collaborative Outliner. Users report lag on large maps with embedded images; large files slow to open. — [Capterra](https://capterra.com/p/128088/XMind/), [Xmind forum](https://support.xmind.net/hc/en-us/community/posts/900002371446/comments/4404758445977), [Xmind AI search](https://www.stork.ai/en/xmind) (low confidence)
- iThoughts/iThoughtsX: toketaWare announced 30 Jan 2024 it ceased trading; no more updates; existing installs run until an OS change breaks them; Setapp installs ended after 2 Feb 2024; status of non-X iThoughts not stated. — [MPU forum](https://talk.macpowerusers.com/t/toketaware-is-out-of-business-and-along-with-it-ithoughtsx/36169)
- MindManager: Windows and Mac; one-time about $349 or subscription $99-169/yr per aggregators; no confirmed AI features; Mac app reportedly gets mostly maintenance; large maps slow per user reports (26 MB file unusable in MindManager 2023), vendor says issues under 1% of cases, others report 30,000-topic maps. — [Capterra](https://www.capterra.com/p/31776/MindManager/pricing/), [forum](https://community.mindmanager.com/comments/4826/vote/toggle), [vendor blog](https://blog.mindmanager.com/?p=2217)
- SimpleMind: one-time purchase per platform, about $29.99 Mac or Windows, about $54.99 both (aggregator); free-form layout, images, video and voice notes, cloud sync. — [SimpleMind](https://simplemind.eu/?p=535), [aggregator](https://us.fitgap.com/products/simplemind)
- Freeplane: open source, Java, uses FreeMind XML .mm with extensions; latest 1.13.3 mid-July 2026 per trackers; AI features need Java 17 (1.13.2 note); performance claims unverified. — [Wikipedia](https://en.wikipedia.org/wiki/Freeplane), [PCWelt](https://www.pcwelt.de/article/1141281/freeplane-mindmapping.html)
- FreeMind file format documented on the wiki (XML .mm). — [FreeMind wiki](https://freemind.sourceforge.io/wiki/index.php/Fmt)
- Ayoa (formerly iMindMap): organic maps with adjustable curved branches, freehand branch drawing, images/GIFs/sketches/AI images in branches; price about $10/user/month annual (conflicting, verify); claims are vendor promotion. — [Ayoa organic](https://ayoa.com/?p=3439), [review](https://project-management.com/imindmap-software-review/)
- TheBrain 15: Cerebro agentic AI (Elephas review); single site reports desktop app became free 23 Jun 2026; other sources $219 one-time, $299/year, $15+/month. Conflicting; no performance data found. — [Elephas](https://elephas.app/blog/thebrain-review.md), [yespress](https://yespress.io/thebrain), [Capterra](https://www.capterra.com/p/10017820/TheBrain/pricing/)
- Scapple: free-form notes with connections; Mac 1.5.4, Windows 1.4.2; licences sold per platform. — [Literature & Latte](https://www.literatureandlatte.com/scapple/overview)
- Minder: GPL-3.0 GTK app (Gtk4 in 2.0), keyboard-driven, auto layout, Markdown; imports OPML, FreeMind, Freeplane, Markdown, Mermaid, XMind; save format changed in 2.0. — [GitHub](https://github.com/phase1geo/Minder), [2.0.0](https://newreleases.io/project/github/phase1geo/Minder/release/2.0.0)
- VYM: GPL, C++/Qt, cross-platform, scripting, Jira/Confluence; strict tree; exports XHTML, ASCII, CSV, LaTeX. — [ghacks](https://www.ghacks.net/?p=23489), [Wikipedia](https://Www.wikipedia.org/wiki/Vym_(software))
- Mindomo: web plus desktop; Premium about EUR 6-7/month (aggregators); AI text-to-map. — [FrontDesk](https://frontdeskreview.com/software/mind-mapping/mindomo/)
- EdrawMind: Edraw AI one-click maps since 10.6.0; about $4.9-6.6/user/month (unreliable). — [SoftwareSuggest](https://www.softwaresuggest.com/wondershare-edrawmind)
- Large-map anecdotes: Miro lags near 1,000 nodes; XMind search lag up to a minute on very large files; MindMeister freezes. — [Miro](https://community.miro.com/ask-the-community-45/miro-mindmap-is-slow-freezy-and-lagging-13452), [MindMeister](https://community.meister.co/discussion/comment/1227)

### Inferences
- Best ideas to borrow: Ayoa's freehand/organic branches and image-rich nodes; Freeplane/Minder breadth of import; Scapple's free-form notes; MindManager's mature Windows feature set; TheBrain's AI agent actions.
- Competitors' weakness is large-map responsiveness and embedded-image bloat, directly relevant to a GPU-accelerated, level-of-detail design with rasterised subtrees (inferred).

### Gaps
- Not covered: OmniOutliner/OmniGraffle, Zenmind, DrawExpress, Curio, Buzan iMindMap text-along-branch rendering details (no source found), Ayoa and Xmind official pricing, freehand sketching support in Xmind/MindManager, Freeplane or SimpleMind performance numbers.
- Buzan-style tools: only Ayoa/iMindMap evidenced here; text-on-branch rendering unverified.

## 7. Cross-tool keyboard conventions and file formats

### Takeaway
Tab=child and Enter/Return=sibling is the shared convention (MindNode confirmed). The widely supported interchange formats are OPML, FreeMind .mm, Markdown and Xmind.

### Cited Findings
- MindNode: Tab child, Return sibling, Option+Return sibling above. — [shortcuts](https://www.mindnode.com/support/guides/keyboard-shortcuts)
- Minder: keyboard-first creation; imports OPML, FreeMind, Freeplane, Markdown, Mermaid, XMind. — [Minder](https://github.com/phase1geo/Minder)
- MindNode imports FreeMind, iThoughts, OPML, XMind, Markdown and exports FreeMind, OPML, Markdown, SVG, PDF, PNG. — [import/export](https://www.mindnode.com/support/guides/import-and-export)

### Inferences
- Support in priority order: own format, OPML, FreeMind .mm, Markdown outline, SVG/PNG/PDF export, then Xmind import. Space/F2 to edit is common in other tools (background, unsourced; verify per tool).

### Gaps
- Per-tool shortcut tables for Xmind, MindManager, Freeplane, SimpleMind not retrieved.
