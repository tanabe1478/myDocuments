// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledPlugins } from '../features';
import { createPluginRegistry } from '../plugin-api';
import { normalizePreferences, type StoredPreferences } from '../preferences/preferences';
import { SoundSettings } from './SoundSettings';

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
});

const registry = createPluginRegistry(bundledPlugins);
const stored = (patch: Record<string, unknown> = {}): StoredPreferences => normalizePreferences({ ...patch }, registry.settings);

function render(prefs: StoredPreferences, onChange = vi.fn(), settingsItems = registry.settingsItems) {
  act(() => root.render(<SoundSettings prefs={prefs} onChange={onChange} settingsItems={settingsItems} />));
  return onChange;
}

describe('SoundSettings (the 音 section)', () => {
  it('has a heading 音, the timbre radios (キーボード・タイプライター) before the volume radios 小・中・大, with キーボード and 中 selected by default', () => {
    render(stored());
    const section = container.querySelector('section')!;
    expect(section.getAttribute('data-testid')).toBe('settings-sound');
    expect(section.querySelector('h3')?.textContent).toBe('音');
    expect(section.getAttribute('aria-labelledby')).toBe(section.querySelector('h3')?.id);
    const radios = Array.from(section.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios.map((r) => [r.name, r.value, r.checked, r.closest('label')?.textContent])).toEqual([
      ['typing-sound-timbre', 'keyboard', true, 'キーボード'],
      ['typing-sound-timbre', 'typewriter', false, 'タイプライター'],
      ['typing-sound-volume', 'low', false, '小'],
      ['typing-sound-volume', 'medium', true, '中'],
      ['typing-sound-volume', 'high', false, '大'],
    ]);
    expect(Array.from(section.querySelectorAll('legend')).map((l) => l.textContent)).toEqual(['タイピング音の音色', 'タイピング音の大きさ']);
  });

  it('selects the saved values', () => {
    render(stored({ typingSoundVolume: 'high', typingSoundTimbre: 'typewriter' }));
    const checked = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter((r) => r.checked);
    expect(checked.map((r) => r.value)).toEqual(['typewriter', 'high']);
  });

  it('shows キーボード for an unknown saved timbre', () => {
    render(stored({ typingSoundTimbre: 'piano' }));
    const checked = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]')).filter((r) => r.checked);
    expect(checked.map((r) => r.value)).toEqual(['keyboard', 'medium']);
  });

  it('reports a timbre change as a patch of the setting key', () => {
    const onChange = render(stored());
    const typewriter = container.querySelector<HTMLInputElement>('input[value="typewriter"]')!;
    act(() => typewriter.click());
    expect(onChange).toHaveBeenCalledWith({ typingSoundTimbre: 'typewriter' });
  });

  it('reports a change as a patch of the setting key', () => {
    const onChange = render(stored());
    const low = container.querySelector<HTMLInputElement>('input[value="low"]')!;
    act(() => low.click());
    expect(onChange).toHaveBeenCalledWith({ typingSoundVolume: 'low' });
  });

  it('renders nothing when no plugin put an item there', () => {
    const empty = createPluginRegistry([]);
    render(stored(), vi.fn(), empty.settingsItems);
    expect(container.innerHTML).toBe('');
  });
});
