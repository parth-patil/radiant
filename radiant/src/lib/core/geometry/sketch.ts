import { RoughGenerator } from 'roughjs/bin/generator';
import type { CanvasElement, RGBA, Vec2 } from '../types';
import { inkSamplePolygons, inkSamples } from './ink';

/**
 * Sketch geometry for canvas elements (spec 7.2, CNV-20). Each element becomes one set of subpaths built
 * with the rough.js generator from the element's seed; the triangles for WebGL and the SVG path data for
 * export are both derived from those subpaths, so the canvas and the export draw the same numbers.
 * Everything is local to the element's (x, y) with its rotation applied, so moving an element never
 * re-tessellates it.
 */

type RoughDrawable = ReturnType<RoughGenerator['rectangle']>;
type RoughOptions = NonNullable<Parameters<RoughGenerator['rectangle']>[4]>;
type RoughOp = RoughDrawable['sets'][number]['ops'][number];
type Head = NonNullable<CanvasElement['endHead']>;

/** Which of the element's colours paints a path: its stroke, its fill, or the soft shadow under a note. */
export type SketchPaint = 0 | 1 | 2;
export const PAINT_STROKE = 0;
export const PAINT_FILL = 1;
export const PAINT_SHADOW = 2;

export interface SketchPath {
  paint: SketchPaint;
  /** true: a filled area (nonzero rule); false: a centreline stroked at `width` with miter joins. */
  area: boolean;
  width: number;
  /** Round caps on open stroked subpaths; butt otherwise. */
  roundCaps: boolean;
  /** Subpaths as flat x, y pairs relative to the element's (x, y), rotation applied. */
  parts: Float64Array[];
  closed: boolean[];
  /** How an area is triangulated: fan from its first vertex, fan from its centroid, or ear clipping. */
  mode: 'convex' | 'star' | 'simple';
}

export interface ElementSketch {
  key: string;
  /** Triangle vertices, x, y pairs relative to the element's (x, y). */
  positions: Float64Array;
  /** Paint per vertex. */
  paints: Uint8Array;
  indices: Uint32Array;
  /** minX, minY, maxX, maxY of the triangles, relative to the element's (x, y). */
  bounds: [number, number, number, number];
  paths: SketchPath[];
}

export const DEFAULT_STROKE_WIDTH = 2;
export const DEFAULT_ROUGHNESS = 1;
/** Sticky note fill when the element has none. */
export const NOTE_FILL = '#fff3bf';
export const FRAME_STROKE = '#bbbbbb';
export const FRAME_RADIUS = 8;
/** A canvas pen stroke of width 2 is as wide as the node ink pad's default pen (5). */
export const DRAW_WIDTH_SCALE = 2.5;
const MITER_LIMIT = 4;
const FLATNESS = 0.12;

const generator = new RoughGenerator();

export const drawWidth = (el: Pick<CanvasElement, 'strokeWidth'>): number => (el.strokeWidth ?? DEFAULT_STROKE_WIDTH) * DRAW_WIDTH_SCALE;
export const isLinear = (kind: CanvasElement['kind']): boolean => kind === 'line' || kind === 'arrow';

/** Excalidraw's corner radius: proportional for diamonds, adaptive (25% up to 32) for rectangles. */
export function cornerRadius(size: number, adaptive: boolean): number {
  return adaptive && size > 128 ? 32 : size * 0.25;
}

/** Points of a line, arrow or pen stroke as flat pairs; shapes have none. */
export function elementPoints(el: CanvasElement): number[] {
  const points = el.points;
  if (points && points.length >= 2) return points.length % 2 ? points.slice(0, -1) : points;
  return isLinear(el.kind) ? [0, 0, el.w, el.h] : [];
}

/** Bounding box of flat point pairs as [minX, minY, maxX, maxY]. */
export function pointBounds(points: ArrayLike<number>): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

/** Rotation centre relative to (x, y): the box centre for shapes, the centre of the points for paths. */
export function elementCentre(el: CanvasElement, points?: ArrayLike<number>): Vec2 {
  if (isLinear(el.kind) || el.kind === 'draw') {
    const [x0, y0, x1, y1] = pointBounds(points ?? elementPoints(el));
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  }
  return { x: Math.abs(el.w) / 2, y: Math.abs(el.h) / 2 };
}

// ------------------------------------------------------------------------------------------ key and cache

