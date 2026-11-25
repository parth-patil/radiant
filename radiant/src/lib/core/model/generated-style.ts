import type { Doc, MapNode, NodeId, StyleSheet, Theme } from '../types';
import { ART_PRESET_IDS, BUZAN_ART_PRESET, BUZAN_BRANCH_COLORS } from '../art/styleSheet';
import { parseThemeSettings } from './theme-settings';

export const SHEET_FONTS = ['system-ui, sans-serif','Georgia, serif','Arial, sans-serif','"Courier New", monospace',
  // Everyday theme stacks (macOS system fonts; the browser falls back along each stack).
  '"Avenir Next", Avenir, system-ui, sans-serif','"Helvetica Neue", Helvetica, Arial, sans-serif',
  '"Arial Rounded MT Bold", "Arial Rounded MT", system-ui, sans-serif','Futura, "Avenir Next", system-ui, sans-serif',
  '"Gill Sans", "Gill Sans MT", system-ui, sans-serif','"DIN Alternate", "Helvetica Neue", system-ui, sans-serif'] as const;
export const SHEET_LAYOUTS = ['mindmap','right','left','down','radial'] as const;

export function parseGeneratedStyle(value:unknown):StyleSheet|undefined {
  if(!value || typeof value!=='object')return;
  const raw=value as Record<string,unknown>;
  if(typeof raw.request!=='string')return;
  const {branch,shape,uppercaseMainBranches,branchColors}=parseThemeSettings({...raw,branchColors:raw.palette}) ?? {};
  const sheet:StyleSheet={request:raw.request.slice(0,2000)};
  if(branch)sheet.branch=branch;
  if(shape)sheet.shape=shape;
  if(uppercaseMainBranches!==undefined)sheet.uppercaseMainBranches=uppercaseMainBranches;
  if(typeof raw.centralImage==='boolean')sheet.centralImage=raw.centralImage;
  if(typeof raw.artPresetId==='string'&&ART_PRESET_IDS.includes(raw.artPresetId))sheet.artPresetId=raw.artPresetId;
  if(branchColors?.length)sheet.palette=branchColors;
  if(SHEET_FONTS.some(font=>font===raw.fontFamily))sheet.fontFamily=String(raw.fontFamily);
  if(SHEET_LAYOUTS.some(layout=>layout===raw.layout))sheet.layout=raw.layout as StyleSheet['layout'];
  for(const key of ['medium','mood','themeId'] as const)if(typeof raw[key]==='string')sheet[key]=raw[key].slice(0,120);
  if(Array.isArray(raw.warnings))sheet.warnings=raw.warnings.filter((v):v is string=>typeof v==='string').slice(0,12).map(v=>v.slice(0,180));
  return sheet;
}

/** The theme state a node passes on to its children (see {@link themeScopes}). */
export interface ThemeScope { generated: Theme; preset?: string; resolved: Theme }

/**
 * The same resolution as {@link treeThemes}, top down: `step(parent, node)` gives a node's scope from its parent's
 * (undefined for a root). A node without its own generated style or art preset shares its parent's scope object, so
 * a walk down the tree resolves each node in O(1) and most nodes get the very theme object their parent has.
 */
export function themeScopes(doc: Doc, base: Theme) {
  const withBuzan = new WeakMap<Theme, Theme>();
  return (parent: ThemeScope | undefined, node: MapNode): ThemeScope => {
    const sheet = node.generatedStyle;
    if (parent && !sheet && !node.artStyleId && !node.artStyleIsland) return parent;
    let generated = parent?.generated ?? base;
    let preset = parent ? parent.preset : doc.artStyleId;
    if (sheet) generated = { ...generated, branchColors: sheet.palette ?? generated.branchColors,
      branch: sheet.branch ?? generated.branch, shape: sheet.shape ?? generated.shape, mainShape: sheet.shape ?? generated.mainShape,
      fontFamily: sheet.fontFamily ?? generated.fontFamily, centralImage: sheet.centralImage ?? generated.centralImage,
      uppercaseMainBranches: sheet.uppercaseMainBranches ?? generated.uppercaseMainBranches };
    if (node.artStyleId) preset = node.artStyleId;
    else if (node.artStyleIsland) preset = doc.artStyleId;
    let resolved = generated;
    if (preset === BUZAN_ART_PRESET && !generated.lean) {
      resolved = withBuzan.get(generated) ?? {
        ...generated, branch: 'organic', branchColors: BUZAN_BRANCH_COLORS, colorMainBranches: true,
        curvedLabels: true, keywordLabels: true, centralImage: true
      };
      withBuzan.set(generated, resolved);
    }
    return { generated, preset, resolved };
  };
}

/** Resolve each node once per layout or render pass, including detached/copied generated branches. */
export function treeThemes(doc:Doc,base:Theme) {
  const cached = new Map<NodeId, { generated: Theme; preset?: string; resolved: Theme }>();
  const withBuzan = new WeakMap<Theme, Theme>();
  return (id: NodeId): Theme => {
    const path: NodeId[] = [];
    let current: NodeId | null = id;
    while (current !== null && !cached.has(current)) {
      path.push(current);
      current = doc.nodes[current]?.parent ?? null;
    }
    const inherited = current !== null ? cached.get(current) : undefined;
    let generated = inherited?.generated ?? base;
    let preset = inherited ? inherited.preset : doc.artStyleId;
    for (let i = path.length - 1; i >= 0; i--) {
      const node = doc.nodes[path[i]];
      const sheet = node?.generatedStyle;
      if (sheet) generated = { ...generated, branchColors: sheet.palette ?? generated.branchColors,
        branch: sheet.branch ?? generated.branch, shape: sheet.shape ?? generated.shape, mainShape: sheet.shape ?? generated.mainShape,
        fontFamily: sheet.fontFamily ?? generated.fontFamily, centralImage: sheet.centralImage ?? generated.centralImage,
        uppercaseMainBranches: sheet.uppercaseMainBranches ?? generated.uppercaseMainBranches };
      if (node?.artStyleId) preset = node.artStyleId;
      else if (node?.artStyleIsland) preset = doc.artStyleId;
      let resolved = generated;
      if (preset === BUZAN_ART_PRESET && !generated.lean) {
        resolved = withBuzan.get(generated) ?? {
          ...generated, branch: 'organic', branchColors: BUZAN_BRANCH_COLORS, colorMainBranches: true,
          curvedLabels: true, keywordLabels: true, centralImage: true
        };
        withBuzan.set(generated, resolved);
      }
      cached.set(path[i], { generated, preset, resolved });
    }
    return cached.get(id)?.resolved ?? base;
  };
}
