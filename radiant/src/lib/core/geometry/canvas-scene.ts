import type { CanvasElement, ImageDraw, LabelDraw, Mesh, NodeBox, NodeId, Rect, RGBA, Theme, Vec2 } from '../types';
import { premulCss, readableInk } from './color';
import { dimOpaque } from './scene';
import { defaultBand, elementBand, type CanvasBand } from '../model/canvas';
import {
  elementCentre, elementPoints, FRAME_STROKE, isLinear, NOTE_FILL, PAINT_FILL, PAINT_SHADOW, PAINT_STROKE,
  sketchElement, sketchSvg, type ElementSketch, type SketchPaint
} from './sketch';

/**
 * Canvas elements to scene data (spec 7.2): two meshes (under and over the maps) with one span per element
 * for culling, text as LabelDraw entries, pictures as ImageDraw entries, and SVG fragments for export that
 * come from the same sketch geometry. Arrow ends bound to nodes or elements are resolved here.
 */

// The default-band rule lives with the model commands, which must not load the sketch code (roughjs).
export { defaultBand, elementBand, type CanvasBand };

export const HAND_FONT = '"Chalkboard SE", "Marker Felt", "Comic Sans MS", cursive';
export const CODE_FONT = 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace';
export const DEFAULT_ELEMENT_FONT_SIZE = 20;
export const FRAME_NAME_SIZE = 14;
const SHADOW = 'rgba(0,0,0,0.14)';
const FRAME_NAME_COLOR = '#8a8a8a';
const BINDING_GAP = 4;

export function elementFontFamily(font: CanvasElement['font'], themeFamily: string): string {
  return font === 'hand' ? HAND_FONT : font === 'code' ? CODE_FONT : themeFamily;
}

/** Inner text area of an element, for wrapping: [maxWidth, centre offset x, centre offset y]. */
function textBox(el: CanvasElement): { maxWidth: number; cx: number; cy: number } {
  const w = Math.abs(el.w), h = Math.abs(el.h);
  switch (el.kind) {
    case 'note': return { maxWidth: Math.max(8, w - 24), cx: w / 2, cy: h / 2 };
    case 'ellipse': return { maxWidth: Math.max(8, w / Math.SQRT2 - 10), cx: w / 2, cy: h / 2 };
    case 'diamond': return { maxWidth: Math.max(8, w / 2 - 10), cx: w / 2, cy: h / 2 };
    case 'text': return { maxWidth: Math.max(8, w + 1), cx: w / 2, cy: h / 2 };
    default: return { maxWidth: Math.max(8, w - 10), cx: w / 2, cy: h / 2 };
  }
}

// ------------------------------------------------------------------------------------------ bindings

interface Target { cx: number; cy: number; w: number; h: number; angle: number; shape: 'rect' | 'ellipse' | 'diamond' }

function targetOf(binding: NonNullable<CanvasElement['start']>, boxes: ReadonlyMap<NodeId, NodeBox>,
  byId: ReadonlyMap<string, CanvasElement>): Target | undefined {
  if (binding.node) {
    const box = boxes.get(binding.node);
    return box && { cx: box.x, cy: box.y, w: box.w, h: box.h, angle: 0, shape: 'rect' };
  }
  const el = binding.element ? byId.get(binding.element) : undefined;
  if (!el || isLinear(el.kind) || el.kind === 'draw') return;
  const w = Math.abs(el.w), h = Math.abs(el.h);
  return {
    cx: el.x + w / 2, cy: el.y + h / 2, w, h, angle: el.angle ?? 0,
    shape: el.kind === 'ellipse' ? 'ellipse' : el.kind === 'diamond' ? 'diamond' : 'rect'
  };
}

const rotate = (x: number, y: number, angle: number): [number, number] =>
  angle ? [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle)] : [x, y];

/** The end point on `target` for an arrow whose neighbouring point is `toward` (world). */
function bindPoint(target: Target, binding: NonNullable<CanvasElement['start']>, toward: Vec2): Vec2 {
  if (binding.at) {
    const [x, y] = rotate((binding.at.x - 0.5) * target.w, (binding.at.y - 0.5) * target.h, target.angle);
    return { x: target.cx + x, y: target.cy + y };
  }
  const [dx, dy] = rotate(toward.x - target.cx, toward.y - target.cy, -target.angle);
  const hw = Math.max(target.w / 2, 1e-6), hh = Math.max(target.h / 2, 1e-6);
  const length = Math.hypot(dx, dy);
  if (!length) return { x: target.cx, y: target.cy };
  const t = target.shape === 'ellipse' ? 1 / Math.hypot(dx / hw, dy / hh)
    : target.shape === 'diamond' ? 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh)
    : Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  const gap = (binding.gap ?? BINDING_GAP) / length;
  const [x, y] = rotate(dx * (t + gap), dy * (t + gap), target.angle);
  return { x: target.cx + x, y: target.cy + y };
}

