import { decodeImageAspect } from '../host/image-preview';
import { detachArtworkRoot, withSubtreeArtStyles } from '../core/art/subtree-style';
import { removeLoneAliasGroups } from '../core/model/aliases';
import { toFlashcards } from '../core/io/flashcards';
import { canvasCardText } from '../core/io/canvas';
import { layoutDoc } from '../core/layout';
import { referencedAiJobs } from '../core/model/ai-provenance';
import { toFreeMind, toJsonCanvas, toMarkdownOutline, toOpml, writePortableMap, writePortableFiles } from '../core/io';
import { cloneDoc, outlineFromSubtree, rootOf, subtreeIds } from '../core/model';
import { premulCss } from '../core/geometry';
import type { Doc, NodeId, Rect, Size, Theme } from '../core/types';
import { measureLabel } from '../render/text';
import type { Host } from '../host/types';
import { Pipeline, type ImageInfo } from './pipeline';
import type { PrintSettings } from './print-layout';
import { renderExport, type VisualFormat } from './export-visual';

export const exportFormats = {
  png: { label: 'PNG image', ext: 'png', mime: 'image/png', limits: 'PNG flattens the visible map, picture, SVG artwork and ink into pixels. Searchable labels, editable structure, notes, node links, tags and task data are omitted.' },
  svg: { label: 'SVG image', ext: 'svg', mime: 'image/svg+xml', limits: 'SVG keeps selectable labels, vector branches, ink and embedded artwork. Notes, node links, tags, task data and editable map structure are omitted.' },
  pdf: { label: 'PDF document', ext: 'pdf', mime: 'application/pdf', limits: 'PDF keeps vector shapes and searchable text where its fonts support the characters. Some labels and artwork are rasterised. Notes, node links, tags, tasks and editable map data are omitted.' },
  flashcards: { label: 'Anki flashcards', ext: 'flashcards.txt', mime: 'text/plain;charset=utf-8', limits: 'Each exported node becomes an Anki question and answer using its study answer, note or branch relationship. Editable hierarchy, visual styles, pictures, links and task state are omitted.' },
  markdown: { label: 'Markdown outline', ext: 'md', mime: 'text/markdown', limits: 'Markdown carries hierarchy, labels and note paragraphs. Styles, positions, pictures and SVG artwork, sketches, node links, cross-connections, folds, tags and tasks are omitted.' },
  opml: { label: 'OPML outline', ext: 'opml', mime: 'text/x-opml', limits: 'OPML carries hierarchy, labels, notes and original outline attributes. Radiant styles, positions, folds, pictures and SVG artwork, sketches, node links, cross-connections, tags and tasks are omitted.' },
  freemind: { label: 'FreeMind map', ext: 'mm', mime: 'application/x-freemind', limits: 'FreeMind carries hierarchy, labels, notes, folds, node links and original icons. Multiple roots receive a shared parent. Styles, positions, pictures and SVG artwork, sketches, cross-connections, tags and tasks are omitted.' },
  bundle: { label: 'Radiant portable bundle', ext: 'zip', mime: 'application/zip', limits: 'The portable map includes editable map data and referenced artwork in an assets folder. Local Undo, snapshot and review history, and app preferences are omitted.' },
  json: { label: 'Radiant JSON', ext: 'json', mime: 'application/json', limits: 'Radiant JSON keeps editable map data and artwork references. Artwork bytes remain in the original asset store. Local Undo, snapshot and review history, and app preferences are omitted.' },
  canvas: { label: 'JSON Canvas', ext: 'canvas', mime: 'application/json', limits: 'JSON Canvas carries the hierarchy, basic colours and connections. Text cards contain labels, notes and links, and their positions are recalculated to fit the text. Folds, branch shapes, connection bends and dashes, pictures and SVG artwork, sketches, tags and tasks are omitted.' }
} satisfies Record<string, { label: string; ext: string; mime: string; limits: string }>;

export type ExportFormat = keyof typeof exportFormats;
export type ExportScope = 'map' | 'viewport' | 'selection';

export function isVisual(format: ExportFormat): format is VisualFormat {
  return format === 'png' || format === 'svg' || format === 'pdf';
}

interface ExportOptions {
  format: ExportFormat;
  scope: ExportScope;
  scale: number;
  transparent: boolean;
  tiles: boolean;
  print?: PrintSettings;
  printPreview?: boolean;
  collapsed: boolean;
  crossLinks: boolean;
  answers?: boolean;
}

