// verify:narrate-consent — narration never runs a model the owner did not approve.
//
// THE FINDING THIS ENFORCES. Increment M (#148) made `settings.taskModels.categorize.model`
// BOTH the model choice and the approval to download+run it: "NO MODEL ⇒ NOT APPROVED ⇒ NEVER
// PULL, NEVER RUN". The PULL half held. The RUN half did not: pipeline/lib/narrate-infer.js
// resolved narrate's on-box fallback through resolve.js's `resolveOnBoxModel(db, userId,
// 'categorize', labelingRecommendedModel())` — a SECOND reader of the SAME settings key that
// disagreed with the drainer about what silence means:
//
//     unset            drainer defaultLabelModel → null   ·  resolveOnBoxModel → qwen3.5:4b
//     settings THROWS  drainer defaultLabelModel → null   ·  resolveOnBoxModel → qwen3.5:4b
//
// So a vault that had approved NOTHING still ran qwen3.5:4b to name the owner's realms, if it
// happened to be on disk — reachable with no user action (server-rest auto-generate → jobs.js
// → run-clustering.sh → describe-clusters.js → createNarrator). Sharpest case: an owner who
// picks "Off" — portal-providers.js DELETES the key, and the fail-open read reinstated the
// model they had just declined.
//
// ⚠️ N4 IS THE ONE THAT MATTERS. The obvious fix — "pass the fail-closed resolver's null" —
// is WORSE than the bug: router.js coalesces `localModel || env.LOCAL_MODEL ||
// DEFAULT_LOCAL_MODEL`, so null silently becomes llama3.1, a heavier unapproved model than
// the qwen3.5:4b we set out to stop. N4 fails against that "fix".
//
//   N1  the two resolvers no longer disagree — resolveOnBoxModel is RETIRED (one key, one reader)
//   N2  unset ⇒ narrate resolves NO model (and a settings THROW is not consent either)
//   N3  no cloud + no approval ⇒ the narrator REFUSES up front and says so (`blocked`)
//   N4  cloud + no approval ⇒ a cloud failure SURFACES; it never becomes llama3.1 or qwen3.5:4b
//   N5  cloud + approval ⇒ the fallback still works, to the APPROVED model (no regression)
//   N6  §4g sensitive-US block ⇒ still refuses rather than running an unapproved model
//       (the path cloudFallbackToLocal does NOT govern — live once #151 lands)
//   N7  the callers REPORT the refusal instead of silently naming nothing
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripCommentsFor } from './lib/strip-comments.mjs';

process.env.ENCRYPTION_MASTER_KEY ||= crypto.randomBytes(32).toString('hex');
// The router coalesces to env.LOCAL_MODEL before DEFAULT_LOCAL_MODEL — a stray one in the
// developer's shell would mask N4. Pin the hostile case explicitly.
process.env.LOCAL_MODEL = 'llama3.1';
// HERMETIC ENV. hasCloudCreds + the router BOTH read cloud creds from env, so a stray
// ANTHROPIC_API_KEY in the dev's shell makes N3's "no cloud, must refuse" vault look like it
// HAS cloud → spurious NO-GO. That is not a hypothetical: a consent gate that reds on an
// unrelated env var is exactly how a consent check gets "fixed" by loosening it (independent
// review). Each test controls cloud through its fixture db, never the ambient shell — so
// clear the ambient keys and assert intent, not the tester's environment.
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'INFERENCE_BASE_URL', 'INFERENCE_CLOUD_MODEL', 'OLLAMA_URL']) delete process.env[k];

const { createNarrator, BLOCKED_NO_MODEL } = await import('../pipeline/lib/narrate-infer.js');
const { createInferenceRouter } = await import('../src/inference/router.js');
const { defaultLabelModel } = await import('../src/enrich/drainer.js');
const resolveMod = await import('../src/inference/resolve.js');
const { createActivityFeedNamespace } = await import('../src/db/activity-feed.js');

