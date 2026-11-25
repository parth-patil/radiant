<script lang="ts">
  import type { AppController } from './controller.svelte';
  import { SHAPE_TOOLS, TOOLS, type CanvasTool } from './canvas-tools.svelte';

  let { c }: { c: AppController } = $props();
  const t = $derived(c.canvasTools);
  let shapes = $state(false);
  let more = $state(false);
  let file: HTMLInputElement;
  /** The shape the Shapes button shows: the last one chosen. */
  let shape = $state<CanvasTool>('rect');
  $effect(() => {
    if (SHAPE_TOOLS.includes(t.tool)) shape = t.tool;
  });

  const info = (id: CanvasTool) => TOOLS.find((tool) => tool.id === id)!;
  const icons: Record<string, string> = {
    select: 'M5 3l12 7-5 1.5L9.5 17z',
    hand: 'M7 11V5.5a1.5 1.5 0 013 0V10m0-5.5v-1a1.5 1.5 0 013 0V10m0-5a1.5 1.5 0 013 0v6m0-3a1.5 1.5 0 013 0v4c0 3.5-2.5 6-6 6h-1c-2.5 0-4-1.2-5.5-3.5L4 12.5a1.5 1.5 0 012.6-1.5L7 11.5',
    note: 'M4 4h12v8l-4 4H4z M12 16v-4h4',
    text: 'M5 5h10M10 5v11M7.5 16h5',
    rect: 'M3.5 5.5h13v9h-13z',
    diamond: 'M10 3l7 7-7 7-7-7z',
    ellipse: 'M10 4.5c4 0 7 2.5 7 5.5s-3 5.5-7 5.5S3 13 3 10s3-5.5 7-5.5z',
    arrow: 'M4 16L16 4M9 4h7v7',
    line: 'M4 16L16 4',
    draw: 'M3 17c3-1 4-4 6-7s4-5 6-6l2 2c-1 2-3 4-6 6s-6 3-7 6',
    frame: 'M6 3v14M14 3v14M3 6h14M3 14h14',
    eraser: 'M8 16h9M4 12l7-7 5 5-6 6H8z',
    laser: 'M4 16l6-6M12 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1z',
    image: 'M3.5 4.5h13v11h-13z M3.5 13l4-4 3 3 2-2 4 4 M12.5 7.5h.01',
    lock: 'M6 9V6.5a4 4 0 018 0V9 M4.5 9h11v8h-11z',
    more: 'M5 10h.01M10 10h.01M15 10h.01'
  };

  function choose(id: CanvasTool) {
    shapes = false;
    t.setTool(id);
    if (id !== 'image') c.canvas?.focus({ preventScroll: true });
  }

  async function importFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const chosen = input.files?.[0];
    input.value = '';
    more = false;
    if (!chosen) return;
    try {
      await t.insertExcalidraw(JSON.parse(await chosen.text()));
    } catch (error) {
      c.say('Could not import the drawing: ' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  function exportFile() {
    more = false;
    if (!c.doc.canvas?.elements.length) return c.say('There are no drawings to export.');
    const url = URL.createObjectURL(new Blob([t.excalidrawFile()], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = (c.docTitle || 'Drawing') + '.excalidraw';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

{#snippet button(id: CanvasTool)}
  {@const tool = info(id)}
  <button type="button" class="tool" class:active={t.tool === id} aria-pressed={t.tool === id}
    title={`${tool.label} — ${tool.key}`} aria-label={tool.label} onclick={() => choose(id)}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d={icons[id]} /></svg>
    <small>{tool.key}</small>
  </button>
{/snippet}

<div class="dock" role="toolbar" aria-label="Canvas tools">
  {@render button('select')}
  {@render button('hand')}
  <span class="sep"></span>
  {@render button('note')}
  {@render button('text')}
  <div class="shapes">
    {#if shapes}
      <div class="flyout" role="group" aria-label="Shapes">
        {@render button('rect')}
        {@render button('diamond')}
        {@render button('ellipse')}
        {@render button('image')}
      </div>
    {/if}
    <button type="button" class="tool" class:active={SHAPE_TOOLS.includes(t.tool)} aria-expanded={shapes}
      title={`Shapes — ${info(shape).label} (${info(shape).key})`} aria-label="Shapes"
      onclick={() => { if (SHAPE_TOOLS.includes(t.tool)) shapes = !shapes; else { choose(shape); shapes = true; } }}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d={icons[shape]} /></svg>
      <small>{info(shape).key}</small>
    </button>
  </div>
  {@render button('arrow')}
  {@render button('line')}
  {@render button('draw')}
  <span class="sep"></span>
  {@render button('frame')}
  {@render button('eraser')}
  {@render button('laser')}
  <span class="sep"></span>
  <button type="button" class="tool" class:active={t.locked} aria-pressed={t.locked} title="Keep the tool active — Q"
    aria-label="Keep the tool active" onclick={() => (t.locked = !t.locked)}>
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d={icons.lock} /></svg>
    <small>Q</small>
  </button>
  <div class="shapes">
    {#if more}
      <div class="menu" role="menu">
        <button type="button" role="menuitem" onclick={() => { more = false; t.toggleGrid(); }}>{t.grid ? 'Hide grid' : 'Show grid'} <kbd>⌘'</kbd></button>
        <button type="button" role="menuitem" onclick={() => { more = false; t.toggleSnapping(); }}>{t.snapping ? 'Turn snapping off' : 'Turn snapping on'} <kbd>⌥S</kbd></button>
        <button type="button" role="menuitem" onclick={() => file.click()}>Import .excalidraw…</button>
        <button type="button" role="menuitem" onclick={exportFile}>Export drawings as .excalidraw</button>
      </div>
    {/if}
    <button type="button" class="tool" aria-label="More canvas options" aria-expanded={more} title="More" onclick={() => (more = !more)}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d={icons.more} /></svg>
    </button>
  </div>
  <input bind:this={file} type="file" accept=".excalidraw,application/json" hidden onchange={importFile} />
</div>

<style>
  .dock {
    position: absolute;
    z-index: 6;
    left: 50%;
    bottom: calc(var(--ui-bottom, 24px) * var(--ui-scale, 1) + 12px);
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
  }
  .tool {
    position: relative;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text);
    cursor: pointer;
  }
  .tool:hover { background: var(--hover); }
  .tool.active { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  small { position: absolute; right: 3px; bottom: 1px; font-size: 8px; color: var(--text-dim); }
  .sep { width: 1px; height: 20px; margin: 0 3px; background: var(--line); }
  .shapes { position: relative; }
  .flyout, .menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 2px;
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
  }
  .menu { display: grid; min-width: 230px; left: auto; right: 0; transform: none; }
  .menu button {
    display: flex; justify-content: space-between; gap: 12px; padding: 7px 9px; border: 0; border-radius: 5px;
    background: transparent; color: var(--text); text-align: left; cursor: pointer; white-space: nowrap;
  }
  .menu button:hover { background: var(--hover); }
</style>
