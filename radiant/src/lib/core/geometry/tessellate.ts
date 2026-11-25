import type { BranchSpec, Mesh, MeshRelief, RGBA } from '../types';
import { underlineOffset, underlineSlope, underlineSteps } from './underline';
import { LIFT_SHEAR, SHADOW_FALL, rgba8, sameRelief, type ReliefOptions } from './relief';
import { quillCounts, quillReach, emitQuill, type QuillSink } from './quill';
import { buildBranchInstances, gpuBranch, gpuRelief } from './branch-instances';

/** Round start cap: half-disk fan with this many triangles. */
export const CAP_STEPS = 4;
const CAP_VERTS = CAP_STEPS + 2; // centre + (steps + 1) arc points
const CAP_INDICES = CAP_STEPS * 3;
const arc = (steps: number, turn: number) => Array.from({ length: steps + 1 }, (_, k) => {
  const angle = turn * k / steps;
  return { cos: Math.cos(angle), sin: Math.sin(angle) };
});
const CAP_ARC = arc(CAP_STEPS, Math.PI);
/** Half-disk (cap) and full-disk (tip dot) fans by step count. */
const ARCS = new Map<number, { cos: number; sin: number }[]>([[CAP_STEPS * 2, CAP_ARC]]);
function arcOf(steps: number, full: boolean) {
  const key = steps * 2 + (full ? 1 : 0);
  let found = ARCS.get(key);
  if (!found) ARCS.set(key, found = arc(steps, full ? 2 * Math.PI : Math.PI));
  return found;
}

/**
 * Fan steps for an arc of `turn` radians and the given radius whose chord error stays within `MAX_CHORD_ERROR`
 * screen px at `zoom`, clamped to `min`..`max`. Used for caps of a spec with `roundCaps` and for tip dots.
 */
export function arcSteps(turn: number, radius: number, zoom: number, min: number, max: number): number {
  const e = MAX_CHORD_ERROR / (zoom * Math.max(radius, 1e-6));
  const steps = e >= 1 ? 1 : Math.ceil(turn / (2 * Math.acos(1 - e)));
  return steps < min ? min : steps > max ? max : steps;
}

/**
 * Premultiplied colour at the far end of a branch: `color`, or with `fade` the blend toward `fade.toward` at the
 * spec colour's alpha. The underline, end cap and tip dot use it; the limb blends from `color` to it along t.
 */
export function branchEndColor(spec: BranchSpec): RGBA {
  const { color: c, fade } = spec;
  if (!fade) return c;
  const f = fade.amount < 0 ? 0 : fade.amount > 1 ? 1 : fade.amount;
  return {
    r: c.r + (fade.toward.r * c.a - c.r) * f, g: c.g + (fade.toward.g * c.a - c.g) * f,
    b: c.b + (fade.toward.b * c.a - c.b) * f, a: c.a
  };
}

/** Centre of a spec's tip dot (see `BranchSpec.tipDot`), or undefined when it has none. */
export function tipDotCenter(spec: BranchSpec): { x: number; y: number } | undefined {
  const dot = spec.tipDot;
  if (!dot) return;
  const end = spec.underlineTo;
  if (!end) return { x: spec.p1.x, y: spec.p1.y };
  const dx = end.x - spec.p1.x, dy = end.y - spec.p1.y;
  const length = Math.hypot(dx, dy);
  const ux = length > 1e-9 ? dx / length : spec.p1.x >= spec.p0.x ? 1 : -1, uy = length > 1e-9 ? dy / length : 0;
  return { x: end.x + ux * (dot.gap + dot.radius), y: end.y + uy * (dot.gap + dot.radius) };
}

interface BranchBatch {
  specs: BranchSpec[];
  mesh: Mesh;
  starts: Uint32Array;
}

function sameSpec(a: BranchSpec, b: BranchSpec): boolean {
  return a.from === b.from && a.style === b.style && a.flow === b.flow && a.seed === b.seed &&
    a.w0 === b.w0 && a.w1 === b.w1 && a.p0.x === b.p0.x && a.p0.y === b.p0.y &&
    a.p1.x === b.p1.x && a.p1.y === b.p1.y &&
    a.color.r === b.color.r && a.color.g === b.color.g && a.color.b === b.color.b && a.color.a === b.color.a &&
    a.underlineTo?.x === b.underlineTo?.x && a.underlineTo?.y === b.underlineTo?.y &&
    a.underlineWidth === b.underlineWidth && a.underlineBend === b.underlineBend &&
    a.roundCaps === b.roundCaps && a.startTangent?.x === b.startTangent?.x && a.startTangent?.y === b.startTangent?.y &&
    a.fade?.amount === b.fade?.amount && a.fade?.toward.r === b.fade?.toward.r && a.fade?.toward.g === b.fade?.toward.g &&
    a.fade?.toward.b === b.fade?.toward.b && a.tipDot?.radius === b.tipDot?.radius && a.tipDot?.gap === b.tipDot?.gap &&
    a.lift === b.lift && a.startPlug === b.startPlug && a.dim === b.dim && a.wall === b.wall && a.twist === b.twist && sameRing(a.ring, b.ring) &&
    a.whip?.x === b.whip?.x && a.whip?.y === b.whip?.y && a.whip?.dx === b.whip?.dx && a.whip?.dy === b.whip?.dy &&
    a.whip?.width === b.whip?.width;
}

function sameRing(a: BranchSpec['ring'], b: BranchSpec['ring']): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.radius === b.radius &&
    a.colors.length === b.colors.length && a.colors.every((c, i) => c.r === b.colors[i].r && c.g === b.colors[i].g &&
      c.b === b.colors[i].b && c.a === b.colors[i].a);
}

export class BranchMeshCache {
  private batch?: BranchBatch;
  private edges = new Map<string, number>();
  private stems = new Map<string, number>();
  private relief?: ReliefOptions;
  lastRebuilt = 0;

  /** `relief`: dimensional material (see core/geometry/relief.ts); absent = flat branches. */
  build(specs: BranchSpec[], relief?: ReliefOptions): Mesh {
    if (gpuRelief(relief) && specs.length && specs.every(gpuBranch)) {
      // Flat, 'clay' and 'rope' branches are expanded on the GPU: a record per branch, nothing to reuse.
      this.batch = undefined;
      this.relief = undefined;
      this.edges = new Map();
      this.stems = new Map();
      this.lastRebuilt = specs.length;
      return buildBranchInstances(specs, MESH_DETAIL_ZOOM, relief);
    }
    // Geometry of another material cannot be reused.
    const previous = sameRelief(relief, this.relief) ? this.batch : undefined;
    this.relief = relief;
    const nextEdges = new Map<string, number>();
    const nextStems = new Map<string, number>();
    const starts = new Uint32Array(specs.length + 1);
    const build: BranchCacheBuild = {
      batch: previous,
      starts,
      reused: 0,
      find: (spec, index) => {
        // A picture branch can also have a separate stem after its underline.
        const stem = nextEdges.has(spec.to);
        (stem ? nextStems : nextEdges).set(spec.to, index);
        const cached = (stem ? this.stems : this.edges).get(spec.to);
        if (cached === undefined || !previous || !sameSpec(previous.specs[cached], spec)) return undefined;
        return cached;
      }
    };
    const mesh = relief ? reliefBatch(specs, MESH_DETAIL_ZOOM, relief, build) : tessellateBatch(specs, MESH_DETAIL_ZOOM, build);
    starts[specs.length] = mesh.positions.length / 2;
    this.batch = { specs, mesh, starts };
    this.edges = nextEdges;
    this.stems = nextStems;
    this.lastRebuilt = specs.length - build.reused;
    return mesh;
  }
}

interface BranchCacheBuild {
  batch?: BranchBatch;
  starts: Uint32Array;
  find: (spec: BranchSpec, index: number) => number | undefined;
  /** Branches copied from `batch`. */
  reused: number;
}

