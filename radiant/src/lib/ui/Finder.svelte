<script lang="ts">
  import { commands } from './keymap';
  import { effectiveRepresentation } from '../core/art/representation';
  import { onMount, tick, untrack } from 'svelte';
  import type { AppController } from './controller.svelte';
  import type { MenuId, PaletteItem } from '../host/types';
  import { basename, isTypingTarget } from './util';
  import type { MapNode, Op } from '../core/types';
  let { c, mode }: { c: AppController; mode: 'commands' | 'search' } = $props();
  let dialog: HTMLDialogElement;
  let field: HTMLInputElement;
  let query = $state('');
  let replacement = $state('');
  let replace = $state(false);
  let kind = $state('all');
  let index = $state(0);
  let nativeItems = $state.raw<PaletteItem[]>([]);
  let previousFocus: HTMLElement | null = null;
  let selection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' | null } | null = null;
  let choosing = false;
  const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
  const commandIds = new Set<string>(commands.map(([id]) => id));

  function showShortcut(value: string | undefined): string {
    if (!value) return '';
    if (!mac) return value.replace('Mod', 'Ctrl');
    const glyphs: Record<string, string> = {
      Mod: '⌘', Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Enter: '↩', Backspace: '⌫',
      Delete: '⌦', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', NumpadMultiply: '*',
    };
    return value.split('+').map(key => glyphs[key] ?? key).join('');
  }

  const palette = $derived.by(() => {
    if (mode !== 'commands') return [];
    const native = new Map(nativeItems.map(item => [item.id, item]));
    const entries = commands.filter(([id]) => id !== 'select-all' || !native.has('native:select-all'))
      .map(([id, label]): PaletteItem => native.get(id) ?? { id, label, native: false, group: '', shortcut: '' });
    const extra = nativeItems.filter(item => !commandIds.has(item.id));
    const recent = c.host.paletteItems ? [] : c.recent.map((path): PaletteItem => ({
      id: 'browser-recent:' + path, label: 'Open Recent: ' + basename(path), group: 'File › Open Recent', hint: path, native: false, shortcut: '',
    }));
    return [...entries, ...extra, ...recent].map((item) => ({
      ...item,
      detail: [item.group, item.hint, showShortcut(commandIds.has(item.id) ? c.shortcuts[item.id as MenuId] : item.shortcut)].filter(Boolean).join(' · '),
    }));
  });
  const results = $derived.by(() => {
    void c.rev;
    const q = query.trim().toLowerCase();
    if (mode === 'commands') return palette.filter(item => `${item.label} ${item.group} ${item.detail}`.toLowerCase().includes(q));
    if (!q) return [];
    const matches=(value?:string)=>value?.toLowerCase().includes(q);
    const nodes=Object.values(c.doc.nodes).filter(n=>(kind==='all' || effectiveRepresentation(c.doc,n.id)===kind) &&
      [n.text,n.note,n.link,...(n.tags??[])].some(matches))
      .map(n=>({id:'node:'+n.id,label:n.text || '(empty)',detail:[n.note,n.link,...(n.tags??[]).map(tag=>'#'+tag)].filter(Boolean).join(' · ')}));
    const links=c.doc.links.filter(link=>matches(link.label) && (kind==='all' || effectiveRepresentation(c.doc,link.from)===kind))
      .map(link=>({id:'link:'+link.id,label:link.label!,detail:c.doc.nodes[link.from].text+' → '+c.doc.nodes[link.to].text}));
    return [...nodes,...links];
  });
  onMount(() => {
    replace = c.finderReplace;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement) {
      const { selectionStart, selectionEnd, selectionDirection } = previousFocus;
      if (selectionStart !== null && selectionEnd !== null) {
        selection = { start: selectionStart, end: selectionEnd, direction: selectionDirection };
      }
    }
    dialog.showModal();
    field.focus();
    if (mode === 'commands') void c.host.paletteItems?.().then(items => { nativeItems = items; }).catch(error => {
      c.say(`Desktop menu commands are unavailable: ${String(error)}`, 'error');
    });
  });

  function restoreFocus() {
    if (!previousFocus?.isConnected) return;
    previousFocus.focus({ preventScroll: true });
    if (selection && (previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement)) {
      previousFocus.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
    }
  }
  function reveal(resultId:string) {
    const link=resultId.startsWith('link:') ? c.doc.links.find(l=>l.id===resultId.slice(5)) : undefined;
    const focus=link?.from ?? resultId.slice(5);
    if (!c.doc.nodes[focus]) return;
    const open=new Set<string>();
    for (const node of link?[link.from,link.to]:[focus]) {
      for(let id=c.doc.nodes[node]?.parent;id;id=c.doc.nodes[id].parent) if(c.doc.nodes[id].collapsed)open.add(id);
    }
    if(open.size)c.editor.apply({label:'Reveal search result',source:'user',ops:[...open].map(id=>({t:'set',id,patch:{collapsed:undefined}}))});
    c.flush();c.selectFromOutline(focus);
    if(link)c.select([link.from,link.to],link.from);
  }
  let last='';
  $effect(()=>{
    const active=mode==='search' && results[index]?.id;
    if(active && active!==last){last=active;untrack(()=>reveal(active));}
    if (!active)last='';
  });
  function dismiss() {
    choosing = true;
    dialog.close();
    if (mode === 'commands') restoreFocus();
    c.finder = null;
  }

  async function choose(i: number) {
    const result = results[i];
    if (!result || choosing) return;
    const isCommand = mode === 'commands';
    dismiss();
    if (!isCommand) { reveal(result.id); return; }
    // Unmount the palette before an action opens another dialog or takes native focus.
    await tick();
    try {
      if (result.id.startsWith('browser-recent:')) {
        await c.openDoc(result.id.slice('browser-recent:'.length));
      } else if ('native' in result && result.native) {
        const typing = isTypingTarget(previousFocus);
        if (result.id === 'native:select-all') {
          if (previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement) previousFocus.select();
          else if (typing) document.execCommand('selectAll');
          else await c.command('select-all');
        } else if (!mac && /^native:(copy|cut|paste)$/.test(result.id)) {
          const action = result.id.slice('native:'.length);
          if (!document.execCommand(action)) {
            throw new Error('The focused control could not use the clipboard command.');
          }
        } else await c.host.runPaletteItem?.(result.id);
      } else if (commandIds.has(result.id)) await c.command(result.id as MenuId);
      else throw new Error('This menu command is unavailable.');
    } catch (error) {
      c.say(error instanceof Error ? error.message : String(error), 'error');
    }
  }
  const changes=$derived.by(()=>{
    const ops:Op[]=[];
    const preview:string[]=[];
    if(!replace || mode!=='search' || !query.trim())return {ops,preview};
    const escaped=query.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const pattern=new RegExp(escaped,'gi');
    const sub=(value:string)=>value.replace(pattern,()=>replacement);
    for (const result of results) {
      const id=result.id.slice(5);
      if(result.id.startsWith('link:')) {
        const label=c.doc.links.find(l=>l.id===id)?.label;
        if(label && sub(label)!==label){ops.push({t:'setLink',id,label:sub(label)});preview.push(label+' → '+sub(label));}
        continue;
      }
      const n=c.doc.nodes[id], patch:Partial<MapNode>={};
      for(const field of ['text','note','link'] as const){
        const old=n[field];
        if(old && sub(old)!==old){patch[field]=sub(old);preview.push(old+' → '+patch[field]);}
      }
      if(n.tags?.some(tag=>sub(tag)!==tag)){
        patch.tags=n.tags.map(sub);preview.push(n.tags.join(', ')+' → '+patch.tags.join(', '));
      }
      if(Object.keys(patch).length)ops.push({t:'set',id,patch});
    }
    return {ops,preview};
  });
  function replaceMatches() {
    if(changes.ops.length)c.editor.apply({ops:changes.ops,label:'Replace in map',source:'user'});
  }
