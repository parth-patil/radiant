import { createDoc, newId } from '../model';
import type { MapNode, NodeId, Vec2 } from '../types';
import { isAttachmentName, type MindNodeImport } from './mindnode-archive';
import { bytes, fields, integer, message, readProto, scalar, utf8, uuid, type ProtoField } from './protobuf';

const NODE_LIMIT = 50_000;

function richText(data: Uint8Array | undefined): string {
  // Each field 1 contains a text run. The run's value is a string in field 4.1.
  return fields(message(data), 1).map((run) => {
    const value = message(bytes(message(run), 4));
    return utf8(bytes(value, 1));
  }).join('').replace(/\u2028/g, '\n').trim();
}

function point(data: Uint8Array | undefined): Vec2 | undefined {
  const m = message(data);
  const x = scalar(m, 1);
  const y = scalar(m, 2);
  if (x !== undefined && y !== undefined && Math.max(Math.abs(x), Math.abs(y)) <= 1e7) return { x, y };
}

interface Relationship {
  id: string;
  parent?: string;
  children: string[];
}

function relationships(data: ProtoField[], known: Set<string>) {
  const records = new Map<string, Relationship>();
  for (const raw of fields(data, 2)) {
    const m = message(raw);
    const id = uuid(bytes(m, 1));
    if (!id || records.has(id)) throw new Error('Invalid MindNode Next node relationship index.');
    const parent = uuid(bytes(m, 2));
    const children = fields(m, 3).flatMap((value) => {
      const child = uuid(value);
      return child ? [child] : [];
    });
    records.set(id, { id, parent, children });
  }

  const order = new Map<string | undefined, string[]>();
  for (const relation of records.values()) {
    // Relationship records also include structural containers that have no canvas node.
    const parent = known.has(relation.id) ? relation.id : undefined;
    for (const id of relation.children) {
      const child = records.get(id);
      if (!known.has(id) || !child || child.parent !== relation.id) continue;
      const children = order.get(parent) ?? [];
      children.push(id);
      order.set(parent, children);
    }
  }
  const included = new Set([...order.values()].flat());
  for (const id of known) {
    if (included.has(id)) continue;
    const relation = records.get(id);
    const parent = relation?.parent && known.has(relation.parent) ? relation.parent : undefined;
    const children = order.get(parent) ?? [];
    children.push(id);
    order.set(parent, children);
  }
  return order;
}

function attachment(raw: Uint8Array, node: NodeId): MindNodeImport['attachments'][number] | undefined {
  const value = readProto(raw);
  const image = message(bytes(value, 2));
  const name = utf8(bytes(image, 1));
  if (isAttachmentName(name)) {
    const geometry = message(bytes(image, 3));
    const size = point(bytes(geometry, 1));
    return { node, name, entry: name, size };
  }
  const emoji = message(bytes(value, 4));
  const symbol = utf8(bytes(emoji, 1)).trim();
  if (symbol.length > 0 && symbol.length <= 64 && /\p{Extended_Pictographic}/u.test(symbol)) {
    return { node, name: symbol, symbol };
  }
}

/** Read the version-1 snapshot and its ordered node index, as observed in MindNode's public samples. */
export function parseMindNodeNext(content: Uint8Array, title: string): MindNodeImport {
  const envelope = readProto(content);
  const document = message(bytes(envelope, 1));
  const snapshot = message(bytes(message(bytes(document, 2)), 1));
  const id = uuid(bytes(document, 1));
  const graph = message(bytes(snapshot, 3));
  const payloads = fields(snapshot, 2);
  if (!id || uuid(bytes(graph, 1)) !== id || !payloads.length || payloads.length > NODE_LIMIT) {
    throw new Error('Cannot read this MindNode Next v1 document. Export it as MindNode Classic or OPML.');
  }

  const rawById = new Map<string, ProtoField[]>();
  for (const raw of payloads) {
    const entry = readProto(raw);
    const key = uuid(bytes(entry, 1));
    if (!key || rawById.has(key) || !bytes(entry, 2)) throw new Error('Invalid MindNode Next node index.');
    rawById.set(key, message(bytes(entry, 2)));
  }
  const order = relationships(graph, new Set(rawById.keys()));
  const doc = createDoc(title);
  doc.roots = [];
  doc.rootInfo = Object.create(null);
  doc.nodes = Object.create(null);
  const skipped = new Set<string>(['MindNode Next visual styles and manual branch positions']);
  const attachments: MindNodeImport['attachments'] = [];
  const pending = (order.get(undefined) ?? []).map((key) => ({ key, parent: null as NodeId | null, depth: 0 })).reverse();
  const visited = new Set<string>();
  while (pending.length) {
    const { key, parent, depth } = pending.pop()!;
    if (visited.has(key) || depth > 500) throw new Error('Invalid or excessively deep MindNode Next tree.');
    visited.add(key);
    const raw = rawById.get(key)!;
    const id = newId();
    const node: MapNode = { id, parent, text: richText(bytes(raw, 11)), children: [] };
    const note = richText(bytes(raw, 12));
    if (note) node.note = note;
    const task = integer(message(bytes(raw, 2)), 1);
    if (task === 1 || task === 2) node.task = { done: task === 2 };
    if (bytes(raw, 14)?.length) skipped.add('MindNode Next tag definitions');
    const asset = bytes(raw, 8);
    if (asset?.length) {
      const item = attachment(asset, id);
      if (item) attachments.push(item);
      else skipped.add('built-in MindNode Next stickers');
    }
    doc.nodes[id] = node;
    if (parent) doc.nodes[parent].children.push(id);
    else {
      const position = point(bytes(raw, 5)) ?? { x: doc.roots.length * 480, y: 0 };
      doc.roots.push(id);
      doc.rootInfo[id] = { position, layout: 'mindmap' };
    }
    const children = order.get(key) ?? [];
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ key: children[index], parent: id, depth: depth + 1 });
    }
  }
  if (visited.size !== rawById.size) throw new Error('The MindNode Next document has unresolved node relationships.');
  skipped.add('MindNode Next connection and collapse settings');
  return { doc, skipped, attachments };
}
