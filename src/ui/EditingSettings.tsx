import { useId } from 'react';
import type { ListContinuation, Preferences } from '../preferences/preferences';

export interface EditingSettingsProps {
  prefs: Preferences;
  onChange(patch: Partial<Preferences>): void;
}

const LIST_CONTINUATION_OPTIONS: ReadonlyArray<{ value: ListContinuation; label: string }> = [
  { value: 'tight', label: '空行を入れない' },
  { value: 'preserve', label: 'リストの形に合わせる' },
];

/**
 * 設定画面の「編集」の節。入力のときの挙動（いまは、リストの継続だけ）。
 * 変更はすぐ編集中の文書に効く（設定画面の枠は SettingsDialog.tsx）。
 */
export function EditingSettings({ prefs, onChange }: EditingSettingsProps) {
  const headingId = useId();

  return (
    <section className="settings-section" aria-labelledby={headingId} data-testid="settings-editing">
      <h3 id={headingId}>編集</h3>

      <fieldset>
        <legend>リストの継続</legend>
        <div className="choices">
          {LIST_CONTINUATION_OPTIONS.map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name="list-continuation"
                value={o.value}
                checked={prefs.listContinuation === o.value}
                onChange={() => onChange({ listContinuation: o.value })}
              />
              {o.label}
            </label>
          ))}
        </div>
        <p className="hint">空行で区切ったリストで Enter を押したとき、次の項目の前にも空行を入れるか</p>
      </fieldset>
    </section>
  );
}
