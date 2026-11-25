<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { effectiveRepresentation } from '../core/art/representation';
  import { cloneDoc, newId, parseDocReport } from '../core/model';
  import {
    buzanSchedule, editInterval, firstLevel, intervalDays, isDue, latestOutcomes, localDate, outcomes,
    planSchedule, reviewNodes, reviewScope, sameScope,
    type Outcome, type ReviewData, type ReviewMode, type ReviewNode, type ReviewRecord,
    type ReviewSchedule, type ReviewScope
  } from '../core/review';
  import { advanceStudy, studyItems, studyResults, type StudyItem, type StudyKind } from '../core/review/study';
  import type { Doc, NodeId } from '../core/types';
  import type { AppController } from './controller.svelte';
  import { learnedMap, markLearned, readReviews, readStudyProgress, reviewRemindersEnabled, saveReviews, setReviewReminders, subscribeReviews, writeStudyProgress } from './reviewStore';
  import RebuildCanvas from './RebuildCanvas.svelte';
  import ReviewTree from './ReviewTree.svelte';

  let { c }: { c: AppController } = $props();

  type Page = 'setup' | 'recall' | 'schedule' | 'due' | 'history' | 'rebuild' | 'strength' | 'study' | 'explain' | 'learned';

  interface Session {
    scope: ReviewScope;
    doc: Doc;
    mode: ReviewMode;
    rows: ReviewNode[];
    startedAt: number;
    from: number;
    last: number;
    schedule?: ReviewSchedule;
  }

  const outcomeName = { recalled: 'Recalled', partly: 'Partly', missed: 'Missed' };
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const pages: Array<[Page, string]> = [
    ['setup', 'Practice'], ['schedule', 'Schedule'], ['due', 'Due'], ['history', 'History']
  ];

  let dialog: HTMLDialogElement = $state(null!);
  let page = $state<Page>('setup');
  let scope = $state.raw<ReviewScope | null>(null);
  let data = $state.raw<ReviewData>({ history: [], schedules: [] });
  let mode = $state<ReviewMode>('branches');
  let date = $state('');
  let plan = $state.raw<ReviewSchedule | null>(null);
  let now = $state(Date.now());
  let session = $state.raw<Session | null>(null);
  let step = $state(0);
  let revealed = $state(false);
  let revealedLabels = $state.raw(new Set<NodeId>());
  let answer = $state('');
  let scored = $state.raw<Map<NodeId, Outcome>>(new Map());
  let pics = $state.raw<Map<string, string>>(new Map());
  let error = $state('');
  let loading = $state(false);
  let previewStrength = $state(false);
  let historyBranchOnly = $state(false);
  let message = $state('');
  let learned = $state(false);
  let explanation = $state('');
  let studyKind = $state<StudyKind>('nodes');
  let studyShare = $state(35);
  let exercise = $state.raw<StudyItem[]>([]);
  let studyRows = $state.raw<ReviewNode[]>([]);
  let guesses = $state.raw(new Map<string, string>());
  let grading = $state.raw<Map<string, boolean> | null>(null);
  let timerMinutes = $state(20);
  let canRemind = $state(false);
  let reminders = $state(false);
  let requestingReminders = $state(false);
  const studyById = $derived(new Map(studyRows.map((row) => [row.id, row])));
  const blanks = $derived(new Map(exercise.map((item) => [item.id, item])));
  const timerLeft = $derived(c.reviewTimerDeadline ? Math.max(0, Math.ceil((c.reviewTimerDeadline - now) / 60_000)) : 0);

  const due = $derived(data.schedules.filter((item) => isDue(item, now))
    .toSorted((a, b) => a.dates[a.completed] - b.dates[b.completed]));
  const records = $derived(data.history.filter((entry) =>
    entry.scope.docId === scope?.docId && (!historyBranchOnly || sameScope(entry.scope, scope))));
  const scores = $derived(latestOutcomes(data.history, scope?.docId ?? ''));
  const recallRows = $derived(session?.rows.filter((row) =>
    session?.mode === 'labels' || row.depth < step || (revealed && row.depth === step)) ?? []);
  const byId = $derived(new Map(session?.rows.map((row) => [row.id, row])));
  const levelRows = $derived(session?.rows.filter((row) => row.depth === step) ?? []);
  const levelScored = $derived(levelRows.every((row) => scored.has(row.id)));

  function refresh() {
    try {
      data = readReviews();
    } catch {
      error = 'Review data could not be loaded from this device.';
    }
  }

  onMount(() => {
    refresh();
    reminders = reviewRemindersEnabled();
    if (c.host.reviewNotificationPermission) {
      void c.host.platformInfo().then((info) => { canRemind = info.os === 'macos'; }).catch(() => {});
    }
    const unsubscribe = subscribeReviews(refresh);
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => { unsubscribe(); clearInterval(timer); };
  });

  $effect(() => {
    const offer = c.reviewOffer;
    if (offer && dialog && offer === c.doc.id) {
      untrack(() => {
        c.reviewOffer = null;
        if (!dialog.open) show('learned');
      });
    }
  });

  function show(next: Page) {
    if (!dialog.open) {
      refresh();
      now = Date.now();
      scope = reviewScope(c.doc, null, c.filePath);
      historyBranchOnly = false;
      learned = learnedMap(c.doc.id);
      dialog.showModal();
    }
    error = '';
    message = '';
    page = next;
    if (next === 'schedule') loadSchedule();
    if (next === 'study') configureStudy();
    if (next === 'explain') explanation = '';
  }

  function close() {
    if (loading) return;
    dialog.close();
    reset();
  }

  function reset() {
    session = null;
    pics = new Map();
    previewStrength = c.reviewStrength !== null;
    exercise = [];
    grading = null;
  }

  async function toggleReminders(enabled: boolean) {
    error = '';
    if (!enabled) {
      reminders = false;
      setReviewReminders(false);
      return;
    }
    requestingReminders = true;
    try {
      reminders = await c.host.reviewNotificationPermission?.(true) ?? false;
      setReviewReminders(reminders);
      if (!reminders) error = 'Allow Radiant notifications in macOS Settings to get reminders.';
    } catch {
      error = 'Notifications could not be enabled.';
    } finally {
      requestingReminders = false;
    }
  }

  function configureStudy() {
    if (!scope) return;
    studyShare = readStudyProgress(scope, studyKind).percent;
    exercise = [];
    grading = null;
    guesses = new Map();
  }

  function beginStudy() {
    if (!scope) return;
    const share = Math.round(studyShare);
    if (!Number.isFinite(share) || share < 5 || share > 90) {
      error = 'Choose a share between 5 and 90 per cent.';
      return;
    }
    studyRows = reviewNodes(c.doc, scope.nodeId);
    exercise = studyItems(c.doc, scope.nodeId, studyKind, share);
    guesses = new Map();
    grading = null;
    error = exercise.length ? '' : 'There are no eligible items in this scope.';
    message = '';
  }

  function checkStudy() {
    if (!scope || !exercise.length || grading) return;
    const checked = studyResults(exercise, guesses);
    grading = checked;
    const correct = [...checked.values()].filter(Boolean).length;
    const previous = readStudyProgress(scope, studyKind);
    const population = studyKind === 'nodes'
      ? studyRows.length : studyItems(c.doc, scope.nodeId, studyKind, 100).length;
    const next = advanceStudy({ percent: studyShare, streak: previous.percent === studyShare ? previous.streak : 0 },
      correct === exercise.length, population, exercise.length);
    writeStudyProgress(scope, studyKind, next);
    message = correct + ' of ' + exercise.length + ' correct.' +
      (next.percent < studyShare ? ' Next session blanks ' + next.percent + '%.' : '');
  }

  function saveExplanation() {
    const id = scope?.nodeId;
    const answer = explanation.trim();
    if (!id || scope?.docId !== c.doc.id || !c.doc.nodes[id] || !answer) return;
    const existing = c.doc.nodes[id].note?.trimEnd();
    c.setNoteOf(id, existing ? existing + '\n\n' + answer : answer);
    explanation = '';
    message = 'Explanation saved in the branch note.';
  }

  function toggleLearned(enabled: boolean) {
    learned = enabled;
    markLearned(c.doc.id, enabled);
  }

  function toggleStrength(enabled: boolean) {
    previewStrength = enabled;
    if (scope?.docId === c.doc.id) c.setReviewStrength(enabled ? new Map(scores) : null);
  }

  function changeScope(nodeId: NodeId | null) {
    scope = reviewScope(c.doc, nodeId, c.filePath);
    if (page === 'schedule') loadSchedule();
  }

  function begin(target: ReviewScope, doc: Doc, kind: ReviewMode, next: Page, schedule?: ReviewSchedule) {
    const rows = reviewNodes(doc, target.nodeId);
    if (!rows.length) {
      error = 'This branch is no longer in the map.';
      return;
    }
    const from = firstLevel(kind, rows);
    const current: Session = {
      scope: target, doc, mode: from === 0 ? 'labels' : kind, rows, startedAt: Date.now(),
      from, last: rows.reduce((depth, row) => Math.max(depth, row.depth), 0), schedule
    };
    scope = target;
    session = current;
    step = from;
    revealed = false;
    revealedLabels = new Set();
    answer = '';
    scored = new Map();
    pics = new Map();
    error = '';
    page = next;
    if (next === 'recall') loadPictures(current);
    if (next === 'strength') previewStrength = c.reviewStrength !== null;
    explanation = '';
  }

  function start(next: Page) {
    if (!scope) return;
    const doc = next === 'rebuild' ? cloneDoc(c.documentWithLayout()) : c.doc;
    begin(scope, doc, mode, next, next === 'recall'
      ? data.schedules.find((item) => sameScope(item.scope, scope!) && isDue(item, now))
      : undefined);
  }

  function pictureHash(doc: Doc, row: ReviewNode): string | undefined {
    const representation = effectiveRepresentation(doc, row.id);
    if (representation === 'svg') return row.node.svgArt?.assetHash ?? row.node.imageAsset;
    if (representation === 'picture') return row.node.pictureArt?.assetHash ?? row.node.imageAsset;
    return row.node.imageAsset;
  }

  function loadPictures(current: Session) {
    const hashes = new Map<string, Promise<string>>();
    function url(hash: string): Promise<string> {
      let existing = hashes.get(hash);
      if (!existing) {
        existing = c.host.assetUrl(hash);
        hashes.set(hash, existing);
      }
      return existing;
    }
    void Promise.all(current.rows.map(async (row) => {
      const hash = pictureHash(current.doc, row);
      if (!hash) return null;
      try { return [row.id, await url(hash)] as const; }
      catch { return null; }
    })).then((urls) => {
      if (session === current) pics = new Map(urls.filter((item) => item !== null));
    });
  }

  async function openDue(item: ReviewSchedule) {
    loading = true;
    error = '';
    try {
      const { docId, path, nodeId } = item.scope;
      if (c.doc.id !== docId && !path) {
        error = 'Open the original map to review this schedule.';
        return;
      }
      const doc = c.doc.id === docId ? c.doc : parseDocReport(await c.host.docLoad(path!)).doc;
      if (doc.id !== docId) {
        error = 'The file at this location is a different map.';
        return;
      }
      begin(reviewScope(doc, nodeId, c.doc.id === docId ? c.filePath : path), doc, item.mode, 'recall', item);
    } catch {
      error = 'The scheduled map could not be opened. Open it in Radiant and try again.';
    } finally {
      loading = false;
    }
  }

  function revealLabel(id: NodeId) {
    revealedLabels = new Set(revealedLabels).add(id);
    revealed = levelRows.every((row) => revealedLabels.has(row.id));
  }

  function rate(id: NodeId, outcome: Outcome) {
    scored = new Map(scored).set(id, outcome);
  }

  function nextLevel() {
    step += 1;
    revealed = false;
    revealedLabels = new Set();
    answer = '';
  }

  function finish() {
    if (!session || !levelScored || session.last !== step || !revealed) return;
    const current = session;
    const finishedAt = Date.now();
    const results = current.rows.flatMap((row) => {
      const outcome = scored.get(row.id);
      return outcome ? [{ id: row.id, label: row.label, outcome }] : [];
    });
    const record: ReviewRecord = {
      id: newId(), scope: current.scope, mode: current.mode, finishedAt,
      elapsedMs: Math.max(0, finishedAt - current.startedAt), results
    };
    try {
      data = saveReviews((latest) => ({
        history: [record, ...latest.history],
        schedules: latest.schedules.map((item) => {
          const used = current.schedule;
          return used && sameScope(item.scope, used.scope) && item.completed === used.completed &&
            item.dates[item.completed] === used.dates[used.completed]
            ? { ...item, scope: current.scope, completed: item.completed + 1 } : item;
        })
      }));
      if (c.reviewStrength && current.scope.docId === c.doc.id) c.setReviewStrength(latestOutcomes(data.history, c.doc.id));
      session = null;
      show('history');
      message = 'Review saved.';
    } catch {
      error = 'This review could not be saved. Your results are still here.';
    }
  }

  function loadSchedule() {
    const saved = scope && data.schedules.find((item) => sameScope(item.scope, scope!));
    plan = saved || null;
    date = plan?.target ?? '';
    if (saved) mode = saved.mode;
  }

  function propose(target: string) {
    date = target;
    error = '';
    plan = scope && target ? planSchedule(scope, mode, target, now) : null;
  }

  function chooseBuzan() {
    if (!scope) return;
    plan = buzanSchedule(scope, mode, Date.now());
    date = plan.target;
    error = '';
  }

  function adjust(index: number, event: Event) {
    const element = event.currentTarget as HTMLInputElement;
    if (!plan) return;
    if (plan.preset === 'buzan') {
      const current = plan;
      const time = new Date(element.value).getTime();
      const previous = index === 0 ? current.start : current.dates[index - 1];
      if (time > previous) {
        const delta = time - current.dates[index];
        const dates = current.dates.map((value, i) => i < index ? value : value + delta);
        date = localDate(dates[dates.length - 1]);
        plan = { ...current, target: date, dates };
        error = '';
        return;
      }
    } else {
      const edited = editInterval(plan, index, element.valueAsNumber);
      if (edited) {
        plan = edited;
        error = '';
        return;
      }
    }
    error = 'Choose a positive interval within the schedule.';
    element.value = plan.preset === 'buzan'
      ? datetimeInput(plan.dates[index])
      : String(intervalDays(plan.dates[index - 1] ?? plan.start, plan.dates[index]));
  }

  function datetimeInput(time: number): string {
    const local = new Date(time);
    const pad = (value: number) => String(value).padStart(2, '0');
    return localDate(time) + 'T' + pad(local.getHours()) + ':' + pad(local.getMinutes());
  }

  function savePlan() {
    if (!scope || !plan?.dates.length) return;
    const updated = { ...plan, scope, mode };
    try {
      data = saveReviews((latest) => ({
        ...latest, schedules: [...latest.schedules.filter((item) => !sameScope(item.scope, updated.scope)), updated]
      }));
      plan = updated;
      message = 'Schedule saved.';
      error = '';
    } catch {
      error = 'This schedule could not be saved on this device.';
    }
  }

  function removePlan() {
    if (!scope) return;
    try {
      data = saveReviews((latest) => ({
        ...latest, schedules: latest.schedules.filter((item) => !sameScope(item.scope, scope!))
      }));
      loadSchedule();
      message = 'Schedule removed.';
      error = '';
    } catch {
      error = 'This schedule could not be removed.';
    }
  }

  function elapsed(ms: number): string {
    const seconds = Math.round(ms / 1000);
    return seconds < 60 ? seconds + 's' : Math.floor(seconds / 60) + 'm ' + seconds % 60 + 's';
  }
