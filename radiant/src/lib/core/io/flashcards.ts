import type { Doc, NodeId } from '../types';

/** Anki's UTF-8 text import accepts quoted tabs, line breaks and doubled quotes. */
function field(text: string): string {
  return '"' + text.replaceAll('"', '""') + '"';
}

export function toFlashcards(doc: Doc, selection?: ReadonlySet<NodeId>): string {
  const rows = ['#separator:Tab', '#html:false', '#notetype:Basic', '#columns:Front\tBack'];
  const cards: { front: string; back: string }[] = [];
  const counts = new Map<string, number>();
  const stack = [...doc.roots].reverse();
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    if (selection && !selection.has(node.id)) continue;

    const label = node.text.trim();
    const parent = node.parent && (!selection || selection.has(node.parent)) ? doc.nodes[node.parent] : undefined;
    const parentLabel = parent?.blankAnswer?.trim() || parent?.text.trim();
    let front = label;
    let back = node.blankAnswer?.trim() || node.note?.trim();
    if (node.blankAnswer && parentLabel) front = parentLabel + ' — ' + (label || '____');
    if (!back && node.children.length) {
      front = 'Which topics branch from ' + label + '?';
      back = node.children.map(id => doc.nodes[id].blankAnswer?.trim() || doc.nodes[id].text.trim()).filter(Boolean).join('\n');
    }
    if (!back && parentLabel) {
      front = 'Which topic contains ' + label + '?';
      back = parentLabel;
    }
    if (!back && !parent) {
      front = 'What is the main topic of this map?';
      back = label;
    }
    if (front && back) {
      cards.push({ front, back });
      counts.set(front, (counts.get(front) ?? 0) + 1);
    }
  }
  // Anki uses the front field to identify duplicates during text import.
  const emitted = new Set<string>();
  const nextNumber = new Map<string, number>();
  for (const card of cards) {
    let front = card.front;
    if (counts.get(front)! > 1) {
      let number = nextNumber.get(front) ?? 1;
      do { front = card.front + ' (' + number++ + ')'; } while (emitted.has(front) || counts.has(front));
      nextNumber.set(card.front, number);
    }
    emitted.add(front);
    rows.push(field(front) + '\t' + field(card.back));
  }
  if (!cards.length) throw new Error('Select a node with a label, note or study answer to export flashcards.');
  return rows.join('\n') + '\n';
}
