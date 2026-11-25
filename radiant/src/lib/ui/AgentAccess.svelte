<script lang="ts">
  // The Inspector's view of the window's agent session (ui/agent-session.svelte.ts owns the grant and its work).
  import type { AppController } from './controller.svelte';

  let { c }: { c: AppController } = $props();

  const INTRO_KEY = 'radiant:agent-intro-seen:v1';
  let intro: HTMLDialogElement;
  let details = $state(false);
  let enabling = $state(false);
  let requestedWritable = $state(false);
  let allowDeletes = $state(false);
  let copied = $state('');

  const agent = $derived(c.agent);
  const transport = $derived(agent.transport);
  const session = $derived(agent.session);
  const pending = $derived(agent.pending);
  const status = $derived(copied || agent.status);
  const credentials = $derived(session && !session.path.startsWith('untitled:') && JSON.stringify({
    RADIANT_AGENT_SOCKET: session.grant.socket,
    RADIANT_AGENT_DOCUMENT: session.document.id,
    RADIANT_AGENT_PATH: session.grant.path,
    RADIANT_AGENT_TOKEN: session.grant.token
  }, null, 2));

  function openExplanation(enableOnAccept: boolean) {
    enabling = enableOnAccept;
    intro.showModal();
  }

  function requestGrant(writable: boolean) {
    let seen = false;
    try { seen = localStorage.getItem(INTRO_KEY) === '1'; }
    catch { /* Show consent when storage is unavailable. */ }
    requestedWritable = writable;
    if (seen) void allow(writable);
    else openExplanation(true);
  }

  function acknowledge() {
    intro.close();
    if (enabling) {
      try { localStorage.setItem(INTRO_KEY, '1'); }
      catch { /* The grant is still session-local. */ }
      void allow(requestedWritable);
    }
  }

  function allow(writable: boolean) {
    copied = '';
    if (!c.filePath) return;
    return agent.allow(writable, allowDeletes);
  }

  function revoke() {
    copied = '';
    details = false;
    agent.revoke();
  }

  async function copy() {
    if (!credentials) return;
    try {
      await navigator.clipboard.writeText(credentials);
      copied = 'Connection details copied.';
    } catch {
      copied = 'Select and copy the connection details below.';
    }
  }
</script>

<div class="agent">
  <strong>Local agent access</strong>
  <div class="controls">
    {#if transport}
      <label class="toggle">
        <input type="checkbox" checked={session?.writable === true}
          disabled={pending || !c.filePath || (session !== null && !session.writable)} onchange={(event) => {
          event.currentTarget.checked = session?.writable === true;
          if (session) revoke();
          else requestGrant(true);
        }}>
        Allow agent writes to this map
      </label>
      {#if !session}
        <label class="toggle">
          <input type="checkbox" bind:checked={allowDeletes} disabled={pending || !c.filePath}>
          Also allow deletes
        </label>
      {/if}
      {#if session && !session.writable}
        <button class="btn bordered" onclick={() => revoke()}>End live read access</button>
      {:else if !session}
        <button class="btn bordered" disabled={pending || !c.filePath} onclick={() => requestGrant(false)}>Allow live reads</button>
      {/if}
      {#if !c.filePath && !session}<small>Save this map to grant access by hand. An assistant that asks from its own side (for example Claude Code) can be allowed on an unsaved map.</small>{/if}
    {/if}
    <button class="btn bordered" onclick={() => openExplanation(false)}>About agent access</button>
  </div>
  {#if status}<p role="status">{status}</p>{/if}
  {#if session}
    <p>{session.client ? session.client + ': ' : ''}{session.destructive ? 'reads, edits and deletes' : session.writable ? 'reads and edits' : 'reads only'}. Live access ends after 15 minutes without requests, when you stop it, or when the map closes.</p>
    {#if credentials}
      <button class="btn bordered" aria-expanded={details} onclick={() => (details = !details)}>
        {details ? 'Hide connection details' : 'Show connection details'}
      </button>
    {/if}
    {#if details && credentials}
      <p>Set these variables in your local agent’s environment. Start the MCP server with <code>{session.writable ? 'mcp --write' : 'mcp'}</code> and list the saved maps you want it to access.</p>
      <pre>{credentials}</pre>
      <button class="btn bordered" onclick={() => void copy()}>Copy connection details</button>
    {/if}
  {/if}
</div>

<dialog bind:this={intro} aria-labelledby="agent-access-heading"
  onkeydown={(event) => event.stopPropagation()} onkeyup={(event) => event.stopPropagation()}>
  <h2 id="agent-access-heading">{enabling ? 'Allow this agent connection?' : 'About local agent access'}</h2>
  <p>MCP lets a coding assistant use tools from another app. Radiant’s MCP server runs on this device. A live grant lets an assistant read current edits to this map and move the view; it ends after 15 minutes without requests. An assistant can also ask for access itself, and Radiant then shows a prompt naming it. Other explicitly listed files are read from disk.</p>
  <p>Write access is off by default. A write grant also lets the assistant add, edit, style and move branches, links, presentations and canvas elements. Deleting needs "Also allow deletes". Each submitted batch is one Undo step.</p>
  <p>Press Stop in the status bar, end the grant here or close the map to revoke live access. To stop sharing saved files through MCP, stop the local server and remove its entry from your assistant’s settings.</p>
  <div class="controls">
    <button class="btn bordered" onclick={() => intro.close()}>{enabling ? 'Cancel' : 'Close'}</button>
    {#if enabling}<button class="btn primary" onclick={acknowledge}>{requestedWritable ? 'Allow writes' : 'Allow live reads'}</button>{/if}
  </div>
</dialog>

<style>
  .agent { padding: 10px 0; border-top: 1px solid var(--line); }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
  .toggle { display: flex; gap: 6px; align-items: center; }
  .controls > .toggle { flex: 1 0 100%; }
  pre { user-select: text; white-space: pre-wrap; overflow-wrap: anywhere; padding: 6px; background: var(--field); border: 1px solid var(--line); border-radius: 5px; }
  dialog {
    color: var(--text);
    background: var(--panel-solid);
    border: 1px solid var(--line);
    border-radius: 14px;
    box-shadow: var(--shadow);
    width: min(500px, calc(100vw - 54px));
    padding: 20px;
  }
  dialog::backdrop { background: rgb(0 0 0 / 48%); }
  h2 { margin: 0; font-size: 1.24rem; }
</style>
