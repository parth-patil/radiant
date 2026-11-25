import type { CanvasElement, Doc, NodeBox, NodeId, Presentation, PresentationStep, Rect, Transaction } from '../types';
import { cloneValue } from './doc';
import { newId } from './ids';

// Presentations (implementation spec 6.2): automatic tours, the visible set at a step, step resolution and the
// commands that edit saved presentations. Everything here is pure; presenting itself is view state (PRS-03).

export type TourGranularity = 'branches' | 'levels' | 'nodes';

export interface TourOptions {
  /** Default 'levels'. */
  granularity?: TourGranularity;
  /** Cover only these nodes' subtrees, in this order. Absent or empty: the whole map. */
  selection?: readonly NodeId[];
}

/** Default dimming of context nodes. */
export const DEFAULT_DIM_OPACITY = 0.22;
/** Opacity of the ancestors of the focus while others are dimmed. */
export const ANCESTOR_OPACITY = 0.6;

/** Children shown in the editor: none for a folded node. Missing ids are skipped. */
function shownChildren(doc: Doc, id: NodeId): NodeId[] {
  const n = doc.nodes[id];
  return n && !n.collapsed ? n.children.filter((c) => doc.nodes[c]) : [];
}

/** Visible descendants of `id` in pre-order, children in document order (excluding `id`). */
function shownDescendants(doc: Doc, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  const stack = shownChildren(doc, id).reverse();
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    const kids = shownChildren(doc, cur);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

/** True when the node exists and no ancestor is folded, so the editor shows it. */
export function shownInEditor(doc: Doc, id: NodeId): boolean {
  const n = doc.nodes[id];
  if (!n) return false;
  for (let p = n.parent; p !== null; p = doc.nodes[p]?.parent ?? null) {
    const parent = doc.nodes[p];
    if (!parent || parent.collapsed) return false;
  }
  return true;
}

/** Drop selected nodes that are missing, hidden by a fold, repeated or inside another selected node's subtree. */
function tourStarts(doc: Doc, selection: readonly NodeId[]): NodeId[] {
  const chosen = new Set(selection.filter((id) => shownInEditor(doc, id)));
  const out: NodeId[] = [];
  for (const id of chosen) {
    let covered = false;
    for (let p = doc.nodes[id].parent; p !== null && !covered; p = doc.nodes[p].parent) covered = chosen.has(p);
    if (!covered && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Compute an automatic tour without storing anything (PRS-01). Children are visited in document order, depth first.
 * - `branches`: one step per main branch; it reveals the branch's whole unfolded subtree.
 * - `levels`: an opening step frames the map with the centres and their main branches, then one step for every node
 *   below the centre that has visible children (it reveals those children), then a closing whole-map step with
 *   nothing dimmed. Without a selection the count is 2 plus the number of such nodes.
 * - `nodes`: as `levels`, with `build: 'each'` so children appear one per press.
 * With a selection, `branches` makes one step per selected node and `levels` / `nodes` walk only the selected
 * subtrees (a selected node without visible children still gets a step of its own).
 * Step ids are derived from node ids, so the same map gives the same tour.
 */
export function autoTour(doc: Doc, options: TourOptions = {}): PresentationStep[] {
  const granularity = options.granularity ?? 'levels';
  const selection = options.selection?.length ? tourStarts(doc, options.selection) : null;
  const steps: PresentationStep[] = [];
  if (granularity === 'branches') {
    const heads = selection ?? doc.roots.flatMap((r) => shownChildren(doc, r));
    for (const id of heads) {
      const reveal = shownDescendants(doc, id);
      steps.push({ id: 'branch-' + id, focus: [id], ...(reveal.length ? { reveal } : {}) });
    }
    return steps;
  }
  const build = granularity === 'nodes' ? { build: 'each' as const } : {};
  const walk = (id: NodeId, always: boolean) => {
    const kids = shownChildren(doc, id);
    if (kids.length) steps.push({ id: 'node-' + id, focus: [id], reveal: kids, ...build });
    else if (always) steps.push({ id: 'node-' + id, focus: [id] });
    for (const c of kids) walk(c, false);
  };
  if (selection) {
    for (const id of selection) walk(id, true);
    return steps;
  }
  const roots = doc.roots.filter((r) => doc.nodes[r]);
  const mains = roots.flatMap((r) => shownChildren(doc, r));
  steps.push({ id: 'tour-start', focus: roots, ...(mains.length ? { reveal: mains } : {}), frame: 'map', ...(mains.length > 1 ? build : {}) });
  for (const r of roots) for (const c of shownChildren(doc, r)) walk(c, false);
  steps.push({ id: 'tour-end', focus: roots, frame: 'map', dim: 'none' });
  return steps;
}

// ---------------------------------------------------------------- resolving steps against the current document

export interface ResolvedStep {
  step: PresentationStep;
  /** Ids that still exist (PRS-12: missing ids are ignored at play time; the step itself is never rewritten). */
  focus: NodeId[];
  reveal: NodeId[];
  hide: NodeId[];
  /** Canvas elements that still exist. */
  elements: string[];
  /** Nothing left to focus: the player skips the step and the step list marks it broken. */
  broken: boolean;
}

/** Resolve one step against the document: drop ids that no longer exist and flag a step with nothing left to focus. */
export function resolveStep(doc: Doc, step: PresentationStep): ResolvedStep {
  return resolveWith(doc, step, elementIds(doc));
}

function elementIds(doc: Doc): Set<string> {
  return new Set((doc.canvas?.elements ?? []).map((e) => e.id));
}

function resolveWith(doc: Doc, step: PresentationStep, present: Set<string>): ResolvedStep {
  const nodes = (ids: readonly NodeId[] | undefined) => (ids ?? []).filter((id) => !!doc.nodes[id]);
  const focus = nodes(step.focus);
  const elements = (step.elements ?? []).filter((id) => present.has(id));
  return { step, focus, reveal: nodes(step.reveal), hide: nodes(step.hide), elements, broken: !focus.length && !elements.length };
}

/** Resolve every step of a presentation. */
export function resolvePresentation(doc: Doc, presentation: Presentation): ResolvedStep[] {
  const present = elementIds(doc);
  return presentation.steps.map((s) => resolveWith(doc, s, present));
}

/** Indices of the steps a player stops at: not skipped and not broken. */
export function playableSteps(doc: Doc, presentation: Presentation): number[] {
  return resolvePresentation(doc, presentation).flatMap((r, i) => (r.broken || r.step.skip ? [] : [i]));
}

/** Title shown for a step: its own, else the text of its first existing focus node, else of its first named element. */
export function stepTitle(doc: Doc, step: PresentationStep): string {
  if (step.title) return step.title;
  const first = step.focus.find((id) => doc.nodes[id]);
  if (first) return doc.nodes[first].text;
  if (!step.elements?.length) return '';
  const byId = new Map((doc.canvas?.elements ?? []).map((el) => [el.id, el]));
  for (const id of step.elements) {
    const text = byId.get(id)?.text?.trim();
    if (text) return text.split(/\s+/).join(' ');
  }
  return '';
}

/** Speaker note for a step: its own, else the note of its first existing focus node (DEC-P5). */
export function stepNote(doc: Doc, step: PresentationStep): string | undefined {
  if (step.note) return step.note;
  const first = step.focus.find((id) => doc.nodes[id]);
  return first ? doc.nodes[first].note : undefined;
}

// ---------------------------------------------------------------- visible set and opacity at a step

/** `focus`: focus and what this step reveals (opacity 1). `ancestor`: ancestors of the focus. `context`: the rest. */
export type StepOpacityClass = 'focus' | 'ancestor' | 'context';

export interface StepView {
  /** Nodes drawn at this step. Nodes inside a fold are never included (DEC-P2). */
  visible: Set<NodeId>;
  /** Class of every visible node. */
  classes: Map<NodeId, StepOpacityClass>;
  /** Opacity of every visible node, from the classes, the step's `dim` and the presentation's `dimOpacity`. */
  opacity: Map<NodeId, number>;
  /** Nodes the camera frames: focus, focus plus revealed, or every visible node, by the step's `frame`. */
  frame: NodeId[];
  /** Canvas elements the step focuses (CNV-60): its own `elements` and the members of the frames among them. */
  elements: Set<string>;
  /**
   * Opacity of every other canvas element: 1 with `dim: 'none'`, 0 when the talk hides context (they are not drawn),
   * else `dimOpacity`.
   */
  elementContext: number;
  /** Canvas elements the camera frames with the nodes: the focused ones, or every element for frame 'map'. */
  frameElements: string[];
  resolved: ResolvedStep;
}

export interface StepViewOptions {
  /** For `build: 'each'`: how many of this step's revealed nodes have appeared so far. Default: all of them. */
  built?: number;
}

/**
 * The visible node set and per-node opacity at step `index` (spec 6.2, "Visible set and opacity at a step").
 * - `reveal: 'all'`: every node visible in the editor is visible.
 * - `reveal: 'progressive'` (default): all roots, plus focus and reveal of steps 0..index (each step's `hide` removes
 *   nodes, in step order), plus every ancestor of those. Skipped steps other than `index` contribute nothing.
 *   Jumping to a step computes the same set as walking to it.
 * - Focus and what this step reveals are at 1. With `dim: 'others'` (default) ancestors of the focus are at 0.6 and
 *   every other visible node at `dimOpacity`; with `dim: 'none'` everything is at 1. With `context: 'hide'` only the
 *   focus, this step's reveals and the focus ancestors are visible.
 */
export function stepView(doc: Doc, presentation: Presentation, index: number, options: StepViewOptions = {}): StepView {
  const steps = presentation.steps;
  const at = Math.max(0, Math.min(steps.length - 1, index));
  const empty: PresentationStep = { id: '', focus: [] };
  const present = elementIds(doc);
  const resolved = resolveWith(doc, steps[at] ?? empty, present);
  const step = resolved.step;
  const revealedNow = step.build === 'each' && options.built !== undefined
    ? resolved.reveal.slice(0, Math.max(0, options.built)) : resolved.reveal;
  const shown = (id: NodeId) => shownInEditor(doc, id);

  let base: Set<NodeId>;
  if (presentation.reveal === 'all') {
    base = new Set(Object.keys(doc.nodes).filter(shown));
  } else {
    base = new Set(doc.roots.filter((r) => doc.nodes[r]));
    for (let k = 0; k <= at && k < steps.length; k++) {
      if (k !== at && steps[k].skip) continue;
      const r = k === at ? resolved : resolveWith(doc, steps[k], present);
      for (const id of r.focus) base.add(id);
      for (const id of k === at ? revealedNow : r.reveal) base.add(id);
      for (const id of r.hide) base.delete(id);
    }
    for (const id of [...base]) {
      if (!shown(id)) { base.delete(id); continue; }
      for (let p = doc.nodes[id].parent; p !== null && !base.has(p); p = doc.nodes[p].parent) base.add(p);
    }
  }

  const classes = new Map<NodeId, StepOpacityClass>();
  for (const id of [...resolved.focus, ...revealedNow]) if (shown(id)) classes.set(id, 'focus');
  for (const id of resolved.focus) {
    if (!shown(id)) continue;
    for (let p = doc.nodes[id].parent; p !== null; p = doc.nodes[p].parent) if (!classes.has(p)) classes.set(p, 'ancestor');
  }
  const hide = presentation.context === 'hide';
  const visible = hide ? new Set(classes.keys()) : base;
  for (const id of classes.keys()) visible.add(id);
  for (const id of visible) if (!classes.has(id)) classes.set(id, 'context');

  const dimOff = step.dim === 'none';
  const dim = presentation.dimOpacity ?? DEFAULT_DIM_OPACITY;
  const opacity = new Map<NodeId, number>();
  for (const [id, c] of classes) opacity.set(id, dimOff || c === 'focus' ? 1 : c === 'ancestor' ? ANCESTOR_OPACITY : dim);

  const frameKind = step.frame ?? 'subtree';
  const frame = frameKind === 'map' ? [...visible]
    : frameKind === 'nodes' ? resolved.focus.filter(shown)
    : [...resolved.focus, ...revealedNow].filter(shown);
  const all = doc.canvas?.elements ?? [];
  const elements = new Set(resolved.elements);
  if (elements.size) {
    // A focused frame brings its members.
    for (const el of all) if (el.frame && elements.has(el.frame)) elements.add(el.id);
  }
  const elementContext = dimOff ? 1 : hide ? 0 : dim;
  const frameElements = frameKind === 'map' ? all.filter((el) => elementContext > 0 || elements.has(el.id)).map((el) => el.id)
    : [...elements];
  return { visible, classes, opacity, frame, elements, elementContext, frameElements, resolved };
}

// ---------------------------------------------------------------- canvas elements in a step (CNV-60)

/** World bounds of an element, its rotation included; a frame's bounds include its name above it. */
export function elementBounds(el: CanvasElement): Rect {
  const w = Math.abs(el.w), h = Math.abs(el.h), angle = el.angle ?? 0;
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const rw = w * c + h * s, rh = w * s + h * c;
  const box = { x: el.x + w / 2 - rw / 2, y: el.y + h / 2 - rh / 2, w: rw, h: rh };
  if (el.kind !== 'frame' || !el.text?.trim()) return box;
  const name = (el.fontSize ?? 14) * 1.25 + 8;
  return { ...box, y: box.y - name, h: box.h + name };
}

/** Union of the bounds of the given elements, or null when none of them exists. */
export function elementsBounds(doc: Doc, ids: Iterable<string>): Rect | null {
  const wanted = new Set(ids);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const el of doc.canvas?.elements ?? []) {
    if (!wanted.has(el.id)) continue;
    const b = elementBounds(el);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return x1 >= x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Nodes whose centre lies inside one of the focused frames: a map drawn in a frame is part of what the frame shows. */
export function nodesInFocusedFrames(doc: Doc, view: Pick<StepView, 'elements'>, boxes: ReadonlyMap<NodeId, NodeBox>): NodeId[] {
  const frames = (doc.canvas?.elements ?? []).filter((el) => el.kind === 'frame' && view.elements.has(el.id));
  if (!frames.length) return [];
  const out: NodeId[] = [];
  for (const [id, box] of boxes) {
    for (const f of frames) {
      const w = Math.abs(f.w), h = Math.abs(f.h), angle = f.angle ?? 0;
      const dx = box.x - (f.x + w / 2), dy = box.y - (f.y + h / 2);
      const c = Math.cos(-angle), s = Math.sin(-angle);
      if (Math.abs(dx * c - dy * s) <= w / 2 && Math.abs(dx * s + dy * c) <= h / 2) {
        out.push(id);
        break;
      }
    }
  }
  return out;
}

/**
 * "Add frames as steps" (CNV-60): one step per frame in reading order. Frames are grouped into rows (a frame joins the
 * row when its top lies above the middle of the row's first frame), rows run top to bottom and each row left to right.
 */
export function framesAsSteps(doc: Doc): PresentationStep[] {
  const frames = (doc.canvas?.elements ?? []).filter((el) => el.kind === 'frame')
    .map((el) => ({ el, b: elementBounds(el) }))
    .sort((a, b) => a.b.y - b.b.y || a.b.x - b.b.x);
  const rows: (typeof frames)[] = [];
  for (const f of frames) {
    const row = rows.at(-1);
    if (row && f.b.y < row[0].b.y + row[0].b.h / 2) row.push(f);
    else rows.push([f]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.b.x - b.b.x)).map(({ el }) => ({ id: newId(), focus: [], elements: [el.id] }));
}

// ---------------------------------------------------------------- commands (each returns one undoable transaction)

function tx(label: string, op: Transaction['ops'][number]): Transaction {
  return { label, source: 'user', ops: [op] };
}

function find(doc: Doc, id: string): { presentation: Presentation; index: number } | null {
  const index = doc.presentations?.findIndex((p) => p.id === id) ?? -1;
  return index >= 0 ? { presentation: doc.presentations![index], index } : null;
}

function replace(doc: Doc, id: string, label: string, change: (p: Presentation) => Presentation | null): Transaction | null {
  const found = find(doc, id);
  if (!found) return null;
  const next = change(cloneValue(found.presentation));
  return next ? tx(label, { t: 'presentation', id, value: next }) : null;
}

/** Give steps that collide with an earlier id (or have none) a fresh id. */
function uniqueSteps(steps: readonly PresentationStep[], taken = new Set<string>()): PresentationStep[] {
  return steps.map((s) => {
    const step = cloneValue(s);
    if (!step.id || taken.has(step.id)) step.id = newId();
    taken.add(step.id);
    return step;
  });
}

/** A step that focuses the given nodes ("Add step from selection"). */
export function stepFromSelection(ids: readonly NodeId[]): PresentationStep {
  return { id: newId(), focus: [...new Set(ids)] };
}

/** Create a presentation at the end of the list (or at `index`). Pass `id` to know it in advance. */
export function createPresentation(doc: Doc, name: string, steps: readonly PresentationStep[] = [], id: string = newId(),
    index?: number): Transaction | null {
  if (find(doc, id)) return null;
  const value: Presentation = { id, name: name.trim() || 'Presentation', steps: uniqueSteps(steps) };
  return tx('New Presentation', { t: 'presentation', id, value, ...(index === undefined ? {} : { index }) });
}

export function renamePresentation(doc: Doc, id: string, name: string): Transaction | null {
  const clean = name.trim();
  return replace(doc, id, 'Rename Presentation', (p) => (!clean || p.name === clean ? null : { ...p, name: clean }));
}

/** Change presentation-wide options (reveal, context, dimOpacity, motion, targetMinutes). Undefined clears a key. */
export function setPresentationOptions(doc: Doc, id: string,
    patch: Partial<Omit<Presentation, 'id' | 'name' | 'steps'>>): Transaction | null {
  return replace(doc, id, 'Change Presentation', (p) => {
    const next = { ...p, ...patch } as Record<string, unknown>;
    for (const key of Object.keys(patch)) if (next[key] === undefined) delete next[key];
    return JSON.stringify(next) === JSON.stringify(p) ? null : next as unknown as Presentation;
  });
}

/** Copy a presentation directly after the original. */
export function duplicatePresentation(doc: Doc, id: string, newPresentationId: string = newId(), name?: string): Transaction | null {
  const found = find(doc, id);
  if (!found || find(doc, newPresentationId)) return null;
  const value = { ...cloneValue(found.presentation), id: newPresentationId, name: name ?? found.presentation.name + ' copy' };
  return tx('Duplicate Presentation', { t: 'presentation', id: newPresentationId, value, index: found.index + 1 });
}

export function deletePresentation(doc: Doc, id: string): Transaction | null {
  return find(doc, id) ? tx('Delete Presentation', { t: 'presentation', id }) : null;
}

/** Move a presentation to `index` in the list. */
export function movePresentation(doc: Doc, id: string, index: number): Transaction | null {
  const found = find(doc, id);
  if (!found) return null;
  const to = Math.max(0, Math.min(doc.presentations!.length - 1, index));
  return to === found.index ? null
    : tx('Reorder Presentations', { t: 'presentation', id, value: cloneValue(found.presentation), index: to });
}

/** Insert steps at `index` (default: the end). Colliding step ids are replaced. */
export function addSteps(doc: Doc, id: string, steps: readonly PresentationStep[], index?: number): Transaction | null {
  if (!steps.length) return null;
  return replace(doc, id, steps.length > 1 ? 'Add Steps' : 'Add Step', (p) => {
    const added = uniqueSteps(steps, new Set(p.steps.map((s) => s.id)));
    const at = Math.max(0, Math.min(p.steps.length, index ?? p.steps.length));
    p.steps.splice(at, 0, ...added);
    return p;
  });
}

/** Replace every step, e.g. with {@link autoTour} output ("Generate steps"). */
export function setSteps(doc: Doc, id: string, steps: readonly PresentationStep[], label = 'Generate Steps'): Transaction | null {
  return replace(doc, id, label, (p) => ({ ...p, steps: uniqueSteps(steps) }));
}

export function deleteSteps(doc: Doc, id: string, stepIds: readonly string[]): Transaction | null {
  const gone = new Set(stepIds);
  return replace(doc, id, gone.size > 1 ? 'Delete Steps' : 'Delete Step', (p) => {
    const steps = p.steps.filter((s) => !gone.has(s.id));
    return steps.length === p.steps.length ? null : { ...p, steps };
  });
}

/** Move one step to `index` (its position after removal, clamped), as a drag in the step list does. */
export function moveStep(doc: Doc, id: string, stepId: string, index: number): Transaction | null {
  return replace(doc, id, 'Reorder Steps', (p) => {
    const from = p.steps.findIndex((s) => s.id === stepId);
    if (from < 0) return null;
    const [step] = p.steps.splice(from, 1);
    const to = Math.max(0, Math.min(p.steps.length, index));
    if (to === from) return null;
    p.steps.splice(to, 0, step);
    return p;
  });
}

/** Edit one step. Undefined values clear optional keys; `id` cannot change. */
export function updateStep(doc: Doc, id: string, stepId: string, patch: Partial<Omit<PresentationStep, 'id'>>): Transaction | null {
  return replace(doc, id, 'Edit Step', (p) => {
    const at = p.steps.findIndex((s) => s.id === stepId);
    if (at < 0) return null;
    const next = { ...p.steps[at], ...cloneValue(patch) } as Record<string, unknown>;
    for (const key of Object.keys(patch)) if ((patch as Record<string, unknown>)[key] === undefined) delete next[key];
    next.id = stepId;
    if (!Array.isArray(next.focus)) next.focus = [];
    if (JSON.stringify(next) === JSON.stringify(p.steps[at])) return null;
    p.steps[at] = next as unknown as PresentationStep;
    return p;
  });
}
