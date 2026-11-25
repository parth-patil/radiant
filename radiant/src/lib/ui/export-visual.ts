import { handDrawnOutline } from '../core/geometry/hand-drawn';
import { planPrint, type PrintPlan, type PrintSettings } from './print-layout';
import { inkPath, type InkDraw } from '../core/geometry/ink';
import { sanitizeSvg } from '../core/art/svg';
import { branchEndColor, MESH_DETAIL_ZOOM, premulCss, tessellateBranches } from '../core/geometry';
import { linkCurve } from '../core/geometry/link';
import { escapeXml } from '../core/io/xml';
import type { BranchSpec, CrossLink, ImageDraw, LabelDraw, NodeBox, NodeId, Rect, RectDraw, RGBA, Scene, Vec2 } from '../core/types';
import type { CanvasSvgFragment } from '../core/geometry/canvas-scene';
import { alignedLabelX, fontString, graphemes, type FontSpec, labelDepthOffsets, labelRasterBounds, layoutLabel, placeCurvedGlyphs } from '../render/text';

export type VisualFormat = 'png' | 'svg' | 'pdf';

interface VisualExport {
  scene: Scene;
  branches: BranchSpec[];
  boxes: Map<NodeId, NodeBox>;
  links: CrossLink[];
  linkColor: RGBA;
  viewport?: Rect;
  scale: number;
  transparent: boolean;
  tiles: boolean;
  print?: PrintSettings;
  printPreview?: boolean;
  /**
   * Canvas elements (CNV-26) in stacking order; their text and pictures are already in the scene's labels and images,
   * where `underMaps` places them with their band (true: back, false: front).
   */
  canvas?: CanvasSvgFragment[];
}

