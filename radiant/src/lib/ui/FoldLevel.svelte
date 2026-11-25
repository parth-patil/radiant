<script lang="ts">
  import {onMount} from 'svelte';
  import type {AppController} from './controller.svelte';
  let {c}:{c:AppController}=$props();
  let dialog:HTMLDialogElement, input:HTMLInputElement, depth=$state(1);
  onMount(()=>{dialog.showModal();input.select();});
</script>
<dialog bind:this={dialog} class="dialog" aria-label="Fold branch to level" onclose={()=>c.foldLevelFor=null}
  onkeydown={e=>e.stopPropagation()}>
  <form onsubmit={e=>{e.preventDefault();c.foldToLevel(depth);}}>
    <label>Levels to show below this node
      <input bind:this={input} type="number" min="0" step="1" required bind:value={depth}/>
    </label>
    <div class="btns"><button type="button" class="btn" onclick={()=>dialog.close()}>Cancel</button>
      <button class="btn primary">Apply</button></div>
  </form>
</dialog>
