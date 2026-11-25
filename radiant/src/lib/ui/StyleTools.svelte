<script lang="ts">
  import { effectiveRepresentation } from '../core/art';
  import { createStyleResolver } from '../core/geometry';
  import { THEME_FONT_FAMILIES } from '../core/model/theme-settings';
  import type { MapNode, NodeStyle } from '../core/types';
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();
  let open = $state(false);
  let reportOpen = $state(false);
  let hints = $state(true);
  let dismissed = $state<string[]>([]);
  let colours = $state<number | null>(null);
  const node = $derived.by(() => {
    void c.rev;
    const n = c.focusId ? c.doc.nodes[c.focusId] : undefined;
    return n ? { ...n } : null;
  });
  const firstRoot = $derived.by(() => {
    void c.rev;
    const root = c.doc.nodes[c.doc.roots[0]];
    return root ? { ...root } : null;
  });
  const docId = $derived.by(() => { void c.rev; return c.doc.id; });
  const paletteSource = $derived(firstRoot && visibleAsset(firstRoot));
  const keyCount = $derived.by(() => {
    void c.rev;
    if (!open) return 0;
    return Object.values(c.doc.nodes).filter((n) => n.style?.emphasis === 2).length;
  });

  function visibleAsset(n: MapNode): string | undefined {
    if (c.theme.lean) return;
    if (n.imageAsset) return n.imageAsset;
    if (!c.showGeneratedArtwork) return;
    const mode = effectiveRepresentation(c.doc, n.id);
    return mode === 'picture' ? n.pictureArt?.thumbnailHash ?? n.pictureArt?.assetHash :
      mode === 'svg' ? n.svgArt?.assetHash : undefined;
  }
  function readPrefs() {
    try {
      const data = JSON.parse(localStorage.getItem('radiant.styleHints.' + docId) ?? '{}');
      hints = data.hints !== false;
      dismissed = Array.isArray(data.dismissed) ? data.dismissed.filter((key: unknown) => typeof key === 'string') : [];
    } catch { hints = true; dismissed = []; }
  }
  function savePrefs() {
    try {
      localStorage.setItem('radiant.styleHints.' + docId, JSON.stringify({ hints, dismissed }));
    } catch { /* preference unavailable */ }
  }
  $effect(() => { void docId; readPrefs(); });
  $effect(() => {
    const hash = paletteSource;
    colours = null;
    if (!hash || !c.theme.centralPalette || !open || !hints) return;
    let active = true;
    void (async () => {
      const response = await fetch(await c.host.assetUrl(hash));
      if (!response.ok) return;
      const source = URL.createObjectURL(await response.blob());
      try {
        const im = new Image();
        im.src = source;
        await im.decode();
        if (!active) return;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(im, 0, 0, 32, 32);
        const pixels = ctx.getImageData(0, 0, 32, 32).data;
        const bins = new Map<number, number>();
        let visible = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 128) continue;
          visible++;
          const key = ((pixels[i] >> 6) << 4) | ((pixels[i + 1] >> 6) << 2) | (pixels[i + 2] >> 6);
          bins.set(key, (bins.get(key) ?? 0) + 1);
        }
        colours = [...bins.values()].filter((count) => count >= Math.max(2, visible * 0.07)).length;
      } finally { URL.revokeObjectURL(source); }
    })().catch(() => {});
    return () => { active = false; };
  });
  const overlap = $derived.by(() => {
    void c.layoutTick;
    if (!open || (!hints && !reportOpen) || !c.pipeline || c.pipeline.layout.boxes.size > 1700) return false;
    for (const box of c.pipeline.layout.boxes.values()) {
      const nearby = c.pipeline.spatial.query({ x: box.x - box.w / 2, y: box.y - box.h / 2, w: box.w, h: box.h });
      if (nearby.some((id) => {
        const other = c.pipeline.layout.boxes.get(id);
        return other && other.id !== box.id && Math.abs(box.x - other.x) < (box.w + other.w) / 2 - .01 &&
          Math.abs(box.y - other.y) < (box.h + other.h) / 2 - .01;
      })) return true;
    }
    return false;
  });
  const issues = $derived.by(() => {
    void c.rev;
    if (!open || !hints) return [];
    const result: Array<{ key: string; message: string }> = [];
    const theme = c.theme;
    if (theme.centralImage && firstRoot && !paletteSource) result.push({ key: 'centre-image', message: 'Consider a central image.' });
    if (theme.centralPalette && colours !== null && colours < 3) result.push({ key: 'centre-colours', message: 'The central image appears to use fewer than three colours.' });
    if (theme.singleCenter && c.doc.roots.length > 1) result.push({ key: 'extra-roots', message: 'The strict preset suggests keeping one centre.' });
    if (overlap) result.push({ key: 'overlap', message: 'Some nodes overlap.' });
    if (c.doc.themeId === 'buzan' && Object.values(c.doc.nodes).some((node) =>
      node.parent && (node.style?.curvedLabel ?? theme.curvedLabels))) {
      result.push({ key: 'curve-text', message: 'The strict preset keeps labels horizontal.' });
    }
    for (const n of Object.values(c.doc.nodes)) {
      if (n.parent && theme.keywordHints && n.text.trim().split(/\s+/).length > 1) {
        result.push({ key: 'keyword:' + n.id + ':' + n.text, message: `Consider one keyword for “${n.text}”.` });
      }
      if (n.children.length >= 2 && n.children.filter((id) => c.doc.nodes[id].style?.emphasis === 2).length > n.children.length / 2) {
        result.push({ key: 'emphasis:' + n.id, message: `Most branches under “${n.text}” are marked as key nodes. Consider keeping only the most important ones marked.` });
      }
      if (result.length >= 60) break;
    }
    return result.filter((issue) => !dismissed.includes(issue.key));
  });
  const report = $derived.by(() => {
    void c.rev; void c.layoutTick;
    if (!open || !reportOpen || !firstRoot) return [];
    const theme = c.theme;
    const nodes = Object.values(c.doc.nodes);
    const roots = c.doc.roots;
    const resolve = createStyleResolver(c.doc, theme);
    const branchColours = new Set<string>();
    let inheritedColours = true;
    let organic = true;
    let branchCount = 0;
    for (const root of roots) {
      for (const [index, id] of c.doc.nodes[root].children.entries()) {
        const mainColour = resolve.get(id, 1, index).color.toLowerCase();
        if (branchColours.has(mainColour)) inheritedColours = false;
        branchColours.add(mainColour);
        const pending = [{ id, depth: 1 }];
        while (pending.length) {
          const item = pending.pop()!;
          const style = resolve.get(item.id, item.depth, index);
          if (style.color.toLowerCase() !== mainColour) inheritedColours = false;
          if (style.branch !== 'organic') organic = false;
          branchCount++;
          for (const child of c.doc.nodes[item.id].children) pending.push({ id: child, depth: item.depth + 1 });
        }
      }
    }
    const boxes = c.pipeline?.layout.boxes;
    const centre = boxes?.get(firstRoot.id);
    let radiating: boolean | null = false;
    if (roots.length === 1 && firstRoot.children.length >= 2) {
      const angles = firstRoot.children.flatMap((id) => {
        const box = boxes?.get(id);
        return centre && box ? [Math.atan2(box.y - centre.y, box.x - centre.x)] : [];
      }).sort((a, b) => a - b);
      // A tree that fits entirely within a right angle reads as one-sided.
      radiating = angles.length !== firstRoot.children.length ? null :
        angles.every((a, i) => (angles[i + 1] ?? angles[0] + 2 * Math.PI) - a < 1.5 * Math.PI);
    }
    const observations: [string, boolean | null][] = [
      ['One clear central concept', roots.length === 1 && !!firstRoot.text.trim()],
      ['A central image', !!paletteSource],
      ['Branches radiate from the centre', radiating],
      ['One word per branch', nodes.every((n) => !n.parent || /^\S+$/.test(n.text.trim()))],
      ['Images or symbols', nodes.some((n) => n.sticker || visibleAsset(n))],
      ['Distinct colours throughout', branchColours.size > 1 && inheritedColours],
      ['No visible overlaps', c.pipeline?.layout.boxes.size > 1700 ? null : !overlap],
      ['Organic branch shapes', branchCount > 0 && organic],
      ['Visual appeal', null]
    ];
    return observations;
  });
  function color(key: 'textColor' | 'fillColor' | 'color', value: string | undefined) {
    c.styleSelection({ [key]: value });
  }
