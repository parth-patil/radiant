<script lang="ts">
  import { onMount } from 'svelte';
  import { Camera, CameraController, Renderer } from '../../../lib/render';
  import type { RenderStats } from '../../../lib/render';
  import type { Rect } from '../../../lib/core/types';
  import { buildSyntheticScene, makeImageUrls, type SyntheticScene } from './synthetic';
  import { buildFeatureScene, decorateScene, type FeatureFlags } from './features';

  let canvas: HTMLCanvasElement;
  let hud = $state({
    fps: 0,
    cpu: 0,
    draws: 0,
    labels: 0,
    greeked: 0,
    rects: 0,
    images: 0,
    textures: 0,
    pending: 0,
    zoom: 1,
    status: 'starting'
  });
  let info = $state('');
  let results = $state<string[]>([]);
  let running = $state(false);
  let farOrigin = $state(false);
  // ?scene=features shows the small theme/canvas feature scene; ?shadows=0|1, ?surface=0|1, ?canvas=0|1 override.
  let sceneKind = $state<'synthetic' | 'features'>('synthetic');
  let flags = $state<FeatureFlags>({ shadows: false, surface: false, canvas: false });

  let renderer: Renderer;
  let camera: Camera;
  let controller: CameraController;
  let syn: SyntheticScene | null = null;
  let imageUrls: string[] = [];
  let bounds: Rect = { x: 0, y: 0, w: 1000, h: 1000 };
  let benchSink: ((s: RenderStats) => void) | null = null;

  // fps from the timestamps of frames that were actually rendered (the app renders only on demand).
  const stamps: number[] = [];
  let hudTimer = 0;
  function onFrame(s: RenderStats) {
    const now = performance.now();
    stamps.push(now);
    while (stamps.length && now - stamps[0] > 1000) stamps.shift();
    benchSink?.(s);
    if (!hudTimer) hudTimer = window.setTimeout(refreshHud, 200);
  }
  function refreshHud() {
    hudTimer = 0;
    const s = renderer.stats;
    const now = performance.now();
    while (stamps.length && now - stamps[0] > 1000) stamps.shift();
    hud = {
      fps: stamps.length,
      cpu: s.cpuMs,
      draws: s.drawCalls,
      labels: s.labelsDrawn,
      greeked: s.labelsGreeked,
      rects: s.rectsDrawn,
      images: s.imagesDrawn,
      textures: s.textures,
      pending: s.labelsPending + s.imagesLoading,
      zoom: camera.zoom,
      status: stamps.length ? 'rendering' : 'idle (no frames requested)'
    };
    if (stamps.length) hudTimer = window.setTimeout(refreshHud, 250);
  }

  function percentile(a: number[], p: number): number {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  function buildScene(rebuild = true) {
    const on = [flags.shadows && 'shadows', flags.surface && 'surface', flags.canvas && 'canvas'].filter(Boolean).join(', ') || 'none';
    if (sceneKind === 'features') {
      const f = buildFeatureScene(flags);
      bounds = f.bounds;
      renderer.setScene(f.scene);
      info = `feature scene: ${f.scene.rects.length} rects, ${f.scene.labels.length} labels | features: ${on}`;
      return;
    }
    if (rebuild || !syn) syn = buildSyntheticScene(imageUrls, { originOffset: farOrigin ? 2_000_000 : 0 });
    bounds = syn.bounds;
    const scene = flags.shadows || flags.surface || flags.canvas ? decorateScene(syn.scene, syn.bounds, flags) : syn.scene;
    renderer.setScene(scene);
    info = `${syn.nodeCount} nodes, ${syn.scene.labels.length} labels, ${syn.scene.rects.length} rects, ${syn.scene.images.length} images, ${syn.triangles} triangles (built in ${syn.buildMs.toFixed(0)} ms) | features: ${on}`;
  }

  function setFeatures(next: Partial<FeatureFlags>) {
    flags = { ...flags, ...next };
    buildScene(false);
  }

  function setSceneKind(kind: 'synthetic' | 'features') {
    sceneKind = kind;
    buildScene(false);
    resetView();
  }

  function resetView() {
    const cx = bounds.x + bounds.w / 2;
    camera.set({ cx, cy: bounds.y + bounds.h / 2, zoom: sceneKind === 'features' ? 1 : 0.6 });
  }

  function fitAll() {
    camera.animateTo(Camera.fitState(bounds, camera.width, camera.height, 30), 400);
  }

  function toggleOrigin() {
    farOrigin = !farOrigin;
    buildScene();
    resetView();
  }

  /** 5 s scripted pan + zoom; renders synchronously in each rAF tick and records intervals and CPU time. */
  function runBench(label = 'run'): Promise<string> {
    return new Promise((resolve) => {
      running = true;
      const cx0 = bounds.x + bounds.w / 2;
      const cy0 = bounds.y + bounds.h / 2;
      const ax = bounds.w * 0.38;
      const ay = Math.min(bounds.h * 0.35, 20000);
      const intervals: number[] = [];
      const cpu: number[] = [];
      const labelsDrawn: number[] = [];
      let last = 0;
      let start = 0;
      let frames = 0;
      let pendingEnd = 0;
      const tick = (now: number) => {
        if (!start) start = now;
        const t = (now - start) / 5000;
        if (t >= 1) {
          const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
          const msg =
            `${label}: ${frames} frames | interval mean ${mean(intervals).toFixed(2)} ms, p95 ${percentile(intervals, 0.95).toFixed(2)} ms, max ${Math.max(...intervals).toFixed(1)} ms` +
            ` | CPU mean ${mean(cpu).toFixed(2)} ms, p95 ${percentile(cpu, 0.95).toFixed(2)} ms, max ${Math.max(...cpu).toFixed(2)} ms` +
            ` | labels/frame ${mean(labelsDrawn).toFixed(0)} | ${syn?.nodeCount} nodes`;
          results = [msg, ...results];
          running = false;
          cancelAnimationFrame(pendingEnd);
          resolve(msg);
          return;
        }
        if (last) intervals.push(now - last);
        last = now;
        // Sweep across the map while zooming in and out.
        const z = 0.55 * Math.exp(0.75 * Math.sin(t * Math.PI * 4));
        camera.cx = cx0 + ax * Math.sin(t * Math.PI * 2);
        camera.cy = cy0 + ay * Math.sin(t * Math.PI * 3 + 1);
        camera.zoom = z;
        renderer.setCamera(camera);
        renderer.render();
        cpu.push(renderer.stats.cpuMs);
        labelsDrawn.push(renderer.stats.labelsDrawn);
        frames++;
        pendingEnd = requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  onMount(() => {
    let disposed = false;
    camera = new Camera({ zoom: 0.6 });
    renderer = new Renderer(canvas, { onFrame });
    controller = new CameraController(canvas, camera, {
      onChange: () => {
        renderer.setCamera(camera);
      }
    });
    (async () => {
      const q = new URLSearchParams(location.search);
      if (q.get('scene') === 'features') {
        sceneKind = 'features';
        flags = { shadows: true, surface: true, canvas: true };
      }
      for (const key of ['shadows', 'surface', 'canvas'] as const) {
        if (q.has(key)) flags[key] = q.get(key) !== '0';
      }
      hud.status = 'generating images';
      imageUrls = await makeImageUrls(300);
      if (disposed) return;
      buildScene();
      resetView();
      const w = window as unknown as Record<string, unknown>;
      w.__radiant = { renderer, camera, runBench, setFeatures, setSceneKind, ready: true };
      if (q.has('autobench')) {
        await new Promise((r) => setTimeout(r, 500));
        const a = await runBench('cold');
        const b = await runBench('warm');
        w.__radiantBench = [a, b];
      }
    })();
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'f') fitAll();
      if (e.key === '0') camera.animateTo({ cx: camera.cx, cy: camera.cy, zoom: 1 }, 250);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      disposed = true;
      window.removeEventListener('keydown', onKey);
      controller.destroy();
      renderer.destroy();
      for (const u of imageUrls) URL.revokeObjectURL(u);
    };
  });
</script>

<svelte:head><title>Radiant render demo</title></svelte:head>

<canvas bind:this={canvas}></canvas>

<div class="hud">
  <div class="row"><b>Radiant render demo</b> <span class="dim">{hud.status}</span></div>
  <div class="row mono">
    fps {hud.fps.toString().padStart(3)} &nbsp; cpu {hud.cpu.toFixed(2)} ms &nbsp; draws {hud.draws} &nbsp;
    labels {hud.labels} (+{hud.greeked} bars) &nbsp; rects {hud.rects} &nbsp; images {hud.images} &nbsp;
    textures {hud.textures} &nbsp; pending {hud.pending} &nbsp; zoom {hud.zoom.toFixed(2)}
  </div>
  <div class="row dim mono">{info}</div>
  <div class="row">
    <button onclick={() => runBench()} disabled={running}>{running ? 'Running 5 s…' : 'Run 5 s pan + zoom test'}</button>
    <button onclick={fitAll}>Fit all (f)</button>
    <button onclick={resetView}>Reset view</button>
    <label><input type="checkbox" checked={farOrigin} onchange={toggleOrigin} /> far from origin (+2,000,000)</label>
  </div>
  <div class="row">
    <label><input type="checkbox" checked={sceneKind === 'features'}
      onchange={(e) => setSceneKind(e.currentTarget.checked ? 'features' : 'synthetic')} /> feature scene</label>
    <label><input type="checkbox" checked={flags.shadows} onchange={(e) => setFeatures({ shadows: e.currentTarget.checked })} /> shadows</label>
    <label><input type="checkbox" checked={flags.surface} onchange={(e) => setFeatures({ surface: e.currentTarget.checked })} /> surface</label>
    <label><input type="checkbox" checked={flags.canvas} onchange={(e) => setFeatures({ canvas: e.currentTarget.checked })} /> canvas bands</label>
  </div>
  <div class="row dim">Two-finger scroll pans, pinch or Cmd/Alt+wheel zooms, Space+drag or middle-drag pans.</div>
  {#each results as r}
    <div class="row mono result">{r}</div>
  {/each}
</div>

<style>
  :global(html, body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
    overscroll-behavior: none;
  }
  canvas {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    display: block;
    touch-action: none;
  }
  .hud {
    position: fixed;
    left: 12px;
    top: 12px;
    max-width: min(920px, calc(100vw - 24px));
    padding: 8px 12px;
    background: rgba(20, 22, 28, 0.82);
    color: #eef;
    font: 12px/1.4 system-ui, sans-serif;
    border-radius: 8px;
    user-select: none;
  }
  .row {
    margin: 2px 0;
  }
  .mono {
    font-family: ui-monospace, Menlo, monospace;
    white-space: pre-wrap;
  }
  .dim {
    opacity: 0.65;
  }
  .result {
    color: #9fe;
  }
  button {
    margin-right: 6px;
  }
</style>
