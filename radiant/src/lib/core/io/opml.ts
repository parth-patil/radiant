import type { OutlineNode } from '../types';
import { attr, elements, escapeXml, parseXml, textOf, type XmlElement } from './xml';

const XML_ATTRIBUTE = /^(?:[\p{L}_][\p{L}\p{N}_.-]*:)?[\p{L}_][\p{L}\p{N}_.-]*$/u;

function namespaces(el: XmlElement, inherited: Map<string, string>): Map<string, string> {
  const combined = new Map(inherited);
  for (const [key, value] of Object.entries(el.attrs)) {
    if (key.startsWith('xmlns:')) combined.set(key, value);
  }
  return combined;
}

function outlineOf(el: XmlElement, inherited: Map<string, string>, depth: number, skipped: Set<string>): OutlineNode {
  if (depth > 500) throw new Error('The OPML document has more than 500 nested outline levels.');
  const title = attr(el, 'text');
  const node: OutlineNode = { text: title ?? attr(el, 'title') ?? '', children: [] };
  const note = attr(el, '_note');
  if (note) node.note = note;
  const current = namespaces(el, inherited);
  const attributes = new Map<string, string>();
  for (const [key, value] of Object.entries(el.attrs)) {
    const lower = key.toLowerCase();
    if (lower === 'text' || lower === '_note' || (title === undefined && lower === 'title')) continue;
    attributes.set(key, value);
    const colon = key.indexOf(':');
    if (colon < 0) continue;
    const declaration = `xmlns:${key.slice(0, colon)}`;
    const namespace = current.get(declaration);
    if (namespace) attributes.set(declaration, namespace);
  }
  if (attributes.size) node.interchange = { opmlAttributes: [...attributes] };
  for (const child of elements(el)) if (child.name.toLowerCase() !== 'outline') skipped.add(`Outline element: ${child.name}`);
  node.children = elements(el, 'outline').map((child) => outlineOf(child, current, depth + 1, skipped));
  return node;
}

export function parseOpml(xml: string): { title: string; nodes: OutlineNode[]; skipped: string[] } {
  const skipped = new Set<string>();
  const opml = elements(parseXml(xml), 'opml')[0];
  const head = opml && elements(opml, 'head')[0];
  const titleEl = head && elements(head, 'title')[0];
  const title = titleEl ? textOf(titleEl) : '';
  const body = opml && elements(opml, 'body')[0];
  if (head) for (const child of elements(head)) if (child.name.toLowerCase() !== 'title') skipped.add(`Document metadata: ${child.name}`);
  if (body) for (const child of elements(body)) if (child.name.toLowerCase() !== 'outline') skipped.add(`Document element: ${child.name}`);
  const nodes = body
    ? elements(body, 'outline').map((el) => outlineOf(el, namespaces(body, namespaces(opml, new Map())), 0, skipped))
    : [];
  return { title, nodes, skipped: [...skipped].sort() };
}

function extraAttributes(node: OutlineNode): string {
  const data = node.interchange?.opmlAttributes;
  if (!Array.isArray(data)) return '';
  const attrs = new Map<string, string>();
  for (const entry of data) {
    if (!Array.isArray(entry)) continue;
    const [name, value] = entry;
    if (typeof name === 'string' && typeof value === 'string' && XML_ATTRIBUTE.test(name) && !/^(text|_note)$/i.test(name)) {
      attrs.set(name, value);
    }
  }
  return [...attrs].filter(([name]) => {
    const colon = name.indexOf(':');
    if (colon < 0) return true;
    const prefix = name.slice(0, colon);
    return prefix === 'xml' || prefix === 'xmlns' || attrs.has(`xmlns:${prefix}`);
  }).map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join('');
}

export function toOpml(title: string, nodes: OutlineNode[]): string {
  const lines: string[] = [];
  const walk = (list: OutlineNode[], pad: string) => {
    for (const n of list) {
      const a = `text="${escapeXml(n.text)}"${n.note ? ` _note="${escapeXml(n.note)}"` : ''}${extraAttributes(n)}`;
      if (n.children.length) {
        lines.push(`${pad}<outline ${a}>`);
        walk(n.children, pad + '  ');
        lines.push(`${pad}</outline>`);
      } else lines.push(`${pad}<outline ${a}/>`);
    }
  };
  walk(nodes, '    ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(title).replace(/&#10;/g, ' ')}</title>
  </head>
  <body>
${lines.join('\n')}
  </body>
</opml>
`;
}
