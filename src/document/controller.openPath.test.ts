import { describe, expect, it } from 'vitest';
import { BridgeError } from '../platform';
import { isDirty } from './state';
import { setup } from './testKit';

// エクスプローラーから、ダイアログを経由せずにパスを指定して開く。
describe('openPath', () => {
  const files = { '/a.md': 'first', '/b.md': 'second', '/notes.txt': 'plain' };

  it('opens the file without showing the open dialog, watches it and remembers it as the last document', async () => {
    const t = setup({ files });
    expect(await t.controller.openPath('/b.md')).toBe(true);
    expect(t.bridge.pickOpenPath).not.toHaveBeenCalled();
    expect(t.editor()).toBe('second');
    expect(t.controller.getState().path).toBe('/b.md');
    expect(t.bridge.watchDocument).toHaveBeenLastCalledWith('/b.md');
    expect(t.session().lastPath).toBe('/b.md');
  });

  it('asks before replacing unsaved changes, and keeps the current document on cancel', async () => {
    const t = setup({ files, confirm: 'cancel' });
    await t.controller.openPath('/a.md');
    t.type('unsaved');
    expect(await t.controller.openPath('/b.md')).toBe(false);
    expect(t.confirmDiscard).toHaveBeenCalledWith('a.md');
    expect(t.controller.getState().path).toBe('/a.md');
    expect(t.editor()).toBe('unsaved');
    expect(isDirty(t.controller.getState())).toBe(true);
  });

  it('opens after discarding, and after saving', async () => {
    const discard = setup({ files, confirm: 'discard' });
    await discard.controller.openPath('/a.md');
    discard.type('unsaved');
    expect(await discard.controller.openPath('/b.md')).toBe(true);
    expect(discard.editor()).toBe('second');
    expect(discard.files.get('/a.md')).toBe('first');

    const save = setup({ files, confirm: 'save' });
    await save.controller.openPath('/a.md');
    save.type('edited');
    expect(await save.controller.openPath('/b.md')).toBe(true);
    expect(save.files.get('/a.md')).toBe('edited');
    expect(save.editor()).toBe('second');
  });

  it('does nothing for the document that is already open, so edits are not thrown away', async () => {
    const t = setup({ files, confirm: 'discard' });
    await t.controller.openPath('/a.md');
    t.type('unsaved');
    expect(await t.controller.openPath('/a.md')).toBe(true);
    expect(t.confirmDiscard).not.toHaveBeenCalled();
    expect(t.editor()).toBe('unsaved');
  });

  it('reports an error and keeps the document when the file cannot be read', async () => {
    const t = setup({ files });
    await t.controller.openPath('/a.md');
    t.bridge.openDocument.mockRejectedValueOnce(new BridgeError('not-utf8', 'x'));
    expect(await t.controller.openPath('/b.md')).toBe(false);
    expect(t.notices.at(-1)?.message).toContain('UTF-8');
    expect(t.controller.getState().path).toBe('/a.md');
  });

  it('does nothing while another operation is running (for example a confirmation dialog)', async () => {
    const t = setup({ files });
    await t.controller.openPath('/a.md');
    t.type('unsaved');
    let answer: (c: 'discard') => void = () => {};
    t.confirmDiscard.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve as typeof answer)));
    const first = t.controller.openPath('/b.md');
    expect(await t.controller.openPath('/notes.txt')).toBe(false);
    answer('discard');
    expect(await first).toBe(true);
    expect(t.controller.getState().path).toBe('/b.md');
  });
});
