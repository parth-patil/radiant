import { BUZAN_BRANCH_COLORS } from '../art/styleSheet';
import type { Theme } from '../types';

const SYSTEM_UI =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, system-ui, sans-serif';

/** Shared sizing defaults; individual themes override what they need. */
const BASE = {
  fontFamily: SYSTEM_UI,
  rootFontSize: 28,
  mainFontSize: 20,
  fontSize: 16,
  rootBranchWidth: 14,
  minBranchWidth: 2,
  levelGap: 56,
  siblingGap: 10,
  connectionColor: '#516070',
  connectionDash: 'dashed',
  colorMainBranches: true,
  centralImage: true,
  showGrid: false,
  fitBranchToLabel: true,
  lean: false
} as const;

const clean: Theme = {
  ...BASE,
  id: 'clean',
  name: 'Clean',
  background: '#FAFAF8',
  // Okabe-Ito based, adjusted for contrast on a light background; distinguishable under common colour blindness.
  branchColors: ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#D99A00', '#6A4C93', '#3AA0DC', '#7A7A1F'],
  rootColor: '#1F2933',
  textColor: '#1F2933',
  rootShape: 'box',
  shape: 'underline',
  branch: 'tapered'
};

const buzan: Theme = {
  ...BASE,
  id: 'buzan',
  name: 'Buzan strict',
  background: '#FFFDF6',
  branchColors: BUZAN_BRANCH_COLORS,
  rootColor: '#3E2723',
  textColor: '#2B2B2B',
  rootShape: 'none',
  shape: 'underline',
  branch: 'organic',
  rootBranchWidth: 22,
  minBranchWidth: 2.5,
  mainFontSize: 21,
  uppercaseMainBranches: true,
  curvedLabels: false,
  centralPalette: true,
  singleCenter: true,
  keywordHints: true,
  landscapePrint: true
};

const midnight: Theme = {
  ...BASE,
  id: 'midnight',
  name: 'Midnight',
  background: '#12151C',
  branchColors: ['#56B4E9', '#FF8A4C', '#2FD1A0', '#F08CC4', '#F5C04A', '#A98BE0', '#8FD8F7', '#C9C24D'],
  rootColor: '#E8ECF2',
  textColor: '#E8ECF2',
  rootShape: 'box',
  shape: 'underline',
  branch: 'tapered'
};

const ink: Theme = {
  ...BASE,
  id: 'ink',
  name: 'Ink',
  background: '#FBFBF9',
  // Monochrome greys; the single accent is the root.
  branchColors: ['#2B2B2B', '#555555', '#7A7A7A', '#3D3D3D', '#666666', '#8C8C8C', '#4A4A4A', '#707070'],
  rootColor: '#C2410C',
  textColor: '#1A1A1A',
  rootShape: 'box',
  shape: 'box',
  branch: 'line',
  rootBranchWidth: 4,
  minBranchWidth: 1.5
};

