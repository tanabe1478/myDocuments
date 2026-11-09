#!/usr/bin/env node
// Linux の Tauri デスクトップアプリ（debug ビルド）を、tauri-driver（WebKitGTK の WebDriver）で操作し、窓の中を撮影する。
// macOS の tauri.mjs と違い、実際の窓へキー入力・クリックを送れる（WebDriver 経由。OS の入力の注入ではない）。
// 使い方:
//   node .pi/skills/verify-mydocuments/scripts/tauri-linux.mjs setup                                   tauri-driver と WebKitWebDriver を確かめ、なければ sudo なしで用意する
//   node .pi/skills/verify-mydocuments/scripts/tauri-linux.mjs drive --run-id <id> --scenario <json> [--name <label>]
// 実行ファイルは tauri.mjs build（build だけは Linux でも使える）で先に作る。
// HOME と XDG_CONFIG_HOME / XDG_DATA_HOME / XDG_CACHE_HOME を <run>/tauri-home へ向ける（アプリのデータ領域は <run>/tauri-home/.local/share/<identifier>/）。
// 隔離の確認は 2 つ: (1) 起動したアプリの /proc/<pid>/environ の HOME が run 専用か、(2) アプリ自身が run 側のデータ領域に書いたエントリがあるか。
// 加えて、実ユーザーのホームにある既知の場所の署名が drive の前後で同じことを見る。どれかが外れたら exit 1。
// scenario の形式は SKILL.md の「Linux の Tauri の窓」節。証跡は <run>/evidence/tauri-linux/<name>/（observations.json、*.png）。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ARTIFACTS, ROOT, TAURI_BIN, fail, parseArgs, rel, resolveRun, sleep, treeSignature, writeState } from './lib.mjs';

if (process.platform !== 'linux') fail('tauri-linux.mjs は Linux 専用です（macOS は tauri.mjs）。');
const args = parseArgs(process.argv.slice(2));
const sub = args._[0];
const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const IDENTIFIER = conf.identifier;
const BIN_NAME = path.basename(TAURI_BIN);
// sudo なしで展開した WebKitWebDriver の置き場所（artifacts/ は gitignore 済み）。
const TOOLS = path.join(ARTIFACTS, '.tools');
const LOCAL_WEBDRIVER = path.join(TOOLS, 'webkitgtk-webdriver', 'usr', 'bin', 'WebKitWebDriver');

