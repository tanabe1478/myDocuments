import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_API_VERSION, createPluginRegistry, type Plugin, type SettingDefinition, type SettingHandle } from '../plugin-api';
import { createCommandContext, updateStoredSetting } from './commandContext';
import { DEFAULT_PREFERENCES, type StoredPreferences } from './preferences';

const count: SettingDefinition<number> = {
  key: 'demoCount',
  defaultValue: 0,
  normalize: (raw) => (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : 0),
};
const flag: SettingDefinition<boolean> = { key: 'demoFlag', defaultValue: false, normalize: (raw) => raw === true };
const definitions = [count, flag] as SettingDefinition<unknown>[];
const countHandle: SettingHandle<number> = { key: count.key, defaultValue: 0 };
const flagHandle: SettingHandle<boolean> = { key: flag.key, defaultValue: false };

const initial = (): StoredPreferences => ({ ...DEFAULT_PREFERENCES, demoCount: 0, demoFlag: false });

/**
 * React の state の更新の写し。setPrefs に渡した更新関数は、すぐには適用されず、次の描画でまとめて、渡した順に適用される。
 * 描画までの間、readPrefs は描画済みの値（更新前）を返し続ける。
 */
function fakeStore(start: StoredPreferences, options: { strict?: boolean } = {}) {
  let rendered = start;
  const queue: Array<(prev: StoredPreferences) => StoredPreferences> = [];
  return {
    read: () => rendered,
    set: (update: (prev: StoredPreferences) => StoredPreferences) => void queue.push(update),
    render: () => {
      // strict: 開発ビルドの StrictMode のように、更新関数を同じ直前の値で 2 回呼び、あとの結果を使う。
      for (const update of queue.splice(0)) {
        if (options.strict) update(rendered);
        rendered = update(rendered);
      }
      return rendered;
    },
  };
}

describe('settings.update (N1: computed from the previous value, not from the rendered one)', () => {
  it('applies two updates made in the same tick, both of them', () => {
    const store = fakeStore(initial());
    const ctx = createCommandContext(store.read, store.set, definitions);
    ctx.settings.update(countHandle, (n) => n + 1);
    ctx.settings.update(countHandle, (n) => n + 1);
    expect(store.read().demoCount).toBe(0);
    expect(store.render().demoCount).toBe(2);
  });

  it('applies updates to different settings made in the same tick, without losing either', () => {
    const store = fakeStore(initial());
    const ctx = createCommandContext(store.read, store.set, definitions);
    ctx.settings.update(flagHandle, (on) => !on);
    ctx.settings.update(countHandle, (n) => n + 3);
    const after = store.render();
    expect(after).toMatchObject({ demoFlag: true, demoCount: 3 });
  });

  it('two toggles in the same tick cancel out (each sees the result of the one before)', () => {
    const store = fakeStore(initial());
    const ctx = createCommandContext(store.read, store.set, definitions);
    ctx.settings.update(flagHandle, (on) => !on);
    ctx.settings.update(flagHandle, (on) => !on);
    expect(store.render().demoFlag).toBe(false);
  });

  it('still validates the result with the setting definition (an out-of-range value falls back to the default)', () => {
    const store = fakeStore({ ...initial(), demoCount: 5 });
    const ctx = createCommandContext(store.read, store.set, definitions);
    ctx.settings.update(countHandle, (n) => n + 1);
    expect(store.render().demoCount).toBe(0);
  });

  it('does not call the update function until the state is applied, and passes the previous value to it', () => {
    const store = fakeStore({ ...initial(), demoCount: 2 });
    const ctx = createCommandContext(store.read, store.set, definitions);
    const seen: number[] = [];
    ctx.settings.update(countHandle, (n) => (seen.push(n), n + 1));
    expect(seen).toEqual([]);
    store.render();
    expect(seen).toEqual([2]);
  });

  it('leaves the other items of the stored preferences as they were', () => {
    const start = { ...initial(), theme: 'dark', fontSizePx: 22 } as StoredPreferences;
    const store = fakeStore(start);
    createCommandContext(store.read, store.set, definitions).settings.update(flagHandle, () => true);
    expect(store.render()).toEqual({ ...start, demoFlag: true });
  });
});

