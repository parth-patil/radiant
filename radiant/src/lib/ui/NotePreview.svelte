<script lang="ts">
  import { renderNote } from './note-preview';

  let { note, open }: { note: string; open: (url: URL) => void } = $props();
  let preview: HTMLDivElement | undefined = $state();
  const formatted = $derived(/[$\\*`_\[<>#]|^(?:\s*[-+>] |\s*\d+\. )/m.test(note));

  $effect(() => {
    const target = preview;
    const raw = note;
    if (!target) return;
    target.textContent = raw;
    let active = true;
    renderNote(raw, open).then(content => {
      if (active) target.replaceChildren(content);
    }).catch(() => { /* Preserve the source when optional equation fonts or rendering are unavailable. */ });
    return () => { active = false; };
  });
</script>

{#if formatted}
  <div class="note-preview" aria-label="Formatted note preview" role="group" bind:this={preview}></div>
{/if}

<style>
  .note-preview { margin-block-start: .5rem; overflow-wrap: anywhere; overflow-x: auto; }
  .note-preview :global(p) { margin: .35em 0; }
  .note-preview :global(pre) { overflow-x: auto; }
  .note-preview :global(.note-link) { display: inline; background: transparent; border: 0; padding: 0; color: inherit; font: inherit; text-decoration: underline; text-align: start; cursor: pointer; }
  .note-preview :global(.katex-display) { overflow-x: auto; overflow-y: hidden; padding: .12em 0; }
</style>