/** PATH と ~/.cargo/bin から実行ファイルを探す。 */
function which(name, extra = []) {
  const dirs = [...(process.env.PATH ?? '').split(':'), ...extra];
  return dirs.map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) ?? null;
}
const tauriDriver = () => which('tauri-driver', [path.join(os.homedir(), '.cargo', 'bin')]);
const nativeDriver = () => which('WebKitWebDriver') ?? (fs.existsSync(LOCAL_WEBDRIVER) ? LOCAL_WEBDRIVER : null);
const dpkgVersion = (pkg) => {
  const r = spawnSync('dpkg-query', ['-W', '-f=${Version}', pkg], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};

if (sub === 'setup') {
  if (tauriDriver()) console.log(`tauri-driver: ${tauriDriver()}`);
  else {
    console.log('cargo install tauri-driver --locked ...');
    const r = spawnSync('cargo', ['install', 'tauri-driver', '--locked'], { stdio: 'inherit', timeout: 900_000 });
    if (r.status !== 0 || !tauriDriver()) fail('tauri-driver を入れられませんでした（cargo が必要。rustup で入れる）。');
  }
  const lib = dpkgVersion('libwebkit2gtk-4.1-0');
  if (!lib) fail('libwebkit2gtk-4.1-0 がありません。Tauri の Linux の依存（libwebkit2gtk-4.1-dev ほか。CI の Install Linux system dependencies と同じ）を入れてください。');
  if (!nativeDriver()) {
    // webkitgtk-webdriver の .deb を取得して展開するだけ（システムには入れない）。版はインストール済みの WebKitGTK と揃える。
    const work = path.join(TOOLS, 'deb');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const dl = spawnSync('apt-get', ['download', `webkitgtk-webdriver=${lib}`], { cwd: work, stdio: 'inherit', timeout: 120_000 });
    if (dl.status !== 0) fail(`webkitgtk-webdriver ${lib} を取得できませんでした（universe のリポジトリが必要）。`);
    const deb = fs.readdirSync(work).find((f) => f.endsWith('.deb'));
    const x = spawnSync('dpkg-deb', ['-x', path.join(work, deb), path.join(TOOLS, 'webkitgtk-webdriver')], { stdio: 'inherit' });
    if (x.status !== 0 || !fs.existsSync(LOCAL_WEBDRIVER)) fail('webkitgtk-webdriver の展開に失敗しました。');
  }
  console.log(`WebKitWebDriver: ${rel(nativeDriver()).startsWith('..') ? nativeDriver() : rel(nativeDriver())}（libwebkit2gtk-4.1-0 ${lib}）`);
  if (!fs.existsSync(TAURI_BIN)) console.log(`実行ファイルがまだありません: ${rel(TAURI_BIN)}。tauri.mjs build で作ってください。`);
  process.exit(0);
}
if (sub !== 'drive') fail('サブコマンドは setup / drive のいずれか。');

// ---- drive ----
if (!tauriDriver() || !nativeDriver()) fail('tauri-driver または WebKitWebDriver がありません。先に tauri-linux.mjs setup を実行してください。');
if (!fs.existsSync(TAURI_BIN)) fail(`実行ファイルがありません: ${rel(TAURI_BIN)}。先に tauri.mjs build を実行してください。`);
if (typeof args.scenario !== 'string') fail('--scenario <scenario.json> が必要です。');
const scenarioPath = path.resolve(ROOT, args.scenario);
if (!fs.existsSync(scenarioPath)) fail(`scenario がありません: ${args.scenario}`);
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const name = typeof args.name === 'string' ? args.name : path.basename(scenarioPath, '.json');
// Tauri だけを動かす run は launch.mjs を経ないので、run ディレクトリと state.json がなければ作る。
const { runDir, statePath } = resolveRun(args, { mustExist: false });
fs.mkdirSync(runDir, { recursive: true });
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const outDir = path.join(runDir, 'evidence', 'tauri-linux', name);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 文書とフォルダは run の中の files/ に作る（scenario のパスはここからの相対）。実ユーザーのフォルダは使わない。
const home = path.join(runDir, 'tauri-home');
const filesDir = path.join(runDir, 'files', name);
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(filesDir, { recursive: true, force: true });
const xdg = { XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CACHE_HOME: path.join(home, '.cache') };
const dataDir = path.join(xdg.XDG_DATA_HOME, IDENTIFIER);
const configDir = path.join(xdg.XDG_CONFIG_HOME, IDENTIFIER);
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });
const inFiles = (p) => {
  const abs = path.resolve(filesDir, p);
  if (!abs.startsWith(filesDir + path.sep) && abs !== filesDir) fail(`scenario のパスが run の files/ の外を指しています: ${p}`);
  return abs;
};
const seed = scenario.seed ?? {};
for (const [p, text] of Object.entries(seed.files ?? {})) {
  fs.mkdirSync(path.dirname(inFiles(p)), { recursive: true });
  fs.writeFileSync(inFiles(p), text);
}
for (const d of seed.emptyFolders ?? []) fs.mkdirSync(inFiles(d), { recursive: true });
const session = {};
if (seed.doc) session.lastPath = inFiles(seed.doc);
if (seed.folder) session.lastFolder = inFiles(seed.folder);
const SEEDED = new Set(['session.json', 'preferences.json']);
fs.writeFileSync(path.join(dataDir, 'session.json'), `${JSON.stringify(session, null, 2)}\n`);
if (seed.preferences) fs.writeFileSync(path.join(configDir, 'preferences.json'), `${JSON.stringify(seed.preferences, null, 2)}\n`);

// HOME と XDG を付け替えても、実ユーザーのホームに作られうる場所（識別子またはバイナリ名で決まるもの）。
const realHome = os.homedir();
const REAL_PATHS = [
  path.join(realHome, '.local', 'share', IDENTIFIER),
  path.join(realHome, '.local', 'share', BIN_NAME),
  path.join(realHome, '.config', IDENTIFIER),
  path.join(realHome, '.cache', IDENTIFIER),
  path.join(realHome, '.cache', BIN_NAME),
];
const realSignatures = () => Object.fromEntries(REAL_PATHS.map((p) => [p, treeSignature(p)]));
const realBefore = realSignatures();

