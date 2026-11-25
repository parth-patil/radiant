import type { BranchSpec, RGBA } from '../types';
import { SHADOW_FALL, WALL_SHEAR, rgba8 } from './relief';
import { underlineOffset, underlineSteps } from './underline';

/*
 * 'quilling' geometry: each branch is one to four paper strips standing on their edge. Under the fixed oblique shear a
 * wall is plain 2D: the band between its top edge and the same line moved by -WALL_SHEAR * height. The top edge stays
 * on the layout line and the wall hangs below it, so a strip never runs through the label above its underline. Faces
 * are lit by their facing (baked into the vertex colour); the renderer adds the lit top edge and a little shade
 * toward the ground from `across` (0 at the foot of the wall, 1 on its top edge).
 */

/** Arrays a quilled branch is written into; `vp` and `ip` advance. */
export interface QuillSink {
  positions: Float64Array;
  rgba: Uint32Array;
  attribs: Int8Array;
  shadow: Int16Array;
  indices: Uint32Array;
  vp: number;
  ip: number;
}

/** Control points of the limb's cubic (see tessellate.ts curveOf). */
interface Cubic {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** World units between neighbouring strips of one branch. */
const STRIP_SPACING = 3.2;
/**
 * The scroll a leaf's strip ends in is drawn by the renderer's QUILL_FS on a small fan (SCROLL_RING corners round its
 * centre): a two-turn spiral wall, smooth at any zoom for 9 vertices. The fan carries the spiral's local coordinates
 * in nx, ny (in units of SCROLL_UNITS scroll radii, x mirrored for scrolls that curl left), the side in the sign of
 * the strength byte, and a negative across to tell it from a wall. Wall height relative to the radius: SCROLL_WALL.
 */
const SCROLL_RING = 8;
const SCROLL_UNITS = 2.5;
const SCROLL_WALL = 0.8;
/** Walls throw long shadows: as if the light were lower than for ribbons by this factor on the fall. */
const LONG = 1.6;
/** Loops round a root: gaps from the root box, wall heights, and steps per rounded corner. */
const RING_GAPS = [5, 9.5, 14];
const RING_HEIGHTS = [7, 6, 5];
const CORNER_STEPS = 6;
/** Facing light in the page plane (toward the upper left) and the in-plane direction the walls are seen from. */
const LX = -0.433, LY = -0.901;
const VX = -WALL_SHEAR.x, VY = -WALL_SHEAR.y;

/** Strips side by side for a branch of this width. */
export function quillStrips(s: BranchSpec): number {
  return Math.max(1, Math.min(3, Math.round(Math.max(s.w0, s.w1) / 3)));
}

const scrolls = (s: BranchSpec) => !!s.tipDot && s.tipDot.radius > 0;

/** Points of the branch's centre path: the limb's samples, its underline, and the scroll at a leaf tip. */
function pathLength(s: BranchSpec, n: number): number {
  return n + 1 + (s.underlineTo ? underlineSteps(s) : 0) + (scrolls(s) ? 1 : 0);
}

/** Vertices and indices of a quilled branch with `n` limb segments, its root loops included. */
export function quillCounts(s: BranchSpec, n: number): [number, number] {
  const p = pathLength(s, n), k = quillStrips(s);
  let nv = k * 2 * p, ni = k * (p - 1) * 6;
  if (scrolls(s)) {
    nv += 1 + SCROLL_RING;
    ni += 3 * SCROLL_RING;
  }
  if (s.ring) {
    const loops = Math.min(s.ring.colors.length, RING_GAPS.length), q = ringLength();
    nv += loops * 2 * q;
    ni += loops * (q - 1) * 6;
  }
  return [nv, ni];
}

const ringLength = () => 4 * (CORNER_STEPS + 1) + 2;

// Scratch path (grown on demand, reused across branches and builds): points, colour blend, and per point the unit
// normal and the face shade, shared by the strips of one branch.
let PX = new Float64Array(256), PY = new Float64Array(256), PT = new Float64Array(256);
let NX = new Float64Array(256), NY = new Float64Array(256), SH = new Float64Array(256);
function room(count: number): void {
  if (PX.length >= count) return;
  const size = Math.max(count, PX.length * 2);
  PX = new Float64Array(size);
  PY = new Float64Array(size);
  PT = new Float64Array(size);
  NX = new Float64Array(size);
  NY = new Float64Array(size);
  SH = new Float64Array(size);
}

/** Fill the scratch path; PT is the colour blend (0 at the start, 1 from the end of the limb on). */
function buildPath(s: BranchSpec, c: Cubic, n: number, elbow: number[][] | undefined): number {
  room(pathLength(s, n));
  const x0 = s.p0.x, y0 = s.p0.y, x3 = s.p1.x, y3 = s.p1.y;
  let m = 0;
  for (let j = 0; j <= n; j++) {
    const t = j / n, u = 1 - t;
    if (elbow) {
      PX[m] = elbow[j][0];
      PY[m] = elbow[j][1];
    } else {
      PX[m] = u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * x3;
      PY[m] = u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * y3;
    }
    PT[m++] = t;
  }
  if (s.underlineTo) {
    const ux = s.underlineTo.x - x3, uy = s.underlineTo.y - y3, rise = s.underlineBend ?? 0, steps = underlineSteps(s);
    for (let j = 1; j <= steps; j++) {
      const t = j / steps;
      PX[m] = x3 + ux * t;
      PY[m] = y3 + uy * t + (rise ? underlineOffset(t, rise) : 0);
      PT[m++] = 1;
    }
  }
  if (scrolls(s)) {
    // Run on to the bottom of the scroll, then curl up and outward, tightening.
    const ex = PX[m - 1], ey = PY[m - 1];
    const dot = s.tipDot!, r0 = dot.radius;
    const dx = s.underlineTo ? s.underlineTo.x - x3 : x3 - x0, dy = s.underlineTo ? s.underlineTo.y - y3 : y3 - y0;
    const length = Math.sqrt(dx * dx + dy * dy) || 1;
    const side = dx >= 0 ? 1 : -1;
    const bx = ex + dx / length * (dot.gap + r0), by = ey + dy / length * (dot.gap + r0);
    PX[m] = bx;
    PY[m] = by;
    PT[m++] = 1;
    // The spiral starts at the bottom of its circle, where the strip arrives.
    scrollX = bx;
    scrollY = by - r0;
    scrollR = r0;
    scrollSide = side;
  }
  return m;
}

let scrollX = 0, scrollY = 0, scrollR = 0, scrollSide = 1;

/** The fan the renderer draws the scroll on (see SCROLL_RING), in the strip's end colour. */
function scroll(sink: QuillSink, color: RGBA, strength: number): void {
  const { positions, rgba, attribs, shadow, indices } = sink;
  const r0 = scrollR, h = SCROLL_WALL * r0, side = scrollSide;
  const footX = -WALL_SHEAR.x * h, footY = -WALL_SHEAR.y * h;
  // Covers the spiral and its foot: centred between them, a little past both.
  const mx = scrollX + footX / 2, my = scrollY + footY / 2;
  const reach = (r0 + Math.sqrt(footX * footX + footY * footY) / 2 + 1) / Math.cos(Math.PI / SCROLL_RING);
  const fallX = Math.round((footX + SHADOW_FALL.x * LONG * h) * 128), fallY = Math.round((footY + SHADOW_FALL.y * LONG * h) * 128);
  const c32 = rgba8(color.r, color.g, color.b, color.a);
  const k = side * Math.max(1, Math.round(strength * 127));
  const scale = 127 / (SCROLL_UNITS * r0);
  const first = sink.vp;
  for (let i = 0; i <= SCROLL_RING; i++) {
    const angle = (i - 1) * 2 * Math.PI / SCROLL_RING;
    const x = i ? mx + reach * Math.cos(angle) : mx, y = i ? my + reach * Math.sin(angle) : my;
    const v = sink.vp++;
    positions[v * 2] = x;
    positions[v * 2 + 1] = y;
    rgba[v] = c32;
    const o = v * 4;
    attribs[o] = Math.round((x - scrollX) * side * scale);
    attribs[o + 1] = Math.round((y - scrollY) * scale);
    attribs[o + 2] = k;
    attribs[o + 3] = i ? -127 : -1;
    shadow[v * 2] = fallX;
    shadow[v * 2 + 1] = fallY;
  }
  let ip = sink.ip;
  for (let i = 1; i <= SCROLL_RING; i++) {
    indices[ip++] = first;
    indices[ip++] = first + i;
    indices[ip++] = first + (i % SCROLL_RING) + 1;
  }
  sink.ip = ip;
}

/**
 * Walls along the scratch path (`count` points), `strips` side by side, `h` high, blending `from` to `to` along PT.
 * Strips are written back to front, so the nearer one is drawn over the farther.
 */
function walls(sink: QuillSink, count: number, strips: number, h: number, from: RGBA, to: RGBA, strength: number): void {
  if (count < 2) return;
  const { positions, rgba, attribs, shadow, indices } = sink;
  // Foot of the wall relative to its top edge, and the top edge's shadow relative to the top edge (1/128 units).
  const footX = -WALL_SHEAR.x * h, footY = -WALL_SHEAR.y * h;
  const fallX = Math.round((footX + SHADOW_FALL.x * LONG * h) * 128), fallY = Math.round((footY + SHADOW_FALL.y * LONG * h) * 128);
  const k = Math.round(strength * 127);
  // Per point: the unit normal (left of the path) and the shade of the face we see there.
  let ptx = 1, pty = 0;
  for (let i = 0; i < count; i++) {
    const a = i > 0 ? i - 1 : i, b = i < count - 1 ? i + 1 : i;
    let tx = PX[b] - PX[a], ty = PY[b] - PY[a];
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl > 1e-9) {
      tx /= tl;
      ty /= tl;
    } else {
      tx = ptx;
      ty = pty;
    }
    ptx = tx;
    pty = ty;
    // Turn of the tangent per unit length: its direction is the concave side.
    let kx = 0, ky = 0, bend = 0;
    if (i > 0 && i < count - 1) {
      const ax = PX[i] - PX[a], ay = PY[i] - PY[a], bx = PX[b] - PX[i], by = PY[b] - PY[i];
      const la = Math.sqrt(ax * ax + ay * ay) || 1, lb = Math.sqrt(bx * bx + by * by) || 1;
      kx = bx / lb - ax / la;
      ky = by / lb - ay / la;
      bend = Math.sqrt(kx * kx + ky * ky) / (0.5 * (la + lb));
    }
    let nx = -ty, ny = tx;
    NX[i] = nx;
    NY[i] = ny;
    // The face we see is the one turned toward the viewer; light it by its facing, darker on the inside of a bend.
    if (nx * VX + ny * VY < 0) {
      nx = -nx;
      ny = -ny;
    }
    const weight = bend * 10 > 1 ? 1 : bend * 10;
    SH[i] = (0.86 + 0.22 * (nx * LX + ny * LY)) * (nx * kx + ny * ky > 0 ? 1 - 0.16 * weight : 1 + 0.05 * weight);
  }
  // A strip offset along +normal is nearer (lower on the page) when the normal's y is positive: draw it last.
  const order = NY[count >> 1] >= 0 ? 1 : -1;
  for (let jj = 0; jj < strips; jj++) {
    const j = order > 0 ? jj : strips - 1 - jj;
    const offset = (j - (strips - 1) / 2) * STRIP_SPACING;
    const tone = 1 + (j - (strips - 1) / 2) * 0.12;
    const base = sink.vp;
    for (let i = 0; i < count; i++) {
      const px = PX[i] + NX[i] * offset, py = PY[i] + NY[i] * offset;
      const shade = SH[i] * tone, t = PT[i];
      const a2 = from.a + (to.a - from.a) * t;
      const cr = (from.r + (to.r - from.r) * t) * shade, cg = (from.g + (to.g - from.g) * t) * shade;
      const cb = (from.b + (to.b - from.b) * t) * shade;
      const v = sink.vp;
      positions[v * 2] = px;
      positions[v * 2 + 1] = py;
      positions[v * 2 + 2] = px + footX;
      positions[v * 2 + 3] = py + footY;
      rgba[v] = rgba[v + 1] = rgba8(cr < a2 ? cr : a2, cg < a2 ? cg : a2, cb < a2 ? cb : a2, a2);
      const o = v * 4;
      attribs[o] = attribs[o + 1] = attribs[o + 4] = attribs[o + 5] = attribs[o + 7] = 0;
      attribs[o + 2] = attribs[o + 6] = k;
      attribs[o + 3] = 127;
      shadow[v * 2] = fallX;
      shadow[v * 2 + 1] = fallY;
      shadow[v * 2 + 2] = shadow[v * 2 + 3] = 0;
      sink.vp += 2;
    }
    let ip = sink.ip;
    for (let i = 0; i < count - 1; i++) {
      const q = base + i * 2;
      indices[ip++] = q;
      indices[ip++] = q + 1;
      indices[ip++] = q + 2;
      indices[ip++] = q + 1;
      indices[ip++] = q + 3;
      indices[ip++] = q + 2;
    }
    sink.ip = ip;
  }
}

