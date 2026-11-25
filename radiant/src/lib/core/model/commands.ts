import { removeLoneAliasGroups } from './aliases';
import type {
  Doc,
  MapNode,
  NodeId,
  NodeStyle,
  Op,
  OutlineNode,
  RootInfo,
  Transaction,
  Vec2
} from '../types';
import { cloneDoc } from './doc';
import { applyOps } from './ops';
import { newId } from './ids';
import { cloneValue } from './doc';
import { releaseTargets } from './canvas';

// ====================================================================== navigation helpers

/** Parent id of a node, or null for roots (and unknown ids). */
export function parentOf(doc: Doc, id: NodeId): NodeId | null {
  return doc.nodes[id]?.parent ?? null;
}

/** First child, or null. */
export function firstChild(doc: Doc, id: NodeId): NodeId | null {
  const c = doc.nodes[id]?.children;
  return c && c.length ? c[0] : null;
}

/** Next sibling in the parent's child list (roots: next root in z-order), or null. */
export function nextSibling(doc: Doc, id: NodeId): NodeId | null {
  const sib = siblingsOf(doc, id);
  if (!sib) return null;
  const i = sib.indexOf(id);
  return i >= 0 && i + 1 < sib.length ? sib[i + 1] : null;
}

/** Previous sibling, or null. */
export function prevSibling(doc: Doc, id: NodeId): NodeId | null {
  const sib = siblingsOf(doc, id);
  if (!sib) return null;
  const i = sib.indexOf(id);
  return i > 0 ? sib[i - 1] : null;
}

/** Children that are shown: empty when the node is collapsed. */
export function visibleChildren(doc: Doc, id: NodeId): readonly NodeId[] {
  const n = doc.nodes[id];
  return n && !n.collapsed ? n.children : [];
}

/** True if `anc` is a strict ancestor of `id`. O(depth). */
export function isAncestor(doc: Doc, anc: NodeId, id: NodeId): boolean {
  for (let p = doc.nodes[id]?.parent ?? null; p !== null; p = doc.nodes[p].parent) if (p === anc) return true;
  return false;
}

/** Ids of the subtree rooted at `id` in pre-order (the node itself first). */
export function subtreeIds(doc: Doc, id: NodeId): NodeId[] {
  const out: NodeId[] = [];
  if (!doc.nodes[id]) return out;
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop() as NodeId;
    out.push(cur);
    const ch = doc.nodes[cur].children;
    for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
  }
  return out;
}

/** Depth of a node: 0 for roots. */
export function depthOf(doc: Doc, id: NodeId): number {
  let d = 0;
  for (let p = doc.nodes[id]?.parent ?? null; p !== null; p = doc.nodes[p].parent) d++;
  return d;
}

/** The root (main or floating node) whose tree contains `id`. */
export function rootOf(doc: Doc, id: NodeId): NodeId {
  let cur = id;
  for (let p = doc.nodes[cur]?.parent ?? null; p !== null; p = doc.nodes[cur].parent) cur = p;
  return cur;
}

/**
 * Index of the depth-1 ancestor (the main branch) among its root's children; -1 for roots.
 * A depth-1 node returns its own index.
 */
export function mainBranchIndex(doc: Doc, id: NodeId): number {
  let cur = doc.nodes[id];
  if (!cur || cur.parent === null) return -1;
  while (cur.parent !== null && doc.nodes[cur.parent].parent !== null) cur = doc.nodes[cur.parent];
  return doc.nodes[cur.parent as NodeId].children.indexOf(cur.id);
}

function siblingsOf(doc: Doc, id: NodeId): readonly NodeId[] | null {
  const n = doc.nodes[id];
  if (!n) return null;
  return n.parent === null ? doc.roots : doc.nodes[n.parent].children;
}

// ====================================================================== command results

/** Result of an editing command: the transaction to apply and where the UI should put focus afterwards. */
export interface Edit {
  tx: Transaction;
  /** Node to focus/select after applying (null: clear selection). Undefined: leave selection alone. */
  focus?: NodeId | null;
  /** Ids of newly created top-level nodes (insertOutline, duplicateSubtree, addChild...). */
  created?: NodeId[];
}

type Source = Transaction['source'];

