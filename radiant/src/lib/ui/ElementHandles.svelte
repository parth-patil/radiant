<script lang="ts">
  import type { AppController } from './controller.svelte';
  import type { CanvasElement, Vec2 } from '../core/types';
  import { isLinear } from '../core/geometry/sketch';
  import { boxCentre, elementBox, elementCorners, HANDLES, selectionBounds, type Handle } from './canvas-ops';

  let { c }: { c: AppController } = $props();
  const t = $derived(c.canvasTools);

  /** Selection outlines, resize and rotate handles, line end handles, the in-place text editor and the laser trail. */
  const view = $derived.by(() => {
    void c.camTick;
    void c.rev;
    void t.tick;
    const ids = t.selected;
    const resolved = c.pipeline?.canvas.scene?.points;
    // Lines and arrows are outlined where they are drawn (bound ends and elbow routes resolved).
    const els = ids.map((id) => t.live(id)).filter((el): el is CanvasElement => !!el)
      .map((el) => isLinear(el.kind) && resolved?.has(el.id) ? { ...el, points: resolved.get(el.id) } : el);
    const screen = (p: Vec2) => c.camera.worldToScreen(p, { x: 0, y: 0 });
    const outlines = els.map((el) => ({ id: el.id, locked: !!el.locked, points: elementCorners(el).map(screen) }));
    let frame: { corners: Vec2[]; handles: Array<{ id: Handle; at: Vec2 }>; rotate: Vec2; angle: number } | null = null;
    let ends: Array<{ end: 'start' | 'end'; at: Vec2 }> = [];
    const movable = els.filter((el) => !el.locked);
    const busy = t.busy;
    if (movable.length === 1 && isLinear(movable[0].kind) && !movable[0].angle) {
      const el = movable[0];
      const points = c.pipeline?.canvas.scene?.points.get(el.id) ?? el.points ?? [0, 0, el.w, el.h];
      const n = points.length;
      ends = [
        { end: 'start', at: screen({ x: el.x + points[0], y: el.y + points[1] }) },
        { end: 'end', at: screen({ x: el.x + points[n - 2], y: el.y + points[n - 1] }) }
      ];
    } else if (movable.length) {
      const single = movable.length === 1 ? movable[0] : null;
      const box = single ? elementBox(single) : selectionBounds(movable)!;
      const angle = single?.angle ?? 0;
      const centre = boxCentre(box);
      const at = (sx: number, sy: number) => {
        const x = sx * box.w / 2, y = sy * box.h / 2;
        return screen({ x: centre.x + x * Math.cos(angle) - y * Math.sin(angle), y: centre.y + x * Math.sin(angle) + y * Math.cos(angle) });
      };
      const signs: Record<Handle, [number, number]> = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
      const z = c.camera.zoom;
      const offset = 22 / Math.max(z, 1e-4) / Math.max(box.h / 2, 1e-6);
      // Small elements show only the corner handles.
      const small = Math.min(box.w, box.h) * z < 24;
      frame = {
        corners: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)],
        handles: HANDLES.filter((h) => !small || h.length === 2).map((id) => ({ id, at: at(...signs[id]) })),
        rotate: at(0, -1 - offset),
        angle
      };
    }
    return { outlines, frame, ends, busy };
  });

  const editor = $derived.by(() => {
    void c.camTick;
    const edit = t.editing;
    if (!edit) return null;
    const style = t.textStyle(edit);
    const z = c.camera.zoom;
    const el = edit.id ? c.doc.canvas?.elements.find((x) => x.id === edit.id) : undefined;
    let centre: Vec2, width: number, angle = 0, anchor: 'left' | 'center' = 'center';
    if (!el) {
      centre = { x: edit.at!.x, y: edit.at!.y };
      width = 320;
      anchor = 'left';
    } else if (isLinear(el.kind)) {
      const points = c.pipeline?.canvas.scene?.points.get(el.id) ?? el.points ?? [0, 0, el.w, el.h];
      const n = points.length;
      const i = Math.max(0, Math.floor((n / 2 - 1) / 2) * 2);
      centre = n >= 4 ? { x: el.x + (points[i] + points[i + 2]) / 2, y: el.y + (points[i + 1] + points[i + 3]) / 2 } : { x: el.x, y: el.y };
      width = 220;
    } else if (el.kind === 'frame') {
      centre = { x: el.x, y: el.y - 6 - style.size * 0.625 };
      width = Math.max(120, Math.abs(el.w));
      anchor = 'left';
    } else if (el.kind === 'text') {
      centre = { x: el.x, y: el.y + Math.abs(el.h) / 2 };
      width = Math.max(Math.abs(el.w) + style.size * 4, 160);
      anchor = 'left';
      angle = el.angle ?? 0;
    } else {
      const box = elementBox(el);
      centre = boxCentre(box);
      const inset = el.kind === 'note' ? 24 : el.kind === 'ellipse' ? box.w - box.w / Math.SQRT2 + 10 : el.kind === 'diamond' ? box.w / 2 + 10 : 10;
      width = Math.max(40, box.w - inset);
      angle = el.angle ?? 0;
    }
    const p = c.camera.worldToScreen(centre, { x: 0, y: 0 });
    const lines = Math.max(1, edit.text.split('\n').length);
    return {
      left: p.x, top: p.y, width: width * z, size: style.size * z, family: style.family,
      align: style.align, color: style.color, anchor, angle, height: lines * style.size * 1.25 * z + 4
    };
  });

  const laser = $derived.by(() => {
    void c.camTick;
    const now = performance.now();
    return t.laser.map((p) => ({ ...c.camera.worldToScreen(p, { x: 0, y: 0 }), a: Math.max(0, 1 - (now - p.t) / 1000) }));
  });

  function focusEditor(node: HTMLTextAreaElement) {
    requestAnimationFrame(() => {
      node.focus({ preventScroll: true });
      node.select();
    });
  }
