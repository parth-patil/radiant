import type { BranchMaterial, BranchStyle, CanvasSurface, NodeShape, ShadowSpec, Theme } from '../types';

export const THEME_SHAPES: readonly NodeShape[] = ['box', 'rectangle', 'circle', 'square', 'underline', 'none'];
export const THEME_BRANCHES: readonly BranchStyle[] = ['rounded', 'angular', 'tapered', 'organic', 'line'];
export const THEME_BRANCH_MATERIALS: readonly BranchMaterial[] = ['flat', 'clay', 'arcs', 'rope', 'quilling'];
export const THEME_FONT_FAMILIES = [
  'system-ui, sans-serif', 'Arial, sans-serif', 'Georgia, serif',
  '"Trebuchet MS", sans-serif', '"Courier New", monospace',
  // Everyday themes: macOS system fonts, none bundled; the browser falls back along each stack.
  '"Avenir Next", Avenir, system-ui, sans-serif', '"Helvetica Neue", Helvetica, Arial, sans-serif',
  '"Arial Rounded MT Bold", "Arial Rounded MT", system-ui, sans-serif', 'Futura, "Avenir Next", system-ui, sans-serif',
  '"Gill Sans", "Gill Sans MT", system-ui, sans-serif', '"DIN Alternate", "Helvetica Neue", system-ui, sans-serif'
] as const;

export type ThemeSettings = Partial<Pick<Theme,
  'background' | 'textColor' | 'rootColor' | 'rootFillColor' | 'nodeFillColor' | 'connectionColor' | 'connectionDash' |
  'branchColors' | 'levelGap' | 'siblingGap' | 'fontFamily' | 'fontSize' |
  'rootFontSize' | 'mainFontSize' | 'rootShape' | 'mainShape' | 'shape' |
  'rootBranchWidth' | 'minBranchWidth' | 'fitBranchToLabel' | 'uppercaseMainBranches' | 'curvedLabels' | 'branch' |
  'colorMainBranches' | 'branchMarkers' | 'centralImage' | 'centralPalette' | 'singleCenter' | 'keywordHints' |
  'landscapePrint' | 'showGrid' | 'lean' | 'canvasAppearance' |
  'leafTextColor' | 'rootTextColor' | 'rootStrokeColor' | 'rootRadius' | 'rootBold' | 'mainBold' | 'boxFillStrength' |
  'boxFillBase' | 'boxStrokeWidth' | 'boxRadius' | 'nodeShadow' | 'rootShadow' | 'tipTint' | 'branchGradient' |
  'fanRootJoins' | 'roundCaps' | 'evenBranches' | 'tipDots' | 'canvasSurface' | 'branchMaterial'
>>;

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** A shadow needs finite dy, blur and opacity; an invalid colour is dropped (the engine default is used). */
function parseShadow(input: unknown): ShadowSpec | undefined {
  const v = record(input);
  if (!v || !finite(v.dy) || !finite(v.blur) || !finite(v.opacity)) return;
  const out: ShadowSpec = { dy: clamp(v.dy, 0, 40), blur: clamp(v.blur, 0, 40), opacity: clamp(v.opacity, 0, 1) };
  if (isHex(v.color)) out.color = v.color;
  return out;
}

/** Keeps each valid part. An object with no valid part becomes `{}`, a plain surface that overrides the theme's. */
function parseSurface(input: unknown): CanvasSurface | undefined {
  const v = record(input);
  if (!v) return;
  const out: CanvasSurface = {};
  const dots = record(v.dots);
  if (dots && isHex(dots.color) && finite(dots.opacity)) {
    out.dots = { color: dots.color, opacity: clamp(dots.opacity, 0, 1) };
    if (finite(dots.spacing)) out.dots.spacing = clamp(dots.spacing, 8, 96);
  }
  if (Array.isArray(v.gradient) && v.gradient.length === 2 && v.gradient.every(isHex)) out.gradient = [v.gradient[0], v.gradient[1]];
  if (finite(v.vignette)) out.vignette = clamp(v.vignette, 0, 1);
  return out;
}

export function parseThemeSettings(input: unknown): ThemeSettings | undefined {
  if (!input || typeof input !== 'object') return;
  const value = input as Record<string, unknown>;
  const out: ThemeSettings = {};
  for (const key of ['background', 'textColor', 'rootColor', 'rootFillColor', 'nodeFillColor', 'connectionColor',
    'leafTextColor', 'rootTextColor', 'rootStrokeColor', 'boxFillBase'] as const) if (isHex(value[key])) out[key] = value[key];
  for (const key of ['fitBranchToLabel', 'uppercaseMainBranches', 'curvedLabels', 'colorMainBranches', 'branchMarkers', 'showGrid', 'lean', 'centralImage',
    'centralPalette', 'singleCenter', 'keywordHints', 'landscapePrint', 'rootBold', 'mainBold', 'branchGradient', 'fanRootJoins', 'roundCaps', 'evenBranches'] as const) {
    if (typeof value[key] === 'boolean') out[key] = value[key];
  }
  if (Array.isArray(value.branchColors) && value.branchColors.length && value.branchColors.every(isHex)) {
    out.branchColors = value.branchColors.slice(0, 32);
  }
  for (const [key, min, max] of [
    ['levelGap', 8, 250], ['siblingGap', 2, 150], ['fontSize', 8, 96], ['mainFontSize', 8, 96],
    ['rootFontSize', 8, 96], ['rootBranchWidth', 1, 64], ['minBranchWidth', 1, 64],
    ['tipTint', 0, 1], ['boxFillStrength', 0, 1], ['boxStrokeWidth', 0, 8]
  ] as const) {
    const n = value[key];
    if (typeof n === 'number' && Number.isFinite(n)) out[key] = Math.max(min, Math.min(max, n));
  }
  for (const key of ['rootRadius', 'boxRadius'] as const) {
    const r = value[key];
    if (r === 'pill') out[key] = r;
    else if (finite(r)) out[key] = clamp(r, 0, 64);
  }
  for (const key of ['rootShadow', 'nodeShadow'] as const) {
    const shadow = parseShadow(value[key]);
    if (shadow) out[key] = shadow;
  }
  const dots = record(value.tipDots);
  // A radius of 0 or less means "no tip dots" (it overrides a theme that has them); otherwise 1..8.
  if (dots && finite(dots.radius) && finite(dots.gap)) {
    out.tipDots = { radius: dots.radius <= 0 ? 0 : clamp(dots.radius, 1, 8), gap: clamp(dots.gap, 0, 16) };
  }
  const surface = parseSurface(value.canvasSurface);
  if (surface) out.canvasSurface = surface;
  const family = value.fontFamily;
  if (typeof family === 'string' && /^[-\w ,'"]{1,200}$/.test(family)) out.fontFamily = family;
  if (THEME_BRANCHES.includes(value.branch as BranchStyle)) out.branch = value.branch as BranchStyle;
  if (THEME_BRANCH_MATERIALS.includes(value.branchMaterial as BranchMaterial)) out.branchMaterial = value.branchMaterial as BranchMaterial;
  for (const key of ['rootShape', 'mainShape', 'shape'] as const) {
    if (THEME_SHAPES.includes(value[key] as NodeShape)) out[key] = value[key] as NodeShape;
  }
  if (value.connectionDash === 'solid' || value.connectionDash === 'dashed') out.connectionDash = value.connectionDash;
  if (value.canvasAppearance === 'system' || value.canvasAppearance === 'light' || value.canvasAppearance === 'dark') {
    out.canvasAppearance = value.canvasAppearance;
  }
  return Object.keys(out).length ? out : undefined;
}
