/**
 * Picture subtrees: per-node image briefs, the batch planner, and pixel helpers (trim, pad, anchors).
 * Pixel helpers use a structural `PixelImage`, so they run in workers and Node.
 */
import template from '../ai/templates/picture.json';
import { fill } from '../ai/template';
import type { Vec2 } from '../types';
import { describeStyle, type ArtStyleSheet } from './styleSheet';

// ------------------------------------------------------------------ briefs

export const IMAGE_INSTRUCTIONS = [template.role, template.output, template.rules].join(' ');
export const PICTURE_TEMPLATE_VERSION = template.version;

export interface NodeImageBriefInput {
  /** Texts from the subtree root (or map root) down to and including the node. */
  path: string[];
  nodeText: string;
  note?: string;
  /** Titles of the other nodes under the same parent, including any with the same title. */
  siblings: string[];
  imageHint?: string;
  style: ArtStyleSheet;
  /** Branch colour of the subtree root, for the palette. */
  branchColour?: string;
  /** True when the style reference image is attached to the request. */
  hasReference?: boolean;
}

/** One concrete, memorable picture of the node's meaning, distinct from its siblings, no text, centred. */
export function buildNodeImageBrief(i: NodeImageBriefInput): string {
  const node = template.node;
  const siblings = i.siblings.filter(text => text.trim());
  return [
    fill(node.task, { node: JSON.stringify(i.nodeText) }),
    i.path.length > 1 && fill(node.path, { path: i.path.map(text => JSON.stringify(text)).join(' > ') }),
    i.note?.trim() && fill(node.note, { note: i.note.trim() }),
    i.imageHint?.trim() ? fill(node.hint, { hint: i.imageHint.trim() }) : node.subject,
    node.example, node.silhouette,
    siblings.length > 0 && fill(node.siblings, { siblings: siblings.map(text => JSON.stringify(text)).join(', ') }),
    template.rules, pictureStyle(i.style, i.branchColour),
    i.hasReference && node.match
  ].filter(Boolean).join('\n');
}

/** Keep the image rules in an edited brief, even when the user replaces its entire text. */
export function completeCustomPictureBrief(brief: string): string {
  const content = brief.split(/\r?\n/).filter(line => line.trim() !== template.rules).join('\n').trim();
  return [content, template.rules].filter(Boolean).join('\n');
}

function pictureStyle(style: ArtStyleSheet, branchColour?: string): string {
  return [
    style.background === 'transparent' ? template.transparent : template.plain,
    fill(template.style, { description: describeStyle(style, branchColour) })
  ].join('\n');
}

/** The reference is a separate job and carries the same style as its subsequent node pictures. */
export function buildStyleReferencePrompt(style: ArtStyleSheet, opts: { subject?: string; branchColour?: string } = {}): string {
  return [
    fill(template.reference.task, { subject: opts.subject?.trim() || template.reference.defaultSubject }),
    template.reference.example, template.rules, pictureStyle(style, opts.branchColour)
  ].join('\n');
}

// ------------------------------------------------------------------ batch planner

export interface PlanNode {
  id: string;
  /** Depth below the subtree root (0 for the root). */
  depth: number;
  /** Leaf nodes are preferred as the second sample. */
  isLeaf?: boolean;
}

export const DEFAULT_PICTURE_ESTIMATE_THRESHOLD = 10;
export const DEFAULT_PICTURE_CONCURRENCY = 1;

export interface PlanOptions {
  maxConcurrent?: number;
  /** Include a duration estimate in confirmation when the image count exceeds this. Default 10. */
  estimateAbove?: number;
  /** Generate a style reference first (default true unless the sheet already has one: pass false then). */
  withReference?: boolean;
  /** Typical seconds per image for the estimate (measured 12 to 29 s). Default 20. */
  secondsPerImage?: number;
}

export interface PictureJob {
  kind: 'reference' | 'node';
  nodeId?: string;
  /** 0-based position in the queue. */
  order: number;
  /** 'sample' jobs run first and need user acceptance before the 'batch' jobs start (FR-ART-08). */
  phase: 'sample' | 'batch';
}

export interface PicturePlan {
  jobs: PictureJob[];
  maxConcurrent: number;
  /** True when the number of images exceeds `estimateAbove` (FR-ART-26). */
  showEstimate: boolean;
  imageCount: number;
  estimatedSeconds: number;
}

/**
 * Orders the work: the reference image first, then nodes nearest the subtree root first (stable within a depth).
 * The reference, the root and one leaf form the sample phase (at most two node images); the rest is the batch.
 */
export function planPictureBatch(nodes: PlanNode[], opts: Partial<PlanOptions> = {}): PicturePlan {
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? DEFAULT_PICTURE_CONCURRENCY);
  const estimateAbove = opts.estimateAbove ?? DEFAULT_PICTURE_ESTIMATE_THRESHOLD;
  const perImage = opts.secondsPerImage ?? 20;
  const sorted = nodes.map((n, i) => ({ n, i })).sort((a, b) => a.n.depth - b.n.depth || a.i - b.i).map((x) => x.n);
  const sample = new Set<string>();
  if (sorted.length) sample.add(sorted[0].id);
  const leaf = [...sorted].reverse().find((n) => n.isLeaf && !sample.has(n.id)) ?? sorted.find((n) => !sample.has(n.id));
  if (leaf && sorted.length > 1) sample.add(leaf.id);

  const jobs: PictureJob[] = [];
  if (opts.withReference !== false) jobs.push({ kind: 'reference', order: 0, phase: 'sample' });
  // samples first (root, then leaf), then the remaining nodes root-first
  const ordered = [...sorted.filter((n) => sample.has(n.id)), ...sorted.filter((n) => !sample.has(n.id))];
  for (const n of ordered) jobs.push({ kind: 'node', nodeId: n.id, order: jobs.length, phase: sample.has(n.id) ? 'sample' : 'batch' });
  // The reference must finish before attached-reference node jobs start; the host serialises the sample phase.
  const imageCount = jobs.length;
  const sampleCount = jobs.filter((job) => job.phase === 'sample').length;
  return {
    jobs,
    maxConcurrent,
    showEstimate: imageCount > estimateAbove,
    imageCount,
    estimatedSeconds: (sampleCount + Math.ceil((imageCount - sampleCount) / maxConcurrent)) * perImage,
  };
}

