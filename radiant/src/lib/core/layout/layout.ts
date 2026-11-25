/**
 * Layout engine. Pure TypeScript, deterministic, no DOM.
 *
 * Pipeline per root (see layoutRootOnly):
 *  1. Collect visible nodes in breadth-first order (children of a node are contiguous), skipping the
 *     children of collapsed nodes.
 *  2. Bottom-up (reverse BFS): separate sibling subtrees using threaded contours and cross-axis offsets.
 *  3. Top-down (BFS): main-axis position = parent's outer edge + levelGap + half own main size (so levels are
 *     not aligned columns), cross position = parent's + offset. Then map to world coordinates by layout kind.
 *  4. Manual offsets are accumulated down the tree and added last.
 *
 * Box attachment points for branch drawing (for the geometry module): flow 'h' attaches to the parent's
 * outer vertical edge (right edge for side 1, left edge for side -1) at the parent's centre y, and to the
 * child's inner vertical edge (facing the parent) at the child's centre y. Flow 'v' uses the horizontal
 * edges facing each other. Flow 'r' (radial) uses the box edge point facing the other node, or simply centres.
 */
import type { Doc, LayoutKind, LayoutOptions, LayoutResult, NodeBox, NodeId, Rect, RootInfo, Size } from '../types';
import { branchSeed } from '../geometry/branches';
import { isCollectionLayout, layoutCollection } from './collections';
import { Occupancy } from './occupancy';
import { tidyTree } from './tidy';

/** Extra, optional tuning on top of the shared LayoutOptions. */
export interface LayoutOptionsEx extends LayoutOptions {
  /**
   * How 'mindmap' roots distribute children that have no explicit `side`.
   * 'extent' (default): greedy by subtree extent. 'alternate': strictly right, left, right, ... by index
   * (perfectly stable, ignores subtree sizes).
   */
  balance?: 'extent' | 'alternate';
  /** Cross-axis clearance between any two nodes compared by the tidy algorithm. */
  spacing?: (left: NodeId, right: NodeId) => number;
  /** Accepted sides of existing unpinned branches during an incremental layout. */
  fixedSides?: ReadonlyMap<NodeId, 'left' | 'right'>;
  organic?: boolean;
}

const DEFAULT_SIZE: Size = { w: 80, h: 30 };
const LAYOUT_KINDS: readonly LayoutKind[] = ['mindmap', 'left', 'right', 'down', 'radial', 'outline', 'up', 'compact'];

export function layoutFlow(kind: LayoutKind): NodeBox['flow'] {
  if (isCollectionLayout(kind) || kind === 'radial') return 'r';
  return kind === 'down' || kind === 'up' || kind === 'compact' || kind === 'outline' ? 'v' : 'h';
}

// ------------------------------------------------------------------ cache

interface CacheEntry {
  boxes: NodeBox[];
  layout: string;
  px: number;
  py: number;
  levelGap: number;
  siblingGap: number;
  balance: string;
  organic: boolean;
  sig: number;
}

/**
 * Per-root memo of layout results. A root's entry is reused while the root's position, layout kind, the
 * options and a signature of its visible layout inputs are unchanged and nobody called invalidate.
 */
export class LayoutCache {
  private entries = new Map<NodeId, CacheEntry>();

