<script lang="ts">
  import type { MenuId } from '../host/types';
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();
  let menu: HTMLDetailsElement;

  function choose(id: MenuId) {
    menu.open = false;
    void c.command(id);
  }

  function dismiss(e: MouseEvent) {
    if (e.target instanceof Node && !menu.contains(e.target)) menu.open = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && menu.open) {
      e.stopPropagation();
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
    if (e.code === 'Space') e.stopPropagation();
  }
</script>

<svelte:window onclick={dismiss} />
<details bind:this={menu} class="view-menu">
  <summary class="btn" onkeydown={onKey}>View</summary>
  <div class="view-actions">
    <button type="button" onkeydown={onKey} aria-pressed={c.showMinimap} onclick={() => choose('toggle-minimap')}>Minimap</button>
    <button type="button" onkeydown={onKey} aria-pressed={!!c.canvasFilter}
      onclick={() => choose('filter-map')}>Filter map…</button>
    <button type="button" onkeydown={onKey} aria-pressed={c.canvasView?.kind === 'focus'} disabled={!c.focusId && !c.canvasView}
      onclick={() => choose('focus-branch')}>Focus on branch <kbd>⇧⌘F</kbd></button>
    <button type="button" onkeydown={onKey} onclick={() => choose('zoom-fit')}>Zoom to fit everything <kbd>⇧1</kbd></button>
    <button type="button" onkeydown={onKey} disabled={!c.focusId && !c.canvasTools.selected.length} onclick={() => choose('zoom-selection')}>Zoom to selection <kbd>⇧2</kbd></button>
    <button type="button" onkeydown={onKey} aria-pressed={!!c.canvasTools.grid} onclick={() => { menu.open = false; c.canvasTools.toggleGrid(); }}>Grid <kbd>⌘'</kbd></button>
    <div class="heading">Bookmarks</div>
    {#each c.doc.canvas?.bookmarks ?? [] as mark, i (mark.id)}
      <div class="bookmark">
        <button type="button" onkeydown={onKey} onclick={() => { menu.open = false; c.canvasTools.goToBookmark(i); }}>{mark.name}{#if i < 9}<kbd>⌃{i + 1}</kbd>{/if}</button>
        <button type="button" class="remove" onkeydown={onKey} aria-label={'Delete bookmark ' + mark.name} title="Delete bookmark"
          onclick={() => c.canvasTools.deleteBookmark(mark.id)}>×</button>
      </div>
    {/each}
    <button type="button" onkeydown={onKey} onclick={() => { menu.open = false; c.canvasTools.addBookmark(); }}>Save this view as a bookmark</button>
    <button type="button" onkeydown={onKey} disabled={!c.focusId} onclick={() => choose('centre-selection')}>Centre selection</button>
    <button type="button" onkeydown={onKey} disabled={!c.focusId} onclick={() => choose('select-level')}>Select nodes at the same level</button>
    <button type="button" onkeydown={onKey} onclick={() => choose('present-branches')}>Present <kbd>⌥⌘P</kbd></button>
    <button type="button" onkeydown={onKey} disabled={!c.focusId} onclick={() => choose('present-from-here')}>Present from here</button>
    <button type="button" onkeydown={onKey} aria-pressed={c.presentation.showPanel} onclick={() => choose('presentations')}>Presentations…</button>
    <button type="button" onkeydown={onKey} disabled={!c.selIds.length} onclick={() => choose('reset-branch-offsets')}>Reset positions in selected branches</button>
    <button type="button" onkeydown={onKey} onclick={() => choose('reset-map-offsets')}>Reset positions in whole map</button>
    <button type="button" onkeydown={onKey} onclick={() => choose('tidy-map')}>Tidy whole map…</button>
  </div>
</details>

<style>
  .view-menu {
    position: relative;
  }
  summary {
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .view-actions {
    position: absolute;
    right: 0;
    top: calc(100% + 6px);
    display: grid;
    min-width: 185px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
  }
  .view-actions button {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 7px 9px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }
  .view-actions button[aria-pressed='true'] {
    color: var(--accent);
  }
  .view-actions button:enabled:hover {
    background: var(--hover);
  }
  .heading { padding: 7px 9px 2px; color: var(--text-dim); font-size: 11px; border-top: 1px solid var(--line); margin-top: 4px; }
  .bookmark { display: flex; }
  .bookmark button:first-child { flex: 1; }
  .bookmark .remove { padding: 7px; color: var(--text-dim); }
  .view-actions button:disabled {
    color: var(--text-dim);
    cursor: default;
  }
</style>
