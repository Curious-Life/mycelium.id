// Verify the master-key source layer (src/crypto/key-source.js).
//
// A MOCK exec stands in for `security` (macOS Keychain) and `op` (1Password) —
// no real Keychain, no real 1Password, no real keys. Asserts:
//   K1  env source reads USER_MASTER_KEY / SYSTEM_KEY (trimmed)
//   K2  env source missing → fail-closed (KeySourceError)
//   K3  non-hex value → rejected, and the error never contains the value
//   K4  keychain source → `security find-generic-password -a <acct> -s <svc> -w`
//   K5  keychain item missing → clear error pointing at set-keys
//   K6  keychain on non-macOS (`security` ENOENT) → clear "macOS only" error
//   K7  1password source → `op read <ref>` for both refs
//   K8  1password missing reference → clear error
//   K9  unknown source → rejected
//   K10 injection-safety: a service name with shell metachars is passed as ONE
//       argv element (arg array, never a shell string)
//   K11 secret leak-safety: no thrown error contains the secret value
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>; process.exit reflects pass/fail.

import { resolveKeys, KeySourceError } from '../src/crypto/key-source.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
};

const HEXA = 'a'.repeat(64);
const HEXB = 'b'.repeat(64);

// Mock exec: records calls; maps (cmd,args) → output via a routing table.
function mockExec(routes, calls = []) {
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    for (const r of routes) {
      if (r.match(cmd, args)) {
        if (r.throw) { const e = new Error(r.throw.msg || 'exec failed'); if (r.throw.code) e.code = r.throw.code; throw e; }
        return r.out;
      }
    }
    const e = new Error(`mock exec: no route for ${cmd} ${args.join(' ')}`); e.code = 'ENOENT'; throw e;
  };
  fn.calls = calls;
  return fn;
}

