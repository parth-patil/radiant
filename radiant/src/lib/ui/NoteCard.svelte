<script lang="ts">
  import type { NodeId } from '../core/types';
  import type { AppController } from './controller.svelte';
  import { renderNote } from './note-preview';

  let { c, id, note, title, left, width, above, y, height, editing }: {
    c: AppController; id: NodeId; note: string; title: string; left: number; width: number;
    /** Over the node instead of under it; then `y` is measured up from the bottom of the stage. */
    above: boolean; y: number; height: number; editing: boolean;
  } = $props();

  let body: HTMLDivElement | undefined = $state();
  let field: HTMLTextAreaElement | undefined = $state();
  let draft = $state('');
  let timer = 0;
  const open = (url: URL) => { void c.host.openNodeUrl(url).catch((error) => c.say(String(error), 'error')); };

  $effect(() => {
    const target = body;
    const raw = note;
    if (!target) return;
    target.textContent = raw;
    let active = true;
    renderNote(raw, open).then((content) => {
      if (active) target.replaceChildren(content);
    }).catch(() => { /* The source stays readable when optional equation rendering is unavailable. */ });
    return () => { active = false; };
  });
  // The draft follows the document (an undo, an edit in the inspector) except while this field is being typed in.
  $effect(() => { if (editing && document.activeElement !== field) draft = note; });
  $effect(() => { if (editing) field?.focus(); });
  // A card that leaves the screen or is closed mid-sentence still saves what was typed.
  $effect(() => () => { if (timer) flush(); });

  function flush() {
    clearTimeout(timer);
    timer = 0;
    const node = c.doc.nodes[id];
    if (node && (node.note ?? '') !== draft) c.setNoteOf(id, draft);
  }
  function onInput() {
    clearTimeout(timer);
    timer = window.setTimeout(flush, 700);
  }
  function toCanvas() { document.querySelector<HTMLCanvasElement>('canvas.map')?.focus(); }
  function done() {
    flush();
    if (draft.trim()) c.noteEditing = null;
    else c.closeNote(id);
    toCanvas();
  }
  function close() {
    if (editing) flush();
    c.closeNote(id);
    toCanvas();
  }
  function onKey(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (editing && draft.trim()) done();
    else close();
  }
</script>

<div class="note-card" role="dialog" tabindex="-1" aria-label={'Note for ' + title} onkeydown={onKey}
  style:left={left + 'px'} style:width={width + 'px'} style:max-height={height + 'px'}
  style:top={above ? undefined : y + 'px'} style:bottom={above ? y + 'px' : undefined}>
  <div class="bar">
    <span class="name" title={title}>{title}</span>
    {#if editing}
      <button type="button" class="text" onclick={done}>Done</button>
    {:else}
      <button type="button" class="text" aria-label={'Edit note for ' + title} onclick={() => c.toggleNote(id, true)}>Edit</button>
    {/if}
    <button type="button" title="Close note" aria-label={'Close note for ' + title} onclick={close}>×</button>
  </div>
  {#if editing}
    <textarea bind:this={field} bind:value={draft} oninput={onInput} onblur={flush} spellcheck="true"
      aria-label={'Note for ' + title} style:height={height + 'px'}
      placeholder={'Write a note. Markdown works:\n**bold**, *italic*, # headings, - lists,\n[links](https://…), `code`, > quotes, tables.'}></textarea>
    <div class="tip">Markdown · Esc when done</div>
  {:else}
    <div class="note-body" bind:this={body}></div>
  {/if}
</div>

<style>
  .note-card {
    position: absolute;
    z-index: 4;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow: hidden;
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    color: var(--text);
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    font: calc(13px * var(--ui-scale, 1)) / 1.45 var(--font);
  }
  .bar { display: flex; flex: none; align-items: center; gap: 2px; padding: 3px 5px 3px 11px; border-bottom: 1px solid var(--line); }
  .name { flex: 1; min-width: 0; overflow: hidden; color: var(--text-dim); font-size: 0.9em; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
  button { min-width: 24px; height: 24px; padding: 0 5px; border: 0; border-radius: 6px; color: var(--text-dim); background: transparent; font: inherit; line-height: 1; cursor: pointer; }
  button:hover { color: var(--text); background: var(--hover); }
  button.text { padding: 0 9px; color: var(--accent); font-weight: 600; }
  textarea { display: block; box-sizing: border-box; flex: 1 1 auto; width: 100%; min-height: 96px; max-height: 240px; padding: 9px 12px; border: 0; outline: 0; resize: none; color: inherit; background: var(--field); font: inherit; }
  .tip { flex: none; padding: 3px 12px 5px; border-top: 1px solid var(--line); color: var(--text-dim); font-size: 0.85em; }
  .note-body { padding: 8px 13px 11px; overflow: auto; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; cursor: text; }
  .note-body :global(:first-child) { margin-top: 0; }
  .note-body :global(:last-child) { margin-bottom: 0; }
  .note-body :global(p) { margin: 0.5em 0; }
  .note-body :global(h1), .note-body :global(h2), .note-body :global(h3),
  .note-body :global(h4), .note-body :global(h5), .note-body :global(h6) { margin: 0.9em 0 0.35em; line-height: 1.25; }
  .note-body :global(h1) { font-size: 1.35em; }
  .note-body :global(h2) { font-size: 1.2em; }
  .note-body :global(h3) { font-size: 1.08em; }
  .note-body :global(h4), .note-body :global(h5), .note-body :global(h6) { font-size: 1em; }
  .note-body :global(ul), .note-body :global(ol) { margin: 0.5em 0; padding-inline-start: 1.5em; }
  .note-body :global(li) { margin: 0.15em 0; }
  .note-body :global(li > p) { margin: 0.2em 0; }
  .note-body :global(blockquote) { margin: 0.6em 0; padding: 0.05em 0 0.05em 0.8em; border-inline-start: 3px solid var(--line-strong); color: var(--text-dim); }
  .note-body :global(code) { padding: 0.08em 0.3em; border-radius: 4px; background: var(--hover); font: 0.92em var(--mono); }
  .note-body :global(pre) { margin: 0.6em 0; padding: 8px 10px; overflow-x: auto; border-radius: 6px; background: var(--hover); }
  .note-body :global(pre code) { padding: 0; background: transparent; }
  .note-body :global(hr) { margin: 0.8em 0; border: 0; border-top: 1px solid var(--line-strong); }
  .note-body :global(table) { display: block; max-width: 100%; margin: 0.6em 0; overflow-x: auto; border-collapse: collapse; font-size: 0.95em; }
  .note-body :global(th), .note-body :global(td) { padding: 3px 8px; border: 1px solid var(--line-strong); text-align: start; vertical-align: top; }
  .note-body :global(th) { background: var(--hover); font-weight: 600; }
  .note-body :global(.note-link) { display: inline; padding: 0; height: auto; min-width: 0; border: 0; border-radius: 0; color: var(--accent); background: transparent; font: inherit; text-align: start; text-decoration: underline; cursor: pointer; }
  .note-body :global(.katex-display) { overflow-x: auto; overflow-y: hidden; padding: 0.12em 0; }
</style>
