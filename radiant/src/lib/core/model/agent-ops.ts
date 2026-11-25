import type {
  CanvasElement, CanvasElementKind, Doc, LayoutKind, LinkStyle, MapNode, NodeId, NodeStyle, Op, Presentation, PresentationStep, RootInfo, RootSpacing, Transaction
} from '../types';
import {
  addChild, addLink, collapseToDepth, deleteSubtree, depthOf, duplicateSubtree, expandAll, moveSubtree, outlineInsertOps, removeLink,
  setNote, setStyle, setText, toggleCollapsed
} from './commands';
import { applyOps, newTrack } from './ops';
import { cloneDoc, parseCanvasElement, presentationProblems } from './doc';
import { canvasLimitError, deleteElements, reorderElements, setBand, updateElement } from './canvas';
import { autoTour, type TourGranularity } from './presentation';
import { listThemes } from './themes';
import { THEME_BRANCHES, THEME_SHAPES, parseThemeSettings } from './theme-settings';
import {
  SPEC_ID, SPEC_LAYOUTS, SPEC_SPACINGS, compileSpecElement, hash53, parseMapSpec, parseMapSpecJson, parseSpecStep, specOutline,
  specStyle, suggest, type MapSpecNode, type SpecDiagnostic
} from '../io/map-spec';

/**
 * The agent edit vocabulary (implementation spec 8.1, "Edit operations"; AGT-OPS, AGT-EXT-03 and 05), defined once.
 *
 * One table describes every op: its fields as a JSON-Schema subset, its tier and a summary. The same table validates
 * batches (here, for the CLI and the app's web side), prints the published schema ("radiant schema ops") and
 * classifies a batch as write or destructive, which is all the native host needs to know. Each op compiles to
 * existing Op values through the helpers in commands.ts, presentation.ts and canvas.ts. Pure TypeScript.
 */

export const AGENT_OPS_VERSION = 1;

export const AGENT_LIMITS = {
  /** Agent ops in one batch. */
  ops: 2_000,
  /** Nodes one batch may insert (add, add-root, add-tree, duplicate). */
  nodes: 20_000,
  /** Ids in one ids[] field. */
  ids: 5_000,
  labelBytes: 1_000,
  noteBytes: 65_536,
  /** Characters of an add-tree spec fragment. */
  fragmentChars: 4 * 1024 * 1024,
  /** Bytes of one encoded request on the app socket. */
  frameBytes: 8 * 1024 * 1024
} as const;

// ====================================================================== the schema subset

/** A JSON Schema subset used both to validate and to publish. maxBytes counts UTF-8 bytes; nonEmpty rejects blank text. */
export interface FieldSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null' | readonly ('string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null')[];
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | FieldSchema;
  anyOf?: readonly FieldSchema[];
  maxBytes?: number;
  nonEmpty?: boolean;
}

export type AgentTier = 'write' | 'destructive';

export interface AgentOpDefinition {
  summary: string;
  tier: AgentTier;
  /** Fields besides "op". */
  fields: Record<string, FieldSchema>;
  required: readonly string[];
}

const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$';
const HEX_PATTERN = '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$';
const HASH_PATTERN = '^(sha256:)?[a-f0-9]{64}$';
const ref: FieldSchema = { type: 'string', pattern: '^(@[A-Za-z0-9_-]{1,64}|[A-Za-z0-9][A-Za-z0-9_-]{0,127})$',
  description: 'An existing id, or "@name" for something an earlier op of this batch created with ref "name".' };
const refs: FieldSchema = { type: 'array', items: ref, minItems: 1, maxItems: AGENT_LIMITS.ids };
const newRef: FieldSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Name for what this op creates; later ops use "@name".' };
const newId: FieldSchema = { type: 'string', pattern: ID_PATTERN, description: 'Explicit id for the new item (must be unused). Default: derived from the batch.' };
const label: FieldSchema = { type: 'string', maxBytes: AGENT_LIMITS.labelBytes, nonEmpty: true };
const note: FieldSchema = { type: ['string', 'null'], maxBytes: AGENT_LIMITS.noteBytes, description: 'Note text; "" or null clears it.' };
const index: FieldSchema = { type: 'integer', minimum: 0, maximum: 1_000_000, description: 'Position among the siblings (default: the end).' };
const hex = (nullable = true): FieldSchema => ({ type: nullable ? ['string', 'null'] : 'string', pattern: HEX_PATTERN });
const nullable = (s: FieldSchema): FieldSchema => ({ ...s, type: [...(Array.isArray(s.type) ? s.type : [s.type ?? 'string']), 'null'] as FieldSchema['type'] });
const point: FieldSchema = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false };
const bool: FieldSchema = { type: 'boolean' };
const LINK_DASHES = ['solid', 'dashed'] as const;
const LINK_ARROWS = ['none', 'start', 'end', 'both'] as const;
const TREE_LAYOUTS: readonly LayoutKind[] = ['mindmap', 'right', 'left', 'down', 'up', 'compact', 'radial', 'outline'];

/** NodeStyle fields, also under their spec attribute names (text, fill, font, align, width, size, curved, boundary, extruded). */
const STYLE_FIELDS: Record<string, FieldSchema> = {
  color: { ...hex(), description: 'Branch colour; inherited by the branch.' },
  textColor: hex(), fillColor: hex(),
  fontFamily: { type: ['string', 'null'], pattern: '^[-\\w ,\'"]{1,200}$' },
  alignment: { type: ['string', 'null'], enum: ['left', 'center', 'right', null] },
  branchWidth: { type: ['number', 'null'], minimum: 0.5, maximum: 64 },
  fontSize: { type: ['number', 'null'], minimum: 6, maximum: 200 },
  bold: nullable(bool), italic: nullable(bool), curvedLabel: nullable(bool), branchBoundary: nullable(bool), extrudedLabel: nullable(bool),
  shape: { type: ['string', 'null'], enum: [...THEME_SHAPES, null] },
  branch: { type: ['string', 'null'], enum: [...THEME_BRANCHES, null] },
  emphasis: { type: ['integer', 'null'], enum: [0, 1, 2, null] }
};
const STYLE_ALIASES: Record<string, keyof NodeStyle> = {
  text: 'textColor', fill: 'fillColor', font: 'fontFamily', align: 'alignment', width: 'branchWidth', size: 'fontSize',
  curved: 'curvedLabel', boundary: 'branchBoundary', extruded: 'extrudedLabel'
};
const style: FieldSchema = {
  type: 'object', additionalProperties: false, description: 'NodeStyle patch; null clears a key. Spec attribute names (text, fill, size, ...) are accepted too.',
  properties: { ...STYLE_FIELDS, ...Object.fromEntries(Object.entries(STYLE_ALIASES).map(([alias, field]) => [alias, STYLE_FIELDS[field]])) }
};
const tags: FieldSchema = { type: ['array', 'null'], items: { type: 'string', maxBytes: 64, nonEmpty: true }, maxItems: 32 };
const task: FieldSchema = { type: ['string', 'null'], enum: ['open', 'done', null] };
const nodePatch: FieldSchema = {
  type: 'object', additionalProperties: false, description: 'Node fields; null clears a key.',
  properties: {
    sticker: { type: ['string', 'null'], maxBytes: 64 }, tags, task,
    link: { type: ['string', 'null'], maxBytes: 2_048 }, href: { type: ['string', 'null'], maxBytes: 2_048 },
    collapsed: bool, folded: bool,
    side: { type: ['string', 'null'], enum: ['left', 'right', null] },
    branchLayout: { type: ['string', 'null'], enum: [...TREE_LAYOUTS, null] }, layout: { type: ['string', 'null'], enum: [...TREE_LAYOUTS, null] },
    image: { type: ['string', 'null'], pattern: HASH_PATTERN, description: 'Content hash of a picture already embedded in the map.' },
    alt: { type: ['string', 'null'], maxBytes: AGENT_LIMITS.labelBytes },
    scale: { type: ['number', 'null'], minimum: 0.1, maximum: 8 },
    offset: { ...point, type: ['object', 'null'], description: 'Manual offset from the automatic position; null clears it.' }
  }
};
const stepSchema: FieldSchema = {
  anyOf: [
    { type: 'string', description: 'A step line: "ids : title {frame= build= dim= note= caption= seconds=}".' },
    { type: 'object', description: 'A step: focus ids (refs allowed) and optional fields.', required: ['focus'],
      properties: { focus: { anyOf: [{ type: 'array', items: ref }, { type: 'string' }] }, id: { type: 'string', pattern: ID_PATTERN },
        title: { type: 'string' }, reveal: { type: 'array', items: ref }, hide: { type: 'array', items: ref }, elements: { type: 'array', items: ref },
        frame: { type: 'string', enum: ['nodes', 'subtree', 'map'] }, build: { type: 'string', enum: ['all', 'each'] },
        dim: { type: 'string', enum: ['others', 'none'] }, caption: { type: 'string' }, note: { type: 'string' },
        transition: { type: 'string', enum: ['glide', 'cut'] }, skip: bool, seconds: { type: 'number', minimum: 0 } } }
  ]
};
const elementInput: FieldSchema = {
  anyOf: [
    { type: 'string', description: 'A canvas line: "kind #id at=x,y size=wxh {attributes} : text"; arrows: "arrow from=a to=b : label".' },
    { type: 'object', required: ['kind'], description: 'CanvasElement fields; from and to bind a line or arrow to a node or element id.',
      properties: { kind: { type: 'string', enum: ['rect', 'ellipse', 'diamond', 'line', 'arrow', 'draw', 'text', 'note', 'frame', 'image'] } } }
  ]
};

