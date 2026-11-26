/**
 * Shared contracts for Radiant. Every module builds against these types.
 * Changing a type here is a cross-module change: only the coordinator edits this file.
 *
 * Coordinates: world space, y pointing down, 1 world unit = 1 CSS pixel at zoom 1.
 * A node's box is described by its CENTRE (x, y) and size (w, h).
 */

import type { ThumbnailLevels } from './image-levels';
import type { AiEffort, AiEngine } from './ai/provider';

// ---------------------------------------------------------------- document model

export type NodeId = string;

/** How a subtree is drawn. Set on a subtree root and inherited by descendants unless overridden. */
export type Representation = 'vector' | 'picture' | 'svg';
export type PictureLabelPlacement = 'caption' | 'branch' | 'recall';

/** Visual form of a node in the vector representation. */
export type NodeShape =
  | 'underline' // text sits on the branch line (MindNode / Buzan "word on the line"); the default
  | 'box' // rounded rectangle
  | 'rectangle'
  | 'circle'
  | 'square'
  | 'none'; // text only

export type BranchStyle =
  | 'tapered' // thick at the parent, thin at the child, smooth cubic (default)
  | 'organic' // tapered plus seeded irregular curvature (hand-drawn look)
  | 'line' // straight stroke
  | 'rounded' // smooth stroke
  | 'angular'; // right-angle elbows

/** Layout used for the children of a root (main node). */
export type LayoutKind = 'mindmap' | 'right' | 'left' | 'down' | 'up' | 'compact' | 'radial' | 'outline' | 'timeline' | 'columns' | 'grid' | 'popcorn';

export interface Vec2 {
  x: number;
  y: number;
}
export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  x: number; // left
  y: number; // top
  w: number;
  h: number;
}

/** Per-node style overrides. Absent fields inherit from the parent chain, then the theme. */
export interface NodeStyle {
  color?: string; // CSS colour for this node's branch and underline; children inherit
  textColor?: string;
  fillColor?: string;
  fontFamily?: string;
  alignment?: 'left' | 'center' | 'right';
  branchWidth?: number;
  fontSize?: number; // world units
  bold?: boolean;
  italic?: boolean;
  /** Follow the underline curve on supported one-line labels. */
  curvedLabel?: boolean;
  branchBoundary?: boolean;
  extrudedLabel?: boolean;
  shape?: NodeShape;
  branch?: BranchStyle;
  emphasis?: 0 | 1 | 2; // 0 normal, 1 emphasised, 2 key node (richest treatment; use sparingly)
}

export interface ArtStyleOverrides {
  medium?: string;
  mood?: string;
  detail?: string;
  lineWeight?: string;
  palette?: string[];
  negative?: string[];
  background?: 'transparent' | 'plain';
  seed?: number;
}

export interface NodeArt {
  assetHash: string;
  inputHash: string;
  /** Digest of the editable node fields and artwork style. */
  sourceHash?: string;
  prompt: string;
  /** Editable artistic direction, distinct from the full provider prompt. */
  brief?: string;
  instructions?: string;
  effort?: AiEffort;
  /** Untouched provider image, retained when fitting produces a derivative. */
  originalAsset?: string;
  templateVersion?: string;
  model?: string;
  revisedPrompt?: string;
  styleId: string;
  styleVersion: number;
  styleSnapshot?: import('./art/styleSheet').ArtStyleSheet;
  /** Seed reported by the provider, when present. */
  seed?: number;
  /** Style seed requested from the SVG model. */
  svgSeed?: number;
  parentAsset?: string;
  generatedAt: string;
  framed?: boolean;
  thumbnailHash?: string;
  /** Validated SVG region shared by the independently rendered node groups. */
  svgRegion?: import('./art/svg-region').SvgRegionAsset;
  /** Validation notes from SVG generation and any automatic fitting applied before acceptance. */
  svgValidation?: { warnings: string[]; fitted?: boolean };
  pixelSize?: { width: number; height: number; padding: number };
  /** Normalized coordinates within the artwork. */
  anchors?: { in: Vec2; out: Vec2; outByChild?: Record<NodeId, Vec2> };
}

/** File-format metadata kept on imported nodes for faithful re-export. */
export interface InterchangeMetadata {
  opmlAttributes?: [name: string, value: string][];
  freeMindIcons?: string[];
}

