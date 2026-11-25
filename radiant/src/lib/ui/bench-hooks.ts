/**
 * Benchmark adapter: window.__radiantBench, the one surface autoresearch/bench/measure.py and visual.py drive.
 *
 * Installed only when the build sets VITE_RADIANT_BENCH=1 (see App.svelte), never in a normal production build.
 * The benchmark scripts use nothing else from the page, so an experiment that restructures the internals (a WASM
 * core, more workers, rendering in a worker) keeps the benchmark working by keeping this file's contract:
 *
 *   version                     1
 *   loadSynthetic(n, theme?)    replace the map with the deterministic synthetic map of about n nodes
 *   loadOutline(title, root, theme?)  replace the map with one built from an outline ({ text, children })
 *   setTheme(id) / setDark(on)  change the theme or the light/dark appearance (a full relayout)
 *   nodeCount()                 nodes in the laid-out map that is on screen
 *   bounds()                    world rectangle of the laid-out map (x, y = top left)
 *   box(id)                     world rectangle (x, y = top left) of a laid-out node, or null
 *   nodeAtDepth(d, f)           the node at depth d (root = 0) that sits at fraction f of document order
 *   nodeWithSubtreeNear(k)      the node whose descendant count is closest to k (ties: first in document order)
 *   shape()                     tree statistics: node count, depth histogram, label length percentiles
 *   addChild(parent, text)      add a child as a user edit and select it; returns the new id
 *   toggleFold(id)              fold or unfold a node as a user edit
 *   camera() / setCamera(s) / fit()   read or set { cx, cy, zoom } (world centre, CSS px per world unit), or fit the map
 *   frames()                    frames drawn so far
 *   layoutGeneration()          bumped every time a new layout result is adopted for display
 *   idle()                      nothing is on its way to the screen: no pending layout, worker job, scheduled
 *                               flush, animation, requested frame, or outstanding label or picture work
 *   onFrame(fn)                 fn({ t, drawMs, items }) after every drawn frame: t = performance.now() when the
 *                               frame's draw calls were issued, drawMs = main-thread ms the frame's drawing took,
 *                               items = rectangles + labels drawn (to check the camera is over the map)
 *   gpuTimer(on)                time every frame on the GPU when the platform allows; returns availability
 *   gpuSamples()                drain the GPU frame times (ms) collected so far
 *   memory()                    { gpuBufferBytes } held in WebGL buffers created since install
 *   diagnostics()               internal breakdown of the last rebuild (layout, geometry, adopt, scene ...), in ms
 *
 * Timings are performance.now() on the main thread. Keep every function cheap: the benchmark calls idle() and
 * frames() once per animation frame.
 */
import type { AppController } from './controller.svelte';
import type { NodeId, OutlineNode, Rect } from '../core/types';
import { addChild } from '../core/model';
import type { Renderer } from '../render/renderer';
import { createGpuProbe } from '../render/bench-probe';

export interface BenchFrame { t: number; drawMs: number; items: number }
export interface BenchCamera { cx: number; cy: number; zoom: number }

export interface RadiantBench {
  version: 1;
  loadSynthetic(n: number, themeId?: string): void;
  loadOutline(title: string, root: OutlineNode, themeId?: string): void;
  setTheme(id: string): void;
  setDark(dark: boolean): void;
  nodeCount(): number;
  bounds(): Rect;
  box(id: NodeId): Rect | null;
  nodeAtDepth(depth: number, fraction: number): NodeId | null;
  nodeWithSubtreeNear(size: number): { id: NodeId; descendants: number } | null;
  shape(): { nodes: number; depths: number[]; labelChars: { p10: number; p50: number; p90: number; max: number } };
  addChild(parent: NodeId, text: string): NodeId | null;
  toggleFold(id: NodeId): void;
  camera(): BenchCamera;
  setCamera(s: BenchCamera): void;
  fit(): void;
  frames(): number;
  layoutGeneration(): number;
  idle(): boolean;
  onFrame(fn: (f: BenchFrame) => void): () => void;
  gpuTimer(on: boolean): boolean;
  gpuSamples(): number[];
  memory(): { gpuBufferBytes: number };
  diagnostics(): Record<string, number | string>;
}

