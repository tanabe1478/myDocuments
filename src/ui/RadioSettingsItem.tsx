import type { RegisteredRadioItem } from '../plugin-api';
import type { StoredPreferences } from '../preferences/preferences';

/**
 * 選択肢（ラジオボタン）の項目 1 つ。部品が登録した項目（kind: 'radio'）を、枠（fieldset と legend）ごと描く。
 * 選択肢の value が設定の値。保存された値が選択肢にないときは、どれも選ばれない。
 */
export function RadioSettingsItem({
  item,
  prefs,
  onChange,
}: {
  item: RegisteredRadioItem;
  prefs: StoredPreferences;
  onChange(patch: Partial<StoredPreferences>): void;
}) {
  return (
    <fieldset>
      <legend>{item.legend}</legend>
      <div className="choices">
        {item.options.map((o) => (
          <label key={o.value} className="choice">
            <input
              type="radio"
              name={item.name}
              value={o.value}
              checked={prefs[item.settingKey] === o.value}
              onChange={() => onChange({ [item.settingKey]: o.value })}
            />
            {o.label}
          </label>
        ))}
      </div>
      {item.hint !== null && <p className="hint">{item.hint}</p>}
    </fieldset>
  );
}
