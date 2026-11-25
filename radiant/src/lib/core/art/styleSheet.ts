/**
 * The subtree art style sheet (spec: art-subtrees, "The style sheet"). It keeps a picture or SVG subtree visually
 * consistent: stored with the subtree, inherited from the nearest art ancestor, and sent with every generation
 * request. Named ArtStyleSheet to keep it apart from the map-level StyleSheet in core/types.
 */
import type { ArtStyleOverrides } from '../types';
import { hslToRgb, parseColor, rgbToHex, rgbToHsl } from './color';

export const BUZAN_ART_PRESET = 'buzan-vivid';
export const BUZAN_BRANCH_COLORS = ['#E53935', '#FB8C00', '#F2B600', '#43A047', '#1E88E5', '#8E24AA', '#00ACC1', '#EC407A'];

export interface ArtStyleSheet {
  id: string;
  name: string;
  /** The technique the art imitates, e.g. "ink and watercolour wash on paper". */
  medium: string;
  palette: {
    /** 'branch-colour': derived from the colour of the subtree root's branch (FR-ART-19). 'custom': `accents` only. */
    source: 'branch-colour' | 'custom';
    /** Named or hex colours added to (or, for custom, forming) the palette. */
    accents: string[];
    /** Upper bound on distinct colours in one image. */
    maxColours: number;
  };
  /** Line quality. */
  line: { weight: string; colour: string };
  mood: string;
  /** Level of detail, e.g. "low: one subject, no scenery". */
  detail: string;
  /** Hash of an accepted reference asset that later calls attach as a style guide. */
  referenceAsset?: string;
  /** Recurring cast and one fixed motif per concept type. */
  cast?: { mascot?: string; symbols: Record<string, string> };
  /** What the image must not contain. Always includes the default rules. */
  negative: string[];
  background: 'transparent' | 'plain';
  canvas?: { branchEmphasis: 'curved'; labels: 'keyword'; branchColors: string[] };
  /** Stored integer for SVG organic variation and engine-side randomness. */
  seed: number;
}

export function applyArtStyleOverrides(sheet: ArtStyleSheet, edits: ArtStyleOverrides): ArtStyleSheet {
  const custom = Array.isArray(edits.palette) ? edits.palette.filter((c) => typeof c === 'string' && parseColor(c)) : [];
  return ensureDefaultNegatives({
    ...sheet,
    seed: typeof edits.seed === 'number' && Number.isSafeInteger(edits.seed) ? edits.seed : sheet.seed,
    medium: typeof edits.medium === 'string' && edits.medium.trim() ? edits.medium : sheet.medium,
    mood: typeof edits.mood === 'string' && edits.mood.trim() ? edits.mood : sheet.mood,
    detail: typeof edits.detail === 'string' && edits.detail.trim() ? edits.detail : sheet.detail,
    line: typeof edits.lineWeight === 'string' && edits.lineWeight.trim() ? { ...sheet.line, weight: edits.lineWeight } : sheet.line,
    palette: custom.length ? { source: 'custom', accents: custom, maxColours: custom.length } : sheet.palette,
    background: edits.background === 'plain' || edits.background === 'transparent' ? edits.background : sheet.background,
    negative: Array.isArray(edits.negative) ? [...sheet.negative, ...edits.negative.filter((s): s is string => typeof s === 'string')] : sheet.negative
  });
}

/** FR-ART-20: present in every sheet. */
export const DEFAULT_NEGATIVE: readonly string[] = ['no text or letters', 'no watermark', 'no frame or border'];

export function ensureDefaultNegatives<T extends ArtStyleSheet>(sheet: T): T {
  const have = new Set(sheet.negative.map((n) => n.trim().toLowerCase()));
  const add = DEFAULT_NEGATIVE.filter((n) => !have.has(n));
  return add.length ? { ...sheet, negative: [...sheet.negative, ...add] } : sheet;
}

function make(p: Omit<ArtStyleSheet, 'negative' | 'background' | 'seed'> & Partial<Pick<ArtStyleSheet, 'negative' | 'background' | 'seed'>>): ArtStyleSheet {
  return {
    background: 'transparent',
    seed: 1,
    ...p,
    negative: [...(p.negative ?? []), ...DEFAULT_NEGATIVE.filter((d) => !(p.negative ?? []).includes(d))],
  };
}

