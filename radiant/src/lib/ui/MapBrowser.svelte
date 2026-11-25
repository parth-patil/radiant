<script lang="ts">
  import {onMount} from 'svelte';
  import type {AppController} from './controller.svelte';
  import type {FolderMap} from '../host/types';
  import MapThumbnail from './MapThumbnail.svelte';
  let {c}:{c:AppController}=$props();
  let dialog:HTMLDialogElement;
  let folder=$state(''),maps=$state.raw<FolderMap[]>([]),filter=$state(''),message=$state(''),loading=$state(false);
  let selected=$state('');
  const visible=$derived(maps.filter(map=>map.name.toLowerCase().includes(filter.trim().toLowerCase())));
  async function pick(){
    loading=true;message='';
    try {
      const result=await c.host.browseMapFolder();
      if(result){maps=result.maps;folder=result.folder;filter='';selected='';}
    }catch(error){message=String(error);}
    finally{loading=false;}
  }
  function open(path:string){dialog.close();void c.openDoc(path);}
  onMount(()=>{dialog.showModal();void pick();});
</script>
<dialog bind:this={dialog} aria-labelledby="library-heading" onclose={()=>c.browsingMaps=false}
  onkeydown={event=>event.stopPropagation()}>
  <header><h2 id="library-heading">Map browser</h2><button class="btn" onclick={()=>dialog.close()}>Close</button></header>
  <div class="tools"><button class="btn bordered" disabled={loading} onclick={pick}>Choose folder…</button>
    <input aria-label="Search map names" placeholder="Search map names…" bind:value={filter}/>
    <button class="btn bordered" disabled={!visible.some(map=>map.path===selected)} onclick={()=>open(selected)}>Open</button></div>
  {#if folder}<p>{folder}</p>{/if}
  {#if loading}<p role="status">Reading folder…</p>{:else if message}<p role="alert">{message}</p>
  {:else if !visible.length}<p>{filter?'No matching maps.':folder?'This folder contains no Radiant maps.':'Choose a folder to see its maps.'}</p>{/if}
  <div class="grid">
    {#each visible as map (map.path)}
      <button class="card" title={map.path} aria-pressed={selected===map.path} onclick={()=>selected=map.path} ondblclick={()=>open(map.path)} onkeydown={e=>{
        if(e.key==='Enter'||e.key===' '){e.preventDefault();open(map.path);}
      }}>
        <MapThumbnail host={c.host} path={map.path}/>
        <strong>{map.name}</strong>{#if map.modified!==null}<time datetime={new Date(map.modified).toISOString()}>{new Date(map.modified).toLocaleString()}</time>{/if}
      </button>
    {/each}
  </div>
</dialog>
<style>
 dialog{width:min(760px,90vw);max-height:82vh;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:16px}
 header,.tools{display:flex;justify-content:space-between;align-items:center;gap:12px}h2{margin:0 0 12px;font-size:18px}
 input{flex:1;min-width:0;padding:6px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
 .card{display:grid;gap:4px;padding:6px;background:transparent;border:1px solid var(--line);border-radius:6px;color:inherit;text-align:left;cursor:pointer}
.card[aria-pressed=true]{outline:2px solid var(--accent)}
 strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}time,p{font-size:12px;color:var(--text-dim)}
</style>
