<script lang="ts">
  import AiQueuePanel from './AiQueuePanel.svelte';
  import type { AiJobKind } from '../core/ai/jobs';
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();
  let displayHz = $state<number | null>(null);
  let systemCap = $state(false);
  const frameBudget = $derived(Math.max(c.stats.refreshMs, displayHz ? 1000 / displayHz : 0, systemCap ? 1000 / 60 : 0));
  $effect(() => {
    if (!c.showStats || c.isBrowser) return;
    let active = true;
    const read = () => {
      void c.host.platformInfo().then((info) => {
        if (!active) return;
        displayHz = info.displayHz ?? null;
        systemCap = info.os === 'macos' && !info.highRefreshEnabled;
      }).catch(() => {});
    };
    read();
    const timer = window.setInterval(read, 2000);
    return () => { active = false; clearInterval(timer); };
  });
  const ai = $derived(c.aiStatus);
  const usage = $derived.by(() => {
    const r = ai?.capabilities?.rateLimits ? ai.rateLimits : undefined;
    if (!r) return '';
    const parts: string[] = [];
    if (r.planType) parts.push(r.planType.charAt(0).toUpperCase() + r.planType.slice(1));
    for (const window of ['primary', 'secondary'] as const) {
      const used = r[`${window}UsedPercent`];
      if (used === undefined) continue;
      const mins = r[`${window}WindowMinutes`];
      const reset = r[`${window}ResetsAt`] ?? (window === 'primary' ? r.resetsAt : undefined);
      const duration = mins === 10080 ? 'weekly window' : mins ? `${mins / 60} h window` : `${window} window`;
      const date = reset ? new Date(reset) : undefined;
      parts.push(`${Math.round(Math.max(0, Math.min(100, 100 - used)))}% remaining in ${duration}${date && Number.isFinite(date.getTime()) ? ` (resets ${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })})` : ''}`);
    }
    return parts.join(' · ');
  });
  const sessionTokens = $derived.by(() => {
    const measured = Object.values(c.jobs).flatMap((job) => job.usage ? [job.usage] : []);
    if (!measured.length) return '';
    const total = (field: 'inputTokens' | 'outputTokens') => {
      const counts = measured.flatMap((job) => job[field] === undefined ? [] : [job[field]]);
      return counts.length ? counts.reduce((sum, count) => sum + count, 0).toLocaleString() : 'unreported';
    };
    return `${total('inputTokens')} in / ${total('outputTokens')} out`;
  });
  const recentJobs = $derived(Object.values(c.jobs).filter(job => job.endedAt !== undefined)
    .sort((a, b) => b.endedAt! - a.endedAt!).slice(0, 8));
  const activities: Record<AiJobKind, string> = {
    generate: 'Map generation', expand: 'Branch expansion', refine: 'Refinement',
    svg: 'SVG artwork', image: 'Picture artwork', other: 'AI request'
  };
  const aiText = $derived.by(() => {
    if (!ai) return 'Checking AI…';
    if (ai.provider === 'replay') return 'AI replay preview';
    if (!ai.available && ai.fallbackAvailable) return 'AI ready for JSON map generation';
    if (c.aiAllowanceError) return c.aiAllowanceError;
    if (ai.available) return `AI ready${ai.version ? ' · ' + ai.version : ''}`;
    return ai.error ? `AI off: ${ai.error}` : 'AI unavailable';
  });
  const sel = $derived.by(() => {
    void c.rev;
    void c.selTick;
    const n = c.selIds.length;
    const total = Object.keys(c.doc.nodes).length;
    return `${total.toLocaleString()} node${total === 1 ? '' : 's'}${n ? ` · ${n} selected` : ''}`;
  });
</script>

<footer class="status" bind:offsetHeight={c.statusBarHeight}>
  <span title={ai?.versionWarning ?? ai?.error ?? ''}>
    <span class="dot" class:ok={ai?.available || ai?.fallbackAvailable || c.isBrowser} class:warn={!ai?.available && !ai?.fallbackAvailable && !c.isBrowser}></span>{aiText}{usage ? ' · ' + usage : ''}
  </span>
  <AiQueuePanel {c} />
  <span>{sel}</span>
  {#if c.agent.session}
    {@const live = c.agent.session}
    <span class="agent-live" title={c.agent.status}>
      <span class="dot ok"></span>{live.client ?? 'Agent'} connected · {live.destructive ? 'can edit and delete' : live.writable ? 'can edit' : 'read only'}
      <button class="btn bordered" onclick={() => c.agent.revoke('Agent access stopped.')}>Stop</button>
    </span>
  {/if}
  {#if recentJobs.length}
    <details class="ai-usage">
      <summary aria-label="AI usage and recent jobs">{sessionTokens ? `${sessionTokens} tokens` : 'AI usage'}</summary>
      <section aria-label="Recent AI jobs">
        <strong>Reported tokens this session</strong>
        <p>{sessionTokens ? `${sessionTokens} tokens` : 'Usage not reported'}</p>
        <ol>
          {#each recentJobs as job (job.id)}
            <li>
              <strong>{activities[job.kind]}</strong>
              <small>{job.status === 'done' ? 'Completed' : job.status === 'cancelled' ? 'Cancelled' : job.error?.code === 'stream_interrupted' ? 'Interrupted' : 'Failed'} · {((job.endedAt! - job.startedAt) / 1000).toFixed(1)} s</small>
              <small>{job.usage ? `${job.usage.inputTokens?.toLocaleString() ?? 'Unreported'} input / ${job.usage.outputTokens?.toLocaleString() ?? 'unreported'} output tokens` : 'Usage not reported'}</small>
            </li>
          {/each}
        </ol>
      </section>
    </details>
  {/if}
  <span class="sp"></span>
  {#if c.showStats}
    <span class="mono">{c.stats.fps} fps{displayHz ? ' · ' + displayHz + ' Hz display maximum' : ''} · {frameBudget.toFixed(1)} ms/frame budget · cpu {c.stats.cpu.toFixed(1)} ms · {c.stats.draws} draws · {c.stats.labels} labels · layout {c.stats.layoutMs.toFixed(1)} ms · {c.stats.nodes.toLocaleString()} visible</span>
  {/if}
  {#if c.reviewTimerDeadline}
    <button title="Stop the mapping timer" onclick={() => c.stopReviewTimer()}>Stop mapping timer</button>
  {/if}
  <span>{c.saveText}</span>
  <button title="Show or hide performance stats" onclick={() => c.toggleStats()}>{c.showStats ? 'Hide stats' : 'Stats'}</button>
</footer>


<style>
  .agent-live { display: inline-flex; align-items: center; gap: 6px; color: var(--text); }
  .agent-live .dot { margin-right: 0; }
  .agent-live button { height: 18px; padding: 0 7px; border: 1px solid var(--line-strong); border-radius: 5px; }
  .ai-usage { position: relative; }
  .ai-usage summary { cursor: pointer; }
  .ai-usage section {
    position: absolute;
    bottom: calc(100% + 12px);
    left: 0;
    z-index: 10;
    width: 230px;
    max-height: 45vh;
    overflow: auto;
    padding: 10px 12px;
    color: var(--text);
    background: var(--panel-solid);
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    box-shadow: var(--shadow);
  }
  .ai-usage p { margin: 2px 0 8px; }
  .ai-usage ol { margin: 0; padding: 0; list-style: none; }
  .ai-usage li { padding: 5px 0; }
  .ai-usage small { display: block; color: var(--text-dim); }
</style>
