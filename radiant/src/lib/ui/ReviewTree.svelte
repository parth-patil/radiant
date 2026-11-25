<script lang="ts">
  import type { Snippet } from 'svelte';

  interface TreeItem {
    id: string;
    parent: string | null;
  }

  let { nodes, card, name }: {
    nodes: readonly TreeItem[];
    card: Snippet<[string]>;
    name: string;
  } = $props();

  const children = $derived.by(() => {
    const result = new Map<string | null, TreeItem[]>();
    for (const row of nodes) {
      const group = result.get(row.parent);
      if (group) group.push(row);
      else result.set(row.parent, [row]);
    }
    return result;
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling for the map) -->
<div class="tree" role="region" aria-label={name} tabindex="0">
  {#snippet branch(item: TreeItem)}
    {@const descendants = children.get(item.id)}
    <li>
      <div class="card">{@render card(item.id)}</div>
      {#if descendants?.length}
        <ul>
          {#each descendants as child (child.id)}
            {@render branch(child)}
          {/each}
        </ul>
      {/if}
    </li>
  {/snippet}
  <ul class="roots">
    {#each children.get(null) ?? [] as root (root.id)}
      {@render branch(root)}
    {/each}
  </ul>
</div>

<style>
  .tree {
    background: var(--bg);
    background-image: radial-gradient(var(--line-strong) 0.7px, transparent 0.7px);
    background-size: 16px 16px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 14px;
    overflow: auto;
    min-height: 76px;
    max-height: min(46vh, 560px);
  }
  ul { margin: 0; padding: 0 0 0 28px; list-style: none; }
  .roots { padding: 0; width: max-content; }
  li { display: flex; position: relative; align-items: center; padding: 5px 0; gap: 0; }
  li::before { content: ''; height: 100%; left: -14px; position: absolute; border-left: 1px solid var(--line-strong); }
  li:first-child::before { top: 50%; height: 50%; }
  li:last-child::before { bottom: 50%; height: 50%; }
  li:only-child::before, .roots > li::before, .roots > li::after { display: none; }
  li::after { content: ''; position: absolute; left: -14px; width: 14px; border-top: 1px solid var(--line-strong); top: 50%; }
  .card { position: relative; min-width: 98px; }
  li:has(> ul) > .card::after { content: ''; position: absolute; left: 100%; width: 14px; border-top: 1px solid var(--line-strong); top: 50%; }
</style>
