import type { ReminderScope, ReminderCompletion } from '../host/reminders';
import type { AppController } from './controller.svelte';
import type { Doc } from '../core/types';

type ActiveMap = { doc: Doc; scope: ReminderScope };

export class RemindersSync {
  private active = $state.raw<ActiveMap | null>(null);
  private links = $state.raw<Set<string>>(new Set());
  private pending = false;
  busy = $state(false);
  error = $state('');

  constructor(private readonly c: AppController) {}

  private current(): ActiveMap | null {
    const { c } = this;
    return c.ready && c.filePath && c.host.reminders
      ? { doc: c.doc, scope: { path: c.filePath, documentId: c.doc.id } }
      : null;
  }

  private matches(map: ActiveMap): boolean {
    return this.c.doc === map.doc && this.c.filePath === map.scope.path;
  }

  linked(node: string): boolean {
    return !!this.active && this.matches(this.active) && this.links.has(node);
  }

  start(): () => void {
    if (!this.c.host.reminders) return () => {};
    const update = () => { void this.refresh(); };
    const timer = window.setInterval(update, 3000);
    window.addEventListener('focus', update);
    update();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }

  async refresh(): Promise<void> {
    const host = this.c.host.reminders;
    const map = this.current();
    if (!host || !map || this.pending || this.busy || this.c.editor.waitingForCommit || this.c.quitPending) return;
    this.pending = true;
    if (!this.active || !this.matches(this.active)) {
      this.active = map;
      this.links = new Set();
      this.error = '';
    }
    try {
      const nodes = await host.links(map.scope);
      if (!this.matches(map)) return;
      this.links = new Set(nodes);
      const tasks = nodes.flatMap(node => {
        const task = map.doc.nodes[node]?.task;
        return task ? [{ node, done: task.done }] : [];
      });
      if (tasks.length === 0) return;
      const results = await host.sync(map.scope, tasks);
      if (!this.matches(map)) return;
      const expected = new Map(tasks.map(({ node, done }) => [node, done]));
      const remote: ReminderCompletion[] = [];
      this.error = '';
      for (const result of results) {
        if ('Err' in result) this.error ||= result.Err;
        else if (expected.get(result.Ok.node) !== result.Ok.done) remote.push(result.Ok);
      }
      if (!remote.length || !await this.c.editor.settled() ||
          !this.matches(map) || this.busy || this.c.quitPending || this.c.editor.waitingForCommit) return;
      const applied = remote.filter(({ node, done }) => {
        const task = map.doc.nodes[node]?.task;
        return this.links.has(node) && task && task.done !== done && task.done === expected.get(node);
      });
      this.c.editor.apply({ label: 'Sync Reminders completion', source: 'user',
        ops: applied.map(({ node, done }) => ({ t: 'set', id: node, patch: { task: { done } } })) });
      if (applied.length && await this.c.editor.settled() && this.matches(map)) {
        await host.acknowledge(map.scope, applied);
      }
    } catch (error) {
      if (this.matches(map)) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.pending = false;
    }
  }

  async changeLink(node: string, requestAccess = false): Promise<void> {
    const host = this.c.host.reminders;
    const map = this.current();
    if (!host || !map || this.busy || this.c.quitPending) return;
    const item = map.doc.nodes[node];
    if (!item) return;
    this.busy = true;
    this.error = '';
    try {
      if (this.linked(node) && !requestAccess) await host.disconnect(map.scope, node);
      else if (item.task) await host.connect(map.scope, node, item.text, item.task.done);
    } catch (error) {
      if (this.matches(map)) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
    if (this.matches(map) && !this.error) await this.refresh();
  }
}
