<script lang="ts">
  import { page } from '$app/state';
  import App from '../lib/ui/App.svelte';
  import QuickCapture from '../lib/ui/QuickCapture.svelte';
  import PresenterConsole from '../lib/ui/PresenterConsole.svelte';
</script>

{#if page.url.searchParams.get('quick-capture') === '1'}
  <QuickCapture />
{:else if page.url.searchParams.get('presenter') === '1'}
  <PresenterConsole />
{:else}
  <App />
{/if}
