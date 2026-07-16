// verify:narrate-sovereignty — §4g for the task that needed it most, and did not have it.
//
// THE BUG (found 2026-07-16 while designing the Intelligence screen, design §3.11d).
// role-models.js asserted — and the Intelligence screen was about to PRINT ON THE USER'S
// SCREEN — that `narrate` runs `sensitive:true`, so a US pick "would be silently downgraded
// to local". It was false. `sensitive` was a per-CALL boolean, and exactly two call sites in
// the repo passed it (claims/discovery, claims/validator) — neither of which describes the
// mindscape. The REAL Descriptions worker — pipeline/lib/narrate-infer.js:94, driving
// describe-clusters.js (cluster names + chronicles) — called router.infer({task:'narrate'})
// with no flag, so it defaulted to FALSE and the §4g gate never fired. agent/run-turn.js
// hard-coded `{sensitive:false}` for EVERY task, so the agent narration walk had no gate at
// all. The guarantee lived in a comment and a design doc; in code, a US model was free to name
// the user's personal themes. Operator decision (2026-07-16): make the guarantee real.
//
// The fix is STRUCTURAL, and that is what this gate defends: `sensitive` is DERIVED FROM THE
// TASK (src/inference/sensitivity.js), so any caller that OMITS it is correct. A gate that only
// checked "narrate-infer passes the flag" would let the next narrate call site reintroduce the
// same hole. It is NOT a force field — an explicit argument still wins (cascade.js shipped a
// hardcoded `false`), which is why N13 pins every wrapper's default.
//
//   N1  the taxonomy: narrate is sensitive; chat/harness/reflection/summarize are NOT
//   N2  ⭐ router.infer({task:'narrate'}) with NO flag ⇒ US is REFUSED → on-box. THE BUG.
//   N3  inferStream too — the same gate, so it must have the same trigger
//   N4  not a blanket ban: a non-sensitive cloud task still reaches US
//   N5  EU-ZDR is never blocked — the recommendation must keep working
//   N6  the opt-in exemption survives (the user's own Claude subscription, explicitly enabled)
//   N7  the exemption does not depend on WHICH resolver path found the provider
//   N12 "local" means THIS MACHINE — isLoopbackUrl parses the host
//   N12b …and jurisdictionForBaseUrl AGREES with it (`.local` = another machine, not sovereign)
//   N12c ⭐ end-to-end: a `.local` provider never takes narrate's silent direct-fetch branch
import crypto from 'node:crypto';
import { createInferenceRouter } from '../src/inference/router.js';
import { isSensitiveTask, SENSITIVE_TASKS } from '../src/inference/sensitivity.js';
import { resolveInferenceConfigForTask, _setSubscriptionTokenReaderForTests } from '../src/inference/resolve.js';
import { runAgentTurn } from '../src/agent/run-turn.js';
import { isLoopbackUrl } from '../src/inference/local.js';
import { jurisdictionForBaseUrl } from '../src/inference/presets.js';
import { createNarrator, isOnBoxCfg } from '../pipeline/lib/narrate-infer.js';
import { inferWithCascade } from '../src/inference/cascade.js';

// HERMETIC: resolve.js's default reader spawns `security`/`claude` against the REAL machine
// keychain. resolve.js:60 exists precisely so verify:* doesn't ("overridable so verify:* is
// deterministic (no live keychain)") and the first draft of this gate didn't use it
// (independent review, 2026-07-16).
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

// ── N1) the taxonomy ─────────────────────────────────────────────────────────
rec('N1. `narrate` is §4g-sensitive; chat/harness/reflection are NOT',
  isSensitiveTask('narrate') === true
  && ['chat', 'harness', 'reflection', 'categorize', 'enrich', 'summarize', 'complex'].every((t) => isSensitiveTask(t) === false)
  && SENSITIVE_TASKS instanceof Set,
  // A set that swallowed every task would disable US providers app-wide, get reverted by the
  // next person who noticed, and take narrate's protection with it.
  `sensitive=${[...SENSITIVE_TASKS].join(',')}`);

