<script lang="ts">
  import { canvasFilterLabel } from './canvas-filter';
  import type { AppController } from './controller.svelte';
  import type { MotionLevel } from './presentation.svelte';
  let { c }: { c: AppController } = $props();
  const title = $derived.by(() => {
    void c.rev;
    const id = c.canvasBranch;
    return id ? c.doc.nodes[id]?.text.trim() || 'Untitled branch' : '';
  });
  const p = $derived(c.presentation);
  const info = $derived(c.presenting ? p.info() : null);
  const crumbs = $derived.by(() => {
    const all = info?.crumbs ?? [];
    const path = all.at(-1) === info?.title ? all.slice(0, -1) : all;
    return path.length > 3 ? [path[0], '…', ...path.slice(-2)] : path;
  });

  // The bar fades after 3 seconds without pointer movement (PRS-24); DOM only, the canvas is not redrawn.
  let idle = $state(false);
  let hovering = false;
  let timer = 0;
  function wake() {
    idle = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => { if (!hovering) idle = true; }, 3000);
  }
  $effect(() => {
    if (!c.presenting) return;
    wake();
    window.addEventListener('pointermove', wake, { passive: true });
    return () => {
      window.removeEventListener('pointermove', wake);
      clearTimeout(timer);
    };
  });
</script>

{#if c.presenting && info}
  <nav class="view-bar presentation" class:idle aria-label="Presentation controls"
    onpointerenter={() => { hovering = true; wake(); }} onpointerleave={() => { hovering = false; wake(); }}>
    <div class="progress" aria-hidden="true"><span style:width={(100 * info.number / Math.max(1, info.total)) + '%'}></span></div>
    <button class="btn bordered" type="button" disabled={p.atStart} onclick={() => p.previous()}
      title="Previous (Left, Up, Page Up)">Previous</button>
    <div class="position">
      <span class="step">{info.number} / {info.total}</span>
      {#if crumbs.length}
        <span class="crumbs" aria-label="Where in the map">{#each crumbs as crumb, i}{#if i}<span class="sep" aria-hidden="true">›</span>{/if}<span>{crumb}</span>{/each}</span>
        <span class="sep" aria-hidden="true">›</span>
      {/if}
      <strong>{info.title}</strong>
      {#if p.digits}<span class="digits">Go to {p.digits}…</span>{/if}
    </div>
    <button class="btn bordered" type="button" disabled={p.atEnd} onclick={() => p.next()}
      title="Next (Right, Down, Space, Page Down)">Next</button>
    <details class="options">
      <summary class="btn" title="Presentation options">Options</summary>
      <div class="menu">
        <label>Motion
          <select value={p.motion} onchange={(e) => p.setMotion(e.currentTarget.value as MotionLevel)}>
            <option value="full">Full</option><option value="gentle">Gentle</option><option value="none">None</option>
          </select>
        </label>
        <label>Dim the rest
          <input type="range" min="0.1" max="0.6" step="0.02" value={p.dimLevel}
            oninput={(e) => p.setDim(Number(e.currentTarget.value))} />
        </label>
        <label class="check"><input type="checkbox" checked={p.fullscreen} onchange={() => p.toggleFullscreen()} /> Full screen <kbd>F</kbd></label>
        <label class="check"><input type="checkbox" checked={p.fullscreenDefault}
          onchange={(e) => p.setFullscreenDefault(e.currentTarget.checked)} /> Start in full screen</label>
        <p class="keys">B blank · R re-centre · O whole map · L laser · Q A D capture · ⌫ back</p>
      </div>
    </details>
    <button class="btn" type="button" onclick={() => c.leaveCanvasView()} title="End presentation (Esc)">End</button>
  </nav>
  {#if info.detour}
    <button class="return-pill btn primary" type="button" onclick={() => p.returnToTalk()} title="Back to the step you left (Backspace goes back one)">Return to talk</button>
  {/if}
  <div class="readout" role="status" aria-live="polite" aria-atomic="true">{p.readout}</div>
{:else if c.canvasView?.kind === 'focus' || c.canvasFilter}
  <div class="view-bar focus">
    {#if c.canvasView?.kind === 'focus'}
      <strong>{title}</strong>
      <button class="btn bordered" type="button" onclick={() => c.leaveCanvasView()} title="Exit focus (Esc)">Exit focus</button>
    {/if}
    {#if c.canvasFilter}
      <strong aria-label={`Active filter ${canvasFilterLabel(c.canvasFilter)}`}>{canvasFilterLabel(c.canvasFilter)}</strong>
      {#if c.canvasFilter.kind === 'repeated' && c.repeatedWords.has(c.canvasFilter.value)}
        {@const word = c.repeatedWords.get(c.canvasFilter.value)!}
        <button class="btn bordered" type="button" onclick={() => void c.startWordMap(word.spelling)}>New map from “{word.spelling}”…</button>
      {/if}
      <button class="btn bordered" type="button" onclick={() => c.setCanvasFilter(null)}>Clear filter</button>
    {/if}
  </div>
{/if}

<style>
  .view-bar {
    position: absolute;
    left: 50%;
    display: flex;
    align-items: center;
    gap: 10px;
    transform: translateX(-50%);
    max-width: calc(100% - 28px);
    padding: 6px 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    z-index: 7;
  }
  .focus {
    top: 52px;
  }
  .presentation {
    bottom: 16px;
    overflow: visible;
    transition: opacity 400ms ease;
  }
  .presentation.idle:not(:focus-within) {
    opacity: 0;
  }
  .progress {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 2px;
    height: 2px;
    border-radius: 1px;
    background: var(--line);
    overflow: hidden;
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 200ms ease;
  }
  .position {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .step, .crumbs, .sep, .digits {
    color: var(--text-dim);
    white-space: nowrap;
  }
  .step {
    margin-right: 4px;
  }
  .crumbs {
    display: flex;
    gap: 6px;
    min-width: 0;
    max-width: 30vw;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 12px;
  }
  .crumbs span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .crumbs .sep {
    flex: none;
    overflow: visible;
  }
  .digits {
    font-variant-numeric: tabular-nums;
  }
  strong {
    min-width: 0;
    max-width: 34vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .options {
    position: relative;
  }
  .options summary {
    list-style: none;
    cursor: pointer;
  }
  .options summary::-webkit-details-marker {
    display: none;
  }
  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 10px);
    display: grid;
    gap: 8px;
    min-width: 230px;
    padding: 10px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    font-size: 12px;
  }
  .menu label {
    display: grid;
    gap: 4px;
  }
  .menu label.check {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .keys {
    margin: 0;
    color: var(--text-dim);
    line-height: 1.4;
  }
  .return-pill {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    border-radius: 999px;
    z-index: 7;
  }
  .readout {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
