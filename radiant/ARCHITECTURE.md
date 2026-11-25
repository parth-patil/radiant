# Radiant architecture and module ownership

Radiant is a desktop mind-mapping app: Tauri 2 (Rust host) + system WebView + TypeScript front end
(Svelte 5 via SvelteKit in SPA mode) + a custom WebGL2 renderer. The full requirements are in
`../radiant-mind-map-blueprint.html` (pages: features, ai-engine, engine, quality, art-subtrees).

## Data flow

```
user input / AI stream
      │  Transaction (ops)
      ▼
core/model  ── DocChange ──►  core/layout  ──►  core/geometry  ──►  ui/scene builder  ──►  render (WebGL2)
 (Doc, undo)                  (NodeBox map)      (branch mesh,          (Scene)               (canvas)
                                                  spatial index)
```

- `core/*` modules are pure TypeScript: no DOM, no WebGL, no Tauri. They must run in a Worker and in Vitest.
- `render/` owns everything WebGL and text rasterisation. It knows nothing about Doc.
- `host/` is the only code that imports `@tauri-apps/*`.
- `ui/` wires everything together (Svelte components, input handling, scene building).

## Ownership (one owner per path; do not edit paths you do not own)

| Path | Owner | Notes |
|---|---|---|
| `src/lib/core/types.ts`, `src/lib/host/types.ts` | coordinator | Shared contracts. Ask, do not edit. |
| `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/`, `package.json`, `vite.config.js` | coordinator | Request dependency changes in your final report. |
| `src/lib/core/model/` | model agent | Doc creation, ops, undo/redo, editor helpers, serialisation, themes registry |
| `src/lib/core/layout/` | layout agent | Tidy-tree layout (variable sizes), mindmap/right/left/down/radial |
| `src/lib/core/geometry/` | geometry agent | Branch specs, tapered/organic tessellation, spatial index, hit-testing |
| `src/lib/render/`, `src/routes/dev/render/` | render agent | WebGL2 renderer, camera, label atlas, image textures, perf demo page |
| `src/lib/core/ai/`, `src/lib/core/art/`, `src-tauri/src/codex/` | AI agent | Codex app-server client (Rust), prompts and stream parser (TS) |
| `src/lib/core/io/`, `src/lib/host/index.ts`, `src/lib/host/tauri.ts`, `src/lib/host/mock.ts`, `src-tauri/src/store/`, `src-tauri/src/platform/` | host agent | Document files, autosave, assets, 120 Hz setting, Host implementation, Markdown/OPML import-export |
| `src/lib/ui/`, `src/routes/+page.svelte`, `src/routes/+layout.*` | UI agent (phase 2) | App shell and integration |

Do not write unit tests (owner's instruction). Verify with `bun run check`, `cargo build`, and short throwaway scripts kept outside the repository.

## Conventions

- TypeScript strict. No `any` in exported APIs. Each module exposes a single `index.ts`.
- World coordinates: y down, 1 unit = 1 CSS px at zoom 1, node boxes are centre + size.
- Performance budgets (blueprint, quality page): 8.3 ms frame at 120 Hz; at most 4 ms script per frame on a
  5,000-node map while panning; layout of 5,000 nodes under 50 ms; render only on demand.
- Commands: `bun run check` (svelte-check), `cd src-tauri && cargo build`,
  `bun run tauri dev` (runs the app; do not leave it running).
