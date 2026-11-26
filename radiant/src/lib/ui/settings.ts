/**
 * Settings: an in-memory copy with a synchronous API, loaded once at start-up (initSettings) and written through
 * to the host in batches. On the desktop the host keeps them in state.sqlite; the browser preview keeps them in
 * localStorage as before. Keys and value formats are unchanged ("radiant." or "radiant:" prefixes).
 *
 * The first desktop launch after the move imports the WebView's old localStorage settings (before anything reads a
 * setting) and its IndexedDB History snapshots (after the UI is up). The import only inserts what the state file
 * lacks, never touches the WebView data, and is marked done only when every part succeeded, so a failed import
 * is retried on the next launch.
 */
import type { Host, SettingEntry, StoredSnapshot } from '../host/types';
import { isSettingKey, webViewSettings, webViewSnapshotBatches, writeWebViewSetting } from '../host/local-data';
import { recordDiagnostic } from './diagnostics';

/** How long start-up waits for the host before using the WebView's own copy for this session. */
const LOAD_TIMEOUT_MS = 1500;
/** Snapshot JSON sent per import call. */
const IMPORT_BATCH_CHARS = 8 * 1024 * 1024;
/** The host's limits (src-tauri/src/app_state.rs); rows beyond them are left out of the import. */
const MAX_KEY_BYTES = 512;
const MAX_SETTING_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

type Listener = (key: string, value: string | null) => void;

const cache = new Map<string, string>();
const listeners = new Set<Listener>();
/** Local writes not yet sent to the host, in order; a later write to the same key replaces the earlier one. */
const pending = new Map<string, string | null>();
let host: Host | null = null;
let ready: Promise<void> | null = null;
let flushQueued = false;
let writes: Promise<void> = Promise.resolve();
/** The host could not load the settings: this session reads, and also writes, the WebView's localStorage. */
let fallback = false;
/** A failure has been recorded and nothing has succeeded since (one diagnostic per failure streak). */
let failing = false;
/** Settings were imported this launch; the snapshots and the done marker remain. */
let importPending = false;

const encoder = new TextEncoder();
/** Whether text is at most limit bytes of UTF-8 (encoding only when the length alone cannot tell). */
const fits = (text: string, limit: number) =>
  text.length <= limit && (text.length * 3 <= limit || encoder.encode(text).length <= limit);

export function getSetting(key: string): string | null {
  return cache.get(key) ?? null;
}

export function setSetting(key: string, value: string): void {
  write(key, value);
}

export function removeSetting(key: string): void {
  write(key, null);
}

/** Called when another window changes a setting (like the 'storage' event). Returns the unsubscribe function. */
export function onSettingChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function write(key: string, value: string | null): void {
  if (value === null) cache.delete(key);
  else cache.set(key, value);
  pending.delete(key);
  pending.set(key, value);
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(() => void flushSettings());
  }
}

function failed(): void {
  if (failing || !host) return;
  failing = true;
  recordDiagnostic(host, 'settings_unavailable');
}

/** Send pending writes to the host now. Never rejects. */
export function flushSettings(): Promise<void> {
  flushQueued = false;
  const target = host;
  if (!target || !pending.size) return writes;
  const entries: SettingEntry[] = [...pending];
  pending.clear();
  if (fallback) {
    for (const [key, value] of entries) {
      try { writeWebViewSetting(key, value); } catch { /* the host write below may still succeed */ }
    }
  }
  writes = writes.then(() => target.appState.set(entries)).then(() => { failing = false; }, failed);
  return writes;
}

function receive(entries: SettingEntry[]): void {
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || pending.has(key)) continue;
    if (value === null) cache.delete(key);
    else if (typeof value === 'string') cache.set(key, value);
    else continue;
    for (const listener of listeners) {
      try { listener(key, value); } catch (error) { console.error('Settings listener failed', error); }
    }
  }
}