/** Every agent op. Deletes are the destructive tier (decision DEC-A6). */
export const AGENT_OPS: Record<string, AgentOpDefinition> = {
  'add': { summary: 'Add a child node.', tier: 'write', required: ['parent', 'text'], fields: {
    parent: ref, text: label, index, ref: newRef, id: newId, note, style, sticker: { type: 'string', maxBytes: 64 }, tags, task,
    link: { type: 'string', maxBytes: 2_048 }, side: { type: 'string', enum: ['left', 'right'] }, folded: bool } },
  'add-tree': { summary: 'Insert a branch written as a spec fragment (Markdown outline with attributes, or nested JSON nodes).', tier: 'write',
    required: ['parent', 'spec'], fields: { parent: ref, index, ref: newRef,
      spec: { anyOf: [{ type: 'string', maxBytes: AGENT_LIMITS.fragmentChars }, { type: 'array' }, { type: 'object' }], description: 'Markdown outline, a JSON node, an array of nodes or {"roots": [...]}.' } } },
  'add-root': { summary: 'Add a root (a new map on the canvas).', tier: 'write', required: ['text'], fields: {
    text: label, layout: { type: 'string', enum: SPEC_LAYOUTS }, spacing: { type: 'string', enum: SPEC_SPACINGS }, organic: bool,
    position: point, ref: newRef, id: newId, note, style } },
  'set-text': { summary: 'Change a label.', tier: 'write', required: ['id', 'text'], fields: { id: ref, text: label } },
  'set-note': { summary: 'Set or clear a note.', tier: 'write', required: ['id', 'note'], fields: { id: ref, note } },
  'set-style': { summary: 'Merge a style patch into nodes (null clears a key).', tier: 'write', required: ['ids', 'style'], fields: { ids: refs, style } },
  'set': { summary: 'Set node fields: sticker, tags, task, link, collapsed, side, branchLayout, image, alt, scale, offset.', tier: 'write',
    required: ['id', 'patch'], fields: { id: ref, patch: nodePatch } },
  'move': { summary: 'Move a node and its subtree under another parent.', tier: 'write', required: ['id', 'parent'], fields: { id: ref, parent: ref, index } },
  'reorder': { summary: 'Move a node among its siblings by delta or to an index.', tier: 'write', required: ['id'],
    fields: { id: ref, delta: { type: 'integer', minimum: -1_000_000, maximum: 1_000_000 }, index } },
  'delete': { summary: 'Delete whole subtrees, leaves first.', tier: 'destructive', required: ['ids'], fields: { ids: refs } },
  'duplicate': { summary: 'Copy a subtree next to the original.', tier: 'write', required: ['id'], fields: { id: ref, ref: newRef } },
  'fold': { summary: 'Fold or unfold nodes, or show a number of levels below them.', tier: 'write', required: ['ids'],
    fields: { ids: refs, folded: bool, depth: { type: 'integer', minimum: 0, maximum: 64 }, all: { type: 'boolean', description: 'With folded=false: unfold the whole subtree.' } } },
  'link': { summary: 'Add a cross-link.', tier: 'write', required: ['from', 'to'], fields: {
    from: ref, to: ref, label: { type: 'string', maxBytes: AGENT_LIMITS.labelBytes }, dash: { type: 'string', enum: LINK_DASHES },
    arrows: { type: 'string', enum: LINK_ARROWS }, color: hex(false), ref: newRef, id: newId } },
  'unlink': { summary: 'Remove a cross-link.', tier: 'destructive', required: ['id'], fields: { id: ref } },
  'link-style': { summary: 'Change a cross-link\'s dash, arrows, colour or bend (null clears).', tier: 'write', required: ['id'], fields: {
    id: ref, dash: { type: ['string', 'null'], enum: [...LINK_DASHES, null] }, arrows: { type: ['string', 'null'], enum: [...LINK_ARROWS, null] },
    color: hex(), bend: { ...point, type: ['object', 'null'] } } },
  'link-label': { summary: 'Set or clear a cross-link label.', tier: 'write', required: ['id', 'label'], fields: {
    id: ref, label: { type: ['string', 'null'], maxBytes: AGENT_LIMITS.labelBytes } } },
  'set-root': { summary: 'Change a root\'s layout, spacing, organic look or position.', tier: 'write', required: ['id'], fields: {
    id: ref, layout: { type: 'string', enum: SPEC_LAYOUTS }, spacing: { type: ['string', 'null'], enum: [...SPEC_SPACINGS, null] }, organic: bool, position: point } },
  'doc': { summary: 'Change the title, theme, theme settings, tag colours or seed.', tier: 'write', required: [], fields: {
    title: label, theme: { type: 'string', description: 'A theme id from "radiant themes".' },
    themeSettings: { type: ['object', 'null'], description: 'Theme overrides accepted by parseThemeSettings; null clears them.' },
    tagColors: { type: ['object', 'null'], additionalProperties: { type: 'string', pattern: HEX_PATTERN } },
    seed: { type: 'integer', minimum: -0x7fffffff, maximum: 0x7fffffff } } },
  'presentation-set': { summary: 'Create a presentation or change one: name, options, all steps, or steps to insert.', tier: 'write', required: [], fields: {
    id: ref, ref: newRef, name: label,
    reveal: { type: 'string', enum: ['progressive', 'all'] }, context: { type: 'string', enum: ['dim', 'hide'] },
    dimOpacity: { type: 'number', minimum: 0, maximum: 1 }, motion: { type: 'string', enum: ['full', 'gentle', 'none'] },
    targetMinutes: { type: 'number', minimum: 0, maximum: 10_000 },
    steps: { type: 'array', items: stepSchema, maxItems: 2_000, description: 'Every step, replacing the current ones.' },
    auto: { type: 'string', enum: ['branches', 'levels', 'nodes'], description: 'Replace the steps with an automatic tour.' },
    addSteps: { type: 'array', items: stepSchema, minItems: 1, maxItems: 2_000, description: 'Steps to insert at "at" (default: the end).' },
    at: { type: 'integer', minimum: 0, maximum: 2_000 } } },
  'presentation-delete': { summary: 'Delete a presentation.', tier: 'destructive', required: ['id'], fields: { id: ref } },
  'canvas-add': { summary: 'Add a canvas element (shape, note, text, frame, line, arrow, drawing or picture).', tier: 'write', required: ['element'],
    fields: { element: elementInput, ref: newRef, index: { ...index, description: 'Stacking position (default: on top).' } } },
  'canvas-set': { summary: 'Change a canvas element\'s fields (null clears; id and kind never change).', tier: 'write', required: ['id', 'patch'],
    fields: { id: ref, patch: { type: 'object', description: 'CanvasElement fields; also at=[x,y], size=[w,h], from and to (ids or refs).' } } },
  'canvas-order': { summary: 'Restack canvas elements, or move them to the band under or over the maps.', tier: 'write', required: ['ids'], fields: {
    ids: refs, to: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] }, band: { type: 'string', enum: ['back', 'front'] } } },
  'canvas-delete': { summary: 'Delete canvas elements.', tier: 'destructive', required: ['ids'], fields: { ids: refs } }
};

export const AGENT_OP_NAMES = Object.keys(AGENT_OPS);

export type AgentOp = { op: string } & Record<string, unknown>;

export interface AgentBatch {
  ops: AgentOp[];
  label?: string;
  /** Revision ("sha256:<hex>") the batch was written against; a mismatch applies nothing. */
  ifRevision?: string;
  dryRun?: boolean;
  /** Client name recorded in the transaction source, e.g. "claude-code". */
  client?: string;
}

const BATCH_FIELDS: Record<string, FieldSchema> = {
  label: { type: 'string', maxBytes: 200, nonEmpty: true, description: 'Undo label shown in the app (default "Agent Edit").' },
  ifRevision: { type: 'string', pattern: '^(sha256:)?[a-f0-9]{64}$', description: 'Apply only if the map is still at this revision.' },
  dryRun: { type: 'boolean', description: 'Compile and report; write nothing.' },
  client: { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,39}$', description: 'Client name for the transaction source.' },
  ops: { type: 'array', minItems: 1, maxItems: AGENT_LIMITS.ops }
};

/** JSON Schema of an agent batch, generated from the same table the validator uses. */
export function agentOpsSchema(): Record<string, unknown> {
  const publish = (s: FieldSchema): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(s)) {
      if (key === 'maxBytes') { out.maxLength = value; out['x-maxBytes'] = value; }
      else if (key === 'nonEmpty') out.minLength = 1;
      else if (key === 'items' || key === 'additionalProperties') out[key] = typeof value === 'object' ? publish(value as FieldSchema) : value;
      else if (key === 'properties') out[key] = Object.fromEntries(Object.entries(value as Record<string, FieldSchema>).map(([k, v]) => [k, publish(v)]));
      else if (key === 'anyOf') out[key] = (value as FieldSchema[]).map(publish);
      else out[key] = Array.isArray(value) ? value.slice() : value;
    }
    return out;
  };
  const ops = AGENT_OP_NAMES.map((name) => {
    const def = AGENT_OPS[name];
    return {
      type: 'object', title: name, description: def.summary + (def.tier === 'destructive' ? ' Destructive tier.' : ''),
      required: ['op', ...def.required], additionalProperties: false,
      properties: { op: { const: name }, ...Object.fromEntries(Object.entries(def.fields).map(([k, v]) => [k, publish(v)])) }
    };
  });
  return {
    type: 'object', required: ['ops'], additionalProperties: false,
    properties: { ...Object.fromEntries(Object.entries(BATCH_FIELDS).filter(([k]) => k !== 'ops').map(([k, v]) => [k, publish(v)])),
      ops: { ...publish(BATCH_FIELDS.ops), items: { oneOf: ops } } },
    'x-tiers': Object.fromEntries(AGENT_OP_NAMES.map((n) => [n, AGENT_OPS[n].tier])),
    'x-limits': AGENT_LIMITS
  };
}

// ====================================================================== errors and validation

