// verify:readiness — the ONE readiness model (DATA-READINESS-DESIGN-2026-07-15 §3.2, §7).
//
// R3  canGenerate encodes the >=5 threshold ONCE; get() and getFresh() agree after a settle
// R4  fail-closed: a broken source ⇒ not-ready / cannot-generate, never a throw
// R5  no plaintext: the full readiness JSON carries no message content and no nlp_error
// R6  /onboarding/status stays byte-compatible — the shape must not move (§7 R6)
// R7  'unknown' ≠ 'no_messages' — a counting error must never report an empty vault
// S1-S4  slicing + warm: a cheap slice must NOT touch the expensive scan (§3.2b)
//
// R8  the `models` slice: four members, honest defaults, and it stays FREE (§3.2b)
//
// NOTE ON IDs: §7's R1/R2 (the keystone `pending` assertions) live in
// verify-pipeline-integrity.mjs (I8-I12) — they gate increment A's counter, not this
// module. §7's R4 also names `labeler.state:'unavailable'`.
// ⚠️ THIS NOTE USED TO SAY "the labeler slice lands in increment C, so R4 here covers the
// fail-closed contract for the slices that exist" — STALE, and it had gone stale silently.
// `labeler` landed with increment M and `enricher` with the re-review (readiness.js: both are
// members of `models`), but nothing here was ever added, so this file asserted NOTHING about
// either — the deferral note was the only thing telling a reader why, long after the reason
// expired. A stale "not yet" reads exactly like a considered "not needed" (independent review,
// 2026-07-16). R8/R8b below close the seam for the readiness MODULE's half of the contract;
// the drainer's half (what each status MEANS) is verify-model-consent's M4b/M4c/M7b/M9*.
// An earlier version of this file numbered the SLICING tests R6, silently displacing
// §7's back-compat test — so a reviewer ticking §7 by ID got a false green (independent
// review, 2026-07-15).
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createReadiness } from '../src/readiness.js';
import { portalCompatRouter } from '../src/portal-compat.js';
import { isEnrichProcessingPaused, pauseEnrichProcessing, resumeEnrichProcessing } from '../src/enrich/drainer.js';
import { bustMindscapePoints } from '../src/mindscape-cache.js';

// The slice list R5 must sweep. Kept HERE, next to the gate that depends on it, because the
// module's own ALL is private — and because R5's job is to name the surface explicitly.
const ALL_SLICES = ['data', 'tags', 'embedder', 'models', 'ai', 'channel', 'mindscape', 'onboarding', 'processing'];

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
async function t(n, fn) { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }

const U = 'local-user';
// A db double that records what got touched — that is how R6 proves the slicing.
function mkDb(over = {}) {
  const touched = [];
  const db = {
    touched,
    messages: {
      async embedBacklog() { touched.push('embedBacklog:PURE'); return { total: 100, embedded: 90, pending: 8, unprocessable: 2 }; },
      async embedBacklogCached() { touched.push('embedBacklog:CACHED'); return { total: 100, embedded: 90, pending: 8, unprocessable: 2 }; },
      async categoriesBacklogCached() { touched.push('categories:CACHED'); return { total: 100, tagged: 60, pending: 40 }; },
      async nlpBacklogCached() { touched.push('nlp:CACHED'); return { done: 30, total: 100, pending: 20 }; },
    },
    users: { async getSettings() { touched.push('getSettings'); return {}; } },
    providers: { async list() { touched.push('providers'); return [{ id: 1, provider: 'claude_subscription', label: 'Claude', is_active: 1 }]; } },
    secrets: { async get() { return '1'; }, async has() { return true; } },
    mindscape: { async getNoiseStats() { touched.push('noiseStats'); return { total: 73520 }; } },
    async rawQuery(sql) {
      const s = String(sql || '');
      // The evidence aggregates — recorded individually so a test can assert WHICH scan ran.
      if (/MIN\(created_at\)/.test(s)) { touched.push('evidence:dateRange'); return { results: [{ earliest: '2019-03-04T00:00:00Z', latest: '2024-11-02T00:00:00Z' }] }; }
      if (/GROUP BY source/.test(s)) { touched.push('evidence:sources'); return { results: [{ source: 'chatgpt', c: 500 }, { source: 'claude', c: 347 }] }; }
      if (/COUNT\(DISTINCT conversation_id\)/.test(s)) { touched.push('evidence:conversations'); return { results: [{ c: 61 }] }; }
      if (/FROM people/.test(s)) { touched.push('evidence:people'); return { results: [{ c: 12 }] }; }
      return { results: [{ welcome_shown_at: '2026-01-01', onboarding_dismissed_at: null }] };
    },
  };
  return Object.assign(db, over);
}

// ── R3) canGenerate: the >=5 threshold, once; get()/getFresh() agree ──────────
await t('R3. canGenerate encodes the >=5 threshold ONCE and get()/getFresh() agree', async () => {
  // The doubles return DIFFERENT counts per path, so "they agree" is a real assertion:
  // a vacuous double (identical values both ways) would pass any implementation.
  const db = mkDb();
  db.messages.embedBacklogCached = async () => ({ total: 100, embedded: 90, pending: 8, unprocessable: 2 });
  db.messages.embedBacklog       = async () => ({ total: 100, embedded: 91, pending: 7, unprocessable: 2 }); // fresher
  const r = createReadiness({ db, userId: U });
  const a = await r.get({ slices: ['data'] });
  const b = await r.getFresh({ slices: ['data'] });
  assert.equal(a.data.embedded, 90, 'cached path reads the cached count');
  assert.equal(b.data.embedded, 91, 'fresh path reads the PURE count — different source, proving the split');
  assert.equal(a.canGenerate.ok, true, 'embedded=90 >= 5 ⇒ ok');
  assert.deepEqual(a.canGenerate, b.canGenerate, 'both sides of the threshold agree despite different counts');
  assert.equal(r.MIN_EMBEDDED, 5, 'the threshold is exported once, not re-declared per caller');
});

await t('R3b. below the threshold ⇒ not_embedded (not a generic failure)', async () => {
  const db = mkDb(); db.messages.embedBacklogCached = async () => ({ total: 10, embedded: 2, pending: 8, unprocessable: 0 });
  const r = createReadiness({ db, userId: U });
  const { canGenerate } = await r.get({ slices: ['data'] });
  assert.deepEqual(canGenerate, { ok: false, reason: 'not_embedded' });
});

await t('R3c. an empty vault ⇒ no_messages', async () => {
  const db = mkDb(); db.messages.embedBacklogCached = async () => ({ total: 0, embedded: 0, pending: 0, unprocessable: 0 });
  const r = createReadiness({ db, userId: U });
  const { canGenerate } = await r.get({ slices: ['data'] });
  assert.deepEqual(canGenerate, { ok: false, reason: 'no_messages' });
});

// ── R7) 'unknown' must NOT impersonate an empty vault (§3.2a — a live bug today) ──
await t("R7. a COUNTING ERROR reports 'unknown', never 'no_messages' (the preflight bug)", async () => {
  const db = mkDb(); db.messages.embedBacklogCached = async () => { throw new Error('SQLITE_BUSY'); };
  const r = createReadiness({ db, userId: U });
  const { canGenerate } = await r.get({ slices: ['data'] });
  assert.equal(canGenerate.ok, false, 'fail-closed on the gate');
  assert.equal(canGenerate.reason, 'unknown',
    "a count failure must NOT tell a full vault it is empty — that is the live preflight bug this replaces");
});

// ── R4) fail-closed everywhere ────────────────────────────────────────────────
await t('R4. every source broken ⇒ degrades safely, never throws', async () => {
  const db = {
    messages: { async embedBacklogCached() { throw new Error('x'); }, async embedBacklog() { throw new Error('x'); },
                async categoriesBacklogCached() { throw new Error('x'); } },
    providers: { async list() { throw new Error('x'); } },
    secrets: { async get() { throw new Error('x'); }, async has() { throw new Error('x'); } },
    mindscape: { async getNoiseStats() { throw new Error('x'); } },
    async rawQuery() { throw new Error('x'); },
  };
  const r = createReadiness({ db, userId: U, embedderHealth: () => { throw new Error('x'); } });
  const s = await r.get();
  assert.equal(s.canGenerate.ok, false, 'cannot generate when nothing is known');
  assert.equal(s.ai.connected, false, 'unknown ⇒ NOT connected');
  assert.equal(s.mindscape.generated, false, 'unknown ⇒ NOT generated');
  assert.equal(s.embedder.up, false, 'unknown ⇒ embedder down');
  assert.equal(s.channel.connected, false, 'unknown ⇒ channel not connected');
});

await t('R4b. an ALL-INACTIVE provider list is NOT connected (the old onboarding bug)', async () => {
  const db = mkDb(); db.providers.list = async () => [{ id: 1, provider: 'openai', is_active: 0 }];
  const r = createReadiness({ db, userId: U });
  const { ai } = await r.get({ slices: ['ai'] });
  assert.equal(ai.connected, false, 'providers.length>0 is NOT connected — an active row is');
});

// ── R5) no plaintext (CLAUDE.md §1) ───────────────────────────────────────────
await t('R5. the full readiness payload carries NO content and NO nlp_error', async () => {
  const db = mkDb();
  db.messages.embedBacklogCached = async () => ({ total: 1, embedded: 0, pending: 1, unprocessable: 0,
    content: 'MY SECRET JOURNAL ENTRY', nlp_error: 'dim mismatch on message 42' });
  const r = createReadiness({ db, userId: U, embedderHealth: () => ({ status: 'ok' }) });
  // ⚠️ EVERY slice, evidence INCLUDED. R5 called a bare get(), and the moment `evidence`
  // became opt-in (increment E) it silently fell OUT of this leak gate's coverage — adding
  // a slice shrank the pre-existing guarantee, invisibly (independent review, 2026-07-16).
  // A leak gate must enumerate the surface, not inherit a default that can move under it.
  const json = JSON.stringify(await r.get({ slices: [...ALL_SLICES, 'evidence'] }));
  assert.ok(!json.includes('MY SECRET JOURNAL'), 'message content must never reach readiness');
  assert.ok(!json.includes('dim mismatch'), 'a failure REASON must never reach readiness — counts only');
  assert.ok(!json.includes('nlp_error'), 'not even the field name');
});

// ── R6) BACK-COMPAT + the second copy of the bug (§7 R6; the review's HIGH-1) ─────
// §7 requires /onboarding/status to stay byte-compatible. And HIGH-1 showed the SERVER
// fix is not enough: the client ignores the preflight's 409 reason and polls
// /processing-status, whose catch used to return `{total:0}` — so the "your vault is
// empty" lie survived one HTTP hop away. These pin BOTH halves.
await t('R6. /processing-status reports `unknown` on a count failure — never a fabricated zero', async () => {
  const { portalMindscapeRouter } = await import('../src/portal-mindscape.js');
  const db = mkDb();
  db.messages.embedBacklogCached = async () => { throw new Error('SQLITE_BUSY'); };
  const router = portalMindscapeRouter({ db, userId: U, dbPath: '/tmp/x.db' });
  const layer = router.stack.find((l) => l.route?.path === '/mycelium/processing-status');
  assert.ok(layer, 'the route must exist');
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await layer.route.stack[0].handle({ query: {} }, res, () => {});
  assert.equal(body.unknown, true, 'a count failure must say so');
  assert.equal(body.total, undefined,
    'it must NOT emit total:0 — generate.ts turns total===0 into "Import some conversations first", which is the bug');
  assert.equal(body.embedded, undefined, 'nor a fabricated embedded count');
});

