# G1: flat branches of the tapered family expanded on the GPU (instanced chunks), behind the existing CPU path

Parent: e2d9186 (merged round 1). Track: gpu. Verdict: **keep** (screening favourable on rebuild/edit/fold and memory;
a frame-cost increase on the GPU in Chrome at 50k that G2 measures in detail and must weigh).

## Hypothesis
Today every flat branch is tessellated in the worker into a ribbon (n segments chosen for zoom 4, caps, underline, dot;
about 66 vertices and 180 indices on average), packed, copied to the main thread and uploaded (98 MB of WebGL buffers at
50k clean), and all of it is redone on every relayout. If the worker sends one small record per branch instead and the
vertex shader rebuilds the same triangles, the rebuild path loses tessellation, packing, most of the transfer and the
upload, and GPU memory drops by ~90 %. Metrics that should move: `rebuild_ms`, `load_ms`, `edit_ms`, `fold_ms`
(clean only), `gpu_buffer_mb@*/clean`, `heap_mb`; risk on `pan_gpu_mean@*/clean` (vertex work per frame).

## What changed
- `src/lib/core/geometry/branch-instances.ts` (new, pure TS): `gpuBranch(spec)` (styles tapered, rounded and line, i.e.
  the specs that take tessellateBatch's tapered code path: every flag of that path is ported: h/v/r flows, startTangent,
  start cap, round caps at both ends, straight and bent underlines, tip dots, fade colours); `buildBranchInstances`
  (one 32-word record per branch: exact p0 as float32 + residual, control points/p1 relative to p0, widths, start/end
  colour as rgba8, segment and fan counts computed by the same `segmentCount`/`arcSteps` at MESH_DETAIL_ZOOM, start and
  end-cap tangents, underline, end cap, tip dot; conservative bounds from the control polygon plus half the widest
  width, caps, underline and dot); `instanceStrip` (the shader's maths in TS, for picking and for checking).
- A branch is one strip of points (left and right vertex each): ribbon, start cap (centre/arc pairs, so a fan triangle
  per quad plus an empty one), underline, end cap, tip dot, joined by two degenerate break points. The GPU draws the
  strip in chunks of 8 quads; one instance per chunk (`branch << 8 | chunk`), so the vertex work follows each branch's
  own segment count (mean 27-31 at 5k/50k, max 96: a single per-branch template would have cost ~3.5x) and one
  instanced draw keeps the CPU order of branches (order matters where branches of different colours overlap).
- `render/shaders.ts` `BRANCH_INSTANCE_VS`: reads the record (7 texelFetch from an RGBA32UI texture, 8 texels a record,
  2048 a row), finds the piece and point, evaluates the cubic, normal, taper, caps, underline, dot; same camera-relative
  precision scheme as MESH_VS (exact p0 split hi/lo against the split camera). Coarse LOD below zoom 0.02 (F4) is done
  in the shader with F4's exact rules (ribbons/underlines every 8th point, fans every 2nd, the dot's closing triangle).
- `render/renderer.ts`: `uploadInstances` (texture + two chunk lists, full and coarse, built on the main thread from
  the records: ~1 MB at 50k), `visibleChunks` (culling by the same grid over branch bounds, runs of chunks merged
  within 256 chunks), `drawChunks` (one `drawElementsInstanced` per run; WebGL 2 has no base instance, so each run
  re-points the instance attribute). Opaque meshes draw with blending off as F2.
- `core/geometry/tessellate.ts`: `BranchMeshCache.build` returns the instanced mesh when there is no relief material and
  every spec is `gpuBranch` (per mesh: a map with one organic/angular branch keeps the CPU path for all, so draw order
  never mixes two paths). `curveOf`, `segmentCount`, `arcSteps`, `CAP_STEPS` exported.
- `core/types.ts` (coordinator-owned contract): `Mesh.instances?: BranchInstances`.
- Consumers of CPU mesh data: picking (`branch-index.ts pickBranch`: candidates from the grid, then each candidate's strip
  rebuilt by `instanceStrip` and tested triangle by triangle, exact up to float32); culling spans (bounds per branch as
  before, `ends` now count chunks); `ui/layout-transport.ts shipMesh` (records and spans copied and transferred);
  `ui/layout-animation.ts staticBranchMesh` (records for the selected branches); `render/headless.ts` (triangle counts
  from chunks); `ui/pipeline.ts` (search-dim check). Exports, thumbnails and fold/presentation animation frames call
  `tessellateBranches` directly and are unchanged (CPU). The coarse far-zoom path is in the shader (above).

## Correctness
- `bun run check` 0/0, `node tools/check-boundaries.mjs` OK, `uv run tools/check-browser.py --url http://127.0.0.1:1444` all PASS.
- Geometry parity (my probe `scratchpad/ar/gpu/parity.js`, dev server): for every branch of an 800-node map in clean,
  midnight, daylight, studio, lagoon, ink, sorbet, citrus (round caps on 799 specs in 5 themes, tip dots on 570, fades,
  'line' and 'rounded'), `instanceStrip` gives exactly the same triangles as `tessellateBranches(zoom 4)` (same count,
  every vertex within 1.2e-4 world units: float32 control points), and its bounds contain the CPU bounds. Bent
  underlines (`underlineBend`) were not exercised by these themes.
