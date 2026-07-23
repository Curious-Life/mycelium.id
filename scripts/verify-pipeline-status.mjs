// verify:pipeline-status — the `pipeline` readiness slice
// (PIPELINE-TRANSPARENCY-DESIGN-2026-07-19 §"Canonical model", §"Test strategy", §"Threat model").
//
// The ONE ordered stage machine — import → embed → categorize → cluster → describe → measure —
// that both the rail and the generate store read, so they can never disagree. This gate drives
// `createReadiness` directly with INJECTED fakes (mirroring verify-readiness.mjs), because the
// stage machine is pure derivation over cheap reads + in-memory health — nothing here needs a boot.
//
//   PS1  order + shape: exactly the six stages, in order; every state is a STRING in the enum,
//        never a bare boolean (§"Design principles")
//   PS2  a `no_model` labeler ⇒ categorize.blocked, reason:'no_model', with an approve-model action
//   PS3  embedded < floor ⇒ cluster.blocked, reason:'too_few_embedded', with a Generate action
//   PS4  a caught-up vault ⇒ EVERY stage done, overall:'done' — no spinner, no "checking" state
//   PS5  paused ⇒ embed + categorize blocked, reason:'paused', with a Resume action; blockedOn:'paused'
//   PS6  above-floor but no map ⇒ cluster.blocked, reason:'needs_generate' (the debounce made visible)
//   PS7  a down embedder ⇒ embed.blocked, reason:'embedder_down'
//   PS8  EVERY blocked stage carries BOTH a reason (enum) AND an action {label,target} — no naked block
//   PS9  overall ∈ {running,blocked,done,idle}; an empty vault is `idle`, not a spinner
//   PS-ETA   a running embed reuses embedEta (the activity feed's math) — a real number, not a re-derive
//   PS-LEAK  §1: the slice carries counts + enums ONLY — never message content, never a failure reason
//   PS-FAIL  §3.2a fail-closed: a throwing backlog read ⇒ {unknown:true}, never a fabricated all-done, never a throw
//   PS-FAIL2 §3.2a: a TRANSIENT mindscape read failure on a BUILT vault (mindscape⇒{unknown:true}) ⇒ cluster
//            PENDING/'map_unknown', NEVER blocked/needs_generate + a spurious Generate — distinguished from PS6
//            (a GENUINE no-map, unknown:false) by ms.unknown alone; both must stay green together
//   PS-COST  ⭐ THE LOAD-BEARING GATE (§Threat model / P-COST): the slice adds ZERO fresh scans — it
//            SHARES the SWR-cached reads its siblings already buy, and a repeat poll re-scans nothing.
//
// Each load-bearing assertion is mutation-falsified in scripts/mutate-pipeline-status.sh — a claim a
// mutation to the slice logic cannot red is decoration ([[gates-fail-on-fixtures-not-assertions]]).
import assert from 'node:assert/strict';
import { createReadiness } from '../src/readiness.js';

const U = 'local-user';
const STATES = new Set(['pending', 'running', 'blocked', 'done']);
const REASONS = new Set(['no_model', 'embedder_down', 'ollama_down', 'disk_low', 'paused', 'needs_generate', 'too_few_embedded', 'waiting_embed']);
// QA6: the ONE blocked reason with no user remedy — categorize DEFERRED behind a draining embed
// stage is scheduled work, not a fault, so it carries a reason but no action (the design forbids a
// named block WITHOUT an action only where a remedy exists). Every OTHER blocked reason must carry one.
const ACTIONLESS_BLOCK = new Set(['waiting_embed']);
const OVERALL = new Set(['running', 'blocked', 'done', 'idle']);
const ORDER = ['import', 'embed', 'categorize', 'cluster', 'describe', 'measure'];

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
async function t(n, fn) { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }

// A readiness wired with fully-INJECTED fakes: the stage machine's every input is controllable, and
// the db double RECORDS what it touched so PS-COST can prove the slice never issues a fresh scan.
function mk({ emb, cat, points = 0, pointsThrow = false, embHealth = 'ok', labHealth = 'ok', paused = false, embedPaused, categorizePaused, st = null, leak = false } = {}) {
  const touched = [];
  const bump = (o) => (leak ? { ...o, content: 'MY SECRET JOURNAL ENTRY', nlp_error: 'dim mismatch on message 42' } : o);
  const db = {
    touched,
    messages: {
      async embedBacklogCached() { touched.push('scan:embed'); return bump(emb); },
      async categoriesBacklogCached() { touched.push('scan:categories'); return bump(cat); },
      async nlpBacklogCached() { touched.push('scan:nlp'); return { pending: 0 }; },
    },
    // pointsThrow models a TRANSIENT getNoiseStats failure — mindscape()'s own §3.2a catch turns this
    // into {pointCount:0, unknown:true} WITHOUT throwing, so the pipeline slice runs to completion on
    // a fully-built vault whose map read merely hiccuped (the PS-FAIL2 scenario).
    mindscape: { async getNoiseStats() { touched.push('scan:points'); if (pointsThrow) throw new Error('SQLITE_BUSY on clustering_points'); return { total: points }; } },
    users: { async getSettings() { touched.push('users.getSettings'); return {}; } },
  };
  const r = createReadiness({
    db, userId: U,
    embedderHealth: () => ({ status: embHealth }),
    labelerHealth: () => ({ status: labHealth }),
    isProcessingPaused: () => paused,
    // Per-stage injection (R2): when a per-stage flag is provided the slice uses it; otherwise it
    // FALLS BACK to isProcessingPaused (so PS5's single-flag scenario still drives BOTH stages).
    ...(embedPaused === undefined ? {} : { isEmbedPaused: () => embedPaused }),
    ...(categorizePaused === undefined ? {} : { isCategorizePaused: () => categorizePaused }),
    drainerStatus: () => st,
  });
  return { r, db };
}
async function pipe(opts) { return (await mk(opts).r.get({ slices: ['pipeline'] })).pipeline; }
const byKey = (p) => Object.fromEntries(p.stages.map((s) => [s.key, s]));

// A shared shape-invariant asserted on EVERY scenario: six stages in order, every state a legal
// string, every blocked stage complete, overall a legal enum.
function invariants(p, where) {
  assert.deepEqual(p.stages.map((s) => s.key), ORDER, `${where}: stages must be the six canonical keys IN ORDER`);
  for (const s of p.stages) {
    assert.equal(typeof s.state, 'string', `${where}/${s.key}: state must be a STRING, never a bare boolean`);
    assert.ok(STATES.has(s.state), `${where}/${s.key}: '${s.state}' is not a legal state`);
    if (s.state === 'blocked') {
      assert.ok(REASONS.has(s.reason), `${where}/${s.key}: a blocked stage must carry an enum reason — got '${s.reason}'`);
      if (!ACTIONLESS_BLOCK.has(s.reason)) {
        assert.ok(s.action && typeof s.action.label === 'string' && typeof s.action.target === 'string',
          `${where}/${s.key}: a blocked stage must carry an action {label,target} — got ${JSON.stringify(s.action)}`);
      } else {
        assert.ok(!s.action, `${where}/${s.key}: a ${s.reason} block has no user remedy — it must NOT carry an action`);
      }
    }
  }
  assert.ok(OVERALL.has(p.overall), `${where}: overall '${p.overall}' is not a legal enum`);
}

// ── PS1) order + shape, on a mid-flight vault ─────────────────────────────────
await t('PS1. the six stages render IN ORDER; every state is a string in the enum (never a bare boolean)', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 30, pending: 70 }, cat: { total: 100, tagged: 0, pending: 100 }, points: 0 });
  invariants(p, 'PS1');
  const s = byKey(p);
  assert.equal(s.import.state, 'done', 'messages present ⇒ import done');
  assert.equal(s.embed.state, 'running', 'a live embed backlog ⇒ embed running');
  assert.deepEqual(s.embed.count, { done: 30, total: 100 }, 'embed carries its counts, not content');
  assert.equal(s.cluster.state, 'pending', 'still embedding ⇒ cluster waits');
  assert.equal(s.cluster.reason, 'waiting_embed', 'and says WHY it waits');
  assert.equal(s.describe.state, 'pending');
  assert.equal(s.measure.state, 'pending');
  assert.equal(p.overall, 'running');
  assert.equal(p.blockedOn, null, 'nothing blocked ⇒ blockedOn null');
});

