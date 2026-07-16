// verify:enrich-ollama-wake — the enrich drainer must WAKE the lazy on-box Ollama
// daemon for Context Engine L1 categorization. Without this, a vault whose owner
// never opened local chat leaves EVERY message untagged forever (the live-vault
// dormancy bug found 2026-06-20: 0 / 69,600 messages categorized because Ollama
// was down and nothing on the enrich path called ensureUp()).
//
// Drives startEnrichDrainer with offline stubs: a HEALTHY embed stub (so the cycle
// passes the :8091 gate and reaches the categories stage), an injected classify
// (no real Ollama), an in-memory messages store, and a recording daemon stub.
//   W1 pending categories + daemon → ensureUp() IS called, rows get tagged
//   W2 NO pending categories + daemon → ensureUp() NOT called (idle vault never spawns a model)
//   W3 daemon.ensureUp() resolves {ok:false} → cycle does NOT throw; still fail-soft
//   W4 NO daemon (tests / model-less host) → no throw; categories still run (back-compat)
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import crypto from 'node:crypto';
// The cycle's embed stage (drainOnce) fail-closes without a master key. Seed a throwaway
// one (read from process.env at call time) — the categories stage under test writes only
// plaintext label columns, so no real key material is exercised.
process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
const { startEnrichDrainer, pauseEnrichCategorize, resumeEnrichCategorize, isEnrichCategorizePaused } = await import('../src/enrich/drainer.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 2000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return true; await sleep(stepMs); }
  return false;
}

// A healthy embed stub → embedHealthy() true → cycle proceeds past the :8091 gate.
// .embed() is required at construction but never called here (no embed backlog).
const healthyEmbed = {
  async health() { return { status: 'ok', loaded: true, dim: 768 }; },
  async embed() { return null; },
};
// Injected classifier → no real Ollama call; returns fixed plaintext labels.
const classify = async () => ({ domain: 'Mind & Growth', register: 'Inquiry', subregister: 'Map' });

// In-memory messages namespace. `pending` rows are the categories backlog.
function makeDb(pendingIds, { approved = 'qwen3.5:4b' } = {}) {
  const cats = new Map(pendingIds.map((id) => [id, { id, content: `row ${id} about minds`, categories_processed: 0 }]));
  return {
    db: {
      // The owner's approval — see APPROVED/approve below. null ⇒ nothing approved.
      users: { getSettings: async () => (approved ? { taskModels: { categorize: { model: approved }, enrich: { model: approved } } } : {}) },
      async rawQuery() { return { rows: [] }; }, // self-heal UPDATE → no-op
      messages: {
        async selectPendingEnrichment() { return []; },          // no embed backlog
        async updateEnrichment() {},
        async selectPendingNlp() { return []; },
        async updateNlp() {},
        async selectPendingCategories(_userId, { limit = 25 } = {}) {
          return [...cats.values()].filter((r) => r.categories_processed === 0).slice(0, limit);
        },
        async updateCategories(id, _userId, patch) {
          const r = cats.get(id); if (r && patch.categoriesProcessed !== undefined) r.categories_processed = patch.categoriesProcessed;
        },
      },
    },
    taggedCount: () => [...cats.values()].filter((r) => r.categories_processed === 1).length,
  };
}

// ⚠️ CONSENT (§3.10c). The approval IS the model setting — there is no separate flag. Every
// fixture below must GRANT it, because an unset taskModels.categorize.model now means "the
// owner has not approved a local model", and the drainer then wakes nothing and pulls
// nothing. Before 2026-07-16 these fixtures passed with NO settings at all, because the
// resolver fell back to qwen3.5:4b — which is precisely the implicit default that made a
// fresh vault download 3.4GB unasked. A fixture with no settings must now tag NOTHING.
const APPROVED = 'qwen3.5:4b';
const approve = (model = APPROVED) => ({ users: { getSettings: async () => ({ taskModels: { categorize: { model }, enrich: { model } } }) } });

function makeDaemon(result = { ok: true, running: true, adopted: true }) {
  const stub = { calls: 0, async ensureUp() { stub.calls++; return result; } };
  return stub;
}

