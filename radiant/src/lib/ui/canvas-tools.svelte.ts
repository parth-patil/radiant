import type { CameraState, CanvasBinding, CanvasElement, CanvasElementKind, NodeId, Op, Rect, Transaction, Vec2 } from '../core/types';
import {
  addBookmark, addElements, canvasLimitError, deleteBookmark, deleteElements, deleteSubtree, duplicateElements,
  groupElements, lockElements, releaseTargets, reorderElements, setBand, setGrid, styleElements, subtreeIds, ungroupElements,
  updateElements, cloneDoc, applyOps, newId
} from '../core/model';
import { isLinear, NOTE_FILL } from '../core/geometry/sketch';
import { readableInk } from '../core/geometry/color';
import { DEFAULT_ELEMENT_FONT_SIZE, elementFontFamily } from '../core/geometry/canvas-scene';
import { isExcalidraw, parseExcalidraw, remapAssets, stringifyExcalidraw } from '../core/io/excalidraw';
import { measureLabel } from '../render/text';
import type { AppController } from './controller.svelte';
import {
  boxCentre, elementBox, expandGroups, isPath, newElement, nodeMoveOps, remapPasted, resizeBox, resizeMany, resizeOne,
  rotateMany, selectionBounds, snap, snapAngle, withFrames, type ElementStyle, type Handle
} from './canvas-ops';
import { isTypingTarget } from './util';

/**
 * Canvas tools (spec 7.3, CNV-30 to 44): the dock's current tool, the selection of canvas elements, pointer
 * gestures that draw, move, resize, rotate, erase and point, in-place text editing, keys, clipboard and the
 * camera's history and bookmarks. The controller delegates to it; every document change is one transaction from
 * the model's canvas commands, committed when the pointer is released.
 */

export type CanvasTool = 'select' | 'hand' | 'note' | 'text' | 'rect' | 'diamond' | 'ellipse' | 'arrow' | 'line' | 'draw' |
  'frame' | 'eraser' | 'laser' | 'image';

export const TOOLS: ReadonlyArray<{ id: CanvasTool; label: string; key: string }> = [
  { id: 'select', label: 'Select', key: 'V' }, { id: 'hand', label: 'Hand', key: 'H' }, { id: 'note', label: 'Note', key: 'N' },
  { id: 'text', label: 'Text', key: 'T' }, { id: 'rect', label: 'Rectangle', key: 'R' }, { id: 'diamond', label: 'Diamond', key: 'D' },
  { id: 'ellipse', label: 'Ellipse', key: 'O' }, { id: 'arrow', label: 'Arrow', key: 'A' }, { id: 'line', label: 'Line', key: 'L' },
  { id: 'draw', label: 'Pen', key: 'P' }, { id: 'frame', label: 'Frame', key: 'F' }, { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'laser', label: 'Laser', key: 'K' }, { id: 'image', label: 'Image', key: '9' }
];

/** Excalidraw's single-key tool bindings (letters and digits). */
const TOOL_KEYS: Record<string, CanvasTool> = {
  v: 'select', 1: 'select', h: 'hand', n: 'note', t: 'text', 8: 'text', r: 'rect', 2: 'rect', d: 'diamond', 3: 'diamond',
  o: 'ellipse', 4: 'ellipse', a: 'arrow', 5: 'arrow', l: 'line', 6: 'line', p: 'draw', 7: 'draw', f: 'frame',
  e: 'eraser', 0: 'eraser', k: 'laser', 9: 'image'
};

export const SHAPE_TOOLS: readonly CanvasTool[] = ['rect', 'diamond', 'ellipse'];
const CREATE: ReadonlySet<CanvasTool> = new Set(['note', 'text', 'rect', 'diamond', 'ellipse', 'arrow', 'line', 'draw', 'frame']);
/** Screen pixels: element hit tolerance (CNV-27), binding reach (CNV-36), drag threshold. */
const HIT_PX = 6, BIND_PX = 12, DRAG_PX = 4;
const NOTE_SIZE = 200;
export const CANVAS_GRID = 20;

export interface CanvasToolHooks {
  /** Node (or branch) under a world point. */
  hitNode(world: Vec2): NodeId | null;
  /** Resolve a picture asset so it can be drawn; returns its aspect (width / height). */
  ensureImage(hash: string): Promise<{ aspect: number }>;
}

type Gesture =
  | { kind: 'pan'; pointer: number; last: Vec2 }
  | { kind: 'create'; pointer: number; tool: CanvasTool; start: Vec2; current: Vec2; client: Vec2; moved: boolean;
      points?: number[]; pressures?: number[]; startBind?: CanvasBinding; shift: boolean; alt: boolean }
  | { kind: 'move'; pointer: number; start: Vec2; client: Vec2; active: boolean; ids: string[]; nodes: NodeId[]; dx: number; dy: number }
  | { kind: 'resize'; pointer: number; handle: Handle; originals: CanvasElement[]; box: Rect; current?: CanvasElement[] }
  | { kind: 'rotate'; pointer: number; originals: CanvasElement[]; centre: Vec2; a0: number; current?: CanvasElement[] }
  | { kind: 'endpoint'; pointer: number; id: string; end: 'start' | 'end'; original: CanvasElement; current?: CanvasElement; bind?: CanvasBinding }
  | { kind: 'erase'; pointer: number; hits: Set<string> }
  | { kind: 'laser'; pointer: number };

export interface TextEdit {
  /** Element being edited; null for a new text element. */
  id: string | null;
  kind: CanvasElementKind;
  /** World position of the new text (top-left) when id is null. */
  at?: Vec2;
  text: string;
}

export class CanvasTools {
  tool = $state<CanvasTool>('select');
  /** Q: the tool stays active after drawing. */
  locked = $state(false);
  /** Selected canvas elements (the node selection stays in the controller). */
  selected = $state.raw<string[]>([]);
  editing = $state.raw<TextEdit | null>(null);
  /** Bumped on every preview change so handles follow a gesture. */
  tick = $state(0);
  style = $state<ElementStyle>({ roughness: 1, strokeWidth: 2, fillStyle: 'hachure', font: 'hand' });
  snapping = $state(true);
  /** Node a dragged note would be adopted by (CNV-44); drawn as a drop highlight. */
  adoptTarget = $state<NodeId | null>(null);
  /** Laser trail: world points with their time. */
  laser = $state.raw<Array<{ x: number; y: number; t: number }>>([]);
  readonly history = new CameraHistory();
  private gesture: Gesture | null = null;
  private pointerWorld: Vec2 | null = null;
  private laserTimer = 0;

  constructor(private c: AppController, private hooks: CanvasToolHooks) {}

  // ---------------------------------------------------------------- reading

  get elements(): readonly CanvasElement[] {
    return this.c.doc.canvas?.elements ?? [];
  }

  /** Element as currently drawn: the gesture's preview if any, else the document's. */
  live(id: string): CanvasElement | undefined {
    const preview = this.c.pipeline?.canvasPreview;
    if (preview?.replace?.has(id)) return preview.replace.get(id) ?? undefined;
    return this.elements.find((el) => el.id === id) ?? preview?.extra?.find((el) => el.id === id);
  }