type VertexArray = Float64Array | Float32Array | Uint32Array | Int8Array | Int16Array;
/** A per-vertex array of the previous batch, its counterpart in the batch being built, and its values per vertex. */
type Lane = [from: VertexArray, to: VertexArray, width: number];

/**
 * Copy branches `c0`..`c1` (exclusive) of the previous batch to branch `at` onward of the new one, whose next free
 * vertex and index are `vp` and `ip`: one bulk copy per array, indices moved by the change of vertex offset.
 * Returns the next free index.
 */
function reuseRun(batch: BranchBatch, starts: Uint32Array, c0: number, c1: number, at: number, vp: number, ip: number,
  lanes: Lane[], indices: Uint32Array, bounds: Float64Array, ends: Uint32Array): number {
  const previous = batch.mesh, spans = previous.branchSpans!;
  const v0 = batch.starts[c0], v1 = batch.starts[c1];
  const i0 = c0 ? spans.ends[c0 - 1] : 0, i1 = spans.ends[c1 - 1];
  for (const [from, to, width] of lanes) to.set(from.subarray(v0 * width, v1 * width), vp * width);
  const delta = vp - v0;
  if (delta === 0) indices.set(previous.indices.subarray(i0, i1), ip);
  else {
    const source = previous.indices;
    for (let j = i0, k = ip; j < i1; j++, k++) indices[k] = source[j] + delta;
  }
  bounds.set(spans.bounds.subarray(c0 * 4, c1 * 4), at * 4);
  const shift = ip - i0;
  for (let c = c0, k = at; c < c1; c++, k++) {
    starts[k] = batch.starts[c] + delta;
    ends[k] = spans.ends[c] + shift;
  }
  return ip + i1 - i0;
}

/** mulberry32 PRNG returning [0,1). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inner control points of a branch's cubic and the 'organic' width variation (amp 0 = none). */
export interface Curve {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  phase: number;
  freq: number;
  amp: number;
}

/**
 * Control points: horizontal tangents for 'h' (vertical for 'v') at distance max(half the main-axis span, 6),
 * the start one along `startTangent` when given, thirds of the chord for 'r'. 'organic' adds a deterministic seeded
 * wobble to both and a low-frequency width variation.
 */
export function curveOf(s: BranchSpec): Curve {
  const x0 = s.p0.x,
    y0 = s.p0.y,
    x3 = s.p1.x,
    y3 = s.p1.y;
  const dx = x3 - x0,
    dy = y3 - y0;
  const chord = Math.sqrt(dx * dx + dy * dy);
  let x1: number, y1: number, x2: number, y2: number;
  if (s.flow === 'h') {
    const sg = dx >= 0 ? 1 : -1;
    const k = Math.max(0.5 * Math.abs(dx), 6);
    x1 = x0 + sg * k;
    y1 = y0;
    x2 = x3 - sg * k;
    y2 = y3;
    if (s.startTangent) {
      x1 = x0 + s.startTangent.x * k;
      y1 = y0 + s.startTangent.y * k;
    }
  } else if (s.flow === 'v') {
    const sg = dy >= 0 ? 1 : -1;
    const k = Math.max(0.5 * Math.abs(dy), 6);
    x1 = x0;
    y1 = y0 + sg * k;
    x2 = x3;
    y2 = y3 - sg * k;
    if (s.startTangent) {
      x1 = x0 + s.startTangent.x * k;
      y1 = y0 + s.startTangent.y * k;
    }
  } else {
    x1 = x0 + dx / 3;
    y1 = y0 + dy / 3;
    x2 = x0 + (2 * dx) / 3;
    y2 = y0 + (2 * dy) / 3;
  }
  let phase = 0,
    freq = 0,
    amp = 0;
  if (s.style === 'organic') {
    const rand = rng(s.seed);
    const inv = chord > 1e-6 ? 1 / chord : 0;
    const nx = -dy * inv,
      ny = dx * inv;
    const maxAmp = Math.min(0.1 * chord, 22);
    const o1 = (rand() * 2 - 1) * maxAmp;
    const o2 = (rand() * 2 - 1) * maxAmp;
    x1 += nx * o1;
    y1 += ny * o1;
    x2 += nx * o2;
    y2 += ny * o2;
    phase = rand() * Math.PI * 2;
    freq = 1.2 + rand() * 1.6;
    amp = 0.14;
  }
  return { x1, y1, x2, y2, phase, freq, amp };
}

/** Largest distance, in screen px, between a sampled limb edge and the true curve (THM-21). */
const MAX_CHORD_ERROR = 0.25;
/** Most segments one limb gets. */
const MAX_SEGMENTS = 96;
/**
 * Zoom the cached branch mesh (`BranchMeshCache`) is built for. The mesh is built once in world space, so it is
 * sampled for close viewing: within `MAX_CHORD_ERROR` up to this zoom, about twice that at the camera's maximum (8).
 */
export const MESH_DETAIL_ZOOM = 4;
const SAMPLES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
/** Headroom for bends between the samples. */
const SAMPLE_MARGIN = 1.25;

/**
 * Segments for one limb. Curves get enough that the chord error stays within `MAX_CHORD_ERROR` screen px at
 * `zoom`, and never fewer than the length-based count used before (`round((4 + chord * 0.045) * lod)`).
 * A uniform sampling of a cubic B with n segments leaves a chord error of about a / (8 n^2), where a is the
 * acceleration normal to the curve, |B' x B''| / |B'|; an edge offset by half width hw bends more, by a factor of
 * (1 + hw * curvature). Both are taken at nine samples, with `SAMPLE_MARGIN` for what lies between them.
 */
export function segmentCount(s: BranchSpec, lod: number, zoom: number, c: Curve): number {
  const x0 = s.p0.x, y0 = s.p0.y, x3 = s.p1.x, y3 = s.p1.y;
  const dx = x3 - x0,
    dy = y3 - y0;
  const chord = Math.sqrt(dx * dx + dy * dy);
  if (s.style === 'angular') return Math.abs(dx) > 1e-6 && Math.abs(dy) > 1e-6 ? 3 : 1;
  if (s.style === 'line' || (s.flow === 'r' && s.style !== 'organic')) return 1; // straight, linear taper: one quad is exact
  let n = Math.round((4 + chord * 0.045) * lod);
  const ax = x0 - 2 * c.x1 + c.x2, ay = y0 - 2 * c.y1 + c.y2;
  const bx = c.x1 - 2 * c.x2 + x3, by = c.y1 - 2 * c.y2 + y3;
  const halfWidth = 0.5 * Math.max(s.w0, s.w1) * (1 + c.amp);
  let error = 0;
  for (const t of SAMPLES) {
    const u = 1 - t;
    const tx = 3 * (u * u * (c.x1 - x0) + 2 * u * t * (c.x2 - c.x1) + t * t * (x3 - c.x2));
    const ty = 3 * (u * u * (c.y1 - y0) + 2 * u * t * (c.y2 - c.y1) + t * t * (y3 - c.y2));
    const speed = Math.sqrt(tx * tx + ty * ty);
    if (speed < 1e-6) continue;
    const normal = Math.abs(tx * 6 * (u * ay + t * by) - ty * 6 * (u * ax + t * bx)) / speed;
    error = Math.max(error, normal * (1 + Math.min(4, halfWidth * normal / (speed * speed))));
  }
  if (error > 0) n = Math.max(n, Math.ceil(Math.sqrt(SAMPLE_MARGIN * zoom * error / (8 * MAX_CHORD_ERROR))));
  return n < 3 ? 3 : n > MAX_SEGMENTS ? MAX_SEGMENTS : n;
}

/**
 * Segments for an 'arcs' limb: its ground curve, and enough for the rise of `lift` (a half sine) to stay within twice
 * `MAX_CHORD_ERROR` at `zoom`. Straight styles get a few, since the lift alone bends them.
 */
