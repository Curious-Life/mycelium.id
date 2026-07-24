#!/usr/bin/env node
/**
 * verify:compute-lanes — the D-001 crash gate (QA7 U1). Design: docs/COMPUTE-GOVERNOR-DESIGN-2026-07-23.md §4.
 *
 * WHAT THIS PROVES: a second heavy lane is REFUSED while one holds admission — and it proves it
 * against the PRODUCT's real admission call sites (the real jobs.js spawners, the real drainer
 * cycle), not just the governor module's arithmetic. C1 alone (module arithmetic) is a fixture
 * assertion; C3/C4/C9 drive the actual spawners/drainer, which is the check that would have caught
 * #329's narrowness (it ordered two stages INSIDE ingest and the crash recurred twice anyway).
 *
 * A GREEN VERDICT HERE DOES NOT CLOSE D-001. The acceptance bar is the operator's machine surviving
 * import→embed→cluster→describe→chat with vm_stat swap-ins observed throughout (design §5/§6). This
 * gate proves the admission LOGIC; only the operator's box proves the crash is gone.
 */
// ── MANDATORY MUTATION RECORD (/gate-teeth) — each was RUN, RED on the named check, then restored ──
// MUTATION-TESTED: RESIDENT_MAX raised 1 → 2 in src/core/compute-governor.js → C1 and C9 RED
//   (the headline mutation of design §4 — if the suite stays green after this, the gate is
//   decorative and D-001 recurs a third time)
// MUTATION-TESTED: the admit() guard removed from startChronicleNarrationJob (src/jobs.js) so it
//   spawns unconditionally → C3 RED while C1 stays GREEN — the pair that proves C3 tests the
//   PRODUCT's admission and C1 only tests the module
// MUTATION-TESTED: the governor gate removed from the drainer's categorize block (src/enrich/
//   drainer.js) so it wakes Ollama while a resident ticket is held → C4 RED (daemon.ensureUp
//   called, status not waiting)
// MUTATION-TESTED: the child 'error' handler dropped from the ticket binding (bindChild,
//   src/core/compute-governor.js) → C5 RED (a crashed child never frees its slot)
// MUTATION-TESTED: memoryPressure() darwin branch reverted to os.freemem()/totalmem() < 0.05 ⇒
//   critical → C8 RED (a healthy 16 GB Mac reads freemem 0.03 and refuses every admission forever)
// MUTATION-TESTED: the aging-floor branch (agedBackgroundExists → refuse interactive) removed →
//   C7 RED (a chatty vault starves the background drain forever — the mirror of the crash, D-017)
// MUTATION-TESTED: a new ungoverned spawn( added to src/enrich/enricher.js with no allowlist
//   entry → C10 RED (the derived enumeration catches the rot pattern design §5 names)
// MUTATION-TESTED (review finding #1): an ALIASED ungoverned spawn — `const spawnImpl = spawn;
//   spawnImpl(process.execPath)` in src/enrich/enricher.js — added → C10 RED (the broadened
//   regex now catches aliased spawns the old `spawn(` regex missed; the exact green-for-the-
//   wrong-reason the reviewer proved)
// MUTATION-TESTED (review finding #2): the BULK admit removed from the drainer's embed loop
//   (src/enrich/drainer.js) so it drains while a resident model + WARN pressure → C11 RED
// MUTATION-TESTED (review finding #2): the BULK admit removed from transcribeAttachment
//   (src/enrich/transcribe-attachment.js) so it decodes under CRITICAL pressure → C12 RED
// MUTATION-TESTED (review finding #3): the childStillRunning re-arm removed from armLease
//   (src/core/compute-governor.js) so a live-child lease reclaims → C6b RED (the self-inflicted
//   double-admit the reviewer identified)
// MUTATION-TESTED: the swap-in escalation removed from memoryPressure() darwin branch → C8b RED
//   (a WARN box actively swapping is not escalated to CRITICAL)
// MUTATION-TESTED (round-2 review #2): the RESIDENT-path memory checks removed from admit()
//   (src/core/compute-governor.js) so a resident model admits under CRITICAL / WARN+BULK → C13 RED
//   (a ~13 GB vision model could stack on live BULK embed+whisper — the last narrow crash path)
// MUTATION-TESTED (round-2 review #1): the `compute-busy` exemption removed from the transcription
//   retry loop (src/enrich/transcribe-retry.js) so a capacity refusal counts as a decode failure
//   and caps → C14 RED (a busy voice note is abandoned instead of retried when capacity frees)
// MUTATION-TESTED (round-3 review): the drainResidentQueue() call removed from doRelease
//   (src/core/compute-governor.js) so a QUEUE-lane waiter never fires when the slot frees → C15
//   RED (a user-initiated Generate refused behind a background chronicle pass would silently never
//   run — the D-004 map-rebuild control breaks, verify:portal-mindscape S4)
// All restored; the suite returns GREEN on the restored tree.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import { EventEmitter } from 'node:events';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.env.MYCELIUM_TMP || '/tmp';

