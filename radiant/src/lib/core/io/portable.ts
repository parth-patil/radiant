import { withSubtreeArtStyles } from '../art/subtree-style';
import { unzipSync, zipSync } from 'fflate';
import { parseDocReport } from '../model';
import type { Doc, NodeArt } from '../types';
import { artworkProvenance, type AssetMeta } from '../asset-meta';

const MAX_BUNDLE_BYTES = 48 * 1024 * 1024;
const MAX_ZIP_BYTES = 50 * 1024 * 1024;
const MAX_MAP_BYTES = 20 * 1024 * 1024;
const FILES = new Map([
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp'],
  ['gif', 'image/gif'], ['svg', 'image/svg+xml'], ['bin', 'application/octet-stream']
]);
const ASSET = /^assets\/([a-f0-9]{64})\.(png|jpg|webp|gif|svg|bin)$/;
const MANIFEST = 'manifest.json';
const MAP = 'map.json';
const FORMAT = 'radiant-bundle';
const encode = new TextEncoder();
export type PortableFiles = Record<string, Uint8Array>;

export function isPortableFile(name: string): boolean {
  return name === MANIFEST || name === MAP || ASSET.test(name);
}

const decode = new TextDecoder('utf-8', { fatal: true });

export interface BundledAsset {
  hash: string;
  bytes: Uint8Array;
  mime: string;
  meta?: AssetMeta;
}

export function imageReferences(doc: Doc): Map<string, AssetMeta | undefined> {
  const assets = new Map<string, AssetMeta | undefined>();
  const add = (hash: string | undefined, meta?: AssetMeta) => {
    if (!hash) return;
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('The map contains an invalid asset reference.');
    if (!assets.has(hash) || (!assets.get(hash) && meta)) assets.set(hash, meta);
  };
  const generated = (art: NodeArt | undefined) => {
    if (!art) return;
    const meta = artworkProvenance(art);
    add(art.assetHash, meta);
    add(art.svgRegion?.assetHash);
    if (art.originalAsset !== art.assetHash) add(art.originalAsset, { ...meta, originalAsset: undefined });
    if (art.thumbnailHash !== art.assetHash) add(art.thumbnailHash, { ...meta, parentAsset: art.assetHash });
  };
  for (const node of Object.values(doc.nodes)) {
    add(node.imageAsset);
    generated(node.pictureArt);
    generated(node.svgArt);
    generated(node.artReference);
  }
  for (const element of doc.canvas?.elements ?? []) add(element.asset);
  return assets;
}

async function verify(hash: string, bytes: Uint8Array): Promise<void> {
  if (!globalThis.crypto?.subtle) return;
  const payload = new Uint8Array(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
  const actual = [...digest].map((c) => c.toString(16).padStart(2, '0')).join('');
  if (actual !== hash) throw new Error(`Asset ${hash.slice(0, 12)} does not match its content hash.`);
}

type ReadAsset = (hash: string) => Promise<{ bytes: Uint8Array; mime: string }>;

export async function writePortableFiles(doc: Doc, read: ReadAsset): Promise<PortableFiles> {
  const files: PortableFiles = {
    [MANIFEST]: encode.encode(JSON.stringify({ format: FORMAT, version: 1 }, null, 2) + '\n'),
    [MAP]: encode.encode(JSON.stringify(withSubtreeArtStyles(doc), null, 2) + '\n')
  };
  if (files[MAP].length > MAX_MAP_BYTES) throw new Error('The map JSON is too large for a portable bundle.');
  let size = files[MAP].length + files[MANIFEST].length;
  for (const hash of imageReferences(doc).keys()) {
    const { bytes, mime } = await read(hash);
    size += bytes.length;
    if (size > MAX_BUNDLE_BYTES) throw new Error('This portable map is larger than 48 MB. Try exporting a selected branch.');
    await verify(hash, bytes);
    const ext = [...FILES].find(([, type]) => type === mime)?.[0] ?? 'bin';
    files[`assets/${hash}.${ext}`] = bytes;
  }
  return files;
}

export async function writePortableMap(doc: Doc, read: ReadAsset): Promise<Uint8Array<ArrayBuffer>> {
  const archive = zipSync({ ...await writePortableFiles(doc, read), 'assets/': new Uint8Array() }, { level: 0 });
  if (archive.length > MAX_ZIP_BYTES) throw new Error('The portable archive is too large. Try exporting a selected branch.');
  return new Uint8Array(archive);
}

export async function readPortableMap(bytes: Uint8Array): Promise<{ doc: Doc; assets: BundledAsset[]; skipped: string[] }> {
  if (bytes.length > MAX_ZIP_BYTES) throw new Error('This portable archive is larger than 50 MB.');
  let size = 0;
  const seen = new Set<string>();
  const files = unzipSync(bytes, {
    filter({ name, originalSize }) {
      if (!isPortableFile(name)) return false;
      if (seen.has(name)) throw new Error('The map bundle contains duplicate entries.');
      seen.add(name);
      size += originalSize;
      if (size > MAX_BUNDLE_BYTES || (name === MAP && originalSize > MAX_MAP_BYTES) || (name === MANIFEST && originalSize > 4096)) {
        throw new Error('This portable map exceeds Radiant’s import size limit.');
      }
      return true;
    }
  });
  return readPortableFiles(files);
}

export async function readPortableFiles(files: PortableFiles): Promise<{ doc: Doc; assets: BundledAsset[]; skipped: string[] }> {
  if (!Object.hasOwn(files, MANIFEST) || !Object.hasOwn(files, MAP)) throw new Error('This folder or ZIP does not contain a Radiant portable map.');
  const total = Object.entries(files).reduce((n, [name, bytes]) => n + (isPortableFile(name) ? bytes.length : 0), 0);
  if (total > MAX_BUNDLE_BYTES || files[MAP].length > MAX_MAP_BYTES || files[MANIFEST].length > 4096) {
    throw new Error('This portable map exceeds Radiant’s import size limit.');
  }
  const manifest = JSON.parse(decode.decode(files[MANIFEST]));
  if (manifest?.format !== FORMAT || manifest.version !== 1) throw new Error('This Radiant portable map version is unsupported.');
  const { doc, repairs } = parseDocReport(decode.decode(files[MAP]));
  const expected = imageReferences(doc);
  const assets: BundledAsset[] = [];
  const found = new Set<string>();
  for (const [file, data] of Object.entries(files)) {
    const match = ASSET.exec(file);
    if (!match || !expected.has(match[1])) continue;
    const [, hash, ext] = match;
    if (found.has(hash)) throw new Error('The map bundle contains duplicate copies of an asset.');
    found.add(hash);
    await verify(hash, data);
    assets.push({ hash, bytes: data, mime: FILES.get(ext)!, meta: expected.get(hash) });
  }
  if (found.size !== expected.size) throw new Error('The portable map is missing one or more referenced assets.');
  return { doc, assets, skipped: repairs };
}
