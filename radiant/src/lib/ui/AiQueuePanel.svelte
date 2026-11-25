<script lang="ts">
  import type { AiQueueJob } from '../core/ai/provider';
  import type { AppController } from './controller.svelte';

  let { c, embedded = false }: { c: AppController; embedded?: boolean } = $props();
  const names: Record<AiQueueJob['activity'], string> = {
    generate: 'Map generation', expand: 'Branch expansion', refine: 'Refinement',
    svg: 'SVG artwork', picture: 'Picture artwork', text: 'Text request'
  };
  const jobs = $derived(c.aiQueue?.jobs ?? []);
  const running = $derived(jobs.filter((job) => job.state === 'running').length);
</script>

{#if jobs.length}
  <details>
    <summary aria-label="AI job queue">
      {running} running · {jobs.length - running} queued
    </summary>
    <section class:embedded aria-label="AI job queue">
      <strong>AI jobs</strong>
      <p>{c.aiQueue?.limit} simultaneous jobs maximum</p>
      <ol>
        {#each jobs as job (job.id)}
          <li>
            <span>{names[job.activity]}<small>{job.state === 'running' ? 'Running' : 'Queued'}{job.owned ? '' : ' · Other window'}</small></span>
            {#if job.owned}
              <button class="btn bordered" aria-label={`Cancel ${names[job.activity]}`} onclick={() => void c.cancelQueuedAi(job.id)}>Cancel</button>
            {/if}
          </li>
        {/each}
      </ol>
    </section>
  </details>
{/if}

<style>
  details { position: relative; }
  summary { cursor: pointer; color: var(--text); }
  section {
    position: absolute;
    bottom: calc(100% + 12px);
    left: 0;
    z-index: 10;
    width: 240px;
    max-height: 45vh;
    overflow: auto;
    padding: 10px 12px;
    background: var(--panel-solid);
    color: var(--text);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    box-shadow: var(--shadow);
    font-size: 13px;
  }
  .embedded { position: static; width: auto; max-height: 200px; }
  p { margin: 2px 0 8px; }
  ol { margin: 0; padding: 0; list-style: none; }
  li { display: flex; align-items: center; gap: 10px; justify-content: space-between; padding: 4px 0; }
  small { display: block; color: var(--text-dim); }
</style>
