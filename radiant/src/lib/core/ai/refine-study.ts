import { subtreeIds } from '../model';
import type { Doc, NodeId, Op } from '../types';

export function createStudyBlanks(doc: Doc, root: NodeId, percent: number, allowed?: ReadonlySet<NodeId>): Op[] {
  const ids = subtreeIds(doc, root).filter(id => !allowed || allowed.has(id));
  const candidates = ids.filter((id) => id !== root && doc.nodes[id].text.trim() && doc.nodes[id].blankAnswer === undefined);
  const share = Math.max(1, Math.min(90, Number.isFinite(percent) ? percent : 35));
  const count = Math.min(candidates.length, Math.round(ids.length * share / 100));
  // Spread the blanks through the branch in tree order.
  const chosen = Array.from({ length: count }, (_, index) => candidates[Math.floor((index + 0.5) * candidates.length / count)]);
  return chosen.map((id) => ({ t: 'set', id, patch: { text: '', blankAnswer: doc.nodes[id].text } }));
}

export function fillStudyBlank(doc: Doc, id: NodeId, reveal: boolean): Op | null {
  const node = doc.nodes[id];
  if (node?.blankAnswer === undefined) return null;
  return { t: 'set', id, patch: { text: reveal ? node.blankAnswer : node.text, blankAnswer: undefined } };
}

export function checkStudyAnswer(guess: string, answer: string): boolean {
  const normalise = (text: string) => text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return normalise(guess) === normalise(answer);
}
