// pipeline/lib/narrate-infer.js — the inference seam for the describe pipeline
// (naming realms/territories + chronicling them).
//
// THE selected provider names things. resolveInferenceConfig() returns the row the
// user activated in Settings → Intelligence (gemma / Regolo / Claude / …); the
// describe scripts call THIS, never the Claude CLI (the old describe-clusters.js
// shelled out to `claude -p`, which fails on any box without an authed CLI → every
// realm fell back to "Realm N").
//
// Speed: a LOCAL Ollama provider is reached over its NATIVE /api/chat with
// think:false + format:'json'. Measured on gemma4:12b: native think:false = ~4s with
// zero reasoning vs ~36s over the OpenAI-compatible /v1 surface (which ignores both
// think:false AND response_format for reasoning models). Cloud providers go through
// the existing inference router (audited egress).

import { resolveInferenceConfigForTask } from '../../src/inference/resolve.js';
// The FAIL-CLOSED reader of settings.taskModels.categorize.model (#148) — the ONLY reader.
// NOT resolveOnBoxModel + labelingRecommendedModel(), which is what this file used until
// 2026-07-16: see the §M block in createNarrator below.
import { defaultLabelModel } from '../../src/enrich/drainer.js';
import { createInferenceRouter } from '../../src/inference/router.js';
import { createEgressAuditSink } from '../../src/inference/egress.js';
import { createUsageSink } from '../../src/inference/usage.js';
import { resolveModelProfile } from '../../src/inference/model-profile.js';
import { planGeneration, estimateTokens } from '../../src/inference/token-budget.js';
import { DEFAULT_LOCAL_MODEL, isLoopbackUrl } from '../../src/inference/local.js';
import { InferenceError } from '../../src/inference/errors.js';

/** The narrator refused: no cloud provider AND no owner-approved on-box model. */
export const BLOCKED_NO_MODEL = 'no-approved-on-box-model';

// Mirrors router.js's hasCloud() EXACTLY — including its `?? env` coalesce, which is not a
// detail: resolve.js returns {} for "no provider configured", and the router would still find
// ANTHROPIC_API_KEY / OPENAI_API_KEY / INFERENCE_BASE_URL in env and route to cloud. A stricter
// check here would refuse up front on a config where cloud demonstrably works — turning a
// consent fix into an outage. This predicate decides only whether a cloud failure has anywhere
// legitimate to land; the router still decides whether cloud is tried. They must not drift.
// (`??`, not `||`, because mapRowToConfig sets anthropicApiKey:'' on OpenAI-compat rows and ''
// must stay falsy-but-present rather than reaching for an env key — again, as the router does.)
const hasCloudCreds = (cfg, env = process.env) => Boolean(
  (cfg?.anthropicApiKey ?? env.ANTHROPIC_API_KEY)
  || cfg?.claudeOAuthToken
  || (cfg?.openaiApiKey ?? env.OPENAI_API_KEY)
  || (cfg?.baseUrl ?? env.INFERENCE_BASE_URL),
);

// A narrator that refuses. Throws the SAME typed error the router's own gate throws, so a
// caller distinguishes "refused" from "the model returned junk" by code, not by message.
const blockedInfer = async () => {
  throw new InferenceError(
    'narrate: no cloud provider and no approved on-box model — nothing safe to run',
    { backend: 'local', code: 'no-approved-local-model' },
  );
};

/**
 * Does this cfg describe a model on THIS MACHINE — i.e. may narration take the direct-fetch
 * branch, which skips the §4g gate AND the egress audit?
 *
 * Derived from the URL ALONE — deliberately NOT from `cfg.jurisdiction`. That label is computed
 * upstream (presets.js jurisdictionForBaseUrl), and the `cfg.jurisdiction === 'local' ||` half
 * that used to be inline here meant the WRONG half won: `.local` (mDNS = another machine) mapped
 * to 'local' there, so an off-box host took the silent branch and narration left the machine with
 * no audit row (independent review, 2026-07-16). presets.js no longer does that — this is the
 * second, independent layer (§2): the branch stays loopback-only even if a future jurisdiction
 * mapping is wrong again.
 *
 * It is a separate exported function ONLY so the gate can pin it. Inline, it was unpinnable —
 * reachable only when layer 1 is ALSO broken, so reverting it alone left verify:narrate-
 * sovereignty GO and nothing would have caught its removal (independent review, 2026-07-16;
 * the anti-pattern this very gate documents at N13/N14). @see isLoopbackUrl
 * @param {{baseUrl?:string, jurisdiction?:string}} [cfg]
 * @returns {boolean} true ⇒ provably on-box; false ⇒ take the audited, §4g-gated router path
 */
