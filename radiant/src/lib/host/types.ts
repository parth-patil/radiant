/**
 * Contract between the front end and the Rust host (decision D-01: the front end must not depend on Tauri
 * directly; only src/lib/host/tauri.ts imports @tauri-apps/*). Only the coordinator edits this file.
 *
 * Rust commands (snake_case in Rust, called with camelCase args from JS):
 *   ai_status() -> AiStatus
 *   ai_start_turn(req: AiTurnRequest) -> string (job id)
 *   ai_cancel(jobId: string) -> ()
 *   doc_save(path: string, docJson: string) -> ()
 *   doc_load(path: string) -> string (doc JSON)
 *   doc_autosave(docId: string, docJson: string, path: string | null) -> ()
 *   doc_recover() -> RecoveredDoc[]
 *   doc_discard_recovery(docId: string) -> ()
 *   asset_put(bytesBase64: string, mime: string, meta: AssetMeta | null) -> string (content hash)
 *   asset_path(hash: string) -> string (absolute file path, for convertFileSrc)
 *   platform_info() -> PlatformInfo
 *   text_read(path: string) -> string
 *   text_write(path: string, text: string) -> ()
 *   state_load(origin: string) -> AppStateLoad
 *   state_set(entries: SettingEntry[]) -> ()   (one transaction; then "state-changed" to every other window)
 *   state_snapshot_list(docId: string) -> SnapshotInfo[] (newest first; metadata only, no map JSON)
 *   state_snapshot_get(id: string) -> StoredSnapshot | null (with its map JSON)
 *   state_snapshot_put(row: StoredSnapshot, keepAutomatic: number | null) -> ()   (an automatic row with keepAutomatic
 *     1..100 also deletes that document's automatic snapshots beyond the newest keepAutomatic, in one transaction)
 *   state_snapshot_delete(id: string) -> ()
 *   state_import(origin: string, settings: Record<string, string>, snapshots: StoredSnapshot[]) -> AppStateImported
 *   state_import_done(origin: string) -> ()
 * Rust events:
 *   "ai-event" with payload AiEvent
 *   "menu" with payload MenuId (native menu item chosen)
 *   "state-changed" with payload SettingEntry[] (settings another window wrote)
 */

import type { ThumbnailLevels } from '../core/image-levels';
import type { AiProvider } from '../core/ai/provider';
import type { AssetMeta } from '../core/asset-meta';
export type * from '../core/ai/provider';
export type { AssetMeta } from '../core/asset-meta';

export interface RecoveredDoc {
  baseRevision?: string | null;
  conflict?: 'changed' | 'missing' | 'unreadable' | 'older-format' | null;
  recoveryKey?: string;
  docId: string;
  path: string | null;
  docJson: string;
  savedAt: string;
}

export interface DesktopQuitDecision {
  approved: boolean;
  discard?: { docId: string; path: string | null };
}

export type DiagnosticEvent =
  | 'started' | 'ui_error' | 'window_error' | 'unhandled_rejection' | 'layout_worker_fallback' | 'webkit_refresh_fallback' | 'update_failed' | 'artwork_unavailable' | 'settings_unavailable'
  | 'codex_not_installed' | 'codex_not_logged_in' | 'codex_rate_limit'
  | 'codex_protocol' | 'codex_timeout' | 'codex_interrupted' | 'codex_error';

export interface DiagnosticEntry {
  timeMs: number;
  level: 'info' | 'warning' | 'error';
  event: DiagnosticEvent;
}

export interface PlatformInfo {
  displayHz?: number | null;
  os: string;
  /** True if the 120 Hz WebKit setting was applied successfully at window creation. */
  highRefreshEnabled: boolean;
  /** Whether this desktop build includes the guarded WebKit feature switch. */
  highRefreshBuild?: boolean;
  updateChannel?: boolean;
  appVersion: string;
}

export interface FolderMap { path:string; name:string; modified:number|null }

export interface PaletteItem {
  id: string;
  label: string;
  group: string;
  hint?: string;
  shortcut: string;
  native: boolean;
}

