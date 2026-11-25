import { createDoc, newId } from '../model';
import type { LayoutKind, MapNode, NodeId, NodeStyle, Vec2 } from '../types';
import { isAttachmentName, type MindNodeImport } from './mindnode-archive';
import { parseXml, type XmlNode } from './xml';

const NODE_LIMIT = 50_000;
type Fields = Record<string, unknown>;
const object = (value: unknown): Fields | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : null;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function html(value: unknown): string {
  const source = typeof value === 'string' ? value : object(value)?.text;
  return typeof source === 'string' ? source : '';
}

function plain(value: unknown): string {
  const root = parseXml(html(value));
  const output: string[] = [];
  const pending: XmlNode[] = [...root.children].reverse();
  while (pending.length) {
    const item = pending.pop()!;
    if (typeof item === 'string') { output.push(item); continue; }
    const name = item.name.toLowerCase();
    if (name === 'br') { output.push('\n'); continue; }
    if (name === 'p' || name === 'div' || name === 'li') pending.push('\n');
    for (let i = item.children.length - 1; i >= 0; i--) pending.push(item.children[i]);
  }
  return output.join('').replace(/[ \t]+\n/g, '\n').replace(/\u2028/g, '\n').trim();
}

function point(value: unknown): Vec2 | undefined {
  if (typeof value !== 'string') return;
  const match = /^\{\s*([+-]?[\d.eE+-]+)\s*,\s*([+-]?[\d.eE+-]+)\s*\}$/.exec(value);
  if (!match) return;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (Number.isFinite(x) && Number.isFinite(y) && Math.max(Math.abs(x), Math.abs(y)) <= 1e7) return { x, y };
}

