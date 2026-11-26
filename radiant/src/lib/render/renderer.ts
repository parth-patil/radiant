import { packMeshVertices, packVertices, reliefStride } from './mesh-vertices';
import type { CameraState, ImageDraw, LabelDraw, Mesh, MeshRelief, Rect, RGBA, Scene, Vec2 } from '../core/types';
import type { RenderDevice } from './device';
import { SceneViewport, visibleBranchSpans, type FrameBounds } from './scene-viewport';
import { branchIndex } from '../core/geometry/branch-index';
import { INSTANCE_QUADS, RECORD_ROW_TEXELS, stripChunks } from '../core/geometry/branch-instances';
import { ImageCache, type ImageCacheOptions, type ImageEntry } from './images';
import { coarseBlur } from './coarse-blur';
import {
  BRANCH_INSTANCE_VS, BRANCH_RELIEF_VS, BRANCH_ROPE_VS, BRANCH_SHADOW_VS, COARSE_BLUR_VS, GRID_FS, GRID_VS, MESH_FS, MESH_VS, QUILL_FS, RECT_FS, RECT_VS, RELIEF_COMPOSITE_FS, RELIEF_FS,
  RELIEF_SHADOW_FS, RECT_RAISED_FS, RELIEF_SHADOW_VS, RELIEF_VS, ROPE_FS, ROPE_VS, SHADOW_FS, SHADOW_VS, SURFACE_FS, TEX_FS,
  TEX_VS
} from './shaders';
import { alignedLabelX, estimateExtent, LabelAtlas, type LabelEntry } from './text';
import { outlineAt } from './screen-outline';

const FAR_ART_ZOOM = 0.12;
const OVERVIEW_TITLE_PX = 11;
const OVERVIEW_CELL_PX = 16;
const OVERVIEW_TITLE_LIMIT = 48;
/** Surface dots are fully visible from this zoom and gone at SURFACE_DOTS_GONE. */
const SURFACE_DOTS_FULL = 0.4;
const SURFACE_DOTS_GONE = 0.25;
/**
 * Level of detail for dimensional branches: below this many screen px of ribbon width the lighting cannot be seen and
 * the flat program draws the mesh; a shadow layer starts when shadows reach this far on screen and is full at twice it.
 */
const RELIEF_SHADE_PX = 1.5;
const RELIEF_SHADOW_PX = 2.5;
/** Lighting per material: ambient, diffuse, specular strength, shininess (RELIEF_FS u_mat). */
const RELIEF_MATERIALS: Record<MeshRelief['material'], [number, number, number, number]> = {
  clay: [0.56, 0.56, 0.07, 6],
  arcs: [0.5, 0.6, 0.55, 40],
  rope: [0.52, 0.6, 0.18, 14],
  quilling: [1, 0, 0, 1]
};
type MeshUniforms = Record<'view' | 'zoom' | 'off' | 'offLow' | 'mat' | 'coded' | 'far', WebGLUniformLocation | null>;

function overviewBackground(color: RGBA, background: RGBA): RGBA {
  // Atlas glyphs keep their styled ink. Choose a contrasting chip when that ink
  // was designed for a node fill rather than the surrounding canvas.
  const channel = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const luminance = ({ r, g, b, a }: RGBA) => {
    const inv = 1 / Math.max(a, 0.001);
    return 0.2126 * channel(r * inv) + 0.7152 * channel(g * inv) + 0.0722 * channel(b * inv);
  };
  const ink = luminance(color);
  const canvas = luminance(background);
  if ((Math.max(ink, canvas) + 0.05) / (Math.min(ink, canvas) + 0.05) >= 4.5) return background;
  const value = ink >= 0.179 ? 0 : 1;
  return { r: value, g: value, b: value, a: 1 };
}

export interface RendererOptions {
  /** CPU budget per frame for layout + text rasterisation, ms. Default 4. */
  labelBudgetMs?: number;
  /** Text smaller than this many screen px is drawn as a bar (greeking). Default 4. */
  greekPx?: number;
  /** Image texture memory budget in bytes. Default 256 MB. */
  imageBudgetBytes?: number;
  images?: ImageCacheOptions;
  /** Tint drawn where an image has not loaded yet. */
  imagePlaceholder?: RGBA;
  /** Extra screen px around the viewport that still count as visible. Default 48. */
  cullMarginPx?: number;
  atlasPages?: number;
  /** Called after each rendered frame. */
  onFrame?: (stats: RenderStats) => void;
  onImageDecodeFailed?: (url: string) => void;
}

export interface RenderStats {
  /** CPU time of the last frame (JS + GL command submission), ms. */
  cpuMs: number;
  drawCalls: number;
  labelsDrawn: number;
  labelsGreeked: number;
  rectsDrawn: number;
  imagesDrawn: number;
  /** Atlas pages + image textures alive. */
  textures: number;
  /** Labels waiting to be rasterised (frames keep being requested until 0). */
  labelsPending: number;
  imagesLoading: number;
  gpuImageMB: number;
  meshTriangles: number;
  /** Visible canvas-element triangles, both bands. */
  canvasTriangles: number;
  /** Spatial queries and branch-index packing, excluding uploads and drawing. */
  visibleSetMs: number;
  /** Measured active animation-frame interval, with the 60 Hz budget before a sample is available. */
  refreshIntervalMs: number;
  frames: number;
}

// ---------------------------------------------------------------------------------------- helpers

class InstanceBuf {
  data: Float32Array;
  n = 0;
  constructor(readonly stride: number, cap = 1024) {
    this.data = new Float32Array(cap * stride);
  }
  reset(): void {
    this.n = 0;
  }
  /** Reserve one instance, returns the float offset to write at. */
  next(): number {
    const need = (this.n + 1) * this.stride;
    if (need > this.data.length) {
      const nd = new Float32Array(Math.max(need, this.data.length * 2));
      nd.set(this.data);
      this.data = nd;
    }
    return this.n++ * this.stride;
  }
}

const RECT_STRIDE = 16;
/** Rect and shadow instances kept on the GPU: RECT_STRIDE plus the float32 residual of x, y (RECT_VS a_low). */
const RESIDENT_STRIDE = 18;

type PlaceUniforms = Record<'view' | 'zoom' | 'off' | 'offLow' | 'min', WebGLUniformLocation | null>;
interface ResidentList { buf: WebGLBuffer; vao: WebGLVertexArrayObject; n: number }
/**
 * Every rectangle and shadow of the scene in world space relative to (ox, oy), drawn as they are while the whole map
 * is in view, so a camera move re-sends nothing. `sizes` holds each rectangle's larger side (float32, ascending), to
 * count the ones RECT_VS does not skip as smaller than a quarter pixel.
 */
interface Resident { ox: number; oy: number; shadows: ResidentList; rects: ResidentList; over: ResidentList; sizes: Float32Array }
/** Textured quad: rect (4), uv (4), opacity, then rotation (angle in radians, pivot x, y camera-relative world). */
const TEX_STRIDE = 12;

type ImageBatch = { tex: WebGLTexture | null; clipped: boolean; start: number; count: number };

function placeUniforms(gl: WebGL2RenderingContext, p: WebGLProgram): PlaceUniforms {
  const at = (name: string) => gl.getUniformLocation(p, name);
  return { view: at('u_view'), zoom: at('u_zoom'), off: at('u_off'), offLow: at('u_off_low'), min: at('u_min') };
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs]
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  return p;
}

interface MeshGPU {
  vao: WebGLVertexArrayObject;
  relief?: MeshRelief;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
  ox: number;
  oy: number;
  wide: boolean;
  src: Mesh;
  /**
   * Every vertex colour is fully opaque and the program writes that alpha unchanged (not quilling, whose scrolls fade
   * out), so drawing over the page with blending off gives the same pixels and lets the GPU skip hidden fragments.
   */
  opaque: boolean;
  /**
   * Visible part of the static index buffer this frame when culled: `runs` ranges of `runCounts` indices starting at
   * byte `runOffsets` (the shadow layer and the mesh draw the same runs). Nothing is copied or uploaded per frame.
   */
  runs: number;
  runCounts?: Int32Array;
  runOffsets?: Int32Array;
  /** Coarse level of detail (static branch mesh only), built in slices after the camera first goes below LOD_ZOOM. */
  coarse?: { ibo: WebGLBuffer | null; count: number; ends: Uint32Array; build: Uint32Array | null; span: number; timer: number };
  /** This frame draws (and culls with) the coarse indices. */
  lod: boolean;
  /**
   * GPU-expanded branches (Mesh.instances): the record texture and the chunk instances at full and coarse detail.
   * `vbo` is the full list's buffer, `ibo` the one-chunk template, `count` and runs are in chunks.
   */
  inst?: { tex: WebGLTexture; full: ChunkList; coarse: ChunkList; stride: number };
}

/** Chunk instances of GPU-expanded branches: buffer of (branch << 8 | chunk) words, cumulative chunks per branch. */
interface ChunkList { buf: WebGLBuffer; ends: Uint32Array; total: number }

/** Indices of one chunk: INSTANCE_QUADS quads of a strip, (l0, r0, l1) and (r0, r1, l1) as tessellateBatch's ribbons. */
const CHUNK_INDICES = 6 * INSTANCE_QUADS;
/** Texture unit of the branch record texture (unit 0 belongs to labels and pictures). */
const RECORD_UNIT = 3;
/** Chunk runs closer than this are drawn as one (as RUN_GAP for indices). */
const CHUNK_RUN_GAP = 256;

/**
 * Runs separated by fewer indices than this are drawn as one: the culled branches in the gap lie outside the view, so
 * they add no pixels, and fewer, longer draws cost less than many tiny ones.
 */
const RUN_GAP = 1536;
/** Camera changes closer together than this are one movement, drawn without multisampling until it ends. */
const MOVING_MS = 120;
/**
 * Frames while the camera moves skip multisampling only when the branch mesh in view is this large (triangles drawn in
 * the previous frame): the whole-map view of a map of roughly 20,000 nodes or more. Lighter frames keep their edges
 * smooth while moving, since skipping it there saves little and shows stair-steps on every edge.
 */
const MOVING_PLAIN_TRIANGLES = 400_000;
/** Smallest drawing-buffer scale (see Renderer.bufferScale). */
const MIN_BUFFER_SCALE = 2;
/**
 * Below this zoom the static branch mesh is drawn from a coarse index buffer over the same vertices: every LOD_STEP
 * ribbon segments become one, and fans (caps, dots) take every other step. The sampling keeps a quarter pixel of chord
 * error at MESH_DETAIL_ZOOM (4), so LOD_STEP^2 merged segments stay within 64 * 0.25 * 0.02 / 4 = 0.08 px here.
 */
const LOD_ZOOM = 0.02;
const LOD_STEP = 8;
/** Main-thread time per slice of the coarse index build (it runs in timer tasks, never inside a frame). */
const LOD_SLICE_MS = 3;

/**
 * Coarse indices of one branch span (`indices[start, end)`) appended to `out` from `at`; returns the new length.
 * Ribbons are quads of (q, q+1, q+2), (q+1, q+3, q+2) with q stepping by 2 (tessellate.ts); fans are (c, c+1+k, c+2+k).
 * Anything else is copied.
 */
