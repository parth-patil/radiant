<script lang="ts">
  import { inkFrame, inkPath, inkStrokeAt, INK_HEIGHT, INK_WIDTH, MAX_INK_POINTS, MAX_INK_STROKES, type InkPoint, type InkStroke } from '../core/geometry/ink';
  import type { Doc, NodeId } from '../core/types';
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();
  let draft = $state.raw<{ doc: Doc; id: NodeId; pointer: number; stroke: InkStroke } | null>(null);
  const active = $derived.by(() => {
    void c.rev; void c.layoutTick; void c.camTick;
    const id = c.sketchTarget;
    if (!id || c.theme.lean || c.presenting || c.editingId) return null;
    const node = c.doc.nodes[id];
    const box = c.pipeline?.box(id);
    if (!node || !box) return null;
    const placement = node.sketch?.placement ?? c.inkPlacement;
    const frame = inkFrame(box, placement);
    const { x, y } = c.camera.worldToScreen(frame);
    return { id, placement, x, y, w: frame.w * c.camera.zoom, h: frame.h * c.camera.zoom, sketch: node.sketch };
  });
  $effect(() => {
    if (draft && (draft.doc !== c.doc || active?.id !== draft.id)) draft = null;
  });
  const ghost = $derived(draft ? inkPath(draft.stroke, { x: 0, y: 0, w: INK_WIDTH, h: INK_HEIGHT }, (n) => n.toFixed(2)) : '');
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const sample = (event: PointerEvent, bounds: DOMRect, fallback = .65): InkPoint => ({
    x: clamp((event.clientX - bounds.left) / bounds.width),
    y: clamp((event.clientY - bounds.top) / bounds.height),
    pressure: event.pointerType !== 'mouse' && event.pressure > 0 ? clamp(event.pressure) : fallback
  });

  function start(event: PointerEvent & { currentTarget: HTMLButtonElement }) {
    const stylusEraser = event.pointerType === 'pen' && (event.button === 5 || (event.buttons & 32) !== 0);
    if (!active || (event.button !== 0 && !stylusEraser) || draft) return;
    event.preventDefault();
    event.stopPropagation();
    const pad = event.currentTarget;
    pad.focus({ preventScroll: true });
    c.camera.cancelAnimation();
    const point = sample(event, pad.getBoundingClientRect());
    if (c.inkTool === 'erase' || stylusEraser) {
      erase(point);
      return;
    }
    if ((active.sketch?.strokes.length ?? 0) >= MAX_INK_STROKES) return;
    pad.setPointerCapture(event.pointerId);
    draft = { doc: c.doc, id: active.id, pointer: event.pointerId, stroke: { color: c.inkColor, width: c.inkWidth, points: [point] } };
  }

  function erase(point: InkPoint) {
    if (!active) return;
    const id = active.id;
    c.updateSketch(id, 'Erase Ink Stroke', (previous) => {
      if (!previous) return previous;
      const index = inkStrokeAt(previous.strokes, point, 6);
      if (index < 0) return previous;
      const strokes = previous.strokes.filter((_, i) => i !== index);
      return strokes.length ? { ...previous, strokes } : undefined;
    });
  }

  function move(event: PointerEvent & { currentTarget: HTMLButtonElement }) {
    if (!draft || draft.pointer !== event.pointerId) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const points = [...draft.stroke.points];
    const coalesced = event.getCoalescedEvents?.() ?? [];
    for (const physical of coalesced.length ? coalesced : [event]) {
      if (points.length >= MAX_INK_POINTS) break;
      const last = points.at(-1)!;
      const point = sample(physical, bounds, last.pressure);
      if (Math.hypot((last.x - point.x) * INK_WIDTH, (last.y - point.y) * INK_HEIGHT) >= .8) points.push(point);
    }
    draft = { ...draft, stroke: { ...draft.stroke, points } };
  }

  function finish(event: PointerEvent & { currentTarget: HTMLButtonElement }, cancel = false) {
    if (!draft || draft.pointer !== event.pointerId) return;
    if (!cancel) move(event);
    const completed = draft;
    draft = null;
    if (cancel || completed.doc !== c.doc || active?.id !== completed.id) return;
    const placement = active.placement;
    c.updateSketch(completed.id, 'Draw Ink Stroke', (previous) => {
      const strokes = previous?.strokes ?? [];
      return strokes.length < MAX_INK_STROKES ? { placement: previous?.placement ?? placement, strokes: [...strokes, completed.stroke] } : previous;
    });
  }

  function close(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !active) return;
    event.preventDefault();
    event.stopPropagation();
    draft = null;
    c.sketchTarget = null;
  }
</script>

{#if active}
  <button type="button" class="ink-pad" class:erase={c.inkTool === 'erase'}
    aria-label="Node sketch drawing area" style:left={active.x + 'px'} style:top={active.y + 'px'}
    style:width={active.w + 'px'} style:height={active.h + 'px'}
    onpointerdown={start} onpointermove={move} onpointerup={finish}
    onpointercancel={(event) => finish(event, true)} onlostpointercapture={(event) => finish(event, true)}
    onkeydown={close}>
    <svg viewBox={`0 0 ${INK_WIDTH} ${INK_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      {#if ghost && draft}<path d={ghost} fill={draft.stroke.color} />{/if}
    </svg>
  </button>
{/if}

<style>
  .ink-pad { position: absolute; z-index: 2; touch-action: none; cursor: crosshair; padding: 0; border: 0; outline: 1px dashed #2563eb; background: transparent; }
  .ink-pad.erase { cursor: cell; }
  .ink-pad:focus-visible { outline: 2px solid #2563eb; }
  svg { display: block; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
</style>