- Visual guard (`visual.py`, Chrome, parent pin e2d9186 vs this tree; raw: `scratchpad/ar/gpu/visual-G1/`): 17 of 18
  scenes 0.0000 % over threshold; map60-clean light/dark zoom 2: 3 pixels each (max 62 / 54), big5k-clean-z035: 2 pixels
  (max 62): single MSAA edge samples flipping (positions differ by up to ~1e-4 world units). big5k-clean-fit: 1,619 pixels
  (0.021 %, max 186) in the 36-px trunk column x 1710-1745. Explained and checked: that is F4's coarse level of detail.
  The parent draws the guard's single fit frame with the full mesh because F4 builds its coarse buffer in timer slices
  after the first far frame and does not redraw when it is done; the GPU path takes the coarse level on the first frame.
  In my build, the same view with the coarse level forced off differs from it by 1,618 pixels (0.0210 %, max 186, x
  1710-1745: `scratchpad/ar/gpu/lodcheck.py`), i.e. full-detail GPU output equals the parent's, and the coarse output is
  F4's accepted trade-off (F4's notes: 0.025 %, same column). Crops looked at: isolated speckle pixels only.
  Not run in WebKit.

## Screening (`measure.py --quick`, chrome + webkit, 1 round, parent e2d9186 = A, G1 = B; raw `quick.json`)
Other agents were running benchmarks before and after (the lock serialised them); one round, so changes under 10 % are
unproven.

| metric | Chrome A | B | B/A | WebKit A | B | B/A |
|---|---:|---:|---:|---:|---:|---:|
| load_ms@5k | 121 | 107 | 0.88 | 120 | 108 | 0.90 |
| load_ms@50k | 807 | 734 | 0.91 | 857 | 810 | 0.95 |
| rebuild_ms@5k/clean | 119 | 87 | 0.73 | 134 | 104 | 0.78 |
| rebuild_ms@50k/clean | 795 | 719 | 0.90 | 1002 | 820 | 0.82 |
| edit_ms@5k | 86 | 84 | 0.98 | 85 | 68 | 0.79 |
| edit_ms@50k | 457 | 424 | 0.93 | 529 | 389 | 0.73 |
| fold_ms@5k | 139 | 108 | 0.78 | 117 | 102 | 0.87 |
| fold_ms@50k | 961 | 799 | 0.83 | 1021 | 798 | 0.78 |
| pan_cpu_mean@50k/clean | 0.53 | 0.63 | 1.19 | 0.85 | 0.83 | 0.97 |
| pan_cpu_p95@50k/clean | 2.81 | 3.38 | 1.20 | 2.98 | 2.52 | 0.85 |
| pan_gpu_mean@5k/clean | 0.40 | 0.45 | 1.12 | - | - | - |
| pan_gpu_mean@50k/clean | 0.96 | 1.31 | 1.36 | - | - | - |
| gpu_buffer_mb@50k/clean | 98.1 | 1.61 | 0.016 | 98.1 | 1.67 | 0.017 |
| heap_mb@50k (main thread) | 167 | 75 | 0.45 | - | - | - |
| rope metrics (control, not on the new path) | | | 0.98-1.0 rebuild | | | 1.0-1.03 rebuild |
| REBUILD | 323 | 290 | 0.90 | 351 | 319 | 0.91 |
| INTERACTION | 269 | 236 | 0.88 | 271 | 215 | 0.79 |
| FRAME | 0.81 | 0.85 | 1.05 | 0.89 | 0.82 | 0.93 |
| SCORE | 41.3 | 38.7 | 0.94 | 43.9 | 38.4 | 0.87 |

`gpu_buffer_mb` counts `bufferData` only: the record texture (128 bytes per branch, padded to 256-branch rows:
6.4 MB at 50k, 0.66 MB at 5k) is not in it. Honest GPU-memory figure at 50k clean: 98 MB -> 1.6 + 6.4 = 8.0 MB.

## What surprised me
- The per-frame cost moved to the GPU: Chrome `pan_gpu_mean@50k/clean` 0.96 -> 1.31 ms (one round). The shader does a
  cubic, a normalise, 7 texel fetches and the piece logic per vertex, and the chunk template draws ~15-20 % empty
  triangles. G2 measures this per zoom and size.
- Picking needed no CPU mesh at all: rebuilding the few candidate strips per pick is cheap.

## Verdict
Keep, pending G2's frame-cost measurement: the rebuild/interaction gains are large for flat maps (WebKit, the shipping
engine, edit@50k -27 %, fold@50k -22 %, rebuild@50k -18 %), memory drops ~90 %, picture identical up to edge samples and
F4's LOD timing; the cost is GPU time per frame.
