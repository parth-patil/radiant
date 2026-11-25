import { aliasPeers, SHARED_ALIAS_FIELDS } from './aliases';
import type { CanvasState, Doc, MapNode, NodeId, Op, RootInfo } from '../types';
import {
  CANVAS_LIMITS, canvasElementProblems, cloneNode, cloneValue, emptyCanvas, parseCanvasBookmarks, parseCanvasGrid,
  presentationProblems
} from './doc';
import { parseAiJobRecord, validAiJobId } from './ai-provenance';

/** Accumulates what a series of ops changed. Pass the same object to several {@link applyOp} calls. */
export interface ChangeTrack {
  /** Ids whose structure, text or size-affecting style changed (including parents of inserted/removed/moved nodes). */
  touched: Set<NodeId>;
  /** Stays true while every op applied so far only changed note, tags, task, link or origin (or cross-links / title). */
  cosmeticOnly: boolean;
}

/** Create an empty {@link ChangeTrack}. */
export function newTrack(): ChangeTrack {
  return { touched: new Set(), cosmeticOnly: true };
}

/** Node fields that never affect geometry. */
const COSMETIC_KEYS = new Set<string>(['note', 'tags', 'task', 'link', 'origin', 'lastAiJob', 'generatedDraft']);

type SetPatch = Extract<Op, { t: 'set' }>['patch'];

/**
 * Apply one op to the document in place and return its exact inverse.
 *
 * Applying the inverse restores the previous state, including node fields, sibling index, root z-order and
 * keys that were absent (a `set` inverse carries `undefined` for them, meaning "delete the key").
 * Throws on an invalid op (unknown id, cycle, removing a node that has children); the document is unchanged then.
 *
 * @param track optional accumulator for touched ids and the cosmetic-only flag.
 */
export function applyOp(doc: Doc, op: Op, track?: ChangeTrack): Op {
  switch (op.t) {
    case 'insert':
      return applyInsert(doc, op, track);
    case 'remove':
      return applyRemove(doc, op, track);
    case 'move':
      return applyMove(doc, op, track);
    case 'set':
      return applySet(doc, op, track);
    case 'setRoot': {
      const prev = mustRoot(doc, op.id);
      doc.rootInfo[op.id] = cloneInfo(op.info);
      mark(track, op.id, false);
      return { t: 'setRoot', id: op.id, info: prev };
    }
    case 'link': {
      if (doc.links.some((l) => l.id === op.link.id)) throw new Error(`link ${op.link.id} exists`);
      if (!doc.nodes[op.link.from] || !doc.nodes[op.link.to]) throw new Error('link endpoint missing');
      doc.links.splice(op.index ?? doc.links.length, 0, { ...op.link });
      mark(track, op.link.from, true);
      mark(track, op.link.to, true);
      return { t: 'unlink', id: op.link.id };
    }
    case 'unlink': {
      const i = doc.links.findIndex((l) => l.id === op.id);
      if (i < 0) throw new Error(`link ${op.id} not found`);
      const [l] = doc.links.splice(i, 1);
      mark(track, l.from, true);
      mark(track, l.to, true);
      return { t: 'link', link: l, index: i };
    }
    case 'linkStyle': {
      const link = doc.links.find(l => l.id === op.id);
      if (!link) throw new Error(`link ${op.id} not found`);
      const {id,from,to,label,...previous} = link;
      for (const key of ['bend','color','arrows','dash'] as const) delete link[key];
      Object.assign(link,cloneValue(op.style));
      mark(track,from,true);mark(track,to,true);
      return {t:'linkStyle',id,style:previous};
    }
    case 'setLink': {
      const l = doc.links.find((x) => x.id === op.id);
      if (!l) throw new Error(`link ${op.id} not found`);
      const prev = l.label;
      if (op.label === undefined) delete l.label;
      else l.label = op.label;
      mark(track, l.from, true);
      mark(track, l.to, true);
      return { t: 'setLink', id: op.id, label: prev };
    }
    case 'aiJob': {
      if (!validAiJobId(op.id)) throw new Error('Invalid AI job ID');
      const value = op.value === undefined ? undefined : parseAiJobRecord(op.value);
      if (op.value !== undefined && !value) throw new Error('Invalid AI job record');
      const previous = Object.hasOwn(doc.aiJobs ?? {}, op.id) ? doc.aiJobs?.[op.id] : undefined;
      if (value) {
        doc.aiJobs ??= Object.create(null);
        doc.aiJobs![op.id] = value;
      } else if (doc.aiJobs && previous) {
        delete doc.aiJobs[op.id];
        if (Object.keys(doc.aiJobs).length === 0) delete doc.aiJobs;
      }
      return { t: 'aiJob', id: op.id, value: previous };
    }
    case 'docMeta': {
      const inv: Extract<Op, { t: 'docMeta' }>['patch'] = {};
      const p = op.patch;
      let geometric = false;
      if ('title' in p && p.title !== undefined) {
        inv.title = doc.title;
        doc.title = p.title;
      }
      if ('themeId' in p && p.themeId !== undefined) {
        inv.themeId = doc.themeId;
        doc.themeId = p.themeId;
        geometric = true;
      }
      if ('tagColors' in p) {
        inv.tagColors=doc.tagColors;
        if (p.tagColors) doc.tagColors={...p.tagColors};
        else delete doc.tagColors;
      }
      if ('markerMeanings' in p) {
        inv.markerMeanings = doc.markerMeanings;
        if (p.markerMeanings) doc.markerMeanings = { ...p.markerMeanings };
        else delete doc.markerMeanings;
      }
      if ('themeSettings' in p) {
        inv.themeSettings = doc.themeSettings;
        if (p.themeSettings) doc.themeSettings = cloneValue(p.themeSettings);
        else delete doc.themeSettings;
        geometric = true;
      }
      if ('artStyleId' in p) {
        inv.artStyleId = doc.artStyleId;
        if (p.artStyleId === undefined) delete doc.artStyleId;
        else doc.artStyleId = p.artStyleId;
      }
      if ('layoutPlacements' in p) {
        inv.layoutPlacements = doc.layoutPlacements;
        if (p.layoutPlacements) doc.layoutPlacements = cloneValue(p.layoutPlacements);
        else delete doc.layoutPlacements;
        geometric = true;
      }
      if ('seed' in p && p.seed !== undefined) {
        inv.seed = doc.seed;
        doc.seed = p.seed;
        geometric = true;
      }
      if (geometric && track) for (const r of doc.roots) mark(track, r, false);
      return { t: 'docMeta', patch: inv };
    }
    case 'presentation':
      return applyPresentation(doc, op);
    case 'canvas':
      return applyCanvas(doc, op);
    case 'canvasMeta':
      return applyCanvasMeta(doc, op);
  }
}

