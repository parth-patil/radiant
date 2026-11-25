import { parseMarkdownOutline } from './markdown';
import { decodeEntities } from './xml';
import { createDoc, validateDoc } from '../model/doc';
import { addLink, outlineInsertOps, setSide, setStyle } from '../model/commands';
import { applyOps } from '../model/ops';
import { getTheme, listThemes } from '../model/themes';
import { THEME_BRANCHES, THEME_SHAPES, parseThemeSettings } from '../model/theme-settings';
import { createStyleResolver } from '../geometry/style';
import { autoTour, type TourGranularity } from '../model/presentation';
import { canvasElementProblems, presentationProblems } from '../model/doc';
import { treeThemes } from '../model/generated-style';
import { settleLayout } from '../layout/placement';
import { overlaps } from '../layout/occupancy';
import { nodeSize, type FontSpec, type MeasureFn } from '../geometry/style';
import { elementBand, resolveCanvasPoints } from '../geometry/canvas-scene';
import { elementBounds } from '../geometry/spatial';
import type {
  BranchStyle, CanvasBinding, CanvasElement, CanvasElementKind, Doc, LayoutKind, MapNode, NodeBox, NodeId, NodeShape,
  NodeStyle, Op, OutlineNode, Presentation, PresentationStep, Rect, RootInfo, RootSpacing, Size, Theme
} from '../types';

/**
 * Radiant map spec, version 1 (agent tooling, implementation spec 8.1).
 *
 * A spec is a Markdown outline with optional front matter, trailing {…} attribute blocks and a fenced links block
 * (".map.md"), or the nested JSON twin {@link MapSpec}. Both parse to the same validated MapSpec, which compiles
 * to existing Op values. Pure TypeScript: callers read files and resolve picture assets.
 */

export const MAP_SPEC_VERSION = 1;

export const SPEC_LIMITS = {
  labelBytes: 1_000,
  noteBytes: 65_536,
  stickerBytes: 64,
  hrefBytes: 2_048,
  tagBytes: 64,
  tags: 32,
  nodes: 20_000,
  links: 5_000,
  specBytes: 8 * 1024 * 1024
} as const;

export type SpecTask = 'open' | 'done';

/** One node of the nested JSON twin. Attribute names match the Markdown attribute block. */
export interface MapSpecNode {
  label: string;
  id?: string;
  note?: string;
  task?: SpecTask;
  color?: string;
  text?: string;
  fill?: string;
  shape?: NodeShape;
  branch?: BranchStyle;
  width?: number;
  bold?: boolean;
  italic?: boolean;
  size?: number;
  font?: string;
  align?: 'left' | 'center' | 'right';
  emphasis?: 0 | 1 | 2;
  curved?: boolean;
  boundary?: boolean;
  extruded?: boolean;
  sticker?: string;
  tags?: string[];
  href?: string;
  folded?: boolean;
  side?: 'left' | 'right';
  layout?: LayoutKind;
  spacing?: RootSpacing;
  organic?: boolean;
  image?: string;
  alt?: string;
  scale?: number;
  offset?: [number, number];
  pin?: [number, number];
  children?: MapSpecNode[];
}

export interface MapSpecLink {
  from: string;
  to: string;
  label?: string;
  dash?: 'solid' | 'dashed';
  arrows?: 'none' | 'start' | 'end' | 'both';
  color?: string;
}

/** One step of a presentation block: "ids : title {frame= build= dim= note= caption= seconds=}". */
export interface MapSpecStep {
  focus: string[];
  id?: string;
  title?: string;
  reveal?: string[];
  hide?: string[];
  elements?: string[];
  frame?: PresentationStep['frame'];
  build?: PresentationStep['build'];
  dim?: PresentationStep['dim'];
  caption?: string;
  note?: string;
  transition?: PresentationStep['transition'];
  skip?: boolean;
  seconds?: number;
}

/** A fenced presentation block (AGT-EXT-02): steps, or "auto levels" for a tour computed at build time. */
export interface MapSpecPresentation {
  name: string;
  id?: string;
  reveal?: Presentation['reveal'];
  context?: Presentation['context'];
  dimOpacity?: number;
  motion?: Presentation['motion'];
  targetMinutes?: number;
  auto?: TourGranularity;
  steps?: MapSpecStep[];
}

/**
 * One line of a fenced canvas block (AGT-EXT-05): "kind #id at=x,y size=wxh {attributes} : text". Fields are the
 * CanvasElement fields; from/to bind a line or arrow end to a node or element id; image names a front-matter asset.
 */
export type MapSpecElement = { kind: CanvasElementKind; id?: string; from?: string; to?: string; image?: string } &
  Partial<Omit<CanvasElement, 'id' | 'kind' | 'asset' | 'source'>>;

/** The nested JSON twin of a ".map.md" spec. */
export interface MapSpec {
  radiant?: 1;
  title?: string;
  theme?: string;
  themeSettings?: Record<string, unknown>;
  layout?: LayoutKind;
  spacing?: RootSpacing;
  seed?: number;
  tagColors?: Record<string, string>;
  /** Asset name to a local file path (relative to the spec) or "sha256:<hash>" of an asset embedded in a source map. */
  assets?: Record<string, string>;
  roots: MapSpecNode[];
  links?: MapSpecLink[];
  presentations?: MapSpecPresentation[];
  canvas?: MapSpecElement[];
}

export interface SpecLocation {
  line?: number;
  column?: number;
  /** JSON path for the nested JSON twin, e.g. roots[0].children[2].shape */
  path?: string;
}

export interface SpecDiagnostic extends SpecLocation {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  suggestions?: string[];
  hint?: string;
}

export interface ParsedMapSpec {
  spec: MapSpec;
  diagnostics: SpecDiagnostic[];
  /** Source location of a node or link of {@link spec}, or of one of its attributes. */
  locate(item: MapSpecNode | MapSpecLink | MapSpecPresentation | MapSpecStep | MapSpecElement, attribute?: string): SpecLocation;
}

export interface ResolvedSpecAsset {
  hash: string;
  /** Width / height of the picture, when known. */
  aspect?: number;
}

export interface ParseSpecOptions {
  /** Apply offset= and pin= attributes. Without it they are ignored with a warning. */
  allowGeometry?: boolean;
}

export interface CompileSpecOptions {
  /** ISO time for created and modified. Default: now. Fix it for byte-identical builds. */
  now?: string;
  /** Title when the spec has none (for example the file name). Default: the first root label. */
  defaultTitle?: string;
  /** Turn every warning into an error. */
  strict?: boolean;
  /** Assets resolved by the caller, by name. Images that name an unresolved asset are errors. */
  assets?: Record<string, ResolvedSpecAsset>;
}

export interface SpecBuildSummary {
  roots: number;
  nodes: number;
  depth: number;
  links: number;
  assets: number;
  /** Canvas elements and presentations in the spec. */
  elements?: number;
  presentations?: number;
  ids: { explicit: number; derived: number };
  /** Derived ids with their labels and source locations (first 200). */
  assigned: { id: string; label: string; line?: number; path?: string }[];
}

export interface CompiledMapSpec {
  doc: Doc | null;
  diagnostics: SpecDiagnostic[];
  summary: SpecBuildSummary;
}

// ====================================================================== shared vocabulary

const ALL_LAYOUTS: Record<LayoutKind, true> = {
  mindmap: true, right: true, left: true, down: true, up: true, compact: true, radial: true, outline: true,
  timeline: true, columns: true, grid: true, popcorn: true
};
/** Every root layout, in the order of the spec table. */
export const SPEC_LAYOUTS = Object.keys(ALL_LAYOUTS) as LayoutKind[];
/** Layouts a main branch can override (tree layouts). */
export const SPEC_BRANCH_LAYOUTS: readonly LayoutKind[] = ['mindmap', 'right', 'left', 'down', 'up', 'compact', 'radial', 'outline'];
export const SPEC_SPACINGS: readonly RootSpacing[] = ['narrow', 'default', 'wide'];
export const SPEC_ALIGNMENTS = ['left', 'center', 'right'] as const;
export const SPEC_DASHES = ['solid', 'dashed'] as const;
export const SPEC_ARROWS = ['none', 'start', 'end', 'both'] as const;
export const SPEC_SIDES = ['left', 'right'] as const;
export const SPEC_SHAPES: readonly NodeShape[] = THEME_SHAPES;
export const SPEC_BRANCHES: readonly BranchStyle[] = THEME_BRANCHES;

/** Node attribute names accepted in a Markdown attribute block and as keys of a JSON node. */
export const SPEC_NODE_ATTRIBUTES = [
  'id', 'color', 'text', 'fill', 'shape', 'branch', 'width', 'bold', 'italic', 'size', 'font', 'align', 'emphasis',
  'curved', 'boundary', 'extruded', 'sticker', 'tags', 'href', 'folded', 'side', 'layout', 'spacing', 'organic',
  'image', 'alt', 'scale', 'note', 'task', 'offset', 'pin'
] as const;
export const SPEC_FRONT_MATTER_KEYS = [
  'radiant', 'title', 'theme', 'themeSettings', 'layout', 'spacing', 'seed', 'tagColors', 'assets'
] as const;
/** Attributes that would place or size a node. Ignored with a warning: the layout engine computes geometry. */
export const SPEC_GEOMETRY_ATTRIBUTES = ['x', 'y', 'w', 'h', 'height', 'top', 'left', 'position', 'pos', 'rotation'] as const;
export const SPEC_LINK_ATTRIBUTES = ['dash', 'arrows', 'color'] as const;
/** Fenced blocks besides links: presentations (AGT-EXT-02) and canvas elements (AGT-EXT-05). */
export const SPEC_RESERVED_BLOCKS = ['presentation', 'canvas'] as const;
/** Attributes of a presentation block's info string. */
export const SPEC_PRESENTATION_ATTRIBUTES = ['name', 'id', 'reveal', 'context', 'opacity', 'motion', 'minutes'] as const;
/** Attributes of one step line. */
export const SPEC_STEP_ATTRIBUTES = ['id', 'frame', 'build', 'dim', 'note', 'caption', 'seconds', 'reveal', 'hide', 'elements', 'transition', 'skip', 'title'] as const;
export const SPEC_CANVAS_KINDS: readonly CanvasElementKind[] = ['rect', 'ellipse', 'diamond', 'line', 'arrow', 'draw', 'text', 'note', 'frame', 'image'];
/** Attributes of one canvas line (CanvasElement field names, plus at, size, rotate, from, to and image). */
export const SPEC_CANVAS_ATTRIBUTES = [
  'id', 'at', 'size', 'x', 'y', 'w', 'h', 'rotate', 'angle', 'band', 'stroke', 'fill', 'fillStyle', 'strokeWidth', 'strokeStyle',
  'roughness', 'round', 'opacity', 'seed', 'locked', 'groups', 'frame', 'link', 'text', 'fontSize', 'font', 'align', 'textColor',
  'points', 'pressures', 'from', 'to', 'from-at', 'to-at', 'from-gap', 'to-gap', 'startHead', 'endHead', 'elbow', 'image'
] as const;
const STEP_FRAMES = ['nodes', 'subtree', 'map'] as const;
const STEP_BUILDS = ['all', 'each'] as const;
const STEP_DIMS = ['others', 'none'] as const;
const STEP_TRANSITIONS = ['glide', 'cut'] as const;
const TOUR_KINDS: readonly TourGranularity[] = ['branches', 'levels', 'nodes'];
const PRESENTATION_REVEALS = ['progressive', 'all'] as const;
const PRESENTATION_CONTEXTS = ['dim', 'hide'] as const;
const PRESENTATION_MOTIONS = ['full', 'gentle', 'none'] as const;
const ELEMENT_FILL_STYLES = ['solid', 'hachure', 'cross-hatch', 'zigzag'] as const;
const ELEMENT_STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
const ELEMENT_FONTS = ['theme', 'hand', 'code'] as const;
const ELEMENT_HEADS = ['none', 'arrow', 'dot', 'bar'] as const;
const ELEMENT_BANDS = ['back', 'front'] as const;
const MAX_COORDINATE = 1e7;

export const SPEC_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const ASSET_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const CONTROLS = /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}]/u;
const FONT = /^[-\w ,'"]{1,200}$/;
const MAX_BRANCH_WIDTH = 64;

const utf8 = new TextEncoder();
const byteLength = (s: string) => utf8.encode(s).length;

/** Theme ids accepted by "theme:", always taken from the registered themes. */
export function specThemeIds(): string[] {
  return listThemes().map((theme) => theme.id);
}

// ====================================================================== suggestions

/** Edit distance with adjacent transpositions (optimal string alignment), case-insensitive. */
export function editDistance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 0;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push(new Array<number>(b.length + 1).fill(0));
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, rows[i - 2][j - 2] + 1);
      rows[i][j] = d;
    }
  }
  return rows[a.length][b.length];
}

/** Up to max candidates closest to input: exact, prefix and substring matches first, then small edit distances. */
export function suggest(input: string, candidates: Iterable<string>, max = 3): string[] {
  const q = input.toLowerCase();
  const scored: [number, string][] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const lc = c.toLowerCase();
    let score: number;
    if (lc === q) score = 0;
    else if (q.length >= 2 && (lc.startsWith(q) || q.startsWith(lc))) score = 0.5;
    else if (q.length >= 3 && lc.includes(q)) score = 0.8;
    else {
      const d = editDistance(q, lc);
      if (d > Math.max(1, Math.round(Math.max(q.length, lc.length) * 0.4))) continue;
      score = d;
    }
    scored.push([score, c]);
  }
  scored.sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
  return scored.slice(0, max).map(([, c]) => c);
}

// ====================================================================== deterministic hashing

/** 53-bit string hash (cyrb53). Stable across platforms; used for derived ids. */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

const hashId = (prefix: string, key: string, length = 8) =>
  prefix + hash53(key).toString(36).padStart(11, '0').slice(-length);

// ====================================================================== front matter (restricted YAML subset)

type FrontValue = string | number | boolean | null | FrontValue[] | { [key: string]: FrontValue };
interface FrontEntry { key: string; value: FrontValue; line: number; column: number }

class FlowError extends Error {
  constructor(message: string, readonly offset: number) { super(message); }
}

/** Flow value: JSON-like {a: 1, "b": [x, y]}, quoted strings, numbers, true, false, null, or plain text. */
function parseFlow(text: string, start: number, stop: string): [FrontValue, number] {
  let i = start;
  const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; };
  const value = (terminators: string): FrontValue => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const out: Record<string, FrontValue> = {};
      ws();
      if (text[i] === '}') { i++; return out; }
      for (;;) {
        ws();
        let key: string;
        if (text[i] === '"' || text[i] === "'") key = String(quoted());
        else {
          const m = /^[^:,{}[\]\s][^:,{}[\]]*/.exec(text.slice(i));
          if (!m) throw new FlowError('Expected a key', i);
          key = m[0].trim();
          i += m[0].length;
        }
        ws();
        if (text[i] !== ':') throw new FlowError('Expected ":" after "' + key + '"', i);
        i++;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new FlowError('Reserved key ' + key, i);
        out[key] = value(',}');
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return out; }
        throw new FlowError('Expected "," or "}"', i);
      }
    }
    if (c === '[') {
      i++;
      const out: FrontValue[] = [];
      ws();
      if (text[i] === ']') { i++; return out; }
      for (;;) {
        out.push(value(',]'));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return out; }
        throw new FlowError('Expected "," or "]"', i);
      }
    }
    if (c === '"' || c === "'") return quoted();
    let j = i;
    while (j < text.length && !terminators.includes(text[j]) && !(text[j] === '#' && /\s/.test(text[j - 1] ?? ' '))) j++;
    const raw = text.slice(i, j).trim();
    i = j;
    return scalar(raw);
  };
  const quoted = (): string => {
    const q = text[i];
    let j = i + 1;
    let out = '';
    if (q === "'") {
      for (;;) {
        if (j >= text.length) throw new FlowError('Unterminated string', i);
        if (text[j] === "'") {
          if (text[j + 1] === "'") { out += "'"; j += 2; continue; }
          break;
        }
        out += text[j++];
      }
      i = j + 1;
      return out;
    }
    for (;;) {
      if (j >= text.length) throw new FlowError('Unterminated string', i);
      if (text[j] === '\\') { j += 2; continue; }
      if (text[j] === '"') break;
      j++;
    }
    try { out = JSON.parse(text.slice(i, j + 1)) as string; } catch { throw new FlowError('Invalid escape in string', i); }
    i = j + 1;
    return out;
  };
  const result = value(stop);
  return [result, i];
}

function scalar(raw: string): FrontValue {
  if (raw === '' || raw === '~' || raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(raw)) return Number(raw);
  return raw;
}

/**
 * Restricted YAML: "key: value" lines, nested block mappings by indentation, "- item" block sequences,
 * flow collections and quoted strings. No anchors, tags, multi-line scalars or documents.
 */
