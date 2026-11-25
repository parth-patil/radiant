/** Small colour helpers shared by style sheets and the SVG validator. Pure. */

export interface Rgb {
  r: number; // 0..255
  g: number;
  b: number;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a', gray: '#808080', grey: '#808080',
  cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00', navy: '#000080', teal: '#008080', maroon: '#800000',
  olive: '#808000', silver: '#c0c0c0', gold: '#ffd700', beige: '#f5f5dc', ivory: '#fffff0', tan: '#d2b48c',
  coral: '#ff7f50', salmon: '#fa8072', crimson: '#dc143c', indigo: '#4b0082', violet: '#ee82ee',
};

/** Values that are not colours to check (no paint, inherited, references). */
export function isNonColour(v: string): boolean {
  const s = v.trim().toLowerCase();
  return s === '' || s === 'none' || s === 'transparent' || s === 'currentcolor' || s === 'inherit' || s.startsWith('url(');
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const hh = ((h % 360) + 360) % 360;
  const ss = Math.min(1, Math.max(0, s));
  const ll = Math.min(1, Math.max(0, l));
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = ll - c / 2;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === rr ? ((gg - bb) / d) % 6 : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const x = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
  return `#${x(r)}${x(g)}${x(b)}`;
}

/** Parses #rgb, #rrggbb, rgb(), rgba(), hsl(), hsla() (comma or space syntax) and a few names. Null if unknown. */
export function parseColor(input: string): Rgb | null {
  let s = input.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  let m = /^#([0-9a-f]{3,4})$/.exec(s);
  if (m) {
    const h = m[1];
    return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) };
  }
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) };
  m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(s);
  if (m) {
    const parts = m[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (p: string, pct = 1) => (p.endsWith('%') ? (parseFloat(p) / 100) * pct : parseFloat(p));
    if (m[1].startsWith('rgb')) {
      const v = parts.slice(0, 3).map((p) => num(p, 255));
      return v.some((n) => !Number.isFinite(n)) ? null : { r: v[0], g: v[1], b: v[2] };
    }
    const h = parseFloat(parts[0]);
    const sat = num(parts[1]);
    const lig = num(parts[2]);
    const sN = parts[1].endsWith('%') ? sat : sat > 1 ? sat / 100 : sat;
    const lN = parts[2].endsWith('%') ? lig : lig > 1 ? lig / 100 : lig;
    return [h, sN, lN].some((n) => !Number.isFinite(n)) ? null : hslToRgb(h, sN, lN);
  }
  return null;
}

export function colorDistance(a: Rgb, b: Rgb): number {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}
