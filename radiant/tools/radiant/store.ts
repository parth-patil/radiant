import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseDocReport } from '../../src/lib/core/model';
import type { Doc } from '../../src/lib/core/types';
import { CliError, EXIT, invalid, nearest, notFound } from './envelope';

const APPLICATION_ID = 0x52444e54;
/** SQLite user_version values this tool reads. It never writes SQLite maps (portable bundles only, for now). */
export const READABLE_VERSIONS = [1, 2, 3] as const;

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

export interface StoredMap {
  doc: Doc;
  repairs: string[];
  version: number;
  /** sha256 of the exact stored doc.json string (the store's document digest). */
  revision: string;
}

function openDatabase(path: string): Database {
  try {
    return new Database(path, { readonly: true });
  } catch (e) {
    throw invalid('not_a_map', 'Could not open ' + path + ' as a Radiant map: ' + (e instanceof Error ? e.message : String(e)));
  }
}

function header(db: Database, path: string): number {
  let id: number;
  let version: number;
  try {
    id = (db.query('PRAGMA application_id').get() as { application_id: number }).application_id;
    version = (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  } catch {
    throw invalid('not_a_map', path + ' is not a SQLite database.', { hint: 'radiant validate ' + path });
  }
  if (id !== APPLICATION_ID) throw invalid('not_a_map', path + ' is a SQLite database but not a Radiant map.');
  if (!(READABLE_VERSIONS as readonly number[]).includes(version)) {
    throw invalid(version > 3 ? 'format_too_new' : 'format_unsupported',
      'Radiant file version ' + version + ' is ' + (version > 3 ? 'newer than this tool reads' : 'not supported') + ' (it reads 1 to 3). The file was not changed.');
  }
  return version;
}

/** Read the snapshot and its last commit together, read-only, while the desktop editor may be writing. */
export function readStoredMap(path: string): StoredMap {
  const db = openDatabase(path);
  try {
    db.exec('PRAGMA trusted_schema=OFF');
    const version = header(db, path);
    db.exec('BEGIN');
    const digest = version >= 2
      ? '(SELECT result_json_hash FROM operation_log ORDER BY sequence DESC LIMIT 1)'
      : 'NULL';
    const row = db.query('SELECT json, ' + digest + ' AS digest FROM doc WHERE id=1').get() as {
      json: string; digest: string | null
    } | null;
    if (!row) throw invalid('not_a_map', 'Map has no document');
    const revision = sha256(row.json);
    if (row.digest !== null && revision !== row.digest) {
      throw invalid('inconsistent_map', 'The document and its last committed edit disagree.');
    }
    try {
      return { ...parseDocReport(row.json), version, revision };
    } catch (e) {
      throw invalid('invalid_document', 'The stored document could not be read: ' + (e instanceof Error ? e.message : String(e)));
    }
  } finally { db.close(); }
}

/** One embedded asset from a SQLite map, or null. */
export function readStoredAsset(path: string, hash: string): { bytes: Uint8Array; mime: string } | null {
  const db = openDatabase(path);
  try {
    header(db, path);
    const row = db.query('SELECT mime, bytes FROM assets WHERE hash = ?').get(hash) as { mime: string | null; bytes: Uint8Array | null } | null;
    if (!row?.bytes) return null;
    return { bytes: new Uint8Array(row.bytes), mime: row.mime ?? 'application/octet-stream' };
  } finally { db.close(); }
}

export interface HistoryEntry {
  sequence: number;
  kind: string;
  label?: string;
  source: string;
  sourceKind: 'user' | 'ai' | 'agent' | 'other' | 'none';
  group?: string;
  ops?: number;
  revision: string;
}

function sourceOf(raw: unknown): { source: string; sourceKind: HistoryEntry['sourceKind'] } {
  if (raw === undefined || raw === null) return { source: '', sourceKind: 'none' };
  if (typeof raw === 'object' && raw && 'ai' in raw) return { source: 'ai:' + String((raw as { ai: unknown }).ai), sourceKind: 'ai' };
  const s = String(raw);
  if (s === 'user') return { source: s, sourceKind: 'user' };
  if (/^agent(?::|$)/.test(s)) return { source: s, sourceKind: 'agent' };
  if (/^ai(?::|$)/.test(s)) return { source: s, sourceKind: 'ai' };
  return { source: s, sourceKind: 'other' };
}

/** Operation-log entries, newest first. Version 1 files without a log return an empty list. */
export function readHistory(path: string, limit: number, filter?: string): { entries: HistoryEntry[]; total: number; version: number } {
  const db = openDatabase(path);
  try {
    const version = header(db, path);
    const table = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='operation_log'").get();
    if (!table) return { entries: [], total: 0, version };
    const total = (db.query('SELECT count(*) AS n FROM operation_log').get() as { n: number }).n;
    const rows = db.query('SELECT sequence, operation_json, result_json_hash FROM operation_log ORDER BY sequence DESC').all() as {
      sequence: number; operation_json: string; result_json_hash: string
    }[];
    const entries: HistoryEntry[] = [];
    for (const row of rows) {
      let op: Record<string, unknown> = {};
      try { op = JSON.parse(row.operation_json) as Record<string, unknown>; } catch { /* unreadable entry */ }
      const { source, sourceKind } = sourceOf(op.source);
      if (filter && sourceKind !== filter) continue;
      const forward = op.forward ?? op.ops;
      entries.push({
        sequence: row.sequence,
        kind: typeof op.kind === 'string' ? op.kind : 'unknown',
        ...(typeof op.label === 'string' ? { label: op.label } : {}),
        source, sourceKind,
        ...(typeof op.group === 'string' ? { group: op.group } : {}),
        ...(Array.isArray(forward) ? { ops: forward.length } : {}),
        revision: 'sha256:' + row.result_json_hash
      });
      if (entries.length >= limit) break;
    }
    return { entries, total, version };
  } finally { db.close(); }
}

export interface ListedMap {
  path: string;
  title?: string;
  nodes?: number;
  modified: string;
  formatVersion?: number;
  error?: string;
}

/** Summary of one .radiant file, without modifying it. */
export function describeStoredMap(path: string): ListedMap {
  const modified = statSync(path).mtime.toISOString();
  const db = openDatabaseQuiet(path);
  if (!db) return { path, modified, error: 'Not a readable SQLite file.' };
  try {
    const version = header(db, path);
    const row = db.query('SELECT json FROM doc WHERE id=1').get() as { json: string } | null;
    if (!row) return { path, modified, formatVersion: version, error: 'Map has no document.' };
    const raw = JSON.parse(row.json) as { title?: unknown; nodes?: Record<string, unknown> };
    return { path, title: typeof raw.title === 'string' ? raw.title : undefined, nodes: raw.nodes ? Object.keys(raw.nodes).length : 0, modified, formatVersion: version };
  } catch (e) {
    return { path, modified, error: e instanceof Error ? e.message : String(e) };
  } finally { db.close(); }
}

function openDatabaseQuiet(path: string): Database | null {
  try { return new Database(path, { readonly: true }); } catch { return null; }
}

/** .radiant files in a directory (optionally recursive, skipping hidden folders and node_modules). */
export function listMapFiles(dir: string, recursive: boolean, limit = 5_000): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;
  const visit = (folder: string, depth: number) => {
    let entries: { name: string; isFile(): boolean; isDirectory(): boolean }[];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files.length >= limit) { truncated = true; return; }
      const full = join(folder, e.name);
      if (e.isFile() && e.name.endsWith('.radiant')) files.push(resolve(full));
      else if (recursive && e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && depth < 16) visit(full, depth + 1);
    }
  };
  visit(dir, 0);
  return { files, truncated };
}

/** Canonical path of an existing input file, or a not-found error that suggests nearby names. */
export function existingFile(path: string, what = 'file'): string {
  if (!existsSync(path)) {
    const dir = dirname(resolve(path));
    let names: string[] = [];
    try { names = (readdirSync(dir) as string[]).filter((n) => !n.startsWith('.')); } catch { /* missing directory */ }
    throw notFound('file_not_found', 'No ' + what + ' at ' + path + '.', {
      suggestions: nearest(basename(path), names).map((n) => join(dirname(path), n)),
      hint: 'radiant list ' + (dirname(path) || '.')
    });
  }
  const canonical = realpathSync(path);
  if (lstatSync(canonical).isDirectory()) throw new CliError('is_directory', EXIT.usage, path + ' is a directory; name a file.', { hint: 'radiant list ' + path });
  return canonical;
}

export const isRadiantPath = (path: string) => extname(path) === '.radiant';
