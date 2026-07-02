// scripts/verify-keystore.mjs — the Keychain WRITE guard (src/account/keystore.js).
//
// Context: on 2026-06-05 a fresh-key ceremony overwrote the real
// `mycelium-user-master` item in place (`security add-generic-password -U` keeps
// NO version history), and an 81MB vault encrypted under the destroyed key
// became permanently undecryptable. This gate locks in the two independent
// defenses added in response, plus the test-isolation discipline that the stray
// `mycelium-firsttest/fresh2/fresh3/freshtest` items proved was being skipped.
//
// HERMETIC: a MOCK exec stands in for `security` (an in-memory Keychain map) —
// no real Keychain is touched, so this runs identically on macOS and Linux/CI
// and can NEVER clobber a real key. Asserts:
//   W1  backup-before-overwrite: a different-value overwrite copies the PRIOR
//       secret to a `<service>.bak.<ts>` companion before replacing it
//   W2  same-value write is idempotent (no backup, no error, even default ns)
//   W3  default namespace + different value + NO force → KeyOverwriteError, and
//       NOTHING is written (the primary item is left untouched)
//   W4  default namespace + different value + force:true → writes AND backs up
//   W5  ephemeral namespace (overrides set) + different value + NO force → allowed
//       (tests are never blocked) and still backs up
//   W6  isDefaultNamespace: true with no overrides, false when any is set
//   W7  leak-safety: the refusal message carries NEITHER key value
//   W8  isolation discipline: verify-account + verify-passphrase-lock set all
//       three MYCELIUM_KC_* overrides (they namespace away from the real keys)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { writeKeychain, deleteKeychain, readUserMaster, keychainHasKeys, KeyOverwriteError } from '../src/account/keystore.js';
import { isDefaultNamespace } from '../src/account/keychain-names.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const SYS_A = 'c'.repeat(64);
const SYS_B = 'd'.repeat(64);

// ── Mock Keychain: an in-memory map keyed by "<account>\0<service>". The exec
//    signature is the keystore.js contract `(cmd, args, input) → trimmed stdout`,
//    throws on a missing item (mirrors `security` exit 44). WRITES now feed the
//    secret on stdin (`input`): `-w` carries no value and the key arrives as two
//    identical lines (security's enter+retype) — so the mock reads the secret
//    from `input`, falling back to the legacy argv `-w <value>` form. ──────────
function mockKeychain() {
  const store = new Map();
  const key = (acct, svc) => `${acct}\0${svc}`;
  const argval = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const exec = (cmd, args, input) => {
    if (cmd !== 'security') throw new Error(`mock: unexpected cmd ${cmd}`);
    const op = args[0];
    const acct = argval(args, '-a');
    const svc = argval(args, '-s');
    if (op === 'find-generic-password') {
      const k = key(acct, svc);
      if (!store.has(k)) { const e = new Error('not found'); e.code = 44; throw e; }
      return store.get(k);
    }
    if (op === 'add-generic-password') {
      // secret on stdin (first line of the enter+retype) or legacy argv `-w <value>`
      const secret = input != null ? String(input).split('\n')[0] : argval(args, '-w');
      store.set(key(acct, svc), secret); return '';
    }
    if (op === 'delete-generic-password') {
      const k = key(acct, svc);
      if (!store.has(k)) { const e = new Error('not found'); e.code = 44; throw e; }
      store.delete(k); return '';
    }
    throw new Error(`mock: unexpected op ${op}`);
  };
  return { exec, store };
}

// Find a backup companion item for `service` holding `expectedValue`.
const backupOf = (store, account, service, expectedValue) => [...store.entries()].some(
  ([k, v]) => k.startsWith(`${account}\0${service}.bak.`) && v === expectedValue);

const EPHEMERAL = { MYCELIUM_KC_ACCOUNT: 'mycelium-verify-keystore', MYCELIUM_KC_USER: 'mycelium-verify-keystore-user', MYCELIUM_KC_SYSTEM: 'mycelium-verify-keystore-system' };
const DEFAULT_ENV = {}; // no overrides → real (protected) namespace names

