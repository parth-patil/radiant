import { readableLabel } from '../core/model/markdown';
import { wordParts } from '../core/model/repeated-words';
import type { Doc, MapNode, NodeId } from '../core/types';

export type CanvasFilter =
  | { kind: 'tag' | 'word' | 'repeated'; value: string }
  | { kind: 'marker'; value: string }
  | { kind: 'task'; value: 'open' | 'done' };

export const DIM_OPACITY = 0.22;

export function nodeMarkers(node: MapNode): string[] {
  const icons = node.interchange?.freeMindIcons ?? [];
  return node.sticker ? [node.sticker, ...icons] : icons;
}

export function matchingCanvasNodes(doc: Doc, filter: CanvasFilter): Set<NodeId> {
  const target = filter.value.toLowerCase();
  const matches = new Set<NodeId>();
  for (const node of Object.values(doc.nodes)) {
    switch (filter.kind) {
      case 'repeated':
        if (node.parent && wordParts(readableLabel(node)).some(part => part.key === target)) matches.add(node.id);
        break;
      case 'marker':
        if (nodeMarkers(node).includes(filter.value)) matches.add(node.id);
        break;
      case 'tag':
        if (node.tags?.some((tag) => tag.toLowerCase() === target)) matches.add(node.id);
        break;
      case 'word':
        if (node.text.toLowerCase().includes(target) || node.note?.toLowerCase().includes(target)) matches.add(node.id);
        break;
      case 'task':
        if (node.task?.done === (filter.value === 'done')) matches.add(node.id);
        break;
    }
  }
  return matches;
}

export function canvasFilterLabel(filter: CanvasFilter): string {
  if (filter.kind === 'marker') return 'Marker ' + filter.value;
  if (filter.kind === 'tag') return `#${filter.value}`;
  if (filter.kind === 'task') return filter.value === 'done' ? 'Completed tasks' : 'Open tasks';
  return `“${filter.value}”`;
}
