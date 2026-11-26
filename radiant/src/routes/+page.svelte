<script lang="ts">
  import { page } from '$app/state';
  import { getHost } from '../lib/host';
  import { initSettings } from '../lib/ui/settings';
  import App from '../lib/ui/App.svelte';
  import QuickCapture from '../lib/ui/QuickCapture.svelte';
  import PresenterConsole from '../lib/ui/PresenterConsole.svelte';

  // Every route reads settings synchronously, some while constructing; load them first (never rejects).
  const settingsReady = initSettings(getHost());
</script>

{#await settingsReady then}
  {#if page.url.searchParams.get('quick-capture') === '1'}
    <QuickCapture />
  {:else if page.url.searchParams.get('presenter') === '1'}
    <PresenterConsole />
  {:else}
    <App />
  {/if}
{/await}
