import mapTemplate from './templates/map.json';
import { fill } from './template';

const MAX_REPAIR_LINES = 12;
export const MAX_MAP_REPAIRS = 2;

interface Rejection {
  line: string;
  reason: string;
  expectedId?: string;
}

/** Retains only a bounded set of rejected output, never the source material or unrelated document data. */
export class MapRepair {
  private pending = new Map<number, Rejection>();
  private uncaptured = 0;
  private rejected = 0;
  attempts = 0;

  get unrepaired(): number { return this.pending.size + this.uncaptured; }

  reject(line: string, reason: string, expectedId?: string, repairable = true): void {
    if (this.attempts) return;
    const repair = ++this.rejected;
    if (repairable && this.pending.size < MAX_REPAIR_LINES) {
      if (!expectedId) {
        try {
          const id = JSON.parse(line)?.id;
          if (typeof id === 'string' && id.trim()) expectedId = id.trim();
          else if (typeof id === 'number') expectedId = String(id);
        } catch { /* A syntactically invalid line may not have a recoverable ID. */ }
      }
      const boundedId = expectedId && expectedId.length <= 180 ? expectedId : undefined;
      this.pending.set(repair, { line: line.slice(0, 400), reason: reason.slice(0, 180), expectedId: boundedId });
    } else this.uncaptured++;
  }

  allows(slot: number | undefined, id: string): boolean {
    if (slot === undefined) return false;
    const target = this.pending.get(slot);
    return !!target && (target.expectedId === undefined || target.expectedId === id);
  }

  received(slot: number | undefined): void {
    if (slot !== undefined) this.pending.delete(slot);
  }

  nextPrompt(): string | undefined {
    if (!this.pending.size || this.attempts >= MAX_MAP_REPAIRS) return;
    this.attempts++;
    const rejected = [...this.pending].map(([repair, row]) => ({ repair, ...row }));
    const template = mapTemplate.repair;
    return [
      template.role, template.output, template.example, template.rules, template.style,
      fill(template.task, { rejected: JSON.stringify(rejected) })
    ].join('\n');
  }
}
