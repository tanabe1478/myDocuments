import { Facet, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { DEFAULT_VOLUME, type TypingSoundPlayer, type TypingSoundVolume } from './player';

/** 音量の設定の値を、エディタの state に持たせる（音量の設定は別の登録で、値が変わると差し替わる）。 */
export const volumeFacet = Facet.define<TypingSoundVolume, TypingSoundVolume>({
  combine: (values) => values[values.length - 1] ?? DEFAULT_VOLUME,
});

/**
 * 本文の keydown を観察して、音を鳴らす。
 * keydown は preventDefault せず、止めもしない。ほかの keydown の処理（リストの継続の Enter など、先に処理して止めるもの）に
 * 隠れないよう、CodeMirror の処理の連鎖ではなく、エディタの外枠の capture 段階で受ける（本文の中のイベントだけ数える）。
 * 拡張が入るのは、設定がオンのときだけ。入った時点で素材の読み込みを始める。
 */
export function typingSoundExtension(player: TypingSoundPlayer): Extension {
  return ViewPlugin.define((view: EditorView) => {
    const onKeyDown = (event: KeyboardEvent) => {
      try {
        if (!(event.target instanceof Node) || !view.contentDOM.contains(event.target)) return;
        player.handleKeyDown(event, view.state.facet(volumeFacet));
      } catch {
        // 音の失敗を入力に影響させない。
      }
    };
    view.dom.addEventListener('keydown', onKeyDown, true);
    try {
      player.prepare();
    } catch {
      // 読み込みを始められなくても、入力は妨げない。
    }
    return { destroy: () => view.dom.removeEventListener('keydown', onKeyDown, true) };
  });
}
