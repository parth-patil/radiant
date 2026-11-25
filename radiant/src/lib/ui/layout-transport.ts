import type { BranchSpec, LabelDraw, Mesh, NodeBox, NodeId, Rect, RectDraw, Scene } from '../core/types';
import type { LayoutResult } from './layout.worker';
import type { AdoptedWork } from './pipeline';
import { packVertices, reliefStride } from '../render/mesh-vertices';

// Structured-cloning an entire stress map can monopolize the UI thread. Keep
// small messages on the fast path and split large collections into bounded turns.
const CHUNK_SIZE = 1400;
export const STREAM_LAYOUT_AT = 12_000;

type Container = Map<unknown, unknown> | Set<unknown> | unknown[] | Record<string, unknown>;
export interface LayoutHeader<T> { snapshot: T; containers: Container[] }
export interface LayoutChunk { index: number; values: unknown[] }

export function splitLayoutPayload<T>(value: T) {
  const containers: Container[] = [];
  const parts: Iterator<unknown>[] = [];
  const copies = new WeakMap<object, object>();

  const split = (entity: unknown): unknown => {
    if (entity === null || typeof entity !== 'object' || ArrayBuffer.isView(entity) || entity instanceof ArrayBuffer) return entity;
    const known = copies.get(entity);
    if (known) return known;

    let target: Container;
    let values: Iterator<unknown>;
    let count: number;
    if (Array.isArray(entity)) {
      [target, count, values] = [[], entity.length, entity.values()];
    } else if (entity instanceof Map) {
      [target, count, values] = [new Map(), entity.size, entity.entries()];
    } else if (entity instanceof Set) {
      [target, count, values] = [new Set(), entity.size, entity.values()];
    } else {
      const record = entity as Record<string, unknown>;
      const keys = Object.keys(record);
      const empty: Record<string, unknown> = Object.create(null);
      target = empty;
      count = keys.length;
      values = (function* () { for (const key of keys) yield [key, record[key]]; })();
      if (count <= CHUNK_SIZE) {
        copies.set(entity, target);
        for (const key of keys) empty[key] = split(record[key]);
        return target;
      }
    }
    if (count <= CHUNK_SIZE) return entity;
    copies.set(entity, target);
    parts.push(values);
    containers.push(target);
    return target;
  };

  const header: LayoutHeader<T> = { snapshot: split(value) as T, containers };
  let index = 0;
  return {
    header,
    next(): LayoutChunk | null {
      while (index < parts.length) {
        const values: unknown[] = [];
        while (values.length < CHUNK_SIZE) {
          const item = parts[index].next();
          if (item.done) break;
          values.push(item.value);
        }
        if (values.length) return { index, values };
        index++;
      }
      return null;
    }
  };
}

export function applyLayoutChunk(header: LayoutHeader<unknown>, chunk: LayoutChunk): void {
  const target = header.containers[chunk.index];
  if (Array.isArray(target)) target.push(...chunk.values);
  else if (target instanceof Set) for (const value of chunk.values) target.add(value);
  else if (target instanceof Map) for (const [key, value] of chunk.values as [unknown, unknown][]) target.set(key, value);
  else for (const [key, value] of chunk.values as [string, unknown][]) {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }
}

/** Give the browser a scheduling point without background-tab timer clamping. */
export function layoutTaskTurn(): Promise<void> {
  return new Promise((resolve) => {
    const turn = new MessageChannel();
    turn.port1.onmessage = () => {
      turn.port1.close();
      turn.port2.close();
      resolve();
    };
    turn.port2.postMessage(null);
  });
}

/**
 * The branch mesh as the main thread needs it: the packed GPU buffer it uploads, the indices and branch spans it culls
 * and animates with. Both are transferred (the indices and spans as copies, since the worker's mesh cache reuses its
 * own batch on the next edit); the CPU arrays (f64 positions, colours, relief attributes) are not sent at all. The
 * positions are rebuilt from the packed buffer only if the main thread picks a branch (`meshPositions`).
 */
