/** Geometry: node sizes, branch specs, branch mesh, scene primitives, spatial queries. Pure TypeScript. */
export { parseColor, premultiply, premulCss, premulWithAlpha, luminance } from './color';
export {
  nodeSize,
  resolveNodeStyle,
  createStyleResolver,
  displayText,
  nodePadding,
  branchWidthAt,
  underlineThickness,
  MAX_TEXT_WIDTH,
  MAX_ROOT_TEXT_WIDTH
} from './style';
export type { FontSpec, MeasureFn, ResolvedNodeStyle, Padding, StyleResolver } from './style';
export { buildBranchSpecs, BranchSpecMemo, branchSeed, hashString } from './branches';
export type { BranchSpecEx } from './branches';
export { tessellateBranches } from './tessellate';
export { appendNodeOverlay, buildScene, SceneMemo, ACCENT_COLOR } from './scene';
export type { SceneInput } from './scene';
export { SpatialIndex } from './spatial';
export type { Direction } from './spatial';
export { visibleRect, cullScene } from './view';
export { canCurveText, canCurveUnderline, underlineOffset, underlineSlope } from './underline';
export { mixColor, mixRGBA } from './color';
export { BOX_RADIUS, boxCornerRadius, lineColor, nodeFill, tipDotInset } from './style';
export { fanJoin } from './branches';
export { branchEndColor, tipDotCenter, MESH_DETAIL_ZOOM } from './tessellate';
export { canvasSurface } from './scene';
export { sketchElement, sketchKey, sketchSvg, sketchPathData, clearSketchCache, elementPoints, elementCentre, drawWidth, PAINT_STROKE, PAINT_FILL, PAINT_SHADOW } from './sketch';
export type { ElementSketch, SketchPath, SketchPaint } from './sketch';
export { buildCanvasScene, canvasSvgFragments, resolveCanvasPoints, defaultBand, elementBand, elementFontFamily } from './canvas-scene';
export type { CanvasBand, CanvasItem, CanvasPicture, CanvasScene, CanvasSceneContext, CanvasSvgFragment } from './canvas-scene';
export { ElementIndex, elementBounds, elementHit, canvasHitTest } from './spatial';
export type { ElementHit } from './spatial';
