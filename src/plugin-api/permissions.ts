/**
 * 隔離した操作（段 2）の部品の権限（ADR-005 の R6）。部品は manifest.permissions で、使うつもりの権限を宣言する。
 * 宣言した権限は、初めて使うときに、本体が確認の画面を出して利用者に聞く（結果は保存する）。宣言していない権限の API は、確認なしで拒否する。
 */

/** 決められる権限の種類。src-tauri/src/plugin_permissions.rs の KNOWN_PERMISSIONS と同じ。 */
export const PERMISSIONS = ['clipboard.write', 'paths.read'] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 確認の画面と設定画面に出す、権限ごとの説明。 */
export const PERMISSION_DESCRIPTIONS: Readonly<Record<Permission, string>> = {
  'clipboard.write': '文字列をクリップボードに書き込む',
  'paths.read': '開いている文書と、ツリーで選んだ項目のパスを知る',
};

export type PermissionDecision = 'granted' | 'denied';
/** 部品 1 つぶんの、利用者が決めた結果。決めていない権限は、キーがない。 */
export type PermissionDecisions = Partial<Record<Permission, PermissionDecision>>;

export const isPermission = (value: unknown): value is Permission => typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);

/** 保存の形（plugin-permissions.json の中身）。 */
export interface PluginPermissionsFile {
  readonly version: 1;
  readonly plugins: Readonly<Record<string, PermissionDecisions>>;
}

/**
 * 権限を使ってよいかを、本体の側で決める口（レジストリが呼ぶ）。実装は src/permissions/（保存と確認の画面を持つ）。
 * - granted: 許可済み、または今回の確認で許可された。
 * - denied: 拒否済み、または今回の確認で拒否された。
 * - dismissed: 確認の画面を、決めずに閉じた（Esc、閉じる）。今回だけ断る。決定は保存せず、次の使用で再び聞く。
 */
export type PermissionOutcome = 'granted' | 'denied' | 'dismissed';

/**
 * authorize の結果。PermissionOutcome に加えて:
 * - not-asked: 確認の画面を出さずに断った（決めていない権限で、利用者の操作で始まった実行の中ではない、または、その実行で確認の画面を出した後）。
 *   決定は保存せず、次の利用者の操作で始まった実行で、改めて聞く。
 */
export type PermissionAuthorization = PermissionOutcome | 'not-asked';

export interface PermissionGate {
  /**
   * 部品 plugin が権限 needed を使ってよいか。決めていなければ、宣言した権限のうち、決めていないもの（declared のうち）を
   * まとめて、確認の画面で聞く。needed は declared に含まれていること（宣言していない権限は、呼ぶ前にレジストリが拒否する）。
   * 確認の画面を出してよいのは、beginRun で開いた実行（利用者の操作で始まったもの）の中で、その実行につき 1 回まで。
   * それ以外の時機（起動時、activate の中、実行の外、同じ実行の 2 回目以降）の、決めていない権限は、not-asked で断る。
   */
  authorize(plugin: { readonly id: string; readonly name: string }, declared: readonly Permission[], needed: Permission): Promise<PermissionAuthorization>;
  /**
   * 利用者の操作（段 2 のコマンドのショートカット、ツリーのメニューの項目の選択）で、部品 pluginId の実行を始める直前に呼ぶ。
   * 戻り値の関数は、その実行が終わったとき（終わる、止まる、時間切れ、実行されなかった）に呼ぶ。何度呼んでもよい。
   * ない実装は、実行の中かどうかを区別しない（テスト用の偽物）。
   */
  beginRun?(pluginId: string): () => void;
}

/**
 * 保存された（または、ネイティブから届いた）値から、検証した PluginPermissionsFile を作る。壊れている値は空として扱う
 * （形が違う、知らない権限、granted / denied 以外は、その項目を捨てる）。ネイティブ側も同じ規則で検査する。
 */
export function normalizePermissionsFile(raw: unknown): PluginPermissionsFile {
  const plugins: Record<string, PermissionDecisions> = {};
  if (typeof raw === 'object' && raw !== null && (raw as { version?: unknown }).version === 1) {
    const source = (raw as { plugins?: unknown }).plugins;
    if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
      for (const [id, decisions] of Object.entries(source)) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || id.length > 64 || typeof decisions !== 'object' || decisions === null || Array.isArray(decisions)) continue;
        const kept: PermissionDecisions = {};
        for (const [permission, decision] of Object.entries(decisions)) {
          if (isPermission(permission) && (decision === 'granted' || decision === 'denied')) kept[permission] = decision;
        }
        if (Object.keys(kept).length > 0) plugins[id] = kept;
      }
    }
  }
  return { version: 1, plugins };
}
