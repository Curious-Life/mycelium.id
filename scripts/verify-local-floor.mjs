// verify:local-floor — the cascade's on-box floor must STAY on-box, and the egress audit
// must never describe a cloud call as 'local'. (§4g sovereignty + §8 audit truthfulness.)
//
//   LF1 the floor element blanks its cloud fields ('' — the only value `??` won't coalesce)
//   LF2 THE BUG: stray ANTHROPIC_API_KEY + sensitive:true → the floor runs ON-BOX, not Anthropic
//   LF3 …and no egress row claims 'local' for a call that left the box
//   LF4 a localFallback router is structurally cloud-less (hasCloud false + creds stripped)
//   LF5 audit truthfulness is INDEPENDENT of the floor: a 'local'-tagged router holding a
//       cloud key still cannot report 'local', and §4g still fires
//   LF6 NO FALSE POSITIVE: a real on-box Ollama (jurisdiction 'local' + loopback base_url)
//       still serves sensitive work and is still audited, honestly, as 'local'
//   LF7 class-check: a native-OpenAI row does not inherit a stray INFERENCE_BASE_URL
//
// WHY THIS GATE EXISTS: every other inference gate either injects `env:{}` or DELETES the
// cloud keys from process.env for isolation (correct for their purpose) — which means none of
// them can ever OBSERVE this class of bug. This one deliberately puts a stray key IN the env.
//
// Asserts the IDENTITY of what answered (LOCAL_HELLO vs ANTHROPIC_HELLO), never a call count
// alone: a counter cannot tell "the floor stayed local" from "the floor never ran".
// Mock fetch throughout — no real network. Never logs a key.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { resolveProviderChain, resolveInferenceConfig } from '../src/inference/resolve.js';
import { inferWithCascade } from '../src/inference/cascade.js';
import { createInferenceRouter } from '../src/inference/router.js';

const DB = 'data/verify-local-floor.db', KCV = 'data/verify-local-floor-kcv.json';

// This gate deliberately puts stray keys IN process.env, so its cleanup is registered BEFORE
// anything can throw — a check that fails early must not leave a temp vault, or (worse) a stray
// ANTHROPIC_API_KEY, behind for whatever runs next in the chain.
// `process.env.X = undefined` STRINGIFIES to "undefined", so an assignment can never restore an
// absent var: delete-or-set, uniformly.
const savedEnv = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, b: process.env.INFERENCE_BASE_URL };
const restoreEnv = () => {
  for (const [k, v] of [['ANTHROPIC_API_KEY', savedEnv.a], ['OPENAI_API_KEY', savedEnv.o], ['INFERENCE_BASE_URL', savedEnv.b]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};
const cleanup = () => {
  restoreEnv();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* best effort */ } }
};
process.on('exit', cleanup);

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// ── mock fetch: route by host, and record WHO was dialled ────────────────────
let anthropicCalls = 0, openaiCalls = 0, ollamaGenCalls = 0, ollamaChatCalls = 0, strayHostCalls = 0, mdnsCalls = 0, attackerCalls = 0;
const seenHosts = [];
const ok = (obj) => ({ ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify(obj); }, async json() { return obj; } });
const mockFetch = async (url) => {
  const u = String(url);
  seenHosts.push(u);
  if (u.includes('/api/generate')) { ollamaGenCalls++; return ok({ response: 'LOCAL_HELLO' }); }
  if (u.includes('api.anthropic.com')) { anthropicCalls++; return ok({ content: [{ type: 'text', text: 'ANTHROPIC_HELLO' }] }); }
  if (u.includes('api.openai.com')) { openaiCalls++; return ok({ choices: [{ message: { content: 'OPENAI_HELLO' } }] }); }
  if (u.includes('mymac.local')) { mdnsCalls++; return ok({ choices: [{ message: { content: 'MDNS_HELLO' } }] }); }
  if (u.includes('localhost.attacker.io')) { attackerCalls++; return ok({ choices: [{ message: { content: 'ATTACKER_HELLO' } }] }); }
  if (u.includes('127.0.0.1')) { ollamaChatCalls++; return ok({ choices: [{ message: { content: 'OLLAMA_CHAT_HELLO' } }] }); }
  if (u.includes('stray-host.example')) { strayHostCalls++; return ok({ choices: [{ message: { content: 'STRAY_HELLO' } }] }); }
  return ok({ choices: [{ message: { content: 'UNKNOWN_HELLO' } }] });
};
const reset = () => { anthropicCalls = openaiCalls = ollamaGenCalls = ollamaChatCalls = strayHostCalls = mdnsCalls = attackerCalls = 0; seenHosts.length = 0; };

