import { Camera } from '../render/camera';
import { addChild } from '../core/model/commands';
import {
  autoTour, elementsBounds, nodesInFocusedFrames, playableSteps, resolveStep, shownInEditor, stepNote, stepTitle, stepView,
  DEFAULT_DIM_OPACITY, type StepView, type TourGranularity
} from '../core/model/presentation';
import { createStyleResolver } from '../core/geometry';
import { DEFAULT_ELEMENT_FONT_SIZE } from '../core/geometry/canvas-scene';
import type { CameraState, Doc, NodeBox, NodeId, Presentation, PresentationStep, Rect, Transaction } from '../core/types';
import type { PresenterCommand, PresenterState } from '../host/types';
import { FOLD_DURATION, type MembershipOptions } from './layout-animation';
import type { PresentScope } from './pipeline';
import type { AppController } from './controller.svelte';
import { chord } from './keymap';
import { isTypingTarget } from './util';

/**
 * What the pipeline draws at a step: its nodes at their opacity, plus the canvas elements (CNV-60), the step's focused
 * ones as drawn and the rest dimmed like nodes (or hidden with the nodes). Nodes drawn inside a focused frame count as
 * focus. Shared with the handout export, so pages show what the audience sees.
 */
export function presentScope(doc: Doc, view: StepView, boxes: ReadonlyMap<NodeId, NodeBox> | undefined,
    visible: ReadonlySet<NodeId> = view.visible, opacity: ReadonlyMap<NodeId, number> = view.opacity): PresentScope {
  const scope: PresentScope = { visible, opacity, focus: view.resolved.focus.filter((id) => visible.has(id)) };
  if (!doc.canvas?.elements.length) return scope;
  if (view.elements.size && boxes) {
    const inside = nodesInFocusedFrames(doc, view, boxes).filter((id) => visible.has(id) && (opacity.get(id) ?? 1) < 1);
    if (inside.length) {
      const o = new Map(opacity);
      for (const id of inside) o.set(id, 1);
      scope.opacity = o;
    }
  }
  if (view.elementContext < 1) scope.elements = { focus: view.elements, context: view.elementContext };
  return scope;
}

/** World rectangle a step frames (PRS-06, CNV-60): its frame nodes and its focused canvas elements; null when empty. */
export function stepFrame(doc: Doc, view: StepView, boxes: ReadonlyMap<NodeId, NodeBox>): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const id of view.frame) {
    const b = boxes.get(id);
    if (!b) continue;
    x0 = Math.min(x0, b.x - b.w / 2);
    y0 = Math.min(y0, b.y - b.h / 2);
    x1 = Math.max(x1, b.x + b.w / 2);
    y1 = Math.max(y1, b.y + b.h / 2);
  }
  const els = view.frameElements.length ? elementsBounds(doc, view.frameElements) : null;
  if (els) {
    x0 = Math.min(x0, els.x);
    y0 = Math.min(y0, els.y);
    x1 = Math.max(x1, els.x + els.w);
    y1 = Math.max(y1, els.y + els.h);
  }
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// Presentation engine (implementation spec 6, PRS-02 to 35, 60 to 63). It holds the presentation being played, the
// step and build position, the visited stack and detours, and runs each step transition. Presenting is view state:
// stepping never creates a transaction (PRS-03). Only the capture commands (PRS-33) write to the document.

export type MotionLevel = 'full' | 'gentle' | 'none';
export type CaptureKind = 'question' | 'action' | 'decision';
/** Settings of the automatic tour played when no saved presentation is chosen. */
export interface TourSettings { granularity: TourGranularity; context: 'dim' | 'hide' }

/** What the controller lends the engine; everything else goes through the controller's public surface. */
export interface PresentationHooks {
  /** Enter the presentation canvas view; `previous` is restored on leaving. */
  begin(previous: CameraState): void;
  /** Rebuild the scene now. With `growth`, nodes entering or leaving animate from the frame on screen. */
  refresh(growth: MembershipOptions | null): void;
  /** Cut a running reveal animation to its end. */
  finishGrowth(): void;
  /** Node under a pointer event, among the drawn nodes. */
  hit(e: PointerEvent): NodeId | null;
}

interface Position {
  index: number;
  /** For `build: 'each'`: revealed nodes shown so far; undefined = all. */
  built?: number;
  /** A temporary step shown on top of `index` (detour, overview, captured list). */
  temp?: PresentationStep | null;
}

export interface Capture { id: NodeId; kind: CaptureKind }
export interface PreflightWarning { stepId?: string; step?: number; nodeId?: NodeId; text: string }

/** Speaker-facing figures for the bar and the readout. */
export interface StepInfo {
  number: number;
  total: number;
  title: string;
  caption?: string;
  note?: string;
  crumbs: string[];
  detour: boolean;
  special?: 'overview' | 'captured' | 'detour';
}

export const CAPTURE_LABELS: Record<CaptureKind, string> = { question: 'Question', action: 'Action', decision: 'Decision' };
const AUTO_ID = 'auto';
const GLIDE_MS = 350;
const FLY_MS = 800;
const DIP_MS = 300;
const READABLE_PX = 14;
const FIT_PAD = 48;
const FIT_MAX_ZOOM = 2;
const FULLSCREEN_KEY = 'radiant.presentFullscreen';
const TOUR_KEY = 'radiant.presentTour';

const reducedMotionPreferred = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Shown children of a node (none when folded). */
function shownChildren(doc: Doc, id: NodeId): NodeId[] {
  const n = doc.nodes[id];
  return n && !n.collapsed ? n.children.filter((c) => doc.nodes[c]) : [];
}