export interface MapNode {
  generatedStyle?: StyleSheet;
  /** Initial generated tree awaiting its first user edit or explicit acceptance. */
  generatedDraft?: true;
  pictureArt?: NodeArt;
  /** Latest failed picture generation, shown beside the node and in the inspector. */
  pictureArtError?: string;
  pictureLabelPlacement?: PictureLabelPlacement;
  svgArt?: NodeArt;
  /** Latest failed SVG generation, shown beside the node and in the inspector. */
  svgArtError?: string;
  artReference?: NodeArt;
  /** Optional artwork preset inherited by descendants. */
  artStyleId?: string;
  artStyleOverrides?: ArtStyleOverrides;
  artStyleIsland?: true;
  artStyleSheet?: import('./art/subtree-style').SubtreeArtStyle;
  id: NodeId;
  /** null for roots (main nodes and floating nodes). */
  parent: NodeId | null;
  /** Ordered children. */
  children: NodeId[];
  text: string;
  /** Identifies a shared content group, independent of any one occurrence. */
  aliasGroup?: string;
  /** Stored answer for a study blank. The visible label remains independently editable. */
  blankAnswer?: string;
  note?: string;
  interchange?: InterchangeMetadata;
  collapsed?: boolean;
  /** For children of a root in 'mindmap' layout: which side. Absent = layout decides (balanced). */
  side?: 'left' | 'right';
  /** Layout override for a direct child of a map root. */
  branchLayout?: LayoutKind;
  /** Manual move, stored as an offset from the automatic position (MindNode behaviour). */
  offset?: Vec2;
  /** Absolute world-space centre of a pinned non-root node. */
  pinnedPosition?: Vec2;
  style?: NodeStyle;
  /** Representation of the subtree rooted here; absent = inherit; roots default to 'vector'. */
  representation?: Representation;
  /** Content hash of a picture for this node (picture representation), in the asset store. */
  imageAsset?: string;
  /** Intrinsic width / height declared for the attached picture. */
  imageAspect?: number;
  /** Display scale for an attached local picture. Defaults to 1. */
  imageScale?: number;
  imageAlt?: string;
  sketch?: import('./geometry/ink').InkSketch;
  /** An optional symbol shown beside the node label. */
  sticker?: string;
  /** Free-form tags. */
  tags?: string[];
  /** Task state if the node is a task. */
  task?: { done: boolean };
  /** Optional link (URL or another map). */
  link?: string;
  /** Who created the node: the user, or the AI (with the job id). Used to show what the AI did. */
  origin?: { by: 'user' } | { by: 'ai'; job: string };
  /** Job that most recently refined this node. */
  lastAiJob?: string;
  /** Heading cited by the model for this generated branch. */
  sourceHeading?: string;
}

export type RootSpacing = 'narrow' | 'default' | 'wide';

export interface RootInfo {
  /** World position of the root node centre. */
  position: Vec2;
  layout: LayoutKind;
  spacing?: RootSpacing;
  organic?: true;
}

export interface LinkStyle {
  bend?: Vec2;
  color?: string;
  dash?: 'solid' | 'dashed';
  arrows?: 'none' | 'start' | 'end' | 'both';
}

export interface CrossLink extends LinkStyle {
  id: string;
  from: NodeId;
  to: NodeId;
  label?: string;
}

export interface StoredNodePlacement {
  root: NodeId;
  parent: NodeId | null;
  index: number;
  siblingCount: number;
  /** Settled world coordinates including accumulated manual offset. */
  x: number;
  y: number;
  w: number;
  h: number;
  offsetX: number;
  offsetY: number;
  side: -1 | 0 | 1;
  flow: 'h' | 'v' | 'r';
  branchLayout?: LayoutKind;
  pinnedSide?: 'left' | 'right';
  collapsed?: boolean;
}

export interface LayoutPlacements {
  roots: Record<NodeId, { layout: LayoutKind; x: number; y: number; levelGap: number; siblingGap: number; organicSeed?: number }>;
  nodes: Record<NodeId, StoredNodePlacement>;
}