// Ollama model-mgmt stub. Default: the labeling model (llama3.1) is already installed, so
// categorize proceeds. Pass installed:[] to exercise the auto-pull path.
function makeOllama({ installed = ['qwen3.5:4b', 'llama3.1:latest'], pullOk = true } = {}) {
  const stub = {
    listCalls: 0, pullCalls: 0, pulled: [], installed: [...installed],
    async listInstalled() { stub.listCalls++; return [...stub.installed]; },
    async pullModel(name) { stub.pullCalls++; stub.pulled.push(name); if (!pullOk) throw new Error('pull failed'); stub.installed.push(name); return true; },
  };
  return stub;
}

const BIG = 10_000_000; // effectively disable the interval; the boot cycle does the work

// ── W1: pending + daemon → ensureUp called, rows tagged ──
{
  const { db, taggedCount } = makeDb(['a', 'b', 'c']);
  const daemon = makeDaemon();
  let threw = null;
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  const woke = await waitFor(() => daemon.calls > 0).catch((e) => { threw = e; return false; });
  const tagged = await waitFor(() => taggedCount() === 3);
  d.stop();
  rec('W1. pending categories + daemon → ensureUp() called', woke && !threw, `calls=${daemon.calls} threw=${threw?.message || 'no'}`);
  rec('W1b. rows actually categorized after wake', tagged, `tagged=${taggedCount()}/3`);
}

// ── W2: no pending + daemon → ensureUp NOT called (don't spawn a model on an idle vault) ──
{
  const { db } = makeDb([]); // empty backlog
  const daemon = makeDaemon();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  await sleep(400); // let the boot cycle run fully
  d.stop();
  rec('W2. idle vault (no pending) → ensureUp() NOT called', daemon.calls === 0, `calls=${daemon.calls}`);
}

// ── W3: ensureUp resolves {ok:false} → cycle does not throw, stays fail-soft ──
{
  const { db, taggedCount } = makeDb(['a', 'b']);
  const daemon = makeDaemon({ ok: false, running: false, reason: 'not_installed' });
  let threw = null;
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: (m) => { if (/error/i.test(m)) threw = new Error(m); } });
  const woke = await waitFor(() => daemon.calls > 0);
  await sleep(200);
  d.stop();
  rec('W3. ensureUp {ok:false} → wake attempted, cycle did not error', woke && !threw, `calls=${daemon.calls} tagged=${taggedCount()} err=${threw?.message || 'no'}`);
}

// ── W4: no daemon → no throw; L1 stays PENDING ──
// ⚠️ CHANGED 2026-07-16, deliberately. This used to assert "categories still run" with no
// daemon: an injected `classify` made the model/daemon irrelevant, so labeling ran while
// `modelReady` sat at its default `true`. That contradicted the drainer's own `daemon` param
// doc — "Null in contexts with no local model → L1 simply stays pending, fail-soft" — which
// was therefore FALSE for exactly this path. L1 now runs iff an approved model is confirmed
// installed, with no exception for an injected classifier: ONE rule, and the comment is now
// true. No production path is affected — server-rest.js always passes hwOllamaDaemon.
{
  const { db, taggedCount } = makeDb(['a', 'b']);
  let threw = null;
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, log: (m) => { if (/error/i.test(m)) threw = new Error(m); } });
  await sleep(150);
  d.stop();
  rec('W4. no daemon param → no throw, L1 stays pending (as the param contract says)',
    !threw && taggedCount() === 0, `tagged=${taggedCount()}/0 err=${threw?.message || 'no'}`);
}

// ── W5: THE CONSENT GATE — no approved model ⇒ nothing is woken, nothing is pulled ──
// The headline of §3.10: a fresh vault must download NOTHING until the owner approves it.
// Both silent paths are covered — the 3.4GB model pull AND the Ollama RUNTIME install that
// ensureUp() performs (ollama-daemon.js autoInstall), which happens BEFORE the pull is even
// considered. Approving labeling approves both; declining fetches neither.
{
  resumeEnrichCategorize();
  const { db, taggedCount } = makeDb(['a', 'b', 'c'], { approved: null }); // owner has NOT approved
  const daemon = makeDaemon();
  const ollama = makeOllama({ installed: [] });
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  await sleep(200);
  d.stop();
  rec('W5. NO approved model ⇒ Ollama is never woken and nothing is pulled (the 3.4GB consent gate)',
    daemon.calls === 0 && ollama.pullCalls === 0 && ollama.listCalls === 0 && taggedCount() === 0,
    `ensureUp=${daemon.calls} pulls=${ollama.pullCalls} lists=${ollama.listCalls} tagged=${taggedCount()}`);
}