// The real feed namespace — so "notice() does not exist" is checked against the API rather
// than asserted from memory (the mistake that made the dead call survive in the first place).
const feedNamespace = createActivityFeedNamespace({ d1QueryAdmin: async () => ({ results: [] }), randomUUID: () => 'id' });

// Source assertions must read CODE, not prose: these files legitimately NAME the retired
// resolver and the dead notice() in comments explaining why they are gone. Matching a comment
// would make this gate fail on its own documentation.
// ONE lexical stripper (scripts/lib/strip-comments.mjs) — the regex pair that was here
// missed TRAILING `//` comments entirely and could not tell a comment from a string in
// either direction. Gated by verify:strip-comments.
const stripComments = (s) => stripCommentsFor('x.js', s);

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
async function t(n, fn) { try { await fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } }

// A vault whose narrate task is routed to a cloud provider (`jurisdiction`), and whose
// on-box approval is `approved` (null = the owner approved nothing — a fresh post-#148 vault).
// getSettings THROWS when `throws` — a read error is not an approval.
function vault({ approved = null, jurisdiction = 'eu-zdr', throws = false } = {}) {
  const settings = {
    taskModels: {
      ...(approved ? { categorize: { model: approved } } : {}),
      narrate: { providerId: 'p1' },
    },
  };
  return {
    users: { getSettings: async () => { if (throws) throw new Error('settings read failed'); return settings; } },
    providers: {
      get: async () => ({ id: 'p1', provider: 'openai', base_url: 'https://api.regolo.ai/v1', label: 'Regolo', model_preference: 'maestrale', credentials: JSON.stringify({ apiKey: 'k' }), auth_type: 'api_key' }),
      getActive: async () => null,
    },
    audit: { log: async () => {} },
  };
}
// Cloud always fails → forces the fallback decision, which is the whole question.
// It also asserts HERMETICITY: every request must arrive at the injected fetch. If a code path
// ignores the injection and uses globalThis.fetch, the spy sees nothing, `calls` stays [], and
// a "nothing unapproved ran" assertion passes VACUOUSLY while the real network is hit. That is
// not hypothetical — narrate-infer accepted `fetch` and never passed it to the router until
// 2026-07-16, and the first draft of N4 was green for exactly that reason. `cloudAttempts`
// below is the tripwire: a test that expects a cloud attempt must SEE one.
const deadCloud = async () => { throw new Error('ECONNREFUSED'); };
// Records the MODEL NAME of any /api/generate or /api/chat that reaches Ollama — the whole
// question is "did an unapproved model run", so the assertion is on what was actually sent to
// the wire, not on what a resolver returned. Nothing may reach here unapproved.
// The response shape matches the REAL contract: localInfer reads res.text() and JSON.parses it
// (src/inference/local.js), narrate-infer's local branch reads res.json().message.content.
const OLLAMA_REPLY = '{"name":"X","essence":"y"}';
function spyOllama() {
  const calls = [];          // model names that reached Ollama
  const cloudAttempts = [];  // URLs that went anywhere else (i.e. the cloud)
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (/\/api\/(generate|chat)/.test(u)) {
      let model = null;
      try { model = JSON.parse(init?.body || '{}').model ?? null; } catch { /* */ }
      calls.push(model);
      const payload = JSON.stringify({ response: OLLAMA_REPLY, message: { content: OLLAMA_REPLY }, done_reason: 'stop' });
      return { ok: true, status: 200, text: async () => payload, json: async () => JSON.parse(payload) };
    }
    cloudAttempts.push(u);
    return deadCloud();
  };
  return { calls, cloudAttempts, fetchImpl };
}

