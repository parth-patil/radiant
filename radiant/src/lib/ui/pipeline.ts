import { BranchMeshCache } from '../core/geometry/tessellate';
import { reliefOptions, type ReliefOptions } from '../core/geometry/relief';
import { pickBranch } from '../core/geometry/branch-index';
import { inkFrame, inkMesh, type InkDraw } from '../core/geometry/ink';
import { themeScopes, type ThemeScope } from '../core/model/generated-style';
/**
 * Render pipeline: Doc -> sizes -> layout -> branch mesh -> spatial index -> Scene.
 * Pure TypeScript (no Svelte, no DOM besides what `measure` needs), owned by the UI.
 */
import { DIM_OPACITY } from './canvas-filter';
import type { BranchSpec, Doc, ImageDraw, Op, LabelDraw, LayoutPlacements, LayoutResult, Mesh, NodeArt, NodeBox, NodeId, PictureLabelPlacement, Rect, RectDraw, Representation, Scene, Size, Theme, Vec2 } from '../core/types';
import { LayoutCache, settleLayout, subtreeBounds, type SettleReuse } from '../core/layout';
import { dimOpaque, foldAnchor } from '../core/geometry/scene';
import { resolveNodeStyle } from '../core/geometry/style';
import { CanvasLayer, type CanvasDim, type CanvasPreview } from './canvas-layer';
import { meshPositions } from './layout-transport';
import { screenOutline } from '../render/screen-outline';
import {
  SpatialIndex,
  appendNodeOverlay,
  buildBranchSpecs,
  BranchSpecMemo,
  buildScene,
  SceneMemo,
  canCurveText,
  canCurveUnderline,
  createStyleResolver,
  displayText,
  nodePadding,
  premulCss,
  nodeSize,
  BOX_RADIUS,
  type MeasureFn
} from '../core/geometry';

/** Gap between a presentation focus node and its outline (PRS-11), screen px. */
const CUE_GAP_PX = 4;
/** Height of a picture inside a picture node, world units. */
export const IMAGE_H = 100;
const IMAGE_GAP = 8;
const DEFAULT_ART_ASPECT = 1.28;
const DEFAULT_PICTURE_ASPECT = 1.5;

export interface ImageInfo {
  url: string;
  thumbnailUrl?: string;
  thumbnailUrls?: ImageDraw['previewSrcs'];
  thumbHash?: string;
  vector?: boolean;
  /** width / height of the picture. */
  aspect: number;
}

const EMPTY_MESH: Mesh = {
  positions: new Float32Array(0),
  colors: new Float32Array(0),
  indices: new Uint32Array(0)
};

/**
 * A presentation step as the pipeline draws it (PRS-04, 05, 11): the settled layout restricted to `visible`, each
 * node at its opacity, and a cue around the focus nodes. A new object means a new scope; reuse it while unchanged.
 */
export interface PresentScope {
  visible: ReadonlySet<NodeId>;
  opacity: ReadonlyMap<NodeId, number>;
  focus: readonly NodeId[];
  /** Canvas elements (CNV-60): the step's focused elements as drawn, the others dimmed or hidden. Absent: as drawn. */
  elements?: CanvasDim;
}

export interface SceneState {
  selection: Set<NodeId>;
  focus: NodeId | null;
  editing: NodeId | null;
  hover: NodeId | null;
  branch?: NodeId | null;
  /** Presenting: draw only this step's visible set (takes precedence over `branch` and `matches`). */
  present?: PresentScope | null;
  revealArtworkLabels?: boolean;
  matches?: ReadonlySet<NodeId> | null;
  highlightedWord?: string;
}

export const clampImageScale = (scale: number): number => Number.isFinite(scale) ? Math.min(6, Math.max(0.25, scale)) : 1;

function positiveAspect(aspect: number | undefined): number | undefined {
  return aspect !== undefined && Number.isFinite(aspect) && aspect > 0 ? aspect : undefined;
}

function declaredArtAspect(art?: NodeArt): number | undefined {
  const size = art?.pixelSize;
  if (size && size.width > 0 && size.height > 0) return positiveAspect(size.width / size.height);
}

type PictureFrame = Size & { aspect: number };

function imageSize(aspect: number, scale: number): PictureFrame {
  const h = Math.min(IMAGE_H, 220 / aspect) * clampImageScale(scale);
  return { w: h * aspect, h, aspect };
}

export interface LayoutWork {
  /** The whole document, sent when the worker has no current copy of it. */
  doc?: Doc;
  /** Otherwise the edits since the previous request, replayed on the worker's copy; `nodes` checks the result. */
  edits?: { ops: Op[]; nodes: number };
  theme: Theme;
  anchor: NodeId | null;
  /** Placements to start from, or the sequence of the worker result whose placements the main thread still holds. */
  placements?: LayoutPlacements | { result: number };
  imageInfo: Map<string, ImageInfo>;
  failedImages: ReadonlySet<string>;
  artPending: Map<NodeId, 'Queued' | 'Generating'>;
  showGeneratedArtwork: boolean;
  prepareScene: boolean;
  editing: NodeId | null;
}

/** A list that is either here or decoded on first use (a memoised function). */
export type BranchList = BranchSpec[] | (() => BranchSpec[]);
/** A worker result as the main thread adopts it: the branch lists may still be undecoded. */
export type AdoptedWork = Omit<ReturnType<Pipeline['computeWork']>, 'layoutBranches' | 'drawnBranches'> & {
  layoutBranches: BranchList;
  drawnBranches: BranchList;
};

export class Pipeline {
  doc!: Doc;
  theme!: Theme;
  layout: LayoutResult = { boxes: new Map(), bounds: { x: -50, y: -20, w: 100, h: 40 } };
  readonly spatial = new SpatialIndex();
  readonly cache = new LayoutCache();
  placements?: LayoutPlacements;
  mesh: Mesh = EMPTY_MESH;
  /** Resolved picture info by asset hash (filled by the controller). */
  readonly imageInfo = new Map<string, ImageInfo>();
  failedImages: ReadonlySet<string> = new Set();
  readonly artPending = new Map<NodeId, 'Queued' | 'Generating'>();
  /** Hashes the controller still has to resolve. */
  missingImages = new Set<string>();
  readonly missingImagePreviews = new Set<string>();
  showGeneratedArtwork = true;
  /** Time of the last layout pass, ms (for the stats line). */
  lastLayoutMs = 0;
  nodeCount = 0;
  lastGeometryMs = 0;
  lastBranchMeshMs = 0;
  lastBranchesRebuilt = 0;
  lastLayoutSource: 'main' | 'worker' = 'main';

