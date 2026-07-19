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
//   G0 preflight       no embedded messages → 409 (refuse, don't spawn a doomed run)
//   G4 error path      a failing script → status 'error' surfacing its last stderr line
//   G5 unknown job     GET status/<bogus> → 404
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { shouldAutoGenerate } from '../src/jobs.js';

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
echo "Step 1/5: Sync"
echo "RuntimeError: clustering precondition failed" >&2
exit 1
`);

  const uHex = hex(), sHex = hex();
  // The spawn re-resolves keys from the source — use env source so it can.
  process.env.MYCELIUM_KEY_SOURCE = 'env';
  process.env.USER_MASTER_KEY = uHex;
  process.env.SYSTEM_KEY = sHex;

  // ── G0: the preflight refuses on an empty vault (short-lived server) ──
  {
    const s0 = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: uHex, systemHex: sHex, port: 0, host: '127.0.0.1', portalMode: 'legacy' });
    const r = await fetch(`${s0.url}/api/v1/portal/mycelium/generate`, { method: 'POST' });
    const b = await r.json().catch(() => ({}));
    rec('G0. preflight: 0 messages → 409 (no doomed spawn)', r.status === 409 && b?.reason === 'no_messages', `status=${r.status} reason=${b?.reason}`);
    s0.server.close(); try { s0.close?.(); } catch {}
  }
  // Seed ≥5 embedded messages so the real job lifecycle runs past the preflight.
  { const s = new Database(DB); const ins = s.prepare("INSERT INTO messages (id, user_id, content, embedding_768) VALUES (?, 'local-user', 'x', 'x')"); for (let i = 0; i < 6; i++) ins.run('seed-' + i); s.close(); }

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
    rec('G4. failing pipeline → status:error surfacing the REAL reason (single line)',
      err?.status === 'error' && typeof err?.error === 'string'
        && err.error.includes('clustering precondition failed') && !err.error.includes('\n'),
      `status=${err?.status} error=${JSON.stringify(err?.error)}`);

    // ── G5 unknown job ──
    const g5 = await get('/mycelium/generate/status/gen_does_not_exist');
    rec('G5. unknown job → 404', g5.status === 404);

    // ── G6 first-run auto-continue gate (shouldAutoGenerate truth table) ──
    rec('G6a. fires: enough embedded + no topology + not running', shouldAutoGenerate({ embedded: 30, points: 0, clusteringRunning: false, min: 5 }) === true);
    rec('G6b. holds: below the data floor (trivial-cluster guard)', shouldAutoGenerate({ embedded: 4, points: 0, clusteringRunning: false, min: 5 }) === false);
    rec('G6c. holds: topology already built (re-gen stays manual)', shouldAutoGenerate({ embedded: 100, points: 500, clusteringRunning: false, min: 5 }) === false);
    rec('G6d. holds: clustering already running (single-flight)', shouldAutoGenerate({ embedded: 100, points: 0, clusteringRunning: true, min: 5 }) === false);

    // ── G6e ⭐ THE FLOOR IS THE MANUAL FLOOR (PIPELINE-TRANSPARENCY-DESIGN §"Filling the gaps" #2).
    // The truth table above pins the PURE function; G6e pins the value the WIRE actually passes.
    // At 25 a real-but-small vault (5–24 embedded) auto-clustered NEVER and nothing prompted the
    // user — a silent stall. Read server-rest.js's AUTO_GEN_MIN default and assert it is the manual
    // floor MIN_EMBEDDED (5). Mutate that default back to 25 (or anything > 5) and this reds.
    // Paired with G6f: a vault AT the manual floor (exactly 5 embedded) must auto-fire under it.
    {
      const src = readFileSync(path.resolve('src/server-rest.js'), 'utf8');
      const m = src.match(/const\s+AUTO_GEN_MIN\s*=\s*Number\(process\.env\.MYCELIUM_AUTO_GEN_MIN\)\s*\|\|\s*(\d+)/);
      const wireFloor = m ? Number(m[1]) : NaN;
      rec(`G6e. the wire auto-gen floor is the manual floor (5, was 25) — got ${wireFloor}`, wireFloor === 5);
      rec('G6f. a vault AT the manual floor (5 embedded) auto-fires under the wire floor',
        Number.isFinite(wireFloor) && shouldAutoGenerate({ embedded: 5, points: 0, clusteringRunning: false, min: wireFloor }) === true);
    }
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    for (const f of [OK, FAIL]) { try { rmSync(f); } catch {} }
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — Phase G: clustering job registry (trigger + progress + single-flight + fail-closed; keys re-resolved into child env)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-generate threw:', e); process.exit(1); });
