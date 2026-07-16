#!/usr/bin/env node
// install-vault.mjs — the ONLY sanctioned way to put a repaired/rebuilt vault into place.
//
// Manual swaps are how the 2026-07 corruption series kept re-igniting: a rebuilt,
// integrity-ok file dropped next to a stale mycelium.db-wal gets the previous
// generation's frames silently replayed into it on first open (mechanism demonstrated
// 2026-07-16; see src/db/wal-guard.js). One swap done by hand with the sidecars removed
// survived; one done by hand without that step died within hours. This script IS that
// hygiene, always, in order:
//
//   1. REFUSE if anything holds the live vault (lsof) — never swap under a writer.
//   2. Validate the candidate: quick_check ok + a real write/readback/delete probe.
//   3. Archive the outgoing db WITH its -wal/-shm as one unit (evidence, never deleted).
//   4. Install the candidate via rename (atomic), leaving NO sidecar files behind.
//   5. Re-record the wal-guard binding so the new generation is the recorded owner.
//   6. Verify the installed file opens + quick_check ok at its final path.
//
// Usage: node scripts/vault-repair/install-vault.mjs <candidate.db> [--yes]
//   Prints the plan and refuses without --yes (a vault swap deserves one deliberate flag).

import Database from 'better-sqlite3';
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { dbPath } from '../../src/paths.js';
import { readUserMaster, deriveDbKey } from '../../src/account/keystore.js';
import { recordVaultBinding } from '../../src/db/wal-guard.js';
import { recordDurabilityEvent } from '../../src/db/durability-log.js';

const CANDIDATE = process.argv[2];
const YES = process.argv.includes('--yes');
const die = (m) => { console.error(`FAIL: ${m}`); process.exit(1); };

if (!CANDIDATE) die('usage: install-vault.mjs <candidate.db> [--yes]');
if (!existsSync(CANDIDATE)) die(`candidate not found: ${CANDIDATE}`);

const LIVE = dbPath();
const hex = readUserMaster();
if (!hex) die('USER_MASTER not found in Keychain — cannot validate the candidate');
const KEY = deriveDbKey(hex);

const open = (p, ro) => {
  const d = new Database(p, { fileMustExist: true, readonly: !!ro });
  d.pragma(`cipher='sqlcipher'`); d.pragma(`key="x'${KEY}'"`); d.pragma('cache_size=-100000');
  return d;
};

// 1. Zero holders — a swap under any open handle corrupts by construction.
let holders = '';
try { holders = execFileSync('lsof', ['-t', LIVE], { encoding: 'utf8' }).trim(); } catch { /* lsof exits 1 when none — that is the good case */ }
if (holders) die(`the live vault is OPEN by pid(s) ${holders.replace(/\n/g, ', ')} — quit the app first (osascript -e 'quit app "Mycelium Dev"'), then verify lsof is empty`);

// 2. Candidate must be genuinely healthy: structure AND writability.
console.log(`[install] validating candidate ${CANDIDATE} …`);
{
  const c = open(CANDIDATE, false);
  const qc = c.prepare('PRAGMA quick_check').all().map((r) => r.quick_check);
  if (!(qc.length === 1 && qc[0] === 'ok')) { c.close(); die(`candidate quick_check: ${qc.join(' | ').slice(0, 120)}`); }
  try {
    c.prepare("INSERT INTO messages (id, user_id, role, content, created_at) VALUES ('__install_probe__','local-user','user','probe','2000-01-01T00:00:00.000Z')").run();
    const got = c.prepare("SELECT content FROM messages WHERE id='__install_probe__'").get();
    c.prepare("DELETE FROM messages WHERE id='__install_probe__'").run();
    if (got?.content !== 'probe') throw new Error('readback mismatch');
  } catch (e) { c.close(); die(`candidate failed the WRITE probe (${e?.code || e?.message}) — an unwritable vault must never be installed`); }
  // The probe wrote → a candidate -wal now exists; fold it in so the install is one file.
  c.pragma('wal_checkpoint(TRUNCATE)');
  c.close();
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const plan = [
  `archive  ${LIVE}  (+ -wal/-shm as a unit)  →  ${LIVE}.replaced-${stamp}*`,
  `install  ${CANDIDATE}  →  ${LIVE}   (rename, atomic; no sidecars left behind)`,
  `rebind   wal-guard to the new generation`,
];
console.log(`[install] plan:\n  - ${plan.join('\n  - ')}`);
if (!YES) { console.log('\n[install] dry run — re-run with --yes to execute.'); process.exit(0); }

// 3. Archive the outgoing generation as a UNIT (db + sidecars share the fate — split
//    them and the leftover half becomes the exact bomb this tool exists to defuse).
if (existsSync(LIVE)) {
  renameSync(LIVE, `${LIVE}.replaced-${stamp}`);
  for (const sfx of ['-wal', '-shm']) {
    if (existsSync(`${LIVE}${sfx}`)) renameSync(`${LIVE}${sfx}`, `${LIVE}.replaced-${stamp}${sfx}`);
  }
  console.log(`[install] outgoing vault archived → ${path.basename(LIVE)}.replaced-${stamp}`);
}
// Belt & suspenders: nothing may remain at the canonical sidecar names.
for (const sfx of ['-wal', '-shm']) rmSync(`${LIVE}${sfx}`, { force: true });

// 4. Install (rename = atomic on the same filesystem; cross-device would throw — good).
renameSync(CANDIDATE, LIVE);

// 5. The new generation is now the rightful owner of any future WAL.
recordVaultBinding(LIVE);
recordDurabilityEvent('vault-installed', { from: path.basename(CANDIDATE), bytes: statSync(LIVE).size });

// 6. Final verification at the final path.
{
  const v = open(LIVE, true);
  const qc = v.prepare('PRAGMA quick_check').all().map((r) => r.quick_check);
  const n = v.prepare('SELECT count(*) c FROM messages').get().c;
  v.close();
  if (!(qc.length === 1 && qc[0] === 'ok')) die(`installed vault quick_check FAILED: ${qc.join('|').slice(0, 120)}`);
  console.log(`[install] DONE — installed vault verified at ${LIVE} (quick_check ok, ${n} messages). Relaunch the app.`);
}
