import { describe, expect, it, vi } from 'vitest';
import {
  DECLARATION_ONLY_PERMISSIONS,
  PERMISSIONS,
  PLUGIN_API_VERSION,
  createPluginRegistry,
  isDeclaredPermission,
  isPermission,
  type ActionPlugin,
  type DocumentSnapshot,
  type IsolatedPluginHost,
  type IsolatedPluginListener,
  type PermissionGate,
  type PluginManifest,
  type SelectionSnapshot,
} from '.';

// R7: パネル（部品が項目を送る）、権限 document.read（宣言だけで使える）と、本文とカーソルの位置を届ける規則。Worker を動かす仕組みは偽物。

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({ id: 'outline', name: 'アウトライン', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'action', ...over });
const action = (over: Partial<PluginManifest> = {}): ActionPlugin => ({ manifest: manifest(over), source: 'api.registerPanel({})' });

function fakeHost() {
  const listeners = new Map<string, IsolatedPluginListener>();
  const host = {
    start: vi.fn((id: string, _s: string, l: IsolatedPluginListener) => void listeners.set(id, l)),
    run: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    deliverDocument: vi.fn((_id: string, _d: DocumentSnapshot) => true),
    deliverSelection: vi.fn((_id: string, _s: SelectionSnapshot) => true),
  } satisfies IsolatedPluginHost;
  return { host, listener: (id: string) => listeners.get(id)! };
}
const quiet = () => ({ report: vi.fn() });
const doc = (version: number, text = '# a', kind: 'markdown' | 'plain' = 'markdown'): DocumentSnapshot => ({ version, kind, text });
const sel = (version: number, head = 0): SelectionSnapshot => ({ version, anchor: head, head });

/** パネルを持ち、document.read を宣言した部品を、動かし始めたところまで進める。 */
function withOutline(extra: Partial<PluginManifest> = {}) {
  const f = fakeHost();
  const registry = createPluginRegistry([action({ permissions: ['document.read'], ...extra })], { isolation: f.host, ...quiet() });
  const l = f.listener('outline');
  l.onPanel?.({ id: 'outline', title: 'アウトライン' });
  return { ...f, registry, l };
}

describe('the document.read permission is declaration-only', () => {
  it('is not one of the confirmable permissions (the saved set and the native KNOWN_PERMISSIONS stay as they were)', () => {
    expect([...PERMISSIONS]).toEqual(['clipboard.write', 'paths.read']);
    expect(isPermission('document.read')).toBe(false);
    expect([...DECLARATION_ONLY_PERMISSIONS]).toEqual(['document.read']);
    expect(isDeclaredPermission('document.read')).toBe(true);
    expect(isDeclaredPermission('network')).toBe(false);
  });

  it('loads a part that declares only document.read even where there is no permission gate (nothing to confirm)', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ permissions: ['document.read'] })], { isolation: f.host, ...quiet() });
    expect(registry.records[0]).toMatchObject({ id: 'outline', status: 'active' });
  });

  it('still refuses a part that declares a confirmable permission where there is no gate', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ permissions: ['document.read', 'clipboard.write'] })], { isolation: f.host, ...quiet() });
    expect(registry.records[0]!.status).toBe('incompatible');
  });

  it('never asks the gate about it: the gate sees only the confirmable permissions', async () => {
    const f = fakeHost();
    const gate: PermissionGate = { authorize: vi.fn(async () => 'granted' as const) };
    createPluginRegistry([action({ permissions: ['document.read', 'paths.read'] })], { isolation: f.host, permissions: gate, ...quiet() });
    const onCall = f.listener('outline').onCall!;
    await onCall({ method: 'currentPath' });
    expect(gate.authorize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(gate.authorize).mock.calls[0]![1]).toEqual(['paths.read']);
    // document.read だけを宣言した部品は、確認の要る API を呼べない（宣言していない）。
    const g2 = fakeHost();
    const gate2: PermissionGate = { authorize: vi.fn(async () => 'granted' as const) };
    createPluginRegistry([action({ permissions: ['document.read'] })], { isolation: g2.host, permissions: gate2, ...quiet() });
    const refused = await g2.listener('outline').onCall!({ method: 'currentPath' });
    expect(refused).toMatchObject({ ok: false });
    expect(gate2.authorize).not.toHaveBeenCalled();
  });

  it('is not allowed on an editor-tier plugin (permissions are for the isolated tier only)', () => {
    const registry = createPluginRegistry(
      [{ manifest: manifest({ id: 'ed', tier: 'editor', permissions: ['document.read'] }), activate: () => {} }],
      quiet(),
    );
    expect(registry.records[0]!.status).toBe('incompatible');
  });
});

