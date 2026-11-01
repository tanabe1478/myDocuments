// controller のテスト用の部品。本物の bridge の代わりに、メモリ上のディスクを持つ bridge を作る。
import { vi } from 'vitest';
import {
  BridgeError,
  type DiskState,
  type DocumentBridge,
  type Draft,
  type SaveOptions,
  type SaveResult as BridgeSaveResult,
  type SessionInfo,
} from '../platform';
import {
  DocumentController,
  type DiscardChoice,
  type Notice,
  type RecoveryChoice,
} from './controller';
import type { DocumentFormat } from './format';

export const LF: DocumentFormat = { bom: false, eol: 'lf', mixedEol: false };

/** テスト用の revision。内容から決まる（本物は SHA-256）。 */
export const rev = (text: string): string => `rev:${text}`;

export interface SetupOptions {
  confirm?: DiscardChoice;
  recreate?: boolean;
  recovery?: RecoveryChoice;
  openPath?: string | null;
  savePath?: string | null;
  /** ディスクの初期状態（パス → 本文）。 */
  files?: Record<string, string>;
  drafts?: Draft[];
  session?: SessionInfo;
}

export function setup(options: SetupOptions = {}) {
  let editorText = '';
  const notices: Notice[] = [];
  const files = new Map<string, string>(Object.entries(options.files ?? { '/a.md': 'opened' }));
  const drafts = new Map<string, Draft>((options.drafts ?? []).map((d) => [d.draftId, d]));
  const backups: Array<{ path: string; text: string }> = [];
  let session: SessionInfo = options.session ?? { lastPath: null };

  const diskState = (path: string): DiskState => {
    const text = files.get(path);
    return text === undefined ? { kind: 'missing' } : { kind: 'present', revision: rev(text) };
  };

  const bridge = {
    pickOpenPath: vi.fn(async () => (options.openPath === undefined ? '/a.md' : options.openPath)),
    pickSavePath: vi.fn(async () => (options.savePath === undefined ? '/new.md' : options.savePath)),
    openDocument: vi.fn(async (path: string) => {
      const text = files.get(path);
      if (text === undefined) throw new BridgeError('not-found', 'no such file');
      return { path, text, format: LF, revision: rev(text) };
    }),
    saveDocument: vi.fn(
      async (path: string, text: string, _format: DocumentFormat, opts: SaveOptions): Promise<BridgeSaveResult> => {
        const current = diskState(path);
        const matches =
          current.kind === 'present' ? current.revision === opts.expectedRevision : opts.expectedRevision === null;
        const same = current.kind === 'present' && current.revision === rev(text);
        if (!matches && !same && !opts.overwrite) return { kind: 'conflict', disk: current };
        let backup: string | null = null;
        const old = files.get(path);
        if (!matches && !same && old !== undefined) {
          backup = `/backups/${backups.length + 1}.bak`;
          backups.push({ path: backup, text: old });
        }
        files.set(path, text);
        return { kind: 'saved', outcome: same ? 'unchanged' : 'written', revision: rev(text), backup };
      },
    ),
    saveDocumentAs: vi.fn(async (path: string, text: string): Promise<BridgeSaveResult> => {
      files.set(path, text);
      return { kind: 'saved', outcome: 'written', revision: rev(text), backup: null };
    }),
    checkDocument: vi.fn(async (path: string) => diskState(path)),
    watchDocument: vi.fn(async (_path: string | null) => {}),
    onDocumentChanged: vi.fn(async () => () => {}),
    writeDraft: vi.fn(async (draft: Draft) => {
      drafts.set(draft.draftId, draft);
      return `/data/drafts/${draft.draftId}.json`;
    }),
    listDrafts: vi.fn(async () =>
      [...drafts.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(({ draftId, path, updatedAt }) => ({ draftId, path, updatedAt })),
    ),
    readDraft: vi.fn(async (draftId: string) => drafts.get(draftId) ?? null),
    deleteDraft: vi.fn(async (draftId: string) => {
      drafts.delete(draftId);
    }),
    loadSession: vi.fn(async () => session),
    saveSession: vi.fn(async (s: SessionInfo) => {
      session = s;
    }),
    onCloseRequested: vi.fn(async () => () => {}),
    closeApp: vi.fn(async () => {}),
    loadPreferences: vi.fn(async () => null),
    savePreferences: vi.fn(async () => {}),
    pickImagePath: vi.fn(async () => null),
    importBackgroundImage: vi.fn(async () => 'a'.repeat(64)),
    readBackgroundImage: vi.fn(async () => ({ mime: 'image/png', bytes: new Uint8Array() })),
    toggleFullscreen: vi.fn(async () => true),
    notifyReady: vi.fn(async () => {}),
  } satisfies DocumentBridge;

  const confirmDiscard = vi.fn(async () => options.confirm ?? 'cancel');
  const confirmRecreate = vi.fn(async () => options.recreate ?? true);
  const askRecovery = vi.fn(async () => options.recovery ?? 'later');

  // タイマーはテストが進める。草稿の書き込みは、timers.advance(ms) で待ちを進めたときだけ起きる。
  let now = 1_000_000;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let nextTimer = 1;
  const timers = {
    delayMs: 2000,
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (h: unknown) => void pending.delete(h as number),
    /** 時間を進め、期限が来たタイマーを実行する。 */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
    },
  };

  let ids = 0;
  const controller = new DocumentController({
    bridge,
    io: { getText: () => editorText, setText: (t) => (editorText = t) },
    confirmDiscard,
    confirmRecreate,
    askRecovery,
    notify: (n) => notices.push(n),
    newDraftId: () => `draft-${++ids}`,
    draftTimers: timers,
  });
  const type = (text: string) => {
    editorText = text;
    controller.handleEdit(text);
  };
  /** タイマーで起きた草稿の書き込みの完了まで待つ。 */
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  };
  return {
    controller,
    bridge,
    confirmDiscard,
    confirmRecreate,
    askRecovery,
    notices,
    type,
    editor: () => editorText,
    files,
    drafts,
    backups,
    session: () => session,
    timers,
    settle,
  };
}

export function draftOf(partial: Partial<Draft> & Pick<Draft, 'draftId'>): Draft {
  return {
    path: null,
    text: '',
    format: LF,
    baseRevision: null,
    updatedAt: 1,
    ...partial,
  };
}