// ── N2) THE BUG ──────────────────────────────────────────────────────────────
// No `sensitive` argument — exactly how pipeline/lib/narrate-infer.js:94 calls it.
let ev = [];
let out = await mkRouter('us-standard', ev).infer({ prompt: 'name this cluster of my private themes', task: 'narrate' });
rec('N2. ⭐ narrate + US, caller passes NO flag ⇒ REFUSED → on-box (this is what was broken)',
  out === 'local-out' && ev[0]?.decision === 'denied' && ev[0]?.reason === 'sensitive_us_block',
  `out=${out} decision=${ev[0]?.decision} reason=${ev[0]?.reason}`);
rec('N2b. …and the refusal is audited by HASH — never the prompt (§1)',
  ev[0]?.contentHash === crypto.createHash('sha256').update('name this cluster of my private themes').digest('hex')
  && !JSON.stringify(ev[0] || {}).includes('private themes'),
  `hash=${String(ev[0]?.contentHash).slice(0, 12)}…`);

// ── N3) the streaming twin ───────────────────────────────────────────────────
ev = [];
let streamed = '';
try { for await (const d of mkRouter('us-standard', ev).inferStream({ prompt: 'chronicle my year', task: 'narrate' })) streamed += d; } catch { /* recorded below */ }
rec('N3. inferStream({task:"narrate"}) + US ⇒ REFUSED too (same gate ⇒ same trigger)',
  ev[0]?.decision === 'denied' && ev[0]?.reason === 'sensitive_us_block',
  `decision=${ev[0]?.decision} streamed=${JSON.stringify(streamed.slice(0, 20))}`);

