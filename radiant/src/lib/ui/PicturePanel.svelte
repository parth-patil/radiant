<script lang="ts">
  import type { MapNode } from '../core/types';
  import type { AppController } from './controller.svelte';
  import { LOCAL_PICTURE_ACCEPT } from './local-picture';

  let { c, node }: { c: AppController; node: MapNode } = $props();
  let chooser = $state<HTMLInputElement>();
  let url = $state('');
  let changing = $state(false);

  $effect(() => {
    const hash = node.imageAsset;
    let active = true;
    url = '';
    if (hash) void c.host.assetUrl(hash).then((path) => { if (active) url = path; }, () => {});
    return () => { active = false; };
  });

  async function choose(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    event.currentTarget.value = '';
    changing = true;
    try { await c.attachImage(node.id, file); }
    finally { changing = false; }
  }
</script>

<div class="sec pictures">
  <div class="lbl">Local picture</div>
  <button type="button" class="btn bordered" disabled={changing} onclick={() => chooser?.click()}>
    {node.imageAsset ? 'Replace picture…' : 'Attach picture…'}
  </button>
  <input type="file" hidden bind:this={chooser} accept={LOCAL_PICTURE_ACCEPT} onchange={(event) => void choose(event)} />
  {#if node.imageAsset}
    {#if c.failedImages.has(node.imageAsset)}
      <p role="status">Picture could not be loaded. The editable vector node is shown.</p>
      <button type="button" class="btn bordered" onclick={() => c.retryImage(node.imageAsset!)}>Retry loading picture</button>
    {:else if url}
      <img class="preview" src={url} alt={node.imageAlt ?? (node.text || 'Attached picture')} draggable="true"
        ondragstart={(event) => {
          event.dataTransfer?.setData('text/uri-list', url);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        }} />
    {/if}
    <label for="picture-size-percent">Picture size (%)</label>
    <input id="picture-size-percent" class="field" type="number" min="25" max="600" step="5" value={Math.round((node.imageScale ?? 1) * 100)}
      onchange={(event) => c.resizeImage(node.id, event.currentTarget.valueAsNumber / 100)} />
    <label for="picture-description">Picture description</label>
    <input id="picture-description" class="field" value={node.imageAlt ?? ''} maxlength="240"
      placeholder={node.text || 'Describe the picture'} onchange={(event) => c.describeImage(node.id, event.currentTarget.value)} />
    <button type="button" class="btn bordered" onclick={() => c.removeImage(node.id)}>Remove picture</button>
  {/if}
</div>

<style>
  .pictures { display: grid; gap: 6px; }
  .pictures label { margin-bottom: 0; }
  .preview { max-width: 100%; max-height: 110px; object-fit: contain; justify-self: center; border-radius: 5px; }
</style>
