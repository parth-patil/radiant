<script lang="ts">
  import type { MapNode } from '../core/types';
  import type { AppController } from './controller.svelte';

  let { c, node }: { c: AppController; node: MapNode } = $props();
  const linked = $derived(c.remindersSync.linked(node.id));
</script>

{#if c.host.reminders && (node.task || linked)}
  <div class="reminders">
    {#if linked}
      <span>{node.task ? 'Completion syncs with Apple Reminders while this map is open.' : 'Add a task to resume completion sync.'}</span>
      <button class="btn bordered" disabled={c.remindersSync.busy} onclick={() => void c.remindersSync.changeLink(node.id)}>
        Disconnect Reminders
      </button>
    {:else if c.filePath}
      <span>Creates this task in your default Apple Reminders list.</span>
      <button class="btn bordered" disabled={c.remindersSync.busy || !node.text.trim()} onclick={() => void c.remindersSync.changeLink(node.id)}>
        Connect to Reminders
      </button>
    {:else}
      <span>Save this map to connect the task to Apple Reminders.</span>
    {/if}
    {#if c.remindersSync.error}
      <p role="status">{c.remindersSync.error}</p>
      {#if linked && node.task && /^(Allow Radiant|Reminders access|Reminders permission)/.test(c.remindersSync.error)}
        <button class="btn bordered" disabled={c.remindersSync.busy} onclick={() => void c.remindersSync.changeLink(node.id, true)}>
          Retry Reminders access
        </button>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .reminders { display: grid; justify-items: start; gap: 0.4rem; }
  span, p { margin: 0; font-size: 0.8em; }
</style>
