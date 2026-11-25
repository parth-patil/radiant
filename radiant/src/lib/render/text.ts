import { wordParts } from '../core/model/repeated-words';
import { canCurveText, canCurveUnderline, underlineOffset, underlineSlope } from '../core/geometry/underline';
import type { LabelDraw, Rect, RGBA } from '../core/types';

export interface FontSpec {
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
}

export const LINE_HEIGHT = 1.25;

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type Surface = OffscreenCanvas | HTMLCanvasElement;

function make2D(w: number, h: number): { canvas: Surface; ctx: Ctx2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (ctx) return { canvas, ctx };
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d')! };
}

export function fontString(f: FontSpec, size = f.size): string {
  return `${f.italic ? 'italic ' : ''}${f.bold ? '700 ' : '400 '}${size}px ${f.family}`;
}

// ------------------------------------------------------------------ measuring / wrapping

export interface TextLine {
  text: string;
  w: number;
}
export interface TextLayout {
  lines: TextLine[];
  /** Widest line, world units at the base font size. */
  w: number;
  /** lines * 1.25 * size. */
  h: number;
  lineHeight: number;
  /** y of the alphabetic baseline measured from the top of a line box. */
  baseline: number;
}

let measureCtx: Ctx2D | null = null;
/** Layouts by font and wrap width, then by text: a lookup builds one short key and reuses the text string itself. */
const layoutCache = new Map<string, Map<string, TextLayout>>();
let layoutCacheSize = 0;
let layoutCacheLimit = 30000;

/**
 * Let the layout cache hold every label of a map with `labels` nodes in three fonts (a theme switch and back),
 * so maps above the default limit do not re-measure every label on each pass. The limit only grows.
 */
export function reserveLayoutCache(labels: number): void {
  layoutCacheLimit = Math.max(layoutCacheLimit, 3 * labels);
}
const baselineCache = new Map<string, number>();
let segmenter: { segment(s: string): Iterable<{ segment: string }> } | null | undefined;

export function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => typeof segmenter }).Segmenter;
    segmenter = Seg ? (new Seg(undefined, { granularity: 'grapheme' }) as typeof segmenter) : null;
  }
  if (segmenter) return Array.from(segmenter.segment(s), (x) => x.segment);
  return Array.from(s);
}

function baselineFor(ctx: Ctx2D, font: FontSpec): number {
  const key = fontString(font, 100);
  let b = baselineCache.get(key);
  if (b === undefined) {
    ctx.font = key;
    const m = ctx.measureText('Hgé');
    const asc = m.fontBoundingBoxAscent ?? 80;
    const desc = m.fontBoundingBoxDescent ?? 20;
    // Centre the font's ascent+descent inside the 1.25 line box; stored per unit of font size.
    b = (LINE_HEIGHT * 100 - (asc + desc)) / 2 / 100 + asc / 100;
    baselineCache.set(key, b);
  }
  return b * font.size;
}

/**
 * Wrap and measure text with the browser's own shaping (the same code path the atlas uses to draw).
 * Rules: split on newlines; greedy word wrap at spaces when maxWidth is finite and > 0; a single word
 * wider than maxWidth is broken between grapheme clusters; line height = 1.25 x size; width = widest line.
 */
