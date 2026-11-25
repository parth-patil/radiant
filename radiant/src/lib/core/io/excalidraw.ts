import type { CanvasBinding, CanvasElement, CanvasElementKind } from '../types';
import { parseColor } from '../geometry/color';

/**
 * Excalidraw files and clipboard (CNV-50). Pure conversion between Excalidraw's element JSON and Radiant's
 * CanvasElement. Fields Radiant does not use are kept in `source` and written back on export; a field Radiant
 * maps lossily (colour spelling, roundness, font, arrowheads, bindings) is also kept there and written back
 * unchanged as long as the Radiant value still corresponds to it.
 */

export const MAX_CANVAS_ELEMENTS = 20_000;
export const MAX_DRAW_POINTS = 4_096;
export const MAX_ELEMENT_TEXT_BYTES = 8_000;

export interface ExcalidrawFileData {
  mimeType: string;
  id: string;
  dataURL: string;
  created?: number;
  lastRetrieved?: number;
}

/** A picture file from the drawing. Image elements refer to it by `fileId` in `asset` until remapAssets. */
export interface ExcalidrawAsset {
  fileId: string;
  mimeType: string;
  dataURL: string;
}

export interface ExcalidrawImport {
  kind: 'file' | 'clipboard';
  elements: CanvasElement[];
  assets: ExcalidrawAsset[];
  /** Plain-language notes about anything that changed on the way in. */
  notices: string[];
  appState?: Record<string, unknown>;
}

export interface ExcalidrawDocument {
  type: 'excalidraw' | 'excalidraw/clipboard';
  version?: 2;
  source?: string;
  elements: Record<string, unknown>[];
  appState?: Record<string, unknown>;
  files: Record<string, ExcalidrawFileData>;
}

export interface ExcalidrawExportOptions {
  /** 'file' (default) writes a .excalidraw document, 'clipboard' the excalidraw/clipboard payload. */
  type?: 'file' | 'clipboard';
  /** Picture bytes by asset hash, as data URLs. Pictures without one are written without a file. */
  files?: (asset: string) => { mimeType: string; dataURL: string } | undefined;
  /** Line and arrow points with bound ends resolved (CanvasScene.points), so ends sit where they are drawn. */
  points?: ReadonlyMap<string, number[]>;
  appState?: Record<string, unknown>;
  /** Timestamp for elements that have none. */
  now?: number;
}

type Raw = Record<string, unknown>;

const object = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown, fallback = 0): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const text = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  return (h >>> 0) || 1;
}

/** Six-digit hex for a CSS colour; undefined for transparent. */
function hex(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const s = value.trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'none') return;
  if (/^#[\da-f]{6}$/.test(s)) return s;
  const c = parseColor(s);
  if (c.a === 0) return;
  const byte = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return '#' + byte(c.r) + byte(c.g) + byte(c.b);
}

const FILL_STYLES = new Set(['solid', 'hachure', 'cross-hatch', 'zigzag']);
const STROKE_STYLES = new Set(['solid', 'dashed', 'dotted']);

/** Excalidraw font family numbers: Virgil 1, Helvetica 2, Cascadia 3, Excalifont 5, Nunito 6, Lilita One 7, Comic Shanns 8. */
function fontOf(value: unknown): CanvasElement['font'] {
  return value === 1 || value === 5 || value === 7 ? 'hand' : value === 3 || value === 8 ? 'code' : 'theme';
}
const FONT_NUMBER: Record<NonNullable<CanvasElement['font']>, number> = { hand: 5, theme: 2, code: 3 };

function headOf(value: unknown): CanvasElement['endHead'] {
  if (value === null || value === undefined) return 'none';
  if (value === 'bar') return 'bar';
  if (value === 'dot' || value === 'circle' || value === 'circle_outline') return 'dot';
  return 'arrow';
}

function roughnessOf(value: unknown): 0 | 1 | 2 {
  const r = finite(value, 1);
  return r <= 0.5 ? 0 : r < 1.5 ? 1 : 2;
}