function parseFrontMatter(lines: string[], firstLine: number, diag: (d: SpecDiagnostic) => void): FrontEntry[] {
  interface Row { indent: number; text: string; line: number }
  const rows: Row[] = [];
  lines.forEach((raw, k) => {
    if (!raw.trim() || /^\s*#/.test(raw)) return;
    const indent = /^ */.exec(raw)![0].length;
    if (raw[indent] === '\t') diag({ severity: 'error', code: 'front_matter_syntax', line: firstLine + k, column: indent + 1,
      message: 'Front matter is indented with a tab; use spaces.' });
    rows.push({ indent, text: raw.slice(indent).replace(/\s+$/, ''), line: firstLine + k });
  });
  let at = 0;
  const topLines = new Map<string, number>();
  const flow = (row: Row, text: string, offset: number): FrontValue => {
    try {
      const [value, end] = parseFlow(text, 0, '');
      if (text.slice(end).trim() && !/^\s+#/.test(text.slice(end))) throw new FlowError('Unexpected text', end);
      return value;
    } catch (e) {
      const where = e instanceof FlowError ? e.offset : 0;
      diag({ severity: 'error', code: 'front_matter_syntax', line: row.line, column: row.indent + offset + where + 1,
        message: 'Front matter value could not be read: ' + (e instanceof Error ? e.message : String(e)) + '.' });
      return null;
    }
  };
  const block = (indent: number): FrontValue => {
    if (at < rows.length && rows[at].indent >= indent && rows[at].text.startsWith('- ')) {
      const list: FrontValue[] = [];
      const own = rows[at].indent;
      while (at < rows.length && rows[at].indent === own && (rows[at].text === '-' || rows[at].text.startsWith('- '))) {
        const row = rows[at++];
        list.push(flow(row, row.text.slice(2), 2));
      }
      return list;
    }
    const map: Record<string, FrontValue> = {};
    if (at >= rows.length) return map;
    const own = rows[at].indent;
    if (own < indent) return map;
    while (at < rows.length && rows[at].indent === own) {
      const row = rows[at++];
      const m = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:#\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(row.text);
      if (!m) {
        diag({ severity: 'error', code: 'front_matter_syntax', line: row.line, column: row.indent + 1,
          message: 'Expected "key: value" in the front matter.' });
        continue;
      }
      let key = m[1];
      if (key.startsWith('"')) key = JSON.parse(key) as string;
      else if (key.startsWith("'")) key = key.slice(1, -1);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (own === 0) topLines.set(key, row.line);
      const rest = m[2]?.trim() ?? '';
      if (rest && !rest.startsWith('#')) map[key] = flow(row, rest, row.text.length - m[2]!.length);
      else if (at < rows.length && rows[at].indent > own) map[key] = block(own + 1);
      else map[key] = null;
    }
    return map;
  };
  const entries: FrontEntry[] = [];
  while (at < rows.length) {
    const row = rows[at];
    if (row.indent !== 0) {
      diag({ severity: 'error', code: 'front_matter_syntax', line: row.line, column: 1,
        message: 'Unexpected indentation in the front matter.' });
      at++;
      continue;
    }
    const before = at;
    const map = block(0) as Record<string, FrontValue>;
    for (const [key, value] of Object.entries(map)) entries.push({ key, value, line: topLines.get(key) ?? row.line, column: 1 });
    if (at === before) at++;
  }
  return entries;
}

// ====================================================================== attribute blocks

interface AttrToken { key: string; value: string | true; column: number }

/**
 * Parse "{#id key=value key="quoted value" flag}" starting at text[start] === '{' and ending at the last
 * character of text. Returns null when it is not a well-formed block (the braces are then part of the label).
 */
function parseAttrBlock(text: string, start: number): AttrToken[] | null {
  const tokens: AttrToken[] = [];
  let i = start + 1;
  const end = text.length - 1;
  if (text[end] !== '}') return null;
  for (;;) {
    while (i < end && /\s/.test(text[i])) i++;
    if (i === end) return tokens;
    const column = i;
    let key: string;
    let value: string | true = true;
    if (text[i] === '#' || text[i] === '.') {
      key = text[i];
      let j = i + 1;
      while (j < end && !/[\s{}"=]/.test(text[j])) j++;
      if (j === i + 1) return null;
      value = text.slice(i + 1, j);
      i = j;
    } else {
      const m = /^[A-Za-z_][\w-]*/.exec(text.slice(i, end));
      if (!m) return null;
      key = m[0];
      i += key.length;
      if (text[i] === '=') {
        i++;
        if (text[i] === '"') {
          let j = i + 1;
          while (j < end && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
          if (j >= end) return null;
          try { value = JSON.parse(text.slice(i, j + 1)) as string; } catch { return null; }
          i = j + 1;
        } else {
          let j = i;
          while (j < end && !/[\s{}"]/.test(text[j])) j++;
          value = text.slice(i, j);
          i = j;
        }
      }
    }
    if (i < end && !/\s/.test(text[i])) return null;
    tokens.push({ key, value, column });
  }
}

/** Split a raw label into text and its trailing attribute block, if any. */
function splitAttributes(raw: string): { text: string; attrs: AttrToken[]; offset: number } {
  const trimmed = raw.replace(/\s+$/, '');
  if (!trimmed.endsWith('}')) return { text: raw, attrs: [], offset: 0 };
  for (let k = trimmed.lastIndexOf('{'); k >= 0; k = k > 0 ? trimmed.lastIndexOf('{', k - 1) : -1) {
    if (k > 0 && !/\s/.test(trimmed[k - 1])) continue;
    const attrs = parseAttrBlock(trimmed, k);
    if (attrs) return { text: trimmed.slice(0, k), attrs, offset: 0 };
  }
  return { text: raw, attrs: [], offset: 0 };
}

// ====================================================================== validation shared by both spec forms

type NodeLocation = SpecLocation & { attrs?: Record<string, number> };

class SpecReader {
  readonly diagnostics: SpecDiagnostic[] = [];
  readonly locations = new Map<object, NodeLocation>();
  constructor(readonly opts: ParseSpecOptions) {}

  report(d: SpecDiagnostic): void {
    if (this.diagnostics.length < 500) this.diagnostics.push(d);
  }

  where(item: object, attribute?: string): SpecLocation {
    const loc = this.locations.get(item);
    if (!loc) return {};
    if (attribute === undefined) return { line: loc.line, column: loc.column, path: loc.path };
    return {
      line: loc.line,
      column: loc.attrs?.[attribute] ?? loc.column,
      path: loc.path !== undefined ? loc.path + '.' + attribute : undefined
    };
  }

  locate = (item: MapSpecNode | MapSpecLink | MapSpecPresentation | MapSpecStep | MapSpecElement, attribute?: string): SpecLocation =>
    this.where(item, attribute);

  text(kind: string, value: string, limit: number, loc: SpecLocation): boolean {
    const at: SpecLocation = { line: loc.line, column: loc.column, path: loc.path };
    if (CONTROLS.test(value)) {
      this.report({ severity: 'error', code: 'control_characters', ...at, message: kind + ' contains control characters.' });
      return false;
    }
    const size = byteLength(value);
    if (size > limit) {
      this.report({ severity: 'error', code: kind.toLowerCase().replace(/\s+/g, '_') + '_too_long', ...at,
        message: kind + ' is ' + size + ' bytes; the limit is ' + limit + '.', hint: 'Shorten it or move detail into a child node.' });
      return false;
    }
    return true;
  }

  invalid(name: string, value: unknown, choices: readonly (string | number)[] | string, at: SpecLocation, subject: string): void {
    const list = typeof choices === 'string' ? undefined : choices.map(String);
    this.report({
      severity: 'warning', code: 'invalid_value', ...at,
      message: 'Invalid ' + name + ' "' + String(value) + '" on ' + subject + '; ' +
        (list ? 'valid values are ' + list.join(', ') : choices) + '. The attribute was ignored.',
      suggestions: list ? suggest(String(value), list) : undefined
    });
  }

  /** Front matter key, from Markdown or from the top level of the JSON twin. */
  front(spec: MapSpec, key: string, value: unknown, at: SpecLocation): void {
    const bad = (choices: readonly (string | number)[] | string) => this.invalid(key, typeof value === 'object' ? JSON.stringify(value) : value, choices, at, 'the front matter');
    switch (key) {
      case 'radiant':
        if (value === 1) spec.radiant = 1;
        else if (typeof value === 'number' && value > MAP_SPEC_VERSION) this.report({ severity: 'error', code: 'unsupported_version', ...at,
          message: 'This is a version ' + value + ' spec; this tool reads version ' + MAP_SPEC_VERSION + '.', hint: 'radiant capabilities --json' });
        else bad([1]);
        return;
      case 'title':
        if (typeof value === 'string' || typeof value === 'number') {
          const title = String(value);
          if (this.text('Title', title, SPEC_LIMITS.labelBytes, at)) spec.title = title;
        } else bad('a text value');
        return;
      case 'theme': {
        const ids = specThemeIds();
        if (typeof value === 'string' && ids.includes(value)) spec.theme = value;
        else this.report({ severity: 'warning', code: 'unknown_theme', ...at,
          message: 'Unknown theme "' + String(value) + '"; the default theme is used. Themes: ' + ids.join(', ') + '.',
          suggestions: suggest(String(value), ids), hint: 'radiant themes' });
        return;
      }
      case 'themeSettings': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('a mapping of theme fields');
        const accepted = parseThemeSettings(value) as Record<string, unknown> | undefined;
        const dropped = Object.keys(value).filter((k) => !accepted || !(k in accepted));
        if (dropped.length) this.report({ severity: 'warning', code: 'theme_setting_dropped', ...at,
          message: 'themeSettings ignored ' + dropped.map((k) => '"' + k + '"').join(', ') + ' (unknown field or invalid value).',
          hint: 'radiant schema spec' });
        if (accepted) spec.themeSettings = accepted;
        return;
      }
      case 'layout':
        if (typeof value === 'string' && (SPEC_LAYOUTS as string[]).includes(value)) spec.layout = value as LayoutKind;
        else bad(SPEC_LAYOUTS);
        return;
      case 'spacing':
        if (typeof value === 'string' && (SPEC_SPACINGS as readonly string[]).includes(value)) spec.spacing = value as RootSpacing;
        else bad(SPEC_SPACINGS);
        return;
      case 'seed':
        if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 0x7fffffff) spec.seed = value;
        else bad('an integer');
        return;
      case 'tagColors': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('a mapping of tag to hex colour');
        const out: Record<string, string> = {};
        for (const [tag, colour] of Object.entries(value)) {
          const hex = typeof colour === 'string' ? normalHex(colour) : null;
          if (hex) out[tag.toLowerCase()] = hex;
          else this.invalid('tag colour', colour, 'a hex colour such as #2F78D0', at, 'tag "' + tag + '"');
        }
        if (Object.keys(out).length) spec.tagColors = out;
        return;
      }
      case 'assets': {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('a mapping of name to local file path');
        const out: Record<string, string> = {};
        for (const [name, path] of Object.entries(value)) {
          if (!ASSET_NAME.test(name)) {
            this.report({ severity: 'error', code: 'invalid_asset', ...at, message: 'Asset name "' + name + '" must be letters, digits, ".", "_" or "-", up to 64 characters.' });
          } else if (typeof path !== 'string' || !path.trim() || CONTROLS.test(path) || path.length > 4096) {
            this.report({ severity: 'error', code: 'invalid_asset', ...at, message: 'Asset "' + name + '" needs a local file path.' });
          } else out[name] = path.trim();
        }
        spec.assets = out;
        return;
      }
      default:
        this.report({ severity: 'warning', code: 'unknown_front_matter_key', ...at,
          message: 'Unknown front matter key "' + key + '"; it was ignored. Keys: ' + SPEC_FRONT_MATTER_KEYS.join(', ') + '.',
          suggestions: suggest(key, SPEC_FRONT_MATTER_KEYS) });
    }
  }

  /** One node attribute. depth: 0 = root, 1 = main branch. */
  attribute(node: MapSpecNode, key: string, value: unknown, depth: number): void {
    const at = this.where(node, key);
    const subject = '"' + clip(node.label) + '"';
    const str = (): string | null => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
    const flag = (): boolean | null => value === true || value === 'true' || value === 'yes' ? true
      : value === false || value === 'false' || value === 'no' ? false : null;
    const num = (): number | null => {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
      return Number.isFinite(n) ? n : null;
    };
    const choice = <T extends string>(list: readonly T[]): T | null => {
      const s = str();
      if (s !== null && (list as readonly string[]).includes(s)) return s as T;
      this.invalid(key, value, list, at, subject);
      return null;
    };
    const notHere = (where: string) => this.report({ severity: 'warning', code: 'attribute_not_applicable', ...at,
      message: '"' + key + '" applies to ' + where + ' only; it was ignored on ' + subject + '.' });
    const geometry = (why: string) => this.report({ severity: 'warning', code: 'geometry_ignored', ...at,
      message: 'Geometry attribute "' + key + '" on ' + subject + ' was ignored.' + (why ? ' ' + why : ''),
      hint: 'Layout computes positions. Use side=, layout= or spacing= to steer it.' });
    switch (key) {
      case 'id': {
        const s = str();
        if (s !== null && SPEC_ID.test(s)) node.id = s;
        else this.report({ severity: 'error', code: 'invalid_id', ...at,
          message: 'Id "' + String(value) + '" on ' + subject + ' must be letters, digits, "_" or "-", starting with a letter or digit, up to 128 characters.' });
        return;
      }
      case 'color': case 'text': case 'fill': {
        const hex = typeof value === 'string' ? normalHex(value) : null;
        if (hex) node[key] = hex;
        else this.invalid(key, value, 'a hex colour such as #2F78D0', at, subject);
        return;
      }
      case 'shape': { const v = choice(SPEC_SHAPES); if (v) node.shape = v; return; }
      case 'branch': { const v = choice(SPEC_BRANCHES); if (v) node.branch = v; return; }
      case 'align': { const v = choice(SPEC_ALIGNMENTS); if (v) node.align = v; return; }
      case 'width': {
        const n = num();
        if (n !== null && n >= 0.5 && n <= MAX_BRANCH_WIDTH) node.width = n;
        else if (n !== null || /px$/i.test(String(value))) geometry('width sets the branch width (0.5 to ' + MAX_BRANCH_WIDTH + '); node sizes come from the label.');
        else this.invalid(key, value, 'a branch width from 0.5 to ' + MAX_BRANCH_WIDTH, at, subject);
        return;
      }
      case 'size': {
        const n = num();
        if (n !== null && n >= 6 && n <= 200) node.size = n;
        else this.invalid(key, value, 'a font size from 6 to 200', at, subject);
        return;
      }
      case 'font': {
        const s = str();
        if (s !== null && FONT.test(s)) node.font = s;
        else this.invalid(key, value, 'a CSS font family list', at, subject);
        return;
      }
      case 'emphasis': {
        const n = num();
        if (n === 0 || n === 1 || n === 2) node.emphasis = n;
        else this.invalid(key, value, [0, 1, 2], at, subject);
        return;
      }
      case 'bold': case 'italic': case 'curved': case 'boundary': case 'extruded': case 'folded': case 'organic': {
        const f = flag();
        if (f === null) return this.invalid(key, value, ['true', 'false'], at, subject);
        if (key === 'organic' && depth !== 0) return notHere('a root');
        node[key] = f;
        return;
      }
      case 'sticker': {
        const s = str();
        if (s === null || !s.trim()) return this.invalid(key, value, 'a short symbol', at, subject);
        if (this.text('Sticker', s, SPEC_LIMITS.stickerBytes, at)) node.sticker = s;
        return;
      }
      case 'tags': {
        const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
        if (!list || list.some((t) => typeof t !== 'string')) return this.invalid(key, value, 'comma-separated tags', at, subject);
        const tags = [...new Set((list as string[]).map((t) => t.trim()).filter(Boolean))];
        if (tags.length > SPEC_LIMITS.tags) return this.invalid(key, tags.length + ' tags', 'at most ' + SPEC_LIMITS.tags + ' tags', at, subject);
        if (tags.every((t) => this.text('Tag', t, SPEC_LIMITS.tagBytes, at)) && tags.length) node.tags = tags;
        return;
      }
      case 'href': {
        const s = str();
        if (s === null || !s.trim()) return this.invalid(key, value, 'a URL or map link', at, subject);
        if (this.text('Link', s, SPEC_LIMITS.hrefBytes, at)) node.href = s.trim();
        return;
      }
      case 'side': {
        const v = choice(SPEC_SIDES);
        if (v && depth !== 1) return notHere('a main branch (a child of a root)');
        if (v) node.side = v;
        return;
      }
      case 'layout': {
        if (depth > 1) return notHere('a root or a main branch');
        const v = choice(depth === 0 ? SPEC_LAYOUTS : SPEC_BRANCH_LAYOUTS);
        if (v) node.layout = v;
        return;
      }
      case 'spacing': {
        const v = choice(SPEC_SPACINGS);
        if (v && depth !== 0) return notHere('a root');
        if (v) node.spacing = v;
        return;
      }
      case 'image': {
        const s = str();
        if (s !== null && ASSET_NAME.test(s)) node.image = s;
        else this.invalid(key, value, 'an asset name from the front matter', at, subject);
        return;
      }
      case 'alt': {
        const s = str();
        if (s === null) return this.invalid(key, value, 'text', at, subject);
        if (this.text('Alt text', s, SPEC_LIMITS.labelBytes, at)) node.alt = s;
        return;
      }
      case 'scale': {
        const n = num();
        if (n !== null && n >= 0.1 && n <= 8) node.scale = n;
        else this.invalid(key, value, 'a picture scale from 0.1 to 8', at, subject);
        return;
      }
      case 'note': {
        const s = str();
        if (s === null) return this.invalid(key, value, 'text', at, subject);
        if (node.note !== undefined) {
          this.report({ severity: 'warning', code: 'duplicate_note', ...at, message: subject + ' has a note paragraph and note=; the paragraph was kept.' });
          return;
        }
        if (this.text('Note', s, SPEC_LIMITS.noteBytes, at)) node.note = s;
        return;
      }
      case 'task': {
        const s = value === true ? 'open' : str();
        if (s === 'open' || s === 'done') node.task = s;
        else this.invalid(key, value, ['open', 'done'], at, subject);
        return;
      }
      case 'offset': case 'pin': {
        const pair = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map((p) => p.trim() ? Number(p) : NaN) : null;
        if (!pair || pair.length !== 2 || !pair.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6)) {
          return this.invalid(key, value, 'two numbers "x,y"', at, subject);
        }
        if (!this.opts.allowGeometry) return geometry('Pass --allow-geometry to keep manual offsets and pins.');
        if (key === 'pin' && depth === 0) return notHere('a non-root node');
        node[key] = [pair[0] as number, pair[1] as number];
        return;
      }
      case '.':
        this.report({ severity: 'warning', code: 'unknown_attribute', ...at, message: 'Classes (".' + String(value) + '") are not supported; it was ignored.' });
        return;
      default:
        if ((SPEC_GEOMETRY_ATTRIBUTES as readonly string[]).includes(key)) return geometry('');
        this.report({ severity: 'warning', code: 'unknown_attribute', ...at,
          message: 'Unknown attribute "' + key + '" on ' + subject + '; it was ignored.',
          suggestions: suggest(key, SPEC_NODE_ATTRIBUTES), hint: 'radiant schema spec' });
    }
  }

  link(raw: { from: unknown; to: unknown; label?: unknown; attrs: [string, unknown][] }, at: SpecLocation): MapSpecLink | null {
    const from = typeof raw.from === 'string' ? raw.from : '';
    const to = typeof raw.to === 'string' ? raw.to : '';
    if (!SPEC_ID.test(from) || !SPEC_ID.test(to)) {
      this.report({ severity: 'error', code: 'link_syntax', ...at, message: 'A link needs two node ids: "from -> to : label {dash=dashed}".' });
      return null;
    }
    const link: MapSpecLink = { from, to };
    this.locations.set(link, at);
    if (raw.label !== undefined && raw.label !== '') {
      if (typeof raw.label !== 'string') this.invalid('label', raw.label, 'text', at, 'a link');
      else if (this.text('Link label', raw.label, SPEC_LIMITS.labelBytes, at)) link.label = raw.label;
    }
    for (const [key, value] of raw.attrs) {
      if (key === 'dash') {
        if ((SPEC_DASHES as readonly unknown[]).includes(value)) link.dash = value as MapSpecLink['dash'];
        else if (value === true) link.dash = 'dashed';
        else this.invalid('dash', value, SPEC_DASHES, at, 'a link');
      } else if (key === 'arrows') {
        if ((SPEC_ARROWS as readonly unknown[]).includes(value)) link.arrows = value as MapSpecLink['arrows'];
        else this.invalid('arrows', value, SPEC_ARROWS, at, 'a link');
      } else if (key === 'color') {
        const hex = typeof value === 'string' ? normalHex(value) : null;
        if (hex) link.color = hex;
        else this.invalid('color', value, 'a hex colour such as #2F78D0', at, 'a link');
      } else {
        this.report({ severity: 'warning', code: 'unknown_attribute', ...at, message: 'Unknown link attribute "' + key + '"; it was ignored.',
          suggestions: suggest(key, SPEC_LINK_ATTRIBUTES) });
      }
    }
    return link;
  }

  /** Node or element ids: an array, or a comma- or space-separated list. A leading "#" is allowed. */
  ids(name: string, value: unknown, at: SpecLocation, subject: string): string[] | null {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/).filter(Boolean) : value === true ? [] : null;
    if (!list || list.some((v) => typeof v !== 'string' || !SPEC_ID.test(v.replace(/^#/, '')))) {
      this.invalid(name, Array.isArray(value) ? value.join(',') : value, 'comma-separated ids', at, subject);
      return null;
    }
    return [...new Set((list as string[]).map((v) => v.replace(/^#/, '')))];
  }

  private number(name: string, value: unknown, min: number, max: number, at: SpecLocation, subject: string, integer = false): number | null {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n))) return n;
    this.invalid(name, value, (integer ? 'a whole number' : 'a number') + ' from ' + min + ' to ' + max, at, subject);
    return null;
  }

  private pick<T extends string>(name: string, value: unknown, list: readonly T[], at: SpecLocation, subject: string): T | null {
    if (typeof value === 'string' && (list as readonly string[]).includes(value)) return value as T;
    this.invalid(name, value, list, at, subject);
    return null;
  }

  private numbers(name: string, value: unknown, at: SpecLocation, subject: string, size?: number): number[] | null {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,x]+/i).filter(Boolean).map(Number) : null;
    if (!list || list.some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > MAX_COORDINATE) ||
        (size !== undefined && list.length !== size)) {
      this.invalid(name, Array.isArray(value) ? value.join(',') : value, size === 2 ? 'two numbers "x,y"' : 'a list of numbers', at, subject);
      return null;
    }
    return list as number[];
  }

  /** A presentation from its info-string attributes (Markdown) or its object keys (JSON twin). */
  presentation(entries: [string, unknown][], at: SpecLocation): MapSpecPresentation {
    const p: MapSpecPresentation = { name: '' };
    this.locations.set(p, at);
    const subject = 'a presentation';
    for (const [key, value] of entries) {
      switch (key) {
        case 'name': case 'title':
          if (typeof value === 'string' && value.trim()) { if (this.text('Presentation name', value, SPEC_LIMITS.labelBytes, at)) p.name = value.trim(); }
          else this.invalid('name', value, 'text', at, subject);
          break;
        case 'id': case '#':
          if (typeof value === 'string' && SPEC_ID.test(value)) p.id = value;
          else this.report({ severity: 'error', code: 'invalid_id', ...at, message: 'Presentation id "' + String(value) + '" must be letters, digits, "_" or "-".' });
          break;
        case 'reveal': { const v = this.pick(key, value, PRESENTATION_REVEALS, at, subject); if (v) p.reveal = v; break; }
        case 'context': { const v = this.pick(key, value, PRESENTATION_CONTEXTS, at, subject); if (v) p.context = v; break; }
        case 'motion': { const v = this.pick(key, value, PRESENTATION_MOTIONS, at, subject); if (v) p.motion = v; break; }
        case 'opacity': case 'dimOpacity': { const v = this.number('opacity', value, 0, 1, at, subject); if (v !== null) p.dimOpacity = v; break; }
        case 'minutes': case 'targetMinutes': { const v = this.number('minutes', value, 0, 10_000, at, subject); if (v !== null) p.targetMinutes = v; break; }
        case 'auto': {
          const v = value === true ? 'levels' : this.pick(key, value, TOUR_KINDS, at, subject);
          if (v) p.auto = v;
          break;
        }
        default:
          this.report({ severity: 'warning', code: 'unknown_attribute', ...at, message: 'Unknown presentation attribute "' + key + '"; it was ignored.',
            suggestions: suggest(key, SPEC_PRESENTATION_ATTRIBUTES) });
      }
    }
    if (!p.name) {
      p.name = 'Presentation';
      this.report({ severity: 'warning', code: 'missing_name', ...at, message: 'The presentation has no name; it is called "Presentation".',
        hint: 'Write the block as \x60\x60\x60presentation name="Team intro"' });
    }
    return p;
  }

  /** One step: focus ids, an optional title and attributes. */
  step(focus: unknown, entries: [string, unknown][], at: SpecLocation): MapSpecStep | null {
    const subject = 'a presentation step';
    const ids = this.ids('focus', focus ?? [], at, subject);
    if (!ids) return null;
    const step: MapSpecStep = { focus: ids };
    this.locations.set(step, at);
    for (const [key, value] of entries) {
      switch (key) {
        case 'id': case '#':
          if (typeof value === 'string' && SPEC_ID.test(value)) step.id = value;
          else this.report({ severity: 'error', code: 'invalid_id', ...at, message: 'Step id "' + String(value) + '" must be letters, digits, "_" or "-".' });
          break;
        case 'title': case 'caption': case 'note':
          if (typeof value !== 'string') this.invalid(key, value, 'text', at, subject);
          else if (this.text(key === 'note' ? 'Note' : 'Step ' + key, value, key === 'note' ? SPEC_LIMITS.noteBytes : SPEC_LIMITS.labelBytes, at) && value.trim()) step[key] = value;
          break;
        case 'reveal': case 'hide': case 'elements': { const v = this.ids(key, value, at, subject); if (v?.length) step[key] = v; break; }
        case 'frame': { const v = this.pick(key, value, STEP_FRAMES, at, subject); if (v) step.frame = v; break; }
        case 'build': { const v = this.pick(key, value, STEP_BUILDS, at, subject); if (v) step.build = v; break; }
        case 'dim': { const v = this.pick(key, value, STEP_DIMS, at, subject); if (v) step.dim = v; break; }
        case 'transition': { const v = this.pick(key, value, STEP_TRANSITIONS, at, subject); if (v) step.transition = v; break; }
        case 'seconds': { const v = this.number(key, value, 0, 86_400, at, subject); if (v !== null) step.seconds = v; break; }
        case 'skip': {
          const f = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
          if (f === null) this.invalid(key, value, ['true', 'false'], at, subject);
          else if (f) step.skip = true;
          break;
        }
        default:
          this.report({ severity: 'warning', code: 'unknown_attribute', ...at, message: 'Unknown step attribute "' + key + '"; it was ignored.',
            suggestions: suggest(key, SPEC_STEP_ATTRIBUTES) });
      }
    }
    return step;
  }

  /** One canvas element from a canvas line or a JSON object. */
  element(kind: unknown, entries: [string, unknown][], at: SpecLocation): MapSpecElement | null {
    if (typeof kind !== 'string' || !(SPEC_CANVAS_KINDS as readonly string[]).includes(kind)) {
      this.report({ severity: 'error', code: 'unknown_kind', ...at, message: 'Unknown canvas element kind "' + String(kind) + '". Kinds: ' + SPEC_CANVAS_KINDS.join(', ') + '.',
        suggestions: suggest(String(kind), SPEC_CANVAS_KINDS) });
      return null;
    }
    const el: MapSpecElement = { kind: kind as CanvasElementKind };
    this.locations.set(el, at);
    const subject = 'a canvas ' + kind;
    const raw = el as Record<string, unknown>;
    const binding = (end: 'start' | 'end'): CanvasBinding => (el[end] ??= {});
    for (const [key, value] of entries) {
      switch (key) {
        case 'id': case '#':
          if (typeof value === 'string' && SPEC_ID.test(value.replace(/^#/, ''))) el.id = value.replace(/^#/, '');
          else this.report({ severity: 'error', code: 'invalid_id', ...at, message: 'Element id "' + String(value) + '" must be letters, digits, "_" or "-".' });
          break;
        case 'at': { const v = this.numbers(key, value, at, subject, 2); if (v) { el.x = v[0]; el.y = v[1]; } break; }
        case 'size': { const v = this.numbers(key, value, at, subject, 2); if (v) { el.w = v[0]; el.h = v[1]; } break; }
        case 'x': case 'y': case 'w': case 'h': { const v = this.number(key, value, -MAX_COORDINATE, MAX_COORDINATE, at, subject); if (v !== null) raw[key] = v; break; }
        case 'rotate': { const v = this.number(key, value, -360, 360, at, subject); if (v !== null && v) el.angle = v * Math.PI / 180; break; }
        case 'angle': { const v = this.number(key, value, -100, 100, at, subject); if (v !== null && v) el.angle = v; break; }
        case 'band': { const v = this.pick(key, value, ELEMENT_BANDS, at, subject); if (v) el.band = v; break; }
        case 'fillStyle': { const v = this.pick(key, value, ELEMENT_FILL_STYLES, at, subject); if (v) el.fillStyle = v; break; }
        case 'strokeStyle': { const v = this.pick(key, value, ELEMENT_STROKE_STYLES, at, subject); if (v) el.strokeStyle = v; break; }
        case 'font': { const v = this.pick(key, value, ELEMENT_FONTS, at, subject); if (v) el.font = v; break; }
        case 'align': { const v = this.pick(key, value, SPEC_ALIGNMENTS, at, subject); if (v) el.align = v; break; }
        case 'startHead': case 'endHead': { const v = this.pick(key, value, ELEMENT_HEADS, at, subject); if (v) el[key] = v; break; }
        case 'stroke': case 'fill': case 'textColor': {
          const hex = typeof value === 'string' ? canvasHex(value) : null;
          if (hex) el[key] = hex;
          else this.invalid(key, value, 'a hex colour such as #1E1E1E', at, subject);
          break;
        }
        case 'strokeWidth': { const v = this.number(key, value, 0.1, 64, at, subject); if (v !== null) el.strokeWidth = v; break; }
        case 'opacity': { const v = this.number(key, value, 0, 1, at, subject); if (v !== null) el.opacity = v; break; }
        case 'seed': { const v = this.number(key, value, 0, 0x7fffffff, at, subject, true); if (v !== null) el.seed = v; break; }
        case 'fontSize': { const v = this.number(key, value, 1, 400, at, subject); if (v !== null) el.fontSize = v; break; }
        case 'roughness': { const v = this.number(key, value, 0, 2, at, subject, true); if (v !== null) el.roughness = v as 0 | 1 | 2; break; }
        case 'round': case 'locked': case 'elbow': {
          const f = value === true || value === 'true' ? true : value === false || value === 'false' ? false : null;
          if (f === null) this.invalid(key, value, ['true', 'false'], at, subject);
          else el[key] = f;
          break;
        }
        case 'groups': {
          const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',').map((g) => g.trim()).filter(Boolean) : null;
          if (!list || !list.length || list.some((g) => typeof g !== 'string' || !/^[\w-]{1,128}$/.test(g))) this.invalid(key, value, 'comma-separated group ids', at, subject);
          else el.groups = list as string[];
          break;
        }
        case 'frame': case 'from': case 'to': {
          if (typeof value === 'string' && SPEC_ID.test(value.replace(/^#/, ''))) raw[key] = value.replace(/^#/, '');
          else this.invalid(key, value, 'a node or element id', at, subject);
          break;
        }
        case 'from-at': case 'to-at': { const v = this.numbers(key, value, at, subject, 2); if (v) binding(key === 'from-at' ? 'start' : 'end').at = { x: v[0], y: v[1] }; break; }
        case 'from-gap': case 'to-gap': { const v = this.number(key, value, -1000, 1000, at, subject); if (v !== null) binding(key === 'from-gap' ? 'start' : 'end').gap = v; break; }
        case 'start': case 'end': {
          const b = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
          const target = b && (typeof b.node === 'string' ? b.node : typeof b.element === 'string' ? b.element : null);
          if (!b || !target || !SPEC_ID.test(target)) { this.invalid(key, JSON.stringify(value), 'a binding {"node": id} or {"element": id}', at, subject); break; }
          raw[key === 'start' ? 'from' : 'to'] = target;
          const out = binding(key);
          if (b.at && typeof b.at === 'object') { const p = b.at as Record<string, unknown>; if (typeof p.x === 'number' && typeof p.y === 'number') out.at = { x: p.x, y: p.y }; }
          if (typeof b.gap === 'number' && Number.isFinite(b.gap)) out.gap = b.gap;
          if (typeof b.element === 'string') out.element = b.element;
          break;
        }
        case 'link': {
          if (typeof value !== 'string' || !value.trim()) this.invalid(key, value, 'a URL or map link', at, subject);
          else if (this.text('Link', value, SPEC_LIMITS.hrefBytes, at)) el.link = value.trim();
          break;
        }
        case 'text': {
          if (typeof value !== 'string') this.invalid(key, value, 'text', at, subject);
          else if (this.text('Element text', value, 8_000, at)) el.text = value;
          break;
        }
        case 'points': case 'pressures': { const v = this.numbers(key, value, at, subject); if (v) el[key] = v; break; }
        case 'image': {
          if (typeof value === 'string' && ASSET_NAME.test(value)) el.image = value;
          else this.invalid(key, value, 'an asset name from the front matter', at, subject);
          break;
        }
        default:
          this.report({ severity: 'warning', code: 'unknown_attribute', ...at, message: 'Unknown canvas attribute "' + key + '" on ' + subject + '; it was ignored.',
            suggestions: suggest(key, SPEC_CANVAS_ATTRIBUTES), hint: 'radiant schema spec' });
      }
    }
    return el;
  }
}

/** Six-digit hex colour for canvas elements; three-digit colours are expanded. Case is kept. */
function canvasHex(value: string): string | null {
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('');
  return null;
}

function normalHex(value: string): string | null {
  const v = value.trim();
  if (!HEX.test(v)) return null;
  const body = v.length === 4 ? v.slice(1).split('').map((c) => c + c).join('') : v.slice(1);
  return '#' + body.toUpperCase();
}

const clip = (text: string, max = 40) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

// ====================================================================== Markdown spec

// The same structural patterns as parseMarkdownOutline, used only to find each node's source line.
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const MD_BULLET = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/;
const MD_FENCE = /^\s*([\x60]{3}|~~~)/;
const TASK = /^\[([ xX])\][ \t]+/;

interface SourceNode { line: number; column: number; raw: string }

/** Lines that become nodes, in the order parseMarkdownOutline creates them. */
function nodeLines(lines: readonly string[]): SourceNode[] {
  const out: SourceNode[] = [];
  let fence = false;
  lines.forEach((raw, i) => {
    if (MD_FENCE.test(raw)) { fence = !fence; return; }
    if (fence || !raw.trim()) return;
    const h = MD_HEADING.exec(raw);
    if (h) {
      out.push({ line: i + 1, column: raw.indexOf(h[2], h[1].length) + 1, raw: h[2] });
      return;
    }
    const b = MD_BULLET.exec(raw);
    if (b) {
      out.push({ line: i + 1, column: raw.length - b[2].length + 1, raw: b[2] });
      return;
    }
    if (!out.length) out.push({ line: i + 1, column: raw.search(/\S/) + 1, raw: raw.trim() });
  });
  return out;
}

/** Parse a ".map.md" spec. Any Markdown outline that Radiant imports is a valid spec. */
export function parseMapSpecMarkdown(source: string, opts: ParseSpecOptions = {}): ParsedMapSpec {
  const reader = new SpecReader(opts);
  const spec: MapSpec = { roots: [] };
  const lines = source.replace(/^\u{feff}/u, '').replace(/\r\n?/g, '\n').split('\n');
  const body = lines.slice();

  // Front matter.
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
    if (close < 0) {
      reader.report({ severity: 'error', code: 'front_matter_syntax', line: 1, column: 1,
        message: 'Front matter starts with "---" but has no closing "---".' });
    } else {
      for (const entry of parseFrontMatter(lines.slice(1, close), 2, (d) => reader.report(d))) {
        reader.front(spec, entry.key, entry.value, { line: entry.line, column: entry.column });
      }
      for (let i = 0; i <= close; i++) body[i] = '';
    }
  }

  // Whole-line HTML comments are spec comments, not nodes.
  let inFence = false;
  for (let i = 0; i < body.length; i++) {
    if (MD_FENCE.test(body[i])) inFence = !inFence;
    else if (!inFence && /^s*<!--.*-->s*$/.test(body[i])) body[i] = '';
  }

  // Spec blocks: links, presentation and canvas. Other fences stay notes, as in the importer.
  const linkRows: { text: string; line: number }[] = [];
  const presentationBlocks: { info: string; line: number; rows: { text: string; line: number }[] }[] = [];
  const canvasRows: { text: string; line: number }[] = [];
  for (let i = 0; i < body.length; i++) {
    const open = MD_FENCE.exec(body[i]);
    if (!open) continue;
    const info = body[i].trim().slice(3).trim();
    const word = info.split(/\s+/)[0]?.toLowerCase() ?? '';
    let end = i + 1;
    while (end < body.length && !MD_FENCE.test(body[end])) end++;
    const known = word === 'links' || (SPEC_RESERVED_BLOCKS as readonly string[]).includes(word);
    if (!known) {
      const near = word ? suggest(word, ['links', ...SPEC_RESERVED_BLOCKS], 1) : [];
      if (near.length) reader.report({ severity: 'warning', code: 'unknown_block', line: i + 1, column: 1,
        message: 'Fenced block "' + word + '" is not a spec block; it is kept as note text.', suggestions: near });
      i = end;
      continue;
    }
    if (end >= body.length) reader.report({ severity: 'error', code: 'block_syntax', line: i + 1, column: 1,
      message: 'The "' + word + '" block has no closing fence.' });
    const rows: { text: string; line: number }[] = [];
    for (let k = i + 1; k < Math.min(end, body.length); k++) rows.push({ text: body[k], line: k + 1 });
    if (word === 'links') linkRows.push(...rows);
    else if (word === 'presentation') presentationBlocks.push({ info: info.slice(word.length).trim(), line: i + 1, rows });
    else canvasRows.push(...rows);
    for (let k = i; k <= Math.min(end, body.length - 1); k++) body[k] = '';
    i = end;
  }

  // The tree: the existing Markdown importer, then attribute blocks and task boxes on each label.
  const skipped = new Set<string>();
  const outline = parseMarkdownOutline(body.join('\n'), skipped);
  for (const note of skipped) reader.report({ severity: 'warning', code: 'markdown_skipped', message: note });
  const sources = nodeLines(body);
  let index = 0;
  const convert = (o: OutlineNode, depth: number): MapSpecNode => {
    const source = sources[index++] as SourceNode | undefined;
    const node: MapSpecNode = { label: o.text };
    const loc: NodeLocation = source ? { line: source.line, column: source.column, attrs: {} } : {};
    reader.locations.set(node, loc);
    let tokens: AttrToken[] = [];
    if (source) {
      let raw = source.raw;
      const split = splitAttributes(raw);
      tokens = split.attrs;
      raw = split.text;
      const task = TASK.exec(raw);
      if (task) {
        node.task = task[1] === ' ' ? 'open' : 'done';
        raw = raw.slice(task[0].length);
      }
      node.label = decodeEntities(raw.trim());
      for (const t of tokens) loc.attrs![t.key === '#' ? 'id' : t.key] = source.column + t.column;
    }
    reader.text('Label', node.label, SPEC_LIMITS.labelBytes, loc);
    if (o.note !== undefined) {
      node.note = o.note;
      reader.text('Note', o.note, SPEC_LIMITS.noteBytes, loc);
    }
    for (const t of tokens) {
      if (t.key === '#') reader.attribute(node, 'id', t.value, depth);
      else reader.attribute(node, t.key, t.value, depth);
    }
    if (o.children.length) node.children = o.children.map((c) => convert(c, depth + 1));
    return node;
  };
  spec.roots = outline.map((o) => convert(o, 0));
  if (index !== sources.length) {
    reader.report({ severity: 'warning', code: 'internal_locations', message: 'Line numbers may be approximate for this spec.' });
  }

  // Links.
  for (const row of linkRows) {
    const text = row.text.trim();
    if (!text || text.startsWith('#') || text.startsWith('//')) continue;
    const at: SpecLocation = { line: row.line, column: row.text.search(/\S/) + 1 };
    const split = splitAttributes(text);
    const m = /^([^\s:>-][^\s]*)\s*->\s*([^\s:]+)\s*(?::\s*(.*))?$/.exec(split.text.trim());
    if (!m) {
      reader.report({ severity: 'error', code: 'link_syntax', ...at, message: 'Expected "from -> to : label {dash=dashed arrows=end color=#hex}".' });
      continue;
    }
    const link = reader.link({ from: m[1], to: m[2], label: m[3] !== undefined ? decodeEntities(m[3].trim()) : undefined,
      attrs: split.attrs.map((t) => [t.key, t.value]) }, at);
    if (link) (spec.links ??= []).push(link);
  }

  // Canvas elements, then presentations (steps may name elements).
  for (const row of canvasRows) {
    const text = row.text.trim();
    if (!text || text.startsWith('//')) continue;
    const el = readCanvasLine(reader, text, { line: row.line, column: row.text.search(/\S/) + 1 });
    if (el) (spec.canvas ??= []).push(el);
  }
  for (const block of presentationBlocks) {
    const at: SpecLocation = { line: block.line, column: 1 };
    let entries: [string, unknown][] = [];
    if (block.info) {
      const tokens = parseAttrBlock('{' + block.info + '}', 0);
      if (!tokens) reader.report({ severity: 'error', code: 'block_syntax', ...at,
        message: 'Could not read the presentation attributes "' + block.info + '"; write them as name="Team intro" reveal=all.' });
      else entries = tokens.map((t) => [t.key, t.value]);
    }
    const p = reader.presentation(entries, at);
    for (const row of block.rows) {
      const text = row.text.trim();
      if (!text || text.startsWith('//')) continue;
      readStepLine(reader, p, text, { line: row.line, column: row.text.search(/\S/) + 1 });
    }
    (spec.presentations ??= []).push(p);
  }
  return { spec, diagnostics: reader.diagnostics, locate: reader.locate };
}

/** "auto levels", or "ids : title {attributes}". Adds the step (or the tour) to the presentation. */
function readStepLine(reader: SpecReader, p: MapSpecPresentation, text: string, at: SpecLocation): void {
  const auto = /^auto(?:\s+(\S+))?$/.exec(text);
  if (auto) {
    if (p.steps?.length || p.auto) reader.report({ severity: 'warning', code: 'auto_steps', ...at, message: '"auto" replaces the other steps of this presentation.' });
    const kind = auto[1] ?? 'levels';
    if ((TOUR_KINDS as readonly string[]).includes(kind)) p.auto = kind as TourGranularity;
    else reader.invalid('auto', kind, TOUR_KINDS, at, 'a presentation');
    return;
  }
  const split = splitAttributes(text);
  const body = split.text.trim();
  const colon = body.indexOf(':');
  const ids = (colon < 0 ? body : body.slice(0, colon)).trim();
  const title = colon < 0 ? '' : decodeEntities(body.slice(colon + 1).trim());
  const entries: [string, unknown][] = split.attrs.map((t) => [t.key, t.value]);
  if (title) entries.unshift(['title', title]);
  const step = reader.step(ids, entries, at);
  if (step) (p.steps ??= []).push(step);
}

/** "kind #id at=x,y size=wxh {attributes} : text". The text follows the first ":" that has a space before it. */
function readCanvasLine(reader: SpecReader, line: string, at: SpecLocation): MapSpecElement | null {
  let quote = false;
  let depth = 0;
  let split = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') quote = !quote;
    else if (!quote && c === '{') depth++;
    else if (!quote && c === '}') depth = Math.max(0, depth - 1);
    else if (!quote && depth === 0 && c === ':' && (i === 0 || /\s/.test(line[i - 1]))) { split = i; break; }
  }
  const head = (split < 0 ? line : line.slice(0, split)).trim();
  const text = split < 0 ? undefined : decodeEntities(line.slice(split + 1).trim());
  const kind = /^\S+/.exec(head)?.[0] ?? '';
  let rest = '';
  quote = false;
  for (const c of head.slice(kind.length)) {
    if (c === '"') quote = !quote;
    rest += !quote && (c === '{' || c === '}') ? ' ' : c;
  }
  const tokens = parseAttrBlock('{' + rest + '}', 0);
  if (!tokens) {
    reader.report({ severity: 'error', code: 'canvas_syntax', ...at,
      message: 'Expected "kind #id at=x,y size=wxh {attributes} : text"; the attributes could not be read.' });
    return null;
  }
  const entries: [string, unknown][] = tokens.map((t) => [t.key === '#' ? 'id' : t.key, t.value]);
  if (text) entries.push(['text', text]);
  return reader.element(kind, entries, at);
}

// ====================================================================== JSON twin

const JSON_TOP = new Set<string>([...SPEC_FRONT_MATTER_KEYS, 'roots', 'links', 'presentations', 'canvas', '$schema']);

/** Validate the nested JSON twin (already parsed from JSON text). */
export function parseMapSpecJson(input: unknown, opts: ParseSpecOptions = {}): ParsedMapSpec {
  const reader = new SpecReader(opts);
  const spec: MapSpec = { roots: [] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    reader.report({ severity: 'error', code: 'spec_syntax', path: '$', message: 'A JSON spec is an object with "roots".' });
    return { spec, diagnostics: reader.diagnostics, locate: reader.locate };
  }
  const top = input as Record<string, unknown>;
  for (const [key, value] of Object.entries(top)) {
    if (key === 'roots' || key === 'links' || key === 'presentations' || key === 'canvas' || key === '$schema') continue;
    if (!JSON_TOP.has(key)) {
      reader.report({ severity: 'warning', code: 'unknown_front_matter_key', path: key,
        message: 'Unknown key "' + key + '"; it was ignored.', suggestions: suggest(key, [...JSON_TOP]) });
      continue;
    }
    reader.front(spec, key, value, { path: key });
  }
  const node = (value: unknown, path: string, depth: number): MapSpecNode | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      reader.report({ severity: 'error', code: 'spec_syntax', path, message: 'A node is an object with a "label".' });
      return null;
    }
    const raw = value as Record<string, unknown>;
    const out: MapSpecNode = { label: typeof raw.label === 'string' ? raw.label : '' };
    reader.locations.set(out, { path });
    if (typeof raw.label !== 'string') {
      reader.report({ severity: 'error', code: 'spec_syntax', path: path + '.label', message: 'Each node needs a "label" string ("" for a picture-only node).' });
    } else reader.text('Label', raw.label, SPEC_LIMITS.labelBytes, { path: path + '.label' });
    for (const [key, v] of Object.entries(raw)) {
      if (key === 'label' || key === 'children') continue;
      reader.attribute(out, key, v, depth);
    }
    if (raw.children !== undefined) {
      if (!Array.isArray(raw.children)) reader.report({ severity: 'error', code: 'spec_syntax', path: path + '.children', message: '"children" must be an array.' });
      else {
        const kids = raw.children.map((c, i) => node(c, path + '.children[' + i + ']', depth + 1)).filter((c): c is MapSpecNode => !!c);
        if (kids.length) out.children = kids;
      }
    }
    return out;
  };
  if (!Array.isArray(top.roots)) reader.report({ severity: 'error', code: 'spec_syntax', path: 'roots', message: '"roots" must be an array of nodes.' });
  else spec.roots = top.roots.map((r, i) => node(r, 'roots[' + i + ']', 0)).filter((r): r is MapSpecNode => !!r);
  if (top.links !== undefined) {
    if (!Array.isArray(top.links)) reader.report({ severity: 'error', code: 'spec_syntax', path: 'links', message: '"links" must be an array.' });
    else top.links.forEach((l, i) => {
      const at = { path: 'links[' + i + ']' };
      if (!l || typeof l !== 'object' || Array.isArray(l)) {
        reader.report({ severity: 'error', code: 'link_syntax', ...at, message: 'A link is an object with "from" and "to".' });
        return;
      }
      const { from, to, label, ...rest } = l as Record<string, unknown>;
      const link = reader.link({ from, to, label, attrs: Object.entries(rest) }, at);
      if (link) (spec.links ??= []).push(link);
    });
  }
  if (top.canvas !== undefined) {
    if (!Array.isArray(top.canvas)) reader.report({ severity: 'error', code: 'spec_syntax', path: 'canvas', message: '"canvas" must be an array of elements.' });
    else top.canvas.forEach((e, i) => {
      const at = { path: 'canvas[' + i + ']' };
      let el: MapSpecElement | null = null;
      if (typeof e === 'string') el = readCanvasLine(reader, e.trim(), at);
      else if (e && typeof e === 'object' && !Array.isArray(e)) {
        const { kind, ...rest } = e as Record<string, unknown>;
        el = reader.element(kind, Object.entries(rest), at);
      } else reader.report({ severity: 'error', code: 'canvas_syntax', ...at, message: 'A canvas element is an object with "kind", or a canvas line.' });
      if (el) (spec.canvas ??= []).push(el);
    });
  }
  if (top.presentations !== undefined) {
    if (!Array.isArray(top.presentations)) reader.report({ severity: 'error', code: 'spec_syntax', path: 'presentations', message: '"presentations" must be an array.' });
    else top.presentations.forEach((raw, i) => {
      const at = { path: 'presentations[' + i + ']' };
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        reader.report({ severity: 'error', code: 'spec_syntax', ...at, message: 'A presentation is an object with "name" and "steps".' });
        return;
      }
      const { steps, ...rest } = raw as Record<string, unknown>;
      const p = reader.presentation(Object.entries(rest), at);
      if (typeof steps === 'string') readStepLine(reader, p, steps.trim(), { path: at.path + '.steps' });
      else if (Array.isArray(steps)) steps.forEach((s, k) => {
        const where = { path: at.path + '.steps[' + k + ']' };
        if (typeof s === 'string') return readStepLine(reader, p, s.trim(), where);
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          reader.report({ severity: 'error', code: 'spec_syntax', ...where, message: 'A step is an object with "focus", or a step line.' });
          return;
        }
        const { focus, ...fields } = s as Record<string, unknown>;
        const step = reader.step(focus, Object.entries(fields), where);
        if (step) (p.steps ??= []).push(step);
      });
      else if (steps !== undefined) reader.report({ severity: 'error', code: 'spec_syntax', path: at.path + '.steps', message: '"steps" must be an array or "auto levels".' });
      (spec.presentations ??= []).push(p);
    });
  }
  return { spec, diagnostics: reader.diagnostics, locate: reader.locate };
}

/** Parse either form: JSON text starting with "{" is the JSON twin, anything else is Markdown. */
export function parseMapSpec(source: string, opts: ParseSpecOptions = {}): ParsedMapSpec {
  const trimmed = source.replace(/^\u{feff}/u, '').trimStart();
  if (!trimmed.startsWith('{')) return parseMapSpecMarkdown(source, opts);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const position = /position (\d+)/.exec(message);
    let line: number | undefined;
    let column: number | undefined;
    if (position) {
      const before = trimmed.slice(0, Number(position[1]));
      line = before.split('\n').length;
      column = before.length - before.lastIndexOf('\n');
    }
    return { spec: { roots: [] }, diagnostics: [{ severity: 'error', code: 'json_syntax', line, column, message: 'Invalid JSON: ' + message }],
      locate: () => ({}) };
  }
  return parseMapSpecJson(value, opts);
}

// ====================================================================== compile to a document

function walk(nodes: readonly MapSpecNode[], visit: (node: MapSpecNode, depth: number, parent: MapSpecNode | null) => void): void {
  const stack: [MapSpecNode, number, MapSpecNode | null][] = [];
  for (let i = nodes.length - 1; i >= 0; i--) stack.push([nodes[i], 0, null]);
  while (stack.length) {
    const [node, depth, parent] = stack.pop()!;
    visit(node, depth, parent);
    const kids = node.children ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i], depth + 1, node]);
  }
}