export function layoutLabel(text: string, font: FontSpec, maxWidth: number): TextLayout {
  const wrap = Number.isFinite(maxWidth) && maxWidth > 0;
  const fontKey = `${fontString(font)}|${wrap ? maxWidth : 0}`;
  let byText = layoutCache.get(fontKey);
  const hit = byText?.get(text);
  if (hit) return hit;
  if (layoutCacheSize >= layoutCacheLimit) {
    layoutCache.clear();
    layoutCacheSize = 0;
    byText = undefined;
  }
  if (!byText) layoutCache.set(fontKey, byText = new Map());
  if (!measureCtx) measureCtx = make2D(1, 1).ctx;
  const ctx = measureCtx;
  ctx.font = fontString(font);
  const width = (s: string) => (s ? ctx.measureText(s).width : 0);
  const lines: TextLine[] = [];
  const push = (t: string, w: number) => lines.push({ text: t, w });

  for (const para of text.split(/\r\n|\r|\n/)) {
    if (!wrap) {
      push(para, width(para));
      continue;
    }
    const words = para.split(/[ \t]+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      push('', 0);
      continue;
    }
    let line = '';
    let lw = 0;
    const addWord = (word: string) => {
      const ww = width(word);
      if (ww <= maxWidth) {
        line = word;
        lw = ww;
        return;
      }
      let cur = '';
      let cw = 0;
      for (const g of graphemes(word)) {
        const t = cur + g;
        const tw = width(t);
        if (tw > maxWidth && cur) {
          push(cur, cw);
          cur = g;
          cw = width(g);
        } else {
          cur = t;
          cw = tw;
        }
      }
      line = cur;
      lw = cw;
    };
    for (const word of words) {
      if (!line) {
        addWord(word);
        continue;
      }
      const cand = line + ' ' + word;
      const cw = width(cand);
      if (cw <= maxWidth) {
        line = cand;
        lw = cw;
      } else {
        push(line, lw);
        line = '';
        addWord(word);
      }
    }
    push(line, lw);
  }
  let w = 0;
  for (const l of lines) if (l.w > w) w = l.w;
  const lineHeight = font.size * LINE_HEIGHT;
  const layout: TextLayout = {
    lines,
    w,
    h: lines.length * lineHeight,
    lineHeight,
    baseline: baselineFor(ctx, font)
  };
  byText.set(text, layout);
  layoutCacheSize++;
  return layout;
}

/** Size of a label's text block in world units (width of widest line, 1.25 x size per line). */
export function measureLabel(text: string, font: FontSpec, maxWidth: number): { w: number; h: number } {
  const l = layoutLabel(text, font, maxWidth);
  return { w: l.w, h: l.h };
}

export interface CurvedGlyph {
  text: string;
  start: number;
  /** Baseline centre, relative to the label centre in world coordinates. */
  x: number;
  y: number;
  angle: number;
}

/** Shared placement for the label atlas and vector exports. Unsupported shaping stays whole-line. */
export function placeCurvedGlyphs(label: LabelDraw, layout: TextLayout): CurvedGlyph[] | null {
  const curve = label.curve;
  const line = layout.lines[0];
  if (!curve || layout.lines.length !== 1 || !line || !canCurveText(line.text) ||
      curve.span < line.w || !canCurveUnderline(curve.span, curve.rise, label.fontSize)) return null;
  if (!measureCtx) measureCtx = make2D(1, 1).ctx;
  measureCtx.font = fontString({ family: label.fontFamily, size: label.fontSize, bold: label.bold, italic: label.italic });
  const baseline = layout.baseline - layout.h / 2;
  const placements: CurvedGlyph[] = [];
  let prefix = '';
  let past = 0;
  for (const text of graphemes(line.text)) {
    prefix += text;
    const end = measureCtx.measureText(prefix).width;
    if (end <= past) return null;
    const x = (past + end - line.w) / 2;
    const t = (x + curve.span / 2) / curve.span;
    if (text.trim()) placements.push({
      text, start: prefix.length - text.length, x, y: baseline + underlineOffset(t, curve.rise),
      angle: Math.atan(underlineSlope(t, curve.rise) / curve.span)
    });
    past = end;
  }
  return placements.length ? placements : null;
}

/** Farthest-to-nearest offsets for the visible sides. The face is at zero. */
export function labelDepthOffsets(label: LabelDraw): number[] {
  if (!label.extrusion) return [];
  const step = Math.max(0.35, Math.min(1.4, label.fontSize * 0.075));
  return [3 * step, 2 * step, step];
}

function rgba(color: RGBA): string {
  const toByte = (v: number) => Math.round(255 * v / (color.a || 1));
  return `rgba(${toByte(color.r)},${toByte(color.g)},${toByte(color.b)},${color.a})`;
}

