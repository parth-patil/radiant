# Sample maps

Three small maps that combine a mind map with sketches on the canvas. Each is a portable Radiant bundle (`.radiant.zip`), built with the Clean theme.

| File | What it shows |
|---|---|
| `system-design-url-shortener.radiant.zip` | A design review: requirements, API, data model, scaling and risks as a map, with a hand-drawn request-path diagram, labelled arrows and sticky notes |
| `launch-plan-with-board.radiant.zip` | A launch plan with a Now / Next / Later board made of frames and sticky notes, and a launch-day timeline |
| `study-notes-coffee.radiant.zip` | Study notes with a handwritten title, freehand ink, sticky notes and a small decision flowchart in a frame |

Open one in the app with **File → Open**, or inspect it from a terminal:

```sh
cd radiant
bun tools/agent-cli.ts get ../samples/system-design-url-shortener.radiant.zip
bun tools/agent-cli.ts stats ../samples/launch-plan-with-board.radiant.zip
```