  private readonly branchMeshes = new BranchMeshCache();
  private scopeMeshes?: BranchMeshCache;
  private filteredMeshes?: BranchMeshCache;
  /** Canvas elements (spec 7): meshes, text, pictures and their hit-test index. */
  readonly canvas = new CanvasLayer();
  /** A gesture in progress on canvas elements, drawn without changing the document. */
  canvasPreview: CanvasPreview | null = null;
  /** Draw the canvas grid (CNV-07) when the document turns it on; exports leave it out. */
  canvasGrid = true;
  /** The worker computes maps only; the main thread adds the canvas layer. */
  private canvasDeferred = false;
  /** The scene of the maps before the canvas layer was laid over it. */
  private mapScene: Scene | null = null;
  private sizes = new Map<NodeId, Size>();
  private sizeKey = new Map<NodeId, string>();
  /** What a node's size key was built from besides the node itself, while it can be trusted (see computeSizes). */
  private sizeContext = new Map<NodeId, { depth: number; local: Theme; number?: number; frameW?: number; frameH?: number }>();
  private sizeTheme?: Theme;
  private sizeInputs = '';
  /** Nodes whose size changed in the last pass. */
  private readonly resized = new Set<NodeId>();
  /** Branch specs of the last pass and what they were built from (see dirtyNodes). */
  private readonly specMemo = new BranchSpecMemo();
  /** Node rects and labels of the last worker scene, and the relayout pass it was built in. */
  private readonly sceneMemo = new SceneMemo();
  private sceneMemoPass = -1;
  /** Relayout passes so far, and the nodes the last one could not take over from the one before (see dirtyNodes). */
  private pass = 0;
  private dirty: Set<NodeId> | null = null;
  /** Whether some visible node has a failed generation or a sketch, as of this pipeline's own last computeSizes. */
  private sceneFeatures: { artErrors: boolean; sketches: boolean } | null = null;
  private specInputs?: { theme: Theme; seed: number; sizes: string };
  /** Some visible node has a theme of its own (generated style or art preset), or a curved-label style. */
  private localThemes = false;
  private curvedStyles = false;
  /** The output of the last settleLayout, which the next pass can take over in part (see settleReuse). */
  private settled?: { placements: LayoutPlacements; boxes: ReadonlyMap<NodeId, NodeBox> };
  /** The theme of the last worker pass and its JSON: an equal theme keeps that object, so it can be compared by identity. */
  private workTheme?: { theme: Theme; json: string };
  private baseScene: Scene | null = null;
  private foldedBadges = new Map<NodeId, Rect>();
  private scope: {
    root: NodeId | null; present?: PresentScope; full: LayoutResult; layout: LayoutResult; mesh: Mesh; specs: BranchSpec[];
    spatial: SpatialIndex; cues?: RectDraw[];
  } | null = null;

  get canvasLayout(): LayoutResult {
    return this.scope?.layout ?? this.layout;
  }

  get canvasSpatial(): SpatialIndex {
    return this.scope?.spatial ?? this.spatial;
  }

  /** Branch material of the current theme for mesh building; undefined draws flat branches. */
  meshOptions(): ReliefOptions | undefined {
    return reliefOptions(this.theme);
  }

  hitBranch(point: Vec2): NodeId | null {
    return pickBranch(meshPositions(this.baseScene?.branches ?? this.scope?.mesh ?? this.mesh), point);
  }

  /** Where a fold control attaches to a node: a point on its outward edge and the outward direction. */
  foldAnchor(id: NodeId): ReturnType<typeof foldAnchor> | null {
    const box = this.canvasLayout.boxes.get(id);
    if (!box || !this.doc?.nodes[id]) return null;
    return foldAnchor(box, resolveNodeStyle(this.doc, id, box.depth, this.theme).shape, this.theme);
  }

  /** Pick the same bounds used to render the count, including long counts. */
  hitFoldBadge(point: Vec2): NodeId | null {
    const pad = 5;
    let closest: NodeId | null = null;
    let distance = Infinity;
    const reach = 72;
    const nearby = this.canvasSpatial.query({ x: point.x - reach, y: point.y - reach, w: reach * 2, h: reach * 2 });
    for (const id of nearby) {
      const r = this.foldedBadges.get(id);
      if (!r || point.x < r.x - pad || point.x > r.x + r.w + pad || point.y < r.y - pad || point.y > r.y + r.h + pad) continue;
      const d = Math.hypot(point.x - r.x - r.w / 2, point.y - r.y - r.h / 2);
      if (d >= distance) continue;
      closest = id;
      distance = d;
    }
    return closest;
  }

  private indexFoldedBadges(scene: Scene | null): void {
    this.foldedBadges.clear();
    for (const rect of scene?.rects ?? []) {
      if (rect.foldBadge && rect.nodeId) this.foldedBadges.set(rect.nodeId, rect);
    }
  }

