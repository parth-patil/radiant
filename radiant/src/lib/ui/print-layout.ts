import type { Rect } from '../core/types';

const MM_TO_POINTS = 72 / 25.4;
const mmSize = (w: number, h: number): [number, number] => [w * MM_TO_POINTS, h * MM_TO_POINTS];

export const PAPER_SIZES = {
  a3: { label: 'A3', dimensions: mmSize(297, 420) },
  a4: { label: 'A4', dimensions: mmSize(210, 297) },
  a5: { label: 'A5', dimensions: mmSize(148, 210) },
  letter: { label: 'US Letter', dimensions: [612, 792] as [number, number] },
  legal: { label: 'US Legal', dimensions: [612, 1008] as [number, number] },
};

export interface PrintSettings {
  paper: keyof typeof PAPER_SIZES;
  orientation: 'portrait' | 'landscape';
  marginMm: number;
  tiled: boolean;
}

export interface PrintPlan {
  paper: [number, number];
  columns: number;
  rows: number;
  page(index: number): { crop: Rect; frame: Rect };
}

export function planPrint(crop: Rect, settings: PrintSettings): PrintPlan {
  const { dimensions } = PAPER_SIZES[settings.paper];
  const paper: [number, number] = settings.orientation === 'landscape'
    ? [dimensions[1], dimensions[0]] : [...dimensions];
  const margin = settings.marginMm * MM_TO_POINTS;
  const width = paper[0] - margin * 2;
  const height = paper[1] - margin * 2;
  if (!Number.isFinite(margin) || margin < 0 || width < 36 || height < 36) {
    throw new Error('Choose margins that leave at least ½ inch of printable area on each axis.');
  }
  if (!settings.tiled) {
    const scale = Math.min(width / crop.w, height / crop.h);
    const w = crop.w * scale;
    const h = crop.h * scale;
    const frame = { x: (paper[0] - w) / 2, y: (paper[1] - h) / 2, w, h };
    return { paper, columns: 1, rows: 1, page: () => ({ crop, frame }) };
  }
  const tileW = width / 0.75;
  const tileH = height / 0.75;
  const columns = Math.ceil(crop.w / tileW);
  const rows = Math.ceil(crop.h / tileH);
  if (columns * rows > 200) throw new Error('This map exceeds 200 printed pages. Fit on one page or print a subtree.');
  const frame = { x: margin, y: margin, w: width, h: height };
  return {
    paper, columns, rows,
    page: (index) => ({
      frame,
      crop: {
        x: crop.x + index % columns * tileW,
        y: crop.y + Math.floor(index / columns) * tileH,
        w: tileW,
        h: tileH,
      },
    }),
  };
}