  get selectedElements(): CanvasElement[] {
    const set = new Set(this.selected);
    return this.elements.filter((el) => set.has(el.id));
  }

  get grid(): { size: number; snap: boolean } | undefined {
    return this.c.doc.canvas?.grid;
  }

  get busy(): boolean {
    return this.gesture !== null;
  }

  private get zoom(): number {
    return Math.max(this.c.camera.zoom, 1e-4);
  }

  private world(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.c.canvas.getBoundingClientRect();
    return this.c.camera.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
  }

  /** Element under a world point, honouring the bands: the front band covers the maps, which cover the back band. */
  hitElement(w: Vec2, skipLocked = false): { id: string; band: 'back' | 'front' } | 'node' | null {
    const index = this.c.pipeline.canvas.index;
    const tolerance = HIT_PX / this.zoom;
    const skip = skipLocked ? (el: CanvasElement) => !!el.locked : undefined;
    const front = index.size ? index.hitTest(w, tolerance, 'front', skip) : null;
    if (front) return front;
    if (this.hooks.hitNode(w)) return 'node';
    return index.size ? index.hitTest(w, tolerance, 'back', skip) : null;
  }

  // ---------------------------------------------------------------- selection

  select(ids: readonly string[], keepNodes = false): void {
    const exist = new Set(this.elements.map((el) => el.id));
    const next = ids.filter((id) => exist.has(id));
    if (!keepNodes && next.length && this.c.selIds.length) this.c.select([]);
    if (next.length === this.selected.length && next.every((id, i) => id === this.selected[i])) return;
    this.selected = next;
  }

  clearSelection(): void {
    if (this.selected.length) this.selected = [];
  }

  /** After any document change: forget elements that no longer exist, end an edit whose element is gone. */
  onDocChange(): void {
    if (this.selected.length) {
      const exist = new Set(this.elements.map((el) => el.id));
      if (this.selected.some((id) => !exist.has(id))) this.selected = this.selected.filter((id) => exist.has(id));
    }
    if (this.editing?.id && !this.elements.some((el) => el.id === this.editing!.id)) this.editing = null;
  }

  /** Marquee (CNV-33): elements wholly inside the rectangle join the selection; locked ones are skipped. */
  marquee(rect: Rect, additive: boolean): void {
    const index = this.c.pipeline.canvas.index;
    const inside = index.entries().filter(({ el, x, y, w, h }) => !el.locked &&
      x >= rect.x && y >= rect.y && x + w <= rect.x + rect.w && y + h <= rect.y + rect.h).map(({ el }) => el.id);
    const ids = expandGroups(this.elements, inside);
    this.selected = additive ? [...new Set([...this.selected, ...ids])] : ids;
  }

  setTool(tool: CanvasTool): void {
    if (tool === 'image') {
      this.pickImage();
      return;
    }
    this.finishText();
    this.tool = tool;
    if (tool !== 'select' && tool !== 'hand') this.clearSelection();
    this.c.canvas.style.cursor = this.cursor();
  }

  cursor(): string {
    return this.tool === 'hand' ? 'grab' : this.tool === 'select' ? 'default' : this.tool === 'text' ? 'text' : 'crosshair';
  }

  // ---------------------------------------------------------------- preview

  private preview(replace?: Map<string, CanvasElement | null>, extra?: CanvasElement[], fade?: Map<string, number>): void {
    const hideText = this.editing?.id ? new Set([this.editing.id]) : undefined;
    this.c.pipeline.canvasPreview = replace || extra || fade || hideText ? { replace, extra, fade, hideText } : null;
    this.tick++;
    this.c.markCanvas();
  }

  clearPreview(): void {
    if (!this.c.pipeline?.canvasPreview) return;
    this.preview();
  }

  private commit(tx: Transaction | null | undefined, select?: readonly string[]): void {
    if (tx) {
      try {
        this.c.editor.apply(tx);
      } catch (error) {
        this.c.say(error instanceof Error ? error.message : String(error), 'error');
      }
    }
    this.preview();
    if (select) this.select(select);
  }

  // ---------------------------------------------------------------- pointer

  /** Primary-button pointerdown on the canvas. True when the canvas tools took it. */
  onPointerDown(e: PointerEvent): boolean {
    const w = this.world(e);
    this.pointerWorld = w;
    if (this.editing) this.finishText();
    if (this.tool === 'hand') return this.capture(e, { kind: 'pan', pointer: e.pointerId, last: { x: e.clientX, y: e.clientY } });
    if (this.tool === 'laser') {
      this.addLaser(w);
      return this.capture(e, { kind: 'laser', pointer: e.pointerId });
    }
    if (this.tool === 'eraser') {
      const g: Gesture = { kind: 'erase', pointer: e.pointerId, hits: new Set() };
      this.capture(e, g);
      this.erase(g, w);
      return true;
    }
    if (CREATE.has(this.tool)) {
      this.c.select([]);
      this.clearSelection();
      const start = this.snapPoint(w);
      const g: Gesture = {
        kind: 'create', pointer: e.pointerId, tool: this.tool, start, current: start, client: { x: e.clientX, y: e.clientY },
        moved: false, shift: e.shiftKey, alt: e.altKey
      };
      if (this.tool === 'draw') {
        g.points = [0, 0];
        g.pressures = [e.pressure || 0.5];
        g.start = w;
      }
      if (this.tool === 'arrow' || this.tool === 'line') g.startBind = this.bindTarget(w);
      return this.capture(e, g);
    }
    // Select tool.
    const hit = this.hitElement(w);
    const additive = e.shiftKey;
    if (!hit || hit === 'node') {
      if (!additive && !(e.metaKey || e.ctrlKey)) this.clearSelection();
      return false;
    }
    const deep = e.metaKey || e.ctrlKey;
    const ids = deep ? [hit.id] : expandGroups(this.elements, [hit.id]);
    if (additive) {
      const set = new Set(this.selected);
      const all = ids.every((id) => set.has(id));
      for (const id of ids) if (all) set.delete(id); else set.add(id);
      this.select(this.elements.filter((el) => set.has(el.id)).map((el) => el.id), true);
    } else if (!ids.every((id) => this.selected.includes(id))) this.select(ids);
    this.c.canvas.focus({ preventScroll: true });
    const moving = this.selected.filter((id) => !this.elements.find((el) => el.id === id)?.locked);
    return this.capture(e, {
      kind: 'move', pointer: e.pointerId, start: w, client: { x: e.clientX, y: e.clientY }, active: false,
      ids: moving, nodes: [...this.c.selIds], dx: 0, dy: 0
    });
  }

