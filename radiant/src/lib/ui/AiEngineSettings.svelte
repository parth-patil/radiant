<script lang="ts">
  import type { AiEffort, AiEngine } from '../core/ai/provider';
  import { EXPAND_GUIDANCE_LIMIT } from '../core/ai/prompts';
  import { AI_ENGINES, EFFORT_LABELS, aiChoice, isAiEffort, validModelId } from './ai-engine.svelte';
  import type { AppController } from './controller.svelte';
  import { friendlyAiError } from './util';

  let { c }: { c: AppController } = $props();
  const CUSTOM = ' custom';

  const engine = $derived(aiChoice.engine);
  const info = $derived(aiChoice.info(engine));
  const pick = $derived(aiChoice.picks[engine]);
  const listed = $derived(!!pick.model && !!info?.models.some((model) => model.id === pick.model));
  /** The user is typing a full model id (engines that accept any model name). */
  let typing = $state(false);
  let typed = $state('');
  let typedError = $state('');
  const custom = $derived(!!info?.customModels && (typing || (!!pick.model && !listed)));
  const automaticModel = $derived.by(() => {
    const model = aiChoice.model(engine, undefined);
    return model?.label ?? info?.defaultModel ?? 'the engine default';
  });
  const efforts = $derived(aiChoice.efforts(engine, pick.model));
  const automaticEffort = $derived(aiChoice.automaticEffort(engine));
  const problem = $derived(info && (!info.installed || info.error)
    ? info.error || friendlyAiError(info.errorCode ?? 'not_installed', '', undefined, engine) : '');

  function status(name: AiEngine): string {
    const item = aiChoice.info(name);
    if (!item) return aiChoice.engines ? 'Not reported' : 'Checking…';
    if (!item.installed) return 'Not installed';
    if (item.errorCode === 'not_logged_in') return 'Not signed in' + (item.version ? ' · ' + item.version : '');
    return 'Installed' + (item.version ? ' · ' + item.version : '');
  }

  function chooseEngine(name: AiEngine) {
    typing = false;
    typedError = '';
    aiChoice.setEngine(name);
  }

  function chooseModel(value: string) {
    typedError = '';
    if (value === CUSTOM) {
      typing = true;
      typed = pick.model && !listed ? pick.model : '';
      return;
    }
    typing = false;
    aiChoice.setModel(engine, value || undefined);
  }

  function commitTyped() {
    const id = typed.trim();
    if (!id) { typedError = ''; aiChoice.setModel(engine, undefined); typing = false; return; }
    if (!validModelId(id)) { typedError = 'Use the full model name without spaces or quotes.'; return; }
    typedError = '';
    aiChoice.setModel(engine, id);
  }

  function chooseEffort(value: string) {
    aiChoice.setEffort(engine, isAiEffort(value) ? value as AiEffort : undefined);
  }

  // The expansion guidance: a local draft, saved shortly after typing stops and on leaving the field.
  let draft = $state(aiChoice.expandGuidance);
  let editing = $state(false);
  let saveTimer = 0;
  $effect(() => {
    const saved = aiChoice.expandGuidance;
    if (!editing) draft = saved;
  });
  function onDraft() {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => aiChoice.setGuidance(draft), 400);
  }
  function leaveDraft() {
    clearTimeout(saveTimer);
    aiChoice.setGuidance(draft);
    editing = false;
    draft = aiChoice.expandGuidance;
  }
  function resetDraft() {
    clearTimeout(saveTimer);
    aiChoice.setGuidance('');
    draft = aiChoice.expandGuidance;
  }
</script>

