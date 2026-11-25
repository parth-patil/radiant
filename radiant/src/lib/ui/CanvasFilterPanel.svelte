<script lang="ts">
  import { onMount } from 'svelte';
  import type { AppController } from './controller.svelte';
  import { nodeMarkers, type CanvasFilter } from './canvas-filter';

  let { c }: { c: AppController } = $props();
  let modal: HTMLDialogElement;
  let kind = $state<CanvasFilter['kind']>('tag');
  let tag = $state('');
  let marker = $state('');
  let repeated = $state('');
  const choices = $derived([...c.repeatedWords].sort((a, b) => b[1].branches - a[1].branches || a[0].localeCompare(b[0])));
  const markers = $derived.by(() => {
    void c.rev;
    return [...new Set(Object.values(c.doc.nodes).flatMap(nodeMarkers))].sort();
  });
  let word = $state('');
  let task = $state<'open' | 'done'>('open');

  const tags = $derived.by(() => {
    void c.rev;
    const names = new Map<string, string>();
    for (const node of Object.values(c.doc.nodes)) {
      for (const value of node.tags ?? []) {
        const key = value.toLowerCase();
        if (!names.has(key)) names.set(key, value);
      }
    }
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  });

  onMount(() => {
    const filter = c.canvasFilter;
    kind = filter?.kind ?? (tags.length ? 'tag' : 'word');
    tag = (filter?.kind === 'tag' ? tags.find((name) => name.toLowerCase() === filter.value.toLowerCase()) : undefined) ?? tags[0] ?? '';
    repeated = filter?.kind === 'repeated' ? filter.value : choices[0]?.[0] ?? '';
    marker = filter?.kind === 'marker' ? filter.value : markers[0] ?? '';
    word = filter?.kind === 'word' ? filter.value : '';
    task = filter?.kind === 'task' ? filter.value : 'open';
    modal.showModal();
  });

  function close() {
    modal.close();
    c.showCanvasFilter = false;
  }

  function apply(e: SubmitEvent) {
    e.preventDefault();
    if (kind === 'task') c.setCanvasFilter({ kind, value: task });
    else if (kind === 'repeated') c.setCanvasFilter({ kind, value: repeated });
    else if (kind === 'marker') c.setCanvasFilter({ kind, value: marker });
    else {
      const value = (kind === 'tag' ? tag : word).trim();
      if (!value) return;
      c.setCanvasFilter({ kind, value });
    }
    close();
  }
</script>

<dialog bind:this={modal} class="dialog filter-dialog" aria-labelledby="canvas-filter-title"
  oncancel={(e) => { e.preventDefault(); close(); }}
  onkeydown={(e) => e.stopPropagation()} onkeyup={(e) => e.stopPropagation()}>
  <h2 id="canvas-filter-title">Filter map</h2>
  <form onsubmit={apply}>
    <label>
      Filter by
      <select class="field" bind:value={kind}>
        <option value="tag" disabled={!tags.length}>Tag</option>
        <option value="repeated" disabled={!choices.length}>Repeated word</option>
        <option value="marker" disabled={!markers.length}>Marker</option>
        <option value="word">Text</option>
        <option value="task">Task state</option>
      </select>
    </label>
    {#if kind === 'tag'}
      <label>
        Tag
        <select class="field" bind:value={tag}>
          {#each tags as name (name)}<option value={name}>{name}</option>{/each}
        </select>
      </label>
    {:else if kind === 'repeated'}
      <label>Repeated word
        <select class="field" aria-label="Repeated word" bind:value={repeated}>
          {#each choices as [key, word] (key)}
            <option value={key}>{word.spelling} · {word.branches} main branches</option>
          {/each}
        </select>
      </label>
    {:else if kind === 'marker'}
      <label>
        Marker
        <select class="field" aria-label="Marker" bind:value={marker}>
          {#each markers as name (name)}<option value={name}>{name}</option>{/each}
        </select>
      </label>
    {:else if kind === 'word'}
      <label>
        Text
        <input class="field" bind:value={word} type="search" placeholder="Search labels and notes" />
      </label>
    {:else}
      <label>
        Task state
        <select class="field" bind:value={task}>
          <option value="open">Open</option>
          <option value="done">Completed</option>
        </select>
      </label>
    {/if}
    <div class="btns">
      <button class="btn bordered" type="button" onclick={close}>Cancel</button>
      <button class="btn primary" type="submit" disabled={(kind === 'repeated' && !repeated) || (kind === 'tag' && !tag) || (kind === 'marker' && !marker) || (kind === 'word' && !word.trim())}>Apply filter</button>
    </div>
  </form>
</dialog>

<style>
  .filter-dialog {
    width: min(360px, calc(100vw - 32px));
  }
  label {
    display: grid;
    gap: 5px;
    margin: 12px 0;
  }
</style>