function arcSegments(s: BranchSpec, lod: number, zoom: number, c: Curve): number {
  let n = s.style === 'angular' || s.style === 'line' || s.flow === 'r' ? 3 : segmentCount(s, lod, zoom, c);
  const lift = s.lift ?? 0;
  // The lift is held to four times MAX_CHORD_ERROR: a pixel at the mesh's detail zoom, a quarter of one at zoom 1.
  if (lift > 0) n = Math.max(n, Math.ceil(Math.sqrt(SAMPLE_MARGIN * zoom * lift * Math.PI * Math.PI / (32 * MAX_CHORD_ERROR))));
  return n < 3 ? 3 : n > MAX_SEGMENTS ? MAX_SEGMENTS : n;
}

/**
 * Segments for a quilled limb: the chord-error rule of `segmentCount` for a strip of paper, so without the term for a
 * wide ribbon's outer edge (a strip's width becomes more strips, which share one path).
 */
function wallSegments(s: BranchSpec, lod: number, zoom: number, c: Curve): number {
  if (s.style === 'angular') return Math.abs(s.p1.x - s.p0.x) > 1e-6 && Math.abs(s.p1.y - s.p0.y) > 1e-6 ? 3 : 1;
  if (s.style === 'line' || s.flow === 'r') return 1;
  const x0 = s.p0.x, y0 = s.p0.y, x3 = s.p1.x, y3 = s.p1.y;
  const chord = Math.sqrt((x3 - x0) ** 2 + (y3 - y0) ** 2);
  let n = Math.round((3 + chord * 0.03) * lod);
  const ax = x0 - 2 * c.x1 + c.x2, ay = y0 - 2 * c.y1 + c.y2;
  const bx = c.x1 - 2 * c.x2 + x3, by = c.y1 - 2 * c.y2 + y3;
  let error = 0;
  for (const t of SAMPLES) {
    const u = 1 - t;
    const tx = 3 * (u * u * (c.x1 - x0) + 2 * u * t * (c.x2 - c.x1) + t * t * (x3 - c.x2));
    const ty = 3 * (u * u * (c.y1 - y0) + 2 * u * t * (c.y2 - c.y1) + t * t * (y3 - c.y2));
    const speed = Math.sqrt(tx * tx + ty * ty);
    if (speed < 1e-6) continue;
    error = Math.max(error, Math.abs(tx * 6 * (u * ay + t * by) - ty * 6 * (u * ax + t * bx)) / speed);
  }
  if (error > 0) n = Math.max(n, Math.ceil(Math.sqrt(SAMPLE_MARGIN * zoom * error / (8 * MAX_CHORD_ERROR))));
  return n < 3 ? 3 : n > MAX_SEGMENTS ? MAX_SEGMENTS : n;
}

/** Radius of the plug where an 'arcs' limb of these widths meets a node. */
function plugRadius(s: BranchSpec): number {
  const hw = Math.max(s.w0, s.w1) * 0.5;
  return Math.min(hw * 1.55 + 1, hw + 3);
}

/**
 * Tessellate all branches (and the underline bars carried by `BranchSpecEx`) into ONE indexed triangle mesh.
 *
 * Each branch is a cubic Bezier (horizontal tangents for 'h', vertical for 'v', straight for 'r'), sampled finely
 * enough for viewing at `zoom` (see `segmentCount`; default 1), offset by half the interpolated width on both
 * sides of the normal, and capped with a round half-disk at the start. 'organic' adds a deterministic seeded
 * wobble to the control points and a low-frequency width variation that vanishes at both ends (so chains of
 * branches still join exactly). Colours are the spec's premultiplied colour.
 */
export function tessellateBranches(specs: BranchSpec[], opts?: { zoom?: number; relief?: ReliefOptions }): Mesh {
  const zoom = opts?.zoom ?? 1;
  return opts?.relief ? reliefBatch(specs, zoom, opts.relief) : tessellateBatch(specs, zoom);
}

/** Options a dimensional mesh was built with, to build more geometry (an animation frame) in the same look. */
export function meshRelief(mesh: Mesh | undefined): ReliefOptions | undefined {
  const relief = mesh?.relief;
  return relief && { material: relief.material, shadowColor: relief.shadowColor };
}

/** sin(pi t) and pi cos(pi t) at t = j / n, j = 0..n: the lift profile of an 'arcs' limb and its slope. */
const WAVES = new Map<number, Float64Array>();
function halfWave(n: number): Float64Array {
  let wave = WAVES.get(n);
  if (!wave) {
    wave = new Float64Array(2 * (n + 1));
    for (let j = 0; j <= n; j++) {
      wave[2 * j] = Math.sin(Math.PI * j / n);
      wave[2 * j + 1] = Math.PI * Math.cos(Math.PI * j / n);
    }
    WAVES.set(n, wave);
  }
  return wave;
}

const NO_COLORS = new Float32Array(0);

/** Fan steps of an 'arcs' plug (the bead where a lifted limb meets a node). */
const PLUG_STEPS = 8;
/** 'clay': soft contact shadow of a rope of half width hw lying on the page: its axis is hw above the ground. */
export const clayFall = (hw: number) => hw * 1.1 + 1;
export const claySpread = (hw: number) => hw * 0.5 + 2;
/** 'arcs': the shadow of a lifted limb widens and fades with its height z. */
const arcSpread = (hw: number, z: number) => hw * 0.8 + 1.6 + z * 0.12;
const arcStrength = (z: number) => 0.9 / (1 + z / 24);
const FALL = Math.sqrt(SHADOW_FALL.x * SHADOW_FALL.x + SHADOW_FALL.y * SHADOW_FALL.y);
const FALL_X = SHADOW_FALL.x, FALL_Y = SHADOW_FALL.y;
/** 'rope': world units of rope width per ply, and the lay length (one full twist) per unit of width. */
const PLY_WIDTH = 3.4;
export const LAY = 2.8;
/** Plies of a bundle, 1 to 6 (7 marks a whipping, see ROPE_FS). */
export const plyCount = (s: BranchSpec) => Math.max(1, Math.min(6, Math.round(Math.max(s.w0, s.w1) / PLY_WIDTH)));

/** Length of a branch's limb (the cubic, from its control polygon and chord) plus its underline, world units. */
export function branchLength(s: BranchSpec, c: Curve): number {
  const x0 = s.p0.x, y0 = s.p0.y, x3 = s.p1.x, y3 = s.p1.y;
  const chord = Math.sqrt((x3 - x0) ** 2 + (y3 - y0) ** 2);
  const polygon = Math.sqrt((c.x1 - x0) ** 2 + (c.y1 - y0) ** 2) + Math.sqrt((c.x2 - c.x1) ** 2 + (c.y2 - c.y1) ** 2) +
    Math.sqrt((x3 - c.x2) ** 2 + (y3 - c.y2) ** 2);
  const limb = s.style === 'angular' ? Math.abs(x3 - x0) + Math.abs(y3 - y0) : (chord + polygon) / 2;
  return limb;
}

/**
 * 'rope': turns of twist along a branch (limb and underline). Along a branch the phase grows linearly with the curve
 * parameter over this estimated length, so a child that starts at its parent's `twist + branchTurns` (see
 * buildBranchSpecs) continues it exactly, however either was sampled.
 */
export function branchTurns(s: BranchSpec): number {
  return (branchLength(s, curveOf(s)) + underlineSpan(s)) / (LAY * Math.max(s.w0, s.w1, 1));
}

const underlineSpan = (s: BranchSpec) => s.underlineTo ? Math.sqrt((s.underlineTo.x - s.p1.x) ** 2 + (s.underlineTo.y - s.p1.y) ** 2) : 0;

