import { makeImagePreview, makeThumbnailLevels, type BrowserImagePreview } from './image-preview';
import { THUMBNAIL_LEVELS, type ThumbnailLevels } from '../core/image-levels';
/** Host for plain-browser development (`bun run dev`): localStorage documents, IndexedDB assets, offline AI replay. */
import { localData } from './local-data';
import { ReplayProvider } from './replay';
import { browserDirectoryReader, browserDirectoryWriter } from './portable-directory';
import type {
  AssetImageInfo,
  AssetMeta,
  Host,
  MenuId,
  PlatformInfo,
  PresenterCommand,
  PresenterState,
  RecoveredDoc,
  Unlisten
} from './types';

const DOC_PREFIX = 'radiant.doc:';
const TEXT_PREFIX = 'radiant.text:';
const AUTO_PREFIX = 'radiant.autosave:';
/** The presenter console and the document tab talk over this channel in a plain browser (PRS-40). */
const PRESENTER_CHANNEL = 'radiant-presenter';

type PresenterMessage = { type: 'state'; state: PresenterState } | { type: 'command'; command: PresenterCommand } | { type: 'close' };

function presenterChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(PRESENTER_CHANNEL) : null;
}

/** Post one message on a short-lived channel. Payloads are copied through JSON so reactive proxies never cross. */
function presenterPost(message: PresenterMessage): void {
  const channel = presenterChannel();
  if (!channel) return;
  channel.postMessage(JSON.parse(JSON.stringify(message)));
  channel.close();
}

