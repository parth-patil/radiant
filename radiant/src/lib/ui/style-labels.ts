import type { BranchMaterial, BranchStyle, NodeShape } from '../core/types';

export const shapeName: Record<NodeShape, string> = {
  box: 'Rounded rectangle', rectangle: 'Rectangle', square: 'Square', circle: 'Circle',
  underline: 'Underline', none: 'Text only'
};

export const branchName: Record<BranchStyle, string> = {
  tapered: 'Tapered', organic: 'Organic', line: 'Straight', rounded: 'Rounded', angular: 'Angular'
};

export const branchMaterialName: Record<BranchMaterial, string> = {
  flat: 'Flat', clay: 'Soft clay', arcs: 'Lifted arcs', rope: 'Rope', quilling: 'Paper quilling'
};
