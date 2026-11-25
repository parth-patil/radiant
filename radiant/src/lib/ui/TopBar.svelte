<script lang="ts">
  import type { AppController } from './controller.svelte';
  import { LAYOUT_NAMES } from './controller.svelte';
  import { listThemes } from '../core/model';
  import type { LayoutKind, Theme } from '../core/types';
  import Icon from './Icon.svelte';
  import ViewMenu from './ViewMenu.svelte';

  let { c }: { c: AppController } = $props();
  const themes = listThemes();
  const groupNames = [...new Set(['Classic', ...themes.map((t) => t.group ?? 'Classic')])];
  const themeGroups = groupNames.map((name) => ({ name, themes: themes.filter((t) => (t.group ?? 'Classic') === name) }))
    .filter((g) => g.themes.length);
  let themeMenu: HTMLDetailsElement;
  const currentTheme = $derived(themes.find((t) => t.id === c.theme.id) ?? c.theme);
  function chooseTheme(id: string) {
    themeMenu.open = false;
    themeMenu.querySelector('summary')?.focus();
    if (id !== c.theme.id) c.setTheme(id);
  }
  function dismissThemes(e: MouseEvent) {
    if (themeMenu?.open && e.target instanceof Node && !themeMenu.contains(e.target)) themeMenu.open = false;
  }
  function themeKeys(e: KeyboardEvent) {
    if (e.code === 'Space' && e.target instanceof HTMLButtonElement) e.stopPropagation();
    if (!themeMenu.open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      themeMenu.open = false;
      themeMenu.querySelector('summary')?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    e.stopPropagation();
    const items = [...themeMenu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 :
      at < 0 ? Math.max(0, items.findIndex((item) => item.getAttribute('aria-checked') === 'true')) :
      (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  const layouts = Object.keys(LAYOUT_NAMES) as LayoutKind[];

  let title = $state('');
  let editingTitle = false;
  $effect(() => {
    const t = c.docTitle;
    if (!editingTitle) title = t;
  });
  const layout = $derived.by(() => {
    void c.rev;
    void c.selTick;
    const id = c.focusId ? c.editor.doc.nodes[c.focusId] && rootOfFocus() : c.doc.roots[0];
    return id ? (c.doc.rootInfo[id]?.layout ?? 'mindmap') : 'mindmap';
  });
  function rootOfFocus(): string | null {
    let id = c.focusId;
    while (id && c.doc.nodes[id]?.parent) id = c.doc.nodes[id].parent;
    return id;
  }
  const arrangeTitle = $derived.by(() => {
    void c.rev;
    void c.selTick;
    const ids = c.selIds;
    const whole = !ids.length || ids.some((id) => c.doc.nodes[id]?.parent === null);
    return (whole ? 'Arrange the whole map' : ids.length > 1 ? 'Arrange the selected branches' : 'Arrange the selected branch') +
      ': reset moved nodes and balance the layout (⌥⌘L)';
  });
  function onLayout(e: Event) {
    const root = rootOfFocus() ?? c.doc.roots[0];
    if (root) c.setRootLayout(root, (e.currentTarget as HTMLSelectElement).value as LayoutKind);
  }
</script>

<svelte:window onclick={dismissThemes} />
<header class="topbar" data-keyboard-pane bind:offsetHeight={c.topBarHeight}>
  {#if c.mapLinkTrail.length}
    <button class="btn" type="button" onclick={() => void c.backFromMapLink()}
      title={`Back to ${c.mapLinkTrail.at(-1)?.title}`}>← Back</button>
  {/if}
  <button class="btn" class:on={c.showOutline} title="Show or hide the outline (⌘⌥O)" onclick={() => (c.showOutline = !c.showOutline)}>
    <Icon name="outline" />
  </button>
  <input
    class="title-input"
    type="text"
    bind:value={title}
    spellcheck="false"
    aria-label="Map title"
    onfocus={() => (editingTitle = true)}
    onblur={() => {
      editingTitle = false;
      c.setTitle(title);
      title = c.docTitle;
    }}
    onkeydown={(e) => {
      if(e.isComposing || e.keyCode===229)return;
      if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
      if (e.key === 'Escape') {
        title = c.docTitle;
        (e.currentTarget as HTMLInputElement).blur();
      }
    }}
  />
  {#if c.dirty}<span class="dirty-dot" title="Unsaved changes"></span>{/if}
  <span class="sep"></span>
  <button class="btn" title="Undo (⌘Z)" disabled={!c.canUndo} onclick={() => c.undo()}><Icon name="undo" /></button>
  <button class="btn" title="Redo (⇧⌘Z)" disabled={!c.canRedo} onclick={() => c.redo()}><Icon name="redo" /></button>
  <span class="sep"></span>
  <select aria-label="Layout" title="Layout of the selected main node" value={layout} onchange={onLayout}>
    {#each layouts as l (l)}<option value={l}>{LAYOUT_NAMES[l]}</option>{/each}
  </select>
  <button class="btn" title={arrangeTitle} onclick={() => void c.command('arrange')}><Icon name="arrange" size={14} /> Arrange</button>
  <details class="theme-menu" bind:this={themeMenu}>
    <summary class="btn" onkeydown={themeKeys} aria-label={`Theme: ${currentTheme.name}`} aria-haspopup="menu" title="Theme (⌘T)">
      <span class="theme-name" style:font-family={currentTheme.fontFamily}>{currentTheme.name}</span>
      <span class="chevron" aria-hidden="true">▾</span>
    </summary>
    <div class="theme-list" role="menu" aria-label="Theme">
      {#each themeGroups as group (group.name)}
        <div class="theme-group" role="group" aria-label={group.name}>
          <div class="theme-group-name" aria-hidden="true">{group.name}</div>
          {#each group.themes as t (t.id)}
            <button type="button" role="menuitemradio" aria-checked={t.id === currentTheme.id} onkeydown={themeKeys} onclick={() => chooseTheme(t.id)}>
              <span class="theme-name" style:font-family={t.fontFamily}>{t.name}</span>
              <span class="theme-dots" aria-hidden="true">
                {#each t.branchColors.slice(0, 5) as color, i (i)}<span style:background={color}></span>{/each}
              </span>
            </button>
          {/each}
        </div>
      {/each}
    </div>
  </details>
  <span class="sp"></span>
  <button class="btn gen" class:busy={c.busy} title="Generate with AI: grows the selected node, or starts a new map (⌘G)" onclick={() => c.togglePrompt()}>
    <Icon name="sparkle" size={14} />
    {c.busy ? (c.gen?.kind === 'expand' ? 'Expanding…' : 'Generating…') : 'Generate'}
  </button>
  <span class="sp"></span>
  <ViewMenu {c} />
  <button class="btn" title="Find in map (⌘F)" onclick={() => void c.command('find')}>Find</button>
  <div class="zoom">
    <button class="btn" title="Zoom out (⌘−)" onclick={() => c.zoomBy(0.8)}><Icon name="minus" /></button>
    <button class="btn pct" title="Actual size (100%)" onclick={() => c.command('zoom-actual')}>{c.zoomPercent}%</button>
    <button class="btn" title="Zoom in (⌘=)" onclick={() => c.zoomBy(1.25)}><Icon name="plus" /></button>
    <button class="btn" title="Zoom to fit" onclick={() => c.zoomFit()}><Icon name="fit" /></button>
  </div>
  <button class="btn" class:on={c.showInspector} title="Show or hide the inspector (⌘⌥I)" onclick={() => (c.showInspector = !c.showInspector)}>
    <Icon name="inspector" />
  </button>
</header>

<style>
  .theme-menu {
    position: relative;
  }
  .theme-menu summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .theme-menu summary::-webkit-details-marker {
    display: none;
  }
  .chevron {
    font-size: 10px;
    color: var(--text-dim);
  }
  .theme-list {
    position: absolute;
    left: 0;
    top: calc(100% + 6px);
    z-index: 20;
    display: grid;
    min-width: 210px;
    max-height: min(70vh, 560px);
    overflow-y: auto;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
  }
  .theme-group + .theme-group {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid var(--line);
  }
  .theme-group-name {
    padding: 4px 9px 2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-dim);
  }
  .theme-list button {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 6px 9px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    font-size: 13px;
  }
  .theme-list button:hover,
  .theme-list button:focus-visible {
    background: var(--hover);
  }
  .theme-list button[aria-checked='true'] {
    color: var(--accent);
  }
  .theme-dots {
    display: flex;
    gap: 3px;
  }
  .theme-dots span {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  }
  .pct {
    min-width: 48px;
    font-variant-numeric: tabular-nums;
    color: var(--text-dim);
  }
</style>
