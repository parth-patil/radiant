import type { AiQueue } from '../core/ai/provider';
import { boundSource } from '../core/ai/source';
import { importNotices, type ImportFormat } from './import-notices';
import { imageReferences } from '../core/io/portable';
import { repeatedWords } from '../core/model/repeated-words';
import { RemindersSync } from './remindersSync.svelte';
import { MapRepair } from '../core/ai/map-repair';
import { COLLECTION_LAYOUTS, isCollectionLayout } from '../core/layout/collections';
import type { InkPlacement, InkSketch } from '../core/geometry/ink';
import { codexDiagnostic, recordDiagnostic } from './diagnostics';
import { getSetting, initSettings, setSetting } from './settings';
import { AI_JOB_WARNING_LIMIT, AI_PROMPT_LIMIT, captureAiJob, parseAiJobRecord } from '../core/model/ai-provenance';
import { animateLayoutBetween, FOLD_DURATION, type LayoutFrame, type MembershipOptions } from './layout-animation';
import { PresentationEngine } from './presentation.svelte';
import { AgentSession } from './agent-session.svelte';
/**
 * AppController: owns the Editor, the render pipeline, the camera, input handling, AI jobs and files.
 * Svelte components read its reactive fields (runes) and call its methods.
 */
import { BRANCH_MIME, copyBranches, insertBranches } from '../core/model/clipboard';
import { parseGeneratedStyle, treeThemes } from '../core/model/generated-style';
import { artSubtree, setArtRepresentation } from '../core/art/representation';
import { planArtNesting } from '../core/art/nesting';
import { confirmArtIslands } from './art-nesting';
import { AiChanges, type AiChangeSummary } from './ai-change-summary';
import type { Representation } from '../core/types';
import { chord, commands as shortcutCommands, preset, type Shortcuts } from './keymap';
import { addSnapshot, latestSnapshotForPath, readRecent, rememberRecent, storeSnapshot, type Snapshot } from './history';
import { discardRecoveryUndo, loadUndo, saveUndo, STORED_UNDO_LIMIT } from './undo-storage';
import { learnedMap, linkReviewMapPath } from './reviewStore';
import { createStudyBlanks } from '../core/ai/refine-study';
import type { Outcome } from '../core/review';
import type { EditorChange, EditorHistory } from '../core/model/editor';
import { encodeJournalChange } from './journal';
import type {
  AiJobRecord,
  CameraState,
  Doc,
  LayoutKind,
  LayoutPlacements,
  NodeId,
  Op,
  OutlineNode,
  RectDraw,
  Rect,
  StyleSheet,
  Theme,
  Transaction,
  Vec2
} from '../core/types';
import {
  Editor,
  addChild,
  addParent, addLink, clearOffset,
  addSibling,
  createAlias,
  createDoc,
  deleteSubtree, deleteAndPromote,
  docFromOutline,
  docFromOutlines,
  getTheme,
  insertOutline,
  isAncestor,
  listThemes,
  moveSubtree,
  newId,
  nextSibling,
  outlineFromDoc,
  outlineFromSubtree,
  outlineInsertOps,
  parentOf,
  parseDocReport,
  parseIndentedText,
  prevSibling,
  reorder,
  rootOf,
  serializeDoc,
  setNote,
  setOffset,
  setStyle,
  setText,
  subtreeIds,
  toIndentedText,
  toggleCollapsed, detach, collapseToDepth, expandAll, unfoldOneLevel,
  type GroupHandle
} from '../core/model';
import { measureLabel, Camera, CameraController, Renderer } from '../render';
import type { RenderDevice, RenderStats } from '../render';
import type { CanvasGestures } from '../render/camera';
import { loadCanvasGestures, saveCanvasGestures } from './canvas-input';
import { createStyleResolver, nodePadding, premulCss, ACCENT_COLOR, type Direction } from '../core/geometry';
import {
  NodeLineParser,
  StreamApplier,
  addNodes,
  applyAiEvent,
  buildExpandPrompt,
  buildGenerateMapPrompt, generationLimits,
  registerJob,
  type AiJobKind,
  type AiJobs
} from '../core/ai';
import { StreamJournal } from '../core/ai/stream-journal';
import { isMindNodeArchive, parseMindNode } from './mindnode-import';
import { parseXmind, mapLink, parseMapLink, extractLinkedBranch, readPortableFiles, readPortableMap, parseJsonCanvas, parseFreeMind, parseMarkdownOutline, parseOpml, toMarkdownOutline } from '../core/io';
import { getHost } from '../host';
import { decodeImageAspect } from '../host/image-preview';
import { readBranches } from './clipboard';
import { parseNodeLink } from './node-link';
import type { AiEvent, AiStatus, AiTurnRequest, Host, MapLinkNavigation, MapLinkOrigin, MapLinkResult, MenuId, RecoveredDoc } from '../host/types';
import { clampImageScale, Pipeline, type AdoptedWork, type SceneState } from './pipeline';
import { canvasOnly } from './canvas-layer';
import { CanvasTools } from './canvas-tools.svelte';
import type { LayoutResultMessage, LayoutWorkerRequest } from './layout.worker';
import {
  applyLayoutChunk, layoutTaskTurn, splitLayoutPayload, STREAM_LAYOUT_AT, unpackLayoutResult, type LayoutHeader, type LayoutWire
} from './layout-transport';
import { checkedPictureMime, pictureFile, pictureFromDrop, picturePathMime } from './local-picture';
import { matchingCanvasNodes, type CanvasFilter } from './canvas-filter';
import {
  basename,
  extOf,
  fmtTime,
  blockedAiAllowance, friendlyAiError,
  isEmptyDoc,
  isTypingTarget,
  stem,
  themeFromText,
  wrapOutline
} from './util';

export interface DialogButton {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}
export interface DialogState {
  title: string;
  message: string;
  buttons: DialogButton[];
  details?: readonly string[];
  requestPreview?: string;
  resolve: (id: string) => void;
}

export interface GenState {
  kind: 'generate' | 'expand';
  status: 'starting' | 'running' | 'cancelling';
  nodes: number;
  liveGrowth: boolean;
  startedAt: number;
  webSearch?: boolean;
}

export interface OutlineRow {
  id: NodeId;
  depth: number;
  text: string;
  hasChildren: boolean;
  collapsed: boolean;
}

const LAYOUTS: LayoutKind[] = ['mindmap', 'right', 'left', 'down', 'up', 'compact', 'radial', 'outline', ...COLLECTION_LAYOUTS];
export const LAYOUT_NAMES: Record<LayoutKind, string> = {
  mindmap: 'Balanced',
  right: 'Right',
  left: 'Left',
  down: 'Down',
  up: 'Up',
  compact: 'Compact',
  radial: 'Radial',
  outline: 'Outline',
  timeline: 'Timeline / Path',
  columns: 'Columns',
  grid: 'Grid',
  popcorn: 'Popcorn'
};

const MAP_ART_PRESETS: Record<string, string> = {
  buzan: 'buzan-vivid', clean: 'flat-vector', ink: 'ink-sketch', midnight: 'flat-vector', 'hand-drawn': 'ink-sketch'
};
const FIXED_MAP_PRESETS = new Set(['buzan organic', 'clean', 'ink', 'midnight', 'hand-drawn', 'colourful for kids', 'minimal business']);

const MAX_BUFFERED_MAP_LENGTH = 1_000_000;

interface AiRun {
  journal: StreamJournal;
  buffered?: boolean;
  changes: AiChanges;
  studyPercent?: number;
  userTouched: Set<NodeId>;
  id: string | null;
  kind: 'generate' | 'expand';
  limits: { maxDepth: number; maxChildren: number };
  provenance?: AiJobRecord;
  pendingWarning?: boolean;
  repair?: MapRepair;
  buf: AiEvent[];
  topic: string;
  styleRequest: string;
  attach: { kind: 'newRoot'; position: Vec2 } | { kind: 'existing'; parentId: NodeId };
  placeholder: NodeId | null;
  targetId: NodeId | null;
  /** Started from the Generate panel, which closes when the run is done. */
  fromPrompt?: boolean;
  parser: NodeLineParser | null;
  applier: StreamApplier | null;
  group: GroupHandle | null;
  sheet: Partial<StyleSheet>;
  firstApplied: boolean;
  autoFit: boolean;
  lastFit: number;
  fitTimer: number;
  stopFit?: () => void;
  heuristicTheme: string | null;
}

/** Generate started on a node: several levels of new nodes under it. */
interface GrowRequest {
  id: NodeId;
  depth: number;
  breadth: number;
  focus: string;
}

interface DragState {
  id: NodeId;
  startClient: Vec2;
  startWorld: Vec2;
  active: boolean;
  dx: number;
  dy: number;
  target: NodeId | null;
  insertAt: 'before' | 'after' | null;
  wasSelected: boolean;
  modifier: boolean;
  linkDrag:boolean;
  detach:boolean;
}

type CanvasView =
  | { kind: 'focus'; root: NodeId; previous: CameraState }
  | { kind: 'presentation'; previous: CameraState };

interface Marquee {
  pointer: number;
  start: Vec2;
  client: Vec2;
  base: NodeId[];
  rect: Rect | null;
}

/**
 * Resolves once the browser has drawn the next frame (or after 100 ms, for a window that draws none while hidden), so
 * long work queued behind it stays off the path between an edit and the frame that shows it.
 */
function afterNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => setTimeout(() => {
      clearTimeout(fallback);
      resolve();
    }, 0));
  });
}

export class AppController {
  // ------------------------------------------------------------ reactive state (read by components)
  ready = $state(false);
  rev = $state(0); // bumped on every document change
  layoutTick = $state(0); // bumped after every layout pass
  camTick = $state(0); // bumped on every camera change
  selTick = $state(0);
  selIds = $state.raw<NodeId[]>([]);
  focusId = $state<NodeId | null>(null);
  editingId = $state<NodeId | null>(null);
  filePath = $state<string | null>(null);
  mapLinkTrail = $state.raw<readonly MapLinkOrigin[]>([]);
  brokenMapLinks = $state.raw<ReadonlyMap<string, 'file' | 'node'>>(new Map());
  dirty = $state(false);
  saveText = $state('');
  outlineOnly = $state(false);
  showOutline = $state(false);
  topBarHeight = $state(40);
  statusBarHeight = $state(24);
  interfaceScale = $state(1);
  setInterfaceScale(value:number) {
    if(!Number.isFinite(value))return;
    this.interfaceScale=Math.min(1.5,Math.max(1,value));
    setSetting('radiant.interfaceScale',String(this.interfaceScale));
  }
  showInspector = $state(false);
  exportRequest = $state.raw<'export' | 'print' | { format: 'opml'; scope: 'map' | 'selection' } | null>(null);
  showStats = $state(false);
  showMinimap = $state(false);
  showGeneratedArtwork = $state(true);
  showCanvasFilter = $state(false);
  canvasFilter = $state.raw<CanvasFilter | null>(null);
  canvasMatches = $state.raw<ReadonlySet<NodeId> | null>(null);
  canvasView = $state.raw<CanvasView | null>(null);
  // ------------------------------------------------------------ presentation (PRS-02): the engine owns it; these are its hooks
  readonly presentation: PresentationEngine = new PresentationEngine(this, {
    begin: (previous) => {
      this.showPrompt = this.showCanvasFilter = this.spaceCandidate = false;
      this.canvasView = { kind: 'presentation', previous: this.canvasView?.previous ?? previous };
    },
    refresh: (growth) => {
      if (this.canvasView?.kind === 'presentation') this.canvasView = { ...this.canvasView };
      this.sceneGrowth = growth;
      this.markScene();
      this.flush();
    },
    finishGrowth: () => {
      if (!this.layoutAnimation || !this.settledFrame) return;
      this.layoutAnimation = null;
      this.renderer.setScene(this.settledFrame.scene);
    },
    hit: (e) => this.hitAt(this.clientToWorld(e))
  });
  /** The window's live agent session and access prompt. */
  readonly agent: AgentSession = new AgentSession(this);
  /** Canvas elements: tools, selection, gestures and keys (spec 7.3). */
  readonly canvasTools: CanvasTools = new CanvasTools(this, {
    hitNode: (world) => this.hitAt(world, true),
    ensureImage: (hash) => this.ensureImage(hash)
  });
  recent = $state<string[]>([]);
  private linkFrom:NodeId|null=null;
  foldLevelFor = $state<NodeId | null>(null);
  sketchTarget = $state<NodeId | null>(null);
  inkPlacement = $state<InkPlacement>('on');
  inkTool = $state<'draw' | 'erase'>('draw');
  inkColor = $state('#2563eb');
  inkWidth = $state(5);

  startSketch(id: NodeId): void {
    if (this.theme.lean || this.presenting || !this.doc.nodes[id]) return;
    this.endEdit();
    this.select([id]);
    this.sketchTarget = id;
    this.inkTool = 'draw';
    this.centerOn(id);
  }

  updateSketch(id: NodeId, label: string, update: (previous: InkSketch | undefined) => InkSketch | undefined): void {
    if (this.editor.defer(() => this.updateSketch(id, label, update))) return;
    const node = this.doc.nodes[id];
    if (!node) return;
    const sketch = update(node.sketch);
    if (sketch === node.sketch) return;
    this.editor.apply({ source: 'user', label, ops: [{ t: 'set', id, patch: { sketch } }] });
  }

  setSketchPlacement(id: NodeId, placement: InkPlacement): void {
    this.inkPlacement = placement;
    this.updateSketch(id, 'Move Sketch', (previous) => previous && previous.placement !== placement
      ? { ...previous, placement } : previous);
  }

  shortcutPreset = $state('Radiant');
  shortcuts = $state<Shortcuts>(preset('Radiant'));

  async setShortcuts(name: string, bindings: Shortcuts): Promise<void> {
    await this.host.setMenuKeys?.(bindings);
    this.shortcuts = bindings;
    this.shortcutPreset = name;
    setSetting('radiant.shortcuts', JSON.stringify({name,bindings}));
  }
  nodeMenu = $state<{x?:number;y?:number} | null>(null);
  /** Notes shown open on the canvas, in the order they were opened, and the one being written. Not saved with the map. */
  openNotes = $state<NodeId[]>([]);
  noteEditing = $state<NodeId | null>(null);
  browsingMaps = $state(false);
  finderReplace = $state(false);
  finder = $state<'search' | 'commands' | null>(null);
  showPrompt = $state(false);
  inspectMapRepairs = $state(false);
  pendingMapRepair = $state.raw<{ id: string; prompt: string } | null>(null);
  sentMapRepairs = $state.raw<string[]>([]);
  generateStudy = $state(false);
  generateStudyShare = $state(35);
  reviewOffer = $state<string | null>(null);
  desktopSession = $state.raw<string[]>([]);
  unfinishedJobNotice = $state('');
  quitPending = $state(false);
  reviewStrength = $state.raw<ReadonlyMap<NodeId, Outcome> | null>(null);
  reviewTimerDeadline = $state(0);
  private reviewTimer = 0;
  isDark = $state(false);
  leanDefault = $state(false);
  copiedStyle = $state.raw<Parameters<typeof setStyle>[2] | null>(null);
  topic = $state('');
  /** Generate grows the selected node; the panel can switch it to a new map instead. */
  generateNewMap = $state(false);
  growFocus = $state('');
  growDepth = $state(2);
  /** The node Generate will grow, or null when it makes a new map. */
  get generateNodeId(): NodeId | null {
    const id = this.focusId;
    return !this.generateNewMap && id && !this.isEmpty && this.doc.nodes[id] ? id : null;
  }
  /** What Generate sends when it grows the selected node. */
  nodeGenerationPrompt() {
    const id = this.generateNodeId;
    return id ? this.expandRequest(id, this.growRequest(id))?.request ?? null : null;
  }
  private growRequest(id: NodeId): GrowRequest {
    return { id, depth: this.growDepth, breadth: this.breadth, focus: this.growFocus.trim() };
  }
  styleText = $state('');
  sourceMaterial = $state('');
  sourceName = $state('');
  sourceTruncated = $state(false);

  setGenerationSource(text: string, name = '', truncated = false): void {
    const bounded = boundSource(text);
    this.sourceMaterial = bounded.text;
    this.sourceName = name;
    this.sourceTruncated = truncated || bounded.truncated;
  }
  audience = $state('');
  generateNotes = $state(false);

  generationPrompt() {
    const request = this.styleText.trim();
    const preset = FIXED_MAP_PRESETS.has(request.toLowerCase()) ? themeFromText(request) : null;
    const theme = preset ? getTheme(preset) : undefined;
    return buildGenerateMapPrompt(this.topic.trim(), { request, branch: theme?.branch, palette: theme?.branchColors }, {
      depth:this.depth, breadth:this.breadth, source:this.sourceMaterial,
      audience:this.audience, withNotes:this.generateNotes
    });
  }
  depth = $state(3);
  breadth = $state(5);
  gen = $state.raw<GenState | null>(null);
  aiQueue = $state.raw<AiQueue | null>(null);
  aiChangeSummary = $state.raw<AiChangeSummary | null>(null);
  private refinementChanges: { job: string; changes: AiChanges } | null = null;
  jobs = $state.raw<AiJobs>({});
  aiStatus = $state.raw<AiStatus | null>(null);
  isBrowser = $state(true);
  toast = $state.raw<{ text: string; kind: 'info' | 'error' } | null>(null);
  dialog = $state.raw<DialogState | null>(null);
  recovery = $state.raw<RecoveredDoc[]>([]);
  stats = $state({ fps: 0, refreshMs: 1000 / 60, cpu: 0, draws: 0, labels: 0, layoutMs: 0, nodes: 0, tris: 0 });
  canUndo = $state(false);
  canRedo = $state(false);

  // ------------------------------------------------------------ plain fields
  readonly host: Host = getHost();
  readonly remindersSync = new RemindersSync(this);
  editor: Editor = new Editor(createDoc());
  camera = new Camera();
  pipeline!: Pipeline;
  renderer!: RenderDevice;
  controller!: CameraController;
  canvasGestures = $state(loadCanvasGestures());

  setCanvasGestures(changes: Partial<CanvasGestures>): void {
    this.canvasGestures = { ...this.canvasGestures, ...changes };
    this.controller?.setGestures(this.canvasGestures);
    saveCanvasGestures(this.canvasGestures);
  }
  canvas!: HTMLCanvasElement;
  textarea!: HTMLTextAreaElement;

  private selSet = new Set<NodeId>();
  private hover: NodeId | null = null;
  /** The node under the pointer, for controls that appear on hover; null while dragging. */
  hoverNode = $state<NodeId | null>(null);
  private editNew = false;
  private queuedInlineEntry = 0;
  private artworkPlacements?: LayoutPlacements;
  private rafId = 0;
  private needLayout = true;
  private layoutWorker: Worker | null = null;
  private layoutWorkerUnavailable = false;
  /**
   * What the layout worker's copy of the document lacks: the document it mirrors, the edits made since the last
   * request (replayed there), and the worker result whose placements the main thread adopted. Null: send it whole.
   */
  private workerDoc: { doc: Doc; ops: Op[]; kept?: { placements?: LayoutPlacements; result: number } } | null = null;
  private layoutSequence = 0;
  private layoutInFlight: number | null = null;
  private layoutReply: { sequence: number; result: AdoptedWork } | null = null;
  private layoutAssembly: LayoutHeader<LayoutWire> | null = null;
  private layoutWaiters = new Set<() => void>();
  private fitAfterLayout = false;
  private revealAfterLayout: { id: NodeId; animate: boolean; center: boolean } | null = null;
  private layoutAnchor: NodeId | null = null;
  private animateLayout = false;
  private animateWorkerMembership = false;
  private settledFrame: LayoutFrame | null = null;
  private motionPreference?: MediaQueryList;
  private layoutAnimation: { start: number; frame: ReturnType<typeof animateLayoutBetween> & {} } | null = null;
  private needScene = true;
  private needOverlay = true;
  private needCanvas = false;
  private drag: DragState | null = null;
  private marquee: Marquee | null = null;
  /** Presentation reveal requested for the next scene (PRS-04). */
  private sceneGrowth: MembershipOptions | null = null;
  private run: AiRun | null = null;
  private pulseTimer = 0;
  private autosaveTimer = 0;
  private pendingWrite: Promise<void> = Promise.resolve();
  private saving = false;
  private toastTimer = 0;
  private statsTimer = 0;
  private frameStamps: number[] = [];
  private lastRenderStats: RenderStats | null = null;
  private spaceCandidate = false;
  private cleanups: Array<() => void> = [];
  failedImages = $state.raw<ReadonlySet<string>>(new Set());
  private loadingImages = new Set<string>();
  private pictureUploads = new Map<NodeId, symbol>();

  get doc(): Doc {
    return this.editor.doc;
  }
  get theme(): Theme {
    void this.rev;
    const settings = this.doc.themeSettings;
    const preset = getTheme(this.doc.themeId, this.darkChrome);
    return { ...preset, ...(this.leanDefault ? { lean: true } : {}), ...settings };
  }
  get busy(): boolean {
    return this.gen !== null;
  }
  get docTitle(): string {
    void this.rev;
    return this.editor.doc.title;
  }
  get isEmpty(): boolean {
    void this.rev;
    return isEmptyDoc(this.editor.doc);
  }
  get zoomPercent(): number {
    void this.camTick;
    const percent = this.camera.zoom * 100;
    return percent < 1 ? Number(percent.toFixed(2)) : Math.round(percent);
  }
  get darkChrome(): boolean {
    void this.rev;
    const mode = this.doc.themeSettings?.canvasAppearance;
    return mode === 'dark' || (mode !== 'light' && this.isDark);
  }

  // ====================================================================== lifecycle

