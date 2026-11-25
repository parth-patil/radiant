export interface BitmapRequest {
  id: number;
  source: string | Blob;
  maxDimension: number;
}

export type BitmapReply = { id: number; bitmap: ImageBitmap } | { id: number; error: true };

const worker = self as unknown as {
  onmessage: ((message: MessageEvent<BitmapRequest>) => void) | null;
  postMessage: (reply: BitmapReply, transfer?: Transferable[]) => void;
};

worker.onmessage = async ({ data: { id, source, maxDimension } }) => {
  let bitmap: ImageBitmap | undefined;
  try {
    if (typeof source === 'string') {
      const response = await fetch(source);
      if (!response.ok) throw new Error('Image asset could not be read');
      source = await response.blob();
    }
    bitmap = await createImageBitmap(source, { premultiplyAlpha: 'premultiply' });
    const dim = Math.max(bitmap.width, bitmap.height);
    if (dim > maxDimension) {
      const scale = maxDimension / dim;
      const resized = await createImageBitmap(bitmap, {
        resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
        resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
        resizeQuality: 'high',
        premultiplyAlpha: 'premultiply'
      });
      bitmap.close();
      bitmap = resized;
    }
    worker.postMessage({ id, bitmap }, [bitmap]);
  } catch {
    bitmap?.close();
    worker.postMessage({ id, error: true });
  }
};
