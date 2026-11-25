import type { EditorChange } from '../core/model/editor';
import type { Op } from '../core/types';

function encodeOp(op: Op) {
  // JSON omits undefined values, but an explicit undefined patch deletes the property.
  if (op.t === 'set' || op.t === 'docMeta' || op.t === 'canvasMeta') {
    const deleted = Object.keys(op.patch).filter((key) =>
      (op.patch as Record<string, unknown>)[key] === undefined);
    return { op, deleted };
  }
  return { op };
}

export function encodeJournalChange(change: EditorChange): string {
  const edit = change.edit;
  if (!edit) throw new Error('Missing edit record.');
  return JSON.stringify({
    version: 1,
    kind: change.kind,
    label: edit.label,
    source: edit.source,
    group: edit.group,
    forward: edit.forward.map(encodeOp),
    inverse: edit.inverse.map(encodeOp)
  });
}
