import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type CDPSession, type Page } from '@playwright/test';
import { docTitle, launch, test, unsavedMark, utf8 } from './helpers';

// R9: 同梱の部品「タイピング音」。キーを押すたびに打鍵音を鳴らす（既定はオフ）。
// R10: 音色（キーボード、タイプライター）の切り替えと、鳴り始めの位置（素材の頭の無音を飛ばす）、keydown から start までの時間。
// 音の要求の数え方（window.__mdeE2ETypingSound）は e2e のビルドだけにある（本番の dist には入らない）。
// Playwright の chromium は --mute-audio で起動するので、実際の音は出ない。数えるのは「鳴らす要求を出した」ところまで。
// 実際に音が聞こえるか（Tauri の窓、WKWebView）は、このテストでは確かめられない（未確認）。

const DOC = '/docs/sound.md';

interface Request {
  kind: string;
  timbre: string;
  index: number;
  rate: number;
  gain: number;
  offset: number;
  startDelayMs: number;
  baseLatency: number | null;
  outputLatency: number | null;
}
interface Probe {
  fetches: number;
  fetchedTimbres: string[];
  contexts: number;
  decoded: number;
  decodedTimbres: string[];
  decodedOffsets: Record<string, number[]>;
  decodedCount: number;
  requests: Request[];
}
const EMPTY_PROBE = { fetches: 0, fetchedTimbres: [], contexts: 0, decoded: 0, decodedTimbres: [], decodedOffsets: {}, decodedCount: 0, requests: [] };

const SOUNDS_DIR = fileURLToPath(new URL('../../src/features/typing-sound/sounds', import.meta.url));
const TIMBRE_FILES = {
  keyboard: { dir: SOUNDS_DIR, count: 10 },
  typewriter: { dir: path.join(SOUNDS_DIR, 'typewriter'), count: 8 },
} as const;
type Timbre = keyof typeof TIMBRE_FILES;

/**
 * 素材（WAV、16bit、1ch）の鳴り始めの位置の期待値（秒）。実装とは別に、ファイルの標本から求める
 * （最大値の 10% を最初に超える点の 2 ms 前。0 未満は 0）。素材の並びは、ファイル名の順（sounds.ts と同じ）。
 */
function expectedOffsets(timbre: Timbre): number[] {
  const { dir, count } = TIMBRE_FILES[timbre];
  const files = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  expect(files).toHaveLength(count);
  return files.map((f) => {
    const buf = readFileSync(path.join(dir, f));
    // チャンクをたどって fmt と data を探す（キーボードの素材は、data の前にほかのチャンクがある）。
    let channels = 0;
    let bits = 0;
    let rate = 0;
    let data: Buffer | null = null;
    for (let p = 12; p + 8 <= buf.length; ) {
      const id = buf.toString('latin1', p, p + 4);
      const size = buf.readUInt32LE(p + 4);
      if (id === 'fmt ') {
        channels = buf.readUInt16LE(p + 10);
        rate = buf.readUInt32LE(p + 12);
        bits = buf.readUInt16LE(p + 22);
      } else if (id === 'data') data = buf.subarray(p + 8, p + 8 + size);
      p += 8 + size + (size % 2);
    }
    expect(channels, `${f}: channels`).toBe(1);
    expect(bits, `${f}: bits`).toBe(16);
    expect(data, `${f}: data`).not.toBeNull();
    const n = data!.length / 2;
    const x = Array.from({ length: n }, (_, i) => Math.abs(data!.readInt16LE(i * 2)));
    const peak = Math.max(...x);
    const first = x.findIndex((v) => v > peak * 0.1);
    return Math.max(0, first / rate - 0.002);
  });
}
/**
 * ブラウザは、デコードのときに素材を AudioContext の標本化周波数（48 kHz など）へ変換する。
 * キーボードの素材（頭の無音のあとに急な立ち上がり）は、変換しても位置がほぼ変わらない（測った差は 0.11 ms 以内）ので 0.5 ms の幅。
 * タイプライターの素材は、頭の雑音が最大値の 10% 近くまであり、変換の行き過ぎ（リンギング）で 10% を超える点が早まることがある
 * （測った差は最大 2.1 ms。いずれも早まる向き）ので、鳴り始めの 2 ms 前の幅（2.5 ms）を許す。位置そのものが 0 から 6 ms に収まることも別に確かめる。
 */
