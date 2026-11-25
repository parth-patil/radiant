import { parseSubtreeArtStyle, withSubtreeArtStyles } from '../art/subtree-style';
import { COLLECTION_LAYOUTS } from '../layout/collections';
import { SHARED_ALIAS_FIELDS, validAliasGroup } from './aliases';
import { parseInkSketch } from '../geometry/ink';
import { parseAiJobs, validAiJobId } from './ai-provenance';
import {parseGeneratedStyle} from './generated-style';
import {parseThemeSettings} from './theme-settings';
import type {
  CameraState, CanvasBinding, CanvasElement, CanvasElementKind, CanvasState, CrossLink, Doc, LayoutKind, LayoutPlacements,
  MapNode, NodeId, Presentation, PresentationStep, RootInfo
} from '../types';
import { newId } from './ids';
import { DEFAULT_THEME_ID } from './themes';

const TREE_LAYOUTS: readonly LayoutKind[] = ['mindmap', 'right', 'left', 'down', 'radial', 'outline', 'up', 'compact'];
const ROOT_LAYOUTS: readonly LayoutKind[] = [...TREE_LAYOUTS, ...COLLECTION_LAYOUTS];

/** Deep-copy a JSON-like value (objects, arrays, primitives). Used for node fields such as style and tags. */
export function cloneValue<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneValue) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (k === '__proto__') continue;
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = cloneValue(x);
  }
  return out as T;
}

/** Deep-copy one node (children array included). */
export function cloneNode(n: MapNode): MapNode {
  const out: MapNode = { ...n, children: n.children.slice() };
  for (const key of ['pictureArt', 'svgArt', 'artReference'] as const) {
    if (n[key]) out[key] = cloneValue(n[key]);
  }
  if(n.generatedStyle)out.generatedStyle=cloneValue(n.generatedStyle);
  if (n.artStyleSheet) out.artStyleSheet = cloneValue(n.artStyleSheet);
  if (n.artStyleOverrides) out.artStyleOverrides = cloneValue(n.artStyleOverrides);
  if (n.interchange) out.interchange = cloneValue(n.interchange);
  if (n.sketch) out.sketch = cloneValue(n.sketch);
  if (n.offset) out.offset = { ...n.offset };
  if (n.pinnedPosition) out.pinnedPosition = { ...n.pinnedPosition };
  if (n.style) out.style = { ...n.style };
  if (n.tags) out.tags = n.tags.slice();
  if (n.task) out.task = { ...n.task };
  if (n.origin) out.origin = { ...n.origin };
  return out;
}

/** Create a new document with a single root node. */
export function createDoc(title?: string): Doc {
  const rootId = newId();
  const now = new Date().toISOString();
  const text = title && title.trim() ? title : 'Central topic';
  return {
    version: 1,
    id: newId(),
    title: text,
    roots: [rootId],
    rootInfo: { [rootId]: { position: { x: 0, y: 0 }, layout: 'mindmap' } },
    nodes: { [rootId]: { id: rootId, parent: null, children: [], text, origin: { by: 'user' } } },
    links: [],
    themeId: DEFAULT_THEME_ID,
    seed: (Math.random() * 0x7fffffff) | 0,
    created: now,
    modified: now
  };
}

/** Deep copy of a document; the copy shares no mutable state with the original. */
export function cloneDoc(doc: Doc): Doc {
  const nodes: Record<NodeId, MapNode> = Object.create(null);
  for (const id in doc.nodes) nodes[id] = cloneNode(doc.nodes[id]);
  const rootInfo: Record<NodeId, RootInfo> = Object.create(null);
  for (const id in doc.rootInfo) {
    const r = doc.rootInfo[id];
    rootInfo[id] = { ...r, position: { ...r.position } };
  }
  return { ...doc, aiJobs: doc.aiJobs && cloneValue(doc.aiJobs), tagColors:doc.tagColors ? {...doc.tagColors} : undefined, markerMeanings: cloneValue(doc.markerMeanings), layoutPlacements: cloneValue(doc.layoutPlacements), themeSettings:parseThemeSettings(doc.themeSettings), roots: doc.roots.slice(), rootInfo, nodes, links: doc.links.map(cloneValue),
    presentations: doc.presentations && cloneValue(doc.presentations), canvas: doc.canvas && cloneValue(doc.canvas) };
}

/**
 * Check the structural invariants of a document. Returns a list of human-readable problems; empty means valid.
 * Linear in the number of nodes.
 */
