import { useEffect, useState } from 'react';
import type { DocumentBridge } from '../platform';
import type { Rgb } from './contrast';
import { measureAverageColor } from './imageStats';

export interface BackgroundImageState {
  readonly status: 'none' | 'loading' | 'ready' | 'error';
  /** 背景に表示する blob URL。差し替え・取り外しのときに revoke する。 */
  readonly url: string | null;
  /** 縮小して求めた平均色。求められなければ null。 */
  readonly average: Rgb | null;
}

const NONE: BackgroundImageState = { status: 'none', url: null, average: null };

/** 取り込み済みの背景画像を読み、blob URL と平均色を用意する。 */
export function useBackgroundImage(bridge: DocumentBridge, imageId: string | null): BackgroundImageState {
  const [state, setState] = useState<BackgroundImageState>(NONE);

  useEffect(() => {
    if (imageId === null) {
      setState(NONE);
      return;
    }
    let cancelled = false;
    let url: string | null = null;
    setState({ status: 'loading', url: null, average: null });
    void (async () => {
      try {
        const image = await bridge.readBackgroundImage(imageId);
        if (cancelled) return;
        const blob = new Blob([image.bytes as BlobPart], { type: image.mime });
        url = URL.createObjectURL(blob);
        const average = await measureAverageColor(blob).catch(() => null);
        if (cancelled) return;
        setState({ status: 'ready', url, average });
      } catch {
        if (!cancelled) setState({ status: 'error', url: null, average: null });
      }
    })();
    return () => {
      cancelled = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [bridge, imageId]);

  return state;
}