const OFFSET_TOLERANCE_S: Record<Timbre, number> = { keyboard: 0.0005, typewriter: 0.0025 };

const dialog = (page: Page) => page.getByRole('dialog', { name: '設定' });
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __mdeE2ETypingSound?: Probe }).__mdeE2ETypingSound ?? null);
const soundRadios = (page: Page) => dialog(page).getByTestId('settings-sound');
const requests = async (page: Page) => (await probe(page))!.requests;
const savedPreferences = (page: Page) => page.evaluate(() => window.__mdeE2E!.savedPreferences.at(-1) as Record<string, unknown> | undefined);
const text = (page: Page) => page.evaluate(() => window.__mdeE2E!.editor!.getText());

async function launchWith(page: Page, body = '', preferences: Record<string, unknown> = {}): Promise<void> {
  await launch(page, { files: { [DOC]: utf8(body) }, openPath: DOC, preferences: { theme: 'light', autoHideChrome: false, ...preferences } });
  await page.keyboard.press('ControlOrMeta+o');
  await expect(docTitle(page)).toHaveText('sound.md');
}

/** 本文にフォーカスして、末尾へ。 */
async function focusEnd(page: Page): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
}

/**
 * 最初の鳴らすキーは AudioContext を作ってデコードを始めるだけで、鳴らない（デコードの前）。
 * ここで 1 キー押し、デコードが終わるのを待ってから、数え始める。
 */
async function warmUp(page: Page, count = 10): Promise<void> {
  await focusEnd(page);
  await page.keyboard.press('x');
  await expect.poll(async () => (await probe(page))!.decoded).toBe(1);
  expect((await probe(page))!.decodedCount).toBe(count);
  expect(await requests(page)).toEqual([]);
}

/** 素材の WAV の fetch（ネットワークの要求）を、ファイル名で記録する。launchWith の前に呼ぶ。 */
function recordWavRequests(page: Page): string[] {
  const names: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('.wav')) names.push(path.basename(url.pathname));
  });
  return names;
}
const isKeyboardWav = (name: string) => /^keypress-\d{3}-/.test(name);
const isTypewriterWav = (name: string) => /^typewriter-[1-8]-/.test(name);

/** 間引き（30ms に 1 回）を避けるため、間を置いてから押す。固定の待ちは、間引きの間隔を空けるためだけ。 */
async function pressSpaced(page: Page, key: string): Promise<void> {
  await page.waitForTimeout(45);
  await page.keyboard.press(key);
}

