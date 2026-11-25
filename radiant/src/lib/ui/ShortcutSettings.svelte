<script lang="ts">
  import { onDestroy } from 'svelte';
  import { chord, commands, preset } from './keymap';
  import type { MenuId } from '../host/types';
  import type { AppController } from './controller.svelte';
  let { c }: {c:AppController} = $props();
  let recording = $state<MenuId|null>(null), message = $state('');
  async function nativeKeys(enabled: boolean) {
    const bindings=enabled ? $state.snapshot(c.shortcuts) : Object.fromEntries(commands.map(([id])=>[id,'']));
    await c.host.setMenuKeys?.(bindings);
  }
  function stopRecording() {
    if (recording===null) return;
    recording=null;
    void nativeKeys(true).catch(error=>message=String(error));
  }
  onDestroy(stopRecording);
  async function capture(event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!recording) return;
    if (event.key === 'Escape') { stopRecording(); return; }
    const binding=chord(event);
    if (!binding) return;
    const conflict=commands.find(([id])=>id!==recording && c.shortcuts[id]===binding);
    if (conflict) { message='Already assigned to '+conflict[1]+'.'; return; }
    if (['Space','Mod+Q','Mod+C','Mod+V','Mod+X'].includes(binding)) {
      message='This shortcut is reserved for panning or a system command.'; return;
    }
    try { await c.setShortcuts('Custom',{...c.shortcuts,[recording]:binding}); message='Shortcut saved.'; }
    catch (error) { message=String(error); }
    recording=null;
  }
</script>
<details><summary>Keyboard shortcuts</summary>
  <label>Preset <select aria-label="Preset" value={c.shortcutPreset} onchange={async e=>{
    const name=e.currentTarget.value;
    try {await c.setShortcuts(name,preset(name));recording=null;message='';}
    catch(error){message=String(error);}
  }}><option>Radiant</option><option>MindNode</option>{#if c.shortcutPreset==='Custom'}<option>Custom</option>{/if}</select></label>
  <div class="keys">
  {#each commands as [id,label]}
    <label>{label}
      <button class="btn bordered" aria-label={'Shortcut for '+label}
        onclick={async ()=>{recording=id;message='';try {await nativeKeys(false);} catch(error){message=String(error);stopRecording();}}}
        onblur={()=>{if(recording===id)stopRecording();}}
        onkeydown={e=>{if(recording===id)void capture(e);}}>
        {recording===id?'Press keys…':c.shortcuts[id] || 'Assign'}
      </button>
    </label>
  {/each}
  </div>
  <span role="status">{message}</span>
</details>
<style>
 details{margin:8px 0}summary{cursor:pointer}.keys{max-height:260px;overflow:auto}
 label{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:5px 0;font-size:12px}
</style>