export function validateDoc(doc: Doc): string[] {
  const errs: string[] = [];
  if (doc.version !== 1) errs.push(`unsupported version ${String(doc.version)}`);
  const rootSet = new Set<NodeId>();
  for (const r of doc.roots) {
    if (rootSet.has(r)) errs.push(`duplicate root ${r}`);
    rootSet.add(r);
    const n = doc.nodes[r];
    if (!n) errs.push(`root ${r} does not exist`);
    else if (n.parent !== null) errs.push(`root ${r} has parent ${n.parent}`);
    if (!doc.rootInfo[r]) errs.push(`root ${r} has no rootInfo`);
  }
  for (const r in doc.rootInfo) if (!rootSet.has(r)) errs.push(`rootInfo for non-root ${r}`);

  for (const id in doc.nodes) {
    const n = doc.nodes[id];
    if (n.id !== id) errs.push(`node key ${id} has id ${n.id}`);
    if (n.parent === null) {
      if (!rootSet.has(id)) errs.push(`node ${id} has no parent but is not in roots`);
    } else {
      const p = doc.nodes[n.parent];
      if (!p) errs.push(`node ${id} has missing parent ${n.parent}`);
      else if (p.children.indexOf(id) < 0) errs.push(`node ${id} is not in the children of its parent ${n.parent}`);
    }
    const seen = new Set<NodeId>();
    for (const c of n.children) {
      if (seen.has(c)) errs.push(`node ${id} lists child ${c} twice`);
      seen.add(c);
      const cn = doc.nodes[c];
      if (!cn) errs.push(`node ${id} has missing child ${c}`);
      else if (cn.parent !== id) errs.push(`child ${c} of ${id} has parent ${String(cn.parent)}`);
    }
  }

  // Reachability from roots (detects cycles and orphans).
  const visited = new Set<NodeId>();
  const stack: NodeId[] = [];
  for (const r of doc.roots) if (doc.nodes[r]) stack.push(r);
  while (stack.length) {
    const id = stack.pop() as NodeId;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const c of doc.nodes[id].children) if (doc.nodes[c] && !visited.has(c)) stack.push(c);
  }
  let unreachable = 0;
  for (const id in doc.nodes) if (!visited.has(id)) unreachable++;
  if (unreachable) errs.push(`${unreachable} node(s) unreachable from roots (cycle or orphan)`);

  const linkIds = new Set<string>();
  for (const l of doc.links) {
    if (linkIds.has(l.id)) errs.push(`duplicate link id ${l.id}`);
    linkIds.add(l.id);
    if (!doc.nodes[l.from] || !doc.nodes[l.to]) errs.push(`link ${l.id} references a missing node`);
  }

  const presentationIds = new Set<string>();
  for (const p of doc.presentations ?? []) {
    if (presentationIds.has(p.id)) errs.push(`duplicate presentation id ${p.id}`);
    presentationIds.add(p.id);
    const stepIds = new Set<string>();
    for (const s of p.steps) {
      if (stepIds.has(s.id)) errs.push(`presentation ${p.id} has duplicate step id ${s.id}`);
      stepIds.add(s.id);
    }
  }
  const elements = doc.canvas?.elements ?? [];
  if (elements.length > CANVAS_LIMITS.elements) errs.push(`${elements.length} canvas elements exceed the limit of ${CANVAS_LIMITS.elements}`);
  const elementIds = new Set<string>();
  for (const e of elements) {
    if (elementIds.has(e.id)) errs.push(`duplicate canvas element id ${e.id}`);
    elementIds.add(e.id);
  }
  return errs;
}

/** Serialise a document to compact JSON. */
export function serializeDoc(doc: Doc): string {
  return JSON.stringify(withSubtreeArtStyles(doc));
}

/**
 * Parse and repair a document from JSON. Throws if the text is not JSON, is not a document object,
 * or has a version newer than this build understands. Repairable damage (dangling references, orphans,
 * missing fields) is fixed silently; use {@link parseDocReport} to see what was repaired.
 */
export function parseDoc(json: string): Doc {
  return parseDocReport(json).doc;
}