export type AgentErrorKind = 'invalid' | 'not_found' | 'conflict' | 'denied';

/** A batch that cannot be applied. Nothing has been applied when this is thrown. */
export class AgentOpError extends Error {
  constructor(readonly code: string, message: string, readonly kind: AgentErrorKind = 'invalid', readonly extra: {
    op?: number; path?: string; suggestions?: string[]; details?: Record<string, unknown>;
  } = {}) {
    super(message);
  }
  get op(): number | undefined { return this.extra.op; }
  /** Plain JSON for a reply. */
  toJSON(): Record<string, unknown> {
    return { code: this.code, kind: this.kind, message: this.message, applied: 0, ...(this.extra.op !== undefined ? { op: this.extra.op } : {}),
      ...(this.extra.path ? { path: this.extra.path } : {}), suggestions: this.extra.suggestions ?? [], ...(this.extra.details ?? {}) };
  }
}

const utf8 = new TextEncoder();
const CONTROLS = /[\u{0}-\u{8}\u{b}\u{c}\u{e}-\u{1f}\u{7f}-\u{9f}]/u;
const typeName = (v: unknown) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** The first problem with value against schema, or null. */
function problem(schema: FieldSchema, value: unknown, path: string): { path: string; message: string; suggestions?: string[] } | null {
  if (schema.anyOf) {
    const all = schema.anyOf.map((s) => problem(s, value, path));
    if (all.some((p) => p === null)) return null;
    return all.find((p) => p && p.path !== path) ?? all[0];
  }
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = typeName(value);
  if (types && !types.some((t) => t === actual || (t === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (t === 'number' && typeof value === 'number'))) {
    return { path, message: path + ' must be ' + types.join(' or ') + ', not ' + actual + '.' };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { path, message: path + ' must be a finite number.' };
    if (types?.includes('integer') && !types.includes('number') && !Number.isInteger(value)) return { path, message: path + ' must be a whole number.' };
    if (schema.minimum !== undefined && value < schema.minimum) return { path, message: path + ' must be at least ' + schema.minimum + '.' };
    if (schema.maximum !== undefined && value > schema.maximum) return { path, message: path + ' must be at most ' + schema.maximum + '.' };
  }
  if (schema.enum && !schema.enum.includes(value as string)) {
    const list = schema.enum.filter((v) => v !== null).map(String);
    return { path, message: path + ' must be one of ' + list.join(', ') + '; got "' + String(value) + '".', suggestions: suggest(String(value), list) };
  }
  if (typeof value === 'string') {
    if (CONTROLS.test(value)) return { path, message: path + ' contains control characters.' };
    if (schema.maxBytes !== undefined && utf8.encode(value).length > schema.maxBytes) return { path, message: path + ' is longer than ' + schema.maxBytes + ' bytes.' };
    if (schema.nonEmpty && !value.trim()) return { path, message: path + ' must not be empty.' };
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return { path, message: path + ' has an invalid format: "' + value.slice(0, 80) + '".' };
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return { path, message: path + ' needs at least ' + schema.minItems + ' item' + (schema.minItems === 1 ? '' : 's') + '.' };
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return { path, message: path + ' has more than ' + schema.maxItems + ' items.' };
    if (schema.items) for (let i = 0; i < value.length; i++) { const p = problem(schema.items, value[i], path + '[' + i + ']'); if (p) return p; }
  }
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in obj)) return { path, message: path + ' needs "' + key + '".' };
    for (const [key, v] of Object.entries(obj)) {
      const field = schema.properties?.[key];
      if (field) { const p = problem(field, v, path + '.' + key); if (p) return p; continue; }
      if (schema.additionalProperties === false) {
        return { path: path + '.' + key, message: 'Unknown field "' + key + '" in ' + path + '.', suggestions: suggest(key, Object.keys(schema.properties ?? {})) };
      }
      if (typeof schema.additionalProperties === 'object') { const p = problem(schema.additionalProperties, v, path + '.' + key); if (p) return p; }
    }
  }
  return null;
}

/**
 * Validate a batch without a document: shape, op names, field types, limits and refs. Accepts {ops, label, ...} or a
 * bare array of ops. Throws AgentOpError naming the op index.
 */
export function parseAgentBatch(input: unknown): AgentBatch {
  const raw = Array.isArray(input) ? { ops: input } : input;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentOpError('invalid_batch', 'An edit batch is {"ops": [...]} or an array of ops.');
  const batch = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(batch)) {
    const field = BATCH_FIELDS[key];
    if (!field) throw new AgentOpError('invalid_batch', 'Unknown batch field "' + key + '".', 'invalid', { path: key, suggestions: suggest(key, Object.keys(BATCH_FIELDS)) });
    const p = problem(field, value, key);
    if (p) throw new AgentOpError('invalid_batch', p.message, 'invalid', { path: p.path, suggestions: p.suggestions });
  }
  if (!Array.isArray(batch.ops)) throw new AgentOpError('invalid_batch', 'The batch needs "ops", an array of 1 to ' + AGENT_LIMITS.ops + ' ops.');
  const refsSeen = new Set<string>();
  batch.ops.forEach((value, i) => {
    const at = 'ops[' + i + ']';
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentOpError('invalid_op', at + ' must be an object with "op".', 'invalid', { op: i, path: at });
    const op = value as Record<string, unknown>;
    const name = op.op;
    if (typeof name !== 'string' || !AGENT_OPS[name]) {
      throw new AgentOpError('unknown_op', at + ': unknown op "' + String(name) + '". Ops: ' + AGENT_OP_NAMES.join(', ') + '.', 'invalid',
        { op: i, path: at + '.op', suggestions: suggest(String(name), AGENT_OP_NAMES) });
    }
    const def = AGENT_OPS[name];
    const p = problem({ type: 'object', required: def.required, properties: { op: { type: 'string' }, ...def.fields }, additionalProperties: false }, op, at);
    if (p) throw new AgentOpError('invalid_op', p.message, 'invalid', { op: i, path: p.path, suggestions: p.suggestions });
    for (const [key, v] of Object.entries(op)) {
      if (key === 'ref' || key === 'op') continue;
      const list = Array.isArray(v) ? v : [v];
      for (const item of list) {
        if (typeof item !== 'string' || !/^@[A-Za-z0-9_-]{1,64}$/.test(item)) continue;
        if (!refsSeen.has(item.slice(1))) {
          throw new AgentOpError('unknown_ref', at + '.' + key + ': "' + item + '" names nothing created earlier in this batch.', 'not_found',
            { op: i, path: at + '.' + key, suggestions: suggest(item.slice(1), refsSeen).map((r) => '@' + r) });
        }
      }
    }
    if (typeof op.ref === 'string') {
      if (refsSeen.has(op.ref)) throw new AgentOpError('duplicate_ref', at + ': ref "' + op.ref + '" is already used in this batch.', 'invalid', { op: i, path: at + '.ref' });
      refsSeen.add(op.ref);
    }
    if (name === 'reorder' && (op.delta === undefined) === (op.index === undefined)) {
      throw new AgentOpError('invalid_op', at + ': reorder needs exactly one of "delta" and "index".', 'invalid', { op: i, path: at });
    }
    if (name === 'canvas-order' && (op.to === undefined) === (op.band === undefined)) {
      throw new AgentOpError('invalid_op', at + ': canvas-order needs exactly one of "to" and "band".', 'invalid', { op: i, path: at });
    }
    if (name === 'fold' && op.folded === undefined && op.depth === undefined) {
      throw new AgentOpError('invalid_op', at + ': fold needs "folded" or "depth".', 'invalid', { op: i, path: at });
    }
  });
  return batch as unknown as AgentBatch;
}

/** The tier a batch needs: destructive when any op deletes something. */
export function classifyAgentBatch(batch: AgentBatch): AgentTier {
  return batch.ops.some((op) => AGENT_OPS[op.op]?.tier === 'destructive') ? 'destructive' : 'write';
}

/** "sha256:<hex>" for a revision given with or without the prefix. */
export const normalRevision = (revision: string) => 'sha256:' + revision.replace(/^sha256:/, '');

// ====================================================================== running a batch

export interface AgentRunOptions {
  /** Revision of the document as given; required to honour ifRevision. */
  revision?: string;
  /** The destructive tier is granted. */
  allowDestructive?: boolean;
  /** Client name when the batch has none. Default "cli". */
  client?: string;
}

export interface AgentReply {
  status: 'applied' | 'dry_run';
  /** Transaction source, "agent:<client>:<id>". */
  tx: string;
  label: string;
  tier: AgentTier;
  /** Agent ops in the batch. */
  applied: number;
  /** Document ops they compiled to. */
  ops: number;
  /** New ids by ref, or by op index for ops without a ref. */
  created: Record<string, string>;
  /** Cross-links created. */
  links: string[];
  /** Canvas elements created or changed. */
  elements: string[];
  /** Presentations created or changed. */
  presentations: string[];
  /** Existing nodes the batch changed (parents of added nodes included). */
  touched: NodeId[];
  warnings: string[];
}

