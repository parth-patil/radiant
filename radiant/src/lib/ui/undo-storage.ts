import type { EditorHistory, HistoryEntry } from '../core/model/editor';
import { localData } from '../host/local-data';

type Slot = 'saved' | 'recovery';

interface Sidecar {
  key: string;
  docId: string;
  slot: Slot;
  at: number;
  json: string;
  history: EditorHistory;
}

const MAX_REVISIONS = 4;
/** Restore the most recent 1,000 steps from disk; the live editor retains its full session. */
export const STORED_UNDO_LIMIT = 1000;
const operationTypes = new Set(['insert', 'remove', 'move', 'set', 'setRoot', 'link', 'unlink', 'linkStyle', 'setLink', 'docMeta', 'aiJob', 'presentation', 'canvas', 'canvasMeta']);

/** The fast key indexes candidates. The exact document string is always checked before use. */
function revisionKey(docId: string, slot: Slot, json: string): string {
  let digest = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) digest = Math.imul(digest ^ json.charCodeAt(i), 0x01000193);
  return JSON.stringify([docId, slot, json.length, digest]);
}

function historyOwner(docId: string, slot: Slot, path?: string | null): string {
  return slot === 'recovery' && path ? JSON.stringify([docId, path]) : docId;
}

function validEntry(entry: HistoryEntry): boolean {
  return !!entry && typeof entry.label === 'string' && Number.isFinite(entry.time)
    && (entry.beforeModified === undefined || typeof entry.beforeModified === 'string')
    && (entry.afterModified === undefined || typeof entry.afterModified === 'string')
    && (entry.source === 'user' || typeof entry.source?.ai === 'string')
    && Array.isArray(entry.fwd) && entry.fwd.length > 0 && Array.isArray(entry.inv)
    && entry.inv.length === entry.fwd.length
    && entry.fwd.every((op) => op && operationTypes.has(op.t))
    && entry.inv.every((op) => op && operationTypes.has(op.t));
}

function validHistory(value: EditorHistory): boolean {
  return value?.version === 1 && [value.undo, value.redo].every((stack) =>
    Array.isArray(stack) && stack.length <= STORED_UNDO_LIMIT && stack.every(validEntry));
}

export async function loadUndo(docId: string, slot: Slot, json: string, path?: string | null): Promise<EditorHistory | undefined> {
  try {
    const owner = historyOwner(docId, slot, path);
    for (const entry of owner === docId ? [docId] : [owner, docId]) {
      const row: Sidecar | undefined = await localData('undo', 'readonly', (store) => store.get(revisionKey(entry, slot, json)));
      if (row?.json === json && row.docId === entry && row.slot === slot && validHistory(row.history)) return row.history;
    }
  } catch {
    // Document loading works when local history storage is unavailable.
  }
}

export async function saveUndo(docId: string, slot: Slot, json: string, history: EditorHistory, path?: string | null): Promise<void> {
  try {
    const owner = historyOwner(docId, slot, path);
    const key = revisionKey(owner, slot, json);
    const row: Sidecar = { key, docId: owner, slot, json, history, at: Date.now() };
    await localData('undo', 'readwrite', (store) => store.put(row));
    const range = IDBKeyRange.bound([owner, slot, 0], [owner, slot, Number.MAX_SAFE_INTEGER]);
    const versions = await localData('undo', 'readonly', (store) => store.index('revision').getAllKeys(range));
    for (const expired of versions.slice(0, -MAX_REVISIONS)) {
      await localData('undo', 'readwrite', (store) => store.delete(expired));
    }
  } catch {
    // Saving the document remains available when the local history store is full.
  }
}

export async function discardRecoveryUndo(docId: string, path?: string | null): Promise<void> {
  try {
    const keys: IDBValidKey[] = await localData('undo', 'readonly', (store) => store.index('document').getAllKeys([historyOwner(docId, 'recovery', path), 'recovery']));
    for (const key of keys) await localData('undo', 'readwrite', (store) => store.delete(key));
  } catch {
    // Exact matching prevents recovery data being used with a different file.
  }
}
