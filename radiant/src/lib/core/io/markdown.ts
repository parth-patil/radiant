import type { OutlineNode } from '../types';
import { decodeEntities } from './xml';

export interface MarkdownOptions {
  /** Number of heading levels before switching to bullets. Default 1 (first level only). Max 6. */
  headingLevels?: number;
}

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/;

const FENCE = /^\s*([`]{3}|~~~)/;
const entity = (char: string) => `&#${char.charCodeAt(0)};`;

function encodeText(text: string, characters = /[&\t\n\r]/g): string {
  return text.replace(characters, entity).replace(/^ +| +$/g, (spaces) => '&#32;'.repeat(spaces.length));
}

function label(text: string): string {
  return encodeText(text, /[&\t\n\r#*_[\]<>`\\]/g);
}

function paragraphs(note: string): string[] {
  const leading = /^\n*/.exec(note)![0].length;
  const rest = note.slice(leading);
  const trailing = /\n*$/.exec(rest)![0].length;
  const lines = rest.slice(0, rest.length - trailing).split('\n').map((line) => {
    const structural = HEADING.test(line) || BULLET.test(line) || FENCE.test(line);
    if (!structural) return encodeText(line);
    const start = line.search(/\S/);
    return encodeText(line.slice(0, start)) + entity(line[start]) + encodeText(line.slice(start + 1));
  });
  lines[0] = '&#10;'.repeat(leading) + lines[0];
  lines[lines.length - 1] += '&#10;'.repeat(trailing);
  return lines;
}

function indentWidth(ws: string): number {
  let w = 0;
  for (const c of ws) w += c === '\t' ? 4 : 1;
  return w;
}

/** Parses headings and nested bullet lists. Paragraph text under a heading or bullet becomes its note. */
export function parseMarkdownOutline(md: string, skipped?: Set<string>): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: { depth: number; node: OutlineNode }[] = [];
  let headingDepth = 0;
  let listIndents: number[] = [];
  let last: OutlineNode | null = null;
  let blankLines = 0;
  let fence = false;

  const add = (depth: number, text: string): OutlineNode => {
    const node: OutlineNode = { text: decodeEntities(text.trim()), children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ depth, node });
    return node;
  };
  const addNote = (line: string) => {
    if (!last) {
      last = add(headingDepth + 1, line);
      return;
    }
    const t = decodeEntities(line.trim());
    if (!t) return;
    last.note = last.note ? last.note + '\n'.repeat(blankLines + 1) + t : t;
  };

  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(raw)) {
      skipped?.add('Code block fences and language markers.');
      fence = !fence;
      blankLines = 0;
      continue;
    }
    if (fence) {
      if (last) last.note = last.note ? last.note + '\n' + raw : raw;
      else if (raw.trim()) skipped?.add('Code block content before the first outline entry.');
      continue;
    }
    if (!raw.trim()) {
      blankLines++;
      continue;
    }
    if (/!\[[^\]]*\](?:\(|\[)/.test(raw)) skipped?.add('Markdown picture references kept as text without attachments.');
    const h = HEADING.exec(raw);
    if (h) {
      headingDepth = h[1].length;
      listIndents = [];
      last = add(headingDepth, h[2]);
      blankLines = 0;
      continue;
    }
    const b = BULLET.exec(raw);
    if (b) {
      const w = indentWidth(b[1]);
      while (listIndents.length && listIndents[listIndents.length - 1] > w) listIndents.pop();
      if (!listIndents.length || listIndents[listIndents.length - 1] < w) listIndents.push(w);
      last = add(headingDepth + listIndents.length, b[2]);
      blankLines = 0;
      continue;
    }
    addNote(raw);
    blankLines = 0;
  }
  return roots;
}

/** Writes the first level(s) as headings, deeper levels as nested bullets, notes as paragraphs. */
export function toMarkdownOutline(nodes: OutlineNode[], opts: MarkdownOptions = {}): string {
  const levels = Math.min(6, Math.max(1, Math.floor(opts.headingLevels ?? 1)));
  const out: string[] = [];
  const walk = (list: OutlineNode[], depth: number) => {
    for (const n of list) {
      if (depth < levels) {
        if (out.length) out.push('');
        out.push(`${'#'.repeat(depth + 1)} ${label(n.text)}`);
        if (n.note) out.push('', ...paragraphs(n.note));
        if (n.children.length && depth + 1 >= levels) out.push('');
        walk(n.children, depth + 1);
      } else {
        const pad = '  '.repeat(depth - levels);
        out.push(`${pad}- ${label(n.text)}`);
        if (n.note) for (const l of paragraphs(n.note)) out.push(l.trim() ? `${pad}  ${l}` : '');
        walk(n.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return out.join('\n') + '\n';
}
