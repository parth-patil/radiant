/** Persistent browser-side data, partitioned by WebView origin. */
import type { SettingEntry, StoredSnapshot, Unlisten } from './types';

/** localStorage keys the browser preview's MockHost uses for its own documents (never settings). */
export const MOCK_DOCUMENT_PREFIXES = ['radiant.doc:', 'radiant.text:', 'radiant.autosave:'] as const;
const SETTING_PREFIXES = ['radiant.', 'radiant:'] as const;

export function isSettingKey(key: string): boolean {
  return SETTING_PREFIXES.some((prefix) => key.startsWith(prefix)) && !MOCK_DOCUMENT_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Every setting this WebView origin keeps in localStorage. Empty when storage is unavailable. */
export function webViewSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key === null || !isSettingKey(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) settings[key] = value;
    }
  } catch { /* storage unavailable */ }
  return settings;
}

/** Write (or with null, remove) one setting in localStorage. Throws when storage refuses it. */
export function writeWebViewSetting(key: string, value: string | null): void {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

/** Settings another tab or window changed in localStorage (the 'storage' event). */
export function onWebViewSettingChange(handler: (entries: SettingEntry[]) => void): Unlisten {
  const listener = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return;
    if (event.key === null) handler(Object.entries(webViewSettings()));
    else if (isSettingKey(event.key)) handler([[event.key, event.newValue]]);
  };
  window.addEventListener('storage', listener);
  return () => window.removeEventListener('storage', listener);
}

/**
 * Read every row of the IndexedDB "snapshots" store, one row at a time, and hand them over in batches of at most
 * about maxChars characters (a single larger row travels alone). Nothing is changed or deleted.
 */
export async function webViewSnapshotBatches(maxChars: number, receive: (rows: unknown[]) => Promise<void>): Promise<void> {
  const keys = await localData('snapshots', 'readonly', (store) => store.getAllKeys());
  let batch: unknown[] = [];
  let size = 0;
  for (const key of keys) {
    const row: unknown = await localData('snapshots', 'readonly', (store) => store.get(key));
    if (!row || typeof row !== 'object') continue;
    const json = (row as { json?: unknown }).json;
    const rowSize = (typeof json === 'string' ? json.length : 0) + 1024;
    if (batch.length && size + rowSize > maxChars) {
      await receive(batch);
      batch = [];
      size = 0;
    }
    batch.push(row);
    size += rowSize;
  }
  if (batch.length) await receive(batch);
}

/** The browser preview's History snapshots, in IndexedDB as before. */
export const webViewSnapshots = {
  async list(docId: string): Promise<StoredSnapshot[]> {
    const rows: StoredSnapshot[] = await localData('snapshots', 'readonly', (store) => store.index('document').getAll(docId));
    return rows.sort((a, b) => b.at - a.at);
  },
  async get(id: string): Promise<StoredSnapshot | null> {
    return (await localData<StoredSnapshot | undefined>('snapshots', 'readonly', (store) => store.get(id))) ?? null;
  },
  async put(row: StoredSnapshot): Promise<void> {
    await localData('snapshots', 'readwrite', (store) => store.put(row));
  },
  async delete(id: string): Promise<void> {
    await localData('snapshots', 'readwrite', (store) => store.delete(id));
  }
};

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve,reject) => {
      const request = indexedDB.open('radiant-local-data',2);
      let blocked = false;
      request.onblocked = () => { blocked = true; reject(new Error('Close an older Radiant window to use local history.')); };
      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (event.oldVersion < 1) {
          db.createObjectStore('images');
          const snapshots = db.createObjectStore('snapshots',{keyPath:'id'});
          snapshots.createIndex('document','docId');
        }
        if (event.oldVersion < 2) {
          const undo = db.createObjectStore('undo',{keyPath:'key'});
          undo.createIndex('document',['docId','slot']);
          undo.createIndex('revision',['docId','slot','at']);
        }
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onversionchange = () => { db.close(); database = undefined; };
        resolve(db);
      };
    }).catch(error => {database=undefined;throw error;});
  }
  return database;
}

export async function localData<T>(table:'images'|'snapshots'|'undo', mode:IDBTransactionMode, request:(store:IDBObjectStore)=>IDBRequest<T>):Promise<T> {
  const db=await openDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(table,mode);
    const operation=request(tx.objectStore(table));
    tx.oncomplete=()=>resolve(operation.result);
    tx.onerror=tx.onabort=()=>reject(tx.error ?? operation.error);
  });
}
