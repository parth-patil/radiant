import type { Doc } from '../types';
import { readableLabel } from './markdown';

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : undefined;

export function wordParts(text: string) {
  if (!segmenter) {
    return text.split(/([\p{L}\p{N}\p{M}]+(?:['’][\p{L}\p{N}\p{M}]+)*)/u)
      .filter(Boolean)
      .map(part => ({ text: part, key: /\p{L}/u.test(part) ? part.normalize('NFC').toLowerCase() : '' }));
  }
  return Array.from(segmenter.segment(text), ({ segment, isWordLike }) => ({
    text: segment,
    key: isWordLike && /\p{L}/u.test(segment) ? segment.normalize('NFC').toLowerCase() : ''
  }));
}

export interface RepeatedWord {
  spelling: string;
  branches: number;
}

/** Traverse each primary branch as a unit so occurrences in one branch count only once. */
export function repeatedWords(doc: Doc): Map<string, RepeatedWord> {
  const words = new Map<string, RepeatedWord>();
  const repeated = new Map<string, RepeatedWord>();
  for (const root of doc.roots) {
    for (const branch of doc.nodes[root].children) {
      const seen = new Set<string>();
      const pending = [branch];
      while (pending.length) {
        const node = doc.nodes[pending.pop()!];
        for (const { key, text } of wordParts(readableLabel(node))) {
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const word = words.get(key);
          if (word) {
            word.branches++;
            repeated.set(key, word);
          } else words.set(key, { spelling: text, branches: 1 });
        }
        for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]);
      }
    }
  }
  return repeated;
}