// ── N1 — the root defect: two resolvers for one key ──────────────────────────
await t('N1. resolveOnBoxModel is RETIRED — settings.taskModels.*.model has ONE reader', () => {
  assert.equal(resolveMod.resolveOnBoxModel, undefined,
    'resolve.js still exports resolveOnBoxModel: a fail-OPEN reader of the same key the fail-CLOSED defaultLabelModel owns. Two resolvers that disagree about what silence means IS the defect — retire it, do not add a flag to it.');
  const src = readFileSync(new URL('../pipeline/lib/narrate-infer.js', import.meta.url), 'utf8');
  assert.ok(!/resolveOnBoxModel/.test(stripComments(src)),
    'narrate-infer.js still CALLS resolveOnBoxModel');
  assert.ok(/defaultLabelModel/.test(src), 'narrate-infer.js must read the approval through the fail-closed defaultLabelModel');
});

// ── N2 — silence, and failure, are not consent ───────────────────────────────
await t('N2. unset ⇒ no model resolved; a settings THROW is not consent either', async () => {
  assert.equal(await defaultLabelModel(vault({ approved: null }), 'u'), null, 'unset must resolve to null');
  assert.equal(await defaultLabelModel({ users: { getSettings: async () => { throw new Error('boom'); } } }, 'u'), null,
    'a settings read that FAILS must not be read as an approval');
});

// ── N3 — no cloud + no approval ⇒ refuse, honestly ───────────────────────────
await t('N3. no cloud + nothing approved ⇒ the narrator REFUSES up front and says why', async () => {
  const db = { users: { getSettings: async () => ({}) }, providers: { get: async () => null, getActive: async () => null } };
  const { calls, fetchImpl } = spyOllama();
  const n = await createNarrator({ db, userId: 'u', fetch: fetchImpl });
  assert.equal(n.blocked, BLOCKED_NO_MODEL, `the refusal must be REPORTABLE, not just a thrown string — got blocked=${n.blocked}`);
  await assert.rejects(() => n.infer('name this'), (e) => e.code === 'no-approved-local-model',
    'infer must reject with a typed code the caller can distinguish from "the model returned junk"');
  assert.deepEqual(calls, [], `nothing may reach Ollama — got ${JSON.stringify(calls)}`);
});

// ── N4 — THE ONE THAT KILLS THE NAIVE FIX ────────────────────────────────────
await t('N4. cloud + nothing approved ⇒ cloud failure SURFACES — never llama3.1, never qwen3.5:4b', async () => {
  const { calls, cloudAttempts, fetchImpl } = spyOllama();
  const n = await createNarrator({ db: vault({ approved: null }), userId: 'u', fetch: fetchImpl });
  await assert.rejects(() => n.infer('name this'),
    'a cloud failure with no approved fallback must reach the caller as a failure, not become a silent unapproved run');
  assert.ok(cloudAttempts.length > 0,
    'the injected fetch saw NO cloud attempt — this assertion is vacuous: the code is using globalThis.fetch, so `calls` would stay empty no matter what ran');
  assert.deepEqual(calls, [],
    `NOTHING may run on-box: the owner approved no model. Got ${JSON.stringify(calls)} — "llama3.1" means the router's \`localModel || env.LOCAL_MODEL || DEFAULT_LOCAL_MODEL\` coalesce swallowed the fail-closed null (the naive resolver-swap "fix"); "qwen3.5:4b" means the fail-open resolveOnBoxModel is back.`);
});

await t('N4b. …and a settings read that THROWS is not a licence to run one either', async () => {
  const { calls, fetchImpl } = spyOllama();
  const n = await createNarrator({ db: vault({ approved: null, throws: true }), userId: 'u', fetch: fetchImpl });
  await assert.rejects(() => n.infer('name this'));
  assert.deepEqual(calls, [], `a failed settings read must not resolve a model — got ${JSON.stringify(calls)}`);
  // NOTE: no cloudAttempts tripwire here — a throwing getSettings also breaks provider
  // resolution, so this vault legitimately never reaches cloud. N4 carries the hermeticity check.
});