// ── N4) NOT a blanket ban ────────────────────────────────────────────────────
ev = [];
out = await mkRouter('us-standard', ev).infer({ prompt: 'public', task: 'complex' });
rec('N4. a NON-sensitive cloud task still reaches US (this is a narrate rule, not a US ban)',
  out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// ── N5) EU-ZDR must keep working — it IS the recommendation ──────────────────
ev = [];
out = await mkRouter('eu-zdr', ev).infer({ prompt: 'name this cluster', task: 'narrate' });
rec('N5. narrate + EU-ZDR ⇒ ALLOWED (Regolo is the recommendation; blocking it would be the bug)',
  out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// ── N6) the opt-in exemption survives ────────────────────────────────────────
ev = [];
out = await mkRouter('us-standard', ev, { sensitiveUsExempt: true }).infer({ prompt: 'name this cluster', task: 'narrate' });
rec('N6. narrate + US + the EXPLICIT opt-in (own Claude subscription) ⇒ ALLOWED',
  out === 'cloud-out' && ev[0]?.decision === 'allowed', `out=${out} decision=${ev[0]?.decision}`);

// ── N7) the exemption must not depend on the lookup path ─────────────────────
// resolveInferenceConfigForTask has TWO branches: an explicit per-task assignment, and the
// fallback to the active provider. applySensitiveExempt ran only on the SECOND — so the same
// subscription was exempt when reached as "active" and NOT exempt when assigned to narrate
// explicitly. Harmless while nothing gated the primary; the moment §4g covers narrate it would
// refuse an opt-in the user actually gave.
const subRow = {
  id: 'p1', provider: 'anthropic', auth_type: 'oauth', model_preference: 'claude-opus-4-8',
  credentials: JSON.stringify({ claudeOAuthToken: 'sk-ant-oat-test' }), label: 'Claude (subscription)',
};
// ⚠️ get() and getActive() must return DIFFERENT rows, or this check cannot tell "the
// per-task branch applied the exemption" from "the per-task branch threw and the ACTIVE
// branch answered" — resolveInferenceConfigForTask falls through on any throw
// (independent review, 2026-07-16).
const activeRow = { ...subRow, id: 'p2', model_preference: 'claude-sonnet-5' };
const mkDb = (taskModels) => ({
  users: { getSettings: async () => ({ allowSubscriptionSensitive: true, ...(taskModels ? { taskModels } : {}) }) },
  providers: { get: async (id) => (id === 'p1' ? subRow : activeRow), getActive: async () => activeRow },
});
const viaTask = await resolveInferenceConfigForTask(mkDb({ narrate: { providerId: 'p1' } }), 'u', 'narrate');
const viaActive = await resolveInferenceConfigForTask(mkDb(null), 'u', 'narrate');
rec('N7. the §4g opt-in applies on BOTH resolver branches (per-task assignment AND active)',
  viaTask?.sensitiveUsExempt === true && viaActive?.sensitiveUsExempt === true
  // …and prove the per-task branch is the one that ANSWERED, not the active fallthrough.
  && viaTask?.cloudModel === 'claude-opus-4-8' && viaActive?.cloudModel === 'claude-sonnet-5',
  `perTask=${viaTask?.sensitiveUsExempt}/${viaTask?.cloudModel} active=${viaActive?.sensitiveUsExempt}/${viaActive?.cloudModel}`);

// ── N8-N11) run-turn — THE PATH THIS PR IS ABOUT, and which nothing tested ──────────
// N1-N7 exercise router.js + resolve.js only. Nothing touched run-turn, so N2 would have
// passed with run-turn still hard-coding {sensitive:false} — the whole live narration-walk
// path (primary gate, chain gate, audit, isUsNonExempt) was unverified. That is exactly how
// the "guaranteed on-box floor" shipped as `{skipped:'no-model'}` (independent review).
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
// Records the provider run-turn ACTUALLY hands the loop — the only thing that decides where
// the content goes.
const mkLoop = (seen, result = { text: 'ok', toolsUsed: [] }) => ({ run: async ({ provider, providerChain }) => { seen.push({ provider, providerChain }); return result; } });
// ⚠️ loop.run NEVER THROWS (agent/loop.js): a dead wire is swallowed into `lastErr` and it
// returns `{text:''}`. So THIS is what an unreachable-but-approved model actually looks like
// to the caller — and a loop double that only ever returns {text:'ok'} can never see it.
// That is exactly how the HIGH survived three rounds (independent review, 2026-07-16).
const DEAD_WIRE = { text: '', toolsUsed: [], lastErr: 'harness: Ollama unreachable at http://127.0.0.1:11434/api/chat' };

// N8 — THE REGRESSION THE REVIEW CAUGHT: a US-ONLY vault (the most likely V1 config: only a
// Claude subscription, opt-in off) must still RUN, on-box — not silently skip.
{
  const seen = [];
  // WITH an approved on-box model. Without one there is nothing safe to run, and N15 pins that
  // it refuses honestly rather than fabricating a run.
  const { db, audits } = mkTurnDb([usRow], { settings: { taskModels: { narrate: { providerId: 'us1' }, categorize: { model: 'qwen3.5:4b' } } } });
  const res = await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'name this cluster', inferenceTask: 'narrate' });
  const used = seen[0]?.provider;
  rec('N8. ⭐ narrate on a US-ONLY vault + an APPROVED on-box model ⇒ runs ON-BOX — never skipped',
    res?.skipped !== 'no-model' && !!used && used.jurisdiction === 'local' && !!used.baseUrl,
    `skipped=${res?.skipped} usedJurisdiction=${used?.jurisdiction} baseUrl=${used?.baseUrl ? 'set' : 'MISSING'} model=${used?.cloudModel}`);
  rec('N8b. …and the refusal is audited, content-free',
    audits[0]?.action === 'sensitive-us-block' && audits[0]?.resourceId === 'narrate'
    && audits[0]?.details?.deniedJurisdiction === 'us-standard'
    && !JSON.stringify(audits[0] || {}).includes('name this cluster'),
    JSON.stringify(audits[0]?.details || {}));
}