const relaxed: Theme = {
  ...buzan, id: 'buzan-relaxed', name: 'Buzan relaxed',
  uppercaseMainBranches: false, keywordHints: false, centralPalette: false, singleCenter: false,
  rootShape: 'box', rootBranchWidth: 17
};
const handDrawn: Theme = {
  ...clean, id: 'hand-drawn', name: 'Hand-drawn', background: '#FBF5E9',
  rootColor: '#493722', textColor: '#30271C', branch: 'organic', curvedLabels: true,
  mainShape: 'box', handDrawn: true,
  branchColors: ['#A4402A', '#315A75', '#637542', '#795275', '#8B5709', '#247371']
};
const outline: Theme = {
  ...clean, id: 'outline', name: 'Plain outline', background: '#FFFFFF',
  rootShape: 'none', shape: 'none', branch: 'angular', rootBranchWidth: 3, minBranchWidth: 1.5,
  colorMainBranches: false, centralImage: false, lean: true
};
/* ---- Everyday themes (implementation spec 5.1). Each has its own dark variant; the generic DARKS rule skips them. */
const daylight: Theme = {
  ...BASE,
  id: 'daylight',
  group: 'Everyday',
  name: 'Daylight',
  background: '#FBFAF6',
  textColor: '#17212B',
  leafTextColor: '#2B3743',
  rootColor: '#17212B',
  branchColors: ['#12A07C', '#E05C8E', '#7353E5', '#2B7DE9', '#F2672A'],
  fontFamily: '"Avenir Next", Avenir, system-ui, sans-serif',
  rootShape: 'box',
  shape: 'underline',
  branch: 'tapered',
  rootFillColor: '#FFFFFF',
  rootStrokeColor: '#E3E0D8',
  rootRadius: 'pill',
  rootShadow: { dy: 6, blur: 9, opacity: 0.18 },
  tipTint: 0.22,
  branchGradient: true,
  fanRootJoins: true,
  roundCaps: true,
  canvasSurface: { dots: { color: '#8A8170', opacity: 0.35 }, vignette: 0.06 }
};
const daylightDark: Theme = {
  ...daylight,
  background: '#171A1F',
  textColor: '#EEF1F5',
  leafTextColor: '#C9D1DB',
  rootColor: '#EEF1F5',
  connectionColor: '#9CAAC0',
  branchColors: ['#3DCBA6', '#F08AB1', '#A08CFF', '#62A8FF', '#FF9160'],
  rootFillColor: '#232831',
  rootStrokeColor: '#39414D',
  rootShadow: { dy: 6, blur: 9, opacity: 0.5, color: '#000000' },
  canvasSurface: { dots: { color: '#9AA5B5', opacity: 0.22 }, vignette: 0.25 }
};

const studio: Theme = {
  ...BASE,
  id: 'studio',
  group: 'Everyday',
  name: 'Studio',
  background: '#F4F4F2',
  textColor: '#1A1A1A',
  leafTextColor: '#3A3F47',
  rootColor: '#2952E3',
  branchColors: ['#3D4A5C', '#6B7A90', '#2952E3', '#52607A', '#7D8AA0'],
  fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  rootShape: 'box',
  shape: 'underline',
  branch: 'rounded',
  // Constant-width style: main limbs end at max(min, 0.58 * 0.85 * 8) ~ 3.9, leaf limbs ~ 2.3 (THM-01 targets 4 and 2).
  rootBranchWidth: 8,
  minBranchWidth: 2,
  evenBranches: true,
  rootFillColor: '#2952E3',
  rootTextColor: '#FFFFFF',
  rootRadius: 10,
  rootShadow: { dy: 5, blur: 6.5, opacity: 0.2 },
  fanRootJoins: true,
  roundCaps: true,
  tipDots: { radius: 3, gap: 4 }
};
const studioDark: Theme = {
  ...studio,
  background: '#17181B',
  textColor: '#F1F1EF',
  leafTextColor: '#C4C8CF',
  rootColor: '#3558E0',
  connectionColor: '#9CAAC0',
  branchColors: ['#9AA7BA', '#7F8CA3', '#6F8DFF', '#A9B4C6', '#8894AA'],
  rootFillColor: '#3558E0',
  rootTextColor: '#FFFFFF',
  rootShadow: { dy: 5, blur: 6.5, opacity: 0.5, color: '#000000' }
};

