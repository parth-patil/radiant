import { REFINE_MARKER, type RefineContext, type RefineMode } from '../core/ai/refine';
import type { AiTurnRequest } from './types';

export function previewRefinement(req: AiTurnRequest): string | null {
  const prefix = REFINE_MARKER + ' ';
  if (!req.instructions.startsWith(prefix)) return null;
  const mode = req.instructions.split('\n')[0].slice(prefix.length) as RefineMode;
  const marker = 'Selected branch (tree order): ';
  const input = req.prompt.split('\n').find((line) => line.startsWith(marker));
  if (!input) return JSON.stringify({ items: [] });
  const rows = JSON.parse(input.slice(marker.length)) as RefineContext['input'];
  const [root, second, third] = rows;
  if (!root) return JSON.stringify({ items: [] });
  const parents = new Set(rows.map((row) => row.parent));
  const leaves = rows.filter((row) => !parents.has(row.id));

  const sourceMarker = 'Source material: ';
  const sourceLine = req.prompt.split('\n').find((line) => line.startsWith(sourceMarker));
  const source = sourceLine ? JSON.parse(sourceLine.slice(sourceMarker.length)) as string : '';
  if (mode === 'chat') return JSON.stringify({
    reply: 'This scope contains ' + rows.length + ' nodes. The selected branch starts with ' + root.title + '.',
    quotes: source ? [source.slice(0, 100).trim()] : [],
    items: [{ parent: root.id, title: 'Discussion notes', reason: 'A place to record ideas from this conversation.' }]
  });

  const cases = {
    regenerate: () => ['Key ideas', 'Examples', 'Applications'].map((title, i) =>
      ({ id: 'new-' + i, parent: null, title })),
    keywords: () => rows.filter(({ blank }) => !blank).map(({ id, title }) =>
      ({ id, title: title.trim().split(/\s+/).slice(0, 4).join(' ') })),
    summarise: () => leaves.filter(({ id }) => id !== root.id).slice(0, Math.ceil(leaves.length / 2))
      .map(({ id }) => ({ id, remove: true })),
    explain: () => [{ id: root.id, note: root.title + ' connects the ideas on this branch.' }],
    gaps: () => [
      { parent: root.id, title: 'Worked example', reason: 'Check whether a worked example in the supplied source belongs here.' },
      ...(second && third ? [{ from: second.id, to: third.id, label: 'Related ideas' }] : [])
    ],
    check: () => [
      { kind: 'missing', parent: root.id, title: 'Source example', reason: 'Compare the examples in the source with the draft.' },
      ...(leaves[0] && leaves[0].id !== root.id
        ? [{ kind: 'extra', id: leaves[0].id, reason: 'This item may be beyond the scope of the supplied source.' }] : [])
    ],
    questions: () => leaves.map(({ id, parent }) => ({
      id, question: 'What is one key idea related to ' + (rows.find((row) => row.id === parent)?.title ?? 'this topic') + '?'
    }))
  };
  return JSON.stringify({ items: cases[mode]?.() ?? [] });
}
