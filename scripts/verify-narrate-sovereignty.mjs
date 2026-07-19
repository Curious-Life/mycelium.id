// verify:narrate-sovereignty — narrate is NO LONGER §4g-limited, and the §4g machinery still
// protects the callers that pass sensitive:true EXPLICITLY.
//
// THE CHANGE (operator decision, 2026-07-19). `narrate` — the "Descriptions" task (mindscape
// names + chronicles) — used to sit in SENSITIVE_TASKS, so the router refused a US provider for
// it and the Intelligence screen offered only EU/on-device. The operator lifted that limit:
// Descriptions may now be assigned to ANY connected provider, US included. The recommendation
// stays EU-ZDR (Regolo), but it is a recommendation, not a wall.
//
// This gate inverts what it used to prove, and adds the check the removal makes load-bearing:
//   GROUP A — narrate is UNRESTRICTED: router.infer / inferStream / cascade run it on a US
//             provider with NO refusal (this is the change), and EU still works.
//   GROUP B — the LIVE path: run-turn hands the loop the SELECTED US provider — not skipped, not
//             silently downgraded to local, no §4g-block audit. (The exact "no silent refusal
//             left" the security review requires.)
//   GROUP C — the §4g MACHINERY IS STILL LIVE: a caller that passes sensitive:true EXPLICITLY
//             (claims/discovery.js + claims/validator.js — the persona/claim abstractions) is
//             STILL refused a US provider. Removing narrate from the default set must not have
//             weakened the gate itself. Also: the wrapper (cascade) honours an explicit flag, the
//             subscription opt-in still exempts, and the sensitive chain still fail-closes.
//
// The on-device HONESTY checks (isLoopbackUrl / jurisdictionForBaseUrl / isOnBoxCfg + the audit
// that narrate never takes a SILENT off-box direct-fetch branch) are orthogonal to §4g and STAY:
// even a now-permitted off-box narrate must be routed + AUDITED, never dialled unrecorded.
import crypto from 'node:crypto';
import { createInferenceRouter } from '../src/inference/router.js';
import { isSensitiveTask, SENSITIVE_TASKS } from '../src/inference/sensitivity.js';
import { resolveInferenceConfigForTask, resolveProviderChain, _setSubscriptionTokenReaderForTests } from '../src/inference/resolve.js';
import { runAgentTurn } from '../src/agent/run-turn.js';
import { isLoopbackUrl } from '../src/inference/local.js';
import { jurisdictionForBaseUrl } from '../src/inference/presets.js';
import { createNarrator, isOnBoxCfg } from '../pipeline/lib/narrate-infer.js';
import { inferWithCascade } from '../src/inference/cascade.js';

// HERMETIC: resolve.js's default reader spawns `security`/`claude` against the REAL machine
// keychain. resolve.js:60 exists precisely so verify:* doesn't ("overridable so verify:* is
// deterministic (no live keychain)").
_setSubscriptionTokenReaderForTests(async () => ({ claudeOAuthToken: 'sk-ant-oat-fake' }));

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

// Mirrors scripts/verify-egress.mjs: local Ollama → 'local-out'; cloud → 'cloud-out'.
const mockFetch = async (url) => {
  if (/\/api\/generate$/.test(url)) return { ok: true, status: 200, async text() { return JSON.stringify({ response: 'local-out' }); } };
  return { ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: 'cloud-out' } }] }); } };
};
const mkRouter = (jurisdiction, events, extra = {}) => createInferenceRouter({
  fetch: mockFetch,
  openaiApiKey: 'k', baseUrl: 'https://api.example.com/v1', jurisdiction,
  onEgress: (e) => events.push(e),
  env: {},
  ...extra,
});

// ── A1) the taxonomy — narrate is NO LONGER sensitive ─────────────────────────
rec('A1. narrate is NOT §4g-sensitive (limit lifted); chat/harness/reflection are not either; the set is EMPTY',
  isSensitiveTask('narrate') === false
  && ['chat', 'harness', 'reflection', 'categorize', 'enrich', 'summarize', 'complex'].every((t) => isSensitiveTask(t) === false)
  && SENSITIVE_TASKS instanceof Set && SENSITIVE_TASKS.size === 0,
  `sensitive={${[...SENSITIVE_TASKS].join(',')}}`);