// N9 — an EU provider is the head of the sensitive chain, so narrate uses IT, not the floor.
{
  const seen = [];
  const { db } = mkTurnDb([usRow, euRow], { settings: { taskModels: { narrate: { providerId: 'us1' } } } });
  await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'x', inferenceTask: 'narrate' });
  const used = seen[0]?.provider;
  rec('N9. narrate with an EU provider available ⇒ uses EU (not the on-box floor)',
    used?.jurisdiction === 'eu-zdr', `usedJurisdiction=${used?.jurisdiction}`);
}

// N10 — NO regression for the tasks that are not sensitive. run-turn is shared by chat /
// harness / reflection; if this flips, the gate has disabled US cloud app-wide.
{
  const seen = [];
  const { db, audits } = mkTurnDb([usRow], { settings: { taskModels: { chat: { providerId: 'us1' } } } });
  await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'hi', inferenceTask: 'chat' });
  const used = seen[0]?.provider;
  rec('N10. CHAT on a US provider is UNTOUCHED (this is a narrate rule, not a US ban)',
    /^us/.test(used?.jurisdiction || '') && audits.length === 0,
    `usedJurisdiction=${used?.jurisdiction} audits=${audits.length}`);
}

// N11 — the FALLBACK CHAIN must be sensitive too: gating only the primary would send the
// content to US on the first retry.
{
  const seen = [];
  const { db } = mkTurnDb([usRow, euRow], { settings: { taskModels: { narrate: { providerId: 'eu1' } } } });
  await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'x', inferenceTask: 'narrate' });
  const chain = seen[0]?.providerChain || [];
  rec('N11. the narrate FALLBACK CHAIN carries no US provider (a retry must not leak either)',
    chain.length > 0 && !chain.some((c) => /^us/.test(c?.jurisdiction || '') && c?.sensitiveUsExempt !== true),
    `chain=${chain.map((c) => c?.jurisdiction).join(' → ')}`);
}

// ── N12) "local" must mean THIS MACHINE ──────────────────────────────────────
// narrate-infer.js takes a DIRECT-FETCH branch when isLocal — skipping the §4g gate AND the
// egress audit. It decided that with an UNANCHORED regex, so any URL merely CONTAINING
// "localhost" read as on-box and narration left the machine ungated and unaudited.
rec('N12. isLoopbackUrl parses the HOST — a remote host that merely CONTAINS "localhost" is NOT local',
  isLoopbackUrl('https://localhost.attacker.io/v1') === false
  && isLoopbackUrl('https://evil.com/?x=localhost') === false
  && isLoopbackUrl('http://127.0.0.1:11434') === true
  && isLoopbackUrl('http://localhost:11434/v1') === true
  && isLoopbackUrl('http://[::1]:11434') === true
  && isLoopbackUrl('not a url') === false           // fail-closed on garbage
  // ⚠️ `x.localhost` must NOT be local: Node does not implement RFC 6761's loopback
  // guarantee — it asks the OS resolver, so a hosts-file line moves it off-box. It was this
  // function's only fail-open branch (independent review, 2026-07-16).
  && isLoopbackUrl('http://x.localhost:11434/') === false
  && isLoopbackUrl('http://127.0.0.1.evil.com/') === false
  && isLoopbackUrl('http://localhost@evil.com/') === false
  // …while the numeric forms WHATWG normalizes to 127.0.0.1 stay local — they are what
  // fetch() will actually dial.
  && isLoopbackUrl('http://2130706433/') === true
  && isLoopbackUrl('http://0177.0.0.1/') === true
  && isLoopbackUrl('http://127.1/') === true,
  'the old regex said TRUE for the first two — a §4g bypass + no audit row');