function presenterListen(receive: (message: PresenterMessage) => void): Unlisten {
  const channel = presenterChannel();
  if (!channel) return () => {};
  channel.onmessage = (event: MessageEvent<PresenterMessage>) => receive(event.data);
  return () => channel.close();
}

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    throw new Error(`Could not store the document in the browser (${e instanceof Error ? e.message : String(e)})`);
  }
}
function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function lsKeys(prefix: string): string[] {
  try {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const d = await subtle.digest('SHA-256', bytes as unknown as BufferSource);
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Fallback (insecure contexts): FNV-1a repeated to 64 hex chars. Only for development.
  let h = 0x811c9dc5;
  let out = '';
  for (let r = 0; r < 8; r++) {
    for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0;
    h = Math.imul(h ^ r, 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export class MockHost extends ReplayProvider implements Host {
  readonly shell = 'browser' as const;
  private assets = new Map<string, string>();
  private imageInfo = new Map<string, AssetImageInfo>();
  private baselines = new Map<string, string>();

  constructor(textOnly = false) {
    super((bytes, mime) => this.assetPut(bytes, mime), undefined,
      textOnly ? { streaming: false, images: false, rateLimits: false } : undefined);
  }

  async docSave(path: string, docJson: string): Promise<void> {
    const expected = this.baselines.get(path);
    if (expected !== undefined && lsGet(DOC_PREFIX + path) !== expected) {
      throw new Error('The saved map changed outside Radiant. Use Save As to keep your edits in a separate map.');
    }
    lsSet(DOC_PREFIX + path, docJson);
    this.baselines.set(path, docJson);
    try {
      const id = (JSON.parse(docJson) as { id?: string }).id;
      if (id) lsRemove(AUTO_PREFIX + this.autosaveKey(id, path));
    } catch {
      /* not JSON: ignore */
    }
  }
  async docLoad(path: string, trackBase = false): Promise<string> {
    const v = lsGet(DOC_PREFIX + path);
    if (v === null) throw new Error(`The file ${path} does not exist (browser preview)`);
    if (trackBase) this.baselines.set(path, v);
    return v;
  }
  async docExists(path: string): Promise<boolean> {
    return lsGet(DOC_PREFIX + path) !== null;
  }
  async docCreate(path: string, docJson: string): Promise<void> {
    if (lsGet(DOC_PREFIX + path) !== null) throw new Error('Choose a new file name for the linked branch.');
    await this.docSave(path, docJson);
  }
  expectRecoveryRevision(path: string, revision: string): Promise<void> {
    this.baselines.set(path, revision);
    return Promise.resolve();
  }

  private autosaveKey(id: string, path: string | null): string {
    return path ? id + ':' + encodeURIComponent(path) : id;
  }
  async docAutosave(docId: string, docJson: string, path: string | null): Promise<void> {
    const recoveryKey = this.autosaveKey(docId, path);
    lsSet(AUTO_PREFIX + recoveryKey, JSON.stringify({
      docId, docJson, path, recoveryKey,
      baseRevision: path ? this.baselines.get(path) : undefined,
      savedAt: new Date().toISOString()
    }));
  }
  async docRecover(): Promise<RecoveredDoc[]> {
    const out: RecoveredDoc[] = [];
    for (const k of lsKeys(AUTO_PREFIX)) {
      try {
        const r = JSON.parse(lsGet(k) ?? '') as RecoveredDoc;
        const saved = r.path ? lsGet(DOC_PREFIX + r.path) : null;
        if (saved !== null && saved === r.docJson) {
          lsRemove(k);
          continue;
        }
        const conflict = r.path && saved !== r.baseRevision
          ? saved === null ? 'missing' : 'changed' : null;
        out.push({ ...r, recoveryKey: k.slice(AUTO_PREFIX.length), conflict });
      } catch {
        /* skip damaged entry */
      }
    }
    return out;
  }
  async docDiscardRecovery(docId: string, path: string | null = null): Promise<void> {
    lsRemove(AUTO_PREFIX + this.autosaveKey(docId, path));
  }

  async browseMapFolder() {
    const maps=lsKeys(DOC_PREFIX).map(key=>{
      const path=key.slice(DOC_PREFIX.length);
      let modified:number|null=null;
      try { modified=Date.parse(JSON.parse(lsGet(key) ?? '{}').modified) || null; } catch { /* damaged map */ }
      return {path,name:path.split(/[\\/]/).pop() ?? path,modified};
    }).sort((a,b)=>a.name.localeCompare(b.name));
    return {folder:'Browser maps',maps};
  }
  previewMapJson(path:string) { return this.docLoad(path); }
  async pickOpenPath(): Promise<string | null> {
    const names = lsKeys(DOC_PREFIX).map((k) => k.slice(DOC_PREFIX.length));
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') return names[0] ?? null;
    const r = window.prompt(`Open which map?\n${names.join('\n') || '(none saved yet)'}`, names[0] ?? '');
    return r && r.trim() ? r.trim() : null;
  }
  async pickSavePath(suggestedName: string): Promise<string | null> {
    const def = suggestedName.endsWith('.radiant') ? suggestedName : `${suggestedName}.radiant`;
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') return def;
    const r = window.prompt('Save map as', def);
    return r && r.trim() ? r.trim() : null;
  }

  async assetPut(bytes: Uint8Array, mime: string, _meta?: AssetMeta): Promise<string> {
    const hash = await sha256Hex(bytes);
    if (!this.assets.has(hash)) {
      const blob = new Blob([new Uint8Array(bytes)], {type:mime});
      await localData('images','readwrite',store => store.put(blob,hash));
      this.assets.set(hash, URL.createObjectURL(blob));
      await this.prepareImageInfo(hash, blob).catch(() => {});
    }
    return hash;
  }
  async assetUrl(hash: string): Promise<string> {
    const u = this.assets.get(hash);
    if (u) return u;
    const blob = await localData('images','readonly',store => store.get(hash));
    if (!(blob instanceof Blob)) throw new Error(`Asset ${hash} was not found`);
    const url = URL.createObjectURL(blob);
    this.assets.set(hash,url);
    return url;
  }

  private async prepareImageInfo(hash: string, blob: Blob): Promise<AssetImageInfo> {
    const key = 'preview:' + hash;
    let preview = await localData<BrowserImagePreview>('images', 'readonly', store => store.get(key));
    if (!preview && blob.type.startsWith('image/')) {
      preview = await makeImagePreview(blob);
      await localData('images', 'readwrite', store => store.put(preview, key));
    } else if (preview && !THUMBNAIL_LEVELS.every((level) => preview?.thumbnails?.[level])) {
      preview = { ...preview, thumbnails: await makeThumbnailLevels(preview.thumbnail) };
      await localData('images', 'readwrite', store => store.put(preview, key));
    }
    const url = await this.assetUrl(hash);
    const thumbnailUrls: ThumbnailLevels<string> = {};
    for (const level of THUMBNAIL_LEVELS) {
      const thumbnail = preview?.thumbnails?.[level];
      if (thumbnail) thumbnailUrls[level] = URL.createObjectURL(thumbnail);
    }
    const info: AssetImageInfo = {
      url, aspect: preview?.aspect, thumbHash: preview?.thumbHash,
      thumbnailUrl: preview ? URL.createObjectURL(preview.thumbnail) : undefined, thumbnailUrls,
      vector: blob.type === 'image/svg+xml'
    };
    // Concurrent callers may have prepared the same derivative while IndexedDB was reading.
    const cached = this.imageInfo.get(hash);
    if (cached) {
      if (info.thumbnailUrl) URL.revokeObjectURL(info.thumbnailUrl);
      for (const url of Object.values(thumbnailUrls)) URL.revokeObjectURL(url);
      return cached;
    }
    this.imageInfo.set(hash, info);
    return info;
  }

  async assetImageInfo(hash: string): Promise<AssetImageInfo> {
    const cached = this.imageInfo.get(hash);
    if (cached) return cached;
    const blob = await localData('images', 'readonly', store => store.get(hash));
    if (!(blob instanceof Blob)) throw new Error('Image asset not found.');
    return this.prepareImageInfo(hash, blob);
  }

  async onMenu(_cb: (id: MenuId) => void): Promise<Unlisten> {
    return () => {};
  }

  // Presenter console in a second tab or popup, linked by a BroadcastChannel (PRS-40).
  async openPresenter(): Promise<void> {
    const url = new URL(window.location.href);
    url.search = '?presenter=1';
    url.hash = '';
    window.open(url.href, 'radiant-presenter', 'popup,width=980,height=680');
  }

  async closePresenter(): Promise<void> {
    presenterPost({ type: 'close' });
  }

  async sendPresenterState(state: PresenterState): Promise<void> {
    presenterPost({ type: 'state', state });
  }

  async onPresenterCommand(handler: (command: PresenterCommand) => void): Promise<Unlisten> {
    return presenterListen((message) => { if (message.type === 'command') handler(message.command); });
  }

  async sendPresenterCommand(command: PresenterCommand): Promise<void> {
    presenterPost({ type: 'command', command });
  }

  async onPresenterState(handler: (state: PresenterState) => void): Promise<Unlisten> {
    return presenterListen((message) => {
      if (message.type === 'state') handler(message.state);
      else if (message.type === 'close') window.close();
    });
  }

  private imported = new Map<string, File>();

  async readBinaryFile(path: string): Promise<Uint8Array> {
    const file = this.imported.get(path);
    if (!file) throw new Error('Select the file to import again');
    return new Uint8Array(await file.arrayBuffer());
  }

  async readTextFile(path: string): Promise<string> {
    const mem = this.imported.get(path);
    if (mem) return mem.text();
    const v = lsGet(TEXT_PREFIX + path);
    if (v === null) throw new Error(`The file ${path} does not exist (browser preview)`);
    return v;
  }
  async writeTextFile(path: string, text: string): Promise<void> {
    lsSet(TEXT_PREFIX + path, text);
  }
  async exportFile(name: string, mime: string, bytes: Uint8Array): Promise<boolean> {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  }

  readonly exportPortableDirectory = browserDirectoryWriter();
  readPortableDirectory = browserDirectoryReader;

  pickImportPath(): Promise<string | null> {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') return resolve(null);
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.md,.markdown,.opml,.mm,.txt,.json,.canvas,.xmind,.mindnode,.zip';
      input.style.display = 'none';
      input.addEventListener('change', async () => {
        const f = input.files?.[0];
        input.remove();
        if (!f) return resolve(null);
        const path = `browser:${f.name}`;
        this.imported.set(path, f);
        resolve(path);
      });
      input.addEventListener('cancel', () => {
        input.remove();
        resolve(null);
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  async openNodeUrl(url: URL): Promise<void> {
    if (url.protocol === 'file:') throw new Error('Open local file links in the Radiant desktop app.');
    window.open(url.href, '_blank', 'noopener,noreferrer');
  }

  async platformInfo(): Promise<PlatformInfo> {
    return { os: 'browser', highRefreshEnabled: false, appVersion: 'dev' };
  }
}
