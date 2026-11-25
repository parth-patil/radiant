/**
 * Streaming side of the JSON Lines contract (decision D-08): NodeLineParser turns text deltas into validated
 * StreamNodes; StreamApplier turns StreamNodes into document Ops. Pure: no model-module import, no DOM, no Tauri.
 */
import type { MapNode, NodeId, Op, RootInfo, StreamNode, StyleSheet, LayoutKind } from '../types';
import nodeStream from './templates/node-stream.json';
import { listThemes } from '../model/themes';
import { SHEET_FONTS } from '../model/generated-style';
import { STYLE_BRANCHES, STYLE_LAYOUTS, STYLE_SHAPES } from './prompts';

// ------------------------------------------------------------------ line parser

export interface NodeLineHandlers {
  onNode(node: StreamNode, raw: string, repairSlot?: number): void;
  /** Partial style sheet from the optional style line; invalid fields are already dropped. */
  onStyle?(style: Partial<StyleSheet>): void;
  /** A line that could not be used (not JSON, missing fields, over-long title...). */
  onError?(line: string, reason: string): void;
  /** A usable line carried something that was ignored (for example x/y fields, an invalid style value). */
  onWarning?(line: string, reason: string): void;
}

export interface NodeLineParserOptions {
  /** Titles longer than this are rejected. Default 200. */
  maxTitleLength?: number;
  /** Notes longer than this are truncated. Default 2000. */
  maxNoteLength?: number;
  /** Lines longer than this are rejected without parsing. Default 20000. */
  maxLineLength?: number;
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Accepts text deltas in arbitrary chunks and emits each complete line as soon as its newline arrives.
 * Tolerates code fences, blank lines, `\r\n`, a trailing comma and array brackets. Call `end()` when the model
 * finished normally (a last line without newline is processed); call `discard()` after an interrupt so a partial
 * line never becomes a node.
 */
export class NodeLineParser {
  private buf = '';
  private readonly maxTitle: number;
  private readonly maxNote: number;
  private readonly maxLine: number;
  /** Counters, handy for the job summary. */
  nodes = 0;
  errors = 0;

  constructor(
    private readonly h: NodeLineHandlers,
    opts: NodeLineParserOptions = {},
  ) {
    this.maxTitle = opts.maxTitleLength ?? nodeStream.limits.title;
    this.maxNote = opts.maxNoteLength ?? nodeStream.limits.note;
    this.maxLine = opts.maxLineLength ?? nodeStream.limits.line;
  }

  push(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      this.line(line);
      nl = this.buf.indexOf('\n');
    }
  }

  /** The stream finished: process a final line that has no newline. */
  end(): void {
    const rest = this.buf;
    this.buf = '';
    if (rest.trim()) this.line(rest, true);
  }

  /** The stream was interrupted: drop the unfinished line. Returns it (for logging). */
  discard(): string {
    const rest = this.buf;
    this.buf = '';
    return rest;
  }

  private fail(line: string, reason: string): void {
    this.errors++;
    this.h.onError?.(line, reason);
  }

