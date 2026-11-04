import { useId } from 'react';
import type { PluginRegistry } from '../plugin-api';
import type { StoredPreferences } from '../preferences/preferences';
import { RadioSettingsItem } from './RadioSettingsItem';

export interface EditingSettingsProps {
  prefs: StoredPreferences;
  onChange(patch: Partial<StoredPreferences>): void;
  /** 部品が置いた設定画面の項目（場所ごと）。 */
  settingsItems: PluginRegistry['settingsItems'];
}

/**
 * 設定画面の「編集」の節。入力のときの挙動。節の見出しだけをここで持ち、項目（選択肢の枠）は、部品が
 * 置き場所 editing.body に登録したものを order の順に並べる。
 * 変更はすぐ編集中の文書に効く（設定画面の枠は SettingsDialog.tsx）。
 */
export function EditingSettings({ prefs, onChange, settingsItems }: EditingSettingsProps) {
  const headingId = useId();

  return (
    <section className="settings-section" aria-labelledby={headingId} data-testid="settings-editing">
      <h3 id={headingId}>編集</h3>

      {settingsItems('editing.body').map((item) => (
        <RadioSettingsItem key={item.settingKey} item={item} prefs={prefs} onChange={onChange} />
      ))}
    </section>
  );
}
