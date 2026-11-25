<script lang="ts">
  import {
    addSteps, autoTour, createPresentation, deletePresentation, deleteSteps, duplicatePresentation, elementBounds,
    framesAsSteps, moveStep, renamePresentation, resolveStep, setPresentationOptions, setSteps, stepFromSelection, stepNote,
    stepTitle, updateStep, DEFAULT_DIM_OPACITY, type TourGranularity
  } from '../core/model/presentation';
  import { newId } from '../core/model/ids';
  import type { NodeId, Presentation, PresentationStep, Transaction } from '../core/types';
  import type { AppController } from './controller.svelte';
  import {
    exportPresentationPdf, exportPresentationPngZip, presentationFilename, speakingScript, type HandoutPaper
  } from './export-presentation';
  let { c }: { c: AppController } = $props();
  const p = $derived(c.presentation);

  // The document is edited in place, so copy the list to notice each change.
  const list = $derived.by(() => { void c.rev; return [...(c.doc.presentations ?? [])]; });
  const open = $derived.by(() => {
    if (p.openId === 'auto') return null;
    return list.find((x) => x.id === p.openId) ?? (p.openId === undefined ? list[0] ?? null : null);
  });
  const resolved = $derived.by(() => { void c.rev; return open ? open.steps.map((s) => resolveStep(c.doc, s)) : []; });
  const warnings = $derived.by(() => { void c.rev; void c.layoutTick; return open ? p.preflight(open) : []; });
  let granularity = $state<TourGranularity>('levels');
  let expanded = $state<string | null>(null);
  let dragging = $state<string | null>(null);
  let dropAt = $state<number | null>(null);
  /** Frames on the canvas, for "Add frames as steps" (CNV-60). */
  const frames = $derived.by(() => { void c.rev; return (c.doc.canvas?.elements ?? []).filter((el) => el.kind === 'frame').length; });
  let paper = $state<HandoutPaper>('slide');
  let withNotes = $state(false);
  let exporting = $state(false);

  function apply(tx: Transaction | null) {
    if (tx) c.editor.apply(tx);
  }
  function choose(id: string) {
    p.openId = id;
    expanded = null;
  }
  function create() {
    const id = newId();
    apply(createPresentation(c.doc, 'Presentation ' + (list.length + 1), [], id));
    choose(id);
  }
  function saveTour() {
    const id = newId();
    apply(createPresentation(c.doc, 'Tour', autoTour(c.doc, { granularity: p.tour.granularity }), id));
    if (p.tour.context === 'hide') apply(setPresentationOptions(c.doc, id, { context: 'hide' }));
    choose(id);
  }
  function duplicate(x: Presentation) {
    const id = newId();
    apply(duplicatePresentation(c.doc, x.id, id));
    choose(id);
  }
  function remove(x: Presentation) {
    apply(deletePresentation(c.doc, x.id));
    p.openId = undefined;
  }
  /** Selected canvas elements that exist, for steps that focus elements (CNV-60). */
  function selectedElements(): string[] {
    const exist = new Set((c.doc.canvas?.elements ?? []).map((el) => el.id));
    return c.canvasTools.selected.filter((id) => exist.has(id));
  }
  function addFromSelection(x: Presentation) {
    const ids = c.selIds.filter((id) => c.doc.nodes[id]);
    const elements = selectedElements();
    if (!ids.length && !elements.length) {
      c.say('Select the nodes or canvas elements this step should focus on.', 'info');
      return;
    }
    apply(addSteps(c.doc, x.id, [{ ...stepFromSelection(ids), ...(elements.length ? { elements } : {}) }]));
  }
  function addFrames(x: Presentation) {
    const steps = framesAsSteps(c.doc);
    if (!steps.length) c.say('Draw frames on the canvas first (F).', 'info');
    else apply(addSteps(c.doc, x.id, steps));
  }
  function focusOnSelection(x: Presentation, step: PresentationStep) {
    const elements = selectedElements();
    edit(x, step, { focus: c.selIds.filter((id) => c.doc.nodes[id]), elements: elements.length ? elements : undefined });
  }
  function edit(x: Presentation, step: PresentationStep, patch: Partial<Omit<PresentationStep, 'id'>>) {
    apply(updateStep(c.doc, x.id, step.id, patch));
  }
  const text = (value: string) => value.trim() || undefined;
  const seconds = (value: string) => {
    const n = Number(value);
    return value.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
  };
  function present(at?: number) {
    p.start({ id: open?.id ?? 'auto', at });
  }
  /** Handouts (PRS-50, 51): the open presentation, or the automatic tour with the chosen settings. */
  async function handout(kind: 'pdf' | 'png' | 'script') {
    if (exporting) return;
    const x = open ?? p.autoPresentation();
    const source = {
      doc: c.documentWithLayout(), theme: c.theme, images: new Map(c.pipeline.imageInfo), failedImages: c.failedImages,
      onImageFailure: (hash: string) => c.noteImageFailure(hash), assetUrl: (hash: string) => c.host.assetUrl(hash)
    };
    exporting = true;
    try {
      const [suffix, mime, bytes] = kind === 'pdf'
        ? ['.pdf', 'application/pdf', await exportPresentationPdf(source, x, { paper, notes: withNotes })] as const
        : kind === 'png'
          ? [' pictures.zip', 'application/zip', await exportPresentationPngZip(source, x, { paper })] as const
          : [' script.md', 'text/markdown', new TextEncoder().encode(speakingScript(source.doc, x))] as const;
      const name = presentationFilename(c.docTitle, x, suffix);
      if (await c.host.exportFile(name, mime, bytes)) c.say(`Exported ${name}.`);
    } catch (error) {
      c.say(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      exporting = false;
    }
  }
  /** Drop before the step at `index` (or at the end when `index` is the length). */
  function drop(x: Presentation, index: number) {
    const from = x.steps.findIndex((s) => s.id === dragging);
    if (dragging && from >= 0) apply(moveStep(c.doc, x.id, dragging, from < index ? index - 1 : index));
    dragging = null;
    dropAt = null;
  }

  /** A small drawing of the step's frame from the settled layout: focus dark, revealed light; focused elements too. */
  function thumbnail(step: PresentationStep) {
    void c.layoutTick;
    const boxes = c.pipeline?.layout.boxes;
    const r = resolveStep(c.doc, step);
    const ids: NodeId[] = [...r.focus, ...r.reveal];
    const items = ids.flatMap((id) => {
      const b = boxes?.get(id);
      return b ? [{ id, x: b.x - b.w / 2, y: b.y - b.h / 2, w: b.w, h: b.h, focus: r.focus.includes(id) }] : [];
    });
    if (r.elements.length) {
      // A frame is drawn light with its members dark, so frame steps tell apart.
      const wanted = new Set(r.elements);
      for (const el of c.doc.canvas?.elements ?? []) {
        if (wanted.has(el.id) || (el.frame && wanted.has(el.frame))) items.push({ id: el.id, ...elementBounds(el), focus: el.kind !== 'frame' });
      }
    }
    if (!items.length) return null;
    const x0 = Math.min(...items.map((b) => b.x)), y0 = Math.min(...items.map((b) => b.y));
    const x1 = Math.max(...items.map((b) => b.x + b.w)), y1 = Math.max(...items.map((b) => b.y + b.h));
    const pad = Math.max(x1 - x0, y1 - y0) * 0.06 + 4;
    return { viewBox: [x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad].join(' '), items: items.slice(0, 200) };
  }
</script>

{#snippet handouts()}
  <details class="handouts">
    <summary>Handouts</summary>
    <div class="grid">
      <label>Page
        <select bind:value={paper}><option value="slide">Slide 16:9</option><option value="a4">A4 landscape</option></select>
      </label>
      <label class="check"><input type="checkbox" bind:checked={withNotes} /> Speaker notes in the PDF</label>
    </div>
    <div class="row">
      <button class="btn bordered" type="button" disabled={exporting} onclick={() => handout('pdf')}>PDF…</button>
      <button class="btn bordered" type="button" disabled={exporting} onclick={() => handout('png')}>PNG pictures…</button>
      <button class="btn bordered" type="button" disabled={exporting} onclick={() => handout('script')}>Speaking script…</button>
    </div>
    <p class="dim">One page or picture per step, as the audience sees it.{withNotes ? ' Notes go under each PDF page.' : ''}</p>
  </details>
{/snippet}

<aside class="side right presentations" aria-label="Presentations">
  <header>
    <h2>Presentations</h2>
    <button class="btn" type="button" aria-label="Close presentations" onclick={() => { p.showPanel = false; }}>✕</button>
  </header>

  <div class="list" role="listbox" aria-label="Presentations in this map">
    <button type="button" role="option" aria-selected={!open} class:on={!open} onclick={() => choose('auto')}>Automatic tour</button>
    {#each list as x (x.id)}
      <button type="button" role="option" aria-selected={open?.id === x.id} class:on={open?.id === x.id} onclick={() => choose(x.id)}>
        {x.name} <span class="dim">{x.steps.length} {x.steps.length === 1 ? 'step' : 'steps'}</span>
      </button>
    {/each}
  </div>
  <div class="row">
    <button class="btn bordered" type="button" onclick={create}>New</button>
    {#if open}
      <button class="btn bordered" type="button" onclick={() => duplicate(open)}>Duplicate</button>
      <button class="btn bordered" type="button" onclick={() => remove(open)}>Delete</button>
    {/if}
  </div>

  {#if !open}
    <section>
      <p class="dim">Walks the map from the centre, branch by branch. Nothing is saved.</p>
      <label>Steps
        <select value={p.tour.granularity} onchange={(e) => p.setTour({ granularity: e.currentTarget.value as TourGranularity })}>
          <option value="levels">Node by node</option>
          <option value="nodes">Node by node, one child per press</option>
          <option value="branches">One step per main branch</option>
        </select>
      </label>
      <label>The rest of the map
        <select value={p.tour.context} onchange={(e) => p.setTour({ context: e.currentTarget.value as 'dim' | 'hide' })}>
          <option value="dim">Dimmed</option>
          <option value="hide">Hidden</option>
        </select>
      </label>
      <div class="row">
        <button class="btn primary" type="button" onclick={() => present()}>Present</button>
        <button class="btn bordered" type="button" onclick={saveTour}>Save as presentation</button>
      </div>
      <div class="row">
        <button class="btn bordered" type="button" onclick={() => p.openPresenter()}>Presenter console…</button>
      </div>
    </section>
    {@render handouts()}
  {:else}
    <section>
      <label>Name
        <input class="field" value={open.name} onchange={(e) => apply(renamePresentation(c.doc, open.id, e.currentTarget.value))} />
      </label>
      <div class="grid">
        <label>Reveal
          <select value={open.reveal ?? 'progressive'} onchange={(e) => apply(setPresentationOptions(c.doc, open.id,
            { reveal: e.currentTarget.value === 'all' ? 'all' : undefined }))}>
            <option value="progressive">Step by step</option><option value="all">Whole map</option>
          </select>
        </label>
        <label>The rest
          <select value={open.context ?? 'dim'} onchange={(e) => apply(setPresentationOptions(c.doc, open.id,
            { context: e.currentTarget.value === 'hide' ? 'hide' : undefined }))}>
            <option value="dim">Dimmed</option><option value="hide">Hidden</option>
          </select>
        </label>
        <label>Motion
          <select value={open.motion ?? 'full'} onchange={(e) => apply(setPresentationOptions(c.doc, open.id,
            { motion: e.currentTarget.value === 'full' ? undefined : e.currentTarget.value as 'gentle' | 'none' }))}>
            <option value="full">Full</option><option value="gentle">Gentle</option><option value="none">None</option>
          </select>
        </label>
        <label>Minutes
          <input class="field" type="number" min="1" max="600" value={open.targetMinutes ?? ''}
            onchange={(e) => apply(setPresentationOptions(c.doc, open.id, { targetMinutes: seconds(e.currentTarget.value) }))} />
        </label>
      </div>
      <label>Dim level <span class="dim">{Math.round((open.dimOpacity ?? DEFAULT_DIM_OPACITY) * 100)}%</span>
        <input type="range" min="0.1" max="0.6" step="0.02" value={open.dimOpacity ?? DEFAULT_DIM_OPACITY}
          onchange={(e) => apply(setPresentationOptions(c.doc, open.id, { dimOpacity: Number(e.currentTarget.value) }))} />
      </label>
      <div class="row">
        <button class="btn primary" type="button" disabled={!resolved.some((r) => !r.broken && !r.step.skip)} onclick={() => present()}>Present</button>
        <button class="btn bordered" type="button" onclick={() => addFromSelection(open)}>Add step from selection</button>
        {#if frames}
          <button class="btn bordered" type="button" title="One step per frame, top to bottom, then left to right"
            onclick={() => addFrames(open)}>Add frames as steps</button>
        {/if}
        <button class="btn bordered" type="button" onclick={() => p.openPresenter()}>Presenter console…</button>
      </div>
      <div class="row">
        <select aria-label="Kind of generated steps" bind:value={granularity}>
          <option value="levels">Node by node</option>
          <option value="nodes">One child per press</option>
          <option value="branches">Per main branch</option>
        </select>
        <button class="btn bordered" type="button"
          onclick={() => apply(setSteps(c.doc, open.id, autoTour(c.doc, { granularity, selection: c.selIds.length > 1 ? c.selIds : undefined })))}>
          Generate steps</button>
      </div>
    </section>

    {@render handouts()}

    {#if warnings.length}
      <section class="warnings" aria-label="Pre-flight check">
        <h3>Check before presenting</h3>
        <ul>{#each warnings as w, i (i)}<li>{w.text}</li>{/each}</ul>
      </section>
    {/if}

    <ol class="steps" aria-label="Steps">
      {#each open.steps as step, i (step.id)}
        {@const r = resolved[i]}
        {@const thumb = thumbnail(step)}
        <li class:broken={r?.broken} class:skipped={step.skip} class:drop={dropAt === i} draggable="true"
          ondragstart={(e) => { dragging = step.id; e.dataTransfer?.setData('text/plain', step.id); }}
          ondragover={(e) => { if (dragging) { e.preventDefault(); dropAt = i; } }}
          ondragleave={() => { if (dropAt === i) dropAt = null; }}
          ondrop={(e) => { e.preventDefault(); drop(open, i); }}
          ondragend={() => { dragging = null; dropAt = null; }}>
          <div class="head">
            <span class="num">{i + 1}</span>
            {#if thumb}
              <svg class="thumb" viewBox={thumb.viewBox} aria-hidden="true">
                {#each thumb.items as b (b.id)}<rect x={b.x} y={b.y} width={b.w} height={b.h} rx="4" class:focus={b.focus} />{/each}
              </svg>
            {:else}<span class="thumb empty" aria-hidden="true"></span>{/if}
            <button type="button" class="title" aria-expanded={expanded === step.id}
              onclick={() => { expanded = expanded === step.id ? null : step.id; }}>
              {stepTitle(c.doc, step) || 'Untitled step'}
              {#if r?.broken}<span class="tag">broken</span>{/if}
              {#if step.skip}<span class="tag">skipped</span>{/if}
              {#if r && r.reveal.length}<span class="dim">+{r.reveal.length}</span>{/if}
            </button>
            <button class="btn" type="button" title="Move earlier" aria-label="Move step earlier" disabled={i === 0}
              onclick={() => apply(moveStep(c.doc, open.id, step.id, i - 1))}>↑</button>
            <button class="btn" type="button" title="Move later" aria-label="Move step later" disabled={i === open.steps.length - 1}
              onclick={() => apply(moveStep(c.doc, open.id, step.id, i + 1))}>↓</button>
          </div>
          {#if expanded === step.id}
            <div class="detail">
              <label>Title <input class="field" value={step.title ?? ''} placeholder={stepTitle(c.doc, { ...step, title: undefined })}
                onchange={(e) => edit(open, step, { title: text(e.currentTarget.value) })} /></label>
              <label>Caption <input class="field" value={step.caption ?? ''} placeholder="One-line takeaway shown large"
                onchange={(e) => edit(open, step, { caption: text(e.currentTarget.value) })} /></label>
              <label>Speaker note <textarea class="field" rows="3" value={step.note ?? ''}
                placeholder={stepNote(c.doc, { ...step, note: undefined }) ?? 'Shown only to you'}
                onchange={(e) => edit(open, step, { note: text(e.currentTarget.value) })}></textarea></label>
              <div class="grid">
                <label>Frame
                  <select value={step.frame ?? 'subtree'} onchange={(e) => edit(open, step,
                    { frame: e.currentTarget.value === 'subtree' ? undefined : e.currentTarget.value as 'nodes' | 'map' })}>
                    <option value="subtree">Focus and reveals</option><option value="nodes">Focus only</option><option value="map">Whole map</option>
                  </select>
                </label>
                <label>Build
                  <select value={step.build ?? 'all'} onchange={(e) => edit(open, step,
                    { build: e.currentTarget.value === 'each' ? 'each' : undefined })}>
                    <option value="all">All at once</option><option value="each">One per press</option>
                  </select>
                </label>
                <label>Dim
                  <select value={step.dim ?? 'others'} onchange={(e) => edit(open, step,
                    { dim: e.currentTarget.value === 'none' ? 'none' : undefined })}>
                    <option value="others">The rest</option><option value="none">Nothing</option>
                  </select>
                </label>
                <label>Seconds
                  <input class="field" type="number" min="1" value={step.seconds ?? ''}
                    onchange={(e) => edit(open, step, { seconds: seconds(e.currentTarget.value) })} />
                </label>
              </div>
              <label class="check"><input type="checkbox" checked={!!step.skip}
                onchange={(e) => edit(open, step, { skip: e.currentTarget.checked || undefined })} /> Skip this step</label>
              <div class="row">
                <button class="btn bordered" type="button" disabled={r?.broken || step.skip} onclick={() => present(i)}>Present from this step</button>
                <button class="btn bordered" type="button" disabled={!c.selIds.length && !c.canvasTools.selected.length}
                  onclick={() => focusOnSelection(open, step)}>Focus on selection</button>
                <button class="btn bordered" type="button" onclick={() => apply(deleteSteps(c.doc, open.id, [step.id]))}>Delete step</button>
              </div>
            </div>
          {/if}
        </li>
      {/each}
      {#if open.steps.length}
        <li class="end" class:drop={dropAt === open.steps.length}
          ondragover={(e) => { if (dragging) { e.preventDefault(); dropAt = open.steps.length; } }}
          ondrop={(e) => { e.preventDefault(); drop(open, open.steps.length); }}></li>
      {:else}
        <li class="empty dim">No steps yet. Select nodes and add a step, or generate steps from the map.</li>
      {/if}
    </ol>
  {/if}
</aside>

<style>
  .presentations {
    gap: 10px;
    padding: 10px 12px;
    overflow: auto;
    font-size: 12px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-size: 14px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 12px;
  }
  section {
    display: grid;
    gap: 8px;
  }
  label {
    display: grid;
    gap: 3px;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .dim {
    color: var(--text-dim);
  }
  .list {
    display: grid;
    gap: 2px;
  }
  .list button {
    display: flex;
    justify-content: space-between;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .list button.on {
    background: var(--hover);
    color: var(--accent);
  }
  .warnings ul {
    margin: 0;
    padding-left: 16px;
    color: #b45309;
  }
  .steps {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .steps li {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 4px 6px;
  }
  .steps li.drop {
    border-top: 2px solid var(--accent);
  }
  .steps li.end, .steps li.empty {
    border: 0;
    min-height: 8px;
  }
  .steps li.broken .title {
    color: #b91c1c;
  }
  .steps li.skipped {
    opacity: 0.6;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: grab;
  }
  .num {
    width: 18px;
    color: var(--text-dim);
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .thumb {
    flex: none;
    width: 56px;
    height: 34px;
    border-radius: 4px;
    background: var(--hover);
  }
  .thumb rect {
    fill: currentColor;
    opacity: 0.25;
  }
  .thumb rect.focus {
    fill: var(--accent);
    opacity: 0.9;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    padding: 4px;
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .tag {
    margin-left: 4px;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--hover);
    color: var(--text-dim);
    font-size: 10px;
  }
  .handouts {
    display: grid;
    gap: 8px;
  }
  .handouts summary {
    cursor: pointer;
    font-weight: 600;
  }
  .handouts[open] {
    display: grid;
  }
  .handouts > :not(summary) {
    margin-top: 8px;
  }
  .handouts p {
    margin: 0;
  }
  .detail {
    display: grid;
    gap: 8px;
    padding: 8px 2px 4px;
  }
</style>
