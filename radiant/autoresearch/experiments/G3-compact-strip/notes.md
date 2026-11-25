# G3: one continuous strip per branch (zig-zag caps joined to the ribbon), so the whole-map view stops paying for caps

Parent: 3d0f7f4 (G1). Track: gpu. Verdict: **keep**.

## Hypothesis
G2 found the GPU path's only frame-cost loss at the whole-map view (zoom < 0.02, coarse level): each branch's strip had
a 5-point fan cap, an underline and 4 break points, so a coarse branch took 2 chunks of 8 quads (3.0x F4's triangles
at 50k, 2x GPU time in Chrome). A half-disk drawn from its centre covers exactly the polygon of its arc points, and the
centre lies on the chord (a_0, a_S), which is exactly the ribbon's first (or last) left/right pair. So a cap can be a
zig-zag over its arc points, (a_k, a_S-k), that runs straight into the ribbon with no break; an underline whose first
pair is the ribbon's last continues it too. Expected: strips of n + 3 quads instead of n + 11 for a clean branch, one
chunk per coarse branch instead of two, so `pan_gpu_mean@*/fit` close to the parent's; same pixels.

## What changed
- `core/geometry/branch-instances.ts`: new strip order: start cap zig-zag from its apex, ribbon, underline (from its
  second point when JOINED: the builder checks on the CPU that the underline's first edge offset equals the ribbon's
  last one, within 1e-6 relative), end cap zig-zag out to its apex, then after two break points the tip dot as a
  zig-zag over its polygon. A non-joined underline keeps its two break points. Piece order inside a branch changes
  (cap before ribbon): no effect, one colour where pieces meet. `instanceStrip` mirrors the new layout.
- `render/shaders.ts BRANCH_INSTANCE_VS`: the same piece logic (no renderer change).

## Correctness
- `bun run check` 0/0, boundaries OK, `check-browser.py` all PASS (dev server on my worktree, port 1444).
- Coverage parity (`parity-coverage.js`, dev server, 300-node maps in clean, daylight, studio, lagoon, sorbet, ink):
  for every branch, 600 sample points (half in the bounds, half near the reference triangles) tested against the CPU
  triangles and against the strip's triangles, at full detail (`tessellateBranches(zoom 4)`) and at the coarse level
  (F4's `coarsenSpan` applied to the CPU indices): 0 mismatches away from edges (2e-3) in 179,400 samples per theme
  and level; total area equal to 6e-8 relative. JOINED held for 299/299 underlined branches in clean, daylight, studio,
  lagoon and 298/299 in sorbet (the straight 'line' style never joins: its tilted end has a notch on the CPU too, so it
  keeps its break points).
- Visual guard (`visual.py`, Chrome, G1 pin vs G3): **all 18 scenes identical** (max difference 0, no pixel with any
  difference), including big5k-clean-fit (coarse level). Raw: `scratchpad/ar/gpu/visual-G3/`.

## Screening (`measure.py --quick`, chrome + webkit, 1 round, A = G1 3d0f7f4, B = G3 tree snapshot; raw `quick.json`)
The run waited 34 minutes for the lock (the lead's official G1 run) and ran right after it.

| metric | Chrome A | B | B/A | WebKit A | B | B/A |
|---|---:|---:|---:|---:|---:|---:|
| pan_gpu_mean@50k/clean | 1.16 | 0.91 | 0.79 | - | - | - |
| pan_gpu_mean@50k/rope (control: not on this path) | 2.22 | 1.88 | 0.85 | - | - | - |
| pan_gpu_mean@5k/clean | 0.44 | 0.44 | 1.00 | - | - | - |
| pan_cpu_p95@50k/clean | 2.96 | 2.92 | 0.99 | 3.20 | 3.80 | 1.19 |
| gpu_buffer_mb@50k/clean | 1.61 | 1.23 | 0.76 | 1.67 | 1.29 | 0.77 |
| rebuild / edit / fold / load (all sizes) | | | 0.99-1.07, all ~ | | | 0.94-1.05, all ~ |
| SCORE | 37.6 | 37.3 | 0.99 | 39.6 | 39.7 | 1.00 |

The quick run cannot separate this change from noise (the rope control moved 15 % with no code change), and its pan
metrics pool three camera positions; the targeted probe below is the evidence.

## Targeted probe: parent e2d9186 vs G3 (G2's probe, plus a zoom 0.05 camera; 3 rounds, interleaved; raw `probe-*.json`)
Chrome GPU ms per frame (median of round medians) and triangles submitted:

| camera | 5k parent | 5k G3 | 20k parent | 20k G3 | 50k parent | 50k G3 |
|---|---:|---:|---:|---:|---:|---:|
| fit | 0.42 | 0.44 | 0.61 | 0.69 | 1.07 | 1.22 |
| fit, triangles | 65 k | 92 k | 237 k | 373 k | 574 k | 929 k |
| zoom 0.05 | 0.71 | 0.74 | 0.86 | 0.95 | 1.28 | 1.04 |
| zoom 0.35 | 0.39 | 0.41 | 0.43 | 0.43 | 0.58 | 0.55 |
| zoom 1 | 0.37 | 0.37 | 0.42 | 0.43 | 0.58 | 0.58 |
| zoom 4 | 0.35 | 0.35 | 0.47 | 0.47 | 0.82 | 0.78 |

For comparison G1 (G2's run): fit 0.52 / 1.08 / 2.17 ms at 5k / 20k / 50k (1,723 k triangles at 50k).
WebKit wall ms per frame (readPixels-synchronised): fit 1.02 -> 1.10 (5k), 1.26 -> 1.46 (20k), 2.10 -> 2.02 (50k);
other cameras within -5 to +19 % with no consistent sign (spread per build up to 30 %).
Rebuild side unchanged from G1 (Chrome, worker branch mesh at 50k 48.8 -> 11.5 ms, one edit 54.3 -> 10.3 ms, edit to
settled 696 -> 563 ms; WebGL buffers 104.6 -> 1.1 MB + 6.1 MB record texture).

## What surprised me
- The cap identity (a half-disk fan = a zig-zag over its arc) made the change pixel-identical, not just close; the
  zig-zag even removes the empty half of every fan quad.
- Remaining fit overhead vs the parent (+14 % GPU, 1.6x triangles at 50k) is chunk padding (a coarse branch is ~6
  quads drawn as 8) and the empty quads of the break points.

## Verdict
Keep: whole-map GPU cost from +100 % to +14 % (Chrome, 50k) at identical pixels; nothing else moves.
