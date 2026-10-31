#!/usr/bin/env node
// Phase 0 P0-1: run MDE build/test commands and record exit code, duration, and output tail.
// Usage: node scripts/run-mde-checks.mjs [--tauri]
// Output: phase0/results/mde-build.json
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mde = resolve(root, 'phase0/vendor/MDE');
if (!existsSync(mde)) {
  console.error('phase0/vendor/MDE がありません。git clone https://github.com/sevenevesai/MDE phase0/vendor/MDE を先に実行してください。');
  process.exit(2);
}

const registry = 'https://registry.npmjs.org';
const commands = [
  ['npm', ['ci', '--registry', registry]],
  ['npm', ['test']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['run', 'build']],
];
if (process.argv.includes('--tauri')) {
  commands.push(['npx', ['tauri', 'build', '--debug']]);
  // MDE sets createUpdaterArtifacts=true (tauri.conf.json), which needs TAURI_SIGNING_PRIVATE_KEY.
  // Without the key the build ends with exit 1 after the app/dmg are bundled, so also record a run with it disabled.
  commands.push(['npx', ['tauri', 'build', '--debug', '--config', '{"bundle":{"createUpdaterArtifacts":false}}']]);
}

const tail = (s, n = 25) => s.split('\n').slice(-n).join('\n');
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: mde, encoding: 'utf8' }).stdout.trim();
const results = [];
for (const [cmd, args] of commands) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { cwd: mde, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 1_800_000 });
  const sec = Number(process.hrtime.bigint() - t0) / 1e9;
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  results.push({
    command: [cmd, ...args].join(' '),
    exitCode: r.status,
    durationSec: Math.round(sec * 10) / 10,
    outputTail: tail(out, 12),
  });
  console.log(`${[cmd, ...args].join(' ')} -> exit ${r.status} (${sec.toFixed(1)}s)`);
}

const rev = (c, a) => spawnSync(c, a, { encoding: 'utf8' }).stdout.trim();
writeFileSync(
  resolve(root, 'phase0/results/mde-build.json'),
  JSON.stringify(
    {
      mdeCommit: git,
      environment: {
        os: `${os.type()} ${os.release()} (${rev('sw_vers', ['-productVersion']) || 'n/a'})`,
        arch: os.arch(),
        cpu: os.cpus()[0]?.model,
        node: process.version,
        npm: rev('npm', ['-v']),
        cargo: rev('cargo', ['-V']),
      },
      results,
    },
    null,
    2,
  ) + '\n',
);