</script>

{#snippet studyField(item: StudyItem)}
  <div class="node-card" data-status={grading ? (grading.get(item.id) ? 'recalled' : 'missed') : undefined}>
    <input type="text" maxlength="500" aria-label={'Hidden ' + (studyKind === 'nodes' ? 'node label ' + (exercise.indexOf(item) + 1) : 'connection label for ' + item.cue)}
      value={guesses.get(item.id) ?? ''} disabled={grading !== null}
      oninput={(e) => { guesses = new Map(guesses).set(item.id, e.currentTarget.value); }}>
    {#if grading}<small>{grading.get(item.id) ? 'Correct' : 'Answer: ' + item.answer}</small>{/if}
  </div>
{/snippet}

{#snippet explanationPrompt()}
  <label class="answer">How would you explain this branch to someone new to it?
    <textarea class="field" rows="4" maxlength="10000" bind:value={explanation}></textarea>
  </label>
  <button class="btn bordered" disabled={!explanation.trim()} onclick={saveExplanation}>Save to branch note</button>
{/snippet}

<div class="launch">
  <button class="btn bordered" onclick={() => show('setup')}>Review map</button>
  {#if due.length}
    <button class="btn bordered" onclick={() => show('due')}>Due ({due.length})</button>
  {/if}
</div>

<dialog bind:this={dialog} class:hide-map={page === 'recall' || page === 'rebuild' || (page === 'study' && exercise.length > 0)}
  class:rebuild={page === 'rebuild'} aria-labelledby="review-heading"
  onkeydown={(event) => event.stopPropagation()}
  onkeyup={(event) => event.stopPropagation()}
  oncancel={(event) => { event.preventDefault(); close(); }}>
  <header>
    <h2 id="review-heading">
      {{ setup: 'Review', recall: 'Recall', schedule: 'Review schedule', due: 'Due reviews', history: 'Review history',
        rebuild: 'Rebuild from memory', strength: 'Review strength',
        study: 'Fill study blanks', explain: 'Explain this branch', learned: 'Recall this map?' }[page]}
    </h2>
    <button class="btn bordered" onclick={close} disabled={loading}>Close</button>
  </header>

  {#if pages.some(([key]) => key === page)}
    <nav aria-label="Review views">
      {#each pages as [key, title] (key)}
        <button class="btn bordered" aria-current={page === key ? 'page' : undefined}
          disabled={loading} onclick={() => show(key)}>{title}{key === 'due' && due.length ? ' (' + due.length + ')' : ''}</button>
      {/each}
    </nav>
  {/if}

  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}

  {#if page === 'setup' || page === 'schedule'}
    <div class="settings">
      <label>Review scope
        <select value={scope?.nodeId ?? ''} onchange={(e) => changeScope(e.currentTarget.value || null)}>
          <option value="">Whole map · {c.docTitle}</option>
          {#if c.focusId && c.doc.nodes[c.focusId]}
            <option value={c.focusId}>Selected branch · {c.doc.nodes[c.focusId].text || 'Untitled'}</option>
          {/if}
        </select>
      </label>
      <label>Recall mode
        <select bind:value={mode}>
          <option value="branches">Hide branches</option>
          <option value="labels">Hide labels, keep artwork</option>
        </select>
      </label>
    </div>
  {/if}

  {#if page === 'setup'}
    <p>Recall each level silently or type what you remember. Reveal it when you’re ready and rate each item.</p>
    <div class="actions">
      <button class="btn primary" onclick={() => start('recall')}>Start recall</button>
      <button class="btn bordered" onclick={() => start('rebuild')}>Rebuild from memory</button>
      <button class="btn bordered" onclick={() => start('strength')}>Review strength</button>
      <button class="btn bordered" onclick={() => show('study')}>Fill study blanks</button>
      {#if scope?.nodeId}<button class="btn bordered" onclick={() => show('explain')}>Explain this branch</button>{/if}
    </div>
    <label class="check"><input type="checkbox" checked={learned} onchange={(e) => toggleLearned(e.currentTarget.checked)}> Offer recall when I reopen this learned map</label>
    <div class="settings">
      {#if c.reviewTimerDeadline}
        <p>Mapping timer · about {timerLeft} min left</p>
        <button class="btn bordered" onclick={() => c.stopReviewTimer()}>Stop timer</button>
      {:else}
        <label>Mapping timer (minutes)
          <input type="number" min="1" max="120" bind:value={timerMinutes}>
        </label>
        <button class="btn bordered" disabled={!Number.isInteger(timerMinutes) || timerMinutes < 1 || timerMinutes > 120}
          onclick={() => { c.startReviewTimer(timerMinutes); now = Date.now(); }}>Start timer</button>
      {/if}
    </div>
  {:else if page === 'learned'}
    <p>Try to recall this map from memory. Recall is generally more useful for learning than rereading.</p>
    <div class="actions">
      <button class="btn primary" onclick={() => start('recall')}>Start recall</button>
      <button class="btn bordered" onclick={close}>Open map</button>
      <button class="btn bordered" onclick={() => { toggleLearned(false); close(); }}>Don’t offer again</button>
    </div>
  {:else if page === 'study'}
    {#if !exercise.length}
      <div class="settings">
        <label>Blank items
          <select bind:value={studyKind} onchange={configureStudy}>
            <option value="nodes">Node labels</option>
            <option value="connections">Connection labels</option>
          </select>
        </label>
        <label>Share to blank (%)
          <input type="number" min="5" max="90" bind:value={studyShare}>
        </label>
      </div>
      <button class="btn primary" onclick={beginStudy}>Start filling</button>
    {:else}
      {#if studyKind === 'nodes'}
        <ReviewTree nodes={studyRows} name="Study map with blank node labels">
          {#snippet card(id)}
            {@const item = blanks.get(id)}
            {#if item}
              {@render studyField(item)}
            {:else}
              <div class="node-card"><strong>{studyById.get(id)?.label || 'Untitled'}</strong></div>
            {/if}
          {/snippet}
        </ReviewTree>
      {:else}
        <ul class="entries">
          {#each exercise as item (item.id)}
            <li class="entry"><strong>{item.cue}</strong>{@render studyField(item)}</li>
          {/each}
        </ul>
      {/if}
      <div class="actions">
        {#if !grading}
          <button class="btn primary" onclick={checkStudy}>Check answers</button>
        {:else}
          <button class="btn primary" onclick={configureStudy}>Practice again</button>
        {/if}
      </div>
    {/if}
    <div class="actions"><button class="btn bordered" onclick={() => show('setup')}>Back to practice</button></div>
  {:else if page === 'explain'}
    {@render explanationPrompt()}
    <div class="actions"><button class="btn bordered" onclick={() => show('setup')}>Back to practice</button></div>
  {:else if page === 'recall' && session}
    <p aria-live="polite">Level {step - session.from + 1} of {session.last - session.from + 1}.
      {revealed ? 'Rate each revealed item below.' : 'Recall the items on this level.'}</p>
    <ReviewTree nodes={recallRows} name="Recall map">
      {#snippet card(id)}
        {@const row = byId.get(id)!}
        {@const visible = row.depth < step || (row.depth === step && (revealed || revealedLabels.has(id)))}
        {@const src = pics.get(id)}
        <div class="node-card">
          {#if src}<img {src} alt={visible ? '' : 'Picture cue'}>{/if}
          {#if visible}<strong>{row.label || 'Untitled'}</strong>
          {:else if session?.mode === 'labels' && row.depth === step}
            <button class="btn bordered" onclick={() => revealLabel(id)}>Reveal label</button>
          {:else}<span class="hidden-label" aria-label="Hidden label">···</span>{/if}
        </div>
      {/snippet}
    </ReviewTree>

    {#if !revealed}
      <label class="answer">What do you remember? <span class="muted">(optional)</span>
        <textarea class="field" rows="2" bind:value={answer} placeholder="Type your recall here"></textarea>
      </label>
      <div class="actions"><button class="btn primary" onclick={() => { revealed = true; }}>Reveal level</button></div>
    {/if}
    {#if revealed || revealedLabels.size > 0}
      {#if scope?.nodeId && scope.docId === c.doc.id}
        <details><summary>Explain this branch in your own words</summary>{@render explanationPrompt()}</details>
      {/if}
      {#if answer.trim()}<p class="typed"><strong>Your recall</strong> {answer}</p>{/if}
      <ul class="entries">
        {#each levelRows.filter((row) => revealed || revealedLabels.has(row.id)) as row (row.id)}
          <li class="entry">
            <strong>{row.label || 'Untitled'}</strong>
            <div class="ratings" role="group" aria-label={'Rate ' + (row.label || 'Untitled')}>
              {#each outcomes as item (item)}
                <button class="btn bordered" data-status={item} aria-pressed={scored.get(row.id) === item}
                  onclick={() => rate(row.id, item)}>{outcomeName[item]}</button>
              {/each}
            </div>
          </li>
        {/each}
      </ul>
      <div class="actions">
        {#if step < session.last}
          <button class="btn primary" disabled={!levelScored} onclick={nextLevel}>Next level</button>
        {:else}
          <button class="btn primary" disabled={!levelScored} onclick={finish}>Finish review</button>
        {/if}
      </div>
    {/if}
  {:else if page === 'schedule'}
    <div class="settings">
      <label>Target date
        <input type="date" min={localDate(now)} value={date} onchange={(e) => propose(e.currentTarget.value)}>
      </label>
      <button class="btn bordered" onclick={chooseBuzan}>Use Buzan’s preset</button>
    </div>
    {#if plan?.preset === 'buzan'}
      <p class="muted"><em>Use Your Head</em> proposes reviews at about 10 minutes, one day, one week and one month.
        The evidence supports spacing in general. These intervals are Buzan’s recommendation.</p>
    {:else if date && !plan?.dates.length}
      <p>Choose a date after today to plan your reviews.</p>
    {/if}
    {#if plan?.dates.length}
      {@const schedule = plan}
      <ul class="entries">
        {#each schedule.dates as time, index (index)}
          <li class="entry">
            <span>{schedule.preset === 'buzan' ? timeFormat.format(time) : dateFormat.format(time)}</span>
            {#if index < schedule.completed}
              <span class="muted">Reviewed</span>
            {:else if schedule.preset === 'buzan'}
              <input type="datetime-local" aria-label={'Review ' + (index + 1) + ' date and time'}
                value={datetimeInput(time)} onchange={(e) => adjust(index, e)}>
            {:else}
              <label class="interval">
                <input type="number" min="1" aria-label={'Interval ' + (index + 1) + ' in days'}
                  value={intervalDays(schedule.dates[index - 1] ?? schedule.start, time)} onchange={(e) => adjust(index, e)}>
                days
              </label>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    <div class="actions">
      <button class="btn primary" disabled={!plan?.dates.length} onclick={savePlan}>Save schedule</button>
      {#if scope && data.schedules.some((item) => sameScope(item.scope, scope!))}
        <button class="btn bordered" onclick={removePlan}>Remove schedule</button>
      {/if}
    </div>
  {:else if page === 'due'}
    {#if canRemind}
      <label class="check">
        <input type="checkbox" checked={reminders} disabled={requestingReminders}
          onchange={(e) => { const next = e.currentTarget.checked; e.currentTarget.checked = reminders; void toggleReminders(next); }}>
        Remind me about due reviews while Radiant is running
      </label>
    {/if}
    {#if due.length}
      <ul class="entries">
        {#each due as item (item.scope.docId + '/' + (item.scope.nodeId ?? ''))}
          <li class="entry">
            <span><strong>{item.scope.title}</strong>
              <small>{item.scope.nodeId === null ? 'Whole map' : item.scope.mapTitle} · {localDate(item.dates[item.completed]) < localDate(now)
                ? 'Overdue since ' + dateFormat.format(item.dates[item.completed]) : 'Due today'}</small>
            </span>
            <button class="btn bordered" disabled={loading} onclick={() => void openDue(item)}>Start recall</button>
          </li>
        {/each}
      </ul>
    {:else}<p>No maps or branches due today.</p>{/if}
  {:else if page === 'history'}
    {#if scope?.nodeId !== null && scope}
      <label class="check"><input type="checkbox" bind:checked={historyBranchOnly}>Only {scope.title}</label>
    {/if}
    {#if records.length}
      <ul class="entries">
        {#each records as entry (entry.id)}
          <li class="history">
            <details>
              <summary><strong>{entry.scope.title}</strong>
                <small>{timeFormat.format(entry.finishedAt)} · {elapsed(entry.elapsedMs)} · {entry.results.length} rated</small>
              </summary>
              <ul class="entries">
                {#each entry.results as item (item.id)}
                  <li class="entry"><span>{item.label || 'Untitled'}</span>
                    <span class="status" data-status={item.outcome}>{outcomeName[item.outcome]}</span></li>
                {/each}
              </ul>
            </details>
          </li>
        {/each}
      </ul>
    {:else}<p>No completed recall sessions for this map.</p>{/if}
  {:else if page === 'strength' && session}
    <label class="check"><input type="checkbox" checked={previewStrength} onchange={(e) => toggleStrength(e.currentTarget.checked)}>Show latest recall results on the map</label>
    <ReviewTree nodes={session.rows} name="Map review strength">
      {#snippet card(id)}
        {@const outcome = previewStrength ? scores.get(id) : undefined}
        <div class="node-card" data-status={outcome}><strong>{byId.get(id)?.label || 'Untitled'}</strong>
          {#if outcome}<small>{outcomeName[outcome]}</small>{/if}
        </div>
      {/snippet}
    </ReviewTree>
  {:else if page === 'rebuild' && session}
    <RebuildCanvas expected={session.rows} source={session.doc} theme={c.theme} images={c.pipeline.imageInfo}
      onfinish={() => { reset(); show('setup'); }} />
  {/if}
</dialog>

<style>
  .launch { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 12px 10px; }
  dialog {
    width: min(740px, calc(100vw - 38px));
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
  dialog.rebuild { width: min(1150px, calc(100vw - 38px)); }
  dialog.hide-map::backdrop { background: var(--bg); }
  header, .settings, .actions, nav, .entry, .ratings {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  header { justify-content: space-between; }
  h2 { margin: 0; font-size: 1.25rem; }
  nav { margin: 14px 0; }
  nav button[aria-current] { background: var(--active); font-weight: 650; }
  .settings { margin: 14px 0; align-items: end; }
  .settings label, .answer { display: grid; min-width: 0; gap: 4px; }
  .settings select { max-width: min(270px, 73vw); }
  .actions { margin-top: 12px; }
  .answer { margin-top: 12px; }
  .answer .muted { display: inline; }
  input, select { padding: 5px 7px; max-width: 100%; border: 1px solid var(--line-strong); border-radius: 5px; color: var(--text); background: var(--field); font: inherit; }
  textarea { width: 100%; box-sizing: border-box; user-select: text; }
  .typed { white-space: pre-wrap; overflow-wrap: anywhere; }
  .typed strong { display: block; }
  .entries { list-style: none; margin: 0; padding: 0; }
  .entries > li { padding: 8px 0; border-bottom: 1px solid var(--line); }
  .entry { justify-content: space-between; overflow-wrap: anywhere; }
  .interval input { width: 5em; }
  .history summary { cursor: pointer; }
  .history small { margin-left: 15px; }
  small, .muted { color: var(--text-dim); }
  .entry small { display: block; margin-top: 3px; }
  .check { display: block; margin: 12px 0; }
  .node-card { padding: 8px 10px; background: var(--panel-solid); border: 1px solid var(--line-strong); border-radius: 6px; max-width: 180px; overflow-wrap: anywhere; text-align: center; }
  .node-card img { display: block; max-width: 90px; max-height: 72px; margin: 0 auto 4px; object-fit: contain; }
  .node-card small { display: block; margin-top: 3px; }
  .hidden-label { color: var(--text-dim); }
  [data-status="recalled"], [data-status="matched"] { --result: var(--ok); }
  [data-status="partly"], [data-status="misplaced"] { --result: var(--warn); }
  [data-status="missed"], [data-status="missing"] { --result: var(--danger); }
  [data-status="extra"] { --result: var(--accent); }
  .node-card[data-status], .ratings button[aria-pressed="true"] {
    border-color: var(--result);
    background: color-mix(in srgb, var(--panel-solid) 88%, var(--result));
  }
  .status { border-left: 3px solid var(--result); padding-left: 7px; }
  .error { color: var(--danger); }
</style>