// ── LF1 — the floor blanks its cloud fields ─────────────────────────────────
{
  const chain = await resolveProviderChain(db, U);           // no providers configured → [floor]
  const floor = chain[chain.length - 1];
  // '' — NOT null/undefined. `null ?? env.X` still yields env.X; only '' survives the coalesce.
  rec('LF1. floor element blanks anthropicApiKey/openaiApiKey/baseUrl with \'\' (not null)',
    floor.localFallback === true && floor.jurisdiction === 'local'
    && floor.anthropicApiKey === '' && floor.openaiApiKey === '' && floor.baseUrl === '',
    JSON.stringify(floor));
}

// ── LF2 / LF3 — THE BUG, reproduced on the real call shape ──────────────────
// A stray ANTHROPIC_API_KEY in the operator's env + the cascade enabled + sensitive content.
// Pre-fix: hasCloud() went true off the env key, /^us/.test('local') was false so §4g never
// fired, and the prompt went to api.anthropic.com — stamped 'local' in the audit.
process.env.ANTHROPIC_API_KEY = 'sk-ant-STRAY';
process.env.OPENAI_API_KEY = 'sk-openai-STRAY';
{
  reset();
  const egress = [];
  const chain = await resolveProviderChain(db, U, { sensitive: true });   // → [floor] only
  const out = await inferWithCascade({ chain, prompt: 'a private thought', task: 'complex', sensitive: true, fetch: mockFetch, onEgress: (e) => egress.push(e) });

  // IDENTITY, not a count: the answer must be the on-box model's, and Anthropic must be untouched.
  rec('LF2. stray ANTHROPIC_API_KEY + sensitive → the floor answers ON-BOX (never Anthropic)',
    out === 'LOCAL_HELLO' && anthropicCalls === 0 && ollamaGenCalls === 1,
    `out=${JSON.stringify(out)} anthropic=${anthropicCalls} ollamaGen=${ollamaGenCalls} hosts=${JSON.stringify(seenHosts)}`);

  // §8: a row may only say 'local' if the bytes truly stayed on-box. Nothing left the box here,
  // so the strong form holds: no ALLOWED cloud egress row at all.
  const cloudRows = egress.filter((e) => e.decision === 'allowed');
  const lyingRows = egress.filter((e) => e.jurisdiction === 'local' && e.decision === 'allowed');
  rec('LF3. no egress row claims \'local\' for a cloud call (audit truthfulness, §8)',
    lyingRows.length === 0 && cloudRows.length === 0,
    `rows=${JSON.stringify(egress.map((e) => ({ j: e.jurisdiction, d: e.decision, r: e.reason })))}`);
}

// ── LF2b — the check that isolates the FLOOR from the AUDIT layer ───────────
// ⚠️ LF2 above cannot red-test the floor fix on its own: revert the floor entirely and LF2
// still passes, because the audit layer independently re-tags the destination us-standard and
// §4g then blocks the sensitive call. That is defence in depth working — and exactly why a
// gate must be red-tested rather than trusted.
//
// A NON-SENSITIVE floor request is the isolating case: §4g does not protect it, so only the
// FLOOR fix keeps it on-box. It also shows the harm is not merely the §4g bypass — a floor that
// egresses spends the operator's key and ships plaintext to a US provider for ordinary content
// too, which §4g would never have caught.
//
// ⚠️ WHAT IT ISOLATES, EXACTLY (an earlier version of this comment got this wrong, and a review
// caught it — the same false-confidence defect this gate exists to prevent): LF2b isolates the
// floor PAIR from the audit layer. It does NOT red-test either floor half alone, because the
// two are independent and each holds on its own:
//     revert BOTH floor halves → LF2b FAILS   ← the property it actually guards
//     revert the '' data half  → LF2b passes  (localOnly still refuses the cloud branch); LF1 catches it
//     revert localOnly         → LF2b passes  (the '' fields still block the env coalesce); LF4 catches it
// So: LF1 + LF4 pin the halves, LF2b pins the pair. Do not read a LF2b pass as "localOnly works".
{
  reset();
  process.env.ANTHROPIC_API_KEY = 'sk-ant-STRAY';
  const chain = await resolveProviderChain(db, U);
  const out = await inferWithCascade({ chain, prompt: 'hi', task: 'complex', sensitive: false, fetch: mockFetch });
  rec('LF2b. stray key + NON-sensitive → the floor STILL answers on-box (isolates the floor layer)',
    out === 'LOCAL_HELLO' && anthropicCalls === 0 && ollamaGenCalls === 1,
    `out=${JSON.stringify(out)} anthropic=${anthropicCalls} ollamaGen=${ollamaGenCalls} hosts=${JSON.stringify(seenHosts)}`);
}

