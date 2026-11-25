/** Tiny tolerant XML reader and writer helpers (no DOM needed, so it runs in Workers, Node and Vitest). */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED[e] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/[\t\n\r]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '\ufffd');
}

/** Parses XML into a tree. Tolerates missing end tags, stray text, comments, DOCTYPE and processing instructions. */
export function parseXml(xml: string, preserveWhitespace = false): XmlElement {
  const root: XmlElement = { name: '#document', attrs: Object.create(null), children: [] };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const n = xml.length;
  const VOID = new Set(['br', 'hr', 'img', 'meta', 'link', 'input']);
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      const t = xml.slice(i);
      if (t.trim() || (preserveWhitespace && stack.length > 1)) top().children.push(decodeEntities(t));
      break;
    }
    if (lt > i) {
      const t = xml.slice(i, lt);
      if (t.trim() || (preserveWhitespace && stack.length > 1)) top().children.push(decodeEntities(t));
    }
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      const end = e < 0 ? n : e;
      top().children.push(xml.slice(lt + 9, end));
      i = e < 0 ? n : e + 3;
    } else if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
    } else if (xml.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in [...]
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = xml[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (xml[lt + 1] === '/') {
      const e = xml.indexOf('>', lt + 2);
      const name = xml.slice(lt + 2, e < 0 ? n : e).trim().toLowerCase();
      // Pop to the matching open element if there is one; otherwise ignore the stray end tag.
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name.toLowerCase() === name) {
          stack.length = k;
          break;
        }
      }
      i = e < 0 ? n : e + 1;
    } else {
      // start tag: read name, attributes (quotes may contain '>')
      let j = lt + 1;
      while (j < n && !/[\s/>]/.test(xml[j])) j++;
      const name = xml.slice(lt + 1, j);
      const attrs: Record<string, string> = Object.create(null);
      let selfClose = false;
      while (j < n) {
        while (j < n && /\s/.test(xml[j])) j++;
        if (xml[j] === '>') {
          j++;
          break;
        }
        if (xml[j] === '/') {
          selfClose = true;
          j++;
          continue;
        }
        let k = j;
        while (k < n && !/[\s=/>]/.test(xml[k])) k++;
        const an = xml.slice(j, k);
        j = k;
        while (j < n && /\s/.test(xml[j])) j++;
        let val = '';
        if (xml[j] === '=') {
          j++;
          while (j < n && /\s/.test(xml[j])) j++;
          const q = xml[j];
          if (q === '"' || q === "'") {
            const e = xml.indexOf(q, j + 1);
            val = xml.slice(j + 1, e < 0 ? n : e);
            j = e < 0 ? n : e + 1;
          } else {
            k = j;
            while (k < n && !/[\s>]/.test(xml[k])) k++;
            val = xml.slice(j, k);
            j = k;
          }
        }
        if (an) attrs[an] = decodeEntities(val);
        else j++;
      }
      const el: XmlElement = { name, attrs, children: [] };
      top().children.push(el);
      if (!selfClose && !VOID.has(name.toLowerCase())) stack.push(el);
      i = j;
    }
  }
  return root;
}

export function elements(el: XmlElement, name?: string): XmlElement[] {
  const lower = name?.toLowerCase();
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && (!lower || c.name.toLowerCase() === lower));
}

export function findFirst(el: XmlElement, name: string): XmlElement | undefined {
  const lower = name.toLowerCase();
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    if (c.name.toLowerCase() === lower) return c;
    const r = findFirst(c, name);
    if (r) return r;
  }
  return undefined;
}

export function attr(el: XmlElement, name: string): string | undefined {
  if (name in el.attrs) return el.attrs[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(el.attrs)) if (k.toLowerCase() === lower) return el.attrs[k];
  return undefined;
}

const BLOCK = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr']);

/** Plain text of an element, with block elements separated by newlines. */
export function textOf(el: XmlElement): string {
  let out = '';
  const walk = (node: XmlNode) => {
    if (typeof node === 'string') {
      if (node.trim() || (out && !/[ \n]$/.test(out))) out += node.replace(/\s+/g, ' ');
      return;
    }
    const lower = node.name.toLowerCase();
    if (lower === 'head' || lower === 'style' || lower === 'script') return;
    const block = BLOCK.has(lower);
    if (block && out && !out.endsWith('\n')) out += '\n';
    node.children.forEach(walk);
    if (block && out && !out.endsWith('\n')) out += '\n';
  };
  walk(el);
  return out
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