export type MenuId =
  | 'node-menu' | 'browse-maps' | 'export' | 'cancel-generation' | 'next-pane' | 'previous-pane'
  | 'new' | 'open' | 'save' | 'save-as' | 'print' | 'import-markdown' | 'import-folder' | 'extract-branch' | 'copy-map-link' | 'back-map-link' | 'copy-markdown'
  | 'undo' | 'redo' | 'find' | 'commands' | 'edit-link' | 'edit-note'
  | 'add-sibling' | 'sibling-before' | 'sibling-above' | 'new-main' | 'outdent' | 'delete' | 'delete-forward' | 'promote' | 'promote-forward' | 'edit-label' | 'edit-label-alt' | 'select-all' | 'move-up' | 'move-down' | 'art-visibility' | 'nav-up' | 'nav-down' | 'nav-left' | 'nav-right'
  | 'find-replace' | 'map-view' | 'outline-view'
  | 'zoom-actual' | 'zoom-plus' | 'move-left' | 'move-right' | 'sort-tasks'
  | 'detach' | 'fold-alt' | 'fold-siblings' | 'unfold-one' | 'unfold-all' | 'fold-level'
  | 'add-child' | 'connect' | 'task' | 'add-parent' | 'duplicate' | 'create-alias' | 'select-subtree' | 'select-siblings' | 'reset-offset' | 'reset-branch-offsets' | 'reset-map-offsets' | 'sort-children'
  | 'generate' | 'expand' | 'collapse-toggle' | 'next-layout' | 'next-theme' | 'balance' | 'new-variation'
  | 'zoom-in' | 'zoom-out' | 'zoom-fit' | 'zoom-selection' | 'centre-selection' | 'select-level' | 'pin-position' | 'tidy-layout' | 'tidy-map' | 'arrange'
  | 'toggle-outline' | 'toggle-inspector' | 'toggle-stats'
  | 'toggle-minimap' | 'focus-branch' | 'present-branches' | 'present-from-here' | 'presentations' | 'filter-map';

export type Unlisten = () => void;

export interface AssetImageInfo {
  url: string;
  aspect?: number;
  thumbnailUrl?: string;
  thumbnailUrls?: ThumbnailLevels<string>;
  thumbHash?: string;
  vector?: boolean;
}

export interface MapLinkOrigin {
  path: string;
  node: string | null;
  title: string;
}

export type MapLinkResult = 'opened' | 'missingNode' | 'unavailable';
export interface MapLinkNavigation {
  path: string;
  node?: string | null;
  origin?: MapLinkOrigin | null;
}

/** A display the audience window can fill (PRS-42). `id` is stable while the display stays connected. */
export interface DisplayInfo {
  id: string;
  name: string;
  /** Logical size in points. */
  width: number;
  height: number;
  scale: number;
  primary: boolean;
  /** The display the asking window is on. */
  current: boolean;
}

/** One playable step as the presenter console lists it. */
export interface PresenterStepInfo {
  id: string;
  /** 1-based position among the playable steps. */
  number: number;
  title: string;
  seconds?: number;
}

/**
 * What the document window tells the presenter console (PRS-40, 41). Sent only when the step or the talk changes,
 * never per frame. Notes travel only to the console, never to the audience view.
 */
export interface PresenterState {
  active: boolean;
  docId: string;
  docTitle: string;
  presentationId: string;
  presentation: string;
  steps: PresenterStepInfo[];
  /** 1-based number of the step on screen; 0 when not presenting. */
  current: number;
  title?: string;
  note?: string;
  caption?: string;
  nextTitle?: string;
  special?: 'overview' | 'captured' | 'detour';
  /** The step still reveals nodes one per press before Next moves on. */
  building?: boolean;
  blank?: boolean;
  targetMinutes?: number;
  /** Epoch ms when the talk started. */
  startedAt?: number;
}

/** What the presenter console asks of the document window. 'hello' asks for the state; 'closed' comes from the host. */
export type PresenterCommand =
  | { kind: 'hello' } | { kind: 'closed' }
  | { kind: 'next' } | { kind: 'previous' } | { kind: 'first' } | { kind: 'last' }
  | { kind: 'jump'; step: number }
  | { kind: 'blank' }
  | { kind: 'start' } | { kind: 'end' }
  | { kind: 'fullscreen'; display: string | null };

/** A setting write: a value, or null to delete the key. Keys start with "radiant." or "radiant:". */
export type SettingEntry = [key: string, value: string | null];

