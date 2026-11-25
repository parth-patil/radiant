import type { Rect } from '../types';
import { parseColor, rgbToHex } from './color';
import { parseSvg, svgElementText, SVG_REGION_SIZE, validateSvg, viewBoxOf, type SvgEl, type SvgNeighbour, type SvgNodeSpec, type SvgSubtreeRequest } from './svg';

export interface SvgRegionSpec {
  id: string;
  box: Rect;
  parentId: string | null;
  hasChildren: boolean;
  parent?: SvgNeighbour;
  children?: SvgNeighbour[];
  legacyAnchors?: true;
}

export interface SvgRegionAsset {
  assetHash: string;
  nodes: SvgRegionSpec[];
  palette: string[];
}

export function regionSpecs(nodes: SvgNodeSpec[]): SvgRegionSpec[] {
  const parents = new Set(nodes.map(node => node.parentId));
  return nodes.map(node => ({
    id: node.id, box: node.box, parentId: node.parentId,
    hasChildren: !!node.children?.length || parents.has(node.id), parent: node.parent, children: node.children
  }));
}

const elements = (root: SvgEl) => root.children.filter((child): child is SvgEl => typeof child !== 'string');
function rootOf(source: string): SvgEl {
  const parsed = parseSvg(source);
  if (parsed.hadDoctype || parsed.errors.length || parsed.root?.name !== 'svg' ||
      parsed.root.attrs.xmlns !== 'http://www.w3.org/2000/svg') throw new Error('The stored SVG could not be read.');
  return parsed.root;
}

export function checkedSvgRegion(
  root: SvgEl, nodes: SvgRegionSpec[], palette: string[], style: SvgSubtreeRequest['style']
): string {
  if (!nodes.length || nodes.length > SVG_REGION_SIZE || !Array.isArray(palette) ||
      !palette.every(colour => typeof colour === 'string') ||
      new Set(nodes.map(node => node.id)).size !== nodes.length ||
      nodes.some(node => typeof node.id !== 'string' || !node.box ||
        ![node.box.x, node.box.y, node.box.w, node.box.h].every(Number.isFinite) || node.box.w <= 0 || node.box.h <= 0)) {
    throw new Error('The stored SVG region contract is invalid.');
  }
  const requested = nodes.map(node => ({
    ...node, text: '', children: node.children?.length ? node.children : node.hasChildren ? [{ id: '', text: '' }] : undefined
  }));
  const { x, y, w, h } = viewBoxOf(requested);
  const source = svgElementText({ ...root, attrs: {
    xmlns: 'http://www.w3.org/2000/svg', viewBox: [x, y, w, h].join(' ')
  } });
  const report = validateSvg(source, { nodes: requested, palette, style });
  const invalid = report.issues.find(issue => issue.severity === 'error' &&
    !(issue.nodeId && (issue.code === 'anchor-off-edge' || issue.code === 'anchor-side') &&
      nodes.some(node => node.id === issue.nodeId && node.legacyAnchors)));
  if (invalid) throw new Error('The complete SVG region could not be validated. ' + invalid.message);
  return source;
}

/** Canonical region with one copy of each shared definition block. */
export function joinSvgGroups(wrappers: Iterable<string>): SvgEl {
  const defs = new Map<string, SvgEl>();
  const groups: SvgEl[] = [];
  for (const wrapper of wrappers) {
    for (const child of elements(rootOf(wrapper))) {
      if (child.name === 'defs') defs.set(svgElementText(child), child);
      else if (child.name === 'g') groups.push(child);
    }
  }
  return { name: 'svg', attrs: {}, children: [...defs.values(), ...groups] };
}