// ── N5 — the happy path is untouched ─────────────────────────────────────────
await t('N5. cloud + APPROVED ⇒ the on-box fallback still runs, on the approved model', async () => {
  const { calls, cloudAttempts, fetchImpl } = spyOllama();
  const n = await createNarrator({ db: vault({ approved: 'qwen3.5:4b' }), userId: 'u', fetch: fetchImpl });
  assert.equal(n.blocked, undefined, 'an approved vault must not be blocked');
  const out = await n.infer('name this');
  assert.ok(cloudAttempts.length > 0, 'cloud must be TRIED first — the fallback is a fallback, not the primary');
  assert.match(String(out), /name/, 'the fallback must actually produce the narration');
  assert.deepEqual(calls, ['qwen3.5:4b'],
    `the fallback must run the APPROVED model and nothing else — got ${JSON.stringify(calls)}`);
});

// ── N6 — the path cloudFallbackToLocal does not govern ───────────────────────
await t('N6. §4g sensitive-US block ⇒ refuses rather than running an unapproved model', async () => {
  const { calls, fetchImpl } = spyOllama();
  // The router's §4g block `return runLocal(...)` (router.js) is NOT governed by
  // cloudFallbackToLocal, so it is the path a fallback-only fix leaves open. It goes live for
  // narrate when #151 lands (narrate → SENSITIVE_TASKS); drive the router directly so this
  // gate holds the line NOW and does not need to be remembered later.
  const router = createInferenceRouter({
    fetch: fetchImpl, anthropicApiKey: 'k', jurisdiction: 'us-standard',
    localModel: null, requireApprovedLocal: true,
  });
  await assert.rejects(() => router.infer({ prompt: 'p', task: 'narrate', sensitive: true }),
    (e) => e.code === 'no-approved-local-model',
    'the §4g US block must refuse when no on-box model is approved — not silently run one');
  assert.deepEqual(calls, [], `the §4g block must not reach Ollama unapproved — got ${JSON.stringify(calls)}`);
});

await t('N6b. requireApprovedLocal defaults OFF — existing router callers are unchanged', async () => {
  const { calls, fetchImpl } = spyOllama();
  const router = createInferenceRouter({ fetch: fetchImpl }); // no localModel, no flag
  await router.infer({ prompt: 'p', task: 'summarize' });
  assert.deepEqual(calls, ['llama3.1'],
    `without the flag the legacy coalesce must still apply, or this becomes a breaking change to every other caller — got ${JSON.stringify(calls)}`);
});

// ── N7 — the refusal is REPORTED, not silently absorbed ──────────────────────
await t('N7. describe-clusters + describe-chronicles report the refusal (not a fake success)', () => {
  // PR #151's review caught the silent-nothing failure TWICE, so this is asserted, not trusted:
  // a narrator that refuses must not leave the run looking like it merely had nothing to say.
  for (const f of ['describe-clusters.js', 'describe-chronicles.js']) {
    const src = readFileSync(new URL(`../pipeline/${f}`, import.meta.url), 'utf8');
    assert.ok(/narrator\.blocked/.test(src), `${f} must check narrator.blocked`);
    assert.ok(/status:\s*'error'/.test(src), `${f} must land a TERMINAL 'error' feed row carrying the reason — a run that describes nothing must not finish 'done'`);
    assert.ok(/Settings → Intelligence/.test(src), `${f} must tell the owner where to fix it`);
    // The refusal must NOT be gated on !DRY_RUN. It was, and a dry run then walked every
    // item calling a narrator that throws — N "narration failed" lines and no cause, in the
    // mode that exists to report what WOULD happen. Only the feed WRITE may be dry-gated.
    // Order-insensitive: `!DRY_RUN && narrator.blocked` is the same evasion (independent review).
    const code = stripComments(src);
    assert.ok(!/narrator\.blocked\s*&&\s*!DRY_RUN/.test(code) && !/!DRY_RUN\s*&&\s*narrator\.blocked/.test(code),
      `${f} gates the refusal on !DRY_RUN — a dry run must report the refusal too (skip only the feed write)`);
  }
  // activityFeed has NO notice(): begin/heartbeat/finish/active/recent/reap/prune is the whole
  // surface (src/db/activity-feed.js), so `notice?.()` is a silent no-op — narrate-infer.js
  // carried exactly that for months under a comment promising the UI would show the fallback.
  // Assert against CODE only: these files legitimately discuss the dead call in prose.
  for (const f of ['describe-clusters.js', 'describe-chronicles.js', 'lib/narrate-infer.js']) {
    const src = readFileSync(new URL(`../pipeline/${f}`, import.meta.url), 'utf8');
    assert.ok(!/activityFeed\s*\??\.\s*notice/.test(stripComments(src)),
      `${f} calls activityFeed.notice(), which does not exist — it would be a silent no-op`);
  }
  // …and the method really is absent, so the rule above is grounded in the API, not folklore.
  assert.equal(typeof feedNamespace.notice, 'undefined',
    'activityFeed now HAS notice() — if it was added deliberately, use it and update this gate');
  for (const m of ['begin', 'finish']) {
    assert.equal(typeof feedNamespace[m], 'function', `activityFeed.${m}() must exist — the refusal is reported through it`);
  }
});