test.describe('設定画面 (Q1)', () => {
  test('「執筆の補助」に「タイピング音」（既定オフ）、新しい「音」の節に音量（小・中・大、既定は中）がある', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();

    const check = dialog(page).getByRole('checkbox', { name: 'タイピング音' });
    await expect(check).not.toBeChecked();
    // 「執筆の補助」の枠の中の、最後の項目。
    const aids = dialog(page).locator('fieldset', { has: page.locator('legend', { hasText: '執筆の補助' }) });
    await expect(aids.getByRole('checkbox')).toHaveCount(4);
    await expect(aids.getByRole('checkbox').last()).toHaveAccessibleName('タイピング音');

    const sound = dialog(page).getByTestId('settings-sound');
    await expect(sound.getByRole('heading', { name: '音' })).toBeVisible();
    await expect(sound.getByRole('radio')).toHaveCount(5);
    // 音色（キーボード、タイプライター）が、音量（小・中・大）の前。
    await expect(sound.locator('legend')).toHaveText(['タイピング音の音色', 'タイピング音の大きさ']);
    await expect(sound.getByRole('radio').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).resolves.toEqual(['keyboard', 'typewriter', 'low', 'medium', 'high']);
    await expect(sound.getByRole('radio', { name: 'キーボード' })).toBeChecked();
    await expect(sound.getByRole('radio', { name: 'タイプライター' })).not.toBeChecked();
    await expect(sound.getByRole('radio', { name: '小' })).not.toBeChecked();
    await expect(sound.getByRole('radio', { name: '中' })).toBeChecked();
    await expect(sound.getByRole('radio', { name: '大' })).not.toBeChecked();
    // 節の並び: 外観、編集、音。
    await expect(dialog(page).locator('.settings-section h3')).toHaveText(['外観', '編集', '音']);
  });

  test('チェックと音量を操作すると保存され、再読み込み（起動し直し）のあとも残る', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).check();
    await dialog(page).getByTestId('settings-sound').getByRole('radio', { name: '大' }).check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typingSound: true, typingSoundVolume: 'high' });
    const saved = (await savedPreferences(page))!;
    // 保存の形は、ほかの部品の設定と同じ（最上位の真偽値と文字列）。
    expect(saved.typingSound).toBe(true);
    expect(saved.typingSoundVolume).toBe('high');

    // 起動し直し: メモリ bridge は、同じタブでの再読み込みで、保存した設定を読み直す。
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page).getByRole('checkbox', { name: 'タイピング音' })).toBeChecked();
    await expect(dialog(page).getByTestId('settings-sound').getByRole('radio', { name: '大' })).toBeChecked();
    // 音色は触っていないので、既定のキーボードのまま保存されている。
    await expect(dialog(page).getByTestId('settings-sound').getByRole('radio', { name: 'キーボード' })).toBeChecked();
    expect(saved.typingSoundTimbre ?? 'keyboard').toBe('keyboard');
    // オンで起動したので、素材の読み込みが始まっている（AudioContext はキーまで作らない）。
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    expect((await probe(page))!.contexts).toBe(0);
  });

  test('音量は「小」に変えても保存され、オフのままなら素材も AudioContext も使わない', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByTestId('settings-sound').getByRole('radio', { name: '小' }).check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typingSound: false, typingSoundVolume: 'low' });
    await page.keyboard.press('Escape');
    await focusEnd(page);
    await page.keyboard.type('abc');
    expect(await probe(page)).toEqual(EMPTY_PROBE);
  });

  test('ショートカットでは、タイピング音は切り替わらない（タイプライターモードの Mod+Shift+T は、これまでどおり切り替わる）', async ({ page }) => {
    await launchWith(page);
    // どのキーの組み合わせも、タイピング音のオンには結びつかない。
    await page.keyboard.press('ControlOrMeta+Shift+S');
    await page.keyboard.press('ControlOrMeta+t');
    await expect.poll(async () => (await savedPreferences(page))?.typingSound ?? false).toBe(false);
    // タイプライターモード（Mod+Shift+T）は、これまでどおり切り替わる。
    await page.keyboard.press('ControlOrMeta+Shift+T');
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typewriterMode: true });
    expect(await probe(page)).toMatchObject({ fetches: 0, contexts: 0 });
  });
});