export interface AgentRun {
  reply: AgentReply;
  /** The document ops, in order; apply them as one transaction with {@link AgentRun.source}. */
  ops: Op[];
  /** A copy of the document with the ops applied. The input document is never changed. */
  doc: Doc;
  source: Transaction['source'];
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A 12-character id derived from key (base62, like newId), so one batch gives one set of ids everywhere. */
function derivedId(key: string): string {
  let a = hash53(key);
  let b = hash53(key, 0x9e3779b9);
  let out = '';
  for (let i = 0; i < 8; i++) { out += BASE62[a % 62]; a = Math.floor(a / 62); }
  for (let i = 0; i < 4; i++) { out += BASE62[b % 62]; b = Math.floor(b / 62); }
  return out;
}

/** Stable text of a value with sorted keys. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}

/** Deep equality ignoring key order. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

const clip = (text: string, max = 40) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

/**
 * Validate, compile and apply a batch to a copy of doc. Atomic: the first failing op throws AgentOpError with its
 * index and nothing is returned. The same batch on the same document gives the same ops and ids on every back end.
 */
export function runAgentBatch(doc: Doc, input: unknown, opts: AgentRunOptions = {}): AgentRun {
  const batch = parseAgentBatch(input);
  const tier = classifyAgentBatch(batch);
  if (batch.ifRevision && opts.revision !== undefined && normalRevision(batch.ifRevision) !== normalRevision(opts.revision)) {
    throw new AgentOpError('revision_mismatch', 'The map changed since revision ' + normalRevision(batch.ifRevision).slice(0, 19) +
      '…; nothing was applied. Read it again and retry with the current revision.', 'conflict', { details: { currentRevision: normalRevision(opts.revision) } });
  }
  if (tier === 'destructive' && !opts.allowDestructive) {
    const first = batch.ops.findIndex((op) => AGENT_OPS[op.op].tier === 'destructive');
    throw new AgentOpError('destructive_not_allowed', 'Op ' + first + ' (' + batch.ops[first].op + ') deletes content and needs the destructive tier; nothing was applied.',
      'denied', { op: first });
  }
  const client = batch.client ?? opts.client ?? 'cli';
  const key = canonical({ label: batch.label ?? '', ops: batch.ops });
  const tx = 'agent:' + client + ':' + hash53(key).toString(36).slice(0, 8);
  const source: Transaction['source'] = { ai: tx };
  const label = batch.label ?? 'Agent Edit';
  const c = new Compiler(cloneDoc(doc), source, key);
  batch.ops.forEach((op, i) => {
    c.index = i;
    try {
      c.run(op);
    } catch (e) {
      if (e instanceof AgentOpError) throw e.extra.op === undefined ? new AgentOpError(e.code, 'ops[' + i + '] (' + op.op + '): ' + e.message, e.kind, { ...e.extra, op: i }) : e;
      throw new AgentOpError('op_failed', 'ops[' + i + '] (' + op.op + ') could not be applied: ' + (e instanceof Error ? e.message : String(e)), 'invalid', { op: i });
    }
  });
  const touched = [...c.track.touched].filter((id) => c.doc.nodes[id] && !c.createdNodes.has(id) && doc.nodes[id]);
  return {
    reply: {
      status: batch.dryRun ? 'dry_run' : 'applied', tx, label, tier, applied: batch.ops.length, ops: c.ops.length,
      created: c.created, links: c.links, elements: [...new Set(c.elements)], presentations: [...new Set(c.presentations)],
      touched, warnings: c.warnings
    },
    ops: c.ops,
    doc: c.doc,
    source
  };
}

type Patch = Partial<Omit<MapNode, 'id' | 'parent' | 'children'>>;

/** Compiles ops one at a time against a draft, applying each so later ops see earlier ones. */
class Compiler {
  readonly ops: Op[] = [];
  readonly track = newTrack();
  readonly created: Record<string, string> = {};
  readonly createdNodes = new Set<NodeId>();
  readonly links: string[] = [];
  readonly elements: string[] = [];
  readonly presentations: string[] = [];
  readonly warnings: string[] = [];
  private readonly refs = new Map<string, string>();
  private inserted = 0;
  index = 0;
  private serial = 0;

  constructor(readonly doc: Doc, readonly source: Transaction['source'], private readonly key: string) {}

  private fail(code: string, message: string, kind: AgentErrorKind = 'invalid', suggestions?: string[]): never {
    throw new AgentOpError(code, message, kind, { suggestions });
  }

  /** A fresh id for something new, unused in taken. */
  private fresh(taken: (id: string) => boolean): string {
    for (;;) {
      const id = derivedId(this.key + '\n' + this.index + '\n' + this.serial++);
      if (!taken(id)) return id;
    }
  }

  private freshNode = () => this.fresh((id) => !!this.doc.nodes[id]);

  private resolve(value: string): string {
    return value.startsWith('@') ? this.refs.get(value.slice(1)) ?? value : value;
  }

  /** An existing node id (refs resolved), or a not-found error with the nearest ids and labels. */
  node(value: unknown, field: string): NodeId {
    const id = this.resolve(String(value));
    if (this.doc.nodes[id]) return id;
    const ids = Object.keys(this.doc.nodes);
    const q = String(value).toLowerCase();
    const byLabel = ids.filter((k) => this.doc.nodes[k].text.toLowerCase() === q || (q.length >= 3 && this.doc.nodes[k].text.toLowerCase().includes(q)));
    this.fail('unknown_node', field + ' "' + String(value) + '" is not a node in this map.', 'not_found', [...new Set([...suggest(String(value), ids), ...byLabel])].slice(0, 5));
  }

  private linkId(value: unknown): string {
    const id = this.resolve(String(value));
    if (this.doc.links.some((l) => l.id === id)) return id;
    this.fail('unknown_link', 'Link "' + String(value) + '" is not in this map.', 'not_found', suggest(String(value), this.doc.links.map((l) => l.id)));
  }

  private elementId(value: unknown): string {
    const id = this.resolve(String(value));
    const list = this.doc.canvas?.elements ?? [];
    if (list.some((e) => e.id === id)) return id;
    this.fail('unknown_element', 'Canvas element "' + String(value) + '" is not in this map.', 'not_found', suggest(String(value), list.map((e) => e.id)));
  }

  private presentationId(value: unknown): string | null {
    const id = this.resolve(String(value));
    return (this.doc.presentations ?? []).some((p) => p.id === id) ? id : null;
  }

  private emit(ops: readonly Op[] | null | undefined): void {
    if (!ops?.length) return;
    applyOps(this.doc, ops, this.track);
    this.ops.push(...ops);
  }

  private remember(op: AgentOp, id: string): void {
    this.created[typeof op.ref === 'string' ? op.ref : String(this.index)] = id;
    if (typeof op.ref === 'string') this.refs.set(op.ref, id);
  }

  private countInsert(n: number): void {
    this.inserted += n;
    if (this.inserted > AGENT_LIMITS.nodes) this.fail('too_many_nodes', 'The batch inserts more than ' + AGENT_LIMITS.nodes + ' nodes.');
  }

  /** Give inserts that helpers made with random ids the batch's derived ids (and fix parents and alias groups). */
  private remap(ops: Op[], explicit?: string): Op[] {
    const renamed = new Map<string, string>();
    const used = new Set<string>();
    const groups = new Map<string, string>();
    const existingGroups = new Set(Object.values(this.doc.nodes).flatMap((n) => (n.aliasGroup ? [n.aliasGroup] : [])));
    for (const op of ops) {
      if (op.t !== 'insert' || this.doc.nodes[op.node.id]) continue;
      const id = renamed.size === 0 && explicit ? explicit : this.fresh((x) => !!this.doc.nodes[x] || used.has(x));
      renamed.set(op.node.id, id);
      used.add(id);
      op.node = { ...op.node, id };
      if (op.parent !== null && renamed.has(op.parent)) op.parent = op.node.parent = renamed.get(op.parent)!;
      if (op.node.aliasGroup && !existingGroups.has(op.node.aliasGroup)) {
        const group = groups.get(op.node.aliasGroup) ?? this.fresh(() => false);
        groups.set(op.node.aliasGroup, group);
        op.node.aliasGroup = group;
      }
      this.createdNodes.add(id);
    }
    this.countInsert(renamed.size);
    return ops;
  }

  private explicitNodeId(op: AgentOp): string | undefined {
    if (typeof op.id !== 'string') return undefined;
    if (this.doc.nodes[op.id]) this.fail('id_exists', 'Id "' + op.id + '" is already used by a node.', 'conflict');
    return op.id;
  }