interface ElementDraw {
  bounds: Rect;
  markup: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const attrs = (values: Record<string, string | number>) =>
  Object.entries(values).map(([key, value]) => `${key}="${typeof value === 'number' ? fmt(value) : escapeXml(value)}"`).join(' ');

function paint(kind: 'fill' | 'stroke', color: RGBA): string {
  if (!color.a) return `${kind}="none"`;
  const component = (v: number) => Math.round(Math.max(0, Math.min(1, v / color.a)) * 255);
  const rgb = [component(color.r), component(color.g), component(color.b)].join(',');
  return `${kind}="rgb(${rgb})" ${kind}-opacity="${fmt(color.a)}"`;
}

/** `stop-color` and `stop-opacity` of a premultiplied colour. */
function stop(offset: number, color: RGBA): string {
  return `<stop offset="${offset}" ${paint('fill', color).replace(/^fill="none"$/, 'fill="rgb(0,0,0)" fill-opacity="0"')
    .replace('fill=', 'stop-color=').replace('fill-opacity=', 'stop-opacity=')}/>`;
}

function inkElement({ stroke, frame, opacity }: InkDraw): ElementDraw {
  const padding = stroke.width / 2;
  return {
    bounds: { x: frame.x - padding, y: frame.y - padding, w: frame.w + 2 * padding, h: frame.h + 2 * padding },
    markup: `<path ${attrs({ 'data-radiant-ink': 'stroke', d: inkPath(stroke, frame, fmt) })} ${paint('fill', premulCss(stroke.color, opacity))}/>`
  };
}

/**
 * Soft shadow under a rectangle: the rounded box offset by `dy` and blurred with standard deviation `blur`
 * (world units), as the renderer draws it. SVG and PNG use an SVG Gaussian blur filter (the shadow half of
 * feDropShadow, kept as its own element so every shadow lies under every rectangle and branch, as on the canvas).
 * PDF has no filters (svg2pdf.js ignores them), so there the shadow is three stacked translucent rounded
 * rectangles that approximate the Gaussian falloff.
 */
function shadow(r: RectDraw, key: number, pdf: boolean): ElementDraw | null {
  const s = r.shadow;
  if (!s || s.color.a <= 0) return null;
  const y = r.y + s.dy;
  const reach = 3 * s.blur;
  const bounds = { x: r.x - reach, y: y - reach, w: r.w + 2 * reach, h: r.h + 2 * reach };
  if (pdf || s.blur <= 0) {
    const layers = s.blur <= 0 ? [[0, 1]] : [[0, 0.45], [0.9, 0.22], [1.8, 0.08]];
    const markup = layers.map(([grow, share]) => {
      const d = grow * s.blur;
      const color = { r: s.color.r * share, g: s.color.g * share, b: s.color.b * share, a: s.color.a * share };
      return `<rect ${attrs({ x: r.x - d, y: y - d, width: r.w + 2 * d, height: r.h + 2 * d, rx: r.radius + d })} ${paint('fill', color)}/>`;
    }).join('');
    return { bounds, markup: `<g data-radiant-shadow="true">${markup}</g>` };
  }
  const id = `node-shadow-${key}`;
  const region = attrs({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h });
  return {
    bounds,
    markup: `<defs><filter id="${id}" filterUnits="userSpaceOnUse" ${region}><feGaussianBlur stdDeviation="${fmt(s.blur)}"/></filter></defs>` +
      `<rect data-radiant-shadow="true" ${attrs({ x: r.x, y, width: r.w, height: r.h, rx: r.radius })} ${paint('fill', s.color)} filter="url(#${id})"/>`
  };
}

/** Theme canvas surface over the background: screen-fixed gradient, world-fixed dots, screen-fixed vignette. */
function surfaceElements(surface: NonNullable<Scene['surface']>, crop: Rect): ElementDraw[] {
  const box = attrs({ x: crop.x, y: crop.y, width: crop.w, height: crop.h });
  const out: ElementDraw[] = [];
  if (surface.gradient) {
    const [top, bottom] = surface.gradient;
    out.push({ bounds: crop, markup: `<defs><linearGradient id="surface-gradient" x1="0" y1="0" x2="0" y2="1">${stop(0, top)}${stop(1, bottom)}</linearGradient></defs>` +
      `<rect ${box} fill="url(#surface-gradient)"/>` });
  }
  if (surface.dots && surface.dots.spacing > 0) {
    // Dots on world multiples of the spacing, one world unit in radius, as the renderer draws them at zoom 1.
    const s = surface.dots.spacing;
    out.push({ bounds: crop, markup: `<defs><pattern id="surface-dots" patternUnits="userSpaceOnUse" ${attrs({ x: -s / 2, y: -s / 2, width: s, height: s })}>` +
      `<circle ${attrs({ cx: s / 2, cy: s / 2, r: 1 })} ${paint('fill', surface.dots.color)}/></pattern></defs><rect ${box} fill="url(#surface-dots)"/>` });
  }
  const vignette = Math.min(1, surface.vignette ?? 0);
  if (vignette > 0) {
    // Elliptical, clear to 55% of 0.75 of the box and full strength at the rim (render/shaders.ts SURFACE_FS).
    const clear = { r: 0, g: 0, b: 0, a: 0 }, dark = { r: 0, g: 0, b: 0, a: vignette };
    out.push({ bounds: crop, markup: `<defs><radialGradient id="surface-vignette" cx="0.5" cy="0.5" r="0.75">${stop(0.55, clear)}${stop(1, dark)}</radialGradient></defs>` +
      `<rect ${box} fill="url(#surface-vignette)"/>` });
  }
  return out;
}

function rectangle(r: RectDraw): ElementDraw {
  if (r.wobble) {
    const points = handDrawnOutline(r);
    const path = points.map(({ x, y }, i) => `${i ? 'L' : 'M'}${fmt(x)} ${fmt(y)}`).join('') + 'Z';
    return {
      bounds: rectangleOfPoints(points.flatMap(({ x, y }) => [x, y])),
      markup: `<path data-radiant-hand-drawn="true" d="${path}" ${paint('fill', r.fill)}${r.stroke ? ` ${paint('stroke', r.stroke)} stroke-width="${fmt(r.strokeWidth ?? 1)}" stroke-linejoin="round"` : ''}/>`
    };
  }
  return {
    bounds: r,
    markup: `<rect${r.branchBoundary ? ' data-radiant-branch-boundary="true"' : ''} ${attrs({ x: r.x, y: r.y, width: r.w, height: r.h, rx: r.radius })} ${paint('fill', r.fill)}${r.stroke && r.strokeWidth !== 0 ? ` ${paint('stroke', r.stroke)} stroke-width="${fmt(r.strokeWidth ?? 1)}"` : ''}/>`
  };
}

function rectangleOfPoints(positions: ArrayLike<number>): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    minX = Math.min(minX, positions[i]);
    maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    maxY = Math.max(maxY, positions[i + 1]);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * One branch from the same geometry as the canvas (caps, tip dots, fanned joins). `zoom` sets the curve detail.
 * A limb that blends along its length (`spec.fade`) gets a linear gradient from p0 to p1 that pads past p1, so
 * the underline, end cap and tip dot take the end colour.
 */
function branch(spec: BranchSpec, key: number, zoom: number): ElementDraw {
  const { positions, indices } = tessellateBranches([spec], { zoom });
  const point = (i: number) => `${fmt(positions[i * 2])} ${fmt(positions[i * 2 + 1])}`;
  // Fill the whole mesh as one path. All triangles wind in the same direction so their shared
  // edges stay solid and overlaps at caps and underline bars do not cancel out.
  const triangles: string[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = indices.subarray(i, i + 3);
    const ax = positions[a * 2], ay = positions[a * 2 + 1];
    const winding = (positions[b * 2] - ax) * (positions[c * 2 + 1] - ay)
      - (positions[b * 2 + 1] - ay) * (positions[c * 2] - ax);
    triangles.push(winding >= 0 ? `M${point(a)}L${point(b)}L${point(c)}Z` : `M${point(a)}L${point(c)}L${point(b)}Z`);
  }
  const d = triangles.join('');
  const end = branchEndColor(spec);
  if (!spec.fade || (spec.p0.x === spec.p1.x && spec.p0.y === spec.p1.y)) {
    return { bounds: rectangleOfPoints(positions), markup: `<path d="${d}" ${paint('fill', spec.fade ? end : spec.color)}/>` };
  }
  const id = `branch-fade-${key}`;
  const line = attrs({ x1: spec.p0.x, y1: spec.p0.y, x2: spec.p1.x, y2: spec.p1.y });
  return {
    bounds: rectangleOfPoints(positions),
    markup: `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" spreadMethod="pad" ${line}>${stop(0, spec.color)}${stop(1, end)}</linearGradient></defs>` +
      `<path d="${d}" fill="url(#${id})"/>`
  };
}

/** Turn a drawn item about (x, y) by `angle` radians: the markup gets a rotate transform, the bounds grow to fit. */
function turned(draw: ElementDraw, angle: number | undefined, x: number, y: number): ElementDraw {
  if (!angle) return draw;
  const c = Math.cos(angle), s = Math.sin(angle);
  const { x: bx, y: by, w, h } = draw.bounds;
  const corners = [[bx, by], [bx + w, by], [bx, by + h], [bx + w, by + h]]
    .flatMap(([px, py]) => [x + (px - x) * c - (py - y) * s, y + (px - x) * s + (py - y) * c]);
  return {
    bounds: rectangleOfPoints(corners),
    markup: `<g transform="rotate(${fmt(angle * 180 / Math.PI)} ${fmt(x)} ${fmt(y)})">${draw.markup}</g>`
  };
}

function label(l: LabelDraw, pdf = false): ElementDraw {
  if (l.angle) return turned(label({ ...l, angle: undefined }, pdf), l.angle, l.x, l.y);
  if (l.extrusion) {
    const face = { ...l, extrusion: undefined };
    const front = label(face, pdf);
    const offsets = labelDepthOffsets(l);
    const sides = offsets.map(offset => label({ ...face, x: l.x + offset, y: l.y + offset, color: l.extrusion! }, pdf));
    return {
      bounds: { ...front.bounds, w: front.bounds.w + offsets[0], h: front.bounds.h + offsets[0] },
      markup: `<g data-radiant-text-depth="true"><g aria-hidden="true">${sides.map(side => side.markup).join('')}</g>${front.markup}</g>`
    };
  }
  const font = { family: l.fontFamily, size: l.fontSize, bold: l.bold, italic: l.italic };
  const layout = layoutLabel(l.text, font, l.maxWidth);
  const centered = alignedLabelX(l, layout.w);
  const bounds = { x: centered - layout.w / 2, y: l.y - layout.h / 2, w: layout.w, h: layout.h };
  const style = attrs({
    'font-size': l.fontSize, 'font-family': l.fontFamily,
    'font-weight': l.bold ? 'bold' : 'normal', 'font-style': l.italic ? 'italic' : 'normal'
  });
  const color = paint('fill', l.color);
  const text = (value: string) => escapeXml(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''));
  const glyphs = placeCurvedGlyphs(l, layout);
  if (glyphs) {
    const crop = labelRasterBounds(l, layout);
    const markup = glyphs.map((glyph) => {
      const x = centered + glyph.x;
      const y = l.y + glyph.y;
      const angle = glyph.angle * 180 / Math.PI;
      const transform = `rotate(${fmt(angle)} ${fmt(x)} ${fmt(y)})`;
      return `<text ${attrs({ x, y, transform, 'text-anchor': 'middle' })} ${style} ${color}>${text(glyph.text)}</text>`;
    }).join('');
    return {
      bounds: { ...crop, x: crop.x + centered, y: crop.y + l.y },
      markup: `<g aria-label="${text(l.text)}">${markup}</g>`
    };
  }
  const elements = layout.lines.flatMap((line, i) => {
    if (!line.text) return [];
    const free = layout.w - line.w;
    const x = bounds.x + (l.align === 'left' ? 0 : l.align === 'right' ? free : free / 2);
    const y = bounds.y + i * layout.lineHeight + layout.baseline;
    // Retain measured line width when a standalone SVG reader substitutes fonts.
    const width = !pdf && line.w > 0 ? ' ' + attrs({ textLength: line.w, lengthAdjust: 'spacingAndGlyphs' }) : '';
    const vector = (value: string, at: number) => `<text ${attrs({ x: at, y })} ${style} ${color}${width} xml:space="preserve">${text(value)}</text>`;
    if (!pdf || !needsPdfFallback(line.text)) return [{ bounds, markup: vector(line.text, x) }];
    return pdfTextLine(line.text, x, y, font, l.color).map(run => run.image ?? {
      bounds, markup: vector(run.text, run.x)
    });
  });
  return {
    bounds: elements.reduce(({ x, y, w, h }, element) => {
      const left = Math.min(x, element.bounds.x), top = Math.min(y, element.bounds.y);
      return { x: left, y: top, w: Math.max(x + w, element.bounds.x + element.bounds.w) - left,
        h: Math.max(y + h, element.bounds.y + element.bounds.h) - top };
    }, bounds),
    markup: elements.map(element => element.markup).join('')
  };
}

