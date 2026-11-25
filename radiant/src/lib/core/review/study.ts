import { checkStudyAnswer } from '../ai/refine-study';
import type { Doc, NodeId } from '../types';
import { reviewNodes } from './index';

export type StudyKind = 'nodes' | 'connections';
export interface StudyItem {
  id: string;
  cue: string;
  answer: string;
}
export interface StudyProgress {
  percent: number;
  streak: number;
}

export const initialStudyProgress = { percent: 35, streak: 0 };

export function studyItems(doc: Doc, root: NodeId | null, kind: StudyKind, percent: number): StudyItem[] {
  const rows = reviewNodes(doc, root);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const candidates = kind === 'nodes'
    ? rows.filter((row) => row.depth > 0 && row.label.trim()).map((row) => ({
        id: row.id, cue: byId.get(row.parent ?? '')?.label || 'Parent topic', answer: row.label
      }))
    : doc.links.filter((link) => link.label?.trim() && byId.has(link.from) && byId.has(link.to)).map((link) => ({
        id: link.id,
        cue: (byId.get(link.from)?.label || 'Untitled') + ' → ' + (byId.get(link.to)?.label || 'Untitled'),
        answer: link.label!
      }));
  const population = kind === 'nodes' ? rows.length : candidates.length;
  const count = Math.min(candidates.length, Math.max(1, Math.round(population * percent / 100)));
  return Array.from({ length: count }, (_, i) => candidates[Math.floor((i + .5) * candidates.length / count)]);
}

export function studyResults(items: readonly StudyItem[], guesses: ReadonlyMap<string, string>): Map<string, boolean> {
  return new Map(items.map((item) => [item.id, checkStudyAnswer(guesses.get(item.id) ?? '', item.answer)]));
}

export function advanceStudy(
  progress: StudyProgress, correct: boolean, population: number, blanked: number
): StudyProgress {
  if (!correct) return { ...progress, streak: 0 };
  if (progress.streak < 1) return { ...progress, streak: progress.streak + 1 };
  const fewer = blanked > 1 && population > 0
    ? Math.ceil((blanked - .5) * 100 / population) - 1
    : progress.percent - 5;
  return { percent: Math.max(5, Math.min(progress.percent - 5, fewer)), streak: 0 };
}
