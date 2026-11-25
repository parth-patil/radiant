// Synthetic scene for the render performance demo. Independent of core/layout and core/geometry on purpose.
import type { LabelDraw, ImageDraw, Mesh, RectDraw, RGBA, Rect, Scene } from '../../../lib/core/types';
import { measureLabel } from '../../../lib/render';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'Strategy', 'Research', 'Design', 'Budget', 'Timeline', 'Customers', 'Risks', 'Ideas', 'Launch', 'Metrics',
  'Planning', 'Notes', 'Experiments', 'Hiring', 'Roadmap', 'Marketing', 'Engineering', 'Support', 'Legal', 'Data',
  'Onboarding', 'Pricing', 'Feedback', 'Quality', 'Security', 'Operations', 'Brand', 'Partners', 'Vision', 'Goals'
];
const EXOTIC = [
  '日本語のテキスト', '中文节点示例', '한국어 노드', 'مرحبا بالعالم', 'שלום עולם', 'नमस्ते दुनिया', 'Привет, мир',
  'Γειά σου Κόσμε', 'ไทยตัวอย่าง', '🚀 Launch day 🎉', '🌍 Global ✨', '👩‍💻 Dev team', 'Ünïcödé àccénts', 'ᚠᚢᚦᚨᚱᚲ'
];
const LONG = [
  'A longer idea that needs to wrap onto several lines so wrapping is exercised',
  'Remember to follow up with the research group about the open questions from last week',
  'Mind maps work best when every node holds a single short thought'
];
const PALETTE: RGBA[] = [
  '#e6492d', '#2e86de', '#27ae60', '#f39c12', '#8e44ad', '#16a085', '#d35400', '#c0392b', '#1f7a8c', '#6c5ce7', '#e84393', '#2d3436'
].map(hex);

const pm = (c: RGBA, a = c.a): RGBA => ({ r: c.r * a, g: c.g * a, b: c.b * a, a });

