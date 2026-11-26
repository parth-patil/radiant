<script lang="ts">
  import { onMount } from 'svelte';
  import './app.css';
  import { AppController } from './controller.svelte';
  import Connections from './Connections.svelte';
  import CanvasDock from './CanvasDock.svelte';
  import ElementHandles from './ElementHandles.svelte';
  import ElementStyleBar from './ElementStyleBar.svelte';
  import EdgePointers from './EdgePointers.svelte';
  import InkOverlay from './InkOverlay.svelte';
  import PictureHandles from './PictureHandles.svelte';
  import NodeBadges from './NodeBadges.svelte';
  import NodeHandles from './NodeHandles.svelte';
  import NodeNotes from './NodeNotes.svelte';
  import AgentConsent from './AgentConsent.svelte';
  import CanvasViewBar from './CanvasViewBar.svelte';
  import PresentationOverlay from './PresentationOverlay.svelte';
  import PresentationPanel from './PresentationPanel.svelte';
  import CanvasFilterPanel from './CanvasFilterPanel.svelte';
  import Minimap from './Minimap.svelte';
  import FoldLevel from './FoldLevel.svelte';
  import NodeMenu from './NodeMenu.svelte';
  import MapBrowser from './MapBrowser.svelte';
  import Finder from './Finder.svelte';
  import TopBar from './TopBar.svelte';
  import OutlinePanel from './OutlinePanel.svelte';
  import Inspector from './Inspector.svelte';
  import AiChangeSummary from './AiChangeSummary.svelte';
  import GeneratedDraftBar from './GeneratedDraftBar.svelte';
  import PromptPanel from './PromptPanel.svelte';
  import StatusBar from './StatusBar.svelte';
  import ReviewReminders from './ReviewReminders.svelte';
  import Dialog from './Dialog.svelte';
  import { basename } from './util';
  import { finishWebViewImport } from './settings';

  const c = new AppController();
  let canvas: HTMLCanvasElement;
  let ta: HTMLTextAreaElement;
  const canvasSelection = $derived.by(() => {
    void c.rev;
    const node = c.focusId ? c.doc.nodes[c.focusId] : undefined;
    if (!node) return 'No node selected.';
    const title = [node.sticker, node.text].filter(Boolean).join(' ') || 'Untitled node';
    return node.imageAsset ? `${title}. Picture: ${node.imageAlt ?? (node.text || 'Attached picture')}` : title;
  });

  $effect(() => {
    const title = `${c.dirty ? '• ' : ''}${c.docTitle}${c.filePath ? ' — ' + basename(c.filePath) : ''} — Radiant`;
    document.title = title;
    void c.host.setWindowTitle?.(title).catch(() => {});
  });

  const recoveryTitle = $derived.by(() => {
    const entry = c.recovery[0];
    if (entry) {
      try {
        const title = JSON.parse(entry.docJson)?.title;
        if (typeof title === 'string' && title.trim()) return title;
      } catch {
        // Keep the recovery controls available for an unreadable snapshot.
      }
    }
    return 'Untitled';
  });

  onMount(() => {
    const stopReminders = c.remindersSync.start();
    let cancelled = false;
    void (async () => {
      await c.init(canvas, ta);
      if (cancelled) return;
      const params = new URLSearchParams(location.search);
      const demo = params.get('demo');
      // VITE_RADIANT_BENCH=1 installs the same hooks in a production build, plus the benchmark adapter
      // (autoresearch/bench). Both are dropped from normal production builds.
      if (import.meta.env.DEV || import.meta.env.VITE_RADIANT_BENCH === '1') {
        const { installDebugHooks } = await import('./debug');
        installDebugHooks(c, params);
      }
      if (import.meta.env.VITE_RADIANT_BENCH === '1') {
        const { installBenchHooks } = await import('./bench-hooks');
        installBenchHooks(c);
      }
      if (!demo) {
        await c.checkRecovery();
        await c.checkDesktopSession();
      }
      // One-time copy of the WebView's old History snapshots into the host's state file.
      void finishWebViewImport(c.host);
    })();
    return () => {
      stopReminders();
      cancelled = true;
      c.destroy();
    };
  });
</script>

<ReviewReminders {c} />
<AgentConsent {c} />

