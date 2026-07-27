// verify:enrich-resilience — the enrich drainer's per-row failure handling, the
// fix for the "5,292 stuck / 2,380 wrongly-poisoned / 19 empty pending" backlog,
// EXTENDED (2026-07-18) with the bounded, outage-safe retry semantics: a
// transiently-failing row is no longer pending FOREVER — it gets a counted,
// progress-aware attempt budget (EMBED_MAX_ATTEMPTS) with a longer-timeout
// rescue, then a RECOVERABLE terminal mark ('embed-capped:N'). Same matrix for
// the L1 categorize path (LABEL_MAX_ATTEMPTS → categories_processed = -1).
//
// Sections:
//   E*  drainOnce row states (empty→skip, transient→bounded retry, wrong-dim→
//       poison, valid→embed) — stub embedder + in-memory messages
//   R*  rescue: the per-row retry passes a LONGER timeout VALUE (asserted on the
//       stub), and a global outage never moves a counter
//   S*  the drainer's REAL self-heal + boot-reclaim statements against a REAL
//       better-sqlite3 vault (real migrations — the bug class is the SQL)
//   T*  retry-failed: resetEnrichmentGiveUps re-queues capped + label-gave-up
//       rows and clears every marker, and a re-drain then re-embeds them
//   C*  categorize cap matrix: progress-aware counting, terminal at K, outage
//       counts nothing, a gave-up row does not wedge the batch
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { createEnrichmentService, EMBED_MAX_ATTEMPTS, EMBED_CAPPED_MARK, EMBED_RETRY_MARK, EMBED_RESCUE_TIMEOUT_MS, LABEL_MAX_ATTEMPTS, embedAttemptsOf } from '../src/enrich/service.js';
import { selfHealStrandedEmbeds, reclaimGaveUpRows } from '../src/enrich/drainer.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createMessagesNamespace } from '../src/db/messages.js';
import { loadKey } from '../src/crypto/keys.js';
import { EMBED_DIM } from '../src/embed/client.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const masterKey = await loadKey(crypto.randomBytes(32).toString('hex'));

// ── In-memory messages namespace (drives drainOnce as a pure unit) ───────────
function memMessages(rows) {
  const store = new Map(rows.map((r) => [r.id, { nlp_error: null, embedding_768: null, ...r }]));
  return {
    _store: store,
    async selectPendingEnrichment() {
      // mirror the real SELECT: pending rows ride with their nlp_error marker
      return [...store.values()].filter((r) => r.nlp_processed === 0)
        .map((r) => ({ id: r.id, content: r.content, scope: r.scope, nlp_error: r.nlp_error }));
    },
    async updateEnrichment(id, _userId, patch) {
      const r = store.get(id); if (!r) return;
      if (patch.nlpProcessed !== undefined) r.nlp_processed = patch.nlpProcessed;
      if (patch.embedding768 !== undefined) r.embedding_768 = patch.embedding768;
      // mirror messages.js updateEnrichment: nlp_error is ALWAYS set (default null)
      r.nlp_error = patch.nlpError ?? null;
    },
    async selectPendingNlp() { return []; },
    async updateNlp() {},
  };
}
const VALID = () => Array.from({ length: EMBED_DIM }, () => 0.01);

