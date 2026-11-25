import { createStyleResolver, parseColor } from '../geometry';
import { createDoc, newId } from '../model';
import type { CrossLink, Doc, LayoutResult, MapNode, NodeBox, NodeId, Theme } from '../types';

function facing(from: NodeBox, to: NodeBox): 'left' | 'right' | 'top' | 'bottom' {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) * from.h >= Math.abs(dy) * from.w) return dx < 0 ? 'left' : 'right';
  return dy < 0 ? 'top' : 'bottom';
}

function canvasColor(color: string): string {
  const { r, g, b } = parseColor(color);
  return '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

export function canvasCardText(node: MapNode): string {
  return [node.text, node.note, node.link].filter(Boolean).join('\n\n');
}

/** JSON Canvas 1.0 text cards and edges, using the map's world-space layout. */
export function toJsonCanvas(doc: Doc, layout: LayoutResult, theme: Theme): string {
  const { boxes } = layout;
  const styles = createStyleResolver(doc, theme);
  const nodes = [...boxes.values()].map(({ id, x, y, w, h, depth, mainBranch }) => {
    const node = doc.nodes[id];
    const color = canvasColor(styles.get(id, depth, mainBranch).color);
    return {
      id, type: 'text', x: Math.round(x - w / 2), y: Math.round(y - h / 2),
      width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)), color,
      text: canvasCardText(node)
    };
  });

  function edge(id: string, fromNode: NodeId, toNode: NodeId, link?: CrossLink) {
    const from = boxes.get(fromNode);
    const to = boxes.get(toNode);
    if (!from || !to) return [];
    return [{
      id, fromNode, toNode, fromSide: facing(from, to), toSide: facing(to, from),
      fromEnd: link?.arrows === 'both' || link?.arrows === 'start' ? 'arrow' : 'none',
      toEnd: link?.arrows === 'both' || link?.arrows === 'end' ? 'arrow' : 'none',
      label: link?.label, color: link?.color ? canvasColor(link.color) : undefined
    }];
  }

  const tree = nodes.flatMap(({ id }) => {
    const parent = doc.nodes[id].parent;
    return parent ? edge(`tree:${id}`, parent, id) : [];
  });
  const links = doc.links.flatMap((link) => edge(`link:${link.id}`, link.from, link.to, link));
  return JSON.stringify({ nodes, edges: [...tree, ...links] }, null, 2) + '\n';
}

interface CanvasCard {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  url?: string;
  file?: string;
  label?: string;
}

interface CanvasConnection {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
  color?: string;
  arrows: NonNullable<CrossLink['arrows']>;
}

const CARD_TYPES = new Set(['text', 'link', 'file', 'group']);
const COLORS = new Map(Object.entries({
  '1': '#d74646', '2': '#eb872e', '3': '#dca423',
  '4': '#229e72', '5': '#2f99b8', '6': '#885bd1'
}));
function importedColor(color: unknown): string | undefined {
  return typeof color === 'string' ? (/^#[a-f0-9]{6}$/i.test(color) ? color : COLORS.get(color)) : undefined;
}
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isCoordinate = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= 1e8;

function card(value: unknown): CanvasCard | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !value.id || typeof value.type !== 'string' || !CARD_TYPES.has(value.type)) return null;
  const { id, type, x, y, width, height } = value;
  if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height) || width <= 0 || height <= 0) return null;
  const out: CanvasCard = { id, type, x, y, width, height };
  for (const key of ['color', 'text', 'url', 'file', 'label'] as const) {
    const field = value[key];
    if (typeof field === 'string') out[key] = field;
  }
  return out;
}

function connection(value: unknown): CanvasConnection | null {
  if (!isRecord(value)) return null;
  const { id, fromNode, toNode, label } = value;
  if (typeof id !== 'string' || typeof fromNode !== 'string' || typeof toNode !== 'string' || fromNode === toNode) return null;
  const start = value.fromEnd === 'arrow';
  const end = value.toEnd === undefined || value.toEnd === 'arrow';
  return {
    id, fromNode, toNode, label: typeof label === 'string' ? label : undefined,
    color: importedColor(value.color), arrows: start ? (end ? 'both' : 'start') : (end ? 'end' : 'none')
  };
}

/** Imports generic cards as positioned roots and restores parentage for tree edges emitted by Radiant. */
export function parseJsonCanvas(text: string, title: string): { doc: Doc; skipped: string[] } {
  const input: unknown = JSON.parse(text);
  if (!isRecord(input) || !Array.isArray(input.nodes)) throw new Error('This file has no JSON Canvas node array.');
  const skipped = new Set<string>(['fixed card sizes', 'edge attachment sides']);
  const cards = new Map<string, CanvasCard>();
  for (const value of input.nodes) {
    const parsed = card(value);
    if (parsed && !cards.has(parsed.id)) cards.set(parsed.id, parsed);
    else skipped.add('invalid or duplicate cards');
  }
  if (!cards.size) throw new Error('This JSON Canvas has no readable cards.');

  const connections: CanvasConnection[] = [];
  const parents = new Map<string, CanvasConnection>();
  for (const value of Array.isArray(input.edges) ? input.edges : []) {
    const edge = connection(value);
    if (!edge || !cards.has(edge.fromNode) || !cards.has(edge.toNode)) {
      skipped.add('invalid connections');
      continue;
    }
    connections.push(edge);
    if (!parents.has(edge.toNode) && edge.id === `tree:${edge.toNode}`) parents.set(edge.toNode, edge);
  }

  // Make malformed tree cycles into cross-connections in one pass.
  const seen = new Set<string>();
  for (const id of cards.keys()) {
    const path = new Set<string>();
    let ancestor: string | undefined = id;
    while (ancestor && !seen.has(ancestor) && !path.has(ancestor)) {
      path.add(ancestor);
      ancestor = parents.get(ancestor)?.fromNode;
    }
    if (ancestor && path.has(ancestor)) {
      parents.delete(ancestor);
      skipped.add('cyclic tree edges treated as cross-connections');
    }
    for (const visited of path) seen.add(visited);
  }

  const doc = createDoc(title);
  doc.roots = [];
  doc.rootInfo = {};
  doc.nodes = {};
  const ids = new Map<string, NodeId>();
  for (const id of cards.keys()) ids.set(id, newId());

  for (const item of cards.values()) {
    const originalParent = parents.get(item.id)?.fromNode;
    const parent = originalParent ? ids.get(originalParent)! : null;
    const id = ids.get(item.id)!;
    const color = importedColor(item.color);
    const text = item.text ?? item.label ?? item.url ?? item.file ?? '';
    doc.nodes[id] = { id, text, parent, children: [], ...(color ? { style: { color, shape: 'box' } } : {}) };
    if (item.type === 'link' && item.url) doc.nodes[id].link = item.url;
    if (item.type === 'file') skipped.add('file attachments');
    if (item.type === 'group') skipped.add('group backgrounds and containment');
    if (!parent) {
      doc.roots.push(id);
      doc.rootInfo[id] = { position: { x: item.x + item.width / 2, y: item.y + item.height / 2 }, layout: 'mindmap' };
    }
  }
  for (const { id, parent } of Object.values(doc.nodes)) {
    if (parent) doc.nodes[parent].children.push(id);
  }
  for (const edge of connections) {
    if (parents.get(edge.toNode) !== edge) {
      doc.links.push({ id: newId(), from: ids.get(edge.fromNode)!, to: ids.get(edge.toNode)!, label: edge.label, color: edge.color, arrows: edge.arrows });
    }
  }
  if (parents.size) skipped.add('exact branch layout');
  return { doc, skipped: [...skipped] };
}
