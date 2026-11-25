import { THUMBNAIL_LEVELS, type ThumbnailLevels } from '../core/image-levels';
import type { AiQueue, AiQueueJob } from '../core/ai/provider';
import type { DisplayInfo, PaletteItem, PresenterCommand, PresenterState } from './types';
import type { QuickCaptureDriver, QuickCaptureOwnerResult, QuickCaptureRequest } from './quick-capture';
import type { HistoryEntry } from '../core/model/editor';
import type { ReminderHost } from './reminders';
import {createAgentTransport} from './agent';
/** Host implementation for the Tauri desktop app. The only file (with index.ts) that imports @tauri-apps/*. */
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { availableMonitors, currentMonitor, getCurrentWindow, primaryMonitor, type Monitor } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { open, save } from '@tauri-apps/plugin-dialog';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { PortableFiles } from '../core/io/portable';
import type {
  AiEvent,
  AiStatus,
  AiTurnRequest,
  AssetImageInfo,
  AssetMeta,
  DesktopQuitDecision,
  DiagnosticEntry,
  DiagnosticEvent,
  Host,
  MenuId,
  MapLinkNavigation,
  MapLinkResult,
  PlatformInfo,
  RecoveredDoc,
  Unlisten
} from './types';

const FILTERS = [{ name: 'Radiant map', extensions: ['radiant'] }];
// A portable bundle is "name.radiant.zip": the dialog sees its extension as "zip".
const OPEN_FILTERS = [{ name: 'Radiant map or portable bundle', extensions: ['radiant', 'zip'] }];

/** A display's id: its name and physical origin, stable while it stays connected. */
const displayId = (monitor: Monitor) => `${monitor.name ?? 'Display'}@${monitor.position.x},${monitor.position.y}`;

