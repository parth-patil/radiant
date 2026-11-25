<script lang="ts">
  import type { AppController } from './controller.svelte';
  import type { Rect, Vec2 } from '../core/types';

  let { c }: { c: AppController } = $props();
  let svg: SVGSVGElement;
  let drag = $state.raw<{ id: number; frame: Rect; offset: Vec2 } | null>(null);

  const aspect = 192 / 128;
  const map = $derived.by(() => {
    void c.layoutTick;
    void c.canvasView;
    void c.rev;
    const { bounds, boxes } = c.pipeline.canvasLayout;
    const rect = (x: number, y: number, w: number, h: number) =>
      `M${x.toFixed(2)} ${y.toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}h-${w.toFixed(2)}Z`;
    const path: string[] = [];
    for (const b of boxes.values()) path.push(rect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h));
    // CNV-02: every canvas element too, and the preview frames them all.
    const elements: string[] = [];
    if (!c.canvasView) for (const { x, y, w, h } of c.pipeline.canvas.index.entries()) elements.push(rect(x, y, w, h));
    const all = c.canvasView ? null : c.canvasTools.everything();
    return { bounds: all ?? bounds, nodes: path.join(''), elements: elements.join('') };
  });
  const viewport = $derived.by(() => {
    void c.camTick;
    return c.camera.visibleRect();
  });

  function fitPreview(bounds: Rect, view: Rect): Rect {
    const x = Math.min(bounds.x, view.x);
    const y = Math.min(bounds.y, view.y);
    const right = Math.max(bounds.x + bounds.w, view.x + view.w);
    const bottom = Math.max(bounds.y + bounds.h, view.y + view.h);
    const w = right - x;
    const h = bottom - y;
    const width = Math.max(w, h * aspect, 1) * 1.12;
    const height = width / aspect;
    return { x: x + (w - width) / 2, y: y + (h - height) / 2, w: width, h: height };
  }

  const frame = $derived(drag?.frame ?? fitPreview(map.bounds, viewport));

  function world(e: PointerEvent): Vec2 {
    const transform = svg.getScreenCTM()?.inverse();
    if (!transform) return { x: c.camera.cx, y: c.camera.cy };
    return new DOMPoint(e.clientX, e.clientY).matrixTransform(transform);
  }

  function down(e: PointerEvent) {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    const button = e.currentTarget as HTMLButtonElement;
    button.focus({ preventScroll: true });
    const p = world(e);
    const inside = p.x >= viewport.x && p.x <= viewport.x + viewport.w
      && p.y >= viewport.y && p.y <= viewport.y + viewport.h;
    drag = {
      id: e.pointerId,
      frame,
      offset: inside ? { x: c.camera.cx - p.x, y: c.camera.cy - p.y } : { x: 0, y: 0 }
    };
    button.setPointerCapture(e.pointerId);
    move(e);
  }

  function move(e: PointerEvent) {
    if (!drag || drag.id !== e.pointerId) return;
    const p = world(e);
    c.camera.set({ cx: p.x + drag.offset.x, cy: p.y + drag.offset.y, zoom: c.camera.zoom });
  }

  function end(e: PointerEvent) {
    if (drag?.id === e.pointerId) drag = null;
  }

  function onKey(e: KeyboardEvent) {
    const hops: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const hop = hops[e.key];
    if (!hop) return;
    e.stopPropagation();
    e.preventDefault();
    c.camera.set({ cx: c.camera.cx + viewport.w * hop[0] / 4, cy: c.camera.cy + viewport.h * hop[1] / 4, zoom: c.camera.zoom });
  }
</script>

<button class="minimap" class:with-outline={c.showOutline} class:dragging={drag}
  type="button" aria-label="Minimap. Drag or use arrow keys to pan" title="Minimap"
  onpointerdown={down} onpointermove={move} onpointerup={end} onpointercancel={end}
  onlostpointercapture={end} onkeydown={onKey}>
  <svg bind:this={svg} aria-hidden="true" viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}>
    <path d={map.elements} class="elements" />
    <path d={map.nodes} class="nodes" />
    <rect x={viewport.x} y={viewport.y} width={viewport.w} height={viewport.h}
      class="viewport" vector-effect="non-scaling-stroke" />
  </svg>
</button>

<style>
  .minimap {
    position: absolute;
    z-index: 5;
    left: 12px;
    bottom: 34px;
    width: 194px;
    padding: 0;
    display: grid;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 9px;
    box-shadow: var(--shadow);
    background: var(--panel-solid);
    cursor: grab;
    touch-action: none;
  }
  .with-outline {
    left: 272px;
  }
  .dragging {
    cursor: grabbing;
  }
  svg {
    display: block;
    width: 100%;
    aspect-ratio: 3 / 2;
    pointer-events: none;
  }
  .nodes {
    fill: var(--text-dim);
    opacity: .55;
  }
  .elements {
    fill: var(--accent);
    opacity: .3;
  }
  .viewport {
    fill: var(--accent);
    fill-opacity: .12;
    stroke: var(--accent);
    stroke-width: 1.5;
  }
  @media (max-width: 550px) {
    .with-outline {
      left: auto;
      right: 12px;
      width: min(194px, 36vw);
    }
  }
</style>
