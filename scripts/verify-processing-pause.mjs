// Verify the PERSIST half of §3.9/R3 (D13) — the pause route's settings write.
//
// ⚠️ WHY THIS FILE EXISTS: portal-compat.js's persistPause carried the comment "…drops
// taskModels, and with it the model approvals — it has already happened once. Gated by P4."
// THERE WAS NO P4. The read-modify-write was gated by nothing at all — the sentence naming the
// hazard was doing the work of the protection. An independent reviewer dropped the `...s` spread,
// confirmed the mutation applied, and EVERY gate in the repo stayed green (2026-07-16).
//
// The hazard is not theoretical: db/users.js's upsert is
// `ON CONFLICT DO UPDATE SET settings = excluded.settings` — a FULL BLOB REPLACEMENT. A bare
// write of {enrichProcessingPaused} therefore deletes taskModels, and taskModels IS the model
// consent record (§3.10c: "the approval IS the model setting"). So the failure mode is not a lost
// preference — it is a SILENTLY REVOKED CONSENT, and the vault stops labeling with no explanation.
// It has already happened once for real (portal-hardware.js:117).
//
// This drives the REAL route over a REAL SQLite vault (startRestServer, same pattern as
// verify-portal-data.mjs) and reads the blob back through the REAL db, because that is the only
// way to answer "did the write drop something" — a stub would only prove the stub.
//
//   P4  pause  → enrichProcessingPaused persisted AND every pre-existing settings key survives
//   P5  resume → the flag clears AND the other keys still survive
//   P6  the route reports a FAILED write (500) instead of lying that it paused
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { startEmbedSupervisor, getEmbedSupervisor, _resetEmbedSupervisor } from '../src/embed/supervisor.js';