// ── N8 — the files N7 asserts about must actually PARSE ──────────────────────
await t('N8. every narrate pipeline entry point parses + imports (N7 reads text; text cannot see a SyntaxError)', async () => {
  // THIS GATE SHIPPED GREEN OVER AN UNPARSEABLE FILE. N7 asserts on describe-chronicles.js
  // with readFileSync + regex and never loads it, so an `Illegal return statement` (a top-level
  // `return` in an ESM `if (isMain)` block) passed every text assertion while jobs.js's spawned
  // child died at parse time — chronicle narration 100% dead, fail-soft, near-silent. Caught by
  // independent review, not by this gate. A static assertion ABOUT a file must be paired with
  // proof the file loads, or it certifies a corpse.
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  // fileURLToPath, NOT new URL(...).pathname — .pathname stays percent-encoded, so on the
  // shipped "Mycelium Dev.app" path (a space → %20) the cwd is a non-existent dir and every
  // --check throws ENOENT, which this would misreport as "does not parse" (independent review).
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  for (const f of ['pipeline/describe-clusters.js', 'pipeline/describe-chronicles.js', 'pipeline/lib/narrate-infer.js']) {
    try {
      execFileSync(process.execPath, ['--check', f], { cwd: repoRoot, stdio: 'pipe' });
    } catch (e) {
      throw new Error(`${f} does not parse: ${String(e?.stderr || e?.message).split('\n').slice(0, 3).join(' ')}`);
    }
  }
  // --check validates SYNTAX only — it never resolves imports, so a broken import graph (a
  // missing/renamed module, the retired resolveOnBoxModel as a dead named import) passes
  // --check and then dies at module-load when jobs.js spawns the file: the ORIGINAL failure
  // class, one layer deeper. Independent review drove a bad import past a --check-only N8. So
  // actually LOAD every entry point. Their `isMain` guards keep run() from firing under import
  // (describe-clusters.js gained one for exactly this). describe-clusters can't export, so
  // assert it at least resolves to a module object.
  const loaded = await Promise.all([
    import('../pipeline/lib/narrate-infer.js'),
    import('../pipeline/describe-chronicles.js'),
    import('../pipeline/describe-clusters.js'),
  ]);
  assert.ok(loaded.every((m) => m && typeof m === 'object'), 'every narrate entry point must load, not just parse');
});