export class PresentationEngine {
  // ------------------------------------------------------------ reactive state (read by components)
  active = $state(false);
  /** Bumped on every position change, so components re-read the step. */
  tick = $state(0);
  private blankState = $state(false);
  /** Audience screen blanked (B or full stop). The presenter console is told. */
  get blank(): boolean { return this.blankState; }
  set blank(on: boolean) {
    if (on === this.blankState) return;
    this.blankState = on;
    this.publish();
  }
  laser = $state(false);
  /** Digits typed for "jump to step". */
  digits = $state('');
  capture = $state<CaptureKind | null>(null);
  captured = $state.raw<Capture[]>([]);
  /** Motion level for this talk; selectable before and during it (PRS-10). */
  motion = $state<MotionLevel>('full');
  /** Dim level chosen during this talk (view state); null = the presentation's own. */
  dimOverride = $state<number | null>(null);
  /** Opacity of the cover used by the gentle cross-fade (0 = clear). */
  curtain = $state(0);
  readout = $state('');
  fullscreenDefault = $state(true);
  fullscreen = $state(false);
  /** Where a detour left the talk; the "Return to talk" pill goes back here. */
  talk = $state.raw<Position | null>(null);
  showPanel = $state(false);
  /** Presentation chosen in the panel: a saved id, 'auto', or undefined (first saved, else automatic). */
  openId = $state<string | undefined>(undefined);
  tour = $state<TourSettings>({ granularity: 'levels', context: 'dim' });
  /** A presenter console is open for this window (PRS-40); step changes are sent to it. */
  presenterLinked = $state(false);

  // ------------------------------------------------------------ playback state
  private auto: Presentation | null = null;
  private savedId: string | null = null;
  private pos: Position = { index: 0 };
  private history: Position[] = [];
  /** What the pipeline draws now; a new object for every change. */
  private scope: PresentScope | null = null;
  /** Document revision the scope was computed for (the document is edited in place). */
  private scopeRev = -1;
  private target: { scope: PresentScope; camera: CameraState | null } | null = null;
  private transitioning = false;
  private token = 0;
  private timers: number[] = [];
  private burst = 0;
  private lastPress = 0;
  private lastFocus: NodeId | null = null;
  private savedReducedMotion: boolean | undefined = undefined;
  private fullscreenMode: 'document' | 'window' | null = null;
  private fullscreenRequest: Promise<void> | null = null;
  private reopenPanel = false;
  /** Epoch ms when the talk started, for the console's elapsed time. */
  private startedAt = 0;
  private lastPublished = '';
  private playableMemo: { p: Presentation; rev: number; list: number[] } | null = null;

  constructor(private c: AppController, private hooks: PresentationHooks) {
    try {
      this.fullscreenDefault = localStorage.getItem(FULLSCREEN_KEY) !== 'false';
      const tour = JSON.parse(localStorage.getItem(TOUR_KEY) ?? 'null');
      if (tour && ['branches', 'levels', 'nodes'].includes(tour.granularity) && ['dim', 'hide'].includes(tour.context)) this.tour = tour;
    } catch { /* preferences unavailable */ }
    // Commands from a presenter console; the host is ready once the controller has finished constructing.
    if (typeof window !== 'undefined') queueMicrotask(() => this.listenPresenter());
  }

  // ====================================================================== what is being played

  /** The presentation being played, read from the document for saved ones so edits and undo apply at once. */
  get presentation(): Presentation | null {
    void this.c.rev;
    if (this.savedId) return this.c.doc.presentations?.find((p) => p.id === this.savedId) ?? null;
    return this.auto;
  }

  /** The presentation Present would play: the panel's choice, else the first saved one, else the automatic tour. */
  chosen(): { saved: Presentation | null } {
    const list = this.c.doc.presentations ?? [];
    if (this.openId === AUTO_ID) return { saved: null };
    return { saved: list.find((p) => p.id === this.openId) ?? list[0] ?? null };
  }

  setTour(tour: Partial<TourSettings>): void {
    this.tour = { ...this.tour, ...tour };
    try { localStorage.setItem(TOUR_KEY, JSON.stringify(this.tour)); } catch { /* storage unavailable */ }
  }

  setFullscreenDefault(on: boolean): void {
    this.fullscreenDefault = on;
    try { localStorage.setItem(FULLSCREEN_KEY, String(on)); } catch { /* storage unavailable */ }
  }

  /** The automatic tour of the current document with the chosen settings. */
  autoPresentation(selection?: readonly NodeId[]): Presentation {
    const steps = autoTour(this.c.doc, { granularity: this.tour.granularity, selection });
    return { id: AUTO_ID, name: 'Automatic tour', steps, context: this.tour.context };
  }

  /** Playable step indices, remembered per presentation object and document revision (asked several times a step). */
  private playable(p = this.presentation): number[] {
    if (!p) return [];
    const rev = this.c.rev;
    const memo = this.playableMemo;
    if (memo && memo.p === p && memo.rev === rev) return memo.list;
    const list = playableSteps(this.c.doc, p);
    this.playableMemo = { p, rev, list };
    return list;
  }

  // ====================================================================== start and stop

  toggle(): void {
    if (this.active) this.c.leaveCanvasView();
    else this.start();
  }

