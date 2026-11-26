import type { AiJobRecord } from '../types';

export const AI_JOB_WARNING_LIMIT = 24;
export const AI_PROMPT_LIMIT = 1_000_000;
const KINDS = ['generate', 'expand', 'refine'] as const;
const ENGINES = ['codex', 'claude', 'antigravity'] as const;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const ROUTES = ['stream', 'exec', 'replay'] as const;
const STATES = ['running', 'done', 'cancelled', 'error'] as const;

function has<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !!value.trim();
}
function tokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validAiJobId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id) && id !== 'constructor' && id !== 'prototype';
}

export function parseAiJobRecord(raw: unknown): AiJobRecord | undefined {
  if (!object(raw) || !has(KINDS, raw.kind) || !has(STATES, raw.status) ||
      !text(raw.prompt, AI_PROMPT_LIMIT) || !text(raw.created, 40) || !Number.isFinite(Date.parse(raw.created))) return;
  const value: AiJobRecord = { kind: raw.kind, status: raw.status, prompt: raw.prompt, created: raw.created };
  if (raw.status === 'error' && raw.interrupted === true) value.interrupted = true;
  if (typeof raw.webSearch === 'boolean') value.webSearch = raw.webSearch;
  if (has(ROUTES, raw.route)) value.route = raw.route;
  if (has(['node', 'branch', 'map'] as const, raw.scope)) value.scope = raw.scope;
  if (has(EFFORTS, raw.effort)) value.effort = raw.effort;
  if (has(ENGINES, raw.engine)) value.engine = raw.engine;
  for (const key of ['model', 'templateVersion', 'scopeId'] as const) {
    if (text(raw[key], 256)) value[key] = raw[key];
  }
  for (const key of ['instructions', 'fallbackPrompt'] as const) {
    if (text(raw[key], AI_PROMPT_LIMIT)) value[key] = raw[key];
  }
  if (Array.isArray(raw.warnings)) {
    const warnings = raw.warnings.slice(0, AI_JOB_WARNING_LIMIT).filter((item): item is string => text(item, 256));
    if (warnings.length) value.warnings = [...new Set(warnings)];
  }
  if (object(raw.limits) && tokens(raw.limits.maxDepth) && tokens(raw.limits.maxChildren) &&
      raw.limits.maxDepth >= 1 && raw.limits.maxDepth <= 6 && raw.limits.maxChildren >= 1 && raw.limits.maxChildren <= 7) {
    value.limits = { maxDepth: raw.limits.maxDepth, maxChildren: raw.limits.maxChildren };
  }
  if (object(raw.usage)) {
    const { inputTokens, outputTokens } = raw.usage;
    if (tokens(inputTokens) || tokens(outputTokens)) {
      value.usage = {};
      if (tokens(inputTokens)) value.usage.inputTokens = inputTokens;
      if (tokens(outputTokens)) value.usage.outputTokens = outputTokens;
    }
  }
  return value;
}

export function parseAiJobs(raw: unknown): Record<string, AiJobRecord> | undefined {
  if (!object(raw)) return;
  const jobs: Record<string, AiJobRecord> = Object.create(null);
  for (const [id, source] of Object.entries(raw)) {
    if (!validAiJobId(id)) continue;
    const job = parseAiJobRecord(source);
    if (job) jobs[id] = job;
  }
  return Object.keys(jobs).length ? jobs : undefined;
}

/** Capture the actual request once and link each affected node to its job ID. */
export function captureAiJob(
  kind: AiJobRecord['kind'],
  request: import('../ai/provider').AiTurnRequest,
  scopeId?: string,
  limits?: AiJobRecord['limits']
): AiJobRecord {
  return {
    kind, scopeId, limits, status: 'running', created: new Date().toISOString(),
    prompt: request.prompt, instructions: request.instructions,
    fallbackPrompt: request.execFallbackPrompt, templateVersion: request.templateVersion,
    webSearch: request.webSearch, engine: request.engine, model: request.model, effort: request.effort
  };
}

/** Keep provenance for the exported nodes without including other branches' job prompts. */
export function referencedAiJobs(
  nodes: import('../types').Doc['nodes'], jobs: import('../types').Doc['aiJobs']
): import('../types').Doc['aiJobs'] {
  if (!jobs) return;
  const ids = new Set<string>();
  for (const node of Object.values(nodes)) {
    if (node.origin?.by === 'ai') ids.add(node.origin.job);
    if (node.lastAiJob) ids.add(node.lastAiJob);
  }
  const entries = [...ids].flatMap((id) => Object.hasOwn(jobs, id) ? [[id, jobs[id]] as const] : []);
  return entries.length ? Object.fromEntries(entries) : undefined;
}
