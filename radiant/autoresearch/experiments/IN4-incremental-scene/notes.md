# IN4: incremental scene (keep the rects and labels of unchanged nodes; skip empty badge and sketch walks)

Track: incremental (round 2). Parent: aa88cd3 (IN3).

## Hypothesis

`Pipeline.fullScene` in the worker builds a label and a rect (filled shapes) for every visible node on every pass via
`buildScene` (style resolution, display text, padding, colours), then walks every box twice more for generation-failure
badges and sketches even when no node has either: 36-41 ms per edit at 50,000 nodes in the stage harness. A node whose
box object is unchanged (IN2/IN3 keep unmoved boxes) and which is not in the edited subtrees (IN3's `dirtyNodes`)
draws the same label and rect, so the previous objects can be reused; the two walks can be skipped when the last
measuring pass saw no failed generation and no sketch. Expected: fullScene 36-41 -> under 10 ms per edit at 50k.

## Change

- `core/geometry/scene.ts`: `buildScene(input, memo?)` with `SceneMemo` (per node: box, rect, label, plus the node being
  edited last time). A node that is not folded, not a branch boundary, not being edited now or in the previous build,
  not in `dirty`, and whose box is the same object as last time pushes its previous rect and label; everything else is
  built as before and remembered. Folded nodes are always rebuilt (their hidden-count badge can change without them
  being touched).
- `ui/pipeline.ts`: the memo is used only for the worker's whole-map scene (no presentation scope, filter, pictures,
  curved labels or artwork), and only when the memo was built in the immediately previous relayout pass (a pass that
  did not prepare a scene invalidates it). `computeSizes` records whether any visible node has a failed generation or a
  sketch; `fullScene` skips those walks when neither exists. The main thread, which adopts results without running
  `computeSizes`, always walks (flags reset on adoption). In the memo case `nodeOpacity` is not passed (it is 1 for
  every node there, which is what `buildScene` assumes without it).

## Correctness

Harness `check` with scene-specific additions: a random node being edited in 20 % of passes, passes that do not
prepare a scene (10 %, and forced `ns-` steps), sketches, generation errors and text-colour-only edits (`ink`): 5,000 x
clean, rope, hand-drawn, soft-clay, lifted-arcs x 60 and 20,000 x clean, rope, paper-quilling x 60: no difference in
labels, rects, images, ink. Two mutation tests: dropping the dirty test fails at the first width edit; accepting a memo
older than the previous pass fails on `ns-ink, add` (label colour). `e2e.py` through the worker (5k, 20k x clean, rope):
identical after a forced resync. `bun run check` 0/0, boundaries OK.

## Visual guard

Chrome, 18 scenes, IN3 vs IN4: 0 differing pixels in every scene.

## Screening

Quick benchmark, 1 round, parent = IN3 (raw: `quick.json`):

| metric | Chrome A | Chrome B | B/A | WebKit A | WebKit B | B/A |
|---|---:|---:|---:|---:|---:|---:|
| edit_ms@5k | 68.3 | 68.0 | 1.00 | 68.5 | 69.6 | 1.02 |
| edit_ms@50k | 384 | 342 | 0.89 | 376 | 363 | 0.96 |
| fold_ms@5k | 117 | 106 | 0.91 | 105 | 105 | 1.00 |
| fold_ms@50k | 781 | 691 | 0.88 | 817 | 705 | 0.86 |
| load_ms@50k | 782 | 849 | 1.09 | 838 | 814 | 0.97 |
| rebuild_ms@50k/clean | 790 | 848 | 1.07 | 938 | 935 | 1.00 |
| rebuild_ms@50k/rope | 839 | 891 | 1.06 | 903 | 929 | 1.03 |
| INTERACTION | 221 | 203 | 0.92 | 217 | 208 | 0.96 |
| SCORE | 36.93 | 37.54 | 1.02 | 40.45 | 41.27 | 1.02 |

Targeted probe (`probe.json`, production builds, interleaved, 2 rounds, medians in ms; "worker handler" is the
worker's whole handling of the request: relayout, scene, packing):

| op | engine, size, theme | settled A -> B | worker handler A -> B |
|---|---|---|---|
| add | chrome 20k clean | 181 -> 166 | 133 -> 115 |
| fold | chrome 20k clean | 184 -> 175 | 108 -> 97 |
| unfold | chrome 20k clean | 157 -> 141 | 112 -> 91 |
| add | chrome 20k rope | 194 -> 173 | 129 -> 116 |
| fold | chrome 20k rope | 214 -> 198 | 133 -> 125 |
| unfold | chrome 20k rope | 201 -> 175 | 143 -> 120 |
| add | chrome 50k clean | 427 -> 396 | 329 -> 285 |
| fold | chrome 50k clean | 486 -> 435 | 295 -> 257 |
| unfold | chrome 50k clean | 391 -> 351 | 293 -> 253 |
| add | chrome 50k rope | 457 -> 437 | 341 -> 322 |
| fold | chrome 50k rope | 556 -> 533 | 364 -> 330 |
| unfold | chrome 50k rope | 471 -> 495 | 359 -> 355 |
| add | webkit 20k clean | 156 -> 142 | 97 -> 96 |
| fold | webkit 20k clean | 174 -> 172 | 105 -> 101 |
| unfold | webkit 20k clean | 138 -> 135 | 96 -> 88 |
| add | webkit 20k rope | 151 -> 149 | 109 -> 100 |
| fold | webkit 20k rope | 198 -> 188 | 124 -> 111 |
| unfold | webkit 20k rope | 172 -> 157 | 127 -> 113 |
| add | webkit 50k clean | 333 -> 304 | 250 -> 225 |
| fold | webkit 50k clean | 413 -> 382 | 268 -> 260 |
| unfold | webkit 50k clean | 356 -> 351 | 270 -> 259 |
| add | webkit 50k rope | 383 -> 363 | 294 -> 268 |
| fold | webkit 50k rope | 520 -> 489 | 348 -> 320 |
| unfold | webkit 50k rope | 459 -> 400 | 363 -> 309 |

Stage harness (Chrome, 50k): fullScene per edit 38-41 -> 4-9 ms (clean and rope).

## What surprised me

- Chrome's load and rebuild at 50k came out 6-9 % slower in this one round while WebKit's did not move; a full pass now
  also fills the scene memo (50,000 small entry objects). Possibly real for Chrome (a few ms of allocation on a full
  pass would not explain 60 ms, so most of it is likely noise), but it should be checked in the official run.
- The interaction gain is mostly fold (-12 to -14 % in both engines); after IN1-IN4 the worker's relayout + scene is no
  longer the largest part of an edit at 50k (see IN5).

## Verdict

Keep (provisional on the official run's rebuild numbers in Chrome). fold_ms@50k -12 % / -14 %, edit_ms@50k -11 % / -4 %,
fullScene per edit roughly -85 %; no visual change.