export function legacySvgSpec(source: string, id: string): SvgRegionSpec | undefined {
  const root = rootOf(source);
  const group = elements(root).find(el => el.name === 'g' && el.attrs.id === 'node-' + id);
  const values = (root.attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (!group || values.length !== 4 || !values.every(Number.isFinite) || values[2] <= 0 || values[3] <= 0) return;
  const [x, y, w, h] = values;
  return { id, box: { x, y, w, h }, parentId: null, hasChildren: 'data-anchor-out' in group.attrs, legacyAnchors: true };
}

export function existingSvgColours(root: SvgEl): string[] {
  const colours = new Set(['#000000']);
  function visit(node: SvgEl): void {
    for (const key of ['fill', 'stroke', 'stop-color', 'color']) {
      const value = node.attrs[key];
      const paint = value && parseColor(value);
      if (paint) colours.add(rgbToHex(paint));
    }
    for (const child of elements(node)) visit(child);
  }
  visit(root);
  return [...colours];
}

export function moveSvgSpec(spec: SvgRegionSpec, box: Rect): SvgRegionSpec {
  const dx = box.x - spec.box.x, dy = box.y - spec.box.y;
  const move = (point?: { x: number; y: number }) => point && { x: point.x + dx, y: point.y + dy };
  const neighbour = (n: SvgNeighbour): SvgNeighbour => ({
    ...n, centre: move(n.centre), anchorIn: move(n.anchorIn), anchorOut: move(n.anchorOut)
  });
  return { ...spec, box, parent: spec.parent && neighbour(spec.parent), children: spec.children?.map(neighbour) };
}

/** Replace exactly one canonical group, keeping shared definitions and the other groups intact. */
export function spliceSvgGroup(region: string, replacement: string, previous: SvgRegionSpec, next: SvgRegionSpec): SvgEl {
  const root = rootOf(region);
  const fragment = rootOf(replacement);
  const id = 'node-' + previous.id;
  const index = root.children.findIndex(child => typeof child !== 'string' && child.name === 'g' && child.attrs.id === id);
  const group = elements(fragment).find(el => el.name === 'g' && el.attrs.id === id);
  if (index < 0 || !group) throw new Error('The SVG region is missing the group to replace.');

  const occupied = new Set<string>();
  function collect(element: SvgEl): void {
    if (element.attrs.id) occupied.add(element.attrs.id);
    for (const child of elements(element)) collect(child);
  }
  collect(root);
  const renamed = new Map<string, string>();
  function reserve(element: SvgEl): void {
    const original = element.attrs.id;
    if (element !== group && original) {
      if (renamed.has(original)) throw new Error('The replacement SVG uses a duplicate element ID.');
      let name = 'splice-' + original;
      while (occupied.has(name)) name = 'splice-' + name;
      renamed.set(original, name);
      occupied.add(name);
    }
    for (const child of elements(element)) reserve(child);
  }
  reserve(fragment);
  function rewrite(element: SvgEl): void {
    for (const [key, value] of Object.entries(element.attrs)) {
      if (key === 'id' && element !== group) element.attrs[key] = renamed.get(value) ?? value;
      else if ((key === 'href' || key === 'xlink:href') && value.trim().startsWith('#')) {
        const id = value.trim().slice(1);
        element.attrs[key] = '#' + (renamed.get(id) ?? id);
      } else element.attrs[key] = value.replace(/url\(\s*(['"]?)#([^\s)'"]+)\1\s*\)/gi, (match, _quote, name) =>
        renamed.has(name) ? 'url(#' + renamed.get(name) + ')' : match);
    }
    for (const child of elements(element)) rewrite(child);
  }
  rewrite(fragment);

  const dx = previous.box.x - next.box.x, dy = previous.box.y - next.box.y;
  if (dx || dy) {
    group.attrs.transform = ('translate(' + dx + ' ' + dy + ') ' + (group.attrs.transform ?? '')).trim();
    for (const key of ['data-anchor-in', 'data-anchor-out']) {
      if (!group.attrs[key]) continue;
      const [x, y] = group.attrs[key].split(/[\s,]+/).map(Number);
      group.attrs[key] = (x + dx) + ',' + (y + dy);
    }
  }
  group.children.unshift(...elements(fragment).filter(el => el.name === 'defs'));
  root.children[index] = group;
  return root;
}
