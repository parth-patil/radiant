<script lang="ts">
  import {onMount} from 'svelte';
  import type {Host} from '../host/types';
  import type {RectDraw,RGBA,Theme} from '../core/types';
  import {parseDocReport,getTheme} from '../core/model';
  import {branchEndColor,tessellateBranches} from '../core/geometry';
  import {Pipeline} from './pipeline';
  import {alignedLabelX,fontString,layoutLabel,measureLabel} from '../render/text';
  let {host,path}:{host:Host;path:string}=$props();
  let canvas:HTMLCanvasElement;
  let error=$state('');
  const css=(c:RGBA)=>c.a>0 ? `rgba(${[c.r,c.g,c.b].map(v=>Math.round(Math.min(1,v/c.a)*255)).join(',')},${c.a})` : 'transparent';
  function roundRect(ctx:CanvasRenderingContext2D,r:RectDraw){
    ctx.beginPath();ctx.roundRect(r.x,r.y,r.w,r.h,Math.max(0,Math.min(r.radius,r.w/2,r.h/2)));
  }
  onMount(()=>{
    let active=true;
    const observer=new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)) {observer.disconnect();void draw();}
    });
    observer.observe(canvas);
    async function draw(){
      try {
        const json=await host.previewMapJson(path);
        if(!active)return;
        const {doc}=parseDocReport(json);
        // Same theme as the canvas: preset in the map's appearance (or the system's), then the map's settings.
        const mode=doc.themeSettings?.canvasAppearance;
        const dark=mode==='dark' || (mode!=='light' && matchMedia('(prefers-color-scheme: dark)').matches);
        const theme:Theme={...getTheme(doc.themeId,dark),...doc.themeSettings};
        const pipeline=new Pipeline(measureLabel);
        pipeline.relayout(doc,theme);
        const {boxes,bounds}=pipeline.layout;
        const ctx=canvas.getContext('2d');
        if(!ctx)return;
        const scene=pipeline.fullScene({selection:new Set(),focus:null,hover:null,editing:null});
        const w=canvas.width,h=canvas.height, scale=Math.min((w-16)/Math.max(1,bounds.w),(h-16)/Math.max(1,bounds.h));
        ctx.fillStyle=css(scene.background);ctx.fillRect(0,0,w,h);
        const gradient=scene.surface?.gradient;
        if(gradient){
          const fill=ctx.createLinearGradient(0,0,0,h);
          fill.addColorStop(0,css(gradient[0]));fill.addColorStop(1,css(gradient[1]));
          ctx.fillStyle=fill;ctx.fillRect(0,0,w,h);
        }
        ctx.translate((w-bounds.w*scale)/2,(h-bounds.h*scale)/2);
        ctx.scale(scale,scale);ctx.translate(-bounds.x,-bounds.y);
        // Shadows under everything (canvas shadows are in device pixels, so scale them by hand).
        for(const r of scene.rects){
          if(!r.shadow || r.shadow.color.a<=0)continue;
          ctx.save();
          ctx.shadowColor=css(r.shadow.color);ctx.shadowBlur=2*r.shadow.blur*scale;ctx.shadowOffsetY=r.shadow.dy*scale;
          ctx.fillStyle=css(r.fill.a>0 ? r.fill : r.shadow.color);roundRect(ctx,r);ctx.fill();
          ctx.restore();
        }
        const rect=(r:RectDraw)=>{
          roundRect(ctx,r);
          if(r.fill.a>0){ctx.fillStyle=css(r.fill);ctx.fill();}
          if(r.stroke && r.stroke.a>0 && (r.strokeWidth ?? 1)>0){ctx.strokeStyle=css(r.stroke);ctx.lineWidth=r.strokeWidth ?? 1;ctx.stroke();}
        };
        for(const r of scene.rects)if(!r.overBranches)rect(r);
        // Branch geometry as drawn on the canvas: caps, tip dots, fanned joins and the blend along limbs.
        for(const spec of pipeline.branchSpecs()){
          const {positions:p,indices}=tessellateBranches([spec],{zoom:Math.max(0.1,scale)});
          ctx.beginPath();
          for(let i=0;i<indices.length;i+=3){
            const a=indices[i],b=indices[i+1],c=indices[i+2];
            const turn=(p[b*2]-p[a*2])*(p[c*2+1]-p[a*2+1])-(p[b*2+1]-p[a*2+1])*(p[c*2]-p[a*2]);
            const [m,n]=turn>=0 ? [b,c] : [c,b];
            ctx.moveTo(p[a*2],p[a*2+1]);ctx.lineTo(p[m*2],p[m*2+1]);ctx.lineTo(p[n*2],p[n*2+1]);ctx.closePath();
          }
          if(spec.fade){
            const fill=ctx.createLinearGradient(spec.p0.x,spec.p0.y,spec.p1.x,spec.p1.y);
            fill.addColorStop(0,css(spec.color));fill.addColorStop(1,css(branchEndColor(spec)));
            ctx.fillStyle=fill;
          } else ctx.fillStyle=css(spec.color);
          ctx.fill();
        }
        for(const r of scene.rects)if(r.overBranches)rect(r);
        ctx.textBaseline='alphabetic';ctx.textAlign='left';
        for(const l of scene.labels){
          const font={family:l.fontFamily,size:l.fontSize,bold:l.bold,italic:l.italic};
          const layout=layoutLabel(l.text,font,l.maxWidth);
          const left=alignedLabelX(l,layout.w)-layout.w/2, top=l.y-layout.h/2;
          ctx.font=fontString(font);ctx.fillStyle=css(l.color);
          layout.lines.forEach((line,i)=>{
            const free=layout.w-line.w;
            ctx.fillText(line.text,left+(l.align==='left' ? 0 : l.align==='right' ? free : free/2),top+i*layout.lineHeight+layout.baseline);
          });
        }
        if(!boxes.size)error='Preview unavailable';
      }catch{if(active)error='Preview unavailable';}
    }
    return ()=>{active=false;observer.disconnect();};
  });
</script>
<canvas bind:this={canvas} width="400" height="240" aria-label="Whole-map preview" hidden={!!error}></canvas>
{#if error}<span>{error}</span>{/if}
<style>canvas,span{width:100%;aspect-ratio:5/3;border-radius:4px}span{display:grid;place-items:center;background:var(--panel);font-size:12px}</style>
