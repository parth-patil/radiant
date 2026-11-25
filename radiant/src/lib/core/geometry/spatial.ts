import type { CanvasElement, NodeBox, NodeId, Rect, Vec2 } from '../types';
import { elementBand, FRAME_NAME_SIZE, type CanvasBand } from './canvas-scene';
import { GridIndex } from './grid';
import { inkSamples, inkSamplesHit } from './ink';
import { drawWidth, elementCentre, elementPoints, isLinear, PAINT_STROKE, sketchElement } from './sketch';

export type Direction = 'left' | 'right' | 'up' | 'down';

/**
 * Uniform-grid spatial index over node boxes (CSR layout in typed arrays, so build is a counting sort).
 * A box is registered in every cell it overlaps. Boxes are in the order given to `build`; later = on top.
 */
export class SpatialIndex {
  private n = 0;
  private ids: NodeId[] = [];
  private x0 = new Float64Array(0);
  private y0 = new Float64Array(0);
  private x1 = new Float64Array(0);
  private y1 = new Float64Array(0);
  private depth = new Int16Array(0);
  private cell = 1;
  private ox = 0;
  private oy = 0;
  private gx = 1;
  private gy = 1;
  private start = new Uint32Array(2);
  private items = new Uint32Array(0);
  private stamp = new Uint32Array(0);
  private stampNow = 0;
  private moved = new Set<number>();

  /** Restore a worker-built index from its structured-cloned data. */
  adopt(snapshot: SpatialIndex): void {
    Object.assign(this, snapshot);
  }

  transferBuffers(): ArrayBuffer[] {
    return [this.x0, this.y0, this.x1, this.y1, this.depth, this.start, this.items, this.stamp]
      .map((array) => array.buffer as ArrayBuffer).filter((buffer) => buffer.byteLength);
  }

  /** Number of indexed boxes. */
  get size(): number {
    return this.n;
  }

