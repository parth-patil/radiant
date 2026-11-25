import type { CameraState, CanvasBinding, CanvasElement, CanvasState, Doc, NodeId, Op, Transaction, Vec2 } from '../types';
import { CANVAS_LIMITS, canvasElementProblems, cloneValue, limitTextBytes, simplifyPoints } from './doc';
import { newId } from './ids';

// Canvas element commands (implementation spec 7.2, CNV-10 to 12). Each returns one undoable transaction built
// from `canvas` and `canvasMeta` ops. Geometry (bounds, hit-testing, default band, tessellation) lives in core/geometry.

export { CANVAS_LIMITS, parseCanvasElement, simplifyPoints } from './doc';

export type CanvasBand = 'back' | 'front';

/** Spec 7.2: shapes, notes, frames and pictures sit under the maps; arrows, lines, pen strokes and text over them. */
export function defaultBand(kind: CanvasElement['kind']): CanvasBand {
  return kind === 'arrow' || kind === 'line' || kind === 'draw' || kind === 'text' ? 'front' : 'back';
}

export const elementBand = (el: CanvasElement): CanvasBand => el.band ?? defaultBand(el.kind);
const bandOf = elementBand;

/** Result of a canvas command: the transaction to apply and the elements the UI should select afterwards. */
export interface CanvasEdit {
  tx: Transaction;
  select?: string[];
}

type Patch = Partial<Omit<CanvasElement, 'id' | 'kind'>>;
type End = 'start' | 'end';

function edit(label: string, ops: Op[], select?: string[]): CanvasEdit | null {
  return ops.length ? { tx: { label, source: 'user', ops }, ...(select ? { select } : {}) } : null;
}

function elementsOf(doc: Doc): CanvasElement[] {
  return doc.canvas?.elements ?? [];
}

function byId(doc: Doc): Map<string, CanvasElement> {
  return new Map(elementsOf(doc).map((e) => [e.id, e]));
}

/** Ids of the elements that exist, in stacking order, without repeats. */
function existing(doc: Doc, ids: Iterable<string>): string[] {
  const want = new Set(ids);
  return elementsOf(doc).filter((e) => want.has(e.id)).map((e) => e.id);
}

function replaceOp(e: CanvasElement, index?: number): Op {
  return { t: 'canvas', id: e.id, value: e, ...(index === undefined ? {} : { index }) };
}

/** Message for adding `adding` elements past the limit (CNV-12), or null when they fit. */
export function canvasLimitError(doc: Doc, adding: number): string | null {
  const total = elementsOf(doc).length + adding;
  if (total <= CANVAS_LIMITS.elements) return null;
  const limit = CANVAS_LIMITS.elements.toLocaleString('en-US');
  return `A map can hold at most ${limit} canvas elements. Adding ${adding.toLocaleString('en-US')} would make ${total.toLocaleString('en-US')}.`;
}

/**
 * Apply the storage limits to an element: text is cut to 8,000 bytes, point lists are simplified to 4,096 points,
 * empty optional lists and undefined keys are dropped. Returns a new object.
 */
export function limitElement(element: CanvasElement): CanvasElement {
  const e = cloneValue(element);
  if (e.text !== undefined) e.text = limitTextBytes(e.text);
  if (e.points && e.points.length / 2 > CANVAS_LIMITS.points) {
    const simple = simplifyPoints(e.points, e.pressures);
    e.points = simple.points;
    if (simple.pressures) e.pressures = simple.pressures;
  }
  if (e.groups && !e.groups.length) delete e.groups;
  return e;
}

