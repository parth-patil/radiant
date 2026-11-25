<script lang="ts">
  import type {AppController} from './controller.svelte';
  import type {Op,StyleSheet} from '../core/types';
  import {SHEET_FONTS,SHEET_LAYOUTS,parseGeneratedStyle} from '../core/model/generated-style';
  import {THEME_BRANCHES,THEME_SHAPES} from '../core/model/theme-settings';
  let {c}:{c:AppController}=$props();
  const owner=$derived.by(()=>{
    void c.rev;
    let id=c.focusId;
    while(id && !c.doc.nodes[id]?.generatedStyle)id=c.doc.nodes[id]?.parent ?? null;
    return id;
  });
  const sheet=$derived.by(()=>{void c.rev;return owner ? c.doc.nodes[owner].generatedStyle : null;});
  function change(patch:Partial<StyleSheet>) {
    if(!owner||!sheet)return;
    const style=parseGeneratedStyle({...sheet,...patch});
    if(!style)return;
    const ops:Op[]=[{t:'set',id:owner,patch:{generatedStyle:style}}];
    const info=c.doc.rootInfo[owner];
    if(info && patch.layout)ops.push({t:'setRoot',id:owner,info:{...info,layout:patch.layout}});
    c.editor.apply({label:'Edit generated style sheet',source:'user',ops});
  }
</script>
{#if sheet}
  <details><summary>Generated map style</summary>
    {#if sheet.request}<p>{sheet.request}</p>{/if}
    {#if sheet.warnings?.length}<p>Defaults used for {sheet.warnings.join(', ')}.</p>{/if}
    <fieldset><legend>Branch palette</legend>
      {#each sheet.palette ?? [] as colour,index}
        <input type="color" value={colour} aria-label={'Branch palette colour '+(index+1)}
          onchange={e=>{const palette=[...(sheet?.palette ?? [])];palette[index]=e.currentTarget.value;change({palette});}}/>
      {/each}
    </fieldset>
    <label>Branch style <select value={sheet.branch} onchange={e=>change({branch:e.currentTarget.value as StyleSheet['branch']})}>
      {#each THEME_BRANCHES as style}<option value={style}>{style}</option>{/each}</select></label>
    <label>Node shape <select value={sheet.shape} onchange={e=>change({shape:e.currentTarget.value as StyleSheet['shape']})}>
      {#each THEME_SHAPES as shape}<option>{shape}</option>{/each}</select></label>
    {#if owner && c.doc.rootInfo[owner]}<label>Tree layout <select value={c.doc.rootInfo[owner].layout} onchange={e=>change({layout:e.currentTarget.value as StyleSheet['layout']})}>
      {#each SHEET_LAYOUTS as layout}<option>{layout}</option>{/each}</select></label>{/if}
    <label>Typeface <select aria-label="Typeface" value={sheet.fontFamily} onchange={e=>change({fontFamily:e.currentTarget.value})}>
      {#each SHEET_FONTS as font}<option value={font}>{font.split(',')[0].replaceAll('"','')}</option>{/each}</select></label>
    <label>Uppercase main branches <input type="checkbox" checked={sheet.uppercaseMainBranches}
      onchange={e=>change({uppercaseMainBranches:e.currentTarget.checked})}/></label>
    <label>Illustration medium <input value={sheet.medium ?? ''} onchange={e=>change({medium:e.currentTarget.value})}/></label>
    <label>Mood <input value={sheet.mood ?? ''} onchange={e=>change({mood:e.currentTarget.value})}/></label>
  </details>
{/if}
<style>
 details{margin:8px 0}summary{cursor:pointer}label{display:flex;align-items:center;justify-content:space-between;gap:5px;margin:6px 0;font-size:12px}
 fieldset{border:1px solid var(--line)}fieldset input{width:26px;height:23px;padding:0}label input:not([type]),select{max-width:55%}
</style>
