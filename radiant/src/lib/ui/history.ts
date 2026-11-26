import type { ChangeSummary } from '../core/model/editor';
import type { Doc } from '../core/types';
import { serializeDoc, newId } from '../core/model';
import { getHost } from '../host';
import { getSetting, setSetting } from './settings';

const retentionKey = 'radiant:snapshot-retention';
export function automaticSnapshotLimit(): number {
  const value = Number(getSetting(retentionKey));
  if (Number.isInteger(value) && value >= 1 && value <= 100) return value;
  return 24;
}

export function setAutomaticSnapshotLimit(value: number): void {
  if (Number.isInteger(value) && value >= 1 && value <= 100) {
    setSetting(retentionKey, String(value));
  }
}

export async function pruneAutomaticSnapshots(docId: string): Promise<void> {
  const expired = (await listSnapshots(docId)).filter((entry) => entry.automatic).slice(automaticSnapshotLimit());
  for (const row of expired) await getHost().appState.snapshotDelete(row.id);
}

export interface Snapshot {
  id: string;
  docId: string;
  name: string;
  at: number;
  json: string;
  automatic: boolean;
  change?: ChangeSummary;
}
export async function listSnapshots(docId: string):Promise<Snapshot[]> {
  const rows: Snapshot[] = await getHost().appState.snapshotList(docId);
  return rows.sort((a,b)=>b.at-a.at);
}
function snapshotPathKey(path: string): string {
  return 'radiant:snapshot-path:' + path;
}

export async function latestSnapshotForPath(path: string): Promise<Snapshot | undefined> {
  try {
    const id = getSetting(snapshotPathKey(path));
    if (id) return (await getHost().appState.snapshotGet(id)) ?? undefined;
  } catch { /* A map can still report its file error without a snapshot. */ }
}

export function addSnapshot(doc: Doc, name: string, automatic = false, change?: ChangeSummary): Promise<void> {
  return storeSnapshot(doc.id, serializeDoc(doc), name, automatic, change);
}

export async function storeSnapshot(docId: string, json: string, name: string, automatic = false, change?: ChangeSummary, path?: string): Promise<void> {
  const snapshot: Snapshot = { id: newId(), docId, name, at: Date.now(), json, automatic, change };
  await getHost().appState.snapshotPut(snapshot);
  if (path) setSetting(snapshotPathKey(path), snapshot.id);
  if (automatic) await pruneAutomaticSnapshots(docId);
  window.dispatchEvent(new CustomEvent('radiant-snapshot-saved', { detail: docId }));
}

export const historySource = { user: 'You', ai: 'AI', agent: 'Agent' } as const;
export function readRecent(): string[] {
  try {
    const value:unknown=JSON.parse(getSetting('radiant.recent') ?? '[]');
    return Array.isArray(value)?value.filter((p):p is string=>typeof p==='string').slice(0,12):[];
  } catch {return [];}
}
export function rememberRecent(path:string) {
  const recent=[path,...readRecent().filter(p=>p!==path)].slice(0,12);
  setSetting('radiant.recent',JSON.stringify(recent));
  return recent;
}
