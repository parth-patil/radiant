<script lang="ts">
  import type { AppController } from './controller.svelte';

  let { c, floating = false }: { c: AppController; floating?: boolean } = $props();
  const label = (text: string) => text.trim() || 'Blank node';
</script>

{#if c.aiChangeSummary}
  {@const change = c.aiChangeSummary}
  <section aria-label="AI change summary" class:floating class:above-toast={floating && !!c.toast}>
    <div class="heading">
      <div role="status" aria-atomic="true">
        <strong>{change.title}</strong>
        <div>{change.added.length} added · {change.edited.length} edited · {change.removed.length} removed</div>
      </div>
      <button class="btn bordered" onclick={() => c.dismissAiChangeSummary()}>Dismiss summary</button>
    </div>
    {#if change.added.length}
      <div class="legend"><span aria-hidden="true"></span>Added nodes carry a + badge.</div>
    {/if}
    {#if change.linksAdded || change.linksRemoved}
      <div>Connections · {change.linksAdded} added · {change.linksRemoved} removed</div>
    {/if}
    {#if change.edited.length || change.removed.length}
      <details>
        <summary>Edited and removed nodes</summary>
        <ul>
          {#each change.edited as node (node.id)}
            <li>Edited · {node.previous !== node.text ? `${label(node.previous ?? '')} → ${label(node.text)}` : label(node.text)}</li>
          {/each}
          {#each change.removed as node (node.id)}
            <li>Removed · {label(node.text)}</li>
          {/each}
        </ul>
      </details>
    {/if}
  </section>
{/if}

<style>
  section {
    padding: 10px 12px;
    background: var(--panel-solid);
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .floating {
    position: absolute;
    bottom: 48px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    width: max-content;
    max-width: min(420px, calc(100% - 24px));
    max-height: 45vh;
    overflow: auto;
    box-shadow: 0 4px 18px #0002;
  }
  .above-toast { bottom: 100px; }
  .heading { display: flex; align-items: start; gap: 16px; justify-content: space-between; }
  .heading button { flex-shrink: 0; }
  .legend { display: flex; align-items: center; gap: 6px; }
  .legend span { border: 2px solid #059669; width: 12px; height: 10px; border-radius: 3px; }
  details ul { margin: 4px 0; padding-left: 18px; }
</style>