/**
 * Points of every line or arrow with a bound end whose target exists, relative to the element's (x, y),
 * so bound ends follow nodes and elements when they move. Ends whose target is missing keep their stored point.
 */
export function resolveCanvasPoints(elements: readonly CanvasElement[], boxes: ReadonlyMap<NodeId, NodeBox>,
  byId?: ReadonlyMap<string, CanvasElement>): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let index = byId;
  for (const el of elements) {
    if (!isLinear(el.kind) || (!el.start && !el.end && !el.elbow)) continue;
    index ??= new Map(elements.map((item) => [item.id, item]));
    const local = elementPoints(el);
    const n = local.length;
    if (n < 4) continue;
    const angle = el.angle ?? 0;
    const centre = elementCentre(el, local);
    const toWorld = (i: number): Vec2 => {
      const [x, y] = rotate(local[i] - centre.x, local[i + 1] - centre.y, angle);
      return { x: el.x + centre.x + x, y: el.y + centre.y + y };
    };
    const start = el.start && targetOf(el.start, boxes, index);
    const end = el.end && targetOf(el.end, boxes, index);
    if (!start && !end && !el.elbow) continue;
    const towardStart = n > 4 ? toWorld(2) : end ? { x: end.cx, y: end.cy } : toWorld(2);
    const towardEnd = n > 4 ? toWorld(n - 4) : start ? { x: start.cx, y: start.cy } : toWorld(n - 4);
    const points = local.slice();
    const place = (i: number, p: Vec2) => {
      const [x, y] = rotate(p.x - el.x - centre.x, p.y - el.y - centre.y, -angle);
      points[i] = centre.x + x;
      points[i + 1] = centre.y + y;
    };
    if (start) place(0, bindPoint(start, el.start!, el.elbow && end ? { x: end.cx, y: end.cy } : towardStart));
    if (end) place(n - 2, bindPoint(end, el.end!, el.elbow && start ? { x: start.cx, y: start.cy } : towardEnd));
    out.set(el.id, el.elbow ? elbowRoute(points) : points);
  }
  return out;
}

/**
 * Right-angle route between the first and last point (CNV-37): out along the axis with the larger distance, across
 * at the middle, then in. Recomputed whenever an end moves, so the route follows its targets.
 */
export function elbowRoute(points: readonly number[]): number[] {
  const n = points.length;
  const sx = points[0], sy = points[1], ex = points[n - 2], ey = points[n - 1];
  if (Math.abs(ex - sx) >= Math.abs(ey - sy)) {
    const mx = (sx + ex) / 2;
    return [sx, sy, mx, sy, mx, ey, ex, ey];
  }
  const my = (sy + ey) / 2;
  return [sx, sy, sx, my, ex, my, ex, ey];
}

// ------------------------------------------------------------------------------------------ scene

export interface CanvasPicture {
  src: string;
  previewSrc?: string;
  previewSrcs?: ImageDraw['previewSrcs'];
  thumbHash?: string;
  vector?: boolean;
  alt?: string;
}

export interface CanvasSceneContext {
  /** Current node boxes, for arrow ends bound to nodes. */
  boxes: ReadonlyMap<NodeId, NodeBox>;
  theme: Pick<Theme, 'background' | 'textColor' | 'fontFamily'>;
  /** Extra opacity per element (eraser marks); multiplies element opacity. */
  opacity?: (el: CanvasElement) => number;
  /**
   * Presentation dimming per element (CNV-60), 0..1: colours mix toward the theme background and stay opaque, as
   * dimmed nodes do (dimOpaque), so overlapping parts do not blend twice. Pictures fade by opacity. 1 = as drawn.
   */
  dim?: (el: CanvasElement) => number;
  /** Image source for a picture element's asset; without one the picture is not drawn. */
  picture?: (el: CanvasElement) => CanvasPicture | undefined;
  /** The scene built last time: a band whose elements are all unchanged keeps its mesh. */
  previous?: CanvasScene;
  /** Binding targets by id when `elements` is only part of the canvas (a gesture draws moving elements apart). */
  lookup?: ReadonlyMap<string, CanvasElement>;
}

