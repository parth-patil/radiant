# AI mind-mapping tools and infinite-canvas thinking tools (as of Nov 2026)

Scope note: research was capped at ~16 tool calls, so coverage is uneven. Many tools (Whimsical, Ayoa, Taskade, Mindomo, Coggle, Albus, Heuristica, Markmap, Obsidian plugins, Excalidraw, Scrintal, Kinopio, Muse, Freeform, Logseq, AFFiNE, Miro engine) were NOT individually verified and are listed under Gaps. Most "best of" lists are vendor-authored; treat rankings as marketing.

## 1. AI mind-mapping tools: profiles (input, refinement, style, images, export, price, platform)

### Takeaway
The market has converged on "prompt/document/YouTube -> text-outline map -> chat/expand to refine", with generic editor styling. Image support is limited to Xmind's per-topic "Make Image" stickers and image attachments; no verified tool renders whole subtrees as generated pictures or SVG art.

### Cited Findings
- Comparison by MindMap AI's own CEO (July 2026 hands-on tests, unreproducible, self-ranked #1, internal price inconsistencies): Mapify takes PDF, YouTube, audio, docs, images (file input paid); free = 30 one-time credits, Basic ~$5.99/mo annual, Pro $19.99, Unlimited $29.99; web + Chrome ext + iOS/Android; chat can summarize/expand/reorganize a section on the same map; PDF/SVG/Markdown export paid. — [MindMap AI blog](https://mindmapai.app/blog/122/ai-mind-map-generators)
- Same source, Xmind: free 10 maps/10 AI credits, Pro $10/mo or $59.04/yr; desktop Win/macOS/Linux + mobile; generation, expand, Thinking Mode; chat edits same map; document/image inputs Premium only. — [MindMap AI blog](https://mindmapai.app/blog/122/ai-mind-map-generators)
- Whimsical: no document input, free = 3 boards/100 lifetime AI actions, Pro $12/editor/mo; chat edits content but not structure (moving nodes). Miro: prompt-only input, free 3 boards, Starter $8, Business $20; author saw layout break after AI edits. — [MindMap AI blog](https://mindmapai.app/blog/122/ai-mind-map-generators)
- MindMeister: online only, AI draft + "AI Expand" button, no chat, ~$42-102/yr. GitMind: PDF/YouTube/audio/web/images, all platforms, chat does not see the map; EdrawMind: offline desktop, one file per chat, chat made a new map each time; Mymap.ai: prompt only, follow-ups create a new map, $20/mo Pro, no annual plan. — [MindMap AI blog](https://mindmapai.app/blog/122/ai-mind-map-generators)
- Xmind Agent is the centerpiece of "Xmind 2027": creates maps from ideas/source materials, answers questions about a map, edits/reorganizes branches; included on all plans, uses AI credits; also an Xmind Skill & CLI. — search summary citing [Xmind](https://xmind.com/user-guide/xmind-cli), [Product Hunt](https://www.producthunt.com/products/xmind?launch=xmind-2027)
- Xmind "Make Image" (blog Mar 11 2026, release notes Mar 16 2026): per selected topic, AI reads topic + surrounding map, drafts a prompt and suggests a style; presets 3D, Sketch, Oil Painting (+Realistic), plus Custom Style; "Inspire" re-rolls prompt; output is a "sticker" with auto background removal for presets, inserted on the topic. Plan gating not stated. — [Xmind blog](https://xmind.com/blog/bring-your-ideas-to-life-with-make-image), [user guide](https://xmind.com/user-guide/make-image)
- NotebookLM Mind Maps (launched ~Mar 2025): generated from notebook sources via "Mind Map" chip in chat, ~20 s; zoom/pan, expand/collapse, click a node to ask chat about it; download as image; "regenerate" = delete note and redo; not on mobile app; can be inaccurate. — [Google support](https://support.google.com/notebooklm/answer/16212283?hl=en), [9to5Google](https://9to5google.com/2025/03/27/notebooklm-mind-map/)
- Miro: AI mind-map generator from a prompt onto the board, also flowcharts/ER/UML; maps are live for comments/workshops; Miro announced new AI platform items May 19 2026 (details unverified). — [Miro](https://miro.com/ai/mind-map-ai/), [Miro newsroom](https://miro.com/fr/newsroom/miro-takes-aim-at-the-gap-between-ai-potential-and-organizational-reality)
- MindMap AI (mindmapai.app): nodes can hold pictures, MCP connector for Claude/ChatGPT; Free 50 credits/mo, Basic $4.99, Pro $7.99 annual. Jeda.ai: nodes are "Smart Shapes" on a canvas. — [mindmapai.app](https://mindmapai.app/), [Jeda](https://jeda.ai/ai-mind-map)
- Napkin AI (text to visuals, not mind maps per se): edit generated visuals but not build from scratch; export SVG to finish elsewhere; sometimes misreads intent. — [DEV review Mar 2026](https://dev.to/techsifted/napkin-ai-review-march-2026-turn-text-into-visuals-instantly-97i)
- Heptabase: AI chat at global / whiteboard / card scope, cites card content and PDF page numbers, official hosted MCP server. — [Tana comparison](https://tana.inc/blog/best-heptabase-alternatives-2026) (secondary)
- Reviewer pattern: Mapify = document-to-map, Xmind = polished editable output, Whimsical = fast prompt drafts, Miro = team workshops; no consensus winner. — [AFFiNE guide](https://affine.pro/blog/ai-mind-map-generator), [Scholarly](https://scholarly.so/blog/best-ai-mind-map-generators-2026)

### Inferences
- Refinement quality varies sharply: tools where chat is bound to the live map (Mapify, Xmind, Miro) beat ones that regenerate a new map each turn (EdrawMind, Mymap.ai, Monica). A branch-scoped "regenerate/expand" is the table-stakes pattern.
- Style control in all verified tools = editor themes; only Xmind Make Image takes a natural-language visual style, and only for a single sticker.

### Gaps
- Not verified individually: Whimsical (beyond secondary), Ayoa AI, Taskade, Mindomo, Coggle (any AI), Albus, Heuristica, Markmap, Obsidian AI mind-map plugins, any other 2025-26 newcomers, G2/Reddit/HN sentiment on map quality. Xmind AI pricing for current credits unverified.

## 2. Does anyone render nodes/subtrees as AI raster images or SVG art / organic illustrated maps?

### Takeaway
Searches found NO product that generates a picture per node or turns a subtree into generated raster/SVG art while remaining a live, collapsible map. Closest: Xmind Make Image (per-topic stickers) and a hobby agent that puts one DALL-E image at the root of an SVG map. This looks like an open gap, but absence of evidence from limited search.

### Cited Findings
- Agent.ai "Mindmap Generator": LLM emits indented text tree; custom text2mindmap API lays it out as SVG; ONE DALL-E 3 image (zen, single pastel colour, thick brushstrokes) for the central concept, circle-clipped via SVG clip-path and base64-embedded; no per-node images; layout is two-sided horizontal; tree validity depends on prompt+example. — [DEV Community](https://dev.to/sosuisen/mindmap-generator-how-to-draw-svg-based-graphs-with-ai-generated-text-and-images-using-the-agent-2po2)
- Developer guides suggest prompting DALL-E with a structured mind-map description, or GPT-4 -> Mermaid plus a separate illustrative image; Nano Banana Pro "mind map" images exist as single illustrations on stock-AI sites (unverified quality). — [Medium guide](https://medium.com/@dev-Oscar-checklive/generating-mind-maps-with-openai-dall-e-a-developers-guide-f1f6468f83f0), [Easy-Peasy](https://easy-peasy.ai/ai-image-generator/images/research-mind-map-insights-knowledge-visualization)
- tldraw 4.4 (Feb 19 2026) ships an MIT starter kit for a node-based image-generation pipeline on an infinite canvas, plus an improved agent starter kit. — [tldraw blog](https://tldraw.dev/blog/tldraw-sdk-4.4)

### Inferences
- Single-image "illustrated mind map" outputs from image models are non-editable bitmaps, with text errors a known image-model weakness (general knowledge, NOT sourced here). Hybrid approach (LLM tree + deterministic layout + per-node image/SVG generation, text rendered by app) avoids this; no product found doing it.

### Gaps
- No evidence checked on Midjourney/Ideogram/Recraft mind-map outputs or research prototypes/GitHub projects; limits (text errors, non-editability) not backed by a source in this pass.

## 3. Prompt/interaction patterns and data formats

### Takeaway
Best patterns seen: chat bound to the live map, node-click-to-ask (NotebookLM), one-click "AI Expand" (MindMeister), AI-drafted image prompt from map context (Xmind), source-cited AI (Heptabase). For formats, use a validated JSON or indented-outline tree and compile deterministically; raw Mermaid needs repair loops.

### Cited Findings
- A HU Berlin LLM diagram project raised Mermaid validity from ~70% to near 100% via render-check-repair loop plus syntax reference in the prompt (single project); a JSON-then-deterministic-convert two-stage approach was also used. — [HU Berlin](https://llm-enabled-development-41d6d8.pages.cms.hu-berlin.de/en/experiments/diagram/diagram-long)
- Microsoft GenAIScript: LLMs sometimes emit invalid Mermaid but can repair given parser errors. — [GenAIScript](https://microsoft.github.io/genaiscript/blog/mermaids)
- Aider benchmarks: models make more errors when code is wrapped in JSON (quoting/escaping). — [Aider](https://aider.chat/2024/08/14/code-in-json.html)
- DEV estimate: XML/JSON costs up to 24x more tokens than Mermaid for a sequence diagram (estimate). — [DEV](https://dev.to/akari_iku/analyzing-the-best-diagramming-tools-for-the-llm-age-based-on-token-efficiency-5891)
- StructEval benchmarks JSON/Markdown/Mermaid-type outputs (per-format numbers not retrieved). — [alphaxiv](https://alphaxiv.org/abs/2505.20139)
- The Agent.ai generator found that including an example in the prompt reduced malformed trees. — [DEV](https://dev.to/sosuisen/mindmap-generator-how-to-draw-svg-based-graphs-with-ai-generated-text-and-images-using-the-agent-2po2)

### Inferences
- Recommended: outline-first (indented Markdown or compact JSON with schema), stream tokens line-by-line so nodes appear progressively (indented outlines stream trivially; JSON needs incremental parsing), then per-node image/SVG jobs queued afterward. No source on streaming-onto-canvas in existing tools.

### Gaps
- No head-to-head evidence on which format LLMs generate most reliably for mind maps; depth/breadth controls and citation grounding in mind-map tools not verified beyond Heptabase.

## 4. Infinite canvas tools, performance engineering, layout vs free placement

### Takeaway
Verified engineering references: tldraw (reactive signals, R-tree index, LOD, canvas indicators) and Figma (C++/Wasm, WebGPU with WebGL fallback). Other canvases were not researched.

### Cited Findings
- tldraw SDK: level-of-detail rendering by zoom/on-screen size; reactive state tracks dependencies automatically; tldraw sync on Cloudflare Durable Objects. — [tldraw perf docs](https://tldraw.dev/sdk-features/performance)
- tldraw 4.4: shape indicators moved from SVG to 2D canvas (up to 25x faster in some cases); R-tree spatial index for brush/scribble/erase; skips off-screen shape checks. A "tldraw offline" local app is advertised on the blog header (details unfetched). — [tldraw blog](https://tldraw.dev/blog/tldraw-sdk-4.4)
- Figma (post Sept 18 2025): C++ renderer to Wasm and native, Dawn for WebGPU, uniforms batched in one buffer, shaders GLSL->WGSL via naga, compute shaders planned for blur, runtime WebGPU->WebGL fallback mid-session, device blocklist; gains on some devices, no regressions. — [Figma](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)
- Obsidian Canvas uses open JSON Canvas files; arrows not visible to backlinks/graph (secondary). — [Zeli](https://zeli.app/story/50274139)
- Kosmik: one source says sunset May 31 2026, others still list pricing (conflict; verify). — [Toolradar](https://toolradar.com/alternatives/kosmik)
- Milanote: board/infinite canvas moodboard tool, rated 4.6/5 aggregated. — [Toolradar](https://toolradar.com/compare/milanote-vs-miro)

### Inferences
- For a native high-performance app: spatial index + LOD + GPU renderer with cached rasters per subtree is directly supported by tldraw/Figma practice; image-per-node maps especially need texture atlases/mip LOD (inference).

### Gaps
- Not covered: Excalidraw (rough.js, AI), perfect-freehand, FigJam, Miro engine, Heptabase/Scrintal/Kinopio/Muse/Freeform/Logseq/AFFiNE details, zoom/pan feel write-ups, auto-layout vs free placement trade-offs, tldraw "Make Real". Miro AI quality: only a vendor claim that layout broke after AI edits (single reviewer).

## 5. Synthesis

### Takeaway
Comparison table (from verified fragments; "?" = unverified):

| Tool | Platform | AI generation | Style control | Images per node | Organic look | Offline/desktop | Price |
|---|---|---|---|---|---|---|---|
| Mapify | web, mobile, Chrome | prompt, PDF, YouTube, audio | no | no (image input only) | no | no | free 30 credits; $5.99-29.99/mo |
| Xmind (Agent, Make Image) | desktop+mobile+web | prompt/docs; chat agent | Make Image style presets | stickers per topic | limited | yes | free; Pro ~$10/mo |
| Whimsical | web | prompt | no | attachments | no | no | free 100 AI actions; $12/editor |
| Miro | web | prompt | no | no | no | no | $8-20/member |
| MindMeister | web | draft + Expand | no | ? | no | no | ~$42-102/yr |
| GitMind | all | doc/YouTube/audio/web | no | ? | no | desktop yes | free; $19 Pro |
| EdrawMind | desktop | doc/audio/video | no | ? | no | yes | ~$7.90/mo |
| Mymap.ai | web | prompt | no | no | no | no | $20/mo |
| MindMap AI | web | many inputs | no | node pictures | no | no | $4.99-7.99/mo annual |
| NotebookLM | web | sources | no | no | no | no | Google plan |
| Heptabase | desktop/web | chat, cites cards | n/a | n/a | no | partly | ? |
| tldraw | SDK/app | agent kit | n/a | image-gen pipeline kit | rough styles ? | tldraw offline | MIT/licence ? |
| Napkin AI | web | text->visual | visual styles | n/a | some | no | ? |

### Cited Findings
(see sources above)

### Inferences
Ideas to borrow:
1. Xmind Make Image: AI drafts image prompt from node + surrounding map, suggests style, "Inspire" re-roll, background-removed output.
2. NotebookLM: click a node to ask/explain about it in side chat.
3. MindMeister: one-click "AI Expand" on a node.
4. Mapify/Xmind: chat bound to the live map editing a branch in place (avoid regenerate-everything).
5. Heptabase: scoped AI context (whole space / board / card) and source citations; MCP exposure.
6. tldraw: LOD rendering, R-tree spatial index, reactive state.
7. Figma: GPU renderer with graceful fallback and device blocklist; batched uniforms.
8. tldraw starter kit: node-based image-generation pipeline on canvas for per-node job queues.
9. Agent.ai generator: circle-cropped root artwork; example-in-prompt to stabilise tree format; interactive vs full-auto modes.
10. HU Berlin: render-check-repair loop and JSON-to-deterministic-compiler.
11. Obsidian JSON Canvas: open, portable file format for export.
12. Napkin: SVG export so generated art is editable downstream.
13. Whimsical (reported limitation): structure edits by chat fail; Miro layout breaks after AI edits -> keep layout engine authoritative.

Gap statement: no verified product combines (a) AI tree generation from topic + natural-language style, (b) per-subtree switchable representation as generated raster or SVG art, (c) seamless connection to the parent branch and collapsibility, (d) organic hand-crafted aesthetic, and (e) a native high-performance infinite canvas using a CLI subscription (no per-credit billing). Xmind stickers come closest to (b), but not subtree-level or style-coherent.

### Gaps
- Table cells with "?" unverified; coverage limits listed above. Unverified: Muse, Freeform, Logseq, AFFiNE, Scrintal, Kinopio.
