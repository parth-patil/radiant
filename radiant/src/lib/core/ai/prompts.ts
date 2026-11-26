/**
 * Prompt builders for the Codex engine (decision D-08). Each returns `{ instructions, prompt }`: `instructions` is
 * sent as developer instructions (the output contract), `prompt` is the task. The model writes one node per line
 * as compact JSON; the front end parses it with NodeLineParser and applies it with StreamApplier.
 */
import { fill } from './template';
import nodeStream from './templates/node-stream.json';
import mapTemplate from './templates/map.json';
import expandTemplate from './templates/expand.json';
import rephraseTemplate from './templates/rephrase.json';
import { SHEET_FONTS } from '../model/generated-style';
import { boundSource } from './source';
import type { BranchStyle, LayoutKind, NodeShape, StyleSheet } from '../types';

export interface PromptPair {
  instructions: string;
  prompt: string;
  templateVersion?: string;
}

function parts(...sections: string[]): string {
  return sections.map((part) => part.trim()).filter(Boolean).join('\n\n');
}

function detail(label: string, value?: string): string {
  return value?.trim() ? `${label}: ${value.trim()}\n` : '';
}

/** Allowed style values, shared with the stream parser so prompt and validator cannot drift apart. */
export const STYLE_BRANCHES: readonly BranchStyle[] = ['tapered', 'organic', 'line'];
export const STYLE_SHAPES: readonly NodeShape[] = ['underline', 'box', 'none'];
export const STYLE_LAYOUTS: readonly LayoutKind[] = ['mindmap', 'right', 'left', 'down', 'radial'];

export interface GenerateOptions {
  /** Levels below the root. Default 3. */
  depth?: number;
  /** Maximum children per node. Default 5. */
  breadth?: number;
  /** Audience or purpose, e.g. "study", "presentation", "brainstorm". */
  audience?: string;
  /** Source material the map must be built from. The caller truncates it to fit and tells the user. */
  source?: string;
  /** Longest node title in words. Default 4 (Buzan: one key word or a short phrase). */
  maxTitleWords?: number;
  /** Ask for notes on nodes where a short explanation helps. Default false (keep labels terse). */
  withNotes?: boolean;
  /** Ask for an imageHint on main branches (for later picture generation). Default false. */
  withImageHints?: boolean;
}

const DEFAULT_DEPTH = 3;
const DEFAULT_MAX_TITLE_WORDS = 4;

export function generationLimits(opts: Pick<GenerateOptions, 'depth' | 'breadth'>) {
  return {
    maxDepth: Math.max(1, Math.round(opts.depth ?? DEFAULT_DEPTH)),
    maxChildren: Math.max(1, Math.round(opts.breadth ?? 5))
  };
}

interface LineFormatOptions {
  allowStyleLine: boolean;
  withNotes: boolean;
  withImageHints: boolean;
  withSource?: boolean;
}

function optionalFields(opts: LineFormatOptions) {
  const keys: Array<keyof typeof nodeStream.optionalFields> = [];
  if (opts.withNotes) keys.push('note');
  if (opts.withImageHints) keys.push('imageHint');
  if (opts.withSource) keys.push('sourceHeading');
  return keys;
}

function lineFormat(opts: LineFormatOptions): string {
  const fields = optionalFields(opts).map(key => `"${nodeStream.fields[key]}" (${nodeStream.optionalFields[key]})`);
  return fill(nodeStream.format.join('\n'), {
    ...nodeStream.fields, version: nodeStream.version, maxTitle: nodeStream.limits.title,
    optional: fields.length ? fill(nodeStream.withOptional, { fields: fields.join(', ') }) : nodeStream.withoutOptional,
    style: opts.allowStyleLine ? nodeStream.withStyle : nodeStream.withoutStyle
  });
}