function edit(label: string, ops: Op[], source: Source = 'user', extra?: Omit<Edit, 'tx'>): Edit | null {
  if (ops.length === 0) return null;
  return { tx: { ops, label, source }, ...extra };
}

function makeNode(text: string, parent: NodeId | null, source: Source): MapNode {
  return {
    id: newId(),
    parent,
    children: [],
    text,
    origin: source === 'user' ? { by: 'user' } : { by: 'ai', job: source.ai }
  };
}

/** Op that expands a collapsed node, or nothing. */
function expandOp(doc: Doc, id: NodeId): Op[] {
  return doc.nodes[id]?.collapsed ? [{ t: 'set', id, patch: { collapsed: undefined } }] : [];
}

// ====================================================================== structural commands

/** Add a child under `parent` (expanding it if collapsed). `index` defaults to the end. Focus = new node. */
export function addChild(doc: Doc, parent: NodeId, text = '', index?: number, source: Source = 'user'): Edit | null {
  const p = doc.nodes[parent];
  if (!p) return null;
  const node = makeNode(text, parent, source);
  const ops: Op[] = [
    ...expandOp(doc, parent),
    { t: 'insert', node, parent, index: index ?? p.children.length }
  ];
  return edit('Add Child', ops, source, { focus: node.id, created: [node.id] });
}

/**
 * Add a sibling after (default) or before `id`. For a root this inserts a new main node.
 * The sibling inherits `side`, so it stays on the same side of a mindmap root.
 */
export function addSibling(doc: Doc, id: NodeId, after = true, rootPosition?: Vec2): Edit | null {
  const n = doc.nodes[id];
  if (!n) return null;
  if (n.parent === null) {
    const current = doc.rootInfo[id];
    const node = makeNode('', null, 'user');
    const position = rootPosition ?? {x:current.position.x + 380, y:current.position.y};
    const index = doc.roots.indexOf(id) + Number(after);
    return edit('Add Main Node', [{t:'insert', node, parent:null, index, rootInfo:{layout:current.layout, position}}],
      'user', {focus:node.id, created:[node.id]});
  }
  const idx = doc.nodes[n.parent].children.indexOf(id);
  const node = makeNode('', n.parent, 'user');
  if (n.side) node.side = n.side;
  return edit('Add Sibling', [{ t: 'insert', node, parent: n.parent, index: after ? idx + 1 : idx }], 'user', {
    focus: node.id,
    created: [node.id]
  });
}

/** Insert a new node between `id` and its parent (the new node takes `id`'s place). Not available for roots. */
export function addParent(doc: Doc, id: NodeId): Edit | null {
  const n = doc.nodes[id];
  if (!n || n.parent === null) return null;
  const idx = doc.nodes[n.parent].children.indexOf(id);
  const node = makeNode('', n.parent, 'user');
  if (n.side) node.side = n.side;
  return edit(
    'Add Parent',
    [
      { t: 'insert', node, parent: n.parent, index: idx },
      { t: 'move', id, parent: node.id, index: 0 }
    ],
    'user',
    { focus: node.id, created: [node.id] }
  );
}

/**
 * Delete the subtrees of `ids` (descendants of other listed ids are folded in; the last remaining root cannot
 * be deleted). Cross-links touching deleted nodes are removed too. Focus = next sibling, else previous sibling,
 * else parent of the first deleted node.
 */