function tessellateBatch(specs: BranchSpec[], zoom: number, cache?: BranchCacheBuild): Mesh {
  const lod = zoom < 0.12 ? 0.35 : zoom < 0.3 ? 0.55 : zoom < 0.6 ? 0.8 : 1;
  const count = specs.length;
  const segs = new Uint8Array(count);
  const curves = new Array<Curve>(count);
  // Fan steps of the start cap, end cap and tip dot of specs that have them.
  const fans = new Uint8Array(count * 3);
  let nv = 0,
    ni = 0;
  for (let i = 0; i < count; i++) {
    const s = specs[i];
    const curve = curves[i] = curveOf(s);
    const n = segmentCount(s, lod, zoom, curve);
    segs[i] = n;
    nv += 2 * (n + 1) + CAP_VERTS;
    ni += n * 6 + CAP_INDICES;
    if (s.roundCaps) {
      const start = fans[i * 3] = arcSteps(Math.PI, s.w0 * 0.5, zoom, CAP_STEPS, 16);
      nv += start - CAP_STEPS;
      ni += (start - CAP_STEPS) * 3;
      if (s.roundCaps === 'both') {
        const end = fans[i * 3 + 1] = arcSteps(Math.PI, (s.underlineTo ? s.underlineWidth ?? s.w1 : s.w1) * 0.5, zoom, CAP_STEPS, 16);
        nv += end + 2;
        ni += end * 3;
      }
    }
    if (s.tipDot) {
      const dot = fans[i * 3 + 2] = arcSteps(2 * Math.PI, s.tipDot.radius, zoom, 8, 32);
      nv += dot + 1;
      ni += dot * 3;
    }
    if (s.underlineTo) {
      const steps = underlineSteps(s);
      nv += 2 * (steps + 1);
      ni += steps * 6;
    }
  }
  const positions = new Float64Array(nv * 2);
  const colors = new Float32Array(nv * 4);
  const indices = new Uint32Array(ni);
  const bounds = new Float64Array(count * 4);
  const ends = new Uint32Array(count);
  const ids = specs.map(spec => spec.to);
  let vp = 0; // vertex count so far
  let ip = 0; // index count so far

  const pushColor = (v: number, r: number, g: number, b: number, a: number) => {
    const o = v * 4;
    colors[o] = r;
    colors[o + 1] = g;
    colors[o + 2] = b;
    colors[o + 3] = a;
  };

  // Reused branches are copied in runs: consecutive specs that were consecutive in the previous batch.
  const previous = cache?.batch;
  const lanes: Lane[] = previous ? [[previous.mesh.positions, positions, 2], [previous.mesh.colors, colors, 4]] : [];
  let run0 = -1, run1 = -1, runAt = 0;
  const flush = () => {
    ip = reuseRun(previous!, cache!.starts, run0, run1, runAt, vp, ip, lanes, indices, bounds, ends);
    vp += previous!.starts[run1] - previous!.starts[run0];
    run0 = run1 = -1;
  };
  for (let i = 0; i < count; i++) {
    const s = specs[i];
    if (cache) {
      const cached = cache.find(s, i);
      if (cached !== undefined && previous) {
        cache.reused++;
        if (cached === run1) run1++;
        else {
          if (run0 >= 0) flush();
          run0 = cached;
          run1 = cached + 1;
          runAt = i;
        }
        continue;
      }
      if (run0 >= 0) flush();
      cache.starts[i] = vp;
    }
    const n = segs[i];
    const { r, g, b, a } = s.color;
    const end = branchEndColor(s);
    const fade = end !== s.color;
    const x0 = s.p0.x,
      y0 = s.p0.y,
      x3 = s.p1.x,
      y3 = s.p1.y;
    const dx = x3 - x0,
      dy = y3 - y0;
    const { x1, y1, x2, y2, phase, freq, amp } = curves[i];
    const organic = s.style === 'organic';
    const elbow = s.style === 'angular' && n === 3 ? s.flow === 'v'
      ? [[x0, y0], [x0, (y0 + y3) / 2], [x3, (y0 + y3) / 2], [x3, y3]]
      : [[x0, y0], [(x0 + x3) / 2, y0], [(x0 + x3) / 2, y3], [x3, y3]] : undefined;

    // derivative control differences
    const ax = x1 - x0,
      ay = y1 - y0,
      bx = x2 - x1,
      by = y2 - y1,
      cx = x3 - x2,
      cy = y3 - y2;

    const base = vp;
    let lastTx = dx,
      lastTy = dy;
    let t0x = 1,
      t0y = 0;
    for (let j = 0; j <= n; j++) {
      const t = j / n;
      const u = 1 - t;
      const uu = u * u,
        tt = t * t;
      let px = uu * u * x0 + 3 * uu * t * x1 + 3 * u * tt * x2 + tt * t * x3;
      let py = uu * u * y0 + 3 * uu * t * y1 + 3 * u * tt * y2 + tt * t * y3;
      let tx = 3 * (uu * ax + 2 * u * t * bx + tt * cx);
      let ty = 3 * (uu * ay + 2 * u * t * by + tt * cy);
      if (n === 1) { tx = dx; ty = dy; }
      let join = 1;
      if (elbow) {
        [px, py] = elbow[j];
        const a = elbow[Math.max(0, j - 1)];
        const b = elbow[Math.min(n, j + 1)];
        tx = Math.sign(px - a[0]) + Math.sign(b[0] - px);
        ty = Math.sign(py - a[1]) + Math.sign(b[1] - py);
        if (j > 0 && j < n) join = Math.SQRT2;
      }
      let tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-6) {
        tx = lastTx;
        ty = lastTy;
        tl = Math.sqrt(tx * tx + ty * ty);
        if (tl < 1e-6) {
          tx = 1;
          ty = 0;
          tl = 1;
        }
      }
      tx /= tl;
      ty /= tl;
      lastTx = tx;
      lastTy = ty;
      if (j === 0) {
        t0x = tx;
        t0y = ty;
      }
      let w = s.w0 + (s.w1 - s.w0) * t;
      if (organic) w *= 1 + amp * Math.sin(Math.PI * t) * Math.sin(freq * 2 * Math.PI * t + phase);
      const hw = w * 0.5 * join;
      const nx = -ty * hw,
        ny = tx * hw;
      const o = vp * 2;
      positions[o] = px + nx;
      positions[o + 1] = py + ny;
      if (fade) {
        const cr = r + (end.r - r) * t, cg = g + (end.g - g) * t, cb = b + (end.b - b) * t;
        pushColor(vp, cr, cg, cb, a);
        pushColor(vp + 1, cr, cg, cb, a);
      } else {
        pushColor(vp, r, g, b, a);
        pushColor(vp + 1, r, g, b, a);
      }
      vp++;
      const o2 = vp * 2;
      positions[o2] = px - nx;
      positions[o2 + 1] = py - ny;
      vp++;
    }
    for (let j = 0; j < n; j++) {
      const q = base + j * 2;
      indices[ip++] = q;
      indices[ip++] = q + 1;
      indices[ip++] = q + 2;
      indices[ip++] = q + 1;
      indices[ip++] = q + 3;
      indices[ip++] = q + 2;
    }

    const endTx = lastTx,
      endTy = lastTy;
    // Half-disk around (cx, cy) from +normal (nx, ny) through the unit direction (bx, by) to -normal, in one colour.
    const cap = (cx: number, cy: number, nx: number, ny: number, bx: number, by: number, radius: number, c: RGBA, steps: number) => {
      const capArc = arcOf(steps, false);
      const capSteps = steps;
      const first = vp;
      positions[vp * 2] = cx;
      positions[vp * 2 + 1] = cy;
      pushColor(vp, c.r, c.g, c.b, c.a);
      vp++;
      for (let k = 0; k <= capSteps; k++) {
        const co = capArc[k].cos * radius,
          sn = capArc[k].sin * radius;
        positions[vp * 2] = cx + co * nx + sn * bx;
        positions[vp * 2 + 1] = cy + co * ny + sn * by;
        pushColor(vp, c.r, c.g, c.b, c.a);
        vp++;
      }
      for (let k = 0; k < capSteps; k++) {
        indices[ip++] = first;
        indices[ip++] = first + 1 + k;
        indices[ip++] = first + 2 + k;
      }
    };
    // round start cap: half-disk behind the start point
    cap(x0, y0, -t0y, t0x, -t0x, -t0y, s.w0 * 0.5, s.color, s.roundCaps ? fans[i * 3] : CAP_STEPS);

    // The terminal stroke continues under the child's label.
    if (s.underlineTo) {
      const ux = s.underlineTo.x - x3;
      const uy = s.underlineTo.y - y3;
      const rise = s.underlineBend ?? 0;
      const steps = underlineSteps(s);
      const hw = (s.underlineWidth ?? s.w1) * 0.5;
      const q = vp;
      for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        const x = x3 + ux * t;
        const y = y3 + uy * t + (rise ? underlineOffset(t, rise) : 0);
        const dyBar = uy + (rise ? underlineSlope(t, rise) : 0);
        const len = Math.hypot(ux, dyBar) || 1;
        // Outgoing edges inherit this joint's width, including at the far end.
        const nx = -dyBar * hw / len;
        const ny = ux * hw / len;
        positions[vp * 2] = x + nx;
        positions[vp * 2 + 1] = y + ny;
        pushColor(vp, end.r, end.g, end.b, end.a);
        vp++;
        positions[vp * 2] = x - nx;
        positions[vp * 2 + 1] = y - ny;
        pushColor(vp, end.r, end.g, end.b, end.a);
        vp++;
      }
      for (let j = 0; j < steps; j++) {
        const v = q + j * 2;
        indices[ip++] = v;
        indices[ip++] = v + 1;
        indices[ip++] = v + 2;
        indices[ip++] = v + 1;
        indices[ip++] = v + 3;
        indices[ip++] = v + 2;
      }
    }
    // round end cap at the free end: the underline's far end, else the end of the limb
    if (s.roundCaps === 'both') {
      let ex = x3, ey = y3, tx = endTx, ty = endTy, radius = s.w1 * 0.5;
      if (s.underlineTo) {
        const ux = s.underlineTo.x - x3, uy = s.underlineTo.y - y3;
        const length = Math.hypot(ux, uy);
        ex = s.underlineTo.x;
        ey = s.underlineTo.y;
        radius = (s.underlineWidth ?? s.w1) * 0.5;
        if (length > 1e-9) {
          tx = ux / length;
          ty = uy / length;
        }
      }
      cap(ex, ey, -ty, tx, tx, ty, radius, end, fans[i * 3 + 1]);
    }
    const dot = tipDotCenter(s);
    if (dot) {
      const radius = s.tipDot!.radius;
      const steps = fans[i * 3 + 2];
      const disk = arcOf(steps, true);
      const first = vp;
      positions[vp * 2] = dot.x;
      positions[vp * 2 + 1] = dot.y;
      pushColor(vp, end.r, end.g, end.b, end.a);
      vp++;
      for (let k = 0; k < steps; k++) {
        positions[vp * 2] = dot.x + disk[k].cos * radius;
        positions[vp * 2 + 1] = dot.y + disk[k].sin * radius;
        pushColor(vp, end.r, end.g, end.b, end.a);
        vp++;
      }
      for (let k = 0; k < steps; k++) {
        indices[ip++] = first;
        indices[ip++] = first + 1 + k;
        indices[ip++] = first + 1 + (k + 1) % steps;
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let v = base * 2; v < vp * 2; v += 2) {
      const x = positions[v], y = positions[v + 1];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    const offset = i * 4;
    bounds[offset] = minX;
    bounds[offset + 1] = minY;
    bounds[offset + 2] = maxX;
    bounds[offset + 3] = maxY;
    ends[i] = ip;
  }
  if (run0 >= 0) flush();
  return { positions, colors, indices, branchSpans: { ids, bounds, ends } };
}

