#!/usr/bin/env node
// verify-operational-vault.mjs — operational tooling must act on THE VAULT THE USER RUNS.
//
// THE DEFECT (hit twice in one session, 2026-07-28, false diagnosis both times):
// `db-health.mjs --live` and `install-vault.mjs` resolved their target with `dbPath()` —
// the APPLICATION's resolver, which in a repo checkout answers <repo>/data/mycelium.db.
//
//   • db-health --live probed the DEV vault, keyed it with the real Keychain key, and
//     reported SQLITE_NOTADB — which reads exactly like "your master key does not open
//     your vault". It produced a confident, wrong conclusion ("the key is missing from
//     the Keychain") on a machine whose Keychain was fine. Its existsSync fallback never
//     fired because a dev vault DID exist.
//   • install-vault — the SWAP — had no fallback at all. Run from the repo it would have
//     archived and replaced the DEV vault, printed "DONE — installed vault verified", and
//     left the user's real corrupt vault untouched.
//
// The second is the dangerous one: a repair tool that silently repairs the wrong database
// reports success while the actual data stays broken.
//
// ⚠️ RECORD CORRECTED 2026-07-28. The --live check was a NEGATIVE regex forbidding ONE
//   literal spelling (/\blet p = dbPath\(\)/), and an adversarial review restored the
//   exact defect with a different spelling — re-assigning the target AFTER the resolver —
//   while the gate stayed green and --live probed the checkout vault. The product now
//   binds the target with `const` (a re-assign is a loud TypeError rather than a silent
//   wrong target) and announces the path it is about to open, from that binding.
// MUTATION-TESTED: `const p` → `let p` plus `p = (await import('../src/paths.js')).dbPath()`
//   → "db-health --live opens the app vault, not the checkout" REDs. That is the
//   reviewer's own bypass, now caught by running the tool under a faked HOME with a decoy
//   where dbPath() resolves.
// MUTATION-TESTED: removed the `console.error('[vault] target: …')` announcement from
//   resolveOperationalVault → "the chosen target is always announced" REDs
// MUTATION-TESTED: made resolveOperationalVault prefer the platform vault over an
//   explicit MYCELIUM_DB → "an explicit target wins over the platform default" REDs
// MUTATION-TESTED: reverted install-vault's quick_check try/catch → "a corrupt candidate
//   is refused with a message, not a stack trace" REDs

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

const dir = mkdtempSync(join(tmpdir(), 'myc-opvault-'));
const { resolveOperationalVault, platformVaultPath } = await import('../src/../scripts/vault-repair/operational-vault.mjs');

// The resolver prints to stderr; capture it so the announcement can be asserted.
function withCapturedStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try { return { result: fn(), lines }; } finally { console.error = orig; }
}

const ENV_KEYS = ['MYCELIUM_DB', 'MYCELIUM_DATA_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const clearEnv = () => { for (const k of ENV_KEYS) delete process.env[k]; };
const restoreEnv = () => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };

await t('with no env set, the default target is the PLATFORM app vault — never the checkout', async () => {
  clearEnv();
  const { result } = withCapturedStderr(() => resolveOperationalVault({ mustExist: false }));
  assert.equal(result.source, 'platform');
  assert.equal(result.path, platformVaultPath());
  assert.doesNotMatch(result.path, /mycelium\.id-dev|[/\\]data[/\\]mycelium\.db$/,
    'the default must not be the repo checkout vault — that is the whole defect');
  restoreEnv();
});

await t('an explicit target wins over the platform default', async () => {
  clearEnv();
  const explicit = join(dir, 'explicit.db');
  writeFileSync(explicit, 'x');
  const { result: a } = withCapturedStderr(() => resolveOperationalVault({ explicit, mustExist: true }));
  assert.equal(a.source, 'argv');
  assert.equal(a.path, explicit);

  process.env.MYCELIUM_DB = join(dir, 'fromenv.db');
  writeFileSync(process.env.MYCELIUM_DB, 'x');
  const { result: b } = withCapturedStderr(() => resolveOperationalVault({ mustExist: true }));
  assert.equal(b.source, 'env', 'MYCELIUM_DB must still be honoured — it is how a copy/fixture is named');
  assert.equal(b.path, process.env.MYCELIUM_DB);
  restoreEnv();
});

await t('the chosen target is always announced (silence is what hid the defect)', async () => {
  clearEnv();
  const { lines } = withCapturedStderr(() => resolveOperationalVault({ mustExist: false }));
  const line = lines.find((l) => l.includes('[vault] target:'));
  assert.ok(line, 'the resolver must print which database it picked');
  assert.match(line, /\(from (platform|env|argv)\)/, 'it must say WHERE the choice came from');
  restoreEnv();
});

