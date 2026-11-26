<script lang="ts">
  import type { AiJobRecord, MapNode } from '../core/types';
  import { AI_PROMPT_LIMIT } from '../core/model/ai-provenance';
  import type { AppController } from './controller.svelte';
  import { EFFORT_LABELS, ENGINE_LABELS } from './ai-engine.svelte';

  let { c, node, openRefinement }: { c: AppController; node: MapNode; openRefinement: (job: AiJobRecord, prompt: string) => void } = $props();
  const original = $derived(node.origin?.by === 'ai' ? node.origin.job : undefined);
  const entries = $derived.by(() => {
    void c.rev;
    const ids = [...new Set([node.lastAiJob, original].filter((id): id is string => !!id))];
    return ids.flatMap((id) => {
      const jobs = c.doc.aiJobs;
      return jobs && Object.hasOwn(jobs, id) ? [{ id, job: jobs[id] }] : [];
    });
  });
  let editing = $state<string>();
  let draft = $state('');
  let topic = $state('');

  function canRerun(job: AiJobRecord): boolean {
    return job.kind === 'generate' || !!job.scopeId && !!c.doc.nodes[job.scopeId] &&
      (job.kind === 'expand' || /^refine\/\d+:/.test(job.templateVersion ?? ''));
  }

  function edit(id: string, job: AiJobRecord) {
    draft = job.prompt;
    topic = /^Topic: (.+)$/m.exec(job.prompt)?.[1] ?? node.text ?? c.doc.title;
    editing = id;
  }

  async function rerun(job: AiJobRecord) {
    if (!draft.trim() || !canRerun(job)) return;
    editing = undefined;
    if (job.kind === 'refine') openRefinement(job, draft);
    else await c.rerunTextJob(job, draft, topic || c.doc.title);
  }
</script>

{#if entries.length}
  <section class="sec" aria-label="AI provenance">
    <h4>AI provenance</h4>
    {#if node.sourceHeading}<p>Reported source heading: {node.sourceHeading}</p>{/if}
    {#each entries as { id, job } (id)}
      <details>
        <summary>{job.kind === 'generate' ? 'Map generation' : job.kind === 'expand' ? 'Node expansion' : 'Branch refinement'}</summary>
        {#if job.interrupted}<p>Interrupted. The work received so far was kept.</p>{/if}
        <dl>
          <dt>Engine</dt><dd>{job.route === 'replay' ? 'Replay preview' : ENGINE_LABELS[job.engine ?? 'codex']}</dd>
          <dt>Model</dt><dd>{job.model ?? 'Unreported'}</dd>
          <dt>Effort</dt><dd>{job.effort ? EFFORT_LABELS[job.effort] : 'Unreported'}</dd>
          <dt>Template</dt><dd>{job.templateVersion ?? 'Unversioned'}</dd>
          {#if job.webSearch !== undefined}<dt>Web search</dt><dd>{job.webSearch ? 'Live' : 'Disabled'}</dd>{/if}
          {#if job.warnings?.length}
            <dt>Validation warnings</dt><dd>{job.warnings.join(' · ')}</dd>
          {/if}
          <dt>Created</dt><dd><time datetime={job.created}>{new Date(job.created).toLocaleString()}</time></dd>
          <dt>Usage</dt>
          <dd>{job.usage ? `${job.usage.inputTokens?.toLocaleString() ?? 'Unreported'} input / ${job.usage.outputTokens?.toLocaleString() ?? 'unreported'} output tokens` : 'Usage not reported'}</dd>
        </dl>
        <details>
          <summary>Prompt</summary>
          <pre>{job.prompt}</pre>
          {#if job.instructions}
            <details><summary>Instructions</summary><pre>{job.instructions}</pre></details>
          {/if}
        </details>
        {#if editing === id}
          <label>
            Edit prompt for a new job
            <textarea bind:value={draft} maxlength={AI_PROMPT_LIMIT} rows="5"></textarea>
          </label>
          <div class="actions">
            <button class="btn bordered" onclick={() => (editing = undefined)}>Cancel</button>
            <button class="btn primary" disabled={c.busy || !draft.trim()} onclick={() => void rerun(job)}>
              {job.kind === 'generate' ? 'Generate new map' : job.kind === 'expand' ? 'Expand again' : 'Review prompt'}
            </button>
          </div>
        {:else if canRerun(job)}
          {#if job.interrupted && job.kind !== 'refine'}
            <button class="btn bordered" disabled={c.busy} onclick={() => void c.rerunTextJob(job, job.prompt, /^Topic: (.+)$/m.exec(job.prompt)?.[1] ?? node.text ?? c.doc.title)}>Retry generation</button>
          {/if}
          <button class="btn bordered" disabled={c.busy} onclick={() => edit(id, job)}>Edit and rerun</button>
        {/if}
      </details>
    {/each}
  </section>
{/if}

<style>
  h4 { margin: 0 0 6px; }
  details { margin: 6px 0; }
  summary { cursor: pointer; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; margin: 8px 0; }
  dt { color: var(--muted); }
  dd { margin: 0; overflow-wrap: anywhere; }
  pre { max-height: 13em; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  label { display: block; margin: 6px 0; }
  textarea { box-sizing: border-box; width: 100%; }
  .actions { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
</style>
