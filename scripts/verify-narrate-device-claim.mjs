// verify:narrate-device-claim — "content leaves this machine" must be a FACT, not a NAME.
//
// THE BUG (independent review of #184, 2026-07-16). NarrateControl.svelte:49 decided whether to
// tell the user their narration stayed on-box with:
//     const isLocal = (p) => !p || /local|ollama|on-?box|127\.0\.0\.1/i.test(p);
// — an UNANCHORED substring match over the provider's DISPLAY NAME. A cloud provider labelled
// "localai" rendered as "on-box" while its content went to an internet host. Labels are free
// text the user types (portal-providers `label`), so this needs no attacker.
//
// And the field it matched was never a fact about the run: portal-mindscape stored
// req.body.provider VERBATIM — a client-supplied string with no connection to the provider that
// actually ran the walk (resolved server-side, per turn, by run-turn → resolve.js).
//
// THE FIX IS OBSERVED, NOT PREDICTED — and that is the part this gate exists to defend. A
// snapshot at run start (the obvious fix, and the one the ticket asked for) is UNSOUND: loop.js
// advances the provider chain on failure, and a sensitive chain is [localPrimary, eu-zdr…,
// localFloor], so a run whose on-box Ollama dies falls back to EU CLOUD mid-run. The snapshot
// would still say "on-box" while the bytes left — the same lie, better derived. D4 pins exactly
// that, against the REAL loop.
//
//   D1  ⭐ the PROPERTY: onThisDevice is TRUE iff the base_url is loopback — over an
//          adversarial corpus, not a table of examples
//   D2  a NAME never moves the answer (the corpus that beat the old regex)
//   D3  onThisDevice ≠ jurisdiction: a `.local` LAN box is 'local' but NOT this device
//   D4  ⭐ THE FALLBACK: on-box primary → dead → EU cloud ⇒ the run reports it LEFT
//   D5  the tally is sticky + fail-closed (unknown claims nothing; off dominates)
//   D6  ⭐ the client cannot author the claim (no provider echo from the body)
//   D7  the UI reads the server fact — deny-by-default on the TOKEN, not on the FORM
import assert from 'node:assert';
import fs, { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { describeProvider } from '../src/agent/harness.js';
import { createAgentLoop } from '../src/agent/loop.js';
import { stripCommentsFor } from './lib/strip-comments.mjs';
import { isLoopbackUrl } from '../src/inference/presets.js';
import { DEFAULT_OLLAMA_URL } from '../src/inference/local.js';
import { startNarrationWalkJob, resumeNarration, getNarrationStatus, _resetNarration } from '../src/jobs.js';
import { runNarrationWalk } from '../src/agent/narration-walk.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// ── D1) THE PROPERTY ─────────────────────────────────────────────────────────
// NOT a table of expected values — an INVARIANT over a corpus: describeProvider's
// onThisDevice agrees with the shared host parser for EVERY url, whatever the label says.
// A gate that pinned examples would pass against a fix that special-cased those examples.
const HOSTS = [
  'http://127.0.0.1:11434/v1', 'http://localhost:11434/v1', 'http://[::1]:11434/v1',
  'http://127.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://0.0.0.0:11434/',
  'https://localhost.attacker.io/v1', 'https://evil.com/?x=localhost', 'http://x.localhost:11434/',
  'http://127.0.0.1.evil.com/', 'http://localhost@evil.com/', 'https://api.openai.com/v1',
  'https://api.regolo.ai/v1', 'http://ollama.lan.local:11434/v1', 'http://192.168.1.9:11434/v1',
  'not a url', '',
];
// Labels chosen to BEAT the old regex: each contains one of its alternatives.
const LABELS = ['localai', 'Ollama Cloud', 'on-box inference co', 'my 127.0.0.1 proxy', 'Regolo.ai (EU)', '', undefined];
{
  const bad = [];
  for (const baseUrl of HOSTS) {
    for (const label of LABELS) {
      const d = describeProvider({ openaiApiKey: 'k', baseUrl, label, cloudModel: 'm' });
      if (!d) continue;
      if (d.onThisDevice !== isLoopbackUrl(baseUrl)) bad.push(`${JSON.stringify(baseUrl)}+${JSON.stringify(label)}→${d.onThisDevice}`);
    }
  }
  rec('D1. ⭐ onThisDevice === isLoopbackUrl(base_url) for EVERY (url × label) — the PROPERTY, not examples',
    bad.length === 0, bad.length ? `disagreed: ${bad.slice(0, 3).join(' ')}` : `${HOSTS.length}×${LABELS.length} combos agree`);
}

// ── D2) a NAME never moves the answer ────────────────────────────────────────
// The old predicate's whole failure mode: the label decided. Vary ONLY the label and the
// answer must not budge — for a real cloud host, and for a real on-box one.
{
  const cloud = LABELS.map((label) => describeProvider({ openaiApiKey: 'k', baseUrl: 'https://api.openai.com/v1', label })?.onThisDevice);
  const box = LABELS.map((label) => describeProvider({ openaiApiKey: 'k', baseUrl: 'http://127.0.0.1:11434/v1', label })?.onThisDevice);
  rec('D2. the LABEL cannot move the verdict — "localai" on an internet host is NOT on your device',
    cloud.every((v) => v === false) && box.every((v) => v === true),
    `cloudHost=${JSON.stringify(cloud)} boxHost=${JSON.stringify(box)}`);
}

// ── D3) two fields, not one ──────────────────────────────────────────────────
// jurisdictionForBaseUrl maps `.local` → 'local' (a LAN box: no US Cloud Act exposure, and the
// right input for picking the native-Ollama WIRE). But the bytes cross the network, so it is
// NOT this device. Collapsing these re-ships the bug inverted.
{
  const lan = describeProvider({ openaiApiKey: 'k', baseUrl: 'http://ollama.lan.local:11434/v1', jurisdiction: 'local' });
  rec('D3. ⭐ a `.local` LAN box: jurisdiction "local" (sovereign) BUT onThisDevice FALSE (it left)',
    lan?.local === true && lan?.onThisDevice === false && lan?.jurisdiction === 'local',
    `local=${lan?.local} onThisDevice=${lan?.onThisDevice} jurisdiction=${lan?.jurisdiction}`);
}

// ── D4) ⭐ THE FALLBACK — against the REAL loop ───────────────────────────────
// This is the check a start-of-run snapshot cannot pass. The primary is a REAL on-box config;
// it fails; loop.js advances to the EU cloud element. The run must report that it LEFT.
// Uses the real createAgentLoop — asserting this against a stub would prove nothing (the
// standing trap: a gate that re-implements the thing it is testing).
{
  const onBox = { openaiApiKey: 'k', baseUrl: 'http://127.0.0.1:11434/v1', cloudModel: 'qwen3.5:4b', jurisdiction: 'local' };
  const euCloud = { openaiApiKey: 'k', baseUrl: 'https://api.regolo.ai/v1', cloudModel: 'qwen', jurisdiction: 'eu-zdr', label: 'Regolo.ai (EU)' };
  let call = 0;
  // A harness whose FIRST provider (on-box) dies pre-content — exactly the fallback trigger —
  // and whose second answers.
  const harness = {
    streamTurn: async ({ provider }) => {
      call += 1;
      if (isLoopbackUrl(provider?.baseUrl || '')) { const e = new Error('ECONNREFUSED: Ollama not running'); e.status = 503; throw e; }
      return { text: 'named it', toolsUsed: [] };
    },
  };
  const loop = createAgentLoop({ harness });
  const out = await loop.run({ provider: onBox, providerChain: [onBox, euCloud], system: '', userMessage: 'name this cluster', tools: [], call: async () => '' });
  rec('D4. ⭐ on-box primary DIES → loop falls back to EU cloud ⇒ actualOnThisDevice=FALSE (a start-of-run snapshot would still say on-box)',
    out?.fellBack === true && out?.actualOnThisDevice === false && out?.actualJurisdiction === 'eu-zdr',
    `fellBack=${out?.fellBack} actualOnThisDevice=${out?.actualOnThisDevice} actualJurisdiction=${out?.actualJurisdiction} calls=${call}`);
}

{
  // ⚠️ THIS CHECK EXISTS BECAUSE THE RED-TEST CAUGHT ITS ABSENCE. Mutating loop.js's
  // `?? null` → `?? true` — an unattributable wire silently claiming "on your device", the
  // fail-OPEN direction and the whole bug class — left every other check GREEN. D5c looked
  // like it covered this, but it feeds onThisDevice:null straight to the tally through a stub
  // walk, so loop.js's defaulting never ran. A gate proves the bug it was WRITTEN for.
  //
  // The local FLOOR ({jurisdiction:'local', localFallback:true}) is the real unattributable
  // provider: normalizeProvider dials it on-box, but it carries no base_url, so describeProvider
  // returns null and NOTHING can honestly attribute it. `=== null` pins BOTH defaults: `?? true`
  // (claims on-box — the lie) and `?? false` (claims it left — a false alarm).
  const floor = { jurisdiction: 'local', localFallback: true };
  const harness = { streamTurn: async () => ({ text: 'named it', toolsUsed: [] }) };
  const out = await createAgentLoop({ harness }).run({ provider: floor, system: '', userMessage: 'x', tools: [], call: async () => '' });
  rec('D4b. ⭐ an UNATTRIBUTABLE provider (the local FLOOR — no base_url) ⇒ actualOnThisDevice=null, never defaulted',
    out?.actualOnThisDevice === null, `actualOnThisDevice=${JSON.stringify(out?.actualOnThisDevice)} (a default of true|false here is a claim nothing can support)`);
}

// ── D5) the tally: sticky, fail-closed, resume-safe — through the REAL job + a REAL vault ────
// A REAL booted vault, not a hand-rolled db double: a fake that answers my own SQL proves my
// SQL matches my fake. This way the same run also proves migration 0050 APPLIES and the columns
// round-trip through better-sqlite3 (which returns the boolean as INTEGER 0/1 — the exact
// coercion the UI has to get right). Mirrors verify:narration-job's setup.
const DB = 'data/verify-narrate-device-claim.db', KCV = 'data/verify-narrate-device-claim-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* absent */ } }
mkdirSync('data', { recursive: true });
{ const d0 = new Database(DB); applyMigrations(d0); d0.close(); }
const { db, close } = await boot({
  dbPath: DB, kcvPath: KCV, embedder: null,
  userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'),
});
const U = 'local-user';
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// Prove 0050 actually landed before asserting anything about its columns — an ALTER that
// silently didn't apply would otherwise read as "the tally never set the field".
{
  const cols = new Database(DB, { readonly: true });
  const names = cols.prepare('PRAGMA table_info(narration_runs)').all().map((c) => c.name);
  cols.close();
  rec('D5. migration 0050 applied — narration_runs carries the two device columns',
    names.includes('on_this_device') && names.includes('off_device_jurisdictions'), names.join(','));
}

const walkOf = (progressEvents) => async ({ onProgress }) => {
  for (const p of progressEvents) await onProgress({ described: 1, reflected: 0, skipped: 0, total: 2, item: { kind: 'realm', id: 1 }, doneKey: 'realm:1', ...p });
  return { described: 1, reflected: 0, skipped: 0, failed: 0, total: 2, ledger: [], stopped: false, doneKeys: ['realm:1'] };
};
const runWith = async (events) => {
  _resetNarration();
  const { runId } = await startNarrationWalkJob({ db, userId: U, scope: 'all', runWalk: walkOf(events) });
  await settle();
  return { row: await getNarrationStatus({ db, userId: U, runId }), runId };
};
{
  const { row } = await runWith([{ wireRan: true, onThisDevice: true, wireJurisdiction: 'local' }]);
  rec('D5a. every turn proven on-box ⇒ on_this_device=1', row?.on_this_device === 1, `on_this_device=${row?.on_this_device}`);
}
{
  // STICKY + DOMINANT: one turn left, the rest were on-box. The run LEFT. Order must not matter.
  const { row } = await runWith([
    { wireRan: true, onThisDevice: true, wireJurisdiction: 'local' },
    { wireRan: true, onThisDevice: false, wireJurisdiction: 'eu-zdr' },
    { wireRan: true, onThisDevice: true, wireJurisdiction: 'local' },
  ]);
  rec('D5b. ⭐ ONE turn off-device among on-box turns ⇒ 0 + WHERE (sticky: once content leaves, it has left)',
    row?.on_this_device === 0 && row?.off_device_jurisdictions === '["eu-zdr"]',
    `on_this_device=${row?.on_this_device} where=${row?.off_device_jurisdictions}`);
}
{
  // UNKNOWN claims NOTHING — it must NOT read as on-box (the lie) and must NOT read as a
  // warning (a false alarm teaches the user to ignore the badge).
  const { row } = await runWith([
    { wireRan: true, onThisDevice: true, wireJurisdiction: 'local' },
    { wireRan: true, onThisDevice: null, wireJurisdiction: null },
  ]);
  rec('D5c. ⭐ an UNATTRIBUTABLE turn ⇒ NULL (claims nothing) — never folded into "all on-box"',
    row?.on_this_device === null || row?.on_this_device === undefined,
    `on_this_device=${JSON.stringify(row?.on_this_device)}`);
}
{
  // A §4g refusal / no-model ran NO wire → nothing observed → no claim either way.
  const { row } = await runWith([{ wireRan: undefined, onThisDevice: null }]);
  rec('D5d. a turn that ran NO wire (§4g refusal / no model) leaves the claim unmade',
    row?.on_this_device === null || row?.on_this_device === undefined, `on_this_device=${JSON.stringify(row?.on_this_device)}`);
}
{
  // RESUME must not forget: segment 1 egressed; segment 2 is all on-box. The run still LEFT.
  _resetNarration();
  const { runId } = await startNarrationWalkJob({ db, userId: U, scope: 'all', runWalk: walkOf([{ wireRan: true, onThisDevice: false, wireJurisdiction: 'us-standard' }]) });
  await settle();
  await db.rawQuery(`UPDATE narration_runs SET status = 'paused' WHERE run_id = ?`, [runId]);
  _resetNarration();
  await resumeNarration({ db, userId: U, runId, runWalk: walkOf([{ wireRan: true, onThisDevice: true, wireJurisdiction: 'local' }]) });
  await settle();
  const row = await getNarrationStatus({ db, userId: U, runId });
  rec('D5e. ⭐ RESUME is seeded from the row — an earlier segment\'s egress is never forgotten',
    row?.on_this_device === 0 && String(row?.off_device_jurisdictions).includes('us-standard'),
    `on_this_device=${row?.on_this_device} where=${row?.off_device_jurisdictions}`);
}

// ── D9) ⭐ the WALK actually REPORTS the wire — against the REAL runNarrationWalk ──────
// ⚠️ THIS SECTION EXISTS BECAUSE THE GATE WAS VACUOUS HERE (independent review, 2026-07-16 —
// the reviewer spotted it before its session died). D5* drives the tally through a STUB walk
// that emits progress payloads directly, so narration-walk.js's `wire` construction — the
// thing that decides what the tally ever sees — was executed by NOTHING. Three mutations
// survived a full GO:
//     hardcode `onThisDevice: true`      → the badge claims on-box for EVERY run
//     drop `...wire` from the FAILED path → an egressing failed turn goes unreported
//     drop `...wire` from the SUCCESS path → the fact never reaches the row at all
// Same shape as the `?? null → ?? true` hole D4b pins: the gate proved the bug it was WRITTEN
// for. So: drive the REAL walk with an injected runTurn (it is injectable precisely so the
// walk is testable without a model) and assert the fact ARRIVES.
{
  const R = 7;
  const q = (sql, p = []) => db.rawQuery(sql, p).then((r) => r.results || r || []);
  await q(`INSERT INTO realms (user_id, realm_id, name, essence) VALUES (?,?,?,?)`, [U, R, 'Inner weather', 'moods']);
  await q(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, essence, message_count, described_period_start, described_period_end) VALUES (?,?,?,?,?,?,?,?)`,
    [U, 70, R, 'Grief', 'loss', 12, '2023-01-01T00:00:00Z', '2023-12-31T00:00:00Z']);
  for (let i = 0; i < 6; i++) {
    for (const [id, ts] of [[`d70o${i}`, `2023-0${1 + i}-15T10:00:00Z`], [`d70n${i}`, `2024-0${1 + i}-15T10:00:00Z`]]) {
      await q(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`, [id, U, `reflection ${id} on the matter at hand`, ts]);
      await q(`INSERT INTO clustering_points (id, user_id, source_type, source_id, territory_id, realm_id, created_at) VALUES (?,?,?,?,?,?,?)`, [`cp-${id}`, U, 'message', id, 70, R, ts]);
    }
  }
  // Territories are walked BEFORE their realm (synthesis last), so: turn 1 = territory 70
  // (SUCCEEDS, off-device via EU), turn 2 = the realm (FAILS mid-stream, off-device via US).
  // The failing turn is the point: loop.js keeps text streamed before an error and an error can
  // land mid-request — the prompt was ALREADY SENT. "The turn failed" ≠ "nothing left".
  const seen = [];
  let turn = 0;
  const injectedRunTurn = async () => (++turn === 1
    ? { text: 'named it', toolsUsed: [], actualOnThisDevice: false, actualJurisdiction: 'eu-zdr' }
    : { text: '', toolsUsed: [], lastErr: 'ECONNRESET mid-stream', actualOnThisDevice: false, actualJurisdiction: 'us-standard' });
  await runNarrationWalk(
    { db, userId: U, runTurn: injectedRunTurn },
    { runId: 'gate-wire', scope: { realm_id: R }, onProgress: (p) => { seen.push(p); } },
  );
  const ok = seen.find((p) => p.doneKey && p.wireRan);
  const failedEv = seen.find((p) => p.failedReason);
  rec('D9. ⭐ the REAL walk reports the wire on a SUCCESSFUL turn (pins `...wire` on the success path)',
    !!ok && ok.onThisDevice === false && ok.wireJurisdiction === 'eu-zdr',
    `wireRan=${ok?.wireRan} onThisDevice=${ok?.onThisDevice} jurisdiction=${ok?.wireJurisdiction}`);
  rec('D9b. ⭐ …and on a FAILED turn too — an error lands mid-request, the prompt already left',
    !!failedEv && failedEv.wireRan === true && failedEv.onThisDevice === false && failedEv.wireJurisdiction === 'us-standard',
    `failedReason=${failedEv?.failedReason} wireRan=${failedEv?.wireRan} onThisDevice=${failedEv?.onThisDevice} jurisdiction=${failedEv?.wireJurisdiction}`);
  // …and the value must come from the TURN, not be hardcoded: a walk told the wire was on-box
  // must say so. Without this, `onThisDevice: false` could be pinned by hardcoding FALSE.
  turn = 10;
  const seen2 = [];
  await runNarrationWalk(
    { db, userId: U, runTurn: async () => ({ text: 'named it', toolsUsed: [], actualOnThisDevice: true, actualJurisdiction: 'local' }) },
    { runId: 'gate-wire-2', scope: { realm_id: R }, onProgress: (p) => { seen2.push(p); } },
  );
  const onBox = seen2.find((p) => p.wireRan);
  rec('D9c. …and the reported value TRACKS the turn (on-box in ⇒ on-box out) — not a hardcoded constant',
    !!onBox && onBox.onThisDevice === true && onBox.wireJurisdiction === 'local',
    `onThisDevice=${onBox?.onThisDevice} jurisdiction=${onBox?.wireJurisdiction} — with D9/D9b, only the real value satisfies both`);
  // A §4g refusal ran NO wire — the walk must not invent one.
  const seen3 = [];
  await runNarrationWalk(
    { db, userId: U, runTurn: async () => ({ skipped: 'sensitive-no-safe-provider' }) },
    { runId: 'gate-wire-3', scope: { realm_id: R }, onProgress: (p) => { seen3.push(p); } },
  );
  rec('D9d. a §4g-refused turn reports NO wire (nothing ran ⇒ nothing to claim)',
    seen3.length > 0 && seen3.every((p) => !p.wireRan),
    `events=${seen3.length} anyWireRan=${seen3.some((p) => p.wireRan)}`);
}