// ── A2) ⭐ THE CHANGE — narrate + US, no flag ⇒ ALLOWED (it used to be refused) ─
// No `sensitive` argument — exactly how pipeline/lib/narrate-infer.js calls it.
let ev = [];
let out = await mkRouter('us-standard', ev).infer({ prompt: 'name this cluster of my themes', task: 'narrate' });
rec('A2. ⭐ narrate + US, caller passes NO flag ⇒ ALLOWED → cloud (the limit is gone; no silent refusal)',
  out === 'cloud-out' && ev[0]?.decision === 'allowed' && ev[0]?.reason == null,
  `out=${out} decision=${ev[0]?.decision} reason=${ev[0]?.reason}`);
rec('A2b. …and the ALLOWED egress is still audited by HASH — never the prompt (§1 observability survives)',
  ev[0]?.contentHash === crypto.createHash('sha256').update('name this cluster of my themes').digest('hex')
  && !JSON.stringify(ev[0] || {}).includes('themes'),
  `hash=${String(ev[0]?.contentHash).slice(0, 12)}…`);

// ── A3) the streaming twin ───────────────────────────────────────────────────
ev = [];
try { for await (const _d of mkRouter('us-standard', ev).inferStream({ prompt: 'chronicle my year', task: 'narrate' })) { /* drain */ } } catch { /* recorded below */ }
rec('A3. inferStream({task:"narrate"}) + US ⇒ ALLOWED too (same egress rule as infer, not denied)',
  ev[0]?.decision === 'allowed' && ev[0]?.reason == null,
  `decision=${ev[0]?.decision} reason=${ev[0]?.reason}`);

// ── A4) baseline — a plain non-sensitive cloud task still reaches US ──────────
ev = [];
out = await mkRouter('us-standard', ev).infer({ prompt: 'public', task: 'complex' });
rec('A4. a NON-sensitive cloud task still reaches US (unchanged baseline)',
  out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// ── A5) EU-ZDR still works — it IS the recommendation ─────────────────────────
ev = [];
out = await mkRouter('eu-zdr', ev).infer({ prompt: 'name this cluster', task: 'narrate' });
rec('A5. narrate + EU-ZDR ⇒ ALLOWED (Regolo is the recommended default; blocking it would be the bug)',
  out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// ── A6) the wrapper defaults from the task too — now non-sensitive ────────────
{
  const events = [];
  const chain = [{ jurisdiction: 'us-standard', openaiApiKey: 'k', baseUrl: 'https://api.example.com/v1' }];
  out = await inferWithCascade({ chain, prompt: 'name this cluster', task: 'narrate', fetch: mockFetch, onEgress: (e) => events.push(e) });
  rec('A6. inferWithCascade({task:"narrate"}) + US ⇒ ALLOWED (the wrapper derives the now-false default from the task)',
    out === 'cloud-out' && events[0]?.decision === 'allowed', `out=${out} decision=${events[0]?.decision}`);
}

// ── GROUP B — run-turn, the LIVE narration path (the security-review requirement) ─────
const usRow = { id: 'us1', provider: 'openai', model_preference: 'gpt-5', credentials: JSON.stringify({ apiKey: 'k' }), label: 'OpenAI' };
const euRow = { id: 'eu1', provider: 'custom', base_url: 'https://api.regolo.ai/v1', model_preference: 'qwen', credentials: JSON.stringify({ apiKey: 'k' }), label: 'Regolo.ai' };

function mkTurnDb(rows, { settings = {} } = {}) {
  const audits = [];
  return {
    audits,
    db: {
      users: { getSettings: async () => settings },
      providers: { list: async () => rows, get: async (id) => rows.find((r) => r.id === id) || null, getActive: async () => rows[0] || null },
      audit: { log: (r) => audits.push(r) },
    },
  };
}
// Records the provider run-turn ACTUALLY hands the loop — the only thing that decides where the
// content goes.
const mkLoop = (seen, result = { text: 'ok', toolsUsed: [] }) => ({ run: async ({ provider, providerChain }) => { seen.push({ provider, providerChain }); return result; } });
// loop.run NEVER THROWS (agent/loop.js): a dead wire is swallowed into `lastErr` and it returns
// `{text:''}`. So this is what an unreachable-but-selected model looks like to the caller.
const DEAD_WIRE = { text: '', toolsUsed: [], lastErr: 'harness: Ollama unreachable at http://127.0.0.1:11434/api/chat' };

// B1 — ⭐ THE PROOF the review asks for: narrate assigned to a US provider RUNS ON IT — not
// skipped, not downgraded to local, no §4g-block audit. A UI that offers US while the router
// still refused would be the silent lie the old gate existed to prevent; this proves the router
// really does run it.
{
  const seen = [];
  const { db, audits } = mkTurnDb([usRow], { settings: { taskModels: { narrate: { providerId: 'us1' } } } });
  const res = await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'name this cluster', inferenceTask: 'narrate' });
  const used = seen[0]?.provider;
  rec('B1. ⭐ narrate ASSIGNED to a US provider ⇒ run-turn hands the loop THAT US provider (no skip, no downgrade)',
    res?.skipped == null && /^us/.test(used?.jurisdiction || '') && used?.providerName !== 'claude_subscription',
    `skipped=${res?.skipped} usedJurisdiction=${used?.jurisdiction} model=${used?.cloudModel || used?.model}`);
  rec('B1b. …and NOTHING is audited as a §4g block — there is no refusal to audit anymore',
    !audits.some((a) => a.action === 'sensitive-us-block'),
    `audits=${JSON.stringify(audits.map((a) => a.action))}`);
}

