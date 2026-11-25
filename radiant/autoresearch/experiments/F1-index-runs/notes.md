# F1: draw visible branch runs from the resident index buffer; no culling walk when the whole map is in view

Commit 270ddf3 (parent 9992500, baseline). Verdict: **keep**.

## Hypothesis
`visibleMesh()` copied the indices of every visible branch into a new array and re-uploaded it with `bufferData` every frame (MBs per frame at 50k), and every viewport query walked the grid and sorted its result even when everything was in view (study 02: ~1 ms branch culling + 1.1 to 2.2 ms viewport queries at the 50k whole-map view). Drawing the visible runs straight from the static index buffer, and returning "all items" without a walk when the query rectangle contains every box, should cut whole-map script per frame to a fraction and remove the per-frame index upload everywhere. Metrics expected to move: `pan_cpu_mean`/`pan_cpu_p95` at 20k and 50k (mostly the fit position), `pan_cpu_mean@*/fit`; `gpu_buffer_mb` slightly down (no culled index buffer). No change to pixels.

## What changed
- `src/lib/core/geometry/grid.ts` `GridIndex`: keeps the extent of all current boxes (min/max over both corners, recomputed in `build` and `update`); `query` returns a cached identity array 0..n-1 when the query rectangle contains that extent. Benefits the rect, label and image queries of `SceneViewport` and the branch index alike. Results are the same ascending indices as before.
- `src/lib/render/renderer.ts`: `visibleMesh` now records runs (byte offset, count) of the resident index buffer instead of copying indices; runs closer than `RUN_GAP` = 1536 indices are merged (the culled spans in between lie outside the view, so they add no pixels). `drawRuns` draws them with `WEBGL_multi_draw` (`multiDrawElementsWEBGL`, present in Chrome, Playwright WebKit and WKWebView per study 02) or a `drawElements` loop as fallback. The shadow layer draws the same runs. `culledIbo`/`culledIndices` and the per-frame `bufferData` are gone.

## Numbers
Probe (method below), 50k nodes after F1 (script mean ms / GPU median ms):

| theme | fit | zoom 0.35 | zoom 1 |
|---|---|---|---|
| clean | 0.60 / 1.67 | 0.55 / 3.39 (16.4 runs) | 0.21 / 3.77 (8.4 runs) |
| rope | 0.33 / 2.41 | 0.32 / 3.18 (17.4 runs) | 0.19 / 4.40 (8.5 runs) |

For comparison, study 02 (same machine, same method family) measured the renderer script at the 50k whole-map view at 2.48 ms (clean) and 2.44 ms (rope) before this change. Runs per frame are small (4 to 90 across themes and zooms), so one multi-draw replaces the copy + upload cheaply.

Official A/B by the lead (full benchmark, 3 rounds, both engines, 9992500 vs 270ddf3; `radiant/autoresearch/official/F1-270ddf3.json` in the main tree), medians A -> B (ratio):
- Chrome: score 69.31 -> 58.23 (0.84); frame 2.10 -> 1.23 (0.58); dimensional 10.81 -> 8.27 (0.76); rebuild 392 -> 396 (1.01); interaction 404 -> 407 (1.01). pan_cpu_mean@50k/clean/fit 3.47 -> 0.94 (0.27), @50k/rope/fit 4.10 -> 0.92 (0.22), @50k/soft-clay/fit 5.55 -> 1.97 (0.35); pan_gpu_mean@50k/clean 3.02 -> 2.02 (0.67).
- WebKit: score 69.28 -> 63.13 (0.91); frame 1.53 -> 1.08 (0.71); dimensional 22.2 -> 19.9 (0.90); rebuild 489 -> 509 (1.04); interaction 446 -> 457 (1.02). pan_cpu_mean@50k/clean/fit 1.92 -> 0.75 (0.39), @50k/soft-clay/fit 3.39 -> 2.15 (0.64).
- The 1 to 4 % rebuild/interaction rises are within the README's noise band (sd 2 to 5 %); nothing in F1 runs on the rebuild path except one O(n) extent pass per grid build/update.

My own screening run: not done. My `--quick` A/B was queued behind other runs and was killed when the owner paused all work; per the lead's instruction after the restart I did not re-run it (the lead is measuring this commit officially by sha).

Probe method (all "probe" numbers below): `/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/probe.py`, headless Chrome (Metal ANGLE), DPR 2, 1728 x 1117, against my own Vite dev server on port 1431 serving the worktree at that point; `?demo=big&n=50000`; per theme three camera positions (fit, densest view at zoom 0.35, densest at zoom 1); 30 warm-up + 60 measured frames each, camera on a circle; script = performance.now() around `renderer.render()` (the dev page is not cross-origin isolated, so the clock has 0.1 ms resolution: means are usable, medians are not), GPU = median EXT_disjoint_timer_query time per frame. One run each, other agents active on the machine: treat any single number as +-30 % for GPU. The probe output was printed, not saved; the values are copied here from the session log.

## Visual guard
`visual.py` 9992500 vs 270ddf3: Chrome 18/18 scenes 0.0000 % over threshold, max 0, any 0.000 % (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F1/visual.json`); WebKit 18/18 identical, max 0, any 0 (`/private/tmp/claude-501/-Users-parth-projects-general-mind-maps/58425155-0c4a-49c7-bc98-b2e0f4d9fe14/scratchpad/ar/frame/visual-F1-webkit/visual.json`).

## Surprises
- The identity shortcut in `GridIndex` also removes the label and rect grid walks (which the study counted separately), so the whole-map renderer script drops more than the branch culling alone.
- Lifted-arcs at zoom 1 produced 90 runs per frame (the other themes 4 to 17); still one call with multi-draw.

## Risks / notes
- `grid.ts` is in core and shared with picking (`pickBranch` queries a point, never the identity path in practice).
- `stats.meshTriangles` counts the visible spans' triangles, not the merged-gap triangles actually submitted.
