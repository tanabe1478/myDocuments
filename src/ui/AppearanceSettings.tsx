import { useId, useState } from 'react';
import type { ContrastReport } from '../canvas/canvas';
import { formatRatio, WCAG_AA, WCAG_AAA } from '../canvas/contrast';
import { GRADIENTS, gradientCss, type ThemeMode } from '../canvas/gradients';
import type { RegisteredSettingsItem, SettingsPlacement } from '../plugin-api';
import { FONT_PRESETS, presetIdOf } from '../preferences/fonts';
import {
  RANGES,
  validFontFamily,
  type BackgroundKind,
  type MarkupDisplay,
  type StoredPreferences,
  type SurfaceWidth,
  type ThemeSetting,
} from '../preferences/preferences';

export interface AppearanceSettingsProps {
  prefs: StoredPreferences;
  /** 表示中のテーマ（グラデーションの見本の色に使う）。 */
  mode: ThemeMode;
  contrast: ContrastReport;
  /** 今の設定で、1 行に入る全角文字の数の目安。 */
  lineChars: number;
  imageStatus: 'none' | 'loading' | 'ready' | 'error';
  onChange(patch: Partial<StoredPreferences>): void;
  onPickImage(): void;
  /** 部品が置いた設定画面の項目（場所ごと）。 */
  settingsItems(placement: SettingsPlacement): readonly RegisteredSettingsItem[];
}

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeSetting; label: string }> = [
  { value: 'light', label: 'ライト' },
  { value: 'dark', label: 'ダーク' },
  { value: 'system', label: 'OS に従う' },
];

const KIND_OPTIONS: ReadonlyArray<{ value: BackgroundKind; label: string }> = [
  { value: 'color', label: '単色' },
  { value: 'gradient', label: 'グラデーション' },
  { value: 'image', label: '画像' },
];

const SURFACE_WIDTH_OPTIONS: ReadonlyArray<{ value: SurfaceWidth; label: string }> = [
  { value: 'fill', label: '窓いっぱい' },
  { value: 'text', label: '本文に合わせる' },
];

const MARKUP_DISPLAY_OPTIONS: ReadonlyArray<{ value: MarkupDisplay; label: string }> = [
  { value: 'cursorLine', label: 'カーソルのある行だけ' },
  { value: 'always', label: '常に表示' },
];

/**
 * 設定画面の「外観」の節。文字組み、紙の幅、記号の表示、テーマ、背景、執筆の補助。
 * 変更はすぐ本文に反映される（設定画面の枠は SettingsDialog.tsx）。
 */
