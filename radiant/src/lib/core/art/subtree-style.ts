import type { ArtStyleOverrides, Doc, MapNode, NodeId, StyleSheet } from '../types';
import { effectiveRepresentation } from './representation';
import { applyArtStyleOverrides, artPreset, BUZAN_ART_PRESET, type ArtStyleSheet } from './styleSheet';

const STYLE_RECORD_VERSION = 1;

export interface SubtreeArtStyle extends Omit<ArtStyleSheet, 'referenceAsset' | 'cast'> {
  version: typeof STYLE_RECORD_VERSION;
  recordId: NodeId;
  inherits: NodeId | 'map-theme' | null;
  generatedStyleNode?: NodeId;
  referenceAsset: string | null;
  cast: ArtStyleSheet['cast'] | null;
  /** Identifies the editable preset/overrides from which this complete record was resolved. */
  source: string;
}

/** The generated map's canonical sheet remains the source for inheriting picture and SVG subtrees. */
export function generatedArtworkStyle(doc: Doc, root: NodeId): { nodeId: NodeId; sheet: StyleSheet } | undefined {
  return generatedSourceFrom(doc, doc.nodes[root]);
}

function generatedSourceFrom(doc: Doc, root: MapNode | undefined): { nodeId: NodeId; sheet: StyleSheet } | undefined {
  for (let node = root; node; node = node.parent === null ? undefined : doc.nodes[node.parent]) {
    if (node.artStyleId || node.artStyleIsland) return;
    if (node.generatedStyle) return { nodeId: node.id, sheet: node.generatedStyle };
  }
}

function sourceFor(doc: Doc, root: MapNode): string {
  const edits: ArtStyleOverrides[] = [];
  const generated = generatedSourceFrom(doc, root);
  let node: MapNode | undefined = root;
  while (node) {
    if (node.artStyleOverrides) edits.push(node.artStyleOverrides);
    if (node.artStyleId) return JSON.stringify([node.artStyleId, edits]);
    if (generated?.nodeId === node.id) {
      return JSON.stringify([generated.nodeId, generated.sheet, edits, doc.artStyleId]);
    }
    if (node.artStyleIsland) break;
    node = node.parent === null ? undefined : doc.nodes[node.parent];
  }
  return JSON.stringify([doc.artStyleId ?? 'ink-sketch', edits]);
}

function readSheet(record: SubtreeArtStyle): ArtStyleSheet {
  const { version, recordId, inherits, generatedStyleNode, source, referenceAsset, cast, ...style } = record;
  const canvas = style.canvas ?? (style.id === BUZAN_ART_PRESET ? artPreset(BUZAN_ART_PRESET).canvas : undefined);
  return { ...style, canvas, referenceAsset: referenceAsset ?? undefined, cast: cast ?? undefined };
}

/** Resolve local edits over the nearest stored sheet, falling back to legacy presets and overrides. */
export function artStyleAt(doc: Doc, id: NodeId): ArtStyleSheet {
  const edits: ArtStyleOverrides[] = [];
  const generated = generatedArtworkStyle(doc, id);
  let node: MapNode | undefined = doc.nodes[id];
  while (node) {
    const stored = node.artStyleSheet;
    if (stored && stored.source === sourceFor(doc, node)) {
      return edits.reverse().reduce(applyArtStyleOverrides, readSheet(stored));
    }
    if (node.artStyleOverrides) edits.push(node.artStyleOverrides);
    if (node.artStyleId) return edits.reverse().reduce(applyArtStyleOverrides, artPreset(node.artStyleId));
    if (generated?.nodeId === node.id) {
      const { artPresetId, ...inputs } = generated.sheet;
      const preset = artPreset(artPresetId ?? doc.artStyleId ?? 'ink-sketch');
      return edits.reverse().reduce(applyArtStyleOverrides, applyArtStyleOverrides(preset, inputs));
    }
    if (node.artStyleIsland) break;
    node = node.parent === null ? undefined : doc.nodes[node.parent];
  }
  return edits.reverse().reduce(applyArtStyleOverrides, artPreset(doc.artStyleId ?? 'ink-sketch'));
}

function styleParent(doc: Doc, node: MapNode): SubtreeArtStyle['inherits'] {
  if (node.artStyleId || node.artStyleIsland) return null;
  for (let ancestor = node.parent && doc.nodes[node.parent]; ancestor; ancestor = ancestor.parent && doc.nodes[ancestor.parent]) {
    if (ancestor.representation === 'picture' || ancestor.representation === 'svg') return ancestor.id;
    if (ancestor.artStyleId) return 'map-theme';
  }
  return 'map-theme';
}

