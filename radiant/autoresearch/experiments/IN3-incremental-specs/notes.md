# IN3: incremental branch specs (keep the spec of a limb whose inputs did not change)

Track: incremental (round 2). Parent: 62651b6 (IN2).

## Hypothesis

`buildBranchSpecs` resolves the style of both ends (colour inheritance, branch style chain, local theme, readable ink),
builds a spec object for every visible limb, and `Pipeline.branchSpecs` walks all specs again (picture anchors, curved
labels, a `themeFor` per spec): 70-110 ms per one-node edit at 50,000 nodes in the stage harness. A spec depends on
its two boxes, the resolved styles of its two nodes (which inherit down the tree), its parent's spec (start width,
underline, rope twist), its siblings (lifted-arcs plugs, rope whipping, fanned root joins, quilling ring) and, for
rope and quilling, the leaves its node carries. If settleLayout keeps box objects for unmoved nodes (IN2 keeps clean
main branches; this experiment also keeps an unmoved box object inside a dirty one), a memo can hand back last pass's
spec for every limb whose inputs are the same objects. Expected: branch specs 70-110 -> 10-30 ms per edit at 50k.

## Change

- `core/geometry/branches.ts`: `buildBranchSpecs(doc, layout, theme, memo?)` with `BranchSpecMemo` (per child id: spec,
  source, both boxes, the parent spec it continued, leaves). A first pass marks a source's children for rebuilding when
  any of them has no entry, a different box or parent box object, a different source, different leaves, or a node or
  source in `dirty`; the main loop reuses the entry of every other limb whose parent spec is the very object it
  continued. A rebuilt spec equal (key by key) to the previous one keeps the previous object, which stops the cascade
  down the subtree. The rope whipping is now computed when the last limb of a bundle is built (same values: from the
  parent spec, on the last limb leaving it in layout order) instead of being assigned afterwards, so specs are never
  changed after they are built. `dirty` null rebuilds everything and refills the memo.
- `core/layout/placement.ts`: in the final loop an unmoved box (all fields equal) keeps its previous object.
- `ui/pipeline.ts`: `dirtyNodes(changed)`: the visible subtrees of the touched nodes; null (full rebuild) without an edit
  list, when a root was touched, when the theme object, seed or IN1's global size inputs changed, or when the map has
  pictures. `branchSpecs` skips its second walk entirely when there are no pictures, no curved labels in the theme and
  no node with its own theme or a curved-label style (flags gathered by computeSizes); otherwise it changes copies of
  specs (copy on write), so memo specs are never mutated.

## Correctness

Harness `check` (now 33 edit kinds, plus a random node being edited in 20 % of passes): 5,000 nodes x clean, rope x 2
seeds x 60; 5,000 x lifted-arcs, paper-quilling, soft-clay, hand-drawn (curved labels), buzan, daylight, studio, sorbet,
citrus, lagoon, boardroom, outline, midnight, ink x 50; 20,000 x clean, rope, lifted-arcs, paper-quilling x 60: no
difference from a fresh pipeline (specs compared field by field, mesh arrays too). Dropping the `dirty` test makes it
fail on the first branch-width edit. `e2e.py` through the worker: 5k and 20k x rope, paper-quilling: identical after a
forced resync. `bun run check` 0/0, boundaries OK. Not covered by any check: maps with pictures (the memo is off there).

## Visual guard

Chrome, 18 scenes, IN2 vs IN3: 0 differing pixels in every scene.

## Screening

Quick benchmark, 1 round, parent = IN2 (raw: `quick.json`):

| metric | Chrome A | Chrome B | B/A | WebKit A | WebKit B | B/A |
|---|---:|---:|---:|---:|---:|---:|
| edit_ms@5k | 85.0 | 68.3 | 0.80 | 85.4 | 68.4 | 0.80 |
| edit_ms@50k | 416 | 381 | 0.92 | 397 | 357 | 0.90 |
| fold_ms@5k | 125 | 114 | 0.92 | 105 | 105 | 1.01 |
| fold_ms@50k | 881 | 830 | 0.94 | 903 | 775 | 0.86 |
| load_ms@50k | 799 | 811 | 1.02 | 890 | 888 | 1.00 |
| rebuild_ms@50k/clean | 813 | 880 | 1.08 | 921 | 885 | 0.96 |
| rebuild_ms@50k/rope | 828 | 869 | 1.05 | 857 | 923 | 1.08 |
| INTERACTION | 250 | 223 | 0.89 | 238 | 211 | 0.89 |
| SCORE | 39.33 | 37.99 | 0.97 | 42.55 | 39.87 | 0.94 |

Targeted probe (`probe.json`, production builds, interleaved, 2 rounds, medians in ms):

| op | engine | size/theme | settled A -> B | worker relayout A -> B |
|---|---|---|---|---|
| add | Chrome | 20k clean | 209 -> 181 | 63.8 -> 36.9 |
| add | Chrome | 50k clean | 474 -> 426 | 153 -> 114 |
| fold | Chrome | 50k clean | 472 -> 437 | 155 -> 117 |
| add | Chrome | 50k rope | 504 -> 429 | 187 -> 129 |
| fold | Chrome | 50k rope | 562 -> 505 | 215 -> 147 |
| add | WebKit | 20k rope | 183 -> 151 | 68.2 -> 40.8 |
| add | WebKit | 50k clean | 372 -> 326 | 133 -> 96 |
| fold | WebKit | 50k clean | 433 -> 374 | 147 -> 105 |
| add | WebKit | 50k rope | 450 -> 384 | 182 -> 120 |
| fold | WebKit | 50k rope | 550 -> 476 | 225 -> 167 |

Loads and theme switches unchanged in the probe (within 1-4 %). Stage harness (Chrome, 50k): branch specs per edit
68-75 -> 15-22 ms (clean), 101-112 -> 33-41 ms (rope).

## What surprised me

- Rope keeps ~35 ms: its leaves count (two Maps over every box, ~13 ms) and the pre-pass with the last-limb map run over
  all 50,000 limbs every edit; only the spec building itself became proportional.
- The rebuild-on-theme-switch path now also fills the memo (50,000 entry objects). Not visible in the probe's theme
  switches (+-1 %); the quick run's Chrome rebuild@50k +5/+8 % is not repeated in WebKit or in the probe.

## Verdict

Keep. Worker relayout per edit/fold at 50k -25 % to -33 % in both engines, settled edit/fold at 50k -7 % to -15 %,
edit_ms@5k -20 % in both engines in the quick run; no visual change.