test.describe('音の要求（e2e のビルドだけの数え方）(Q3)', () => {
  test('オフの間は、キーを押しても素材の fetch も AudioContext も音の要求もない', async ({ page }) => {
    await launchWith(page, 'a');
    expect(await probe(page)).toEqual(EMPTY_PROBE);
    await focusEnd(page);
    for (const key of ['b', 'Enter', 'Backspace', 'Tab', 'Delete', ' ']) await pressSpaced(page, key);
    await page.keyboard.type('日本語');
    expect(await probe(page)).toEqual(EMPTY_PROBE);
  });

  test('オンで起動すると素材を fetch し、AudioContext は最初のキーまで作らない。デコード後、キー 1 回につき要求が 1 回', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    expect(await probe(page)).toMatchObject({ contexts: 0, requests: [] });

    await warmUp(page);
    expect((await probe(page))!.contexts).toBe(1);

    await pressSpaced(page, 'a');
    expect(await requests(page)).toHaveLength(1);
    await pressSpaced(page, 'b');
    await pressSpaced(page, ' ');
    await pressSpaced(page, 'Backspace');
    await pressSpaced(page, 'Delete');
    await pressSpaced(page, 'Tab');
    const all = await requests(page);
    expect(all).toHaveLength(6);
    // 1 つのキーにつき 1 つ。音は 10 個のどれかで、高さと音量は決めた幅の中（既定の音量は中）。
    for (const r of all) {
      expect(r.kind).toBe('key');
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.index).toBeLessThan(10);
      expect(r.rate).toBeGreaterThanOrEqual(0.96);
      expect(r.rate).toBeLessThanOrEqual(1.04);
      expect(r.gain).toBeGreaterThanOrEqual(0.5 * 0.9);
      expect(r.gain).toBeLessThanOrEqual(0.5 * 1.1);
    }
    // 直前と同じ音は続かない。
    for (let i = 1; i < all.length; i++) expect(all[i]!.index).not.toBe(all[i - 1]!.index);
    // AudioContext は 1 つだけ。
    expect((await probe(page))!.contexts).toBe(1);
  });

  test('鳴らさないキー（修飾キーだけ、Cmd/Ctrl のショートカット、矢印などの移動、Escape、ファンクション）は要求を出さない', async ({ page }) => {
    await launchWith(page, 'abc\ndef', { typingSound: true });
    await warmUp(page);
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'ArrowLeft', 'ArrowUp', 'Home', 'End', 'PageUp', 'Escape', 'F7', 'ControlOrMeta+a', 'ControlOrMeta+ArrowLeft', 'Shift+ArrowRight']) {
      await pressSpaced(page, key);
    }
    expect(await requests(page)).toEqual([]);
    // そのあとでも、文字は 1 回ずつ要求になる。
    await pressSpaced(page, 'z');
    expect(await requests(page)).toHaveLength(1);
  });

  test('Enter は少し低い音（再生速度が 0.8 前後）で、要求の種類が違う', async ({ page }) => {
    await launchWith(page, 'abc', { typingSound: true });
    await warmUp(page);
    await pressSpaced(page, 'Enter');
    const [r] = await requests(page);
    expect(r!.kind).toBe('enter');
    expect(r!.rate).toBeGreaterThanOrEqual(0.8 * 0.96);
    expect(r!.rate).toBeLessThanOrEqual(0.8 * 1.04);
  });

  test('音量の段階（小・中・大）が gain の違いとして要求に出る。変えた次のキーから効く', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    const gains: number[] = [];
    for (const label of ['小', '中', '大'] as const) {
      await page.keyboard.press('ControlOrMeta+,');
      await dialog(page).getByTestId('settings-sound').getByRole('radio', { name: label }).check();
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toHaveCount(0);
      await focusEnd(page);
      const before = (await requests(page)).length;
      await pressSpaced(page, 'a');
      const after = await requests(page);
      expect(after).toHaveLength(before + 1);
      gains.push(after.at(-1)!.gain);
    }
    const [low, medium, high] = gains as [number, number, number];
    expect(low).toBeLessThanOrEqual(0.25 * 1.1);
    expect(medium).toBeGreaterThanOrEqual(0.5 * 0.9);
    expect(medium).toBeLessThanOrEqual(0.5 * 1.1);
    expect(high).toBeGreaterThanOrEqual(1 * 0.9);
    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  test('設定画面でオンにすると素材の読み込みが始まり、オフにすると以降の要求は出ない', async ({ page }) => {
    await launchWith(page, 'a');
    expect(await probe(page)).toMatchObject({ fetches: 0, contexts: 0 });
    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).check();
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    await page.keyboard.press('Escape');
    await warmUp(page);
    await pressSpaced(page, 'a');
    expect(await requests(page)).toHaveLength(1);

    await page.keyboard.press('ControlOrMeta+,');
    await dialog(page).getByRole('checkbox', { name: 'タイピング音' }).uncheck();
    await page.keyboard.press('Escape');
    await focusEnd(page);
    await pressSpaced(page, 'b');
    await pressSpaced(page, 'Enter');
    expect(await requests(page)).toHaveLength(1);
    // もう一度オンにしても、素材を読み直さない（読み込み済み）。
    expect((await probe(page))!.fetches).toBe(1);
  });

  test('キーの繰り返し（押し続け）は 30ms に 1 回までに間引かれる', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    // 繰り返しの keydown を、本文に短い間隔で送る（実際のキーの繰り返しと同じ repeat: true）。
    const sent = await page.evaluate(async () => {
      const content = document.querySelector('.cm-content')!;
      const start = performance.now();
      let n = 0;
      while (performance.now() - start < 300) {
        content.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true, cancelable: true }));
        n++;
        await new Promise((r) => setTimeout(r, 4));
      }
      return { n, ms: performance.now() - start };
    });
    const count = (await requests(page)).length;
    expect(sent.n).toBeGreaterThan(count);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(Math.floor(sent.ms / 30) + 1);
  });
});

