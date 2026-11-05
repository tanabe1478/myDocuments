/*
 * 「パスをコピー」の、Worker で動くコード（段 2。ADR-005 の R6）。クラシックスクリプトで、?raw で文字列として読み込まれ、
 * 隔離した iframe の中の Worker の中でだけ動く（ホストの空間では評価されない）。Worker のグローバルに、公開 API の `api` がある。
 *
 * 使う権限（manifest.permissions）: paths.read（開いている文書のパス、ツリーで選んだ項目）、clipboard.write（パスの書き込み）。
 * 権限を拒否された、確認の画面を閉じた、書けなかった、のどれでも、API の Promise は reject される。ここでは握りつぶして何もしない
 * （理由は本体が利用者に伝える。例外を出すと、実行が失敗として、この部品が止まってしまう）。
 */
(function () {
  'use strict';

  /** パスをクリップボードに書く。書けたかどうかのトーストは、本体が出す。 */
  async function copy(path) {
    if (typeof path !== 'string' || path === '') return;
    try {
      await api.clipboard.writeText(path);
    } catch (error) {
      // 拒否、確認を閉じた、書けなかった。何もしない。
    }
  }

  api.registerCommand({
    id: 'copy-current-path',
    title: '開いている文書のパスをコピー',
    shortcut: 'Mod+Alt+C',
    ignoreInTextEntry: true,
    run: async function () {
      var path;
      try {
        path = await api.document.currentPath();
      } catch (error) {
        return;
      }
      // 未保存の新規文書（パスがない）では、何もしない。
      if (path === null) return;
      await copy(path);
    },
  });

  api.registerContextMenuItem({
    id: 'copy-path',
    title: 'パスをコピー',
    where: 'tree',
    run: async function (target) {
      await copy(target.path);
    },
  });
})();
