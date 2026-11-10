// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledPlugins } from '../features';
import { createPluginRegistry } from '../plugin-api';
import { normalizePreferences, type StoredPreferences } from '../preferences/preferences';
import { DiagnosticsSettings, MAC_LOG_DIRECTORY } from './DiagnosticsSettings';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const registry = createPluginRegistry(bundledPlugins);
const stored = (patch: Record<string, unknown> = {}): StoredPreferences => normalizePreferences({ ...patch }, registry.settings);

function render(prefs: StoredPreferences, onChange = vi.fn()) {
  act(() => root.render(<DiagnosticsSettings prefs={prefs} onChange={onChange} />));
  return onChange;
}

const checkbox = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

describe('DiagnosticsSettings (the 診断 section)', () => {
  it('is a section with the heading 診断 and one checkbox 「ログを記録する」, off by default', () => {
    render(stored());
    const section = container.querySelector('section')!;
    expect(section.getAttribute('data-testid')).toBe('settings-diagnostics');
    expect(section.className).toBe('settings-section');
    expect(section.querySelector('h3')?.textContent).toBe('診断');
    expect(section.getAttribute('aria-labelledby')).toBe(section.querySelector('h3')?.id);
    expect(container.querySelectorAll('input')).toHaveLength(1);
    expect(checkbox().closest('label')?.textContent).toBe('ログを記録する');
    expect(checkbox().checked).toBe(false);
  });

  it('shows the state of the setting', () => {
    render(stored({ appLog: true }));
    expect(checkbox().checked).toBe(true);
  });

  it('reports a change as { appLog: boolean } (and nothing else)', () => {
    const onChange = render(stored());
    act(() => checkbox().click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ appLog: true });
    const off = render(stored({ appLog: true }), vi.fn());
    act(() => checkbox().click());
    expect(off).toHaveBeenCalledWith({ appLog: false });
  });

  it('says where the file is (macOS path) and that the written file stays after turning off', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac' });
    render(stored());
    const text = container.textContent ?? '';
    expect(MAC_LOG_DIRECTORY).toBe('~/Library/Logs/io.github.tanabe1478.immersive-markdown-editor/');
    expect(text).toContain(MAC_LOG_DIRECTORY);
    expect(text).toContain('オフにしても、書いたファイルは残ります');
    expect(text).toContain('本文とファイルのパスは書きません');
  });

  it('uses a generic place on other OSes instead of the macOS path', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' });
    render(stored());
    const text = container.textContent ?? '';
    expect(text).not.toContain('~/Library/Logs');
    expect(text).toContain('OS のログのフォルダ');
    expect(text).toContain('オフにしても、書いたファイルは残ります');
  });
});
