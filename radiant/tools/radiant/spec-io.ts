import { closeSync, existsSync, readdirSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep, isAbsolute } from 'node:path';
import { zipSync } from 'fflate';
import { sanitizeSvgDetailed } from '../../src/lib/core/art/svg';
import { writePortableFiles } from '../../src/lib/core/io/portable';
import {
  compileMapSpec, parseMapSpec, SPEC_LIMITS, type CompiledMapSpec, type ParsedMapSpec, type ResolvedSpecAsset, type SpecDiagnostic
} from '../../src/lib/core/io/map-spec';
import type { Doc } from '../../src/lib/core/types';
import { conflict, denied, invalid, nearest, notFound, usageError } from './envelope';
import { sha256 } from './store';

/** The picture importer's limit. */
export const MAX_PICTURE_BYTES = 45 * 1024 * 1024;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

export interface LoadedAsset {
  name: string;
  hash: string;
  mime: string;
  bytes: Uint8Array;
  aspect?: number;
  /** Where it came from: a file path or an embedded hash. */
  source: string;
  /** What sanitising removed (SVG). */
  removed?: string[];
}

/** Reads an asset embedded in another map, for "sha256:" asset references. */
export type EmbeddedAssets = (hash: string) => { bytes: Uint8Array; mime: string } | null;

export interface LoadSpecOptions {
  strict?: boolean;
  allowGeometry?: boolean;
  /** ISO timestamp for created and modified. */
  now?: string;
  /** Directory that asset paths must stay inside. Default: the spec's directory. */
  root?: string;
  assetsFrom?: EmbeddedAssets;
  defaultTitle?: string;
  /** The spec text, when the caller has already read it (stdin). */
  text?: string;
}