await t('R6b. /processing-status still carries the counts on the happy path (shape unmoved)', async () => {
  const { portalMindscapeRouter } = await import('../src/portal-mindscape.js');
  const router = portalMindscapeRouter({ db: mkDb(), userId: U, dbPath: '/tmp/x.db' });
  const layer = router.stack.find((l) => l.route?.path === '/mycelium/processing-status');
  let body = null;
  const res = { json: (b) => { body = b; return res; }, status: () => res };
  await layer.route.stack[0].handle({ query: {} }, res, () => {});
  for (const k of ['embedded', 'total', 'pending', 'unprocessable', 'embedder']) {
    assert.ok(k in body, `back-compat: /processing-status must still carry \`${k}\``);
  }
  assert.equal(body.unknown, undefined, 'no `unknown` flag on the happy path');
  assert.equal(body.total, 100, 'and the real count');
});

// ── R8) the `models` slice — four members, honest defaults, free to ask ───────
await t('R8. an UNWIRED `models` slice reads `unknown` for all four members — never a fabricated `ok`', async () => {
  // THE MODULE'S OWN FAIL-CLOSED DEFAULT, which nothing here asserted: createReadiness takes all
  // four healths by INJECTION, so a caller that wires none (a verify script, a pre-boot read, or
  // — the real risk — a boot path that simply forgets one) must be told 'unknown'. M4c covers a
  // health that THROWS; this covers one that was never passed, which is the likelier accident:
  // it is silent, and 'ok' would be a lie assembled from nothing at all.
  const r = createReadiness({ db: mkDb(), userId: U });          // ← no health injectors AT ALL
  const out = await r.get();                                      // slice-less ⇒ ALL ⇒ carries `models`
  assert.ok(out.models, 'the default payload must carry the `models` slice (it is in ALL)');
  for (const m of ['embedder', 'labeler', 'enricher', 'transcriber']) {
    assert.equal(out.models[m]?.status, 'unknown', `${m}: an unwired health is 'unknown', never 'ok' — got '${out.models[m]?.status}'`);
    // One vocabulary, one shape — the whole point of the slice (§3.10b). A member that drops a
    // key forces every consumer into a per-member special case, which is the spaghetti it replaced.
    for (const k of ['status', 'message', 'detail', 'model', 'progress']) {
      assert.ok(k in out.models[m], `${m} must carry the uniform key '${k}'`);
    }
  }
  // The ENRICHER specifically — the member this file had zero assertions for, and the one whose
  // absence let L2 run dormant AND silent for a month.
  assert.match(out.models.enricher.message || '', /enrichment/i, `the enricher must say what is unknown, not just that something is: got "${out.models.enricher.message}"`);
});

await t('R8b. asking for `models` is FREE — it must never drag in the multi-second scan (§3.2b)', async () => {
  // The four healths are in-memory supervisor reads, which is WHY readiness.js keeps them out of
  // the awaited set. That is a property worth pinning: `models` rides in ALL, so if it ever grew
  // a DB hit (an nlp-backlog counter for the enricher is an OPEN design question — see the note
  // in drainer.js's defaultEnrichModel), every slice-less readiness call — including the polled
  // ones — would silently inherit a full-table decrypt scan. S1/S2 pin this for the other slices.
  const db = mkDb();
  const r = createReadiness({ db, userId: U, enricherHealth: () => ({ status: 'ok', message: 'Enriching with qwen3.5:4b.' }) });
  const out = await r.get({ slices: ['models'] });
  assert.equal(out.models.enricher.status, 'ok', 'sanity: the injected health is what it reports');
  assert.deepEqual(db.touched, [], `a models-only slice must touch NO db source — got [${db.touched}]`);
});

// ── R6) slicing — the cheap probe stays cheap (§3.2b) ─────────────────────────
await t('S1. a mindscape-only slice does NOT touch the multi-second backlog scan', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  await r.get({ slices: ['mindscape'] });
  assert.ok(db.touched.includes('noiseStats'), 'it must read the cheap COUNT');
  assert.ok(!db.touched.some((x) => x.startsWith('embedBacklog')),
    'the MCP gate must NOT drag in the SQLCipher full-table scan — that is why get() is sliced');
});

await t('S2. the default (cached) path never runs the PURE scan', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  await r.get({ slices: ['data'] });
  assert.ok(db.touched.includes('embedBacklog:CACHED'), 'default rides the SWR cache');
  assert.ok(!db.touched.includes('embedBacklog:PURE'), 'polling the pure scan once hung the app at boot');
});

await t('S3. getFresh() DOES run the pure scan (the Generate preflight)', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  await r.getFresh({ slices: ['data'] });
  assert.ok(db.touched.includes('embedBacklog:PURE'), 'the preflight needs a fresh count');
});

await t('S4. warm() is fire-and-forget and never throws, even when everything is broken', async () => {
  const db = { messages: { async embedBacklogCached() { throw new Error('x'); }, async categoriesBacklogCached() { throw new Error('x'); } } };
  const r = createReadiness({ db, userId: U });
  let threw = false;
  try { r.warm(); } catch { threw = true; }
  assert.equal(threw, false, 'warm() must never throw synchronously — it runs inside completeBoot');
  // An unhandled rejection would exit the process nonzero; surviving the tick IS the assert.
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(true, 'warm() survived a fully-broken db without an unhandled rejection');
});

// ── evidence (increment E) ───────────────────────────────────────────────────
// The invite's Data step reads these four facts. §3.2's TYPE SKETCH put them inside
// `data`; §3.2b — later, and the pass that established "a cheap probe must stay cheap" —
// forbids it, because `data` is what the GENERATE PREFLIGHT buys on every click. The two
// sections of the design contradict each other and the principle wins; E1 pins that.

await t('E1. ⭐ evidence is OPT-IN — a bare get() must NOT buy three unindexed scans', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  const out = await r.get();                       // no slices = "the portal's ONE call"
  assert.equal(out.evidence, undefined, 'a bare get() must not RETURN evidence…');
  assert.ok(!db.touched.some((x) => x.startsWith('evidence:')),
    '…and must not RUN its aggregates. Increment G polls readiness; if evidence rode ALL, '
    + 'that poll would full-scan a 76k-row messages table every tick — PIVOT 2 reintroduced '
    + 'by the back door. Naming the slice is the price of paying for it.');
});

await t('E2. …but naming it returns the four facts the card renders', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  const { evidence } = await r.get({ slices: ['evidence'] });
  assert.deepEqual(evidence.sources, [{ source: 'chatgpt', count: 500 }, { source: 'claude', count: 347 }]);
  assert.equal(evidence.dateRange.yearStart, 2019);
  assert.equal(evidence.dateRange.yearEnd, 2024);
  assert.equal(evidence.conversationCount, 61);
  assert.equal(evidence.peopleCount, 12);
  assert.ok(!evidence.unknown, 'the happy path is not "unknown"');
});

await t('E3. evidence NEVER drags in the multi-second backlog scan', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  await r.get({ slices: ['evidence'] });
  assert.ok(!db.touched.some((x) => x.startsWith('embedBacklog')),
    'the card wants the aggregates WITHOUT the SQLCipher decrypt — that is the whole reason '
    + 'it does not reuse /import/preview, which bundles them with the pure scan (PIVOT 2)');
});

await t("E4. a failed aggregate reads 'unknown' — never a fabricated empty vault", async () => {
  // The §3.2a discipline, applied to evidence: R7 proves it for counts; a card that
  // renders "0 sources · 0 people" off a query that NEVER RAN tells an owner with 70k
  // messages that their vault is empty. Same bug, different surface.
  const db = mkDb({ async rawQuery() { throw new Error('SQLCipher scan failed'); } });
  const r = createReadiness({ db, userId: U });
  const { evidence } = await r.get({ slices: ['evidence'] });
  assert.equal(evidence.unknown, true, "a broken read must SAY it is unknown");
  assert.deepEqual(evidence.sources, [], 'and must not invent sources');
  assert.equal(evidence.conversationCount, 0);
});

await t('E5. ⭐ evidence touches ONLY allowlisted plaintext columns — deny-by-default', () => {
  // ⚠️ REWRITTEN after review. The first version asserted `!sql.includes('content')` — a
  // BLOCKLIST OF ONE WORD. It caught `SELECT content` and let `SELECT nlp_error` walk
  // straight through, green, alongside R5 which also missed it. A single-negative test
  // passes a blocklist; only an allowlist asserts the property.
  //
  // ⚠️ AND the obvious repair — "assert against ENCRYPTED_FIELDS.messages" — is a DEAD END
  // built on a false premise. `crypto-local.js:247` is `messages: []`: the per-field
  // envelope was REMOVED (DESIGN-sqlcipher-stageBC-content-2026-06-19), so content
  // plaintext lives INSIDE the SQLCipher file and only `secrets` stays field-encrypted.
  // There is no envelope to hide behind — a leak here is REAL PLAINTEXT over HTTP (§1),
  // not a blob. An empty list would have made this gate vacuous in the other direction.
  //
  // So: enumerate what evidence() is ALLOWED to read. Anything else fails, forever,
  // including columns nobody has invented yet.
  const ALLOWED = new Set(['user_id', 'created_at', 'source', 'conversation_id', 'id', 'c', 'earliest', 'latest']);
  const seen = [];
  const db = {
    messages: {},
    async rawQuery(sql) {
      seen.push(String(sql));
      if (/MIN\(created_at\)/.test(String(sql))) return { results: [{ earliest: '2019-01-01', latest: '2024-01-01' }] };
      if (/GROUP BY source/.test(String(sql))) return { results: [{ source: 'chatgpt', c: 5 }] };
      if (/COUNT\(DISTINCT conversation_id\)/.test(String(sql))) return { results: [{ c: 2 }] };
      if (/FROM people/.test(String(sql))) return { results: [{ c: 1 }] };
      return { results: [{}] };
    },
  };
  const r = createReadiness({ db, userId: U });
  return r.get({ slices: ['evidence'] }).then(({ evidence }) => {
    assert.ok(!evidence.unknown, 'fixture sanity: the happy path must not be unknown');
    assert.ok(seen.length >= 4, 'fixture sanity: evidence must have issued its aggregates');
    // Every bare identifier in every statement must be allowlisted or a SQL keyword.
    const KEYWORDS = new Set(['select', 'from', 'where', 'and', 'or', 'group', 'by', 'order', 'desc', 'asc',
      'limit', 'count', 'distinct', 'min', 'max', 'as', 'is', 'not', 'null', 'messages', 'people']);
    for (const sql of seen) {
      for (const ident of sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) || []) {
        if (KEYWORDS.has(ident) || ALLOWED.has(ident)) continue;
        assert.fail(`evidence() read a NON-ALLOWLISTED column: "${ident}" in: ${sql.trim().replace(/\s+/g, ' ').slice(0, 90)}`
          + ' — this shape crosses the HTTP boundary and messages.content is PLAINTEXT inside the'
          + ' SQLCipher file (crypto-local.js:247 messages: []). Aggregates only, never a column'
          + ' that describes, narrates or fingerprints the user.');
      }
    }
  });
});


