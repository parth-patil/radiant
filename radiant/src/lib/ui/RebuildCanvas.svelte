<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { addChild, addSibling, cloneDoc, createDoc, Editor, moveSubtree, newId, setText, subtreeIds } from '../core/model';
  import { premulCss } from '../core/geometry';
  import { layoutDoc } from '../core/layout';
  import { compareAttempt, type AttemptNode, type ComparisonStatus } from '../core/review/rebuild';
  import type { ReviewNode } from '../core/review';
  import type { Doc, NodeBox, Theme } from '../core/types';
  import { measureLabel } from '../render/text';
  import { renderExport } from './export-visual';
  import { Pipeline, type ImageInfo } from './pipeline';

  let { expected, source, theme, images, onfinish }: {
    expected: readonly ReviewNode[];
    source: Doc;
    theme: Theme;
    images: ReadonlyMap<string, ImageInfo>;
    onfinish: () => void;
  } = $props();

  interface Card {
    id: string;
    parent: string | null;
    label: string;
    box: NodeBox;
    status?: ComparisonStatus;
    attemptedParent?: string;
  }

  const legend: Record<ComparisonStatus, string> = {
    matched: 'Matched', missing: 'Missing', extra: 'Extra', misplaced: 'Misplaced'
  };
  const empty = createDoc('Memory attempt');
  empty.roots = [];
  empty.rootInfo = {};
  empty.nodes = {};
  const editor = new Editor(empty);
  let revision = $state(0);
  let focus = $state<string | null>(null);
  let editing = $state<string | null>(null);
  let draft = $state('');
  let input = $state<HTMLInputElement>();
  let viewport: HTMLDivElement;
  let dragged: string | null = null;
  let zoom = $state(1);
  let savedImage = $state<string>();
  let result = $state.raw<{ cards: Card[]; misplaced: Array<{ from: string; to: string }> } | null>(null);
  const doc = $derived.by(() => { void revision; return editor.doc; });
  const attempt = $derived.by(() => {
    void revision;
    return Object.values(doc.nodes).map((node): AttemptNode => ({ id: node.id, parent: node.parent, label: node.text }));
  });
  const hasAnswer = $derived(attempt.some((node) => node.label.trim()) || !!draft.trim());
  const canUndo = $derived.by(() => { void revision; return editor.canUndo; });
  const canRedo = $derived.by(() => { void revision; return editor.canRedo; });
  const cards = $derived.by(() => {
    if (result) return result.cards;
    const sizes = new Map(attempt.map((node) => [
      node.id, { w: Math.max(116, Math.min(220, (node.label || '').length * 8 + 28)), h: 42 },
    ]));
    const { boxes } = layoutDoc(doc, sizes, { levelGap: 58, siblingGap: 26 });
    return attempt.map((node): Card => ({ ...node, box: boxes.get(node.id)! }));
  });
  const byId = $derived(new Map(cards.map((card) => [card.id, card])));
  const bounds = $derived.by(() => {
    if (!cards.length) return { x: 0, y: 0, w: 580, h: 370 };
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const { box } of cards) {
      left = Math.min(left, box.x - box.w / 2);
      top = Math.min(top, box.y - box.h / 2);
      right = Math.max(right, box.x + box.w / 2);
      bottom = Math.max(bottom, box.y + box.h / 2);
    }
    return { x: left - 48, y: top - 48, w: Math.max(580, right - left + 96), h: Math.max(370, bottom - top + 96) };
  });

  onMount(() => editor.subscribe(() => { revision++; }));
  onDestroy(() => { result = null; clearSavedImage(); });

  function clearSavedImage() {
    if (savedImage) URL.revokeObjectURL(savedImage);
    savedImage = undefined;
  }


  function commit() {
    if (!editing) return;
    const id = editing;
    editing = null;
    const edit = setText(doc, id, draft.trim());
    draft = '';
    if (edit) editor.apply(edit.tx);
  }

  async function edit(id: string) {
    commit();
    focus = id;
    editing = id;
    draft = doc.nodes[id].text;
    await tick();
    input?.focus();
    input?.select();
  }

  async function create(kind: 'root' | 'child' | 'sibling') {
    commit();
    if (kind === 'root' || !focus || (kind === 'sibling' && doc.nodes[focus].parent === null)) {
      const id = newId();
      const lowest = cards.reduce((bottom, { box }) => Math.max(bottom, box.y + box.h / 2), -82);
      editor.apply({ label: 'Add Main Topic', source: 'user', ops: [{
        t: 'insert', parent: null, index: doc.roots.length, node: { id, parent: null, children: [], text: '' },
        rootInfo: { layout: 'right', position: { x: 0, y: lowest + 82 } }
      }] });
      await edit(id);
      return;
    }
    const next = kind === 'child' ? addChild(doc, focus) : addSibling(doc, focus);
    if (next?.focus) {
      editor.apply(next.tx);
      await edit(next.focus);
    }
  }

  function remove() {
    if (!focus) return;
    commit();
    const parent = doc.nodes[focus].parent;
    const ops = subtreeIds(doc, focus).toReversed().map((id) => ({ t: 'remove' as const, id }));
    editor.apply({ label: 'Delete Practice Branch', source: 'user', ops });
    focus = parent ?? doc.roots[0] ?? null;
  }

  function replay(redo = false) {
    commit();
    if (redo) editor.redo();
    else editor.undo();
    if (focus && !doc.nodes[focus]) focus = doc.roots[0] ?? null;
  }

  function onKey(event: KeyboardEvent) {
    if (event.isComposing || result) return;
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'z' && !editing) {
      event.preventDefault();
      replay(event.shiftKey);
    } else if (key === 'Tab' && editing && !event.shiftKey) {
      event.preventDefault();
      void create('child');
    } else if (key === 'Enter' && editing) {
      event.preventDefault();
      void create('sibling');
    } else if (key === 'F2' && focus && !editing) {
      event.preventDefault();
      void edit(focus);
    } else if ((key === 'Delete' || key === 'Backspace') && focus && !editing) {
      event.preventDefault();
      remove();
    } else if (key === 'Escape' && editing) {
      event.preventDefault();
      event.stopPropagation();
      editing = null;
      draft = '';
      viewport.focus();
    }
  }

  function reparent(event: DragEvent, target: string) {
    event.preventDefault();
    if (!dragged || dragged === target) return;
    const moved = moveSubtree(doc, dragged, target, doc.nodes[target].children.length);
    if (!moved) return;
    commit();
    editor.apply(moved.tx);
    focus = dragged;
    dragged = null;
  }

  function compare() {
    commit();
    const answered = new Set(attempt.filter((node) => !!node.label.trim()).map((node) => node.id));
    const guess = attempt.filter((node) => answered.has(node.id)).map((node) => {
      let parent = node.parent;
      while (parent && !answered.has(parent)) parent = doc.nodes[parent].parent;
      return { ...node, parent };
    });
    clearSavedImage();
    const saved = cloneDoc(source);
    for (const node of Object.values(saved.nodes)) node.collapsed = false;
    for (const row of expected) if (!saved.nodes[row.id].text) saved.nodes[row.id].text = row.label;
    const pipeline = new Pipeline(measureLabel);
    for (const [hash, info] of images) pipeline.imageInfo.set(hash, info);
    pipeline.relayout(saved, theme);
    const compared = compareAttempt(expected, guess);
    const original = compared.filter((item) => item.status !== 'extra');
    const originalBoxes = original.map((item) => pipeline.layout.boxes.get(item.id.slice(6))!);
    const right = originalBoxes.reduce((edge, box) => Math.max(edge, box.x + box.w / 2), -Infinity);
    const top = originalBoxes.reduce((edge, box) => Math.min(edge, box.y - box.h / 2), Infinity);
    let extra = 0;
    const output = compared.map((item): Card => {
      const box = item.status === 'extra'
        ? { id: item.id, x: right + 170, y: top + 25 + 65 * extra++, w: 180, h: 42, depth: 0, side: 0, flow: 'h', mainBranch: -1 } satisfies NodeBox
        : pipeline.layout.boxes.get(item.id.slice(6))!;
      return { ...item, box };
    });
    const mapped = new Map(compared.filter((item) => item.attemptId).map((item) => [item.attemptId, item.id]));
    const misplaced = compared.flatMap((item) => {
      const from = mapped.get(item.attemptedParentId);
      return from ? [{ from, to: item.id }] : [];
    });
    const comparison = { cards: output, misplaced };
    result = comparison;
    zoom = 1;
    void tick().then(fit);
    const included = new Set(expected.map(({ id }) => id));
    pipeline.layout = { ...pipeline.layout, boxes: new Map([...pipeline.layout.boxes].filter(([id]) => included.has(id))) };
    const scene = pipeline.fullScene({ selection: new Set(), focus: null, hover: null, editing: null });
    void renderExport('svg', {
      scene, branches: pipeline.branchSpecs(), boxes: pipeline.layout.boxes, links: saved.links,
      linkColor: premulCss(theme.connectionColor ?? theme.textColor), viewport: bounds, scale: 1,
      transparent: false, tiles: false,
    }).then(async (bytes) => {
      if (result !== comparison) return;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
      const image = new Image();
      image.src = url;
      try {
        await image.decode();
        if (result === comparison) {
          savedImage = url;
          return;
        }
      } catch {
        // Keep the clean fallback graph if the SVG cannot be decoded.
      }
      URL.revokeObjectURL(url);
    }).catch(() => {
      // The comparison cards remain available if an artwork asset cannot be rendered.
    });
  }

  function fit() {
    if (!viewport) return;
    zoom = Math.min(1, Math.max(0.25, (viewport.clientWidth - 8) / bounds.w));
    viewport.scrollTo(0, 0);
  }

  const cardWidth = (card: Card) => Math.max(82, card.box.w);
