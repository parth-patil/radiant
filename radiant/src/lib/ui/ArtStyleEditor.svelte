<script lang="ts">
  import { parseColor, rgbToHex } from '../core/art';
  import type { ArtStyleOverrides, MapNode } from '../core/types';
  import type { AppController } from './controller.svelte';
  import { artStyleAt } from './artWorkflow.svelte';

  let { c, node, locked }: { c: AppController; node: MapNode; locked: boolean } = $props();
  const style = $derived.by(() => {
    void c.rev;
    return artStyleAt(c.doc, node.id);
  });
  let paletteError = $state(false);

  const descriptors: Array<[keyof Pick<ArtStyleOverrides, 'medium' | 'mood' | 'detail' | 'lineWeight'>, string]> = [
    ['medium', 'Medium'],
    ['mood', 'Mood'],
    ['detail', 'Level of detail'],
    ['lineWeight', 'Line weight']
  ];

  function set<K extends keyof ArtStyleOverrides>(key: K, value: ArtStyleOverrides[K]) {
    const current = c.doc.nodes[node.id];
    if (!current || locked) return;
    const edits = { ...current.artStyleOverrides };
    if (value === undefined) delete edits[key];
    else edits[key] = value;
    apply(Object.keys(edits).length ? edits : undefined);
  }

  function apply(artStyleOverrides: ArtStyleOverrides | undefined) {
    c.editor.apply({
      source: 'user', label: 'Edit Artwork Style',
      ops: [{ t: 'set', id: node.id, patch: { artStyleOverrides } }]
    });
  }

  function updatePalette(value: string) {
    const colours = value.trim().split(/[,\s]+/).filter(Boolean);
    const parsed = colours.map(parseColor);
    if (colours.length > 12 || parsed.some((colour) => !colour)) {
      paletteError = true;
      return;
    }
    paletteError = false;
    set('palette', colours.length ? [...new Set(parsed.map((colour) => rgbToHex(colour!)))] : undefined);
  }
</script>

<details class="style-editor">
  <summary>Edit artwork style</summary>
  {#each descriptors as [key, label] (key)}
    <label for={'art-style-' + key}>{label}</label>
    <input id={'art-style-' + key} class="field" maxlength="160" disabled={locked}
      value={node.artStyleOverrides?.[key] ?? ''}
      placeholder={key === 'lineWeight' ? style.line.weight : style[key]}
      onchange={(event) => set(key, event.currentTarget.value.trim() || undefined)} />
  {/each}
  <label for="art-style-palette">Custom palette</label>
  <input id="art-style-palette" class="field" maxlength="132" disabled={locked} aria-invalid={paletteError}
    value={node.artStyleOverrides?.palette?.join(', ') ?? ''} placeholder="#d04c1d, #263f5c"
    onchange={(event) => updatePalette(event.currentTarget.value)} />
  {#if paletteError}<p role="alert">Use up to 12 hex colours separated by commas.</p>{/if}
  <label for="art-style-background">Picture background</label>
  <select id="art-style-background" disabled={locked} value={node.artStyleOverrides?.background ?? ''}
    onchange={(event) => {
      const value = event.currentTarget.value;
      set('background', value === 'transparent' || value === 'plain' ? value : undefined);
    }}>
    <option value="">Inherit background</option>
    <option value="transparent">Transparent</option>
    <option value="plain">Plain</option>
  </select>
  <label for="art-style-exclusions">Additional exclusions</label>
  <input id="art-style-exclusions" class="field" maxlength="320" disabled={locked}
    value={node.artStyleOverrides?.negative?.join(', ') ?? ''} placeholder="Scenery, shadows"
    onchange={(event) => {
      const terms = event.currentTarget.value.split(',').map((term) => term.trim()).filter(Boolean);
      set('negative', terms.length ? terms : undefined);
    }} />
  <label for="art-style-seed">SVG style seed</label>
  <input id="art-style-seed" class="field" type="number" step="1" disabled={locked}
    value={node.artStyleOverrides?.seed ?? ''} placeholder={String(style.seed)}
    onchange={(event) => {
      const seed = event.currentTarget.valueAsNumber;
      if (event.currentTarget.value === '' || Number.isSafeInteger(seed)) set('seed', Number.isSafeInteger(seed) ? seed : undefined);
    }} />
  {#if node.artStyleOverrides}
    <button class="btn" disabled={locked} onclick={() => { paletteError = false; apply(undefined); }}>Reset style edits</button>
  {/if}
</details>

<style>
  label { display: block; margin: 6px 0 3px; }
  input, select { box-sizing: border-box; width: 100%; }
  button { margin-top: 6px; }
  p { margin: 3px 0; }
</style>