/** Fields fully represented by Radiant fields; everything else goes to `source`. */
const CONSUMED = new Set([
  'id', 'type', 'x', 'y', 'width', 'height', 'angle', 'seed', 'groupIds', 'frameId', 'link', 'locked', 'isDeleted',
  'boundElements', 'fillStyle', 'strokeStyle', 'strokeWidth', 'text', 'originalText', 'fontSize', 'textAlign',
  'containerId', 'points', 'pressures', 'name', 'fileId'
]);

function rest(raw: Raw, more: string[] = []): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) if (!CONSUMED.has(key) && !more.includes(key)) out[key] = value;
  return Object.keys(out).length ? out : undefined;
}

function clipText(value: string, notes: Notices): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= MAX_ELEMENT_TEXT_BYTES) return value;
  notes.add('Text longer than 8,000 bytes was shortened.');
  let cut = new TextDecoder().decode(bytes.slice(0, MAX_ELEMENT_TEXT_BYTES));
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return cut;
}

class Notices {
  private counts = new Map<string, number>();
  add(message: string): void {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.counts].map(([message, count]) => count > 1 ? message + ' (' + count + ' times)' : message);
  }
}

function radiantData(raw: Raw): Record<string, unknown> {
  const custom = raw.customData;
  return object(custom) && object(custom.radiant) ? custom.radiant : {};
}

function bindingOf(value: unknown, elbowed: boolean): CanvasBinding | undefined {
  if (!object(value) || typeof value.elementId !== 'string') return;
  const binding: CanvasBinding = { element: value.elementId };
  const fixed = value.fixedPoint;
  if ((elbowed || value.mode === 'inside') && Array.isArray(fixed) && fixed.length === 2 && fixed.every((v) => Number.isFinite(v))) {
    binding.at = { x: fixed[0] as number, y: fixed[1] as number };
  }
  if (typeof value.gap === 'number' && Number.isFinite(value.gap)) binding.gap = value.gap;
  return binding;
}

function simplify(points: number[], pressures: number[] | undefined): [number[], number[] | undefined] {
  const n = points.length / 2;
  if (n <= MAX_DRAW_POINTS) return [points, pressures];
  const keptPoints: number[] = [], keptPressures: number[] = [];
  for (let k = 0; k < MAX_DRAW_POINTS; k++) {
    const i = Math.round(k * (n - 1) / (MAX_DRAW_POINTS - 1));
    keptPoints.push(points[i * 2], points[i * 2 + 1]);
    if (pressures) keptPressures.push(pressures[i] ?? 0.5);
  }
  return [keptPoints, pressures ? keptPressures : undefined];
}

/** Whether a parsed JSON value is an Excalidraw file or clipboard payload. */
export function isExcalidraw(value: unknown): boolean {
  return object(value) && (value.type === 'excalidraw' || value.type === 'excalidraw/clipboard') && Array.isArray(value.elements);
}

/**
 * Read a .excalidraw document or Excalidraw clipboard JSON. Throws with a readable message when the input is
 * not Excalidraw data or holds more than MAX_CANVAS_ELEMENTS elements.
 */
