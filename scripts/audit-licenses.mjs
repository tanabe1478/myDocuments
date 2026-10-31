#!/usr/bin/env node
// Phase 0 P0-4: enumerate npm + cargo dependency licenses of the cloned MDE.
// Usage: node scripts/audit-licenses.mjs      Output: phase0/results/licenses.json
// Needs: phase0/vendor/MDE with `npm ci` done, and `cargo metadata` working (crates already fetched).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mde = resolve(root, 'phase0/vendor/MDE');
const rd = (p) => JSON.parse(readFileSync(p, 'utf8'));
const mdeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: mde, encoding: 'utf8' }).trim();

// ---- license classification -------------------------------------------------
const PERMISSIVE = /^(mit|mit-0|isc|bsd-[0-9]-clause.*|bsd|0bsd|apache-2\.0|apache-1\.1|zlib|unlicense|cc0-1\.0|blueoak-1\.0\.0|python-2\.0|bsl-1\.0|unicode-3\.0|unicode-dfs-2016|wtfpl|libpng-2\.0|ncsa|curl|x11|hpnd.*)$/i;
const NO_ATTRIBUTION = /^(0bsd|unlicense|cc0-1\.0|wtfpl|mit-0)$/i;
const WEAK = /^(mpl-.*|lgpl-.*|epl-.*|cddl-.*|cpl-.*|eupl-.*)$/i;
const STRONG = /^(gpl-.*|agpl-.*|sspl-.*|osl-.*)(\+|-only|-or-later)?$/i;
const OTHER_NOTICE = /^(cc-by-.*|ofl-.*|ccby.*)$/i;
const SEVERITY = ['permissive', 'weak-copyleft', 'notice-required-other', 'strong-copyleft', 'unknown'];

function classifyId(id) {
  const t = id.trim().replace(/^\(|\)$/g, '').replace(/\+$/, '');
  if (!t) return 4;
  if (PERMISSIVE.test(t)) return 0;
  if (WEAK.test(t)) return 1;
  if (OTHER_NOTICE.test(t)) return 2;
  if (STRONG.test(t)) return 3;
  return 4;
}
// SPDX expression: OR = licensee may choose (take the least restrictive), AND = all apply (take the most restrictive).
function classifyExpr(expr) {
  if (!expr) return { sev: 4, attribution: true };
  const e = expr.replace(/\s+WITH\s+[\w.-]+/gi, '');
  const ors = e.split(/\s+OR\s+|\s*\/\s*/i).map((s) => s.trim());
  const orSev = ors.map((o) => {
    const ands = o.replace(/[()]/g, '').split(/\s+AND\s+/i);
    return Math.max(...ands.map(classifyId));
  });
  const sev = Math.min(...orSev);
  const allIds = e.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+|\s*\/\s*/i).map((s) => s.trim());
  const attribution = !allIds.every((i) => NO_ATTRIBUTION.test(i));
  return { sev, attribution };
}
const category = (sev) => SEVERITY[sev];

// ---- npm --------------------------------------------------------------------
const pkgJson = rd(resolve(mde, 'package.json'));
const lock = rd(resolve(mde, 'package-lock.json'));
const directProd = new Set(Object.keys(pkgJson.dependencies ?? {}));
const directDev = new Set(Object.keys(pkgJson.devDependencies ?? {}));
const packages = [];

function npmLicense(dir, entry) {
  const p = resolve(mde, dir, 'package.json');
  let lic = entry.license;
  let src = 'package-lock.json';
  if (existsSync(p)) {
    const j = rd(p);
    const l = j.license ?? j.licenses;
    if (typeof l === 'string') { lic = l; src = 'node_modules package.json'; }
    else if (l?.type) { lic = l.type; src = 'node_modules package.json'; }
    else if (Array.isArray(l)) { lic = '(' + l.map((x) => x.type ?? x).join(' OR ') + ')'; src = 'node_modules package.json'; }
  }
  return { lic, src };
}
function licenseFileHead(dir) {
  const full = resolve(mde, dir);
  if (!existsSync(full)) return null;
  const f = readdirSync(full).find((n) => /^(licen[cs]e|copying)/i.test(n));
  return f ? readFileSync(resolve(full, f), 'utf8').split('\n').slice(0, 3).join(' ').trim().slice(0, 120) : null;
}

for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path) continue;
  const name = path.replace(/^.*node_modules\//, '');
  const { lic: lic0, src } = npmLicense(path, entry);
  let lic = lic0;
  let licNote;
  if (!lic) {
    const head = licenseFileHead(path);
    if (head && /^(the )?mit license/i.test(head)) { lic = 'MIT'; licNote = 'package.json に license フィールドなし。LICENSE ファイル先頭の "The MIT License" から MIT と判断'; }
  }
  const c = classifyExpr(lic);
  const scope = entry.dev ? 'dev' : entry.optional ? 'optional' : 'prod';
  packages.push({
    ecosystem: 'npm', name, version: entry.version, license: lic ?? null, licenseSource: src,
    direct: path === `node_modules/${name}` && (directProd.has(name) || directDev.has(name)),
    scope: directProd.has(name) && path === `node_modules/${name}` ? 'prod' : directDev.has(name) && path === `node_modules/${name}` ? 'dev' : scope,
    category: category(c.sev), attributionRequired: c.attribution,
    licenseFileHead: c.sev >= 1 || !lic ? licenseFileHead(path) : undefined,
    note: licNote,
  });
}