// ── LF4 — the structural half: a localFallback router has no cloud at all ───
{
  const r = createInferenceRouter({ jurisdiction: 'local', localFallback: true, fetch: mockFetch });  // real process.env, stray key present
  rec('LF4. localFallback router: hasCloud() false + credentials stripped (env cannot promote)',
    r.hasCloud() === false && r.config.anthropicConfigured === false && r.config.openaiConfigured === false,
    JSON.stringify({ hasCloud: r.hasCloud(), ...r.config }));
}

// ── LF7 — same class, no feature flag: native-OpenAI row + stray base_url ───
{
  reset();
  process.env.INFERENCE_BASE_URL = 'https://stray-host.example/v1';
  const oid = await db.providers.create(U, { provider: 'openai', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-openai-REAL' }), model: 'gpt-4o-mini' });
  await db.providers.setActive(oid, U);
  const cfg = await resolveInferenceConfig(db, U);
  const r = createInferenceRouter({ ...cfg, fetch: mockFetch });
  const out = await r.infer({ prompt: 'hi', task: 'complex', sensitive: false });
  rec('LF7. a configured OpenAI row does not inherit a stray INFERENCE_BASE_URL',
    cfg.baseUrl === '' && out === 'OPENAI_HELLO' && strayHostCalls === 0 && openaiCalls === 1,
    `cfgBaseUrl=${JSON.stringify(cfg.baseUrl)} out=${JSON.stringify(out)} stray=${strayHostCalls} openai=${openaiCalls}`);
  await db.providers.remove(oid, U);
  delete process.env.INFERENCE_BASE_URL;
}

restoreEnv();   // stray keys are done doing their job — put the env back before LF5/LF6

// ── LF5 — audit truthfulness stands ALONE (no floor, no flag involved) ──────
// A router tagged 'local' that actually holds a cloud key. This is the layer that must hold
// even if the floor fix above were reverted: the tag cannot outrank the destination.
{
  reset();
  const egress = [];
  // (a) sensitive → §4g must fire, because the effective jurisdiction is us-standard, not 'local'
  const r = createInferenceRouter({ jurisdiction: 'local', anthropicApiKey: 'sk-ant-MISTAGGED', env: {}, fetch: mockFetch, onEgress: (e) => egress.push(e) });
  const out = await r.infer({ prompt: 'a private thought', task: 'complex', sensitive: true });
  rec('LF5a. a \'local\'-tagged router holding a cloud key: §4g still blocks sensitive → on-box',
    out === 'LOCAL_HELLO' && anthropicCalls === 0 && egress.every((e) => e.jurisdiction !== 'local'),
    `out=${JSON.stringify(out)} anthropic=${anthropicCalls} rows=${JSON.stringify(egress.map((e) => ({ j: e.jurisdiction, d: e.decision })))}`);

  // (b) non-sensitive → the call DOES egress; the row must name the real destination.
  reset(); egress.length = 0;
  const out2 = await r.infer({ prompt: 'hi', task: 'complex', sensitive: false });
  const row = egress.find((e) => e.decision === 'allowed');
  rec('LF5b. when the bytes DO leave, the audit row says us-standard — never \'local\'',
    out2 === 'ANTHROPIC_HELLO' && anthropicCalls === 1 && !!row && row.jurisdiction === 'us-standard',
    `out=${JSON.stringify(out2)} anthropic=${anthropicCalls} row=${JSON.stringify(row && { j: row.jurisdiction, d: row.decision })}`);
}

// ── LF6 — the false positive this must NOT introduce ────────────────────────
// Ollama/LM Studio are legitimately jurisdiction:'local' WITH a loopback base_url (presets.js).
// A blanket "'local' → 'us-standard'" would make §4g refuse the user's own on-box model and
// push sensitive work AWAY from the private path. The destination decides, not the tag.
{
  reset();
  const egress = [];
  const r = createInferenceRouter({ jurisdiction: 'local', baseUrl: 'http://127.0.0.1:11434/v1', anthropicApiKey: '', openaiApiKey: '', cloudModel: 'qwen3', env: {}, fetch: mockFetch, onEgress: (e) => egress.push(e) });
  const out = await r.infer({ prompt: 'a private thought', task: 'complex', sensitive: true });
  const row = egress.find((e) => e.decision === 'allowed');
  rec('LF6. a real on-box Ollama still serves sensitive work, audited honestly as \'local\'',
    out === 'OLLAMA_CHAT_HELLO' && ollamaChatCalls === 1 && anthropicCalls === 0 && !!row && row.jurisdiction === 'local',
    `out=${JSON.stringify(out)} ollamaChat=${ollamaChatCalls} row=${JSON.stringify(row && { j: row.jurisdiction, d: row.decision })}`);
}

// ── LF6b — the mDNS member of the rule, RECONCILED to #175 ───────────────────
// This assertion originally pinned the pre-#175 vocabulary (jurisdictionForBaseUrl minted
// 'local' for any `*.local` host) and expected the mDNS model to serve sensitive work. #175
// (merged first) deliberately KILLED that mapping: mDNS names a DIFFERENT machine — link-local
// trust is not device trust — so `.local` now falls to the us-standard fail-safe and a
// sensitive task must NOT reach it. The two PRs shipped opposite expectations for the same
// URL; the landed, stricter rule wins (fail-closed). ⚠️ OPEN UX QUESTION for the operator, on
// record: a LAN homelab Ollama addressed as `mymac.local` is now refused for sensitive tasks.
// Re-allowing it would need an explicit jurisdiction concept for "my LAN, my hardware"
// ('lan'?), decided as a §4g policy change — not re-widened here by a gate.
{
  reset();
  const egress = [];
  // https, not http: base-url.js#assertSafeBaseUrl allows plaintext http ONLY for loopback, so an
  // `http://…​.local` model is refused at the wire regardless of §4g. https is the reachable shape.
  const r = createInferenceRouter({ jurisdiction: 'local', baseUrl: 'https://mymac.local:11434/v1', anthropicApiKey: '', openaiApiKey: '', cloudModel: 'qwen3', env: {}, fetch: mockFetch, onEgress: (e) => egress.push(e) });
  const out = await r.infer({ prompt: 'a private thought', task: 'complex', sensitive: true });
  rec('LF6b. an mDNS .local host is NOT sovereign (#175): sensitive work never reaches it, never audited \'local\'',
    out === 'LOCAL_HELLO' && mdnsCalls === 0 && anthropicCalls === 0 && egress.every((e) => e.jurisdiction !== 'local' || e.decision !== 'allowed' || !String(e.baseUrl || '').includes('mymac.local')),
    `out=${JSON.stringify(out)} mdns=${mdnsCalls} rows=${JSON.stringify(egress.map((e) => ({ j: e.jurisdiction, d: e.decision })))}`);
}

// ── LF6c — …and the tag still cannot launder a genuinely remote host ────────
// The counterpart to LF6b: reusing jurisdictionForBaseUrl must not become a rubber stamp.
{
  reset();
  const egress = [];
  const r = createInferenceRouter({ jurisdiction: 'local', baseUrl: 'https://localhost.attacker.io/v1', anthropicApiKey: '', openaiApiKey: '', env: {}, fetch: mockFetch, onEgress: (e) => egress.push(e) });
  const out = await r.infer({ prompt: 'a private thought', task: 'complex', sensitive: true });
  rec('LF6c. a \'local\'-tagged but REMOTE host (localhost.attacker.io) is still blocked + never audited \'local\'',
    out === 'LOCAL_HELLO' && attackerCalls === 0 && egress.every((e) => e.jurisdiction !== 'local'),
    `out=${JSON.stringify(out)} attacker=${attackerCalls} rows=${JSON.stringify(egress.map((e) => ({ j: e.jurisdiction, d: e.decision })))}`);
}

await close?.();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
console.log(passed === ledger.length ? 'VERDICT: GO' : 'VERDICT: NO-GO');
process.exit(passed === ledger.length ? 0 : 1);
