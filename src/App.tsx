import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { textKindOf } from './document/fileKinds';
import { UNTITLED, documentTitle, isDirty } from './document/state';
import { ExplorerController, type TrashTarget } from './explorer/controller';
import type { EditorAdapter } from './editor/EditorAdapter';
import { createCodeMirrorAdapter } from './editor/codemirror/CodeMirrorAdapter';
import { BridgeError, type DocumentBridge, type DraftSummary } from './platform';
import { applyPreferences } from './preferences/apply';
import { normalizePreferences, type Preferences } from './preferences/preferences';
import { useResolvedTheme } from './preferences/useResolvedTheme';
import { charsPerLine, columnWidth } from './editor/layout';
import { ConflictBar, isConflictBarVisible } from './ui/ConflictBar';
import { ConfirmDiscardDialog } from './ui/ConfirmDiscardDialog';
import { ConfirmRecreateDialog } from './ui/ConfirmRecreateDialog';
import { ConfirmTrashDialog } from './ui/ConfirmTrashDialog';
import { DiffDialog } from './ui/DiffDialog';
import { RecoveryDialog } from './ui/RecoveryDialog';
import { SettingsDialog } from './ui/SettingsDialog';
import { Sidebar, SIDEBAR_ID } from './ui/Sidebar';
import { sidebarMode, sidebarReserve } from './ui/sidebarLayout';
import { isMacPlatform, matchShortcut, shouldHandleShortcut } from './ui/shortcuts';
import { Toast, type ToastNotice } from './ui/Toast';
import { toastLayout } from './ui/toastLayout';

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

interface PendingTrash {
  target: TrashTarget;
  resolve(confirmed: boolean): void;
}

interface PendingRecovery {
  draft: DraftSummary;
  others: number;
  resolve(choice: RecoveryChoice): void;
}