function toOutline(node: MapSpecNode): OutlineNode {
  const out: OutlineNode = { text: node.label, children: (node.children ?? []).map(toOutline) };
  if (node.note) out.note = node.note;
  if (node.folded) out.collapsed = true;
  if (node.href) out.link = node.href;
  return out;
}

/** Spec attribute name for each NodeStyle field. */
const STYLE_ATTRIBUTES: Record<keyof NodeStyle, keyof MapSpecNode> = {
  color: 'color', textColor: 'text', fillColor: 'fill', shape: 'shape', branch: 'branch', branchWidth: 'width', bold: 'bold',
  italic: 'italic', fontSize: 'size', fontFamily: 'font', alignment: 'align', emphasis: 'emphasis', curvedLabel: 'curved',
  branchBoundary: 'boundary', extrudedLabel: 'extruded'
};
const STYLE_FIELDS = new Map(Object.entries(STYLE_ATTRIBUTES).map(([field, attr]) => [attr as string, field as keyof NodeStyle]));

/** The node's style fields, in the order the attributes were written (so a document round-trips key for key). */
function styleOf(node: MapSpecNode): NodeStyle {
  const style: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    const field = STYLE_FIELDS.get(key);
    if (field && value !== undefined) style[field] = value;
  }
  return style as NodeStyle;
}

