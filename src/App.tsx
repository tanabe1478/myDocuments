import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { backgroundImageId, resolveCanvas } from './canvas/canvas';
import { CanvasBackground } from './canvas/CanvasBackground';
import { countCharacters } from './canvas/charCount';
import { useBackgroundImage } from './canvas/useBackgroundImage';
import {
  DocumentController,
  describeError,
  type DiscardChoice,
  type Notice,
  type RecoveryChoice,
} from './document/controller';
import { draftTitle } from './document/recovery';
import { UNTITLED, documentTitle, isDirty } from './document/state';
import type { EditorAdapter } from './editor/EditorAdapter';
import { createCodeMirrorAdapter } from './editor/codemirror/CodeMirrorAdapter';
import { BridgeError, type DocumentBridge, type DraftSummary } from './platform';
import { applyPreferences } from './preferences/apply';
import { normalizePreferences, type Preferences } from './preferences/preferences';
import { useResolvedTheme } from './preferences/useResolvedTheme';
import { charsPerLine, columnWidth } from './editor/layout';
import { AppearancePanel } from './ui/AppearancePanel';
import { ConflictBar } from './ui/ConflictBar';
import { ConfirmDiscardDialog } from './ui/ConfirmDiscardDialog';
import { ConfirmRecreateDialog } from './ui/ConfirmRecreateDialog';
import { DiffDialog } from './ui/DiffDialog';
import { RecoveryDialog } from './ui/RecoveryDialog';
import { panelReserve } from './ui/panelLayout';
import { isMacPlatform, matchShortcut, shouldHandleShortcut } from './ui/shortcuts';
import { Toast, type ToastNotice } from './ui/Toast';

/** 設定の変更から保存までの待ち（連続操作をまとめる）。 */
const SAVE_DEBOUNCE_MS = 300;

interface PendingConfirm {
  documentName: string;
  resolve(choice: DiscardChoice): void;
}

interface PendingRecreate {
  documentName: string;
  resolve(recreate: boolean): void;
}

interface PendingRecovery {
  draft: DraftSummary;
  others: number;
  resolve(choice: RecoveryChoice): void;
}