/** Apply a patch to an element; undefined values remove keys. Returns a new, limited element. */
function patched(e: CanvasElement, patch: Patch): CanvasElement {
  const next = { ...e, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(patch)) if ((patch as Record<string, unknown>)[key] === undefined) delete next[key];
  next.id = e.id;
  next.kind = e.kind;
  return limitElement(next as unknown as CanvasElement);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Throw a readable error when an element is malformed, so a bad command never reaches the document. */
function check(e: CanvasElement): CanvasElement {
  const problems = canvasElementProblems(e);
  if (problems.length) throw new Error(`Invalid canvas element: ${problems[0]}`);
  return e;
}

// ---------------------------------------------------------------- add, update, delete

/**
 * Add elements on top of the stacking order (or from `index`). Missing ids are allocated. Throws with a readable
 * message when the document would hold more than 20,000 elements (CNV-12); nothing is applied then.
 */
export function addElements(doc: Doc, elements: readonly CanvasElement[], label?: string, index?: number): CanvasEdit | null {
  if (!elements.length) return null;
  const error = canvasLimitError(doc, elements.length);
  if (error) throw new Error(error);
  const taken = new Set(elementsOf(doc).map((e) => e.id));
  const ops: Op[] = [];
  const ids: string[] = [];
  elements.forEach((element, i) => {
    const e = limitElement(element);
    if (!e.id || taken.has(e.id)) e.id = newId();
    taken.add(e.id);
    ids.push(e.id);
    ops.push(replaceOp(check(e), index === undefined ? undefined : index + i));
  });
  return edit(label ?? (elements.length > 1 ? 'Add Elements' : 'Add ' + kindLabel(elements[0].kind)), ops, ids);
}

function kindLabel(kind: CanvasElement['kind']): string {
  return ({ rect: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', line: 'Line', arrow: 'Arrow', draw: 'Drawing',
    text: 'Text', note: 'Note', frame: 'Frame', image: 'Image' } as const)[kind];
}

/** Change several elements in one transaction. Undefined values clear keys; `id` and `kind` never change. */
export function updateElements(doc: Doc, changes: ReadonlyArray<readonly [string, Patch]>, label = 'Edit Elements'): CanvasEdit | null {
  const map = byId(doc);
  const next = new Map<string, CanvasElement>();
  for (const [id, patch] of changes) {
    const e = next.get(id) ?? map.get(id);
    if (e) next.set(id, patched(e, patch));
  }
  const ops: Op[] = [];
  for (const [id, e] of next) if (!same(e, map.get(id))) ops.push(replaceOp(check(e)));
  return edit(label, ops);
}

/** Change one element. */
export function updateElement(doc: Doc, id: string, patch: Patch, label = 'Edit Element'): CanvasEdit | null {
  return updateElements(doc, [[id, patch]], label);
}

/** Apply the same patch to several elements (style bar). */
export function styleElements(doc: Doc, ids: readonly string[], patch: Patch, label = 'Style Elements'): CanvasEdit | null {
  return updateElements(doc, ids.map((id) => [id, patch] as const), label);
}

/**
 * Move elements by (dx, dy). Members of a moved frame move with it (CNV-38). Locked elements stay put.
 * Bound arrow ends are recomputed from their targets when the scene is built.
 */
export function translateElements(doc: Doc, ids: readonly string[], dx: number, dy: number, label = 'Move Elements'): CanvasEdit | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  const map = byId(doc);
  const moving = new Set(existing(doc, ids));
  const frames = new Set([...moving].filter((id) => map.get(id)?.kind === 'frame'));
  for (const e of elementsOf(doc)) if (e.frame && frames.has(e.frame)) moving.add(e.id);
  const changes: Array<[string, Patch]> = [];
  for (const e of elementsOf(doc)) if (moving.has(e.id) && !e.locked) changes.push([e.id, { x: e.x + dx, y: e.y + dy }]);
  return updateElements(doc, changes, label);
}

/**
 * Ops that clear bindings and frame references pointing at `targets` (node ids or element ids that are going away).
 * `endPoint` may return the world point where a bound end currently sits, so that it stays there unbound (CNV-36);
 * without it the end keeps its stored point.
 */
export function releaseTargets(doc: Doc, targets: ReadonlySet<string>, kind: 'node' | 'element',
    endPoint?: (element: CanvasElement, end: End) => Vec2 | undefined): Op[] {
  const ops: Op[] = [];
  for (const e of elementsOf(doc)) {
    if (kind === 'element' && targets.has(e.id)) continue;
    let next: CanvasElement | null = null;
    for (const end of ['start', 'end'] as const) {
      const b = e[end];
      if (!b || !targets.has((kind === 'node' ? b.node : b.element) ?? '')) continue;
      next = unbound(next ?? e, end, endPoint?.(e, end));
    }
    if (kind === 'element' && e.frame && targets.has(e.frame)) next = patched(next ?? e, { frame: undefined });
    if (next) ops.push(replaceOp(next));
  }
  return ops;
}

