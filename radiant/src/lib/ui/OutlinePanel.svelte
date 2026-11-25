<script lang="ts">
  import { wordParts } from '../core/model/repeated-words';
  import { readableLabel } from '../core/model/markdown';
  import { tick } from 'svelte';
  import { addChild, addSibling, detach, moveSubtree, prevSibling, outlineFromSubtree, toIndentedText, isAncestor } from '../core/model';
  import {toMarkdownOutline,parseMarkdownOutline} from '../core/io';
  import type {Doc, Op} from '../core/types';
  import type { AppController } from './controller.svelte';
  import Icon from './Icon.svelte';
  let { c }: { c: AppController } = $props();
  let filter = $state('');
  let limit = $state(1500);
  const rows = $derived.by(() => {
    void c.rev;
    const q = filter.trim().toLowerCase();
    if (!q) return c.outlineRows(limit + 1);
    const keep=new Set<string>();
    for (const node of Object.values(c.doc.nodes)) {
      if (![node.text,node.note,...(node.tags ?? [])].some(s=>s?.toLowerCase().includes(q))) continue;
      for(let id:string|null=node.id;id && !keep.has(id);id=c.doc.nodes[id].parent) keep.add(id);
    }
    const result:ReturnType<typeof c.outlineRows>=[];
    const queue=c.doc.roots.map(id=>({id,depth:0})).reverse();
    while(queue.length && result.length<=limit) {
      const {id,depth}=queue.pop()!;
      if (!keep.has(id)) continue;
      const node=c.doc.nodes[id];
      result.push({id,depth,text:node.text,hasChildren:!!node.children.length,collapsed:!!node.collapsed});
      for(let i=node.children.length-1;i>=0;i--)queue.push({id:node.children[i],depth:depth+1});
    }
    return result;
  });
  let list: HTMLDivElement;
  let filterInput:HTMLInputElement;
  let showDetails=$state(false), scope=$state('selection');
  let dragged = $state.raw<{id: string; x: number; doc: Doc} | null>(null);
  type DropZone = 'before' | 'after' | 'child';
  let dropHint = $state<{id: string; zone: DropZone} | null>(null);
  async function output(format:'opml'|'markdown'|'plain') {
    const wholeMap = scope === 'map' || !c.selIds.length;
    if (format === 'opml') {
      c.showInspector = true;
      c.exportRequest = { format: 'opml', scope: wholeMap ? 'map' : 'selection' };
      return;
    }
    const ids=wholeMap ? c.doc.roots : c.selIds.filter(id=>!c.selIds.some(other=>isAncestor(c.doc,other,id)));
    const nodes=ids.map(id=>outlineFromSubtree(c.doc,id));
    try {
      await navigator.clipboard.writeText(format==='markdown'?toMarkdownOutline(nodes):toIndentedText(nodes));
    } catch(error){c.say(String(error),'error');}
  }
  function dropTarget(event: DragEvent, id: string): {id: string; zone: DropZone} {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const y = (event.clientY - bounds.top) / bounds.height;
    const levels = Math.round(((dragged?.x ?? event.clientX) - event.clientX) / 14);
    if (levels < 0) return {id, zone: 'child'};
    let anchor = id;
    for (let i = 0; i < levels; i++) {
      const ancestor = c.doc.nodes[anchor].parent;
      if (!ancestor) break;
      anchor = ancestor;
    }
    const zone = y < 0.25 ? 'before' : y > 0.75 || levels > 0 ? 'after' : 'child';
    return {id: anchor, zone};
  }

  function dragOver(event: DragEvent, id: string) {
    if (!dragged) return;
    event.preventDefault();
    dropHint = dropTarget(event, id);
  }

  async function drop(event: DragEvent, id: string) {
    if (!dragged) return;
    event.preventDefault();
    event.stopPropagation();
    const {id: source, doc} = dragged;
    const {id: anchor, zone} = dropTarget(event, id);
    dragged = null;
    dropHint = null;
    if (!(await c.editor.settled()) || c.doc !== doc || !doc.nodes[source] || !doc.nodes[anchor]) return;
    const parent = zone === 'child' ? anchor : doc.nodes[anchor].parent;
    const siblings = parent === null ? c.doc.roots : c.doc.nodes[parent].children;
    const others = siblings.filter((node) => node !== source);
    if (zone !== 'child' && anchor === source) return;
    const index = zone === 'child' ? others.length : others.indexOf(anchor) + Number(zone === 'after');
    if (siblings[index] === source) return;
    if (parent !== null) {
      const edit = moveSubtree(c.doc, source, parent, index);
      if (edit) c.editor.apply(edit.tx, () => reveal(source));
      return;
    }
    const box = c.pipeline.layout.boxes.get(source);
    const detached = box && c.doc.nodes[source].parent !== null ? detach(c.doc, source, {x: box.x, y: box.y}) : null;
    const ops: Op[] = detached ? detached.tx.ops.map((op) => op.t === 'move' ? {...op, index} : op) :
      [{t: 'move', id: source, parent: null, index}];
    c.editor.apply({label: 'Move outline row', source: 'user', ops}, () => reveal(source));
  }

  let editing = $state<string | null>(null);
  let draft = $state('');
  let editor = $state<HTMLInputElement>();
  function reveal(id: string) {
    for (let p = c.doc.nodes[id]?.parent; p; p = c.doc.nodes[p].parent) {
      if (c.doc.nodes[p].collapsed) c.toggleFoldOf(p);
    }
    c.flush(); c.selectFromOutline(id);
  }
  async function edit(id: string, caret?:number) {
    reveal(id); editing=id; draft=c.doc.nodes[id].text; await tick(); editor?.focus(); if(caret===undefined)editor?.select();else editor?.setSelectionRange(caret,caret);
  }
  function commit() {
    if (!editing) return;
    c.setNodeText(editing, draft);
    editing=null;
  }
  async function key(e: KeyboardEvent,id: string) {
    if(e.isComposing) return;
    const mod=e.metaKey||e.ctrlKey;
    if(editing && editor) {
      const from=editor.selectionStart ?? 0, to=editor.selectionEnd ?? from;
      if(e.key==='Enter'){
        e.preventDefault();e.stopPropagation();
        const sibling=addSibling(c.doc,id,true);
        if(!sibling?.focus)return;
        const value=editor.value;
        const ops:Op[]=[{t:'set',id,patch:{text:value.slice(0,from)}},...sibling.tx.ops,{t:'set',id:sibling.focus,patch:{text:value.slice(to)}}];
        c.doc.nodes[id].children.forEach((child,index)=>ops.push({t:'move',id:child,parent:sibling.focus!,index}));
        editing=null;
        const next = sibling.focus;
        c.editor.apply({label:'Split outline line',source:'user',ops}, () => { void edit(next,0); });
        return;
      }
      if(e.key==='Backspace' && from===0 && to===0){
        const previous=rows[rows.findIndex(r=>r.id===id)-1]?.id;
        if(!previous)return;
        e.preventDefault();e.stopPropagation();
        const node=c.doc.nodes[id], prior=c.doc.nodes[previous], caret=prior.text.length;
        const ops:Op[]=[{t:'set',id:previous,patch:{text:prior.text+editor.value,note:[prior.note,node.note].filter(Boolean).join('\n')||undefined}}];
        node.children.forEach((child,i)=>ops.push({t:'move',id:child,parent:previous,index:prior.children.length+i}));
        for(const link of c.doc.links)if(link.from===id||link.to===id){
          ops.push({t:'unlink',id:link.id});
          const from=link.from===id?previous:link.from,to=link.to===id?previous:link.to;
          if(from!==to)ops.push({t:'link',link:{...link,from,to}});
        }
        ops.push({t:'remove',id});editing=null;
        c.editor.apply({label:'Merge outline lines',source:'user',ops}, () => { void edit(previous,caret); });
        return;
      }
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();commit();return;}
      if(e.key!=='Tab' && !(mod && ['ArrowUp','ArrowDown'].includes(e.key)))return;
      commit();
    }
    if(!editing) {
      const node=c.doc.nodes[id];
      const moveFocus=async (next:string|null)=>{
        if(!next)return;
        reveal(next);await tick();
        list.querySelector<HTMLElement>(`[data-node="${CSS.escape(next)}"]`)?.focus();
      };
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();filterInput.focus();return;}
      if(e.key==='ContextMenu'||(e.shiftKey && e.key==='F10')){
        e.preventDefault();e.stopPropagation();if(!c.selIds.includes(id))reveal(id);void c.command('node-menu');return;
      }
      if(e.key==='Backspace'||e.key==='Delete'){
        e.preventDefault();e.stopPropagation();if(!c.selIds.includes(id))reveal(id);c.deleteSelection(e.altKey);
        await moveFocus(c.focusId);return;
      }
      if(!mod && (e.key==='ArrowLeft'||e.key==='ArrowRight')){
        e.preventDefault();e.stopPropagation();
        if(e.key==='ArrowLeft'){
          if(node.children.length && !node.collapsed)c.toggleFoldOf(id);else await moveFocus(node.parent);
        }else if(node.collapsed)c.toggleFoldOf(id);else await moveFocus(node.children[0] ?? null);
        return;
      }
      if(e.key==='Home'||e.key==='End'){
        e.preventDefault();e.stopPropagation();
        if(e.key==='End' && rows.length>limit){limit=Object.keys(c.doc.nodes).length;await tick();}
        await moveFocus((e.key==='Home'?rows[0]:rows.at(-1))?.id ?? null);return;
      }
    }
    if(mod && !['ArrowUp','ArrowDown'].includes(e.key)) return;
    if(!['ArrowUp','ArrowDown','Enter','Tab','F2',' '].includes(e.key))return;
    e.preventDefault();e.stopPropagation();
    reveal(id);
    if(e.key==='F2' || e.key===' '){await edit(id);return;}
    if(e.key==='Enter'){
      filter='';const change=e.shiftKey ? addChild(c.doc,id) : addSibling(c.doc,id,true);
      if(change?.focus){const next=change.focus;c.editor.apply(change.tx,()=>{void edit(next);});}
    }else if(e.key==='Tab'){
      if(e.shiftKey)c.outdent();
      else {const sib=prevSibling(c.doc,id);if(sib){const change=moveSubtree(c.doc,id,sib,c.doc.nodes[sib].children.length);if(change)c.editor.apply(change.tx);reveal(id);}}
    }else if(mod) c.reorderFocus(e.key==='ArrowUp'?-1:1);
    else {
      const idx=rows.findIndex(r=>r.id===id)+(e.key==='ArrowUp'?-1:1);
      if(idx>=limit && rows.length>limit){limit+=1500;await tick();}
      const next=rows[idx];
      if(next){reveal(next.id);await tick();list.querySelector<HTMLElement>(`[data-node="${CSS.escape(next.id)}"]`)?.focus();}
    }
  }
  $effect(() => {
    void c.selTick;
    const id=c.focusId;
    if(!id || !list)return;
    if(!filter && rows.length>limit && !rows.slice(0,limit).some(row=>row.id===id)) {
      const at=c.outlineRows(Object.keys(c.doc.nodes).length).findIndex(row=>row.id===id);
      if(at>=limit)limit=at+1;
    }
    void tick().then(()=>list?.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)?.scrollIntoView({block:'nearest'}));
  });