/** Like {@link parseDoc} but also returns a description of every repair made. */
export function parseDocReport(json: string): { doc: Doc; repairs: string[] } {
  const raw: unknown = JSON.parse(json);
  if (!isObj(raw)) throw new Error('Not a Radiant document');
  const version = raw.version;
  if (typeof version !== 'number') throw new Error('Missing document version');
  if (version > 1) throw new Error(`Document version ${version} is newer than this app supports`);
  if (version < 1) throw new Error(`Unsupported document version ${version}`);

  const repairs: string[] = [];
  const fix = (m: string) => {
    if (repairs.length < 200) repairs.push(m);
  };
  const now = new Date().toISOString();

  // --- nodes
  const nodes: Record<NodeId, MapNode> = Object.create(null);
  const rawNodes = isObj(raw.nodes) ? raw.nodes : {};
  for (const id of Object.keys(rawNodes)) {
    const rn = rawNodes[id];
    if (!isObj(rn)) {
      fix(`dropped malformed node ${id}`);
      continue;
    }
    const n = rn as unknown as MapNode;
    if (typeof n.text !== 'string') {
      n.text = typeof rn.text === 'number' ? String(rn.text) : '';
      fix(`node ${id}: fixed text`);
    }
    if (n.aliasGroup !== undefined && !validAliasGroup(n.aliasGroup)) {
      delete n.aliasGroup;
      fix(`node ${id}: dropped malformed alias group`);
    }
    if (n.blankAnswer !== undefined && typeof n.blankAnswer !== 'string') {
      delete n.blankAnswer;
      fix(`node ${id}: dropped malformed study answer`);
    }
    if (n.note !== undefined && typeof n.note !== 'string') {
      delete n.note; fix(`node ${id}: dropped malformed note`);
    }
    if (n.tags !== undefined) {
      if (!Array.isArray(n.tags)) { delete n.tags; fix(`node ${id}: dropped malformed tags`); }
      else n.tags = n.tags.filter(tag => typeof tag === 'string');
    }
    if (n.offset && (!finite(n.offset.x) || !finite(n.offset.y))) {
      delete n.offset; fix(`node ${id}: dropped invalid position`);
    }
    if (n.pinnedPosition !== undefined && (!isObj(n.pinnedPosition) ||
        !finite(n.pinnedPosition.x) || !finite(n.pinnedPosition.y))) {
      delete n.pinnedPosition;
      fix(`node ${id}: dropped invalid pin position`);
    }
    if (n.artStyleSheet !== undefined) n.artStyleSheet = parseSubtreeArtStyle(n.artStyleSheet);
    if (n.artStyleIsland !== true) delete n.artStyleIsland;
    for (const field of ['pictureArtError', 'svgArtError'] as const) {
      const error = n[field];
      if (error !== undefined && (typeof error !== 'string' || !error.length || error.length > 280)) {
        delete n[field];
        fix(`node ${id}: dropped malformed artwork failure`);
      }
    }
    for (const key of ['pictureArt','svgArt','artReference'] as const) {
      const art = n[key];
      if (art !== undefined && (!isObj(art) || typeof art.assetHash !== 'string' ||
          typeof art.prompt !== 'string' || typeof art.inputHash !== 'string' || typeof art.styleId !== 'string')) {
        delete n[key]; fix(`node ${id}: dropped malformed artwork reference`);
      }
    }
    if(n.generatedStyle)n.generatedStyle=parseGeneratedStyle(n.generatedStyle);
    if (n.generatedDraft !== true) delete n.generatedDraft;
    if (n.style !== undefined) {
      if (!isObj(n.style)) { delete n.style; fix(`node ${id}: dropped malformed style`); }
      else {
        if (!finite(n.style.fontSize) || n.style.fontSize <= 0) delete n.style.fontSize;
        for (const key of ['color','textColor'] as const) if (typeof n.style[key] !== 'string') delete n.style[key];
        for (const key of ['branchBoundary', 'extrudedLabel'] as const) {
          if (typeof n.style[key] !== 'boolean') delete n.style[key];
        }
      }
    }
    if (n.imageAspect !== undefined && (!finite(n.imageAspect) || n.imageAspect <= 0)) delete n.imageAspect;
    if (n.imageScale !== undefined && (!finite(n.imageScale) || n.imageScale < 0.25 || n.imageScale > 6)) delete n.imageScale;
    if (n.imageAlt !== undefined && typeof n.imageAlt !== 'string') delete n.imageAlt;
    if (n.sketch !== undefined) {
      const sketch = parseInkSketch(n.sketch);
      if (sketch) n.sketch = sketch;
      else { delete n.sketch; fix(`node ${id}: dropped malformed sketch`); }
    }
    if (typeof n.sourceHeading !== 'string' || !n.sourceHeading.trim() || n.sourceHeading.length > 240) delete n.sourceHeading;
    if (n.sticker !== undefined && (typeof n.sticker !== 'string' || n.sticker.length > 64)) delete n.sticker;
    if (n.lastAiJob !== undefined && (typeof n.lastAiJob !== 'string' || !validAiJobId(n.lastAiJob))) {
      delete n.lastAiJob;
      fix(`node ${id}: dropped malformed AI revision reference`);
    }
    if (n.origin !== undefined && (!isObj(n.origin) || (n.origin.by !== 'user' &&
        (n.origin.by !== 'ai' || typeof n.origin.job !== 'string')))) {
      delete n.origin;
      fix(`node ${id}: dropped malformed node origin`);
    }
    n.id = id;
    n.parent = typeof n.parent === 'string' ? n.parent : null;
    n.children = Array.isArray(n.children) ? n.children.filter((c): c is string => typeof c === 'string') : [];
    nodes[id] = n;
  }

  const canonicalAliases = new Map<string, MapNode>();
  for (const id of Object.keys(nodes).filter((id) => nodes[id].aliasGroup).sort()) {
    const node = nodes[id];
    const group = node.aliasGroup!;
    const first = canonicalAliases.get(group);
    if (!first) {
      canonicalAliases.set(group, node);
      continue;
    }
    for (const field of SHARED_ALIAS_FIELDS) {
      if (JSON.stringify(node[field]) === JSON.stringify(first[field])) continue;
      if (first[field] === undefined) delete node[field as Exclude<typeof field, 'text'>];
      else Object.assign(node, { [field]: cloneValue(first[field]) });
      fix(`node ${id}: repaired inconsistent alias content`);
    }
  }

  // --- rebuild structure from the children lists, starting at the declared roots
  const roots: NodeId[] = [];
  const visited = new Set<NodeId>();
  const walk = (start: NodeId) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop() as NodeId;
      const n = nodes[id];
      const keep: NodeId[] = [];
      for (const c of n.children) {
        if (!nodes[c] || visited.has(c) || c === id) {
          fix(`node ${id}: dropped invalid child ${c}`);
          continue;
        }
        visited.add(c);
        if (nodes[c].parent !== id) {
          fix(`node ${c}: parent pointer corrected`);
          nodes[c].parent = id;
        }
        keep.push(c);
        stack.push(c);
      }
      n.children = keep;
    }
  };
  const addRoot = (id: NodeId) => {
    visited.add(id);
    nodes[id].parent = null;
    roots.push(id);
    walk(id);
  };
  const declared = Array.isArray(raw.roots) ? raw.roots : [];
  for (const r of declared) {
    if (typeof r !== 'string' || !nodes[r] || visited.has(r)) {
      fix(`dropped invalid root ${String(r)}`);
      continue;
    }
    addRoot(r);
  }
  // Orphans: nodes with a missing parent first, then anything left over (cycles).
  const ids = Object.keys(nodes);
  for (const id of ids) {
    if (visited.has(id)) continue;
    const p = nodes[id].parent;
    if (p === null || !nodes[p]) {
      fix(`node ${id}: orphan promoted to root`);
      addRoot(id);
    }
  }
  for (const id of ids) {
    if (visited.has(id)) continue;
    fix(`node ${id}: cycle broken, promoted to root`);
    addRoot(id);
  }
  if (roots.length === 0) {
    const d = createDoc();
    fix('document had no nodes; created a new root');
    return { doc: d, repairs };
  }

  // --- root info
  const rootInfo: Record<NodeId, RootInfo> = Object.create(null);
  const rawInfo = isObj(raw.rootInfo) ? raw.rootInfo : {};
  for (const r of roots) {
    const ri = rawInfo[r];
    const pos = isObj(ri) && isObj(ri.position) ? ri.position : undefined;
    const x = pos && finite(pos.x) ? pos.x : 0;
    const y = pos && finite(pos.y) ? pos.y : 0;
    const layout =
      isObj(ri) && ROOT_LAYOUTS.includes(ri.layout as LayoutKind) ? (ri.layout as LayoutKind) : 'mindmap';
    if (!ri) fix(`root ${r}: added missing rootInfo`);
    const spacing = isObj(ri) ? ri.spacing : undefined;
    rootInfo[r] = {
      position: { x, y }, layout,
      ...(spacing === 'narrow' || spacing === 'default' || spacing === 'wide' ? { spacing } : {}),
      ...(isObj(ri) && ri.organic === true ? { organic: true } : {}),
    };
  }

  // --- links
  const links: CrossLink[] = [];
  const linkIds = new Set<string>();
  if (Array.isArray(raw.links)) {
    for (const l of raw.links) {
      if (
        isObj(l) &&
        typeof l.id === 'string' &&
        typeof l.from === 'string' &&
        typeof l.to === 'string' &&
        nodes[l.from] &&
        nodes[l.to] &&
        !linkIds.has(l.id)
      ) {
        linkIds.add(l.id);
        const link: CrossLink = { id: l.id, from: l.from, to: l.to };
        if (isObj(l.bend) && finite(l.bend.x) && finite(l.bend.y)) link.bend={x:l.bend.x,y:l.bend.y};
        if (typeof l.color === 'string' && /^#[a-f0-9]{6}$/i.test(l.color)) link.color=l.color;
        if (l.dash === 'solid' || l.dash === 'dashed') link.dash=l.dash;
        if (l.arrows === 'none' || l.arrows === 'start' || l.arrows === 'end' || l.arrows === 'both') link.arrows=l.arrows;
        if (typeof l.label === 'string') link.label = l.label;
        links.push(link);
      } else fix('dropped invalid link');
    }
  }

  const aiJobs = parseAiJobs(raw.aiJobs);
  if (raw.aiJobs !== undefined && (!isObj(raw.aiJobs) || Object.keys(raw.aiJobs).length !== Object.keys(aiJobs ?? {}).length)) {
    fix('Dropped invalid AI job records');
  }
  const presentations = parsePresentations(raw.presentations, fix);
  const canvas = parseCanvas(raw.canvas, nodes, fix);
  const rootNode = nodes[roots[0]];
  const doc: Doc = {
    version: 1,
    id: typeof raw.id === 'string' ? raw.id : newId(),
    title: typeof raw.title === 'string' ? raw.title : rootNode.text,
    roots,
    rootInfo,
    layoutPlacements: readPlacements(raw.layoutPlacements, nodes, rootInfo),
    nodes,
    links,
    ...(aiJobs ? { aiJobs } : {}),
    tagColors: isObj(raw.tagColors) ? Object.fromEntries(Object.entries(raw.tagColors)
      .filter((entry): entry is [string,string] => typeof entry[1] === 'string' && /^#[a-f0-9]{6}$/i.test(entry[1]))
      .map(([key,value])=>[key.toLowerCase(),value])) : undefined,
    markerMeanings: isObj(raw.markerMeanings) ? Object.fromEntries(Object.entries(raw.markerMeanings)
      .filter((entry): entry is [string, string] => {
        const [marker, meaning] = entry;
        return marker.trim() === marker && marker.length > 0 && marker.length <= 64 &&
          typeof meaning === 'string' && meaning.trim().length > 0 && meaning.length <= 120;
      })) : undefined,
    themeSettings:parseThemeSettings(raw.themeSettings),
    themeId: typeof raw.themeId === 'string' ? raw.themeId : DEFAULT_THEME_ID,
    ...(typeof raw.artStyleId === 'string' ? { artStyleId: raw.artStyleId } : {}),
    seed: finite(raw.seed) ? raw.seed : (Math.random() * 0x7fffffff) | 0,
    created: typeof raw.created === 'string' ? raw.created : now,
    modified: typeof raw.modified === 'string' ? raw.modified : now,
    // Last, so that ops creating these fields append them in the same place (see ops.ts placeTail).
    ...(presentations ? { presentations } : {}),
    ...(canvas ? { canvas } : {})
  };
  const errs = validateDoc(doc);
  if (errs.length) throw new Error(`Document is invalid and could not be repaired: ${errs[0]}`);
  return { doc: withSubtreeArtStyles(doc), repairs };
}

// ====================================================================== presentations and canvas elements

/** Limits for canvas elements (CNV-12). */
export const CANVAS_LIMITS = { elements: 20_000, points: 4_096, textBytes: 8_000 } as const;

const CANVAS_KINDS: readonly CanvasElementKind[] = ['rect', 'ellipse', 'diamond', 'line', 'arrow', 'draw', 'text', 'note', 'frame', 'image'];
const HEX = /^#[0-9a-f]{6}$/i;
const HASH = /^[a-f0-9]{64}$/;
const HEADS = ['none', 'arrow', 'dot', 'bar'] as const;

function oneOf<T extends string | number>(values: readonly T[], v: unknown): v is T {
  return values.includes(v as T);
}
function stringList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : undefined;
}