test.describe('音色（キーボード、タイプライター）(R10)', () => {
  const pickTimbre = async (page: Page, label: 'キーボード' | 'タイプライター') => {
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await soundRadios(page).getByRole('radio', { name: label }).check();
    // 閉じるボタンで閉じる（WebKit は、ラジオをクリックしてもフォーカスが移らず、Escape が設定画面に届かない）。
    await page.getByTestId('settings-close').click();
    await expect(dialog(page)).toHaveCount(0);
    await focusEnd(page);
  };

  test('音色のラジオを操作すると保存され、再読み込み（起動し直し）のあとも残る。知らない保存値はキーボードに戻る', async ({ page }) => {
    await launchWith(page);
    await page.keyboard.press('ControlOrMeta+,');
    await soundRadios(page).getByRole('radio', { name: 'タイプライター' }).check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typingSound: false, typingSoundTimbre: 'typewriter' });
    await expect(soundRadios(page).getByRole('radio', { name: 'キーボード' })).not.toBeChecked();
    // オフのままなので、音色を変えても素材は読まない。
    expect(await probe(page)).toEqual(EMPTY_PROBE);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-ready', 'true');
    await page.keyboard.press('ControlOrMeta+,');
    await expect(soundRadios(page).getByRole('radio', { name: 'タイプライター' })).toBeChecked();
    await soundRadios(page).getByRole('radio', { name: 'キーボード' }).check();
    await expect.poll(() => savedPreferences(page)).toMatchObject({ typingSoundTimbre: 'keyboard' });
  });

  test('保存値が知らない値（型違いを含む）のときはキーボード（素材もキーボードを読む）', async ({ page }) => {
    const wavs = recordWavRequests(page);
    await launchWith(page, '', { typingSound: true, typingSoundTimbre: 'piano' });
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    expect((await probe(page))!.fetchedTimbres).toEqual(['keyboard']);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(soundRadios(page).getByRole('radio', { name: 'キーボード' })).toBeChecked();
    await expect.poll(() => wavs.filter(isKeyboardWav).length).toBe(10);
    expect(wavs.filter(isTypewriterWav)).toEqual([]);
  });

  test('オフの間は、音色が何でも、素材の fetch（ネットワーク）も AudioContext も音の要求もない', async ({ page }) => {
    const wavs = recordWavRequests(page);
    await launchWith(page, 'a', { typingSoundTimbre: 'typewriter' });
    await focusEnd(page);
    for (const key of ['b', 'Enter', 'Backspace', ' ']) await pressSpaced(page, key);
    await pickTimbre(page, 'キーボード');
    await pickTimbre(page, 'タイプライター');
    await pressSpaced(page, 'c');
    expect(await probe(page)).toEqual(EMPTY_PROBE);
    expect(wavs).toEqual([]);
  });

  test('タイプライターで起動すると、タイプライターの素材 8 個だけを fetch し、キー 1 回につき要求が 1 回', async ({ page }) => {
    const wavs = recordWavRequests(page);
    await launchWith(page, '', { typingSound: true, typingSoundTimbre: 'typewriter' });
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    expect((await probe(page))!.fetchedTimbres).toEqual(['typewriter']);
    await expect.poll(() => wavs.filter(isTypewriterWav).length).toBe(8);
    expect(new Set(wavs.filter(isTypewriterWav)).size).toBe(8);
    expect(wavs.filter(isKeyboardWav)).toEqual([]);
    expect(await probe(page)).toMatchObject({ contexts: 0, requests: [] });

    await warmUp(page, 8);
    expect((await probe(page))!.decodedTimbres).toEqual(['typewriter']);
    for (const key of ['a', 'b', ' ', 'Backspace', 'Delete', 'Tab']) await pressSpaced(page, key);
    await pressSpaced(page, 'Enter');
    const all = await requests(page);
    expect(all).toHaveLength(7);
    for (const r of all) {
      expect(r.timbre).toBe('typewriter');
      expect(r.index).toBeGreaterThanOrEqual(0);
      expect(r.index).toBeLessThan(8);
      // 同じ音量の段階（既定は中）に、音色ごとの gain（1.15）が掛かる。揺れは ±10%。
      expect(r.gain).toBeGreaterThanOrEqual(0.5 * 1.15 * 0.9);
      expect(r.gain).toBeLessThanOrEqual(0.5 * 1.15 * 1.1);
    }
    expect(all.map((r) => r.kind)).toEqual(['key', 'key', 'key', 'key', 'key', 'key', 'enter']);
    // 規則はキーボードと同じ: 高さ ±4%、Enter は 0.8 前後、直前と同じ素材は続かない。
    for (const r of all.slice(0, -1)) {
      expect(r.rate).toBeGreaterThanOrEqual(0.96);
      expect(r.rate).toBeLessThanOrEqual(1.04);
    }
    expect(all.at(-1)!.rate).toBeGreaterThanOrEqual(0.8 * 0.96);
    expect(all.at(-1)!.rate).toBeLessThanOrEqual(0.8 * 1.04);
    for (let i = 1; i < all.length; i++) expect(all[i]!.index).not.toBe(all[i - 1]!.index);
    expect((await probe(page))!.contexts).toBe(1);
    expect((await probe(page))!.fetches).toBe(1);
  });

  test('オン（キーボード）で使ってから設定画面でタイプライターを選ぶと、そのときにタイプライターの素材だけを読む。キーボードに戻すと、キーボードの素材で鳴る', async ({ page }) => {
    const wavs = recordWavRequests(page);
    await launchWith(page, '', { typingSound: true });
    await expect.poll(async () => (await probe(page))!.fetches).toBe(1);
    await expect.poll(() => wavs.length).toBe(10);
    await warmUp(page, 10);
    await pressSpaced(page, 'a');
    expect((await requests(page)).map((r) => r.timbre)).toEqual(['keyboard']);

    // タイプライターへ: そのとき、タイプライターの 8 個だけを読む（キーボードは読み直さない）。
    await pickTimbre(page, 'タイプライター');
    await expect.poll(async () => (await probe(page))!.fetches).toBe(2);
    expect((await probe(page))!.fetchedTimbres).toEqual(['keyboard', 'typewriter']);
    await expect.poll(() => wavs.length).toBe(18);
    expect(wavs.slice(10).every(isTypewriterWav)).toBe(true);
    expect(new Set(wavs.slice(10)).size).toBe(8);
    // 切り替えの直後のキーは、デコードが終わるまで鳴らなくてよい。終わるのを待ってから、キー 1 回につき要求が 1 回。
    await expect.poll(async () => (await probe(page))!.decoded).toBe(2);
    expect((await probe(page))!.decodedTimbres).toEqual(['keyboard', 'typewriter']);
    expect((await probe(page))!.decodedCount).toBe(8);
    const before = (await requests(page)).length;
    for (const key of ['b', 'c', 'd']) await pressSpaced(page, key);
    const afterSwitch = (await requests(page)).slice(before);
    expect(afterSwitch.map((r) => r.timbre)).toEqual(['typewriter', 'typewriter', 'typewriter']);
    expect(afterSwitch.every((r) => r.index < 8)).toBe(true);

    // キーボードに戻す: 読み直さず、キーボードの素材（10 個のどれか）で鳴る。
    await pickTimbre(page, 'キーボード');
    const mark = (await requests(page)).length;
    for (const key of ['e', 'f', 'g']) await pressSpaced(page, key);
    const back = (await requests(page)).slice(mark);
    expect(back.map((r) => r.timbre)).toEqual(['keyboard', 'keyboard', 'keyboard']);
    expect((await probe(page))!.fetches).toBe(2);
    expect(wavs).toHaveLength(18);
    expect((await probe(page))!.contexts).toBe(1);
  });

  test('切り替えの直後でも、キー 1 回につき要求は 1 回を超えない（デコード前のキーは鳴らないだけ）', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page, 10);
    await pickTimbre(page, 'タイプライター');
    const before = (await requests(page)).length;
    const keys = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const key of keys) await pressSpaced(page, key);
    const added = (await requests(page)).slice(before);
    expect(added.length).toBeLessThanOrEqual(keys.length);
    expect(added.every((r) => r.timbre === 'typewriter')).toBe(true);
    // デコードが終わったあとは、必ず 1 回ずつ。
    await expect.poll(async () => (await probe(page))!.decoded).toBe(2);
    const mark = (await requests(page)).length;
    for (const key of keys) await pressSpaced(page, key);
    expect((await requests(page)).length - mark).toBe(keys.length);
  });
});