/**
 * Arrays a dimensional mesh is written into, its write cursor, and the strength bytes of the branch being written (see
 * `reliefBatch`). The helpers below take it instead of closing over the build's locals, so each is a small function
 * that the engines optimise early, also on the first (cold) build after a theme switch.
 */
class ReliefSink implements QuillSink {
  positions: Float64Array;
  rgba: Uint32Array;
  /** Normal, shadow strength and across per vertex, as int8 / 127 (MeshRelief.attribs). */
  attribs: Int8Array;
  /** Offset to the vertex's shadow, int16 / 128 world units. */
  shadow: Int16Array;
  indices: Uint32Array;
  /** 'rope': twist phase per vertex. */
  twist: Float32Array | undefined;
  vp = 0;
  ip = 0;
  /**
   * Strength byte of the branch being written, as `lit` takes it: its colour's alpha times its dimming; for 'rope' that
   * strength in 1/15 steps with the ply count above it (`ribK` on the ribbon, `capK` on plain parts, count 0).
   */
  kd = 1;
  ribK = 1;
  capK = 1;
  constructor(nv: number, ni: number, rope: boolean) {
    this.positions = new Float64Array(nv * 2);
    this.rgba = new Uint32Array(nv);
    this.attribs = new Int8Array(nv * 4);
    this.shadow = new Int16Array(nv * 2);
    this.indices = new Uint32Array(ni);
    this.twist = rope ? new Float32Array(nv) : undefined;
  }
}

/**
 * Relief of vertex v: normal (nx, ny), shadow strength k, across, shadow offset (sx, sy) from the vertex. Written in the
 * form the GPU reads (see MeshRelief): normal, strength and across as int8 / 127, the shadow offset as int16 / 128 world
 * units. Conversions truncate: within 1/127.
 */
function lit(w: ReliefSink, v: number, nx: number, ny: number, k: number, across: number, sx: number, sy: number): void {
  const attribs = w.attribs, shadow = w.shadow, o = v * 4;
  attribs[o] = nx * 127;
  attribs[o + 1] = ny * 127;
  attribs[o + 2] = k * 127;
  attribs[o + 3] = across * 127;
  shadow[v * 2] = sx * 128;
  shadow[v * 2 + 1] = sy * 128;
}

/**
 * Half-disk around (cx, cy) from +normal (nx, ny) through the unit direction (bx, by) to -normal, in one colour: a dome
 * (normals point out from the centre) lying on the page; for 'rope' a plain one at twist `at`.
 */
function reliefCap(w: ReliefSink, cx: number, cy: number, nx: number, ny: number, bx: number, by: number, radius: number,
  c: number, steps: number, at: number): void {
  const capArc = arcOf(steps, false);
  const positions = w.positions, rgba = w.rgba, twist = w.twist, indices = w.indices, capK = w.capK;
  let vp = w.vp, ip = w.ip;
  const first = vp;
  const f = clayFall(radius), sp = claySpread(radius);
  const qx = SHADOW_FALL.x * f, qy = SHADOW_FALL.y * f;
  positions[vp * 2] = cx;
  positions[vp * 2 + 1] = cy;
  rgba[vp] = c;
  lit(w, vp, 0, 0, capK, 0, qx, qy);
  if (twist) twist[vp] = at;
  vp++;
  for (let k = 0; k <= steps; k++) {
    const cos = capArc[k].cos, sin = capArc[k].sin;
    const co = cos * radius,
      sn = sin * radius;
    positions[vp * 2] = cx + co * nx + sn * bx;
    positions[vp * 2 + 1] = cy + co * ny + sn * by;
    rgba[vp] = c;
    const ux = cos * nx + sin * bx, uy = cos * ny + sin * by;
    lit(w, vp, ux, uy, capK, 1, qx + ux * sp, qy + uy * sp);
    if (twist) twist[vp] = at;
    vp++;
  }
  for (let k = 0; k < steps; k++) {
    indices[ip++] = first;
    indices[ip++] = first + 1 + k;
    indices[ip++] = first + 2 + k;
  }
  w.vp = vp;
  w.ip = ip;
}

