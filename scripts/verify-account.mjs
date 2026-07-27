// scripts/verify-account.mjs — setup-mode boot + the /api/v1/account ceremony.
//
// Fully ISOLATED from the real vault/app: ephemeral data dir (explicit dbPath +
// kcvPath, so ensureDataDir never runs), ephemeral Keychain service names, and
// an OS-assigned port. Exercises: status, the 503 guard before setup, POST
// /setup (one recovery key), re-setup 409, recovery-key view, then a new-machine
// RESTORE (Keychain cleared, vault files remain) with wrong/malformed/right keys.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SUF = `acct-${process.pid}-${Date.now()}`;
process.env.MYCELIUM_KEY_SOURCE = 'keychain';
process.env.MYCELIUM_KC_ACCOUNT = `mycelium-${SUF}`;
process.env.MYCELIUM_KC_USER = `mycelium-user-${SUF}`;
process.env.MYCELIUM_KC_SYSTEM = `mycelium-system-${SUF}`;
process.env.MYCELIUM_DISABLE_EMBED = '1'; // no embed-service dependency for these tests

const DATA = mkdtempSync(join(tmpdir(), 'myc-acct-'));
const DB = join(DATA, 'mycelium.db');
const KCV = join(DATA, 'kcv.json');

const { startRestServer } = await import('../src/server-rest.js');
const { keychainAvailable, deleteKeychain, keychainHasKeys } = await import('../src/account/keystore.js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── U10 / D-027 SOURCE guards (run everywhere, incl. Linux CI — BEFORE the
// Keychain-availability skip below, which returns early on non-macOS). They
// assert the op-CLI false-blame path is gone, no key material can reach
// argv/logs, and the wizard backup step cannot advance without the explicit
// "I've saved it" re-entry challenge.
{
  const HERE = dirname(fileURLToPath(import.meta.url));
  const ROOT = join(HERE, '..');
  const keystore = readFileSync(join(ROOT, 'src/account/keystore.js'), 'utf8');
  const acctRouter = readFileSync(join(ROOT, 'src/account/router.js'), 'utf8');
  const step = readFileSync(join(ROOT, 'portal-app/src/lib/components/onboarding/wizard/RecoveryKeyStep.svelte'), 'utf8');

  // U3 — the `op`-CLI SAVE path stays removed (distinct from the boot key-source
  // `op read` in src/crypto/key-source.js, which is untouched).
  // MUTATION-TESTED: re-added `export function onePasswordSignInState(){…}` to keystore.js → U3a RED (restored → GREEN)
  ok(!/onePasswordSignInState|saveRecoveryKeyTo1Password|resolveOpBin/.test(keystore),
    'U3a. keystore: the op-CLI recovery-key save path is removed');
  // MUTATION-TESTED: re-added a `target:'1password'` branch returning "not signed in / Integrate with 1Password CLI" to router.js → U3b RED (restored → GREEN)
  ok(!/op[\s_]?signed[\s_]?out|Integrate with 1Password CLI|not signed in/i.test(acctRouter),
    'U3b. router: no false "not signed in / enable CLI integration" copy');

  // U4 — no recovery-key material in argv or logs. The reveal audit line must be
  // value-free, and the save handler must not interpolate the key into a response.
  // MUTATION-TESTED: changed the reveal audit log to `…revealed ${key}…` → U4a RED (restored → GREEN)
  const revealLog = acctRouter.match(/console\.info\([^)]*recovery key revealed[^)]*\)/i)?.[0] ?? '';
  ok(revealLog.length > 0 && !/\$\{[^}]*key[^}]*\}|\+\s*key\b/i.test(revealLog),
    'U4a. router: the recovery-key reveal audit log carries no key value');
  // MUTATION-TESTED: added `recoveryKey: key` to the save success JSON → U4b RED (restored → GREEN)
  const saveHandler = acctRouter.match(/router\.post\('\/recovery-key\/save'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  ok(saveHandler.length > 0 && !/recoveryKey:\s*key|key:\s*key\b|\bkey\b\s*\}\)/.test(saveHandler),
    'U4b. router: the save response never puts the key in the JSON body');

  // U5 — the wizard backup gate: progression requires the explicit re-entry
  // confirmation. The 'show' phase must NOT auto-advance (no store-save that calls
  // commitAndAdvance / onNext directly); the only way forward is phase='verify',
  // and the confirm button is disabled until the re-typed key matches.
  const showPhase = step.match(/\{:else if phase === 'show'\}[\s\S]*?\{:else if phase === 'verify'\}/)?.[0] ?? '';
  // MUTATION-TESTED: pointed the show-phase primary at `commitAndAdvance` → U5a RED (restored → GREEN)
  ok(showPhase.length > 0 && !/commitAndAdvance|onNext\(\)/.test(showPhase),
    'U5a. RecoveryKeyStep: the show phase never auto-advances (no store-save skip)');
  // MUTATION-TESTED: same mutation dropped `phase = 'verify'` from the show phase → U5b RED (restored → GREEN)
  ok(/phase = 'verify'/.test(showPhase),
    'U5b. RecoveryKeyStep: the only way past show is the re-entry challenge (phase=verify)');
  // MUTATION-TESTED: changed the confirm button to `disabled={committing}` (dropped `!verifyMatches`) → U5c RED (restored → GREEN)
  ok(/disabled=\{!verifyMatches[^}]*\}[\s\S]*?commitAndAdvance/.test(step),
    'U5c. RecoveryKeyStep: confirm is gated on verifyMatches (re-typed key must match)');
}