export function installBenchHooks(c: AppController): void {
  // The controller holds a RenderDevice; today that is always the WebGL Renderer on the main thread.
  const renderer = c.renderer as unknown as Renderer;
  const pipeline = c.pipeline;

  // ---- frame observation: wrap the renderer's own draw entry point (it calls this.render()).
  const listeners = new Set<(f: BenchFrame) => void>();
  const probe = createGpuProbe(renderer.canvas);
  const render = renderer.render;
  renderer.render = function (this: typeof renderer) {
    const before = this.stats.frames;
    const start = performance.now();
    probe.beginFrame();
    try {
      render.call(this);
    } finally {
      probe.endFrame();
    }
    const end = performance.now();
    if (this.stats.frames === before) return; // nothing drawn (no scene, lost context)
    const frame = { t: end, drawMs: end - start, items: this.stats.rectsDrawn + this.stats.labelsDrawn };
    for (const fn of listeners) fn(frame);
  };

  // ---- adoption timing (diagnostics only)
  const diag: Record<string, number | string> = {};
  const timed = <K extends 'adoptWork' | 'work' | 'fullScene'>(name: K, label: string) => {
    const original = pipeline[name] as (...args: unknown[]) => unknown;
    (pipeline as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      const t0 = performance.now();
      try { return original.apply(this, args); } finally {
        diag[label + 'Ms'] = performance.now() - t0;
        diag[label + 'At'] = t0;
      }
    };
  };
  timed('adoptWork', 'adopt');
  timed('work', 'snapshot');
  timed('fullScene', 'scene');

  // ---- document queries (read the model only)
  const order = (): { id: NodeId; depth: number }[] => {
    const out: { id: NodeId; depth: number }[] = [];
    const stack: [NodeId, number][] = [...c.doc.roots].reverse().map((id) => [id, 0] as [NodeId, number]);
    while (stack.length) {
      const [id, depth] = stack.pop()!;
      out.push({ id, depth });
      const kids = c.doc.nodes[id]?.children ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1]);
    }
    return out;
  };
  const descendants = (): Map<NodeId, number> => {
    const counts = new Map<NodeId, number>();
    const list = order();
    for (let i = list.length - 1; i >= 0; i--) {
      const node = c.doc.nodes[list[i].id];
      let sum = 0;
      for (const k of node.children) sum += 1 + (counts.get(k) ?? 0);
      counts.set(node.id, sum);
    }
    return counts;
  };
  const topLeft = (b: { x: number; y: number; w: number; h: number }): Rect => ({ x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h });

  const bench: RadiantBench = {
    version: 1,
    loadSynthetic: (n, themeId) => c.loadSynthetic(n, themeId),
    loadOutline: (title, root, themeId) => c.loadOutline(title, root, themeId),
    setTheme: (id) => c.setTheme(id),
    setDark: (dark) => { c.isDark = dark; c.refreshLayout(); },
    nodeCount: () => pipeline.nodeCount,
    bounds: () => ({ ...pipeline.canvasLayout.bounds }),
    box: (id) => { const b = pipeline.box(id); return b ? topLeft(b) : null; },
    nodeAtDepth: (depth, fraction) => {
      const at = order().filter((n) => n.depth === depth);
      return at.length ? at[Math.min(at.length - 1, Math.floor(fraction * at.length))].id : null;
    },
    nodeWithSubtreeNear: (size) => {
      let best: { id: NodeId; descendants: number } | null = null;
      const counts = descendants();
      for (const { id } of order()) {
        const d = counts.get(id) ?? 0;
        if (!best || Math.abs(d - size) < Math.abs(best.descendants - size)) best = { id, descendants: d };
      }
      return best;
    },
    shape: () => {
      const list = order();
      const depths: number[] = [];
      for (const n of list) depths[n.depth] = (depths[n.depth] ?? 0) + 1;
      const chars = list.map((n) => c.doc.nodes[n.id].text.length).sort((a, b) => a - b);
      const at = (p: number) => chars[Math.min(chars.length - 1, Math.floor(p * chars.length))] ?? 0;
      return { nodes: list.length, depths: Array.from(depths, (v) => v ?? 0), labelChars: { p10: at(.1), p50: at(.5), p90: at(.9), max: chars[chars.length - 1] ?? 0 } };
    },
    addChild: (parent, text) => {
      const e = addChild(c.doc, parent, text);
      if (!e) return null;
      c.editor.apply(e.tx);
      c.select([e.focus as NodeId]);
      return e.focus as NodeId;
    },
    toggleFold: (id) => c.toggleFoldOf(id),
    camera: () => c.camera.getState(),
    setCamera: (s) => c.camera.set(s),
    fit: () => c.zoomFit(false),
    frames: () => renderer.stats.frames,
    layoutGeneration: () => c.layoutTick,
    idle: () => !c.frameWorkPending && renderer.idle,
    onFrame: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    gpuTimer: (on) => probe.timer(on),
    gpuSamples: () => probe.samples(),
    memory: () => ({ gpuBufferBytes: probe.bufferBytes() }),
    diagnostics: () => ({
      ...diag,
      layoutMs: pipeline.lastLayoutMs,
      geometryMs: pipeline.lastGeometryMs,
      branchMeshMs: pipeline.lastBranchMeshMs,
      branchesRebuilt: pipeline.lastBranchesRebuilt,
      layoutSource: pipeline.lastLayoutSource,
      meshTriangles: renderer.stats.meshTriangles,
      drawCalls: renderer.stats.drawCalls
    })
  };
  (window as unknown as { __radiantBench: RadiantBench }).__radiantBench = bench;
}
