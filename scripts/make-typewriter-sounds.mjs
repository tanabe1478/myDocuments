#!/usr/bin/env node
// タイピング音の「タイプライター」の素材を、CC0 の録音（8 個）から作る（依存なし）。
// 使い方（リポジトリのルートで）:
//   node scripts/make-typewriter-sounds.mjs           original/ の 8 個から、加工後の 8 個を sounds/typewriter/ に書く
//   node scripts/make-typewriter-sounds.mjs --check   作り直した結果が、同梱のファイルとバイト列で一致するか確かめる（違えば exit 1）
// 出典と加工の内容は src/features/typing-sound/sounds/typewriter/README.md。
//
// 加工（M1-mild）: 2ch は平均して 1ch → 1 次の IIR のローパス（3500 Hz）を 2 回 → 打撃の尖りを縮める（soften 0.4）→
// 最初に最大値の 25% を超えた点の 8ms 前から 0.22 秒を切り出し、最後の 60ms を二乗のフェードで消す → [-1, 1] に clip して
// 32767 倍し、int16 に切り捨てる。出力は 1ch、16bit、元と同じ標本化周波数。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPEWRITER_DIR = path.join(ROOT, 'src', 'features', 'typing-sound', 'sounds', 'typewriter');
const ORIGINAL_DIR = path.join(TYPEWRITER_DIR, 'original');

/** 元の録音（Cassie-OrbitGames、CC0）の SHA-256。使う前に確かめる。 */
const ORIGINALS = [
  ['typewriter1.wav', 'f860766aa7922afbf1523ea1a41504c64f3f6362fa03a60b6497c75c1d0d0344'],
  ['typewriter2.wav', 'b40c17fe45c9e3a6ad8a617f7831da5ccb3c8baab1fa0eb368f8ba3ade52c8a4'],
  ['typewriter3.wav', 'c9bb2c6245bdd60b996fe39f2fb74c810309ee03bbe2d8ae1ee6715888df9c69'],
  ['typewriter4.wav', '28d4c07732fbd6f324f257c27a92d8a3c14ea5c26517972295b288bb75d5a2c3'],
  ['typewriter5.wav', 'f52a889a483985d40ca31ed97ddd86227a776650f4666f5899c86dfec6de2edf'],
  ['typewriter6.wav', '825b668508448212edbf8ddcff2801b0a6251528aaccdf8ab85427023cf0797f'],
  ['typewriter7.wav', '113210a80c394cb3ad0d8b7d773ff752b81cb42bb193efb4d11eb8379f736144'],
  ['typewriter8.wav', 'c29966383e602df84db68577758e34f830deb01aff6a208579ee943511217118'],
];

/** M1-mild の値。 */
const PARAMS = { lowpassHz: 3500, soften: 0.4, keepSeconds: 0.22 };

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** 16bit PCM の WAV を読む。2ch 以上は平均して 1ch にする。返す標本は [-1, 1) の範囲（int16 / 32768）。 */
export function readWav(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('RIFF/WAVE ではありません');
  let fmt = null;
  let data = null;
  for (let p = 12; p + 8 <= buf.length; ) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(buf.length, body + size));
    }
    p = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('fmt または data のチャンクがありません');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`16bit PCM ではありません（format ${fmt.format}、${fmt.bits}bit）`);
  const frames = Math.floor(data.length / (2 * fmt.channels));
  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) sum += data.readInt16LE((i * fmt.channels + c) * 2) / 32768;
    samples[i] = fmt.channels > 1 ? sum / fmt.channels : sum;
  }
  return { samples, sampleRate: fmt.sampleRate };
}

/** 1ch、16bit PCM の WAV（44 バイトのヘッダー）にする。[-1, 1] に clip して 32767 倍し、0 に向けて切り捨てる。 */
export function writeWav(samples, sampleRate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.min(1, Math.max(-1, samples[i]));
    out.writeInt16LE(Math.trunc(v * 32767), 44 + i * 2);
  }
  return out;
}