describe('panels', () => {
  it('lists a registered panel (qualified id, title, nothing loaded yet) and replaces the snapshot when items arrive', () => {
    const { registry, l } = withOutline();
    expect(registry.panels).toEqual([{ pluginId: 'outline', id: 'outline.outline', title: 'アウトライン', loaded: false, version: -1, items: [], current: null, empty: null }]);
    const before = registry.panels;
    const listener = vi.fn();
    registry.subscribePanels(listener);
    l.onItems?.({ panel: 'outline', version: 2, items: [{ text: 'a', depth: 0, offset: 0 }], current: 0, empty: '空' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(registry.panels).not.toBe(before);
    expect(registry.panels[0]).toMatchObject({ loaded: true, version: 2, items: [{ text: 'a', depth: 0, offset: 0 }], current: 0, empty: '空' });
  });

  it('does not create a panel for a part that is stopped; a stopped part’s panel disappears and subscribers are told', () => {
    const { registry, l } = withOutline();
    const listener = vi.fn();
    registry.subscribePanels(listener);
    l.onStopped('止めた');
    expect(registry.panels).toEqual([]);
    expect(registry.records[0]).toMatchObject({ status: 'stopped', reason: '止めた' });
    expect(listener).toHaveBeenCalled();
  });

  it('rejects a duplicate panel id (the part is stopped by the host: the listener throws)', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action(), action({ id: 'other' })], { isolation: f.host, ...quiet() });
    f.listener('outline').onPanel?.({ id: 'p', title: 't' });
    f.listener('other').onPanel?.({ id: 'p', title: 't' });
    expect(registry.panels.map((p) => p.id)).toEqual(['outline.p', 'other.p']);
    expect(() => f.listener('outline').onPanel?.({ id: 'p', title: 't' })).toThrow('登録済み');
  });

  it('only a part that is not stopped can update the panel', () => {
    const { registry, l } = withOutline();
    l.onStopped('x');
    l.onItems?.({ panel: 'outline', version: 1, items: [], current: null, empty: null });
    expect(registry.panels).toEqual([]);
  });

  it('a panel needs no permission declaration (a part with no permissions can show a panel)', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action()], { isolation: f.host, ...quiet() });
    f.listener('outline').onPanel?.({ id: 'p', title: 't' });
    expect(registry.panels).toHaveLength(1);
  });
});