// ── PS2) the biggest silent stall: no approved labeling model ─────────────────
await t("PS2. a `no_model` labeler ⇒ categorize.blocked, reason:'no_model', with an Approve action", async () => {
  const p = await pipe({ emb: { total: 100, embedded: 100, pending: 0 }, cat: { total: 100, tagged: 0, pending: 100 }, points: 0, labHealth: 'no_model' });
  invariants(p, 'PS2');
  const c = byKey(p).categorize;
  assert.equal(c.state, 'blocked', 'no model approved ⇒ categorize is blocked, not silently pending forever');
  assert.equal(c.reason, 'no_model');
  assert.equal(c.action.target, 'intelligence', 'the remedy points at the Intelligence screen');
  assert.match(c.action.label, /model/i, 'and names the action');
  assert.equal(p.blockedOn, 'no_model', 'the first block surfaces as blockedOn');
  assert.equal(p.overall, 'blocked');
});

// ── PS3) sub-floor vault must not be stranded ─────────────────────────────────
await t("PS3. embedded < floor ⇒ cluster.blocked, reason:'too_few_embedded', with a Generate action", async () => {
  const p = await pipe({ emb: { total: 4, embedded: 3, pending: 0 }, cat: { total: 4, tagged: 4, pending: 0 }, points: 0 });
  invariants(p, 'PS3');
  const c = byKey(p).cluster;
  assert.equal(c.state, 'blocked', '3 < MIN_EMBEDDED(5) ⇒ cluster blocked, never a silent no-op');
  assert.equal(c.reason, 'too_few_embedded');
  assert.equal(c.action.label, 'Generate');
  assert.equal(c.action.target, 'generate');
  assert.equal(p.blockedOn, 'too_few_embedded');
});

// ── PS4) the caught-up vault (the models-slice / restart trap) ────────────────
await t('PS4. a caught-up vault ⇒ EVERY stage done, overall:"done" — no spinner, no "checking"', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 100, pending: 0 }, cat: { total: 100, tagged: 100, pending: 0 }, points: 5000 });
  invariants(p, 'PS4');
  for (const s of p.stages) assert.equal(s.state, 'done', `${s.key} must be done on a caught-up vault`);
  assert.equal(p.overall, 'done');
  assert.equal(p.blockedOn, null);
  assert.ok(!p.stages.some((s) => s.state === 'running' || s.state === 'pending'), 'a mature vault must show NO in-progress state (the caught-up spinner bug)');
});

// ── PS5) pause is a choice, surfaced with its undo ────────────────────────────
await t('PS5. paused ⇒ embed + categorize blocked, reason:"paused", with a Resume action; blockedOn:"paused"', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 50, pending: 50 }, cat: { total: 100, tagged: 20, pending: 80 }, points: 0, paused: true });
  invariants(p, 'PS5');
  const s = byKey(p);
  assert.equal(s.embed.state, 'blocked', 'a paused embed reads as blocked-by-choice, not running');
  assert.equal(s.embed.reason, 'paused');
  assert.equal(s.embed.action.label, 'Resume');
  assert.equal(s.embed.action.target, 'resume');
  assert.equal(s.categorize.state, 'blocked');
  assert.equal(s.categorize.reason, 'paused');
  assert.equal(p.blockedOn, 'paused', 'embed is first ⇒ paused is the surfaced block');
  assert.equal(p.overall, 'blocked');
  // Every embed/categorize stage carries a `paused` flag so the co-located Stop/Resume control (R2)
  // knows its two-state label — true here for both.
  assert.equal(byKey(p).embed.paused, true, 'a paused embed stage must carry paused:true for the control');
  assert.equal(byKey(p).categorize.paused, true, 'a paused categorize stage must carry paused:true for the control');
});

// ── PS5b) per-stage pause: EMBED only (R2) — categorize keeps running ──────────
await t('PS5b. embedPaused only ⇒ embed blocked/paused, categorize still RUNNING (independent controls)', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 50, pending: 50 }, cat: { total: 100, tagged: 20, pending: 80 }, points: 0, embedPaused: true, categorizePaused: false });
  invariants(p, 'PS5b');
  const s = byKey(p);
  assert.equal(s.embed.state, 'blocked', 'embed paused ⇒ blocked');
  assert.equal(s.embed.reason, 'paused');
  assert.equal(s.embed.paused, true, 'embed carries paused:true');
  assert.equal(s.categorize.state, 'running', 'categorize is NOT paused ⇒ still running (the split is real)');
  assert.equal(s.categorize.paused, false, 'categorize carries paused:false');
  assert.equal(p.blockedOn, 'paused', 'the paused embed is the surfaced block');
});