/** A quilled branch: its root loops first (when it carries them), then its strips. */
export function emitQuill(sink: QuillSink, s: BranchSpec, c: Cubic, n: number, elbow: number[][] | undefined, end: RGBA,
  strength: number): void {
  if (s.ring) emitRing(sink, s.ring, strength);
  const count = buildPath(s, c, n, elbow);
  walls(sink, count, quillStrips(s), s.wall ?? 6, s.color, end, strength);
  if (scrolls(s)) scroll(sink, end, strength);
}

/** Nested loops round a root box: each a closed strip from its left middle over the top and back under the bottom. */
export function emitRing(sink: QuillSink, ring: NonNullable<BranchSpec['ring']>, strength: number): void {
  const loops = Math.min(ring.colors.length, RING_GAPS.length);
  room(ringLength());
  for (let l = 0; l < loops; l++) {
    const g = RING_GAPS[l];
    const x0 = ring.x - g, y0 = ring.y - g, x1 = ring.x + ring.w + g, y1 = ring.y + ring.h + g;
    const r = Math.min(ring.radius + g, (x1 - x0) / 2, (y1 - y0) / 2), cy = (y0 + y1) / 2;
    let m = 0;
    const put = (x: number, y: number) => {
      PX[m] = x;
      PY[m] = y;
      PT[m++] = 0;
    };
    const corner = (cx: number, cyy: number, from: number) => {
      for (let k = 0; k <= CORNER_STEPS; k++) {
        const angle = from + (k / CORNER_STEPS) * Math.PI / 2;
        put(cx + r * Math.cos(angle), cyy + r * Math.sin(angle));
      }
    };
    put(x0, cy);
    corner(x0 + r, y0 + r, Math.PI);
    corner(x1 - r, y0 + r, Math.PI * 1.5);
    corner(x1 - r, y1 - r, 0);
    corner(x0 + r, y1 - r, Math.PI / 2);
    put(x0, cy);
    walls(sink, m, 1, RING_HEIGHTS[l], ring.colors[l], ring.colors[l], strength);
  }
}

/** Wall height and shadow reach of a quilled branch, for level of detail. */
export function quillReach(s: BranchSpec): [height: number, reach: number] {
  const h = Math.max(s.wall ?? 6, s.ring ? RING_HEIGHTS[0] : 0);
  const fx = -WALL_SHEAR.x * h + SHADOW_FALL.x * LONG * h, fy = -WALL_SHEAR.y * h + SHADOW_FALL.y * LONG * h;
  return [h, Math.sqrt(fx * fx + fy * fy) + quillStrips(s) * STRIP_SPACING];
}