<div class="app" style:--ui-scale={c.interfaceScale} style:--ui-top={c.topBarHeight+'px'} style:--ui-bottom={c.statusBarHeight+'px'} class:enlarged={c.interfaceScale>1} class:dark={c.darkChrome} inert={c.quitPending}>
  <div class="stage" data-keyboard-pane style:visibility={c.outlineOnly && c.showOutline ? 'hidden' : undefined}>
    <canvas class="map" bind:this={canvas} tabindex="0" aria-label="Mind map canvas" aria-describedby="canvas-selection"></canvas>
    <span class="canvas-selection" id="canvas-selection" aria-live="polite">{canvasSelection}</span>
    <PictureHandles {c} />
    <InkOverlay {c} />
    <Connections {c} />
    {#if c.ready && !c.presenting}<ElementHandles {c} />{/if}
    <NodeBadges {c} />
    <NodeHandles {c} />
    <NodeNotes {c} />
    <textarea
      class="inline-editor"
      bind:this={ta}
      style={c.editStyle()}
      spellcheck="true"
      aria-label="Node text"
      tabindex="-1"
      rows="1"
      oninput={() => c.onEditInput()}
      onblur={() => { if (c.finder !== 'commands') c.endEdit(); }}
    ></textarea>
    {#if c.ready && c.isEmpty && !c.busy && !c.editingId && !c.showPrompt && !c.canvasView}
      <div class="empty-hint">
        Start typing to name your central topic<br />
        <kbd>Tab</kbd> adds a branch
        {#if !c.recovery.length && !c.desktopSession.length}
          <form class="quick-generate" onsubmit={(event) => {
            event.preventDefault();
            if (!c.topic.trim()) return;
            c.showPrompt = true;
            void c.generate();
          }}>
            <input class="field" aria-label="Topic for AI map" placeholder="Topic for AI map" bind:value={c.topic} />
            <button class="btn bordered" type="submit" disabled={!c.topic.trim()}>Generate</button>
          </form>
        {/if}
      </div>
    {/if}
  </div>

  {#if !c.presenting}
    <TopBar {c} />
    {#if c.foldLevelFor}<FoldLevel {c} />{/if}
    {#if c.nodeMenu}<NodeMenu {c}/>{/if}
    {#if c.browsingMaps}<MapBrowser {c}/>{/if}
    {#if c.finder}<Finder {c} mode={c.finder} />{/if}
    {#if c.showOutline}<OutlinePanel {c} />{/if}
    {#if c.presentation.showPanel}<PresentationPanel {c} />{:else if c.showInspector}<Inspector {c} />{/if}
    {#if c.showPrompt}<PromptPanel {c} />{:else if c.ready && !c.gen && !c.recovery.length && !c.desktopSession.length && !c.unfinishedJobNotice}<GeneratedDraftBar {c} />{/if}
    {#if c.recovery.length && !c.showPrompt}
      <div class="banner" role="status">
        <span>
          Radiant found an unsaved map "{recoveryTitle}" from {new Date(c.recovery[0].savedAt).toLocaleString()}.
          {#if c.recovery[0].conflict === 'changed'} The saved file also changed. Recover as a separate map to keep both versions.
          {:else if c.recovery[0].conflict === 'older-format'} The original uses an older format. Recover as a separate map to keep the original.
          {:else if c.recovery[0].conflict} The original file is unavailable. Recover as a separate map.
          {/if}
        </span>
        {#if c.recovery[0].conflict}
          <button class="btn primary" onclick={() => c.restoreRecovered(true)}>Recover as Copy</button>
        {:else}
          <button class="btn primary" onclick={() => c.restoreRecovered()}>Restore</button>
          {#if c.recovery[0].path}<button class="btn bordered" onclick={() => c.restoreRecovered(true)}>Recover as Copy</button>{/if}
        {/if}
        <button class="btn bordered" onclick={() => void c.discardRecovered()}>Discard</button>
      </div>
    {/if}
    {#if c.desktopSession.length && !c.recovery.length && !c.showPrompt}
      <div class="banner" role="status">
        <span>Reopen {c.desktopSession.length === 1 ? 'the map' : c.desktopSession.length + ' maps'} from your last session?</span>
        <button class="btn primary" onclick={() => void c.finishDesktopSession(true)}>Reopen</button>
        <button class="btn bordered" onclick={() => void c.finishDesktopSession(false)}>Dismiss</button>
      </div>
    {/if}
    {#if c.unfinishedJobNotice && !c.recovery.length && !c.desktopSession.length && !c.showPrompt}
      <div class="banner" role="status" aria-label="Recovered AI work">
        <span>{c.unfinishedJobNotice}</span>
        <button class="btn bordered" onclick={() => c.unfinishedJobNotice = ''}>Dismiss</button>
      </div>
    {/if}
    <StatusBar {c} />
    <AiChangeSummary {c} floating />
    {#if c.ready && c.showMinimap}<Minimap {c} />{/if}
    {#if c.ready}<CanvasDock {c} /><ElementStyleBar {c} /><EdgePointers {c} />{/if}
    {#if c.showCanvasFilter}<CanvasFilterPanel {c} />{/if}
  {/if}
  {#if c.presenting}<PresentationOverlay {c} />{/if}
  <CanvasViewBar {c} />
  <div class="canvas-selection" role="status" aria-live="polite" aria-atomic="true">
    {#if c.gen}Generating map.{#if c.gen.liveGrowth} {Math.floor(c.gen.nodes/5)*5} nodes received.{/if}{:else if c.toast}{c.toast.text}{/if}
  </div>
  {#if c.toast}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="toast" class:error={c.toast.kind === 'error'} onclick={() => c.dismissToast()}>{c.toast.text}</div>
  {/if}
  {#if c.dialog}<Dialog d={c.dialog} />{/if}
</div>

{#if c.quitPending}
  <div class="banner" role="status">Waiting for the other map windows before quitting.</div>
{/if}

<style>
  .quick-generate { display: flex; gap: 6px; margin-top: 8px; pointer-events: auto; }
  .quick-generate input { min-width: 0; flex: 1; }
  .canvas-selection { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
