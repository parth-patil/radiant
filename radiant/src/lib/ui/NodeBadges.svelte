<script lang="ts">
  import type { AppController } from './controller.svelte';
  let { c }: { c: AppController } = $props();
  const outcomeBadges = {
    recalled: { glyph: '✓', label: 'Recalled' },
    partly: { glyph: '◐', label: 'Partly recalled' },
    missed: { glyph: '×', label: 'Missed' }
  };
  const added = $derived(new Set(c.aiChangeSummary?.added.map(node => node.id)));
  const annotated = $derived.by(() => {
    void c.rev;
    return Object.values(c.doc.nodes).filter(node =>
      node.link || node.note || node.task || node.tags?.length || c.reviewStrength?.has(node.id) || added.has(node.id));
  });
  const colors = $derived.by(()=>{void c.rev;return c.doc.tagColors;});
  const badges = $derived.by(() => {
    if (!c.ready || !annotated.length || c.presenting) return [];
    void c.camTick; void c.layoutTick;
    const { camera } = c;
    return annotated.flatMap(node => {
      const box = c.pipeline.canvasLayout.boxes.get(node.id);
      if (!box || (c.canvasMatches && !c.canvasMatches.has(node.id))) return [];
      const point = camera.worldToScreen({x:box.x + box.w / 2, y:box.y - box.h / 2});
      if (point.x < -40 || point.x > camera.width || point.y < -20 || point.y > camera.height) return [];
      const compact = camera.zoom < 0.45 && c.focusId !== node.id;
      const outcome = c.reviewStrength?.get(node.id);
      if (compact && !outcome && !added.has(node.id)) return [];
      return [{node, point, compact, outcome}];
    });
  });

  function refreshLinks() {
    const links = new Set(badges.map(({ node }) => node.link).filter((link): link is string => !!link));
    for (const link of links) void c.checkMapLink(link).catch(() => {});
  }
</script>
<svelte:window onfocus={refreshLinks} />
{#each badges as {node, point, compact, outcome} (node.id)}
  <div class="badges" class:align-right={point.x > c.camera.width - 170}
    style:left={Math.max(0, Math.min(c.camera.width - 4, point.x)) + 'px'} style:top={point.y + 'px'}>
    {#if outcome}
      {@const cue = outcomeBadges[outcome]}
      <span class="badge" role="img" title={cue.label} aria-label={cue.label + ' · ' + node.text}>{cue.glyph}</span>
    {/if}
    {#if added.has(node.id)}
      <span class="badge" role="img" title="Added by AI" aria-label={'Added by AI · ' + node.text}>+</span>
    {/if}
    {#if !compact}
      {#if node.task}
        {@const task = node.task.done ? 'Task completed' : 'Task open'}
        <span class="badge" role="img" title={task} aria-label={task + ' · ' + node.text}>{node.task.done ? '☑' : '☐'}</span>
      {/if}
      {#each node.tags ?? [] as tag}
        <button class="tag" title={'Filter by '+tag} aria-label={'Filter by tag '+tag}
          style:--tag-color={colors && Object.hasOwn(colors,tag.toLowerCase()) ? colors[tag.toLowerCase()] : '#68768a'}
          onclick={()=>c.setCanvasFilter({kind:'tag',value:tag})}>#{tag}</button>
      {/each}
      {#if node.link}
        {@const broken = c.brokenMapLinks.has(node.link)}
        <button title={broken ? 'Broken map link' : node.link}
          aria-label={(broken ? 'Broken link for ' : 'Open link for ') + node.text}
          onclick={() => void c.followNodeLink(node.link!, node.id)}>{broken ? '↗!' : '↗'}</button>
      {/if}
      {#if node.note}
        {@const shown = c.openNotes.includes(node.id)}
        <button class:on={shown} title={shown ? 'Hide note' : 'Show note'} aria-expanded={shown}
          aria-label={(shown ? 'Hide note for ' : 'Show note for ') + node.text}
          onclick={() => c.toggleNote(node.id)}>≡</button>
      {/if}
    {/if}
  </div>
{/each}
<style>
  .badges {
    position: absolute;
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    width: max-content;
    max-width: 162px;
    transform: translate(-2px, -90%);
    pointer-events: none;
  }
  .badges.align-right { transform: translate(-100%, -90%); }
  .badge, button {
    box-sizing: border-box;
    padding: 1px 3px;
    min-width: 17px;
    min-height: 17px;
    border: 1px solid var(--line-strong);
    border-radius: 4px;
    color: var(--text);
    background: var(--panel-solid);
    font-size: calc(11px * var(--ui-scale, 1));
    line-height: 1.1;
    text-align: center;
  }
  button { cursor: pointer; pointer-events: auto; }
  button.on { border-color: var(--accent); color: var(--accent-ink); background: var(--accent); }
  .tag { max-width: 100%; overflow-wrap: anywhere; border-inline-start: 3px solid var(--tag-color); }
</style>
