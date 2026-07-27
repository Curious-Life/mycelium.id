// verify:vault-fail-closed — D-080 (P0, data loss), D-081, D-082.
//
// THE DEFECT THIS GATE EXISTS FOR: the boot path treated "I cannot read this
// vault" as "there is no vault here". On 2026-07-27 an operator's production
// vault location was re-initialised as an empty vault at app launch. The
// existence test that should have stopped everything was pointed at the kcv.json
// SIDECAR (src/server-rest.js:917, src/account/router.js:59) and never at
// mycelium.db itself.
//
// Two distinct destructions are gated here, because the incident report named
// only the first and the SPIKE found the second:
//   1. a fresh, empty vault created where a vault already lives;
//   2. RECOVERABILITY destroyed without touching a byte of the db — unlock()
//      (src/crypto/keys.js:41-48) mints a NEW kcv.json for the WRONG key beside
//      an existing vault. The db survives intact and the user's real recovery
//      key is then rejected ("that key does not match this vault") forever,
//      because /restore verifies against the KCV the wrong key just wrote.
//      Byte-identity of mycelium.db is NOT sufficient to prove no data was lost.
//
// The invariant, stated once (CLAUDE.md §3, fail closed): if a vault is present
// and the resolved key cannot open it, NOTHING is created, replaced or attested —
// no db, no kcv, no schema — and the app never presents itself as a fresh machine.
//
// PIVOT (v1 → v2). v1 of this fix aborted the process outright, which is what the
// D-080 report asks for. An existing gate refuted it: verify:account B3-B7 boots
// against an existing vault with NO resolvable key and then pastes the correct
// recovery key to re-open it. Aborting removes the only in-app route back into
// your own vault after a Keychain loss, a new Mac or a migrated account — which
// pushes a stuck user toward deleting the data dir, i.e. back to losing the vault.
// v2 keeps every safety property the report demands and drops only the mechanism:
// the process stays up in RECOVERY-ONLY mode, where each creating path is refused
// by its own guard and its own check below.
//
// MUTATION-TESTED: 2026-07-27 — restored all four fixed files to their pre-fix
// state at f231988c (`git show HEAD:<f> > <f>` for src/crypto/keys.js,
// src/index.js, src/server-rest.js, src/account/router.js) and ran THIS gate
// unchanged. RED on the mutation: C1 (a kcv was fabricated for the wrong key),
// C2 (same, stated directly), C5 (open=false — the operator's real recovery key
// no longer opened their own intact vault), C6 (no 409 refusal), C6e
// (needsSetup:true with a vault sitting on disk). Restored → 16/16 GREEN.
//
// Two checks were rewritten BECAUSE the mutation run caught them greening for the
// wrong reason — the M-001 failure mode this repo keeps re-learning:
//   · C4's first regex (/refus/i) matched "Refusing to migrate" from an unrelated
//     snapshot error. Now anchored to the RECOVERY MODE banner + the absence of
//     "entering setup mode", and it REDs.
//   · C1 first asserted only the needsSetup/needsRecoveryKey pair, which the BUG
//     also satisfies — the kcv it fabricates is what sets needsRecoveryKey. The
//     `!existsSync(kcvPath)` clause is what makes it discriminate.
// Honest scope: C3, C6b-C6d, C7 and C7b do NOT red on that mutation. They are
// regression guards for invariants that already held (the db was never truncated;
// KCV verification already refused a plaintext vault whose verifier was intact),
// kept so a future change cannot quietly take them away.
//
// The D block (C8/C8b/C9/C9b) was mutation-tested SEPARATELY, by reverting
// src/account/snapshot-on-boot.js and src-tauri/src/main.rs to f231988c: C8, C8b
// and C9 RED. C9b's FIRST version — /debug_assertions/ && /data_dir/ — was true on
// the unfixed main.rs (line 14 has carried that attribute since long before this
// fix), so it could never red and was reported as covered when it was not; it now
// asserts the specific new derivation and REDs on the revert.
//
// Scenario B blanks PATH so the mutated /setup cannot reach `security` and write
// to the operator's real login Keychain while the gate runs.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnReaped, reap } from './lib/reap.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digest = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null);

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  — ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  — ' + extra : ''}`); }
};

