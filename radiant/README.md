# Radiant app: developer notes

The project overview is in the [README at the repository root](../README.md).

The [SQLite and portable file format](docs/file-format.md) includes a standalone SQL example that opens in Radiant.

### Offline browser checks

From `radiant/`, run `bun run test` with Bun, uv and Chrome installed. The default suite checks the shell import boundary and starts a temporary Vite server. It opens the normal editor in a fresh browser, blocks remote requests and exercises editing, undo and redo, search, picture persistence, save and reopen, Markdown download, offline AI replay and worker rendering. It uses the browser host selected by the app on startup.

The separate visual and performance gates can run with the browser host too. Start `bun run dev`, then run `uv run tools/check-performance.py` for the Chromium performance gate. On macOS, run `uv run tools/check-visuals.py` for the WebKit visual comparison.

### Inspect maps from a terminal or an assistant

From the `radiant` directory, run `bun tools/agent-cli.ts --help` for local listing, Markdown, JSON, search and validation commands. To share saved maps with an MCP client, configure a local stdio server with executable `bun` and arguments `/absolute/path/to/radiant/tools/agent-cli.ts`, `mcp`, and the absolute paths of the maps you want to expose. The client can list those maps, read a subtree, and search labels, notes and tags. Each request reads the saved SQLite file in read-only mode. Stop the server or remove its entry from the client to end access.

The [Radiant agent skill](skills/radiant-map/SKILL.md) includes a branch-edit walkthrough. Run `bun tools/agent-cli.ts skill-pack radiant-map.zip` to assemble the skill and its schema references into a portable ZIP.

### macOS distribution

The high-refresh edition is intended for distribution outside the Mac App Store. Radiant's desktop host uses one private WebKit feature switch for 120 Hz on compatible displays. The switch is isolated in `disable_60fps_cap`, which checks that WebKit supports the selectors before calling them. If the switch is unavailable, editing continues at the system frame rate. Build the public-WebKit edition with `bun run tauri build --features public-webkit --bundles app`. This removes the feature switch from the host binary. The native About panel and the inspector describe these editions.

`bun run tauri build --bundles app` builds a local macOS application. A distribution build uses `bun tools/build-release.ts` with a publisher-controlled HTTPS manifest URL in `RADIANT_UPDATE_ENDPOINT` and the corresponding public key in `RADIANT_UPDATE_PUBKEY`. Configure the updater signing key, Apple Developer ID identity and notarization credentials in the release environment using Tauri’s signing settings. Publish the signed archive and matching manifest together. Release builds expose **Check for updates** under **Inspector → About Radiant**.

The macOS bundle hook builds the Finder Quick Look extension for Apple silicon and Intel. It needs the macOS SDK and Swift compiler from Xcode or the Command Line Tools. For distribution, make the app’s Developer ID identity available to `codesign` before bundling and use the same `APPLE_SIGNING_IDENTITY` for Tauri. The extension is signed inside-out before Tauri signs the app. An ad-hoc bundle can be verified locally with `APPLE_SIGNING_IDENTITY=- bun run tauri build --bundles app`.
