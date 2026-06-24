// verify:harness-budget — Step 7c: 'harness' task routing + the scheduler daily-token
// budget gate + the provider-fallback chain wired into runAgentTurn. Over a REAL vault.
//   BG1 'harness' is in INFERENCE_TASKS (per-task model routing)
//   BG2 over daily budget → task skipped-budget, the turn does NOT run
//   BG3 under budget → the turn runs
//   BG4 budget unset → unlimited (turn runs)
//   BG5 runAgentTurn passes a providerChain (resolved primary first, on-box local floor last)
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { createScheduler } from '../src/agent/scheduler.js';
import { runAgentTurn } from '../src/agent/run-turn.js';
import { INFERENCE_TASKS } from '../src/inference/resolve.js';

const DB = 'data/verify-harness-budget.db', KCV = 'data/verify-harness-budget-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

// ── BG1 'harness' task ──
rec("BG1 'harness' ∈ INFERENCE_TASKS", INFERENCE_TASKS.includes('harness'), INFERENCE_TASKS.join(','));

// ── Budget gate (BG2-BG4) ──
const ran = [];
const sched = createScheduler({ db, userId: U, runTurn: async (task) => { ran.push(task.id); return { text: 'ok' }; }, logger: () => {} });
// Seed ~1200 tokens of usage today.
await db.usage.record(U, { source: 'scheduler', area: 'chat', inputTokens: 600, outputTokens: 600 });
const dueTask = async (name) => db.harness.createTask(U, { name, prompt: 'p', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'none' });

{
  process.env.MYCELIUM_DAILY_TOKEN_BUDGET = '1000';   // spent 1200 ≥ 1000 → skip
  const id = await dueTask('over');
  await sched.tickOnce();
  const t = await db.harness.getTask(U, id);
  rec('BG2 over budget → skipped-budget, turn not run', !ran.includes(id) && t.last_status === 'skipped-budget', `last=${t.last_status}`);
}
{
  process.env.MYCELIUM_DAILY_TOKEN_BUDGET = '100000';  // spent 1200 < 100000 → run
  const id = await dueTask('under');
  await sched.tickOnce();
  rec('BG3 under budget → turn runs', ran.includes(id));
}
{
  delete process.env.MYCELIUM_DAILY_TOKEN_BUDGET;       // unset → unlimited
  const id = await dueTask('unset');
  await sched.tickOnce();
  rec('BG4 budget unset → unlimited (turn runs)', ran.includes(id));
}

// ── BG5 provider-chain wiring ──
{
  // Seed an active Anthropic provider so a primary resolves + the chain has a cloud head.
  const pid = await db.providers.create(U, { provider: 'anthropic', label: 'Anthropic', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-test' }), model: 'claude-x' });
  await db.providers.setActive(pid, U);
  let captured = null;
  const fakeLoop = { run: async (opts) => { captured = opts; return { text: 'x', toolsUsed: [] }; } };
  const r = await runAgentTurn(
    { db, userId: U, tools: [], handlers: { getContext: async () => '' }, loop: fakeLoop, fetchImpl: async () => { throw new Error('no-net'); } },
    { userMessage: 'hi', systemExtra: 'X' },
  );
  const chain = captured?.providerChain;
  rec('BG5 runAgentTurn passed a providerChain (not skipped)', !r?.skipped && Array.isArray(chain) && chain.length >= 2, `len=${chain?.length}`);
  rec('BG5 primary first = the resolved provider (anthropic)', !!chain?.[0]?.anthropicApiKey);
  rec('BG5 on-box local floor is the terminal element', chain?.[chain.length - 1]?.jurisdiction === 'local' && chain[chain.length - 1].localFallback === true);
  rec('BG5 single provider also still passed as `provider`', !!captured?.provider?.anthropicApiKey);
}

await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? "GO — budget+routing: 'harness' task · daily-budget skip (over/under/unset) · providerChain wired (primary-first · local-floor-last)" : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
