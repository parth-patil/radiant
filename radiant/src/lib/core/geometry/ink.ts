import type { Mesh, NodeBox, NodeId, Rect, Vec2 } from '../types';
import { premulCss } from './color';

export type InkPlacement = 'on' | 'beside';
export interface InkPoint extends Vec2 { pressure: number }
export interface InkStroke { color: string; width: number; points: InkPoint[] }
export interface InkSketch { placement: InkPlacement; strokes: InkStroke[] }
export interface InkDraw { id: NodeId; frame: Rect; stroke: InkStroke; opacity: number }

export const MAX_INK_STROKES = 96;
export const MAX_INK_POINTS = 512;
export const INK_WIDTH = 156;
export const INK_HEIGHT = 108;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const between = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

/** Retain only bounded, normalized strokes from an imported document. */
export function parseInkSketch(value: unknown): InkSketch | undefined {
  if (!object(value) || (value.placement !== 'on' && value.placement !== 'beside') ||
      !Array.isArray(value.strokes) || !value.strokes.length || value.strokes.length > MAX_INK_STROKES) return;
  const strokes: InkStroke[] = [];
  for (const raw of value.strokes) {
    if (!object(raw) || typeof raw.color !== 'string' || !/^#[\da-f]{6}$/i.test(raw.color) ||
        !between(raw.width, .5, 16) || !Array.isArray(raw.points) || !raw.points.length || raw.points.length > MAX_INK_POINTS) return;
    const points: InkPoint[] = [];
    for (const sample of raw.points) {
      if (!object(sample) || !between(sample.x, 0, 1) || !between(sample.y, 0, 1) || !between(sample.pressure, 0, 1)) return;
      points.push({ x: sample.x, y: sample.y, pressure: sample.pressure });
    }
    strokes.push({ color: raw.color, width: raw.width, points });
  }
  return { placement: value.placement, strokes };
}

export function inkFrame(box: NodeBox, placement: InkPlacement): Rect {
  return {
    x: box.x - INK_WIDTH / 2,
    y: placement === 'on' ? box.y - INK_HEIGHT / 2 : box.y + box.h / 2 + 10,
    w: INK_WIDTH,
    h: INK_HEIGHT
  };
}

/** Pressure stroke sample in absolute coordinates with its pen radius. */
export interface InkSample extends Vec2 { r: number }

/** Pen radius of a stroke of `width` at `pressure` (0..1). */
export const inkRadius = (width: number, pressure: number): number => width * (.28 + .72 * pressure) / 2;
const radius = (stroke: InkStroke, p: InkPoint): number => inkRadius(stroke.width, p.pressure);
const ring = Array.from({ length: 10 }, (_, i) => ({
  x: Math.cos(i * Math.PI / 5),
  y: Math.sin(i * Math.PI / 5)
}));

/** One shared stroke silhouette for the editor, WebGL map, and visual exports. */
export function inkPolygons(stroke: InkStroke, frame: Rect): Vec2[][] {
  return inkSamplePolygons(stroke.points.map((p) => ({
    x: frame.x + p.x * frame.w, y: frame.y + p.y * frame.h, r: radius(stroke, p)
  })));
}

/**
 * Samples of a canvas `draw` element in absolute coordinates: `points` are x, y pairs relative to (ox, oy),
 * missing pressures count as 0.5, and the optional rotation turns each sample about `centre`.
 */
export function inkSamples(points: ArrayLike<number>, pressures: ArrayLike<number> | undefined, width: number,
  ox: number, oy: number, angle = 0, centre?: Vec2): InkSample[] {
  const cos = Math.cos(angle), sin = Math.sin(angle), cx = centre?.x ?? 0, cy = centre?.y ?? 0;
  const samples: InkSample[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) {
    let x = points[i], y = points[i + 1];
    if (angle) {
      const dx = x - cx, dy = y - cy;
      x = cx + dx * cos - dy * sin;
      y = cy + dx * sin + dy * cos;
    }
    const pressure = pressures?.[i / 2];
    samples.push({ x: ox + x, y: oy + y, r: inkRadius(width, Number.isFinite(pressure) ? Math.max(0, Math.min(1, pressure!)) : .5) });
  }
  return samples;
}

/** The node ink pad silhouette for samples already placed in world coordinates. */
export function inkSamplePolygons(samples: InkSample[]): Vec2[][] {
  const polygons: Vec2[][] = [];
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (b) {
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (length > 0) {
        const x = -dy / length, y = dx / length;
        polygons.push([
          { x: a.x + a.r * x, y: a.y + a.r * y }, { x: a.x - a.r * x, y: a.y - a.r * y },
          { x: b.x - b.r * x, y: b.y - b.r * y }, { x: b.x + b.r * x, y: b.y + b.r * y }
        ]);
      }
    }
    polygons.push(ring.map((p) => ({ x: a.x + p.x * a.r, y: a.y + p.y * a.r })));
  }
  return polygons;
}

export function inkPath(stroke: InkStroke, frame: Rect, format: (value: number) => string): string {
  return inkPolygons(stroke, frame).map((polygon) => 'M' +
    polygon.map((p) => `${format(p.x)} ${format(p.y)}`).join('L') + 'Z').join('');
}

export function inkMesh(items: InkDraw[]): Mesh | undefined {
  if (!items.length) return;
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  for (const { stroke, frame, opacity } of items) {
    const { r, g, b, a } = premulCss(stroke.color, opacity);
    for (const polygon of inkPolygons(stroke, frame)) {
      const first = positions.length / 2;
      for (const p of polygon) {
        positions.push(p.x, p.y);
        colors.push(r, g, b, a);
      }
      for (let i = 1; i < polygon.length - 1; i++) indices.push(first, first + i, first + i + 1);
    }
  }
  return { positions: new Float64Array(positions), colors: new Float32Array(colors), indices: new Uint32Array(indices) };
}

/** Whether `point` lies within `padding` of a stroke given as absolute samples. */
export function inkSamplesHit(samples: InkSample[], point: Vec2, padding: number): boolean {
  for (let j = 0; j < samples.length; j++) {
    const a = samples[j], b = samples[j + 1] ?? a;
    const dx = b.x - a.x, dy = b.y - a.y, x = point.x - a.x, y = point.y - a.y;
    const square = dx * dx + dy * dy;
    const t = square ? Math.max(0, Math.min(1, (x * dx + y * dy) / square)) : 0;
    if (Math.hypot(x - dx * t, y - dy * t) <= padding + Math.max(a.r, b.r)) return true;
  }
  return false;
}

export function inkStrokeAt(strokes: InkStroke[], point: Vec2, padding: number): number {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const stroke = strokes[i];
    for (let j = 0; j < stroke.points.length; j++) {
      const a = stroke.points[j], b = stroke.points[j + 1] ?? a;
      const ax = a.x * INK_WIDTH, ay = a.y * INK_HEIGHT;
      const dx = (b.x - a.x) * INK_WIDTH, dy = (b.y - a.y) * INK_HEIGHT;
      const x = point.x * INK_WIDTH - ax, y = point.y * INK_HEIGHT - ay;
      const square = dx * dx + dy * dy;
      const t = square ? Math.max(0, Math.min(1, (x * dx + y * dy) / square)) : 0;
      if (Math.hypot(x - dx * t, y - dy * t) <= padding + Math.max(radius(stroke, a), radius(stroke, b))) return i;
    }
  }
  return -1;
}