/** Canvas elements a map may hold (CNV-12). */
const CANVAS_ELEMENT_LIMIT = 20_000;
const ELEMENT_SIZES: Record<CanvasElementKind, [number, number]> = {
  rect: [160, 100], ellipse: [160, 100], diamond: [160, 100], line: [100, 0], arrow: [100, 0], draw: [100, 0],
  text: [200, 40], note: [200, 140], frame: [640, 420], image: [200, 150]
};
/** Optional element fields in the order they are written. */
const ELEMENT_FIELDS = [
  'angle', 'band', 'stroke', 'fill', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'round', 'opacity', 'seed', 'locked',
  'groups', 'frame', 'link', 'text', 'fontSize', 'font', 'align', 'textColor', 'points', 'pressures', 'start', 'end', 'startHead',
  'endHead', 'elbow', 'asset'
] as const;

type Reporter = (d: SpecDiagnostic) => void;

/** Turn a spec element into a CanvasElement: defaults, a seed derived from the id, bindings and the picture asset. */
function buildElement(el: MapSpecElement, id: string, nodeIds: ReadonlySet<string>, kinds: ReadonlyMap<string, CanvasElementKind>,
    assets: Record<string, ResolvedSpecAsset> | undefined, assetNames: readonly string[], report: Reporter, at: SpecLocation,
    allNodeIds: readonly string[]): CanvasElement | null {
  const [dw, dh] = ELEMENT_SIZES[el.kind];
  const linear = el.kind === 'line' || el.kind === 'arrow' || el.kind === 'draw';
  const w = el.w ?? (linear && el.points ? Math.max(...el.points.filter((_, i) => i % 2 === 0)) : dw);
  const h = el.h ?? (linear && el.points ? Math.max(...el.points.filter((_, i) => i % 2 === 1)) : dh);
  const out: Record<string, unknown> = { id, kind: el.kind, x: el.x ?? 0, y: el.y ?? 0, w, h };
  let ok = true;
  const fail = (code: string, message: string, suggestions?: string[]) => {
    ok = false;
    report({ severity: 'error', code, ...at, message, ...(suggestions?.length ? { suggestions } : {}) });
  };
  const bind = (end: 'start' | 'end', target: string | undefined) => {
    const extra = el[end];
    if (!target) return extra?.node || extra?.element ? extra : undefined;
    const element = extra?.element === target || (!nodeIds.has(target) && kinds.has(target));
    if (!element && !nodeIds.has(target)) {
      fail('unknown_binding', 'Canvas ' + el.kind + ' ' + (end === 'start' ? 'from' : 'to') + ' "' + target + '" is neither a node nor an element id.',
        suggest(target, [...allNodeIds, ...kinds.keys()]));
      return undefined;
    }
    const binding: CanvasBinding = element ? { element: target } : { node: target };
    if (extra?.at) binding.at = { ...extra.at };
    if (extra?.gap !== undefined) binding.gap = extra.gap;
    return binding;
  };
  for (const key of ELEMENT_FIELDS) {
    let value: unknown = (el as Record<string, unknown>)[key];
    switch (key) {
      case 'seed': value = el.seed ?? hash53(id) % 0x7fffffff; break;
      case 'frame':
        if (value !== undefined && kinds.get(value as string) !== 'frame') {
          fail('unknown_frame', 'Frame "' + String(value) + '" is not a frame element in this spec.', suggest(String(value), [...kinds].filter(([, k]) => k === 'frame').map(([i]) => i)));
          value = undefined;
        }
        break;
      case 'points':
        if (linear) {
          value = el.points ?? [0, 0, w, h];
          if ((value as number[]).length < 4 || (value as number[]).length % 2) { fail('invalid_points', 'A ' + el.kind + ' needs at least two points (x0,y0,x1,y1).'); value = undefined; }
        } else if (value !== undefined) {
          report({ severity: 'warning', code: 'attribute_not_applicable', ...at, message: '"points" applies to lines, arrows and drawings only; it was ignored.' });
          value = undefined;
        }
        break;
      case 'pressures':
        if (value !== undefined && (el.kind !== 'draw' || (value as number[]).length * 2 !== (out.points as number[] | undefined)?.length)) {
          report({ severity: 'warning', code: 'attribute_not_applicable', ...at, message: '"pressures" needs a drawing with one pressure per point; it was ignored.' });
          value = undefined;
        }
        break;
      case 'start': value = bind('start', el.from); break;
      case 'end': value = bind('end', el.to); break;
      case 'asset':
        if (el.image) {
          if (el.kind !== 'image') {
            report({ severity: 'warning', code: 'attribute_not_applicable', ...at, message: '"image" applies to image elements only; it was ignored.' });
          } else if (assets?.[el.image]) value = assets[el.image].hash;
          else {
            const declared = assetNames.includes(el.image);
            fail(declared ? 'asset_unresolved' : 'unknown_asset', declared ? 'Asset "' + el.image + '" could not be loaded.'
              : 'Unknown asset "' + el.image + '"; declare it under "assets:" in the front matter.', declared ? undefined : suggest(el.image, assetNames));
          }
        }
        break;
    }
    if (value !== undefined) out[key] = Array.isArray(value) ? value.slice() : value && typeof value === 'object' ? { ...value } : value;
  }
  if ((el.from || el.to) && !linear) {
    report({ severity: 'warning', code: 'attribute_not_applicable', ...at, message: '"from" and "to" bind lines and arrows only; they were ignored.' });
    delete out.start;
    delete out.end;
  }
  if (!ok) return null;
  const problems = canvasElementProblems(out);
  if (problems.length) {
    report({ severity: 'error', code: 'invalid_element', ...at, message: 'Canvas element ' + id + ' is invalid: ' + problems[0] });
    return null;
  }
  return out as unknown as CanvasElement;
}