// ---- cargo ------------------------------------------------------------------
const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', resolve(mde, 'src-tauri/Cargo.toml'), '--locked'], { encoding: 'utf8', maxBuffer: 1 << 29 }));
const rootPkg = meta.packages.find((p) => p.id === meta.resolve.root);
const directCargo = new Map(rootPkg.dependencies.map((d) => [d.name, d.kind ?? 'normal']));
// Which crates are actually compiled for macOS arm64 (normal deps, target-filtered).
const darwin = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', resolve(mde, 'src-tauri/Cargo.toml'), '--locked', '--filter-platform', 'aarch64-apple-darwin'], { encoding: 'utf8', maxBuffer: 1 << 29 }));
const darwinIds = new Set(darwin.resolve.nodes.map((n) => n.id));
const darwinNames = new Set(darwin.packages.filter((p) => darwinIds.has(p.id)).map((p) => `${p.name}@${p.version}`));
for (const p of meta.packages) {
  if (p.id === meta.resolve.root) continue;
  const c = classifyExpr(p.license);
  packages.push({
    ecosystem: 'cargo', name: p.name, version: p.version, license: p.license ?? (p.license_file ? `file:${p.license_file}` : null),
    licenseSource: 'cargo metadata', direct: directCargo.has(p.name),
    scope: directCargo.get(p.name) === 'build' ? 'build' : darwinNames.has(`${p.name}@${p.version}`) ? 'macos-arm64-resolved' : 'other-target-or-dev',
    category: category(c.sev), attributionRequired: c.attribution,
  });
}

// ---- assets -----------------------------------------------------------------
const assets = [
  { kind: 'icon', path: 'src-tauri/icons/*', note: 'MDE 独自のロゴ画像（src-tauri/icons/icon.png を目視確認：白灰の「MDE」ロゴ）。フォークでも製品名・ロゴとして再利用しないこと。権利者表記は LICENSE（MIT, MDE Contributors）以外に見当たらない（未確認：画像生成元・第三者素材の有無）' },
  { kind: 'image', path: 'public/tauri.svg, public/vite.svg', note: 'Tauri / Vite のテンプレート由来ロゴ。vite.svg は index.html:5 で favicon として参照、tauri.svg は src・index.html から参照なし。どちらもフォークでは削除対象' },
  { kind: 'font', path: '(MDE リポジトリ内に @font-face・フォントファイルなし)', note: 'CSS は Inter / Cascadia Code 等を名前指定するのみ（src/editor/milkdown-dark.css:14,51）。同梱はしない' },
  { kind: 'audio', path: '(なし)', note: 'git ls-files に音声ファイルなし' },
  { kind: 'video', path: '(なし)', note: 'git ls-files に動画ファイルなし' },
];
let katex = null;
const distAssets = resolve(mde, 'dist/assets');
if (existsSync(distAssets)) {
  const fonts = readdirSync(distAssets).filter((f) => /\.(woff2?|ttf|otf)$/.test(f));
  const fam = [...new Set(fonts.map((f) => (f.match(/^(KaTeX_[A-Za-z0-9]+-[A-Za-z]+)/) ?? [null, f])[1]))].sort();
  katex = { fontFiles: fonts.length, families: fam.length, sample: fam.slice(0, 5) };
  assets.push({ kind: 'font', path: 'npm run build の dist/assets/*', note: `KaTeX フォント ${fonts.length} ファイル（${fam.length} ファミリ）がビルド成果物に含まれる。由来は npm 依存 katex。katex パッケージは MIT。ただし node_modules/katex/dist/katex.js:6977 に「SIL Open Font License 1.1」と書かれた箇所があり、フォントファイル個別のライセンスは未確認`, detail: katex });
}
const katexPkg = existsSync(resolve(mde, 'node_modules/katex/package.json')) ? rd(resolve(mde, 'node_modules/katex/package.json')) : null;
if (katexPkg) assets.at(-1).katexPackageLicense = katexPkg.license;

// ---- summary ----------------------------------------------------------------
const count = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
const npm = packages.filter((p) => p.ecosystem === 'npm');
const cargo = packages.filter((p) => p.ecosystem === 'cargo');
const flagged = packages.filter((p) => p.category !== 'permissive' || p.license === null).map(({ ecosystem, name, version, license, scope, direct, category, licenseFileHead }) => ({ ecosystem, name, version, license, scope, direct, category, licenseFileHead }));
const out = {
  mdeCommit,
  generatedAt: new Date().toISOString(),
  command: 'node scripts/audit-licenses.mjs',
  mdeOwnLicense: { file: 'LICENSE', spdx: 'MIT', holder: 'MDE Contributors', year: 2026 },
  method: 'npm: package-lock.json の全エントリ（推移依存含む）を node_modules/*/package.json の license で補完。cargo: cargo metadata --locked（全ターゲット）と --filter-platform aarch64-apple-darwin。SPDX 式は OR=最も緩い選択肢、AND=最も厳しい要素で分類。classification はこのスクリプトの簡易判定であり法的判断ではない。',
  summary: {
    npm: { total: npm.length, prodScope: npm.filter((p) => p.scope === 'prod').length, devScope: npm.filter((p) => p.scope === 'dev').length, byLicense: sortObj(count(npm, (p) => p.license ?? 'UNKNOWN')), byCategory: count(npm, (p) => p.category) },
    cargo: { total: cargo.length, macosArm64Resolved: cargo.filter((p) => p.scope === 'macos-arm64-resolved' || p.scope === 'build').length, byLicense: sortObj(count(cargo, (p) => p.license ?? 'UNKNOWN')), byCategory: count(cargo, (p) => p.category) },
    flaggedCount: flagged.length,
  },
  flagged,
  assets,
  packages,
};
writeFileSync(resolve(root, 'phase0/results/licenses.json'), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out.summary, null, 1).slice(0, 3500));