await t('a missing target fails closed with an actionable message', async () => {
  clearEnv();
  process.env.MYCELIUM_DB = join(dir, 'nope.db');
  assert.throws(
    () => withCapturedStderr(() => resolveOperationalVault({ mustExist: true })),
    (e) => e.code === 'vault_not_found',
    'a missing vault must throw, never silently fall through to another database',
  );
  restoreEnv();
});

await t('db-health --live opens the app vault, not the checkout — proven by running it', async () => {
  // BEHAVIOURAL. This was a NEGATIVE regex forbidding one literal spelling
  // (/\blet p = dbPath\(\)/), and an adversarial review restored the exact 2026-07-28
  // defect by re-assigning the target AFTER the resolver with a different spelling — gate
  // green, --live probing the checkout vault and reporting a false "your master key does
  // not open your vault". db-health now binds the target with `const` (a re-assign is a
  // loud TypeError, not a silent wrong target) and ANNOUNCES the path it is about to open,
  // from that same binding, before anything unrelated can abort.
  //
  // HOME is faked so the platform path lands in a temp dir: this must NEVER probe the
  // operator's real vault. A decoy sits where dbPath() resolves in a checkout, so choosing
  // the wrong one is observable, not merely asserted.
  const home = join(dir, 'fakehome');
  // ASK THE PRODUCT WHERE ITS VAULT GOES — do not spell the path here. This fixture used
  // to hardcode macOS's `Library/Application Support/...`, so it passed locally and FAILED
  // ON CI, which runs Linux where platformVaultPath() resolves to `.local/share/...`.
  // A fixture that reimplements the product's path logic is testing its own copy of it —
  // the same class of defect that cost this branch four review rounds, in a new costume:
  // this time the mismatch was with the PLATFORM rather than the config. os.homedir()
  // reads $HOME on POSIX, so pointing HOME at the fake root makes the product's own
  // resolver produce exactly the path the child will look for.
  const realHome = process.env.HOME;
  process.env.HOME = home;
  let appVault;
  try { appVault = platformVaultPath(); } finally {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
  }
  const appDir = dirname(appVault);
  const checkout = join(dir, 'checkout');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(join(checkout, 'data'), { recursive: true });
  writeFileSync(appVault, 'placeholder');
  const decoy = join(checkout, 'data', 'mycelium.db');
  writeFileSync(decoy, 'decoy');

  const r = spawnSync(process.execPath, [fileURLToPath(new URL('./db-health.mjs', import.meta.url)), '--live'], {
    cwd: checkout,
    env: { ...process.env, HOME: home, MYCELIUM_DB: '', MYCELIUM_DATA_DIR: '' },
    encoding: 'utf8',
  });
  const err = String(r.stderr || '');
  // POSITIVE PRECONDITION: it must have got as far as announcing a target. Without this a
  // crash on an unrelated line would read as "did not open the decoy".
  const opening = /\[vault\] opening: (.+)/.exec(err);
  assert.ok(opening, `db-health --live never announced the file it opens (stderr=${err.slice(-300)})`);
  assert.equal(opening[1].trim(), appVault,
    'db-health --live must open the PLATFORM app vault');
  assert.ok(!err.includes(decoy), 'db-health --live must never touch the checkout vault');
});

await t('install-vault resolves its SWAP TARGET through the operational resolver', async () => {
  const src = readFileSync(new URL('./vault-repair/install-vault.mjs', import.meta.url), 'utf8');
  assert.match(src, /const \{ path: LIVE \} = resolveOperationalVault\(/,
    'the swap target must come from the operational resolver');
  assert.doesNotMatch(src, /^const LIVE = dbPath\(\);$/m,
    'install-vault must not swap against the checkout vault');
});

await t('a corrupt candidate is refused with a message, not a stack trace', async () => {
  // quick_check THROWS on a badly damaged candidate — the most likely thing an operator
  // points this tool at by mistake. It must produce a refusal, not a raw SqliteError.
  const src = readFileSync(new URL('./vault-repair/install-vault.mjs', import.meta.url), 'utf8');
  const i = src.indexOf("prepare('PRAGMA quick_check')");
  assert.ok(i > 0, 'quick_check validation not found');
  const around = src.slice(Math.max(0, i - 400), i + 400);
  assert.match(around, /try \{[\s\S]*quick_check[\s\S]*\} *\n? *catch/,
    'the candidate quick_check must be wrapped — it throws on a corrupt candidate');
  assert.match(around, /candidate is CORRUPT/, 'the refusal must name the problem');
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