  /**
   * Start presenting. `from`: begin at the step that shows this node ("Present from Here"). `at`: begin at this
   * step index of the chosen presentation ("Present from this step"). `id`: a saved presentation or 'auto'.
   */
  start(options: { from?: NodeId | null; at?: number; id?: string } = {}): void {
    if (this.active) this.stopPlayback();
    this.c.endEdit();
    this.c.flush();
    const doc = this.c.doc;
    const chosenId = options.id ?? this.openId;
    const saved = chosenId === AUTO_ID ? null
      : (doc.presentations ?? []).find((p) => p.id === chosenId) ?? (chosenId === undefined ? this.chosen().saved : null);
    const selection = this.c.selIds.filter((id) => shownInEditor(doc, id));
    this.savedId = saved?.id ?? null;
    this.auto = saved ? null : this.autoPresentation(!options.from && selection.length > 1 ? selection : undefined);
    const p = this.presentation;
    const playable = this.playable(p);
    if (!p || !playable.length) {
      this.savedId = null;
      this.auto = null;
      this.c.say(saved ? 'This presentation has no steps to play.' : 'There is nothing to present yet.', 'info');
      return;
    }
    let index = playable[0];
    const fromStep = options.from ? this.stepFor(options.from) : null;
    if (options.at !== undefined && playable.includes(options.at)) index = options.at;
    else if (fromStep !== null) index = fromStep;
    this.active = true;
    this.reopenPanel = this.showPanel;
    this.showPanel = false;
    this.captured = [];
    this.history = [];
    this.talk = null;
    this.blank = this.laser = false;
    this.capture = null;
    this.digits = '';
    this.dimOverride = null;
    this.motion = p.motion ?? (reducedMotionPreferred() ? 'gentle' : 'full');
    this.savedReducedMotion = this.c.camera.reducedMotion;
    // The presenter chose the motion level explicitly (PRS-10), so the camera follows it rather than the OS.
    this.c.camera.reducedMotion = false;
    this.scope = null;
    this.startedAt = Date.now();
    this.hooks.begin(this.c.camera.getState());
    this.go({ index, built: this.initialBuilt(p, index) }, { first: true });
    // A node that no step shows: start where the talk would and step aside to it.
    if (options.from && fromStep === null && shownInEditor(doc, options.from)) this.detour(options.from);
    if (this.fullscreenDefault) this.enterFullscreen();
  }

  /** Called by the controller when the presentation view is left. */
  stop(): void {
    if (!this.active) return;
    this.stopPlayback();
    this.exitFullscreen();
    if (this.reopenPanel) this.showPanel = true;
    this.reopenPanel = false;
  }

  private stopPlayback(): void {
    this.cancelTransition();
    this.active = false;
    this.scope = this.target = null;
    this.scopeRev = -1;
    this.blank = this.laser = false;
    this.capture = null;
    this.digits = '';
    this.curtain = 0;
    this.talk = null;
    this.history = [];
    this.readout = '';
    this.c.camera.reducedMotion = this.savedReducedMotion;
    this.publish();
  }

  // ====================================================================== what the pipeline draws

  /** The scope for `SceneState.present`. Recomputed when the document changed (a capture, an undo). */
  sceneScope(): PresentScope | null {
    if (!this.active) return null;
    if (this.scopeRev !== this.c.rev || !this.scope) {
      const view = this.viewAt(this.pos);
      this.scope = view ? this.toScope(view) : null;
      this.scopeRev = this.c.rev;
    }
    return this.scope;
  }

  private effective(pos: Position): { p: Presentation; index: number } | null {
    const base = this.presentation;
    if (!base) return null;
    let p = this.dimOverride === null ? base : { ...base, dimOpacity: this.dimOverride };
    let index = pos.index;
    if (pos.temp) {
      // The whole-map view shows everything revealed so far, even when the talk hides context.
      p = { ...p, steps: [...p.steps.slice(0, index + 1), pos.temp], ...(pos.temp.id === 'overview' ? { context: 'dim' as const } : {}) };
      index = Math.min(index + 1, p.steps.length - 1);
    }
    return { p, index };
  }

  private viewAt(pos: Position): StepView | null {
    const e = this.effective(pos);
    if (!e || !e.p.steps.length) return null;
    return stepView(this.c.doc, e.p, e.index, { built: pos.built });
  }

  private toScope(view: StepView): PresentScope {
    const doc = this.c.doc;
    let visible: ReadonlySet<NodeId> = view.visible;
    let opacity: ReadonlyMap<NodeId, number> = view.opacity;
    const extra = this.captured.filter((x) => shownInEditor(doc, x.id) && !view.visible.has(x.id));
    if (extra.length) {
      const v = new Set(view.visible);
      const o = new Map(view.opacity);
      for (const { id } of extra) {
        v.add(id);
        o.set(id, 1);
      }
      visible = v;
      opacity = o;
    }
    return presentScope(doc, view, this.c.pipeline?.layout.boxes, visible, opacity);
  }

  // ====================================================================== navigation

  private initialBuilt(p: Presentation, index: number): number | undefined {
    return p.steps[index]?.build === 'each' ? 0 : undefined;
  }

  /** Index of the first playable step that shows `id`: as focus, else as a reveal, else for its nearest ancestor. */
  stepFor(id: NodeId): number | null {
    const p = this.presentation ?? this.auto;
    if (!p) return null;
    const doc = this.c.doc;
    const playable = this.playable(p);
    for (let cur: NodeId | null = id; cur !== null; cur = doc.nodes[cur]?.parent ?? null) {
      const resolved = playable.map((i) => [i, resolveStep(doc, p.steps[i])] as const);
      const focus = resolved.find(([, r]) => r.focus.includes(cur!));
      if (focus) return focus[0];
      const reveal = resolved.find(([, r]) => r.reveal.includes(cur!));
      if (reveal) return reveal[0];
    }
    return null;
  }

  next(): void {
    if (this.unblank()) return;
    const p = this.presentation;
    if (!p) return;
    const pos = this.pos;
    if (pos.temp?.id === 'captured') return;
    const step = p.steps[pos.index];
    if (!pos.temp && step?.build === 'each' && pos.built !== undefined) {
      const count = resolveStep(this.c.doc, step).reveal.length;
      if (pos.built < count) {
        this.go({ index: pos.index, built: pos.built + 1 }, { build: true });
        return;
      }
    }
    const after = this.playable(p).find((i) => i > pos.index);
    this.talk = null;
    if (after !== undefined) this.go({ index: after, built: this.initialBuilt(p, after) });
    else if (this.capturedStep()) this.go({ index: pos.index, temp: this.capturedStep() });
  }

