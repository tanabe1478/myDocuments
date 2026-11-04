import type { HostServices } from '../plugin-api';
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
