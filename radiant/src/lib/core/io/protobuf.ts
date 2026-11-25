/** Bounded protobuf wire reader for the MindNode Next v1 archive snapshot. */
export type ProtoField = { id: number; wire: 0 | 1 | 2 | 5; value: number | Uint8Array };

export function readProto(bytes: Uint8Array): ProtoField[] {
  let offset = 0;
  const fields: ProtoField[] = [];
  const integer = () => {
    let n = 0;
    for (let shift = 0; shift <= 63 && offset < bytes.length; shift += 7) {
      const b = bytes[offset++];
      n += (b & 127) * 2 ** shift;
      if (!(b & 128) && (shift !== 63 || b <= 1)) return n;
    }
    throw new Error('Invalid MindNode Next protobuf integer.');
  };
  while (offset < bytes.length) {
    if (fields.length > 100_000) throw new Error('The MindNode Next record contains too many fields.');
    const tag = integer();
    const id = Math.floor(tag / 8);
    const wire = tag % 8;
    if (id < 1 || id > 0x1fffffff) throw new Error('Invalid MindNode Next protobuf field.');
    if (wire === 0) {
      fields.push({ id, wire, value: integer() });
      continue;
    }
    if (wire !== 1 && wire !== 2 && wire !== 5) throw new Error('Unsupported MindNode Next protobuf record.');
    const length = wire === 2 ? integer() : wire === 1 ? 8 : 4;
    const end = offset + length;
    if (end > bytes.length || !Number.isSafeInteger(end)) throw new Error('Truncated MindNode Next protobuf record.');
    fields.push({ id, wire, value: bytes.subarray(offset, end) });
    offset = end;
  }
  return fields;
}

export const message = (field: Uint8Array | undefined) => field ? readProto(field) : [];
export function fields(records: ProtoField[], id: number): Uint8Array[] {
  return records.flatMap((record) => record.id === id && record.wire === 2 ? [record.value as Uint8Array] : []);
}
export function bytes(records: ProtoField[], id: number): Uint8Array | undefined {
  return records.find((field) => field.id === id && field.wire === 2)?.value as Uint8Array | undefined;
}
export function integer(records: ProtoField[], id: number): number | undefined {
  return records.find((field) => field.id === id && field.wire === 0)?.value as number | undefined;
}
export function scalar(records: ProtoField[], id: number): number | undefined {
  const raw = records.find((field) => field.id === id && field.wire === 1)?.value as Uint8Array | undefined;
  if (!raw) return;
  const value = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat64(0, true);
  return Number.isFinite(value) ? value : undefined;
}
export function uuid(raw: Uint8Array | undefined): string | undefined {
  if (raw?.length === 16) return Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
}
export const utf8 = (input: Uint8Array | undefined) => input ? new TextDecoder('utf-8', { fatal: true }).decode(input) : '';