const sorbet: Theme = {
  ...BASE,
  id: 'sorbet',
  group: 'Everyday',
  name: 'Sorbet',
  background: '#FFF9F4',
  textColor: '#33313A',
  leafTextColor: '#4A4853',
  rootColor: '#33313A',
  branchColors: ['#4DABF7', '#FF8787', '#63C7A0', '#B197FC', '#FFA94D'],
  fontFamily: '"Arial Rounded MT Bold", "Arial Rounded MT", system-ui, sans-serif',
  rootBold: false,
  mainBold: false,
  mainFontSize: 19,
  rootShape: 'box',
  mainShape: 'box',
  shape: 'underline',
  branch: 'tapered',
  rootBranchWidth: 12,
  minBranchWidth: 3,
  rootFillColor: '#33313A',
  rootTextColor: '#FFFFFF',
  rootRadius: 'pill',
  rootShadow: { dy: 4, blur: 6.5, opacity: 0.13 },
  boxFillStrength: 0.28,
  boxFillBase: '#FFFFFF',
  boxStrokeWidth: 0,
  boxRadius: 'pill',
  nodeShadow: { dy: 4, blur: 6.5, opacity: 0.13 },
  tipTint: 0.1,
  fanRootJoins: true,
  roundCaps: true
};
const sorbetDark: Theme = {
  ...sorbet,
  background: '#201D24',
  textColor: '#F4F0F7',
  leafTextColor: '#D2CDD8',
  rootColor: '#F4F0F7',
  connectionColor: '#AE9B82',
  branchColors: ['#6BBBF9', '#FF9B9B', '#7AD4B0', '#C2ADFF', '#FFB868'],
  rootFillColor: '#F4F0F7',
  rootTextColor: '#201D24',
  rootShadow: { dy: 4, blur: 6.5, opacity: 0.45, color: '#000000' },
  boxFillStrength: 0.3,
  boxFillBase: '#201D24',
  nodeShadow: { dy: 4, blur: 6.5, opacity: 0.45, color: '#000000' }
};

const citrus: Theme = {
  ...BASE,
  id: 'citrus',
  group: 'Everyday',
  name: 'Citrus',
  background: '#FFFCF2',
  textColor: '#2B2118',
  rootColor: '#2B2118',
  branchColors: ['#F26B1D', '#D99A00', '#6F9A00', '#F0437A', '#00A6A6'],
  fontFamily: 'Futura, "Avenir Next", system-ui, sans-serif',
  mainFontSize: 17,
  uppercaseMainBranches: true,
  rootShape: 'box',
  shape: 'underline',
  branch: 'tapered',
  rootBranchWidth: 17,
  minBranchWidth: 4,
  rootFillColor: '#2B2118',
  rootTextColor: '#FFFCF2',
  rootRadius: 'pill',
  tipTint: 0.12,
  fanRootJoins: true,
  roundCaps: true
};
const citrusDark: Theme = {
  ...citrus,
  background: '#1E1812',
  textColor: '#FFF6E3',
  rootColor: '#FFF6E3',
  connectionColor: '#AE9B82',
  branchColors: ['#FF8A3D', '#F2B824', '#9BC53D', '#FF6F9C', '#2CC7C7'],
  rootFillColor: '#FFF6E3',
  rootTextColor: '#1E1812'
};

const lagoon: Theme = {
  ...BASE,
  id: 'lagoon',
  group: 'Everyday',
  name: 'Lagoon',
  background: '#F1F8F8',
  textColor: '#0F2B33',
  leafTextColor: '#24424B',
  rootColor: '#0F2B33',
  branchColors: ['#0E8388', '#2E6FB0', '#16A085', '#5B7DB1', '#0A9BBF'],
  fontFamily: '"Gill Sans", "Gill Sans MT", system-ui, sans-serif',
  rootShape: 'box',
  shape: 'underline',
  branch: 'tapered',
  rootFillColor: '#FFFFFF',
  rootStrokeColor: '#BFD9DC',
  rootRadius: 'pill',
  rootShadow: { dy: 5, blur: 6.5, opacity: 0.2 },
  tipTint: 0.25,
  branchGradient: true,
  fanRootJoins: true,
  roundCaps: true,
  canvasSurface: { gradient: ['#F4FAFA', '#DDEEF0'] }
};
const lagoonDark: Theme = {
  ...lagoon,
  background: '#0F2126',
  textColor: '#E6F4F5',
  leafTextColor: '#B9D3D6',
  rootColor: '#E6F4F5',
  connectionColor: '#9CAAC0',
  branchColors: ['#3FC1C6', '#6FA8E6', '#45CFAF', '#8FA9DB', '#3CC4E6'],
  rootFillColor: '#17313A',
  rootStrokeColor: '#2F5560',
  rootShadow: { dy: 5, blur: 6.5, opacity: 0.5, color: '#000000' },
  canvasSurface: { gradient: ['#12272D', '#0B1A1E'] }
};

