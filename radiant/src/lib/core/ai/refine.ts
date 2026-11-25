import template from './templates/refine.json';
import { fill } from './template';
import { addChild, deleteSubtree, newId, subtreeIds } from '../model';
import type { Doc, NodeId, Op, Transaction } from '../types';
import type { AiTurnRequest } from './provider';

export type RefineMode = 'regenerate' | 'keywords' | 'summarise' | 'explain' | 'gaps' | 'questions' | 'chat' | 'check';
export type ChatScope = 'node' | 'branch' | 'map';
export const REFINE_MARKER = template.marker;
export const MAX_REFINEMENT_NODES = 200;

export const refineNames: Record<RefineMode, string> = {
  regenerate: 'Regenerate branch',
  keywords: 'Rephrase to keywords',
  summarise: 'Summarise branch',
  explain: 'Explain into note',
  gaps: 'Find gaps and cross-links',
  questions: 'Generate recall questions',
  chat: 'Chat about the map',
  check: 'Check draft against source'
};

export interface RefineContext {
  docId: string;
  root: NodeId;
  input: Array<{ id: NodeId; parent: NodeId | null; title: string; note?: string; blank?: boolean }>;
  outside: string[];
}

export function refinementContext(doc: Doc, root: NodeId, scope: ChatScope = 'branch'): RefineContext | null {
  if (!doc.nodes[root]) return null;
  const ids = scope === 'map' ? doc.roots.flatMap((id) => subtreeIds(doc, id))
    : scope === 'node' ? [root] : subtreeIds(doc, root);
  if (!ids.length || ids.length > MAX_REFINEMENT_NODES) return null;
  const input = ids.map((id) => {
    const node = doc.nodes[id];
    return { id, parent: id === root && scope !== 'map' ? null : node.parent, title: node.text,
      note: node.note?.slice(0, 600), blank: node.blankAnswer !== undefined || undefined };
  });
  const selected = doc.nodes[root];
  const parent = selected.parent === null ? null : doc.nodes[selected.parent];
  const siblings = parent?.children ?? doc.roots;
  const outside = scope === 'map' ? [] : [parent?.text, ...siblings.filter((id) => id !== root).slice(0, 11).map((id) => doc.nodes[id]?.text)]
    .flatMap((text) => text ? [text.slice(0, 100)] : []);
  return { docId: doc.id, root, input, outside };
}

export interface ChatTurn {
  question: string;
  reply: string;
  quotes: string[];
}

export function refinementRequest(
  context: RefineContext, mode: RefineMode, instruction: string, source: string, conversation: readonly ChatTurn[] = []
): AiTurnRequest {
  const variant = template.modes[mode];
  return {
    kind: 'text',
    templateVersion: template.version + ':' + mode,
    effort: 'low',
    instructions: [
      REFINE_MARKER + ' ' + mode,
      template.role, template.output, template.style,
      fill(template.rules, { modeRules: variant.rules }),
      fill(template.example, { example: JSON.stringify(variant.example) })
    ].join('\n'),
    prompt: fill(template.task, {
      input: JSON.stringify(context.input), outside: JSON.stringify(context.outside),
      history: conversation.length ? fill(template.history, { conversation: JSON.stringify(conversation.slice(-5)) }) : '',
      instruction: JSON.stringify(instruction.trim()), source: JSON.stringify(source.trim())
    })
  };
}

export interface RefineChange {
  ops: Op[];
  label: string;
  detail?: string;
  adds?: string[];
  edits?: string[];
  removes?: string[];
  append?: boolean;
}

export interface RefineQuestion {
  id: NodeId;
  question: string;
}

