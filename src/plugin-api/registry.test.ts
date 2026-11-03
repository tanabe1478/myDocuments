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
    expect(bad?.create(false)).toEqual([]);
    expect(bad?.create(true)).toEqual([]);
    expect(registry.records[0]).toMatchObject({ id: 'bad-ext', status: 'stopped', reason: 'create failed' });
    // 止めた後は、値に関係なく空。
    expect(bad?.create(false)).toEqual([]);
    expect(ok?.create(true)).not.toEqual([]);
    expect(registry.records[1]?.status).toBe('active');
    // 動作中に止めても、設定の定義は残る（保存値を落とさない）。
    expect(registry.settings.map((s) => s.key)).toEqual(['bad', 'ok']);
    expect(registry.editorExtensions.map((e) => e.pluginId)).toEqual(['ok-ext']);
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
    const ext = registry.editorExtensions[0]?.create(true);
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
    expect(registry.editorExtensions[0]?.create(false)).toEqual([]);
    expect(registry.editorExtensions[0]?.create(true)).toHaveLength(1);
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