await t("E6. ⭐ /import/preview FAILS CLOSED on an unknown read — it must not serve an empty vault", async () => {
  // The regression an independent review caught in MY OWN diff (2026-07-16), and the reason
  // E4 was not enough: E4 asserts on `readiness`, this asserts on the ROUTE. evidence()
  // computes `unknown` correctly and the ONLY CALLER destructured the zeros and dropped the
  // flag — so a corrupt-DB read served HTTP 200 {messageCount: 76000, sources: [],
  // conversationCount: 0}. OnboardingFlow:185 gates on messageCount being a number, so the
  // card RENDERS it: "76,000 messages · 0 sources" off a scan that never ran. Before the
  // delegation this route threw into its own 500 and the card showed nothing.
  // I wrote the principle in evidence() and discarded it one line later. Gate the caller.
  const db = {
    messages: { async embedBacklog() { return { total: 76000, embedded: 70000, pending: 6000, unprocessable: 0 }; } },
    async rawQuery() { throw new Error('SQLITE_CORRUPT: database disk image is malformed'); },
  };
  const app = express();
  app.use('/portal', portalCompatRouter({ db, userId: U, readiness: createReadiness({ db, userId: U }) }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/portal/import/preview`);
    const body = await res.json().catch(() => ({}));
    assert.equal(res.status, 500,
      `a failed aggregate must fail closed, got ${res.status} ${JSON.stringify(body).slice(0, 120)}`
      + ' — serving 200 with zeroed evidence tells an owner with 76k messages their vault is empty');
    assert.equal(body.conversationCount, undefined, 'and must not ship fabricated counts alongside the error');
  } finally { srv.close(); }
});

await t('E7. ⭐ a failed PEOPLE read is unknown too — no silently-earned "0 people"', async () => {
  // MED-2. The route this slice replaces wrapped the people read in its own try/catch → 0,
  // and I inherited it — making `{peopleCount: 0, unknown: false}` an UNQUALIFIED CLAIM off a
  // swallowed error. `people` exists from migrations/0001_init.sql, so that catch never fired
  // for absence, only for real failures. The old route could afford it (it never rendered the
  // number); the evidence card renders it as proof-of-perception: "you know 0 people".
  //
  // ⚠️ This gate exists because reverting the fix produced NO RED. I removed the inner catch
  // and nothing pinned it — the fix was decoration until this line (mutation sweep, 2026-07-16).
  let calls = 0;
  const db = {
    messages: {},
    async rawQuery(sql) {
      calls++;
      if (/FROM people/.test(String(sql))) throw new Error('SQLITE_ERROR: disk I/O error');
      if (/MIN\(created_at\)/.test(String(sql))) return { results: [{ earliest: '2019-01-01', latest: '2024-01-01' }] };
      if (/GROUP BY source/.test(String(sql))) return { results: [{ source: 'chatgpt', c: 847 }] };
      if (/COUNT\(DISTINCT conversation_id\)/.test(String(sql))) return { results: [{ c: 61 }] };
      return { results: [{}] };
    },
  };
  const r = createReadiness({ db, userId: U });
  const { evidence } = await r.get({ slices: ['evidence'] });
  assert.ok(calls >= 4, 'fixture sanity: the people read must actually have been attempted');
  assert.equal(evidence.unknown, true,
    'a people read that FAILED must mark the evidence unknown — not report peopleCount:0 as a fact. '
    + 'Re-adding an inner try/catch that swallows to 0 must fail HERE.');
});

// ── EC/W/M) the cold-status-load caches (2026-07-18) ─────────────────────────
// The status popover's FIRST paint on a 76k-message vault paid four live full-table
// aggregate scans (evidence, once per open — G-COST) plus the clustering_points COUNT.
// These gates price the fix: evidence rides an SWR memo (serve stale, single-flight,
// 15s TTL), the mindscape memo rides the REAL points-bust chokepoint, and warm()
// pre-pays both at boot. ⚠️ IDs: the operator's brief named these E3/E4/E5 — but this
// file already HAS an E3/E4/E5 with different meanings, and this file's own header
// documents what silent ID displacement does to a reviewer ticking a checklist. EC*/W5/M*
// are the same assertions under non-colliding names.
// Every gate counts DB TOUCHES across calls (the COST), never the response shape —
// a shape gate is satisfied by a cache that never caches (memory: gates-assert-shape-
// never-cost, #200).

const EVIDENCE_TOUCHES = (db) => db.touched.filter((x) => x.startsWith('evidence:')).length;

await t('EC1. ⭐ evidence COST — the SECOND read within TTL runs ZERO of the aggregate queries', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  const first = (await r.get({ slices: ['evidence'] })).evidence;
  const paidOnce = EVIDENCE_TOUCHES(db);
  assert.ok(paidOnce >= 4, `fixture sanity: the cold read must pay the aggregates (saw ${paidOnce})`);
  const second = (await r.get({ slices: ['evidence'] })).evidence;
  assert.equal(EVIDENCE_TOUCHES(db), paidOnce,
    'the second read within TTL re-ran aggregate queries — the popover re-open (and any second '
    + 'consumer in the window) must be served from the memo, zero scans. Count the COST, not the shape.');
  assert.deepEqual(second, first, 'and it serves the SAME snapshot, not a recompute in disguise');
});

await t('EC2. ⭐ evidence stale-serve — an expired read returns the PRIOR snapshot instantly while the revalidate lands the fresh one', async () => {
  let t0 = 1_000_000;
  let conv = 61;
  const db = mkDb();
  const baseRaw = db.rawQuery.bind(db);
  db.rawQuery = async (sql, args) => {
    if (/COUNT\(DISTINCT conversation_id\)/.test(String(sql))) { db.touched.push('evidence:conversations'); return { results: [{ c: conv }] }; }
    return baseRaw(sql, args);
  };
  const r = createReadiness({ db, userId: U, now: () => t0 });
  assert.equal((await r.get({ slices: ['evidence'] })).evidence.conversationCount, 61, 'cold read sees the current count');
  t0 += 20_000;                    // TTL (15s) expired
  conv = 99;                       // the vault changed meanwhile
  const stale = (await r.get({ slices: ['evidence'] })).evidence;
  assert.equal(stale.conversationCount, 61,
    'an EXPIRED read must serve the prior snapshot instantly (SWR) — blocking on the recompute is '
    + 'exactly the cold-load cost this memo exists to remove');
  await new Promise((res) => setTimeout(res, 30));   // let the background revalidate land
  const before = EVIDENCE_TOUCHES(db);
  const freshAfter = (await r.get({ slices: ['evidence'] })).evidence;
  assert.equal(freshAfter.conversationCount, 99,
    'the background revalidate must have LANDED the fresh snapshot — stale-serve without '
    + 'revalidation is a cache that never updates, which breaks the operator\'s "updates still live"');
  assert.equal(EVIDENCE_TOUCHES(db), before, 'and the post-revalidate read is served from the memo, zero new scans');
});

await t('EC3. an `unknown` revalidate is NEVER cached and never evicts the last GOOD snapshot (§3.2a)', async () => {
  let t0 = 1_000_000;
  let broken = false;
  const db = mkDb();
  const baseRaw = db.rawQuery.bind(db);
  db.rawQuery = async (sql, args) => { if (broken) throw new Error('SQLITE_BUSY'); return baseRaw(sql, args); };
  const r = createReadiness({ db, userId: U, now: () => t0 });
  const good = (await r.get({ slices: ['evidence'] })).evidence;
  assert.ok(!good.unknown, 'fixture sanity');
  t0 += 20_000; broken = true;
  const held = (await r.get({ slices: ['evidence'] })).evidence;       // stale-served; revalidate will fail
  await new Promise((res) => setTimeout(res, 30));
  const after = (await r.get({ slices: ['evidence'] })).evidence;
  assert.deepEqual(held, good, 'the stale serve holds the good snapshot');
  assert.deepEqual(after, good,
    'a FAILED revalidate must not replace a good snapshot with `unknown` — holding the last known '
    + 'answer is the same discipline G3 pins on the client. Caching the unknown would serve a '
    + 'fabricated-empty card for a full TTL window.');
});

await t('EC4. /import/preview BYPASSES the memo — a read-after-import surface must never see a stale snapshot', async () => {
  // The route change EC1 makes dangerous: if /import/preview rode the memo, the card the user
  // reads MOMENTS after importing would render the BOOT-TIME snapshot — "0 sources" over a
  // just-imported corpus, the §3.2a lie by way of a cache. fresh:true is that route's contract;
  // removing it must fail HERE, not in production.
  let conv = 5;
  const db = mkDb();
  const baseRaw = db.rawQuery.bind(db);
  db.rawQuery = async (sql, args) => {
    if (/COUNT\(DISTINCT conversation_id\)/.test(String(sql))) return { results: [{ c: conv }] };
    return baseRaw(sql, args);
  };
  db.messages.embedBacklog = async () => ({ total: 10, embedded: 10, pending: 0, unprocessable: 0 });
  const readiness = createReadiness({ db, userId: U });
  await readiness.get({ slices: ['evidence'] });      // warm the memo (the popover's read)
  conv = 42;                                          // "the import just landed"
  const app = express();
  app.use('/portal', portalCompatRouter({ db, userId: U, readiness }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const body = await (await fetch(`http://127.0.0.1:${srv.address().port}/portal/import/preview`)).json();
    assert.equal(body.conversationCount, 42,
      'preview served the MEMOIZED count from before the import — it must read fresh (fresh:true), '
      + 'exactly like its deliberately-PURE messageCount one line up');
  } finally { srv.close(); }
});

await t('EC4b. ⭐ fresh:true does NOT join an in-flight background revalidate — it must see the POST-import count', async () => {
  // THE DEFECT EC4 MISSES. EC4 warms the memo with NO concurrent scan running, so it only drives
  // the memo-HIT path — it never exercises the single-flight LATCH. If a background revalidate
  // (a status-popover open, or boot warm()) is already IN FLIGHT when /import/preview fires
  // fresh:true, routing fresh through evidenceRevalidate() makes the fresh caller JOIN that older
  // promise and receive the count the background scan read BEFORE the import committed — the
  // read-after-import contract (portal-compat.js:1305) silently returns pre-import data. The
  // window is one background evidence scan, which WIDENS with vault size (worst on 76k-message
  // vaults). fresh must run its OWN scan, exactly like data(fresh) does, never a shared latch.
  //
  // Deterministic: the background scan is PARKED at its conversation aggregate (held promise)
  // so it is provably in-flight; the import "commits" (conv 5→42) while it is parked; then the
  // fresh read fires. With the fix it runs a second, independent scan and sees 42. With the bug
  // (fresh routed back through the single-flight) it joins the parked promise and returns 5.
  let conv = 5;                                   // pre-import
  let releaseBackground;
  const backgroundHeld = new Promise((r) => { releaseBackground = r; });
  let convCalls = 0;
  const db = mkDb();
  const baseRaw = db.rawQuery.bind(db);
  db.rawQuery = async (sql, args) => {
    if (/COUNT\(DISTINCT conversation_id\)/.test(String(sql))) {
      convCalls++;
      db.touched.push('evidence:conversations');
      if (convCalls === 1) { await backgroundHeld; return { results: [{ c: 5 }] }; } // background: parked IN-FLIGHT, reads pre-import 5
      return { results: [{ c: conv }] };                                             // fresh: its OWN scan, current value
    }
    return baseRaw(sql, args);
  };
  const readiness = createReadiness({ db, userId: U });

  const background = readiness.get({ slices: ['evidence'] });   // NOT awaited — leaves evidenceRevalidate() in flight
  await new Promise((res) => setTimeout(res, 30));              // let the background scan reach + park at its held query
  assert.equal(convCalls, 1, 'fixture sanity: the background revalidate must be parked in-flight at its conversation scan');
  conv = 42;                                                    // "the import commits while the background scan is parked"

  // Arm the release BEFORE awaiting: under the bug the fresh read JOINS the held promise, so it
  // only resolves once the background is released — to the PRE-import 5, which reds the assert.
  // Under the fix the fresh read resolves immediately from its own scan (42), before this fires.
  setTimeout(() => releaseBackground(), 40);
  const fresh = (await readiness.get({ slices: ['evidence'], fresh: true })).evidence;
  assert.equal(fresh.conversationCount, 42,
    'fresh:true JOINED the in-flight background revalidate and returned its PRE-import count (5). '
    + 'fresh must run its OWN scan, never evidenceInFlight — this is the read-after-import contract '
    + '/import/preview depends on (portal-compat.js:1305), and EC4 cannot catch it (no concurrent scan).');
  releaseBackground();
  await background.catch(() => {});
});

await t('W5. ⭐ warm() pre-pays evidence + mindscape — the first user-facing read runs ZERO scans', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  r.warm();
  await new Promise((res) => setTimeout(res, 30));    // warm is fire-and-forget; let it land
  db.touched.length = 0;
  const out = await r.get({ slices: ['evidence', 'mindscape'] });
  assert.equal(EVIDENCE_TOUCHES(db), 0,
    'the first post-boot evidence read paid the aggregates — warm() must have populated the memo, '
    + 'or the status panel\'s first open still pays four live full-table scans');
  assert.ok(!db.touched.includes('noiseStats'),
    'the first post-boot mindscape read re-counted — warm() must cover the mindscape memo too');
  assert.equal(out.evidence.conversationCount, 61, 'and the warmed snapshot carries real values');
  assert.equal(out.mindscape.generated, true, 'mindscape too (73520 points ⇒ generated)');
});