// ── E: the four row states in one drain ──────────────────────────────────────
{
  const messages = memMessages([
    { id: 'empty',     content: '   ',                                 scope: 'personal', nlp_processed: 0 },
    { id: 'transient', content: 'a transient row about minds',         scope: 'personal', nlp_processed: 0 },
    { id: 'wrongdim',  content: 'a wrongdim row about minds',          scope: 'personal', nlp_processed: 0 },
    { id: 'valid',     content: 'a valid row about minds and forests', scope: 'personal', nlp_processed: 0 },
  ]);
  // Per-row .embed only → exercises the null/wrong-dim path (no embedBatch).
  const embed = {
    async embed(content) {
      if (!content || !content.trim()) return null;
      if (/transient/.test(content)) return null;              // transient failure → null vector
      if (/wrongdim/.test(content)) return [1, 2, 3];          // genuine wrong-size array
      return VALID();
    },
  };
  const svc = createEnrichmentService({ messages, embed, getMasterKey: async () => masterKey });
  const res = await svc.drainOnce({ userId: 'u' });
  const g = (id) => messages._store.get(id);

  rec('E1. empty content → SKIPPED (nlp_processed=1), no embedding, no error',
    g('empty').nlp_processed === 1 && g('empty').embedding_768 === null && g('empty').nlp_error === null,
    `state=${g('empty').nlp_processed}`);
  // REVISED (bounded retry): the pass embedded another row, so the service is
  // provably up and the transient failure now COUNTS — but the row stays PENDING
  // with the retry marker until the budget is spent. Never silently forever.
  rec(`E2. transient null vec + progress → still PENDING with '${EMBED_RETRY_MARK}:1' (counted, not poisoned)`,
    g('transient').nlp_processed === 0 && g('transient').nlp_error === `${EMBED_RETRY_MARK}:1`,
    `state=${g('transient').nlp_processed} err=${g('transient').nlp_error}`);
  rec('E3. genuine wrong-dim → POISONED (nlp_processed=-1, "expected 768")',
    g('wrongdim').nlp_processed === -1 && /expected 768/.test(g('wrongdim').nlp_error || ''),
    `state=${g('wrongdim').nlp_processed} err=${(g('wrongdim').nlp_error || '').slice(0, 40)}`);
  rec('E4. valid 768 vector → EMBEDDED (nlp_processed=2, embedding768 raw BLOB set)',
    g('valid').nlp_processed === 2 && Buffer.isBuffer(g('valid').embedding_768) && g('valid').embedding_768.length === 768 * 4,
    `state=${g('valid').nlp_processed} len=${g('valid').embedding_768?.length}`);
  rec('E5. no transient row carries "object dims" (the string the old self-heal skipped forever)',
    !/object/.test(g('transient').nlp_error || '') && !/object/.test(g('wrongdim').nlp_error || ''),
    `counts=${JSON.stringify(res)}`);

  // E6: run the remaining cycles — the transient row must stay pending for the
  // counted attempts below the cap, then go TERMINAL exactly at EMBED_MAX_ATTEMPTS.
  let capReported = 0;
  let sawPendingBelowCap = true;
  for (let n = 2; n <= EMBED_MAX_ATTEMPTS; n++) {
    const e = await svc.drainOnce({ userId: 'u' });          // each call = its own cycle
    capReported += e?.capped ?? 0;
    if (n < EMBED_MAX_ATTEMPTS) {
      sawPendingBelowCap = sawPendingBelowCap
        && g('transient').nlp_processed === 0
        && g('transient').nlp_error === `${EMBED_RETRY_MARK}:${n}`;
    }
  }
  rec(`E6a. below the cap the row STAYS PENDING with a rising counted marker (<${EMBED_MAX_ATTEMPTS} attempts)`,
    sawPendingBelowCap, `final=${g('transient').nlp_error}`);
  rec(`E6b. at attempt ${EMBED_MAX_ATTEMPTS} the row goes TERMINAL '${EMBED_CAPPED_MARK}:${EMBED_MAX_ATTEMPTS}' and leaves the backlog`,
    g('transient').nlp_processed === -1 && g('transient').nlp_error === `${EMBED_CAPPED_MARK}:${EMBED_MAX_ATTEMPTS}`,
    `state=${g('transient').nlp_processed} err=${g('transient').nlp_error}`);
  rec('E6c. capping is REPORTED by drainOnce (never silent)', capReported === 1, `capped=${capReported}`);
  rec('E6d. lone-repeat-failer counting: a SOLE-candidate row that keeps failing against an otherwise-up service still caps, even with no other progress this pass',
    embedAttemptsOf(g('transient').nlp_error) === EMBED_MAX_ATTEMPTS);
}