/** A History snapshot without its map JSON, as lists return it. */
export interface SnapshotInfo {
  id: string;
  docId: string;
  name: string;
  /** Epoch ms. */
  at: number;
  automatic: boolean;
  change?: import('../core/model/editor').ChangeSummary;
}

/** One History snapshot with its map JSON (the rows of the former IndexedDB "snapshots" store). */
export interface StoredSnapshot extends SnapshotInfo {
  json: string;
}

export interface AppStateLoad {
  settings: Record<string, string>;
  /** Whether this WebView origin's old localStorage and IndexedDB data has already been imported. */
  imported: boolean;
}

export interface AppStateImported { settings: number; snapshots: number }

/**
 * Settings and History snapshots. The desktop keeps them in the host's state.sqlite; the browser preview keeps
 * them in localStorage and IndexedDB as before.
 */
export interface AppStateHost {
  load(origin: string): Promise<AppStateLoad>;
  set(entries: SettingEntry[]): Promise<void>;
  /** Settings written by another window. */
  onChanged(handler: (entries: SettingEntry[]) => void): Promise<Unlisten>;
  /** Newest first, without map JSON; fetch one with snapshotGet when its JSON is needed. */
  snapshotList(docId: string): Promise<SnapshotInfo[]>;
  snapshotGet(id: string): Promise<StoredSnapshot | null>;
  /** For an automatic row, keepAutomatic (1..100) prunes that document's older automatic snapshots in the same write. */
  snapshotPut(row: StoredSnapshot, keepAutomatic?: number): Promise<void>;
  snapshotDelete(id: string): Promise<void>;
  /** Insert-if-missing import of WebView data; callable several times with batches. */
  importBatch(origin: string, settings: Record<string, string>, snapshots: StoredSnapshot[]): Promise<AppStateImported>;
  /** Mark this origin's import complete. */
  importDone(origin: string): Promise<void>;
}

export interface Host extends AiProvider {
  readonly appState: AppStateHost;
  readonly shell: 'desktop' | 'browser';
  isWindowFullscreen?(): Promise<boolean>;
  setWindowFullscreen?(fullscreen: boolean): Promise<void>;
  /** Presenter screen (PRS-40 to 42). Displays connected to the computer. */
  listDisplays?(): Promise<DisplayInfo[]>;
  /** Fill the given display with this window; null leaves full screen. */
  setFullscreenOnDisplay?(display: string | null): Promise<void>;
  /** Hide this window from screen capture and sharing. */
  setContentProtected?(on: boolean): Promise<void>;
  /** Open (or bring forward) the presenter console for this document window. */
  openPresenter?(): Promise<void>;
  closePresenter?(): Promise<void>;
  /** Document window: send the talk's state to the console. */
  sendPresenterState?(state: PresenterState): Promise<void>;
  /** Document window: commands from the console. */
  onPresenterCommand?(handler: (command: PresenterCommand) => void): Promise<Unlisten>;
  /** Console: send a command to the document window that opened it. */
  sendPresenterCommand?(command: PresenterCommand): Promise<void>;
  /** Console: state updates from the document window. */
  onPresenterState?(handler: (state: PresenterState) => void): Promise<Unlisten>;
  reminders?: import('./reminders').ReminderHost;
  quickCapture?: import('./quick-capture').QuickCaptureDriver;
  onQuickCapture?(handler: (request: import('./quick-capture').QuickCaptureRequest) => Promise<import('./quick-capture').QuickCaptureOwnerResult>): Promise<Unlisten>;
  quickCaptureHistory?(path: string, snapshot: string): Promise<import('../core/model/editor').EditorHistory | undefined>;
  agentAccess?: import('./agent').AgentTransport;
  docSave(path: string, docJson: string): Promise<string | void>;
  docLoad(path: string, trackBase?: boolean): Promise<string>;
  docOpen?(path: string): Promise<{ path: string; json: string; migrated: boolean; originalJson?: string; unavailableAssets?: string[] }>;
  expectRecoveryRevision?(path: string, revision: string): Promise<void>;
  docExists(path: string): Promise<boolean>;
  docCreate(path: string, docJson: string): Promise<void>;
  docAutosave(docId: string, docJson: string, path: string | null): Promise<void>;
  /** True when SQLite committed the edit in the document; false when saved to local recovery. */
  docCommit?(docId: string, docJson: string, path: string | null, operationJson: string): Promise<boolean>;
  docRecover(): Promise<RecoveredDoc[]>;
  docDiscardRecovery(docId: string, path?: string | null): Promise<void>;