export interface AiJobRecord {
  kind: 'generate' | 'expand' | 'refine';
  webSearch?: boolean;
  status: 'running' | 'done' | 'cancelled' | 'error';
  interrupted?: true;
  route?: 'stream' | 'exec' | 'replay';
  prompt: string;
  instructions?: string;
  fallbackPrompt?: string;
  warnings?: string[];
  templateVersion?: string;
  /** The engine that ran the job; absent on jobs saved before engines could be chosen, which all ran on Codex. */
  engine?: AiEngine;
  model?: string;
  effort?: AiEffort;
  created: string;
  scopeId?: NodeId;
  scope?: 'node' | 'branch' | 'map';
  limits?: { maxDepth: number; maxChildren: number };
  usage?: { inputTokens?: number; outputTokens?: number };
}

// ---------------------------------------------------------------- presentations (implementation spec 6.2)

export interface PresentationStep {
  id: string;
  /** What this step is about; the camera frames these nodes. */
  focus: NodeId[];
  /** Nodes that become visible at this step, besides focus. */
  reveal?: NodeId[];
  /** Nodes that stop being visible at this step. */
  hide?: NodeId[];
  /** Canvas elements this step focuses, frames included. */
  elements?: string[];
  /** Default 'subtree': focus nodes plus what they reveal. */
  frame?: 'nodes' | 'subtree' | 'map';
  /** 'each': revealed nodes appear one per press. */
  build?: 'all' | 'each';
  /** Default 'others'. */
  dim?: 'others' | 'none';
  /** Default: text of the first focus node. */
  title?: string;
  /** One-line takeaway shown large. */
  caption?: string;
  /** Speaker note; falls back to the focus node's note. */
  note?: string;
  transition?: 'glide' | 'cut';
  skip?: boolean;
  /** Time budget. */
  seconds?: number;
}

export interface Presentation {
  id: string;
  name: string;
  steps: PresentationStep[];
  /** Default 'progressive': the map starts folded and grows. */
  reveal?: 'progressive' | 'all';
  /** Default 'dim'. */
  context?: 'dim' | 'hide';
  /** Default 0.22. */
  dimOpacity?: number;
  /** Default 'full'. */
  motion?: 'full' | 'gentle' | 'none';
  targetMinutes?: number;
}

// ---------------------------------------------------------------- canvas elements (implementation spec 4.3)

export type CanvasElementKind =
  'rect' | 'ellipse' | 'diamond' | 'line' | 'arrow' | 'draw' | 'text' | 'note' | 'frame' | 'image';

export interface CanvasBinding {
  /** A mind-map node, or */
  node?: NodeId;
  /** another canvas element. */
  element?: string;
  /** Fixed point on the target as 0..1 ratios; absent = nearest edge toward the other end. */
  at?: Vec2;
  gap?: number;
}

export interface CanvasElement {
  id: string;
  kind: CanvasElementKind;
  /** Top-left corner and size in world units (Excalidraw's x, y, width, height). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Radians about the centre. */
  angle?: number;
  /** Under or over the mind maps. Default by kind: frame, rect, ellipse, diamond, note, image = back; arrow, line, draw, text = front. */
  band?: 'back' | 'front';
  stroke?: string;
  /** Absent = transparent. */
  fill?: string;
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch' | 'zigzag';
  /** 1, 2 or 4. */
  strokeWidth?: number;
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  /** 0 = clean geometry. */
  roughness?: 0 | 1 | 2;
  round?: boolean;
  /** 0..1 */
  opacity?: number;
  /** Fixes the sketch. */
  seed: number;
  locked?: boolean;
  /** Innermost first. */
  groups?: string[];
  /** Id of the owning frame. */
  frame?: string;
  link?: string;
  /** Text, note text, frame name, label inside a shape or on an arrow. */
  text?: string;
  fontSize?: number;
  font?: 'theme' | 'hand' | 'code';
  align?: 'left' | 'center' | 'right';
  textColor?: string;
  /** line, arrow, draw: x0, y0, x1, y1, ... relative to (x, y). */
  points?: number[];
  /** draw: 0..1 per point. */
  pressures?: number[];
  start?: CanvasBinding;
  end?: CanvasBinding;
  startHead?: 'none' | 'arrow' | 'dot' | 'bar';
  endHead?: 'none' | 'arrow' | 'dot' | 'bar';
  elbow?: boolean;
  /** image: content hash in the assets table. */
  asset?: string;
  /** Unused fields of an imported .excalidraw element, kept for round trip. */
  source?: Record<string, unknown>;
}

