/**
 * SVG subtrees: the node-group contract as a prompt, a validator, a sanitiser and a repair prompt.
 * Contract (spec "The contract"): one <svg> with the given viewBox; exactly one <g id="node-ID"> per node with
 * data-anchor-in (and data-anchor-out when the node has children), all drawing inside the node's box, no connectors,
 * no text, no scripts or external references, palette only, element budget. Pure TypeScript, own tolerant tokenizer.
 */
import type { PromptPair } from '../ai/prompts';
import { fill } from '../ai/template';
import svgTemplate from '../ai/templates/svg.json';
import svgRepairTemplate from '../ai/templates/svg-repair.json';
import type { Rect, Vec2 } from '../types';
import { colorDistance, isNonColour, parseColor, type Rgb } from './color';
import { describeStyle, type ArtStyleSheet } from './styleSheet';

// ------------------------------------------------------------------ request and limits

export const SVG_REGION_SIZE = 8;

export interface SvgNeighbour {
  id: string;
  text: string;
  centre?: Vec2;
  anchorIn?: Vec2;
  anchorOut?: Vec2;
}

export interface SvgNodeSpec {
  id: string;
  /** The node's text. Used only to tell the model what to draw; the drawing must not contain text. */
  text: string;
  /** Layout box, relative to the subtree frame (x,y = left,top). */
  box: Rect;
  parentId: string | null;
  parent?: SvgNeighbour;
  children?: SvgNeighbour[];
  siblings?: SvgNeighbour[];
}

export interface SvgLimits {
  /** Directly rendered drawing elements per node group. Default 40. */
  perNode: number;
  /** Drawing elements in the whole SVG, including definitions. Default 400. */
  total: number;
  /** Maximum bytes of SVG text. Default 200000. */
  bytes: number;
  /** Minimum anchor separation as a share of the box diagonal. Default 0.25. */
  anchorSeparation: number;
}

export const DEFAULT_SVG_LIMITS: SvgLimits = { perNode: 40, total: 400, bytes: 200_000, anchorSeparation: 0.25 };

export interface SvgSubtreeRequest {
  /** User-authored visual instructions for a single-node regeneration. */
  brief?: string;
  nodes: SvgNodeSpec[];
  /** Allowed colours (hex, rgb() or hsl()). Usually `resolvePalette(style, branchColour)`. */
  palette: string[];
  style: ArtStyleSheet;
  branchColour?: string;
  limits?: Partial<SvgLimits>;
}

/** The ids of nodes that have at least one child in the request. */
function parentsOf(nodes: SvgNodeSpec[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.parentId) ids.add(node.parentId);
    if (node.children?.length) ids.add(node.id);
  }
  return ids;
}

/** Divide a pre-laid-out subtree into independently validated regions using its document order. */
export function svgRegionCount(nodes: number): number {
  if (!nodes) return 0;
  return nodes <= SVG_REGION_SIZE ? 1 : 1 + Math.ceil((nodes - 2) / SVG_REGION_SIZE);
}

