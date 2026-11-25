<script lang="ts">
  import AiQueuePanel from './AiQueuePanel.svelte';
  import AiChangeSummary from './AiChangeSummary.svelte';
  import { onDestroy } from 'svelte';
  import {
    applyRefinement, MAX_REFINEMENT_NODES, parseRefinement, refinementContext, refinementRequest, refineNames,
    type ChatScope, type ChatTurn, type RefineChange, type RefineContext, type RefineMode, type RefineProposal
  } from '../core/ai/refine';
  import { checkStudyAnswer, createStudyBlanks, fillStudyBlank } from '../core/ai/refine-study';
  import { AI_PROMPT_LIMIT, captureAiJob, parseAiJobRecord } from '../core/model/ai-provenance';
  import type { AiJobRecord, NodeId } from '../core/types';
  import type { AiEvent } from '../host/types';
  import type { AppController } from './controller.svelte';
  import { friendlyAiError } from './util';

  let { c }: { c: AppController } = $props();

  interface Run {
    mode: RefineMode;
    context: RefineContext;
    rev: number;
    id: string | null;
    cancelled: boolean;
    text: string;
    source: string;
    question: string;
    beforeId: AiEvent[];
    provenance: AiJobRecord;
    unsubscribe?: () => void;
    timer?: ReturnType<typeof setTimeout>;
  }

  const modes = Object.keys(refineNames) as RefineMode[];
  let dialog: HTMLDialogElement;
  let page = $state<'refine' | 'blanks'>('refine');
  let root = $state<NodeId | null>(null);
  let mode = $state<RefineMode>('regenerate');
  let instruction = $state('');
  let source = $state('');
  let chatScope = $state<ChatScope>('branch');
  let chatHistory = $state.raw<ChatTurn[]>([]);
  let pending = $state(false);
  let error = $state('');
  let status = $state('');
  let proposal = $state.raw<RefineProposal | null>(null);
  let active: Run | null = null;
  let reviewJob = '';
  let reviewRecord: AiJobRecord | undefined;
  let savedPrompt = $state<string>();
  let savedJob: AiJobRecord | undefined;
  let proposalRev = 0;
  let savedScope = $state.raw<RefineContext | null>(null);
  let share = $state(35);
  let answerVisible = $state(false);
  let checked = $state(false);

  const focus = $derived.by(() => {
    void c.rev;
    const node = c.focusId ? c.doc.nodes[c.focusId] : undefined;
    return node ? { id: node.id, text: node.text, blankAnswer: node.blankAnswer } : undefined;
  });
  const selectedRoot = $derived.by(() => {
    void c.rev;
    const node = root ? c.doc.nodes[root] : undefined;
    return node ? { text: node.text, note: node.note } : undefined;
  });
  const blankOps = $derived.by(() => {
    void c.rev;
    return page === 'blanks' && root ? createStudyBlanks(c.doc, root, share) : [];
  });
  const needsSource = $derived(mode === 'gaps' || mode === 'check');
  const canRequest = $derived(!c.busy && (savedPrompt !== undefined ? savedPrompt.trim() : (!needsSource || source.trim()) && (mode !== 'chat' || instruction.trim())));

  const requestPreview = $derived.by(() => {
    void c.rev;
    if (!root || page !== 'refine') return undefined;
    const scope = mode === 'chat' ? chatScope : mode === 'explain' ? 'node' : 'branch';
    const context = refinementContext(c.doc, root, scope);
    if (!context) return undefined;
    const request = refinementRequest(context, mode, instruction.trim(), source.trim(), mode === 'chat' ? chatHistory : []);
    if (savedPrompt !== undefined && savedJob) {
      request.prompt = savedPrompt;
      request.model = savedJob.route === 'replay' ? undefined : savedJob.model;
      request.effort = savedJob.effort ?? request.effort;
    }
    return { scope, context, request };
  });
  let lastRequest = $state.raw<typeof requestPreview>(undefined);
  const scopeLabel = (scope: ChatScope) => scope === 'node' ? 'Selected node' : scope === 'map' ? 'Whole map' : 'Selected branch';

  function show(next: typeof page, target: NodeId | null = c.focusId) {
    if (!target) return;
    root = target;
    lastRequest = undefined;
    savedPrompt = undefined;
    savedJob = undefined;
    page = next;
    mode = 'regenerate';
    instruction = '';
    source = '';
    chatScope = 'branch';
    chatHistory = [];
    proposal = null;
    error = '';
    status = '';
    dialog.showModal();
  }

  export function openSavedPrompt(job: AiJobRecord, prompt: string) {
    const refinement = job.templateVersion?.split(':')[1] as RefineMode | undefined;
    if (!refinement || !modes.includes(refinement) || !job.scopeId || !c.doc.nodes[job.scopeId]) return;
    show('refine', job.scopeId);
    mode = refinement;
    chatScope = job.scope ?? 'branch';
    savedPrompt = prompt;
    savedJob = job;
  }

  function reset(modeValue: RefineMode) {
    mode = modeValue;
    proposal = null;
    error = '';
    status = '';
  }

  function stop(run: Run) {
    clearTimeout(run.timer);
    run.unsubscribe?.();
    if (active === run) active = null;
    pending = false;
  }

  function cancel() {
    const run = active;
    if (!run) return;
    run.cancelled = true;
    stop(run);
    if (run.id) void c.host.aiCancel(run.id).catch(() => {});
    status = 'Refinement cancelled.';
  }

  function close() {
    cancel();
    dialog.close();
  }

  onDestroy(cancel);

  function eventFor(run: Run, event: AiEvent) {
    if (active !== run || event.kind === 'rateLimits') return;
    if (run.id === null) {
      // Some hosts start delivering immediately before the start promise resolves.
      if (run.beforeId.length < 256) run.beforeId.push(event);
      return;
    }
    if (event.jobId !== run.id) return;
    if (event.kind === 'started') {
      run.provenance = { ...run.provenance, route: event.route, model: event.model ?? run.provenance.model };
    } else if (event.kind === 'warning') {
      status = event.message;
    } else if (event.kind === 'delta') {
      if (run.text.length + event.text.length > 300_000) {
        cancel();
        error = 'The proposal was too large. Try a smaller branch.';
      } else run.text += event.text;
    } else if (event.kind === 'cancelled') {
      stop(run);
      status = 'Refinement cancelled.';
    } else if (event.kind === 'error') {
      stop(run);
      error = friendlyAiError(event.code, event.message, c.aiStatus?.rateLimits);
    } else if (event.kind === 'done') {
      stop(run);
      const text = event.text ?? run.text;
      if (text.length > 300_000) {
        error = 'The proposal was too large. Try a smaller branch.';
        return;
      }
      if (c.rev !== run.rev || c.doc.id !== run.context.docId) {
        error = 'The map changed during refinement. Run it again to use the current branch.';
        return;
      }
      try {
        const read = parseRefinement(text, run.mode, run.context, c.doc, event.jobId, run.source);
        if (read.rejected.length) console.warn('Radiant rejected AI refinement items', read.rejected);
        proposal = read;
        reviewJob = event.jobId;
        reviewRecord = { ...run.provenance, status: 'done', usage: event.usage };
        proposalRev = run.rev;
        savedScope = run.context;
        if (read.reply) {
          chatHistory = [...chatHistory, { question: run.question, reply: read.reply, quotes: read.quotes ?? [] }];
          instruction = '';
        }
        status = read.changes.length || read.questions.length || read.reply ? '' : 'There are no changes to review.';
      } catch {
        error = 'Radiant could not read this proposal. Try again.';
      }
    }
  }

  async function request() {
    if (!root || active || !canRequest) return;
    if (c.aiAllowanceError) { error = c.aiAllowanceError; return; }
    const preview = requestPreview;
    if (!preview) {
      error = 'Select a branch of at most ' + MAX_REFINEMENT_NODES + ' nodes.';
      return;
    }
    const { scope, context, request } = preview;
    const question = instruction.trim();
    const provenance = parseAiJobRecord({ ...captureAiJob('refine', request, root), scope });
    if (!provenance) {
      error = 'The refinement prompt is too large to store with the map.';
      return;
    }
    reset(mode);
    const run: Run = {
      mode, context, rev: c.rev, id: null, cancelled: false, text: '', source: source.trim(), question, beforeId: [], provenance
    };
    active = run;
    pending = true;
    run.timer = setTimeout(() => {
      if (active !== run) return;
      cancel();
      error = 'The proposal timed out. Try again.';
    }, 120_000);
    try {
      const unsubscribe = await c.host.onAiEvent((event) => eventFor(run, event));
      if (run.cancelled) {
        unsubscribe();
        return;
      }
      run.unsubscribe = unsubscribe;
      if (c.rev !== run.rev || c.doc.id !== context.docId) {
        stop(run);
        error = 'The map changed. Review the updated request and try again.';
        return;
      }
      run.id = await c.host.aiStartTurn(request);
      lastRequest = preview;
      c.trackAiJob(run.id, 'refine');
      if (run.cancelled) {
        await c.host.aiCancel(run.id);
        return;
      }
      for (const event of run.beforeId) eventFor(run, event);
      run.beforeId = [];
    } catch {
      if (active === run) {
        stop(run);
        error = 'The AI job could not be started.';
      }
    }
  }

  function discard(index: number) {
    if (proposal) proposal = { ...proposal, changes: proposal.changes.filter((_, i) => i !== index) };
  }

  function accept(change: RefineChange, index: number) {
    if (c.editor.defer(() => {
      const current = proposal?.changes.indexOf(change) ?? -1;
      if (current >= 0) accept(change, current);
    })) return;
    if (c.rev !== proposalRev || c.doc.id !== savedScope?.docId) {
      error = 'The map changed after this proposal. Run refinement again.';
      return;
    }
    const tx = applyRefinement(c.doc, change, reviewJob);
    if (!tx.ops.length) {
      discard(index);
      status = 'The proposal no longer changes the map.';
      return;
    }
    try {
      if (reviewRecord) {
        tx.ops = tx.ops.map((op) => op.t === 'set'
          ? { ...op, patch: { ...op.patch, lastAiJob: reviewJob } }
          : op);
        if (!Object.hasOwn(c.doc.aiJobs ?? {}, reviewJob)) tx.ops.unshift({ t: 'aiJob', id: reviewJob, value: reviewRecord });
      }
      c.applyAiRefinement(tx, reviewJob);
      proposalRev = c.rev;
      status = 'Applied. One Undo restores the previous branch.';
      discard(index);
      const added = tx.ops.flatMap((op) => op.t === 'insert' ? [op.node.id] : []);
      if (added.length) c.select(added);
    } catch {
      error = 'The proposal could not be applied. The map was restored.';
    }
  }

  function makeBlanks() {
    if (!root || !blankOps.length) return;
    const first = blankOps[0];
    c.editor.apply({ ops: blankOps, label: 'Create Study Blanks', source: 'user' });
    if (first.t === 'set') c.select([first.id]);
    close();
  }

  function fillBlank(id: NodeId, reveal: boolean) {
    const op = fillStudyBlank(c.doc, id, reveal);
    if (!op) return;
    c.editor.apply({ ops: [op], label: reveal ? 'Reveal Study Answer' : 'Keep Study Label', source: 'user' });
  }

  const focusedId = $derived(focus?.id);

  $effect(() => {
    void focusedId;
    answerVisible = false;
    checked = false;
  });
