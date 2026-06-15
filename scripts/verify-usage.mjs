// verify:usage — token-usage accounting end-to-end (§12). Boots a temp vault and
// drives the router (local + cloud, actual counts + estimate fallback) and the
// chat harness through INJECTED fetch, then asserts every call persisted a
// llm_usage row with correct dimensions, that summary() aggregates by area/
// provider/model and splits input vs output, and the HARD invariant: NO prompt or
// completion text ever lands in llm_usage (counts + dimensions only).
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createInferenceRouter } from '../src/inference/router.js';
import { createUsageSink } from '../src/inference/usage.js';
import { createAgentHarness } from '../src/agent/harness.js';

const DB = 'data/verify-usage.db', KCV = 'data/verify-usage-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const SECRET = 'SECRET_HEALTH_DIARY_TEXT_xyz';   // a recognizable prompt to prove it is never stored
const enc = new TextEncoder();
const streamRes = (chunks) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(x)); c.close(); } }) });
const sse = (objs) => objs.map((o) => (o === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(o)}\n\n`));

const usageSink = createUsageSink(db, U, { source: 'enrichment' });
rec('U0. usage sink builds when db.usage present', typeof usageSink === 'function');

// ── 1) LOCAL infer: Ollama /api/generate reports real counts ─────────────────
{
  const ollamaFetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ response: 'a local answer', prompt_eval_count: 123, eval_count: 45 }); } });
  const router = createInferenceRouter({ fetch: ollamaFetch, onUsage: usageSink, ollamaUrl: 'http://127.0.0.1:11434' });
  await router.infer({ prompt: `${SECRET} summarize`, task: 'summarize' });
}
// ── 2) CLOUD infer (anthropic): usage.input_tokens/output_tokens ─────────────
{
  const anthFetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ content: [{ type: 'text', text: 'cloud answer' }], usage: { input_tokens: 200, output_tokens: 60 } }); } });
  const router = createInferenceRouter({ fetch: anthFetch, onUsage: usageSink, anthropicApiKey: 'sk-ant', cloudModel: 'claude-opus-4-8', jurisdiction: 'us-standard' });
  await router.infer({ prompt: `${SECRET} narrate`, task: 'narrate' });
}
// ── 3) ESTIMATE FALLBACK: local returns NO counts → estimated=1, chars/4 ──────
{
  const noCountFetch = async () => ({ ok: true, status: 200, async text() { return JSON.stringify({ response: 'xxxx' }); } }); // 4 chars → 1 output token
  const router = createInferenceRouter({ fetch: noCountFetch, onUsage: usageSink, ollamaUrl: 'http://127.0.0.1:11434' });
  await router.infer({ prompt: 'abcdefgh', task: 'classify' }); // 8 chars → 2 input tokens
}
// ── 4) CHAT harness (openai-compat stream w/ usage) → source 'chat' ──────────
{
  const chatSink = createUsageSink(db, U, { source: 'chat' });
  const oFinal = sse([
    { choices: [{ index: 0, delta: { content: 'hello from chat' } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { usage: { prompt_tokens: 77, completion_tokens: 11 }, choices: [] },
    '[DONE]',
  ]);
  const queue = [streamRes(oFinal)];
  const h = createAgentHarness({ onUsage: chatSink, fetch: async () => queue.shift() });
  await h.streamTurn({ provider: { openaiApiKey: 'sk', cloudModel: 'gpt-4o', jurisdiction: 'us-standard' }, system: SECRET, userMessage: `${SECRET} hi`, tools: [], call: async () => 'x', send: () => {} });
}

// give the fire-and-forget inserts a tick to flush
await new Promise((r) => setTimeout(r, 50));

// ── Assertions on persisted rows ─────────────────────────────────────────────
const rows = (await db.rawQuery('SELECT * FROM llm_usage WHERE user_id = ? ORDER BY at ASC', [U])).results || [];
rec('A1. four usage rows persisted (local, cloud, fallback, chat)', rows.length === 4, `rows=${rows.length}`);

const local = rows.find((r) => r.area === 'summarize');
rec('A2. LOCAL row: actual counts (123/45), is_local=1, estimated=0', local && local.input_tokens === 123 && local.output_tokens === 45 && local.is_local === 1 && local.estimated === 0, JSON.stringify(local && { i: local.input_tokens, o: local.output_tokens, l: local.is_local, e: local.estimated }));

const cloud = rows.find((r) => r.area === 'narrate');
rec('A3. CLOUD row: actual counts (200/60), provider anthropic, model+jurisdiction, estimated=0', cloud && cloud.input_tokens === 200 && cloud.output_tokens === 60 && cloud.provider === 'anthropic' && cloud.model === 'claude-opus-4-8' && cloud.jurisdiction === 'us-standard' && cloud.estimated === 0, JSON.stringify(cloud && { i: cloud.input_tokens, o: cloud.output_tokens, p: cloud.provider, m: cloud.model }));

const est = rows.find((r) => r.area === 'classify');
rec('A4. FALLBACK row: estimated=1, chars/4 (in=2 from 8 chars, out=1 from 4 chars)', est && est.estimated === 1 && est.input_tokens === 2 && est.output_tokens === 1, JSON.stringify(est && { i: est.input_tokens, o: est.output_tokens, e: est.estimated }));

const chat = rows.find((r) => r.area === 'chat');
rec('A5. CHAT row: source=chat, actual counts (77/11), provider openai', chat && chat.source === 'chat' && chat.input_tokens === 77 && chat.output_tokens === 11 && chat.provider === 'openai', JSON.stringify(chat && { s: chat.source, i: chat.input_tokens, o: chat.output_tokens, p: chat.provider }));

// ── HARD privacy invariant: no column in any row contains the prompt text ────
const leaked = rows.some((r) => Object.values(r).some((v) => typeof v === 'string' && v.includes(SECRET)));
rec('A6. NO prompt/response text in any llm_usage column (counts + dimensions only)', !leaked);
// table has no content-bearing columns at all
const cols = (await db.rawQuery('PRAGMA table_info(llm_usage)', [])).results.map((c) => c.name);
rec('A7. schema has no content column (no prompt/response/text/content)', !cols.some((c) => /prompt|response|content|text|message/i.test(c)), cols.join(','));

// ── Aggregation: summary() splits input vs output + groups ───────────────────
const sum = await db.usage.summary(U, { sinceDays: 30 });
rec('A8. totals: input = 123+200+2+77 = 402', sum.totals.inputTokens === 402, `input=${sum.totals.inputTokens}`);
rec('A9. totals: output = 45+60+1+11 = 117', sum.totals.outputTokens === 117, `output=${sum.totals.outputTokens}`);
rec('A10. totals: 4 events', sum.totals.events === 4, `events=${sum.totals.events}`);
rec('A11. byArea has summarize/narrate/classify/chat', ['summarize', 'narrate', 'classify', 'chat'].every((a) => sum.byArea.some((x) => x.key === a)), sum.byArea.map((x) => x.key).join(','));
rec('A12. bySource: chat vs enrichment split', sum.bySource.some((x) => x.key === 'chat') && sum.bySource.some((x) => x.key === 'enrichment'), sum.bySource.map((x) => `${x.key}:${x.inputTokens}+${x.outputTokens}`).join(' '));
rec('A13. byProvider includes anthropic + openai + local', ['anthropic', 'openai', 'local'].every((p) => sum.byProvider.some((x) => x.key === p)), sum.byProvider.map((x) => x.key).join(','));
rec('A14. byModel includes claude-opus-4-8 + gpt-4o', sum.byModel.some((x) => x.key === 'claude-opus-4-8') && sum.byModel.some((x) => x.key === 'gpt-4o'), sum.byModel.map((x) => x.key).join(','));
rec('A15. byDay non-empty + carries input/output', sum.byDay.length >= 1 && sum.byDay[0].inputTokens >= 0, JSON.stringify(sum.byDay));

const recent = await db.usage.recent(U, 50);
rec('A16. recent() returns 4 shaped events newest-first', recent.length === 4 && typeof recent[0].area === 'string' && typeof recent[0].inputTokens === 'number', `n=${recent.length}`);

// ── Sink is fail-soft when db has no usage namespace ─────────────────────────
rec('A17. createUsageSink → undefined when db has no usage namespace', createUsageSink({}, U) === undefined && createUsageSink(db, '') === undefined);

// ── A18) STREAMING estimate fallback: provider streams text but reports NO counts
//     → output estimated from the ACCUMULATED stream text (not 1), estimated=1.
{
  const sink = createUsageSink(db, U, { source: 'enrichment' });
  const nd = (objs) => objs.map((o) => JSON.stringify(o) + '\n');
  const sres = (lines) => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { for (const x of lines) c.enqueue(enc.encode(x)); c.close(); } }) });
  // Ollama NDJSON stream with NO prompt_eval_count/eval_count on the done event.
  const fetchStream = async () => sres(nd([{ response: 'hello ', done: false }, { response: 'there friend', done: false }, { response: '', done: true }]));
  const router = createInferenceRouter({ fetch: fetchStream, onUsage: sink, ollamaUrl: 'http://127.0.0.1:11434' });
  let acc = '';
  for await (const d of router.inferStream({ prompt: 'abcd', task: 'summarize' })) acc += d;
  await new Promise((r) => setTimeout(r, 50));
  const row = (await db.rawQuery("SELECT area, input_tokens, output_tokens, estimated FROM llm_usage WHERE user_id=? AND area='summarize' ORDER BY at DESC LIMIT 1", [U])).results?.[0];
  rec('A18. streaming no-count → output estimated from accumulated text (not 1)', acc === 'hello there friend' && row && row.estimated === 1 && row.output_tokens === Math.ceil('hello there friend'.length / 4) && row.output_tokens > 1, JSON.stringify(row));
}

// ── A19) recordContentFlow: estimated ingest/import token-flow row ────────────
{
  const { recordContentFlow } = await import('../src/inference/usage.js');
  recordContentFlow(db, U, { source: 'ingest', area: 'import', content: ['x'.repeat(4000), 'y'.repeat(2000)] }); // 1000 + 500 = 1500 tokens
  await new Promise((r) => setTimeout(r, 50));
  const row = (await db.rawQuery("SELECT source, area, provider, input_tokens, output_tokens, estimated, is_local FROM llm_usage WHERE user_id=? AND source='ingest' ORDER BY at DESC LIMIT 1", [U])).results?.[0];
  rec('A19. recordContentFlow → ingest/import row, estimated, input=Σchars/4, output=0', row && row.source === 'ingest' && row.area === 'import' && row.estimated === 1 && row.input_tokens === 1500 && row.output_tokens === 0 && row.provider === null, JSON.stringify(row));
  const s2 = await db.usage.summary(U, { sinceDays: 1 });
  rec('A20. summary surfaces the ingest source + import area', s2.bySource.some((x) => x.key === 'ingest') && s2.byArea.some((x) => x.key === 'import'), `${s2.bySource.map((x) => x.key)} | ${s2.byArea.map((x) => x.key)}`);
}

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — token usage captured (actual + estimate-fallback) across local/cloud/chat, persisted with dimensions, aggregated by area/source/provider/model/day; NO content stored' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
