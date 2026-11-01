// 計測データ A〜D（仕様 §9.2）。scripts/gen-fixtures.mjs が決定論的に作る。このファイルは呼び出すだけ。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OUT_DIR, ROOT, ensureDir, rel } from './util.mjs';

const PERF_FIXTURES = path.join(ROOT, 'phase0', 'fixtures', 'perf');
const MANIFEST = path.join(PERF_FIXTURES, 'manifest.json');
const GENERATED = path.join(OUT_DIR, 'fixtures');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * A〜D のファイルの絶対パスと manifest の sha256 を返す。
 * phase0/fixtures/perf にあって sha256 が manifest と一致すればそれを使う。
 * なければ（C は gitignore 対象）scripts/gen-fixtures.mjs を --out perf/out/fixtures で呼ぶ。
 * その呼び出しは phase0/fixtures/perf/manifest.json も上書きするので、呼ぶ前の内容へ戻す。
 */
export function ensureFixtures() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const result = [];
  let generated = false;
  for (const d of manifest.datasets) {
    let file = path.join(PERF_FIXTURES, d.file);
    const ok = (f) => fs.existsSync(f) && sha256(fs.readFileSync(f)) === d.sha256;
    if (!ok(file)) {
      if (!generated) {
        ensureDir(GENERATED);
        const before = fs.readFileSync(MANIFEST);
        const r = spawnSync('node', [path.join(ROOT, 'scripts', 'gen-fixtures.mjs'), '--out', rel(GENERATED)], { cwd: ROOT, encoding: 'utf8' });
        try {
          if (!fs.readFileSync(MANIFEST).equals(before)) fs.writeFileSync(MANIFEST, before);
        } catch {
          // 読み取り専用の環境では、gen-fixtures の manifest 書き込みが失敗する。fixture 自体は先に書かれている。
        }
        generated = true;
        if (r.status !== 0 && !fs.existsSync(path.join(GENERATED, d.file))) throw new Error(`gen-fixtures.mjs に失敗しました: ${r.stderr}`);
      }
      file = path.join(GENERATED, d.file);
      if (!ok(file)) throw new Error(`${d.file} の sha256 が manifest と一致しません（Node の版が違う可能性）`);
    }
    result.push({ id: d.id, file, name: d.file, bytes: d.bytes, chars: d.chars, sha256: d.sha256, description: d.description });
  }
  return result;
}
