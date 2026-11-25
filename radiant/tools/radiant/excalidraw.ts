import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parseExcalidraw, remapAssets, stringifyExcalidraw } from '../../src/lib/core/io/excalidraw';
import { layoutReport } from '../../src/lib/core/io/map-spec';
import { resolveCanvasPoints } from '../../src/lib/core/geometry/canvas-scene';
import { createDoc, serializeDoc, type AgentOp } from '../../src/lib/core/model';
import type { CanvasElement, NodeBox } from '../../src/lib/core/types';
import { flagString } from './args';
import { invalid, usageError, type CommandResult } from './envelope';
import { openMap, type MapSource } from './sources';
import { decodeText, preparePicture } from './spec-io';
import { sha256 } from './store';
import { commitBatch } from './write';
import type { Ctx } from './read';

/** Picture bytes from a data URL. */
function dataUrlBytes(url: string): Uint8Array | null {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  return m[2] ? new Uint8Array(Buffer.from(m[3], 'base64')) : new TextEncoder().encode(decodeURIComponent(m[3]));
}

/** canvas-add input for an element: its fields, the picture by hash, bindings and frame left for a second pass. */
function addInput(el: CanvasElement, live: boolean): { add: Record<string, unknown>; later: Record<string, unknown> | null } {
  const add: Record<string, unknown> = {};
  const later: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(el)) {
    if (k === 'start' || k === 'end') later[k === 'start' ? 'from' : 'to'] = (v as { node?: string; element?: string }).node ?? (v as { element?: string }).element;
    else if (k === 'frame') later.frame = v;
    else if (k === 'asset') { if (!live) add.image = v; }
    else add[k] = v;
  }
  return { add, later: Object.keys(later).length ? later : null };
}

/**
 * import FILE.excalidraw [--into MAP]: canvas elements through the agent vocabulary (canvas-add, then canvas-set for
 * bindings and frames so forward references resolve), pictures embedded by content hash (AGT-EXT-06, CNV-50).
 */
export async function importExcalidraw(ctx: Ctx, file: string): Promise<CommandResult> {
  let parsed;
  try { parsed = parseExcalidraw(decodeText(new Uint8Array(readFileSync(file)), basename(file))); } catch (e) {
    throw invalid('invalid_import', 'Could not import ' + basename(file) + ': ' + (e instanceof Error ? e.message : String(e)));
  }
  const into = flagString(ctx.args, 'into');
  let src: MapSource;
  if (into) src = await openMap(into);
  else {
    if (!flagString(ctx.args, 'output')) throw usageError('import needs -o OUT.radiant.zip, or --into MAP.', { hint: 'radiant import ' + basename(file) + ' --into Map.radiant.zip --in-place' });
    const doc = createDoc(flagString(ctx.args, 'title') ?? basename(file).replace(/\.[^.]+$/, ''));
    src = { path: '-', kind: 'json', backend: 'file', doc, repairs: [], revision: sha256(serializeDoc(doc)), asset: () => null };
  }
  const live = src.backend === 'live';
  const notices = [...parsed.notices];
  const assets = new Map<string, { bytes: Uint8Array; mime: string }>();
  const fileIds = new Map<string, string>();
  for (const a of parsed.assets) {
    const bytes = dataUrlBytes(a.dataURL);
    if (!bytes) { notices.push('Picture ' + a.fileId + ' has no readable data and was skipped.'); continue; }
    try {
      const picture = preparePicture(a.fileId, bytes, a.fileId, a.mimeType);
      assets.set(picture.hash, { bytes: picture.bytes, mime: picture.mime });
      fileIds.set(a.fileId, picture.hash);
    } catch (e) {
      notices.push('Picture ' + a.fileId + ' ' + (e instanceof Error ? e.message : String(e)));
    }
  }
  if (live && parsed.assets.length) notices.push('Pictures cannot be sent to the open map yet; image elements were added without their pictures.');
  const elements = remapAssets(parsed.elements, fileIds);
  const existing = new Set((src.doc.canvas?.elements ?? []).map((e) => e.id));
  const ops: AgentOp[] = [];
  const later: AgentOp[] = [];
  let skipped = 0;
  for (const el of elements) {
    if (existing.has(el.id)) { skipped++; continue; }
    const { add, later: patch } = addInput(el, live);
    ops.push({ op: 'canvas-add', element: add });
    if (patch) later.push({ op: 'canvas-set', id: el.id, patch });
  }
  if (skipped) notices.push(skipped + ' element' + (skipped === 1 ? ' is' : 's are') + ' already on the canvas (same id) and were skipped.');
  if (!ops.length) throw invalid('empty_import', basename(file) + ' has no new canvas elements to import.');
  const batch = { label: 'Import ' + basename(file), ops: [...ops, ...later] };
  const result = await commitBatch(ctx, src, batch as never, assets, 'import.result');
  const data = { ...(result.data as Record<string, unknown>), format: 'excalidraw', elements: ops.length, assets: assets.size, notices };
  return { ...result, data, text: 'Imported ' + ops.length + ' canvas elements from ' + basename(file) + '. ' + (result.text ?? ''), notes: notices };
}

/** export --format excalidraw: the canvas elements, bound arrow ends where they are drawn, pictures as data URLs. */
export function excalidrawText(src: MapSource): { text: string; omissions: string[] } {
  const elements = src.doc.canvas?.elements ?? [];
  const omissions = ['the mind maps themselves (only canvas elements are written)'];
  if (!elements.length) omissions.push('nothing: the map has no canvas elements');
  const report = layoutReport(src.doc);
  const boxes = new Map<string, NodeBox>(report.boxes.map((b) => [b.id, { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, depth: b.depth, side: b.side, flow: 'h', mainBranch: b.mainBranch }]));
  const points = resolveCanvasPoints(elements, boxes);
  const missing = new Set<string>();
  const text = stringifyExcalidraw(elements, {
    points,
    now: Number.isNaN(Date.parse(src.doc.modified)) ? 1 : Date.parse(src.doc.modified),
    files: (hash) => {
      const asset = src.asset(hash);
      if (!asset) { missing.add(hash); return undefined; }
      return { mimeType: asset.mime, dataURL: 'data:' + asset.mime + ';base64,' + Buffer.from(asset.bytes).toString('base64') };
    }
  });
  if (missing.size) omissions.push('picture bytes not available: ' + missing.size);
  return { text, omissions };
}