  /** (Re)build the index. Cost is linear in the number of boxes. */
  build(boxes: Iterable<NodeBox>): void {
    const arr = Array.isArray(boxes) ? (boxes as NodeBox[]) : Array.from(boxes);
    const n = arr.length;
    this.n = n;
    this.ids = new Array<NodeId>(n);
    this.x0 = new Float64Array(n);
    this.y0 = new Float64Array(n);
    this.x1 = new Float64Array(n);
    this.y1 = new Float64Array(n);
    this.depth = new Int16Array(n);
    this.stamp = new Uint32Array(n);
    this.stampNow = 0;
    this.moved.clear();
    if (n === 0) {
      this.gx = this.gy = 1;
      this.start = new Uint32Array(2);
      this.items = new Uint32Array(0);
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      sw = 0,
      sh = 0;
    for (let i = 0; i < n; i++) {
      const b = arr[i];
      const l = b.x - b.w / 2,
        t = b.y - b.h / 2,
        r = b.x + b.w / 2,
        bt = b.y + b.h / 2;
      this.ids[i] = b.id;
      this.x0[i] = l;
      this.y0[i] = t;
      this.x1[i] = r;
      this.y1[i] = bt;
      this.depth[i] = b.depth;
      if (l < minX) minX = l;
      if (t < minY) minY = t;
      if (r > maxX) maxX = r;
      if (bt > maxY) maxY = bt;
      sw += b.w;
      sh += b.h;
    }
    const W = Math.max(maxX - minX, 1),
      H = Math.max(maxY - minY, 1);
    let cell = Math.max(Math.sqrt((W * H) / n) * 1.5, sw / n, sh / n, 8);
    // keep the grid at most ~4 cells per box
    while ((Math.ceil(W / cell) + 1) * (Math.ceil(H / cell) + 1) > 4 * n + 16) cell *= 1.25;
    this.cell = cell;
    this.ox = minX;
    this.oy = minY;
    const gx = (this.gx = Math.floor(W / cell) + 1);
    const gy = (this.gy = Math.floor(H / cell) + 1);
    const cells = gx * gy;
    const start = new Uint32Array(cells + 1);
    const inv = 1 / cell;
    for (let i = 0; i < n; i++) {
      const cx0 = ((this.x0[i] - minX) * inv) | 0,
        cx1 = ((this.x1[i] - minX) * inv) | 0;
      const cy0 = ((this.y0[i] - minY) * inv) | 0,
        cy1 = ((this.y1[i] - minY) * inv) | 0;
      for (let cy = cy0; cy <= cy1; cy++) {
        const row = cy * gx;
        for (let cx = cx0; cx <= cx1; cx++) start[row + cx + 1]++;
      }
    }
    for (let c = 0; c < cells; c++) start[c + 1] += start[c];
    const fill = start.slice(0, cells);
    const items = new Uint32Array(start[cells]);
    for (let i = 0; i < n; i++) {
      const cx0 = ((this.x0[i] - minX) * inv) | 0,
        cx1 = ((this.x1[i] - minX) * inv) | 0;
      const cy0 = ((this.y0[i] - minY) * inv) | 0,
        cy1 = ((this.y1[i] - minY) * inv) | 0;
      for (let cy = cy0; cy <= cy1; cy++) {
        const row = cy * gx;
        for (let cx = cx0; cx <= cx1; cx++) items[fill[row + cx]++] = i;
      }
    }
    this.start = start;
    this.items = items;
  }

  /**
   * Keep the cell directory when a small, stable-order layout edit only moves a few boxes.
   * Changed boxes bypass their original cells until the next rebuild.
   */
  update(boxes: Iterable<NodeBox>, fallback?: SpatialIndex): void {
    const rebuild = (next: NodeBox[]) => fallback ? this.adopt(fallback) : this.build(next);
    const next = Array.from(boxes);
    if (next.length !== this.n || this.x0.length !== this.n) {
      rebuild(next);
      return;
    }
    const changed: number[] = [];
    const maxMoved = Math.min(32, this.n / 4);
    for (let i = 0; i < next.length; i++) {
      const b = next[i];
      if (b.id !== this.ids[i]) {
        rebuild(next);
        return;
      }
      if (this.x0[i] !== b.x - b.w / 2 || this.x1[i] !== b.x + b.w / 2 ||
          this.y0[i] !== b.y - b.h / 2 || this.y1[i] !== b.y + b.h / 2 ||
          this.depth[i] !== b.depth) {
        changed.push(i);
        if (changed.length > maxMoved) {
          rebuild(next);
          return;
        }
      }
    }
    const moved = new Set([...this.moved, ...changed]);
    if (moved.size > maxMoved) {
      rebuild(next);
      return;
    }
    this.moved = moved;
    for (const i of changed) {
      const b = next[i];
      this.x0[i] = b.x - b.w / 2;
      this.x1[i] = b.x + b.w / 2;
      this.y0[i] = b.y - b.h / 2;
      this.y1[i] = b.y + b.h / 2;
      this.depth[i] = b.depth;
    }
  }

  /** Ids of all boxes intersecting `rect` (touching counts). Order is unspecified. */
  query(rect: Rect): NodeId[] {
    const out: NodeId[] = [];
    const n = this.n;
    if (n === 0) return out;
    const rx0 = rect.x,
      ry0 = rect.y,
      rx1 = rect.x + rect.w,
      ry1 = rect.y + rect.h;
    const inv = 1 / this.cell;
    let cx0 = Math.floor((rx0 - this.ox) * inv),
      cx1 = Math.floor((rx1 - this.ox) * inv);
    let cy0 = Math.floor((ry0 - this.oy) * inv),
      cy1 = Math.floor((ry1 - this.oy) * inv);
    for (const i of this.moved) {
      if (this.x0[i] <= rx1 && this.x1[i] >= rx0 && this.y0[i] <= ry1 && this.y1[i] >= ry0) out.push(this.ids[i]);
    }
    if (cx1 < 0 || cy1 < 0 || cx0 >= this.gx || cy0 >= this.gy) return out;
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.gx) cx1 = this.gx - 1;
    if (cy1 >= this.gy) cy1 = this.gy - 1;
    const x0 = this.x0,
      y0 = this.y0,
      x1 = this.x1,
      y1 = this.y1;
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > n) {
      for (let i = 0; i < n; i++) {
        if (x0[i] <= rx1 && x1[i] >= rx0 && y0[i] <= ry1 && y1[i] >= ry0 && !this.moved.has(i)) out.push(this.ids[i]);
      }
      return out;
    }
    const stamp = this.stamp;
    if (++this.stampNow === 0xffffffff) {
      stamp.fill(0);
      this.stampNow = 1;
    }
    const now = this.stampNow;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.gx + cx;
        for (let k = this.start[c], e = this.start[c + 1]; k < e; k++) {
          const i = this.items[k];
          if (stamp[i] === now || this.moved.has(i)) continue;
          stamp[i] = now;
          if (x0[i] <= rx1 && x1[i] >= rx0 && y0[i] <= ry1 && y1[i] >= ry0) out.push(this.ids[i]);
        }
      }
    }
    return out;
  }

  /**
   * Topmost node under `p`: boxes inflated by `slop` world units; the deepest wins, ties go to the box
   * that was added last. Returns null if nothing is hit.
   */
  hitTest(p: Vec2, slop = 4): NodeId | null {
    if (this.n === 0) return null;
    const inv = 1 / this.cell;
    // a box inflated by slop may reach into a neighbouring cell: scan the cell range of the inflated point
    let cx0 = Math.floor((p.x - slop - this.ox) * inv),
      cx1 = Math.floor((p.x + slop - this.ox) * inv);
    let cy0 = Math.floor((p.y - slop - this.oy) * inv),
      cy1 = Math.floor((p.y + slop - this.oy) * inv);
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.gx) cx1 = this.gx - 1;
    if (cy1 >= this.gy) cy1 = this.gy - 1;
    let best = -1,
      bestDepth = -1;
    for (const i of this.moved) {
      const d = this.depth[i];
      if (p.x >= this.x0[i] - slop && p.x <= this.x1[i] + slop &&
          p.y >= this.y0[i] - slop && p.y <= this.y1[i] + slop &&
          (d > bestDepth || (d === bestDepth && i > best))) {
        best = i;
        bestDepth = d;
      }
    }
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.gx + cx;
        for (let k = this.start[c], e = this.start[c + 1]; k < e; k++) {
          const i = this.items[k];
          if (
            !this.moved.has(i) &&
            p.x >= this.x0[i] - slop &&
            p.x <= this.x1[i] + slop &&
            p.y >= this.y0[i] - slop &&
            p.y <= this.y1[i] + slop
          ) {
            const d = this.depth[i];
            if (d > bestDepth || (d === bestDepth && i > best)) {
              best = i;
              bestDepth = d;
            }
          }
        }
      }
    }
    return best < 0 ? null : this.ids[best];
  }

  /**
   * Spatial fallback for arrow-key navigation: the nearest centre in the requested half-plane.
   */
  nearestInDirection(fromId: NodeId, dir: Direction): NodeId | null {
    const n = this.n;
    let from = -1;
    for (let i = 0; i < n; i++) {
      if (this.ids[i] === fromId) {
        from = i;
        break;
      }
    }
    if (from < 0) return null;
    const fcx = (this.x0[from] + this.x1[from]) / 2,
      fcy = (this.y0[from] + this.y1[from]) / 2;
    let best = -1,
      bestScore = Infinity;
    for (let i = 0; i < n; i++) {
      if (i === from) continue;
      const dx = (this.x0[i] + this.x1[i]) / 2 - fcx;
      const dy = (this.y0[i] + this.y1[i]) / 2 - fcy;
      const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
      // Symmetric layouts can put a centre infinitesimally to one side of an axis.
      if (along <= 1e-9) continue;
      const score = dx * dx + dy * dy;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best < 0 ? null : this.ids[best];
  }
}

