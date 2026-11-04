import { EditorState } from '@codemirror/state';
import { describe, expect, it, vi } from 'vitest';
import {
  PLUGIN_API_VERSION,
  createPluginRegistry,
  type CommandContext,
  type Plugin,
  type PluginManifest,
  type PluginRegistryOptions,
} from '.';

const ENV = { textKind: 'markdown' } as const;

const manifest = (over: Partial<PluginManifest> = {}): PluginManifest => ({
  id: 'demo',
  name: 'デモ',
  version: '1.0.0',
  apiVersion: PLUGIN_API_VERSION,
  tier: 'editor',
  ...over,
});

const plugin = (activate: Plugin['activate'], over: Partial<PluginManifest> = {}): Plugin => ({ manifest: manifest(over), activate });

/** 記録だけして、console には出さない。 */
function quiet() {
  const report = vi.fn<NonNullable<PluginRegistryOptions['report']>>();
  return { report, options: { report } satisfies PluginRegistryOptions };
}

const ctxStub: CommandContext = { settings: { get: (s) => s.defaultValue, update: () => undefined } };
const keyEvent = (k: string, mods: object = {}) => ({
  key: k,
  code: `Key${k.toUpperCase()}`,
  metaKey: false,
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe('API version check', () => {
  it('is version 0', () => {
    expect(PLUGIN_API_VERSION).toBe(0);
  });

  it('does not load a plugin whose apiVersion differs (newer or older), and records why', () => {
    const { report, options } = quiet();
    const activate = vi.fn();
    const registry = createPluginRegistry(
      [plugin(activate, { id: 'newer', apiVersion: PLUGIN_API_VERSION + 1 }), plugin(activate, { id: 'older', apiVersion: -1 })],
      options,
    );
    expect(activate).not.toHaveBeenCalled();
    expect(registry.records.map((r) => [r.id, r.status])).toEqual([
      ['newer', 'incompatible'],
      ['older', 'incompatible'],
    ]);
    expect(registry.records[0]?.reason).toContain('API の版が合いません');
    expect(report).toHaveBeenCalledWith('warn', expect.stringContaining('newer'));
  });

  it('rejects malformed manifests without throwing', () => {
    const { options } = quiet();
    const bad = [
      { manifest: manifest({ id: 'Bad Id' }), activate: () => {} },
      { manifest: manifest({ name: '' }), activate: () => {} },
      { manifest: manifest({ version: '' }), activate: () => {} },
      { manifest: manifest({ tier: 'view' as unknown as 'editor' }), activate: () => {} },
      { manifest: manifest({ apiVersion: '0' as unknown as number }), activate: () => {} },
      { activate: () => {} } as unknown as Plugin,
      null as unknown as Plugin,
    ];
    const registry = createPluginRegistry(bad, options);
    expect(registry.records).toHaveLength(bad.length);
    expect(registry.records.every((r) => r.status === 'incompatible' && r.reason)).toBe(true);
  });

  it('does not load a second plugin with the same id', () => {
    const { options } = quiet();
    const registry = createPluginRegistry([plugin(() => {}), plugin(() => {})], options);
    expect(registry.records.map((r) => r.status)).toEqual(['active', 'incompatible']);
  });
});

describe('isolation of exceptions', () => {
  it('stops only the plugin whose activate throws, and discards its partial registrations', () => {
    const { report, options } = quiet();
    const registry = createPluginRegistry(
      [
        plugin((ctx) => {
          const s = ctx.registerSetting({ key: 'half', defaultValue: 1, normalize: () => 1 });
          ctx.registerCommand({ id: 'a', title: 'A', shortcut: 'Mod+K', run: () => {} });
          ctx.registerEditorExtension({ setting: s, create: () => [] });
          throw new Error('boom');
        }, { id: 'broken' }),
        plugin((ctx) => {
          const s = ctx.registerSetting({ key: 'fine', defaultValue: true, normalize: (r) => r === true });
          ctx.registerCommand({ id: 'b', title: 'B', shortcut: 'Mod+K', run: () => {} });
          ctx.registerEditorExtension({ setting: s, create: () => [] });
        }, { id: 'healthy' }),
      ],
      options,
    );
    expect(registry.records.map((r) => [r.id, r.status])).toEqual([
      ['broken', 'stopped'],
      ['healthy', 'active'],
    ]);
    expect(registry.records[0]?.reason).toBe('boom');
    expect(registry.settings.map((s) => s.key)).toEqual(['fine']);
    // 止めた部品が持っていたショートカットは、あとの部品が使える。
    expect(registry.commands.map((c) => c.id)).toEqual(['healthy.b']);
    expect(registry.editorExtensions.map((e) => e.pluginId)).toEqual(['healthy']);
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('broken'), expect.any(Error));
  });

  it('stops the plugin when its extension factory throws, and keeps the others working', () => {
    const { options } = quiet();
    const registry = createPluginRegistry(
      [
        plugin((ctx) => {
          const s = ctx.registerSetting({ key: 'bad', defaultValue: false, normalize: (r) => r === true });
          ctx.registerEditorExtension({
            setting: s,
            create: (on) => {
              if (on) throw new Error('create failed');
              return [];
            },
          });
        }, { id: 'bad-ext' }),
        plugin((ctx) => {
          const s = ctx.registerSetting({ key: 'ok', defaultValue: false, normalize: (r) => r === true });
          ctx.registerEditorExtension({ setting: s, create: () => [EditorState.readOnly.of(true)] });
        }, { id: 'ok-ext' }),
      ],
      options,
    );
    const [bad, ok] = registry.editorExtensions;
    expect(bad?.create(false, ENV)).toEqual([]);
    expect(bad?.create(true, ENV)).toEqual([]);
    expect(registry.records[0]).toMatchObject({ id: 'bad-ext', status: 'stopped', reason: 'create failed' });
    // 止めた後は、値に関係なく空。
    expect(bad?.create(false, ENV)).toEqual([]);
    expect(ok?.create(true, ENV)).not.toEqual([]);
    expect(registry.records[1]?.status).toBe('active');
    // 動作中に止めても、設定の定義は残る（保存値を落とさない）。
    expect(registry.settings.map((s) => s.key)).toEqual(['bad', 'ok']);
    expect(registry.editorExtensions.map((e) => e.pluginId)).toEqual(['ok-ext']);
  });

  it('hands the document kind to create, and flags only the registrations that depend on it', () => {
    const { options } = quiet();
    const seen: string[] = [];
    const registry = createPluginRegistry(
      [
        plugin((ctx) => {
          const s = ctx.registerSetting({ key: 'kindy', defaultValue: true, normalize: (r) => r === true });
          ctx.registerEditorExtension({
            setting: s,
            dependsOnTextKind: true,
            create: (_value, env) => {
              seen.push(env.textKind);
              return [];
            },
          });
          const t = ctx.registerSetting({ key: 'plain', defaultValue: true, normalize: (r) => r === true });
          ctx.registerEditorExtension({ setting: t, create: () => [] });
        }),
      ],
      options,
    );
    const [kindy, other] = registry.editorExtensions;
    expect(kindy?.dependsOnTextKind).toBe(true);
    expect(other?.dependsOnTextKind).toBe(false);
    kindy?.create(true, { textKind: 'plain' });
    kindy?.create(true, { textKind: 'markdown' });
    expect(seen).toEqual(['plain', 'markdown']);
  });

  it('stops the plugin when the extension it returns is not a valid CodeMirror extension', () => {
    const { options } = quiet();
    const registry = createPluginRegistry(
      [
        plugin((ctx) => {
          const s = ctx.registerSetting({ key: 'junk', defaultValue: true, normalize: (r) => r === true });
          ctx.registerEditorExtension({ setting: s, create: () => ({ not: 'an extension' }) as never });
        }),
      ],
      options,
    );
    const ext = registry.editorExtensions[0]?.create(true, ENV);
    expect(ext).toEqual([]);
    expect(registry.records[0]?.status).toBe('stopped');
  });

  it('stops the plugin when a command throws, and a normalize that throws falls back to the default', () => {
    const { options } = quiet();
    const registry = createPluginRegistry(
      [
        plugin((ctx) => {
          ctx.registerSetting({
            key: 'flaky',
            defaultValue: 5,
            normalize: () => {
              throw new Error('bad normalize');
            },
          });
          ctx.registerCommand({
            id: 'go',
            title: 'Go',
            shortcut: 'Mod+G',
            run: () => {
              throw new Error('bad command');
            },
          });
        }),
        plugin((ctx) => ctx.registerCommand({ id: 'other', title: 'Other', shortcut: 'Mod+H', run: () => {} }), { id: 'other-plugin' }),
      ],
      options,
    );
    const command = registry.findCommandByKey(keyEvent('g'), false);
    expect(command?.id).toBe('demo.go');
    expect(() => command?.run(ctxStub)).not.toThrow();
    expect(registry.records[0]).toMatchObject({ status: 'stopped', reason: 'bad command' });
    expect(registry.findCommandByKey(keyEvent('g'), false)).toBeNull();
    expect(registry.findCommandByKey(keyEvent('h'), false)?.id).toBe('other-plugin.other');
    expect(registry.settings[0]?.normalize('x')).toBe(5);
  });

  it('rejects invalid registrations by throwing inside activate (so the plugin is stopped)', () => {
    const { options } = quiet();
    const cases: Array<[string, Plugin['activate']]> = [
      ['reserved key', (ctx) => void ctx.registerSetting({ key: 'theme', defaultValue: 1, normalize: () => 1 })],
      ['invalid key', (ctx) => void ctx.registerSetting({ key: 'a-b', defaultValue: 1, normalize: () => 1 })],
      [
        'duplicate key in the same plugin',
        (ctx) => {
          ctx.registerSetting({ key: 'dup', defaultValue: 1, normalize: () => 1 });
          ctx.registerSetting({ key: 'dup', defaultValue: 1, normalize: () => 1 });
        },
      ],
      ['invalid shortcut', (ctx) => ctx.registerCommand({ id: 'x', title: 'X', shortcut: 'T', run: () => {} })],
      [
        'duplicate command id',
        (ctx) => {
          ctx.registerCommand({ id: 'x', title: 'X', run: () => {} });
          ctx.registerCommand({ id: 'x', title: 'X', run: () => {} });
        },
      ],
      ['unknown placement', (ctx) => {
        const s = ctx.registerSetting({ key: 'flag', defaultValue: false, normalize: (r) => r === true });
        ctx.registerSettingsItem({ placement: 'nowhere' as never, order: 1, kind: 'checkbox', setting: s, label: 'x' });
      }],
      ['unknown setting handle', (ctx) => ctx.registerEditorExtension({ setting: { key: 'ghost', defaultValue: 1 }, create: () => [] })],
    ];
    for (const [name, activate] of cases) {
      const registry = createPluginRegistry([plugin(activate)], { ...options, reservedSettingKeys: ['theme'] });
      expect(registry.records[0]?.status, name).toBe('stopped');
      expect(registry.settings, name).toEqual([]);
    }
    const reserved = createPluginRegistry([plugin((ctx) => void ctx.registerSetting({ key: 'mine', defaultValue: 1, normalize: () => 1 }))], {
      ...options,
      reservedSettingKeys: ['mine'],
    });
    expect(reserved.records[0]?.status).toBe('stopped');
  });

  it('refuses a key or a shortcut already used by another plugin', () => {
    const { options } = quiet();
    const registry = createPluginRegistry(
      [
        plugin((ctx) => {
          ctx.registerSetting({ key: 'shared', defaultValue: 1, normalize: () => 1 });
          ctx.registerCommand({ id: 'c', title: 'C', shortcut: 'Mod+Shift+X', run: () => {} });
        }, { id: 'first' }),
        plugin((ctx) => void ctx.registerSetting({ key: 'shared', defaultValue: 2, normalize: () => 2 }), { id: 'second' }),
        plugin((ctx) => ctx.registerCommand({ id: 'c', title: 'C', shortcut: 'Mod+Shift+X', run: () => {} }), { id: 'third' }),
      ],
      options,
    );
    expect(registry.records.map((r) => r.status)).toEqual(['active', 'stopped', 'stopped']);
    expect(registry.settings).toHaveLength(1);
  });
});

describe('registrations', () => {
  const full = plugin((ctx) => {
    const flag = ctx.registerSetting<boolean>({ key: 'flag', defaultValue: false, normalize: (r) => r === true });
    ctx.registerEditorExtension({ setting: flag, create: (on) => (on ? [EditorState.readOnly.of(true)] : []) });
    ctx.registerCommand({
      id: 'toggle',
      title: '切り替え',
      shortcut: 'Mod+Shift+Y',
      ignoreInTextEntry: true,
      run: ({ settings }) => settings.update(flag, (on) => !on),
    });
    ctx.registerSettingsItem({ placement: 'appearance.writingAids', order: 200, kind: 'checkbox', setting: flag, label: 'フラグ' });
    ctx.registerSettingsItem({ placement: 'appearance.writingAids', order: 50, kind: 'checkbox', setting: flag, label: '先頭' });
  });

  it('exposes settings, extensions, commands and settings items to the host', () => {
    const { options } = quiet();
    const registry = createPluginRegistry([full], options);
    expect(registry.records[0]).toMatchObject({ id: 'demo', name: 'デモ', version: '1.0.0', status: 'active', reason: null });
    expect(registry.settings[0]).toMatchObject({ key: 'flag', defaultValue: false });
    expect(registry.settings[0]?.normalize('yes')).toBe(false);
    expect(registry.settings[0]?.normalize(true)).toBe(true);
    expect(registry.editorExtensions[0]).toMatchObject({ pluginId: 'demo', settingKey: 'flag', defaultValue: false });
    expect(registry.editorExtensions[0]?.create(false, ENV)).toEqual([]);
    expect(registry.editorExtensions[0]?.create(true, ENV)).toHaveLength(1);
    expect(registry.commands[0]).toMatchObject({ id: 'demo.toggle', title: '切り替え', ignoreInTextEntry: true });
    expect(registry.settingsItems('appearance.writingAids').map((i) => [i.label, i.order, i.settingKey])).toEqual([
      ['先頭', 50, 'flag'],
      ['フラグ', 200, 'flag'],
    ]);
  });

  it('finds a command by its shortcut (Mod = Cmd on macOS, Ctrl elsewhere) and runs it through the context', () => {
    const { options } = quiet();
    const registry = createPluginRegistry([full], options);
    const update = vi.fn();
    const ctx: CommandContext = { settings: { get: (s) => s.defaultValue, update } };
    const hit = registry.findCommandByKey(keyEvent('Y', { shiftKey: true }), false);
    expect(hit?.id).toBe('demo.toggle');
    hit?.run(ctx);
    expect(update).toHaveBeenCalledOnce();
    expect(registry.findCommandByKey(keyEvent('Y', { shiftKey: true, ctrlKey: false, metaKey: true }), true)?.id).toBe('demo.toggle');
    expect(registry.findCommandByKey(keyEvent('Y'), false)).toBeNull();
    expect(registry.findCommandByKey(keyEvent('Y', { shiftKey: true, isComposing: true }), false)).toBeNull();
  });
});

describe('settings item: radio (choices)', () => {
  const radioPlugin = (over: Record<string, unknown> = {}, id = 'demo', key = 'listMode') =>
    plugin(
      (ctx) => {
        const mode = ctx.registerSetting<string>({ key, defaultValue: 'a', normalize: (r) => (r === 'b' ? 'b' : 'a') });
        ctx.registerSettingsItem({
          placement: 'editing.body',
          order: 100,
          kind: 'radio',
          setting: mode,
          legend: '見出し',
          options: [
            { value: 'a', label: 'エー' },
            { value: 'b', label: 'ビー' },
          ],
          hint: '補足',
          ...over,
        } as never);
      },
      { id },
    );

  it('exposes the item to the host: legend, options, hint, and a radio name made from the setting key by a rule', () => {
    const registry = createPluginRegistry([radioPlugin()], quiet().options);
    expect(registry.records[0]?.status).toBe('active');
    expect(registry.settingsItems('editing.body')).toEqual([
      {
        pluginId: 'demo',
        placement: 'editing.body',
        order: 100,
        kind: 'radio',
        settingKey: 'listMode',
        name: 'list-mode',
        legend: '見出し',
        options: [
          { value: 'a', label: 'エー' },
          { value: 'b', label: 'ビー' },
        ],
        hint: '補足',
      },
    ]);
    expect(registry.settingsItems('appearance.writingAids')).toEqual([]);
  });

  it('makes the radio name by lowercasing and hyphenating the word boundaries of the key (listContinuation -> list-continuation)', () => {
    const names = ['listContinuation', 'a', 'markupDisplay2Mode', 'Plain'].map((key, i) => {
      const registry = createPluginRegistry([radioPlugin({}, `p${i}`, key)], quiet().options);
      return (registry.settingsItems('editing.body')[0] as { name: string }).name;
    });
    expect(names).toEqual(['list-continuation', 'a', 'markup-display2-mode', 'plain']);
  });

  it('treats the hint as optional (null when omitted)', () => {
    const registry = createPluginRegistry([radioPlugin({ hint: undefined })], quiet().options);
    expect(registry.records[0]?.status).toBe('active');
    expect(registry.settingsItems('editing.body')[0]).toMatchObject({ hint: null });
  });

  it('does not keep a reference to the options array it was given', () => {
    const options = [{ value: 'a', label: 'エー' }];
    const registry = createPluginRegistry([radioPlugin({ options })], quiet().options);
    options.push({ value: 'b', label: 'ビー' });
    expect((registry.settingsItems('editing.body')[0] as { options: readonly unknown[] }).options).toHaveLength(1);
  });

  it('rejects invalid radio registrations inside activate (the plugin is stopped and nothing is left behind)', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no legend', { legend: '' }],
      ['no options', { options: [] }],
      ['options is not an array', { options: 'a' }],
      ['an option without a label', { options: [{ value: 'a', label: '' }] }],
      ['a non-string value', { options: [{ value: 1, label: 'x' }] }],
      ['duplicate values', { options: [{ value: 'a', label: 'x' }, { value: 'a', label: 'y' }] }],
      ['a default value that is not among the options', { options: [{ value: 'b', label: 'x' }] }],
      ['a hint that is not a string', { hint: 1 }],
      ['a non-finite order', { order: Number.NaN }],
    ];
    for (const [name, over] of cases) {
      const registry = createPluginRegistry([radioPlugin(over)], quiet().options);
      expect(registry.records[0]?.status, name).toBe('stopped');
      expect(registry.settingsItems('editing.body'), name).toEqual([]);
    }
  });

  it('allows only the kind the placement can draw: a checkbox in editing.body and a radio in writingAids are rejected', () => {
    const wrongCheckbox = plugin((ctx) => {
      const flag = ctx.registerSetting<boolean>({ key: 'flag', defaultValue: false, normalize: (r) => r === true });
      ctx.registerSettingsItem({ placement: 'editing.body', order: 1, kind: 'checkbox', setting: flag, label: 'x' } as never);
    });
    const wrongRadio = radioPlugin({ placement: 'appearance.writingAids' }, 'other', 'otherKey');
    const registry = createPluginRegistry([wrongCheckbox, wrongRadio], quiet().options);
    expect(registry.records.map((r) => r.status)).toEqual(['stopped', 'stopped']);
    expect(registry.records[0]?.reason).toContain('editing.body');
  });

  it('refuses a radio name that another item already uses (keys that differ only in case)', () => {
    const registry = createPluginRegistry([radioPlugin({}, 'one', 'Mode'), radioPlugin({}, 'two', 'mode')], quiet().options);
    expect(registry.records.map((r) => r.status)).toEqual(['active', 'stopped']);
    expect(registry.records[1]?.reason).toContain('mode');
  });

  it('orders items in editing.body by order, then by registration', () => {
    const registry = createPluginRegistry(
      [radioPlugin({ order: 200, legend: '後' }, 'late', 'lateKey'), radioPlugin({ order: 100, legend: '先' }, 'early', 'earlyKey')],
      quiet().options,
    );
    expect(registry.settingsItems('editing.body').map((i) => (i as { legend: string }).legend)).toEqual(['先', '後']);
  });

  it('does not offer the items of a stopped plugin', () => {
    const stopping = plugin(
      (ctx) => {
        const mode = ctx.registerSetting<string>({ key: 'modeKey', defaultValue: 'a', normalize: () => 'a' });
        ctx.registerSettingsItem({ placement: 'editing.body', order: 1, kind: 'radio', setting: mode, legend: 'x', options: [{ value: 'a', label: 'A' }] });
        ctx.registerCommand({
          id: 'boom',
          title: 'Boom',
          shortcut: 'Mod+B',
          run: () => {
            throw new Error('x');
          },
        });
      },
      { id: 'stopping' },
    );
    const registry = createPluginRegistry([stopping], quiet().options);
    expect(registry.settingsItems('editing.body')).toHaveLength(1);
    registry.findCommandByKey(keyEvent('b'), false)?.run(ctxStub);
    expect(registry.settingsItems('editing.body')).toEqual([]);
  });
});