export function deleteSubtree(doc: Doc, ids: readonly NodeId[]): Edit | null {
  const want = new Set(ids.filter((i) => doc.nodes[i]));
  const tops: NodeId[] = [];
  let rootsLeft = doc.roots.length;
  for (const id of want) {
    let covered = false;
    for (let p = doc.nodes[id].parent; p !== null; p = doc.nodes[p].parent) {
      if (want.has(p)) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    if (doc.nodes[id].parent === null) {
      if (rootsLeft <= 1) continue;
      rootsLeft--;
    }
    tops.push(id);
  }
  if (tops.length === 0) return null;

  const gone = new Set<NodeId>();
  const ops: Op[] = [];
  const post: NodeId[] = [];
  for (const top of tops) {
    // Post-order: children before parents.
    const stack: Array<[NodeId, boolean]> = [[top, false]];
    while (stack.length) {
      const [id, expanded] = stack.pop() as [NodeId, boolean];
      if (expanded) {
        post.push(id);
        continue;
      }
      gone.add(id);
      stack.push([id, true]);
      const ch = doc.nodes[id].children;
      for (let i = ch.length - 1; i >= 0; i--) stack.push([ch[i], false]);
    }
  }
  for (const l of doc.links) if (gone.has(l.from) || gone.has(l.to)) ops.push({ t: 'unlink', id: l.id });
  // Canvas arrows bound to deleted nodes keep their stored end points, unbound (CNV-36).
  if (doc.canvas) ops.push(...releaseTargets(doc, gone, 'node'));
  for (const id of post) ops.push({ t: 'remove', id });

  const first = tops[0];
  const focus = selectionAfterDelete(doc, first, gone);
  return edit(tops.length > 1 || post.length > 1 ? 'Delete Nodes' : 'Delete Node', ops, 'user', { focus });
}

/** Remove only selected nodes, promoting their children into the vacated slots in order. */
export function deleteAndPromote(doc: Doc, ids: readonly NodeId[], positionOf: (id: NodeId) => Vec2 | undefined): Edit | null {
  const draft = cloneDoc(doc);
  const ops: Op[] = [];
  let focus: NodeId | null = null;
  for (const id of new Set(ids)) {
    const node = draft.nodes[id];
    if (!node || (node.parent === null && draft.roots.length === 1 && !node.children.length)) continue;
    const index = siblingsOf(draft, id)!.indexOf(id);
    const batch: Op[] = [];
    for (const [offset, child] of node.children.entries()) {
      const root = draft.rootInfo[id];
      const rootInfo = node.parent === null ? {
        layout:root.layout, position:positionOf(child) ?? {x:root.position.x, y:root.position.y + offset * 120}
      } : undefined;
      batch.push({t:'move', id:child, parent:node.parent, index:index + offset, rootInfo});
    }
    for (const link of draft.links) if (link.from === id || link.to === id) batch.push({t:'unlink', id:link.id});
    if (draft.canvas) batch.push(...releaseTargets(draft, new Set([id]), 'node'));
    if (!focus || focus === id) focus = node.children[0] ?? selectionAfterDelete(draft, id, new Set([id]));
    batch.push({t:'remove', id});
    applyOps(draft, batch);
    ops.push(...batch);
  }
  return ops.length ? edit('Delete and Promote Children', ops, 'user', {focus: focus && draft.nodes[focus] ? focus : draft.roots[0]}) : null;
}

function selectionAfterDelete(doc: Doc, id: NodeId, gone: Set<NodeId>): NodeId | null {
  const sib = siblingsOf(doc, id) as readonly NodeId[];
  const i = sib.indexOf(id);
  for (let k = i + 1; k < sib.length; k++) if (!gone.has(sib[k])) return sib[k];
  for (let k = i - 1; k >= 0; k--) if (!gone.has(sib[k])) return sib[k];
  return doc.nodes[id].parent;
}

/**
 * Move `id` (with its subtree) under `newParent` at `index` (position among the parent's children after the node
 * has been taken out of its old place; clamped). Returns null when `newParent` is `id` or inside its subtree.
 */
export function moveSubtree(doc: Doc, id: NodeId, newParent: NodeId, index: number): Edit | null {
  const n = doc.nodes[id];
  if (!n || !doc.nodes[newParent]) return null;
  if (id === newParent || isAncestor(doc, id, newParent)) return null;
  const ops: Op[] = [...expandOp(doc, newParent), { t: 'move', id, parent: newParent, index }];
  // A node that leaves its old side-assignment should let the layout decide again.
  if (n.parent !== newParent && n.side) ops.push({ t: 'set', id, patch: { side: undefined } });
  return edit('Move Node', ops, 'user', { focus: id });
}

/** Move a node `delta` places among its siblings (negative = earlier). Null if it cannot move. */
export function reorder(doc: Doc, id: NodeId, delta: number): Edit | null {
  const n = doc.nodes[id];
  if (!n || n.parent === null) return null;
  const sib = doc.nodes[n.parent].children;
  const i = sib.indexOf(id);
  const j = Math.max(0, Math.min(sib.length - 1, i + delta));
  if (i === j) return null;
  return edit('Reorder Node', [{ t: 'move', id, parent: n.parent, index: j }], 'user', { focus: id });
}

/** Detach a node into a floating root at a world position. If it already is a root, just moves it. */
export function detach(doc: Doc, id: NodeId, position: Vec2): Edit | null {
  const n = doc.nodes[id];
  if (!n) return null;
  const previous = n.parent === null ? doc.rootInfo[id] : undefined;
  const info: RootInfo = { ...(previous ?? { layout: 'mindmap' }), position: { ...position } };
  if (n.parent === null) return edit('Move Root', [{ t: 'setRoot', id, info }], 'user', { focus: id });
  const ops: Op[] = [{ t: 'move', id, parent: null, index: doc.roots.length, rootInfo: info }];
  const clear: Partial<MapNode> = {};
  if (n.offset) clear.offset = undefined;
  if (n.pinnedPosition) clear.pinnedPosition = undefined;
  if (n.side) clear.side = undefined;
  if (Object.keys(clear).length) ops.push({ t: 'set', id, patch: clear });
  return edit('Detach Node', ops, 'user', { focus: id });
}

// ====================================================================== field commands

/** Change a node's text. Null if unchanged. */
export function setText(doc: Doc, id: NodeId, text: string): Edit | null {
  const n = doc.nodes[id];
  if (!n || n.text === text) return null;
  return edit('Edit Text', [{ t: 'set', id, patch: { text } }]);
}

/** Set or clear (empty string) a node's note. */
export function setNote(doc: Doc, id: NodeId, note: string): Edit | null {
  const n = doc.nodes[id];
  const next = note === '' ? undefined : note;
  if (!n || n.note === next) return null;
  return edit('Edit Note', [{ t: 'set', id, patch: { note: next } }]);
}

/** Collapse or expand nodes. With `collapsed` omitted each node is toggled. Leaves are skipped. */
export function toggleCollapsed(doc: Doc, ids: readonly NodeId[], collapsed?: boolean): Edit | null {
  const ops: Op[] = [];
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    const target = collapsed ?? !n.collapsed;
    if (target === !!n.collapsed) continue;
    if (target && n.children.length === 0) continue;
    ops.push({ t: 'set', id, patch: { collapsed: target ? true : undefined } });
  }
  return edit(collapsed === false ? 'Expand' : collapsed ? 'Collapse' : 'Toggle Collapse', ops);
}

