import type { CameraState, Rect, Vec2 } from '../core/types';

export const MIN_ZOOM = 0.0001;
export const MAX_ZOOM = 8;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface CameraInit extends Partial<CameraState> {
  width?: number;
  height?: number;
}

/**
 * Pan/zoom camera. State is the world point at the viewport centre plus zoom (screen px per world unit).
 * `width`/`height` are the viewport size in CSS px (kept up to date by CameraController, or call setViewport).
 * Every mutation notifies subscribers, so the app can requestFrame() from one place.
 */
export class Camera implements CameraState {
  cx = 0;
  cy = 0;
  zoom = 1;
  width = 800;
  height = 600;
  minZoom = MIN_ZOOM;
  maxZoom = MAX_ZOOM;
  /** true/false forces; undefined follows the OS "prefers-reduced-motion" setting. */
  reducedMotion: boolean | undefined = undefined;

  private listeners = new Set<() => void>();
  private animId = 0;
  private animResolve: ((finished: boolean) => void) | null = null;

  constructor(init: CameraInit = {}) {
    if (init.cx !== undefined) this.cx = init.cx;
    if (init.cy !== undefined) this.cy = init.cy;
    if (init.zoom !== undefined) this.zoom = clamp(init.zoom, this.minZoom, this.maxZoom);
    if (init.width !== undefined) this.width = init.width;
    if (init.height !== undefined) this.height = init.height;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  getState(): CameraState {
    return { cx: this.cx, cy: this.cy, zoom: this.zoom };
  }

  /** Jump to a state (cancels any running animation). */
  set(s: CameraState): void {
    this.cancelAnimation();
    this.cx = s.cx;
    this.cy = s.cy;
    this.zoom = clamp(s.zoom, this.minZoom, this.maxZoom);
    this.emit();
  }

  setViewport(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.emit();
  }

  worldToScreen(p: Vec2, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = (p.x - this.cx) * this.zoom + this.width / 2;
    out.y = (p.y - this.cy) * this.zoom + this.height / 2;
    return out;
  }

  screenToWorld(p: Vec2, out: Vec2 = { x: 0, y: 0 }): Vec2 {
    out.x = (p.x - this.width / 2) / this.zoom + this.cx;
    out.y = (p.y - this.height / 2) / this.zoom + this.cy;
    return out;
  }

  /** World rectangle currently visible, optionally grown by `marginPx` screen pixels. */
  visibleRect(marginPx = 0): Rect {
    const w = this.width / this.zoom;
    const h = this.height / this.zoom;
    const m = marginPx / this.zoom;
    return { x: this.cx - w / 2 - m, y: this.cy - h / 2 - m, w: w + 2 * m, h: h + 2 * m };
  }

  /** Multiply zoom by `factor`, keeping the world point under `screenPoint` fixed. */
  zoomAt(screenPoint: Vec2, factor: number): void {
    const nz = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    if (nz === this.zoom) return;
    const wx = (screenPoint.x - this.width / 2) / this.zoom + this.cx;
    const wy = (screenPoint.y - this.height / 2) / this.zoom + this.cy;
    this.zoom = nz;
    this.cx = wx - (screenPoint.x - this.width / 2) / nz;
    this.cy = wy - (screenPoint.y - this.height / 2) / nz;
    this.emit();
  }

  /** Move the content by (dx, dy) screen pixels (content follows the fingers). */
  panBy(dxScreen: number, dyScreen: number): void {
    if (dxScreen === 0 && dyScreen === 0) return;
    this.cx -= dxScreen / this.zoom;
    this.cy -= dyScreen / this.zoom;
    this.emit();
  }

  /** Pure: the camera state that fits `rect` in a viewport with `padding` px around it. */
  static fitState(
    rect: Rect,
    viewportW: number,
    viewportH: number,
    padding = 40,
    maxZoom = MAX_ZOOM,
    minZoom = MIN_ZOOM
  ): CameraState {
    const aw = Math.max(1, viewportW - 2 * padding);
    const ah = Math.max(1, viewportH - 2 * padding);
    const z = Math.min(aw / Math.max(rect.w, 1e-6), ah / Math.max(rect.h, 1e-6));
    return {
      cx: rect.x + rect.w / 2,
      cy: rect.y + rect.h / 2,
      zoom: clamp(z, minZoom, Math.min(maxZoom, MAX_ZOOM))
    };
  }

  /** Fit `rect` immediately (use `animateTo(Camera.fitState(...), ms)` to animate). Returns the new state. */
  fitRect(rect: Rect, viewportW = this.width, viewportH = this.height, padding = 40, maxZoom = this.maxZoom): CameraState {
    const s = Camera.fitState(rect, viewportW, viewportH, padding, maxZoom, this.minZoom);
    this.set(s);
    return s;
  }

  cancelAnimation(): void {
    if (this.animId) {
      cancelAnimationFrame(this.animId);
      this.animId = 0;
    }
    if (this.animResolve) {
      const r = this.animResolve;
      this.animResolve = null;
      r(false);
    }
  }

  get animating(): boolean {
    return this.animId !== 0;
  }

  /** Ease to `target` over `ms`. Resolves true when finished, false if interrupted. Jumps when reduced motion is on. */
  animateTo(target: CameraState, ms = 350): Promise<boolean> {
    this.cancelAnimation();
    const preference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const reduceMotion = () => this.reducedMotion ?? preference?.matches ?? false;
    const tz = clamp(target.zoom, this.minZoom, this.maxZoom);
    if (reduceMotion() || ms <= 0) {
      this.set(target);
      return Promise.resolve(true);
    }
    const sx = this.cx, sy = this.cy, sl = Math.log(this.zoom), tl = Math.log(tz);
    const start = performance.now();
    return new Promise<boolean>((resolve) => {
      this.animResolve = resolve;
      const step = (now: number) => {
        const t = clamp((now - start) / ms, 0, 1);
        if (t === 1 || reduceMotion()) {
          this.animId = 0;
          this.animResolve = null;
          this.set(target);
          resolve(true);
          return;
        }
        const e = easeInOutCubic(t);
        this.cx = sx + (target.cx - sx) * e;
        this.cy = sy + (target.cy - sy) * e;
        this.zoom = Math.exp(sl + (tl - sl) * e);
        this.animId = requestAnimationFrame(step);
        this.emit();
      };
      this.animId = requestAnimationFrame(step);
    });
  }

  /**
   * Long jump (presentation, PRS-08): pull back until both ends are in view, pan while zoomed out, then move in.
   * The centre moves mostly while the view is wide, so unrelated nodes never stream across the screen; there is
   * no rotation. Falls back to `animateTo` when no pull-back is needed. Resolves like `animateTo`.
   */
  flyTo(target: CameraState, ms = 800): Promise<boolean> {
    const tz = clamp(target.zoom, this.minZoom, this.maxZoom);
    const dx = Math.abs(target.cx - this.cx), dy = Math.abs(target.cy - this.cy);
    // Widest zoom that shows both centres with a quarter-viewport margin around each.
    const span = Math.min(this.width / Math.max(dx * 1.5, 1e-6), this.height / Math.max(dy * 1.5, 1e-6));
    const mid = clamp(Math.min(this.zoom, tz, span), this.minZoom, this.maxZoom);
    if (mid >= Math.min(this.zoom, tz) * 0.98) return this.animateTo(target, Math.min(ms, 350));
    this.cancelAnimation();
    const preference = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    const reduceMotion = () => this.reducedMotion ?? preference?.matches ?? false;
    if (reduceMotion() || ms <= 0) {
      this.set(target);
      return Promise.resolve(true);
    }
    const sx = this.cx, sy = this.cy, sl = Math.log(this.zoom), tl = Math.log(tz);
    const bump = (sl + tl) / 2 - Math.log(mid);
    const start = performance.now();
    return new Promise<boolean>((resolve) => {
      this.animResolve = resolve;
      const step = (now: number) => {
        const t = clamp((now - start) / ms, 0, 1);
        if (t === 1 || reduceMotion()) {
          this.animId = 0;
          this.animResolve = null;
          this.set(target);
          resolve(true);
          return;
        }
        const e = easeInOutCubic(t);
        // Pan inside the middle of the move, while the view is pulled back.
        const p = easeInOutCubic(clamp((t - 0.15) / 0.7, 0, 1));
        this.cx = sx + (target.cx - sx) * p;
        this.cy = sy + (target.cy - sy) * p;
        this.zoom = Math.exp(sl + (tl - sl) * e - bump * Math.sin(Math.PI * t));
        this.animId = requestAnimationFrame(step);
        this.emit();
      };
      this.animId = requestAnimationFrame(step);
    });
  }
}

export interface CameraControllerOptions {
  /** Called after any camera change caused by input or animation (request a frame here). */
  onChange?: () => void;
  /** Zoom per pixel of pinch delta (wheel+ctrl). Default 0.01. */
  pinchSpeed?: number;
  /** Zoom per pixel of modifier+wheel delta. Default 0.0025. */
  wheelZoomSpeed?: number;
  /**
   * When a pan drag starts the pointerdown is stopped (capture phase) so node handlers never see it.
   * Default true. UI code may also check `isPanning` / `spaceHeld`.
   */
  swallowPanEvents?: boolean;
  gestures?: CanvasGestures;
  onResize?: () => void;
}

export interface CanvasGestures {
  wheel: 'pan' | 'zoom' | 'off';
  zoomModifier: 'command-or-option' | 'command' | 'option' | 'shift' | 'off';
  pinch: boolean;
  space: boolean;
  middle: boolean;
}

export const DEFAULT_CANVAS_GESTURES: CanvasGestures = {
  wheel: 'pan', zoomModifier: 'command-or-option', pinch: true, space: true, middle: true
};

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

interface GestureLike extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

/**
 * macOS-style navigation for a canvas:
 *  - two-finger scroll pans (wheel without ctrlKey); OS momentum arrives as more wheel events
 *  - pinch zooms (wheel with ctrlKey; Safari/WebKit gesture* events)
 *  - Cmd/Alt + wheel zooms (mouse wheel)
 *  - Space+drag and middle-button drag pan
 * It never handles clicks on nodes. The UI should ignore pointer events while `isPanning || spaceHeld`.
 */
export class CameraController {
  private cleanup: Array<() => void> = [];
  private _panning = false;
  private _space = false;
  private lastX = 0;
  private lastY = 0;
  private panPointer = -1;
  private gestureStartZoom = 1;
  private lastPointer: Vec2 = { x: 0, y: 0 };
  private prevCursor = '';
  private swallow: boolean;
  private pinchSpeed: number;
  private wheelZoomSpeed: number;
  private gestures: CanvasGestures;
  private onResize?: () => void;