/** Apply several ops in order; returns their inverses already reversed, ready to apply for an undo. */
export function applyOps(doc: Doc, ops: readonly Op[], track?: ChangeTrack): Op[] {
  const inv: Op[] = [];
  try {
    for (const op of ops) inv.push(applyOp(doc, op, track));
  } catch (e) {
    for (let i = inv.length - 1; i >= 0; i--) applyOp(doc, inv[i]);
    throw e;
  }
  return inv.reverse();
}

// ------------------------------------------------------------------ internals

function mark(track: ChangeTrack | undefined, id: NodeId | null, cosmetic: boolean): void {
  if (!track || id === null) return;
  track.touched.add(id);
  if (!cosmetic) track.cosmeticOnly = false;
}

function cloneInfo(i: RootInfo): RootInfo {
  return { ...i, position: { ...i.position } };
}

function mustNode(doc: Doc, id: NodeId): MapNode {
  const n = doc.nodes[id];
  if (!n) throw new Error(`node ${id} not found`);
  return n;
}

function mustRoot(doc: Doc, id: NodeId): RootInfo {
  const r = doc.rootInfo[id];
  if (!r) throw new Error(`node ${id} is not a root`);
  return r;
}

function clampIndex(i: number, len: number): number {
  return i < 0 ? 0 : i > len ? len : i;
}

/**
 * Keep `presentations` and `canvas` as the last keys of the document, in that order, as {@link parseDocReport}
 * writes them. Called after either field is created so that undo restores the serialised document exactly.
 */
function placeTail(doc: Doc): void {
  for (const key of ['presentations', 'canvas'] as const) {
    const value = doc[key];
    if (value === undefined) continue;
    delete doc[key];
    Object.assign(doc, { [key]: value });
  }
}

/**
 * Insert, replace or delete one entry of an id-keyed list. A present `value` replaces the entry with the same id
 * (moving it to `index` when given) or inserts it at `index` (default: the end). Returns the previous entry and
 * its index, which together form the inverse.
 */
function upsert<T extends { id: string }>(list: T[], id: string, value: T | undefined, index: number | undefined):
    { previous?: T; at?: number } {
  const at = list.findIndex((item) => item.id === id);
  const previous = at >= 0 ? list[at] : undefined;
  if (at >= 0) list.splice(at, 1);
  if (value) list.splice(clampIndex(index ?? (at >= 0 ? at : list.length), list.length), 0, value);
  return previous ? { previous, at } : {};
}

