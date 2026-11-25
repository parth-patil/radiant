import type { CameraState, Rect, Scene } from '../types';

/** World rectangle visible through a viewport of `viewportW` x `viewportH` CSS px, grown by `margin` world units. */
export function visibleRect(camera: CameraState, viewportW: number, viewportH: number, margin = 0): Rect {
  const w = viewportW / camera.zoom,
    h = viewportH / camera.zoom;
  return { x: camera.cx - w / 2 - margin, y: camera.cy - h / 2 - margin, w: w + margin * 2, h: h + margin * 2 };
}

function hit(x: number, y: number, w: number, h: number, r: Rect): boolean {
  return x <= r.x + r.w && x + w >= r.x && y <= r.y + r.h && y + h >= r.y;
}

/**
 * Drop rects, images, labels and overlay items outside `rect`. The branch mesh is passed through untouched
 * (the GPU clips it). Label bounds are conservative: half `maxWidth` wide, 3 font sizes tall each way.
 */
export function cullScene(scene: Scene, rect: Rect): Scene {
  return {
    ...scene,
    rects: scene.rects.filter((q) => hit(q.x, q.y, q.w, q.h, rect)),
    images: scene.images.filter((q) => hit(q.x - q.w / 2, q.y - q.h / 2, q.w, q.h, rect)),
    labels: scene.labels.filter((l) =>
      hit(l.x - l.maxWidth / 2, l.y - l.fontSize * 3, l.maxWidth, l.fontSize * 6, rect)
    ),
    overlay: scene.overlay.filter((q) => hit(q.x, q.y, q.w, q.h, rect))
  };
}
