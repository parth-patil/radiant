// The live agent session of one window: the grant, the work it receives and the access prompt. It lives with the
// controller, so a grant keeps working when the Inspector is closed (AGT-LIVE-01). The host has already checked
// who may ask (token, document, path, tier, size, rate); this side validates what is asked and applies it.
import { AgentOpError, addChild, runAgentBatch, serializeDoc } from '../core/model';
import type { Doc, NodeId } from '../core/types';
import type { AgentConsentRequest, AgentEdit, AgentGrant, AgentTransport, AgentWork } from '../host/agent';
import type { AppController } from './controller.svelte';

export type AgentAccessLevel = 'read' | 'write' | 'destructive';

export interface AgentLiveSession {
  grant: AgentGrant;
  transport: AgentTransport;
  document: Doc;
  /** The saved file, or "untitled:" plus the document id for a map that has no file yet. */
  path: string;
  writable: boolean;
  destructive: boolean;
  /** The name the agent gave when it asked; absent for a grant made by hand in the Inspector. */
  client?: string;
  expiresAt: number;
}

const failure = (code: string, kind: string, message: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ error: { code, kind, message, applied: 0, suggestions: [], ...extra } });

const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).length <= max && !CONTROLS.test(value);
}

function validEdit(edit: AgentEdit): boolean {
  if (!edit || typeof edit !== 'object') return false;
  if (Object.keys(edit).length !== 3) return false;
  if (edit.type === 'add') return typeof edit.parent === 'string' && validText(edit.text, 1_000) && !!edit.text.trim();
  if (edit.type === 'rename') return typeof edit.id === 'string' && validText(edit.text, 1_000) && !!edit.text.trim();
  if (edit.type === 'set-note') return typeof edit.id === 'string' && validText(edit.note, 8_000);
  return false;
}

