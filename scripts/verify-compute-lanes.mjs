#!/usr/bin/env node
/**
 * verify:compute-lanes — the D-001 crash gate (QA7 U1). Design: the compute-governor design §4.
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
// ── QA9 additions (D-047 ↻1 + the chat-priority defect) ───────────────────────────────────────
// Every record below was RE-RUN on the FINAL tree, after two independent adversarial reviews
// changed both the code and several assertions. An earlier set of records was accurate for an
// earlier draft and is deliberately not carried forward — /gate-teeth: "never trust an existing
// comment that claims a mutation."
//
// ORDERING INVARIANT (D-047 ↻1)
// MUTATION-TESTED: `AND embedding_768 IS NOT NULL` removed from selectPendingCategories
//   (src/db/messages.js) → C16, C16b, C17 RED. C17's failure line is the operator's own defect,
//   reproduced verbatim: `embedded=10 tagged=40`.
// MUTATION-TESTED: `_computeCategoriesBacklog`'s `pending` left WITHOUT that clause so the count
//   and the drain predicate disagree → C16b RED (`pending=4 selected=2`) — a pending that counts
//   rows the drain will never select can never reach 0, the stuck-forever bug messages.js warns of.
// MUTATION-TESTED: `blockedOnEmbed` forced to 0 in _computeCategoriesBacklog → C16b RED
//   (`blockedOnEmbed=0 sum=4` vs total 5) — a mid-import vault would report `pending: 0` with
//   thousands untagged, i.e. the categorize stage renders `done` over work that has not started.
// MUTATION-TESTED: the blank-skip exclusion `AND NOT (nlp_processed = 1 AND embedding_768 IS NULL)`
//   removed from _computeCategoriesBacklog → C16b RED (`total=6 sum=5`) — the blank row re-enters
//   `total` while staying unselectable, a progress bar that can never reach its own total.
// MUTATION-TESTED: the categorize reset (`categories_processed = 0`, …) removed from updateContent
//   (src/db/messages.js) → C17b RED (`after(tagged=1,embedded=0)`) — a content re-sync manufactures
//   `tagged > embedded` in the DAL with no scheduler involved, and the drain-query invariant cannot
//   see it because the row is already tagged.
// MUTATION-TESTED: the enrichment strip removed from restoreTable's `messages` branch
//   (src/ingest/vault-import.js) → C17c RED (`nlp_processed=2 categories_processed=1
//   embedding_768=null` ⇒ `tagged=1 embedded=0`) — the third restore path, which passes NO
//   overrides, lands tagged-but-unembedded rows that also never re-embed.
//
// CHAT PRIORITY
// MUTATION-TESTED: admitTranscribe forced to always-BULK (`return bulk()` first line,
//   src/enrich/transcribe-attachment.js) → C18 RED (`preempted=false takesTheOneSlot=false`),
//   C18b RED (`askedToYield=false ranGoverned=false`), C19 RED and C20b RED — the reported defect
//   restored end to end.
// MUTATION-TESTED: admitTranscribe forced to always-INTERACTIVE (`if (false) return bulk()`) →
//   C18 RED on its SECOND arm specifically (`importIsBulk=false`): an IMPORT transcription preempts
//   a background describe pass, the D-001 thrash the live-vs-import distinction exists to prevent.
//   The two mutations are MIRROR IMAGES, which is what proves C18 tests the DISTINCTION rather than
//   merely "interactive exists".
// MUTATION-TESTED: the `abandonPreempt(...)` call removed from admitTranscribe's give-up path →
//   C18 RED (`preemptWithdrawn=false`) — the holder still aborts its cycle for a requester that has
//   already fallen back to BULK.
// MUTATION-TESTED: the `interactive: true` admit replaced by a fake always-ok handle in the
//   /internal/attachment-context audio branch (src/internal-router.js) → C18b RED
//   (`askedToYield=false ranGoverned=false lane=null residentHeld=0`) — the live voice-note decode
//   runs ungoverned beside a held resident model.
// MUTATION-TESTED: `signal` + `onProgress` removed from that same call → C20a RED
//   (`sawSignal=false sawHeartbeat=false`) — the decode becomes unbounded, and then NO lease is
//   safe (this is the load-bearing half: C20b's arithmetic is only meaningful with the bound).
// MUTATION-TESTED: INTERACTIVE_LEASE_MS set below the worst-case hold (60_000) → C20b RED
//   (`leaseCoversHold=false`) — the lease would reclaim under a live decode and the drainer would
//   load a SECOND resident model beside it.
// MUTATION-TESTED: RESIDENT_MAX raised 1 → 2 → C19 RED (`held=0 bgRefused=false`) plus C1, C2, C3,
//   C4, C5, C7, C9, C6b, C15, C18, C18b, C20b — the headline mutation, now red across the suite.
// All restored; the suite returns GREEN (27/27) on the restored tree.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative } from 'node:path';
import { EventEmitter } from 'node:events';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = process.env.MYCELIUM_TMP || '/tmp';
// Shrink ONLY the preempt WAIT BUDGET so C18/C18b do not each sleep the production 45 s. What the
// checks assert — the classes, the preempt, the BULK fallback, the withdrawal — is untouched. Set
// before the module is imported, because it reads the env once at load.
// ⚠️ KEEP THIS NAME IN SYNC with transcribe-attachment.js. It was `MYCELIUM_TRANSCRIBE_PREEMPT_MS`
// against an earlier draft; when the constant was renamed the override silently stopped applying and
// the suite ran 90 s of real sleeps — a stale test override is the quiet kind of rot.
process.env.MYCELIUM_TRANSCRIBE_PREEMPT_BUDGET_MS = process.env.MYCELIUM_TRANSCRIBE_PREEMPT_BUDGET_MS || '30';
process.env.MYCELIUM_GOV_YIELD_MS = process.env.MYCELIUM_GOV_YIELD_MS || '5';
// C17 drives the REAL enrichment service, which fails CLOSED without a master key ("refusing to
// write"). A throwaway gate key so the drain actually writes; the fixture vault is :memory: and
// its namespace has no crypto adapter, so nothing here is a real secret.
process.env.ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY || 'c'.repeat(64);

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
const { default: Database } = await import('better-sqlite3');
const { applyMigrations } = await import('../src/db/migrate.js');
const { createMessagesNamespace } = await import('../src/db/messages.js');
const { admitTranscribe } = await import('../src/enrich/transcribe-attachment.js');
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

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  QA9 — D-047 ↻1: EMBED BEFORE CATEGORIZE IS A STRUCTURAL INVARIANT, NOT A SCHEDULE
// ══════════════════════════════════════════════════════════════════════════════════════════════
// #329 shipped the ordering as a per-cycle heuristic in the drainer (deferCategorizeForEmbed) and
// it did not hold: EVERY way embedding can fail to move — unhealthy service, a throw, a governor
// refusal, a no-progress break — RELEASES categorize over the whole corpus (the anti-deadlock
// valve). On the operator's shipped-v0.1.13 5.5K import, drainOnce's outage signature tripped the
// no-progress break at 445 embedded and Qwen then tagged 772. C16/C17 pin the invariant where it
// is now enforced: in the DRAIN QUERY, as set inclusion.
function freshVault() {
  const raw = new Database(':memory:');
  applyMigrations(raw);
  const d1Query = async (sql, params = []) => {
    const stmt = raw.prepare(sql);
    if (/^\s*(insert|update|delete)/i.test(sql) && !/returning/i.test(sql)) {
      const info = stmt.run(...params);
      return { results: [], meta: { changes: info.changes } };
    }
    return { results: stmt.all(...params) };
  };
  const d1Batch = async (stmts) => { for (const s of stmts) await d1Query(s.sql, s.params); return []; };
  const messages = createMessagesNamespace({ d1Query, d1Batch, firstRow: (r) => (r?.results || [])[0] || null });
  return { raw, db: { rawQuery: d1Query, messages }, messages };
}
const GU = 'gate-user';
let gseq = 0;
function addMsg(raw, { content, nlp = 0, vec = null, cats = 0 }) {
  const id = `g${++gseq}`;
  raw.prepare(
    `INSERT INTO messages (id, user_id, role, content, nlp_processed, embedding_768, categories_processed, created_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?)`,
  ).run(id, GU, content, nlp, vec, cats, `2026-07-26T00:${String(Math.floor(gseq / 60)).padStart(2, '0')}:${String(gseq % 60).padStart(2, '0')}.000Z`);
  return id;
}
const counts = (raw) => raw.prepare(
  `SELECT COALESCE(SUM(CASE WHEN embedding_768 IS NOT NULL THEN 1 ELSE 0 END), 0) AS embedded,
          COALESCE(SUM(CASE WHEN categories_processed = 1 THEN 1 ELSE 0 END), 0) AS tagged
     FROM messages WHERE user_id = ?`,
).get(GU);

// ── C16 — the drain query CANNOT hand back an un-embedded row ─────────────────────────────────
{
  const { raw, messages } = freshVault();
  const embedded = addMsg(raw, { content: 'this one has a vector', nlp: 2, vec: Buffer.alloc(4) });
  addMsg(raw, { content: 'this one is still waiting to embed', nlp: 0, vec: null });
  addMsg(raw, { content: 'this one was blank-skipped and will never embed', nlp: 1, vec: null });
  const rows = await messages.selectPendingCategories(GU, { limit: 100 });
  const onlyEmbedded = rows.length === 1 && rows[0].id === embedded;
  rec('C16 stage ordering is STRUCTURAL — selectPendingCategories returns ONLY rows that already have an embedding (tagged ⊆ embedded by construction, D-047 ↻1)',
    onlyEmbedded, onlyEmbedded ? '' : `returned ${rows.length} row(s): ${JSON.stringify(rows.map((r) => r.id))} (expected exactly [${embedded}])`);
}

// ── C16b — the COUNT mirrors the DRAIN PREDICATE, and the held-back rows are still reported ────
// messages.js's own warning: a `pending` that counts rows the drain will never select can never
// reach 0. And a `pending` that silently drops them makes a mid-import vault read as "done".
{
  const { raw, messages } = freshVault();
  addMsg(raw, { content: 'embedded, untagged — drainable now', nlp: 2, vec: Buffer.alloc(4) });
  addMsg(raw, { content: 'embedded, untagged — drainable now too', nlp: 2, vec: Buffer.alloc(4) });
  addMsg(raw, { content: 'no vector, still queued for embedding', nlp: 0, vec: null });
  addMsg(raw, { content: 'no vector, embed stage TERMINAL (attempt-capped)', nlp: -1, vec: null });
  addMsg(raw, { content: 'already tagged', nlp: 2, vec: Buffer.alloc(4), cats: 1 });
  // A whitespace-only row: passes `content != ''`, blank-skipped by the embed stage to
  // nlp_processed = 1 with no vector, and therefore never selectable for labeling. It must be
  // excluded from total/tagged/pending CONSISTENTLY (the TRIM clause) or the progress bar can
  // never reach its own total — so it must move NONE of the buckets below.
  addMsg(raw, { content: '   ', nlp: 1, vec: null });
  const b = await messages.categoriesBacklogCached(GU);   // fresh namespace ⇒ no cache ⇒ a real compute
  const drainable = await messages.selectPendingCategories(GU, { limit: 1000 });
  // The anti-drift assertion: the COUNT and the SELECT must agree exactly, row for row.
  const mirrors = b.pending === drainable.length && b.pending === 2;
  // …and the rows the clause holds back are REPORTED, split by whether they can ever clear.
  const reported = b.blockedOnEmbed === 1 && b.unembeddable === 1 && b.tagged === 1;
  // …and the whitespace-only row moves NOTHING: excluded from total AND from every bucket, so
  // `tagged + pending + blockedOnEmbed + unembeddable === total` still closes and the bar can fill.
  const blankExcluded = b.total === 5 && (b.tagged + b.pending + b.blockedOnEmbed + b.unembeddable) === b.total;
  rec('C16b the categorize backlog COUNT mirrors the drain predicate exactly (pending === selectPendingCategories().length), reports the held-back rows (blockedOnEmbed / unembeddable) so a mid-import vault never reads as done, and excludes blanks CONSISTENTLY so the buckets sum to total',
    mirrors && reported && blankExcluded,
    `pending=${b.pending} selected=${drainable.length} blockedOnEmbed=${b.blockedOnEmbed} unembeddable=${b.unembeddable} tagged=${b.tagged} total=${b.total} sum=${b.tagged + b.pending + b.blockedOnEmbed + b.unembeddable}`);
}

// ── C17 — DRIVE THE REAL DRAINER: `tagged > embedded` is unreachable even when embed STALLS ────
// This is the operator's run, in miniature. The embedder embeds the 10 oldest rows and then
// returns null for everything else, which is drainOnce's OUTAGE SIGNATURE: a pass with several
// candidates and zero embeds writes NOTHING and returns all-zero counters, so the drainer's
// `moved === 0` no-progress break fires (`embedStalledOut`) and deferCategorizeForEmbed RELEASES
// categorize — exactly as it did on v0.1.13. Categorize then runs at full rate. The check is that
// it can only ever chew through the 10 rows that DID embed.
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  setSessionKeys({ userHex: 'a'.repeat(64), systemHex: 'b'.repeat(64) });
  const { raw, db } = freshVault();
  const EMBEDDABLE = 10, STUCK = 30;
  for (let i = 0; i < EMBEDDABLE; i++) addMsg(raw, { content: `ok row ${i} about minds and forests` });
  for (let i = 0; i < STUCK; i++) addMsg(raw, { content: `stuck row ${i} the embedder cannot vectorise` });

  const VEC = () => Array.from({ length: 768 }, () => 0.01);
  const embed = {
    health: async () => ({ status: 'ok', loaded: true, dim: 768 }),
    embed: async (content) => (/^ok row/.test(String(content)) ? VEC() : null),
    embedBatch: async (contents) => contents.map((c) => (/^ok row/.test(String(c)) ? VEC() : null)),
  };
  db.users = { getSettings: async () => ({ taskModels: { categorize: { model: 'test-label' } } }) };
  const daemon = { ensureUp: async () => {}, getBaseUrl: () => 'http://127.0.0.1:11434' };
  const ollama = { listInstalled: async () => ['test-label'], pullModel: async () => {} };
  // A classifier that ALWAYS succeeds — categorize is deliberately given every advantage, so the
  // only thing that can stop it outrunning embed is the drain-query invariant itself.
  const classify = async () => ({ domain: 'personal', register: 'reflective', subregister: null });

  const drainer = startEnrichDrainer({ db, userId: GU, intervalMs: 3600000, embed, daemon, ollama, classify, log: () => {} });
  for (let i = 0; i < 4; i++) await settle(drainer);   // several full cycles, embed stalled throughout
  const c = counts(raw);
  drainer.stop(); clearSessionKeys(); _resetGovernor();
  // `tagged <= embedded` is the operator's metric verbatim ("more categorized items than
  // embedded"). The second clause proves the run was REAL — categorize genuinely ran and tagged
  // the embedded rows, so a green here is not "nothing happened".
  const orderingHeld = c.tagged <= c.embedded;
  const actuallyRan = c.tagged > 0 && c.embedded === EMBEDDABLE;
  rec('C17 REAL drainer, embed STALLED mid-corpus: categorize never outruns embedding — tagged <= embedded (the operator\'s 445-embedded/772-categorized report is unreachable)',
    orderingHeld && actuallyRan,
    `embedded=${c.embedded} tagged=${c.tagged} (expected tagged<=embedded, embedded=${EMBEDDABLE}, tagged>0)`);
}

// ── C17b — a content RE-SYNC cannot manufacture `tagged > embedded` either ────────────────────
// The drain-query invariant is blind to this path: the row is ALREADY tagged, so it is never
// re-selected. updateContent nulls the vector and resets the embed stage; before this it left
// categories_processed at 1, minting a tagged-but-unembedded row on every content change.
{
  const { raw, messages } = freshVault();
  const id = addMsg(raw, { content: 'original body', nlp: 2, vec: Buffer.alloc(4), cats: 1 });
  const before = counts(raw);
  await messages.updateContent(GU, id, { content: 'the upstream body changed', contentHash: 'h2' });
  const after = counts(raw);
  const row = raw.prepare('SELECT nlp_processed, embedding_768, categories_processed FROM messages WHERE id = ?').get(id);
  const reEnriched = row.embedding_768 === null && row.nlp_processed === 0 && row.categories_processed === 0;
  const invariantHeld = after.tagged <= after.embedded;
  rec('C17b updateContent resets the CATEGORIZE stage with the embed stage — a content re-sync cannot leave a row counted as tagged with no vector (tagged <= embedded survives a re-sync)',
    reEnriched && invariantHeld,
    `before(tagged=${before.tagged},embedded=${before.embedded}) after(tagged=${after.tagged},embedded=${after.embedded}) row=${JSON.stringify(row)}`);
}

// ── C17c — a RESTORE cannot land tagged-but-unembedded rows (QA9 review, F1) ───────────────────
// The third message-restore path. `restoreTable` NULLs `embedding_768` for every table that has the
// column, unconditionally — so any caller restoring messages WITHOUT the enrichment overrides lands
// rows with no vector but the exporting vault's `categories_processed` intact: `tagged > embedded`
// straight out of an import, and permanently (a row left at nlp_processed 1|2 also never re-embeds).
// `src/ingest/restore-core.js` was exactly that caller — reachable in production via the
// `recent-export` import route — and the drain-query invariant is blind to an already-tagged row.
// Driving restoreTable with NO overrides is the point: the strip must live IN it, not in the caller.
{
  const { restoreTable } = await import('../src/ingest/vault-import.js');
  const { raw, db } = freshVault();
  const r = await restoreTable(db, 'messages', [{
    id: 'restored-1', user_id: 'someone-else', role: 'user', content: 'a restored message about minds',
    created_at: '2026-01-01T00:00:00.000Z',
    // What a real bundle carries from a vault that had already enriched it:
    nlp_processed: 2, categories_processed: 1, categorized_at: '2026-01-01T00:00:00.000Z',
    categories_model: 'qwen3.5:4b', domain: 'personal', register: 'reflective',
    embedding_768: Buffer.alloc(4),
  }], { userId: GU });            // ⚠️ NO `overrides` — the restore-core.js call shape
  const row = raw.prepare('SELECT nlp_processed, categories_processed, embedding_768, domain FROM messages WHERE id = ?').get('restored-1');
  const c = counts(raw);
  const landed = (r?.inserted ?? 0) === 1;
  const stripped = row && row.embedding_768 === null && row.nlp_processed === 0 && row.categories_processed === 0 && row.domain === null;
  const invariantHeld = c.tagged <= c.embedded;
  rec('C17c a RESTORE strips the categorize stage inside restoreTable itself — a caller that passes NO overrides still cannot land a row counted as tagged with no vector, and the row is left re-embeddable (nlp_processed = 0)',
    landed && stripped && invariantHeld,
    `landed=${landed} row=${JSON.stringify(row)} tagged=${c.tagged} embedded=${c.embedded}`);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  QA9 — CHAT IS PRIMARY: a LIVE-turn transcription preempts; an IMPORT transcription does not
// ══════════════════════════════════════════════════════════════════════════════════════════════
// ── C18 — the class comes from the CALL SITE, and both arms matter ────────────────────────────
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  // (a) LIVE turn, background holder present → INTERACTIVE ⇒ it PREEMPTS (sets the holder's yield
  //     flag). The fixture holder never yields, so it does NOT get the model slot — but it must
  //     still DECODE, on a BULK ticket. ⚠️ AN EARLIER DRAFT ASSERTED `!live.ok` HERE, i.e. it
  //     encoded the operator's own complaint ("the voice message got stopped") as the pass
  //     condition (QA9 review, F6). Three things must hold at once: the holder was ASKED to yield,
  //     the decode is NOT refused, and it is NOT a second resident model.
  const bg = admit({ lane: 'embed-drain-categorize', klass: CLASS.RESIDENT });
  const live = await admitTranscribe({ interactive: true });
  const preempted = governorStatus().counters.preempted >= 1;
  const notASecondModel = live.ok && live.klass === CLASS.BULK && governorStatus().resident.held === 1;
  // …and the abandoned preempt is WITHDRAWN, so the holder does not abort its cycle for a requester
  // that has already gone to BULK (QA9 review, HIGH-3).
  const preemptWithdrawn = bg.shouldYield() === false;
  if (live.ok) live.release();

  // (b) IMPORT, same conditions → BULK ⇒ it does NOT preempt and does NOT touch the model slot.
  const preemptsBefore = governorStatus().counters.preempted;
  const bulk = await admitTranscribe({ interactive: false });
  const importIsBulk = bulk.ok && governorStatus().bulk.held === 1 && governorStatus().resident.held === 1
    && governorStatus().counters.preempted === preemptsBefore;
  if (bulk.ok) bulk.release();
  bg.release();

  // (c) …and once the slot is free, the live transcription takes it AS the single model holder.
  const live2 = await admitTranscribe({ interactive: true });
  const st2 = governorStatus();
  const takesTheOneSlot = live2.ok && live2.klass === CLASS.INTERACTIVE && st2.resident.held === 1 && st2.resident.lane === 'transcribe-live';
  if (live2.ok) live2.release();
  _resetGovernor();
  rec('C18 live-chat transcription is INTERACTIVE and PREEMPTS a background resident holder (falling back to BULK, never refused, never a 2nd resident, preempt withdrawn on give-up), while an IMPORT transcription stays BULK and preempts nothing',
    preempted && notASecondModel && preemptWithdrawn && importIsBulk && takesTheOneSlot,
    `preempted=${preempted} notASecondModel=${notASecondModel} preemptWithdrawn=${preemptWithdrawn} importIsBulk=${importIsBulk} takesTheOneSlot=${takesTheOneSlot}`);
}

// ── C18b — the REAL live-turn route, not the module: /internal/attachment-context audio ────────
// The channel daemon's media stage awaits this route BEFORE the reply turn, so it IS the live-turn
// boundary. Until now it called transcribeAudio() with NO ticket at all — a ~1-3 GB whisper decode
// beside a resident model, on the one path where a human is waiting, and invisible to the C10
// anti-rot scan (it reaches whisper over HTTP, not via spawn/localInfer).
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const { internalRouter } = await import('../src/internal-router.js');
  const express = (await import('express')).default;

  let decodes = 0; let laneDuringDecode = null; let residentDuringDecode = null;
  // C20's SECOND ARM lives here, in the real route: the bound must be APPLIED, not merely sized.
  // The lease arithmetic below is only safe because the decode carries an AbortSignal; without one
  // the true hold is transcribe-long.js's 2 h default × withRetry's 2 attempts, and no lease is
  // safe. Capture what the route actually passes.
  let sawSignal = false; let sawHeartbeat = false;
  const db = {
    attachments: {
      getById: async () => ({ id: 'a1', user_id: 'u', file_type: 'audio/ogg', file_name: 'note.ogg', local_path: '/x.ogg' }),
      update: async () => {},
    },
    secrets: { get: async () => null, set: async () => {} },   // internalRouter's pairing store
  };
  const enrich = {
    getBlob: async () => Buffer.from('audio'),
    transcribeAudio: async (args) => {
      decodes++;
      if (args?.signal && typeof args.signal.aborted === 'boolean') sawSignal = true;
      if (typeof args?.onProgress === 'function') sawHeartbeat = true;
      const s = governorStatus();
      laneDuringDecode = s.resident.lane; residentDuringDecode = s.resident.held;
      return 'the transcript';
    },
  };
  const app = express();
  app.use(internalRouter({ db, userId: 'u', enrich }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const post = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/internal/attachment-context`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachmentId: 'a1', kind: 'audio' }),
    });
    return res.json();
  };

  // A background describe pass holds the model slot. The live decode must PREEMPT it — and then,
  // because the fixture holder never yields, must still DECODE on a BULK ticket rather than be
  // dropped. ⚠️ THE EARLIER DRAFT ASSERTED `decodes === 0` AND `reason === 'compute-busy'` HERE,
  // which made the gate's green the operator's complaint (QA9 review, F6) — and worse, it would
  // have been a REGRESSION on main, where this route took no ticket and always decoded.
  const held = admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT });
  const busy = await post();
  const decodedNotDropped = decodes === 1 && busy?.contextText === 'the transcript';
  const askedToYield = governorStatus().counters.preempted >= 1;
  // …and it did NOT become a second resident model while the describe pass held the slot.
  const neverTwoResident = residentDuringDecode === 1 && laneDuringDecode === 'describe-chronicles';
  held.release();

  // Slot free → the decode runs, and it runs AS the single resident-class holder on the
  // `transcribe-live` lane. That is what proves the ticket is INTERACTIVE and not ungoverned.
  const okRes = await post();
  const ranGoverned = decodes === 2 && okRes?.contextText === 'the transcript'
    && laneDuringDecode === 'transcribe-live' && residentDuringDecode === 1;
  // The ticket is RELEASED after the decode — a leaked model slot would wedge every resident lane.
  const released = governorStatus().resident.held === 0;
  await new Promise((r) => server.close(r));
  _resetGovernor();
  rec('C18b the LIVE channel voice-note route (/internal/attachment-context, audio) decodes UNDER a governor ticket — it PREEMPTS a describe pass and falls back to BULK rather than being dropped (never a 2nd resident), takes the single slot on lane `transcribe-live` once free, and releases it',
    decodedNotDropped && askedToYield && neverTwoResident && ranGoverned && released,
    `decodedNotDropped=${decodedNotDropped} askedToYield=${askedToYield} neverTwoResident=${neverTwoResident} ranGoverned=${ranGoverned} released=${released} decodes=${decodes} lane=${laneDuringDecode} residentHeld=${residentDuringDecode}`);

  // C20a — the BOUND IS APPLIED at the real call site. This is the load-bearing half of C20: the
  // lease arithmetic (C20b) is only safe because the decode carries an AbortSignal. Drop the signal
  // and the true hold becomes transcribe-long.js's 2 h × 2 attempts, which NO lease covers.
  rec('C20a the live route BOUNDS the decode it holds the model slot for — it passes an AbortSignal (the hold-time cap the lease is derived from) and an onProgress heartbeat (so a genuinely-advancing decode re-arms its own lease)',
    sawSignal && sawHeartbeat, `sawSignal=${sawSignal} sawHeartbeat=${sawHeartbeat}`);
}

// ── C19 — RESIDENT_MAX is STILL 1, and the new interactive lane does not stack a second model ──
// C1/C9 pin the cap for the background lanes. This pins it for the lane QA9 ADDED — the one that
// is allowed to preempt, i.e. the one most likely to be "optimised" into an exemption.
{
  _resetGovernor(); _setMemProbe(OK_PROBE);
  const live = await admitTranscribe({ interactive: true });
  const st = governorStatus();
  const capIsOne = st.resident.max === 1 && st.resident.held === 1;
  // Every resident-class lane must now be refused — including a SECOND interactive one.
  const bgRefused = !admit({ lane: 'describe-chronicles', klass: CLASS.RESIDENT }).ok;
  const secondLiveRefused = !admit({ lane: 'transcribe-live', klass: CLASS.INTERACTIVE }).ok;
  const neverTwo = governorStatus().resident.held === 1;
  if (live.ok) live.release();
  _resetGovernor();
  rec('C19 RESIDENT_MAX is still 1 — an INTERACTIVE transcription takes the ONE model slot by preempting and no path (background resident, or a second interactive) admits a second resident-class model alongside it',
    live.ok && capIsOne && bgRefused && secondLiveRefused && neverTwo,
    `admitted=${live.ok} max=${st.resident.max} held=${st.resident.held} bgRefused=${bgRefused} secondLiveRefused=${secondLiveRefused} neverTwo=${neverTwo}`);
}

// ── C20 — the INTERACTIVE lease can NEVER reclaim under a live decode (QA9 review, CRITICAL-1) ──
// The lease is the ONLY release backstop for this lane (whisper is HTTP — there is no ChildProcess
// to bind), and reclaiming while the decode is still running frees the model slot so the drainer
// loads a SECOND resident model beside it. That is a self-inflicted double admit: D-001.
// The first draft hard-coded 25 min and justified it against the channel daemon's 660 s CLIENT
// abort — which does not stop an express handler. The real hold is transcribe-long.js's 2 h default
// × internal-router's `withRetry` 2 attempts ≈ 4 h. So the fix is from both ends: the decode is
// BOUNDED by an AbortSignal (LIVE_DECODE_BUDGET_MS) and the lease is DERIVED from that bound.
{
  const { LIVE_DECODE_BUDGET_MS, INTERACTIVE_LEASE_MS } = await import('../src/enrich/transcribe-attachment.js');
  // (1) ARITHMETIC: the lease must exceed the worst-case hold (budget × the route's 2 attempts).
  const WORST_HOLD_MS = LIVE_DECODE_BUDGET_MS * 2;
  const leaseCoversHold = INTERACTIVE_LEASE_MS > WORST_HOLD_MS;

  // (2) FUNCTIONAL: hold an interactive ticket, advance the governor's clock to just past the
  //     worst-case hold, and assert it has NOT been reclaimed and the slot is still occupied.
  _resetGovernor(); _setMemProbe(OK_PROBE);
  let clock = 1_000_000;
  gov._setNow(() => clock);
  const live = await admitTranscribe({ interactive: true });
  clock += WORST_HOLD_MS + 1000;                 // the longest a live decode can possibly run
  await sleep(30);                               // let any armed lease timer fire
  const stillHeld = governorStatus().counters.reclaimed === 0 && governorStatus().resident.held === 1;
  // …and a background resident lane is STILL refused — i.e. no double-admit window opened.
  const noDoubleAdmit = !admit({ lane: 'embed-drain-categorize', klass: CLASS.RESIDENT }).ok;
  if (live.ok) live.release();
  gov._setNow(() => Date.now());
  _resetGovernor();
  rec('C20b the INTERACTIVE transcribe lease is DERIVED from the bounded live-decode budget and cannot reclaim under a running decode — no self-inflicted double admit (D-001)',
    leaseCoversHold && live.ok && stillHeld && noDoubleAdmit,
    `lease=${INTERACTIVE_LEASE_MS}ms worstHold=${WORST_HOLD_MS}ms leaseCoversHold=${leaseCoversHold} stillHeld=${stillHeld} noDoubleAdmit=${noDoubleAdmit}`);
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
