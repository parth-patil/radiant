import { MAX_MAP_REPAIRS } from '../core/ai/map-repair';
import { previewPicture, previewSvg } from './mock-art';
import { previewRefinement } from './mock-refine';
import type { AiCapabilities } from '../core/ai/provider';
import type { AiEvent, AiProvider, AiTurnRequest, Unlisten } from './types';

type Retrace<T> = T extends { jobId: string } ? Omit<T, 'jobId'> : never;
export interface ReplayFrame {
  delay: number;
  event: Retrace<Exclude<AiEvent, { kind: 'rateLimits' }>>;
}
export type ReplayLog = (request: AiTurnRequest, sequence: number) => readonly ReplayFrame[] | undefined;
/** Decodes the replay frames in a native diagnostic JSONL trace. */
export function decodeReplayFrames(jsonl: string): ReplayFrame[] {
  const frames: ReplayFrame[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row: { kind?: unknown; delay?: unknown; event?: Partial<ReplayFrame['event']> } = JSON.parse(line);
    if (row == null || typeof row !== 'object') throw new Error('Invalid replay record');
    if (row.kind === 'output') throw new Error('This trace was recorded without replay text');
    if (!row.event) continue;
    const event = row.event;
    const kind = event.kind;
    const valid = kind === 'started' || kind === 'mapRoundDone' || (kind === 'done' && (event.text === undefined || typeof event.text === 'string')) || kind === 'cancelled' ||
      (kind === 'delta' && typeof event.text === 'string') ||
      (kind === 'image' && typeof event.assetHash === 'string') ||
      (kind === 'warning' && typeof event.message === 'string') ||
      (kind === 'error' && typeof event.code === 'string' && typeof event.message === 'string');
    if (!valid || typeof row.delay !== 'number' || !Number.isFinite(row.delay) || row.delay < 0) {
      throw new Error('Invalid replay frame');
    }
    frames.push({ delay: row.delay, event: event as ReplayFrame['event'] });
  }
  const end = frames.at(-1)?.event.kind;
  if (end !== 'done' && end !== 'cancelled' && end !== 'error') throw new Error('Incomplete replay trace');
  return frames;
}

type PictureStore = (bytes: Uint8Array, mime: string) => Promise<string>;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Canned map about a topic, as node lines (one JSON object per line). */
function cannedMap(topic: string): string[] {
  const t = topic.trim().replace(/\s+/g, ' ').slice(0, 60) || 'New idea';
  const branches: [string, string[]][] = [
    ['Overview', ['What it is', 'Why it matters', 'Key terms']],
    ['History', ['Origins', 'Turning points', 'Today']],
    ['Key ideas', ['Core principle', 'Common examples', 'Misconceptions']],
    ['How to start', ['First steps', 'Useful tools', 'Pitfalls to avoid']],
    ['Open questions', ['What is unknown', 'Where it is heading']]
  ];
  const lines: string[] = [JSON.stringify({ id: 'n1', parent: null, title: t })];
  let n = 2;
  for (const [title, kids] of branches) {
    const id = `n${n++}`;
    lines.push(JSON.stringify({ id, parent: 'n1', title }));
    for (const k of kids) lines.push(JSON.stringify({ id: `n${n++}`, parent: id, title: `${k}: ${t}`.slice(0, 70) }));
  }
  return lines.map((l) => l + '\n');
}

/** Canned new nodes under one node: as many first-level nodes and levels as the request asks for. */
function cannedBranches(request: AiTurnRequest, parent: string): string[] {
  const count = Number(request.prompt.match(/Write (\d+) new child nodes/)?.[1] ?? 4);
  const levels = Number(request.instructions.match(/new levels in total: (\d+)/)?.[1] ?? 1);
  const titles = ['Examples', 'Applications', 'Challenges', 'Next steps', 'Background', 'People', 'Resources'];
  const lines: string[] = [];
  let n = 0;
  const add = (title: string, to: string, level: number) => {
    const id = `n${++n}`;
    lines.push(JSON.stringify({ id, parent: to, title }) + '\n');
    if (level < levels) for (const part of ['Basics', 'In practice']) add(`${part}: ${title}`.slice(0, 70), id, level + 1);
  };
  for (const title of titles.slice(0, Math.max(1, count))) add(title, parent, 1);
  return lines;
}

/** Offline provider for recorded event sequences and deterministic built-in previews. */
export class ReplayProvider implements AiProvider {
  private listeners = new Set<(event: AiEvent) => void>();
  private jobs = new Map<string, AbortController>();
  private sequence = 0;
  private decisions = new Map<string, (prompt?: string) => void>();

  constructor(
    private storePicture: PictureStore,
    private log?: ReplayLog,
    private capabilities: AiCapabilities = { streaming: true, images: true, rateLimits: false }
  ) {}