  private line(raw: string, final = false): void {
    let s = raw.trim();
    if (!s) return;
    if (s.startsWith('```') || s === '[' || s === ']') return; // code fence / array brackets
    if (s.endsWith(',')) s = s.slice(0, -1).trimEnd();
    if (s.length > this.maxLine) return this.fail(raw.slice(0, 200), 'line too long');
    if (!s.startsWith('{')) {
      if (!final) this.fail(s.slice(0, 200), 'not a JSON object');
      return;
    }
    let v: unknown;
    try {
      v = JSON.parse(s);
    } catch {
      if (!final) this.fail(s.slice(0, 200), 'invalid JSON');
      return;
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return this.fail(s.slice(0, 200), 'not a JSON object');
    const o = v as Record<string, unknown>;
    const fields = nodeStream.fields;

    // Style line: {"style":{...}} (proposed) or {"type":"style", ...fields}
    if (o.style && typeof o.style === 'object' && !Array.isArray(o.style) && !(fields.title in o)) {
      return this.style(s, o.style as Record<string, unknown>);
    }
    if (o.type === 'style') {
      const { type: _t, ...rest } = o;
      return this.style(s, rest);
    }

    const rawId = o[fields.id];
    const id = typeof rawId === 'number' ? String(rawId) : rawId;
    if (typeof id !== 'string' || !id.trim()) return this.fail(s, 'missing id');
    const rawParent = o[fields.parent];
    let parent: string | null;
    if (rawParent === null || rawParent === '') parent = null;
    else if (typeof rawParent === 'string' || typeof rawParent === 'number') parent = String(rawParent);
    else return this.fail(s, 'parent must be a string or null');
    const rawTitle = o[fields.title];
    if (typeof rawTitle !== 'string') return this.fail(s, 'missing title');
    const title = rawTitle.replace(/\s+/g, ' ').trim();
    if (!title) return this.fail(s, 'empty title');
    if (title.length > this.maxTitle) return this.fail(s, `title longer than ${this.maxTitle} characters`);

    const node: StreamNode = { id: id.trim(), parent, title };
    const note = o[fields.note];
    const source = o[fields.sourceHeading];
    const hint = o[fields.imageHint] ?? o[nodeStream.aliases.imageHint];
    if (typeof note === 'string' && note.trim()) node.note = note.trim().slice(0, this.maxNote);
    if (typeof source === 'string' && source.trim()) node.sourceHeading = source.trim().slice(0, nodeStream.limits.sourceHeading);
    if (typeof hint === 'string' && hint.trim()) node.imageHint = hint.trim().slice(0, nodeStream.limits.imageHint);
    const ignored = nodeStream.ignoredGeometry.filter(key => key in o);
    if (ignored.length) this.h.onWarning?.(s, `ignored geometry fields: ${ignored.join(', ')}`);
    this.nodes++;
    this.h.onNode(node, s, typeof o.repair === 'number' && Number.isSafeInteger(o.repair) ? o.repair : undefined);
  }

  private style(line: string, o: Record<string, unknown>): void {
    const out: Partial<StyleSheet> = {};
    const bad: string[] = [];
    if (Array.isArray(o.palette)) {
      const pal = o.palette.filter((c): c is string => typeof c === 'string' && HEX.test(c.trim())).map((c) => c.trim());
      if (pal.length) out.palette = pal.slice(0, 16);
      if (pal.length !== o.palette.length) bad.push('palette');
    } else if ('palette' in o) bad.push('palette');
    const pick = <T extends string>(key: string, allowed: readonly T[]): T | undefined => {
      if (!(key in o)) return undefined;
      const val = o[key];
      if (typeof val === 'string' && (allowed as readonly string[]).includes(val)) return val as T;
      bad.push(key);
      return undefined;
    };
    const family=pick('fontFamily',SHEET_FONTS);
    if(family)out.fontFamily=family;
    const branch = pick('branch', STYLE_BRANCHES);
    if (branch) out.branch = branch;
    const shape = pick('shape', STYLE_SHAPES);
    if (shape) out.shape = shape;
    const layout = pick('layout', STYLE_LAYOUTS);
    if (layout) out.layout = layout;
    if (typeof o.uppercaseMainBranches === 'boolean') out.uppercaseMainBranches = o.uppercaseMainBranches;
    else if ('uppercaseMainBranches' in o) bad.push('uppercaseMainBranches');
    const themeId=pick('themeId',listThemes().map(theme=>theme.id));
    if(themeId)out.themeId=themeId;
    for (const k of ['medium', 'mood'] as const) {
      if (typeof o[k] === 'string' && (o[k] as string).trim()) out[k] = (o[k] as string).trim().slice(0, 100);
    }
    if(bad.length)out.warnings=[...new Set(bad)];
    if (bad.length) this.h.onWarning?.(line, `style fields replaced by defaults: ${bad.join(', ')}`);
    this.h.onStyle?.(out);
  }
}

// ------------------------------------------------------------------ applier

export type AttachTo =
  | { kind: 'newRoot'; position: { x: number; y: number }; layout?: LayoutKind }
  | { kind: 'existing'; parentId: NodeId };

export interface StreamApplierConfig {
  /** Makes a fresh permanent node id. */
  idGen: () => NodeId;
  jobId: string;
  attachTo: AttachTo;
  /** Ids already in the document: used to keep generated ids unique and to check the attach target exists. */
  existingIds: Set<NodeId>;
  /** Maximum nodes added by this job. Default 400. */
  maxNodes?: number;
  /** Maximum depth. For `newRoot` the root is depth 0; for `existing` the first new level is depth 1. Default 6. */
  maxDepth?: number;
  /** Maximum children per node (breadth limit). Default unlimited. */
  maxChildren?: number;
}

export interface RejectedNode {
  node: StreamNode;
  reason: string;
}

const APPEND = Number.MAX_SAFE_INTEGER; // insert ops clamp the index, so this means "at the end"

/**
 * Maps streamed nodes (model-local ids) to insert Ops with permanent ids. Each `push` returns the ops to apply
 * immediately. Lines whose parent is unknown (including children of rejected lines) are dropped and reported in
 * `rejected`. For `existing` attachment only the given node may receive new first-level children, so a model
 * cannot touch other parts of the map.
 */
export class StreamApplier {
  readonly rejected: RejectedNode[] = [];
  /** imageHint per created node, for later picture generation (MapNode has no such field). */
  readonly imageHints = new Map<NodeId, string>();
  /** Permanent ids created by this job, in creation order. */
  readonly created: NodeId[] = [];

  private readonly cfg: Required<Omit<StreamApplierConfig, 'attachTo' | 'existingIds' | 'idGen' | 'jobId'>>;
  private readonly local = new Map<string, NodeId>(); // model id -> permanent id
  private readonly depth = new Map<NodeId, number>();
  private readonly childCount = new Map<NodeId, number>();
  private root: NodeId | null = null;
  private readonly used: Set<NodeId>;