// ── R: rescue timeout VALUE + global-outage immunity ─────────────────────────
{
  // R1: the last-chance rescue must pass a LONGER per-call timeout — assert the
  // VALUE the stub receives, not merely that a call happened.
  const messages = memMessages([
    { id: 'slow',    content: 'slow but valid', scope: 'p', nlp_processed: 0 },
    { id: 'healthy', content: 'healthy sibling', scope: 'p', nlp_processed: 0 },
  ]);
  const seenTimeouts = [];
  const embed = {
    async embedBatch(texts) { return texts.map((t) => (t === 'slow but valid' ? null : VALID())); },
    async embed(t, _task, opts) {
      if (t !== 'slow but valid') return VALID();
      seenTimeouts.push(opts?.timeoutMs ?? null);
      return opts?.timeoutMs === EMBED_RESCUE_TIMEOUT_MS ? VALID() : null;
    },
  };
  const svc = createEnrichmentService({ messages, embed, getMasterKey: async () => masterKey });
  await svc.drainOnce({ userId: 'u' });
  rec(`R1. the rescue retry passes timeoutMs=${EMBED_RESCUE_TIMEOUT_MS} (the VALUE, asserted on the stub)`,
    seenTimeouts.includes(EMBED_RESCUE_TIMEOUT_MS), `seen=${JSON.stringify(seenTimeouts)}`);
  rec('R2. a slow-but-valid row is RESCUED by the longer budget, never retired',
    messages._store.get('slow').nlp_processed === 2 && messages._store.get('slow').embedding_768 != null,
    `state=${messages._store.get('slow').nlp_processed}`);

  // R3: GLOBAL OUTAGE — every embed fails ⇒ no counter moves, no rescue fires,
  // nothing is ever retired, however many cycles pass.
  const outMsgs = memMessages([
    { id: 'a', content: 'row a', scope: 'p', nlp_processed: 0 },
    { id: 'b', content: 'row b', scope: 'p', nlp_processed: 0 },
  ]);
  let rescueCalls = 0;
  const deadEmbed = {
    async embedBatch(texts) { return texts.map(() => null); },
    async embed(_t, _task, opts) { if (opts?.timeoutMs) rescueCalls++; return null; },
  };
  const outSvc = createEnrichmentService({ messages: outMsgs, embed: deadEmbed, getMasterKey: async () => masterKey });
  for (let i = 0; i < EMBED_MAX_ATTEMPTS * 3; i++) await outSvc.drainOnce({ userId: 'u' });
  const outStates = [...outMsgs._store.values()];
  rec('R3a. a total outage NEVER increments a counter — every row still pending, no markers',
    outStates.every((r) => r.nlp_processed === 0 && r.nlp_error === null),
    outStates.map((r) => `${r.id}:${r.nlp_processed}/${r.nlp_error}`).join(' '));
  rec('R3b. …and the outage never triggers the long-timeout rescue (no 120s hammering while down)',
    rescueCalls === 0, `rescueCalls=${rescueCalls}`);

  // R4: ONE attempt per drainer cycle — the same Set across many passes must
  // count at most one attempt however often the row is re-selected.
  const cycMsgs = memMessages([
    { id: 'bad', content: 'never embeds', scope: 'p', nlp_processed: 0 },
    { id: 'ok', content: 'fine', scope: 'p', nlp_processed: 0 },
  ]);
  const cycEmbed = {
    async embedBatch(texts) { return texts.map((t) => (t === 'never embeds' ? null : VALID())); },
    async embed(t) { return t === 'never embeds' ? null : VALID(); },
  };
  const cycSvc = createEnrichmentService({ messages: cycMsgs, embed: cycEmbed, getMasterKey: async () => masterKey });
  const attemptedThisCycle = new Set();
  for (let i = 0; i < 10; i++) await cycSvc.drainOnce({ userId: 'u', attemptedThisCycle });
  rec('R4. one CYCLE = at most ONE counted attempt (the shared attemptedThisCycle budget)',
    embedAttemptsOf(cycMsgs._store.get('bad').nlp_error) === 1 && cycMsgs._store.get('bad').nlp_processed === 0,
    `err=${cycMsgs._store.get('bad').nlp_error}`);

  // R5: MASS-LOSS GUARD (the 2026-07-18 MEDIUM fix). The degrade-then-die vector: a
  // backlog where rows ALREADY carry 'embed-retry:N' plus fresh rows, then the embed
  // service dies for EVERYONE. A prior-marked row must NOT advance its counter just
  // because it is prior-suspect — an outage with MORE THAN ONE candidate may cap
  // NOTHING. (Pre-fix `suspect = embedded > 0 || t.prior > 0` marched 'marked' to
  // 'embed-capped:5' in ~4 cycles here; this asserts it survives at :2.)
  const massMsgs = memMessages([
    { id: 'marked', content: 'already at retry two', scope: 'p', nlp_processed: 0, nlp_error: `${EMBED_RETRY_MARK}:2` },
    { id: 'fresh',  content: 'fresh pending row',    scope: 'p', nlp_processed: 0 },
  ]);
  const deadEmbed2 = {
    async embedBatch(texts) { return texts.map(() => null); },
    async embed() { return null; },
  };
  const massSvc = createEnrichmentService({ messages: massMsgs, embed: deadEmbed2, getMasterKey: async () => masterKey });
  for (let i = 0; i < EMBED_MAX_ATTEMPTS * 3; i++) await massSvc.drainOnce({ userId: 'u' });
  const marked = massMsgs._store.get('marked');
  const fresh = massMsgs._store.get('fresh');
  rec(`R5a. a prior-marked row ('${EMBED_RETRY_MARK}:2') does NOT advance its counter during a total outage with another candidate present — still PENDING at :2`,
    marked.nlp_processed === 0 && embedAttemptsOf(marked.nlp_error) === 2,
    `state=${marked.nlp_processed} err=${marked.nlp_error}`);
  rec('R5b. …and the outage NEVER caps the prior-marked row (the mass-loss vector stays shut)',
    marked.nlp_processed !== -1 && marked.nlp_error !== `${EMBED_CAPPED_MARK}:${EMBED_MAX_ATTEMPTS}`,
    `err=${marked.nlp_error}`);
  rec('R5c. the fresh sibling likewise survives the outage untouched (pending, no marker)',
    fresh.nlp_processed === 0 && fresh.nlp_error === null,
    `state=${fresh.nlp_processed} err=${fresh.nlp_error}`);
}