export interface CanvasItem {
  el: CanvasElement;
  band: CanvasBand;
  sketch: ElementSketch;
  /** Line and arrow points with bound ends resolved, relative to (x, y). */
  points?: number[];
  opacity: number;
  stroke: RGBA;
  fill: RGBA;
  shadow: RGBA;
  label?: LabelDraw;
  image?: ImageDraw;
  /** World bounds of everything drawn for the element. */
  bounds: Rect;
}

export interface CanvasScene {
  back: Mesh;
  front: Mesh;
  /**
   * Element text in stacking order; each label's id is its element's id. `underMaps` is true for the back band (drawn
   * under the maps) and false for the front band (drawn over the maps and over the front band's shapes).
   */
  labels: LabelDraw[];
  /** Pictures in stacking order, with `underMaps` set by band as for labels. */
  images: ImageDraw[];
  /** Every element in stacking order: the back band, then the front band. */
  items: CanvasItem[];
  /** Resolved points of bound lines and arrows. */
  points: Map<string, number[]>;
  stats: { elements: number; vertices: number; triangles: number; reusedBands: number };
  /** @internal reuse key for the theme colours */
  themeKey: string;
}

function emptyMesh(): Mesh {
  return {
    positions: new Float64Array(0), colors: new Float32Array(0), indices: new Uint32Array(0),
    branchSpans: { ids: [], bounds: new Float64Array(0), ends: new Uint32Array(0) }
  };
}

const sameColor = (a: RGBA, b: RGBA) => a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

function sameBand(items: CanvasItem[], previous: CanvasItem[]): boolean {
  if (items.length !== previous.length) return false;
  for (let i = 0; i < items.length; i++) {
    const a = items[i], b = previous[i];
    if (a.sketch !== b.sketch || a.el.x !== b.el.x || a.el.y !== b.el.y || !sameColor(a.stroke, b.stroke) ||
        !sameColor(a.fill, b.fill) || !sameColor(a.shadow, b.shadow)) return false;
  }
  return true;
}

function bandMesh(items: CanvasItem[]): Mesh {
  let vertices = 0, indexCount = 0, spans = 0;
  for (const item of items) {
    if (!item.sketch.indices.length) continue;
    vertices += item.sketch.paints.length;
    indexCount += item.sketch.indices.length;
    spans++;
  }
  if (!spans) return emptyMesh();
  const positions = new Float64Array(vertices * 2), colors = new Float32Array(vertices * 4), indices = new Uint32Array(indexCount);
  const ids: string[] = [], bounds = new Float64Array(spans * 4), ends = new Uint32Array(spans);
  let vp = 0, ip = 0, span = 0;
  for (const item of items) {
    const { sketch, el } = item;
    if (!sketch.indices.length) continue;
    const palette = [item.stroke, item.fill, item.shadow];
    const count = sketch.paints.length;
    for (let v = 0; v < count; v++) {
      positions[(vp + v) * 2] = el.x + sketch.positions[v * 2];
      positions[(vp + v) * 2 + 1] = el.y + sketch.positions[v * 2 + 1];
      const c = palette[sketch.paints[v]], o = (vp + v) * 4;
      colors[o] = c.r;
      colors[o + 1] = c.g;
      colors[o + 2] = c.b;
      colors[o + 3] = c.a;
    }
    for (let k = 0; k < sketch.indices.length; k++) indices[ip + k] = vp + sketch.indices[k];
    vp += count;
    ip += sketch.indices.length;
    ids.push(el.id);
    bounds[span * 4] = el.x + sketch.bounds[0];
    bounds[span * 4 + 1] = el.y + sketch.bounds[1];
    bounds[span * 4 + 2] = el.x + sketch.bounds[2];
    bounds[span * 4 + 3] = el.y + sketch.bounds[3];
    ends[span++] = ip;
  }
  return { positions, colors, indices, branchSpans: { ids, bounds, ends } };
}