  previous(): void {
    if (this.unblank()) return;
    const p = this.presentation;
    if (!p) return;
    const pos = this.pos;
    this.talk = null;
    if (pos.temp) {
      this.go({ index: pos.index });
      return;
    }
    if (p.steps[pos.index]?.build === 'each' && pos.built !== undefined && pos.built > 0) {
      this.go({ index: pos.index, built: pos.built - 1 }, { build: true });
      return;
    }
    const before = this.playable(p).filter((i) => i < pos.index).at(-1);
    if (before !== undefined) this.go({ index: before });
  }

  /** Jump to the n-th playable step (1-based), recording where the talk was. */
  jump(n: number): void {
    const playable = this.playable();
    const index = playable[Math.max(0, Math.min(playable.length - 1, n - 1))];
    if (index === undefined) return;
    this.unblank();
    const p = this.presentation!;
    this.go({ index, built: this.initialBuilt(p, index) }, { remember: true });
  }

  first(): void { this.jump(1); }
  last(): void { this.jump(this.playable().length); }

  /** Back to where I was (Backspace): undo the last jump or detour. */
  back(): void {
    const previous = this.history.pop();
    if (!previous) return;
    if (!this.history.length || previous === this.talk) this.talk = null;
    this.go(previous);
  }

  /** "Return to talk": leave every detour and go back to the step that was left. */
  returnToTalk(): void {
    const talk = this.talk;
    if (!talk) return;
    this.history = [];
    this.talk = null;
    this.go(talk);
  }

  /** Clicking a visible node: jump to its step, or show a temporary step for it (PRS-22). */
  detour(id: NodeId): void {
    const doc = this.c.doc;
    if (!doc.nodes[id] || this.pos.temp?.focus[0] === id) return;
    const p = this.presentation;
    if (!p) return;
    const step = this.playable(p).find((i) => resolveStep(doc, p.steps[i]).focus.includes(id));
    if (step === this.pos.index && !this.pos.temp) return;
    this.talk ??= this.pos;
    if (step !== undefined) this.go({ index: step, built: this.initialBuilt(p, step) }, { remember: true });
    else {
      const reveal = shownChildren(doc, id);
      const temp: PresentationStep = { id: 'detour', focus: [id], ...(reveal.length ? { reveal } : {}) };
      this.go({ index: this.pos.index, built: this.pos.built, temp }, { remember: true });
    }
  }

  /** Whole map (O): everything revealed so far, nothing dimmed. Pressing O again goes back. */
  overview(): void {
    if (this.pos.temp?.id === 'overview') {
      this.back();
      return;
    }
    const temp: PresentationStep = { id: 'overview', focus: this.c.doc.roots.filter((r) => this.c.doc.nodes[r]), frame: 'map', dim: 'none', title: 'Whole map' };
    this.go({ index: this.pos.index, built: this.pos.built, temp }, { remember: true });
  }

  /** Re-centre on the current step (R), after panning or zooming by hand. */
  recentre(): void {
    this.finishTransition();
    const state = this.cameraFor(this.pos, undefined, true);
    if (state) void this.moveCamera(state, false, ++this.token);
  }

  private capturedStep(): PresentationStep | null {
    const ids = this.captured.map((x) => x.id).filter((id) => this.c.doc.nodes[id]);
    return ids.length ? { id: 'captured', focus: ids, frame: 'nodes', title: 'Captured' } : null;
  }

  private unblank(): boolean {
    if (!this.blank) return false;
    this.blank = false;
    return true;
  }

  // ====================================================================== the transition (PRS-04, 06 to 10)

  /**
   * Show a position. The opacity change happens at once, then the camera glides (or flies, or cross-fades), then
   * newly revealed nodes grow out of their parents. A press during a transition finishes it at once; a second
   * press inside one burst cuts straight to the latest target (PRS-09).
   */
  private go(next: Position, how: { remember?: boolean; first?: boolean; build?: boolean } = {}): void {
    const now = performance.now();
    const interrupted = this.finishTransition();
    this.burst = interrupted || now - this.lastPress < 150 ? this.burst + 1 : 0;
    this.lastPress = now;
    if (how.remember) this.history.push(this.pos);
    this.pos = next;
    this.tick++;
    this.publish();
    const view = this.viewAt(next);
    if (!view) return;
    const target = this.toScope(view);
    const before = this.scope;
    this.scopeRev = this.c.rev;
    const entering = before ? [...target.visible].filter((id) => !before.visible.has(id)) : [];
    const leaving = before ? [...before.visible].filter((id) => !target.visible.has(id)) : [];
    const step = view.resolved.step;
    const camera = how.build ? null : this.cameraFor(next, view);
    const cut = this.motion === 'none' || this.burst >= 2 || step.transition === 'cut';
    this.announce(view, how.build ? entering.length : view.resolved.reveal.length && entering.length);
    const focus = view.resolved.focus[0] ?? null;
    const long = !!camera && !how.first && this.isLongJump(camera, focus);
    this.lastFocus = focus;
    if (cut) {
      this.scope = target;
      this.hooks.refresh(null);
      if (camera) this.c.camera.set(camera);
      return;
    }
    const token = ++this.token;
    this.transitioning = true;
    this.target = { scope: target, camera };
    const growth = (): MembershipOptions => ({ fade: this.motion === 'gentle', within: this.c.camera.visibleRect(64) });
    if (!camera && entering.length) {
      // No camera move: opacity and growth start together, so one scene rebuild serves both (PRS-61).
      this.scope = target;
      this.hooks.refresh(growth());
      this.later(() => this.settle(token), FOLD_DURATION);
      return;
    }
    // 1. Opacity at once; nodes that leave shrink back meanwhile.
    const enteringSet = new Set(entering);
    this.scope = entering.length ? { ...target, visible: new Set([...target.visible].filter((id) => !enteringSet.has(id))) } : target;
    this.hooks.refresh(leaving.length ? growth() : null);
    // 2. Camera, then 3. growth.
    const moved = camera ? this.moveCamera(camera, long, token) : Promise.resolve();
    void moved.then(() => {
      if (token !== this.token) return;
      if (!entering.length) {
        this.settle(token);
        return;
      }
      this.scope = target;
      this.hooks.refresh(growth());
      this.later(() => this.settle(token), FOLD_DURATION);
    });
  }

