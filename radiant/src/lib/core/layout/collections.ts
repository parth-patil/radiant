import type { LayoutKind, LayoutOptions, NodeId } from '../types';

export const COLLECTION_LAYOUTS = ['timeline', 'columns', 'grid', 'popcorn'] as const;
type CollectionLayout = typeof COLLECTION_LAYOUTS[number];

export function isCollectionLayout(kind: LayoutKind): kind is CollectionLayout {
  return (COLLECTION_LAYOUTS as readonly LayoutKind[]).includes(kind);
}

interface BranchGroup {
  nodes: number[];
  width: number;
  height: number;
}

function fraction(id: NodeId, seed: number): number {
  let hash = seed | 0;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 0xffffffff;
}

/** Board modes pack ordered main-branch groups. Each group is an indented list of its visible tree. */
export function layoutCollection(
  kind: CollectionLayout, ids: readonly NodeId[], childStart: readonly number[], childCount: readonly number[],
  w: readonly number[], h: readonly number[], depth: Int32Array, x: Float64Array, y: Float64Array,
  options: LayoutOptions, seed: number
): void {
  const groups: BranchGroup[] = [];
  const gap = Math.max(12, options.levelGap);
  const rowGap = Math.max(8, options.siblingGap);
  for (let main = childStart[0]; main < childStart[0] + childCount[0]; main++) {
    const group: BranchGroup = { nodes: [], width: 0, height: 0 };
    const stack = [main];
    while (stack.length) {
      const i = stack.pop()!;
      const indent = Math.min(5, depth[i] - 1) * rowGap;
      x[i] = indent + w[i] / 2;
      y[i] = group.height + h[i] / 2;
      group.width = Math.max(group.width, indent + w[i]);
      group.height += h[i] + rowGap;
      group.nodes.push(i);
      for (let j = childCount[i] - 1; j >= 0; j--) stack.push(childStart[i] + j);
    }
    group.height -= rowGap;
    groups.push(group);
  }
  const translate = (group: BranchGroup, dx: number, dy: number) => {
    for (const i of group.nodes) {
      x[i] += dx;
      y[i] += dy;
    }
  };
  if (kind === 'timeline' || kind === 'columns') {
    let nextX = w[0] / 2 + gap;
    for (const group of groups) {
      // Timeline aligns the topic centres on one axis. Columns align the tops of their cards.
      translate(group, nextX, kind === 'timeline' ? -y[group.nodes[0]] : -h[0] / 2);
      nextX += group.width + gap;
    }
    return;
  }

  const count = Math.ceil(Math.sqrt(groups.length));
  let cellWidth = 0;
  for (const group of groups) cellWidth = Math.max(cellWidth, group.width);
  const left = -(count * cellWidth + Math.max(0, count - 1) * gap) / 2;
  const top = h[0] / 2 + gap;
  if (kind === 'grid') {
    let rowY = top;
    for (let i = 0; i < groups.length; i += count) {
      let rowHeight = 0;
      for (let col = 0; col < count && i + col < groups.length; col++) {
        const group = groups[i + col];
        translate(group, left + col * (cellWidth + gap), rowY);
        rowHeight = Math.max(rowHeight, group.height);
      }
      rowY += rowHeight + gap;
    }
    return;
  }

  // Popcorn places the next group in the shortest column and varies its inset deterministically.
  const lanes = new Float64Array(count).fill(top);
  for (const group of groups) {
    let col = 0;
    for (let i = 1; i < count; i++) if (lanes[i] < lanes[col]) col = i;
    const jitter = fraction(ids[group.nodes[0]], seed);
    const start = lanes[col] + gap * jitter;
    translate(group, left + col * (cellWidth + gap) + (cellWidth - group.width) * jitter, start);
    lanes[col] = start + group.height + gap;
  }
}
