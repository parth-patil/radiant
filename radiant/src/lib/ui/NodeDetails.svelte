<script lang="ts">
  import RemindersPanel from './RemindersPanel.svelte';
  import { parseNodeLink } from './node-link';
  import type { AppController } from './controller.svelte';
  import { addLink, removeLink, subtreeIds } from '../core/model';
  import type { CrossLink, LinkStyle, MapNode, Op } from '../core/types';
  let { c, node }: {c: AppController; node: MapNode} = $props();
  const descendants = $derived.by(() => {
    void c.rev;
    return subtreeIds(c.doc,node.id).map(id => c.doc.nodes[id]).filter(n => n.task);
  });
  const completed = $derived(descendants.filter(n => n.task?.done).length);
  const links = $derived.by(() => {void c.rev;return c.doc.links.filter(l=>l.from===node.id || l.to===node.id).map(l=>({...l}));});
  function checkLink() {
    if (node.link) void c.checkMapLink(node.link).catch(() => {});
  }
  $effect(() => { checkLink(); });
  function apply(label: string, ops: Op[]) {if (ops.length) c.editor.apply({label,ops,source:'user'});}
  const commonTags = $derived.by(()=>{
    void c.rev;
    return (node.tags ?? []).filter(tag=>c.selIds.every(id=>c.doc.nodes[id]?.tags?.includes(tag)));
  });
  function editTags(value:string) {
    const wanted=[...new Set(value.split(',').map(tag=>tag.trim()).filter(Boolean))];
    const remove=new Set(commonTags.filter(tag=>!wanted.includes(tag)));
    const ops:Op[]=[];
    for (const id of c.selIds) {
      const existing=c.doc.nodes[id]?.tags ?? [];
      const tags=[...new Set([...existing.filter(tag=>!remove.has(tag)),...wanted])];
      if (tags.length!==existing.length || tags.some((tag,i)=>tag!==existing[i])) ops.push({t:'set',id,patch:{tags}});
    }
    apply('Edit tags',ops);
  }
  function styleLink(link:CrossLink,patch:LinkStyle) {
    const {id,from,to,label,...style}=link;
    apply('Style connection',[{t:'linkStyle',id,style:{...style,...patch}}]);
  }
  function connect(){
    const [from,to]=c.selIds;
    const e=addLink(c.doc,from,to);if(e)c.editor.apply(e.tx);
  }
</script>
<svelte:window onfocus={checkLink} />
<div class="sec">
  <label for="node-link">Node link</label>
  <input id="node-link" class="field" placeholder="Web address, file path or Radiant map link" value={node.link ?? ''}
    oninput={e=>e.currentTarget.setCustomValidity('')}
    onchange={e=>{
      const field=e.currentTarget;
      try {
        const link=field.value.trim() ? parseNodeLink(field.value).href : undefined;
        if(link!==node.link) apply('Edit node link',[{t:'set',id:node.id,patch:{link}}]);
      } catch { field.setCustomValidity('Enter a web address, absolute file path or Radiant map link.');field.reportValidity(); }
    }}/>
  {#if node.link}
    <button class="btn bordered" onclick={() => void c.followNodeLink(node.link!, node.id)}>Open link</button>
    {#if c.brokenMapLinks.has(node.link)}<p role="status">The linked map or node is missing.</p>{/if}
  {/if}
  <button class="btn bordered" onclick={() => void c.chooseLinkedMap(node.id)}>Link to map…</button>
  {#if c.filePath}<button class="btn bordered" onclick={() => void c.copyMapNodeLink(node.id)}>Copy link to this node</button>{/if}
  <button class="btn bordered" onclick={() => void c.extractBranch(node.id)}>Move branch to new map…</button>
</div>
<div class="sec">
  <label for="node-tags">Tags</label>
  <input id="node-tags" class="field" placeholder="Comma-separated tags" value={commonTags.join(', ')}
    onchange={e=>editTags(e.currentTarget.value)}/>
</div>
<div class="sec">
  <label for="task-state">Task</label>
  <select id="task-state" value={node.task ? node.task.done ? 'done' : 'open' : ''}
    onchange={e=>{const value=e.currentTarget.value;apply('Change task',c.selIds.map(id=>({t:'set',id,patch:{task:value?{done:value==='done'}:undefined}})));}}>
    <option value="">None</option><option value="open">Open</option><option value="done">Completed</option>
  </select>
  <RemindersPanel {c} {node} />
  {#if descendants.length}
    <div>{completed} of {descendants.length} complete ({Math.round(100*completed/descendants.length)}%)</div>
    <button class="btn bordered" onclick={()=>apply('Update branch tasks',descendants.filter(n=>n.task?.done===(completed===descendants.length)).map(n=>({t:'set',id:n.id,patch:{task:{done:completed!==descendants.length}}})))}>
      {completed===descendants.length?'Reopen branch tasks':'Complete branch tasks'}
    </button>
  {/if}
</div>
<div class="sec">
  <div class="lbl">Connections</div>
  <button class="btn bordered" title="Select two nodes to connect them" disabled={c.selIds.length!==2} onclick={connect}>Connect selected nodes</button>
  {#each links as link (link.id)}
    <label for={'link-'+link.id}>{c.doc.nodes[link.from===node.id?link.to:link.from]?.text}</label>
    <input id={'link-'+link.id} class="field" placeholder="Connection label" value={link.label ?? ''} onchange={e=>apply('Label connection',[{t:'setLink',id:link.id,label:e.currentTarget.value}])}/>
    <label>Colour <input type="color" value={link.color ?? '#646a75'} onchange={e=>styleLink(link,{color:e.currentTarget.value})}/></label>
    <label>Line <select value={link.dash ?? 'dashed'} onchange={e=>styleLink(link,{dash:e.currentTarget.value as LinkStyle['dash']})}><option value="dashed">Dashed</option><option value="solid">Solid</option></select></label>
    <label>Arrowheads <select value={link.arrows ?? 'none'} onchange={e=>styleLink(link,{arrows:e.currentTarget.value as LinkStyle['arrows']})}>{#each ['none','start','end','both'] as side}<option value={side}>{side}</option>{/each}</select></label>
    <button class="btn" onclick={()=>styleLink(link,{bend:undefined})}>Reset bend</button>
    <button class="btn" onclick={()=>{const e=removeLink(c.doc,link.id);if(e)c.editor.apply(e.tx)}}>Remove connection</button>
  {/each}
</div>
