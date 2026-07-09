// src/agent/scheduler.js — the autonomous wake-cycle runtime (Phase 5, Step 4b).
// Spec §5.5/§5.6. The executor D5 deferred, built as ONE engine over the existing
// streamTurn: a tick fires due scheduled_tasks as headless turns (no SSE client),
// serialized on a single lane, and advances each task's next_run.
//
// It reuses the SAME pieces as portal-chat — createAgentHarness → createAgentLoop,
// resolveInferenceConfigForTask, the getContext briefing, the granted-tool/`call`
// wrapper — but with `send` = no-op (nothing to stream to) and a READ-SAFE tool set
// (Step 4b grants no write/egress tools; the gated autonomy tools land in Step 5).
//
// SECURITY (§1/§3/§8):
//  • Runs ONLY on the vault-unlocked path (boot gates it behind !injectedKeys).
//  • Fail-closed: a turn that throws (incl. any decrypt failure) → finishRun('error')
//    with a CODE only — never prompt/response text, never e.message, in runs or logs.
//  • harness_runs is content-free (counts + prompt_hash). The task `prompt` stays
//    encrypted at rest; it is only ever in memory for the duration of a turn.
//  • Single-flight: an in-memory `executing` set + the 30s wasRecentlyCompleted
//    dedup window stop a task double-firing across overlapping ticks / a boot.

import { createHash } from 'node:crypto';
import { createAgentHarness } from './harness.js';
import { createAgentLoop } from './loop.js';
import { createAgentHooks, autonomousToolGuard } from './hooks.js';
import { createLane } from './lane.js';
import { computeNextRun, parseSchedule } from './scheduler-time.js';
import { classifyProviderError } from './provider-errors.js';
import { runAgentTurn } from './run-turn.js';
import { cycleTurnOpts, cycleByName } from './cycle-prompts.js';
import { finalizeCycleOutput, cycleDeliveryId } from './cycle-output.js';
import { hasEnoughActivity } from './cycle-activity.js';
import { resolveTaskCapability } from '../inference/capability.js';
import { resolvePersona } from '../skills/store.js';
import { createEgressAuditSink } from '../inference/egress.js';
import { createUsageSink } from '../inference/usage.js';

const DEFAULT_TICK_MS = 30_000;
// Transient-failure retry backoff (minutes). A 429/5xx/network blip on the model provider
// shouldn't lose a check-in until its next schedule (~24h) — retry a few times, growing.
const RETRY_BACKOFF_MIN = [5, 15, 45];

const SCHEDULER_SYSTEM = [
  'You are running an autonomous scheduled task for the owner of this Mycelium vault,',
  'on their own machine — they are not present at the keyboard right now. Carry out the',
  'task below using the briefing as your current working context. Be concise and',
  'self-contained; there is no back-and-forth this turn.',
].join(' ');

// A run error becomes a short stable CODE, never plaintext (§1). Prefer machine
// fields (code/status); fall back to a generic label — NEVER the message text.
const errCode = (e) => String(e?.code || e?.status || (e?.name && e.name !== 'Error' ? e.name : 'error')).slice(0, 40);

/**
 * Create the scheduler runtime.
 * @param {object} o
 * @param {object}   o.db           keyed db namespace (has db.harness, db.users)
 * @param {string}   o.userId       boot owner id (tasks also carry their own user_id)
 * @param {Array}    o.tools        the tool registry defs (same array portal-chat gets)
 * @param {object}   o.handlers     the in-proc tool handler map
 * @param {(task:object, text:string, meta?:{model?:string|null})=>Promise<void>} [o.deliver]
 *                    output_target sink (non-'none' targets); `meta.model` = WHICH model
 *                    produced the text (recorded on the persisted message). Absent ⇒ logged + skipped.
 * @param {(task:object)=>Promise<object>} [o.runTurn]  turn-executor override (tests)
 * @param {Function} [o.fetchImpl]
 * @param {(m:string)=>void} [o.logger]
 * @param {number}   [o.tickMs]
 */