  async init(canvas: HTMLCanvasElement, textarea: HTMLTextAreaElement): Promise<void> {
    // The page awaits this before constructing the controller; awaiting again here costs nothing.
    await initSettings(this.host);
    this.setInterfaceScale(Number(getSetting('radiant.interfaceScale') ?? 1));
    this.canvas = canvas;
    this.textarea = textarea;
    this.isBrowser = this.host.shell === 'browser';
    const onError = () => recordDiagnostic(this.host, 'window_error');
    const onRejection = () => recordDiagnostic(this.host, 'unhandled_rejection');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this.cleanups.push(() => window.removeEventListener('error', onError), () => window.removeEventListener('unhandledrejection', onRejection));
    recordDiagnostic(this.host, 'started');
    try {
      const saved = JSON.parse(getSetting('radiant.shortcuts') ?? 'null');
      if (saved?.bindings) {
        const bindings = preset(saved.name);
        if (saved.name === 'Custom') {
          for (const [id] of shortcutCommands) if (typeof saved.bindings[id] === 'string') bindings[id] = saved.bindings[id];
        }
        await this.setShortcuts(saved.name, bindings);
      }
    } catch (error) { this.say('Could not restore keyboard shortcuts: ' + String(error), 'error'); }
    this.leanDefault = getSetting('radiant.leanDefault') === 'true';
    this.showGeneratedArtwork = getSetting('radiant.generatedArtwork') !== 'hidden';
    try {
      await document.fonts?.ready;
    } catch {
      /* ignore */
    }
    this.pipeline = new Pipeline((text, font, maxWidth) => measureLabel(text, font, maxWidth));
    this.renderer = new Renderer(canvas, {
      onFrame: (stats) => this.onFrame(stats),
      onImageDecodeFailed: (url) => {
        for (const [hash, image] of this.pipeline.imageInfo) {
          if (image.url === url) this.noteImageFailure(hash);
        }
      }
    });
    this.controller = new CameraController(canvas, this.camera, {
      gestures: this.canvasGestures,
      onResize: () => {
        if (this.presenting) this.presentation.onResize();
      },
      onChange: () => {
        this.renderer.setCamera(this.camera);
        this.camTick++;
        this.canvasTools.history.moved(this.camera.getState());
      }
    });
    this.camera.set({ cx: 0, cy: 0, zoom: 1 });
    this.renderer.setCamera(this.camera);

    if (this.host.docCommit) {
      this.editor.setCommitBarrier((change) => this.journalChange(change),
        error => this.say(error instanceof Error ? error.message : String(error), 'error'));
    }
    this.cleanups.push(this.editor.subscribe((c) => this.onChange(c)));
    this.bindInput();
    this.bindHost();

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    this.isDark = mq.matches;
    const onMq = (e: MediaQueryListEvent) => {
      this.isDark = e.matches;
      this.markLayout();
    };
    mq.addEventListener('change', onMq);
    this.cleanups.push(() => mq.removeEventListener('change', onMq));
    const motion = this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateMotion = () => {
      if (motion.matches) this.layoutAnimation = null;
      if (this.gen?.liveGrowth && this.run?.kind === 'expand') this.startPulse();
      this.markOverlay();
    };
    motion.addEventListener('change', updateMotion);
    this.cleanups.push(() => motion.removeEventListener('change', updateMotion));

    this.needLayout = this.needScene = this.needOverlay = true;
    this.select([this.doc.roots[0]]);
    this.flush();
    this.recent = readRecent();
    let lastSnapshot = -1;
    const snapshotTimer = window.setInterval(() => {
      if (this.rev === lastSnapshot || this.isEmpty || !this.rev || this.editor.hasOpenGroup) return;
      const revision = this.rev;
      void addSnapshot(this.documentWithLayout(), 'Automatic snapshot', true, this.editor.historySummary(1).applied[0])
        .then(() => { lastSnapshot=revision; })
        .catch(() => this.say('Automatic snapshot could not be stored.', 'error'));
    }, 15 * 60_000);
    this.cleanups.push(() => clearInterval(snapshotTimer));
    this.ready = true;
    this.agent.listen();
    this.updateUndoState();

    const refreshConnectivity = () => void this.refreshAiStatus();
    window.addEventListener('online', refreshConnectivity);
    window.addEventListener('offline', refreshConnectivity);
    this.cleanups.push(() => {
      window.removeEventListener('online', refreshConnectivity);
      window.removeEventListener('offline', refreshConnectivity);
    });
    void this.refreshAiStatus();
    const timer = window.setInterval(() => void this.refreshAiStatus(), 60_000);
    this.cleanups.push(() => clearInterval(timer));
  }

  destroy(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.layoutWorker?.terminate();
    this.layoutWorker = null;
    for (const settled of this.layoutWaiters) settled();
    this.layoutWaiters.clear();
    this.controller?.destroy();
    this.renderer?.destroy();
    this.canvasTools.destroy();
    this.agent.dispose();
    cancelAnimationFrame(this.rafId);
    clearInterval(this.pulseTimer);
    clearInterval(this.statsTimer);
    clearTimeout(this.autosaveTimer);
    clearTimeout(this.reviewTimer);
    clearTimeout(this.toastTimer);
  }

  private onFrame(s: RenderStats): void {
    this.lastRenderStats = s;
    const now = performance.now();
    this.frameStamps.push(now);
    while (this.frameStamps.length && now - this.frameStamps[0] > 1000) this.frameStamps.shift();
  }

  diagnosticRenderSummary() {
    const cpu = this.lastRenderStats?.cpuMs;
    const cutoff = performance.now() - 1000;
    return {
      renderer: this.renderer ? 'webgl2' as const : 'unavailable' as const,
      lastFrameCpuMs: typeof cpu === 'number' && Number.isFinite(cpu) ? Math.round(cpu * 10) / 10 : null,
      drawsInPreviousSecond: this.frameStamps.filter((stamp) => stamp > cutoff).length,
      layoutEngine: this.pipeline?.lastLayoutSource ?? 'unavailable' as const
    };
  }

  private startStatsTimer(): void {
    clearInterval(this.statsTimer);
    if (!this.showStats) return;
    this.statsTimer = window.setInterval(() => {
      const now = performance.now();
      while (this.frameStamps.length && now - this.frameStamps[0] > 1000) this.frameStamps.shift();
      const s = this.lastRenderStats;
      this.stats = {
        fps: this.frameStamps.length,
        refreshMs: s?.refreshIntervalMs ?? 1000 / 60,
        cpu: s?.cpuMs ?? 0,
        draws: s?.drawCalls ?? 0,
        labels: s?.labelsDrawn ?? 0,
        layoutMs: this.pipeline.lastLayoutMs,
        nodes: this.pipeline.nodeCount,
        tris: s?.meshTriangles ?? 0
      };
    }, 400);
  }

  // ====================================================================== pipeline

  private sceneState(): SceneState {
    return {
      revealArtworkLabels: false,
      selection: this.presenting ? new Set() : this.selSet,
      focus: this.presenting ? null : this.focusId,
      editing: this.editingId,
      hover: this.presenting ? null : this.hover,
      branch: this.canvasBranch,
      present: this.presenting ? this.presentation.sceneScope() : null,
      highlightedWord: !this.presenting && this.canvasFilter?.kind === 'repeated' ? this.canvasFilter.value : undefined,
      matches: this.presenting ? null : this.canvasMatches
    };
  }

