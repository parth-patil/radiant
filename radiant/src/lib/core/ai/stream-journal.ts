import type { NodeId } from '../types';

const MAX_STREAM_LENGTH = 4 * 1024 * 1024;
const MAX_CHUNKS = 32_768;

/** In-memory source for a map turn, including rejected and unfinished text. */
export class StreamJournal {
  private readonly received: string[] = [];
  private length = 0;
  private readonly applied: { id: NodeId; line: string }[] = [];

  append(text: string, limit = MAX_STREAM_LENGTH): boolean {
    if (this.length + text.length > limit || this.received.length >= MAX_CHUNKS) return false;
    this.received.push(text);
    this.length += text.length;
    return true;
  }

  get latest(): string {
    return this.received.at(-1) ?? '';
  }

  text(): string {
    return this.received.join('');
  }

  recordApplied(id: NodeId, line: string): void {
    this.applied.push({ id, line });
  }

  get appliedCount(): number {
    return this.applied.length;
  }
}