/** 1 次の IIR のローパス（y[i] = (1 - a) * x[i] + a * y[i - 1]、a = exp(-2π cutoff / sr)）を passes 回掛ける。初期値は 0。 */
export function lowpass(x, cutoff, sampleRate, passes = 2) {
  const a = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  let cur = x;
  for (let k = 0; k < passes; k++) {
    const y = new Float64Array(cur.length);
    let prev = 0;
    for (let i = 0; i < cur.length; i++) {
      prev = (1 - a) * cur[i] + a * prev;
      y[i] = prev;
    }
    cur = y;
  }
  return cur;
}

/** 打撃の瞬間の尖りだけを抑える（速い包絡が遅い包絡より大きい分を縮める）。 */
export function soften(x, sampleRate, amount) {
  const abs = x.map(Math.abs);
  const fast = lowpass(abs, 400, sampleRate, 1);
  const slow = lowpass(abs, 30, sampleRate, 1);
  const gain = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) gain[i] = Math.max(fast[i] / (slow[i] + 1e-4), 1) ** -amount;
  const smooth = lowpass(gain, 200, sampleRate, 1);
  return x.map((v, i) => v * smooth[i]);
}

/** 最初の打撃（最初に最大値の 25% を超えた点）の 8ms 前から keepSeconds 秒を切り出し、最後の 60ms を二乗のフェードで消す。 */
export function firstStrike(x, sampleRate, keepSeconds) {
  let max = 0;
  for (const v of x) max = Math.max(max, Math.abs(v));
  let hit = 0;
  while (hit < x.length && !(Math.abs(x[hit]) > 0.25 * max)) hit++;
  if (hit === x.length) hit = 0;
  const start = Math.max(0, hit - Math.trunc(0.008 * sampleRate));
  const seg = Float64Array.from(x.subarray(start, start + Math.trunc(keepSeconds * sampleRate)));
  const fade = Math.trunc(0.06 * sampleRate);
  const step = -1 / (fade - 1);
  for (let k = 0; k < fade; k++) {
    const line = k === fade - 1 ? 0 : k * step + 1;
    seg[seg.length - fade + k] *= line * line;
  }
  return seg;
}

/** 元の WAV 1 つから、加工後の WAV のバイト列を作る。 */
export function makeStrike(originalBytes) {
  const { samples, sampleRate } = readWav(originalBytes);
  const softened = soften(lowpass(samples, PARAMS.lowpassHz, sampleRate), sampleRate, PARAMS.soften);
  return writeWav(firstStrike(softened, sampleRate, PARAMS.keepSeconds), sampleRate);
}

const outputName = (index) => `typewriter-${index + 1}.wav`;

function loadOriginals() {
  return ORIGINALS.map(([name, expected]) => {
    const file = path.join(ORIGINAL_DIR, name);
    const bytes = fs.readFileSync(file);
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`${name} の SHA-256 が違います（期待 ${expected}、実際 ${actual}）`);
    return bytes;
  });
}

function main() {
  const check = process.argv.slice(2).includes('--check');
  const outputs = loadOriginals().map(makeStrike);
  if (check) {
    let bad = 0;
    outputs.forEach((bytes, i) => {
      const name = outputName(i);
      const file = path.join(TYPEWRITER_DIR, name);
      const existing = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const same = existing !== null && existing.equals(bytes);
      if (!same) bad++;
      console.log(`${same ? 'OK  ' : 'NG  '} ${name} ${sha256(bytes)}${same ? '' : existing ? '（同梱のファイルと違う）' : '（同梱のファイルがない）'}`);
    });
    console.log(bad === 0 ? `OK: ${outputs.length} 個とも、作り直した結果が同梱のファイルとバイト列で一致` : `NG: ${bad} 個が一致しない`);
    process.exit(bad === 0 ? 0 : 1);
  }
  outputs.forEach((bytes, i) => {
    fs.writeFileSync(path.join(TYPEWRITER_DIR, outputName(i)), bytes);
    console.log(`${outputName(i)} ${bytes.length} バイト ${sha256(bytes)}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
