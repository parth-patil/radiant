import type { Doc, DocChange, NodeId, Op, Transaction } from '../types';
import { applyOp, newTrack, type ChangeTrack } from './ops';

/** Consecutive single-node text edits closer together than this merge into one undo step. */
const COALESCE_MS = 1000;

interface Entry extends HistoryEntry {
  /** Set for text-only single-node edits that may absorb the next one. */
  textNode?: NodeId;
}

export interface HistoryEntry {
  label: string;
  source: Transaction['source'];
  /** Ops as applied (used by redo). */
  fwd: Op[];
  /** Inverse ops in the order they must be applied to undo. */
  inv: Op[];
  time: number;
  beforeModified?: string;
  afterModified?: string;
}

export interface JournalEdit {
  label: string;
  source: Transaction['source'];
  forward: readonly Op[];
  inverse: readonly Op[];
  group?: string;
}

export type EditorChange = DocChange & { edit?: JournalEdit };

export interface EditorHistory {
  version: 1;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
}

export interface ChangeSummary {
  label: string;
  at: number;
  source: 'user' | 'ai' | 'agent';
}

export function describeChange(entry: HistoryEntry): ChangeSummary {
  const source = entry.source === 'user' ? 'user' : entry.source.ai.startsWith('agent:') ? 'agent' : 'ai';
  return { label: entry.label, at: entry.time, source };
}

/** Editor ops use plain values. Preserve explicit undefined patches as property deletions. */
function copyOps<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(copyOps) as T;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyOps(item)])) as T;
}

/** Returned by {@link Editor.beginGroup}. */
export interface GroupHandle {
  /** Close the group; everything applied meanwhile stays one undo step. Safe to call twice. */
  end(): void;
  /** Same as `end()`: the group is closed and its changes are kept (it does not revert anything). */
  abort(): void;
}

interface Group {
  label: string;
  source: Transaction['source'];
  interleaveAppends: boolean;
  /** Created lazily on the first matching apply, so an empty group leaves no undo step. */
  entry: Entry | null;
}

function sameSource(a: Transaction['source'], b: Transaction['source']): boolean {
  if (a === 'user' || b === 'user') return a === b;
  return a.ai === b.ai;
}

/**
 * Handed to the callback of {@link Editor.batch}. Ops are applied to the live document immediately,
 * so later ops (and `doc` reads) see the effects of earlier ones. If the callback throws, everything is rolled back.
 */
export class Builder {
  /** @internal */ readonly fwd: Op[] = [];
  /** @internal */ readonly inv: Op[] = [];
  /** @internal */ readonly track: ChangeTrack = newTrack();

  constructor(
    /** The live document (already containing the effects of ops added so far). Do not mutate directly. */
    readonly doc: Doc,
    private readonly pinPositions = false
  ) {}

  /** Apply one op now and record it; returns its inverse. */
  add(op: Op): Op {
    const inv = applyOp(this.doc, op, this.track);
    if (this.pinPositions && (op.t === 'insert' || op.t === 'move')) {
      const siblings = op.parent === null ? this.doc.roots : this.doc.nodes[op.parent].children;
      const id = op.t === 'insert' ? op.node.id : op.id;
      op = { ...op, index: siblings.indexOf(id) };
    }
    this.fwd.push(op);
    this.inv.push(inv);
    return inv;
  }

  /** Apply several ops now, in order. */
  addAll(ops: readonly Op[]): void {
    for (const op of ops) this.add(op);
  }

  /** @internal Undo everything added so far. */
  rollback(): void {
    for (let i = this.inv.length - 1; i >= 0; i--) applyOp(this.doc, this.inv[i]);
    this.fwd.length = 0;
    this.inv.length = 0;
  }
}

/** Holds a document with undo/redo history and change notification. */
export class Editor {
  private _doc: Doc;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private group: Group | null = null;
  private listeners = new Set<(c: EditorChange) => void>();

  private persist: ((change: EditorChange) => Promise<void> | undefined) | undefined;
  private onDeferredError: ((error: unknown) => void) | undefined;
  private intents: Array<() => void> = [];
  private waiters: Array<(saved: boolean) => void> = [];
  private inFlight = false;
  private held = false;
  private failedWrite: EditorChange | null = null;