function exampleStream(opts: LineFormatOptions): string {
  const { id, parent, title } = nodeStream.fields;
  const fields = [id, parent, title, ...optionalFields(opts).map(key => nodeStream.fields[key])];
  return nodeStream.example.map(node => JSON.stringify(node, fields)).join('\n');
}

function titleRules(maxWords: number): string {
  return fill(nodeStream.titleRules, { maxWords });
}

function styleLineRules(style: StyleSheet): string {
  const fixed = (['palette', 'branch', 'shape', 'layout'] as const)
    .filter(key => key === 'palette' ? style.palette?.length : style[key])
    .map(key => key + ' = ' + JSON.stringify(style[key]));
  return fill(mapTemplate.styleLine, {
    branches: STYLE_BRANCHES.join(', '), shapes: STYLE_SHAPES.join(', '), layouts: STYLE_LAYOUTS.join(', '),
    fonts: JSON.stringify(SHEET_FONTS), fixed: fixed.length ? fill(mapTemplate.fixedStyle, { fields: fixed.join(', ') }) : ''
  });
}

/** Whole-map generation from a topic (and optional source). The first output line may carry the style sheet. */
export function buildGenerateMapPrompt(topic: string, style: StyleSheet, opts: GenerateOptions = {}): PromptPair & { execFallbackPrompt: string } {
  const { maxDepth: depth, maxChildren } = generationLimits(opts);
  const breadth = fill(mapTemplate.breadth, { maxChildren });
  const mainBranches = maxChildren <= 3 ? String(maxChildren) : `3 to ${Math.min(5, maxChildren)}`;
  const source = boundSource(opts.source ?? '').text.trim();
  const values = {
    topic: topic.trim(),
    depth,
    breadth,
    mainBranches,
    style: detail('Style request', style.request),
    audience: detail('Audience / purpose', opts.audience),
    source: source ? fill(mapTemplate.source, { source }) : '',
    sourceRules: source ? mapTemplate.sourceRules : '',
    titleRules: titleRules(opts.maxTitleWords ?? DEFAULT_MAX_TITLE_WORDS)
  };
  const rules = fill(mapTemplate.rules, values);
  const stylePart = fill(mapTemplate.style, { styleRules: styleLineRules(style) });
  const format = { allowStyleLine: true, withNotes: !!opts.withNotes, withImageHints: !!opts.withImageHints, withSource: !!source };
  const fallbackContract = fill(mapTemplate.fallbackOutput, {
    notes: opts.withNotes ? mapTemplate.notes : mapTemplate.noNotes,
    sourceHeading: source ? mapTemplate.sourceHeading : mapTemplate.noSourceHeading
  });
  return {
    templateVersion: mapTemplate.version,
    instructions: parts(mapTemplate.role, fill(mapTemplate.output, { contract: lineFormat(format) }), stylePart, rules,
      fill(mapTemplate.example, { example: exampleStream(format) })),
    prompt: fill(mapTemplate.task, { ...values, closing: mapTemplate.closing }),
    execFallbackPrompt: parts(
      mapTemplate.role, fallbackContract, fill(mapTemplate.style, { styleRules: '' }),
      rules, mapTemplate.fallbackExample,
      fill(mapTemplate.task, { ...values, closing: mapTemplate.fallbackClosing })
    )
  };
}

export interface ExpandContext {
  /** The permanent id of the node to expand. New first-level lines get this as their "parent". */
  nodeId: string;
  /** Texts from the root down to and including the node, e.g. ["Coffee", "Brewing", "Espresso"]. */
  path: string[];
  nodeText: string;
  /** Texts of its current children (must not be repeated). */
  existingChildren: string[];
  /** Texts of its siblings, for context. */
  siblings: string[];
  /** The node's note, if any. */
  note?: string;
}

export interface ExpandOptions {
  depth?: number; // levels of new nodes below the node; default 1
  maxTitleWords?: number;
  audience?: string;
  /** What the new nodes should cover, when the user narrows it. */
  focus?: string;
  /** The user's own guidance in place of DEFAULT_EXPAND_GUIDANCE; empty or blank means the default. */
  guidance?: string;
}