  /** Drop one root's memo. */
  invalidate(rootId: NodeId): void {
    this.entries.delete(rootId);
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  /**
   * Invalidate the roots owning the touched node ids (walks parent chains in `doc`). If any touched id no
   * longer exists in `doc` (deleted or moved away) every entry is dropped, which is always safe.
   */
  invalidateTouched(doc: Doc, touched: Iterable<NodeId>): void {
    for (const id of touched) {
      let n = doc.nodes[id];
      if (!n) {
        this.entries.clear();
        return;
      }
      let guard = 0;
      while (n.parent !== null && doc.nodes[n.parent] && guard++ < 1e6) n = doc.nodes[n.parent];
      this.entries.delete(n.id);
    }
  }

  /** @internal */
  get(rootId: NodeId, key: Omit<CacheEntry, 'boxes'>): NodeBox[] | undefined {
    const e = this.entries.get(rootId);
    if (!e) return undefined;
    if (
      e.layout !== key.layout || e.px !== key.px || e.py !== key.py ||
      e.levelGap !== key.levelGap || e.siblingGap !== key.siblingGap || e.balance !== key.balance ||
      e.sig !== key.sig || e.organic !== key.organic
    ) {
      return undefined;
    }
    return e.boxes;
  }

  /** @internal */
  set(rootId: NodeId, key: Omit<CacheEntry, 'boxes'>, boxes: NodeBox[]): void {
    this.entries.set(rootId, { ...key, boxes });
  }
}

/**
 * Use the exact visible layout inputs, including fractional dimensions and offsets.
 * Image measurements can update between passes without changing the document.
 */
function sizeSignature(doc: Doc, rootId: NodeId, sizes: Map<NodeId, Size>): number {
  let hash = 2166136261;
  const float = new DataView(new ArrayBuffer(8));
  const mix = (value: number) => { hash = Math.imul(hash ^ value, 16777619); };
  const mixFloat = (value: number) => {
    float.setFloat64(0, value);
    mix(float.getUint32(0));
    mix(float.getUint32(4));
  };
  mix(doc.seed);
  const stack: NodeId[] = [rootId];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    const sz = sizes.get(node.id) ?? DEFAULT_SIZE;
    mix(node.id.length);
    for (let i = 0; i < node.id.length; i++) mix(node.id.charCodeAt(i));
    mixFloat(sz.w);
    mixFloat(sz.h);
    mixFloat(node.offset?.x ?? 0);
    mixFloat(node.offset?.y ?? 0);
    mix(node.side === 'left' ? -1 : node.side === 'right' ? 1 : 0);
    mix(node.branchLayout ? LAYOUT_KINDS.indexOf(node.branchLayout) + 1 : 0);
    if (node.collapsed) {
      mix(-1);
      continue;
    }
    mix(node.children.length);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return hash >>> 0;
}

// ------------------------------------------------------------------ public API

/** Lay out every root of the document. Only visible nodes are returned. */
export function rootLayoutOptions<T extends LayoutOptions>(info: RootInfo, options: T): T & Pick<LayoutOptionsEx, 'organic'> {
  const factor = info.spacing === 'narrow' ? 0.65 : info.spacing === 'wide' ? 1.55 : 1;
  return { ...options, levelGap: options.levelGap * factor, siblingGap: options.siblingGap * factor, organic: info.organic };
}

export function layoutDoc(
  doc: Doc,
  sizes: Map<NodeId, Size>,
  opts: LayoutOptionsEx,
  cache?: LayoutCache,
): LayoutResult {
  const boxes = new Map<NodeId, NodeBox>();
  const memo = opts.spacing || opts.fixedSides?.size ? undefined : cache;
  for (const rootId of doc.roots) {
    const info = doc.rootInfo[rootId];
    if (!doc.nodes[rootId] || !info) continue;
    const local = rootLayoutOptions(info, opts);
    const key = {
      layout: info.layout,
      px: info.position.x,
      py: info.position.y,
      levelGap: local.levelGap,
      siblingGap: local.siblingGap,
      balance: opts.balance ?? 'extent',
      organic: !!local.organic,
      sig: memo ? sizeSignature(doc, rootId, sizes) : 0,
    };
    let list = memo?.get(rootId, key);
    if (!list) {
      list = layoutRootBoxes(doc, rootId, sizes, local);
      memo?.set(rootId, key, list);
    }
    for (let i = 0; i < list.length; i++) boxes.set(list[i].id, list[i]);
  }
  return { boxes, bounds: boundsOf(boxes.values()) };
}

/** Lay out a single root (used for incremental updates; merge the result into an existing one). */
export function layoutRootOnly(
  doc: Doc,
  rootId: NodeId,
  sizes: Map<NodeId, Size>,
  opts: LayoutOptionsEx,
): LayoutResult {
  const boxes = new Map<NodeId, NodeBox>();
  if (doc.nodes[rootId] && doc.rootInfo[rootId]) {
    for (const b of layoutRootBoxes(doc, rootId, sizes, rootLayoutOptions(doc.rootInfo[rootId], opts))) boxes.set(b.id, b);
  }
  return { boxes, bounds: boundsOf(boxes.values()) };
}

/** Lay out a main branch around its own centre, using the map's measured node sizes. */
export function layoutMainBranch(
  doc: Doc, id: NodeId, sizes: Map<NodeId, Size>, opts: LayoutOptionsEx, kind: LayoutKind
): NodeBox[] {
  return layoutRootBoxes(doc, id, sizes, opts, { position: { x: 0, y: 0 }, layout: kind }, false);
}

/** Union of the boxes of `id` and all its visible descendants (those present in `result`). */
export function subtreeBounds(result: LayoutResult, doc: Doc, id: NodeId): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const stack: NodeId[] = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    const b = result.boxes.get(cur);
    if (!b) continue;
    if (b.x - b.w / 2 < x0) x0 = b.x - b.w / 2;
    if (b.y - b.h / 2 < y0) y0 = b.y - b.h / 2;
    if (b.x + b.w / 2 > x1) x1 = b.x + b.w / 2;
    if (b.y + b.h / 2 > y1) y1 = b.y + b.h / 2;
    const n = doc.nodes[cur];
    if (n) for (const c of n.children) stack.push(c);
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function boundsOf(boxes: Iterable<NodeBox>): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    if (b.x - b.w / 2 < x0) x0 = b.x - b.w / 2;
    if (b.y - b.h / 2 < y0) y0 = b.y - b.h / 2;
    if (b.x + b.w / 2 > x1) x1 = b.x + b.w / 2;
    if (b.y + b.h / 2 > y1) y1 = b.y + b.h / 2;
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ------------------------------------------------------------------ one root

function layoutRootBoxes(
  doc: Doc,
  rootId: NodeId,
  sizes: Map<NodeId, Size>,
  opts: LayoutOptionsEx,
  info: RootInfo = doc.rootInfo[rootId],
  mixed = true,
  nested = true,
): NodeBox[] {
  const px = info.position.x;
  const py = info.position.y;
  const kind = info.layout;

  // 1. Visible nodes, breadth-first: children of node i occupy [cs[i], cs[i] + cc[i]).
  const ids: NodeId[] = [rootId];
  const par: number[] = [-1];
  const cs: number[] = [];
  const cc: number[] = [];
  const w: number[] = [];
  const h: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const node = doc.nodes[ids[i]];
    const sz = sizes.get(ids[i]) ?? DEFAULT_SIZE;
    w.push(sz.w);
    h.push(sz.h);
    cs.push(ids.length);
    let count = 0;
    if (!node.collapsed) {
      const kids = node.children;
      for (let k = 0; k < kids.length; k++) {
        if (!doc.nodes[kids[k]]) continue;
        ids.push(kids[k]);
        par.push(i);
        count++;
      }
    }
    cc.push(count);
  }
  const n = ids.length;