export function parseExcalidraw(input: string | unknown): ExcalidrawImport {
  let value: unknown = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error('This is not an Excalidraw drawing: the file is not valid JSON.');
    }
  }
  if (!isExcalidraw(value)) throw new Error('This is not an Excalidraw drawing.');
  const doc = value as Raw;
  const kind = doc.type === 'excalidraw' ? 'file' : 'clipboard';
  const raws = (doc.elements as unknown[]).filter((raw): raw is Raw => object(raw) && raw.isDeleted !== true);
  if (raws.length > MAX_CANVAS_ELEMENTS) {
    throw new Error('This drawing has ' + raws.length.toLocaleString('en-US') + ' elements; Radiant takes at most ' +
      MAX_CANVAS_ELEMENTS.toLocaleString('en-US') + ' per map.');
  }
  const notes = new Notices();
  const files = object(doc.files) ? doc.files : {};
  const byId = new Map<string, Raw>();
  for (const raw of raws) if (typeof raw.id === 'string') byId.set(raw.id, raw);
  // Text inside a container becomes the container's text.
  const containerText = new Map<string, Raw>();
  for (const raw of raws) {
    if (raw.type === 'text' && typeof raw.containerId === 'string' && byId.has(raw.containerId)) containerText.set(raw.containerId, raw);
  }
  const absorbed = new Map<string, string>([...containerText].map(([container, t]) => [t.id as string, container]));
  const elements: CanvasElement[] = [];
  const assets = new Map<string, ExcalidrawAsset>();
  const seen = new Set<string>();
  for (const raw of raws) {
    const type = raw.type;
    if (typeof raw.id === 'string' && absorbed.has(raw.id)) continue;
    let kind: CanvasElementKind;
    const data = radiantData(raw);
    switch (type) {
      case 'rectangle': kind = data.kind === 'note' ? 'note' : 'rect'; break;
      case 'diamond': case 'ellipse': case 'line': case 'arrow': case 'text': case 'image': case 'frame': kind = type; break;
      case 'freedraw': kind = 'draw'; break;
      case 'embeddable': case 'iframe': case 'magicframe':
        kind = 'rect';
        notes.add('Embedded web content and AI frames became rectangles that keep their link.');
        break;
      default:
        notes.add('Left out an element of a kind Radiant does not draw (' + String(type) + ').');
        continue;
    }
    let id = typeof raw.id === 'string' && raw.id ? raw.id : 'excalidraw-' + elements.length;
    if (seen.has(id)) {
      notes.add('Renamed an element whose id was used twice.');
      let n = 2;
      while (seen.has(id + '-' + n)) n++;
      id = id + '-' + n;
    }
    seen.add(id);
    const el: CanvasElement = {
      id, kind,
      x: finite(raw.x), y: finite(raw.y), w: Math.abs(finite(raw.width)), h: Math.abs(finite(raw.height)),
      seed: Number.isInteger(raw.seed) && raw.seed !== 0 ? raw.seed as number : hash32(id)
    };
    const angle = finite(raw.angle);
    if (angle) el.angle = angle;
    if (data.band === 'back' || data.band === 'front') el.band = data.band;
    const strokeColor = hex(raw.strokeColor);
    const fill = hex(raw.backgroundColor);
    if (kind === 'text') {
      if (strokeColor) el.textColor = strokeColor;
    } else if (strokeColor) el.stroke = strokeColor;
    if (fill && kind !== 'text') el.fill = fill;
    if (typeof raw.fillStyle === 'string' && FILL_STYLES.has(raw.fillStyle)) el.fillStyle = raw.fillStyle as CanvasElement['fillStyle'];
    if (typeof raw.strokeStyle === 'string' && STROKE_STYLES.has(raw.strokeStyle)) el.strokeStyle = raw.strokeStyle as CanvasElement['strokeStyle'];
    if (typeof raw.strokeWidth === 'number' && raw.strokeWidth > 0 && Number.isFinite(raw.strokeWidth)) el.strokeWidth = raw.strokeWidth;
    el.roughness = roughnessOf(raw.roughness);
    if (object(raw.roundness)) el.round = true;
    const opacity = finite(raw.opacity, 100);
    if (opacity < 100) el.opacity = Math.max(0, opacity) / 100;
    if (Array.isArray(raw.groupIds) && raw.groupIds.length) el.groups = raw.groupIds.filter((g): g is string => typeof g === 'string');
    if (typeof raw.frameId === 'string') el.frame = raw.frameId;
    if (typeof raw.link === 'string' && raw.link) el.link = raw.link;
    if (raw.locked === true) el.locked = true;
    if (kind === 'text') {
      el.text = clipText(text(raw.originalText) ?? text(raw.text) ?? '', notes);
      el.fontSize = finite(raw.fontSize, 20);
      el.font = fontOf(raw.fontFamily);
      if (raw.textAlign === 'left' || raw.textAlign === 'center' || raw.textAlign === 'right') el.align = raw.textAlign;
    }
    if (kind === 'frame' && typeof raw.name === 'string') el.text = clipText(raw.name, notes);
    const label = containerText.get(raw.id as string);
    if (label) {
      el.text = clipText(text(label.originalText) ?? text(label.text) ?? '', notes);
      el.fontSize = finite(label.fontSize, 20);
      el.font = fontOf(label.fontFamily);
      if (label.textAlign === 'left' || label.textAlign === 'center' || label.textAlign === 'right') el.align = label.textAlign;
      const ink = hex(label.strokeColor);
      if (ink) el.textColor = ink;
    }
    if (kind === 'line' || kind === 'arrow' || kind === 'draw') {
      const points: number[] = [];
      if (Array.isArray(raw.points)) {
        for (const point of raw.points) {
          if (Array.isArray(point) && point.length >= 2) points.push(finite(point[0]), finite(point[1]));
        }
      }
      let pressures = kind === 'draw' && Array.isArray(raw.pressures) && raw.pressures.length && raw.simulatePressure !== true
        ? raw.pressures.map((p) => Math.max(0, Math.min(1, finite(p, 0.5)))) : undefined;
      let kept = points;
      if (kind === 'draw' && points.length / 2 > MAX_DRAW_POINTS) {
        [kept, pressures] = simplify(points, pressures);
        notes.add('A pen stroke with more than 4,096 points was simplified.');
      }
      el.points = kept;
      if (pressures) el.pressures = pressures;
    }
    if (kind === 'line' || kind === 'arrow') {
      const elbowed = raw.elbowed === true;
      if (elbowed) el.elbow = true;
      const start = headOf(raw.startArrowhead), end = headOf(raw.endArrowhead);
      if (start !== 'none') el.startHead = start;
      if (kind === 'line' ? end !== 'none' : end !== 'arrow') el.endHead = end;
      const startBinding = bindingOf(raw.startBinding, elbowed), endBinding = bindingOf(raw.endBinding, elbowed);
      if (startBinding) el.start = startBinding;
      if (endBinding) el.end = endBinding;
    }
    if (kind === 'image') {
      const fileId = text(raw.fileId);
      const file = fileId ? files[fileId] : undefined;
      if (fileId && object(file) && typeof file.dataURL === 'string') {
        el.asset = fileId;
        assets.set(fileId, { fileId, mimeType: text(file.mimeType) ?? 'application/octet-stream', dataURL: file.dataURL });
      } else notes.add('A picture arrived without its file data and will show as empty.');
      if (Array.isArray(raw.crop) || object(raw.crop)) notes.add('Picture crops are not shown; the whole picture is drawn.');
    }
    if (type === 'embeddable' || type === 'iframe' || type === 'magicframe') {
      if (type === 'magicframe' && typeof raw.name === 'string') el.text = raw.name;
    }
    const source = rest(raw) ?? {};
    if (kind === 'text' && typeof raw.text === 'string' && raw.text !== el.text) {
      source.$wrapped = raw.text;
      source.$wrappedFrom = el.text;
    }
    if (label) {
      const textSource = rest(label) ?? {};
      textSource.id = label.id;
      textSource.seed = label.seed;
      textSource.$geometry = [finite(label.x), finite(label.y), finite(label.width), finite(label.height), el.x, el.y, el.w, el.h,
        el.text ?? '', el.fontSize ?? 20];
      if (typeof label.text === 'string') textSource.$wrapped = label.text;
      source.$text = textSource;
    }
    if (type !== kind && kind === 'rect' && type !== 'rectangle') source.$type = type;
    if (Object.keys(source).length) el.source = source;
    elements.push(el);
  }
  // Bindings: a bound label's id means its container; a missing target is cleared.
  const ids = new Set(elements.map((el) => el.id));
  for (const el of elements) {
    for (const end of ['start', 'end'] as const) {
      const binding = el[end];
      if (!binding?.element) continue;
      const target = absorbed.get(binding.element) ?? binding.element;
      if (ids.has(target)) binding.element = target;
      else delete el[end];
    }
    if (el.frame && !ids.has(el.frame)) delete el.frame;
  }
  return {
    kind, elements, assets: [...assets.values()], notices: notes.list(),
    appState: object(doc.appState) ? doc.appState : undefined
  };
}