/** The editable part of the expansion instructions as built in: the role, the style and the choice of branches. */
export const DEFAULT_EXPAND_GUIDANCE: string = expandTemplate.guidance;
/** Longest guidance a user may set, in characters. */
export const EXPAND_GUIDANCE_LIMIT = 4000;

/** The guidance to send: the user's text when it is set and differs from the default, else undefined. */
export function customExpandGuidance(text: string | undefined): string | undefined {
  const value = text?.trim().slice(0, EXPAND_GUIDANCE_LIMIT).trim();
  return value && value !== DEFAULT_EXPAND_GUIDANCE ? value : undefined;
}

/**
 * Adds new children (and optionally grandchildren) under one existing node. Never changes other nodes. The
 * guidance comes first and may be the user's; the output contract, the parent and count rules, the title rules and
 * the example always follow it, so the parser can read the answer whatever the guidance says.
 */
export function buildExpandPrompt(
  ctx: ExpandContext,
  style: StyleSheet,
  count?: number,
  opts: ExpandOptions = {},
): PromptPair {
  const n = Math.max(1, Math.round(count ?? 4));
  const depth = Math.max(1, Math.round(opts.depth ?? 1));
  const maxWords = opts.maxTitleWords ?? DEFAULT_MAX_TITLE_WORDS;
  const parent = JSON.stringify(ctx.nodeId);
  const contract = lineFormat({ allowStyleLine: false, withNotes: false, withImageHints: false });
  const custom = customExpandGuidance(opts.guidance);
  return {
    templateVersion: expandTemplate.version + (custom ? '+custom' : ''),
    instructions: parts(
      custom ?? DEFAULT_EXPAND_GUIDANCE, fill(expandTemplate.output, { contract }),
      fill(expandTemplate.rules, {
        parent, count: n, titleRules: titleRules(maxWords),
        children: depth > 1 ? fill(expandTemplate.children, { depth }) : ''
      }), fill(expandTemplate.example, { parent })
    ),
    prompt: fill(expandTemplate.task, {
      parent, count: n, text: JSON.stringify(ctx.nodeText),
      path: ctx.path.map((item) => JSON.stringify(item)).join(' > '),
      note: detail('Its note', ctx.note),
      existing: ctx.existingChildren.length ? JSON.stringify(ctx.existingChildren) : 'none',
      siblings: ctx.siblings.length ? detail('Siblings (context only)', JSON.stringify(ctx.siblings)) : '',
      focus: detail('Focus of the new nodes', opts.focus),
      style: detail('Style of the map', style.request),
      audience: detail('Audience / purpose', opts.audience)
    })
  };
}

export interface RephraseContext {
  /** Nodes to rewrite, in tree order, with their permanent ids and parents (parent null for the branch top). */
  nodes: { id: string; parent: string | null; text: string }[];
}

export interface RephraseOptions {
  maxWords?: number; // default 4
  /** Extra instruction from the user, e.g. "more formal". */
  instruction?: string;
}

/**
 * Rewrites the labels of a branch as terse keyword phrases. The model echoes id and parent of every node it
 * changes and gives the new "title"; apply the lines with `rephraseOps`.
 */
export function buildRephrasePrompt(ctx: RephraseContext, opts: RephraseOptions = {}): PromptPair {
  return {
    templateVersion: rephraseTemplate.version,
    instructions: parts(
      rephraseTemplate.role, rephraseTemplate.output, rephraseTemplate.style,
      fill(rephraseTemplate.rules, { maxWords: opts.maxWords ?? 4 }), rephraseTemplate.example
    ),
    prompt: fill(rephraseTemplate.task, {
      instruction: detail('Extra instruction', opts.instruction),
      nodes: ctx.nodes.map((node) => JSON.stringify({ id: node.id, parent: node.parent, title: node.text })).join('\n')
    })
  };
}
