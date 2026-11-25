import type {
  Doc,
  ImageDraw,
  LabelDraw,
  LayoutResult,
  Mesh,
  NodeBox,
  NodeId,
  NodeShape,
  Rect,
  RectDraw,
  RGBA,
  Scene,
  Theme,
  Vec2
} from '../types';
import { outlineWobble } from './hand-drawn';
import { readableInk, parseColor, premulCss, premulWithAlpha } from './color';
import { reliefMaterial } from './relief';
import { BOX_RADIUS, boxCornerRadius, createStyleResolver, displayText, MAX_ROOT_TEXT_WIDTH, MAX_TEXT_WIDTH, nodeFill, nodePadding, underlineThickness } from './style';

export interface SceneInput {
  doc: Doc;
  layout: LayoutResult;
  theme: Theme;
  measureFont?: never;
  selection: Set<NodeId>;
  focus: NodeId | null;
  /** Node being edited: its label is skipped (the UI draws an HTML text field). */
  editing: NodeId | null;
  hover: NodeId | null;
  /** Branch mesh from `tessellateBranches`. */
  branches: Mesh;
  /** Picture URLs by node. */
  images?: Map<NodeId, string>;
  nodeOpacity?: (id: NodeId) => number;
}

/** Selection / focus / hover accent colour (CSS). */
export const ACCENT_COLOR = '#3b82f6';
const FOLD_BADGE_RADIUS = 8;

/**
 * Dim an opaque colour by mixing it toward the (opaque) background instead of lowering its alpha, so overlapping
 * dimmed geometry does not blend twice. Translucent colours and full opacity keep the plain alpha scaling.
 */
export function dimOpaque(color: RGBA, opacity: number, background: RGBA): RGBA {
  if (opacity >= 1) return color;
  if (color.a < 1 || background.a < 1) return { r: color.r * opacity, g: color.g * opacity, b: color.b * opacity, a: color.a * opacity };
  const o = Math.max(0, opacity), k = 1 - o;
  return { r: color.r * o + background.r * k, g: color.g * o + background.g * k, b: color.b * o + background.b * k, a: 1 };
}

/** Where fold controls attach to a node: the point on its outward edge and the outward direction. */
export function foldAnchor(box: NodeBox, shape: NodeShape, theme: Theme): Vec2 & { dx: number; dy: number } {
  const side = box.side === -1 ? -1 : 1;
  if (box.flow === 'v') return { x: box.x, y: box.y + side * box.h / 2, dx: 0, dy: side };
  return {
    x: box.x + side * box.w / 2,
    y: shape === 'underline' && box.depth > 0 ? box.y + box.h / 2 - underlineThickness(box.depth, theme) / 2 : box.y,
    dx: side, dy: 0
  };
}

function foldBadgeCenter(box: NodeBox, shape: NodeShape, theme: Theme, halfWidth: number): Vec2 {
  const at = foldAnchor(box, shape, theme);
  return { x: at.x + at.dx * (halfWidth + 3), y: at.y + at.dy * (FOLD_BADGE_RADIUS + 3) };
}
const CLEAR: RGBA = { r: 0, g: 0, b: 0, a: 0 };
/** Default shadow colour (theme `ShadowSpec.color`). */
const SHADOW_COLOR = '#1B2A3A';

/** Theme `canvasSurface` as scene data (premultiplied colours); undefined when the theme has none. */
export function canvasSurface(theme: Theme): Scene['surface'] {
  const source = theme.canvasSurface;
  if (!source || theme.lean) return;
  const surface: NonNullable<Scene['surface']> = {};
  if (source.gradient) surface.gradient = [premulCss(source.gradient[0]), premulCss(source.gradient[1])];
  if (source.vignette !== undefined && source.vignette > 0) surface.vignette = Math.min(1, source.vignette);
  if (source.dots && source.dots.opacity > 0) {
    surface.dots = { color: premulCss(source.dots.color, Math.min(1, source.dots.opacity)), spacing: source.dots.spacing ?? 24 };
  }
  return surface.gradient || surface.vignette !== undefined || surface.dots ? surface : undefined;
}

