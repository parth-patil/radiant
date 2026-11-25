import desktop from "./src-tauri/tauri.conf.json" with { type: "json" };
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { checkBoundaries } from "./tools/check-boundaries.mjs";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// Use the desktop resource policy in static builds. SvelteKit hashes its
// inline bootstrap and expects CSP keywords without quotes.
const directives = Object.fromEntries(Object.entries(desktop.app.security.csp).map(
  ([name, sources]) => [name, String(sources).replaceAll("'", "").split(" ")]
));

export default defineConfig(({ command }) => ({
  plugins: [
    { name: "radiant-architecture", apply: "build", buildStart: checkBoundaries },
    sveltekit({
      preprocess: vitePreprocess(),
      csp: command === "build" ? { mode: "hash", directives } : undefined,
      version: { pollInterval: 0 },
      // The Tauri shell serves static files, so routes use the SPA fallback.
      adapter: adapter({ fallback: "index.html" })
    })
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
