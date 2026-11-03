import type { Extension } from '@codemirror/state';

/** 部品の段。R1 では 'editor'（エディタの中の拡張。ホストと同じ JavaScript の空間で動く）だけ。 */
export type PluginTier = 'editor';

/** 部品の宣言。 */
export interface PluginManifest {
  /** 一意。小文字の英数字とハイフン。 */
  readonly id: string;
  readonly name: string;
  /** 部品の版。 */
  readonly version: string;
  /** 対応する公開 API の版。ホストの PLUGIN_API_VERSION と違うと読み込まれない。 */
  readonly apiVersion: number;
  readonly tier: PluginTier;
}

/**
 * 部品の形。登録は activate の中で ctx に対して行う。
 * activate の中でタイマー・リスナー・購読を始めない（登録だけにする）。後片付けが要る処理は、返す関数に書く
 * （ホストが部品を外すときに呼ぶ）。
 */
export interface Plugin {
  readonly manifest: PluginManifest;
  activate(ctx: PluginContext): void | (() => void);
}

/** 設定の定義。値は、設定ファイル（preferences.json）の最上位のキーとして、これまでと同じ形で保存される。 */
export interface SettingDefinition<T> {
  /** 保存するキー。ホストの設定や、ほかの部品のキーと重ならない名前。 */
  readonly key: string;
  readonly defaultValue: T;
  /** 未検証の値（保存ファイルの中身）から有効な値を作る。読めない値は既定値にする。 */
  normalize(raw: unknown): T;
}

/** registerSetting が返す、登録した設定への参照。ほかの登録（拡張・コマンド・設定画面）で使う。 */
export interface SettingHandle<T> {
  readonly key: string;
  readonly defaultValue: T;
}

/** 設定の値から CodeMirror の拡張を作る登録。値が変わると、ホストが部品ごとの Compartment で差し替える。 */
export interface EditorExtensionRegistration<T> {
  readonly setting: SettingHandle<T>;
  /** 現在の値に対する拡張。純粋に作る（副作用を持たない）。setText で state を作り直しても、現在の値で呼ばれる。 */
  create(value: T): Extension;
}

/** コマンドの実行時にホストが渡すもの。 */
export interface CommandContext {
  readonly settings: {
    get<T>(setting: SettingHandle<T>): T;
    /** 現在の値から次の値を作って保存する（値はホストが setting.normalize で検証する）。 */
    update<T>(setting: SettingHandle<T>, next: (current: T) => T): void;
  };
}

export interface CommandRegistration {
  /** 部品の中で一意。ホストが `<部品の id>.<id>` として扱う。 */
  readonly id: string;
  readonly title: string;
  /**
   * ショートカット。'Mod+T' や 'Mod+Shift+T' の形（Mod は macOS で Cmd、それ以外で Ctrl。
   * 末尾は ASCII の英字 1 文字か ','）。論理キーを優先し、英字でない配列のときは物理キーで判定する。
   * Alt との組み合わせと IME の変換中のキーは対象にしない。ホストの固定のショートカットが先に判定される。
   */
  readonly shortcut?: string;
  /** true のとき、本文以外の文字入力欄（検索パネル・設定画面の入力欄など）にフォーカスがあれば実行しない。 */
  readonly ignoreInTextEntry?: boolean;
  run(ctx: CommandContext): void;
}

/** 設定画面で項目を置ける場所。 */
export const SETTINGS_PLACEMENTS = ['appearance.writingAids'] as const;
export type SettingsPlacement = (typeof SETTINGS_PLACEMENTS)[number];

export interface SettingsItemRegistration {
  readonly placement: SettingsPlacement;
  /** 場所の中の並び順（小さいほど上）。ホストの項目は 100 刻み。同じ値のときは、ホストの項目、登録の順。 */
  readonly order: number;
  readonly kind: 'checkbox';
  readonly setting: SettingHandle<boolean>;
  readonly label: string;
}

/** activate に渡される登録の口。 */
export interface PluginContext {
  registerSetting<T>(definition: SettingDefinition<T>): SettingHandle<T>;
  registerEditorExtension<T>(registration: EditorExtensionRegistration<T>): void;
  registerCommand(registration: CommandRegistration): void;
  registerSettingsItem(registration: SettingsItemRegistration): void;
}