// ── PS5c) per-stage pause: CATEGORIZE only (R2) — embed keeps running ──────────
await t('PS5c. categorizePaused only ⇒ categorize blocked/paused, embed still RUNNING', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 50, pending: 50 }, cat: { total: 100, tagged: 20, pending: 80 }, points: 0, embedPaused: false, categorizePaused: true });
  invariants(p, 'PS5c');
  const s = byKey(p);
  assert.equal(s.embed.state, 'running', 'embed is NOT paused ⇒ still running');
  assert.equal(s.embed.paused, false, 'embed carries paused:false');
  assert.equal(s.categorize.state, 'blocked', 'categorize paused ⇒ blocked');
  assert.equal(s.categorize.reason, 'paused');
  assert.equal(s.categorize.paused, true, 'categorize carries paused:true');
  assert.equal(p.blockedOn, 'paused', 'the paused categorize is the surfaced block');
});

// ── PS5d) QA6: categorize DEFERRED behind a draining embed stage ──────────────
await t('PS5d. QA6: drainer reports categorizeWaitingOnEmbed ⇒ categorize blocked/waiting_embed, NO action, overall stays running', async () => {
  // Embed is mid-drain (pending > 0) AND the drainer says the categorize stage is deferred behind it.
  // categorize has its own pending work and a healthy model — the ONLY reason it is not running is the
  // scheduler. It must render as a NAMED, ACTIONLESS block, and must NOT dominate `overall` (embed is
  // healthily running — nothing is waiting on the user).
  const p = await pipe({
    emb: { total: 1000, embedded: 400, pending: 600 }, cat: { total: 1000, tagged: 100, pending: 900 },
    points: 0, labHealth: 'ok', st: { categorizeWaitingOnEmbed: true },
  });
  invariants(p, 'PS5d');
  const s = byKey(p);
  assert.equal(s.embed.state, 'running', 'embed is the stage actually working');
  assert.equal(s.categorize.state, 'blocked', 'categorize is deferred ⇒ blocked, never a lying running/done');
  assert.equal(s.categorize.reason, 'waiting_embed', 'and it says WHY — waiting for embedding');
  assert.ok(!s.categorize.action, 'a deferral has no user remedy ⇒ NO action button (nothing for the user to do)');
  assert.deepEqual(s.categorize.count, { done: 100, total: 1000 }, 'it still carries its own counts');
  assert.equal(s.categorize.paused, false, 'not paused — the Stop control stays a Pause');
  assert.equal(p.overall, 'running', 'a deferral behind a HEALTHY embed is the pipeline working — it must NOT read as blocked-on-you');
  assert.notEqual(p.blockedOn, 'waiting_embed', 'and waiting_embed must never surface as the aggregate block');
});

// ── PS5e) QA6: the deferral OUTRANKS ollama_down (the true immediate cause) but yields to no_model/paused ──
await t('PS5e. QA6: waiting_embed outranks ollama_down; no_model + paused still outrank waiting_embed', async () => {
  // While deferred the drainer does not touch Ollama, so "waiting for embedding" is the true cause,
  // not "ollama down". But a MISSING MODEL (no consent) and an owner PAUSE are both states the user
  // must still see — they outrank the scheduler.
  const down = await pipe({ emb: { total: 1000, embedded: 400, pending: 600 }, cat: { total: 1000, tagged: 100, pending: 900 }, points: 0, labHealth: 'down', st: { categorizeWaitingOnEmbed: true } });
  assert.equal(byKey(down).categorize.reason, 'waiting_embed', 'ollama_down must NOT mask the real immediate cause');

  const noModel = await pipe({ emb: { total: 1000, embedded: 400, pending: 600 }, cat: { total: 1000, tagged: 100, pending: 900 }, points: 0, labHealth: 'no_model', st: { categorizeWaitingOnEmbed: true } });
  assert.equal(byKey(noModel).categorize.reason, 'no_model', 'a missing model (no consent) still outranks the deferral');

  const paused = await pipe({ emb: { total: 1000, embedded: 400, pending: 600 }, cat: { total: 1000, tagged: 100, pending: 900 }, points: 0, categorizePaused: true, st: { categorizeWaitingOnEmbed: true } });
  assert.equal(byKey(paused).categorize.reason, 'paused', 'an owner pause still outranks the deferral');
});