export function createScheduler({ db, userId, tools = [], handlers = {}, deliver, runTurn: runTurnOverride, fetchImpl = globalThis.fetch, logger = () => {}, tickMs = DEFAULT_TICK_MS } = {}) {
  if (!db || !db.harness) throw new TypeError('createScheduler: db with db.harness required');
  if (typeof userId !== 'string') throw new TypeError('createScheduler: userId required');

  const lane = createLane();
  const executing = new Set();       // task ids currently queued/running (dedup across ticks)
  const retries = new Map();          // task id → transient-failure retry attempt count (cleared on success/give-up)
  const ctrl = new AbortController(); // stop() aborts in-flight turns
  let timer = null;
  let stopped = false;

  // Runtime tool guard (G1): defense-in-depth under the grant-time allowlist; opt-in via
  // MYCELIUM_AUTONOMOUS_TOOL_DENY (unset ⇒ undefined ⇒ unchanged).
  const hooks = createAgentHooks({ db, userId, source: 'scheduler', toolGuard: autonomousToolGuard() });
  const harness = createAgentHarness({
    onEgress: createEgressAuditSink(db, userId),
    onUsage: createUsageSink(db, userId, { source: 'scheduler' }),
    hooks, surface: 'scheduler',
    fetch: fetchImpl,
    logger: (m) => logger(`harness: ${m}`),
  });
  const loop = createAgentLoop({ harness, logger: (m) => logger(`loop: ${m}`) });

  const deliverFn = typeof deliver === 'function'
    ? deliver
    : async (task) => { logger(`scheduler: no deliver sink — dropping output for task ${task.id} (target=${task.output_target})`); };

  // Single-flight key: same task within the dedup window ⇒ duplicate. Includes the
  // task id so distinct tasks with identical prompts never collide. Recurring tasks
  // fire >30s apart (interval floor is 30m) so a legitimate re-run never dedups.
  const promptHash = (task) => createHash('sha256').update(`${task.id}\n${task.prompt || ''}`).digest('hex');

  // Build + drive one headless turn via the shared assembly (tests inject runTurnOverride).
  // A scheduled turn opts into whatever gated tools the task named in enabled_tools.
  // A reflection-cycle task (Context Engine L2) runs with the relationship persona as its
  // system preamble and routes to the cloud-by-default 'reflection' inference task; any other
  // task keeps SCHEDULER_SYSTEM + the 'harness' model. cycleTurnOpts is the single decision point.
  async function buildAndRunTurn(task) {
    const { isCycle, inferenceTask } = cycleTurnOpts(task);
    const tUser = task.user_id || userId;
    // Quiet-day gate (C2): a check-in cycle whose window has too little REAL activity skips
    // in CODE, BEFORE composing — so an empty day can't produce a "system status" meta-report,
    // and no tokens are spent. Internal cycles (no minActivity) fall through and run.
    if (isCycle) {
      const def = cycleByName(task.name);
      if (def?.minActivity) {
        const { enough, count, min } = await hasEnoughActivity(db, tUser, def, { now: new Date(), tz: task.tz || null });
        if (!enough) { logger(`scheduler: quiet-day skip ${task.id} (${count}/${min})`); return { skipped: 'quiet' }; }
      }
      // Model-capability guard (C3): a cycle is worthless on a model that can't call tools
      // (it can't read the day or write memory — it just fabricates). Skip before composing;
      // the dashboard's model-health banner tells the user to pick a capable model.
      const cap = await resolveTaskCapability(db, tUser, inferenceTask, { fetch: fetchImpl });
      if (cap.configured && !cap.toolsCapable) { logger(`scheduler: model-incapable skip ${task.id} (${cap.model})`); return { skipped: 'model-incapable' }; }
    }
    // A reflection cycle injects the user-editable persona (skills/persona/soul.md, resolved
    // with a hard fallback to the ported default); any other task keeps the generic preamble.
    const systemExtra = isCycle ? await resolvePersona(db, tUser) : SCHEDULER_SYSTEM;
    return runAgentTurn(
      { db, userId: tUser, tools, handlers, loop, fetchImpl, signal: ctrl.signal, hooks },
      {
        userMessage: task.prompt || '',
        systemExtra,
        enabledTools: task.enabled_tools || [],
        inferenceTask,
      },
    );
  }

  // Advance the task's next_run from its schedule. A 'once' schedule with no further fire
  // is marked completed. A RECURRING cycle should always have a next fire — a null there is
  // an anomaly, NOT an end-of-life: re-arm it an hour out rather than silently 'completing'
  // (which would kill the cycle with no trace), so it self-heals and stays observable.
  async function advance(task, lastStatus, lastError = null) {
    const tUser = task.user_id || userId;
    let nextRun = null;
    try { nextRun = computeNextRun(task.schedule, { after: new Date(), tz: task.tz || null, scheduledAt: task.scheduled_at || null }); }
    catch { nextRun = null; }
    let parsed = null;
    try { parsed = parseSchedule(task.schedule); } catch { parsed = null; }
    const isOnce = !parsed || parsed.type === 'once';
    if (!nextRun && !isOnce) {
      nextRun = new Date(Date.now() + 3600_000).toISOString();
      logger(`scheduler: next_run compute failed for recurring ${task.id} (${task.schedule}); re-armed +1h`);
      if (lastStatus !== 'error') lastStatus = 'next-run-recovered';
    }
    await db.harness.markTaskRun(tUser, task.id, { nextRun, lastStatus, lastError });
    if (!nextRun && isOnce) { try { await db.harness.setTaskStatus(tUser, task.id, 'completed'); } catch { /* non-fatal */ } }
  }

  async function runTask(task) {
    const tUser = task.user_id || userId;
    const hash = promptHash(task);
    let runId = null;
    try {
      if (await db.harness.wasRecentlyCompleted(hash)) { logger(`scheduler: dedup skip ${task.id}`); await advance(task, 'skipped-dup'); return; }

      // Daily token-budget gate (Step 7c): unattended turns shouldn't run away with the
      // bill. MYCELIUM_DAILY_TOKEN_BUDGET (0/unset = unlimited). Counts only; fail-open
      // (a usage-read failure never blocks a turn).
      // Essential cycles (morning/evening check-ins) are the user-facing value and are
      // EXEMPT — the budget throttles background work, not the person's daily touchpoints.
      const budget = Number(process.env.MYCELIUM_DAILY_TOKEN_BUDGET) || 0;
      if (budget > 0 && !task.essential) {
        try {
          const { totals } = await db.usage.summary(tUser, { sinceDays: 1 });
          const spent = (totals?.inputTokens || 0) + (totals?.outputTokens || 0);
          if (spent >= budget) { logger(`scheduler: daily budget reached (${spent}/${budget}); skip ${task.id}`); await advance(task, 'skipped-budget'); return; }
        } catch { /* fail-open */ }
      }

      runId = await db.harness.openRun({ userId: tUser, trigger: 'schedule', taskId: task.id, promptHash: hash });

      const r = await (runTurnOverride || buildAndRunTurn)(task);

      // ONE robust decision point (src/agent/cycle-output.js): deliver a grounded check-in,
      // or skip cleanly. Suppresses the reserved NO_REPLY sentinel (however wrapped), a
      // truncated fragment, an empty turn, and self-referential "system status" meta-reports
      // — the leaks that reached people in production. Pre-turn skips (no-model, model-
      // incapable, quiet day) carry their own status through unchanged.
      const decision = finalizeCycleOutput(r, task);
      if (decision.action === 'deliver') {
        try {
          await deliverFn(task, decision.text, { model: r?.model || null, id: cycleDeliveryId(task) });
        } catch (e) {
          // Delivery failure is NOT a silent 'done' — the check-in was composed but never
          // reached the person; record it so the dashboard/last_status shows the drop.
          const code = errCode(e);
          logger(`scheduler: deliver failed for ${task.id}: ${code}`);
          await db.harness.finishRun(runId, { status: 'delivery-failed', error: code });
          await advance(task, 'delivery-failed', code);
          return;
        }
      }
      await db.harness.finishRun(runId, { status: decision.status });
      await advance(task, decision.status);
      retries.delete(task.id); // a completed fire (delivered or cleanly skipped) clears retry state
    } catch (e) {
      const code = errCode(e);
      logger(`scheduler: task ${task.id} failed (${code})`);
      if (runId) { try { await db.harness.finishRun(runId, { status: 'error', error: code }); } catch { /* */ } }
      // Transient TRANSPORT failure (429/5xx/network) → bounded short-backoff retry instead
      // of losing the cycle until its next schedule (~24h). Requires BOTH a retryable class
      // AND a concrete transport signal (status/network code) — an arbitrary turn error (code
      // bug, decrypt failure) must NOT be retried, it just ends 'error'. Auth/abort → give up.
      let isTransient = false;
      try {
        const status = Number(e?.status) || 0;
        const netHint = String(e?.code || e?.name || '');
        isTransient = !!classifyProviderError(e)?.retryable
          && (status === 429 || status >= 500 || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE/i.test(netHint));
      } catch { isTransient = false; }
      const attempt = retries.get(task.id) || 0;
      if (isTransient && attempt < RETRY_BACKOFF_MIN.length) {
        const nextRun = new Date(Date.now() + RETRY_BACKOFF_MIN[attempt] * 60_000).toISOString();
        retries.set(task.id, attempt + 1);
        try { await db.harness.markTaskRun(tUser, task.id, { nextRun, lastStatus: 'retry-scheduled', lastError: code }); }
        catch { try { await advance(task, 'error', code); } catch { /* */ } }
        logger(`scheduler: retry ${attempt + 1}/${RETRY_BACKOFF_MIN.length} for ${task.id} in ${RETRY_BACKOFF_MIN[attempt]}m (${code})`);
        return;
      }
      retries.delete(task.id); // give up → advance to the next real schedule, reset for next fire
      try { await advance(task, 'error', code); } catch { /* */ }
    }
  }

  async function tick() {
    if (stopped) return;
    let due = [];
    try { due = await db.harness.dueTasks(new Date().toISOString()); }
    catch (e) { logger(`scheduler: tick query failed (${errCode(e)})`); return; }
    for (const task of due) {
      if (executing.has(task.id)) continue;        // already queued this cycle / still running
      executing.add(task.id);
      lane.enqueue(() => runTask(task)).finally(() => executing.delete(task.id));
    }
  }

  // Run one cycle and await the lane to fully drain — the gate's single entry point.
  async function tickOnce() {
    await tick();
    await lane.enqueue(() => Promise.resolve()); // resolves only after all queued tasks settle (serial)
  }

  function start() {
    if (timer || stopped) return;
    const loopTick = async () => {
      try { await tick(); } catch (e) { logger(`scheduler: loop tick error (${errCode(e)})`); }
      if (!stopped) { timer = setTimeout(loopTick, tickMs); timer.unref?.(); }
    };
    timer = setTimeout(loopTick, 1000); // let boot finish before the first sweep
    timer.unref?.();
    logger('scheduler: started');
  }

  function stop() {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    try { ctrl.abort(); } catch { /* */ }
  }

  return { start, stop, tick, tickOnce, _lane: lane };
}

export default createScheduler;