/** UTF-8 byte length of a string. */
function utf8Bytes(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
export function limitTextBytes(text: string, max: number = CANVAS_LIMITS.textBytes): string {
  if (text.length * 3 <= max || utf8Bytes(text) <= max) return text;
  let n = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length;
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (n + size > max) break;
    n += size;
    i += pair ? 2 : 1;
  }
  return text.slice(0, i);
}

/**
 * Simplify a flat point list (x0, y0, x1, y1, ...) to at most `max` points with Ramer-Douglas-Peucker,
 * doubling the tolerance until it fits. The first and last points are kept; pressures follow the kept points.
 */
export function simplifyPoints(points: number[], pressures: number[] | undefined, max: number = CANVAS_LIMITS.points):
    { points: number[]; pressures?: number[] } {
  const count = points.length >> 1;
  if (count <= max) return { points, pressures };
  let span = 0;
  for (let i = 0; i < points.length; i++) span = Math.max(span, Math.abs(points[i]));
  let tolerance = Math.max(span, 1) * 1e-5;
  for (;;) {
    const keep = rdp(points, count, tolerance);
    if (keep.length <= max) {
      return {
        points: keep.flatMap((k) => [points[k * 2], points[k * 2 + 1]]),
        ...(pressures ? { pressures: keep.map((k) => pressures[k]) } : {})
      };
    }
    tolerance *= 2;
  }
}