export interface CanvasState {
  /** Array order is stacking order within a band. */
  elements: CanvasElement[];
  bookmarks?: { id: string; name: string; view: CameraState }[];
  grid?: { size: number; snap: boolean };
}

export interface Doc {
  /** Format version of this JSON structure. */
  version: 1;
  id: string;
  title: string;
  /** Root (main and floating) nodes, in z-order. */
  roots: NodeId[];
  rootInfo: Record<NodeId, RootInfo>;
  layoutPlacements?: LayoutPlacements;
  nodes: Record<NodeId, MapNode>;
  links: CrossLink[];
  aiJobs?: Record<string, AiJobRecord>;
  themeId: string;
  tagColors?: Record<string,string>;
  markerMeanings?: Record<string, string>;
  themeSettings?: import('./model/theme-settings').ThemeSettings;
  artStyleId?: string;
  presentations?: Presentation[];
  canvas?: CanvasState;
  /** Seed for organic geometry, so a map looks the same every time it is opened. */
  seed: number;
  created: string; // ISO date
  modified: string; // ISO date
}

// ---------------------------------------------------------------- operations (undoable edits)

/**
 * Every change to a Doc is an Op. applyOp returns the inverse Op, so undo is "apply the inverses in reverse".
 * Ops are plain JSON so they can be logged to disk for crash recovery and, later, synced.
 */
export type Op =
  | { t: 'insert'; node: MapNode; parent: NodeId | null; index: number; rootInfo?: RootInfo } // node.children must be [] ; insert subtrees as several inserts
  | { t: 'remove'; id: NodeId } // removes a LEAF; remove subtrees bottom-up (helpers do this)
  | { t: 'move'; id: NodeId; parent: NodeId | null; index: number; rootInfo?: RootInfo }
  | { t: 'set'; id: NodeId; patch: Partial<Omit<MapNode, 'id' | 'parent' | 'children'>> } // undefined value = delete key
  | { t: 'setRoot'; id: NodeId; info: RootInfo }
  | { t: 'link'; link: CrossLink; index?: number }
  | { t: 'unlink'; id: string }
  | { t: 'linkStyle'; id:string; style:LinkStyle }
  | { t: 'setLink'; id: string; label?: string }
  | { t: 'aiJob'; id: string; value?: AiJobRecord }
  | { t: 'docMeta'; patch: Partial<Pick<Doc, 'title' | 'themeId' | 'seed' | 'artStyleId' | 'themeSettings' | 'tagColors' | 'layoutPlacements' | 'markerMeanings'>> }
  | { t: 'presentation'; id: string; value?: Presentation; index?: number } // insert or replace by id; no value = delete
  | { t: 'canvas'; id: string; value?: CanvasElement; index?: number } // insert or replace by id; no value = delete; index = stacking position
  | { t: 'canvasMeta'; patch: Partial<Pick<CanvasState, 'bookmarks' | 'grid'>> };

/** A group of ops applied and undone together. */
export interface Transaction {
  ops: Op[];
  label: string; // shown in the Edit menu: "Undo Add Child"
  /** 'user' edits, or an AI job id. AI transactions are shown as AI changes. */
  source: 'user' | { ai: string };
}

/** Emitted after every applied transaction, undo or redo. */
export interface DocChange {
  doc: Doc;
  /** Ids whose subtree structure, text or size-affecting style changed (layout must rerun for their roots). */
  touched: Set<NodeId>;
  /** True if only non-geometric fields changed (note, tags, task). */
  cosmeticOnly: boolean;
  kind: 'apply' | 'undo' | 'redo' | 'load';
}

// ---------------------------------------------------------------- theme

/** blur is a Gaussian standard deviation in world units (as SVG feDropShadow stdDeviation). */
export interface ShadowSpec {
  dy: number;
  blur: number;
  opacity: number;
  /** Default '#1B2A3A'. */
  color?: string;
}

