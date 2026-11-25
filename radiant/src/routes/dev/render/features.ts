// Demo scenes for the theme and canvas drawing features: rectangle shadows, the canvas surface and the two
// canvas-element bands. Independent of core/geometry on purpose, like synthetic.ts.
import type { LabelDraw, Mesh, Rect, RectDraw, RGBA, Scene } from '../../../lib/core/types';

export interface FeatureFlags {
  shadows: boolean;
  surface: boolean;
  canvas: boolean;
}

/** Opaque mix of a colour into white, as theme node boxes are filled. */
function tint(h: string, t: number): RGBA {
  const c = hex(h);
  return { r: 1 - (1 - c.r) * t, g: 1 - (1 - c.g) * t, b: 1 - (1 - c.b) * t, a: 1 };
}

function hex(h: string, a = 1): RGBA {
  const n = parseInt(h.slice(1), 16);
  return { r: (((n >> 16) & 255) / 255) * a, g: (((n >> 8) & 255) / 255) * a, b: ((n & 255) / 255) * a, a };
}

const SHADOW = hex('#1B2A3A', 0.18);
const SURFACE: NonNullable<Scene['surface']> = {
  gradient: [hex('#F7F4EC'), hex('#E4EAF2')],
  vignette: 0.25,
  dots: { color: hex('#8A8170', 0.35), spacing: 24 }
};

/** Triangles with one span per element, the shape W5's canvas meshes take. */
class MeshBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private idx: number[] = [];
  private ids: string[] = [];
  private bounds: number[] = [];
  private ends: number[] = [];

  /** One element: polygons given as flat x,y lists, fanned from their first point. */
  element(id: string, color: RGBA, ...polygons: number[][]): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const poly of polygons) {
      const base = this.pos.length / 2;
      for (let i = 0; i < poly.length; i += 2) {
        this.pos.push(poly[i], poly[i + 1]);
        this.col.push(color.r, color.g, color.b, color.a);
        x0 = Math.min(x0, poly[i]);
        x1 = Math.max(x1, poly[i]);
        y0 = Math.min(y0, poly[i + 1]);
        y1 = Math.max(y1, poly[i + 1]);
      }
      for (let k = 1; k < poly.length / 2 - 1; k++) this.idx.push(base, base + k, base + k + 1);
    }
    this.ids.push(id);
    this.bounds.push(x0, y0, x1, y1);
    this.ends.push(this.idx.length);
  }

  /** A straight band of width w from (ax, ay) to (bx, by). */
  static band(ax: number, ay: number, bx: number, by: number, w: number): number[] {
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const nx = (-(by - ay) / l) * (w / 2), ny = ((bx - ax) / l) * (w / 2);
    return [ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny];
  }

  build(): Mesh | undefined {
    if (!this.idx.length) return undefined;
    return {
      positions: new Float64Array(this.pos),
      colors: new Float32Array(this.col),
      indices: new Uint32Array(this.idx),
      branchSpans: { ids: this.ids, bounds: new Float64Array(this.bounds), ends: new Uint32Array(this.ends) }
    };
  }
}

/** Arrow from a to b drawn as a shaft and a head, so it can be seen crossing a label. */
function arrow(m: MeshBuilder, id: string, color: RGBA, ax: number, ay: number, bx: number, by: number, w = 5): void {
  const l = Math.hypot(bx - ax, by - ay);
  const ux = (bx - ax) / l, uy = (by - ay) / l;
  const hx = bx - ux * 22, hy = by - uy * 22;
  m.element(id, color, MeshBuilder.band(ax, ay, hx, hy, w),
    [bx, by, hx - uy * 11, hy + ux * 11, hx + uy * 11, hy - ux * 11]);
}

export interface FeatureScene {
  scene: Scene;
  bounds: Rect;
}

