import type { NodeId } from '../types';
import type { ReviewNode } from './index';

export interface AttemptNode {
  id: string;
  parent: string | null;
  label: string;
}

export type ComparisonStatus = 'matched' | 'missing' | 'extra' | 'misplaced';

export interface ComparisonNode {
  id: string;
  parent: string | null;
  label: string;
  status: ComparisonStatus;
  attemptId?: string;
  attemptedParent?: string;
  attemptedParentId?: string;
}

function comparable(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Parent-aware text matching. Duplicate labels prefer matches under the same parent. */
export function compareAttempt(expected: readonly ReviewNode[], attempt: readonly AttemptNode[]): ComparisonNode[] {
  const groups = new Map<string, AttemptNode[]>();
  const attemptById = new Map(attempt.map((item) => [item.id, item]));
  for (const item of attempt) {
    const key = comparable(item.label);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  const expectedToAttempt = new Map<NodeId, AttemptNode>();
  const attemptedToExpected = new Map<string, NodeId>();
  const match = (id: NodeId, item: AttemptNode) => {
    expectedToAttempt.set(id, item);
    attemptedToExpected.set(item.id, id);
  };

  for (const row of expected) {
    const parent = row.parent === null ? null : expectedToAttempt.get(row.parent)?.id;
    const item = (groups.get(comparable(row.label)) ?? [])
      .find((candidate) => candidate.parent === parent && !attemptedToExpected.has(candidate.id));
    if (item) match(row.id, item);
  }
  for (const row of expected) {
    if (expectedToAttempt.has(row.id)) continue;
    const group = groups.get(comparable(row.label)) ?? [];
    const parent = row.parent === null ? null : expectedToAttempt.get(row.parent)?.id;
    const unused = (item: AttemptNode) => !attemptedToExpected.has(item.id);
    const item = group.find((candidate) => candidate.parent === parent && unused(candidate)) ?? group.find(unused);
    if (item) match(row.id, item);
  }

  const result: ComparisonNode[] = [];
  for (const row of expected) {
    const found = expectedToAttempt.get(row.id);
    const parent = row.parent === null ? null : expectedToAttempt.get(row.parent)?.id;
    const status = !found ? 'missing' : found.parent === parent ? 'matched' : 'misplaced';
    result.push({
      id: 'saved-' + row.id,
      parent: row.parent === null ? null : 'saved-' + row.parent,
      label: row.label,
      status,
      attemptId: found?.id,
      attemptedParentId: status === 'misplaced' ? found?.parent ?? undefined : undefined,
      attemptedParent: status === 'misplaced'
        ? (found?.parent && attemptById.get(found.parent)?.label) || 'Top level'
        : undefined
    });
  }
  for (const item of attempt) {
    if (attemptedToExpected.has(item.id)) continue;
    const mapped = item.parent !== null ? attemptedToExpected.get(item.parent) : undefined;
    const parent = mapped !== undefined ? 'saved-' + mapped : item.parent !== null ? 'attempt-' + item.parent : null;
    result.push({ id: 'attempt-' + item.id, parent, label: item.label, status: 'extra', attemptId: item.id });
  }
  return result;
}
