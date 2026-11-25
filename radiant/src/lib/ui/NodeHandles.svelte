<script lang="ts">
  // Small round buttons where a node's children branch out.
  // Fold ("−"): on the node under the pointer and on the one selected node; a folded node shows its count badge
  // instead, which unfolds it. Generate (sparkle): on the one selected node; opens Generate aimed at that node.
  import type { NodeId } from '../core/types';
  import type { AppController } from './controller.svelte';
  import Icon from './Icon.svelte';

  let { c }: { c: AppController } = $props();
  const SIZE = 16;
  const GAP = 3;
  const GENERATE = 20;
  /** Room kept for a folded node's count badge, which the canvas draws at the same place. */
  const BADGE = 30;
  // The handle sits outside the node, so it lingers while the pointer travels from the node to it.
  let lingering = $state<NodeId | null>(null);
  let over = false;
  let pressed = $state(false);
  let timer = 0;
  function release() {
    clearTimeout(timer);
    timer = window.setTimeout(() => { if (!over && !c.hoverNode) lingering = null; }, 500);
  }
  $effect(() => {
    const id = c.hoverNode;
    if (id) {
      clearTimeout(timer);
      lingering = id;
    } else release();
    return () => clearTimeout(timer);
  });

  const handles = $derived.by(() => {
    void c.rev; void c.layoutTick; void c.camTick; void c.selTick;
    if (!c.ready || c.presenting || pressed || c.canvasTools.tool !== 'select' || c.camera.zoom < 0.3) return [];
    const ids = new Set<NodeId>();
    if (lingering) ids.add(lingering);
    if (c.focusId && c.selIds.length === 1) ids.add(c.focusId);
    const out: { id: NodeId; x: number; y: number; text: string }[] = [];
    for (const id of ids) {
      const node = c.doc.nodes[id];
      if (!node || !node.children.length || node.collapsed || c.editingId === id) continue;
      const at = c.pipeline.foldAnchor(id);
      if (!at) continue;
      const point = c.camera.worldToScreen(at);
      const x = point.x + at.dx * (SIZE / 2 + GAP);
      const y = point.y + at.dy * (SIZE / 2 + GAP);
      if (x < 0 || y < 0 || x > c.camera.width || y > c.camera.height) continue;
      out.push({ id, x, y, text: node.text || 'Unnamed node' });
    }
    return out;
  });

  const generate = $derived.by(() => {
    void c.rev; void c.layoutTick; void c.camTick; void c.selTick;
    const id = c.focusId;
    if (!c.ready || c.presenting || pressed || c.gen || c.canvasTools.tool !== 'select' || c.camera.zoom < 0.3) return null;
    if (!id || c.selIds.length !== 1 || c.editingId === id) return null;
    const node = c.doc.nodes[id];
    const at = node && c.pipeline.foldAnchor(id);
    if (!node || !at) return null;
    // Past the fold button or the count badge when the node has children.
    const taken = !node.children.length ? 0 : node.collapsed ? BADGE : SIZE + GAP;
    const point = c.camera.worldToScreen(at);
    const x = point.x + at.dx * (GAP + taken + GENERATE / 2);
    const y = point.y + at.dy * (GAP + taken + GENERATE / 2);
    if (x < 0 || y < 0 || x > c.camera.width || y > c.camera.height) return null;
    return { id, x, y, text: node.text || 'Unnamed node' };
  });

  // Hidden during any drag on the canvas: the node moves under the pointer and the handle would stay behind.
  function down(event: PointerEvent) {
    if (!(event.target instanceof Element && event.target.closest('.fold-handle, .generate-handle'))) pressed = true;
  }
</script>

<svelte:window onpointerdowncapture={down} onpointerupcapture={() => (pressed = false)} onpointercancelcapture={() => (pressed = false)} />
{#each handles as handle (handle.id)}
  <button type="button" class="fold-handle" tabindex="-1" title="Fold this branch (⌘.)" aria-label={'Fold ' + handle.text}
    style:left={handle.x + 'px'} style:top={handle.y + 'px'}
    onmousedown={(event) => event.preventDefault()}
    onpointerenter={() => (over = true)}
    onpointerleave={() => { over = false; release(); }}
    onclick={() => { over = false; c.toggleFoldOf(handle.id); }}></button>
{/each}
{#if generate}
  <button type="button" class="generate-handle" tabindex="-1" title="Generate a subtree here with AI (⌘G)"
    aria-label={'Generate a subtree under ' + generate.text}
    style:left={generate.x + 'px'} style:top={generate.y + 'px'}
    onmousedown={(event) => event.preventDefault()}
    onclick={() => c.togglePrompt(true)}><Icon name="sparkle" size={12} /></button>
{/if}

<style>
  .fold-handle {
    position: absolute;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    min-width: 0;
    margin: -8px 0 0 -8px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--text) 60%, transparent);
    border-radius: 50%;
    color: var(--text);
    background: var(--panel-solid);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    cursor: pointer;
  }
  .fold-handle::before {
    content: '';
    width: 8px;
    height: 1.5px;
    border-radius: 1px;
    background: currentColor;
  }
  .generate-handle {
    position: absolute;
    box-sizing: border-box;
    width: 20px;
    height: 20px;
    min-width: 0;
    margin: -10px 0 0 -10px;
    padding: 0;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--accent) 70%, transparent);
    border-radius: 50%;
    color: var(--accent);
    background: var(--panel-solid);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    cursor: pointer;
  }
  .generate-handle:hover {
    color: #fff;
    background: var(--accent);
  }
  .fold-handle:hover {
    border-color: var(--accent);
    color: #fff;
    background: var(--accent);
  }
</style>
