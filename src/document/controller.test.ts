import { describe, expect, it, vi } from 'vitest';
import { BridgeError, type DocumentBridge, type SaveOutcome } from '../platform';
import { DocumentController, type DiscardChoice, type Notice } from './controller';
import { isDirty } from './state';
import type { DocumentFormat } from './format';

const LF: DocumentFormat = { bom: false, eol: 'lf', mixedEol: false };

function setup(options: { confirm?: DiscardChoice; openPath?: string | null; savePath?: string | null } = {}) {
  let editorText = '';
  const notices: Notice[] = [];
  const bridge = {
    pickOpenPath: vi.fn(async () => (options.openPath === undefined ? '/a.md' : options.openPath)),
    pickSavePath: vi.fn(async () => (options.savePath === undefined ? '/new.md' : options.savePath)),
    openDocument: vi.fn(async (path: string) => ({ path, text: 'opened', format: LF })),
    saveDocument: vi.fn(async (): Promise<SaveOutcome> => 'written'),
    saveDocumentAs: vi.fn(async (): Promise<SaveOutcome> => 'written'),
    loadPreferences: vi.fn(async () => null),
    savePreferences: vi.fn(async () => {}),
    pickImagePath: vi.fn(async () => null),
    importBackgroundImage: vi.fn(async () => 'a'.repeat(64)),
    readBackgroundImage: vi.fn(async () => ({ mime: 'image/png', bytes: new Uint8Array() })),
    toggleFullscreen: vi.fn(async () => true),
    notifyReady: vi.fn(async () => {}),
  } satisfies DocumentBridge;
  const confirmDiscard = vi.fn(async () => options.confirm ?? 'cancel');
  const controller = new DocumentController({
    bridge,
    io: { getText: () => editorText, setText: (t) => (editorText = t) },
    confirmDiscard,
    notify: (n) => notices.push(n),
  });
  const type = (text: string) => {
    editorText = text;
    controller.handleEdit(text);
  };
  return { controller, bridge, confirmDiscard, notices, type, editor: () => editorText };
}

describe('open', () => {
  it('loads the document into the editor and the state', async () => {
    const t = setup();
    await t.controller.openDocument();
    expect(t.editor()).toBe('opened');
    expect(t.controller.getState().path).toBe('/a.md');
    expect(isDirty(t.controller.getState())).toBe(false);
    expect(t.confirmDiscard).not.toHaveBeenCalled();
  });

  it('does nothing when the dialog is cancelled', async () => {
    const t = setup({ openPath: null });
    await t.controller.openDocument();
    expect(t.bridge.openDocument).not.toHaveBeenCalled();
    expect(t.controller.getState().path).toBeNull();
  });

  it('keeps the current document and reports an error when the file cannot be opened', async () => {
    // 未保存の本文があるので、破棄を選んだ上で開く。開けなければ、本文はそのまま残る。
    const t = setup({ confirm: 'discard' });
    t.type('mine');
    t.bridge.openDocument.mockRejectedValueOnce(new BridgeError('not-utf8', 'x'));
    await t.controller.openDocument();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]?.kind).toBe('error');
    expect(t.notices[0]?.message).toContain('UTF-8');
    expect(t.controller.getState().text).toBe('mine');
    expect(t.editor()).toBe('mine');
  });

  it('asks before replacing unsaved changes, and stops on cancel', async () => {
    const t = setup({ confirm: 'cancel' });
    t.type('unsaved');
    await t.controller.openDocument();
    expect(t.confirmDiscard).toHaveBeenCalledWith('無題');
    expect(t.bridge.pickOpenPath).not.toHaveBeenCalled();
    expect(t.editor()).toBe('unsaved');
  });

  it('discard: replaces without saving', async () => {
    const t = setup({ confirm: 'discard' });
    t.type('unsaved');
    await t.controller.openDocument();
    expect(t.bridge.saveDocumentAs).not.toHaveBeenCalled();
    expect(t.editor()).toBe('opened');
  });

  it('save: saves first, then opens', async () => {
    const t = setup({ confirm: 'save' });
    t.type('unsaved');
    await t.controller.openDocument();
    expect(t.bridge.saveDocumentAs).toHaveBeenCalledWith('/new.md', 'unsaved', LF);
    expect(t.editor()).toBe('opened');
  });

  it('save: does not continue when the save dialog is cancelled', async () => {
    const t = setup({ confirm: 'save', savePath: null });
    t.type('unsaved');
    await t.controller.openDocument();
    expect(t.bridge.pickOpenPath).not.toHaveBeenCalled();
    expect(t.editor()).toBe('unsaved');
  });
});

describe('new', () => {
  it('resets the editor and the state', async () => {
    const t = setup();
    await t.controller.openDocument();
    await t.controller.newDocument();
    expect(t.editor()).toBe('');
    expect(t.controller.getState().path).toBeNull();
  });

  it('asks when the new document has typed text', async () => {
    const t = setup({ confirm: 'cancel' });
    t.type('x');
    await t.controller.newDocument();
    expect(t.confirmDiscard).toHaveBeenCalled();
    expect(t.editor()).toBe('x');
  });
});

