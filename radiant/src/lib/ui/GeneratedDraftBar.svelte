<script lang="ts">
  import { prevSibling, rootOf } from '../core/model';
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();
  const active = $derived.by(() => {
    void c.rev; void c.selTick;
    const selected = c.focusId && c.doc.nodes[c.focusId] ? c.focusId : null;
    const selectedRoot = selected && rootOf(c.doc, selected);
    const root = selectedRoot && c.doc.nodes[selectedRoot].generatedDraft
      ? selectedRoot : c.doc.roots.find(id => c.doc.nodes[id]?.generatedDraft);
    if (!root) return null;
    const target = selected && selectedRoot === root ? selected : root;
    return { root, target, canMove: Boolean(prevSibling(c.doc, target)), canDelete: target !== root || c.doc.roots.length > 1 };
  });
</script>

{#if active}
  <section class="draft-bar" aria-label="Generated draft">
    <span role="status"><strong>Draft</strong> · {c.doc.nodes[active.root]?.text || 'Untitled tree'}</span>
    <button class="btn bordered" onclick={() => active && c.startEdit(active.target)}>Rename</button>
    <button class="btn bordered" onclick={() => active && c.addChildOf(active.target)}>Add child</button>
    <button class="btn bordered" disabled={!active.canMove}
      onclick={() => active && c.reorderFocus(-1, active.target)}>Move earlier</button>
    <button class="btn bordered" disabled={!active.canDelete} onclick={() => active && c.deleteSelection(false, [active.target])}>Delete branch</button>
    <button class="btn bordered" onclick={() => active && c.keepGeneratedDraft(active.root)}>Keep</button>
  </section>
{/if}

<style>
  .draft-bar { position: fixed; z-index: 5; top: calc(var(--ui-top, 44px) + 10px); left: 50%; transform: translateX(-50%); display: flex; gap: 5px; align-items: center; flex-wrap: wrap; width: max-content; max-width: 92vw; padding: 7px 9px; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; font-size: 12px; }
  span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 5px; }
</style>