// B2 — the assignment is HONOURED: narrate assigned to EU uses EU (not because §4g forced it,
// because the user picked it).
{
  const seen = [];
  const { db } = mkTurnDb([usRow, euRow], { settings: { taskModels: { narrate: { providerId: 'eu1' } } } });
  await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'x', inferenceTask: 'narrate' });
  const used = seen[0]?.provider;
  rec('B2. narrate assigned to an EU provider ⇒ uses EU (the pick is honoured)',
    used?.jurisdiction === 'eu-zdr', `usedJurisdiction=${used?.jurisdiction}`);
}

// B3 — CHAT is untouched (this was never a US ban, and still is not).
{
  const seen = [];
  const { db, audits } = mkTurnDb([usRow], { settings: { taskModels: { chat: { providerId: 'us1' } } } });
  await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'hi', inferenceTask: 'chat' });
  const used = seen[0]?.provider;
  rec('B3. CHAT on a US provider is UNTOUCHED (no §4g audit, runs on US)',
    /^us/.test(used?.jurisdiction || '') && audits.length === 0,
    `usedJurisdiction=${used?.jurisdiction} audits=${audits.length}`);
}

// B4 — the FALLBACK CHAIN is no longer §4g-filtered for narrate: it MAY carry a US provider, so
// a fallback isn't silently dropping the user's US choice either.
{
  const seen = [];
  const { db } = mkTurnDb([usRow, euRow], { settings: { taskModels: { narrate: { providerId: 'eu1' } } } });
  await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'x', inferenceTask: 'narrate' });
  const chain = seen[0]?.providerChain || [];
  rec('B4. the narrate fallback chain is NOT §4g-filtered — it carries the US provider (no silent drop)',
    chain.length > 0 && chain.some((c) => /^us/.test(c?.jurisdiction || '')),
    `chain=${chain.map((c) => c?.jurisdiction).join(' → ')}`);
}

// B5 — a selected-but-unreachable provider still returns lastErr + empty text (run-turn's return
// shape is unchanged; classification is verify:narration-walk W7's job). Narrate is non-sensitive
// so this exercises the plain path, not a §4g downgrade.
{
  const seen = [];
  const { db } = mkTurnDb([usRow], { settings: { taskModels: { narrate: { providerId: 'us1' } } } });
  const res = await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen, DEAD_WIRE) }, { userMessage: 'x', inferenceTask: 'narrate' });
  rec('B5. a selected-but-UNREACHABLE narrate provider returns lastErr + empty text (NOT a skip)',
    res?.skipped == null && res?.lastErr && (res?.text ?? '') === '',
    `skipped=${res?.skipped} lastErr=${String(res?.lastErr).slice(0, 40)} text=${JSON.stringify(res?.text)}`);
}

// ── GROUP C — the §4g MACHINERY IS STILL LIVE for explicit sensitive:true callers ─────
// claims/discovery.js + claims/validator.js pass sensitive:true; they NEVER read SENSITIVE_TASKS,
// so removing narrate must not have touched their protection. Prove the gate still fires.

// C1 — ⭐ router.infer + EXPLICIT sensitive:true + US ⇒ REFUSED. This is the claims path.
ev = [];
out = await mkRouter('us-standard', ev).infer({ prompt: 'a persona claim about the user', task: 'narrate', sensitive: true });
rec('C1. ⭐ EXPLICIT sensitive:true + US ⇒ still REFUSED → on-box (the machinery claims rely on is intact)',
  out === 'local-out' && ev[0]?.decision === 'denied' && ev[0]?.reason === 'sensitive_us_block',
  `out=${out} decision=${ev[0]?.decision} reason=${ev[0]?.reason}`);