// ── PS6) the debounce made visible (re-cluster is a deliberate action, not silence) ──
await t('PS6. above the floor with no map ⇒ cluster.blocked, reason:"needs_generate"', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 100, pending: 0 }, cat: { total: 100, tagged: 100, pending: 0 }, points: 0 });
  invariants(p, 'PS6');
  const c = byKey(p).cluster;
  assert.equal(c.state, 'blocked');
  assert.equal(c.reason, 'needs_generate', 'enough embedded but no map ⇒ prompt a Generate, never leave it silent');
  assert.equal(c.action.target, 'generate');
  assert.equal(p.blockedOn, 'needs_generate');
});

// ── PS7) a down embedder blocks embed with its reason ─────────────────────────
await t('PS7. a down embedder ⇒ embed.blocked, reason:"embedder_down"', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 10, pending: 90 }, cat: { total: 100, tagged: 0, pending: 100 }, points: 0, embHealth: 'down' });
  invariants(p, 'PS7');
  const e = byKey(p).embed;
  assert.equal(e.state, 'blocked');
  assert.equal(e.reason, 'embedder_down');
  assert.ok(e.action && e.action.target, 'and offers a remedy');
  assert.equal(p.blockedOn, 'embedder_down');
});

// ── PS8) NO naked block anywhere — reason AND action, always ──────────────────
await t('PS8. every blocked stage across every scenario carries BOTH a reason and an action', async () => {
  const scenarios = [
    await pipe({ emb: { total: 100, embedded: 100, pending: 0 }, cat: { total: 100, tagged: 0, pending: 100 }, points: 0, labHealth: 'no_model' }),
    await pipe({ emb: { total: 100, embedded: 50, pending: 50 }, cat: { total: 100, tagged: 20, pending: 80 }, points: 0, paused: true }),
    await pipe({ emb: { total: 4, embedded: 3, pending: 0 }, cat: { total: 4, tagged: 4, pending: 0 }, points: 0 }),
    await pipe({ emb: { total: 100, embedded: 10, pending: 90 }, cat: { total: 100, tagged: 0, pending: 100 }, points: 0, embHealth: 'error' }),
  ];
  let blockedSeen = 0;
  for (const p of scenarios) {
    for (const s of p.stages.filter((x) => x.state === 'blocked')) {
      blockedSeen++;
      assert.ok(REASONS.has(s.reason), `naked block: ${s.key} has no enum reason (${s.reason})`);
      assert.ok(s.action?.label && s.action?.target, `naked block: ${s.key} has no {label,target} action`);
    }
  }
  assert.ok(blockedSeen >= 4, `fixture sanity: the scenarios must actually PRODUCE blocks — saw ${blockedSeen}`);
});

// ── PS9) overall enum + the idle empty vault ──────────────────────────────────
await t('PS9. an empty vault ⇒ overall:"idle" (not a spinner); import pending', async () => {
  const p = await pipe({ emb: { total: 0, embedded: 0, pending: 0 }, cat: { total: 0, tagged: 0, pending: 0 }, points: 0 });
  invariants(p, 'PS9');
  assert.equal(p.overall, 'idle', 'no data ⇒ idle, never a fabricated running/done');
  assert.equal(byKey(p).import.state, 'pending', 'nothing imported yet');
  assert.equal(p.blockedOn, null);
});

// ── PS-ETA) the running embed REUSES the activity feed's math (not a re-derive) ──
await t('PS-ETA. a running embed carries etaSeconds from embedEta — the reused throughput math', async () => {
  // embedEta: perItemMs = embedActiveMs/embeddedTotal = 100000/100 = 1000ms; remaining 70 ⇒ 70s.
  // If the slice re-derived its own rate (or dropped the call) this exact number would not appear.
  const st = { embeddedTotal: 100, embedActiveMs: 100_000, barrenPasses: 0, embedErrs: 0 };
  const p = await pipe({ emb: { total: 100, embedded: 30, pending: 70 }, cat: { total: 100, tagged: 100, pending: 0 }, points: 0, st });
  const e = byKey(p).embed;
  assert.equal(e.state, 'running');
  assert.equal(e.etaSeconds, 70, 'the reused embedEta math must price the remaining backlog — 100000/100 × 70 / 1000 = 70s');
});

