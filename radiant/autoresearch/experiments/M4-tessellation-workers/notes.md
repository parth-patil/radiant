# M4: tessellation across a pool of workers (skipped)

## Hypothesis (from the brief and study 03)
Split flat tessellation of maps over about 20,000 nodes across 4-8 nested workers in "chunk mode" (each worker packs its
own buffer, the renderer draws one buffer per chunk). Study 03 measured about 2.5x at 8 workers for the WebAssembly
kernel in isolation (50k: 52-55 ms on one worker to 21 ms on 8, most of it by 4).

## Why it was not built
The brief says to build it if M3 wins. M3 is at best a marginal win (see M3's notes), and the numbers leave no room for M4:
- After M1 to M3, the whole flat mesh step for a fresh 50k batch is about 49 ms (Chrome) and 37-52 ms (WebKit), wasm
  kernel plus copy-out (`M3` kernel.json). The copy-out alone is 15 ms (Chrome) and 4-21 ms (WebKit), and chunk mode
  does not remove it (each worker still copies its chunk out of its own memory and transfers it).
- The best case for 4 workers is therefore roughly 49 -> 25 ms per full 50k rebuild, about 25 ms, against settled times
  of 1,000-1,500 ms (Chrome) and 1,400-2,900 ms (WebKit) for load_ms@50k and rebuild_ms@50k/clean in the quick runs. That
  is 1.5-2.5 % of the metric, well under the benchmark's single-metric noise (sd 2-10 %, single rounds 10 %+).
- Edits and folds would not use it: with most branches reusable they take the TypeScript reuse path (M2), which is cheaper
  than any fresh tessellation.
- The cost is large and lands in other tracks' files: the renderer would draw several mesh buffers (renderer.ts upload,
  draw, culling and the branch index used for picking), the transport would carry several packed buffers, and the worker
  would own a pool of nested workers with their own wasm instances (each grows its linear memory to its chunk's peak and
  never shrinks it: about 217 MB for one 50k instance today).
- The JavaScript-only variant loses in WebKit, the shipping engine: the workers must receive the specs by structured
  clone, which study 03 measured at 78-113 ms for 50k specs in JavaScriptCore, more than the 40-50 ms the whole
  single-threaded TypeScript tessellation takes.

## Where more threads could pay instead
Dimensional materials: a 50k rope rebuild spends 135-145 ms (Chrome) and 240-350 ms (WebKit) in the mesh step in the
quick runs' worker diagnostics, 3-4x the flat step, and the relief tessellator has no WebAssembly port. If those maps
matter, a wasm port of reliefBatch and quill.ts (about 700 lines of TypeScript) comes before splitting across workers,
and it is still bounded by the same share of the total: the rope rebuild at 50k settles in 1.3-3.1 s.

## Verdict
skipped: no code, no measurement of its own; the reasoning rests on M3's kernel numbers and study 03.
