import { removeLoneAliasGroups } from '../model/aliases';
import { referencedAiJobs } from '../model/ai-provenance';
import { detachArtworkRoot } from '../art/subtree-style';
import { cloneDoc, deleteSubtree, newId, rootOf, subtreeIds } from '../model';
import type { Doc, NodeId, Op } from '../types';

export interface MapLink {
  path: string;
  node?: NodeId;
}

function documentPath(path: string): boolean {
  return path.length <= 4096 && /\.radiant$/i.test(path) && !/[\x00-\x1f]/.test(path);
}

export function mapLink(path: string, node?: NodeId): string {
  if (!documentPath(path)) throw new Error('Choose a saved Radiant map.');
  const url = new URL('radiant://map');
  url.searchParams.set('path', path);
  if (node) url.searchParams.set('node', node);
  return url.href;
}

export function parseMapLink(value?: string): MapLink | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'radiant:' && url.host === 'map' && (url.pathname === '' || url.pathname === '/')) {
      const path = url.searchParams.get('path');
      const node = url.searchParams.get('node') || undefined;
      return path && documentPath(path) ? { path, node } : null;
    }
    if (url.protocol === 'file:' && !url.host) {
      const path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
      const node = new URLSearchParams(url.hash.slice(1)).get('node') || undefined;
      return documentPath(path) ? { path, node } : null;
    }
  } catch {
    // A plain URL or non-map file is handled by the generic node link opener.
  }
  return null;
}

/** Build the destination and source operations before saving either side of a linked branch. */
export function extractLinkedBranch(doc: Doc, id: NodeId, source: string, destination: string): { target: Doc; sourceOps: Op[] } {
  const branch = doc.nodes[id];
  if (!branch) throw new Error('Select a branch to move.');
  if (source === destination) throw new Error('Choose a different file for the new map.');
  const included = new Set(subtreeIds(doc, id));
  const target = cloneDoc(doc);
  target.id = newId();
  target.title = branch.text.trim() || 'Linked branch';
  target.created = target.modified = new Date().toISOString();
  target.roots = [id];
  target.rootInfo = {
    [id]: {
      position: { x: 0, y: 0 },
      layout: branch.branchLayout ?? doc.rootInfo[rootOf(doc, id)].layout
    }
  };
  detachArtworkRoot(target, id);
  target.nodes = Object.fromEntries(Object.entries(target.nodes).filter(([key]) => included.has(key)));
  removeLoneAliasGroups(target.nodes);
  target.links = target.links.filter(({ from, to }) => included.has(from) && included.has(to));
  target.layoutPlacements = undefined;
  target.aiJobs = referencedAiJobs(target.nodes, target.aiJobs);
  const root = target.nodes[id];
  delete root.offset;
  delete root.side;
  delete root.branchLayout;
  delete root.pinnedPosition;

  const backlink = newId();
  root.children.push(backlink);
  target.nodes[backlink] = {
    id: backlink, parent: id, children: [], text: `Back to ${doc.title}`,
    link: mapLink(source, id), representation: 'vector'
  };

  const sourceOps = deleteSubtree(doc, branch.children)?.tx.ops ?? [];
  const patch = {
    link: mapLink(destination, id), representation: 'vector' as const, collapsed: undefined,
    imageAsset: undefined, imageAspect: undefined, imageScale: undefined, imageAlt: undefined, pictureArt: undefined,
    svgArt: undefined, artReference: undefined, pictureLabelPlacement: undefined,
    note: undefined, blankAnswer: undefined, task: undefined, tags: undefined, interchange: undefined
  };
  if (branch.aliasGroup) sourceOps.push({ t: 'set', id, patch: { aliasGroup: undefined } });
  sourceOps.push({ t: 'set', id, patch });
  const removed = (key: NodeId) => key !== id && included.has(key);
  const pair = (from: NodeId, to: NodeId) => [from, to].sort().join('\x00');
  const existing = new Set(doc.links.filter(({ from, to }) => !removed(from) && !removed(to)).map(({ from, to }) => pair(from, to)));
  for (const link of doc.links) {
    if (included.has(link.from) === included.has(link.to) || (!removed(link.from) && !removed(link.to))) continue;
    const from = removed(link.from) ? id : link.from;
    const to = removed(link.to) ? id : link.to;
    const key = pair(from, to);
    if (!existing.has(key)) {
      existing.add(key);
      sourceOps.push({ t: 'link', link: { ...link, from, to, bend: undefined } });
    }
  }
  return { target, sourceOps };
}
