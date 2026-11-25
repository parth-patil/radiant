<script lang="ts">
  import { isCollectionLayout } from '../core/layout/collections';
  import { rootOf } from '../core/model';
  import type { LayoutKind, RootSpacing } from '../core/types';
  import { LAYOUT_NAMES, type AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();
  const kinds = (Object.keys(LAYOUT_NAMES) as LayoutKind[]).filter((kind) => !isCollectionLayout(kind));
  const node = $derived.by(() => {
    void c.rev;
    const current = c.focusId && c.doc.nodes[c.focusId];
    return current && current.parent !== null && !isCollectionLayout(c.doc.rootInfo[rootOf(c.doc, current.id)].layout)
      ? { id: current.id, branchLayout: current.branchLayout, main: c.doc.nodes[current.parent]?.parent === null }
      : null;
  });

  const root = $derived.by(() => {
    void c.rev;
    const id = c.focusId;
    return id && c.doc.rootInfo[id] ? { id, info: c.doc.rootInfo[id] } : null;
  });

  const pin = $derived.by(() => {
    void c.rev;
    return c.focusId ? c.doc.nodes[c.focusId] : undefined;
  });

  function changeSpacing(spacing: RootSpacing) {
    if (!root || (root.info.spacing ?? 'default') === spacing) return;
    c.editor.apply({
      label: 'Change Root Spacing', source: 'user',
      ops: [{ t: 'setRoot', id: root.id, info: { ...root.info, spacing } }],
    });
  }

  function change(branchLayout: string) {
    if (!node) return;
    c.editor.apply({
      label: 'Change Subtree Layout',
      source: 'user',
      ops: [{ t: 'set', id: node.id, patch: { branchLayout: kinds.find((kind) => kind === branchLayout) } }]
    });
  }
</script>

<button type="button" class="btn bordered" title="Reset moved nodes and balance the layout of the selection, or of the whole map when a main node is selected"
  onclick={() => void c.command('arrange')}>Arrange</button>
<button type="button" class="btn bordered" onclick={() => void c.command('tidy-layout')}>
  Tidy selected branches…
</button>
<button type="button" class="btn bordered" onclick={() => void c.command('tidy-map')}>
  Tidy whole map…
</button>

{#if pin && pin.parent !== null}
  <button type="button" class="btn bordered" aria-pressed={!!pin.pinnedPosition}
    onclick={() => void c.command('pin-position')}>{pin.pinnedPosition ? 'Unpin position' : 'Pin position'}</button>
{/if}

{#if root}
  {#if root.info.layout === 'mindmap'}
    <button type="button" class="btn bordered" onclick={() => void c.command('balance')}>Balance main node</button>
  {/if}
  {#if !isCollectionLayout(root.info.layout)}
    <label>
      <input type="checkbox" checked={!!root.info.organic} onchange={(event) => {
        if (!root) return;
        c.editor.apply({ label: 'Organic Layout', source: 'user', ops: [
          { t: 'setRoot', id: root.id, info: { ...root.info, organic: event.currentTarget.checked ? true : undefined } }
        ] });
      }} />
      Organic layout
    </label>
    {#if root.info.organic}
      <button type="button" class="btn bordered" onclick={() => void c.command('new-variation')}>New organic variation</button>
    {/if}
  {/if}
  <div class="sec">
    <label for="root-spacing">Main node spacing</label>
    <select id="root-spacing" value={root.info.spacing ?? 'default'}
      onchange={(event) => changeSpacing(event.currentTarget.value as RootSpacing)}>
      <option value="narrow">Narrow</option>
      <option value="default">Default</option>
      <option value="wide">Wide</option>
    </select>
  </div>
{/if}

{#if node}
  <div class="sec">
    <label for="main-branch-layout">{node.main ? 'Main branch layout' : 'Subtree layout'}</label>
    <select id="main-branch-layout" value={node.branchLayout ?? ''} onchange={(event) => change(event.currentTarget.value)}>
      <option value="">Inherit layout</option>
      {#each kinds as kind (kind)}
        <option value={kind}>{LAYOUT_NAMES[kind]}</option>
      {/each}
    </select>
  </div>
{/if}