await t('M1. mindscape COST — the second read within TTL runs ZERO COUNT queries', async () => {
  const db = mkDb();
  const r = createReadiness({ db, userId: U });
  await r.get({ slices: ['mindscape'] });
  assert.equal(db.touched.filter((x) => x === 'noiseStats').length, 1, 'fixture sanity: the cold read counts once');
  await r.get({ slices: ['mindscape'] });
  assert.equal(db.touched.filter((x) => x === 'noiseStats').length, 1,
    'the rail polls this @4s for the life of every session — a repeat within TTL must be memo-served');
});

await t('M2. ⭐ the REAL bustMindscapePoints invalidates the memo — a regenerate shows up on the NEXT read', async () => {
  // The operator's second requirement — "updates should still show up live" — proven against the
  // REAL bust chokepoint (mindscape-cache.js), not a hand-rolled invalidation: jobs.js:297 calls
  // exactly this export when clustering re-runs, so this drives the production wire end to end.
  let total = 100;
  const db = mkDb();
  db.mindscape = { async getNoiseStats() { db.touched.push('noiseStats'); return { total }; } };
  const r = createReadiness({ db, userId: U });
  assert.equal((await r.get({ slices: ['mindscape'] })).mindscape.pointCount, 100);
  total = 250;                                        // "Generate re-ran"
  // Scope control first: a bust for ANOTHER user must not evict this vault's memo.
  bustMindscapePoints('someone-else');
  await r.get({ slices: ['mindscape'] });
  assert.equal(db.touched.filter((x) => x === 'noiseStats').length, 1,
    "another user's bust must not evict this memo (userId-scoped listener)");
  bustMindscapePoints(U);                             // the REAL hook, this user
  const after = (await r.get({ slices: ['mindscape'] })).mindscape;
  assert.equal(db.touched.filter((x) => x === 'noiseStats').length, 2,
    'after the real bust the next read must RE-COUNT — a no-op bust means "Generated · N points" '
    + 'goes stale for the full TTL after a regenerate, which is the staleness the operator forbade');
  assert.equal(after.pointCount, 250, 'and it reports the post-regenerate count');
  // And the all-users form (bustMindscapePoints() with no arg) must evict too:
  total = 300;
  bustMindscapePoints();
  assert.equal((await r.get({ slices: ['mindscape'] })).mindscape.pointCount, 300, 'a global bust evicts as well');
});