function coarsenSpan(ind: Uint32Array, start: number, end: number, out: Uint32Array, at: number): number {
  let o = at, i = start;
  while (i < end) {
    const q = ind[i];
    let j = i, m = 0;
    while (j + 5 < end && ind[j] === q + 2 * m && ind[j + 1] === q + 2 * m + 1 && ind[j + 2] === q + 2 * m + 2 &&
      ind[j + 3] === q + 2 * m + 1 && ind[j + 4] === q + 2 * m + 3 && ind[j + 5] === q + 2 * m + 2) {
      j += 6;
      m++;
    }
    if (m >= 2) {
      for (let s = 0; s < m;) {
        const e = Math.min(m, s + LOD_STEP), p = q + 2 * s, t = q + 2 * e;
        out[o++] = p; out[o++] = p + 1; out[o++] = t;
        out[o++] = p + 1; out[o++] = t + 1; out[o++] = t;
        s = e;
      }
      i = j;
      continue;
    }
    j = i;
    m = 0;
    while (j + 2 < end && ind[j] === q && ind[j + 1] === q + 1 + m && ind[j + 2] === q + 2 + m) {
      j += 3;
      m++;
    }
    if (m >= 4) {
      for (let s = 0; s < m;) {
        const e = Math.min(m, s + 2);
        out[o++] = q; out[o++] = q + 1 + s; out[o++] = q + 1 + e;
        s = e;
      }
      i = j;
      continue;
    }
    out[o++] = ind[i]; out[o++] = ind[i + 1]; out[o++] = ind[i + 2];
    i += 3;
  }
  return o;
}

/** Every vertex's alpha byte (offset 11 in both the flat and the dimensional layout, see mesh-vertices.ts) is 255. */
function opaqueVertices(buffer: ArrayBuffer, stride: number): boolean {
  const bytes = new Uint8Array(buffer);
  for (let at = 11; at < bytes.length; at += stride) if (bytes[at] !== 255) return false;
  return true;
}

function writeShadow(b: InstanceBuf, x: number, y: number, w: number, h: number, radius: number, blur: number, color: RGBA): void {
  const o = b.next();
  const d = b.data;
  d[o] = x;
  d[o + 1] = y;
  d[o + 2] = w;
  d[o + 3] = h;
  d[o + 4] = radius;
  d[o + 5] = blur;
  d[o + 6] = color.r;
  d[o + 7] = color.g;
  d[o + 8] = color.b;
  d[o + 9] = color.a;
  for (let k = 10; k < 16; k++) d[o + k] = 0;
}

function writeRect(
  b: InstanceBuf,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  sw: number,
  fill: RGBA,
  stroke: RGBA | undefined,
  wobble?: Vec2
): void {
  const o = b.next();
  const d = b.data;
  d[o] = x;
  d[o + 1] = y;
  d[o + 2] = w;
  d[o + 3] = h;
  d[o + 4] = radius;
  d[o + 5] = stroke ? sw : 0;
  d[o + 14] = wobble?.x ?? 0;
  d[o + 15] = wobble?.y ?? 0;
  d[o + 6] = fill.r;
  d[o + 7] = fill.g;
  d[o + 8] = fill.b;
  d[o + 9] = fill.a;
  if (stroke) {
    d[o + 10] = stroke.r;
    d[o + 11] = stroke.g;
    d[o + 12] = stroke.b;
    d[o + 13] = stroke.a;
  } else {
    d[o + 10] = d[o + 11] = d[o + 12] = d[o + 13] = 0;
  }
}

/**
 * Visible label or picture indices split by canvas band: `back` (underMaps true), `maps` (unset) and `front`
 * (underMaps false), each in scene order. Buffers are kept between frames.
 */
class BandSplit {
  private data = new Uint32Array(256);
  back = this.data.subarray(0, 0);
  maps = this.data.subarray(0, 0);
  front = this.data.subarray(0, 0);

  split(items: ReadonlyArray<{ underMaps?: boolean }>, idx: Uint32Array): this {
    const n = idx.length;
    if (this.data.length < n * 3) this.data = new Uint32Array(Math.max(n * 3, this.data.length * 2));
    const d = this.data;
    let b = 0, m = n, f = 2 * n;
    for (let k = 0; k < n; k++) {
      const i = idx[k];
      const under = items[i].underMaps;
      if (under === true) d[b++] = i;
      else if (under === false) d[f++] = i;
      else d[m++] = i;
    }
    this.back = d.subarray(0, b);
    this.maps = d.subarray(n, m);
    this.front = d.subarray(2 * n, f);
    return this;
  }

  /** Fold the front band into the maps' pass (nothing of the front band's shapes is drawn this frame). */
  joinFront(): void {
    if (!this.front.length) return;
    const start = this.maps.byteOffset / 4, end = start + this.maps.length;
    this.data.copyWithin(end, this.front.byteOffset / 4, this.front.byteOffset / 4 + this.front.length);
    this.maps = this.data.subarray(start, end + this.front.length);
    this.front = this.data.subarray(0, 0);
  }
}

// ---------------------------------------------------------------------------------------- renderer

export class Renderer implements RenderDevice {
  readonly stats: RenderStats = {
    cpuMs: 0,
    drawCalls: 0,
    labelsDrawn: 0,
    labelsGreeked: 0,
    rectsDrawn: 0,
    imagesDrawn: 0,
    textures: 0,
    labelsPending: 0,
    imagesLoading: 0,
    gpuImageMB: 0,
    meshTriangles: 0,
    canvasTriangles: 0,
    visibleSetMs: 0,
    refreshIntervalMs: 1000 / 60,
    frames: 0
  };

  private gl!: WebGL2RenderingContext;
  private opts: Required<Pick<RendererOptions, 'labelBudgetMs' | 'greekPx' | 'cullMarginPx'>> & RendererOptions;
  private ro: ResizeObserver | null = null;
  private raf = 0;
  private destroyed = false;
  private lost = false;

  private scene: Scene | null = null;
  private cam: CameraState = { cx: 0, cy: 0, zoom: 1 };
  private viewW = 1;
  private viewH = 1;
  private dpr = 1;
  private frame = 0;

  // scene-derived
  private sceneDirty = true;
  private meshDirty = true;
  private overlayMeshDirty = true;
  private animatedMeshDirty = true;
  private canvasBackDirty = true;
  private canvasFrontDirty = true;
  private viewport = new SceneViewport();
  private labelEntries: (LabelEntry | undefined)[] = [];
  /** The scene has canvas-element text or pictures (`underMaps` set), drawn in passes of their own. */
  private layeredLabels = false;
  /** Largest label font size in the scene, and whether any label can be drawn as an overview title. */
  private labelMaxFont = 0;
  private labelOverviews = false;
  /** Zoom of the last frame that drew labels, and the direction it changed in this frame (-1, 0, 1). */
  private labelZoom = 0;
  private labelZoomFrame = -1;
  private labelZoomDir = 0;
  private layeredImages = false;
  private labelLayers = new BandSplit();
  private imageLayers = new BandSplit();

  // GL objects
  private progGrid!: WebGLProgram;
  private uGrid!: { origin: WebGLUniformLocation | null; pixels: WebGLUniformLocation | null;
    radius: WebGLUniformLocation | null; color: WebGLUniformLocation | null };
  private progSurface!: WebGLProgram;
  private uSurface!: Record<'res' | 'top' | 'bottom' | 'vignette' | 'dot' | 'origin' | 'pixels' | 'spacing' | 'radius',
    WebGLUniformLocation | null>;
  private progMesh!: WebGLProgram;
  private progRect!: WebGLProgram;
  private progShadow!: WebGLProgram;
  private uShadow!: PlaceUniforms;
  private progTex!: WebGLProgram;
  private progBlur!: WebGLProgram;
  private uBlur!: { view: WebGLUniformLocation | null; zoom: WebGLUniformLocation | null };
  private blurCorners = new WeakMap<ImageDraw, { hash: string; corners?: number[] }>();
  private uMesh!: { view: WebGLUniformLocation | null; zoom: WebGLUniformLocation | null;
    off: WebGLUniformLocation | null; offLow: WebGLUniformLocation | null };
  /** Dimensional branches: compiled on the first dimensional mesh, so flat maps never build them. */
  private relief: {
    /** Lit programs by material: clay and arcs share one; rope and quilling have their own. */
    lit: Record<MeshRelief['material'], { program: WebGLProgram; u: MeshUniforms }>;
    shade: WebGLProgram; uShade: MeshUniforms;
    composite: WebGLProgram; uComposite: Record<'tex' | 'res' | 'color', WebGLUniformLocation | null>;
  } | null = null;
  /** Raised rectangles (Scene.raisedRects), compiled on first use. */
  private raised: { program: WebGLProgram; u: PlaceUniforms } | null = null;
  /** GPU-expanded branches: flat, lit ('clay', 'rope') and shadow-layer programs, each compiled on first use. */
  private instanced = new Map<string, { program: WebGLProgram;
    u: Record<'view' | 'zoom' | 'off' | 'offLow' | 'coarse' | 'stride' | 'mat' | 'coded', WebGLUniformLocation | null> }>();
  /**
   * 4x multisampled colour target for frames at rest, resolved to the canvas at the end of the frame (what
   * `antialias: true` did implicitly). Frames while the camera keeps moving also use it, unless the mesh in view is very
   * large (MOVING_PLAIN_TRIANGLES): those draw straight to the canvas and the full-quality frame follows when it stops.
   */
  private msaa: { fbo: WebGLFramebuffer; rb: WebGLRenderbuffer; w: number; h: number; samples: number } | null = null;
  /** Framebuffer the frame draws to (the multisampled one, or null for the canvas). */
  private target: WebGLFramebuffer | null = null;
  /** The camera changed within MOVING_MS of its previous change: draw without multisampling. */
  private moving = false;
  private lastCameraAt = -Infinity;
  /** Timer for the full-quality frame once the camera has been still for MOVING_MS. */
  private settleTimer = 0;
  /** Low-resolution single-channel shadow layer (created on first use). */
  private shadowLayer: { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;
  private uRect!: PlaceUniforms;
  /** The scene's rectangles and shadows on the GPU (built on the first whole-map frame after a scene change). */
  private resident: Resident | null = null;
  private uTex!: {
    view: WebGLUniformLocation | null;
    zoom: WebGLUniformLocation | null;
    tex: WebGLUniformLocation | null;
    alpha: WebGLUniformLocation | null;
    clampUV: WebGLUniformLocation | null;
  };
  private mesh: MeshGPU | null = null;
  private overlayMesh: MeshGPU | null = null;
  private animatedMesh: MeshGPU | null = null;
  private canvasBack: MeshGPU | null = null;
  private canvasFront: MeshGPU | null = null;
  private rectBuf!: WebGLBuffer;
  private shadowBuf!: WebGLBuffer;
  private shadowVao!: WebGLVertexArrayObject;
  private barBuf!: WebGLBuffer;
  private rectVao!: WebGLVertexArrayObject;
  private barVao!: WebGLVertexArrayObject;
  private texBuf!: WebGLBuffer;
  private texVao!: WebGLVertexArrayObject;
  private imgVao!: WebGLVertexArrayObject;
  private atlas!: LabelAtlas;
  private images!: ImageCache;
  /** Draws culled branch runs in one call; without it each run is its own drawElements. */
  private multiDraw: WEBGL_multi_draw | null = null;

  // per-frame scratch
  private rects = new InstanceBuf(RECT_STRIDE);
  private shadows = new InstanceBuf(RECT_STRIDE);
  /** Rectangles flagged `overBranches`, drawn in a second rectangle call after the branch mesh. */
  private rectsOver = new InstanceBuf(RECT_STRIDE);
  private bars = new InstanceBuf(RECT_STRIDE);
  private overviewChips = new InstanceBuf(RECT_STRIDE);
  private overviewGrid = new Uint8Array();
  private overviewColumns = 0;
  private overviewRows = 0;
  private texInst = new InstanceBuf(TEX_STRIDE);
  private texPageCounts: number[] = [];
  private drawIdx: number[] = [];
  private drawBucket: number[] = [];
  private drawScale: number[] = [];
  private imgList: ImageBatch[] = [];
  private groupedImages = new InstanceBuf(TEX_STRIDE);
  private imageOrder: number[] = [];
  private drawCalls = 0;
  private previousFrameStamp: number | undefined;
  private refreshSamples: number[] = [];

  constructor(
    readonly canvas: HTMLCanvasElement,
    opts: RendererOptions = {}
  ) {
    this.opts = { labelBudgetMs: 4, greekPx: 4, cullMarginPx: 48, ...opts };
    this.initGL();
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    }
    this.resize();
  }