function countHidden(doc: Doc, id: NodeId): number {
  let n = 0;
  const stack: NodeId[] = [...(doc.nodes[id]?.children ?? [])];
  while (stack.length) {
    const c = doc.nodes[stack.pop() as NodeId];
    if (!c) continue;
    n++;
    for (const k of c.children) stack.push(k);
  }
  return n;
}

function inflate(b: NodeBox, by: number, radius: number, extra: Partial<RectDraw>): RectDraw {
  return {
    x: b.x - b.w / 2 - by,
    y: b.y - b.h / 2 - by,
    w: b.w + by * 2,
    h: b.h + by * 2,
    radius,
    fill: CLEAR,
    ...extra
  };
}

/** Node outlines are drawn above labels, so keep their interiors transparent. */
export function appendNodeOverlay(
  overlay: RectDraw[], box: NodeBox, selection: Set<NodeId>, focus: NodeId | null, hover: NodeId | null
): void {
  const id = box.id;
  const sel = selection.has(id);
  if (id === hover && !sel) {
    overlay.push(
      inflate(box, 2, BOX_RADIUS + 2, {
        stroke: premulCss(ACCENT_COLOR, 0.5),
        strokeWidth: 1
      })
    );
  }
  if (sel) {
    overlay.push(
      inflate(box, 3, BOX_RADIUS + 3, {
        stroke: premulCss(ACCENT_COLOR),
        strokeWidth: 2
      })
    );
  }
  if (id === focus) {
    overlay.push(
      inflate(box, 6, BOX_RADIUS + 6, { stroke: premulCss(ACCENT_COLOR, 0.55), strokeWidth: 1.5 })
    );
  }
}

function extrudedSide(branch: RGBA, face: RGBA, background: RGBA, opacity: number): RGBA {
  const distance = Math.hypot(branch.r - face.r, branch.g - face.g, branch.b - face.b);
  if (distance >= 0.25) return premulWithAlpha(branch, 0.85 * opacity);
  const midtone = (a: number, b: number) => (a + b) / 2;
  return premulWithAlpha({
    r: midtone(branch.r, background.r), g: midtone(branch.g, background.g),
    b: midtone(branch.b, background.b), a: branch.a
  }, 0.85 * opacity);
}

/** Calculate enclosing shapes from the visible boxes, so a fold shrinks its boundary. */
function branchBoundaries(input: SceneInput, styles: ReturnType<typeof createStyleResolver>, marked: NodeBox[]): RectDraw[] {
  const { doc, layout } = input;
  const boxes = [...layout.boxes.values()];
  const extents = new Map<NodeId, Rect>();
  for (let index = boxes.length - 1; index >= 0; index--) {
    const box = boxes[index];
    const own = { x: box.x - box.w / 2, y: box.y - box.h / 2, w: box.w, h: box.h };
    const child = extents.get(box.id);
    const x = Math.min(own.x, child?.x ?? own.x), y = Math.min(own.y, child?.y ?? own.y);
    const right = Math.max(own.x + own.w, child ? child.x + child.w : -Infinity);
    const bottom = Math.max(own.y + own.h, child ? child.y + child.h : -Infinity);
    const bounds = { x, y, w: right - x, h: bottom - y };
    extents.set(box.id, bounds);
    const parent = doc.nodes[box.id]?.parent;
    if (!parent || !layout.boxes.has(parent)) continue;
    const existing = extents.get(parent);
    if (!existing) extents.set(parent, bounds);
    else {
      const x = Math.min(bounds.x, existing.x), y = Math.min(bounds.y, existing.y);
      extents.set(parent, {
        x, y, w: Math.max(right, existing.x + existing.w) - x,
        h: Math.max(bottom, existing.y + existing.h) - y
      });
    }
  }
  return marked.map(box => {
    const bounds = extents.get(box.id)!;
    const color = styles.get(box.id, box.depth, box.mainBranch).color;
    const opacity = input.nodeOpacity?.(box.id) ?? 1;
    const pad = 16;
    return {
      nodeId: box.id, branchBoundary: true, x: bounds.x - pad, y: bounds.y - pad,
      w: bounds.w + pad * 2, h: bounds.h + pad * 2,
      radius: Math.min(36, (Math.min(bounds.w, bounds.h) + pad * 2) / 2),
      fill: premulCss(color, opacity * 0.08), stroke: premulCss(color, opacity * 0.44), strokeWidth: 1.6
    };
  });
}