</script>

<p>{result ? 'Your attempt overlaid on the saved map.' : 'Build the map from memory. Tab adds a child and Return adds a sibling while editing. Drag one topic onto another to reparent it.'}</p>
<div class="toolbar">
  {#if result}
    <button class="btn bordered" type="button" onclick={() => { result = null; clearSavedImage(); zoom = 1; }}>Edit attempt</button>
    <button class="btn bordered primary" type="button" onclick={onfinish}>Back to practice</button>
  {:else}
    <button class="btn bordered" type="button" onclick={() => void create('root')}>Add main topic</button>
    <button class="btn bordered" type="button" disabled={!focus} onclick={() => void create('child')}>Add child</button>
    <button class="btn bordered" type="button" disabled={!focus} onclick={remove}>Delete branch</button>
    <button class="btn bordered" type="button" disabled={!canUndo} onclick={() => replay()}>Undo</button>
    <button class="btn bordered" type="button" disabled={!canRedo} onclick={() => replay(true)}>Redo</button>
    <button class="btn bordered primary" type="button" disabled={!hasAnswer} onclick={compare}>Compare with saved map</button>
  {/if}
  <button class="btn bordered" type="button" aria-label="Zoom out" onclick={() => zoom = Math.max(0.25, zoom / 1.25)}>−</button>
  <button class="btn bordered" type="button" aria-label="Zoom in" onclick={() => zoom = Math.min(2, zoom * 1.25)}>+</button>
  <button class="btn bordered" type="button" onclick={fit}>Fit width</button>
</div>
{#if result}
  <ul class="legend" aria-label="Comparison results">
    {#each Object.entries(legend) as [status, title] (status)}
      <li data-status={status}>{title} {result.cards.filter((card) => card.status === status).length}</li>
    {/each}
  </ul>
{/if}
<!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling for the canvas) -->
<div class="viewport" bind:this={viewport} role="region" aria-label={result ? 'Comparison overlay on saved map' : 'Editable memory map canvas'}
  tabindex="0">
  {#if !cards.length}
    <p class="empty">Add a main topic to begin.</p>
  {:else}
    <div class="scaled" style:width={bounds.w * zoom + 'px'} style:height={bounds.h * zoom + 'px'}>
      <div class="world" style:width={bounds.w + 'px'} style:height={bounds.h + 'px'} style:transform={`scale(${zoom})`}>
        {#if savedImage}<img class="saved-map" aria-hidden="true" alt="" src={savedImage} />{/if}
        <svg viewBox={`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`} aria-hidden="true">
          {#each cards as card (card.id)}
            {@const parent = card.parent && byId.get(card.parent)}
            {#if parent && (!savedImage || card.status === 'extra')}
              <path class:extra={card.status === 'extra'} d={`M ${parent.box.x} ${parent.box.y} L ${card.box.x} ${card.box.y}`} />
            {/if}
          {/each}
          {#each result?.misplaced ?? [] as edge (edge.to)}
            {@const from = byId.get(edge.from)!.box}
            {@const to = byId.get(edge.to)!.box}
            <path class="misplaced" d={`M ${from.x} ${from.y} L ${to.x} ${to.y}`} />
          {/each}
        </svg>
        {#each cards as card (card.id)}
          <div class="card" class:focused={!result && focus === card.id}
            class:overlaid={!!savedImage && card.status !== 'extra'} data-status={card.status} data-node={card.id}
            style:left={card.box.x - bounds.x + 'px'} style:top={card.box.y - bounds.y + 'px'} style:width={cardWidth(card) + 'px'} style:min-height={savedImage && card.status !== 'extra' ? card.box.h + 'px' : undefined}>
            {#if result && card.status}
              <strong>{card.label || 'Untitled'}</strong>
              <small>{legend[card.status]}{card.attemptedParent ? ' · placed under ' + card.attemptedParent : ''}</small>
            {:else if editing === card.id}
              <input aria-label="Practice node label" bind:this={input} bind:value={draft} maxlength={500} onkeydown={onKey} onblur={() => { if (editing === card.id) commit(); }} />
            {:else}
              <button type="button" class="node-label" aria-pressed={focus === card.id} title={card.label || 'Untitled'}
                draggable="true" ondragstart={(event) => { dragged = card.id; event.dataTransfer?.setData('text/plain', card.id); }}
                ondragend={() => dragged = null} ondragover={(event) => { if (dragged) event.preventDefault(); }}
                ondrop={(event) => reparent(event, card.id)} onfocus={() => focus = card.id} onkeydown={onKey} onclick={() => focus = card.id} ondblclick={() => void edit(card.id)}>
                {card.label || 'Untitled'}
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  p { margin: 10px 0; }
  .toolbar, .legend { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .legend { list-style: none; padding: 0; }
  .legend li { border-left: 3px solid var(--outcome); padding-left: 6px; }
  .viewport { width: 100%; height: min(62vh, 690px); min-height: 260px; overflow: auto; position: relative; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--bg); }
  .empty { padding: 22px; color: var(--text-dim); }
  .scaled { overflow: hidden; }
  .world { position: relative; transform-origin: left top; }
  svg, .saved-map { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  path { fill: none; stroke: var(--line-strong); stroke-width: 2; }
  path.extra, path.misplaced { stroke-dasharray: 7 4; }
  path.extra { stroke: var(--accent); }
  path.misplaced { stroke: var(--warn); }
  .card { --outcome: var(--line-strong); position: absolute; box-sizing: border-box; transform: translate(-50%, -50%); display: grid; text-align: center; background: var(--panel-solid); border: 2px solid var(--outcome); border-radius: 9px; }
  .card.overlaid { background: transparent; }
  .card.overlaid strong { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
  .card.overlaid small { position: absolute; top: 100%; left: 0; background: var(--panel-solid); border-bottom: 2px solid var(--outcome); }
  .card.focused { --outcome: var(--accent); }
  [data-status="matched"] { --outcome: var(--ok); }
  [data-status="missing"] { --outcome: var(--danger); }
  [data-status="extra"] { --outcome: var(--accent); }
  [data-status="misplaced"] { --outcome: var(--warn); }
  [data-status] > strong, [data-status] > small { overflow-wrap: anywhere; padding: 2px 5px; }
  .node-label, input { width: 100%; min-height: 38px; padding: 4px 8px; box-sizing: border-box; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; }
  .node-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: grab; }
</style>
