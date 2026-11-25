# Canvas engine, layout, rendering and hybrid raster/SVG subtree design for a mind-mapping app

Research date: 2026-11-17. About 30 tool calls (searches and fetches). Items labelled **(proposed)** are my own design suggestions with no prior art found. Items labelled **(background, not re-verified)** come from general knowledge and carry no URL. The report writer should treat those as lower confidence.

---

## 1. Tree layout algorithms for mind maps (variable-size nodes, two-sided, radial)

### Takeaway
The standard lineage is Reingold-Tilford (1981), Walker (1989/90), Buchheim-Juenger-Leipert (2002, linear time), then van der Ploeg (2014), which adds linear-time non-layered drawing and variable node sizes. The shipped, usable implementation is d3-flextree, a port of van der Ploeg's Java code. For a mixed picture/text mind map this is the right base. Radial, balloon and organic looks are best built as a mapping or post-process over a tidy-tree result, or as a separate custom pass.

### Cited Findings
- van der Ploeg's paper, "Drawing non-layered tidy trees in linear time", appeared in Software: Practice and Experience 44(12), 2014, pp. 1467-1484, DOI 10.1002/spe.2213. It extends Reingold-Tilford so drawings are non-layered (subtrees can tuck under neighbours rather than being confined to depth rows). It is presented as the first linear-time algorithm for that case. A naive extension to unbounded-degree trees can go O(n^2), and a modification restores O(n). — [WebSearch result summarising the paper](https://core.ac.uk/download/301654972.pdf); [DOI](https://doi.org/10.1002/spe.2213)
- Ports exist: the `non-layered-tidy-tree-layout` npm package and the Cytoscape.js `tidytree` extension. — [socket.dev listing](https://socket.dev/npm/package/non-layered-tidy-tree-layout); [cytoscape-tidytree](https://www.npmjs.com/package/cytoscape-tidytree)
- d3-flextree generalises D3's fixed-size tree layout to variable node sizes via a `nodeSize` accessor and a `spacing` accessor (min gap, can depend on the node pair). It runs in O(n) and is a JS port of van der Ploeg's Java implementation. D3's tree descends from Reingold-Tilford (1981), Walker, and Buchheim et al. (2002). Its x/y are abstract, so they can be remapped (for example to radial). — [d3-flextree README](https://github.com/Klortho/d3-flextree)
- ELK ships these algorithm ids: layered, mrtree (Mr. Tree), radial, force, stress. The page lists ids only, with no descriptions. — [ELK algorithms reference](https://eclipse.dev/elk/reference/algorithms.html)
- markmap offers `tree`, `two-sided` and `org-chart` layouts. It has an SVG renderer and a canvas renderer for very large maps. It supports fold levels and per-node folding. The README does not say which layout algorithm it uses. — [markmap README](https://github.com/markmap/markmap)
- Reingold-Tilford (1981) and Walker (1989) are the base lineage cited by d3-flextree. Buchheim et al. (2002) is cited as the linear-time refinement. — [d3-flextree README](https://github.com/Klortho/d3-flextree)

### Inferences
- A two-sided Xmind-style map = split the root's children into a left and right set, run the tidy-tree layout on each half, mirror the left half. Balance by total subtree height (sum of subtree extents) rather than child count, using a greedy or partition pass. This is the common approach, but I found no primary source, so treat it as **(proposed)**.
- Because node sizes vary (pictures), use the van der Ploeg / flextree family and not fixed-size Walker variants. Set each node's `size` to its representation's bounding box. For a picture node that is the image bounds plus caption plus padding.
- Radial/balloon: map flextree's (depth, breadth) onto (radius, angle) with angular wedge widths proportional to subtree leaf weight. This is the d3 "abstract coordinates" idea. Wide picture nodes need a radius per ring chosen from the largest node on that ring. **(proposed)**
- ELK mrtree and radial are useful as reference or fallback implementations (JVM/JS-compiled) but are probably heavier than a purpose-built layout for a pure tree.

### Gaps
- I could not fetch the full text of Walker (1990) and Buchheim (2002) in this session, or documentation of yFiles' organic/mind-map layouts, dagre, or how Xmind and MindNode do "free" layouts. No primary source on the internals of Xmind/MindNode layout was found.
- No source was found on balancing left and right sides in published literature.

---

## 2. Organic, Buzan-style layout (curved fan-out branches, hand-made look)

### Takeaway
I found no published algorithm or open-source implementation specifically for Buzan/iMindMap-style organic layout. What exists is general machinery (tidy trees, force-directed refinement, jitter) that has to be combined. This is a design area to treat as **proposed**.

### Cited Findings
- rough.js produces a hand-drawn look through parameters: `roughness` (default 1; 0 is perfect; above 10 mostly useless), `bowing` (default 1; curviness of lines), and a `seed` option so the same shape is reproducible. Hachure fill defaults (angle -41 degrees, gap 4x stroke width). The wiki page does not describe the underlying algorithm. — [rough.js wiki](https://github.com/rough-stuff/rough/wiki)
- Misue, Eades, Lai, Sugiyama (1995), "Layout Adjustment and the Mental Map", J. Visual Languages and Computing 6(2):183-210, is the origin of the mental-map idea. It includes a method to remove node overlaps while preserving the user's mental map. — [paper listing](https://typeset.io/papers/layout-adjustment-and-the-mental-map-36y8o59qtx)

### Inferences (all **proposed**)
- Pipeline: (1) tidy-tree layout (flextree) gives a collision-free skeleton; (2) convert each parent-child edge to a cubic Bezier whose tangent at the parent follows the parent's incoming direction (C1 continuity for smooth fan-out); (3) bend branches using a per-node seeded random angle offset (seed stored in the document so it is stable across sessions, same idea as rough.js `seed`); (4) run a few iterations of overlap removal, using Misue-style displacement of overlapping boxes, to resolve collisions caused by curving; (5) store the result as cached positions, not as truth.
- Make "hand-made" deterministic: derive jitter from a hash of (node id, document seed), never from `Math.random()`, so layouts do not change on reload or re-layout.
- Main branches (depth 1) carry the colour. Curvature and thickness decrease with depth.

### Gaps
- No iMindMap/Buzan-specific algorithm, paper or open-source repo found. No source on contour-based subtree packing for organic maps was fetched.

---

## 3. Incremental, stable layout and performance

### Takeaway
Preserving the user's mental map is a well-established requirement (Misue et al. 1995). The practical approach is to keep a cached position per node, re-layout only the changed subtree, and animate between old and new positions. Linear-time layouts make 10,000+ nodes feasible. Running layout in a worker is standard engineering, but I found no source specific to mind maps.

### Cited Findings
- Mental-map preservation was formalised in Misue, Eades, Lai, Sugiyama (1995) and later work, including simulated-annealing-based mental-map-preserving drawing. — [paper listing](https://typeset.io/papers/layout-adjustment-and-the-mental-map-36y8o59qtx); [NYCU PDF on mental-map-preserving drawing](https://ir.lib.nycu.edu.tw/bitstream/11536/19026/1/000293304600012.pdf)
- van der Ploeg's algorithm and flextree are O(n), so a full re-layout of a 10,000-node tree is a linear pass. — [d3-flextree](https://github.com/Klortho/d3-flextree); [van der Ploeg](https://core.ac.uk/download/301654972.pdf)

### Inferences
- Layout stability **(proposed)**: when a node is collapsed or expanded, keep the clicked node's screen position fixed (anchor it) and translate the rest of the layout relative to it. Siblings and subtrees move only as far as the tree layout forces. Pinned (manually placed) nodes are stored as offsets relative to their parent's auto-layout position, so they move with the parent but stay put relative to it.
- Tween old to new positions over about 200-300 ms with per-node easing. Do layout in a worker (or a separate thread natively) over a compact structure-of-arrays tree, and post positions back.
- Because pictures have different sizes, always lay out with the final (or reserved placeholder) size so that image arrival does not shift the layout. Reserve the box from the declared aspect ratio before the asset arrives.

### Gaps
- No source on animation timing, nor benchmark of flextree at 10,000+ nodes. Not measured here.

---

## 4. Laying out image subtrees and SVG-artwork subtrees

### Takeaway
No prior art exists for mixing generated art subtrees into a tree layout. The design below is **proposed**. Recommended option: treat every node as a box with declared in/out anchors, whichever representation it uses, and give an SVG subtree the same per-node boxes but a shared artwork frame ("island") so the artwork can be generated against already-computed positions.

### Cited Findings
- d3-flextree takes per-node width/height and a spacing function, which is what is needed to reserve space for picture nodes. — [d3-flextree](https://github.com/Klortho/d3-flextree)

### Inferences (all **proposed**)
Options and recommendation:
1. **Per-node pieces placed by the normal layout engine.** Most flexible, because collapse, drag, pinning and animation all work unchanged. Risk: pieces may not read as one coherent artwork.
2. **One island bounding box with anchors per node.** Coherent artwork, but the island is rigid: collapsing a child cannot reclaim space, and the island must be regenerated for any structural change.
3. **Artwork conditioned on already-computed node positions** (layout first, then ask the model to draw into the given boxes). This keeps the layout engine authoritative and gives coherent art. It is the recommended default for SVG mode: pass the model a list of `{id, x, y, w, h, anchorIn, anchorOut}` and require output groups in those boxes.
- Fallback: if the generated SVG ignores the boxes, scale-to-fit each `<g id="node-...">` into its reserved box using its measured bbox.
- Raster mode: use option 1. Each image is a node with reserved aspect-ratio-correct box; the caption and branch label are drawn by the engine.
- Space reservation uses the representation's box in layout; switching representation changes the box and triggers an incremental re-layout of that subtree only.

### Gaps
- No prior-art papers or products found for this exact problem.

---

## 5. Rendering tapered curved branches

### Takeaway
Use variable-width stroking by generating a closed filled outline (two offset curves plus caps). For quality at scale, Levien and Uguray's Euler-spiral approach (HPG 2024) is the state of the art for GPU stroke expansion. For a simpler engine, perfect-freehand-style polygon outlines (pressure to width) are enough for tapered branches, and rough.js-style jitter gives the hand-drawn look.

### Cited Findings
- "GPU-friendly Stroke Expansion", Raph Levien and Arman Uguray, HPG 2024 (Best Paper, 3rd place), also in PACM CGIT 7(3), DOI 10.1145/3675390; arXiv 2405.00127. Cubic Beziers are approximated by Euler spiral segments, offset curves are lowered to lines or circular arcs, avoiding recursion and minimising divergence. It introduces a new error metric and an encoding that reduces CPU precomputation. It builds on Nehab (2020). Listed limitations: load balancing is imperfect; dashing may fit prefix-sum approaches. — [arXiv abstract](https://arxiv.org/abs/2405.00127); [paper page](https://linebender.org/gpu-stroke-expansion-paper/)
- perfect-freehand: input points (optionally with pressure) produce a closed polygon outline. Options: `size`, `thinning` (pressure-to-width), `smoothing`, `streamline`, and `start`/`end` `taper` with easing and caps. Self-crossings remain unless flattened with `polygon-clipping`. Lower-level `getStrokePoints` and `getStrokeOutlinePoints` are exposed. — [perfect-freehand README](https://github.com/steveruizok/perfect-freehand)
- rough.js provides seeded roughness and bowing. — [rough.js wiki](https://github.com/rough-stuff/rough/wiki)
- Vello (Linebender) now contains three renderers: the compute-centric original (experimental, needs compute-capable GPU), Vello GPU and Vello CPU (both Sparse Strips; GPU one has WebGL2 and wgpu backends; CPU one is the most mature). — [Vello repo](https://github.com/linebender/vello)

### Inferences
- **(proposed)** Branch geometry: a branch is a cubic Bezier centreline plus a width function w(t) going from thick at the parent to thin at the child end, with width at the start matched to the parent's width at the attach point so child branches emerge seamlessly. Build the outline by sampling the centreline, offsetting by w(t)/2 along the normal, and emitting a closed polygon (as perfect-freehand does). Child branches should start slightly inside the parent's outline and be drawn before the parent, or union-merged, to hide the join.
- Since a mind map has thousands of branches rather than millions of strokes, CPU tessellation, cached per branch and rebuilt only when geometry changes, is likely enough. Euler-spiral GPU expansion matters only if stroking must happen on the GPU every frame.
- Triangle strips are cheaper to render; a filled closed outline is easier to give textures, outlines and rough edges. Pick filled outlines with an optional second pass for texture.

### Gaps
- I did not fetch Levien's blog posts, kurbo docs or Skia/Inkscape power-stroke documentation (the blog URL I tried returned 404). No source on brush/watercolour texturing was fetched.

---

## 6. Text on curved paths and text rendering

### Takeaway
Glyph-by-glyph placement along the branch curve, with a curvature limit and flip-if-upside-down rule, is standard. For rendering, either MSDF atlases or Slug-style direct outline rendering give crisp text at any zoom. Slug's patent was dedicated to the public domain in March 2026, which removes the licensing barrier.

### Cited Findings
- Slug: Eric Lengyel's 2017 JCGT paper "GPU-Centered Font Rendering Directly from Glyph Outlines" renders text from Bezier outlines with no atlas. Lengyel dedicated the patent (US 10,373,352) to the public domain effective March 17, 2026. — [terathon blog "A Decade of Slug"](https://terathon.com/blog/decade-slug.html); [JCGT paper](https://jcgt.org/published/0006/02/02/paper.pdf); [Hackaday summary](https://hackaday.com/2026/03/20/slug-algorithm-for-on-gpu-rendering-of-fonts-with-bezier-curves-now-in-public-domain)
- A claim that Microsoft's Loop-Blinn patent expires March 25, 2026 is from an unverified commenter quoted in a blog. — [blog](https://mathewsachin.github.io/blog/2026/03/18/decade-of-slug.html) (unverified)
- msdfgen (Chlumsky): multi-channel signed distance fields reproduce sharp corners almost perfectly by using three channels; the shader takes the median. Modes: sdf, psdf, msdf, mtsdf (true SDF in alpha). The README warns channel values must be read as linear, and `screenPxRange()` must never be below 1 (below 2 likely breaks anti-aliasing). The thesis is linked from the README. — [msdfgen](https://github.com/Chlumsky/msdfgen)
- resvg does not use system text rendering. — [resvg](https://github.com/linebender/resvg)

### Inferences
- **(proposed)** Text on branch: shape the string with a shaper (HarfBuzz) to get glyph advances, then place each glyph at arclength s along the centreline, rotated to the tangent, offset to the branch edge or centre. Constraints: reject or shorten labels if the curvature radius is below a threshold relative to font size; if the tangent points left-to-right-downward past 90 degrees, reverse the path direction so text is never upside down; fall back to a horizontal label next to the branch when the branch is too short or too curved. Keep the keyword text as engine-rendered text, never baked into a generated image.
- MSDF atlas has per-glyph quads, simple to instance and rotate individually, which suits per-glyph path placement. Slug is better for very large zoom ranges and no atlas, but needs per-glyph curve buffers. For a first version, MSDF is simpler.
- Note that this is native-GPU or WebGL/WebGPU only; a pure DOM/SVG path would use `<textPath>`, which I did not research.

### Gaps
- No source fetched on SVG `textPath` behaviour, HarfBuzz, or glyph caching.

---

## 7. Infinite canvas performance

### Takeaway
Industry practice (Figma and others) is a custom renderer, now moving to WebGPU. The key general techniques are camera transform with local origins, spatial index culling, LOD, tile or texture caching, and frame budgeting. My sources here are thin; most details are background knowledge.

### Cited Findings
- Figma published "Figma Rendering: Powered by WebGPU". Its engine had an interface layer between rendering code and low-level graphics API that mapped closely to WebGL. Secondary summaries say the migration took about a year, shaders moved from GLSL to WGSL, and a mid-session WebGPU-to-WebGL fallback was built. The renderer is C++ compiled to WebAssembly (and native for server-side rendering). — [Figma blog](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/); secondary summary: [sysdesign-wiki](https://sysdesign-wiki.pages.dev/sources/2026-04-21-figma-rendering-powered-by-webgpu/)
- I found no primary source confirming Figma's tile-based rendering in the WebGPU post. A tutorial claims a tile-based engine in C++/WASM. — [awesome.ecosyste.ms entry](https://awesome.ecosyste.ms/projects/github.com%2Fantvis%2Finfinite-canvas-tutorial) (secondary)
- ThorVG offers a retained scene graph, SW (SIMD), GL/ES, WebGL and WebGPU backends, and "smart partial rendering that redraws only changed regions". — [ThorVG](https://github.com/ThorVG/thorvg)

### Inferences (background-informed, **proposed** as design)
- Use double-precision camera state (pan, zoom) and store node positions as doubles or as local offsets relative to a parent or island origin; convert to float32 relative to the camera at draw time to avoid jitter at extreme zoom.
- Zoom-to-cursor: keep the world point under the cursor fixed, so `pan' = cursor - (cursor - pan) * (zoom'/zoom)`.
- Spatial index: a static R-tree/BVH or uniform grid over node bounds, rebuilt incrementally on layout change, for culling and hit-testing. Hit-testing branches needs the outline polygon, not just bounds.
- Semantic zoom: below a screen-size threshold replace text with greeked bars, images with a low mip or dominant colour, and collapse deep subtrees. Cache static content to tiles or a texture and re-render only dirty regions.
- Target 8.3 ms per frame for 120 Hz: do culling and draw-list building on CPU in under 2-3 ms, and keep decoding and layout off the render thread.

### Gaps
- Not fetched: tldraw, Excalidraw, Miro, Zed GPUI, Google Maps vector tile, Vello talks, Flutter Impeller write-ups. No benchmarks gathered. Tile-cache design is not backed by a source here.

---

## 8. Raster images at scale

### Takeaway
Store source PNG/WebP with alpha, generate a thumbnail pyramid, decode off-thread, and show ThumbHash placeholders first. For GPU memory, transcode KTX2/Basis UASTC to BC7 or ASTC.

### Cited Findings
- ThumbHash is a compact inline placeholder that encodes more detail than BlurHash in the same space, includes aspect ratio and more accurate colour, and supports images with alpha. Parameters are not configurable. — [thumbhash](https://github.com/evanw/thumbhash)
- Basis Universal / KTX2: transcoding UASTC LDR to ASTC LDR and BC7 is fast and simple, as UASTC LDR is a common subset. KTX2 supports Zstandard supercompression, used by default for UASTC textures. — [Basis Universal mirror README/notes](https://skia.googlesource.com/external/github.com/BinomialLLC/basis_universal/+/refs/tags/v2_0); [Vulkan sample docs](https://docs.vulkan.org/samples/latest/samples/performance/texture_compression_basisu/README.html)
- OpenAI image models support a `background` parameter with `transparent` or `opaque`, requiring png or webp output. For gpt-image-2 this support is in preview per the OpenAI CLI reference. Third-party posts report a model recommendation to avoid describing the background in the prompt. A community post reported gpt-image-1 sometimes not returning transparency. — [OpenAI API reference](https://developers.openai.com/api/reference/cli/resources/images/methods/generate); [community report](https://community.openai.com/t/how-to-output-a-background-transparent-image-using-the-edit-or-generate-interface/1349936)

### Inferences
- Use premultiplied alpha in all GPU blending, so soft edges from generated cut-outs do not show halos. Compress to BC7/ASTC only for large maps; GPU-compressed formats have a quality cost for generated art.
- Evict with an LRU policy by screen-space need. Keep mip levels or thumbnails resident, and load the full resolution only when the node is large on screen.
- Format choice (PNG vs WebP vs AVIF vs JPEG XL) was not researched; lossless WebP or PNG for alpha cut-outs is the conservative choice.

### Gaps
- No sources on AVIF, JPEG XL, texture atlases vs texture arrays, or LRU budgets.

---

## 9. SVG at scale and sanitising LLM-generated SVG

### Takeaway
Choose a renderer that matches the SVG subset you allow. resvg is a strict, static, memory-safe option; ThorVG is lightweight and has GPU backends but targets SVG Tiny; Vello is a vector GPU renderer. Always sanitise and restrict generated SVG.

### Cited Findings
- resvg: static SVG subset only. It excludes `a`, `script`, `view`, `cursor` elements, events and animations. It is memory-safe Rust with checks against infinite loops and stack overflow via recursion. It renders using tiny-skia, aiming for pixel-identical output across platforms. usvg handles parsing and preprocessing, so you can render the simplified tree with another backend. No native text rendering. SVG 2 support is in progress. — [resvg](https://github.com/linebender/resvg)
- ThorVG: SVG Tiny target, no animation/interactivity support; CPU SIMD, GL, WebGL, WebGPU backends; masking, blending, gradients, blur and drop-shadow effects; about 170 KB core. Performance figures are from the project's own benchmarks. — [ThorVG](https://github.com/ThorVG/thorvg)
- Vello: see section 5. — [Vello](https://github.com/linebender/vello)
- DOMPurify permits HTML, SVG and MathML by default; `USE_PROFILES: {svg: true, svgFilters: true}` restricts to SVG. It strips event handlers such as `onload`. The README does not state default foreignObject handling (it shows a hook to remove it). — [DOMPurify](https://github.com/cure53/DOMPurify)
- LLM SVG research: LLM4SVG (2412.11102), OmniSVG (2504.06263), SVGThinker (2509.24299), Reason-SVG (2505.24499), LayerTracer (2502.01105), NeuralSVG (2501.03992) address generating layered/structured SVG. None of the snippets I saw describe a "node-id contract" like the one proposed here. — [LLM4SVG](https://arxiv.org/pdf/2412.11102v2); [OmniSVG](https://arxiv.org/pdf/2504.06263); [SVGThinker](https://arxiv.org/abs/2509.24299v1); [Reason-SVG](https://arxiv.org/html/2505.24499); [LayerTracer](https://arxiv.org/abs/2502.01105v3); [NeuralSVG](https://arxiv.org/html/2501.03992v1)

### Inferences (**proposed**)
- Allowed SVG subset: `svg, g, path, rect, circle, ellipse, line, polyline, polygon, defs, linearGradient, radialGradient, stop, clipPath, mask, title, desc`, plus `transform`, fill, stroke, opacity. Disallow `script`, `foreignObject`, `image` with external href, `use` with external href, `style` with `@import`, event attributes, animation elements. Avoid filters (costly, uneven support across renderers) or whitelist `feGaussianBlur` and `feDropShadow` only. Convert text to paths or reject `<text>` (resvg has no system text) and render keywords with the engine.
- Pipeline: parse with usvg (or any strict parser), validate against the allowlist, normalise to a simplified tree (flatten transforms, resolve `use`), and enforce the node contract (below). Cache a rasterised texture per zoom bucket for distant views, and render live vector paths when zoomed in. Re-rasterise on bucket change, in a worker.

### Gaps
- No benchmarks on re-rasterisation cost. Skia SVG module, lunasvg/plutovg, NanoSVG, librsvg were not researched. Whether a Vello-based SVG crate is maintained was not verified.

---

## 10. Hybrid subtree design: seamless connection, collapse, fallbacks

### Takeaway
No prior art was found for hybrid raster/SVG subtrees in a mind map. The robust design is to make the tree the single source of truth, and make representation a per-subtree "view" with a declared contract (box plus anchors) so the engine always owns branches, text, collapse and hit-testing.

### Cited Findings
- OpenAI's `background: transparent` gives cut-out images for compositing (see section 8). — [OpenAI reference](https://developers.openai.com/api/reference/cli/resources/images/methods/generate)
- markmap supports per-node folding and a default fold level. — [markmap](https://github.com/markmap/markmap)
- JSON Canvas edges attach to a node's `top/right/bottom/left` side, a coarse version of the anchor idea. — [JSON Canvas spec](https://jsoncanvas.org/spec/1.0/)

### Inferences (all **proposed**)
- **Connection options, ranked:** (a) Engine draws the branch to the node's declared in-anchor, drawn under the image with the image's soft alpha edge covering the join; this works with any generated image. (b) Declared anchors per image (normalised coordinates), set by the engine in a post-step (for instance by detecting the subject's mask and choosing the nearest edge point) and stored in the document. (c) Branch style matched to the art (colour sampled from the style sheet) so stems are consistent. (d) Generating the connector inside the art is the least reliable, so avoid it.
- **SVG contract:** each node is `<g id="node-<id>" data-anchor-in="x,y" data-anchor-out="x,y" data-bbox="x,y,w,h">`; the root also declares the attach anchor. Engine hides groups to collapse, hit-tests via the group's bbox or geometry, animates via transforms, and draws the parent branch to the root anchor. Validate on import; repair by scaling to the reserved box or fall back to the vector representation for nodes whose groups are missing.
- **Collapse:** hide descendants, show a count badge, animate children towards the parent anchor and fade; image nodes of descendants stay cached.
- **Source of truth:** every node keeps its text, notes and ids in the tree; image and SVG are cached, regenerable assets referenced from the node (keyed by prompt+style hash). Reverting to vector view is a flag change.
- **Partial regeneration:** a text edit invalidates only that node's asset; in SVG mode, regenerate just that node's group (with neighbours as context) and splice it in.
- **Placeholders and failure:** show a ThumbHash or flat-colour placeholder and the vector node while generating; on failure keep the vector node and mark the node "generation failed, retry".

### Gaps
- No sources found for "structured SVG contracts for LLM output" beyond the layered-SVG research listed in section 9, or for collapsible or animated generated diagrams.

---

## 11. Style consistency and generation pipeline

### Takeaway
Use a shared style sheet object plus a style-reference image generated first and used to condition every node. Background removal and vectorisation are well-served by open tools.

### Cited Findings
- vtracer converts raster to SVG, handles colour (`color-cluster`, `bw`, `watershed` modes; palette and colour-precision controls), skips Potrace's expensive optimal-polygon search for a faster linear pipeline, and is MIT-licensed with CLI, Rust, Python and WebAssembly bindings. — [vtracer](https://github.com/visioncortex/vtracer)
- Transparent PNG/WebP output is supported by some image models (section 8). — [OpenAI reference](https://developers.openai.com/api/reference/cli/resources/images/methods/generate)

### Inferences (**proposed**)
- Style sheet fields: palette (hex list), medium (watercolour, ink, flat vector, clay 3D), line weight, mood, reference-image asset id, negative prompts, seed. Stored per subtree with inheritance from the map's theme.
- Steps: generate the reference image, then each node image with the reference attached as an image input and the style sheet text. Optionally generate several nodes in one sheet and slice them, then run background removal. Tools such as rembg, BiRefNet or Apple Vision foreground masks exist but I did not verify details here.
- Bridge to SVG: vtracer on a flat-style raster gives an SVG that can then be given the node-group contract by the engine, which is more reliable than asking an LLM to draw free-hand.

### Gaps
- I did not research rembg, BiRefNet, Apple Vision foreground masks, upscalers, sprite-sheet slicing quality, or style-reference conditioning APIs.

---

## 12. Mnemonic image prompts and keyword legibility

### Takeaway
Rendering the keyword in the engine, not the image, is a firm design recommendation. No source on the mnemonic image literature was fetched.

### Cited Findings
- No cited findings. I did not fetch anything on Sketchy, Picmonic or memory palaces.

### Inferences (**proposed**, from general principles)
- Prompt template: one concrete, distinctive, exaggerated object per concept, interacting with a neighbour concept when sensible, simple background (or transparent), and no text in the image. Add "no text, no letters" to the prompt, because models still make text errors. Render the keyword as an engine caption or along the branch.

### Gaps
- No evidence gathered on mnemonic efficacy or prompt patterns.

---

## 13. Data model, undo, CRDT

### Takeaway
Use a tree of nodes with stable ids, with representation, style and layout overrides as per-node fields, plus separate cross-link edges. For future collaboration, Loro's movable tree CRDT is the closest prior art for the tree part.

### Cited Findings
- Loro provides a movable tree CRDT based on Kleppmann et al., "A highly-available move operation for replicated trees". Each node has a unique TreeID and an associated Map container for its data; Loro generates a fractional index to order siblings, and prevents cycles after merging concurrent moves. API includes `create`, `mov`, `mov_to`. — [Loro tree tutorial](https://www.loro.dev/docs/tutorial/tree); [Loro blog "Movable tree CRDTs"](https://loro.dev/blog/movable-tree); [docs.rs](https://docs.rs/loro)
- SQLite triggers can maintain an undo/redo stack in the database, so undo survives sessions. — [sqlite.org appfileformat](https://www.sqlite.org/appfileformat.html)

### Inferences
- **(proposed)** Node fields: `id` (UUIDv7/ULID), `parent`, `order` (fractional index), `text`, `note`, `collapsed`, `representation` ∈ {vector, raster, svg}, `assetRef`, `styleRef`, `layout: {pin?: {dx, dy}, side?, seed}`. Separate collections for cross-links (`edges`), floating nodes (nodes with no parent plus an absolute position), multiple roots, styles and assets.
- Undo/redo: a command log (operations with inverses) is simplest for a single-user app and maps well onto an operation-log CRDT later. I did not research Automerge or Yjs/Yrs details in this session.

### Gaps
- Automerge and Yjs/Yrs tree support and relative performance not researched.

---

## 14. File format and import/export

### Takeaway
SQLite as the application file format is a strong fit (atomic, incremental, queryable, single file, blobs for assets). Offer a zip/folder export, and plain-text exports for interchange.

### Cited Findings
- sqlite.org's appfileformat page lists: single-file documents with an Application ID; transactional atomic writes; incremental updates (only changed pages written); crash-safe continuous saves; extensible schema; fast access to just the data needed; BLOBs under about 100 KB can be faster than separate files; concurrent readers; cross-platform portability; backward compatible since 2004. It cautions that users can still be tricked into opening a malicious database. — [SQLite appfileformat](https://www.sqlite.org/appfileformat.html)
- `.xmind` is a ZIP containing a JSON content document (older XMind 8 files use `content.xml`), a thumbnail, and attachment directories; community tools also reference `metadata.json` and `manifest.json`. No authoritative official content.json schema was found. — [XMind overview](https://en.wikipedia.org/wiki/XMind); [xmind-sdk-js](https://github.com/xmindltd/xmind-sdk-js); [xmind npm](https://www.npmjs.com/package/xmind-sdk)
- JSON Canvas 1.0: top-level `nodes` and `edges`; node types text, file, link, group; common fields `id,type,x,y,width,height,color`; edges have `fromNode,toNode,fromSide,toSide,fromEnd,toEnd,color,label`; node order is z-order. — [JSON Canvas spec](https://jsoncanvas.org/spec/1.0/)
- Markmap uses Markdown as input, with YAML frontmatter options. — [markmap](https://github.com/markmap/markmap)

### Inferences (**proposed**)
- **Primary format:** a single SQLite file (`.mmap`) with tables `nodes`, `edges`, `styles`, `assets`, `meta`, `ops` (command log). Assets stored in a content-addressed table `assets(hash PRIMARY KEY, mime, bytes, width, height, thumbhash, gen_json)`, where `gen_json` holds prompt, model, seed, style-sheet snapshot and parent asset for reproducibility. SVG assets stored as text after sanitising, with the validated contract recorded.
- Export: zip bundle (JSON + `assets/<hash>.png`) for sharing, Markdown outline, OPML, FreeMind `.mm`, Xmind, JSON Canvas, Mermaid mindmap. Whole-map SVG export: inline SVG nodes directly and embed raster nodes as `<image href="data:...">` with clip paths. PDF export: render the vector layer as paths and place rasters as images at native resolution.
- Concern: SQLite files are opaque to diff and sync tools. Include a periodic "export to bundle" for version control.

### Gaps
- FreeMind `.mm`, OPML, MindNode and Mermaid mindmap formats not researched. PDF export tooling not researched.

---

## 15. Proposed engine architecture (all **proposed**)

Layers:
1. **Document layer:** tree + edges + styles + assets, a command log for undo, and optional later CRDT sync (Loro tree).
2. **Representation layer:** per-subtree "view resolver" chooses vector, raster or SVG. Provides each node's box, in/out anchors and caption from cached assets or defaults.
3. **Layout layer (worker):** flextree-style tidy layout over node boxes, two-sided balancing, seeded organic curve pass, overlap removal, cached positions, pins as parent-relative offsets. Emits positions and branch geometry.
4. **Geometry layer:** branch outlines (variable-width polygons), glyph placement along curves, spatial index.
5. **Renderer:** culls via the index, builds draw lists (branches, text via MSDF/Slug, raster quads, SVG textures or paths), with LOD and tile or texture caching; uses premultiplied alpha.
6. **Asset layer:** decode and transcode workers, thumbnail pyramid, ThumbHash placeholders, LRU cache.
7. **Generation layer:** style sheet, reference image, per-node jobs, background removal, optional vtracer, SVG validation and contract repair, regeneration queue.
8. **IO layer:** SQLite store, bundle export, import and export adapters.

Key invariants: the tree is always the truth; assets are caches; the engine always draws branches, labels and handles; every representation can fall back to vector.

## Overall gaps for the report writer
Not researched or not sourced: Walker 1990 and Buchheim 2002 full texts; yFiles, dagre, Xmind/MindNode layout internals; iMindMap-like algorithms (none found); Levien's blog and kurbo; Skia/Inkscape power stroke; tldraw/Excalidraw/Miro/Zed/Maps/Impeller write-ups; SVG textPath and HarfBuzz; AVIF/JPEG XL; rembg/BiRefNet; Sketchy/Picmonic; Automerge/Yjs; FreeMind/OPML/Mermaid specs.