  // Per-node outputs in world space.
  const wx = new Float64Array(n);
  const wy = new Float64Array(n);
  const side = new Int8Array(n);
  const depth = new Int32Array(n);
  const mainBranch = new Int32Array(n);
  mainBranch[0] = -1;
  for (let i = 1; i < n; i++) depth[i] = depth[par[i]] + 1;
  const branchIndex = new Map<NodeId, number>();
  doc.nodes[rootId].children.forEach((c, k) => branchIndex.set(c, k));
  for (let i = 1; i < n; i++) {
    mainBranch[i] = par[i] === 0 ? branchIndex.get(ids[i])! : mainBranch[par[i]];
  }

  if (isCollectionLayout(kind)) {
    layoutCollection(kind, ids, cs, cc, w, h, depth, wx, wy, opts, doc.seed);
  } else if (kind === 'radial') {
    layoutRadial(ids, par, cs, cc, w, h, depth, side, wx, wy, opts);
  } else if (kind === 'outline') {
    const stack = [0];
    let top = -h[0] / 2;
    const indent = opts.levelGap / 2;
    while (stack.length) {
      const i = stack.pop()!;
      wx[i] = (w[i] - w[0]) / 2 + depth[i] * indent;
      wy[i] = top + h[i] / 2;
      top += h[i] + opts.siblingGap;
      for (let k = cs[i] + cc[i] - 1; k >= cs[i]; k--) stack.push(k);
    }
  } else {
    layoutTidy(kind, doc, ids, par, cs, cc, w, h, depth, side, wx, wy, opts);
  }

