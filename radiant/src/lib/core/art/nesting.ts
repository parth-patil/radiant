import type { ArtStyleOverrides, Doc, NodeId, Op, Representation } from '../types';
import { effectiveRepresentation } from './representation';
import { artPreset } from './styleSheet';
import { artStyleAt, subtreeArtStyle } from './subtree-style';

type SetNode = Extract<Op, { t: 'set' }>;
type ArtNestingPlan = { error: string } | { changes: SetNode[]; islands: number };

/** Validate the new boundaries, including explicit islands already inside the edited subtree. */
export function planArtNesting(doc: Doc, changes: SetNode[], requested: Iterable<NodeId>): ArtNestingPlan {
  const changed = new Map(changes.map((op) => [op.id, op.patch.representation]));
  const explicitAt = (id: NodeId) => changed.has(id) ? changed.get(id) : doc.nodes[id]?.representation;
  const modeAt = (id: NodeId | null): Representation => {
    while (id !== null) {
      const mode = explicitAt(id);
      if (mode) return mode;
      id = doc.nodes[id]?.parent ?? null;
    }
    return 'vector';
  };
  const targets = new Set(requested);
  const boundaries = new Set([...targets, ...changed.keys()]);
  const visited = new Set<NodeId>();
  for (const id of changed.keys()) {
    const stack = [...doc.nodes[id].children];
    while (stack.length) {
      const child = stack.pop()!;
      if (visited.has(child)) continue;
      visited.add(child);
      if (explicitAt(child)) boundaries.add(child);
      else for (const id of doc.nodes[child].children) stack.push(id);
    }
  }

  const styles: SetNode[] = [];
  let islands = 0;
  for (const id of boundaries) {
    const parent = doc.nodes[id]?.parent;
    if (!parent) continue;
    const outer = modeAt(parent);
    const inner = modeAt(id);
    const unchanged = outer === effectiveRepresentation(doc, parent) && inner === effectiveRepresentation(doc, id);
    if (!targets.has(id) && unchanged) continue;
    if (outer === 'svg' && inner === 'picture') {
      return { error: 'Picture artwork cannot be nested inside an SVG subtree. Choose a scope that keeps picture artwork outside SVG subtrees.' };
    }
    if (outer === 'picture' && inner === 'svg') {
      const node = doc.nodes[id];
      if (node.artStyleIsland) {
        if (!unchanged) islands++;
        continue;
      }
      islands++;
      const style = artStyleAt(doc, id);
      if (node.artStyleId) {
        styles.push({ t: 'set', id, patch: {
          artStyleIsland: true, artStyleSheet: subtreeArtStyle(doc, { ...node, artStyleIsland: true }, style)
        } });
        continue;
      }
      const preset = artPreset(style.id);
      const artStyleOverrides: ArtStyleOverrides = {
        medium: style.medium, mood: style.mood, detail: style.detail, lineWeight: style.line.weight,
        background: style.background, seed: style.seed,
        ...(style.palette.source === 'custom' ? { palette: style.palette.accents } : {}),
        negative: style.negative.filter((rule) => !preset.negative.includes(rule))
      };
      const island = { artStyleIsland: true as const, artStyleId: style.id, artStyleOverrides };
      styles.push({ t: 'set', id, patch: {
        ...island, artStyleSheet: subtreeArtStyle(doc, { ...node, ...island }, style)
      } });
    }
  }
  return { changes: [...changes, ...styles], islands };
}
