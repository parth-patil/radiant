import type { CanvasElement, Doc, ImageDraw, Mesh, NodeBox, NodeId, Op, Scene, Theme } from '../core/types';
import { buildCanvasScene, canvasSvgFragments, type CanvasPicture, type CanvasScene, type CanvasSvgFragment } from '../core/geometry/canvas-scene';
import { ElementIndex } from '../core/geometry/spatial';
import type { ImageInfo } from './pipeline';

/**
 * The canvas-element layer of the scene (spec 7.2, CNV-22 to 27): builds the two element meshes, element text and
 * pictures from Doc.canvas, keeps the element spatial index for hit-testing, and lays a transient preview (an
 * element being drawn, moved, resized or erased) over the document without touching it. Owned by the Pipeline.
 */

/** A transaction that only changes canvas elements or canvas settings: the maps need no layout or new scene. */
export function canvasOnly(tx: { forward?: readonly Op[]; ops?: readonly Op[] }): boolean {
  const ops = tx.forward ?? tx.ops ?? [];
  return ops.length > 0 && ops.every((op) => op.t === 'canvas' || op.t === 'canvasMeta');
}

export interface CanvasPreview {
  /** Elements replaced while a gesture runs (null hides the element). */
  replace?: ReadonlyMap<string, CanvasElement | null>;
  /** Elements that do not exist yet (being drawn), on top of their band. */
  extra?: readonly CanvasElement[];
  /** Elements whose text is hidden (being edited in place). */
  hideText?: ReadonlySet<string>;
  /** Extra opacity per element (eraser marks). */
  fade?: ReadonlyMap<string, number>;
}

/** Presentation dimming of elements (CNV-60): the step's focused elements as drawn, the others at `context`. */
export interface CanvasDim {
  focus: ReadonlySet<string>;
  /** 1 = as drawn, 0 = not drawn (the talk hides context), between = mixed toward the background. */
  context: number;
}

export interface CanvasLayerInput {
  doc: Doc;
  theme: Theme;
  boxes: ReadonlyMap<NodeId, NodeBox>;
  imageInfo: ReadonlyMap<string, ImageInfo>;
  failedImages: ReadonlySet<string>;
  preview?: CanvasPreview | null;
  dim?: CanvasDim | null;
}

export class CanvasLayer {
  /** Scene of the last build; null when the document has no elements. */
  scene: CanvasScene | null = null;
  /** Spatial index over the document's elements (never the preview), for hit-testing and the marquee. */
  readonly index = new ElementIndex();
  /** Picture hashes that elements use and the pipeline has not resolved yet. */
  readonly missing = new Set<string>();
  /** While a gesture runs: the scene of everything it does not change, and of what it changes. */
  private rest: CanvasScene | null = null;
  private lifted: CanvasScene | null = null;
  /** Time of the last build, ms. */
  lastBuildMs = 0;
  private indexed: { elements: readonly CanvasElement[] | null; snapshot: CanvasElement[]; boxes: unknown } = { elements: null, snapshot: [], boxes: null };

  /** Elements of the document, in stacking order. */
  static elements(doc: Doc | undefined): readonly CanvasElement[] {
    return doc?.canvas?.elements ?? [];
  }

  get empty(): boolean {
    return !this.scene;
  }

