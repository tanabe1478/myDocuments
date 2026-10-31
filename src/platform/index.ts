import type { DocumentBridge } from './DocumentBridge';

export type { DocumentBridge, OpenedDocument, SaveOutcome, BridgeErrorKind } from './DocumentBridge';
export { BridgeError } from './DocumentBridge';

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
