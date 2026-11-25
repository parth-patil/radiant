import { packVertices } from '../render/mesh-vertices';
import { measureLabel, reserveLayoutCache } from '../render/text';
import { applyOps, newTrack } from '../core/model/ops';
import type { Doc, LayoutPlacements, NodeId } from '../core/types';
import {
  applyLayoutChunk, packLayoutResult, shipMesh, splitLayoutPayload, STREAM_LAYOUT_AT, type LayoutChunk, type LayoutHeader, type LayoutWire
} from './layout-transport';
import { Pipeline, type LayoutWork } from './pipeline';

export type LayoutResult = ReturnType<Pipeline['computeWork']>;
export type LayoutResultMessage =
  | { sequence: number; result: LayoutWire }
  | { sequence: number; header: LayoutHeader<LayoutWire> }
  | { sequence: number; part: LayoutChunk | null }
  /** The worker's copy of the document or of the placements could not be brought up to date: send them whole. */
  | { sequence: number; resync: true };
export type LayoutWorkerRequest =
  | { sequence: number; work: LayoutWork }
  | { sequence: number; header: LayoutHeader<LayoutWork> }
  | { sequence: number; part: LayoutChunk | null }
  | { sequence: number; pull: true };

const pipeline = new Pipeline(measureLabel);
const worker = self as unknown as {
  onmessage: ((event: MessageEvent<LayoutWorkerRequest>) => void) | null;
  postMessage: (message: LayoutResultMessage, transfer?: Transferable[]) => void;
};
let input: { sequence: number; header: LayoutHeader<LayoutWork> } | undefined;
let output: { sequence: number; next: () => LayoutChunk | null } | undefined;
/** The document as of the last request; edits arrive as ops (LayoutWork.edits). */
let replica: Doc | null = null;
/** Placements of the latest results, by request sequence, for requests that start from one of them. */
const placementsOf = new Map<number, LayoutPlacements | undefined>();

/** Nodes the edits of the current request touched; undefined after a whole document. */
let touched: Set<NodeId> | undefined;

/** Bring the worker's document up to date; false when it cannot be trusted and the main thread must send it whole. */
function sync(work: LayoutWork): Doc | null {
  touched = undefined;
  if (work.doc) return replica = work.doc;
  if (!replica || !work.edits) return null;
  const track = newTrack();
  try {
    applyOps(replica, work.edits.ops, track);
  } catch {
    return replica = null;
  }
  if (Object.keys(replica.nodes).length !== work.edits.nodes) replica = null;
  touched = track.touched;
  return replica;
}

function compute(sequence: number, work: LayoutWork, streamed = false): void {
  const doc = sync(work);
  const start = work.placements && 'result' in work.placements ? work.placements.result : null;
  if (!doc || (start !== null && !placementsOf.has(start))) {
    replica = null;
    worker.postMessage({ sequence, resync: true });
    return;
  }
  const placements = start !== null ? placementsOf.get(start) : work.placements as LayoutPlacements | undefined;
  // Size the text-layout cache to the map before measuring, so a big map's labels stay measured across passes.
  reserveLayoutCache(Object.keys(doc.nodes).length);
  const computed = pipeline.computeWork({ ...work, doc, placements }, touched);
  placementsOf.set(sequence, computed.placements);
  for (const old of placementsOf.keys()) if (placementsOf.size > 4) placementsOf.delete(old);
  const transfer: Transferable[] = [];
  const overlay = computed.baseScene?.overlayMesh;
  if (overlay?.indices.length) {
    overlay.gpuVertices = packVertices(overlay);
    transfer.push(overlay.gpuVertices.buffer, overlay.positions.buffer, overlay.colors.buffer, overlay.indices.buffer);
    if (overlay.branchSpans) transfer.push(overlay.branchSpans.bounds.buffer, overlay.branchSpans.ends.buffer);
  }
  // The worker keeps its CPU branch batch for the next edit; the main thread gets the mesh it draws and culls.
  const mesh = shipMesh(computed.mesh, transfer);
  const scene = computed.baseScene;
  const result = packLayoutResult({
    ...computed, mesh,
    baseScene: scene && (scene.branches === computed.mesh ? { ...scene, branches: mesh } : scene)
  }, transfer);
  transfer.push(...result.spatial.transferBuffers());
  if (streamed || result.nodeCount >= STREAM_LAYOUT_AT) {
    const { header, next } = splitLayoutPayload(result);
    output = { sequence, next };
    worker.postMessage({ sequence, header }, transfer);
  } else {
    worker.postMessage({ sequence, result }, transfer);
  }
}

worker.onmessage = ({ data }) => {
  const { sequence } = data;
  if ('pull' in data) {
    if (output?.sequence !== sequence) return;
    const part = output.next();
    if (!part) output = undefined;
    worker.postMessage({ sequence, part });
  } else if ('header' in data) {
    input = data;
    output = undefined;
  } else if ('part' in data) {
    if (input?.sequence !== sequence) return;
    if (data.part) applyLayoutChunk(input.header, data.part);
    else {
      const work = input.header.snapshot;
      input = undefined;
      compute(sequence, work, true);
    }
  } else {
    input = undefined;
    output = undefined;
    compute(sequence, data.work);
  }
};
