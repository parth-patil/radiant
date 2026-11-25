import type { Doc, MapNode, NodeId } from '../types';

export const SHARED_ALIAS_FIELDS = ['text', 'note', 'blankAnswer', 'task', 'tags', 'link'] as const;
export const validAliasGroup = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);

export function aliasPeers(doc: Doc, node: MapNode): MapNode[] {
  return node.aliasGroup ? Object.values(doc.nodes).filter((peer) => peer.id !== node.id && peer.aliasGroup === node.aliasGroup) : [];
}

/** A detached document retains only the relationships it contains. */
export function removeLoneAliasGroups(nodes: Record<NodeId, MapNode>): void {
  const groupCounts = new Map<string, number>();
  for (const node of Object.values(nodes)) {
    if (node.aliasGroup) groupCounts.set(node.aliasGroup, (groupCounts.get(node.aliasGroup) ?? 0) + 1);
  }
  for (const node of Object.values(nodes)) {
    if (node.aliasGroup && groupCounts.get(node.aliasGroup) === 1) delete node.aliasGroup;
  }
}