export function AppearanceSettings(props: AppearanceSettingsProps) {
  const { prefs, mode, contrast, lineChars, imageStatus, onChange, onPickImage, settingsItems } = props;
  const headingId = useId();

  return (
    <section className="settings-section" aria-labelledby={headingId} data-testid="settings-appearance">
      <h3 id={headingId}>外観</h3>

      <FontFields prefs={prefs} onChange={onChange} />

      <fieldset>
        <legend>文字組み</legend>
        <RangeField
          label="文字サイズ"
          range={RANGES.fontSizePx}
          step={1}
          value={prefs.fontSizePx}
          format={(v) => `${v}px`}
          onChange={(v) => onChange({ fontSizePx: v })}
        />
        <RangeField
          label="行高"
          range={RANGES.lineHeight}
          step={0.05}
          value={prefs.lineHeight}
          format={(v) => v.toFixed(2)}
          onChange={(v) => onChange({ lineHeight: v })}
        />
        <RangeField
          label="段落間隔"
          range={RANGES.paragraphSpacing}
          step={0.1}
          value={prefs.paragraphSpacing}
          format={(v) => `${v.toFixed(1)}行`}
          onChange={(v) => onChange({ paragraphSpacing: v })}
        />
        <p className="hint">空行 1 つの高さ。見出し前の余白にも使います。</p>
        <RangeField
          label="字間"
          range={RANGES.letterSpacing}
          step={0.005}
          value={prefs.letterSpacing}
          format={(v) => `${v.toFixed(3)}em`}
          onChange={(v) => onChange({ letterSpacing: v })}
        />
        <RangeField
          label="本文の最大幅"
          range={RANGES.maxWidthPx}
          step={10}
          value={prefs.maxWidthPx}
          format={(v) => `${v}px`}
          onChange={(v) => onChange({ maxWidthPx: v })}
        />
        <p className="hint" data-testid="chars-per-line">
          1 行 約 {lineChars} 字（全角）
        </p>
      </fieldset>

      <fieldset>
        <legend>紙の幅</legend>
        <div className="choices">
          {SURFACE_WIDTH_OPTIONS.map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name="surface-width"
                value={o.value}
                checked={prefs.surfaceWidth === o.value}
                onChange={() => onChange({ surfaceWidth: o.value })}
              />
              {o.label}
            </label>
          ))}
        </div>
        <p className="hint">「窓いっぱい」では、背景は本文面の透け具合（不透明度）でだけ見えます。背景を見せたいときは「本文に合わせる」にします。</p>
      </fieldset>

      <fieldset>
        <legend>記号の表示</legend>
        <div className="choices">
          {MARKUP_DISPLAY_OPTIONS.map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name="markup-display"
                value={o.value}
                checked={prefs.markupDisplay === o.value}
                onChange={() => onChange({ markupDisplay: o.value })}
              />
              {o.label}
            </label>
          ))}
        </div>
        <p className="hint">Markdown の # や * などの記号を、どの行で見せるか。「カーソルのある行だけ」では、ほかの行は記号を隠して整形して表示します（文書の中身は変わりません）。</p>
      </fieldset>

      <fieldset>
        <legend>テーマ</legend>
        <div className="choices">
          {THEME_OPTIONS.map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name="theme"
                value={o.value}
                checked={prefs.theme === o.value}
                onChange={() => onChange({ theme: o.value })}
              />
              {o.label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>背景</legend>
        <div className="choices">
          {KIND_OPTIONS.map((o) => (
            <label key={o.value} className="choice">
              <input
                type="radio"
                name="background-kind"
                value={o.value}
                checked={prefs.background.kind === o.value}
                onChange={() => onChange({ background: { ...prefs.background, kind: o.value } })}
              />
              {o.label}
            </label>
          ))}
        </div>

        {prefs.background.kind === 'color' && (
          <ColorField
            value={prefs.background.color}
            onChange={(color) => onChange({ background: { ...prefs.background, color } })}
          />
        )}

        {prefs.background.kind === 'gradient' && (
          <div className="choices gradient-choices" role="radiogroup" aria-label="グラデーション">
            {GRADIENTS.map((g) => (
              <label key={g.id} className="choice gradient-choice">
                <input
                  type="radio"
                  name="gradient"
                  value={g.id}
                  checked={prefs.background.gradientId === g.id}
                  onChange={() => onChange({ background: { ...prefs.background, gradientId: g.id } })}
                />
                <span className="swatch" aria-hidden="true" style={{ background: gradientCss(g.id, mode) }} />
                {g.label}
              </label>
            ))}
          </div>
        )}

        {prefs.background.kind === 'image' && (
          <>
            <div className="image-row">
              <button type="button" data-testid="image-pick" onClick={onPickImage}>
                画像を選ぶ…
              </button>
              <span className="hint" data-testid="image-status" role="status">
                {imageStatus === 'ready' && '取り込み済み'}
                {imageStatus === 'loading' && '読み込み中…'}
                {imageStatus === 'error' && '画像を読み込めませんでした'}
                {imageStatus === 'none' && '画像は未選択です'}
              </span>
            </div>
            <RangeField
              label="画像の明るさ"
              range={RANGES.imageBrightness}
              step={0.05}
              value={prefs.imageBrightness}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => onChange({ imageBrightness: v })}
            />
            <RangeField
              label="オーバーレイ濃度"
              range={RANGES.overlayOpacity}
              step={0.05}
              value={prefs.overlayOpacity}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => onChange({ overlayOpacity: v })}
            />
          </>
        )}

        <RangeField
          label="本文面の不透明度"
          range={RANGES.surfaceOpacity}
          step={0.05}
          value={prefs.surfaceOpacity}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => onChange({ surfaceOpacity: v })}
        />
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.hideBackground}
            onChange={(e) => onChange({ hideBackground: e.target.checked })}
          />
          背景を表示しない
        </label>
        <p className="hint">読みにくいときは、背景を消してテーマの既定配色だけにできます。</p>
      </fieldset>

      <fieldset>
        <legend>文字と本文面のコントラスト</legend>
        <ContrastView contrast={contrast} />
      </fieldset>

      <fieldset>
        <legend>執筆の補助</legend>
        {writingAidChecks(prefs, settingsItems('appearance.writingAids')).map((item) => (
          <label className="check" key={item.key}>
            <input type="checkbox" checked={item.checked} onChange={(e) => onChange({ [item.key]: e.target.checked })} />
            {item.label}
          </label>
        ))}
      </fieldset>
    </section>
  );
}

interface CheckEntry {
  readonly key: string;
  readonly label: string;
  readonly checked: boolean;
  readonly order: number;
}

