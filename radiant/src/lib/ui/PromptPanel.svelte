<script lang="ts">
  import type { AppController } from './controller.svelte';
  import { SOURCE_BYTE_LIMIT } from '../core/ai/source';
  import Icon from './Icon.svelte';
  import { aiChoice } from './ai-engine.svelte';

  let { c }: { c: AppController } = $props();
  const chips = ['Buzan organic', 'Clean', 'Ink', 'Midnight', 'Hand-drawn', 'Colourful for kids', 'Minimal business'];
  let useFallback = $state(false);
  let researchWeb = $state(false);
  const canGenerate = $derived(!c.aiAllowanceError && (c.aiStatus === null || c.aiStatus.available || c.aiStatus.fallbackAvailable === true));
  function generate(): void {
    if (!canGenerate) return;
    const enabled = researchWeb;
    researchWeb = false;
    void c.generate(useFallback && !!c.aiStatus?.fallbackAvailable, undefined, enabled);
  }
  let readingSource = $state(false);
  let sourceError = $state('');
  async function loadSource(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    sourceError = '';
    readingSource = true;
    try {
      const content = await file.slice(0, SOURCE_BYTE_LIMIT + 4).text();
      c.setGenerationSource(content, file.name, file.size > SOURCE_BYTE_LIMIT);
    } catch {
      sourceError = 'Could not read the selected source file.';
    } finally {
      readingSource = false;
    }
  }
  let topicEl: HTMLInputElement | undefined = $state();
  $effect(() => {
    topicEl?.focus();
  });
  let now = $state(Date.now());
  const startedAt = $derived(c.gen?.startedAt);
  const template = $derived(c.generationPrompt());
  const lastGeneration = $derived(Object.values(c.jobs).filter((job) => job.kind === 'generate').at(-1));
  $effect(() => {
    if (startedAt === undefined) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const secs = $derived(startedAt === undefined ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000)));
  const label = $derived(
    c.gen
      ? c.gen.status === 'cancelling'
        ? 'Stopping…'
        : !c.gen.liveGrowth
          ? `Preparing the map… ${secs}s`
          : c.gen.nodes === 0
          ? `Waiting for the first nodes… ${secs}s`
          : `${c.gen.nodes} node${c.gen.nodes === 1 ? '' : 's'} added · ${secs}s`
      : ''
  );
  const emptyDoc = $derived(c.isEmpty);
  // Generate grows the selected node; "New map" keeps the earlier behaviour.
  const target = $derived.by(() => {
    void c.rev;
    const id = c.generateNodeId;
    return id ? { id, text: c.doc.nodes[id]?.text || 'Unnamed node' } : null;
  });
  const canTarget = $derived.by(() => {
    void c.rev;
    return !c.isEmpty && !!c.focusId && !!c.doc.nodes[c.focusId];
  });
  const nodeTemplate = $derived(target ? c.nodeGenerationPrompt() : null);
</script>