export function shipMesh(mesh: Mesh, transfer: Transferable[]): Mesh {
  if (mesh.instances) {
    // GPU-expanded branches: the records and spans (copies, like the indices below) are all the main thread needs.
    const records = mesh.instances.records.slice();
    const spans = mesh.branchSpans!;
    const branchSpans = { ids: spans.ids, bounds: spans.bounds.slice(), ends: spans.ends.slice() };
    transfer.push(records.buffer, branchSpans.bounds.buffer, branchSpans.ends.buffer);
    return { ...mesh, instances: { ...mesh.instances, records }, branchSpans };
  }
  if (!mesh.indices.length) return mesh;
  const gpuVertices = packVertices(mesh);
  const indices = mesh.indices.slice();
  transfer.push(gpuVertices.buffer, indices.buffer);
  const spans = mesh.branchSpans;
  const branchSpans = spans && { ids: spans.ids, bounds: spans.bounds.slice(), ends: spans.ends.slice() };
  if (branchSpans) transfer.push(branchSpans.bounds.buffer, branchSpans.ends.buffer);
  const relief = mesh.relief && {
    ...mesh.relief, rgba: new Uint32Array(0), attribs: new Int8Array(0),
    shadow: mesh.relief.shadow && new Int16Array(0), twist: mesh.relief.twist && new Float32Array(0)
  };
  return { positions: new Float64Array(0), colors: new Float32Array(0), indices, gpuVertices, relief, branchSpans };
}

/** World positions of a shipped mesh, read back from its packed buffer once (for picking) and kept on the mesh. */
export function meshPositions(mesh: Mesh): Mesh {
  const packed = mesh.gpuVertices;
  if (mesh.positions.length || !packed || !mesh.indices.length) return mesh;
  const words = (mesh.relief ? reliefStride(!!mesh.relief.twist, packed.wide) : packed.wide ? 20 : 12) >> 2;
  const f = new Float32Array(packed.buffer);
  const nv = f.length / words;
  const low = words - 2;
  const positions = new Float64Array(nv * 2);
  for (let i = 0, o = 0; i < nv; i++, o += words) {
    positions[2 * i] = packed.ox + f[o] + (packed.wide ? f[o + low] : 0);
    positions[2 * i + 1] = packed.oy + f[o + 1] + (packed.wide ? f[o + low + 1] : 0);
  }
  mesh.positions = positions;
  return mesh;
}

/** Node boxes as typed columns in layout order: one id list and numbers, rebuilt into the Map on arrival. */
export interface PackedBoxes {
  ids: NodeId[];
  /** x, y, w, h per box. */
  xywh: Float64Array;
  depth: Int32Array;
  mainBranch: Int32Array;
  side: Int8Array;
  /** Index into FLOWS. */
  flow: Uint8Array;
}

const FLOWS = ['h', 'v', 'r'] as const;

export function packBoxes(boxes: ReadonlyMap<NodeId, NodeBox>, transfer: Transferable[]): PackedBoxes {
  const n = boxes.size;
  const packed: PackedBoxes = {
    ids: new Array<NodeId>(n), xywh: new Float64Array(n * 4), depth: new Int32Array(n), mainBranch: new Int32Array(n),
    side: new Int8Array(n), flow: new Uint8Array(n)
  };
  let i = 0;
  for (const box of boxes.values()) {
    packed.ids[i] = box.id;
    packed.xywh[4 * i] = box.x;
    packed.xywh[4 * i + 1] = box.y;
    packed.xywh[4 * i + 2] = box.w;
    packed.xywh[4 * i + 3] = box.h;
    packed.depth[i] = box.depth;
    packed.mainBranch[i] = box.mainBranch;
    packed.side[i] = box.side;
    packed.flow[i] = box.flow === 'h' ? 0 : box.flow === 'v' ? 1 : 2;
    i++;
  }
  transfer.push(packed.xywh.buffer, packed.depth.buffer, packed.mainBranch.buffer, packed.side.buffer, packed.flow.buffer);
  return packed;
}

