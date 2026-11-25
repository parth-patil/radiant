import type { BranchSpec, Mesh, MeshRelief, NodeId } from '../types';
import { underlineSteps } from './underline';
import { rgba8, SHADOW_FALL, type ReliefOptions } from './relief';
import {
  CAP_STEPS, LAY, arcSteps, branchEndColor, branchLength, clayFall, claySpread, curveOf, plyCount, segmentCount, tipDotCenter
} from './tessellate';

/**
 * GPU-expanded branches. In place of a tessellated ribbon (66 to 100 vertices, kilobytes per branch) a branch is one
 * record (INSTANCE_WORDS 32-bit words for flat branches, RELIEF_WORDS for the 'clay' and 'rope' materials), and the
 * vertex shader (render/shaders.ts BRANCH_INSTANCE_VS) rebuilds the same triangles as `tessellateBatch` /
 * `reliefBatch` from it.
 *
 * A branch's geometry is one strip of points, each with a left and a right vertex, consecutive points making a quad.
 * Pieces, in this order: start cap, ribbon (n + 1 points), underline, rope whipping (2), end cap, tip dot. Flat caps
 * and dots are zig-zags over their arc points, (a_k, a_S-k), which cover the same polygon as tessellateBatch's fan from
 * the centre (the centre lies on the chord (a_0, a_S), which is exactly the ribbon's end pair): the start cap runs from
 * its apex into the ribbon, the end cap from the ribbon's (or underline's) end to its apex, with no break. Dimensional
 * caps and dots (FANS) keep the centre vertex, which carries the dome's shading: (centre, a_k) pairs, one fan triangle
 * and one empty one per quad. An underline whose first point is the ribbon's last (JOINED) continues the strip. Other
 * pieces start after two break points (the right vertex of the last point twice, then the left vertex of the next
 * first point twice), so the quads across the jump have no area. Inside one branch the order of pieces only matters
 * for the whipping, which must cover the limb's start, and it comes after the start cap and the ribbon as on the CPU.
 * The GPU draws the strip in chunks of INSTANCE_QUADS quads, one instance each, so the vertex work follows each
 * branch's own segment count and one instanced draw keeps the branches in order.
 *
 * Record words (f = float32 bits, u = uint32):
 *   0-3   f p0 x, y as float32 and the residuals x - fround(x), y - fround(y) (exact world position)
 *   4-9   f first and second control points and p1, relative to p0
 *   10-11 f w0, w1
 *   12-13 u start and end colour, premultiplied rgba8 (end = branchEndColor)
 *   14    u n | S << 8 | U << 16 | Se << 24 (U, Se 0 when absent)
 *   15    u D | flags << 8 (D 0 when absent; flags below)
 *   16-19 f unit tangent at the start and the end cap's direction
 *   20-23 f underline vector (underlineTo - p1), half width and rise
 *   24-27 f end cap radius, tip dot radius, tip dot centre relative to p0
 *   28-30 f 'organic': phase, frequency, amplitude of the width variation
 *   31    reserved
 * RELIEF_WORDS records add:
 *   32-33 f shadow strength of the ribbon and of the caps (as reliefBatch writes them, before the int8 conversion)
 *   34-37 f 'rope': twist at the start (turns), limb length, lay length, underline length
 *   38-41 f whipping centre relative to p0 and its unit direction
 *   42-43 f whipping half width and its far reach
 *   44    u whipping colour (rgba8)
 */
export const INSTANCE_WORDS = 32;
export const RELIEF_WORDS = 64;
/** Quads per GPU instance (chunk). */
export const INSTANCE_QUADS = 8;
/** RGBA32UI texels per row of the record texture (the WebGL 2 minimum texture size). */
export const RECORD_ROW_TEXELS = 2048;
/** Flags (record word 15 >> 8). */
export const STRAIGHT = 1;
export const JOINED = 2;
export const ORGANIC = 4;
export const ELBOW = 8;
export const ELBOW_V = 16;
/** Dimensional record: caps and dots as centre fans, lighting attributes. */
export const FANS = 32;
/** 'rope': a whipping where the parent's bundle divides. */
export const WHIP = 64;
/** Coarse level of detail (render LOD_ZOOM): ribbons and underlines keep every 8th point, fans every 2nd. */
export const COARSE_RIBBON = 8;
export const COARSE_FAN = 2;