// ── PS-LEAK) §1 — counts + enums only, never plaintext ────────────────────────
await t('PS-LEAK. the slice payload carries NO message content and NO failure reason (§1)', async () => {
  // The backlog objects are poisoned with content + nlp_error; the slice must read only the counts.
  const p = await pipe({ emb: { total: 10, embedded: 1, pending: 9 }, cat: { total: 10, tagged: 1, pending: 9 }, points: 0, leak: true });
  const json = JSON.stringify(p);
  assert.ok(!json.includes('MY SECRET JOURNAL'), 'message content must never reach the pipeline slice');
  assert.ok(!json.includes('dim mismatch'), 'a failure REASON string must never reach it — enum reasons only');
  assert.ok(!json.includes('nlp_error'), 'not even the field name');
});

// ── PS-FAIL) §3.2a — a broken read claims NOTHING, never crashes ──────────────
await t('PS-FAIL. a throwing backlog read ⇒ {unknown:true}, overall idle — never a fabricated all-done, never a throw', async () => {
  const db = {
    messages: { async embedBacklogCached() { throw new Error('SQLITE_BUSY'); }, async categoriesBacklogCached() { throw new Error('x'); }, async nlpBacklogCached() { throw new Error('x'); } },
    mindscape: { async getNoiseStats() { throw new Error('x'); } },
    users: { async getSettings() { throw new Error('x'); } },
  };
  const r = createReadiness({ db, userId: U, embedderHealth: () => { throw new Error('x'); }, labelerHealth: () => { throw new Error('x'); } });
  const { pipeline } = await r.get({ slices: ['pipeline'] });
  assert.equal(pipeline.unknown, true, 'a failed assembly must SAY unknown');
  assert.ok(!pipeline.stages.some((s) => s.state === 'done'), 'and must NOT fabricate a done stage from a failed read');
  assert.equal(pipeline.overall, 'idle', 'unknown degrades to idle, not a spinner');
});

// ── PS-FAIL2) §3.2a — a mindscape hiccup must NOT impersonate an ungenerated vault ────────────
// The MED (independent review, confirmed): mindscape() NEVER throws — on a transient getNoiseStats
// failure it returns {pointCount:0, unknown:true} (HIGH-4 catch). embed+categorize succeed with known
// counts on a FULLY-BUILT vault, but the map read hiccups. Reading unknown as points===0 let cluster
// fabricate `blocked needs_generate` + a Generate action — a spurious "Generate" prompt over a built
// vault whose action kicks a redundant, expensive re-cluster (the caught-up-trap). The fix: cluster
// holds at `pending` (reason map_unknown, NO action), never blocked/needs_generate.
//
// ⚠️ This MUST stay distinguished from PS6: PS6 is a GENUINE no-map (points:0, unknown:false, an
// embedded above-floor vault) and MUST still show cluster.blocked/needs_generate. The two differ ONLY
// by ms.unknown — so a fix that collapses them (e.g. suppressing needs_generate whenever points===0)
// would red PS6. Both green together is the proof the flag — not the zero — is what's read.
await t('PS-FAIL2. a built vault whose mindscape read TRANSIENTLY fails ⇒ cluster PENDING (map_unknown), NOT blocked/needs_generate, NO Generate action', async () => {
  const p = await pipe({ emb: { total: 100, embedded: 100, pending: 0 }, cat: { total: 100, tagged: 100, pending: 0 }, points: 0, pointsThrow: true });
  invariants(p, 'PS-FAIL2');
  const c = byKey(p).cluster;
  assert.equal(c.state, 'pending', 'a map read that FAILED is not a zero-map — cluster must hold at pending, never assert blocked');
  assert.notEqual(c.reason, 'needs_generate', 'must NOT fabricate needs_generate from a failed map read (the caught-up-trap)');
  assert.notEqual(c.reason, 'too_few_embedded', 'nor any other blocked reason — the map state is simply unknown');
  assert.equal(c.reason, 'map_unknown', 'it says WHY it waits: the map state is not known');
  assert.equal(c.action, undefined, 'a pending stage carries NO action — no spurious Generate button to kick a redundant re-cluster');
  // embed + categorize are KNOWN-good and must stay honest — a mindscape hiccup must not blank them.
  assert.equal(byKey(p).embed.state, 'done', 'embed is known-good and must still read done');
  assert.equal(byKey(p).categorize.state, 'done', 'categorize is known-good and must still read done');
  // describe/measure cannot claim done (no proven map) and cluster is not blocked ⇒ pending.
  assert.equal(byKey(p).describe.state, 'pending');
  assert.equal(byKey(p).measure.state, 'pending');
  // NOT blocked anywhere from this ⇒ overall is not a fabricated Generate-prompt block.
  assert.notEqual(p.overall, 'blocked', 'a transient map hiccup must not read as a blocked pipeline');
  assert.equal(p.blockedOn, null, 'and nothing is blockedOn — no spurious Generate remedy surfaced');
  // The whole slice is NOT blanked — the stages we know are still reported (not a slice-wide unknown).
  assert.notEqual(p.unknown, true, 'a mindscape hiccup must NOT blank the whole pipeline — only the map stage is unknown');
});

