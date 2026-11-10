import { describe, expect, it } from 'vitest';
import type { PluginPerf } from '../plugin-api';
import { BridgeError } from '../platform';
import { setup } from './testKit';

// R16: 保存（document.save）と草稿の書き込み（document.draft-write）の区間。ダイアログと確認の待ちは含めない。

function recordingPerf(enabled = true) {
  const started: string[] = [];
  const ended: string[] = [];
  const perf: PluginPerf = {
    enabled,
    span: (name) => {
      started.push(name);
      return () => void ended.push(name);
    },
    measure: (_n, fn) => fn(),
    record: () => {},
  };
  return { perf, started, ended };
}

describe('document.save', () => {
  it('counts a save of an existing file from the bridge call to the applied result', async () => {
    const r = recordingPerf();
    const t = setup({ perf: r.perf, files: { '/a.md': 'old' } });
    await t.controller.openPath('/a.md');
    t.type('new');
    expect(await t.controller.save()).toBe('written');
    expect(r.started).toEqual(['document.save']);
    expect(r.ended).toEqual(['document.save']);
  });

  it('counts save-as after the dialog (the wait for the dialog is not included)', async () => {
    const r = recordingPerf();
    const t = setup({ perf: r.perf, savePath: '/new.md' });
    t.type('text');
    let spansDuringDialog: string[] = [];
    t.bridge.pickSavePath.mockImplementationOnce(async () => {
      spansDuringDialog = [...r.started];
      return '/new.md';
    });
    await t.controller.saveAs();
    expect(spansDuringDialog).toEqual([]);
    expect(r.started).toEqual(['document.save']);
    expect(r.ended).toEqual(['document.save']);
  });

  it('ends the span when the save fails', async () => {
    const r = recordingPerf();
    const t = setup({ perf: r.perf, files: { '/a.md': 'old' } });
    await t.controller.openPath('/a.md');
    t.type('new');
    t.bridge.saveDocument.mockRejectedValueOnce(new BridgeError('io', 'disk full'));
    expect(await t.controller.save()).toBe('failed');
    expect(r.ended).toEqual(['document.save']);
  });

  it('does not count a save that has nothing to write, nor when there is no perf', async () => {
    const r = recordingPerf();
    const t = setup({ perf: r.perf, files: { '/a.md': 'old' } });
    await t.controller.openPath('/a.md');
    expect(await t.controller.save()).toBe('noop');
    expect(r.started).toEqual([]);
    const plain = setup({ files: { '/a.md': 'old' } });
    await plain.controller.openPath('/a.md');
    plain.type('x');
    await expect(plain.controller.save()).resolves.toBe('written');
  });
});

describe('document.draft-write', () => {
  it('counts the draft write that follows an edit (after the draft delay), around the bridge call only', async () => {
    const r = recordingPerf();
    const t = setup({ perf: r.perf });
    t.type('typed');
    expect(r.started).toEqual([]);
    t.timers.advance(2000);
    await t.settle();
    expect(t.bridge.writeDraft).toHaveBeenCalledTimes(1);
    expect(r.started).toEqual(['document.draft-write']);
    expect(r.ended).toEqual(['document.draft-write']);
  });

  it('ends the span when the draft write fails', async () => {
    const r = recordingPerf();
    const t = setup({ perf: r.perf });
    t.bridge.writeDraft.mockRejectedValueOnce(new BridgeError('io', 'no space'));
    t.type('typed');
    t.timers.advance(2000);
    await t.settle();
    expect(r.ended).toEqual(['document.draft-write']);
    expect(t.notices).toHaveLength(1);
  });
});
