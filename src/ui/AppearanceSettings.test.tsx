// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledPlugins } from '../features';
import { HOST_APPEARANCE_ORDER, PLUGIN_API_VERSION, createPluginRegistry, type Plugin } from '../plugin-api';
import { normalizePreferences, type StoredPreferences } from '../preferences/preferences';
import { AppearanceSettings } from './AppearanceSettings';

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

const bundled = createPluginRegistry(bundledPlugins);
const stored = (registry = bundled, patch: Record<string, unknown> = {}) => normalizePreferences({ ...patch }, registry.settings);

function render(prefs: StoredPreferences, settingsItems = bundled.settingsItems, onChange = vi.fn()) {
  act(() =>
    root.render(
      <AppearanceSettings
        prefs={prefs}
        mode="light"
        contrast={{ ratio: 7.5, belowAA: false }}
        lineChars={30}
        imageStatus="none"
        onChange={onChange}
        onPickImage={() => {}}
        settingsItems={settingsItems}
      />,
    ),
  );
  return onChange;
}

const legends = () => Array.from(container.querySelectorAll('section > fieldset > legend'), (l) => l.textContent);

// 変更前の AppearanceSettings.tsx が、実ブラウザで描いていた fieldset の並び（verify-mydocuments の before の記録と同じ）。
const BEFORE_LEGENDS = ['フォント', '文字組み', '紙の幅', '記号の表示', 'テーマ', '背景', '文字と本文面のコントラスト', '執筆の補助'];

describe('the appearance section keeps the order of the fieldsets it had before the Markdown plugin', () => {
  it('draws 記号の表示 between 紙の幅 and テーマ, and every other fieldset where it was', () => {
    render(stored());
    expect(legends()).toEqual(BEFORE_LEGENDS);
  });

  it('keeps the radio name, values and the checked one of 記号の表示, and the hint', () => {
    render(stored(bundled, { markupDisplay: 'always' }));
    const group = Array.from(container.querySelectorAll('fieldset')).find((f) => f.querySelector('legend')?.textContent === '記号の表示')!;
    expect(Array.from(group.querySelectorAll<HTMLInputElement>('input[type=radio]'), (r) => [r.name, r.value, r.checked])).toEqual([
      ['markup-display', 'cursorLine', false],
      ['markup-display', 'always', true],
    ]);
    expect(Array.from(group.querySelectorAll('.choices > label.choice'), (l) => l.textContent)).toEqual(['カーソルのある行だけ', '常に表示']);
    expect(group.querySelector('p.hint')?.textContent).toContain('Markdown の # や * などの記号を、どの行で見せるか。');
    // 全体の構造: section の直下に h3 と fieldset だけ（ラッパーの要素を足さない）。
    const section = container.querySelector('section[data-testid="settings-appearance"]')!;
    expect(Array.from(section.children, (c) => c.tagName.toLowerCase())).toEqual(['h3', ...BEFORE_LEGENDS.map(() => 'fieldset')]);
  });

  it('reports the chosen value as a patch of the stored preferences, under the same key as before', () => {
    const onChange = render(stored());
    const always = container.querySelector<HTMLInputElement>('input[name=markup-display][value=always]')!;
    act(() => always.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ markupDisplay: 'always' });
  });

  it('the checked radio follows the stored value (a value outside the choices checks none)', () => {
    render({ ...stored(), markupDisplay: 'hidden' });
    expect(container.querySelector('input[name=markup-display]:checked')).toBeNull();
  });
});

describe('without the Markdown plugin, the host knows nothing of 記号の表示', () => {
  it('does not draw the fieldset (the host has no such setting any more)', () => {
    const without = createPluginRegistry(bundledPlugins.filter((p) => p.manifest.id !== 'markdown'));
    render(stored(without), without.settingsItems);
    expect(legends()).toEqual(BEFORE_LEGENDS.filter((l) => l !== '記号の表示'));
    expect(container.querySelector('input[name=markup-display]')).toBeNull();
  });
});

describe('the order scale shared with the host fieldsets', () => {
  const demo = (order: number, id: string): Plugin => ({
    manifest: { id, name: id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
    activate(ctx) {
      const key = `${id.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Mode`;
      const setting = ctx.registerSetting<string>({ key, defaultValue: 'a', normalize: (r) => (r === 'b' ? 'b' : 'a') });
      ctx.registerSettingsItem({
        placement: 'appearance.body',
        order,
        kind: 'radio',
        setting,
        legend: `デモ ${id}`,
        options: [
          { value: 'a', label: 'エー' },
          { value: 'b', label: 'ビー' },
        ],
      });
    },
  });

  it('puts a plugin item first, last, or between host fieldsets by its order', () => {
    const registry = createPluginRegistry([...bundledPlugins, demo(50, 'first'), demo(HOST_APPEARANCE_ORDER.writingAids + 1, 'last'), demo(HOST_APPEARANCE_ORDER.contrast + 50, 'late')]);
    render(stored(registry), registry.settingsItems);
    expect(legends()).toEqual([
      'デモ first',
      'フォント',
      '文字組み',
      '紙の幅',
      '記号の表示',
      'テーマ',
      '背景',
      '文字と本文面のコントラスト',
      'デモ late',
      '執筆の補助',
      'デモ last',
    ]);
  });

  it('puts a host fieldset before a plugin item with the same order', () => {
    const registry = createPluginRegistry([demo(HOST_APPEARANCE_ORDER.theme, 'same')]);
    render(stored(registry), registry.settingsItems);
    expect(legends().slice(legends().indexOf('テーマ'), legends().indexOf('テーマ') + 2)).toEqual(['テーマ', 'デモ same']);
  });

  it('scales the host fieldsets by 100 in the order they are drawn', () => {
    expect(Object.values(HOST_APPEARANCE_ORDER)).toEqual([100, 200, 300, 400, 500, 600, 700]);
  });
});
