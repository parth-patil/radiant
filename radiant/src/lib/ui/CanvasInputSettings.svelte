<script lang="ts">
  import type { CanvasGestures } from '../render/camera';
  import type { AppController } from './controller.svelte';
  let { c }: { c: AppController } = $props();
  const toggles = [
    ['pinch', 'Pinch to zoom'], ['space', 'Space-drag pans'], ['middle', 'Middle-button drag pans']
  ] as const;
</script>

<details>
  <summary>Canvas input</summary>
  <label>Scroll or plain wheel
    <select value={c.canvasGestures.wheel} onchange={(e) =>
      c.setCanvasGestures({ wheel: e.currentTarget.value as CanvasGestures['wheel'] })}>
      <option value="pan">Pan</option>
      <option value="zoom">Zoom</option>
      <option value="off">Disabled</option>
    </select>
  </label>
  <label>Wheel zoom modifier
    <select value={c.canvasGestures.zoomModifier} onchange={(e) =>
      c.setCanvasGestures({ zoomModifier: e.currentTarget.value as CanvasGestures['zoomModifier'] })}>
      <option value="command-or-option">Command or Option</option>
      <option value="command">Command</option>
      <option value="option">Option</option>
      <option value="shift">Shift</option>
      <option value="off">Disabled</option>
    </select>
  </label>
  {#each toggles as [key, label] (key)}
    <label>
      <input type="checkbox" checked={c.canvasGestures[key]} onchange={(e) =>
        c.setCanvasGestures({ [key]: e.currentTarget.checked })} />
      {label}
    </label>
  {/each}
</details>

<style>
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  label { display: flex; align-items: center; gap: 6px; margin: 5px 0; font-size: 12px; }
  select { margin-inline-start: auto; min-width: 0; }
</style>
