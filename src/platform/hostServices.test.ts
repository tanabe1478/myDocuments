import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_API_VERSION, createPluginRegistry, type EditorExtensionEnvironment, type Plugin } from '../plugin-api';
import { LINK_NOT_OPENABLE_MESSAGE, createHostServices } from './hostServices';

function setup(openExternalUrl: (url: string) => Promise<void> = () => Promise.resolve()) {
  const bridge = { openExternalUrl: vi.fn(openExternalUrl) };
  const notify = vi.fn();
  const services = createHostServices({ bridge, notify, isMacPlatform: () => true });
  return { bridge, notify, services };
}

describe('host services: open an external URL (same path the app had for ⌘/Ctrl+click)', () => {
  it('passes an http or https URL to the bridge, and shows no toast', () => {
    const { bridge, notify, services } = setup();
    services.openExternalUrl('https://example.com/a');
    services.openExternalUrl('http://example.com/b');
    expect(bridge.openExternalUrl.mock.calls).toEqual([['https://example.com/a'], ['http://example.com/b']]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('shows the toast "このリンクは開けません" for a URL that cannot be opened, without calling the bridge', () => {
    const { bridge, notify, services } = setup();
    for (const url of ['javascript:alert(1)', './other.md', 'file:///etc/passwd', 'mailto:a@example.com', '', ' https://example.com', 'https:example.com']) {
      services.openExternalUrl(url);
    }
    expect(bridge.openExternalUrl).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(7);
    expect(notify).toHaveBeenCalledWith({ kind: 'info', message: 'このリンクは開けません' });
    expect(LINK_NOT_OPENABLE_MESSAGE).toBe('このリンクは開けません');
  });

  it('shows the same toast when the bridge fails to open it', async () => {
    const { bridge, notify, services } = setup(() => Promise.reject(new Error('open failed')));
    services.openExternalUrl('https://example.com/a');
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://example.com/a');
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify).toHaveBeenCalledWith({ kind: 'info', message: 'このリンクは開けません' });
  });

  it('answers the OS check as given', () => {
    expect(setup().services.isMacPlatform()).toBe(true);
  });
});

describe('a plugin calling the service through the registry reaches the same path', () => {
  const caller: Plugin = {
    manifest: { id: 'caller', name: 'caller', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
    activate(ctx) {
      const flag = ctx.registerSetting<boolean>({ key: 'callerFlag', defaultValue: false, normalize: (r) => r === true });
      ctx.registerEditorExtension({
        setting: flag,
        create: (_v, env) => {
          captured.push(env);
          return [];
        },
      });
    },
  };
  const captured: EditorExtensionEnvironment[] = [];

  it('opens through the bridge, toasts on a URL that is not allowed, and does nothing once the plugin is gone', () => {
    captured.length = 0;
    const { bridge, notify, services } = setup();
    const registry = createPluginRegistry([caller]);
    registry.editorExtensions[0]?.create(false, { textKind: 'markdown', ...services });
    captured[0]?.openExternalUrl('https://example.com/a');
    expect(bridge.openExternalUrl).toHaveBeenCalledWith('https://example.com/a');
    captured[0]?.openExternalUrl('javascript:alert(1)');
    expect(notify).toHaveBeenCalledTimes(1);
    registry.dispose();
    captured[0]?.openExternalUrl('https://example.com/b');
    expect(bridge.openExternalUrl).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
