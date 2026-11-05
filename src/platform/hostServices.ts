import type { HostServices, IsolatedServices } from '../plugin-api';
import type { DocumentBridge } from './DocumentBridge';
import { isOpenableExternalUrl } from './externalUrl';

/** 開けないリンクを知らせるトーストの文言。 */
export const LINK_NOT_OPENABLE_MESSAGE = 'このリンクは開けません';

export interface HostServicesOptions {
  readonly bridge: Pick<DocumentBridge, 'openExternalUrl'>;
  /** 利用者に知らせる（トースト）。 */
  readonly notify: (notice: { kind: 'info'; message: string }) => void;
  /** 使っている OS が macOS か。 */
  readonly isMacPlatform: () => boolean;
}

/**
 * 本体が部品（段 3）に貸す機能（ADR-005 の R4）。
 * - 外部の URL を開く: http / https だけを既定のブラウザで開く（ネイティブ側でも検査する）。開けない URL と、開くのに失敗したときは、
 *   トースト「このリンクは開けません」で知らせる。部品は bridge を直接使わない。
 * - OS の判定: 呼んだ時点の判定を返す。
 */
export function createHostServices({ bridge, notify, isMacPlatform }: HostServicesOptions): HostServices {
  const notOpenable = () => notify({ kind: 'info', message: LINK_NOT_OPENABLE_MESSAGE });
  return {
    openExternalUrl(url) {
      if (!isOpenableExternalUrl(url)) {
        notOpenable();
        return;
      }
      bridge.openExternalUrl(url).catch(notOpenable);
    },
    isMacPlatform,
  };
}

/** クリップボードに書けたときのトーストの文言。 */
export const CLIPBOARD_COPIED_MESSAGE = 'クリップボードにコピーしました';
/** クリップボードに書けなかったときのトーストの文言。 */
export const CLIPBOARD_FAILED_MESSAGE = 'クリップボードに書けませんでした';

export interface IsolatedServicesOptions {
  readonly bridge: Pick<DocumentBridge, 'writeClipboardText'>;
  /** 利用者に知らせる（トースト）。 */
  readonly notify: (notice: { kind: 'info' | 'error'; message: string }) => void;
  /** 開いている文書のパス（未保存の新規文書は null）。呼ぶたびに今の値を返す。 */
  readonly currentPath: () => string | null;
}

/**
 * 本体が段 2 の部品に貸す機能（ADR-005 の R6）。権限の確認（clipboard.write、paths.read）は、レジストリが、これを呼ぶ前に済ませる。
 * - クリップボードに書く: 本体の bridge（自前のネイティブのコマンド）を通す。書けたら、トースト「クリップボードにコピーしました」。
 *   書けなかったときは、トースト「クリップボードに書けませんでした」を出し、部品の呼び出しは失敗になる。
 * - 開いている文書のパス: 呼んだ時点の値。
 */
export function createIsolatedServices({ bridge, notify, currentPath }: IsolatedServicesOptions): IsolatedServices {
  return {
    async writeClipboardText(text) {
      try {
        await bridge.writeClipboardText(text);
      } catch (error) {
        notify({ kind: 'error', message: CLIPBOARD_FAILED_MESSAGE });
        throw error;
      }
      notify({ kind: 'info', message: CLIPBOARD_COPIED_MESSAGE });
    },
    currentPath,
  };
}
