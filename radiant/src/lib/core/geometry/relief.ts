import type { BranchMaterial, BranchSpec, RGBA, Theme } from '../types';
import { parseColor, premultiply } from './color';

/*
 * Dimensional branch materials (Theme.branchMaterial): 'clay', 'arcs', 'rope' (plies drawn in the fragment shader on
 * the bundle ribbon) and 'quilling' (paper walls, core/geometry/quill.ts). The look of 3D comes from geometry baked into
 * 2D plus a little fragment shading, so a frame costs about what a flat one does:
 *  - one fixed light from the upper left, the same everywhere (no per-frame state beyond the camera);
 *  - ribbons carry the in-plane part of a cylinder's normal per vertex (MeshRelief.attribs) and the renderer lights it;
 *  - height is an oblique shear baked at build time: a point at height z is drawn at (x + LIFT_SHEAR.x * z,
 *    y + LIFT_SHEAR.y * z), so the ground plane (layout, text, hit-testing) is untouched;
 *  - shadows are baked ground geometry (MeshRelief.shadow) that shares the mesh's indices; the renderer draws it into a
 *    low-resolution layer with MAX blending, so overlapping shadows never darken twice, and composites that once.
 */

/** Screen displacement per unit of height: height slides geometry straight up the screen. */
export const LIFT_SHEAR = { x: 0, y: -1 } as const;
/** Ground displacement of a shadow per unit of height: the light comes from the upper left and above. */
export const SHADOW_FALL = { x: 0.3, y: 0.62 } as const;
/**
 * Unit vector toward the light in world axes (y down, z toward the viewer). The renderer's shaders use the same
 * numbers (render/shaders.ts RELIEF_FS); keep them in step with SHADOW_FALL (same azimuth).
 */
export const LIGHT = { x: -0.24, y: -0.5, z: 0.83 } as const;

/**
 * 'quilling' walls are drawn with this shear instead: a little sideways as well, so a wall running up the page is still
 * seen at an angle (its west face, which the light reaches) instead of edge-on.
 */
export const WALL_SHEAR = { x: 0.6, y: -1 } as const;

/** Peak heights of 'arcs' limbs by the depth of the node they lead to (1, 2, 3 and deeper), world units. */
const ARC_LIFT = [30, 20, 14] as const;

/** Heights of 'quilling' walls by the depth of the node they lead to (1, 2 and deeper), world units. */
const WALL_HEIGHT = [9, 7, 6] as const;

export interface ReliefOptions {
  material: 'clay' | 'arcs' | 'rope' | 'quilling';
  /** Premultiplied colour of a fully dark shadow. */
  shadowColor: RGBA;
}

/** The dimensional look of a theme's branch material, or undefined for flat branches. */
export function reliefMaterial(material: BranchMaterial | undefined): ReliefOptions['material'] | undefined {
  if (!material || material === 'flat') return;
  return material;
}

/** Mesh options for a theme, or undefined for flat branches (also in lean mode). */
export function reliefOptions(theme: Theme): ReliefOptions | undefined {
  const material = reliefMaterial(theme.branchMaterial);
  if (!material || theme.lean) return;
  // Follow the node shadows, so a dark theme's black shadows also tint the branch shadows.
  const nodes = theme.nodeShadow?.opacity ? theme.nodeShadow : theme.rootShadow?.opacity ? theme.rootShadow : undefined;
  const opacity = Math.max(0.16, Math.min(0.6, (nodes?.opacity ?? 0.2) * 1.5));
  const color = parseColor(nodes?.color ?? '#1B2A3A');
  return { material, shadowColor: premultiply({ ...color, a: opacity }) };
}

/** Peak height of the 'arcs' limb into a node at `depth`. */
export function arcLift(depth: number): number {
  return ARC_LIFT[Math.max(0, Math.min(ARC_LIFT.length - 1, depth - 1))];
}

/** Height of the 'quilling' wall into a node at `depth`. */
export function wallHeight(depth: number): number {
  return WALL_HEIGHT[Math.max(0, Math.min(WALL_HEIGHT.length - 1, depth - 1))];
}

/**
 * Under the oblique view the nearer of two crossing limbs is the higher one, and of two on the page the one further
 * down: limbs are drawn lowest first, then back (top of the page) to front. Sorts in place; stable for equal keys.
 */
export function sortByLift(specs: BranchSpec[]): void {
  specs.sort((a, b) => (a.lift ?? 0) - (b.lift ?? 0) || Math.max(a.p0.y, a.p1.y) - Math.max(b.p0.y, b.p1.y));
}

/** Premultiplied colour as 4 bytes r, g, b, a in memory order (little-endian), rounded as packMeshVertices does. */
export function rgba8(r: number, g: number, b: number, a: number): number {
  return (byte(r) | byte(g) << 8 | byte(b) << 16 | byte(a) << 24) >>> 0;
}
function byte(v: number): number {
  // Math.round for 0 < v < 1, without the call.
  return v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
}

/** Same options (material and shadow colour) for mesh reuse. */
export function sameRelief(a: ReliefOptions | undefined, b: ReliefOptions | undefined): boolean {
  if (!a || !b) return a === b;
  const p = a.shadowColor, q = b.shadowColor;
  return a.material === b.material && p.r === q.r && p.g === q.g && p.b === q.b && p.a === q.a;
}
