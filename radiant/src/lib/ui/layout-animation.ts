import { tessellateBranches } from '../core/geometry';
import { meshRelief, MESH_DETAIL_ZOOM } from '../core/geometry/tessellate';
import { buildBranchInstances } from '../core/geometry/branch-instances';
import type { BranchSpec, LayoutPlacements, LayoutResult, Mesh, NodeBox, NodeId, Rect, RectDraw, RGBA, Scene, Vec2 } from '../core/types';

export const FOLD_DURATION = 220;

export interface LayoutFrame {
  scene: Scene;
  layout: LayoutResult;
  placements?: LayoutPlacements;
  branches: BranchSpec[];
}

interface Motion {
  from: Vec2;
  to: Vec2;
  entering?: boolean;
  leaving?: boolean;
}

const faded = (color: RGBA, alpha: number): RGBA =>
  ({ r: color.r * alpha, g: color.g * alpha, b: color.b * alpha, a: color.a * alpha });

/** Static edges already exist in the settled scene. Keep their vertices and only compact their indices. */
function staticBranchMesh(mesh: Mesh, specs: BranchSpec[], selected: number[]): Mesh {
  const spans = mesh.branchSpans;
  if (!spans || spans.ids.length !== specs.length) {
    return tessellateBranches(selected.map(i => specs[i]), { relief: meshRelief(mesh) });
  }
  if (selected.length === specs.length) return mesh;
  // GPU-expanded branches: records for the selected ones (as cheap as copying them).
  if (mesh.instances) return buildBranchInstances(selected.map(i => specs[i]), MESH_DETAIL_ZOOM, meshRelief(mesh));

  const ids: NodeId[] = [];
  const bounds = new Float64Array(selected.length * 4);
  const ends = new Uint32Array(selected.length);
  let count = 0;
  for (const i of selected) count += spans.ends[i] - (spans.ends[i - 1] ?? 0);
  const indices = new Uint32Array(count);
  let offset = 0;
  for (const [j, i] of selected.entries()) {
    const start = spans.ends[i - 1] ?? 0, end = spans.ends[i];
    ids.push(spans.ids[i]);
    bounds.set(spans.bounds.subarray(i * 4, i * 4 + 4), j * 4);
    indices.set(mesh.indices.subarray(start, end), offset);
    offset += end - start;
    ends[j] = offset;
  }
  return { ...mesh, indices, branchSpans: { ids, bounds, ends } };
}

/** Options for a presentation reveal (PRS-04, 10, 61). */
export interface MembershipOptions {
  /** Entering and leaving nodes only fade in place instead of growing out of their parent. */
  fade?: boolean;
  /** Only nodes whose box meets this world rectangle are animated; the rest appear at once. */
  within?: Rect;
}

/** Above this many entering nodes a reveal fades instead of growing (PRS-61). */
export const GROW_LIMIT = 300;