// C2 — the opt-in exemption still lets the user's OWN Claude subscription through, explicitly.
ev = [];
out = await mkRouter('us-standard', ev, { sensitiveUsExempt: true }).infer({ prompt: 'claim', task: 'narrate', sensitive: true });
rec('C2. sensitive:true + US + the EXPLICIT opt-in (own Claude subscription) ⇒ ALLOWED',
  out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// C3 — the exemption must not depend on the lookup path (per-task assignment AND active). This is
// exemption-flag plumbing the claims path leans on; task-independent, so it survives the change.
{
  const subRow = {
    id: 'p1', provider: 'anthropic', auth_type: 'oauth', model_preference: 'claude-opus-4-8',
    credentials: JSON.stringify({ claudeOAuthToken: 'sk-ant-oat-test' }), label: 'Claude (subscription)',
  };
  const activeRow = { ...subRow, id: 'p2', model_preference: 'claude-sonnet-5' };
  const mkDb = (taskModels) => ({
    users: { getSettings: async () => ({ allowSubscriptionSensitive: true, ...(taskModels ? { taskModels } : {}) }) },
    providers: { get: async (id) => (id === 'p1' ? subRow : activeRow), getActive: async () => activeRow },
  });
  const viaTask = await resolveInferenceConfigForTask(mkDb({ narrate: { providerId: 'p1' } }), 'u', 'narrate');
  const viaActive = await resolveInferenceConfigForTask(mkDb(null), 'u', 'narrate');
  rec('C3. the §4g opt-in applies on BOTH resolver branches (per-task assignment AND active)',
    viaTask?.sensitiveUsExempt === true && viaActive?.sensitiveUsExempt === true
    && viaTask?.cloudModel === 'claude-opus-4-8' && viaActive?.cloudModel === 'claude-sonnet-5',
    `perTask=${viaTask?.sensitiveUsExempt}/${viaTask?.cloudModel} active=${viaActive?.sensitiveUsExempt}/${viaActive?.cloudModel}`);
}

// C4 — the WRAPPER honours an EXPLICIT sensitive flag (a wrapper must not silently downgrade the
// gate). inferWithCascade defaults from the task (A6), but an explicit true still refuses.
{
  const events = [];
  const chain = [{ jurisdiction: 'us-standard', openaiApiKey: 'k', baseUrl: 'https://api.example.com/v1' }];
  let cout = null;
  try { cout = await inferWithCascade({ chain, prompt: 'claim', task: 'narrate', sensitive: true, fetch: mockFetch, onEgress: (e) => events.push(e) }); } catch { /* recorded */ }
  rec('C4. inferWithCascade({sensitive:true}) + US ⇒ REFUSED (the wrapper honours an explicit flag)',
    events[0]?.decision === 'denied' && events[0]?.reason === 'sensitive_us_block',
    `out=${cout} decision=${events[0]?.decision}`);
}

// C5 — the SENSITIVE chain still drops US (resolve.js `sensitive && /^us/.test(jurisdiction)`),
// and a no-base_url US provider fail-closes to us-standard (jurisdictionForBaseUrl, pinned D2).
// This is the chain the claims path builds; removing narrate must not have relaxed it.
{
  const usApi = { id: 'us', provider: 'openai', model_preference: 'gpt-5', credentials: JSON.stringify({ apiKey: 'k' }) };
  const db = {
    users: { getSettings: async () => ({ allowSubscriptionSensitive: false }) },
    providers: { list: async () => [usApi], get: async () => usApi, getActive: async () => usApi },
  };
  const chain = await resolveProviderChain(db, 'u', { sensitive: true });
  const nonFloor = chain.filter((c) => !c.localFallback);
  rec('C5. a US provider is dropped from a SENSITIVE chain, leaving only the on-box floor (§4g machinery holds)',
    nonFloor.length === 0 && chain.some((c) => c.localFallback),
    `chain=${chain.map((c) => c.jurisdiction).join(' → ')}`);
  // …but a NON-sensitive chain KEEPS it — narrate's real chain now, no over-restriction.
  const openChain = await resolveProviderChain(db, 'u', { sensitive: false });
  rec('C5b. …and a NON-sensitive chain KEEPS the US provider (narrate no longer drops it)',
    openChain.some((c) => !c.localFallback && /^us/.test(c.jurisdiction || '')),
    `chain=${openChain.map((c) => c.jurisdiction).join(' → ')}`);
}

// ── D) on-device HONESTY — orthogonal to §4g, and it STAYS ─────────────────────
// A now-permitted off-box narrate must still be ROUTED + AUDITED, never dialled by a silent
// direct-fetch branch. These pin the wire-selection + audit, whatever §4g decides.
rec('D1. isLoopbackUrl parses the HOST — a remote host that merely CONTAINS "localhost" is NOT local',
  isLoopbackUrl('https://localhost.attacker.io/v1') === false
  && isLoopbackUrl('https://evil.com/?x=localhost') === false
  && isLoopbackUrl('http://127.0.0.1:11434') === true
  && isLoopbackUrl('http://localhost:11434/v1') === true
  && isLoopbackUrl('http://[::1]:11434') === true
  && isLoopbackUrl('not a url') === false
  && isLoopbackUrl('http://x.localhost:11434/') === false
  && isLoopbackUrl('http://127.0.0.1.evil.com/') === false
  && isLoopbackUrl('http://localhost@evil.com/') === false
  && isLoopbackUrl('http://2130706433/') === true
  && isLoopbackUrl('http://0177.0.0.1/') === true
  && isLoopbackUrl('http://127.1/') === true,
  'the old regex said TRUE for the first two — a silent-branch bypass + no audit row');

rec('D2. jurisdictionForBaseUrl agrees with isLoopbackUrl — `.local` (mDNS = another machine) is NOT sovereign',
  jurisdictionForBaseUrl('http://mybox.local:11434/v1') === 'us-standard'
  && jurisdictionForBaseUrl('https://box.local/v1') === 'us-standard'
  && jurisdictionForBaseUrl('https://evil.com/?x=box.local') === 'us-standard'
  && jurisdictionForBaseUrl('http://127.0.0.1:11434/v1') === 'local'
  && jurisdictionForBaseUrl('http://localhost:1234/v1') === 'local'
  && jurisdictionForBaseUrl('https://api.regolo.ai/v1') === 'eu-zdr',
  'it must not return "local" for *.local — that host is off-box');

{
  // END-TO-END: drive createNarrator with a `.local` provider and watch what is DIALLED and what
  // is AUDITED. narrate is non-sensitive now, so the off-box host is ALLOWED — but it must be
  // routed through the router (not the silent native branch) so the egress is RECORDED.
  const dialled = [];
  const spyFetch = async (url) => {
    dialled.push(String(url));
    return { ok: true, status: 200, async json() { return { message: { content: '{}' } }; }, async text() { return '{}'; } };
  };
  const lanRow = { id: 'lan', provider: 'custom', label: 'homelab', base_url: 'http://mybox.local:11434/v1', model_preference: 'gemma3:12b', credentials: JSON.stringify({ apiKey: '' }) };
  const audits = [];
  const db = {
    users: { getSettings: async () => ({}) },
    providers: { getActive: async () => lanRow, get: async () => lanRow, list: async () => [lanRow] },
    audit: { log: (e) => audits.push(e) },
  };
  const n = await createNarrator({ db, userId: 'u', fetch: spyFetch });
  try { await n.infer('name this realm: grief, divorce, debt'); } catch { /* the point is the WIRE, not the reply */ }
  rec('D3. ⭐ narrate + a `.local` provider ⇒ never the silent direct-fetch branch: it is routed, so the egress is recorded',
    n.local === false && audits.length > 0,
    `narrator.local=${n.local} dialled=${JSON.stringify(dialled)} auditRows=${audits.length}`);
  rec('D3b. …and the egress is AUDITED by hash (ALLOWED now — narrate no longer refuses off-box, but it is still recorded)',
    audits.some((a) => a.action === 'inference-egress' && a.details?.decision === 'allowed' && !!a.details?.content_hash),
    `audits=${JSON.stringify(audits.map((a) => `${a.details?.decision}/${a.details?.reason ?? '-'}`))}`);
}

rec('D4. narrate decides its wire from the URL ALONE — a cfg LABELLED local but pointing off-box is NOT on-box (§2: survives a wrong mapping)',
  isOnBoxCfg({ jurisdiction: 'local', baseUrl: 'http://mybox.local:11434/v1' }) === false
  && isOnBoxCfg({ jurisdiction: 'local', baseUrl: 'https://evil.example.com/v1' }) === false
  && isOnBoxCfg({ jurisdiction: 'local' }) === false
  && isOnBoxCfg({ jurisdiction: 'us-standard', baseUrl: 'http://127.0.0.1:11434/v1' }) === true
  && isOnBoxCfg({ jurisdiction: 'local', baseUrl: 'http://localhost:11434/v1' }) === true,
  'a label alone can never buy the silent native branch — only a real loopback URL may');

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narrate is UNRESTRICTED (US allowed end-to-end, run on the selected provider), the §4g machinery still refuses explicit sensitive:true (claims), and off-box narrate stays audited' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
