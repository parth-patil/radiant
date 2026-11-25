import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  AgentOpError, classifyAgentBatch, normalRevision, parseAgentBatch, planApply, runAgentBatch, serializeDoc, type AgentBatch, type AgentRun
} from '../../src/lib/core/model';
import type { Doc } from '../../src/lib/core/types';
import { agentEdits, requestEdits, requestOps, requestUndo, writeConnection, type AgentConnection } from '../agent-write';
import { flagBool, flagString } from './args';
import { CliError, EXIT, conflict, denied, invalid, usageError, type CommandResult } from './envelope';
import { LIVE_MAP, liveConnection, liveError, openMap, type MapSource } from './sources';
import { existingFile, sha256 } from './store';
import { buildTime, decodeText, loadSpec, portableBundle, prepareOutput, readStdin, writeAtomic } from './spec-io';
import { quoteArg, type Ctx } from './read';

/** Largest edit batch read from stdin or --ops. */
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const EXIT_BY_KIND = { invalid: EXIT.invalid, not_found: EXIT.notFound, conflict: EXIT.conflict, denied: EXIT.denied, unavailable: EXIT.unavailable } as const;

/** A structured CLI error from an AgentOpError (or the same shape in a live reply). */
function batchError(e: { code: string; kind?: string; message: string; op?: number; suggestions?: string[]; [key: string]: unknown }, path: string): CliError {
  const exit = EXIT_BY_KIND[(e.kind ?? 'invalid') as keyof typeof EXIT_BY_KIND] ?? EXIT.invalid;
  const { code, kind, message, suggestions, ...rest } = e;
  void kind;
  const hint = code === 'revision_mismatch' ? 'radiant get ' + quoteArg(path) + ' --format spec, then retry with the new revision'
    : code === 'destructive_not_allowed' ? (path.endsWith('.radiant') ? 'Grant deletes in Radiant (Inspector > Local agent access > Also allow deletes).' : 'Pass --allow-destructive.')
    : code === 'unknown_node' ? 'radiant find ' + quoteArg(path) + ' TEXT' : 'radiant schema ops';
  return new CliError(code, exit, message, { suggestions: suggestions ?? [], hint, details: { applied: 0, ...rest } });
}

async function readBatchInput(ctx: Ctx): Promise<unknown> {
  const from = flagString(ctx.args, 'ops');
  const bytes = from && from !== '-' ? new Uint8Array(readFileSync(existingFile(from, 'ops file'))) : await readStdin(MAX_BATCH_BYTES);
  if (bytes.length > MAX_BATCH_BYTES) throw invalid('input_too_large', 'The edit batch is larger than ' + MAX_BATCH_BYTES + ' bytes.');
  const text = decodeText(bytes, from ?? 'Standard input');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw invalid('invalid_edits', 'The edit batch is not JSON: ' + (e instanceof Error ? e.message : String(e)), { hint: 'radiant schema ops' });
  }
}

/** The earlier three-edit form: an array of {type: add|rename|set-note}. */
const isLegacy = (value: unknown) => Array.isArray(value) && value.every((v) => v && typeof v === 'object' && 'type' in v && !('op' in v));

async function legacyEdit(path: string, value: unknown): Promise<CommandResult> {
  let connection: AgentConnection;
  try { connection = writeConnection(); } catch (e) {
    throw denied('no_grant', e instanceof Error ? e.message : String(e), { hint: 'Allow agent writes in Inspector > Local agent access and set the four RADIANT_AGENT_* variables.' });
  }
  let canonical: string;
  try { canonical = existingFile(path, 'map'); } catch { throw denied('not_granted_map', 'Supply the explicitly granted map'); }
  if (canonical !== connection.path) throw denied('not_granted_map', 'Supply the explicitly granted map', { hint: 'The grant is for ' + connection.path });
  const parsed = agentEdits.safeParse(value);
  if (!parsed.success) throw invalid('invalid_edits', 'The edit batch is invalid: ' + parsed.error.message.slice(0, 2000), { hint: 'radiant schema ops' });
  try { await requestEdits(connection, parsed.data); } catch (e) { throw liveError(e); }
  return { type: 'edit.result', data: { status: 'applied', backend: 'live', path: canonical, applied: parsed.data.length }, text: 'Applied in Radiant as one undoable batch.' };
}

