import { initialStudyProgress, type StudyKind, type StudyProgress } from '../core/review/study';
import type { ReviewData, ReviewScope } from '../core/review';
import { getSetting, onSettingChange, setSetting } from './settings';

const STORAGE_KEY = 'radiant:reviews:v1';

export function readReviews(): ReviewData {
  const raw = getSetting(STORAGE_KEY);
  if (raw === null) return { history: [], schedules: [] };
  const data = JSON.parse(raw) as ReviewData | null;
  if (!data || !Array.isArray(data.history) || !Array.isArray(data.schedules)) {
    throw new Error('Review data could not be read.');
  }
  return data;
}

export function saveReviews(change: (data: ReviewData) => ReviewData): ReviewData {
  const next = change(readReviews());
  setSetting(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function subscribeReviews(callback: () => void): () => void {
  return onSettingChange((key) => { if (key === STORAGE_KEY) callback(); });
}

/** Refresh the path independently of whether the Review panel is mounted. */
export function linkReviewMapPath(docId: string, path: string): void {
  try {
    const data = readReviews();
    if (!data.schedules.some((item) => item.scope.docId === docId && item.scope.path !== path)) return;
    saveReviews((current) => ({
      ...current,
      schedules: current.schedules.map((item) => item.scope.docId === docId
        ? { ...item, scope: { ...item.scope, path } } : item)
    }));
  } catch {
    // Map saving and opening still work when local review storage is unavailable.
  }
}

const LEARNED_PREFIX = 'radiant:learned:';
const STUDY_PREFIX = 'radiant:study:';

export function reviewPreference(key: string): boolean {
  return getSetting(key) === '1';
}

export function setReviewPreference(key: string, enabled: boolean): void {
  setSetting(key, enabled ? '1' : '0');
}

export function learnedMap(docId: string): boolean {
  return reviewPreference(LEARNED_PREFIX + docId);
}

export function markLearned(docId: string, enabled: boolean): void {
  setReviewPreference(LEARNED_PREFIX + docId, enabled);
}

export function readStudyProgress(scope: ReviewScope, kind: StudyKind) {
  try {
    const record = JSON.parse(getSetting(STUDY_PREFIX + JSON.stringify([scope.docId, scope.nodeId, kind])) ?? 'null');
    if (record && Number.isInteger(record.percent) && record.percent >= 5 && record.percent <= 90 &&
      Number.isInteger(record.streak) && record.streak >= 0 && record.streak < 2) {
      return { percent: record.percent as number, streak: record.streak as number };
    }
  } catch { /* Use the default for older or unavailable storage. */ }
  return { ...initialStudyProgress };
}

export function writeStudyProgress(scope: ReviewScope, kind: StudyKind, progress: StudyProgress) {
  setSetting(STUDY_PREFIX + JSON.stringify([scope.docId, scope.nodeId, kind]), JSON.stringify(progress));
}

const REMINDERS_KEY = 'radiant:review-reminders';
const LAST_REMINDER_KEY = 'radiant:review-reminded-on';
export const reviewReminderEvent = 'radiant:review-reminder-preference';

export function reviewRemindersEnabled(): boolean {
  return reviewPreference(REMINDERS_KEY);
}

export function setReviewReminders(enabled: boolean): void {
  setReviewPreference(REMINDERS_KEY, enabled);
  window.dispatchEvent(new Event(reviewReminderEvent));
}

export function alreadyReminded(day: string): boolean {
  return getSetting(LAST_REMINDER_KEY) === day;
}

export function markReminded(day: string): void {
  setSetting(LAST_REMINDER_KEY, day);
}