/** A Presentation from its spec, with step ids derived from the presentation id and the step position. */
function buildPresentation(doc: Doc, p: MapSpecPresentation, id: string): Presentation {
  const out: Presentation = { id, name: p.name, steps: [] };
  if (p.reveal) out.reveal = p.reveal;
  if (p.context) out.context = p.context;
  if (p.dimOpacity !== undefined) out.dimOpacity = p.dimOpacity;
  if (p.motion) out.motion = p.motion;
  if (p.targetMinutes !== undefined) out.targetMinutes = p.targetMinutes;
  if (p.auto) {
    out.steps = autoTour(doc, { granularity: p.auto });
    return out;
  }
  const taken = new Set((p.steps ?? []).flatMap((s) => (s.id ? [s.id] : [])));
  (p.steps ?? []).forEach((s, k) => {
    let stepId = s.id;
    if (!stepId) {
      const key = id + '\n' + k + '\n' + s.focus.join(',');
      stepId = hashId('s-', key);
      for (let n = 1; taken.has(stepId); n++) stepId = hashId('s-', key + '\n' + n);
      taken.add(stepId);
    }
    const step: PresentationStep = { id: stepId, focus: s.focus.slice() };
    for (const key of ['reveal', 'hide', 'elements'] as const) if (s[key]?.length) step[key] = s[key]!.slice();
    for (const key of ['frame', 'build', 'dim', 'title', 'caption', 'note', 'transition', 'skip', 'seconds'] as const) {
      if (s[key] !== undefined) (step as unknown as Record<string, unknown>)[key] = s[key];
    }
    out.steps.push(step);
  });
  return out;
}

/**
 * Compile a parsed spec into a new document. Explicit ids are kept; other ids are derived from the parent id,
 * the label and its occurrence among same-label siblings, so building one spec twice gives identical documents
 * (with a fixed opts.now). Every change is an existing Op, made with the command helpers where one exists.
 */
export function compileMapSpec(parsed: ParsedMapSpec, opts: CompileSpecOptions = {}): CompiledMapSpec {
  const { spec } = parsed;
  const diagnostics = parsed.diagnostics.map((d) => opts.strict && d.severity === 'warning' ? { ...d, severity: 'error' as const } : d);
  const report = (d: SpecDiagnostic) => diagnostics.push(opts.strict && d.severity === 'warning' ? { ...d, severity: 'error' } : d);
  const summary: SpecBuildSummary = { roots: spec.roots.length, nodes: 0, depth: 0, links: 0, assets: 0, ids: { explicit: 0, derived: 0 }, assigned: [] };
  if (!spec.roots.length) report({ severity: 'error', code: 'empty_spec', line: 1, message: 'The spec has no nodes. Start with a heading such as "# Topic".' });

  // Ids: explicit first, then derived.
  const explicit = new Map<string, MapSpecNode>();
  walk(spec.roots, (node, depth) => {
    summary.nodes++;
    summary.depth = Math.max(summary.depth, depth);
    if (!node.id) return;
    const first = explicit.get(node.id);
    if (first) {
      const at = parsed.locate(first);
      report({ severity: 'error', code: 'duplicate_id', ...parsed.locate(node, 'id'),
        message: 'Id "' + node.id + '" is already used' + (at.line ? ' on line ' + at.line : at.path ? ' at ' + at.path : '') + '.' });
    } else explicit.set(node.id, node);
  });
  if (summary.nodes > SPEC_LIMITS.nodes) report({ severity: 'error', code: 'too_many_nodes', line: 1,
    message: 'The spec has ' + summary.nodes + ' nodes; the limit is ' + SPEC_LIMITS.nodes + '.' });
  const finalId = new Map<MapSpecNode, string>();
  const taken = new Set(explicit.keys());
  const order: MapSpecNode[] = [];
  const parentOf = new Map<MapSpecNode, MapSpecNode | null>();
  walk(spec.roots, (node, _depth, parent) => { order.push(node); parentOf.set(node, parent); });
  const siblingsSeen = new Map<MapSpecNode | null, Map<string, number>>();
  for (const node of order) {
    if (node.id && explicit.get(node.id) === node) {
      finalId.set(node, node.id);
      summary.ids.explicit++;
      continue;
    }
    const parent = parentOf.get(node) ?? null;
    let seen = siblingsSeen.get(parent);
    if (!seen) siblingsSeen.set(parent, seen = new Map());
    const nth = seen.get(node.label) ?? 0;
    seen.set(node.label, nth + 1);
    const key = (parent ? finalId.get(parent) : 'root') + '\n' + node.label + '\n' + nth;
    let id = hashId('n-', key);
    for (let k = 1; taken.has(id); k++) id = hashId('n-', key + '\n' + k);
    taken.add(id);
    finalId.set(node, id);
    summary.ids.derived++;
    if (summary.assigned.length < 200) {
      const at = parsed.locate(node);
      summary.assigned.push({ id, label: clip(node.label, 60), ...(at.line ? { line: at.line } : {}), ...(at.path ? { path: at.path } : {}) });
    }
  }

  // Cross-references: pictures and links.
  const assetNames = Object.keys(spec.assets ?? {});
  const usedAssets = new Set<string>();
  for (const node of order) {
    if (!node.image) continue;
    if (opts.assets?.[node.image]) { usedAssets.add(node.image); continue; }
    const declared = assetNames.includes(node.image);
    report({ severity: 'error', code: declared ? 'asset_unresolved' : 'unknown_asset', ...parsed.locate(node, 'image'),
      message: declared ? 'Asset "' + node.image + '" could not be loaded.' : 'Unknown asset "' + node.image + '"; declare it under "assets:" in the front matter.',
      suggestions: declared ? undefined : suggest(node.image, assetNames) });
  }
  summary.assets = usedAssets.size;
  const allIds = [...finalId.values()];
  const idSet = new Set(allIds);
  const pairs = new Set<string>();
  const links: MapSpecLink[] = [];
  for (const link of spec.links ?? []) {
    let ok = true;
    for (const end of ['from', 'to'] as const) {
      if (idSet.has(link[end])) continue;
      ok = false;
      report({ severity: 'error', code: 'unknown_link_node', ...parsed.locate(link),
        message: 'Link ' + end + ' "' + link[end] + '" is not a node id in this spec.', suggestions: suggest(link[end], allIds),
        hint: 'Give the node an explicit id: "Label {#' + link[end] + '}".' });
    }
    if (!ok) continue;
    if (link.from === link.to) {
      report({ severity: 'error', code: 'self_link', ...parsed.locate(link), message: 'A link cannot join "' + link.from + '" to itself.' });
      continue;
    }
    const pair = link.from + '>' + link.to;
    if (pairs.has(pair)) {
      report({ severity: 'warning', code: 'duplicate_link', ...parsed.locate(link), message: 'A link from "' + link.from + '" to "' + link.to + '" already exists; this one was ignored.' });
      continue;
    }
    pairs.add(pair);
    links.push(link);
  }
  if (links.length > SPEC_LIMITS.links) report({ severity: 'error', code: 'too_many_links', line: 1, message: 'The spec has more than ' + SPEC_LIMITS.links + ' links.' });
  summary.links = links.length;

  // Canvas elements: ids first (bindings and frames may point forward), then each element.
  const elementIds = new Map<MapSpecElement, string>();
  const elementKinds = new Map<string, CanvasElementKind>();
  const canvasSpec = spec.canvas ?? [];
  canvasSpec.forEach((el, index) => {
    if (el.id) {
      if (elementKinds.has(el.id) || idSet.has(el.id)) {
        report({ severity: 'error', code: 'duplicate_id', ...parsed.locate(el, 'id'), message: 'Id "' + el.id + '" is already used by a node or element.' });
        return;
      }
      elementIds.set(el, el.id);
      elementKinds.set(el.id, el.kind);
    }
    void index;
  });
  canvasSpec.forEach((el, index) => {
    if (el.id) return;
    const key = el.kind + '\n' + index + '\n' + (el.text ?? '');
    let id = hashId('e-', key);
    for (let k = 1; elementKinds.has(id) || idSet.has(id); k++) id = hashId('e-', key + '\n' + k);
    elementIds.set(el, id);
    elementKinds.set(id, el.kind);
  });
  if (canvasSpec.length > CANVAS_ELEMENT_LIMIT) report({ severity: 'error', code: 'too_many_elements', line: 1, message: 'The spec has more than ' + CANVAS_ELEMENT_LIMIT + ' canvas elements.' });
  const elements: CanvasElement[] = [];
  for (const el of canvasSpec) {
    const id = elementIds.get(el);
    if (!id) continue;
    const built = buildElement(el, id, idSet, elementKinds, opts.assets, assetNames, report, parsed.locate(el), allIds);
    if (built) {
      elements.push(built);
      if (el.image) usedAssets.add(el.image);
    }
  }
  summary.assets = usedAssets.size;
  summary.elements = elements.length;

  // Presentations: ids, and every step's nodes and elements.
  const presentationIds = new Set<string>();
  const presentations: { spec: MapSpecPresentation; id: string }[] = [];
  (spec.presentations ?? []).forEach((p, index) => {
    let id = p.id;
    if (id && presentationIds.has(id)) {
      report({ severity: 'error', code: 'duplicate_id', ...parsed.locate(p), message: 'Presentation id "' + id + '" is already used.' });
      return;
    }
    if (!id) {
      id = hashId('p-', p.name + '\n' + index);
      for (let k = 1; presentationIds.has(id); k++) id = hashId('p-', p.name + '\n' + index + '\n' + k);
    }
    presentationIds.add(id);
    const stepIds = new Set<string>();
    for (const step of p.steps ?? []) {
      const at = parsed.locate(step);
      for (const field of ['focus', 'reveal', 'hide'] as const) {
        for (const ref of step[field] ?? []) {
          if (!idSet.has(ref)) report({ severity: 'error', code: 'unknown_step_node', ...at,
            message: 'Step ' + field + ' "' + ref + '" is not a node id in this spec.', suggestions: suggest(ref, allIds),
            hint: 'Give the node an explicit id: "Label {#' + ref + '}".' });
        }
      }
      for (const ref of step.elements ?? []) {
        if (!elementKinds.has(ref)) report({ severity: 'error', code: 'unknown_step_element', ...at,
          message: 'Step element "' + ref + '" is not a canvas element id in this spec.', suggestions: suggest(ref, [...elementKinds.keys()]) });
      }
      if (step.id) {
        if (stepIds.has(step.id)) report({ severity: 'error', code: 'duplicate_id', ...at, message: 'Step id "' + step.id + '" is already used in this presentation.' });
        stepIds.add(step.id);
      }
    }
    presentations.push({ spec: p, id });
  });
  summary.presentations = presentations.length;
  if (diagnostics.some((d) => d.severity === 'error')) return { doc: null, diagnostics, summary };

  // Structure: the same insert ops as the Markdown importer (docFromOutlines), with deterministic ids.
  const title = spec.title ?? opts.defaultTitle ?? spec.roots[0].label;
  const doc = createDoc(title);
  const ops: Op[] = [{ t: 'remove', id: doc.roots[0] }];
  spec.roots.forEach((root, index) => {
    const info: RootInfo = { layout: root.layout ?? spec.layout ?? 'mindmap', position: { x: 0, y: index * 240 } };
    const spacing = root.spacing ?? spec.spacing;
    if (spacing) info.spacing = spacing;
    if (root.organic) info.organic = true;
    outlineInsertOps(toOutline(root), null, index, 'user', ops, info);
  });
  const renamed = new Map<NodeId, NodeId>();
  ops.slice(1).forEach((op, k) => {
    if (op.t !== 'insert') return;
    const id = finalId.get(order[k])!;
    renamed.set(op.node.id, id);
    op.node.id = id;
    if (op.parent !== null) op.node.parent = op.parent = renamed.get(op.parent) ?? op.parent;
  });
  applyOps(doc, ops);

  // Attributes, node by node, through the command helpers.
  for (const node of order) {
    const id = finalId.get(node)!;
    const style = styleOf(node);
    const edits: (Op[] | undefined)[] = [];
    if (Object.keys(style).length) edits.push(setStyle(doc, [id], style)?.tx.ops);
    if (node.side) edits.push(setSide(doc, id, node.side)?.tx.ops);
    const patch: Partial<MapNode> = {};
    if (node.sticker) patch.sticker = node.sticker;
    if (node.tags?.length) patch.tags = node.tags.slice();
    if (node.task) patch.task = { done: node.task === 'done' };
    if (node.layout && doc.nodes[id].parent !== null) patch.branchLayout = node.layout;
    if (node.image) {
      const asset = opts.assets![node.image];
      patch.imageAsset = asset.hash;
      patch.representation = 'picture';
      if (asset.aspect && Number.isFinite(asset.aspect)) patch.imageAspect = asset.aspect;
      if (node.alt) patch.imageAlt = node.alt;
      if (node.scale !== undefined) patch.imageScale = node.scale;
    } else if (node.alt || node.scale !== undefined) {
      report({ severity: 'warning', code: 'attribute_not_applicable', ...parsed.locate(node, node.alt ? 'alt' : 'scale'),
        message: '"alt" and "scale" need image= on "' + clip(node.label) + '"; they were ignored.' });
    }
    if (node.offset) patch.offset = { x: node.offset[0], y: node.offset[1] };
    if (node.pin) patch.pinnedPosition = { x: node.pin[0], y: node.pin[1] };
    if (Object.keys(patch).length) edits.push([{ t: 'set', id, patch }]);
    for (const batch of edits) if (batch) applyOps(doc, batch);
  }
  for (const link of links) {
    const edit = addLink(doc, link.from, link.to, link.label);
    const op = edit?.tx.ops[0];
    if (!op || op.t !== 'link') continue;
    op.link.id = hashId('l-', link.from + '>' + link.to);
    if (link.dash) op.link.dash = link.dash;
    if (link.arrows) op.link.arrows = link.arrows;
    if (link.color) op.link.color = link.color;
    applyOps(doc, [op]);
  }
  if (elements.length) applyOps(doc, elements.map((value) => ({ t: 'canvas', id: value.id, value })));
  for (const { spec: p, id } of presentations) {
    const value = buildPresentation(doc, p, id);
    const problems = presentationProblems(value);
    if (problems.length) {
      report({ severity: 'error', code: 'invalid_presentation', ...parsed.locate(p), message: 'Presentation "' + p.name + '" is invalid: ' + problems[0] });
      return { doc: null, diagnostics, summary };
    }
    applyOps(doc, [{ t: 'presentation', id, value }]);
  }
  const canonical = JSON.stringify(spec);
  const meta: Extract<Op, { t: 'docMeta' }>['patch'] = { title, seed: spec.seed ?? hash53(canonical) % 0x7fffffff };
  if (spec.theme) meta.themeId = spec.theme;
  const settings = parseThemeSettings(spec.themeSettings);
  if (settings) meta.themeSettings = settings;
  if (spec.tagColors) meta.tagColors = { ...spec.tagColors };
  applyOps(doc, [{ t: 'docMeta', patch: meta }]);
  const now = opts.now ?? new Date().toISOString();
  doc.id = hashId('m', canonical, 11);
  doc.created = now;
  doc.modified = now;
  const problems = validateDoc(doc);
  if (problems.length) {
    diagnostics.push({ severity: 'error', code: 'invalid_document', message: 'The compiled map is invalid: ' + problems[0] });
    return { doc: null, diagnostics, summary };
  }
  return { doc, diagnostics, summary };
}