/** The live revision: SHA-256 of the document string, as the CLI reports for files. */
async function revisionOf(doc: Doc): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeDoc(doc)));
  return 'sha256:' + Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class AgentSession {
  session = $state.raw<AgentLiveSession | null>(null);
  pending = $state(false);
  status = $state('');
  /** An agent's request for access, waiting for the user's answer. */
  request = $state.raw<AgentConsentRequest | null>(null);
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopListening: (() => void) | undefined;

  constructor(private c: AppController) {}

  get transport(): AgentTransport | undefined {
    return this.c.host.agentAccess;
  }

  /** What a grant for the open map is bound to. */
  private get path(): string {
    return this.c.filePath ?? 'untitled:' + this.c.doc.id;
  }

  /** Start hearing access requests. Called once the window is ready. */
  listen(): void {
    void this.transport?.onConsent?.(
      (request) => { if (!this.disposed) this.request = request; },
      (id) => { if (this.request?.id === id) this.request = null; }
    ).then((stop) => {
      if (this.disposed) stop();
      else this.stopListening = stop;
    }).catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    this.stopListening?.();
    this.revoke();
  }

  /** Answer the waiting request with the access the user chose, or null to decline. */
  async answer(access: AgentAccessLevel | null): Promise<void> {
    const request = this.request;
    const transport = this.transport;
    this.request = null;
    if (!request || !transport?.consent) return;
    if (!access) {
      this.status = 'Declined a request from ' + request.client + '.';
      await transport.consent(request.id, null).catch(() => {});
      return;
    }
    if (this.session) this.revoke('Agent access replaced.');
    const granted = await this.allow(access !== 'read', access === 'destructive', request.client);
    await transport.consent(request.id, granted ? this.session!.grant.id : null, this.c.docTitle).catch(() => {});
  }

  async allow(writable: boolean, destructive = false, client?: string): Promise<boolean> {
    const transport = this.transport;
    if (!transport || this.session || this.pending) return false;
    this.pending = true;
    this.status = '';
    const document = this.c.doc;
    const path = this.path;
    destructive = writable && destructive;
    try {
      const grant = await transport.grant(document.id, path, writable, destructive);
      if (this.disposed || this.c.doc !== document || this.path !== path) {
        await transport.revoke(grant.id);
        return false;
      }
      const current: AgentLiveSession = { grant, transport, document, path, writable, destructive, client, expiresAt: grant.expiresAt };
      this.session = current;
      this.status = destructive ? 'Live reads, edits and deletes enabled for this map.'
        : writable ? 'Live reads and edits enabled for this map.' : 'Live reads enabled for this map.';
      void this.poll(current);
      return true;
    } catch {
      this.status = 'Radiant could not start local agent access.';
      return false;
    } finally {
      this.pending = false;
    }
  }

  revoke(message = 'Agent access turned off.'): void {
    clearTimeout(this.timer);
    const current = this.session;
    this.session = null;
    if (current) {
      this.status = message;
      void current.transport.revoke(current.grant.id).catch(() => {});
    }
  }

  private activeRequest(work: AgentWork, current: AgentLiveSession): boolean {
    const c = this.c;
    return this.session === current && c.doc === current.document && c.doc.id === work.documentId &&
      this.path === current.path && Date.now() < current.expiresAt && !c.quitPending;
  }

  private busyReason(): string | undefined {
    const c = this.c;
    if (c.quitPending || c.busy || c.editingId || c.editor.waitingForCommit || document.querySelector('dialog[open]')) {
      return 'Finish the active edit or close the dialog, then retry.';
    }
  }

  /** The earlier three-edit message (add, rename, set-note). */
  private async applyEdits(work: Extract<AgentWork, { kind: 'edit' }>, current: AgentLiveSession): Promise<string | undefined> {
    const c = this.c;
    if (!current.writable || !this.activeRequest(work, current)) return 'This map no longer has active agent write access.';
    const busy = this.busyReason();
    if (busy) return busy;
    if (!Array.isArray(work.edits) || !work.edits.length || work.edits.length > 32 || !work.edits.every(validEdit)) return 'Invalid edit batch.';
    try {
      const source = { ai: 'agent:' + work.id };
      c.editor.batch('Agent Edit', source, (builder) => {
        for (const edit of work.edits) {
          const target = edit.type === 'add' ? edit.parent : edit.id;
          if (!Object.hasOwn(builder.doc.nodes, target)) throw new Error('An edit refers to a node outside the granted map.');
          if (edit.type === 'add') {
            const add = addChild(builder.doc, target, edit.text.trim(), undefined, source);
            if (add) builder.addAll(add.tx.ops);
          } else if (edit.type === 'rename') {
            builder.add({ t: 'set', id: target, patch: { text: edit.text.trim() } });
          } else {
            builder.add({ t: 'set', id: target, patch: { note: edit.note || undefined } });
          }
        }
      });
      if (!(await c.editor.settled())) return 'The edit is pending because disk persistence failed. Keep the map open and save to retry.';
      this.status = 'Applied ' + work.edits.length + ' agent ' + (work.edits.length === 1 ? 'edit' : 'edits') + '. Undo reverses the batch.';
    } catch (error) {
      return error instanceof Error ? error.message : 'The edit batch could not be applied.';
    }
  }

  /**
   * An agent op batch (AGT-OPS-01): validated and compiled with the shared schema, checked against the grant's tier
   * and the batch's ifRevision, then applied as one Undo step with an agent source. Replies with created ids,
   * touched ids and the new revision. A dry run compiles on a copy and changes nothing.
   */
  private async applyBatch(work: Extract<AgentWork, { kind: 'ops' }>, current: AgentLiveSession): Promise<string> {
    const c = this.c;
    if (!current.writable || !this.activeRequest(work, current)) return failure('not_permitted', 'denied', 'This map no longer has active agent write access.');
    const busy = this.busyReason();
    if (busy) return failure('app_busy', 'unavailable', busy);
    const revision = await revisionOf(c.doc);
    try {
      const run = runAgentBatch(c.doc, work.batch, { revision, allowDestructive: current.destructive && work.destructive });
      if (run.reply.tier === 'destructive' && !work.destructive) {
        return failure('undeclared_destructive', 'denied', 'The batch deletes content but was not sent as destructive.');
      }
      if (run.reply.status === 'dry_run') return JSON.stringify({ reply: { ...run.reply, revision } });
      if (this.busyReason() || c.doc !== current.document) return failure('app_busy', 'unavailable', 'The map changed while the batch was prepared; retry.');
      c.editor.batch(run.reply.label, run.source, (builder) => builder.addAll(run.ops));
      if (!(await c.editor.settled())) {
        return failure('not_saved', 'unavailable', 'The edit is pending because disk persistence failed. Keep the map open and save to retry.');
      }
      this.status = 'Applied ' + run.reply.applied + ' agent ' + (run.reply.applied === 1 ? 'op' : 'ops') + '. Undo reverses the batch.';
      return JSON.stringify({ reply: { ...run.reply, revision: await revisionOf(c.doc), previousRevision: revision } });
    } catch (error) {
      if (error instanceof AgentOpError) return JSON.stringify({ error: { ...error.toJSON(), currentRevision: revision } });
      return failure('rejected', 'invalid', error instanceof Error ? error.message : 'The batch could not be applied.');
    }
  }

  /** Undo the agent's own transaction, only when it is the latest change (AGT-OPS-07). */
  private async undoAgent(work: Extract<AgentWork, { kind: 'undo' }>, current: AgentLiveSession): Promise<string> {
    const c = this.c;
    if (!current.writable || !this.activeRequest(work, current)) return failure('not_permitted', 'denied', 'This map no longer has active agent write access.');
    const busy = this.busyReason();
    if (busy) return failure('app_busy', 'unavailable', busy);
    const top = c.editor.exportHistory(1).undo.at(-1);
    const source = top && top.source !== 'user' ? top.source.ai : undefined;
    if (source !== work.tx) {
      return failure('not_latest', 'conflict', source
        ? 'The latest change is "' + top!.label + '", not transaction ' + work.tx + '; undo was refused so no other change is reverted.'
        : 'The latest change is not transaction ' + work.tx + '; undo was refused so no user edit is reverted.');
    }
    c.editor.undo();
    if (!(await c.editor.settled())) return failure('not_saved', 'unavailable', 'The undo is pending because disk persistence failed.');
    this.status = 'Undid agent change "' + top!.label + '".';
    return JSON.stringify({ reply: { status: 'undone', tx: work.tx, label: top!.label, revision: await revisionOf(c.doc) } });
  }

  /**
   * Selection and camera (AGT-LIVE-05): select nodes, fit or centre the view, or just report the view. Never a
   * document change, so nothing is unfolded: a node inside a folded branch is shown as its nearest visible ancestor.
   */
  private view(work: Extract<AgentWork, { kind: 'view' }>, current: AgentLiveSession): string {
    const c = this.c;
    if (!this.activeRequest(work, current)) return failure('not_permitted', 'denied', 'This map no longer has active agent access.');
    if (c.presenting) return failure('app_busy', 'unavailable', 'A presentation is running; the view belongs to the presenter.');
    const command = work.command as Record<string, unknown> | null;
    if (!command || typeof command !== 'object' || Array.isArray(command)) return failure('invalid_view', 'invalid', 'A view request is a JSON object.');
    const unknown = Object.keys(command).filter((key) => !['select', 'fit', 'center'].includes(key));
    if (unknown.length) {
      return failure('invalid_view', 'invalid', 'Unknown view field "' + unknown[0] + '".', { suggestions: ['select', 'fit', 'center'] });
    }
    const nodes = c.doc.nodes;
    const hidden: Record<string, string> = {};
    /** Ids as the canvas can show them, or an error reply. */
    const shown = (value: unknown, field: string): NodeId[] | string => {
      if (!Array.isArray(value) || value.length > 500 || !value.every((id) => typeof id === 'string')) {
        return failure('invalid_view', 'invalid', field + ' takes up to 500 node ids.');
      }
      const out = new Set<NodeId>();
      for (const id of value as string[]) {
        if (!Object.hasOwn(nodes, id)) return failure('unknown_node', 'not_found', 'No node has the id "' + id + '".', { field });
        let visible = id;
        for (let p = nodes[id].parent; p; p = nodes[p]?.parent ?? null) if (nodes[p].collapsed) visible = p;
        if (visible !== id) hidden[id] = visible;
        out.add(visible);
      }
      return [...out];
    };
    if (command.select !== undefined) {
      const ids = shown(command.select, 'select');
      if (typeof ids === 'string') return ids;
      c.select(ids, ids[0] ?? null);
    }
    if (command.fit !== undefined && command.center !== undefined) return failure('invalid_view', 'invalid', 'Send fit or center, not both.');
    if (command.fit === 'map') c.zoomFit();
    else if (command.fit === 'selection') {
      if (c.selIds.length) c.showNodes(c.selIds, 'fit');
    } else if (command.fit !== undefined) {
      const ids = shown(command.fit, 'fit');
      if (typeof ids === 'string') return ids;
      if (ids.length) c.showNodes(ids, 'fit');
    }
    if (command.center !== undefined) {
      const ids = shown(command.center, 'center');
      if (typeof ids === 'string') return ids;
      if (ids.length) c.showNodes(ids, 'centre');
    }
    return JSON.stringify({ reply: {
      status: 'ok', title: c.docTitle, selection: c.selIds, focus: c.focusId, zoom: c.camera.zoom,
      ...(Object.keys(hidden).length ? { foldedInto: hidden } : {})
    } });
  }

  private async poll(current: AgentLiveSession): Promise<void> {
    const c = this.c;
    if (this.disposed || this.session !== current) return;
    if (current.document !== c.doc || current.path !== this.path) {
      this.revoke('Agent access turned off because the map changed.');
      return;
    }
    if (Date.now() >= current.expiresAt) {
      this.revoke('Agent access ended after 15 minutes without requests.');
      return;
    }
    try {
      const work = await current.transport.take(current.grant.id);
      if (work) {
        // The host renewed the grant when it accepted this request.
        if (current.grant.idleMs) current.expiresAt = Date.now() + current.grant.idleMs;
        const { id } = current.grant;
        if (work.kind === 'read') {
          if (!this.activeRequest(work, current)) {
            await current.transport.finish(id, work.id, 'This map no longer has active agent access.');
          } else {
            await current.transport.finish(id, work.id, undefined, serializeDoc(c.documentWithLayout()), await revisionOf(c.doc));
          }
        } else if (work.kind === 'ops' || work.kind === 'undo') {
          const reply = work.kind === 'ops' ? await this.applyBatch(work, current) : await this.undoAgent(work, current);
          await current.transport.finish(id, work.id, undefined, reply, await revisionOf(c.doc));
        } else if (work.kind === 'view') {
          await current.transport.finish(id, work.id, undefined, this.view(work, current), await revisionOf(c.doc));
        } else {
          await current.transport.finish(id, work.id, await this.applyEdits(work, current));
        }
      }
    } catch {
      if (this.session === current) this.revoke('Agent access disconnected.');
      return;
    }
    if (this.session === current) this.timer = setTimeout(() => void this.poll(current), 120);
  }
}