export interface LoadedSpec {
  path: string;
  text: string;
  parsed: ParsedMapSpec;
  compiled: CompiledMapSpec;
  assets: LoadedAsset[];
  now: string;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

export async function readStdin(limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
    size += bytes.length;
    if (size > limit) throw invalid('input_too_large', 'Standard input exceeds ' + limit + ' bytes.');
    chunks.push(bytes);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export function decodeText(bytes: Uint8Array, what: string): string {
  try { return decoder.decode(bytes); } catch { throw invalid('not_text', what + ' is not UTF-8 text.'); }
}

/** Timestamp for a build: --now, then SOURCE_DATE_EPOCH, then the spec file's modification time. */
export function buildTime(explicit: string | undefined, file: string | null): string {
  if (explicit) {
    const t = new Date(explicit);
    if (Number.isNaN(t.getTime())) throw usageError('--now needs an ISO date such as 2026-01-01T00:00:00Z.');
    return t.toISOString();
  }
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  if (file) return statSync(file).mtime.toISOString();
  return new Date().toISOString();
}

const inside = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);

function imageType(bytes: Uint8Array): string | null {
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.subarray(a, b));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Width / height from the image header, without decoding pixels. */
export function imageAspect(bytes: Uint8Array, mime: string): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ratio = (w: number, h: number) => (w > 0 && h > 0 ? w / h : undefined);
  try {
    if (mime === 'image/png') return ratio(view.getUint32(16), view.getUint32(20));
    if (mime === 'image/gif') return ratio(view.getUint16(6, true), view.getUint16(8, true));
    if (mime === 'image/webp') {
      const kind = String.fromCharCode(...bytes.subarray(12, 16));
      if (kind === 'VP8 ') return ratio(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
      if (kind === 'VP8L') {
        const b = view.getUint32(21, true);
        return ratio((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
      }
      if (kind === 'VP8X') {
        const w = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
        const h = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
        return ratio(w, h);
      }
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        const length = view.getUint16(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return ratio(view.getUint16(i + 7), view.getUint16(i + 5));
        }
        i += 2 + length;
      }
    }
  } catch { /* truncated header */ }
  return undefined;
}

function svgAspect(svg: string): number | undefined {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const box = /viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)/i.exec(tag);
  if (box) { const w = Number(box[1]); const h = Number(box[2]); if (w > 0 && h > 0) return w / h; }
  const w = Number(/\swidth\s*=\s*["']([\d.]+)/i.exec(tag)?.[1]);
  const h = Number(/\sheight\s*=\s*["']([\d.]+)/i.exec(tag)?.[1]);
  return w > 0 && h > 0 ? w / h : undefined;
}

/**
 * Check, sanitise and hash one picture. PNG, JPEG, WebP and GIF are kept byte for byte; SVG is sanitised and
 * what was removed is reported.
 */
export function preparePicture(name: string, bytes: Uint8Array, source: string, declaredMime?: string): LoadedAsset {
  if (bytes.length > MAX_PICTURE_BYTES) throw new Error('is ' + bytes.length + ' bytes; the limit is ' + MAX_PICTURE_BYTES + '.');
  const raster = imageType(bytes);
  if (raster) return { name, hash: sha256(bytes), mime: raster, bytes, aspect: imageAspect(bytes, raster), source };
  let text: string | null = null;
  try { text = decoder.decode(bytes); } catch { /* binary */ }
  if (text !== null && (declaredMime === 'image/svg+xml' || /<svg[\s>]/i.test(text.slice(0, 4096)))) {
    const aspect = svgAspect(text);
    const { svg, removed } = sanitizeSvgDetailed(text);
    if (!svg) throw new Error('is not a usable SVG (' + (removed.join(', ') || 'no <svg> root') + ').');
    const clean = new TextEncoder().encode(svg);
    return { name, hash: sha256(clean), mime: 'image/svg+xml', bytes: clean, aspect, source, removed };
  }
  throw new Error('is not a PNG, JPEG, WebP, GIF or SVG picture.');
}

function assetLine(text: string, name: string): number | undefined {
  const lines = text.split('\n');
  const k = lines.findIndex((l) => new RegExp('^\\s+["\']?' + name.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '["\']?\\s*:').test(l));
  return k >= 0 ? k + 1 : undefined;
}

/** Read, validate and compile a spec file (or "-" for stdin), resolving its picture assets. */
export async function loadSpec(path: string, opts: LoadSpecOptions = {}): Promise<LoadedSpec> {
  const file = path === '-' ? null : path;
  let text = opts.text;
  if (text === undefined) {
    let bytes: Uint8Array;
    if (file) {
      if (statSync(file).size > SPEC_LIMITS.specBytes) throw invalid('input_too_large', 'The spec is larger than ' + SPEC_LIMITS.specBytes + ' bytes.');
      bytes = readFileSync(file);
    } else bytes = await readStdin(SPEC_LIMITS.specBytes);
    text = decodeText(bytes, file ?? 'Standard input');
  }
  if (text.length > SPEC_LIMITS.specBytes) throw invalid('input_too_large', 'The spec is larger than ' + SPEC_LIMITS.specBytes + ' bytes.');
  const now = buildTime(opts.now, file);
  const parsed = parseMapSpec(text, { allowGeometry: opts.allowGeometry });
  const base = file ? dirname(file) : process.cwd();
  const allowed = realpathSync(opts.root ?? base);
  const assets: LoadedAsset[] = [];
  const resolved: Record<string, ResolvedSpecAsset> = {};
  const extra: SpecDiagnostic[] = [];
  const used = new Set<string>();
  const jsonSpec = text.trimStart().startsWith('{');
  const walk = (nodes: typeof parsed.spec.roots) => { for (const n of nodes) { if (n.image) used.add(n.image); if (n.children) walk(n.children); } };
  walk(parsed.spec.roots);
  for (const el of parsed.spec.canvas ?? []) if (el.image) used.add(el.image);
  for (const [name, value] of Object.entries(parsed.spec.assets ?? {})) {
    const where = jsonSpec ? { path: 'assets.' + name } : { line: assetLine(text, name) };
    const fail = (code: string, message: string, suggestions?: string[]) =>
      extra.push({ severity: 'error', code, ...where, message: 'Asset "' + name + '" ' + message, ...(suggestions?.length ? { suggestions } : {}) });
    if (!used.has(name)) {
      extra.push({ severity: 'warning', code: 'unused_asset', ...where, message: 'Asset "' + name + '" is not used by any node; it was not embedded.' });
      continue;
    }
    try {
      let asset: LoadedAsset;
      const embedded = /^sha256:([a-f0-9]{64})$/.exec(value);
      if (embedded) {
        const found = opts.assetsFrom?.(embedded[1]);
        if (!found) {
          fail('asset_unresolved', opts.assetsFrom ? 'is not embedded in the --assets-from map.' : 'refers to an embedded picture; pass --assets-from MAP to copy it.');
          continue;
        }
        asset = preparePicture(name, found.bytes, value, found.mime);
        if (asset.hash !== embedded[1] && asset.mime !== 'image/svg+xml') throw new Error('does not match its content hash.');
      } else {
        const full = isAbsolute(value) ? value : resolve(base, value);
        if (!existsSync(full)) {
          let names: string[] = [];
          try { names = readdirSync(dirname(full)); } catch { /* none */ }
          fail('asset_not_found', 'file ' + value + ' was not found.', nearest(basename(full), names).map((n) => join(dirname(value), n)));
          continue;
        }
        const real = realpathSync(full);
        if (!inside(real, allowed)) {
          fail('asset_outside_root', 'is outside ' + allowed + '; pictures must sit beside the spec or under --root.');
          continue;
        }
        if (!statSync(real).isFile()) { fail('invalid_asset', 'is not a file.'); continue; }
        if (statSync(real).size > MAX_PICTURE_BYTES) { fail('invalid_asset', 'is larger than ' + MAX_PICTURE_BYTES + ' bytes.'); continue; }
        asset = preparePicture(name, readFileSync(real), relative(base, real) || value, /\.svg$/i.test(real) ? 'image/svg+xml' : undefined);
      }
      if (asset.removed?.length) extra.push({ severity: 'warning', code: 'svg_sanitised', ...where,
        message: 'Asset "' + name + '" was sanitised; removed ' + asset.removed.join(', ') + '.' });
      assets.push(asset);
      resolved[name] = { hash: asset.hash, ...(asset.aspect ? { aspect: Number(asset.aspect.toFixed(6)) } : {}) };
    } catch (e) {
      fail('invalid_asset', e instanceof Error ? e.message : String(e));
    }
  }
  const strict = opts.strict ?? false;
  const merged: ParsedMapSpec = { ...parsed, diagnostics: [...parsed.diagnostics, ...extra] };
  const defaultTitle = opts.defaultTitle ?? (file ? basename(file).replace(/\.map\.md$|\.md$|\.json$/i, '') : undefined);
  const compiled = compileMapSpec(merged, { now, strict, assets: resolved, defaultTitle });
  return { path: file ?? '-', text, parsed, compiled, assets, now };
}

export interface OutputTarget {
  path: string;
  exists: boolean;
}

/**
 * Where a new file may be written: the named path or a path under --root, canonicalised. An existing file is
 * replaced only with replace (the destructive flag); a symlink at the target is refused.
 */
export function prepareOutput(out: string, opts: { replace?: boolean; root?: string }): OutputTarget {
  const abs = resolve(out);
  const parent = dirname(abs);
  if (!existsSync(parent)) throw notFound('directory_not_found', 'The folder ' + parent + ' does not exist.');
  const target = join(realpathSync(parent), basename(abs));
  if (opts.root !== undefined) {
    if (!existsSync(opts.root)) throw notFound('directory_not_found', 'The --root folder ' + opts.root + ' does not exist.');
    const root = realpathSync(opts.root);
    if (!inside(target, root)) throw denied('outside_root', target + ' is outside --root ' + root + '.', { hint: 'Write under ' + root + ' or change --root.' });
  }
  let exists = false;
  try {
    const st = lstatSync(target);
    exists = true;
    if (st.isSymbolicLink()) throw denied('symlink_refused', target + ' is a symbolic link; the tool never writes through links.');
    if (st.isDirectory()) throw conflict('file_exists', target + ' is a folder.');
    if (!opts.replace) throw conflict('file_exists', target + ' already exists.', { hint: 'Choose a new name, or pass --replace to overwrite it.' });
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  return { path: target, exists };
}

/** Write bytes atomically: a temporary file in the same folder, synced, then linked (new) or renamed (replace). */
export function writeAtomic(target: OutputTarget, bytes: Uint8Array, replace: boolean): void {
  const tmp = join(dirname(target.path), '.' + basename(target.path) + '.' + randomBytes(6).toString('hex') + '.tmp');
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    let at = 0;
    while (at < bytes.length) at += writeSync(fd, bytes, at, bytes.length - at);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    if (replace) renameSync(tmp, target.path);
    else {
      try { linkSync(tmp, target.path); } catch (e) {
        if ((e as { code?: string }).code === 'EEXIST') throw conflict('file_exists', target.path + ' already exists.', { hint: 'Pass --replace to overwrite it.' });
        throw e;
      }
      unlinkSync(tmp);
    }
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already moved */ }
    throw e;
  }
}

/** A portable bundle (manifest.json, map.json, assets/) as deterministic ZIP bytes. */
export async function portableBundle(doc: Doc, assets: ReadonlyMap<string, { bytes: Uint8Array; mime: string }>): Promise<Uint8Array> {
  const files = await writePortableFiles(doc, async (hash) => {
    const asset = assets.get(hash);
    if (!asset) throw invalid('asset_missing', 'The map refers to picture ' + hash.slice(0, 12) + ' but its bytes are not available.');
    return asset;
  });
  const mtime = new Date(doc.modified);
  const archive = zipSync({ ...files, 'assets/': new Uint8Array() }, { level: 0, mtime: Number.isNaN(mtime.getTime()) ? new Date(0) : mtime });
  if (archive.length > MAX_ZIP_BYTES) throw invalid('output_too_large', 'The portable bundle would be larger than 50 MB.');
  return archive;
}

/** Output names a portable bundle can take. */
export function bundlePath(out: string): void {
  if (/\.radiant$/i.test(out)) {
    throw usageError('This version writes portable bundles, not native .radiant files.', {
      suggestions: [out + '.zip'],
      hint: 'Use -o ' + basename(out) + '.zip, then open it in Radiant with File > Import.'
    });
  }
  if (!/\.zip$/i.test(out)) throw usageError('The output must be a portable bundle ending in .radiant.zip or .zip.', { suggestions: [out + '.radiant.zip'] });
}