  /** Shows a native dialog; null if cancelled. */
  browseMapFolder(): Promise<{folder:string; maps:FolderMap[]} | null>;
  previewMapJson(path:string): Promise<string>;
  pickOpenPath(bundles?: boolean): Promise<string | null>;
  pickSavePath(suggestedName: string): Promise<string | null>;

  assetForegroundMask?(hash: string, width: number, height: number): Promise<Uint8Array>;
  assetImageInfo?(hash: string): Promise<AssetImageInfo>;
  assetRecord?(hash: string, meta: AssetMeta): Promise<void>;
  assetPut(bytes: Uint8Array, mime: string, meta?: AssetMeta): Promise<string>;
  /** A URL the WebView can load for the asset. */
  assetUrl(hash: string): Promise<string>;

  checkUpdate?(): Promise<{version:string;install:()=>Promise<void>;close:()=>Promise<void>} | null>;
  platformInfo(): Promise<PlatformInfo>;
  diagnosticRecord?(event: DiagnosticEvent): Promise<void>;
  diagnosticRecent?(): Promise<DiagnosticEntry[]>;
  reviewNotificationPermission?(request: boolean): Promise<boolean>;
  notifyReview?(count: number): Promise<void>;

  /** Native menu commands. In a plain browser (MockHost) this never fires; the UI's own shortcuts cover it. */
  onFileDrop?(handler: (paths: string[], position: { x: number; y: number }) => void): Promise<Unlisten>;
  writeVectorClipboard?: (svg: Uint8Array) => Promise<void>;
  writeImageClipboard?: (png: Uint8Array, svg: Uint8Array) => Promise<void>;
  prepareDragFile?(name: string, bytes: Uint8Array): Promise<string>;
  startDragFile?(token: string): Promise<void>;
  onCloseRequest?(allow: () => Promise<boolean>): Promise<Unlisten>;
  onOpenFile?(cb: (path: string) => Promise<void>): Promise<Unlisten>;
  openDocumentWindow?(path?: string): Promise<void>;
  routeOpenMapLink?(request: MapLinkNavigation): Promise<MapLinkResult | 'local' | 'closed'>;
  onMapLink?(handle: (request: MapLinkNavigation) => MapLinkResult): Promise<Unlisten>;
  claimDocumentPath?(path: string): Promise<string>;
  releaseDocumentPath?(path: string): Promise<void>;
  noteDocument?(path: string): Promise<void>;
  desktopSession?(): Promise<string[]>;
  finishDesktopSession?(reopen: boolean): Promise<void>;
  isRecoveryWindow?(): boolean;
  onQuitRequest?(allow: () => Promise<DesktopQuitDecision>, cancelled: () => void): Promise<Unlisten>;
  setWindowTitle?(title: string): Promise<void>;
  onMenu(cb: (id: MenuId) => void): Promise<Unlisten>;
  paletteItems?(): Promise<PaletteItem[]>;
  runPaletteItem?(id: string): Promise<void>;
  setMenuKeys?(bindings: Record<string, string>): Promise<void>;
  openNodeUrl(url: URL): Promise<void>;

  /** Read and write a UTF-8 text file chosen through the dialogs (import and export). */
  readBinaryFile(path: string): Promise<Uint8Array>;
  rasterizeImportedPdf?(bytes: Uint8Array, tint?: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, text: string): Promise<void>;
  openPdfForPrint?(name: string, bytes: Uint8Array): Promise<void>;
  exportFile(name: string, mime: string, bytes: Uint8Array): Promise<boolean>;
  exportPortableDirectory?(name: string, prepare: () => Promise<import('../core/io/portable').PortableFiles>): Promise<boolean>;
  readPortableDirectory(): Promise<import('../core/io/portable').PortableFiles | null>;
  pickImportPath(): Promise<string | null>; // filters: .md, .markdown, .opml, .mm, .txt
}