const DB = 'data/verify-processing-pause.db';
const KCV = 'data/verify-processing-pause-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// The settings a real vault carries alongside the pause. `taskModels` is the one that matters —
// it is the model CONSENT record, not a preference — but the property is general: a pause must
// not disturb ANY other key, so the fixture carries neighbours too.
const SEED = {
  taskModels: { categorize: { model: 'qwen3.5:4b' }, enrich: { model: 'qwen3.5:4b' } },
  timezone: 'Europe/Riga',
  onboardingHandle: 'martin',
};

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const post = async (p) => {
    const r = await fetch(`${url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    let b = null; try { b = await r.json(); } catch { /* non-JSON */ }
    return { status: r.status, body: b };
  };

  try {
    // Get the id the ROUTE uses — by letting the route write it. A fresh vault has NO users row
    // (boot doesn't create one; updateSettings UPSERTs it), and startRestServer does not expose
    // userId. Guessing it wrong is silently catastrophic for a gate: updateSettings(undefined, …)
    // upserts a junk row and getSettings(undefined) returns {}, so every assertion below would
    // compare undefined to undefined and PASS. So: pause once to materialise the row, then read
    // the id back. P4a is the control that catches a mis-resolved id; it is not decoration.
    await post('/api/v1/portal/enrichment/processing/pause');
    const uid = (await db.users.getFirst())?.id;
    if (!uid) throw new Error('no users row even after the pause route wrote settings — fixture broken');

    // Now seed the neighbours OVER that row (this also clears the flag the probe just set), so
    // the pause under test runs against a realistic blob.
    await db.users.updateSettings(uid, { ...SEED });
    const seeded = await db.users.getSettings(uid);
    rec('P4a. fixture seeded (the control: taskModels + neighbours are present BEFORE the pause)',
      seeded?.taskModels?.categorize?.model === 'qwen3.5:4b' && seeded?.timezone === 'Europe/Riga',
      `taskModels=${JSON.stringify(seeded?.taskModels)} timezone=${seeded?.timezone}`);

    // ── P4: pause persists the flag WITHOUT dropping anything else ──
    const paused = await post('/api/v1/portal/enrichment/processing/pause');
    const after = await db.users.getSettings(uid);
    const flagOk = after?.enrichProcessingPaused === true;
    const consentSurvived = after?.taskModels?.categorize?.model === 'qwen3.5:4b'
      && after?.taskModels?.enrich?.model === 'qwen3.5:4b';
    const neighboursSurvived = after?.timezone === 'Europe/Riga' && after?.onboardingHandle === 'martin';
    rec('P4. pause → flag persisted AND taskModels (the model CONSENT) + every other key survive',
      paused.status === 200 && flagOk && consentSurvived && neighboursSurvived,
      `status=${paused.status} paused=${after?.enrichProcessingPaused} taskModels=${JSON.stringify(after?.taskModels)} timezone=${after?.timezone} handle=${after?.onboardingHandle}`);

    // ── P5: resume clears the flag, still without collateral ──
    const resumed = await post('/api/v1/portal/enrichment/processing/resume');
    const after2 = await db.users.getSettings(uid);
    rec('P5. resume → flag cleared AND taskModels + every other key still survive',
      resumed.status === 200 && after2?.enrichProcessingPaused === false
      && after2?.taskModels?.categorize?.model === 'qwen3.5:4b' && after2?.timezone === 'Europe/Riga',
      `status=${resumed.status} paused=${after2?.enrichProcessingPaused} taskModels=${JSON.stringify(after2?.taskModels)}`);

    // ── P6: a FAILED write must be REPORTED, not applied silently ──
    // The whole persist contract: a pause that cannot be remembered must not be claimed. If the
    // route 200s here, the vault reads paused now and silently resumes on the next restart —
    // D13's silent undo, wearing a success response.
    const realUpdate = db.users.updateSettings.bind(db.users);
    db.users.updateSettings = async () => { throw new Error('disk full'); };
    const failed = await post('/api/v1/portal/enrichment/processing/pause');
    db.users.updateSettings = realUpdate;
    const after3 = await db.users.getSettings(uid);
    rec('P6. a failed settings write → 500 (never a 200 claiming a pause it cannot remember)',
      failed.status === 500 && after3?.enrichProcessingPaused !== true,
      `status=${failed.status} body=${JSON.stringify(failed.body)} persistedFlag=${after3?.enrichProcessingPaused}`);

    // ── PER-STAGE PAUSE (QA R2-PIPECTL) — the split routes persist independently ──
    // Reset to a clean seed so the per-stage assertions start from "nothing paused".
    await db.users.updateSettings(uid, { ...SEED });

    // P7: embed/pause persists enrichEmbedPaused ONLY — categorize stays running, taskModels survive,
    // pausedAt is stamped, and the LEGACY composite stays false (not BOTH paused).
    const ep = await post('/api/v1/portal/enrichment/embed/pause');
    const s7 = await db.users.getSettings(uid);
    rec('P7. embed/pause → enrichEmbedPaused only (categorize untouched, taskModels survive, pausedAt set, composite false)',
      ep.status === 200 && s7?.enrichEmbedPaused === true && s7?.enrichCategorizePaused !== true
        && s7?.enrichProcessingPaused === false && typeof s7?.enrichProcessingPausedAt === 'string'
        && s7?.taskModels?.categorize?.model === 'qwen3.5:4b' && s7?.timezone === 'Europe/Riga',
      `status=${ep.status} embed=${s7?.enrichEmbedPaused} cat=${s7?.enrichCategorizePaused} composite=${s7?.enrichProcessingPaused} pausedAt=${s7?.enrichProcessingPausedAt} taskModels=${JSON.stringify(s7?.taskModels)}`);

    // P8: categorize/pause with embed already paused → BOTH paused ⇒ the legacy composite flips true,
    // and the ORIGINAL pausedAt is preserved (the earliest stamp, not re-stamped).
    const firstPausedAt = s7?.enrichProcessingPausedAt;
    const cp = await post('/api/v1/portal/enrichment/categorize/pause');
    const s8 = await db.users.getSettings(uid);
    rec('P8. categorize/pause (embed already paused) → both flags true, composite true, earliest pausedAt kept',
      cp.status === 200 && s8?.enrichEmbedPaused === true && s8?.enrichCategorizePaused === true
        && s8?.enrichProcessingPaused === true && s8?.enrichProcessingPausedAt === firstPausedAt,
      `status=${cp.status} embed=${s8?.enrichEmbedPaused} cat=${s8?.enrichCategorizePaused} composite=${s8?.enrichProcessingPaused} pausedAt=${s8?.enrichProcessingPausedAt} (was ${firstPausedAt})`);

    // P9: embed/resume with categorize still paused → embed clears, categorize stays, pausedAt still
    // set (any stage paused). Then categorize/resume → both clear, pausedAt null.
    const er = await post('/api/v1/portal/enrichment/embed/resume');
    const s9 = await db.users.getSettings(uid);
    const cr = await post('/api/v1/portal/enrichment/categorize/resume');
    const s9b = await db.users.getSettings(uid);
    rec('P9. embed/resume leaves categorize paused (pausedAt kept); categorize/resume → both clear, pausedAt null',
      er.status === 200 && s9?.enrichEmbedPaused === false && s9?.enrichCategorizePaused === true
        && typeof s9?.enrichProcessingPausedAt === 'string'
        && cr.status === 200 && s9b?.enrichEmbedPaused === false && s9b?.enrichCategorizePaused === false
        && s9b?.enrichProcessingPausedAt === null,
      `embedResume=${er.status} s9(embed=${s9?.enrichEmbedPaused},cat=${s9?.enrichCategorizePaused},at=${s9?.enrichProcessingPausedAt}) catResume=${cr.status} s9b(embed=${s9b?.enrichEmbedPaused},cat=${s9b?.enrichCategorizePaused},at=${s9b?.enrichProcessingPausedAt})`);

    // P10: a per-stage restart route succeeds (200, count-only body) and NEVER drops model consent —
    // it only re-queues gave-up rows (none in the fixture ⇒ 0). Both stages' restart routes exist.
    const reEmbed = await post('/api/v1/portal/enrichment/embed/restart');
    const reCat = await post('/api/v1/portal/enrichment/categorize/restart');
    const s10 = await db.users.getSettings(uid);
    rec('P10. per-stage restart routes → 200 count-only, model consent (taskModels) untouched',
      reEmbed.status === 200 && typeof reEmbed.body?.reset?.embed === 'number'
        && reCat.status === 200 && typeof reCat.body?.reset?.label === 'number'
        && s10?.taskModels?.categorize?.model === 'qwen3.5:4b',
      `embedRestart=${reEmbed.status}/${JSON.stringify(reEmbed.body)} catRestart=${reCat.status}/${JSON.stringify(reCat.body)} taskModels=${JSON.stringify(s10?.taskModels)}`);

    // P11: a FAILED per-stage persist → 500 (the D13 contract holds per stage, not just globally).
    db.users.updateSettings = async () => { throw new Error('disk full'); };
    const stageFailed = await post('/api/v1/portal/enrichment/embed/pause');
    db.users.updateSettings = realUpdate;
    const s11 = await db.users.getSettings(uid);
    rec('P11. a failed per-stage persist → 500 (never a silent per-stage pause)',
      stageFailed.status === 500 && s11?.enrichEmbedPaused !== true,
      `status=${stageFailed.status} body=${JSON.stringify(stageFailed.body)} embed=${s11?.enrichEmbedPaused}`);

    // ── P12: the embedder retry route (the fresh-install un-hang) is MOUNTED, session-gated (it
    // rides the same vaultAuth as every /api route), FAIL-SAFE, and HONEST. This boot injects keys,
    // so the embed supervisor is NOT started (getEmbedSupervisor() === null) — the route must still
    // 200 with the REAL current health rather than throwing on a null handle or claiming a retry
    // succeeded. That null-safe path is exactly the one a real box hits before/after a supervisor
    // lifecycle, so proving it here proves the route can never wedge on a missing supervisor.
    const retry = await post('/api/v1/portal/embed/retry');
    rec('P12. POST /portal/embed/retry → 200, fail-safe with NO supervisor, returns real health (never a fake success)',
      retry.status === 200 && retry.body?.ok === true && typeof retry.body?.health?.status === 'string',
      `status=${retry.status} body=${JSON.stringify(retry.body)}`);

    // ── P12b: the route ACTUALLY calls the supervisor's nudge() — the resume-out-of-a-halt edge ──
    // P12 proves fail-safe on a null supervisor; it does NOT prove the route reaches nudge(), so a
    // regression dropping `getEmbedSupervisor()?.nudge()` (leaving a halted governor un-resumable)
    // would stay GREEN. Start an in-process supervisor (the route reads the SAME module singleton),
    // spy its nudge(), hit the route, and assert the spy fired. The supervisor is driven with an
    // unreachable stub client + a non-existent interpreter so it never spawns a real :8091 process.
    _resetEmbedSupervisor();
    const sup = startEmbedSupervisor({ embed: { async health() { throw new Error('unreachable'); } }, pythonBin: '/usr/bin/false' });
    let nudged = 0;
    const realNudge = sup.nudge;
    sup.nudge = () => { nudged += 1; return realNudge(); };
    const routed = getEmbedSupervisor() === sup; // the route reads exactly this handle
    const retry2 = await post('/api/v1/portal/embed/retry');
    rec('P12b. the route CALLS getEmbedSupervisor().nudge() (resume-out-of-halt), not just returns health — MUTATION: drop the nudge() line ⇒ this REDS',
      routed && retry2.status === 200 && nudged >= 1,
      `routedToSameHandle=${routed} status=${retry2.status} nudged=${nudged}`);
    try { sup.stop(); } catch { /* */ }
    _resetEmbedSupervisor();
  } finally {
    try { await srv.close(); } catch { /* best-effort */ }
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  }

  const passed = ledger.filter(Boolean).length;
  const failed = ledger.length - passed;
  console.log('\n================================================================');
  console.log(failed === 0
    ? `VERDICT: GO — the pause persists without dropping model consent, and reports a failed write  EXIT=0`
    : `VERDICT: NO-GO — see FAIL rows  EXIT=1`);
  console.log('================================================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