function rdp(p: number[], count: number, tolerance: number): number[] {
  const keep = new Uint8Array(count);
  keep[0] = keep[count - 1] = 1;
  const stack: Array<[number, number]> = [[0, count - 1]];
  const t2 = tolerance * tolerance;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = p[a * 2], ay = p[a * 2 + 1], dx = p[b * 2] - ax, dy = p[b * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let far = t2;
    for (let i = a + 1; i < b; i++) {
      const px = p[i * 2] - ax, py = p[i * 2 + 1] - ay;
      let d2: number;
      if (len2 === 0) d2 = px * px + py * py;
      else {
        const s = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - s * dx, ey = py - s * dy;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > far) { far = d2; worst = i; }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push([a, worst], [worst, b]);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (keep[i]) out.push(i);
  return out;
}

/** Targets that canvas bindings and frame references may point at. Null skips the existence checks. */
interface CanvasTargets {
  nodes: Record<NodeId, unknown>;
  elements: Map<string, CanvasElementKind>;
}

function readBinding(raw: unknown, self: string, targets: CanvasTargets | null, fix: (m: string) => void, where: string): CanvasBinding | undefined {
  if (!isObj(raw)) { fix(`${where}: dropped malformed binding`); return; }
  const out: CanvasBinding = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (key === 'node' && typeof v === 'string' && v) out.node = v;
    else if (key === 'element' && typeof v === 'string' && v && v !== self) out.element = v;
    else if (key === 'at' && isObj(v) && finite(v.x) && finite(v.y)) out.at = { x: v.x, y: v.y };
    else if (key === 'gap' && finite(v)) out.gap = v;
    else fix(`${where}: dropped invalid binding field ${key}`);
  }
  if (!!out.node === !!out.element) { fix(`${where}: dropped binding without exactly one target`); return; }
  if (targets && (out.node ? !targets.nodes[out.node] : !targets.elements.has(out.element!))) {
    fix(`${where}: cleared binding to a missing target`);
    return;
  }
  return out;
}

/**
 * Validate one canvas element, keeping the key order of the input and dropping invalid or unknown fields.
 * Returns undefined for an element that cannot be kept (not an object, no id, unknown kind).
 * @param targets existing nodes and elements for binding and frame checks; null skips those checks.
 */
export function parseCanvasElement(raw: unknown, targets: CanvasTargets | null, fix: (m: string) => void): CanvasElement | undefined {
  if (!isObj(raw)) { fix('dropped malformed canvas element'); return; }
  const id = raw.id;
  if (typeof id !== 'string' || !id) { fix('dropped canvas element without an id'); return; }
  if (!oneOf(CANVAS_KINDS, raw.kind)) { fix(`dropped canvas element ${id} of unknown kind ${String(raw.kind)}`); return; }
  const where = `canvas element ${id}`;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (v === undefined) continue;
    let ok = true;
    switch (key) {
      case 'id': case 'kind': out[key] = v; break;
      case 'x': case 'y': case 'w': case 'h': case 'seed':
        if (finite(v)) out[key] = v;
        else { out[key] = 0; fix(`${where}: made ${key} finite`); }
        continue;
      case 'angle': case 'fontSize': case 'strokeWidth':
        ok = finite(v) && (key === 'angle' || v > 0); if (ok) out[key] = v; break;
      case 'opacity': ok = finite(v) && v >= 0 && v <= 1; if (ok) out[key] = v; break;
      case 'band': ok = v === 'back' || v === 'front'; if (ok) out[key] = v; break;
      case 'stroke': case 'fill': case 'textColor': ok = typeof v === 'string' && HEX.test(v); if (ok) out[key] = v; break;
      case 'fillStyle': ok = oneOf(['solid', 'hachure', 'cross-hatch', 'zigzag'], v); if (ok) out[key] = v; break;
      case 'strokeStyle': ok = oneOf(['solid', 'dashed', 'dotted'], v); if (ok) out[key] = v; break;
      case 'roughness': ok = oneOf([0, 1, 2], v); if (ok) out[key] = v; break;
      case 'round': case 'locked': case 'elbow': ok = typeof v === 'boolean'; if (ok) out[key] = v; break;
      case 'groups': { const g = stringList(v); ok = !!g?.length && g.length === (v as unknown[]).length; if (g?.length) out[key] = g; break; }
      case 'frame': ok = typeof v === 'string' && !!v && v !== id &&
        (!targets || targets.elements.get(v) === 'frame'); if (ok) out[key] = v; break;
      case 'link': ok = typeof v === 'string'; if (ok) out[key] = v; break;
      case 'text':
        ok = typeof v === 'string';
        if (ok) {
          const cut = limitTextBytes(v as string);
          if (cut !== v) fix(`${where}: text cut to ${CANVAS_LIMITS.textBytes} bytes`);
          out[key] = cut;
        }
        break;
      case 'font': ok = oneOf(['theme', 'hand', 'code'], v); if (ok) out[key] = v; break;
      case 'align': ok = oneOf(['left', 'center', 'right'], v); if (ok) out[key] = v; break;
      case 'points': case 'pressures': {
        ok = Array.isArray(v) && v.every((n) => typeof n === 'number');
        if (!ok) break;
        const list = (v as number[]).map((n) => Number.isFinite(n) ? n : 0);
        if (list.some((n, i) => n !== (v as number[])[i])) fix(`${where}: made ${key} finite`);
        out[key] = list;
        break;
      }
      case 'start': case 'end': { const b = readBinding(v, id, targets, fix, where); if (b) out[key] = b; continue; }
      case 'startHead': case 'endHead': ok = oneOf(HEADS, v); if (ok) out[key] = v; break;
      case 'asset': ok = typeof v === 'string' && HASH.test(v); if (ok) out[key] = v; break;
      case 'source': ok = isObj(v); if (ok) out[key] = cloneValue(v); break;
      default: ok = false;
    }
    if (!ok) fix(`${where}: dropped invalid field ${key}`);
  }
  for (const key of ['x', 'y', 'w', 'h', 'seed'] as const) {
    if (!(key in out)) { out[key] = 0; fix(`${where}: added missing ${key}`); }
  }
  const points = out.points as number[] | undefined;
  if (points && points.length % 2) { delete out.points; fix(`${where}: dropped odd-length points`); }
  const pressures = out.pressures as number[] | undefined;
  if (pressures) {
    if (!out.points || pressures.length !== (out.points as number[]).length / 2) {
      delete out.pressures; fix(`${where}: dropped pressures that do not match the points`);
    } else if (pressures.some((p) => p < 0 || p > 1)) {
      out.pressures = pressures.map((p) => Math.max(0, Math.min(1, p)));
      fix(`${where}: clamped pressures to 0..1`);
    }
  }
  if (out.points && (out.points as number[]).length / 2 > CANVAS_LIMITS.points) {
    const simple = simplifyPoints(out.points as number[], out.pressures as number[] | undefined);
    out.points = simple.points;
    if (simple.pressures) out.pressures = simple.pressures;
    fix(`${where}: stroke simplified to ${CANVAS_LIMITS.points} points`);
  }
  return out as unknown as CanvasElement;
}