  /** NodeStyle patch from an op's style object (aliases mapped, null clearing a key). */
  private stylePatch(raw: unknown): Partial<NodeStyle> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const field = STYLE_ALIASES[key] ?? key;
      out[field] = value === null ? undefined : typeof value === 'string' && /^#[0-9a-f]{3}$/i.test(value) ? upperHex(value)
        : typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : value;
    }
    return out as Partial<NodeStyle>;
  }

  /** Fields an add op may carry besides text and style. */
  private nodeExtras(op: AgentOp, id: NodeId): void {
    const patch: Patch = {};
    if (typeof op.note === 'string' && op.note) patch.note = op.note;
    if (typeof op.sticker === 'string' && op.sticker.trim()) patch.sticker = op.sticker;
    if (Array.isArray(op.tags) && op.tags.length) patch.tags = [...new Set((op.tags as string[]).map((t) => t.trim()))];
    if (op.task === 'open' || op.task === 'done') patch.task = { done: op.task === 'done' };
    if (typeof op.link === 'string' && op.link.trim()) patch.link = op.link.trim();
    if (op.side === 'left' || op.side === 'right') {
      if (depthOf(this.doc, id) !== 1) this.warnings.push('ops[' + this.index + ']: side applies to main branches only; it was ignored.');
      else patch.side = op.side;
    }
    if (Object.keys(patch).length) this.emit([{ t: 'set', id, patch }]);
    if (op.style && typeof op.style === 'object') this.emit(setStyle(this.doc, [id], this.stylePatch(op.style))?.tx.ops);
  }

  run(op: AgentOp): void {
    switch (op.op) {
      case 'add': {
        const parent = this.node(op.parent, 'parent');
        const explicit = this.explicitNodeId(op);
        const edit = addChild(this.doc, parent, String(op.text).trim(), op.index as number | undefined, this.source);
        if (!edit) this.fail('invalid_op', 'Could not add a child under "' + parent + '".');
        const ops = this.remap(edit.tx.ops, explicit);
        this.emit(ops);
        const id = (ops.find((o) => o.t === 'insert') as Extract<Op, { t: 'insert' }>).node.id;
        if (op.folded === true) this.warnings.push('ops[' + this.index + ']: a new node has no children to fold.');
        this.nodeExtras(op, id);
        this.remember(op, id);
        return;
      }
      case 'add-root': {
        const id = this.explicitNodeId(op) ?? this.freshNode();
        const positions = Object.values(this.doc.rootInfo).map((r) => r.position);
        const position = (op.position as { x: number; y: number } | undefined) ??
          (positions.length ? { x: positions[0].x, y: Math.max(...positions.map((p) => p.y)) + 480 } : { x: 0, y: 0 });
        const info: RootInfo = { position: { x: position.x, y: position.y }, layout: (op.layout as LayoutKind | undefined) ?? 'mindmap' };
        if (op.spacing) info.spacing = op.spacing as RootSpacing;
        if (op.organic === true) info.organic = true;
        const node: MapNode = { id, parent: null, children: [], text: String(op.text).trim(), origin: { by: 'ai', job: (this.source as { ai: string }).ai } };
        this.countInsert(1);
        this.createdNodes.add(id);
        this.emit([{ t: 'insert', node, parent: null, index: this.doc.roots.length, rootInfo: info }]);
        this.nodeExtras(op, id);
        this.remember(op, id);
        return;
      }
      case 'add-tree': return this.addTree(op);
      case 'set-text': {
        const id = this.node(op.id, 'id');
        this.emit(setText(this.doc, id, String(op.text).trim())?.tx.ops);
        return;
      }
      case 'set-note': {
        const id = this.node(op.id, 'id');
        this.emit(setNote(this.doc, id, typeof op.note === 'string' ? op.note : '')?.tx.ops);
        return;
      }
      case 'set-style': {
        const ids = (op.ids as string[]).map((v) => this.node(v, 'ids'));
        this.emit(setStyle(this.doc, ids, this.stylePatch(op.style))?.tx.ops);
        return;
      }
      case 'set': return this.setFields(op);
      case 'move': {
        const id = this.node(op.id, 'id');
        const parent = this.node(op.parent, 'parent');
        if (this.doc.nodes[id].parent === null && this.doc.roots.length === 1) this.fail('last_root', 'The only root cannot become a child.');
        const index = (op.index as number | undefined) ?? this.doc.nodes[parent].children.filter((c) => c !== id).length;
        const edit = moveSubtree(this.doc, id, parent, index);
        if (!edit) this.fail('invalid_move', 'Cannot move "' + clip(this.doc.nodes[id].text) + '" into its own subtree.');
        this.emit(edit.tx.ops);
        return;
      }
      case 'reorder': {
        const id = this.node(op.id, 'id');
        const n = this.doc.nodes[id];
        const siblings = n.parent === null ? this.doc.roots : this.doc.nodes[n.parent].children;
        const from = siblings.indexOf(id);
        const to = Math.max(0, Math.min(siblings.length - 1, op.index !== undefined ? op.index as number : from + (op.delta as number)));
        if (to === from) return;
        this.emit([n.parent === null ? { t: 'move', id, parent: null, index: to, rootInfo: this.doc.rootInfo[id] } : { t: 'move', id, parent: n.parent, index: to }]);
        return;
      }
      case 'delete': {
        const ids = (op.ids as string[]).map((v) => this.node(v, 'ids'));
        const roots = new Set(ids.filter((id) => this.doc.nodes[id].parent === null));
        if (roots.size && roots.size >= this.doc.roots.length) this.fail('last_root', 'A map keeps at least one root; delete its children instead.');
        this.emit(deleteSubtree(this.doc, ids)?.tx.ops);
        return;
      }
      case 'duplicate': {
        const id = this.node(op.id, 'id');
        const edit = duplicateSubtree(this.doc, id);
        if (!edit) this.fail('invalid_op', 'Could not duplicate "' + id + '".');
        const ops = this.remap(edit.tx.ops);
        this.emit(ops);
        this.remember(op, (ops[0] as Extract<Op, { t: 'insert' }>).node.id);
        return;
      }
      case 'fold': {
        const ids = (op.ids as string[]).map((v) => this.node(v, 'ids'));
        if (op.depth !== undefined) for (const id of ids) this.emit(collapseToDepth(this.doc, id, op.depth as number)?.tx.ops);
        else if (op.folded === false && op.all === true) for (const id of ids) this.emit(expandAll(this.doc, id)?.tx.ops);
        else this.emit(toggleCollapsed(this.doc, ids, op.folded as boolean)?.tx.ops);
        return;
      }
      case 'link': {
        const from = this.node(op.from, 'from');
        const to = this.node(op.to, 'to');
        if (from === to) this.fail('self_link', 'A link cannot join a node to itself.');
        const edit = addLink(this.doc, from, to, typeof op.label === 'string' && op.label ? op.label : undefined);
        if (!edit) this.fail('link_exists', 'A link from "' + from + '" to "' + to + '" already exists.', 'conflict',
          this.doc.links.filter((l) => l.from === from && l.to === to).map((l) => l.id));
        const linkOp = edit.tx.ops[0] as Extract<Op, { t: 'link' }>;
        let id = typeof op.id === 'string' ? op.id : undefined;
        if (id && this.doc.links.some((l) => l.id === id)) this.fail('id_exists', 'Link id "' + id + '" is already used.', 'conflict');
        id ??= this.fresh((x) => this.doc.links.some((l) => l.id === x));
        linkOp.link = { ...linkOp.link, id };
        if (op.dash) linkOp.link.dash = op.dash as LinkStyle['dash'];
        if (op.arrows) linkOp.link.arrows = op.arrows as LinkStyle['arrows'];
        if (typeof op.color === 'string') linkOp.link.color = upperHex(op.color);
        this.emit([linkOp]);
        this.links.push(id);
        this.remember(op, id);
        return;
      }
      case 'unlink': {
        const id = this.linkId(op.id);
        this.emit(removeLink(this.doc, id)?.tx.ops);
        return;
      }
      case 'link-style': {
        const id = this.linkId(op.id);
        const link = this.doc.links.find((l) => l.id === id)!;
        const next: Record<string, unknown> = {};
        for (const key of ['bend', 'color', 'dash', 'arrows'] as const) if (link[key] !== undefined) next[key] = link[key];
        for (const key of ['bend', 'color', 'dash', 'arrows'] as const) {
          if (!(key in op)) continue;
          if (op[key] === null) delete next[key];
          else next[key] = key === 'color' ? upperHex(op[key] as string) : op[key];
        }
        this.emit([{ t: 'linkStyle', id, style: next as LinkStyle }]);
        return;
      }
      case 'link-label': {
        const id = this.linkId(op.id);
        const text = typeof op.label === 'string' && op.label ? op.label : undefined;
        if (this.doc.links.find((l) => l.id === id)!.label !== text) this.emit([{ t: 'setLink', id, label: text }]);
        return;
      }
      case 'set-root': {
        const id = this.node(op.id, 'id');
        const current = this.doc.rootInfo[id];
        if (!current) this.fail('not_a_root', '"' + clip(this.doc.nodes[id].text) + '" is not a root.', 'invalid', this.doc.roots.slice(0, 5));
        const info: RootInfo = { ...current, position: { ...((op.position as RootInfo['position'] | undefined) ?? current.position) } };
        if (op.layout) info.layout = op.layout as LayoutKind;
        if (op.spacing === null) delete info.spacing;
        else if (op.spacing) info.spacing = op.spacing as RootSpacing;
        if (op.organic === true) info.organic = true;
        else if (op.organic === false) delete info.organic;
        if (!sameValue(info, current)) this.emit([{ t: 'setRoot', id, info }]);
        return;
      }
      case 'doc': return this.docMeta(op);
      case 'presentation-set': return this.presentationSet(op);
      case 'presentation-delete': {
        const id = this.presentationId(op.id);
        if (!id) this.fail('unknown_presentation', 'Presentation "' + String(op.id) + '" is not in this map.', 'not_found',
          suggest(String(op.id), (this.doc.presentations ?? []).map((p) => p.id)));
        this.emit([{ t: 'presentation', id }]);
        this.presentations.push(id);
        return;
      }
      case 'canvas-add': return this.canvasAdd(op);
      case 'canvas-set': return this.canvasSet(op);
      case 'canvas-order': {
        const ids = (op.ids as string[]).map((v) => this.elementId(v));
        const edit = op.band ? setBand(this.doc, ids, op.band as 'back' | 'front') : reorderElements(this.doc, ids, op.to as 'front' | 'back' | 'forward' | 'backward');
        this.emit(edit?.tx.ops);
        this.elements.push(...ids);
        return;
      }
      case 'canvas-delete': {
        const ids = (op.ids as string[]).map((v) => this.elementId(v));
        this.emit(deleteElements(this.doc, ids)?.tx.ops);
        this.elements.push(...ids);
        return;
      }
    }
    this.fail('unknown_op', 'Unknown op "' + op.op + '".');
  }

  private addTree(op: AgentOp): void {
    const parent = this.node(op.parent, 'parent');
    const raw = op.spec;
    const parsed = typeof raw === 'string' ? parseMapSpec(raw) : parseMapSpecJson(Array.isArray(raw) ? { roots: raw }
      : raw && typeof raw === 'object' && 'roots' in raw ? raw : { roots: [raw] });
    const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length) this.fail('invalid_spec', 'The spec fragment has ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + '; first: ' + describe(errors[0]));
    for (const d of parsed.diagnostics) if (d.severity === 'warning') this.warnings.push('ops[' + this.index + '] spec: ' + describe(d));
    const spec = parsed.spec;
    if (!spec.roots.length) this.fail('invalid_spec', 'The spec fragment has no nodes.');
    if (spec.links?.length || spec.presentations?.length || spec.canvas?.length || spec.title || spec.theme) {
      this.warnings.push('ops[' + this.index + ']: add-tree inserts the outline only; front matter and blocks were ignored (use link, doc, presentation-set and canvas-add ops).');
    }
    const order: MapSpecNode[] = [];
    const visit = (n: MapSpecNode) => { order.push(n); for (const c of n.children ?? []) visit(c); };
    for (const r of spec.roots) visit(r);
    const explicit = new Set<string>();
    for (const node of order) {
      if (!node.id) continue;
      if (this.doc.nodes[node.id] || explicit.has(node.id)) this.fail('id_exists', 'Id "' + node.id + '" in the spec fragment is already used.', 'conflict');
      explicit.add(node.id);
    }
    const ops: Op[] = [];
    let at = (op.index as number | undefined) ?? this.doc.nodes[parent].children.length;
    if (this.doc.nodes[parent].collapsed) ops.push({ t: 'set', id: parent, patch: { collapsed: undefined } });
    for (const root of spec.roots) outlineInsertOps(specOutline(root), parent, at++, this.source, ops);
    // outlineInsertOps writes pre-order, the order of "order".
    const renamed = new Map<string, string>();
    const ids: string[] = [];
    const tops: string[] = [];
    for (const o of ops) {
      if (o.t !== 'insert') continue;
      const node = order[ids.length];
      const id = node.id ?? this.fresh((x) => !!this.doc.nodes[x] || explicit.has(x) || ids.includes(x));
      renamed.set(o.node.id, id);
      ids.push(id);
      o.node = { ...o.node, id };
      if (o.parent !== null && renamed.has(o.parent)) o.parent = o.node.parent = renamed.get(o.parent)!;
      if (o.parent === parent) tops.push(id);
      this.createdNodes.add(id);
    }
    this.countInsert(ids.length);
    this.emit(ops);
    order.forEach((node, k) => {
      const id = ids[k];
      const style = specStyle(node);
      if (Object.keys(style).length) this.emit(setStyle(this.doc, [id], style)?.tx.ops);
      const patch: Patch = {};
      if (node.sticker) patch.sticker = node.sticker;
      if (node.tags?.length) patch.tags = node.tags.slice();
      if (node.task) patch.task = { done: node.task === 'done' };
      if (node.image) this.warnings.push('ops[' + this.index + ']: pictures in a fragment need assets; "' + clip(node.label) + '" was added without its picture.');
      if (node.side && depthOf(this.doc, id) === 1) patch.side = node.side;
      if (node.layout && depthOf(this.doc, id) === 1 && TREE_LAYOUTS.includes(node.layout)) patch.branchLayout = node.layout;
      if (Object.keys(patch).length) this.emit([{ t: 'set', id, patch }]);
    });
    this.remember(op, tops[0]);
    for (const id of explicit) this.refs.set(id, id);
  }

  private setFields(op: AgentOp): void {
    const id = this.node(op.id, 'id');
    const n = this.doc.nodes[id];
    const raw = op.patch as Record<string, unknown>;
    const patch: Patch = {};
    const depth = depthOf(this.doc, id);
    for (const [key, value] of Object.entries(raw)) {
      switch (key) {
        case 'sticker': patch.sticker = value === null || value === '' ? undefined : value as string; break;
        case 'tags': patch.tags = value === null || !(value as string[]).length ? undefined : [...new Set((value as string[]).map((t) => t.trim()))]; break;
        case 'task': patch.task = value === null ? undefined : { done: value === 'done' }; break;
        case 'link': case 'href': patch.link = value === null || value === '' ? undefined : (value as string).trim(); break;
        case 'collapsed': case 'folded': patch.collapsed = value === true && n.children.length ? true : undefined; break;
        case 'side':
          if (value !== null && depth !== 1) this.fail('not_a_main_branch', '"side" applies to main branches (children of a root) only.');
          patch.side = value === null ? undefined : value as 'left' | 'right';
          break;
        case 'branchLayout': case 'layout':
          if (value !== null && depth !== 1) this.fail('not_a_main_branch', '"' + key + '" applies to main branches only; use set-root for a root.');
          patch.branchLayout = value === null ? undefined : value as LayoutKind;
          break;
        case 'image':
          if (value === null) {
            patch.imageAsset = undefined;
            patch.imageAspect = undefined;
            if (n.representation === 'picture') patch.representation = undefined;
          } else {
            patch.imageAsset = (value as string).replace(/^sha256:/, '');
            patch.representation = 'picture';
          }
          break;
        case 'alt': patch.imageAlt = value === null || value === '' ? undefined : value as string; break;
        case 'scale': patch.imageScale = value === null ? undefined : value as number; break;
        case 'offset': patch.offset = value === null ? undefined : { x: (value as { x: number }).x, y: (value as { y: number }).y }; break;
      }
    }
    const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => !sameValue((n as unknown as Record<string, unknown>)[k] ?? null, v ?? null)));
    if (Object.keys(changed).length) this.emit([{ t: 'set', id, patch: changed as Patch }]);
  }

  private docMeta(op: AgentOp): void {
    const patch: Extract<Op, { t: 'docMeta' }>['patch'] = {};
    if (typeof op.title === 'string' && op.title.trim() !== this.doc.title) patch.title = op.title.trim();
    if (typeof op.theme === 'string') {
      const ids = listThemes().map((t) => t.id);
      if (!ids.includes(op.theme)) this.fail('unknown_theme', 'Unknown theme "' + op.theme + '".', 'not_found', suggest(op.theme, ids));
      if (op.theme !== this.doc.themeId) patch.themeId = op.theme;
    }
    if ('themeSettings' in op) {
      if (op.themeSettings === null) patch.themeSettings = undefined;
      else {
        const parsed = parseThemeSettings(op.themeSettings);
        const dropped = Object.keys(op.themeSettings as object).filter((k) => !parsed || !(k in parsed));
        if (dropped.length) this.fail('invalid_theme_settings', 'themeSettings has unknown or invalid fields: ' + dropped.join(', ') + '.');
        patch.themeSettings = parsed;
      }
    }
    if ('tagColors' in op) {
      patch.tagColors = op.tagColors === null ? undefined : Object.fromEntries(Object.entries(op.tagColors as Record<string, string>).map(([t, c]) => [t.toLowerCase(), upperHex(c)]));
    }
    if (typeof op.seed === 'number' && op.seed !== this.doc.seed) patch.seed = op.seed;
    if (Object.keys(patch).length) this.emit([{ t: 'docMeta', patch }]);
  }

  /** A presentation step from a step line or object; node and element refs resolved and checked. */
  private step(value: unknown, taken: Set<string>, n: number): PresentationStep {
    const resolved = typeof value === 'string' ? value.replace(/@([A-Za-z0-9_-]{1,64})/g, (all, name: string) => this.refs.get(name) ?? all)
      : value && typeof value === 'object' && !Array.isArray(value) ? this.resolveDeep(value) : value;
    const { step, diagnostics } = parseSpecStep(resolved);
    const error = diagnostics.find((d) => d.severity === 'error');
    if (!step || error) this.fail('invalid_step', 'Step ' + n + ': ' + (error ? describe(error) : 'it could not be read.'));
    for (const d of diagnostics) if (d.severity === 'warning') this.warnings.push('ops[' + this.index + '] step ' + n + ': ' + describe(d));
    for (const field of ['focus', 'reveal', 'hide'] as const) for (const id of step[field] ?? []) this.node(id, 'step ' + n + ' ' + field);
    for (const id of step.elements ?? []) this.elementId(id);
    let id = step.id;
    if (id && taken.has(id)) this.fail('duplicate_id', 'Step id "' + id + '" is already used in this presentation.', 'conflict');
    id ??= this.fresh((x) => taken.has(x));
    taken.add(id);
    const out: PresentationStep = { id, focus: step.focus };
    for (const key of ['reveal', 'hide', 'elements', 'frame', 'build', 'dim', 'title', 'caption', 'note', 'transition', 'skip', 'seconds'] as const) {
      if (step[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = step[key];
    }
    return out;
  }

  private resolveDeep(value: object): unknown {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = typeof v === 'string' ? this.resolve(v) : Array.isArray(v) ? v.map((x) => typeof x === 'string' ? this.resolve(x) : x) : v;
    }
    return out;
  }

  private presentationSet(op: AgentOp): void {
    const list = this.doc.presentations ?? [];
    const existing = op.id !== undefined ? this.presentationId(op.id) : null;
    const id = existing ?? (op.id !== undefined ? this.resolve(String(op.id)) : this.fresh((x) => list.some((p) => p.id === x)));
    if (!existing && !SPEC_ID.test(id)) this.fail('invalid_id', 'Presentation id "' + id + '" must be letters, digits, "_" or "-".');
    const current = list.find((p) => p.id === id);
    const value: Presentation = current ? JSON.parse(JSON.stringify(current)) : { id, name: 'Presentation', steps: [] };
    if (!current && typeof op.name !== 'string') this.warnings.push('ops[' + this.index + ']: the new presentation has no name; it is called "Presentation".');
    if (typeof op.name === 'string') value.name = op.name.trim();
    for (const key of ['reveal', 'context', 'dimOpacity', 'motion', 'targetMinutes'] as const) {
      if (op[key] !== undefined) (value as unknown as Record<string, unknown>)[key] = op[key];
    }
    if (op.auto) value.steps = autoTour(this.doc, { granularity: op.auto as TourGranularity });
    if (Array.isArray(op.steps)) {
      const taken = new Set<string>();
      value.steps = op.steps.map((s, k) => this.step(s, taken, k));
    }
    if (Array.isArray(op.addSteps)) {
      const taken = new Set(value.steps.map((s) => s.id));
      const added = op.addSteps.map((s, k) => this.step(s, taken, k));
      const at = Math.min(value.steps.length, (op.at as number | undefined) ?? value.steps.length);
      value.steps.splice(at, 0, ...added);
    }
    const problems = presentationProblems(value);
    if (problems.length) this.fail('invalid_presentation', 'The presentation is invalid: ' + problems[0]);
    if (!current || !sameValue(current, value)) this.emit([{ t: 'presentation', id, value }]);
    this.presentations.push(id);
    this.remember(op, id);
  }

  private elementContext() {
    const kinds = new Map<string, CanvasElementKind>((this.doc.canvas?.elements ?? []).map((e) => [e.id, e.kind]));
    return { nodes: new Set(Object.keys(this.doc.nodes)), elements: kinds };
  }

  private canvasAdd(op: AgentOp): void {
    const limit = canvasLimitError(this.doc, 1);
    if (limit) this.fail('too_many_elements', limit);
    const ctx = this.elementContext();
    let raw = op.element;
    let source: Record<string, unknown> | undefined;
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'source' in raw) {
      // Unused fields of an imported Excalidraw element ride along for round trip (CNV-50).
      const { source: kept, ...rest } = raw as Record<string, unknown>;
      if (kept && typeof kept === 'object' && !Array.isArray(kept)) source = JSON.parse(JSON.stringify(kept)) as Record<string, unknown>;
      raw = rest;
    }
    const resolved = typeof raw === 'string'
      ? raw.replace(/\b(from|to|frame)=@([A-Za-z0-9_-]{1,64})/g, (all, key: string, name: string) => this.refs.has(name) ? key + '=' + this.refs.get(name) : all)
      : this.resolveDeep(raw as object);
    const { element, diagnostics } = compileSpecElement(resolved, {
      ...ctx,
      asset: (name) => /^(sha256:)?[a-f0-9]{64}$/.test(name) ? { hash: name.replace(/^sha256:/, '') } : undefined
    }, () => this.fresh((x) => ctx.elements.has(x) || ctx.nodes.has(x)));
    const error = diagnostics.find((d) => d.severity === 'error');
    if (!element || error) this.fail(error?.code === 'duplicate_id' ? 'id_exists' : 'invalid_element', error ? describe(error) : 'The element could not be read.',
      error?.code === 'duplicate_id' ? 'conflict' : error?.code === 'unknown_binding' || error?.code === 'unknown_frame' ? 'not_found' : 'invalid', error?.suggestions);
    for (const d of diagnostics) if (d.severity === 'warning') this.warnings.push('ops[' + this.index + ']: ' + describe(d));
    if (source) element.source = source;
    const index = op.index as number | undefined;
    this.emit([{ t: 'canvas', id: element.id, value: element, ...(index === undefined ? {} : { index }) }]);
    this.elements.push(element.id);
    this.remember(op, element.id);
  }

  private canvasSet(op: AgentOp): void {
    const id = this.elementId(op.id);
    const current = this.doc.canvas!.elements.find((e) => e.id === id)!;
    const patch: Record<string, unknown> = {};
    const ctx = this.elementContext();
    const binding = (value: unknown, end: 'start' | 'end') => {
      if (value === null) return undefined;
      const target = this.resolve(String(value).replace(/^#/, ''));
      if (ctx.nodes.has(target)) return { ...current[end], node: target, element: undefined };
      if (ctx.elements.has(target) && target !== id) return { ...current[end], element: target, node: undefined };
      this.fail('unknown_binding', (end === 'start' ? 'from' : 'to') + ' "' + String(value) + '" is neither a node nor an element.', 'not_found',
        suggest(target, [...ctx.nodes, ...ctx.elements.keys()]));
    };
    for (const [key, value] of Object.entries(op.patch as Record<string, unknown>)) {
      if (key === 'id' || key === 'kind') this.fail('invalid_op', 'canvas-set cannot change "' + key + '".');
      if (key === 'at' || key === 'size') {
        if (!Array.isArray(value) || value.length !== 2 || !value.every((v) => typeof v === 'number' && Number.isFinite(v))) this.fail('invalid_op', '"' + key + '" must be [number, number].');
        const [a, b] = value as number[];
        Object.assign(patch, key === 'at' ? { x: a, y: b } : { w: a, h: b });
      } else if (key === 'from' || key === 'to') {
        const b = binding(value, key === 'from' ? 'start' : 'end');
        patch[key === 'from' ? 'start' : 'end'] = b && Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined));
      } else if (key === 'frame' && typeof value === 'string') patch.frame = this.resolve(value);
      else if (key === 'source') this.fail('invalid_op', '"source" holds imported Excalidraw fields and cannot be set.');
      else if (value === null && ['x', 'y', 'w', 'h', 'seed'].includes(key)) this.fail('invalid_op', '"' + key + '" cannot be cleared.');
      else if (key === 'image' || key === 'asset') patch.asset = value === null ? undefined : String(value).replace(/^sha256:/, '');
      else patch[key] = value === null ? undefined : value;
    }
    const merged = { ...current, ...patch } as Record<string, unknown>;
    for (const key of Object.keys(patch)) if (patch[key] === undefined) delete merged[key];
    const problems: string[] = [];
    parseCanvasElement(merged, { nodes: this.doc.nodes as Record<string, unknown>, elements: ctx.elements }, (m) => problems.push(m));
    if (problems.length) this.fail('invalid_element', 'The changed element is invalid: ' + problems[0]);
    const edit = updateElement(this.doc, id, patch as Partial<Omit<CanvasElement, 'id' | 'kind'>>);
    this.emit(edit?.tx.ops);
    this.elements.push(id);
  }
}