export function App({ bridge, initialPreferences }: { bridge: DocumentBridge; initialPreferences: Preferences }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const bottombarRef = useRef<HTMLElement>(null);
  const adapterRef = useRef<EditorAdapter | null>(null);
  const noticeId = useRef(0);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [recreate, setRecreate] = useState<PendingRecreate | null>(null);
  const [recovery, setRecovery] = useState<PendingRecovery | null>(null);
  const [trash, setTrash] = useState<PendingTrash | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [notice, setNotice] = useState<ToastNotice | null>(null);
  const [prefs, setPrefs] = useState<Preferences>(initialPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 入力で隠した状態（autoHideChrome が ON のときだけ効く）。ポインタ・フォーカス・F6 で戻る。 */
  const [typing, setTyping] = useState(false);
  const settingsOriginRef = useRef<HTMLElement | null>(null);
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

  // エクスプローラーから文書を開く。開けたら、本文へフォーカスを移す（すぐ書ける）。
  const openFromExplorer = useCallback(
    async (path: string) => {
      const opened = await controller.openPath(path);
      if (opened) adapterRef.current?.focus();
      return opened;
    },
    [controller],
  );

  const explorer = useMemo(
    () =>
      new ExplorerController({
        bridge,
        notify,
        confirmTrash: (target) => new Promise<boolean>((resolve) => setTrash({ target, resolve })),
        documents: {
          isDocumentInside: controller.isDocumentInside,
          rename: controller.renameEntry,
          checkExternal: controller.checkExternal,
          open: openFromExplorer,
        },
      }),
    [bridge, notify, controller, openFromExplorer],
  );
  const explorerState = useSyncExternalStore(explorer.subscribe, explorer.getState);

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
    adapter.setTextKind(textKindOf(controller.getState().path));
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

  // .txt と .text は素のテキストとして表示する（別名保存で拡張子が変わったときも追従する）。描画の前に切り替える。
  const textKind = textKindOf(state.path);
  useLayoutEffect(() => adapterRef.current?.setTextKind(textKind), [textKind]);

  // 前回のフォルダを復元する（開けなければ未選択のまま、トーストで知らせる）。
  useEffect(() => void explorer.restore(), [explorer]);

  // フォルダの項目の増減の通知（監視中のフォルダ）を、ツリーへ反映する。
  useEffect(() => {
    let off: (() => void) | null = null;
    let cancelled = false;
    void explorer.attach().then((unsubscribe) => {
      if (cancelled) unsubscribe();
      else off = unsubscribe;
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [explorer]);

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
  const sidebarOpen = prefs.sidebarOpen;
  const sidebarLayoutMode = sidebarMode(viewportWidth);
  // 本文の領域（サイドバーを除いた領域）の幅。狭い窓では、サイドバーは本文の上に重なるので、引かない。
  const reserve = sidebarReserve(sidebarOpen, viewportWidth);
  const lineChars = charsPerLine(
    columnWidth(viewportWidth - reserve, prefs.maxWidthPx),
    prefs.fontSizePx,
    prefs.letterSpacing,
  );

  // トースト: 本文の領域の中で、列の外に場所があれば右下、なければ本文に重ねる。重ねている間は、覆う高さをエディタのスクロール余白に渡す。
  const toast = useMemo(() => toastLayout(viewportWidth - reserve, prefs.maxWidthPx), [viewportWidth, reserve, prefs.maxWidthPx]);
  const setCoveredHeight = useCallback((px: number) => adapterRef.current?.setBottomInset(px), []);

  const reveal = useCallback(() => setTyping(false), []);
  const chromeHidden = prefs.autoHideChrome && typing && !settingsOpen;

  const openSettings = useCallback((origin: HTMLElement | null) => {
    settingsOriginRef.current = origin;
    setSettingsOpen(true);
  }, []);

  /** 閉じたら、開く前にフォーカスのあった場所へ戻す（なければ本文）。 */
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    const origin = settingsOriginRef.current;
    settingsOriginRef.current = null;
    if (origin?.isConnected && origin !== document.body) origin.focus();
    else adapterRef.current?.focus();
  }, []);

  const toggleSettings = useCallback(() => {
    if (settingsOpen) closeSettings();
    else openSettings(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }, [settingsOpen, closeSettings, openSettings]);

  const toggleSidebar = useCallback(() => setPrefs((p) => ({ ...p, sidebarOpen: !p.sidebarOpen })), []);

  /** 重ねて表示中のサイドバーを閉じる（中の閉じるボタン・Esc から）。 */
  const closeSidebar = useCallback(() => {
    setPrefs((p) => ({ ...p, sidebarOpen: false }));
    adapterRef.current?.focus();
  }, []);

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
      // 競合バーは、表示中（conflictRef が付いているとき）だけ巡回に含める。
      const all: Array<{ el: HTMLElement | null; focus(): void }> = [
        { el: hostRef.current, focus: () => adapterRef.current?.focus() },
        { el: topbarRef.current, focus: () => firstFocusable(topbarRef.current)?.focus() },
        { el: conflictRef.current, focus: () => firstFocusable(conflictRef.current)?.focus() },
        { el: bottombarRef.current, focus: () => firstFocusable(bottombarRef.current)?.focus() },
      ];
      const regions = all.filter((r) => r.el !== null);
      const active = document.activeElement;
      const current = regions.findIndex((r) => active !== null && r.el?.contains(active));
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
      // F6: 本文 → 上部バー → 競合バー（表示中のみ）→ 下部バー → 本文（Shift で逆順）。バーが隠れていても届く。
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
        case 'settings':
          toggleSettings();
          break;
        case 'sidebar':
          // 設定画面（モーダル）を開いている間は、後ろのレイアウトを動かさない。
          if (!settingsOpen) toggleSidebar();
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
  }, [bridge, controller, runCommand, toggleSettings, toggleSidebar, settingsOpen, cycleRegion, notify]);

  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${title} - Immersive Markdown Editor`;
  }, [dirty, title]);

  const dismissNotice = useCallback((id: number) => setNotice((n) => (n?.id === id ? null : n)), []);

  const choose = (choice: DiscardChoice) => {
    confirm?.resolve(choice);
    setConfirm(null);
  };

  const chooseTrash = (confirmed: boolean) => {
    trash?.resolve(confirmed);
    setTrash(null);
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
      data-surface={prefs.surfaceWidth}
      data-sidebar={sidebarOpen ? 'open' : 'closed'}
      data-sidebar-mode={sidebarLayoutMode}
      data-conflict={isConflictBarVisible(external) ? 'true' : 'false'}
    >
      <CanvasBackground layer={canvas.layer} imageUrl={image.url} />
      <Sidebar
        open={sidebarOpen}
        mode={sidebarLayoutMode}
        explorer={explorer}
        explorerState={explorerState}
        currentPath={state.path}
        onOpenFile={(path) => void openFromExplorer(path)}
        onClose={closeSidebar}
      />
      <div className="workspace" data-testid="workspace">
        <div className="canvas-surface" data-testid="canvas-surface" aria-hidden="true" style={{ opacity: canvas.surfaceOpacity }} />
        <header className="topbar" ref={topbarRef} aria-label="上部バー" onFocus={reveal}>
          <button
            type="button"
            className="chrome-button icon-button"
            data-testid="sidebar-toggle"
            aria-label="サイドバー"
            aria-expanded={sidebarOpen}
            aria-controls={SIDEBAR_ID}
            title={`サイドバー（${isMacPlatform() ? '⌘B' : 'Ctrl+B'}）`}
            onClick={toggleSidebar}
          >
            <SidebarIcon />
          </button>
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
            className="chrome-button icon-button"
            data-testid="settings-button"
            aria-label="設定"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            title={`設定（${isMacPlatform() ? '⌘,' : 'Ctrl+,'}）`}
            onClick={(e) => (settingsOpen ? closeSettings() : openSettings(e.currentTarget))}
          >
            <GearIcon />
          </button>
        </header>
        <ConflictBar
          external={external}
          regionRef={conflictRef}
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
        <Toast notice={notice} layout={toast} onDismiss={dismissNotice} onCoveredHeight={setCoveredHeight} />
      </div>
      {settingsOpen && (
        <SettingsDialog
          prefs={prefs}
          mode={theme}
          contrast={canvas.contrast}
          lineChars={lineChars}
          imageStatus={image.status}
          onChange={updatePrefs}
          onPickImage={() => void pickImage()}
          onClose={closeSettings}
        />
      )}
      {diskTextForDiff !== null && <DiffDialog mine={state.text} disk={diskTextForDiff} onClose={closeDiff} />}
      {confirm && <ConfirmDiscardDialog documentName={confirm.documentName} onChoose={choose} />}
      {recreate && <ConfirmRecreateDialog documentName={recreate.documentName} onChoose={chooseRecreate} />}
      {trash && <ConfirmTrashDialog target={trash.target} onChoose={chooseTrash} />}
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

function SidebarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="1.7" y="2.7" width="12.6" height="10.6" rx="1.8" />
      <line x1="6" y1="2.7" x2="6" y2="13.3" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
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
