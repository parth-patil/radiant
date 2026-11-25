<script lang="ts">
  import type { AppController } from './controller.svelte';
  import { CAPTURE_LABELS } from './presentation.svelte';
  let { c }: { c: AppController } = $props();
  const p = $derived(c.presentation);
  const info = $derived(p.info());
  const target = $derived.by(() => {
    void c.rev;
    const id = p.capture ? p.captureTarget() : null;
    return id ? c.doc.nodes[id]?.text.trim() || 'Untitled' : '';
  });
  const captures = $derived.by(() => {
    void c.rev;
    return p.captured.flatMap((x) => c.doc.nodes[x.id] ? [{ ...x, text: c.doc.nodes[x.id].text }] : []);
  });

  // Laser pointer (PRS-26): a DOM dot that follows the pointer while L is held. It never redraws the canvas.
  let dot: HTMLDivElement | undefined = $state();
  let x = 0, y = 0;
  function track(e: PointerEvent) {
    x = e.clientX;
    y = e.clientY;
    if (dot) dot.style.transform = `translate(${x}px, ${y}px)`;
  }
  $effect(() => {
    if (dot) dot.style.transform = `translate(${x}px, ${y}px)`;
  });

  let field: HTMLInputElement | undefined = $state();
  $effect(() => { if (p.capture) field?.focus(); });
  function done() {
    (document.querySelector('canvas.map') as HTMLElement | null)?.focus();
  }
  function onCaptureKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      p.commitCapture(e.currentTarget instanceof HTMLInputElement ? e.currentTarget.value : '');
      done();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      p.cancelCapture();
      done();
    }
  }
</script>

<svelte:window onpointermove={track} onblur={() => { p.laser = false; }} />

{#if info?.caption}
  <div class="caption" aria-live="polite">{info.caption}</div>
{/if}

{#if info?.special === 'captured' && captures.length}
  <section class="captured" aria-label="Captured during this talk">
    <h2>Captured</h2>
    <ul>
      {#each captures as item (item.id)}<li><span class="kind {item.kind}">{CAPTURE_LABELS[item.kind]}</span> {item.text}</li>{/each}
    </ul>
  </section>
{/if}

{#if p.capture}
  <form class="capture" onsubmit={(e) => e.preventDefault()}>
    <label for="presentation-capture">{CAPTURE_LABELS[p.capture]} under “{target}”</label>
    <input id="presentation-capture" class="field" bind:this={field} autocomplete="off" spellcheck="true"
      placeholder="Type and press Return" onkeydown={onCaptureKey} onblur={() => { if (p.capture) { p.cancelCapture(); } }} />
  </form>
{/if}

<div class="curtain" aria-hidden="true" style:background={c.theme.background} style:opacity={p.curtain}></div>

{#if p.laser}
  <div class="laser" bind:this={dot} aria-hidden="true"></div>
{/if}

{#if p.blank}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="blank" onclick={() => { p.blank = false; }} title="Press B or . to show the map again"></div>
{/if}

<style>
  .caption {
    position: absolute;
    left: 50%;
    bottom: 76px;
    transform: translateX(-50%);
    max-width: min(88vw, 1400px);
    padding: 10px 22px;
    border-radius: 12px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    color: var(--text);
    font-size: clamp(24px, 3.4vw, 54px);
    font-weight: 600;
    line-height: 1.2;
    text-align: center;
    z-index: 6;
    pointer-events: none;
  }
  .captured {
    position: absolute;
    top: 64px;
    right: 24px;
    width: min(420px, 40vw);
    max-height: 60vh;
    overflow: auto;
    padding: 14px 18px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    z-index: 6;
  }
  .captured h2 {
    margin: 0 0 8px;
    font-size: 20px;
  }
  .captured ul {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: 8px;
    font-size: 16px;
  }
  .kind {
    display: inline-block;
    min-width: 72px;
    color: var(--text-dim);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .capture {
    position: absolute;
    left: 50%;
    top: 30%;
    transform: translateX(-50%);
    display: grid;
    gap: 6px;
    width: min(560px, 80vw);
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    z-index: 9;
  }
  .capture label {
    color: var(--text-dim);
    font-size: 12px;
  }
  .capture input {
    font-size: 18px;
  }
  .curtain {
    position: absolute;
    inset: 0;
    pointer-events: none;
    transition: opacity 150ms linear;
    z-index: 5;
  }
  .laser {
    position: fixed;
    left: -18px;
    top: -18px;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255, 40, 40, 0.95) 0 22%, rgba(255, 40, 40, 0.45) 40%, rgba(255, 40, 40, 0) 70%);
    pointer-events: none;
    z-index: 20;
  }
  .blank {
    position: fixed;
    inset: 0;
    background: #000;
    z-index: 19;
    cursor: none;
  }
</style>