// ── un-dismiss (increment E3, §3.7b) ─────────────────────────────────────────
await t('U1. ⭐ POST /onboarding/reset actually CLEARS the dismissal — the undo works', async () => {
  // §3.7b: the rail is gated on `!dismissed` and `dismissed` was PERMANENT — the only writer
  // was /onboarding/dismiss, and the undo's CLIENT route already existed (secure-fetch.ts:180)
  // while the SERVER half was never ported, so it 404'd. One reflexive × silenced the only
  // surface that says "your AI isn't connected", for the life of the vault.
  // ⚠️ Assert the EFFECT, not the status code: a route that 200s and writes nothing is exactly
  // the bug (it is what /dismiss's swallow-and-say-ok would have given us here).
  const writes = [];
  const db = {
    messages: {}, providers: { async list() { return []; } },
    secrets: { async has() { return false; } },
    async rawQuery(sql, args) {
      const s = String(sql);
      // ⚠️ Match the WHOLE statement, WHERE clause included. The first version matched only the
      // SET clause, so `WHERE id != ?` (clears every OTHER user) and a bare UPDATE with no WHERE
      // at all (clears EVERYONE) both passed VERDICT: GO — the args are still [userId] either
      // way. My own comment said "and scope it to this user" and nothing tested it (independent
      // review MED-1, 2026-07-16). Assert the SQL that must run, not a fragment of it.
      // ⚠️ END-ANCHORED. Un-anchored, `WHERE id = ? OR 1=1` (clears EVERY user) is a prefix match
      // and passed VERDICT: GO (independent review, LOW residual of MED-1). A predicate is not a
      // prefix — assert the whole statement, to its end.
      if (/^UPDATE users SET onboarding_dismissed_at = NULL WHERE id = \?$/.test(s.trim())) { writes.push({ sql: s, args }); return { results: [] }; }
      return { results: [{ welcome_shown_at: '2026-01-01', onboarding_dismissed_at: '2026-07-01' }] };
    },
  };
  const app = express();
  app.use('/portal', portalCompatRouter({ db, userId: U, readiness: createReadiness({ db, userId: U }) }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/portal/onboarding/reset`, { method: 'POST' });
    assert.equal(res.status, 200, 'the route must exist — it 404d before E3 (the client has called it all along)');
    assert.equal(writes.length, 1, 'it must actually issue the UPDATE — a 200 that writes nothing IS the bug');
    assert.deepEqual(writes[0].args, [U], 'and scope it to this user');
  } finally { srv.close(); }
});

await t('U2. ⭐ a FAILED reset reports failure — it must not claim the guidance is back', async () => {
  // Its sibling /onboarding/dismiss swallows and returns ok:true — defensible there, because a
  // failed dismiss just means the nudge persists (safe). Here the polarity INVERTS: answering
  // ok:true on a failed write tells the user their guidance is restored while it stays gone,
  // and they have no way to tell. Fail closed (§3.2a's discipline, one surface over).
  const db = {
    messages: {}, providers: { async list() { return []; } },
    secrets: { async has() { return false; } },
    async rawQuery(sql) {
      if (/UPDATE users SET onboarding_dismissed_at = NULL/.test(String(sql))) throw new Error('SQLITE_BUSY');
      return { results: [{ welcome_shown_at: '2026-01-01', onboarding_dismissed_at: '2026-07-01' }] };
    },
  };
  const app = express();
  app.use('/portal', portalCompatRouter({ db, userId: U, readiness: createReadiness({ db, userId: U }) }));
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/portal/onboarding/reset`, { method: 'POST' });
    assert.equal(res.status, 500, `a failed write must SAY so, got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    assert.notEqual(body.ok, true, 'and must never answer ok:true over a write that did not happen');
  } finally { srv.close(); }
});

await t('U3. ⭐ restoring guidance reaches the LIVE rail — proven by MOUNTING it, not grepping', () => {
  // ⚠️ THIS GATE WAS A REGEX AND A REVIEWER BEAT IT THREE WAYS, each leaving the feature DEAD:
  //   • effect body wrapped in `if (false) { … }`            → GO   (the #190/D2 pattern)
  //   • real `void refresh()` deleted, a TRAILING comment
  //     "// TODO: should call refresh() here" left behind    → GO   ← satisfied by a COMMENT,
  //       because the stripper only removed FULL-LINE // comments. The gate written to stop
  //       comment-satisfaction, satisfied by a comment. Third time this exact shape.
  //   • the import deleted (runtime ReferenceError)          → GO
  // A regex proves the wiring is PRESENT. The bug was LIVENESS — "the signal reaches the rail" —
  // and only running it can see that. My own memory says so: a render must be MOUNTED, not
  // grepped (independent review MED-2, 2026-07-16).
  //
  // So: compile the REAL OnboardingFlow + the REAL rune store, mount in jsdom, signal from a
  // separate importer, and COUNT the /onboarding/status reads. That read IS refresh() working.
  let r = {};
  try {
    r = JSON.parse(execFileSync('node', ['--conditions', 'browser', 'test/mount-onboarding-flow.mjs'],
      { cwd: 'portal-app', encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop());
  } catch (e) { assert.fail(`the mount harness did not run: ${String(e?.message || e).slice(0, 200)}`); }

  assert.ok(r.ok, `the real component failed to mount: ${r.error || 'unknown'}`);
  assert.equal(r.afterMount, 1, 'sanity: onMount must read status exactly once — if this is 0 the harness is not exercising the component');
  assert.equal(r.refreshedOnSignal, 1,
    'THE BUG: signalling a restored dismissal did NOT make OnboardingFlow re-read `dismissed`. '
    + 'Its only other re-read is `else if (railVisible) refresh()`, and railVisible requires '
    + '!dismissed — the one path that can clear the flag is gated on the flag. So the toggle '
    + 'writes the DB, says "Setup guidance restored.", and the rail stays gone until RESTART.');
  assert.equal(r.refreshedOnSecond, 1, 'and it must keep working — a signal that fires once is a latch, not a signal');
});


// ── §3.7a — the invite and the rail can NEVER coexist (increment E2) ─────────
await t('X1. ⭐ the rail appears IFF generated && (!ai || !channel) — proven by MOUNTING it', () => {
  // THE structural claim, and map §5.1's bug. Before this the invite hid on `points.length === 0`
  // (the client STORE) and the rail on `!generated` (/portal/mindscape's NODES) — two
  // measurements of one idea, both true through the middle of onboarding ⇒ BOTH ON SCREEN AT
  // ONCE. Now both pivot on readiness.mindscape.generated with OPPOSITE polarity, so overlap is
  // unrepresentable rather than carefully avoided.
  //
  // ⚠️ MOUNTED, not grepped. A regex over `railVisible` proves the EXPRESSION, not that anything
  // renders — `{#if false && …}` beat exactly that gate on #190/#195. This drives the REAL
  // component and reads the DOM for `.rail`.
  //
  // ⚠️ And it drives EACH GUARD SEPARATELY: `railVisible` ANDs five terms, and a mutation to one
  // can be masked by another short-circuiting first (memory: two-guards-can-mask-each-other, #198).
  const drive = (generated, ai, channel, extra = {}) => {
    const out = execFileSync('node', ['--conditions', 'browser', 'test/mount-onboarding-flow.mjs'], {
      cwd: 'portal-app', encoding: 'utf8', timeout: 120000,
      env: {
        ...process.env, GENERATED: generated ? '1' : '0', AI: ai ? '1' : '0', CHANNEL: channel ? '1' : '0',
        DISMISSED: extra.dismissed ? '1' : '0', TOTAL: String(extra.total ?? 5),
        WELCOME_STAMPED: extra.welcomeStamped === false ? '0' : '1',
      },
    }).trim().split('\n').pop();
    const r = JSON.parse(out);
    assert.ok(r.ok, `the real rail failed to mount: ${r.error || 'unknown'}`);
    return r;
  };
  const shows = (...a) => drive(...a).railRendered;

  assert.equal(shows(false, false, false), false,
    'PRE-generation the rail must be GONE — that is the invite\'s territory, and the invite gates on '
    + '!generated. A rail here is map §5.1: two onboarding surfaces at once.');
  // ⚠️ BOTH single-miss cases, and the reason is not symmetry-for-its-own-sake. My first matrix
  // had (1,0,0) (1,1,0) (1,1,1) — every row expecting `true` ALSO had channel missing, so the
  // channel term carried the assertion and the AI guard was never exercised alone. Deleting the
  // AI guard outright, and separately re-introducing the all-inactive-provider bug, BOTH passed.
  // (1,0,1) is the row that distinguishes them (memory: two-guards-can-mask-each-other, #198 —
  // which I had already cited in a comment three lines up while writing the incomplete matrix).
  assert.equal(shows(true, false, false), true, 'generated + neither connected ⇒ the rail must say so');
  assert.equal(shows(true, false, true), true,
    'generated + AI MISSING but channel present ⇒ the rail must STILL appear. This row exists to '
    + 'exercise the AI guard ALONE — without it, deleting that guard passes.');
  assert.equal(shows(true, true, false), true,
    'generated + channel MISSING but AI present ⇒ likewise, exercising the channel guard alone '
    + '(the rail had NO channel awareness at all before E2)');
  assert.equal(shows(true, true, true), false, 'generated + nothing missing ⇒ the rail has nothing true to say; it must be hidden');

  // ⚠️ THE REMAINING GUARDS, each driven ALONE. A reviewer deleted `!dismissed` and `welcomeSeen`
  // OUTRIGHT and this gate stayed GO — the harness had DISMISSED/TOTAL knobs that NO ASSERTION
  // TOUCHED, so the stub's hardcoded `welcomeSeen:true, total:5` satisfied both unconditionally.
  // I fixed the two holes I found and stopped; that is the SECOND time in this one gate.
  assert.equal(shows(true, false, false, { dismissed: true }), false,
    'a DISMISSED rail must stay gone — §3.7b calls the undo "non-negotiable" precisely because '
    + 'this guard is what the × writes. Deleting it made dismissal a no-op and X1 did not notice.');
  // BOTH arms of `welcomeSeen = welcome_shown_at || total > 0`, or the reconstruction is untested.
  assert.equal(shows(true, false, false, { welcomeStamped: false, total: 0 }), false,
    'unstamped welcome AND empty vault ⇒ welcomeSeen is FALSE ⇒ the rail must not pre-empt the '
    + 'welcome screen. Deleting the welcomeSeen guard must fail HERE.');
  assert.equal(shows(true, false, false, { welcomeStamped: false, total: 5 }), true,
    'unstamped welcome BUT the vault has data ⇒ welcomeSeen is TRUE via the `|| total > 0` arm. '
    + 'This row is the ONLY one that exercises that arm — a naive swap to '
    + 'readiness.onboarding.welcomeSeen (which is Boolean(welcome_shown_at) alone) fails here, '
    + 'and that swap would resurface the welcome backdrop on a populated vault.');

  // ⭐ AND THE RAIL MUST SAY SOMETHING. `railRendered` is satisfied by a bare <div>: at
  // (generated, ai, !channel) the rail shipped as a titled panel with one ticked step and no
  // action but × — it could not name what was missing, and this gate BLESSED it (review HIGH-1).
  // ⚠️ ASSERT THE ACTION. My first version matched /messenger/i against railText — which hits the
  // step's <span class="step-name">, rendered UNCONDITIONALLY. Deleting the actual CTA left this
  // GREEN: the gate written because "presence is not content" was satisfied by presence-of-a-word
  // (review MED-5). A step the user cannot act on is not a step.
  const act = (r) => (r.railButtons || []).filter((b) => b && b !== '×');
  const missingChannel = drive(true, true, false);
  assert.ok(act(missingChannel).some((b) => /messenger/i.test(b)),
    `generated + channel missing ⇒ the rail must offer a way to LINK one. Buttons: ${JSON.stringify(missingChannel.railButtons)}. `
    + 'Naming the gap without an action is the empty rail with extra words.');
  const missingAi = drive(true, false, true);
  assert.ok(act(missingAi).length > 0,
    `generated + AI missing ⇒ the rail must offer an action, not just a heading. Buttons: ${JSON.stringify(missingAi.railButtons)}`);
});

await t('X2. ⭐ the rail APPEARS in the session you generate — the poll must not gate on what it learns', () => {
  // ⚠️ X1 CANNOT SEE THIS, and that blindness shipped a HIGH. Every X1 row bakes `generated` at
  // MOUNT; the bug lives across TIME. `if (railVisible) refresh()` with railVisible requiring
  // `generated` means the ONLY code that can notice generated flipped was gated on it already
  // being true ⇒ import → generate → map appears → invite vanishes → NO RAIL, for the life of the
  // page. Design E2's own acceptance criterion — "generate with no AI ⇒ rail appears" — was FALSE
  // on the shipped component (independent review HIGH-3, 2026-07-16).
  //
  // It is map §5.1a verbatim with `generated` for `messageCount`: "only refresh() can learn that
  // messageCount changed … refresh() never runs again for the life of the page." On main the gate
  // was NEGATIVE (`!generated`, true at mount) so the deadlock was benign; inverting it made the
  // deadlock the default path. A guard matrix with no time dimension cannot catch that.
  const out = execFileSync('node', ['--conditions', 'browser', 'test/mount-onboarding-flow.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000,
    env: { ...process.env, FLIP_GENERATED: '1', AI: '0', CHANNEL: '0' },
  }).trim().split('\n').pop();
  const r = JSON.parse(out);
  assert.ok(r.ok, `the transition probe failed to mount: ${r.error || 'unknown'}`);
  assert.equal(r.railAtMount, false, 'sanity: ungenerated at mount ⇒ no rail (that is the invite\'s phase)');
  assert.ok(r.readsAfterPolls > 1,
    `the poll never ran again (${r.readsAfterPolls} read). It is gated on a fact only it can learn — `
    + 'poll on what does NOT move (!dismissed && welcomeSeen), never on `generated`.');
  assert.equal(r.railAfterPolls, true,
    'THE BUG: the server said generated=true and the rail never appeared. The user generates their '
    + 'map, the invite vanishes, and nothing tells them their AI is unconnected — until a reload. '
    + 'OnboardingFlow is in the persistent layout, so navigation cannot rescue it.');
});

await t('X3. ⭐ the mindscape slice SAYS when it could not count — like every sibling', async () => {
  // ⚠️ MY FIRST X3 TESTED NOTHING TWICE OVER. It drove a STUB that fabricated `unknown:true`, so
  // it never exercised readiness.js's catch — mutating that catch left it green. And it asserted
  // "unknown ⇒ rail hidden", which passes trivially because `generated` starts false at mount:
  // holding a false is indistinguishable from setting one. Both errors in one gate.
  // ⇒ Test the SLICE where the bug lives: a throwing count must report `unknown`, not fabricate
  // `generated:false`. This was the ONLY slice that fabricated a definite answer while the route
  // still 200'd, so every consumer read "I could not count" as "there is no map" (review HIGH-4).
  const db = {
    messages: {}, providers: { async list() { return []; } }, secrets: { async has() { return false; } },
    mindscape: { async getNoiseStats() { throw new Error('SQLITE_BUSY: database is locked'); } },
    async rawQuery() { return { results: [{}] }; },
  };
  const r = createReadiness({ db, userId: U });
  const { mindscape } = await r.get({ slices: ['mindscape'] });
  assert.equal(mindscape.unknown, true,
    'a failed point COUNT must say `unknown` — every sibling slice does (data/tags/evidence/'
    + 'onboarding). Fabricating `generated:false` tells the invite to render "Grow your mycelium" '
    + 'over a built 76k-message vault, and self-gates the rail\'s poll so it never recovers.');
  assert.equal(mindscape.generated, false, 'and it must not claim a map exists either — unknown is neither');
});

await t('X3b. ⭐ a KNOWN-true generated must survive a failed probe — holding ≠ setting', () => {
  // The client half. At mount `generated` is false, so "unknown ⇒ rail hidden" proves nothing —
  // it cannot tell holding-a-false from setting-one. Drive it in TIME: read 1 says generated,
  // read 2 fails. The rail must still be there.
  const out = execFileSync('node', ['--conditions', 'browser', 'test/mount-onboarding-flow.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000,
    env: { ...process.env, UNKNOWN_AFTER_FIRST_READ: '1', GENERATED: '1', AI: '0', CHANNEL: '0' },
  }).trim().split('\n').pop();
  const r = JSON.parse(out);
  assert.ok(r.ok, `mount failed: ${r.error || 'unknown'}`);
  assert.equal(r.railAtMount, true, 'sanity: the first read says generated ⇒ the rail is up');
  assert.equal(r.railAfterPolls, true,
    'a LATER probe returned `unknown` and the rail VANISHED — the transient was read as "your map '
    + 'is gone". Hold the last known answer; a failed count is not an empty vault (§3.2a).');
});


await t('C1. ⭐ a POLLED get() must cost O(1) DB touches — count EVERY call, not just secrets', async () => {
  // ⚠️ THIS GATE'S FIRST VERSION ASSERTED THE WRONG PROPERTY, and a reviewer proved it by doing
  // the SAME three full-table scans through `rawQuery` instead of `secrets.*` — C1 stayed GREEN,
  // cost fully intact. Worse, it was green while `mindscape`'s getNoiseStats FULL-SCANNED
  // clustering_points on every 4s tick, because C1 only counted the one namespace that burned me
  // last round. A cost gate scoped to yesterday's slice keeps passing over tomorrow's
  // (independent review MED-11, 2026-07-16).
  //
  // The property is not "secrets are cheap". It is: A POLLED get() MUST NOT PAY TWICE. Count
  // every DB touch — rawQuery, secrets, mindscape, providers — so the next uncached slice fails
  // here without anyone having to think of it. §3.8 specifies increment G's popover as POLLING
  // readiness; this is what protects it.
  let touches = [];
  const hit = (what) => touches.push(what);
  const db = {
    messages: {
      async embedBacklogCached() { hit('embedBacklogCached'); return { total: 1, embedded: 1, pending: 0, unprocessable: 0 }; },
      async categoriesBacklogCached() { hit('categoriesBacklogCached'); return { total: 1, tagged: 1, pending: 0 }; },
      async nlpBacklogCached() { hit('nlpBacklogCached'); return { done: 1, total: 1, pending: 0 }; },
    },
    users: { async getSettings() { hit('users.getSettings'); return { enrichProcessingPausedAt: null }; } },
    providers: { async list() { hit('providers.list'); return [{ id: 1, is_active: 1, label: 'x' }]; } },
    secrets: { async get() { hit('secrets.get'); return '1'; }, async has() { hit('secrets.has'); return true; } },
    mindscape: { async getNoiseStats() { hit('getNoiseStats'); return { total: 3 }; } },
    async rawQuery() { hit('rawQuery'); return { results: [{ welcome_shown_at: '2026-01-01' }] }; },
  };
  const r = createReadiness({ db, userId: U });
  // The UNION of everything any consumer polls, kept in lockstep with the consumers:
  //   • the rail @4s (OnboardingFlow.svelte SLICES): data,ai,channel,mindscape,onboarding
  //   • G's §3.8 popover @4s while open (StatusPopover.svelte POLL_SLICES):
  //     data,tags,processing,models,ai,mindscape,pipeline — the #211 reviewer note ("when G ships
  //     its popover poll, C1's POLLED list should gain processing in the same change"),
  //     discharged HERE, in the same change as the poll. `models`/`embedder` are in-memory
  //     health reads (zero DB — this gate proves it); `evidence` must NEVER join this list
  //     (opt-in, not pollable — E1). G-COST below pins the client half: the popover's poll
  //     URLs must buy exactly its declared set, so this union cannot silently under-cover.
  //   • ON-3: `pipeline` joins the poll (the vault-health pill rides it). It costs ZERO marginal
  //     scans — it re-CALLS embedBacklogCached / categoriesBacklogCached (the SWR memos `data`/
  //     `tags` already buy) and mindscape() (single-flight with the `mindscape` slice), so the
  //     only movement here is the two shared-backlog budgets tick from 2 → 3 (a third memo reader).
  const POLLED = ['data', 'ai', 'channel', 'mindscape', 'onboarding', 'tags', 'processing', 'models', 'pipeline'];

  await r.get({ slices: POLLED });
  assert.ok(touches.length > 0, 'fixture sanity: the first call must really hit the db');

  // The rail polls every 4s for the life of every session. Tick 2 must be free.
  // ⚠️ DENY-BY-DEFAULT WITH STATED REASONS, not "zero touches". Demanding zero would force a memo
  // in front of the SWR cache itself, which is absurd; demanding "no scans" needs a judgement the
  // gate cannot make. So: name what a repeat poll may cost, and WHY. Anything new fails until
  // someone either memoizes it or writes its reason down here — which is the review this gate is
  // standing in for. (E5 uses the same allowlist shape for columns.)
  // ⚠️ ALLOWLISTED BY NAME **AND COUNT**. Name-only was still evadable: a reviewer reproduced the
  // exact HIGH-5 cost by doing the same full-table SELECTs through `rawQuery` — which is on this
  // list as "a PK read" — and the gate stayed green. The list's REASON became false while its
  // NAME stayed true. A budget makes the reason enforceable: one PK read is one call; three is
  // somebody scanning.
  const ALLOWED_ON_REPEAT = {
    // max:3 — bought by `data`, by `processing.waiting`, AND by `pipeline` (ON-3). All three calls
    // land on ONE SWR memo in db/messages.js (8s/60s TTL, single-flight), so every CALL past the
    // first is zero scans in production — P-COST proves that with a faithful memo model; this
    // counts CALLS, and three memo readers is still one scan.
    embedBacklogCached: { max: 3, why: 'IS the SWR cache (§3.2b) — memoizing a cache is absurd; data + processing + pipeline share the one memo' },
    'categoriesBacklogCached': { max: 3, why: 'the same SWR-cache class — bought by tags AND processing.waiting AND pipeline, one memo beneath' },
    'nlpBacklogCached': { max: 1, why: 'the same SWR-cache class — processing.waiting only' },
    'users.getSettings': { max: 1, why: 'processing.pausedAt: SELECT settings FROM users WHERE id=? — ONE PK read (no in-memory pausedAt exists, by design)' },
    'providers.list': { max: 1, why: 'small, indexed table; a query, not a scan' },
    rawQuery: { max: 1, why: 'onboarding: SELECT welcome_shown_at FROM users WHERE id = ? — ONE PK read' },
  };

  touches = [];
  await r.get({ slices: POLLED });
  const counts = touches.reduce((a, x) => ({ ...a, [x]: (a[x] || 0) + 1 }), {});
  const unexpected = Object.entries(counts)
    .filter(([k, n]) => !(k in ALLOWED_ON_REPEAT) || n > ALLOWED_ON_REPEAT[k].max)
    .map(([k, n]) => `${k}×${n}`);
  assert.deepEqual(unexpected, [],
    `a repeat poll paid for ${JSON.stringify(unexpected)} — not on the allowlist. At 4s that is `
    + '~900/hour per user, forever, for surfaces that may never appear. `secrets.has()` DECRYPTS '
    + 'THE WHOLE TABLE in JS (§3.2c) and getNoiseStats FULL-SCANS clustering_points (no index '
    + 'covers `landscape_x IS NOT NULL`). Memoize in readiness.js so every consumer — including '
    + "G's popover — inherits it, rather than narrowing one caller.");
});


// ── P) processing (§3.2 D13) — the pause reminder's slice, G's precondition ────
// The slice §3.2's type declared and increment B never built (recorded four times). G's
// §3.8 popover renders the D13 reminder from it, so every P-gate stands in for the review
// that would otherwise only happen when G ships — and each is falsified by mutation.

await t('P1. processing = {paused,pausedAt,waiting} from seeded state — EXACT values', async () => {
  // The three counters return DISTINCT pendings and NO pair sums to the total (12+30=42,
  // 12+25=37, 30+25=55, all three = 67, no single = 67), so "waiting sums all THREE stages"
  // is a real assertion a one- or two-counter implementation cannot satisfy by coincidence.
  const db = mkDb();
  db.messages.embedBacklogCached = async () => ({ total: 100, embedded: 88, pending: 12, unprocessable: 0 });
  db.messages.categoriesBacklogCached = async () => ({ total: 100, tagged: 70, pending: 30 });
  db.messages.nlpBacklogCached = async () => ({ done: 40, total: 100, pending: 25 });
  db.users = { async getSettings() { return { enrichProcessingPaused: true, enrichProcessingPausedAt: '2026-07-17T08:30:00.000Z' }; } };
  const r = createReadiness({ db, userId: U, isProcessingPaused: () => true });
  const { processing } = await r.get({ slices: ['processing'] });
  assert.deepEqual(processing, { paused: true, pausedAt: '2026-07-17T08:30:00.000Z', waiting: 67 },
    'paused (live flag) + pausedAt (settings stamp) + waiting (embed 12 + categories 30 + nlp 25)');
});

await t("P2. a THROWING backlog counter ⇒ unknown:true, NEVER a fabricated waiting:0 (§3.2a)", async () => {
  const db = mkDb();
  db.messages.nlpBacklogCached = async () => { throw new Error('SQLCipher scan failed'); };
  db.users = { async getSettings() { return { enrichProcessingPausedAt: '2026-07-17T08:30:00.000Z' }; } };
  const r = createReadiness({ db, userId: U, isProcessingPaused: () => true });
  const { processing } = await r.get({ slices: ['processing'] });
  assert.equal(processing.unknown, true,
    'a count that threw must SAY unknown — a bare 0 would tell a paused user their vault is fully processed');
  // paused/pausedAt are computed BEFORE the counters and stay truthful through a count failure:
  assert.equal(processing.paused, true, 'a count failure does not erase the live pause flag');
  assert.equal(processing.pausedAt, '2026-07-17T08:30:00.000Z', 'nor the durable pausedAt');
});

await t('P3. pausedAt is HONEST — absent ⇒ null, a stamp ⇒ that stamp, a failed read ⇒ null (never fabricated)', async () => {
  const proc = async (settingsFn, paused) =>
    (await createReadiness({ db: Object.assign(mkDb(), { users: { getSettings: settingsFn } }), userId: U, isProcessingPaused: () => paused }).get({ slices: ['processing'] })).processing;
  // (a) resumed vault: persistPause writes pausedAt:null on resume
  assert.equal((await proc(async () => ({ enrichProcessingPaused: false, enrichProcessingPausedAt: null }), false)).pausedAt, null, 'pausedAt:null in settings ⇒ null');
  // (b) empty settings blob (fresh vault) ⇒ null, never invented
  assert.equal((await proc(async () => ({}), false)).pausedAt, null, 'no key at all ⇒ null');
  // (c) a real stamp ⇒ EXACTLY that stamp (the reminder shows the true paused-since time)
  const stamp = '2026-07-17T09:15:42.123Z';
  assert.equal((await proc(async () => ({ enrichProcessingPausedAt: stamp }), true)).pausedAt, stamp, 'a stamp ⇒ that stamp');
  // (d) a THROWING settings read ⇒ null (never "paused since now"), and paused stays truthful
  const d = await proc(async () => { throw new Error('settings read failed'); }, true);
  assert.equal(d.pausedAt, null, 'a failed settings read degrades to null, never a fabricated time');
  assert.equal(d.paused, true, 'paused comes from the live flag, so it survives a settings failure');
});

await t('P4. paused is the LIVE flag, NOT settings.enrichProcessingPaused', async () => {
  // settings says paused:false in BOTH cases; paused must follow the INJECTED flag, proving the
  // source is isEnrichProcessingPaused (drainer, live) and not the persisted settings mirror.
  const db = mkDb();
  db.users = { async getSettings() { return { enrichProcessingPaused: false, enrichProcessingPausedAt: null }; } };
  const on = (await createReadiness({ db, userId: U, isProcessingPaused: () => true }).get({ slices: ['processing'] })).processing;
  assert.equal(on.paused, true, 'live flag true ⇒ paused true, even though settings.enrichProcessingPaused is false');
  const off = (await createReadiness({ db, userId: U, isProcessingPaused: () => false }).get({ slices: ['processing'] })).processing;
  assert.equal(off.paused, false, 'live flag false ⇒ paused false');
});

await t('P5. the DEFAULT wiring reads the drainer module flag — no injection needed (§3.2 "no handle")', async () => {
  // Proves the production path: server-rest passes NO isProcessingPaused, so the default import
  // must track the live drainer flag. Flip the real module flag and watch readiness follow.
  const db = Object.assign(mkDb(), { users: { async getSettings() { return {}; } } });
  resumeEnrichProcessing();                         // ensure a clean baseline
  const r = createReadiness({ db, userId: U });     // ← no isProcessingPaused dep
  assert.equal((await r.get({ slices: ['processing'] })).processing.paused, false, 'default: clear flag ⇒ not paused');
  pauseEnrichProcessing();
  assert.equal((await r.get({ slices: ['processing'] })).processing.paused, true, 'default: flipping the drainer flag flips readiness — the import IS the wire');
  assert.equal(isEnrichProcessingPaused(), true, 'sanity: the module flag really is set');
  resumeEnrichProcessing();                         // ⚠️ restore global drainer state for any later reader
});

await t('P-COST. ⭐ a POLLED processing slice is O(1) on repeat — caches pay 0, settings is ONE PK read (C1)', async () => {
  // Model the SWR caches FAITHFULLY: db/messages.js memoizes them (8s/60s TTL, single-flight), so
  // a second poll within the window is ZERO scans even though the function is called again. The
  // doubles `hit()` only on a real recompute — counting CALLS instead of SCANS would be the C1 sin.
  let touches = [];
  const hit = (w) => touches.push(w);
  const cache = (label, val) => { let memo = null; return async () => { if (!memo) { hit(label); memo = val; } return memo; }; };
  const db = {
    messages: {
      embedBacklogCached: cache('scan:embed', { pending: 3 }),
      categoriesBacklogCached: cache('scan:categories', { pending: 5 }),
      nlpBacklogCached: cache('scan:nlp', { pending: 7 }),
    },
    users: { async getSettings() { hit('users.getSettings'); return { enrichProcessingPausedAt: null }; } },
  };
  const r = createReadiness({ db, userId: U, isProcessingPaused: () => false });
  await r.get({ slices: ['processing'] });
  assert.ok(touches.length > 0, 'fixture sanity: the first poll must really hit the db');

  // DENY-BY-DEFAULT, named AND counted (C1's earned shape). The three cache scans are ABSENT from
  // a warm repeat (max:0 implied by omission); getSettings is the one PK read processing legitimately
  // pays every tick — the same cost class as `onboarding`'s already-allowlisted users PK read.
  const ALLOWED_ON_REPEAT = {
    'users.getSettings': { max: 1, why: 'processing.pausedAt: SELECT settings FROM users WHERE id=? — ONE PK read; there is deliberately no in-memory pausedAt (drainer.js), so settings is the only source' },
  };
  touches = [];
  await r.get({ slices: ['processing'] });          // tick 2 — caches warm
  const counts = touches.reduce((a, x) => ({ ...a, [x]: (a[x] || 0) + 1 }), {});
  const unexpected = Object.entries(counts)
    .filter(([k, n]) => !(k in ALLOWED_ON_REPEAT) || n > ALLOWED_ON_REPEAT[k].max)
    .map(([k, n]) => `${k}×${n}`);
  assert.deepEqual(unexpected, [],
    `a repeat processing poll paid for ${JSON.stringify(unexpected)} — not on the allowlist. G's popover `
    + 'polls this; a re-scan here is a multi-second full-table SQLCipher decrypt every tick, forever.');
  // Prove the caches were genuinely WARM (0 re-scans) — not that the gate simply forgot to look:
  assert.equal(counts['scan:embed'], undefined, 'embed backlog re-scanned on a warm poll — waiting must ride the CACHE');
  assert.equal(counts['scan:nlp'], undefined, 'nlp backlog re-scanned on a warm poll — waiting must ride the CACHE');
});

await t('P-AICH. a THROWING ai/channel read ⇒ unknown:true, not a bare connected:false (#208 reviewer)', async () => {
  // ai: providers.list throws ⇒ unknown, still connected:false (fail-closed on the gate)
  const dbAi = Object.assign(mkDb(), { providers: { async list() { throw new Error('providers read failed'); } } });
  const ai = (await createReadiness({ db: dbAi, userId: U }).get({ slices: ['ai'] })).ai;
  assert.equal(ai.connected, false, 'fail-closed: a throw is not "connected"');
  assert.equal(ai.unknown, true, 'a throw is NOT "no AI connected" — a blip must not light the connect-AI rail over a configured vault');
  // channel: a throwing secrets decrypt ⇒ unknown, still connected:false
  const dbCh = Object.assign(mkDb(), { secrets: { async get() { return '1'; }, async has() { throw new Error('decrypt loop failed'); } } });
  const ch = (await createReadiness({ db: dbCh, userId: U }).get({ slices: ['channel'] })).channel;
  assert.equal(ch.connected, false, 'fail-closed');
  assert.equal(ch.unknown, true, 'a throwing secrets decrypt (§3.2c) is not "no channel configured"');
  // CONTROL — the HAPPY paths must NOT carry unknown (the fix adds it ONLY on error, never blanket)
  const okAi = (await createReadiness({ db: mkDb(), userId: U }).get({ slices: ['ai'] })).ai;
  assert.equal(okAi.unknown, undefined, 'a healthy ai read carries no unknown marker');
  const okCh = (await createReadiness({ db: mkDb(), userId: U }).get({ slices: ['channel'] })).channel;
  assert.equal(okCh.unknown, undefined, 'a healthy channel read carries no unknown marker');
});


// ── G) §3.8 — the Header status popover (increment G; absorbs R4 + R5) ─────────
// Every G-gate runs the REAL StatusPopover.svelte through the mount harness
// (portal-app/test/mount-status-popover.mjs) — rendering proven by MOUNTING, never by
// grepping ({#if false && …} keeps every string; only a mount sees the silence — #194).
// G2 is the CONTROL RUN for the whole family: the same needles asserted PRESENT in G1
// are asserted ABSENT there while the surrounding rows still render — so a check that
// reds every real render (the -webkit-text-fill-color class) and a check that greens
// everything are both caught.

function mountPopover(env) {
  const out = execFileSync('node', ['--conditions', 'browser', 'test/mount-status-popover.mjs'], {
    cwd: 'portal-app', encoding: 'utf8', timeout: 120000,
    env: { ...process.env, ...env },
  }).trim().split('\n').pop();
  const r = JSON.parse(out);
  assert.ok(r.ok, `mount failed: ${r.error || 'unknown'}`);
  return r;
}

await t('G1. the D13 Processing row: paused ⇒ "Paused by you — N waiting" + Resume, MOUNTED and VISIBLE', async () => {
  const r = mountPopover({ PAUSED: '1', KEEPAWAKE: '1', ONBATT: '1', CLICK_RESUME: '1' });
  assert.ok(r.pausedRow.present && r.pausedRow.visible, 'the paused reminder must be on screen (present+visible)');
  assert.ok(r.waitingCount.present && r.waitingCount.visible, 'with the COUNT — "12,431 messages waiting" (D13: "also showing how much")');
  assert.ok(r.statusButtons.includes('Resume'), `the row must OFFER the restart — buttons seen: ${JSON.stringify(r.statusButtons)}`);
  // The whole §3.8 row set, each mounted and visible (n≥2 against a vacuous fixture):
  for (const [k, why] of [
    ['vaultRow', 'Vault: Encrypted · open'],
    ['dataRow', 'Data: counts + sources + years'],
    ['labelingRow', 'Labeling: Sorting · tagged/total · model'],
    ['aiRow', 'Intelligence: provider · connected'],
    ['mindscapeRow', 'Mindscape: Generated · points'],
    ['unprocessableRow', 'the honest gap: N couldn’t be processed'],
  ]) {
    assert.ok(r[k].present && r[k].visible, `${why} must render (got ${JSON.stringify(r[k])})`);
  }
  // R5 — the on-AC/keep-awake truth (detectOnAC through GET /system/keep-awake):
  assert.ok(r.keepAwakeLine.present && r.keepAwakeLine.visible, '"Keeping your Mac awake" renders while the assertion is active');
  assert.ok(r.onBattLine.present && r.onBattLine.visible, '"On battery" renders when onAC === false');
  assert.ok(r.wontUpdateLine.present && r.wontUpdateLine.visible, 'Mindscape: "Won’t update while processing is paused" (§3.8)');
  // The control is a CONTROL: clicking Resume must actually fire the route and clear the row.
  assert.equal(r.resumePosts, 1, 'Resume must POST /portal/enrichment/processing/resume exactly once');
  assert.equal(r.pausedRowAfterResume.present, false, 'after a successful resume + refresh, the reminder clears');
});

await t('G2. CONTROL — an unpaused, AC-unknown vault shows NONE of the paused/battery strings (and still renders)', async () => {
  const r = mountPopover({});
  assert.equal(r.pausedRow.present, false, 'no "Paused by you" on an unpaused vault');
  assert.ok(!r.statusButtons.includes('Resume'), 'no Resume control in the status rows when nothing is paused');
  assert.equal(r.keepAwakeLine.present, false, 'keep-awake inactive ⇒ no awake line');
  assert.equal(r.onBattLine.present, false, 'onAC:null is an ABSENCE (unknown), never rendered as a battery state');
  assert.equal(r.wontUpdateLine.present, false, 'no paused-consequence line when not paused');
  // …while the surrounding rows DO render — proves the control mounts real content, so the
  // absences above are earned, not a blank screen agreeing with everything:
  assert.ok(r.dataRow.visible && r.aiRow.visible && r.mindscapeRow.visible, 'the healthy rows still render in the control');
});

await t('G3. §3.2a — a degraded poll HOLDS the last known answers; no fabricated zeros, ever', async () => {
  // First read healthy, every later read unknown-degraded (waiting:0+unknown, ai unknown,
  // mindscape unknown, canGenerate 'unknown'). ≥3 polls tick. The §3.2a lie under test:
  // rendering the degraded 0 ("0 messages waiting" / "No data yet" / losing the map).
  const r = mountPopover({ PAUSED: '1', UNKNOWN_AFTER_FIRST: '1' });
  assert.ok(r.readinessPollUrls.length >= 3, `sanity: the poll must have ticked (saw ${r.readinessPollUrls.length} readiness reads) — otherwise the degraded responses never arrived and this gate is vacuous`);
  assert.ok(r.waitingCountAfter.present && r.waitingCountAfter.visible, 'the waiting count HOLDS at 12,431 through unknown polls — a failed count is not an empty queue');
  assert.equal(r.zeroWaiting, false, '"0 messages waiting" must never render off a degraded count');
  assert.ok(r.aiRowAfter.present && r.aiRowAfter.visible, 'a providers-read blip must not regress "Claude · connected" to "No AI connected"');
  assert.ok(r.mindscapeRowAfter.present && r.mindscapeRowAfter.visible, 'a mindscape-count blip must not un-generate the map on screen');
  assert.ok(r.dataRowAfter.present && r.dataRowAfter.visible, 'a data-count blip must not tell a full vault it has no messages');
});

await t('G3b. §3.2a — a count that was NEVER known renders NO number: "Paused by you" with no fabricated 0', async () => {
  // EVERY read is degraded (waiting:0 + unknown:true) — there is no last-known count to
  // hold. The row must still say "Paused by you" (paused is a live fact, never unknown)
  // but the number is a claim we did not earn: neither "0 messages waiting" nor any count.
  const r = mountPopover({ PAUSED: '1', UNKNOWN_ALWAYS: '1' });
  assert.ok(r.pausedRow.present && r.pausedRow.visible, 'the paused reminder still renders — the pause is real even when the count is not');
  assert.equal(r.zeroWaiting, false, 'a 0 we never counted must not render');
  assert.equal(r.waitingCount.present, false, 'no waiting count at all — absence, not fabrication');
  assert.equal(r.waitingCountAfter.present, false, 'and none appears after more degraded ticks');
});

await t('G4. R4 (recorded decision) — the FEED row owns pull progress: bytes as GB there, NO second percent in the status rows', async () => {
  const r = mountPopover({ MODELPULL: '1' });
  assert.ok(r.pullBytes.present && r.pullBytes.visible, 'the model-pull feed row renders "1.2 GB / 3.4 GB" (fmtBytes — not raw byte counts)');
  assert.equal(r.pullRawBytes, false, 'ten-digit raw byte counts must not reach the screen');
  assert.ok(r.downloadingState.present && r.downloadingState.visible, 'the Labeling status row STATES the downloading state (the drainer’s constant)');
  assert.equal(r.statusHasPct, false, 'and carries NO percent — one signal, one owner (the feed row); duplicating it is the drift class §3.2 ends');
});

await t('G4b. a FAILED model-pull row points at where the reason lives — and ONLY that row (issue #2)', async () => {
  // The feed row is content-free by contract (activity-feed.js §SECURITY): a failed download can
  // only say "Failed", a dead end. The affordance points the owner at the classified reason on the
  // model status rows above. The fixture carries TWO error rows — a model-pull AND an import — so
  // this proves the pointer is SCOPED to the dead-end (model-pull) case, not slapped on every error.
  const r = mountPopover({ MODELPULL_FAILED: '1' });
  assert.ok(r.recentErrorRows, 'sanity: the recent feed must render the failed rows (else this gate is vacuous)');
  assert.ok(r.pullFailedAffordance.present && r.pullFailedAffordance.visible,
    'the failed model-pull row must carry a pointer to where the reason lives (mounted + visible)');
  // The CONTROL: exactly ONE hint. The import error is ALSO status:error but is not a dead end
  // (it has its own surface), so it must get no pointer. A count of 2 would mean the affordance
  // keyed on `status:error` alone; 0 means it never rendered. Only 1 is correct.
  assert.equal(r.affordanceCount, 1,
    `exactly one hint — the model-pull error only, never the import error too: got ${r.affordanceCount}`);
});

await t('G-COST. the popover poll buys EXACTLY its declared slices; evidence + keep-awake are once-per-open (never per tick)', async () => {
  // The client half of C1's contract: C1 prices the slice set server-side; this pins the
  // popover to that set. A slice added to the poll without joining C1's POLLED list fails
  // HERE; `evidence` on the poll (E1's forbidden case) fails here too.
  const r = mountPopover({ PAUSED: '1', UNKNOWN_AFTER_FIRST: '1' });
  const WANT = ['data', 'tags', 'processing', 'models', 'ai', 'mindscape', 'pipeline'].sort().join(',');
  assert.ok(r.readinessPollUrls.length >= 3, 'sanity: the poll ticked');
  for (const u of r.readinessPollUrls) {
    const got = (u.split('slices=')[1] || '').split(',').map((s) => s.trim()).filter(Boolean).sort().join(',');
    assert.equal(got, WANT, `every poll tick buys exactly the C1-priced set — got "${got}" from ${u}`);
  }
  assert.equal(r.evidenceFetches, 1, 'evidence: ONCE per open (three unindexed aggregates — a user gesture, never a tick)');
  assert.equal(r.keepAwakeFetches, 1, 'keep-awake: ONCE per open (it runs the pmset subprocess — R5’s cost note)');
});

await t('G-AC. R5 — detectOnAC is EXPORTED from portal-system.js (reuse, not copy) and answers boolean-or-null', async () => {
  const mod = await import('../src/portal-system.js');
  assert.equal(typeof mod.detectOnAC, 'function', 'detectOnAC must be a named export — the probe was module-private, which is what breeds a second pmset parser');
  const v = await mod.detectOnAC();
  assert.ok(v === null || typeof v === 'boolean', `detectOnAC resolves boolean (macOS) or null (unknown/non-macOS) — got ${JSON.stringify(v)}; it must never throw and never fabricate a power state`);
});


// ── ON-3) the adaptive vault-health pill (QA-LEDGER §"ON-3 locked design") ─────
// The pipeline stage machine, relocated out of onboarding into THIS activity bar as one pill:
// quiet when fine, loud only on error, expanding to the shipped PipelineStatus. Proven by
// MOUNTING the real StatusPopover (the pill lives in it) — the same mount discipline as the
// G-family, driving the `pipeline` slice fixture the popover now polls.
await t('ON-3a. healthy ⇒ "● Vault · all green", QUIET — no persistent stage count (the locked design)', async () => {
  const r = mountPopover({ PIPELINE: 'done' });
  assert.equal(r.pillState, 'healthy', `a done pipeline reads healthy — got "${r.pillState}"`);
  assert.ok(r.pillVisible && /Vault/.test(r.pillText) && /all green/.test(r.pillText),
    `the calm pill must render "Vault · all green" — got "${r.pillText}"`);
  // ⭐ THE locked requirement: NO count when fine. A digit here is the persistent stage count
  // ON-3 deletes ("quiet when fine, loud only when it matters").
  assert.equal(r.pillHasDigits, false,
    `the healthy pill must carry NO count — a digit is the persistent stage count ON-3 removes: "${r.pillText}"`);
  // It is the SUMMARY, above/outside the per-service status rows (not another row).
  assert.equal(r.pillOutsideStatusRows, true, 'the pill is the summary — it sits outside the status rows');
  // Quiet = collapsed: the heavy PipelineStatus detail is NOT mounted until asked.
  assert.equal(r.pillDetailBeforeClick, false, 'the detail must be collapsed until the pill is clicked');
});

await t('ON-3b. working ⇒ "◐ Mapping… <stage> <done>/<total>" — the live running stage + its counts', async () => {
  const r = mountPopover({ PIPELINE: 'working' });
  assert.equal(r.pillState, 'working', `a running pipeline reads working — got "${r.pillState}"`);
  assert.ok(/Mapping/.test(r.pillText) && /embed/.test(r.pillText),
    `the working pill names the running stage — got "${r.pillText}"`);
  // The live per-stage progress: the fixture embeds 812 / 1204 (localised), so the counts must show.
  assert.ok(/812/.test(r.pillText) && /1,?204/.test(r.pillText),
    `the working pill shows the running stage's live counts — got "${r.pillText}"`);
});

await t('ON-3c. ⭐ error ⇒ "▲ N stage(s) need attention" and clicking EXPANDS the real PipelineStatus + inline remedy', async () => {
  const r = mountPopover({ PIPELINE: 'error' });
  assert.equal(r.pillState, 'error', `a blocked/error pipeline reads error — got "${r.pillState}"`);
  assert.ok(/needs? attention/.test(r.pillText), `the error pill names the attention count — got "${r.pillText}"`);
  assert.ok(/\b1\b/.test(r.pillText), `one blocked stage ⇒ "1 stage needs attention" — got "${r.pillText}"`);
  // ⭐ Clicking expands the SHIPPED component, not a re-derivation: the .pipe root, the ordered
  // six-stage machine, AND the inline remedy button (blocked no_model ⇒ "Approve a labeling model").
  assert.equal(r.pillDetailAfterClick, true, 'clicking the pill must mount the expanded detail');
  assert.equal(r.pillDetailHasPipeRoot, true,
    'the expanded detail must be the REAL PipelineStatus (its .pipe root), never a hand-rolled list');
  assert.deepEqual(r.pillDetailStageKeys, ['import', 'embed', 'categorize', 'cluster', 'describe', 'measure'],
    `the expanded detail renders the ordered stage machine — got ${JSON.stringify(r.pillDetailStageKeys)}`);
  assert.equal(r.pillDetailHasRemedy, true,
    'a blocked stage in the expanded detail must carry its inline remedy button (the whole point of expanding on error)');
  // ⭐ COST: expanding is a pure subscribe to the already-fed store — it must add ZERO fetches.
  assert.equal(r.expandAddedFetches, 0,
    'expanding the pill fired a network read — the detail rides the store refresh() already fed, never its own fetch');
});

await t('ON-3d. the CONTROL — an unknown-always pipeline reads the QUIET pill, never a fabricated state', async () => {
  // §3.2a on the pill: before any good read (or a slice that fails every time) the pill must not
  // impersonate healthy/working/error. It reads the neutral "checking" state. This is the control
  // that stops ON-3a's "no digits" from passing simply because the pill rendered nothing.
  const r = mountPopover({ PIPELINE: 'done', UNKNOWN_ALWAYS: '1' });
  assert.equal(r.pillState, 'quiet', `an all-unknown pipeline must read the neutral pill — got "${r.pillState}"`);
  assert.ok(/Vault/.test(r.pillText), `even quiet, the pill still says what it is — got "${r.pillText}"`);
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — one readiness model: sliced (evidence opt-in), fail-closed, leak-free, threshold encoded once' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
