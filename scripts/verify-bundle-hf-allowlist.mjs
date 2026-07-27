#!/usr/bin/env node
// verify-bundle-hf-allowlist.mjs — the app bundle must ship ONLY allowlisted HF models.
//
// THE BUG THIS PINS (2026-07-16). build-app-bundle.sh rsynced the operator's ENTIRE
// global ~/.cache/huggingface/hub into the .app: ~15.5GB of concluded-eval Qwen3-TTS
// models rode along, producing a 21GB bundle that filled the disk to zero mid-install —
// twice — and left /Applications with a half-copied, unlaunchable app. The bundle's
// contract is ONE model (Nomic v1.5, the embed service's offline first run); everything
// else must be excluded no matter what experiments left in the global cache.
//
// Drives the REAL scripts/stage-hf-models.sh on fixture caches. No mocks.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'stage-hf-models.sh');
const NOMIC = 'models--nomic-ai--nomic-embed-text-v1.5';
const BLOAT = 'models--mlx-community--Qwen3-TTS-12Hz-1.7B-VoiceDesign-6bit';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = (n, fn) => { try { fn(); ok(n); } catch (e) { bad(n, e); } };

const dir = mkdtempSync(join(tmpdir(), 'myc-hf-'));
const run = (src, dest) => execFileSync('bash', [SCRIPT, src, dest], { encoding: 'utf8' });
function makeModel(hub, name) {
  const d = join(hub, name, 'snapshots', 'abc');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'weights.bin'), 'x');
}

console.log('\nbundle HF allowlist (only contract models ship)');

t('the allowlisted model is staged; the eval bloat is EXCLUDED (the 21GB-app bug)', () => {
  const src = join(dir, 'src1', 'hub'); const dest = join(dir, 'dest1');
  makeModel(src, NOMIC); makeModel(src, BLOAT); makeModel(src, 'models--somebody--another-experiment');
  run(src, dest);
  assert.ok(existsSync(join(dest, 'hub', NOMIC)), 'nomic must ship');
  assert.ok(!existsSync(join(dest, 'hub', BLOAT)), 'the TTS eval model must NOT ship');
  assert.ok(!existsSync(join(dest, 'hub', 'models--somebody--another-experiment')), 'no unlisted model ships, ever');
});

t('a PREVIOUSLY BLOATED staging dir self-heals (prune on every run)', () => {
  const src = join(dir, 'src2', 'hub'); const dest = join(dir, 'dest2');
  makeModel(src, NOMIC);
  makeModel(join(dest, 'hub'), BLOAT);                       // pre-existing bloat in dest
  mkdirSync(join(dest, 'hub', '.locks', BLOAT), { recursive: true });
  run(src, dest);
  assert.ok(!existsSync(join(dest, 'hub', BLOAT)), 'stale bloat must be pruned');
  assert.ok(!existsSync(join(dest, 'hub', '.locks')), 'stale locks pruned too');
  assert.ok(existsSync(join(dest, 'hub', NOMIC)), 'and the contract model is present');
});

t('a fresh box (no global cache) exits 0 with an empty hub — the caller downloads', () => {
  const dest = join(dir, 'dest3');
  run(join(dir, 'nonexistent-src-hub'), dest);               // must not throw
  assert.ok(existsSync(join(dest, 'hub')), 'dest hub dir exists for the fallback download');
  assert.ok(!existsSync(join(dest, 'hub', NOMIC)), 'nothing staged from a missing source');
});

t('idempotent: a second run changes nothing and keeps the model', () => {
  const src = join(dir, 'src4', 'hub'); const dest = join(dir, 'dest4');
  makeModel(src, NOMIC);
  run(src, dest); run(src, dest);
  assert.ok(existsSync(join(dest, 'hub', NOMIC, 'snapshots', 'abc', 'weights.bin')));
});

t('build-app-bundle.sh actually USES the stager and has dropped the wholesale rsync', () => {
  const bundler = join(dirname(fileURLToPath(import.meta.url)), 'build-app-bundle.sh');
  const s = execFileSync('cat', [bundler], { encoding: 'utf8' });
  assert.ok(s.includes('stage-hf-models.sh'), 'bundler must call the allowlist stager');
  assert.ok(!/rsync -a "\$HOME\/\.cache\/huggingface\/hub" "\$RT\/hf-cache\/"/.test(s),
    'the wholesale global-cache rsync must be GONE — that line was the entire bug');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