const bits = new Float64Array(1);
const words = new Uint32Array(bits.buffer);

function hashNumbers(values: ArrayLike<number> | undefined): string {
  if (!values) return '-';
  let a = 0x811c9dc5, b = 0x9747b28c;
  for (let i = 0; i < values.length; i++) {
    bits[0] = values[i];
    a = Math.imul(a ^ words[0], 0x01000193);
    a = Math.imul(a ^ words[1], 0x01000193);
    b = Math.imul(b ^ words[1], 0x5bd1e995);
    b = Math.imul(b ^ (b >>> 15) ^ words[0], 0x5bd1e995);
  }
  return values.length + ':' + (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** Every field that changes the shape, and nothing else: colours and position are applied later. */
export function sketchKey(el: CanvasElement, points?: ArrayLike<number>): string {
  return [
    el.kind, el.w, el.h, el.angle ?? 0, el.fill ? 1 : 0, el.fillStyle ?? '', el.strokeWidth ?? '', el.strokeStyle ?? '',
    el.roughness ?? '', el.round ? 1 : 0, el.seed, el.startHead ?? '', el.endHead ?? '', el.elbow ? 1 : 0,
    el.stroke ? 1 : 0, hashNumbers(points ?? el.points), el.kind === 'draw' ? hashNumbers(el.pressures) : ''
  ].join('|');
}

const CACHE_LIMIT = 40_000;
const cache = new Map<string, ElementSketch>();
export const sketchCacheStats = { hits: 0, misses: 0 };

/**
 * The element's geometry, cached by sketchKey. `points` overrides the stored points of a line or arrow,
 * for ends resolved from bindings.
 */
export function sketchElement(el: CanvasElement, points?: ArrayLike<number>): ElementSketch {
  const key = sketchKey(el, points);
  const hit = cache.get(key);
  if (hit) {
    sketchCacheStats.hits++;
    return hit;
  }
  sketchCacheStats.misses++;
  const sketch = buildSketch(el, key, points);
  if (cache.size >= CACHE_LIMIT) {
    let drop = CACHE_LIMIT / 10;
    for (const old of cache.keys()) {
      cache.delete(old);
      if (--drop <= 0) break;
    }
  }
  cache.set(key, sketch);
  return sketch;
}

export function clearSketchCache(): void {
  cache.clear();
}

// ------------------------------------------------------------------------------------------ rough geometry

const seedOf = (seed: number): number => Number.isFinite(seed) && Math.trunc(seed) !== 0 ? Math.trunc(seed) : 1;

/** Excalidraw softens small shapes so they are not all wobble. */
function adjustRoughness(roughness: number, w: number, h: number, linear: boolean, round: boolean): number {
  const max = Math.max(w, h), min = Math.min(w, h);
  if ((min >= 20 && max >= 50) || (min >= 15 && round) || (linear && max >= 50)) return roughness;
  return Math.min(roughness / (max < 10 ? 3 : 2), 2.5);
}

function roughOptions(el: CanvasElement, w: number, h: number): RoughOptions {
  const width = el.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const style = el.strokeStyle ?? 'solid';
  const roughness = adjustRoughness(el.roughness ?? DEFAULT_ROUGHNESS, w, h, isLinear(el.kind), !!el.round);
  return {
    seed: seedOf(el.seed),
    roughness,
    strokeWidth: style === 'solid' ? width : width + 0.5,
    fillWeight: width / 2,
    hachureGap: width * 4,
    // Dashes would overlay each other, and at roughness 0 the second stroke only darkens translucent ink.
    disableMultiStroke: style !== 'solid' || roughness === 0,
    preserveVertices: roughness < 2,
    fillStyle: el.fillStyle ?? 'solid',
    fill: el.fill ? '#000' : undefined
  };
}

/** Number of line segments for one cubic, from how far its control points leave the chord. */
function segments(x0: number, y0: number, d: number[]): number {
  const dx = d[4] - x0, dy = d[5] - y0, length = Math.hypot(dx, dy);
  const off = (x: number, y: number) => length ? Math.abs((x - x0) * dy - (y - y0) * dx) / length : Math.hypot(x - x0, y - y0);
  const bend = Math.max(off(d[0], d[1]), off(d[2], d[3]));
  return bend < 1e-3 ? 1 : Math.min(24, Math.max(1, Math.ceil(Math.sqrt(bend / FLATNESS))));
}

/** rough.js ops to flat polylines, joining a subpath that starts where the last one ended. */
function flatten(ops: RoughOp[]): { parts: number[][]; closed: boolean[] } {
  const parts: number[][] = [];
  let current: number[] | null = null, x = 0, y = 0;
  const near = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) < 1e-6 && Math.abs(ay - by) < 1e-6;
  for (const op of ops) {
    const d = op.data;
    if (op.op === 'move') {
      if (!(current && near(d[0], d[1], x, y))) {
        current = [d[0], d[1]];
        parts.push(current);
      }
      x = d[0];
      y = d[1];
      continue;
    }
    if (!current) parts.push(current = [x, y]);
    if (op.op === 'lineTo') {
      x = d[0];
      y = d[1];
      if (!near(x, y, current[current.length - 2], current[current.length - 1])) current.push(x, y);
      continue;
    }
    const n = segments(x, y, d);
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
      const px = a * x + b * d[0] + c * d[2] + e * d[4];
      const py = a * y + b * d[1] + c * d[3] + e * d[5];
      if (!near(px, py, current[current.length - 2], current[current.length - 1])) current.push(px, py);
    }
    x = d[4];
    y = d[5];
  }
  const kept: number[][] = [], closed: boolean[] = [];
  for (const part of parts) {
    if (part.length < 4) continue;
    const loop = part.length > 6 && near(part[0], part[1], part[part.length - 2], part[part.length - 1]);
    kept.push(loop ? part.slice(0, -2) : part);
    closed.push(loop);
  }
  return { parts: kept, closed };
}

