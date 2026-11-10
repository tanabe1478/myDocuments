import { useId } from 'react';
import type { StoredPreferences } from '../preferences/preferences';
import { isMacPlatform } from './shortcuts';

export interface DiagnosticsSettingsProps {
  prefs: StoredPreferences;
  onChange(patch: Partial<StoredPreferences>): void;
}

/** macOS のログの置き場所（Tauri の app_log_dir。識別子は tauri.conf.json の identifier）。 */
export const MAC_LOG_DIRECTORY = '~/Library/Logs/io.github.tanabe1478.immersive-markdown-editor/';

/**
 * 設定画面の「診断」の節（ADR-007）。「ログを記録する」（既定はオフ）。オンにすると、起動、例外、文書の失敗、部品の停止などの記録が、
 * ログのファイル（app.log）に追記される。本文とファイルのパスは書かない。オフにしても、書いたファイルは残る。
 */
export function DiagnosticsSettings({ prefs, onChange }: DiagnosticsSettingsProps) {
  const headingId = useId();
  const location = isMacPlatform() ? MAC_LOG_DIRECTORY : 'OS のログのフォルダ（アプリの識別子の名前のフォルダ）';

  return (
    <section className="settings-section" aria-labelledby={headingId} data-testid="settings-diagnostics">
      <h3 id={headingId}>診断</h3>

      <fieldset>
        <legend>ログ</legend>
        <label className="check">
          <input type="checkbox" checked={prefs.appLog} onChange={(e) => onChange({ appLog: e.target.checked })} />
          ログを記録する
        </label>
        <p className="hint" data-testid="log-location">
          不具合の原因を調べるための記録です。本文とファイルのパスは書きません。置き場所: {location}
        </p>
        <p className="hint">オフにしても、書いたファイルは残ります。</p>
      </fieldset>
    </section>
  );
}