/** Branches the GPU path draws: every flat style (tapered, rounded, line, organic, angular). */
export function gpuBranch(spec: BranchSpec): boolean {
  return spec.style === 'tapered' || spec.style === 'rounded' || spec.style === 'line' || spec.style === 'organic' ||
    spec.style === 'angular';
}

/** Dimensional materials the GPU path draws ('arcs' and 'quilling' keep the CPU mesh). */
export function gpuRelief(relief: ReliefOptions | undefined): boolean {
  return !relief || relief.material === 'clay' || relief.material === 'rope';
}

const ribbonSteps = (m: number, coarse: boolean) => coarse && m >= 2 ? Math.ceil(m / COARSE_RIBBON) : m;
const fanSteps = (m: number, coarse: boolean) => coarse && m >= 4 ? Math.ceil(m / COARSE_FAN) : m;
/** Corners of the tip dot's polygon: its first D - 1 triangles coarsen like a fan, the closing one stays (F4). */
const dotCorners = (m: number, coarse: boolean) => coarse && m - 1 >= 4 ? Math.ceil((m - 1) / COARSE_FAN) + 1 : m;

/**
 * Points of each piece of a record's strip (0 = absent) into `out`: start cap, ribbon, underline, whipping, end cap,
 * tip dot. Returns a bit mask of the pieces that start after two break points.
 */
export function piecePoints(u: Uint32Array, b: number, words: number, coarse: boolean, out: Int32Array): number {
  const counts = u[b * words + 14], more = u[b * words + 15];
  const n = counts & 255, S = (counts >>> 8) & 255, U = (counts >>> 16) & 255, Se = counts >>> 24, D = more & 255;
  const flags = more >>> 8, fans = (flags & FANS) !== 0, joined = (flags & JOINED) !== 0;
  const S2 = fanSteps(S, coarse), Se2 = fanSteps(Se, coarse), m = dotCorners(D, coarse);
  out[0] = fans ? S2 + 1 : S2 >> 1;
  out[1] = ribbonSteps(n, coarse) + 1;
  out[2] = U ? ribbonSteps(U, coarse) + (joined ? 0 : 1) : 0;
  out[3] = flags & WHIP ? 2 : 0;
  out[4] = Se ? (fans ? Se2 + 1 : Se2 >> 1) : 0;
  out[5] = D ? (fans ? m + 1 : (m >> 1) + 1) : 0;
  return (fans ? 2 | 16 : 0) | (U && !joined ? 4 : 0) | 8 | 32;
}

const scratch = new Int32Array(6);
/** Quads in a record's strip. */
export function stripQuads(u: Uint32Array, b: number, words: number, coarse: boolean): number {
  const breaks = piecePoints(u, b, words, coarse, scratch);
  let points = 0;
  for (let k = 0; k < 6; k++) if (scratch[k]) points += scratch[k] + (breaks & 1 << k ? 2 : 0);
  return points - 1;
}

/** GPU instances (chunks of INSTANCE_QUADS quads) of a record. */
export const stripChunks = (u: Uint32Array, b: number, words: number, coarse: boolean) =>
  Math.ceil(stripQuads(u, b, words, coarse) / INSTANCE_QUADS);

/**
 * Records for `specs` (all `gpuBranch`, flat or of a `gpuRelief` material), sampled for viewing at `zoom` exactly as
 * tessellateBatch / reliefBatch would, with conservative bounds (control polygon, caps, underline, dot and, for a
 * material, its shadow's reach) for culling and picking.
 */