describe('settings.update: an exception in next (N-R2-1)', () => {
  /**
   * ホストの更新の写し。update に渡された next は、すぐには呼ばれず、後で（run が戻った後に）値を渡して呼ばれる。
   * 例外は、呼んだ側（描画の仕組みの中）へ伝わるので、ここでも受け止めずに伝える。
   */
  function deferredHost(initial: number) {
    let value = initial;
    const queue: Array<(current: number) => number> = [];
    const ctx: CommandContext = {
      settings: {
        get: <T,>() => value as T,
        update: <T,>(_setting: unknown, next: (current: T) => T) => void queue.push(next as unknown as (c: number) => number),
      },
    };
    return { ctx, value: () => value, apply: () => queue.splice(0).forEach((next) => (value = next(value))) };
  }

  const counter = (next: (n: number) => number, extra: Plugin['activate'] = () => {}) =>
    plugin((ctx) => {
      const count = ctx.registerSetting<number>({ key: 'count', defaultValue: 0, normalize: (r) => (typeof r === 'number' ? r : 0) });
      ctx.registerCommand({ id: 'go', title: 'Go', shortcut: 'Mod+G', run: ({ settings }) => settings.update(count, next) });
      return extra(ctx);
    });

  it('stops the plugin when next throws (even after run has returned), and leaves the setting at its previous value', () => {
    const { report, options } = quiet();
    const registry = createPluginRegistry(
      [
        counter(() => {
          throw new Error('bad next');
        }),
        plugin((ctx) => ctx.registerCommand({ id: 'other', title: 'Other', shortcut: 'Mod+H', run: () => {} }), { id: 'other-plugin' }),
      ],
      options,
    );
    const host = deferredHost(3);
    registry.findCommandByKey(keyEvent('g'), false)?.run(host.ctx);
    expect(registry.records[0]?.status).toBe('active'); // run は戻った。next はまだ呼ばれていない。
    expect(() => host.apply()).not.toThrow();
    expect(host.value()).toBe(3);
    expect(registry.records[0]).toMatchObject({ status: 'stopped', reason: 'bad next' });
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('「demo」を止めました'), expect.any(Error));
    expect(registry.findCommandByKey(keyEvent('g'), false)).toBeNull();
    expect(registry.findCommandByKey(keyEvent('h'), false)?.id).toBe('other-plugin.other');
  });

  it('also stops the plugin when next throws while run is still running (the host calls it at once)', () => {
    const registry = createPluginRegistry(
      [
        counter(() => {
          throw new Error('now');
        }),
      ],
      quiet().options,
    );
    let value = 7;
    const ctx: CommandContext = { settings: { get: <T,>() => value as T, update: <T,>(_s: unknown, next: (c: T) => T) => void (value = next(value as T) as number) } };
    expect(() => registry.findCommandByKey(keyEvent('g'), false)?.run(ctx)).not.toThrow();
    expect(value).toBe(7);
    expect(registry.records[0]?.status).toBe('stopped');
  });

  it('runs the cleanup of the plugin it stops', () => {
    const cleanup = vi.fn();
    const registry = createPluginRegistry(
      [
        counter(
          () => {
            throw new Error('x');
          },
          () => cleanup,
        ),
      ],
      quiet().options,
    );
    const host = deferredHost(0);
    registry.findCommandByKey(keyEvent('g'), false)?.run(host.ctx);
    host.apply();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('applies a next that does not throw as before (called with the current value, once per call)', () => {
    const next = vi.fn((n: number) => n + 1);
    const registry = createPluginRegistry([counter(next)], quiet().options);
    const host = deferredHost(3);
    registry.findCommandByKey(keyEvent('g'), false)?.run(host.ctx);
    expect(next).not.toHaveBeenCalled();
    host.apply();
    expect(next).toHaveBeenCalledWith(3);
    expect(host.value()).toBe(4);
    expect(registry.records[0]?.status).toBe('active');
  });

  it('does not call next of a plugin that was stopped before the host applied the update (the value stays)', () => {
    const next = vi.fn((n: number) => n + 1);
    const registry = createPluginRegistry([counter(next), plugin(() => {}, { id: 'x' })], quiet().options);
    const host = deferredHost(3);
    registry.findCommandByKey(keyEvent('g'), false)?.run(host.ctx);
    registry.dispose();
    host.apply();
    expect(next).not.toHaveBeenCalled();
    expect(host.value()).toBe(3);
  });

  it('passes get through to the host unchanged', () => {
    let seen: unknown = null;
    const registry = createPluginRegistry(
      [plugin((ctx) => {
        const count = ctx.registerSetting<number>({ key: 'count', defaultValue: 0, normalize: () => 0 });
        ctx.registerCommand({ id: 'read', title: 'Read', shortcut: 'Mod+R', run: ({ settings }) => void (seen = settings.get(count)) });
      })],
      quiet().options,
    );
    registry.findCommandByKey(keyEvent('r'), false)?.run(deferredHost(9).ctx);
    expect(seen).toBe(9);
  });
});

describe('cleanup', () => {
  it('calls the function returned by activate on dispose, and survives its exceptions', () => {
    const { report, options } = quiet();
    const cleanup = vi.fn();
    const registry = createPluginRegistry(
      [
        plugin(() => cleanup, { id: 'a' }),
        plugin(() => () => {
          throw new Error('cleanup failed');
        }, { id: 'b' }),
        plugin(() => cleanup, { id: 'c' }),
      ],
      options,
    );
    registry.dispose();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith('error', expect.stringContaining('b'), expect.any(Error));
    expect(registry.records.every((r) => r.status === 'stopped')).toBe(true);
    expect(registry.commands).toEqual([]);
    registry.dispose();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('runs the cleanup when the plugin is stopped by an exception', () => {
    const { options } = quiet();
    const cleanup = vi.fn();
    const registry = createPluginRegistry(
      [
        plugin((ctx) => {
          ctx.registerCommand({
            id: 'x',
            title: 'X',
            shortcut: 'Mod+J',
            run: () => {
              throw new Error('x');
            },
          });
          return cleanup;
        }),
      ],
      options,
    );
    registry.commands[0]?.run(ctxStub);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('default reporting', () => {
  it('writes to the console when no report function is given', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    createPluginRegistry([plugin(() => {}, { apiVersion: 99 }), plugin(() => { throw new Error('x'); }, { id: 'thrower' })]);
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    warn.mockRestore();
    error.mockRestore();
  });
});
