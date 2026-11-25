import { DEFAULT_CANVAS_GESTURES, type CanvasGestures } from '../render/camera';

const KEY = 'radiant.canvasGestures';

export function loadCanvasGestures(): CanvasGestures {
  const result = { ...DEFAULT_CANVAS_GESTURES };
  try {
    const input = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!input) return result;
    if (['pan', 'zoom', 'off'].includes(input.wheel)) result.wheel = input.wheel;
    if (['command-or-option', 'command', 'option', 'shift', 'off'].includes(input.zoomModifier)) result.zoomModifier = input.zoomModifier;
    for (const key of ['pinch', 'space', 'middle'] as const) {
      if (typeof input[key] === 'boolean') result[key] = input[key];
    }
  } catch { /* Use the defaults when the preference is unavailable. */ }
  return result;
}

export function saveCanvasGestures(settings: CanvasGestures): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* Keep the current session’s settings. */ }
}