export interface CanvasSurface {
  /** Dot grid fixed to the world. Default spacing 24. */
  dots?: { color: string; opacity: number; spacing?: number };
  /** Top and bottom colours of a gradient fixed to the screen; replaces the flat background. */
  gradient?: [string, string];
  /** 0..1 darkening toward the screen corners. */
  vignette?: number;
}

/**
 * How branches are drawn. 'flat' (or absent) is the classic flat ribbon. The others are dimensional looks baked into
 * 2D geometry with fixed lighting (see core/geometry/relief.ts): 'clay' matte ropes, 'arcs' lifted glossy tubes.
 * 'rope' and 'quilling' are accepted and draw as 'clay' until they have looks of their own.
 */
export type BranchMaterial = 'flat' | 'clay' | 'arcs' | 'rope' | 'quilling';

export interface Theme {
  id: string;
  name: string;
  background: string;
  /** Colours for main branches, assigned in order around the root (one colour per main branch). */
  branchColors: string[];
  rootColor: string;
  rootFillColor?: string;
  nodeFillColor?: string;
  textColor: string;
  fontFamily: string;
  rootFontSize: number;
  mainFontSize: number; // depth 1
  fontSize: number; // depth >= 2
  rootShape: NodeShape;
  mainShape?: NodeShape;
  shape: NodeShape;
  branch: BranchStyle;
  /** Branch width where it leaves the root, and the minimum width at the tips. */
  rootBranchWidth: number;
  minBranchWidth: number;
  /** Horizontal gap between a parent and its children, and vertical gap between siblings. */
  levelGap: number;
  siblingGap: number;
  /** Text inside the image representation of labels: always drawn by the engine. */
  uppercaseMainBranches?: boolean; // Buzan preset
  curvedLabels?: boolean;
  fitBranchToLabel?: boolean;
  handDrawn?: boolean;
  canvasAppearance?: 'system' | 'light' | 'dark';
  connectionColor?: string;
  connectionDash?: 'solid' | 'dashed';
  colorMainBranches?: boolean;
  branchMarkers?: boolean;
  showGrid?: boolean;
  lean?: boolean;
  centralImage?: boolean;
  centralPalette?: boolean;
  singleCenter?: boolean;
  keywordHints?: boolean;
  keywordLabels?: boolean;
  landscapePrint?: boolean;
  // ---- Everyday themes (implementation spec 4.1). All optional; absent = the drawing before these existed.
  /** Label colour at depth >= 2. Default: textColor. */
  leafTextColor?: string;
  /** Label colour on a filled root. Default: chosen by readableInk. */
  rootTextColor?: string;
  /** Root outline colour. Default: rootColor. */
  rootStrokeColor?: string;
  /** Root corner radius in world units; 'pill' = half the height. Default: min(h / 2, 26). */
  rootRadius?: number | 'pill';
  /** Bold labels at depth 0 and depth 1. Default true. */
  rootBold?: boolean;
  mainBold?: boolean;
  /** Fill of 'box' nodes at depth >= 1: branch colour mixed into boxFillBase at this strength (0..1). Default 0.12. */
  boxFillStrength?: number;
  /** Colour the box fill is mixed into. Default: background. */
  boxFillBase?: string;
  /** Outline width of 'box' nodes at depth >= 1; 0 = no outline. Default 1.5. */
  boxStrokeWidth?: number;
  /** Corner radius of 'box' nodes at depth >= 1; 'pill' = half the height. */
  boxRadius?: number | 'pill';
  /** Soft shadow under filled node boxes at depth >= 1, and under the root. */
  nodeShadow?: ShadowSpec;
  rootShadow?: ShadowSpec;
  /** 0..1: branches and underlines at depth >= 2 use the branch colour mixed this far toward the background. */
  tipTint?: number;
  /** With tipTint: the root-to-main limb blends from the branch colour to the tinted colour along its length. */
  branchGradient?: boolean;
  /** Main branches leave the root from points spread along its facing edge instead of one point. */
  fanRootJoins?: boolean;
  /** Round caps at both ends of every limb and underline. */
  roundCaps?: boolean;
  /** Constant-width styles (line, rounded, angular): limbs leaving the root keep one width instead of narrowing from rootBranchWidth. */
  evenBranches?: boolean;
  /** Group heading in the theme picker. Default 'Classic'. */
  group?: string;
  /** Filled dot at the outer end of each leaf's line (depth >= 2, no visible children). */
  tipDots?: { radius: number; gap: number };
  /** Drawn over the background colour. */
  canvasSurface?: CanvasSurface;
  /** Dimensional branch look; absent = 'flat'. */
  branchMaterial?: BranchMaterial;
}