const boardroom: Theme = {
  ...BASE,
  id: 'boardroom',
  group: 'Everyday',
  name: 'Boardroom',
  background: '#F5F6F8',
  textColor: '#1B2A41',
  rootColor: '#1B2A41',
  branchColors: ['#1B2A41', '#3A6EA5', '#2A9D8F', '#C4553A', '#6C757D'],
  fontFamily: '"DIN Alternate", "Helvetica Neue", system-ui, sans-serif',
  rootShape: 'box',
  mainShape: 'box',
  shape: 'none',
  branch: 'angular',
  // Constant-width style: main limbs end at ~3.2 and leaf limbs at the 2-unit minimum (THM-01 targets 3 and 2).
  rootBranchWidth: 6.5,
  minBranchWidth: 2,
  evenBranches: true,
  rootFillColor: '#1B2A41',
  rootTextColor: '#FFFFFF',
  rootRadius: 6,
  boxFillStrength: 0,
  boxStrokeWidth: 2.2,
  boxRadius: 5,
  roundCaps: true,
  tipDots: { radius: 2.6, gap: 0 }
};
const boardroomDark: Theme = {
  ...boardroom,
  background: '#14181F',
  textColor: '#E9EDF3',
  rootColor: '#E9EDF3',
  connectionColor: '#9CAAC0',
  branchColors: ['#B9C6DA', '#6FA3D8', '#4FC3B4', '#E58A70', '#A3ABB5'],
  rootFillColor: '#E9EDF3',
  rootTextColor: '#14181F'
};

/* ---- Dimensional themes: branch materials (core/geometry/relief.ts) with node styles tuned to match. */
const softClay: Theme = {
  ...BASE,
  id: 'soft-clay',
  group: 'Dimensional',
  name: 'Soft clay',
  branchMaterial: 'clay',
  background: '#F3EDE6',
  textColor: '#2F2B2B',
  leafTextColor: '#3F3838',
  rootColor: '#2F3443',
  branchColors: ['#EE6A60', '#4F8DE8', '#3CBF8C', '#A274E8', '#EDB53E', '#33B5C2'],
  fontFamily: '"Avenir Next", Avenir, system-ui, sans-serif',
  rootShape: 'box',
  mainShape: 'box',
  shape: 'box',
  branch: 'tapered',
  rootBranchWidth: 18,
  minBranchWidth: 6,
  rootFillColor: '#2F3443',
  rootStrokeColor: '#2F3443',
  rootTextColor: '#FFFFFF',
  rootRadius: 'pill',
  rootShadow: { dy: 5, blur: 7, opacity: 0.24 },
  boxFillStrength: 0.3,
  boxFillBase: '#FFFFFF',
  boxStrokeWidth: 0,
  boxRadius: 'pill',
  nodeShadow: { dy: 3, blur: 4.5, opacity: 0.2 },
  roundCaps: true
};
const softClayDark: Theme = {
  ...softClay,
  background: '#1F1C1B',
  textColor: '#F4EEE8',
  leafTextColor: '#DDD3CB',
  rootColor: '#ECE5DE',
  connectionColor: '#AE9B82',
  branchColors: ['#F2827A', '#6FA3F0', '#55CFA0', '#B38CF0', '#F0C25A', '#4CC5D0'],
  rootFillColor: '#ECE5DE',
  rootStrokeColor: '#ECE5DE',
  rootTextColor: '#1F1C1B',
  rootShadow: { dy: 5, blur: 7, opacity: 0.55, color: '#000000' },
  boxFillStrength: 0.34,
  boxFillBase: '#2B2725',
  nodeShadow: { dy: 3, blur: 4.5, opacity: 0.5, color: '#000000' }
};

