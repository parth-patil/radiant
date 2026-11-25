<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { getHost } from '../host';
  import { loadUndo, saveUndo, STORED_UNDO_LIMIT } from './undo-storage';

  const quickCapture = getHost().quickCapture;
  let draft = $state('');
  let paths = $state<string[]>([]);
  let path = $state('');
  let busy = $state(false);
  let message = $state('');
  let error = $state('');
  let input: HTMLTextAreaElement;
  let attempt: { path: string; text: string; id: string } | undefined;
  const basename = (value: string) => value.split(/[/\\]/).at(-1) ?? value;

  onMount(() => {
    input.focus();
    if (!quickCapture) {
      error = 'Quick Capture is available in the desktop app.';
      return;
    }
    void quickCapture.recent().then((recent) => {
      paths = [...new Set([...paths, ...recent])];
      if (!path) path = paths[0] ?? '';
    }).catch(() => {});
  });

  async function choose() {
    error = '';
    try {
      const chosen = await quickCapture?.choose();
      if (!chosen) return;
      if (!paths.includes(chosen)) paths = [chosen, ...paths];
      path = chosen;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  async function save() {
    const text = draft.trim();
    if (!quickCapture || busy || !path || !text) return;
    if (!attempt || attempt.path !== path || attempt.text !== text) {
      attempt = { id: crypto.randomUUID(), path, text };
    }
    busy = true;
    error = '';
    message = '';
    let succeeded = false;
    try {
      const outcome = await quickCapture.save(path, attempt.id, text);
      if (outcome.kind === 'closed') {
        const { before, after, entry } = outcome.receipt;
        const docId: string = JSON.parse(after).id;
        const previous = await loadUndo(docId, 'saved', before);
        await saveUndo(docId, 'saved', after, { version: 1, undo: [...(previous?.undo ?? []), entry].slice(-STORED_UNDO_LIMIT), redo: [] });
      }
      message = outcome.kind === 'recovery'
        ? 'Saved in recovery. Save from the map window to update the file.'
        : `Added to ${basename(path)}.`;
      draft = '';
      attempt = undefined;
      succeeded = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      if (succeeded) { await tick(); input.focus(); }
    }
  }
</script>

<svelte:head><title>Radiant Quick Capture</title></svelte:head>
<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && !busy) void quickCapture?.close(); }} />

<main>
  <form onsubmit={(event) => { event.preventDefault(); void save(); }}>
    <h1>Quick Capture</h1>
    <label for="capture-map">Add to map</label>
    <div class="map-choice">
      <select id="capture-map" bind:value={path} disabled={busy || !paths.length}>
        {#if !paths.length}<option value="">Choose a map</option>{/if}
        {#each paths as item (item)}
          <option value={item} title={item}>{basename(item)}</option>
        {/each}
      </select>
      <button type="button" disabled={busy} onclick={() => void choose()}>Browse…</button>
    </div>
    {#if path}<p class="path" title={path}>{path}</p>{/if}
    <label for="capture-text">New node</label>
    <textarea id="capture-text" bind:this={input} bind:value={draft} maxlength="4000" rows="4"
      placeholder="Type or paste a thought" disabled={busy}
      onkeydown={(event) => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
      }}></textarea>
    <div class="actions">
      <button type="button" disabled={busy} onclick={() => void quickCapture?.close()}>Close</button>
      <button class="primary" type="submit" disabled={busy || !draft.trim() || !path}>{busy ? 'Adding…' : 'Add Node'}</button>
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <p class="status" role="status">{message}</p>
  </form>
</main>

<style>
  :global(body){margin:0}
  main { box-sizing:border-box; height:100vh; overflow:auto; padding:18px 22px; background:Canvas; color:CanvasText; font:14px system-ui,sans-serif; color-scheme:light dark; }
  form { display:grid; gap:7px; }
  h1 { font-size:19px; margin:0 0 6px; }
  label { font-weight:600; }
  .map-choice { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; }
  .path { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.75; margin:0 0 3px; font-size:11px; }
  button, textarea, select { font:inherit; padding:6px 8px; border:1px solid color-mix(in srgb, CanvasText 30%, Canvas); border-radius:5px; background:Field; color:FieldText; }
  textarea { resize:vertical; min-height:56px; }
  button:not(:disabled) { cursor:pointer; }
  button:disabled { opacity:.55; }
  button.primary { background:#215bd7; color:white; }
  .actions { display:flex; justify-content:flex-end; gap:8px; margin-top:5px; }
  .status,.error { margin:0; }
  .status:empty { display:none; }
  .error { color:color-mix(in srgb, #e83332 76%, CanvasText); }
</style>
