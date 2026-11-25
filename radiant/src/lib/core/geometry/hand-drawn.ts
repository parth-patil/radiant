import type { RectDraw, Vec2 } from '../types';
import { branchSeed } from './branches';

// Coefficients used by both the vector contour and the inverse WebGL outline.
export const WOBBLE_BEND = 0.65;
export const WOBBLE_BIAS = 0.42;

export function outlineWobble(seed: number, id: string, w: number, h: number): Vec2 {
  const scale = Math.min(1, Math.min(w, h) / 28);
  const amount = (bits: number) => (bits & 1 ? 1 : -1) * (2 + (bits >>> 1) / 32768 * 2) * scale;
  const hash = branchSeed(seed, 'shape:' + id);
  return { x: amount(hash & 0xffff), y: amount(hash >>> 16) };
}

function bend(value: number): number {
  const t = Math.max(-1, Math.min(1, value));
  return t * (1 - WOBBLE_BEND * t * t) + WOBBLE_BIAS * t * t;
}

/** Samples the same warped rounded rectangle that WebGL evaluates as a distance field. */
export function handDrawnOutline(rect: RectDraw): Vec2[] {
  const hw = rect.w / 2, hh = rect.h / 2;
  const radius = Math.min(hw, hh, rect.radius);
  const warp = rect.wobble!;
  const points: Vec2[] = [];
  const add = (x: number, y: number) => {
    const bentX = x + warp.x * bend(y / hh);
    const bentY = y + warp.y * bend(bentX / hw);
    points.push({ x: rect.x + hw + bentX, y: rect.y + hh + bentY });
  };
  const corners = [
    { x: hw - radius, y: -hh + radius }, { x: hw - radius, y: hh - radius },
    { x: -hw + radius, y: hh - radius }, { x: -hw + radius, y: -hh + radius }
  ];
  for (let corner = 0; corner < corners.length; corner++) {
    const centre = corners[corner];
    const from = (corner - 1) * Math.PI / 2;
    for (let step = 0; step <= 10; step++) {
      const angle = from + step * Math.PI / 20;
      add(centre.x + Math.cos(angle) * radius, centre.y + Math.sin(angle) * radius);
    }
    const next = corners[(corner + 1) % corners.length];
    const dx = Math.cos(from + Math.PI / 2) * radius, dy = Math.sin(from + Math.PI / 2) * radius;
    for (let step = 1; step < 16; step++) {
      add(centre.x + dx + (next.x - centre.x) * step / 16,
        centre.y + dy + (next.y - centre.y) * step / 16);
    }
  }
  return points;
}