  /** Build (or reuse) the canvas scene; returns null when nothing is drawn. */
  build(input: CanvasLayerInput): CanvasScene | null {
    const t0 = performance.now();
    const { doc, theme, preview } = input;
    const stored = CanvasLayer.elements(doc);
    const dim = input.dim && input.dim.context < 1 ? input.dim : null;
    // Elements a talk hides are left out of the drawing; hit-testing still follows the document.
    const drawn = dim && dim.context <= 0 ? stored.filter((el) => dim.focus.has(el.id)) : stored;
    this.missing.clear();
    this.lifted = null;
    if (!stored.length && !preview?.extra?.length) {
      this.scene = this.rest = null;
      if (this.index.size) this.index.build([]);
      this.indexed = { elements: null, snapshot: [], boxes: null };
      return null;
    }
    const hideText = preview?.hideText;
    const fade = preview?.fade;
    const shown = (el: CanvasElement): CanvasElement => hideText?.has(el.id) && el.text ? { ...el, text: undefined } : el;
    const picture = (el: CanvasElement): CanvasPicture | undefined => {
      const hash = el.asset;
      if (!hash || input.failedImages.has(hash)) return;
      const info = input.imageInfo.get(hash);
      if (!info) {
        this.missing.add(hash);
        return;
      }
      return { src: info.url, previewSrc: info.thumbnailUrl, previewSrcs: info.thumbnailUrls, thumbHash: info.thumbHash, vector: info.vector, alt: el.text };
    };
    const context = {
      boxes: input.boxes, theme, picture,
      opacity: fade?.size ? (el: CanvasElement) => fade.get(el.id) ?? 1 : undefined,
      dim: dim && dim.context > 0 ? (el: CanvasElement) => dim.focus.has(el.id) ? 1 : dim.context : undefined
    };
    const replace = preview?.replace;
    if (replace?.size || preview?.extra?.length) {
      // A gesture: the elements it changes (and lines bound to them) are drawn apart in a small mesh over the
      // scene, so the two bands of everything else are built once and kept while the pointer moves (CNV-23).
      const lifted = new Set(replace?.keys() ?? []);
      for (const el of stored) {
        if ((el.start?.element && lifted.has(el.start.element)) || (el.end?.element && lifted.has(el.end.element))) lifted.add(el.id);
      }
      const rest: CanvasElement[] = [], moving: CanvasElement[] = [];
      const lookup = new Map<string, CanvasElement>();
      for (const el of drawn) {
        const next = replace?.has(el.id) ? replace.get(el.id) : el;
        if (!next) continue;
        lookup.set(next.id, next);
        (lifted.has(el.id) ? moving : rest).push(shown(next));
      }
      for (const el of preview?.extra ?? []) {
        lookup.set(el.id, el);
        moving.push(shown(el));
      }
      this.rest = buildCanvasScene(rest, { ...context, lookup, previous: this.rest ?? this.scene ?? undefined });
      this.lifted = buildCanvasScene(moving, { ...context, lookup });
      this.scene = this.rest;
    } else {
      this.scene = buildCanvasScene(hideText?.size ? drawn.map(shown) : drawn, { ...context, previous: this.scene ?? undefined });
      this.rest = null;
    }
    if (!this.sameIndex(stored, input.boxes)) {
      // The index follows the document only; resolved points come from a build without a preview.
      const points = this.scene.items.length === stored.length && !this.lifted ? this.scene.points
        : buildCanvasScene(stored, { boxes: input.boxes, theme }).points;
      this.index.build(stored, points);
      this.indexed = { elements: stored, snapshot: stored.slice(), boxes: input.boxes };
    }
    this.lastBuildMs = performance.now() - t0;
    return this.scene;
  }

  /** The index is current when the same element objects are stored and (for bound arrows) node boxes are unchanged. */
  private sameIndex(stored: readonly CanvasElement[], boxes: unknown): boolean {
    const last = this.indexed;
    if (last.elements !== stored || last.snapshot.length !== stored.length) return false;
    for (let i = 0; i < stored.length; i++) if (last.snapshot[i] !== stored[i]) return false;
    if (last.boxes !== boxes && stored.some((el) => el.start?.node || el.end?.node)) return false;
    return true;
  }

  /**
   * Lay the canvas scene over a scene of the maps: bands as meshes, text and pictures appended in stacking order (the
   * renderer and the exporter draw them with their band by `underMaps`). Elements a gesture is changing are drawn
   * over everything until it ends, their text and pictures with the front band.
   */
  attach(scene: Scene): Scene {
    const canvas = this.scene;
    if (!canvas) return scene;
    const lifted = this.lifted;
    const over = <T extends { underMaps?: boolean }>(item: T): T => item.underMaps === false ? item : { ...item, underMaps: false };
    const labels = lifted ? [...canvas.labels, ...lifted.labels.map(over)] : canvas.labels;
    const images = lifted ? [...canvas.images, ...lifted.images.map(over)] : canvas.images;
    return {
      ...scene,
      canvasBack: canvas.back,
      canvasFront: canvas.front,
      labels: labels.length ? scene.labels.concat(labels) : scene.labels,
      images: images.length ? scene.images.concat(images as ImageDraw[]) : scene.images,
      ...(lifted ? { overlayMesh: joinMeshes([scene.overlayMesh, lifted.back, lifted.front]) } : {})
    };
  }

  /** SVG fragments in band order for export (CNV-26). */
  fragments(): CanvasSvgFragment[] {
    return this.scene ? canvasSvgFragments(this.scene) : [];
  }
}

/** One mesh from several, in order (small meshes only: the overlay of a gesture). */
function joinMeshes(meshes: ReadonlyArray<Mesh | undefined>): Mesh {
  let vertices = 0, indices = 0;
  for (const m of meshes) if (m) { vertices += m.positions.length / 2; indices += m.indices.length; }
  const out: Mesh = { positions: new Float64Array(vertices * 2), colors: new Float32Array(vertices * 4), indices: new Uint32Array(indices) };
  let v = 0, i = 0;
  for (const m of meshes) {
    if (!m) continue;
    out.positions.set(m.positions, v * 2);
    out.colors.set(m.colors, v * 4);
    for (let k = 0; k < m.indices.length; k++) out.indices[i + k] = m.indices[k] + v;
    v += m.positions.length / 2;
    i += m.indices.length;
  }
  return out;
}
