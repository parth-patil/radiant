<script lang="ts">
  import { onMount } from 'svelte';
  import type { ChangeSummary } from '../core/model/editor';
  import type { AppController } from './controller.svelte';
  import { addSnapshot, automaticSnapshotLimit, historySource, listSnapshots, pruneAutomaticSnapshots, setAutomaticSnapshotLimit, type Snapshot } from './history';

  let { c }: { c: AppController } = $props();
  let name = $state('');
  let entries = $state.raw<Snapshot[]>([]);
  let open = $state(false);
  let update = $state(0);
  let message = $state('');
  let retain = $state(automaticSnapshotLimit());
  let docId = $derived.by(() => { void c.rev; return c.doc.id; });
  let lastSave = $derived(c.saveText.startsWith('Saved ') ? c.saveText : '');
  let changes = $derived.by(() => {
    void c.rev;
    return open ? c.editor.historySummary() : { applied: [], undone: [] };
  });
  const formatDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  onMount(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === docId) update++;
    };
    window.addEventListener('radiant-snapshot-saved', refresh);
    return () => window.removeEventListener('radiant-snapshot-saved', refresh);
  });

  $effect(() => {
    const id = docId;
    void update;
    void lastSave;
    if (!open) return;
    let active = true;
    listSnapshots(id).then((rows) => { if (active) entries = rows; })
      .catch(() => { if (active) message = 'Saved snapshots could not be read.'; });
    return () => { active = false; };
  });

  async function saveRetention() {
    if (!Number.isInteger(retain) || retain < 1 || retain > 100) return;
    try {
      setAutomaticSnapshotLimit(retain);
      await pruneAutomaticSnapshots(docId);
      update++;
    } catch { message = 'Could not change the snapshot limit.'; }
  }

  async function capture() {
    if (c.editor.hasOpenGroup) {
      message = 'Finish the current edit before saving a snapshot.';
      return;
    }
    try {
      await addSnapshot(c.doc, name.trim() || c.doc.title, false, c.editor.historySummary(1).applied[0]);
      name = '';
      message = 'Snapshot saved.';
      update++;
    } catch {
      message = 'The snapshot could not be saved.';
    }
  }
</script>

{#snippet changeItem(entry: ChangeSummary)}
  <span>{entry.label}</span>
  <span class="source" data-source={entry.source}>{historySource[entry.source]}</span>
  <small>{formatDate.format(entry.at)}</small>
{/snippet}

<details bind:open>
  <summary>History and recent maps</summary>
  <h4>Snapshots</h4>
  <label>Automatic snapshots to keep
    <input type="number" min="1" max="100" bind:value={retain} onchange={saveRetention}>
  </label>
  <label>Snapshot name<input bind:value={name} placeholder={c.docTitle} maxlength="100"></label>
  <button class="btn bordered" onclick={capture}>Save snapshot</button>
  {#each entries.filter((entry) => entry.docId === docId) as snapshot (snapshot.id)}
    <div class="snapshot">
      <strong>{snapshot.name}</strong>
      <small>{formatDate.format(snapshot.at)}</small>
      {#if snapshot.change}
        <div class="attribution">
          <span class="source" data-source={snapshot.change.source}>{historySource[snapshot.change.source]}</span>
          {snapshot.change.label}
        </div>
      {/if}
      <button class="btn" onclick={() => c.restoreSnapshot(snapshot, false)}>Restore</button>
      <button class="btn" onclick={() => c.restoreSnapshot(snapshot, true)}>Open as copy</button>
    </div>
  {/each}
  {#if message}<p role="status">{message}</p>{/if}
  <h4>Recent changes</h4>
  {#if changes.applied.length}
    <ul aria-label="Applied changes">
      {#each changes.applied as entry, i (i)}<li>{@render changeItem(entry)}</li>{/each}
    </ul>
  {:else}
    <p>No edits in the current Undo history.</p>
  {/if}
  {#if changes.undone.length}
    <details>
      <summary>Undone changes ({changes.undone.length})</summary>
      <ul aria-label="Undone changes">
        {#each changes.undone as entry, i (i)}<li>{@render changeItem(entry)}</li>{/each}
      </ul>
    </details>
  {/if}
  {#if c.recent.length}<h4>Recent maps</h4>{/if}
  {#each c.recent as path (path)}
    <button class="recent btn" title={path} onclick={() => c.openDoc(path)}>{path.split(/[\\/]/).pop()}</button>
  {/each}
</details>

<style>
  details { padding: 7px 0; }
  summary { cursor: pointer; }
  label { display: grid; margin: 8px 0; }
  input { width: 100%; box-sizing: border-box; }
  .recent { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .snapshot, li { margin: 6px 0; overflow-wrap: anywhere; }
  small { display: block; color: var(--text-dim); }
  ul { list-style: none; margin: 0; padding: 0; }
  h4 { margin: 10px 0 4px; }
  p { margin: 6px 0 0; }
  .attribution { margin: 4px 0; }
  .source { border: 1px solid var(--line-strong); border-radius: 4px; color: var(--text-dim); padding: 1px 4px; font-size: 10px; }
  .source[data-source="ai"], .source[data-source="agent"] { border-color: var(--accent); }
</style>
