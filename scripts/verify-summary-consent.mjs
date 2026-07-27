// verify:summary-consent — the Context-Areas summary lens obeys the #148 consent rule:
// nothing runs an on-box model the owner never approved. Companion to verify:model-consent
// (the drainer) and the OpenAI-gateway consent gate — same violation, one more caller.
//
// THE FINDING THIS ENFORCES: POST /contexts/:id/summary builds the inference router with NO
// localModel, and 'summarize' is a LOCAL task (router LOCAL_TASKS) → it ALWAYS runs on-box,
// regardless of any cloud provider. The router's fail-open coalesce
// (localModel || env.LOCAL_MODEL || DEFAULT_LOCAL_MODEL) therefore ran `llama3.1` — a model
// the owner never approved (and, via ensureUp, the Ollama runtime with it). The fix: the
// summary path resolves the APPROVED on-box model (defaultLabelModel — the single #148
// reader) and passes requireApprovedLocal:true, so a local run with no approved model
// REFUSES with a typed InferenceError instead of silently running llama3.1; the endpoint
// renders that as an honest 503 pointing at Settings → Intelligence.
//
//   S1  requireApprovedLocal + no approved model ⇒ infer({task:'summarize'}) REFUSES
//       (code:'no-approved-local-model', status 503) and NEVER contacts Ollama
//   S2  requireApprovedLocal + an approved model ⇒ it runs THAT model, never llama3.1
//   S3  the gate is load-bearing: WITHOUT requireApprovedLocal the router still fails open
//       to DEFAULT_LOCAL_MODEL (the exact bug) — so removing the gate flips S1/S2 red
//   S3b the streaming path (inferStream) refuses on the same terms
//   S4  END-TO-END: POST /contexts/:id/summary with no approved model → 503 honest error,
//       NO Ollama call, NO summary persisted
//   S5  END-TO-END: after approving a model, the endpoint runs it (never llama3.1) + persists
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');

const { createInferenceRouter } = await import('../src/inference/router.js');
const { DEFAULT_LOCAL_MODEL } = await import('../src/inference/local.js');

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
async function t(n, fn) { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }

// A `fetch` that records every OLLAMA generate/chat call (the MODEL it was asked to run) and
// returns a canned Ollama reply. Any OTHER URL throws — the local path must talk to nothing
// but Ollama, and a stray egress would be a finding. `.calls` is the evidence.
function recordingOllamaFetch(response = { response: 'A concise summary.', prompt_eval_count: 5, eval_count: 5 }) {
  const calls = [];
  const fn = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/generate') || u.includes('/api/chat')) {
      let model = null;
      try { model = JSON.parse(opts?.body || '{}').model ?? null; } catch { /* leave null */ }
      calls.push({ url: u, model });
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected non-Ollama fetch to ${u}`);
  };
  fn.calls = calls;
  return fn;
}

// ── S1) the consent gate: no approved model ⇒ refuse, and DO NOT run llama3.1 ────────────
await t('S1. requireApprovedLocal + no model ⇒ summarize REFUSES (typed) and never contacts Ollama', async () => {
  const f = recordingOllamaFetch();
  // env:{} so a stray process env LOCAL_MODEL / OLLAMA_URL can't leak an "approval" in.
  const router = createInferenceRouter({ requireApprovedLocal: true, fetch: f, env: {} });
  let err;
  try { await router.infer({ prompt: 'summarize these', task: 'summarize', maxTokens: 50 }); }
  catch (e) { err = e; }
  assert.ok(err, 'a local run with no approved model must throw, not run');
  assert.equal(err.code, 'no-approved-local-model', `must be the typed consent refusal — got code=${err.code} (${err.message})`);
  assert.equal(err.status, 503, 'the code carries a 503 so the REST layer renders an honest "not configured", not a 500');
  assert.equal(f.calls.length, 0, 'Ollama must NEVER be contacted — no silent llama3.1 pull/run (the whole point)');
});

// ── S2) an APPROVED model runs — and it is the approved one, not the default ─────────────
await t('S2. requireApprovedLocal + an approved model ⇒ runs THAT model, never llama3.1', async () => {
  const f = recordingOllamaFetch();
  const router = createInferenceRouter({ requireApprovedLocal: true, localModel: 'qwen3.5:4b', fetch: f, env: {} });
  const out = (await router.infer({ prompt: 'summarize these', task: 'summarize', maxTokens: 50 })).trim();
  assert.equal(out, 'A concise summary.', 'the approved model produces the summary');
  assert.equal(f.calls.length, 1, 'exactly one on-box call');
  assert.equal(f.calls[0].model, 'qwen3.5:4b', `it runs the APPROVED model — got ${f.calls[0].model}`);
  assert.notEqual(f.calls[0].model, DEFAULT_LOCAL_MODEL, 'and specifically NOT the hardcoded default');
});

// ── S3) the gate is load-bearing — pin the fail-open it removes ──────────────────────────
await t('S3. WITHOUT the gate the router still fails open to DEFAULT_LOCAL_MODEL (the bug the gate closes)', async () => {
  const f = recordingOllamaFetch();
  const router = createInferenceRouter({ fetch: f, env: {} });   // default: requireApprovedLocal off
  await router.infer({ prompt: 'summarize these', task: 'summarize', maxTokens: 50 });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].model, DEFAULT_LOCAL_MODEL,
    `the un-gated router runs ${DEFAULT_LOCAL_MODEL} unasked — this is precisely the consent violation, so deleting the gate re-opens it and flips S1/S2 red`);
});

await t('S3b. the STREAMING local path refuses on the same terms (inferStream)', async () => {
  const f = recordingOllamaFetch();
  const router = createInferenceRouter({ requireApprovedLocal: true, fetch: f, env: {} });
  let err;
  try { for await (const _ of router.inferStream({ prompt: 'x', task: 'summarize', maxTokens: 50 })) { void _; } }
  catch (e) { err = e; }
  assert.equal(err?.code, 'no-approved-local-model', `stream must refuse too — got ${err?.code}`);
  assert.equal(f.calls.length, 0, 'and it must not contact Ollama');
});

// ── S4 + S5) END-TO-END through the real REST endpoint (POST /contexts/:id/summary) ──────
await t('S4/S5. the endpoint refuses honestly with no approved model, and runs the approved one after', async () => {
  const { startRestServer } = await import('../src/server-rest.js');
  const Database = (await import('better-sqlite3')).default;
  const { applyMigrations } = await import('../src/db/migrate.js');
  const { rmSync, mkdirSync } = await import('node:fs');
  const DB = 'data/verify-summary-consent.db', KCV = 'data/verify-summary-consent-kcv.json';
  for (const s of ['', '-shm', '-wal']) { try { rmSync(`${DB}${s}`); } catch { /* */ } }
  try { rmSync(KCV); } catch { /* */ }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();
  const hex = () => crypto.randomBytes(32).toString('hex');
  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });

  // Intercept ONLY the on-box Ollama traffic — every other fetch (our own REST calls to srv.url)
  // passes through to the real implementation. OLLAMA_URL is set so the endpoint's pre-guard
  // ("no AI model connected") passes and we exercise the CONSENT gate, not the pre-guard.
  process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
  // Hermeticity: the endpoint boots a REAL server that reads process.env, and env.LOCAL_MODEL
  // counts as an operator approval under requireApprovedLocal — so a machine that happens to
  // export LOCAL_MODEL would resolve a model and make S4 miss the refusal. Null it for the
  // duration (restored in finally) so this gate tests consent, not the host's environment.
  const savedLocalModel = process.env.LOCAL_MODEL;
  delete process.env.LOCAL_MODEL;
  const realFetch = globalThis.fetch;
  const ollama = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/generate') || u.includes('/api/chat')) {
      let model = null; try { model = JSON.parse(opts?.body || '{}').model ?? null; } catch { /* */ }
      ollama.push({ model });
      return new Response(JSON.stringify({ response: 'Area summary.', prompt_eval_count: 5, eval_count: 5 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  const userId = 'local-user';
  const base = `${srv.url}/api/v1/portal`;
  const summaryOf = async (id) => {
    const r = await fetch(`${base}/contexts/${id}/summary`, { method: 'POST' });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const persistedSummary = async (id) =>
    (await srv.db._base.d1Query('SELECT summary FROM sharing_contexts WHERE id = ?', [id])).results?.[0]?.summary ?? null;

  try {
    // Seed a real area with one real attached document (getDocuments drops rows whose
    // documents row is missing, so the doc must exist with a title/summary).
    const ctxId = await srv.db.contexts.create(userId, { name: 'Health' });
    await srv.db.documents.upsert({ user_id: userId, path: 'health/run.md', title: 'Morning run', summary: 'A 5k run before work.', content: 'ran 5k' });
    await srv.db.contexts.addDocument(ctxId, 'health/run.md');

    // S4) fresh vault → nothing approved → honest 503, no Ollama, no summary written.
    const a = await summaryOf(ctxId);
    assert.equal(a.status, 503, `no approved model must yield 503, not a fabricated summary — got ${a.status} ${JSON.stringify(a.body)}`);
    assert.match(String(a.body?.error || ''), /approve one in Settings/i, `the 503 must point the owner at Settings → Intelligence — got "${a.body?.error}"`);
    assert.equal(ollama.length, 0, 'the endpoint must not have contacted Ollama (no silent llama3.1)');
    assert.equal(await persistedSummary(ctxId), null, 'and it must not persist a summary from a model that never ran');

    // S5) approve the on-box model via the REAL route the UI calls → the endpoint runs IT.
    const put = await fetch(`${base}/providers/task-models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ task: 'categorize', model: 'qwen3.5:4b' }) });
    assert.equal(put.status, 200, `approving the on-box model must succeed — got ${put.status}`);

    const b = await summaryOf(ctxId);
    assert.equal(b.status, 200, `an approved vault must summarize — got ${b.status} ${JSON.stringify(b.body)}`);
    assert.equal(b.body?.summary, 'Area summary.', 'the approved model produced the summary');
    assert.equal(ollama.length, 1, 'exactly one on-box call now that a model is approved');
    assert.equal(ollama[0].model, 'qwen3.5:4b', `the endpoint ran the APPROVED model — got ${ollama[0].model}`);
    assert.notEqual(ollama[0].model, DEFAULT_LOCAL_MODEL, 'never the hardcoded default');
    assert.equal(await persistedSummary(ctxId), 'Area summary.', 'and the summary is persisted');
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OLLAMA_URL;
    if (savedLocalModel === undefined) delete process.env.LOCAL_MODEL; else process.env.LOCAL_MODEL = savedLocalModel;
    try { srv.server.close(); srv.close?.(); } catch { /* */ }
    for (const s of ['', '-shm', '-wal']) { try { rmSync(`${DB}${s}`); } catch { /* */ } }
    try { rmSync(KCV); } catch { /* */ }
  }
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the Areas summary refuses an un-approved on-box model and runs only what the owner approved' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