export function App({ bridge, initialPreferences }: { bridge: DocumentBridge; initialPreferences: Preferences }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const bottombarRef = useRef<HTMLElement>(null);
  const adapterRef = useRef<EditorAdapter | null>(null);
  const noticeId = useRef(0);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [recreate, setRecreate] = useState<PendingRecreate | null>(null);
  const [recovery, setRecovery] = useState<PendingRecovery | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [notice, setNotice] = useState<ToastNotice | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(initialPreferences);
  const [panelOpen, setPanelOpen] = useState(false);
  /** 入力で隠した状態（autoHideChrome が ON のときだけ効く）。ポインタ・フォーカス・F6 で戻る。 */
  const [typing, setTyping] = useState(false);
  const panelOriginRef = useRef<HTMLElement | null>(null);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const controller = useMemo(
    () =>
      new DocumentController({
        bridge,
        io: {
          getText: () => adapterRef.current?.getText() ?? '',
          setText: (text) => adapterRef.current?.setText(text),
        },
        confirmDiscard: (documentName) =>
          new Promise<DiscardChoice>((resolve) => setConfirm({ documentName, resolve })),
        confirmRecreate: (documentName) =>
          new Promise<boolean>((resolve) => setRecreate({ documentName, resolve })),
        askRecovery: (draft, others) =>
          new Promise<RecoveryChoice>((resolve) => setRecovery({ draft, others, resolve })),
        notify: (n: Notice) => setNotice({ ...n, id: ++noticeId.current }),
      }),
    [bridge],
  );

  const notify = useCallback((n: Notice) => setNotice({ ...n, id: ++noticeId.current }), []);

  const updatePrefs = useCallback(
    (patch: Partial<Preferences>) => setPrefs((p) => normalizePreferences({ ...p, ...patch })),
    [],
  );

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const external = useSyncExternalStore(controller.subscribe, controller.getExternal);
  const diskTextForDiff = diffOpen ? controller.getDiskTextForDiff() : null;
  const dirty = isDirty(state);
  const title = documentTitle(state);

  // 編集エンジンの取り付け。最初の描画が済んだら、ネイティブ側へ知らせる（窓を表示する）。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const adapter = createCodeMirrorAdapter();
    adapter.mount(host);
    adapter.focus();
    adapterRef.current = adapter;
    adapter.setFocusMode(prefsRef.current.focusMode);
    adapter.setTypewriterMode(prefsRef.current.typewriterMode);
    const off = adapter.onChange((text) => {
      controller.handleEdit(text);
      setTyping(true);
    });
    if (__E2E__ && window.__mdeE2E) window.__mdeE2E.editor = adapter;

    // ネイティブ側からの通知: 監視中の文書の外部変更、窓を閉じる・終了する操作。
    // 終了の確認の受け手がそろってから、窓の表示（notifyReady）を知らせる。
    let cancelled = false;
    const subscriptions = Promise.all([
      bridge.onDocumentChanged((path) => {
        if (controller.getState().path === path) void controller.checkExternal();
      }),
      bridge.onCloseRequested(() => void controller.requestClose()),
    ]).catch(() => [] as Array<() => void>);
    // ウィンドウに戻ったら確かめる（監視の取りこぼし対策）。
    const onWindowFocus = () => void controller.checkExternal();
    window.addEventListener('focus', onWindowFocus);

    // 前回の草稿の復旧、または前回の文書の開き直し。
    void controller.start();

    // 窓は非表示で作られており、非表示の間は requestAnimationFrame が止まる。
    // rAF には頼らず、レイアウトが済む程度の短い待ちの後に知らせる。
    const readyTimer = setTimeout(() => {
      if (!cancelled) void subscriptions.then(() => bridge.notifyReady()).catch(() => {});
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(readyTimer);
      window.removeEventListener('focus', onWindowFocus);
      void subscriptions.then((offs) => offs.forEach((o) => o()));
      off();
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [bridge, controller]);

  useEffect(() => adapterRef.current?.setFocusMode(prefs.focusMode), [prefs.focusMode]);
  useEffect(() => adapterRef.current?.setTypewriterMode(prefs.typewriterMode), [prefs.typewriterMode]);

  // 設定を CSS 変数と data-theme に反映する（即時）。
  useEffect(() => applyPreferences(prefs), [prefs]);

  // 保存は debounce。ウィンドウを閉じる直前の分は pagehide で出す。
  const savedRef = useRef(initialPreferences);
  useEffect(() => {
    if (prefs === savedRef.current) return;
    const timer = setTimeout(() => {
      savedRef.current = prefs;
      bridge.savePreferences(prefs).catch((e) => notify({ kind: 'error', message: describeError(e) }));
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [prefs, bridge, notify]);
  useEffect(() => {
    const flush = () => {
      if (prefsRef.current === savedRef.current) return;
      savedRef.current = prefsRef.current;
      void bridge.savePreferences(prefsRef.current).catch(() => {});
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [bridge]);

  const theme = useResolvedTheme(prefs.theme);
  const image = useBackgroundImage(bridge, backgroundImageId(prefs.background));
  const canvas = resolveCanvas(prefs, theme, image.average);
  const characters = useMemo(() => countCharacters(state.text), [state.text]);

  const viewportWidth = useViewportWidth();
  const reserve = panelOpen ? panelReserve(prefs.maxWidthPx, viewportWidth) : 0;
  const lineChars = charsPerLine(
    columnWidth(viewportWidth - reserve, prefs.maxWidthPx),
    prefs.fontSizePx,
    prefs.letterSpacing,
  );

  const reveal = useCallback(() => setTyping(false), []);
  const chromeHidden = prefs.autoHideChrome && typing && !panelOpen;

  const openPanel = useCallback((origin: HTMLElement | null) => {
    panelOriginRef.current = origin;
    setPanelOpen(true);
  }, []);

  /** 閉じたら、開く前にフォーカスのあった場所へ戻す（なければ本文）。 */
  const closePanel = useCallback(() => {
    setPanelOpen(false);
    const origin = panelOriginRef.current;
    panelOriginRef.current = null;
    if (origin?.isConnected && origin !== document.body) origin.focus();
    else adapterRef.current?.focus();
  }, []);

  const togglePanel = useCallback(() => {
    if (panelOpen) closePanel();
    else openPanel(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, [panelOpen, closePanel, openPanel]);

  const pickImage = useCallback(async () => {
    try {
      const path = await bridge.pickImagePath();
      if (path === null) return;
      const imageId = await bridge.importBackgroundImage(path);
      setPrefs((p) =>
        normalizePreferences({ ...p, background: { ...p.background, kind: 'image', imageId }, hideBackground: false }),
      );
    } catch (e) {
      const message =
        e instanceof BridgeError && e.kind === 'invalid-input'
          ? '画像を取り込めませんでした。png・jpeg・webp の 20 MiB 以下の画像を選んでください。'
          : describeError(e);
      notify({ kind: 'error', message });
    }
  }, [bridge, notify]);

  // 自動非表示: ポインタが動いたら戻す。座標が変わらない通知（描画の変化に伴うものなど）は無視する。
  useEffect(() => {
    let x = -1;
    let y = -1;
    const onMove = (e: PointerEvent) => {
      if (e.clientX === x && e.clientY === y) return;
      x = e.clientX;
      y = e.clientY;
      reveal();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [reveal]);

  const cycleRegion = useCallback(
    (direction: 1 | -1) => {
      const regions: Array<{ el: HTMLElement | null; focus(): void }> = [
        { el: hostRef.current, focus: () => adapterRef.current?.focus() },
        { el: topbarRef.current, focus: () => firstFocusable(topbarRef.current)?.focus() },
        { el: bottombarRef.current, focus: () => firstFocusable(bottombarRef.current)?.focus() },
      ];
      const active = document.activeElement;
      const current = regions.findIndex((r) => r.el !== null && active !== null && r.el.contains(active));
      const next = regions[(Math.max(current, 0) + direction + regions.length) % regions.length];
      reveal();
      next?.focus();
    },
    [reveal],
  );

  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    await command();
    adapterRef.current?.focus();
  }, []);

  // ショートカット。ダイアログ表示中などの多重実行は controller が止める。
  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (e: KeyboardEvent) => {
      // F6: 本文 → 上部バー → 下部バー → 本文（Shift で逆順）。バーが隠れていても届く。
      if (e.key === 'F6' && !e.isComposing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        cycleRegion(e.shiftKey ? -1 : 1);
        return;
      }
      const action = matchShortcut(e, mac);
      if (!action || !shouldHandleShortcut(action, e.target)) return;
      e.preventDefault();
      switch (action) {
        case 'new':
          void runCommand(controller.newDocument);
          break;
        case 'open':
          void runCommand(controller.openDocument);
          break;
        case 'save':
          void runCommand(controller.save);
          break;
        case 'saveAs':
          void runCommand(controller.saveAs);
          break;
        case 'appearance':
          togglePanel();
          break;
        case 'focusMode':
          setPrefs((p) => ({ ...p, focusMode: !p.focusMode }));
          break;
        case 'typewriterMode':
          setPrefs((p) => ({ ...p, typewriterMode: !p.typewriterMode }));
          break;
        case 'fullscreen':
          bridge.toggleFullscreen().catch((err) => notify({ kind: 'error', message: describeError(err) }));
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bridge, controller, runCommand, togglePanel, cycleRegion, notify]);

  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${title} - Immersive Markdown Editor`;
  }, [dirty, title]);

  const dismissNotice = useCallback((id: number) => setNotice((n) => (n?.id === id ? null : n)), []);

  const choose = (choice: DiscardChoice) => {
    confirm?.resolve(choice);
    setConfirm(null);
  };

  const chooseRecreate = (ok: boolean) => {
    recreate?.resolve(ok);
    setRecreate(null);
  };

  const chooseRecovery = (choice: RecoveryChoice) => {
    recovery?.resolve(choice);
    setRecovery(null);
    adapterRef.current?.focus();
  };

  const closeDiff = useCallback(() => {
    setDiffOpen(false);
    adapterRef.current?.focus();
  }, []);

  return (
    <div
      className="app"
      data-chrome={chromeHidden ? 'hidden' : 'visible'}
      data-theme-mode={theme}
      data-panel-shift={reserve > 0 ? 'true' : 'false'}
      style={{ '--md-panel-reserve': `${reserve}px` } as React.CSSProperties}
    >
      <CanvasBackground layer={canvas.layer} imageUrl={image.url} />
      <div className="canvas-surface" data-testid="canvas-surface" aria-hidden="true" style={{ opacity: canvas.surfaceOpacity }} />
      <header className="topbar" ref={topbarRef} aria-label="上部バー" onFocus={reveal}>
        <span className="doc-title" data-testid="doc-title">
          {title}
        </span>
        {dirty && (
          <span className="unsaved-mark" data-testid="unsaved-mark" role="img" aria-label="未保存の変更あり" title="未保存の変更あり">
            ●
          </span>
        )}
        <span className="topbar-spacer" />
        <button
          type="button"
          className="chrome-button"
          data-testid="appearance-button"
          aria-haspopup="dialog"
          aria-expanded={panelOpen}
          title={`外観（${isMacPlatform() ? '⌘' : 'Ctrl+'},）`}
          onClick={(e) => (panelOpen ? closePanel() : openPanel(e.currentTarget))}
        >
          外観
        </button>
      </header>
      <ConflictBar
        external={external}
        onShowDiff={() => setDiffOpen(true)}
        onReload={() => void runCommand(controller.reloadFromDisk)}
        onKeepMine={() => {
          controller.keepMine();
          adapterRef.current?.focus();
        }}
        onRecreate={() => void runCommand(controller.save)}
      />
      <main className="editor-host" ref={hostRef} />
      <footer className="bottombar" ref={bottombarRef} aria-label="下部バー" onFocus={reveal}>
        {/* 環境音のコントロールの置き場所（Phase 2）。いまは中身を作らない。 */}
        <div className="bottombar-slot" data-slot="ambient" />
        <span className="char-count" data-testid="char-count" tabIndex={0}>
          {characters.toLocaleString('ja-JP')} 文字
        </span>
      </footer>
      {panelOpen && (
        <AppearancePanel
          prefs={prefs}
          mode={theme}
          contrast={canvas.contrast}
          lineChars={lineChars}
          imageStatus={image.status}
          onChange={updatePrefs}
          onPickImage={() => void pickImage()}
          onClose={closePanel}
        />
      )}
      <Toast notice={notice} onDismiss={dismissNotice} />
      {diskTextForDiff !== null && <DiffDialog mine={state.text} disk={diskTextForDiff} onClose={closeDiff} />}
      {confirm && <ConfirmDiscardDialog documentName={confirm.documentName} onChoose={choose} />}
      {recreate && <ConfirmRecreateDialog documentName={recreate.documentName} onChoose={chooseRecreate} />}
      {recovery && (
        <RecoveryDialog
          documentName={draftTitle(recovery.draft, UNTITLED)}
          updatedAt={recovery.draft.updatedAt}
          others={recovery.others}
          onChoose={chooseRecovery}
        />
      )}
    </div>
  );
}

/** 窓の幅（resize に追従）。 */
function useViewportWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}

function firstFocusable(el: HTMLElement | null): HTMLElement | null {
  return el?.querySelector<HTMLElement>('button, [tabindex="0"]') ?? null;
}