function main() {
  // K1 — env source.
  {
    const env = { USER_MASTER_KEY: `  ${HEXA}  `, SYSTEM_KEY: HEXB };
    const { userHex, systemHex } = resolveKeys({ env, exec: mockExec([]) });
    rec('K1. env source reads + trims USER_MASTER_KEY / SYSTEM_KEY', userHex === HEXA && systemHex === HEXB);
  }

  // K2 — env missing → fail-closed.
  {
    let err = null;
    try { resolveKeys({ env: {}, exec: mockExec([]) }); } catch (e) { err = e; }
    rec('K2. env source with nothing set → KeySourceError (fail-closed)', err instanceof KeySourceError, err?.message);
  }

  // K3 — non-hex rejected, value not leaked.
  {
    const bad = 'NOTHEX_SECRET_VALUE_SHOULD_NOT_LEAK';
    let err = null;
    try { resolveKeys({ env: { USER_MASTER_KEY: bad, SYSTEM_KEY: HEXB }, exec: mockExec([]) }); } catch (e) { err = e; }
    rec('K3. non-hex value rejected, and its value is NOT in the error',
      err instanceof KeySourceError && !String(err.message).includes(bad), err?.message);
  }

  // K4 — keychain source, correct argv.
  {
    const calls = [];
    const exec = mockExec([
      { match: (c, a) => c === 'security' && a.includes('mycelium-user-master'), out: HEXA },
      { match: (c, a) => c === 'security' && a.includes('mycelium-system-key'), out: HEXB },
    ], calls);
    const { userHex, systemHex } = resolveKeys({ env: { MYCELIUM_KEY_SOURCE: 'keychain' }, exec });
    const u = calls.find((c) => c.args.includes('mycelium-user-master'));
    rec('K4. keychain → security find-generic-password -a <acct> -s <svc> -w',
      userHex === HEXA && systemHex === HEXB
        && u.args[0] === 'find-generic-password' && u.args.includes('-a') && u.args.includes('mycelium') && u.args.includes('-w'),
      `argv=${JSON.stringify(u.args)}`);
  }

  // K5 — keychain item missing (non-ENOENT failure).
  {
    const exec = mockExec([{ match: (c) => c === 'security', throw: { msg: 'not found', code: 1 } }]);
    let err = null;
    try { resolveKeys({ env: { MYCELIUM_KEY_SOURCE: 'keychain' }, exec }); } catch (e) { err = e; }
    rec('K5. keychain item missing → clear error mentioning set-keys',
      err instanceof KeySourceError && /set-keys/.test(err.message), err?.message);
  }

  // K6 — `security` absent (ENOENT) → macOS-only hint.
  {
    const exec = mockExec([{ match: (c) => c === 'security', throw: { msg: 'enoent', code: 'ENOENT' } }]);
    let err = null;
    try { resolveKeys({ env: { MYCELIUM_KEY_SOURCE: 'keychain' }, exec }); } catch (e) { err = e; }
    rec('K6. keychain on non-macOS (security ENOENT) → clear "macOS" error',
      err instanceof KeySourceError && /macOS/.test(err.message), err?.message);
  }

  // K7 — 1password source.
  {
    const calls = [];
    const exec = mockExec([
      { match: (c, a) => c === 'op' && a[1] === 'op://Private/Mycelium/user', out: HEXA },
      { match: (c, a) => c === 'op' && a[1] === 'op://Private/Mycelium/system', out: HEXB },
    ], calls);
    const { userHex, systemHex } = resolveKeys({
      env: { MYCELIUM_KEY_SOURCE: '1password', MYCELIUM_OP_USER: 'op://Private/Mycelium/user', MYCELIUM_OP_SYSTEM: 'op://Private/Mycelium/system' },
      exec,
    });
    rec('K7. 1password → op read <ref> for both refs',
      userHex === HEXA && systemHex === HEXB && calls[0].cmd === 'op' && calls[0].args[0] === 'read',
      `argv0=${JSON.stringify(calls[0].args)}`);
  }

  // K8 — 1password missing reference.
  {
    let err = null;
    try { resolveKeys({ env: { MYCELIUM_KEY_SOURCE: '1password' }, exec: mockExec([]) }); } catch (e) { err = e; }
    rec('K8. 1password without a secret reference → clear error',
      err instanceof KeySourceError && /reference|op:\/\//.test(err.message), err?.message);
  }

  // K9 — unknown source.
  {
    let err = null;
    try { resolveKeys({ env: { MYCELIUM_KEY_SOURCE: 'magic' }, exec: mockExec([]) }); } catch (e) { err = e; }
    rec('K9. unknown MYCELIUM_KEY_SOURCE → rejected', err instanceof KeySourceError, err?.message);
  }

  // K10 — injection-safety: metachars stay one argv element.
  {
    const calls = [];
    const evil = 'mycelium-user-master; rm -rf ~';
    const exec = mockExec([{ match: (c, a) => c === 'security' && a.includes(evil), out: HEXA }, { match: (c) => c === 'security', out: HEXB }], calls);
    resolveKeys({ env: { MYCELIUM_KEY_SOURCE: 'keychain', MYCELIUM_KC_USER: evil }, exec });
    const got = calls[0].args.includes(evil);
    rec('K10. injection-safety: service name passed as ONE argv element (no shell)', got,
      `argv=${JSON.stringify(calls[0].args)}`);
  }

  // K11 — secret leak-safety across error paths: a returned non-hex secret is
  // rejected without echoing it.
  {
    const secret = 'leaky-secret-from-keychain-not-hex';
    const exec = mockExec([{ match: (c) => c === 'security', out: secret }]);
    let err = null;
    try { resolveKeys({ env: { MYCELIUM_KEY_SOURCE: 'keychain' }, exec }); } catch (e) { err = e; }
    rec('K11. a non-hex secret from the source is rejected, value not leaked in the error',
      err instanceof KeySourceError && !String(err.message).includes(secret) && !String(err.stack || '').includes(secret),
      err?.message);
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — key-source layer: env|keychain|1password, fail-closed, shell-injection-safe, no secret leakage' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main();
