import type { CanvasBinding, CanvasElement, CanvasElementKind, Doc, NodeId, Op, Rect, Vec2 } from '../core/types';
import { elementPoints, isLinear, pointBounds } from '../core/geometry/sketch';
import { newId } from '../core/model';

/**
 * Pure helpers for the canvas tools (spec 7.3): element boxes, resize and rotate maths, frame membership, new
 * elements with the current style, and id remapping for paste. No Svelte, no DOM.
 */

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Style that new elements take (the style bar's last choices). */
export interface ElementStyle {
  stroke?: string;
  fill?: string;
  fillStyle?: CanvasElement['fillStyle'];
  strokeWidth?: number;
  strokeStyle?: CanvasElement['strokeStyle'];
  roughness?: CanvasElement['roughness'];
  round?: boolean;
  opacity?: number;
  font?: CanvasElement['font'];
  fontSize?: number;
}

const rotate = (x: number, y: number, angle: number): Vec2 =>
  angle ? { x: x * Math.cos(angle) - y * Math.sin(angle), y: x * Math.sin(angle) + y * Math.cos(angle) } : { x, y };

export const isPath = (kind: CanvasElementKind): boolean => isLinear(kind) || kind === 'draw';

/** The unrotated box of an element in world units: its (x, y, w, h), or the extent of its points for paths. */
export function elementBox(el: CanvasElement): Rect {
  if (isPath(el.kind)) {
    const [x0, y0, x1, y1] = pointBounds(elementPoints(el));
    return { x: el.x + x0, y: el.y + y0, w: x1 - x0, h: y1 - y0 };
  }
  return { x: el.x, y: el.y, w: Math.abs(el.w), h: Math.abs(el.h) };
}

export const boxCentre = (r: Rect): Vec2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** The four corners of an element's box, rotated about its centre. */
export function elementCorners(el: CanvasElement): Vec2[] {
  const box = elementBox(el), c = boxCentre(box), angle = el.angle ?? 0;
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => {
    const p = rotate(sx * box.w / 2, sy * box.h / 2, angle);
    return { x: c.x + p.x, y: c.y + p.y };
  });
}

