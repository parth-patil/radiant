/**
 * Front-end tracker for AI jobs: a plain value plus a pure reducer over host `ai-event`s. No Tauri imports; the
 * host agent supplies the events through `Host.onAiEvent`.
 */
import type { AiErrorCode, AiEvent, AiTurnRequest, AiUsage } from './provider';

export type AiJobKind = 'generate' | 'expand' | 'refine' | 'svg' | 'image' | 'other';
export type AiJobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface AiJob {
  id: string;
  kind: AiJobKind;
  status: AiJobStatus;
  route?: 'stream' | 'exec' | 'replay';
  model?: string;
  request?: Pick<AiTurnRequest, 'templateVersion' | 'instructions' | 'prompt' | 'execFallbackPrompt' | 'webSearch'>;
  /** Updated by the UI through `addNodes` as the applier accepts nodes. */
  nodesAdded: number;
  /** Lines the parser or applier rejected. */
  nodesRejected: number;
  /** Epoch ms of registration (queued) or of the first event if the job was never registered. */
  startedAt: number;
  /** Epoch ms of the terminal event. */
  endedAt?: number;
  error?: { code: AiErrorCode; message: string };
  usage?: AiUsage;
  /** Asset hashes of generated images. */
  images: string[];
}

export type AiJobs = Readonly<Record<string, AiJob>>;

export const isTerminal = (s: AiJobStatus): boolean => s === 'done' || s === 'error' || s === 'cancelled';

function blank(id: string, now: number, kind: AiJobKind = 'other'): AiJob {
  return { id, kind, status: 'queued', nodesAdded: 0, nodesRejected: 0, startedAt: now, images: [] };
}

/** Registers a job right after `host.aiStartTurn` returned its id. Safe if events already arrived. */
export function registerJob(jobs: AiJobs, id: string, kind: AiJobKind, now: number = Date.now(), request?: AiJob['request']): AiJobs {
  const prev = jobs[id];
  return { ...jobs, [id]: { ...(prev ?? blank(id, now, kind)), kind, request } };
}

/** Adds counts after applying stream nodes. */
export function addNodes(jobs: AiJobs, id: string, added: number, rejected = 0): AiJobs {
  const j = jobs[id];
  if (!j) return jobs;
  return { ...jobs, [id]: { ...j, nodesAdded: j.nodesAdded + added, nodesRejected: j.nodesRejected + rejected } };
}

/** Reduces one host event into the job table. Terminal states are final. `rateLimits` events are ignored here. */
export function applyAiEvent(jobs: AiJobs, event: AiEvent, now: number = Date.now()): AiJobs {
  if (event.kind === 'rateLimits') return jobs;
  const prev = jobs[event.jobId] ?? blank(event.jobId, now);
  if (isTerminal(prev.status)) {
    // Local cancellation can precede the provider's final token counts.
    if ('usage' in event && event.usage) {
      return { ...jobs, [event.jobId]: { ...prev, usage: { ...prev.usage, ...event.usage } } };
    }
    return jobs;
  }
  let next: AiJob = prev;
  switch (event.kind) {
    case 'started':
      next = { ...prev, status: 'running', route: event.route, model: event.model };
      break;
    case 'delta':
      next = prev.status === 'running' ? prev : { ...prev, status: 'running' };
      break;
    case 'image':
      next = { ...prev, status: 'running', images: [...prev.images, event.assetHash] };
      break;
    case 'done':
      next = { ...prev, status: 'done', endedAt: now, usage: event.usage };
      break;
    case 'cancelled':
      next = { ...prev, status: 'cancelled', endedAt: now, usage: event.usage };
      break;
    case 'error':
      next = { ...prev, status: 'error', endedAt: now, usage: event.usage, error: { code: event.code, message: event.message } };
      break;
  }
  return next === prev ? jobs : { ...jobs, [event.jobId]: next };
}