/** Split polylines into dashes of `on` length with `off` gaps, by arc length. */
function dash(parts: number[][], closed: boolean[], on: number, off: number): { parts: number[][]; closed: boolean[] } {
  const out: number[][] = [];
  for (let p = 0; p < parts.length; p++) {
    const src = closed[p] ? [...parts[p], parts[p][0], parts[p][1]] : parts[p];
    let drawing = true, left = on, piece: number[] = [src[0], src[1]];
    for (let i = 2; i < src.length; i += 2) {
      let ax = src[i - 2], ay = src[i - 1];
      const bx = src[i], by = src[i + 1];
      let length = Math.hypot(bx - ax, by - ay);
      while (length > left) {
        const t = left / length;
        ax += (bx - ax) * t;
        ay += (by - ay) * t;
        length -= left;
        if (drawing) {
          piece.push(ax, ay);
          out.push(piece);
        } else piece = [ax, ay];
        drawing = !drawing;
        left = drawing ? on : off;
      }
      left -= length;
      if (drawing) piece.push(bx, by);
    }
    if (drawing && piece.length >= 4) out.push(piece);
  }
  return { parts: out, closed: out.map(() => false) };
}

interface RawPath {
  paint: SketchPaint;
  area: boolean;
  width: number;
  roundCaps: boolean;
  parts: number[][];
  closed: boolean[];
  mode: SketchPath['mode'];
}

interface Paints { path: SketchPaint | null; fillPath: SketchPaint | null; fillSketch: SketchPaint | null }

function fromDrawable(out: RawPath[], drawable: RoughDrawable, paints: Paints, dashing?: [number, number]): void {
  const o = drawable.options;
  for (const set of drawable.sets) {
    const paint = paints[set.type];
    if (paint === null) continue;
    let { parts, closed } = flatten(set.ops);
    if (!parts.length) continue;
    if (set.type === 'fillPath') {
      out.push({ paint, area: true, width: 0, roundCaps: false, parts, closed, mode: 'star' });
      continue;
    }
    if (set.type === 'path' && dashing) ({ parts, closed } = dash(parts, closed, dashing[0], dashing[1]));
    out.push({
      paint, area: false, width: set.type === 'path' ? o.strokeWidth : o.fillWeight,
      roundCaps: set.type === 'path', parts, closed, mode: 'star'
    });
  }
}

function roundedRectPath(w: number, h: number, r: number): string {
  return 'M ' + r + ' 0 L ' + (w - r) + ' 0 Q ' + w + ' 0, ' + w + ' ' + r + ' L ' + w + ' ' + (h - r) +
    ' Q ' + w + ' ' + h + ', ' + (w - r) + ' ' + h + ' L ' + r + ' ' + h + ' Q 0 ' + h + ', 0 ' + (h - r) +
    ' L 0 ' + r + ' Q 0 0, ' + r + ' 0';
}

