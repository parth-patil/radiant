<script lang="ts">
  import { onMount } from 'svelte';
  import { getHost } from '../host';
  import type { DisplayInfo, PresenterCommand, PresenterState } from '../host/types';
  import './app.css';
  import { getSetting, setSetting } from './settings';

  // Presenter console (implementation spec 6.3, PRS-40 to 44). A DOM-only window: it never loads the document or
  // the render pipeline. The document window sends the talk's state when the step changes; this window sends
  // next, previous and jump back. Its clocks tick here, in the DOM, so the audience canvas never redraws for them.

  const host = getHost();
  let talk = $state.raw<PresenterState | null>(null);
  let now = $state(Date.now());
  /** When the step on screen arrived, by this window's clock. */
  let stepSince = $state(Date.now());
  let digits = $state('');
  let displays = $state.raw<DisplayInfo[]>([]);
  let display = $state('');
  let protectedView = $state(true);
  let rehearsing = $state(false);
  let lastRun = $state.raw<Record<string, number>>({});
  let error = $state('');
  let dark = $state(typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);

  // Times of the run being rehearsed, by step id (PRS-44).
  let runTimes: Record<string, number> = {};
  let shown: { id: string; at: number } | null = null;

  const current = $derived(talk && talk.current > 0 ? talk.steps[talk.current - 1] : undefined);
  const total = $derived(talk?.steps.length ?? 0);

  /** Time budget of every step: its own seconds, else an even share of what the target leaves. */
  const budgets = $derived.by(() => {
    if (!talk) return [] as (number | undefined)[];
    const own = talk.steps.map((s) => s.seconds);
    const target = talk.targetMinutes ? talk.targetMinutes * 60 : undefined;
    const fixed = own.reduce<number>((sum, s) => sum + (s ?? 0), 0);
    const open = own.filter((s) => s === undefined).length;
    const share = target !== undefined && open ? Math.max(0, target - fixed) / open : undefined;
    return own.map((s) => s ?? share);
  });
  const planned = $derived(budgets.length && budgets.every((b) => b !== undefined) ? budgets.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined);

  const elapsed = $derived(talk?.active && talk.startedAt ? Math.max(0, (now - talk.startedAt) / 1000) : 0);
  const onStep = $derived(talk?.active ? Math.max(0, (now - stepSince) / 1000) : 0);
  const stepBudget = $derived(talk && talk.current > 0 ? budgets[talk.current - 1] : undefined);

  /** Ahead (negative) or behind (positive) the plan, in seconds; 0 while inside the current step's budget. */
  const pace = $derived.by(() => {
    if (!talk?.active || planned === undefined || !talk.current) return null;
    const before = budgets.slice(0, talk.current - 1).reduce<number>((a, b) => a + (b ?? 0), 0);
    const through = before + (budgets[talk.current - 1] ?? 0);
    if (elapsed > through) return elapsed - through;
    if (elapsed < before) return elapsed - before;
    return 0;
  });

  function clock(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(r).padStart(2, '0');
  }
  const timeOfDay = $derived(new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

  function send(command: PresenterCommand) {
    error = '';
    void host.sendPresenterCommand?.(command).catch((cause) => {
      error = cause instanceof Error ? cause.message : String(cause);
    });
  }

  const rehearsalKey = (s: PresenterState) => `radiant.rehearsal:${s.docId}:${s.presentationId}`;

  function loadRun(s: PresenterState) {
    try {
      const stored = JSON.parse(getSetting(rehearsalKey(s)) ?? 'null');
      lastRun = stored && typeof stored.times === 'object' ? stored.times : {};
    } catch { lastRun = {}; }
  }

  /** Close the timing of the step that was on screen. */
  function closeStep(at: number) {
    if (shown && rehearsing) runTimes[shown.id] = (runTimes[shown.id] ?? 0) + (at - shown.at) / 1000;
    shown = null;
  }

  function saveRun(s: PresenterState) {
    if (!Object.keys(runTimes).length) return;
    const times = Object.fromEntries(Object.entries(runTimes).map(([id, t]) => [id, Math.round(t)]));
    setSetting(rehearsalKey(s), JSON.stringify({ at: new Date().toISOString(), times }));
    lastRun = times;
    runTimes = {};
  }

  function receive(next: PresenterState) {
    const previous = talk;
    const at = Date.now();
    const samePresentation = previous && previous.docId === next.docId && previous.presentationId === next.presentationId;
    if (!samePresentation) loadRun(next);
    const stepId = next.active && next.current > 0 ? next.steps[next.current - 1]?.id : undefined;
    if (!previous || previous.current !== next.current || previous.active !== next.active || !samePresentation) {
      closeStep(at);
      stepSince = at;
      if (stepId && !next.special) shown = { id: stepId, at };
    }
    if (previous?.active && (!next.active || !samePresentation)) {
      if (rehearsing) saveRun(previous);
      rehearsing = false;
    }
    if (!previous?.active && next.active) runTimes = {};
    talk = next;
  }

  function toggleRehearse() {
    if (rehearsing && talk) {
      closeStep(Date.now());
      saveRun(talk);
      rehearsing = false;
    } else {
      rehearsing = true;
      runTimes = {};
      if (current && talk?.active) shown = { id: current.id, at: Date.now() };
    }
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest('input, select, textarea')) return;
    if (e.metaKey || e.ctrlKey) return;
    const handled = (fn: () => void) => {
      e.preventDefault();
      if (!e.repeat) fn();
    };
    if (/^[0-9]$/.test(e.key)) return handled(() => { digits = (digits + e.key).slice(-4); });
    if (e.key === 'Enter' && digits) {
      return handled(() => {
        const n = Number(digits);
        digits = '';
        if (n > 0) send({ kind: 'jump', step: n });
      });
    }
    const onButton = !!target?.closest('button');
    if (onButton && (e.key === ' ' || e.key === 'Enter')) return;
    digits = '';
    switch (e.key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'Enter': return handled(() => send({ kind: 'next' }));
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp': return handled(() => send({ kind: 'previous' }));
      case ' ': return handled(() => send({ kind: e.shiftKey ? 'previous' : 'next' }));
      case 'Home': return handled(() => send({ kind: 'first' }));
      case 'End': return handled(() => send({ kind: 'last' }));
    }
    if (e.code === 'KeyB' || e.code === 'Period') return handled(() => send({ kind: 'blank' }));
  }

  async function loadDisplays() {
    if (!host.listDisplays) return;
    try {
      displays = await host.listDisplays();
      // Suggest the display this console is not on: usually the projector.
      display = displays.find((d) => !d.current)?.id ?? displays[0]?.id ?? '';
    } catch { displays = []; }
  }

  function setProtected(on: boolean) {
    protectedView = on;
    void host.setContentProtected?.(on).catch(() => {});
  }

  onMount(() => {
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    const scheme = () => { dark = !!media?.matches; };
    media?.addEventListener('change', scheme);
    let stop: (() => void) | undefined;
    let gone = false;
    if (host.onPresenterState) {
      void host.onPresenterState(receive).then((off) => {
        if (gone) off();
        else stop = off;
        send({ kind: 'hello' });
      });
    } else {
      error = 'The presenter console needs the map window that opened it.';
    }
    void loadDisplays();
    return () => {
      gone = true;
      clearInterval(timer);
      media?.removeEventListener('change', scheme);
      stop?.();
    };
  });

  let list: HTMLOListElement | undefined = $state();
  $effect(() => {
    const n = talk?.current;
    if (n && list) list.querySelector(`[data-step="${n}"]`)?.scrollIntoView({ block: 'nearest' });
  });
