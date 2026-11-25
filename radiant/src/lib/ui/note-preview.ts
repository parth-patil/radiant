import type { Token } from 'markdown-it/browser';
import { parseNote, webOrMail } from '../core/model/markdown';

const tags = new Set(['p', 'strong', 'em', 's', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td']);
type Parent = HTMLElement | DocumentFragment;

export async function renderNote(raw: string, open: (url: URL) => void): Promise<DocumentFragment> {
  const fragment = document.createDocumentFragment();
  const equations: { token: Token; slot: HTMLElement }[] = [];

  function appendTokens(tokens: Token[], root: Parent) {
    const stack: Parent[] = [root];
    for (const token of tokens) {
      const parent = stack[stack.length - 1];
      if (token.type === 'inline' && token.children) {
        appendTokens(token.children, parent);
      } else if (token.nesting < 0) {
        const closing = stack.pop();
        if (closing instanceof HTMLButtonElement) {
          const destination = closing.title;
          if (closing.textContent !== destination) parent.append(' (' + destination + ')');
        }
      } else if (token.nesting > 0) {
        let el: HTMLElement;
        if (token.type === 'link_open') {
          const href = String(token.attrGet('href') ?? '');
          const url = webOrMail(href);
          if (url) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'note-link';
            button.title = url.href;
            button.addEventListener('click', () => open(url));
            el = button;
          } else el = document.createElement('span');
        } else {
          el = document.createElement(tags.has(token.tag) ? token.tag : 'span');
          if (el instanceof HTMLOListElement && token.attrGet('start')) el.start = Number(token.attrGet('start'));
          // A table column's alignment arrives as a style attribute; only the alignment is taken from it.
          const align = /text-align:(left|center|right)/.exec(String(token.attrGet('style') ?? ''));
          if (align) el.style.textAlign = align[1];
        }
        parent.append(el);
        stack.push(el);
      } else if (token.type === 'math') {
        const slot = document.createElement('span');
        slot.textContent = token.markup;
        parent.append(slot);
        equations.push({ token, slot });
      } else if (token.type === 'image') {
        // Keep alt text and the address visible without instantiating an image.
        parent.append(token.content + ' (' + String(token.attrGet('src') ?? '') + ')');
      } else if (['fence', 'code_block', 'code_inline'].includes(token.type)) {
        const code = document.createElement('code');
        code.textContent = token.content;
        if (token.type === 'code_inline') parent.append(code);
        else { const pre = document.createElement('pre'); pre.append(code); parent.append(pre); }
      } else if (token.type === 'softbreak' || token.type === 'hardbreak' || token.type === 'hr') {
        parent.append(document.createElement(token.type === 'hr' ? 'hr' : 'br'));
      } else parent.append(token.content);
    }
  }
  appendTokens(parseNote(raw), fragment);
  if (equations.length) {
    const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
    for (const { token, slot } of equations) {
      katex.render(token.content, slot, { displayMode: token.block, throwOnError: false, trust: false, maxExpand: 500, maxSize: 10 });
    }
  }
  return fragment;
}