function diamondPath(w: number, h: number): string {
  const v = cornerRadius(w / 2, false), r = cornerRadius(h / 2, false);
  const p = (x: number, y: number) => x + ' ' + y;
  return 'M ' + p(w / 2 + v, r) + ' L ' + p(w - v, h / 2 - r) + ' C ' + p(w, h / 2) + ', ' + p(w, h / 2) + ', ' + p(w - v, h / 2 + r) +
    ' L ' + p(w / 2 + v, h - r) + ' C ' + p(w / 2, h) + ', ' + p(w / 2, h) + ', ' + p(w / 2 - v, h - r) +
    ' L ' + p(v, h / 2 + r) + ' C ' + p(0, h / 2) + ', ' + p(0, h / 2) + ', ' + p(v, h / 2 - r) +
    ' L ' + p(w / 2 - v, r) + ' C ' + p(w / 2, 0) + ', ' + p(w / 2, 0) + ', ' + p(w / 2 + v, r);
}

const HEAD_SIZE: Record<string, number> = { arrow: 25, bar: 15, dot: 15 };
const HEAD_ANGLE: Record<string, number> = { arrow: 20, bar: 90, dot: 25 };

/** Arrowhead at one end of the drawn line, after Excalidraw's getArrowheadPoints. */
function arrowhead(out: RawPath[], line: RoughDrawable, head: Head, end: boolean, points: number[], options: RoughOptions): void {
  if (head === 'none') return;
  const ops = line.sets.find((set) => set.type === 'path')?.ops ?? [];
  const index = end ? ops.length - 1 : 1;
  const op = ops[index], prev = ops[index - 1];
  if (!op || op.op !== 'bcurveTo' || !prev) return;
  const p0 = prev.op === 'move' ? prev.data : prev.data.slice(4);
  const d = op.data;
  const at = (t: number, k: 0 | 1) => (1 - t) ** 3 * p0[k] + 3 * (1 - t) ** 2 * t * d[k] + 3 * (1 - t) * t * t * d[2 + k] + t ** 3 * d[4 + k];
  const [x1, y1] = end ? [d[4], d[5]] : [p0[0], p0[1]];
  const s = end ? 0.7 : 0.3;
  const x2 = at(s, 0), y2 = at(s, 1);
  const distance = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (x1 - x2) / distance, ny = (y1 - y2) / distance;
  const n = points.length;
  const length = end ? Math.hypot(points[n - 2] - points[n - 4], points[n - 1] - points[n - 3]) : Math.hypot(points[2] - points[0], points[3] - points[1]);
  const size = Math.min(HEAD_SIZE[head], length * 0.5);
  const xs = x1 - nx * size, ys = y1 - ny * size;
  const solid = { ...options, disableMultiStroke: options.disableMultiStroke, fill: undefined };
  if (head === 'dot') {
    const diameter = Math.max(1, Math.hypot(ys - y1, xs - x1) + (options.strokeWidth ?? 2) - 2);
    const dot = generator.circle(x1, y1, diameter, { ...solid, fill: '#000', fillStyle: 'solid', roughness: Math.min(1, options.roughness ?? 0) });
    fromDrawable(out, dot, { path: null, fillPath: PAINT_STROKE, fillSketch: null });
    return;
  }
  const angle = HEAD_ANGLE[head] * Math.PI / 180;
  const turn = (a: number) => [x1 + (xs - x1) * Math.cos(a) - (ys - y1) * Math.sin(a), y1 + (xs - x1) * Math.sin(a) + (ys - y1) * Math.cos(a)];
  const [x3, y3] = turn(-angle), [x4, y4] = turn(angle);
  const paints: Paints = { path: PAINT_STROKE, fillPath: null, fillSketch: null };
  if (head === 'bar') fromDrawable(out, generator.line(x3, y3, x4, y4, solid), paints);
  else {
    fromDrawable(out, generator.line(x3, y3, x1, y1, solid), paints);
    fromDrawable(out, generator.line(x4, y4, x1, y1, solid), paints);
  }
}

function pairs(points: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push([points[i], points[i + 1]]);
  return out;
}