function needsPdfFallback(text: string): boolean {
  return /[^\u0000-\u00ff]/u.test(text);
}

/** Keep PDF text selectable around standalone glyphs that the built-in PDF font cannot encode. */
function pdfTextLine(text: string, x: number, y: number, font: FontSpec, color: RGBA):
  { text: string; x: number; image?: ElementDraw }[] {
  const clusters = graphemes(text);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not draw Unicode glyphs for PDF export.');
  const runs: { text: string; start: number; raster: boolean }[] = [];
  // Leave shaped scripts and mixed-direction text to Canvas as a complete line.
  if (clusters.some(cluster => needsPdfFallback(cluster) && !/[\p{S}\uFE0F\u20E3]/u.test(cluster))) {
    runs.push({ text, start: 0, raster: true });
  } else {
    let start = 0;
    for (const cluster of clusters) {
      const raster = needsPdfFallback(cluster);
      const previous = runs.at(-1);
      if (previous?.raster === raster) previous.text += cluster;
      else runs.push({ text: cluster, start, raster });
      start += cluster.length;
    }
  }
  const rgb = [color.r, color.g, color.b].map(c => Math.round(255 * c / (color.a || 1)));
  return runs.map(run => {
    ctx.font = fontString(font);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    const at = x + ctx.measureText(text.slice(0, run.start)).width;
    if (!run.raster) return { text: run.text, x: at };
    const metrics = ctx.measureText(run.text);
    const left = Math.max(0, metrics.actualBoundingBoxLeft) + 1;
    const up = Math.max(0, metrics.actualBoundingBoxAscent) + 1;
    const w = left + Math.max(metrics.width, metrics.actualBoundingBoxRight) + 1;
    const h = up + Math.max(0, metrics.actualBoundingBoxDescent) + 1;
    const scale = Math.min(3, 2048 / Math.max(w, h));
    canvas.width = Math.max(1, Math.ceil(w * scale));
    canvas.height = Math.max(1, Math.ceil(h * scale));
    ctx.font = fontString(font, font.size * scale);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = `rgba(${rgb.join(',')},${color.a})`;
    ctx.fillText(run.text, left * scale, up * scale);
    const bounds = { x: at - left, y: y - up, w: canvas.width / scale, h: canvas.height / scale };
    return {
      text: run.text, x: at,
      image: {
        bounds,
        markup: `<image ${attrs({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h,
          href: canvas.toDataURL('image/png'), 'aria-label': run.text })}/>`
      }
    };
  });
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not embed picture.'));
    reader.readAsDataURL(blob);
  });
}

