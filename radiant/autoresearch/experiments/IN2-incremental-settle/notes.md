# IN2: incremental settleLayout (take over the main branches an edit did not touch)

Track: incremental (round 2). Parent: ca304ac (IN1).

## Hypothesis

`settleLayout` (core/layout/placement.ts) re-solves only the dirty main branch of a one-node edit, but around that it
does per-node work for the whole map: a `VisibleNode` object per node (`collect`, with a size spread), a change scan
of every main-branch group against the previous placements, a new box per node of every clean group (`oldBox`), a
new placement record per visible node, and `Object.entries` over all previous placements to carry hidden nodes. With
the nodes an edit touched (IN1's `changed`) and the nodes whose size changed (IN1's `resized`), the main branches
that may have changed are known before it starts; every other main branch of a root that did not move can keep its
boxes and placement records as objects. Expected: settleLayout per one-node edit at 50,000 nodes from 80-100 ms to
~20-40 ms (the dirty main branch, ~1/9 of the synthetic map, is still laid out). Metrics: worker geometry time
(`geometryMs`) on edit/fold, edit_ms and fold_ms at 20k and 50k.

## Change

- `core/layout/placement.ts`:
  - `settleLayout(..., reuse?: SettleReuse)` with `SettleReuse = { boxes, dirty }`: `boxes` are the boxes the same
    function returned with the `previous` placements, `dirty` the main-branch heads (children of a root) that may have
    changed. Used only on the existing "keep" path of a root whose position did not change.
  - `collectOrder` lists the visible nodes in the same breadth-first order as `collect`, but nodes of clean main
    branches only by id. Clean nodes then skip the change scan, `oldBox` and the record rebuild: the final loop takes
    the previous box and placement objects as they are (pins there are already applied). Their boxes still go into the
    occupancy the dirty branches make room in, as before. If any clean node lacks a previous box or placement the
    root falls back to the full path.
  - The hidden-node carry-over loop uses `for...in` instead of `Object.entries` (same order, no pair arrays).
- `core/layout/occupancy.ts`: cell keys are numbers (packed x/y) instead of `"x/y"` strings, with the string key as a
  fallback for huge coordinates; the add loop no longer builds a key array. Same cells, same blocker sets and order.
- `ui/pipeline.ts`: remembers the last settle output (placements + boxes); `settleReuse(changed, boxes)` maps the
  touched and resized nodes to their main-branch heads (a touched or resized root, or a broken parent chain, means no
  reuse). Reuse only when the placements passed in are the very object this pipeline produced last time.

Why it is exact: for a node in a clean main branch of a root that did not move, the full path computes
`oldBox(node, saved, shift 0)` = the saved x, y, side, flow with the node's size, depth and main-branch index, and a
new record with the same fields; none of those can change without touching the node, an ancestor in its main branch,
the root, or its size, all of which make the branch dirty or disable reuse.

## Correctness

Harness `check` (incremental-tools): 5,000 and 20,000 nodes x clean, rope x seeds 1-3 x 80 random edits, and
5,000 x clean, rope, paper-quilling, hand-drawn + 20,000 x clean x 60 edits with all 30 edit kinds (including main-
branch folds and renames, detach to a second root, root moves, pins, offsets, sides, branch layouts): 0 differences
from a fresh pipeline in boxes (order and fields), placements, specs, scene and mesh. Making the dirty set empty
fails the check at the first deletion. `e2e.py` through the worker (5k, 20k x clean, rope x 2 seeds x 50 edits, then
forced resync): identical. `bun run check` 0/0, boundaries OK.

## Visual guard

Chrome, 18 scenes, IN1 vs IN2: 0 differing pixels in every scene.

## Screening

Quick benchmark, 1 round, parent = IN1 (raw: `quick.json`):

| metric | Chrome A | Chrome B | B/A | WebKit A | WebKit B | B/A |
|---|---:|---:|---:|---:|---:|---:|
| edit_ms@5k | 84.8 | 85.1 | 1.00 | 84.8 | 68.9 | 0.81 |
| edit_ms@50k | 463 | 422 | 0.91 | 488 | 391 | 0.80 |
| fold_ms@5k | 132 | 130 | 0.99 | 115 | 108 | 0.94 |
| fold_ms@50k | 975 | 899 | 0.92 | 921 | 866 | 0.94 |
| load_ms@50k | 799 | 828 | 1.04 | 832 | 847 | 1.02 |
| rebuild_ms@50k/clean | 827 | 834 | 1.01 | 1036 | 934 | 0.90 |
| INTERACTION | 266 | 255 | 0.96 | 257 | 224 | 0.87 |
| SCORE | 40.90 | 40.43 | 0.99 | 43.40 | 42.01 | 0.97 |

Targeted probe (`probe.json`, production builds, interleaved, 2 rounds, 4 adds + 2 fold/unfold cycles per page,
medians, ms; "geometry" is the worker's settleLayout time):

| op | engine | size/theme | settled A -> B | worker relayout A -> B | geometry A -> B |
|---|---|---|---|---|---|
| add | Chrome | 20k clean | 212 -> 196 | 75.6 -> 66.1 | 29.3 -> 15.3 |
| add | Chrome | 50k clean | 536 -> 467 | 205 -> 146 | 87.8 -> 42.0 |
| fold | Chrome | 50k clean | 534 -> 486 | 192 -> 160 | 78.5 -> 47.6 |
| add | Chrome | 50k rope | 547 -> 529 | 221 -> 195 | 74.7 -> 40.1 |
| fold | Chrome | 50k rope | 648 -> 581 | 275 -> 220 | 89.4 -> 41.9 |
| add | WebKit | 20k clean | 172 -> 157 | 58.2 -> 50.1 | 21.8 -> 13.5 |
| add | WebKit | 50k clean | 384 -> 360 | 153 -> 131 | 58.9 -> 35.1 |
| fold | WebKit | 50k clean | 429 -> 416 | 165 -> 146 | 62.8 -> 35.7 |
| add | WebKit | 50k rope | 457 -> 452 | 201 -> 180 | 61.2 -> 35.2 |
| fold | WebKit | 50k rope | 550 -> 527 | 249 -> 224 | 63.9 -> 37.4 |

Loads and theme switches (whole documents) are unchanged, as expected (load geometry 85 -> 86 Chrome, 80 -> 80 WebKit).

Stage harness (Chrome, main thread of a dev page, 50k, medians): settleLayout per edit 78-101 ms -> 34-38 ms.

## What surprised me

- After the reuse, what is left of settleLayout at 50k (~35-45 ms) is mostly the dirty main branch itself (here one of
  9 branches, ~5,500 nodes: collect, change scan, `layoutMainBranch`, reserve loop, occupancy) plus three
  unavoidable O(n) loops at ~4 ms each (breadth-first order of all visible nodes, the boxes Map and placements
  dictionary, the carry-over `for...in`). Adding ~44,000 clean boxes to the occupancy was ~9 ms with string keys and
  ~4 ms with numeric keys. A persistent occupancy (remove/add only the dirty branch) would save the rest but needs
  care with pin shifts; not done.
- Real maps with fewer, bigger main branches will gain less: the dirty unit is a whole main branch.

## Verdict

Keep. Worker settleLayout per edit/fold at 50k roughly halved in both engines (Chrome 79-89 -> 40-48 ms, WebKit
59-64 -> 35-37 ms), edit_ms@50k -9 % (Chrome) and -20 % (WebKit) in the quick run, probe settled time -3 % to -13 %
at 50k; loads and theme switches unchanged.
