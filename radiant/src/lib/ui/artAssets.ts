import { artworkProvenance } from '../core/asset-meta';
import { decodeToPixels } from '../render/pixel-image';
import { defaultAnchors, transparentShare, trimAndPad, type PixelImage } from '../core/art';
import type { NodeArt, NodeId, Vec2 } from '../core/types';
import type { Host } from '../host/types';

export const ART_STYLE_VERSION = 1;

/** Hash structured inputs so unchanged art can be reused across nodes. */
export async function artInputHash(...inputs: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([ART_STYLE_VERSION, ...inputs]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Remove a solid or smoothly shaded background connected to the outer border. */
function removeSmoothBackground(image: PixelImage): boolean {
  const { width: w, height: h, data } = image;
  if (w < 3 || h < 3) return false;
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map(i => i * 4);
  const close = (i: number) => {
    const u = (i % w) / (w - 1);
    const v = Math.floor(i / w) / (h - 1);
    for (let channel = 0; channel < 3; channel++) {
      const top = data[corners[0] + channel] * (1 - u) + data[corners[1] + channel] * u;
      const bottom = data[corners[2] + channel] * (1 - u) + data[corners[3] + channel] * u;
      if (Math.abs(data[i * 4 + channel] - (top * (1 - v) + bottom * v)) >= 24) return false;
    }
    return true;
  };
  return removeConnectedBackground(image, close);
}

/** A small recurring palette along all four edges also covers tiled and checkerboard backdrops. */
function removePatternedBackground(image: PixelImage): boolean {
  const { width, height, data } = image;
  if (width < 3 || height < 3) return false;
  const counts = new Map<number, number>();
  let samples = 0;
  const sample = (i: number) => {
    const key = (data[4 * i] << 16) | (data[4 * i + 1] << 8) | data[4 * i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
    samples++;
  };
  for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 1024))) {
    sample(x); sample((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 1024))) {
    sample(y * width); sample(y * width + width - 1);
  }
  const palette = [...counts].filter(([, n]) => n >= samples * 0.05)
    .sort((a, b) => b[1] - a[1]).slice(0, 4).map(([rgb]) => [rgb >> 16, (rgb >> 8) & 255, rgb & 255]);
  if (palette.length < 2) return false;
  return removeConnectedBackground(image, i => {
    const offset = 4 * i;
    return palette.some(([r,g,b]) => Math.abs(data[offset] - r) <= 12 &&
      Math.abs(data[offset + 1] - g) <= 12 && Math.abs(data[offset + 2] - b) <= 12);
  });
}

function removeConnectedBackground(image: PixelImage, close: (i: number) => boolean): boolean {
  const { width: w, height: h, data } = image;
  // Require the background model on every side before using it inside the image.
  const matches = (start: number, length: number, step: number) => {
    let matching = 0;
    for (let i = 0; i < length; i++) if (close(start + i * step)) matching++;
    return matching / length >= 0.9;
  };
  if (!matches(0, w, 1) || !matches((h - 1) * w, w, 1) ||
      !matches(0, h, w) || !matches(w - 1, h, w)) return false;
  const visited = new Uint8Array(w * h);
  const queue = new Uint32Array(w * h);
  let read = 0, write = 0;
  const add = (i: number) => {
    if (visited[i]) return;
    visited[i] = 1;
    if (close(i)) queue[write++] = i;
  };
  for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
  while (read < write) {
    const i = queue[read++];
    const x = i % w;
    if (x > 0) add(i - 1);
    if (x < w - 1) add(i + 1);
    if (i >= w) add(i - w);
    if (i < w * (h - 1)) add(i + w);
  }
  const coverage = write / (w * h);
  if (coverage < 0.12 || coverage > 0.96) return false;
  for (let i = 0; i < write; i++) data[queue[i] * 4 + 3] = 0;
  return true;
}

async function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The artwork could not be encoded.');
  return new Uint8Array(await blob.arrayBuffer());
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function pictureAnchors(mask: PixelImage, inward: Vec2, outward: Vec2, children: Array<[NodeId, Vec2]>): NodeArt['anchors'] {
  const directions = [outward, ...children.map(([, direction]) => direction)];
  const anchors = defaultAnchors(mask, { towardParent: inward, towardChildren: directions });
  const outByChild = Object.fromEntries(children.map(([id], index) => [id, anchors.out[index + 1]]));
  return { in: anchors.in, out: anchors.out[0], outByChild };
}