// ── N12b-N12c) …and the JURISDICTION MAP must agree with it ────────────────────
// N12 pinned isLoopbackUrl and shipped. The hole was the OTHER half of the `||`: callers wrote
// `cfg.jurisdiction === 'local' || isLoopbackUrl(cfg.baseUrl)`, and jurisdictionForBaseUrl
// ALSO returned 'local' for any `*.local` (mDNS) host — a DIFFERENT machine. So the wrong half
// won: an off-box host was stamped with the most-trusted value in the vocabulary, passed every
// §4g gate (they all key on /^us/, which 'local' fails) and took narrate's direct-fetch branch,
// which writes no egress row. Gating the hardened function while leaving the mapping that feeds
// the same `||` untested is how a fix passes its own gate and still leaks
// (independent review, 2026-07-16). Pin BOTH halves, and pin them TOGETHER.
rec('N12b. jurisdictionForBaseUrl agrees with isLoopbackUrl — `.local` (mDNS = another machine) is NOT sovereign',
  jurisdictionForBaseUrl('http://mybox.local:11434/v1') === 'us-standard'
  && jurisdictionForBaseUrl('https://box.local/v1') === 'us-standard'
  // …a `.local` NAME can resolve anywhere (split-horizon DNS / a hosts line), which is why the
  // name may never confer trust — only a literal/numeric form DNS cannot move may.
  && jurisdictionForBaseUrl('https://evil.com/?x=box.local') === 'us-standard'
  // the real on-box runtimes MUST keep their sovereign label (this is not a US ban)
  && jurisdictionForBaseUrl('http://127.0.0.1:11434/v1') === 'local'
  && jurisdictionForBaseUrl('http://localhost:1234/v1') === 'local'
  && jurisdictionForBaseUrl('https://api.regolo.ai/v1') === 'eu-zdr',
  'it returned "local" for *.local — the §4g bypass N12 thought it had closed');

{
  // END-TO-END, on the wire that matters: N12b is a unit check, and a unit check cannot see
  // narrate CHOOSING the branch. Drive createNarrator with a `.local` provider and watch what
  // is actually DIALLED and what is actually AUDITED — the two facts the bug turned on.
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
  const offBox = dialled.filter((u) => u.includes('mybox.local'));
  rec('N12c. ⭐ narrate + a `.local` provider ⇒ never the silent direct-fetch branch: nothing reaches the LAN host unaudited',
    n.local === false && (offBox.length === 0 || audits.length > 0),
    `narrator.local=${n.local} dialled=${JSON.stringify(dialled)} auditRows=${audits.length} — it direct-fetched mybox.local/api/chat with 0 audit rows`);
  // The §4g gate must now actually FIRE for it — an off-box host gets the us-standard treatment.
  rec('N12d. …and §4g REFUSES it by hash, like any other off-box provider (the audit row the direct branch never wrote)',
    audits.some((a) => a.action === 'inference-egress' && a.details?.decision === 'denied' && a.details?.reason === 'sensitive_us_block' && !!a.details?.content_hash),
    `audits=${JSON.stringify(audits.map((a) => `${a.details?.decision}/${a.details?.reason}`))}`);
}