/**
 * Delete elements. Arrows bound to them keep their ends where they were, unbound; members of a deleted frame
 * leave the frame and stay on the canvas.
 */
export function deleteElements(doc: Doc, ids: readonly string[], label?: string,
    endPoint?: (element: CanvasElement, end: End) => Vec2 | undefined): CanvasEdit | null {
  const gone = existing(doc, ids);
  if (!gone.length) return null;
  const set = new Set(gone);
  const ops: Op[] = [...releaseTargets(doc, set, 'element', endPoint)];
  for (const id of gone) ops.push({ t: 'canvas', id });
  return edit(label ?? (gone.length > 1 ? 'Delete Elements' : 'Delete Element'), ops, []);
}

// ---------------------------------------------------------------- stacking and bands

/** Ops that turn the current element order into `target` (same ids), moving as few elements as practical. */
function orderOps(current: readonly CanvasElement[], target: readonly CanvasElement[]): Op[] {
  const plan = (fromEnd: boolean): Op[] => {
    const work = current.slice();
    const ops: Op[] = [];
    const n = work.length;
    for (let step = 0; step < n; step++) {
      const i = fromEnd ? n - 1 - step : step;
      if (work[i].id === target[i].id) continue;
      const from = work.findIndex((e) => e.id === target[i].id);
      const [e] = work.splice(from, 1);
      work.splice(i, 0, e);
      ops.push(replaceOp(e, i));
    }
    return ops;
  };
  const a = plan(false);
  const b = plan(true);
  return b.length < a.length ? b : a;
}

/**
 * Change stacking order within each element's band: `front` and `back` move to the top or bottom, `forward` and
 * `backward` move one step past the next element of the same band (Command+] and Command+[).
 */
export function reorderElements(doc: Doc, ids: readonly string[], to: 'front' | 'back' | 'forward' | 'backward'): CanvasEdit | null {
  const list = elementsOf(doc);
  const chosen = new Set(existing(doc, ids));
  if (!chosen.size) return null;
  let target = list.slice();
  if (to === 'front') target = [...list.filter((e) => !chosen.has(e.id)), ...list.filter((e) => chosen.has(e.id))];
  else if (to === 'back') target = [...list.filter((e) => chosen.has(e.id)), ...list.filter((e) => !chosen.has(e.id))];
  else {
    const up = to === 'forward';
    const order = up ? [...target.keys()].reverse() : [...target.keys()];
    for (const start of order) {
      const e = target[start];
      if (!chosen.has(e.id)) continue;
      // Swap past the nearest unselected element of the same band in the direction of travel.
      let j = start + (up ? 1 : -1);
      while (j >= 0 && j < target.length && bandOf(target[j]) !== bandOf(e)) j += up ? 1 : -1;
      if (j < 0 || j >= target.length || chosen.has(target[j].id)) continue;
      target.splice(start, 1);
      target.splice(j, 0, e);
    }
  }
  const label = { front: 'Bring to Front', back: 'Send to Back', forward: 'Bring Forward', backward: 'Send Backward' }[to];
  return edit(label, orderOps(list, target), [...chosen]);
}

/** Move elements to the band under or over the maps, on top of that band. */
export function setBand(doc: Doc, ids: readonly string[], band: 'back' | 'front'): CanvasEdit | null {
  const list = elementsOf(doc);
  const chosen = new Set(existing(doc, ids).filter((id) => bandOf(byId(doc).get(id)!) !== band));
  if (!chosen.size) return null;
  // Moving each chosen element to the end in turn leaves them on top, in their previous order.
  const ops = list.filter((e) => chosen.has(e.id)).map((e) => replaceOp(patched(e, { band }), list.length - 1));
  return edit(band === 'back' ? 'Move Under Maps' : 'Move Over Maps', ops, [...chosen]);
}

// ---------------------------------------------------------------- groups, lock, duplicate