  // ------------------------------------------------------------------ public API

  setScene(scene: Scene): void {
    if (scene === this.scene) return;
    if (scene.branches !== this.scene?.branches) this.meshDirty = true;
    if (scene.animatedBranches !== this.scene?.animatedBranches) this.animatedMeshDirty = true;
    if (scene.overlayMesh !== this.scene?.overlayMesh) this.overlayMeshDirty = true;
    if (scene.canvasBack !== this.scene?.canvasBack) this.canvasBackDirty = true;
    if (scene.canvasFront !== this.scene?.canvasFront) this.canvasFrontDirty = true;
    // Selection and hover replace only the overlay. Keep the cached spatial indexes
    // and atlas entries when the indexed scene arrays are shared with the prior frame.
    if (scene.rects !== this.scene?.rects || scene.labels !== this.scene.labels || scene.images !== this.scene.images) {
      this.sceneDirty = true;
    }
    this.scene = scene;
    this.requestFrame();
  }

  invalidateImageSource(url: string): void {
    this.images.invalidateSource(url);
    this.requestFrame();
  }

  setCamera(cam: CameraState): void {
    if (cam.cx === this.cam.cx && cam.cy === this.cam.cy && cam.zoom === this.cam.zoom) return;
    const now = performance.now();
    // A single jump keeps full quality; a camera that keeps moving draws its frames without multisampling.
    if (now - this.lastCameraAt < MOVING_MS) this.moving = true;
    this.lastCameraAt = now;
    this.cam.cx = cam.cx;
    this.cam.cy = cam.cy;
    this.cam.zoom = cam.zoom;
    this.requestFrame();
  }

  /** No frame is requested and the last frame left no label or picture work outstanding (read by benchmarks). */
  get idle(): boolean {
    return !this.raf && !this.settleTimer && this.stats.labelsPending === 0 && this.stats.imagesLoading === 0;
  }

  /** Schedule one render on the next animation frame (coalesced). */
  requestFrame(): void {
    if (this.destroyed || this.raf) return;
    this.raf = requestAnimationFrame((stamp) => {
      this.raf = 0;
      this.observeRefresh(stamp);
      this.render();
    });
  }

  private observeRefresh(stamp: number): void {
    const interval = stamp - (this.previousFrameStamp ?? stamp);
    this.previousFrameStamp = stamp;
    // Long pauses between demand-driven frames are idle time, not the display cadence.
    if (interval < 4 || interval > 22) return;
    this.refreshSamples.push(interval);
    if (this.refreshSamples.length > 7) this.refreshSamples.shift();
    const sorted = this.refreshSamples.slice().sort((a, b) => a - b);
    this.stats.refreshIntervalMs = sorted[Math.floor(sorted.length / 2)];
  }

  /**
   * Device pixels drawn per CSS pixel. On a display of ordinary density this is 2, not 1: the frame is drawn at twice
   * the size and scaled down, so outlines get sixteen samples a pixel with the 4x target instead of four and thin
   * shapes are shaded more than once a pixel. A Retina display already has that density and is left as it is.
   */
  private bufferScale(): number {
    return Math.max(window.devicePixelRatio || 1, MIN_BUFFER_SCALE);
  }

  /** Match the drawing buffer to the canvas CSS size and the buffer scale. */
  resize(): void {
    const dpr = this.bufferScale();
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw === 0 || ch === 0) return;
    const pw = Math.max(1, Math.round(cw * dpr));
    const ph = Math.max(1, Math.round(ch * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.dpr = dpr;
    this.viewW = cw;
    this.viewH = ch;
    this.requestFrame();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    clearTimeout(this.settleTimer);
    this.settleTimer = 0;
    this.raf = 0;
    this.ro?.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (!this.lost) this.freeGL();
    this.scene = null;
  }

  // ------------------------------------------------------------------ GL setup

  private onLost = (e: Event) => {
    e.preventDefault();
    this.lost = true;
  };
  private onRestored = () => {
    this.lost = false;
    this.initGL();
    this.meshDirty = this.overlayMeshDirty = this.sceneDirty = true;
    this.canvasBackDirty = this.canvasFrontDirty = true;
    this.requestFrame();
  };

  private initGL(): void {
    const gl = this.canvas.getContext('webgl2', {
      alpha: false,
      // Multisampling is our own framebuffer (`ensureMsaa`), so frames while the camera moves can skip it.
      antialias: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.multiDraw = gl.getExtension('WEBGL_multi_draw');
    this.progGrid = compile(gl, GRID_VS, GRID_FS);
    this.uGrid = {
      origin: gl.getUniformLocation(this.progGrid, 'u_origin'), pixels: gl.getUniformLocation(this.progGrid, 'u_pixels'),
      radius: gl.getUniformLocation(this.progGrid, 'u_radius'), color: gl.getUniformLocation(this.progGrid, 'u_color')
    };
    this.progSurface = compile(gl, GRID_VS, SURFACE_FS);
    const surface = (name: string) => gl.getUniformLocation(this.progSurface, name);
    this.uSurface = {
      res: surface('u_res'), top: surface('u_top'), bottom: surface('u_bottom'), vignette: surface('u_vignette'),
      dot: surface('u_dot'), origin: surface('u_origin'), pixels: surface('u_pixels'), spacing: surface('u_spacing'),
      radius: surface('u_radius')
    };
    this.progMesh = compile(gl, MESH_VS, MESH_FS);
    this.progRect = compile(gl, RECT_VS, RECT_FS);
    this.progShadow = compile(gl, SHADOW_VS, SHADOW_FS);
    this.uShadow = placeUniforms(gl, this.progShadow);
    this.progBlur = compile(gl, COARSE_BLUR_VS, MESH_FS);
    this.uBlur = {
      view: gl.getUniformLocation(this.progBlur, 'u_view'),
      zoom: gl.getUniformLocation(this.progBlur, 'u_zoom')
    };
    this.progTex = compile(gl, TEX_VS, TEX_FS);
    this.uMesh = {
      view: gl.getUniformLocation(this.progMesh, 'u_view'),
      zoom: gl.getUniformLocation(this.progMesh, 'u_zoom'),
      off: gl.getUniformLocation(this.progMesh, 'u_off'),
      offLow: gl.getUniformLocation(this.progMesh, 'u_off_low')
    };
    this.uRect = placeUniforms(gl, this.progRect);
    this.uTex = {
      view: gl.getUniformLocation(this.progTex, 'u_view'),
      zoom: gl.getUniformLocation(this.progTex, 'u_zoom'),
      tex: gl.getUniformLocation(this.progTex, 'u_tex'),
      alpha: gl.getUniformLocation(this.progTex, 'u_alpha'),
      clampUV: gl.getUniformLocation(this.progTex, 'u_clampUV')
    };

    this.rectBuf = gl.createBuffer()!;
    this.barBuf = gl.createBuffer()!;
    this.rectVao = this.makeRectVao(this.rectBuf);
    this.barVao = this.makeRectVao(this.barBuf);
    this.shadowBuf = gl.createBuffer()!;
    this.shadowVao = this.makeRectVao(this.shadowBuf);
    this.texBuf = gl.createBuffer()!;
    this.texVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.texVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuf);
    for (let loc = 0; loc < 2; loc++) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, TEX_STRIDE * 4, loc * 16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, TEX_STRIDE * 4, 32);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, TEX_STRIDE * 4, 36);
    gl.vertexAttribDivisor(3, 1);
    this.imgVao = gl.createVertexArray()!;

    gl.bindVertexArray(null);
    // RECT_VS a_low: 0 wherever a rect VAO has no array for it (per-frame instances are camera-relative already).
    gl.vertexAttrib2f(5, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);

    this.atlas?.dispose();
    this.images?.dispose();
    this.atlas = new LabelAtlas(gl, { maxPages: this.opts.atlasPages ?? 8 });
    this.images = new ImageCache(gl, () => this.requestFrame(), {
      budgetBytes: this.opts.imageBudgetBytes,
      ...this.opts.images
    });
    this.labelEntries = [];
    this.mesh = null;
    this.overlayMesh = null;
    this.animatedMesh = null;
    this.animatedMeshDirty = true;
    this.canvasBack = this.canvasFront = null;
    this.canvasBackDirty = this.canvasFrontDirty = true;
    this.relief = null;
    this.shadowLayer = null;
    this.raised = null;
    this.instanced = new Map();
    this.resident = null;
    this.msaa = null;
  }