// ---------------------------------------------------------------- layout

export interface LayoutOptions {
  levelGap: number;
  siblingGap: number;
}

export interface NodeBox {
  id: NodeId;
  /** Centre of the node box, world coordinates, offsets already applied. */
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number; // 0 for roots
  /** -1 left of its root, 1 right, 0 for the root itself and for 'down' layouts. */
  side: -1 | 0 | 1;
  /** Direction from parent to this node for branch drawing: 'h' horizontal tree, 'v' vertical tree, 'r' radial. */
  flow: 'h' | 'v' | 'r';
  /** Index of the main branch (child of the root) this node belongs to; -1 for roots. Used for colour. */
  mainBranch: number;
}

export interface LayoutResult {
  /** Only VISIBLE nodes (descendants of collapsed nodes are absent). */
  boxes: Map<NodeId, NodeBox>;
  bounds: Rect;
}

// ---------------------------------------------------------------- geometry

/** 0..1. Every RGBA inside a Scene or Mesh is PREMULTIPLIED (blend with ONE, ONE_MINUS_SRC_ALPHA). */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Triangle mesh in world coordinates. */
export interface Mesh {
  /** World-space x,y pairs. Geometry builders keep doubles until the renderer subtracts the mesh origin. */
  positions: Float64Array | Float32Array;
  /** r,g,b,a per vertex (premultiplied alpha). Empty on a dimensional mesh, which keeps them in `relief.rgba`. */
  colors: Float32Array;
  indices: Uint32Array; // triangles
  gpuVertices?: { buffer: ArrayBuffer; ox: number; oy: number; wide: boolean };
  /** Dimensional shading (a branch material other than 'flat'); absent on flat meshes. */
  relief?: MeshRelief;
  /**
   * Flat branches expanded on the GPU (core/geometry/branch-instances.ts): one record per branch in place of
   * positions, colours and indices, which are then empty. `branchSpans.ends` counts the GPU chunk instances.
   */
  instances?: BranchInstances;
  /** Individual branch geometry, in submission order. */
  branchSpans?: {
    ids: NodeId[];
    bounds: Float64Array;
    ends: Uint32Array;
  };
}

/** Records of GPU-expanded branches (see core/geometry/branch-instances.ts for the layout). */
export interface BranchInstances {
  /** `words` 32-bit words per branch, padded to whole rows of the record texture. */
  records: Uint32Array;
  count: number;
  /** Words per record: INSTANCE_WORDS (flat) or RELIEF_WORDS ('clay', 'rope'). */
  words: number;
}

/**
 * Per-vertex data of a dimensional branch mesh, already in the form the GPU reads. The renderer shades it with a fixed
 * light and draws its shadow geometry into a soft shadow layer. Both share the mesh's indices, so culling one culls
 * the other.
 */
export interface MeshRelief {
  /** Look used for shading ('rope' and 'quilling' have their own; see core/geometry/relief.ts). */
  material: 'clay' | 'arcs' | 'rope' | 'quilling';
  /** Premultiplied colour per vertex as 4 x uint8 (r, g, b, a in memory order), in place of `Mesh.colors`. */
  rgba: Uint32Array;
  /**
   * 4 x int8 per vertex, read as value / 127: nx, ny = in-plane part of the unit surface normal in world axes (length 1
   * on a silhouette, 0 where the surface faces the viewer); the shadow strength 0..1 of the vertex's twin in `shadow`
   * ('rope': strength in 1/15 steps in the low 4 bits and the ply count, 0 for a plain surface, above them);
   * across = -1..1 across a ribbon (|across| = 1 on its edges and on the rim of a cap or bead), or 0..1 up a quilled
   * wall (1 on its top edge). The shadow fades out toward |across| = 1.
   */
  attribs: Int8Array;
  /** 2 x int16 per vertex: offset from the vertex to its twin in the shadow on the ground, in 1/128 world units. */
  shadow?: Int16Array;
  /** 'rope': twist phase per vertex in turns, continuous from a parent into its children. */
  twist?: Float32Array;
  /** Premultiplied colour of a fully dark shadow. */
  shadowColor: RGBA;
  /** Widest ribbon (or tallest wall) in world units: below about a screen pixel the renderer skips the shading. */
  maxWidth: number;
  /** Farthest a shadow lies from its geometry, world units: below a screen pixel the renderer skips the shadow pass. */
  shadowReach: number;
}