export function subtreeArtStyle(doc: Doc, node: MapNode, sheet = artStyleAt(doc, node.id)): SubtreeArtStyle {
  return {
    ...sheet,
    version: STYLE_RECORD_VERSION,
    recordId: node.id,
    inherits: styleParent(doc, node),
    generatedStyleNode: generatedSourceFrom(doc, node)?.nodeId,
    referenceAsset: node.artReference?.assetHash ?? null,
    cast: sheet.cast ?? null,
    source: sourceFor(doc, node)
  };
}

/** Detach a root on a document copy while its ancestors are still available. */
export function detachArtworkRoot(doc: Doc, id: NodeId): void {
  const node = doc.nodes[id];
  node.representation ??= effectiveRepresentation(doc, id);
  const style = artStyleAt(doc, id);
  let carriesStyle = node.representation !== 'vector';
  let reference = node.artReference;
  for (let parent = node.parent; parent && !node.artStyleId && !node.artStyleIsland; ) {
    const ancestor = doc.nodes[parent];
    carriesStyle ||= !!(ancestor.artStyleId || ancestor.artStyleOverrides || ancestor.generatedStyle || ancestor.artStyleSheet);
    reference ??= ancestor.artReference;
    if (ancestor.artStyleId || ancestor.artStyleIsland) break;
    parent = ancestor.parent;
  }
  if (node.parent && carriesStyle && !node.artStyleId) {
    const preset = artPreset(style.id);
    node.artStyleId = style.id;
    node.artStyleOverrides = {
      medium: style.medium, mood: style.mood, detail: style.detail, lineWeight: style.line.weight,
      background: style.background, seed: style.seed,
      palette: style.palette.source === 'custom' ? style.palette.accents : undefined,
      negative: style.negative.filter(rule => !preset.negative.includes(rule))
    };
    if (reference) node.artReference = reference;
  }
  node.parent = null;
  if (ownsSheet(node)) node.artStyleSheet = subtreeArtStyle(doc, node, style);
}

function ownsSheet(node: MapNode): boolean {
  return node.representation === 'picture' || node.representation === 'svg' || !!node.artReference;
}

/** Materialize one standalone record per artwork subtree without changing the live document. */
export function withSubtreeArtStyles(doc: Doc): Doc {
  let nodes: Doc['nodes'] | undefined;
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    if (!ownsSheet(node) && !node.artStyleSheet) continue;
    nodes ??= { ...doc.nodes };
    nodes[node.id] = { ...node, artStyleSheet: ownsSheet(node) ? subtreeArtStyle(doc, node) : undefined };
  }
  return nodes ? { ...doc, nodes } : doc;
}

/** Reject malformed persisted sheets while leaving legacy presets/overrides usable. */
export function parseSubtreeArtStyle(value: unknown): SubtreeArtStyle | undefined {
  if (!value || typeof value !== 'object') return;
  const sheet = value as SubtreeArtStyle;
  if (sheet.version !== STYLE_RECORD_VERSION || typeof sheet.source !== 'string' ||
      ![sheet.id, sheet.name, sheet.medium, sheet.mood, sheet.detail, sheet.line?.weight, sheet.line?.colour].every(v => typeof v === 'string') ||
      !['branch-colour', 'custom'].includes(sheet.palette?.source) ||
      !Array.isArray(sheet.palette.accents) || !sheet.palette.accents.every(v => typeof v === 'string') ||
      (!Number.isSafeInteger(sheet.palette.maxColours) || sheet.palette.maxColours < 1) || !Number.isSafeInteger(sheet.seed) ||
      !Array.isArray(sheet.negative) || !sheet.negative.every(v => typeof v === 'string') ||
      !['transparent', 'plain'].includes(sheet.background)) return;
  const referenceAsset = typeof sheet.referenceAsset === 'string' && /^[a-f0-9]{64}$/.test(sheet.referenceAsset) ? sheet.referenceAsset : null;
  const cast = sheet.cast && typeof sheet.cast === 'object' && sheet.cast.symbols &&
    typeof sheet.cast.symbols === 'object' && !Array.isArray(sheet.cast.symbols) && Object.values(sheet.cast.symbols).every(v => typeof v === 'string') &&
    (sheet.cast.mascot === undefined || typeof sheet.cast.mascot === 'string') ? sheet.cast : null;
  return { ...sheet, referenceAsset, cast };
}
