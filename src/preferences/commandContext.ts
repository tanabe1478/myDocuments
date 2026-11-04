import { type CommandContext, type SettingDefinition, type SettingHandle } from '../plugin-api';
import { normalizePreferences, type StoredPreferences } from './preferences';

/** 設定 1 つの値を、保存の形（StoredPreferences）から読む。値がなければ既定値。 */
function readSetting<T>(prefs: StoredPreferences, setting: SettingHandle<T>): T {
  return (prefs[setting.key] as T | undefined) ?? setting.defaultValue;
}

/**
 * 設定 1 つの更新を、直前の設定から作った次の設定にする。次の値は、直前の設定の値から計算し、
 * 本体の設定と同じ経路（normalizePreferences）で検証する。
 * 次の値が今の値と同じなら、直前の設定をそのまま返す（検証し直さない。部品が止まっていて、next が今の値を返したとき、
 * 検証の関数が止めた部品の既定値を返して、設定が前の値から変わることを防ぐ）。
 */
export function updateStoredSetting<T>(
  prefs: StoredPreferences,
  setting: SettingHandle<T>,
  next: (current: T) => T,
  pluginSettings: readonly SettingDefinition<unknown>[],
): StoredPreferences {
  const current = readSetting(prefs, setting);
  const value = next(current);
  if (Object.is(value, current)) return prefs;
  return normalizePreferences({ ...prefs, [setting.key]: value }, pluginSettings);
}

/**
 * 部品のコマンドに渡す CommandContext。
 * update は、setPrefs の更新関数（直前の設定を受け取る形）の中で次の値を計算する。同じ tick に複数回呼んでも、
 * 呼んだ順に、直前の更新の結果へ重ねて反映される（読むのが描画済みの値だと、後の更新が前の更新を打ち消す）。
 * get は、呼んだ時点で描画済みの値（readPrefs）を返す。
 */
export function createCommandContext(
  readPrefs: () => StoredPreferences,
  setPrefs: (update: (prev: StoredPreferences) => StoredPreferences) => void,
  pluginSettings: readonly SettingDefinition<unknown>[],
): CommandContext {
  return {
    settings: {
      get: <T,>(setting: SettingHandle<T>): T => readSetting(readPrefs(), setting),
      update: <T,>(setting: SettingHandle<T>, next: (current: T) => T): void => {
        setPrefs((prev) => updateStoredSetting(prev, setting, next, pluginSettings));
      },
    },
  };
}