function color(raw: unknown, allowAlpha = true): string | undefined {
  if (typeof raw !== 'string') return;
  if (/^#[a-f\d]{6}$/i.test(raw)) return raw;
  const input = raw.trim();
  const components = (/^\{([^{}]+)\}$/.exec(input) ?? /^rgba?\(([^()]+)\)$/i.exec(input))?.[1]
    ?.split(',').map((part) => part.trim());
  if (!components || components.length < 3 || components.length > 4 ||
      components.some((component) => !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(component))) return;
  const max = input.startsWith('{') ? 1 : 255;
  const values = components.map(Number);
  const alpha = values[3] ?? 1;
  if (values.slice(0, 3).some((c) => c < 0 || c > max) || alpha < 0 || alpha > 1) return;
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + values.slice(0, 3).map((c) => hex(c / max)).join('') + (allowAlpha && alpha < 1 ? hex(alpha) : '');
}

function fontName(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const name = value.trim().replace(/^["']|["']$/g, '');
  if (/^[\p{L}\p{N}-][\p{L}\p{N} -]{0,83}$/u.test(name)) return `"${name}", sans-serif`;
}

function titleStyle(title: unknown): NodeStyle {
  const stored = object(title)?.fontStyle;
  const style: NodeStyle = {};
  const font = object(stored);
  const paragraphs = parseXml(html(title)).children.filter((child): child is Exclude<XmlNode, string> => typeof child !== 'string');
  const css = new Map(
    (paragraphs[0]?.attrs.style ?? '').split(';').map((value) => {
      const colon = value.indexOf(':');
      return [value.slice(0, colon).trim().toLowerCase(), value.slice(colon + 1).trim()];
    }).filter(([key]) => !!key) as [string, string][]
  );
  const shorthand = /^(.*?)\b([\d.]+)px\s+(.+)$/i.exec(css.get('font') ?? '');
  const fontSize = Number(shorthand?.[2] ?? font?.fontSize);
  if (Number.isFinite(fontSize) && fontSize >= 8 && fontSize <= 96) style.fontSize = fontSize;
  const fontFamily = fontName(shorthand?.[3] ?? css.get('font-family') ?? font?.fontName);
  if (fontFamily) style.fontFamily = fontFamily;
  if (shorthand || typeof font?.bold === 'boolean') style.bold = shorthand ? /\bbold\b/i.test(shorthand[1]) : !!font?.bold;
  if (shorthand || typeof font?.italic === 'boolean') style.italic = shorthand ? /\bitalic\b/i.test(shorthand[1]) : !!font?.italic;
  const ink = color(css.get('color') ?? font?.color);
  if (ink) style.textColor = ink;
  const align = css.get('text-align') ?? ([ 'left', 'center', 'right' ] as const)[Number(font?.alignment)];
  if (align === 'left' || align === 'center' || align === 'right') style.alignment = align;
  return style;
}

const SHAPES: Record<number, NodeStyle['shape']> = {
  0: 'underline', 1: 'rectangle', 2: 'box', 3: 'box', 4: 'circle', 5: 'square', 7: 'box'
};

function nodeStyle(raw: Fields, map: Fields, root: boolean, skipped: Set<string>): NodeStyle {
  const style = titleStyle(raw.title);
  const stroke = object(object(raw.pathStyle)?.strokeStyle);
  const shape = object(raw.shapeStyle);
  const branch = color(stroke?.color);
  if (branch) style.color = branch;
  if (typeof stroke?.width === 'number' && stroke.width > 0 && Number.isFinite(stroke.width)) {
    style.branchWidth = Math.min(64, Math.max(1, stroke.width));
  }
  if (map.branchType === 0 || map.branchType === 1) {
    style.branch = map.branchWidthType === 1 ? 'tapered' : map.branchType === 1 ? 'rounded' : 'line';
  }
  const fill = color(shape?.fillColor);
  const kind = Number(shape?.shapeType);
  if (Number.isInteger(kind)) {
    if (SHAPES[kind]) style.shape = root && kind === 0 ? 'none' : SHAPES[kind];
    else skipped.add('unrecognized node shapes');
    if (kind === 3 || kind === 7) skipped.add('some node shapes were approximated');
  }
  if (fill && style.shape !== 'underline' && style.shape !== 'none') style.fillColor = fill;
  return style;
}

function layout(map: Fields, root: Fields): LayoutKind {
  if (map.layoutStyle === 4 || map.layoutStyle === 6) return 'down';
  const origin = point(root.location);
  if (!origin || map.layoutStyle === 2) return 'mindmap';
  const children = list(root.subnodes).flatMap((raw) => {
    const child = point(object(raw)?.location);
    return child ? [child] : [];
  });
  if (children.length && children.every((c) => c.x > origin.x + 4)) return 'right';
  if (children.length && children.every((c) => c.x < origin.x - 4)) return 'left';
  return 'mindmap';
}

function attachment(raw: Fields, node: NodeId, strokeColor?: string): MindNodeImport['attachments'][number] | undefined {
  const info = object(raw.attachment);
  const name = info?.fileName;
  if (typeof name !== 'string' || !isAttachmentName(name)) return;
  const basename = name.replace(/\.[^.]+$/, '');
  const symbol = /^\p{Extended_Pictographic}(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f]*)$/u.test(basename) ? basename : undefined;
  const tint = info?.tinted === true || info?.tintKind === 1 ? strokeColor?.slice(0, 7) : undefined;
  return { node, name, entry: name, size: point(info?.size), symbol, tint };
}

/** Decode the editable map in a MindNode Classic v7/v9 property list. */
export function parseMindNodeClassic(rawDoc: unknown, title: string): MindNodeImport {
  const data = object(rawDoc);
  const canvas = object(data?.canvas);
  if ((data?.version !== 7 && data?.version !== 9) || !canvas || !Array.isArray(canvas.mindMaps)) {
    throw new Error('This MindNode Classic file uses an unsupported format. Export it as a current MindNode Classic file or OPML.');
  }
  const doc = createDoc(title);
  doc.roots = [];
  doc.rootInfo = Object.create(null);
  doc.nodes = Object.create(null);
  const skipped = new Set<string>();
  if (list(canvas.boundaries).length) skipped.add('MindNode group boundaries');
  const attachments: MindNodeImport['attachments'] = [];
  const background = color(canvas.color, false);
  if (background) doc.themeSettings = { background, showGrid: false };
  const ids = new Map<string, NodeId>();
  const tagNames = new Map<string, string>();
  for (const raw of list(canvas.tags)) {
    const tag = object(raw);
    if (typeof tag?.tagID !== 'string' || typeof tag.name !== 'string') continue;
    tagNames.set(tag.tagID, tag.name);
    const tint = color(tag.color, false);
    if (tint) {
      doc.tagColors ??= Object.create(null) as NonNullable<typeof doc.tagColors>;
      doc.tagColors[tag.name.toLowerCase()] = tint;
    }
  }
  const roots = canvas.mindMaps.flatMap((entry) => {
    const map = object(entry);
    const root = object(map?.mainNode);
    return map && root ? [{ raw: root, map }] : [];
  });
  if (!roots.length) throw new Error('The MindNode document has no readable maps.');
  const pending: { raw: Fields; map: Fields; parent: NodeId | null; depth: number }[] =
    roots.map(({ raw, map }) => ({ raw, map, parent: null, depth: 0 })).reverse();
  const visited = new Set<Fields>();
  while (pending.length) {
    const { raw, map, parent, depth } = pending.pop()!;
    if (visited.has(raw)) throw new Error('The MindNode document repeats a node in its tree.');
    if (visited.size >= NODE_LIMIT || depth > 500) throw new Error('The MindNode tree exceeds Radiant’s import limits.');
    visited.add(raw);
    const id = newId();
    const style = nodeStyle(raw, map, !parent, skipped);
    const node: MapNode = { id, parent, text: plain(raw.title), children: [], ...(Object.keys(style).length ? { style } : {}) };
    if (typeof raw.nodeID === 'string') {
      if (ids.has(raw.nodeID)) throw new Error('The MindNode document contains duplicate node IDs.');
      ids.set(raw.nodeID, id);
    }
    const note = plain(raw.note);
    if (note) node.note = note;
    if (raw.hasFoldedSubnodes === true) node.collapsed = true;
    const task = object(raw.task)?.state;
    if (task === 1 || task === 2) node.task = { done: task === 2 };
    const tags = list(raw.tags).flatMap((tag) => typeof tag === 'string' && tagNames.has(tag) ? [tagNames.get(tag)!] : []);
    if (tags.length) node.tags = [...new Set(tags)];
    const item = attachment(raw, id, style.color);
    if (item) attachments.push(item);
    else if (raw.attachment) skipped.add('unnamed or unsupported attachments');
    if (typeof raw.link === 'string') node.link = raw.link;
    if (parent) {
      doc.nodes[parent].children.push(id);
      const parentInfo = doc.rootInfo[parent];
      const position = point(raw.location);
      if (parentInfo?.layout === 'mindmap' && position && Math.abs(position.x - parentInfo.position.x) > 4) {
        node.side = position.x < parentInfo.position.x ? 'left' : 'right';
      }
      if (position) skipped.add('exact positions within branches');
    } else {
      const position = point(raw.location) ?? { x: doc.roots.length * 480, y: 0 };
      doc.roots.push(id);
      doc.rootInfo[id] = { position, layout: layout(map, raw) };
    }
    const markup = html(raw.title);
    if (/<(?:span|b|strong|i|em|u|s)\b/i.test(markup)) skipped.add('mixed formatting within labels');
    if (note && /<(?:p|span|a|b|i|u)\b/i.test(html(raw.note))) skipped.add('rich-text note formatting');
    doc.nodes[id] = node;
    const children = list(raw.subnodes);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = object(children[i]);
      if (child) pending.push({ raw: child, map, parent: id, depth: depth + 1 });
      else skipped.add('unreadable child topics');
    }
  }
  for (const value of list(canvas.crossConnections)) {
    const link = object(value);
    const ends = object(link?.endPoints);
    const from = typeof ends?.startNodeID === 'string' ? ids.get(ends.startNodeID) : undefined;
    const to = typeof ends?.endNodeID === 'string' ? ids.get(ends.endNodeID) : undefined;
    if (!from || !to || from === to) {
      skipped.add('unresolved cross-connections');
      continue;
    }
    const label = plain(link?.title);
    const stroke = object(object(link?.pathStyle)?.strokeStyle);
    const tint = color(stroke?.color);
    const dash = stroke?.dash === 1 ? 'dashed' : stroke?.dash === 0 ? 'solid' : undefined;
    const arrow = object(link?.arrowStyle);
    const start = arrow?.startArrow === 4;
    const end = arrow?.endArrow === 4;
    const arrows = start && end ? 'both' : start ? 'start' : end ? 'end' : arrow ? 'none' : undefined;
    doc.links.push({ id: newId(), from, to, ...(label ? { label } : {}), color: tint, dash, arrows });
    if (list(object(link?.layout)?.wayPoints).length) skipped.add('cross-connection waypoints');
  }
  return { doc, skipped, attachments };
}