const PRESET_DATA: ArtStyleSheet[] = [
  make({
    id: 'ink-sketch', name: 'Ink sketch',
    medium: 'pen and ink sketch with light cross-hatching, on a plain ground',
    palette: { source: 'branch-colour', accents: ['near-black ink', 'cream'], maxColours: 3 },
    line: { weight: 'fine to medium, slightly uneven', colour: 'near-black' },
    mood: 'thoughtful, a little witty',
    detail: 'low to medium: one subject, no scenery',
    negative: ['no realistic faces', 'no photographic rendering'],
  }),
  make({
    id: 'watercolour', name: 'Watercolour',
    medium: 'soft watercolour wash with visible paper grain and gentle edges',
    palette: { source: 'branch-colour', accents: ['warm brown', 'cream'], maxColours: 5 },
    line: { weight: 'thin, loose, optional', colour: 'dark brown' },
    mood: 'calm, curious',
    detail: 'low: one subject, no scenery',
    negative: ['no realistic faces', 'no harsh black outlines'],
  }),
  make({
    id: 'flat-vector', name: 'Flat vector',
    medium: 'flat vector illustration with solid shapes and no gradients',
    palette: { source: 'branch-colour', accents: ['off-white', 'dark navy'], maxColours: 5 },
    line: { weight: 'medium, even, rounded ends', colour: 'dark navy' },
    mood: 'clean, friendly',
    detail: 'low: simple geometric shapes, one subject',
    negative: ['no gradients', 'no photographic textures'],
  }),
  make({
    id: 'cut-paper', name: 'Cut paper',
    medium: 'layered cut-paper collage with soft drop shadows between layers',
    palette: { source: 'branch-colour', accents: ['kraft brown', 'cream'], maxColours: 5 },
    line: { weight: 'none; shapes defined by paper edges', colour: 'none' },
    mood: 'playful, tactile',
    detail: 'low to medium: 3 to 5 paper layers, one subject',
    negative: ['no outlines', 'no photographic rendering'],
  }),
  make({
    id: 'clay-3d', name: 'Clay 3D',
    medium: 'soft claymation-style 3D render with rounded forms and a matte finish',
    palette: { source: 'branch-colour', accents: ['warm white', 'soft shadow grey'], maxColours: 5 },
    line: { weight: 'none; forms defined by shading', colour: 'none' },
    mood: 'cheerful, a little humorous',
    detail: 'low: one rounded subject, soft lighting',
    negative: ['no realistic faces', 'no sharp edges'],
  }),
  make({
    id: BUZAN_ART_PRESET, name: 'Buzan vivid',
    canvas: { branchEmphasis: 'curved', labels: 'keyword', branchColors: BUZAN_BRANCH_COLORS },
    medium: 'vivid hand-drawn illustration with bold saturated colour, in the spirit of Buzan mind maps',
    palette: { source: 'branch-colour', accents: ['saturated complementary accent'], maxColours: 4 },
    line: { weight: 'bold, flowing, hand-drawn', colour: 'the branch colour, darkened' },
    mood: 'energetic, memorable, a little exaggerated',
    detail: 'low: one striking subject, strong silhouette, 3 or more colours',
    negative: ['no realistic faces', 'no clutter'],
  }),
];

export const ART_PRESET_IDS = PRESET_DATA.map((p) => p.id);

/** Fresh, editable copy of a preset (FR-ART-18). Unknown ids fall back to flat vector. */
export function artPreset(id: string): ArtStyleSheet {
  const p = PRESET_DATA.find((x) => x.id === id) ?? PRESET_DATA[2];
  return JSON.parse(JSON.stringify(p)) as ArtStyleSheet;
}

export function listArtPresets(): ArtStyleSheet[] {
  return PRESET_DATA.map((p) => artPreset(p.id));
}

/**
 * The colours a sheet resolves to for a given branch colour (FR-ART-19): the branch colour first, then a darker
 * and a lighter shade of it, then the sheet's accents that parse as colours (named ones the helper does not know
 * are left to `describeStyle`). Custom palettes return only the accents that parse.
 */
export function resolvePalette(sheet: ArtStyleSheet, branchColour?: string): string[] {
  const out: string[] = [];
  const base = branchColour ? parseColor(branchColour) : null;
  if (sheet.palette.source === 'branch-colour' && base) {
    const { h, s, l } = rgbToHsl(base);
    out.push(rgbToHex(base));
    out.push(rgbToHex(hslToRgb(h, s, Math.max(0.12, l - 0.22))));
    out.push(rgbToHex(hslToRgb(h, Math.max(0.2, s - 0.15), Math.min(0.93, l + 0.3))));
  }
  for (const a of sheet.palette.accents) {
    const c = parseColor(a);
    if (c) out.push(rgbToHex(c));
  }
  return [...new Set(out)].slice(0, Math.max(1, sheet.palette.maxColours));
}

/** A human-readable description of the sheet, for image and SVG prompts. */
export function describeStyle(sheet: ArtStyleSheet, branchColour?: string): string {
  const s = ensureDefaultNegatives(sheet);
  const lines: string[] = [`Medium: ${s.medium}.`];
  const pal = resolvePalette(s, branchColour);
  const named = s.palette.accents.filter((a) => !parseColor(a));
  const parts: string[] = [];
  if (s.palette.source === 'branch-colour') {
    parts.push(branchColour ? `built around the branch colour ${pal[0] ?? branchColour} (with its shades ${pal.slice(1, 3).join(', ')})` : 'built around the colour of the branch this subtree grows from');
  }
  if (named.length) parts.push(`accented with ${named.join(', ')}`);
  if (s.palette.source === 'custom' && pal.length) parts.push(`using ${pal.join(', ')}`);
  lines.push(`Palette: ${parts.join('; ') || 'a small, harmonious palette'}; at most ${s.palette.maxColours} colours.`);
  if (s.line.weight.toLowerCase().startsWith('none')) lines.push('Lines: no outlines; shapes are defined by colour and shading.');
  else lines.push(`Lines: ${s.line.weight}, ${s.line.colour}.`);
  lines.push(`Mood: ${s.mood}.`);
  lines.push(`Level of detail: ${s.detail}.`);
  if (s.cast?.mascot) lines.push(`Recurring character: ${s.cast.mascot} (use only where it fits the concept).`);
  const syms = Object.entries(s.cast?.symbols ?? {});
  if (syms.length) lines.push(`Recurring symbols: ${syms.map(([k, v]) => `${k} = ${v}`).join('; ')}.`);
  lines.push(`Background: ${s.background === 'transparent' ? 'fully transparent' : 'plain, single flat colour'}.`);
  lines.push(`Must not contain: ${s.negative.join('; ')}.`);
  return lines.join('\n');
}
