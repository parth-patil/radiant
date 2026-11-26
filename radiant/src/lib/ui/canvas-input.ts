import { DEFAULT_CANVAS_GESTURES, type CanvasGestures } from '../render/camera';
import { getSetting, setSetting } from './settings';

const KEY = 'radiant.canvasGestures';

export function loadCanvasGestures(): CanvasGestures {
  const result = { ...DEFAULT_CANVAS_GESTURES };
  try {
    const input = JSON.parse(getSetting(KEY) ?? 'null');
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
  setSetting(KEY, JSON.stringify(settings));
}