export function isOnBoxCfg(cfg) {
  return !!cfg?.baseUrl && isLoopbackUrl(cfg.baseUrl);
}

/**
 * Build a narrator bound to the user's ACTIVE provider.
 * @param {object} a
 * @param {object} a.db        assembled vault db (needs db.providers)
 * @param {string} a.userId
 * @param {typeof fetch} [a.fetch]
 * @returns {Promise<{ infer:(prompt:string,opts?:{maxTokens?:number})=>Promise<string>, label:string,
 *   local:boolean, blocked?:'no-approved-on-box-model' }>}
 *   `blocked` is set when there is nothing safe to run: no cloud provider and no owner-approved
 *   on-box model. `infer` then throws instead of running an unapproved model — CALLERS MUST
 *   REPORT IT (describe-clusters.js / describe-chronicles.js), because a narrator that quietly
 *   names nothing is indistinguishable from one that had nothing to name.
 */
export async function createNarrator({ db, userId, fetch = globalThis.fetch }) {
  const cfg = await resolveInferenceConfigForTask(db, userId, 'narrate');
  const onUsage = createUsageSink(db, userId, { source: 'enrichment' });
  // Anything not PROVABLY on-box falls through to the router below, which audits + applies §4g.
  // Fail-safe direction: the worst case is an on-box model taking the audited path, not an
  // off-box host taking the silent one. @see isOnBoxCfg for why this is not `cfg.jurisdiction`
  const isLocal = isOnBoxCfg(cfg);
  const label = cfg.label || (isLocal ? 'local model' : cfg.anthropicApiKey ? 'Claude' : cfg.baseUrl ? 'custom' : 'local model');
  // The one approved on-box model name, or null. Resolved BEFORE the branch: both branches can
  // run a local model, so both need the approval. See the §M block below for why fail-closed.
  const approvedOnBox = await defaultLabelModel(db, userId);

  // ── Local Ollama: native /api/chat, think OFF, JSON-constrained — fast + reliable.
  if (isLocal && cfg.baseUrl) {
    const host = cfg.baseUrl.replace(/\/v1\/?$/, '').replace(/\/+$/, ''); // strip the OpenAI-compat /v1 suffix
    // cloudModel = the user's model_preference on the ACTIVE provider (Settings →
    // Intelligence) — the same value chat resolves.
    //
    // §M: this used to read `cfg.cloudModel || DEFAULT_LOCAL_MODEL`, so a local provider row
    // saved with NO model_preference ran llama3.1 — a model the owner never picked, on the
    // PRIMARY path (this branch bypasses the router, so the router's gate cannot save it).
    // Narrower than the fallback hole below (it needs a deliberately-configured local row) but
    // the same defect, in the same file: a default standing in for a choice. The row's own
    // model_preference IS a choice, so it wins; otherwise fall back to the approved on-box
    // model, and refuse if there is none.
    const model = cfg.cloudModel || approvedOnBox;
    if (!model) {
      try { process.stderr.write('[narrate] local provider has no model selected and no on-box model is approved — refusing (Settings → Intelligence)\n'); } catch { /* never break narration */ }
      return { infer: blockedInfer, label, local: true, blocked: BLOCKED_NO_MODEL };
    }
    // Model-aware sizing: resolve the model's real window so we can size num_ctx to
    // hold prompt + reply. Without it Ollama defaults to ~4096 and a long narration
    // prompt silently truncates the JSON reply → a lost run. Fail-soft (cached).
    const profile = await resolveModelProfile({ ...cfg, baseUrl: host, jurisdiction: 'local' }, { fetch, defaultModel: model }).catch(() => null);
    const infer = async (prompt, { maxTokens = 700 } = {}) => {
      const plan = profile ? planGeneration(profile, { task: 'narrate', inputTokens: estimateTokens(prompt), requestedMaxTokens: maxTokens }) : null;
      const options = { num_predict: plan ? plan.maxTokens : maxTokens };
      if (plan?.numCtx) options.num_ctx = plan.numCtx;
      const res = await fetch(`${host}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,          // skip the reasoning preamble (9× faster on gemma/qwen)
          format: 'json',        // constrain decoding to valid JSON — no prose, no fences
          options,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`ollama /api/chat ${res.status}`);
      const d = await res.json();
      // §12 token-usage accounting — Ollama /api/chat reports real counts. Counts only.
      if (typeof onUsage === 'function') { try { onUsage({ area: 'narrate', isLocal: true, provider: 'local', model, jurisdiction: 'local', inputTokens: d?.prompt_eval_count, outputTokens: d?.eval_count, estimated: false }); } catch { /* never break narration */ } }
      return d?.message?.content || '';
    };
    return { infer, label, local: true };
  }

  // ── Cloud / remote: the audited inference router (anthropic or openai-compatible).
  // On a cloud failure the router falls back to ON-BOX — point that fallback at the user's
  // CONFIGURED on-box model (the labeling pick, e.g. qwen3.5:4b) instead of the generic
  // DEFAULT_LOCAL_MODEL (llama3.1), and surface it via onCloudFallback so a Regolo outage
  // degrades visibly to the small local model the user chose — never silently to a heavy 8B
  // that cooks the machine (the 2026-06-29 incident).
  //
  // ── §M CONSENT: the on-box fallback may only be a model the OWNER APPROVED ──
  // That paragraph was right about the SIZE of the fallback and wrong about its LEGITIMACY:
  // "the on-box model the user chose" was only true when they had chosen one.
  // defaultLabelModel is FAIL-CLOSED: unset ⇒ null, settings-read throws ⇒ null. Under #148
  // that setting IS the approval ("NO MODEL ⇒ NOT APPROVED ⇒ NEVER PULL, NEVER RUN"), and
  // this line used to read the same key through resolve.js's fail-OPEN resolveOnBoxModel with
  // labelingRecommendedModel() as the default — so a vault that had approved nothing still ran
  // qwen3.5:4b here, if it happened to be on disk. It never PULLED (pullModel has two callers,
  // both gated), so M's download guarantee held; this closes the "NEVER RUN" half.
  //
  // Reachable with NO user action: server-rest.js auto-generate → jobs.js → run-clustering.sh
  // → describe-clusters.js → createNarrator.
  //
  // Reusing the LABELING approval for narrate's fallback is deliberate and is the precedent
  // agent/run-turn.js set (#151): both are on-box, so the privacy story is identical, and the
  // owner approved *that model, running locally*. What they never approved is a model they
  // never picked. (`approvedOnBox` is resolved above — both branches need it.)
  //
  // ⚠️ BE HONEST ABOUT WHAT THIS IS. Reusing categorize's approval for narrate's fallback is
  // NOT itself an approval — the owner never said "yes, narrate on qwen". What it IS: the
  // narrowest choice that (a) never runs a model the owner didn't approve FOR LOCAL EXECUTION,
  // and (b) doesn't silently kill narration. It leans on a weaker but real fact — the owner
  // approved THIS model to run on-box on their private messages — rather than on a
  // narrate-specific yes that does not exist. Absence of a place to say no is not a yes; this
  // just declines to invent one, and picks the least-surprising model available instead of a
  // hardcoded default. (Independent review, 2026-07-16 — the earlier "narrower reading of
  // consent" framing inverted its own terms; corrected.)
  //
  // Why it does NOT contradict `enrich` (drainer.js insists that is INDEPENDENTLY approved):
  //   • `enrich` is an ONBOX_TASK with its OWN select in Settings → Intelligence. Borrowing
  //     there would override a choice the owner was actually offered — including "off".
  //   • `narrate` is a CLOUD task with NO on-box select. On-box is only ever a fallback, so
  //     there is nothing to override — the choice is reuse-the-approved-model or never-fall-
  //     back, never "ignore what they picked".
  // The real surprise to guard is scope: describe-clusters feeds ~5k-char timeline samples +
  // the existing realm essence, broader than the per-message labeling the select advertises.
  // Bounded because it is on-box (no egress) and now VISIBLE (the refusal/fallback surfaces),
  // but the honest fix is narrate's own on-box select — then this reads THAT key and the
  // borrow goes away. Tracked as the third option (create the surface), not pretended away.
  // NEVER pulls (gated in the drainer); never egresses.

  // ⚠️ THE FALLBACK IS NOT THE ONLY THING AT STAKE, so this does NOT just refuse up front.
  // Three states, because a cloud provider the owner CONFIGURED is a consent-bearing choice of
  // its own — it is only the *substitute* that needs approval:
  //
  //   cloud + approved  → fallback allowed, to the approved model (today's behaviour, kept).
  //   cloud + none      → cloud is still the owner's pick and still runs. But there is nothing
  //                       legitimate to fall back TO, so a cloud failure must SURFACE, not
  //                       quietly become an unapproved model.
  //   no cloud + none   → nothing safe to run at all → refuse honestly, up front, and let the
  //                       caller report it. The drainer's §3.5 "no_model" steady state and
  //                       run-turn's `skipped:'sensitive-no-safe-provider'`, one task over.
  //
  // requireApprovedLocal makes the router itself fail-closed on EVERY local path rather than
  // trusting this file to have reasoned about each: passing localModel:null alone would just
  // hit router.js's `|| DEFAULT_LOCAL_MODEL` coalesce and run llama3.1 — a heavier unapproved
  // model than the one we set out to stop, i.e. the naive "swap the resolver" fix is WORSE
  // than the bug. It also covers the §4g sensitive-US block (router.js), which ignores
  // cloudFallbackToLocal and is the silent path — narrate becomes sensitive in #151.
  if (!hasCloudCreds(cfg) && !approvedOnBox) {
    // No cloud, no approved on-box model. Say so ONCE, here — not N times as N identical
    // per-item failures the caller has to infer a cause from.
    try { process.stderr.write('[narrate] no cloud provider and no approved on-box model — refusing (Settings → Intelligence)\n'); } catch { /* never break narration */ }
    return { infer: blockedInfer, label, local: true, blocked: BLOCKED_NO_MODEL };
  }
  const router = createInferenceRouter({
    ...cfg,
    // createNarrator's injectable `fetch` was accepted, documented, and then NOT passed here —
    // only the local branch above honoured it, so the cloud branch and its on-box fallback both
    // used globalThis.fetch. That made this path untestable offline (a gate asserting "no
    // unapproved model ran" watched an injected fetch the code never called — a FALSE GREEN
    // that passes whatever runs) and let a "hermetic" test reach the real api.regolo.ai. Found
    // by driving it, 2026-07-16. An injection point that isn't wired is worse than none.
    fetch,
    localModel: approvedOnBox,
    requireApprovedLocal: true,
    // No approved on-box model ⇒ there is no legitimate fallback ⇒ a cloud failure must reach
    // the caller as a failure. (requireApprovedLocal would refuse anyway; this keeps the error
    // the caller sees the TRUE one — the cloud's — instead of the refusal that followed it.)
    cloudFallbackToLocal: Boolean(approvedOnBox),
    onEgress: createEgressAuditSink(db, userId),
    onUsage,
    onCloudFallback: (info) => {
      try { process.stderr.write(`[narrate] cloud '${info.provider}/${info.model}' failed (${info.status ?? 'err'}) — using on-box ${info.localModel}\n`); } catch { /* never break narration */ }
      // ⚠️ A `db.activityFeed.notice({...})` call lived here, optional-chained, under a comment
      // promising the UI would show "your model failed, a local one ran instead". activityFeed
      // HAS NO notice() — begin/heartbeat/finish/active/recent/reap/prune is the whole surface
      // (src/db/activity-feed.js) — so `?.()` swallowed it and the promise was never kept. The
      // fallback has only ever been visible in stderr. Removed rather than left as decoration.
      //
      // NOT replaced with a begin/finish row here: the describe scripts already own the run's
      // feed row (describe-clusters.js), and a second row mid-run would read as a second job.
      // Threading that row's id into the narrator is the real fix and is its own diff —
      // task_narrate_fallback_visibility. Recorded honestly instead of papered over.
    },
  });
  const infer = (prompt, { maxTokens = 700 } = {}) => router.infer({ task: 'narrate', prompt, maxTokens });
  return { infer, label, local: false };
}

export default createNarrator;