test.describe('鳴り始めの位置と、keydown から start までの時間 (R10)', () => {
  for (const timbre of ['keyboard', 'typewriter'] as const) {
    test(`${timbre}: 素材ごとの鳴り始めの位置が、ファイルの標本から求めた期待値と一致し、keydown から start までが 5ms 未満`, async ({ page }, testInfo) => {
      await launchWith(page, '', { typingSound: true, typingSoundTimbre: timbre });
      await warmUp(page, TIMBRE_FILES[timbre].count);
      const expected = expectedOffsets(timbre);

      // デコード時に求めた位置（素材ごと、すべて）が、期待値と一致する（デコードで標本化周波数が変わる分の幅は許す）。
      const decoded = (await probe(page))!.decodedOffsets[timbre]!;
      expect(decoded).toHaveLength(expected.length);
      decoded.forEach((offset, i) => expect(Math.abs(offset - expected[i]!), `${timbre} #${i}: ${offset} vs ${expected[i]}`).toBeLessThanOrEqual(OFFSET_TOLERANCE_S[timbre]));

      // 実際に start に渡した位置が、鳴らした素材の位置と同じ。
      for (let i = 0; i < 24; i++) await pressSpaced(page, i % 5 === 4 ? 'Enter' : 'abcdefghij'[i % 10]!);
      const all = await requests(page);
      expect(all).toHaveLength(24);
      for (const r of all) {
        expect(r.timbre).toBe(timbre);
        expect(r.offset, `index ${r.index}`).toBe(decoded[r.index]);
        expect(Math.abs(r.offset - expected[r.index]!)).toBeLessThanOrEqual(OFFSET_TOLERANCE_S[timbre]);
        expect(r.startDelayMs, `index ${r.index}`).toBeGreaterThanOrEqual(0);
        expect(r.startDelayMs, `index ${r.index}`).toBeLessThan(5);
      }
      if (timbre === 'typewriter') expect(Math.max(...decoded)).toBeLessThan(0.0065);
      if (timbre === 'keyboard') {
        // 頭の無音が長い素材（約 35 ms から 53 ms）は、その分を飛ばす。
        expect(Math.max(...decoded)).toBeGreaterThan(0.04);
        expect(decoded.filter((o) => o > 0.01).length).toBeGreaterThanOrEqual(8);
      }

      const last = all.at(-1)!;
      const report = {
        browser: testInfo.project.name,
        timbre,
        offsetsMs: decoded.map((o) => Math.round(o * 10000) / 10),
        expectedMs: expected.map((o) => Math.round(o * 10000) / 10),
        maxStartDelayMs: Math.max(...all.map((r) => r.startDelayMs)),
        baseLatency: last.baseLatency,
        outputLatency: last.outputLatency,
      };
      console.log(`[typing-sound R10] ${JSON.stringify(report)}`);
      await testInfo.attach(`latency-${timbre}.json`, { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    });
  }

  test('AudioContext は latencyHint: "interactive" で作られる', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { AudioContext?: new (...a: unknown[]) => unknown; webkitAudioContext?: new (...a: unknown[]) => unknown; __audioContextArgs?: unknown[][] };
      const Original = w.AudioContext ?? w.webkitAudioContext;
      if (!Original) return;
      w.__audioContextArgs = [];
      w.AudioContext = class extends (Original as new (...a: unknown[]) => object) {
        constructor(...args: unknown[]) {
          super(...args);
          w.__audioContextArgs!.push(args);
        }
      } as never;
    });
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    expect(await page.evaluate(() => (window as unknown as { __audioContextArgs?: unknown[][] }).__audioContextArgs)).toEqual([[{ latencyHint: 'interactive' }]]);
  });
});

