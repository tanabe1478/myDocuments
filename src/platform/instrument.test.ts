import { describe, expect, it, vi } from 'vitest';
import type { PluginPerf } from '../plugin-api';
import { BridgeError, type DocumentBridge } from './DocumentBridge';
import { MEASURED_BRIDGE_METHODS, bridgeSpanName, instrumentBridge } from './instrument';

// R16: ブリッジの往復を、コマンドの名前ごとの区間として数える包み。引数と戻り値は読まない。appendLog は数えない。

function recordingPerf(enabled = true) {
  const spans: Array<{ name: string; started: number; ended: number | null }> = [];
  let t = 0;
  const perf: PluginPerf = {
    enabled,
    span(name) {
      const entry = { name, started: t, ended: null as number | null };
      spans.push(entry);
      return () => {
        entry.ended = t;
      };
    },
    measure: (_n, fn) => fn(),
    record: () => {},
  };
  return { perf, spans, advance: (ms: number) => (t += ms), setEnabled: (v: boolean) => ((perf as { enabled: boolean }).enabled = v) };
}

/** 実際の形（全メソッドがある）の偽のブリッジ。 */
function fullBridge(): DocumentBridge {
  const names = [
    'pickOpenPath', 'pickSavePath', 'openDocument', 'saveDocument', 'saveDocumentAs', 'checkDocument', 'watchDocument', 'onDocumentChanged',
    'writeDraft', 'listDrafts', 'readDraft', 'deleteDraft', 'loadSession', 'saveSession', 'pickFolderPath', 'openFolder', 'listFolder',
    'createFile', 'createFolder', 'renameEntry', 'trashEntry', 'moveEntry', 'watchFolders', 'onFolderChanged', 'onCloseRequested', 'closeApp',
    'loadPreferences', 'savePreferences', 'pickImagePath', 'importBackgroundImage', 'readBackgroundImage', 'openExternalUrl', 'writeClipboardText',
    'loadPluginPermissions', 'savePluginPermissions', 'setLogging', 'appendLog', 'toggleFullscreen', 'notifyReady',
  ];
  return Object.fromEntries(names.map((n) => [n, vi.fn(async () => `result-of-${n}`)])) as unknown as DocumentBridge;
}

describe('bridgeSpanName', () => {
  it('names the span after the Rust command: the method name in snake case with the bridge. prefix', () => {
    expect(bridgeSpanName('saveDocument')).toBe('bridge.save_document');
    expect(bridgeSpanName('saveDocumentAs')).toBe('bridge.save_document_as');
    expect(bridgeSpanName('writeDraft')).toBe('bridge.write_draft');
    expect(bridgeSpanName('loadPluginPermissions')).toBe('bridge.load_plugin_permissions');
  });

  it('every measured method gives a valid span name (1 to 64 characters of [a-z0-9._-])', () => {
    for (const m of MEASURED_BRIDGE_METHODS) expect(bridgeSpanName(m)).toMatch(/^[a-z0-9._-]{1,64}$/);
  });
});

describe('instrumentBridge', () => {
  it('counts a round trip from the call to the promise settling, under the command name', async () => {
    const r = recordingPerf();
    const inner = fullBridge();
    let release: (v: string) => void = () => {};
    (inner.saveDocument as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<string>((resolve) => (release = resolve)));
    const bridge = instrumentBridge(inner, r.perf);
    const pending = bridge.saveDocument('/p.md', 'text', { bom: false, eol: 'lf', mixedEol: false }, { expectedRevision: null, overwrite: false });
    expect(r.spans).toEqual([{ name: 'bridge.save_document', started: 0, ended: null }]);
    r.advance(12);
    release('saved');
    await expect(pending).resolves.toBe('saved');
    expect(r.spans).toEqual([{ name: 'bridge.save_document', started: 0, ended: 12 }]);
  });

  it('ends the span and rethrows when the command fails (the BridgeError is passed on as it is)', async () => {
    const r = recordingPerf();
    const inner = fullBridge();
    const error = new BridgeError('not-found', 'no such file');
    (inner.openDocument as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
    const bridge = instrumentBridge(inner, r.perf);
    await expect(bridge.openDocument('/missing.md')).rejects.toBe(error);
    expect(r.spans).toEqual([{ name: 'bridge.open_document', started: 0, ended: 0 }]);
  });

  it('passes the arguments and the result through unchanged, and never gives them to the measurement', async () => {
    const r = recordingPerf();
    const inner = fullBridge();
    const bridge = instrumentBridge(inner, r.perf);
    await expect(bridge.writeDraft({ draftId: 'd', path: '/secret/path.md', text: 'SECRET', format: { bom: false, eol: 'lf', mixedEol: false }, baseRevision: null, updatedAt: 1 })).resolves.toBe('result-of-writeDraft');
    expect(inner.writeDraft).toHaveBeenCalledWith(expect.objectContaining({ text: 'SECRET' }));
    expect(JSON.stringify(r.spans)).not.toMatch(/SECRET|secret|path\.md/);
  });

  it('does not count appendLog (the log must not create spans by being written), the dialogs, the subscriptions or the window operations', async () => {
    const r = recordingPerf();
    const bridge = instrumentBridge(fullBridge(), r.perf);
    await bridge.appendLog([]);
    await bridge.pickOpenPath();
    await bridge.pickSavePath('x.md');
    await bridge.pickFolderPath();
    await bridge.pickImagePath();
    await bridge.onDocumentChanged(() => {});
    await bridge.onFolderChanged(() => {});
    await bridge.onCloseRequested(() => {});
    await bridge.toggleFullscreen();
    await bridge.notifyReady();
    expect(r.spans).toEqual([]);
  });

  it('counts every other command of the bridge by its own name', async () => {
    const r = recordingPerf();
    const bridge = instrumentBridge(fullBridge(), r.perf);
    for (const method of MEASURED_BRIDGE_METHODS) await (bridge as unknown as Record<string, () => Promise<unknown>>)[method]!();
    expect(r.spans.map((s) => s.name)).toEqual(MEASURED_BRIDGE_METHODS.map(bridgeSpanName));
    expect(r.spans.every((s) => s.ended !== null)).toBe(true);
  });

  it('while the measurement is disabled, it calls the original at once: no span, no extra promise (the very same promise comes back)', () => {
    const r = recordingPerf(false);
    const inner = fullBridge();
    const promise = Promise.resolve('x');
    (inner.listFolder as unknown as ReturnType<typeof vi.fn>).mockReturnValue(promise);
    const bridge = instrumentBridge(inner, r.perf);
    expect(bridge.listFolder('/f')).toBe(promise);
    expect(r.spans).toEqual([]);
  });

  it('a call made while disabled is not counted even if it settles after enabling; the next call is counted', async () => {
    const r = recordingPerf(false);
    const bridge = instrumentBridge(fullBridge(), r.perf);
    const first = bridge.checkDocument('/a');
    r.setEnabled(true);
    await first;
    expect(r.spans).toEqual([]);
    await bridge.checkDocument('/a');
    expect(r.spans.map((s) => s.name)).toEqual(['bridge.check_document']);
  });

  it('keeps unmeasured members as they are', () => {
    const r = recordingPerf();
    const inner = fullBridge();
    const bridge = instrumentBridge(inner, r.perf);
    expect(bridge.appendLog).toBe(inner.appendLog);
    expect(bridge.pickOpenPath).toBe(inner.pickOpenPath);
  });
});
