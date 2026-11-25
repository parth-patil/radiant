import type { OutlineNode } from '../types';
import { attr, elements, escapeXml, findFirst, parseXml, textOf, type XmlElement } from './xml';

const NODE_ATTRIBUTES = new Set(['text', 'folded', 'link']);
const NODE_ELEMENTS = new Set(['node', 'richcontent', 'icon']);

function noteOf(content: XmlElement, skipped: Set<string>): string {
  const body = findFirst(content, 'body');
  const paras = body && elements(body, 'p');
  if (body && paras && body.children.every((child) => typeof child === 'string' ? !child.trim() : child.name.toLowerCase() === 'p') &&
      paras.every((p) => p.children.every((part) => typeof part === 'string'))) {
    return paras.map((p) => p.children.join('')).join('\n');
  }
  skipped.add('rich-text note formatting');
  return textOf(content);
}

function nodeOf(el: XmlElement, skipped: Set<string>, depth: number): OutlineNode {
  if (depth > 500) throw new Error('The FreeMind document has more than 500 nested topic levels.');
  let text = attr(el, 'TEXT');
  let note: string | undefined;
  for (const key of Object.keys(el.attrs)) if (!NODE_ATTRIBUTES.has(key.toLowerCase())) skipped.add(key);
  for (const child of elements(el)) if (!NODE_ELEMENTS.has(child.name.toLowerCase())) skipped.add(child.name);
  for (const rc of elements(el, 'richcontent')) {
    if (findFirst(rc, 'img')) skipped.add('pictures embedded in rich content');
    const type = (attr(rc, 'TYPE') ?? '').toUpperCase();
    if (type === 'NOTE') note = noteOf(rc, skipped);
    else if (type === 'NODE') {
      if (text === undefined) text = textOf(rc);
      skipped.add('rich-text label formatting');
    } else skipped.add('unsupported rich content');
  }
  const node: OutlineNode = { text: text ?? '', children: elements(el, 'node').map((child) => nodeOf(child, skipped, depth + 1)) };
  if (note) node.note = note;
  const link = attr(el, 'LINK');
  if (link) node.link = link;
  if (attr(el, 'FOLDED')?.toLowerCase() === 'true') node.collapsed = true;
  const icons = elements(el, 'icon').map((icon) => attr(icon, 'BUILTIN')).filter((name): name is string => !!name);
  if (icons.length) node.interchange = { freeMindIcons: icons };
  return node;
}

/** FreeMind .mm: the map's root node becomes the single top-level node and also gives the title. */
export function parseFreeMind(xml: string): { title: string; nodes: OutlineNode[]; skipped: string[] } {
  const map = elements(parseXml(xml, true), 'map')[0];
  const skipped = new Set<string>();
  if (map) {
    for (const child of elements(map)) if (child.name.toLowerCase() !== 'node') skipped.add(child.name);
    for (const key of Object.keys(map.attrs)) if (key.toLowerCase() !== 'version') skipped.add(key);
  }
  const nodes = map ? elements(map, 'node').map((el) => nodeOf(el, skipped, 0)) : [];
  return { title: nodes[0]?.text ?? '', nodes, skipped: [...skipped].sort() };
}

export function toFreeMind(title: string, nodes: OutlineNode[]): string {
  const lines: string[] = [];
  const walk = (n: OutlineNode, pad: string) => {
    const fold = n.collapsed ? ' FOLDED="true"' : '';
    const link = n.link ? ` LINK="${escapeXml(n.link)}"` : '';
    const open = `${pad}<node TEXT="${escapeXml(n.text)}"${fold}${link}>`;
    const icons = Array.isArray(n.interchange?.freeMindIcons) ? n.interchange.freeMindIcons.filter((item) => typeof item === 'string') : [];
    if (!n.note && !n.children.length && !icons.length) {
      lines.push(open.replace(/>$/, '/>'));
      return;
    }
    lines.push(open);
    for (const icon of icons) lines.push(`${pad}  <icon BUILTIN="${escapeXml(icon)}"/>`);
    if (n.note) {
      const paras = n.note.split('\n').map((l) => {
        const encoded = escapeXml(l);
        return `${pad}      <p>${l.trim() ? encoded : encoded.replace(/ /g, '&#32;')}</p>`;
      });
      lines.push(
        `${pad}  <richcontent TYPE="NOTE"><html>`,
        `${pad}    <head/>`,
        `${pad}    <body>`,
        ...paras,
        `${pad}    </body>`,
        `${pad}  </html></richcontent>`
      );
    }
    for (const child of n.children) walk(child, pad + '  ');
    lines.push(`${pad}</node>`);
  };
  walk(nodes.length === 1 ? nodes[0] : { text: title, children: nodes }, '  ');
  return `<map version="1.0.1">\n${lines.join('\n')}\n</map>\n`;
}
