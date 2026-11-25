<script lang="ts">
  import type { Doc, NodeId, Rect } from '../core/types';
  import type { AppController } from './controller.svelte';
  import { clampImageScale } from './pipeline';

  let { c }: { c: AppController } = $props();
  type Corner = -1 | 1;
  interface Drag {
    doc: Doc;
    id: NodeId;
    hash: string;
    pointer: number;
    side: Corner;
    screen: Rect;
    x: number;
    y: number;
    originalScale: number;
    scale: number;
  }
  let drag = $state.raw<Drag | null>(null);
  const handle = $derived.by(() => {
    void c.rev; void c.layoutTick; void c.camTick; void c.selTick;
    const id = c.focusId;
    if (!id || c.selIds.length !== 1 || c.editingId || c.presenting) return null;
    const picture = c.pipeline?.attachmentRect(id);
    const file = c.doc.nodes[id];
    if (!picture || !file?.imageAsset) return null;
    const { x, y } = c.camera.worldToScreen(picture);
    const w = picture.w * c.camera.zoom;
    const h = picture.h * c.camera.zoom;
    if (w < 12 || h < 12 || x + w < 0 || y + h < 0 || x > c.camera.width || y > c.camera.height) return null;
    return { id, hash: file.imageAsset, box: { x, y, w, h }, scale: file.imageScale ?? 1, name: file.imageAlt ?? file.text };
  });
  const bounds = $derived.by(() => {
    if (!drag) return handle?.box;
    const factor = drag.scale / drag.originalScale;
    const { x, y, w, h } = drag.screen;
    return { x: x + (1 - factor) * w / 2, y: y + (1 - factor) * h / 2, w: w * factor, h: h * factor };
  });

  function start(event: PointerEvent & { currentTarget: HTMLButtonElement }, side: Corner) {
    if (event.button !== 0 || !handle || drag) return;
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag = { doc: c.doc, id: handle.id, hash: handle.hash, pointer: event.pointerId, side,
      screen: handle.box, x: event.clientX, y: event.clientY, originalScale: handle.scale, scale: handle.scale };
  }

  function move(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    const { w, h } = drag.screen;
    const delta = (event.clientX - drag.x) * w + (event.clientY - drag.y) * h;
    drag = { ...drag, scale: clampImageScale(drag.originalScale * (1 + drag.side * 2 * delta / (w * w + h * h))) };
  }

  function finish(event: PointerEvent, cancel = false) {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!cancel) move(event);
    const completed = drag;
    drag = null;
    if (!cancel && completed && completed.doc === c.doc && c.doc.nodes[completed.id]?.imageAsset === completed.hash) {
      c.resizeImage(completed.id, completed.scale);
    }
  }

  function key(event: KeyboardEvent) {
    const step = event.shiftKey ? 0.2 : 0.05;
    const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowDown'].includes(event.key) ? -1 : 0;
    if (event.key === 'Escape' && drag) { drag = null; event.stopPropagation(); return; }
    if (!direction || !handle) return;
    event.preventDefault(); event.stopPropagation();
    c.resizeImage(handle.id, handle.scale + direction * step);
  }
</script>

{#if bounds && (handle || drag)}
  <div class="picture-controls" style:left={`${bounds.x}px`} style:top={`${bounds.y}px`}
    style:width={`${bounds.w}px`} style:height={`${bounds.h}px`} class:dragging={!!drag}>
    {#each [-1, 1] as side (side)}
      <button type="button" class:near={side === -1} aria-label={`Resize picture from ${side === -1 ? 'top left' : 'bottom right'}${handle?.name ? ': ' + handle.name : ''}`} title="Drag to resize or use the arrow keys"
        onpointerdown={(event) => start(event, side as Corner)} onpointermove={move} onpointerup={finish}
        onpointercancel={(event) => finish(event, true)} onkeydown={key}></button>
    {/each}
    {#if drag}<output>{Math.round(drag.scale * 100)}%</output>{/if}
  </div>
{/if}

<style>
  .picture-controls { position: absolute; pointer-events: none; outline: 1px solid #3b82f6; z-index: 1; }
  .picture-controls.dragging { background: #3b82f620; outline-style: dashed; }
  button { position: absolute; pointer-events: auto; touch-action: none; right: -12px; bottom: -12px; width: 24px; height: 24px; border: 0; padding: 0; background: transparent; cursor: nwse-resize; }
  button::before { content: ''; position: absolute; inset: 6px; border: 1px solid #2563eb; border-radius: 3px; background: white; }
  button.near { right: auto; bottom: auto; left: -12px; top: -12px; }
  button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  output { position: absolute; left: 50%; top: 100%; margin-top: 10px; transform: translateX(-50%); padding: 2px 6px; border-radius: 5px; color: #fff; background: #1d4ed8; font-size: 11px; }
</style>
