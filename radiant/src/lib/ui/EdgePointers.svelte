<script lang="ts">
  import type { AppController } from './controller.svelte';
  import type { Rect } from '../core/types';
  import { subtreeBounds } from '../core/layout';

  let { c }: { c: AppController } = $props();

  /** Maps and frames that can be off screen, with their titles (CNV-03). */
  const targets = $derived.by(() => {
    void c.layoutTick;
    void c.rev;
    if (c.canvasView) return [];
    const doc = c.doc, layout = c.pipeline.layout;
    const out: Array<{ id: string; title: string; rect: Rect }> = [];
    for (const root of doc.roots) {
      if (!layout.boxes.has(root)) continue;
      out.push({ id: root, title: doc.nodes[root]?.text.trim() || 'Untitled map', rect: subtreeBounds(layout, doc, root) });
    }
    for (const { el, x, y, w, h } of c.pipeline.canvas.index.entries()) {
      if (el.kind === 'frame') out.push({ id: el.id, title: el.text?.trim() || 'Frame', rect: { x, y, w, h } });
    }
    return out.length > 1 || (out.length === 1 && out[0].rect) ? out : [];
  });

  /** Pointers at the viewport edge in the direction of each target that is wholly out of view. */
  const pointers = $derived.by(() => {
    void c.camTick;
    if (!targets.length) return [];
    const view = c.camera.visibleRect();
    const ins = c.insets();
    const W = c.camera.width, H = c.camera.height;
    const left = ins.l + 28, right = W - ins.r - 28, top = ins.t + 20, bottom = H - ins.b - 70;
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const out = [];
    for (const t of targets) {
      const r = t.rect;
      if (r.x < view.x + view.w && r.x + r.w > view.x && r.y < view.y + view.h && r.y + r.h > view.y) continue;
      const centre = c.camera.worldToScreen({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, { x: 0, y: 0 });
      const dx = centre.x - cx, dy = centre.y - cy;
      const scale = Math.min(dx ? (dx > 0 ? right - cx : left - cx) / dx : Infinity, dy ? (dy > 0 ? bottom - cy : top - cy) / dy : Infinity);
      if (!Number.isFinite(scale)) continue;
      out.push({ ...t, x: cx + dx * scale, y: cy + dy * scale, angle: Math.atan2(dy, dx), distance: Math.hypot(dx, dy) });
    }
    return out.sort((a, b) => a.distance - b.distance).slice(0, 12);
  });
</script>

{#each pointers as p (p.id)}
  <button type="button" class="edge-pointer" style:left={p.x + 'px'} style:top={p.y + 'px'}
    title={'Go to ' + p.title} aria-label={'Go to ' + p.title} onclick={() => c.fitRect(p.rect, 1.5)}>
    <svg viewBox="0 0 12 12" aria-hidden="true" style:transform={`rotate(${p.angle}rad)`}><path d="M2 2l8 4-8 4z" /></svg>
    <span>{p.title}</span>
  </button>
{/each}

<style>
  .edge-pointer {
    position: absolute;
    z-index: 4;
    transform: translate(-50%, -50%);
    display: flex;
    align-items: center;
    gap: 4px;
    max-width: 160px;
    padding: 3px 8px 3px 5px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    color: var(--text);
    font-size: 11px;
    cursor: pointer;
    opacity: .85;
  }
  .edge-pointer:hover { opacity: 1; }
  svg { width: 10px; height: 10px; flex: none; fill: var(--accent); }
  span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