// ------------------------------------------------------------------------------------------ canvas elements

function rotatedBox(el: CanvasElement): Rect {
  const w = Math.abs(el.w), h = Math.abs(el.h), angle = el.angle ?? 0;
  if (!angle) return { x: el.x, y: el.y, w, h };
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const rw = w * c + h * s, rh = w * s + h * c;
  return { x: el.x + w / 2 - rw / 2, y: el.y + h / 2 - rh / 2, w: rw, h: rh };
}

/** Height of the band above a frame that holds its name, and the widest the name is hit. */
const FRAME_NAME_BAND = FRAME_NAME_SIZE * 1.25 + 8;
const FRAME_NAME_WIDTH = 240;

/**
 * World bounds of everything drawn for an element: stroke width, arrowheads, rotation and a frame's name.
 * `points` are resolved line or arrow points (see resolveCanvasPoints).
 */
export function elementBounds(el: CanvasElement, points?: ArrayLike<number>): Rect {
  const sketch = sketchElement(el, points);
  const linear = isLinear(el.kind) || el.kind === 'draw';
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (sketch.indices.length) {
    x0 = el.x + sketch.bounds[0];
    y0 = el.y + sketch.bounds[1];
    x1 = el.x + sketch.bounds[2];
    y1 = el.y + sketch.bounds[3];
  }
  if (!linear || !sketch.indices.length) {
    const box = rotatedBox(el);
    x0 = Math.min(x0, box.x);
    y0 = Math.min(y0, box.y);
    x1 = Math.max(x1, box.x + box.w);
    y1 = Math.max(y1, box.y + box.h);
  }
  if (el.kind === 'frame' && el.text) y0 = Math.min(y0, el.y - FRAME_NAME_BAND);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, square = dx * dx + dy * dy;
  const t = square ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / square)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