if (!keychainAvailable()) {
  // The live ceremony needs the macOS Keychain, but the U10 SOURCE guards above
  // ran and must still be honored (they catch the D-027 regressions on Linux CI).
  console.log('SKIP  account ceremony (live) — macOS Keychain unavailable on this platform');
  console.log(`\n${pass} passed, ${fail} failed  (U10 source guards only; live ceremony skipped)`);
  console.log(fail
    ? 'VERDICT: NO-GO — U10/D-027 source guard failed'
    : 'VERDICT: GO — skipped live ceremony (no Keychain); U10 source guards pass');
  rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}

const J = async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) });
const get = (u) => fetch(u).then(J);
const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(J);

let recoveryKey = null;
let s1, s2;
try {
  // ── A. fresh setup ────────────────────────────────────────────────────────
  s1 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  let st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.status === 200 && st.body.initialized === false, 'A1. fresh start → status initialized:false', `(${st.body.initialized})`);
  ok(st.body.keychainAvailable === true, 'A2. status reports keychainAvailable:true');

  const guard = await get(`${s1.url}/api/v1/portal/mindscape/structure`);
  ok(guard.status === 503, 'A3. vault data path → 503 before setup', `(${guard.status})`);

  const setup = await post(`${s1.url}/api/v1/account/setup`);
  recoveryKey = setup.body.recoveryKey;
  ok(setup.status === 200 && /^[0-9a-f]{64}$/.test(recoveryKey || ''), 'A4. POST /setup → 64-hex recoveryKey', `(len ${recoveryKey?.length})`);
  ok(keychainHasKeys(), 'A5. both keys now in the (ephemeral) Keychain');

  st = await get(`${s1.url}/api/v1/account/status`);
  ok(st.body.initialized === true, 'A6. status flips to initialized:true after setup');

  const again = await post(`${s1.url}/api/v1/account/setup`);
  ok(again.status === 409, 'A7. second /setup → 409 already_initialized', `(${again.status})`);

  const rk = await get(`${s1.url}/api/v1/account/recovery-key`);
  ok(rk.status === 200 && rk.body.recoveryKey === recoveryKey, 'A8. GET /recovery-key returns the same key');

  // ── U10 / D-027 — recovery-key BACKUP affordances (security-sensitive) ─────
  // (a) The dropped `op`-CLI save path must NOT report the user's correct config
  //     as their misconfiguration. Saving to the removed '1password' target is a
  //     plain bad_target now — never "not signed in" / "enable CLI integration".
  const op = await post(`${s1.url}/api/v1/account/recovery-key/save`, { target: '1password' });
  const opText = JSON.stringify(op.body).toLowerCase();
  // MUTATION-TESTED: re-added a router `target:'1password'` branch → 500 save_failed w/ false-blame text → U1a + U1b RED (restored → GREEN)
  ok(op.status === 400 && op.body.error === 'bad_target', 'U1a. save target:1password → 400 bad_target (op path dropped)', `(${op.status}/${op.body.error})`);
  ok(!/signed[\s_-]?out|not signed in|cli integration|op signin/.test(opText),
    'U1b. no false-blame ("not signed in"/"enable CLI integration") in the save response');

  // (b) A real save must NEVER echo the recovery key back to the client. Exercise
  //     the live Keychain save (isolated namespace) and assert the value is absent,
  //     then clean up the labelled item so the real Keychain is untouched.
  const kcSave = await post(`${s1.url}/api/v1/account/recovery-key/save`, { target: 'keychain' });
  const kcText = JSON.stringify(kcSave.body);
  ok(kcSave.status === 200 && kcSave.body.ok === true, 'U2a. save target:keychain → 200 ok', `(${kcSave.status})`);
  // MUTATION-TESTED: added `recoveryKey: key` to the keychain-save success JSON → U2b RED (restored → GREEN)
  ok(!kcText.includes(recoveryKey), 'U2b. the save response never contains the recovery-key value');
  try { execFileSync('security', ['delete-generic-password', '-a', process.env.MYCELIUM_KC_ACCOUNT, '-s', 'Mycelium Recovery Key'], { stdio: 'ignore' }); } catch { /* best-effort cleanup */ }

  const served = await get(`${s1.url}/api/v1/portal/mindscape/structure`);
  ok(served.status !== 503, 'A9. vault data path no longer 503 after setup', `(${served.status})`);

  await new Promise((r) => s1.server.close(r)); s1.close?.();

  // ── B. restore on a "new machine" (Keychain cleared, vault files remain) ───
  deleteKeychain();
  ok(!keychainHasKeys(), 'B1. Keychain cleared (simulating a new machine)');
  ok(existsSync(DB) && existsSync(KCV), 'B2. vault db + kcv still present on disk');

  s2 = await startRestServer({ port: 0, host: '127.0.0.1', dbPath: DB, kcvPath: KCV });
  let st2 = await get(`${s2.url}/api/v1/account/status`);
  ok(st2.body.initialized === false, 'B3. start with no keys → setup mode again');

  const wrong = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey: 'a'.repeat(64) });
  ok(wrong.status === 400 && wrong.body.error === 'wrong_key', 'B4. restore WRONG key → 400 wrong_key', `(${wrong.body.error})`);
  ok(!keychainHasKeys(), 'B5. a wrong key is NOT written to the Keychain');

  const bad = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey: 'not-hex' });
  ok(bad.status === 400 && bad.body.error === 'invalid_key', 'B6. restore malformed key → 400 invalid_key');

  const good = await post(`${s2.url}/api/v1/account/restore`, { recoveryKey });
  ok(good.status === 200 && good.body.ok === true, 'B7. restore CORRECT key → 200 ok');
  ok(keychainHasKeys(), 'B8. correct key written to the Keychain on restore');

  st2 = await get(`${s2.url}/api/v1/account/status`);
  ok(st2.body.initialized === true, 'B9. status initialized:true after restore');

  await new Promise((r) => s2.server.close(r)); s2.close?.();
} catch (err) {
  fail++; console.log('FAIL  unexpected error:', err?.message || err);
} finally {
  try { if (s1?.server?.listening) s1.server.close(); } catch { /* noop */ }
  try { if (s2?.server?.listening) s2.server.close(); } catch { /* noop */ }
  try { deleteKeychain(); } catch { /* noop */ }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log(fail
  ? 'VERDICT: NO-GO'
  : 'VERDICT: GO — setup-mode boot + account ceremony (status, 503 guard, setup, restore wrong/right, recovery-key)');
process.exit(fail ? 1 : 0);
