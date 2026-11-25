import type { RectDraw } from '../core/types';

/**
 * Outlines measured in screen pixels rather than world units (the presentation focus cue, PRS-11). A rectangle marked
 * here holds the outlined shape itself (in world units); the renderer draws it each frame grown by `gap` screen px with
 * a stroke `width` screen px wide, so the cue looks the same at any zoom without rebuilding the scene. Unmarked
 * rectangles draw as given. Pure TypeScript, so scene builders in workers may import it.
 */
const outlines = new WeakMap<RectDraw, { width: number; gap: number }>();

/** Mark `rect` as a screen-sized outline: `width` px stroke, `gap` px outside the shape. Returns `rect`. */
export function screenOutline<T extends RectDraw>(rect: T, width: number, gap = 0): T {
  outlines.set(rect, { width, gap });
  return rect;
}

/** The rectangle to draw at `zoom` (screen px per world unit): a marked outline in world units, else `rect` itself. */
export function outlineAt(rect: RectDraw, zoom: number): RectDraw {
  const o = outlines.get(rect);
  if (!o) return rect;
  const gap = o.gap / zoom;
  return {
    ...rect, x: rect.x - gap, y: rect.y - gap, w: rect.w + 2 * gap, h: rect.h + 2 * gap,
    radius: rect.radius + gap, strokeWidth: o.width / zoom
  };
}