  private settle(token: number): void {
    if (token !== this.token) return;
    this.transitioning = false;
    this.target = null;
  }

  /** Finish a running transition at once. Returns whether one was running. */
  private finishTransition(): boolean {
    if (!this.transitioning) return false;
    const target = this.target;
    this.cancelTransition();
    if (target) {
      this.scope = target.scope;
      if (target.camera) this.c.camera.set(target.camera);
    }
    return true;
  }

  private cancelTransition(): void {
    this.token++;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.c.camera.cancelAnimation();
    this.hooks.finishGrowth();
    this.curtain = 0;
    this.transitioning = false;
    this.target = null;
  }

  private later(fn: () => void, ms: number): void {
    this.timers.push(window.setTimeout(fn, ms));
  }

  private moveCamera(state: CameraState, long: boolean, token: number): Promise<void> {
    const camera = this.c.camera;
    const viewports = Math.hypot(state.cx - camera.cx, state.cy - camera.cy) * camera.zoom / Math.max(1, camera.width);
    if (this.motion === 'none') {
      camera.set(state);
      return Promise.resolve();
    }
    if (this.motion === 'gentle' && (viewports > 1 || Math.abs(Math.log(state.zoom / camera.zoom)) > Math.log(2.5))) {
      // Cross-fade through the canvas colour instead of moving a long way (PRS-10).
      return new Promise((resolve) => {
        this.curtain = 1;
        this.later(() => {
          if (token === this.token) camera.set(state);
          this.curtain = 0;
          this.later(resolve, DIP_MS / 2);
        }, DIP_MS / 2);
      });
    }
    return (long && this.motion === 'full' ? camera.flyTo(state, FLY_MS) : camera.animateTo(state, GLIDE_MS)).then(() => {});
  }

  /** A jump of more than 1.5 viewports, or into another main branch (PRS-08). */
  private isLongJump(state: CameraState, focus: NodeId | null): boolean {
    const camera = this.c.camera;
    const distance = Math.hypot(state.cx - camera.cx, state.cy - camera.cy) * camera.zoom;
    if (distance > 1.5 * Math.max(camera.width, camera.height)) return true;
    const boxes = this.c.pipeline.layout.boxes;
    const a = this.lastFocus ? boxes.get(this.lastFocus) : undefined;
    const b = focus ? boxes.get(focus) : undefined;
    return !!a && !!b && a.depth > 0 && b.depth > 0 && a.mainBranch !== b.mainBranch && distance > 0.5 * camera.width;
  }

  /**
   * Camera for a position (PRS-06): fit the frame nodes with 48 px padding and at most zoom 2, unless they already
   * fit in the current view with labels at least 14 screen px, in which case null (the camera stays).
   */
  private cameraFor(pos: Position, view = this.viewAt(pos), force = false): CameraState | null {
    if (!view) return null;
    const full = pos.built !== undefined ? this.viewAt({ ...pos, built: undefined }) ?? view : view;
    const rect = stepFrame(this.c.doc, full, this.c.pipeline.layout.boxes);
    if (!rect) return null;
    const camera = this.c.camera;
    const ins = this.c.insets();
    const w = Math.max(100, camera.width - ins.l - ins.r);
    const h = Math.max(100, camera.height - ins.t - ins.b);
    const fit = Camera.fitState(rect, w, h, FIT_PAD, FIT_MAX_ZOOM);
    fit.cx -= (ins.l - ins.r) / 2 / fit.zoom;
    fit.cy -= (ins.t - ins.b) / 2 / fit.zoom;
    if (!force && this.fitsNow(rect, ins, full, fit.zoom)) return null;
    return fit;
  }

  private fitsNow(rect: Rect, ins: { l: number; r: number; t: number; b: number }, view: StepView, fitZoom: number): boolean {
    const camera = this.c.camera;
    if (camera.animating) return false;
    const margin = 16;
    const a = camera.worldToScreen({ x: rect.x, y: rect.y });
    const b = camera.worldToScreen({ x: rect.x + rect.w, y: rect.y + rect.h });
    if (a.x < ins.l + margin || a.y < ins.t + margin || b.x > camera.width - ins.r - margin || b.y > camera.height - ins.b - margin) return false;
    const styles = createStyleResolver(this.c.doc, this.c.theme);
    const boxes = this.c.pipeline.layout.boxes;
    let smallest = Infinity;
    for (const id of view.resolved.focus) {
      const box = boxes.get(id);
      if (box) smallest = Math.min(smallest, styles.get(id, box.depth, box.mainBranch).font.size);
    }
    if (view.elements.size) {
      // Element text counts as labels do (a frame's name does not); a step of shapes alone wants nearly its fitted size.
      let text = false;
      for (const el of this.c.doc.canvas?.elements ?? []) {
        if (!view.elements.has(el.id) || el.kind === 'frame' || !el.text?.trim()) continue;
        smallest = Math.min(smallest, el.fontSize ?? DEFAULT_ELEMENT_FONT_SIZE);
        text = true;
      }
      if (!text && camera.zoom < fitZoom * 0.75) return false;
    }
    return !Number.isFinite(smallest) || smallest * camera.zoom >= READABLE_PX;
  }