/** Reveal one currently hidden generation along every visible path. */
export function unfoldOneLevel(doc: Doc, start: NodeId): Edit | null {
  const ops: Op[] = [];
  const pending = [start];
  while (pending.length) {
    const id = pending.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    if (!node.collapsed) {
      for (const child of node.children) pending.push(child);
      continue;
    }
    ops.push({t:'set',id,patch:{collapsed:undefined}});
    for (const child of node.children) {
      if (doc.nodes[child].children.length && !doc.nodes[child].collapsed)
        ops.push({t:'set',id:child,patch:{collapsed:true}});
    }
  }
  return edit('Unfold One Level',ops);
}

/** Expand every collapsed node in the tree below (and including) `rootId`. */
export function expandAll(doc: Doc, rootId: NodeId): Edit | null {
  const ops: Op[] = [];
  for (const id of subtreeIds(doc, rootId)) {
    if (doc.nodes[id].collapsed) ops.push({ t: 'set', id, patch: { collapsed: undefined } });
  }
  return edit('Expand All', ops);
}

/**
 * Show `depth` levels below `rootId` (0 = only the node itself): nodes at relative depth >= `depth` that have
 * children become collapsed, shallower ones are expanded.
 */
export function collapseToDepth(doc: Doc, rootId: NodeId, depth: number): Edit | null {
  if (!doc.nodes[rootId]) return null;
  const ops: Op[] = [];
  const stack: Array<[NodeId, number]> = [[rootId, 0]];
  while (stack.length) {
    const [id, d] = stack.pop() as [NodeId, number];
    const n = doc.nodes[id];
    const want = d >= depth && n.children.length > 0;
    if (want !== !!n.collapsed) ops.push({ t: 'set', id, patch: { collapsed: want ? true : undefined } });
    for (const c of n.children) stack.push([c, d + 1]);
  }
  return edit('Collapse to Level', ops);
}

