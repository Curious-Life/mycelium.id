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
import assert from 'node:assert/strict';
import express from 'express';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createReadiness } from '../src/readiness.js';
import { portalCompatRouter } from '../src/portal-compat.js';

// The slice list R5 must sweep. Kept HERE, next to the gate that depends on it, because the
// module's own ALL is private — and because R5's job is to name the surface explicitly.
const ALL_SLICES = ['data', 'tags', 'embedder', 'models', 'ai', 'channel', 'mindscape', 'onboarding'];

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
    },
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


const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — one readiness model: sliced (evidence opt-in), fail-closed, leak-free, threshold encoded once' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