function inlineSvg(markup: string, bounds: Rect, prefix: string): string {
  const safe = sanitizeSvg(markup);
  const xml = new DOMParser().parseFromString(safe, 'image/svg+xml');
  if (!safe || xml.getElementsByTagName('parsererror').length) throw new Error('An artwork asset contains invalid SVG.');
  const svg = xml.documentElement;
  svg.setAttribute('x', fmt(bounds.x));
  svg.setAttribute('y', fmt(bounds.y));
  svg.setAttribute('width', fmt(bounds.w));
  svg.setAttribute('height', fmt(bounds.h));
  const elements = [svg, ...svg.querySelectorAll('*')];
  const ids = new Map<string, string>();
  for (const element of elements) {
    const id = element.getAttribute('id');
    if (!id) continue;
    if (!ids.has(id)) ids.set(id, `${prefix}-${ids.size}`);
    element.setAttribute('id', ids.get(id)!);
  }
  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      const value = attribute.value.trim();
      if (attribute.localName === 'href') {
        const target = ids.get(value.slice(1));
        if (target) attribute.value = `#${target}`;
        else element.removeAttributeNode(attribute);
        continue;
      }
      const reference = /^url\s*\(\s*(['"]?)#([\w.:-]+)\1\s*\)$/i.exec(value);
      if (!reference) continue;
      const target = ids.get(reference[2]);
      attribute.value = target ? `url(#${target})` : 'none';
    }
  }
  return new XMLSerializer().serializeToString(svg);
}

async function rasterForExport(blob: Blob): Promise<Blob> {
  if (/^image\/(png|jpeg)$/.test(blob.type)) return blob;
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a canvas for the embedded picture.');
    ctx.drawImage(image, 0, 0);
    return await pngBlob(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function picture(im: ImageDraw, blob: Blob, key: number, pdf: boolean): Promise<ElementDraw> {
  if (im.angle) return turned(await picture({ ...im, angle: undefined }, blob, key, pdf), im.angle, im.x, im.y);
  const bounds = { x: im.x - im.w / 2, y: im.y - im.h / 2, w: im.w, h: im.h };
  const header = await blob.slice(0, 256).text();
  const svg = blob.type === 'image/svg+xml' || /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(header);
  if (svg && im.vector) {
    return { bounds, markup: `<g aria-label="${escapeXml(im.alt ?? '')}">${inlineSvg(await blob.text(), bounds, `art-${key}`)}</g>` };
  }
  const src = await dataUrl(pdf || svg ? await rasterForExport(blob) : blob);
  if (!src.startsWith('data:image/')) throw new Error('An artwork asset uses an unsupported image type.');
  return {
    bounds,
    markup: `<image ${attrs({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h, opacity: im.opacity, href: src, 'aria-label': im.alt ?? '' })}/>`
  };
}

function connectionArrow(endpoint: Vec2, control: Vec2, color: RGBA): ElementDraw[] {
  const dx = endpoint.x - control.x;
  const dy = endpoint.y - control.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) return [];
  const nx = dx / distance;
  const ny = dy / distance;
  // Equivalent to the canvas marker's 10-unit triangle, offset 8 units along the tangent.
  const unit = 6 * 1.4 / 10;
  const tip = { x: endpoint.x + nx * 2 * unit, y: endpoint.y + ny * 2 * unit };
  const base = { x: endpoint.x - nx * 8 * unit, y: endpoint.y - ny * 8 * unit };
  const a = { x: base.x - ny * 5 * unit, y: base.y + nx * 5 * unit };
  const b = { x: base.x + ny * 5 * unit, y: base.y - nx * 5 * unit };
  const vertices = [tip.x, tip.y, a.x, a.y, b.x, b.y];
  return [{
    bounds: rectangleOfPoints(vertices),
    markup: `<polygon points="${vertices.map(fmt).join(' ')}" ${paint('fill', color)}/>`
  }];
}

function crossConnection(link: CrossLink, boxes: Map<NodeId, NodeBox>, textColor: RGBA): ElementDraw[] {
  const from = boxes.get(link.from);
  const to = boxes.get(link.to);
  if (!from || !to) return [];
  const { p, q, control, mid } = linkCurve(from, to, link);
  const color = link.color ? premulCss(link.color) : textColor;
  const d = `M${fmt(p.x)} ${fmt(p.y)}Q${fmt(control.x)} ${fmt(control.y)} ${fmt(q.x)} ${fmt(q.y)}`;
  const dash = link.dash === 'solid' ? '' : ' stroke-dasharray="4 3"';
  const elements: ElementDraw[] = [{
    bounds: rectangleOfPoints([p.x, p.y, q.x, q.y, control.x, control.y]),
    markup: `<path d="${d}" fill="none" ${paint('stroke', color)} stroke-width="1.4"${dash}/>`
  }];
  if (link.arrows === 'both' || link.arrows === 'start') elements.push(...connectionArrow(p, control, color));
  if (link.arrows === 'both' || link.arrows === 'end') elements.push(...connectionArrow(q, control, color));
  if (link.label) {
    const font = { family: 'system-ui, sans-serif', size: 12, bold: false, italic: false };
    const text = link.label.replace(/[\x00-\x1f]+/g, ' ');
    const layout = layoutLabel(text, font, Infinity);
    elements.push(label({
      id: link.id, text, x: mid.x, y: mid.y - 4 + layout.h / 2 - layout.baseline,
      fontSize: font.size, fontFamily: font.family, bold: font.bold, italic: font.italic, color: textColor,
      maxWidth: Infinity, align: 'center'
    }));
  }
  return elements;
}

function intersect(a: Rect, b: Rect): boolean {
  // Small allowance for strokes and font overhang at crop boundaries.
  return a.x <= b.x + b.w + 16 && a.x + a.w >= b.x - 16
    && a.y <= b.y + b.h + 16 && a.y + a.h >= b.y - 16;
}

function contentBounds(elements: ElementDraw[], boxes: Map<NodeId, NodeBox>): Rect {
  const padding = 24;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const expand = ({ x, y, w, h }: Rect) => {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + w);
    bottom = Math.max(bottom, y + h);
  };
  for (const { x, y, w, h } of boxes.values()) expand({ x: x - w / 2, y: y - h / 2, w, h });
  for (const { bounds } of elements) expand(bounds);
  return { x: left - padding, y: top - padding, w: right - left + padding * 2, h: bottom - top + padding * 2 };
}

function svgPage(crop: Rect, width: number, height: number, elements: ElementDraw[], background: RGBA | null, local = false): string {
  const viewBox = [crop.x, crop.y, crop.w, crop.h].join(' ');
  const bg = background ? `<rect ${attrs({ x: crop.x, y: crop.y, width: crop.w, height: crop.h })} ${paint('fill', background)}/>` : '';
  const content = bg + elements.filter(({ bounds }) => intersect(bounds, crop)).map((el) => el.markup).join('');
  const frame = local
    ? `<g clip-path="url(#export-clip)"><g transform="scale(${(width / crop.w).toFixed(9)} ${(height / crop.h).toFixed(9)}) translate(${fmt(-crop.x)} ${fmt(-crop.y)})">${content}</g></g>`
    : content;
  const clip = local ? `<defs><clipPath id="export-clip"><rect width="${fmt(width)}" height="${fmt(height)}"/></clipPath></defs>` : '';
  return `<svg xmlns="${SVG_NS}" xmlns:xlink="${XLINK_NS}" ${attrs({ width, height, viewBox: local ? `0 0 ${fmt(width)} ${fmt(height)}` : viewBox })} preserveAspectRatio="none">${clip}${frame}</svg>`;
}

function pngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (blob) resolve(blob);
    else reject(new Error('The browser could not encode the PNG.'));
  }, 'image/png'));
}

