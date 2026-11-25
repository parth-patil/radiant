<script lang="ts">
  import type {AppController} from './controller.svelte';
  let {c}:{c:AppController}=$props();
  const tags=$derived.by(()=>{
    void c.rev;
    const used=new Map<string,string>();
    for(const node of Object.values(c.doc.nodes)) for(const tag of node.tags ?? []) used.set(tag.toLowerCase(),tag);
    return [...used].sort(([,a],[,b])=>a.localeCompare(b)).map(([key,name])=>({key,name,color:c.doc.tagColors && Object.hasOwn(c.doc.tagColors,key) ? c.doc.tagColors[key] : '#68768a'}));
  });
  function colorTag(key:string,color:string) {
    c.editor.apply({label:'Change tag colour',source:'user',ops:[{t:'docMeta',patch:{tagColors:{...c.doc.tagColors,[key]:color}}}]});
  }
</script>
{#if tags.length}
  <details><summary>Tags</summary>
    {#each tags as tag (tag.key)}
      <div><input type="color" aria-label={'Colour for tag '+tag.name} value={tag.color} onchange={e=>colorTag(tag.key,e.currentTarget.value)}/>
        <button class="btn" aria-pressed={c.canvasFilter?.kind==='tag' && c.canvasFilter.value.toLowerCase()===tag.key}
          onclick={()=>c.setCanvasFilter({kind:'tag',value:tag.name})}>{tag.name}</button></div>
    {/each}
    {#if c.canvasFilter?.kind==='tag'}<button class="btn" onclick={()=>c.setCanvasFilter(null)}>Clear tag filter</button>{/if}
  </details>
{/if}
<style>details{margin:8px 0}summary{cursor:pointer}div{display:flex;align-items:center;gap:6px}input{width:24px;height:22px;padding:1px}</style>