export function unpackBoxes(packed: PackedBoxes): Map<NodeId, NodeBox> {
  const { ids, xywh, depth, mainBranch, side, flow } = packed;
  const boxes = new Map<NodeId, NodeBox>();
  for (let i = 0; i < ids.length; i++) {
    // Same key order as core/layout's boxes.
    boxes.set(ids[i], {
      id: ids[i], x: xywh[4 * i], y: xywh[4 * i + 1], w: xywh[4 * i + 2], h: xywh[4 * i + 3],
      side: side[i] as NodeBox['side'], flow: FLOWS[flow[i]], depth: depth[i], mainBranch: mainBranch[i]
    });
  }
  return boxes;
}

/**
 * A list of plain records as JSON text: stringify and parse are several times cheaper than structured cloning the
 * objects, most of all in JavaScriptCore. JSON has no undefined (the key is dropped, which readers see the same way),
 * NaN or Infinity (they would come back as null): when a null appears in a value position beyond the \`nulls\` the
 * records hold by design, the value is sent as itself.
 */
export type Wire<T> = { json: string } | { value: T };

function count(text: string, part: string): number {
  let n = 0;
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) n++;
  return n;
}

export function toWire<T>(value: T, allowedNull?: string): Wire<T> {
  const json = JSON.stringify(value);
  if (json === undefined) return { value };
  const nulls = count(json, ':null') + count(json, '[null') + count(json, ',null');
  return nulls === (allowedNull ? count(json, allowedNull) : 0) ? { json } : { value };
}

export function fromWire<T>(wire: Wire<T>): T {
  return 'json' in wire ? JSON.parse(wire.json) as T : wire.value;
}

/** The layout result as it crosses from the worker: typed boxes, the big record lists as JSON, the rest cloned. */
export type LayoutWire = Omit<LayoutResult, 'layout' | 'placements' | 'layoutBranches' | 'drawnBranches' | 'baseScene'> & {
  bounds: Rect;
  boxes: PackedBoxes;
  placements: Wire<LayoutResult['placements']>;
  layoutBranches: Wire<BranchSpec[]>;
  /** 'layout' when the scene draws the layout's own branch list (the usual case). */
  drawnBranches: Wire<BranchSpec[]> | 'layout';
  baseScene: (Omit<Scene, 'labels' | 'rects'> & { labels: Wire<LabelDraw[]>; rects: Wire<RectDraw[]> }) | null;
};

export function packLayoutResult(result: LayoutResult, transfer: Transferable[]): LayoutWire {
  const { layout, placements, layoutBranches, drawnBranches, baseScene, ...rest } = result;
  return {
    ...rest,
    bounds: layout.bounds,
    boxes: packBoxes(layout.boxes, transfer),
    placements: toWire(placements, '"parent":null'),
    layoutBranches: toWire(layoutBranches),
    drawnBranches: drawnBranches === layoutBranches ? 'layout' : toWire(drawnBranches),
    baseScene: baseScene && { ...baseScene, labels: toWire(baseScene.labels), rects: toWire(baseScene.rects) }
  };
}

/** Parse JSON once, when first asked. */
function later<T>(wire: Wire<T>): T | (() => T) {
  if (!('json' in wire)) return wire.value;
  let value: T | undefined;
  return () => value ??= JSON.parse(wire.json) as T;
}

/** The result as the main thread adopts it; the branch specs stay JSON until something reads them. */
export function unpackLayoutResult(wire: LayoutWire): AdoptedWork {
  const { bounds, boxes, placements, layoutBranches, drawnBranches, baseScene, ...rest } = wire;
  const branches = later(layoutBranches);
  return {
    ...rest,
    layout: { boxes: unpackBoxes(boxes), bounds },
    placements: fromWire(placements),
    layoutBranches: branches,
    drawnBranches: drawnBranches === 'layout' ? branches : later(drawnBranches),
    baseScene: baseScene && { ...baseScene, labels: fromWire(baseScene.labels), rects: fromWire(baseScene.rects) }
  };
}