/** Merge a style patch into each node's style. A key set to `undefined` removes that override. */
export function setStyle(doc: Doc, ids: readonly NodeId[], patch: Partial<NodeStyle>): Edit | null {
  const ops: Op[] = [];
  for (const id of ids) {
    const n = doc.nodes[id];
    if (!n) continue;
    const merged: Record<string, unknown> = { ...(n.style ?? {}) };
    let changed = false;
    for (const k of Object.keys(patch)) {
      const v = (patch as Record<string, unknown>)[k];
      if (merged[k] === v) continue;
      changed = true;
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    if (!changed) continue;
    ops.push({ t: 'set', id, patch: { style: Object.keys(merged).length ? (merged as NodeStyle) : undefined } });
  }
  return edit('Change Style', ops);
}

/** Pin a main branch to the left or right of its root (undefined: let the layout decide). */
export function setSide(doc: Doc, id: NodeId, side: 'left' | 'right' | undefined): Edit | null {
  const n = doc.nodes[id];
  if (!n || n.side === side) return null;
  return edit('Change Side', [{ t: 'set', id, patch: { side } }]);
}

/** Set the manual offset of a node from its automatic position. */
export function setOffset(doc: Doc, id: NodeId, offset: Vec2): Edit | null {
  const n = doc.nodes[id];
  if (!n || (n.offset && n.offset.x === offset.x && n.offset.y === offset.y)) return null;
  return edit('Move Node', [{ t: 'set', id, patch: { offset: { x: offset.x, y: offset.y } } }]);
}

/** Remove the manual offsets of the given nodes (back to the automatic position). */
export function clearOffset(doc: Doc, ids: readonly NodeId[]): Edit | null {
  const ops: Op[] = [];
  for (const id of ids) if (doc.nodes[id]?.offset) ops.push({ t: 'set', id, patch: { offset: undefined } });
  return edit('Reset Position', ops);
}

// ====================================================================== cross-links

/** Add a cross-link. Null for self-links, unknown nodes, or if the same pair is already linked. */
export function addLink(doc: Doc, from: NodeId, to: NodeId, label?: string): Edit | null {
  if (from === to || !doc.nodes[from] || !doc.nodes[to]) return null;
  if (doc.links.some((l) => l.from === from && l.to === to)) return null;
  const link = label ? { id: newId(), from, to, label } : { id: newId(), from, to };
  return edit('Add Link', [{ t: 'link', link }]);
}

/** Remove a cross-link by id. */
export function removeLink(doc: Doc, linkId: string): Edit | null {
  if (!doc.links.some((l) => l.id === linkId)) return null;
  return edit('Remove Link', [{ t: 'unlink', id: linkId }]);
}

// ====================================================================== bulk insertion

/**
 * Insert outline trees as children of `parent` starting at `index` (default: end).
 * Used for paste and AI. Focus = first inserted node; `created` lists the inserted top-level ids.
 */
export function insertOutline(
  doc: Doc,
  parent: NodeId,
  nodes: readonly OutlineNode[],
  index?: number,
  source: Source = 'user'
): Edit | null {
  const p = doc.nodes[parent];
  if (!p || nodes.length === 0) return null;
  const ops: Op[] = expandOp(doc, parent);
  const created: NodeId[] = [];
  let at = index ?? p.children.length;
  for (const o of nodes) created.push(outlineInsertOps(o, parent, at++, source, ops));
  return edit('Insert Outline', ops, source, { focus: created[0], created });
}

/** Append insert ops for an outline node and its descendants (pre-order); returns the new node's id. */
export function outlineInsertOps(o: OutlineNode, parent: NodeId | null, index: number, source: Source, out: Op[], rootInfo?: RootInfo): NodeId {
  const fromOutline = (item: OutlineNode, pid: NodeId | null): MapNode => {
    const node = makeNode(item.text, pid, source);
    if (item.note) node.note = item.note;
    if (item.collapsed) node.collapsed = true;
    if (item.link) node.link = item.link;
    if (item.interchange) node.interchange = cloneValue(item.interchange);
    return node;
  };
  const node = fromOutline(o, parent);
  const op: Op = { t: 'insert', node, parent, index };
  if (rootInfo) op.rootInfo = rootInfo;
  out.push(op);
  // Iterative pre-order to survive very deep outlines.
  const stack: Array<[OutlineNode, NodeId, number]> = [];
  for (let i = o.children.length - 1; i >= 0; i--) stack.push([o.children[i], node.id, i]);
  while (stack.length) {
    const [c, pid, idx] = stack.pop() as [OutlineNode, NodeId, number];
    const cn = fromOutline(c, pid);
    out.push({ t: 'insert', node: cn, parent: pid, index: idx });
    for (let i = c.children.length - 1; i >= 0; i--) stack.push([c.children[i], cn.id, i]);
  }
  return node.id;
}

/**
 * Duplicate a subtree (new ids, same content) directly after the original. A duplicated root becomes a new
 * floating root offset by (40, 40). Cross-links are not copied. Focus = the copy.
 */
export function duplicateSubtree(doc: Doc, id: NodeId): Edit | null {
  const n = doc.nodes[id];
  if (!n) return null;
  const map = new Map<NodeId, NodeId>();
  const ops: Op[] = [];
  for (const old of subtreeIds(doc, id)) {
    const src = doc.nodes[old];
    const copy: MapNode = { ...src, id: newId(), children: [], parent: null };
    if (src.offset) copy.offset = { ...src.offset };
    if (src.style) copy.style = { ...src.style };
    if (src.tags) copy.tags = src.tags.slice();
    if (src.task) copy.task = { ...src.task };
    if (src.origin) copy.origin = { ...src.origin };
    map.set(old, copy.id);
    if (old === id) {
      if (n.parent === null) {
        const ri = doc.rootInfo[id];
        ops.push({
          t: 'insert',
          node: copy,
          parent: null,
          index: doc.roots.indexOf(id) + 1,
          rootInfo: { position: { x: ri.position.x + 40, y: ri.position.y + 40 }, layout: ri.layout }
        });
      } else {
        ops.push({ t: 'insert', node: copy, parent: n.parent, index: doc.nodes[n.parent].children.indexOf(id) + 1 });
      }
    } else {
      const pid = map.get(src.parent as NodeId) as NodeId;
      ops.push({ t: 'insert', node: copy, parent: pid, index: doc.nodes[src.parent as NodeId].children.indexOf(old) });
    }
  }
  const copies = Object.fromEntries(ops.flatMap(op => op.t === 'insert' ? [[op.node.id, op.node]] : []));
  removeLoneAliasGroups(copies);
  const aliasGroups = new Map<string, string>();
  for (const node of Object.values(copies)) {
    if (!node.aliasGroup) continue;
    const group = aliasGroups.get(node.aliasGroup) ?? newId();
    aliasGroups.set(node.aliasGroup, group);
    node.aliasGroup = group;
  }
  const rootCopy = map.get(id) as NodeId;
  return edit('Duplicate', ops, 'user', { focus: rootCopy, created: [rootCopy] });
}

/** Create one linked occurrence without copying the source subtree. */
export function createAlias(doc: Doc, id: NodeId, destination?: NodeId): Edit | null {
  const source = doc.nodes[id];
  if (!source || (destination && !doc.nodes[destination])) return null;
  const parent = destination ?? source.parent;
  const aliasGroup = source.aliasGroup ?? newId();
  const node: MapNode = {
    id: newId(), aliasGroup, parent, children: [], text: source.text,
    note: source.note, blankAnswer: source.blankAnswer, task: source.task, tags: source.tags,
    link: source.link, origin: { by: 'user' }
  };
  const siblings = parent ? doc.nodes[parent].children : doc.roots;
  const index = destination ? siblings.length : siblings.indexOf(id) + 1;
  const root = doc.rootInfo[id];
  const rootInfo = root && {
    layout: root.layout,
    position: { x: root.position.x + 280, y: root.position.y + 70 }
  };
  const ops: Op[] = [];
  if (!source.aliasGroup) ops.push({ t: 'set', id, patch: { aliasGroup } });
  if (destination && doc.nodes[destination].collapsed) ops.push({ t: 'set', id: destination, patch: { collapsed: false } });
  ops.push({ t: 'insert', node, parent, index, rootInfo: parent ? undefined : rootInfo });
  return edit('Create Alias', ops, 'user', { focus: node.id, created: [node.id] });
}
