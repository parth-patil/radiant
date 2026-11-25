<script lang="ts">
  import type { MapNode, Op } from '../core/types';
  import type { AppController } from './controller.svelte';

  let { c, node }: { c: AppController; node: MapNode | null } = $props();
  let mode = $state<'sticker' | 'text'>('sticker');
  let custom = $state('');
  let open = $state(false);
  const categories = [
    { name: 'Ticks and stars', symbols: [['✓', 'Tick'], ['✅', 'Check mark'], ['⭐', 'Star'], ['★', 'Black star'], ['⚠️', 'Warning']] },
    { name: 'Arrows', symbols: [['↑', 'Up arrow'], ['↓', 'Down arrow'], ['←', 'Left arrow'], ['➡️', 'Right arrow'], ['↔️', 'Left-right arrow']] },
    { name: 'Numbers', symbols: [['①', 'One'], ['②', 'Two'], ['③', 'Three'], ['④', 'Four'], ['⑤', 'Five'], ['⑥', 'Six']] },
    { name: 'Shapes', symbols: [['●', 'Circle'], ['■', 'Square'], ['▲', 'Triangle'], ['◆', 'Diamond'], ['❤️', 'Heart'], ['∞', 'Infinity']] },
    { name: 'Emoji and stickers', symbols: [['💡', 'Light bulb'], ['🎯', 'Target'], ['🌱', 'Seedling'], ['🔖', 'Bookmark'], ['📌', 'Pushpin'],
      ['🔥', 'Fire'], ['💬', 'Speech bubble'], ['🧠', 'Brain'], ['🔍', 'Magnifying glass'], ['📚', 'Books']] }
  ];
  const labels = new Map(categories.flatMap(({ symbols }) => symbols.map(([symbol, name]): [string, string] => [symbol, name])));
  const legend = $derived.by(() => {
    if (!open) return [];
    void c.rev;
    const meanings = new Map(Object.entries(c.doc.markerMeanings ?? {}));
    const counts = new Map<string, number>();
    for (const entry of Object.values(c.doc.nodes)) {
      if (entry.sticker) counts.set(entry.sticker, (counts.get(entry.sticker) ?? 0) + 1);
    }
    return Array.from(counts, ([symbol, count]) => ({
      symbol, count, label: labels.get(symbol) ?? symbol, meaning: meanings.get(symbol) ?? ''
    })).sort((a, b) => a.label.localeCompare(b.label));
  });

  function insert(symbol: string) {
    const value = symbol.trim().slice(0, 64);
    const current = node && c.doc.nodes[node.id];
    if (!value || !current) return;
    if (mode === 'text') {
      c.editor.apply({ source: 'user', label: 'Insert Symbol', ops: [
        { t: 'set', id: current.id, patch: { text: [current.text, value].filter(Boolean).join(' ') } }
      ] });
    } else {
      setMarker(value);
    }
    custom = '';
  }

  function setMarker(marker?: string) {
    const ops: Op[] = [];
    for (const id of c.selIds) {
      const current = c.doc.nodes[id];
      if (current && current.sticker !== marker) ops.push({ t: 'set', id, patch: { sticker: marker } });
    }
    if (ops.length) c.editor.apply({ source: 'user', label: marker ? 'Set Marker' : 'Remove Marker', ops });
  }

  function changeMeaning(symbol: string, input: HTMLInputElement) {
    const meaning = input.value.trim();
    const meanings = new Map(Object.entries(c.doc.markerMeanings ?? {}));
    input.value = meaning;
    if ((meanings.get(symbol) ?? '') === meaning) return;
    if (meaning) meanings.set(symbol, meaning);
    else meanings.delete(symbol);
    c.editor.apply({ source: 'user', label: 'Edit Marker Meaning', ops: [
      { t: 'docMeta', patch: { markerMeanings: meanings.size ? Object.fromEntries(meanings) : undefined } }
    ] });
  }
</script>

<details class="sec" bind:open>
  <summary>Markers, stickers and legend</summary>
  {#if node}
    <label for="symbol-placement">Placement</label>
    <select id="symbol-placement" bind:value={mode}>
      <option value="sticker">Beside the node</option>
      <option value="text">In the label</option>
    </select>
    {#each categories as category (category.name)}
      <fieldset>
        <legend>{category.name}</legend>
        <div class="symbols">
          {#each category.symbols as [symbol, title] (symbol)}
            <button type="button" class="btn bordered" aria-label={title} title={title}
              onclick={() => insert(symbol)}>{symbol}</button>
          {/each}
        </div>
      </fieldset>
    {/each}
    <label for="custom-symbol">Custom symbol</label>
    <div class="custom">
      <input id="custom-symbol" class="field" maxlength="64" bind:value={custom}
        onkeydown={(event) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); insert(custom); } }} />
      <button type="button" class="btn bordered" disabled={!custom.trim()} onclick={() => insert(custom)}>Insert</button>
    </div>
    {#if c.selIds.some((id) => c.doc.nodes[id]?.sticker) || node.sticker}
      <button type="button" class="btn" onclick={() => setMarker()}>Remove marker</button>
    {/if}
  {/if}

  <section aria-label="Map marker legend">
    <h4>Map marker legend</h4>
    {#if legend.length}
      <ul>
        {#each legend as entry (entry.symbol)}
          <li>
            <span>{entry.symbol} · {entry.label} · {entry.count} {entry.count === 1 ? 'node' : 'nodes'}</span>
            <input class="field" aria-label={`Meaning of ${entry.label}`} placeholder="Add a meaning"
              maxlength="120" value={entry.meaning} onchange={(event) => changeMeaning(entry.symbol, event.currentTarget)}
              onkeydown={(event) => { if (event.key === 'Enter' && !event.isComposing) event.currentTarget.blur(); }} />
          </li>
        {/each}
      </ul>
    {:else}
      <p>Markers beside node labels appear here.</p>
    {/if}
  </section>
</details>

<style>
  label, section { margin-top: 8px; }
  fieldset { border: 0; min-width: 0; padding: 0; margin: 8px 0; }
  legend { padding: 0; color: var(--text-dim); font-size: 11px; }
  .symbols { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; margin-top: 4px; }
  .symbols button { padding: 2px; font-size: 16px; }
  .custom { display: flex; gap: 4px; }
  input { width: 100%; min-width: 0; }
  h4 { margin: 0 0 5px; font-size: 12px; }
  ul { display: grid; list-style: none; gap: 8px; padding: 0; margin: 0; }
  li { display: grid; gap: 3px; }
  li span, p { color: var(--text-dim); font-size: 11px; }
</style>