function insidePolygon(points: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
    const xi = points[i], yi = points[i + 1], xj = points[j], yj = points[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point relative to the element's unrotated box, centre at the origin. */
function unrotated(el: CanvasElement, p: Vec2): Vec2 {
  const cx = el.x + Math.abs(el.w) / 2, cy = el.y + Math.abs(el.h) / 2, angle = -(el.angle ?? 0);
  const dx = p.x - cx, dy = p.y - cy;
  return angle ? { x: dx * Math.cos(angle) - dy * Math.sin(angle), y: dx * Math.sin(angle) + dy * Math.cos(angle) } : { x: dx, y: dy };
}

/** The drawn outline (stroke paths and arrowheads), undashed so a click in a gap still counts. */
function strokeHit(el: CanvasElement, p: Vec2, tolerance: number, points?: ArrayLike<number>): boolean {
  const solid = el.strokeStyle && el.strokeStyle !== 'solid' ? { ...el, strokeStyle: 'solid' as const } : el;
  const x = p.x - el.x, y = p.y - el.y;
  for (const path of sketchElement(solid, points).paths) {
    if (path.paint !== PAINT_STROKE) continue;
    for (let k = 0; k < path.parts.length; k++) {
      const part = path.parts[k];
      if (path.area) {
        if (insidePolygon(part, x, y)) return true;
        continue;
      }
      const reach = tolerance + path.width / 2;
      const n = part.length;
      for (let i = 2; i < n; i += 2) {
        if (segmentDistance(x, y, part[i - 2], part[i - 1], part[i], part[i + 1]) <= reach) return true;
      }
      if (path.closed[k] && n >= 4 && segmentDistance(x, y, part[n - 2], part[n - 1], part[0], part[1]) <= reach) return true;
    }
  }
  return false;
}

/**
 * Precise hit test (CNV-27). `tolerance` is in world units (6 screen px / zoom). An unfilled shape is hit on
 * its stroke, a filled one anywhere inside; lines and arrows near their path; notes, text and pictures inside
 * their box; frames on their outline or their name.
 */
export function elementHit(el: CanvasElement, p: Vec2, tolerance: number, points?: ArrayLike<number>): boolean {
  const w = Math.abs(el.w) / 2 + tolerance, h = Math.abs(el.h) / 2 + tolerance;
  switch (el.kind) {
    case 'note':
    case 'text':
    case 'image': {
      const q = unrotated(el, p);
      return Math.abs(q.x) <= w && Math.abs(q.y) <= h;
    }
    case 'frame': {
      const q = unrotated(el, p);
      const left = -Math.abs(el.w) / 2, top = -Math.abs(el.h) / 2;
      if (el.text && q.x >= left - tolerance && q.x <= left + Math.min(Math.abs(el.w), FRAME_NAME_WIDTH) &&
          q.y >= top - FRAME_NAME_BAND && q.y <= top) return true;
      if (el.fill && Math.abs(q.x) <= w && Math.abs(q.y) <= h) return true;
      return strokeHit(el, p, tolerance, points);
    }
    case 'rect':
    case 'ellipse':
    case 'diamond': {
      if (el.fill) {
        const q = unrotated(el, p);
        const inside = el.kind === 'rect' ? Math.abs(q.x) <= w && Math.abs(q.y) <= h
          : el.kind === 'ellipse' ? (q.x / w) ** 2 + (q.y / h) ** 2 <= 1
          : Math.abs(q.x) / w + Math.abs(q.y) / h <= 1;
        if (inside) return true;
      }
      return strokeHit(el, p, tolerance, points);
    }
    case 'line':
    case 'arrow': {
      if (strokeHit(el, p, tolerance, points)) return true;
      if (el.kind !== 'line' || !el.fill) return false;
      const flat = points ?? elementPoints(el), n = flat.length;
      if (n < 8 || Math.hypot(flat[0] - flat[n - 2], flat[1] - flat[n - 1]) >= 8) return false;
      const angle = el.angle ?? 0, centre = elementCentre(el, flat);
      const dx = p.x - el.x - centre.x, dy = p.y - el.y - centre.y;
      const x = centre.x + dx * Math.cos(-angle) - dy * Math.sin(-angle), y = centre.y + dx * Math.sin(-angle) + dy * Math.cos(-angle);
      return insidePolygon(flat, x, y);
    }
    case 'draw': {
      const flat = elementPoints(el);
      return inkSamplesHit(inkSamples(flat, el.pressures, drawWidth(el), el.x, el.y, el.angle ?? 0, elementCentre(el, flat)), p, tolerance);
    }
  }
  return false;
}

export interface ElementHit { id: string; band: CanvasBand }

/**
 * Spatial index over canvas elements in stacking order (back band, then front band, array order within
 * each), with a precise hit test where the top-most element wins.
 */
export class ElementIndex {
  private grid = new GridIndex();
  private elements: CanvasElement[] = [];
  private bands: CanvasBand[] = [];
  private boxes = new Float64Array(0);
  private points: ReadonlyMap<string, ArrayLike<number>> = new Map();

  get size(): number {
    return this.elements.length;
  }

  /** `points` are resolved line and arrow points by element id (CanvasScene.points). */
  build(elements: readonly CanvasElement[], points?: ReadonlyMap<string, ArrayLike<number>>): void {
    const back = elements.filter((el) => elementBand(el) === 'back');
    const front = elements.filter((el) => elementBand(el) === 'front');
    this.elements = [...back, ...front];
    this.bands = this.elements.map((_, i) => i < back.length ? 'back' : 'front');
    this.points = points ?? new Map();
    const n = this.elements.length;
    this.boxes = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const el = this.elements[i];
      const r = elementBounds(el, this.points.get(el.id));
      this.boxes.set([r.x, r.y, r.x + r.w, r.y + r.h], i * 4);
    }
    this.grid.build(this.boxes, n);
  }

  /** World bounds of an indexed element. */
  bounds(id: string): Rect | undefined {
    const i = this.elements.findIndex((el) => el.id === id);
    if (i < 0) return;
    const b = this.boxes;
    return { x: b[i * 4], y: b[i * 4 + 1], w: b[i * 4 + 2] - b[i * 4], h: b[i * 4 + 3] - b[i * 4 + 1] };
  }

  /** Union of the bounds of every indexed element, or null when there are none (Zoom to Fit, mini-map). */
  extent(): Rect | null {
    const b = this.boxes, n = this.elements.length;
    if (!n) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, b[i * 4]); y0 = Math.min(y0, b[i * 4 + 1]);
      x1 = Math.max(x1, b[i * 4 + 2]); y1 = Math.max(y1, b[i * 4 + 3]);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** Every indexed element with its world bounds, in stacking order. */
  entries(): Array<{ el: CanvasElement; x: number; y: number; w: number; h: number }> {
    const b = this.boxes;
    return this.elements.map((el, i) => ({ el, x: b[i * 4], y: b[i * 4 + 1], w: b[i * 4 + 2] - b[i * 4], h: b[i * 4 + 3] - b[i * 4 + 1] }));
  }

  /** Ids of elements whose bounds intersect `rect`, bottom first. `skip` leaves out e.g. locked elements. */
  query(rect: Rect, skip?: (el: CanvasElement) => boolean): string[] {
    const out: string[] = [];
    for (const i of this.grid.query(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h)) {
      const el = this.elements[i];
      if (!skip?.(el)) out.push(el.id);
    }
    return out;
  }

  /** Top-most element under `p` within `tolerance` world units, optionally only in one band. */
  hitTest(p: Vec2, tolerance: number, band?: CanvasBand, skip?: (el: CanvasElement) => boolean): ElementHit | null {
    const candidates = this.grid.query(p.x - tolerance, p.y - tolerance, p.x + tolerance, p.y + tolerance);
    for (let k = candidates.length - 1; k >= 0; k--) {
      const i = candidates[k];
      const el = this.elements[i];
      if ((band && this.bands[i] !== band) || skip?.(el)) continue;
      if (elementHit(el, p, tolerance, this.points.get(el.id))) return { id: el.id, band: this.bands[i] };
    }
    return null;
  }
}

/**
 * The top-most thing under `p` across both kinds: the front band covers the maps, which cover the back band.
 * `tolerance` and `nodeSlop` are world units.
 */
export function canvasHitTest(p: Vec2, tolerance: number, elements: ElementIndex, nodes: SpatialIndex, nodeSlop = 4,
  skip?: (el: CanvasElement) => boolean): { kind: 'node' | 'element'; id: string } | null {
  const front = elements.hitTest(p, tolerance, 'front', skip);
  if (front) return { kind: 'element', id: front.id };
  const node = nodes.hitTest(p, nodeSlop);
  if (node) return { kind: 'node', id: node };
  const back = elements.hitTest(p, tolerance, 'back', skip);
  return back ? { kind: 'element', id: back.id } : null;
}
