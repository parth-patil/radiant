<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ArtAnchors from './ArtAnchors.svelte';
  import ArtStyleEditor from './ArtStyleEditor.svelte';
  import { artPreset, DEFAULT_PICTURE_CONCURRENCY, DEFAULT_PICTURE_ESTIMATE_THRESHOLD, describeStyle, effectiveRepresentation, listArtPresets } from '../core/art';
  import type { MapNode, NodeArt, PictureLabelPlacement, Representation } from '../core/types';
  import type { AppController } from './controller.svelte';
  import { artIsStale, artPaletteAt, artStyleAt, ArtWorkflow, type ArtRequestPreview } from './artWorkflow.svelte';
  import { getSetting, setSetting } from './settings';
  import { aiChoice } from './ai-engine.svelte';

  let { c }: { c: AppController } = $props();
  const workflow = new ArtWorkflow(untrack(() => c));
  const presets = listArtPresets();
  const modes: Array<[Representation, string]> = [['vector', 'Vector'], ['picture', 'Picture'], ['svg', 'SVG']];

  const node = $derived.by(() => {
    void c.rev;
    const id = c.focusId;
    const current = id ? c.doc.nodes[id] : undefined;
    return current ? { ...current } : undefined;
  });
  const representation = $derived.by(() => {
    void c.rev;
    return node ? effectiveRepresentation(c.doc, node.id) : 'vector';
  });
  let scope = $state<'all' | 'node' | 'levels'>('all');
  let levels = $state(2);
  let concurrency = $state(DEFAULT_PICTURE_CONCURRENCY);
  let svgRepairs = $state(2);
  let estimateAbove = $state(DEFAULT_PICTURE_ESTIMATE_THRESHOLD);
  const estimatePreference = 'radiant.pictureEstimateAbove';
  const depth = $derived(scope === 'all' ? Infinity : scope === 'node' ? 0 : Math.max(1, (levels || 2) - 1));
  let stale = $state(false);
  let detailsOpen = $state(false);
  let editingPrompt = $state(false);
  let customPrompt = $state('');
  let confirmationHeading = $state<HTMLHeadingElement>();
  const effectiveStyle = $derived.by(() => {
    void c.rev;
    return node ? artStyleAt(c.doc, node.id) : undefined;
  });
  const palette = $derived.by(() => {
    void c.rev;
    return node ? artPaletteAt(c.doc, c.theme, node.id) : [];
  });
  const chosenStyleName = $derived.by(() => {
    const style = effectiveStyle;
    if (!style) return '';
    const preset = artPreset(style.id);
    const edited = preset.seed !== style.seed || describeStyle(preset) !== describeStyle(style);
    return edited ? `${style.name} (customized)` : style.name;
  });
  const inheritedStyle = $derived.by(() => {
    void c.rev;
    return node?.parent && !node.artStyleIsland
      ? artStyleAt(c.doc, node.parent).name
      : artPreset(c.doc.artStyleId ?? presets[0].id).name;
  });
  const art = $derived.by(() => {
    void c.rev;
    return representation === 'picture' ? node?.pictureArt : representation === 'svg' ? node?.svgArt : undefined;
  });
  const unavailable = $derived(art && c.failedImages.has(art.assetHash));
  const available = $derived(c.aiStatus?.available === true && !c.aiAllowanceError);
  const images = $derived(c.aiStatus?.capabilities?.images === true);
  /** Pictures always use Codex: with another engine chosen, they need only Codex's image tool, not that engine. */
  const pictureReady = $derived(images && !c.aiAllowanceError && (available || aiChoice.engine !== 'codex'));
  const completedPictures = $derived(workflow.pictureProgress.filter(row => row.state === 'Complete').length);
  const locked = $derived(workflow.phase !== 'idle');
  const limits = $derived(c.aiStatus?.capabilities?.rateLimits ? c.aiStatus.rateLimits : undefined);
  const weekly = $derived.by(() => {
    if (!limits) return undefined;
    if (limits.primaryWindowMinutes === 10_080) return limits.primaryUsedPercent;
    if (limits.secondaryWindowMinutes === undefined || limits.secondaryWindowMinutes === 10_080) {
      return limits.secondaryUsedPercent;
    }
  });

  onMount(() => {
    const saved = getSetting(estimatePreference);
    if (saved !== null) estimateAbove = validatedThreshold(Number(saved));
  });

  function validatedThreshold(value: number): number {
    return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_PICTURE_ESTIMATE_THRESHOLD;
  }

  function setEstimateThreshold(input: HTMLInputElement) {
    estimateAbove = validatedThreshold(input.valueAsNumber);
    input.value = String(estimateAbove);
    setSetting(estimatePreference, String(estimateAbove));
  }

  function estimatedDuration(seconds: number): string {
    return seconds < 60 ? `${seconds} sec` : `${Math.ceil(seconds / 60)} min`;
  }

  $effect(() => {
    const doc = c.doc;
    void c.rev;
    workflow.checkDocument(doc, c.focusId);
  });
  $effect(() => () => workflow.cancel());
  $effect(() => { confirmationHeading?.focus(); });
  $effect(() => {
    void c.rev;
    const id = c.focusId;
    const asset = art;
    if (!id || !asset) { stale = false; return; }
    let active = true;
    void artIsStale(c.doc, c.theme, id, asset).then(
      (value) => { if (active) stale = value; },
      () => { if (active) stale = false; }
    );
    return () => { active = false; };
  });
  $effect(() => {
    void c.focusId;
    void representation;
    editingPrompt = false;
    customPrompt = '';
  });

  function setMode(mode?: Representation) {
    if (!node) return;
    c.setSelectedRepresentation(mode,depth);
  }

  function setPreset(target: MapNode, id: string) {
    if (c.focusId !== target.id || !c.doc.nodes[target.id]) return;
    c.editor.apply({ source: 'user', label: 'Change Art Style', ops: [{ t: 'set', id: target.id, patch: { artStyleId: id || undefined } }] });
  }

