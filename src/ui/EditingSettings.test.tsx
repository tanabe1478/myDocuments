// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledPlugins } from '../features';
import { PLUGIN_API_VERSION, createPluginRegistry, type Plugin } from '../plugin-api';
import { normalizePreferences, type StoredPreferences } from '../preferences/preferences';
import { EditingSettings } from './EditingSettings';

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

function render(prefs: StoredPreferences, onChange = vi.fn(), settingsItems = registry.settingsItems) {
  act(() => root.render(<EditingSettings prefs={prefs} onChange={onChange} settingsItems={settingsItems} />));
  return onChange;
}

/** 要素の木を、タグ・class・属性・文字の並びにする（属性の並びと React が付ける id の値に左右されない）。 */
function outline(node: Node, ids: Map<string, string> = new Map()): unknown {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  const el = node as HTMLElement;
  const attrs = Array.from(el.attributes)
    .filter((a) => a.name !== 'style' || a.value !== '')
    .map((a) => {
      // useId の値は、対応関係（見出しの id と aria-labelledby が同じ）だけを残す。
      const v = a.name === 'id' || a.name === 'aria-labelledby' ? (ids.get(a.value) ?? ids.set(a.value, `#id${ids.size + 1}`).get(a.value)!) : a.value;
      return `${a.name}=${v}`;
    })
    .sort();
  return [el.tagName.toLowerCase(), ...attrs, ...Array.from(el.childNodes, (c) => outline(c, ids))];
}

const stored = (patch: Record<string, unknown> = {}) => normalizePreferences({ ...patch }, registry.settings);

/** 変更前の EditingSettings.tsx が描いていた DOM（実ブラウザの outerHTML を、同じ並べ方の木にしたもの）。 */
const expectedSection = (checked: 'tight' | 'preserve' | null): unknown => [
  'section',
  'aria-labelledby=#id1',
  'class=settings-section',
  'data-testid=settings-editing',
  ['h3', 'id=#id1', '編集'],
  [
    'fieldset',
    ['legend', 'リストの継続'],
    [
      'div',
      'class=choices',
      [
        'label',
        'class=choice',
        ['input', 'name=list-continuation', ...(checked === 'tight' ? ['checked='] : []), 'type=radio', 'value=tight'],
        '空行を入れない',
      ],
      [
        'label',
        'class=choice',
        ['input', 'name=list-continuation', ...(checked === 'preserve' ? ['checked='] : []), 'type=radio', 'value=preserve'],
        'リストの形に合わせる',
      ],
    ],
    ['p', 'class=hint', '空行で区切ったリストで Enter を押したとき、次の項目の前にも空行を入れるか'],
  ],
];

// 属性（'名前=値' の文字列）を並べ替える（outline が属性を並べ替えるので、期待値も同じ形にする）。
const normalizeExpected = (v: unknown): unknown => {
  if (!Array.isArray(v)) return v;
  const [tag, ...rest] = v as [string, ...unknown[]];
  const attrs = rest.filter((x): x is string => typeof x === 'string' && /^[a-z-]+=/.test(x)).sort();
  const children = rest.filter((x) => !(typeof x === 'string' && /^[a-z-]+=/.test(x)));
  return [tag, ...attrs, ...children.map(normalizeExpected)];
};

describe('the editing section draws the same DOM as before', () => {
  it('default (tight): same elements, classes, test id, legend, radio name and values, labels, order, and hint', () => {
    render(stored());
    const section = container.firstElementChild as HTMLElement;
    expect(outline(section)).toEqual(normalizeExpected(expectedSection('tight')));
  });

  it('preserve: only the checked radio differs', () => {
    render(stored({ listContinuation: 'preserve' }));
    expect(outline(container.firstElementChild as HTMLElement)).toEqual(normalizeExpected(expectedSection('preserve')));
  });

  it('keeps the handles the e2e tests and the verification scenarios use', () => {
    render(stored());
    expect(container.querySelector('section[data-testid="settings-editing"] > h3')?.textContent).toBe('編集');
    const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"][name="list-continuation"]'));
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['tight', true],
      ['preserve', false],
    ]);
    expect(container.querySelector('input[name=list-continuation]:checked')).toBe(radios[0]);
    expect(container.querySelectorAll('section')).toHaveLength(1);
    expect(container.querySelectorAll('fieldset > legend')).toHaveLength(1);
    const section = container.firstElementChild as HTMLElement;
    expect(section.getAttribute('aria-labelledby')).toBe(section.querySelector('h3')?.id);
  });

  it('reports the chosen value as a patch of the stored preferences (same shape as before)', () => {
    const onChange = render(stored());
    const preserve = container.querySelectorAll<HTMLInputElement>('input[name=list-continuation]')[1]!;
    act(() => preserve.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ listContinuation: 'preserve' });
  });
});