// ====================================================================== from a document back to a spec

export interface SpecFromDocOptions {
  /** Write only this node's subtree (it becomes the single root of the spec). */
  node?: NodeId;
  /** Levels below each written root (0 = only the roots). Deeper nodes are counted in "cut". */
  depth?: number;
  /** Stop after this many nodes (pre-order); the remainder is counted in "cut". */
  maxNodes?: number;
}

export interface DocSpecResult {
  spec: MapSpec;
  /** What the spec cannot carry, with counts (FR-IO-18). */
  omissions: string[];
  /** Nodes written. */
  nodes: number;
  /** Nodes in the requested scope. */
  total: number;
  /** Written nodes whose descendants were left out, with the number left out. */
  cut: { id: NodeId; label: string; hidden: number }[];
}

/** Name used in a spec for an embedded picture. */
export const assetNameFor = (hash: string) => 'img-' + hash.slice(0, 10);

/** Describe a document (or one branch) as a spec, with every node id explicit so it builds back to the same tree. */
export function specFromDoc(doc: Doc, opts: SpecFromDocOptions = {}): DocSpecResult {
  const tops = opts.node ? [opts.node] : doc.roots.slice();
  const maxDepth = opts.depth ?? Infinity;
  const maxNodes = opts.maxNodes ?? Infinity;
  const spec: MapSpec = { radiant: 1, title: doc.title, roots: [] };
  if (doc.seed !== undefined) spec.seed = doc.seed;
  if (doc.themeSettings && Object.keys(doc.themeSettings).length) spec.themeSettings = JSON.parse(JSON.stringify(doc.themeSettings)) as Record<string, unknown>;
  if (doc.tagColors && Object.keys(doc.tagColors).length) spec.tagColors = { ...doc.tagColors };
  const counts = new Map<string, number>();
  const omit = (what: string, n = 1) => counts.set(what, (counts.get(what) ?? 0) + n);
  if (doc.themeId && specThemeIds().includes(doc.themeId)) spec.theme = doc.themeId;
  else if (doc.themeId) omit('unregistered theme "' + doc.themeId + '" (the default theme is used)');
  const assets: Record<string, string> = {};
  const cut: DocSpecResult['cut'] = [];
  const included = new Set<NodeId>();
  let written = 0;
  let total = 0;
  const sizeOf = (id: NodeId): number => {
    let n = 0;
    const stack = [id];
    while (stack.length) { const cur = stack.pop()!; n++; stack.push(...doc.nodes[cur].children); }
    return n;
  };
  for (const top of tops) total += sizeOf(top);

  const convert = (id: NodeId, depth: number): MapSpecNode => {
    const n = doc.nodes[id];
    written++;
    included.add(id);
    const out: MapSpecNode = { label: n.text, id: n.id };
    if (n.task) out.task = n.task.done ? 'done' : 'open';
    const s = n.style;
    for (const [field, value] of Object.entries(s ?? {})) {
      const attr = STYLE_ATTRIBUTES[field as keyof NodeStyle];
      if (attr && value !== undefined && value !== '') (out as unknown as Record<string, unknown>)[attr] = value;
      else if (!attr) omit('unknown style fields');
    }
    if (n.sticker) out.sticker = n.sticker;
    if (n.tags?.length) out.tags = n.tags.slice();
    if (n.link) out.href = n.link;
    if (n.collapsed) out.folded = true;
    if (n.parent === null) {
      const info = doc.rootInfo[id];
      if (info?.layout && info.layout !== 'mindmap') out.layout = info.layout;
      if (info?.spacing) out.spacing = info.spacing;
      if (info?.organic) out.organic = true;
    } else if (doc.nodes[n.parent].parent === null) {
      if (n.side) out.side = n.side;
      if (n.branchLayout) out.layout = n.branchLayout;
    }
    if (n.imageAsset) {
      const name = assetNameFor(n.imageAsset);
      assets[name] = 'sha256:' + n.imageAsset;
      out.image = name;
      if (n.imageAlt) out.alt = n.imageAlt;
      if (n.imageScale !== undefined && n.imageScale !== 1) out.scale = n.imageScale;
    }
    if (n.note) out.note = n.note;
    if (n.sketch) omit('sketches');
    if (n.pictureArt || n.svgArt || n.artReference) omit('generated-art records');
    if (n.generatedStyle) omit('generated styles');
    if (n.artStyleId || n.artStyleOverrides || n.artStyleIsland) omit('artwork style settings');
    if (n.aliasGroup) omit('alias groups (nodes)');
    if (n.origin?.by === 'ai' || n.lastAiJob) omit('AI provenance (nodes)');
    if (n.offset) omit('manual offsets');
    if (n.pinnedPosition) omit('pinned positions');
    if (n.interchange) omit('import interchange metadata');
    if (n.blankAnswer !== undefined) omit('study answers');
    if (n.representation && n.representation !== 'picture') omit('representation choices');
    if (n.pictureLabelPlacement) omit('picture label placements');
    if (n.generatedDraft) omit('generated draft markers');
    if (n.style && (s?.color && !HEX.test(s.color))) omit('non-hex colours');
    if (n.children.length) {
      if (depth >= maxDepth || written >= maxNodes) {
        const hidden = n.children.reduce((sum, c) => sum + sizeOf(c), 0);
        cut.push({ id, label: clip(n.text, 60), hidden });
      } else {
        const kids: MapSpecNode[] = [];
        for (const c of n.children) {
          if (written >= maxNodes) {
            const rest = n.children.slice(n.children.indexOf(c));
            cut.push({ id, label: clip(n.text, 60), hidden: rest.reduce((sum, r) => sum + sizeOf(r), 0) });
            break;
          }
          kids.push(convert(c, depth + 1));
        }
        if (kids.length) out.children = kids;
      }
    }
    return out;
  };
  for (const top of tops) {
    if (!doc.nodes[top]) continue;
    if (written >= maxNodes) { cut.push({ id: top, label: clip(doc.nodes[top].text, 60), hidden: sizeOf(top) }); continue; }
    spec.roots.push(convert(top, 0));
  }
  const links: MapSpecLink[] = [];
  for (const l of doc.links) {
    if (!included.has(l.from) || !included.has(l.to)) continue;
    const link: MapSpecLink = { from: l.from, to: l.to };
    if (l.label) link.label = l.label;
    if (l.dash) link.dash = l.dash;
    if (l.arrows) link.arrows = l.arrows;
    if (l.color) link.color = l.color;
    if (l.bend) omit('link bends');
    if (!SPEC_ID.test(l.from) || !SPEC_ID.test(l.to)) omit('links between nodes with non-portable ids');
    links.push(link);
  }
  if (links.length) spec.links = links;
  const nonPortable = [...included].filter((id) => !SPEC_ID.test(id)).length;
  if (nonPortable) omit('ids that are not valid spec ids (rebuilt as derived ids)', nonPortable);
  if (!opts.node && doc.roots.length > 1) omit('root positions', doc.roots.length);
  if (doc.aiJobs && Object.keys(doc.aiJobs).length) omit('AI job history', Object.keys(doc.aiJobs).length);
  if (doc.layoutPlacements) omit('settled layout placements');
  if (doc.markerMeanings && Object.keys(doc.markerMeanings).length) omit('marker meanings');
  if (doc.artStyleId) omit('map artwork style');
  if (doc.canvas?.elements.length) {
    if (opts.node) omit('canvas elements (written for the whole map only)', doc.canvas.elements.length);
    else spec.canvas = doc.canvas.elements.map((el) => {
      if (el.source && Object.keys(el.source).length) omit('Excalidraw fields kept for round trip (element source)');
      return elementSpec(el, assets);
    });
  }
  if (doc.canvas?.bookmarks?.length) omit('canvas bookmarks', doc.canvas.bookmarks.length);
  if (doc.canvas?.grid) omit('canvas grid');
  if (doc.presentations?.length) {
    if (opts.node) omit('presentations (written for the whole map only)', doc.presentations.length);
    else spec.presentations = doc.presentations.map(presentationSpec);
  }
  if (Object.keys(assets).length) spec.assets = assets;
  const omissions = [...counts].map(([what, n]) => what + ': ' + n);
  return { spec, omissions, nodes: written, total, cut };
}

// ====================================================================== writing Markdown

const entity = (char: string) => '&#' + char.charCodeAt(0) + ';';

function encodeText(text: string, characters = /[&\t\n\r]/g): string {
  return text.replace(characters, entity).replace(/^ +| +$/g, (spaces) => '&#32;'.repeat(spaces.length));
}