// ── N9 — the LOCAL branch, which the router's gate cannot protect ────────────
await t('N9. a LOCAL narrate provider with no model_preference refuses — it never falls back to a default', async () => {
  // The isLocal branch of createNarrator bypasses the router entirely (native /api/chat for
  // speed), so requireApprovedLocal CANNOT save it — its own check is the only thing there.
  // Until this case existed, every fixture was cloud-jurisdiction and the local branch was
  // wholly untested: reverting it to `cfg.cloudModel || 'llama3.1'` left the gate fully GREEN.
  // A gate that cannot fail on a reverted branch is not covering that branch (independent
  // review, 2026-07-16).
  const localVault = (modelPref) => ({
    users: { getSettings: async () => ({ taskModels: { narrate: { providerId: 'p1' } } }) }, // categorize UNSET ⇒ nothing approved
    providers: {
      get: async () => ({ id: 'p1', provider: 'custom', base_url: 'http://127.0.0.1:11434/v1', label: 'Ollama', model_preference: modelPref, credentials: null, auth_type: 'none' }),
      getActive: async () => null,
    },
  });
  const { calls, fetchImpl } = spyOllama();
  const n = await createNarrator({ db: localVault(null), userId: 'u', fetch: fetchImpl });
  assert.equal(n.blocked, BLOCKED_NO_MODEL,
    `a local provider row with NO model_preference and no approved on-box model must refuse — got blocked=${n.blocked}. If this is undefined, the local branch resolved a default (llama3.1) the owner never picked, on the PRIMARY path.`);
  await assert.rejects(() => n.infer('name this'), (e) => e.code === 'no-approved-local-model');
  assert.deepEqual(calls, [], `nothing may reach Ollama — got ${JSON.stringify(calls)}`);
});

await t('N9b. …but the row\'s OWN model_preference IS a choice, and still runs (no regression)', async () => {
  const localVault = {
    users: { getSettings: async () => ({ taskModels: { narrate: { providerId: 'p1' } } }) },
    providers: {
      get: async () => ({ id: 'p1', provider: 'custom', base_url: 'http://127.0.0.1:11434/v1', label: 'Ollama', model_preference: 'gemma4:12b', credentials: null, auth_type: 'none' }),
      getActive: async () => null,
    },
  };
  const { calls, fetchImpl } = spyOllama();
  const n = await createNarrator({ db: localVault, userId: 'u', fetch: fetchImpl });
  assert.equal(n.blocked, undefined, 'an explicitly-chosen local model must not be refused');
  await n.infer('name this');
  // deepEqual, NOT includes(). `includes` asserts the approved model ran; it says NOTHING
  // about what ELSE ran. Independent review drove that through: a shadow
  // fetch(host+'/api/chat', {model:'llama3.1'}) alongside the approved call left this gate
  // printing GO, 12/12 — an unapproved model reading the owner's realm samples, certified
  // green by the check written to stop exactly that. N5 already had the right shape
  // ("…and nothing else"); this did not. An allow-list assertion must be exhaustive.
  assert.deepEqual(calls, ['gemma4:12b'],
    `the owner's chosen local model must run — AND NOTHING ELSE. Got ${JSON.stringify(calls)}`);
});

await t('N9c. local row with NO model_preference but categorize APPROVED ⇒ runs the approved model (fail-CLOSED, not OFF)', async () => {
  // Pins the last local-branch mutation independent review found uncaught: dropping the
  // approved fallback (`const model = cfg.cloudModel` alone) refuses where it should RUN. That
  // is fail-closed, so not a consent breach — but it silently kills narration on a legitimately
  // approved vault, and N9/N9b both stayed green on it because neither had this fixture.
  const localVault = {
    users: { getSettings: async () => ({ taskModels: { categorize: { model: 'qwen3.5:4b' }, narrate: { providerId: 'p1' } } }) },
    providers: {
      get: async () => ({ id: 'p1', provider: 'custom', base_url: 'http://127.0.0.1:11434/v1', label: 'Ollama', model_preference: null, credentials: null, auth_type: 'none' }),
      getActive: async () => null,
    },
  };
  const { calls, fetchImpl } = spyOllama();
  const n = await createNarrator({ db: localVault, userId: 'u', fetch: fetchImpl });
  assert.equal(n.blocked, undefined, 'an approved on-box model must let the local branch run, even with no model_preference on the row');
  await n.infer('name this');
  assert.deepEqual(calls, ['qwen3.5:4b'],
    `the approved on-box model must run when the local row names none — got ${JSON.stringify(calls)}`);
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — narration runs only an owner-approved on-box model, and refuses out loud when there is none' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