// ── D10) the load-bearing coupling under the UNKNOWN state ───────────────────
// makeDeviceTally's resume seeding infers "an earlier segment ran an unattributable wire" from
// (described + reflected) > 0, because narration_runs persists no `failed` count. That leaves a
// theoretical hole: an earlier segment whose turns ALL failed on an unattributable wire leaves
// described+reflected = 0 and on_this_device = NULL, so a resumed all-on-box segment reports 1
// ("every observed turn was on this device") on behalf of turns it never saw.
//
// It is not reachable TODAY, and this pins exactly why. UNKNOWN arises ONLY when
// describeProvider returns null — i.e. a cfg with no oauth/anthropic/openai key AND no
// base_url — and normalizeProvider (harness.js) dials precisely that cfg at DEFAULT_OLLAMA_URL.
// So an unattributable wire IS on this device, and the resumed "1" is TRUE.
//
// That safety is a COUPLING to the floor's default host, not a property of the tally. Point the
// floor at a remote default and the hole opens silently, in the fail-OPEN direction. So pin it
// here: if this check ever fails, makeDeviceTally's seeding must become explicit (persist the
// unknown state) BEFORE the floor moves.
rec('D10. the unattributable FLOOR dials THIS DEVICE (what makes the resume-seeding heuristic sound)',
  isLoopbackUrl(DEFAULT_OLLAMA_URL) === true,
  `DEFAULT_OLLAMA_URL=${DEFAULT_OLLAMA_URL} — if this ever leaves the box, jobs.js makeDeviceTally can claim on-box for a turn that egressed`);