/**
 * Node rects and labels of the previous scene of one layout, by node, with the box they were drawn for. Pass the same
 * memo to consecutive builds of the same map (see {@link buildScene}).
 */
export class SceneMemo {
  readonly entries = new Map<NodeId, { box: NodeBox; rect?: RectDraw; label?: LabelDraw }>();
  editing: NodeId | null = null;
}

/**
 * Build the renderer Scene. All colours in the Scene are PREMULTIPLIED alpha.
 *
 * Label placement: `x`,`y` are the centre of the text block; the block lies inside the box, above the
 * underline bar for 'underline' nodes. `maxWidth` is the box width minus padding (+1 for rounding slack),
 * so text wraps exactly as it did when `nodeSize` measured it. Alignment: 'center' for roots and boxes,
 * 'left' / 'right' on the right / left side for underline and bare text.
 *
 * `memo` (a build with no selection, focus, hover, pictures or dimming): a node whose box is the same object as in
 * the previous build, which is not in `memo.dirty` (nodes whose style or content may have changed since), and which
 * is neither folded, a branch boundary nor being edited now or then, keeps its rect and label objects. With
 * `memo.dirty` null every node is drawn again (and remembered).
 */
export function buildScene(input: SceneInput, memo?: { scene: SceneMemo; dirty: ReadonlySet<NodeId> | null }): Scene {
  const { doc, layout, theme, selection, focus, editing, hover } = input;
  const res = createStyleResolver(doc, theme);
  const rects: RectDraw[] = [];
  const boundaryRoots: NodeBox[] = [];
  const labels: LabelDraw[] = [];
  const images: ImageDraw[] = [];
  const overlay: RectDraw[] = [];
  const backdrop = premulCss(theme.background);
  // Clay tablets are thicker than the ropes, so the ropes tuck under them.
  const tablets = !theme.lean && reliefMaterial(theme.branchMaterial) === 'clay';

  const entries = memo?.scene.entries;
  const dirty = memo?.dirty;
  const wasEditing = memo?.scene.editing;
  if (memo) {
    if (!dirty) entries!.clear();
    memo.scene.editing = editing;
  }
  for (const [id, box] of layout.boxes) {
    const node = doc.nodes[id];
    if (!node) continue;
    const reusable = !!entries && !node.collapsed && !node.style?.branchBoundary && id !== editing;
    if (reusable && dirty && id !== wasEditing && !dirty.has(id)) {
      const entry = entries!.get(id);
      if (entry?.box === box) {
        if (entry.rect) rects.push(entry.rect);
        if (entry.label) labels.push(entry.label);
        continue;
      }
    }
    const rectCount = rects.length, labelCount = labels.length;
    const st = res.get(id, box.depth, box.mainBranch);
    const opacity = input.nodeOpacity?.(id) ?? 1;
    const col = parseColor(st.color);
    if (!theme.lean && node.style?.branchBoundary) boundaryRoots.push(box);
    const pad = nodePadding(box.depth, st.shape, theme, node.style?.branchWidth);
    const side = box.side !== 0 ? box.side : 1;

    if (st.shape !== 'none' && st.shape !== 'underline') {
      const local = res.themeFor(id);
      const radius = st.shape === 'circle' ? Math.min(box.w, box.h) / 2 :
        st.shape === 'box' ? boxCornerRadius(box.depth, box.w, box.h, local) : 0;
      const filled = nodeFill(local, box.depth, st.color, st.emphasis, st.fillColor);
      const fill = filled.alpha === 1 ? dimOpaque(premulCss(filled.color), opacity, backdrop) : premulWithAlpha(col, filled.alpha * opacity);
      const root = box.depth === 0;
      const boxStroke = root ? undefined : local.boxStrokeWidth;
      const strokeWidth = root || st.emphasis === 2 ? Math.max(2.5, boxStroke ?? 0) : boxStroke ?? 1.5;
      const rect: RectDraw = {
        nodeId: id, x: box.x - box.w / 2, y: box.y - box.h / 2, w: box.w, h: box.h, radius, fill,
        wobble: local.handDrawn ? outlineWobble(doc.seed, id, box.w, box.h) : undefined,
        stroke: dimOpaque(root && local.rootStrokeColor && !node.style?.color ? premulCss(local.rootStrokeColor) : premulWithAlpha(col, 1), opacity, backdrop),
        strokeWidth
      };
      if (boxStroke === 0) {
        delete rect.stroke;
        delete rect.strokeWidth;
      }
      // Fanned joins start just inside the root outline; the root then covers their start caps (THM-17).
      if ((root && local.fanRootJoins && doc.rootInfo[id]?.layout !== 'timeline') || tablets) rect.overBranches = true;
      const shadow = root ? local.rootShadow : local.nodeShadow;
      if (shadow && shadow.opacity > 0) {
        rect.shadow = { dy: shadow.dy, blur: shadow.blur, color: premulCss(shadow.color ?? SHADOW_COLOR, shadow.opacity * opacity) };
      }
      rects.push(rect);
    }

    const src = input.images?.get(id);
    if (src) images.push({ id, src, x: box.x, y: box.y, w: box.w, h: box.h, opacity });

    // label
    if (id !== editing && (node.text.length > 0 || (node.sticker && !theme.lean) || (theme.branchMarkers && box.depth === 1))) {
      const innerH = box.h - pad.t - pad.b;
      const underlineLike = st.shape === 'underline' || (st.shape === 'none' && box.depth > 0);
      labels.push({
        id,
        text: displayText(node, box.depth, res.themeFor(id), box.mainBranch),
        overviewTitle: !!node.collapsed && node.children.length > 0,
        x: box.x,
        y: box.y - box.h / 2 + pad.t + innerH / 2,
        fontSize: st.font.size,
        fontFamily: st.font.family,
        bold: st.font.bold,
        italic: st.font.italic,
        color: premulCss(st.textColor, opacity),
        extrusion: !theme.lean && node.style?.extrudedLabel
          ? extrudedSide(col, parseColor(st.textColor), parseColor(theme.background), opacity) : undefined,
        maxWidth: Math.min((box.depth === 0 ? MAX_ROOT_TEXT_WIDTH : MAX_TEXT_WIDTH) + 1, box.w - pad.l - pad.r + 1),
        align: st.alignment ?? (underlineLike && box.flow === 'h' ? (side === 1 ? 'left' : 'right') : 'center'),
        alignWidth: st.alignment ? box.w - pad.l - pad.r : undefined
      });
    }

    // collapsed indicator
    if (node.collapsed && node.children.length > 0) {
      const text = String(countHidden(doc, id));
      const r = FOLD_BADGE_RADIUS;
      const width = Math.max(r * 2, text.length * 6 + 5);
      const { x: ex, y: ey } = foldBadgeCenter(box, st.shape, theme, width / 2);
      rects.push({ nodeId: id, foldBadge: true, x: ex - width / 2, y: ey - r, w: width, h: r * 2, radius: r, fill: dimOpaque(premulWithAlpha(col, 1), opacity, backdrop) });
      labels.push({
        id,
        foldBadge: true,
        text,
        x: ex,
        y: ey,
        fontSize: 9,
        fontFamily: theme.fontFamily,
        bold: true,
        italic: false,
        color: premulCss(readableInk('#ffffff',theme.background,st.color), opacity),
        maxWidth: width,
        align: 'center'
      });
    }

    appendNodeOverlay(overlay, box, selection, focus, hover);
    if (reusable) entries!.set(id, { box, rect: rects.length > rectCount ? rects[rectCount] : undefined, label: labels.length > labelCount ? labels[labelCount] : undefined });
    else entries?.delete(id);
  }
  if (entries && entries.size > layout.boxes.size * 2 + 200) {
    for (const id of [...entries.keys()]) if (!layout.boxes.has(id)) entries.delete(id);
  }

  const scene: Scene = {
    background: premulCss(theme.background),
    grid: theme.showGrid && !theme.lean ? premulCss(theme.textColor, 0.18) : undefined,
    rects: boundaryRoots.length ? [...branchBoundaries(input, res, boundaryRoots), ...rects] : rects,
    branches: input.branches,
    images,
    labels,
    overlay
  };
  const surface = canvasSurface(theme);
  if (surface) scene.surface = surface;
  if (tablets) scene.raisedRects = true;
  return scene;
}
