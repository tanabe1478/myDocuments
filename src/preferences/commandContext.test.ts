import { describe, expect, it } from 'vitest';
import type { SettingDefinition, SettingHandle } from '../plugin-api';
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
function fakeStore(start: StoredPreferences) {
  let rendered = start;
  const queue: Array<(prev: StoredPreferences) => StoredPreferences> = [];
  return {
    read: () => rendered,
    set: (update: (prev: StoredPreferences) => StoredPreferences) => void queue.push(update),
    render: () => {
      for (const update of queue.splice(0)) rendered = update(rendered);
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
