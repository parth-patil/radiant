import { thumbHashToRGBA } from 'thumbhash';
import type { ThumbnailLevels } from '../core/image-levels';
import type { BitmapReply, BitmapRequest } from './bitmap.worker';

type PreviewPage = {
  texture: WebGLTexture;
  tileSize: number;
  slots: (ImageEntry | undefined)[];
  free: number[];
};

export interface ImageEntry {
  src: string;
  cacheKey: string;
  vectorResolution: number;
  previewResolution?: number;
  state: 'loading' | 'decoded' | 'ready' | 'error';
  decodeFailed?: boolean;
  tex: WebGLTexture | null;
  w: number;
  h: number;
  bytes: number;
  lastFrame: number;
  screenPixels: number;
  bitmap: ImageBitmap | null;
  uv?: readonly [number, number, number, number];
  page?: PreviewPage;
  slot?: number;
}

export interface ImageCacheOptions {
  /** GPU memory budget for image textures (bytes, mipmaps included). Default 256 MB. */
  budgetBytes?: number;
  /** Larger images are downscaled when decoded. Default 2048. */
  maxDim?: number;
  maxConcurrent?: number;
}

/** Loads images on demand (createImageBitmap), uploads them with mipmaps, evicts least recently used. */
export class ImageCache {
  private map = new Map<string, ImageEntry>();
  private uploadQueue: ImageEntry[] = [];
  private inflight = 0;
  private bytes = 0;
  private frame = 0;
  private pages = new Set<PreviewPage>();
  private readonly pageSide: number;
  readonly budgetBytes: number;
  readonly maxDim: number;
  readonly maxConcurrent: number;
  private waiting: ImageEntry[] = [];
  private disposed = false;
  private decoder: Worker | null = null;
  private decoderUnavailable = false;
  private decodingId = 0;
  private decoding = new Map<number, (value: ImageBitmap | null) => void>();

  private cacheKey(src: string, resolution: number): string {
    return resolution ? `${src}\u0000${resolution}` : src;
  }