/** Flags that override fields of the batch. */
function withFlags(ctx: Ctx, batch: AgentBatch): AgentBatch {
  const out = { ...batch };
  if (flagBool(ctx.args, 'dry-run')) out.dryRun = true;
  const label = flagString(ctx.args, 'label');
  if (label) out.label = label;
  const revision = flagString(ctx.args, 'if-revision');
  if (revision) out.ifRevision = revision;
  const client = flagString(ctx.args, 'client') ?? process.env.RADIANT_AGENT_CLIENT;
  if (client && !out.client) out.client = client;
  return parseBatch(out);
}

function parseBatch(value: unknown): AgentBatch {
  try { return parseAgentBatch(value); } catch (e) {
    if (e instanceof AgentOpError) throw batchError(e.toJSON() as never, '-');
    throw e;
  }
}

/** Where a changed file at rest goes: a new file (-o), the same file (--in-place), or nowhere (refused). */
function fileTarget(ctx: Ctx, src: MapSource): { kind: 'output' | 'in-place'; path: string; replace: boolean } {
  const out = flagString(ctx.args, 'output');
  if (out) {
    if (!/\.(zip|json)$/i.test(out)) throw usageError('The output must be a portable bundle (.radiant.zip) or Radiant JSON (.json).', { suggestions: [out + '.radiant.zip'] });
    return { kind: 'output', path: out, replace: flagBool(ctx.args, 'replace') };
  }
  if (src.kind === 'radiant') {
    throw conflict('native_file', basename(src.path) + ' is a native .radiant map. This tool never writes .radiant files directly: if the map is open in Radiant, the window owns it. ' +
      'Grant agent access in the app (Inspector > Local agent access) and run the same command with the four RADIANT_AGENT_* variables set, or write a copy with -o MAP.radiant.zip.',
      { hint: 'radiant edit ' + quoteArg(src.path) + ' -o ' + quoteArg(src.path.replace(/\.radiant$/, '') + '-edited.radiant.zip') + ' < ops.json' });
  }
  if (src.kind === 'spec' || src.path === '-') {
    throw usageError('A spec or stdin cannot be changed in place; write the result with -o OUT.radiant.zip.', { hint: 'radiant apply SPEC MAP' });
  }
  if (!flagBool(ctx.args, 'in-place')) {
    throw denied('write_not_permitted', 'Changing ' + basename(src.path) + ' needs --in-place (the write flag for files), or -o to write a new file.',
      { hint: 'radiant edit ' + quoteArg(src.path) + ' --in-place < ops.json' });
  }
  if (flagString(ctx.args, 'root') !== undefined) prepareOutput(src.path, { replace: true, root: flagString(ctx.args, 'root') });
  return { kind: 'in-place', path: src.path, replace: true };
}

export interface ExtraAssets { get(hash: string): { bytes: Uint8Array; mime: string } | null | undefined }

/**
 * Apply a validated batch to a map: through the app when the map is the granted live map, otherwise to a file at rest
 * (a dry run, a new file with -o, or the same bundle or JSON file with --in-place and a revision check).
 */
