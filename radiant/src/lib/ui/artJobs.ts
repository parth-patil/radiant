import type { AiErrorCode, AiEvent, AiTurnRequest, Host } from '../host/types';

type JobEvent = Exclude<AiEvent, { kind: 'rateLimits' }>;
interface TurnResult {
  id: string;
  text: string;
  model?: string;
  image?: Extract<JobEvent, { kind: 'image' }>;
}

export class ArtTurnError extends Error {
  constructor(readonly code: AiErrorCode, message: string) { super(message); }
}

interface ArtTurnCallbacks {
  /** Starts the turn; the controller's startAiTurn, so text turns get the chosen engine. */
  start(req: AiTurnRequest): Promise<string>;
  beforeStart(): void;
  onSubmitted(id: string): void;
  onWarning(message: string): void;
}

export async function runArtTurn(host: Host, req: AiTurnRequest, signal: AbortSignal, callbacks: ArtTurnCallbacks): Promise<TurnResult> {
  signal.throwIfAborted();
  let id: string | undefined;
  let result: TurnResult | undefined;
  let complete: ((result: TurnResult) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const pending: JobEvent[] = [];
  const maxOutput = 240_000;
  let pendingSize = 0;
  let pendingOverflow = false;
  const cancelJob = () => { if (id) void host.aiCancel(id).catch(() => {}); };
  const handle = (event: JobEvent) => {
    if (event.jobId !== id || !result) return;
    if (event.kind === 'started') {
      result.model = event.model;
    } else if (event.kind === 'warning') {
      callbacks.onWarning(event.message);
    } else if (event.kind === 'delta') {
      result.text += event.text;
      if (result.text.length > maxOutput) {
        fail?.(new ArtTurnError('protocol', 'The artwork response exceeded its size limit.'));
        cancelJob();
      }
    } else if (event.kind === 'image') {
      result.image ??= event;
    } else if (event.kind === 'done') {
      if (event.text !== undefined) result.text = event.text;
      if (result.text.length > maxOutput) fail?.(new ArtTurnError('protocol', 'The artwork response exceeded its size limit.'));
      else complete?.(result);
    } else if (event.kind === 'cancelled') {
      fail?.(new DOMException('Artwork generation was cancelled.', 'AbortError'));
    } else if (event.kind === 'error') {
      fail?.(new ArtTurnError(event.code, event.message));
    }
  };
  const off = await host.onAiEvent((event) => {
    if (event.kind === 'rateLimits') return;
    if (id) handle(event);
    else {
      pendingSize += event.kind === 'delta' || event.kind === 'done' ? (event.text?.length ?? 64) : 64;
      if (pendingSize <= maxOutput) pending.push(event);
      else pendingOverflow = true;
    }
  });
  const abort = () => {
    cancelJob();
    fail?.(signal.reason);
  };
  try {
    signal.throwIfAborted();
    callbacks.beforeStart();
    id = await callbacks.start(req);
    callbacks.onSubmitted(id);
    if (signal.aborted) {
      cancelJob();
      signal.throwIfAborted();
    }
    if (pendingOverflow && pending.some((event) => event.jobId === id)) {
      cancelJob();
      throw new ArtTurnError('protocol', 'The artwork response exceeded its size limit.');
    }
    result = { id, text: '' };
    return await new Promise<TurnResult>((resolve, reject) => {
      complete = resolve;
      fail = reject;
      signal.addEventListener('abort', abort, { once: true });
      for (const event of pending) handle(event);
      pending.length = 0;
    });
  } finally {
    signal.removeEventListener('abort', abort);
    off();
  }
}