const results = [];
const rec = (id, pass, detail = '') => { results.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}${detail ? `\n      ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Wait for the drainer's in-flight/pending auto-cycles to drain (running=false), then run one FULL
// awaited cycle — deterministic despite the drainer's fire-and-forget boot cycle + pending re-runs.
async function settle(drainer) {
  for (let i = 0; i < 300; i++) { await sleep(3); if (!drainer.status().running) break; }
  await drainer.nudge();   // running is false ⇒ nudge() awaits the whole cycle body
}

// A fake ChildProcess: EventEmitter + stderr + pid — enough for the spawners' bindings. A no-op
// 'error' listener is attached so emit('error') does not hit Node's throw-on-unhandled default —
// that way C5 tests whether the GOVERNOR bound 'error' (a clean FAIL if it did not), rather than
// relying on an uncaught throw. Production children always carry their own 'error' handler too.
function fakeChild() { const c = new EventEmitter(); c.stderr = new EventEmitter(); c.pid = 4242; c.on('error', () => {}); return c; }

const gov = await import('../src/core/compute-governor.js');
const { admit, CLASS, governorStatus, isResidentBusy, queueForResident, _resetGovernor, _setMemProbe } = gov;
const { memoryPressure, PRESSURE, _resetSwapinBaseline } = await import('../src/core/memory-pressure.js');
const jobs = await import('../src/jobs.js');
const { startEnrichDrainer } = await import('../src/enrich/drainer.js');
const { transcribeAttachment } = await import('../src/enrich/transcribe-attachment.js');
const { startTranscribeRetry } = await import('../src/enrich/transcribe-retry.js');
const { setSessionKeys, clearSessionKeys } = await import('../src/account/session-keys.js');

const WARN_PROBE = () => ({ level: PRESSURE.WARN, signal: 'test-warn', detail: {} });
const CRIT_PROBE = () => ({ level: PRESSURE.CRITICAL, signal: 'test-crit', detail: {} });

const OK_PROBE = () => ({ level: PRESSURE.OK, signal: 'test', detail: {} });
// A dbPath in a real directory so assertVaultDiskHeadroom passes; the spawn is stubbed so no file is touched.
const TMP_DB = join(SCRATCH, 'compute-lanes-gate.db');

// ── C1 — the core claim: RESIDENT is a count gate at 1 ────────────────────────────────────────
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const held = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT });
  const second = admit({ lane: 'embed-drain-categorize', klass: CLASS.RESIDENT });
  const refusedWhileHeld = held.ok && !second.ok && second.state === 'waiting';
  held.release();
  const nowFree = admit({ lane: 'embed-drain-categorize', klass: CLASS.RESIDENT });
  const admitsAfterRelease = nowFree.ok;
  if (nowFree.ok) nowFree.release();
  rec('C1  RESIDENT count gate = 1: a second resident lane is refused while one is held, admitted after release',
    refusedWhileHeld && admitsAfterRelease,
    refusedWhileHeld && admitsAfterRelease ? '' : `refusedWhileHeld=${refusedWhileHeld} admitsAfterRelease=${admitsAfterRelease}`);
}

// ── C2 — refusal is honest: carries reason + retryAfterMs, does not throw, does not block ──────
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const held = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT });
  let threw = false, r;
  const t0 = Date.now();
  try { r = admit({ lane: 'clustering', klass: CLASS.RESIDENT }); } catch { threw = true; }
  const elapsed = Date.now() - t0;
  held.release();
  const honest = !threw && r && r.ok === false && typeof r.reason === 'string' && r.reason.length > 0
    && Number.isFinite(r.retryAfterMs) && r.state === 'waiting' && elapsed < 50;
  rec('C2  refusal is honest — { reason, retryAfterMs, state:"waiting" }, no throw, non-blocking',
    honest, honest ? '' : `threw=${threw} r=${JSON.stringify(r)} elapsed=${elapsed}ms`);
}

// ── C3 — REAL call sites, not the module: the actual spawners refuse to spawn while a ticket held ─
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  setSessionKeys({ userHex: 'a'.repeat(64), systemHex: 'b'.repeat(64) });
  let spawnCount = 0;
  jobs._setSpawnForTests(() => { spawnCount++; return fakeChild(); });

  const held = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT });
  const chron = jobs.startChronicleNarrationJob({ dbPath: TMP_DB, userId: 'u' });
  const naming = jobs.startClusterNamingJob({ dbPath: TMP_DB, userId: 'u' });
  const noSpawnWhileHeld = spawnCount === 0 && chron.pid == null && chron.status === 'busy' && naming.pid == null && naming.status === 'busy';
  held.release();

  // And they DO spawn once the slot is free — proves the gate above was the reason, not a dead path.
  const chron2 = jobs.startChronicleNarrationJob({ dbPath: TMP_DB, userId: 'u' });
  const spawnedWhenFree = spawnCount >= 1 && chron2.pid != null;

  jobs._setSpawnForTests(null); clearSessionKeys(); _resetGovernor();
  rec('C3  real spawners (startChronicleNarrationJob + startClusterNamingJob) spawn NO child while a resident ticket is held',
    noSpawnWhileHeld && spawnedWhenFree,
    noSpawnWhileHeld && spawnedWhenFree ? '' : `noSpawnWhileHeld=${noSpawnWhileHeld} spawnedWhenFree=${spawnedWhenFree} spawnCount=${spawnCount} chron=${JSON.stringify(chron)} naming=${JSON.stringify(naming)}`);
}

// ── C4 — the drainer honors it: one cycle with a resident ticket held makes ZERO Ollama calls ──
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  let ensureUpCount = 0;
  const daemon = { ensureUp: async () => { ensureUpCount++; }, getBaseUrl: () => 'http://127.0.0.1:11434' };
  const noRows = async () => [];
  const db = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'test-label' }, enrich: { model: 'test-enrich' } } }) },
    messages: {
      selectPendingEnrichment: noRows, updateEnrichment: async () => {}, selectPendingNlp: noRows, updateNlp: async () => {},
      // A pending categorize row EXISTS ⇒ IF the block runs it wakes Ollama (daemon.ensureUp). So a
      // held ticket that keeps ensureUpCount at 0 proves the block was refused — and removing the
      // governor gate (the mutation) would let it wake Ollama here, reddening this check.
      selectPendingCategories: async () => [{ id: 1 }],
      embedBacklog: async () => ({ embedded: 0 }),
    },
  };
  const embed = { health: async () => ({ status: 'error' }), embed: async () => ({ vector: [] }) };   // embed unhealthy → embed loop skipped, waitOnEmbed=false → categorize block is REACHED
  const ollama = { listInstalled: async () => ['test-label', 'test-enrich'], pullModel: async () => {} };   // model "already installed" → ensureLabelModel returns fast, no network

  const held = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT }); // a describe child holds the slot
  const drainer = startEnrichDrainer({ db, userId: 'u', intervalMs: 3600000, embed, daemon, ollama, log: () => {} });
  await settle(drainer);                        // a full cycle while the ticket is held
  const st = drainer.status();
  const refusedNoOllama = ensureUpCount === 0 && st.categorizeWaitingOnCompute === true;

  held.release();
  await settle(drainer);                        // slot free → the block runs → Ollama is woken
  const ranWhenFree = ensureUpCount >= 1 && drainer.status().categorizeWaitingOnCompute === false;
  drainer.stop(); _resetGovernor();
  rec('C4  drainer cycle makes ZERO Ollama calls while a resident ticket is held, and status reports categorizeWaitingOnCompute',
    refusedNoOllama && ranWhenFree,
    refusedNoOllama && ranWhenFree ? '' : `ensureUpCount(held)->${ensureUpCount} waitingOnCompute=${st.categorizeWaitingOnCompute} ranWhenFree=${ranWhenFree}`);
}

// ── C5 — crash releases: child 'error' (no 'close') frees the ticket; a later 'close' is idempotent ─
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const child = fakeChild();
  const a = admit({ lane: 'clustering', klass: CLASS.RESIDENT });
  a.bindChild(child);
  child.emit('error', new Error('spawn failed'));   // mechanism #2, error arm — NO close follows
  const freedByError = !isResidentBusy();
  const b = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT });   // slot must be free
  const reAdmits = b.ok;
  child.emit('close', 1);                            // late close — must NOT free b (idempotent)
  const idempotent = isResidentBusy() && b.ok;
  if (b.ok) b.release();
  _resetGovernor();
  rec('C5  crash release — child "error" frees the slot with no "close"; a late "close" is idempotent (does not free a different ticket)',
    freedByError && reAdmits && idempotent,
    `freedByError=${freedByError} reAdmits=${reAdmits} idempotent=${idempotent}`);
}

// ── C6 — lease reclaim: a leaked ticket past its lease is reclaimed AND recorded ───────────────
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT, timeoutMs: 50 });   // never released, never heartbeats
  await sleep(140);
  const st = governorStatus();
  const reclaimed = st.counters.reclaimed >= 1 && !isResidentBusy();
  _resetGovernor();
  rec('C6  lease reclaim — a ticket that neither releases nor heartbeats past its lease is reclaimed and recorded (counters.reclaimed)',
    reclaimed, reclaimed ? '' : `reclaimed=${st.counters.reclaimed} residentBusy=${isResidentBusy()}`);
}

// ── C7 — no starvation: an aged background lane is admitted despite interactive contention ─────
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const chat = admit({ lane: 'portal-chat', klass: CLASS.INTERACTIVE });   // interactive holds the slot
  let allRefused = true;
  for (let i = 0; i < 20; i++) { const bg = admit({ lane: 'embed-drain-categorize', klass: CLASS.RESIDENT }); if (bg.ok) { allRefused = false; bg.release(); } }
  chat.release();
  const chat2 = admit({ lane: 'portal-chat', klass: CLASS.INTERACTIVE });   // aged bg now has priority
  const chat2Refused = !chat2.ok && chat2.reason === 'aged-background-priority';
  if (chat2.ok) chat2.release();
  const bg2 = admit({ lane: 'embed-drain-categorize', klass: CLASS.RESIDENT });
  const bgFinallyWon = bg2.ok;
  if (bg2.ok) bg2.release();
  _resetGovernor();
  rec('C7  aging floor — a background lane refused 20× is promoted over interactive for one ticket (no drain starvation, D-017)',
    allRefused && chat2Refused && bgFinallyWon,
    `allRefused=${allRefused} chat2Refused=${chat2Refused} bgFinallyWon=${bgFinallyWon}`);
}

// ── C8 — the pressure probe is NOT os.freemem() on darwin (the §3.6 trap, encoded) ────────────
{
  const healthy = memoryPressure({
    platform: 'darwin',
    run: (cmd) => (cmd === 'sysctl' ? '56\n' : 'Swapins: 0\n'),
    osMod: { freemem: () => 0.03 * 16e9, totalmem: () => 16e9, platform: () => 'darwin' },
  });
  const critical = memoryPressure({ platform: 'darwin', run: (cmd) => (cmd === 'sysctl' ? '5\n' : 'Swapins: 9999\n') });
  const failOpen = memoryPressure({ platform: 'darwin', run: () => { throw new Error('sysctl missing'); } });
  const ok = healthy.level === PRESSURE.OK && critical.level === PRESSURE.CRITICAL && failOpen.level === PRESSURE.OK;
  rec('C8  memoryPressure() is the kern.memorystatus_level probe, NOT os.freemem(): darwin healthy at freemem/total=0.03, fail-open on probe error',
    ok, ok ? '' : `healthy=${healthy.level} critical=${critical.level} failOpen=${failOpen.level}`);

  // C8b — swap-in ESCALATION (design §3.6: swap-in rate is the beachball fingerprint). A marginal
  // (WARN, level 20) box that is ACTIVELY swapping (rising Swapins delta) escalates to CRITICAL;
  // a single reading with no rising delta does not.
  _resetSwapinBaseline();
  const warnLevel = (swap) => ({ platform: 'darwin', run: (cmd) => (cmd === 'sysctl' ? '20\n' : `Swapins: ${swap}\n`) });
  const first = memoryPressure(warnLevel(1000));                 // first sample: no prior → no delta → WARN
  const rising = memoryPressure(warnLevel(9000));                // Swapins rose 8000 → actively swapping → CRITICAL
  _resetSwapinBaseline();
  const flat0 = memoryPressure(warnLevel(5000));                 // fresh baseline
  const flat1 = memoryPressure(warnLevel(5000));                 // no rise → stays WARN
  const escOk = first.level === PRESSURE.WARN && rising.level === PRESSURE.CRITICAL && flat1.level === PRESSURE.WARN;
  rec('C8b swap-in escalation — a WARN box with a RISING swap-in delta escalates to CRITICAL; a flat swap-in count stays WARN',
    escOk, escOk ? '' : `first=${first.level} rising=${rising.level} flat=${flat1.level}`);
  _resetSwapinBaseline();
}

// ── C9 — P3 specifically: describe-clusters refused while a clustering job holds its ticket ────
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  setSessionKeys({ userHex: 'a'.repeat(64), systemHex: 'b'.repeat(64) });
  let spawnCount = 0;
  jobs._setSpawnForTests(() => { spawnCount++; return fakeChild(); });

  const clustering = admit({ lane: 'clustering', klass: CLASS.RESIDENT });   // a Generate is clustering (loads the naming model in step 3)
  const naming = jobs.startClusterNamingJob({ dbPath: TMP_DB, userId: 'u' });
  const refusedDuringClustering = naming.pid == null && naming.status === 'busy' && spawnCount === 0;
  clustering.release();
  const naming2 = jobs.startClusterNamingJob({ dbPath: TMP_DB, userId: 'u' });
  const runsWhenClusteringDone = naming2.pid != null && spawnCount === 1;

  jobs._setSpawnForTests(null); clearSessionKeys(); _resetGovernor();
  rec('C9  P3 — a standalone describe-clusters is refused while a clustering job holds the model slot (two describe-clusters at once is closed)',
    refusedDuringClustering && runsWhenClusteringDone,
    `refusedDuringClustering=${refusedDuringClustering} runsWhenClusteringDone=${runsWhenClusteringDone} spawnCount=${spawnCount} naming=${JSON.stringify(naming)}`);
}

// ── C10 — derived enumeration (design §5): no ungoverned heavy-lane spawn/localInfer escapes ──
{
  const allowlist = JSON.parse(readFileSync(join(ROOT, 'scripts/compute-lanes-allowlist.json'), 'utf8')).allow || {};
  const SRC = join(ROOT, 'src');
  const files = [];
  (function walk(d) { for (const e of readdirSync(d)) { const p = join(d, e); const s = statSync(p); if (s.isDirectory()) walk(p); else if (/\.js$/.test(p)) files.push(p); } })(SRC);

  // Match ALL spawn call shapes — including ALIASED ones (review finding #1): the naive
  // `spawn(` regex missed `spawnImpl(` / `spawnServe(` (the embed/transcribe/tts supervisors
  // destructure `spawn: spawnImpl = spawn` then call `spawnImpl(...)`), so three heavy-lane
  // spawners were invisible to the anti-rot gate — the exact M-001 pattern this file cites.
  //   • `_?spawn[A-Za-z]*(` catches spawn(, _spawn(, spawnImpl(, spawnServe(, spawnSync(
  //   • the ALIAS regex catches the *definition* `= spawn` / `= nodeSpawn` (i.e. `const x = spawn;`
  //     then a later `x(...)` whose name carries no "spawn") so an alias cannot launder a spawn.
  const CALL = /(?<![A-Za-z.])(?:_?spawn[A-Za-z]*|localInfer|localStream)\(/;
  const ALIAS = /(?<![A-Za-z.])=\s*(?:spawn|nodeSpawn)\b(?!\s*\()/;   // `= spawn` / `= nodeSpawn` as an alias, not an immediate call
  const EXEMPT_FILES = new Set([join(SRC, 'core/compute-governor.js'), join(SRC, 'inference/local.js')]);

  const stripComments = (line) => line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
  const violations = [];
  for (const f of files) {
    if (EXEMPT_FILES.has(f)) continue;
    const body = readFileSync(f, 'utf8');
    const rel = relative(ROOT, f);
    // Governed = the file imports the governor AND calls admit(). A governed file's spawn/localInfer
    // sites are inside the admission-aware module (C3/C4 prove the specific hot spawners deeply).
    const governed = /compute-governor\.js/.test(body) && /\badmit\s*\(/.test(body);
    const allowed = Object.prototype.hasOwnProperty.call(allowlist, rel) && String(allowlist[rel] || '').trim().length >= 20;
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const code = stripComments(lines[i]);
      if (!CALL.test(code) && !ALIAS.test(code)) continue;
      if (governed || allowed) continue;
      violations.push(`${rel}:${i + 1}  ${lines[i].trim().slice(0, 90)}`);
    }
  }
  // Allowlist hygiene: every allow entry must resolve to a real file that actually contains a call
  // site (a stale entry is a hole that reads as coverage — the verify:chains lesson).
  const stale = [];
  for (const rel of Object.keys(allowlist)) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) { stale.push(`${rel} (no such file)`); continue; }
    const b = readFileSync(abs, 'utf8');
    if (!b.split('\n').some((l) => CALL.test(stripComments(l)) || ALIAS.test(stripComments(l)))) stale.push(`${rel} (no spawn/localInfer/localStream call — drop it)`);
  }

  const clean = violations.length === 0 && stale.length === 0;
  rec('C10 derived enumeration — every spawn()/localInfer()/localStream() in src/ is governed or allowlisted-with-reason; allowlist has no stale entries',
    clean,
    clean ? `${files.length} files scanned · ${Object.keys(allowlist).length} residual lanes allowlisted`
      : `${violations.length} ungoverned site(s):\n      ${violations.join('\n      ')}${stale.length ? `\n      STALE allowlist:\n      ${stale.join('\n      ')}` : ''}`);
}

// ── C6b — lease must NOT reclaim a lane whose bound child is STILL ALIVE (review finding #3) ──
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const live = fakeChild(); live.exitCode = null; live.signalCode = null;   // still running
  const a = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT, timeoutMs: 40 });
  a.bindChild(live);
  await sleep(140);                                     // well past the lease
  const notReclaimedWhileAlive = isResidentBusy() && governorStatus().counters.reclaimed === 0;
  // Now the child exits — the child-binding releases it (the real mechanism), slot frees.
  live.exitCode = 0; live.emit('close', 0);
  const freedOnExit = !isResidentBusy();
  _resetGovernor();
  rec('C6b lease does NOT reclaim a lane whose bound child is still running (no self-inflicted double-admit); the child-exit frees it',
    notReclaimedWhileAlive && freedOnExit,
    `notReclaimedWhileAlive=${notReclaimedWhileAlive} freedOnExit=${freedOnExit}`);
}

// ── C11 — the ONNX embed drain takes a BULK ticket and DEFERS under WARN pressure + a resident (finding #2) ──
{
  _resetGovernor(); _setMemProbe(WARN_PROBE);
  const noRows = async () => [];
  const db = {
    users: { getSettings: async () => ({ taskModels: {} }) },
    messages: { selectPendingEnrichment: noRows, updateEnrichment: async () => {}, selectPendingNlp: noRows, updateNlp: async () => {}, selectPendingCategories: noRows, embedBacklog: async () => ({ embedded: 0 }) },
  };
  let embedCalls = 0;
  const embed = { health: async () => ({ status: 'ok', loaded: true, dim: 768 }), embed: async () => { embedCalls++; return { vector: [] }; } };
  const held = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT }); // a resident model is loaded
  const drainer = startEnrichDrainer({ db, userId: 'u', intervalMs: 3600000, embed, log: () => {} });
  await settle(drainer);
  const deferred = drainer.status().embedWaitingOnCompute === true && embedCalls === 0;
  held.release();
  _setMemProbe(OK_PROBE);
  await settle(drainer);
  const ranWhenClear = drainer.status().embedWaitingOnCompute === false;
  drainer.stop(); _resetGovernor();
  rec('C11 the ONNX embed drain admits a BULK ticket and DEFERS (embedWaitingOnCompute, zero embed calls) under WARN pressure while a resident model is loaded',
    deferred && ranWhenClear,
    `deferred=${deferred} embedCalls(held)=${embedCalls} ranWhenClear=${ranWhenClear}`);
}

// ── C12 — whisper transcription admits a BULK ticket and is REFUSED under CRITICAL pressure (finding #2) ──
{
  _resetGovernor(); _setMemProbe(CRIT_PROBE);
  const db = { attachments: { getById: async () => ({ id: 'a1', user_id: 'u', file_type: 'audio/ogg', local_path: '/nonexistent.ogg' }) } };
  const r = await transcribeAttachment(db, 'u', 'a1', { getHealth: () => ({ status: 'ok', model: 'whisper-base' }) });
  const refused = r && r.ok === false && r.reason === 'compute-busy' && r.retryable === true;
  _resetGovernor();
  rec('C12 whisper transcribeAttachment admits a BULK ticket and returns retryable `compute-busy` under CRITICAL memory pressure (never a 2nd concurrent heavy model)',
    refused, refused ? '' : `result=${JSON.stringify(r)}`);
}

// ── C13 — the RESIDENT path respects memory pressure (round-2 finding #2, the last crash path) ──
{
  _resetGovernor();
  // CRITICAL → a resident model is refused even with the slot free.
  _setMemProbe(CRIT_PROBE);
  const crit = admit({ lane: 'vision-caption', klass: CLASS.RESIDENT });
  const refusedCritical = !crit.ok && /memory-pressure/.test(crit.reason);
  // WARN + a live BULK lane → refused (a big model must not stack on live embed/whisper).
  _resetGovernor(); _setMemProbe(WARN_PROBE);
  const bulk = admit({ lane: 'embed-drain', klass: CLASS.BULK, estimateGb: 1 });
  const resWarnBulk = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT });
  const refusedWarnBulk = bulk.ok && !resWarnBulk.ok && /memory-pressure-with-bulk/.test(resWarnBulk.reason);
  // Control: OK pressure admits a resident even with a live BULK lane.
  _setMemProbe(OK_PROBE);
  const resOk = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT });
  const admitsWhenOk = resOk.ok;
  _resetGovernor();
  rec('C13 the RESIDENT path respects memory pressure — a resident model is refused under CRITICAL, and under WARN while a BULK lane is live (no oversized model stacking on live embed/whisper)',
    refusedCritical && refusedWarnBulk && admitsWhenOk,
    `refusedCritical=${refusedCritical} refusedWarnBulk=${refusedWarnBulk} admitsWhenOk=${admitsWhenOk}`);
}

// ── C14 — a `compute-busy` transcription is eventually RETRIED, never silently dropped (finding #1) ──
{
  _resetGovernor();
  let phase = 'busy';
  const transcribed = new Set();
  const transcribe = async (id) => { if (phase === 'busy') return { ok: false, reason: 'compute-busy' }; transcribed.add(id); return { ok: true, transcript: 't' }; };
  const db = { attachments: { listPendingTranscription: async () => (transcribed.has('a1') ? [] : ['a1']) } };
  const loop = startTranscribeRetry({ db, userId: 'u', intervalMs: 3600000, transcribe, getHealth: () => ({ status: 'ok' }), log: () => {} });
  // Many busy cycles (more than the attempt cap): a capacity refusal must NOT count as a decode
  // failure, so the note stays retriable and is NOT capped.
  for (let i = 0; i < 6; i++) await settle(loop);
  const stillPendingNotCapped = !transcribed.has('a1') && loop.status().capped === 0;
  // Capacity frees → the drain picks it up on its own.
  phase = 'ok';
  await settle(loop);
  const eventuallyTranscribed = transcribed.has('a1');
  loop.stop(); _resetGovernor();
  rec('C14 a transcription refused `compute-busy` is left retriable (not capped) and is eventually transcribed by the background drain once capacity frees (no silent under-transcription)',
    stillPendingNotCapped && eventuallyTranscribed,
    `stillPendingNotCapped=${stillPendingNotCapped} eventuallyTranscribed=${eventuallyTranscribed} capped=${loop.status().capped}`);
}

// ── C15 — a QUEUE lane (clustering/Generate) refused behind a holder RUNS when the slot frees ──
// The D-004 map-rebuild control (verify:portal-mindscape S4): a user-initiated Generate refused
// while a background chronicle pass holds the model slot must NOT be silently dropped — it queues
// and launches when the slot frees.
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const held = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT }); // a background pass holds the slot
  let ran = false; let launched = null;
  const q = queueForResident('clustering', () => { const a = admit({ lane: 'clustering', klass: CLASS.RESIDENT }); if (a.ok) { ran = true; launched = a; } });
  const queuedNotRun = q.queued === true && ran === false;   // slot held → the waiter waits, not dropped
  // A 2nd Generate coalesces onto the queued one (no duplicate work).
  const q2 = queueForResident('clustering', () => { ran = 'DUPLICATE'; });
  const coalesced = q2.coalesced === true;
  held.release();                                            // slot frees → the queued Generate launches
  const ranWhenFree = ran === true;
  if (launched) launched.release();
  _resetGovernor();
  rec('C15 a QUEUE lane refused behind a holder is enqueued (coalesced, not dropped) and LAUNCHES when the slot frees — the D-004 rebuild control completes (portal-mindscape S4)',
    queuedNotRun && coalesced && ranWhenFree,
    `queuedNotRun=${queuedNotRun} coalesced=${coalesced} ranWhenFree=${ranWhenFree}`);
}

const passed = results.filter((r) => r.pass).length;
console.log('\n' + '='.repeat(72));
console.log(`${passed}/${results.length} checks passed`);
const allPass = results.every((r) => r.pass);
console.log(`VERDICT: ${allPass
  ? 'GO — a second heavy lane is refused while one holds admission, proven at the real spawners + drainer.\n         NOT PROVEN: that the operator\'s machine survives import→embed→cluster→describe→chat (design §5/§6 —\n         only their box, with vm_stat swap-ins observed, closes D-001). This gate proves the LOGIC, not the crash.'
  : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