/**
 * 「執筆の補助」のチェック項目。本体の項目（order は 100 刻み）と、部品が置いた項目を、order の順に並べる。
 * 同じ order のときは、本体の項目、部品の登録順（sort は安定）。
 */
function writingAidChecks(prefs: StoredPreferences, pluginItems: readonly RegisteredSettingsItem[]): CheckEntry[] {
  const entries: CheckEntry[] = [
    { key: 'focusMode', label: 'フォーカスモード', checked: prefs.focusMode, order: 100 },
    { key: 'autoHideChrome', label: '入力中は上下のバーを隠す', checked: prefs.autoHideChrome, order: 300 },
    ...pluginItems.map((item) => ({
      key: item.settingKey,
      label: item.label,
      checked: prefs[item.settingKey] === true,
      order: item.order,
    })),
  ];
  return entries.sort((a, b) => a.order - b.order);
}

function FontFields({ prefs, onChange }: Pick<AppearanceSettingsProps, 'prefs' | 'onChange'>) {
  const selectId = useId();
  const customId = useId();
  const errorId = useId();
  const presetId = presetIdOf(prefs.fontFamily);
  const [customOpen, setCustomOpen] = useState(presetId === null);
  const [draft, setDraft] = useState(prefs.fontFamily);
  const [invalid, setInvalid] = useState(false);

  const showCustom = customOpen || presetId === null;

  return (
    <fieldset>
      <legend>フォント</legend>
      <div className="field">
        <label htmlFor={selectId}>フォントの種類</label>
        <select
          id={selectId}
          value={showCustom ? 'custom' : (presetId ?? 'custom')}
          onChange={(e) => {
            if (e.target.value === 'custom') {
              setCustomOpen(true);
              setDraft(prefs.fontFamily);
              return;
            }
            const preset = FONT_PRESETS.find((p) => p.id === e.target.value);
            if (preset) {
              setCustomOpen(false);
              setInvalid(false);
              onChange({ fontFamily: preset.value });
            }
          }}
        >
          {FONT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">自由入力…</option>
        </select>
      </div>
      {showCustom && (
        <div className="field">
          <label htmlFor={customId}>font-family（自由入力）</label>
          <input
            id={customId}
            type="text"
            value={draft}
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={invalid ? errorId : undefined}
            onChange={(e) => {
              setDraft(e.target.value);
              const valid = validFontFamily(e.target.value);
              setInvalid(valid === null);
              if (valid !== null) onChange({ fontFamily: valid });
            }}
          />
          {invalid && (
            <p id={errorId} className="hint warn" role="alert">
              使えない指定です（空、300 文字超、; {'{'} {'}'} {'<'} {'>'} \ を含む）。直前の指定のままです。
            </p>
          )}
        </div>
      )}
    </fieldset>
  );
}

function RangeField(props: {
  label: string;
  range: { min: number; max: number };
  step: number;
  value: number;
  format(value: number): string;
  onChange(value: number): void;
}) {
  const id = useId();
  const text = props.format(props.value);
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={id}>{props.label}</label>
        <span className="value" aria-hidden="true">
          {text}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={props.range.min}
        max={props.range.max}
        step={props.step}
        value={props.value}
        aria-valuetext={text}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </div>
  );
}

function ColorField({ value, onChange }: { value: string; onChange(color: string): void }) {
  const id = useId();
  return (
    <div className="field field-inline">
      <label htmlFor={id}>単色の色</label>
      <input id={id} type="color" value={value} onChange={(e) => onChange(e.target.value.toLowerCase())} />
      <span className="value">{value}</span>
    </div>
  );
}

function ContrastView({ contrast }: { contrast: ContrastReport }) {
  const { ratio, belowAA } = contrast;
  if (ratio === null) {
    return (
      <p className="hint" data-testid="contrast-ratio">
        背景画像の色を調べています…
      </p>
    );
  }
  const grade = ratio >= WCAG_AAA ? '基準 7 以上（AAA）' : ratio >= WCAG_AA ? '基準 4.5 以上（AA）' : '基準 4.5 未満';
  return (
    <>
      <p data-testid="contrast-ratio">
        {formatRatio(ratio)} : 1（{grade}）
      </p>
      {belowAA && (
        <p className="hint warn" role="alert" data-testid="contrast-warning">
          警告: 文字と本文面のコントラスト比が {WCAG_AA} 未満で、読みにくい可能性があります。本文面の不透明度を上げるか、背景を変えるか、「背景を表示しない」を使ってください。
        </p>
      )}
    </>
  );
}