  constructor(private readonly c: StreamApplierConfig) {
    this.cfg = {
      maxNodes: c.maxNodes ?? 400,
      maxDepth: c.maxDepth ?? 6,
      maxChildren: c.maxChildren ?? Number.POSITIVE_INFINITY,
    };
    this.used = new Set(c.existingIds);
  }

  /** Permanent id of the root created by a `newRoot` job (null until it arrives). */
  get rootId(): NodeId | null {
    return this.root;
  }

  get count(): number {
    return this.created.length;
  }

  /** Permanent id for a model id, if that node was applied. */
  nodeIdFor(localId: string): NodeId | undefined {
    return this.local.get(localId);
  }

  private reject(node: StreamNode, reason: string): Op[] {
    this.rejected.push({ node, reason });
    return [];
  }

  private freshId(): NodeId {
    for (let i = 0; i < 20; i++) {
      const id = this.c.idGen();
      if (!this.used.has(id)) return id;
    }
    throw new Error('idGen keeps returning ids that already exist');
  }

  push(node: StreamNode): Op[] {
    const at = this.c.attachTo;
    if (this.local.has(node.id)) return this.reject(node, 'duplicate id');
    if (this.created.length >= this.cfg.maxNodes) return this.reject(node, `node limit ${this.cfg.maxNodes} reached`);

    let parentReal: NodeId | null;
    let depth: number;
    if (at.kind === 'newRoot') {
      if (node.parent === null) {
        if (this.root !== null) return this.reject(node, 'second root');
        parentReal = null;
        depth = 0;
      } else {
        const p = this.local.get(node.parent);
        if (p === undefined) return this.reject(node, 'unknown parent');
        parentReal = p;
        depth = (this.depth.get(p) ?? 0) + 1;
      }
    } else {
      if (!this.c.existingIds.has(at.parentId)) return this.reject(node, 'attach target does not exist');
      const local = node.parent === null ? undefined : this.local.get(node.parent);
      if (local !== undefined) {
        parentReal = local;
        depth = (this.depth.get(local) ?? 0) + 1;
      } else if (node.parent === null || node.parent === at.parentId) {
        parentReal = at.parentId;
        depth = 1;
      } else {
        return this.reject(node, this.c.existingIds.has(node.parent) ? 'outside the allowed scope' : 'unknown parent');
      }
    }
    if (depth > this.cfg.maxDepth) return this.reject(node, `deeper than ${this.cfg.maxDepth} levels`);
    if (parentReal !== null && (this.childCount.get(parentReal) ?? 0) >= this.cfg.maxChildren) {
      return this.reject(node, `more than ${this.cfg.maxChildren} children under one node`);
    }

    const id = this.freshId();
    this.used.add(id);
    this.local.set(node.id, id);
    this.depth.set(id, depth);
    this.created.push(id);
    if (parentReal !== null) this.childCount.set(parentReal, (this.childCount.get(parentReal) ?? 0) + 1);
    if (node.imageHint) this.imageHints.set(id, node.imageHint);

    const mapNode: MapNode = {
      id,
      parent: parentReal,
      children: [],
      text: node.title,
      origin: { by: 'ai', job: this.c.jobId },
    };
    if (node.note) mapNode.note = node.note;
    if (node.sourceHeading) mapNode.sourceHeading = node.sourceHeading;

    if (parentReal === null) {
      this.root = id;
      const rootAt = at as Extract<AttachTo, { kind: 'newRoot' }>;
      const rootInfo: RootInfo = { position: { x: rootAt.position.x, y: rootAt.position.y }, layout: rootAt.layout ?? 'mindmap' };
      return [{ t: 'insert', node: mapNode, parent: null, index: APPEND, rootInfo }];
    }
    return [{ t: 'insert', node: mapNode, parent: parentReal, index: APPEND }];
  }
}

// ------------------------------------------------------------------ rephrase

/**
 * Applies rephrase lines (id = permanent id, new title) as `set` ops. Only ids in `allowedIds` are changed;
 * everything else is reported in `rejected`. Structure is never touched.
 */
export function rephraseOps(
  lines: StreamNode[],
  allowedIds: Set<NodeId>,
): { ops: Op[]; rejected: RejectedNode[] } {
  const ops: Op[] = [];
  const rejected: RejectedNode[] = [];
  const seen = new Set<string>();
  for (const n of lines) {
    if (!allowedIds.has(n.id)) rejected.push({ node: n, reason: 'outside the allowed scope' });
    else if (seen.has(n.id)) rejected.push({ node: n, reason: 'duplicate id' });
    else {
      seen.add(n.id);
      ops.push({ t: 'set', id: n.id, patch: { text: n.title } });
    }
  }
  return { ops, rejected };
}