// ── S/T: the REAL SQL against a REAL vault (migrations + DAL, no mocks) ──────
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
  // the drainer helpers take the app's db handle shape ({ rawQuery })
  const db = { rawQuery: d1Query, messages };
  return { raw, db, messages };
}
const U = 'u1';
let seq = 0;
function addRow(raw, { content, nlp = 0, vec = null, nlpError = null, cats = 0 }) {
  const id = `m${++seq}`;
  raw.prepare(
    `INSERT INTO messages (id, user_id, role, content, nlp_processed, nlp_error, embedding_768, categories_processed, created_at)
     VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?)`,
  ).run(id, U, content, nlp, nlpError, vec, cats, `2026-07-18T00:00:${String(seq % 60).padStart(2, '0')}.000Z`);
  return id;
}

{
  const { raw, db } = freshVault();
  const cappedId = addRow(raw, { content: 'capped', nlp: -1, nlpError: `${EMBED_CAPPED_MARK}:5` });
  const strandedId = addRow(raw, { content: 'genuinely stranded', nlp: -1, nlpError: 'embed-service unreachable' });
  const nullErrId = addRow(raw, { content: 'stranded no error', nlp: -1, nlpError: null });
  await selfHealStrandedEmbeds(db, U);
  const st = (id) => raw.prepare('SELECT nlp_processed, nlp_error FROM messages WHERE id = ?').get(id);
  rec('S1. self-heal does NOT reclaim an attempt-capped row (terminal-persistence — pending can settle)',
    st(cappedId).nlp_processed === -1 && st(cappedId).nlp_error === `${EMBED_CAPPED_MARK}:5`,
    `state=${st(cappedId).nlp_processed} err=${st(cappedId).nlp_error}`);
  rec('S2. self-heal DOES still reclaim a genuine stranded -1/null-embedding row (error string)',
    st(strandedId).nlp_processed === 0 && st(strandedId).nlp_error === null);
  rec('S3. self-heal DOES still reclaim a stranded -1 row with NULL nlp_error',
    st(nullErrId).nlp_processed === 0);

  // S4: boot reclaim — capped rows AND label-gave-up rows get one fresh chance.
  const labelGaveUpId = addRow(raw, { content: 'label gave up', nlp: 2, vec: Buffer.alloc(8), cats: -1 });
  await reclaimGaveUpRows(db, U);
  rec('S4a. boot reclaim re-queues the capped row with a CLEARED counter',
    st(cappedId).nlp_processed === 0 && st(cappedId).nlp_error === null,
    `state=${st(cappedId).nlp_processed} err=${st(cappedId).nlp_error}`);
  rec('S4b. boot reclaim re-queues a label-gave-up row (categories_processed -1 → 0)',
    raw.prepare('SELECT categories_processed FROM messages WHERE id = ?').get(labelGaveUpId).categories_processed === 0);
}

