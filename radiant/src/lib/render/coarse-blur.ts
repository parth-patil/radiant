// Keep the DC and first horizontal and vertical frequencies of each ThumbHash
// channel. Four low-frequency corner colours fit in one instanced quad.
export function coarseBlur(hash: string): number[] | undefined {
  if (hash.length > 64) return;
  let bytes: string;
  try { bytes = atob(hash); } catch { return; }
  if (bytes.length < 5) return;
  const byte = (i: number) => bytes.charCodeAt(i);
  const luma = byte(0) | (byte(1) << 8) | (byte(2) << 16);
  const chroma = byte(3) | (byte(4) << 8);
  const alpha = !!(luma & 0x800000);
  const long = alpha ? 5 : 7;
  const short = Math.max(3, chroma & 7);
  const nx = chroma & 0x8000 ? long : short;
  const ny = chroma & 0x8000 ? short : long;
  let lumaTerms = -1; // DC is stored in the header.
  for (let y = 0; y < ny; y++) lumaTerms += Math.ceil(nx * (ny - y) / ny);
  const start = alpha ? 6 : 5;
  if (bytes.length < start + Math.ceil((lumaTerms + 10 + (alpha ? 14 : 0)) / 2)) return;
  const term = (i: number) => ((byte(start + (i >> 1)) >> (4 * (i & 1))) & 15) / 7.5 - 1;
  const channel = (dc: number, scale: number, offset: number, width: number, x: number, y: number) =>
    dc + Math.SQRT2 * scale * (x * term(offset) + y * term(offset + width - 1));
  const quantize = (value: number) => Math.round(63 * Math.max(0, Math.min(1, value)));
  const corners = [];
  for (const y of [1, -1]) {
    for (const x of [1, -1]) {
      const l = channel((luma & 63) / 63, ((luma >> 18) & 31) / 31, 0, nx, x, y);
      const p = channel(((luma >> 6) & 63) / 31.5 - 1, ((chroma >> 3) & 63) / 63 * 1.25, lumaTerms, 3, x, y);
      const q = channel(((luma >> 12) & 63) / 31.5 - 1, ((chroma >> 9) & 63) / 63 * 1.25, lumaTerms + 5, 3, x, y);
      const a = alpha ? channel((byte(5) & 15) / 15, (byte(5) >> 4) / 15, lumaTerms + 10, 5, x, y) : 1;
      const b = l - 2 * p / 3;
      const r = (3 * l - b + q) / 2;
      // Four 6-bit channels are exactly representable in a float32 attribute.
      corners.push(quantize(r) | (quantize(r - q) << 6) | (quantize(b) << 12) | (quantize(a) << 18));
    }
  }
  return corners;
}