/** Axis-aligned bounds of the rotated boxes of several elements. */
export function selectionBounds(elements: readonly CanvasElement[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of elements) {
    for (const p of elementCorners(el)) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
  }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Give an element a new unrotated box (scaling its points for paths). Sizes keep a small minimum. */
export function withBox(el: CanvasElement, box: Rect): CanvasElement {
  const w = Math.max(box.w, 1), h = Math.max(box.h, 1);
  if (!isPath(el.kind)) return { ...el, x: box.x, y: box.y, w, h };
  const old = elementBox(el), local = elementPoints(el);
  const [px, py] = pointBounds(local);
  const sx = old.w > 1e-6 ? box.w / old.w : 1, sy = old.h > 1e-6 ? box.h / old.h : 1;
  const points = local.map((v, i) => (i % 2 ? (v - py) * sy : (v - px) * sx));
  return { ...el, x: box.x, y: box.y, w: Math.abs(box.w), h: Math.abs(box.h), points };
}

/**
 * Resize one element by dragging `handle` to world point `p`, in the element's rotated frame. Shift keeps the
 * aspect ratio, Option resizes about the centre.
 */
export function resizeOne(el: CanvasElement, handle: Handle, p: Vec2, keepAspect: boolean, fromCentre: boolean): CanvasElement {
  const box = elementBox(el), c = boxCentre(box), angle = el.angle ?? 0;
  const q = rotate(p.x - c.x, p.y - c.y, -angle);
  const hw = box.w / 2, hh = box.h / 2;
  let left = -hw, right = hw, top = -hh, bottom = hh;
  if (handle.includes('w')) left = q.x;
  if (handle.includes('e')) right = q.x;
  if (handle.includes('n')) top = q.y;
  if (handle.includes('s')) bottom = q.y;
  if (fromCentre) {
    if (handle.includes('w')) right = -left;
    if (handle.includes('e')) left = -right;
    if (handle.includes('n')) bottom = -top;
    if (handle.includes('s')) top = -bottom;
  }
  if (left > right) [left, right] = [right, left];
  if (top > bottom) [top, bottom] = [bottom, top];
  let w = right - left, h = bottom - top;
  if (keepAspect && box.w > 0 && box.h > 0) {
    const horizontal = handle.includes('e') || handle.includes('w'), vertical = handle.includes('n') || handle.includes('s');
    const s = horizontal && vertical ? Math.max(w / box.w, h / box.h) : horizontal ? w / box.w : h / box.h;
    w = box.w * s;
    h = box.h * s;
    if (fromCentre || !horizontal) { left = -w / 2; right = w / 2; }
    else if (handle.includes('w')) left = right - w;
    else right = left + w;
    if (fromCentre || !vertical) { top = -h / 2; bottom = h / 2; }
    else if (handle.includes('n')) top = bottom - h;
    else bottom = top + h;
  }
  const mid = rotate((left + right) / 2, (top + bottom) / 2, angle);
  const nc = { x: c.x + mid.x, y: c.y + mid.y };
  return withBox(el, { x: nc.x - w / 2, y: nc.y - h / 2, w, h });
}

/** Scale several elements from the selection box `from` to `to` (each element's box scales about `from`'s origin). */
export function resizeMany(elements: readonly CanvasElement[], from: Rect, to: Rect): CanvasElement[] {
  const sx = from.w > 1e-6 ? to.w / from.w : 1, sy = from.h > 1e-6 ? to.h / from.h : 1;
  return elements.map((el) => {
    const box = elementBox(el);
    return withBox(el, { x: to.x + (box.x - from.x) * sx, y: to.y + (box.y - from.y) * sy, w: box.w * sx, h: box.h * sy });
  });
}

/** The selection box after dragging `handle` to `p` (axis aligned). */
export function resizeBox(box: Rect, handle: Handle, p: Vec2, keepAspect: boolean, fromCentre: boolean): Rect {
  const el = { id: '', kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, seed: 1 } as CanvasElement;
  const next = resizeOne(el, handle, p, keepAspect, fromCentre);
  return { x: next.x, y: next.y, w: next.w, h: next.h };
}

/** Rotate elements by `delta` radians about `centre`. */
export function rotateMany(elements: readonly CanvasElement[], centre: Vec2, delta: number): CanvasElement[] {
  return elements.map((el) => {
    const box = elementBox(el), c = boxCentre(box);
    const p = rotate(c.x - centre.x, c.y - centre.y, delta);
    const dx = centre.x + p.x - c.x, dy = centre.y + p.y - c.y;
    let angle = ((el.angle ?? 0) + delta) % (Math.PI * 2);
    if (angle < 0) angle += Math.PI * 2;
    if (Math.abs(angle) < 1e-9 || Math.abs(angle - Math.PI * 2) < 1e-9) angle = 0;
    const next: CanvasElement = { ...el, x: el.x + dx, y: el.y + dy };
    if (angle) next.angle = angle; else delete next.angle;
    return next;
  });
}

/** Snap a value to a grid. */
export const snap = (v: number, size: number): number => Math.round(v / size) * size;

/** Snap a drag vector to 15 degree steps, keeping its length. */
export function snapAngle(dx: number, dy: number): Vec2 {
  const step = Math.PI / 12, length = Math.hypot(dx, dy);
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: Math.cos(a) * length, y: Math.sin(a) * length };
}

/** The top-most frame whose box holds `p`, ignoring `skip`. */
export function frameAt(elements: readonly CanvasElement[], p: Vec2, skip?: ReadonlySet<string>): string | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.kind !== 'frame' || skip?.has(el.id)) continue;
    const box = elementBox(el), c = boxCentre(box);
    const q = rotate(p.x - c.x, p.y - c.y, -(el.angle ?? 0));
    if (Math.abs(q.x) <= box.w / 2 && Math.abs(q.y) <= box.h / 2) return el.id;
  }
}

/** Set `frame` on elements by where their centres are (CNV-38); frames never join frames. */
export function withFrames(changed: readonly CanvasElement[], all: readonly CanvasElement[], moving: ReadonlySet<string>): CanvasElement[] {
  return changed.map((el) => {
    if (el.kind === 'frame') return el;
    // A member of a frame that moves along keeps its frame.
    if (el.frame && moving.has(el.frame)) return el;
    const frame = frameAt(all, boxCentre(elementBox(el)), moving);
    if (frame === el.frame) return el;
    const next = { ...el };
    if (frame) next.frame = frame; else delete next.frame;
    return next;
  });
}