// ── D6) ⭐ the CLIENT cannot author the claim ─────────────────────────────────
// The root defect: the route stored req.body.provider verbatim and the UI reported it back as
// sovereignty. Pin it at the JOB boundary (a signature that ignores it) AND at the route source.
{
  _resetNarration();
  // Pass the old param — a caller that still tries must NOT get it onto the row.
  const { runId } = await startNarrationWalkJob({ db, userId: U, scope: 'all', provider: 'localai', runWalk: walkOf([]) });
  await settle();
  const row = await getNarrationStatus({ db, userId: U, runId });
  rec('D6. ⭐ a caller-supplied provider label CANNOT reach the row (the client no longer authors the claim)',
    row?.provider == null, `row.provider=${JSON.stringify(row?.provider)}`);
}
{
  const src = fs.readFileSync(new URL('../src/portal-mindscape.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("router.post('/mycelium/narrate'"), src.indexOf("router.post('/mycelium/narrate/pause'"));
  assert.ok(route.length > 100, 'gate is looking at the wrong slice — the narrate route moved');
  // Deny-by-default on the TOKEN: ANY mention of a body-sourced provider in this route fails,
  // whatever syntax reads it. Enumerating FORMS (req.body?.provider / req.body["provider"]) is
  // an OPEN set — the last gate that tried was beaten in five minutes.
  const mentionsBodyProvider = /body[^\n]*provider|provider[^\n]*body/i.test(route.replace(/^\s*\/\/.*$/gm, ''));
  rec('D7. the narrate ROUTE reads no provider from the request body (token-denied, not form-matched)',
    !mentionsBodyProvider, mentionsBodyProvider ? 'the route mentions a body-sourced provider' : 'no body→provider path in the route');
}

// ── D7) the UI renders the SERVER fact ───────────────────────────────────────
// Source check, deny-by-default on the TOKEN. P6 in the sibling gate enforced the detection
// FORM (/\.test\(/ etc.) — an OPEN set, beaten by .indexOf/.search/new RegExp/a helper in
// another file. So: the badge's decision must MENTION the server field, and the component must
// not mention the old name-derived one AT ALL. Comments are stripped first — a previous gate
// was satisfied by its OWN comments and went GO with the bug fully restored.
{
  const raw = fs.readFileSync(new URL('../portal-app/src/lib/components/mindscape/NarrateControl.svelte', import.meta.url), 'utf8');
  // Strip comments so prose about the bug can't satisfy the gate — LEXICALLY, via the one
  // stripper (scripts/lib/strip-comments.mjs). The regexes that were here only removed
  // LINE-LEADING `//`, so a TRAILING comment (`someCall(); // run.provider is gone`) stayed
  // in the text and could satisfy these matches outright; block comments were not handled
  // at all. Gated by verify:strip-comments.
  const src = stripCommentsFor('NarrateControl.svelte', raw);
  assert.ok(/on_this_device/.test(raw), 'gate mis-wired: the component does not mention on_this_device at all');
  const readsServerFact = /on_this_device/.test(src);
  // `run.provider` is GONE — the name is not in the component's code in any form.
  const readsProviderName = /\brun\.provider\b|\bprovider:\s*string/.test(src);
  // …and no name-shaped locality predicate survives, whatever it is spelled with.
  const namePredicate = /\bisLocal\b|on-\?box|ollama/i.test(src);
  rec('D8. ⭐ the badge reads on_this_device; no run.provider and no name-derived locality predicate survive',
    readsServerFact && !readsProviderName && !namePredicate,
    `readsServerFact=${readsServerFact} readsProviderName=${readsProviderName} namePredicate=${namePredicate}`);
  // The three-state contract: `unknown` must render nothing. A bare {:else} after the
  // off-device branch would guess.
  rec('D8b. …and it distinguishes the THREE states (null claims nothing — no coercion to a boolean)',
    /on_this_device\s*==\s*null|on_this_device\s*===\s*null/.test(src) && !/!run\.on_this_device/.test(src),
    'null must be tested explicitly, never coerced');
}

await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the sovereignty badge is an OBSERVED fact (base_url via the shared parser), never a name' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
