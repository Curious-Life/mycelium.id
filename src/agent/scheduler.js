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
import { createLane } from './lane.js';
import { computeNextRun } from './scheduler-time.js';
import { runAgentTurn } from './run-turn.js';
import { cycleTurnOpts, isNoReply } from './cycle-prompts.js';
import { resolvePersona } from '../skills/store.js';
import { createEgressAuditSink } from '../inference/egress.js';
import { createUsageSink } from '../inference/usage.js';

const DEFAULT_TICK_MS = 30_000;

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
 * @param {(task:object, text:string)=>Promise<void>} [o.deliver]  output_target sink
 *                    (non-'none' targets). Absent ⇒ delivery is logged + skipped.
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
  const ctrl = new AbortController(); // stop() aborts in-flight turns
  let timer = null;
  let stopped = false;

  const harness = createAgentHarness({
    onEgress: createEgressAuditSink(db, userId),
    onUsage: createUsageSink(db, userId, { source: 'scheduler' }),
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
    // A reflection cycle injects the user-editable persona (skills/persona/soul.md, resolved
    // with a hard fallback to the ported default); any other task keeps the generic preamble.
    const systemExtra = isCycle ? await resolvePersona(db, tUser) : SCHEDULER_SYSTEM;
    return runAgentTurn(
      { db, userId: tUser, tools, handlers, loop, fetchImpl, signal: ctrl.signal },
      {
        userMessage: task.prompt || '',
        systemExtra,
        enabledTools: task.enabled_tools || [],
        inferenceTask,
      },
    );
  }

  // Advance the task's next_run from its schedule; a schedule with no further fire
  // (a past 'once') is marked completed so it doesn't linger active with null next_run.
  async function advance(task, lastStatus, lastError = null) {
    const tUser = task.user_id || userId;
    let nextRun = null;
    try { nextRun = computeNextRun(task.schedule, { after: new Date(), tz: task.tz || null, scheduledAt: task.scheduled_at || null }); }
    catch { nextRun = null; }
    await db.harness.markTaskRun(tUser, task.id, { nextRun, lastStatus, lastError });
    if (!nextRun) { try { await db.harness.setTaskStatus(tUser, task.id, 'completed'); } catch { /* non-fatal */ } }
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
      const budget = Number(process.env.MYCELIUM_DAILY_TOKEN_BUDGET) || 0;
      if (budget > 0) {
        try {
          const { totals } = await db.usage.summary(tUser, { sinceDays: 1 });
          const spent = (totals?.inputTokens || 0) + (totals?.outputTokens || 0);
          if (spent >= budget) { logger(`scheduler: daily budget reached (${spent}/${budget}); skip ${task.id}`); await advance(task, 'skipped-budget'); return; }
        } catch { /* fail-open */ }
      }

      runId = await db.harness.openRun({ userId: tUser, trigger: 'schedule', taskId: task.id, promptHash: hash });

      const r = await (runTurnOverride || buildAndRunTurn)(task);

      if (r && r.skipped === 'no-model') {
        await db.harness.finishRun(runId, { status: 'skipped-no-model' });
        await advance(task, 'skipped-no-model');
        return;
      }
      const text = (r && typeof r.text === 'string') ? r.text : '';
      const status = r?.truncated ? 'truncated' : 'done';
      // NO_REPLY is the canonical "skip the check-in" sentinel — a cycle that returns it
      // delivers nothing (never surface the literal token to the person).
      if (text.trim() && !isNoReply(text) && task.output_target && task.output_target !== 'none') {
        try { await deliverFn(task, text); } catch (e) { logger(`scheduler: deliver failed for ${task.id}: ${errCode(e)}`); }
      }
      await db.harness.finishRun(runId, { status });
      await advance(task, status);
    } catch (e) {
      const code = errCode(e);
      logger(`scheduler: task ${task.id} failed (${code})`);
      if (runId) { try { await db.harness.finishRun(runId, { status: 'error', error: code }); } catch { /* */ } }
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