/** Point image elements at stored assets: `map` takes an Excalidraw fileId to the asset hash. */
export function remapAssets(elements: CanvasElement[], map: ReadonlyMap<string, string>): CanvasElement[] {
  return elements.map((el) => el.kind === 'image' && el.asset && map.has(el.asset) ? { ...el, asset: map.get(el.asset)! } : el);
}

// ------------------------------------------------------------------------------------------ export

const EXCALIDRAW_DEFAULT_STROKE = '#1e1e1e';
const NOTE_FILL = '#fff3bf';
const FRAME_STROKE = '#bbbbbb';

function typeOf(el: CanvasElement): string {
  switch (el.kind) {
    case 'rect': case 'note': return 'rectangle';
    case 'draw': return 'freedraw';
    default: return el.kind;
  }
}

/** The source value when it still means the current Radiant value, otherwise the exported one. */
function keep<T>(source: Record<string, unknown> | undefined, key: string, mapped: (value: unknown) => T, current: T, fresh: unknown): unknown {
  return source && key in source && mapped(source[key]) === current ? source[key] : fresh;
}

function strip(source: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (source) for (const [key, value] of Object.entries(source)) if (!key.startsWith('$')) out[key] = value;
  return out;
}

function pairs(points: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push([points[i], points[i + 1]]);
  return out;
}