</script>

<svelte:head><title>Radiant Presenter{talk ? ' · ' + talk.presentation : ''}</title></svelte:head>
<svelte:window onkeydown={onKey} />

<main class="console" class:dark aria-label="Presenter console">
  <header>
    <div class="name">
      <strong>{talk?.presentation ?? 'Presenter console'}</strong>
      {#if talk}<span class="dim">{talk.docTitle}</span>{/if}
    </div>
    <div class="times" aria-label="Times">
      <span title="Elapsed"><span class="dim">Elapsed</span> <b class="mono">{clock(elapsed)}</b></span>
      <span title="Clock"><span class="dim">Clock</span> <b class="mono">{timeOfDay}</b></span>
    </div>
  </header>

  {#if !talk}
    <section class="waiting">
      <p>{error || 'Waiting for the map window…'}</p>
      <p class="dim">Open a map and choose Presenter console in the Presentations panel.</p>
    </section>
  {:else}
    <section class="now" aria-live="polite">
      {#if talk.active && current}
        <div class="stepline">
          <span class="badge">{talk.special === 'overview' ? 'Whole map' : talk.special === 'captured' ? 'Captured' : talk.special === 'detour' ? 'Detour' : `Step ${talk.current} of ${total}`}</span>
          {#if talk.building}<span class="dim">more reveals on this step</span>{/if}
          {#if talk.blank}<span class="badge warn">Audience screen is blank</span>{/if}
        </div>
        <h1 class="title">{talk.title}</h1>
        {#if talk.caption}<p class="caption">“{talk.caption}”</p>{/if}
      {:else}
        <div class="stepline"><span class="badge">Not presenting</span></div>
        <h1 class="title">{talk.presentation}</h1>
        <p class="dim">{total} {total === 1 ? 'step' : 'steps'}{talk.targetMinutes ? ` · ${talk.targetMinutes} minutes` : ''}</p>
      {/if}
      <div class="note" aria-label="Speaker note">
        {#if talk.active && talk.note}{talk.note}{:else if talk.active}<span class="dim">No note for this step.</span>{:else}<span class="dim">Speaker notes appear here while you present. The audience never sees them.</span>{/if}
      </div>
    </section>

    <aside class="speaker">
      <div class="next">
        <span class="dim">Next</span>
        <strong>{talk.active ? (talk.building ? 'Reveal the next node' : talk.nextTitle ?? 'End of the talk') : talk.steps[0]?.title ?? '—'}</strong>
        {#if talk.active && talk.building && talk.nextTitle}<span class="dim">then {talk.nextTitle}</span>{/if}
      </div>

      {#if talk.active}
        <div class="pace" aria-label="Pace">
          {#if planned !== undefined}
            <div class="bar" title="Elapsed against the planned length">
              <div class="fill" class:over={pace !== null && pace > 0} style:width="{Math.min(100, (elapsed / Math.max(1, planned)) * 100)}%"></div>
            </div>
            <div class="row">
              <span class="mono">{clock(elapsed)} of {clock(planned)}</span>
              <span class:late={pace !== null && pace > 0} class:early={pace !== null && pace < 0}>
                {pace === null || pace === 0 ? 'On pace' : pace > 0 ? `${clock(pace)} behind` : `${clock(-pace)} ahead`}
              </span>
            </div>
          {:else}
            <p class="dim">Set minutes or step seconds in the Presentations panel to see your pace.</p>
          {/if}
          <div class="row"><span class="dim">This step</span><span class="mono">{clock(onStep)}{stepBudget !== undefined ? ' / ' + clock(stepBudget) : ''}</span></div>
          {#if stepBudget !== undefined}
            <div class="bar thin"><div class="fill" class:over={onStep > stepBudget} style:width="{Math.min(100, (onStep / Math.max(1, stepBudget)) * 100)}%"></div></div>
          {/if}
        </div>
      {/if}

      <div class="controls">
        {#if talk.active}
          <button class="btn bordered" type="button" onclick={() => send({ kind: 'previous' })} aria-label="Previous step">◀ Previous</button>
          <button class="btn primary" type="button" onclick={() => send({ kind: 'next' })} aria-label="Next step">Next ▶</button>
          <button class="btn bordered" type="button" aria-pressed={!!talk.blank} onclick={() => send({ kind: 'blank' })}>{talk.blank ? 'Show map' : 'Blank screen'}</button>
          <button class="btn bordered" type="button" onclick={() => send({ kind: 'end' })}>End</button>
        {:else}
          <button class="btn primary" type="button" disabled={!total} onclick={() => send({ kind: 'start' })}>Start presenting</button>
        {/if}
      </div>
      {#if digits}<p class="dim">Go to step {digits}, then Return</p>{/if}

      {#if displays.length}
        <div class="display">
          <label for="presenter-display" class="dim">Audience display</label>
          <div class="row">
            <select id="presenter-display" class="field" bind:value={display}>
              {#each displays as d (d.id)}
                <option value={d.id}>{d.name} · {d.width}×{d.height}{d.current ? ' (this one)' : ''}</option>
              {/each}
            </select>
            <button class="btn bordered" type="button" disabled={!display} onclick={() => send({ kind: 'fullscreen', display })}>Fill</button>
            <button class="btn bordered" type="button" onclick={() => send({ kind: 'fullscreen', display: null })}>Window</button>
          </div>
        </div>
      {/if}

      <div class="options">
        {#if host.setContentProtected}
          <label class="check"><input type="checkbox" checked={protectedView} onchange={(e) => setProtected(e.currentTarget.checked)} /> Hide this console from screen sharing</label>
        {/if}
        <label class="check"><input type="checkbox" checked={rehearsing} onchange={toggleRehearse} /> Rehearse: record time per step</label>
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
    </aside>

    <section class="steps" aria-label="Steps">
      <ol bind:this={list}>
        {#each talk.steps as step (step.id)}
          <li data-step={step.number} class:on={talk.active && step.number === talk.current} class:done={talk.active && step.number < talk.current}>
            <button type="button" disabled={!talk.active} onclick={() => send({ kind: 'jump', step: step.number })}>
              <span class="num">{step.number}</span>
              <span class="label">{step.title}</span>
              <span class="mono dim" title="Budget">{budgets[step.number - 1] !== undefined ? clock(budgets[step.number - 1]!) : ''}</span>
              <span class="mono last" title="Last rehearsal">{lastRun[step.id] !== undefined ? clock(lastRun[step.id]) : ''}</span>
            </button>
          </li>
        {/each}
      </ol>
      {#if Object.keys(lastRun).length}<p class="dim legend">Right column: times from the last rehearsal.</p>{/if}
    </section>
  {/if}
</main>

<style>
  .console {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-columns: minmax(0, 1.6fr) minmax(260px, 1fr);
    grid-template-rows: auto minmax(0, 1fr) minmax(120px, 34%);
    gap: 14px;
    padding: 14px 18px;
    background: var(--bg);
    color: var(--text);
    user-select: text;
    -webkit-user-select: text;
  }
  header {
    grid-column: 1 / -1;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
  }
  .name { display: flex; gap: 10px; align-items: baseline; min-width: 0; }
  .name strong { font-size: 15px; }
  .times { display: flex; gap: 18px; font-size: 15px; }
  .times b { font-size: 22px; }
  .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }
  .dim { color: var(--text-dim); }
  .waiting { grid-column: 1 / -1; align-self: center; text-align: center; font-size: 16px; }
  .now { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .stepline { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .badge { padding: 2px 8px; border-radius: 999px; background: var(--hover); font-size: 12px; }
  .badge.warn { background: var(--warn); color: #fff; }
  .title { margin: 0; font-size: clamp(22px, 3.2vw, 38px); line-height: 1.15; }
  .caption { margin: 0; font-size: 17px; font-style: italic; }
  .note {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel-solid);
    font-size: clamp(17px, 2vw, 24px);
    line-height: 1.45;
    white-space: pre-wrap;
  }
  .speaker { display: flex; flex-direction: column; gap: 14px; min-height: 0; overflow: auto; }
  .next { display: grid; gap: 2px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; }
  .next strong { font-size: 18px; }
  .pace { display: grid; gap: 6px; }
  .bar { height: 10px; border-radius: 5px; background: var(--hover); overflow: hidden; }
  .bar.thin { height: 5px; }
  .fill { height: 100%; background: var(--accent); }
  .fill.over { background: var(--warn); }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .late { color: var(--warn); font-weight: 600; }
  .early { color: var(--ok); font-weight: 600; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; }
  .controls .btn { font-size: 14px; padding: 8px 14px; }
  .display { display: grid; gap: 4px; }
  .display select { flex: 1; min-width: 0; }
  .options { display: grid; gap: 6px; }
  .check { display: flex; gap: 6px; align-items: center; }
  .error { margin: 0; color: var(--danger); }
  .steps { grid-column: 1 / -1; min-height: 0; overflow: auto; border-top: 1px solid var(--line); padding-top: 8px; }
  .steps ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 2px; }
  .steps button {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) 56px 56px;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }
  .steps button:disabled { cursor: default; }
  .steps li.done button { color: var(--text-dim); }
  .steps li.on button { background: var(--accent); color: var(--accent-ink); }
  .steps li.on .dim { color: inherit; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .last { text-align: right; }
  .legend { margin: 6px 0 0; font-size: 12px; }
</style>
