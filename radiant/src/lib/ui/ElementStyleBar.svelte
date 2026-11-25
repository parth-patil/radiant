<script lang="ts">
  import type { AppController } from './controller.svelte';
  import type { CanvasElement } from '../core/types';
  import { elementBand } from '../core/model';
  import { isLinear } from '../core/geometry/sketch';

  let { c }: { c: AppController } = $props();
  const t = $derived(c.canvasTools);

  /** The selected elements as drawn now, and which controls apply to all of them (CNV-35). */
  const sel = $derived.by(() => {
    void c.rev;
    const els = t.selectedElements;
    const first = els[0] as CanvasElement | undefined;
    const kinds = new Set(els.map((el) => el.kind));
    const shaped = els.some((el) => el.kind === 'rect' || el.kind === 'ellipse' || el.kind === 'diamond' || el.kind === 'frame' || el.kind === 'note');
    const stroked = els.some((el) => el.kind !== 'image' && el.kind !== 'note' && el.kind !== 'frame');
    const texted = els.some((el) => el.kind !== 'image' && el.kind !== 'draw');
    const linear = els.some((el) => isLinear(el.kind) || el.kind === 'draw');
    return { els, first, kinds, shaped, stroked, texted, linear, grouped: els.some((el) => el.groups?.length), locked: els.length > 0 && els.every((el) => el.locked) };
  });

  /** Swatches: the theme's branch colours, so drawings match the map, then neutrals. */
  const swatches = $derived([...new Set([...c.theme.branchColors.slice(0, 6).map((v) => v.toLowerCase()), '#1e1e1e', '#868e96', '#ffffff'])]
    .filter((v) => /^#[0-9a-f]{6}$/.test(v)));
  const fills = $derived(['#fff3bf', '#d3f9d8', '#d0ebff', '#ffe3e3', ...swatches.slice(0, 5)]);

  const val = <K extends keyof CanvasElement>(key: K, fallback: CanvasElement[K]) => (sel.first?.[key] ?? fallback);
  const set = (patch: Partial<CanvasElement>, remember?: Parameters<typeof t.applyStyle>[1]) => t.applyStyle(patch, remember);
</script>

{#if sel.els.length && !c.presenting}
  <div class="style-bar" role="toolbar" aria-label="Element style">
    {#if sel.stroked || sel.texted}
      <div class="group" role="group" aria-label="Stroke colour">
        <span class="label">Stroke</span>
        {#each swatches as color (color)}
          <button type="button" class="swatch" style:background={color} title={'Stroke ' + color} aria-label={'Stroke ' + color}
            aria-pressed={val('stroke', '') === color} onclick={() => set({ stroke: color })}></button>
        {/each}
      </div>
    {/if}
    {#if sel.shaped}
      <div class="group" role="group" aria-label="Fill">
        <span class="label">Fill</span>
        <button type="button" class="swatch none" title="No fill" aria-label="No fill" aria-pressed={!sel.first?.fill}
          onclick={() => set({ fill: undefined })}></button>
        {#each fills as color (color)}
          <button type="button" class="swatch" style:background={color} title={'Fill ' + color} aria-label={'Fill ' + color}
            aria-pressed={val('fill', '') === color} onclick={() => set({ fill: color })}></button>
        {/each}
      </div>
      <div class="group" role="group" aria-label="Fill style">
        <span class="label">Fill style</span>
        {#each [['hachure', 'Hachure'], ['cross-hatch', 'Cross'], ['solid', 'Solid'], ['zigzag', 'Zigzag']] as [id, label] (id)}
          <button type="button" class="chip" aria-pressed={val('fillStyle', 'solid') === id}
            onclick={() => set({ fillStyle: id as CanvasElement['fillStyle'] })}>{label}</button>
        {/each}
      </div>
    {/if}
    {#if sel.stroked}
      <div class="group" role="group" aria-label="Stroke width">
        <span class="label">Width</span>
        {#each [1, 2, 4] as width (width)}
          <button type="button" class="chip" title={'Stroke width ' + width} aria-pressed={val('strokeWidth', 2) === width}
            onclick={() => set({ strokeWidth: width })}><span class="bar" style:height={width + 'px'}></span></button>
        {/each}
      </div>
      <div class="group" role="group" aria-label="Stroke style">
        <span class="label">Line</span>
        {#each ['solid', 'dashed', 'dotted'] as id (id)}
          <button type="button" class="chip" aria-pressed={val('strokeStyle', 'solid') === id}
            onclick={() => set({ strokeStyle: id === 'solid' ? undefined : id as CanvasElement['strokeStyle'] }, { strokeStyle: id as CanvasElement['strokeStyle'] })}>{id}</button>
        {/each}
      </div>
      <div class="group" role="group" aria-label="Sloppiness">
        <span class="label">Sloppiness</span>
        {#each [[0, 'Clean'], [1, 'Sketchy'], [2, 'Loose']] as [id, label] (id)}
          <button type="button" class="chip" aria-pressed={val('roughness', 1) === id}
            onclick={() => set({ roughness: id as 0 | 1 | 2 })}>{label}</button>
        {/each}
      </div>
      {#if sel.els.some((el) => isLinear(el.kind))}
        <div class="group" role="group" aria-label="Route">
          <span class="label">Route</span>
          <button type="button" class="chip" aria-pressed={!sel.first?.elbow} onclick={() => set({ elbow: undefined }, {})}>Straight</button>
          <button type="button" class="chip" aria-pressed={!!sel.first?.elbow} onclick={() => set({ elbow: true }, {})}>Elbow</button>
        </div>
      {/if}
      <div class="group" role="group" aria-label="Corners">
        <span class="label">Corners</span>
        <button type="button" class="chip" aria-pressed={!sel.first?.round} onclick={() => set({ round: undefined }, { round: false })}>Sharp</button>
        <button type="button" class="chip" aria-pressed={!!sel.first?.round} onclick={() => set({ round: true })}>Round</button>
      </div>
    {/if}
    <label class="group opacity" title="Opacity">
      <span>Opacity</span>
      <input type="range" min="10" max="100" step="5" value={Math.round(val('opacity', 1)! * 100)}
        onchange={(e) => { const v = Number(e.currentTarget.value) / 100; set({ opacity: v >= 1 ? undefined : v }, { opacity: v }); }} />
    </label>
    {#if sel.texted}
      <div class="group" role="group" aria-label="Font">
        <span class="label">Text</span>
        {#each [['hand', 'Hand'], ['theme', 'Map'], ['code', 'Code']] as [id, label] (id)}
          <button type="button" class="chip" aria-pressed={val('font', 'theme') === id}
            onclick={() => set({ font: id === 'theme' ? undefined : id as CanvasElement['font'] }, { font: id as CanvasElement['font'] })}>{label}</button>
        {/each}
      </div>
      <div class="group" role="group" aria-label="Font size">
        <span class="label">Size</span>
        {#each [[16, 'S'], [20, 'M'], [28, 'L'], [36, 'XL']] as [size, label] (size)}
          <button type="button" class="chip" aria-pressed={val('fontSize', 20) === size} onclick={() => set({ fontSize: size as number })}>{label}</button>
        {/each}
      </div>
      <div class="group" role="group" aria-label="Alignment">
        <span class="label">Align</span>
        {#each [['left', '⇤'], ['center', '↔'], ['right', '⇥']] as [id, label] (id)}
          <button type="button" class="chip" title={'Align ' + id} aria-pressed={sel.first?.align === id}
            onclick={() => set({ align: id as CanvasElement['align'] }, {})}>{label}</button>
        {/each}
      </div>
    {/if}
    <div class="group" role="group" aria-label="Layer">
        <span class="label">Layer</span>
      <button type="button" class="chip" title="Under the maps" aria-pressed={sel.first ? elementBand(sel.first) === 'back' : false}
        onclick={() => t.setBand('back')}>Under maps</button>
      <button type="button" class="chip" title="Over the maps" aria-pressed={sel.first ? elementBand(sel.first) === 'front' : false}
        onclick={() => t.setBand('front')}>Over maps</button>
      <button type="button" class="chip" title="Send backward — ⌘[" onclick={() => t.reorder('backward')}>↓</button>
      <button type="button" class="chip" title="Bring forward — ⌘]" onclick={() => t.reorder('forward')}>↑</button>
    </div>
    <div class="group" role="group" aria-label="Arrange">
        <span class="label">Arrange</span>
      {#if sel.els.length > 1}<button type="button" class="chip" title="Group — ⌥⌘G" onclick={() => t.group()}>Group</button>{/if}
      {#if sel.grouped}<button type="button" class="chip" title="Ungroup — ⇧⌥⌘G" onclick={() => t.ungroup()}>Ungroup</button>{/if}
      <button type="button" class="chip" aria-pressed={sel.locked} title="Lock — ⇧⌘L" onclick={() => t.toggleLock()}>{sel.locked ? 'Unlock' : 'Lock'}</button>
      <button type="button" class="chip" title="Duplicate — ⌘D" onclick={() => t.duplicate()}>Duplicate</button>
      {#if t.canMakeMap}<button type="button" class="chip" title="Turn the notes into a map" onclick={() => t.makeMap()}>Make a map</button>{/if}
      <button type="button" class="chip danger" title="Delete — ⌫" onclick={() => t.deleteSelection([])}>Delete</button>
    </div>
  </div>
{/if}

<style>
  .style-bar {
    position: absolute;
    z-index: 6;
    left: 50%;
    top: calc(var(--ui-top, 40px) * var(--ui-scale, 1) + 10px);
    transform: translateX(-50%);
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: center;
    gap: 4px 10px;
    max-width: min(980px, calc(100vw - 40px));
    padding: 5px 8px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    font-size: 11px;
  }
  .group { display: flex; align-items: center; gap: 2px; }
  .label { margin-right: 3px; color: var(--text-dim); font-size: 10px; }
  .swatch {
    width: 16px; height: 16px; padding: 0; border: 1px solid var(--line-strong); border-radius: 4px; cursor: pointer;
  }
  .swatch[aria-pressed='true'] { outline: 2px solid var(--accent); outline-offset: 1px; }
  .swatch.none { background: linear-gradient(135deg, transparent 45%, var(--danger) 45% 55%, transparent 55%) !important; }
  .chip {
    min-width: 22px; height: 22px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent;
    color: var(--text); cursor: pointer; font-size: 11px; display: grid; place-items: center;
  }
  .chip:hover { background: var(--hover); }
  .chip[aria-pressed='true'] { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
  .chip.danger { color: var(--danger); }
  .bar { display: block; width: 16px; background: currentColor; border-radius: 2px; }
  .opacity { gap: 6px; color: var(--text-dim); }
  .opacity input { width: 70px; }
</style>