function main() {
  // W1 — backup-before-overwrite (ephemeral ns so it isn't blocked).
  {
    const { exec, store } = mockKeychain();
    writeKeychain(KEY_A, SYS_A, { env: EPHEMERAL, exec });
    writeKeychain(KEY_B, SYS_B, { env: EPHEMERAL, exec, force: false });
    const userNow = readUserMaster({ env: EPHEMERAL, exec });
    const backedUp = backupOf(store, EPHEMERAL.MYCELIUM_KC_ACCOUNT, EPHEMERAL.MYCELIUM_KC_USER, KEY_A)
      && backupOf(store, EPHEMERAL.MYCELIUM_KC_ACCOUNT, EPHEMERAL.MYCELIUM_KC_SYSTEM, SYS_A);
    rec('W1. overwrite backs up the PRIOR secret to a .bak companion before replacing',
      userNow === KEY_B && backedUp, `new=${userNow === KEY_B}, backup=${backedUp}`);
  }

  // W2 — same-value write is idempotent: no backup, no throw, default namespace.
  {
    const { exec, store } = mockKeychain();
    writeKeychain(KEY_A, SYS_A, { env: DEFAULT_ENV, exec, force: true }); // seed
    let threw = false;
    try { writeKeychain(KEY_A, SYS_A, { env: DEFAULT_ENV, exec }); } catch { threw = true; } // no force, same value
    const anyBak = [...store.keys()].some((k) => k.includes('.bak.'));
    rec('W2. re-writing the SAME value is idempotent (no force needed, no backup churn)',
      !threw && !anyBak, `threw=${threw}, backups=${anyBak}`);
  }

  // W3 — THE GUARD: default namespace + different value + no force → refuse, write nothing.
  {
    const { exec } = mockKeychain();
    writeKeychain(KEY_A, SYS_A, { env: DEFAULT_ENV, exec, force: true }); // seed the "real" key
    let err = null;
    try { writeKeychain(KEY_B, SYS_B, { env: DEFAULT_ENV, exec }); } catch (e) { err = e; }
    const untouched = readUserMaster({ env: DEFAULT_ENV, exec });
    rec('W3. default ns + different value + NO force → KeyOverwriteError, primary untouched',
      err instanceof KeyOverwriteError && untouched === KEY_A, `err=${err?.name}, key=${untouched === KEY_A ? 'unchanged' : 'CHANGED!'}`);
  }

  // W4 — default namespace + different value + force → writes AND backs up.
  {
    const { exec, store } = mockKeychain();
    writeKeychain(KEY_A, SYS_A, { env: DEFAULT_ENV, exec, force: true });
    writeKeychain(KEY_B, SYS_B, { env: DEFAULT_ENV, exec, force: true });
    const now = readUserMaster({ env: DEFAULT_ENV, exec });
    const backed = backupOf(store, 'mycelium', 'mycelium-user-master', KEY_A);
    rec('W4. default ns + different value + force → replaces AND backs up the old key',
      now === KEY_B && backed, `new=${now === KEY_B}, backup=${backed}`);
  }

  // W5 — ephemeral namespace is never blocked (tests must be able to overwrite).
  {
    const { exec } = mockKeychain();
    writeKeychain(KEY_A, SYS_A, { env: EPHEMERAL, exec });
    let threw = false;
    try { writeKeychain(KEY_B, SYS_B, { env: EPHEMERAL, exec }); } catch { threw = true; } // no force
    rec('W5. ephemeral ns + different value + NO force → allowed (tests not blocked)',
      !threw && readUserMaster({ env: EPHEMERAL, exec }) === KEY_B, `threw=${threw}`);
  }

  // W6 — isDefaultNamespace correctness (the protection trigger).
  {
    const allSet = isDefaultNamespace({ env: EPHEMERAL }) === false;
    const noneSet = isDefaultNamespace({ env: {} }) === true;
    const partial = isDefaultNamespace({ env: { MYCELIUM_KC_USER: 'x' } }) === false; // any one override de-protects
    rec('W6. isDefaultNamespace: true iff NO override is set (any override → ephemeral)',
      allSet && noneSet && partial, `none=${noneSet}, all=${allSet}, partial=${partial}`);
  }

  // W7 — leak-safety: the refusal message carries neither key value.
  {
    const { exec } = mockKeychain();
    writeKeychain(KEY_A, SYS_A, { env: DEFAULT_ENV, exec, force: true });
    let msg = '';
    try { writeKeychain(KEY_B, SYS_B, { env: DEFAULT_ENV, exec }); } catch (e) { msg = String(e.message); }
    rec('W7. refusal message leaks NEITHER the old nor the new key value',
      msg.length > 0 && !msg.includes(KEY_A) && !msg.includes(KEY_B) && !msg.includes(SYS_A) && !msg.includes(SYS_B),
      `len=${msg.length}`);
  }

  // W8 — isolation discipline: the real test harnesses namespace away.
  {
    const here = dirname(fileURLToPath(import.meta.url));
    const needles = ['MYCELIUM_KC_ACCOUNT', 'MYCELIUM_KC_USER', 'MYCELIUM_KC_SYSTEM'];
    const harnesses = ['verify-account.mjs', 'verify-passphrase-lock.mjs'];
    const offenders = [];
    for (const h of harnesses) {
      const src = readFileSync(join(here, h), 'utf8');
      const sets = needles.filter((n) => new RegExp(`process\\.env\\.${n}\\s*=`).test(src));
      if (sets.length !== needles.length) offenders.push(`${h} (sets ${sets.length}/3)`);
    }
    rec('W8. test harnesses set ALL three MYCELIUM_KC_* overrides (isolated from real keys)',
      offenders.length === 0, offenders.join('; '));
  }

  // Sanity: keychainHasKeys reflects the mock store (ties the read path in).
  {
    const { exec } = mockKeychain();
    const before = keychainHasKeys({ env: EPHEMERAL, exec });
    writeKeychain(KEY_A, SYS_A, { env: EPHEMERAL, exec });
    const after = keychainHasKeys({ env: EPHEMERAL, exec });
    deleteKeychain({ env: EPHEMERAL, exec });
    const gone = keychainHasKeys({ env: EPHEMERAL, exec });
    rec('W9. keychainHasKeys/deleteKeychain track the store (read+delete paths wired)',
      before === false && after === true && gone === false, `${before}→${after}→${gone}`);
  }

  const allPass = ledger.every(Boolean);
  console.log(`\n${ledger.filter(Boolean).length} passed, ${ledger.filter((x) => !x).length} failed`);
  console.log(`VERDICT: ${allPass
    ? 'GO — Keychain write guard: backup-before-overwrite, refuse-in-default-namespace, force-to-replace, test isolation'
    : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main();