/** A root pill and three node pills with shadows, a surface, and hand-built back and front canvas meshes. */
export function buildFeatureScene(flags: FeatureFlags): FeatureScene {
  const rects: RectDraw[] = [];
  const labels: LabelDraw[] = [];
  const ink = hex('#2B3743');
  const pill = (id: string, cx: number, cy: number, w: number, h: number, fill: RGBA, stroke: RGBA | undefined,
    text: string, size: number, bold: boolean, shadow: { dy: number; blur: number }) => {
    rects.push({
      nodeId: id, x: cx - w / 2, y: cy - h / 2, w, h, radius: h / 2, fill, stroke, strokeWidth: stroke ? 1.5 : 0,
      shadow: flags.shadows ? { ...shadow, color: SHADOW } : undefined
    });
    labels.push({
      id, text, x: cx, y: cy, fontSize: size, fontFamily: '"Avenir Next", Avenir, system-ui, sans-serif',
      bold, italic: false, color: ink, maxWidth: w - 24, align: 'center'
    });
  };
  pill('root', 0, 0, 230, 66, hex('#FFFFFF'), hex('#E3E0D8'), 'Central topic', 24, true, { dy: 6, blur: 9 });
  const mains = [
    { id: 'a', y: -130, color: '#12A07C', text: 'Research' },
    { id: 'b', y: 0, color: '#E05C8E', text: 'Design' },
    { id: 'c', y: 130, color: '#7353E5', text: 'Launch' }
  ];

  // Branches: one tapered cubic per main node, all in the single branch mesh.
  const SEG = 16;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (const m of mains) {
    const c = hex(m.color);
    const x0 = 100, y0 = m.y * 0.15, x1 = 262, y1 = m.y;
    const base = pos.length / 2;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG, u = 1 - t;
      const dx = (x1 - x0) * 0.5;
      const px = u * u * u * x0 + 3 * u * u * t * (x0 + dx) + 3 * u * t * t * (x1 - dx) + t * t * t * x1;
      const py = (u * u * u + 3 * u * u * t) * y0 + (3 * u * t * t + t * t * t) * y1;
      const w = 7 - 4 * t;
      pos.push(px, py - w / 2, px, py + w / 2);
      col.push(c.r, c.g, c.b, 1, c.r, c.g, c.b, 1);
    }
    for (let s = 0; s < SEG; s++) {
      const q = base + s * 2;
      idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
    }
    pill(m.id, 340, m.y, 160, 44, tint(m.color, 0.16), undefined, m.text, 18, true, { dy: 4, blur: 6 });
  }
  const branches: Mesh = { positions: new Float64Array(pos), colors: new Float32Array(col), indices: new Uint32Array(idx) };

  let canvasBack: Mesh | undefined, canvasFront: Mesh | undefined;
  if (flags.canvas) {
    const back = new MeshBuilder();
    back.element('note', hex('#FFE58F'), [-470, -170, -290, -170, -290, -10, -470, -10]);
    back.element('frame', hex('#2B7DE9', 0.12), [-500, 40, -250, 40, -250, 200, -500, 200]);
    back.element('tri', hex('#12A07C', 0.55), [-420, 180, -340, 70, -280, 180]);
    // Under the maps: this band sits behind the Design pill and its label.
    back.element('under', hex('#F2672A', 0.5), [250, -30, 460, -30, 460, 30, 250, 30]);
    canvasBack = back.build();
    const front = new MeshBuilder();
    arrow(front, 'arrow', hex('#D93F3F', 0.85), -280, -90, 250, -125);
    // Over the maps: this wedge covers part of the Launch label.
    front.element('wedge', hex('#2B3743', 0.55), [330, 110, 440, 120, 360, 170]);
    canvasFront = front.build();
    labels.push({
      id: 'note-text', text: 'Sticky note', x: -380, y: -90, fontSize: 18,
      fontFamily: '"Chalkboard SE", "Marker Felt", cursive', bold: false, italic: false, color: ink, maxWidth: 160, align: 'center'
    });
  }

  const scene: Scene = {
    background: hex('#FBFAF6'),
    rects,
    branches,
    images: [],
    labels,
    overlay: [],
    surface: flags.surface ? SURFACE : undefined,
    canvasBack,
    canvasFront
  };
  return { scene, bounds: { x: -520, y: -200, w: 960, h: 420 } };
}

/**
 * The synthetic performance scene with the same features added: shadows on the root and main nodes, the
 * surface, and one canvas element beside each of up to 5,000 nodes, alternating bands.
 */
export function decorateScene(scene: Scene, bounds: Rect, flags: FeatureFlags, elements = 5000): Scene {
  const out: Scene = { ...scene };
  if (flags.shadows) {
    out.rects = scene.rects.map((r, i) =>
      i === 0 || r.strokeWidth === 2 ? { ...r, shadow: { dy: i === 0 ? 6 : 4, blur: i === 0 ? 9 : 6, color: SHADOW } } : r);
  }
  if (flags.surface) out.surface = SURFACE;
  if (flags.canvas) {
    const back = new MeshBuilder(), front = new MeshBuilder();
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < elements; i++) {
      const x = bounds.x + rnd() * bounds.w, y = bounds.y + rnd() * bounds.h;
      const w = 20 + rnd() * 60, h = 20 + rnd() * 60;
      if (i % 2) arrow(front, 'e' + i, hex('#D93F3F', 0.6), x, y, x + w * 2, y + h, 3);
      else back.element('e' + i, hex('#FFE58F', 0.9), [x, y, x + w, y, x + w, y + h, x, y + h]);
    }
    out.canvasBack = back.build();
    out.canvasFront = front.build();
  }
  return out;
}
