import { unzipSync } from 'fflate';
import type { Doc, NodeId, Vec2 } from '../types';

const DOCUMENT_LIMIT = 16 * 1024 * 1024;
const ATTACHMENT_LIMIT = 12 * 1024 * 1024;
const TOTAL_LIMIT = 50 * 1024 * 1024;
const FILE_LIMIT = 2048;

export interface MindNodeAttachment {
  node: NodeId;
  name: string;
  entry?: string;
  size?: Vec2;
  symbol?: string;
  tint?: string;
}

export interface MindNodeImport {
  doc: Doc;
  skipped: Set<string>;
  attachments: MindNodeAttachment[];
}

export interface MindNodeArchive {
  content: Uint8Array;
  next: boolean;
  resources(names: Iterable<string>): Record<string, Uint8Array>;
}

export function isAttachmentName(name: string): boolean {
  return !!name && name.length <= 255 && name !== '.' && name !== '..' && !/[\\/\x00-\x1f]/.test(name);
}

function documentEntries(bytes: Uint8Array) {
  // Read the central directory without expanding previews or attachments.
  const classic = new Set<string>();
  const next = new Set<string>();
  const metadata = new Set<string>();
  const names = new Set<string>();
  unzipSync(bytes, {
    filter({ name }) {
      if (names.size >= FILE_LIMIT) throw new Error('The MindNode archive contains too many entries.');
      if (names.has(name)) throw new Error('The MindNode archive contains duplicate files.');
      names.add(name);
      const path = /^(?:([^/\\]+\.mindnode)\/)?(contents\.xml|Contents\.data|Metadata\.json)$/.exec(name);
      if (path) {
        const prefix = path[1] ? path[1] + '/' : '';
        if (path[2] === 'contents.xml') classic.add(prefix);
        if (path[2] === 'Contents.data') next.add(prefix);
        if (path[2] === 'Metadata.json') metadata.add(prefix);
      }
      return false;
    }
  });
  return [...classic].map((prefix) => ({ prefix, next: false }))
    .concat([...next].filter((prefix) => metadata.has(prefix)).map((prefix) => ({ prefix, next: true })));
}

export function isMindNodeArchive(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return documentEntries(bytes).length > 0;
}

export function openMindNode(bytes: Uint8Array): MindNodeArchive {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    if (bytes.length > DOCUMENT_LIMIT) throw new Error('The MindNode document content is too large.');
    return { content: bytes, next: false, resources: () => Object.create(null) };
  }

  const possible = documentEntries(bytes);
  if (possible.length !== 1) throw new Error(possible.length
    ? 'The archive contains more than one MindNode document.'
    : 'The archive does not have readable MindNode document content.');
  const [{ prefix, next: isNext }] = possible;
  const contentName = prefix + (isNext ? 'Contents.data' : 'contents.xml');
  const metaName = prefix + 'Metadata.json';
  const entries = unzipSync(bytes, {
    filter({ name, originalSize }) {
      if (name !== contentName && !(isNext && name === metaName)) return false;
      if (originalSize > (name === metaName ? 65_536 : DOCUMENT_LIMIT)) throw new Error('The MindNode document content is too large.');
      return true;
    }
  });
  if (isNext) {
    const meta: unknown = JSON.parse(new TextDecoder().decode(entries[metaName]));
    if (!meta || typeof meta !== 'object' || !('fileFormatVersion' in meta) || meta.fileFormatVersion !== 1) {
      throw new Error('This MindNode Next file uses an unsupported format. Export it as MindNode Classic or OPML.');
    }
  }
  return {
    content: entries[contentName],
    next: isNext,
    resources(wanted) {
      const lookup = new Set([...wanted].filter(isAttachmentName).map((name) => prefix + (isNext ? 'Assets/' : 'resources/') + name));
      let total = 0;
      const data = unzipSync(bytes, {
        filter({ name, originalSize }) {
          if (!lookup.has(name) || originalSize > ATTACHMENT_LIMIT) return false;
          total += originalSize;
          if (total > TOTAL_LIMIT) throw new Error('The MindNode attachments exceed the 50 MB import limit.');
          return true;
        }
      });
      return Object.fromEntries(Object.entries(data).map(([entry, raw]) => [entry.slice(entry.lastIndexOf('/') + 1), raw]));
    }
  };
}
