import MarkdownIt, { type Token } from 'markdown-it/browser';
import type { MapNode } from '../types';

const parser = new MarkdownIt('commonmark', { html: false, maxNesting: 32 });
/** Notes also take the two everyday additions to CommonMark: tables and ~~strikethrough~~. Labels do not. */
const notes = new MarkdownIt('commonmark', { html: false, maxNesting: 32 }).enable(['table', 'strikethrough']);
const math = /\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|\$\$([\s\S]+?)\$\$|\$(?!\s)((?:\\[^\n]|[^$\\\n])+?)(?<!\s)\$(?![\d$])/y;

for (const md of [parser, notes]) md.inline.ruler.before('escape', 'radiant_math', (state, silent) => {
  const start = state.src[state.pos];
  if (start !== '$' && start !== '\\') return false;
  math.lastIndex = state.pos;
  const match = math.exec(state.src);
  if (!match || math.lastIndex > state.posMax) return false;
  if (!silent) {
    const token = state.push('math', '', 0);
    token.content = match[1] ?? match[2] ?? match[3] ?? match[4];
    token.markup = match[0];
    token.block = !!(match[1] ?? match[3]);
  }
  state.pos = math.lastIndex;
  return true;
});

export function parseNote(raw: string): Token[] {
  return notes.parse(raw, {});
}

export function webOrMail(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

function inlineText(tokens: readonly Token[]): string {
  return tokens.map(token => {
    if (token.children) return inlineText(token.children);
    if (token.type === 'math') return token.markup;
    if (token.type === 'softbreak' || token.type === 'hardbreak') return ' ';
    if (token.type === 'link_open') return '';
    return token.content;
  }).join('');
}

const labels = new Map<string, string>();

/** Canvas labels have no navigation surface. Read formatting as plain text and keep the editable source. */
export function readableLabel(node: MapNode): string {
  if (node.origin?.by !== 'ai' || !/[*_`\[<!\\]/.test(node.text)) return node.text;
  let label = labels.get(node.text);
  if (label === undefined) {
    label = inlineText(parser.parseInline(node.text, {}));
    if (labels.size >= 2048) labels.clear();
    labels.set(node.text, label);
  }
  return label;
}
