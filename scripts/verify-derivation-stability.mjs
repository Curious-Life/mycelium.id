// scripts/verify-derivation-stability.mjs — A0: FREEZE the key-derivation scheme.
//
// deriveSystemKey and deriveDbKey are PERMANENT cryptographic commitments: their
// HKDF `info` strings ('mycelium:system-key:v1' / 'mycelium:db-cipher:v1') and
// algorithm must NEVER change, or every existing vault becomes undecryptable
// (SYSTEM_KEY orphans the secrets table; DB key makes SQLCipher unopenable).
//
// This gate pins the outputs for a fixed recovery key to golden values. If a
// refactor changes the info label, salt, algorithm, or output encoding, these
// assertions fail LOUDLY — which is the whole point. Do NOT "update the goldens"
// to make it pass; a changed value means a vault-orphaning regression.
// VERDICT: GO / exit 0.
import { deriveSystemKey, deriveDbKey, isHex64 } from '../src/account/keystore.js';

const FIXED = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
// Golden values — computed once from the frozen scheme (2026-07-09). PERMANENT.
const GOLDEN_SYSTEM = 'ce64bb00886a4e8a162a5dff6d1340f85582656b7f37eb7dad0ec8a2d70caef6';
const GOLDEN_DBKEY  = 'd140d05d4213c8064162ef94c68b8ff44b67c34c7be483490cae694d36d58596';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const sys = deriveSystemKey(FIXED);
const dbk = deriveDbKey(FIXED);
ok(isHex64(sys), 'D1. deriveSystemKey returns 64-hex');
ok(isHex64(dbk), 'D2. deriveDbKey returns 64-hex');
ok(sys === GOLDEN_SYSTEM, `D3. SYSTEM_KEY derivation FROZEN (info=mycelium:system-key:v1)${sys === GOLDEN_SYSTEM ? '' : `\n      got ${sys}\n      exp ${GOLDEN_SYSTEM} — a change here ORPHANS every vault's secrets table`}`);
ok(dbk === GOLDEN_DBKEY, `D4. DB_CIPHER derivation FROZEN (info=mycelium:db-cipher:v1)${dbk === GOLDEN_DBKEY ? '' : `\n      got ${dbk}\n      exp ${GOLDEN_DBKEY} — a change here makes the SQLCipher vault UNOPENABLE`}`);
ok(deriveSystemKey(FIXED) === sys && deriveDbKey(FIXED) === dbk, 'D5. deterministic (same input → same output)');
ok(sys !== dbk && sys !== FIXED && dbk !== FIXED, 'D6. domain separation (system ≠ db ≠ master)');

console.log('');
if (failures) { console.log(`VERDICT: NO-GO — ${failures} failure(s): KEY DERIVATION CHANGED — this would orphan existing vaults. Do NOT update goldens; revert the derivation change.`); process.exit(1); }
console.log('VERDICT: GO — key-derivation scheme is frozen and stable');
