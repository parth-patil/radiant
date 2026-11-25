/**
 * Non-layered tidy layout (van der Ploeg, 2014). Contour threads link the outside edges of
 * sibling groups, and deferred shifts spread extra room over intervening siblings in one sweep.
 * Every traversal is iterative, including position resolution for very deep maps.
 * Uses the initial-separation correction described at https://github.com/cwi-swat/non-layered-tidy-trees.
 *
 * Struct of arrays: every per-node field is a typed array indexed by the node's breadth-first index, and contour
 * threads are indices (-1 = none). Same arithmetic in the same order as the object version it replaces, so the
 * positions are bit-identical; it allocates a few arrays per call instead of one object per node.
 */

type Spacing = (left: number, right: number) => number;

/** Breadth-first input; each node's children occupy a contiguous slice. */
export function tidyTree(
  childStart: number[], childCount: number[], boxMain: number[], boxCross: number[], levelGap: number, spacing: Spacing,
  rootGroups: (children: number[], extentOf: (index: number) => number) => number[][]
): { main: Float64Array; cross: Float64Array } {
  const n = boxMain.length;
  const main = new Float64Array(n);
  const cross = new Float64Array(n);
  const cs = Int32Array.from(childStart), cc = Int32Array.from(childCount), span = Float64Array.from(boxCross);
  const bottom = new Float64Array(n), prelim = new Float64Array(n), offset = new Float64Array(n);
  const shift = new Float64Array(n), change = new Float64Array(n);
  const leftOffset = new Float64Array(n), rightOffset = new Float64Array(n);
  // Ends of the contours (left, right) and the threads that continue them below a subtree.
  const left = new Int32Array(n), right = new Int32Array(n);
  const leftThread = new Int32Array(n).fill(-1), rightThread = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) left[i] = right[i] = i;
  // The stack of lowest preceding siblings while a sibling list is arranged (bottom and position in the list).
  const lowBottom = new Float64Array(n + 1), lowIndex = new Int32Array(n + 1);
  // Children are contiguous, so a node's sibling list is a slice of the identity order.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  /** Separate sibling `list[base + at]` from its left siblings; `top` is the top of the low-siblings stack. */
  const separate = (list: Int32Array, base: number, at: number, top: number): void => {
    const next = list[base + at], previous = list[base + at - 1];
    let contourLeft = previous, contourRight = next;
    let lo = offset[previous], ro = offset[next];
    let firstComparison = true;
    let low = top;
    while (contourLeft >= 0 && contourRight >= 0) {
      while (low > 0 && bottom[contourLeft] > lowBottom[low]) low--;
      const distance = (lo + prelim[contourLeft]) - (ro + prelim[contourRight]) +
        span[contourLeft] / 2 + span[contourRight] / 2 + spacing(contourLeft, contourRight);
      if (distance > 0 || (distance < 0 && firstComparison)) {
        ro += distance;
        offset[next] += distance;
        leftOffset[next] += distance;
        rightOffset[next] += distance;
        const count = at - lowIndex[low];
        if (count > 1) {
          const step = distance / count;
          shift[list[base + lowIndex[low] + 1]] += step;
          shift[next] -= step;
          change[next] -= distance - step;
        }
      }
      firstComparison = false;

      const leftBottom = bottom[contourLeft], rightBottom = bottom[contourRight];
      if (leftBottom <= rightBottom) {
        const count = cc[contourLeft];
        contourLeft = count ? cs[contourLeft] + count - 1 : rightThread[contourLeft];
        if (contourLeft >= 0) lo += offset[contourLeft];
      }
      if (rightBottom <= leftBottom) {
        contourRight = cc[contourRight] ? cs[contourRight] : leftThread[contourRight];
        if (contourRight >= 0) ro += offset[contourRight];
      }
    }

    if (contourRight >= 0) {
      const first = list[base];
      const end = left[first];
      leftThread[end] = contourRight;
      const adjustment = ro - offset[contourRight] - leftOffset[first];
      offset[end] += adjustment;
      prelim[end] -= adjustment;
      left[first] = left[next];
      leftOffset[first] = leftOffset[next];
    } else if (contourLeft >= 0) {
      const end = right[next];
      rightThread[end] = contourLeft;
      const adjustment = lo - offset[contourLeft] - rightOffset[next];
      offset[end] += adjustment;
      prelim[end] -= adjustment;
      right[next] = right[previous];
      rightOffset[next] = rightOffset[previous];
    }
  };

  /** Arrange the siblings `list[base]`..`list[base + count - 1]`; returns the parent's preliminary position. */
  const arrange = (list: Int32Array, base: number, count: number): number => {
    if (count === 0) return 0;
    let top = -1;
    for (let i = 0; i < count; i++) {
      const child = list[base + i];
      const childBottom = bottom[i === 0 ? left[child] : right[child]];
      if (top >= 0) separate(list, base, i, top);
      while (top >= 0 && childBottom >= lowBottom[top]) top--;
      top++;
      lowBottom[top] = childBottom;
      lowIndex[top] = i;
    }
    let sum = 0, total = 0;
    for (let i = 0; i < count; i++) {
      const child = list[base + i];
      sum += shift[child];
      total += sum + change[child];
      offset[child] += total;
    }
    const first = list[base], last = list[base + count - 1];
    return (prelim[first] + offset[first] - span[first] / 2 + prelim[last] + offset[last] + span[last] / 2) / 2;
  };

  const stackNode = new Int32Array(n), stackOffset = new Float64Array(n);
  /** Measure an independently arranged subtree before linking it to its root siblings. */
  const extent = (root: number): number => {
    if (!cc[root]) return span[root];
    let min = Infinity, max = -Infinity;
    stackNode[0] = root;
    stackOffset[0] = offset[root];
    let size = 1;
    while (size) {
      size--;
      const node = stackNode[size], at = stackOffset[size];
      const position = at + prelim[node];
      min = Math.min(min, position - span[node] / 2);
      max = Math.max(max, position + span[node] / 2);
      for (let k = cs[node], end = cs[node] + cc[node]; k < end; k++) {
        stackNode[size] = k;
        stackOffset[size] = at + offset[k];
        size++;
      }
    }
    return max - min;
  };

  bottom[0] = boxMain[0] + levelGap;
  for (let i = 0; i < n; i++) {
    const count = cc[i];
    if (!count) continue;
    for (let k = cs[i], end = cs[i] + count; k < end; k++) {
      main[k] = bottom[i] + boxMain[k] / 2 - boxMain[0] / 2;
      bottom[k] = bottom[i] + boxMain[k] + levelGap;
    }
  }
  for (let i = n - 1; i > 0; i--) {
    const count = cc[i];
    if (!count) continue;
    const first = cs[i], last = cs[i] + count - 1;
    prelim[i] = arrange(order, first, count);
    left[i] = left[first];
    leftOffset[i] = leftOffset[first];
    right[i] = right[last];
    rightOffset[i] = rightOffset[last];
  }

  const rootChildren: number[] = [];
  for (let k = cs[0], end = cs[0] + cc[0]; k < end && cc[0]; k++) rootChildren.push(k);
  for (const indexes of rootGroups(rootChildren, extent)) {
    const siblings = Int32Array.from(indexes);
    const origin = arrange(siblings, 0, siblings.length);
    let size = 0;
    for (let i = 0; i < siblings.length; i++) {
      stackNode[size] = siblings[i];
      stackOffset[size] = offset[siblings[i]] - origin;
      size++;
    }
    while (size) {
      size--;
      const node = stackNode[size], at = stackOffset[size];
      cross[node] = at + prelim[node];
      for (let k = cs[node], end = cs[node] + cc[node]; k < end; k++) {
        stackNode[size] = k;
        stackOffset[size] = at + offset[k];
        size++;
      }
    }
  }
  return { main, cross };
}