</script>

  <div class="sec art-panel" aria-label="Subtree artwork">
    <div class="lbl">Subtree artwork</div>
    <label class="visibility" title="Toggle generated artwork with ⌘⌥A or Ctrl+Alt+A">
      <input type="checkbox" checked={c.showGeneratedArtwork} onchange={(event) => c.setShowGeneratedArtwork(event.currentTarget.checked)} />
      Show generated artwork
    </label>
    {#if node}
      <div class="seg" aria-label="Representation">
        {#each modes as [mode, label] (mode)}
          <button type="button" aria-pressed={representation === mode} class:on={representation === mode}
            disabled={locked} onclick={() => setMode(mode)}>{label}</button>
        {/each}
      </div>
      {#if node.parent && node.representation}
        <button class="btn inherit" disabled={locked} onclick={() => setMode()}>Inherit parent artwork mode</button>
      {/if}

      <label for="art-scope">Scope</label>
      <select id="art-scope" bind:value={scope} disabled={locked}>
        <option value="all">Whole subtree</option>
        <option value="node">This node only</option>
        <option value="levels">Selected levels</option>
      </select>
      {#if scope === 'levels'}
        <label for="art-levels">Levels including this node</label>
        <input id="art-levels" class="field" type="number" min="2" max="12" bind:value={levels} disabled={locked} />
      {/if}

      {#if workflow.phase !== 'confirm'}
        {@render styleControls(node, locked)}
      {/if}

      {#if !locked}
        <label class="visibility">
          <input type="checkbox" bind:checked={workflow.inspectRequests} />
          Review what will be sent before each artwork request
        </label>
        {#if images}
          <label for="art-parallel-jobs">Concurrent picture jobs</label>
          <select id="art-parallel-jobs" bind:value={concurrency}>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
          <label for="art-picture-estimate">Show a time estimate above this many images</label>
          <input id="art-picture-estimate" class="field" type="number" min="0" step="1" value={estimateAbove}
            onchange={(event) => setEstimateThreshold(event.currentTarget)} />
          <button class="btn bordered" disabled={!pictureReady || c.busy}
            onclick={() => void workflow.start(node.id, 'picture', { depth, concurrency, pictureEstimateAbove: estimateAbove })}>
            Generate picture subtree
          </button>
        {/if}
        <label for="svg-repairs">SVG repair attempts</label>
        <select id="svg-repairs" bind:value={svgRepairs}>
          <option value={2}>2</option><option value={1}>1</option><option value={0}>0</option>
        </select>
        <button class="btn bordered" disabled={!available || c.busy}
          onclick={() => void workflow.start(node.id, 'svg', { depth, svgRepairs })}>Generate SVG subtree</button>
        {#if node.svgArtError}
          <button class="btn bordered" disabled={!available || c.busy}
            onclick={() => void workflow.start(node.id, 'svg', { single: true, rework: true, svgRepairs })}>Retry SVG artwork</button>
        {/if}
        {#if representation === 'svg' || (images && representation === 'picture')}
          {#if art}
            <button class="btn" onclick={() => { customPrompt = editingPrompt ? '' : art.brief ?? (art.instructions ? '' : art.prompt); editingPrompt = !editingPrompt; }}>
              {editingPrompt ? 'Use automatic prompt' : representation === 'svg' ? 'Edit SVG instruction' : 'Edit picture prompt'}
            </button>
            {#if editingPrompt}
              <label for="art-custom-prompt">{representation === 'svg' ? 'SVG instruction' : 'Picture prompt'}</label>
              <textarea id="art-custom-prompt" class="field" bind:value={customPrompt}></textarea>
            {/if}
          {/if}
          <button class="btn bordered" disabled={!(representation === 'picture' ? pictureReady : available) || c.busy || (editingPrompt && !customPrompt.trim())}
            onclick={() => void workflow.start(node.id, representation, { rework: true, single: true, svgRepairs, prompt: editingPrompt ? customPrompt : undefined, pictureEstimateAbove: estimateAbove })}>
            {art ? 'Regenerate this node' : 'Generate this node'}
          </button>
        {/if}
        {#if c.aiAllowanceError}<p role="status">{c.aiAllowanceError}</p>
        {:else if !available}<p>Generation requires a connected AI engine.</p>{/if}
      {/if}

      {#if node.pictureArtError}<p role="status">Picture generation failed for this node. {node.pictureArtError}</p>{/if}
      {#if node.svgArtError}<p role="status">SVG generation failed for this node. {node.svgArtError}</p>{/if}
      {#if art && unavailable}
        <p role="status">Artwork could not be loaded. The editable vector node is shown.</p>
        <button class="btn bordered" disabled={locked} onclick={() => c.retryImage(art!.assetHash)}>Retry loading artwork</button>
        <button class="btn bordered" disabled={locked} onclick={() => c.editor.apply({
          source: 'user', label: 'Remove Unavailable Artwork', ops: [
            { t: 'set', id: node.id, patch: representation === 'svg' ? { svgArt: undefined } : { pictureArt: undefined } }
          ]
        })}>Remove unavailable artwork</button>
      {/if}
      {#if art}
        {#if stale}<p class="stale">The artwork predates an edit. Regenerate this node to update it.</p>{/if}
        {#if representation === 'picture'}
          <label for="picture-label-placement">Picture label</label>
          <select id="picture-label-placement" value={node.pictureLabelPlacement ?? 'caption'} disabled={locked}
            onchange={(event) => c.editor.apply({
              source: 'user', label: 'Change Picture Label Placement',
              ops: [{ t: 'set', id: node.id, patch: { pictureLabelPlacement: event.currentTarget.value as PictureLabelPlacement } }]
            })}>
            <option value="caption">Caption below the picture</option>
            <option value="branch">On the branch above the picture</option>
            <option value="recall">Reveal on hover or focus</option>
          </select>
        {/if}
        <details bind:open={detailsOpen}>
          <summary>Artwork details</summary>
          {@render provenance(art, representation === 'svg')}
          {#if detailsOpen && !locked && representation !== 'vector'}
            {#key node.id}
              <ArtAnchors {c} nodeId={node.id} {art} kind={representation} />
            {/key}
          {/if}
        </details>
      {/if}
      {#if node.artReference}
        <details>
          <summary>Style reference details</summary>
          {@render provenance(node.artReference)}
        </details>
      {/if}
    {/if}

    {#if workflow.confirmation && node?.id === workflow.confirmation.root}
      {@const plan = workflow.confirmation}
      <div class="art-confirmation" role="dialog" aria-labelledby="art-confirm-title">
        <h3 id="art-confirm-title" class="lbl" tabindex="-1" bind:this={confirmationHeading}>{plan.title}</h3>
        <p>Style in use is <strong>{chosenStyleName}</strong>.</p>
        {@render styleControls(node, false)}
        {#if plan.imageCount !== undefined}
          <p>{plan.imageCount === 1 ? '1 image · 1 model turn' : `Up to ${plan.imageCount} images · ${plan.turnCount} model turns`}{plan.includesReference ? ', including the style reference.' : '.'}</p>
        {:else}
          <p>Up to {plan.turnCount} model turns, including any selected repairs.</p>
        {/if}
        {#if plan.includesReference}<p>Review the style reference before sample generation.</p>{/if}
        {#if plan.previewsSample}<p>Review a sample before the rest of the batch.</p>{/if}
        {#if plan.estimatedSeconds !== undefined}
          <p>Estimated generation time is {estimatedDuration(plan.estimatedSeconds)}.</p>
          {#if limits?.primaryUsedPercent !== undefined && limits.primaryWindowMinutes !== 10_080}
            <p>Current short-window usage is {Math.round(limits.primaryUsedPercent)}%.</p>
          {/if}
          {#if limits?.secondaryUsedPercent !== undefined && limits.secondaryWindowMinutes !== undefined && limits.secondaryWindowMinutes !== 10_080}
            <p>Current secondary-window usage is {Math.round(limits.secondaryUsedPercent)}%.</p>
          {/if}
        {/if}
        <p>{workflow.refreshingUsage ? 'Checking current usage…' : weekly === undefined ? 'Current weekly usage is unavailable.' : `Current weekly usage is ${Math.round(weekly)}%.`}</p>
        <div class="confirm-actions">
          <button class="btn bordered" onclick={() => workflow.cancel()}>Decline</button>
          <button class="btn bordered primary" disabled={!(plan.imageCount !== undefined ? pictureReady : available) || c.busy || workflow.refreshingUsage} onclick={() => void workflow.confirm()}>Confirm generation</button>
        </div>
      </div>
    {/if}

    {#each workflow.pendingRequests as request (request.id)}
      <details open>
        <summary>What will be sent</summary>
        {@render requestContents(request)}
        <button class="btn bordered" onclick={() => workflow.approveRequest(request.id)}>Send artwork request</button>
      </details>
    {/each}
    {#if workflow.sentRequests.length}
      <details>
        <summary>Artwork requests submitted in the last run ({workflow.sentRequests.length})</summary>
        {#each workflow.sentRequests as request, i (request.id)}
          <details>
            <summary>Request {i + 1}</summary>
            {@render requestContents(request)}
          </details>
        {/each}
      </details>
    {/if}
    {#if workflow.message}<p role="status">{workflow.message}</p>{/if}
    {#if workflow.phase === 'running'}
      <progress max={workflow.total || 1} value={workflow.done} aria-label="Artwork generation progress"></progress>
    {:else if workflow.phase === 'reference' || workflow.phase === 'sample'}
      <div class="samples">
        {#each workflow.previews as preview (preview.id)}
          <figure><img src={preview.url} alt={preview.title} /><figcaption>{preview.title}</figcaption></figure>
        {/each}
      </div>
      {#if workflow.phase === 'reference'}
        <button class="btn bordered" onclick={() => workflow.acceptReference()}>Use style reference</button>
        <button class="btn bordered" onclick={() => workflow.reroll()}>Regenerate reference</button>
      {:else}
        <button class="btn bordered" onclick={() => workflow.accept()}>{workflow.previews.length === 1 ? 'Use new artwork' : 'Use sample'}</button>
        <button class="btn bordered" onclick={() => workflow.reroll()}>Regenerate sample</button>
      {/if}
    {:else if workflow.phase === 'paused'}
      <button class="btn bordered" onclick={() => void workflow.resume()}>Resume artwork</button>
    {/if}
    {#if workflow.pictureProgress.length && workflow.phase !== 'confirm'}
      <details class="picture-jobs" open>
        <summary>{completedPictures} of {workflow.pictureProgress.length} pictures complete</summary>
        <ul aria-label="Picture jobs">
          {#each workflow.pictureProgress as row (row.id)}
            <li><span>{row.title || 'Untitled node'}</span><span>{row.state}</span></li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if locked && workflow.phase !== 'confirm'}
      <button class="btn" onclick={() => workflow.cancel()}>{workflow.phase === 'reference' ? 'Reject reference' : workflow.phase === 'sample' ? 'Reject sample' : workflow.phase === 'paused' ? 'Stop artwork generation' : 'Cancel artwork generation'}</button>
    {/if}
  </div>

{#snippet styleControls(target: MapNode, disabled: boolean)}
  <label for="art-preset">Art style</label>
  <select id="art-preset" value={target.artStyleId ?? ''} {disabled}
    onchange={(event) => setPreset(target, event.currentTarget.value)}>
    <option value="">{target.artStyleIsland ? `Use map preset (${inheritedStyle})` : `Inherit (${inheritedStyle})`}</option>
    {#each presets as preset (preset.id)}
      <option value={preset.id}>{preset.name}</option>
    {/each}
  </select>
  {#if palette.length}
    <div class="lbl">{effectiveStyle?.palette.source === 'custom' ? 'Custom artwork colours' : 'Artwork colours from branch'}</div>
    <ul class="art-colours" aria-label="Effective artwork palette">
      {#each palette as colour (colour)}
        <li><span aria-hidden="true" style:background={colour}></span>{colour}</li>
      {/each}
    </ul>
  {/if}
  {#key target.id}<ArtStyleEditor {c} node={target} locked={disabled} />{/key}
{/snippet}

{#snippet provenance(art: NodeArt, svg = false)}
  {@const svgSeed = art.svgSeed ?? (svg ? art.styleSnapshot?.seed : undefined)}
  <dl>
    {#if art.templateVersion}<dt>Template</dt><dd>{art.templateVersion}</dd>{/if}
    <dt>Generated</dt><dd><time datetime={art.generatedAt}>{new Date(art.generatedAt).toLocaleString()}</time></dd>
    <dt>Style</dt><dd>{presets.find((preset) => preset.id === art.styleId)?.name ?? art.styleId}, v{art.styleVersion}</dd>
    <dt>Model</dt><dd>{art.model ?? 'Unreported'}</dd>
    <dt>Effort</dt><dd>{art.effort ?? 'Unreported'}</dd>
    <dt>Provider seed</dt><dd>{art.seed ?? 'Unreported'}</dd>
    {#if svgSeed !== undefined}<dt>Requested SVG seed</dt><dd>{svgSeed}</dd>{/if}
    <dt>Input hash</dt><dd>{art.inputHash}</dd>
    {#if art.svgValidation?.fitted}<dt>Fit</dt><dd>Adjusted to fit the node box.</dd>{/if}
    {#if art.svgValidation?.warnings?.length}
      <dt>SVG validation</dt><dd>{art.svgValidation.warnings.join(' ')}</dd>
    {/if}
    {#if art.pixelSize}<dt>Picture</dt><dd>{art.pixelSize.width} × {art.pixelSize.height} px · {art.pixelSize.padding} px padding</dd>{/if}
    <dt>Prompt</dt><dd class="prompt">{art.prompt}</dd>
    {#if art.instructions}<dt>Instructions</dt><dd class="prompt">{art.instructions}</dd>{/if}
    {#if art.revisedPrompt}<dt>Revised prompt</dt><dd class="prompt">{art.revisedPrompt}</dd>{/if}
  </dl>
{/snippet}

{#snippet requestContents(request: ArtRequestPreview)}
  <dl>
    <dt>Scope</dt><dd>{request.scope}</dd>
    <dt>Instructions</dt><dd class="prompt">{request.instructions}</dd>
    <dt>Prompt and map context</dt><dd class="prompt">{request.prompt}</dd>
    <dt>Reference images</dt>
    <dd>
      {#each request.refs as ref (ref.hash)}
        <figure>
          <img class="attachment" src={ref.url} alt="Reference included in this request" />
          <figcaption>{ref.hash}</figcaption>
        </figure>
      {:else}
        None
      {/each}
    </dd>
  </dl>
{/snippet}

<style>
  .attachment { max-width: 100%; max-height: 180px; object-fit: contain; }
  .art-panel { display: grid; gap: 7px; }
  .art-panel button:disabled { opacity: 0.5; cursor: default; }
  .art-panel p, .art-panel details { margin: 0; color: var(--text-dim); font-size: 11.5px; line-height: 1.4; overflow-wrap: anywhere; }
  .art-panel label { margin-bottom: 0; }
  .art-confirmation { display: grid; gap: 5px; }
  .art-confirmation h3 { margin: 0; }
  .confirm-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .visibility { display: flex; align-items: center; gap: 6px; }
  .art-panel progress { width: 100%; }
  .art-colours { display: flex; flex-wrap: wrap; gap: 4px 8px; padding: 0; margin: 0 0 8px; list-style: none; }
  .art-colours li { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
  .art-colours span { width: 10px; height: 10px; border: 1px solid var(--border); border-radius: 2px; }
  .picture-jobs ul { list-style: none; margin: 4px 0; padding: 0; max-height: 12rem; overflow: auto; }
  .picture-jobs li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; padding: 2px 0; }
  .picture-jobs li span:first-child { overflow-wrap: anywhere; }
  .art-panel .stale { color: var(--text); }
  .inherit { justify-self: start; }
  .samples { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  figure { min-width: 0; margin: 0; }
  figure img { width: 100%; height: 60px; object-fit: contain; background: var(--panel); border-radius: 6px; }
  figcaption { font-size: 10px; overflow-wrap: anywhere; }
  dl { margin: 4px 0 0; }
  dt { font-weight: 600; color: var(--text); }
  dd { margin: 0 0 4px; }
  .prompt { white-space: pre-wrap; max-height: 160px; overflow: auto; }
</style>
