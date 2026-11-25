/** Platform-independent provider contract for text requests, image requests, and streamed results. */
export interface AiCapabilities {
  streaming: boolean;
  images: boolean;
  rateLimits: boolean;
}

export interface AiStatus {
  capabilities?: AiCapabilities; // absent when provider discovery fails
  available: boolean; // codex binary found and app-server initialised
  fallbackAvailable?: boolean;
  provider?: 'codex' | 'replay';
  versionWarning?: string;
  version?: string; // e.g. "codex-cli 0.167.0"
  error?: string; // human-readable reason when not available
  errorCode?: AiErrorCode;
  rateLimits?: RateLimits;
}

export interface RateLimits {
  limitReason?: AiAllowanceError;
  /** Percent used of the primary (short) window, and of the secondary (weekly) window, if reported. */
  primaryUsedPercent?: number;
  secondaryUsedPercent?: number;
  resetsAt?: string;
  planType?: string;
  primaryWindowMinutes?: number;
  secondaryWindowMinutes?: number;
  primaryResetsAt?: string;
  secondaryResetsAt?: string;
  raw?: unknown;
}

export interface AiTurnRequest {
  /** 'text' for map generation and edits; 'image' asks the model to use its image tool and return one picture. */
  kind: 'text' | 'image';
  /** Per-turn opt-in. Omitted requests run with web search disabled. */
  webSearch?: boolean;
  /** System-style instructions (output contract, style rules). Sent as developer instructions where supported. */
  instructions: string;
  /** The user-facing task, e.g. "Topic: Photosynthesis. Style: watercolour, Buzan". */
  prompt: string;
  model?: string; // default chosen by host
  effort?: 'low' | 'medium' | 'high';
  /** Optional JSON schema for structured output (non-streaming fallback). */
  outputSchema?: unknown;
  /** For whole-map requests only. The host chooses this schema prompt before dispatching a model turn. */
  execFallbackPrompt?: string;
  preferExecFallback?: boolean;
  /** Let completed map streams await a same-thread repair decision. */
  repairMap?: boolean;
  mapLimits?: { maxDepth: number; maxChildren: number };
  templateVersion?: string;
  /** Asset hashes of reference images to attach (image kind). */
  refImages?: string[];
}

export interface AiUsage { inputTokens?: number; outputTokens?: number }

export type AiEvent =
  | { jobId: string; kind: 'started'; route?: 'stream' | 'exec' | 'replay'; templateVersion?: string; model?: string }
  | { jobId: string; kind: 'delta'; text: string } // streamed text chunk, in order
  | { jobId: string; kind: 'image'; assetHash: string; revisedPrompt?: string; seed?: number }
  | { jobId: string; kind: 'warning'; message: string }
  | { jobId: string; kind: 'mapRoundDone' }
  | { jobId: string; kind: 'done'; text?: string; usage?: AiUsage } // terminal text from a non-streaming turn
  | { jobId: string; kind: 'cancelled'; usage?: AiUsage }
  | { jobId: string; kind: 'error'; code: AiErrorCode; message: string; usage?: AiUsage }
  | { jobId: ''; kind: 'rateLimits'; rateLimits: RateLimits };

export type AiAllowanceError = 'rate_limited' | 'usage_exhausted' | 'credits_depleted';

export type AiErrorCode =
  | AiAllowanceError
  | 'not_installed'
  | 'not_logged_in'
  | 'offline'
  | 'protocol'
  | 'timeout'
  | 'transient'
  | 'stream_interrupted'
  | 'process_exited'
  | 'other';

export interface AiQueueJob {
  id: string;
  activity: 'generate' | 'expand' | 'refine' | 'svg' | 'picture' | 'text';
  state: 'running' | 'queued';
  owned: boolean;
}

export interface AiQueue {
  revision: number;
  limit: number;
  jobs: AiQueueJob[];
}

/** The only route to AI operations. */
export interface AiProvider {
  aiStatus(refreshLimits?: boolean): Promise<AiStatus>;
  aiStartTurn(req: AiTurnRequest): Promise<string>;
  aiCancel(jobId: string): Promise<void>;
  aiResolveMapRound?(jobId: string, prompt?: string): Promise<void>;
  onAiEvent(cb: (e: AiEvent) => void): Promise<() => void>;
  onAiQueue?(cb: (queue: AiQueue) => void): Promise<() => void>;
  aiShutdown?(): Promise<void>;
}