describe('settings.get', () => {
  it('reads the rendered value, and falls back to the default when the key is missing', () => {
    const store = fakeStore(initial());
    const ctx = createCommandContext(store.read, store.set, definitions);
    expect(ctx.settings.get(countHandle)).toBe(0);
    ctx.settings.update(countHandle, () => 4);
    expect(ctx.settings.get(countHandle)).toBe(0);
    store.render();
    expect(ctx.settings.get(countHandle)).toBe(4);
    expect(ctx.settings.get({ key: 'unknownKey', defaultValue: 'x' })).toBe('x');
  });
});

describe('updateStoredSetting', () => {
  it('is a pure function of the previous preferences', () => {
    const before = initial();
    const after = updateStoredSetting(before, countHandle, (n) => n + 1, definitions);
    expect(after.demoCount).toBe(1);
    expect(before.demoCount).toBe(0);
    expect(updateStoredSetting(after, countHandle, (n) => n + 1, definitions).demoCount).toBe(2);
  });
});

describe('an exception in next, through the registry (N-R2-1)', () => {
  const key = (k: string) => ({ key: k, code: `Key${k.toUpperCase()}`, metaKey: false, ctrlKey: true, altKey: false, shiftKey: false });

  /** 本体の経路（createCommandContext と、React の更新の写し）の上で、部品のコマンドを実行する。 */
  function setup(next: (n: number) => number, options: { strict?: boolean } = {}) {
    const demo: Plugin = {
      manifest: { id: 'demo', name: 'デモ', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
      activate(ctx) {
        const handle = ctx.registerSetting<number>(count);
        ctx.registerCommand({ id: 'go', title: 'Go', shortcut: 'Mod+G', run: ({ settings }) => settings.update(handle, next) });
        ctx.registerCommand({ id: 'bump', title: 'Bump', shortcut: 'Mod+B', run: ({ settings }) => settings.update(handle, (n) => n + 1) });
      },
    };
    const report = vi.fn();
    const registry = createPluginRegistry([demo], { report });
    const store = fakeStore({ ...initial(), demoCount: 2 }, options);
    const ctx = createCommandContext(store.read, store.set, registry.settings);
    const run = (k: string) => registry.findCommandByKey(key(k), false)?.run(ctx);
    return { registry, store, run, report };
  }

  it('stops the plugin and keeps the previous value; the render that applies the update does not throw', () => {
    const { registry, store, run, report } = setup(() => {
      throw new Error('bad next');
    });
    run('g');
    expect(() => store.render()).not.toThrow();
    expect(store.read().demoCount).toBe(2);
    expect(registry.records[0]).toMatchObject({ status: 'stopped', reason: 'bad next' });
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('止めました'), expect.any(Error));
  });

  it('keeps the other items of the stored preferences as they were', () => {
    const { store, run } = setup(() => {
      throw new Error('bad next');
    });
    const before = store.read();
    run('g');
    expect(store.render()).toEqual(before);
  });

  it('a throwing update in the same tick does not cancel the others that were queued before it', () => {
    const { registry, store, run } = setup(() => {
      throw new Error('bad next');
    });
    run('b');
    run('g');
    // 先に積んだ更新は、止める前なので効く。止めた後の更新は何もしない。
    expect(store.render().demoCount).toBe(3);
    run('b');
    expect(store.render().demoCount).toBe(3);
    expect(registry.records[0]?.status).toBe('stopped');
  });

  it('a pure next gives the same result when the host calls it twice (StrictMode), and is called with the previous value each time', () => {
    const next = vi.fn((n: number) => n + 1);
    const { store, run } = setup(next, { strict: true });
    run('g');
    expect(store.render().demoCount).toBe(3);
    expect(next.mock.calls).toEqual([[2], [2]]);
  });

  it('stops the plugin once even when the host calls the throwing next twice (StrictMode)', () => {
    const { registry, store, run, report } = setup(() => {
      throw new Error('twice');
    }, { strict: true });
    run('g');
    expect(() => store.render()).not.toThrow();
    expect(store.read().demoCount).toBe(2);
    expect(registry.records[0]?.status).toBe('stopped');
    expect(report).toHaveBeenCalledTimes(1);
  });
});

describe('updateStoredSetting with an unchanged value', () => {
  it('returns the previous preferences themselves (no validation again, no new object)', () => {
    const before = initial();
    expect(updateStoredSetting(before, countHandle, (n) => n, definitions)).toBe(before);
    expect(updateStoredSetting(before, flagHandle, () => false, definitions)).toBe(before);
  });
});