</script>

{#if view.outlines.length || laser.length}
  <svg class="element-handles" aria-hidden="true">
    {#each view.outlines as o (o.id)}
      <polygon points={o.points.map((p) => p.x + ',' + p.y).join(' ')} class="outline" class:locked={o.locked} />
    {/each}
    {#if view.frame && !view.busy}
      {#if view.outlines.length > 1}
        <polygon points={view.frame.corners.map((p) => p.x + ',' + p.y).join(' ')} class="outline group" />
      {/if}
      <line x1={(view.frame.corners[0].x + view.frame.corners[1].x) / 2} y1={(view.frame.corners[0].y + view.frame.corners[1].y) / 2}
        x2={view.frame.rotate.x} y2={view.frame.rotate.y} class="stem" />
      <circle cx={view.frame.rotate.x} cy={view.frame.rotate.y} r="5" class="handle rotate" role="presentation"
        onpointerdown={(e) => { e.stopPropagation(); t.startRotate(e); }} />
      {#each view.frame.handles as h (h.id)}
        <rect x={h.at.x - 4} y={h.at.y - 4} width="8" height="8" rx="1.5" class="handle h-{h.id}" role="presentation"
          transform={`rotate(${view.frame.angle * 180 / Math.PI} ${h.at.x} ${h.at.y})`}
          onpointerdown={(e) => { e.stopPropagation(); t.startResize(e, h.id); }} />
      {/each}
    {/if}
    {#if !view.busy}
      {#each view.ends as end (end.end)}
        <circle cx={end.at.x} cy={end.at.y} r="5.5" class="handle end" role="presentation"
          onpointerdown={(e) => { e.stopPropagation(); t.startEndpoint(e, t.selected[0], end.end); }} />
      {/each}
    {/if}
    {#if laser.length > 1}
      {#each laser.slice(1) as p, i (i)}
        <line x1={laser[i].x} y1={laser[i].y} x2={p.x} y2={p.y} class="laser" style:opacity={p.a} />
      {/each}
    {/if}
  </svg>
{/if}

{#if editor && t.editing}
  <textarea class="element-editor" data-element-editor="" spellcheck="true" aria-label="Element text" use:focusEditor
    style:left={editor.left + 'px'} style:top={editor.top + 'px'} style:width={editor.width + 'px'}
    style:height={editor.height + 'px'} style:font-size={editor.size + 'px'} style:font-family={editor.family}
    style:text-align={editor.align} style:color={editor.color}
    style:transform={`translate(${editor.anchor === 'left' ? 0 : -50}%, -50%) rotate(${editor.angle}rad)`}
    value={t.editing.text}
    oninput={(e) => { if (t.editing) t.editing = { ...t.editing, text: e.currentTarget.value }; }}
    onblur={(e) => t.finishText(e.currentTarget.value)}></textarea>
{/if}

<style>
  .element-handles { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 3; }
  .outline { fill: none; stroke: var(--accent); stroke-width: 1.25; vector-effect: non-scaling-stroke; }
  .outline.group { stroke-dasharray: 4 3; }
  .outline.locked { stroke-dasharray: 2 3; stroke: var(--text-dim); }
  .stem { stroke: var(--accent); stroke-width: 1; }
  .handle { fill: var(--panel-solid); stroke: var(--accent); stroke-width: 1.5; pointer-events: all; }
  .h-n, .h-s { cursor: ns-resize; }
  .h-e, .h-w { cursor: ew-resize; }
  .h-nw, .h-se { cursor: nwse-resize; }
  .h-ne, .h-sw { cursor: nesw-resize; }
  .handle.rotate { cursor: grab; }
  .handle.end { cursor: move; }
  .laser { stroke: #ff3b30; stroke-width: 4; stroke-linecap: round; }
  .element-editor {
    position: absolute;
    z-index: 4;
    margin: 0;
    padding: 0;
    border: 0;
    outline: 1px dashed var(--accent);
    background: transparent;
    color: var(--text);
    line-height: 1.25;
    resize: none;
    overflow: hidden;
    white-space: pre-wrap;
    transform-origin: center;
    user-select: text;
    -webkit-user-select: text;
  }
</style>
