import type { Doc, NodeId, Op } from '../core/types';
import type { JournalEdit } from '../core/model/editor';
import { aliasPeers, SHARED_ALIAS_FIELDS } from '../core/model/aliases';

interface ChangedNode { id: NodeId; text: string; previous?: string }

export interface AiChangeSummary {
  title: string;
  added: ChangedNode[];
  edited: ChangedNode[];
  removed: ChangedNode[];
  linksAdded: number;
  linksRemoved: number;
}

export class AiChanges {
  private readonly before = new Map<NodeId, string | null>();
  private readonly linksBefore = new Map<string, boolean>();

  record(doc: Doc, edit: JournalEdit): void {
    const previousText = new Map<NodeId, string>();
    for (const op of edit.inverse) {
      if (op.t === 'insert') previousText.set(op.node.id, op.node.text);
      if (op.t === 'set' && op.patch.text !== undefined) previousText.set(op.id, op.patch.text);
    }
    for (const op of edit.forward) {
      if (op.t === 'link' || op.t === 'unlink') {
        const id = op.t === 'link' ? op.link.id : op.id;
        if (!this.linksBefore.has(id)) this.linksBefore.set(id, op.t === 'unlink');
        continue;
      }
      if (op.t === 'insert') {
        if (!this.before.has(op.node.id)) this.before.set(op.node.id, null);
      } else if (isNodeChange(op)) {
        const node = doc.nodes[op.id];
        const previous = previousText.get(op.id) ?? node?.text ?? '';
        if (!this.before.has(op.id)) this.before.set(op.id, previous);
        if (node && op.t === 'set' && SHARED_ALIAS_FIELDS.some(key => Object.hasOwn(op.patch, key))) {
          for (const peer of aliasPeers(doc, node)) if (!this.before.has(peer.id)) this.before.set(peer.id, previous);
        }
      }
    }
  }

  summarize(doc: Doc, title: string): AiChangeSummary | null {
    const summary: AiChangeSummary = { title, added: [], edited: [], removed: [], linksAdded: 0, linksRemoved: 0 };
    for (const [id, before] of this.before) {
      const node = doc.nodes[id];
      if (before === null) {
        if (node) summary.added.push({ id, text: node.text });
      } else if (node) {
        summary.edited.push({ id, text: node.text, previous: before });
      } else {
        summary.removed.push({ id, text: before });
      }
    }
    if (this.linksBefore.size) {
      const current = new Set(doc.links.map((link) => link.id));
      for (const [id, existed] of this.linksBefore) {
        if (!existed && current.has(id)) summary.linksAdded++;
        if (existed && !current.has(id)) summary.linksRemoved++;
      }
    }
    return summary.added.length || summary.edited.length || summary.removed.length || summary.linksAdded || summary.linksRemoved
      ? summary : null;
  }
}

function isNodeChange(op: Op): op is Extract<Op, { t: 'set' | 'remove' | 'move' | 'setRoot' }> {
  if (op.t === 'set') return Object.keys(op.patch).some((field) => field !== 'generatedDraft' && field !== 'lastAiJob');
  return op.t === 'remove' || op.t === 'move' || op.t === 'setRoot';
}