/** Full disk (tip dot, plug) around (cx, cy) in one colour, a dome like `reliefCap`. */
function reliefDisk(w: ReliefSink, cx: number, cy: number, radius: number, c: number, steps: number, at: number): void {
  const ring = arcOf(steps, true);
  const positions = w.positions, rgba = w.rgba, twist = w.twist, indices = w.indices, capK = w.capK;
  let vp = w.vp, ip = w.ip;
  const first = vp;
  const f = clayFall(radius), sp = claySpread(radius);
  const qx = SHADOW_FALL.x * f, qy = SHADOW_FALL.y * f;
  positions[vp * 2] = cx;
  positions[vp * 2 + 1] = cy;
  rgba[vp] = c;
  lit(w, vp, 0, 0, capK, 0, qx, qy);
  if (twist) twist[vp] = at;
  vp++;
  for (let k = 0; k < steps; k++) {
    const ux = ring[k].cos, uy = ring[k].sin;
    positions[vp * 2] = cx + ux * radius;
    positions[vp * 2 + 1] = cy + uy * radius;
    rgba[vp] = c;
    lit(w, vp, ux, uy, capK, 1, qx + ux * sp, qy + uy * sp);
    if (twist) twist[vp] = at;
    vp++;
  }
  for (let k = 0; k < steps; k++) {
    indices[ip++] = first;
    indices[ip++] = first + 1 + k;
    indices[ip++] = first + 1 + (k + 1) % steps;
  }
  w.vp = vp;
  w.ip = ip;
}

/** Quads between consecutive vertex pairs from `first` on: `count` of them. */
function stripIndices(w: ReliefSink, first: number, count: number): void {
  const indices = w.indices;
  let ip = w.ip;
  for (let j = 0; j < count; j++) {
    const q = first + j * 2;
    indices[ip++] = q;
    indices[ip++] = q + 1;
    indices[ip++] = q + 2;
    indices[ip++] = q + 1;
    indices[ip++] = q + 3;
    indices[ip++] = q + 2;
  }
  w.ip = ip;
}

/**
 * One ribbon branch ('clay', 'arcs' or 'rope'): the limb with `n` segments, its plugs or caps, underline, whipping and
 * tip dot. `fans` holds the fan steps of branch `i`'s caps and tip dot; `limb` is its length ('rope').
 */
function reliefRibbon(w: ReliefSink, s: BranchSpec, c: Curve, n: number, elbow: number[][] | undefined, fans: Uint8Array,
  i: number, limb: number, arcs: boolean, rope: boolean): void {
  const positions = w.positions, rgba = w.rgba, twist = w.twist;
  const { r, g, b, a } = s.color;
  const end = branchEndColor(s);
  const fade = end !== s.color;
  const x0 = s.p0.x,
    y0 = s.p0.y,
    x3 = s.p1.x,
    y3 = s.p1.y;
  const dx = x3 - x0,
    dy = y3 - y0;
  const { x1, y1, x2, y2, phase, freq, amp } = c;
  const organic = s.style === 'organic';

  // derivative control differences
  const ax = x1 - x0,
    ay = y1 - y0,
    bx = x2 - x1,
    by = y2 - y1,
    cx = x3 - x2,
    cy = y3 - y2;

  // Spec fields the per-sample loop needs, read once (specs of different materials have different shapes).
  const sw0 = s.w0, dw = s.w1 - s.w0;
  const kd = w.kd;
  const start32 = rgba8(r, g, b, a), end32 = fade ? rgba8(end.r, end.g, end.b, end.a) : start32;
  // Never higher than 0.3 of the span, so a short limb (also one growing in an animation) never doubles back. A limb
  // that runs down the page ('v') is lifted against its own drop, so it keeps to a quarter of that drop and still
  // reads as running down instead of flattening into a level arc.
  const lift = arcs ? Math.min(s.lift ?? 0, (s.flow === 'v' ? 0.25 * Math.abs(dy) : 0.3 * Math.sqrt(dx * dx + dy * dy))) : 0;
  const wave = arcs ? halfWave(n) : undefined;
  // 'rope': twist along the limb (linear in t over its estimated length) and the ply count.
  const total = limb + (rope ? underlineSpan(s) : 0);
  const lay = LAY * Math.max(s.w0, s.w1, 1), turn0 = s.twist ?? 0;
  if (rope) {
    const q = Math.round(Math.min(1, kd) * 15);
    w.capK = (q + 0.5) / 127;
    w.ribK = ((q | plyCount(s) << 4) + 0.5) / 127;
  }
  const ribK = w.ribK;
  let vp = w.vp;
  const base = vp;
  let lastTx = dx,
    lastTy = dy;
  let t0x = 1,
    t0y = 0;
  for (let j = 0; j <= n; j++) {
    const t = j / n;
    const u = 1 - t;
    const uu = u * u,
      tt = t * t;
    let px = uu * u * x0 + 3 * uu * t * x1 + 3 * u * tt * x2 + tt * t * x3;
    let py = uu * u * y0 + 3 * uu * t * y1 + 3 * u * tt * y2 + tt * t * y3;
    let tx = 3 * (uu * ax + 2 * u * t * bx + tt * cx);
    let ty = 3 * (uu * ay + 2 * u * t * by + tt * cy);
    if (n === 1) { tx = dx; ty = dy; }
    let join = 1;
    if (elbow) {
      [px, py] = elbow[j];
      const a = elbow[Math.max(0, j - 1)];
      const b = elbow[Math.min(n, j + 1)];
      tx = Math.sign(px - a[0]) + Math.sign(b[0] - px);
      ty = Math.sign(py - a[1]) + Math.sign(b[1] - py);
      if (j > 0 && j < n) join = Math.SQRT2;
    }
    let tl = Math.sqrt(tx * tx + ty * ty);
    if (tl < 1e-6) {
      tx = lastTx;
      ty = lastTy;
      tl = Math.sqrt(tx * tx + ty * ty);
      if (tl < 1e-6) {
        tx = 1;
        ty = 0;
        tl = 1;
      }
    }
    tx /= tl;
    ty /= tl;
    lastTx = tx;
    lastTy = ty;
    if (j === 0) {
      t0x = tx;
      t0y = ty;
    }
    let width = sw0 + dw * t;
    if (organic) width *= 1 + amp * Math.sin(Math.PI * t) * Math.sin(freq * 2 * Math.PI * t + phase);
    const hw = width * 0.5 * join;
    let nx = -ty * hw,
      ny = tx * hw;
    if (arcs) {
      // Lifted: the drawn spine is G + LIFT_SHEAR z and the shadow's G + SHADOW_FALL z, each offset along its own normal.
      // (LIFT_SHEAR is straight up the page: its x part is 0.)
      const z = lift * wave![2 * j], dz = lift * wave![2 * j + 1];
      const gx = tx * tl, gy = ty * tl;
      const uy0 = gy - dz, ui = 1 / Math.sqrt(gx * gx + uy0 * uy0 + 1e-12);
      const ux = gx * ui, uy = uy0 * ui;
      const vx0 = gx + FALL_X * dz, vy0 = gy + FALL_Y * dz, vi = 1 / Math.sqrt(vx0 * vx0 + vy0 * vy0 + 1e-12);
      const vx = vx0 * vi, vy = vy0 * vi;
      py -= z;
      nx = -uy * hw;
      ny = ux * hw;
      const sp = hw * 1.8 + 1.6 + z * 0.12, k = 0.9 * kd / (1 + z * 0.0416667);
      // Shadow offsets from each vertex: (q - n_shadow sp) - (p + n hw) and its mirror, q - p = (FALL_X, FALL_Y + 1) z.
      const qx = FALL_X * z, qy = (FALL_Y + 1) * z;
      lit(w, vp, -uy, ux, k, 1, qx - vy * sp - nx, qy + vx * sp - ny);
      lit(w, vp + 1, uy, -ux, k, -1, qx + vy * sp + nx, qy - vx * sp + ny);
    } else {
      // The shadow is the ribbon moved along the light by the rope's height and widened by the spread.
      const f = clayFall(hw), sp = claySpread(hw);
      const fx = SHADOW_FALL.x * f, fy = SHADOW_FALL.y * f;
      lit(w, vp, -ty, tx, ribK, 1, fx - ty * sp, fy + tx * sp);
      lit(w, vp + 1, ty, -tx, ribK, -1, fx + ty * sp, fy - tx * sp);
      if (twist) twist[vp] = twist[vp + 1] = turn0 + t * limb / lay;
    }
    const o = vp * 2;
    positions[o] = px + nx;
    positions[o + 1] = py + ny;
    rgba[vp] = rgba[vp + 1] = fade ? rgba8(r + (end.r - r) * t, g + (end.g - g) * t, b + (end.b - b) * t, a) : start32;
    vp++;
    const o2 = vp * 2;
    positions[o2] = px - nx;
    positions[o2 + 1] = py - ny;
    vp++;
  }
  w.vp = vp;
  stripIndices(w, base, n);

  const endTx = lastTx,
    endTy = lastTy;
  const turnEnd = rope ? turn0 + total / lay : 0;
  if (arcs) {
    // Plugs where the limb leaves its parent and lands on its child: beads a shade darker than the limb.
    const rp = plugRadius(s);
    if (s.startPlug !== false) reliefDisk(w, x0, y0, rp, rgba8(r * 0.8, g * 0.8, b * 0.8, a), PLUG_STEPS, 0);
    reliefDisk(w, x3, y3, rp, rgba8(end.r * 0.8, end.g * 0.8, end.b * 0.8, end.a), PLUG_STEPS, 0);
  } else {
    // round start cap: half-disk behind the start point
    reliefCap(w, x0, y0, -t0y, t0x, -t0x, -t0y, s.w0 * 0.5, start32, s.roundCaps ? fans[i * 3] : CAP_STEPS, turn0);
  }

  // The terminal stroke continues under the child's label.
  if (s.underlineTo) reliefUnderline(w, s, end32, turn0, limb, lay);
  // 'rope': where the bundle divides, a whipping bound round it, over the parent's end and these limbs' starts. Lit
  // like the rope (ply count 7 marks it for the thread lines, see ROPE_FS); it casts no shadow of its own, the rope's
  // shadow is under it already.
  if (rope && s.whip) reliefWhip(w, s.whip, end);
  // round end cap at the free end: the underline's far end, else the end of the limb (an 'arcs' limb has its plug)
  if (s.roundCaps === 'both' && (!arcs || s.underlineTo)) {
    let ex = x3, ey = y3, tx = endTx, ty = endTy, radius = s.w1 * 0.5;
    if (s.underlineTo) {
      const ux = s.underlineTo.x - x3, uy = s.underlineTo.y - y3;
      const length = Math.hypot(ux, uy);
      ex = s.underlineTo.x;
      ey = s.underlineTo.y;
      radius = (s.underlineWidth ?? s.w1) * 0.5;
      if (length > 1e-9) {
        tx = ux / length;
        ty = uy / length;
      }
    }
    reliefCap(w, ex, ey, -ty, tx, tx, ty, radius, end32, fans[i * 3 + 1], turnEnd);
  }
  const dot = tipDotCenter(s);
  if (dot) reliefDisk(w, dot.x, dot.y, s.tipDot!.radius, end32, fans[i * 3 + 2], turnEnd);
}

