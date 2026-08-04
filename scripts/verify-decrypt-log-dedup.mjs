#!/usr/bin/env node
// verify:decrypt-log-dedup — D-127: a decrypt failure logs ONCE per unique
// (field, error), never once per row.
//
// THE DEFECT (2026-07-30 restore): ~996 identical `[DECRYPT ERROR] field="hrv_avg"`
// lines flooded boot, and plaintext attachment description/file_name values that
// shape-match isEncrypted() logged on EVERY library read — a console.warn per row per
// field on the hot read path. The dedup pattern existed ten lines away
// (logScopeViolation) and was never applied to this branch.
//
// CHECKS:
//   L1  50 rows carrying the SAME undecryptable envelope → at most 2 warn lines
//       (the first + optional summary), not 50
//   L2  behaviour unchanged: every value passes through AS-IS (still ciphertext)
//   L3  (control) a DIFFERENT field still gets its own first line — dedup is per
//       (field, error), not global silence
//
// MUTATION-TESTED: (D-127, 2026-08-03) both call sites reverted to the bare
// `console.warn(\`[DECRYPT ERROR] …\`)` → L1 REDs (52 lines for 50 rows) while L2/L3
// stay GREEN. Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { importMasterKey, autoDecryptResults, isEncrypted } from '../src/crypto/crypto-local.js';

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`  [✓] ${n}`); };
const bad = (n, e) => { fail++; console.log(`  [✗] ${n}\n      ${e?.message || e}`); };
const t = async (n, fn) => { try { await fn(); ok(n); } catch (e) { bad(n, e); } };

console.log('\nD-127 — decrypt-error logging is deduped');

importMasterKey(crypto.randomBytes(32).toString('hex'));

// An envelope-SHAPED value that decrypt() must fail on (garbage s/iv/ct/dk under this key).
const bogus = Buffer.from(JSON.stringify({
  v: 1, s: 'personal',
  iv: Buffer.alloc(12, 1).toString('base64'),
  ct: Buffer.alloc(24, 2).toString('base64'),
  dk: Buffer.alloc(40, 3).toString('base64'),
})).toString('base64');
assert.ok(isEncrypted(bogus), 'fixture must shape-match isEncrypted (starts "ey", parses as v1 envelope)');

const captured = [];
const realWarn = console.warn;
console.warn = (...a) => { captured.push(a.join(' ')); };
let rows;
try {
  rows = await autoDecryptResults(
    Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, hrv_avg: bogus })),
    null, null, { table: 'health_daily' },
  );
  // control: a different field name gets its own first line
  await autoDecryptResults([{ id: 'x', steps: bogus }], null, null, { table: 'health_daily' });
} finally { console.warn = realWarn; }

const decryptLines = captured.filter((l) => l.includes('[DECRYPT ERROR]'));
const hrvLines = decryptLines.filter((l) => l.includes('"hrv_avg"'));
const stepsLines = decryptLines.filter((l) => l.includes('"steps"'));

await t('L1: 50 identical failures → at most 2 log lines, not 50', async () => {
  assert.ok(hrvLines.length >= 1 && hrvLines.length <= 2,
    `expected 1-2 hrv_avg lines, got ${hrvLines.length} (pre-fix behaviour was one per row)`);
});
await t('L2: behaviour unchanged — every value passes through as ciphertext', async () => {
  assert.equal(rows.length, 50);
  assert.ok(rows.every((r) => r.hrv_avg === bogus), 'undecryptable values must be left AS-IS');
});
await t('L3 (control): a different field still logs its own first line', async () => {
  assert.equal(stepsLines.length, 1, `steps must get its own line (got ${stepsLines.length}) — dedup is per field, not global silence`);
});

console.log(`\nVERDICT: ${fail === 0 ? 'GO — decrypt failures log once per unique (field, error) with values passing through unchanged; a 996-row flood is now 1 line + a counter' : 'NO-GO'} — ${pass} passed, ${fail} failed\nEXIT=${fail === 0 ? 0 : 1}`);
process.exit(fail === 0 ? 0 : 1);
