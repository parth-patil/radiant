import { parse } from 'plist';
import type { BundledAsset } from '../core/io/portable';
import { isMindNodeArchive, openMindNode } from '../core/io/mindnode-archive';
import { parseMindNodeClassic } from '../core/io/mindnode';
import { parseMindNodeNext } from '../core/io/mindnode-next';
import { decodeImageAspect } from '../host/image-preview';
import type { Host } from '../host/types';

export { isMindNodeArchive };

function imageMime(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
}

/** Resolve binary attachments after the pure plist or protobuf importer has verified the document structure. */
export async function parseMindNode(bytes: Uint8Array, title: string, host: Pick<Host, 'rasterizeImportedPdf'>) {
  const archive = openMindNode(bytes);
  const map = archive.next
    ? parseMindNodeNext(archive.content, title)
    : parseMindNodeClassic(parse(archive.content), title);
  const resources = archive.resources(map.attachments.flatMap((attachment) => attachment.entry ? [attachment.entry] : []));
  const assets = new Map<string, BundledAsset>();
  const aspects = new Map<string, number | undefined>();
  const resolved = new Map<string, BundledAsset | undefined>();
  let total = 0;
  for (const attachment of map.attachments) {
    const node = map.doc.nodes[attachment.node];
    const name = attachment.entry;
    let asset: BundledAsset | undefined;
    const cacheKey = name + (attachment.tint ?? '');
    const source = name && Object.hasOwn(resources, name) ? resources[name] : undefined;
    if (name && source) {
      if (!resolved.has(cacheKey)) {
        let data = source;
        if (data[0] === 37 && String.fromCharCode(...data.subarray(1, 5)) === 'PDF-' && host.rasterizeImportedPdf) {
          const rendered = await host.rasterizeImportedPdf(data, attachment.tint).catch(() => undefined);
          if (rendered) data = rendered;
        }
        const mime = imageMime(data);
        if (mime) {
          const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
          const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
          if (assets.has(hash)) asset = assets.get(hash);
          else if (total + data.length <= 50 * 1024 * 1024) {
            asset = { hash, mime, bytes: data, meta: { createdBy: 'user' } };
            assets.set(hash, asset);
            const url = URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime }));
            try {
              aspects.set(hash, await decodeImageAspect(url).catch(() => undefined));
            } finally {
              URL.revokeObjectURL(url);
            }
            total += data.length;
          } else map.skipped.add('attachments beyond the 50 MB map limit');
        } else map.skipped.add('attachments without a supported image preview');
        resolved.set(cacheKey, asset);
      } else asset = resolved.get(cacheKey);
    }
    if (asset) {
      node.imageAsset = asset.hash;
      node.imageAspect = aspects.get(asset.hash);
      node.imageAlt = attachment.name.replace(/\.[^.]+$/, '').slice(0, 160);
      const size = attachment.size;
      if (size && size.x > 0 && size.y > 0) {
        const baseHeight = Math.min(100, 220 * size.y / size.x);
        node.imageScale = Math.max(0.25, Math.min(6, size.y / baseHeight));
      }
    } else if (attachment.symbol) node.sticker = attachment.symbol;
    else if (name && !source) map.skipped.add('missing attachment files');
  }
  return { doc: map.doc, skipped: [...map.skipped], assets: [...assets.values()] };
}
