import type { NodeBox } from '../types';

const CELL = 144;

export function overlaps(a: NodeBox, b: NodeBox, gap = 0): boolean {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap &&
    Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap;
}

/** One key per grid cell: a number while the cell index is small enough to pack, else a string. */
const LIMIT = 2 ** 20;
function cellKey(x: number, y: number): number | string {
  return x > -LIMIT && x < LIMIT && y > -LIMIT && y < LIMIT ? (x + LIMIT) * 2 * LIMIT + (y + LIMIT) : `${x}/${y}`;
}

/** Incremental occupancy for the current root, used only when a branch has to make room. */
export class Occupancy {
  private cells = new Map<number | string, NodeBox[]>();
  private wide = new Set<NodeBox>();
  private all = new Set<NodeBox>();

  private keys(box: NodeBox, gap = 0): (number | string)[] | null {
    const x0 = Math.floor((box.x - box.w / 2 - gap) / CELL);
    const x1 = Math.floor((box.x + box.w / 2 + gap) / CELL);
    const y0 = Math.floor((box.y - box.h / 2 - gap) / CELL);
    const y1 = Math.floor((box.y + box.h / 2 + gap) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64 || !Number.isSafeInteger(x0) || !Number.isSafeInteger(y0)) return null;
    const keys: (number | string)[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(cellKey(x, y));
    return keys;
  }

  add(box: NodeBox): void {
    this.all.add(box);
    const x0 = Math.floor((box.x - box.w / 2) / CELL);
    const x1 = Math.floor((box.x + box.w / 2) / CELL);
    const y0 = Math.floor((box.y - box.h / 2) / CELL);
    const y1 = Math.floor((box.y + box.h / 2) / CELL);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64 || !Number.isSafeInteger(x0) || !Number.isSafeInteger(y0)) { this.wide.add(box); return; }
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = cellKey(x, y);
        const cell = this.cells.get(key);
        if (cell) cell.push(box);
        else this.cells.set(key, [box]);
      }
    }
  }

  remove(box: NodeBox): void {
    this.all.delete(box);
    this.wide.delete(box);
    for (const key of this.keys(box) ?? []) {
      const cell = this.cells.get(key);
      if (!cell) continue;
      const i = cell.indexOf(box);
      if (i !== -1) cell.splice(i, 1);
      if (!cell.length) this.cells.delete(key);
    }
  }

  blockers(box: NodeBox, gap = 0): NodeBox[] {
    const keys = this.keys(box, gap);
    const found = keys ? new Set(this.wide) : new Set(this.all);
    if (keys) for (const key of keys) for (const item of this.cells.get(key) ?? []) found.add(item);
    return [...found].filter((other) => overlaps(box, other, gap));
  }

  /** Keep the radial or main axis; move along its cross axis only when another node occupies the space. */
  makeRoom(box: NodeBox, gap: number): NodeBox {
    if (!this.blockers(box).length) return box;
    const vertical = box.flow !== 'v';
    const key = vertical ? 'y' : 'x';
    const extent = vertical ? 'h' : 'w';
    const seek = (direction: -1 | 1) => {
      const moved = { ...box };
      for (;;) {
        const collisions = this.blockers(moved, gap);
        if (!collisions.length) return moved;
        let edge = moved[key];
        for (const obstacle of collisions) {
          const end = obstacle[key] + direction * ((obstacle[extent] + box[extent]) / 2 + gap + 1e-5);
          edge = direction > 0 ? Math.max(edge, end) : Math.min(edge, end);
        }
        if (!Number.isFinite(edge) || edge === moved[key]) return moved;
        moved[key] = edge;
      }
    };
    const earlier = seek(-1);
    const later = seek(1);
    return box[key] - earlier[key] <= later[key] - box[key] ? earlier : later;
  }
}
