import type { CameraState, Mesh, Scene } from '../core/types';
import { GridIndex } from '../core/geometry/grid';
import { branchIndex } from '../core/geometry/branch-index';
import { estimateExtent } from './text';

export type FrameBounds = [x0: number, y0: number, x1: number, y1: number];

/** Primitives admitted for drawing, in the same back-to-front order as the scene. */
export class SceneViewport {
  private rectGrid = new GridIndex();
  private labelGrid = new GridIndex();
  private imageGrid = new GridIndex();

  update(scene: Scene): void {
    const { rects, labels, images } = scene;
    let b = new Float64Array(rects.length * 4);
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      let m = (r.strokeWidth ?? 0) / 2 + Math.max(Math.abs(r.wobble?.x ?? 0), Math.abs(r.wobble?.y ?? 0));
      // A soft shadow reaches three standard deviations past its offset box.
      if (r.shadow) m = Math.max(m, 3 * r.shadow.blur + Math.abs(r.shadow.dy));
      b[i * 4] = r.x - m;
      b[i * 4 + 1] = r.y - m;
      b[i * 4 + 2] = r.x + r.w + m;
      b[i * 4 + 3] = r.y + r.h + m;
    }
    this.rectGrid.update(b, rects.length);
    b = new Float64Array(labels.length * 4);
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      const e = estimateExtent(l);
      const hw = e.w / 2 + l.fontSize, hh = e.h / 2 + l.fontSize * 0.5;
      b[i * 4] = l.x - hw;
      b[i * 4 + 1] = l.y - hh;
      b[i * 4 + 2] = l.x + hw;
      b[i * 4 + 3] = l.y + hh;
    }
    this.labelGrid.update(b, labels.length);
    b = new Float64Array(images.length * 4);
    for (let i = 0; i < images.length; i++) {
      const m = images[i];
      b[i * 4] = m.x - m.w / 2;
      b[i * 4 + 1] = m.y - m.h / 2;
      b[i * 4 + 2] = m.x + m.w / 2;
      b[i * 4 + 3] = m.y + m.h / 2;
    }
    this.imageGrid.update(b, images.length);
  }

  query({ cx, cy, zoom }: CameraState, width: number, height: number, margin: number) {
    const halfW = (width / 2 + margin) / zoom;
    const halfH = (height / 2 + margin) / zoom;
    const bounds: FrameBounds = [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
    return { bounds, rects: this.rectGrid.query(...bounds), images: this.imageGrid.query(...bounds),
      labels: this.labelGrid.query(...bounds) };
  }
}

/** Unindexed meshes, such as the editing overlay, are submitted whole. */
export function visibleBranchSpans(mesh: Mesh, bounds: FrameBounds): Uint32Array | undefined {
  return branchIndex(mesh)?.query(...bounds);
}
