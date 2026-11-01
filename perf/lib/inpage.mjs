// ページ内で動く計測の道具。addInitScript で window.__perf に入れる（アプリの読み込み前に注入する）。
// 時刻はすべてページ内の performance.now()（ms）。イベントの起点は event.timeStamp（ブラウザがイベントを受けた時刻）。
export const inPageSource = `(() => {
  const perf = (window.__perf = { typing: [], ime: [], imeCommit: [], changed: 0, composedEnd: 0, errors: [] });

  // pred が true になった最初のフレームの描画の後（rAF の後の最初のタスク）の時刻。timeout なら null。
  perf.frameWhen = (pred, timeoutMs = 3000) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        let ok = false;
        try { ok = pred(); } catch (e) { perf.errors.push(String(e)); }
        if (ok) {
          const ch = new MessageChannel();
          ch.port1.onmessage = () => resolve(performance.now());
          ch.port2.postMessage(0);
        } else if (performance.now() - t0 > timeoutMs) resolve(null);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

  // 本文の変化の回数（編集エンジンの onChange）。ユーザーの入力による変化だけ数える。
  perf.attach = () => {
    const ed = window.__mdeE2E && window.__mdeE2E.editor;
    if (!ed) return false;
    if (perf.attached) return true;
    perf.attached = true;
    ed.onChange(() => { perf.changed++; });
    return true;
  };

  // キー入力 → 本文の変化 → 次のフレームの描画後。keydown（capture）の timeStamp を起点にする。
  document.addEventListener('keydown', (e) => {
    if (!perf.typingOn || e.key.length !== 1 || e.metaKey || e.ctrlKey) return;
    const before = perf.changed;
    const t0 = e.timeStamp;
    perf.frameWhen(() => perf.changed > before).then((t1) => {
      perf.typing.push(t1 === null ? null : t1 - t0);
    });
  }, true);

  // IME: compositionupdate → 本文への反映（onChange）→ 次の描画後（変換中の文字が画面に出るまで）。
  document.addEventListener('compositionupdate', (e) => {
    // 確定（insertText）が出す compositionupdate は本文を変えないので数えない。
    if (!perf.imeOn || perf.committing) return;
    const t0 = e.timeStamp;
    const before = perf.changed;
    perf.frameWhen(() => perf.changed > before).then((t1) => { perf.ime.push(t1 === null ? null : t1 - t0); });
  }, true);

  // IME: compositionend（確定）→ 確定した文字が本文にあり、次の描画後。
  // 確定文字は 1 回ごとに別の文字列にする（本文に同じ文字列が残っていると、待たずに成立してしまうため）。
  document.addEventListener('compositionend', (e) => {
    if (!perf.imeOn) return;
    const t0 = e.timeStamp;
    const text = e.data;
    perf.frameWhen(() => {
      const c = document.querySelector('.cm-content');
      return !!c && c.textContent.includes(text);
    }).then((t1) => { perf.imeCommit.push(t1 === null ? null : t1 - t0); });
  }, true);

  // n 件の結果がそろうまで待つ。
  perf.waitCount = (key, n, timeoutMs = 5000) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const poll = () => {
        if (perf[key].length >= n) resolve(true);
        else if (performance.now() - t0 > timeoutMs) resolve(false);
        else setTimeout(poll, 5);
      };
      poll();
    });

  // 長文スクロール: 一定速度（px/秒）で scrollTop を進め、rAF の間隔（フレーム時間）を記録する。
  perf.scroll = (selector, pxPerSec, durationMs) =>
    new Promise((resolve) => {
      const el = document.querySelector(selector);
      const frames = [];
      const start = performance.now();
      const startTop = el.scrollTop;
      let last = start;
      const tick = (now) => {
        frames.push(now - last);
        last = now;
        const elapsed = now - start;
        el.scrollTop = startTop + (pxPerSec * elapsed) / 1000;
        if (elapsed < durationMs) requestAnimationFrame(tick);
        else resolve({ frames: frames.slice(1), scrolled: el.scrollTop - startTop, scrollHeight: el.scrollHeight });
      };
      requestAnimationFrame(tick);
    });
})();`;
