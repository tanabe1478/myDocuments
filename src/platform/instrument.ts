import type { PluginPerf } from '../plugin-api';
import type { DocumentBridge } from './DocumentBridge';

/**
 * 性能の計測（ADR-007 の R16）で、往復を数えるブリッジのメソッド。名前は、Rust のコマンドと同じ（メソッド名をスネークケースにしたもの。
 * 区間の名前は bridge.<コマンド名>、例: saveDocument は bridge.save_document）。
 * 数えないもの: appendLog（ログを書くたびに区間が増えないように）、ファイルや画像を選ぶダイアログ（利用者の待ちが入る）、
 * 通知の購読（on で始まるもの。往復ではない）、窓の操作（toggleFullscreen、notifyReady。コマンドの往復ではない）。
 * saveSession は、読んでから書くので、2 つのコマンドの合計。
 */
export const MEASURED_BRIDGE_METHODS = [
  'openDocument',
  'saveDocument',
  'saveDocumentAs',
  'checkDocument',
  'watchDocument',
  'writeDraft',
  'listDrafts',
  'readDraft',
  'deleteDraft',
  'loadSession',
  'saveSession',
  'openFolder',
  'listFolder',
  'createFile',
  'createFolder',
  'renameEntry',
  'trashEntry',
  'moveEntry',
  'watchFolders',
  'closeApp',
  'loadPreferences',
  'savePreferences',
  'importBackgroundImage',
  'readBackgroundImage',
  'openExternalUrl',
  'writeClipboardText',
  'loadPluginPermissions',
  'savePluginPermissions',
  'setLogging',
] as const satisfies readonly (keyof DocumentBridge)[];

export type MeasuredBridgeMethod = (typeof MEASURED_BRIDGE_METHODS)[number];

/** メソッド名を、区間の名前にする: saveDocumentAs → bridge.save_document_as。 */
export function bridgeSpanName(method: string): string {
  return `bridge.${method.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
}

/**
 * ブリッジを、往復の所要時間を数える包みで覆う。引数と戻り値は読まない（本文もパスも、計測には渡らない）。
 * 計測が無効の間（perf.enabled が false）は、元のメソッドをそのまま呼ぶ（時刻も読まず、Promise も足さない）。
 * 呼ぶ前の時点で無効だった往復は、有効になった後に終わっても数えない。
 */
export function instrumentBridge(bridge: DocumentBridge, perf: PluginPerf): DocumentBridge {
  const wrapped: DocumentBridge = { ...bridge };
  const target = wrapped as unknown as Record<string, (...args: unknown[]) => unknown>;
  const source = bridge as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of MEASURED_BRIDGE_METHODS) {
    const original = source[method];
    if (typeof original !== 'function') continue;
    const name = bridgeSpanName(method);
    target[method] = (...args: unknown[]) => {
      if (!perf.enabled) return original.apply(bridge, args);
      const end = perf.span(name);
      let result: unknown;
      try {
        result = original.apply(bridge, args);
      } catch (error) {
        end();
        throw error;
      }
      if (result instanceof Promise) {
        return result.then(
          (value: unknown) => {
            end();
            return value;
          },
          (error: unknown) => {
            end();
            throw error;
          },
        );
      }
      end();
      return result;
    };
  }
  return wrapped;
}