  /** Re-fit after the window changed size (full screen on or off). */
  onResize(): void {
    if (!this.active) return;
    this.finishTransition();
    const state = this.cameraFor(this.pos);
    if (state) this.c.camera.set(state);
  }

  // ====================================================================== bar, readout and options

  info(): StepInfo | null {
    void this.tick;
    void this.c.rev;
    const p = this.presentation;
    if (!this.active || !p) return null;
    const doc = this.c.doc;
    const pos = this.pos;
    const playable = this.playable(p);
    const extra = this.capturedStep() ? 1 : 0;
    const step = pos.temp ?? p.steps[pos.index];
    if (!step) return null;
    const special = pos.temp ? (pos.temp.id === 'overview' || pos.temp.id === 'captured' ? pos.temp.id : 'detour') : undefined;
    const number = pos.temp?.id === 'captured' ? playable.length + 1 : Math.max(1, playable.indexOf(pos.index) + 1);
    const focus = special === 'captured' || special === 'overview' ? undefined : resolveStep(doc, step).focus[0];
    const crumbs: string[] = [];
    for (let id: NodeId | null = focus ?? null; id !== null; id = doc.nodes[id]?.parent ?? null) {
      crumbs.unshift(doc.nodes[id]?.text.trim() || 'Untitled');
    }
    return {
      number, total: playable.length + extra, title: stepTitle(doc, step) || 'Untitled step',
      caption: pos.temp ? undefined : step.caption, note: pos.temp ? undefined : stepNote(doc, step),
      crumbs, detour: !!this.talk, special
    };
  }

  /** True while the step can still reveal nodes one by one. */
  get building(): boolean {
    void this.tick;
    const step = this.presentation?.steps[this.pos.index];
    return !this.pos.temp && step?.build === 'each' && this.pos.built !== undefined &&
      this.pos.built < resolveStep(this.c.doc, step).reveal.length;
  }

  get atStart(): boolean {
    void this.tick;
    return !this.pos.temp && this.playable()[0] === this.pos.index && !this.pos.built;
  }

  get atEnd(): boolean {
    void this.tick;
    if (this.pos.temp?.id === 'captured') return true;
    return !this.pos.temp && this.playable().at(-1) === this.pos.index && !this.building && !this.capturedStep();
  }

  get dimLevel(): number {
    void this.c.rev;
    return this.dimOverride ?? this.presentation?.dimOpacity ?? DEFAULT_DIM_OPACITY;
  }

  /** Change the dim level for this talk; the audience view updates at once (PRS-63). */
  setDim(value: number): void {
    this.dimOverride = Math.max(0.1, Math.min(0.6, value));
    this.redraw();
  }

  setMotion(level: MotionLevel): void {
    this.motion = level;
  }

  private redraw(): void {
    if (!this.active) return;
    this.finishTransition();
    const view = this.viewAt(this.pos);
    this.scope = view ? this.toScope(view) : null;
    this.hooks.refresh(null);
  }

  private announce(view: StepView, revealed: number): void {
    const p = this.presentation;
    if (!p) return;
    const info = this.info();
    const title = stepTitle(this.c.doc, view.resolved.step) || 'Untitled step';
    const label = info?.special === 'overview' ? 'Whole map' : info?.special === 'captured' ? 'Captured' : `Step ${info?.number ?? 1} of ${info?.total ?? 1}`;
    this.readout = `${label}: ${title}.${revealed ? ` ${revealed} ${revealed === 1 ? 'node' : 'nodes'} revealed.` : ''}`;
  }

  // ====================================================================== input

