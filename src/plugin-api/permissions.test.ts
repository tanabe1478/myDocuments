import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, isPermission, normalizePermissionsFile } from './permissions';

describe('permissions', () => {
  it('has the two permissions, each with a description', () => {
    expect([...PERMISSIONS]).toEqual(['clipboard.write', 'paths.read']);
    expect(PERMISSION_DESCRIPTIONS['clipboard.write']).toBe('文字列をクリップボードに書き込む');
    expect(PERMISSION_DESCRIPTIONS['paths.read']).toBe('開いている文書と、ツリーで選んだ項目のパスを知る');
    expect(isPermission('paths.read')).toBe(true);
    for (const bad of ['network', 'Paths.Read', '', 5, null, undefined]) expect(isPermission(bad), String(bad)).toBe(false);
  });
});

describe('normalizePermissionsFile', () => {
  it('keeps a valid file', () => {
    const file = { version: 1, plugins: { 'copy-path': { 'clipboard.write': 'granted', 'paths.read': 'denied' } } };
    expect(normalizePermissionsFile(file)).toEqual(file);
  });
  it('reads anything broken as empty', () => {
    const empty = { version: 1, plugins: {} };
    for (const raw of [null, undefined, 5, 'x', [], {}, { version: 2, plugins: {} }, { version: 1 }, { version: 1, plugins: [] }, { version: 1, plugins: 'x' }]) {
      expect(normalizePermissionsFile(raw), JSON.stringify(raw)).toEqual(empty);
    }
  });
  it('drops unknown permissions, values other than granted / denied, and bad plugin ids, keeping the rest', () => {
    expect(
      normalizePermissionsFile({
        version: 1,
        plugins: {
          ok: { 'paths.read': 'granted', network: 'granted', 'clipboard.write': 'maybe' },
          'Bad Id': { 'paths.read': 'granted' },
          empty: { network: 'granted' },
          list: [1],
          [`${'a'.repeat(65)}`]: { 'paths.read': 'granted' },
        },
      }),
    ).toEqual({ version: 1, plugins: { ok: { 'paths.read': 'granted' } } });
  });
});