// ── N12e) PIN THE SECOND LAYER ─────────────────────────────────────────────────
// N12b-d all go GREEN with narrate's own guard reverted, because they can only reach it through
// mapRowToConfig — which, once N12b holds, can no longer produce the `jurisdiction:'local'` +
// off-box-baseUrl combo that the guard exists to survive. So the defence-in-depth layer was
// UNPINNED: deleting it broke nothing, exactly the N13/N14 anti-pattern this file documents
// ("a fix nothing pins is a fix waiting to be undone"). Caught by independent review, 2026-07-16.
// isOnBoxCfg is exported for precisely this reason — call the thing that has the behaviour, with
// the hostile cfg the resolver can no longer build.
rec('N12e. narrate decides its wire from the URL ALONE — a cfg LABELLED local but pointing off-box is NOT on-box (§2: survives a wrong mapping)',
  isOnBoxCfg({ jurisdiction: 'local', baseUrl: 'http://mybox.local:11434/v1' }) === false
  && isOnBoxCfg({ jurisdiction: 'local', baseUrl: 'https://evil.example.com/v1' }) === false
  // …a label alone can never buy the silent branch
  && isOnBoxCfg({ jurisdiction: 'local' }) === false
  // …and a REAL on-box provider still gets it, whatever the label says
  && isOnBoxCfg({ jurisdiction: 'us-standard', baseUrl: 'http://127.0.0.1:11434/v1' }) === true
  && isOnBoxCfg({ jurisdiction: 'local', baseUrl: 'http://localhost:11434/v1' }) === true,
  'reverting narrate-infer to `cfg.jurisdiction === "local" || …` must FAIL here even while layer 1 holds');

// ── N13-N14) the fixes the last review proved were UNPINNED ────────────────────
// It reverted each and watched the gate stay GO. A fix nothing pins is a fix waiting to be
// undone by someone who has not read this file.
{
  // cascade.js passes `sensitive` EXPLICITLY, which OVERRIDES the task-derived default — so
  // inferWithCascade({task:'narrate'}) leaked despite SENSITIVE_TASKS. Any wrapper around
  // router.infer must default from the task too.
  const events = [];
  const chain = [{ jurisdiction: 'us-standard', openaiApiKey: 'k', baseUrl: 'https://api.example.com/v1' }];
  let out = null;
  try { out = await inferWithCascade({ chain, prompt: 'name this cluster', task: 'narrate', fetch: mockFetch, onEgress: (e) => events.push(e) }); } catch { /* recorded */ }
  rec('N13. inferWithCascade({task:"narrate"}) + US ⇒ REFUSED (a WRAPPER must default from the task too)',
    events[0]?.decision === 'denied' && events[0]?.reason === 'sensitive_us_block',
    `out=${out} decision=${events[0]?.decision} — cascade hardcoded sensitive:false, overriding the default`);
}
{
  // isUsNonExempt's `|| 'us-standard'`: a cfg with NO jurisdiction must read as US (fail-closed),
  // matching resolve.js:263 and router.js:178. `|| ''` read it as not-US ⇒ ALLOWED, on the PRIMARY.
  const seen = [];
  const noJur = { id: 'nj', provider: 'custom', base_url: 'https://mystery.example/v1', model_preference: 'm', credentials: JSON.stringify({ apiKey: 'k' }) };
  const db = {
    users: { getSettings: async () => ({ taskModels: { narrate: { providerId: 'nj' } }, allowSubscriptionSensitive: false }) },
    providers: { list: async () => [noJur], get: async () => ({ ...noJur, base_url: undefined }), getActive: async () => ({ ...noJur, base_url: undefined }) },
    audit: { log: () => {} },
  };
  const res = await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'x', inferenceTask: 'narrate' });
  const used = seen[0]?.provider;
  rec('N14. a cfg with NO jurisdiction is treated as US (fail-closed, §3) — never allowed through',
    !used || !/^us/.test(used?.jurisdiction || 'us-standard') || res?.skipped,
    `used=${used?.jurisdiction ?? 'none'} skipped=${res?.skipped ?? 'no'}`);
}