function pathLabelPoint(points: number[], ox: number, oy: number): { x: number; y: number; length: number } {
  let length = 0;
  for (let i = 2; i < points.length; i += 2) length += Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
  let left = length / 2;
  for (let i = 2; i < points.length; i += 2) {
    const segment = Math.hypot(points[i] - points[i - 2], points[i + 1] - points[i - 1]);
    if (segment >= left && segment > 0) {
      const t = left / segment;
      return { x: ox + points[i - 2] + (points[i] - points[i - 2]) * t, y: oy + points[i - 1] + (points[i + 1] - points[i - 1]) * t, length };
    }
    left -= segment;
  }
  return { x: ox + (points[0] ?? 0), y: oy + (points[1] ?? 0), length };
}

function elementLabel(el: CanvasElement, points: number[] | undefined, fill: string | undefined, opacity: number,
  theme: CanvasSceneContext['theme'], underMaps: boolean, paint: (color: string, alpha: number) => RGBA): LabelDraw | undefined {
  const text = el.text;
  if (!text || !text.trim() || el.kind === 'image' || el.kind === 'draw') return;
  const fontFamily = elementFontFamily(el.font, theme.fontFamily);
  const base = { id: el.id, text, bold: false, italic: false, underMaps };
  if (el.kind === 'frame') {
    const fontSize = el.fontSize ?? FRAME_NAME_SIZE, w = Math.max(Math.abs(el.w), 8);
    const color = readableInk(el.textColor ?? FRAME_NAME_COLOR, theme.background);
    const angle = el.angle ?? 0;
    const [dx, dy] = rotate(0, -Math.abs(el.h) / 2 - 6 - fontSize * 0.625, angle);
    return {
      ...base, x: el.x + w / 2 + dx, y: el.y + Math.abs(el.h) / 2 + dy, fontSize, fontFamily,
      color: paint(color, opacity), maxWidth: w, align: 'left', alignWidth: w, ...(angle ? { angle } : {})
    };
  }
  const fontSize = el.fontSize ?? DEFAULT_ELEMENT_FONT_SIZE;
  const ink = el.textColor ?? (el.kind === 'text' ? el.stroke : undefined) ?? theme.textColor;
  const align = el.align ?? (el.kind === 'text' ? 'left' : 'center');
  if (isLinear(el.kind)) {
    const local = points ?? elementPoints(el);
    const at = pathLabelPoint(local, el.x, el.y);
    if (el.angle) {
      // Points are unrotated, relative to (x, y); the element turns about its centre. The label stays level.
      const centre = elementCentre(el, local);
      const [dx, dy] = rotate(at.x - el.x - centre.x, at.y - el.y - centre.y, el.angle);
      at.x = el.x + centre.x + dx;
      at.y = el.y + centre.y + dy;
    }
    const maxWidth = Math.max(60, Math.min(320, at.length * 0.7));
    return {
      ...base, x: at.x, y: at.y, fontSize, fontFamily, color: paint(readableInk(ink, theme.background), opacity),
      maxWidth, align, alignWidth: align === 'center' ? undefined : maxWidth
    };
  }
  const box = textBox(el);
  const onFill = el.kind !== 'text' && fill;
  const fillAlpha = (el.fillStyle ?? 'solid') === 'solid' ? 1 : 0.35;
  const color = onFill ? readableInk(ink, theme.background, fill, fillAlpha) : readableInk(ink, theme.background);
  return {
    ...base, x: el.x + box.cx, y: el.y + box.cy, fontSize, fontFamily, color: paint(color, opacity),
    maxWidth: box.maxWidth, align, alignWidth: align === 'center' ? undefined : box.maxWidth, ...(el.angle ? { angle: el.angle } : {})
  };
}