function bindingOut(binding: CanvasBinding | undefined, previous: unknown, known: ReadonlySet<string>): Raw | null {
  if (!binding?.element || !known.has(binding.element)) return null;
  const base = object(previous) && previous.elementId === binding.element ? previous : {};
  const out: Raw = { ...base, elementId: binding.element };
  if (!('focus' in out) && !('mode' in out)) out.focus = 0;
  if (binding.gap !== undefined || !('mode' in out)) out.gap = binding.gap ?? (typeof out.gap === 'number' ? out.gap : 4);
  if (binding.at) out.fixedPoint = [binding.at.x, binding.at.y];
  return out;
}

/** Write canvas elements as a .excalidraw document or Excalidraw clipboard payload. */
export function toExcalidraw(elements: readonly CanvasElement[], options: ExcalidrawExportOptions = {}): ExcalidrawDocument {
  const now = options.now ?? 1;
  // Radiant draws the back band under the front band; Excalidraw has one stack.
  const ordered = [...elements.filter((el) => (el.band ?? backByDefault(el)) === 'back'),
    ...elements.filter((el) => (el.band ?? backByDefault(el)) === 'front')];
  const known = new Set(ordered.map((el) => el.id));
  const textIds = new Map<string, string>();
  for (const el of ordered) {
    if (el.text && el.kind !== 'text' && el.kind !== 'frame' && el.kind !== 'image' && el.kind !== 'draw') {
      const saved = el.source?.$text;
      textIds.set(el.id, object(saved) && typeof saved.id === 'string' ? saved.id : el.id + '-text');
    }
  }
  const arrowsTo = new Map<string, string[]>();
  for (const el of ordered) {
    for (const end of [el.start, el.end]) {
      if (end?.element && known.has(end.element)) {
        const list = arrowsTo.get(end.element) ?? [];
        if (!list.includes(el.id)) list.push(el.id);
        arrowsTo.set(end.element, list);
      }
    }
  }
  const files: Record<string, ExcalidrawFileData> = {};
  const out: Raw[] = [];
  for (const el of ordered) {
    const source = el.source;
    const type = typeOf(el);
    const note = el.kind === 'note';
    const stroke = el.kind === 'text' ? el.textColor ?? el.stroke : el.stroke;
    const strokeDefault = el.kind === 'frame' ? FRAME_STROKE : EXCALIDRAW_DEFAULT_STROKE;
    const fill = el.fill ?? (note ? NOTE_FILL : undefined);
    const opacity = Math.round((el.opacity ?? 1) * 100);
    const bound: Raw[] = (arrowsTo.get(el.id) ?? []).map((id) => ({ id, type: 'arrow' }));
    const textId = textIds.get(el.id);
    if (textId) bound.push({ id: textId, type: 'text' });
    const radiant: Raw = {};
    if (note) radiant.kind = 'note';
    if (el.band) radiant.band = el.band;
    const custom = object(source?.customData) ? { ...source.customData } : {};
    delete custom.radiant;
    if (Object.keys(radiant).length) custom.radiant = radiant;
    const roundDefault = el.kind === 'rect' || el.kind === 'note' ? { type: 3 } : { type: 2 };
    const raw: Raw = {
      ...strip(source),
      id: el.id, type, x: el.x, y: el.y, width: el.w, height: el.h, angle: el.angle ?? 0,
      strokeColor: keep(source, 'strokeColor', hex, stroke, stroke ?? strokeDefault),
      backgroundColor: keep(source, 'backgroundColor', hex, fill, fill ?? 'transparent'),
      fillStyle: el.fillStyle ?? 'solid',
      strokeWidth: el.strokeWidth ?? 2,
      strokeStyle: el.strokeStyle ?? 'solid',
      roughness: keep(source, 'roughness', roughnessOf, el.roughness ?? 1, el.roughness ?? 1),
      opacity: keep(source, 'opacity', (v) => Math.round(finite(v, 100)), opacity, opacity),
      groupIds: el.groups ?? [],
      frameId: el.frame && known.has(el.frame) ? el.frame : null,
      roundness: el.round ? (object(source?.roundness) ? source.roundness : roundDefault) : null,
      seed: el.seed,
      version: typeof source?.version === 'number' ? source.version : 1,
      versionNonce: typeof source?.versionNonce === 'number' ? source.versionNonce : hash32(el.id + ':' + el.seed),
      isDeleted: false,
      boundElements: bound.length ? bound : null,
      updated: typeof source?.updated === 'number' ? source.updated : now,
      link: el.link ?? null,
      locked: !!el.locked
    };
    if (Object.keys(custom).length) raw.customData = custom;
    else delete raw.customData;
    if (el.kind === 'text') {
      const t = el.text ?? '';
      Object.assign(raw, {
        text: typeof source?.$wrapped === 'string' && source.$wrappedFrom === t ? source.$wrapped : t, originalText: t,
        fontSize: el.fontSize ?? 20, textAlign: el.align ?? 'left', verticalAlign: source?.verticalAlign ?? 'top',
        fontFamily: keep(source, 'fontFamily', fontOf, el.font ?? 'theme', FONT_NUMBER[el.font ?? 'theme']),
        containerId: null, lineHeight: source?.lineHeight ?? 1.25, autoResize: source?.autoResize ?? true
      });
    }
    if (el.kind === 'line' || el.kind === 'arrow' || el.kind === 'draw') {
      const points = options.points?.get(el.id) ?? el.points ?? [0, 0, el.w, el.h];
      raw.points = pairs(points);
      if (options.points?.has(el.id)) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of raw.points as [number, number][]) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        raw.width = x1 - x0;
        raw.height = y1 - y0;
      }
    }
    if (el.kind === 'line' || el.kind === 'arrow') {
      const startHead = el.startHead ?? 'none', endHead = el.endHead ?? (el.kind === 'arrow' ? 'arrow' : 'none');
      const head = (h: string) => h === 'none' ? null : h === 'dot' ? 'dot' : h;
      raw.startArrowhead = keep(source, 'startArrowhead', headOf, startHead, head(startHead));
      raw.endArrowhead = keep(source, 'endArrowhead', headOf, endHead, head(endHead));
      raw.startBinding = bindingOut(el.start, source?.startBinding, known);
      raw.endBinding = bindingOut(el.end, source?.endBinding, known);
      raw.lastCommittedPoint ??= null;
      if (el.kind === 'arrow') raw.elbowed = !!el.elbow;
    }
    if (el.kind === 'draw') {
      raw.pressures = el.pressures ?? [];
      raw.simulatePressure = !el.pressures?.length;
      raw.lastCommittedPoint ??= null;
    }
    if (el.kind === 'frame') raw.name = el.text ?? null;
    if (el.kind === 'image') {
      const file = el.asset ? options.files?.(el.asset) : undefined;
      raw.fileId = el.asset ?? null;
      raw.status = 'saved';
      raw.scale ??= [1, 1];
      raw.crop ??= null;
      if (el.asset && file) files[el.asset] = { mimeType: file.mimeType, id: el.asset, dataURL: file.dataURL, created: now };
    }
    out.push(raw);
    if (textId) out.push(boundText(el, textId, raw, now));
  }
  // Fractional indices are kept only while they still increase in the written order.
  let last = '';
  const indexed = out.every((raw) => {
    if (typeof raw.index !== 'string' || raw.index <= last) return false;
    last = raw.index;
    return true;
  });
  if (!indexed) for (const raw of out) delete raw.index;
  const doc: ExcalidrawDocument = options.type === 'clipboard'
    ? { type: 'excalidraw/clipboard', elements: out, files }
    : { type: 'excalidraw', version: 2, source: 'radiant', elements: out, appState: options.appState ?? { gridSize: 20, viewBackgroundColor: '#ffffff' }, files };
  return doc;
}