// ------------------------------------------------------------------ pixels

/** Structural subset of ImageData (so no DOM type is needed). RGBA, 8 bits per channel, row-major. */
export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_ALPHA_THRESHOLD = 8;

/** Bounding box of pixels with alpha above `threshold`; null if the image is fully transparent. */
export function alphaBounds(img: PixelImage, threshold = DEFAULT_ALPHA_THRESHOLD): PixelRect | null {
  const { width: w, height: h, data } = img;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Share (0..1) of pixels that are (nearly) transparent. FR-ART-23: below a set share, run background removal. */
export function transparentShare(img: PixelImage, threshold = DEFAULT_ALPHA_THRESHOLD): number {
  const n = img.width * img.height;
  if (!n) return 0;
  let t = 0;
  for (let i = 3; i < n * 4; i += 4) if (img.data[i] <= threshold) t++;
  return t / n;
}

export interface TrimResult {
  image: PixelImage;
  /** The opaque bounds in the source image (before padding). */
  bounds: PixelRect;
  /** Padding in pixels added on every side. */
  padding: number;
  aspect: number; // width / height of the result
}

/** Crops transparent margins and adds `padding` transparent pixels on every side. Null if nothing is visible. */
export function trimAndPad(img: PixelImage, padding = 16, threshold = DEFAULT_ALPHA_THRESHOLD): TrimResult | null {
  const b = alphaBounds(img, threshold);
  if (!b) return null;
  const pad = Math.max(0, Math.round(padding));
  const w = b.w + pad * 2;
  const h = b.h + pad * 2;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < b.h; y++) {
    const src = ((b.y + y) * img.width + b.x) * 4;
    out.set(img.data.subarray(src, src + b.w * 4), ((y + pad) * w + pad) * 4);
  }
  return { image: { width: w, height: h, data: out }, bounds: b, padding: pad, aspect: w / h };
}

export interface PictureAnchors {
  /** Normalised (0..1) in the image box. */
  in: Vec2;
  out: Vec2[];
}

/**
 * Default anchors from the subject mask. Place branch caps just inside the opaque
 * silhouette so they continue under the soft edge. For thin art, use the nearest
 * opaque point or the visible contour when the subject has no opaque pixels.
 */
export function defaultAnchors(
  img: PixelImage,
  dirs: { towardParent: Vec2; towardChildren: Vec2[] },
  threshold = DEFAULT_ALPHA_THRESHOLD,
): PictureAnchors {
  const { width: w, height: h, data } = img;
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 256));
  const columns = Math.ceil(w / step);
  const rows = Math.ceil(h / step);
  const stride = columns + 1;
  const opaque = new Uint32Array(stride * (rows + 1));
  const edge: Vec2[] = [];
  const solid: Vec2[] = [];
  const inset: Vec2[] = [];
  const alpha = (x: number, y: number) => x >= 0 && x < w && y >= 0 && y < h ? data[(y * w + x) * 4 + 3] : 0;
  for (let row = 0; row < rows; row++) {
    let count = 0;
    for (let col = 0; col < columns; col++) {
      const x = col * step, y = row * step;
      const a = alpha(x, y);
      if (a >= 254) {
        solid.push({ x, y });
        count++;
      }
      opaque[(row + 1) * stride + col + 1] = opaque[row * stride + col + 1] + count;
      if (a > threshold && (
        alpha(x - step, y) <= threshold || alpha(x + step, y) <= threshold ||
        alpha(x, y - step) <= threshold || alpha(x, y + step) <= threshold
      )) edge.push({ x, y });
    }
  }
  const radius = Math.max(1, Math.ceil(Math.min(columns, rows) * 0.05));
  const side = radius * 2 + 1;
  for (let row = radius; row < rows - radius; row++) {
    const top = (row - radius) * stride, bottom = (row + radius + 1) * stride;
    for (let col = radius; col < columns - radius; col++) {
      const left = col - radius, right = col + radius + 1;
      const count = opaque[bottom + right] - opaque[bottom + left] - opaque[top + right] + opaque[top + left];
      if (count === side * side) inset.push({ x: col * step, y: row * step });
    }
  }
  const candidates = inset.length ? inset : solid.length ? solid : edge;
  const fallback = (d: Vec2): Vec2 => {
    const m = Math.hypot(d.x, d.y) || 1;
    return { x: 0.5 + (d.x / m) * 0.5, y: 0.5 + (d.y / m) * 0.5 };
  };
  const nearest = (d: Vec2): Vec2 => {
    if (!candidates.length) return fallback(d);
    const m = Math.hypot(d.x, d.y) || 1;
    const far = { x: w / 2 + (d.x / m) * (w + h), y: h / 2 + (d.y / m) * (w + h) };
    let best = candidates[0], bd = Infinity;
    for (const p of candidates) {
      const dd = (p.x - far.x) ** 2 + (p.y - far.y) ** 2;
      if (dd < bd) {
        bd = dd;
        best = p;
      }
    }
    return { x: (best.x + 0.5) / w, y: (best.y + 0.5) / h };
  };
  return { in: nearest(dirs.towardParent), out: dirs.towardChildren.map(nearest) };
}
