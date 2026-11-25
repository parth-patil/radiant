<script lang="ts">
  import type { MapNode } from '../core/types';
  import type { InkPlacement } from '../core/geometry/ink';
  import { MAX_INK_STROKES } from '../core/geometry/ink';
  import type { AppController } from './controller.svelte';

  let { c, node }: { c: AppController; node: MapNode } = $props();
  const active = $derived(c.sketchTarget === node.id && !c.theme.lean);
  const count = $derived(node.sketch?.strokes.length ?? 0);
</script>

<details>
  <summary>Pen sketch{count ? ' · ' + count : ''}</summary>
  {#if c.theme.lean}
    <p>Sketches are hidden in Lean mode.</p>
  {:else}
    <label>Placement
      <select aria-label="Sketch placement" value={node.sketch?.placement ?? c.inkPlacement}
        onchange={(event) => c.setSketchPlacement(node.id, event.currentTarget.value as InkPlacement)}>
        <option value="on">On node</option>
        <option value="beside">Beside node</option>
      </select>
    </label>
    {#if active}
      <div class="tools">
        <button class="btn bordered" aria-pressed={c.inkTool === 'draw'} onclick={() => c.inkTool = 'draw'}>Pen</button>
        <button class="btn bordered" aria-pressed={c.inkTool === 'erase'} disabled={!count} onclick={() => c.inkTool = 'erase'}>Eraser</button>
        <label>Ink colour <input type="color" bind:value={c.inkColor} /></label>
        <label>Width <input type="range" min="1" max="16" step="1" bind:value={c.inkWidth} /></label>
      </div>
      <p>Draw in the outlined area. Tap with the eraser to remove a stroke.</p>
      {#if count >= MAX_INK_STROKES}<p role="status">Erase a stroke before adding another.</p>{/if}
      <button class="btn bordered" onclick={() => c.sketchTarget = null}>Done sketching</button>
    {:else}
      <button class="btn bordered" onclick={() => c.startSketch(node.id)}>{count ? 'Edit sketch' : 'Draw sketch'}</button>
    {/if}
  {/if}
</details>

<style>
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  p { font-size: 12px; margin: 3px 0; }
  label, .tools { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  input[type=range] { width: 86px; }
  input[type=color] { width: 28px; height: 25px; }
</style>