  /** Keys while presenting (PRS-20, 23, 26, 33). Called for every keydown while the presentation view is open. */
  onKey(e: KeyboardEvent): void {
    if (isTypingTarget(e.target) || e.defaultPrevented) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const pressed = chord(e);
      if (pressed && pressed === this.c.shortcuts['present-branches']) {
        e.preventDefault();
        if (!e.repeat) this.c.leaveCanvasView();
      }
      return;
    }
    const key = e.key;
    const button = e.target instanceof HTMLButtonElement || (e.target instanceof Element && !!e.target.closest('button, select, a'));
    if (button && (e.code === 'Space' || key === 'Enter')) return;
    const handled = (fn: () => void) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) fn();
    };
    if (/^[0-9]$/.test(key) && !e.altKey) return handled(() => { this.digits = (this.digits + key).slice(-4); });
    if (key === 'Enter' && this.digits) {
      return handled(() => {
        const n = Number(this.digits);
        this.digits = '';
        if (n > 0) this.jump(n);
      });
    }
    if (key === 'Escape' && this.digits) return handled(() => { this.digits = ''; });
    this.digits = '';
    switch (key) {
      case 'ArrowRight': case 'ArrowDown': case 'PageDown': case 'Enter':
        return handled(() => this.next());
      case ' ':
        return handled(() => (e.shiftKey ? this.previous() : this.next()));
      case 'ArrowLeft': case 'ArrowUp': case 'PageUp':
        return handled(() => this.previous());
      case 'Home': return handled(() => this.first());
      case 'End': return handled(() => this.last());
      case 'Backspace': return handled(() => this.back());
      case 'Escape': return handled(() => this.c.leaveCanvasView());
    }
    if (e.code === 'Space') return handled(() => (e.shiftKey ? this.previous() : this.next()));
    if (e.altKey) return;
    switch (e.code) {
      case 'KeyB': case 'Period': return handled(() => { this.blank = !this.blank; });
      case 'KeyR': return handled(() => this.recentre());
      case 'KeyO': return handled(() => this.overview());
      case 'KeyF': return handled(() => this.toggleFullscreen());
      case 'KeyL':
        e.preventDefault();
        this.laser = true;
        return;
      case 'KeyQ': return handled(() => this.openCapture('question'));
      case 'KeyA': return handled(() => this.openCapture('action'));
      case 'KeyD': return handled(() => this.openCapture('decision'));
    }
  }

  onKeyUp(e: KeyboardEvent): void {
    if (e.code === 'KeyL') this.laser = false;
  }

  /** Pointer down on the canvas while presenting: a click on a drawn node is a detour (PRS-22). */
  onPointerDown(e: PointerEvent): void {
    if (!e.isPrimary || e.button !== 0) return;
    const id = this.hooks.hit(e);
    if (id) this.detour(id);
  }

  // ====================================================================== capture (PRS-33, 34)

  /** The node a capture is added to: the first focus node of the step on screen. */
  captureTarget(): NodeId | null {
    const step = this.pos.temp ?? this.presentation?.steps[this.pos.index];
    if (!step || step.id === 'captured' || step.id === 'overview') return null;
    return resolveStep(this.c.doc, step).focus[0] ?? null;
  }

  openCapture(kind: CaptureKind): void {
    if (!this.captureTarget()) {
      this.c.say('Go to a step with a focus node to capture.', 'info');
      return;
    }
    this.finishTransition();
    this.capture = kind;
  }

  /** Add the captured text as a tagged child of the focus node: one ordinary undoable transaction. */
  commitCapture(text: string): void {
    const kind = this.capture;
    this.capture = null;
    const parent = this.captureTarget();
    const clean = text.trim();
    if (!kind || !parent || !clean) return;
    const edit = addChild(this.c.doc, parent, clean);
    if (!edit) return;
    const ops = edit.tx.ops.map((op) => op.t === 'insert'
      ? { ...op, node: { ...op.node, tags: [kind], ...(kind === 'action' ? { task: { done: false } } : {}) } }
      : op);
    const tx: Transaction = { ...edit.tx, label: 'Add ' + CAPTURE_LABELS[kind], ops };
    const id = ops.find((op) => op.t === 'insert')?.node.id;
    if (id) this.captured = [...this.captured, { id, kind }];
    this.c.editor.apply(tx);
  }

  cancelCapture(): void {
    this.capture = null;
  }

  // ====================================================================== full screen (PRS-23)

  toggleFullscreen(): void {
    if (this.fullscreen || this.fullscreenMode || document.fullscreenElement) this.exitFullscreen(true);
    else this.enterFullscreen();
  }

  private enterFullscreen(): void {
    if (this.fullscreenRequest || this.fullscreenMode || document.fullscreenElement) return;
    const host = this.c.host;
    const enter = async () => {
      const root = document.documentElement;
      if (root.requestFullscreen && document.fullscreenEnabled && navigator.userActivation?.isActive) {
        try {
          await root.requestFullscreen();
          this.fullscreenMode = 'document';
          return;
        } catch { /* Native menu commands can require window full screen instead. */ }
      }
      if (!this.active || !host.setWindowFullscreen || await host.isWindowFullscreen?.()) return;
      if (!this.active) return;
      await host.setWindowFullscreen(true);
      this.fullscreenMode = 'window';
    };
    this.fullscreenRequest = enter().catch(() => {}).finally(() => {
      this.fullscreenRequest = null;
      this.fullscreen = !!this.fullscreenMode;
      if (!this.active) this.exitFullscreen();
      else this.onResize();
    });
  }

  private exitFullscreen(always = false): void {
    const mode = this.fullscreenMode;
    this.fullscreenMode = null;
    this.fullscreen = false;
    if ((mode === 'document' || always) && document.fullscreenElement === document.documentElement) {
      void document.exitFullscreen().catch(() => {});
    }
    if (mode === 'window') void this.c.host.setWindowFullscreen?.(false).catch(() => {});
  }

  /** The document left full screen by other means (the system, Escape in the browser): keep presenting in a window. */
  onFullscreenChange(): void {
    if (this.fullscreenMode === 'document' && !document.fullscreenElement) {
      this.fullscreenMode = null;
      this.fullscreen = false;
    }
  }

  // ====================================================================== presenter console (PRS-40 to 42)

  private listenPresenter(): void {
    void this.c.host.onPresenterCommand?.((command) => this.onPresenterCommand(command))?.catch(() => {});
  }

  /** Open the console window (or the console tab in a browser) and send it the talk's state. */
  async openPresenter(): Promise<void> {
    const host = this.c.host;
    if (!host.openPresenter) {
      this.c.say('The presenter console is not available here.', 'info');
      return;
    }
    try {
      this.presenterLinked = true;
      await host.openPresenter();
      this.publish(true);
    } catch (error) {
      this.c.say(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  closePresenter(): void {
    this.presenterLinked = false;
    void this.c.host.closePresenter?.().catch(() => {});
  }

  /** A command from the console. Navigation behaves exactly as the keys do. */
  onPresenterCommand(command: PresenterCommand): void {
    switch (command.kind) {
      case 'hello':
        this.presenterLinked = true;
        return this.publish(true);
      case 'closed':
        this.presenterLinked = false;
        return;
      case 'start':
        if (!this.active) this.start();
        return;
      case 'fullscreen':
        void this.fullscreenOn(command.display);
        return;
    }
    if (!this.active) return;
    switch (command.kind) {
      case 'next': return this.next();
      case 'previous': return this.previous();
      case 'first': return this.first();
      case 'last': return this.last();
      case 'jump': return Number.isInteger(command.step) && command.step > 0 ? this.jump(command.step) : undefined;
      case 'blank': this.blank = !this.blank; return;
      case 'end': return this.c.leaveCanvasView();
    }
  }

  /** Fill a chosen display with the audience window (PRS-42); null returns to a window. */
  private async fullscreenOn(display: string | null): Promise<void> {
    const host = this.c.host;
    if (!host.setFullscreenOnDisplay) return;
    if (display === null) {
      this.exitFullscreen(true);
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      // macOS moves a window between displays only outside full screen; leaving it animates for a moment.
      if (await host.isWindowFullscreen?.()) {
        await host.setWindowFullscreen?.(false);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      await host.setFullscreenOnDisplay(display);
      this.fullscreenMode = 'window';
      this.fullscreen = true;
    } catch (error) {
      this.c.say(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  /**
   * Send the talk's state to the console. Called on every step change, start, end and blank; never per frame.
   * Identical states are not sent twice.
   */
  private publish(force = false): void {
    const host = this.c.host;
    if (!this.presenterLinked || !host.sendPresenterState) return;
    const state = this.presenterState();
    const key = JSON.stringify(state);
    if (!force && key === this.lastPublished) return;
    this.lastPublished = key;
    void host.sendPresenterState(state).catch(() => {});
  }

  private presenterState(): PresenterState {
    const doc = this.c.doc;
    const p = this.active ? this.presentation : (this.chosen().saved ?? this.autoPresentation());
    const playable = p ? this.playable(p) : [];
    const steps = p ? playable.map((index, i) => {
      const step = p.steps[index];
      return { id: step.id, number: i + 1, title: stepTitle(doc, step) || 'Untitled step', ...(step.seconds ? { seconds: step.seconds } : {}) };
    }) : [];
    const base: PresenterState = {
      active: false, docId: doc.id, docTitle: this.c.docTitle, presentationId: p?.id ?? AUTO_ID,
      presentation: p?.name ?? 'Automatic tour', steps, current: 0,
      ...(p?.targetMinutes ? { targetMinutes: p.targetMinutes } : {})
    };
    const info = this.active ? this.info() : null;
    if (!info || !p) return base;
    const after = playable.find((i) => i > this.pos.index);
    const nextTitle = after !== undefined ? stepTitle(doc, p.steps[after]) || 'Untitled step' : undefined;
    return {
      ...base, active: true, current: info.number, title: info.title,
      ...(info.note ? { note: info.note } : {}),
      ...(info.caption ? { caption: info.caption } : {}),
      ...(nextTitle ? { nextTitle } : {}),
      ...(info.special ? { special: info.special } : {}),
      ...(this.building ? { building: true } : {}),
      ...(this.blankState ? { blank: true } : {}),
      startedAt: this.startedAt
    };
  }

  // ====================================================================== panel helpers (PRS-32, 35)

  openPanel(): void {
    this.showPanel = true;
  }

  /** Pre-flight warnings for a saved presentation (PRS-35). */
  preflight(p: Presentation): PreflightWarning[] {
    const doc = this.c.doc;
    const out: PreflightWarning[] = [];
    const boxes = this.c.pipeline?.layout.boxes;
    const camera = this.c.camera;
    const viewW = Math.max(1, camera.width);
    let previous: { x: number; y: number; zoom: number } | null = null;
    const visited = new Set<NodeId>();
    p.steps.forEach((step, i) => {
      const name = `Step ${i + 1}`;
      const r = resolveStep(doc, step);
      if (r.broken) {
        out.push({ stepId: step.id, step: i, text: `${name} is broken: none of its nodes exist any more.` });
        return;
      }
      for (const id of [...r.focus, ...r.reveal]) visited.add(id);
      if (step.skip) return;
      if (r.reveal.length > 7) {
        out.push({ stepId: step.id, step: i, nodeId: r.focus[0], text: `${name} reveals ${r.reveal.length} nodes at once under “${doc.nodes[r.focus[0]]?.text ?? ''}”.` });
      }
      for (const id of r.focus) {
        const words = (doc.nodes[id]?.text ?? '').trim().split(/\s+/).filter(Boolean).length;
        if (words > 6) out.push({ stepId: step.id, step: i, nodeId: id, text: `${name}: the label “${doc.nodes[id].text}” has ${words} words.` });
      }
      if (!boxes) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const frame = step.frame === 'nodes' ? r.focus : [...r.focus, ...r.reveal];
      for (const id of frame) {
        const b = boxes.get(id);
        if (!b) continue;
        x0 = Math.min(x0, b.x - b.w / 2); y0 = Math.min(y0, b.y - b.h / 2);
        x1 = Math.max(x1, b.x + b.w / 2); y1 = Math.max(y1, b.y + b.h / 2);
      }
      if (!(x1 > x0) || step.frame === 'map') { previous = null; return; }
      const fit = Camera.fitState({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, viewW, Math.max(1, camera.height), FIT_PAD, FIT_MAX_ZOOM);
      const here = { x: fit.cx, y: fit.cy, zoom: fit.zoom };
      if (previous) {
        const zoom = Math.min(previous.zoom, here.zoom);
        const viewports = Math.hypot(here.x - previous.x, here.y - previous.y) * zoom / viewW;
        if (viewports > 1.5) out.push({ stepId: step.id, step: i, nodeId: r.focus[0], text: `${name} jumps ${viewports.toFixed(1)} screens from the step before.` });
      }
      previous = here;
    });
    for (const root of doc.roots) {
      for (const branch of shownChildren(doc, root)) {
        if (visited.has(branch)) continue;
        out.push({ nodeId: branch, text: `No step visits the branch “${doc.nodes[branch].text || 'Untitled'}”.` });
      }
    }
    return out;
  }
}