interface ExportSource {
  doc: Doc;
  theme: Theme;
  selection: NodeId[];
  viewport: Rect;
  zoom: number;
  linkColor?: string;
  images: ReadonlyMap<string, ImageInfo>;
  failedImages: ReadonlySet<string>;
  onImageFailure?: (hash: string) => void;
  assetUrl: (hash: string) => ReturnType<Host['assetUrl']>;
}

/** Keep selection ancestors ahead of their descendants, and all included ids in document order. */
function exportRoots(doc: Doc, selection: NodeId[]): NodeId[] {
  const selected = new Set(selection);
  const roots: NodeId[] = [];
  const stack = [...doc.roots].reverse();
  while (stack.length) {
    const id = stack.pop()!;
    const node = doc.nodes[id];
    if (!node) continue;
    if (selected.has(id)) roots.push(id);
    else for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return roots;
}

async function resolveImages(pipeline: Pipeline, source: ExportSource): Promise<void> {
  const failed = new Set(pipeline.failedImages);
  await Promise.all([...pipeline.missingImages].map(async (hash) => {
    try {
      const url = await source.assetUrl(hash);
      pipeline.imageInfo.set(hash, { url, aspect: await decodeImageAspect(url) });
    } catch {
      failed.add(hash);
      source.onImageFailure?.(hash);
    }
  }));
  pipeline.failedImages = failed;
}

export function exportFilename(title: string, format: ExportFormat): string {
  const stem = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
  return `${stem || 'Untitled'}.${format === 'bundle' ? 'radiant.zip' : exportFormats[format].ext}`;
}

function trimEditableDocument(source: ExportSource, doc: Doc, roots: NodeId[], selected: Set<NodeId> | null) {
  const theme = source.theme;
  if (selected) {
    const pipeline = new Pipeline(measureLabel);
    pipeline.failedImages = source.failedImages;
    for (const [hash, info] of source.images) pipeline.imageInfo.set(hash, info);
    pipeline.relayout(doc, theme);
    const included = selected;
    const rootInfo: Doc['rootInfo'] = {};
    for (const id of roots) {
      const originalInfo = doc.rootInfo[rootOf(doc, id)];
      const box = pipeline.box(id);
      const node = doc.nodes[id];
      rootInfo[id] = doc.rootInfo[id] ?? {
        layout: originalInfo.layout,
        position: box
          ? { x: box.x - (node.offset?.x ?? 0), y: box.y - (node.offset?.y ?? 0) }
          : originalInfo.position
      };
      detachArtworkRoot(doc, id);
    }
    doc.roots = roots;
    doc.rootInfo = rootInfo;
    doc.nodes = Object.fromEntries(Object.entries(doc.nodes).filter(([id]) => included.has(id)));
    removeLoneAliasGroups(doc.nodes);
    doc.links = doc.links.filter(({ from, to }) => included.has(from) && included.has(to));
    doc.aiJobs = referencedAiJobs(doc.nodes, doc.aiJobs);
  }
}

function assetReader(source: ExportSource) {
  return async (hash: string) => {
    const response = await fetch(await source.assetUrl(hash));
    if (!response.ok) throw new Error(`Could not read asset ${hash.slice(0, 12)}.`);
    const mime = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    return { bytes: new Uint8Array(await response.arrayBuffer()), mime };
  };
}

export async function exportMapFolder(source: ExportSource, scope: ExportScope) {
  const doc = cloneDoc(source.doc);
  const roots = scope === 'selection' ? exportRoots(doc, source.selection) : doc.roots;
  if (!roots.length) throw new Error('There is nothing to export.');
  const selected = scope === 'selection' ? new Set(roots.flatMap((id) => subtreeIds(doc, id))) : null;
  trimEditableDocument(source, doc, roots, selected);
  return writePortableFiles(doc, assetReader(source));
}

function exportCanvas(doc: Doc, theme: Theme, selection: Set<NodeId> | null): string {
  // JSON Canvas readers give Markdown cards their own text size and padding.
  // Lay out the expanded map using the whole card instead of the map's label bounds.
  const font = { family: 'Arial, sans-serif', size: 16, bold: false, italic: false };
  const sizes = new Map<NodeId, Size>();
  for (const node of Object.values(doc.nodes)) {
    node.collapsed = false;
    const text = measureLabel(canvasCardText(node), font, 360);
    sizes.set(node.id, { w: Math.max(110, Math.ceil(text.w + 48)), h: Math.max(54, Math.ceil(text.h * 1.5 + 36)) });
  }
  const layout = layoutDoc(doc, sizes, { levelGap: theme.levelGap, siblingGap: theme.siblingGap });
  if (selection) {
    for (const id of layout.boxes.keys()) if (!selection.has(id)) layout.boxes.delete(id);
  }
  return toJsonCanvas(doc, layout, theme);
}

export async function exportMap(source: ExportSource, options: ExportOptions): Promise<Uint8Array<ArrayBuffer>> {
  const { theme, selection, viewport, zoom } = source;
  // Document edits and AI events can continue while image assets load.
  const doc = cloneDoc(source.doc);
  const { format, scope, collapsed, crossLinks } = options;
  const roots = scope === 'selection' ? exportRoots(doc, selection) : doc.roots;
  if (!roots.length) throw new Error('There is nothing to export.');
  const selected = scope === 'selection' ? new Set(roots.flatMap((id) => subtreeIds(doc, id))) : null;
  const encode = (value: string) => new TextEncoder().encode(value);
  // A selection exports its branches only; the map and the view include the canvas elements (CNV-26).
  if (selected && isVisual(format)) delete doc.canvas;

  if (format === 'flashcards') return encode(toFlashcards(doc, selected ?? undefined));
  if (format === 'freemind') return encode(toFreeMind(doc.title, roots.map((id) => outlineFromSubtree(doc, id))));
  if (format === 'markdown' || format === 'opml') {
    const outline = roots.map((id) => outlineFromSubtree(doc, id));
    return encode(format === 'markdown' ? toMarkdownOutline(outline) : toOpml(doc.title, outline));
  }

  if (format === 'json' || format === 'bundle') {
    trimEditableDocument(source, doc, roots, selected);
    return format === 'json' ? encode(JSON.stringify(withSubtreeArtStyles(doc), null, 2) + '\n') : writePortableMap(doc, assetReader(source));
  }

  if (format === 'canvas') return encode(exportCanvas(doc, theme, selected));

  if (options.answers && isVisual(format)) {
    for (const node of Object.values(doc.nodes)) {
      if (node.blankAnswer !== undefined) node.text = node.blankAnswer;
    }
  }

  if (collapsed) {
    for (const node of Object.values(doc.nodes)) node.collapsed = false;
  }

  const pipeline = new Pipeline(measureLabel);
  pipeline.canvasGrid = false;
  pipeline.failedImages = source.failedImages;
  for (const [hash, info] of source.images) pipeline.imageInfo.set(hash, info);
  pipeline.relayout(doc, theme);
  for (const el of doc.canvas?.elements ?? []) {
    if (el.asset && !pipeline.imageInfo.has(el.asset) && !pipeline.failedImages.has(el.asset)) pipeline.missingImages.add(el.asset);
  }
  if (pipeline.missingImages.size && isVisual(format)) {
    await resolveImages(pipeline, source);
    pipeline.relayout(doc, theme);
  }
  if (selected) {
    pipeline.layout = {
      ...pipeline.layout,
      boxes: new Map([...pipeline.layout.boxes].filter(([id]) => selected.has(id)))
    };
  }
  if (!pipeline.layout.boxes.size) throw new Error('Expand the selected branch to export it.');

  const scene = pipeline.fullScene({ selection: new Set(), focus: null, hover: null, editing: null });
  return renderExport(format, {
    scene,
    branches: pipeline.branchSpecs(),
    boxes: pipeline.layout.boxes,
    links: crossLinks ? doc.links.map((link) => ({ ...link, color: link.color ?? theme.connectionColor, dash: link.dash ?? theme.connectionDash })) : [],
    linkColor: source.linkColor ? premulCss(source.linkColor) : premulCss(theme.textColor, 0.6),
    viewport: scope === 'viewport' ? viewport : undefined,
    scale: options.scale * (scope === 'viewport' ? zoom : 1),
    transparent: options.transparent,
    tiles: options.tiles,
    print: options.print,
    printPreview: options.printPreview,
    canvas: pipeline.canvas.fragments()
  });
}
