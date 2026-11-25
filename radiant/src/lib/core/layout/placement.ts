import type { Doc, LayoutKind, LayoutOptions, LayoutPlacements, LayoutResult, NodeBox, NodeId, Size, StoredNodePlacement, Vec2 } from '../types';
import { isCollectionLayout } from './collections';
import { LayoutCache, layoutDoc, layoutFlow, layoutMainBranch, rootLayoutOptions } from './layout';
import { Occupancy, overlaps } from './occupancy';

interface VisibleNode {
  id: NodeId;
  parent: NodeId | null;
  index: number;
  siblingCount: number;
  branch: number;
  depth: number;
  offsetX: number;
  offsetY: number;
  w: number;
  h: number;
}

function collect(doc: Doc, root: NodeId, sizes: Map<NodeId, Size>): VisibleNode[] {
  return collectOrder(doc, root, sizes) as VisibleNode[];
}

/**
 * The visible nodes of a root in breadth-first order. With `dirty` (main branches that may have changed), the nodes of
 * the other main branches are listed by id only: their boxes and placements are taken over from the previous pass.
 */
function collectOrder(doc: Doc, root: NodeId, sizes: Map<NodeId, Size>, dirty?: ReadonlySet<NodeId>): (VisibleNode | NodeId)[] {
  const sizeOf = (id: NodeId) => sizes.get(id) ?? { w: 80, h: 30 };
  const entries: (VisibleNode | NodeId)[] = [{
    id: root, parent: null, index: 0, siblingCount: 1, branch: -1,
    depth: 0, offsetX: 0, offsetY: 0, ...sizeOf(root)
  }];
  for (let k = 0; k < entries.length; k++) {
    const node = entries[k];
    const parent = doc.nodes[typeof node === 'string' ? node : node.id];
    if (parent.collapsed) continue;
    const children = parent.children;
    if (typeof node === 'string') {
      for (const id of children) if (doc.nodes[id]) entries.push(id);
      continue;
    }
    for (let index = 0; index < children.length; index++) {
      const id = children[index];
      const child = doc.nodes[id];
      if (!child) continue;
      if (dirty && node.depth === 0 && !dirty.has(id)) {
        entries.push(id);
        continue;
      }
      entries.push({
        id, parent: node.id, index, siblingCount: children.length,
        branch: node.depth === 0 ? index : node.branch, depth: node.depth + 1,
        offsetX: node.offsetX + (child.offset?.x ?? 0), offsetY: node.offsetY + (child.offset?.y ?? 0), ...sizeOf(id)
      });
    }
  }
  return entries;
}

function boxFor(node: VisibleNode, x: number, y: number, side: NodeBox['side'], flow: NodeBox['flow']): NodeBox {
  return { id: node.id, x, y, w: node.w, h: node.h, side, flow, depth: node.depth, mainBranch: node.branch };
}

function oldBox(node: VisibleNode, saved: StoredNodePlacement, rootShift: Vec2): NodeBox {
  const x = saved.x + rootShift.x + (node.offsetX - saved.offsetX);
  const y = saved.y + rootShift.y + (node.offsetY - saved.offsetY);
  return boxFor(node, x, y, saved.side, saved.flow);
}

function sameBox(a: NodeBox, b: NodeBox): boolean {
  return a.id === b.id && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.side === b.side && a.flow === b.flow &&
    a.depth === b.depth && a.mainBranch === b.mainBranch;
}

function branchKind(kind: LayoutKind, side: NodeBox['side']): LayoutKind {
  return kind === 'mindmap' ? side < 0 ? 'left' : 'right' : kind;
}

function worldBounds(boxes: Iterable<NodeBox>): LayoutResult['bounds'] {
  let x = Infinity, y = Infinity, right = -Infinity, bottom = -Infinity;
  for (const b of boxes) {
    x = Math.min(x, b.x - b.w / 2);
    y = Math.min(y, b.y - b.h / 2);
    right = Math.max(right, b.x + b.w / 2);
    bottom = Math.max(bottom, b.y + b.h / 2);
  }
  return x === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x, y, w: right - x, h: bottom - y };
}

