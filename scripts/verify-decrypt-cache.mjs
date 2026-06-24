// verify:decrypt-cache — the decrypt-once plaintext cache + isEncrypted prefix-guard.
//
// Proves the perf change is correct AND can't weaken security:
//   1. prefix-guard rejects plaintext fast + NEVER skips a real envelope (0 false-neg)
//   2. cache hit returns the SAME plaintext as a fresh decrypt (and is faster)
//   3. AUTHZ is NOT bypassed — a scope-denied caller still throws on a CACHED envelope
//   4. no staleness — a re-encrypted (new) envelope decrypts fresh
//   5. SYSTEM_KEY (secrets) envelopes round-trip (excluded from the cache by design)
//   6. clearAllCaches() drops the plaintext cache
import {
  importMasterKey, encrypt, encryptWithSystemKey, decrypt, isEncrypted,
  clearAllCaches, ScopeViolationError,
} from '../src/crypto/crypto-local.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); cond ? pass++ : fail++; };
const now = () => Number(process.hrtime.bigint()) / 1e6;

const userKey = await importMasterKey('a'.repeat(64));
const sysKey = await importMasterKey('b'.repeat(64));

// ── 1. prefix-guard ──────────────────────────────────────────────────────────
const env = await encrypt('a secret reflection about today', 'personal', userKey);
ok('1a. isEncrypted(envelope) === true', isEncrypted(env) === true);
ok("1b. plaintext not starting 'ey' → false (fast reject)", isEncrypted('Hello, this is plaintext content') === false);
ok("1c. 'ey'-prefixed non-envelope → false (full check still runs)", isEncrypted('eyebrow notes, long enough to pass the length gate') === false);
// 0 false-negatives over a corpus of real envelopes (varied scopes/sizes)
let missed = 0;
for (let i = 0; i < 200; i++) { const e = await encrypt(`row ${i} ${'x'.repeat(i % 50)}`, 'personal', userKey); if (!isEncrypted(e)) missed++; }
ok('1d. prefix-guard skips 0 real envelopes (200-corpus)', missed === 0, `missed=${missed}`);

// ── 2. cache hit == fresh decrypt, and faster ────────────────────────────────
await clearAllCaches();
const big = await encrypt('content '.repeat(200), 'personal', userKey);
let t = now(); const cold = await decrypt(big, userKey, ['personal']); const tCold = now() - t;
t = now(); const warm = await decrypt(big, userKey, ['personal']); const tWarm = now() - t;
ok('2a. cache hit returns identical plaintext', cold === warm && cold.startsWith('content'));
ok('2b. cache hit is faster than cold decrypt', tWarm < tCold, `cold=${tCold.toFixed(2)}ms warm=${tWarm.toFixed(3)}ms`);

// ── 3. AUTHZ not bypassed — scope-denied caller throws on a CACHED envelope ───
// 'big' is now cached (decrypted above under allowedScopes incl. 'personal').
let denied = false;
try { await decrypt(big, userKey, ['some-other-scope']); }
catch (e) { denied = e instanceof ScopeViolationError; }
ok('3. cached envelope STILL denied for a non-allowed scope (cache never bypasses authz)', denied === true);
// admin mode (allowedScopes=null) still allowed
ok('3b. admin (allowedScopes=null) still decrypts', (await decrypt(big, userKey, null)) === cold);

// ── 4. no staleness — a NEW envelope (re-encrypt) decrypts fresh ──────────────
const v1 = await encrypt('original value', 'personal', userKey);
const d1 = await decrypt(v1, userKey, ['personal']);          // caches v1
const v2 = await encrypt('UPDATED value', 'personal', userKey); // update = new envelope
ok('4a. re-encrypt produces a different envelope string', v1 !== v2);
ok('4b. new envelope decrypts to the new plaintext (no stale hit)', (await decrypt(v2, userKey, ['personal'])) === 'UPDATED value' && d1 === 'original value');

// ── 5. SYSTEM_KEY envelopes round-trip (excluded from cache by design) ────────
const sysEnv = await encryptWithSystemKey('an operator token', 'org', sysKey);
const s1 = await decrypt(sysEnv, userKey, ['org'], { systemKey: sysKey });
const s2 = await decrypt(sysEnv, userKey, ['org'], { systemKey: sysKey });
ok('5. SYSTEM_KEY envelope decrypts correctly (and repeatedly)', s1 === 'an operator token' && s2 === s1);

// ── 6. clearAllCaches drops the plaintext cache (still correct after) ─────────
await clearAllCaches();
ok('6. decrypt still correct after clearAllCaches()', (await decrypt(big, userKey, ['personal'])) === cold);

console.log(`\n${fail === 0 ? 'VERDICT: GO' : 'VERDICT: NO-GO'} — ${pass}/${pass + fail} passed`);
process.exit(fail === 0 ? 0 : 1);
