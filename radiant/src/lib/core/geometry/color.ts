import type { RGBA } from '../types';

/**
 * Colour helpers. `parseColor` returns STRAIGHT (non-premultiplied) RGBA in 0..1;
 * everything that goes into a Mesh or Scene is premultiplied via `premultiply`.
 */

const NAMED: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  orange: '#ffa500',
  purple: '#800080',
  gray: '#808080',
  grey: '#808080',
  transparent: '#00000000'
};

const cache = new Map<string, RGBA>();
const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function parseHex(hex: string): RGBA | null {
  const h = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  let r: number, g: number, b: number, a = 255;
  if (h.length === 3 || h.length === 4) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
    if (h.length === 4) a = parseInt(h[3] + h[3], 16);
  } else if (h.length === 6 || h.length === 8) {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16);
  } else return null;
  return { r: r / 255, g: g / 255, b: b / 255, a: a / 255 };
}

function num(tok: string, scale: number): number {
  return tok.endsWith('%') ? (parseFloat(tok) / 100) * scale : parseFloat(tok);
}

function parseFunctional(s: string): RGBA | null {
  const m = /^(rgba?|hsla?)\(\s*([^)]*)\)$/i.exec(s);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const toks = m[2].split(/[\s,/]+/).filter(Boolean);
  if (toks.length < 3) return null;
  const a = toks.length > 3 ? clamp01(num(toks[3], 1)) : 1;
  if (kind.startsWith('rgb')) {
    const r = clamp01(num(toks[0], 255) / 255);
    const g = clamp01(num(toks[1], 255) / 255);
    const b = clamp01(num(toks[2], 255) / 255);
    return { r, g, b, a };
  }
  const h = parseFloat(toks[0]); // 'deg' suffix is ignored by parseFloat
  const sat = clamp01(num(toks[1], 1) / (toks[1].endsWith('%') ? 1 : 100));
  const lig = clamp01(num(toks[2], 1) / (toks[2].endsWith('%') ? 1 : 100));
  const [r, g, b] = hslToRgb(h, sat, lig);
  return { r, g, b, a };
}

/**
 * Parse a CSS colour: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla() and a few names.
 * Unparseable input yields opaque black. Returns straight (non-premultiplied) alpha. The result is shared
 * through a cache: do not mutate it.
 */
export function parseColor(css: string): RGBA {
  const hit = cache.get(css);
  if (hit) return hit;
  let s = css.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  const parsed = (s.startsWith('#') ? parseHex(s) : parseFunctional(s)) ?? BLACK;
  if (cache.size > 2048) cache.clear();
  cache.set(css, parsed);
  return parsed;
}

/** Straight RGBA to premultiplied RGBA (new object). */
export function premultiply(c: RGBA): RGBA {
  return { r: c.r * c.a, g: c.g * c.a, b: c.b * c.a, a: c.a };
}

/** Premultiplied colour from a CSS string, with its alpha multiplied by `alpha`. */
export function premulCss(css: string, alpha = 1): RGBA {
  const c = parseColor(css);
  const a = c.a * alpha;
  return { r: c.r * a, g: c.g * a, b: c.b * a, a };
}

/** Premultiplied colour from a straight colour, with its alpha multiplied by `alpha`. */
export function premulWithAlpha(c: RGBA, alpha: number): RGBA {
  const a = c.a * alpha;
  return { r: c.r * a, g: c.g * a, b: c.b * a, a };
}

/** Straight colour `t` of the way from `a` to `b` (0..1), channel by channel, alpha included. */
export function mixRGBA(a: RGBA, b: RGBA, t: number): RGBA {
  const k = clamp01(t);
  return { r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k, a: a.a + (b.a - a.a) * k };
}

/** CSS colour `t` of the way from `a` to `b`, as #rrggbb (or #rrggbbaa when not opaque). */
export function mixColor(a: string, b: string, t: number): string {
  const c = mixRGBA(parseColor(a), parseColor(b), t);
  const hex = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return '#' + hex(c.r) + hex(c.g) + hex(c.b) + (c.a < 1 ? hex(c.a) : '');
}

/** WCAG relative luminance uses linear sRGB channels. */
export function luminance(c: RGBA): number {
  const linear=(v:number)=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;
  return 0.2126*linear(c.r)+0.7152*linear(c.g)+0.0722*linear(c.b);
}

function over(fore:RGBA,back:RGBA,alpha=1):RGBA {
  const amount=fore.a*alpha;
  return {r:fore.r*amount+back.r*(1-amount),g:fore.g*amount+back.g*(1-amount),
    b:fore.b*amount+back.b*(1-amount),a:1};
}

export function contrastRatio(a:RGBA,b:RGBA):number {
  const x=luminance(a)+0.05,y=luminance(b)+0.05;
  return Math.max(x,y)/Math.min(x,y);
}

const readableCache=new Map<string,string>();

/** Preserve the requested ink when legible; otherwise shift its lightness toward a passing neutral. */
export function readableInk(ink:string,canvas:string,fill?:string,alpha=1):string {
  const key=[ink,canvas,fill,alpha].join('|');
  const cached=readableCache.get(key);
  if(cached)return cached;
  const bg=fill ? over(parseColor(fill),parseColor(canvas),alpha) : parseColor(canvas);
  const fg=over(parseColor(ink),bg);
  let result=ink;
  if(contrastRatio(fg,bg)<4.5){
    const white=parseColor('#fff'), black=parseColor('#000');
    const end=contrastRatio(black,bg)>contrastRatio(white,bg)?black:white;
    let lo=0,hi=1;
    result=end===black?'#000000':'#ffffff';
    for(let i=0;i<10;i++){
      const t=(lo+hi)/2;
      const rgb=[fg.r,fg.g,fg.b].map((n,j)=>Math.round(255*(n+t*([end.r,end.g,end.b][j]-n))));
      const candidate='#'+rgb.map(v=>v.toString(16).padStart(2,'0')).join('');
      if(contrastRatio(parseColor(candidate),bg)>=4.5){hi=t;result=candidate;}else lo=t;
    }
  }
  if(readableCache.size>2048)readableCache.clear();
  readableCache.set(key,result);
  return result;
}