  private scopeScene(root: NodeId | null, present?: PresentScope | null): void {
    if (present) {
      this.scopeVisible(present);
      return;
    }
    if (!root) {
      this.scope = null;
      this.scopeMeshes = undefined;
      return;
    }
    if (this.scope?.root === root && this.scope.full === this.layout) return;

    const boxes = new Map<NodeId, NodeBox>();
    const pending = [root];
    while (pending.length) {
      const id = pending.pop()!;
      const box = this.layout.boxes.get(id);
      if (!box) continue;
      boxes.set(id, box);
      const children = this.doc.nodes[id].children;
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
    const layout = { boxes, bounds: subtreeBounds(this.layout, this.doc, root) };
    const spatial = new SpatialIndex();
    spatial.build(boxes.values());
    const specs = this.branchSpecs(layout);
    const mesh = (this.scopeMeshes ??= new BranchMeshCache()).build(specs, this.meshOptions());
    this.scope = { root, full: this.layout, layout, mesh, specs, spatial };
  }

  /**
   * Presentation scope (PRS-04): the settled layout restricted to a visible set. Boxes and branch geometry come
   * from the full layout unchanged, so revealing nodes never moves another node and no layout runs. Branches are
   * faded with the node they lead to (PRS-05) and focus nodes get an outline in their branch colour (PRS-11).
   */
  private scopeVisible(present: PresentScope): void {
    if (this.scope?.present === present && this.scope.full === this.layout) return;
    const boxes = new Map<NodeId, NodeBox>();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, box] of this.layout.boxes) {
      if (!present.visible.has(id)) continue;
      boxes.set(id, box);
      x0 = Math.min(x0, box.x - box.w / 2);
      y0 = Math.min(y0, box.y - box.h / 2);
      x1 = Math.max(x1, box.x + box.w / 2);
      y1 = Math.max(y1, box.y + box.h / 2);
    }
    const layout = { boxes, bounds: boxes.size ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : this.layout.bounds };
    const spatial = new SpatialIndex();
    spatial.build(boxes.values());
    const specs: BranchSpec[] = [];
    for (const spec of this.layoutBranches) {
      if (!boxes.has(spec.to) || !boxes.has(spec.from)) continue;
      const alpha = present.opacity.get(spec.to) ?? 1;
      specs.push(alpha === 1 ? spec : this.dimBranch(spec, alpha));
    }
    const mesh = (this.scopeMeshes ??= new BranchMeshCache()).build(specs, this.meshOptions());
    const cues: RectDraw[] = [];
    if (!this.theme.lean) {
      const styles = createStyleResolver(this.doc, this.theme);
      for (const id of present.focus) {
        const box = boxes.get(id);
        if (!box) continue;
        // The node's own outline, drawn 2 screen px wide and 4 screen px outside it at any zoom (render/screen-outline).
        cues.push(screenOutline({
          nodeId: id, x: box.x - box.w / 2, y: box.y - box.h / 2, w: box.w, h: box.h,
          radius: BOX_RADIUS, fill: { r: 0, g: 0, b: 0, a: 0 },
          stroke: premulCss(styles.get(id, box.depth, box.mainBranch).color), strokeWidth: 2
        }, 2, CUE_GAP_PX));
      }
    }
    this.scope = { root: null, present, full: this.layout, layout, mesh, specs, spatial, cues };
  }
  /** A dimmed branch mixes toward the background and stays opaque, so its overlapping parts do not blend twice. */
  private dimBranch(spec: BranchSpec, alpha: number): BranchSpec {
    // A dimensional branch's shadow fades with it (the mixed colour stays opaque).
    return { ...spec, color: dimOpaque(spec.color, alpha, premulCss(this.theme.background)), dim: (spec.dim ?? 1) * alpha };
  }
  /** Branch specs of the layout and of the scene; an adopted worker result keeps them as JSON until they are read. */
  private layoutSource: BranchList = [];
  private drawnSource: BranchList = [];
  private get layoutBranches(): BranchSpec[] {
    if (typeof this.layoutSource === 'function') this.layoutSource = this.layoutSource();
    return this.layoutSource;
  }
  private set layoutBranches(specs: BranchSpec[]) {
    this.layoutSource = specs;
  }
  get drawnBranches(): BranchSpec[] {
    if (typeof this.drawnSource === 'function') this.drawnSource = this.drawnSource();
    return this.drawnSource;
  }
  set drawnBranches(specs: BranchSpec[]) {
    this.drawnSource = specs;
  }
  /** The drawn branches to read later (a layout animation reads them only when it moves branches). */
  drawnBranchesLater(): () => BranchSpec[] {
    const source = this.drawnSource;
    return typeof source === 'function' ? source : () => source;
  }
  private imageNodes = new Map<NodeId, string>();
  private visibleArt = new Map<NodeId, NodeArt>();
  private artworkUnavailable = new Set<NodeId>();
  private pictureFrames = new Map<NodeId, PictureFrame>();
  private pictureBoxes = new Map<NodeId, Rect>();
  private labelCurves = new Map<NodeId, NonNullable<LabelDraw['curve']>>();
  private recallLabels = new Map<NodeId, LabelDraw>();
  private recalled: { id: NodeId; labels: LabelDraw[] } | null = null;

  constructor(private measure: MeasureFn) {}

  /**
   * Re-measure changed nodes, lay out, rebuild branches and the spatial index. `changed`: the nodes an edit touched
   * since the previous pass on the same document; omitted, everything is treated as changed.
   */
  relayout(doc: Doc, theme: Theme, anchor?: NodeId | null, changed?: ReadonlySet<NodeId> | null): void {
    const t0 = performance.now();
    const previous = this.doc === doc ? this.placements : doc.layoutPlacements;
    if (this.doc !== doc) changed = null;
    this.doc = doc;
    this.theme = theme;
    this.computeSizes(changed ?? null);
    const geometryStart = performance.now();
    const reuse = changed && previous && previous === this.settled?.placements ? this.settleReuse(changed, this.settled.boxes) : undefined;
    const { placements, ...settled } = settleLayout(doc, this.sizes,
      { levelGap: theme.levelGap, siblingGap: theme.siblingGap }, previous, anchor, this.cache, false, reuse);
    this.lastGeometryMs = performance.now() - geometryStart;
    this.layout = settled;
    this.placements = placements;
    this.settled = { placements, boxes: settled.boxes };
    this.placePictureBoxes();
    this.dirty = this.dirtyNodes(changed ?? null);
    this.pass++;
    const specs = this.branchSpecs(this.layout, { specs: this.specMemo, dirty: this.dirty });
    this.layoutBranches = specs;
    this.labelCurves.clear();
    for (const spec of specs) {
      if (spec.underlineBend && spec.underlineTo) {
        this.labelCurves.set(spec.to, { span: Math.abs(spec.underlineTo.x - spec.p1.x), rise: spec.underlineBend });
      }
    }
    const meshStart = performance.now();
    this.mesh = this.branchMeshes.build(specs, this.meshOptions());
    this.lastBranchMeshMs = performance.now() - meshStart;
    this.lastBranchesRebuilt = this.branchMeshes.lastRebuilt;
    this.spatial.update(this.layout.boxes.values());
    this.baseScene = null;
    this.lastLayoutMs = performance.now() - t0;
    this.lastLayoutSource = 'main';
  }

  /**
   * What settleLayout can take over from the previous pass: the main branches (children of a root) holding a node an
   * edit touched or a node whose size changed are dirty, the others are kept. Undefined when a root itself changed.
   */
  private settleReuse(changed: ReadonlySet<NodeId>, boxes: ReadonlyMap<NodeId, NodeBox>): SettleReuse | undefined {
    const { nodes } = this.doc;
    const dirty = new Set<NodeId>();
    for (const ids of [changed, this.resized]) {
      for (const id of ids) {
        let node = nodes[id];
        if (!node) continue;
        if (node.parent === null) return undefined;
        for (let parent = nodes[node.parent]; parent?.parent !== null; parent = nodes[node.parent!]) {
          if (!parent) return undefined;
          node = parent;
        }
        dirty.add(node.id);
      }
    }
    return { boxes, dirty };
  }

  /**
   * Nodes whose branch specs and scene items may have changed beyond what their boxes show: the visible subtrees of
   * the nodes an edit touched (colours, widths, styles and themes are inherited down the tree). Null redoes every
   * node: no edit list, a root changed, or an input of every node changed (theme, seed, pictures).
   */
  private dirtyNodes(changed: ReadonlySet<NodeId> | null): Set<NodeId> | null {
    const inputs = this.specInputs;
    this.specInputs = { theme: this.theme, seed: this.doc.seed, sizes: this.sizeInputs };
    if (!changed || !inputs || inputs.theme !== this.theme || inputs.seed !== this.doc.seed || inputs.sizes !== this.sizeInputs ||
        this.pictureFrames.size || this.visibleArt.size) return null;
    const { nodes } = this.doc;
    const dirty = new Set<NodeId>();
    for (const id of changed) {
      const node = nodes[id];
      if (!node) continue;
      if (node.parent === null) return null;
      const pending = [id];
      while (pending.length) {
        const next = pending.pop()!;
        if (dirty.has(next)) continue;
        dirty.add(next);
        const child = nodes[next];
        if (child && !child.collapsed) for (const k of child.children) pending.push(k);
      }
    }
    return dirty;
  }

  tidyPlacements(doc: Doc, previous: LayoutPlacements): LayoutPlacements {
    const { levelGap, siblingGap } = this.theme;
    return settleLayout(doc, this.sizes, { levelGap, siblingGap }, previous, null, undefined, true).placements;
  }

  /**
   * A request for the layout worker. With `replica` the worker already holds the document as of the previous request:
   * only the edits since then go, and the placements go only if they are not the ones of the worker's result `kept`.
   */
  work(doc: Doc, theme: Theme, anchor: NodeId | null, state: SceneState,
    replica?: { ops: Op[]; nodes: number; kept?: { placements?: LayoutPlacements; result: number } }): LayoutWork {
    const placements = this.doc === doc ? this.placements : doc.layoutPlacements;
    const kept = replica?.kept;
    return {
      ...(replica ? { edits: { ops: replica.ops, nodes: replica.nodes } } : { doc: { ...doc, layoutPlacements: undefined } }),
      theme, anchor, placements: kept && kept.placements === placements ? { result: kept.result } : placements,
      imageInfo: this.imageInfo, failedImages: this.failedImages, artPending: this.artPending, showGeneratedArtwork: this.showGeneratedArtwork,
      prepareScene: !state.branch && !state.matches && !state.present, editing: state.editing
    };
  }

  /** `changed`: the nodes the edits since the previous call touched (see relayout); omitted for a whole document. */
  computeWork(work: Omit<LayoutWork, 'doc' | 'edits' | 'placements'> & { doc: Doc; placements?: LayoutPlacements }, changed?: ReadonlySet<NodeId>) {
    const doc = this.doc?.id === work.doc.id ? this.doc : { ...work.doc };
    if (doc === this.doc) {
      // The same document again: take its fields over, including the removal of one (an art preset, say).
      const fields = doc as unknown as Record<string, unknown>;
      for (const key of Object.keys(fields)) if (!(key in work.doc)) delete fields[key];
      Object.assign(doc, work.doc);
    }
    this.cache.invalidateAll();
    // New snapshots carry the main thread's last accepted placements, including after undo or load.
    this.placements = work.placements;
    doc.layoutPlacements = work.placements;
    this.imageInfo.clear();
    this.failedImages = work.failedImages;
    for (const pair of work.imageInfo) this.imageInfo.set(...pair);
    this.artPending.clear();
    for (const pair of work.artPending) this.artPending.set(...pair);
    this.showGeneratedArtwork = work.showGeneratedArtwork;
    const json = JSON.stringify(work.theme);
    if (this.workTheme?.json !== json) this.workTheme = { theme: work.theme, json };
    this.relayout(doc, this.workTheme.theme, work.anchor, changed);
    this.canvasDeferred = true;
    if (work.prepareScene) this.fullScene({
      selection: new Set(), focus: null, editing: work.editing, hover: null, revealArtworkLabels: false
    });
    return {
      layout: this.layout, placements: this.placements, mesh: this.mesh, spatial: this.spatial,
      layoutBranches: this.layoutBranches, labelCurves: this.labelCurves,
      imageNodes: this.imageNodes, visibleArt: this.visibleArt, artworkUnavailable: this.artworkUnavailable, pictureFrames: this.pictureFrames,
      pictureBoxes: this.pictureBoxes,
      missingImages: this.missingImages, missingImagePreviews: this.missingImagePreviews,
      recallLabels: this.recallLabels, baseScene: this.baseScene, drawnBranches: this.drawnBranches,
      preparedEditing: work.editing, nodeCount: this.nodeCount, lastLayoutMs: this.lastLayoutMs, lastGeometryMs: this.lastGeometryMs,
      lastBranchMeshMs: this.lastBranchMeshMs, lastBranchesRebuilt: this.lastBranchesRebuilt
    };
  }

  adoptWork(doc: Doc, theme: Theme, result: AdoptedWork, state: SceneState): boolean {
    const { missingImagePreviews, preparedEditing, spatial, layoutBranches, drawnBranches, ...snapshot } = result;
    Object.assign(this, snapshot);
    this.sceneFeatures = null;
    this.layoutSource = layoutBranches;
    this.drawnSource = drawnBranches;
    this.doc = doc;
    this.theme = theme;
    this.missingImagePreviews.clear();
    for (const hash of missingImagePreviews) this.missingImagePreviews.add(hash);
    this.spatial.update(snapshot.layout.boxes.values(), spatial);
    const useScene = this.baseScene !== null && !state.branch && !state.matches && !state.present && state.editing === preparedEditing;
    if (useScene) {
      this.scopeScene(null);
      this.mapScene = this.baseScene;
      this.baseScene = this.withCanvas(this.baseScene!);
    } else this.baseScene = null;
    this.indexFoldedBadges(this.baseScene);
    this.recalled = null;
    this.lastLayoutSource = 'worker';
    return useScene;
  }

  /**
   * Measure the visible nodes. A node's size depends on its own fields and on its context (depth, local theme, main
   * branch number, picture frame); it is re-keyed only when it changed since the previous pass (`changed`, from the
   * edit ops) or its context did. With `changed` null, or when an input of every node changed (theme, pictures,
   * art preset), every node is re-keyed, and a node is re-measured only when its key differs.
   */
  private computeSizes(changed: ReadonlySet<NodeId> | null): void {
    const { doc, theme } = this;
    const scopeOf = themeScopes(doc, theme);
    const themeSizeKey = [theme.id, theme.fontFamily, theme.rootFontSize, theme.mainFontSize, theme.fontSize,
      theme.rootShape, theme.mainShape, theme.shape, theme.fitBranchToLabel, theme.centralImage, theme.branchMarkers, theme.lean, theme.uppercaseMainBranches, theme.rootBranchWidth, theme.minBranchWidth,
      theme.keywordLabels, theme.rootBold, theme.mainBold, theme.tipDots ? `${theme.tipDots.radius},${theme.tipDots.gap}` : ''].join('|');
    const inputs = changed && JSON.stringify([this.showGeneratedArtwork, doc.artStyleId ?? null, [...this.imageInfo], [...this.failedImages], [...this.artPending]]);
    if (!changed || theme !== this.sizeTheme || inputs !== this.sizeInputs) this.sizeContext.clear();
    else for (const id of changed) this.sizeContext.delete(id);
    this.sizeTheme = theme;
    this.sizeInputs = inputs || '';
    this.resized.clear();
    const ids: NodeId[] = [], depths: number[] = [], inherited: Representation[] = [], scopes: (ThemeScope | undefined)[] = [];
    for (let i = doc.roots.length - 1; i >= 0; i--) {
      ids.push(doc.roots[i]);
      depths.push(0);
      inherited.push('vector');
      scopes.push(undefined);
    }
    const numbered = new Map<NodeId, number>();
    if (theme.branchMarkers) {
      for (const root of doc.roots) doc.nodes[root].children.forEach((id, index) => numbered.set(id, index));
    }
    let count = 0;
    this.localThemes = this.curvedStyles = false;
    const features: { artErrors: boolean; sketches: boolean } = { artErrors: false, sketches: false };
    this.sceneFeatures = features;
    this.imageNodes.clear();
    this.visibleArt.clear();
    this.artworkUnavailable.clear();
    this.pictureFrames.clear();
    this.missingImages = new Set();
    this.missingImagePreviews.clear();
    while (ids.length) {
      const id = ids.pop()!, depth = depths.pop()!, parentRepresentation = inherited.pop()!, parentScope = scopes.pop();
      const node = doc.nodes[id];
      if (!node) continue;
      count++;
      const scope = scopeOf(parentScope, node);
      const representation = node.representation ?? parentRepresentation;
      const attachment = theme.lean ? undefined : node.imageAsset;
      const generated = !theme.lean && this.showGeneratedArtwork && !attachment;
      const art = !generated ? undefined :
        representation === 'picture' ? node.pictureArt : representation === 'svg' ? node.svgArt : undefined;
      const pending = generated && representation !== 'vector' && this.artPending.has(id);
      const hash = art?.assetHash ?? attachment;
      const failed = hash !== undefined && this.failedImages.has(hash);
      const info = hash && !failed ? this.imageInfo.get(hash) : undefined;
      if (failed) this.artworkUnavailable.add(id);
      else if (hash) {
        if (info) this.imageNodes.set(id, hash);
        else this.missingImages.add(hash);
      }
      if (art && info) this.visibleArt.set(id, art);
      if (!failed && art?.thumbnailHash && art.thumbnailHash !== hash &&
          !this.failedImages.has(art.thumbnailHash) && !this.imageInfo.has(art.thumbnailHash)) {
        this.missingImagePreviews.add(art.thumbnailHash);
      }
      let frame: PictureFrame | undefined;
      if (!failed && (attachment || art || pending)) {
        // A generated raster picture uses the same frame throughout a batch. Its cropped
        // aspect controls the fit inside that frame, while SVG can declare its frame upfront.
        const aspect = attachment
          ? positiveAspect(node.imageAspect) ?? positiveAspect(info?.aspect) ?? DEFAULT_PICTURE_ASPECT
          : (representation === 'svg' ? declaredArtAspect(art) : undefined) ?? DEFAULT_ART_ASPECT;
        const central = depth === 0 && theme.centralImage !== false ? 1.35 : 1;
        frame = imageSize(aspect, (attachment ? node.imageScale ?? 1 : 1) * central);
        this.pictureFrames.set(id, frame);
      }
      const local = scope.resolved;
      if (local !== theme) this.localThemes = true;
      if (node.style?.curvedLabel) this.curvedStyles = true;
      if (node.svgArtError || node.pictureArtError) features.artErrors = true;
      if (node.sketch?.strokes.length) features.sketches = true;
      const number = numbered.get(id);
      const context = this.sizeContext.get(id);
      // Unchanged node in an unchanged context: its key, and so its size, are the ones of the previous pass.
      if (!context || context.depth !== depth || context.local !== local || context.number !== number ||
          context.frameW !== frame?.w || context.frameH !== frame?.h) {
        const imgKey = frame ? `|img${frame.w},${frame.h}` : '';
        const localKey=local===theme ? '' : [local.fontFamily,local.shape,local.mainShape,local.uppercaseMainBranches,local.keywordLabels,
          local.rootBold,local.mainBold,local.tipDots ? `${local.tipDots.radius},${local.tipDots.gap}` : ''].join('|');
        const key = `${localKey}/${node.sticker ?? ''}/${node.text}\u0001${depth}\u0001${node.style ? JSON.stringify(node.style) : ''}\u0001${themeSizeKey}|${number ?? ''}${imgKey}`;
        if (this.sizeKey.get(id) !== key) {
          let s = nodeSize(node, depth, local, this.measure, number);
          if (frame) s = { w: Math.max(s.w, frame.w + 8), h: s.h + frame.h + IMAGE_GAP };
          const old = this.sizes.get(id);
          if (!old || old.w !== s.w || old.h !== s.h) this.resized.add(id);
          this.sizes.set(id, s);
          this.sizeKey.set(id, key);
        }
        // Only a node whose theme lasts from pass to pass (the map's own) can skip the key next time.
        if (changed && local === theme) this.sizeContext.set(id, { depth, local, number, frameW: frame?.w, frameH: frame?.h });
        else this.sizeContext.delete(id);
      }
      if (!node.collapsed) {
        for (let i = node.children.length - 1; i >= 0; i--) {
          ids.push(node.children[i]);
          depths.push(depth + 1);
          inherited.push(representation);
          scopes.push(scope);
        }
      }
    }
    this.nodeCount = count;
    if (this.sizes.size > count * 2 + 200) {
      // drop entries of deleted nodes
      for (const id of Array.from(this.sizes.keys())) {
        if (!doc.nodes[id]) {
          this.sizes.delete(id);
          this.sizeKey.delete(id);
          this.sizeContext.delete(id);
        }
      }
    }
  }

  private placePictureBoxes(): void {
    this.pictureBoxes.clear();
    if (!this.pictureFrames.size) return;
    const styles = createStyleResolver(this.doc, this.theme);
    for (const [id, frame] of this.pictureFrames) {
      const hash = this.imageNodes.get(id);
      const box = this.layout.boxes.get(id);
      const info = hash ? this.imageInfo.get(hash) : undefined;
      if (!box) continue;
      const style = styles.get(id, box.depth, box.mainBranch);
      const pad = nodePadding(box.depth, style.shape, this.theme, this.doc.nodes[id].style?.branchWidth);
      const aspect = info ? declaredArtAspect(this.visibleArt.get(id)) ?? positiveAspect(info.aspect) : undefined;
      let size: Size = frame;
      if (aspect && aspect !== frame.aspect) {
        const h = Math.min(frame.h, frame.w / aspect);
        size = { w: h * aspect, h };
      }
      const labelFirst = this.pictureLabelPlacement(id) === 'branch';
      const textHeight = labelFirst ? box.h - pad.t - pad.b - frame.h : 0;
      const y = box.y - box.h / 2 + pad.t + 2 + (frame.h - size.h) / 2 + textHeight;
      this.pictureBoxes.set(id, { x: box.x - size.w / 2, y, w: size.w, h: size.h });
    }
  }

  /** Art rectangles for a tentative SVG layout, including nodes currently collapsed. */
  planSvgBoxes(ids: NodeId[], rootId: NodeId): Map<NodeId, Rect> {
    const placeholder = '_svg-preview';
    const nodes = { ...this.doc.nodes };
    for (const id of ids) {
      const { parent } = nodes[id];
      if (parent !== null && nodes[parent].collapsed) nodes[parent] = { ...nodes[parent], collapsed: false };
      nodes[id] = {
        ...nodes[id],
        collapsed: false,
        imageAsset: undefined,
        representation: id === rootId ? 'svg' : undefined,
        svgArt: { assetHash: placeholder, inputHash: '', prompt: '', styleId: '', styleVersion: 1, generatedAt: '' }
      };
    }
    let parent = nodes[rootId]?.parent;
    while (parent != null) {
      if (nodes[parent].collapsed) nodes[parent] = { ...nodes[parent], collapsed: false };
      parent = nodes[parent].parent;
    }
    const preview = new Pipeline(this.measure);
    for (const [hash, info] of this.imageInfo) preview.imageInfo.set(hash, info);
    preview.relayout({ ...this.doc, nodes, layoutPlacements: this.placements }, { ...this.theme, lean: false });
    const boxes = new Map<NodeId, Rect>();
    for (const id of ids) {
      const rect = preview.pictureBoxes.get(id);
      if (rect) boxes.set(id, rect);
    }
    return boxes;
  }

  /** Branch geometry with the same artwork anchors used by the on-screen scene. */
  branchSpecs(layout = this.layout, memo?: Parameters<typeof buildBranchSpecs>[3]) {
    const specs = buildBranchSpecs(this.doc, layout, this.theme, memo);
    const theme = this.theme;
    // Nothing below applies without pictures and curved labels; the specs (possibly the memo's) stay as they are.
    if (!this.pictureBoxes.size && !this.visibleArt.size && !theme.curvedLabels && !this.localThemes && !this.curvedStyles) return specs;
    const artStems: BranchSpec[] = [];
    const pictureJoints = new Map<NodeId, number>();
    let styleResolver: ReturnType<typeof createStyleResolver> | undefined;
    for (let i = 0; i < specs.length; i++) {
      // A spec may be the memo's for the next pass: a change goes to a copy, which replaces it in the list.
      let spec = specs[i];
      const own = () => { if (spec === specs[i]) spec = specs[i] = { ...spec }; };
      const parent = this.artAnchor(spec.from, 'out', spec.to) ?? this.centralImageAnchor(spec.from, layout.boxes.get(spec.to));
      const child = this.artAnchor(spec.to, 'in');
      if (parent) {
        own();
        spec.p0 = parent;
        spec.w0 = pictureJoints.get(spec.from) ?? spec.w0;
      }
      const node = this.doc.nodes[spec.to];
      const box = layout.boxes.get(spec.to);
      if (child && box && this.pictureLabelPlacement(spec.to) === 'branch') {
        own();
        styleResolver ??= createStyleResolver(this.doc, theme);
        const s = styleResolver.get(box.id, box.depth, box.mainBranch);
        const pad = nodePadding(box.depth, s.shape, theme, node.style?.branchWidth);
        const side = spec.p0.x <= box.x ? 1 : -1;
        const y = box.y + box.h / 2 - pad.b - 2 * this.labelShift(spec.to) + IMAGE_GAP / 2;
        const underlineEnd = { x: box.x + side * box.w / 2, y };
        spec.p1 = { x: box.x - side * box.w / 2, y };
        spec.underlineTo = underlineEnd;
        spec.w1 = spec.underlineWidth = Math.min(4, spec.w1);
        const pictureWidth = Math.max(1, spec.underlineWidth * 0.75);
        pictureJoints.set(spec.to, pictureWidth);
        artStems.push({
          ...spec, p0: underlineEnd, p1: child, flow: 'v',
          w0: spec.underlineWidth, w1: pictureWidth,
          underlineTo: undefined, underlineWidth: undefined, lift: undefined
        });
      } else if (child) {
        own();
        spec.p1 = child;
        delete spec.underlineTo;
        delete spec.underlineWidth;
      }
      if (!box || !spec.underlineTo || this.pictureBoxes.has(spec.to) || (node.style?.alignment && node.style.alignment !== 'center')) continue;
      styleResolver ??= createStyleResolver(this.doc, theme);
      const local = styleResolver.themeFor(box.id);
      if (!(node.style?.curvedLabel ?? local.curvedLabels)) continue;
      const text = displayText(node, box.depth, local, box.mainBranch);
      if (!canCurveText(text)) continue;
      const style = styleResolver.get(spec.to, box.depth, box.mainBranch);
      const padding = nodePadding(box.depth, style.shape, theme, node.style?.branchWidth);
      const span = Math.abs(spec.underlineTo.x - spec.p1.x);
      const textHeight = box.h - padding.t - padding.b;
      if (textHeight > style.font.size * 1.25 + 1 || span < style.font.size * 1.45) continue;
      const rise = Math.min(3, span * 0.055, style.font.size * 0.18);
      if (canCurveUnderline(span, rise, style.font.size)) {
        own();
        spec.underlineBend = rise;
      }
    }
    return artStems.length ? [...specs, ...artStems] : specs;
  }

  private centralImageAnchor(id: NodeId, child?: Vec2): Vec2 | undefined {
    if (this.theme.centralImage === false || this.doc.nodes[id].parent !== null || !child) return;
    const image = this.pictureBoxes.get(id);
    if (!image || !this.imageNodes.has(id)) return;
    const x = image.x + image.w / 2, y = image.y + image.h / 2;
    const dx = child.x - x, dy = child.y - y;
    if (!dx && !dy) return;
    const edge = Math.min(dx ? image.w / (2 * Math.abs(dx)) : Infinity, dy ? image.h / (2 * Math.abs(dy)) : Infinity);
    return { x: x + dx * edge, y: y + dy * edge };
  }

  private pictureLabelPlacement(id: NodeId): PictureLabelPlacement {
    const art = this.visibleArt.get(id);
    const node = this.doc.nodes[id];
    return art && art === node.pictureArt ? node.pictureLabelPlacement ?? 'caption' : 'caption';
  }

  private artAnchor(id: NodeId, direction: 'in' | 'out', child?: NodeId): Vec2 | undefined {
    const anchors = this.visibleArt.get(id)?.anchors;
    const anchor = (child ? anchors?.outByChild?.[child] : undefined) ?? anchors?.[direction];
    const box = this.pictureBoxes.get(id);
    if (!anchor || !box || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return;
    const normalized = (n: number) => Math.max(0, Math.min(1, n));
    return { x: box.x + box.w * normalized(anchor.x), y: box.y + box.h * normalized(anchor.y) };
  }

  /** Box of a node, or undefined if hidden. */
  box(id: NodeId): NodeBox | undefined {
    return this.layout.boxes.get(id);
  }

  attachmentRect(id: NodeId): Rect | undefined {
    if (this.doc.nodes[id]?.imageAsset && this.canvasLayout.boxes.has(id)) return this.pictureBoxes.get(id);
  }

  /** Half the extra vertical space below or above a picture label. */
  labelShift(id: NodeId): number {
    const frame = this.pictureFrames.get(id);
    return frame ? (frame.h + IMAGE_GAP) / 2 : 0;
  }

  labelEditorOffset(id: NodeId): number {
    return this.pictureLabelPlacement(id) === 'branch' ? 0 : this.labelShift(id) * 2;
  }

  /** Full scene (labels, rects, images) with an empty overlay; selection is added by `withOverlay`. */
  fullScene(state: SceneState): Scene {
    const present = state.present ?? null;
    this.scopeScene(state.branch ?? null, present);
    const images = new Map<NodeId, string>();
    for (const [id, hash] of this.imageNodes) {
      const info = this.imageInfo.get(hash);
      if (info && this.canvasLayout.boxes.has(id)) images.set(id, info.url);
    }
    const matches = present ? null : state.matches;
    const opacity = present ? (id: NodeId) => present.opacity.get(id) ?? 1
      : (id: NodeId) => !matches || matches.has(id) ? 1 : DIM_OPACITY;
    let mesh = this.scope?.mesh ?? this.mesh;
    this.drawnBranches = this.scope?.specs ?? this.layoutBranches;
    if (matches && (mesh.indices.length || mesh.instances?.count)) {
      const specs = this.drawnBranches.map((spec) => {
        const alpha = opacity(spec.to);
        return alpha === 1 ? spec : this.dimBranch(spec, alpha);
      });
      this.drawnBranches = specs;
      mesh = (this.filteredMeshes ??= new BranchMeshCache()).build(specs, this.meshOptions());
    } else this.filteredMeshes = undefined;
    // The worker's scene of the whole map, without pictures or curved labels: keep the items of unchanged nodes.
    const memo = this.canvasDeferred && !present && !matches && !this.scope && !images.size && !this.pictureBoxes.size &&
      !this.labelCurves.size && !this.visibleArt.size
      ? { scene: this.sceneMemo, dirty: this.sceneMemoPass === this.pass - 1 ? this.dirty : null } : undefined;
    this.sceneMemoPass = memo ? this.pass : -1;
    const scene = buildScene({
      doc: this.doc,
      layout: this.canvasLayout,
      theme: this.theme,
      selection: new Set(),
      focus: null,
      editing: state.editing,
      hover: null,
      branches: mesh,
      images,
      nodeOpacity: memo ? undefined : opacity
    }, memo);
    if (this.pictureBoxes.size) this.placePictures(scene, state.editing, opacity);
    if (this.scope?.cues?.length) this.shapeCues(scene, this.scope.cues);
    if (this.theme.centralImage !== false && scene.images.some((im) => this.doc.nodes[im.id].parent === null)) {
      scene.rects = scene.rects.filter((r) => r.branchBoundary || r.foldBadge || !r.nodeId || this.doc.nodes[r.nodeId]?.parent !== null ||
        !this.imageNodes.has(r.nodeId) || r.pictureFrame);
    }
    if (this.labelCurves.size) this.placeCurvedLabels(scene.labels, state.editing);
    if (state.highlightedWord && matches) {
      for (const label of scene.labels) {
        if (!label.foldBadge && matches.has(label.id)) label.highlightedWord = state.highlightedWord;
      }
    }
    this.recallLabels.clear();
    this.recalled = null;
    if (state.revealArtworkLabels === false && this.visibleArt.size) {
      scene.labels = scene.labels.filter((label) => {
        const id = label.id;
        if (id === state.editing || !(this.doc.nodes[id].text || this.doc.nodes[id].sticker) || this.recallLabels.has(id) ||
            this.pictureLabelPlacement(id) !== 'recall') return true;
        this.recallLabels.set(id, label);
        return false;
      });
    }
    if (scene.images.length) {
      const pictures = new Map(scene.images.map((image) => [image.id, image]));
      for (const label of scene.labels) {
        const picture = pictures.get(label.id);
        if (!picture || label.foldBadge || !label.text.trim()) continue;
        picture.overviewTitle = label.pictureTitle = true;
      }
    }
    // Failure badges and sketches: skip the walk when this pipeline's last measuring found none.
    const features = this.sceneFeatures;
    if (!this.theme.lean && (!features || features.artErrors || this.artworkUnavailable.size)) {
      for (const [id, box] of this.canvasLayout.boxes) {
        const node = this.doc.nodes[id];
        const generationFailed = this.showGeneratedArtwork && (node?.svgArtError || node?.pictureArtError);
        if (!generationFailed && !this.artworkUnavailable.has(id)) continue;
        const x = box.x + box.w / 2 + 7, y = box.y - box.h / 2 + 4;
        scene.rects.push({ nodeId: id, x: x - 6, y: y - 6, w: 12, h: 12, radius: 6, fill: premulCss('#A24105', opacity(id)) });
        scene.labels.push({
          id, text: '!', x, y, fontSize: 9, fontFamily: this.theme.fontFamily, bold: true, italic: false,
          color: premulCss('#FFFFFF', opacity(id)), maxWidth: 12, align: 'center'
        });
      }
    }
    const ink: InkDraw[] = [];
    if (!this.theme.lean && (!features || features.sketches)) {
      for (const [id, box] of this.canvasLayout.boxes) {
        const sketch = this.doc.nodes[id]?.sketch;
        if (!sketch?.strokes.length) continue;
        const frame = inkFrame(box, sketch.placement);
        for (const stroke of sketch.strokes) ink.push({ id, frame, stroke, opacity: opacity(id) });
      }
    }
    if (ink.length) {
      scene.ink = ink;
      scene.overlayMesh = inkMesh(ink);
    }
    this.mapScene = scene;
    const full = this.canvasDeferred ? scene : this.withCanvas(scene);
    this.baseScene = full;
    this.indexFoldedBadges(scene);
    return full;
  }

  /** Lay the canvas elements over a scene of the maps. A map without elements gets its scene back unchanged. */
  private withCanvas(scene: Scene): Scene {
    const built = this.canvas.build({
      doc: this.doc, theme: this.theme, boxes: this.layout.boxes, imageInfo: this.imageInfo,
      failedImages: this.failedImages, preview: this.canvasPreview, dim: this.scope?.present?.elements
    });
    for (const hash of this.canvas.missing) this.missingImages.add(hash);
    const grid = this.canvasGrid ? this.doc.canvas?.grid : undefined;
    if (grid) {
      // World-fixed dots at the grid size, over the theme's own surface.
      scene = { ...scene, surface: { ...scene.surface, dots: { color: premulCss(this.theme.textColor, 0.28), spacing: grid.size } } };
    }
    return built ? this.canvas.attach(scene) : scene;
  }

  /** Rebuild only the canvas layer (an element edit or a gesture preview); false when there is no scene to update. */
  refreshCanvas(): boolean {
    if (!this.mapScene || !this.baseScene) return false;
    this.baseScene = this.withCanvas(this.mapScene);
    return true;
  }

  /** Focus cues follow the outline of their node (a pill gets a pill); the renderer grows them by a screen-px gap. */
  private shapeCues(scene: Scene, cues: RectDraw[]): void {
    const radii = new Map<NodeId, number>();
    for (const r of scene.rects) {
      if (r.nodeId && !r.foldBadge && !r.branchBoundary && !r.pictureFrame && !radii.has(r.nodeId)) radii.set(r.nodeId, r.radius);
    }
    for (const cue of cues) {
      const radius = cue.nodeId !== undefined ? radii.get(cue.nodeId) : undefined;
      if (radius !== undefined) cue.radius = radius;
    }
  }

  private placeCurvedLabels(labels: LabelDraw[], editing: NodeId | null): void {
    const labelled = new Set<NodeId>();
    for (const label of labels) {
      if (label.id === editing || label.id === this.scope?.root || labelled.has(label.id)) continue;
      const curve = this.labelCurves.get(label.id);
      if (curve) {
        label.curve = curve;
        labelled.add(label.id);
      }
    }
  }

  /** Move the picture to the top of its node and the label below it. */
  private placePictures(scene: Scene, editing: NodeId | null, opacity: (id: NodeId) => number): void {
    for (const im of scene.images) {
      const box = this.pictureBoxes.get(im.id);
      if (!box) continue;
      im.w = box.w;
      im.h = box.h;
      im.y = box.y + box.h / 2;
      const node = this.doc.nodes[im.id];
      const art = this.visibleArt.get(im.id);
      im.alt = node.imageAlt ?? (node.text || 'Attached picture');
      const hash = this.imageNodes.get(im.id);
      const info = hash && this.imageInfo.get(hash);
      if (info) {
        im.vector = info.vector;
        im.previewSrc = info.thumbnailUrl;
        im.previewSrcs = info.thumbnailUrls;
        im.thumbHash = info.thumbHash;
      }
      if (art) {
        if (node.svgArt?.assetHash === art.assetHash) im.vector = true;
        if (art.thumbnailHash) im.previewSrc = this.imageInfo.get(art.thumbnailHash)?.url ?? im.previewSrc;
      }
      if (art?.framed) {
        scene.rects.push({ ...box, nodeId: im.id, pictureFrame: true, radius: 8, fill: premulCss(this.theme.background, opacity(im.id)) });
      }
    }
    const seen = new Set<NodeId>();
    for (const l of scene.labels) {
      if (seen.has(l.id) || l.id === editing || !(this.doc.nodes[l.id].text || this.doc.nodes[l.id].sticker)) continue;
      seen.add(l.id);
      l.y += this.labelShift(l.id) * (this.pictureLabelPlacement(l.id) === 'branch' ? -1 : 1);
    }
    for (const [id, box] of this.pictureBoxes) {
      if (!this.canvasLayout.boxes.has(id) || this.imageNodes.has(id)) continue;
      const pending = this.doc.nodes[id].imageAsset ? undefined : this.artPending.get(id);
      const fade = opacity(id);
      scene.rects.push({
        ...box, nodeId: id, radius: 8, fill: premulCss(this.theme.textColor, 0.035 * fade), stroke: premulCss(this.theme.textColor, 0.18 * fade), strokeWidth: 1
      });
      if (pending) scene.labels.push({
        id, text: pending === 'Queued' ? 'Queued' : 'Generating…',
        x: box.x + box.w / 2, y: box.y + box.h / 2,
        fontSize: 12, fontFamily: this.theme.fontFamily, bold: false, italic: false, color: premulCss(this.theme.textColor, 0.75 * fade),
        maxWidth: box.w, align: 'center'
      });
    }
  }

  /**
   * Cheap update for selection / hover / drag changes: reuses the full scene and replaces only the overlay.
   * Only highlighted boxes are visited.
   */
  withOverlay(state: SceneState, extra: RectDraw[]): Scene {
    const base = this.baseScene ?? this.fullScene(state);
    const ids = new Set<NodeId>(state.selection);
    if (state.focus) ids.add(state.focus);
    if (state.hover) ids.add(state.hover);
    const overlay: RectDraw[] = [];
    for (const id of ids) {
      const box = this.canvasLayout.boxes.get(id);
      if (box && (!state.matches || state.matches.has(id))) {
        appendNodeOverlay(overlay, box, state.selection, state.focus, state.hover);
      }
    }
    let labels = base.labels;
    if (this.recallLabels.size) {
      const id = [state.hover, state.focus].find((candidate) => candidate && this.recallLabels.has(candidate));
      if (id) {
        if (this.recalled?.id !== id) this.recalled = { id, labels: [...base.labels, this.recallLabels.get(id)!] };
        labels = this.recalled.labels;
      }
    }
    const cues = state.present && this.scope?.present === state.present ? this.scope.cues ?? [] : [];
    if (cues.length) overlay.push(...cues);
    return { ...base, labels, overlay: extra.length ? overlay.concat(extra) : overlay };
  }

  invalidateScene(): void {
    this.baseScene = null;
  }

  get hasBase(): boolean {
    return this.baseScene !== null;
  }
}