/** Group elements (Option+Command+G). The new group is the outermost group of each member. */
export function groupElements(doc: Doc, ids: readonly string[], groupId: string = newId()): CanvasEdit | null {
  const members = existing(doc, ids);
  if (members.length < 2) return null;
  const map = byId(doc);
  return edit('Group', members.map((id) => {
    const e = map.get(id)!;
    return replaceOp(check(patched(e, { groups: [...(e.groups ?? []), groupId] })));
  }), members);
}

/** Ungroup (Shift+Option+Command+G): remove the outermost group of each selected element from all its members. */
export function ungroupElements(doc: Doc, ids: readonly string[]): CanvasEdit | null {
  const map = byId(doc);
  const groups = new Set(existing(doc, ids).flatMap((id) => map.get(id)!.groups?.slice(-1) ?? []));
  if (!groups.size) return null;
  const ops: Op[] = [];
  const select: string[] = [];
  for (const e of elementsOf(doc)) {
    if (!e.groups?.some((g) => groups.has(g))) continue;
    const rest = e.groups.filter((g) => !groups.has(g));
    ops.push(replaceOp(patched(e, { groups: rest.length ? rest : undefined })));
    select.push(e.id);
  }
  return edit('Ungroup', ops, select);
}

/** Lock or unlock elements. Locked elements are skipped by the marquee and never move. */
export function lockElements(doc: Doc, ids: readonly string[], locked = true): CanvasEdit | null {
  const map = byId(doc);
  const ops = existing(doc, ids).filter((id) => !!map.get(id)!.locked !== locked)
    .map((id) => replaceOp(patched(map.get(id)!, { locked: locked || undefined })));
  return edit(locked ? 'Lock' : 'Unlock', ops);
}

/**
 * Duplicate elements (Command+D), offset by `offset`, on top of the stacking order. Groups and frames that are
 * copied whole get new ids; a binding survives only when its target element is copied too, or is a node.
 */
export function duplicateElements(doc: Doc, ids: readonly string[], offset: Vec2 = { x: 10, y: 10 }): CanvasEdit | null {
  const map = byId(doc);
  const chosen = existing(doc, ids);
  const frames = new Set(chosen.filter((id) => map.get(id)!.kind === 'frame'));
  for (const e of elementsOf(doc)) if (e.frame && frames.has(e.frame) && !chosen.includes(e.id)) chosen.push(e.id);
  const copies = elementsOf(doc).filter((e) => chosen.includes(e.id));
  if (!copies.length) return null;
  const error = canvasLimitError(doc, copies.length);
  if (error) throw new Error(error);
  const ids2 = new Map(copies.map((e) => [e.id, newId()]));
  const groups = new Map<string, string>();
  const ops: Op[] = [];
  for (const e of copies) {
    const copy = cloneValue(e);
    copy.id = ids2.get(e.id)!;
    copy.x += offset.x;
    copy.y += offset.y;
    if (copy.groups) {
      // A group copied whole becomes a new group; a copy of part of a group joins the original group.
      copy.groups = copy.groups.map((g) => {
        if (!elementsOf(doc).every((x) => !x.groups?.includes(g) || ids2.has(x.id))) return g;
        if (!groups.has(g)) groups.set(g, newId());
        return groups.get(g)!;
      });
    }
    if (copy.frame && ids2.has(copy.frame)) copy.frame = ids2.get(copy.frame);
    for (const end of ['start', 'end'] as const) {
      const b = copy[end];
      if (!b?.element) continue;
      if (ids2.has(b.element)) copy[end] = { ...b, element: ids2.get(b.element) };
      else delete copy[end];
    }
    delete copy.locked;
    ops.push(replaceOp(check(copy)));
  }
  return edit('Duplicate', ops, [...ids2.values()]);
}

// ---------------------------------------------------------------- arrow bindings

function endIndex(e: CanvasElement, end: End): number {
  return end === 'start' ? 0 : Math.max(0, (e.points?.length ?? 2) - 2);
}

/** Recompute w and h from the point list, as Excalidraw does for linear elements. */
function withExtent(e: CanvasElement): CanvasElement {
  const p = e.points;
  if (!p || p.length < 2) return e;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
  }
  return { ...e, w: maxX - minX, h: maxY - minY };
}