/** A ribbon branch's underline (the terminal stroke under the child's label), in its end colour `c`. */
function reliefUnderline(w: ReliefSink, s: BranchSpec, c: number, turn0: number, limb: number, lay: number): void {
  const positions = w.positions, rgba = w.rgba, twist = w.twist;
  const x3 = s.p1.x, y3 = s.p1.y;
  const ux = s.underlineTo!.x - x3;
  const uy = s.underlineTo!.y - y3;
  const rise = s.underlineBend ?? 0;
  const steps = underlineSteps(s);
  const hw = (s.underlineWidth ?? s.w1) * 0.5;
  let vp = w.vp;
  const q = vp;
  const f = clayFall(hw), sp = claySpread(hw);
  const span = Math.hypot(ux, uy);
  const ribK = w.ribK;
  for (let j = 0; j <= steps; j++) {
    const t = j / steps;
    const x = x3 + ux * t;
    const y = y3 + uy * t + (rise ? underlineOffset(t, rise) : 0);
    const dyBar = uy + (rise ? underlineSlope(t, rise) : 0);
    const len = Math.hypot(ux, dyBar) || 1;
    // Outgoing edges inherit this joint's width, including at the far end.
    const nx = -dyBar * hw / len;
    const ny = ux * hw / len;
    const qx = SHADOW_FALL.x * f, qy = SHADOW_FALL.y * f;
    const mx = nx / hw, my = ny / hw;
    lit(w, vp, mx, my, ribK, 1, qx + mx * sp, qy + my * sp);
    lit(w, vp + 1, -mx, -my, ribK, -1, qx - mx * sp, qy - my * sp);
    if (twist) twist[vp] = twist[vp + 1] = turn0 + (limb + span * t) / lay;
    positions[vp * 2] = x + nx;
    positions[vp * 2 + 1] = y + ny;
    rgba[vp] = c;
    vp++;
    positions[vp * 2] = x - nx;
    positions[vp * 2 + 1] = y - ny;
    rgba[vp] = c;
    vp++;
  }
  w.vp = vp;
  stripIndices(w, q, steps);
}

/** 'rope': the whipping over a fork (see reliefRibbon), in a cream blended from the branch's end colour. */
function reliefWhip(w: ReliefSink, whip: NonNullable<BranchSpec['whip']>, end: RGBA): void {
  const positions = w.positions, rgba = w.rgba, twist = w.twist!;
  const { x: ex, y: ey, dx: tx, dy: ty } = whip;
  const hw = whip.width * 0.58 + 0.4;
  const cream = rgba8(end.r * 0.14 + 0.8 * end.a, end.g * 0.14 + 0.77 * end.a, end.b * 0.14 + 0.7 * end.a, end.a);
  const whipK = (7 << 4) / 127 + 0.5 / 127;
  let vp = w.vp;
  const q = vp;
  for (let e = 0; e < 2; e++) {
    // Past the parent's rounded end, so the whipping covers it.
    const reach = e ? Math.max(2.2, whip.width * 0.5 + 0.8) : -7;
    const cx = ex + tx * reach, cy = ey + ty * reach;
    positions[vp * 2] = cx - ty * hw;
    positions[vp * 2 + 1] = cy + tx * hw;
    positions[vp * 2 + 2] = cx + ty * hw;
    positions[vp * 2 + 3] = cy - tx * hw;
    rgba[vp] = rgba[vp + 1] = cream;
    lit(w, vp, -ty, tx, whipK, 1, 0, 0);
    lit(w, vp + 1, ty, -tx, whipK, -1, 0, 0);
    twist[vp] = twist[vp + 1] = e;
    vp += 2;
  }
  w.vp = vp;
  stripIndices(w, q, 1);
}

/**
 * Bounds of the vertices `from`..`to` into `bounds` at `o`. They cover the shadow too (culling the mesh culls its
 * shadow, which shares its indices): no shadow lies further from its vertex than the branch's `reach`, and shadows
 * fall down and to the right.
 */
function reliefBounds(positions: Float64Array, from: number, to: number, reach: number, bounds: Float64Array, o: number): void {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let v = from * 2; v < to * 2; v += 2) {
    const x = positions[v], y = positions[v + 1];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  bounds[o] = minX - reach * 0.4;
  bounds[o + 1] = minY - reach * 0.4;
  bounds[o + 2] = maxX + reach;
  bounds[o + 3] = maxY + reach;
}

/**
 * Dimensional meshes (see core/geometry/relief.ts): the same geometry as `tessellateBatch` plus the relief data, or
 * quilled walls. A function of its own, so flat tessellation keeps its own optimised code whatever else has run. The
 * per-branch work is in the small functions above, which write through one `ReliefSink`.
 */