export function buildBranchInstances(specs: BranchSpec[], zoom: number, relief?: ReliefOptions): Mesh {
  const count = specs.length;
  const words = relief ? RELIEF_WORDS : INSTANCE_WORDS;
  const perRow = RECORD_ROW_TEXELS * 4 / words;
  const u = new Uint32Array(Math.max(1, Math.ceil(count / perRow)) * perRow * words);
  const f = new Float32Array(u.buffer);
  const bounds = new Float64Array(count * 4);
  const ends = new Uint32Array(count);
  const ids = new Array<NodeId>(count);
  const rope = relief?.material === 'rope';
  let chunks = 0, maxWidth = 0, shadowReach = 0;
  for (let i = 0; i < count; i++) {
    const s = specs[i];
    ids[i] = s.to;
    const c = curveOf(s);
    const n = segmentCount(s, 1, zoom, c);
    const o = i * words;
    const x0 = s.p0.x, y0 = s.p0.y, x3 = s.p1.x, y3 = s.p1.y;
    const hx = Math.fround(x0), hy = Math.fround(y0);
    f[o] = hx;
    f[o + 1] = hy;
    f[o + 2] = x0 - hx;
    f[o + 3] = y0 - hy;
    f[o + 4] = c.x1 - x0;
    f[o + 5] = c.y1 - y0;
    f[o + 6] = c.x2 - x0;
    f[o + 7] = c.y2 - y0;
    f[o + 8] = x3 - x0;
    f[o + 9] = y3 - y0;
    f[o + 10] = s.w0;
    f[o + 11] = s.w1;
    const end = branchEndColor(s);
    u[o + 12] = rgba8(s.color.r, s.color.g, s.color.b, s.color.a);
    u[o + 13] = rgba8(end.r, end.g, end.b, end.a);
    const S = s.roundCaps ? arcSteps(Math.PI, s.w0 * 0.5, zoom, CAP_STEPS, 16) : CAP_STEPS;
    const U = s.underlineTo ? underlineSteps(s) : 0;
    const endRadius = (s.underlineTo ? s.underlineWidth ?? s.w1 : s.w1) * 0.5;
    const Se = s.roundCaps === 'both' ? arcSteps(Math.PI, endRadius, zoom, CAP_STEPS, 16) : 0;
    const D = s.tipDot ? arcSteps(2 * Math.PI, s.tipDot.radius, zoom, 8, 32) : 0;
    u[o + 14] = (n | S << 8 | U << 16 | Se << 24) >>> 0;
    let flags = (n === 1 ? STRAIGHT : 0) | (relief ? FANS : 0);
    const elbow = s.style === 'angular' && n === 3;
    if (elbow) flags |= ELBOW | (s.flow === 'v' ? ELBOW_V : 0);
    if (c.amp) {
      flags |= ORGANIC;
      f[o + 28] = c.phase;
      f[o + 29] = c.freq;
      f[o + 30] = c.amp;
    }
    // Unit tangents at both ends, as tessellateBatch finds them (the chord for one segment, else the derivative).
    const dx = x3 - x0, dy = y3 - y0;
    let sx = n === 1 ? dx : 3 * (c.x1 - x0), sy = n === 1 ? dy : 3 * (c.y1 - y0);
    let ex = n === 1 ? dx : 3 * (x3 - c.x2), ey = n === 1 ? dy : 3 * (y3 - c.y2);
    if (elbow) {
      // The elbow's first and last legs: along the main axis of the flow.
      const v = s.flow === 'v';
      sx = ex = v ? 0 : Math.sign(dx);
      sy = ey = v ? Math.sign(dy) : 0;
    }
    [sx, sy] = unit(sx, sy, dx, dy);
    [ex, ey] = unit(ex, ey, dx, dy);
    f[o + 16] = sx;
    f[o + 17] = sy;
    let ux = 0, uy = 0;
    const uhw = (s.underlineWidth ?? s.w1) * 0.5, rise = s.underlineBend ?? 0;
    if (s.underlineTo) {
      ux = s.underlineTo.x - x3;
      uy = s.underlineTo.y - y3;
      const length = Math.hypot(ux, uy);
      // The underline's first edge offset (its slope at t = 0 is uy) against the ribbon's last one.
      const ul = length || 1;
      const ox = -uy * uhw / ul - -ey * s.w1 * 0.5, oy = ux * uhw / ul - ex * s.w1 * 0.5;
      if (Math.abs(ox) < 1e-6 * (1 + uhw) && Math.abs(oy) < 1e-6 * (1 + uhw)) flags |= JOINED;
      if (length > 1e-9) {
        ex = ux / length;
        ey = uy / length;
      }
    }
    f[o + 18] = ex;
    f[o + 19] = ey;
    f[o + 20] = ux;
    f[o + 21] = uy;
    f[o + 22] = uhw;
    f[o + 23] = rise;
    f[o + 24] = endRadius;
    const dot = tipDotCenter(s);
    const dotRadius = s.tipDot?.radius ?? 0;
    f[o + 25] = dotRadius;
    f[o + 26] = dot ? dot.x - x0 : 0;
    f[o + 27] = dot ? dot.y - y0 : 0;
    let reach = 0;
    if (relief) {
      // As reliefBatch: strengths (rope: 1/15 steps with the ply count above them), twist, whipping, shadow reach.
      const kd = s.color.a * (s.dim ?? 1);
      let ribK = kd, capK = kd;
      if (rope) {
        const q = Math.round(Math.min(1, kd) * 15);
        capK = (q + 0.5) / 127;
        ribK = ((q | plyCount(s) << 4) + 0.5) / 127;
      }
      f[o + 32] = ribK;
      f[o + 33] = capK;
      f[o + 36] = 1;
      if (rope) {
        f[o + 34] = s.twist ?? 0;
        f[o + 35] = branchLength(s, c);
        f[o + 36] = LAY * Math.max(s.w0, s.w1, 1);
        f[o + 37] = s.underlineTo ? Math.hypot(ux, uy) : 0;
        if (s.whip) {
          flags |= WHIP;
          f[o + 38] = s.whip.x - x0;
          f[o + 39] = s.whip.y - y0;
          f[o + 40] = s.whip.dx;
          f[o + 41] = s.whip.dy;
          f[o + 42] = s.whip.width * 0.58 + 0.4;
          f[o + 43] = Math.max(2.2, s.whip.width * 0.5 + 0.8);
          u[o + 44] = rgba8(end.r * 0.14 + 0.8 * end.a, end.g * 0.14 + 0.77 * end.a, end.b * 0.14 + 0.7 * end.a, end.a);
        }
      }
      const rhw = 0.5 * Math.max(s.w0, s.w1, s.underlineWidth ?? 0, 2 * (s.tipDot?.radius ?? 0));
      maxWidth = Math.max(maxWidth, 2 * rhw);
      reach = Math.hypot(SHADOW_FALL.x, SHADOW_FALL.y) * clayFall(rhw) + claySpread(rhw);
      shadowReach = Math.max(shadowReach, reach);
    }
    u[o + 15] = D | flags << 8;

    const hw = Math.max(s.w0, s.w1) * 0.5 * (1 + c.amp);
    let minX = Math.min(x0, c.x1, c.x2, x3) - hw, maxX = Math.max(x0, c.x1, c.x2, x3) + hw;
    let minY = Math.min(y0, c.y1, c.y2, y3) - hw, maxY = Math.max(y0, c.y1, c.y2, y3) + hw;
    if (s.underlineTo) {
      const m = uhw + Math.abs(rise);
      minX = Math.min(minX, x3 - m, s.underlineTo.x - m - endRadius);
      maxX = Math.max(maxX, x3 + m, s.underlineTo.x + m + endRadius);
      minY = Math.min(minY, y3 - m, s.underlineTo.y - m - endRadius);
      maxY = Math.max(maxY, y3 + m, s.underlineTo.y + m + endRadius);
    } else if (Se) {
      minX = Math.min(minX, x3 - endRadius);
      maxX = Math.max(maxX, x3 + endRadius);
      minY = Math.min(minY, y3 - endRadius);
      maxY = Math.max(maxY, y3 + endRadius);
    }
    if (dot) {
      minX = Math.min(minX, dot.x - dotRadius);
      maxX = Math.max(maxX, dot.x + dotRadius);
      minY = Math.min(minY, dot.y - dotRadius);
      maxY = Math.max(maxY, dot.y + dotRadius);
    }
    if (flags & WHIP) {
      const m = Math.max(7, f[o + 43]) + f[o + 42];
      minX = Math.min(minX, s.whip!.x - m);
      maxX = Math.max(maxX, s.whip!.x + m);
      minY = Math.min(minY, s.whip!.y - m);
      maxY = Math.max(maxY, s.whip!.y + m);
    }
    // A dimensional branch's shadow falls down and to the right, within its reach (as reliefBatch's bounds).
    bounds[i * 4] = minX - reach * 0.4;
    bounds[i * 4 + 1] = minY - reach * 0.4;
    bounds[i * 4 + 2] = maxX + reach;
    bounds[i * 4 + 3] = maxY + reach;
    chunks += stripChunks(u, i, words, false);
    ends[i] = chunks;
  }
  const mesh: Mesh = {
    positions: new Float64Array(0), colors: new Float32Array(0), indices: new Uint32Array(0),
    instances: { records: u, count, words }, branchSpans: { ids, bounds, ends }
  };
  if (relief) {
    const data: MeshRelief = {
      material: relief.material, rgba: new Uint32Array(0), attribs: new Int8Array(0), shadowColor: relief.shadowColor,
      maxWidth, shadowReach
    };
    if (relief.shadowColor.a > 0) data.shadow = new Int16Array(0);
    if (rope) data.twist = new Float32Array(0);
    mesh.relief = data;
  }
  return mesh;
}

