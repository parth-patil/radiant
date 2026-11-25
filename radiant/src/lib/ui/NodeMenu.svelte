<script lang="ts">
  import {onMount} from 'svelte';
  import type {AppController} from './controller.svelte';
  import type {MenuId} from '../host/types';
  import type {Representation} from '../core/types';
  let {c}:{c:AppController}=$props();
  let dialog:HTMLDialogElement;
  let scope=$state('all'),levels=$state(2);
  const modes:[Representation,string][]=[['vector','Vector'],['picture','Picture'],['svg','SVG']];
  const actions:[MenuId,string][]=[['add-child','Add child'],['duplicate','Duplicate'],['create-alias','Create Alias'],['edit-link','Edit link'],['arrange','Arrange'],['generate','Generate subtree…']];
  const folds:[MenuId,string][]=[['collapse-toggle','Fold or unfold'],['fold-siblings','Fold with siblings'],
    ['unfold-one','Unfold one level'],['fold-level','Fold to level…'],['unfold-all','Unfold all descendants']];
  onMount(()=>{
    dialog.showModal();
    const point=c.nodeMenu;
    if(point?.x!==undefined && point.y!==undefined){
      dialog.style.position = 'fixed';
      dialog.style.margin = '0';
      dialog.style.right = dialog.style.bottom = 'auto';
      const bounds = dialog.getBoundingClientRect();
      const scale = c.interfaceScale;
      dialog.style.left = Math.max(0, Math.min(point.x, innerWidth - bounds.width)) / scale + 'px';
      dialog.style.top = Math.max(0, Math.min(point.y, innerHeight - bounds.height)) / scale + 'px';
    }
  });
  function close(){c.nodeMenu=null;dialog.close();}
  function change(mode:Representation){
    c.setSelectedRepresentation(mode,scope==='all'?Infinity:scope==='node'?0:levels-1);
    close();
  }
</script>
<dialog bind:this={dialog} aria-label="Node actions" oncancel={e=>{e.preventDefault();close();}} onkeydown={e=>e.stopPropagation()}
  onclick={e=>{if(e.target===dialog){const b=dialog.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)close();}}}>
  <h3>{c.selIds.length>1?c.selIds.length+' selected nodes':c.focusId && (c.doc.nodes[c.focusId]?.text || 'Unnamed node')}</h3>
  <div class="actions">{#each actions as [id,label]}<button class="btn" onclick={()=>{close();void c.command(id);}}>{label}</button>{/each}
    {#if c.focusId && c.selIds.length<=1}{@const id=c.focusId}{@const has=!!c.doc.nodes[id]?.note}
      <button class="btn" onclick={()=>{close();c.toggleNote(id,!has);}}>{has?(c.openNotes.includes(id)?'Hide note':'Show note'):'Add note'}</button>{/if}</div>
  <div class="actions" role="group" aria-label="Folding">
    {#each folds as [id,label]}
      <button class="btn" onclick={()=>{close();void c.command(id);}}>{label}</button>
    {/each}
  </div>
  <label>Artwork scope <select bind:value={scope}><option value="all">Whole subtree</option>
    <option value="node">This node only</option><option value="levels">Selected levels</option></select></label>
  {#if scope==='levels'}<label>Levels including this node <input type="number" min="1" step="1" bind:value={levels}/></label>{/if}
  <div class="actions">{#each modes as [mode,label]}<button class="btn bordered" disabled={scope==='levels' && !(Number.isInteger(levels)&&levels>=1)}
    onclick={()=>change(mode)}>{label}</button>{/each}</div>
  <button class="btn" onclick={close}>Close</button>
</dialog>
<style>
 dialog{width:min(290px,90vw);border:1px solid var(--line);border-radius:8px;padding:10px;background:var(--panel);color:var(--text)}
 h3{font-size:14px;overflow-wrap:anywhere;margin:0 0 6px}.actions{display:flex;gap:4px;flex-wrap:wrap;margin:6px 0}
 label{font-size:12px;display:flex;align-items:center;justify-content:space-between;gap:5px;margin-top:7px}input{width:50px}
</style>