function readCamera(v: unknown): CameraState | undefined {
  return isObj(v) && finite(v.cx) && finite(v.cy) && finite(v.zoom) && v.zoom > 0 ? { cx: v.cx, cy: v.cy, zoom: v.zoom } : undefined;
}

/** Bookmarks of {@link CanvasState}; undefined when malformed. */
export function parseCanvasBookmarks(v: unknown, fix: (m: string) => void): NonNullable<CanvasState['bookmarks']> | undefined {
  if (!Array.isArray(v)) { fix('dropped malformed canvas bookmarks'); return; }
  const out: NonNullable<CanvasState['bookmarks']> = [];
  const ids = new Set<string>();
  for (const b of v) {
    const view = isObj(b) ? readCamera(b.view) : undefined;
    if (!isObj(b) || typeof b.id !== 'string' || !b.id || ids.has(b.id) || typeof b.name !== 'string' || !view) {
      fix('dropped invalid canvas bookmark');
      continue;
    }
    ids.add(b.id);
    out.push({ id: b.id, name: b.name, view });
  }
  return out;
}

/** Grid of {@link CanvasState}; undefined when malformed. */
export function parseCanvasGrid(v: unknown): CanvasState['grid'] {
  return isObj(v) && finite(v.size) && v.size > 0 && typeof v.snap === 'boolean' ? { size: v.size, snap: v.snap } : undefined;
}

