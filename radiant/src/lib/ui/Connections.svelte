<script lang="ts">
  import { DIM_OPACITY } from './canvas-filter';
  import {linkCurve} from '../core/geometry/link';
  import type {Vec2} from '../core/types';
  import type { AppController } from './controller.svelte';
  let {c}: {c:AppController}=$props();
  let drag=$state<{id:string;start:Vec2;initial:Vec2;bend:Vec2}|null>(null);
  const paths=$derived.by(()=>{
    void c.rev;void c.layoutTick;void c.canvasView;
    const theme = c.theme;
    const matches=c.presenting ? null : c.canvasMatches;
    // Presenting: links fade with the nodes they join and disappear with them (read-only use of the presentation).
    const scope=c.presenting ? c.presentation.sceneScope() : null;
    if(!c.pipeline || !c.doc.links.length)return [];
    return c.doc.links.flatMap(l=>{
      const boxes=c.pipeline.canvasLayout.boxes;
      const a=boxes.get(l.from),b=boxes.get(l.to);
      if(!a||!b)return [];
      if(scope && (!scope.visible.has(l.from) || !scope.visible.has(l.to)))return [];
      const fade=scope ? Math.min(scope.opacity.get(l.from) ?? 1, scope.opacity.get(l.to) ?? 1) : 1;
      const curve=linkCurve(a,b,drag?.id===l.id?{...l,bend:drag.bend}:l);
      const {p,q,control,mid}=curve;
      return [{...l,color:l.color ?? theme.connectionColor,dash:l.dash ?? theme.connectionDash,opacity:(matches && !matches.has(l.from) && !matches.has(l.to) ? DIM_OPACITY : 1)*fade,d:`M${p.x} ${p.y} Q${control.x} ${control.y} ${q.x} ${q.y}`,x:mid.x,y:mid.y,
        bend:{x:control.x-(a.x+b.x)/2,y:control.y-(a.y+b.y)/2}}];
    });
  });
  function finish(){
    if(!drag)return;
    const link=c.doc.links.find(l=>l.id===drag?.id);
    if(link && (drag.initial.x!==drag.bend.x || drag.initial.y!==drag.bend.y)){
      const {id,from,to,label,...style}=link;
      c.editor.apply({label:'Bend connection',source:'user',ops:[{t:'linkStyle',id,style:{...style,bend:drag.bend}}]});
    }
    drag=null;
  }
  const transform=$derived.by(()=>{
    if(!paths.length)return '';
    void c.camTick;const o=c.camera.worldToScreen({x:0,y:0});return `translate(${o.x} ${o.y}) scale(${c.camera.zoom})`;
  });
</script>
{#if paths.length}<svg class="connections" aria-label="Map connections"><g {transform}>{#each paths as p (p.id)}
  <defs><marker id={'arr-'+p.id} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill={p.color ?? 'currentColor'}/></marker></defs>
  <path opacity={p.opacity} d={p.d} fill="none" stroke={p.color ?? "currentColor"} stroke-width="1.4" stroke-dasharray={p.dash==='solid'?undefined:'4 3'}
    marker-start={p.arrows==='start'||p.arrows==='both'?`url(#arr-${p.id})`:undefined}
    marker-end={p.arrows==='end'||p.arrows==='both'?`url(#arr-${p.id})`:undefined}/>
  {#if !c.presenting && (c.selIds.includes(p.from)||c.selIds.includes(p.to))}
    <circle class="handle" cx={p.x} cy={p.y} r={4} fill={p.color ?? 'currentColor'} role="presentation"
      onpointerdown={e=>{e.currentTarget.setPointerCapture(e.pointerId);drag={id:p.id,start:{x:e.clientX,y:e.clientY},initial:p.bend,bend:p.bend};}}
      onpointermove={e=>{if(drag?.id===p.id)drag.bend={x:drag.initial.x+2*(e.clientX-drag.start.x)/c.camera.zoom,y:drag.initial.y+2*(e.clientY-drag.start.y)/c.camera.zoom};}}
      onpointerup={finish} onpointercancel={()=>drag=null} ondblclick={()=>{c.showInspector=true;requestAnimationFrame(()=>document.getElementById('link-'+p.id)?.focus());}}/>
  {/if}
  {#if p.label}<text opacity={p.opacity} x={p.x} y={p.y-4} text-anchor="middle" fill="currentColor" font-size="12">{p.label}</text>{/if}
{/each}</g></svg>{/if}
<style>.connections{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;color:var(--text-dim)}.handle{pointer-events:all;cursor:move}</style>
