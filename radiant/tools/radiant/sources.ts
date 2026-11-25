import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { basename } from 'node:path';
import { readPortableMap } from '../../src/lib/core/io/portable';
import { parseDocReport, serializeDoc } from '../../src/lib/core/model';
import type { SpecDiagnostic } from '../../src/lib/core/io/map-spec';
import type { Doc } from '../../src/lib/core/types';
import { optionalConnection, requestSnapshot, type AgentConnection } from '../agent-write';
import { CliError, EXIT, denied, invalid, unavailable } from './envelope';
import { existingFile, readStoredAsset, readStoredMap, sha256 } from './store';
import { decodeText, loadSpec, readStdin, type LoadSpecOptions } from './spec-io';

export type SourceKind = 'radiant' | 'bundle' | 'spec' | 'json';

export interface MapSource {
  /** Canonical path, or "-" for stdin. */
  path: string;
  kind: SourceKind;
  backend: 'file' | 'live';
  doc: Doc;
  /** Repairs made while reading, or skipped import content. */
  repairs: string[];
  formatVersion?: number;
  revision: string;
  diagnostics?: SpecDiagnostic[];
  /** Tiers of the live grant, when backend is live. */
  live?: { writable: boolean; destructive: boolean };
  /** Bytes of an embedded picture, when the source carries them. */
  asset(hash: string): { bytes: Uint8Array; mime: string } | null;
}

const MAX_JSON_BYTES = 64 * 1024 * 1024;

/** The name that stands for the map open in Radiant, once this process holds a grant for it. */
export const LIVE_MAP = '@live';

let session: AgentConnection | null = null;

/** Hold a grant the app issued to this process (the MCP server). It stays in memory. */
export function setLiveSession(connection: AgentConnection | null): void {
  session = connection;
}

/** The grant in use: the one this process was given, or the one in the environment. */
export function liveConnection(): AgentConnection | null {
  return session ?? grantFromEnvironment();
}

/** Read the granted map from the app. */
async function liveSource(connection: AgentConnection): Promise<MapSource> {
  let reply: Awaited<ReturnType<typeof requestSnapshot>>;
  try {
    reply = await requestSnapshot(connection);
  } catch (e) { throw liveError(e); }
  const report = parseDocReport(reply.snapshot);
  if (report.doc.id !== connection.documentId) throw denied('grant_mismatch', 'The active map does not match this grant.');
  // The app reports the revision of its document (without settled layout); older builds do not.
  const revision = reply.revision?.replace(/^sha256:/, '') ?? sha256(reply.snapshot);
  const saved = connection.path.startsWith('/');
  return { path: saved ? connection.path : LIVE_MAP, kind: 'radiant', backend: 'live', ...report, revision, formatVersion: 3,
    live: { writable: reply.writable, destructive: reply.destructive === true },
    asset: (hash) => saved ? readStoredAsset(connection.path, hash) : null };
}

/** The agent grant from the environment, as a structured error when it is set but incomplete. */
export function grantFromEnvironment(): AgentConnection | null {
  try {
    return optionalConnection();
  } catch (e) {
    throw denied('no_grant', e instanceof Error ? e.message : String(e), { hint: 'Copy all four RADIANT_AGENT_* values from Inspector > Local agent access.' });
  }
}

