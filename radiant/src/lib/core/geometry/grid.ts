/**
 * Uniform-grid spatial index over axis-aligned boxes (world coordinates, doubles).
 * Built when the scene changes; queried every frame. Query results are ascending item indices,
 * so draw order (scene order) is preserved.
 */
export class GridIndex {
  private minX = 0;
  private minY = 0;
  private cell = 1;
  private cols = 0;
  private rows = 0;
  private offsets = new Uint32Array(1);
  private items = new Uint32Array(0);
  private big: number[] = [];
  private boxes: Float64Array = new Float64Array(0);
  private baseBoxes: Float64Array = this.boxes;
  private moved = new Set<number>();
  private n = 0;
  private stamp = new Uint32Array(0);
  private stampId = 0;
  /** Reusable result buffer (valid until the next query). */
  private out = new Uint32Array(0);
  /** Extent of every current box (min and max over both corners), and 0..n-1, for queries that contain it all. */
  private ext = [0, 0, 0, 0];
  private all: Uint32Array | null = null;

  get size(): number {
    return this.n;
  }

  /** boxes: [minX, minY, maxX, maxY] per item. */
  build(boxes: Float64Array, n: number): void {
    this.boxes = this.baseBoxes = boxes;
    this.n = n;
    this.big = [];
    this.moved.clear();
    this.stamp = new Uint32Array(n);
    this.stampId = 0;
    this.out = new Uint32Array(n);
    this.all = null;
    this.measure(boxes, n);
    if (n === 0) {
      this.cols = this.rows = 0;
      this.offsets = new Uint32Array(1);
      this.items = new Uint32Array(0);
      return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sum = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (boxes[o] < x0) x0 = boxes[o];
      if (boxes[o + 1] < y0) y0 = boxes[o + 1];
      if (boxes[o + 2] > x1) x1 = boxes[o + 2];
      if (boxes[o + 3] > y1) y1 = boxes[o + 3];
      sum += Math.max(boxes[o + 2] - boxes[o], boxes[o + 3] - boxes[o + 1]);
    }
    const span = Math.max(x1 - x0, y1 - y0, 1);
    this.minX = x0;
    this.minY = y0;
    this.cell = Math.max((sum / n) * 2, 16, span / 400);
    this.cols = Math.floor((x1 - x0) / this.cell) + 1;
    this.rows = Math.floor((y1 - y0) / this.cell) + 1;
    const cells = this.cols * this.rows;
    const counts = new Uint32Array(cells + 1);
    const cell = this.cell;
    const MAXCELLS = 64;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const cx0 = Math.floor((boxes[o] - x0) / cell), cx1 = Math.floor((boxes[o + 2] - x0) / cell);
      const cy0 = Math.floor((boxes[o + 1] - y0) / cell), cy1 = Math.floor((boxes[o + 3] - y0) / cell);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAXCELLS) {
        this.big.push(i);
        continue;
      }
      for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) counts[cy * this.cols + cx + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.offsets = counts;
    const fill = counts.slice(0, cells);
    this.items = new Uint32Array(counts[cells]);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      const cx0 = Math.floor((boxes[o] - x0) / cell), cx1 = Math.floor((boxes[o + 2] - x0) / cell);
      const cy0 = Math.floor((boxes[o + 1] - y0) / cell), cy1 = Math.floor((boxes[o + 3] - y0) / cell);
      if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > MAXCELLS) continue;
      for (let cy = cy0; cy <= cy1; cy++)
        for (let cx = cx0; cx <= cx1; cx++) this.items[fill[cy * this.cols + cx]++] = i;
    }
  }

  /** Small edits keep the cell directory. Changed slots are tested at their new bounds. */
  update(boxes: Float64Array, n: number): void {
    if (n !== this.n) {
      this.build(boxes, n);
      return;
    }
    const moved = new Set<number>();
    const limit = Math.min(32, n / 4);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (boxes[o] === this.baseBoxes[o] && boxes[o + 1] === this.baseBoxes[o + 1] &&
          boxes[o + 2] === this.baseBoxes[o + 2] && boxes[o + 3] === this.baseBoxes[o + 3]) continue;
      moved.add(i);
      if (moved.size > limit) {
        this.build(boxes, n);
        return;
      }
    }
    this.boxes = boxes;
    this.moved = moved;
    this.measure(boxes, n);
  }

  private measure(boxes: Float64Array, n: number): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let o = 0; o < n * 4; o += 4) {
      const a = boxes[o], b = boxes[o + 1], c = boxes[o + 2], d = boxes[o + 3];
      if (a < x0) x0 = a;
      if (c < x0) x0 = c;
      if (a > x1) x1 = a;
      if (c > x1) x1 = c;
      if (b < y0) y0 = b;
      if (d < y0) y0 = d;
      if (b > y1) y1 = b;
      if (d > y1) y1 = d;
    }
    const e = this.ext;
    e[0] = x0;
    e[1] = y0;
    e[2] = x1;
    e[3] = y1;
  }

  /** Indices of items whose box intersects the query rect, ascending. */
  query(qx0: number, qy0: number, qx1: number, qy1: number): Uint32Array {
    if (this.n === 0) return this.out.subarray(0, 0);
    // Every box inside the query (the whole map in view): all items, without visiting a cell.
    const e = this.ext;
    if (qx0 <= e[0] && qy0 <= e[1] && qx1 >= e[2] && qy1 >= e[3]) {
      if (!this.all) {
        this.all = new Uint32Array(this.n);
        for (let i = 0; i < this.n; i++) this.all[i] = i;
      }
      return this.all;
    }
    this.stampId++;
    if (this.stampId === 0xffffffff) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const id = this.stampId;
    const b = this.boxes;
    const out = this.out;
    let count = 0;
    const cell = this.cell;
    let cx0 = Math.floor((qx0 - this.minX) / cell), cx1 = Math.floor((qx1 - this.minX) / cell);
    let cy0 = Math.floor((qy0 - this.minY) / cell), cy1 = Math.floor((qy1 - this.minY) / cell);
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= this.cols) cx1 = this.cols - 1;
    if (cy1 >= this.rows) cy1 = this.rows - 1;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.cols + cx;
        for (let k = this.offsets[c], e = this.offsets[c + 1]; k < e; k++) {
          const i = this.items[k];
          if (this.stamp[i] === id || this.moved.has(i)) continue;
          this.stamp[i] = id;
          const o = i * 4;
          if (b[o] > qx1 || b[o + 2] < qx0 || b[o + 1] > qy1 || b[o + 3] < qy0) continue;
          out[count++] = i;
        }
      }
    }
    for (const i of this.big) {
      if (this.moved.has(i)) continue;
      const o = i * 4;
      if (b[o] > qx1 || b[o + 2] < qx0 || b[o + 1] > qy1 || b[o + 3] < qy0) continue;
      out[count++] = i;
    }
    for (const i of this.moved) {
      const o = i * 4;
      if (b[o] > qx1 || b[o + 2] < qx0 || b[o + 1] > qy1 || b[o + 3] < qy0) continue;
      out[count++] = i;
    }
    const res = out.subarray(0, count);
    res.sort();
    return res;
  }
}