describe('a stored value that is not among the choices', () => {
  it('checks none of the radios and does not break (the value is only replaced when a choice is made)', () => {
    // 読み込みでは範囲外の値は既定値になる。ここは、検証を通らない値が渡っても描画が壊れないことの確認。
    render({ ...stored(), listContinuation: 'loose' });
    expect(container.querySelectorAll('input[type=radio]')).toHaveLength(2);
    expect(container.querySelector('input[type=radio]:checked')).toBeNull();
  });

  it('is read as the default by the normal loading path, so the default radio is checked', () => {
    for (const bad of ['loose', '', 'Preserve', 1, null, ['preserve']]) {
      render(stored({ listContinuation: bad }));
      expect((container.querySelector('input[type=radio]:checked') as HTMLInputElement).value, String(bad)).toBe('tight');
    }
  });

  it('a missing key checks none (the stored preferences always carry the key after loading)', () => {
    const { listContinuation: _omit, ...without } = stored();
    render(without as StoredPreferences);
    expect(container.querySelector('input[type=radio]:checked')).toBeNull();
  });
});

describe('the section is generic over the items the plugins put in editing.body', () => {
  const demo: Plugin = {
    manifest: { id: 'demo', name: 'デモ', version: '1.0.0', apiVersion: PLUGIN_API_VERSION, tier: 'editor' },
    activate(ctx) {
      const size = ctx.registerSetting<string>({ key: 'demoSize', defaultValue: 'm', normalize: (r) => (r === 's' || r === 'l' ? r : 'm') });
      ctx.registerSettingsItem({
        placement: 'editing.body',
        order: 50,
        kind: 'radio',
        setting: size,
        legend: 'サイズ',
        options: [
          { value: 's', label: '小' },
          { value: 'm', label: '中' },
          { value: 'l', label: '大' },
        ],
      });
    },
  };
  const both = createPluginRegistry([...bundledPlugins, demo]);
  const bothStored = (patch: Record<string, unknown> = {}) => normalizePreferences(patch, both.settings);

  it('draws the items in order, each in its own fieldset with its own radio name; omits the hint when there is none', () => {
    render(bothStored({ demoSize: 'l' }), vi.fn(), both.settingsItems);
    const fieldsets = Array.from(container.querySelectorAll('fieldset'));
    expect(fieldsets.map((f) => f.querySelector('legend')?.textContent)).toEqual(['サイズ', 'リストの継続']);
    expect(fieldsets[0]?.querySelector('p.hint')).toBeNull();
    expect(fieldsets[1]?.querySelector('p.hint')).not.toBeNull();
    expect(fieldsets[0]?.querySelectorAll<HTMLInputElement>('input[name=demo-size]')).toHaveLength(3);
    const checked = Array.from(container.querySelectorAll<HTMLInputElement>('input:checked'), (i) => [i.name, i.value]);
    expect(checked).toEqual([
      ['demo-size', 'l'],
      ['list-continuation', 'tight'],
    ]);
  });

  it('shows only the heading when no plugin puts an item in the section', () => {
    render(stored(), vi.fn(), createPluginRegistry([]).settingsItems);
    expect(container.querySelector('h3')?.textContent).toBe('編集');
    expect(container.querySelectorAll('fieldset')).toHaveLength(0);
  });
});