function applyPresentation(doc: Doc, op: Extract<Op, { t: 'presentation' }>): Op {
  if (typeof op.id !== 'string' || !op.id) throw new Error('Invalid presentation ID');
  let value = op.value;
  if (value !== undefined) {
    if (value.id !== op.id) throw new Error('Presentation ID does not match its op');
    const problems = presentationProblems(value);
    if (problems.length) throw new Error(`Invalid presentation: ${problems[0]}`);
    value = cloneValue(value);
  }
  const created = !doc.presentations;
  const list = doc.presentations ?? [];
  const { previous, at } = upsert(list, op.id, value, op.index);
  if (list.length === 0) delete doc.presentations;
  else if (created) {
    doc.presentations = list;
    placeTail(doc);
  }
  return previous ? { t: 'presentation', id: op.id, value: previous, index: at } : { t: 'presentation', id: op.id };
}

function applyCanvas(doc: Doc, op: Extract<Op, { t: 'canvas' }>): Op {
  if (typeof op.id !== 'string' || !op.id) throw new Error('Invalid canvas element ID');
  let value = op.value;
  if (value !== undefined) {
    if (value.id !== op.id) throw new Error('Canvas element ID does not match its op');
    const problems = canvasElementProblems(value);
    if (problems.length) throw new Error(`Invalid canvas element: ${problems[0]}`);
    value = cloneValue(value);
  }
  const canvas = doc.canvas ?? { elements: [] };
  if (value && canvas.elements.length >= CANVAS_LIMITS.elements && !canvas.elements.some((e) => e.id === op.id)) {
    throw new Error(`A map can hold at most ${CANVAS_LIMITS.elements.toLocaleString('en-US')} canvas elements.`);
  }
  const { previous, at } = upsert(canvas.elements, op.id, value, op.index);
  setCanvas(doc, canvas);
  return previous ? { t: 'canvas', id: op.id, value: previous, index: at } : { t: 'canvas', id: op.id };
}

function applyCanvasMeta(doc: Doc, op: Extract<Op, { t: 'canvasMeta' }>): Op {
  const p = op.patch;
  const invalid = () => { throw new Error('Invalid canvas settings'); };
  if ('bookmarks' in p && p.bookmarks !== undefined) {
    let bad = false;
    const parsed = parseCanvasBookmarks(p.bookmarks, () => { bad = true; });
    if (bad || !parsed?.length) invalid();
  }
  if ('grid' in p && p.grid !== undefined && !parseCanvasGrid(p.grid)) invalid();
  const current = doc.canvas ?? { elements: [] };
  const inv: Extract<Op, { t: 'canvasMeta' }>['patch'] = {};
  // Rebuild in the canonical key order (elements, bookmarks, grid) so undo restores the exact serialisation.
  const next: CanvasState = { elements: current.elements };
  const bookmarks = 'bookmarks' in p ? p.bookmarks && cloneValue(p.bookmarks) : current.bookmarks;
  const grid = 'grid' in p ? p.grid && { ...p.grid } : current.grid;
  if ('bookmarks' in p) inv.bookmarks = current.bookmarks;
  if ('grid' in p) inv.grid = current.grid;
  if (bookmarks) next.bookmarks = bookmarks;
  if (grid) next.grid = grid;
  setCanvas(doc, next);
  return { t: 'canvasMeta', patch: inv };
}

/** Store the canvas, or drop the field when it holds nothing (the form {@link parseDocReport} reads). */
function setCanvas(doc: Doc, canvas: CanvasState): void {
  if (emptyCanvas(canvas)) {
    delete doc.canvas;
    return;
  }
  const created = !doc.canvas;
  doc.canvas = canvas;
  if (created) placeTail(doc);
}

function applyInsert(doc: Doc, op: Extract<Op, { t: 'insert' }>, track?: ChangeTrack): Op {
  const id = op.node.id;
  if (doc.nodes[id]) throw new Error(`node ${id} already exists`);
  const node = cloneNode(op.node);
  node.children = [];
  node.parent = op.parent;
  if (op.parent === null) {
    const index = clampIndex(op.index, doc.roots.length);
    doc.nodes[id] = node;
    doc.roots.splice(index, 0, id);
    doc.rootInfo[id] = op.rootInfo ? cloneInfo(op.rootInfo) : { position: { x: 0, y: 0 }, layout: 'mindmap' };
  } else {
    const parent = mustNode(doc, op.parent);
    doc.nodes[id] = node;
    parent.children.splice(clampIndex(op.index, parent.children.length), 0, id);
  }
  mark(track, id, false);
  mark(track, op.parent, false);
  return { t: 'remove', id };
}