{
  // T: retry-failed — the DAL reset re-queues both terminal classes + clears the
  // pending retry markers, and a re-drain then actually re-embeds the rows.
  const { raw, db, messages } = freshVault();
  const cappedId = addRow(raw, { content: 'was capped, embeds now', nlp: -1, nlpError: `${EMBED_CAPPED_MARK}:5` });
  const retryId = addRow(raw, { content: 'mid-count', nlp: 0, nlpError: `${EMBED_RETRY_MARK}:3` });
  const labelId = addRow(raw, { content: 'label terminal', nlp: 2, vec: Buffer.alloc(8), cats: -1 });
  const poisonId = addRow(raw, { content: 'real poison', nlp: -1, nlpError: 'embed returned 3 dims, expected 768' });

  const reset = await messages.resetEnrichmentGiveUps(U);
  rec('T1. resetEnrichmentGiveUps returns honest counts { embedReset:1, labelReset:1 }',
    reset.embedReset === 1 && reset.labelReset === 1, JSON.stringify(reset));
  const st = (id) => raw.prepare('SELECT nlp_processed, nlp_error, categories_processed, embedding_768 FROM messages WHERE id = ?').get(id);
  rec('T2. capped row re-queued (pending, marker cleared) + mid-count marker cleared (fresh budget)',
    st(cappedId).nlp_processed === 0 && st(cappedId).nlp_error === null
      && st(retryId).nlp_processed === 0 && st(retryId).nlp_error === null);
  rec('T3. label-gave-up row re-queued for labeling', st(labelId).categories_processed === 0);
  rec('T4. a GENUINE poison row (real error string) is NOT touched by retry-failed (self-heal owns it)',
    st(poisonId).nlp_processed === -1 && /expected 768/.test(st(poisonId).nlp_error || ''));

  // …and the re-queued row actually re-embeds on the next drain (recovery is real).
  const svc = createEnrichmentService({ messages, embed: { async embed() { return VALID(); }, async embedBatch(texts) { return texts.map(() => VALID()); } }, getMasterKey: async () => masterKey });
  await svc.drainOnce({ userId: U });
  rec('T5. after retry-failed, a drain re-embeds the recovered row (nlp_processed 0 → 2, vector set)',
    st(cappedId).nlp_processed === 2 && st(cappedId).embedding_768 != null,
    `state=${st(cappedId).nlp_processed}`);
}

