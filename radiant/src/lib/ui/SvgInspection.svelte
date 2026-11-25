<script lang="ts">
  import { effectiveRepresentation } from '../core/art/representation';
  import { sanitizeSvg } from '../core/art/svg';
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();
  let open = $state(false);
  let preview = $state.raw<{ key: string; svg: SVGElement } | undefined>();
  let failed = $state<string>();
  const selected = $derived.by(() => {
    void c.rev;
    const id = c.focusId;
    if (!id || !c.showGeneratedArtwork || effectiveRepresentation(c.doc, id) !== 'svg') return;
    const node = c.doc.nodes[id];
    if (!node?.svgArt || node.imageAsset) return;
    return { key: c.doc.id + '/' + id + '/' + node.svgArt.assetHash, hash: node.svgArt.assetHash, label: node.text };
  });

  $effect(() => {
    const target = selected;
    if (!target) open = false;
    if (!open || !target) return;
    const abort = new AbortController();
    failed = undefined;
    void load(target.hash, abort.signal).then(svg => {
      if (!abort.signal.aborted) preview = { key: target.key, svg };
    }).catch(() => {
      if (!abort.signal.aborted) failed = target.key;
    });
    return () => abort.abort();
  });

  async function load(hash: string, signal: AbortSignal): Promise<SVGElement> {
    const response = await fetch(await c.host.assetUrl(hash), { signal });
    if (!response.ok) throw new Error('Could not read SVG.');
    const bytes = await response.blob();
    if (bytes.size > 2_000_000) throw new Error('SVG exceeds inspection size.');
    const svg = sanitizeSvg(await bytes.text());
    const element = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
    if (element.namespaceURI !== 'http://www.w3.org/2000/svg' || element.localName !== 'svg') {
      throw new Error('Invalid SVG.');
    }
    return document.importNode(element as unknown as SVGElement, true);
  }

  function mount(node: HTMLDivElement, svg: SVGElement): void {
    // Isolate local gradient and clip IDs from the rest of the inspector.
    const shadow = node.attachShadow({ mode: 'open' });
    svg.style.width = '100%';
    svg.style.maxHeight = '240px';
    svg.style.display = 'block';
    shadow.replaceChildren(svg);
  }
</script>

{#if selected}
  <details ontoggle={event => open = event.currentTarget.open}>
    <summary>Inspect SVG artwork</summary>
    {#if open && preview?.key === selected.key}
      {#key preview}
        <div class="inspection" role="img" aria-label={selected.label || 'SVG artwork'} use:mount={preview.svg}></div>
      {/key}
    {:else if open}
      <p role="status">{failed === selected.key ? 'The SVG could not be displayed.' : 'Loading SVG…'}</p>
    {/if}
  </details>
{/if}