<div class="prompt" data-keyboard-pane class:running={c.gen != null} role="dialog" aria-label="Generate a map">
  {#if !c.gen}
    <h2>{target ? `Generate under “${target.text}”` : emptyDoc ? 'Generate a map' : 'Generate a new map next to this one'}</h2>
    {#if canTarget}
      <div class="row" style="margin-top:0">
        <span class="control-label" id="target-label">Add to</span>
        <div class="seg target" role="group" aria-labelledby="target-label">
          <button class:on={!c.generateNewMap} aria-pressed={!c.generateNewMap} onclick={() => (c.generateNewMap = false)}>Selected node</button>
          <button class:on={c.generateNewMap} aria-pressed={c.generateNewMap} onclick={() => (c.generateNewMap = true)}>New map</button>
        </div>
      </div>
    {/if}
    {#if target}
      <div class="row">
        <label for="grow-focus">Focus</label>
        <input id="grow-focus" class="wide" type="text" placeholder="Optional: what should the new nodes cover?"
          bind:this={topicEl} bind:value={c.growFocus} disabled={c.busy}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !e.isComposing && !readingSource) {
              e.preventDefault();
              generate();
            }
          }} />
      </div>
      <div class="row">
        <span class="control-label" id="grow-depth-label" title="Levels of new nodes below the selected node. Default 2.">Depth</span>
        <div class="seg" role="group" aria-labelledby="grow-depth-label" style="width:130px">
          {#each [1, 2, 3] as d (d)}<button class:on={c.growDepth === d} aria-pressed={c.growDepth === d} disabled={c.busy} onclick={() => (c.growDepth = d)}>{d}</button>{/each}
        </div>
        <span class="control-label" id="grow-breadth-label" title="Most new branches under the selected node. Default 5." style="width:auto;margin-left:14px">Breadth</span>
        <div class="stepper" role="group" aria-labelledby="grow-breadth-label">
          <button aria-label="Fewer branches" disabled={c.busy || c.breadth <= 3} onclick={() => (c.breadth = Math.max(3, c.breadth - 1))}><Icon name="minus" size={12} /></button>
          <span>{c.breadth}</span>
          <button aria-label="More branches" disabled={c.busy || c.breadth >= 7} onclick={() => (c.breadth = Math.min(7, c.breadth + 1))}><Icon name="plus" size={12} /></button>
        </div>
      </div>
      {#if c.aiAllowanceError}<p role="status">{c.aiAllowanceError}</p>{/if}
      <details>
        <summary>Audience and prompt preview</summary>
        <label for="grow-audience">Audience or purpose</label>
        <input id="grow-audience" class="field" placeholder="e.g. First-year biology students" bind:value={c.audience} disabled={c.busy}/>
        <label><input type="checkbox" bind:checked={c.inspectMapRepairs} /> Review the request before sending</label>
        {#if nodeTemplate}
          <details>
            <summary>What will be sent · The node, its path and its neighbours</summary>
            <p>{nodeTemplate.templateVersion}</p>
            <pre>{nodeTemplate.instructions}{'\n\n'}{nodeTemplate.prompt}</pre>
          </details>
        {/if}
      </details>
    {:else}
    <div class="row" style:margin-top={canTarget ? undefined : '0'}>
      <label for="topic">Topic</label>
      <input
        id="topic"
        class="wide"
        type="text"
        placeholder="e.g. Photosynthesis, Launching a podcast, The French Revolution"
        bind:this={topicEl}
        bind:value={c.topic}
        disabled={c.busy}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.isComposing && !readingSource) {
            e.preventDefault();
            generate();
          }
        }}
      />
    </div>
    <div class="row">
      <label for="style">Style</label>
      <input id="style" class="wide" type="text" placeholder="Optional: how should it look and feel?" bind:value={c.styleText} disabled={c.busy}
        onkeydown={(e) => {
          if (e.key === 'Enter' && !e.isComposing && !readingSource) {
            e.preventDefault();
            generate();
          }
        }} />
    </div>
    <div class="chips">
      {#each chips as ch (ch)}
        <button class="chip" class:on={c.styleText === ch} aria-pressed={c.styleText === ch} disabled={c.busy} onclick={() => (c.styleText = c.styleText === ch ? '' : ch)}>{ch}</button>
      {/each}
    </div>
    <div class="row">
      <span class="control-label" id="depth-label" title="Levels below the root. Default 3.">Depth</span>
      <div class="seg" role="group" aria-labelledby="depth-label" style="width:130px">
        {#each [2, 3, 4] as d (d)}<button class:on={c.depth === d} aria-pressed={c.depth === d} disabled={c.busy} onclick={() => (c.depth = d)}>{d}</button>{/each}
      </div>
      <span class="control-label" id="breadth-label" title="Maximum children per node. Default 5." style="width:auto;margin-left:14px">Breadth</span>
      <div class="stepper" role="group" aria-labelledby="breadth-label">
        <button aria-label="Fewer branches" disabled={c.busy || c.breadth <= 3} onclick={() => (c.breadth = Math.max(3, c.breadth - 1))}><Icon name="minus" size={12} /></button>
        <span>{c.breadth}</span>
        <button aria-label="More branches" disabled={c.busy || c.breadth >= 7} onclick={() => (c.breadth = Math.min(7, c.breadth + 1))}><Icon name="plus" size={12} /></button>
      </div>
    </div>
    <fieldset class="study">
      <label><input type="checkbox" bind:checked={c.generateStudy} disabled={c.busy}> Create a study skeleton with blanks</label>
      {#if c.generateStudy}
        <label>Share to blank <input type="number" min="5" max="90" bind:value={c.generateStudyShare} disabled={c.busy}>%</label>
      {/if}
    </fieldset>
    {#if c.aiAllowanceError}<p role="status">{c.aiAllowanceError}</p>{/if}
    <details>
      <summary>Source, audience and prompt preview</summary>
      <label for="audience">Audience or purpose</label>
      <input id="audience" class="field" placeholder="e.g. First-year biology students" bind:value={c.audience} disabled={c.busy}/>
      <label for="source">Source material</label>
      <textarea id="source" class="field" rows="3" value={c.sourceMaterial} disabled={readingSource}
        oninput={(event) => {
          c.setGenerationSource(event.currentTarget.value);
          event.currentTarget.value = c.sourceMaterial;
        }} placeholder="Paste text for the map to cover"></textarea>
      <label for="source-file">Add a text or Markdown source file</label>
      <input id="source-file" type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" disabled={readingSource}
        onchange={(event) => void loadSource(event.currentTarget)} />
      {#if c.sourceName}<p>Source file {c.sourceName}</p>{/if}
      {#if c.sourceTruncated}<p role="status">Source truncated to the first 64 KiB to leave room for generation.</p>{/if}
      {#if sourceError}<p role="alert">{sourceError}</p>{/if}
      <label><input type="checkbox" bind:checked={c.inspectMapRepairs} /> Review node expansion and repair requests before sending</label>
      <label><input type="checkbox" bind:checked={researchWeb} /> Research the web for this generation</label>
      <label><input type="checkbox" bind:checked={c.generateNotes} disabled={c.busy}/> Include explanatory notes</label>
      <details>
        <summary>What will be sent · Topic and supplied source</summary>
        <p>Web search {researchWeb ? 'live' : 'disabled'}</p>
        {#if !useFallback && (c.aiStatus?.available || !c.aiStatus?.fallbackAvailable)}
          <p>{template.templateVersion}</p>
          <pre>{template.instructions}{'\n\n'}{template.prompt}</pre>
        {/if}
        {#if c.aiStatus?.fallbackAvailable && template.execFallbackPrompt}
          <details open={useFallback || !c.aiStatus?.available}>
            <summary>JSON fallback prompt</summary>
            <pre>{template.execFallbackPrompt}</pre>
          </details>
        {/if}
      </details>
      {#each c.sentMapRepairs as repair, i}
        <details><summary>Submitted repair {i + 1}</summary><pre>{repair}</pre></details>
      {/each}
      {#if lastGeneration?.request}
        {@const request = lastGeneration.request}
        {@const usage = lastGeneration.usage}
        <details>
          <summary>Last generation · {request.templateVersion ?? 'Unversioned'}{lastGeneration.route === 'exec' ? ' · JSON fallback' : ''}</summary>
          {#if lastGeneration.endedAt !== undefined}
            <p>{((lastGeneration.endedAt - lastGeneration.startedAt) / 1000).toFixed(1)} s · {lastGeneration.nodesRejected} rejected · {usage ? `${usage.inputTokens?.toLocaleString() ?? 'Unreported'} input / ${usage.outputTokens?.toLocaleString() ?? 'unreported'} output tokens` : 'Usage not reported'}</p>
          {/if}
          <p>Web search {request.webSearch ? 'live' : 'disabled'}</p>
          <pre>{lastGeneration.route === 'exec' ? request.execFallbackPrompt : request.instructions + '\n\n' + request.prompt}</pre>
        </details>
      {/if}
    </details>
    {/if}
    {#if c.aiStatus && !c.aiStatus.available && c.aiStatus.error}
      <p role="status">{c.aiStatus.error}{c.aiStatus.fallbackAvailable ? ' Map generation will use JSON fallback.' : ''}</p>
      <button class="btn bordered" onclick={() => void c.refreshAiStatus()}>Check {aiChoice.label()} again</button>
    {/if}
    {#if c.aiStatus?.versionWarning}
      <p>{c.aiStatus.versionWarning}</p>
      {#if c.aiStatus.available && c.aiStatus.fallbackAvailable}
        <label><input type="checkbox" bind:checked={useFallback} disabled={c.busy} /> Use JSON fallback</label>
      {/if}
    {/if}
  {/if}
  {#if c.pendingMapRepair}
    <details open>
      <summary>What will be sent · Rejected map lines</summary>
      <pre>{c.pendingMapRepair.prompt}</pre>
      <button class="btn bordered" onclick={() => c.finishMapRepair(false)}>Keep valid nodes</button>
      <button class="btn primary" onclick={() => c.finishMapRepair(true)}>Send repair request</button>
    </details>
  {/if}
  <div class="actions">
    <div class="job">
      {#if c.gen}<span class="spinner"></span>{label}{#if c.gen.webSearch} · Web research{/if}{:else}<span><kbd>Return</kbd> to generate · one undo step</span>{/if}
    </div>
    {#if c.gen}
      <button class="btn bordered" onclick={() => void c.cancelAi()} disabled={c.gen.status === 'cancelling'}><Icon name="stop" size={12} /> Cancel</button>
    {:else}
      <button class="btn bordered" onclick={() => (c.showPrompt = false)}>Close</button>
      <button class="btn primary" disabled={!canGenerate || (!target && !c.topic.trim()) || readingSource} onclick={generate}><Icon name="sparkle" size={13} /> Generate</button>
    {/if}
  </div>
</div>

<style>
  .study{border:0;padding:0;margin:10px 0;display:flex;flex-wrap:wrap;gap:10px}
  .study input[type=number]{width:4em}
  .seg.target { flex: 1; }
  .prompt.running { width: min(360px, calc(100vw - 32px)); }
  .running .actions { margin-top: 0; }
  .prompt{max-height:calc(100dvh - 84px);overflow:auto}
  details{margin:8px 0}summary{cursor:pointer}details>label{display:block;margin:7px 0 3px}pre{max-height:12em;overflow:auto;white-space:pre-wrap;font-size:11px}
</style>
