import { readableLabel } from '../model/markdown';
import { mixColor, readableInk } from './color';
import { treeThemes } from '../model/generated-style';
import type { Doc, MapNode, NodeId, NodeShape, NodeStyle, BranchStyle, Size, Theme } from '../types';
import { parseColor } from './color';

/** Font description passed to the text measurer and used by the label atlas. */
export interface FontSpec {
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
}

/** Measures `text` wrapped at `maxWidth` (world units) and returns the block size. */
export type MeasureFn = (text: string, font: FontSpec, maxWidth: number) => Size;

/** Fully resolved look of one node. Colours are CSS strings (see `parseColor`). */
export interface ResolvedNodeStyle {
  /** Branch + underline + box outline colour (inherited down the tree). */
  color: string;
  textColor: string;
  fillColor?: string;
  alignment?: NodeStyle['alignment'];
  font: FontSpec;
  /**
   * Effective shape. Roots never use 'underline': a root asked to be 'underline' resolves to 'box',
   * because roots are always drawn as a rounded box (or 'none' for bare text).
   */
  shape: NodeShape;
  branch: BranchStyle;
  emphasis: 0 | 1 | 2;
}

export interface Padding {
  l: number;
  r: number;
  t: number;
  b: number;
}

/** Text wraps at this width (world units); the root a bit wider. */
export const MAX_TEXT_WIDTH = 260;
export const MAX_ROOT_TEXT_WIDTH = 320;

/** Per-level branch width factor ("halving-ish"). */
const WIDTH_DECAY = 0.58;

/**
 * Width of the branch that starts at a node of the given depth, i.e. the width of edges going INTO depth `d`
 * at their parent end: d = 1 -> `rootBranchWidth`, then decaying, never below `minBranchWidth`.
 * An edge into depth d tapers from `branchWidthAt(d)` to `branchWidthAt(d + 1)`, so chains are continuous.
 */
export function branchWidthAt(depth: number, theme: Theme): number {
  const d = depth < 1 ? 1 : depth;
  return Math.max(theme.minBranchWidth, theme.rootBranchWidth * Math.pow(WIDTH_DECAY, d - 1));
}

/** Thickness of the underline bar of a node at `depth` (equals the width of its outgoing branches). */
export function underlineThickness(depth: number, theme: Theme): number {
  return branchWidthAt(depth + 1, theme);
}