/** (x, y) normalised; a vanishing vector falls back to the chord (dx, dy), then to +x, as tessellateBatch does. */
function unit(x: number, y: number, dx: number, dy: number): [number, number] {
  let l = Math.sqrt(x * x + y * y);
  if (l < 1e-6) {
    x = dx;
    y = dy;
    l = Math.sqrt(x * x + y * y);
    if (l < 1e-6) return [1, 0];
  }
  return [x / l, y / l];
}

/** One vertex: world position, colour (rgba8), and for a dimensional record its lighting as the CPU mesh stores it. */
export interface InstanceVertex {
  x: number;
  y: number;
  rgba: number;
  /** nx, ny, strength, across (as written before the int8 conversion), shadow offset, twist. */
  nx: number; ny: number; k: number; across: number; sx: number; sy: number; twist: number;
}

/**
 * The strip of record `b`, left and right vertex per point, mirroring BRANCH_INSTANCE_VS (in double precision). For
 * picking, and to check the shader's maths against tessellateBatch and reliefBatch.
 */
export function instanceVertices(records: Uint32Array, b: number, words: number, coarse = false): InstanceVertex[] {
  const u = records, f = new Float32Array(records.buffer, records.byteOffset, records.length);
  const o = b * words;
  const counts = u[o + 14], more = u[o + 15];
  const n = counts & 255, S = (counts >>> 8) & 255, U = (counts >>> 16) & 255, Se = counts >>> 24, D = more & 255;
  const flags = more >>> 8;
  const straight = (flags & STRAIGHT) !== 0, joined = (flags & JOINED) !== 0, elbow = (flags & ELBOW) !== 0;
  const organic = (flags & ORGANIC) !== 0, fans = (flags & FANS) !== 0;
  const p0x = f[o] + f[o + 2], p0y = f[o + 1] + f[o + 3];
  const c1x = f[o + 4], c1y = f[o + 5], c2x = f[o + 6], c2y = f[o + 7], p1x = f[o + 8], p1y = f[o + 9];
  const w0 = f[o + 10], w1 = f[o + 11], colA = u[o + 12], colB = u[o + 13];
  const t0x = f[o + 16], t0y = f[o + 17], tex = f[o + 18], tey = f[o + 19];
  const ux = f[o + 20], uy = f[o + 21], uhw = f[o + 22], rise = f[o + 23];
  const endR = f[o + 24], dotR = f[o + 25], dcx = f[o + 26], dcy = f[o + 27];
  const phase = f[o + 28], freq = f[o + 29], amp = f[o + 30];
  const ribK = fans ? f[o + 32] : 0, capK = fans ? f[o + 33] : 0;
  const turn0 = fans ? f[o + 34] : 0, limb = fans ? f[o + 35] : 0, lay = fans ? f[o + 36] : 1, span = fans ? f[o + 37] : 0;
  const turnEnd = turn0 + (limb + span) / lay;
  const corners = elbow ? (flags & ELBOW_V
    ? [[0, 0], [0, p1y * 0.5], [p1x, p1y * 0.5], [p1x, p1y]]
    : [[0, 0], [p1x * 0.5, 0], [p1x * 0.5, p1y], [p1x, p1y]]) : [];
  const pts = new Int32Array(6);
  const breaks = piecePoints(u, b, words, coarse, pts);
  const S2 = fanSteps(S, coarse), Se2 = fanSteps(Se, coarse), m = dotCorners(D, coarse);
  const lerp8 = (t: number) => {
    let w = 0;
    for (let s = 0; s < 32; s += 8) {
      const a = (colA >>> s) & 255, z = (colB >>> s) & 255;
      w |= Math.round(a + (z - a) * t) << s;
    }
    return w >>> 0;
  };
  type V = InstanceVertex;
  const vtx = (x: number, y: number, rgba: number, nx = 0, ny = 0, k = 0, across = 0, sx = 0, sy = 0, twist = 0): V =>
    ({ x: p0x + x, y: p0y + y, rgba, nx, ny, k, across, sx, sy, twist });
  // Lit edge pair of a ribbon-like point at (px, py), unit normal (mx, my), half width hw (shadow fall and spread from it).
  const edges = (px: number, py: number, mx: number, my: number, hw: number, rgba: number, k: number, twist: number): [V, V] => {
    const fl = clayFall(hw), sp = claySpread(hw), fx = SHADOW_FALL.x * fl, fy = SHADOW_FALL.y * fl;
    return [vtx(px + mx * hw, py + my * hw, rgba, mx, my, k, 1, fx + mx * sp, fy + my * sp, twist),
      vtx(px - mx * hw, py - my * hw, rgba, -mx, -my, k, -1, fx - mx * sp, fy - my * sp, twist)];
  };
  const ribbon = (i: number): [V, V] => {
    const j = coarse && n >= 2 ? Math.min(COARSE_RIBBON * i, n) : i;
    const t = j / n, v = 1 - t;
    let px = 3 * v * v * t * c1x + 3 * v * t * t * c2x + t * t * t * p1x;
    let py = 3 * v * v * t * c1y + 3 * v * t * t * c2y + t * t * t * p1y;
    let tx = straight ? p1x : 3 * (v * v * c1x + 2 * v * t * (c2x - c1x) + t * t * (p1x - c2x));
    let ty = straight ? p1y : 3 * (v * v * c1y + 2 * v * t * (c2y - c1y) + t * t * (p1y - c2y));
    let join = 1;
    if (elbow) {
      // As tessellateBatch: the polyline's corners, tangents from the signs of both legs, mitred inner corners.
      [px, py] = corners[j];
      const a = corners[Math.max(0, j - 1)], c = corners[Math.min(3, j + 1)];
      tx = Math.sign(px - a[0]) + Math.sign(c[0] - px);
      ty = Math.sign(py - a[1]) + Math.sign(c[1] - py);
      if (j > 0 && j < 3) join = Math.SQRT2;
    }
    [tx, ty] = unit(tx, ty, p1x, p1y);
    let w = w0 + (w1 - w0) * t;
    if (organic) w *= 1 + amp * Math.sin(Math.PI * t) * Math.sin(freq * 2 * Math.PI * t + phase);
    return edges(px, py, -ty, tx, w * 0.5 * join, lerp8(t), ribK, turn0 + t * limb / lay);
  };
  const underline = (i: number): [V, V] => {
    const j = coarse && U >= 2 ? Math.min(COARSE_RIBBON * i, U) : i;
    const t = j / U;
    const x = p1x + ux * t;
    const y = p1y + uy * t + (rise ? (Math.cos(2 * Math.PI * t) - 1) * rise / 2 : 0);
    const dyBar = uy + (rise ? -Math.PI * rise * Math.sin(2 * Math.PI * t) : 0);
    const len = Math.hypot(ux, dyBar) || 1;
    return edges(x, y, -dyBar / len, ux / len, uhw, colB, ribK, turn0 + (limb + span * t) / lay);
  };
  // Arc point q (coarse step space) of the start or end cap: from +normal through -tangent (start) or +tangent (end).
  const capAt = (start: boolean, q: number): V => {
    const steps = start ? S : Se;
    const k = coarse && steps >= 4 ? Math.min(COARSE_FAN * q, steps) : q;
    const cx = start ? 0 : p1x + ux, cy = start ? 0 : p1y + uy;
    const [tx, ty] = start ? [t0x, t0y] : [tex, tey];
    const bx = start ? -tx : tx, by = start ? -ty : ty;
    const r = start ? w0 * 0.5 : endR;
    const a = Math.PI * k / steps, co = Math.cos(a), sn = Math.sin(a);
    const mx = co * -ty + sn * bx, my = co * tx + sn * by;
    const fl = clayFall(r), sp = claySpread(r);
    return vtx(cx + mx * r, cy + my * r, start ? colA : colB, mx, my, capK, 1,
      SHADOW_FALL.x * fl + mx * sp, SHADOW_FALL.y * fl + my * sp, start ? turn0 : turnEnd);
  };
  const capCentre = (start: boolean): V => {
    const r = start ? w0 * 0.5 : endR, fl = clayFall(r);
    return vtx(start ? 0 : p1x + ux, start ? 0 : p1y + uy, start ? colA : colB, 0, 0, capK, 0,
      SHADOW_FALL.x * fl, SHADOW_FALL.y * fl, start ? turn0 : turnEnd);
  };
  const cornerAt = (q: number): V => {
    const k = coarse && D - 1 >= 4 ? Math.min(COARSE_FAN * q, D - 1) : q;
    const a = 2 * Math.PI * (k % D) / D, mx = Math.cos(a), my = Math.sin(a);
    const fl = clayFall(dotR), sp = claySpread(dotR);
    return vtx(dcx + mx * dotR, dcy + my * dotR, colB, mx, my, capK, 1,
      SHADOW_FALL.x * fl + mx * sp, SHADOW_FALL.y * fl + my * sp, turnEnd);
  };
  const dotCentre = (): V => {
    const fl = clayFall(dotR);
    return vtx(dcx, dcy, colB, 0, 0, capK, 0, SHADOW_FALL.x * fl, SHADOW_FALL.y * fl, turnEnd);
  };
  const whip = (e: number): [V, V] => {
    const wx = f[o + 38], wy = f[o + 39], tx = f[o + 40], ty = f[o + 41], hw = f[o + 42];
    const reach = e ? f[o + 43] : -7;
    const cx = wx + tx * reach, cy = wy + ty * reach;
    const k = ((7 << 4) + 0.5) / 127, cream = u[o + 44];
    return [vtx(cx - ty * hw, cy + tx * hw, cream, -ty, tx, k, 1, 0, 0, e), vtx(cx + ty * hw, cy - tx * hw, cream, ty, -tx, k, -1, 0, 0, e)];
  };
  const point = (kind: number, idx: number): [V, V] => {
    switch (kind) {
      case 0: return fans ? [capCentre(true), capAt(true, idx)] : [capAt(true, pts[0] - idx), capAt(true, S2 - (pts[0] - idx))];
      case 1: return ribbon(idx);
      case 2: return underline(joined ? idx + 1 : idx);
      case 3: return whip(idx);
      case 4: return fans ? [capCentre(false), capAt(false, idx)] : [capAt(false, idx + 1), capAt(false, Se2 - idx - 1)];
      default: return fans ? [dotCentre(), cornerAt(idx === m ? 0 : idx)] : [cornerAt(idx), cornerAt(idx ? m - idx : 0)];
    }
  };
  const out: V[] = [];
  let previous = -1;
  for (let kind = 0; kind < 6; kind++) {
    if (!pts[kind]) continue;
    if (breaks & 1 << kind && previous >= 0) {
      const right = point(previous, pts[previous] - 1)[1], left = point(kind, 0)[0];
      out.push(right, right, left, left);
    }
    for (let i = 0; i < pts[kind]; i++) out.push(...point(kind, i));
    previous = kind;
  }
  return out;
}

/** World positions of a record's strip, left and right vertex per point (x, y, x, y): for picking. */
export function instanceStrip(records: Uint32Array, b: number, words: number, coarse = false): Float64Array {
  const vertices = instanceVertices(records, b, words, coarse);
  const out = new Float64Array(vertices.length * 2);
  vertices.forEach((v, i) => {
    out[2 * i] = v.x;
    out[2 * i + 1] = v.y;
  });
  return out;
}