/** All elements of the outermost group of each element in `ids` (Command-click reaches inside instead). */
export function expandGroups(elements: readonly CanvasElement[], ids: Iterable<string>): string[] {
  const chosen = new Set(ids);
  const groups = new Set<string>();
  for (const el of elements) if (chosen.has(el.id) && el.groups?.length) groups.add(el.groups[el.groups.length - 1]);
  if (!groups.size) return [...chosen];
  for (const el of elements) if (el.groups?.some((g) => groups.has(g))) chosen.add(el.id);
  return elements.filter((el) => chosen.has(el.id)).map((el) => el.id);
}

/** Ops that move whole branches by (dx, dy): main nodes by position, pinned nodes by pin, others by offset. */
export function nodeMoveOps(doc: Doc, ids: readonly NodeId[], dx: number, dy: number): Op[] {
  const set = new Set(ids);
  const ops: Op[] = [];
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node) continue;
    let covered = false;
    for (let p = node.parent; p !== null && !covered; p = doc.nodes[p]?.parent ?? null) covered = set.has(p);
    if (covered) continue;
    if (node.parent === null) {
      const info = doc.rootInfo[id];
      ops.push({ t: 'setRoot', id, info: { ...info, position: { x: info.position.x + dx, y: info.position.y + dy } } });
    } else if (node.pinnedPosition) {
      ops.push({ t: 'set', id, patch: { pinnedPosition: { x: node.pinnedPosition.x + dx, y: node.pinnedPosition.y + dy } } });
    } else {
      ops.push({ t: 'set', id, patch: { offset: { x: (node.offset?.x ?? 0) + dx, y: (node.offset?.y ?? 0) + dy } } });
    }
  }
  return ops;
}

export const randomSeed = (): number => 1 + Math.floor(Math.random() * 2 ** 31 - 2);

/** A new element of `kind` with the current style. Fields the kind does not use are left out. */
export function newElement(kind: CanvasElementKind, box: Rect, style: ElementStyle): CanvasElement {
  const el: CanvasElement = { id: newId(), kind, x: box.x, y: box.y, w: box.w, h: box.h, seed: randomSeed() };
  const shape = kind === 'rect' || kind === 'ellipse' || kind === 'diamond';
  if (style.stroke && kind !== 'frame' && kind !== 'image' && kind !== 'note') el.stroke = style.stroke;
  if (shape && style.fill) {
    el.fill = style.fill;
    if (style.fillStyle) el.fillStyle = style.fillStyle;
  }
  if (style.strokeWidth && kind !== 'frame' && kind !== 'image' && kind !== 'text' && kind !== 'note') el.strokeWidth = style.strokeWidth;
  if (style.strokeStyle && style.strokeStyle !== 'solid' && (shape || isLinear(kind))) el.strokeStyle = style.strokeStyle;
  if (style.roughness !== undefined && (shape || isLinear(kind))) el.roughness = style.roughness;
  if (style.round && (kind === 'rect' || kind === 'diamond' || isLinear(kind))) el.round = true;
  if (style.opacity !== undefined && style.opacity < 1) el.opacity = style.opacity;
  if (style.font && style.font !== 'theme') el.font = style.font;
  if (style.fontSize && (kind === 'text' || kind === 'note')) el.fontSize = style.fontSize;
  return el;
}

/**
 * Give pasted elements fresh ids and keep their links among themselves: groups, frames and arrow bindings to
 * pasted elements. Bindings to elements that were not pasted are dropped; node bindings stay when the node exists.
 */
export function remapPasted(elements: readonly CanvasElement[], doc: Doc, offset: Vec2): CanvasElement[] {
  const ids = new Map(elements.map((el) => [el.id, newId()]));
  const groups = new Map<string, string>();
  const group = (g: string) => groups.get(g) ?? (groups.set(g, newId()), groups.get(g)!);
  const binding = (b: CanvasBinding | undefined): CanvasBinding | undefined => {
    if (!b) return;
    if (b.element) return ids.has(b.element) ? { ...b, element: ids.get(b.element) } : undefined;
    if (b.node) return doc.nodes[b.node] ? b : undefined;
  };
  return elements.map((el) => {
    const next: CanvasElement = { ...el, id: ids.get(el.id)!, x: el.x + offset.x, y: el.y + offset.y };
    if (el.groups) next.groups = el.groups.map(group);
    if (el.frame) { if (ids.has(el.frame)) next.frame = ids.get(el.frame); else delete next.frame; }
    for (const end of ['start', 'end'] as const) {
      const b = binding(el[end]);
      if (b) next[end] = b; else delete next[end];
    }
    delete next.locked;
    return next;
  });
}