  /** Optional native durability gate. The in-memory editor remains synchronous without a writer. */
  setCommitBarrier(
    persist: (change: EditorChange) => Promise<void> | undefined,
    onDeferredError: (error: unknown) => void
  ): void {
    this.persist = persist;
    this.onDeferredError = onDeferredError;
  }

  get waitingForCommit(): boolean {
    return this.inFlight || this.held || this.failedWrite !== null;
  }

  /** Queue a user intent before preparing ops whose indices or targets depend on earlier edits. */
  defer(intent: () => void): boolean {
    if (!this.waitingForCommit) return false;
    this.intents.push(intent);
    return true;
  }

  /** Drain accepted input before reading a snapshot or switching documents. */
  settled(retry = false): Promise<boolean> {
    if (retry && this.failedWrite) this.write(this.failedWrite);
    if (this.failedWrite) return Promise.resolve(false);
    if (!this.waitingForCommit) return Promise.resolve(true);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Hold queued mutations while a file operation changes which path receives the next edit. */
  hold(): () => void {
    this.held = true;
    return () => {
      this.held = false;
      this.drain();
    };
  }

  private drain(): void {
    while (!this.waitingForCommit && this.intents.length) {
      const intent = this.intents.shift()!;
      try { intent(); }
      catch (error) { this.onDeferredError?.(error); }
    }
    if (!this.waitingForCommit) this.finishWaiting(true);
  }

  private write(change: EditorChange): void {
    this.failedWrite = null;
    this.inFlight = true;
    Promise.resolve().then(() => this.persist?.(change)).then(() => {
      this.inFlight = false;
      this.drain();
    }, () => {
      this.inFlight = false;
      this.failedWrite = change;
      this.finishWaiting(false);
    });
  }

  private finishWaiting(saved: boolean): void {
    for (const resolve of this.waiters.splice(0)) resolve(saved);
  }

  constructor(doc: Doc) {
    this._doc = doc;
  }

  /** The live document. Mutated in place by edits; treat as read-only outside the model. */
  get doc(): Doc {
    return this._doc;
  }
  get hasOpenGroup(): boolean {
    return this.group !== null;
  }
  get undoTargetsOpenGroup(): boolean {
    return !!this.group?.entry && this.undoStack.at(-1) === this.group.entry;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  /** Label of the step undo would revert (for "Undo Add Child"), or null. */
  get undoLabel(): string | null {
    return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : null;
  }
  get redoLabel(): string | null {
    return this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : null;
  }

  /** Listen for changes. Returns the unsubscribe function. */
  subscribe(listener: (c: EditorChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Capture the stacks paired with the current document, including a partially streamed group. */
  exportHistory(limit = Infinity): EditorHistory {
    const capture = ({ label, source, fwd, inv, time, beforeModified, afterModified }: Entry, open: boolean): HistoryEntry =>
      copyOps({ label, source, fwd, inv: open ? inv.toReversed() : inv, time, beforeModified, afterModified });
    return {
      version: 1,
      undo: this.undoStack.slice(Math.max(0, this.undoStack.length - limit)).map((entry) => capture(entry, this.group?.entry === entry)),
      redo: this.redoStack.slice(Math.max(0, this.redoStack.length - limit)).map((entry) => capture(entry, false))
    };
  }

  /** Applied and undone edits, newest toward the next Undo/Redo. */
  historySummary(limit = 40): { applied: ChangeSummary[]; undone: ChangeSummary[] } {
    return {
      applied: this.undoStack.slice(-limit).reverse().map(describeChange),
      undone: this.redoStack.slice(-limit).reverse().map(describeChange)
    };
  }

  /** Replace the document and optionally restore undo state captured at that exact saved version. */
  load(doc: Doc, history?: EditorHistory): void {
    this.intents = [];
    this.failedWrite = null;
    this.closeGroup();
    this._doc = doc;
    this.undoStack = history ? history.undo.map(copyOps) : [];
    this.redoStack = history ? history.redo.map(copyOps) : [];
    this.emit({ doc, touched: new Set(doc.roots), cosmeticOnly: false, kind: 'load' });
  }

  /**
   * Apply a transaction as one undo step. A transaction with no ops does nothing. If an op throws,
   * earlier ops of the transaction are rolled back and the error is rethrown.
   */
  apply(tx: Transaction, applied?: () => void): void {
    if (tx.ops.length === 0) return;
    if (this.defer(() => this.apply(tx, applied))) return;
    const b = this.build(tx.source);
    try {
      b.addAll(tx.ops);
      if (tx.source === 'user') this.acceptEditedDrafts(b);
    } catch (e) {
      b.rollback();
      throw e;
    }
    this.commit(tx.label, tx.source, b);
    applied?.();
  }

  /**
   * Build a multi-op transaction imperatively. Ops added through the builder are applied immediately,
   * so the callback can read `b.doc` and base later ops on earlier ones.
   */
  batch(label: string, source: Transaction['source'], fn: (b: Builder) => void): void {
    if (this.defer(() => this.batch(label, source, fn))) return;
    const b = this.build(source);
    try {
      fn(b);
      if (source === 'user') this.acceptEditedDrafts(b);
    } catch (e) {
      b.rollback();
      throw e;
    }
    if (b.fwd.length === 0) return;
    this.commit(label, source, b);
  }

  /**
   * Open an undo group (for streamed AI generation). While open, every transaction applied with the same
   * `source` is merged into ONE undo entry labelled `label` (ops concatenated in order; undo reverts all,
   * redo restores all). Listeners are still notified on every apply, so the UI updates live.
   *
   * By default other edits close the group. Streamed map groups can keep their original position in the
   * history while later rows append new siblings. Intervening edits retain their applied positions and undo
   * first, so a user can edit or move nodes created earlier in the stream.
   */
  beginGroup(label: string, source: Transaction['source'], options: { interleaveAppends?: boolean } = {}): GroupHandle {
    const g: Group = { label, source, interleaveAppends: options.interleaveAppends === true, entry: null };
    const open = () => {
      this.closeGroup();
      this.group = g;
    };
    if (!this.defer(open)) open();
    const end = () => { if (this.group === g) this.closeGroup(); };
    const close = () => { if (!this.defer(end)) end(); };
    return { end: close, abort: close };
  }

  private closeGroup(): void {
    const g = this.group;
    if (!g) return;
    this.group = null;
    if (g.entry) g.entry.inv.reverse(); // stored in apply order while open; undo needs reverse order
  }

  /** Revert the most recent step. */
  undo(): void {
    if (this.defer(() => this.undo())) return;
    if (!this.group?.interleaveAppends || this.undoTargetsOpenGroup) this.closeGroup();
    const e = this.undoStack.at(-1);
    if (!e) return;
    const track = this.replay(e.inv);
    this.undoStack.pop();
    this.redoStack.push(e);
    const prev = this.undoStack[this.undoStack.length - 1];
    if (prev) prev.textNode = undefined; // typing after an undo starts a fresh step
    this._doc.modified = e.beforeModified ?? new Date().toISOString();
    this.emit({ doc: this._doc, touched: track.touched, cosmeticOnly: track.cosmeticOnly, kind: 'undo',
      edit: { label: e.label, source: e.source, forward: e.inv, inverse: e.fwd } });
  }

  /** Re-apply the most recently undone step. */
  redo(): void {
    if (this.defer(() => this.redo())) return;
    if (!this.group?.interleaveAppends) this.closeGroup();
    const e = this.redoStack.at(-1);
    if (!e) return;
    const track = this.replay(e.fwd);
    this.redoStack.pop();
    e.textNode = undefined; // never merge into a redone step
    this.undoStack.push(e);
    this._doc.modified = e.afterModified ?? new Date().toISOString();
    this.emit({ doc: this._doc, touched: track.touched, cosmeticOnly: track.cosmeticOnly, kind: 'redo',
      edit: { label: e.label, source: e.source, forward: e.fwd, inverse: e.inv } });
  }

  // ---------------------------------------------------------------- internals

  private build(source: Transaction['source']): Builder {
    const group = this.group;
    return new Builder(this._doc, !!group?.interleaveAppends && !sameSource(group.source, source));
  }

  private replay(ops: readonly Op[]): ChangeTrack {
    const replay = new Builder(this._doc);
    try {
      replay.addAll(ops);
      return replay.track;
    } catch (error) {
      replay.rollback();
      throw error;
    }
  }

  private acceptEditedDrafts(builder: Builder): void {
    const doc = builder.doc;
    const touched = [...builder.track.touched];
    const visited = new Set<NodeId>();
    for (const id of touched) {
      for (let cursor: NodeId | null = id; cursor && !visited.has(cursor); cursor = doc.nodes[cursor]?.parent ?? null) {
        visited.add(cursor);
        if (doc.nodes[cursor]?.generatedDraft) builder.add({ t: 'set', id: cursor, patch: { generatedDraft: undefined } });
      }
    }
  }

  private commit(label: string, source: Transaction['source'], b: Builder): void {
    this.redoStack.length = 0;
    const now = Date.now();
    const beforeModified = this._doc.modified;
    const afterModified = new Date(now).toISOString();
    const matching = this.group && sameSource(this.group.source, source);
    if (this.group && !matching && !this.group.interleaveAppends) this.closeGroup();
    const g = matching ? this.group : null;
    if (g) {
      if (g.entry) {
        const tip = this.undoStack.at(-1);
        if (tip) tip.afterModified = afterModified;
        for (const op of b.fwd) g.entry.fwd.push(op);
        for (const op of b.inv) g.entry.inv.push(op); // apply order; reversed when the group closes
      } else {
        g.entry = { label: g.label, source: g.source, fwd: b.fwd.slice(), inv: b.inv.slice(), time: now, beforeModified, afterModified };
        this.undoStack.push(g.entry);
      }
      this._doc.modified = afterModified;
      this.emit({ doc: this._doc, touched: b.track.touched, cosmeticOnly: b.track.cosmeticOnly, kind: 'apply',
        edit: { label: g.label, source: g.source, forward: b.fwd, inverse: b.inv.toReversed(),
          group: g.source === 'user' ? undefined : g.source.ai } });
      return;
    }
    const textNode = textOnlyNode(b.fwd.filter(op => !clearsDraft(op)));
    const top = this.undoStack[this.undoStack.length - 1];
    if (
      textNode !== undefined &&
      top &&
      top.textNode === textNode &&
      source === 'user' &&
      top.source === 'user' &&
      now - top.time <= COALESCE_MS
    ) {
      // Keep the original inverse (restores the text from before the burst); replace the forward op.
      top.fwd = [...b.fwd, ...top.fwd.filter(clearsDraft)];
      top.time = now;
      top.afterModified = afterModified;
    } else {
      this.undoStack.push({ label, source, fwd: b.fwd, inv: b.inv.slice().reverse(), textNode, time: now, beforeModified, afterModified });
    }
    this._doc.modified = afterModified;
    this.emit({ doc: this._doc, touched: b.track.touched, cosmeticOnly: b.track.cosmeticOnly, kind: 'apply',
      edit: { label, source, forward: b.fwd, inverse: b.inv.toReversed() } });
  }

  private emit(c: EditorChange): void {
    if (c.edit && this.persist) this.write(c);
    for (const l of Array.from(this.listeners)) l(c);
  }
}

function clearsDraft(op: Op): boolean {
  return op.t === 'set' && Object.keys(op.patch).length === 1 &&
    Object.hasOwn(op.patch, 'generatedDraft') && op.patch.generatedDraft === undefined;
}

/** If the ops are exactly one `set` that changes only `text`, return its node id. */
function textOnlyNode(ops: readonly Op[]): NodeId | undefined {
  if (ops.length !== 1) return undefined;
  const op = ops[0];
  if (op.t !== 'set') return undefined;
  const keys = Object.keys(op.patch);
  return keys.length === 1 && keys[0] === 'text' ? op.id : undefined;
}
