// Verify Phase G — the in-app "generate mindscape" trigger (POST
// /api/v1/portal/mycelium/generate + status polling). Drives the full job
// lifecycle against a FAKE pipeline script (MYCELIUM_CLUSTER_SCRIPT), so the
// registry/progress-parse/single-flight/error paths are Tier-1 verifiable; the
// REAL run-clustering.sh needs the Tier-2 Python stack on the host.
//
// The fake "ok" script EXITS NON-ZERO if USER_MASTER/SYSTEM_KEY aren't in its
// env — so G3 reaching "done" proves the keys were re-resolved and passed into
// the child env (and the allowlist didn't drop them). Keys are never asserted by
// value (zero-leak) — only that the child had them.
//
//   G1 trigger         POST /mycelium/generate → {jobId, status:'running'}
//   G2 single-flight   immediate 2nd POST → {status:'already_running', same jobId}
//   G3 progress+done   poll status → step advances 1→5, stageLabel set, status 'done'
//                      (proves keys reached the child: the script exits 3 without them)
//   G4 error path      a failing script → status 'error' (generic, no stderr leak)
//   G5 unknown job     GET status/<bogus> → 404
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-generate.db';
const KCV = 'data/verify-generate-kcv.json';
const OK = path.resolve('data/gen-ok.sh');
const FAIL = path.resolve('data/gen-fail.sh');
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  // Fake pipeline scripts. "ok" guards on the keys being present in its env.
  writeFileSync(OK, `#!/usr/bin/env bash
if [ -z "$USER_MASTER" ] || [ -z "$SYSTEM_KEY" ]; then echo "missing keys" >&2; exit 3; fi
echo "Step 1/5: Sync"; sleep 0.2
echo "Step 2/5: Cluster"; sleep 0.2
echo "Step 3/5: Describe"; sleep 0.2
echo "Step 4/5: Cofire"; sleep 0.2
echo "Step 5/5: Harmonics"; sleep 0.1
exit 0
`);
  writeFileSync(FAIL, `#!/usr/bin/env bash
echo "Step 1/5: Sync"; exit 1
`);

  const uHex = hex(), sHex = hex();
  // The spawn re-resolves keys from the source — use env source so it can.
  process.env.MYCELIUM_KEY_SOURCE = 'env';
  process.env.USER_MASTER_KEY = uHex;
  process.env.SYSTEM_KEY = sHex;

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: uHex, systemHex: sHex, port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url } = srv;
  const M = (p) => `${url}/api/v1/portal${p}`;
  const post = async (p) => { const r = await fetch(M(p), { method: 'POST' }); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const get = async (p) => { const r = await fetch(M(p)); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };

  try {
    // ── G1 trigger ──
    process.env.MYCELIUM_CLUSTER_SCRIPT = OK;
    const g1 = await post('/mycelium/generate');
    const jobId = g1.body?.jobId;
    rec('G1. POST /mycelium/generate → {jobId, status:running}', g1.status === 200 && !!jobId && g1.body?.status === 'running', `status=${g1.status} jobId=${jobId}`);

    // ── G2 single-flight (script still sleeping) ──
    const g2 = await post('/mycelium/generate');
    rec('G2. concurrent POST → already_running (same job)', g2.body?.status === 'already_running' && g2.body?.jobId === jobId, `status=${g2.body?.status} jobId=${g2.body?.jobId}`);

    // ── G3 poll to completion; track progress ──
    let maxStep = 0, final = null;
    for (let i = 0; i < 80; i++) {
      const s = await get(`/mycelium/generate/status/${jobId}`);
      if (s.status === 200) { maxStep = Math.max(maxStep, s.body?.step || 0); final = s.body; if (s.body?.status !== 'running') break; }
      await sleep(150);
    }
    rec('G3. progress parsed → done (step 1→5; keys reached child)',
      final?.status === 'done' && final?.step === 5 && final?.totalSteps === 5 && final?.stageLabel === 'Complete' && maxStep === 5,
      `status=${final?.status} step=${final?.step} stage=${final?.stageLabel} maxStep=${maxStep}`);

    // ── G4 error path ──
    process.env.MYCELIUM_CLUSTER_SCRIPT = FAIL;
    const g4 = await post('/mycelium/generate');
    let err = null;
    for (let i = 0; i < 40; i++) {
      const s = await get(`/mycelium/generate/status/${g4.body?.jobId}`);
      if (s.body?.status !== 'running') { err = s.body; break; }
      await sleep(150);
    }
    rec('G4. failing pipeline → status:error (generic, no stderr leak)',
      err?.status === 'error' && typeof err?.error === 'string' && !/Step|bash|\//.test(err.error),
      `status=${err?.status} error=${JSON.stringify(err?.error)}`);

    // ── G5 unknown job ──
    const g5 = await get('/mycelium/generate/status/gen_does_not_exist');
    rec('G5. unknown job → 404', g5.status === 404);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    for (const f of [OK, FAIL]) { try { rmSync(f); } catch {} }
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase G: clustering job registry (trigger + progress + single-flight + fail-closed; keys re-resolved into child env)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-generate threw:', e); process.exit(1); });