// ── P1: user PAUSE → categorization stage skipped (no wake, no tagging) despite pending work ──
{
  pauseEnrichCategorize();
  const { db, taggedCount } = makeDb(['a', 'b', 'c']);
  const daemon = makeDaemon();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  await sleep(400); // let the boot cycle run fully
  d.stop();
  rec('P1. paused → no wake + nothing tagged (embedding unaffected)', isEnrichCategorizePaused() && daemon.calls === 0 && taggedCount() === 0, `paused=${isEnrichCategorizePaused()} calls=${daemon.calls} tagged=${taggedCount()}`);
}

// ── P2: RESUME → categorization runs again, rows tagged (resumable from where it paused) ──
{
  resumeEnrichCategorize();
  const { db, taggedCount } = makeDb(['a', 'b', 'c']);
  const daemon = makeDaemon();
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama: makeOllama(), log: () => {} });
  const tagged = await waitFor(() => taggedCount() === 3);
  d.stop();
  rec('P2. resume → wake + rows tagged', !isEnrichCategorizePaused() && daemon.calls > 0 && tagged, `paused=${isEnrichCategorizePaused()} calls=${daemon.calls} tagged=${taggedCount()}/3`);
}

// ── A1: labeling MODEL missing → drainer PULLS it (background), then tags once ready ──
// The production bug: ensureUp() starts the server but a fresh app-private Ollama has NO
// models, so classify fails "model not found" forever. The drainer must pull the model.
{
  resumeEnrichCategorize();
  // Approved, but NOT installed — so the pull must fire for the model the OWNER chose.
  const { db, taggedCount } = makeDb(['a', 'b', 'c'], { approved: 'llama3.1' });
  const daemon = makeDaemon();
  const ollama = makeOllama({ installed: [] }); // model NOT installed
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: 60, embed: healthyEmbed, classify, daemon, ollama, log: () => {} });
  const pulled = await waitFor(() => ollama.pullCalls > 0); // it tried to pull the missing model
  const eventually = await waitFor(() => taggedCount() === 3, 3000); // after pull, a later tick tags
  d.stop();
  rec('A1. labeling model missing → pullModel() called for it', pulled && ollama.pulled.includes('llama3.1'), `pullCalls=${ollama.pullCalls} pulled=${ollama.pulled.join(',')}`);
  rec('A1b. once pulled, categorization resumes + tags', eventually, `tagged=${taggedCount()}/3`);
}

// ── A2: Ollama unreachable (listInstalled throws) → no crash, nothing tagged, retries ──
{
  resumeEnrichCategorize();
  const { db, taggedCount } = makeDb(['a', 'b'], { approved: 'llama3.1' });
  const daemon = makeDaemon();
  let threw = null;
  const ollama = { listCalls: 0, async listInstalled() { this.listCalls++; throw new Error('ECONNREFUSED'); }, async pullModel() { throw new Error('down'); } };
  const d = startEnrichDrainer({ db, userId: 'u', intervalMs: BIG, embed: healthyEmbed, classify, daemon, ollama, log: (m) => { if (/drain cycle error/i.test(m)) threw = new Error(m); } });
  await waitFor(() => ollama.listCalls > 0);
  await sleep(150);
  d.stop();
  rec('A2. Ollama unreachable → no crash, nothing tagged (fail-soft, retries next tick)', ollama.listCalls > 0 && !threw && taggedCount() === 0, `listCalls=${ollama.listCalls} tagged=${taggedCount()} err=${threw?.message || 'no'}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — enrich drainer wakes the lazy Ollama daemon + AUTO-PULLS the missing labeling model on pending L1 work, idle-safe + fail-soft + user pause/resume' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