describe('save', () => {
  it('an untitled document goes through the save dialog (save as)', async () => {
    const t = setup();
    t.type('hello');
    expect(await t.controller.save()).toBe('written');
    expect(t.bridge.saveDocumentAs).toHaveBeenCalledWith('/new.md', 'hello', LF);
    expect(t.controller.getState().path).toBe('/new.md');
    expect(isDirty(t.controller.getState())).toBe(false);
  });

  it('suggests 無題.md for an untitled document', async () => {
    const t = setup();
    t.type('x');
    await t.controller.save();
    expect(t.bridge.pickSavePath).toHaveBeenCalledWith('無題.md');
  });

  it('a clean document is not written at all', async () => {
    const t = setup();
    await t.controller.openDocument();
    expect(await t.controller.save()).toBe('noop');
    expect(t.bridge.saveDocument).not.toHaveBeenCalled();
    expect(t.bridge.saveDocumentAs).not.toHaveBeenCalled();
  });

  it('a dirty document is written to its path with its format', async () => {
    const t = setup();
    t.bridge.openDocument.mockResolvedValueOnce({
      path: '/a.md',
      text: 'a',
      format: { bom: true, eol: 'crlf', mixedEol: false },
    });
    await t.controller.openDocument();
    t.type('ab');
    expect(await t.controller.save()).toBe('written');
    expect(t.bridge.saveDocument).toHaveBeenCalledWith('/a.md', 'ab', { bom: true, eol: 'crlf', mixedEol: false });
    expect(isDirty(t.controller.getState())).toBe(false);
  });

  it('reports a failure, and the document stays dirty', async () => {
    const t = setup();
    await t.controller.openDocument();
    t.type('changed');
    t.bridge.saveDocument.mockRejectedValueOnce(new BridgeError('permission-denied', 'x'));
    expect(await t.controller.save()).toBe('failed');
    expect(isDirty(t.controller.getState())).toBe(true);
    expect(t.notices.at(-1)?.kind).toBe('error');
  });

  it('notifies when a mixed-eol document is saved with the majority eol', async () => {
    const t = setup();
    t.bridge.openDocument.mockResolvedValueOnce({
      path: '/m.md',
      text: 'a\nb',
      format: { bom: false, eol: 'crlf', mixedEol: true },
    });
    await t.controller.openDocument();
    t.type('a\nbc');
    await t.controller.save();
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]?.message).toContain('CRLF');
    // 保存で揃ったので、次の保存では通知しない。
    t.type('a\nbcd');
    await t.controller.save();
    expect(t.notices).toHaveLength(1);
  });

  it('tells the user when the bridge reports unchanged', async () => {
    const t = setup();
    t.type('same');
    t.bridge.saveDocumentAs.mockResolvedValueOnce('unchanged');
    expect(await t.controller.save()).toBe('unchanged');
    expect(t.notices[0]?.message).toContain('書き込みませんでした');
  });

  it('save as on a clean document still asks for a path', async () => {
    const t = setup();
    await t.controller.openDocument();
    expect(await t.controller.saveAs()).toBe('written');
    expect(t.bridge.saveDocumentAs).toHaveBeenCalledWith('/new.md', 'opened', LF);
    expect(t.controller.getState().path).toBe('/new.md');
  });

  it('save as suggests the current file name', async () => {
    const t = setup();
    await t.controller.openDocument();
    await t.controller.saveAs();
    expect(t.bridge.pickSavePath).toHaveBeenCalledWith('a.md');
  });

  it('save as cancelled leaves everything as it was', async () => {
    const t = setup({ savePath: null });
    t.type('x');
    expect(await t.controller.saveAs()).toBe('cancelled');
    expect(t.controller.getState().path).toBeNull();
    expect(isDirty(t.controller.getState())).toBe(true);
  });

  it('text typed while the save is in flight stays unsaved', async () => {
    const t = setup();
    await t.controller.openDocument();
    t.type('first');
    let release: () => void = () => {};
    t.bridge.saveDocument.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve('written'))),
    );
    const pending = t.controller.save();
    await Promise.resolve();
    t.type('first and more');
    release();
    await pending;
    expect(t.controller.getState().savedText).toBe('first');
    expect(isDirty(t.controller.getState())).toBe(true);
  });

  it('ignores a second command while one is running', async () => {
    const t = setup();
    t.type('x');
    let release: (p: string) => void = () => {};
    t.bridge.pickSavePath.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const first = t.controller.save();
    const second = await t.controller.save();
    expect(second).toBe('noop');
    release('/new.md');
    await first;
    expect(t.bridge.saveDocumentAs).toHaveBeenCalledTimes(1);
  });
});