</script>

{#if focus}
  <div class="launch">
    <button class="btn bordered" onclick={() => show('refine')}>Refine branch</button>
    <button class="btn bordered" onclick={() => show('blanks')}>Create study blanks</button>
    {#if focus.blankAnswer !== undefined}
      <div class="blank">
        <strong>Study blank</strong>
        <p>Type a label on the map before checking your answer.</p>
        <button class="btn bordered" disabled={!focus.text.trim()} onclick={() => { checked = true; }}>Check</button>
        <button class="btn bordered" onclick={() => (answerVisible = !answerVisible)}>{answerVisible ? 'Hide answer' : 'Show answer'}</button>
        {#if checked}<p role="status">{checkStudyAnswer(focus.text, focus.blankAnswer) ? 'Matches the stored answer.' : 'Differs from the stored answer.'}</p>{/if}
        {#if answerVisible}
          <p><strong>{focus.blankAnswer}</strong></p>
          <button class="btn bordered" onclick={() => fillBlank(focus!.id, true)}>Use answer as label</button>
          {#if focus.text.trim()}<button class="btn bordered" onclick={() => fillBlank(focus!.id, false)}>Keep my label</button>{/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<dialog bind:this={dialog} aria-labelledby="refine-heading"
  onkeydown={(event) => event.stopPropagation()} onkeyup={(event) => event.stopPropagation()}
  oncancel={(event) => { event.preventDefault(); close(); }}>
  <header>
    <div>
      <h2 id="refine-heading">{page === 'refine' ? 'Refine branch' : 'Create study blanks'}</h2>
      <p>{selectedRoot?.text || 'Selected branch'}</p>
    </div>
    <button class="btn bordered" onclick={close}>Close</button>
  </header>
  {#if page === 'blanks'}
    <p>Remove labels from part of this branch and store their answers. Select a blank node to check or reveal its answer.</p>
    <label>Share of nodes to blank
      <span><input type="number" min="1" max="90" bind:value={share}>%</span>
    </label>
    <p role="status">{blankOps.length} {blankOps.length === 1 ? 'label' : 'labels'} to blank.</p>
    <button class="btn primary" disabled={!blankOps.length} onclick={makeBlanks}>Create blanks</button>
  {:else}
    {#if savedPrompt !== undefined}
      <label>Saved {refineNames[mode].toLowerCase()} prompt
        <textarea class="field" rows="8" bind:value={savedPrompt} maxlength={AI_PROMPT_LIMIT} disabled={pending}></textarea>
      </label>
    {:else}
    <label>Refinement
      <select disabled={pending} value={mode} onchange={(event) => reset(event.currentTarget.value as RefineMode)}>
        {#each modes as option (option)}
          <option value={option}>{refineNames[option]}</option>
        {/each}
      </select>
    </label>
    {#if mode === 'chat'}
      <label>Chat scope
        <select value={chatScope} disabled={pending} onchange={(event) => {
          chatScope = event.currentTarget.value as ChatScope;
          chatHistory = [];
          reset('chat');
        }}>
          <option value="node">Selected node</option>
          <option value="branch">Selected branch</option>
          <option value="map">Whole map</option>
        </select>
      </label>
    {/if}
    <label>{mode === 'chat' ? 'Question' : 'Instruction (optional)'}
      <input type="text" bind:value={instruction} maxlength="1000" disabled={pending}>
    </label>
    {#if needsSource || mode === 'chat'}
      <label>{mode === 'chat' ? 'Source material (optional)' : 'Source material'}
        <textarea class="field" rows="4" bind:value={source} maxlength="18000" disabled={pending}></textarea>
      </label>
    {:else if mode === 'questions'}
      <p>Use these questions after practising free recall from the branch.</p>
    {/if}
    {/if}
    {#if requestPreview}
      <details>
        <summary>What will be sent · {scopeLabel(requestPreview.scope)}</summary>
        <pre>{requestPreview.request.instructions}{'\n\n'}{requestPreview.request.prompt}</pre>
      </details>
    {/if}
    {#if lastRequest}
      <details>
        <summary>Last request sent · {scopeLabel(lastRequest.scope)}</summary>
        <pre>{lastRequest.request.instructions}{'\n\n'}{lastRequest.request.prompt}</pre>
      </details>
    {/if}
    {#if c.aiAllowanceError}<p role="status">{c.aiAllowanceError}</p>{/if}
    <div class="actions">
      {#if pending}
        <span class="muted" role="status">Preparing proposal…</span>
        <button class="btn bordered" onclick={cancel}>Cancel job</button>
      {:else}
        <button class="btn primary" disabled={!canRequest || !!c.aiAllowanceError} onclick={() => void request()}>
          {mode === 'questions' ? 'Generate questions' : mode === 'chat' ? 'Ask' : mode === 'check' ? 'Compare draft' : 'Get proposal'}
        </button>
      {/if}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if status}<p role="status">{status}</p>{/if}
    <AiQueuePanel {c} embedded />
    <AiChangeSummary {c} />
    {#if proposal?.rejected.length}
      <details><summary>{proposal.rejected.length} issues in the proposal</summary>
        <ul>{#each proposal.rejected as issue (issue)}<li>{issue}</li>{/each}</ul>
      </details>
    {/if}
    {#if mode === 'chat' && chatHistory.length}
      <ol class="proposals" aria-label="Conversation">
        {#each chatHistory as turn, i (i)}
          <li class="proposal">
            <strong>{turn.question}</strong>
            <p class="detail">{turn.reply}</p>
            {#if turn.quotes.length}
              <strong>Excerpts from your source</strong>
              {#each turn.quotes as quote}<blockquote>{quote}</blockquote>{/each}
            {/if}
          </li>
        {/each}
      </ol>
      <details>
        <summary>Context sent · {savedScope?.input.length ?? 0} {savedScope?.input.length === 1 ? 'node' : 'nodes'}</summary>
        <ul>{#each savedScope?.input ?? [] as row (row.id)}<li>{row.title || 'Blank node'}</li>{/each}</ul>
      </details>
    {/if}
    {#if proposal?.questions.length}
      <ol class="proposals">
        {#each proposal.questions as question (question.id)}
          <li class="proposal">
            <strong>{question.question}</strong>
            <details><summary>Reveal source node</summary>{savedScope?.input.find((row) => row.id === question.id)?.title || 'Blank study node'}</details>
          </li>
        {/each}
      </ol>
    {/if}
    {#if proposal?.changes.length}
      <ul class="proposals">
        {#each proposal.changes as change, i (change)}
          <li class="proposal">
            <strong>{change.label}</strong>
            {#if mode === 'explain' && selectedRoot?.note}
              <p class="muted">Replace the existing note by accepting this proposal.</p>
              <details><summary>Existing note</summary><p>{selectedRoot.note}</p></details>
            {/if}
            {#if change.detail}<p class="detail">{change.detail}</p>{/if}
            <div class="columns">
              {#if change.removes?.length}
                <div><strong>Remove ({change.removes.length})</strong><ul>
                  {#each change.removes as title}<li>{title || 'Blank node'}</li>{/each}
                </ul></div>
              {/if}
              {#if change.adds?.length}
                <div><strong>Add ({change.adds.length})</strong><ul>
                  {#each change.adds as title}<li>{title}</li>{/each}
                </ul></div>
              {/if}
            </div>
            {#if mode !== 'explain' && change.edits?.length}
              <strong>Edit ({change.edits.length})</strong><ul>
                {#each change.edits as title}<li>{title}</li>{/each}
              </ul>
            {/if}
            <div class="actions">
              <button class="btn primary" onclick={() => accept(change, i)}>
                {mode === 'explain' && selectedRoot?.note ? 'Replace note' : 'Accept'}
              </button>
              <button class="btn bordered" onclick={() => discard(i)}>Discard</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</dialog>

<style>
  .launch { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .blank { border-top: 1px solid var(--line); padding-top: 8px; flex-basis: 100%; }
  dialog {
    width: min(630px, calc(100vw - 38px));
    box-sizing: border-box;
    max-height: calc(100dvh - 38px);
    padding: 22px;
    border: 1px solid var(--line);
    border-radius: 14px;
    color: var(--text);
    background: var(--panel-solid);
    box-shadow: var(--shadow);
  }
  dialog::backdrop { background: rgb(0 0 0 / 48%); }
  header { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
  header p { color: var(--text-dim); margin: 4px 0 12px; overflow-wrap: anywhere; }
  h2 { margin: 0; font-size: 1.24rem; }
  label { display: grid; gap: 4px; margin: 10px 0; }
  input, select, textarea { color: var(--text); background: var(--field); font: inherit; border: 1px solid var(--line-strong); border-radius: 5px; padding: 6px; }
  input[type=number] { width: 6em; margin-right: 4px; }
  .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
  .error { color: var(--danger); }
  .muted { color: var(--text-dim); }
  .proposals { padding-left: 0; list-style: none; }
  .proposal { background: var(--field); padding: 10px; border: 1px solid var(--line); border-radius: 6px; margin: 10px 0; overflow-wrap: anywhere; }
  .detail { white-space: pre-wrap; }
  .columns { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; }
  .columns > div { flex: 1 1 155px; }
  details { margin: 8px 0; }
  summary { cursor: pointer; }
</style>