function hex(h: string): RGBA {
  const n = parseInt(h.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
}

interface N {
  parent: number;
  depth: number;
  side: -1 | 0 | 1;
  main: number;
  kids: number[];
  text: string;
  size: number;
  maxW: number;
  w: number;
  h: number;
  x: number; // centre
  y: number;
}

export interface SyntheticOptions {
  nodes?: number;
  images?: number;
  /** Added to every coordinate: tests precision far from the origin. */
  originOffset?: number;
  seed?: number;
}

export interface SyntheticScene {
  scene: Scene;
  bounds: Rect;
  nodeCount: number;
  triangles: number;
  buildMs: number;
}

export function pickText(r: () => number, depth: number): string {
  const x = r();
  if (depth <= 1) return WORDS[Math.floor(r() * WORDS.length)];
  if (x < 0.12) return EXOTIC[Math.floor(r() * EXOTIC.length)];
  if (x < 0.2) return LONG[Math.floor(r() * LONG.length)];
  const a = WORDS[Math.floor(r() * WORDS.length)];
  return x < 0.6 ? a : `${a} ${WORDS[Math.floor(r() * WORDS.length)].toLowerCase()} ${Math.floor(r() * 90 + 10)}`;
}

export function buildSyntheticScene(imageUrls: string[], o: SyntheticOptions = {}): SyntheticScene {
  const t0 = performance.now();
  const count = o.nodes ?? 5000;
  const rnd = rng(o.seed ?? 7);
  const off = o.originOffset ?? 0;
  const nodes: N[] = [];
  const mk = (parent: number, depth: number, side: -1 | 0 | 1, main: number): number => {
    const size = depth === 0 ? 30 : depth === 1 ? 20 : 14;
    const text = depth === 0 ? 'Central Topic' : pickText(rnd, depth);
    const maxW = depth <= 1 ? 220 : 170;
    const m = measureLabel(text, { family: 'system-ui, sans-serif', size, bold: depth <= 1, italic: false }, maxW);
    nodes.push({ parent, depth, side, main, kids: [], text, size, maxW, w: m.w, h: m.h, x: 0, y: 0 });
    if (parent >= 0) nodes[parent].kids.push(nodes.length - 1);
    return nodes.length - 1;
  };
  mk(-1, 0, 0, -1);
  const mains = 12;
  for (let i = 0; i < mains; i++) mk(0, 1, i % 2 === 0 ? 1 : -1, i);
  while (nodes.length < count) {
    const pi = 1 + Math.floor(Math.pow(rnd(), 1.5) * (nodes.length - 1));
    const p = nodes[pi];
    if (p.depth >= 9 || p.kids.length >= 6) continue;
    mk(pi, p.depth + 1, p.side, p.main);
  }

  // Layout: each side stacks its leaves; parents sit at the mean of their children.
  const gap = 46;
  const slotH = 22;
  const layoutSide = (side: -1 | 1) => {
    let slot = 0;
    const place = (i: number, edgeX: number) => {
      const n = nodes[i];
      const left = edgeX; // near edge toward the root
      n.x = side * (left + n.w / 2);
      if (n.kids.length === 0) {
        const hh = Math.max(slotH, n.h + 6);
        n.y = slot + hh / 2;
        slot += hh;
      } else {
        for (const k of n.kids) place(k, left + n.w + gap);
        n.y = (nodes[n.kids[0]].y + nodes[n.kids[n.kids.length - 1]].y) / 2;
      }
    };
    const roots = nodes[0].kids.filter((k) => nodes[k].side === side);
    for (const k of roots) place(k, nodes[0].w / 2 + gap);
    // Centre the side vertically.
    const total = slot;
    const stack = [...roots];
    while (stack.length) {
      const i = stack.pop()!;
      nodes[i].y -= total / 2;
      stack.push(...nodes[i].kids);
    }
  };
  layoutSide(1);
  layoutSide(-1);

  // Branch mesh: tapered quad strips along a horizontal-tangent cubic.
  const SEG = 10;
  const nb = nodes.length - 1;
  const pos = new Float32Array(nb * (SEG + 1) * 2 * 2);
  const col = new Float32Array(nb * (SEG + 1) * 2 * 4);
  const idx = new Uint32Array(nb * SEG * 6);
  let vi = 0, ii = 0;
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    const p = nodes[n.parent];
    const dir = n.side;
    const x0 = p.depth === 0 ? dir * (p.w / 2) : p.x + dir * (p.w / 2);
    const y0 = p.y + (p.depth === 0 ? 0 : p.h / 2 - 2);
    const x1 = n.x - dir * (n.w / 2);
    const y1 = n.y + n.h / 2 - 2;
    const dx = (x1 - x0) * 0.5;
    const w0 = Math.max(1.5, 13 - n.depth * 1.6) / 2;
    const w1 = Math.max(0.9, w0 * 0.5);
    const c = PALETTE[n.main % PALETTE.length];
    const base = vi / 2;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
      const px = a * x0 + b * (x0 + dx) + cc * (x1 - dx) + d * x1;
      const py = a * y0 + b * y0 + cc * y1 + d * y1;
      const tx = 3 * u * u * dx + 6 * u * t * (x1 - dx - x0 - dx) + 3 * t * t * dx;
      const ty = 6 * u * t * (y1 - y0);
      const l = Math.hypot(tx, ty) || 1;
      const w = w0 + (w1 - w0) * t;
      const nx = (-ty / l) * w, ny = (tx / l) * w;
      pos[vi] = px + nx + off;
      pos[vi + 1] = py + ny + off;
      pos[vi + 2] = px - nx + off;
      pos[vi + 3] = py - ny + off;
      const co = (vi / 2) * 4;
      for (let k = 0; k < 2; k++) {
        col[co + k * 4] = c.r;
        col[co + k * 4 + 1] = c.g;
        col[co + k * 4 + 2] = c.b;
        col[co + k * 4 + 3] = 1;
      }
      vi += 4;
    }
    for (let s = 0; s < SEG; s++) {
      const q = base + s * 2;
      idx[ii++] = q;
      idx[ii++] = q + 1;
      idx[ii++] = q + 2;
      idx[ii++] = q + 1;
      idx[ii++] = q + 3;
      idx[ii++] = q + 2;
    }
  }
  const branches: Mesh = { positions: pos, colors: col, indices: idx };

  const labels: LabelDraw[] = [];
  const rects: RectDraw[] = [];
  const dark: RGBA = { r: 0.1, g: 0.11, b: 0.14, a: 1 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    labels.push({
      id: 'n' + i,
      text: n.text,
      x: n.x + off,
      y: n.y + off,
      fontSize: n.size,
      fontFamily: 'system-ui, sans-serif',
      bold: n.depth <= 1,
      italic: false,
      color: n.depth === 0 ? { r: 1, g: 1, b: 1, a: 1 } : dark,
      maxWidth: n.maxW,
      align: n.depth <= 1 ? 'center' : n.side < 0 ? 'right' : 'left'
    });
    if (n.depth <= 1 || (n.depth >= 2 && i % 5 === 0)) {
      const c = n.depth === 0 ? { r: 0.15, g: 0.2, b: 0.35, a: 1 } : PALETTE[n.main % PALETTE.length];
      rects.push({
        x: n.x - n.w / 2 - 8 + off,
        y: n.y - n.h / 2 - 5 + off,
        w: n.w + 16,
        h: n.h + 10,
        radius: n.depth === 0 ? 14 : 7,
        fill: n.depth === 0 ? pm(c) : n.depth === 1 ? pm(c, 0.22) : pm(c, 0.1),
        stroke: n.depth === 0 ? undefined : pm(c, 0.85),
        strokeWidth: n.depth === 1 ? 2 : 1
      });
    }
    x0 = Math.min(x0, n.x - n.w / 2);
    x1 = Math.max(x1, n.x + n.w / 2);
    y0 = Math.min(y0, n.y - n.h / 2);
    y1 = Math.max(y1, n.y + n.h / 2);
  }
  // Root rect must be under its label: it was pushed first (index 0), so order is already correct.

  const images: ImageDraw[] = [];
  const nImg = Math.min(o.images ?? 300, imageUrls.length);
  for (let k = 0; k < nImg; k++) {
    const n = nodes[1 + Math.floor(rnd() * (nodes.length - 1))];
    const size = 56 + Math.floor(rnd() * 56);
    images.push({
      id: 'img' + k,
      src: imageUrls[k],
      x: n.x + n.side * (n.w / 2 + size / 2 + 10) + off,
      y: n.y + off,
      w: size,
      h: size,
      opacity: 1
    });
  }

  const scene: Scene = {
    background: { r: 0.98, g: 0.975, b: 0.96, a: 1 },
    rects,
    branches,
    images,
    labels,
    overlay: []
  };
  return {
    scene,
    bounds: { x: x0 + off, y: y0 + off, w: x1 - x0, h: y1 - y0 },
    nodeCount: nodes.length,
    triangles: idx.length / 3,
    buildMs: performance.now() - t0
  };
}

/** Small distinct pictures drawn on canvases and exposed as blob URLs. */
export async function makeImageUrls(n: number): Promise<string[]> {
  const urls: string[] = [];
  const c = document.createElement('canvas');
  c.width = c.height = 192;
  const g = c.getContext('2d')!;
  for (let i = 0; i < n; i++) {
    const h = (i * 47) % 360;
    const grad = g.createLinearGradient(0, 0, 192, 192);
    grad.addColorStop(0, `hsl(${h} 70% 62%)`);
    grad.addColorStop(1, `hsl(${(h + 60) % 360} 70% 40%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 192, 192);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    g.arc(96 + Math.sin(i) * 40, 96 + Math.cos(i * 1.7) * 40, 50 + (i % 5) * 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.font = 'bold 44px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i), 96, 96);
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 6;
    g.strokeRect(3, 3, 186, 186);
    const blob = await new Promise<Blob>((res) => c.toBlob((b) => res(b!), 'image/png'));
    urls.push(URL.createObjectURL(blob));
  }
  return urls;
}
