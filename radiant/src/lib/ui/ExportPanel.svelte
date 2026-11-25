<script lang="ts">
  import type { Rect } from '../core/types';
  import type { PrintSettings } from './print-layout';
  import PrintPreview from './PrintPreview.svelte';
  import type { AppController } from './controller.svelte';
  import { exportFilename, exportFormats, exportMap, exportMapFolder, isVisual, type ExportFormat, type ExportScope } from './export-map';

  let { c }: { c: AppController } = $props();

  let dialog: HTMLDialogElement;
  let format = $state<ExportFormat>('png');
  let scope = $state<ExportScope>('map');
  let scale = $state(1);
  let transparent = $state(false);
  let print = $state<PrintSettings>({ paper: 'a4', orientation: 'portrait', marginMm: 10, tiled: false });
  let show = $state(false);
  let preview = $state.raw<{ url: string; crop: Rect } | null>(null);
  let previewError = $state('');
  let printError = $state('');
  let printOnly = $state(false);
  let printTheme: string | undefined;
  let collapsed = $state(false);
  let crossLinks = $state(false);
  let answers = $state(false);
  let busy = $state(false);
  let message = $state('');
  let failed = $state(false);
  let receipt = $state('');
  let staged = $state.raw<{ name: string; token: string } | null>(null);
  let dragStart: { x: number; y: number } | null = null;

  const visual = $derived(isVisual(format));
  const hasAnswers = $derived.by(() => {
    void c.rev;
    return Object.values(c.doc.nodes).some((node) => node.blankAnswer !== undefined);
  });
  const selected = $derived(c.selIds.length > 0);
  const formats = Object.entries(exportFormats) as Array<[ExportFormat, (typeof exportFormats)[ExportFormat]]>;

  function open(printing = false) {
    printOnly = printing;
    if (printing) format = 'pdf';
    const theme = c.theme;
    if (printTheme !== theme.id) {
      print = { ...print, orientation: theme.landscapePrint ? 'landscape' : 'portrait' };
      printTheme = theme.id;
    }
    show = true;
    if (scope === 'selection' && !selected) scope = 'map';
    clearStatus();
    dialog.showModal();
  }

  $effect(() => {
    const requested = c.exportRequest;
    if (!requested || !dialog) return;
    c.exportRequest = null;
    if (dialog.open) return;
    if (typeof requested === 'object') {
      format = requested.format;
      scope = requested.scope;
    }
    open(requested === 'print');
  });

  function clearStatus() {
    receipt = '';
    staged = null;
    message = '';
    failed = false;
  }

  function formatChanged() {
    if (format === 'flashcards' && selected) scope = 'selection';
    else if (!isVisual(format) && scope === 'viewport') scope = 'map';
    clearStatus();
  }

  function cancel(event: Event) {
    if (busy) event.preventDefault();
  }

  function source() {
    return {
      doc: format === 'flashcards' ? c.doc : c.documentWithLayout(),
      theme: c.theme,
      selection: [...c.selIds],
      viewport: c.camera.visibleRect(),
      zoom: c.camera.zoom,
      linkColor: c.theme.connectionColor ?? getComputedStyle(dialog).getPropertyValue('--text-dim').trim(),
      images: new Map(c.pipeline.imageInfo),
      failedImages: c.failedImages,
      onImageFailure: (hash: string) => c.noteImageFailure(hash),
      assetUrl: (hash: string) => c.host.assetUrl(hash)
    };
  }

  function prepare(target: ExportFormat) {
    return exportMap(source(), {
      format: target, scope, scale: target === 'png' ? scale : 1, transparent,
      tiles: print.tiled, print: target === 'pdf' ? { ...print } : undefined, collapsed, crossLinks, answers
    });
  }

  $effect(() => {
    if (!show || format !== 'pdf') return;
    const options = { format: 'svg', scope, scale: 1, transparent, tiles: false, printPreview: true, collapsed, crossLinks, answers } as const;
    let abandoned = false;
    let url: string | undefined;
    preview = null;
    previewError = '';
    // A fresh snapshot keeps the preview in step with document changes while the dialog is open.
    void c.rev;
    const timer = window.setTimeout(async () => {
      try {
        const bytes = await exportMap(source(), options);
        if (abandoned) return;
        const markup = new TextDecoder().decode(bytes);
        const svg = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
        const [x, y, w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
        if (![x, y, w, h].every(Number.isFinite) || !(w > 0 && h > 0)) throw new Error('Could not measure page preview.');
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
        preview = { url, crop: { x, y, w, h } };
      } catch (error) {
        if (!abandoned) previewError = error instanceof Error ? error.message : String(error);
      }
    }, 60);
    return () => {
      abandoned = true;
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  });

  $effect(() => {
    void print;
    staged = null;
  });

  function openPrint() {
    if (busy || !preview || printError) return;
    const popup = c.host.openPdfForPrint ? null : window.open('', '_blank');
    if (popup) popup.opener = null;
    void transfer(async () => {
      try {
        if (!c.host.openPdfForPrint && !popup) throw new Error('Allow a new tab to open the PDF for printing, or save it instead.');
        const bytes = await prepare('pdf');
        const name = exportFilename(c.docTitle, 'pdf');
        if (c.host.openPdfForPrint) await c.host.openPdfForPrint(name, bytes);
        else if (popup) {
          const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
          popup.location.replace(url);
          window.setTimeout(() => URL.revokeObjectURL(url), 300_000);
        }
      } catch (error) {
        popup?.close();
        throw error;
      }
      receipt = exportFormats.pdf.limits;
      return 'PDF opened in your viewer. Use its Print command.';
    });
  }

  async function transfer(task: () => Promise<string>) {
    if (busy) return;
    busy = true;
    failed = false;
    message = 'Preparing export…';
    receipt = '';
    try {
      message = await task();
    } catch (error) {
      failed = true;
      message = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }

  function save(event: SubmitEvent) {
    event.preventDefault();
    void transfer(async () => {
      const name = exportFilename(c.docTitle, format);
      const bytes = await prepare(format);
      const saved = await c.host.exportFile(name, exportFormats[format].mime, bytes);
      if (saved) receipt = exportFormats[format].limits;
      return saved ? `Exported ${name}.` : '';
    });
  }

  function saveFolder() {
    void transfer(async () => {
      const write = c.host.exportPortableDirectory;
      if (!write) return '';
      const name = exportFilename(c.docTitle, 'bundle').replace(/\.radiant\.zip$/, '.radiant-bundle');
      const saved = await write.call(c.host, name, () => exportMapFolder(source(), scope));
      if (saved) receipt = exportFormats.bundle.limits;
      return saved ? `Exported ${name}.` : '';
    });
  }

  function prepareDrag() {
    void transfer(async () => {
      if (!c.host.prepareDragFile) return '';
      const name = exportFilename(c.docTitle, format);
      staged = { name, token: await c.host.prepareDragFile(name, await prepare(format)) };
      receipt = exportFormats[format].limits;
      return 'Drag the prepared file to Finder or another app.';
    });
  }

  function startDrag(event: PointerEvent) {
    if (!dragStart || !staged || !c.host.startDragFile || !(event.buttons & 1)) return;
    if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) < 5) return;
    dragStart = null;
    const button = event.currentTarget as HTMLButtonElement;
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
    void c.host.startDragFile(staged.token).catch((error) => {
      failed = true;
      message = error instanceof Error ? error.message : String(error);
    });
  }

  const canWriteClipboard = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
  const canCopyImage = $derived(!!c.host.writeImageClipboard || canWriteClipboard);
  const canCopyVector = $derived(!!c.host.writeVectorClipboard || canWriteClipboard && ClipboardItem.supports?.('text/html') !== false);

  async function vectorClipboardHtml(svg: Blob): Promise<Blob> {
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not encode the vector clipboard image.'));
      reader.readAsDataURL(svg);
    });
    return new Blob([`<html><body><img alt="Radiant map branch" src="${url}"></body></html>`], { type: 'text/html' });
  }

  function copyVector() {
    if (!canCopyVector || scope !== 'selection' || !selected) return;
    void transfer(async () => {
      const bytes = prepare('svg');
      if (c.host.writeVectorClipboard) await c.host.writeVectorClipboard(await bytes);
      else {
        const svg = bytes.then((value) => new Blob([value], { type: 'image/svg+xml' }));
        const content: Record<string, Promise<Blob>> = { 'text/html': svg.then(vectorClipboardHtml) };
        if (ClipboardItem.supports?.('image/svg+xml')) content['image/svg+xml'] = svg;
        await navigator.clipboard.write([new ClipboardItem(content)]);
      }
      return 'Copied the selected subtrees as vector artwork.';
    });
  }

  function copyImage() {
    if (!canCopyImage || scope !== 'selection' || !selected) return;
    void transfer(async () => {
      if (c.host.writeImageClipboard) {
        const [png, svg] = await Promise.all([prepare('png'), prepare('svg')]);
        await c.host.writeImageClipboard(png, svg);
        return 'Copied the selected subtrees as an image.';
      }
      const png = 'image/png';
      const svg = 'image/svg+xml';
      const content: Record<string, Promise<Blob>> = {};
      if (ClipboardItem.supports?.(svg)) content[svg] = prepare('svg').then((bytes) => new Blob([bytes], { type: svg }));
      content[png] = prepare('png').then((bytes) => new Blob([bytes], { type: png }));
      // WebKit requires clipboard.write itself to run in the button's user gesture.
      const writing = navigator.clipboard.write([new ClipboardItem(content)]);
      await Promise.all([...Object.values(content), writing]);
      return 'Copied the selected subtrees as an image.';
    });
  }