/** World extents relative to label centre, including the arch and dimensional sides. */
export function labelRasterBounds(label: LabelDraw, layout: TextLayout): Rect {
  const depth = labelDepthOffsets(label)[0] ?? 0;
  const crop = { x: -layout.w / 2, y: -layout.h / 2, w: layout.w + depth, h: layout.h + depth };
  if (!label.curve) return crop;
  const margin = label.fontSize * 0.2;
  const { rise } = label.curve;
  return { x: crop.x - margin, y: crop.y - rise - margin, w: crop.w + 2 * margin, h: crop.h + rise + 2 * margin };
}
export function alignedLabelX(l: LabelDraw, blockWidth: number): number {
  const width = l.alignWidth;
  if (!width || l.align === 'center') return l.x;
  const free = Math.max(0, width - blockWidth) / 2;
  return l.x + (l.align === 'right' ? free : -free);
}

/** Cheap, conservative size estimate (no measuring) for culling and far-away placeholder bars. */
export function estimateExtent(l: LabelDraw): { w: number; h: number; lines: number } {
  const lh = l.fontSize * LINE_HEIGHT;
  const wrap = Number.isFinite(l.maxWidth) && l.maxWidth > 0;
  const len = l.text.length;
  const natural = len * l.fontSize * 0.95;
  let lines = 1;
  for (let i = 0; i < len; i++) if (l.text.charCodeAt(i) === 10) lines++;
  let w = natural;
  if (wrap && natural > l.maxWidth) {
    w = l.maxWidth;
    lines += Math.ceil(natural / l.maxWidth);
  }
  const curveH = l.curve ? 2 * l.curve.rise + l.fontSize * 0.4 : 0;
  const curveW = l.curve ? l.fontSize * 0.4 : 0;
  return { w: Math.max(w, l.alignWidth ?? 0) + curveW, h: lines * lh + curveH, lines };
}

// ------------------------------------------------------------------ atlas

const PAD = 2; // transparent texels around every slot (linear filtering, italics, emoji overhang)
const MAX_DIM = 1024; // largest slot edge in texels
/**
 * Staging strip sizes. A frame's rasterisations are drawn side by side on one strip, then uploaded. In WebKit the upload
 * reads the whole strip back from the GPU (about 0.4 ms plus 1 ms per MB, measured), so each batch uses the smallest
 * strip its labels fit on.
 */
const STRIP_SIZES: readonly [number, number][] = [[512, 128], [1024, 256], [2048, 512]];

interface Strip {
  canvas: Surface;
  ctx: Ctx2D;
  w: number;
  h: number;
  x: number;
  y: number;
  rowH: number;
  used: number;
  /** Running estimate of one batch upload from this strip, ms. */
  uploadMs: number;
}

interface Upload {
  page: AtlasPage;
  x: number;
  y: number;
  w: number;
  h: number;
  sx: number;
  sy: number;
}

export interface AtlasPage {
  id: number;
  tex: WebGLTexture;
  gen: number;
  lastUse: number;
  nextY: number;
  shelves: { y: number; h: number; x: number }[];
}

export interface AtlasSlot {
  page: AtlasPage;
  gen: number;
  bucket: number;
  /** texels per world unit used when rasterising */
  scale: number;
  /** Quad offset from the label centre and size, in world units. */
  ox: number;
  oy: number;
  qw: number;
  qh: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface LabelEntry {
  key: string;
  label: LabelDraw;
  font: FontSpec;
  css: string;
  layout: TextLayout | null;
  curvedGlyphs?: CurvedGlyph[] | null;
  slots: AtlasSlot[];
  lastFrame: number;
  reqFrame: number;
  reqBucket: number;
  prio: number;
}

export interface AtlasOptions {
  pageSize?: number;
  maxPages?: number;
  /** Bucket step in log2 units: 0.5 = powers of sqrt(2). */
  bucketStep?: number;
}

export class LabelAtlas {
  readonly pages: AtlasPage[] = [];
  readonly pageSize: number;
  readonly maxPages: number;
  readonly step: number;
  private entries = new Map<string, LabelEntry>();
  private pending: LabelEntry[] = [];
  private frame = 0;
  /**
   * One staging canvas for a frame's rasterisations. Each label is drawn, clipped, into its own cell, and all are
   * copied into the atlas after the batch. Uploading from a canvas costs a GPU readback per call in WebKit unless the
   * canvas is unchanged since the last copy, so one batch pays it once instead of once per label.
   */
  private strips: (Strip | null)[] = STRIP_SIZES.map(() => null);
  /** For a label larger than every strip size. */
  private bigStrip: Strip | null = null;
  private strip: Strip | null = null;
  private uploads: Upload[] = [];
  /** True when the atlas could not place a slot even after evicting (working set too large). */
  full = false;

