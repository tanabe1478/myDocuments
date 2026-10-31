import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { DocumentFormat } from '../document/format';
import {
  BridgeError,
  type BridgeErrorKind,
  type DocumentBridge,
  type OpenedDocument,
  type SaveOutcome,
} from './DocumentBridge';

const FILTERS = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }];

const KINDS: readonly BridgeErrorKind[] = [
  'not-found',
  'permission-denied',
  'not-utf8',
  'not-allowed',
  'invalid-input',
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
    saveDocument: (path: string, text: string, format: DocumentFormat) =>
      call<SaveOutcome>('save_document', { path, text, format }),
    saveDocumentAs: (path: string, text: string, format: DocumentFormat) =>
      call<SaveOutcome>('save_document_as', { path, text, format }),
    loadPreferences: () => call<unknown>('load_preferences'),
    savePreferences: (prefs) => call<void>('save_preferences', { prefs }),
    notifyReady: () => emit('frontend-ready'),
  };
}