  // Offsets, accumulated down the tree; then translate to the root position.
  const ox = new Float64Array(n);
  const oy = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const off = doc.nodes[ids[i]].offset;
    ox[i] = ox[par[i]] + (off ? off.x : 0);
    oy[i] = oy[par[i]] + (off ? off.y : 0);
  }
  const flow = layoutFlow(kind);
  const out: NodeBox[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      id: ids[i],
      x: px + wx[i] + ox[i],
      y: py + wy[i] + oy[i],
      w: w[i],
      h: h[i],
      depth: depth[i],
      side: kind === 'up' ? -1 : side[i] as -1 | 0 | 1,
      flow,
      mainBranch: mainBranch[i],
    };
  }
  if (mixed && !isCollectionLayout(kind) && doc.nodes[rootId].children.some((id) => LAYOUT_KINDS.includes(doc.nodes[id]?.branchLayout as LayoutKind))) {
    placeMixedBranches(doc, sizes, opts, out);
  }
  if (nested && !isCollectionLayout(kind)) placeNestedBranches(doc, sizes, opts, out, mixed ? 2 : 1);
  if (opts.organic && !isCollectionLayout(kind)) {
    const amplitude = Math.max(0, Math.min(opts.levelGap, opts.siblingGap) * 0.2);
    const occupied = new Occupancy();
    for (const box of out) occupied.add(box);
    for (let i = 1; i < out.length; i++) {
      const box = out[i];
      const bits = branchSeed(doc.seed, box.id);
      const offsetX = box.flow === 'h' ? 0 : ((bits & 0xffff) / 32768 - 1) * amplitude;
      const offsetY = box.flow === 'v' ? 0 : ((bits >>> 16) / 32768 - 1) * amplitude;
      const candidate = { ...box, x: box.x + offsetX, y: box.y + offsetY };
      occupied.remove(box);
      if (!occupied.blockers(candidate).length) Object.assign(box, candidate);
      occupied.add(box);
    }
  }
  return out;
}

// ------------------------------------------------------------------ mixed main branches

interface Interval { lo: number; hi: number }

/** Project occupied footprints onto the free axis and choose the nearest place that fits. */
function closestGap(preferred: number, blocked: Interval[]): number {
  blocked.sort((a, b) => a.lo - b.lo);
  let lo = -Infinity;
  let hi = -Infinity;
  for (const interval of blocked) {
    if (interval.lo > hi) {
      if (preferred > lo && preferred < hi) return preferred - lo <= hi - preferred ? lo : hi;
      if (preferred <= interval.lo) return preferred;
      lo = interval.lo;
    }
    hi = Math.max(hi, interval.hi);
  }
  if (preferred > lo && preferred < hi) return preferred - lo <= hi - preferred ? lo : hi;
  return preferred;
}