function bytesToBase64(bytes: Uint8Array): string {
  // Chunked String.fromCharCode keeps the call stack small and is much faster than per-byte concatenation.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export class TauriHost implements Host {
  readonly shell = 'desktop' as const;
  isWindowFullscreen(): Promise<boolean> {
    return getCurrentWindow().isFullscreen();
  }

  setWindowFullscreen(fullscreen: boolean): Promise<void> {
    return getCurrentWindow().setFullscreen(fullscreen);
  }

  // ------------------------------------------------------------ presenter screen (PRS-40 to 42)
  async listDisplays(): Promise<DisplayInfo[]> {
    const [all, current, primary] = await Promise.all([
      availableMonitors(), currentMonitor().catch(() => null), primaryMonitor().catch(() => null)
    ]);
    return all.map((monitor) => ({
      id: displayId(monitor),
      name: monitor.name ?? 'Display',
      width: Math.round(monitor.size.width / monitor.scaleFactor),
      height: Math.round(monitor.size.height / monitor.scaleFactor),
      scale: monitor.scaleFactor,
      primary: !!primary && displayId(primary) === displayId(monitor),
      current: !!current && displayId(current) === displayId(monitor)
    }));
  }

  async setFullscreenOnDisplay(display: string | null): Promise<void> {
    const window = getCurrentWindow();
    if (display === null) return window.setFullscreen(false);
    const monitor = (await availableMonitors()).find((m) => displayId(m) === display);
    if (!monitor) throw new Error('That display is no longer connected.');
    await window.setFullscreenOnMonitor(monitor.position);
  }

  setContentProtected(on: boolean): Promise<void> {
    return getCurrentWindow().setContentProtected(on);
  }

  openPresenter(): Promise<void> {
    return invoke('presenter_open');
  }

  closePresenter(): Promise<void> {
    return invoke('presenter_close');
  }

  sendPresenterState(state: PresenterState): Promise<void> {
    return invoke('presenter_publish', { state });
  }

  onPresenterCommand(handler: (command: PresenterCommand) => void): Promise<Unlisten> {
    return getCurrentWindow().listen<PresenterCommand>('presenter-command', ({ payload }) => handler(payload));
  }

  sendPresenterCommand(command: PresenterCommand): Promise<void> {
    return invoke('presenter_command', { command });
  }

  onPresenterState(handler: (state: PresenterState) => void): Promise<Unlisten> {
    return getCurrentWindow().listen<PresenterState>('presenter-state', ({ payload }) => handler(payload));
  }

  readonly reminders: ReminderHost | undefined = navigator.platform.startsWith('Mac') ? {
    links: map => invoke('reminders_links', { map }),
    connect: (map, node, title, done) => invoke('reminders_connect', { map, node, title, done }),
    disconnect: (map, node) => invoke('reminders_disconnect', { map, node }),
    sync: (map, tasks) => invoke('reminders_sync', { map, tasks }),
    acknowledge: (map, tasks) => invoke('reminders_ack', { map, tasks })
  } : undefined;
  readonly quickCapture: QuickCaptureDriver = {
    recent: () => invoke('capture_recent'),
    async choose() {
      const path = await open({ multiple: false, directory: false, filters: [{ name: 'Radiant map', extensions: ['radiant'] }] });
      return typeof path === 'string' ? path : null;
    },
    save: (path, id, text) => invoke('capture_submit', { path, id, text }),
    close: () => getCurrentWindow().close()
  };

  onQuickCapture(handler: (request: QuickCaptureRequest) => Promise<QuickCaptureOwnerResult>) {
    return getCurrentWindow().listen<QuickCaptureRequest>('quick-capture-request', async ({ payload }) => {
      let result: QuickCaptureOwnerResult;
      try {
        result = await handler(payload);
      } catch (error) {
        result = { kind: 'rejected', message: error instanceof Error ? error.message : String(error) };
      }
      await invoke('capture_complete', { id: payload.id, result }).catch(() => {});
    });
  }

  async quickCaptureHistory(path: string, snapshot: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
    const revision = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    const undo = await invoke<HistoryEntry[]>('capture_history', { path, revision });
    return undo.length ? { version: 1 as const, undo, redo: [] } : undefined;
  }

  readonly agentAccess = createAgentTransport(invoke, (event, handler) => getCurrentWindow().listen(event, ({ payload }) => handler(payload as never)));
  aiStatus(refreshLimits = false): Promise<AiStatus> {
    return invoke<AiStatus>('ai_status', { refreshLimits });
  }
  aiStartTurn(req: AiTurnRequest): Promise<string> {
    return invoke<string>('ai_start_turn', { req });
  }
  aiResolveMapRound(jobId: string, prompt?: string): Promise<void> {
    return invoke<void>('ai_resolve_map_round', { jobId, prompt: prompt ?? null });
  }
  aiCancel(jobId: string): Promise<void> {
    return invoke<void>('ai_cancel', { jobId });
  }
  async onAiEvent(cb: (e: AiEvent) => void): Promise<Unlisten> {
    return getCurrentWindow().listen<AiEvent>('ai-event', (ev) => cb(ev.payload));
  }

  async onAiQueue(cb: (queue: AiQueue) => void): Promise<Unlisten> {
    type NativeQueue = Omit<AiQueue, 'jobs'> & { jobs: (Omit<AiQueueJob, 'owned'> & { owner: string | null })[] };
    const window = getCurrentWindow();
    let revision = -1;
    const receive = (queue: NativeQueue) => {
      if (queue.revision <= revision) return;
      revision = queue.revision;
      cb({ ...queue, jobs: queue.jobs.map(({ owner, ...job }) => ({ ...job, owned: owner === window.label })) });
    };
    const off = await window.listen<NativeQueue>('ai-queue', ({ payload }) => receive(payload));
    try {
      receive(await invoke<NativeQueue>('ai_queue'));
      return off;
    } catch (error) {
      off();
      throw error;
    }
  }

  docSave(path: string, docJson: string): Promise<string> {
    return invoke<string>('doc_save', { path, docJson });
  }
  docOpen(path: string) { return invoke<{ path: string; json: string; migrated: boolean; originalJson?: string; unavailableAssets?: string[] }>('doc_open', { path }); }
  docLoad(path: string, trackBase = false): Promise<string> {
    return invoke<string>('doc_load', { path, trackBase });
  }
  expectRecoveryRevision(path: string, revision: string): Promise<void> {
    return invoke('expect_recovery_revision', { path, revision });
  }
  docExists(path: string): Promise<boolean> {
    return invoke<boolean>('doc_exists', { path });
  }
  docCreate(path: string, docJson: string): Promise<void> {
    return invoke('doc_create', { path, docJson });
  }
  docAutosave(docId: string, docJson: string, path: string | null): Promise<void> {
    return invoke<void>('doc_autosave', { docId, docJson, path });
  }
  docCommit(docId: string, docJson: string, path: string | null, operationJson: string): Promise<boolean> {
    return invoke('doc_commit', { docId, docJson, path, operationJson });
  }
  docRecover(): Promise<RecoveredDoc[]> {
    return invoke<RecoveredDoc[]>('doc_recover');
  }
  docDiscardRecovery(docId: string, path?: string | null): Promise<void> {
    return invoke<void>('doc_discard_recovery', { docId, path: path ?? null });
  }

  async browseMapFolder() {
    const folder=await open({directory:true,multiple:false,title:'Browse map folder'});
    if(typeof folder!=='string') return null;
    const maps=await invoke<import('./types').FolderMap[]>('list_map_folder',{folder});
    return {folder,maps};
  }
  previewMapJson(path:string):Promise<string> {
    return invoke('preview_map_json',{path});
  }
  async pickOpenPath(bundles = false): Promise<string | null> {
    const r = await open({ multiple: false, directory: false, filters: bundles ? OPEN_FILTERS : FILTERS });
    return typeof r === 'string' ? r : null;
  }
  async pickSavePath(suggestedName: string): Promise<string | null> {
    const name = suggestedName.endsWith('.radiant') ? suggestedName : `${suggestedName}.radiant`;
    const r = await save({ defaultPath: name, filters: FILTERS });
    if (!r) return null;
    return r.endsWith('.radiant') ? r : `${r}.radiant`;
  }

  async assetImageInfo(hash: string): Promise<AssetImageInfo> {
    const info = await invoke<{
      path: string; thumbnail: string | null; thumbnails?: ThumbnailLevels<string>; thumbHash: string | null; width: number | null; height: number | null; mime: string;
    }>('asset_image_info', { hash });
    const thumbnailUrls: ThumbnailLevels<string> = {};
    for (const level of THUMBNAIL_LEVELS) {
      const path = info.thumbnails?.[level];
      if (path) thumbnailUrls[level] = convertFileSrc(path);
    }
    return {
      url: convertFileSrc(info.path),
      aspect: info.width && info.height ? info.width / info.height : undefined,
      thumbnailUrl: info.thumbnail ? convertFileSrc(info.thumbnail) : undefined,
      thumbnailUrls,
      thumbHash: info.thumbHash ?? undefined,
      vector: info.mime === 'image/svg+xml'
    };
  }

  assetRecord(hash: string, meta: AssetMeta): Promise<void> {
    return invoke('asset_record', { hash, meta });
  }

  assetPut(bytes: Uint8Array, mime: string, meta?: AssetMeta): Promise<string> {
    return invoke<string>('asset_put', { bytesBase64: bytesToBase64(bytes), mime, meta: meta ?? null });
  }
  async assetForegroundMask(hash: string, width: number, height: number): Promise<Uint8Array> {
    return new Uint8Array(await invoke<ArrayBuffer>('asset_foreground_mask', { hash, width, height }));
  }
  async assetUrl(hash: string): Promise<string> {
    return convertFileSrc(await invoke<string>('asset_path', { hash }));
  }

  async onCloseRequest(allow: () => Promise<boolean>): Promise<Unlisten> {
    let closing = false;
    return getCurrentWindow().onCloseRequested(async event => {
      if (closing) { event.preventDefault(); return; }
      closing = true;
      try { if (!(await allow())) event.preventDefault(); }
      catch { event.preventDefault(); }
      finally { closing = false; }
    });
  }
  async onOpenFile(openFile: (path: string) => Promise<void>): Promise<Unlisten> {
    let pending = Promise.resolve();
    const drain = () => {
      pending = pending.then(async () => {
        const paths = await invoke<string[]>('take_open_files');
        for (const path of paths) await openFile(path);
      }).catch(error => console.error('Could not receive document open request',error));
    };
    drain();
    return () => {};
  }
  async onMenu(cb: (id: MenuId) => void): Promise<Unlisten> {
    return getCurrentWindow().listen<MenuId>('menu', (ev) => cb(ev.payload));
  }

  paletteItems(): Promise<PaletteItem[]> {
    return invoke('palette_items');
  }

  runPaletteItem(id: string): Promise<void> {
    return invoke('run_palette_item', { id });
  }

  setMenuKeys(bindings: Record<string, string>): Promise<void> {
    return invoke('set_menu_keys', { bindings });
  }

  openNodeUrl(url: URL): Promise<void> {
    return url.protocol === 'file:' ? invoke('open_node_file', { url: url.href }) : openUrl(url.href);
  }

  openDocumentWindow(path?: string): Promise<void> {
    return invoke('open_document_window', { path: path ?? null });
  }
  routeOpenMapLink({ path, node, origin }: MapLinkNavigation): Promise<MapLinkResult | 'local' | 'closed'> {
    return invoke('route_open_map_link', { path, node: node ?? null, origin: origin ?? null });
  }
  onMapLink(handle: (navigation: MapLinkNavigation) => MapLinkResult): Promise<Unlisten> {
    return getCurrentWindow().listen<MapLinkNavigation & { id: string }>('map-link-navigation', async ({ payload }) => {
      let result: MapLinkResult = 'unavailable';
      try { result = handle(payload); }
      finally { await invoke('finish_map_link', { id: payload.id, result }); }
    });
  }
  claimDocumentPath(path: string): Promise<string> {
    return invoke('claim_document_path', { path });
  }
  releaseDocumentPath(path: string): Promise<void> {
    return invoke('release_document_path', { path });
  }
  noteDocument(path: string): Promise<void> {
    return invoke('note_document', { path });
  }
  desktopSession(): Promise<string[]> {
    return invoke('offer_desktop_session');
  }
  finishDesktopSession(reopen: boolean): Promise<void> {
    return invoke('finish_desktop_session', { reopen });
  }
  isRecoveryWindow(): boolean {
    return getCurrentWindow().label === 'main';
  }
  async onQuitRequest(allow: () => Promise<DesktopQuitDecision>, cancelled: () => void): Promise<Unlisten> {
    const current = getCurrentWindow();
    const stopCancelled = await current.listen('desktop-quit-cancelled', cancelled);
    const stopCheck = await current.listen<string>('desktop-quit-check', async ({ payload: requestId }) => {
      let decision: DesktopQuitDecision = { approved: false };
      try { decision = await allow(); } catch { /* Keep this window open. */ }
      const accepted = await invoke<boolean>('respond_desktop_quit', { requestId, approved: decision.approved, discard: decision.discard ?? null })
        .catch(() => false);
      if (!accepted) cancelled();
    });
    return () => { stopCheck(); stopCancelled(); };
  }
  setWindowTitle(title: string): Promise<void> {
    return getCurrentWindow().setTitle(title);
  }

  async readBinaryFile(path: string): Promise<Uint8Array> {
    const encoded = await invoke<string>('binary_read', {path});
    return Uint8Array.from(atob(encoded), ch => ch.charCodeAt(0));
  }
  readonly rasterizeImportedPdf = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
    ? async (bytes: Uint8Array, tint?: string) => {
        const encoded = await invoke<string>('rasterize_imported_pdf', { bytesBase64: bytesToBase64(bytes), tint });
        return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      }
    : undefined;
  readTextFile(path: string): Promise<string> {
    return invoke<string>('text_read', { path });
  }
  writeTextFile(path: string, text: string): Promise<void> {
    return invoke<void>('text_write', { path, text });
  }
  async onFileDrop(handler: (paths: string[], position: { x: number; y: number }) => void): Promise<Unlisten> {
    const window = getCurrentWindow();
    return window.onDragDropEvent(({ payload }) => {
      if (payload.type !== 'drop') return;
      void window.scaleFactor().then((scale) => {
        handler(payload.paths, { x: payload.position.x / scale, y: payload.position.y / scale });
      }).catch(() => {});
    });
  }

  readonly writeVectorClipboard = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
    ? (svg: Uint8Array) => invoke<void>('write_vector_clipboard', { svgBase64: bytesToBase64(svg) })
    : undefined;

  readonly writeImageClipboard = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
    ? (png: Uint8Array, svg: Uint8Array) => invoke<void>('write_image_clipboard', {
        pngBase64: bytesToBase64(png), svgBase64: bytesToBase64(svg)
      })
    : undefined;

  prepareDragFile(name: string, bytes: Uint8Array): Promise<string> {
    return invoke<string>('prepare_drag_file', { name, bytesBase64: bytesToBase64(bytes) });
  }

  startDragFile(token: string): Promise<void> {
    return invoke<void>('start_drag_file', { token });
  }

  openPdfForPrint(name: string, bytes: Uint8Array): Promise<void> {
    return invoke<void>('open_pdf_for_print', { name, bytesBase64: bytesToBase64(bytes) });
  }

  async exportFile(name: string, _mime: string, bytes: Uint8Array): Promise<boolean> {
    const extension = name.split('.').pop() ?? '';
    const path = await save({ defaultPath: name, filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
    if (!path) return false;
    await invoke('export_write', { path, bytesBase64: bytesToBase64(bytes) });
    return true;
  }

  async exportPortableDirectory(name: string, prepare: () => Promise<PortableFiles>): Promise<boolean> {
    const parent = await open({ title: 'Choose where to save the portable map folder', directory: true, multiple: false });
    if (typeof parent !== 'string') return false;
    const files = Object.entries(await prepare()).map(([name, bytes]) => ({ name, data: bytesToBase64(bytes) }));
    await invoke('bundle_write_directory', { parent, name, files });
    return true;
  }

  async readPortableDirectory(): Promise<PortableFiles | null> {
    const path = await open({ title: 'Open a portable map folder', directory: true, multiple: false });
    if (typeof path !== 'string') return null;
    const files = await invoke<{ name: string; data: string }[]>('bundle_read_directory', { path });
    return Object.fromEntries(files.map(({ name, data }) => [name, Uint8Array.from(atob(data), (char) => char.charCodeAt(0))]));
  }

  async pickImportPath(): Promise<string | null> {
    const r = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Outline', extensions: ['md', 'markdown', 'opml', 'mm', 'txt', 'json', 'canvas', 'xmind', 'mindnode', 'zip'] }]
    });
    return typeof r === 'string' ? r : null;
  }

  async checkUpdate() {
    const {check} = await import('@tauri-apps/plugin-updater');
    const update = await check({timeout:15000});
    if (!update) return null;
    return {
      version:update.version,
      install:()=>update.downloadAndInstall(),
      close:()=>update.close()
    };
  }
  async reviewNotificationPermission(request: boolean): Promise<boolean> {
    if ((await this.platformInfo()).os !== 'macos') return false;
    if (await isPermissionGranted()) return true;
    return request && await requestPermission() === 'granted';
  }

  async notifyReview(count: number): Promise<void> {
    sendNotification({
      title: 'Radiant reviews due',
      body: count + (count === 1 ? ' map or branch is' : ' maps or branches are') + ' ready for recall.'
    });
  }

  diagnosticRecord(event: DiagnosticEvent): Promise<void> {
    return invoke('diagnostic_record', { event });
  }
  diagnosticRecent(): Promise<DiagnosticEntry[]> {
    return invoke('diagnostic_recent');
  }

  platformInfo(): Promise<PlatformInfo> {
    return invoke<PlatformInfo>('platform_info');
  }
}
