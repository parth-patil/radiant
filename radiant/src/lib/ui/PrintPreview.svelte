<script lang="ts">
  import type { Rect } from '../core/types';
  import { PAPER_SIZES, planPrint, type PrintSettings } from './print-layout';

  let { settings = $bindable(), source, issue = $bindable(''), previewError }: {
    settings: PrintSettings;
    source: { url: string; crop: Rect } | null;
    issue?: string;
    previewError: string;
  } = $props();
  let index = $state(0);
  const paperSizes = Object.entries(PAPER_SIZES) as [PrintSettings['paper'], (typeof PAPER_SIZES)[PrintSettings['paper']]][];
  const preview = $derived.by(() => {
    if (!source) return null;
    try { return { plan: planPrint(source.crop, settings), error: '' }; }
    catch (error) { return { plan: null, error: (error as Error).message }; }
  });
  const plan = $derived(preview?.plan);
  const count = $derived(plan ? plan.columns * plan.rows : 0);
  const page = $derived(count ? Math.min(index, count - 1) : 0);
  const layout = $derived(plan?.page(page));

  $effect(() => { issue = preview?.error ?? ''; });
  const percent = (value: number, whole: number) => (value / whole * 100) + '%';

  function change<K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) {
    index = 0;
    settings = { ...settings, [key]: value };
  }
</script>

<div class="paper-settings">
  <label>
    Paper size
    <select class="field" value={settings.paper} onchange={(event) => change('paper', event.currentTarget.value as PrintSettings['paper'])}>
      {#each paperSizes as [id, paper] (id)}
        <option value={id}>{paper.label}</option>
      {/each}
    </select>
  </label>
  <label>
    Orientation
    <select class="field" value={settings.orientation} onchange={(event) => change('orientation', event.currentTarget.value as PrintSettings['orientation'])}>
      <option value="portrait">Portrait</option>
      <option value="landscape">Landscape</option>
    </select>
  </label>
  <label>
    Margin (mm)
    <input class="field" type="number" step="any" min="0"
      value={settings.marginMm} oninput={(event) => change('marginMm', event.currentTarget.valueAsNumber)} required />
  </label>
  <label>
    Pagination
    <select class="field" value={settings.tiled ? 'tile' : 'fit'} onchange={(event) => change('tiled', event.currentTarget.value === 'tile')}>
      <option value="fit">Fit on one page</option>
      <option value="tile">Tile at actual size</option>
    </select>
  </label>
</div>

<div class="preview">
  {#if previewError}
    <p role="alert">{previewError}</p>
  {:else if preview?.error}
    <p role="alert">{preview.error}</p>
  {:else if source && plan && layout}
    <div class="sheet" style:aspect-ratio={plan.paper.join(' / ')}>
      <div class="content"
        style:left={percent(layout.frame.x, plan.paper[0])}
        style:top={percent(layout.frame.y, plan.paper[1])}
        style:width={percent(layout.frame.w, plan.paper[0])}
        style:height={percent(layout.frame.h, plan.paper[1])}>
        <img src={source.url} alt={`Print preview, page ${page + 1}`}
          style:left={percent(source.crop.x - layout.crop.x, layout.crop.w)}
          style:top={percent(source.crop.y - layout.crop.y, layout.crop.h)}
          style:width={percent(source.crop.w, layout.crop.w)}
          style:height={percent(source.crop.h, layout.crop.h)} />
      </div>
    </div>
    <div class="preview-nav">
      <button class="btn bordered" type="button" disabled={page === 0} onclick={() => index = page - 1}>Previous</button>
      <span role="status">Page {page + 1} of {count}{#if count > 1} · {plan.columns} × {plan.rows} sheets{/if}</span>
      <button class="btn bordered" type="button" disabled={page + 1 === count} onclick={() => index = page + 1}>Next</button>
    </div>
  {:else}
    <p role="status">Preparing page preview…</p>
  {/if}
</div>

<style>
  .paper-settings { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  label { display: grid; gap: 4px; min-width: 0; font-size: 12px; }
  .preview { display: grid; gap: 8px; }
  .sheet { position: relative; width: min(100%, 245px); margin-inline: auto; background: white; box-shadow: 0 0 0 1px #888; }
  .content { position: absolute; overflow: hidden; }
  img { position: absolute; display: block; max-width: none; }
  .preview-nav { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; }
  p { margin: 0; }
</style>