describe('who receives the document and the selection', () => {
  it('a part that declared document.read receives them once it is ready and its panel is visible; the latest is delivered then', () => {
    const { registry, host, l } = withOutline();
    registry.publishDocument(doc(1), sel(1));
    // まだ動いていない（ready 前）、パネルが見えていない。
    expect(host.deliverDocument).not.toHaveBeenCalled();
    l.onReady();
    expect(host.deliverDocument).not.toHaveBeenCalled();
    registry.setPanelVisible('outline.outline', true);
    expect(host.deliverDocument).toHaveBeenCalledWith('outline', doc(1));
    expect(host.deliverSelection).toHaveBeenCalledWith('outline', sel(1));
  });

  it('does not deliver while the panel is hidden (sidebar closed or section collapsed), and delivers only the latest when it is shown again', () => {
    const { registry, host, l } = withOutline();
    l.onReady();
    registry.setPanelVisible('outline.outline', true);
    registry.publishDocument(doc(1), sel(1));
    expect(host.deliverDocument).toHaveBeenCalledTimes(1);
    registry.setPanelVisible('outline.outline', false);
    registry.publishDocument(doc(2), sel(2));
    registry.publishDocument(doc(3, '# c'), sel(3));
    registry.publishSelection(sel(3, 2));
    expect(host.deliverDocument).toHaveBeenCalledTimes(1);
    expect(host.deliverSelection).toHaveBeenCalledTimes(1);
    registry.setPanelVisible('outline.outline', true);
    expect(host.deliverDocument).toHaveBeenCalledTimes(2);
    expect(host.deliverDocument).toHaveBeenLastCalledWith('outline', doc(3, '# c'));
    expect(host.deliverSelection).toHaveBeenLastCalledWith('outline', sel(3, 2));
  });

  it('does not deliver the same version twice (hiding and showing again with nothing new sends nothing)', () => {
    const { registry, host, l } = withOutline();
    l.onReady();
    registry.setPanelVisible('outline.outline', true);
    registry.publishDocument(doc(1), sel(1));
    registry.publishDocument(doc(1), sel(1));
    registry.setPanelVisible('outline.outline', false);
    registry.setPanelVisible('outline.outline', true);
    expect(host.deliverDocument).toHaveBeenCalledTimes(1);
    expect(host.deliverSelection).toHaveBeenCalledTimes(1);
  });

  it('delivers a selection change alone (same document version), and a kind change as a new version', () => {
    const { registry, host, l } = withOutline();
    l.onReady();
    registry.setPanelVisible('outline.outline', true);
    registry.publishDocument(doc(1), sel(1));
    registry.publishSelection(sel(1, 5));
    expect(host.deliverDocument).toHaveBeenCalledTimes(1);
    expect(host.deliverSelection).toHaveBeenCalledTimes(2);
    registry.publishDocument(doc(2, '# a', 'plain'), sel(2, 5));
    expect(host.deliverDocument).toHaveBeenLastCalledWith('outline', doc(2, '# a', 'plain'));
  });

  it('a part that did not declare document.read never receives anything', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ id: 'quiet' }), action({ id: 'other', permissions: [] })], { isolation: f.host, ...quiet() });
    for (const id of ['quiet', 'other']) {
      f.listener(id).onPanel?.({ id: 'p', title: 't' });
      f.listener(id).onReady();
      registry.setPanelVisible(`${id}.p`, true);
    }
    registry.publishDocument(doc(1), sel(1));
    registry.publishSelection(sel(1, 3));
    expect(f.host.deliverDocument).not.toHaveBeenCalled();
    expect(f.host.deliverSelection).not.toHaveBeenCalled();
  });

  it('a part with document.read and no panel receives it as soon as it is ready (there is no panel to hide)', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ permissions: ['document.read'] })], { isolation: f.host, ...quiet() });
    registry.publishDocument(doc(1), sel(1));
    f.listener('outline').onReady();
    expect(f.host.deliverDocument).toHaveBeenCalledWith('outline', doc(1));
    registry.publishDocument(doc(2), sel(2));
    expect(f.host.deliverDocument).toHaveBeenCalledTimes(2);
  });

  it('a stopped part receives nothing; only the visible part among two receives', () => {
    const f = fakeHost();
    const registry = createPluginRegistry([action({ permissions: ['document.read'] }), action({ id: 'second', permissions: ['document.read'] })], { isolation: f.host, ...quiet() });
    for (const id of ['outline', 'second']) {
      f.listener(id).onPanel?.({ id: 'p', title: 't' });
      f.listener(id).onReady();
    }
    registry.setPanelVisible('outline.p', true);
    registry.publishDocument(doc(1), sel(1));
    expect(f.host.deliverDocument).toHaveBeenCalledTimes(1);
    expect(f.host.deliverDocument).toHaveBeenCalledWith('outline', doc(1));
    f.listener('outline').onStopped('x');
    registry.publishDocument(doc(2), sel(2));
    expect(f.host.deliverDocument).toHaveBeenCalledTimes(1);
  });

  it('when the host did not deliver (returns false), the same version is tried again at the next publish', () => {
    const { registry, host, l } = withOutline();
    l.onReady();
    registry.setPanelVisible('outline.outline', true);
    host.deliverDocument.mockReturnValueOnce(false);
    registry.publishDocument(doc(1), sel(1));
    expect(host.deliverSelection).not.toHaveBeenCalled();
    registry.publishDocument(doc(1), sel(1));
    expect(host.deliverDocument).toHaveBeenCalledTimes(2);
    expect(host.deliverSelection).toHaveBeenCalledTimes(1);
  });

  it('ignores setPanelVisible for an unknown panel', () => {
    const { registry, host } = withOutline();
    registry.setPanelVisible('nobody.nothing', true);
    registry.publishDocument(doc(1), sel(1));
    expect(host.deliverDocument).not.toHaveBeenCalled();
  });
});