  private emit(event: AiEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async aiStatus() {
    return { available: true, provider: 'replay' as const, version: 'Replay preview', capabilities: this.capabilities };
  }

  async aiStartTurn(request: AiTurnRequest): Promise<string> {
    if (request.kind === 'image' && !this.capabilities.images) throw new Error('This provider does not support image generation.');
    const sequence = ++this.sequence;
    const id = `replay-${sequence}`;
    const abort = new AbortController();
    this.jobs.set(id, abort);
    void this.play(id, request, sequence, abort.signal);
    return id;
  }

  async aiResolveMapRound(id: string, prompt?: string): Promise<void> {
    const resolve = this.decisions.get(id);
    if (!resolve) throw new Error('Replay is not waiting for a repair decision.');
    resolve(prompt);
  }

  private decide(id: string, signal: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      const stop = () => finish();
      const finish = (prompt?: string) => {
        this.decisions.delete(id);
        signal.removeEventListener('abort', stop);
        resolve(prompt);
      };
      if (signal.aborted) return finish();
      this.decisions.set(id, finish);
      signal.addEventListener('abort', stop, { once: true });
      this.emit({ jobId: id, kind: 'mapRoundDone' });
    });
  }

  async aiCancel(id: string): Promise<void> {
    this.jobs.get(id)?.abort();
  }

  async aiShutdown(): Promise<void> {
    for (const job of this.jobs.values()) job.abort();
  }

  async onAiEvent(listener: (event: AiEvent) => void): Promise<Unlisten> {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private async play(jobId: string, request: AiTurnRequest, sequence: number, signal: AbortSignal): Promise<void> {
    let terminal = false;
    try {
      let frames = this.log?.(request, sequence) ?? await this.preview(request);
      let round = 0;
      let route: 'stream' | 'exec' | 'replay' | undefined;
      for (let cursor = 0; cursor < frames.length; cursor++) {
        const { delay, event } = frames[cursor];
        await wait(delay, signal);
        if (signal.aborted) break;
        if (event.kind === 'started') route = event.route ?? route;
        if (event.kind === 'mapRoundDone' ||
            event.kind === 'done' && this.capabilities.streaming && request.repairMap && route !== 'exec' && round < MAX_MAP_REPAIRS) {
          const prompt = request.repairMap && round < MAX_MAP_REPAIRS ? await this.decide(jobId, signal) : undefined;
          if (signal.aborted) break;
          if (!prompt) {
            if (event.kind === 'done') this.emit({ ...event, jobId });
            else {
              const done = frames.findLast((row) => row.event.kind === 'done')?.event;
              this.emit({ ...(done?.kind === 'done' ? done : { kind: 'done' as const }), jobId });
            }
            terminal = true;
            return;
          }
          round++;
          if (event.kind === 'mapRoundDone') continue;
          const next = this.log?.({ ...request, prompt }, sequence);
          if (!next) throw new Error('No correction turn was recorded for this replay.');
          frames = next;
          cursor = -1;
          continue;
        }
        terminal = event.kind === 'done' || event.kind === 'error' || event.kind === 'cancelled';
        if (event.kind !== 'started' || round === 0) this.emit({ ...event, jobId } as AiEvent);
        if (terminal) return;
      }
      const event = signal.aborted ? { kind: 'cancelled' } as const : { kind: 'done' } as const;
      this.emit({ ...event, jobId });
    } catch (error) {
      if (!terminal) {
        if (signal.aborted) this.emit({ jobId, kind: 'cancelled' });
        else this.emit({ jobId, kind: 'error', code: 'other', message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      this.jobs.delete(jobId);
    }
  }

  private async preview(request: AiTurnRequest): Promise<ReplayFrame[]> {
    const frames: ReplayFrame[] = [
      { delay: 45, event: { kind: 'started', route: 'replay', templateVersion: request.templateVersion, model: request.model ?? 'Replay preview' } }
    ];
    if (request.kind === 'image') {
      const assetHash = await this.storePicture(await previewPicture(request.prompt), 'image/png');
      frames.push({ delay: 250, event: { kind: 'image', assetHash } });
    } else {
      const structured = previewRefinement(request) ?? (request.instructions.includes('SVG CONTRACT') ? previewSvg(request.prompt) : null);
      const topic = request.prompt.replace(/^\s*Topic:\s*/i, '').split(/[\n.]/)[0];
      const target = request.prompt.match(/^Node to expand: .* \(id "([^"]+)"\)$/m);
      const lines = target ? cannedBranches(request, target[1]) : cannedMap(topic);
      const text = structured ?? lines.join('');
      if (!this.capabilities.streaming) {
        frames.push({ delay: 600, event: { kind: 'done', text } });
        return frames;
      }
      if (structured !== null) {
        frames.push({ delay: 45, event: { kind: 'delta', text } });
      } else {
        for (let i = 0; i < text.length; i += 20) {
          frames.push({ delay: 32, event: { kind: 'delta', text: text.slice(i, i + 20) } });
        }
      }
    }
    frames.push({ delay: 0, event: { kind: 'done' } });
    return frames;
  }
}