const { initVaultStorage } = await import(`${REPO}/src/db/init.js`);
const { unlock } = await import(`${REPO}/src/crypto/keys.js`);
const { deriveSystemKey } = await import(`${REPO}/src/account/keystore.js`);

const PORT = 8793;

/** Boot the REAL server-rest against `dir` with `userHex`, and report what it did. */
async function bootServer(dir, userHex, { atRest = '1', extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    MYCELIUM_DATA_DIR: dir,
    MYCELIUM_REST_PORT: String(PORT),
    MYCELIUM_KEY_SOURCE: 'env',
    USER_MASTER_KEY: userHex,
    SYSTEM_KEY: deriveSystemKey(userHex),
    MYCELIUM_AT_REST: atRest,
    MYCELIUM_PORTAL_MODE: 'none',
    ...extraEnv,
  };
  // The env fallback must never be the thing that opens a vault (D-080's
  // aggravating factor) — prove the gate is not accidentally relying on it.
  delete env.ENCRYPTION_MASTER_KEY;
  const proc = spawnReaped('node', ['src/server-rest.js'], { env, cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  let exit;
  proc.on('exit', (code) => { exit = code ?? 0; });
  // Wait for a verdict: either the process exits, or it comes up listening.
  for (let i = 0; i < 80 && exit === undefined; i++) {
    await sleep(250);
    if (/portal \+ REST on http/i.test(out)) break;
  }
  await sleep(750);
  let status = null;
  if (exit === undefined) {
    try { status = await (await fetch(`http://127.0.0.1:${PORT}/api/v1/account/status`)).json(); }
    catch { status = null; }
  }
  return { proc, out, exit, status, alive: exit === undefined };
}

/** A real, encrypted vault under `userHex`, with its matching kcv. */
async function seedVault(dir, userHex, { atRest = true } = {}) {
  const dbPath = path.join(dir, 'mycelium.db');
  const kcvPath = path.join(dir, 'kcv.json');
  const prev = process.env.MYCELIUM_AT_REST;
  process.env.MYCELIUM_AT_REST = atRest ? '1' : '';
  try {
    await initVaultStorage({ dbPath, userHex, log: () => {} });
    await unlock({ userHex, systemHex: deriveSystemKey(userHex), kcvPath });
  } finally {
    if (prev === undefined) delete process.env.MYCELIUM_AT_REST; else process.env.MYCELIUM_AT_REST = prev;
  }
  return { dbPath, kcvPath };
}

// ── Scenario A — an ENCRYPTED vault is present; the resolved key cannot open it,
//    and the kcv sidecar is gone (a hand-copied data dir, a cleared Keychain, a
//    restore that landed only the db). This is the incident state.
console.log('\n[A] existing encrypted vault + unusable key + missing sidecar');
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vfc-a-'));
  const keyA = randomBytes(32).toString('hex');
  const keyB = randomBytes(32).toString('hex');
  const { dbPath, kcvPath } = await seedVault(dir, keyA);
  const dbBefore = digest(dbPath);
  rmSync(kcvPath); // the sidecar the old code keyed its decision on

  const r = await bootServer(dir, keyB);

  // NOT "the process exits": see the pivot note in the header. What must hold is
  // that it never presents itself as a fresh machine — needsSetup is the field the
  // UI turns into a "create a new vault" button.
  // The `!existsSync(kcvPath)` clause is load-bearing, not decoration: without it
  // this check passes against the BROKEN code, because the bug mints a kcv and the
  // freshly-minted file is what then makes needsRecoveryKey true. The state must be
  // reached from the vault that is really there, not from a verifier we invented.
  ok(r.status?.needsSetup === false && r.status?.needsRecoveryKey === true && !existsSync(kcvPath),
    'C1 an unopenable vault enters RECOVERY mode (never setup) without fabricating a verifier',
    r.alive ? JSON.stringify(r.status)?.slice(0, 100) : `process exited (${r.exit})`);
  ok(digest(kcvPath) === null, 'C2 no kcv.json is minted for a key that cannot open the vault',
    existsSync(kcvPath) ? 'a KCV for the WRONG key was written — the real recovery key is now rejected' : '');
  ok(digest(dbPath) === dbBefore, 'C3 mycelium.db is byte-identical after the refused boot');
  // Match the abort BANNER specifically. A loose /refus/i here passed against the
  // unfixed code by matching "Refusing to migrate" from an unrelated snapshot
  // error — a check that greens on the wrong evidence is worse than no check.
  ok(/RECOVERY MODE/.test(r.out) && !/entering setup mode/.test(r.out),
    'C4 the message names the real cause and "setup mode" is never logged',
    (r.out.split('\n').find((l) => /RECOVERY MODE|setup mode/.test(l)) || '(neither)').slice(0, 90));
  reap(r.proc, 'SIGKILL');

  // C5 — the whole point of C2: recoverability must SURVIVE the refused boot.
  // The operator's real key must still open their own vault afterwards.
  const r2 = await bootServer(dir, keyA);
  ok(r2.alive && r2.status?.open === true, 'C5 the real key still opens the vault after a refused boot',
    r2.alive ? `open=${r2.status?.open}` : `process exited (${r2.exit})`);
  reap(r2.proc, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

// ── Scenario B — defence in depth (CLAUDE.md §2). Even if a boot legitimately
//    reaches setup mode, POST /account/setup must independently refuse while a
//    mycelium.db is sitting there. Two layers, not one.
// The router is mounted DIRECTLY with isInitialized:()=>false. Driving this
// through a spawned server instead would let the pre-existing
// `already_initialized` guard answer first, and the check would pass 409 without
// ever reaching the guard it claims to test (M-001: green for the wrong reason).
console.log('\n[B] POST /account/setup with a vault file present');
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vfc-b-'));
  const seedDir = mkdtempSync(path.join(os.tmpdir(), 'vfc-b-seed-'));
  const { dbPath: seededDb } = await seedVault(seedDir, randomBytes(32).toString('hex'));

  const dbPath = path.join(dir, 'mycelium.db');
  const kcvPath = path.join(dir, 'kcv.json');
  copyFileSync(seededDb, dbPath); // a vault is here; its verifier is not
  const dbBefore = digest(dbPath);

  // Hide `security` from PATH for the duration: the vault_exists refusal must come
  // BEFORE any Keychain interaction, and a gate must never write to the operator's
  // real login Keychain — which is what the UNFIXED /setup would attempt here.
  const realPath = process.env.PATH;
  let srv = null;
  try {
  process.env.PATH = '/nonexistent';
  const { default: express } = await import('express');
  const { accountRouter } = await import(`${REPO}/src/account/router.js`);
  let completeBootCalls = 0;
  const app = express();
  app.use('/api/v1/account', accountRouter({
    isInitialized: () => false,                 // NOT open — the old guard cannot answer
    completeBoot: async () => { completeBootCalls++; },
    getBootError: () => null,
    kcvPath, dbPath,
  }));
  srv = app.listen(PORT + 1, '127.0.0.1');
  await sleep(300);

  let code = 0, body = '';
  try {
    const res = await fetch(`http://127.0.0.1:${PORT + 1}/api/v1/account/setup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    code = res.status; body = (await res.text()).slice(0, 140);
  } catch (e) { body = String(e.message); }

  ok(code === 409 && /vault_exists/.test(body), 'C6 /account/setup refuses while a mycelium.db is present', `${code} ${body}`);
  ok(completeBootCalls === 0, 'C6b the refused setup never booted a new vault', `completeBoot calls=${completeBootCalls}`);
  ok(digest(dbPath) === dbBefore, 'C6c the existing db is untouched by the refused setup');
  ok(digest(kcvPath) === null, 'C6d the refused setup minted no key-verifier');

  // And the honest signal the UI gates on: with a db present this is NOT a fresh machine.
  const st = await (await fetch(`http://127.0.0.1:${PORT + 1}/api/v1/account/status`)).json();
  ok(st.needsSetup === false, 'C6e /account/status does not report needsSetup with a vault on disk',
    JSON.stringify(st).slice(0, 90));

  } finally {
    // A throw here must not poison PATH for Scenario C, leak the listener, or
    // exit before VERDICT prints (the swallowed-verdict failure #400 just fixed).
    process.env.PATH = realPath;
    try { srv?.close(); } catch { /* */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  }
}

// ── Scenario C — a PLAINTEXT vault, its kcv intact, opened with a key that never
//    belonged to it. Left unguarded the old path opened it unkeyed, applied
//    migrations to the user's real data, re-encrypted it under the NEW key and
//    then purged the plaintext original — and no byte-identity check catches
//    that, because the file is legitimately rewritten. The KCV is what refuses.
//
//    NOT COVERED, stated rather than hidden: a plaintext vault whose kcv.json is
//    ALSO missing. Nothing can distinguish it from the plaintext fixtures ~104
//    gates boot as a library (Design D5), because any key "opens" plaintext. In
//    production at-rest is on and the vault is encrypted from birth, so the
//    provable branch is the one that runs; D-081 (a snapshot now exists) and
//    D-082 (dev builds no longer resolve the production dir) cover the residue.
console.log('\n[C] existing plaintext vault + a key that never belonged to it');
{
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vfc-c-'));
  const { dbPath } = await seedVault(dir, randomBytes(32).toString('hex'), { atRest: false });
  const dbBefore = digest(dbPath);

  const r = await bootServer(dir, randomBytes(32).toString('hex'));
  ok(r.status?.needsSetup === false && r.status?.open !== true,
    'C7 a plaintext vault with a failing KCV is not adopted', JSON.stringify(r.status)?.slice(0, 90));
  ok(digest(dbPath) === dbBefore, 'C7b the plaintext vault is byte-identical (not re-keyed)');
  reap(r.proc, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
}

// ── NOT GATED, and deliberately left visible rather than quietly dropped: a legacy
//    PLAINTEXT vault WITH REAL ROWS whose kcv.json is missing is still adopted by
//    whatever key boots it, and the at-rest migration then encrypts the user's data
//    under that key. Both independent reviews raised it. It is NOT fixed here
//    because the only rule that closes it — refuse a plaintext vault holding rows —
//    contradicts an asserted product contract: verify:at-rest-default T4 requires
//    the real launch to migrate exactly that vault to ciphertext, and the same
//    fixture shape recurs across verify:vault-import, verify:full-export-import and
//    others. That is a product decision with a wide blast radius. See the fix
//    handoff, "Open finding F1". The ENCRYPTED path — every at-rest vault, i.e. all
//    current production — is closed above by C1/C2/C5.

// ── D-081 / D-082 — the two halves that make D-080 survivable. Static assertions:
//    the snapshot must not be opt-in/QA-only, and a non-release build must not
//    silently resolve the production vault.
console.log('\n[D] D-081 snapshot default-on · D-082 dev/prod separation');
{
  const snap = readFileSync(`${REPO}/src/account/snapshot-on-boot.js`, 'utf8');
  ok(!/if\s*\(\s*!\s*process\.env\.MYCELIUM_SNAPSHOT_ON_BOOT\s*\)\s*return null/.test(snap),
    'C8 the pre-boot snapshot is not gated off by an unset opt-in flag');
  ok(/MYCELIUM_SNAPSHOT_ON_BOOT\s*===?\s*['"]0['"]|opt\s*-?\s*out/i.test(snap),
    'C8b the snapshot flag is an opt-OUT (production default on)');

  const mainRs = readFileSync(`${REPO}/src-tauri/src/main.rs`, 'utf8');
  ok(!/with_file_name\(\s*"id\.mycelium\.app"\s*\)/.test(mainRs),
    'C9 a .dev build is not redirected onto the production data dir');
  // NOT /debug_assertions/ alone — main.rs:14 has carried that since long before
  // this fix, so the first version of this check was TRUE on the unfixed file and
  // could never red. Assert the actual new behaviour: a debug build APPENDS its
  // own suffix, and a .dev bundle short-circuits that rewrite (it already has one).
  ok(/is_dev_bundle\s*\|\|\s*cfg!\(debug_assertions\)/.test(mainRs)
    && /is_dev\s*&&\s*!is_dev_bundle/.test(mainRs)
    && /format!\("\{name\}\.dev"\)/.test(mainRs),
  'C9b a debug build appends its own .dev dir; a .dev bundle keeps the one it has');
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`VERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — vault lifecycle fail-closed (D-080/081/082). EXIT=${fail === 0 ? 0 : 1}`);
process.exit(fail === 0 ? 0 : 1);
