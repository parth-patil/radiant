import type { Doc, NodeId, OutlineNode } from '../types';
import { cloneValue, createDoc } from './doc';
import { outlineInsertOps } from './commands';
import { applyOp } from './ops';

/**
 * Build a document whose single root is `root` (text, note and children). `title` is the document title.
 * Node ids are freshly generated.
 */
export function docFromOutline(title: string, root: OutlineNode): Doc {
  return docFromOutlines(title, [root]);
}

/** Build a new map with one independent main node for each imported outline root. */
export function docFromOutlines(title: string, roots: readonly OutlineNode[]): Doc {
  const doc = createDoc(title);
  if (!roots.length) return doc;
  const placeholder = doc.roots[0];
  const ops: Parameters<typeof applyOp>[1][] = [{ t: 'remove', id: placeholder }];
  roots.forEach((root, index) => {
    outlineInsertOps(root, null, index, 'user', ops, {
      layout: 'mindmap',
      position: { x: 0, y: index * 240 }
    });
  });
  for (const op of ops) applyOp(doc, op);
  return doc;
}

/** Convert the subtree at `rootId` (default: first root) to an outline. Iterative, safe for deep trees. */
export function outlineFromDoc(doc: Doc, rootId: NodeId = doc.roots[0]): OutlineNode {
  return outlineFromSubtree(doc, rootId);
}

/** Convert the subtree rooted at `id` to an outline tree. */
export function outlineFromSubtree(doc: Doc, id: NodeId): OutlineNode {
  const make = (nid: NodeId): OutlineNode => {
    const n = doc.nodes[nid];
    const o: OutlineNode = { text: n.text, children: [] };
    if (n.note) o.note = n.note;
    if (n.collapsed) o.collapsed = true;
    if (n.link) o.link = n.link;
    if (n.interchange) o.interchange = cloneValue(n.interchange);
    return o;
  };
  const top = make(id);
  const stack: Array<[NodeId, OutlineNode]> = [[id, top]];
  while (stack.length) {
    const [nid, o] = stack.pop() as [NodeId, OutlineNode];
    for (const c of doc.nodes[nid].children) {
      const co = make(c);
      o.children.push(co);
      stack.push([c, co]);
    }
  }
  return top;
}

const BULLET = /^(?:[-*+•◦▪]|\d+[.)])\s+/;
const MD_HEADING = /^#{1,6}\s+/;

/**
 * Parse pasted text into an outline. Nesting comes from indentation (tabs count as 4 columns; any consistent
 * indent step works). Leading bullets ("-", "*", "+", "1.", "1)") are stripped, as are Markdown "#" markers.
 * Blank lines are ignored. Returns the top-level nodes.
 */
export function parseIndentedText(text: string): OutlineNode[] {
  const top: OutlineNode[] = [];
  const stack: Array<{ indent: number; node: OutlineNode }> = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') continue;
    let indent = 0;
    let i = 0;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === ' ') indent++;
      else if (c === '\t') indent += 4;
      else break;
    }
    let body = line.slice(i).trimEnd();
    if (BULLET.test(body)) body = body.replace(BULLET, '');
    else if (MD_HEADING.test(body)) body = body.replace(MD_HEADING, '');
    body = body.trim();
    if (body === '') continue;
    const node: OutlineNode = { text: body, children: [] };
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else top.push(node);
    stack.push({ indent, node });
  }
  return top;
}

/** Render outline nodes as tab-indented text, one node per line (notes are not included). */
export function toIndentedText(nodes: readonly OutlineNode[]): string {
  const lines: string[] = [];
  const stack: Array<[OutlineNode, number]> = [];
  for (let i = nodes.length - 1; i >= 0; i--) stack.push([nodes[i], 0]);
  while (stack.length) {
    const [n, d] = stack.pop() as [OutlineNode, number];
    lines.push('\t'.repeat(d) + n.text.replace(/\s*[\r\n]+\s*/g, ' '));
    for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], d + 1]);
  }
  return lines.join('\n');
}
