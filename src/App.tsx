import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DocumentController, type DiscardChoice, type Notice } from './document/controller';
import { documentTitle, isDirty } from './document/state';
import type { EditorAdapter } from './editor/EditorAdapter';
import { createCodeMirrorAdapter } from './editor/codemirror/CodeMirrorAdapter';
import type { DocumentBridge } from './platform';
import { ConfirmDiscardDialog } from './ui/ConfirmDiscardDialog';
import { isMacPlatform, matchShortcut } from './ui/shortcuts';
import { Toast, type ToastNotice } from './ui/Toast';

interface PendingConfirm {
  documentName: string;
  resolve(choice: DiscardChoice): void;
}

export function App({ bridge }: { bridge: DocumentBridge }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const adapterRef = useRef<EditorAdapter | null>(null);
  const noticeId = useRef(0);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [notice, setNotice] = useState<ToastNotice | null>(null);

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
        notify: (n: Notice) => setNotice({ ...n, id: ++noticeId.current }),
      }),
    [bridge],
  );

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
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
    const off = adapter.onChange(controller.handleEdit);
    if (__E2E__ && window.__mdeE2E) window.__mdeE2E.editor = adapter;

    // 窓は非表示で作られており、非表示の間は requestAnimationFrame が止まる。
    // rAF には頼らず、レイアウトが済む程度の短い待ちの後に知らせる。
    let cancelled = false;
    const readyTimer = setTimeout(() => {
      if (!cancelled) void bridge.notifyReady().catch(() => {});
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(readyTimer);
      off();
      adapter.destroy();
      adapterRef.current = null;
    };
  }, [bridge, controller]);

  const runCommand = useCallback(async (command: () => Promise<unknown>) => {
    await command();
    adapterRef.current?.focus();
  }, []);

  // ショートカット。ダイアログ表示中などの多重実行は controller が止める。
  useEffect(() => {
    const mac = isMacPlatform();
    const onKeyDown = (e: KeyboardEvent) => {
      const action = matchShortcut(e, mac);
      if (!action) return;
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
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller, runCommand]);

  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${title} - Immersive Markdown Editor`;
  }, [dirty, title]);

  const dismissNotice = useCallback((id: number) => setNotice((n) => (n?.id === id ? null : n)), []);

  const choose = (choice: DiscardChoice) => {
    confirm?.resolve(choice);
    setConfirm(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <span className="doc-title" data-testid="doc-title">
          {title}
        </span>
        {dirty && (
          <span className="unsaved-mark" data-testid="unsaved-mark" role="img" aria-label="未保存の変更あり" title="未保存の変更あり">
            ●
          </span>
        )}
      </header>
      <main className="editor-host" ref={hostRef} />
      <Toast notice={notice} onDismiss={dismissNotice} />
      {confirm && <ConfirmDiscardDialog documentName={confirm.documentName} onChoose={choose} />}
    </div>
  );
}