/** The element with one end unbound, its stored point moved to `at` (world coordinates) when given. */
function unbound(e: CanvasElement, end: End, at?: Vec2): CanvasElement {
  let next = patched(e, { [end]: undefined } as Patch);
  if (at && next.points && Number.isFinite(at.x) && Number.isFinite(at.y)) {
    const points = next.points.slice();
    const i = endIndex(next, end);
    points[i] = at.x - next.x;
    points[i + 1] = at.y - next.y;
    next = withExtent({ ...next, points });
  }
  return next;
}

/** Bind one end of an arrow or line to a node or another element (CNV-36). */
export function bindArrowEnd(doc: Doc, id: string, end: End, binding: CanvasBinding): CanvasEdit | null {
  const e = byId(doc).get(id);
  if (!e || (e.kind !== 'arrow' && e.kind !== 'line')) return null;
  if (!!binding.node === !!binding.element || binding.element === id) return null;
  if (binding.node ? !doc.nodes[binding.node] : !byId(doc).has(binding.element!)) return null;
  const next = patched(e, { [end]: cloneValue(binding) } as Patch);
  return same(next, e) ? null : edit('Bind Arrow', [replaceOp(check(next))], [id]);
}

/** Unbind one end of an arrow; with `at`, the end stays at that world point. */
export function unbindArrowEnd(doc: Doc, id: string, end: End, at?: Vec2): CanvasEdit | null {
  const e = byId(doc).get(id);
  if (!e?.[end]) return null;
  return edit('Unbind Arrow', [replaceOp(unbound(e, end, at))], [id]);
}

// ---------------------------------------------------------------- canvas settings: grid and bookmarks

/** Set or clear the grid (CNV-07). */
export function setGrid(doc: Doc, grid: CanvasState['grid']): Transaction | null {
  if (same(grid, doc.canvas?.grid)) return null;
  return { label: 'Change Grid', source: 'user', ops: [{ t: 'canvasMeta', patch: { grid: grid && { ...grid } } }] };
}

function bookmarksTx(doc: Doc, label: string, next: NonNullable<CanvasState['bookmarks']>): Transaction | null {
  if (same(next, doc.canvas?.bookmarks ?? [])) return null;
  return { label, source: 'user', ops: [{ t: 'canvasMeta', patch: { bookmarks: next.length ? next : undefined } }] };
}

/** Save a named view (CNV-05). */
export function addBookmark(doc: Doc, name: string, view: CameraState, id: string = newId()): Transaction | null {
  const list = cloneValue(doc.canvas?.bookmarks ?? []);
  if (list.some((b) => b.id === id)) return null;
  return bookmarksTx(doc, 'Add Bookmark', [...list, { id, name: name.trim() || 'View', view: { ...view } }]);
}

export function renameBookmark(doc: Doc, id: string, name: string): Transaction | null {
  const clean = name.trim();
  if (!clean) return null;
  return bookmarksTx(doc, 'Rename Bookmark', cloneValue(doc.canvas?.bookmarks ?? []).map((b) => (b.id === id ? { ...b, name: clean } : b)));
}

export function deleteBookmark(doc: Doc, id: string): Transaction | null {
  return bookmarksTx(doc, 'Delete Bookmark', cloneValue(doc.canvas?.bookmarks ?? []).filter((b) => b.id !== id));
}

/** Move a bookmark to `index` (Control+1 to 9 follow the list order). */
export function moveBookmark(doc: Doc, id: string, index: number): Transaction | null {
  const list = cloneValue(doc.canvas?.bookmarks ?? []);
  const from = list.findIndex((b) => b.id === id);
  if (from < 0) return null;
  const [b] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(list.length, index)), 0, b);
  return bookmarksTx(doc, 'Reorder Bookmarks', list);
}

/** Node ids bound by canvas elements, for callers that delete nodes. */
export function boundNodes(doc: Doc): Set<NodeId> {
  const out = new Set<NodeId>();
  for (const e of elementsOf(doc)) for (const b of [e.start, e.end]) if (b?.node) out.add(b.node);
  return out;
}
