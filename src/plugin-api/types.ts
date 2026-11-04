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

/** 本文の表示の種類。markdown は Markdown として扱う文書、plain は素のテキスト（.txt、.text）。 */
export type TextKind = 'markdown' | 'plain';

/**
 * 本体が部品に貸す機能。部品は、bridge（ネイティブへの入口）やブラウザの API を直接使わず、これを呼ぶ。
 * 段 3（エディタの中の拡張。同梱の部品と、信頼した部品）だけに貸す。段 1・段 2 に貸すときは、権限の確認が要る（ADR-005 の R4）。
 * 部品が止まったあと（例外で止めた、または解除した）は、呼んでも何もしない。
 */
export interface HostServices {
  /**
   * 外部の URL を、既定のブラウザで開く。本体の今の経路を通る: http と https だけを開き、ほかの URL や、開けなかったときは
   * トースト「このリンクは開けません」で知らせる（ネイティブ側でも検査する）。戻り値はない（失敗は本体が利用者に知らせる）。
   *
   * 利用者の操作（リンクを ⌘/Ctrl+クリックしたとき、など）への応答としてだけ呼ぶ。起動時、タイマー、文書の変更への反応から
   * 呼ばない。ネットワークの API ではない（本文を URL に入れて開けば外へ出せるので、段 1・段 2 に貸すなら操作のたびに URL を確かめる）。
   */
  openExternalUrl(url: string): void;
  /** 使っている OS が macOS か（Cmd と Ctrl の使い分けなどに使う）。呼んだ時点の判定で、値を覚えてよい固定の値とは限らない。 */
  isMacPlatform(): boolean;
}

/** 拡張を作るときにホストが渡す、今の文書についての情報と、本体が貸す機能。 */
export interface EditorExtensionEnvironment extends HostServices {
  /** 今の文書の種類。dependsOnTextKind が true の登録だけ、この値が変わると拡張が作り直される。 */
  readonly textKind: TextKind;
}

/** 設定の値から CodeMirror の拡張を作る登録。値が変わると、ホストが部品ごとの Compartment で差し替える。 */
export interface EditorExtensionRegistration<T> {
  readonly setting: SettingHandle<T>;
  /**
   * true のとき、文書の種類（env.textKind）が変わるたびに、ホストが拡張を作り直す（設定の値が変わったときと同じ差し替え）。
   * create が env.textKind を読むなら true にする。false（既定）のとき、種類が変わっても create は呼ばれない
   * （env.textKind は、拡張を作った時点の値のまま）。
   */
  readonly dependsOnTextKind?: boolean;
  /** 現在の値と文書の種類に対する拡張。純粋に作る（副作用を持たない）。setText で state を作り直しても、現在の値で呼ばれる。 */
  create(value: T, env: EditorExtensionEnvironment): Extension;
}

/** コマンドの実行時にホストが渡すもの。 */
export interface CommandContext {
  readonly settings: {
    get<T>(setting: SettingHandle<T>): T;
    /**
     * 現在の値から次の値を作って保存する（値はホストが setting.normalize で検証する）。
     *
     * next は、副作用を持たない純粋な関数にする（同じ current には同じ値を返す。外の状態を読み書きしない）。
     * ホストは next を、描画の仕組み（React の state の更新関数）の中で呼ぶので、次の 2 点が起きうる。
     * - 2 回以上呼ばれうる（開発ビルドの StrictMode は更新関数を 2 回呼ぶ）。
     * - update を呼んだ時点では呼ばれず、遅れて呼ばれうる（同じ tick の更新はまとめて、呼んだ順に適用される）。
     *   update が戻った時点で設定が変わっているとは限らず、変わった値は get で読めるとは限らない。
     * next が例外を出したときは、その部品を止め（コマンドの run が例外を出したときと同じ）、設定は前の値のままにする。
     */
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

/**
 * 設定画面で項目を置ける場所。名前は `<節>.<節の中の置き場>`。
 * - appearance.writingAids: 「外観」の節の「執筆の補助」の枠の中。チェックボックスの並び。
 * - editing.body: 「編集」の節の本文。節の見出しの下に、項目が並ぶ（枠はホストが持たず、項目が自分の枠を持つ）。
 * - appearance.body: 「外観」の節の本文。ホストの枠（フォント、文字組み、紙の幅、テーマ、背景、コントラスト、執筆の補助）と
 *   同じ並びの中に、項目が自分の枠を持って並ぶ。並びは order の数で決め、ホストの枠も同じ数の尺度で並ぶ（HOST_APPEARANCE_ORDER）。
 */
export const SETTINGS_PLACEMENTS = ['appearance.writingAids', 'editing.body', 'appearance.body'] as const;
export type SettingsPlacement = (typeof SETTINGS_PLACEMENTS)[number];

/** 置き場所ごとに置ける項目の種類（ホストがその場所で描ける種類）。合わない登録は、登録の例外になる。 */
export const SETTINGS_PLACEMENT_KINDS = {
  'appearance.writingAids': 'checkbox',
  'editing.body': 'radio',
  'appearance.body': 'radio',
} as const satisfies Record<SettingsPlacement, SettingsItemKind>;

/**
 * 「外観」の節（appearance.body）の、ホストの枠の order。部品の項目は、この間の数で並びを決める
 * （例: 「紙の幅」と「テーマ」の間は 300 より大きく 400 より小さい数）。同じ数のときは、ホストの枠が先。
 */
export const HOST_APPEARANCE_ORDER = {
  font: 100,
  typography: 200,
  surfaceWidth: 300,
  theme: 400,
  background: 500,
  contrast: 600,
  writingAids: 700,
} as const;

export type SettingsItemKind = 'checkbox' | 'radio';

interface SettingsItemBase {
  readonly placement: SettingsPlacement;
  /** 場所の中の並び順（小さいほど上）。ホストの項目は 100 刻み（appearance.body は HOST_APPEARANCE_ORDER）。同じ値のときは、ホストの項目、登録の順。 */
  readonly order: number;
}

/** チェックボックス 1 つ。設定は真偽値。 */
export interface CheckboxSettingsItem extends SettingsItemBase {
  readonly kind: 'checkbox';
  readonly setting: SettingHandle<boolean>;
  readonly label: string;
}

/** 選択肢の 1 つ。 */
export interface RadioOption {
  /** 設定に保存される値。 */
  readonly value: string;
  readonly label: string;
}

/**
 * 選択肢（ラジオボタン）の項目。設定は、選択肢の value のどれか（文字列）。
 * 枠（fieldset）、見出し（legend）、選択肢、補足の文（hint）を 1 まとまりで描く。ラジオの name は、設定のキーから
 * 規則で作る（小文字のハイフン区切り: `listContinuation` → `list-continuation`）。
 */
export interface RadioSettingsItem extends SettingsItemBase {
  readonly kind: 'radio';
  readonly setting: SettingHandle<string>;
  /** 項目の見出し。 */
  readonly legend: string;
  /** 1 つ以上。value は重ならない。設定の既定値は、このどれかにする。 */
  readonly options: readonly RadioOption[];
  /** 選択肢の下に出す補足の文。省略すると出さない。 */
  readonly hint?: string;
}

export type SettingsItemRegistration = CheckboxSettingsItem | RadioSettingsItem;

/** activate に渡される登録の口。 */
export interface PluginContext {
  registerSetting<T>(definition: SettingDefinition<T>): SettingHandle<T>;
  registerEditorExtension<T>(registration: EditorExtensionRegistration<T>): void;
  registerCommand(registration: CommandRegistration): void;
  registerSettingsItem(registration: SettingsItemRegistration): void;
}
