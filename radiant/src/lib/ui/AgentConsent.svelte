<script lang="ts">
  // The prompt for an agent that asked for access through the app's control socket (AGT-LIVE-04). Nothing is
  // shared until the user allows it here, and the user may give less than was asked for.
  import type { AppController } from './controller.svelte';
  import type { AgentAccessLevel } from './agent-session.svelte';

  let { c }: { c: AppController } = $props();
  let dialog: HTMLDialogElement;
  let access = $state<AgentAccessLevel>('read');
  const request = $derived(c.agent.request);
  const title = $derived.by(() => { void c.rev; return c.docTitle || 'Untitled map'; });

  $effect(() => {
    if (request) {
      access = request.access;
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  });
  const levels: [AgentAccessLevel, string, string][] = [
    ['read', 'Read only', 'See this map as you edit it, select nodes and move the view.'],
    ['write', 'Read and edit', 'Also add, change, style and move branches, links, presentations and drawings. Each batch is one Undo step.'],
    ['destructive', 'Read, edit and delete', 'Also delete branches, links and drawings.']
  ];
</script>

<dialog bind:this={dialog} aria-labelledby="agent-consent-heading"
  oncancel={(event) => { event.preventDefault(); void c.agent.answer(null); }}
  onkeydown={(event) => event.stopPropagation()} onkeyup={(event) => event.stopPropagation()}>
  {#if request}
    <h2 id="agent-consent-heading">Allow “{request.client}” to work with this map?</h2>
    <p>A program on this Mac that calls itself <strong>{request.client}</strong> is asking for live access to <strong>{title}</strong>. Radiant cannot verify the name: allow it only if you just asked your assistant to connect.</p>
    <fieldset>
      <legend>Access</legend>
      {#each levels as [level, label, detail] (level)}
        <label>
          <input type="radio" name="agent-access" value={level} bind:group={access}>
          <span><strong>{label}</strong>{level === request.access ? ' (requested)' : ''}<small>{detail}</small></span>
        </label>
      {/each}
    </fieldset>
    <p class="dim">Access ends after 15 minutes without requests, when you press Stop in the status bar, or when the map closes.</p>
    <div class="controls">
      <button class="btn bordered" onclick={() => void c.agent.answer(null)}>Don’t allow</button>
      <button class="btn primary" onclick={() => void c.agent.answer(access)}>Allow</button>
    </div>
  {/if}
</dialog>

<style>
  dialog {
    color: var(--text);
    background: var(--panel-solid);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    width: min(520px, calc(100vw - 54px));
    padding: 20px;
  }
  dialog::backdrop { background: rgb(0 0 0 / 48%); }
  h2 { margin: 0 0 8px; font-size: 1.24rem; }
  p { margin: 8px 0; }
  fieldset { margin: 12px 0; padding: 0; border: 0; display: grid; gap: 8px; }
  legend { padding: 0; margin-bottom: 6px; font-weight: 600; color: var(--text-dim); font-size: 12px; }
  label { display: flex; gap: 8px; align-items: flex-start; }
  label small { display: block; color: var(--text-dim); }
  .dim { color: var(--text-dim); }
  .controls { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
