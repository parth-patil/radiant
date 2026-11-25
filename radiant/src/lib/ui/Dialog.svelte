<script lang="ts">
  import { onMount } from 'svelte';
  import type { DialogState } from './controller.svelte';

  let { d }: { d: DialogState } = $props();
  let element: HTMLDialogElement;

  onMount(() => {
    element.showModal();
    element.querySelector<HTMLButtonElement>('.primary')?.focus();
    return () => element.close();
  });
</script>

<dialog bind:this={element} class="dialog" aria-labelledby="dialog-title" aria-describedby={d.details?.length ? 'dialog-message dialog-details' : 'dialog-message'}
  onkeydown={(e) => e.stopPropagation()} onkeyup={(e) => e.stopPropagation()}
  oncancel={(e) => { e.preventDefault(); d.resolve('cancel'); }}>
  <h2 id="dialog-title">{d.title}</h2>
  <p id="dialog-message">{d.message}</p>
  {#if d.details?.length}
    <div id="dialog-details">
      <h3>Skipped or changed in this file</h3>
      <ul>{#each d.details as detail (detail)}<li>{detail}</li>{/each}</ul>
    </div>
  {/if}
  {#if d.requestPreview !== undefined}<pre class="request-preview">{d.requestPreview}</pre>{/if}
  <div class="btns">
    {#each d.buttons as b (b.id)}
      <button class="btn bordered" class:primary={b.primary} class:danger={b.danger} onclick={() => d.resolve(b.id)}>{b.label}</button>
    {/each}
  </div>
</dialog>

<style>
  #dialog-details { max-height: min(32vh, 240px); overflow: auto; margin-bottom: 12px; overflow-wrap: anywhere; }
  .request-preview {max-height:min(42vh,360px);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
  h3 { font-size: 1rem; margin: 0; }
</style>
