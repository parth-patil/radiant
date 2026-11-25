import type { BranchSpec, Doc, LayoutResult, NodeBox, NodeId, NodeShape, Theme, Vec2 } from '../types';
import { parseColor, premultiply } from './color';
import { boxCornerRadius, branchWidthAt, createStyleResolver, lineColor, nodePadding } from './style';
import { arcLift, reliefMaterial, sortByLift, wallHeight } from './relief';
import { branchTurns } from './tessellate';
import { premulCss } from './color';

/**
 * A BranchSpec plus the optional underline bar of the child node. `tessellateBranches` accepts plain
 * BranchSpec[] and reads these optional fields when present.
 */
export interface BranchSpecEx extends BranchSpec {
  /** Far end of the child's underline bar; the bar runs from `p1` to here (same y). */
  underlineTo?: Vec2;
  /** Bar thickness, shared by the incoming tip and starting width of child branches. */
  underlineWidth?: number;
}

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seed for one branch: document seed mixed with the child id hash. */
export function branchSeed(docSeed: number, childId: string): number {
  let h = (hashString(childId) ^ Math.imul(docSeed | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Point where the ray from the box centre towards (dx,dy) leaves the box. */
function clip(b: NodeBox, dx: number, dy: number, shape: NodeShape, theme: Theme): Vec2 {
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return { x: b.x, y: b.y };
  const x = Math.abs(dx / length), y = Math.abs(dy / length);
  const hw = b.w / 2, hh = b.h / 2;
  const r = shape === 'circle' ? Math.min(hw, hh) :
    shape === 'box' ? Math.min(hw, hh, boxCornerRadius(b.depth, b.w, b.h, theme)) : 0;
  let t = Math.min(x ? hw / x : Infinity, y ? hh / y : Infinity);
  if (r && x * t > hw - r && y * t > hh - r) {
    const cx = hw - r, cy = hh - r;
    const dot = cx * x + cy * y;
    t = dot + Math.sqrt(Math.max(0, r * r - cx * cx - cy * cy + dot * dot));
  }
  return { x: b.x + dx * t / length, y: b.y + dy * t / length };
}

/** No visible children and no fold badge (a folded node shows its count instead), and no picture. */
function isLeaf(doc: Doc, layout: LayoutResult, id: NodeId): boolean {
  const node = doc.nodes[id];
  if (node.imageAsset || node.pictureArt || node.svgArt) return false;
  if (node.collapsed) return node.children.length === 0;
  return !node.children.some(child => layout.boxes.has(child));
}

/**
 * Order of each main branch along its side of a root (top to bottom), for fanned joins. Null when the root's
 * theme does not fan, the root is bare text, or it is a timeline.
 */
function fanSlot(
  fans: Map<NodeId, Map<NodeId, { i: number; m: number }> | null>, doc: Doc, layout: LayoutResult, root: NodeId,
  shape: NodeShape, theme: Theme
): Map<NodeId, { i: number; m: number }> | null {
  let slots = fans.get(root);
  if (slots !== undefined) return slots;
  slots = null;
  const rbox = layout.boxes.get(root);
  if (theme.fanRootJoins && rbox && shape !== 'none' && shape !== 'underline' && doc.rootInfo[root]?.layout !== 'timeline') {
    const sides = new Map<number, { id: NodeId; y: number; order: number }[]>();
    doc.nodes[root].children.forEach((id, order) => {
      const box = layout.boxes.get(id);
      if (!box || box.flow !== 'h') return;
      const side = box.side !== 0 ? box.side : box.x >= rbox.x ? 1 : -1;
      let list = sides.get(side);
      if (!list) sides.set(side, list = []);
      list.push({ id, y: box.y, order });
    });
    slots = new Map();
    for (const list of sides.values()) {
      list.sort((a, b) => a.y - b.y || a.order - b.order);
      list.forEach(({ id }, i) => slots!.set(id, { i, m: list.length }));
    }
  }
  fans.set(root, slots);
  return slots;
}

/**
 * Fanned centre join (implementation spec 5.3): the start point of main branch `i` of `m` on one side of a root
 * box, spread along the facing edge and 3 units inside the outline, and the direction it leaves in (roughly the
 * outward normal). One branch on a side starts on the centre line.
 */
export function fanJoin(root: NodeBox, shape: NodeShape, theme: Theme, side: number, i: number, m: number): [Vec2, Vec2] {
  const r = root.h / 2;
  const c = shape === 'circle' ? Math.min(root.w, root.h) / 2 :
    shape === 'box' ? Math.min(r, boxCornerRadius(0, root.w, root.h, theme)) : 0;
  const step = Math.min(0.5 * r, 1.2 * r / Math.max(1, m - 1));
  const dy = (i - (m - 1) / 2) * step;
  const q = Math.max(0, Math.abs(dy) - (r - c));
  const ex = Math.sqrt(Math.max(0, c * c - q * q));
  const p0 = { x: root.x + side * (root.w / 2 - c + ex - 3), y: root.y + dy };
  const dx = side * Math.max(0.6, ex / Math.max(c, 1)), ny = 1.15 * dy / Math.max(r, 1e-6);
  const length = Math.hypot(dx, ny) || 1;
  return [p0, { x: 1.05 * dx / length, y: 1.05 * ny / length }];
}

/** What a branch spec was built from, so the next pass can tell whether it still holds (see {@link buildBranchSpecs}). */
interface SpecEntry {
  spec: BranchSpecEx;
  source: NodeId;
  box: NodeBox;
  pbox: NodeBox;
  parent?: BranchSpecEx;
  leaves?: number;
}

/**
 * Specs of the previous pass of one layout, by child id. Give the same memo to consecutive passes over the same
 * document, theme and seed, with `dirty` (see {@link buildBranchSpecs}); a memo used without it is refilled.
 */
export class BranchSpecMemo {
  readonly entries = new Map<NodeId, SpecEntry>();
}

/** Plain data equal key by key (numbers, strings, booleans, nested plain objects and arrays). */
function samePlain(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!samePlain(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (k !== kb[i] || !samePlain((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/**
 * One spec per visible parent -> child edge.
 *
 * Attachment conventions (box = centre x,y and size w,h; "bar" = underline line along the box bottom,
 * centred vertically at bottom - thickness/2):
 *  - flow 'h', child 'underline': leaves the parent at the OUTER end of the parent's bar (right end for side 1,
 *    left for side -1; a root, which is a box, leaves from its edge at centre height facing the child),
 *    arrives at the NEAR end of the child's bar (left end for side 1). The bar then runs to the far end.
 *  - flow 'h', 'box'/'none': edge-centre to edge-centre (parent's outer edge, child's near edge).
 *  - flow 'v': parent bottom-centre (or top-centre if the child is above) to child top-centre. No bars.
 *  - flow 'r': along the line between centres, clipped to both box edges. No bars.
 * The incoming edge or underline sets the outgoing start width. The child's style sets the tip.
 *
 * Everyday-theme flags (all off by default) add: fanned root joins (`fanRootJoins`, see `fanJoin`), tinted lines at
 * depth >= 2 (`tipTint`) with a blend along the limb leaving a main node (`branchGradient`), round caps
 * (`roundCaps`) and tip dots on leaves (`tipDots`). Flags come from the theme of the child's tree.
 */
export function buildBranchSpecs(
  doc: Doc, layout: LayoutResult, theme: Theme, memo?: { specs: BranchSpecMemo; dirty: ReadonlySet<NodeId> | null }
): BranchSpecEx[] {
  const res = createStyleResolver(doc, theme);
  const out: BranchSpecEx[] = [];
  const boxes = layout.boxes;
  const incoming = new Map<NodeId, BranchSpecEx>();
  const timelinePrevious = new Map<NodeId, NodeId>();
  const fans = new Map<NodeId, Map<NodeId, { i: number; m: number }> | null>();
  const material = theme.lean ? undefined : reliefMaterial(theme.branchMaterial);
  const lifted = material === 'arcs', rope = material === 'rope', quill = material === 'quilling';
  // 'arcs': limbs leaving one point share one plug.
  const plugs = lifted ? new Map<NodeId, Vec2>() : undefined;
  // 'rope' and 'quilling': leaves each node carries (its visible subtree's), negative where it has visible children.
  const leaves = rope || quill ? new Map<NodeId, number>() : undefined;
  if (leaves) {
    const sums = new Map<NodeId, number>();
    const order = [...boxes.keys()];
    for (let k = order.length - 1; k >= 0; k--) {
      const id = order[k];
      const own = sums.get(id) ?? 1;
      leaves.set(id, own);
      const parent = doc.nodes[id]?.parent;
      if (parent && boxes.has(parent)) sums.set(parent, (sums.get(parent) ?? 0) + own);
    }
    for (const id of order) if (sums.has(id)) leaves.set(id, -leaves.get(id)!);
  }
  // 'quilling': roots already ringed by loops.
  const ringed = quill ? new Set<NodeId>() : undefined;
  for (const root of doc.roots) {
    if (doc.rootInfo[root]?.layout !== 'timeline') continue;
    let previous = root;
    for (const child of doc.nodes[root].children) {
      if (!boxes.has(child)) continue;
      timelinePrevious.set(child, previous);
      previous = child;
    }
  }
  // 'rope': the whipping where a bundle divides goes with the last limb leaving it.
  const lastLimb = rope ? new Map<NodeId, NodeId>() : undefined;
  // With a memo: a spec is rebuilt with all its siblings when one of them may have changed: its node or its parent's
  // is `dirty` (an edit there or above), either box moved or resized, or the leaves it carries changed. Otherwise it is
  // the previous pass's spec, as long as the spec it continues (its parent's) is too.
  const entries = memo?.specs.entries;
  const changed = memo && memo.dirty === null ? undefined : new Set<NodeId>();
  if (!memo || memo.dirty === null) entries?.clear();
  if (lastLimb || changed) {
    for (const [id, box] of boxes) {
      const node = doc.nodes[id];
      if (!node || node.parent === null) continue;
      const source = timelinePrevious.get(id) ?? node.parent;
      const pbox = boxes.get(source);
      if (!pbox) continue;
      lastLimb?.set(source, id);
      if (!changed || changed.has(source)) continue;
      const entry = entries!.get(id);
      if (!entry || entry.box !== box || entry.pbox !== pbox || entry.source !== source || memo!.dirty!.has(id) ||
          memo!.dirty!.has(source) || (leaves && entry.leaves !== leaves.get(id))) changed.add(source);
    }
  }
  for (const [id, box] of boxes) {
    const node = doc.nodes[id];
    if (!node || node.parent === null) continue;
    // A timeline draws its main topics as a path. The underlying tree keeps its actual parent links.
    const source = timelinePrevious.get(id) ?? node.parent;
    const pbox = boxes.get(source);
    if (!pbox) continue;
    const previous = entries?.get(id);
    if (previous && changed && !changed.has(source) && previous.parent === incoming.get(source)) {
      incoming.set(id, previous.spec);
      out.push(previous.spec);
      continue;
    }
    const st = res.get(id, box.depth, box.mainBranch);
    const pst = res.get(source, pbox.depth, pbox.mainBranch);
    const local = res.themeFor(id);
    let startTangent: Vec2 | undefined;
    const parentBranch = incoming.get(source);
    const parentWidth = doc.nodes[source]?.style?.branchWidth;
    const width = node.style?.branchWidth;
    const inheritedWidth = parentBranch?.underlineWidth ?? parentBranch?.w1 ?? (Number.isFinite(parentWidth) ? Math.max(1, Math.min(64, parentWidth!)) : undefined);
    const constant = st.branch === 'line' || st.branch === 'rounded' || st.branch === 'angular';
    const tip = Number.isFinite(width) ? Math.max(1, Math.min(64, width!)) :
      branchWidthAt(box.depth + 1, theme) * (st.emphasis === 2 ? 1.35 : 1);
    const w1 = constant ? Number.isFinite(width) ? tip : Math.max(theme.minBranchWidth, tip * 0.85) : tip;
    // evenBranches: a constant-width limb leaving the root starts at its own width, not at rootBranchWidth.
    const w0 = inheritedWidth ?? (constant && local.evenBranches ? w1 : branchWidthAt(box.depth, theme));
    const childBar = st.shape === 'underline' && box.depth > 0;
    const parentBar = pst.shape === 'underline' && pbox.depth > 0;

    let p0: Vec2, p1: Vec2;
    let underlineTo: Vec2 | undefined;
    if (box.flow === 'h') {
      const side = box.side !== 0 ? box.side : box.x >= pbox.x ? 1 : -1;
      const parentPad = parentBar ? nodePadding(pbox.depth, pst.shape, theme).r : 0;
      p0 = {
        x: pbox.x + side * (pbox.w / 2 - parentPad),
        y: parentBar ? pbox.y + pbox.h / 2 - w0 / 2 : pbox.y
      };
      const fan = source === node.parent && pbox.depth === 0 ? fanSlot(fans, doc, layout, source, pst.shape, res.themeFor(source))?.get(id) : undefined;
      if (fan) [p0, startTangent] = fanJoin(pbox, pst.shape, res.themeFor(source), side, fan.i, fan.m);
      if (parentBranch?.underlineTo) {
        const a = parentBranch.p1, b = parentBranch.underlineTo;
        const [edge, interior] = side * (b.x - a.x) > 0 ? [b, a] : [a, b];
        // Begin inside the actual underline, including a curved or reversed parent's underline.
        // The cap overlaps the parent even when a child leaves at a different angle.
        const inset = Math.min(Math.abs(edge.x - interior.x) / 2, w0 / 4);
        p0 = { x: edge.x - side * inset, y: edge.y };
      }
      if (childBar) {
        const y = box.y + box.h / 2 - w1 / 2;
        const pad = nodePadding(box.depth, st.shape, theme).l;
        p1 = { x: box.x - side * (box.w / 2 - pad), y };
        underlineTo = { x: box.x + side * (box.w / 2 - pad), y };
      } else {
        p1 = { x: box.x - side * (box.w / 2), y: box.y };
      }
    } else if (box.flow === 'v') {
      const sgn = box.y >= pbox.y ? 1 : -1;
      p0 = { x: pbox.x, y: pbox.y + sgn * (pbox.h / 2) };
      p1 = { x: box.x, y: box.y - sgn * (box.h / 2) };
    } else {
      const dx = box.x - pbox.x,
        dy = box.y - pbox.y;
      p0 = clip(pbox, dx, dy, pst.shape, theme);
      p1 = clip(box, -dx, -dy, st.shape, theme);
    }

    const spec: BranchSpecEx = {
      from: source,
      to: id,
      p0,
      p1,
      w0,
      w1,
      color: premultiply(parseColor(st.color)),
      style: st.branch,
      flow: box.flow,
      seed: branchSeed(doc.seed, id)
    };
    if (underlineTo && box.flow === 'h') {
      spec.underlineTo = underlineTo;
      spec.underlineWidth = spec.w1;
    }
    if (startTangent) spec.startTangent = startTangent;
    if (local.tipTint) {
      const tinted = lineColor(st.color, box.depth, local);
      if (tinted !== st.color) {
        // Blend from the main node's full colour, so leaf limbs leave it without a step.
        if (local.branchGradient && box.depth === 2) spec.fade = { toward: parseColor(local.background), amount: local.tipTint };
        else spec.color = premultiply(parseColor(tinted));
      }
    }
    const filled = st.shape !== 'none' && st.shape !== 'underline';
    if (local.roundCaps) spec.roundCaps = filled ? 'start' : 'both';
    if (local.tipDots && local.tipDots.radius > 0 && box.depth >= 2 && box.flow === 'h' && !filled && isLeaf(doc, layout, id) &&
        (st.shape === 'none' || spec.underlineTo)) {
      spec.tipDot = { radius: local.tipDots.radius, gap: local.tipDots.gap };
    }
    // The tessellator keeps it within 0.3 of the span.
    if (lifted) {
      spec.lift = arcLift(box.depth);
      const first = plugs!.get(source);
      if (!first) plugs!.set(source, p0);
      else if (first.x === p0.x && first.y === p0.y) spec.startPlug = false;
    }
    if (leaves && rope) {
      // A bundle as thick as the ideas it carries, one cord for a leaf, never thicker than the room under its label.
      const carried = leaves.get(id) ?? 1;
      const cord = Math.max(theme.minBranchWidth, Math.min(theme.rootBranchWidth, theme.minBranchWidth * Math.sqrt(Math.abs(carried))));
      const w = Number.isFinite(width) ? spec.w1 : Math.min(cord, childBar ? Math.max(theme.minBranchWidth, branchWidthAt(box.depth + 1, theme)) : cord);
      spec.w0 = spec.w1 = w;
      if (spec.underlineTo) spec.underlineWidth = w;
      spec.twist = parentBranch ? (parentBranch.twist ?? 0) + branchTurns(parentBranch) : 0;
    }
    let whip: BranchSpecEx['whip'];
    if (lastLimb && parentBranch && lastLimb.get(source) === id) {
      const parent = parentBranch;
      const x = parent.underlineTo?.x ?? parent.p1.x, y = parent.underlineTo?.y ?? parent.p1.y;
      const ax = parent.underlineTo ? parent.p1.x : parent.p0.x, ay = parent.underlineTo ? parent.p1.y : parent.p0.y;
      const length = Math.hypot(x - ax, y - ay) || 1;
      whip = { x, y, dx: (x - ax) / length, dy: (y - ay) / length, width: parent.underlineWidth ?? parent.w1 };
    }
    if (quill) {
      spec.wall = wallHeight(box.depth);
      // More strips side by side the more ideas a branch carries, up to three (see core/geometry/quill.ts quillStrips).
      if (!Number.isFinite(width)) spec.w0 = spec.w1 = 3 * Math.min(3, Math.round(Math.sqrt(Math.abs(leaves!.get(id) ?? 1))));
      if (spec.underlineTo) spec.underlineWidth = spec.w1;
      if (pbox.depth === 0 && !ringed!.has(source) && pst.shape !== 'none' && doc.rootInfo[source]?.layout !== 'timeline') {
        ringed!.add(source);
        const local = res.themeFor(source);
        const palette = local.branchColors.length ? local.branchColors : [local.rootColor];
        spec.ring = {
          x: pbox.x - pbox.w / 2, y: pbox.y - pbox.h / 2, w: pbox.w, h: pbox.h,
          radius: pst.shape === 'box' ? boxCornerRadius(0, pbox.w, pbox.h, local) : 0,
          colors: [premulCss(local.rootStrokeColor ?? local.rootColor), premulCss(palette[4 % palette.length]),
            premulCss(palette[1 % palette.length])]
        };
      }
    }
    if (whip) spec.whip = whip;
    // Rebuilt but the same as before: keep the previous object, so the limbs continuing it stay as they are too.
    const kept = previous && samePlain(previous.spec, spec) ? previous.spec : spec;
    if (entries) entries.set(id, { spec: kept, source, box, pbox, parent: parentBranch, leaves: leaves?.get(id) });
    incoming.set(id, kept);
    out.push(kept);
  }
  if (entries && entries.size > out.length * 2 + 200) {
    for (const id of [...entries.keys()]) if (!boxes.has(id)) entries.delete(id);
  }
  if (lifted || quill) sortByLift(out);
  return out;
}