const liftedArcs: Theme = {
  ...BASE,
  id: 'lifted-arcs',
  group: 'Dimensional',
  name: 'Lifted arcs',
  branchMaterial: 'arcs',
  background: '#ECEEF2',
  textColor: '#1F2A37',
  leafTextColor: '#334155',
  rootColor: '#2F3443',
  branchColors: ['#E0483F', '#3B7DDD', '#1E9E6E', '#7B50D6', '#DE9F1A', '#139DB0'],
  fontFamily: '"Avenir Next", Avenir, system-ui, sans-serif',
  rootShape: 'box',
  mainShape: 'box',
  shape: 'box',
  branch: 'rounded',
  rootBranchWidth: 4.5,
  minBranchWidth: 3,
  evenBranches: true,
  // Room for the limbs to rise and land; the shared 56 makes twig arcs into hooks. (Layout placements keep a theme's
  // gaps when switching away, as with any change of gaps.)
  levelGap: 84,
  siblingGap: 12,
  rootFillColor: '#3A3F4D',
  rootStrokeColor: '#3A3F4D',
  rootTextColor: '#FFFFFF',
  rootRadius: 9,
  rootShadow: { dy: 4, blur: 6, opacity: 0.24 },
  boxFillStrength: 0,
  boxFillBase: '#FFFFFF',
  boxStrokeWidth: 0,
  boxRadius: 6,
  nodeShadow: { dy: 2, blur: 3.5, opacity: 0.16 }
};
const liftedArcsDark: Theme = {
  ...liftedArcs,
  background: '#16181D',
  textColor: '#E8ECF2',
  leafTextColor: '#C9D1DB',
  rootColor: '#E8ECF2',
  connectionColor: '#9CAAC0',
  branchColors: ['#F2675F', '#5E9BF0', '#3CC28E', '#9A78EE', '#F0B83C', '#2FBCCE'],
  rootFillColor: '#E8ECF2',
  rootStrokeColor: '#E8ECF2',
  rootTextColor: '#16181D',
  rootShadow: { dy: 4, blur: 6, opacity: 0.55, color: '#000000' },
  boxFillBase: '#242833',
  nodeShadow: { dy: 2, blur: 3.5, opacity: 0.5, color: '#000000' }
};

/** Everyday themes with their designed dark variants, in picker order. */
const EVERYDAY: readonly (readonly [Theme, Theme])[] = [
  [daylight, daylightDark], [studio, studioDark], [sorbet, sorbetDark],
  [citrus, citrusDark], [lagoon, lagoonDark], [boardroom, boardroomDark]
];

const CLASSIC: readonly Theme[] = [clean, buzan, relaxed, handDrawn, outline, midnight, ink];
const rope: Theme = {
  ...BASE,
  id: 'rope',
  group: 'Dimensional',
  name: 'Rope',
  branchMaterial: 'rope',
  background: '#ECE7DF',
  textColor: '#2E2A26',
  leafTextColor: '#3B3631',
  rootColor: '#3A2F2A',
  branchColors: ['#E2574C', '#3E7BD6', '#2FA37A', '#8A5BD6', '#E3A72F', '#1F9DB0'],
  fontFamily: '"Avenir Next", Avenir, system-ui, sans-serif',
  rootShape: 'box',
  mainShape: 'underline',
  shape: 'underline',
  // Bundles as thick as the ideas they carry (minBranchWidth is one cord); see buildBranchSpecs.
  branch: 'rounded',
  rootBranchWidth: 16,
  minBranchWidth: 3.4,
  evenBranches: true,
  rootFillColor: '#3A2F2A',
  rootStrokeColor: '#3A2F2A',
  rootTextColor: '#FFFFFF',
  rootRadius: 'pill',
  rootShadow: { dy: 5, blur: 7, opacity: 0.26 },
  tipDots: { radius: 3.2, gap: 1.5 },
  // Rounded rope ends: their shadows end softly where a bundle divides under its whipping.
  roundCaps: true
};
const ropeDark: Theme = {
  ...rope,
  background: '#1D1A17',
  textColor: '#F3EDE6',
  leafTextColor: '#D9D0C6',
  rootColor: '#EDE4D8',
  connectionColor: '#AE9B82',
  branchColors: ['#F0776D', '#6A9CEB', '#4CC596', '#A882EE', '#F0BE52', '#3CBFD0'],
  rootFillColor: '#EDE4D8',
  rootStrokeColor: '#EDE4D8',
  rootTextColor: '#1D1A17',
  rootShadow: { dy: 5, blur: 7, opacity: 0.55, color: '#000000' }
};