async function pngBytes(svg: string, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  const canvas = document.createElement('canvas');
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create a canvas for PNG export.');
    ctx.drawImage(image, 0, 0, w, h);
    return new Uint8Array(await (await pngBlob(canvas)).arrayBuffer());
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    URL.revokeObjectURL(url);
  }
}

async function pdfBytes(
  crop: Rect, elements: ElementDraw[], background: RGBA | null, tiled: boolean, settings?: PrintSettings
): Promise<Uint8Array<ArrayBuffer>> {
  let plan: PrintPlan;
  if (settings || tiled) {
    plan = planPrint(crop, settings ?? { paper: 'a4', orientation: 'landscape', marginMm: 24 * 25.4 / 72, tiled: true });
  } else {
    // Preserve a geometry-sized single page for export callers without paper settings.
    const scale = Math.min(0.75, 14400 / Math.max(crop.w, crop.h));
    const w = Math.max(1, crop.w * scale);
    const h = Math.max(1, crop.h * scale);
    plan = { paper: [w, h], columns: 1, rows: 1, page: () => ({ crop, frame: { x: 0, y: 0, w, h } }) };
  }
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const orientation = plan.paper[0] >= plan.paper[1] ? 'landscape' : 'portrait';
  const pdf = new jsPDF({ unit: 'pt', format: plan.paper, orientation, compress: true, putOnlyUsedFonts: true });
  // Keep the last tile's blank paper consistent with the live preview.
  const drawing = background ? [{
    bounds: crop,
    markup: `<rect ${attrs({ x: crop.x, y: crop.y, width: crop.w, height: crop.h })} ${paint('fill', background)}/>`,
  }, ...elements] : elements;
  for (let index = 0; index < plan.columns * plan.rows; index++) {
    if (index) pdf.addPage(plan.paper, orientation);
    const { crop: tile, frame } = plan.page(index);
    const xml = svgPage(tile, frame.w, frame.h, drawing, null, true);
    const svg = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
    await svg2pdf(svg, pdf, { x: frame.x, y: frame.y, width: frame.w, height: frame.h });
  }
  return new Uint8Array(pdf.output('arraybuffer'));
}