  /** The multisampled colour target at the canvas size (created or resized on demand). */
  private ensureMsaa(): NonNullable<Renderer['msaa']> {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    let m = this.msaa;
    if (m && m.w === w && m.h === h) return m;
    if (!m) {
      const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number);
      m = this.msaa = { fbo: gl.createFramebuffer()!, rb: gl.createRenderbuffer()!, w, h, samples };
    }
    m.w = w;
    m.h = h;
    gl.bindRenderbuffer(gl.RENDERBUFFER, m.rb);
    // RGB8 like the canvas (alpha: false): a multisampled blit needs identical formats.
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, m.samples, gl.RGB8, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.fbo);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, m.rb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
    return m;
  }

  private ensureRelief(): NonNullable<Renderer['relief']> {
    if (this.relief) return this.relief;
    const gl = this.gl;
    const at = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);
    const uniforms = (p: WebGLProgram): MeshUniforms => ({ view: at(p, 'u_view'), zoom: at(p, 'u_zoom'), off: at(p, 'u_off'),
      offLow: at(p, 'u_off_low'), mat: at(p, 'u_mat'), coded: at(p, 'u_coded'), far: at(p, 'u_far') });
    const make = (vs: string, fs: string) => {
      const program = compile(gl, vs, fs);
      return { program, u: uniforms(program) };
    };
    const ribbon = make(RELIEF_VS, RELIEF_FS);
    const shade = compile(gl, RELIEF_SHADOW_VS, RELIEF_SHADOW_FS);
    const composite = compile(gl, GRID_VS, RELIEF_COMPOSITE_FS);
    return this.relief = {
      lit: { clay: ribbon, arcs: ribbon, rope: make(ROPE_VS, ROPE_FS), quilling: make(RELIEF_VS, QUILL_FS) },
      shade, composite, uShade: uniforms(shade),
      uComposite: { tex: at(composite, 'u_tex'), res: at(composite, 'u_res'), color: at(composite, 'u_color') }
    };
  }

  /** Half-resolution R8 target for branch shadows, resized with the canvas. */
  private ensureShadowLayer(): NonNullable<Renderer['shadowLayer']> {
    const gl = this.gl;
    const w = Math.max(1, Math.ceil(this.canvas.width / 2)), h = Math.max(1, Math.ceil(this.canvas.height / 2));
    let layer = this.shadowLayer;
    if (layer && layer.w === w && layer.h === h) return layer;
    if (!layer) {
      layer = { fbo: gl.createFramebuffer()!, tex: gl.createTexture()!, w, h };
      this.shadowLayer = layer;
    }
    layer.w = w;
    layer.h = h;
    gl.bindTexture(gl.TEXTURE_2D, layer.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, layer.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return layer;
  }

  private makeRectVao(buf: WebGLBuffer, stride = RECT_STRIDE): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const S = stride * 4;
    const layout: [number, number, number][] = [
      [0, 4, 0],
      [1, 2, 16],
      [2, 4, 24],
      [3, 4, 40],
      [4, 2, 56]
    ];
    if (stride === RESIDENT_STRIDE) layout.push([5, 2, 64]);
    for (const [loc, size, off] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  private freeGL(): void {
    const gl = this.gl;
    this.atlas.dispose();
    this.images.dispose();
    for (const m of [this.mesh, this.overlayMesh, this.animatedMesh, this.canvasBack, this.canvasFront]) this.freeMesh(m);
    gl.deleteBuffer(this.rectBuf);
    gl.deleteBuffer(this.barBuf);
    gl.deleteBuffer(this.shadowBuf);
    gl.deleteBuffer(this.texBuf);
    gl.deleteVertexArray(this.rectVao);
    gl.deleteVertexArray(this.barVao);
    gl.deleteVertexArray(this.shadowVao);
    gl.deleteVertexArray(this.texVao);
    gl.deleteVertexArray(this.imgVao);
    this.freeResident();
    gl.deleteProgram(this.progMesh);
    gl.deleteProgram(this.progGrid);
    gl.deleteProgram(this.progRect);
    gl.deleteProgram(this.progShadow);
    gl.deleteProgram(this.progSurface);
    gl.deleteProgram(this.progTex);
    gl.deleteProgram(this.progBlur);
    if (this.raised) {
      gl.deleteProgram(this.raised.program);
      this.raised = null;
    }
    if (this.relief) {
      for (const p of new Set(Object.values(this.relief.lit).map((l) => l.program))) gl.deleteProgram(p);
      gl.deleteProgram(this.relief.shade);
      gl.deleteProgram(this.relief.composite);
      this.relief = null;
    }
    if (this.msaa) {
      gl.deleteFramebuffer(this.msaa.fbo);
      gl.deleteRenderbuffer(this.msaa.rb);
      this.msaa = null;
    }
    if (this.shadowLayer) {
      gl.deleteFramebuffer(this.shadowLayer.fbo);
      gl.deleteTexture(this.shadowLayer.tex);
      this.shadowLayer = null;
    }
    this.mesh = this.overlayMesh = this.animatedMesh = this.canvasBack = this.canvasFront = null;
  }

  private freeResident(): void {
    const r = this.resident;
    if (!r) return;
    for (const list of [r.shadows, r.rects, r.over]) {
      this.gl.deleteBuffer(list.buf);
      this.gl.deleteVertexArray(list.vao);
    }
    this.resident = null;
  }

  /** Upload every rectangle and shadow of the scene once, in scene order, relative to the centre of their extent. */
  private buildResident(scene: Scene): Resident {
    this.freeResident();
    const R = scene.rects;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of R) {
      if (r.x < x0) x0 = r.x;
      if (r.x > x1) x1 = r.x;
      if (r.y < y0) y0 = r.y;
      if (r.y > y1) y1 = r.y;
    }
    const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2;
    const shadows = new InstanceBuf(RESIDENT_STRIDE, R.length), rects = new InstanceBuf(RESIDENT_STRIDE, R.length);
    const over = new InstanceBuf(RESIDENT_STRIDE, 16);
    const sizes = new Float32Array(R.length);
    const low = (b: InstanceBuf, x: number, y: number) => {
      const o = (b.n - 1) * RESIDENT_STRIDE;
      b.data[o + 16] = x - Math.fround(x);
      b.data[o + 17] = y - Math.fround(y);
    };
    for (let i = 0; i < R.length; i++) {
      const r = R[i];
      const x = r.x - ox, y = r.y - oy;
      sizes[i] = Math.max(Math.fround(r.w), Math.fround(r.h));
      const sh = r.shadow;
      if (sh && sh.color.a > 0) {
        writeShadow(shadows, x, r.y + sh.dy - oy, r.w, r.h, r.radius, sh.blur, sh.color);
        low(shadows, x, r.y + sh.dy - oy);
      }
      const target = r.overBranches ? over : rects;
      writeRect(target, x, y, r.w, r.h, r.radius, r.strokeWidth ?? 0, r.fill, r.stroke, r.wobble);
      low(target, x, y);
    }
    sizes.sort();
    const gl = this.gl;
    const list = (b: InstanceBuf): ResidentList => {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, b.data, gl.STATIC_DRAW, 0, b.n * RESIDENT_STRIDE);
      return { buf, vao: this.makeRectVao(buf, RESIDENT_STRIDE), n: b.n };
    };
    return this.resident = { ox, oy, shadows: list(shadows), rects: list(rects), over: list(over), sizes };
  }

  /** Rectangles of the resident set RECT_VS draws at this zoom (those with a side of at least a quarter pixel). */
  private residentDrawn(sizes: Float32Array, zoom: number): number {
    const min = Math.fround(0.25 / zoom);
    let lo = 0, hi = sizes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sizes[mid] < min) lo = mid + 1;
      else hi = mid;
    }
    return sizes.length - lo;
  }

  /** Build the coarse indices of the static branch mesh a slice at a time in timer tasks, then upload them once. */
  private buildCoarse(mesh: MeshGPU): void {
    const spans = mesh.src.branchSpans!;
    const c = mesh.coarse ??= { ibo: null, count: 0, ends: new Uint32Array(spans.ends.length),
      build: new Uint32Array(mesh.count), span: 0, timer: 0 };
    const step = () => {
      c.timer = 0;
      if (this.mesh !== mesh || this.lost || this.destroyed || !c.build) return;
      const deadline = performance.now() + LOD_SLICE_MS;
      const ind = mesh.src.indices, ends = spans.ends;
      while (c.span < ends.length) {
        c.count = coarsenSpan(ind, c.span ? ends[c.span - 1] : 0, ends[c.span], c.build, c.count);
        c.ends[c.span++] = c.count;
        if ((c.span & 127) === 0 && performance.now() > deadline) {
          c.timer = setTimeout(step, 0) as unknown as number;
          return;
        }
      }
      const gl = this.gl;
      c.ibo = gl.createBuffer()!;
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, c.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, c.build.subarray(0, c.count), gl.STATIC_DRAW);
      c.build = null;
    };
    c.timer = setTimeout(step, 0) as unknown as number;
  }

  private freeMesh(m: MeshGPU | null): void {
    if (!m) return;
    if (m.inst) {
      this.gl.deleteTexture(m.inst.tex);
      this.gl.deleteBuffer(m.inst.coarse.buf);
    }
    this.gl.deleteBuffer(m.vbo);
    this.gl.deleteBuffer(m.ibo);
    if (m.coarse) {
      clearTimeout(m.coarse.timer);
      if (m.coarse.ibo) this.gl.deleteBuffer(m.coarse.ibo);
      m.coarse = undefined;
    }
    this.gl.deleteVertexArray(m.vao);
  }

  // ------------------------------------------------------------------ scene upload

  /**
   * Interleaved vertex = float32 x, float32 y (relative to the mesh origin), 4 x unorm8 premultiplied colour.
   * Positions are re-based on the mesh centre in double precision, so geometry far from the world origin
   * keeps full float32 precision; the shader adds (origin - camera) computed in doubles per frame.
   */
  private uploadMesh(old: MeshGPU | null, mesh: Mesh | undefined): MeshGPU | null {
    this.freeMesh(old);
    if (mesh?.instances) return mesh.instances.count ? this.uploadInstances(old, mesh) : null;
    if (!mesh || mesh.indices.length === 0) return null;
    if (mesh.relief) return this.uploadRelief(old, mesh);
    const gl = this.gl;
    const { buffer, ox, oy, wide } = mesh.gpuVertices ?? packMeshVertices(mesh);
    const stride = wide ? 20 : 12;
    branchIndex(mesh, old?.src);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, stride, 8);
    if (wide) {
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 12);
    }
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, vbo, ibo, count: mesh.indices.length, ox, oy, wide, src: mesh, runs: 0, lod: false,
      opaque: opaqueVertices(buffer, stride) };
  }

  /**
   * A dimensional mesh (see mesh-vertices.ts RELIEF_STRIDE): one vertex buffer, one index buffer and one VAO, read by
   * the lit program (the flat MESH_VS can draw it too) and by the shadow layer's program (location 4, shadow offset).
   */
  private uploadRelief(old: MeshGPU | null, mesh: Mesh): MeshGPU {
    const gl = this.gl;
    this.ensureRelief();
    const nv = mesh.positions.length >> 1;
    const rope = !!mesh.relief!.twist;
    const given = mesh.gpuVertices;
    // A mesh from the layout worker carries only its packed buffer (no CPU positions; see ui/layout-transport shipMesh).
    const packed = given && (!nv || given.buffer.byteLength === nv * reliefStride(rope, given.wide)) ? given : packVertices(mesh);
    const { buffer, ox, oy, wide } = packed;
    const stride = reliefStride(rope, wide);
    branchIndex(mesh, old?.src);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, stride, 8);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.BYTE, true, stride, 12);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 2, gl.SHORT, false, stride, 16);
    if (rope) {
      gl.enableVertexAttribArray(5);
      gl.vertexAttribPointer(5, 1, gl.FLOAT, false, stride, 20);
    }
    if (wide) {
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, stride - 8);
    }
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, vbo, ibo, count: mesh.indices.length, ox, oy, wide, src: mesh, relief: mesh.relief, runs: 0, lod: false,
      opaque: mesh.relief!.material !== 'quilling' && opaqueVertices(buffer, stride) };
  }

  /**
   * GPU-expanded branches (core/geometry/branch-instances.ts): the records go to an RGBA32UI texture (8 texels a
   * record, 2048 a row), and each branch's strip becomes chunk instances drawn over one INSTANCE_QUADS template.
   */
  private uploadInstances(old: MeshGPU | null, mesh: Mesh): MeshGPU {
    const gl = this.gl;
    const { records, count, words } = mesh.instances!;
    if (mesh.relief) this.ensureRelief();
    branchIndex(mesh, old?.src);
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + RECORD_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Premultiplication applies to array uploads too; these are not colours.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, RECORD_ROW_TEXELS, records.length / 4 / RECORD_ROW_TEXELS, 0, gl.RGBA_INTEGER,
      gl.UNSIGNED_INT, records);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    const full = this.chunkList(records, count, words, false), coarse = this.chunkList(records, count, words, true);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const template = new Uint16Array(CHUNK_INDICES);
    for (let q = 0, i = 0; q < INSTANCE_QUADS; q++) {
      const v = 2 * q;
      template.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], i);
      i += 6;
    }
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, template, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, full.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
    let opaque = true;
    for (let b = 0, o = 12; b < count && opaque; b++, o += words) {
      opaque = records[o] >>> 24 === 255 && records[o + 1] >>> 24 === 255;
    }
    return { vao, vbo: full.buf, ibo, count: full.total, ox: 0, oy: 0, wide: false, src: mesh, relief: mesh.relief, runs: 0,
      lod: false, opaque, inst: { tex, full, coarse, stride: words / 4 } };
  }

  private chunkList(records: Uint32Array, count: number, words: number, coarse: boolean): ChunkList {
    const ends = new Uint32Array(count);
    let total = 0;
    for (let b = 0; b < count; b++) ends[b] = total += stripChunks(records, b, words, coarse);
    const chunks = new Uint32Array(total);
    for (let b = 0, at = 0; b < count; b++) for (let c = 0; at < ends[b]; c++) chunks[at++] = (b << 8 | c) >>> 0;
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, chunks, gl.STATIC_DRAW);
    return { buf, ends, total };
  }

  /** Visible chunk runs of GPU-expanded branches (as visibleMesh for indices); returns the indices that will be drawn. */
  private visibleChunks(mesh: MeshGPU, bounds: FrameBounds, lod: boolean): number {
    mesh.runs = 0;
    mesh.lod = lod;
    const list = lod ? mesh.inst!.coarse : mesh.inst!.full;
    const ends = list.ends;
    const visible = visibleBranchSpans(mesh.src, bounds)!;
    if (visible.length === ends.length) return list.total * CHUNK_INDICES;
    if (!visible.length) return 0;
    let counts = mesh.runCounts, offsets = mesh.runOffsets;
    let runs = 0, written = 0;
    for (let at = 0; at < visible.length;) {
      const first = visible[at++];
      let last = first;
      while (at < visible.length && visible[at] === last + 1) last = visible[at++];
      const start = first === 0 ? 0 : ends[first - 1];
      const end = ends[last];
      written += end - start;
      if (runs > 0 && start - (offsets![runs - 1] + counts![runs - 1]) < CHUNK_RUN_GAP) {
        counts![runs - 1] = end - offsets![runs - 1];
        continue;
      }
      if (!counts || runs === counts.length) {
        const grown = new Int32Array(Math.max(64, runs * 2)), grownOff = new Int32Array(grown.length);
        if (counts) {
          grown.set(counts);
          grownOff.set(offsets!);
        }
        counts = mesh.runCounts = grown;
        offsets = mesh.runOffsets = grownOff;
      }
      offsets![runs] = start;
      counts[runs] = end - start;
      runs++;
    }
    mesh.runs = runs;
    return written * CHUNK_INDICES;
  }

  /** The instanced program of one look, compiled on first use. */
  private chunkProgram(look: 'flat' | 'clay' | 'rope' | 'shadow') {
    let p = this.instanced.get(look);
    if (!p) {
      const gl = this.gl;
      const program = look === 'flat' ? compile(gl, BRANCH_INSTANCE_VS, MESH_FS) : look === 'shadow'
        ? compile(gl, BRANCH_SHADOW_VS, RELIEF_SHADOW_FS) : look === 'rope' ? compile(gl, BRANCH_ROPE_VS, ROPE_FS)
          : compile(gl, BRANCH_RELIEF_VS, RELIEF_FS);
      const at = (name: string) => gl.getUniformLocation(program, name);
      gl.useProgram(program);
      gl.uniform1i(at('u_rec'), RECORD_UNIT);
      p = { program, u: { view: at('u_view'), zoom: at('u_zoom'), off: at('u_off'), offLow: at('u_off_low'), coarse: at('u_coarse'),
        stride: at('u_stride'), mat: at('u_mat'), coded: at('u_coded') } };
      this.instanced.set(look, p);
    }
    return p;
  }

  /** Draw the visible chunks of GPU-expanded branches: flat, lit by their material, or into the shadow layer. */
  private drawChunks(mesh: MeshGPU, cx: number, cy: number, zoom: number, look: 'flat' | 'clay' | 'rope' | 'shadow' = 'flat'): void {
    const gl = this.gl;
    const p = this.chunkProgram(look);
    const inst = mesh.inst!;
    gl.useProgram(p.program);
    this.meshUniforms(p.u, mesh, cx, cy, zoom);
    gl.uniform1i(p.u.coarse, mesh.lod ? 1 : 0);
    gl.uniform1i(p.u.stride, inst.stride);
    if (look === 'clay' || look === 'rope') {
      const m = RELIEF_MATERIALS[mesh.relief!.material];
      gl.uniform4f(p.u.mat, m[0], m[1], m[2], m[3]);
    }
    if (look === 'shadow') gl.uniform1f(p.u.coded, mesh.relief!.material === 'rope' ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0 + RECORD_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, inst.tex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(mesh.vao);
    const list = mesh.lod ? inst.coarse : inst.full;
    gl.bindBuffer(gl.ARRAY_BUFFER, list.buf);
    const opaque = mesh.opaque && look !== 'shadow';
    if (opaque) gl.disable(gl.BLEND);
    if (!mesh.runs) {
      gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, 0);
      gl.drawElementsInstanced(gl.TRIANGLES, CHUNK_INDICES, gl.UNSIGNED_SHORT, 0, list.total);
      this.drawCalls++;
    } else {
      // No base instance in WebGL 2: each run points the instance attribute at its first chunk.
      const counts = mesh.runCounts!, offsets = mesh.runOffsets!;
      for (let r = 0; r < mesh.runs; r++) {
        gl.vertexAttribIPointer(0, 1, gl.UNSIGNED_INT, 4, offsets[r] * 4);
        gl.drawElementsInstanced(gl.TRIANGLES, CHUNK_INDICES, gl.UNSIGNED_SHORT, 0, counts[r]);
      }
      this.drawCalls += mesh.runs;
    }
    if (opaque) gl.enable(gl.BLEND);
  }

  // ------------------------------------------------------------------ frame

  /** Render synchronously now (cancels a pending requestFrame). Prefer requestFrame(). */
  render(): void {
    if (this.destroyed || this.lost || !this.scene) return;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    const t0 = performance.now();
    const gl = this.gl;
    const scene = this.scene;
    if (this.bufferScale() !== this.dpr) this.resize();
    this.frame++;
    this.drawCalls = 0;
    const st = this.stats;
    st.labelsDrawn = st.labelsGreeked = st.labelsPending = st.rectsDrawn = st.imagesDrawn = 0;

    if (this.meshDirty) {
      this.mesh = this.uploadMesh(this.mesh, scene.branches);
      this.meshDirty = false;
    }
    if (this.animatedMeshDirty) {
      this.animatedMesh = this.uploadMesh(this.animatedMesh, scene.animatedBranches);
      this.animatedMeshDirty = false;
    }
    if (this.overlayMeshDirty) {
      this.overlayMesh = this.uploadMesh(this.overlayMesh, scene.overlayMesh);
      this.overlayMeshDirty = false;
    }
    if (this.canvasBackDirty) {
      this.canvasBack = this.uploadMesh(this.canvasBack, scene.canvasBack);
      this.canvasBackDirty = false;
    }
    if (this.canvasFrontDirty) {
      this.canvasFront = this.uploadMesh(this.canvasFront, scene.canvasFront);
      this.canvasFrontDirty = false;
    }
    if (this.sceneDirty) {
      this.viewport.update(scene);
      this.labelEntries = new Array(scene.labels.length);
      this.layeredLabels = scene.labels.some((l) => l.underMaps !== undefined);
      let maxFont = 0, overviews = false;
      for (const l of scene.labels) {
        if (l.fontSize > maxFont) maxFont = l.fontSize;
        if (l.overviewTitle || l.pictureTitle) overviews = true;
      }
      this.labelMaxFont = maxFont;
      this.labelOverviews = overviews;
      this.layeredImages = scene.images.some((im) => im.underMaps !== undefined);
      this.freeResident();
      this.sceneDirty = false;
    }

    const { cx, cy, zoom } = this.cam;
    const halfW = this.viewW / 2 / zoom, halfH = this.viewH / 2 / zoom;
    const visibilityStart = performance.now();
    const { bounds, rects, images, labels } = this.viewport.query(this.cam, this.viewW, this.viewH, this.opts.cullMarginPx);
    const far = zoom < LOD_ZOOM;
    if (far && this.mesh?.src.branchSpans && !this.mesh.coarse && !this.mesh.inst) this.buildCoarse(this.mesh);
    const branches = this.visibleMesh(this.mesh, bounds, far);
    const animated = this.visibleMesh(this.animatedMesh, bounds);
    const canvasBack = this.visibleMesh(this.canvasBack, bounds);
    const canvasFront = this.visibleMesh(this.canvasFront, bounds);
    st.visibleSetMs = performance.now() - visibilityStart;

    // Into the multisampled target, resolved at the end of the frame; a heavy frame while the camera moves goes
    // straight to the canvas instead.
    const moving = this.moving && performance.now() - this.lastCameraAt < MOVING_MS;
    const plain = moving && this.stats.meshTriangles > MOVING_PLAIN_TRIANGLES;
    if (!moving) this.moving = false;
    this.target = plain ? null : this.ensureMsaa().fbo;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);

    // Dimensional branches: their shadows go to their own layer before anything is drawn on the canvas.
    const shadowAlpha = this.mesh?.relief || this.animatedMesh?.relief
      ? this.drawShadowLayer(cx, cy, zoom, branches, animated) : 0;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const bg = scene.background;
    gl.clearColor(bg.r, bg.g, bg.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (scene.surface) this.drawSurface(scene.surface, cx, cy, zoom, halfW, halfH);
    if (scene.grid && zoom >= 0.30) {
      gl.useProgram(this.progGrid);
      gl.bindVertexArray(this.imgVao);
      gl.uniform2f(this.uGrid.origin, (cx - halfW) % 32, (cy + halfH) % 32);
      gl.uniform1f(this.uGrid.pixels, zoom * this.dpr);
      gl.uniform1f(this.uGrid.radius, this.dpr * 0.9);
      gl.uniform4f(this.uGrid.color, scene.grid.r, scene.grid.g, scene.grid.b, scene.grid.a);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.drawCalls++;
    }
    this.atlas.beginFrame(this.frame);
    this.images.beginFrame(this.frame);
    let more = false;

    // Canvas-element text and pictures go with their band (underMaps true: back, false: front); the maps' own in
    // between. A scene without them keeps a single pass of each, as before.
    const labelLayers = this.layeredLabels ? this.labelLayers.split(scene.labels, labels) : null;
    const imageLayers = this.layeredImages ? this.imageLayers.split(scene.images, images) : null;
    if (!canvasFront && !this.overlayMesh?.count) {
      // Nothing is drawn between the maps' text and the front band's: one pass serves both.
      labelLayers?.joinFront();
      imageLayers?.joinFront();
    }

    // 0. canvas elements under the maps: shapes, then pictures and text (one extra pass each, only when present)
    this.drawMesh(this.canvasBack, cx, cy, zoom, canvasBack);
    if (imageLayers?.back.length) more = this.drawImages(scene.images, imageLayers.back, cx, cy, zoom, t0, false) || more;
    if (labelLayers?.back.length) more = this.drawLabels(scene.labels, labelLayers.back, cx, cy, zoom, t0) || more;

    if (shadowAlpha > 0) this.compositeShadowLayer(shadowAlpha);

    // 1. rects, with their shadows in one pass underneath (rects flagged overBranches wait until after the branches)
    this.rects.reset();
    this.shadows.reset();
    this.rectsOver.reset();
    let over: ResidentList | null = null;
    if (rects.length > 0 && rects.length === scene.rects.length) {
      // The whole map is in view: draw every rectangle from the GPU-resident lists (RECT_VS skips the tiny ones).
      const res = this.resident ?? this.buildResident(scene);
      st.rectsDrawn = this.residentDrawn(res.sizes, zoom);
      if (res.shadows.n) this.drawPlaced(this.progShadow, this.uShadow, res.shadows, zoom, res);
      if (res.rects.n) this.drawPlaced(...this.rectProgram(scene.raisedRects), res.rects, zoom, res);
      if (res.over.n) over = res.over;
    } else {
      const idx = rects;
      const R = scene.rects;
      const px = 0.25 / zoom;
      for (let k = 0; k < idx.length; k++) {
        const r = R[idx[k]];
        if (r.w < px && r.h < px) continue;
        const sh = r.shadow;
        if (sh && sh.color.a > 0) writeShadow(this.shadows, r.x - cx, r.y + sh.dy - cy, r.w, r.h, r.radius, sh.blur, sh.color);
        writeRect(r.overBranches ? this.rectsOver : this.rects, r.x - cx, r.y - cy, r.w, r.h, r.radius, r.strokeWidth ?? 0,
          r.fill, r.stroke, r.wobble);
      }
      st.rectsDrawn = this.rects.n + this.rectsOver.n;
      this.drawShadows(zoom);
      this.drawRects(this.rectVao, this.rectBuf, this.rects, zoom, scene.raisedRects);
    }

    // 2. branch mesh
    this.drawMesh(this.mesh, cx, cy, zoom, branches);
    this.drawMesh(this.animatedMesh, cx, cy, zoom, animated);
    // 2b. rects over the branches (a root covering fanned start caps); no call when none is flagged
    if (over) this.drawPlaced(...this.rectProgram(scene.raisedRects), over, zoom, this.resident!);
    else this.drawRects(this.rectVao, this.rectBuf, this.rectsOver, zoom, scene.raisedRects);

    // 3. images
    more = this.drawImages(scene.images, imageLayers?.maps ?? images, cx, cy, zoom, t0, true) || more;

    // 4. labels
    more = this.drawLabels(scene.labels, labelLayers?.maps ?? labels, cx, cy, zoom, t0) || more;

    // 5. canvas elements over the maps
    this.drawMesh(this.canvasFront, cx, cy, zoom, canvasFront);

    // 6. overlay mesh (node ink, elements a gesture is moving), then front-band pictures and text over both
    this.drawMesh(this.overlayMesh, cx, cy, zoom);
    if (imageLayers?.front.length) more = this.drawImages(scene.images, imageLayers.front, cx, cy, zoom, t0, true) || more;
    if (labelLayers?.front.length) more = this.drawLabels(scene.labels, labelLayers.front, cx, cy, zoom, t0) || more;
    if (scene.overlay.length > 0) {
      this.rects.reset();
      for (const item of scene.overlay) {
        const r = outlineAt(item, zoom);
        writeRect(this.rects, r.x - cx, r.y - cy, r.w, r.h, r.radius, r.strokeWidth ?? 0, r.fill, r.stroke, r.wobble);
      }
      this.drawRects(this.rectVao, this.rectBuf, this.rects, zoom);
    }

    if (this.target) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.target);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, this.canvas.width, this.canvas.height, 0, 0, this.canvas.width, this.canvas.height,
        gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      // The camera may stop here: draw the frame again with multisampling once it has been still for MOVING_MS.
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => {
        this.settleTimer = 0;
        this.moving = false;
        this.requestFrame();
      }, MOVING_MS) as unknown as number;
    }
    if (zoom < FAR_ART_ZOOM) this.images.evictFar();
    st.cpuMs = performance.now() - t0;
    st.drawCalls = this.drawCalls;
    st.textures = this.atlas.textureCount + this.images.textureCount;
    st.imagesLoading = this.images.loadingCount;
    st.gpuImageMB = this.images.gpuBytes / (1024 * 1024);
    st.meshTriangles = (branches + animated) / 3;
    st.canvasTriangles = (canvasBack + canvasFront) / 3;
    st.frames++;
    this.opts.onFrame?.(st);
    if (more) this.requestFrame();
  }

  /** The rectangle program (raised: the clay tablets' one, compiled on first use) and its uniforms. */
  private rectProgram(raised?: boolean): [WebGLProgram, PlaceUniforms] {
    if (!raised) return [this.progRect, this.uRect];
    const r = this.raised ??= (() => {
      const program = compile(this.gl, RECT_VS, RECT_RAISED_FS);
      return { program, u: placeUniforms(this.gl, program) };
    })();
    return [r.program, r.u];
  }

  /** View, zoom and placement uniforms: camera-relative instances (place null) or a resident list's origin. */
  private usePlaced(program: WebGLProgram, u: PlaceUniforms, zoom: number, place: Resident | null): void {
    const gl = this.gl;
    gl.useProgram(program);
    gl.uniform2f(u.view, this.viewW, this.viewH);
    gl.uniform1f(u.zoom, zoom);
    if (!place) {
      gl.uniform2f(u.off, 0, 0);
      gl.uniform2f(u.offLow, 0, 0);
      gl.uniform1f(u.min, 0);
      return;
    }
    const x = place.ox - this.cam.cx, y = place.oy - this.cam.cy;
    const highX = Math.fround(x), highY = Math.fround(y);
    gl.uniform2f(u.off, highX, highY);
    gl.uniform2f(u.offLow, x - highX, y - highY);
    gl.uniform1f(u.min, 0.25 / zoom);
  }

  private drawPlaced(program: WebGLProgram, u: PlaceUniforms, list: ResidentList, zoom: number, place: Resident): void {
    this.usePlaced(program, u, zoom, place);
    this.gl.bindVertexArray(list.vao);
    this.gl.drawArraysInstanced(this.gl.TRIANGLE_STRIP, 0, 4, list.n);
    this.drawCalls++;
  }

  private drawRects(vao: WebGLVertexArrayObject, buf: WebGLBuffer, ib: InstanceBuf, zoom: number, raised?: boolean): void {
    if (ib.n === 0) return;
    const gl = this.gl;
    this.usePlaced(...this.rectProgram(raised), zoom, null);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, ib.data, gl.STREAM_DRAW, 0, ib.n * ib.stride);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ib.n);
    this.drawCalls++;
  }

  /** Gradient, world dots and vignette in one full-screen pass. Skipped when nothing in it would show. */
  private drawSurface(surface: NonNullable<Scene['surface']>, cx: number, cy: number, zoom: number,
    halfW: number, halfH: number): void {
    const { gradient, dots } = surface;
    const vignette = Math.max(0, Math.min(1, surface.vignette ?? 0));
    const fade = dots && dots.spacing > 0
      ? Math.max(0, Math.min(1, (zoom - SURFACE_DOTS_GONE) / (SURFACE_DOTS_FULL - SURFACE_DOTS_GONE))) : 0;
    const dotAlpha = dots ? dots.color.a * fade : 0;
    if (!gradient && vignette <= 0 && dotAlpha <= 0) return;
    const gl = this.gl;
    const u = this.uSurface;
    gl.useProgram(this.progSurface);
    gl.bindVertexArray(this.imgVao);
    gl.uniform2f(u.res, this.canvas.width, this.canvas.height);
    const [top, bottom] = gradient ?? [undefined, undefined];
    gl.uniform4f(u.top, top?.r ?? 0, top?.g ?? 0, top?.b ?? 0, top?.a ?? 0);
    gl.uniform4f(u.bottom, bottom?.r ?? 0, bottom?.g ?? 0, bottom?.b ?? 0, bottom?.a ?? 0);
    gl.uniform1f(u.vignette, vignette);
    if (dots && dotAlpha > 0) {
      const s = dots.spacing, c = dots.color;
      gl.uniform4f(u.dot, c.r * fade, c.g * fade, c.b * fade, dotAlpha);
      gl.uniform2f(u.origin, (cx - halfW) % s, (cy + halfH) % s);
      gl.uniform1f(u.pixels, zoom * this.dpr);
      gl.uniform1f(u.spacing, s);
      // One world unit at zoom 1 (as the SVG pattern draws it), kept between 0.75 and 1.5 screen px.
      gl.uniform1f(u.radius, this.dpr * Math.max(0.75, Math.min(1.5, zoom)));
    } else {
      gl.uniform4f(u.dot, 0, 0, 0, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;
  }

  private drawShadows(zoom: number): void {
    const ib = this.shadows;
    if (ib.n === 0) return;
    const gl = this.gl;
    this.usePlaced(this.progShadow, this.uShadow, zoom, null);
    gl.bindVertexArray(this.shadowVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
    gl.bufferData(gl.ARRAY_BUFFER, ib.data, gl.STREAM_DRAW, 0, ib.n * ib.stride);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ib.n);
    this.drawCalls++;
  }

  /**
   * Find the runs of the static index buffer that hold intersecting branch spans, in the mesh's draw order. Returns the
   * number of indices drawn (the whole mesh when every span is visible).
   */
  private visibleMesh(mesh: MeshGPU | null, bounds: FrameBounds, lod = false): number {
    if (!mesh) return 0;
    if (mesh.inst) return this.visibleChunks(mesh, bounds, lod);
    mesh.runs = 0;
    const spans = mesh.src.branchSpans;
    mesh.lod = lod && !!mesh.coarse?.ibo;
    if (!spans) return mesh.count;
    const total = mesh.lod ? mesh.coarse!.count : mesh.count;
    const visible = visibleBranchSpans(mesh.src, bounds)!;
    if (visible.length === spans.ids.length) return total;
    if (!visible.length) return 0;
    const ends = mesh.lod ? mesh.coarse!.ends : spans.ends;
    let counts = mesh.runCounts, offsets = mesh.runOffsets;
    let runs = 0, written = 0;
    for (let at = 0; at < visible.length;) {
      const first = visible[at++];
      let last = first;
      while (at < visible.length && visible[at] === last + 1) last = visible[at++];
      const start = first === 0 ? 0 : ends[first - 1];
      const end = ends[last];
      written += end - start;
      if (runs > 0 && start - (offsets![runs - 1] / 4 + counts![runs - 1]) < RUN_GAP) {
        counts![runs - 1] = end - offsets![runs - 1] / 4;
        continue;
      }
      if (!counts || runs === counts.length) {
        const grown = new Int32Array(Math.max(64, runs * 2)), grownOff = new Int32Array(grown.length);
        if (counts) {
          grown.set(counts);
          grownOff.set(offsets!);
        }
        counts = mesh.runCounts = grown;
        offsets = mesh.runOffsets = grownOff;
      }
      offsets![runs] = start * 4;
      counts[runs] = end - start;
      runs++;
    }
    mesh.runs = runs;
    return written;
  }

  /** Draw the mesh's visible runs (all of it when nothing was culled) from its static index buffer. */
  private drawRuns(mesh: MeshGPU): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.lod ? mesh.coarse!.ibo : mesh.ibo);
    if (!mesh.runs) {
      gl.drawElements(gl.TRIANGLES, mesh.lod ? mesh.coarse!.count : mesh.count, gl.UNSIGNED_INT, 0);
      this.drawCalls++;
      return;
    }
    const counts = mesh.runCounts!, offsets = mesh.runOffsets!;
    if (this.multiDraw) {
      this.multiDraw.multiDrawElementsWEBGL(gl.TRIANGLES, counts, 0, gl.UNSIGNED_INT, offsets, 0, mesh.runs);
      this.drawCalls++;
      return;
    }
    for (let r = 0; r < mesh.runs; r++) gl.drawElements(gl.TRIANGLES, counts[r], gl.UNSIGNED_INT, offsets[r]);
    this.drawCalls += mesh.runs;
  }

  private drawMesh(mesh: MeshGPU | null, cx: number, cy: number, zoom: number, count = mesh?.count ?? 0): void {
    if (!mesh || !count) return;
    if (mesh.inst) {
      const relief = mesh.relief;
      const lit = relief && relief.maxWidth * zoom >= RELIEF_SHADE_PX;
      return this.drawChunks(mesh, cx, cy, zoom, lit ? relief.material === 'rope' ? 'rope' : 'clay' : 'flat');
    }
    const gl = this.gl;
    const relief = mesh.relief;
    // Quilled walls are lit by their baked colours; their program adds the top edge and draws the scrolls, so it is used
    // at every zoom (flat, u_far, once the walls are under a pixel high).
    const quill = relief?.material === 'quilling';
    if (relief && (quill || relief.maxWidth * zoom >= RELIEF_SHADE_PX)) {
      const lit = this.relief!.lit[relief.material];
      const m = RELIEF_MATERIALS[relief.material];
      gl.useProgram(lit.program);
      gl.uniform4f(lit.u.mat, m[0], m[1], m[2], m[3]);
      if (quill) gl.uniform1f(lit.u.far, relief.maxWidth * zoom < 1 ? 1 : 0);
      this.meshUniforms(lit.u, mesh, cx, cy, zoom);
    } else {
      gl.useProgram(this.progMesh);
      this.meshUniforms(this.uMesh, mesh, cx, cy, zoom);
    }
    gl.bindVertexArray(mesh.vao);
    // Constant vertex attributes are shared across VAOs. Picture draws may replace this value.
    if (!mesh.wide) gl.vertexAttrib2f(2, 0, 0);
    if (mesh.opaque) gl.disable(gl.BLEND);
    this.drawRuns(mesh);
    if (mesh.opaque) gl.enable(gl.BLEND);
  }

  private meshUniforms(u: { view: WebGLUniformLocation | null; zoom: WebGLUniformLocation | null; off: WebGLUniformLocation | null;
    offLow: WebGLUniformLocation | null }, mesh: MeshGPU, cx: number, cy: number, zoom: number): void {
    const gl = this.gl;
    gl.uniform2f(u.view, this.viewW, this.viewH);
    gl.uniform1f(u.zoom, zoom);
    const x = mesh.ox - cx, y = mesh.oy - cy;
    const highX = Math.fround(x), highY = Math.fround(y);
    gl.uniform2f(u.off, highX, highY);
    gl.uniform2f(u.offLow, x - highX, y - highY);
  }

  /**
   * Branch shadows of the static and animated dimensional meshes into the half-resolution layer, with MAX blending so
   * overlapping shadows (every fork) never darken twice. Returns the layer's opacity, 0 when nothing was drawn: the
   * shadows fade in from `RELIEF_SHADOW_PX` to twice that on screen and are skipped below it.
   */
  private drawShadowLayer(cx: number, cy: number, zoom: number, branches: number, animated: number): number {
    const still = this.mesh?.relief, moving = this.animatedMesh?.relief;
    const reach = Math.max(still?.shadow ? still.shadowReach : 0, moving?.shadow ? moving.shadowReach : 0);
    const alpha = Math.min(1, (reach * zoom - RELIEF_SHADOW_PX) / RELIEF_SHADOW_PX);
    if (alpha <= 0 || (!branches && !animated)) return 0;
    const gl = this.gl;
    const r = this.relief!;
    const layer = this.ensureShadowLayer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.fbo);
    gl.viewport(0, 0, layer.w, layer.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendEquation(gl.MAX);
    gl.useProgram(r.shade);
    this.shadowMesh(this.mesh, branches, cx, cy, zoom);
    this.shadowMesh(this.animatedMesh, animated, cx, cy, zoom);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    return alpha;
  }

  private shadowMesh(mesh: MeshGPU | null, count: number, cx: number, cy: number, zoom: number): void {
    if (!mesh?.relief?.shadow || !count) return;
    if (mesh.inst) {
      this.drawChunks(mesh, cx, cy, zoom, 'shadow');
      // The shadow layer's own program goes on drawing the static meshes after this one.
      this.gl.useProgram(this.relief!.shade);
      return;
    }
    const gl = this.gl;
    const u = this.relief!.uShade;
    this.meshUniforms(u, mesh, cx, cy, zoom);
    gl.uniform1f(u.coded, mesh.relief.material === 'rope' ? 1 : 0);
    gl.bindVertexArray(mesh.vao);
    if (!mesh.wide) gl.vertexAttrib2f(2, 0, 0);
    this.drawRuns(mesh);
  }

  /** The shadow layer over the page in the mesh's shadow colour (one full-screen pass). */
  private compositeShadowLayer(alpha: number): void {
    const gl = this.gl;
    const r = this.relief!;
    const color = (this.mesh?.relief ?? this.animatedMesh!.relief!).shadowColor;
    gl.useProgram(r.composite);
    gl.bindVertexArray(this.imgVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowLayer!.tex);
    gl.uniform1i(r.uComposite.tex, 0);
    gl.uniform2f(r.uComposite.res, this.canvas.width, this.canvas.height);
    gl.uniform4f(r.uComposite.color, color.r * alpha, color.g * alpha, color.b * alpha, color.a * alpha);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.drawCalls++;
  }

  private drawImages(
    images: ImageDraw[],
    idx: Uint32Array,
    cx: number,
    cy: number,
    zoom: number,
    t0: number,
    upload: boolean
  ): boolean {
    const gl = this.gl;
    const t = this.opts.imagePlaceholder ?? { r: 0.121, g: 0.132, b: 0.158, a: 0.22 };
    this.bars.reset();
    this.imgList.length = 0;
    const instances = this.texInst;
    instances.reset();
    const far = zoom < FAR_ART_ZOOM;
    const placeholderDeadline = t0 + 2;
    for (let k = 0; k < idx.length; k++) {
      const im = images[idx[k]];
      const screenSize = Math.max(im.w, im.h) * zoom;
      if (far && im.overviewTitle) continue;
      if (screenSize < 0.5 || ((far || im.vector || im.previewSrc) && screenSize < 7)) continue;
      const pixels = screenSize * this.dpr;
      const bucket = Math.max(32, Math.min(1024, 2 ** Math.ceil(Math.log2(pixels))));
      const vector = im.vector ? Math.min(bucket, far ? 128 : 1024) : 0;
      const level = bucket <= 32 ? 32 : bucket <= 64 ? 64 : 128;
      const thumbnail = im.previewSrc ?? im.src;
      const preview = im.vector
        ? vector <= 128 && im.previewSrcs?.[level] ? level : 0
        : far || pixels <= 112 ? level : 0;
      const source = preview ? im.previewSrcs?.[preview] ?? thumbnail : im.src;
      let entry: ImageEntry | undefined = this.images.get(source, preview ? 0 : vector, pixels, preview);
      if (entry.state === 'error' && source !== im.src) {
        if (!vector && source !== thumbnail) entry = this.images.get(thumbnail, 0, pixels, preview);
        if (vector || entry.state === 'error') entry = this.images.get(im.src, vector, pixels, vector ? 0 : preview);
      }
      if (entry.src === im.src && entry.decodeFailed) {
        this.opts.onImageDecodeFailed?.(im.src);
        continue;
      }
      if (entry.state !== 'ready') {
        entry = this.images.nearestPreview(thumbnail, preview, pixels, im.previewSrcs);
        if (!entry && vector) entry = this.images.nearestVector(im.src, vector, pixels, far ? 128 : 1024);
        const coarse = im.previewSrcs?.[128] ?? im.previewSrc;
        if (!entry && !preview && coarse) entry = this.images.get(coarse, 0, pixels, 128);
      }
      const texture = (entry?.state === 'ready' && entry.tex) ||
        (im.thumbHash && this.images.blurredTexture(im.thumbHash, pixels, placeholderDeadline));
      let corners: number[] | undefined;
      if (!texture && im.thumbHash) {
        let cached = this.blurCorners.get(im);
        if (cached?.hash !== im.thumbHash) {
          cached = { hash: im.thumbHash, corners: coarseBlur(im.thumbHash) };
          this.blurCorners.set(im, cached);
        }
        corners = cached.corners;
      }
      if (texture || corners) {
        const tex = texture || null;
        const uv = entry?.state === 'ready' ? entry.uv : undefined;
        const previous = this.imgList.at(-1);
        if (previous && previous.tex === tex) previous.count++;
        else this.imgList.push({ tex, clipped: !!uv, start: instances.n, count: 1 });
        const offset = instances.next();
        const data = instances.data;
        data[offset] = im.x - im.w / 2 - cx;
        data[offset + 1] = im.y - im.h / 2 - cy;
        data[offset + 2] = im.w;
        data[offset + 3] = im.h;
        data[offset + 4] = corners?.[0] ?? uv?.[0] ?? 0;
        data[offset + 5] = corners?.[1] ?? uv?.[1] ?? 0;
        data[offset + 6] = corners?.[2] ?? uv?.[2] ?? 1;
        data[offset + 7] = corners?.[3] ?? uv?.[3] ?? 1;
        data[offset + 8] = im.opacity;
        data[offset + 9] = im.angle ?? 0;
        data[offset + 10] = im.x - cx;
        data[offset + 11] = im.y - cy;
      } else {
        const rad = Math.min(im.w, im.h) * 0.08;
        const alpha = im.opacity;
        const tint = alpha === 1 ? t : { r: t.r * alpha, g: t.g * alpha, b: t.b * alpha, a: t.a * alpha };
        writeRect(this.bars, im.x - im.w / 2 - cx, im.y - im.h / 2 - cy, im.w, im.h, rad, 0, tint, undefined);
      }
    }
    this.drawRects(this.barVao, this.barBuf, this.bars, zoom);
    if (instances.n > 0) {
      gl.useProgram(this.progTex);
      gl.uniform2f(this.uTex.view, this.viewW, this.viewH);
      gl.uniform1f(this.uTex.zoom, zoom);
      gl.uniform1i(this.uTex.tex, 0);
      gl.uniform1f(this.uTex.alpha, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(this.texVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuf);
      const buffer = this.batchDisjointPictures(instances);
      gl.bufferData(gl.ARRAY_BUFFER, buffer, gl.STREAM_DRAW, 0, instances.n * TEX_STRIDE);
      let active = this.progTex;
      for (const batch of this.imgList) {
        const program = batch.tex ? this.progTex : this.progBlur;
        if (active !== program) {
          active = program;
          gl.useProgram(active);
          if (!batch.tex) {
            gl.uniform2f(this.uBlur.view, this.viewW, this.viewH);
            gl.uniform1f(this.uBlur.zoom, zoom);
          }
        }
        if (batch.tex) gl.uniform1i(this.uTex.clampUV, Number(batch.clipped));
        const base = batch.start * TEX_STRIDE * 4;
        for (let loc = 0; loc < 2; loc++) {
          gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, TEX_STRIDE * 4, base + loc * 16);
        }
        gl.vertexAttribPointer(2, 1, gl.FLOAT, false, TEX_STRIDE * 4, base + 32);
        gl.vertexAttribPointer(3, 3, gl.FLOAT, false, TEX_STRIDE * 4, base + 36);
        if (batch.tex) gl.bindTexture(gl.TEXTURE_2D, batch.tex);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
        this.drawCalls++;
      }
      if (active !== this.progTex) gl.useProgram(this.progTex);
      gl.uniform1i(this.uTex.clampUV, 0);
    }
    this.stats.imagesDrawn += instances.n;
    // Uploads run once in the maps' pass, and again after front-band pictures (which come after it).
    if (!upload) return false;
    const moreUploads = this.images.processUploads(Math.min(t0 + 4, performance.now() + Math.min(3, this.stats.refreshIntervalMs * 0.18)));
    return moreUploads;
  }

  /** Group non-overlapping thumbnails without changing the order of overlapping art. */
  private batchDisjointPictures(instances: InstanceBuf): Float32Array {
    const runs = this.imgList;
    if (runs.length <= 5 || runs.some((run) => !run.clipped)) return instances.data;
    // Rotated pictures may overlap where their unrotated boxes do not: keep their order.
    for (let i = 0; i < instances.n; i++) if (instances.data[i * TEX_STRIDE + 9]) return instances.data;

    const order = this.imageOrder;
    order.length = instances.n;
    for (let i = 0; i < order.length; i++) order[i] = i * TEX_STRIDE;
    const data = instances.data;
    order.sort((a, b) => data[a] - data[b]);
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      const right = data[a] + data[a + 2];
      for (let j = i + 1; j < order.length && data[order[j]] < right; j++) {
        const b = order[j];
        if (data[a + 1] < data[b + 1] + data[b + 3] && data[b + 1] < data[a + 1] + data[a + 3]) return data;
      }
    }

    const pages = new Map<WebGLTexture | null, ImageBatch[]>();
    for (const run of runs) {
      const page = pages.get(run.tex);
      if (page) page.push(run);
      else pages.set(run.tex, [run]);
    }
    const grouped = this.groupedImages;
    grouped.reset();
    runs.length = 0;
    for (const page of pages.values()) {
      const start = grouped.n;
      for (const run of page) {
        for (let i = 0; i < run.count; i++) {
          const source = (run.start + i) * TEX_STRIDE;
          const target = grouped.next();
          for (let component = 0; component < TEX_STRIDE; component++) {
            grouped.data[target + component] = data[source + component];
          }
        }
      }
      runs.push({ tex: page[0].tex, clipped: true, start, count: grouped.n - start });
    }
    return grouped.data;
  }

  private drawLabels(
    labels: LabelDraw[],
    idx: Uint32Array,
    cx: number,
    cy: number,
    zoom: number,
    t0: number
  ): boolean {
    if (this.labelZoomFrame !== this.frame) {
      this.labelZoomDir = this.labelZoom > 0 ? Math.sign(zoom - this.labelZoom) : 0;
      this.labelZoom = zoom;
      this.labelZoomFrame = this.frame;
    }
    // Every label is under the skip size and none can become an overview title: nothing to visit.
    if (!this.labelOverviews && this.labelMaxFont * zoom < 0.65) return false;
    const gl = this.gl;
    const atlas = this.atlas;
    const deadline = t0 + Math.min(this.opts.labelBudgetMs, this.stats.refreshIntervalMs * 0.24);
    const k0 = atlas.bucketFor(zoom * this.dpr);
    const greekPx = this.opts.greekPx;
    // While the zoom is changing, a raster one bucket (a factor of sqrt 2) off is drawn scaled instead of re-rasterising
    // every visible label at each bucket crossing. The first frame after the zoom stops asks for the exact bucket again.
    const zoomDir = this.labelZoomDir;
    this.bars.reset();
    this.drawIdx.length = 0;
    this.drawBucket.length = 0;
    this.drawScale.length = 0;
    this.overviewChips.reset();
    let overviewCount = 0;
    let overviewPrepared = false;
    let more = false;
    let greeked = 0;

    // Pass 1: decide per label (greek, placeholder, text) and queue missing rasterisations.
    for (let k = 0; k < idx.length; k++) {
      const li = idx[k];
      const l = labels[li];
      const labelPixels = l.fontSize * zoom;
      const overview = (l.overviewTitle || (l.pictureTitle && zoom < FAR_ART_ZOOM)) && labelPixels < OVERVIEW_TITLE_PX;
      if (overview) {
        if (overviewCount >= OVERVIEW_TITLE_LIMIT) continue;
        if (!overviewPrepared) {
          this.resetOverviewGrid();
          overviewPrepared = true;
        }
        if (!this.overviewAnchorFree(l, cx, cy, zoom)) continue;
      }
      if (!overview && labelPixels < 0.65) continue;
      if (!overview && labelPixels < greekPx) {
        this.pushBars(l, null, cx, cy, zoom, 0.55);
        greeked++;
        continue;
      }
      let e = this.labelEntries[li];
      if (!e) e = this.labelEntries[li] = atlas.entryFor(l);
      else e.lastFrame = this.frame;
      if (!e.layout) {
        if (performance.now() > deadline) {
          this.pushBars(l, null, cx, cy, zoom, 0.35);
          this.stats.labelsPending++;
          more = true;
          continue;
        }
        atlas.ensureLayout(e);
      }
      const scale = overview ? OVERVIEW_TITLE_PX / Math.max(labelPixels, 0.01) : 1;
      if (overview) {
        const area = this.overviewRect(l, e.layout!, cx, cy, zoom, scale);
        if (!this.reserveOverview(area)) continue;
        overviewCount++;
      }
      const bucket = Math.min(overview ? atlas.bucketFor(zoom * scale * this.dpr) : k0, atlas.maxBucket(e.layout!, l));
      if (!atlas.exact(e, bucket)) {
        const near = zoomDir !== 0 && !overview ? atlas.best(e, bucket) : null;
        if (near && Math.abs(near.bucket - bucket) <= 1) more = true;
        else {
          const dx = l.x - cx, dy = l.y - cy;
          atlas.request(e, bucket, dx * dx + dy * dy);
        }
      }
      this.drawIdx.push(li);
      this.drawBucket.push(bucket);
      this.drawScale.push(scale);
    }

    // Pass 2: rasterise what fits in the budget; the rest continues next frame.
    const remaining = atlas.process(deadline);
    this.stats.labelsPending += remaining;
    if (remaining > 0) more = true;

    // Pass 3: build per-page instance lists (fallback to nearest bucket, or a faint bar).
    const nPages = atlas.pages.length;
    const counts = this.texPageCounts;
    counts.length = nPages;
    counts.fill(0);
    // First count per page to lay instances out contiguously by page.
    const chosen: (ReturnType<LabelAtlas['best']>)[] = new Array(this.drawIdx.length);
    for (let j = 0; j < this.drawIdx.length; j++) {
      const e = this.labelEntries[this.drawIdx[j]]!;
      const s = atlas.best(e, this.drawBucket[j]);
      chosen[j] = s;
      if (s) counts[s.page.id]++;
      else this.pushBars(labels[this.drawIdx[j]], e, cx, cy, zoom, 0.35);
    }
    const starts: number[] = new Array(nPages);
    let acc = 0;
    for (let p = 0; p < nPages; p++) {
      starts[p] = acc;
      acc += counts[p];
    }
    const ti = this.texInst;
    ti.reset();
    for (let n = 0; n < acc; n++) ti.next();
    const fillAt = starts.slice();
    let drawn = 0;
    for (let j = 0; j < chosen.length; j++) {
      const s = chosen[j];
      if (!s) continue;
      atlas.touch(s);
      const l = labels[this.drawIdx[j]];
      const o = fillAt[s.page.id]++ * TEX_STRIDE;
      const d = ti.data;
      const layout = this.labelEntries[this.drawIdx[j]]?.layout;
      const scale = this.drawScale[j];
      const x = alignedLabelX(l, layout?.w ?? s.qw) - cx;
      const y = l.y - cy;
      d[o] = x + s.ox * scale;
      d[o + 1] = y + s.oy * scale;
      d[o + 2] = s.qw * scale;
      d[o + 3] = s.qh * scale;
      if (scale > 1 && layout) {
        const area = this.overviewRect(l, layout, cx, cy, zoom, scale);
        writeRect(this.overviewChips, (area.x - this.viewW / 2) / zoom, (area.y - this.viewH / 2) / zoom,
          area.w / zoom, area.h / zoom, 3 / zoom, 0, overviewBackground(l.color, this.scene!.background), undefined);
      }
      d[o + 4] = s.u0;
      d[o + 5] = s.v0;
      d[o + 6] = s.u1;
      d[o + 7] = s.v1;
      d[o + 8] = l.opacity ?? 1;
      d[o + 9] = l.angle ?? 0;
      d[o + 10] = l.x - cx;
      d[o + 11] = y;
      drawn++;
    }
    if (this.overviewChips.n > 0) {
      this.drawRects(this.barVao, this.barBuf, this.bars, zoom);
      this.drawRects(this.barVao, this.barBuf, this.overviewChips, zoom);
    }
    if (acc > 0) {
      gl.useProgram(this.progTex);
      gl.uniform2f(this.uTex.view, this.viewW, this.viewH);
      gl.uniform1f(this.uTex.zoom, zoom);
      gl.uniform1i(this.uTex.tex, 0);
      gl.uniform1f(this.uTex.alpha, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(this.texVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.texBuf);
      gl.bufferData(gl.ARRAY_BUFFER, ti.data, gl.STREAM_DRAW, 0, acc * TEX_STRIDE);
      for (let p = 0; p < nPages; p++) {
        if (counts[p] === 0) continue;
        const base = starts[p] * TEX_STRIDE * 4;
        for (let loc = 0; loc < 2; loc++) {
          gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, TEX_STRIDE * 4, base + loc * 16);
        }
        gl.vertexAttribPointer(2, 1, gl.FLOAT, false, TEX_STRIDE * 4, base + 32);
        gl.vertexAttribPointer(3, 3, gl.FLOAT, false, TEX_STRIDE * 4, base + 36);
        gl.bindTexture(gl.TEXTURE_2D, atlas.pages[p].tex);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, counts[p]);
        this.drawCalls++;
      }
    }
    this.stats.labelsDrawn += drawn;
    this.stats.labelsGreeked += greeked;
    if (!this.overviewChips.n) this.drawRects(this.barVao, this.barBuf, this.bars, zoom);
    return more;
  }

  private resetOverviewGrid(): void {
    this.overviewColumns = Math.ceil(this.viewW / OVERVIEW_CELL_PX);
    this.overviewRows = Math.ceil(this.viewH / OVERVIEW_CELL_PX);
    const size = this.overviewColumns * this.overviewRows;
    if (this.overviewGrid.length !== size) this.overviewGrid = new Uint8Array(size);
    else this.overviewGrid.fill(0);
  }

  private overviewAnchorFree(label: LabelDraw, cx: number, cy: number, zoom: number): boolean {
    const x = Math.floor(((label.x - cx) * zoom + this.viewW / 2) / OVERVIEW_CELL_PX);
    const y = Math.floor(((label.y - cy) * zoom + this.viewH / 2) / OVERVIEW_CELL_PX);
    return x >= 0 && y >= 0 && x < this.overviewColumns && y < this.overviewRows &&
      this.overviewGrid[y * this.overviewColumns + x] === 0;
  }

  private overviewRect(label: LabelDraw, layout: Pick<Rect, 'w' | 'h'>,
    cx: number, cy: number, zoom: number, scale: number): Rect {
    const w = layout.w * zoom * scale + 8;
    const h = layout.h * zoom * scale + 4;
    return {
      x: (alignedLabelX(label, layout.w) - cx) * zoom + (this.viewW - w) / 2,
      y: (label.y - cy) * zoom + (this.viewH - h) / 2,
      w, h
    };
  }

  private reserveOverview(area: Rect): boolean {
    const x0 = Math.max(0, Math.floor(area.x / OVERVIEW_CELL_PX));
    const y0 = Math.max(0, Math.floor(area.y / OVERVIEW_CELL_PX));
    const x1 = Math.min(this.overviewColumns - 1, Math.floor((area.x + area.w) / OVERVIEW_CELL_PX));
    const y1 = Math.min(this.overviewRows - 1, Math.floor((area.y + area.h) / OVERVIEW_CELL_PX));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (this.overviewGrid[y * this.overviewColumns + x]) return false;
      }
    }
    for (let y = y0; y <= y1; y++) {
      this.overviewGrid.fill(1, y * this.overviewColumns + x0, y * this.overviewColumns + x1 + 1);
    }
    return true;
  }

  /** Greeking bar(s) in the label's colour; used for tiny text and while a label is not yet rasterised. */
  private pushBars(l: LabelDraw, e: LabelEntry | null, cx: number, cy: number, zoom: number, alpha: number): void {
    let lineW: number[] | null = null;
    let bw: number, lh: number;
    if (e && e.layout) {
      lineW = e.layout.lines.map((x) => x.w);
      bw = e.layout.w;
      lh = e.layout.lineHeight;
    } else {
      const est = estimateExtent(l);
      bw = est.w * 0.65;
      lh = l.fontSize * 1.25;
      const n = Math.min(est.lines, 8);
      lineW = [];
      for (let i = 0; i < n; i++) lineW.push(i === n - 1 && n > 1 ? bw * 0.6 : bw);
    }
    const n = lineW.length;
    const top = l.y - (n * lh) / 2;
    const barH = Math.max(1.4 / zoom, l.fontSize * 0.45);
    const c = l.color;
    alpha *= l.opacity ?? 1;
    const col: RGBA = { r: c.r * alpha, g: c.g * alpha, b: c.b * alpha, a: c.a * alpha };
    for (let i = 0; i < n; i++) {
      const w = lineW[i];
      if (w <= 0) continue;
      const free = bw - w;
      const x0 = alignedLabelX(l, bw) - bw / 2 + (l.align === 'left' ? 0 : l.align === 'center' ? free / 2 : free);
      writeRect(this.bars, x0 - cx, top + (i + 0.5) * lh - barH / 2 - cy, w, barH, barH / 2, 0, col, undefined);
    }
  }
}