export interface BranchSpec {
  from: NodeId;
  to: NodeId;
  /** Start and end points in world coordinates. */
  p0: Vec2;
  p1: Vec2;
  /** Width at start and end. */
  w0: number;
  w1: number;
  color: RGBA;
  style: BranchStyle;
  flow: 'h' | 'v' | 'r';
  seed: number;
  /** For 'underline' nodes: the bar under the child's text continues from p1 to this point. */
  underlineTo?: Vec2;
  underlineWidth?: number;
  /** Upward rise of the terminal underline, in world units. */
  underlineBend?: number;
  // ---- Everyday themes (implementation spec 5.2). All optional; absent = the drawing before these existed.
  /**
   * Blend along the limb: at p1 the colour is `color` mixed `amount` (0..1) of the way toward `toward` (straight,
   * opaque). The end colour keeps `color`'s alpha, so scaling `color` (dimming) scales both ends. The underline,
   * end cap and tip dot use the end colour. See `branchEndColor` in core/geometry.
   */
  fade?: { toward: RGBA; amount: number };
  /** Smooth round caps: 'start' at p0 only, or 'both', adding one at the free end (the underline's far end, else p1). */
  roundCaps?: 'start' | 'both';
  /** 'h' and 'v' flows: the limb leaves p0 along this vector; first control point = p0 + startTangent * k, k = max(half the main-axis distance, 6). */
  startTangent?: Vec2;
  /** Filled dot in the end colour, centred `gap + radius` beyond the underline's far end, or on p1 when there is no underline. */
  tipDot?: { radius: number; gap: number };
  /** 'arcs' material: peak height of the limb above the page in world units (it rises from p0 and lands at p1). */
  lift?: number;
  /** 'arcs': false when a sibling limb already draws the plug at p0 (limbs leaving one point share one plug). */
  startPlug?: boolean;
  /** Opacity this branch is shown at when it is dimmed by mixing its colour toward the canvas; its shadow fades with it. */
  dim?: number;
  /** 'rope': twist phase (turns) where the branch starts, so the twist runs on from its parent. */
  twist?: number;
  /**
   * 'rope': a whipping binds the parent's bundle where it divides, at (x, y) where the parent ends, which runs along the
   * unit (dx, dy), `width` wide. Carried by the last limb leaving that point, so it is drawn over all of their starts.
   */
  whip?: { x: number; y: number; dx: number; dy: number; width: number };
  /** 'quilling': height of the paper wall in world units. */
  wall?: number;
  /** 'quilling': loops of paper round this root box (carried by one limb of the root), in the given colours, inside out. */
  ring?: { x: number; y: number; w: number; h: number; radius: number; colors: RGBA[] };
}

// ---------------------------------------------------------------- render scene

export interface LabelDraw {
  /** Exact word underlined by the active canvas filter. */
  highlightedWord?: string;
  /** Premultiplied side color for a dimensional label treatment. */
  extrusion?: RGBA;
  id: NodeId;
  opacity?: number;
  foldBadge?: boolean;
  /** Keep folded subtree titles readable when the map is viewed at overview scale. */
  overviewTitle?: boolean;
  /** This title replaces its picture at far zoom. */
  pictureTitle?: boolean;
  text: string;
  /** Centre of the text block in world coordinates. */
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  color: RGBA;
  /** Max width in world units before wrapping. */
  maxWidth: number;
  align: 'left' | 'center' | 'right';
  /** Align an explicitly styled label inside this width rather than its natural block. */
  alignWidth?: number;
  /** A shallow arch centred on the label, matching its branch underline. */
  curve?: { span: number; rise: number };
  /** Rotation in radians about (x, y); used by canvas element text. */
  angle?: number;
  /** Canvas element text: true = back band, drawn under the maps; false = front band, drawn after Scene.canvasFront; unset = map text. */
  underMaps?: boolean;
}