</script>

<details bind:open class="style-tools">
  <summary>Typography and Buzan check</summary>
  {#if node}
    <div class="sec">
      <label for="node-font-family">Font family</label>
      <select id="node-font-family" value={node.style?.fontFamily ?? ''}
        onchange={(event) => c.styleSelection({ fontFamily: event.currentTarget.value || undefined })}>
        <option value="">Theme font</option>
        {#each THEME_FONT_FAMILIES as family (family)}<option value={family}>{family.split(',')[0].replaceAll('"', '')}</option>{/each}
      </select>
      <label for="node-font-size">Text size</label>
      <input id="node-font-size" type="number" min="8" max="96" placeholder="Theme" value={node.style?.fontSize ?? ''}
        onchange={(event) => c.styleSelection({ fontSize: event.currentTarget.value ? Math.max(8, Math.min(96, event.currentTarget.valueAsNumber)) : undefined })} />
      <label for="node-text-alignment">Alignment</label>
      <select id="node-text-alignment" value={node.style?.alignment ?? ''}
        onchange={(event) => c.styleSelection({ alignment: (event.currentTarget.value || undefined) as NodeStyle['alignment'] })}>
        <option value="">Theme alignment</option><option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option>
      </select>
      <div class="colours">
        <label>Text colour<input type="color" value={node.style?.textColor ?? c.theme.textColor} onchange={(event) => color('textColor', event.currentTarget.value)} /></label>
        <button class="btn" disabled={!node.style?.textColor} onclick={() => color('textColor', undefined)}>Reset text colour</button>
        <label>Node fill<input type="color" value={node.style?.fillColor ?? '#ffffff'} onchange={(event) => color('fillColor', event.currentTarget.value)} /></label>
        <button class="btn" disabled={!node.style?.fillColor} onclick={() => color('fillColor', undefined)}>Reset fill</button>
        <label>Custom branch colour<input type="color" value={node.style?.color ?? c.theme.rootColor}
          onchange={(event) => color('color', event.currentTarget.value)} /></label>
      </div>
      <label for="node-branch-width">Branch tip width</label>
      <input id="node-branch-width" type="number" min="1" max="64" step="0.25" placeholder="Theme" value={node.style?.branchWidth ?? ''}
        onchange={(event) => c.styleSelection({ branchWidth: event.currentTarget.value ? Math.max(1, Math.min(64, event.currentTarget.valueAsNumber)) : undefined })} />
      <label><input type="checkbox" checked={node.style?.curvedLabel ?? c.theme.curvedLabels ?? false}
        onchange={(event) => c.styleSelection({ curvedLabel: event.currentTarget.checked })} /> Follow branch curve</label>
      <label><input type="checkbox" checked={node.style?.bold ?? (node.parent === null || c.doc.nodes[node.parent]?.parent === null || !!node.style?.emphasis)}
        onchange={(event) => c.styleSelection({ bold: event.currentTarget.checked })} /> Bold</label>
      <label><input type="checkbox" checked={node.style?.italic ?? false}
        onchange={(event) => c.styleSelection({ italic: event.currentTarget.checked })} /> Italic</label>
      <label><input type="checkbox" checked={node.style?.extrudedLabel ?? false}
        onchange={(event) => c.styleSelection({ extrudedLabel: event.currentTarget.checked || undefined })} /> Three-dimensional text</label>
      <label><input type="checkbox" checked={node.style?.branchBoundary ?? false}
        onchange={(event) => c.styleSelection({ branchBoundary: event.currentTarget.checked || undefined })} /> Branch boundary</label>
      <small>Add the boundary once the branch is mostly complete.</small>
      <button class="btn bordered" title="⌥⌘C" onclick={() => c.copySelectedStyle()}>Copy style</button>
      <button class="btn bordered" title="⌥⌘V" disabled={!c.copiedStyle} onclick={() => c.pasteSelectedStyle()}>Paste style</button>
    </div>
  {/if}
  <label><input type="checkbox" checked={hints} onchange={(event) => { hints = event.currentTarget.checked; savePrefs(); }} /> Show style hints</label>
  {#if keyCount}<p>{keyCount} {keyCount === 1 ? 'key node' : 'key nodes'}</p>{/if}
  {#if hints}
    {#each issues.slice(0, 40) as issue (issue.key)}
      <div class="issue"><span>{issue.message}</span><button class="btn" aria-label={'Dismiss ' + issue.message}
        onclick={() => { dismissed = [...dismissed, issue.key]; savePrefs(); }}>×</button></div>
    {/each}
  {/if}
  <details bind:open={reportOpen}>
    <summary>Buzan checklist</summary>
    <p>Based on Tony Buzan’s <cite>Mind Map Mastery</cite> (2018), Chapter 3.</p>
    <dl>
      {#each report as [criterion, value] (criterion)}
        <div><dt>{criterion}</dt><dd>{value === null ? criterion === 'Visual appeal' ? 'Your judgement' : 'Not measured' : value ? 'Yes' : 'No'}</dd></div>
      {/each}
    </dl>
  </details>
</details>

<style>
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  .sec > input { width: 100%; box-sizing: border-box; margin-bottom: 4px; }
  .colours { display: grid; grid-template-columns: 1fr auto; align-items: center; margin: 7px 0; gap: 4px; }
  .colours label { display: block; font-size: 12px; }
  .colours label input { margin-left: 4px; }
  .issue, dl > div { display: flex; align-items: center; justify-content: space-between; gap: 5px; font-size: 12px; }
  .issue span { overflow-wrap: anywhere; }
  p, dl { color: var(--text-dim); font-size: 11px; }
  dd { margin-left: 4px; }
</style>