function replaceCache(settings: Record<string, string>): void {
  cache.clear();
  for (const [key, value] of Object.entries(settings)) if (typeof value === 'string') cache.set(key, value);
  // Writes made before loading finished are newer than what was loaded.
  for (const [key, value] of pending) {
    if (value === null) cache.delete(key);
    else cache.set(key, value);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out')), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

/** The WebView's old settings that the host accepts. */
function importableSettings(): Record<string, string> {
  return Object.fromEntries(Object.entries(webViewSettings()).filter(([key, value]) =>
    isSettingKey(key) && fits(key, MAX_KEY_BYTES) && fits(value, MAX_SETTING_BYTES)));
}

/**
 * Load every setting once. Await this before any code reads a setting (the page awaits it before mounting the
 * app, the presenter console or Quick Capture). Idempotent; never rejects.
 */
export function initSettings(target: Host): Promise<void> {
  ready ??= start(target);
  return ready;
}

async function start(target: Host): Promise<void> {
  host = target;
  const origin = location.origin;
  target.appState.onChanged(receive).catch(() => { /* this window then only sees its own changes */ });
  try {
    const loaded = await withTimeout(target.appState.load(origin), LOAD_TIMEOUT_MS);
    replaceCache(loaded.settings);
    if (!loaded.imported && target.shell === 'desktop') {
      try {
        const old = importableSettings();
        if (Object.keys(old).length) await target.appState.importBatch(origin, old, []);
        replaceCache((await withTimeout(target.appState.load(origin), LOAD_TIMEOUT_MS)).settings);
        importPending = true;
      } catch {
        // Show the old values this session; the import is tried again next launch.
        for (const [key, value] of Object.entries(webViewSettings())) if (!cache.has(key)) cache.set(key, value);
        failed();
      }
    }
  } catch {
    fallback = true;
    replaceCache(webViewSettings());
    failed();
  }
  addEventListener('pagehide', () => void flushSettings());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flushSettings(); });
  void flushSettings();
}

function importableSnapshot(row: unknown): StoredSnapshot[] {
  if (!row || typeof row !== 'object') return [];
  const { id, docId, name, at, json, automatic, change } = row as Record<string, unknown>;
  if (typeof id !== 'string' || !id || !fits(id, MAX_KEY_BYTES)) return [];
  if (typeof docId !== 'string' || !docId || !fits(docId, MAX_KEY_BYTES)) return [];
  if (typeof json !== 'string' || !json || !fits(json, MAX_SNAPSHOT_BYTES)) return [];
  if (typeof at !== 'number' || !Number.isFinite(at) || Math.abs(at) > Number.MAX_SAFE_INTEGER) return [];
  const label = typeof name === 'string' && fits(name, MAX_SETTING_BYTES) ? name : 'Snapshot';
  const summary = change && typeof change === 'object' && fits(JSON.stringify(change), MAX_SETTING_BYTES)
    ? change as StoredSnapshot['change'] : undefined;
  return [{ id, docId, name: label, at, json, automatic: automatic === true, change: summary }];
}

/**
 * Second half of the one-time import, after the UI is up: copy the WebView's IndexedDB History snapshots in
 * batches, then mark this origin done. Safe to run in several windows and to repeat after a failure.
 */
export async function finishWebViewImport(target: Host): Promise<void> {
  await initSettings(target);
  if (!importPending) return;
  importPending = false;
  const origin = location.origin;
  const documents = new Set<string>();
  try {
    await webViewSnapshotBatches(IMPORT_BATCH_CHARS, async (rows) => {
      const snapshots = rows.flatMap(importableSnapshot);
      if (!snapshots.length) return;
      await target.appState.importBatch(origin, {}, snapshots);
      for (const row of snapshots) documents.add(row.docId);
    });
    await target.appState.importDone(origin);
  } catch {
    failed();
    return;
  }
  for (const docId of documents) window.dispatchEvent(new CustomEvent('radiant-snapshot-saved', { detail: docId }));
}