<details class="ai-engine" ontoggle={(event) => { if (event.currentTarget.open) void c.refreshAiEngines(); }}>
  <summary>AI engine</summary>
  {#if aiChoice.sample}
    <p class="note" role="note">Preview: these engines are sample data. The desktop app lists what is installed on this computer.</p>
  {/if}
  {#if aiChoice.listError}<p class="warn" role="status">{aiChoice.listError}</p>{/if}

  <fieldset>
    <legend>Engine</legend>
    {#each AI_ENGINES as name (name)}
      <label class="engine">
        <input type="radio" name="ai-engine" value={name} checked={engine === name} onchange={() => chooseEngine(name)} />
        <span class="engine-text">
          <span>{aiChoice.label(name)}</span>
          <small>{status(name)}</small>
        </span>
      </label>
    {/each}
  </fieldset>
  {#if problem}
    <p class="warn" role="status">{problem} Until then, AI text actions are off.</p>
  {/if}
  {#if engine === 'antigravity'}
    <p class="note" role="note">Antigravity cannot be started without its tools (files, commands, browser). Radiant blocks every tool call it makes. Each request is also kept in Antigravity's own conversation history.</p>
  {/if}

  <label class="stack">Model
    <select aria-label="Model" value={custom ? CUSTOM : pick.model ?? ''} onchange={(event) => chooseModel(event.currentTarget.value)}>
      <option value="">Automatic ({automaticModel})</option>
      {#each info?.models ?? [] as model (model.id)}
        <option value={model.id}>{model.label}</option>
      {/each}
      {#if pick.model && !listed && !info?.customModels}
        <option value={pick.model}>{pick.model} (not listed)</option>
      {/if}
      {#if info?.customModels}<option value={CUSTOM}>Other model…</option>{/if}
    </select>
  </label>
  {#if custom}
    <label class="stack">Full model name
      <input type="text" aria-label="Full model name" spellcheck="false" autocomplete="off" maxlength="128"
        placeholder="For example claude-sonnet-5-5" value={typing ? typed : pick.model ?? ''}
        oninput={(event) => { typing = true; typed = event.currentTarget.value; }}
        onchange={commitTyped} onkeydown={(event) => { if (event.key === 'Enter') commitTyped(); }} />
    </label>
    {#if typedError}<p class="warn" role="alert">{typedError}</p>{/if}
  {/if}

  <label class="stack">Effort
    <select aria-label="Effort" value={pick.effort && efforts.includes(pick.effort) ? pick.effort : ''} disabled={!efforts.length}
      onchange={(event) => chooseEffort(event.currentTarget.value)}>
      <option value="">Automatic{automaticEffort ? ` (${EFFORT_LABELS[automaticEffort]})` : ''}</option>
      {#each efforts as effort (effort)}<option value={effort}>{EFFORT_LABELS[effort]}</option>{/each}
    </select>
  </label>
  {#if !efforts.length}<p class="note">This model has no effort setting.</p>{/if}
  <p class="note">Pictures are always drawn with Codex.</p>

  <label class="stack" for="expand-guidance">Expansion prompt{aiChoice.guidance ? ' (customised)' : ''}</label>
  <textarea id="expand-guidance" class="field" rows="7" maxlength={EXPAND_GUIDANCE_LIMIT} spellcheck="true" bind:value={draft}
    onfocus={() => (editing = true)} oninput={onDraft} onblur={leaveDraft}></textarea>
  <div class="row">
    <small>{draft.length.toLocaleString()} / {EXPAND_GUIDANCE_LIMIT.toLocaleString()} characters</small>
    <button class="btn bordered" type="button" disabled={!aiChoice.guidance} onclick={resetDraft}>Reset to default</button>
  </div>
  <p class="note">The output format, the rules that keep new nodes under the right parent and count, the title rules and the example are always added after this text.</p>
</details>

<style>
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  fieldset { border: 0; margin: 6px 0; padding: 0; min-width: 0; }
  legend, .stack { font-size: 11px; font-weight: 600; color: var(--text-dim); }
  legend { padding: 0; margin-bottom: 4px; }
  .engine { display: flex; align-items: flex-start; gap: 6px; margin: 4px 0; font-size: 12px; }
  .engine input { margin: 2px 0 0; flex: none; }
  .engine-text { display: flex; flex-direction: column; min-width: 0; }
  .engine-text small { color: var(--text-dim); font-size: 11px; overflow-wrap: anywhere; }
  .stack { display: flex; flex-direction: column; gap: 4px; margin: 8px 0 4px; }
  .stack select, .stack input, textarea { width: 100%; min-width: 0; box-sizing: border-box; font-weight: 400; color: var(--text); }
  select { text-overflow: ellipsis; }
  textarea { min-height: 120px; font-size: 12px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 4px 0; }
  .row small { color: var(--text-dim); font-size: 11px; }
  .note, .warn { font-size: 11px; line-height: 1.4; margin: 4px 0; color: var(--text-dim); }
  .warn { color: var(--danger); }
</style>
