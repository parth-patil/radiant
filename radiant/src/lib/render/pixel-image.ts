import type { PixelImage } from '../core/art';

/** Decode an artwork asset into the pixel mask used to find its visible edges. */
export async function decodeToPixels(blob: Blob): Promise<PixelImage> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (!width || !height) throw new Error('The generated picture has no dimensions.');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The generated picture could not be prepared.');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}