export async function renderExport(format: VisualFormat, options: VisualExport): Promise<Uint8Array<ArrayBuffer>> {
  const { scene, boxes, branches, links, linkColor, viewport, transparent, scale, tiles } = options;
  const canvas = (band: 'back' | 'front'): ElementDraw[] => (options.canvas ?? [])
    .filter((f) => f.band === band && f.markup).map((f) => ({ bounds: f.bounds, markup: `<g data-radiant-element="${escapeXml(f.id)}">${f.markup}</g>` }));
  const pdf = format === 'pdf' || options.printPreview === true;
  const fetched = new Map<string, Promise<Blob>>();
  const imageDraws = await Promise.all(scene.images.map((image, key) => {
    if (viewport && !intersect({ x: image.x - image.w / 2, y: image.y - image.h / 2, w: image.w, h: image.h }, viewport)) return null;
    let task = fetched.get(image.src);
    if (!task) {
      task = fetch(image.src).then((response) => {
        if (!response.ok) throw new Error('Could not embed an artwork asset.');
        return response.blob();
      });
      fetched.set(image.src, task);
    }
    return task.then((blob) => picture(image, blob, key, pdf));
  }));
  // Pictures and text of canvas elements go with their band, as on the canvas; the maps' own stay in between.
  const band = (under: boolean | undefined): ElementDraw[] => [
    ...imageDraws.filter((el, key): el is ElementDraw => el !== null && scene.images[key].underMaps === under),
    ...scene.labels.filter((item) => item.underMaps === under).map((item) => label(item, pdf))
  ];
  // Curve detail at least the export scale, so zooming into an SVG or PDF shows no facets.
  const detail = Math.max(MESH_DETAIL_ZOOM, scale);
  // Canvas order: elements under the maps with their pictures and text, shadows, rectangles, branches, rectangles
  // flagged overBranches (a root over fanned joins), images, labels, elements over the maps, ink, the front band's
  // pictures and text, cross-links.
  const elements: ElementDraw[] = [
    ...canvas('back'),
    ...band(true),
    ...scene.rects.map((r, key) => shadow(r, key, pdf)).filter((el) => el !== null),
    ...scene.rects.filter((r) => !r.overBranches).map(rectangle),
    ...branches.map((spec, key) => branch(spec, key, detail)),
    ...scene.rects.filter((r) => r.overBranches).map(rectangle),
    ...band(undefined),
    ...canvas('front'),
    ...(scene.ink ?? []).map(inkElement),
    ...band(false),
    ...links.flatMap((link) => crossConnection(link, boxes, linkColor))
  ];
  const crop = viewport ?? contentBounds(elements, boxes);
  const background = transparent ? null : scene.background;
  if (scene.grid && !transparent) {
    const pattern = '<defs><pattern id="map-grid" patternUnits="userSpaceOnUse" x="-16" y="-16" width="32" height="32">' +
      `<circle cx="16" cy="16" r="0.9" ${paint('fill', scene.grid)}/></pattern></defs>`;
    elements.unshift({ bounds: crop, markup: `${pattern}<rect ${attrs({ x: crop.x, y: crop.y, width: crop.w, height: crop.h, fill: 'url(#map-grid)' })}/>` });
  }
  if (scene.surface && !transparent) elements.unshift(...surfaceElements(scene.surface, crop));
  if (format === 'pdf') return pdfBytes(crop, elements, background, tiles, options.print);
  const width = Math.max(1, Math.ceil(crop.w * scale));
  const height = Math.max(1, Math.ceil(crop.h * scale));
  if (format === 'png' && (width > 16384 || height > 16384 || width * height > 40_000_000)) {
    throw new Error('This PNG is too large. Use a lower scale, export a subtree, or choose SVG.');
  }
  const svg = svgPage(crop, width, height, elements, background);
  return format === 'svg' ? new TextEncoder().encode(svg) : pngBytes(svg, width, height);
}