function placeMixedBranches(
  doc: Doc,
  sizes: Map<NodeId, Size>,
  opts: LayoutOptionsEx,
  boxes: NodeBox[],
): void {
  const root = boxes[0];
  const rootBounds = boundsOf([root]);
  const mains = boxes.filter((box) => box.depth === 1);
  const members = new Map<number, NodeBox[]>();
  for (const box of boxes) {
    if (box.depth === 0) continue;
    let list = members.get(box.mainBranch);
    if (!list) members.set(box.mainBranch, list = []);
    list.push(box);
  }
  const overridden = (main: NodeBox) => LAYOUT_KINDS.includes(doc.nodes[main.id].branchLayout as LayoutKind);
  const occupied: Rect[] = mains.filter((main) => !overridden(main)).map((main) => boundsOf(members.get(main.mainBranch)!));

  for (const main of mains) {
    const kind = doc.nodes[main.id].branchLayout;
    if (!kind || !LAYOUT_KINDS.includes(kind)) continue;
    const local = layoutRootBoxes(doc, main.id, sizes, { ...opts, organic: false },
      { position: { x: 0, y: 0 }, layout: kind }, false, false);
    const region = boundsOf(local);
    const verticalLayout = layoutFlow(kind) === 'v';
    const explicit = kind === 'left' || kind === 'right' || verticalLayout;
    const vertical = verticalLayout || (!explicit && Math.abs(main.y - root.y) > Math.abs(main.x - root.x));
    const toward = kind === 'left' || kind === 'up' ? -1 : explicit ? 1
      : vertical ? Math.sign(main.y - root.y) || 1 : Math.sign(main.x - root.x) || 1;
    const offset = doc.nodes[main.id].offset ?? { x: 0, y: 0 };
    const near = vertical ? rootBounds.y : rootBounds.x;
    const far = near + (vertical ? rootBounds.h : rootBounds.w);
    const localMin = vertical ? region.y : region.x;
    const localLength = vertical ? region.h : region.w;
    const naturalMain = vertical ? main.y - offset.y : main.x - offset.x;
    const wantedMain = explicit ? (toward > 0 ? far : near) - localMin : naturalMain;
    const axis = toward > 0
      ? Math.max(wantedMain, far + opts.levelGap - localMin)
      : Math.min(wantedMain, near - opts.levelGap - localMin - localLength);
    const footprintStart = axis + localMin;
    const footprintEnd = footprintStart + localLength;
    const crossMin = vertical ? region.x : region.y;
    const crossLength = vertical ? region.w : region.h;
    const blocked: Interval[] = [];
    for (const obstacle of occupied) {
      const start = vertical ? obstacle.y : obstacle.x;
      const length = vertical ? obstacle.h : obstacle.w;
      if (footprintEnd + opts.siblingGap <= start || start + length + opts.siblingGap <= footprintStart) continue;
      const crossStart = vertical ? obstacle.x : obstacle.y;
      const crossEnd = crossStart + (vertical ? obstacle.w : obstacle.h);
      blocked.push({ lo: crossStart - opts.siblingGap - crossMin - crossLength, hi: crossEnd + opts.siblingGap - crossMin });
    }
    const naturalCross = vertical ? main.x - offset.x : main.y - offset.y;
    const cross = closestGap(naturalCross, blocked);
    const dx = (vertical ? cross : axis) + offset.x;
    const dy = (vertical ? axis : cross) + offset.y;
    const original = new Map(members.get(main.mainBranch)!.map((box) => [box.id, box]));
    for (const box of local) {
      const destination = original.get(box.id)!;
      destination.x = box.x + dx;
      destination.y = box.y + dy;
      destination.flow = box.depth > 0 ? box.flow : (kind === 'radial' ? 'r' : vertical ? 'v' : 'h');
      destination.side = box.depth > 0 ? box.side : kind === 'up' ? -1 : vertical ? 0 : toward as -1 | 1;
    }
    occupied.push({ x: region.x + dx, y: region.y + dy, w: region.w, h: region.h });
  }
}