const quilling: Theme = {
  ...BASE,
  id: 'paper-quilling',
  group: 'Dimensional',
  name: 'Paper quilling',
  branchMaterial: 'quilling',
  background: '#F1ECE4',
  textColor: '#2B2F3C',
  leafTextColor: '#363A47',
  rootColor: '#2B2F3C',
  branchColors: ['#C8202B', '#1D5FC0', '#139464', '#6A3FC4', '#E89B12', '#127F8C'],
  fontFamily: '"Avenir Next", Avenir, system-ui, sans-serif',
  rootShape: 'box',
  mainShape: 'underline',
  shape: 'underline',
  // Strips side by side: about one per 3 units of width (see core/geometry/quill.ts).
  branch: 'rounded',
  rootBranchWidth: 9,
  minBranchWidth: 3,
  evenBranches: true,
  rootFillColor: '#F7F4EE',
  rootStrokeColor: '#2B2F3C',
  rootTextColor: '#2B2F3C',
  rootRadius: 'pill',
  rootShadow: { dy: 4, blur: 6, opacity: 0.2 },
  // The scroll at each leaf tip sits in the room kept for a tip dot.
  tipDots: { radius: 8, gap: 4 }
};
const quillingDark: Theme = {
  ...quilling,
  background: '#1B1D22',
  textColor: '#ECEEF3',
  leafTextColor: '#CBD0DA',
  rootColor: '#ECEEF3',
  connectionColor: '#9CAAC0',
  branchColors: ['#E5484F', '#4F8BE6', '#2DB882', '#9070E6', '#F2B032', '#22A9B8'],
  rootFillColor: '#262A33',
  rootStrokeColor: '#ECEEF3',
  rootTextColor: '#ECEEF3',
  rootShadow: { dy: 4, blur: 6, opacity: 0.55, color: '#000000' }
};

/** Dimensional themes with their dark variants, in picker order. */
const DIMENSIONAL: readonly (readonly [Theme, Theme])[] = [
  [softClay, softClayDark], [liftedArcs, liftedArcsDark], [rope, ropeDark], [quilling, quillingDark]
];
const THEMES: readonly Theme[] = [...CLASSIC, ...EVERYDAY.map(([light]) => light), ...DIMENSIONAL.map(([light]) => light)];
const BY_ID = new Map<string, Theme>(THEMES.map((t) => [t.id, t]));
const warm = new Set(['buzan', 'buzan-relaxed', 'hand-drawn']);
const DARKS = new Map<string, Theme>(CLASSIC.map((theme) => [theme.id, {
  ...theme,
  background: warm.has(theme.id) ? '#242019' : '#11151D',
  textColor: warm.has(theme.id) ? '#F0E8DA' : '#E7EDF5',
  rootColor: warm.has(theme.id) ? '#E6BD8F' : '#D6E2F0',
  connectionColor: warm.has(theme.id) ? '#AE9B82' : '#9CAAC0',
  branchColors: theme.id === 'ink' ? ['#A5AFBE', '#C5CAD2', '#858F9E', '#E0E3EC'] : midnight.branchColors
} satisfies Theme]));
DARKS.set('midnight', { ...midnight, connectionColor: '#A7B4CA' });
for (const [light, dark] of [...EVERYDAY, ...DIMENSIONAL]) DARKS.set(light.id, dark);
const lightMidnight: Theme = { ...midnight, background: '#F0F3FA', rootColor: '#283F62', textColor: '#21334E', branchColors: clean.branchColors };

/** Id of the theme used for new documents. */
export const DEFAULT_THEME_ID = 'clean';

/** Look up a theme by id; unknown ids fall back to the default theme. */
export function getTheme(id: string, dark?: boolean): Theme {
  if (dark) return DARKS.get(id) ?? DARKS.get(DEFAULT_THEME_ID) ?? clean;
  if (dark === false && id === 'midnight') return lightMidnight;
  return BY_ID.get(id) ?? clean;
}

/** All registered themes, default first. */
export function listThemes(): Theme[] {
  return THEMES.slice();
}