function reliefBatch(specs: BranchSpec[], zoom: number, relief: ReliefOptions, cache?: BranchCacheBuild): Mesh {
  const lod = zoom < 0.12 ? 0.35 : zoom < 0.3 ? 0.55 : zoom < 0.6 ? 0.8 : 1;
  const count = specs.length;
  const segs = new Uint8Array(count);
  const curves = new Array<Curve>(count);
  // Fan steps of the start cap, end cap and tip dot of specs that have them.
  const fans = new Uint8Array(count * 3);
  const arcs = relief.material === 'arcs';
  const quill = relief.material === 'quilling';
  const rope = relief.material === 'rope';
  // 'rope': each limb's length, for the twist.
  const limbs = rope ? new Float64Array(count) : undefined;

  // Farthest any vertex's shadow lies from it, per branch (for its bounds).
  const branchReach = new Float64Array(count);
  let maxWidth = 0, shadowReach = 0;
  let nv = 0,
    ni = 0;
  for (let i = 0; i < count; i++) {
    const s = specs[i];
    let curve = curves[i] = curveOf(s);
    if (arcs && s.style === 'line') {
      // A straight limb keeps a straight track on the page under its lift.
      const dx = s.p1.x - s.p0.x, dy = s.p1.y - s.p0.y;
      curve = curves[i] = { ...curve, x1: s.p0.x + dx / 3, y1: s.p0.y + dy / 3, x2: s.p0.x + 2 * dx / 3, y2: s.p0.y + 2 * dy / 3 };
    }
    const n = arcs ? arcSegments(s, lod, zoom, curve) : quill ? wallSegments(s, lod, zoom, curve) : segmentCount(s, lod, zoom, curve);
    if (quill) {
      segs[i] = n;
      const [qv, qi] = quillCounts(s, n);
      nv += qv;
      ni += qi;
      const [h, reach] = quillReach(s);
      maxWidth = Math.max(maxWidth, h);
      shadowReach = Math.max(shadowReach, reach);
      branchReach[i] = reach;
      continue;
    }
    if (limbs) {
      limbs[i] = branchLength(s, curve);
      if (s.whip) {
        nv += 4;
        ni += 6;
      }
    }
    {
      const hw = 0.5 * Math.max(s.w0, s.w1, s.underlineWidth ?? 0, 2 * (s.tipDot?.radius ?? 0));
      const lift = arcs ? s.lift ?? 0 : 0;
      maxWidth = Math.max(maxWidth, arcs ? 2 * plugRadius(s) : 2 * hw);
      // An arc's shadow is also displaced by its own lift (drawn up, cast down): (SHADOW_FALL - LIFT_SHEAR) * lift.
      const reach = arcs ? (FALL + 1) * lift + 2 * hw + arcSpread(hw, lift) : FALL * clayFall(hw) + claySpread(hw);
      branchReach[i] = reach;
      shadowReach = Math.max(shadowReach, reach);
    }
    segs[i] = n;
    nv += 2 * (n + 1) + CAP_VERTS;
    ni += n * 6 + CAP_INDICES;
    if (arcs) {
      // A plug at each end in place of the start cap (one start plug per point that limbs leave from).
      const plugs = s.startPlug === false ? 1 : 2;
      nv += plugs * (PLUG_STEPS + 1) - CAP_VERTS;
      ni += plugs * PLUG_STEPS * 3 - CAP_INDICES;
      if (s.roundCaps === 'both' && s.underlineTo) {
        const end = fans[i * 3 + 1] = arcSteps(Math.PI, (s.underlineWidth ?? s.w1) * 0.5, zoom, CAP_STEPS, 16);
        nv += end + 2;
        ni += end * 3;
      }
    } else if (s.roundCaps) {
      const start = fans[i * 3] = arcSteps(Math.PI, s.w0 * 0.5, zoom, CAP_STEPS, 16);
      nv += start - CAP_STEPS;
      ni += (start - CAP_STEPS) * 3;
      if (s.roundCaps === 'both') {
        const end = fans[i * 3 + 1] = arcSteps(Math.PI, (s.underlineTo ? s.underlineWidth ?? s.w1 : s.w1) * 0.5, zoom, CAP_STEPS, 16);
        nv += end + 2;
        ni += end * 3;
      }
    }
    if (s.tipDot) {
      const dot = fans[i * 3 + 2] = arcSteps(2 * Math.PI, s.tipDot.radius, zoom, 8, 32);
      nv += dot + 1;
      ni += dot * 3;
    }
    if (s.underlineTo) {
      const steps = underlineSteps(s);
      nv += 2 * (steps + 1);
      ni += steps * 6;
    }
  }
  const w = new ReliefSink(nv, ni, rope);
  const bounds = new Float64Array(count * 4);
  const ends = new Uint32Array(count);
  const ids = specs.map(spec => spec.to);
  // Reused branches are copied in runs, as in tessellateBatch.
  const previous = cache?.batch;
  const lanes: Lane[] = [];
  if (previous) {
    const before = previous.mesh.relief!;
    lanes.push([previous.mesh.positions, w.positions, 2], [before.rgba, w.rgba, 1], [before.attribs, w.attribs, 4]);
    if (before.shadow) lanes.push([before.shadow, w.shadow, 2]);
    if (w.twist && before.twist) lanes.push([before.twist, w.twist, 1]);
  }
  let run0 = -1, run1 = -1, runAt = 0;
  for (let i = 0; i < count; i++) {
    const s = specs[i];
    if (cache) {
      const cached = cache.find(s, i);
      if (cached !== undefined && previous) {
        cache.reused++;
        if (cached === run1) run1++;
        else {
          if (run0 >= 0) reliefReuse(w, previous, cache.starts, run0, run1, runAt, lanes, bounds, ends);
          run0 = cached;
          run1 = cached + 1;
          runAt = i;
        }
        continue;
      }
      if (run0 >= 0) {
        reliefReuse(w, previous!, cache.starts, run0, run1, runAt, lanes, bounds, ends);
        run0 = run1 = -1;
      }
      cache.starts[i] = w.vp;
    }
    const n = segs[i];
    const base = w.vp;
    w.kd = w.ribK = w.capK = s.color.a * (s.dim ?? 1);
    const elbow = s.style === 'angular' && n === 3 && !arcs ? elbowOf(s) : undefined;
    if (quill) emitQuill(w, s, curves[i], n, elbow, branchEndColor(s), w.kd);
    else reliefRibbon(w, s, curves[i], n, elbow, fans, i, limbs ? limbs[i] : 0, arcs, rope);
    reliefBounds(w.positions, base, w.vp, branchReach[i], bounds, i * 4);
    ends[i] = w.ip;
  }
  if (run0 >= 0) reliefReuse(w, previous!, cache!.starts, run0, run1, runAt, lanes, bounds, ends);
  const mesh: Mesh = { positions: w.positions, colors: NO_COLORS, indices: w.indices, branchSpans: { ids, bounds, ends } };
  const data: MeshRelief = { material: relief.material, rgba: w.rgba, attribs: w.attribs, shadowColor: relief.shadowColor, maxWidth, shadowReach };
  if (relief.shadowColor.a > 0) data.shadow = w.shadow;
  if (w.twist) data.twist = w.twist;
  mesh.relief = data;
  return mesh;
}

/** The corners of an 'angular' limb of three segments (an elbow), as `tessellateBatch` builds them. */
function elbowOf(s: BranchSpec): number[][] {
  const x0 = s.p0.x, y0 = s.p0.y, x3 = s.p1.x, y3 = s.p1.y;
  return s.flow === 'v'
    ? [[x0, y0], [x0, (y0 + y3) / 2], [x3, (y0 + y3) / 2], [x3, y3]]
    : [[x0, y0], [(x0 + x3) / 2, y0], [(x0 + x3) / 2, y3], [x3, y3]];
}

/** Copy the run of reused branches `run0`..`run1` of the previous batch to branch `runAt` onward (see reuseRun). */
function reliefReuse(w: ReliefSink, previous: BranchBatch, starts: Uint32Array, run0: number, run1: number, runAt: number,
  lanes: Lane[], bounds: Float64Array, ends: Uint32Array): void {
  w.ip = reuseRun(previous, starts, run0, run1, runAt, w.vp, w.ip, lanes, w.indices, bounds, ends);
  w.vp += previous.starts[run1] - previous.starts[run0];
}