/**
 * Read `Doc.canvas`: unknown kinds are dropped, numbers made finite, colours must be six-digit hex,
 * bindings and frame references to missing targets are cleared. An empty canvas reads as undefined.
 */
export function parseCanvas(raw: unknown, nodes: Record<NodeId, unknown>, fix: (m: string) => void): CanvasState | undefined {
  if (raw === undefined) return;
  if (!isObj(raw)) { fix('dropped malformed canvas'); return; }
  const list = Array.isArray(raw.elements) ? raw.elements : [];
  if (raw.elements !== undefined && !Array.isArray(raw.elements)) fix('dropped malformed canvas element list');
  if (list.length > CANVAS_LIMITS.elements) fix(`dropped ${list.length - CANVAS_LIMITS.elements} canvas elements over the limit of ${CANVAS_LIMITS.elements}`);
  const kept = list.slice(0, CANVAS_LIMITS.elements);
  // First pass: ids and kinds of the elements that will survive, for binding and frame checks.
  const elements = new Map<string, CanvasElementKind>();
  for (const e of kept) {
    if (isObj(e) && typeof e.id === 'string' && e.id && oneOf(CANVAS_KINDS, e.kind) && !elements.has(e.id)) elements.set(e.id, e.kind);
  }
  const targets: CanvasTargets = { nodes, elements };
  const seen = new Set<string>();
  const out: CanvasElement[] = [];
  for (const e of kept) {
    const el = parseCanvasElement(e, targets, fix);
    if (!el) continue;
    if (seen.has(el.id)) { fix(`dropped duplicate canvas element ${el.id}`); continue; }
    seen.add(el.id);
    out.push(el);
  }
  const canvas: CanvasState = { elements: out };
  if (raw.bookmarks !== undefined) {
    const bookmarks = parseCanvasBookmarks(raw.bookmarks, fix);
    if (bookmarks?.length) canvas.bookmarks = bookmarks;
  }
  if (raw.grid !== undefined) {
    const grid = parseCanvasGrid(raw.grid);
    if (grid) canvas.grid = grid;
    else fix('dropped malformed canvas grid');
  }
  for (const key of Object.keys(raw)) if (key !== 'elements' && key !== 'bookmarks' && key !== 'grid') fix(`dropped unknown canvas field ${key}`);
  return emptyCanvas(canvas) ? undefined : canvas;
}

/** True when a canvas holds nothing worth saving; such a canvas is stored as an absent field. */
export function emptyCanvas(canvas: CanvasState): boolean {
  return canvas.elements.length === 0 && !canvas.bookmarks && !canvas.grid;
}

function readStep(raw: unknown, ids: Set<string>, fix: (m: string) => void, where: string): PresentationStep | undefined {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id)) {
    fix(`${where}: dropped invalid step`);
    return;
  }
  ids.add(raw.id);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (v === undefined) continue;
    let ok = true;
    switch (key) {
      case 'id': out[key] = v; break;
      case 'focus': case 'reveal': case 'hide': case 'elements': {
        const list = stringList(v);
        ok = !!list && list.length === (v as unknown[]).length;
        if (list) out[key] = list;
        break;
      }
      case 'frame': ok = oneOf(['nodes', 'subtree', 'map'], v); if (ok) out[key] = v; break;
      case 'build': ok = oneOf(['all', 'each'], v); if (ok) out[key] = v; break;
      case 'dim': ok = oneOf(['others', 'none'], v); if (ok) out[key] = v; break;
      case 'transition': ok = oneOf(['glide', 'cut'], v); if (ok) out[key] = v; break;
      case 'title': case 'caption': case 'note': ok = typeof v === 'string'; if (ok) out[key] = v; break;
      case 'skip': ok = typeof v === 'boolean'; if (ok) out[key] = v; break;
      case 'seconds': ok = finite(v) && v >= 0; if (ok) out[key] = v; break;
      default: ok = false;
    }
    if (!ok) fix(`${where}: step ${raw.id}: dropped invalid field ${key}`);
  }
  if (!out.focus) { out.focus = []; fix(`${where}: step ${raw.id}: added missing focus`); }
  return out as unknown as PresentationStep;
}