  private schedule(): void {
    if (this.rafId || !this.pipeline) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.flush(false);
    });
  }

  /** Bring pipeline and renderer up to date right now. */
  flush(synchronous = true): void {
    if (!this.pipeline) return;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    let prior: LayoutFrame | null = null;
    let animateMembership = false;
    let waitingForLayout = false;
    if (this.needLayout) {
      const theme = this.theme;
      this.pipeline.showGeneratedArtwork = this.showGeneratedArtwork;
      this.pipeline.failedImages = this.failedImages;
      const reply = this.layoutReply;
      this.layoutReply = null;
      const accepted = reply?.sequence === this.layoutSequence;
      if (!accepted && !synchronous && this.requestLargeLayout(theme)) {
        if (!this.layoutAnimation && this.needOverlay && !this.needScene && this.pipeline.doc === this.doc && this.pipeline.hasBase) {
          this.renderer.setScene(this.pipeline.withOverlay(this.sceneState(), this.extraOverlay()));
          this.needOverlay = false;
        }
        if (!this.layoutAnimation) return;
        waitingForLayout = true;
      } else {
        if (this.animateLayout && !this.motionPreference?.matches) prior = this.settledFrame;
        animateMembership = this.animateWorkerMembership;
        this.animateLayout = this.animateWorkerMembership = false;
        this.layoutAnimation = null;
        let preparedScene = false;
        if (accepted) {
          preparedScene = this.pipeline.adoptWork(this.doc, theme, reply.result, this.sceneState());
          if (this.workerDoc) this.workerDoc.kept = { placements: this.pipeline.placements, result: reply.sequence };
        } else {
          this.layoutSequence++;
          this.pipeline.relayout(this.doc, theme, this.layoutAnchor);
        }
        if (this.showGeneratedArtwork) this.artworkPlacements = this.pipeline.placements;
        this.layoutAnchor = null;
        this.needLayout = false;
        this.needScene = !preparedScene;
        this.needOverlay = true;
        this.layoutTick++;
        this.resolveMissingImages();
        for (const settled of this.layoutWaiters) settled();
        this.layoutWaiters.clear();
      }
    }
    if (!waitingForLayout && this.needCanvas && !this.needScene) {
      // Canvas elements only (an element edit or a gesture preview): the scene of the maps is reused.
      if (this.pipeline.refreshCanvas()) this.needOverlay = true;
      else this.needScene = true;
    }
    if (!waitingForLayout && this.needScene) {
      this.pipeline.fullScene(this.sceneState());
      this.needScene = false;
      this.needOverlay = true;
    }
    if (!waitingForLayout) {
      this.needCanvas = false;
      if (this.pipeline.canvas.missing.size) this.resolveMissingImages();
    }
    if (!waitingForLayout && this.needOverlay) {
      const scene = this.pipeline.withOverlay(this.sceneState(), this.extraOverlay());
      const growth = this.sceneGrowth; // presentation reveal: grow from the frame on screen
      this.sceneGrowth = null;
      if (growth) prior = this.settledFrame;
      const branches = this.pipeline.drawnBranchesLater();
      this.settledFrame = {
        scene, layout: this.pipeline.canvasLayout, placements: this.pipeline.placements, get branches() { return branches(); }
      };
      const mode = growth ? 'membership' : this.pipeline.lastLayoutSource === 'main' ? 'all' : animateMembership ? 'membership' : 'pictures';
      const frame = prior && animateLayoutBetween(prior, this.settledFrame, mode, growth ?? undefined);
      if (frame) this.layoutAnimation = { start: performance.now(), frame };
      if (!this.layoutAnimation) this.renderer.setScene(scene);
      this.needOverlay = false;
    }
    if (!waitingForLayout && this.fitAfterLayout) {
      this.fitAfterLayout = false;
      this.zoomFit(false);
    }
    if (!waitingForLayout && this.revealAfterLayout) {
      const { id, animate, center } = this.revealAfterLayout;
      this.revealAfterLayout = null;
      if (center) this.centerOn(id);
      else this.ensureVisible(id, animate);
    }
    if (this.layoutAnimation && this.settledFrame) {
      const progress = (performance.now() - this.layoutAnimation.start) / FOLD_DURATION;
      const final = this.settledFrame.scene;
      if (progress >= 1) {
        this.layoutAnimation = null;
        this.renderer.setScene(final);
      } else {
        const interpolated = this.layoutAnimation.frame(progress);
        this.renderer.setScene({ ...interpolated, overlay: final.overlay, overlayMesh: final.overlayMesh });
        this.schedule();
      }
    }
  }

  private requestLargeLayout(theme: Theme): boolean {
    if (this.layoutWorkerUnavailable || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
    if (this.layoutInFlight !== null) return true;
    const size = Object.keys(this.doc.nodes).length;
    if (size < 1000) return false;
    try {
      if (!this.layoutWorker) this.workerDoc = null;
      const worker = this.layoutWorker ??= new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }: MessageEvent<LayoutResultMessage>) => {
        if (this.layoutInFlight !== data.sequence) return;
        if ('resync' in data) {
          this.workerDoc = null;
          this.layoutInFlight = null;
          if (this.needLayout) this.schedule();
          return;
        }
        if (data.sequence === this.layoutSequence && this.needLayout) {
          if ('header' in data) this.layoutAssembly = data.header;
          else if ('part' in data && data.part && this.layoutAssembly) applyLayoutChunk(this.layoutAssembly, data.part);
          if ('header' in data || ('part' in data && data.part)) {
            const pull: LayoutWorkerRequest = { sequence: data.sequence, pull: true };
            worker.postMessage(pull);
            return;
          }
          if ('result' in data) this.layoutReply = { sequence: data.sequence, result: unpackLayoutResult(data.result) };
          else if (this.layoutAssembly) this.layoutReply = { sequence: data.sequence, result: unpackLayoutResult(this.layoutAssembly.snapshot) };
        }
        this.layoutAssembly = null;
        this.layoutInFlight = null;
        if (this.needLayout) {
          if (this.animateWorkerMembership || (document.hidden && this.layoutWaiters.size)) this.flush(false);
          else this.schedule();
        }
      };
      const fallback = () => {
        worker.terminate();
        this.layoutWorker = null;
        this.layoutWorkerUnavailable = true;
        this.layoutAssembly = null;
        this.layoutInFlight = null;
        recordDiagnostic(this.host, 'layout_worker_fallback');
        this.flush();
      };
      worker.onerror = fallback;
      worker.onmessageerror = fallback;
      const sequence = this.layoutSequence;
      this.layoutInFlight = sequence;
      const replica = this.workerDoc?.doc === this.doc ? this.workerDoc : null;
      const work = this.pipeline.work(this.doc, theme, this.layoutAnchor, this.sceneState(),
        replica ? { ops: replica.ops, nodes: size, kept: replica.kept } : undefined);
      // Once the worker reads this request its copy is current; a whole document cut off mid-stream leaves it unknown.
      this.workerDoc = { doc: this.doc, ops: [], kept: replica?.kept };
      if (replica || size < STREAM_LAYOUT_AT) worker.postMessage({ sequence, work });
      else {
        void (async () => {
          const { header, next } = splitLayoutPayload(work);
          worker.postMessage({ sequence, header });
          for (;;) {
            await layoutTaskTurn();
            if (this.layoutWorker !== worker || this.layoutInFlight !== sequence) return;
            if (!this.needLayout || this.layoutSequence !== sequence) {
              this.layoutInFlight = null;
              this.workerDoc = null;
              if (this.needLayout) this.schedule();
              return;
            }
            const part = next();
            worker.postMessage({ sequence, part });
            if (!part) {
              // Chunks read the live document: an edit made while they were sent may be in them already.
              if (this.workerDoc?.ops.length) this.workerDoc = null;
              return;
            }
          }
        })().catch(fallback);
      }
      return true;
    } catch {
      this.layoutWorker?.terminate();
      this.layoutWorker = null;
      this.layoutWorkerUnavailable = true;
      this.layoutInFlight = null;
      recordDiagnostic(this.host, 'layout_worker_fallback');
      return false;
    }
  }

  documentWithLayout(): Doc {
    this.flush();
    const layoutPlacements = this.showGeneratedArtwork ? this.pipeline?.placements
      : this.artworkPlacements ?? this.doc.layoutPlacements;
    return { ...this.doc, layoutPlacements };
  }

  refreshLayout(): void { this.markLayout(); }

  setShowGeneratedArtwork(visible: boolean): void {
    if (visible && !this.showGeneratedArtwork && this.pipeline) {
      this.pipeline.placements = this.artworkPlacements ?? this.doc.layoutPlacements;
    }
    this.showGeneratedArtwork = visible;
    setSetting('radiant.generatedArtwork', visible ? 'visible' : 'hidden');
    this.markLayout();
  }

  private markLayout(): void {
    this.layoutSequence++;
    this.needLayout = true;
    this.schedule();
  }
  private markScene(): void {
    this.needScene = true;
    this.schedule();
  }
  private markOverlay(): void {
    this.needOverlay = true;
    this.schedule();
  }
  /** Redraw the canvas elements only (CanvasTools uses this for edits and gesture previews). */
  markCanvas(): void {
    this.needCanvas = true;
    this.schedule();
  }

  dismissAiChangeSummary(): void {
    if (!this.aiChangeSummary) return;
    this.aiChangeSummary = null;
    this.markOverlay();
  }

  private showAiChanges(changes: AiChanges, title: string): void {
    const summary = changes.summarize(this.doc, title);
    if (!summary) return;
    this.aiChangeSummary = summary;
    this.markOverlay();
  }

  snapshotBeforeAi(name: string): void {
    if (this.editor.hasOpenGroup) return;
    const document = this.documentWithLayout();
    void storeSnapshot(document.id, serializeDoc(document), name, true,
      this.editor.historySummary(1).applied[0], this.filePath ?? undefined)
      .catch(() => this.say('The pre-change snapshot could not be stored.', 'error'));
  }

  applyAiRefinement(tx: Transaction, job: string): void {
    this.snapshotBeforeAi('Before AI refinement');
    const changes = new AiChanges();
    this.refinementChanges = { job, changes };
    try {
      this.editor.apply(tx);
      this.showAiChanges(changes, tx.label);
    } finally {
      this.refinementChanges = null;
    }
  }

  private onChange(c: EditorChange): void {
    if (this.workerDoc) {
      // Copies: later edits mutate the objects an op carries. A long backlog is cheaper to resend whole.
      if (c.kind === 'load' || !c.edit || c.doc !== this.workerDoc.doc || this.workerDoc.ops.length > 10_000) this.workerDoc = null;
      else this.workerDoc.ops.push(...structuredClone(c.edit.forward));
    }
    if (c.kind === 'undo' || c.kind === 'load') this.dismissAiChangeSummary();
    const aiRun = this.run;
    if (aiRun && c.edit && (c.edit.source === 'user' || c.edit.source.ai !== aiRun.id)) {
      for (const id of c.touched) aiRun.userTouched.add(id);
    }
    if (c.kind === 'apply' && c.edit && c.edit.source !== 'user') {
      const job = c.edit.source.ai;
      if (this.run?.id === job) this.run.changes.record(c.doc, c.edit);
      if (this.refinementChanges?.job === job) this.refinementChanges.changes.record(c.doc, c.edit);
    }
    if (c.kind === 'load') {
      this.sketchTarget = null;
      this.showCanvasFilter = false;
      this.setCanvasFilter(null);
    } else if (this.canvasFilter) {
      this.canvasMatches = matchingCanvasNodes(c.doc, this.canvasFilter);
    }
    if (this.canvasView && (c.kind === 'load' || (this.canvasBranch && !c.doc.nodes[this.canvasBranch]))) {
      this.leaveCanvasView(c.kind !== 'load');
    }
    if (c.kind === 'load') {
      this.queuedInlineEntry = 0;
      this.artworkPlacements = undefined;
      this.revealAfterLayout = null;
      this.animateLayout = this.animateWorkerMembership = false;
      this.layoutAnchor = null;
    } else if (!c.cosmeticOnly && this.pipeline?.doc === c.doc) {
      const previous = this.pipeline.placements?.nodes;
      const fold = [...c.touched].find((id) => previous?.[id] && c.doc.nodes[id]?.children.length &&
        Boolean(previous[id].collapsed) !== Boolean(c.doc.nodes[id].collapsed));
      this.layoutAnchor = fold ?? this.editingId ?? this.focusId;
      const source = c.edit?.source;
      const streamInsert = this.gen?.liveGrowth && this.run && source && source !== 'user' && source.ai === this.run.id &&
        c.edit?.forward.some((op) => op.t === 'insert');
      this.animateWorkerMembership ||= !!fold || !!streamInsert;
      this.animateLayout ||= !!fold || (this.ready && !this.drag?.active && (!this.run || !!streamInsert));
    }
    if (this.pipeline && c.edit?.forward.some((op) => op.t === 'docMeta' && 'layoutPlacements' in op.patch)) {
      this.artworkPlacements = this.pipeline.placements = c.doc.layoutPlacements;
    }
    if (c.kind === 'load') this.pipeline?.cache.invalidateAll();
    else this.pipeline?.cache.invalidateTouched(c.doc, c.touched);
    this.rev++;
    if (!c.cosmeticOnly || c.kind === 'load') this.markLayout();
    else if (c.edit && canvasOnly(c.edit)) this.markCanvas();
    else this.markScene();
    const historyChange = c.kind === 'undo' || c.kind === 'redo';
    // If Undo removes the focused node, follow its parent from the recorded edit.
    const oldFocus = this.focusId;
    if (this.selIds.some((id) => !c.doc.nodes[id]) || (this.focusId && !c.doc.nodes[this.focusId])) {
      const keep = this.selIds.filter((id) => !!c.doc.nodes[id]);
      this.select(keep, this.focusId && c.doc.nodes[this.focusId] ? this.focusId : (keep[keep.length - 1] ?? null));
    }
    if (historyChange && oldFocus) {
      let target = this.focusId;
      if (!target) {
        const removedParents = new Map<NodeId, NodeId | null>();
        for (const op of c.edit?.inverse ?? []) {
          if (op.t === 'insert') removedParents.set(op.node.id, op.parent);
        }
        target = oldFocus;
        while (target && !c.doc.nodes[target]) target = removedParents.get(target) ?? null;
        target ??= this.canvasBranch ?? c.doc.roots[0] ?? null;
      }
      if (target) {
        for (let parent = c.doc.nodes[target]?.parent; parent; parent = c.doc.nodes[parent]?.parent) {
          if (c.doc.nodes[parent].collapsed) target = parent;
        }
        if (target !== this.focusId) this.select([target]);
        this.revealAfterLayout = { id: target, animate: true, center: false };
      }
    }
    if (this.editingId && !c.doc.nodes[this.editingId]) this.editingId = null;
    this.canvasTools.onDocChange();
    this.updateUndoState();
    if (c.kind !== 'load') {
      this.dirty = true;
      if (!c.edit || !this.host.docCommit) this.queueAutosave();
    }
    const streamRoot = aiRun?.targetId ?? aiRun?.applier?.rootId;
    if (streamRoot && !c.doc.nodes[streamRoot] && this.gen?.status !== 'cancelling') void this.cancelAi();
  }

  private updateUndoState(): void {
    this.canUndo = this.editor.canUndo;
    this.canRedo = this.editor.canRedo;
  }

  /** Apply an Edit from the model commands and update the selection. */
  private run_(e: { tx: Transaction; focus?: NodeId | null } | null): boolean {
    if (!e) return false;
    this.editor.apply(e.tx, () => {
      if (e.focus === null) this.select([]);
      else if (e.focus !== undefined) this.select([e.focus]);
    });
    return true;
  }

  private apply(label: string, ops: Transaction['ops']): void {
    this.editor.apply({ ops, label, source: 'user' });
  }

  // ====================================================================== selection

  select(ids: readonly NodeId[], focus?: NodeId | null): void {
    this.selSet = new Set(ids);
    this.selIds = Array.from(this.selSet);
    this.focusId = focus !== undefined ? focus : (ids[ids.length - 1] ?? null);
    if (this.sketchTarget && (this.focusId !== this.sketchTarget || ids.length !== 1)) this.sketchTarget = null;
    this.selTick++;
    this.markOverlay();
  }

  private setHover(id: NodeId | null): void {
    if (id === this.hover) return;
    this.hover = this.hoverNode = id;
    if (this.pipeline.nodeCount > 2500) return; // keep huge maps cheap
    this.markOverlay();
  }

  // ====================================================================== camera helpers

  repeatedWords = $derived.by(() => {
    void this.rev;
    return repeatedWords(this.doc);
  });

  async startWordMap(word: string): Promise<void> {
    const map = createDoc(word);
    map.themeId = this.doc.themeId;
    try {
      const destination = await this.host.pickSavePath(word);
      if (!destination) return;
      await this.host.docCreate(destination, serializeDoc(map));
      await this.openDoc(destination);
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  setCanvasFilter(filter: CanvasFilter | null): void {
    if (!filter && !this.canvasFilter) return;
    this.canvasFilter = filter;
    this.canvasMatches = filter ? matchingCanvasNodes(this.doc, filter) : null;
    this.markScene();
  }

  get canvasBranch(): NodeId | null {
    const view = this.canvasView;
    return view?.kind === 'focus' ? view.root : null;
  }

  get presenting(): boolean {
    return this.canvasView?.kind === 'presentation';
  }

  private fitCanvasBranch(): void {
    this.markScene();
    this.flush();
    const bounds = this.pipeline.canvasLayout.bounds;
    if (bounds.w > 0 && bounds.h > 0) this.fitRect(bounds, 2);
  }

  private focusBranch(): void {
    if (this.canvasView?.kind === 'focus') {
      this.leaveCanvasView();
      return;
    }
    this.endEdit();
    this.flush();
    if (!this.focusId || !this.pipeline.box(this.focusId)) {
      this.say('Select a visible branch to focus on.', 'info');
      return;
    }
    this.canvasView = { kind: 'focus', root: this.focusId, previous: this.camera.getState() };
    this.select([this.focusId]);
    this.fitCanvasBranch();
  }

  leaveCanvasView(restore = true): void {
    const previous = this.canvasView?.previous;
    if (!previous) return;
    this.presentation.stop();
    this.canvasView = null;
    this.markScene();
    if (restore) {
      this.camera.set(previous);
      this.flush();
    }
  }

  /** Screen insets covered by floating panels. */
  insets(): { l: number; r: number; t: number; b: number } {
    const app = this.canvas?.closest('.app');
    const bounds = (selector: string) => app?.querySelector(selector)?.getBoundingClientRect();
    const controls = bounds('.view-bar');
    if (this.presenting) return { l: 0, r: 0, t: 0, b: controls ? this.camera.height - controls.top + 8 : 36 };
    const l = this.showOutline ? bounds('.side.left')?.width ?? 264 * this.interfaceScale : 0;
    const r = this.showInspector ? bounds('.side.right')?.width ?? 296 * this.interfaceScale : 0;
    const t = Math.max(this.topBarHeight * this.interfaceScale + 8, controls ? controls.bottom + 8 : 0);
    const b = this.statusBarHeight * this.interfaceScale + 4;
    return { l, r, t, b };
  }

  fitRect(rect: Rect, maxZoom: number, animate = true, pad = 48): void {
    const ins = this.insets();
    const w = Math.max(100, this.camera.width - ins.l - ins.r);
    const h = Math.max(100, this.camera.height - ins.t - ins.b);
    const s = Camera.fitState(rect, w, h, pad, maxZoom);
    // shift so the rect centres in the free area
    s.cx -= (ins.l - ins.r) / 2 / s.zoom;
    s.cy -= (ins.t - ins.b) / 2 / s.zoom;
    if (animate) void this.camera.animateTo(s, 350);
    else this.camera.set(s);
  }

  zoomFit(animate = true): void {
    this.flush();
    // CNV-01: every map and every canvas element, unless a branch is in focus.
    const all = this.canvasView ? null : this.canvasTools.everything();
    if (all) return this.fitRect(all, 1.5, animate);
    if (!this.pipeline.canvasLayout.boxes.size) return;
    this.fitRect(this.pipeline.canvasLayout.bounds, 1.5, animate);
  }

  zoomSelection(): void {
    this.flush();
    const r = this.canvasTools.selectionRect(this.boundsOf(this.selIds));
    if (r) this.fitRect(r, 2);
    else this.zoomFit();
  }

  /** Bring nodes into view without changing the document: fit them, or centre on them at the current zoom. */
  showNodes(ids: readonly NodeId[], mode: 'fit' | 'centre' = 'fit'): boolean {
    this.flush();
    const bounds = this.boundsOf(ids);
    if (!bounds) return false;
    if (mode === 'fit') {
      this.fitRect(bounds, 2);
      return true;
    }
    const { zoom } = this.camera.getState();
    const { l, r, t, b } = this.insets();
    void this.camera.animateTo({
      cx: bounds.x + bounds.w / 2 - (l - r) / (2 * zoom),
      cy: bounds.y + bounds.h / 2 - (t - b) / (2 * zoom),
      zoom,
    }, 350);
    return true;
  }

  centreSelection(): void {
    this.flush();
    const bounds = this.boundsOf(this.selIds);
    if (!bounds) return;
    const { zoom } = this.camera.getState();
    const { l, r, t, b } = this.insets();
    void this.camera.animateTo({
      cx: bounds.x + bounds.w / 2 - (l - r) / (2 * zoom),
      cy: bounds.y + bounds.h / 2 - (t - b) / (2 * zoom),
      zoom,
    }, 350);
  }

  private async tidy(selection: readonly NodeId[]): Promise<void> {
    this.endEdit();
    const doc = this.doc;
    const scope = selection.length
      ? [...new Set(selection.flatMap((id) => subtreeIds(doc, id)))]
      : Object.keys(doc.nodes);
    if (!scope.length) return;
    const choice = await this.ask(
      'Tidy layout',
      (selection.length ? 'Rearrange the selected branches.' : 'Rearrange the whole map.') +
        ' You can keep manual offsets or clear them. Absolute pins stay in place.',
      [
        { id: 'keep', label: 'Keep offsets', primary: true },
        { id: 'clear', label: 'Clear offsets' },
        { id: 'cancel', label: 'Cancel' },
      ],
    );
    if (choice === 'cancel' || this.doc !== doc || !(await this.editor.settled()) || this.doc !== doc) return;
    this.flush();
    const previous = this.pipeline.placements;
    if (!previous) return;
    const roots = { ...previous.roots };
    const nodes = { ...previous.nodes };
    const model = { ...doc.nodes };
    const ops: Transaction['ops'] = [];
    for (const id of scope) {
      const node = doc.nodes[id];
      if (!node) continue;
      if (node.parent === null) delete roots[id];
      delete nodes[id];
      if (choice === 'clear' && node.offset) {
        model[id] = { ...node, offset: undefined };
        ops.push({ t: 'set', id, patch: { offset: undefined } });
      }
    }
    const next = this.pipeline.tidyPlacements({ ...doc, nodes: model }, { roots, nodes });
    doc.layoutPlacements = previous;
    ops.push({ t: 'docMeta', patch: { layoutPlacements: next } });
    this.apply('Tidy Layout', ops);
  }

  /**
   * One step, no questions: forget hand-made positions in scope and lay it out again. A scope that holds a main
   * node rebuilds that whole map, which also rebalances the two sides of a mind map. Pins and declared sides stay.
   */
  private arrange(selection: readonly NodeId[]): void {
    this.endEdit();
    this.flush();
    const doc = this.doc;
    const previous = this.pipeline.placements;
    if (!previous) return;
    const tops = selection.length ? this.topLevelSelection(selection) : doc.roots;
    const roots = { ...previous.roots };
    const nodes = { ...previous.nodes };
    const model = { ...doc.nodes };
    const ops: Transaction['ops'] = [];
    for (const top of tops) {
      for (const id of subtreeIds(doc, top)) {
        const node = doc.nodes[id];
        if (node.parent === null) delete roots[id];
        delete nodes[id];
        if (node.offset) {
          model[id] = { ...node, offset: undefined };
          ops.push({ t: 'set', id, patch: { offset: undefined } });
        }
      }
    }
    const next = this.pipeline.tidyPlacements({ ...doc, nodes: model }, { roots, nodes });
    if (!ops.length && JSON.stringify(next) === JSON.stringify(previous)) {
      this.say('Already arranged.', 'info');
      return;
    }
    doc.layoutPlacements = previous;
    ops.push({ t: 'docMeta', patch: { layoutPlacements: next } });
    this.apply('Arrange', ops);
  }

  private balance(id: NodeId | null): void {
    if (!id) return;
    const root = rootOf(this.doc, id);
    if (this.doc.rootInfo[root].layout !== 'mindmap') return;
    this.flush();
    const previous = this.pipeline.placements;
    if (!previous) return;
    const roots = { ...previous.roots };
    delete roots[root];
    const next = this.pipeline.tidyPlacements(this.doc, { ...previous, roots });
    this.doc.layoutPlacements = previous;
    this.apply('Balance Main Node', [{ t: 'docMeta', patch: { layoutPlacements: next } }]);
  }

  private varyOrganicLayout(): void {
    if (!this.doc.roots.some((id) => this.doc.rootInfo[id].organic && !isCollectionLayout(this.doc.rootInfo[id].layout))) return;
    this.flush();
    const previous = this.pipeline.placements;
    if (!previous) return;
    const seed = new Uint32Array(1);
    do crypto.getRandomValues(seed);
    while (seed[0] === (this.doc.seed >>> 0));
    const next = this.pipeline.tidyPlacements({ ...this.doc, seed: seed[0] }, previous);
    this.doc.layoutPlacements = previous;
    this.apply('New Organic Variation', [{ t: 'docMeta', patch: { seed: seed[0], layoutPlacements: next } }]);
  }

  private selectSameLevel(id: NodeId): void {
    let level = 0;
    for (let parent = this.doc.nodes[id].parent; parent; parent = this.doc.nodes[parent].parent) level++;
    let ids = this.doc.roots;
    for (let depth = 0; depth < level; depth++) ids = ids.flatMap((node) => this.doc.nodes[node].children);
    this.select(ids, id);
  }

  private boundsOf(ids: readonly NodeId[]): Rect | null {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const id of ids) {
      const b = this.pipeline.box(id);
      if (!b) continue;
      x0 = Math.min(x0, b.x - b.w / 2);
      y0 = Math.min(y0, b.y - b.h / 2);
      x1 = Math.max(x1, b.x + b.w / 2);
      y1 = Math.max(y1, b.y + b.h / 2);
    }
    return x0 === Infinity ? null : { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }

  zoomBy(factor: number): void {
    const s = this.camera.getState();
    void this.camera.animateTo({ ...s, zoom: s.zoom * factor }, 180);
  }

  /** Pan (animated) so the node is comfortably inside the free viewport area. */
  ensureVisible(id: NodeId, animate = true): void {
    this.flush(false);
    if (this.needLayout) {
      this.revealAfterLayout = { id, animate, center: false };
      return;
    }
    const b = this.pipeline.box(id);
    if (!b) return;
    const cam = this.camera;
    const ins = this.insets();
    const m = 56;
    const left = (b.x - b.w / 2 - cam.cx) * cam.zoom + cam.width / 2;
    const right = (b.x + b.w / 2 - cam.cx) * cam.zoom + cam.width / 2;
    const top = (b.y - b.h / 2 - cam.cy) * cam.zoom + cam.height / 2;
    const bottom = (b.y + b.h / 2 - cam.cy) * cam.zoom + cam.height / 2;
    let dx = 0,
      dy = 0;
    if (left < ins.l + m) dx = ins.l + m - left;
    else if (right > cam.width - ins.r - m) dx = cam.width - ins.r - m - right;
    if (top < ins.t + m) dy = ins.t + m - top;
    else if (bottom > cam.height - ins.b - m) dy = cam.height - ins.b - m - bottom;
    if (dx === 0 && dy === 0) return;
    const target = { cx: cam.cx - dx / cam.zoom, cy: cam.cy - dy / cam.zoom, zoom: cam.zoom };
    if (animate) void cam.animateTo(target, 260);
    else cam.set(target);
  }

  centerOn(id: NodeId): void {
    this.flush(false);
    if (this.needLayout) {
      this.revealAfterLayout = { id, animate: true, center: true };
      return;
    }
    const b = this.pipeline.box(id);
    if (!b) return;
    const ins = this.insets();
    const z = Math.max(this.camera.zoom, 0.6);
    void this.camera.animateTo(
      { cx: b.x - (ins.l - ins.r) / 2 / z, cy: b.y - (ins.t - ins.b) / 2 / z, zoom: z },
      300
    );
  }

  private clientToWorld(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    return this.camera.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
  }

  // ====================================================================== editing (inline text)

  startEdit(id: NodeId, mode: 'keep' | 'replace' | 'new' = 'keep'): void {
    const node = this.doc.nodes[id];
    if (!node) return;
    if (this.editingId && this.editingId !== id) this.endEdit();
    const folded: NodeId[] = [];
    for (let parent = node.parent; parent; parent = this.doc.nodes[parent]?.parent ?? null) {
      if (this.doc.nodes[parent]?.collapsed) folded.push(parent);
    }
    if (folded.length) {
      const edit = toggleCollapsed(this.doc, folded, false);
      if (edit) this.editor.apply(edit.tx);
    }
    this.editNew = mode === 'new';
    if (mode === 'replace' && node.text !== '') {
      const e = setText(this.doc, id, '');
      if (e) this.editor.apply(e.tx);
    }
    this.textarea.value = mode === 'replace' ? '' : node.text;
    this.editingId = id;
    if (!this.selSet.has(id) || this.selSet.size !== 1) this.select([id]);
    this.markScene();
    this.ensureVisible(id);
    const ta = this.textarea;
    ta.focus({ preventScroll: true });
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
  }

  onEditInput(): void {
    const id = this.editingId;
    if (!id) return;
    this.setNodeText(id, this.textarea.value);
    this.ensureVisible(id, false);
  }

  setNodeText(id: NodeId, text: string): void {
    if (this.editor.defer(() => this.setNodeText(id, text))) return;
    const edit = setText(this.doc, id, text);
    if (edit) this.editor.apply(edit.tx);
  }

  endEdit(keepEmpty = false): void {
    const id = this.editingId;
    if (!id) return;
    this.editingId = null;
    const wasNew = this.editNew && !keepEmpty;
    this.editNew = false;
    if (document.activeElement === this.textarea) this.textarea.blur();
    const cleanupEmpty = () => {
      const node = this.doc.nodes[id];
      if (wasNew && node?.text === '' && !node.children.length && /^Add (Child|Sibling)$/.test(this.editor.undoLabel ?? '')) {
        this.editor.undo();
        this.select(node.parent ? [node.parent] : []);
      }
    };
    if (wasNew && !this.editor.defer(cleanupEmpty)) cleanupEmpty();
    this.markScene();
    this.flush(false);
  }

  /** Geometry of the inline editor in canvas coordinates; null when not editing. */
  editStyle(): string {
    void this.layoutTick;
    void this.camTick;
    const id = this.editingId;
    const hidden = 'opacity:0;pointer-events:none;left:-9999px;top:0;width:10px;height:10px;';
    if (!id || !this.pipeline) return hidden;
    const b = this.pipeline.box(id);
    const node = this.doc.nodes[id];
    if (!b || !node) return hidden;
    const theme = this.theme;
    const st = createStyleResolver(this.doc, theme).get(id, b.depth, b.mainBranch);
    const pad = nodePadding(b.depth, st.shape, theme, node.style?.branchWidth);
    const shift = this.pipeline.labelShift(id);
    const z = this.camera.zoom;
    const cam = this.camera;
    const x0 = b.x - b.w / 2 + pad.l;
    const innerW = b.w - pad.l - pad.r;
    const top = b.y - b.h / 2 + pad.t + this.pipeline.labelEditorOffset(id);
    const textH = Math.max(st.font.size * 1.25, b.h - pad.t - pad.b - shift * 2);
    const sx = (x0 - cam.cx) * z + cam.width / 2;
    const sy = (top - cam.cy) * z + cam.height / 2;
    const underlineLike = st.shape === 'underline' || (st.shape === 'none' && b.depth > 0);
    const align = st.alignment ?? (underlineLike && b.flow === 'h' ? (b.side === 1 || b.side === 0 ? 'left' : 'right') : 'center');
    const slack = 10;
    const left = align === 'left' ? sx : align === 'right' ? sx - slack : sx - slack / 2;
    const upper = treeThemes(this.doc,theme)(id).uppercaseMainBranches && b.depth === 1;
    return (
      `left:${left}px;top:${sy}px;width:${innerW * z + slack}px;height:${textH * z}px;` +
      `font-size:${st.font.size * z}px;font-family:${st.font.family};font-weight:${st.font.bold ? 700 : 400};` +
      `font-style:${st.font.italic ? 'italic' : 'normal'};color:${st.textColor};text-align:${align};` +
      `text-transform:${upper ? 'uppercase' : 'none'};opacity:1;`
    );
  }

  // ====================================================================== commands: structure

  addChildOf(id?: NodeId | null): void {
    if (!this.editor.waitingForCommit) this.endEdit();
    if (this.deferInlineEntry(() => this.addChildOf(id))) return;
    const target = (id === undefined ? this.focusId : id) ?? this.doc.roots[0];
    if (!target) return;
    const e = addChild(this.doc, target);
    if (e) {
      this.editor.apply(e.tx);
      this.select([e.focus as NodeId]);
      this.startEdit(e.focus as NodeId, 'new');
    }
  }

  addSiblingOf(after: boolean, position?:Vec2): void {
    if (!this.editor.waitingForCommit) this.endEdit();
    if (this.deferInlineEntry(() => this.addSiblingOf(after, position))) return;
    const id = this.focusId;
    if (!id) return this.addChildOf(null);
    const e = addSibling(this.doc, id, after, this.doc.nodes[id].parent === null ? position ?? this.nextFreePosition() : undefined);
    if (e) {
      this.editor.apply(e.tx);
      this.select([e.focus as NodeId]);
      this.startEdit(e.focus as NodeId, 'new');
    }
  }

  deleteSelection(promote = false, selection: readonly NodeId[] = this.selIds): void {
    if (this.editor.defer(() => this.deleteSelection(promote, selection))) return;
    const ids = selection.filter(id => this.doc.nodes[id]);
    if (!promote && this.canvasTools.selected.length && this.canvasTools.deleteSelection(ids)) return;
    if (!ids.length) return;
    const e = promote ? deleteAndPromote(this.doc, ids, id => this.pipeline.box(id)) : deleteSubtree(this.doc, ids);
    if (e && !promote) e.tx = this.canvasTools.keepDrawnEnds(e.tx, ids);
    if (!e) {
      this.say('A map needs at least one main node, so the last one stays.', 'info');
      return;
    }
    this.run_(e);
    if (this.focusId) this.ensureVisible(this.focusId);
  }

  outdent(id: NodeId | null = this.focusId): void {
    if (this.editor.defer(() => this.outdent(id))) return;
    if (!id) return;
    const p = parentOf(this.doc, id);
    if (!p) return;
    const g = parentOf(this.doc, p);
    if (!g) return;
    const idx = this.doc.nodes[g].children.indexOf(p) + 1;
    this.run_(moveSubtree(this.doc, id, g, idx));
    this.ensureVisible(id);
  }

  reorderFocus(delta: number, id: NodeId | null = this.focusId): void {
    if (this.editor.defer(() => this.reorderFocus(delta, id))) return;
    if (!id || !this.doc.nodes[id]) return;
    this.run_(reorder(this.doc, id, delta));
    this.ensureVisible(id);
  }

  foldToLevel(depth:number): void {
    if (this.foldLevelFor && Number.isSafeInteger(depth) && depth>=0)
      this.run_(collapseToDepth(this.doc,this.foldLevelFor,depth));
    this.foldLevelFor=null;
  }

  toggleFold(selection: readonly NodeId[] = this.selIds): void {
    if (this.editor.defer(() => this.toggleFold(selection))) return;
    if (!selection.length) return;
    this.run_(toggleCollapsed(this.doc, selection));
  }

  toggleFoldOf(id: NodeId): void {
    if (this.editor.defer(() => this.toggleFoldOf(id))) return;
    this.run_(toggleCollapsed(this.doc, [id]));
  }

  setNoteOf(id: NodeId, note: string): void {
    if (this.editor.defer(() => this.setNoteOf(id, note))) return;
    this.run_(setNote(this.doc, id, note));
  }

  /** Open or close a node's note on the canvas. `edit` opens it for writing, which is also how a first note starts. */
  toggleNote(id: NodeId, edit = false): void {
    const open = this.openNotes.includes(id);
    if (open && !edit) { this.closeNote(id); return; }
    if (!open) this.openNotes = [...this.openNotes, id];
    if (edit) this.noteEditing = id;
  }

  closeNote(id: NodeId): void {
    this.openNotes = this.openNotes.filter((open) => open !== id);
    if (this.noteEditing === id) this.noteEditing = null;
  }

  styleSelection(patch: Parameters<typeof setStyle>[2]): void {
    if (!this.selIds.length) return;
    this.run_(setStyle(this.doc, this.selIds, patch));
  }

  setLeanDefault(enabled: boolean): void {
    this.leanDefault = enabled;
    setSetting('radiant.leanDefault', String(enabled));
    this.markLayout();
  }

  copySelectedStyle(): void {
    const node = this.focusId ? this.doc.nodes[this.focusId] : undefined;
    if (node) this.copiedStyle = { ...node.style };
  }

  pasteSelectedStyle(): void {
    const style = this.copiedStyle;
    if (!style || !this.selIds.length) return;
    this.apply('Paste Node Style', this.selIds.map((id) => ({ t: 'set', id, patch: { style } })));
  }

  setRootLayout(rootId: NodeId, layout: LayoutKind): void {
    const info = this.doc.rootInfo[rootId];
    if (!info || info.layout === layout) return;
    this.apply('Change Layout', [{ t: 'setRoot', id: rootId, info: { ...info, layout } }]);
  }

  setTheme(id: string): void {
    if (this.doc.themeId === id) return;
    this.apply('Change Theme', [{ t: 'docMeta', patch: { themeId: id, themeSettings:undefined } }]);
  }

  setTitle(title: string): void {
    if (this.editor.defer(() => this.setTitle(title))) return;
    const t = title.trim();
    if (!t || t === this.doc.title) return;
    this.apply('Rename Map', [{ t: 'docMeta', patch: { title: t } }]);
  }

  nextLayout(focus: NodeId | null = this.focusId): void {
    const root = focus ? rootOf(this.doc, focus) : this.doc.roots[0];
    if (!root) return;
    const cur = this.doc.rootInfo[root]?.layout ?? 'mindmap';
    this.setRootLayout(root, LAYOUTS[(LAYOUTS.indexOf(cur) + 1) % LAYOUTS.length]);
  }

  nextTheme(): void {
    const all = listThemes();
    const i = all.findIndex((t) => t.id === this.doc.themeId);
    this.setTheme(all[(i + 1) % all.length].id);
  }

  createFloating(at: Vec2): void {
    if (this.editor.defer(() => this.createFloating(at))) return;
    const id = newId();
    this.apply('Add Node', [
      {
        t: 'insert',
        node: { id, parent: null, children: [], text: '', origin: { by: 'user' } },
        parent: null,
        index: this.doc.roots.length,
        rootInfo: { position: { x: at.x, y: at.y }, layout: 'mindmap' }
      }
    ]);
    this.select([id]);
    this.startEdit(id, 'new');
  }

  selectAll(): void {
    this.flush();
    this.select(Array.from(this.pipeline.canvasLayout.boxes.keys()), this.focusId);
  }

  // ====================================================================== navigation

  navigate(dir: Direction): void {
    const id = this.focusId ?? this.canvasBranch ?? this.doc.roots[0];
    if (!id) return;
    if (!this.focusId) {
      this.select([id]);
      this.ensureVisible(id);
      return;
    }
    this.flush();
    const doc = this.doc;
    const box = this.pipeline.box(id);
    if (!box) return;
    const node = doc.nodes[id];
    const parent = parentOf(doc, id);
    let target: NodeId | null = null;

    const siblingOnSide = (forward: boolean): NodeId | null => {
      let s: NodeId | null = forward ? nextSibling(doc, id) : prevSibling(doc, id);
      while (s) {
        const sb = this.pipeline.box(s);
        if (sb && sb.side === box.side) return s;
        s = forward ? nextSibling(doc, s) : prevSibling(doc, s);
      }
      return null;
    };
    const expandIfCollapsed = (): boolean => {
      if (node.collapsed && node.children.length) {
        this.run_(toggleCollapsed(doc, [id], false));
        return true;
      }
      return false;
    };

    const root = rootOf(doc, id);
    const rootKind = doc.rootInfo[root]?.layout;
    const mainChildren = doc.nodes[root].children;
    const kindFor = (branch: number) => doc.nodes[mainChildren[branch]]?.branchLayout ?? rootKind;
    if (kindFor(box.mainBranch) === 'outline') {
      if (dir === 'left') target = parent;
      else if (dir === 'right') {
        if (expandIfCollapsed()) return;
        target = node.children[0] ?? null;
      } else {
        let distance = Infinity;
        for (const row of this.pipeline.canvasLayout.boxes.values()) {
          if (kindFor(row.mainBranch) !== 'outline' || (row.mainBranch !== box.mainBranch && rootKind !== 'outline')) continue;
          const delta = (row.y - box.y) * (dir === 'down' ? 1 : -1);
          if (delta > 0 && delta < distance) {
            distance = delta;
            target = row.id;
          }
        }
      }
    } else if (box.flow === 'v') {
      const outward = box.side === -1 ? 'up' : 'down';
      if (dir === (outward === 'up' ? 'down' : 'up')) target = parent;
      else if (dir === outward) {
        if (expandIfCollapsed()) return;
        target = node.children[0] ?? null;
      } else target = dir === 'right' ? nextSibling(doc, id) : prevSibling(doc, id);
    } else if (box.flow === 'h') {
      if (dir === 'up' || dir === 'down') {
        target = parent ? siblingOnSide(dir === 'down') : null;
      } else {
        const want = dir === 'right' ? 1 : -1;
        if (box.depth === 0) {
          if (node.collapsed && expandIfCollapsed()) return;
          target = node.children.find((child) => {
            const childBox = this.pipeline.box(child);
            return childBox?.flow === 'h' && childBox.side === want;
          }) ?? null;
        } else if (box.side === want) {
          if (expandIfCollapsed()) return;
          target = node.children[0] ?? null;
        } else target = parent;
      }
    }
    if (!target || !this.pipeline.canvasLayout.boxes.has(target)) {
      target = this.pipeline.canvasSpatial.nearestInDirection(id, dir);
    }
    if (target) {
      this.select([target]);
      this.ensureVisible(target);
    }
  }

  // ====================================================================== commands from menu / shortcuts

  async setSelectedRepresentation(mode:Representation|undefined, depth=Infinity): Promise<void> {
    if (this.dialog) return;
    const doc = this.doc;
    const selected=new Set(this.selIds);
    const covered=new Set<NodeId>(selected);
    if(mode && Number.isFinite(depth) && selected.size>1) {
      for(const id of selected)for(const node of artSubtree(this.doc,id,depth))covered.add(node.id);
    }
    type SetNode = Extract<Transaction['ops'][number], { t: 'set' }>;
    const boundary=new Map<NodeId,SetNode>();
    const roots:SetNode[]=[];
    for (const id of selected) {
      const ops=mode ? setArtRepresentation(this.doc,id,mode,depth) :
        [{t:'set' as const,id,patch:{representation:undefined}}];
      for(const op of ops) {
        if(op.t!=='set')continue;
        if(op.id===id)roots.push(op);
        else if(!covered.has(op.id))boundary.set(op.id,op);
      }
    }
    const plan = planArtNesting(doc, [...boundary.values(), ...roots], selected);
    if ('error' in plan) { this.say(plan.error, 'error'); return; }
    if (plan.islands) {
      const revision = this.rev;
      if (await confirmArtIslands(this, plan.islands) !== 'island') return;
      if (this.doc !== doc || this.rev !== revision) return;
    }
    if (plan.changes.length) this.apply('Change Subtree Representation', plan.changes);
  }

  async command(id: MenuId, intent?: { focus: NodeId | null; selection: readonly NodeId[] }): Promise<void> {
    if (!intent && (this.dialog || (this.presenting && id !== 'present-branches'))) return;
    const target = intent ?? { focus: this.focusId, selection: this.selIds };
    const focus = target.focus && this.doc.nodes[target.focus] ? target.focus : null;
    const selection = intent ? target.selection.filter(node => this.doc.nodes[node]) : target.selection;
    const presentationCommand: string = id; // not yet in the host's MenuId (PRS-21)
    if (presentationCommand === 'present-from-here') return this.presentation.start({ from: focus });
    if (presentationCommand === 'presentations') return this.presentation.openPanel();
    switch (id) {
      case 'detach': case 'fold-alt': case 'fold-siblings': case 'unfold-one': case 'unfold-all':
      case 'new-main': case 'task': case 'connect': case 'add-parent': case 'duplicate': case 'create-alias':
      case 'reset-branch-offsets': case 'reset-map-offsets':
      case 'pin-position': case 'reset-offset': case 'sort-tasks': case 'sort-children': case 'collapse-toggle':
      case 'next-layout': case 'next-theme': case 'balance': case 'new-variation': case 'arrange':
        if (this.editor.defer(() => { void this.command(id, target); })) return;
    }
    switch (id) {
      case 'detach':
        if (focus && this.doc.nodes[focus].parent) this.run_(detach(this.doc,focus,this.nextFreePosition()));
        return;
      case 'fold-alt': this.toggleFold(selection); return;
      case 'fold-siblings': {
        const node=focus && this.doc.nodes[focus];
        if (node) this.run_(toggleCollapsed(this.doc,node.parent ? this.doc.nodes[node.parent].children : this.doc.roots,true));
        return;
      }
      case 'unfold-one':
        if (focus) this.run_(unfoldOneLevel(this.doc,focus));
        return;
      case 'unfold-all':
        if (focus) this.run_(expandAll(this.doc,focus));
        return;
      case 'fold-level':
        this.foldLevelFor=focus;
        return;
      case 'add-sibling': this.addSiblingOf(true); return;
      case 'sibling-before':
      case 'sibling-above': this.addSiblingOf(false); return;
      case 'new-main': {
        const root = focus ? rootOf(this.doc,focus) : this.doc.roots[0];
        if (root) this.select([root]);
        this.addSiblingOf(true,{x:this.camera.cx,y:this.camera.cy});
        return;
      }
      case 'outdent': this.outdent(); return;
      case 'delete':
      case 'delete-forward': this.deleteSelection(); return;
      case 'promote':
      case 'promote-forward': this.deleteSelection(true); return;
      case 'edit-label':
      case 'edit-label-alt': if (this.focusId) this.startEdit(this.focusId,'keep'); return;
      case 'select-all': this.selectAll(); return;
      case 'move-up': this.reorderFocus(-1); return;
      case 'move-down': this.reorderFocus(1); return;
      case 'nav-up':
      case 'nav-left':
      case 'nav-right':
      case 'nav-down': this.navigate(id.slice(4) as Direction); return;
      case 'art-visibility': this.setShowGeneratedArtwork(!this.showGeneratedArtwork); return;
      case 'edit-link':
      case 'edit-note':
        if (!this.focusId) { this.say('Select a node first.'); return; }
        this.endEdit();
        this.showInspector = true;
        requestAnimationFrame(() => document.getElementById(id === 'edit-link' ? 'node-link' : 'note-field')?.focus());
        return;
      case 'connect':
        if (selection.length===2) this.run_(addLink(this.doc,selection[0],selection[1]));
        else if (focus) {this.linkFrom=focus;this.say('Click another node, or use the arrow keys and press Enter. Escape cancels.','info');}
        return;
      case 'task':
        this.apply('Toggle task',selection.map(id=>({t:'set',id,patch:{task:this.doc.nodes[id].task?undefined:{done:false}}})));
        return;
      case 'add-child':
        this.addChildOf();
        return;
      case 'add-parent':
        if (focus) {
          const edit = addParent(this.doc, focus);
          if (edit && this.run_(edit) && edit.focus) this.startEdit(edit.focus, 'new');
        }
        return;
      case 'create-alias':
        if (focus) this.run_(createAlias(this.doc, focus, selection.length === 2 ? selection.find(id => id !== focus) : undefined));
        return;
      case 'duplicate':
        if(selection.length) {
          const doc=this.doc;
          const roots=this.topLevelSelection(selection);
          const added=new Map<NodeId|null,number[]>();
          const {ops,created}=insertBranches(copyBranches(doc,roots),(root)=>{
            const parent=doc.nodes[root].parent;
            const previous=(parent ? doc.nodes[parent].children : doc.roots).indexOf(root);
            const already=added.get(parent) ?? [];
            const index=previous+1+already.filter(position=>position<=previous).length;
            already.push(previous);added.set(parent,already);
            const info=doc.rootInfo[root];
            return {parent,index,rootInfo:info && {...info,position:{x:info.position.x+40,y:info.position.y+40}}};
          });
          this.apply('Duplicate branches',ops);
          this.select(created);
        }
        return;
      case 'select-subtree':
        if(this.focusId)this.select(subtreeIds(this.doc,this.focusId),this.focusId);
        return;
      case 'select-siblings':
        if(this.focusId){const parent=this.doc.nodes[this.focusId].parent;this.select(parent?this.doc.nodes[parent].children:this.doc.roots,this.focusId);}
        return;
      case 'select-level':
        if (focus) this.selectSameLevel(focus);
        return;
      case 'tidy-layout':
        if (selection.length) return this.tidy(selection);
        return;
      case 'tidy-map':
        return this.tidy([]);
      case 'arrange':
        this.arrange(selection);
        return;
      case 'balance':
        this.balance(focus);
        return;
      case 'new-variation':
        this.varyOrganicLayout();
        return;
      case 'pin-position': {
        this.flush();
        const ids = selection.filter((node) => this.doc.nodes[node].parent !== null && this.pipeline.box(node));
        const pinned = ids.length > 0 && ids.every((node) => this.doc.nodes[node].pinnedPosition);
        if (ids.length) this.apply(pinned ? 'Unpin Node Positions' : 'Pin Node Positions', ids.map((node) => {
          const { x, y } = this.pipeline.box(node)!;
          return { t: 'set', id: node, patch: { pinnedPosition: pinned ? undefined : { x, y } } };
        }));
        return;
      }
      case 'reset-offset':
        this.run_(clearOffset(this.doc, selection));
        return;
      case 'reset-branch-offsets': {
        const ids = this.topLevelSelection(selection).flatMap(root => subtreeIds(this.doc, root));
        this.run_(clearOffset(this.doc, ids));
        return;
      }
      case 'reset-map-offsets':
        this.run_(clearOffset(this.doc, Object.keys(this.doc.nodes)));
        return;
      case 'sort-tasks':
      case 'sort-children':
        if(focus){
          const parent=focus;
          const ids=this.doc.nodes[parent].children;
          const rank=(id:NodeId)=>this.doc.nodes[id].task ? this.doc.nodes[id].task!.done ? 1 : 0 : 2;
          const sorted=[...ids].sort((a,b)=>id==='sort-tasks' ? rank(a)-rank(b) : this.doc.nodes[a].text.localeCompare(this.doc.nodes[b].text));
          if(sorted.some((id,i)=>ids[i]!==id))this.apply('Sort children',sorted.map((id,index)=>({t:'move',id,parent,index})));
        }
        return;
      case 'find-replace':
      case 'find':
      case 'commands':
        if (id !== 'commands') this.endEdit();
        this.finderReplace=id==='find-replace';
        this.finder=id==='commands'?'commands':'search';
        return;
      case 'new':
        return this.newDoc();
      case 'node-menu':
        if(this.focusId)this.nodeMenu={};
        return;
      case 'browse-maps': this.browsingMaps=true;return;
      case 'open':
        return this.openDoc();
      case 'save':
        await this.save();
        return;
      case 'save-as':
        await this.save(true);
        return;
      case 'export':
      case 'print':
        this.endEdit();
        this.showInspector = true;
        this.exportRequest = id;
        return;
      case 'import-markdown':
        return this.importFile();
      case 'import-folder':
        return this.importFolder();
      case 'extract-branch':
        return this.extractBranch();
      case 'copy-map-link':
        return this.copyMapNodeLink();
      case 'back-map-link':
        return this.backFromMapLink();
      case 'copy-markdown':
        return this.copyMarkdown();
      case 'undo':
        if (isTypingTarget(document.activeElement)) document.execCommand('undo');
        else this.undo();
        return;
      case 'redo':
        if (isTypingTarget(document.activeElement)) document.execCommand('redo');
        else this.redo();
        return;
      case 'cancel-generation': return this.cancelAi();
      case 'next-pane': this.focusPane(1); return;
      case 'previous-pane': this.focusPane(-1); return;
      case 'generate':
        this.togglePrompt(true);
        return;
      case 'expand':
        return this.expandSelected();
      case 'collapse-toggle':
        return this.toggleFold(selection);
      case 'next-layout':
        return this.nextLayout(focus);
      case 'next-theme':
        return this.nextTheme();
      case 'move-left':
      case 'move-right':
        if (this.focusId && this.pipeline.box(this.focusId)?.flow==='v') this.reorderFocus(id==='move-left'?-1:1);
        return;
      case 'zoom-actual':
        void this.camera.animateTo({...this.camera.getState(),zoom:1},180);
        return;
      case 'zoom-plus':
      case 'zoom-in':
        return this.zoomBy(1.25);
      case 'zoom-out':
        return this.zoomBy(0.8);
      case 'zoom-fit':
        return this.zoomFit();
      case 'zoom-selection':
        return this.zoomSelection();
      case 'centre-selection':
        return this.centreSelection();
      case 'map-view':
        this.outlineOnly=false;this.showOutline=false;return;
      case 'outline-view':
        this.outlineOnly=false;this.showOutline=true;return;
      case 'toggle-outline':
        this.showOutline = !this.showOutline;
        return;
      case 'toggle-inspector':
        this.showInspector = !this.showInspector;
        return;
      case 'toggle-minimap':
        this.showMinimap = !this.showMinimap;
        return;
      case 'filter-map':
        this.endEdit();
        this.showCanvasFilter = true;
        return;
      case 'focus-branch':
        return this.focusBranch();
      case 'present-branches':
        return this.presentation.toggle();
      case 'toggle-stats':
        this.showStats = !this.showStats;
        this.startStatsTimer();
        return;
    }
  }

  toggleStats(): void {
    void this.command('toggle-stats');
  }

  undo(): void {
    this.endEdit(true);
    if (this.editor.defer(() => this.undo())) return;
    if (this.run && this.editor.undoTargetsOpenGroup) void this.cancelAi();
    this.editor.undo();
  }
  redo(): void {
    this.endEdit();
    this.editor.redo();
  }

  togglePrompt(open?: boolean): void {
    this.showPrompt = open ?? !this.showPrompt;
    if (this.showPrompt && !this.gen) this.generateNewMap = false;
  }

  // ====================================================================== input

  private bindInput(): void {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void
    ) => {
      el.addEventListener(type, fn as EventListener);
      this.cleanups.push(() => el.removeEventListener(type, fn as EventListener));
    };
    const onDoc = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void) => {
      document.addEventListener(type, fn as EventListener);
      this.cleanups.push(() => document.removeEventListener(type, fn as EventListener));
    };
    // The camera captures space-drag before the canvas editor receives pointerdown.
    const cancelSpaceEdit = () => { this.spaceCandidate = false; };
    document.addEventListener('pointerdown', cancelSpaceEdit, true);
    this.cleanups.push(() => document.removeEventListener('pointerdown', cancelSpaceEdit, true));
    on(c, 'pointerdown', (e) => this.onPointerDown(e));
    on(c, 'pointermove', (e) => this.onPointerMove(e));
    on(c, 'pointerup', (e) => this.onPointerUp(e));
    on(c, 'pointercancel', (e) => this.onPointerUp(e));
    on(c, 'lostpointercapture', (e) => {
      if (this.marquee?.pointer === e.pointerId) this.finishMarquee(false);
    });
    on(c, 'pointerleave', () => this.setHover(null));
    on(c, 'contextmenu', e=>{
      if(this.presenting)return;
      const id=this.hitAt(this.clientToWorld(e));
      if(!id)return;
      e.preventDefault();
      this.endEdit();
      if(!this.selSet.has(id))this.select([id]);
      else this.select(this.selIds,id);
      this.nodeMenu={x:e.clientX,y:e.clientY};
    });
    on(c, 'dblclick', (e) => this.onDoubleClick(e));
    on(c, 'dragover', (e) => {
      if (e.dataTransfer?.types.some((type) => type === 'Files' || type === 'text/uri-list' || type === 'text/html')) e.preventDefault();
    });
    on(c, 'drop', (e) => this.onDrop(e));
    onDoc('fullscreenchange', () => {
      this.presentation.onFullscreenChange();
    });
    onDoc('keydown', (e) => this.onKeyDown(e));
    onDoc('keyup', (e) => this.onKeyUp(e));
    onDoc('copy', (e) => this.onCopy(e, false));
    onDoc('cut', (e) => this.onCopy(e, true));
    onDoc('paste', (e) => { if (!this.quitPending) void this.onPaste(e); });
    const bu = (e: BeforeUnloadEvent) => {
      if (this.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', bu);
    this.cleanups.push(() => window.removeEventListener('beforeunload', bu));
  }

  private hitAt(world: Vec2, includeBranches = false): NodeId | null {
    if (this.pipeline.doc !== this.doc) return null;
    const id = this.pipeline.canvasSpatial.hitTest(world, 3 / Math.max(this.camera.zoom, 0.3))
      ?? (includeBranches ? this.pipeline.hitBranch(world) : null);
    return id && this.doc.nodes[id] ? id : null;
  }

  /** Collapsed-count badge under the pointer, if any. */
  private badgeAt(world: Vec2): NodeId | null {
    if (this.pipeline.doc !== this.doc) return null;
    const id = this.pipeline.hitFoldBadge(world);
    return id && this.doc.nodes[id]?.collapsed ? id : null;
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.presenting) return this.presentation.onPointerDown(e);
    if (!e.isPrimary || this.marquee || this.drag || this.canvasTools.busy) return;
    if (e.button !== 0 || this.controller.isPanning || this.controller.spaceHeld) {
      this.spaceCandidate = false;
      return;
    }
    this.camera.cancelAnimation();
    const w = this.clientToWorld(e);
    const badge = this.badgeAt(w);
    if (badge) {
      this.toggleFoldOf(badge);
      return;
    }
    if (!this.linkFrom && this.canvasTools.onPointerDown(e)) {
      this.endEdit();
      return;
    }
    const hit = this.hitAt(w, true);
    if(this.linkFrom){
      const from=this.linkFrom;this.linkFrom=null;
      if(hit)this.run_(addLink(this.doc,from,hit));
      this.dismissToast();return;
    }
    if (hit && (e.metaKey || e.ctrlKey) && this.doc.nodes[hit]?.link) {
      e.preventDefault();
      void this.followNodeLink(this.doc.nodes[hit].link!, hit);
      return;
    }
    const modifier = e.shiftKey || e.metaKey || e.ctrlKey;
    if (hit) {
      const wasSelected = this.selSet.has(hit);
      if (modifier) {
        const next = new Set(this.selSet);
        if (wasSelected) next.delete(hit);
        else next.add(hit);
        this.select(Array.from(next), wasSelected ? (Array.from(next).pop() ?? null) : hit);
      } else if (!wasSelected) this.select([hit]);
      else this.select(this.selIds, hit);
      this.drag = {
        id: hit,
        startClient: { x: e.clientX, y: e.clientY },
        startWorld: w,
        active: false,
        dx: 0,
        dy: 0,
        target: null,
        insertAt: null,
        wasSelected,
        linkDrag:e.shiftKey,
        detach:false,
        modifier
      };
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    } else {
      this.marquee = {
        pointer: e.pointerId,
        start: w,
        client: { x: e.clientX, y: e.clientY },
        base: modifier ? [...this.selIds] : [],
        rect: null
      };
      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    if (document.activeElement && document.activeElement !== document.body && !isTypingTarget(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }

  private updateMarquee(e: PointerEvent, world: Vec2): void {
    const marquee = this.marquee;
    if (!marquee || marquee.pointer !== e.pointerId) return;
    if (!marquee.rect && Math.hypot(e.clientX - marquee.client.x, e.clientY - marquee.client.y) < 5) return;
    marquee.rect = {
      x: Math.min(marquee.start.x, world.x),
      y: Math.min(marquee.start.y, world.y),
      w: Math.abs(world.x - marquee.start.x),
      h: Math.abs(world.y - marquee.start.y)
    };
    this.canvas.style.cursor = 'crosshair';
    this.setHoverQuiet(null);
    this.markOverlay();
  }

  private finishMarquee(applySelection: boolean): void {
    const marquee = this.marquee;
    if (!marquee) return;
    this.marquee = null;
    if (this.canvas.hasPointerCapture(marquee.pointer)) this.canvas.releasePointerCapture(marquee.pointer);
    this.canvas.style.cursor = 'default';
    if (applySelection) {
      const hits = marquee.rect ? this.pipeline.canvasSpatial.query(marquee.rect) : [];
      if (marquee.rect) this.canvasTools.marquee(marquee.rect, marquee.base.length > 0);
      this.select([...marquee.base, ...hits], hits.at(-1) ?? (marquee.base.includes(this.focusId ?? '') ? this.focusId : null));
    }
    this.markOverlay();
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.presenting || this.controller.isPanning) return;
    if (!this.marquee && !this.drag && this.canvasTools.onPointerMove(e)) return;
    const w = this.clientToWorld(e);
    if (this.marquee) {
      this.updateMarquee(e, w);
      return;
    }
    const d = this.drag;
    if (!d) {
      if (e.buttons === 0) {
        const hit = this.hitAt(w);
        this.setHover(hit);
        const badge = !hit ? this.badgeAt(w) : null;
        this.canvas.style.cursor = badge || hit ? 'pointer' : this.controller.spaceHeld ? 'grab' : 'default';
      }
      return;
    }
    if (!d.active) {
      if (Math.hypot(e.clientX - d.startClient.x, e.clientY - d.startClient.y) < 5) return;
      d.active = true;
      this.canvas.style.cursor = 'grabbing';
    }
    d.dx = w.x - d.startWorld.x;
    d.dy = w.y - d.startWorld.y;
    if (!d.linkDrag && !d.detach) this.canvasTools.followNodeDrag(d.dx, d.dy);
    let t = this.hitAt(w);
    d.insertAt = null;
    if (!d.linkDrag && !d.detach) {
      // Include the narrow gap just outside each sibling's leading or trailing edge.
      const margin = 9 / this.camera.zoom;
      const nearby = t ? [t] : this.pipeline.canvasSpatial.query({x:w.x-margin,y:w.y-margin,w:2*margin,h:2*margin});
      let nearest = Infinity;
      for (const id of nearby) {
        const box = this.pipeline.box(id);
        if (!box || !this.doc.nodes[id].parent || id === d.id) continue;
        const horizontal = box.flow !== 'v';
        const along = horizontal ? w.y-box.y : w.x-box.x;
        const across = horizontal ? w.x-box.x : w.y-box.y;
        const half = (horizontal ? box.h : box.w)/2;
        const gap = Math.abs(Math.abs(along)-half);
        if (Math.abs(across) > (horizontal ? box.w : box.h)/2 || gap > Math.min(margin,half/2) || gap >= nearest) continue;
        nearest=gap; t=id; d.insertAt=along<0?'before':'after';
      }
    }
    const moving = this.selSet.has(d.id) ? this.topLevelSelection() : [d.id];
    if (t && (d.linkDrag ? t===d.id : moving.some(id=>id===t || isAncestor(this.doc,id,t!)))) t=null;
    d.target=t;
    this.setHoverQuiet(t);
    this.markOverlay();
  }

  private setHoverQuiet(id: NodeId | null): void {
    this.hover = id;
    this.hoverNode = null;
  }

  private dragWouldOverlap(roots: NodeId[], dx: number, dy: number): boolean {
    const { boxes } = this.pipeline.layout;
    const moving = new Set<NodeId>();
    const pending = [...roots];
    while (pending.length) {
      const id = pending.pop()!;
      const node = this.doc.nodes[id];
      if (!node || !boxes.has(id)) continue;
      moving.add(id);
      for (const child of node.children) {
        // A pin stays at its world coordinate while an ancestor is dragged.
        if (!this.doc.nodes[child]?.pinnedPosition) pending.push(child);
      }
    }
    for (const id of moving) {
      const box = boxes.get(id)!;
      const x = box.x + dx, y = box.y + dy;
      const nearby = this.pipeline.spatial.query({ x: x - box.w / 2, y: y - box.h / 2, w: box.w, h: box.h });
      for (const other of nearby) {
        if (moving.has(other)) continue;
        const obstacle = boxes.get(other)!;
        if (Math.abs(x - obstacle.x) < (box.w + obstacle.w) / 2 &&
            Math.abs(y - obstacle.y) < (box.h + obstacle.h) / 2) return true;
      }
    }
    return false;
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.canvasTools.onPointerUp(e)) return;
    if (this.marquee) {
      if (this.marquee.pointer === e.pointerId) {
        if (e.type !== 'pointercancel') this.updateMarquee(e, this.clientToWorld(e));
        this.finishMarquee(e.type !== 'pointercancel');
      }
      return;
    }
    const d = this.drag;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.canvas.style.cursor = 'default';
    if (!d) return;
    this.canvasTools.clearPreview();
    if (!d.active) {
      if (d.wasSelected && !d.modifier && this.selSet.size > 1) this.select([d.id]);
      return;
    }
    this.hover = null;
    if (e.type === 'pointercancel') {
      this.markOverlay();
      return;
    }
    const doc = this.doc;
    const dropHit = this.hitAt(this.clientToWorld(e));
    if(d.detach && doc.nodes[d.id]?.parent) {
      this.run_(detach(doc,d.id,this.clientToWorld(e)));
      this.markOverlay();return;
    }
    if(d.linkDrag){
      if(dropHit)this.run_(addLink(doc,d.id,dropHit));
      this.markOverlay();return;
    }
    if (dropHit && (dropHit === d.id || isAncestor(doc, d.id, dropHit))) {
      this.markOverlay();
      return;
    }
    const moving = this.selSet.has(d.id) ? this.topLevelSelection() : [d.id];
    if (d.target) {
      const parent = d.insertAt ? doc.nodes[d.target].parent : d.target;
      if (parent && !moving.some(id=>id===parent || isAncestor(doc,id,parent))) {
        const siblings = [...doc.nodes[parent].children];
        const pivot = d.insertAt === 'before' ? d.target : d.insertAt === 'after'
          ? siblings.slice(siblings.indexOf(d.target)+1).find(id=>!moving.includes(id)) : undefined;
        const ops:Transaction['ops'] = [];
        for (const id of moving) {
          const previous=siblings.indexOf(id);
          if (previous>=0) siblings.splice(previous,1);
          const index=pivot ? siblings.indexOf(pivot) : siblings.length;
          const edit=moveSubtree(doc,id,parent,index);
          if (edit) ops.push(...edit.tx.ops);
          siblings.splice(index,0,id);
        }
        if (ops.length) this.apply('Move selected branches',ops);
      }
    } else if (!dropHit && Math.hypot(d.dx, d.dy) > 3 / this.camera.zoom) {
      if (this.dragWouldOverlap(moving, d.dx, d.dy)) {
        this.say('There is no room to drop the selection here.');
        this.markOverlay();
        return;
      }
      const ops:Transaction['ops'] = [];
      for (const id of moving) {
        const node = doc.nodes[id];
        if (node.parent === null) {
          const info = doc.rootInfo[id];
          ops.push({t:'setRoot',id,info:{...info,position:{x:info.position.x+d.dx,y:info.position.y+d.dy}}});
        } else if (node.pinnedPosition) {
          const { x, y } = node.pinnedPosition;
          ops.push({ t: 'set', id, patch: { pinnedPosition: { x: x + d.dx, y: y + d.dy } } });
        } else {
          ops.push({t:'set',id,patch:{offset:{x:(node.offset?.x ?? 0)+d.dx,y:(node.offset?.y ?? 0)+d.dy}}});
        }
      }
      ops.push(...this.canvasTools.moveOps(d.dx, d.dy));
      this.apply('Move selected branches',ops);
    }
    this.markOverlay();
  }

  private onDoubleClick(e: MouseEvent): void {
    if (this.presenting || this.controller.spaceHeld) return;
    if (this.canvasTools.onDoubleClick(e)) return;
    const w = this.clientToWorld(e);
    const hit = this.hitAt(w);
    if (hit) this.startEdit(hit, 'keep');
    else if (!this.canvasBranch && !this.badgeAt(w)) this.createFloating(w);
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (this.presenting) this.presentation.onKeyUp(e);
    if (e.code === 'Space' && this.spaceCandidate) {
      this.spaceCandidate = false;
      if (!isTypingTarget(e.target) && this.focusId && !this.editingId && !this.controller.isPanning) {
        this.startEdit(this.focusId, 'keep');
      }
    }
  }

  private focusPane(direction: number): void {
    const active = document.activeElement;
    const panes = [...document.querySelectorAll<HTMLElement>('[data-keyboard-pane]')].flatMap(pane => {
      const controls = pane.querySelectorAll<HTMLElement>('canvas, input, select, textarea, button, summary, [tabindex="0"]');
      const first = [...controls].find(el => el.tabIndex >= 0 && !el.matches(':disabled') &&
        el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible');
      return first ? [{ pane, first }] : [];
    });
    if (!panes.length) return;
    const current = panes.findIndex(({ pane }) => active && pane.contains(active));
    const index = current < 0 ? (direction > 0 ? 0 : panes.length - 1) : (current + direction + panes.length) % panes.length;
    panes[index].first.focus();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.quitPending) return;
    if (e.isComposing || e.keyCode===229 || e.defaultPrevented || this.dialog) return;
    if (this.drag && e.code==='KeyD' && !e.metaKey && !e.ctrlKey) {e.preventDefault();this.drag.detach=true;return;}
    if (this.presenting) {
      this.presentation.onKey(e);
      return;
    }
    if (this.marquee) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.finishMarquee(false);
      }
      return;
    }
    if (this.canvasTools.onKeyDown(e)) return;
    if (e.key === 'Escape' && this.canvasView?.kind === 'focus' && !isTypingTarget(e.target)) {
      e.preventDefault();
      this.leaveCanvasView();
      return;
    }
    const typing = isTypingTarget(e.target);
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    if (!typing && mod && e.altKey && !e.shiftKey && (e.code === 'KeyC' || e.code === 'KeyV')) {
      e.preventDefault();
      if (!e.repeat) {
        if (e.code === 'KeyC') this.copySelectedStyle();
        else this.pasteSelectedStyle();
      }
      return;
    }

    const pressed = chord(e);
    const command = shortcutCommands.find(([id]) => pressed && this.shortcuts[id] === pressed)?.[0];
    const control = e.target instanceof Element && !!e.target.closest('button, a, summary, [role=button], [role=treeitem]');
    if (this.linkFrom && key === 'Enter' && !mod && !e.altKey && !e.shiftKey && !typing && !control) {
      e.preventDefault();
      if (this.focusId && this.linkFrom !== this.focusId) {
        this.run_(addLink(this.doc, this.linkFrom, this.focusId));
        this.linkFrom = null;
        this.dismissToast();
      }
      return;
    }
    if (command && !e.isComposing && !(e.target instanceof Element && e.target.closest('dialog:modal'))) {
      const globalWhileTyping = ['save','save-as','new','open','find','commands','edit-link','edit-note'];
      if (command === 'next-pane' || command === 'previous-pane' || (!typing && !(control && !mod)) || (mod && globalWhileTyping.includes(command))) {
        e.preventDefault();
        if (!e.repeat || command.startsWith('nav-')) void this.command(command);
        return;
      }
    }

    // ---- inline editor
    if (e.target === this.textarea) {
      if (key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.addSiblingOf(!e.altKey);
      } else if (key === 'Escape') {
        e.preventDefault();
        this.endEdit();
      } else if (key === 'Tab') {
        e.preventDefault();
        this.advanceInlineEdit(e.shiftKey);
      } else if (this.queuedInlineEntry && key.length === 1 && !mod && !e.altKey) {
        // The focused field may still belong to the preceding node while a
        // durable structural edit waits. Keep later characters in input order.
        e.preventDefault();
        if (!this.deferInlineEntry(() => this.typeOnCanvas(key))) this.typeOnCanvas(key);
      }
      return;
    }

    if (key === 'Escape') {
      if(this.linkFrom){this.linkFrom=null;this.dismissToast();return;}
      if (this.dialog) return;
      if (this.showPrompt && !this.busy) {
        this.showPrompt = false;
        return;
      }
      if (typing) {
        (e.target as HTMLElement).blur();
        return;
      }
      if (this.selIds.length) this.select([]);
      return;
    }
    if (typing || control) return;

    if (mod) return;
    if (key === ' ') {
      if (!e.repeat && this.focusId) this.spaceCandidate = true;
      return;
    }
    if (key.length === 1 && !e.altKey && this.focusId) {
      // A queued structural command may change the target before this key can be applied.
      if (this.deferInlineEntry(() => this.typeOnCanvas(key))) {
        e.preventDefault();
      } else this.startEdit(this.focusId, 'replace');
    }
  }

  private deferInlineEntry(intent: () => void): boolean {
    const deferred = this.editor.defer(() => {
      this.queuedInlineEntry--;
      intent();
    });
    if (deferred) this.queuedInlineEntry++;
    return deferred;
  }

  private advanceInlineEdit(outdent: boolean): void {
    if (this.deferInlineEntry(() => this.advanceInlineEdit(outdent))) return;
    const id = this.editingId;
    if (!id) return;
    if (outdent) {
      this.endEdit();
      this.outdent();
    } else this.addChildOf(id);
  }

  private typeOnCanvas(key: string): void {
    if (!this.editingId && this.focusId) this.startEdit(this.focusId, 'replace');
    if (!this.editingId) return;
    const input = this.textarea;
    input.setRangeText(key, input.selectionStart, input.selectionEnd, 'end');
    this.onEditInput();
  }

  // ====================================================================== clipboard

  private topLevelSelection(selection: readonly NodeId[] = this.selIds): NodeId[] {
    const set = new Set(selection);
    return selection.filter((id) => {
      for (let p = this.doc.nodes[id]?.parent ?? null; p !== null; p = this.doc.nodes[p]?.parent ?? null) {
        if (set.has(p)) return false;
      }
      return true;
    });
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    if (isTypingTarget(e.target) || this.dialog || this.presenting) return;
    if (this.canvasTools.onCopy(e, cut)) return;
    const ids = this.topLevelSelection();
    if (!ids.length || !e.clipboardData) return;
    const nodes = ids.map((id) => outlineFromSubtree(this.doc, id));
    const plain=toIndentedText(nodes);
    const json=JSON.stringify(copyBranches(this.doc,ids));
    const rich=document.createElement('pre');
    rich.dataset.radiantBranches=json;
    rich.textContent=plain;
    e.clipboardData.setData('text/plain',plain);
    e.clipboardData.setData('text/html',rich.outerHTML);
    e.clipboardData.setData(BRANCH_MIME,json);
    e.clipboardData.setData('text/markdown', toMarkdownOutline(nodes, { headingLevels: 1 }));
    e.preventDefault();
    if (cut) this.deleteSelection();
    else this.say(`Copied ${ids.length === 1 ? 'a node' : ids.length + ' nodes'}`, 'info');
  }

  private async onPaste(e: ClipboardEvent): Promise<void> {
    if (this.dialog || this.presenting) return;
    const cd = e.clipboardData;
    if (!cd) return;
    const file = pictureFile(cd);
    if (file && (!isTypingTarget(e.target) || e.target === this.textarea)) {
      e.preventDefault();
      const target = this.editingId ?? this.focusId;
      this.endEdit();
      await this.attachImage(target, file);
      return;
    }
    if (isTypingTarget(e.target)) return;
    if (this.canvasTools.onPaste(e)) return;
    try {
      const copied=readBranches(cd);
      if (copied) {
        e.preventDefault();
        this.pasteBranches(copied);
        return;
      }
    } catch(error) { e.preventDefault(); this.say(String(error),'error');return; }
    const opml = cd.getData('text/x-opml') || cd.getData('application/x-opml+xml');
    const markdown = cd.getData('text/markdown');
    const plain = cd.getData('text/plain');
    const xml = cd.getData('application/xml') || cd.getData('text/xml');
    const text = opml || markdown || plain || (/<opml[\s>]/i.test(xml) ? xml : '');
    if (!text.trim()) return;
    e.preventDefault();
    let nodes: OutlineNode[];
    try {
      if (opml || (!markdown && text.trimStart().startsWith('<') && /<opml[\s>]/i.test(text))) nodes = parseOpml(text).nodes;
      else if (markdown || /^\s*(?:#{1,6}|[-*+]|\d+[.)])\s/m.test(text)) nodes = parseMarkdownOutline(text);
      else nodes = parseIndentedText(text);
    } catch (error) { this.say(String(error), 'error'); return; }
    if (!nodes.length) return;
    this.pasteOutline(nodes);
  }

  private pasteBranches(copied: NonNullable<ReturnType<typeof readBranches>>): void {
    if (this.editor.defer(() => this.pasteBranches(copied))) return;
    const parent=this.focusId;
    const position=parent ? undefined : this.nextFreePosition();
    const doc=this.doc;
    const {ops,created}=insertBranches(copied,(root,i)=>({
      parent,index:(parent ? doc.nodes[parent].children.length : doc.roots.length)+i,
      rootInfo:position && {layout:copied.rootInfo[root].layout,position:{x:position.x,y:position.y+i*160}}
    }));
    if(parent && doc.nodes[parent].collapsed) ops.unshift({t:'set',id:parent,patch:{collapsed:undefined}});
    if(copied.tagColors) ops.unshift({t:'docMeta',patch:{tagColors:{...copied.tagColors,...doc.tagColors}}});
    this.apply('Paste branches',ops);
    this.select(created);
    if(created[0])this.ensureVisible(created[0]);
  }

  pasteOutline(nodes: OutlineNode[]): void {
    if (this.editor.defer(() => this.pasteOutline(nodes))) return;
    const doc = this.doc;
    const target = this.focusId;
    if (target && doc.nodes[target]) {
      const e = insertOutline(doc, target, nodes);
      if (e) {
        this.editor.apply(e.tx);
        this.select(e.created ?? []);
        if (e.created?.[0]) this.ensureVisible(e.created[0]);
      }
    } else this.importOutline('Pasted map', nodes);
  }

  /** Put an outline into the map: replaces an empty map, otherwise adds a new root to the right. */
  importOutline(title: string, nodes: OutlineNode[]): void {
    if (!nodes.length) return;
    this.endEdit();
    if (this.editor.defer(() => this.importOutline(title, nodes))) return;
    this.flush();
    const placeholder = isEmptyDoc(this.doc) ? this.doc.roots[0] : null;
    const b = this.pipeline.layout.bounds;
    const ops: Transaction['ops'] = [];
    const root = wrapOutline(title, nodes);
    const info = placeholder ? this.doc.rootInfo[placeholder] : {
      position: { x: b.x + b.w + 360, y: b.y + b.h / 2 }, layout: 'mindmap' as const
    };
    const id = outlineInsertOps(root, null, this.doc.roots.length, 'user', ops, info);
    if (placeholder) {
      ops.push({ t: 'remove', id: placeholder }, { t: 'docMeta', patch: { title: title || root.text } });
    }
    this.apply('Import', ops);
    this.select([id]);
    this.flush();
    if (placeholder) this.zoomFit(false);
    else this.centerOn(id);
  }

  // ====================================================================== images

  private async onNativeDrop(paths: string[], point: Vec2): Promise<void> {
    if (this.presenting || this.dialog) return;
    this.spaceCandidate = false;
    try {
      const nativeDocument = paths.find((path) => extOf(path) === 'radiant');
      if (nativeDocument) return await this.openDoc(nativeDocument);
      const picture = paths.find((path) => picturePathMime(path));
      const overCanvas = document.elementFromPoint(point.x, point.y)?.closest('.stage');
      if (picture && overCanvas) {
        const doc = this.doc;
        const position = this.clientToWorld({ clientX: point.x, clientY: point.y });
        const id = this.hitAt(position);
        const bytes = new Uint8Array(await this.host.readBinaryFile(picture));
        if (this.doc !== doc) return;
        const dropped = new File([bytes], basename(picture), { type: picturePathMime(picture) });
        return await (id ? this.attachImage(id, dropped, position) : this.canvasTools.addImage(dropped, position));
      }
      const outline = paths.find((path) => ['md', 'markdown', 'txt', 'opml', 'mm', 'xmind', 'mindnode', 'canvas', 'json', 'zip'].includes(extOf(path)));
      if (outline) return await this.importFile(outline);
      this.say(picture ? 'Drop the picture onto the canvas.' : 'The drop did not contain a supported map or picture.', 'info');
    } catch (error) {
      this.say(`Could not open the drop: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async onDrop(e: DragEvent): Promise<void> {
    if (this.presenting || !e.dataTransfer?.types.some((type) => type === 'Files' || type === 'text/uri-list' || type === 'text/html')) return;
    e.preventDefault();
    const doc = this.doc;
    const position = this.clientToWorld(e);
    const hit = this.hitAt(position);
    try {
      const file = await pictureFromDrop(e.dataTransfer);
      if (this.doc !== doc) return;
      // CNV-42: on a node the picture attaches to it; on empty canvas it becomes a free picture element.
      if (file) await (hit ? this.attachImage(hit, file, position) : this.canvasTools.addImage(file, position));
      else this.say('The drop did not contain a supported picture.', 'info');
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  async attachImage(id: NodeId | null, file: File, position?: Vec2): Promise<void> {
    const doc = this.doc;
    const request = Symbol();
    if (id) this.pictureUploads.set(id, request);
    try {
      const mime = checkedPictureMime(file);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await this.host.assetPut(bytes, mime, { createdBy: 'user' });
      const { aspect: imageAspect } = await this.ensureImage(hash);
      if (this.doc !== doc || (id && (!doc.nodes[id] || this.pictureUploads.get(id) !== request))) return;
      if (id) {
        this.apply('Attach Picture', [{ t: 'set', id, patch: { imageAsset: hash, imageAspect, imageScale: undefined, imageAlt: undefined } }]);
        this.select([id]);
      } else {
        const newNode = newId();
        const text = file.name.replace(/\.[^.]+$/, '').trim() || 'Picture';
        this.apply('Add Picture Node', [{
          t: 'insert', node: { id: newNode, parent: null, children: [], text, imageAsset: hash, imageAspect, origin: { by: 'user' } },
          parent: null, index: doc.roots.length,
          rootInfo: { layout: 'mindmap', position: position ?? { x: this.camera.cx, y: this.camera.cy } }
        }]);
        this.select([newNode]);
      }
      this.say('Picture added.', 'info');
    } catch (err) {
      if (this.doc === doc) this.say(`Could not add the picture: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      if (id && this.pictureUploads.get(id) === request) this.pictureUploads.delete(id);
    }
  }

  removeImage(id: NodeId): void {
    this.pictureUploads.delete(id);
    this.apply('Remove Picture', [{ t: 'set', id, patch: { imageAsset: undefined, imageAspect: undefined, imageScale: undefined, imageAlt: undefined } }]);
  }

  resizeImage(id: NodeId, scale: number): void {
    const n = this.doc.nodes[id];
    const imageScale = Math.round(clampImageScale(scale) * 1000) / 1000;
    if (!n?.imageAsset || imageScale === (n.imageScale ?? 1)) return;
    this.apply('Resize Picture', [{ t: 'set', id, patch: { imageScale } }]);
  }

  describeImage(id: NodeId, alt: string): void {
    if (!this.doc.nodes[id]?.imageAsset) return;
    this.apply('Describe Picture', [{ t: 'set', id, patch: { imageAlt: alt.trim().slice(0, 240) || undefined } }]);
  }

  private async ensureImage(hash: string) {
    const cached = this.pipeline.imageInfo.get(hash);
    if (cached) return cached;
    const info = await this.host.assetImageInfo?.(hash).catch(() => undefined);
    const url = info?.url ?? await this.host.assetUrl(hash);
    const hint = info?.aspect;
    const aspect = hint && Number.isFinite(hint) && hint > 0 ? hint : await decodeImageAspect(url);
    const resolved = { ...info, url, aspect };
    this.pipeline.imageInfo.set(hash, resolved);
    return resolved;
  }

  noteImageFailure(hash: string, report = true): void {
    if (this.failedImages.has(hash)) return;
    this.failedImages = new Set(this.failedImages).add(hash);
    if (report) recordDiagnostic(this.host, 'artwork_unavailable');
    this.markLayout();
  }

  retryImage(hash: string): void {
    if (!this.failedImages.has(hash)) return;
    this.forgetImage(hash);
    const next = new Set(this.failedImages);
    next.delete(hash);
    this.failedImages = next;
    this.markLayout();
  }

  private forgetImage(hash: string): void {
    const info = this.pipeline.imageInfo.get(hash);
    if (info) this.renderer.invalidateImageSource?.(info.url);
    this.pipeline.imageInfo.delete(hash);
  }

  private resolveMissingImages(): void {
    for (const hash of [...this.pipeline.missingImages, ...this.pipeline.missingImagePreviews]) {
      if (this.failedImages.has(hash) || this.loadingImages.has(hash)) continue;
      this.loadingImages.add(hash);
      this.ensureImage(hash).then(
        () => this.markLayout(),
        () => this.noteImageFailure(hash, this.pipeline.missingImages.has(hash))
      ).finally(() => this.loadingImages.delete(hash));
    }
  }

  // ====================================================================== overlay extras (drag, pulse)

  setReviewStrength(outcomes: ReadonlyMap<NodeId, Outcome> | null): void {
    this.reviewStrength = outcomes;
    this.markOverlay();
  }

  startReviewTimer(minutes = 20): void {
    this.stopReviewTimer();
    this.reviewTimerDeadline = Date.now() + minutes * 60_000;
    this.reviewTimer = window.setTimeout(() => {
      this.reviewTimerDeadline = 0;
      this.say('Mapping timer complete.', 'info', 6000);
    }, minutes * 60_000);
  }

  stopReviewTimer(): void {
    clearTimeout(this.reviewTimer);
    this.reviewTimerDeadline = 0;
  }

  private extraOverlay(): RectDraw[] {
    const out: RectDraw[] = [];
    if (this.marquee?.rect) {
      out.push({
        ...this.marquee.rect, radius: 0,
        fill: premulCss(ACCENT_COLOR, 0.12), stroke: premulCss(ACCENT_COLOR, 0.85),
        strokeWidth: 1 / this.camera.zoom
      });
    }
    if (this.presenting) return out;
    for (const { id } of this.aiChangeSummary?.added ?? []) {
      const box = this.pipeline.canvasLayout.boxes.get(id);
      if (!box) continue;
      const pad = 4 / this.camera.zoom;
      out.push({
        x: box.x - box.w / 2 - pad, y: box.y - box.h / 2 - pad,
        w: box.w + 2 * pad, h: box.h + 2 * pad, radius: 7,
        fill: premulCss('#059669', 0), stroke: premulCss('#059669', 1), strokeWidth: 2 / this.camera.zoom
      });
    }
    if (this.reviewStrength) {
      const colors = { recalled: '#16a34a', partly: '#d97706', missed: '#dc2626' };
      for (const [id, outcome] of this.reviewStrength) {
        const box = this.pipeline.box(id);
        if (!box) continue;
        const color = colors[outcome];
        out.push({
          x: box.x - box.w / 2 - 3, y: box.y - box.h / 2 - 3, w: box.w + 6, h: box.h + 6,
          radius: 7, fill: premulCss(color, 0), stroke: premulCss(color, .9), strokeWidth: 1.5
        });
      }
    }
    const d = this.drag;
    if (d?.active) {
      const b = this.pipeline.box(d.id);
      if (!d.detach && !d.linkDrag) {
        const moving = this.selSet.has(d.id) ? this.topLevelSelection() : [d.id];
        for (const id of moving) {
          const node = this.doc.nodes[id];
          const box = this.pipeline.box(id);
          if (!box || !node.parent || node.pinnedPosition) continue;
          out.push({
            x: box.x - box.w / 2 - (node.offset?.x ?? 0),
            y: box.y - box.h / 2 - (node.offset?.y ?? 0),
            w: box.w, h: box.h, radius: 8,
            fill: premulCss(ACCENT_COLOR, 0.08), stroke: premulCss(ACCENT_COLOR, 0.55),
            strokeWidth: 2 / this.camera.zoom
          });
        }
      }
      if (b) {
        out.push({
          x: b.x - b.w / 2 + d.dx,
          y: b.y - b.h / 2 + d.dy,
          w: b.w,
          h: b.h,
          radius: 8,
          fill: premulCss(ACCENT_COLOR, 0.14),
          stroke: premulCss(ACCENT_COLOR, 0.8),
          strokeWidth: 1.5
        });
      }
      if (d.target) {
        const t = this.pipeline.box(d.target);
        if (t && d.insertAt) {
          const side=d.insertAt==='before'?-1:1;
          const vertical=t.flow==='v';
          out.push({x:vertical?t.x+side*t.w/2:t.x-t.w/2, y:vertical?t.y-t.h/2:t.y+side*t.h/2,
            w:vertical?3/this.camera.zoom:t.w,h:vertical?t.h:3/this.camera.zoom,
            radius:1,fill:premulCss(ACCENT_COLOR,1)});
        } else if (t) {
          out.push({
            x: t.x - t.w / 2 - 6,
            y: t.y - t.h / 2 - 6,
            w: t.w + 12,
            h: t.h + 12,
            radius: 12,
            fill: premulCss('#16a34a', 0.14),
            stroke: premulCss('#16a34a', 0.95),
            strokeWidth: 2.5
          });
        }
      }
    }
    const run = this.run;
    if (this.gen?.liveGrowth && run?.kind === 'expand' && run.targetId) {
      const b = this.pipeline.canvasLayout.boxes.get(run.targetId);
      if (b) {
        const a = this.motionPreference?.matches ? 0.35 : 0.35 + 0.35 * Math.sin(performance.now() / 260);
        out.push({
          x: b.x - b.w / 2 - 8,
          y: b.y - b.h / 2 - 8,
          w: b.w + 16,
          h: b.h + 16,
          radius: 14,
          fill: premulCss('#8b5cf6', 0.08 + a * 0.12),
          stroke: premulCss('#8b5cf6', 0.4 + a * 0.6),
          strokeWidth: 2
        });
      }
    }
    return out;
  }

  private startPulse(): void {
    clearInterval(this.pulseTimer);
    if (this.motionPreference?.matches) return;
    this.pulseTimer = window.setInterval(() => {
      if (this.gen?.liveGrowth && this.run?.kind === 'expand') this.markOverlay();
    }, 70);
  }

  // ====================================================================== messages and dialogs

  say(text: string, kind: 'info' | 'error' = 'info', ms = kind === 'error' ? 9000 : 2600): void {
    this.toast = { text, kind };
    if (kind === 'error') recordDiagnostic(this.host, 'ui_error');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (this.toast = null), ms);
  }

  dismissToast(): void {
    this.toast = null;
  }

  ask(title: string, message: string, buttons: DialogButton[], details?: readonly string[], requestPreview?: string): Promise<string> {
    return new Promise((resolve) => {
      this.dialog = {
        title,
        message,
        buttons,
        details,
        requestPreview,
        resolve: (id) => {
          this.dialog = null;
          resolve(id);
        }
      };
    });
  }

  /** Returns true if it is fine to discard the current map. */
  private async confirmDiscard(action: string): Promise<boolean> {
    this.endEdit();
    if (!(await this.editor.settled(true))) {
      this.say('Pending edits could not be written. Keep the map open and retry saving.', 'error');
      return false;
    }
    if (!this.dirty) return true;
    const r = await this.ask(
      `Save changes to "${this.doc.title}"?`,
      `Your changes will be lost if you ${action} without saving.`,
      [
        { id: 'save', label: 'Save', primary: true },
        { id: 'discard', label: "Don't Save", danger: true },
        { id: 'cancel', label: 'Cancel' }
      ]
    );
    if (r === 'cancel') return false;
    if (r === 'save') return await this.save();
    return true;
  }

  // ====================================================================== files

  private loadDoc(doc: Doc, path: string | null, dirty: boolean, history?: EditorHistory, unavailableAssets: readonly string[] = []): void {
    this.pendingMapRepair = null;
    this.sentMapRepairs = [];
    this.endEdit();
    clearTimeout(this.autosaveTimer);
    const run = this.run;
    if (run) {
      this.endRun(run);
      if (run.id) void this.host.aiCancel(run.id).catch(() => {});
    }
    this.linkFrom=null;
    this.mapLinkTrail = [];
    this.reviewOffer = null;
    this.setReviewStrength(null);
    for (const hash of this.failedImages) this.forgetImage(hash);
    this.failedImages = new Set(unavailableAssets);
    if (unavailableAssets.length) recordDiagnostic(this.host, 'artwork_unavailable');
    this.editor.load(doc, history);
    const unfinished = new Set(Object.entries(doc.aiJobs ?? {})
      .filter(([, job]) => job.status === 'running').map(([id]) => id));
    this.unfinishedJobNotice = '';
    if (unfinished.size) {
      const retained = Object.values(doc.nodes).filter(node =>
        (node.origin?.by === 'ai' && unfinished.has(node.origin.job)) ||
        (node.lastAiJob && unfinished.has(node.lastAiJob))).length;
      const jobs = unfinished.size === 1 ? 'an unfinished AI job' : `${unfinished.size} unfinished AI jobs`;
      this.unfinishedJobNotice = `This map was saved during ${jobs}. It contains ${retained} ${retained === 1 ? 'node' : 'nodes'} from that work.`;
    }
    const priorPath = this.filePath;
    this.filePath = path;
    if (priorPath && priorPath !== path) void this.host.releaseDocumentPath?.(priorPath).catch(() => {});
    this.select([doc.roots[0]]);
    this.fitAfterLayout = true;
    this.flush(false);
    this.dirty = dirty;
    this.saveText = '';
    this.updateUndoState();
  }

  async newDoc(): Promise<void> {
    if (this.host.openDocumentWindow) {
      try { await this.host.openDocumentWindow(); }
      catch (error) { this.say(String(error), 'error'); }
      return;
    }
    if (!(await this.confirmDiscard('create a new map'))) return;
    const d = createDoc();
    d.themeId = this.doc.themeId;
    this.discardCurrentRecovery();
    this.loadDoc(d, null, false);
    this.camera.set({ cx: 0, cy: 0, zoom: 1 });
  }

  async restoreSnapshot(snapshot: Snapshot, copy: boolean): Promise<void> {
    if ((!copy && this.doc.id !== snapshot.docId) || !(await this.confirmDiscard('restore a snapshot'))) return;
    try {
      const { doc: restored, repairs } = parseDocReport(snapshot.json);
      const previous = this.doc;
      const revision = this.rev;
      const history = copy || repairs.length ? undefined : await loadUndo(restored.id, 'saved', snapshot.json);
      if (this.doc !== previous || this.rev !== revision) return;
      if (copy) { restored.id = newId(); restored.title += ' (copy)'; }
      this.discardCurrentRecovery();
      this.loadDoc(restored, copy ? null : this.filePath, true, history);
      this.queueAutosave();
    } catch (error) { this.say(String(error),'error'); }
  }

  async openDoc(chosen?: string, inThisWindow = false, initialWindowOpen = false): Promise<void> {
    let path: string | null | undefined = chosen;
    let readFailed = false;
    try {
      path ??= await this.host.pickOpenPath(true);
      if (!path) return;
      // A portable bundle (name.radiant.zip) is not a document file: it is imported as a new, unsaved map.
      if (/\.zip$/i.test(path)) return this.importFile(path);
      if (!inThisWindow && this.host.openDocumentWindow) {
        await this.host.openDocumentWindow(path);
        return;
      }
      if (!(await this.confirmDiscard('open another map'))) return;
      const previous = this.doc;
      const revision = this.rev;
      readFailed = true;
      const opened = await this.host.docOpen?.(path);
      const json = opened?.json ?? await this.host.docLoad(path, true);
      path = opened?.path ?? path;
      const { doc, repairs } = parseDocReport(json);
      readFailed = false;
      const history = repairs.length ? undefined : await loadUndo(doc.id, 'saved', json)
        ?? await this.host.quickCaptureHistory?.(path, json).catch(() => undefined);
      if ((this.doc !== previous || this.rev !== revision) && !(await this.confirmDiscard('open another map'))) return;
      if (this.host.claimDocumentPath) path = await this.host.claimDocumentPath(path);
      this.discardCurrentRecovery();
      this.loadDoc(doc, path, false, history, opened?.unavailableAssets);
      const change = this.editor.historySummary(1).applied[0];
      const original = opened?.originalJson;
      const saveOpened = () => storeSnapshot(doc.id, json, 'Opened map', true, change, path ?? undefined);
      const checkpoint = original === undefined ? saveOpened()
        : storeSnapshot(doc.id, original, 'Before migration', true, change, path)
          .then(() => { if (original !== json) return saveOpened(); });
      void checkpoint.catch(() => this.say('The open-time snapshot could not be stored.', 'error'));
      void this.host.noteDocument?.(path).catch(() => {});
      linkReviewMapPath(doc.id, path);
      if (learnedMap(doc.id)) {
        this.showInspector = true;
        this.reviewOffer = doc.id;
      }
      this.recent=rememberRecent(path);
      if (opened?.migrated) this.say(`Opened a migrated copy at ${path}. The original map was kept.`, 'info');
      else if (repairs.length) this.say(`Opened with ${repairs.length} automatic repair${repairs.length === 1 ? '' : 's'}.`, 'info');
    } catch (err) {
      if (initialWindowOpen && chosen && !this.filePath) void this.host.releaseDocumentPath?.(chosen).catch(() => {});
      const problem = `Could not open the map: ${err instanceof Error ? err.message : String(err)}`;
      const snapshot = path && readFailed ? await latestSnapshotForPath(path) : undefined;
      if (snapshot) {
        const choice = await this.ask('Map could not be opened', problem + ' A local snapshot is available.',
          [{ id: 'copy', label: 'Open snapshot as copy', primary: true }, { id: 'cancel', label: 'Cancel' }]);
        if (choice === 'copy') await this.restoreSnapshot(snapshot, true);
      } else this.say(problem, 'error');
    }
  }

  private writeInOrder(write: () => Promise<void>): Promise<void> {
    const pending = this.pendingWrite.then(write);
    this.pendingWrite = pending.catch(() => {});
    return pending;
  }

  private discardCurrentRecovery(): void {
    if (!this.dirty) return;
    const id = this.doc.id;
    const path = this.filePath;
    void this.writeInOrder(() => this.discardRecoveryState(id, path)).catch(() => {
      this.say('Could not remove the previous recovery copy.', 'error');
    });
  }

  private async discardRecoveryState(docId: string, path?: string | null, recoveryKey?: string): Promise<void> {
    await this.host.docDiscardRecovery(recoveryKey ?? docId, recoveryKey ? null : path);
    await discardRecoveryUndo(docId, path);
  }

  async save(forceAs = false): Promise<boolean> {
    if (this.saving) return false;
    this.saving = true;
    let resumeEdits: (() => void) | undefined;
    try {
      this.endEdit();
      if (!(await this.editor.settled(true))) return false;
      const doc = this.doc;
      let path = this.filePath;
      if (!path || forceAs) {
        path = await this.host.pickSavePath(this.doc.title || 'Untitled');
        if (!path || this.doc !== doc) return false;
      }
      if (!this.filePath) {
        const name = stem(path);
        if (name && name !== this.doc.title) this.apply('Rename Map', [{ t: 'docMeta', patch: { title: name } }]);
      }
      if (!(await this.editor.settled(true)) || this.doc !== doc) return false;
      resumeEdits = this.editor.hold();
      this.saveText = 'Saving…';
      const revision = this.rev;
      const json = serializeDoc(this.documentWithLayout());
      const history = this.editor.exportHistory(STORED_UNDO_LIMIT);
      const change = this.editor.historySummary(1).applied[0];
      const checkpoint = !this.editor.hasOpenGroup;
      const destination = path;
      let savedPath = destination;
      const recoveryPath = this.filePath;
      clearTimeout(this.autosaveTimer);
      await this.writeInOrder(async () => {
        savedPath = await this.host.docSave(destination, json) ?? destination;
        await saveUndo(doc.id, 'saved', json, history).catch(() => {});
        if (recoveryPath !== savedPath) await this.host.docDiscardRecovery(doc.id, recoveryPath).catch(() => {});
        await discardRecoveryUndo(doc.id, recoveryPath).catch(() => {});
        linkReviewMapPath(doc.id, savedPath);
        if (checkpoint) await storeSnapshot(doc.id, json, 'Saved ' + fmtTime(), true, change, savedPath).catch(() => {});
      });
      if (this.doc !== doc) return false;
      this.filePath = savedPath;
      void this.host.noteDocument?.(savedPath).catch(() => {});
      this.recent=rememberRecent(savedPath);
      if (revision !== this.rev) {
        if (!this.host.docCommit) this.queueAutosave();
        return false;
      }
      this.dirty = false;
      clearTimeout(this.autosaveTimer);
      this.saveText = `Saved ${fmtTime()}`;
      return true;
    } catch (err) {
      this.saveText = '';
      if (this.dirty) this.queueAutosave();
      this.say(`Could not save: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    } finally {
      this.saving = false;
      resumeEdits?.();
    }
  }

  private async journalChange(change: EditorChange): Promise<void> {
    const doc = change.doc;
    const path = this.filePath;
    this.saveText = 'Saving edit…';
    try {
      // The editor holds later edits until this commit is written, so the document cannot change meanwhile. Writing
      // the whole document is long on a big map: let the next frame request the layout first.
      await afterNextFrame();
      const json = serializeDoc(doc);
      const operation = encodeJournalChange(change);
      const history = this.editor.exportHistory(STORED_UNDO_LIMIT);
      const revision = this.rev;
      const commit = this.host.docCommit!.bind(this.host);
      await this.writeInOrder(async () => {
        const savedInMap = await commit(doc.id, json, path, operation);
        if (this.doc === doc && this.rev === revision) {
          if (savedInMap) this.dirty = false;
          this.saveText = (savedInMap ? 'Autosaved ' : 'Recovery saved ') + fmtTime();
        }
        await saveUndo(doc.id, savedInMap ? 'saved' : 'recovery', json, history, path).catch(() => {});
      });
    } catch (error) {
      if (this.doc === doc) this.saveText = 'Autosave failed';
      this.say('Could not write the edit. Save to retry pending edits.', 'error');
      throw error;
    }
  }

  private queueAutosave(): void {
    clearTimeout(this.autosaveTimer);
    this.saveText = 'Unsaved changes';
    // Capture once at the end of this event, which can apply several streamed node operations.
    this.autosaveTimer = window.setTimeout(() => { void this.persistRecovery(); }, 0);
  }

  private async persistRecovery(): Promise<boolean> {
    if (!this.dirty) return false;
    const doc = this.doc;
    const revision = this.rev;
    if (this.needLayout) {
      await new Promise<void>((settled) => {
        this.layoutWaiters.add(settled);
        if (document.hidden) this.flush(false);
        else this.schedule();
      });
      if (this.needLayout || this.doc !== doc || this.rev !== revision) return false;
    }
    // Serialising and hashing a big map takes tens of ms: do it after the frame that shows the edit. A later edit
    // queues its own autosave.
    await afterNextFrame();
    if (this.needLayout || this.doc !== doc || this.rev !== revision) return false;
    const id = doc.id;
    const json = serializeDoc({ ...doc, layoutPlacements: this.pipeline?.placements });
    const history = this.editor.exportHistory(STORED_UNDO_LIMIT);
    const path = this.filePath;
    try {
      await this.writeInOrder(async () => {
        await Promise.all([
          this.host.docAutosave(id, json, path),
          saveUndo(id, 'recovery', json, history, path)
        ]);
      });
      if (this.doc === doc && this.rev === revision && this.dirty) this.saveText = `Autosaved ${fmtTime()}`;
      return true;
    } catch {
      if (this.doc === doc && this.rev === revision && this.dirty) this.saveText = 'Autosave failed';
      return false;
    }
  }

  async checkDesktopSession(): Promise<void> {
    try { this.desktopSession = await this.host.desktopSession?.() ?? []; }
    catch { this.desktopSession = []; }
  }

  async finishDesktopSession(reopen: boolean): Promise<void> {
    this.desktopSession = [];
    try { await this.host.finishDesktopSession?.(reopen); }
    catch (error) { this.say(String(error), 'error'); }
  }

  async checkRecovery(): Promise<void> {
    if (this.host.isRecoveryWindow && !this.host.isRecoveryWindow()) return;
    try {
      const list = await this.host.docRecover();
      this.recovery = list.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    } catch {
      /* ignore */
    }
  }

  async restoreRecovered(asCopy = false): Promise<void> {
    const r = this.recovery[0];
    if (!r || !(await this.confirmDiscard('restore a recovered map'))) return;
    const previous = this.doc;
    const revision = this.rev;
    try {
      const { doc, repairs } = parseDocReport(r.docJson);
      const history = repairs.length ? undefined : await loadUndo(doc.id, 'recovery', r.docJson, r.path);
      if (this.recovery[0] !== r || this.doc !== previous || this.rev !== revision) return;
      const copy = asCopy || Boolean(r.conflict);
      let path = copy ? null : r.path;
      if (path && this.host.claimDocumentPath) {
        try { path = await this.host.claimDocumentPath(path); }
        catch (error) { this.say(String(error), 'error'); return; }
      }
      if (path && r.baseRevision) {
        await this.host.expectRecoveryRevision?.(path, r.baseRevision);
      }
      if (copy) doc.id = newId();
      this.loadDoc(doc, path, true, history);
      if (copy) {
        if (await this.persistRecovery()) {
          await this.discardRecoveryState(r.docId, r.path, r.recoveryKey).catch(() => {});
        } else {
          this.say('Save this recovered copy to keep it. The original recovery copy is still on disk.', 'error');
          return;
        }
      } else {
        this.queueAutosave();
      }
    } catch (err) {
      this.say(`Could not restore the map: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    this.recovery = this.recovery.filter((item) => item !== r);
  }

  async discardRecovered(): Promise<void> {
    const r = this.recovery[0];
    if (!r) return;
    this.recovery = this.recovery.slice(1);
    try {
      await this.writeInOrder(() => this.discardRecoveryState(r.docId, r.path, r.recoveryKey));
    } catch {
      /* ignore */
    }
  }

  private noteBrokenLink(link: string, reason?: 'file' | 'node'): void {
    if (this.brokenMapLinks.get(link) === reason) return;
    const next = new Map(this.brokenMapLinks);
    if (reason) next.set(link, reason);
    else next.delete(link);
    this.brokenMapLinks = next;
  }

  async checkMapLink(link: string): Promise<boolean> {
    const target = parseMapLink(link);
    if (!target) return true;
    const exists = await this.host.docExists(target.path);
    if (!exists) this.noteBrokenLink(link, 'file');
    else if (this.brokenMapLinks.get(link) === 'file') this.noteBrokenLink(link);
    return exists;
  }

  revealAlias(id: NodeId): void {
    this.revealLinkedNode(id);
  }

  private revealLinkedNode(id: NodeId): boolean {
    if (!this.doc.nodes[id]) return false;
    this.selectFromOutline(id);
    // A folded ancestor must be opened before a specific target can be reached.
    const parents: NodeId[] = [];
    for (let parent = this.doc.nodes[id].parent; parent; parent = this.doc.nodes[parent].parent) {
      if (this.doc.nodes[parent].collapsed) parents.push(parent);
    }
    if (parents.length) {
      const edit = toggleCollapsed(this.doc, parents, false);
      if (edit) this.editor.apply(edit.tx);
      this.flush();
      this.centerOn(id);
    }
    return true;
  }

  private async navigateMapLink({ path, node, origin }: MapLinkNavigation): Promise<MapLinkResult> {
    if (this.filePath !== path) {
      const previous = this.doc;
      const trail = this.mapLinkTrail;
      const routed = await this.host.routeOpenMapLink?.({ path, node, origin }) ?? 'closed';
      if (routed === 'opened' || routed === 'missingNode' || routed === 'unavailable') return routed;
      if (this.doc !== previous) return 'unavailable';
      if (routed === 'closed') {
        await this.openDoc(path, true);
        if (this.doc === previous) return 'unavailable';
        if (origin) this.mapLinkTrail = [...trail, origin].slice(-24);
      }
    }
    return !node || this.revealLinkedNode(node) ? 'opened' : 'missingNode';
  }

  async followNodeLink(value: string, originId: NodeId | null = this.focusId): Promise<void> {
    try {
      const target = parseMapLink(value);
      if (!target) return await this.host.openNodeUrl(parseNodeLink(value));
      const source = this.doc;
      if (!(await this.checkMapLink(value))) {
        this.say(`Broken map link. Could not find ${basename(target.path)}.`, 'error');
        return;
      }
      if (this.doc !== source) return;
      const origin = this.filePath ? { path: this.filePath, node: originId, title: this.docTitle } : null;
      const result = await this.navigateMapLink({ ...target, origin });
      if (result === 'missingNode') {
        this.noteBrokenLink(value, 'node');
        this.say('Broken node link. The target node could not be found in this map.', 'error');
      } else if (result === 'opened') this.noteBrokenLink(value);
    } catch (error) {
      this.say(`Could not open the link: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async backFromMapLink(): Promise<void> {
    const trail = this.mapLinkTrail;
    const entry = trail.at(-1);
    if (!entry) return;
    try {
      const result = await this.navigateMapLink(entry);
      if (result === 'missingNode') {
        if (await this.navigateMapLink({ path: entry.path }) !== 'opened') return;
        this.say('The original node has been removed.', 'info');
      }
      if (result !== 'unavailable') this.mapLinkTrail = trail.slice(0, -1);
    } catch (error) {
      this.say(`Could not return to the map: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async chooseLinkedMap(id: NodeId): Promise<void> {
    const doc = this.doc;
    try {
      const path = await this.host.pickOpenPath();
      if (path && this.doc === doc && doc.nodes[id]) this.apply('Link to Map', [{ t: 'set', id, patch: { link: mapLink(path) } }]);
    } catch (error) {
      this.say(`Could not link the map: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async copyMapNodeLink(id: NodeId | null = this.focusId): Promise<void> {
    if (!this.filePath) {
      this.say('Save this map first to copy a link to it.', 'info');
      return;
    }
    try {
      await navigator.clipboard.writeText(mapLink(this.filePath, id ?? undefined));
      this.say(id ? 'Copied the link to this node.' : 'Copied the link to this map.', 'info');
    } catch (error) {
      this.say(`Could not copy the map link: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  async extractBranch(id: NodeId | null = this.focusId): Promise<void> {
    if (!id || !this.doc.nodes[id]) {
      this.say('Select the branch you want to move.', 'info');
      return;
    }
    const doc = this.doc;
    this.endEdit();
    if (!(await this.editor.settled(true)) || this.doc !== doc) return;
    if (!this.filePath && !(await this.save())) return;
    const source = this.filePath;
    if (!source || this.doc !== doc || !doc.nodes[id]) return;
    const revision = this.rev;
    try {
      const destination = await this.host.pickSavePath(doc.nodes[id].text.trim() || 'Linked branch');
      if (!destination || this.doc !== doc || this.rev !== revision) return;
      const { target, sourceOps } = extractLinkedBranch(doc, id, source, destination);
      target.title = stem(destination) || target.title;
      await this.host.docCreate(destination, serializeDoc(target));
      this.recent = rememberRecent(destination);
      void this.host.noteDocument?.(destination).catch(() => {});
      if (!(await this.editor.settled()) || this.doc !== doc || this.rev !== revision || this.filePath !== source) {
        this.say('Saved the new map. The source changed before the branch could be replaced.', 'info');
        return;
      }
      this.apply('Move Branch to Linked Map', sourceOps);
      this.select([id]);
      if (!(await this.editor.settled())) {
        this.say('The new map was saved. Save the source map to retry writing its link.', 'error');
        return;
      }
      this.say(`Moved the branch to ${basename(destination)} and left a link here.`, 'info');
    } catch (error) {
      this.say(`Could not move the branch: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }

  private async acceptImportedMap(doc: Doc, assets: Awaited<ReturnType<typeof readPortableMap>>['assets']): Promise<boolean> {
    if (!(await this.confirmDiscard('open the imported map'))) return false;
    const previous = this.doc;
    const revision = this.rev;
    for (const { hash, bytes, mime, meta } of assets) {
      if (await this.host.assetPut(bytes, mime, meta) !== hash) throw new Error('The asset store could not verify a bundle asset.');
    }
    if (this.doc !== previous || this.rev !== revision) throw new Error('The current map changed during import. Try again.');
    this.discardCurrentRecovery();
    doc.id = newId();
    this.loadDoc(doc, null, true);
    this.queueAutosave();
    return true;
  }

  private async reportImport(
    name: string, format: ImportFormat, skipped: string[], apply: () => boolean | Promise<boolean>
  ): Promise<void> {
    if (this.dialog) return;
    const details = [...new Set(skipped)].filter(Boolean).sort();
    const notice = importNotices[format];
    const choice = await this.ask(`Import ${name}?`, notice, [
      { id: 'cancel', label: 'Cancel' }, { id: 'import', label: 'Import', primary: true },
    ], details);
    if (choice !== 'import' || !(await apply())) return;
    await this.ask(`Imported ${name}`, notice, [{ id: 'done', label: 'Done', primary: true }], details);
  }

  async importFolder(): Promise<void> {
    try {
      const files = await this.host.readPortableDirectory();
      if (!files) return;
      const { doc, skipped, assets } = await readPortableFiles(files);
      await this.reportImport(doc.title || 'portable folder', 'bundle', skipped, () => this.acceptImportedMap(doc, assets));
    } catch (err) {
      this.say(`Could not import the folder: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async importFile(chosen?: string): Promise<void> {
    try {
      const path = chosen ?? await this.host.pickImportPath();
      if (!path) return;
      const name = basename(path);
      const ext = extOf(path);
      if (ext === 'mindnode' || ext === 'zip') {
        const bytes = await this.host.readBinaryFile(path);
        let format: ImportFormat = ext === 'mindnode' ? 'mindnode' : 'bundle';
        const { doc, skipped, assets } = ext === 'mindnode'
          ? await parseMindNode(bytes, stem(path), this.host)
          : await readPortableMap(bytes).catch((error) => {
            if (!isMindNodeArchive(bytes)) throw error;
            format = 'mindnode';
            return parseMindNode(bytes, stem(path), this.host);
          });
        await this.reportImport(name, format, skipped, () => this.acceptImportedMap(doc, assets));
        return;
      }
      if (ext === 'canvas') {
        const { doc, skipped } = parseJsonCanvas(await this.host.readTextFile(path), stem(path));
        await this.reportImport(name, 'canvas', skipped, () => this.acceptImportedMap(doc, []));
        return;
      }
      if (ext === 'json') {
        const { doc, repairs } = parseDocReport(await this.host.readTextFile(path));
        const hashes = [...imageReferences(doc).keys()];
        let missing = 0;
        for (let offset = 0; offset < hashes.length; offset += 16) {
          const batch = await Promise.allSettled(hashes.slice(offset, offset + 16).map((hash) => this.host.assetUrl(hash)));
          missing += batch.filter((item) => item.status === 'rejected').length;
        }
        if (missing) repairs.push(`${missing} referenced artwork asset${missing === 1 ? ' is' : 's are'} unavailable in the local store.`);
        await this.reportImport(name, 'json', repairs, () => this.acceptImportedMap(doc, []));
        return;
      }
      const format = ext === 'mm' ? 'freemind' : ext === 'opml' ? 'opml' : ext === 'txt' ? 'text' : ext === 'xmind' ? 'xmind' : 'markdown';
      let result: { nodes: OutlineNode[]; title?: string; skipped?: string[] };
      if (format === 'xmind') result = parseXmind(await this.host.readBinaryFile(path));
      else {
        const text = await this.host.readTextFile(path);
        switch (format) {
          case 'freemind': result = parseFreeMind(text); break;
          case 'opml': result = parseOpml(text); break;
          case 'text': result = { nodes: parseIndentedText(text) }; break;
          case 'markdown': {
            const skipped = new Set<string>();
            result = { nodes: parseMarkdownOutline(text, skipped), skipped: [...skipped] };
            break;
          }
        }
      }
      if (!result.nodes.length) {
        this.say('That file has no outline to import.', 'info');
        return;
      }
      if (format !== 'text') {
        const doc = docFromOutlines(result.title || stem(path), result.nodes);
        await this.reportImport(name, format, result.skipped ?? [], () => this.acceptImportedMap(doc, []));
        return;
      }
      await this.reportImport(name, format, result.skipped ?? [], async () => {
        this.endEdit();
        if (!(await this.editor.settled())) throw new Error('Pending edits could not be saved. Retry the import after saving.');
        this.importOutline(result.title || stem(path), result.nodes);
        return true;
      });
    } catch (err) {
      this.say(`Could not import: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  async copyMarkdown(): Promise<void> {
    const nodes = this.doc.roots.map((r) => outlineFromDoc(this.doc, r));
    const md = toMarkdownOutline(nodes, { headingLevels: 2 });
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = md;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    this.say('Copied the map as Markdown.', 'info');
  }

  // ====================================================================== host events

  private bindHost(): void {
    const h = this.host;
    if (h.onQuickCapture) void h.onQuickCapture(async ({ path, id, text }) => {
      const doc = this.doc;
      const modalOpen = () => this.dialog || document.querySelector('dialog:modal');
      const reject = (message: string) => ({ kind: 'rejected' as const, message });
      if (this.filePath !== path || this.quitPending || this.busy || modalOpen() || this.editor.hasOpenGroup) {
        return reject('The map window is busy or has moved to another map. Try again.');
      }
      this.endEdit();
      const ready = await this.editor.settled(true);
      if (!ready || this.doc !== doc || this.filePath !== path || this.quitPending || this.busy || modalOpen() || this.editor.hasOpenGroup) {
        return reject('The map could not finish saving its earlier edits. Keep it open and retry.');
      }
      const existing = doc.nodes[id];
      if (existing && existing.text !== text) return reject('This capture was already added and its text changed.');
      if (!existing) {
        const root = doc.nodes[doc.roots[0]];
        if (!root) return reject('The map has no main topic to capture into.');
        this.editor.apply({
          ops: [{ t: 'insert', node: { id, parent: root.id, children: [], text, origin: { by: 'user' } },
            parent: root.id, index: root.children.length }],
          label: 'Quick Capture', source: 'user'
        });
      }
      if (!(await this.editor.settled())) {
        return reject('The node is in the map window, but saving failed. Keep the map open and retry.');
      }
      return { kind: this.dirty ? 'recovery' : 'saved' };
    }).then((stop) => this.cleanups.push(stop)).catch(() => {});
    if (h.onFileDrop) {
      void h.onFileDrop((paths, point) => { void this.onNativeDrop(paths, point); })
        .then((unlisten) => this.cleanups.push(unlisten)).catch(() => {});
    }
    if (h.onCloseRequest) void h.onCloseRequest(async () => {
      if (this.busy) {
        this.say('Finish or cancel generation before closing the map.');
        return false;
      }
      if (this.quitPending || this.dialog || document.querySelector('dialog:modal')) return false;
      this.endEdit();
      if (!(await this.confirmDiscard('close the window'))) return false;
      clearTimeout(this.autosaveTimer);
      await this.pendingWrite;
      if (this.dirty) await this.writeInOrder(() => this.discardRecoveryState(this.doc.id, this.filePath));
      return true;
    }).then(stop => this.cleanups.push(stop));
    if (h.onMapLink) void h.onMapLink(({ path, node, origin }) => {
      if (this.filePath !== path || this.dialog || this.quitPending) return 'unavailable';
      if (node && !this.revealLinkedNode(node)) return 'missingNode';
      if (origin) this.mapLinkTrail = [...this.mapLinkTrail, origin].slice(-24);
      return 'opened';
    }).then(stop => this.cleanups.push(stop));
    const listenForOpen = () => {
      if (h.onOpenFile) void h.onOpenFile(path => this.openDoc(path, true, true)).then(stop => this.cleanups.push(stop));
    };
    if (h.onQuitRequest) void h.onQuitRequest(async () => {
      if (this.busy) {
        this.say('Finish or cancel generation before quitting Radiant.');
        return { approved: false };
      }
      if (this.dialog || document.querySelector('dialog:modal')) return { approved: false };
      this.endEdit();
      if (!(await this.confirmDiscard('quit Radiant'))) return { approved: false };
      this.quitPending = true;
      clearTimeout(this.autosaveTimer);
      await this.pendingWrite;
      return { approved: true, discard: this.dirty ? { docId: this.doc.id, path: this.filePath } : undefined };
    }, () => {
      this.quitPending = false;
      if (this.dirty) this.queueAutosave();
    }).then(stop => { this.cleanups.push(stop); listenForOpen(); }).catch(() => listenForOpen());
    else listenForOpen();
    void h.onAiEvent((e) => {
      if (e.kind === 'error') recordDiagnostic(h, codexDiagnostic(e.code));
      this.onAiEvent(e);
    }).then((u) => this.cleanups.push(u));
    void h.onAiQueue?.((queue) => { this.aiQueue = queue; })
      .then((off) => this.cleanups.push(off)).catch(() => {});
    if (typeof h.onMenu === 'function') {
      void h.onMenu((id) => {
        if (!this.quitPending && !document.querySelector('dialog:modal')) void this.command(id);
      }).then((u) => this.cleanups.push(u));
    }
  }

  async refreshAiStatus(refreshLimits = false): Promise<void> {
    const offline = () => !this.isBrowser && typeof navigator !== 'undefined' && navigator.onLine === false;
    const offlineStatus: AiStatus = { available: false, errorCode: 'offline', error: friendlyAiError('offline', '') };
    if (offline()) {
      this.aiStatus = offlineStatus;
      return;
    }
    try {
      const status = await this.host.aiStatus(refreshLimits);
      this.aiStatus = offline() ? offlineStatus : status;
    } catch (err) {
      this.aiStatus = offline() ? offlineStatus : { available: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ====================================================================== AI

  private nextFreePosition(): Vec2 {
    this.flush();
    const b = this.pipeline.layout.bounds;
    return { x: b.x + b.w + 380, y: b.y + b.h / 2 };
  }

  get aiAllowanceError(): string | undefined {
    const code = blockedAiAllowance(this.aiStatus?.rateLimits);
    return code ? friendlyAiError(code, '', this.aiStatus?.rateLimits) : undefined;
  }

  private async aiReady(allowFallback = false): Promise<boolean> {
    await this.refreshAiStatus();
    if (this.aiAllowanceError) {
      this.say(this.aiAllowanceError, 'info');
      return false;
    }
    if (this.aiStatus?.available || (allowFallback && this.aiStatus?.fallbackAvailable)) return true;
    const err = this.aiStatus?.error ?? '';
    const code = this.aiStatus?.errorCode ?? (/not installed|not found|no such file/i.test(err)
      ? 'not_installed'
      : /log ?in|sign|auth/i.test(err)
        ? 'not_logged_in'
        : 'other');
    recordDiagnostic(this.host, codexDiagnostic(code));
    this.say(friendlyAiError(code, err), 'error');
    return false;
  }

  async rerunTextJob(job: AiJobRecord, prompt: string, topic: string): Promise<void> {
    if (!prompt.trim() || prompt.length > AI_PROMPT_LIMIT || this.busy) return;
    if (job.kind === 'generate') {
      await this.generate(job.route === 'exec', { job, prompt, topic });
    } else if (job.kind === 'expand' && job.scopeId && this.doc.nodes[job.scopeId]) {
      await this.expandSelected({ job, prompt });
    }
  }

  keepGeneratedDraft(id: NodeId): void {
    if (this.editor.defer(() => this.keepGeneratedDraft(id))) return;
    if (this.doc.nodes[id]?.generatedDraft) {
      this.apply('Keep Generated Draft', [{ t: 'set', id, patch: { generatedDraft: undefined } }]);
    }
  }

  async generate(preferExecFallback = false, previous?: { job: AiJobRecord; prompt: string; topic: string }, webSearch = false): Promise<void> {
    if (this.busy) return;
    const anchor = previous ? null : this.generateNodeId;
    if (anchor) return this.expandSelected(undefined, this.growRequest(anchor));
    const topic = (previous?.topic ?? this.topic).trim();
    if (!topic) {
      this.say('Type a topic first, for example "Photosynthesis".', 'info');
      return;
    }
    const before = this.doc;
    const allowFallback = !previous || previous.job.route === 'exec' || !!previous.job.fallbackPrompt && previous.prompt === previous.job.prompt;
    if (!(await this.aiReady(allowFallback)) || this.busy || before !== this.doc) return;
    this.endEdit();
    const empty = isEmptyDoc(this.doc);
    const style: StyleSheet = { request: previous
      ? (/^Style request: (.+)$/m.exec(previous.prompt)?.[1] ?? '')
      : this.styleText.trim() };
    const request: Omit<AiTurnRequest, 'kind'> = previous ? {
      prompt: previous.prompt,
      instructions: previous.job.route === 'exec' ? '' : previous.job.instructions ?? '',
      templateVersion: previous.job.templateVersion,
      execFallbackPrompt: previous.job.route === 'exec' ? previous.prompt
        : previous.prompt === previous.job.prompt ? previous.job.fallbackPrompt : undefined,
      model: previous.job.route === 'replay' ? undefined : previous.job.model,
      effort: previous.job.effort ?? 'low',
      webSearch
    } : { ...this.generationPrompt(), effort: 'low', webSearch };
    const placeholder = empty ? this.doc.roots[0] : null;
    const position = empty ? { ...this.doc.rootInfo[this.doc.roots[0]].position } : this.nextFreePosition();
    const run: AiRun = {
      journal: new StreamJournal(),
      changes: new AiChanges(),
      userTouched: new Set(),
      id: null,
      kind: 'generate',
      repair: new MapRepair(),
      limits: previous?.job.limits ?? generationLimits(this),
      studyPercent: this.generateStudy ? (this.generateStudyShare ?? 35) : undefined,
      buf: [],
      topic,
      styleRequest: style.request,
      attach: { kind: 'newRoot', position },
      placeholder,
      targetId: null,
      parser: null,
      applier: null,
      group: null,
      sheet: {},
      firstApplied: false,
      autoFit: true,
      lastFit: 0,
      fitTimer: 0,
      heuristicTheme: themeFromText(style.request)
    };
    this.sentMapRepairs = [];
    await this.startRun(run, { kind: 'text', ...request, mapLimits: run.limits, preferExecFallback, repairMap: !!this.host.aiResolveMapRound });
  }

  /** The request that grows new nodes under one node: Expand asks for one level, Generate at a node for several. */
  private expandRequest(id: NodeId, grow?: GrowRequest, most = 4) {
    const doc = this.doc;
    const node = doc.nodes[id];
    if (!node) return null;
    const path: string[] = [];
    for (let p: NodeId | null = id; p; p = doc.nodes[p]?.parent ?? null) path.unshift(doc.nodes[p].text || '(empty)');
    const par = node.parent ? doc.nodes[node.parent] : null;
    const root = doc.nodes[rootOf(doc, id)];
    const generated = root?.origin?.by === 'ai' ? doc.aiJobs?.[root.origin.job] : undefined;
    // Generate at a node always adds a few branches, even beside many existing children.
    const count = grow
      ? Math.max(Math.min(grow.breadth, 3), grow.breadth - node.children.length)
      : Math.min(most, (generated?.limits?.maxChildren ?? this.breadth) - node.children.length);
    if (count <= 0) return { count, request: null };
    const request = buildExpandPrompt(
      {
        nodeId: id,
        path,
        nodeText: node.text || '(empty)',
        existingChildren: node.children.map((c) => doc.nodes[c].text),
        siblings: par ? par.children.filter((c) => c !== id).map((c) => doc.nodes[c].text) : [],
        note: node.note
      },
      { request: root?.generatedStyle?.request || this.theme.name },
      count,
      grow ? { depth: grow.depth, focus: grow.focus, audience: this.audience } : {}
    );
    return { count, request };
  }

  async expandSelected(previous?: { job: AiJobRecord; prompt: string }, grow?: GrowRequest): Promise<void> {
    const id = previous?.job.scopeId ?? grow?.id ?? this.focusId;
    if (!id) {
      this.say('Select a node to expand with AI.', 'info');
      return;
    }
    if (this.busy) return;
    const before = this.doc;
    if (!(await this.aiReady()) || this.busy || before !== this.doc) return;
    this.endEdit();
    const doc = this.doc;
    const node = doc.nodes[id];
    if (!node) return;
    const planned = this.expandRequest(id, grow, previous?.job.limits?.maxChildren ?? 4);
    if (!planned) return;
    const { count } = planned;
    if (count <= 0 || !planned.request) {
      this.say('This node already has the maximum number of children for expansion.', 'info');
      return;
    }
    const request: Omit<AiTurnRequest, 'kind'> = previous ? {
      instructions: previous.job.instructions ?? '', prompt: previous.prompt, templateVersion: previous.job.templateVersion,
      model: previous.job.route === 'replay' ? undefined : previous.job.model, effort: previous.job.effort ?? 'low'
    } : planned.request;
    if (this.inspectMapRepairs) {
      const revision = this.rev;
      const approval = await this.ask('Review node expansion', 'What will be sent for the selected node', [
        { id: 'cancel', label: 'Cancel' },
        { id: 'send', label: 'Send expansion request', primary: true }
      ], undefined, `${request.instructions}\n\n${request.prompt}`);
      if (approval !== 'send' || this.doc !== doc || this.rev !== revision || this.busy) return;
      if (!(await this.aiReady()) || this.doc !== doc || this.rev !== revision || this.busy) return;
    }
    const run: AiRun = {
      journal: new StreamJournal(),
      changes: new AiChanges(),
      userTouched: new Set(),
      id: null,
      kind: 'expand',
      limits: {
        maxDepth: grow?.depth ?? previous?.job.limits?.maxDepth ?? 1,
        maxChildren: grow ? Math.max(count, grow.breadth) : count
      },
      buf: [],
      topic: grow?.focus || node.text,
      styleRequest: '',
      attach: { kind: 'existing', parentId: id },
      placeholder: null,
      targetId: id,
      fromPrompt: !!grow,
      parser: null,
      applier: null,
      group: null,
      sheet: {},
      firstApplied: false,
      autoFit: !!grow,
      lastFit: 0,
      fitTimer: 0,
      heuristicTheme: null
    };
    await this.startRun(run, { kind: 'text', effort: 'low', ...request, mapLimits: run.limits });
  }

  private async startRun(
    run: AiRun,
    req: AiTurnRequest
  ): Promise<void> {
    run.provenance = parseAiJobRecord(captureAiJob(run.kind, req, run.targetId ?? undefined, run.limits));
    if (!run.provenance) {
      this.say('The AI prompt is too large to store with the map.', 'error');
      return;
    }
    const liveGrowth = this.aiStatus?.capabilities?.streaming === true && !req.preferExecFallback;
    if (!liveGrowth) {
      req = { ...req, repairMap: false };
      run.buffered = true;
    }
    this.run = run;
    this.gen = { kind: run.kind, status: 'starting', nodes: 0, liveGrowth, startedAt: Date.now(), webSearch: req.webSearch };
    if (run.kind === 'expand' && liveGrowth) this.startPulse();
    // user interaction with the camera stops the gentle auto-fit
    const stop = () => (run.autoFit = false);
    this.canvas.addEventListener('wheel', stop, { once: true });
    this.canvas.addEventListener('pointerdown', stop, { once: true });
    run.stopFit = () => {
      this.canvas.removeEventListener('wheel', stop);
      this.canvas.removeEventListener('pointerdown', stop);
    };
    try {
      const id = await this.host.aiStartTurn(req);
      if (this.run !== run) {
        await this.host.aiCancel(id);
        return;
      }
      run.id = id;
      this.jobs = registerJob(this.jobs, id, run.kind === 'generate' ? 'generate' : 'expand', Date.now(), {
        templateVersion: req.templateVersion, instructions: req.instructions, prompt: req.prompt, execFallbackPrompt: req.execFallbackPrompt, webSearch: req.webSearch
      });
      this.beginRun(run, id);
      for (const e of run.buf.splice(0)) if (e.jobId === id) this.handleRunEvent(run, e);
    } catch (err) {
      if (this.run === run) this.failRun(run, 'other', err instanceof Error ? err.message : String(err));
    }
  }

  private beginRun(run: AiRun, id: string): void {
    this.snapshotBeforeAi(run.kind === 'generate' ? 'Before AI generation' : 'Before AI expansion');
    const source = { ai: id };
    run.group = this.editor.beginGroup(run.kind === 'generate' ? 'AI Generate' : 'AI Expand', source, { interleaveAppends: true });
    run.applier = new StreamApplier({
      idGen: newId,
      jobId: id,
      attachTo:
        run.attach.kind === 'newRoot'
          ? { kind: 'newRoot', position: run.attach.position }
          : { kind: 'existing', parentId: run.attach.parentId },
      existingIds: new Set(Object.keys(this.doc.nodes)),
      maxNodes: 400,
      ...run.limits
    });
    run.parser = new NodeLineParser({
      onNode: (n, raw, repairSlot) => this.onStreamNode(run, n, raw, repairSlot),
      onStyle: (s) => {
        if (run.repair?.attempts) return;
        run.sheet = { ...run.sheet, ...s };
        if (s.themeId && !run.heuristicTheme) run.heuristicTheme = s.themeId;
      },
      onWarning: (_line, reason) => {
        const job = run.provenance;
        const warnings = job?.warnings ?? [];
        if (!job || warnings.includes(reason) || warnings.length >= AI_JOB_WARNING_LIMIT) return;
        run.provenance = { ...job, warnings: [...warnings, reason] };
        run.pendingWarning = true;
      },
      onError: (line, reason) => {
        run.repair?.reject(line, reason);
        this.jobs = addNodes(this.jobs, id, 0, 1);
      }
    });

  }

  trackAiJob(id: string, kind: AiJobKind): void {
    this.jobs = registerJob(this.jobs, id, kind);
  }

  private onAiEvent(e: AiEvent): void {
    if (e.kind === 'rateLimits') {
      if (this.aiStatus?.capabilities?.rateLimits) this.aiStatus = { ...this.aiStatus, rateLimits: e.rateLimits };
      return;
    }
    this.jobs = applyAiEvent(this.jobs, e);
    const run = this.run;
    if (!run) return;
    if (run.id === null) {
      run.buf.push(e);
      return;
    }
    if (e.jobId !== run.id) return;
    this.handleRunEvent(run, e);
  }

  private handleRunEvent(run: AiRun, e: AiEvent): void {
    if (e.kind === 'rateLimits') return;
    if (this.run !== run) return;
    switch (e.kind) {
      case 'started':
        if (e.route === 'exec') {
          run.buffered = true;
          if (this.gen) this.gen = { ...this.gen, liveGrowth: false };
        }
        if (run.provenance) {
          run.provenance = {
            ...run.provenance, model: e.model ?? run.provenance.model, route: e.route,
            templateVersion: e.templateVersion ?? run.provenance.templateVersion,
            ...(e.route === 'exec' && run.provenance.fallbackPrompt
              ? { prompt: run.provenance.fallbackPrompt, instructions: undefined } : {})
          };
        }
        if (this.gen && this.gen.status === 'starting') this.gen = { ...this.gen, status: 'running' };
        break;
      case 'warning':
        this.say(e.message, 'info');
        break;
      case 'delta':
        if (this.gen && this.gen.status === 'starting') this.gen = { ...this.gen, status: 'running' };
        if (!run.journal.append(e.text, run.buffered ? MAX_BUFFERED_MAP_LENGTH : undefined)) {
          run.parser?.discard();
          if (run.id) void this.host.aiCancel(run.id).catch(() => {});
          this.failRun(run, 'protocol', 'The map response exceeded its size limit.');
        } else if (!run.buffered && this.gen?.status !== 'cancelling') {
          run.parser?.push(run.journal.latest);
        }
        break;
      case 'mapRoundDone':
        run.parser?.end();
        this.resolveMapRound(run);
        break;
      case 'done':
        if (this.gen?.status === 'cancelling') {
          run.parser?.discard();
          this.finishRun(run, 'cancelled');
          break;
        }
        if (e.text !== undefined) {
          if (!run.journal.append(e.text, MAX_BUFFERED_MAP_LENGTH)) {
            run.parser?.discard();
            this.failRun(run, 'protocol', 'The map response exceeded its size limit.');
            break;
          }
          run.parser?.push(run.journal.latest);
        } else if (run.buffered) {
          run.parser?.push(run.journal.text());
        }
        run.parser?.end();
        this.finishRun(run, 'done');
        break;
      case 'cancelled':
        run.parser?.discard();
        this.finishRun(run, 'cancelled');
        break;
      case 'error':
        run.parser?.discard();
        this.failRun(run, e.code, e.message);
        break;
    }
  }

  private resolveMapRound(run: AiRun): void {
    if (this.editor.defer(() => this.resolveMapRound(run))) return;
    if (this.run !== run || !run.id || this.gen?.status === 'cancelling') return;
    const prompt = run.repair?.nextPrompt();
    if (prompt && this.inspectMapRepairs) {
      this.pendingMapRepair = { id: run.id, prompt };
      this.showPrompt = true;
      return;
    }
    this.sendMapRepair(run.id, prompt);
  }

  finishMapRepair(send: boolean): void {
    const pending = this.pendingMapRepair;
    this.pendingMapRepair = null;
    if (!pending || this.run?.id !== pending.id || this.gen?.status === 'cancelling') return;
    this.sendMapRepair(pending.id, send ? pending.prompt : undefined);
  }

  private sendMapRepair(id: string, prompt?: string): void {
    if (prompt) this.say(`Repairing rejected map lines (attempt ${this.run?.repair?.attempts} of 2)…`, 'info');
    void this.host.aiResolveMapRound?.(id, prompt).then(() => {
      if (prompt && (this.run?.id === id || this.doc.aiJobs?.[id])) this.sentMapRepairs = [...this.sentMapRepairs, prompt];
    }).catch(() => {
      // The provider may already have timed out or been cancelled. Its terminal event still owns completion.
    });
  }

  private onStreamNode(run: AiRun, n: Parameters<StreamApplier['push']>[0], raw: string, repairSlot?: number): void {
    if (this.editor.defer(() => this.onStreamNode(run, n, raw, repairSlot))) return;
    if (this.run !== run || this.gen?.status === 'cancelling') return;
    if (run.repair?.attempts && !run.repair.allows(repairSlot, n.id)) {
      if (run.id) this.jobs = addNodes(this.jobs, run.id, 0, 1);
      return;
    }
    const applier = run.applier;
    if (!applier || !run.id) return;
    const parent = n.parent && applier.nodeIdFor(n.parent);
    if (parent && !this.doc.nodes[parent]) {
      this.jobs = addNodes(this.jobs, run.id, 0, 1);
      return;
    }
    const ops = applier.push(n);
    if (!ops.length) {
      const reason = applier.rejected.at(-1)?.reason ?? 'Rejected node';
      run.repair?.reject(raw, reason, n.id, reason === 'unknown parent');
      this.jobs = addNodes(this.jobs, run.id, 0, 1);
      return;
    }
    const ins = ops[0];
    const placeholder = run.placeholder && !run.userTouched.has(run.placeholder) && isEmptyDoc(this.doc)
      ? run.placeholder : null;
    if (ins.t==='insert' && ins.parent===null && ins.rootInfo && run.kind==='generate') {
      if (run.placeholder && !placeholder) ins.rootInfo.position = this.nextFreePosition();
      ins.node.generatedDraft = true;
      const sheet = run.sheet;
      const fixedPreset = FIXED_MAP_PRESETS.has(run.styleRequest.toLowerCase());
      const theme = getTheme(fixedPreset ? run.heuristicTheme ?? this.doc.themeId : sheet.themeId ?? run.heuristicTheme ?? this.doc.themeId);
      const layout = sheet.layout ?? ins.rootInfo.layout;
      const calm = /watercolou?r|aquarelle/i.test(run.styleRequest);
      const palette = calm ? ['#568f99','#89a98a','#bc907b','#868da9'] : theme.branchColors;
      ins.node.generatedStyle = parseGeneratedStyle({
        ...sheet, request: run.styleRequest, themeId: theme.id,
        branch: fixedPreset ? theme.branch : sheet.branch ?? theme.branch,
        shape: sheet.shape ?? theme.shape,
        uppercaseMainBranches: sheet.uppercaseMainBranches ?? theme.uppercaseMainBranches,
        centralImage: theme.centralImage,
        fontFamily: sheet.fontFamily ?? 'system-ui, sans-serif',
        medium: sheet.medium ?? (calm ? 'watercolour' : undefined),
        artPresetId: calm ? 'watercolour' : MAP_ART_PRESETS[theme.id],
        palette: fixedPreset ? palette : sheet.palette ?? palette,
        layout
      });
      ins.rootInfo.layout=layout;
    }
    if (run.provenance && (run.pendingWarning || !Object.hasOwn(this.doc.aiJobs ?? {}, run.id))) {
      run.pendingWarning = false;
      ops.unshift({ t: 'aiJob', id: run.id, value: run.provenance });
    }
    let rootId: NodeId | undefined;
    this.editor.batch(run.kind === 'generate' ? 'AI Generate' : 'AI Expand', { ai: run.id }, builder => {
      builder.addAll(ops);
      if (run.firstApplied || ins.t !== 'insert' || ins.parent !== null) return;
      run.firstApplied = true;
      rootId = ins.node.id;
      if (placeholder && builder.doc.nodes[placeholder]) {
        const edit = deleteSubtree(builder.doc, [placeholder]);
        if (edit) builder.addAll(edit.tx.ops);
      }
      const patch: { title?: string; themeId?: string } = {};
      if (placeholder && run.heuristicTheme && run.heuristicTheme !== builder.doc.themeId &&
          listThemes().some(theme => theme.id === run.heuristicTheme)) patch.themeId = run.heuristicTheme;
      if (builder.doc.title === 'Central topic' || builder.doc.title === '' || placeholder) patch.title = n.title;
      if (Object.keys(patch).length) builder.add({ t: 'docMeta', patch });
    });
    if (ins.t === 'insert' && this.doc.nodes[ins.node.id]) run.journal.recordApplied(ins.node.id, raw);
    if (run.repair?.attempts) run.repair.received(repairSlot);
    this.jobs = addNodes(this.jobs, run.id, 1);
    if (this.gen) this.gen = { ...this.gen, nodes: applier.count };
    if (rootId) this.select([rootId]);
    if (this.gen?.liveGrowth) {
      // Send completed lines from this delta together, before the next frame.
      const doc = this.doc;
      queueMicrotask(() => {
        if (this.doc === doc && this.needLayout) this.flush(false);
      });
      if (rootId && run.autoFit) {
        const position = this.pipeline.box(rootId) ?? this.doc.rootInfo[rootId]?.position;
        if (position) {
          const { x: cx, y: cy } = position;
          const zoom = Math.min(1, Math.max(this.camera.zoom, 0.6));
          const screen = this.camera.worldToScreen(position);
          if (screen.x < 0 || screen.y < 0 || screen.x > this.camera.width || screen.y > this.camera.height) {
            this.camera.set({ cx, cy, zoom });
          } else void this.camera.animateTo({ cx, cy, zoom }, 300);
        }
      }
      this.scheduleFit(run);
    }
  }

  private scheduleFit(run: AiRun, final = false): void {
    // A node grown from the Generate panel keeps the view still, then shows the new branch once it is complete.
    if (!run.autoFit || (run.kind !== 'generate' && !run.fromPrompt) || (run.fromPrompt && !final)) return;
    const now = performance.now();
    const doFit = () => {
      run.fitTimer = 0;
      run.lastFit = performance.now();
      if (!run.autoFit || !run.applier) return;
      const doc = this.doc;
      this.flush(false);
      const fit = () => {
        if (this.doc !== doc || !this.canvas.isConnected || !run.autoFit || !run.applier) return;
        if (run.fromPrompt && run.targetId) {
          const r = this.boundsOf([run.targetId, ...run.applier.created]);
          const { cx, cy, zoom } = this.camera.getState();
          const ins = this.insets();
          const halfW = this.camera.width / 2, halfH = this.camera.height / 2;
          const inView = r && r.x >= cx - (halfW - ins.l) / zoom && r.x + r.w <= cx + (halfW - ins.r) / zoom &&
            r.y >= cy - (halfH - ins.t) / zoom && r.y + r.h <= cy + (halfH - ins.b) / zoom;
          if (r && !inView) this.fitRect(r, zoom, true, 70);
          return;
        }
        const r = this.boundsOf(run.applier.created);
        if (r) this.fitRect(r, 1.1, true, 70);
      };
      if (this.needLayout) this.layoutWaiters.add(fit);
      else fit();
    };
    if (final) {
      clearTimeout(run.fitTimer);
      doFit();
      return;
    }
    if (run.fitTimer) return;
    const wait = Math.max(150, 1100 - (now - run.lastFit));
    run.fitTimer = window.setTimeout(doFit, wait);
  }

  private endRun(run: AiRun, status: 'done' | 'cancelled' | 'error' = 'cancelled'): void {
    if (this.pendingMapRepair?.id === run.id) this.pendingMapRepair = null;
    if (run.provenance && run.id && Object.hasOwn(this.doc.aiJobs ?? {}, run.id)) {
      this.editor.apply({
        ops: [{ t: 'aiJob', id: run.id, value: { ...run.provenance, status, usage: this.jobs[run.id]?.usage } }],
        label: run.kind === 'generate' ? 'AI Generate' : 'AI Expand', source: { ai: run.id }
      });
    }
    clearTimeout(run.fitTimer);
    run.stopFit?.();
    run.group?.end();
    if (this.run === run) this.run = null;
    this.gen = null;
    clearInterval(this.pulseTimer);
    this.markOverlay();
    void this.refreshAiStatus();
  }

  private finishRun(run: AiRun, why: 'done' | 'cancelled'): void {
    if (this.editor.defer(() => this.finishRun(run, why))) return;
    if (this.run !== run) return;
    const count = run.journal.appliedCount;
    const root = run.applier?.rootId;
    if (why === 'done' && run.id && root && run.studyPercent !== undefined) {
      const eligible = new Set(run.applier!.created.filter(id => !run.userTouched.has(id)));
      const ops = createStudyBlanks(this.doc, root, run.studyPercent, eligible);
      this.editor.apply({ ops, source: { ai: run.id }, label: 'AI Generate' });
    }
    this.scheduleFit(run, true);
    this.endRun(run, why);
    this.showAiChanges(run.changes, streamSummaryTitle(run.kind, why !== 'done'));
    const unrepaired = run.repair?.unrepaired ?? 0;
    const repairSummary = unrepaired ? ` ${unrepaired} rejected ${unrepaired === 1 ? 'line remains' : 'lines remain'} unrepaired.` : '';
    if (why === 'cancelled') this.say(count ? `Stopped. Kept the ${count} nodes that had arrived.` : 'Cancelled.', 'info');
    else if (count === 0) this.say('The AI answered, but no usable nodes came back.' + repairSummary + ' Try again with a clearer topic.', 'error');
    else {
      const warnings=root ? this.doc.nodes[root]?.generatedStyle?.warnings : undefined;
      this.say(`Added ${count} nodes.${repairSummary}${warnings?.length ? ' Style defaults used for '+warnings.join(', ')+'.' : ''} Undo removes them all at once.`, 'info');
      if (run.kind === 'generate' || run.fromPrompt) this.showPrompt = false;
    }
  }

  private failRun(run: AiRun, code: string, message: string): void {
    if (this.editor.defer(() => this.failRun(run, code, message))) return;
    if (this.run !== run) return;
    const count = run.journal.appliedCount;
    if (count) this.scheduleFit(run, true);
    if (code === 'stream_interrupted' && run.provenance) run.provenance.interrupted = true;
    this.endRun(run, 'error');
    this.showAiChanges(run.changes, streamSummaryTitle(run.kind, true));
    const text = friendlyAiError(code, message, this.aiStatus?.rateLimits);
    const unrepaired = run.repair?.unrepaired ?? 0;
    const repairSummary = unrepaired ? ` ${unrepaired} rejected ${unrepaired === 1 ? 'line remains' : 'lines remain'} unrepaired.` : '';
    this.say((count ? `${text} Kept the ${count} nodes that arrived.` : text) + repairSummary, 'error');
  }

  async cancelQueuedAi(id: string): Promise<void> {
    if (!this.aiQueue?.jobs.some((job) => job.id === id && job.owned)) return;
    try {
      if (this.run?.id === id) await this.cancelAi();
      else await this.host.aiCancel(id);
    } catch (error) {
      this.say(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async cancelAi(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (this.gen) this.gen = { ...this.gen, status: 'cancelling' };
    run.parser?.discard();
    if (run.id) {
      void this.host.aiCancel(run.id).catch(() => {});
      this.jobs = applyAiEvent(this.jobs, { jobId: run.id, kind: 'cancelled' });
    }
    this.finishRun(run, 'cancelled');
  }

  // ====================================================================== outline panel

  outlineRows(limit = 1500): OutlineRow[] {
    void this.rev;
    const doc = this.doc;
    const rows: OutlineRow[] = [];
    const stack: Array<[NodeId, number]> = [];
    for (let i = doc.roots.length - 1; i >= 0; i--) stack.push([doc.roots[i], 0]);
    while (stack.length && rows.length < limit) {
      const [id, d] = stack.pop() as [NodeId, number];
      const n = doc.nodes[id];
      if (!n) continue;
      rows.push({ id, depth: d, text: n.text, hasChildren: n.children.length > 0, collapsed: !!n.collapsed });
      if (!n.collapsed) for (let i = n.children.length - 1; i >= 0; i--) stack.push([n.children[i], d + 1]);
    }
    return rows;
  }

  selectFromOutline(id: NodeId): void {
    if (this.canvasBranch && id !== this.canvasBranch && !isAncestor(this.doc, this.canvasBranch, id)) {
      this.leaveCanvasView();
    }
    this.endEdit();
    this.select([id]);
    this.centerOn(id);
  }

  // ====================================================================== dev helpers

  /** Dev and benchmark only: replace the map with a synthetic one of about `n` nodes (fixed seed, so the same shape every time). */
  loadSynthetic(n: number, themeId?: string): void {
    let seed = 12345;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let count = 1;
    const mk = (depth: number, label: string): OutlineNode => {
      const node: OutlineNode = { text: label, children: [] };
      if (depth >= 6) return node;
      const k = depth === 0 ? 9 : Math.floor(2 + rnd() * 4);
      for (let i = 0; i < k && count < n; i++) {
        count++;
        node.children.push(mk(depth + 1, `${label.split(' ')[0]} ${depth + 1}.${i + 1}`));
      }
      return node;
    };
    const root = mk(0, 'Big map');
    // top up if the random tree came out small
    while (count < n) {
      const branch = root.children[Math.floor(rnd() * root.children.length)];
      let cur = branch;
      while (cur.children.length && rnd() < 0.85) cur = cur.children[Math.floor(rnd() * cur.children.length)];
      cur.children.push({ text: `Extra ${count}`, children: [] });
      count++;
    }
    this.loadOutline('Big map', root, themeId);
  }

  /** Dev and benchmark only: replace the map with one built from an outline, optionally in a given theme. */
  loadOutline(title: string, root: OutlineNode, themeId?: string): void {
    const d = docFromOutline(title, root);
    if (themeId) d.themeId = themeId;
    this.loadDoc(d, null, false);
    this.dirty = false;
  }

  /** Benchmark: true while a change is still on its way to the screen (layout pending or in a worker, a scheduled
   *  flush, a layout or camera animation, or an uncommitted edit). Read by ui/bench-hooks.ts. */
  get frameWorkPending(): boolean {
    return this.needLayout || this.layoutInFlight !== null || this.rafId !== 0 || this.layoutAnimation !== null ||
      this.camera.animating || this.editor.waitingForCommit;
  }

  /** Dev only: all subtree ids for a node. */
  subtree(id: NodeId): NodeId[] {
    return subtreeIds(this.doc, id);
  }
}

function streamSummaryTitle(kind: AiRun['kind'], partial: boolean): string {
  if (kind === 'generate') return partial ? 'Partial map generation' : 'Map generated';
  return partial ? 'Partial branch expansion' : 'Branch expanded';
}
