# Canvas reference images

Run `bun run dev` from `radiant/`, then run `uv run tools/check-visuals.py --fault-check` in a second terminal. The check uses an isolated macOS WKWebView with the same development app and offline host as the application section of the [performance harness](../../tools/check-performance.py). It uses the normal renderer, reads the WebGL canvas immediately after drawing, and waits for glyphs and artwork textures to become resident. Native window chrome sits outside the capture.

The five references pair distinct layout and branch variants. The mind map also includes a locally drawn raster, an SVG subtree, two selected nodes, and a collapsed branch. The fixture uses fixed node IDs, seed, camera framing and colours. [The environment record](environment.json) identifies the macOS build, architecture, WebKit user agent and pixel dimensions that produced these references.

A pixel differs if any RGB channel differs by more than 18 on a 0–255 scale. A scene passes when at most 0.10% of pixels differ overall and no 96×96-pixel tile exceeds 3% differing pixels. The local limit helps detect changes to thin branches in mostly empty scenes. Dimension changes fail. The gate prints both percentages and saves each failed candidate and a pink-highlighted diff in the reported scratch directory.

To review an intentional change, run `uv run tools/check-visuals.py --record --output /tmp/radiant-visual-candidates`. Compare the candidate PNGs and metadata with the tracked references. Copy the accepted PNGs and `environment.json` here and include those files in the reviewed change. The capture command leaves the tracked references untouched.

On the recorded macOS build, three fresh clean runs matched all five references exactly. The deliberate colour change affected 1.3037% of the frame with a 34.9609% worst tile. The deliberate branch-shape change affected 0.6897% of the frame with a 27.7452% worst tile. Both exceeded the failure limits.

## Branch join refresh

The refresh compares native WKWebView captures before and after `478a4f8`. Node boxes, label geometry, picture geometry and camera framing match across those revisions. The tapered and organic scenes show child stems starting inside the existing parent underline. The straight, rounded and angular scenes retain their routing styles and tip widths while carrying the upstream width into each outgoing stem. In the straight and rounded fixtures, the main stem starts at 14 world units and reaches 6.902 at its tip, where the child starts. The earlier `8f5d9ff` accounts for the uniform terminal strokes already visible in the straight and organic scenes. These changes cover the continuous joins in [FR-STY-05](../../../report/src/pages/features.html#FR-STY-05) and the connections into picture artwork in [FR-ART-29](../../../report/src/pages/art-subtrees.html#FR-ART-29).

The mind-map capture also includes the two transparent selection interiors from `6df1e52`. The blue outlines remain, and removing the low-opacity fill keeps foreground text and artwork unshaded. The largest channel difference from this change was 12 of 255. This supports [NFR-A11Y-04](../../../report/src/pages/quality.html#NFR-A11Y-04). The one-digit fold badge renders identically after `fef9f6b`.

A separate capture matched all five refreshed PNGs byte for byte. The deliberate colour change differed across 1.4401% of the frame with a 39.5833% worst tile. The deliberate shape change differed across 1.0059% of the frame with a 41.7643% worst tile.
