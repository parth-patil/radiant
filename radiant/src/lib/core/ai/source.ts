// Budget one input token per UTF-8 byte, leaving room for instructions and output
// without relying on a provider tokenizer or its advertised maximum window.
export const SOURCE_BYTE_LIMIT = 64 * 1024;

export function boundSource(text: string): { text: string; truncated: boolean } {
  if (text.length <= SOURCE_BYTE_LIMIT / 3) return { text, truncated: false };
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(SOURCE_BYTE_LIMIT));
  return { text: text.slice(0, read), truncated: read < text.length };
}