  constructor(
    private canvas: HTMLElement,
    readonly camera: Camera,
    opts: CameraControllerOptions = {}
  ) {
    this.swallow = opts.swallowPanEvents ?? true;
    this.pinchSpeed = opts.pinchSpeed ?? 0.01;
    this.wheelZoomSpeed = opts.wheelZoomSpeed ?? 0.0025;
    this.gestures = opts.gestures ?? DEFAULT_CANVAS_GESTURES;
    this.onResize = opts.onResize;
    if (opts.onChange) this.cleanup.push(camera.subscribe(opts.onChange));

    const on = <K extends string>(
      target: EventTarget,
      type: K,
      fn: (e: Event) => void,
      o?: AddEventListenerOptions
    ) => {
      target.addEventListener(type, fn, o);
      this.cleanup.push(() => target.removeEventListener(type, fn, o));
    };

    on(canvas, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    on(canvas, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent), { capture: true });
    on(canvas, 'pointermove', (e) => this.onPointerMove(e as PointerEvent), { capture: true });
    on(canvas, 'pointerup', (e) => this.onPointerEnd(e as PointerEvent), { capture: true });
    on(canvas, 'pointercancel', (e) => this.onPointerEnd(e as PointerEvent), { capture: true });
    on(canvas, 'auxclick', (e) => {
      if ((e as MouseEvent).button === 1) e.preventDefault();
    });
    on(canvas, 'gesturestart', (e) => this.onGestureStart(e as GestureLike));
    on(canvas, 'gesturechange', (e) => this.onGestureChange(e as GestureLike));
    on(canvas, 'gestureend', (e) => e.preventDefault());
    on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    on(window, 'blur', () => this.setSpace(false));

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.syncViewport());
      ro.observe(canvas);
      this.cleanup.push(() => ro.disconnect());
    }
    this.syncViewport();
  }

  get isPanning(): boolean {
    return this._panning;
  }
  get spaceHeld(): boolean {
    return this._space;
  }

  /** Match camera.width/height to the element's CSS size. */
  syncViewport(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w > 0 && h > 0 && (w !== this.camera.width || h !== this.camera.height)) {
      this.camera.setViewport(w, h);
      this.onResize?.();
    }
  }

  setGestures(gestures: CanvasGestures): void {
    this.gestures = gestures;
    if (!gestures.space) this.setSpace(false);
  }

  destroy(): void {
    for (const c of this.cleanup) c();
    this.cleanup = [];
    this.setSpace(false);
  }

  private local(e: { clientX: number; clientY: number }): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    this.lastPointer.x = e.clientX - r.left;
    this.lastPointer.y = e.clientY - r.top;
    return this.lastPointer;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.camera.cancelAnimation();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.camera.height : 1;
    const dx = e.deltaX * k;
    const dy = e.deltaY * k;
    const p = this.local(e);
    const { wheel, zoomModifier, pinch } = this.gestures;
    const modified = zoomModifier === 'command-or-option' ? e.metaKey || e.altKey :
      zoomModifier === 'command' ? e.metaKey : zoomModifier === 'option' ? e.altKey :
      zoomModifier === 'shift' && e.shiftKey;
    if (e.ctrlKey) {
      // Pinch on a trackpad (Chrome/Firefox report it as ctrl+wheel) or ctrl+wheel with a mouse.
      if (pinch) this.camera.zoomAt(p, clamp(Math.exp(-dy * this.pinchSpeed), 0.5, 2));
    } else if (modified || wheel === 'zoom') {
      const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      this.camera.zoomAt(p, clamp(Math.exp(-d * this.wheelZoomSpeed), 0.5, 2));
    } else if (wheel === 'pan') {
      this.camera.panBy(-dx, -dy);
    }
  }

  private onGestureStart(e: GestureLike): void {
    e.preventDefault();
    if (!this.gestures.pinch) return;
    this.camera.cancelAnimation();
    this.gestureStartZoom = this.camera.zoom;
  }

  private onGestureChange(e: GestureLike): void {
    e.preventDefault();
    if (!this.gestures.pinch) return;
    const p = this.local(e);
    const target = this.gestureStartZoom * e.scale;
    this.camera.zoomAt(p, target / this.camera.zoom);
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.code !== 'Space' || !this.gestures.space) return;
    if (down && isTypingTarget(e.target)) return;
    if (down && !this._space) {
      // Prevent page scroll / button activation while space is the pan modifier over the canvas.
      if (e.target === document.body || e.target === this.canvas) e.preventDefault();
    }
    this.setSpace(down);
  }

  private setSpace(v: boolean): void {
    if (v === this._space) return;
    this._space = v;
    if (v) {
      this.prevCursor = this.canvas.style.cursor;
      this.canvas.style.cursor = 'grab';
    } else if (!this._panning) {
      this.canvas.style.cursor = this.prevCursor;
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (this._panning) return;
    if (!(e.button === 1 && this.gestures.middle || e.button === 0 && this._space)) return;
    e.preventDefault();
    if (this.swallow) e.stopPropagation();
    this.camera.cancelAnimation();
    this._panning = true;
    this.panPointer = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.canvas.style.cursor = 'grabbing';
  }

  private onPointerMove(e: PointerEvent): void {
    this.local(e);
    if (!this._panning || e.pointerId !== this.panPointer) return;
    if (this.swallow) e.stopPropagation();
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.camera.panBy(dx, dy);
  }

  private onPointerEnd(e: PointerEvent): void {
    if (!this._panning || e.pointerId !== this.panPointer) return;
    if (this.swallow) e.stopPropagation();
    this._panning = false;
    this.panPointer = -1;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.canvas.style.cursor = this._space ? 'grab' : this.prevCursor;
  }
}