test.describe('入力は変わらない (Q2)', () => {
  test('入力した文字と Backspace がそのまま入る（オンのとき）', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('hello, 世界');
    expect(await text(page)).toBe('hello, 世界');
    await page.keyboard.press('Backspace');
    expect(await text(page)).toBe('hello, 世');
    await expect(unsavedMark(page)).toBeVisible();
  });

  test('Enter でリストの項目が続き、続けて書いた文字が新しい項目に入る（オンのとき）', async ({ page }) => {
    await launchWith(page, '- 一つ目\n  - 入れ子', { typingSound: true });
    await warmUp(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+End');
    await pressSpaced(page, 'Enter');
    expect(await text(page)).toBe('- 一つ目\n  - 入れ子\n  - ');
    await page.keyboard.type('次');
    expect(await text(page)).toBe('- 一つ目\n  - 入れ子\n  - 次');
    // Enter はリストの継続が処理しても、音の要求は出る（1 回）。
    const enters = (await requests(page)).filter((r) => r.kind === 'enter');
    expect(enters).toHaveLength(1);
  });

  test('ショートカット（保存、設定画面）の振る舞いは変わらず、要求も出ない', async ({ page }) => {
    await launchWith(page, '', { typingSound: true });
    await warmUp(page);
    await page.keyboard.type('保存する');
    await expect(unsavedMark(page)).toBeVisible();
    const before = (await requests(page)).length;
    await page.waitForTimeout(45);
    await page.keyboard.press('ControlOrMeta+s');
    await expect(unsavedMark(page)).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+,');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    expect((await requests(page)).length).toBe(before);
    expect(await page.evaluate(() => window.__mdeE2E!.readFile('/docs/sound.md'))).toEqual(utf8('x保存する'));
  });

  test('日本語入力: 変換中の keydown（key が Process、keyCode が 229）は 1 回の要求になり、変換と確定は壊れない', async ({ page }) => {
    await launchWith(page, '前。', { typingSound: true });
    await warmUp(page);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ControlOrMeta+End');
    const client: CDPSession = await page.context().newCDPSession(page);
    const before = (await requests(page)).length;

    // 変換中のキー: 実ブラウザの IME が送る keydown（Process、229）を、CDP で本物のキーイベントとして送る。
    await page.waitForTimeout(45);
    await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: 'KeyN', windowsVirtualKeyCode: 229 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78 });
    expect((await requests(page)).length).toBe(before + 1);

    for (const reading of ['に', 'にほ', 'にほん', 'にほんご']) {
      await client.send('Input.imeSetComposition', { text: reading, selectionStart: reading.length, selectionEnd: reading.length });
      expect(await text(page)).toBe(`前。${reading}`);
    }
    await client.send('Input.insertText', { text: '日本語' });
    expect(await text(page)).toBe('前。日本語');
    // 変換の操作そのもの（imeSetComposition、insertText）は keydown ではないので、要求にならない。
    expect((await requests(page)).length).toBe(before + 1);
  });
});
