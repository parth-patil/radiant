import type {CrossLink,NodeBox,Vec2} from '../types';

function edge(box:NodeBox, toward:Vec2):Vec2 {
  const dx=toward.x-box.x,dy=toward.y-box.y;
  if (!dx && !dy) return {x:box.x,y:box.y};
  const scale=Math.min(dx ? box.w/(2*Math.abs(dx)) : Infinity,dy ? box.h/(2*Math.abs(dy)) : Infinity);
  return {x:box.x+scale*dx,y:box.y+scale*dy};
}
export function linkCurve(a:NodeBox,b:NodeBox,link:CrossLink) {
  const dx=b.x-a.x,dy=b.y-a.y,gap=Math.hypot(dx,dy)||1;
  const amplitude=Math.min(68,gap/4);
  const bend=link.bend ?? {x:-dy/gap*amplitude,y:dx/gap*amplitude};
  const control={x:(a.x+b.x)/2+bend.x,y:(a.y+b.y)/2+bend.y};
  const p=edge(a,control),q=edge(b,control);
  return {p,q,control,mid:{x:(p.x+2*control.x+q.x)/4,y:(p.y+2*control.y+q.y)/4}};
}