/** The outline of an unrotated element, local to its top-left corner. */
function rawPaths(el: CanvasElement, points?: ArrayLike<number>): RawPath[] {
  const out: RawPath[] = [];
  const w = Math.abs(el.w), h = Math.abs(el.h);
  const style = el.strokeStyle ?? 'solid';
  const sw = el.strokeWidth ?? DEFAULT_STROKE_WIDTH;
  const dashing: [number, number] | undefined = style === 'dashed' ? [8, 8 + sw] : style === 'dotted' ? [1.5, 6 + sw] : undefined;
  const shapePaints: Paints = { path: PAINT_STROKE, fillPath: PAINT_FILL, fillSketch: PAINT_FILL };
  switch (el.kind) {
    case 'rect':
    case 'note':
    case 'frame': {
      const note = el.kind === 'note', frame = el.kind === 'frame';
      const o = roughOptions({ ...el, ...(frame ? { roughness: 0 } : {}), ...(note && !el.fill ? { fill: NOTE_FILL } : {}) }, w, h);
      if (frame) o.strokeWidth = el.strokeWidth ?? 1;
      const radius = frame ? Math.min(FRAME_RADIUS, w / 2, h / 2) : el.round ? cornerRadius(Math.min(w, h), true) : 0;
      if (note && w > 4 && h > 4) {
        const sh = [2, 4, w + 1, 4, w + 1, h + 3, 2, h + 3];
        out.push({ paint: PAINT_SHADOW, area: true, width: 0, roundCaps: false, parts: [sh], closed: [true], mode: 'convex' });
      }
      const shape = radius > 0 ? generator.path(roundedRectPath(w, h, radius), o) : generator.rectangle(0, 0, w, h, o);
      fromDrawable(out, shape, { ...shapePaints, path: note && !el.stroke ? null : PAINT_STROKE }, dashing);
      break;
    }
    case 'diamond': {
      const o = roughOptions(el, w, h);
      const shape = el.round ? generator.path(diamondPath(w, h), o)
        : generator.polygon([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]], o);
      fromDrawable(out, shape, shapePaints, dashing);
      break;
    }
    case 'ellipse': {
      const o = { ...roughOptions(el, w, h), curveFitting: 1 };
      fromDrawable(out, generator.ellipse(w / 2, h / 2, w, h, o), shapePaints, dashing);
      break;
    }
    case 'line':
    case 'arrow': {
      const flat = points ? Array.from(points) : elementPoints(el);
      if (flat.length < 4) break;
      const [x0, y0, x1, y1] = pointBounds(flat);
      const n = flat.length;
      const loop = el.kind === 'line' && n >= 8 && Math.hypot(flat[0] - flat[n - 2], flat[1] - flat[n - 1]) < 8;
      const o = roughOptions(loop ? el : { ...el, fill: undefined }, x1 - x0, y1 - y0);
      const list = pairs(flat);
      const curve = el.round && !el.elbow && list.length > 2;
      const line = curve ? generator.curve(list, o) : loop && el.fill ? generator.polygon(list, o) : generator.linearPath(list, o);
      fromDrawable(out, line, shapePaints, dashing);
      if (loop) for (const path of out) if (path.area) path.mode = 'simple';
      if (el.kind === 'arrow' || el.startHead || el.endHead) {
        const headOptions = { ...o, strokeWidth: style === 'solid' ? sw : sw + 0.5 };
        arrowhead(out, line, el.startHead ?? 'none', false, flat, headOptions);
        arrowhead(out, line, el.endHead ?? (el.kind === 'arrow' ? 'arrow' : 'none'), true, flat, headOptions);
      }
      break;
    }
    case 'draw': {
      const flat = elementPoints(el);
      if (!flat.length) break;
      const polygons = inkSamplePolygons(inkSamples(flat, el.pressures, drawWidth(el), 0, 0));
      out.push({
        paint: PAINT_STROKE, area: true, width: 0, roundCaps: false,
        parts: polygons.map((polygon) => polygon.flatMap((p) => [p.x, p.y])), closed: polygons.map(() => true), mode: 'convex'
      });
      break;
    }
    case 'text':
    case 'image':
      break;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ triangles

class Builder {
  positions: number[] = [];
  paints: number[] = [];
  indices: number[] = [];
  vertex(x: number, y: number, paint: number): number {
    this.positions.push(x, y);
    this.paints.push(paint);
    return this.paints.length - 1;
  }
}

function earClip(pts: Float64Array): number[] | null {
  const n = pts.length / 2;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  const sign = area >= 0 ? 1 : -1;
  const ring = Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const cross = (a: number, b: number, c: number) =>
    (pts[b * 2] - pts[a * 2]) * (pts[c * 2 + 1] - pts[a * 2 + 1]) - (pts[b * 2 + 1] - pts[a * 2 + 1]) * (pts[c * 2] - pts[a * 2]);
  let guard = n * n + 8;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
      if (cross(a, b, c) * sign <= 0) continue;
      let inside = false;
      for (const p of ring) {
        if (p === a || p === b || p === c) continue;
        if (cross(a, b, p) * sign >= 0 && cross(b, c, p) * sign >= 0 && cross(c, a, p) * sign >= 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(a, b, c);
      ring.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (ring.length === 3) out.push(ring[0], ring[1], ring[2]);
  return out;
}

function fillArea(b: Builder, pts: Float64Array, mode: SketchPath['mode'], paint: number): void {
  const n = pts.length / 2;
  if (n < 3) return;
  const first = b.paints.length;
  for (let i = 0; i < n; i++) b.vertex(pts[i * 2], pts[i * 2 + 1], paint);
  if (mode === 'simple') {
    const triangles = earClip(pts);
    if (triangles) {
      for (const i of triangles) b.indices.push(first + i);
      return;
    }
  }
  if (mode === 'convex') {
    for (let i = 1; i < n - 1; i++) b.indices.push(first, first + i, first + i + 1);
    return;
  }
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) {
    cx += pts[i * 2];
    cy += pts[i * 2 + 1];
  }
  const centre = b.vertex(cx / n, cy / n, paint);
  for (let i = 0; i < n; i++) b.indices.push(centre, first + i, first + (i + 1) % n);
}

function cap(b: Builder, x: number, y: number, dx: number, dy: number, hw: number, left: number, right: number, paint: number): void {
  // Half disc beyond (x, y) in direction (dx, dy), from the left edge vertex round to the right one.
  const nx = -dy, ny = dx;
  const centre = b.vertex(x, y, paint);
  let previous = left;
  for (let k = 1; k < 4; k++) {
    const a = k * Math.PI / 4;
    const v = b.vertex(x + hw * (nx * Math.cos(a) + dx * Math.sin(a)), y + hw * (ny * Math.cos(a) + dy * Math.sin(a)), paint);
    b.indices.push(centre, previous, v);
    previous = v;
  }
  b.indices.push(centre, previous, right);
}

function strokeLine(b: Builder, pts: Float64Array, closed: boolean, hw: number, roundCaps: boolean, paint: number): void {
  const n = pts.length / 2;
  if (n < 2) return;
  const dir = (i: number, j: number): [number, number] => {
    const dx = pts[j * 2] - pts[i * 2], dy = pts[j * 2 + 1] - pts[i * 2 + 1], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const pairsAt: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    const hasIn = closed || i > 0, hasOut = closed || i < n - 1;
    const din = hasIn ? dir((i + n - 1) % n, i) : dir(i, i + 1);
    const dout = hasOut ? dir(i, (i + 1) % n) : din;
    const n0x = -din[1], n0y = din[0], n1x = -dout[1], n1y = dout[0];
    let mx = n0x + n1x, my = n0y + n1y;
    const ml = Math.hypot(mx, my);
    const dot = ml ? (mx / ml) * n1x + (my / ml) * n1y : 0;
    if (ml > 1e-9 && hw / dot <= hw * MITER_LIMIT) {
      const s = hw / dot / ml;
      mx *= s;
      my *= s;
      pairsAt.push([b.vertex(x + mx, y + my, paint), b.vertex(x - mx, y - my, paint)]);
    } else {
      // Sharp turn: bevel through both segment normals.
      pairsAt.push([b.vertex(x + n0x * hw, y + n0y * hw, paint), b.vertex(x - n0x * hw, y - n0y * hw, paint)]);
      pairsAt.push([b.vertex(x + n1x * hw, y + n1y * hw, paint), b.vertex(x - n1x * hw, y - n1y * hw, paint)]);
    }
  }
  const count = pairsAt.length;
  for (let k = 0; k < (closed ? count : count - 1); k++) {
    const [l0, r0] = pairsAt[k], [l1, r1] = pairsAt[(k + 1) % count];
    b.indices.push(l0, r0, l1, r0, r1, l1);
  }
  if (!closed && roundCaps) {
    const [sx, sy] = dir(0, 1), [ex, ey] = dir(n - 2, n - 1);
    cap(b, pts[0], pts[1], -sx, -sy, hw, pairsAt[0][1], pairsAt[0][0], paint);
    cap(b, pts[n * 2 - 2], pts[n * 2 - 1], ex, ey, hw, pairsAt[count - 1][0], pairsAt[count - 1][1], paint);
  }
}

function dot(b: Builder, x: number, y: number, r: number, paint: number): void {
  const centre = b.vertex(x, y, paint);
  const first = b.paints.length;
  for (let k = 0; k < 8; k++) b.vertex(x + r * Math.cos(k * Math.PI / 4), y + r * Math.sin(k * Math.PI / 4), paint);
  for (let k = 0; k < 8; k++) b.indices.push(centre, first + k, first + (k + 1) % 8);
}

const EMPTY_BOUNDS: [number, number, number, number] = [0, 0, 0, 0];

function buildSketch(el: CanvasElement, key: string, points?: ArrayLike<number>): ElementSketch {
  const raw = rawPaths(el, points);
  const angle = el.angle ?? 0;
  const centre = angle ? elementCentre(el, points) : { x: 0, y: 0 };
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const b = new Builder();
  const paths: SketchPath[] = [];
  for (const path of raw) {
    const parts = path.parts.map((part) => {
      const out = new Float64Array(part.length);
      for (let i = 0; i < part.length; i += 2) {
        const dx = part[i] - centre.x, dy = part[i + 1] - centre.y;
        out[i] = angle ? centre.x + dx * cos - dy * sin : part[i];
        out[i + 1] = angle ? centre.y + dx * sin + dy * cos : part[i + 1];
      }
      return out;
    });
    paths.push({ ...path, parts });
    parts.forEach((part, i) => {
      if (path.area) fillArea(b, part, path.mode, path.paint);
      else if (part.length === 2) dot(b, part[0], part[1], path.width / 2, path.paint);
      else strokeLine(b, part, path.closed[i], path.width / 2, path.roundCaps, path.paint);
    });
  }
  const positions = new Float64Array(b.positions);
  return {
    key,
    positions,
    paints: new Uint8Array(b.paints),
    indices: new Uint32Array(b.indices),
    bounds: positions.length ? pointBounds(positions) : EMPTY_BOUNDS,
    paths
  };
}

// ------------------------------------------------------------------------------------------ SVG

const svgNumber = (v: number) => String(Math.round(v * 100) / 100);

function paintAttr(kind: 'fill' | 'stroke', color: RGBA): string {
  if (!color.a) return kind + '="none"';
  const channel = (v: number) => Math.round(Math.max(0, Math.min(1, v / color.a)) * 255);
  return kind + '="rgb(' + channel(color.r) + ',' + channel(color.g) + ',' + channel(color.b) + ')" ' + kind + '-opacity="' + svgNumber(color.a) + '"';
}

/** Path data for one sketch path, offset to world coordinates. */
export function sketchPathData(path: SketchPath, ox: number, oy: number): string {
  let d = '';
  path.parts.forEach((part, k) => {
    for (let i = 0; i < part.length; i += 2) d += (i ? 'L' : 'M') + svgNumber(ox + part[i]) + ' ' + svgNumber(oy + part[i + 1]);
    if (part.length === 2) d += 'l0 0';
    if (path.area || path.closed[k]) d += 'Z';
  });
  return d;
}

/**
 * SVG markup for a sketch placed at (ox, oy). `color` gives each paint's premultiplied colour, or null to
 * leave that paint out.
 */
export function sketchSvg(sketch: ElementSketch, ox: number, oy: number, color: (paint: SketchPaint) => RGBA | null): string {
  let markup = '';
  for (const path of sketch.paths) {
    const c = color(path.paint);
    if (!c || !c.a) continue;
    const d = sketchPathData(path, ox, oy);
    markup += path.area
      ? '<path d="' + d + '" ' + paintAttr('fill', c) + '/>'
      : '<path d="' + d + '" fill="none" ' + paintAttr('stroke', c) + ' stroke-width="' + svgNumber(path.width) +
        '" stroke-linejoin="miter" stroke-miterlimit="' + MITER_LIMIT + '" stroke-linecap="' + (path.roundCaps ? 'round' : 'butt') + '"/>';
  }
  return markup;
}
