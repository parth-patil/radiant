<script lang="ts">
  import { THEME_BRANCHES, THEME_SHAPES } from '../core/model/theme-settings';
  import { branchName, shapeName } from './style-labels';
  import AliasPanel from './AliasPanel.svelte';
  import InkPanel from './InkPanel.svelte';
  import PicturePanel from './PicturePanel.svelte';
  import StickerPanel from './StickerPanel.svelte';
  import AgentAccess from './AgentAccess.svelte';
  import AppInfo from './AppInfo.svelte';
  import ShortcutSettings from './ShortcutSettings.svelte';
  import CanvasInputSettings from './CanvasInputSettings.svelte';
  import AiEngineSettings from './AiEngineSettings.svelte';
  import HistoryPanel from './HistoryPanel.svelte';
  import BranchLayoutPanel from './BranchLayoutPanel.svelte';
  import TagPanel from './TagPanel.svelte';
  import ThemeSettings from './ThemeSettings.svelte';
  import StyleTools from './StyleTools.svelte';
  import AiProvenancePanel from './AiProvenancePanel.svelte';
  import NodeDetails from './NodeDetails.svelte';
  import NotePreview from './NotePreview.svelte';
  import GeneratedStylePanel from './GeneratedStylePanel.svelte';
  import ArtPanel from './ArtPanel.svelte';
  import SvgInspection from './SvgInspection.svelte';
  import RefinePanel from './RefinePanel.svelte';
  import ReviewPanel from './ReviewPanel.svelte';
  import ExportPanel from './ExportPanel.svelte';
  import type { AppController } from './controller.svelte';
  import { LAYOUT_NAMES } from './controller.svelte';
  import type { LayoutKind } from '../core/types';
  import { rootOf } from '../core/model';

  let refinePanel: ReturnType<typeof RefinePanel> | undefined = $state();
  let { c }: { c: AppController } = $props();

  const node = $derived.by(() => {
    void c.rev;
    void c.selTick;
    const focused = c.focusId && c.doc.nodes[c.focusId];
    return focused ? { ...focused } : null;
  });
  const rootId = $derived(node ? rootOf(c.doc, node.id) : null);
  const layout = $derived.by(() => {
    void c.rev;
    return rootId ? c.doc.rootInfo[rootId]?.layout ?? 'mindmap' : 'mindmap';
  });
  const colors = $derived(c.theme.branchColors);
  const layouts = Object.keys(LAYOUT_NAMES) as LayoutKind[];

  let note = $state('');
  let noteFor: string | null = null;
  let noteTimer = 0;
  $effect(() => {
    const n = node;
    if (!n) {
      note = '';
      noteFor = null;
      return;
    }
    if (noteFor !== n.id || document.activeElement?.id !== 'note-field') {
      note = n.note ?? '';
      noteFor = n.id;
    }
  });
  function flushNote() {
    clearTimeout(noteTimer);
    if (noteFor && c.doc.nodes[noteFor] && (c.doc.nodes[noteFor].note ?? '') !== note) c.setNoteOf(noteFor, note);
  }
  function onNote() {
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(flushNote, 700);
  }

</script>

<aside class="side right" data-keyboard-pane aria-label="Inspector">
  <h3>Inspector</h3>
  <div class="inspector-body">
    <ExportPanel {c} />
    <HistoryPanel {c} />
    <AppInfo {c} />
    <ShortcutSettings {c} />
    <CanvasInputSettings {c} />
    <AiEngineSettings {c} />
    <AgentAccess {c} />
    <ThemeSettings {c} />
    <TagPanel {c} />
    <StickerPanel {c} {node} />
    <ReviewPanel {c} />
    <RefinePanel {c} bind:this={refinePanel} />
    <GeneratedStylePanel {c} />
    <ArtPanel {c} />
    <SvgInspection {c} />
  {#if !node}
    <div class="hint">Select a node to edit its note, colour, shape and style.</div>
  {:else}
      <div class="sec" style="margin-top:2px">
        <label for="note-field">Note{c.selIds.length > 1 ? ' (first selected)' : ''}</label>
        <textarea
          id="note-field"
          class="field"
          placeholder="Add a note…"
          bind:value={note}
          oninput={onNote}
          onblur={flushNote}
          spellcheck="true"
        ></textarea>
        <NotePreview {note} open={url => { void c.host.openNodeUrl(url).catch(error => c.say(String(error), 'error')); }} />
      </div>

      <div class="sec">
        <div class="lbl">Branch colour{c.selIds.length > 1 ? ` (${c.selIds.length} nodes)` : ''}</div>
        <div class="swatches">
          <button class="sw auto" class:sel={!node.style?.color} title="Automatic" aria-label="Automatic colour" onclick={() => c.styleSelection({ color: undefined })}></button>
          {#each colors as col (col)}
            <button
              class="sw"
              class:sel={node.style?.color === col}
              style="background:{col}"
              title={col}
              aria-label="Colour {col}"
              onclick={() => c.styleSelection({ color: col })}
            ></button>
          {/each}
        </div>
      </div>

      <div class="sec">
        <label for="node-shape">Shape</label>
        <select id="node-shape" value={node.style?.shape ?? ''} onchange={(event) =>
          c.styleSelection({ shape: THEME_SHAPES.find((shape) => shape === event.currentTarget.value) })}>
          <option value="">Theme shape</option>
          {#each THEME_SHAPES as shape (shape)}<option value={shape}>{shapeName[shape]}</option>{/each}
        </select>
      </div>

      <div class="sec">
        <label for="node-branch-style">Branch style</label>
        <select id="node-branch-style" value={node.style?.branch ?? ''} onchange={(event) =>
          c.styleSelection({ branch: THEME_BRANCHES.find((branch) => branch === event.currentTarget.value) })}>
          <option value="">Inherited style</option>
          {#each THEME_BRANCHES as branch (branch)}<option value={branch}>{branchName[branch]}</option>{/each}
        </select>
      </div>

      <div class="sec">
        <div class="lbl">Emphasis</div>
        <div class="seg">
          {#each [[0, 'Normal'], [1, 'Strong'], [2, 'Key']] as [v, label] (v)}
            <button aria-pressed={(node.style?.emphasis ?? 0) === v} class:on={(node.style?.emphasis ?? 0) === v} onclick={() => c.styleSelection({ emphasis: v === 0 ? undefined : (v as 1 | 2) })}>{label}</button>
          {/each}
        </div>
      </div>

      <StyleTools {c} />
      <NodeDetails {c} {node} />
      {#key node.id}<AiProvenancePanel {c} {node} openRefinement={(job, prompt) => refinePanel?.openSavedPrompt(job, prompt)} />{/key}
      <BranchLayoutPanel {c} />
      {#if rootId}
        <div class="sec">
          <label for="root-layout">Layout of this map</label>
          <select id="root-layout" value={layout} onchange={(e) => c.setRootLayout(rootId, e.currentTarget.value as LayoutKind)}>
            {#each layouts as l (l)}<option value={l}>{LAYOUT_NAMES[l]}</option>{/each}
          </select>
        </div>
      {/if}

      {#key node.id}
        <PicturePanel {c} {node} />
        <InkPanel {c} {node} />
        <AliasPanel {c} {node} />
      {/key}
  {/if}
  </div>
</aside>
