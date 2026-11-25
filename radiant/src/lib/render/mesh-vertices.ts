import type { Mesh } from '../core/types';

/** Pack relative positions and premultiplied colour for direct GL vertex-buffer upload. */
export function packMeshVertices(mesh: Mesh): NonNullable<Mesh['gpuVertices']> {
  const nv = mesh.positions.length >> 1;
  const P = mesh.positions;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = P[2 * i], y = P[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2;
  // Beyond this extent a single mesh-relative float can lose visible increments at maximum zoom.
  // Store the residual as a second pair of floats only for meshes with a wide footprint.
  const wide = Math.max(x1 - x0, y1 - y0) > 65536;
  const stride = wide ? 5 : 3;
  const buf = new ArrayBuffer(nv * stride * 4);
  const f = new Float32Array(buf);
  const u32 = new Uint32Array(buf);
  const C = mesh.colors;
  // A branch's colour is the same along most of its vertices: build its 4-byte word (r, g, b, a in memory order,
  // little-endian) only when the colour changes, and write it as one 32-bit store.
  let lr = NaN, lg = NaN, lb = NaN, la = NaN, word = 0;
  for (let i = 0, o = 0, c = 0; i < nv; i++, o += stride, c += 4) {
    const x = P[2 * i] - ox, y = P[2 * i + 1] - oy;
    f[o] = x;
    f[o + 1] = y;
    if (wide) {
      f[o + 3] = x - f[o];
      f[o + 4] = y - f[o + 1];
    }
    const r = C[c], g = C[c + 1], b = C[c + 2], a = C[c + 3];
    if (r !== lr || g !== lg || b !== lb || a !== la) {
      lr = r; lg = g; lb = b; la = a;
      word = (unorm8(r) | unorm8(g) << 8 | unorm8(b) << 16 | unorm8(a) << 24) >>> 0;
    }
    u32[o + 2] = word;
  }
  return { buffer: buf, ox, oy, wide };
}

/** A colour channel as unorm8, exactly as Uint8Array stores Math.max(0, Math.min(255, Math.round(v * 255))). */
function unorm8(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * Bytes per vertex of a dimensional branch mesh (Mesh.relief): float32 x, y; 4 x unorm8 premultiplied colour;
 * 4 x snorm8 (nx, ny, shadow strength, across); 2 x int16 offset to the vertex's shadow in 1/128 world units. 'rope'
 * adds its float32 twist phase. A wide mesh appends the float32 residuals of x, y.
 */
export function reliefStride(rope: boolean, wide: boolean): number {
  return (rope ? 24 : 20) + (wide ? 8 : 0);
}

/** A 32-bit view of an 8-or-16-bit per-vertex array that holds 4 bytes per vertex. */
function words(a: Int8Array | Int16Array, nv: number): Int32Array {
  const source = a.byteOffset % 4 ? a.slice() : a;
  return new Int32Array(source.buffer, source.byteOffset, nv);
}

/**
 * Pack a dimensional mesh for one interleaved vertex buffer shared by its lit draw and its shadow draw. The relief
 * arrays are already in GPU form, so they are copied a word at a time.
 */
export function packReliefVertices(mesh: Mesh): NonNullable<Mesh['gpuVertices']> {
  const relief = mesh.relief!;
  const nv = mesh.positions.length >> 1;
  const P = mesh.positions;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < nv; i++) {
    const x = P[2 * i], y = P[2 * i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const ox = (x0 + x1) / 2, oy = (y0 + y1) / 2;
  const wide = Math.max(x1 - x0, y1 - y0) > 65536;
  const rope = !!relief.twist;
  const stride = reliefStride(rope, wide) >> 2;
  const buf = new ArrayBuffer(nv * stride * 4);
  const f = new Float32Array(buf);
  const i32 = new Int32Array(buf);
  const u8 = new Uint8Array(buf);
  const RGBA = relief.rgba;
  const A = words(relief.attribs, nv);
  const Q = relief.shadow ? words(relief.shadow, nv) : undefined;
  const T = relief.twist;
  const low = stride - 2;
  for (let i = 0; i < nv; i++) {
    const o = i * stride;
    const x = P[2 * i] - ox, y = P[2 * i + 1] - oy;
    f[o] = x;
    f[o + 1] = y;
    i32[o + 2] = RGBA[i];
    i32[o + 3] = A[i];
    i32[o + 4] = Q ? Q[i] : 0;
    if (T) f[o + 5] = T[i];
    if (wide) {
      f[o + low] = x - f[o];
      f[o + low + 1] = y - f[o + 1];
    }
  }
  return { buffer: buf, ox, oy, wide };
}

/** Pack any mesh for upload: dimensional meshes in their own layout, flat meshes exactly as `packMeshVertices`. */
export function packVertices(mesh: Mesh): NonNullable<Mesh['gpuVertices']> {
  return mesh.relief ? packReliefVertices(mesh) : packMeshVertices(mesh);
}