function upperHex(value: string): string {
  const v = value.trim();
  return (v.length === 4 ? '#' + v.slice(1).split('').map((c) => c + c).join('') : v).toUpperCase();
}

function describe(d: SpecDiagnostic): string {
  const where = d.line !== undefined ? 'line ' + d.line + ': ' : d.path && d.path !== 'step' && d.path !== 'element' ? d.path + ': ' : '';
  return where + d.message + (d.suggestions?.length ? ' (did you mean ' + d.suggestions.join(', ') + '?)' : '');
}

// ====================================================================== apply: make a map match a spec (AGT-SPEC-08)

export interface ApplyPlanOptions {
  /** merge (default) never deletes; replace makes the map or branch match exactly and needs the destructive tier. */
  mode?: 'merge' | 'replace';
  /** Apply to this branch only: the spec's single root describes this node. */
  at?: NodeId;
  /** Which document-level fields the spec states (only those are applied). */
  meta?: { title?: boolean; theme?: boolean; themeSettings?: boolean; tagColors?: boolean; seed?: boolean };
}

export interface ApplyPlan {
  ops: AgentOp[];
  /** Counts by kind of change. */
  summary: { added: number; edited: number; moved: number; deleted: number; links: number; presentations: number; elements: number; meta: number };
  warnings: string[];
}