export function planSvgRegions(input: SvgSubtreeRequest): SvgSubtreeRequest[] {
  const regions: SvgSubtreeRequest[] = [];
  const byId = new Map(input.nodes.map(node => [node.id, node]));
  const childrenByParent = new Map<string, SvgNodeSpec[]>();
  for (const node of input.nodes) {
    if (!node.parentId) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  const neighbour = (node: SvgNodeSpec): SvgNeighbour => ({ id: node.id, text: node.text, centre: centre(node.box) });
  let start = 0;
  while (start < input.nodes.length) {
    const length = start === 0 && input.nodes.length > SVG_REGION_SIZE ? 2 : SVG_REGION_SIZE;
    const nodes = input.nodes.slice(start, start + length);
    start += length;
    const frame = viewBoxOf(nodes);
    const local = (point?: Vec2): Vec2 | undefined => point && { x: point.x - frame.x, y: point.y - frame.y };
    const shift = (neighbour: SvgNeighbour): SvgNeighbour => ({
      ...neighbour, centre: local(neighbour.centre), anchorIn: local(neighbour.anchorIn), anchorOut: local(neighbour.anchorOut)
    });
    regions.push({
      ...input,
      nodes: nodes.map((n) => {
        const knownParent = n.parentId ? byId.get(n.parentId) : undefined;
        const parent = n.parent ?? (knownParent ? neighbour(knownParent) : undefined);
        const children = n.children ?? childrenByParent.get(n.id)?.map(neighbour);
        return {
          ...n, box: { ...n.box, x: n.box.x - frame.x, y: n.box.y - frame.y },
          parent: parent && shift(parent), children: children?.map(shift), siblings: n.siblings?.map(shift)
        };
      })
    });
  }
  return regions;
}

/** viewBox rectangle: the union of the node boxes. */
export function viewBoxOf(nodes: SvgNodeSpec[]): Rect {
  if (!nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    x0 = Math.min(x0, n.box.x);
    y0 = Math.min(y0, n.box.y);
    x1 = Math.max(x1, n.box.x + n.box.w);
    y1 = Math.max(y1, n.box.y + n.box.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const fmt = (n: number) => String(Math.round(n * 100) / 100);
const vbText = (r: Rect) => `${fmt(r.x)} ${fmt(r.y)} ${fmt(r.w)} ${fmt(r.h)}`;
const centre = (b: Rect): Vec2 => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export const SVG_ALLOWED_ELEMENTS = [
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'linearGradient',
  'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc',
] as const;
const ALLOWED = new Set<string>(SVG_ALLOWED_ELEMENTS);
const DRAWING = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
/** Elements whose children are not drawn directly. */
const NON_RENDERED = new Set(['defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'title', 'desc']);

function sideFacing(from: Rect, to: Vec2): string {
  const c = centre(from);
  const dx = to.x - c.x, dy = to.y - c.y;
  if (Math.abs(dx) * from.h >= Math.abs(dy) * from.w) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function meanPoint(points: Vec2[]): Vec2 | undefined {
  if (!points.length) return undefined;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  };
}

function svgInstructions(template: Pick<typeof svgTemplate, 'role' | 'output' | 'rules' | 'example'>, limits: SvgLimits, style?: string): string {
  const contract = { ...limits, anchorSeparation: fmt(limits.anchorSeparation * 100),
    coincidentAnchors: limits.anchorSeparation > 0 ? 'Anchors are never the same point.' : 'In and out anchors may coincide.',
    allowedElements: SVG_ALLOWED_ELEMENTS.join(', ') };
  const values = { ...contract, svgOutput: fill(svgTemplate.output, contract), svgRules: fill(svgTemplate.rules, contract) };
  return [template.role, template.output, style, template.rules, template.example]
    .filter((section): section is string => !!section)
    .map(section => fill(section, values))
    .join('\n\n');
}

/** Builds the SVG-subtree prompt. The model's reply is the SVG document; use `extractSvg` then `validateSvg`. */
export function buildSvgSubtreePrompt(req: SvgSubtreeRequest): PromptPair {
  const limits = { ...DEFAULT_SVG_LIMITS, ...req.limits };
  const vb = viewBoxOf(req.nodes);
  const parents = parentsOf(req.nodes);
  const byId = new Map(req.nodes.map((n) => [n.id, n]));
  const rows = req.nodes.map((n) => {
    const inRegion = req.nodes.filter((child) => child.parentId === n.id);
    const parent = n.parentId ? byId.get(n.parentId) : undefined;
    const parentCentre = n.parent?.anchorOut ?? n.parent?.centre ?? (parent ? centre(parent.box) : undefined);
    const inSide = parentCentre ? sideFacing(n.box, parentCentre) : 'left';
    const children: SvgNeighbour[] = n.children ?? inRegion.map((child) => ({ id: child.id, text: child.text, centre: centre(child.box) }));
    const destinations = children.flatMap((child) => child.anchorIn ? [child.anchorIn] : child.centre ? [child.centre] : []);
    let outPart = 'leaf: no data-anchor-out';
    const toward = meanPoint(destinations);
    if (parents.has(n.id)) {
      const opposite = inSide === 'left' ? 'right' : inSide === 'right' ? 'left' : inSide === 'top' ? 'bottom' : 'top';
      outPart = `data-anchor-out on the ${toward ? sideFacing(n.box, toward) : opposite} side`;
    }
    const b = n.box;
    const related = [
      n.parent ? `parent concept ${JSON.stringify(n.parent.text)}` : '',
      children.length ? `child concepts ${children.slice(0, 8).map((child) => JSON.stringify(child.text)).join(', ')}` : '',
      n.siblings?.length ? `neighbour concepts ${n.siblings.slice(0, 6).map((sibling) => JSON.stringify(sibling.text)).join(', ')}` : ''
    ].filter(Boolean).join('; ');
    return `- id ${JSON.stringify(n.id)} (${JSON.stringify(n.text)}): box x=${fmt(b.x)} y=${fmt(b.y)} width=${fmt(b.w)} height=${fmt(b.h)}; parent: ${n.parentId ?? 'none (subtree root)'}; data-anchor-in on the ${inSide} side; ${outPart}${parentCentre ? `; in target ${fmt(parentCentre.x)},${fmt(parentCentre.y)}` : ''}${toward ? `; out target ${fmt(toward.x)},${fmt(toward.y)}` : ''}${related ? `\n  Context only (do not draw additional groups): ${related}.` : ''}`;
  });
  const style = fill(svgTemplate.style, { description: describeStyle(req.style, req.branchColour), seed: req.style.seed });
  const brief = req.brief === undefined ? '' : fill(svgTemplate.brief, { text: JSON.stringify(req.brief) });
  return {
    templateVersion: svgTemplate.version,
    instructions: svgInstructions(svgTemplate, limits),
    prompt: fill(svgTemplate.task, { frame: vbText(vb), palette: req.palette.join(', '), style, brief, nodes: rows.join('\n') })
  };
}

/** Returns the `<svg ...>...</svg>` part of a model reply (drops code fences and surrounding prose). */
export function extractSvg(reply: string): string {
  const start = reply.search(/<svg[\s>]/i);
  if (start < 0) return reply.trim();
  const end = reply.toLowerCase().lastIndexOf('</svg>');
  return (end >= start ? reply.slice(start, end + 6) : reply.slice(start)).trim();
}

// ------------------------------------------------------------------ tolerant XML tokenizer

export interface SvgEl {
  name: string;
  attrs: Record<string, string>;
  children: (SvgEl | string)[];
}

export interface ParsedSvg {
  root: SvgEl | null;
  /** Well-formedness problems found while tokenizing. */
  errors: string[];
  /** True if a DOCTYPE or entity declaration was present (dropped). */
  hadDoctype: boolean;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlCharacter = (code: number) => code === 9 || code === 10 || code === 13 ||
  (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

// Decode XML's predefined entities and numeric references. General entities require a declaration.
const decode = (s: string, errors: string[]) =>
  s.replace(/&(?:(#x[\da-fA-F]+|#\d+|amp|lt|gt|quot|apos);)?/g, (m, e: string | undefined) => {
    if (!e) { errors.push('invalid XML entity reference'); return m; }
    if (e[0] !== '#') return ENT[e];
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!xmlCharacter(code)) { errors.push('invalid XML character reference'); return m; }
    return String.fromCodePoint(code);
  });

/** Tolerant: recovers from mismatched and unclosed tags, recording what was wrong. */
export function parseSvg(text: string): ParsedSvg {
  const errors: string[] = [];
  if (Array.from(text).some(character => !xmlCharacter(character.codePointAt(0)!))) {
    errors.push('invalid XML character');
  }
  const doc: SvgEl = { name: '#doc', attrs: {}, children: [] };
  const appendText = (value: string) => {
    if (/^[ \r\n\t\ufeff]*$/.test(value)) return;
    if (value.includes(']]>')) errors.push('unexpected CDATA terminator');
    if (stack.length === 1) errors.push('text outside the root element');
    else stack[stack.length - 1].children.push(decode(value, errors));
  };
  const stack: SvgEl[] = [doc];
  let hadDoctype = false;
  const qualifiedName = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      appendText(text.slice(i));
      break;
    }
    if (lt > i) appendText(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const e = text.indexOf('-->', lt + 4);
      if (e < 0) { errors.push('unterminated comment'); break; }
      const comment = text.slice(lt + 4, e);
      if (comment.includes('--') || comment.endsWith('-')) errors.push('invalid XML comment');
      i = e + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const e = text.indexOf(']]>', lt + 9);
      if (e < 0 || stack.length === 1) errors.push('invalid CDATA section');
      else stack[stack.length - 1].children.push(text.slice(lt + 9, e));
      i = e < 0 ? n : e + 3;
    } else if (text.startsWith('<?', lt)) {
      const e = text.indexOf('?>', lt + 2);
      if (e < 0) errors.push('unterminated processing instruction');
      else {
        const instruction = text.slice(lt + 2, e);
        const target = instruction.split(/[ \r\n\t]/, 1)[0];
        if (!qualifiedName.test(target)) errors.push('invalid processing instruction');
        if (/^xml$/i.test(target) && (lt !== (text.charCodeAt(0) === 0xfeff ? 1 : 0) ||
            !/^xml\s+version\s*=\s*(["'])1\.[01]\1(?:\s+encoding\s*=\s*(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone\s*=\s*(["'])(?:yes|no)\3)?\s*$/.test(instruction))) {
          errors.push('invalid XML declaration');
        }
      }
      i = e < 0 ? n : e + 2;
    } else if (text.startsWith('<!', lt)) {
      hadDoctype = true;
      let depth = 0, j = lt;
      for (; j < n; j++) {
        if (text[j] === '[') depth++;
        else if (text[j] === ']') depth--;
        else if (text[j] === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt);
      const name = text.slice(lt + 2, e < 0 ? n : e).replace(/[ \r\n\t]+$/, '');
      if (e < 0 || !qualifiedName.test(name)) errors.push('invalid closing tag');
      i = e < 0 ? n : e + 1;
      let k = stack.length - 1;
      while (k > 0 && stack[k].name !== name) k--;
      if (k === 0) errors.push(`unexpected closing tag </${name}>`);
      else {
        for (let u = stack.length - 1; u > k; u--) errors.push(`<${stack[u].name}> is not closed`);
        stack.length = k;
      }
    } else {
      // start tag
      let j = lt + 1;
      const nm = /^[^ \r\n\t/>]+/.exec(text.slice(j, j + 200));
      if (!nm) { errors.push('stray "<"'); i = lt + 1; continue; }
      const name = nm[0];
      if (!qualifiedName.test(name)) errors.push('invalid element name');
      j += name.length;
      const attrs: Record<string, string> = Object.create(null);
      let selfClose = false;
      for (;;) {
        const beforeSpace = j;
        while (j < n && /[ \r\n\t]/.test(text[j])) j++;
        if (j >= n) { errors.push(`unterminated tag <${name}>`); break; }
        if (text[j] === '>') { j++; break; }
        if (text[j] === '/' && text[j + 1] === '>') { selfClose = true; j += 2; break; }
        if (text[j] === '/') { errors.push('unexpected slash in start tag'); j++; continue; }
        const am = /^[^ \r\n\t=/>]+/.exec(text.slice(j, j + 200));
        if (!am) { j++; continue; }
        const an = am[0];
        if (!qualifiedName.test(an)) errors.push('invalid attribute name');
        if (beforeSpace === j) errors.push('expected space before attribute');
        j += an.length;
        while (j < n && /[ \r\n\t]/.test(text[j])) j++;
        let val = '';
        if (text[j] === '=') {
          j++;
          while (j < n && /[ \r\n\t]/.test(text[j])) j++;
          const q = text[j];
          if (q === '"' || q === "'") {
            const e = text.indexOf(q, j + 1);
            if (e < 0) { errors.push(`unterminated attribute ${an}`); val = text.slice(j + 1); j = n; }
            else { val = text.slice(j + 1, e); j = e + 1; }
          } else {
            const um = /^[^\s>]+/.exec(text.slice(j, j + 500));
            val = um ? um[0].replace(/\/$/, '') : '';
            j += um ? um[0].length : 0;
            errors.push(`attribute ${an} is not quoted`);
          }
        }
        else errors.push(`attribute ${an} has no value`);
        if (an in attrs) errors.push(`duplicate attribute ${an} on <${name}>`);
        if (val.includes('<')) errors.push(`attribute ${an} contains an unescaped opening bracket`);
        attrs[an] = decode(val, errors);
      }
      const el: SvgEl = { name, attrs, children: [] };
      stack[stack.length - 1].children.push(el);
      if (!selfClose) {
        if (stack.length > 64) return { root: null, errors: ['SVG nesting exceeds 64 levels'], hadDoctype };
        stack.push(el);
      }
      i = j;
    }
  }
  for (let u = stack.length - 1; u > 0; u--) errors.push(`<${stack[u].name}> is not closed`);
  const tops = doc.children.filter((c): c is SvgEl => typeof c !== 'string');
  if (tops.length > 1) errors.push('more than one root element');
  if (!tops.length) errors.push('no root element');
  return { root: tops[0] ?? null, errors, hadDoctype };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function serialize(el: SvgEl, depth = 0): string {
  const pad = '  '.repeat(depth);
  const at = Object.entries(el.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  const kids = el.children;
  if (!kids.length) return `${pad}<${el.name}${at}/>`;
  if (kids.every((k) => typeof k === 'string')) return `${pad}<${el.name}${at}>${esc(kids.join(''))}</${el.name}>`;
  const inner = kids.map((k) => (typeof k === 'string' ? '' : serialize(k, depth + 1))).filter(Boolean).join('\n');
  return `${pad}<${el.name}${at}>\n${inner}\n${pad}</${el.name}>`;
}

/** Canonical markup for a parsed artwork element or a composed region. */
export function svgElementText(element: SvgEl): string {
  return serialize(element);
}

// ------------------------------------------------------------------ geometry (approximate bounding boxes)

type Mat = [number, number, number, number, number, number]; // a b c d e f
const IDENT: Mat = [1, 0, 0, 1, 0, 0];
const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Mat, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

function parseTransform(t: string | undefined): Mat {
  let m = IDENT;
  if (!t) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(t))) {
    const a = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (a.some((x) => !Number.isFinite(x))) continue;
    let f: Mat = IDENT;
    switch (r[1]) {
      case 'matrix': if (a.length === 6) f = a as Mat; break;
      case 'translate': f = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0]; break;
      case 'scale': f = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const rad = ((a[0] ?? 0) * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
        const rot: Mat = [c, s, -s, c, 0, 0];
        f = a.length >= 3 ? mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]) : rot;
        break;
      }
      case 'skewX': f = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': f = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, f);
  }
  return m;
}

/** Critical points of the rendered arc, using the SVG endpoint-to-centre conversion. */
function arcPoints(from: Vec2, to: Vec2, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, m: Mat): Vec2[] {
  if (!rx || !ry || (from.x === to.x && from.y === to.y)) return [from, to];
  const phi = angle * Math.PI / 180;
  const c = Math.cos(phi), s = Math.sin(phi);
  const dx = (from.x - to.x) / 2, dy = (from.y - to.y) / 2;
  const px = c * dx + s * dy, py = -s * dx + c * dy;
  const scale = Math.max(1, Math.hypot(px / rx, py / ry));
  rx *= scale; ry *= scale;
  const lambda = (px / rx) ** 2 + (py / ry) ** 2;
  const sign = large === sweep ? -1 : 1;
  const k = sign * Math.sqrt(Math.max(0, 1 / lambda - 1));
  const ux = k * (rx / ry) * py, uy = -k * (ry / rx) * px;
  const centre = { x: c * ux - s * uy + (from.x + to.x) / 2, y: s * ux + c * uy + (from.y + to.y) / 2 };
  const start = Math.atan2((py - uy) / ry, (px - ux) / rx);
  const end = Math.atan2((-py - uy) / ry, (-px - ux) / rx);
  const u = { x: c * rx, y: s * rx }, v = { x: -s * ry, y: c * ry };
  const norm = (theta: number) => ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const measure = (theta: number) => norm(sweep ? theta - start : start - theta);
  const span = measure(end);
  const tx = Math.atan2(m[0] * v.x + m[2] * v.y, m[0] * u.x + m[2] * u.y);
  const ty = Math.atan2(m[1] * v.x + m[3] * v.y, m[1] * u.x + m[3] * u.y);
  return [from, to, ...[tx, tx + Math.PI, ty, ty + Math.PI].filter(theta => measure(theta) <= span + 1e-9)
    .map(theta => ({ x: centre.x + u.x * Math.cos(theta) + v.x * Math.sin(theta),
      y: centre.y + u.y * Math.cos(theta) + v.y * Math.sin(theta) }))];
}

/** Path endpoints, Bézier control hulls, and extrema of transformed arcs. */
function pathPoints(d: string, matrix: Mat): Vec2[] {
  const pts: Vec2[] = [];
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0, cmd = '', cx = 0, cy = 0, sx = 0, sy = 0;
  let cubic: Vec2 | undefined, quadratic: Vec2 | undefined;
  const num = () => Number(tokens[i++]);
  const flag = () => {
    const token = tokens[i] ?? '';
    const flag = token[0] === '1';
    if (token.length > 1 && /^[01]/.test(token)) tokens[i] = token.slice(1);
    else i++;
    return flag;
  };
  const has = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();
    if (up === 'Z') { cx = sx; cy = sy; cmd = ''; cubic = quadratic = undefined; continue; }
    if (!has()) continue;
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    const add = (x: number, y: number) => pts.push({ x, y });
    const reflected = (point?: Vec2): Vec2 => point ? { x: 2 * cx - point.x, y: 2 * cy - point.y } : { x: cx, y: cy };
    if (up !== 'C' && up !== 'S') cubic = undefined;
    if (up !== 'Q' && up !== 'T') quadratic = undefined;
    if (up === 'M' || up === 'L') {
      const x = num() + ox, y = num() + oy;
      cx = x; cy = y; add(x, y);
      if (up === 'M') { sx = x; sy = y; cmd = rel ? 'l' : 'L'; }
    } else if (up === 'H') { cx = num() + ox; add(cx, cy); }
    else if (up === 'V') { cy = num() + oy; add(cx, cy); }
    else if (up === 'C' || up === 'S') {
      const first = up === 'C' ? { x: num() + ox, y: num() + oy } : reflected(cubic);
      cubic = { x: num() + ox, y: num() + oy };
      add(first.x, first.y); add(cubic.x, cubic.y);
      cx = num() + ox; cy = num() + oy; add(cx, cy);
    } else if (up === 'Q' || up === 'T') {
      quadratic = up === 'Q' ? { x: num() + ox, y: num() + oy } : reflected(quadratic);
      add(quadratic.x, quadratic.y);
      cx = num() + ox; cy = num() + oy; add(cx, cy);
    } else if (up === 'A') {
      const rx = Math.abs(num()), ry = Math.abs(num()), angle = num();
      const large = flag(), sweep = flag();
      const to = { x: num() + ox, y: num() + oy };
      pts.push(...arcPoints({ x: cx, y: cy }, to, rx, ry, angle, large, sweep, matrix));
      cx = to.x; cy = to.y;
    } else { i++; }
  }
  return pts;
}

interface Bbox { x0: number; y0: number; x1: number; y1: number }
const toRect = (b: Bbox): Rect => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 });

function styleDecl(el: SvgEl, prop: string): string | undefined {
  if (el.attrs[prop] !== undefined) return el.attrs[prop];
  const st = el.attrs.style;
  if (st) {
    for (const d of st.split(';')) {
      const k = d.indexOf(':');
      if (k > 0 && d.slice(0, k).trim().toLowerCase() === prop) return d.slice(k + 1).trim();
    }
  }
  return undefined;
}

/** Approximate content bounds of an element subtree (transforms and stroke width included). */
export function approxBounds(el: SvgEl): Rect | null {
  const box: Bbox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const grow = (p: Vec2, ex: number, ey: number) => {
    box.x0 = Math.min(box.x0, p.x - ex); box.y0 = Math.min(box.y0, p.y - ey);
    box.x1 = Math.max(box.x1, p.x + ex); box.y1 = Math.max(box.y1, p.y + ey);
  };
  const walk = (e: SvgEl, parent: Mat, stroke: string, sw: number) => {
    const m = mul(parent, parseTransform(e.attrs.transform));
    const st = styleDecl(e, 'stroke') ?? stroke;
    const w = Number(styleDecl(e, 'stroke-width') ?? sw);
    if (NON_RENDERED.has(e.name)) return;
    const f = (k: string, d = 0) => (Number.isFinite(Number(e.attrs[k])) && e.attrs[k] !== undefined ? Number(e.attrs[k]) : d);
    const half = st && st !== 'none' && Number.isFinite(w) ? Math.max(0, w) / 2 : 0;
    const strokeX = half * Math.hypot(m[0], m[2]);
    const strokeY = half * Math.hypot(m[1], m[3]);
    let pts: Vec2[] = [];
    switch (e.name) {
      case 'rect': { const x = f('x'), y = f('y'), ww = f('width'), hh = f('height'); pts = [{ x, y }, { x: x + ww, y }, { x, y: y + hh }, { x: x + ww, y: y + hh }]; break; }
      case 'circle': { const cx = f('cx'), cy = f('cy'), r = f('r'); pts = [{ x: cx - r, y: cy - r }, { x: cx + r, y: cy - r }, { x: cx - r, y: cy + r }, { x: cx + r, y: cy + r }]; break; }
      case 'ellipse': { const cx = f('cx'), cy = f('cy'), rx = f('rx'), ry = f('ry'); pts = [{ x: cx - rx, y: cy - ry }, { x: cx + rx, y: cy - ry }, { x: cx - rx, y: cy + ry }, { x: cx + rx, y: cy + ry }]; break; }
      case 'line': pts = [{ x: f('x1'), y: f('y1') }, { x: f('x2'), y: f('y2') }]; break;
      case 'polyline': case 'polygon': {
        const nums = (e.attrs.points ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
        for (let k = 0; k + 1 < nums.length; k += 2) pts.push({ x: nums[k], y: nums[k + 1] });
        break;
      }
      case 'path': pts = pathPoints(e.attrs.d ?? '', m); break;
    }
    for (const p of pts) if (Number.isFinite(p.x) && Number.isFinite(p.y)) grow(apply(m, p), strokeX, strokeY);
    for (const c of e.children) if (typeof c !== 'string') walk(c, m, st, w);
  };
  for (const c of el.children) if (typeof c !== 'string') {
    walk(c, parseTransform(el.attrs.transform), styleDecl(el, 'stroke') ?? 'none', Number(styleDecl(el, 'stroke-width') ?? 1));
  }
  if (DRAWING.has(el.name)) walk(el, IDENT, 'none', 1);
  return box.x1 < box.x0 ? null : toRect(box);
}

// ------------------------------------------------------------------ validation

export type SvgSeverity = 'error' | 'warning';

export interface SvgIssue {
  severity: SvgSeverity;
  code: string;
  message: string;
  nodeId?: string;
}

export interface SvgNodeReport {
  present: boolean;
  elements: number;
  /** Content bounds with transformed path extrema and conservative Bézier control hulls. */
  bounds: Rect | null;
  anchorIn?: Vec2;
  anchorOut?: Vec2;
}

export interface SvgReport {
  /** No errors (warnings allowed). */
  ok: boolean;
  wellFormed: boolean;
  bytes: number;
  issues: SvgIssue[];
  nodes: Record<string, SvgNodeReport>;
  elementCounts: Record<string, number>;
  drawingElements: number;
  forbiddenElements: string[];
  forbiddenAttributes: string[];
  colorsOutsidePalette: string[];
  missingNodes: string[];
  unexpectedGroups: string[];
}

const byteLength = (s: string) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length);

function parsePoint(v: string | undefined): Vec2 | null {
  if (v === undefined) return null;
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*[, ]\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*$/i.exec(v);
  if (!m) return null;
  const p = { x: Number(m[1]), y: Number(m[2]) };
  return Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
function closestPointOnOutline(target: Vec2, outline: Vec2[]): Vec2 {
  let nearest = outline[0];
  let distance = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((target.x - a.x) * dx + (target.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const p = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(target, p);
    if (d < distance) { nearest = p; distance = d; }
  }
  return nearest;
}

function rectOutline({ x, y, w, h }: Rect): Vec2[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

function renderedShapeCount(element: SvgEl): number {
  // Regenerated groups keep their own definitions. The region budget still counts them.
  if (NON_RENDERED.has(element.name)) return 0;
  let count = DRAWING.has(element.name) ? 1 : 0;
  for (const child of element.children) {
    if (typeof child !== 'string') count += renderedShapeCount(child);
  }
  return count;
}

/** Use the drawn primitive when possible. Composite illustrations use the group's outer bounds. */
function groupOutline(group: SvgEl, bounds: Rect): Vec2[] {
  const shapes: Array<{ shape: SvgEl; matrix: Mat }> = [];
  const collect = (el: SvgEl, transform: Mat) => {
    if (NON_RENDERED.has(el.name)) return;
    const matrix = mul(transform, parseTransform(el.attrs.transform));
    if (DRAWING.has(el.name)) shapes.push({ shape: el, matrix });
    for (const child of el.children) if (typeof child !== 'string') collect(child, matrix);
  };
  collect(group, IDENT);
  const primitive = shapes.length === 1 ? shapes[0] : undefined;
  if (!primitive) return rectOutline(bounds);
  const { shape, matrix } = primitive;
  const number = (name: string) => Number(shape.attrs[name] ?? 0);
  if (shape.name === 'ellipse' || shape.name === 'circle') {
    const rx = number(shape.name === 'circle' ? 'r' : 'rx');
    const ry = number(shape.name === 'circle' ? 'r' : 'ry');
    if (rx > 0 && ry > 0) {
      return Array.from({ length: 64 }, (_, index) => {
        const angle = index * Math.PI / 32;
        return apply(matrix, { x: number('cx') + rx * Math.cos(angle), y: number('cy') + ry * Math.sin(angle) });
      });
    }
  }
  if (shape.name === 'rect' && !number('rx') && !number('ry')) {
    return rectOutline({ x: number('x'), y: number('y'), w: number('width'), h: number('height') })
      .map(point => apply(matrix, point));
  }
  return rectOutline(bounds);
}

const SVG_ATTRIBUTES = new Set([
  'xmlns', 'id', 'viewBox', 'preserveAspectRatio', 'overflow',
  'data-anchor-in', 'data-anchor-out', 'x', 'y', 'width', 'height', 'rx', 'ry',
  'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'd', 'points', 'transform',
  'fill', 'fill-rule', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'opacity', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'fr', 'fx', 'fy',
  'offset', 'stop-color', 'stop-opacity', 'href'
]);
const LOCAL_REFERENCE = /^#[a-zA-Z_][\w.:-]*$/;

/** The validator and sanitizer use the same attribute allowlist. */
function badAttribute(name: string, value: string): string | null {
  if (!SVG_ATTRIBUTES.has(name)) return 'unsupported attribute';
  const trimmed = value.trim();
  if (name === 'href') return LOCAL_REFERENCE.test(trimmed) ? null : 'external reference';
  if (value.includes('\\')) return 'escaped attribute';
  if (/url\s*\(/i.test(value)) {
    const match = /^url\(\s*(['"]?)(#[a-zA-Z_][\w.:-]*)\1\s*\)$/i.exec(trimmed);
    if (!match) return 'external or unsupported reference';
  }
  return null;
}

const PAINT_PROPS = ['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color'];

/** Checks an SVG reply against the contract. Never throws; returns a structured report. */
export function validateSvg(svgText: string, expected: SvgSubtreeRequest): SvgReport {
  const limits = { ...DEFAULT_SVG_LIMITS, ...expected.limits };
  const issues: SvgIssue[] = [];
  const add = (severity: SvgSeverity, code: string, message: string, nodeId?: string) => issues.push({ severity, code, message, nodeId });
  const bytes = byteLength(svgText);
  const parsed = bytes <= limits.bytes ? parseSvg(svgText) : { root: null, errors: [], hadDoctype: false };
  const report: SvgReport = {
    ok: false, wellFormed: parsed.errors.length === 0 && !!parsed.root, bytes, issues, nodes: Object.create(null), elementCounts: Object.create(null),
    drawingElements: 0, forbiddenElements: [], forbiddenAttributes: [], colorsOutsidePalette: [], missingNodes: [], unexpectedGroups: [],
  };
  for (const e of parsed.errors) add('error', 'malformed', `Not well-formed XML: ${e}`);
  if (parsed.hadDoctype) add('error', 'doctype', 'DOCTYPE or entity declarations are not allowed');
  if (bytes > limits.bytes) add('error', 'too-large', `SVG is ${bytes} bytes; the limit is ${limits.bytes}`);
  const root = parsed.root;
  if (!root) {
    report.ok = false;
    return report;
  }
  if (root.attrs.xmlns !== 'http://www.w3.org/2000/svg') {
    report.wellFormed = false;
    add('error', 'xml', 'The root must declare the SVG namespace.');
  }
  if (root.name !== 'svg') add('error', 'root', `Root element is <${root.name}>, expected <svg>`);

  // viewBox
  const vb = viewBoxOf(expected.nodes);
  const vbParts = (root.attrs.viewBox ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  if (vbParts.length !== 4 || vbParts.some((x) => !Number.isFinite(x))) add('error', 'viewbox', `Missing or invalid viewBox; expected "${vbText(vb)}"`);
  else if (Math.abs(vbParts[0] - vb.x) > 0.5 || Math.abs(vbParts[1] - vb.y) > 0.5 || Math.abs(vbParts[2] - vb.w) > 0.5 || Math.abs(vbParts[3] - vb.h) > 0.5) {
    add('error', 'viewbox', `viewBox is "${root.attrs.viewBox}", expected "${vbText(vb)}"`);
  }
  if (Object.keys(root.attrs).some((key) => key !== 'viewBox' && key !== 'xmlns')) {
    add('error', 'root-attrs', 'The outer SVG must contain only viewBox and xmlns attributes.');
  }

  // element walk: counts, forbidden things, colours
  const palette: Rgb[] = [];
  for (const p of expected.palette) {
    const c = parseColor(p);
    if (c) palette.push(c);
  }
  const outside = new Map<string, number>();
  const forbiddenEl = new Set<string>();
  const forbiddenAttr = new Set<string>();
  const checkColour = (raw: string) => {
    const v = raw.trim();
    if (isNonColour(v)) return;
    const c = parseColor(v);
    if (!c || !palette.some((p) => colorDistance(p, c) === 0)) outside.set(v.toLowerCase(), (outside.get(v.toLowerCase()) ?? 0) + 1);
  };
  const counts = report.elementCounts;
  let totalElements = 0;
  const visit = (e: SvgEl, nested = false, inheritedFill = '#000000', paints = true) => {
    totalElements++;
    counts[e.name] = (counts[e.name] ?? 0) + 1;
    if (!ALLOWED.has(e.name)) forbiddenEl.add(e.name);
    if (e !== root && e.attrs.xmlns !== undefined && e.attrs.xmlns !== root.attrs.xmlns) {
      add('error', 'xml', 'All elements must use the SVG namespace.');
      report.wellFormed = false;
    }
    if (nested && e.name === 'g' && e.attrs.id?.startsWith('node-')) {
      add('error', 'nested-group', `Group ${e.attrs.id} must be a top-level node group.`);
    }
    const paint = e.attrs.fill?.trim().toLowerCase();
    const fill = !paint || paint === 'inherit' ? inheritedFill : paint === 'currentcolor' ? '#000000' : paint;
    if (paints && DRAWING.has(e.name) && e.name !== 'line') checkColour(fill);
    if (e.name === 'stop' && (!e.attrs['stop-color'] || /^(inherit|currentcolor)$/i.test(e.attrs['stop-color'].trim()))) {
      checkColour('#000000');
    }
    for (const [k, v] of Object.entries(e.attrs)) {
      const bad = badAttribute(k, v);
      if (bad) forbiddenAttr.add(`${e.name}@${k} (${bad})`);
      if (PAINT_PROPS.includes(k)) checkColour(v.trim().toLowerCase() === 'currentcolor' ? '#000000' : v);
    }
    for (const c of e.children) if (typeof c !== 'string') visit(c, e !== root, fill, paints && !NON_RENDERED.has(e.name));
  };
  visit(root);
  if (totalElements > limits.total * 2 + expected.nodes.length + 20) add('error', 'budget-elements', 'SVG has too many elements.');
  report.drawingElements = [...DRAWING].reduce((s, k) => s + (counts[k] ?? 0), 0);
  report.forbiddenElements = [...forbiddenEl];
  report.forbiddenAttributes = [...forbiddenAttr];
  report.colorsOutsidePalette = [...outside.keys()];
  for (const n of forbiddenEl) {
    const code = n === 'text' || n === 'tspan' ? 'text' : 'forbidden-element';
    add('error', code, n === 'text' || n === 'tspan' ? `<${n}> is forbidden: the engine draws all text` : `Element <${n}> is not allowed`);
  }
  for (const a of forbiddenAttr) add('error', 'forbidden-attribute', `Attribute not allowed: ${a}`);
  if (outside.size) add('error', 'palette', `Colours outside the palette: ${[...outside.keys()].join(', ')}`);
  if (report.drawingElements > limits.total) add('error', 'budget-total', `${report.drawingElements} drawing elements; the limit is ${limits.total}`);

  // groups
  const expectedIds = new Map(expected.nodes.map((n) => [n.id, n]));
  const parents = parentsOf(expected.nodes);
  const topEls = root.children.filter((c): c is SvgEl => typeof c !== 'string');
  const groupFor = new Map<string, SvgEl>();
  for (const t of topEls) {
    if (t.name === 'defs') continue;
    const id = t.attrs.id ?? '';
    if (t.name === 'g' && id.startsWith('node-')) {
      const nid = id.slice(5);
      if (groupFor.has(nid)) add('error', 'duplicate-group', `Duplicate group ${id}`, nid);
      else groupFor.set(nid, t);
      if (!expectedIds.has(nid)) {
        report.unexpectedGroups.push(id);
        add('error', 'unexpected-group', `Group ${id} is not a node of this subtree`);
      }
      continue;
    }
    const label = t.name === 'g' ? `<g id="${id}">` : `<${t.name}>`;
    report.unexpectedGroups.push(label);
    if (/connect|link|edge|branch|arrow/i.test(`${id} ${t.attrs.class ?? ''}`)) add('error', 'connector', `${label} looks like a connector group; connectors are drawn by the engine`);
    else add('error', 'top-level', `${label} is outside any node group (only <g id="node-ID"> and <defs> may be at the top level)`);
  }

  const acceptablePoint = (point: Vec2, box: Rect): boolean => {
    const tol = Math.max(3, 0.02 * Math.min(box.w, box.h));
    return point.x >= box.x - tol && point.x <= box.x + box.w + tol &&
      point.y >= box.y - tol && point.y <= box.y + box.h + tol;
  };
  const neighbourPoint = (id: string, key: 'anchorIn' | 'anchorOut', toward: Vec2, context?: SvgNeighbour): Vec2 | undefined => {
    const known = expectedIds.get(id);
    const local = parsePoint(groupFor.get(id)?.attrs[key === 'anchorIn' ? 'data-anchor-in' : 'data-anchor-out']);
    if (local && known && acceptablePoint(local, known.box)) {
      const from = centre(known.box);
      if ((local.x - from.x) * (toward.x - from.x) + (local.y - from.y) * (toward.y - from.y) > 0) return local;
    }
    return context?.[key] ?? context?.centre ?? (known && centre(known.box));
  };
  const diag = (b: Rect) => Math.hypot(b.w, b.h);
  for (const spec of expected.nodes) {
    const g = groupFor.get(spec.id);
    const nr: SvgNodeReport = { present: !!g, elements: 0, bounds: null };
    report.nodes[spec.id] = nr;
    if (!g) {
      report.missingNodes.push(spec.id);
      add('error', 'missing-group', `Missing group <g id="node-${spec.id}">`, spec.id);
      continue;
    }
    nr.elements = renderedShapeCount(g);
    if (nr.elements === 0) add('error', 'empty-group', `Group node-${spec.id} contains no drawing`, spec.id);
    if (nr.elements > limits.perNode) add('error', 'budget-node', `Group node-${spec.id} has ${nr.elements} drawing elements; the limit is ${limits.perNode}`, spec.id);

    const b = approxBounds(g);
    nr.bounds = b;
    const box = spec.box;
    let drawingOverflow = false;
    if (b) {
      const tol = Math.max(1.5, 0.01 * Math.min(box.w, box.h));
      const over = Math.max(box.x - b.x, box.y - b.y, b.x + b.w - (box.x + box.w), b.y + b.h - (box.y + box.h));
      drawingOverflow = over > tol;
      if (drawingOverflow) add('error', 'outside-box', `Group node-${spec.id} extends ${fmt(over)} units outside its box (${vbText(box)}); its bounds are ${vbText(b)}`, spec.id);
      else if (b.w * b.h < 0.1 * box.w * box.h) add('warning', 'underfilled', `Group node-${spec.id} fills under 10% of its box`, spec.id);
    }
    for (const c of g.children) if (typeof c !== 'string' && /connect|link|edge|arrow/i.test(`${c.attrs.id ?? ''} ${c.attrs.class ?? ''}`)) add('warning', 'connector', `Element in node-${spec.id} looks like a connector (${c.attrs.id ?? c.attrs.class})`, spec.id);

    const outline = b && !drawingOverflow ? groupOutline(g, b) : undefined;
    const edgeTol = Math.max(6, 0.08 * Math.min(box.w, box.h));
    const checkAnchor = (key: 'data-anchor-in' | 'data-anchor-out'): Vec2 | null => {
      const p = parsePoint(g.attrs[key]);
      if (!p) { if (g.attrs[key] !== undefined) add('error', 'anchor-format', `${key} of node-${spec.id} must be "x,y" numbers, got "${g.attrs[key]}"`, spec.id); return null; }
      if (!acceptablePoint(p, box)) {
        add('error', 'anchor-outside', `${key} ${p.x},${p.y} of node-${spec.id} is outside its box`, spec.id);
        return null;
      }
      if (outline && dist(p, closestPointOnOutline(p, outline)) > edgeTol) {
        add('error', 'anchor-off-edge', `${key} of node-${spec.id} must lie within ${fmt(edgeTol)} units of the drawing boundary`, spec.id);
        return null;
      }
      return p;
    };
    const aIn = checkAnchor('data-anchor-in');
    if (!aIn && g.attrs['data-anchor-in'] === undefined) add('error', 'anchor-missing', `node-${spec.id} has no data-anchor-in`, spec.id);
    const hasKids = parents.has(spec.id);
    const aOut = checkAnchor('data-anchor-out');
    if (hasKids && !aOut && g.attrs['data-anchor-out'] === undefined) add('error', 'anchor-missing', `node-${spec.id} has children but no data-anchor-out`, spec.id);
    if (!hasKids && g.attrs['data-anchor-out'] !== undefined) add('error', 'anchor-leaf', `Leaf node-${spec.id} should omit data-anchor-out`, spec.id);
    nr.anchorIn = aIn ?? undefined;
    nr.anchorOut = aOut ?? undefined;
    if (aIn && aOut) {
      const min = limits.anchorSeparation * diag(box);
      if (dist(aIn, aOut) < min) add('error', 'anchors-coincide', `data-anchor-in and data-anchor-out of node-${spec.id} are ${fmt(dist(aIn, aOut))} apart; they must differ by at least ${fmt(min)}`, spec.id);
    }
    const parentTarget = spec.parentId ? neighbourPoint(spec.parentId, 'anchorOut', centre(box), spec.parent) : spec.parent?.anchorOut ?? spec.parent?.centre;
    const children: SvgNeighbour[] = spec.children ?? expected.nodes.filter(node => node.parentId === spec.id);
    const childTarget = meanPoint(children.flatMap(child => {
      const target = neighbourPoint(child.id, 'anchorIn', centre(box), child);
      return target ? [target] : [];
    }));
    const sameSide = parentTarget && childTarget && sideFacing(box, parentTarget) === sideFacing(box, childTarget);
    const near = (key: 'data-anchor-in' | 'data-anchor-out', anchor: Vec2 | null, target: Vec2 | undefined, relation: string) => {
      if (!anchor || !target || !outline || dist(target, centre(box)) <= edgeTol) return;
      const nearest = closestPointOnOutline(target, outline);
      const allowance = edgeTol + (sameSide ? limits.anchorSeparation * diag(box) * 0.7 : 0);
      if (dist(anchor, nearest) > allowance) {
        add('error', 'anchor-side', `${key} of node-${spec.id} must be near ${fmt(nearest.x)},${fmt(nearest.y)} on the boundary facing ${relation}`, spec.id);
      }
    };
    const separation = aIn && aOut ? dist(aIn, aOut) : undefined;
    if (separation === undefined || separation > 0 && separation >= limits.anchorSeparation * diag(box)) {
      near('data-anchor-in', aIn, parentTarget, 'the parent anchor');
      near('data-anchor-out', aOut, childTarget, 'the children');
    }
  }
  report.ok = !issues.some((i) => i.severity === 'error');
  return report;
}

// ------------------------------------------------------------------ sanitiser

/**
 * Removes everything the contract forbids and returns safe SVG text: elements outside the allow-list (with their
 * content), event handlers, non-fragment hrefs, external `url()` references, unsafe style attributes, filters,
 * comments, doctype, and root width/height. Returns an empty string when there is no <svg> root. It does not fix
 * contract violations such as connectors or palette; use `validateSvg` for those.
 */
export function sanitizeSvg(svgText: string): string {
  return sanitizeSvgDetailed(svgText).svg;
}

export function sanitizeSvgDetailed(svgText: string): { svg: string; removed: string[] } {
  const removed: string[] = [];
  const { root } = parseSvg(extractSvg(svgText));
  if (!root || root.name !== 'svg') return { svg: '', removed: ['no <svg> root'] };
  const clean = (e: SvgEl): SvgEl | null => {
    if (!ALLOWED.has(e.name)) {
      removed.push(`<${e.name}>`);
      return null;
    }
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(e.attrs)) {
      if (!/^[A-Za-z_][\w.:-]*$/.test(k)) { removed.push(`${e.name}@${k}`); continue; }
      if (k.startsWith('xmlns')) continue;
      const bad = badAttribute(k, v);
      if (bad) { removed.push(`${e.name}@${k} (${bad})`); continue; }
      if (e.name === 'svg' && (k === 'width' || k === 'height')) { removed.push(`svg@${k}`); continue; }
      attrs[k] = v;
    }
    const children: (SvgEl | string)[] = [];
    for (const c of e.children) {
      if (typeof c === 'string') { if (e.name === 'title' || e.name === 'desc') children.push(c); continue; }
      const k = clean(c);
      if (k) children.push(k);
    }
    return { name: e.name, attrs, children };
  };
  const out = clean(root);
  if (!out) return { svg: '', removed };
  out.attrs = { xmlns: 'http://www.w3.org/2000/svg', ...out.attrs };
  return { svg: serialize(out), removed };
}

/** Split a validated SVG into standalone vector assets so nodes can move or collapse independently. */
export function svgNodeAssets(svg: string, request: SvgSubtreeRequest, report: SvgReport): Map<string, string> {
  const assets = new Map<string, string>();
  if (!report.ok) return assets;
  const { root } = parseSvg(sanitizeSvg(svg));
  if (!root) return assets;
  const elements = root.children.filter((child): child is SvgEl => typeof child !== 'string');
  const defs = elements.filter((child) => child.name === 'defs');
  const groups = new Map(elements.filter((child) => child.name === 'g').map((group) => [group.attrs.id, group]));
  for (const spec of request.nodes) {
    const group = groups.get(`node-${spec.id}`);
    if (!group) continue;
    const { w, h } = spec.box;
    assets.set(spec.id, serialize({
      name: 'svg',
      attrs: { xmlns: 'http://www.w3.org/2000/svg', viewBox: vbText(spec.box),
        width: fmt(w), height: fmt(h), overflow: 'hidden' },
      children: [...defs, group]
    }));
  }
  return assets;
}

/** Fit groups with geometric overflow before consuming a repair request. Other errors stay visible. */
export function fitSvgGroups(text: string, request: SvgSubtreeRequest, report: SvgReport): string | undefined {
  const overflow = new Set(report.issues.flatMap((issue) =>
    issue.code === 'outside-box' && issue.nodeId ? [issue.nodeId] : []));
  if (!overflow.size || report.issues.some((issue) => issue.severity === 'error' && !issue.nodeId)) return;
  const { root } = parseSvg(text);
  if (!root) return;
  const expected = new Map(request.nodes.map((node) => [node.id, node.box]));
  let changed = false;
  for (const item of root.children) {
    if (typeof item === 'string' || item.name !== 'g') continue;
    const id = item.attrs.id?.slice(5);
    if (!id || !overflow.has(id)) continue;
    const b = report.nodes[id]?.bounds;
    const slot = expected.get(id);
    if (!b || !slot || b.w <= 0 || b.h <= 0) continue;
    const scale = Math.min(1, Math.max(1, slot.w - 4) / b.w, Math.max(1, slot.h - 4) / b.h);
    const from = centre(b);
    const to = centre(slot);
    const x = to.x - from.x * scale, y = to.y - from.y * scale;
    item.attrs.transform = `translate(${x} ${y}) scale(${scale}) ${item.attrs.transform ?? ''}`.trim();
    for (const key of ['data-anchor-in', 'data-anchor-out']) {
      const anchor = parsePoint(item.attrs[key]);
      if (anchor) item.attrs[key] = `${fmt(anchor.x * scale + x)},${fmt(anchor.y * scale + y)}`;
    }
    changed = true;
  }
  return changed ? serialize(root) : undefined;
}

// ------------------------------------------------------------------ repair

/**
 * Prompt for one bounded repair round: the previous SVG, the numbered problems from the validator, and the same
 * contract. Call at most twice, then keep the best result or fall back (spec: bounded repair loop).
 */
export function buildSvgRepairPrompt(previousSvg: string, report: SvgReport, request?: SvgSubtreeRequest): PromptPair {
  const limits = { ...DEFAULT_SVG_LIMITS, ...request?.limits };
  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  const base = request ? buildSvgSubtreePrompt(request) : null;
  const list = (issues: SvgIssue[]) => issues.slice(0, 30).map((i, k) => `${k + 1}. [${i.code}]${i.nodeId ? ` node ${i.nodeId}:` : ''} ${i.message}`).join('\n');
  return {
    templateVersion: svgRepairTemplate.version,
    instructions: svgInstructions(svgRepairTemplate, limits, svgRepairTemplate.style),
    prompt: fill(svgRepairTemplate.task, {
      errors: list(errors) || '(none)',
      warnings: warnings.length ? `\n\nAlso improve these if possible:\n${list(warnings)}` : '',
      original: base ? `\n\nThe original task:\n${base.prompt}` : '',
      previous: previousSvg.length > 60_000 ? `${previousSvg.slice(0, 60_000)}\n<!-- truncated -->` : previousSvg
    })
  };
}