function rotatedBox(el: CanvasElement): Rect {
  const w = Math.abs(el.w), h = Math.abs(el.h), angle = el.angle ?? 0;
  if (!angle) return { x: el.x, y: el.y, w, h };
  const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
  const rw = w * c + h * s, rh = w * s + h * c;
  return { x: el.x + w / 2 - rw / 2, y: el.y + h / 2 - rh / 2, w: rw, h: rh };
}

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Build the canvas part of a scene. Only elements whose shape changed are tessellated again (sketch cache). */
export function buildCanvasScene(elements: readonly CanvasElement[], context: CanvasSceneContext): CanvasScene {
  const { theme, previous } = context;
  const themeKey = theme.background + '|' + theme.textColor + '|' + theme.fontFamily;
  const byId = context.lookup ?? new Map(elements.map((el) => [el.id, el]));
  const resolved = resolveCanvasPoints(elements, context.boxes, byId);
  const background = premulCss(theme.background);
  const back: CanvasItem[] = [], front: CanvasItem[] = [];
  for (const el of elements) {
    const points = resolved.get(el.id);
    const sketch = sketchElement(el, points);
    const opacity = Math.max(0, Math.min(1, (el.opacity ?? 1) * (context.opacity?.(el) ?? 1)));
    const dim = Math.max(0, Math.min(1, context.dim?.(el) ?? 1));
    const paint = (color: string, alpha: number): RGBA => dim < 1 ? dimOpaque(premulCss(color, alpha), dim, background) : premulCss(color, alpha);
    const fill = el.fill ?? (el.kind === 'note' ? NOTE_FILL : undefined);
    const strokeColor = el.stroke ?? (el.kind === 'frame' ? FRAME_STROKE : theme.textColor);
    const band = elementBand(el);
    const underMaps = band === 'back';
    const label = elementLabel(el, points, fill, opacity, theme, underMaps, paint);
    let image: ImageDraw | undefined;
    if (el.kind === 'image') {
      const picture = context.picture?.(el);
      if (picture) {
        image = {
          id: el.id, src: picture.src, previewSrc: picture.previewSrc, previewSrcs: picture.previewSrcs,
          thumbHash: picture.thumbHash, vector: picture.vector, alt: picture.alt,
          x: el.x + Math.abs(el.w) / 2, y: el.y + Math.abs(el.h) / 2, w: Math.abs(el.w), h: Math.abs(el.h), opacity: opacity * dim,
          underMaps, ...(el.angle ? { angle: el.angle } : {})
        };
      }
    }
    let bounds: Rect = sketch.indices.length
      ? { x: el.x + sketch.bounds[0], y: el.y + sketch.bounds[1], w: sketch.bounds[2] - sketch.bounds[0], h: sketch.bounds[3] - sketch.bounds[1] }
      : rotatedBox(el);
    if (label && el.kind === 'frame') bounds = union(bounds, { x: el.x, y: el.y - 8 - label.fontSize * 1.25, w: label.maxWidth, h: label.fontSize * 1.25 + 8 });
    const item: CanvasItem = {
      el, band, sketch, points, opacity,
      stroke: paint(strokeColor, opacity),
      fill: fill ? paint(fill, opacity) : { r: 0, g: 0, b: 0, a: 0 },
      shadow: paint(SHADOW, opacity),
      label, image, bounds
    };
    (item.band === 'back' ? back : front).push(item);
  }
  let reusedBands = 0;
  const reuse = (items: CanvasItem[], band: CanvasBand): Mesh => {
    if (previous && previous.themeKey === themeKey) {
      const old = previous.items.filter((item) => item.band === band);
      if (sameBand(items, old)) {
        reusedBands++;
        return band === 'back' ? previous.back : previous.front;
      }
    }
    return bandMesh(items);
  };
  const backMesh = reuse(back, 'back'), frontMesh = reuse(front, 'front');
  const items = [...back, ...front];
  const labels: LabelDraw[] = [], images: ImageDraw[] = [];
  for (const item of items) {
    if (item.image) images.push(item.image);
    if (item.label) labels.push(item.label);
  }
  const vertices = backMesh.positions.length / 2 + frontMesh.positions.length / 2;
  const triangles = (backMesh.indices.length + frontMesh.indices.length) / 3;
  return {
    back: backMesh, front: frontMesh, labels, images, items, points: resolved, themeKey,
    stats: { elements: elements.length, vertices, triangles, reusedBands }
  };
}

// ------------------------------------------------------------------------------------------ export

export interface CanvasSvgFragment {
  id: string;
  band: CanvasBand;
  bounds: Rect;
  /** Shape markup from the sketch geometry in world coordinates; text and pictures are in label and image. */
  markup: string;
  label?: LabelDraw;
  image?: ImageDraw;
}

/** SVG fragments in stacking order (back band, then front band) from the same geometry as the meshes. */
export function canvasSvgFragments(scene: CanvasScene): CanvasSvgFragment[] {
  return scene.items.map((item) => {
    const palette: Record<SketchPaint, RGBA> = { [PAINT_STROKE]: item.stroke, [PAINT_FILL]: item.fill, [PAINT_SHADOW]: item.shadow };
    return {
      id: item.el.id, band: item.band, bounds: item.bounds,
      markup: sketchSvg(item.sketch, item.el.x, item.el.y, (paint) => palette[paint]),
      label: item.label, image: item.image
    };
  });
}
