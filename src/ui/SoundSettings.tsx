import { useId } from 'react';
import type { PluginRegistry } from '../plugin-api';
import type { StoredPreferences } from '../preferences/preferences';
import { RadioSettingsItem } from './RadioSettingsItem';

export interface SoundSettingsProps {
  prefs: StoredPreferences;
  onChange(patch: Partial<StoredPreferences>): void;
  /** 部品が置いた設定画面の項目（場所ごと）。 */
  settingsItems: PluginRegistry['settingsItems'];
}

/**
 * 設定画面の「音」の節。節の見出しだけをここで持ち、項目（選択肢の枠）は、部品が置き場所 sound.body に登録したものを
 * order の順に並べる。置いた部品がなければ、節ごと出さない。
 */
export function SoundSettings({ prefs, onChange, settingsItems }: SoundSettingsProps) {
  const headingId = useId();
  const items = settingsItems('sound.body');
  if (items.length === 0) return null;

  return (
    <section className="settings-section" aria-labelledby={headingId} data-testid="settings-sound">
      <h3 id={headingId}>音</h3>

      {items.map((item) => (
        <RadioSettingsItem key={item.settingKey} item={item} prefs={prefs} onChange={onChange} />
      ))}
    </section>
  );
}
