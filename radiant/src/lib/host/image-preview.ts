import { rgbaToThumbHash } from 'thumbhash';
import { THUMBNAIL_LEVELS, type ThumbnailLevels } from '../core/image-levels';

export async function decodeImageAspect(url: string): Promise<number> {
  const image = new Image();
  image.src = url;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('The image has no dimensions.');
  return image.naturalWidth / image.naturalHeight;
}

export interface BrowserImagePreview {
  aspect: number;
  thumbHash: string;
  thumbnail: Blob;
  thumbnails?: ThumbnailLevels<Blob>;
}

async function withPreviewSource<T>(
  blob: Blob,
  use: (aspect: number, draw: (limit: number) => void, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => Promise<T>
): Promise<T> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) throw new Error('The image has no dimensions.');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('The image preview could not be drawn.');
    const draw = (limit: number) => {
      const scale = Math.min(1, limit / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    };
    return await use(width / height, draw, canvas, ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function previewPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('The thumbnail could not be encoded.')), 'image/png');
  });
}

async function encodeLevels(draw: (limit: number) => void, canvas: HTMLCanvasElement): Promise<ThumbnailLevels<Blob>> {
  const thumbnails: ThumbnailLevels<Blob> = {};
  for (const level of THUMBNAIL_LEVELS) {
    draw(level);
    thumbnails[level] = await previewPng(canvas);
  }
  return thumbnails;
}

export function makeThumbnailLevels(legacy: Blob): Promise<ThumbnailLevels<Blob>> {
  return withPreviewSource(legacy, (_aspect, draw, canvas) => encodeLevels(draw, canvas));
}

export function makeImagePreview(blob: Blob): Promise<BrowserImagePreview> {
  return withPreviewSource(blob, async (aspect, draw, canvas, ctx) => {
    draw(100);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const thumbHash = btoa(String.fromCharCode(...rgbaToThumbHash(canvas.width, canvas.height, data)));
    draw(160);
    const thumbnail = await previewPng(canvas);
    return { aspect, thumbHash, thumbnail, thumbnails: await encodeLevels(draw, canvas) };
  });
}