/** Nested variants keep their incoming attachment and fit only their descendants. */
function placeNestedBranches(doc: Doc, sizes: Map<NodeId, Size>, opts: LayoutOptionsEx, boxes: NodeBox[], minDepth: number): void {
  const anchors = boxes.filter((box) => box.depth >= minDepth && LAYOUT_KINDS.includes(doc.nodes[box.id].branchLayout as LayoutKind));
  if (!anchors.length) return;
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const occupied = new Occupancy();
  for (const box of boxes) occupied.add(box);
  const localOptions = { ...opts, organic: false };
  for (const anchor of anchors) {
    const kind = doc.nodes[anchor.id].branchLayout!;
    const local = layoutRootBoxes(doc, anchor.id, sizes, localOptions,
      { layout: kind, position: { x: anchor.x, y: anchor.y } }, false, false);
    const inherited = new Map<NodeId, { x: number; y: number }>();
    for (let i = 1; i < local.length; i++) occupied.remove(byId.get(local[i].id)!);
    for (let i = 1; i < local.length; i++) {
      const draft = local[i], box = byId.get(draft.id)!;
      const shift = inherited.get(doc.nodes[box.id].parent!);
      const placed = occupied.makeRoom({
        ...box, x: draft.x + (shift?.x ?? 0), y: draft.y + (shift?.y ?? 0),
        flow: draft.flow, side: draft.side
      }, localOptions.siblingGap);
      Object.assign(box, placed);
      occupied.add(box);
      inherited.set(box.id, { x: box.x - draft.x, y: box.y - draft.y });
    }
  }
}

// ------------------------------------------------------------------ tidy layouts

/**
 * Tidy horizontal and vertical trees. Writes world-space positions relative to the root centre.
 *
 * Mind-map side rule: pinned children keep their sides. The rest are assigned
 * to the side with less cumulative extent, seeding with the largest branch.
 * The placement layer retains accepted sides across edits within a main branch.
 * With balance:'alternate' unpinned children alternate right, left, right, ... by index.
 */
function layoutTidy(
  kind: LayoutKind,
  doc: Doc,
  ids: NodeId[],
  par: number[],
  cs: number[],
  cc: number[],
  w: number[],
  h: number[],
  depth: Int32Array,
  side: Int8Array,
  wx: Float64Array,
  wy: Float64Array,
  opts: LayoutOptionsEx,
): void {
  const n = ids.length;
  const vertical = layoutFlow(kind) === 'v'; // main axis is y, cross axis is x
  const cross = vertical ? w : h;
  let main = vertical ? h : w;
  const levelGap = kind === 'compact' ? opts.levelGap * 0.6 : opts.levelGap;
  if (kind === 'compact') {
    // Equal footprints within each level make the organization chart align in rows.
    const heights: number[] = [];
    for (let i = 0; i < n; i++) heights[depth[i]] = Math.max(heights[depth[i]] ?? 0, h[i]);
    main = h.map((_, i) => heights[depth[i]]);
  }
  const spacing = opts.spacing;
  const { main: distance, cross: lateral } = tidyTree(cs, cc, main, cross, levelGap,
    spacing ? (left, right) => spacing(ids[left], ids[right]) : () => opts.siblingGap,
    (kids, extentOf) => kind === 'mindmap'
      ? balancedGroups(kids, (i) => doc.nodes[ids[i]].side ?? opts.fixedSides?.get(ids[i]), extentOf, side, opts)
      : [kids]);
  for (let i = 1; i < n; i++) {
    const parent = par[i];
    if (vertical) {
      wx[i] = lateral[i];
      wy[i] = kind === 'up' ? -distance[i] : distance[i];
    } else {
      if (kind === 'left') side[i] = -1;
      else if (kind === 'right') side[i] = 1;
      else if (parent !== 0) side[i] = side[parent];
      wx[i] = side[i] * distance[i];
      wy[i] = lateral[i];
    }
  }
}

