<script lang="ts">
  import { onMount } from 'svelte';
  import { getTheme } from '../core/model';
  import { createStyleResolver, mixColor } from '../core/geometry';
  import type { CanvasSurface, ShadowSpec } from '../core/types';
  import type { AppController } from './controller.svelte';
  import { parseThemeSettings, THEME_BRANCH_MATERIALS, THEME_BRANCHES, THEME_FONT_FAMILIES, THEME_SHAPES, type ThemeSettings } from '../core/model/theme-settings';
  import { shapeName, branchName, branchMaterialName } from './style-labels';
  import { getSetting, setSetting } from './settings';

  let { c }: { c: AppController } = $props();
  type Profile = { version: 1; name: string; base: string; settings?: ThemeSettings };
  let profiles = $state<Profile[]>([]);
  let name = $state('');
  let title = $state('');
  let status = $state('');
  let extractNode = $state(false);
  let picker = $state<HTMLInputElement>();
  const focused = $derived.by(() => {
    void c.rev;
    return c.focusId ? c.doc.nodes[c.focusId] : undefined;
  });

  const colors: Array<['background' | 'textColor' | 'rootColor' | 'rootFillColor' | 'nodeFillColor' | 'connectionColor', string]> = [
    ['background', 'Canvas colour'], ['textColor', 'Text colour'], ['rootColor', 'Central node colour'],
    ['connectionColor', 'Connection colour'], ['rootFillColor', 'Central fill'], ['nodeFillColor', 'Child fill']
  ];
  const sizes: Array<['rootFontSize' | 'mainFontSize' | 'fontSize', string]> = [
    ['rootFontSize', 'Central text size'], ['mainFontSize', 'Main branch text size'], ['fontSize', 'Child text size']
  ];
  const shapes: Array<['rootShape' | 'mainShape' | 'shape', string]> = [
    ['rootShape', 'Central node shape'], ['mainShape', 'Main branch shape'], ['shape', 'Child shape']
  ];
  const rules: Array<[keyof Pick<ThemeSettings, 'keywordHints' | 'uppercaseMainBranches' | 'colorMainBranches' |
    'centralImage' | 'centralPalette' | 'singleCenter' | 'landscapePrint' | 'fitBranchToLabel'>, string, string]> = [
    ['keywordHints', 'Suggest one keyword per branch', 'No supporting evidence was found for requiring one word.'],
    ['uppercaseMainBranches', 'Uppercase main branches', 'Capitalization is a style preference.'],
    ['colorMainBranches', 'Distinct colours for main branches', 'Colour can provide recall cues.'],
    ['centralImage', 'Replace the central box with an image', 'Meaningful images can support recall.'],
    ['centralPalette', 'Suggest three colours in the centre', 'Three colours is Buzan’s preference.'],
    ['fitBranchToLabel', 'Match underline length to label', 'Buzan recommended matching the branch to the word. Turning this off gives short labels a wider underline.'],
    ['singleCenter', 'Suggest a single centre', 'A single centre is Buzan’s convention.'],
    ['landscapePrint', 'Default to landscape PDF pages', 'Landscape gives radiating branches more horizontal space.']
  ];

  function parseProfile(value: unknown): Profile | undefined {
    if (!value || typeof value !== 'object') return;
    const p = value as Record<string, unknown>;
    if (p.version !== undefined && p.version !== 1) return;
    if (typeof p.name !== 'string' || !p.name.trim() || typeof p.base !== 'string') return;
    return { version: 1, name: p.name.trim().slice(0, 80), base: getTheme(p.base).id, settings: parseThemeSettings(p.settings) };
  }
  onMount(() => {
    try {
      const saved = JSON.parse(getSetting('radiant.themes') ?? '[]');
      if (Array.isArray(saved)) profiles = saved.map(parseProfile).filter((p): p is Profile => !!p);
    } catch { /* no saved profiles */ }
  });

  function change(patch: ThemeSettings) {
    const doc = c.doc;
    if (c.editor.defer(() => { if (c.doc === doc) change(patch); })) return;
    c.editor.apply({ label: 'Customize Theme', source: 'user',
      ops: [{ t: 'docMeta', patch: { themeSettings: parseThemeSettings({ ...c.doc.themeSettings, ...patch }) } }] });
  }
  function currentProfile(): Profile {
    const node = focused;
    const style = extractNode && node ? node.style : undefined;
    const settings = { ...c.doc.themeSettings };
    if (extractNode && node) {
      const theme = c.theme;
      const resolver = createStyleResolver(c.doc, theme);
      const local = resolver.themeFor(node.id);
      // Preserve inherited generation settings while allowing the base preset to follow system appearance.
      for (const key of ['fontFamily', 'branch', 'shape', 'mainShape', 'uppercaseMainBranches', 'branchColors'] as const) {
        if (local[key] !== theme[key]) Object.assign(settings, { [key]: local[key] });
      }
      let depth = 0;
      for (let parent = node.parent; parent; parent = c.doc.nodes[parent]?.parent ?? null) depth++;
      const resolved = resolver.get(node.id, depth);
      if (depth || style?.color) settings.rootColor = resolved.color;
      if (depth || style?.fontSize) settings.rootFontSize = resolved.font.size;
      if (style?.branch || resolved.branch !== theme.branch) settings.branch = resolved.branch;
    }
    if (style?.fillColor) settings.rootFillColor = style.fillColor;
    if (style?.branchWidth) settings.rootBranchWidth = style.branchWidth;
    if (style?.shape) settings.rootShape = style.shape;
    if (style?.fontFamily) settings.fontFamily = style.fontFamily;
    if (style?.textColor) settings.textColor = style.textColor;
    return { version: 1, name: name.trim() || c.theme.name, base: c.doc.themeId, settings: parseThemeSettings(settings) };
  }
  function addProfile(item: Profile) {
    const next = [...profiles.filter((p) => p.name !== item.name), item];
    setSetting('radiant.themes', JSON.stringify(next));
    profiles = next;
    title = item.name;
  }
  function saveProfile() {
    try { const item = currentProfile(); addProfile(item); status = `Saved ${item.name}.`; }
    catch { status = 'Could not save the theme.'; }
  }
  function applyProfile(item: Profile) {
    c.editor.apply({ label: 'Apply Saved Theme', source: 'user',
      ops: [{ t: 'docMeta', patch: { themeId: item.base, themeSettings: item.settings } }] });
  }
  async function exportProfile() {
    const item = currentProfile();
    const file = item.name.replace(/[\\/:*?"<>|]/g, '_') + '.radiant-theme.json';
    try {
      if (await c.host.exportFile(file, 'application/json', new TextEncoder().encode(JSON.stringify(item, null, 2)))) {
        status = `Exported ${item.name}.`;
      }
    } catch { status = 'Could not export the theme.'; }
  }
  async function importProfile(event: Event & { currentTarget: HTMLInputElement }) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    try {
      const item = file.size <= 256_000 ? parseProfile(JSON.parse(await file.text())) : undefined;
      if (!item) throw new Error('Invalid theme file.');
      addProfile(item);
      applyProfile(item);
      status = `Imported ${item.name}.`;
    } catch { status = 'This file does not contain a Radiant theme.'; }
  }
  // ---- Everyday drawing features (THM-06). Each control writes theme settings through `change`, so it is undoable.
  /** The preset under the map's settings, in the current canvas appearance. */
  const preset = $derived.by(() => { void c.rev; return getTheme(c.doc.themeId, c.darkChrome); });
  const OFF_SHADOW: ShadowSpec = { dy: 0, blur: 0, opacity: 0 };
  const DEFAULT_SHADOW: ShadowSpec = { dy: 5, blur: 6.5, opacity: 0.2 };
  const DEFAULT_DOTS = { radius: 3, gap: 4 };
  const lineFlags: Array<['branchGradient' | 'roundCaps' | 'fanRootJoins', string]> = [
    ['branchGradient', 'Blend along main limbs'], ['roundCaps', 'Round line ends'], ['fanRootJoins', 'Fanned centre joins']
  ];
  const shadowsOn = $derived(!!(c.theme.rootShadow?.opacity || c.theme.nodeShadow?.opacity));
  const dotsOn = $derived((c.theme.tipDots?.radius ?? 0) > 0);
  const surfaceKind = $derived(c.theme.canvasSurface?.gradient ? 'gradient' : c.theme.canvasSurface?.dots ? 'dots' : 'plain');
  function setShadows(on: boolean) {
    const has = (s?: ShadowSpec) => !!s && s.opacity > 0;
    if (!on) change({ rootShadow: OFF_SHADOW, nodeShadow: OFF_SHADOW });
    // Back to the preset's shadows; a default root shadow when the preset has none.
    else change({ rootShadow: has(preset.rootShadow) ? undefined : DEFAULT_SHADOW, nodeShadow: undefined });
  }
  function setTipDots(on: boolean) {
    // Radius 0 turns dots off, also over a preset that has them.
    change({ tipDots: on ? (preset.tipDots?.radius ?? 0) > 0 ? undefined : DEFAULT_DOTS : { radius: 0, gap: 0 } });
  }
  function setSurface(kind: string) {
    const theme = c.theme;
    const vignette = theme.canvasSurface?.vignette;
    const next: CanvasSurface = vignette ? { vignette } : {};
    if (kind === 'dots') next.dots = preset.canvasSurface?.dots ?? { color: theme.textColor, opacity: 0.18 };
    if (kind === 'gradient') {
      next.gradient = preset.canvasSurface?.gradient ??
        [mixColor(theme.background, '#ffffff', 0.35).slice(0, 7), mixColor(theme.background, theme.textColor, 0.07).slice(0, 7)];
    }
    change({ canvasSurface: next });
  }
  const palettePresets = {
    vivid: ['#E53935', '#FB8C00', '#F2B600', '#43A047', '#1E88E5', '#8E24AA', '#00ACC1', '#EC407A'],
    light: ['#E5A299', '#E5BB7F', '#8CCE9F', '#8EB8D7', '#AF9DCB', '#CA91AC'],
    accessible: ['#005583', '#AD4800', '#00684C', '#8C3970', '#746100', '#463985', '#007381'],
    muted: ['#845A51', '#8A6940', '#537662', '#4B6484', '#68567C', '#8A5970']
  };
</script>

<details class="theme-settings">
  <summary>Customize theme</summary>
  <label>Canvas appearance
    <select value={c.theme.canvasAppearance ?? 'system'} onchange={(event) =>
      change({ canvasAppearance: event.currentTarget.value as ThemeSettings['canvasAppearance'] })}>
      <option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option>
    </select>
  </label>
  <div class="row">
    {#each colors as [key, label] (key)}
      <label>{label}<input type="color" value={c.theme[key] ?? '#516070'}
        onchange={(event) => change({ [key]: event.currentTarget.value })} /></label>
    {/each}
  </div>
  {#if c.doc.themeSettings?.rootFillColor || c.doc.themeSettings?.nodeFillColor}
    <button class="btn" onclick={() => change({ rootFillColor: undefined, nodeFillColor: undefined })}>Reset theme fills</button>
  {/if}
  <label>Default font
    <select value={c.doc.themeSettings?.fontFamily ?? ''} onchange={(event) => change({ fontFamily: event.currentTarget.value || undefined })}>
      <option value="">Preset font</option>
      {#each THEME_FONT_FAMILIES as family (family)}<option value={family}>{family.split(',')[0].replaceAll('"', '')}</option>{/each}
    </select>
  </label>
  <div class="row">
    {#each sizes as [key, label] (key)}
      <label>{label}<input type="number" min="8" max="96" value={c.theme[key]}
        onchange={(event) => change({ [key]: event.currentTarget.valueAsNumber })} /></label>
    {/each}
  </div>
  {#each shapes as [key, label] (key)}
    <label>{label}<select value={c.theme[key] ?? c.theme.shape}
      onchange={(event) => change({ [key]: THEME_SHAPES.find((shape) => shape === event.currentTarget.value) })}>
      {#each THEME_SHAPES as shape (shape)}<option value={shape}>{shapeName[shape]}</option>{/each}
    </select></label>
  {/each}
  <label>Branch style<select value={c.theme.branch}
    onchange={(event) => change({ branch: THEME_BRANCHES.find((branch) => branch === event.currentTarget.value) })}>
    {#each THEME_BRANCHES as branch (branch)}<option value={branch}>{branchName[branch]}</option>{/each}
  </select></label>
  <label>Branch material<select value={c.theme.branchMaterial ?? 'flat'}
    onchange={(event) => change({ branchMaterial: THEME_BRANCH_MATERIALS.find((material) => material === event.currentTarget.value) })}>
    {#each THEME_BRANCH_MATERIALS as material (material)}<option value={material}>{branchMaterialName[material]}</option>{/each}
  </select></label>
  <label>Connection line<select value={c.theme.connectionDash ?? 'dashed'}
    onchange={(event) => change({ connectionDash: event.currentTarget.value === 'solid' ? 'solid' : 'dashed' })}>
    <option value="dashed">Dashed</option><option value="solid">Solid</option>
  </select></label>
  <label>Palette preset<select value="" onchange={(event) => {
    const key = event.currentTarget.value as keyof typeof palettePresets;
    if (palettePresets[key]) change({ branchColors: palettePresets[key], branchMarkers: key === 'accessible' });
  }}>
    <option value="">Choose palette</option><option value="vivid">Vivid</option><option value="light">Pastel</option><option value="muted">Muted</option><option value="accessible">Colour-blind safe with branch numbers</option>
  </select></label>
  <label>Branch colours<input value={c.theme.branchColors.join(', ')} onchange={(event) => {
    const branchColors = event.currentTarget.value.split(',').map((color) => color.trim());
    if (parseThemeSettings({ branchColors })?.branchColors) change({ branchColors });
    else status = 'Use comma-separated six-digit hex colours.';
  }} /></label>
  <label>Branch spacing<input type="range" min="8" max="250" value={c.theme.levelGap}
    onchange={(event) => change({ levelGap: event.currentTarget.valueAsNumber })} /></label>
  <label>Sibling spacing<input type="range" min="2" max="150" value={c.theme.siblingGap}
    onchange={(event) => change({ siblingGap: event.currentTarget.valueAsNumber })} /></label>

  <details class="lines">
    <summary>Lines, shadows and canvas</summary>
    <label>Tip tint<input type="range" min="0" max="1" step="0.01" value={c.theme.tipTint ?? 0}
      onchange={(event) => change({ tipTint: event.currentTarget.valueAsNumber })} /></label>
    <p>Lines toward the tips fade toward the canvas colour.</p>
    {#each lineFlags as [key, label] (key)}
      <label class="check"><input type="checkbox" checked={!!c.theme[key]} onchange={(event) => change({ [key]: event.currentTarget.checked })} /> {label}</label>
    {/each}
    <label class="check"><input type="checkbox" checked={shadowsOn} onchange={(event) => setShadows(event.currentTarget.checked)} /> Shadows</label>
    <label class="check"><input type="checkbox" checked={dotsOn} onchange={(event) => setTipDots(event.currentTarget.checked)} /> Dots at the tips</label>
    <label>Canvas surface<select value={surfaceKind} onchange={(event) => setSurface(event.currentTarget.value)}>
      <option value="plain">Plain</option><option value="dots">Dots</option><option value="gradient">Gradient</option>
    </select></label>
    <label>Vignette<input type="range" min="0" max="0.5" step="0.01" value={c.theme.canvasSurface?.vignette ?? 0}
      onchange={(event) => change({ canvasSurface: { ...c.theme.canvasSurface, vignette: event.currentTarget.valueAsNumber } })} /></label>
    {#if c.theme.lean}<p>Lean mode hides the canvas surface.</p>{/if}
  </details>

  <details>
    <summary>Buzan settings</summary>
    <label class="check"><input type="checkbox" checked={!c.theme.showGrid} onchange={(event) => change({ showGrid: !event.currentTarget.checked })} /> Blank canvas</label>
    <label class="check"><input type="checkbox" checked={c.theme.branch === 'organic' || c.theme.branch === 'tapered'}
      onchange={(event) => change({ branch: event.currentTarget.checked ? 'organic' : 'line' })} /> Curved tapered branches</label>
    <p>Curves have a preference benefit. The studies cited in the blueprint found no memory benefit.</p>
    <label class="check"><input type="checkbox" checked={c.theme.shape === 'underline' && (c.theme.mainShape ?? c.theme.shape) === 'underline'}
      onchange={(event) => {
        const shape = event.currentTarget.checked ? 'underline' : 'box';
        change({ shape, mainShape: shape });
      }} /> Labels on unboxed branches</label>
    <p>Buzan preferred unboxed keywords on the branch.</p>
    <label class="check"><input type="checkbox" checked={!c.theme.curvedLabels}
      onchange={(event) => change({ curvedLabels: !event.currentTarget.checked })} /> Keep labels upright</label>
    <p>Buzan preferred horizontal text for readability.</p>
    {#each rules as [rule, label, evidence] (rule)}
      <label class="check"><input type="checkbox" checked={!!c.theme[rule]} onchange={(event) => change({ [rule]: event.currentTarget.checked })} /> {label}</label>
      <p>{evidence}</p>
    {/each}
  </details>
  <label class="check"><input type="checkbox" checked={!!c.theme.lean} onchange={(event) => change({ lean: event.currentTarget.checked })} /> Lean mode for this map</label>
  <label class="check"><input type="checkbox" checked={c.leanDefault} onchange={(event) => c.setLeanDefault(event.currentTarget.checked)} /> Lean mode by default</label>

  <details>
    <summary>Personal themes</summary>
    <label>Theme name<input maxlength="80" placeholder={c.theme.name} bind:value={name} /></label>
    <label class="check"><input type="checkbox" disabled={!focused} bind:checked={extractNode} /> Include selected node’s style</label>
    <div class="actions">
      <button class="btn bordered" onclick={saveProfile}>Save theme</button>
      <button class="btn bordered" onclick={() => void exportProfile()}>Export…</button>
      <button class="btn bordered" onclick={() => picker?.click()}>Import…</button>
    </div>
    <input type="file" hidden bind:this={picker} accept=".json,application/json" onchange={(event) => void importProfile(event)} />
    {#if profiles.length}
      <label>Saved theme<select bind:value={title}>
        <option value="">Choose theme</option>
        {#each profiles as item (item.name)}<option value={item.name}>{item.name}</option>{/each}
      </select></label>
      <button class="btn bordered" disabled={!title} onclick={() => {
        const selected = profiles.find((item) => item.name === title);
        if (selected) applyProfile(selected);
      }}>Apply theme</button>
    {/if}
  </details>
  {#if status}<p role="status">{status}</p>{/if}
</details>

<style>
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  label { display: grid; gap: 3px; margin: 7px 0; font-size: 12px; }
  .check { display: block; }
  input, select { min-width: 0; max-width: 100%; box-sizing: border-box; }
  .row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 4px; }
  p { font-size: 11px; margin: 2px 0 6px; color: var(--text-dim); }
</style>
