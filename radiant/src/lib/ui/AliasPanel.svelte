<script lang="ts">
  import type { MapNode } from '../core/types';
  import { aliasPeers } from '../core/model/aliases';
  import type { AppController } from './controller.svelte';

  let { c, node }: { c: AppController; node: MapNode } = $props();
  const peers = $derived.by(() => {
    void c.rev;
    return aliasPeers(c.doc, node);
  });

  function showNext() {
    const ids = [node.id, ...peers.map(peer => peer.id)].sort();
    const next = ids[(ids.indexOf(node.id) + 1) % ids.length];
    if (next) c.revealAlias(next);
  }
</script>

<details>
  <summary>Aliases{peers.length ? ' · ' + (peers.length + 1) : ''}</summary>
  <p>Aliases share the label, note, study answer, tasks, tags and link. Each occurrence has its own position, children, style and artwork.</p>
  <button class="btn bordered" onclick={() => void c.command('create-alias')}>Create Alias</button>
  {#if c.selIds.length === 2}<p>Creates an occurrence of the focused node under the other selected node.</p>{/if}
  {#if peers.length}
    <button class="btn bordered" onclick={showNext}>Go to next occurrence</button>
  {/if}
</details>

<style>
  details { margin: 8px 0; }
  summary { cursor: pointer; }
  p { font-size: 12px; margin: 3px 0; }
</style>