function backByDefault(el: CanvasElement): 'back' | 'front' {
  return el.kind === 'arrow' || el.kind === 'line' || el.kind === 'draw' || el.kind === 'text' ? 'front' : 'back';
}

/** The separate text element Excalidraw keeps for a label inside a shape or on an arrow. */
function boundText(el: CanvasElement, id: string, container: Raw, now: number): Raw {
  const saved = object(el.source?.$text) ? el.source.$text : undefined;
  const t = el.text ?? '';
  const fontSize = el.fontSize ?? 20;
  const geometry = Array.isArray(saved?.$geometry) ? saved.$geometry as unknown[] : undefined;
  const unchanged = !!geometry && geometry[4] === el.x && geometry[5] === el.y && geometry[6] === el.w && geometry[7] === el.h &&
    geometry[8] === t && geometry[9] === fontSize;
  let x: number, y: number, width: number, height: number;
  if (unchanged) [x, y, width, height] = (geometry as number[]).slice(0, 4);
  else {
    const lines = t.split('\n');
    const inner = el.kind === 'arrow' || el.kind === 'line' ? 240 : Math.max(8, el.w - 10);
    width = Math.min(inner, Math.max(...lines.map((line) => line.length)) * fontSize * 0.55);
    height = lines.length * fontSize * 1.25;
    let cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    if ((el.kind === 'arrow' || el.kind === 'line') && Array.isArray(container.points)) {
      const pts = container.points as [number, number][];
      const mid = pts[Math.floor((pts.length - 1) / 2)], next = pts[Math.ceil((pts.length - 1) / 2)];
      cx = el.x + (mid[0] + next[0]) / 2;
      cy = el.y + (mid[1] + next[1]) / 2;
    }
    x = cx - width / 2;
    y = cy - height / 2;
  }
  const font = el.font ?? 'theme';
  return {
    ...strip(saved),
    id, type: 'text', x, y, width, height,
    angle: el.kind === 'arrow' || el.kind === 'line' ? 0 : el.angle ?? 0,
    strokeColor: keep(saved, 'strokeColor', hex, el.textColor, el.textColor ?? EXCALIDRAW_DEFAULT_STROKE),
    backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
    roughness: container.roughness, opacity: container.opacity,
    groupIds: container.groupIds, frameId: container.frameId, roundness: null,
    seed: typeof saved?.seed === 'number' ? saved.seed : hash32(id),
    version: typeof saved?.version === 'number' ? saved.version : 1,
    versionNonce: typeof saved?.versionNonce === 'number' ? saved.versionNonce : hash32(id + ':nonce'),
    isDeleted: false, boundElements: null,
    updated: typeof saved?.updated === 'number' ? saved.updated : now,
    link: null, locked: container.locked,
    text: unchanged && typeof saved?.$wrapped === 'string' ? saved.$wrapped : t,
    fontSize, fontFamily: keep(saved, 'fontFamily', fontOf, font, FONT_NUMBER[font]),
    textAlign: el.align ?? 'center', verticalAlign: saved?.verticalAlign ?? 'middle',
    containerId: el.id, originalText: t, autoResize: saved?.autoResize ?? true, lineHeight: saved?.lineHeight ?? 1.25
  };
}

/** JSON text for a .excalidraw file or the clipboard. */
export function stringifyExcalidraw(elements: readonly CanvasElement[], options: ExcalidrawExportOptions = {}): string {
  return JSON.stringify(toExcalidraw(elements, options), null, options.type === 'clipboard' ? undefined : 2);
}