const NODE_FIELDS = ['note', 'sticker', 'tags', 'task', 'link', 'collapsed', 'side', 'branchLayout', 'imageAsset', 'imageAlt', 'imageScale'] as const;

/**
 * Agent ops that make doc match target (a document compiled from a spec), comparing ids. Nodes are matched by id;
 * nodes of the spec that the map lacks are added with their spec ids, so applying twice changes nothing the second
 * time. In merge mode nothing is deleted and fields the spec leaves out are kept.
 */
export function planApply(doc: Doc, target: Doc, opts: ApplyPlanOptions = {}): ApplyPlan {
  const mode = opts.mode ?? 'merge';
  const ops: AgentOp[] = [];
  const warnings: string[] = [];
  const summary = { added: 0, edited: 0, moved: 0, deleted: 0, links: 0, presentations: 0, elements: 0, meta: 0 };
  let work = cloneDoc(doc);
  // Compile each planned op against the working copy so later index computations see earlier changes.
  const push = (op: AgentOp) => {
    work = runAgentBatch(work, { ops: [op] }, { allowDestructive: true }).doc;
    ops.push(op);
  };
  if (opts.at && !doc.nodes[opts.at]) throw new AgentOpError('unknown_node', 'No node "' + opts.at + '" to apply the spec at.', 'not_found', { suggestions: suggest(opts.at, Object.keys(doc.nodes)) });
  if (opts.at && target.roots.length !== 1) throw new AgentOpError('invalid_spec', 'With --at the spec must have exactly one root (the branch); it has ' + target.roots.length + '.');
  // Spec id to map id: the spec root stands for --at.
  const mapId = (id: NodeId) => (opts.at && id === target.roots[0] ? opts.at : id);
  const specNodes: NodeId[] = [];
  const visit = (id: NodeId) => { specNodes.push(id); for (const c of target.nodes[id].children) visit(c); };
  for (const r of target.roots) visit(r);
  const inSpec = new Set(specNodes.map(mapId));
  const fieldsOf = (n: MapNode) => {
    const out: Record<string, unknown> = {};
    for (const key of NODE_FIELDS) if (n[key] !== undefined) out[key] = n[key];
    return out;
  };
  const insertAt = (specParent: NodeId, id: NodeId, parent: NodeId) => {
    const siblings = target.nodes[specParent].children.map(mapId);
    const before = siblings.slice(0, siblings.indexOf(id)).reverse().find((x) => work.nodes[x]?.parent === parent);
    return before ? work.nodes[parent].children.indexOf(before) + 1 : 0;
  };

  for (const specId of specNodes) {
    const s = target.nodes[specId];
    const id = mapId(specId);
    const isRoot = s.parent === null;
    const parent = s.parent === null ? null : mapId(s.parent);
    if (!work.nodes[id]) {
      if (isRoot) {
        const info = target.rootInfo[specId];
        push({ op: 'add-root', id, text: s.text.trim() || '-', layout: info.layout, ...(info.spacing ? { spacing: info.spacing } : {}), ...(info.organic ? { organic: true } : {}) });
      } else push({ op: 'add', parent: parent!, id, text: s.text.trim() || '-', index: insertAt(s.parent!, id, parent!) });
      summary.added++;
    } else {
      if (!isRoot && work.nodes[id].parent !== parent) {
        push({ op: 'move', id, parent: parent!, index: insertAt(s.parent!, id, parent!) });
        summary.moved++;
      }
      if (work.nodes[id].text !== s.text && s.text.trim()) { push({ op: 'set-text', id, text: s.text }); summary.edited++; }
    }
    const current = work.nodes[id];
    const styleChange: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.style ?? {})) if (!sameValue((current.style as Record<string, unknown> | undefined)?.[k], v)) styleChange[k] = v;
    if (mode === 'replace') for (const k of Object.keys(current.style ?? {})) if (!(k in (s.style ?? {}))) styleChange[k] = null;
    const want = fieldsOf(s);
    const have = fieldsOf(current);
    const patch: Record<string, unknown> = {};
    let noteChange: string | null | undefined;
    for (const key of NODE_FIELDS) {
      const w = want[key];
      const h = have[key];
      if (w === undefined && (mode === 'merge' || h === undefined)) continue;
      if (sameValue(w, h)) continue;
      if (key === 'note') { noteChange = (w as string | undefined) ?? null; continue; }
      if ((key === 'side' || key === 'branchLayout') && depthOf(work, id) !== 1) continue;
      if (key === 'collapsed' && w === true && !current.children.length && !s.children.length) continue;
      if (key === 'imageAsset' && w !== undefined && !imageKnown(work, w as string)) {
        warnings.push('The picture on "' + clip(s.text) + '" is not embedded in the map yet.');
      }
      const name = key === 'imageAsset' ? 'image' : key === 'imageAlt' ? 'alt' : key === 'imageScale' ? 'scale' : key;
      patch[name] = w === undefined ? null : key === 'task' ? ((w as { done: boolean }).done ? 'done' : 'open') : w;
    }
    // A fold on a new node waits until its children exist.
    if (patch.collapsed === true && !current.children.length) delete patch.collapsed;
    if (Object.keys(styleChange).length) push({ op: 'set-style', ids: [id], style: styleChange });
    if (noteChange !== undefined) push({ op: 'set-note', id, note: noteChange ?? '' });
    if (Object.keys(patch).length) push({ op: 'set', id, patch });
    if (Object.keys(styleChange).length || noteChange !== undefined || Object.keys(patch).length) summary.edited++;
    if (isRoot && !opts.at) {
      const wantInfo = target.rootInfo[specId];
      const haveInfo = work.rootInfo[id];
      const change: Record<string, unknown> = {};
      if (wantInfo.layout !== haveInfo.layout) change.layout = wantInfo.layout;
      if ((wantInfo.spacing ?? null) !== (haveInfo.spacing ?? null) && (wantInfo.spacing || mode === 'replace')) change.spacing = wantInfo.spacing ?? null;
      if (!!wantInfo.organic !== !!haveInfo.organic && (wantInfo.organic || mode === 'replace')) change.organic = !!wantInfo.organic;
      if (Object.keys(change).length) { push({ op: 'set-root', id, ...change }); summary.edited++; }
    }
  }
  // Folds that had to wait for children.
  for (const specId of specNodes) {
    const id = mapId(specId);
    if (target.nodes[specId].collapsed && !work.nodes[id].collapsed && work.nodes[id].children.length) push({ op: 'fold', ids: [id], folded: true });
  }
  // Child order among spec children, for every spec parent.
  for (const specId of specNodes) {
    const desired = target.nodes[specId].children.map(mapId);
    if (desired.length < 2) continue;
    const id = mapId(specId);
    for (let i = 1; i < desired.length; i++) {
      const kids = work.nodes[id].children;
      const prev = kids.indexOf(desired[i - 1]);
      const here = kids.indexOf(desired[i]);
      if (here > prev) continue;
      push({ op: 'move', id: desired[i], parent: id, index: prev });
      summary.moved++;
    }
  }
  // Links between nodes the spec names.
  const pair = (l: { from: string; to: string }) => l.from + '>' + l.to;
  const mapLinks = new Map(work.links.map((l) => [pair(l), l]));
  const specPairs = new Set<string>();
  for (const l of target.links) {
    const from = mapId(l.from), to = mapId(l.to);
    specPairs.add(from + '>' + to);
    const existing = mapLinks.get(from + '>' + to);
    if (!existing) {
      push({ op: 'link', from, to, ...(l.label ? { label: l.label } : {}), ...(l.dash ? { dash: l.dash } : {}), ...(l.arrows ? { arrows: l.arrows } : {}),
        ...(l.color ? { color: l.color } : {}), ...(SPEC_ID.test(l.id) && !work.links.some((x) => x.id === l.id) ? { id: l.id } : {}) });
      summary.links++;
      continue;
    }
    if ((existing.label ?? '') !== (l.label ?? '') && (l.label || mode === 'replace')) { push({ op: 'link-label', id: existing.id, label: l.label ?? null }); summary.links++; }
    const linkStyle: Record<string, unknown> = {};
    for (const key of ['dash', 'arrows', 'color'] as const) {
      if (l[key] !== undefined && l[key] !== existing[key]) linkStyle[key] = l[key];
      else if (l[key] === undefined && existing[key] !== undefined && mode === 'replace') linkStyle[key] = null;
    }
    if (Object.keys(linkStyle).length) { push({ op: 'link-style', id: existing.id, ...linkStyle }); summary.links++; }
  }
  if (!opts.at) {
    // Document fields the spec states.
    const meta: Record<string, unknown> = {};
    if (opts.meta?.title && target.title !== work.title) meta.title = target.title;
    if (opts.meta?.theme && target.themeId !== work.themeId) meta.theme = target.themeId;
    if (opts.meta?.themeSettings && !sameValue(target.themeSettings ?? null, work.themeSettings ?? null)) meta.themeSettings = target.themeSettings ?? null;
    if (opts.meta?.tagColors && !sameValue(target.tagColors ?? null, work.tagColors ?? null)) meta.tagColors = target.tagColors ?? null;
    if (opts.meta?.seed && target.seed !== work.seed) meta.seed = target.seed;
    if (Object.keys(meta).length) { push({ op: 'doc', ...meta }); summary.meta++; }
    // Canvas elements and presentations, by id.
    const mapElements = new Map((work.canvas?.elements ?? []).map((e) => [e.id, e]));
    for (const el of target.canvas?.elements ?? []) {
      const have = mapElements.get(el.id);
      if (!have) { push({ op: 'canvas-add', element: canvasInput(el) }); summary.elements++; continue; }
      if (have.kind !== el.kind) { warnings.push('Canvas element ' + el.id + ' is a ' + have.kind + ' in the map and a ' + el.kind + ' in the spec; it was left alone.'); continue; }
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(el)) if (k !== 'id' && k !== 'kind' && !sameValue((have as unknown as Record<string, unknown>)[k], v)) patch[k] = v;
      if (mode === 'replace') for (const k of Object.keys(have)) if (!(k in el) && k !== 'source') patch[k] = null;
      if (Object.keys(patch).length) { push({ op: 'canvas-set', id: el.id, patch }); summary.elements++; }
    }
    for (const p of target.presentations ?? []) {
      const have = work.presentations?.find((x) => x.id === p.id);
      if (have && sameValue(have, p)) continue;
      const fields: Record<string, unknown> = { name: p.name };
      for (const key of ['reveal', 'context', 'dimOpacity', 'motion', 'targetMinutes'] as const) if (p[key] !== undefined) fields[key] = p[key];
      push({ op: 'presentation-set', id: p.id, ...fields, steps: p.steps.map((s) => ({ ...s })) });
      summary.presentations++;
    }
    if (mode === 'replace') {
      const keep = new Set((target.canvas?.elements ?? []).map((e) => e.id));
      const gone = (work.canvas?.elements ?? []).filter((e) => !keep.has(e.id)).map((e) => e.id);
      if (gone.length) { push({ op: 'canvas-delete', ids: gone }); summary.elements += gone.length; }
      const keepP = new Set((target.presentations ?? []).map((p) => p.id));
      for (const p of work.presentations ?? []) if (!keepP.has(p.id)) { push({ op: 'presentation-delete', id: p.id }); summary.presentations++; }
    }
  }
  if (mode === 'replace') {
    for (const l of work.links.slice()) {
      if (inSpec.has(l.from) && inSpec.has(l.to) && !specPairs.has(pair(l))) { push({ op: 'unlink', id: l.id }); summary.links++; }
    }
    const scope = opts.at ? [opts.at] : work.roots.slice();
    const extra: NodeId[] = [];
    const walk = (id: NodeId) => {
      if (!inSpec.has(id)) { extra.push(id); return; }
      for (const c of work.nodes[id].children) walk(c);
    };
    for (const r of scope) walk(r);
    if (extra.length) {
      const roots = extra.filter((id) => work.nodes[id].parent === null);
      const keepOne = roots.length >= work.roots.length;
      if (keepOne) warnings.push('A map keeps at least one root; the last root was kept.');
      const ids = keepOne ? extra.filter((id) => id !== roots[0]) : extra;
      if (ids.length) { push({ op: 'delete', ids }); summary.deleted += ids.length; }
    }
  }
  return { ops, summary, warnings };
}

function imageKnown(doc: Doc, hash: string): boolean {
  return Object.values(doc.nodes).some((n) => n.imageAsset === hash) || (doc.canvas?.elements ?? []).some((e) => e.asset === hash);
}

/** A stored element as canvas-add input. */
function canvasInput(el: CanvasElement): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (k === 'source') continue;
    if (k === 'asset') out.image = v;
    else out[k] = v;
  }
  return out;
}