  constructor(
    private gl: WebGL2RenderingContext,
    opts: AtlasOptions = {}
  ) {
    this.pageSize = opts.pageSize ?? 2048;
    this.maxPages = opts.maxPages ?? 8;
    this.step = opts.bucketStep ?? 0.5;
  }

  get textureCount(): number {
    return this.pages.length;
  }
  get pendingCount(): number {
    return this.pending.length;
  }
  get entryCount(): number {
    return this.entries.size;
  }

  dispose(): void {
    for (const p of this.pages) this.gl.deleteTexture(p.tex);
    this.pages.length = 0;
    this.entries.clear();
    this.pending.length = 0;
    this.uploads.length = 0;
  }

  beginFrame(frame: number): void {
    this.frame = frame;
    this.pending.length = 0;
    this.full = false;
    if (this.entries.size > 60000) {
      for (const [k, e] of this.entries) if (e.lastFrame < frame - 600) this.entries.delete(k);
      if (this.entries.size > 90000) this.entries.clear();
    }
  }

  entryFor(l: LabelDraw): LabelEntry {
    const c = l.color;
    // Scene colours are premultiplied; canvas fillStyle needs straight colour.
    const inv = c.a > 0 ? 1 / c.a : 0;
    const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v * inv * 255)));
    const r = cl(c.r), g = cl(c.g), b = cl(c.b);
    const a = Math.round(c.a * 255);
    const wrap = Number.isFinite(l.maxWidth) && l.maxWidth > 0 ? l.maxWidth : 0;
    const curve = l.curve ? `|${l.curve.span},${l.curve.rise}` : '';
    const depth = l.extrusion ? '|' + rgba(l.extrusion) : '';
    const key = `${l.text}\u0001${l.fontFamily}\u0001${l.fontSize}\u0001${l.bold ? 1 : 0}${l.italic ? 1 : 0}\u0001${r},${g},${b},${a}\u0001${wrap}\u0001${l.align}${curve}${depth}${l.highlightedWord ? '|word=' + l.highlightedWord : ''}`;
    let e = this.entries.get(key);
    if (!e) {
      e = {
        key,
        label: l,
        font: { family: l.fontFamily, size: l.fontSize, bold: l.bold, italic: l.italic },
        css: `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`,
        layout: null,
        slots: [],
        lastFrame: this.frame,
        reqFrame: -1,
        reqBucket: -999,
        prio: 0
      };
      this.entries.set(key, e);
    }
    e.lastFrame = this.frame;
    return e;
  }

  ensureLayout(e: LabelEntry): TextLayout {
    if (!e.layout) e.layout = layoutLabel(e.label.text, e.font, e.label.maxWidth);
    return e.layout;
  }

  /** Bucket index for a scale (texels per world unit). */
  bucketFor(scale: number): number {
    return Math.round(Math.log2(Math.max(scale, 1e-4)) / this.step);
  }
  scaleOf(bucket: number): number {
    return Math.pow(2, bucket * this.step);
  }
  /** Highest bucket that keeps the slot under MAX_DIM texels. */
  maxBucket(layout: TextLayout, label: LabelDraw): number {
    const box = label.curve || label.extrusion ? labelRasterBounds(label, layout) : layout;
    const dim = Math.max(box.w, box.h, 1);
    return Math.floor(Math.log2((MAX_DIM - 2 * PAD) / dim) / this.step);
  }

  private valid(s: AtlasSlot): boolean {
    return s.gen === s.page.gen;
  }

  exact(e: LabelEntry, bucket: number): AtlasSlot | null {
    for (const s of e.slots) if (s.bucket === bucket && this.valid(s)) return s;
    return null;
  }

  /** The slot to draw: the exact bucket if present, else the closest valid one (prefer larger). */
  best(e: LabelEntry, bucket: number): AtlasSlot | null {
    let best: AtlasSlot | null = null;
    let bd = Infinity;
    for (const s of e.slots) {
      if (!this.valid(s)) continue;
      const d = Math.abs(s.bucket - bucket) + (s.bucket < bucket ? 0.25 : 0);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  request(e: LabelEntry, bucket: number, prio: number): void {
    if (e.reqFrame === this.frame && e.reqBucket === bucket) return;
    e.reqFrame = this.frame;
    e.reqBucket = bucket;
    e.prio = prio;
    this.pending.push(e);
  }

  /** Rasterise queued labels until the deadline (performance.now() value). Returns how many remain. */
  process(deadline: number): number {
    const q = this.pending;
    if (q.length === 0) return 0;
    q.sort((a, b) => a.prio - b.prio);
    const start = performance.now();
    // Strip for this batch: the smallest that holds the queue (with room for shelf packing), else the largest.
    const [maxW, maxH] = STRIP_SIZES[STRIP_SIZES.length - 1];
    let area = 0;
    for (let k = 0; k < q.length && area < maxW * maxH; k++) {
      const c = this.cellSize(q[k], q[k].reqBucket);
      area += c.w * c.h;
    }
    let tier = STRIP_SIZES.findIndex(([w, h]) => w * h >= area * 1.4);
    if (tier < 0) tier = STRIP_SIZES.length - 1;
    this.strip = this.stripAt(tier);
    let i = 0;
    for (; i < q.length; i++) {
      // The batch is uploaded after the loop: keep time for it (a GPU readback in WebKit, almost free in Chrome).
      const reserve = Math.min(this.strip.uploadMs, (deadline - start) / 2);
      if (i > 0 && performance.now() + reserve > deadline) break;
      const e = q[i];
      if (!this.rasterize(e, e.reqBucket)) {
        this.full = true;
        i = q.length; // cannot make progress this frame
        break;
      }
    }
    this.flush();
    const remaining = this.full ? 0 : q.length - i;
    q.length = 0;
    return remaining;
  }

  private newPage(): AtlasPage {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.pageSize, this.pageSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const p: AtlasPage = { id: this.pages.length, tex, gen: 0, lastUse: this.frame, nextY: 0, shelves: [] };
    this.pages.push(p);
    return p;
  }

  private tryAlloc(p: AtlasPage, w: number, h: number): { x: number; y: number } | null {
    const size = this.pageSize;
    for (const s of p.shelves) {
      if (h <= s.h && s.h <= h * 1.5 + 4 && s.x + w <= size) {
        const x = s.x;
        s.x += w;
        return { x, y: s.y };
      }
    }
    const sh = Math.min(size, Math.ceil(h / 8) * 8);
    if (p.nextY + sh <= size && w <= size) {
      const s = { y: p.nextY, h: sh, x: w };
      p.nextY += sh;
      p.shelves.push(s);
      return { x: 0, y: s.y };
    }
    return null;
  }

  private alloc(w: number, h: number): { page: AtlasPage; x: number; y: number } | null {
    for (let i = this.pages.length - 1; i >= 0; i--) {
      const r = this.tryAlloc(this.pages[i], w, h);
      if (r) {
        this.pages[i].lastUse = this.frame;
        return { page: this.pages[i], ...r };
      }
    }
    let page: AtlasPage;
    if (this.pages.length < this.maxPages) {
      page = this.newPage();
    } else {
      // Evict the least recently drawn page wholesale (slots validate against page.gen).
      page = this.pages.reduce((a, b) => (b.lastUse < a.lastUse ? b : a));
      if (page.lastUse >= this.frame) return null; // everything was used this frame
      page.gen++;
      page.nextY = 0;
      page.shelves = [];
    }
    page.lastUse = this.frame;
    const r = this.tryAlloc(page, w, h);
    return r ? { page, ...r } : null;
  }

  private stripAt(tier: number): Strip {
    let s = this.strips[tier];
    if (!s) {
      const [w, h] = STRIP_SIZES[tier];
      s = this.strips[tier] = { ...make2D(w, h), w, h, x: 0, y: 0, rowH: 0, used: 0, uploadMs: 0 };
    }
    return s;
  }

  /** Texels a label's slot needs at a bucket (its raster bounds plus padding). */
  private cellSize(e: LabelEntry, bucket: number): { w: number; h: number } {
    const s = this.scaleOf(bucket);
    const bounds = labelRasterBounds(e.label, this.ensureLayout(e));
    return { w: Math.max(1, Math.ceil(bounds.w * s)) + 2 * PAD, h: Math.max(1, Math.ceil(bounds.h * s)) + 2 * PAD };
  }

  /** A free cell of w x h texels in the staging strip; uploads the pending batch first when the strip is full. */
  private stripCell(w: number, h: number): { ctx: Ctx2D; x: number; y: number } {
    let s = this.strip ?? this.stripAt(0);
    if (s.x + w > s.w) {
      s.x = 0;
      s.y += s.rowH;
      s.rowH = 0;
    }
    if (s.y + h > s.h || w > s.w) {
      this.flush();
      if (w > s.w || h > s.h) {
        // Too big for this strip: the smallest strip size that fits, or one made for it.
        const tier = STRIP_SIZES.findIndex(([sw, sh]) => w <= sw && h <= sh);
        if (tier >= 0) s = this.stripAt(tier);
        else {
          const big = this.bigStrip;
          if (!big || w > big.w || h > big.h) {
            const nw = Math.max(w, big?.w ?? 0), nh = Math.max(h, big?.h ?? 0);
            this.bigStrip = { ...make2D(nw, nh), w: nw, h: nh, x: 0, y: 0, rowH: 0, used: 0, uploadMs: 0 };
          }
          s = this.bigStrip!;
        }
        this.strip = s;
      }
    }
    const cell = { ctx: s.ctx, x: s.x, y: s.y };
    s.x += w;
    s.rowH = Math.max(s.rowH, h);
    s.used = Math.max(s.used, s.y + s.rowH);
    return cell;
  }

  /** Copy the batch from the staging strip into the atlas pages, then clear the strip for the next batch. */
  private flush(): void {
    const s = this.strip;
    if (!s) return;
    const ups = this.uploads;
    if (ups.length > 0) {
      const gl = this.gl;
      const t0 = performance.now();
      ups.sort((a, b) => a.page.id - b.page.id);
      let bound: AtlasPage | null = null;
      for (const u of ups) {
        if (u.page !== bound) gl.bindTexture(gl.TEXTURE_2D, (bound = u.page).tex);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, u.sx);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, u.sy);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, u.x, u.y, u.w, u.h, gl.RGBA, gl.UNSIGNED_BYTE, s.canvas);
      }
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
      s.uploadMs = 0.7 * s.uploadMs + 0.3 * (performance.now() - t0);
      ups.length = 0;
    }
    if (s.used > 0) s.ctx.clearRect(0, 0, s.w, s.used);
    s.x = s.y = s.rowH = s.used = 0;
  }

  /** Touch a page so it is not chosen for eviction (call for every slot drawn). */
  touch(slot: AtlasSlot): void {
    slot.page.lastUse = this.frame;
  }

  private rasterize(e: LabelEntry, bucket: number): boolean {
    if (this.exact(e, bucket)) return true;
    const lay = this.ensureLayout(e);
    const s = this.scaleOf(bucket);
    const bounds = labelRasterBounds(e.label, lay);
    const tw = Math.max(1, Math.ceil(bounds.w * s)) + 2 * PAD;
    const th = Math.max(1, Math.ceil(bounds.h * s)) + 2 * PAD;
    const spot = this.alloc(tw, th);
    if (!spot) return false;
    const cell = this.stripCell(tw, th);
    const ctx = cell.ctx;
    // The cell is clear (the strip is cleared after each batch); the clip keeps overhang out of the neighbours.
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, tw, th);
    ctx.clip();
    ctx.translate(cell.x, cell.y);
    ctx.font = fontString(e.font, e.font.size * s);
    ctx.fillStyle = e.css;
    ctx.textBaseline = 'alphabetic';
    if (e.curvedGlyphs === undefined) e.curvedGlyphs = placeCurvedGlyphs(e.label, lay);
    const highlighted = e.label.highlightedWord;
    const source = highlighted && e.label.maxWidth > 0 && Number.isFinite(e.label.maxWidth)
      ? e.label.text.replace(/[ \t]+/g, ' ')
      : e.label.text;
    const marked: { start: number; end: number }[] = [];
    if (highlighted) {
      let start = 0;
      for (const part of wordParts(source)) {
        const end = start + part.text.length;
        if (part.key === highlighted) marked.push({ start, end });
        start = end;
      }
    }
    const draw = (underline = false) => {
      if (e.curvedGlyphs) {
        ctx.textAlign = 'center';
        const start = underline ? source.indexOf(lay.lines[0].text) : 0;
        for (const glyph of e.curvedGlyphs) {
          ctx.save();
          ctx.translate(PAD + (glyph.x - bounds.x) * s, PAD + (glyph.y - bounds.y) * s);
          ctx.rotate(glyph.angle);
          ctx.fillText(glyph.text, 0, 0);
          if (underline && marked.some(range => start + glyph.start >= range.start && start + glyph.start < range.end)) {
            const width = ctx.measureText(glyph.text).width;
            ctx.fillRect(-width / 2, e.font.size * s * 0.12, width, Math.max(1, s * e.font.size * 0.08));
          }
          ctx.restore();
        }
      } else {
        ctx.textAlign = 'left';
        const align = e.label.align;
        let previousEnd = 0;
        for (let i = 0; i < lay.lines.length; i++) {
          const ln = lay.lines[i];
          if (!ln.text) continue;
          const free = lay.w - ln.w;
          const xo = align === 'left' ? 0 : align === 'center' ? free / 2 : free;
          const x = -lay.w / 2 - bounds.x + xo;
          const y = -lay.h / 2 - bounds.y + i * lay.lineHeight + lay.baseline;
          ctx.fillText(ln.text, PAD + x * s, PAD + y * s);
          if (underline) {
            const start = source.indexOf(ln.text, previousEnd);
            if (start < 0) continue;
            previousEnd = start + ln.text.length;
            for (const range of marked) {
              if (range.end <= start || range.start >= previousEnd) continue;
              const left = ctx.measureText(ln.text.slice(0, Math.max(0, range.start - start))).width;
              const right = ctx.measureText(ln.text.slice(0, range.end - start)).width;
              ctx.fillRect(PAD + x * s + left, PAD + (y + e.font.size * 0.12) * s, right - left, Math.max(1, s * e.font.size * 0.08));
            }
          }
        }
      }
    };
    if (e.label.extrusion) {
      ctx.fillStyle = rgba(e.label.extrusion);
      for (const offset of labelDepthOffsets(e.label)) {
        ctx.save();
        ctx.translate(offset * s, offset * s);
        draw();
        ctx.restore();
      }
      ctx.fillStyle = e.css;
    }
    draw(!!highlighted);
    ctx.restore();
    this.uploads.push({ page: spot.page, x: spot.x, y: spot.y, w: tw, h: th, sx: cell.x, sy: cell.y });
    const size = this.pageSize;
    const slot: AtlasSlot = {
      page: spot.page,
      gen: spot.page.gen,
      bucket,
      scale: s,
      ox: bounds.x - PAD / s,
      oy: bounds.y - PAD / s,
      qw: tw / s,
      qh: th / s,
      u0: spot.x / size,
      v0: spot.y / size,
      u1: (spot.x + tw) / size,
      v1: (spot.y + th) / size
    };
    // Replace same-bucket / stale slots, cap variants per label.
    e.slots = e.slots.filter((x) => x.bucket !== bucket && this.valid(x));
    e.slots.push(slot);
    if (e.slots.length > 3) {
      e.slots.sort((a, b) => Math.abs(a.bucket - bucket) - Math.abs(b.bucket - bucket));
      e.slots.length = 3;
    }
    return true;
  }
}