function applyRemove(doc: Doc, op: Extract<Op, { t: 'remove' }>, track?: ChangeTrack): Op {
  const node = mustNode(doc, op.id);
  if (node.children.length) throw new Error(`node ${op.id} has children; remove subtrees bottom-up`);
  const snapshot = cloneNode(node);
  let inv: Op;
  if (node.parent === null) {
    const index = doc.roots.indexOf(op.id);
    doc.roots.splice(index, 1);
    inv = { t: 'insert', node: snapshot, parent: null, index, rootInfo: doc.rootInfo[op.id] };
    delete doc.rootInfo[op.id];
  } else {
    const parent = mustNode(doc, node.parent);
    const index = parent.children.indexOf(op.id);
    parent.children.splice(index, 1);
    inv = { t: 'insert', node: snapshot, parent: node.parent, index };
  }
  delete doc.nodes[op.id];
  mark(track, op.id, false);
  mark(track, node.parent, false);
  return inv;
}

function applyMove(doc: Doc, op: Extract<Op, { t: 'move' }>, track?: ChangeTrack): Op {
  const node = mustNode(doc, op.id);
  if (op.parent !== null) {
    mustNode(doc, op.parent);
    // Cycle check: walk up from the target parent; O(depth).
    for (let a: NodeId | null = op.parent; a !== null; a = doc.nodes[a].parent) {
      if (a === op.id) throw new Error('cannot move a node into its own subtree');
    }
  }
  const oldParent = node.parent;
  let oldIndex: number;
  let oldInfo: RootInfo | undefined;
  if (oldParent === null) {
    oldIndex = doc.roots.indexOf(op.id);
    doc.roots.splice(oldIndex, 1);
    oldInfo = doc.rootInfo[op.id];
    delete doc.rootInfo[op.id];
  } else {
    const siblings = doc.nodes[oldParent].children;
    oldIndex = siblings.indexOf(op.id);
    siblings.splice(oldIndex, 1);
  }
  if (op.parent === null) {
    doc.roots.splice(clampIndex(op.index, doc.roots.length), 0, op.id);
    doc.rootInfo[op.id] = op.rootInfo
      ? cloneInfo(op.rootInfo)
      : (oldInfo ?? { position: { x: 0, y: 0 }, layout: 'mindmap' });
  } else {
    const kids = doc.nodes[op.parent].children;
    kids.splice(clampIndex(op.index, kids.length), 0, op.id);
  }
  node.parent = op.parent;
  mark(track, op.id, false);
  mark(track, oldParent, false);
  mark(track, op.parent, false);
  const inv: Extract<Op, { t: 'move' }> = { t: 'move', id: op.id, parent: oldParent, index: oldIndex };
  if (oldInfo) inv.rootInfo = oldInfo;
  return inv;
}

function applySet(doc: Doc, op: Extract<Op, { t: 'set' }>, track?: ChangeTrack): Op {
  const node = mustNode(doc, op.id);
  const target = node as unknown as Record<string, unknown>;
  const inverse: Record<string, unknown> = {};
  let cosmetic = true;
  const sharesContent = node.aliasGroup && SHARED_ALIAS_FIELDS.some((key) => Object.hasOwn(op.patch, key));
  const peers = sharesContent ? aliasPeers(doc, node) : [];
  for (const key of Object.keys(op.patch)) {
    if (key === 'id' || key === 'parent' || key === 'children') throw new Error(`cannot set ${key}`);
    const value = (op.patch as Record<string, unknown>)[key];
    inverse[key] = target[key];
    if (value === undefined) delete target[key];
    else target[key] = cloneValue(value);
    if (!COSMETIC_KEYS.has(key)) cosmetic = false;
  }
  for (const key of SHARED_ALIAS_FIELDS) {
    if (!Object.hasOwn(op.patch, key)) continue;
    for (const peer of peers) {
      if (target[key] === undefined) delete (peer as unknown as Record<string, unknown>)[key];
      else Object.assign(peer, { [key]: cloneValue(target[key]) });
      mark(track, peer.id, COSMETIC_KEYS.has(key));
    }
  }
  mark(track, op.id, cosmetic);
  return { t: 'set', id: op.id, patch: inverse as SetPatch };
}