/** Text as it is measured and drawn (uppercased on main branches when the theme asks). Never alters the model. */
export function displayText(node: MapNode, depth: number, theme: Theme, mainBranch?: number): string {
  const full = readableLabel(node);
  const text = theme.keywordLabels
    ? full.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:[-’'][\p{L}\p{N}\p{M}]+)*/u)?.[0] ?? full
    : full;
  const label = depth === 1 && theme.uppercaseMainBranches ? text.toUpperCase() : text;
  const marker = depth === 1 && theme.branchMarkers && mainBranch !== undefined ? (mainBranch + 1) + '.' : '';
  const sticker = theme.lean ? '' : node.sticker;
  if (!marker && !sticker) return label;
  return [marker, sticker, label].filter(Boolean).join(' ');
}

/**
 * Room kept on both sides of the text for a tip dot (theme `tipDots`), at depth >= 2 on underline and text-only
 * nodes; 0 otherwise. Underline: the dot sits `gap + radius` beyond the bar's far end. Text only: the dot sits on
 * the end of the limb (the box edge) and the label is inset by `radius + 8`. Reserved on every such node, not just
 * leaves, so adding a child never resizes its parent. A radius of 0 or less turns dots off.
 */
export function tipDotInset(depth: number, shape: NodeShape, theme: Theme): number {
  const dots = theme.tipDots;
  if (!dots || !(dots.radius > 0) || depth < 2) return 0;
  if (shape === 'underline') return 3 + dots.gap + 2 * dots.radius;
  return shape === 'none' ? dots.radius + 8 : 0;
}

/** Padding around the text block for a shape (the box then is text size + padding). */
export function nodePadding(depth: number, shape: NodeShape, theme: Theme, branchWidth = 0): Padding {
  if (depth === 0) {
    return shape === 'none' ? { l: 4, r: 4, t: 2, b: 2 } : { l: 20, r: 20, t: 12, b: 12 };
  }
  const inset = tipDotInset(depth, shape, theme);
  switch (shape) {
    case 'underline':
      return { l: Math.max(3, inset), r: Math.max(3, inset), t: 3, b: Math.max(underlineThickness(depth, theme), Number.isFinite(branchWidth) ? Math.min(64, branchWidth) : 0) + 3 };
    case 'box':
    case 'rectangle':
    case 'circle':
    case 'square':
      return { l: 12, r: 12, t: 7, b: 7 };
    default:
      return { l: Math.max(3, inset), r: Math.max(3, inset), t: 2, b: 2 };
  }
}

/**
 * Fill of a filled node shape as a CSS colour and its alpha over the canvas. A custom fill (node style, else
 * `rootFillColor` / `nodeFillColor`) is opaque. Without one, the branch colour is laid over the canvas at a low
 * alpha, unless the theme sets `boxFillStrength` or `boxFillBase`: then a node at depth >= 1 gets the opaque mix
 * of its branch colour into `boxFillBase` (default: the background).
 */
export function nodeFill(theme: Theme, depth: number, color: string, emphasis: number, fillColor?: string): { color: string; alpha: number } {
  const custom = fillColor ?? (depth === 0 ? theme.rootFillColor : theme.nodeFillColor);
  if (custom) return { color: custom, alpha: 1 };
  if (depth > 0 && (theme.boxFillStrength !== undefined || theme.boxFillBase !== undefined)) {
    const strength = Math.max(0, Math.min(1, (theme.boxFillStrength ?? 0.12) * (emphasis === 2 ? 2 : 1)));
    return { color: mixColor(theme.boxFillBase ?? theme.background, color, strength), alpha: 1 };
  }
  return { color, alpha: emphasis === 2 ? 0.24 : depth === 0 ? 0.18 : 0.12 };
}

/** Default corner radius of 'box' nodes at depth >= 1. */
export const BOX_RADIUS = 8;

/**
 * Corner radius of a 'box' node: `rootRadius` at depth 0 (default min(h / 2, 26)), `boxRadius` deeper
 * (default `BOX_RADIUS`); 'pill' is half the height.
 */
export function boxCornerRadius(depth: number, w: number, h: number, theme: Theme): number {
  const radius = depth === 0 ? theme.rootRadius : theme.boxRadius;
  if (radius === undefined) return depth === 0 ? Math.min(h / 2, 26) : BOX_RADIUS;
  return radius === 'pill' ? Math.min(w, h) / 2 : Math.max(0, Math.min(radius, w / 2, h / 2));
}

/**
 * Colour of the limb into a node at `depth` and of its underline: with `tipTint` t, depth >= 2 uses the branch
 * colour mixed t of the way to the background. Box outlines and text keep `color`.
 */
export function lineColor(color: string, depth: number, theme: Theme): string {
  const t = theme.tipTint;
  return t && depth >= 2 ? mixColor(color, theme.background, t) : color;
}

function localStyle(node: MapNode, depth: number, theme: Theme) {
  const s = node.style;
  const emphasis = s?.emphasis ?? 0;
  const base = depth === 0 ? theme.rootFontSize : depth === 1 ? theme.mainFontSize : theme.fontSize;
  const size = s?.fontSize ?? base * (emphasis === 2 ? 1.15 : 1);
  const font: FontSpec = {
    family: s?.fontFamily ?? theme.fontFamily,
    size,
    bold: s?.bold ?? ((depth === 0 ? theme.rootBold !== false : depth === 1 && theme.mainBold !== false) || emphasis >= 1),
    italic: s?.italic ?? false
  };
  let shape: NodeShape = s?.shape ?? (depth === 0 ? theme.rootShape : depth === 1 ? theme.mainShape ?? theme.shape : theme.shape);
  if (theme.lean) shape = 'none';
  else if (depth === 0 && shape === 'underline') shape = 'box';
  return { font, shape, branch: s?.branch ?? theme.branch, emphasis };
}

export interface StyleResolver {
  themeFor(id:NodeId):Theme;
  get(id: NodeId, depth: number, mainBranch?: number): ResolvedNodeStyle;
}

/**
 * Resolver with a colour cache, so resolving every node of a document is O(n).
 * Colour: node style, else root -> `theme.rootColor`, depth 1 -> `branchColors[mainBranch % length]`,
 * deeper -> the parent's colour. Shape, font and branch style are NOT inherited (they come from the node,
 * then the theme by depth), so `nodeSize` (which sees only the node) agrees with this resolver.
 */
export function createStyleResolver(doc: Doc, theme: Theme): StyleResolver {
  const colors = new Map<NodeId, string>();
  const themeFor=treeThemes(doc,theme);
  const branchCache = new Map<NodeId, BranchStyle | null>();
  const keywordBranchCache = new Map<NodeId, BranchStyle | null>();
  function branchOf(id: NodeId): BranchStyle {
    const local = themeFor(id);
    const cache = local.keywordLabels ? keywordBranchCache : branchCache;
    let next: NodeId | null = id;
    const chain: NodeId[] = [];
    let branch: BranchStyle | null = null;
    while (next !== null) {
      const node: MapNode | undefined = doc.nodes[next];
      branch = node?.style?.branch ?? (local.keywordLabels ? undefined : node?.generatedStyle?.branch) ?? cache.get(next) ?? null;
      if (branch || cache.has(next)) break;
      chain.push(next);
      next = node?.parent ?? null;
    }
    for (const item of chain) cache.set(item, branch);
    return branch ?? local.branch;
  }
  const colorOf = (id: NodeId, depth: number, mainBranch?: number): string => {
    const hit = colors.get(id);
    if (hit !== undefined) return hit;
    const node = doc.nodes[id];
    let col = node?.style?.color;
    if (!col) {
      if (!node || depth <= 0 || node.parent === null) col = theme.rootColor;
      else if (depth === 1) {
        const local=themeFor(id);
        const pal=local.colorMainBranches===false ? [] : local.branchColors;
        if (pal.length === 0) col = theme.rootColor;
        else {
          let idx = mainBranch ?? -1;
          if (idx < 0) idx = Math.max(0, doc.nodes[node.parent]?.children.indexOf(id) ?? 0);
          col = pal[idx % pal.length];
        }
      } else col = colorOf(node.parent, depth - 1);
    }
    colors.set(id, col);
    return col;
  };
  return {
    themeFor,
    get(id, depth, mainBranch) {
      const node = doc.nodes[id];
      const color = colorOf(id, depth, mainBranch);
      if (!node) {
        return {
          color,
          textColor: theme.textColor,
          font: { family: theme.fontFamily, size: theme.fontSize, bold: false, italic: false },
          shape: theme.shape,
          branch: theme.branch,
          emphasis: 0
        };
      }
      const local = themeFor(id);
      const l = localStyle(node, depth, local);
      const filled=l.shape!=='none' && l.shape!=='underline';
      const fill=nodeFill(local,depth,color,l.emphasis,node.style?.fillColor);
      const ink=node.style?.textColor ?? (depth===0 ? filled ? local.rootTextColor : undefined :
        depth>=2 ? local.leafTextColor : undefined) ?? theme.textColor;
      const textColor=readableInk(ink,theme.background,filled ? fill.color : undefined,fill.alpha);
      return {
        color,
        textColor,
        fillColor: node.style?.fillColor,
        alignment: node.style?.alignment,
        font: l.font,
        shape: l.shape,
        branch: branchOf(id),
        emphasis: l.emphasis
      };
    }
  };
}

/** One-off resolve of a node's effective style (see `createStyleResolver` for rules). */
export function resolveNodeStyle(doc: Doc, id: NodeId, depth: number, theme: Theme): ResolvedNodeStyle {
  return createStyleResolver(doc, theme).get(id, depth);
}

/**
 * Size of a node box (text plus shape padding). `measure` wraps at the max text width.
 * Underline nodes reserve room under the text for the line; box nodes pad on all sides.
 */
export function nodeSize(node: MapNode, depth: number, theme: Theme, measure: MeasureFn, mainBranch?: number): Size {
  const { font, shape } = localStyle(node, depth, theme);
  const pad = nodePadding(depth, shape, theme, node.style?.branchWidth);
  const text = displayText(node, depth, theme, mainBranch);
  let tw: number, th: number;
  if (text.length === 0) {
    tw = font.size * 2;
    th = font.size * 1.3;
  } else {
    const m = measure(text, font, depth === 0 ? MAX_ROOT_TEXT_WIDTH : MAX_TEXT_WIDTH);
    tw = m.w;
    th = m.h;
  }
  if (shape === 'underline' && theme.fitBranchToLabel === false) tw = Math.max(tw, 6 * font.size);
  const w = Math.ceil(tw + pad.l + pad.r);
  const h = Math.ceil(th + pad.t + pad.b);
  if (shape === 'square' || shape === 'circle') {
    const edge = shape === 'circle' ? Math.ceil(Math.hypot(w, h)) : Math.max(w, h);
    return { w: edge, h: edge };
  }
  return { w, h };
}

// re-export for convenience (colour of a resolved style as RGBA, straight)
export function styleColorRGBA(style: ResolvedNodeStyle) {
  return parseColor(style.color);
}