export interface SettledLayout extends LayoutResult {
  placements: LayoutPlacements;
}

/**
 * What a pass can take over from the previous one: `boxes`, the boxes settleLayout returned together with the
 * placements passed as `previous`, and `dirty`, the main branches (children of a root) whose nodes may have changed
 * since (structure, size, offset, fold, layout, side, pin). A root that did not move keeps every other main branch's
 * boxes and placements as they are.
 */
export interface SettleReuse {
  boxes: ReadonlyMap<NodeId, NodeBox>;
  dirty: ReadonlySet<NodeId>;
}

/**
 * Use persisted positions as explicit layout input. Surviving nodes keep their world placement
 * unless moved by an edit in their own main branch. Folded nodes keep their last slots.
 */
export function settleLayout(
  doc: Doc, sizes: Map<NodeId, Size>, options: LayoutOptions, previous?: LayoutPlacements,
  anchor?: NodeId | null, cache?: LayoutCache, resolveOverlaps = false, reuse?: SettleReuse
): SettledLayout {
  const roots: LayoutPlacements['roots'] = Object.create(null);
  const saved: LayoutPlacements['nodes'] = Object.create(null);
  const boxes = new Map<NodeId, NodeBox>();
  const ordered = new Map<NodeId, NodeBox>();
  const reorderedRoots = new Set<NodeId>();
  const staleSlots = new Set<NodeId>();
  const invalidateDescendants = (id: NodeId) => {
    const pending = [...doc.nodes[id].children];
    while (pending.length) {
      const child = pending.pop()!;
      if (staleSlots.has(child) || !doc.nodes[child]) continue;
      staleSlots.add(child);
      for (const id of doc.nodes[child].children) pending.push(id);
    }
  };
  let automatic: LayoutResult | undefined;
  const natural = () => {
    if (automatic) return automatic;
    const fixedSides = new Map<NodeId, 'left' | 'right'>();
    for (const root of doc.roots) {
      if (doc.rootInfo[root]?.layout !== 'mindmap' || previous?.roots[root]?.layout !== 'mindmap') continue;
      for (const id of doc.nodes[root].children) {
        const old = previous.nodes[id];
        if (!old || old.parent !== root || old.pinnedSide !== doc.nodes[id]?.side || old.branchLayout !== undefined || !old.side) continue;
        fixedSides.set(id, old.side === -1 ? 'left' : 'right');
      }
    }
    return automatic = layoutDoc(doc, sizes, fixedSides.size ? { ...options, fixedSides } : options, cache);
  };

  for (const rootId of doc.roots) {
    const info = doc.rootInfo[rootId];
    if (!info || !doc.nodes[rootId]) continue;
    const { layout, position } = info;
    const local = rootLayoutOptions(info, options);
    const prior = previous?.roots[rootId];
    const collection = isCollectionLayout(layout);
    const mainOrderChanged = collection && !doc.nodes[rootId].collapsed && doc.nodes[rootId].children.some((id, index, ids) => {
      const old = previous?.nodes[id];
      return !!old && (old.parent !== rootId || old.index !== index || old.siblingCount !== ids.length);
    });
    if (mainOrderChanged) reorderedRoots.add(rootId);
    const organicSeed = info.organic && !collection ? doc.seed : undefined;
    const keep = !mainOrderChanged && prior && prior.layout === layout && prior.levelGap === local.levelGap &&
      prior.siblingGap === local.siblingGap && prior.organicSeed === organicSeed;
    roots[rootId] = {
      layout, x: position.x, y: position.y, levelGap: local.levelGap, siblingGap: local.siblingGap,
      ...(organicSeed !== undefined ? { organicSeed } : {})
    };
    // Clean main branches are listed by id only when the root keeps its place (see SettleReuse).
    let reusing = reuse && keep && previous?.nodes[rootId] && prior.x === position.x && prior.y === position.y ? reuse : undefined;
    let order = collectOrder(doc, rootId, sizes, reusing?.dirty);
    if (reusing && order.some((entry) => typeof entry === 'string' && (!reusing!.boxes.has(entry) || !previous!.nodes[entry]))) {
      // A node of a clean main branch without a box or placement to take over: lay the root out as usual.
      reusing = undefined;
      order = collectOrder(doc, rootId, sizes);
    }
    const entries = reusing ? order.filter((entry): entry is VisibleNode => typeof entry !== 'string') : order as VisibleNode[];
    const root = boxFor(entries[0], position.x, position.y, layout === 'up' ? -1 : 0, layoutFlow(layout));
    boxes.set(rootId, root);
    if (!keep || !previous?.nodes[rootId]) {
      const occupied = resolveOverlaps ? new Occupancy() : undefined;
      occupied?.add(root);
      for (const entry of entries.slice(1)) {
        const box = natural().boxes.get(entry.id);
        if (!box) continue;
        const parent = boxes.get(entry.parent!)!;
        const naturalParent = natural().boxes.get(entry.parent!)!;
        const candidate = occupied
          ? { ...box, x: box.x + parent.x - naturalParent.x, y: box.y + parent.y - naturalParent.y }
          : box;
        const placed = occupied?.makeRoom(candidate, local.siblingGap) ?? candidate;
        occupied?.add(placed);
        boxes.set(entry.id, placed);
      }
    } else {
      const shift = { x: position.x - prior.x, y: position.y - prior.y };
      const priorRoot = previous.nodes[rootId];
      const rootGrew = root.w > priorRoot.w || root.h > priorRoot.h;
      const groups = new Map<number, VisibleNode[]>();
      for (const node of entries.slice(1)) {
        let branch = groups.get(node.branch);
        if (!branch) groups.set(node.branch, branch = []);
        branch.push(node);
      }
      const mainChildren = doc.nodes[rootId].children;
      const fold = anchor ? entries.find((entry) => entry.id === anchor && entry.depth > 1 && previous.nodes[entry.id] &&
        !!previous.nodes[entry.id]?.collapsed !== !!doc.nodes[entry.id].collapsed) : undefined;
      const besideFold = (node: VisibleNode) => fold && node.parent === fold.parent && node.index > fold.index;
      const rebalance = layout === 'mindmap' && mainChildren.some((id) => {
        const old = previous.nodes[id];
        return !old || old.parent !== rootId || old.siblingCount !== mainChildren.length;
      });
      const dirty: { nodes: VisibleNode[]; rebuild: boolean; reflow: boolean; variants: Set<NodeId> }[] = [];
      const clean: NodeBox[] = [root];
      if (reusing) {
        for (const entry of order) if (typeof entry === 'string') clean.push(reusing.boxes.get(entry)!);
      }
      for (const nodes of groups.values()) {
        const branch = nodes[0];
        const priorBranch = previous.nodes[branch.id];
        const model = doc.nodes[branch.id];
        const kind = model.branchLayout ?? layout;
        const variants = new Set<NodeId>();
        if (!collection) for (const node of nodes) {
          const old = previous.nodes[node.id];
          if (old && old.branchLayout !== doc.nodes[node.id].branchLayout) {
            invalidateDescendants(node.id);
            if (node.depth > 1) variants.add(node.id);
          }
        }
        const reflow = !collection && !variants.size && fold?.branch !== branch.branch && (kind === 'outline' || kind === 'compact');
        const rebuild = !priorBranch || priorBranch.parent !== rootId ||
          (!collection && (priorBranch.branchLayout !== model.branchLayout || priorBranch.pinnedSide !== model.side)) ||
          rebalance && natural().boxes.get(branch.id)?.side !== priorBranch.side;
        const changed = rebuild || variants.size || nodes.some((node) => {
          const old = previous.nodes[node.id];
          return besideFold(node) || !old || old.root !== rootId || old.parent !== node.parent || old.w !== node.w || old.h !== node.h ||
            old.offsetX !== node.offsetX || old.offsetY !== node.offsetY ||
            (rootGrew && overlaps(root, oldBox(node, old, shift))) ||
            (reflow && !!old.collapsed !== !!doc.nodes[node.id].collapsed) ||
            (node.depth > 1 && (reflow ? old.index !== node.index || old.siblingCount !== node.siblingCount
              : old.siblingCount === node.siblingCount && old.index !== node.index));
        });
        if (changed) dirty.push({ nodes, rebuild: rebuild || reflow, reflow, variants });
        else for (const node of nodes) {
          const box = oldBox(node, previous.nodes[node.id], shift);
          boxes.set(node.id, box);
          clean.push(box);
        }
      }

      if (dirty.length) {
        const occupied = new Occupancy();
        for (const b of clean) occupied.add(b);
        for (const { nodes, rebuild, reflow, variants } of dirty) {
          const main = nodes[0];
          const priorMain = previous.nodes[main.id];
          const model = doc.nodes[main.id];
          const mainBox = rebuild ? natural().boxes.get(main.id) : oldBox(main, priorMain, shift);
          if (!mainBox) continue;
          if (reflow) {
            // Move the entire group to keep its rows aligned and preserve the space between them.
            const draft = nodes.map((node) => natural().boxes.get(node.id)!);
            const bounds = worldBounds(draft);
            const footprint = { ...mainBox, ...bounds, x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 };
            const slot = occupied.makeRoom(footprint, local.siblingGap);
            for (const b of draft) {
              const box = { ...b, x: b.x + (slot.x - footprint.x), y: b.y + (slot.y - footprint.y) };
              occupied.add(box);
              boxes.set(box.id, box);
            }
            continue;
          }
          const independent = rebuild || collection ? undefined : layoutMainBranch(doc, main.id, sizes, local, model.branchLayout ?? branchKind(layout, mainBox.side));
          const drafts = collection && !rebuild ? natural().boxes : new Map(independent?.map((box) => [box.id, box]));
          const kept = new Map<NodeId, NodeBox>();
          const attached = new Set<NodeId>();
          const shifting = new Set<NodeId>();
          const changedVariant = new Set<NodeId>();
          if (fold) for (const node of nodes) {
            if (besideFold(node) || (node.parent && shifting.has(node.parent))) shifting.add(node.id);
          }
          if (variants.size) for (const node of nodes) {
            if (node.parent && (variants.has(node.parent) || changedVariant.has(node.parent))) changedVariant.add(node.id);
          }
          if (!rebuild) for (const node of nodes) {
            const old = previous.nodes[node.id];
            if (old?.root === rootId && old.parent === node.parent &&
                (node.depth === 1 || (attached.has(node.parent!) && (old.siblingCount !== node.siblingCount || old.index === node.index)))) {
              attached.add(node.id);
            }
          }
          const isKept = (node: VisibleNode) => attached.has(node.id);
          const anchored = anchor ? nodes.find((node) => node.id === anchor && isKept(node)) : undefined;
          const order = anchored ? [anchored, ...nodes.filter((node) => node !== anchored)] : nodes;
          // Reserve all reusable positions first, so adding a node never evicts a sibling that still fits.
          for (const node of order) {
            if (!isKept(node) || shifting.has(node.id) || changedVariant.has(node.id)) continue;
            // A descendant cannot reserve its old slot until we know where its parent fits.
            if (node !== anchored && node.depth > 1 && !kept.has(node.parent!)) continue;
            const old = previous.nodes[node.id];
            const candidate = oldBox(node, old, shift);
            const manuallyMoved = old.offsetX !== node.offsetX || old.offsetY !== node.offsetY;
            if (manuallyMoved || !occupied.blockers(candidate).length) {
              occupied.add(candidate);
              boxes.set(node.id, candidate);
              kept.set(node.id, candidate);
            }
          }
          for (const node of nodes) {
            if (kept.has(node.id)) continue;
            let candidate = rebuild ? natural().boxes.get(node.id)! : drafts.get(node.id)!;
            if (!candidate) continue;
            const parent = node.parent ? boxes.get(node.parent) : undefined;
            const followParent = parent && node.depth > 1 && isKept(node) && !kept.has(parent.id) && !changedVariant.has(node.id);
            if (followParent) {
              // Keep the established child-parent vector when an edit displaces the parent.
              // The stored offsets are cumulative, so add only this child's own offset change.
              const old = previous.nodes[node.id];
              const oldParent = previous.nodes[parent.id];
              const own = doc.nodes[node.id].offset;
              candidate = boxFor(node,
                parent.x + (old.x - oldParent.x) + (own?.x ?? 0) - (old.offsetX - oldParent.offsetX),
                parent.y + (old.y - oldParent.y) + (own?.y ?? 0) - (old.offsetY - oldParent.offsetY),
                old.side, old.flow);
            } else if (!rebuild) {
              const draftParent = node.parent && drafts.get(node.parent);
              const x = parent && draftParent ? candidate.x + parent.x - draftParent.x : mainBox.x;
              const y = parent && draftParent ? candidate.y + parent.y - draftParent.y : mainBox.y;
              const side = node.depth === 1 ? mainBox.side : candidate.side;
              candidate = boxFor(node, x, y, side, node.depth === 1 ? mainBox.flow : candidate.flow);
              if (fold && besideFold(node)) {
                const fixed = boxes.get(fold.id), draftFold = drafts.get(fold.id);
                const desired = drafts.get(node.id);
                if (fixed && draftFold && desired) {
                  if (candidate.flow !== 'h') candidate.x = fixed.x + desired.x - draftFold.x;
                  if (candidate.flow !== 'v') candidate.y = fixed.y + desired.y - draftFold.y;
                }
              }
            }
            const slot = followParent && doc.nodes[node.id].offset ? candidate : occupied.makeRoom(candidate, local.siblingGap);
            occupied.add(slot);
            boxes.set(node.id, slot);
          }
        }
      }
    }
    const pinShifts = new Map<NodeId, Vec2>();
    for (const entry of order) {
      if (typeof entry === 'string') {
        // A clean main branch: the box and placement of the previous pass (pins there are already applied).
        ordered.set(entry, reuse!.boxes.get(entry)!);
        saved[entry] = previous!.nodes[entry];
        continue;
      }
      let box = boxes.get(entry.id);
      if (!box) continue;
      const node = doc.nodes[entry.id];
      const pin = entry.parent === null ? undefined : node.pinnedPosition;
      const shift = pin ? { x: pin.x - box.x, y: pin.y - box.y } : entry.parent ? pinShifts.get(entry.parent) : undefined;
      if (shift) {
        pinShifts.set(entry.id, shift);
        if (shift.x || shift.y) {
          box = { ...box, x: box.x + shift.x, y: box.y + shift.y };
          boxes.set(entry.id, box);
        }
      }
      // An unmoved box keeps its object from the previous pass, so later stages can tell it did not change.
      const before = reuse?.boxes.get(entry.id);
      if (before && before !== box && sameBox(before, box)) box = before;
      ordered.set(entry.id, box);
      saved[entry.id] = {
        root: rootId, parent: entry.parent, index: entry.index, siblingCount: entry.siblingCount,
        x: box.x, y: box.y, w: box.w, h: box.h,
        offsetX: entry.offsetX, offsetY: entry.offsetY, side: box.side, flow: box.flow,
        ...(node.branchLayout ? { branchLayout: node.branchLayout } : {}),
        ...(entry.depth === 1 ? { pinnedSide: node.side } : {}),
        ...(node.collapsed ? { collapsed: true } : {})
      };
    }
  }
  if (previous) for (const id in previous.nodes) {
    const placement = previous.nodes[id];
    const nextRoot = roots[placement.root];
    const oldRoot = previous.roots[placement.root];
    if (!saved[id] && doc.nodes[id] && !staleSlots.has(id) && !reorderedRoots.has(placement.root) &&
        nextRoot && oldRoot && nextRoot.layout === oldRoot.layout &&
        nextRoot.levelGap === oldRoot.levelGap && nextRoot.siblingGap === oldRoot.siblingGap &&
        nextRoot.organicSeed === oldRoot.organicSeed) {
      const dx = nextRoot.x - oldRoot.x;
      const dy = nextRoot.y - oldRoot.y;
      saved[id] = dx || dy ? { ...placement, x: placement.x + dx, y: placement.y + dy } : placement;
    }
  }

  return { boxes: ordered, bounds: worldBounds(ordered.values()), placements: { roots, nodes: saved } };
}