/** 空いている TCP port（tauri-driver は port と port+1 の 2 つを使う）。 */
async function freePort() {
  for (;;) {
    const port = await new Promise((resolve) => {
      const srv = net.createServer().listen(0, '127.0.0.1', () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    const second = await new Promise((resolve) => {
      const srv = net.createServer().once('error', () => resolve(false)).listen(port + 1, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (second) return port;
  }
}
const port = await freePort();
const env = { ...process.env, HOME: home, ...xdg };
const log = fs.openSync(path.join(runDir, 'tauri-driver.log'), 'w');
const driver = spawn(tauriDriver(), ['--port', String(port), '--native-port', String(port + 1), '--native-driver', nativeDriver()], { env, stdio: ['ignore', log, log] });

/** この run の HOME で動いている、この実行ファイルのプロセス（/proc の exe と environ で照合する。プロセス名では判定しない）。 */
function appPids() {
  const out = [];
  for (const d of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
    try {
      if (fs.readlinkSync(`/proc/${d}/exe`) !== TAURI_BIN) continue;
      const vars = fs.readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (vars.includes(`HOME=${home}`)) out.push(Number(d));
    } catch {
      // 終了した、または読めないプロセスは飛ばす
    }
  }
  return out;
}

// ---- WebDriver（W3C）。fetch だけで話す ----
const BASE = `http://127.0.0.1:${port}`;
const ELEM = 'element-6066-11e4-a6e3-4ef4b4ad4a1e';
let sid = null;
async function wd(method, p, body) {
  const url = `${BASE}${sid ? `/session/${sid}` : ''}${p}`;
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (json.value?.error) throw new Error(`${method} ${p}: ${json.value.error} ${json.value.message ?? ''}`);
  return json.value;
}
const js = (script, a = []) => wd('POST', '/execute/sync', { script, args: a });
const cssOf = (target) => (target.testId ? `[data-testid="${target.testId}"]` : target.css);
async function find(target) {
  const v = await wd('POST', '/element', { using: 'css selector', value: cssOf(target) });
  const id = v?.[ELEM] ?? (v && Object.values(v)[0]);
  if (!id) throw new Error(`要素がありません: ${cssOf(target)}`);
  return id;
}
// キーの名前（Playwright の press と同じ書き方）から WebDriver のコードへ。ControlOrMeta は Linux では Control。
const KEYS = { Control: '', ControlOrMeta: '', Shift: '', Alt: '', Meta: '', Enter: '', Escape: '', Tab: '', Backspace: '', Delete: '', Home: '', End: '', ArrowUp: '', ArrowDown: '', ArrowLeft: '', ArrowRight: '', F6: '', F11: '', Space: ' ' };
async function press(chord) {
  const keys = chord.split('+').map((k) => KEYS[k] ?? (k.length === 1 ? k : null));
  if (keys.includes(null)) throw new Error(`知らないキーの名前です: ${chord}`);
  const actions = [...keys.map((value) => ({ type: 'keyDown', value })), ...[...keys].reverse().map((value) => ({ type: 'keyUp', value }))];
  await wd('POST', '/actions', { actions: [{ type: 'key', id: 'keyboard', actions }] });
  await wd('DELETE', '/actions');
}
/** expect の実際の値。testId / css は read（text、count、exists、visible、attr:<name>）、eval はページの式、file は run の files/ のファイル。 */
async function actualOf(spec) {
  if (typeof spec.eval === 'string') return js(`return (${spec.eval});`);
  if (typeof spec.file === 'string') {
    const p = inFiles(spec.file);
    return spec.read === 'exists' ? fs.existsSync(p) : fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  }
  const read = spec.read ?? 'text';
  return js(
    `const all=[...document.querySelectorAll(arguments[0])],e=all[0],r=arguments[1];
     if(r==='count')return all.length; if(r==='exists')return !!e; if(!e)return null;
     if(r==='visible'){const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&getComputedStyle(e).visibility!=='hidden';}
     if(r.startsWith('attr:'))return e.getAttribute(r.slice(5)); return e.textContent;`,
    [cssOf(spec), read],
  );
}
const matches = (actual, spec) =>
  'equals' in spec ? JSON.stringify(actual) === JSON.stringify(spec.equals) : 'contains' in spec ? typeof actual === 'string' && actual.includes(spec.contains) : 'notContains' in spec ? typeof actual === 'string' && !actual.includes(spec.notContains) : Boolean(actual);

const results = [];
let ok = true;
let failure = null;
let isolationEnv = null;
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${BASE}/status`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }
  const created = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: TAURI_BIN } } } });
  sid = created.sessionId;
  // 最初の描画（.cm-content）を待つ。窓は notifyReady まで非表示。
  for (let i = 0; i < 100 && !(await js("return !!document.querySelector('.cm-content')").catch(() => false)); i++) await sleep(150);
  isolationEnv = appPids().length > 0;
  for (const [index, step] of (scenario.steps ?? []).entries()) {
    const record = { index, step };
    try {
      if ('press' in step) for (let n = 0; n < (step.times ?? 1); n++) await press(step.press);
      else if ('click' in step) await wd('POST', `/element/${await find(step.click)}/click`, {});
      else if ('type' in step) {
        // 文字列は WebDriver の send keys で、フォーカスのある要素へ。target があればその要素へ送る。
        const target = typeof step.type === 'string' ? null : step.type;
        const text = typeof step.type === 'string' ? step.type : step.type.text;
        const id = target?.testId || target?.css ? await find(target) : (await wd('POST', '/element/active'))?.[ELEM];
        await wd('POST', `/element/${id}/value`, { text });
      } else if ('wait' in step) await sleep(step.wait);
      else if ('externalWrite' in step) fs.writeFileSync(inFiles(step.externalWrite.path), step.externalWrite.text);
      else if ('screenshot' in step) {
        const png = path.join(outDir, `${step.screenshot}.png`);
        fs.writeFileSync(png, Buffer.from(await wd('GET', '/screenshot'), 'base64'));
        record.png = rel(png);
      } else if ('expect' in step) {
        const spec = step.expect;
        const t0 = Date.now();
        let actual;
        do {
          actual = await actualOf(spec).catch((e) => `ERROR ${e.message}`);
          if (matches(actual, spec)) break;
          await sleep(150);
        } while (Date.now() - t0 < (spec.timeout ?? 8000));
        record.actual = actual;
        if (!matches(actual, spec)) throw new Error(`expect が外れました: ${spec.note ?? ''} actual=${JSON.stringify(actual)} spec=${JSON.stringify(spec)}`);
      } else throw new Error(`知らない step です: ${JSON.stringify(step)}`);
      record.ok = true;
      console.log(`ok   ${index} ${step.expect?.note ?? step.note ?? Object.keys(step)[0]}`);
    } catch (e) {
      record.ok = false;
      record.error = e.message;
      results.push(record);
      console.log(`FAIL ${index} ${e.message}`);
      // 失敗した時点の窓を残す
      fs.writeFileSync(path.join(outDir, 'failure.png'), Buffer.from(await wd('GET', '/screenshot').catch(() => ''), 'base64'));
      throw e;
    }
    results.push(record);
  }
} catch (e) {
  ok = false;
  failure = e.message;
} finally {
  if (sid) await wd('DELETE', '').catch(() => {});
  sid = null;
  driver.kill('SIGTERM');
  // セッションを閉じてもアプリが残っていれば、この run の HOME で動いているものだけを止める。
  for (let i = 0; i < 20 && appPids().length > 0; i++) await sleep(250);
  for (const pid of appPids()) process.kill(pid, 'SIGTERM');
}

const touched = REAL_PATHS.filter((p) => realBefore[p] !== treeSignature(p));
const appCreated = fs.readdirSync(dataDir).filter((f) => !SEEDED.has(f));
const isolation = { homeEnvIsRunHome: isolationEnv, appCreatedUnderRunHome: appCreated, realPathsTouched: touched, confirmed: isolationEnv === true || appCreated.length > 0 };
const report = { scenario: rel(scenarioPath), name, platform: 'linux', bin: rel(TAURI_BIN), ok, failure, isolation, steps: results };
fs.writeFileSync(path.join(outDir, 'observations.json'), `${JSON.stringify(report, null, 2)}\n`);
state.tauriLinux = { ...(state.tauriLinux ?? {}), [name]: { ok, home: rel(home), files: rel(filesDir), evidence: rel(outDir), isolation, finishedAt: new Date().toISOString() } };
writeState(statePath, state);
console.log(`isolation: homeEnvIsRunHome=${isolationEnv} appCreatedUnderRunHome=${appCreated.length} 件 realPathsTouched=${touched.length} 件`);
console.log(`evidence: ${rel(outDir)}`);
if (touched.length > 0) console.error(`実ユーザーの領域が変わっています: ${touched.join(', ')}`);
if (!isolation.confirmed) console.error('Tauri が run 専用 HOME で動いた証拠がありません。隔離できていない可能性があります。');
if (!ok) console.error(`FAIL: ${failure}`);
process.exit(ok && touched.length === 0 && isolation.confirmed ? 0 : 1);