export interface RectDraw {
  wobble?: Vec2;
  branchBoundary?: boolean;
  nodeId?: NodeId;
  foldBadge?: boolean;
  pictureFrame?: boolean;
  x: number; // left, world
  y: number; // top, world
  w: number;
  h: number;
  radius: number;
  fill: RGBA;
  stroke?: RGBA;
  strokeWidth?: number; // world units
  /** Soft shadow under the rectangle; colour is premultiplied. */
  shadow?: { dy: number; blur: number; color: RGBA };
  /** Draw this rectangle after the branch mesh (a root that covers fanned branch starts). */
  overBranches?: boolean;
}

export interface ImageDraw {
  id: NodeId;
  /** URL the renderer can load (asset protocol URL or data/blob URL). */
  src: string;
  /** Generated SVG should rasterise at the current viewport resolution. */
  vector?: boolean;
  /** Low-resolution preview stored at ingestion. */
  previewSrc?: string;
  /** Screen-sized derivatives stored with the art. */
  previewSrcs?: ThumbnailLevels<string>;
  /** At overview scale the visible label replaces this picture. */
  overviewTitle?: boolean;
  /** Base64 ThumbHash decoded before the full image is ready. */
  thumbHash?: string;
  alt?: string;
  x: number; // centre
  y: number;
  w: number;
  h: number;
  opacity: number;
  /** Rotation in radians about the centre; used by canvas image elements. */
  angle?: number;
  /** Canvas element picture: true = back band, drawn under the maps; false = front band, drawn after Scene.canvasFront; unset = map picture. */
  underMaps?: boolean;
}

/** Everything the renderer draws, in world coordinates, back to front: rects, branches, images, labels, overlay. */
export interface Scene {
  background: RGBA;
  grid?: RGBA;
  rects: RectDraw[];
  branches: Mesh;
  animatedBranches?: Mesh;
  images: ImageDraw[];
  labels: LabelDraw[];
  /** Selection outlines, drop indicators and so on, drawn last. */
  overlay: RectDraw[];
  overlayMesh?: Mesh;
  ink?: import('./geometry/ink').InkDraw[];
  /** Drawn over the background colour: screen-fixed gradient and vignette, world-fixed dots. */
  surface?: { gradient?: [RGBA, RGBA]; vignette?: number; dots?: { color: RGBA; spacing: number } };
  /** Canvas elements under the maps: drawn after the surface, before rects. */
  canvasBack?: Mesh;
  /** Canvas elements over the maps: drawn after labels, before the overlay. */
  canvasFront?: Mesh;
  /** Dimensional themes: `rects` are drawn as raised tablets (a lit rim on the fill). */
  raisedRects?: boolean;
}

export interface CameraState {
  /** World point at the centre of the viewport. */
  cx: number;
  cy: number;
  zoom: number; // screen px per world unit
}

// ---------------------------------------------------------------- AI (front-end side)

/** One node line streamed by the model during map generation (decision D-08). */
export interface StreamNode {
  id: string; // model's id, e.g. "n7"; mapped to a real NodeId by the stream applier
  parent: string | null; // model id of the parent, or an existing real NodeId for expansions, or null for the root
  title: string;
  sourceHeading?: string;
  note?: string;
  imageHint?: string;
}

export interface StyleSheet {
  fontFamily?: string;
  warnings?: string[];
  /** Natural-language style request as typed by the user. */
  request: string;
  themeId?: string;
  palette?: string[];
  branch?: BranchStyle;
  shape?: NodeShape;
  layout?: LayoutKind;
  uppercaseMainBranches?: boolean;
  centralImage?: boolean;
  /** Base artwork preset used when no subtree override is selected. */
  artPresetId?: string;
  /** For picture and SVG subtrees. */
  medium?: string;
  mood?: string;
}

// ---------------------------------------------------------------- interchange

/** Plain tree used for import and export (Markdown, OPML, pasted outlines). core/model converts to and from Doc. */
export interface OutlineNode {
  text: string;
  note?: string;
  collapsed?: boolean;
  link?: string;
  interchange?: InterchangeMetadata;
  children: OutlineNode[];
}