// ── PS-COST) ⭐ ZERO fresh scans — the load-bearing constraint (§Threat model / P-COST) ──
await t('PS-COST. ⭐ the pipeline slice SHARES its siblings\' SWR reads and a repeat poll re-scans NOTHING', async () => {
  // Model the SWR caches FAITHFULLY (as verify-readiness P-COST does): db/messages.js memoizes the
  // backlogs (single-flight, TTL), so multiple CALLS in one tick collapse to ONE scan, and a warm
  // repeat is ZERO. The doubles hit() only on a real recompute — counting CALLS instead of SCANS
  // would be the C1 sin. mindscape() has its own closure memo, so getNoiseStats is scanned once too.
  let touches = [];
  const hit = (w) => touches.push(w);
  const cache = (label, val) => { let memo = null; return async () => { if (!memo) { hit(label); memo = val; } return memo; }; };
  const db = {
    messages: {
      embedBacklogCached: cache('scan:embed', { total: 100, embedded: 40, pending: 60 }),
      categoriesBacklogCached: cache('scan:categories', { total: 100, tagged: 30, pending: 70 }),
      nlpBacklogCached: cache('scan:nlp', { pending: 0 }),
    },
    // ⚠️ getNoiseStats is NOT modeled as a cache here — unlike the backlogs (which ARE the db-layer
    // SWR cache), clustering_points has NO db-layer memo; the ONLY thing deduping it across the
    // mindscape slice and the pipeline slice is readiness's OWN mindscape() closure memo — the real
    // code under test. So every raw call hit()s, and scan:points==1 in a full get() PROVES pipeline
    // rode that memo rather than issuing a second full-table COUNT (the mindscape-direct regression).
    mindscape: { async getNoiseStats() { hit('scan:points'); return { total: 0 }; } },
    users: { async getSettings() { hit('users.getSettings'); return {}; } },
    providers: { async list() { hit('providers.list'); return [{ id: 1, is_active: 1, label: 'x' }]; } },
    secrets: { async get() { hit('secrets.get'); return '1'; }, async has() { hit('secrets.has'); return true; } },
    async rawQuery() { hit('rawQuery'); return { results: [{ welcome_shown_at: '2026-01-01' }] }; },
  };
  const r = createReadiness({ db, userId: U, embedderHealth: () => ({ status: 'ok' }), labelerHealth: () => ({ status: 'ok' }), isProcessingPaused: () => false, drainerStatus: () => null });

  // (a) A full ALL get() — data + tags + mindscape + processing + pipeline all buy the SAME sources.
  // Each underlying scan must appear EXACTLY ONCE despite the multiplicity: that IS "zero marginal
  // scans for pipeline". A second scan of embed/categories/points here is the design-breaking regression.
  await r.get();
  const c1 = touches.reduce((a, x) => ({ ...a, [x]: (a[x] || 0) + 1 }), {});
  assert.equal(c1['scan:embed'], 1, `embed backlog scanned ${c1['scan:embed']}× in one get() — data + processing + pipeline must share ONE scan`);
  assert.equal(c1['scan:categories'], 1, `categories backlog scanned ${c1['scan:categories']}× — tags + processing + pipeline must share ONE scan`);
  assert.equal(c1['scan:points'], 1, `clustering_points scanned ${c1['scan:points']}× — mindscape + pipeline must share ONE scan (the memo)`);

  // (b) A repeat poll of ['pipeline'] alone: the caches are warm ⇒ ZERO re-scans. This is the tick
  // the rail/generate store pay every few seconds for the life of the session.
  touches = [];
  await r.get({ slices: ['pipeline'] });
  const c2 = touches.reduce((a, x) => ({ ...a, [x]: (a[x] || 0) + 1 }), {});
  assert.deepEqual(touches, [], `a warm pipeline poll re-scanned ${JSON.stringify(c2)} — it must ride the caches, never a fresh aggregate (P-COST)`);
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — pipeline stage machine: ordered, fail-closed, leak-free, and ZERO fresh scans (P-COST holds)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
