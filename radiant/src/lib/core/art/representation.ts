import type { Doc, NodeId, Op, Representation } from '../types';

/** Nearest explicit representation wins. Older documents default to vector. */
export function effectiveRepresentation(doc: Doc, id: NodeId): Representation {
  let node = doc.nodes[id];
  while (node) {
    if (node.representation) return node.representation;
    if (node.parent === null) break;
    node = doc.nodes[node.parent];
  }
  return 'vector';
}

export function artSubtree(doc: Doc, root: NodeId, maxDepth = Infinity): Array<{ id: NodeId; depth: number; isLeaf: boolean }> {
  const result: Array<{ id: NodeId; depth: number; isLeaf: boolean }> = [];
  const stack = [{ id: root, depth: 0 }];
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    const node = doc.nodes[id];
    if (!node || (id !== root && node.representation !== undefined)) continue;
    const children = depth >= maxDepth ? [] : node.children.filter((child) => doc.nodes[child]?.representation === undefined);
    result.push({ id, depth, isLeaf: children.length === 0 });
    for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i], depth: depth + 1 });
  }
  return result;
}

/** Change only the selected scope and preserve representation beyond its boundary. */
export function setArtRepresentation(doc: Doc, root: NodeId, mode: Representation, maxDepth = Infinity): Extract<Op, { t: 'set' }>[] {
  if (!doc.nodes[root]) return [];
  const ops: Extract<Op, { t: 'set' }>[] = [];
  const previous = effectiveRepresentation(doc, root);
  if (previous !== mode && Number.isFinite(maxDepth)) {
    for (const target of artSubtree(doc, root, maxDepth)) {
      if (target.depth !== maxDepth) continue;
      for (const id of doc.nodes[target.id].children) {
        if (doc.nodes[id]?.representation === undefined) ops.push({ t: 'set', id, patch: { representation: previous } });
      }
    }
  }
  if (doc.nodes[root].representation !== mode) ops.push({ t: 'set', id: root, patch: { representation: mode } });
  return ops;
}