</script>

<button class="btn bordered" type="button" onclick={() => open()}>Export…</button>
<button class="btn bordered" type="button" onclick={() => open(true)}>Print…</button>

<dialog bind:this={dialog} class="dialog export-dialog" aria-labelledby="export-title"
  onclose={() => { show = false; preview = null; }}
  onkeydown={(e) => e.stopPropagation()} onkeyup={(e) => e.stopPropagation()} oncancel={cancel}>
  <h2 id="export-title">{printOnly ? 'Print layout' : 'Export map'}</h2>
  <form onsubmit={save}>
    <fieldset disabled={busy}>
      {#if !printOnly}<label>
        Format
        <select class="field" bind:value={format} onchange={formatChanged}>
          {#each formats as [key, value] (key)}
            <option value={key}>{value.label}</option>
          {/each}
        </select>
      </label>{/if}
      <label>
        Scope
        <select class="field" bind:value={scope} onchange={clearStatus}>
          <option value="map">Whole map</option>
          {#if visual}<option value="viewport">Visible area</option>{/if}
          <option value="selection" disabled={!selected}>{format === 'flashcards' ? 'Selected nodes' : 'Selected subtrees'}</option>
        </select>
      </label>

      {#if format === 'png'}
        <label>
          Scale
          <select class="field" bind:value={scale} onchange={clearStatus}>
            <option value={1}>1×</option>
            <option value={2}>2×</option>
            <option value={3}>3×</option>
            <option value={4}>4×</option>
          </select>
        </label>
      {/if}

      {#if format === 'pdf'}
        <PrintPreview bind:settings={print} source={preview} bind:issue={printError} {previewError} />
      {/if}

      {#if visual}
        <label class="check"><input type="checkbox" bind:checked={transparent} onchange={clearStatus} /> Transparent background</label>
        <label class="check"><input type="checkbox" bind:checked={collapsed} onchange={clearStatus} /> Expand collapsed branches</label>
        <label class="check"><input type="checkbox" bind:checked={crossLinks} onchange={clearStatus} /> Include cross-connections</label>
        {#if hasAnswers}
          <label class="check"><input type="checkbox" bind:checked={answers} onchange={clearStatus} /> Show stored recall answers</label>
        {/if}
      {/if}
    </fieldset>
    {#if !receipt}
      <section aria-label="Format limits"><p>{exportFormats[format].limits}</p></section>
    {/if}
    {#if message}
      <p role={failed ? 'alert' : 'status'} class:error={failed}>{message}</p>
    {/if}
    {#if receipt}
      <section aria-label="Export receipt"><p>{receipt}</p></section>
    {/if}
    {#if c.host.prepareDragFile && !printOnly}
      {#if staged}
        <button class="btn bordered drag-file" type="button" aria-label={`Drag ${staged.name} out of Radiant`}
          onpointerdown={(event) => {
            if (event.button !== 0) return;
            dragStart = { x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onpointermove={startDrag} onpointerup={() => dragStart = null} onpointercancel={() => dragStart = null}>
          {staged.name}
        </button>
      {:else}
        <button class="btn bordered" type="button" disabled={busy || (scope === 'selection' && !selected) || (format === 'pdf' && (!preview || !!printError))}
          onclick={prepareDrag}>Prepare file to drag…</button>
      {/if}
    {/if}
    <div class="btns">
      <button class="btn bordered" type="button" disabled={busy} onclick={() => dialog.close()}>Close</button>
      {#if format === 'bundle' && c.host.exportPortableDirectory}
        <button class="btn bordered" type="button" disabled={busy || (scope === 'selection' && !selected)} onclick={saveFolder}>Save folder…</button>
      {/if}
      {#if canCopyImage && format === 'png' && scope === 'selection'}
        <button class="btn bordered" type="button" disabled={busy || !selected} onclick={copyImage}>Copy image</button>
      {/if}
      {#if canCopyVector && (format === 'png' || format === 'svg') && scope === 'selection'}
        <button class="btn bordered" type="button" disabled={busy || !selected} onclick={copyVector}>Copy vector image</button>
      {/if}
      {#if format === 'pdf'}
        <button class="btn bordered" type="button" disabled={busy || !preview || !!printError} onclick={openPrint}>Open PDF for printing</button>
      {/if}
      <button class="btn bordered primary" disabled={busy || (scope === 'selection' && !selected) || (format === 'pdf' && (!preview || !!printError))}
        type="submit">{format === 'pdf' ? 'Save PDF…' : 'Export'}</button>
    </div>
  </form>
</dialog>

<style>
  .export-dialog {
    width: min(420px, calc(100vw - 32px));
  }
  fieldset {
    display: grid;
    gap: 12px;
    border: 0;
    padding: 0;
    margin: 0;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: 12px;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .drag-file { cursor: grab; touch-action: none; }
  .error {
    color: var(--danger, #c62828);
  }
</style>