async function picturePixels(host: Host, hash: string, signal: AbortSignal): Promise<PixelImage> {
  const response = await fetch(await host.assetUrl(hash), { signal });
  if (!response.ok) throw new Error('The generated picture could not be loaded.');
  const pixels = await decodeToPixels(await response.blob());
  signal.throwIfAborted();
  return pixels;
}

export async function attachFinishedPicture(
  host: Host, art: NodeArt, inward: Vec2, outward: Vec2, children: Array<[NodeId, Vec2]>, signal: AbortSignal
): Promise<NodeArt> {
  const mask = await picturePixels(host, art.assetHash, signal);
  return { ...art, anchors: pictureAnchors(mask, inward, outward, children) };
}

export async function finishPicture(
  host: Host, art: NodeArt, inward: Vec2, outward: Vec2,
  children: Array<[NodeId, Vec2]>, plain: boolean, signal: AbortSignal
): Promise<NodeArt> {
  const pixels = await picturePixels(host, art.assetHash, signal);
  let framed = plain;
  if (!plain && transparentShare(pixels) < 0.04 && !removeSmoothBackground(pixels) && !removePatternedBackground(pixels)) {
    const alpha = await host.assetForegroundMask?.(art.assetHash, pixels.width, pixels.height);
    signal.throwIfAborted();
    // Keep a real subject and a meaningful transparent region. An empty or uniform mask
    // leaves the original pixels available to the framed fallback.
    const hasCutout = alpha?.length === pixels.width * pixels.height &&
      alpha.some(value => value > 127) && alpha.reduce((n, value) => n + Number(value < 16), 0) >= alpha.length * 0.04;
    framed = !hasCutout;
    if (hasCutout) {
      for (let i = 0; i < alpha.length; i++) {
        pixels.data[i * 4 + 3] = Math.round(pixels.data[i * 4 + 3] * alpha[i] / 255);
      }
    }
  }
  const trimmed = framed ? null : trimAndPad(pixels);
  if (!framed && !trimmed) throw new Error('The generated picture has no visible artwork.');
  const image = trimmed?.image ?? pixels;
  const { width, height } = image;
  const raw = canvasFor(width, height);
  const ctx = raw.getContext('2d');
  if (!ctx) throw new Error('The generated picture could not be prepared.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), width, height), 0, 0);

  let picture = raw;
  let mask = image;
  if (framed) {
    const frame = canvasFor(width, height);
    const frameCtx = frame.getContext('2d');
    if (frameCtx && typeof frameCtx.roundRect === 'function') {
      frameCtx.beginPath();
      frameCtx.roundRect(0, 0, width, height, Math.min(width, height) * 0.075);
      frameCtx.clip();
      frameCtx.drawImage(raw, 0, 0);
      picture = frame;
      mask = frameCtx.getImageData(0, 0, width, height);
    }
  }
  const anchors = pictureAnchors(mask, inward, outward, children);

  const bytes = await pngBytes(picture);
  signal.throwIfAborted();
  const originalAsset = art.originalAsset ?? art.assetHash;
  const metadata = artworkProvenance({ ...art, originalAsset });
  const assetHash = await host.assetPut(bytes, 'image/png', metadata);
  const scale = Math.min(1, 160 / Math.max(width, height));
  let thumbnailHash = assetHash;
  if (scale < 1) {
    const thumbnail = canvasFor(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const thumbCtx = thumbnail.getContext('2d');
    if (thumbCtx) {
      thumbCtx.imageSmoothingQuality = 'high';
      thumbCtx.drawImage(picture, 0, 0, thumbnail.width, thumbnail.height);
      const thumbBytes = await pngBytes(thumbnail);
      signal.throwIfAborted();
      thumbnailHash = await host.assetPut(thumbBytes, 'image/png', { ...metadata, parentAsset: assetHash });
    }
  }
  return {
    ...art, assetHash, originalAsset: originalAsset !== assetHash ? originalAsset : undefined, thumbnailHash, framed, pixelSize: { width, height, padding: trimmed?.padding ?? 0 },
    anchors
  };
}
