import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { DocumentFormat } from '../document/format';
import { OPENABLE_EXTENSIONS } from '../document/fileKinds';
import { normalizePermissionsFile } from '../plugin-api';
import {
  BridgeError,
  type BackgroundImageData,
  type BridgeErrorKind,
  type DiskState,
  type DocumentBridge,
  type Draft,
  type DraftSummary,
  type FolderListing,
  type MoveConflict,
  type OpenedDocument,
  type SaveResult,
  type SessionInfo,
} from './DocumentBridge';

const FILTERS = [{ name: 'Markdown・テキスト', extensions: [...OPENABLE_EXTENSIONS] }];

const IMAGE_FILTERS = [{ name: '画像', extensions: ['png', 'jpg', 'jpeg', 'webp'] }];

const KINDS: readonly BridgeErrorKind[] = [
  'not-found',
  'permission-denied',
  'not-utf8',
  'not-allowed',
  'invalid-input',
  'already-exists',
  'io',
];

/** Rust 側の CommandError（{ kind, message }）を BridgeError に変える。 */
function toBridgeError(e: unknown): BridgeError {
  if (typeof e === 'object' && e !== null && 'kind' in e && 'message' in e) {
    const { kind, message } = e as { kind: unknown; message: unknown };
    if (typeof kind === 'string' && (KINDS as readonly string[]).includes(kind)) {
      return new BridgeError(kind as BridgeErrorKind, String(message));
    }
  }
  return new BridgeError('io', e instanceof Error ? e.message : String(e));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toBridgeError(e);
  }
}

/** base64（Rust 側が JSON で運ぶ画像のバイト列）をバイト列に戻す。 */
function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * セッションの更新は、読んでから書く（渡した項目以外を保つため）。並行して呼ばれても取りこぼさないよう、順番に実行する。
 */
let sessionQueue: Promise<unknown> = Promise.resolve();

function updateSession(patch: Partial<SessionInfo>): Promise<void> {
  const run = async () => {
    const current = await call<SessionInfo>('load_session');
    await call<void>('save_session', { session: { ...current, ...patch } });
  };
  const result = sessionQueue.then(run, run);
  sessionQueue = result.catch(() => {});
  return result;
}

export function createTauriBridge(): DocumentBridge {
  return {
    async pickOpenPath() {
      const selected = await open({ multiple: false, directory: false, filters: FILTERS });
      return typeof selected === 'string' ? selected : null;
    },
    async pickSavePath(suggestedName: string) {
      return (await save({ defaultPath: suggestedName, filters: FILTERS })) ?? null;
    },
    openDocument: (path: string) => call<OpenedDocument>('open_document', { path }),
    saveDocument: (path: string, text: string, format: DocumentFormat, options) =>
      call<SaveResult>('save_document', {
        path,
        text,
        format,
        expectedRevision: options.expectedRevision,
        overwrite: options.overwrite,
      }),
    saveDocumentAs: (path: string, text: string, format: DocumentFormat) =>
      call<SaveResult>('save_document_as', { path, text, format }),
    checkDocument: (path: string) => call<DiskState>('check_document', { path }),
    watchDocument: (path: string | null) => call<void>('watch_document', { path }),
    onDocumentChanged: (cb) =>
      listen<{ path: string }>('document-changed', (e) => cb(e.payload.path)),
    writeDraft: (draft: Draft) => call<string>('write_draft', { draft }),
    listDrafts: () => call<DraftSummary[]>('list_drafts'),
    readDraft: (draftId: string) => call<Draft | null>('read_draft', { draftId }),
    deleteDraft: (draftId: string) => call<void>('delete_draft', { draftId }),
    loadSession: () => call<SessionInfo>('load_session'),
    saveSession: updateSession,
    async pickFolderPath() {
      const selected = await open({ multiple: false, directory: true });
      return typeof selected === 'string' ? selected : null;
    },
    openFolder: (path: string) => call<void>('open_folder', { path }),
    listFolder: (path: string) => call<FolderListing>('list_folder', { path }),
    createFile: (parent: string, name: string) => call<string>('create_file', { parent, name }),
    createFolder: (parent: string, name: string) => call<string>('create_folder', { parent, name }),
    renameEntry: (path: string, newName: string) => call<string>('rename_entry', { path, newName }),
    trashEntry: (path: string) => call<void>('trash_entry', { path }),
    moveEntry: (path: string, destDir: string, conflict: MoveConflict) => call<string>('move_entry', { path, destDir, conflict }),
    watchFolders: (paths) => call<void>('watch_folders', { paths: [...paths] }),
    onFolderChanged: (cb) => listen<{ path: string }>('folder-changed', (e) => cb(e.payload.path)),
    onCloseRequested: (cb) => listen('close-requested', () => cb()),
    closeApp: () => call<void>('close_app'),
    loadPreferences: () => call<unknown>('load_preferences'),
    savePreferences: (prefs) => call<void>('save_preferences', { prefs }),
    async pickImagePath() {
      const selected = await open({ multiple: false, directory: false, filters: IMAGE_FILTERS });
      return typeof selected === 'string' ? selected : null;
    },
    importBackgroundImage: (path: string) => call<string>('import_background_image', { path }),
    async readBackgroundImage(imageId: string): Promise<BackgroundImageData> {
      const { mime, data } = await call<{ mime: string; data: string }>('read_background_image', { imageId });
      return { mime, bytes: decodeBase64(data) };
    },
    openExternalUrl: (url: string) => call<void>('open_external_url', { url }),
    writeClipboardText: (text: string) => call<void>('write_clipboard_text', { text }),
    async loadPluginPermissions() {
      return normalizePermissionsFile(await call<unknown>('load_plugin_permissions'));
    },
    savePluginPermissions: (permissions) => call<void>('save_plugin_permissions', { permissions }),
    setLogging: (enabled: boolean) => call<void>('set_logging', { enabled }),
    appendLog: (entries) => call<void>('append_log', { entries }),
    async toggleFullscreen() {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      return next;
    },
    notifyReady: () => emit('frontend-ready'),
  };
}