/** Animate a settled layout without changing the document or the final hit-test positions. */
export function animateLayoutBetween(
  before: LayoutFrame, after: LayoutFrame, mode: 'all' | 'membership' | 'pictures' = 'all', options: MembershipOptions = {}
): ((progress: number) => Scene) | undefined {
  const from = before.layout.boxes;
  const to = after.layout.boxes;
  const priorPictures = new Map(before.scene.images.map(image => [image.id, image]));
  const resized = new Set(after.scene.images.filter(image => {
    const old = priorPictures.get(image.id);
    return old && (old.w !== image.w || old.h !== image.h ||
      (old.src !== image.src && (old.x !== image.x || old.y !== image.y)));
  }).map(image => image.id));
  if (mode === 'pictures') {
    if (!resized.size || from.size !== to.size) return;
    for (const [id, box] of to) {
      const old = from.get(id);
      if (!old || old.x !== box.x || old.y !== box.y || old.w !== box.w || old.h !== box.h) return;
    }
  }
  const motion = new Map<NodeId, Motion>();
  const attachments = (frame: LayoutFrame) => {
    const incoming = new Map<NodeId, BranchSpec>();
    for (const edge of frame.branches) {
      if (!incoming.has(edge.to)) incoming.set(edge.to, edge);
    }
    return incoming;
  };
  const within = options.within;
  const outside = (box: NodeBox) => !!within && (box.x + box.w / 2 < within.x || box.x - box.w / 2 > within.x + within.w ||
    box.y + box.h / 2 < within.y || box.y - box.h / 2 > within.y + within.h);
  const addSubtreeMotions = (start: LayoutFrame, end: LayoutFrame, direction: 'entering' | 'leaving') => {
    const branches = attachments(start);
    const targets = new Map<NodeId, Vec2>();
    for (const [id, box] of start.layout.boxes) {
      if (end.layout.boxes.has(id) || outside(box)) continue;
      const parent = start.placements?.nodes[id]?.parent;
      // Layout frames enumerate parents first, including a scoped branch.
      const attachment = parent ? targets.get(parent) ??
        (end.layout.boxes.has(parent) ? branches.get(id)?.p0 ?? end.layout.boxes.get(parent) : undefined) : undefined;
      const point = attachment ?? box;
      targets.set(id, point);
      motion.set(id, direction === 'entering'
        ? { from: point, to: box, entering: true }
        : { from: box, to: point, leaving: true });
    }
  };
  if (mode !== 'pictures') {
    addSubtreeMotions(after, before, 'entering');
    addSubtreeMotions(before, after, 'leaving');
  }
  if (mode === 'all') {
    for (const [id, final] of to) {
      const old = from.get(id);
      if (old && (old.x !== final.x || old.y !== final.y)) motion.set(id, { from: old, to: final });
    }
  }
  if (!motion.size && !resized.size) return;
  if (!from.size || !to.size) return;
  let entering = 0;
  for (const m of motion.values()) if (m.entering) entering++;
  const fade = options.fade || entering > GROW_LIMIT;

  const staticEdges: number[] = [];
  const finalEdges: BranchSpec[] = [];
  const oldEdges = before.branches.filter((edge) => motion.get(edge.to)?.leaving);
  const beforeEdges = new Map<string, BranchSpec[]>();
  const edgeKey = (edge: BranchSpec) => JSON.stringify([edge.from, edge.to]);
  for (const edge of before.branches) {
    const key = edgeKey(edge);
    let group = beforeEdges.get(key);
    if (!group) beforeEdges.set(key, group = []);
    group.push(edge);
  }
  const prior = new Map<BranchSpec, BranchSpec>();
  const offsets = new Map<string, number>();
  for (const [i, edge] of after.branches.entries()) {
    const key = edgeKey(edge);
    const index = offsets.get(key) ?? 0;
    const old = beforeEdges.get(key)?.[index];
    offsets.set(key, index + 1);
    if (motion.has(edge.from) || motion.has(edge.to) || resized.has(edge.from) || resized.has(edge.to)) {
      finalEdges.push(edge);
      if (old) prior.set(edge, old);
    } else staticEdges.push(i);
  }
  const branches = staticBranchMesh(after.scene.branches, after.branches, staticEdges);
  // Moving limbs are drawn in the settled scene's material.
  const relief = meshRelief(after.scene.branches);

  const disappearingImages = before.scene.images.filter((image) => motion.get(image.id)?.leaving);
  const disappearingLabels = before.scene.labels.filter((label) => motion.get(label.id)?.leaving ||
    label.foldBadge && to.has(label.id) && before.placements?.nodes[label.id]?.collapsed && !after.placements?.nodes[label.id]?.collapsed);
  const disappearingRects = before.scene.rects.filter((rect) => rect.nodeId && (motion.get(rect.nodeId)?.leaving ||
    rect.foldBadge && to.has(rect.nodeId) && before.placements?.nodes[rect.nodeId]?.collapsed && !after.placements?.nodes[rect.nodeId]?.collapsed));
  const priorBoundaries = new Map(before.scene.rects.filter(rect => rect.branchBoundary).map(rect => [rect.nodeId, rect]));
  const newBadge = (id: NodeId) => !before.placements?.nodes[id]?.collapsed && !!after.placements?.nodes[id]?.collapsed;

  return (progress) => {
    if (progress >= 1) return after.scene;
    const t = 1 - (1 - progress) ** 3;
    const delta = (id: NodeId | undefined, leaving = false) => {
      const m = id && motion.get(id);
      if (!m) return;
      if (fade && (m.entering || m.leaving)) return { x: 0, y: 0, alpha: m.entering ? t : 1 - t, anchor: undefined };
      const factor = leaving ? t : t - 1;
      const anchor = m.entering ? m.from : m.leaving ? m.to : undefined;
      return { x: (m.to.x - m.from.x) * factor, y: (m.to.y - m.from.y) * factor,
        alpha: m.entering ? t : m.leaving ? 1 - t : 1, anchor };
    };
    const shifted = <T extends Vec2>(point: T, shift?: ReturnType<typeof delta>): T => {
      if (!shift) return point;
      const anchor = shift.anchor;
      if (anchor) return { ...point, x: anchor.x + (point.x - anchor.x) * shift.alpha,
        y: anchor.y + (point.y - anchor.y) * shift.alpha };
      return { ...point, x: point.x + shift.x, y: point.y + shift.y };
    };
    const tween = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const edgeAt = (edge: BranchSpec, leaving = false): BranchSpec => {
      const child = delta(edge.to, leaving);
      const parent = delta(edge.from, leaving);
      const earlier = !leaving && prior.get(edge);
      return {
        ...edge,
        p0: earlier ? tween(earlier.p0, edge.p0) : shifted(edge.p0, parent),
        p1: earlier ? tween(earlier.p1, edge.p1) : shifted(edge.p1, child),
        underlineTo: edge.underlineTo && (earlier && earlier.underlineTo
          ? tween(earlier.underlineTo, edge.underlineTo) : shifted(edge.underlineTo, child)),
        color: child ? faded(edge.color, child.alpha) : edge.color
      };
    };
    const rectAt = (rect: RectDraw, leaving = false) => {
      if (!rect.nodeId) return rect;
      const previous = !leaving && rect.branchBoundary ? priorBoundaries.get(rect.nodeId) : undefined;
      if (previous) {
        const lerp = (a: number, b: number) => a + (b - a) * t;
        return {
          ...rect, x: lerp(previous.x, rect.x), y: lerp(previous.y, rect.y),
          w: lerp(previous.w, rect.w), h: lerp(previous.h, rect.h), radius: lerp(previous.radius, rect.radius)
        };
      }
      const shift = delta(rect.nodeId, leaving);
      const alpha = shift?.alpha ?? (rect.foldBadge ? leaving ? 1 - t : newBadge(rect.nodeId) ? t : 1 : 1);
      return shift || alpha !== 1 ? {
        ...shifted(rect, shift), fill: faded(rect.fill, alpha), stroke: rect.stroke && faded(rect.stroke, alpha)
      } : rect;
    };
    const labels = [
      ...after.scene.labels.map((label) => {
        const shift = delta(label.id);
        const alpha = shift?.alpha ?? (label.foldBadge && newBadge(label.id) ? t : 1);
        return shift || alpha !== 1 ? { ...shifted(label, shift), opacity: (label.opacity ?? 1) * alpha } : label;
      }),
      ...disappearingLabels.map((label) => {
        const shift = delta(label.id, true);
        return { ...shifted(label, shift), opacity: (label.opacity ?? 1) * (shift?.alpha ?? 1 - t) };
      })
    ];
    const images = [
      ...after.scene.images.flatMap((image) => {
        if (resized.has(image.id)) {
          const old = priorPictures.get(image.id)!;
          const point = tween(old, image);
          const w = old.w + (image.w - old.w) * t;
          const h = old.h + (image.h - old.h) * t;
          const fit = (picture: typeof image, alpha: number) => {
            const scale = Math.min(w / picture.w, h / picture.h);
            return { ...picture, ...point, w: picture.w * scale, h: picture.h * scale, opacity: picture.opacity * alpha };
          };
          if (old.src === image.src) return [fit(image, 1)];
          return [fit(old, 1 - t), fit(image, t)];
        }
        const shift = delta(image.id);
        return [shift ? { ...shifted(image, shift), opacity: image.opacity * shift.alpha } : image];
      }),
      ...disappearingImages.map((image) => {
        const shift = delta(image.id, true);
        return shift ? { ...shifted(image, shift), opacity: image.opacity * shift.alpha } : image;
      })
    ];
    return {
      ...after.scene,
      branches,
      animatedBranches: tessellateBranches([...finalEdges.map((edge) => edgeAt(edge)), ...oldEdges.map((edge) => edgeAt(edge, true))], { relief }),
      rects: [...after.scene.rects.map((rect) => rectAt(rect)), ...disappearingRects.map((rect) => rectAt(rect, true))],
      labels, images
    };
  };
}
