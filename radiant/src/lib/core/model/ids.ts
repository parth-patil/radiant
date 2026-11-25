import type { NodeId } from '../types';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 12;
/** Largest multiple of 62 that fits in a byte; bytes at or above it are rejected to avoid modulo bias. */
const LIMIT = 248;

/**
 * Create a new random id: 12 base62 characters (about 71 bits), drawn from crypto.getRandomValues.
 * Collision probability is negligible even across millions of nodes.
 */
export function newId(): NodeId {
  let out = '';
  const buf = new Uint8Array(new ArrayBuffer(24));
  while (out.length < ID_LENGTH) {
    fillRandom(buf);
    for (let i = 0; i < buf.length && out.length < ID_LENGTH; i++) {
      const b = buf[i];
      if (b < LIMIT) out += ALPHABET[b % 62];
    }
  }
  return out;
}

function fillRandom(buf: Uint8Array<ArrayBuffer>): void {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(buf);
  } else {
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  }
}