  constructor(
    private gl: WebGL2RenderingContext,
    private onReady: () => void,
    opts: ImageCacheOptions = {}
  ) {
    this.budgetBytes = Math.max(0, Math.floor(opts.budgetBytes ?? 256 * 1024 * 1024));
    const budgetDimension = Math.max(1, Math.floor(Math.sqrt(this.budgetBytes * 3 / 16)));
    this.maxDim = Math.min(opts.maxDim ?? 2048, budgetDimension, gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.maxConcurrent = opts.maxConcurrent ?? 6;
    const pageLimit = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE), Math.sqrt(this.budgetBytes / 16));
    this.pageSide = pageLimit >= 256 ? 2 ** Math.floor(Math.log2(pageLimit)) : 0;
  }

  get textureCount(): number {
    let n = this.pages.size;
    for (const e of this.map.values()) if (e.tex && !e.page) n++;
    return n;
  }
  get gpuBytes(): number {
    return this.bytes;
  }
  get loadingCount(): number {
    return this.inflight + this.waiting.length + this.uploadQueue.length;
  }

  beginFrame(frame: number): void {
    this.frame = frame;
    // Newest requests first: those are the ones on screen now.
    this.pump();
  }

  /** Returns the entry (and starts loading it if unknown). Draw only when entry.state === 'ready'. */
  get(src: string, vectorResolution = 0, screenPixels = 0, previewResolution = 0): ImageEntry {
    const cacheKey = this.cacheKey(src, vectorResolution || -previewResolution);
    let e = this.map.get(cacheKey);
    if (!e) {
      e = { src, cacheKey, vectorResolution, previewResolution, state: 'loading', tex: null, w: 0, h: 0, bytes: 0, lastFrame: this.frame, screenPixels, bitmap: null };
      this.map.set(cacheKey, e);
      this.waiting.push(e);
    }
    this.touch(e, screenPixels);
    return e;
  }

  /** Upload the compact placeholder directly. It never waits for the bitmap decoder. */
  blurredTexture(thumbHash: string, screenPixels: number, deadline = Number.POSITIVE_INFINITY): WebGLTexture | null {
    const cacheKey = 'thumb:' + thumbHash;
    const known = this.map.get(cacheKey);
    if (known) {
      this.touch(known, screenPixels);
      return known.tex;
    }
    if (thumbHash.length > 64 || performance.now() >= deadline) return null;
    try {
      const hash = Uint8Array.from(atob(thumbHash), c => c.charCodeAt(0));
      if (hash.length < 5) return null;
      const { w, h, rgba } = thumbHashToRGBA(hash);
      if (!(w > 0 && h > 0 && w <= 32 && h <= 32 && rgba.length === w * h * 4)) return null;
      for (let i = 0; i < rgba.length; i += 4) {
        const alpha = rgba[i + 3] / 255;
        rgba[i] = Math.round(rgba[i] * alpha);
        rgba[i + 1] = Math.round(rgba[i + 1] * alpha);
        rgba[i + 2] = Math.round(rgba[i + 2] * alpha);
      }
      // Preserve textures drawn last frame until this frame's visible set is fully visited.
      if (!this.makeRoom(rgba.byteLength, this.frame - 1)) return null;
      const gl = this.gl;
      const tex = gl.createTexture();
      if (!tex) return null;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(tex);
        return null;
      }
      this.bytes += rgba.length;
      this.map.set(cacheKey, {
        src: '', cacheKey, vectorResolution: 0, state: 'ready', tex, w, h,
        bytes: rgba.length, lastFrame: this.frame, screenPixels, bitmap: null
      });
      return tex;
    } catch {
      return null;
    }
  }

  /** Reuse a resident thumbnail while the new display level loads. */
  nearestPreview(src: string, resolution: number, screenPixels: number, sources?: ThumbnailLevels<string>): ImageEntry | undefined {
    const neighbors = resolution === 32 ? [64, 128] as const
      : resolution === 64 ? [32, 128] as const
      : resolution === 128 ? [64, 32] as const : [128, 64, 32] as const;
    for (const size of neighbors) {
      const preferred = this.map.get(this.cacheKey(sources?.[size] ?? src, -size));
      const entry = preferred?.state === 'ready' ? preferred : this.map.get(this.cacheKey(src, -size));
      if (entry?.state === 'ready') {
        this.touch(entry, screenPixels);
        return entry;
      }
    }
  }

  /** Draw the closest SVG bucket while the requested one loads. */
  nearestVector(src: string, resolution: number, screenPixels: number, maxResolution = 1024): ImageEntry | undefined {
    for (let step = 2; step <= 32; step *= 2) {
      const lower = this.map.get(this.cacheKey(src, resolution / step));
      const higher = resolution * step <= maxResolution ? this.map.get(this.cacheKey(src, resolution * step)) : undefined;
      const candidate = lower?.state === 'ready' ? lower : higher?.state === 'ready' ? higher : undefined;
      if (candidate) {
        this.touch(candidate, screenPixels);
        return candidate;
      }
    }
  }

  private pump(): void {
    // Drop requests that are no longer being asked for (scrolled away before starting).
    if (this.waiting.length > 0) {
      const keep: ImageEntry[] = [];
      for (const e of this.waiting) {
        if (e.lastFrame >= this.frame - 1) keep.push(e);
        else this.map.delete(e.cacheKey);
      }
      this.waiting = keep;
    }
    while (this.inflight + this.uploadQueue.length < this.maxConcurrent && this.waiting.length > 0) {
      const e = this.waiting.pop()!;
      this.inflight++;
      this.load(e).finally(() => {
        this.inflight--;
        if (!this.disposed) this.onReady();
      });
    }
  }

  private async load(e: ImageEntry): Promise<void> {
    const maxDim = Math.min(this.maxDim, e.previewResolution || this.maxDim);
    let bmp: ImageBitmap;
    try {
      bmp = e.vectorResolution ? await this.loadVector(e) : await this.loadPicture(e.src, maxDim);
    } catch {
      e.state = 'error';
      e.decodeFailed = true;
      return;
    }
    try {
      const m = Math.max(bmp.width, bmp.height);
      if (m > maxDim) {
        const k = maxDim / m;
        try {
          const small = await createImageBitmap(bmp, {
            resizeWidth: Math.max(1, Math.round(bmp.width * k)),
            resizeHeight: Math.max(1, Math.round(bmp.height * k)),
            resizeQuality: 'high',
            premultiplyAlpha: 'premultiply'
          });
          bmp.close();
          bmp = small;
        } catch (error) {
          bmp.close();
          throw error;
        }
      }
      if (this.disposed || this.map.get(e.cacheKey) !== e) {
        bmp.close();
        return;
      }
      e.bitmap = bmp;
      e.state = 'decoded';
      this.uploadQueue.push(e);
    } catch {
      e.state = 'error';
    }
  }

  private decodeInWorker(source: string | Blob, maxDimension = this.maxDim): Promise<ImageBitmap | null> {
    if (this.disposed || this.decoderUnavailable || typeof Worker === 'undefined') return Promise.resolve(null);
    try {
      if (!this.decoder) {
        const worker = new Worker(new URL('./bitmap.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<BitmapReply>) => {
          const finish = this.decoding.get(data.id);
          this.decoding.delete(data.id);
          if ('bitmap' in data) {
            if (finish) finish(data.bitmap);
            else data.bitmap.close();
          } else finish?.(null);
        };
        worker.onerror = () => this.stopDecoder();
        worker.onmessageerror = () => this.stopDecoder();
        this.decoder = worker;
      }
      const request: BitmapRequest = { id: ++this.decodingId, source, maxDimension };
      this.decoder.postMessage(request);
      return new Promise((resolve) => this.decoding.set(request.id, resolve));
    } catch {
      this.stopDecoder();
      return Promise.resolve(null);
    }
  }

  private stopDecoder(): void {
    this.decoderUnavailable = true;
    this.decoder?.terminate();
    this.decoder = null;
    for (const finish of this.decoding.values()) finish(null);
    this.decoding.clear();
  }

  private async loadPicture(src: string, maxDimension: number): Promise<ImageBitmap> {
    const decoded = await this.decodeInWorker(src, maxDimension);
    if (decoded) return decoded;
    if (this.disposed) throw new Error('Image cache disposed');
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error('http ' + res.status);
      return await createImageBitmap(await res.blob(), { premultiplyAlpha: 'premultiply' });
    } catch {
      return this.loadImageElement(src);
    }
  }

  private async loadImageElement(src: string): Promise<ImageBitmap> {
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    await image.decode();
    return createImageBitmap(image, { premultiplyAlpha: 'premultiply' });
  }

  private async loadVector(entry: ImageEntry): Promise<ImageBitmap> {
    const response = await fetch(entry.src);
    if (!response.ok) throw new Error(`Could not read SVG (${response.status}).`);
    const xml = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
    const svg = xml.documentElement;
    if (svg.localName !== 'svg' || svg.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('Invalid SVG.');
    const target = Math.min(this.maxDim, entry.vectorResolution);
    const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
    let width: number, height: number;
    if (viewBox) {
      [, , width, height] = viewBox;
      if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || width <= 0 || height <= 0) {
        throw new Error('Invalid SVG viewport.');
      }
    } else {
      // Local SVGs may have intrinsic pixel dimensions without a viewBox.
      // Preserve their coordinate system when rasterizing at a different size.
      const pixelLength = (name: string) => {
        const value = svg.getAttribute(name)?.trim() ?? '';
        return /^\d*\.?\d+(?:px)?$/i.test(value) ? Number.parseFloat(value) : 0;
      };
      width = pixelLength('width');
      height = pixelLength('height');
      if (!width || !height) return this.loadPicture(entry.src, target);
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    const ratio = target / Math.max(width, height);
    svg.setAttribute('width', String(Math.max(1, Math.round(width * ratio))));
    svg.setAttribute('height', String(Math.max(1, Math.round(height * ratio))));
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
    const decoded = await this.decodeInWorker(blob);
    if (decoded) return decoded;
    if (this.disposed) throw new Error('Image cache disposed');
    const url = URL.createObjectURL(blob);
    try {
      return await this.loadImageElement(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Upload decoded bitmaps within the time and residency budgets. */
  processUploads(deadline: number): boolean {
    this.pump();
    const gl = this.gl;
    const waiting: ImageEntry[] = [];
    let uploaded = false;
    for (let i = 0; i < this.uploadQueue.length; i++) {
      const e = this.uploadQueue[i];
      if (this.map.get(e.cacheKey) !== e) continue;
      if (e.lastFrame < this.frame) {
        this.release(e);
        continue;
      }
      if (performance.now() > deadline) {
        waiting.push(...this.uploadQueue.slice(i));
        this.uploadQueue = waiting;
        return true;
      }
      const bmp = e.bitmap!;
      if ((e.previewResolution || e.vectorResolution) && Math.max(bmp.width, bmp.height) <= 128 &&
          this.uploadPreview(e, bmp)) {
        bmp.close();
        e.bitmap = null;
        e.state = 'ready';
        uploaded = true;
        continue;
      }
      const bytes = mipBytes(bmp.width, bmp.height);
      if (bytes > this.budgetBytes) {
        bmp.close();
        e.bitmap = null;
        e.state = 'error';
        continue;
      }
      if (!this.makeRoom(bytes, this.frame)) {
        waiting.push(e);
        continue;
      }
      const tex = gl.createTexture();
      if (tex) {
        gl.bindTexture(gl.TEXTURE_2D, tex);
        // WebGL ignores UNPACK_PREMULTIPLY_ALPHA_WEBGL for ImageBitmap sources.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (gl.getError() === gl.NO_ERROR) {
          e.w = bmp.width;
          e.h = bmp.height;
          e.bytes = bytes;
          this.bytes += bytes;
          e.tex = tex;
          uploaded = true;
        } else gl.deleteTexture(tex);
      }
      bmp.close();
      e.bitmap = null;
      e.state = e.tex ? 'ready' : 'error';
    }
    this.uploadQueue = waiting;
    this.pump();
    return uploaded;
  }

  private uploadPreview(e: ImageEntry, bitmap: ImageBitmap): boolean {
    const side = this.pageSide;
    if (!side) return false;
    const tileSize = Math.max(bitmap.width, bitmap.height) <= 64 ? 64 : 128;
    const columns = side / tileSize;
    const gl = this.gl;
    let page = [...this.pages].find((candidate) => candidate.tileSize === tileSize && candidate.free.length > 0);
    if (!page) {
      // Reclaim a single old slot before allocating another full page.
      let oldest: ImageEntry | undefined;
      for (const candidate of this.pages) {
        if (candidate.tileSize !== tileSize) continue;
        for (const entry of candidate.slots) {
          if (entry && entry.lastFrame < this.frame &&
              (!oldest || entry.lastFrame < oldest.lastFrame ||
                (entry.lastFrame === oldest.lastFrame && entry.screenPixels < oldest.screenPixels))) oldest = entry;
        }
      }
      if (oldest && this.bytes + side * side * 4 > this.budgetBytes) {
        page = oldest.page!;
        this.release(oldest);
        if (!this.pages.has(page)) page = undefined;
      }
    }
    if (!page) {
      const bytes = side * side * 4;
      if (!this.makeRoom(bytes, this.frame)) return false;
      const texture = gl.createTexture();
      if (!texture) return false;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, side, side);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (gl.getError() !== gl.NO_ERROR) {
        gl.deleteTexture(texture);
        return false;
      }
      const capacity = columns * columns;
      page = { texture, tileSize, slots: new Array(capacity), free: Array.from({ length: capacity }, (_, i) => capacity - 1 - i) };
      this.pages.add(page);
      this.bytes += bytes;
    }
    const slot = page.free.pop()!;
    const x = (slot % columns) * tileSize;
    const y = Math.floor(slot / columns) * tileSize;
    gl.bindTexture(gl.TEXTURE_2D, page.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    if (gl.getError() !== gl.NO_ERROR) {
      page.free.push(slot);
      this.releaseEmptyPage(page);
      return false;
    }
    page.slots[slot] = e;
    e.page = page;
    e.slot = slot;
    e.tex = page.texture;
    e.w = bitmap.width;
    e.h = bitmap.height;
    e.uv = [x / side, y / side, (x + bitmap.width) / side, (y + bitmap.height) / side];
    return true;
  }

  private releaseEmptyPage(page: PreviewPage): void {
    if (page.free.length !== page.slots.length) return;
    this.gl.deleteTexture(page.texture);
    this.pages.delete(page);
    this.bytes -= this.pageSide * this.pageSide * 4;
  }

  evictFar(): void {
    for (const e of this.map.values()) {
      if (e.lastFrame >= this.frame || (e.tex && (!e.src || e.previewResolution || (e.vectorResolution > 0 && e.vectorResolution <= 128)))) continue;
      this.release(e);
    }
    this.waiting = this.waiting.filter((e) => this.map.has(e.cacheKey));
    this.uploadQueue = this.uploadQueue.filter((e) => this.map.has(e.cacheKey));
  }

  invalidateSource(src: string): void {
    for (const entry of this.map.values()) if (entry.src === src) this.release(entry);
    this.waiting = this.waiting.filter(entry => entry.src !== src);
    this.uploadQueue = this.uploadQueue.filter(entry => entry.src !== src);
  }

  private touch(e: ImageEntry, screenPixels: number): void {
    e.screenPixels = e.lastFrame === this.frame ? Math.max(e.screenPixels, screenPixels) : screenPixels;
    e.lastFrame = this.frame;
  }

  private makeRoom(bytes: number, protectedFrame: number): boolean {
    if (this.bytes + bytes <= this.budgetBytes) return true;
    const candidates: { entries: ImageEntry[]; bytes: number; lastFrame: number; screenPixels: number }[] = [];
    for (const e of this.map.values()) {
      if (e.tex && !e.page && e.lastFrame < protectedFrame) candidates.push({
        entries: [e], bytes: e.bytes, lastFrame: e.lastFrame, screenPixels: e.screenPixels
      });
    }
    for (const page of this.pages) {
      const entries = page.slots.filter((entry): entry is ImageEntry => !!entry);
      const lastFrame = Math.max(...entries.map((entry) => entry.lastFrame));
      if (lastFrame < protectedFrame) candidates.push({
        entries, bytes: this.pageSide * this.pageSide * 4, lastFrame,
        screenPixels: Math.max(...entries.map((entry) => entry.screenPixels))
      });
    }
    const reclaimable = candidates.reduce((total, e) => total + e.bytes, 0);
    if (this.bytes + bytes - reclaimable > this.budgetBytes) return false;
    candidates.sort((a, b) => a.lastFrame - b.lastFrame || a.screenPixels - b.screenPixels);
    for (const candidate of candidates) {
      for (const entry of candidate.entries) this.release(entry);
      if (this.bytes + bytes <= this.budgetBytes) return true;
    }
    return false;
  }

  private release(e: ImageEntry): void {
    if (e.page && e.slot !== undefined) {
      e.page.slots[e.slot] = undefined;
      e.page.free.push(e.slot);
      this.releaseEmptyPage(e.page);
    } else if (e.tex) this.gl.deleteTexture(e.tex);
    e.bitmap?.close();
    this.bytes -= e.bytes;
    this.map.delete(e.cacheKey);
  }

  dispose(): void {
    this.disposed = true;
    this.stopDecoder();
    for (const e of this.map.values()) {
      if (e.tex && !e.page) this.gl.deleteTexture(e.tex);
      e.bitmap?.close();
    }
    for (const page of this.pages) this.gl.deleteTexture(page.texture);
    this.pages.clear();
    this.map.clear();
    this.uploadQueue.length = 0;
    this.waiting.length = 0;
    this.bytes = 0;
  }
}

/** RGBA8 storage for every mip level, including non-square and odd dimensions. */
function mipBytes(width: number, height: number): number {
  let bytes = width * height * 4;
  while (width > 1 || height > 1) {
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
    bytes += width * height * 4;
  }
  return bytes;
}
