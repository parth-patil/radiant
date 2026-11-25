import type { Mesh, NodeId, Vec2 } from '../types';
import { GridIndex } from './grid';
import { instanceStrip } from './branch-instances';

const indexes = new WeakMap<Mesh, GridIndex>();

/** Picking and rendering use the same bounds as the actual, tessellated branches. */
export function branchIndex(mesh: Mesh, previous?: Mesh): GridIndex | undefined {
  const spans = mesh.branchSpans;
  if (!spans) return undefined;
  let index = indexes.get(mesh);
  if (!index) {
    const reusable = previous && indexes.get(previous);
    if (reusable) {
      indexes.delete(previous);
      index = reusable;
      index.update(spans.bounds, spans.ids.length);
    } else {
      index = new GridIndex();
      index.build(spans.bounds, spans.ids.length);
    }
    indexes.set(mesh, index);
  }
  return index;
}

function containsTriangle(positions: Mesh['positions'], ia: number, ib: number, ic: number, point: Vec2): boolean {
  const ax = positions[ia], ay = positions[ia + 1];
  const bx = positions[ib], by = positions[ib + 1];
  const cx = positions[ic], cy = positions[ic + 1];
  const abx = bx - ax, aby = by - ay;
  const area = abx * (cy - ay) - aby * (cx - ax);
  if (!area) return false;
  const a = abx * (point.y - ay) - aby * (point.x - ax);
  const b = (cx - bx) * (point.y - by) - (cy - by) * (point.x - bx);
  const c = (ax - cx) * (point.y - cy) - (ay - cy) * (point.x - cx);
  return area > 0 ? a >= 0 && b >= 0 && c >= 0 : a <= 0 && b <= 0 && c <= 0;
}

/** Test the tessellated outline without granting the empty corners of its bounding box. */
export function pickBranch(mesh: Mesh, point: Vec2): NodeId | null {
  const { branchSpans: spans, positions, indices } = mesh;
  if (!spans) return null;
  const candidates = branchIndex(mesh)!.query(point.x, point.y, point.x, point.y);
  if (mesh.instances) {
    // GPU-expanded branches: rebuild each candidate's strip as the vertex shader does and test its quads.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const strip = instanceStrip(mesh.instances.records, candidates[i], mesh.instances.words);
      for (let k = 0; k + 7 < strip.length; k += 4) {
        // Quad (l0, r0, l1, r1) = triangles (l0, r0, l1) and (r0, r1, l1), as tessellateBatch's ribbons.
        if (containsTriangle(strip, k, k + 2, k + 4, point) || containsTriangle(strip, k + 2, k + 6, k + 4, point)) {
          return spans.ids[candidates[i]];
        }
      }
    }
    return null;
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    const branch = candidates[i];
    const start = branch === 0 ? 0 : spans.ends[branch - 1];
    const end = spans.ends[branch];
    for (let k = start; k < end; k += 3) {
      if (containsTriangle(positions, indices[k] * 2, indices[k + 1] * 2, indices[k + 2] * 2, point)) {
        return spans.ids[branch];
      }
    }
  }
  return null;
}