export interface RefineProposal {
  changes: RefineChange[];
  questions: RefineQuestion[];
  rejected: string[];
  reply?: string;
  quotes?: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function shortText(value: unknown, limit = 200): string | undefined {
  if (typeof value !== 'string') return;
  const text = value.trim();
  return text.length > 0 && text.length <= limit ? text : undefined;
}

export function parseRefinement(
  text: string, mode: RefineMode, context: RefineContext, doc: Doc, job: string, source = ''
): RefineProposal {
  const change = { ops: [], label: refineNames[mode], adds: [], edits: [], removes: [] } as
    RefineChange & { adds: string[]; edits: string[]; removes: string[] };
  const proposal: RefineProposal = { changes: [], questions: [], rejected: [] };
  const root = doc.nodes[context.root];
  if (!root || context.docId !== doc.id) throw new Error('The selected branch is no longer available.');
  const value: unknown = JSON.parse(text);
  if (!isObject(value) || !Array.isArray(value.items) || value.items.length > MAX_REFINEMENT_NODES) {
    throw new Error('Radiant could not read the proposal.');
  }
  if (mode === 'chat') {
    proposal.reply = shortText(value.reply, 8_000);
    if (!proposal.reply) throw new Error('The chat response did not include an answer.');
    proposal.quotes = Array.isArray(value.quotes) ? value.quotes.slice(0, 6).flatMap((value) => {
      const quote = shortText(value, 500);
      return quote && source.includes(quote) ? [quote] : [];
    }) : [];
  }

  const allowed = new Set(context.input.map((row) => row.id));
  const outsideAliasGroups = new Set(Object.values(doc.nodes).flatMap(node =>
    node.aliasGroup && !allowed.has(node.id) ? [node.aliasGroup] : []
  ));
  const seen = new Set<NodeId>();
  const drops: NodeId[] = [];
  const builds = new Map<string, { id: NodeId; depth: number; children: number }>();
  const insertions: Op[] = [];
  const top = { id: root.id, depth: 0, children: 0 };

  for (const [index, item] of value.items.entries()) {
    const reject = (reason: string) => proposal.rejected.push('Item ' + (index + 1) + ' · ' + reason);
    if (!isObject(item)) {
      reject('Invalid format');
      continue;
    }

    const title = shortText(item.title);
    const id = shortText(item.id, 100);
    if (mode === 'regenerate') {
      const parent = item.parent === null ? top : typeof item.parent === 'string' && builds.get(item.parent);
      if (!title || !id || !parent || Object.hasOwn(doc.nodes, id) || builds.has(id) || parent.depth >= 4 || parent.children >= 7) {
        reject('Invalid new node or parent');
        continue;
      }
      const nodeId = newId();
      builds.set(id, { id: nodeId, depth: parent.depth + 1, children: 0 });
      insertions.push({
        t: 'insert', parent: parent.id, index: parent.children++,
        node: { id: nodeId, parent: parent.id, children: [], text: title,
          note: shortText(item.note, 2_000), origin: { by: 'ai', job } }
      });
      change.adds.push(title);
      continue;
    }

    if (mode === 'gaps' || mode === 'chat' || (mode === 'check' && item.kind === 'missing')) {
      if (typeof item.parent === 'string' && allowed.has(item.parent) && title && shortText(item.reason, 2_000)) {
        const edit = addChild(doc, item.parent, title, undefined, { ai: job });
        if (edit) proposal.changes.push({ ops: edit.tx.ops, label: mode === 'check' ? 'Missing · ' + title : title, detail: shortText(item.reason, 2_000), adds: [title], append: true });
        continue;
      }
      const from = shortText(item.from, 100);
      const to = shortText(item.to, 100);
      const label = shortText(item.label);
      if (mode !== 'check' && from && to && from !== to && allowed.has(from) && allowed.has(to) && label) {
        const link = { id: newId(), from, to, label };
        proposal.changes.push({ ops: [{ t: 'link', link }], label,
          detail: doc.nodes[from].text + ' → ' + doc.nodes[to].text });
        continue;
      }
      reject('Missing evidence or outside the allowed scope');
      continue;
    }

    if (!id || !allowed.has(id) || !doc.nodes[id] || seen.has(id)) {
      reject('Duplicate or outside the allowed scope');
      continue;
    }
    seen.add(id);
    const node = doc.nodes[id];
    const editsAliasContent = mode === 'explain' || mode === 'keywords' ||
      (mode === 'summarise' && item.remove !== true) || (mode === 'check' && item.kind === 'wrong');
    if (editsAliasContent && node.aliasGroup && outsideAliasGroups.has(node.aliasGroup)) {
      reject('This alias shares its content with a node outside the allowed scope');
      continue;
    }
    if (mode === 'check') {
      const reason = shortText(item.reason, 2_000);
      if (reason && item.kind === 'wrong' && title && node.text !== title && node.blankAnswer === undefined) {
        proposal.changes.push({ label: 'Wrong · ' + node.text, detail: reason,
          edits: [node.text + ' → ' + title], ops: [{ t: 'set', id, patch: { text: title } }] });
      } else if (reason && item.kind === 'extra' && id !== root.id && !node.children.length) {
        const removal = deleteSubtree(doc, [id]);
        if (removal) proposal.changes.push({ label: 'Extra · ' + node.text, detail: reason, removes: [node.text], ops: removal.tx.ops });
      } else reject('Invalid source comparison');
    } else if (mode === 'questions') {
      const question = shortText(item.question, 600);
      if (question && !node.children.length) proposal.questions.push({ id, question });
      else reject('Invalid recall question');
    } else if (mode === 'explain') {
      const note = shortText(item.note, 4_000);
      if (id === root.id && note) {
        change.ops.push({ t: 'set', id, patch: { note } });
        change.edits.push(node.text);
        change.detail = note;
      } else reject('Missing note or outside the selected node');
    } else if (mode === 'summarise' && item.remove === true) {
      if (id === root.id) reject('The selected branch root must stay');
      else drops.push(id);
    } else if (!title || node.blankAnswer !== undefined || (mode === 'keywords' && title.split(/\s+/).length > 5)) {
      reject('Invalid or too long a label');
    } else if (node.text !== title) {
      change.ops.push({ t: 'set', id, patch: { text: title } });
      change.edits.push(node.text + ' → ' + title);
    }
  }

  if (mode === 'keywords') {
    const rewritten = new Set(change.ops.flatMap((op) => op.t === 'set' ? [op.id] : []));
    if (context.input.some((row) => !row.blank && row.title.trim().split(/\s+/).length > 5 && !rewritten.has(row.id))) {
      proposal.rejected.push('Some labels still exceed five words. Request a complete proposal.');
      return proposal;
    }
  }
  if (mode === 'regenerate' && insertions.length) drops.push(...root.children);
  if (mode === 'summarise' && !drops.length) {
    proposal.rejected.push('The proposal did not condense the branch.');
    return proposal;
  }
  if (drops.length) {
    const removal = deleteSubtree(doc, drops)?.tx.ops ?? [];
    const lost = new Set(removal.flatMap((op) => op.t === 'remove' ? [op.id] : []));
    change.removes.push(...Array.from(lost, (id) => doc.nodes[id].text));
    change.ops = change.ops.filter((op) => op.t !== 'set' || !lost.has(op.id));
    change.ops.push(...removal);
  }
  change.ops.push(...insertions);
  if (insertions.length && root.collapsed) change.ops.push({ t: 'set', id: root.id, patch: { collapsed: undefined } });
  if (change.ops.length) proposal.changes.push(change);
  if (mode === 'questions') {
    const missing = context.input.filter(({ id }) => doc.nodes[id].children.length === 0).length - proposal.questions.length;
    if (missing > 0) proposal.rejected.push('Questions missing for ' + missing + ' leaf nodes.');
  }
  return proposal;
}

export function applyRefinement(doc: Doc, change: RefineChange, job: string): Transaction {
  const ops = change.ops.flatMap((op): Op[] => {
    if (op.t === 'unlink' && !doc.links.some((link) => link.id === op.id)) return [];
    if (op.t === 'insert' && op.parent !== null && doc.nodes[op.parent] && change.append) {
      return [{ ...op, index: doc.nodes[op.parent].children.length }];
    }
    if (op.t === 'link' && doc.links.some((link) => (link.from === op.link.from && link.to === op.link.to) || (link.from === op.link.to && link.to === op.link.from))) return [];
    return [op];
  });
  return { ops, label: change.label, source: { ai: job } };
}