// ── C: the categorize cap matrix ─────────────────────────────────────────────
function catMessages(rows) {
  const store = new Map(rows.map((r) => [r.id, { categories_processed: 0, ...r }]));
  return {
    _store: store,
    selectPendingEnrichment: async () => [], updateEnrichment: async () => {},
    selectPendingNlp: async () => [], updateNlp: async () => {},
    async selectPendingCategories(_u, { limit = 25 } = {}) {
      // mirror the SQL: pending = 0/NULL only (a -1 row LEAVES the backlog), newest first
      return [...store.values()]
        .filter((r) => (r.categories_processed === 0 || r.categories_processed == null) && r.content)
        .map((r) => ({ id: r.id, content: r.content, scope: r.scope }));
    },
    async updateCategories(id, _u, fields) {
      const r = store.get(id); if (!r) return;
      r.categories_processed = fields.categoriesProcessed ?? 1;
      if (fields.domain !== undefined) r.domain = fields.domain;
    },
  };
}
{
  // C1: total model outage — nothing labels ⇒ no counting, batch stops, rows pending.
  const m = catMessages([{ id: 'a', content: 'first' }, { id: 'b', content: 'second' }]);
  const svc = createEnrichmentService({ messages: m, embed: { embed: async () => [] }, getMasterKey: async () => 'k', classify: async () => { throw new Error('model down'); } });
  for (let i = 0; i < LABEL_MAX_ATTEMPTS * 3; i++) await svc.enrichCategoriesOnce({ userId: 'u' });
  rec('C1. a model OUTAGE never terminal-marks a label row — all stay pending through any number of cycles',
    [...m._store.values()].every((r) => r.categories_processed === 0));

  // C2: row-specific failure with progress — counted per pass, terminal at K, batch not wedged.
  const good = { domain: 'Work & Creativity', register: 'Agency', subregister: 'Build' };
  const m2 = catMessages([
    { id: 'newer', content: 'labels fine' },
    { id: 'poison', content: 'always errors' },
    { id: 'below', content: 'stuck behind the poison row' },
  ]);
  let calls2 = 0;
  const classify2 = async (content) => {
    calls2++;
    if (/always errors/.test(content)) throw new Error('row-specific model error');
    return good;
  };
  const svc2 = createEnrichmentService({ messages: m2, embed: { embed: async () => [] }, getMasterKey: async () => 'k', classify: classify2 });
  let gaveUpReported = 0;
  const passes = [];
  for (let i = 0; i < LABEL_MAX_ATTEMPTS + 3; i++) {
    const c = await svc2.enrichCategoriesOnce({ userId: 'u' });
    gaveUpReported += c?.gaveUp ?? 0;
    passes.push(`${c.enriched}/${c.failed}/${c.gaveUp ?? 0}`);
    if ((c?.scanned ?? 0) === 0) break;
  }
  const p = (id) => m2._store.get(id).categories_processed;
  rec(`C2a. a row-specific persistent error goes TERMINAL (categories_processed = -1) after ${LABEL_MAX_ATTEMPTS} counted attempts`,
    p('poison') === -1, `state=${p('poison')} passes=${passes.join(' ')}`);
  rec('C2b. the healthy rows around it are ALL labeled — a gave-up row never wedges the batch',
    p('newer') === 1 && p('below') === 1, `newer=${p('newer')} below=${p('below')}`);
  rec('C2c. give-up is REPORTED by enrichCategoriesOnce (never silent)', gaveUpReported === 1, `gaveUp=${gaveUpReported}`);
  rec('C2d. the terminal row leaves the pending set (selectPendingCategories excludes -1) so the label can clear',
    (await m2.selectPendingCategories('u', {})).every((r) => r.id !== 'poison'));

  // C3: a success clears the in-memory counter — a flaky row that recovers is never marked.
  const m3 = catMessages([{ id: 'flaky', content: 'flaky row' }, { id: 'ok', content: 'fine' }]);
  let flakyFails = 2;
  const svc3 = createEnrichmentService({
    messages: m3, embed: { embed: async () => [] }, getMasterKey: async () => 'k',
    classify: async (content) => {
      if (/flaky/.test(content) && flakyFails-- > 0) throw new Error('transient');
      return good;
    },
  });
  for (let i = 0; i < 6; i++) await svc3.enrichCategoriesOnce({ userId: 'u' });
  rec('C3. a flaky row that recovers within the budget is LABELED normally (counter cleared on success)',
    m3._store.get('flaky').categories_processed === 1 && m3._store.get('ok').categories_processed === 1,
    `flaky=${m3._store.get('flaky').categories_processed}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — enrich resilience: empty→skip, transient→BOUNDED outage-safe retry→recoverable cap, wrong-dim→poison, valid→embed; label cap mirrors it' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