</script>

<aside class="side left" data-keyboard-pane class:only={c.outlineOnly} aria-label="Outline">
  <h3>Outline</h3>
  <details class="options"><summary>Outline options</summary>
    <button class="btn" onclick={()=>c.outlineOnly=!c.outlineOnly}>{c.outlineOnly?'Show map':'Hide map'}</button>
    <label><input type="checkbox" bind:checked={showDetails}/> Show notes, tags and tasks</label>
    <label>Scope <select bind:value={scope}><option value="selection">Selection</option><option value="map">Whole map</option></select></label>
    <button class="btn" onclick={()=>output('markdown')}>Copy Markdown</button><button class="btn" onclick={()=>output('plain')}>Copy indented text</button>
    <button class="btn" onclick={()=>output('opml')}>Export OPML</button>
  </details>
  <input bind:this={filterInput} aria-label="Filter outline" placeholder="Filter outline…" bind:value={filter} />
  <div class="outline-list" bind:this={list} role="tree" aria-label="Map nodes" aria-multiselectable="true">
    {#each rows.slice(0,limit) as r (r.id)}
      {@const text = readableLabel(c.doc.nodes[r.id])}
      <div class="orow" role="none" ondragover={e=>dragOver(e,r.id)} ondrop={e=>drop(e,r.id)}
        ondragleave={()=>dropHint=null} class:sel={c.selIds.includes(r.id)} style="padding-left:min({4+r.depth*14}px, 32%)">
        {#if r.hasChildren}<button class="twist" tabindex="-1" class:open={!r.collapsed} aria-label={r.collapsed?'Expand':'Collapse'} onclick={() => c.toggleFoldOf(r.id)}><Icon name="chevron" size={11}/></button>{:else}<span class="twist"></span>{/if}
        {#if editing === r.id}
          <input aria-label="Outline node text" bind:this={editor} bind:value={draft} oninput={e=>c.setNodeText(r.id,e.currentTarget.value)}
            onpaste={e=>{
              const text=e.clipboardData?.getData('text/plain');
              if(text?.includes('\n') && /^\s*(?:[-*+]|#{1,6}|\d+[.)])\s/m.test(text)) {
                e.preventDefault();e.stopPropagation();commit();c.pasteOutline(parseMarkdownOutline(text));
              }
            }} onblur={()=>{if(editing===r.id)commit();}} onkeydown={e=>key(e,r.id)} />
        {:else}
          <button class="txt" role="treeitem" data-node={r.id} class:top={r.depth===0}
            tabindex={r.id===(c.focusId ?? rows[0]?.id)?0:-1} aria-level={r.depth+1}
            aria-label={text || 'Empty node'} aria-selected={c.selIds.includes(r.id)} aria-expanded={r.hasChildren?!r.collapsed:undefined}
            aria-describedby={c.doc.nodes[r.id]?.imageAlt ? 'outline-alt-'+r.id : undefined} title="F2 edits · Return adds a sibling · Shift+Return adds a child · Tab indents"
            draggable="true" ondragstart={e=>{dragged={id:r.id,x:e.clientX,doc:c.doc};e.dataTransfer?.setData('text/plain',r.text);}}
            data-drop={dropHint?.id === r.id ? dropHint.zone : undefined}
            ondragend={()=>{dragged=null;dropHint=null;}}
            onclick={e=>{if(e.metaKey||e.ctrlKey||e.shiftKey){const ids=new Set(c.selIds);if(!ids.delete(r.id))ids.add(r.id);c.select([...ids]);}else reveal(r.id);}} ondblclick={() => edit(r.id)} onkeydown={e=>key(e,r.id)}>
            {#if r.depth && text && c.repeatedWords.size}
              {#each wordParts(text) as part}{#if c.repeatedWords.has(part.key)}<mark title={'Used in ' + c.repeatedWords.get(part.key)!.branches + ' main branches'}>{part.text}</mark>{:else}{part.text}{/if}{/each}
            {:else}{text || 'Empty node'}{/if}
          </button>
        {/if}
        {#if c.doc.nodes[r.id]?.imageAlt}<span hidden id={'outline-alt-'+r.id}>{c.doc.nodes[r.id].imageAlt}</span>{/if}
        {#if showDetails}
          {#if c.doc.nodes[r.id].task}<input type="checkbox" aria-label={'Complete '+r.text} checked={c.doc.nodes[r.id].task?.done}
            onchange={e=>c.editor.apply({label:'Change task',source:'user',ops:[{t:'set',id:r.id,patch:{task:{done:e.currentTarget.checked}}}]})}/>{/if}
          {#if c.doc.nodes[r.id].tags?.length}<small>{c.doc.nodes[r.id].tags?.map(tag=>'#'+tag).join(' ')}</small>{/if}
          {#if c.doc.nodes[r.id].note}<small>{c.doc.nodes[r.id].note}</small>{/if}
        {/if}
      </div>
    {/each}
    {#if rows.length>limit}<button onclick={()=>limit+=1500}>Show more nodes</button>{/if}
  </div>
</aside>
<style>
  mark { background: var(--active); color: inherit; text-decoration: underline dotted; text-underline-offset: 2px; }
 .only{width:calc(100% - 24px)}.options{padding:4px 10px}.options label{display:block}.orow small{font-size:11px;color:var(--text-dim)}
 aside>input{margin:0 10px 8px;padding:5px}.orow .txt{color:inherit;font:inherit;text-align:left;border:0;background:transparent;padding:2px}
 .txt[data-drop="before"]{box-shadow:inset 0 2px var(--accent)}
 .txt[data-drop="after"]{box-shadow:inset 0 -2px var(--accent)}
 .txt[data-drop="child"]{outline:1px solid var(--accent);outline-offset:-1px}
 .orow .txt.top{font-weight:600}.orow input{min-width:0;flex:1}
</style>
