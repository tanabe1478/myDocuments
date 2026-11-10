import type { DocumentBridge } from './DocumentBridge';

export type {
  BackgroundImageData,
  BridgeErrorKind,
  DiskState,
  DocumentBridge,
  Draft,
  DraftSummary,
  FolderEntry,
  FolderEntryKind,
  FolderListing,
  MoveConflict,
  OpenedDocument,
  SaveOptions,
  SaveOutcome,
  SaveResult,
  SessionInfo,
} from './DocumentBridge';
export { BridgeError, FOLDER_LISTING_LIMIT } from './DocumentBridge';
export { bridgeSpanName, instrumentBridge, MEASURED_BRIDGE_METHODS } from './instrument';

/**
 * 実行環境に合った DocumentBridge を返す。
 * __E2E__ は VITE_E2E=1 のビルドでだけ true。本番ビルドでは定数 false になり、
 * メモリ実装（./memory）は import ごと取り除かれる。
 */
export async function createBridge(): Promise<DocumentBridge> {
  if (__E2E__) {
    const { createMemoryBridge } = await import('./memory/memoryBridge');
    return createMemoryBridge();
  }
  const { createTauriBridge } = await import('./tauriBridge');
  return createTauriBridge();
}
