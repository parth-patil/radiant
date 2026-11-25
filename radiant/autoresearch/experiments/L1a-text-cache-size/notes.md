# L1a: size the text-layout cache to the map

## Hypothesis
`layoutLabel` (render/text.ts) cleared its whole cache once it passed 30,000 entries. A 50,000-node map has 50,000
distinct labels, so every pass that measures them (load, theme switch) cleared the cache part-way and the next pass
missed on every label: about 170 ms of `measureText` per pass at 50k (study 01, E7). Sizing the cache to the map
should make a switch back to an already-measured font nearly free. Metrics expected to move: `rebuild_ms@50k/clean`
(the quick run's clean switch comes after rope, so the clean labels were measured at load). `rebuild_ms@50k/rope` should
not move (first use of the dimensional themes' font, Avenir Next: cold either way), nor anything at 5k (under the old limit).

## Change
- `src/lib/render/text.ts`: the cache is now a two-level map (font + wrap width, then the label text itself), so a
  lookup builds one short key instead of a key containing the text; a size counter replaces `Map.size`; the limit is
  `max(30000, 3 x nodes)` through a new `reserveLayoutCache(labels)` (only grows). When the limit is reached the cache is
  still cleared wholesale, as before. Three fonts' worth because a theme switch and back needs two (clean uses system-ui,
  the dimensional themes Avenir Next) and depth/bold variants are part of the font key.
- `src/lib/ui/layout.worker.ts`: calls `reserveLayoutCache(Object.keys(work.doc.nodes).length)` before each pass (the worker
  is where all big-map measuring happens; the main thread only measures maps under 1,000 nodes or labels it rasterises).

## Targeted probe (stage harness, `scratchpad/ar/labels/micro.js`, adapted from study 01; one run each, machine busy)
50,000 nodes, clean, `Pipeline.computeWork` stage times, ms:

| pass | engine | before: measure / computeSizes | after: measure / computeSizes |
|---|---|---|---|
| theme switch back (clean, font seen before) | Chrome | 174 / 225 | 31 / 160 |
| theme switch back | WebKit | (161 in study 01) | 115 / 300 (noisy run) |
| theme switch away (rope, new font) | Chrome | 137 / 208 | 286 / 386 (noise: same work as before) |

The "measure" column includes the wrapper's own overhead for 50,000 calls. A clean page micro (`mem.js`, Chrome):
50,000 distinct labels measured cold 155 ms, warm 7.4 ms; memory 243 bytes per cached layout (12 MB per 50,000 labels
per font). So the worker holds up to about 24 MB more at 50k after a theme switch and back (36 MB at most for three fonts);
the main thread is unaffected in practice (it only measures labels it rasterises). Worker heap is not in the benchmark.

## Screening (quick, 1 round, parent = pinned baseline 9992500; raw JSON: quick.json)
| metric | Chrome A -> B | ratio | WebKit A -> B | ratio |
|---|---|---|---|---|
| rebuild_ms@50k/clean | 1123 -> 995 | 0.886 ?faster | 1338 -> 1068 | 0.798 ?faster |
| rebuild_ms@50k/rope | 1280 -> 1192 | 0.932 ~ | 1258 -> 1305 | 1.037 ~ |
| load_ms@50k | 1017 -> 1001 | 0.984 ~ | 1015 -> 1020 | 1.005 ~ |
| REBUILD sub-score | 385.9 -> 371.2 | 0.962 ~ | 423.6 -> 400.7 | 0.946 ~ |
| SCORE | 61.89 -> 60.90 | 0.984 ~ | 59.37 -> 58.82 | 0.991 ~ |

Everything else within noise (single round). The saving on the clean switch (128 ms Chrome, 270 ms WebKit) matches the
measure time removed (about 140 to 170 ms per pass); WebKit's larger drop is one round and probably partly noise.

## Visual guard
`visual.py` Chrome, 18 scenes: 0 differing pixels, max difference 0 in every scene (`scratchpad/ar/labels/visual-L1a`).
Layout results are identical by construction (same measuring code, only the cache changed).

## Verdict
Keep. A targeted win on theme switches and repeated passes above 30,000 labels; nothing at or under 20k. Cost: worker
memory, about 243 bytes per label per font.