/** Validate one presentation, keeping key order. Node ids that no longer exist are kept (PRS-12). */
export function parsePresentation(raw: unknown, fix: (m: string) => void): Presentation | undefined {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) { fix('dropped invalid presentation'); return; }
  const where = `presentation ${raw.id}`;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    const v = raw[key];
    if (v === undefined) continue;
    let ok = true;
    switch (key) {
      case 'id': out[key] = v; break;
      case 'name': ok = typeof v === 'string'; if (ok) out[key] = v; break;
      case 'steps': {
        ok = Array.isArray(v);
        if (!ok) break;
        const ids = new Set<string>();
        out[key] = (v as unknown[]).map((s) => readStep(s, ids, fix, where)).filter((s) => s !== undefined);
        break;
      }
      case 'reveal': ok = oneOf(['progressive', 'all'], v); if (ok) out[key] = v; break;
      case 'context': ok = oneOf(['dim', 'hide'], v); if (ok) out[key] = v; break;
      case 'motion': ok = oneOf(['full', 'gentle', 'none'], v); if (ok) out[key] = v; break;
      case 'dimOpacity': ok = finite(v) && v >= 0 && v <= 1; if (ok) out[key] = v; break;
      case 'targetMinutes': ok = finite(v) && v >= 0; if (ok) out[key] = v; break;
      default: ok = false;
    }
    if (!ok) fix(`${where}: dropped invalid field ${key}`);
  }
  if (typeof out.name !== 'string') { out.name = 'Presentation'; fix(`${where}: added missing name`); }
  if (!out.steps) { out.steps = []; fix(`${where}: added missing steps`); }
  return out as unknown as Presentation;
}

/** Read `Doc.presentations`. An empty list reads as undefined. */
export function parsePresentations(raw: unknown, fix: (m: string) => void): Presentation[] | undefined {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) { fix('dropped malformed presentations'); return; }
  const ids = new Set<string>();
  const out: Presentation[] = [];
  for (const p of raw) {
    const value = parsePresentation(p, fix);
    if (!value) continue;
    if (ids.has(value.id)) { fix(`dropped duplicate presentation ${value.id}`); continue; }
    ids.add(value.id);
    out.push(value);
  }
  return out.length ? out : undefined;
}

/** Problems that make a canvas element unusable in an op; empty when it is valid as given. */
export function canvasElementProblems(value: unknown): string[] {
  const problems: string[] = [];
  parseCanvasElement(value, null, (m) => problems.push(m));
  return problems;
}

/** Problems that make a presentation unusable in an op; empty when it is valid as given. */
export function presentationProblems(value: unknown): string[] {
  const problems: string[] = [];
  parsePresentation(value, (m) => problems.push(m));
  return problems;
}

function readPlacements(raw: unknown, nodes: Doc['nodes'], rootInfo: Doc['rootInfo']): LayoutPlacements | undefined {
  if (!isObj(raw) || !isObj(raw.nodes) || !isObj(raw.roots)) return;
  const roots: LayoutPlacements['roots'] = Object.create(null);
  const positions: LayoutPlacements['nodes'] = Object.create(null);
  for (const id of Object.keys(rootInfo)) {
    const root = raw.roots[id];
    if (!isObj(root) || root.layout !== rootInfo[id].layout ||
        !finite(root.x) || !finite(root.y) || !finite(root.levelGap) || !finite(root.siblingGap)) continue;
    roots[id] = { layout: rootInfo[id].layout, x: root.x, y: root.y, levelGap: root.levelGap, siblingGap: root.siblingGap,
      ...(finite(root.organicSeed) ? { organicSeed: root.organicSeed } : {}) };
  }
  for (const id of Object.keys(nodes)) {
    const b = raw.nodes[id];
    if (!isObj(b) || typeof b.root !== 'string' || !roots[b.root] || b.parent !== nodes[id].parent ||
        !finite(b.x) || !finite(b.y) || !finite(b.w) || !finite(b.h) || b.w < 0 || b.h < 0 ||
        !finite(b.offsetX) || !finite(b.offsetY) || !finite(b.index) || !finite(b.siblingCount) ||
        (b.side !== -1 && b.side !== 0 && b.side !== 1) ||
        (b.flow !== 'h' && b.flow !== 'v' && b.flow !== 'r')) continue;
    positions[id] = {
      root: b.root, parent: nodes[id].parent, index: b.index, siblingCount: b.siblingCount,
      x: b.x, y: b.y, w: b.w, h: b.h, offsetX: b.offsetX, offsetY: b.offsetY, side: b.side, flow: b.flow,
      ...(TREE_LAYOUTS.includes(b.branchLayout as LayoutKind) ? { branchLayout: b.branchLayout as LayoutKind } : {}),
      ...(b.pinnedSide === 'left' || b.pinnedSide === 'right' ? { pinnedSide: b.pinnedSide } : {}),
      ...(b.collapsed === true ? { collapsed: true } : {})
    };
  }
  if (Object.keys(roots).length) return { roots, nodes: positions };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
