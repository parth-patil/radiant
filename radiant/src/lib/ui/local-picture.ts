const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml'
};
export const LOCAL_PICTURE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.svg';
const MIME_TYPES = new Set(Object.values(MIME_BY_EXTENSION));
const MAX_BYTES = 45 * 1024 * 1024;

export function picturePathMime(name: string): string | undefined {
  const ext = name.split('.').at(-1)?.toLowerCase();
  return ext && Object.hasOwn(MIME_BY_EXTENSION, ext) ? MIME_BY_EXTENSION[ext] : undefined;
}

export function pictureMime(file: File): string | undefined {
  const byName = picturePathMime(file.name);
  return MIME_TYPES.has(file.type) ? file.type : (!file.type || file.type === 'application/octet-stream') && byName ? byName : undefined;
}

export function pictureFile(transfer: DataTransfer | null): File | undefined {
  if (!transfer) return;
  for (const file of transfer.files) if (pictureMime(file)) return file;
  for (const item of transfer.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file && pictureMime(file)) return file;
    }
  }
}

export async function pictureFromDrop(transfer: DataTransfer | null): Promise<File | undefined> {
  const file = pictureFile(transfer);
  if (file || !transfer) return file;
  const supplied = transfer.getData('text/uri-list').split(/\r?\n/).find((line) => line && !line.startsWith('#'));
  const html = transfer.getData('text/html');
  const template = document.createElement('template');
  template.innerHTML = html;
  const markup = template.content.querySelector('img')?.getAttribute('src');
  const source = markup || supplied;
  if (!source) return;
  const url = new URL(source, location.href);
  if (url.username || url.password || !['http:', 'https:', 'data:', 'blob:'].includes(url.protocol)) return;
  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== location.origin) {
    throw new Error('Drop an image file or paste the copied image pixels to add it to this map.');
  }
  if (!markup && !url.pathname.match(/\.(png|jpe?g|webp|gif|svg)$/i) && !['data:', 'blob:'].includes(url.protocol)) return;
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('The dropped image could not be read.');
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Pictures must be smaller than 45 MB.');
  const type = response.headers.get('content-type')?.split(';')[0].toLowerCase();
  if (!type || !MIME_TYPES.has(type) || !response.body) return;
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('Pictures must be smaller than 45 MB.');
    }
    chunks.push(new Uint8Array(value));
  }
  const ext = Object.keys(MIME_BY_EXTENSION).find((name) => MIME_BY_EXTENSION[name] === type);
  return new File(chunks, `Picture.${ext}`, { type });
}

export function checkedPictureMime(file: File): string {
  const mime = pictureMime(file);
  if (!mime) throw new Error('Choose a PNG, JPEG, WebP, GIF or SVG picture.');
  if (file.size > MAX_BYTES) throw new Error('Pictures must be smaller than 45 MB.');
  return mime;
}