function balancedGroups(
  kids: number[], pinned: (index: number) => 'left' | 'right' | undefined, extentOf: (index: number) => number,
  side: Int8Array, opts: LayoutOptionsEx
): number[][] {
  const alternate = opts.balance === 'alternate';
  const unpinned: { index: number; extent: number }[] = [];
  let largest = 0;
  let leftExtent = 0, rightExtent = 0;
  for (const index of kids) {
    const pin = pinned(index);
    const extent = alternate ? 0 : extentOf(index) + opts.siblingGap;
    if (pin === 'left') {
      side[index] = -1;
      leftExtent += extent;
    } else if (pin === 'right') {
      side[index] = 1;
      rightExtent += extent;
    } else {
      if (extent > (unpinned[largest]?.extent ?? 0)) largest = unpinned.length;
      unpinned.push({ index, extent });
    }
  }
  const assign = ({ index, extent }: { index: number; extent: number }, right: boolean) => {
    side[index] = right ? 1 : -1;
    if (right) rightExtent += extent;
    else leftExtent += extent;
  };
  if (!alternate && unpinned.length) assign(unpinned[largest], rightExtent <= leftExtent);
  for (let i = 0; i < unpinned.length; i++) {
    if (alternate) assign(unpinned[i], i % 2 === 0);
    else if (i !== largest) assign(unpinned[i], rightExtent <= leftExtent);
  }
  return [kids.filter((i) => side[i] === 1), kids.filter((i) => side[i] === -1)];
}

// ------------------------------------------------------------------ radial

/**
 * Concentric rings by depth. Each leaf gets an equal angular slot (2*PI / leafCount) so a subtree's wedge is
 * proportional to its leaf count; a node sits at the middle of its wedge. Ring radii grow with the largest
 * node on the ring and are widened until neighbours on the ring cannot collide (each node is treated as its
 * bounding circle, so radial layouts are overlap-free but somewhat roomy). The first wedge starts at the top (-PI/2) and runs clockwise.
 */
function layoutRadial(
  ids: NodeId[],
  par: number[],
  cs: number[],
  cc: number[],
  w: number[],
  h: number[],
  depth: Int32Array,
  side: Int8Array,
  wx: Float64Array,
  wy: Float64Array,
  opts: LayoutOptionsEx,
): void {
  const n = ids.length;
  const leaves = new Float64Array(n);
  let maxDepth = 0;
  for (let i = n - 1; i >= 0; i--) {
    if (cc[i] === 0) leaves[i] = 1;
    else {
      let s = 0;
      for (let k = cs[i]; k < cs[i] + cc[i]; k++) s += leaves[k];
      leaves[i] = s;
    }
    if (depth[i] > maxDepth) maxDepth = depth[i];
  }
  const L = leaves[0];
  const ringHalf = new Float64Array(maxDepth + 1);
  const ringTan = new Float64Array(maxDepth + 1);
  for (let i = 0; i < n; i++) {
    const d = depth[i];
    const half = Math.hypot(w[i], h[i]) / 2;
    if (half > ringHalf[d]) ringHalf[d] = half;
    const t = Math.hypot(w[i], h[i]) + opts.siblingGap; // bounding-circle diameter + gap
    if (t > ringTan[d]) ringTan[d] = t;
  }
  const radius = new Float64Array(maxDepth + 1);
  const twoPi = Math.PI * 2;
  const slot = twoPi / Math.max(L, 1);
  for (let d = 1; d <= maxDepth; d++) {
    const stack = radius[d - 1] + ringHalf[d - 1] + opts.levelGap + ringHalf[d];
    // Neighbouring leaf slots are `slot` radians apart: chord 2 r sin(slot/2) must clear the diameter.
    const s2 = Math.sin(Math.min(slot, Math.PI) / 2);
    const arc = s2 > 1e-12 ? ringTan[d] / (2 * s2) : 0;
    radius[d] = Math.max(stack, arc);
  }
  const start = new Float64Array(n);
  start[0] = -Math.PI / 2;
  for (let i = 0; i < n; i++) {
    let a = start[i];
    for (let k = cs[i]; k < cs[i] + cc[i]; k++) {
      start[k] = a;
      const span = leaves[k] * slot;
      const mid = a + span / 2;
      const r = radius[depth[k]];
      wx[k] = Math.cos(mid) * r;
      wy[k] = Math.sin(mid) * r;
      a += span;
    }
  }
  for (let i = 1; i < n; i++) {
    const cx = wx[i];
    side[i] = Math.abs(cx) < 1e-9 ? 1 : cx > 0 ? 1 : -1;
  }
  void par;
}