  private capture(e: PointerEvent, g: Gesture): true {
    this.gesture = g;
    // Handles hide while a gesture runs and come back when it ends: tell them.
    this.tick++;
    try {
      this.c.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
    return true;
  }

  /** Pointer move on the canvas. True when a gesture of the canvas tools used it. */
  onPointerMove(e: PointerEvent): boolean {
    const w = this.world(e);
    this.pointerWorld = w;
    const g = this.gesture;
    if (!g) {
      if (e.buttons === 0 && this.tool === 'select' && this.c.pipeline.canvas.index.size) {
        const hit = this.hitElement(w);
        if (hit && hit !== 'node') {
          this.c.canvas.style.cursor = 'move';
          return true;
        }
      } else if (e.buttons === 0 && this.tool !== 'select') {
        this.c.canvas.style.cursor = this.cursor();
        return true;
      }
      return false;
    }
    if (g.pointer !== e.pointerId) return true;
    switch (g.kind) {
      case 'pan': {
        this.c.camera.panBy(e.clientX - g.last.x, e.clientY - g.last.y);
        g.last = { x: e.clientX, y: e.clientY };
        this.c.canvas.style.cursor = 'grabbing';
        break;
      }
      case 'laser':
        this.addLaser(w);
        break;
      case 'erase':
        this.erase(g, w);
        break;
      case 'create':
        this.dragCreate(g, w, e);
        break;
      case 'move': {
        if (!g.active && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_PX) break;
        g.active = true;
        let dx = w.x - g.start.x, dy = w.y - g.start.y;
        if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? dy = 0 : dx = 0;
        const grid = this.grid;
        if (grid?.snap && this.snapping && g.ids.length) {
          const box = selectionBounds(this.elements.filter((el) => g.ids.includes(el.id)));
          if (box) {
            dx = snap(box.x + dx, grid.size) - box.x;
            dy = snap(box.y + dy, grid.size) - box.y;
          }
        }
        g.dx = dx;
        g.dy = dy;
        this.previewMove(g.ids, dx, dy);
        this.adoptTarget = this.adoptable(g.ids, g.nodes) ? this.hooks.hitNode(w) : null;
        this.c.canvas.style.cursor = 'grabbing';
        break;
      }
      case 'resize': {
        const keep = e.shiftKey, centre = e.altKey;
        // Pictures keep their aspect ratio unless Shift is held; other elements keep it with Shift.
        const aspect = g.originals.every((el) => el.kind === 'image') ? !keep : keep;
        if (g.originals.length === 1) g.current = [resizeOne(g.originals[0], g.handle, w, aspect, centre)];
        else g.current = resizeMany(g.originals, g.box, resizeBox(g.box, g.handle, w, aspect, centre));
        this.preview(new Map(g.current.map((el) => [el.id, el])));
        break;
      }
      case 'rotate': {
        let delta = Math.atan2(w.y - g.centre.y, w.x - g.centre.x) - g.a0;
        if (e.shiftKey) delta = Math.round(delta / (Math.PI / 12)) * (Math.PI / 12);
        g.current = rotateMany(g.originals, g.centre, delta);
        this.preview(new Map(g.current.map((el) => [el.id, el])));
        break;
      }
      case 'endpoint': {
        const el = g.original;
        const points = (el.points ?? [0, 0, el.w, el.h]).slice();
        const resolved = this.c.pipeline.canvas.scene?.points.get(el.id) ?? points;
        const i = g.end === 'start' ? 0 : points.length - 2;
        const other = g.end === 'start' ? resolved.length - 2 : 0;
        g.bind = this.bindTarget(w, el.id);
        let p = { x: w.x - el.x, y: w.y - el.y };
        if (e.shiftKey && !g.bind) {
          const v = snapAngle(p.x - resolved[other], p.y - resolved[other + 1]);
          p = { x: resolved[other] + v.x, y: resolved[other + 1] + v.y };
        }
        for (let k = 0; k < points.length; k++) points[k] = resolved[k] ?? points[k];
        points[i] = p.x;
        points[i + 1] = p.y;
        const next: CanvasElement = { ...el, points };
        delete next[g.end];
        if (g.bind) next[g.end] = g.bind;
        g.current = next;
        this.preview(new Map([[el.id, next]]));
        break;
      }
    }
    return true;
  }

  /** Pointer up or cancel. True when a gesture of the canvas tools ended. */
  onPointerUp(e: PointerEvent): boolean {
    const g = this.gesture;
    if (!g || g.pointer !== e.pointerId) return false;
    this.gesture = null;
    this.tick++;
    try {
      this.c.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.c.canvas.style.cursor = this.cursor();
    if (e.type === 'pointercancel') {
      this.clearPreview();
      return true;
    }
    switch (g.kind) {
      case 'create':
        this.finishCreate(g);
        break;
      case 'move':
        if (g.active && this.adoptTarget) this.adopt(g.ids[0], this.adoptTarget);
        else if (g.active) this.commitMove(g.ids, g.nodes, g.dx, g.dy);
        else if (!e.shiftKey && !(e.metaKey || e.ctrlKey) && this.selected.length > 1) {
          // A click on one of several selected elements selects it (with its group).
          const hit = this.hitElement(this.world(e));
          if (hit && hit !== 'node') this.select(expandGroups(this.elements, [hit.id]));
        }
        break;
      case 'resize':
      case 'rotate':
        if (g.current) {
          const label = g.kind === 'resize' ? 'Resize' : 'Rotate';
          const changed = withFrames(g.current, this.elements, new Set(g.current.map((el) => el.id)));
          this.commit(this.replaceTx(label, changed));
        } else this.clearPreview();
        break;
      case 'endpoint':
        if (g.current) this.commit(this.replaceTx(g.bind ? 'Bind Arrow' : 'Move Arrow End', [g.current]));
        else this.clearPreview();
        break;
      case 'erase':
        // CNV-40: one transaction per drag; nodes are never erased.
        this.commit(deleteElements(this.c.doc, [...g.hits], 'Erase', (el, end) => this.endPoint(el, end))?.tx);
        break;
    }
    return true;
  }

  /** Cancel the running gesture (Escape). */
  cancel(): boolean {
    if (!this.gesture) return false;
    this.gesture = null;
    this.adoptTarget = null;
    this.tick++;
    this.clearPreview();
    return true;
  }

  // ---------------------------------------------------------------- drawing (CNV-31)

  private snapPoint(p: Vec2): Vec2 {
    const grid = this.grid;
    return grid?.snap && this.snapping ? { x: snap(p.x, grid.size), y: snap(p.y, grid.size) } : p;
  }

  private dragCreate(g: Extract<Gesture, { kind: 'create' }>, w: Vec2, e: PointerEvent): void {
    if (!g.moved && Math.hypot(e.clientX - g.client.x, e.clientY - g.client.y) < DRAG_PX) return;
    g.moved = true;
    g.shift = e.shiftKey;
    g.alt = e.altKey;
    if (g.tool === 'draw') {
      const x = w.x - g.start.x, y = w.y - g.start.y;
      const n = g.points!.length;
      if (Math.hypot(x - g.points![n - 2], y - g.points![n - 1]) * this.zoom < 1.5) return;
      g.points!.push(x, y);
      g.pressures!.push(e.pressure || 0.5);
    } else g.current = this.snapPoint(w);
    const el = this.draft(g);
    if (el) this.preview(undefined, [el]);
  }

  /** The element a creation gesture would make right now. */
  private draft(g: Extract<Gesture, { kind: 'create' }>): CanvasElement | null {
    const style = this.style;
    if (g.tool === 'draw') {
      const el = newElement('draw', { x: g.start.x, y: g.start.y, w: 0, h: 0 }, style);
      el.points = g.points!.slice();
      el.pressures = g.pressures!.slice();
      const box = elementBox(el);
      return { ...el, w: box.w, h: box.h };
    }
    let dx = g.current.x - g.start.x, dy = g.current.y - g.start.y;
    if (g.tool === 'arrow' || g.tool === 'line') {
      if (g.shift) ({ x: dx, y: dy } = snapAngle(dx, dy));
      const el = newElement(g.tool, { x: g.start.x, y: g.start.y, w: Math.abs(dx), h: Math.abs(dy) }, style);
      el.points = [0, 0, dx, dy];
      if (g.startBind) el.start = g.startBind;
      const end = this.bindTarget({ x: g.start.x + dx, y: g.start.y + dy }, undefined, g.startBind);
      if (end) el.end = end;
      return el;
    }
    if (g.shift) {
      const s = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * s;
      dy = Math.sign(dy || 1) * s;
    }
    const x0 = g.alt ? g.start.x - Math.abs(dx) : Math.min(g.start.x, g.start.x + dx);
    const y0 = g.alt ? g.start.y - Math.abs(dy) : Math.min(g.start.y, g.start.y + dy);
    const w = g.alt ? Math.abs(dx) * 2 : Math.abs(dx), h = g.alt ? Math.abs(dy) * 2 : Math.abs(dy);
    const el = newElement(g.tool as CanvasElementKind, { x: x0, y: y0, w: Math.max(w, 1), h: Math.max(h, 1) }, style);
    if (g.tool === 'frame') el.text = 'Frame ' + (this.elements.filter((e) => e.kind === 'frame').length + 1);
    return el;
  }

  private finishCreate(g: Extract<Gesture, { kind: 'create' }>): void {
    let el: CanvasElement | null = g.moved ? this.draft(g) : null;
    if (!g.moved) {
      // A click: notes and text are placed at the pointer and typed into; shapes get a default size.
      if (g.tool === 'text') {
        this.clearPreview();
        this.editing = { id: null, kind: 'text', at: g.start, text: '' };
        this.preview();
        return;
      }
      const size = g.tool === 'note' ? NOTE_SIZE : g.tool === 'frame' ? 400 : 120;
      const h = g.tool === 'note' ? NOTE_SIZE : g.tool === 'frame' ? 300 : 80;
      if (g.tool === 'draw' || g.tool === 'arrow' || g.tool === 'line') {
        this.clearPreview();
        return;
      }
      el = this.draft({ ...g, current: { x: g.start.x + size, y: g.start.y + h } });
      if (el) { el.x -= size / 2; el.y -= h / 2; }
    }
    if (!el || (!isPath(el.kind) && (el.w < 2 || el.h < 2)) || (isPath(el.kind) && Math.max(el.w, el.h) < 2)) {
      this.clearPreview();
      return;
    }
    const [placed] = withFrames([el], this.elements, new Set());
    let edit;
    try {
      edit = addElements(this.c.doc, [placed]);
    } catch (error) {
      this.c.say(error instanceof Error ? error.message : String(error), 'error');
      this.clearPreview();
      return;
    }
    this.commit(edit?.tx, edit?.select);
    if (!this.locked) this.tool = 'select';
    this.c.canvas.style.cursor = this.cursor();
    if (placed.kind === 'note') this.startText(placed.id);
  }

  /** Node or element a line end at `p` would bind to (within 12 screen px), CNV-36. */
  private bindTarget(p: Vec2, self?: string, other?: CanvasBinding): CanvasBinding | undefined {
    const reach = BIND_PX / this.zoom;
    const index = this.c.pipeline.canvas.index;
    const skip = (el: CanvasElement) => el.id === self || isLinear(el.kind) || el.kind === 'draw';
    const front = index.size ? index.hitTest(p, reach, 'front', skip) : null;
    if (front) return front.id === other?.element ? undefined : { element: front.id };
    const node = this.c.pipeline.canvasSpatial.hitTest(p, reach);
    if (node && this.c.doc.nodes[node]) return node === other?.node ? undefined : { node };
    const back = index.size ? index.hitTest(p, reach, 'back', (el) => skip(el) || (el.kind === 'frame' && !el.fill)) : null;
    if (back) return back.id === other?.element ? undefined : { element: back.id };
    // A shape's inside also counts, not only its outline.
    for (const hit of index.query({ x: p.x, y: p.y, w: 0, h: 0 }).reverse()) {
      const el = this.elements.find((x) => x.id === hit);
      if (!el || skip(el) || el.kind === 'frame') continue;
      const box = elementBox(el);
      if (p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h) return el.id === other?.element ? undefined : { element: el.id };
    }
  }

  /** The world point where a bound end is drawn now, so it stays there when its target goes away. */
  endPoint(el: CanvasElement, end: 'start' | 'end'): Vec2 | undefined {
    const points = this.c.pipeline.canvas.scene?.points.get(el.id);
    if (!points || points.length < 4) return;
    const i = end === 'start' ? 0 : points.length - 2;
    if (el.angle) return;
    return { x: el.x + points[i], y: el.y + points[i + 1] };
  }

  // ---------------------------------------------------------------- move, resize, rotate (CNV-32)

  /** Replace ops for whole elements, with resolved points stored for bound lines. */
  private replaceTx(label: string, elements: readonly CanvasElement[]): Transaction | null {
    const before = new Map(this.elements.map((el) => [el.id, el]));
    const ops: Op[] = elements.filter((el) => before.has(el.id) && JSON.stringify(el) !== JSON.stringify(before.get(el.id)))
      .map((el) => ({ t: 'canvas', id: el.id, value: this.storedPoints(el) }));
    return ops.length ? { label, source: 'user', ops } : null;
  }

  /** A bound line keeps its drawn points in the document too, so it stays put if its target is deleted. */
  private storedPoints(el: CanvasElement): CanvasElement {
    if (!isLinear(el.kind) || (!el.start && !el.end) || el.angle) return el;
    const resolved = this.c.pipeline.canvas.scene?.points.get(el.id);
    return resolved ? { ...el, points: resolved.slice() } : el;
  }

  private moved(ids: readonly string[], dx: number, dy: number): CanvasElement[] {
    const tx = ids.length ? translateTx(this.c.doc, ids, dx, dy) : null;
    const moving = new Set<string>();
    const out: CanvasElement[] = [];
    for (const op of tx?.ops ?? []) if (op.t === 'canvas' && op.value) { out.push(op.value); moving.add(op.id); }
    return withFrames(out, this.elements, moving);
  }

  private previewMove(ids: readonly string[], dx: number, dy: number): void {
    this.preview(new Map(this.moved(ids, dx, dy).map((el) => [el.id, el])));
  }

  /** Preview the selected elements following a node drag (a mixed selection moves together). */
  followNodeDrag(dx: number, dy: number): void {
    if (this.selected.length) this.previewMove(this.selected, dx, dy);
  }

  /** Ops that move the selected elements by (dx, dy), for a node drag's transaction. */
  moveOps(dx: number, dy: number): Op[] {
    this.clearPreview();
    if (!this.selected.length || (!dx && !dy)) return [];
    return this.moved(this.selected, dx, dy).map((el) => ({ t: 'canvas', id: el.id, value: this.storedPoints(el) }));
  }

  private commitMove(ids: readonly string[], nodes: readonly NodeId[], dx: number, dy: number): void {
    if (!dx && !dy) return this.clearPreview();
    const ops: Op[] = this.moved(ids, dx, dy).map((el) => ({ t: 'canvas', id: el.id, value: this.storedPoints(el) }));
    ops.push(...nodeMoveOps(this.c.doc, nodes, dx, dy));
    this.commit(ops.length ? { label: 'Move Elements', source: 'user', ops } : null);
  }

  /** Arrow keys (CNV-32): nudge by 1, or 10 with Shift. */
  nudge(dx: number, dy: number): void {
    const ops: Op[] = this.moved(this.selected.filter((id) => !this.elements.find((el) => el.id === id)?.locked), dx, dy)
      .map((el) => ({ t: 'canvas', id: el.id, value: this.storedPoints(el) }));
    if (ops.length) this.commit({ label: 'Nudge', source: 'user', ops });
  }

  startResize(e: PointerEvent, handle: Handle): void {
    const originals = this.selectedElements.filter((el) => !el.locked);
    const box = selectionBounds(originals);
    if (!originals.length || !box) return;
    this.capture(e, { kind: 'resize', pointer: e.pointerId, handle, originals, box });
  }

  startRotate(e: PointerEvent): void {
    const originals = this.selectedElements.filter((el) => !el.locked);
    const box = originals.length === 1 ? elementBox(originals[0]) : selectionBounds(originals);
    if (!originals.length || !box) return;
    const centre = boxCentre(box), w = this.world(e);
    this.capture(e, { kind: 'rotate', pointer: e.pointerId, originals, centre, a0: Math.atan2(w.y - centre.y, w.x - centre.x) });
  }

  startEndpoint(e: PointerEvent, id: string, end: 'start' | 'end'): void {
    const original = this.elements.find((el) => el.id === id);
    if (!original || original.locked) return;
    this.capture(e, { kind: 'endpoint', pointer: e.pointerId, id, end, original });
  }

  /** Bring the pointer events of a handle (a DOM element above the canvas) into the running gesture. */
  handleMove(e: PointerEvent): void {
    this.onPointerMove(e);
  }

  handleUp(e: PointerEvent): void {
    this.onPointerUp(e);
  }

  // ---------------------------------------------------------------- notes and maps (CNV-43, 44)

  /** One note or text element dragged on its own can be dropped on a node. */
  private adoptable(ids: readonly string[], nodes: readonly NodeId[]): boolean {
    if (ids.length !== 1 || nodes.length) return false;
    const el = this.elements.find((x) => x.id === ids[0]);
    return !!el && (el.kind === 'note' || el.kind === 'text') && !!el.text?.trim();
  }

  /** Adopt a note (CNV-44): it becomes the last child of the node and leaves the canvas, in one transaction. */
  private adopt(id: string, parent: NodeId): void {
    this.adoptTarget = null;
    const doc = this.c.doc, el = this.elements.find((x) => x.id === id), node = doc.nodes[parent];
    if (!el?.text || !node) return this.clearPreview();
    const child = newId();
    const ops: Op[] = [
      { t: 'insert', node: { id: child, parent, children: [], text: el.text.trim(), origin: { by: 'user' } }, parent, index: node.children.length },
      ...(node.collapsed ? [{ t: 'set', id: parent, patch: { collapsed: undefined } } as Op] : []),
      ...(deleteElements(doc, [id], undefined, (e, end) => this.endPoint(e, end))?.tx.ops ?? [])
    ];
    this.selected = [];
    this.commit({ label: 'Adopt Note', source: 'user', ops });
    this.c.select([child]);
  }

  /** The selection can become a map: notes and text with words in them, and arrows between them. */
  get canMakeMap(): boolean {
    const els = this.selectedElements;
    return els.some((el) => (el.kind === 'note' || el.kind === 'text') && el.text?.trim()) &&
      els.every((el) => el.kind === 'note' || el.kind === 'text' || isLinear(el.kind));
  }

  /**
   * Make this a map (CNV-43): selected notes and text become a floating map. Arrows between them give parent and
   * child; without arrows the largest (then the top-left) is the centre and the rest are its children in reading
   * order. The elements (and the arrows used) are removed in the same transaction.
   */
  makeMap(): void {
    const doc = this.c.doc;
    const items = this.selectedElements.filter((el) => (el.kind === 'note' || el.kind === 'text') && el.text?.trim());
    if (!items.length) return;
    const ids = new Set(items.map((el) => el.id));
    const edges = this.elements.filter((el) => isLinear(el.kind) && el.start?.element && el.end?.element &&
      ids.has(el.start.element) && ids.has(el.end.element) && el.start.element !== el.end.element);
    const parent = new Map<string, string>();
    for (const a of edges) if (!parent.has(a.end!.element!)) parent.set(a.end!.element!, a.start!.element!);
    // Break cycles: an item whose chain of parents comes back round loses its parent.
    for (const el of items) {
      const seen = new Set<string>();
      for (let p = parent.get(el.id); p; p = parent.get(p)) {
        if (p === el.id || seen.has(p)) { parent.delete(el.id); break; }
        seen.add(p);
      }
    }
    const area = (el: CanvasElement) => Math.abs(el.w * el.h);
    const reading = (a: CanvasElement, b: CanvasElement) => (Math.abs(a.y - b.y) > 24 ? a.y - b.y : a.x - b.x);
    const orphans = items.filter((el) => !parent.has(el.id));
    const root = [...orphans].sort((a, b) => area(b) - area(a) || reading(a, b))[0];
    for (const el of orphans) if (el !== root) parent.set(el.id, root.id);
    const nodeIds = new Map(items.map((el) => [el.id, newId()]));
    const ops: Op[] = [];
    const centre = boxCentre(elementBox(root));
    const add = (el: CanvasElement, parentId: string | null, index: number) => {
      const id = nodeIds.get(el.id)!;
      ops.push({
        t: 'insert', node: { id, parent: parentId, children: [], text: el.text!.trim(), origin: { by: 'user' } },
        parent: parentId, index, ...(parentId ? {} : { rootInfo: { layout: 'mindmap' as const, position: centre } })
      });
      items.filter((x) => parent.get(x.id) === el.id).sort(reading).forEach((child, i) => add(child, id, i));
    };
    add(root, null, doc.roots.length);
    const removal = deleteElements(doc, [...ids, ...edges.map((a) => a.id)], undefined, (e, end) => this.endPoint(e, end));
    if (removal) ops.push(...removal.tx.ops);
    this.selected = [];
    this.commit({ label: 'Make a Map', source: 'user', ops });
    this.c.select([nodeIds.get(root.id)!]);
  }

  // ---------------------------------------------------------------- eraser and laser (CNV-40, 41)

  private erase(g: Extract<Gesture, { kind: 'erase' }>, w: Vec2): void {
    const index = this.c.pipeline.canvas.index;
    const tolerance = HIT_PX / this.zoom;
    const before = g.hits.size;
    for (const band of ['front', 'back'] as const) {
      const hit = index.hitTest(w, tolerance, band, (el) => !!el.locked || g.hits.has(el.id));
      if (hit) g.hits.add(hit.id);
    }
    if (g.hits.size !== before) this.preview(undefined, undefined, new Map([...g.hits].map((id) => [id, 0.25])));
  }

  private addLaser(w: Vec2): void {
    const now = performance.now();
    this.laser = [...this.laser.filter((p) => now - p.t < 1000), { x: w.x, y: w.y, t: now }];
    if (!this.laserTimer) {
      const fade = () => {
        const t = performance.now();
        this.laser = this.laser.filter((p) => t - p.t < 1000);
        this.laserTimer = this.laser.length ? requestAnimationFrame(fade) : 0;
      };
      this.laserTimer = requestAnimationFrame(fade);
    }
  }

  // ---------------------------------------------------------------- text (CNV-34)

  /** Edit the text of an element in place: a note, text, a shape's label, an arrow's label or a frame's name. */
  startText(id: string): boolean {
    const el = this.elements.find((x) => x.id === id);
    if (!el || el.kind === 'image' || el.kind === 'draw' || el.locked) return false;
    this.editing = { id, kind: el.kind, text: el.text ?? '' };
    this.select([id]);
    this.preview();
    return true;
  }

  /** Text element style for the editor: family, size, colour and alignment as drawn. */
  textStyle(edit: TextEdit): { family: string; size: number; align: 'left' | 'center' | 'right'; color: string } {
    const el = edit.id ? this.elements.find((x) => x.id === edit.id) : undefined;
    const size = el?.fontSize ?? (el?.kind === 'frame' ? 14 : this.style.fontSize ?? DEFAULT_ELEMENT_FONT_SIZE);
    const family = elementFontFamily(el ? el.font : this.style.font, this.c.theme.fontFamily);
    const align = el?.align ?? (edit.kind === 'text' || edit.kind === 'frame' ? 'left' : 'center');
    const theme = this.c.theme;
    const fill = el?.fill ?? (el?.kind === 'note' ? NOTE_FILL : undefined);
    const ink = el?.textColor ?? (el?.kind === 'text' ? el.stroke : undefined) ?? theme.textColor;
    const color = fill && el?.kind !== 'text' ? readableInk(ink, theme.background, fill) : readableInk(ink, theme.background);
    return { family, size, align, color };
  }

  /** Commit the text being edited (Escape, a click elsewhere or Command+Enter). */
  finishText(value?: string): void {
    const edit = this.editing;
    if (!edit) return;
    this.editing = null;
    const text = (value ?? edit.text).replace(/\s+$/, '');
    const doc = this.c.doc;
    if (!edit.id) {
      this.preview();
      if (!text.trim() || !edit.at) return;
      const el = newElement('text', { x: edit.at.x, y: edit.at.y, w: 1, h: 1 }, this.style);
      el.text = text;
      const size = this.measure(el);
      const placed = withFrames([{ ...el, ...size, y: edit.at.y - size.h / 2 }], this.elements, new Set())[0];
      const added = addElements(doc, [placed]);
      this.commit(added?.tx, added?.select);
      if (!this.locked) this.tool = 'select';
      return;
    }
    const el = this.elements.find((x) => x.id === edit.id);
    if (!el) return this.preview();
    if (el.kind === 'text' && !text.trim()) {
      this.commit(deleteElements(doc, [el.id], 'Delete Text', (e, end) => this.endPoint(e, end))?.tx);
      return;
    }
    const patch: Partial<CanvasElement> = { text: text || undefined };
    if (el.kind === 'text') Object.assign(patch, this.measure({ ...el, text }));
    this.commit(updateElements(doc, [[el.id, patch]], 'Edit Text')?.tx);
  }

  private measure(el: CanvasElement): { w: number; h: number } {
    const font = { family: elementFontFamily(el.font, this.c.theme.fontFamily), size: el.fontSize ?? DEFAULT_ELEMENT_FONT_SIZE, bold: false, italic: false };
    const m = measureLabel(el.text ?? '', font, 100000);
    return { w: Math.max(4, Math.ceil(m.w)), h: Math.max(font.size * 1.25, Math.ceil(m.h)) };
  }

  /** Double-click (CNV-34): edit the text of the element under the pointer. True when it did. */
  onDoubleClick(e: MouseEvent): boolean {
    const w = this.world(e);
    let hit = this.hitElement(w);
    if (!hit) {
      // Inside an unfilled shape: a double-click still edits its label (the click itself only hits the outline).
      for (const id of this.c.pipeline.canvas.index.query({ x: w.x, y: w.y, w: 0, h: 0 }).reverse()) {
        const el = this.elements.find((x) => x.id === id);
        if (!el || (el.kind !== 'rect' && el.kind !== 'ellipse' && el.kind !== 'diamond')) continue;
        const box = elementBox(el);
        if (w.x >= box.x && w.x <= box.x + box.w && w.y >= box.y && w.y <= box.y + box.h) {
          hit = { id, band: 'back' };
          break;
        }
      }
    }
    if (!hit || hit === 'node') {
      if (this.tool === 'text') {
        this.editing = { id: null, kind: 'text', at: w, text: '' };
        return true;
      }
      return false;
    }
    return this.startText(hit.id);
  }

  // ---------------------------------------------------------------- commands

  /** Delete the selected elements and nodes in one transaction (CNV-33). */
  deleteSelection(nodes: readonly NodeId[]): boolean {
    const doc = this.c.doc;
    const elements = [...this.selected];
    if (!elements.length) return false;
    const ops: Op[] = [];
    let draft = doc;
    if (nodes.length) {
      const edit = deleteSubtree(doc, nodes);
      if (edit) {
        // Bound ends stay where they are drawn (CNV-36), so release them with the drawn points.
        const gone = new Set(nodes.flatMap((id) => subtreeIds(doc, id)));
        const nodeOps = edit.tx.ops.filter((op) => op.t !== 'canvas');
        const release = releaseTargets(doc, gone, 'node', (el, end) => this.endPoint(el, end));
        draft = cloneDoc(doc);
        applyOps(draft, [...nodeOps, ...release]);
        ops.push(...nodeOps, ...release);
      }
    }
    const removal = deleteElements(draft, elements, undefined, (el, end) => this.endPoint(el, end));
    if (removal) ops.push(...removal.tx.ops);
    this.selected = [];
    if (nodes.length) this.c.select([]);
    this.commit(ops.length ? { label: nodes.length ? 'Delete' : removal?.tx.label ?? 'Delete Elements', source: 'user', ops } : null);
    return true;
  }

  /** A node deletion whose arrow ends bound to the deleted nodes stay where they are drawn (CNV-36). */
  keepDrawnEnds(tx: Transaction, nodes: readonly NodeId[]): Transaction {
    const doc = this.c.doc;
    if (!doc.canvas) return tx;
    const gone = new Set(nodes.flatMap((id) => subtreeIds(doc, id)));
    return { ...tx, ops: [...tx.ops.filter((op) => op.t !== 'canvas'), ...releaseTargets(doc, gone, 'node', (el, end) => this.endPoint(el, end))] };
  }

  duplicate(): void {
    try {
      const edit = duplicateElements(this.c.doc, this.selected, { x: 20, y: 20 });
      this.commit(edit?.tx, edit?.select);
    } catch (error) {
      this.c.say(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  group(): void {
    const edit = groupElements(this.c.doc, this.selected);
    this.commit(edit?.tx, edit?.select);
  }

  ungroup(): void {
    const edit = ungroupElements(this.c.doc, this.selected);
    this.commit(edit?.tx, edit?.select);
  }

  toggleLock(): void {
    const lock = this.selectedElements.some((el) => !el.locked);
    this.commit(lockElements(this.c.doc, this.selected, lock)?.tx);
  }

  reorder(to: 'front' | 'back' | 'forward' | 'backward'): void {
    this.commit(reorderElements(this.c.doc, this.selected, to)?.tx);
  }

  setBand(band: 'back' | 'front'): void {
    this.commit(setBand(this.c.doc, this.selected, band)?.tx);
  }

  /** Style bar (CNV-35): change the selected elements and remember the choice for new ones. */
  applyStyle(patch: Partial<CanvasElement>, remember: Partial<ElementStyle> = patch as Partial<ElementStyle>): void {
    this.style = { ...this.style, ...remember };
    if (!this.selected.length) return;
    this.commit(styleElements(this.c.doc, this.selected, patch)?.tx);
  }

  toggleGrid(): void {
    const grid = this.grid;
    this.commit(setGrid(this.c.doc, grid ? undefined : { size: CANVAS_GRID, snap: true }));
  }

  toggleSnapping(): void {
    this.snapping = !this.snapping;
    this.c.say(this.snapping ? 'Snapping to the grid is on.' : 'Snapping to the grid is off.');
  }

  // ---------------------------------------------------------------- views (CNV-01, 04, 05)

  /** Bounds of every map and every canvas element. */
  everything(): Rect | null {
    const layout = this.c.pipeline.layout;
    const parts: Rect[] = [];
    if (layout.boxes.size) parts.push(layout.bounds);
    const elements = this.c.pipeline.canvas.index.extent();
    if (elements) parts.push(elements);
    return union(parts);
  }

  /** Bounds of the selected elements (with `nodes` when given). */
  selectionRect(nodes: Rect | null): Rect | null {
    const index = this.c.pipeline.canvas.index;
    const parts = this.selected.map((id) => index.bounds(id)).filter((r): r is Rect => !!r);
    if (nodes) parts.push(nodes);
    return union(parts);
  }

  addBookmark(): void {
    const n = (this.c.doc.canvas?.bookmarks?.length ?? 0) + 1;
    this.commit(addBookmark(this.c.doc, 'View ' + n, this.c.camera.getState()));
    this.c.say('Saved this view as View ' + n + '.' + (n <= 9 ? ' Control+' + n + ' returns to it.' : ''));
  }

  deleteBookmark(id: string): void {
    this.commit(deleteBookmark(this.c.doc, id));
  }

  goToBookmark(index: number): boolean {
    const mark = this.c.doc.canvas?.bookmarks?.[index];
    if (!mark) return false;
    this.history.jumping();
    void this.c.camera.animateTo(mark.view, reduceMotion() ? 0 : 400);
    return true;
  }

  // ---------------------------------------------------------------- keys

  /** Keys for the canvas (spec 7.3). True when handled; the controller then does nothing more. */
  onKeyDown(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    if (target?.dataset?.elementEditor !== undefined) {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.finishText((target as HTMLTextAreaElement).value);
        this.c.canvas.focus({ preventScroll: true });
      }
      return true;
    }
    if (isTypingTarget(e.target) || e.isComposing) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape' && this.cancel()) return true;
    if (mod && e.altKey && e.code === 'KeyG' && this.selected.length) {
      e.preventDefault();
      if (e.shiftKey) this.ungroup(); else this.group();
      return true;
    }
    if (!mod && !e.altKey && e.shiftKey && (e.code === 'Digit1' || e.code === 'Digit2')) {
      e.preventDefault();
      if (e.code === 'Digit1') this.c.zoomFit(); else this.c.zoomSelection();
      return true;
    }
    if (mod && !e.altKey && !e.shiftKey && e.code === 'Quote') {
      e.preventDefault();
      this.toggleGrid();
      return true;
    }
    if (e.altKey && !mod && !e.shiftKey && e.code === 'KeyS') {
      e.preventDefault();
      this.toggleSnapping();
      return true;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      if (this.goToBookmark(Number(e.code.slice(5)) - 1)) {
        e.preventDefault();
        return true;
      }
    }
    if (mod && e.altKey && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const view = e.key === 'ArrowLeft' ? this.history.back(this.c.camera.getState()) : this.history.forward();
      if (view) void this.c.camera.animateTo(view, reduceMotion() ? 0 : 400);
      return true;
    }
    const elementsOnly = this.selected.length > 0 && !this.c.focusId;
    if (elementsOnly) {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        this.deleteSelection([]);
        return true;
      }
      if (mod && !e.altKey && e.code === 'KeyD') {
        e.preventDefault();
        this.duplicate();
        return true;
      }
      if (mod && e.shiftKey && e.code === 'KeyL') {
        e.preventDefault();
        this.toggleLock();
        return true;
      }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (!mod && !e.altKey && arrows[e.key]) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        this.nudge(arrows[e.key][0] * step, arrows[e.key][1] * step);
        return true;
      }
      if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey && this.selected.length === 1) {
        e.preventDefault();
        this.startText(this.selected[0]);
        return true;
      }
    }
    if (this.selected.length && mod && !e.altKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
      e.preventDefault();
      const up = e.code === 'BracketRight';
      this.reorder(e.shiftKey ? (up ? 'front' : 'back') : (up ? 'forward' : 'backward'));
      return true;
    }
    if (e.key === 'Escape' && !this.c.focusId) {
      if (this.tool !== 'select' && !this.selected.length) {
        this.setTool('select');
        return true;
      }
      if (this.selected.length) {
        this.clearSelection();
        return true;
      }
    }
    // DEC-C5: single-letter tool keys only while no node is focused and nothing is edited.
    if (!mod && !e.altKey && !e.shiftKey && !this.c.focusId && !this.c.editingId && e.key.length === 1 && !e.repeat) {
      const key = e.key.toLowerCase();
      if (key === 'q') {
        this.locked = !this.locked;
        e.preventDefault();
        return true;
      }
      const tool = TOOL_KEYS[key];
      if (tool) {
        e.preventDefault();
        this.setTool(tool);
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- clipboard (CNV-39, 51)

  /** Copy (or cut) selected elements as Excalidraw clipboard JSON. False when no element is selected. */
  onCopy(e: ClipboardEvent, cut: boolean): boolean {
    if (!this.selected.length || !e.clipboardData) return false;
    const elements = this.selectedElements;
    const json = stringifyExcalidraw(elements, { type: 'clipboard', points: this.c.pipeline.canvas.scene?.points });
    e.clipboardData.setData(CANVAS_MIME, json);
    if (!this.c.selIds.length) {
      e.clipboardData.setData('text/plain', json);
      e.preventDefault();
      if (cut) this.deleteSelection([]);
      else this.c.say(`Copied ${elements.length === 1 ? 'an element' : elements.length + ' elements'}`, 'info');
      return true;
    }
    return false;
  }

  /** Paste Excalidraw clipboard or file JSON at the pointer (CNV-51). True when the clipboard held elements. */
  onPaste(e: ClipboardEvent): boolean {
    const cd = e.clipboardData;
    if (!cd) return false;
    const raw = cd.getData(CANVAS_MIME) || cd.getData('text/plain');
    if (!raw || !raw.trimStart().startsWith('{')) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!isExcalidraw(parsed)) return false;
    e.preventDefault();
    void this.insertExcalidraw(parsed, this.pointerWorld);
    return true;
  }

  /** Put the elements of an Excalidraw file or clipboard on the canvas, centred on `at` (default: the view). */
  async insertExcalidraw(input: unknown, at?: Vec2 | null): Promise<void> {
    const doc = this.c.doc;
    let result;
    try {
      result = parseExcalidraw(input);
    } catch (error) {
      this.c.say(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    if (!result.elements.length) return this.c.say('There was nothing to paste.');
    const limit = canvasLimitError(doc, result.elements.length);
    if (limit) return this.c.say(limit, 'error');
    let elements = result.elements;
    if (result.assets.length) {
      const map = new Map<string, string>();
      for (const asset of result.assets) {
        try {
          const bytes = Uint8Array.from(atob(asset.dataURL.slice(asset.dataURL.indexOf(',') + 1)), (ch) => ch.charCodeAt(0));
          map.set(asset.fileId, await this.c.host.assetPut(bytes, asset.mimeType, { createdBy: 'user' }));
        } catch {
          /* a picture that cannot be stored is left out */
        }
      }
      elements = remapAssets(elements, map);
    }
    if (this.c.doc !== doc) return;
    const box = selectionBounds(elements);
    const centre = at ?? { x: this.c.camera.cx, y: this.c.camera.cy };
    const offset = box ? { x: centre.x - box.x - box.w / 2, y: centre.y - box.y - box.h / 2 } : { x: 0, y: 0 };
    try {
      const edit = addElements(doc, remapPasted(elements, doc, offset), 'Paste');
      this.commit(edit?.tx, edit?.select);
    } catch (error) {
      this.c.say(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    if (result.notices.length) this.c.say(result.notices.join(' '));
  }

  // ---------------------------------------------------------------- pictures (CNV-25, 42)

  private pickImage(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void this.addImage(file);
    };
    input.click();
  }

  /** A free picture element at `at` (default: the middle of the view). */
  async addImage(file: File, at?: Vec2): Promise<void> {
    const doc = this.c.doc;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await this.c.host.assetPut(bytes, file.type || 'image/png', { createdBy: 'user' });
      const { aspect } = await this.hooks.ensureImage(hash);
      if (this.c.doc !== doc) return;
      const w = Math.min(360, 240 * Math.max(aspect, 0.5)), h = w / (aspect > 0 ? aspect : 1);
      const centre = at ?? { x: this.c.camera.cx, y: this.c.camera.cy };
      const el = newElement('image', { x: centre.x - w / 2, y: centre.y - h / 2, w, h }, {});
      el.asset = hash;
      el.text = file.name.replace(/\.[^.]+$/, '') || undefined;
      const edit = addElements(doc, withFrames([el], this.elements, new Set()));
      this.commit(edit?.tx, edit?.select);
      this.tool = 'select';
    } catch (error) {
      this.c.say('Could not add the picture: ' + (error instanceof Error ? error.message : String(error)), 'error');
    }
  }

  /** Excalidraw file export of the canvas elements (CNV-52), with resolved arrow ends. */
  excalidrawFile(): string {
    return stringifyExcalidraw(this.elements, { points: this.c.pipeline.canvas.scene?.points });
  }

  destroy(): void {
    cancelAnimationFrame(this.laserTimer);
    this.history.destroy();
  }
}

/** Clipboard type for canvas elements beside a node copy (Excalidraw JSON). */
export const CANVAS_MIME = 'web application/x-radiant-canvas';

function translateTx(doc: import('../core/types').Doc, ids: readonly string[], dx: number, dy: number): Transaction | null {
  // Members of moved frames come along; locked elements stay (CNV-38).
  const map = new Map((doc.canvas?.elements ?? []).map((el) => [el.id, el]));
  const moving = new Set(ids.filter((id) => map.has(id)));
  for (const el of map.values()) if (el.frame && moving.has(el.frame)) moving.add(el.id);
  const ops: Op[] = [];
  for (const id of moving) {
    const el = map.get(id)!;
    if (el.locked) continue;
    ops.push({ t: 'canvas', id, value: { ...el, x: el.x + dx, y: el.y + dy } });
  }
  return ops.length ? { label: 'Move Elements', source: 'user', ops } : null;
}

function union(parts: readonly Rect[]): Rect | null {
  if (!parts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of parts) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Camera history (CNV-04): places where the camera rested for more than a second. Back and forward walk them
 * (Option+Command+Left and Right); a jump made from the history is not recorded again.
 */
export class CameraHistory {
  private past: CameraState[] = [];
  private future: CameraState[] = [];
  private timer = 0;
  private skip = false;

  /** Call on every camera change. */
  moved(state: CameraState): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.rest(state), 1000);
  }

  /** The next rest comes from a jump (a bookmark or the history): it is recorded without clearing forward. */
  jumping(): void {
    this.skip = true;
  }

  private rest(state: CameraState): void {
    const last = this.past.at(-1);
    if (last && near(last, state)) return;
    if (this.skip) {
      this.skip = false;
      this.past.push({ ...state });
      return;
    }
    this.past.push({ ...state });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }

  back(current: CameraState): CameraState | undefined {
    clearTimeout(this.timer);
    let last = this.past.pop();
    if (last && near(last, current)) {
      this.future.push(last);
      last = this.past.pop();
    } else if (last) this.future.push({ ...current });
    if (!last) return;
    this.past.push(last);
    this.skip = true;
    return last;
  }

  forward(): CameraState | undefined {
    clearTimeout(this.timer);
    const next = this.future.pop();
    if (!next) return;
    this.past.push(next);
    this.skip = true;
    return next;
  }

  destroy(): void {
    clearTimeout(this.timer);
  }
}

function near(a: CameraState, b: CameraState): boolean {
  return Math.abs(a.zoom - b.zoom) < a.zoom * 0.02 && Math.hypot(a.cx - b.cx, a.cy - b.cy) * a.zoom < 24;
}