export async function commitBatch(ctx: Ctx, src: MapSource, batch: AgentBatch, extra?: ExtraAssets, type = 'edit.result'): Promise<CommandResult> {
  const tier = classifyAgentBatch(batch);
  const base = { backend: src.backend, path: src.path };
  if (src.backend === 'live' && !batch.dryRun) {
    const connection = liveConnection()!;
    let result: unknown;
    try { result = await requestOps(connection, batch, tier === 'destructive'); } catch (e) { throw liveError(e); }
    const r = (result ?? {}) as { reply?: Record<string, unknown>; error?: Record<string, unknown> };
    if (r.error) throw batchError(r.error as never, src.path);
    if (!r.reply) throw new CliError('invalid_reply', EXIT.unavailable, 'The app sent no result for the batch.', { hint: 'radiant get ' + quoteArg(src.path) });
    const data = { ...r.reply, ...base, undo: 'radiant undo ' + quoteArg(src.path) + ' --tx ' + String(r.reply.tx) };
    return { type, data, text: summaryText(data) };
  }
  if (src.backend === 'live' && tier === 'destructive' && !src.live?.destructive) {
    // A dry run is checked locally, but it reports what the grant would refuse.
    throw denied('destructive_not_allowed', 'The batch deletes content and this grant does not allow deletes.', { hint: 'Grant deletes in Radiant (Inspector > Local agent access > Also allow deletes).' });
  }
  const target = batch.dryRun ? null : src.backend === 'file' ? fileTarget(ctx, src) : null;
  let run: AgentRun;
  try {
    run = runAgentBatch(src.doc, batch, {
      revision: src.revision, client: batch.client,
      allowDestructive: src.backend === 'live' ? src.live?.destructive === true : flagBool(ctx.args, 'allow-destructive')
    });
  } catch (e) {
    if (e instanceof AgentOpError) {
      if (e.code === 'destructive_not_allowed' && src.backend === 'file') {
        throw new CliError(e.code, EXIT.denied, e.message + ' Pass --allow-destructive (the destructive flag for files).', { details: { applied: 0, op: e.op } });
      }
      throw batchError(e.toJSON() as never, src.path);
    }
    throw e;
  }
  const previousRevision = normalRevision(src.revision);
  if (!target) {
    const data = { ...run.reply, status: 'dry_run', ...base, revision: previousRevision, wouldBe: 'sha256:' + sha256(serializeDoc(run.doc)) };
    return { type, data, text: summaryText(data) };
  }
  const doc: Doc = run.doc;
  doc.modified = buildTime(flagString(ctx.args, 'now'), null);
  let written: string;
  let bytes: Uint8Array;
  if (/\.json$/i.test(target.path) || (target.kind === 'in-place' && src.kind === 'json')) {
    bytes = new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n');
  } else {
    const assets = new Map<string, { bytes: Uint8Array; mime: string }>();
    const missing: string[] = [];
    for (const hash of referencedAssets(doc)) {
      const found = src.asset(hash) ?? extra?.get(hash) ?? null;
      if (found) assets.set(hash, found);
      else missing.push(hash);
    }
    if (missing.length) {
      throw invalid('asset_missing', 'The map refers to ' + missing.length + ' picture' + (missing.length === 1 ? '' : 's') + ' whose bytes are not available (' + missing[0].slice(0, 12) + '…); nothing was written.',
        { hint: 'Use a picture hash already embedded in this map, or attach the picture through a spec with assets.' });
    }
    bytes = await portableBundle(doc, assets);
  }
  if (target.kind === 'in-place') {
    // Revision precondition: the file must still hold what was read.
    const now = await openMap(src.path, { connection: null });
    if (now.revision !== src.revision) {
      throw conflict('revision_mismatch', basename(src.path) + ' changed while the batch was prepared; nothing was written.',
        { hint: 'Read it again and retry.', details: { applied: 0, currentRevision: normalRevision(now.revision) } });
    }
    writeAtomic({ path: src.path, exists: true }, bytes, true);
    written = src.path;
  } else {
    const out = prepareOutput(target.path, { replace: target.replace, root: flagString(ctx.args, 'root') });
    writeAtomic(out, bytes, target.replace && out.exists);
    written = out.path;
  }
  const revision = 'sha256:' + sha256(serializeDoc(doc));
  const data = { ...run.reply, ...base, output: written, revision, previousRevision,
    undo: target.kind === 'in-place' ? 'Bundles keep no operation log; keep a copy (-o writes a new file) to go back.' : 'The input file is unchanged.' };
  return { type, data, text: summaryText(data) };
}

function referencedAssets(doc: Doc): Set<string> {
  const out = new Set<string>();
  for (const n of Object.values(doc.nodes)) {
    if (n.imageAsset) out.add(n.imageAsset);
    for (const art of [n.pictureArt, n.svgArt, n.artReference]) if (art?.assetHash) out.add(art.assetHash);
  }
  for (const e of doc.canvas?.elements ?? []) if (e.asset) out.add(e.asset);
  return out;
}

function summaryText(d: Record<string, unknown>): string {
  const created = Object.entries((d.created ?? {}) as Record<string, string>).map(([k, v]) => k + '=' + v).join(', ');
  return (d.status === 'dry_run' ? 'Dry run: ' : 'Applied: ') + String(d.applied ?? 0) + ' ops (' + String(d.ops ?? 0) + ' changes) on ' + String(d.backend) +
    (created ? '; created ' + created : '') + (d.output ? '; wrote ' + String(d.output) : '') + '; revision ' + String(d.revision ?? '').slice(0, 19) + '…' +
    (Array.isArray(d.warnings) && d.warnings.length ? '\nWarnings:\n  ' + d.warnings.join('\n  ') : '');
}