/** Map socket and app failures to the exit-code table. */
export function liveError(e: unknown): CliError {
  if (e instanceof CliError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (/could not reach|did not answer|closed before|exceeded its limit|invalid local app response|busy|not ready/i.test(message)) {
    return unavailable('app_unavailable', message, { hint: 'Check that Radiant is open with the grant active, read the map, then retry.' });
  }
  if (/grant|not allowed|permission|denied|expired|revoked|read-only|writ/i.test(message)) return denied('not_permitted', message);
  return invalid('rejected', message);
}

function sniff(path: string): Uint8Array {
  const fd = openSync(path, 'r');
  try {
    const head = new Uint8Array(16);
    const n = readSync(fd, head, 0, 16, 0);
    return head.subarray(0, n);
  } finally { closeSync(fd); }
}

const SQLITE = 'SQLite format 3';

export interface OpenOptions {
  /** Live connection, or undefined to read it from the environment. */
  connection?: AgentConnection | null;
  spec?: LoadSpecOptions;
}

/**
 * Open any map the tool reads: a .radiant file (live through the grant when it is the granted map), a portable
 * bundle, a Radiant JSON export, or a spec (".map.md" or its JSON twin). "-" reads stdin.
 */
export async function openMap(path: string, opts: OpenOptions = {}): Promise<MapSource> {
  if (path === '-') return fromText(decodeText(await readStdin(MAX_JSON_BYTES), 'Standard input'), '-', opts);
  if (path === LIVE_MAP) {
    const connection = opts.connection === undefined ? liveConnection() : opts.connection;
    if (!connection) throw denied('no_grant', 'No map is connected.', { hint: 'Ask Radiant for access first (radiant_connect), then use ' + LIVE_MAP + '.' });
    return liveSource(connection);
  }
  const canonical = existingFile(path, 'map');
  const head = sniff(canonical);
  const ascii = String.fromCharCode(...head);
  if (ascii.startsWith(SQLITE)) {
    const connection = opts.connection === undefined ? liveConnection() : opts.connection;
    if (connection?.path === canonical) return liveSource(connection);
    const stored = readStoredMap(canonical);
    return { path: canonical, kind: 'radiant', backend: 'file', doc: stored.doc, repairs: stored.repairs, formatVersion: stored.version,
      revision: stored.revision, asset: (hash) => readStoredAsset(canonical, hash) };
  }
  if (head[0] === 0x50 && head[1] === 0x4b) {
    let bundle;
    try {
      bundle = await readPortableMap(new Uint8Array(readFileSync(canonical)));
    } catch (e) {
      throw invalid('invalid_bundle', basename(canonical) + ' is not a readable Radiant portable bundle: ' + (e instanceof Error ? e.message : String(e)));
    }
    const assets = new Map(bundle.assets.map((a) => [a.hash, { bytes: a.bytes, mime: a.mime }]));
    return { path: canonical, kind: 'bundle', backend: 'file', doc: bundle.doc, repairs: bundle.skipped,
      revision: sha256(serializeDoc(bundle.doc)), asset: (hash) => assets.get(hash) ?? null };
  }
  if (/\.radiant$/i.test(canonical)) throw invalid('not_a_map', basename(canonical) + ' is not a Radiant SQLite map.');
  if (/\.zip$/i.test(canonical)) throw invalid('invalid_bundle', basename(canonical) + ' is not a ZIP archive.');
  return fromText(decodeText(readFileSync(canonical), basename(canonical)), canonical, opts);
}

async function fromText(text: string, path: string, opts: OpenOptions): Promise<MapSource> {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    let raw: unknown;
    try { raw = JSON.parse(trimmed); } catch { raw = undefined; }
    if (raw && typeof raw === 'object' && 'nodes' in raw && 'version' in raw) {
      try {
        const report = parseDocReport(trimmed);
        return { path, kind: 'json', backend: 'file', ...report, revision: sha256(serializeDoc(report.doc)), asset: () => null };
      } catch (e) {
        throw invalid('invalid_document', 'The JSON map could not be read: ' + (e instanceof Error ? e.message : String(e)));
      }
    }
  }
  const loaded = await loadSpecText(text, path, opts);
  return loaded;
}

async function loadSpecText(text: string, path: string, opts: OpenOptions): Promise<MapSource> {
  const spec = await loadSpec(path, { ...opts.spec, text });
  const errors = spec.compiled.diagnostics.filter((d) => d.severity === 'error');
  if (!spec.compiled.doc || errors.length) {
    throw new CliError('invalid_spec', EXIT.invalid, 'The spec has ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + '.', {
      details: { diagnostics: spec.compiled.diagnostics }, hint: 'radiant validate ' + path
    });
  }
  const assets = new Map(spec.assets.map((a) => [a.hash, { bytes: a.bytes, mime: a.mime }]));
  return { path, kind: 'spec', backend: 'file', doc: spec.compiled.doc, repairs: [], diagnostics: spec.compiled.diagnostics,
    revision: sha256(serializeDoc(spec.compiled.doc)), asset: (hash) => assets.get(hash) ?? null };
}
