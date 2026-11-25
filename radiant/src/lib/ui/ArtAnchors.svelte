<script lang="ts">
  import type { NodeArt, NodeId, Vec2 } from '../core/types';
  import type { AppController } from './controller.svelte';

  type Placement = 'in' | 'out';
  interface Drag {
    placement: Placement;
    pointer: number;
    start: Vec2;
    origin: Vec2;
    current: Vec2;
  }
  let { c, nodeId, art, kind }: { c: AppController; nodeId: NodeId; art: NodeArt; kind: 'picture' | 'svg' } = $props();
  let url = $state('');
  let stage = $state<HTMLDivElement>();
  let child = $state('');
  let dragging = $state<Drag | null>(null);
  const choices = $derived.by(() => {
    void c.rev;
    return (c.doc.nodes[nodeId]?.children ?? []).map((id) => ({ id, text: c.doc.nodes[id]?.text || 'Untitled node' }));
  });
  const defaults = { in: { x: 0.05, y: 0.5 }, out: { x: 0.95, y: 0.5 } };
  const inward = $derived(dragging?.placement === 'in' ? dragging.current : art.anchors?.in ?? defaults.in);
  const outward = $derived(dragging?.placement === 'out' ? dragging.current :
    art.anchors?.outByChild?.[child] ?? art.anchors?.out ?? defaults.out);

  $effect(() => {
    const hash = art.assetHash;
    let active = true;
    url = '';
    void c.host.assetUrl(hash).then((assetUrl) => {
      if (active) url = assetUrl;
    }).catch(() => {});
    return () => { active = false; };
  });

  const normal = (n: number) => Math.max(0, Math.min(1, n));

  function save(placement: Placement, point: Vec2) {
    const field = kind === 'picture' ? 'pictureArt' : 'svgArt';
    const current = c.doc.nodes[nodeId]?.[field];
    if (!current || current.assetHash !== art.assetHash) return;
    const anchors: NonNullable<NodeArt['anchors']> = { ...(current.anchors ?? defaults) };
    if (placement === 'out' && child && c.doc.nodes[child]?.parent === nodeId) {
      anchors.outByChild = { ...current.anchors?.outByChild, [child]: point };
    } else {
      anchors[placement] = point;
    }
    c.editor.apply({
      source: 'user', label: 'Move Artwork Anchor',
      ops: [{ t: 'set', id: nodeId, patch: { [field]: { ...current, anchors } } }]
    });
  }

  function start(event: PointerEvent & { currentTarget: HTMLButtonElement }, placement: Placement) {
    if (event.button !== 0 || dragging) return;
    const origin = placement === 'in' ? inward : outward;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging = { placement, pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin, current: origin };
  }

  function move(event: PointerEvent) {
    const drag = dragging;
    if (!drag || drag.pointer !== event.pointerId) return;
    const box = stage?.getBoundingClientRect();
    if (box?.width && box.height) {
      drag.current = {
        x: normal(drag.origin.x + (event.clientX - drag.start.x) / box.width),
        y: normal(drag.origin.y + (event.clientY - drag.start.y) / box.height)
      };
    }
  }

  function end(event: PointerEvent, cancel = false) {
    const drag = dragging;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!cancel) {
      move(event);
      if (drag.current.x !== drag.origin.x || drag.current.y !== drag.origin.y) save(drag.placement, drag.current);
    }
    dragging = null;
  }

  function nudge(event: KeyboardEvent, placement: Placement) {
    const dir: Record<string, Vec2> = {
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }
    };
    const delta = dir[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const point = placement === 'in' ? inward : outward;
    const step = event.shiftKey ? 0.05 : 0.01;
    save(placement, { x: normal(point.x + delta.x * step), y: normal(point.y + delta.y * step) });
  }
</script>

{#if url}
  <div class="anchors">
    {#if choices.length}
      <label for="art-outgoing-branch">Outgoing branch</label>
      <select id="art-outgoing-branch" bind:value={child} disabled={!!dragging}>
        <option value="">Default outgoing anchor</option>
        {#each choices as choice (choice.id)}<option value={choice.id}>{choice.text}</option>{/each}
      </select>
    {/if}
    <div class="anchor-stage" bind:this={stage}>
      <img src={url} alt="Artwork anchor preview" draggable="false" />
      <button class="pin incoming" type="button" style:left={`${inward.x * 100}%`} style:top={`${inward.y * 100}%`}
        aria-label="Incoming artwork anchor" title="Incoming branch"
        onpointerdown={(event) => start(event, 'in')} onpointermove={move} onpointerup={end}
        onpointercancel={(event) => end(event, true)} onkeydown={(event) => nudge(event, 'in')}>In</button>
      <button class="pin outgoing" type="button" style:left={`${outward.x * 100}%`} style:top={`${outward.y * 100}%`}
        aria-label="Outgoing artwork anchor" title="Outgoing branch"
        onpointerdown={(event) => start(event, 'out')} onpointermove={move} onpointerup={end}
        onpointercancel={(event) => end(event, true)} onkeydown={(event) => nudge(event, 'out')}>Out</button>
    </div>
    <p>Drag an anchor or use the arrow keys to move it.</p>
  </div>
{/if}

<style>
  .anchors { display: grid; gap: 6px; }
  .anchor-stage { position: relative; max-width: 200px; width: 100%; margin: 4px auto; background: var(--panel); border-radius: 7px; }
  img { display: block; width: 100%; height: auto; pointer-events: none; }
  .pin { position: absolute; transform: translate(-50%, -50%); height: 22px; padding: 0 4px; min-width: 22px; border: 1px solid white; border-radius: 6px; color: white; font-size: 10px; cursor: grab; touch-action: none; }
  .pin:active { cursor: grabbing; }
  .incoming { background: #1d4ed8; }
  .outgoing { background: #047857; }
  p, label { margin: 0; }
</style>