export async function editCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const value = await readBatchInput(ctx);
  if (isLegacy(value)) return legacyEdit(path, value);
  const batch = withFlags(ctx, parseBatch(value));
  const src = await openMap(path);
  return commitBatch(ctx, src, batch);
}

export async function applyCommand(ctx: Ctx): Promise<CommandResult> {
  const [specPath, mapPath] = ctx.args.positionals;
  const loaded = await loadSpec(specPath === '-' ? '-' : existingFile(specPath, 'spec'), {
    strict: flagBool(ctx.args, 'strict'), allowGeometry: flagBool(ctx.args, 'allow-geometry'), now: flagString(ctx.args, 'now'), root: flagString(ctx.args, 'root')
  });
  const errors = loaded.compiled.diagnostics.filter((d) => d.severity === 'error');
  if (!loaded.compiled.doc || errors.length) {
    throw new CliError('invalid_spec', EXIT.invalid, 'The spec has ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + '.',
      { details: { diagnostics: loaded.compiled.diagnostics }, hint: 'radiant validate ' + quoteArg(loaded.path) });
  }
  const src = await openMap(mapPath);
  const mode = (flagString(ctx.args, 'mode') ?? 'merge') as 'merge' | 'replace';
  const at = flagString(ctx.args, 'at');
  const spec = loaded.parsed.spec;
  let plan;
  try {
    plan = planApply(src.doc, loaded.compiled.doc, { mode, at, meta: {
      title: spec.title !== undefined, theme: spec.theme !== undefined, themeSettings: spec.themeSettings !== undefined,
      tagColors: spec.tagColors !== undefined, seed: spec.seed !== undefined } });
  } catch (e) {
    if (e instanceof AgentOpError) throw batchError(e.toJSON() as never, src.path);
    throw e;
  }
  const summary = { mode, ...(at ? { at } : {}), ...plan.summary };
  if (!plan.ops.length) {
    const data = { status: 'unchanged', backend: src.backend, path: src.path, applied: 0, ops: 0, plan: summary, revision: normalRevision(src.revision), warnings: plan.warnings };
    return { type: 'apply.result', data, text: 'The map already matches the spec; nothing to apply.' };
  }
  const batch = withFlags(ctx, parseBatch({ label: 'Apply ' + basename(loaded.path === '-' ? 'spec' : loaded.path), ops: plan.ops }));
  const extra = new Map(loaded.assets.map((a) => [a.hash, { bytes: a.bytes, mime: a.mime }]));
  const result = await commitBatch(ctx, src, batch, extra, 'apply.result');
  const data: Record<string, unknown> = { ...(result.data as Record<string, unknown>), plan: summary, ...(flagBool(ctx.args, 'show-ops') ? { planned: plan.ops } : {}) };
  data.warnings = [...((data.warnings as string[] | undefined) ?? []), ...plan.warnings];
  return { ...result, data, text: result.text + '\nPlan: ' + Object.entries(plan.summary).filter(([, n]) => n).map(([k, n]) => k + ' ' + n).join(', ') };
}

export async function undoCommand(ctx: Ctx): Promise<CommandResult> {
  const [path] = ctx.args.positionals;
  const tx = flagString(ctx.args, 'tx');
  if (!tx) throw usageError('undo needs --tx with the transaction an edit reported.', { hint: 'radiant undo MAP --tx agent:cli:1a2b3c4d' });
  const connection = liveConnection();
  const canonical = path === LIVE_MAP ? connection?.path ?? LIVE_MAP : existingFile(path, 'map');
  if (!connection || connection.path !== canonical) {
    throw conflict('no_operation_log', 'Undo works on an open, granted map, where it reverts the agent\'s own latest change. Files written by this tool keep no operation log.',
      { hint: 'Keep the previous file: edit with -o writes a new one and leaves the input unchanged.' });
  }
  let result: unknown;
  try { result = await requestUndo(connection, tx); } catch (e) { throw liveError(e); }
  const r = (result ?? {}) as { reply?: Record<string, unknown>; error?: Record<string, unknown> };
  if (r.error) throw batchError(r.error as never, canonical);
  return { type: 'undo.result', data: { backend: 'live', path: canonical, ...r.reply }, text: 'Undid ' + tx + '.' };
}