// ── N15) ⭐ THE HONEST BLOCKED STATE — the failure the fake floor hid ───────────
// The first two attempts at this fix BOTH left the outcome intact and only changed its shape:
// `{skipped:'no-model'}` → `{text:''}`. narration-walk counts either as a reflection, so the
// job REPORTED SUCCESS while nothing ran, under a log line saying "using local". The gate
// could not see it because its fake loop returns {text:'ok'} without touching a wire — it
// asserted the SHAPE, never that anything answers (independent review, 2026-07-16).
{
  const seen = [];
  const { db, audits } = mkTurnDb([usRow], { settings: { taskModels: { narrate: { providerId: 'us1' } } } });  // NO categorize approval
  const res = await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'x', inferenceTask: 'narrate' });
  rec('N15. ⭐ US provider + NO approved on-box model ⇒ REFUSES honestly — never a fake run',
    res?.skipped === 'sensitive-no-safe-provider' && seen.length === 0,
    `skipped=${res?.skipped} loopRan=${seen.length > 0} — a fresh post-#148 vault has no approved model BY DESIGN`);
  rec('N15b. …and it does NOT run an UNAPPROVED model (#148: "NEVER PULL, NEVER RUN")',
    seen.length === 0,
    'resolveOnBoxModel would have returned qwen3.5:4b here — it is fail-OPEN on unset AND on throw; defaultLabelModel is not');
  const blk = audits.find((a) => a?.details?.reason === 'sensitive_no_safe_provider');
  rec('N15c. …and the refusal is audited with its own reason AND usedJurisdiction=none (nothing ran)',
    !!blk && blk.details.usedJurisdiction === 'none',
    // NOT 'local' — nothing ran, so a `usedJurisdiction='local'` row would over-count local runs
    // (the audit claiming an outcome the code didn't produce — the PR's own thesis).
    `reason=${blk?.details?.reason} usedJurisdiction=${blk?.details?.usedJurisdiction}`);
}
{
  // …but an APPROVED on-box model still runs it. The refusal must be about CONSENT, not a ban.
  const seen = [];
  const { db } = mkTurnDb([usRow], { settings: { taskModels: { narrate: { providerId: 'us1' }, categorize: { model: 'qwen3.5:4b' } } } });
  const res = await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen) }, { userMessage: 'x', inferenceTask: 'narrate' });
  rec('N15d. an APPROVED on-box model DOES run (the refusal is about consent, not a ban)',
    !res?.skipped && seen[0]?.provider?.jurisdiction === 'local' && seen[0]?.provider?.cloudModel === 'qwen3.5:4b',
    `skipped=${res?.skipped} used=${seen[0]?.provider?.jurisdiction}/${seen[0]?.provider?.cloudModel}`);
}

// ── N16) an APPROVED but UNREACHABLE model — what run-turn RETURNS ────────────
// The blocked state (N15) only covers "no model APPROVED". The likelier state is "approved and
// does not answer" — Ollama not running is the NORMAL condition on a fresh box. loop.run
// swallows that into `lastErr` + `{text:''}`, which is why a `res.skipped` check never saw it.
// ⚠️ THIS PINS run-turn's RETURN VALUE ONLY. Whether that gets CLASSIFIED honestly is
// verify:narration-walk W7's job, against the REAL walk. A previous version asserted the
// classification HERE by re-implementing the classifier inline — so it passed while the real
// one was disabled (the fourth vacuous check this session; independent review, 2026-07-16).
// If you are tempted to assert behaviour here, call the thing that has it instead.
{
  const seen = [];
  const { db } = mkTurnDb([usRow], { settings: { taskModels: { narrate: { providerId: 'us1' }, categorize: { model: 'qwen3.5:4b' } } } });
  const res = await runAgentTurn({ db, userId: 'u', loop: mkLoop(seen, DEAD_WIRE) }, { userMessage: 'x', inferenceTask: 'narrate' });
  rec('N16. an APPROVED but UNREACHABLE model returns lastErr + empty text (NOT a skip — which is why keying on `skipped` missed it)',
    !res?.skipped && res?.lastErr && (res?.text ?? '') === '',
    `skipped=${res?.skipped} lastErr=${String(res?.lastErr).slice(0, 40)} text=${JSON.stringify(res?.text)} — classification is W7's job`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narrate is §4g-sensitive BY TASK: US refused, EU + the explicit opt-in still work' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