function encodeLabel(text: string): string {
  let out = encodeText(text, /[&\t\n\r#*_[\]<>\x60\\]/g);
  if (/\}\s*$/.test(out)) out = out.replace(/\{/g, '&#123;');
  return out;
}

function noteLines(note: string): string[] {
  const leading = /^\n*/.exec(note)![0].length;
  const rest = note.slice(leading);
  const trailing = /\n*$/.exec(rest)![0].length;
  const lines = rest.slice(0, rest.length - trailing).split('\n').map((line) => {
    const structural = MD_HEADING.test(line) || MD_BULLET.test(line) || MD_FENCE.test(line);
    if (!structural) return encodeText(line);
    const start = line.search(/\S/);
    return encodeText(line.slice(0, start)) + entity(line[start]) + encodeText(line.slice(start + 1));
  });
  lines[0] = '&#10;'.repeat(leading) + lines[0];
  lines[lines.length - 1] += '&#10;'.repeat(trailing);
  return lines;
}

const attrValue = (value: string) => /^[^\s{}"]+$/.test(value) ? value : JSON.stringify(value);

function attributeBlock(node: MapSpecNode, includeNote: boolean): string {
  const parts: string[] = [];
  if (node.id) parts.push('#' + node.id);
  const known = new Set<string>(SPEC_NODE_ATTRIBUTES);
  for (const key of Object.keys(node) as (keyof MapSpecNode)[]) {
    if (!known.has(key) || key === 'id' || key === 'task' || (key === 'note' && !includeNote)) continue;
    const value = node[key];
    if (value === undefined) continue;
    if (value === true) parts.push(key);
    else if (Array.isArray(value)) parts.push(key + '=' + attrValue(value.join(',')));
    else parts.push(key + '=' + attrValue(String(value)));
  }
  return parts.length ? ' {' + parts.join(' ') + '}' : '';
}

function yamlScalar(value: string): string {
  return /^[A-Za-z_][\w .,()/&+@'-]*$/.test(value) && !/\s$/.test(value) && typeof scalar(value) === 'string' ? value : JSON.stringify(value);
}

/** A canvas element as written in a spec: every stored field except the Excalidraw source, the picture by asset name. */
function elementSpec(el: CanvasElement, assets: Record<string, string>): MapSpecElement {
  const out: Record<string, unknown> = { kind: el.kind, id: el.id, x: el.x, y: el.y, w: el.w, h: el.h };
  for (const key of ELEMENT_FIELDS) {
    const value = el[key];
    if (value === undefined) continue;
    if (key === 'asset') {
      const name = assetNameFor(value as string);
      assets[name] = 'sha256:' + value;
      out.image = name;
    } else out[key] = Array.isArray(value) ? value.slice() : value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  }
  return out as MapSpecElement;
}

function presentationSpec(p: Presentation): MapSpecPresentation {
  const out: MapSpecPresentation = { name: p.name, id: p.id };
  if (p.reveal) out.reveal = p.reveal;
  if (p.context) out.context = p.context;
  if (p.dimOpacity !== undefined) out.dimOpacity = p.dimOpacity;
  if (p.motion) out.motion = p.motion;
  if (p.targetMinutes !== undefined) out.targetMinutes = p.targetMinutes;
  out.steps = p.steps.map((s) => {
    const step: MapSpecStep = { focus: s.focus.slice(), id: s.id };
    for (const key of ['title', 'reveal', 'hide', 'elements', 'frame', 'build', 'dim', 'caption', 'note', 'transition', 'skip', 'seconds'] as const) {
      const value = s[key];
      if (value !== undefined && !(Array.isArray(value) && !value.length)) (step as unknown as Record<string, unknown>)[key] = Array.isArray(value) ? value.slice() : value;
    }
    return step;
  });
  return out;
}

const numberText = (n: number) => String(n);
const attrText = (value: string) => /^[^\s{}"]+$/.test(value) ? value : JSON.stringify(value);

/** One line of a presentation block. */
function stepLine(s: MapSpecStep): string {
  const attrs: string[] = [];
  if (s.id) attrs.push('#' + s.id);
  for (const key of ['reveal', 'hide', 'elements'] as const) if (s[key]?.length) attrs.push(key + '=' + s[key]!.join(','));
  for (const key of ['frame', 'build', 'dim', 'transition'] as const) if (s[key]) attrs.push(key + '=' + s[key]);
  for (const key of ['caption', 'note'] as const) if (s[key] !== undefined) attrs.push(key + '=' + JSON.stringify(s[key]));
  if (s.seconds !== undefined) attrs.push('seconds=' + numberText(s.seconds));
  if (s.skip) attrs.push('skip');
  const title = s.title ? ' : ' + encodeText(s.title).replace(/\{/g, '&#123;') : '';
  return (s.focus.join(', ') + title + (attrs.length ? ' {' + attrs.join(' ') + '}' : '')).trim();
}

/** One line of a canvas block. */
function canvasLine(el: MapSpecElement): string {
  const parts: string[] = [el.kind];
  if (el.id) parts.push('#' + el.id);
  if (el.x !== undefined || el.y !== undefined) parts.push('at=' + numberText(el.x ?? 0) + ',' + numberText(el.y ?? 0));
  if (el.w !== undefined || el.h !== undefined) parts.push('size=' + numberText(el.w ?? 0) + 'x' + numberText(el.h ?? 0));
  const bindingParts = (end: 'start' | 'end', name: 'from' | 'to') => {
    const b = el[end];
    const target = b?.node ?? b?.element ?? (end === 'start' ? el.from : el.to);
    if (!target) return;
    parts.push(name + '=' + target);
    if (b?.at) parts.push(name + '-at=' + numberText(b.at.x) + ',' + numberText(b.at.y));
    if (b?.gap !== undefined) parts.push(name + '-gap=' + numberText(b.gap));
  };
  for (const key of ELEMENT_FIELDS) {
    if (key === 'text' || key === 'asset') continue;
    if (key === 'start') { bindingParts('start', 'from'); continue; }
    if (key === 'end') { bindingParts('end', 'to'); continue; }
    const value = el[key];
    if (value === undefined) continue;
    if (value === true) parts.push(key);
    else if (Array.isArray(value)) parts.push(key + '=' + value.map((v) => typeof v === 'number' ? numberText(v) : String(v)).join(','));
    else if (typeof value === 'number') parts.push(key + '=' + numberText(value));
    else parts.push(key + '=' + attrText(String(value)));
  }
  if (el.image) parts.push('image=' + el.image);
  return parts.join(' ') + (el.text !== undefined && el.text !== '' ? ' : ' + encodeText(el.text) : '');
}

export interface WriteSpecOptions {
  /** Front matter and the links block. Default true; false writes only the outline. */
  frontMatter?: boolean;
}

/** Write a spec as Markdown with attributes. The result parses back to the same spec. */
export function writeMapSpecMarkdown(spec: MapSpec, opts: WriteSpecOptions = {}): string {
  const out: string[] = [];
  const full = opts.frontMatter !== false;
  if (full) {
    out.push('---', 'radiant: ' + MAP_SPEC_VERSION);
    if (spec.title !== undefined) out.push('title: ' + yamlScalar(spec.title));
    if (spec.theme) out.push('theme: ' + yamlScalar(spec.theme));
    if (spec.layout) out.push('layout: ' + spec.layout);
    if (spec.spacing) out.push('spacing: ' + spec.spacing);
    if (spec.seed !== undefined) out.push('seed: ' + spec.seed);
    if (spec.themeSettings) out.push('themeSettings: ' + JSON.stringify(spec.themeSettings));
    if (spec.tagColors) out.push('tagColors: ' + JSON.stringify(spec.tagColors));
    if (spec.assets && Object.keys(spec.assets).length) {
      out.push('assets:');
      for (const [name, path] of Object.entries(spec.assets)) out.push('  ' + name + ': ' + yamlScalar(path));
    }
    out.push('---', '');
  }
  const write = (node: MapSpecNode, depth: number) => {
    const task = node.task ? (node.task === 'done' ? '[x] ' : '[ ] ') : '';
    let label = encodeLabel(node.label);
    const attrs = attributeBlock(node, false);
    if (!label && !attrs && !task) label = '{}';
    if (depth < 2) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push('#'.repeat(depth + 1) + ' ' + task + label + attrs);
      if (node.note) out.push('', ...noteLines(node.note));
      if (node.children?.length && depth === 1) out.push('');
    } else {
      const pad = '  '.repeat(depth - 2);
      out.push(pad + '- ' + task + label + attrs);
      if (node.note) for (const l of noteLines(node.note)) out.push(l.trim() ? pad + '  ' + l : '');
    }
    for (const c of node.children ?? []) write(c, depth + 1);
  };
  for (const root of spec.roots) write(root, 0);
  if (full && spec.links?.length) {
    const fence = '\x60\x60\x60';
    out.push('', fence + 'links');
    for (const l of spec.links) {
      const attrs: string[] = [];
      if (l.dash) attrs.push('dash=' + l.dash);
      if (l.arrows) attrs.push('arrows=' + l.arrows);
      if (l.color) attrs.push('color=' + l.color);
      let label = l.label ? encodeText(l.label).replace(/\{/g, '&#123;') : '';
      if (label.includes('->')) label = label.replace(/-/g, '&#45;');
      out.push(l.from + ' -> ' + l.to + (label ? ' : ' + label : '') + (attrs.length ? ' {' + attrs.join(' ') + '}' : ''));
    }
    out.push(fence);
  }
  const fence = '\x60\x60\x60';
  if (full && spec.canvas?.length) {
    out.push('', fence + 'canvas');
    for (const el of spec.canvas) out.push(canvasLine(el));
    out.push(fence);
  }
  if (full) for (const p of spec.presentations ?? []) {
    const attrs = ['name=' + JSON.stringify(p.name)];
    if (p.id) attrs.push('id=' + p.id);
    if (p.reveal) attrs.push('reveal=' + p.reveal);
    if (p.context) attrs.push('context=' + p.context);
    if (p.dimOpacity !== undefined) attrs.push('opacity=' + numberText(p.dimOpacity));
    if (p.motion) attrs.push('motion=' + p.motion);
    if (p.targetMinutes !== undefined) attrs.push('minutes=' + numberText(p.targetMinutes));
    out.push('', fence + 'presentation ' + attrs.join(' '));
    if (p.auto) out.push('auto ' + p.auto);
    for (const s of p.steps ?? []) out.push(stepLine(s));
    out.push(fence);
  }
  return out.join('\n') + '\n';
}

// ====================================================================== pieces shared with the agent edit vocabulary (core/model/agent-ops.ts)

/** The outline (text, note, fold, link and children) of a spec node. */
export const specOutline = (node: MapSpecNode): OutlineNode => toOutline(node);

/** The NodeStyle a spec node's attributes describe. */
export const specStyle = (node: MapSpecNode): NodeStyle => styleOf(node);

/**
 * Parse one presentation step given as a step line ("ids : title {attributes}") or a JSON step object.
 * Node and element ids are not checked here.
 */
export function parseSpecStep(value: unknown): { step: MapSpecStep | null; diagnostics: SpecDiagnostic[] } {
  const reader = new SpecReader({});
  const at: SpecLocation = { path: 'step' };
  if (typeof value === 'string') {
    const p: MapSpecPresentation = { name: 'step' };
    readStepLine(reader, p, value.trim(), at);
    if (p.auto) reader.report({ severity: 'error', code: 'auto_steps', ...at, message: '"auto" is not a step; use auto= on presentation-set.' });
    return { step: p.steps?.[0] ?? null, diagnostics: reader.diagnostics };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reader.report({ severity: 'error', code: 'spec_syntax', ...at, message: 'A step is an object with "focus", or a step line.' });
    return { step: null, diagnostics: reader.diagnostics };
  }
  const { focus, ...fields } = value as Record<string, unknown>;
  return { step: reader.step(focus, Object.entries(fields), at), diagnostics: reader.diagnostics };
}

/** Context for {@link compileSpecElement}: which ids exist, and how picture names resolve. */
export interface SpecElementContext {
  nodes: ReadonlySet<string>;
  elements: ReadonlyMap<string, CanvasElementKind>;
  /** Content hash for an image name, if known. */
  asset?: (name: string) => ResolvedSpecAsset | undefined;
}

/**
 * Compile one canvas element given as a canvas line or a JSON object (the forms of the canvas block) into a
 * CanvasElement. A missing id uses fallbackId; a missing seed is derived from the id.
 */
export function compileSpecElement(value: unknown, ctx: SpecElementContext, fallbackId: (kind: CanvasElementKind) => string):
    { element: CanvasElement | null; diagnostics: SpecDiagnostic[] } {
  const reader = new SpecReader({});
  const at: SpecLocation = { path: 'element' };
  let el: MapSpecElement | null = null;
  if (typeof value === 'string') el = readCanvasLine(reader, value.trim(), at);
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { kind, ...rest } = value as Record<string, unknown>;
    el = reader.element(kind, Object.entries(rest), at);
  } else reader.report({ severity: 'error', code: 'canvas_syntax', ...at, message: 'A canvas element is an object with "kind", or a canvas line.' });
  if (!el || reader.diagnostics.some((d) => d.severity === 'error')) return { element: null, diagnostics: reader.diagnostics };
  const id = el.id ?? fallbackId(el.kind);
  if (ctx.elements.has(id) || ctx.nodes.has(id)) {
    reader.report({ severity: 'error', code: 'duplicate_id', ...at, message: 'Id "' + id + '" is already used by a node or element.' });
    return { element: null, diagnostics: reader.diagnostics };
  }
  const kinds = new Map(ctx.elements);
  kinds.set(id, el.kind);
  const assets: Record<string, ResolvedSpecAsset> = {};
  if (el.image) { const found = ctx.asset?.(el.image); if (found) assets[el.image] = found; }
  const element = buildElement(el, id, ctx.nodes, kinds, assets, Object.keys(assets), (d) => reader.report(d), at, [...ctx.nodes]);
  return { element, diagnostics: reader.diagnostics };
}

// ====================================================================== document lint (rules that need no layout)

export type LintSeverity = 'error' | 'warn' | 'info';

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  ids: NodeId[];
  message: string;
  hint: string;
}

export interface LintThresholds {
  /** long-label: more words than this. Default 6. */
  maxWords: number;
  /** wide-fanout: more children than this. Default 9. */
  maxChildren: number;
  /** low-contrast: ratio below this. Default 4.5. */
  minContrast: number;
  /** deep-chain: this many or more single children in a row. Default 4. */
  chain: number;
}

export const LINT_DEFAULTS: LintThresholds = { maxWords: 6, maxChildren: 9, minContrast: 4.5, chain: 4 };

/** Every rule of the lint table, and the ones computed from the document alone. */
export const LINT_RULES: readonly { rule: string; severity: LintSeverity; documentOnly: boolean; presentation?: true }[] = [
  { rule: 'overlap', severity: 'error', documentOnly: false },
  { rule: 'empty-label', severity: 'error', documentOnly: true },
  { rule: 'dangling-link', severity: 'error', documentOnly: true },
  { rule: 'long-label', severity: 'warn', documentOnly: true },
  { rule: 'wide-fanout', severity: 'warn', documentOnly: true },
  { rule: 'duplicate-sibling', severity: 'warn', documentOnly: true },
  { rule: 'low-contrast', severity: 'warn', documentOnly: true },
  { rule: 'tiny-in-render', severity: 'warn', documentOnly: false },
  { rule: 'unbalanced', severity: 'info', documentOnly: false },
  { rule: 'deep-chain', severity: 'info', documentOnly: true },
  { rule: 'adjacent-colour', severity: 'info', documentOnly: true },
  { rule: 'missing-alt', severity: 'info', documentOnly: true },
  { rule: 'extreme-aspect', severity: 'info', documentOnly: false },
  { rule: 'element-overlap', severity: 'info', documentOnly: false },
  { rule: 'step-broken', severity: 'error', documentOnly: false, presentation: true },
  { rule: 'step-reveal', severity: 'warn', documentOnly: false, presentation: true },
  { rule: 'step-long-label', severity: 'warn', documentOnly: false, presentation: true },
  { rule: 'step-jump', severity: 'warn', documentOnly: false, presentation: true },
  { rule: 'unvisited-branch', severity: 'info', documentOnly: false, presentation: true }
];

/** The theme a document draws with: the registered theme and the document's overrides. */
export function themeForDoc(doc: Doc, dark?: boolean): Theme {
  return { ...getTheme(doc.themeId, dark), ...(doc.themeSettings ?? {}) } as Theme;
}

function rgb(hex: string): [number, number, number] | null {
  const h = normalHex(hex);
  if (!h) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(1 + i, 3 + i), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two hex colours, or null when either is not a hex colour. */
export function contrastRatio(a: string, b: string): number | null {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Lint rules that need only the document and its theme. Layout rules (overlap, tiny-in-render, unbalanced,
 * extreme-aspect) and the line-count half of long-label need the layout report and are not run here.
 */
export function lintDocument(doc: Doc, limits: Partial<LintThresholds> = {}, scope?: NodeId): LintIssue[] {
  const t = { ...LINT_DEFAULTS, ...limits };
  const issues: LintIssue[] = [];
  const add = (rule: string, severity: LintSeverity, ids: NodeId[], message: string, hint: string) =>
    issues.push({ rule, severity, ids, message, hint });
  const ids: NodeId[] = [];
  const depth = new Map<NodeId, number>();
  const main = new Map<NodeId, number>();
  const stack: NodeId[] = scope ? [scope] : doc.roots.slice().reverse();
  if (scope) {
    let d = 0;
    for (let p = doc.nodes[scope]?.parent ?? null; p !== null; p = doc.nodes[p].parent) d++;
    depth.set(scope, d);
  } else for (const r of doc.roots) depth.set(r, 0);
  while (stack.length) {
    const id = stack.pop()!;
    const n = doc.nodes[id];
    if (!n) continue;
    ids.push(id);
    const d = depth.get(id)!;
    n.children.forEach((c, i) => {
      depth.set(c, d + 1);
      main.set(c, d === 0 ? i : main.get(id) ?? -1);
    });
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
  }
  const theme = themeForDoc(doc);
  const resolver = createStyleResolver(doc, theme);
  const inScope = new Set(ids);

  for (const id of ids) {
    const n = doc.nodes[id];
    const label = n.text.trim();
    const picture = !!(n.imageAsset || n.pictureArt || n.svgArt);
    if (!label && !picture) add('empty-label', 'error', [id], 'Node ' + id + ' has no text and no picture.', 'Give it a label, attach a picture, or delete it.');
    const words = label ? label.split(/\s+/).length : 0;
    if (words > t.maxWords) add('long-label', 'warn', [id], '"' + clip(label) + '" has ' + words + ' words (limit ' + t.maxWords + ').',
      'Keep a keyword in the label and move the rest into the note or a child.');
    if (n.children.length > t.maxChildren) add('wide-fanout', 'warn', [id], '"' + clip(label) + '" has ' + n.children.length + ' children (limit ' + t.maxChildren + ').',
      'Group the children under a few intermediate nodes.');
    const seen = new Map<string, NodeId>();
    for (const c of n.children) {
      const key = doc.nodes[c].text.trim().toLowerCase();
      if (!key) continue;
      const first = seen.get(key);
      if (first) add('duplicate-sibling', 'warn', [first, c], 'Two children of "' + clip(label) + '" are both "' + clip(doc.nodes[c].text) + '".', 'Merge them or make the labels distinct.');
      else seen.set(key, c);
    }
    if (n.imageAsset && !n.imageAlt?.trim()) add('missing-alt', 'info', [id], 'The picture on "' + clip(label || id) + '" has no alt text.', 'Add alt="…" to the node.');
    if (label) {
      const style = resolver.get(id, depth.get(id) ?? 0, main.get(id));
      const filled = style.shape !== 'none' && style.shape !== 'underline' && !!style.fillColor;
      const behind = filled ? style.fillColor! : theme.background;
      const ratio = contrastRatio(style.textColor, behind);
      if (ratio !== null && ratio < t.minContrast) add('low-contrast', 'warn', [id],
        'Text on "' + clip(label) + '" has contrast ' + ratio.toFixed(2) + ':1 against ' + (filled ? 'its fill' : 'the canvas') + ' (minimum ' + t.minContrast + ':1).',
        'Change text= or fill= on the node, or pick another theme.');
    }
  }
  // deep-chain: report the top of each run of single children.
  for (const id of ids) {
    const n = doc.nodes[id];
    if (n.children.length !== 1) continue;
    const parent = n.parent === null ? null : doc.nodes[n.parent];
    if (parent && parent.children.length === 1 && inScope.has(parent.id)) continue;
    const run: NodeId[] = [id];
    let cur = n;
    while (cur.children.length === 1) { cur = doc.nodes[cur.children[0]]; run.push(cur.id); }
    if (run.length - 1 >= t.chain) add('deep-chain', 'info', run, 'A chain of ' + (run.length - 1) + ' single children starts at "' + clip(n.text) + '".',
      'Merge the chain into fewer nodes, or put the detail in a note.');
  }
  for (const link of doc.links) {
    if (!doc.nodes[link.from] || !doc.nodes[link.to]) add('dangling-link', 'error', [link.from, link.to].filter((x) => doc.nodes[x]),
      'Link ' + link.id + ' names a missing node.', 'Remove the link or restore the node.');
  }
  // adjacent-colour: neighbouring main branches, around each root.
  const roots = scope ? (doc.nodes[scope]?.parent === null ? [scope] : []) : doc.roots;
  for (const r of roots) {
    const kids = doc.nodes[r].children;
    if (kids.length < 2) continue;
    const colours = kids.map((c, i) => resolver.get(c, 1, i).color);
    for (let i = 0; i < kids.length; i++) {
      const j = (i + 1) % kids.length;
      if (j === i || (kids.length === 2 && i === 1)) continue;
      const a = rgb(colours[i]);
      const b = rgb(colours[j]);
      if (!a || !b) continue;
      const distance = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (distance < 40) add('adjacent-colour', 'info', [kids[i], kids[j]],
        'Neighbouring main branches "' + clip(doc.nodes[kids[i]].text) + '" and "' + clip(doc.nodes[kids[j]].text) + '" have near-identical colours.',
        'Set color= on one of them.');
    }
  }
  const order: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}

// ====================================================================== layout report and layout lint (AGT-VIS-01, 02; AGT-EXT-07)

/** Line height of a label as a multiple of the font size (render/text.ts). */
const LINE_HEIGHT = 1.25;
const PICTURE_HEIGHT = 100;
const PICTURE_GAP = 8;

/** Width of one character as a fraction of the font size, for a proportional sans-serif face (approximate). */
function charWidth(c: string): number {
  if (c === ' ') return 0.28;
  if (/[ilI.,:;'|!`()[\]{}jft]/.test(c)) return 0.3;
  if (/[mwMW@%]/.test(c)) return 0.86;
  if (/[A-Z]/.test(c)) return 0.66;
  if (/[0-9]/.test(c)) return 0.56;
  if (/[a-z]/.test(c)) return 0.53;
  const code = c.codePointAt(0) ?? 0;
  if (code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || code >= 0x1f300)) return 1;
  return 0.58;
}

/** Approximate width of one line of text in world units. */
export function approximateTextWidth(text: string, font: FontSpec): number {
  let w = 0;
  for (const c of text) w += charWidth(c);
  const mono = /mono|courier|menlo/i.test(font.family);
  return (mono ? [...text].length * 0.6 : w) * font.size * (font.bold ? 1.06 : 1);
}

/** Greedy word wrap with approximate widths (the algorithm of render/text.ts): line count and widest line. */
export function approximateWrap(text: string, font: FontSpec, maxWidth: number): { lines: number; w: number } {
  let lines = 0;
  let widest = 0;
  const push = (w: number) => { lines++; widest = Math.max(widest, w); };
  for (const para of text.split('\n')) {
    const words = para.split(/[ \t]+/).filter(Boolean);
    if (!words.length) { push(0); continue; }
    let line = '';
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (!line || approximateTextWidth(candidate, font) <= maxWidth) {
        if (!line && approximateTextWidth(word, font) > maxWidth) {
          // A word wider than the line breaks across lines.
          const chars = [...word];
          let part = '';
          for (const ch of chars) {
            if (part && approximateTextWidth(part + ch, font) > maxWidth) { push(approximateTextWidth(part, font)); part = ch; } else part += ch;
          }
          line = part;
        } else line = candidate;
      } else {
        push(approximateTextWidth(line, font));
        line = word;
      }
    }
    push(approximateTextWidth(line, font));
  }
  return { lines, w: widest };
}

/** A DOM-free text measurer for the layout pipeline. Its results are approximate; reports say so. */
export const approximateMeasure: MeasureFn = (text, font, maxWidth) => {
  const r = approximateWrap(text, font, maxWidth);
  return { w: r.w, h: r.lines * font.size * LINE_HEIGHT };
};

export interface LayoutReportBox {
  id: NodeId;
  /** Centre and size, world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
  side: -1 | 0 | 1;
  mainBranch: number;
  lines: number;
  fontSize: number;
}

export interface LayoutReportElement {
  id: string;
  kind: CanvasElementKind;
  band: 'back' | 'front';
  /** Centre and size of everything drawn for the element, world units. */
  x: number;
  y: number;
  w: number;
  h: number;
  frame?: string;
}

export interface LayoutReport {
  engine: 'headless';
  metrics: 'approximate';
  bounds: Rect;
  aspect: number;
  nodes: number;
  visible: number;
  depth: number;
  roots: { id: NodeId; layout: LayoutKind; x: number; y: number }[];
  sides: { left: { nodes: number; extent: number }; right: { nodes: number; extent: number } };
  boxes: LayoutReportBox[];
  elements: LayoutReportElement[];
  /** Smallest label font size among visible nodes, world units. */
  smallestFontSize: number;
}

export interface LayoutReportOptions {
  /** Text measurer; default {@link approximateMeasure}. */
  measure?: MeasureFn;
  /** Report only this node's visible subtree (bounds and sides cover it alone). */
  node?: NodeId;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Lay out a document with the pure layout pipeline (settled placements honoured, as the app does on open) and a
 * DOM-free measurer. Pictures use their declared aspect. Canvas elements are reported beside the node boxes.
 */
export function layoutReport(doc: Doc, opts: LayoutReportOptions = {}): LayoutReport {
  const theme = themeForDoc(doc);
  const themeFor = treeThemes(doc, theme);
  const base = opts.measure ?? approximateMeasure;
  let lastLines = 1;
  const measure: MeasureFn = (text, font, maxWidth) => {
    const size = base(text, font, maxWidth);
    lastLines = Math.max(1, Math.round(size.h / (font.size * LINE_HEIGHT)));
    return size;
  };
  const sizes = new Map<NodeId, Size>();
  const lines = new Map<NodeId, number>();
  const fonts = new Map<NodeId, number>();
  const resolver = createStyleResolver(doc, theme);
  const stack: [NodeId, number, number][] = doc.roots.map((r) => [r, 0, -1]);
  while (stack.length) {
    const [id, depth, main] = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    const local = themeFor(id);
    lastLines = node.text ? 1 : 0;
    const numbered = local.branchMarkers && depth === 1 ? main : undefined;
    let size = nodeSize(node, depth, local, measure, numbered);
    if (node.imageAsset && !local.lean) {
      const aspect = node.imageAspect && node.imageAspect > 0 ? node.imageAspect : 1.5;
      const scale = Math.min(6, Math.max(0.25, node.imageScale ?? 1)) * (depth === 0 && local.centralImage !== false ? 1.35 : 1);
      const h = Math.min(PICTURE_HEIGHT, 220 / aspect) * scale;
      size = { w: Math.max(size.w, h * aspect + 8), h: size.h + h + PICTURE_GAP };
    }
    sizes.set(id, size);
    lines.set(id, lastLines);
    fonts.set(id, resolver.get(id, depth, main < 0 ? undefined : main).font.size);
    if (!node.collapsed) node.children.forEach((c, i) => stack.push([c, depth + 1, depth === 0 ? i : main]));
  }
  const settled = settleLayout(doc, sizes, { levelGap: theme.levelGap, siblingGap: theme.siblingGap }, doc.layoutPlacements);
  let scope: Set<NodeId> | null = null;
  if (opts.node) {
    scope = new Set();
    const pending = [opts.node];
    while (pending.length) {
      const id = pending.pop()!;
      if (!settled.boxes.has(id)) continue;
      scope.add(id);
      pending.push(...doc.nodes[id].children);
    }
  }
  const boxes: LayoutReportBox[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let maxDepth = 0;
  let smallest = Infinity;
  const sides = { left: { nodes: 0, top: Infinity, bottom: -Infinity }, right: { nodes: 0, top: Infinity, bottom: -Infinity } };
  const grow = (x: number, y: number, w: number, h: number) => {
    x0 = Math.min(x0, x - w / 2); y0 = Math.min(y0, y - h / 2); x1 = Math.max(x1, x + w / 2); y1 = Math.max(y1, y + h / 2);
  };
  for (const box of settled.boxes.values()) {
    if (scope && !scope.has(box.id)) continue;
    const fontSize = fonts.get(box.id) ?? theme.fontSize;
    boxes.push({ id: box.id, x: round2(box.x), y: round2(box.y), w: round2(box.w), h: round2(box.h), depth: box.depth, side: box.side,
      mainBranch: box.mainBranch, lines: lines.get(box.id) ?? 1, fontSize });
    grow(box.x, box.y, box.w, box.h);
    maxDepth = Math.max(maxDepth, box.depth);
    if (doc.nodes[box.id]?.text.trim()) smallest = Math.min(smallest, fontSize);
    if (box.side !== 0 && box.depth > 0) {
      const s = box.side < 0 ? sides.left : sides.right;
      s.nodes++;
      s.top = Math.min(s.top, box.y - box.h / 2);
      s.bottom = Math.max(s.bottom, box.y + box.h / 2);
    }
  }
  const elements: LayoutReportElement[] = [];
  const list = opts.node ? [] : doc.canvas?.elements ?? [];
  if (list.length) {
    const points = resolveCanvasPoints(list, settled.boxes);
    for (const el of list) {
      const r = elementBounds(el, points.get(el.id));
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
      elements.push({ id: el.id, kind: el.kind, band: elementBand(el), x: round2(r.x + r.w / 2), y: round2(r.y + r.h / 2),
        w: round2(r.w), h: round2(r.h), ...(el.frame ? { frame: el.frame } : {}) });
      grow(r.x + r.w / 2, r.y + r.h / 2, r.w, r.h);
    }
  }
  const bounds: Rect = x0 === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: round2(x0), y: round2(y0), w: round2(x1 - x0), h: round2(y1 - y0) };
  const extent = (s: { top: number; bottom: number }) => (s.top === Infinity ? 0 : round2(s.bottom - s.top));
  return {
    engine: 'headless',
    metrics: 'approximate',
    bounds,
    aspect: bounds.h > 0 ? round2(bounds.w / bounds.h) : 0,
    nodes: scope ? countSubtree(doc, opts.node!) : Object.keys(doc.nodes).length,
    visible: boxes.length,
    depth: maxDepth,
    roots: doc.roots.filter((r) => !scope || scope.has(r)).map((id) => ({ id, layout: doc.rootInfo[id]?.layout ?? 'mindmap',
      x: round2(settled.boxes.get(id)?.x ?? 0), y: round2(settled.boxes.get(id)?.y ?? 0) })),
    sides: { left: { nodes: sides.left.nodes, extent: extent(sides.left) }, right: { nodes: sides.right.nodes, extent: extent(sides.right) } },
    boxes,
    elements,
    smallestFontSize: smallest === Infinity ? 0 : smallest
  };
}

function countSubtree(doc: Doc, id: NodeId): number {
  let n = 0;
  const stack = [id];
  while (stack.length) { const cur = stack.pop()!; if (!doc.nodes[cur]) continue; n++; stack.push(...doc.nodes[cur].children); }
  return n;
}

export interface LayoutLintThresholds {
  /** long-label: more wrapped lines than this. Default 2. */
  maxLines: number;
  /** tiny-in-render: smallest label under this many pixels. Default 9. */
  minPixels: number;
  /** Long edge of the image the map would be rendered to. Default 1,568. */
  maxEdge: number;
  /** unbalanced: one side over this many times the other. Default 1.6. */
  balance: number;
  /** extreme-aspect: wider or taller than this ratio. Default 3. */
  aspect: number;
}

export const LAYOUT_LINT_DEFAULTS: LayoutLintThresholds = { maxLines: 2, minPixels: 9, maxEdge: 1568, balance: 1.6, aspect: 3 };

const boxOf = (b: { id: string; x: number; y: number; w: number; h: number }): NodeBox =>
  ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, depth: 0, side: 0, flow: 'h', mainBranch: -1 });

/**
 * Lint rules that need the layout report: overlap, the line-count half of long-label, tiny-in-render, unbalanced,
 * extreme-aspect, and element-overlap (a canvas element over a node, AGT-EXT-07).
 */
export function lintLayout(doc: Doc, report: LayoutReport, limits: Partial<LayoutLintThresholds> = {}): LintIssue[] {
  const t = { ...LAYOUT_LINT_DEFAULTS, ...limits };
  const issues: LintIssue[] = [];
  const add = (rule: string, severity: LintSeverity, ids: string[], message: string, hint: string) => issues.push({ rule, severity, ids, message, hint });
  const label = (id: string) => clip(doc.nodes[id]?.text || id);
  // overlap: sweep by left edge.
  const sorted = report.boxes.slice().sort((a, b) => (a.x - a.w / 2) - (b.x - b.w / 2));
  let overlapCount = 0;
  for (let i = 0; i < sorted.length && overlapCount < 200; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.x - b.w / 2 >= a.x + a.w / 2) break;
      if (overlaps(boxOf(a), boxOf(b), -0.5)) {
        overlapCount++;
        add('overlap', 'error', [a.id, b.id], '"' + label(a.id) + '" and "' + label(b.id) + '" overlap.',
          'Clear manual offsets with set {offset: null}, move one branch to the other side, or space the roots apart.');
      }
    }
  }
  for (const b of report.boxes) {
    if (b.lines > t.maxLines) add('long-label', 'warn', [b.id], '"' + label(b.id) + '" wraps to ' + b.lines + ' lines (limit ' + t.maxLines + ').',
      'Shorten the label and move detail into the note or a child.');
  }
  const longEdge = Math.max(report.bounds.w, report.bounds.h);
  if (longEdge > 0 && report.smallestFontSize > 0) {
    const scale = Math.min(2, t.maxEdge / longEdge);
    const px = report.smallestFontSize * scale;
    if (px < t.minPixels) {
      const tiny = report.boxes.filter((b) => b.fontSize * scale < t.minPixels && doc.nodes[b.id]?.text.trim()).map((b) => b.id);
      const deepest = report.boxes.reduce((best, b) => (b.depth === 1 && (!best || b.w * b.h > best.w * best.h) ? b : best), null as LayoutReportBox | null);
      add('tiny-in-render', 'warn', tiny.slice(0, 50), 'At ' + t.maxEdge + ' px the smallest labels are ' + px.toFixed(1) + ' px high (limit ' + t.minPixels + ' px); ' + tiny.length + ' labels are too small.',
        deepest ? 'Render a branch instead: --node ' + deepest.id + ', or fold deep levels.' : 'Render a branch instead, or fold deep levels.');
    }
  }
  for (const root of report.roots) {
    if (root.layout !== 'mindmap' || (doc.nodes[root.id]?.children.length ?? 0) < 2) continue;
    let left = 0, right = 0;
    let lt = Infinity, lb = -Infinity, rt = Infinity, rb = -Infinity;
    for (const b of report.boxes) {
      if (b.depth === 0 || !inTree(doc, b.id, root.id)) continue;
      if (b.side < 0) { left++; lt = Math.min(lt, b.y - b.h / 2); lb = Math.max(lb, b.y + b.h / 2); }
      else if (b.side > 0) { right++; rt = Math.min(rt, b.y - b.h / 2); rb = Math.max(rb, b.y + b.h / 2); }
    }
    const le = left ? lb - lt : 0;
    const re = right ? rb - rt : 0;
    const big = Math.max(le, re);
    const small = Math.min(le, re);
    if (big > 0 && (small === 0 ? left + right > 4 : big / small > t.balance)) {
      const heavy = le > re ? 'left' : 'right';
      const branch = (doc.nodes[root.id].children.map((c) => report.boxes.find((b) => b.id === c)).filter((b): b is LayoutReportBox => !!b)
        .filter((b) => (b.side < 0) === (heavy === 'left')).sort((a, b) => b.h - a.h)[0]);
      add('unbalanced', 'info', [root.id], 'The ' + heavy + ' side of "' + label(root.id) + '" is ' + Math.round(big) + ' high and the other ' + Math.round(small) + '.',
        branch ? 'Move "' + label(branch.id) + '" to the other side with set {side: "' + (heavy === 'left' ? 'right' : 'left') + '"}, or fold it.' : 'Move a main branch to the other side.');
    }
  }
  if (report.bounds.w > 0 && report.bounds.h > 0) {
    const ratio = report.bounds.w / report.bounds.h;
    if (ratio > t.aspect || ratio < 1 / t.aspect) add('extreme-aspect', 'info', doc.roots.slice(0, 1),
      'The map is ' + (ratio > 1 ? ratio.toFixed(1) + ' times wider than tall' : (1 / ratio).toFixed(1) + ' times taller than wide') + '.',
      ratio > 1 ? 'Try layout=mindmap or layout=down, or move branches to balance the sides.' : 'Try layout=right or layout=mindmap.');
  }
  // element-overlap: a canvas shape, note, text or picture over a node.
  const covering = report.elements.filter((e) => e.kind !== 'frame' && e.kind !== 'arrow' && e.kind !== 'line');
  let elementCount = 0;
  for (const e of covering) {
    for (const b of report.boxes) {
      if (elementCount >= 200) break;
      if (!overlaps(boxOf(e), boxOf(b), -0.5)) continue;
      elementCount++;
      add('element-overlap', 'info', [e.id, b.id], 'Canvas ' + e.kind + ' ' + e.id + ' (' + e.band + ' band) overlaps node "' + label(b.id) + '".',
        e.band === 'front' ? 'Move the element with canvas-set {x, y}, or send it under the maps with canvas-order {band: "back"}.'
          : 'Move the element with canvas-set {x, y} so the node is not drawn over it.');
    }
  }
  return issues;
}

function inTree(doc: Doc, id: NodeId, root: NodeId): boolean {
  let cur: NodeId | null = id;
  while (cur !== null && doc.nodes[cur]) { if (cur === root) return true; cur = doc.nodes[cur].parent; }
  return false;
}

/** View size assumed by the presentation pre-flight when no window is known. */
const PREFLIGHT_VIEW = { w: 1440, h: 900, pad: 48, maxZoom: 2 };

/**
 * Presentation pre-flight (PRS-35) on a layout report: broken steps, steps that reveal more than seven nodes, focus
 * labels over six words, long camera jumps (over 1.5 screens at a 1440 x 900 view) and branches no step visits.
 */
export function lintPresentation(doc: Doc, presentation: Presentation, report: LayoutReport): LintIssue[] {
  const issues: LintIssue[] = [];
  const boxes = new Map(report.boxes.map((b) => [b.id, b]));
  const elementIds = new Set((doc.canvas?.elements ?? []).map((e) => e.id));
  const visited = new Set<NodeId>();
  let previous: { x: number; y: number; zoom: number } | null = null;
  presentation.steps.forEach((step, i) => {
    const name = 'Step ' + (i + 1) + (step.title ? ' "' + clip(step.title) + '"' : '');
    const focus = step.focus.filter((id) => doc.nodes[id]);
    const reveal = (step.reveal ?? []).filter((id) => doc.nodes[id]);
    const elements = (step.elements ?? []).filter((id) => elementIds.has(id));
    if (!focus.length && !elements.length) {
      issues.push({ rule: 'step-broken', severity: 'error', ids: [step.id], message: name + ' is broken: none of its nodes or elements exist.',
        hint: 'Set new focus ids with presentation-set, or delete the step.' });
      return;
    }
    for (const id of [...focus, ...reveal]) visited.add(id);
    if (step.skip) return;
    if (reveal.length > 7) issues.push({ rule: 'step-reveal', severity: 'warn', ids: [step.id, focus[0] ?? ''].filter(Boolean),
      message: name + ' reveals ' + reveal.length + ' nodes at once.', hint: 'Split the step, or use build=each.' });
    for (const id of focus) {
      const words = doc.nodes[id].text.trim().split(/\s+/).filter(Boolean).length;
      if (words > 6) issues.push({ rule: 'step-long-label', severity: 'warn', ids: [step.id, id],
        message: name + ': the focus label "' + clip(doc.nodes[id].text) + '" has ' + words + ' words.', hint: 'Shorten the label or give the step a title.' });
    }
    if (step.frame === 'map') { previous = null; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const id of step.frame === 'nodes' ? focus : [...focus, ...reveal]) {
      const b = boxes.get(id);
      if (!b) continue;
      x0 = Math.min(x0, b.x - b.w / 2); y0 = Math.min(y0, b.y - b.h / 2); x1 = Math.max(x1, b.x + b.w / 2); y1 = Math.max(y1, b.y + b.h / 2);
    }
    if (!(x1 > x0)) { previous = null; return; }
    const zoom = Math.min(PREFLIGHT_VIEW.maxZoom, (PREFLIGHT_VIEW.w - 2 * PREFLIGHT_VIEW.pad) / (x1 - x0), (PREFLIGHT_VIEW.h - 2 * PREFLIGHT_VIEW.pad) / Math.max(1, y1 - y0));
    const here = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom };
    if (previous) {
      const screens = Math.hypot(here.x - previous.x, here.y - previous.y) * Math.min(previous.zoom, here.zoom) / PREFLIGHT_VIEW.w;
      if (screens > 1.5) issues.push({ rule: 'step-jump', severity: 'warn', ids: [step.id, focus[0] ?? ''].filter(Boolean),
        message: name + ' jumps ' + screens.toFixed(1) + ' screens from the step before.', hint: 'Add a step in between, or frame=map for an overview.' });
    }
    previous = here;
  });
  for (const root of doc.roots) {
    const node = doc.nodes[root];
    if (!node || node.collapsed) continue;
    for (const branch of node.children) {
      if (visited.has(branch)) continue;
      issues.push({ rule: 'unvisited-branch', severity: 'info', ids: [branch], message: 'No step visits the branch "' + clip(doc.nodes[branch]?.text || 'Untitled') + '".',
        hint: 'Add a step that focuses or reveals it.' });
    }
  }
  return issues;
}
