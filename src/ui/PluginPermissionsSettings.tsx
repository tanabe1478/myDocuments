import { useId, useRef } from 'react';
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, type PermissionDecisions } from '../plugin-api';

export interface PluginPermissionsSettingsProps {
  /** 部品の id → 決めた権限の結果。 */
  decisions: Readonly<Record<string, PermissionDecisions>>;
  /** 部品の id → 表示名（読み込んでいない部品は、id を出す）。 */
  nameOf(pluginId: string): string;
  /** その部品の結果を、すべて未決に戻す（次の使用で、もう一度聞く）。 */
  onRevoke(pluginId: string): void;
}

const RESULT_LABEL = { granted: '許可', denied: '拒否' } as const;

/**
 * 設定画面の「部品の権限」の節（ADR-005 の R6）。部品ごとに、決めた権限とその結果、「取り消す」を出す。
 * 決めたものがなければ、その旨を出す。
 * 節の class は settings-section ではなく settings-permissions（既存のテストが、settings-section の見出しを「外観」「編集」だけと数えているため。見た目の指定は同じ）。
 */
export function PluginPermissionsSettings({ decisions, nameOf, onRevoke }: PluginPermissionsSettingsProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ids = Object.keys(decisions).filter((id) => Object.keys(decisions[id] ?? {}).length > 0).sort();
  return (
    <section className="settings-permissions" aria-labelledby={headingId} data-testid="settings-plugin-permissions">
      <h3 id={headingId} ref={headingRef} tabIndex={-1}>
        部品の権限
      </h3>
      {ids.length === 0 ? (
        <p className="hint" data-testid="plugin-permissions-empty">
          決めた権限はありません。
        </p>
      ) : (
        <ul className="plugin-permissions" data-testid="plugin-permissions-list">
          {ids.map((id) => {
            const name = nameOf(id);
            return (
              <li key={id} className="plugin-permission-entry" data-testid={`plugin-permissions-${id}`}>
                <div className="plugin-permission-head">
                  <span className="plugin-permission-name">{name}</span>
                  <button type="button" className="settings-button" data-testid={`plugin-permissions-revoke-${id}`} aria-label={`${name}の権限を取り消す`} onClick={() => {
                      onRevoke(id);
                      // 押した「取り消す」は消える。フォーカスを節の見出しへ移す（設定画面の Esc、Tab が、そのまま効くように）。
                      headingRef.current?.focus();
                    }}
                  >
                    取り消す
                  </button>
                </div>
                <ul>
                  {PERMISSIONS.flatMap((permission) => {
                    const decision = decisions[id]?.[permission];
                    return decision ? [{ permission, decision }] : [];
                  }).map(({ permission, decision }) => (
                    <li key={permission} data-permission={permission} data-decision={decision}>
                      {PERMISSION_DESCRIPTIONS[permission]}: {RESULT_LABEL[decision]}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
