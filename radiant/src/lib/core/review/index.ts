import type { Doc, MapNode, NodeId } from '../types';

export type ReviewMode = 'branches' | 'labels';
export const outcomes = ['recalled', 'partly', 'missed'] as const;
export type Outcome = (typeof outcomes)[number];

export interface ReviewScope {
  docId: string;
  nodeId: NodeId | null;
  title: string;
  mapTitle: string;
  path: string | null;
}

export interface ReviewResult {
  id: NodeId;
  label: string;
  outcome: Outcome;
}

export interface ReviewRecord {
  id: string;
  scope: ReviewScope;
  mode: ReviewMode;
  finishedAt: number;
  elapsedMs: number;
  results: ReviewResult[];
}

export interface ReviewSchedule {
  scope: ReviewScope;
  mode: ReviewMode;
  target: string;
  start: number;
  dates: number[];
  completed: number;
  preset: 'target' | 'buzan';
}

export interface ReviewData {
  history: ReviewRecord[];
  schedules: ReviewSchedule[];
}

export interface ReviewNode {
  id: NodeId;
  parent: NodeId | null;
  depth: number;
  label: string;
  node: MapNode;
}

export function sameScope(a: ReviewScope, b: ReviewScope): boolean {
  return a.docId === b.docId && a.nodeId === b.nodeId;
}

export function reviewScope(doc: Doc, nodeId: NodeId | null, path: string | null): ReviewScope {
  const title = nodeId === null ? doc.title : doc.nodes[nodeId]?.text ?? '';
  return { docId: doc.id, nodeId, title: title.trim() || 'Untitled', mapTitle: doc.title, path };
}

/** The review ignores collapsed state and walks parent before child in visual order. */
export function reviewNodes(doc: Doc, nodeId: NodeId | null): ReviewNode[] {
  const roots = nodeId === null ? doc.roots : [nodeId];
  const pending = roots.toReversed().map((id) => ({ id, parent: null as NodeId | null, depth: 0 }));
  const rows: ReviewNode[] = [];
  while (pending.length) {
    const row = pending.pop()!;
    const node = doc.nodes[row.id];
    if (!node) continue;
    rows.push({ ...row, label: node.text || node.blankAnswer || '', node });
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({ id: node.children[i], parent: row.id, depth: row.depth + 1 });
    }
  }
  return rows;
}

export function firstLevel(mode: ReviewMode, rows: readonly ReviewNode[]): number {
  if (mode === 'labels' || rows.every((row) => row.depth === 0)) return 0;
  return 1;
}

/** Latest self-reported outcome per node. Stored newest first. */
export function latestOutcomes(records: readonly ReviewRecord[], docId: string): Map<NodeId, Outcome> {
  const result = new Map<NodeId, Outcome>();
  for (const record of records) {
    if (record.scope.docId !== docId) continue;
    for (const item of record.results) {
      if (!result.has(item.id)) result.set(item.id, item.outcome);
    }
  }
  return result;
}

export function localDate(time: number): string {
  const date = new Date(time);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0')).join('-');
}

export function dateTime(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return NaN;
  const time = new Date(day + 'T00:00:00').getTime();
  return localDate(time) === day ? time : NaN;
}

const DAY = 86_400_000;

/** Calendar-day arithmetic keeps review dates stable through daylight-saving changes. */
function addDays(time: number, days: number): number {
  const date = new Date(time);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function intervalDays(from: number, to: number): number {
  return Math.round((Date.parse(localDate(to)) - Date.parse(localDate(from))) / DAY);
}

function expandingDates(start: number, target: number, initialGap?: number): number[] {
  const total = intervalDays(start, target);
  if (!(total > 0)) return [];
  const dates: number[] = [];
  let gap = initialGap ?? Math.max(1, Math.round(total * 0.12));
  let elapsed = 0;
  let previousGap = initialGap === undefined ? 1 : Math.max(1, Math.floor(initialGap / 1.35));
  while (elapsed < total) {
    const remaining = total - elapsed;
    if (remaining < 2 * gap) {
      // Split the final portion if both intervals can be at least as long as the last one.
      if (remaining >= 2 * previousGap) dates.push(addDays(start, elapsed + Math.floor(remaining / 2)));
      dates.push(target);
      break;
    }
    elapsed += gap;
    dates.push(addDays(start, elapsed));
    previousGap = gap;
    gap = Math.max(gap + 1, Math.round(gap * 1.35));
  }
  return dates;
}

export function planSchedule(scope: ReviewScope, mode: ReviewMode, target: string, now: number): ReviewSchedule {
  const start = dateTime(localDate(now));
  const dates = expandingDates(start, dateTime(target));
  return { scope, mode, target, start, dates, completed: 0, preset: 'target' };
}

export function buzanSchedule(scope: ReviewScope, mode: ReviewMode, start: number): ReviewSchedule {
  const month = addDays(start, 30);
  return {
    scope, mode, target: localDate(month), start, completed: 0, preset: 'buzan',
    dates: [start + 600_000, addDays(start, 1), addDays(start, 7), month]
  };
}

/** Keep earlier intervals and adapt the remaining dates to the target. */
export function editInterval(schedule: ReviewSchedule, index: number, days: number): ReviewSchedule | null {
  if (!Number.isInteger(days) || days < 1 || index < schedule.completed || index >= schedule.dates.length) return null;
  const previous = index > 0 ? schedule.dates[index - 1] : schedule.start;
  const date = addDays(previous, days);
  const target = dateTime(schedule.target);
  if (!Number.isFinite(date) || date > target) return null;
  const tail = expandingDates(date, target, Math.max(days + 1, Math.round(days * 1.35)));
  return { ...schedule, dates: [...schedule.dates.slice(0, index), date, ...tail] };
}

export function isDue(schedule: ReviewSchedule, now: number): boolean {
  const next = schedule.dates[schedule.completed];
  return next !== undefined && localDate(next) <= localDate(now);
}