</script>

<dialog bind:this={dialog} aria-label={mode === 'commands' ? 'Command palette' : 'Find in map'} onclose={() => { if (!choosing) { if (mode === 'commands') restoreFocus(); c.finder = null; } }}
  oncancel={(e) => { e.preventDefault(); dismiss(); }}
  onkeydown={(e) => {
    e.stopPropagation();
    if(e.isComposing || e.keyCode===229)return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      index = Math.max(0, Math.min(Math.min(results.length, 200)-1, index + (e.key === 'ArrowDown' ? 1 : -1)));
      dialog.querySelector(`[data-i="${index}"]`)?.scrollIntoView({block:'nearest'});
    } else if (e.key === 'Enter' && e.target === field) {e.preventDefault();choose(index);}
  }}>
  <input bind:this={field} aria-label="Search" bind:value={query} oninput={() => index = 0}
    placeholder={mode === 'commands' ? 'Search commands…' : 'Find text, notes, or tags…'} />
  {#if mode==='search'}
    <select aria-label="Node type" bind:value={kind}><option value="all">All node types</option><option value="vector">Vector</option>
      <option value="picture">Picture</option><option value="svg">SVG</option></select>
  {/if}
  {#if mode === 'search' && query.trim()}
    <div class="actions"><span>{results.length} matches</span><button onclick={() => replace = !replace}>Replace…</button></div>
    {#if replace}<div class="actions"><input aria-label="Replacement" bind:value={replacement} placeholder="Replace with…" /><button disabled={!changes.ops.length} onclick={replaceMatches}>Replace all</button></div>
      <ul aria-label="Replacement preview">{#each changes.preview as change}<li>{change}</li>{/each}</ul>{/if}
  {/if}
  <div class="results">
    {#each results.slice(0,200) as r,i (r.id)}
      <button data-i={i} data-command={mode === 'commands' ? r.id : undefined} class:active={i === index} onclick={() => choose(i)}>{r.label}{#if r.detail}<small>{r.detail}</small>{/if}</button>
    {/each}
  </div>
  {#if results.length > 200}<small>Showing the first 200 matches. Refine your search for more.</small>{/if}
  <button class="close" onclick={dismiss}>Close</button>
</dialog>
<style>
 dialog{color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;width:min(480px,85vw)}
 input{box-sizing:border-box;width:100%;padding:8px;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:5px}
 ul{max-height:18vh;overflow:auto;font-size:12px;padding-left:18px}select{margin-top:6px}
 .results{max-height:42vh;overflow:auto}.results button{display:block;text-align:left;width:100%;border:0;background:transparent;color:inherit;padding:6px}
 .results .active,.results button:hover{background:var(--hover)}small{display:block;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .actions{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0}.close{margin-top:8px}dialog::backdrop{background:#0004}
</style>
