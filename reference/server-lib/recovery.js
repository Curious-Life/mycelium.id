/**
 * Recovery + continuation engine.
 *
 * Two parallel machines live here:
 *
 *   1. **Checkpoint recovery** — runs once at startup. Any task whose
 *      checkpoint is in the `running` state when the agent boots was
 *      interrupted (crash/restart/timeout). If young enough, resume
 *      via the Claude Code session UUID; otherwise notify + clear.
 *
 *   2. **Continuation engine** — wraps `runClaudeCode` with retry
 *      semantics for timeout, rate-limit, empty-output, context-
 *      overflow, and max-turns conditions. Rate-limit failures are
 *      written to disk as deferred continuations and replayed by a
 *      periodic scanner; every other retry type loops in-process.
 *
 * Factored as a closure so the per-channel notification cooldown Map
 * stays private (tests get a fresh instance). All side-effecting ops
 * (fetch, db, Claude runner, checkpoint/session/continuation stores)
 * come in as deps so branches can be exercised without touching disk
 * or network.
 *
 * @typedef {object} RecoveryDeps
 * @property {string} agentId
 * @property {string} logPrefix
 * @property {{ root: string, repo: string }} paths
 * @property {number} [maxResumeAgeMs] default 30min
 * @property {object} continuationConfig — { timeout, rateLimit, scanIntervalMs, maxAge }
 * @property {number} maxContinuations — ceiling on max-turns retries
 * @property {string|null} [discordChannel]
 * @property {string|null} [discordBotUrl]
 * @property {string|null} [telegramBotUrl]
 * @property {string|null} [whatsappBotUrl]
 * @property {(agentId: string) => string} resolveBotHttpUrl
 * @property {(type: string, content: string, meta?: object) => void} addActivity
 * @property {() => boolean} hasActiveTasks
 * @property {() => void} incrementActiveTask
 * @property {() => void} decrementActiveTask
 * @property {{ runtime: () => any, activeTaskCount: () => number }} runtimeState
 * @property {(channelId?: string) => number} [getExplicitSendCount] — PR 5.6: guard EMPTY_OUTPUT retry against double-delivery when explicit sends already fired
 * @property {(prompt: string, opts: object) => Promise<{ result: string, sessionId: string|null, hitMaxTurns?: boolean }>} runClaudeCode
 * @property {(runtime: any, taskType: string) => string} getModelForTask
 * @property {(err: Error) => string} classifyError
 * @property {object} ErrorReason
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => Promise<string>} loadSystemPrompt
 * @property {(text: string) => boolean} isSilentReply
 * @property {(s: string, a: number, b?: number) => string} trunc
 * @property {object} checkpointStore — readAllCheckpoints, clearCheckpoint, archiveCheckpoint, getCheckpointSummary, cleanupArchivedCheckpoints
 * @property {object} sessionStore — getSessionMessages, cleanupOldSessions
 * @property {object} continuationStore — writeContinuation, readReadyContinuations, readAllContinuations, updateContinuation, clearContinuation, cleanupOldContinuations
 * @property {(url: string, init?: any) => Promise<any>} [fetch] defaults to globalThis.fetch
 */

import { createOperatorNotifier } from './agent-egress.js';
import * as defaultEgress from './egress.js';
import { setActiveTurn, clearActiveTurn } from './inbound-context.js';

export function createRecovery(deps) {
  if (!deps) throw new TypeError('createRecovery: deps required');
  const {
    agentId, logPrefix, paths,
    maxResumeAgeMs = 30 * 60 * 1000,
    continuationConfig, maxContinuations,
    discordChannel = null, discordBotUrl = null,
    telegramBotUrl = null, whatsappBotUrl = null,
    resolveBotHttpUrl,
    addActivity, hasActiveTasks, incrementActiveTask, decrementActiveTask,
    runtimeState,
    getExplicitSendCount,
    runClaudeCode, getModelForTask,
    classifyError, ErrorReason, sleep,
    loadSystemPrompt, isSilentReply, trunc,
    checkpointStore, sessionStore, continuationStore,
    fetch: fetchImpl = globalThis.fetch,
    operatorNotifier: notifierOverride,
    // Phase 1 (EGRESS-PROVENANCE): notifyContinuation routes through
    // egress.systemTemplate (loopback chokepoint). Default is the
    // singleton from lib/egress.js; tests can inject a stub.
    egress = defaultEgress,
  } = deps;

  if (typeof agentId !== 'string')                    throw new TypeError('createRecovery: agentId required');
  if (typeof logPrefix !== 'string')                  throw new TypeError('createRecovery: logPrefix required');
  if (!paths?.root || !paths?.repo)                   throw new TypeError('createRecovery: paths.{root,repo} required');
  if (!continuationConfig?.timeout || !continuationConfig?.rateLimit) {
    throw new TypeError('createRecovery: continuationConfig.{timeout,rateLimit} required');
  }
  if (typeof maxContinuations !== 'number')           throw new TypeError('createRecovery: maxContinuations required');
  if (typeof resolveBotHttpUrl !== 'function')        throw new TypeError('createRecovery: resolveBotHttpUrl required');
  if (typeof addActivity !== 'function')              throw new TypeError('createRecovery: addActivity required');
  if (typeof hasActiveTasks !== 'function')           throw new TypeError('createRecovery: hasActiveTasks required');
  if (typeof incrementActiveTask !== 'function')      throw new TypeError('createRecovery: incrementActiveTask required');
  if (typeof decrementActiveTask !== 'function')      throw new TypeError('createRecovery: decrementActiveTask required');
  if (!runtimeState?.runtime || !runtimeState?.activeTaskCount) {
    throw new TypeError('createRecovery: runtimeState.{runtime,activeTaskCount} required');
  }
  if (typeof runClaudeCode !== 'function')            throw new TypeError('createRecovery: runClaudeCode required');
  if (typeof getModelForTask !== 'function')          throw new TypeError('createRecovery: getModelForTask required');
  if (typeof classifyError !== 'function')            throw new TypeError('createRecovery: classifyError required');
  if (!ErrorReason)                                   throw new TypeError('createRecovery: ErrorReason required');
  if (typeof sleep !== 'function')                    throw new TypeError('createRecovery: sleep required');
  if (typeof loadSystemPrompt !== 'function')         throw new TypeError('createRecovery: loadSystemPrompt required');
  if (typeof isSilentReply !== 'function')            throw new TypeError('createRecovery: isSilentReply required');
  if (typeof trunc !== 'function')                    throw new TypeError('createRecovery: trunc required');
  for (const k of ['readAllCheckpoints','clearCheckpoint','archiveCheckpoint','getCheckpointSummary','cleanupArchivedCheckpoints']) {
    if (typeof checkpointStore?.[k] !== 'function') throw new TypeError(`createRecovery: checkpointStore.${k} required`);
  }

  // Operator notifier — sends short, trusted system messages on lifecycle
  // events. Tests can inject a fake; production wires it from the same
  // bot URL deps so the routing matches notifyContinuation's existing
  // precedent (Discord channel → Telegram operator DM → WhatsApp).
  // Phase 1: pass the same `egress` override so the notifier and
  // notifyContinuation share a single mock in tests.
  const operatorNotifier = notifierOverride || createOperatorNotifier({
    agentId, logPrefix,
    discordChannel, discordBotUrl,
    telegramBotUrl, whatsappBotUrl,
    egress,
  });
  for (const k of ['getSessionMessages','cleanupOldSessions']) {
    if (typeof sessionStore?.[k] !== 'function') throw new TypeError(`createRecovery: sessionStore.${k} required`);
  }
  for (const k of ['writeContinuation','readReadyContinuations','readAllContinuations','updateContinuation','clearContinuation','cleanupOldContinuations']) {
    if (typeof continuationStore?.[k] !== 'function') throw new TypeError(`createRecovery: continuationStore.${k} required`);
  }
  if (typeof fetchImpl !== 'function')                throw new TypeError('createRecovery: fetch required');

  // Closure-private state — per-channel notification cooldowns.
  // Without this, every inbound message in a group chat that hits
  // the rate-limit window triggers another "rate limited" reply.
  const _continuationNotifyCooldowns = new Map(); // key -> expiresAt ms

  // ── checkpoint recovery ────────────────────────────────────────

  function buildRecoveryPrompt(checkpoint, sessionMessages) {
    const originalPrompt = sessionMessages.find(m => m.role === 'user')?.content || checkpoint.promptSummary;
    return `You are resuming an interrupted task.

## What Happened
You were working on a ${checkpoint.taskType} task when you were interrupted (server restart/crash).
The task started at ${new Date(checkpoint.startedAt).toLocaleString()}.

## Original Request
${originalPrompt}

## Instructions
1. Review what was requested above
2. Check git status and recent file changes to see what you may have completed
3. Continue from where you left off - do NOT repeat completed work
4. If the task appears complete, respond with NO_REPLY

If you're unsure what was done, check:
- git status (for uncommitted changes)
- git log --oneline -5 (for recent commits)
- File timestamps in the working directory`;
  }

  async function recoverFromCheckpoint() {
    const checkpoints = await checkpointStore.readAllCheckpoints(paths.root);

    if (checkpoints.length === 0) {
      console.log(`[${logPrefix}] No checkpoints found - clean start`);
    } else {
      console.log(`[${logPrefix}] Found ${checkpoints.length} checkpoint(s) to process`);
      for (const checkpoint of checkpoints) {
        await processCheckpoint(checkpoint);
      }
    }

    await checkpointStore.cleanupArchivedCheckpoints(paths.root);
    await sessionStore.cleanupOldSessions(paths.root);

    // Recover continuations: any 'running' → reset to 'pending'
    try {
      const continuations = await continuationStore.readAllContinuations(paths.root);
      let resetCount = 0;
      for (const cont of continuations) {
        if (cont.state === 'running') {
          await continuationStore.updateContinuation(paths.root, cont.id, { state: 'pending' });
          resetCount++;
        }
      }
      if (continuations.length > 0) {
        const pending = continuations.filter(c => c.state === 'pending').length + resetCount;
        console.log(`[${logPrefix}] Continuations: ${continuations.length} total, ${pending} pending (${resetCount} reset from running)`);
      }
      await continuationStore.cleanupOldContinuations(paths.root, continuationConfig.maxAge);
    } catch (e) {
      console.error(`[${logPrefix}] Continuation recovery error:`, e.message);
    }
  }

  async function processCheckpoint(checkpoint) {
    console.log(`[${logPrefix}] Processing checkpoint: ${checkpointStore.getCheckpointSummary(checkpoint)}`);
    addActivity('status', `Found interrupted task: ${checkpoint.taskType}`, {
      type: 'recovery',
      checkpointId: checkpoint.id,
      state: checkpoint.state,
      sessionId: checkpoint.sessionId,
    });

    if (checkpoint.state === 'completed') {
      await checkpointStore.clearCheckpoint(paths.root, checkpoint.sessionId);
      console.log(`[${logPrefix}] Cleared stale completed checkpoint (session: ${checkpoint.sessionId})`);
      return;
    }

    if (checkpoint.state === 'running') {
      const age = Date.now() - new Date(checkpoint.startedAt).getTime();
      console.log(`[${logPrefix}] Task was interrupted: ${checkpoint.taskType} (age: ${Math.round(age/1000)}s)`);

      await checkpointStore.archiveCheckpoint(paths.root, {
        ...checkpoint,
        state: 'interrupted',
        completedAt: new Date().toISOString(),
        recoveredAt: new Date().toISOString(),
      });

      if (age > maxResumeAgeMs) {
        console.log(`[${logPrefix}] Task too old to resume (${Math.round(age/60000)}m > ${maxResumeAgeMs/60000}m)`);
        if (checkpoint.deliveryContext?.channelId) {
          await notifyRecovery(checkpoint, false);
        }
        await checkpointStore.clearCheckpoint(paths.root, checkpoint.sessionId);
        return;
      }

      if (checkpoint.sessionId) {
        await resumeSession(checkpoint);
      } else {
        console.log(`[${logPrefix}] No sessionId in checkpoint, cannot resume`);
        if (checkpoint.deliveryContext?.channelId) {
          await notifyRecovery(checkpoint, false);
        }
      }

      await checkpointStore.clearCheckpoint(paths.root, checkpoint.sessionId);
      console.log(`[${logPrefix}] Checkpoint cleared after recovery (session: ${checkpoint.sessionId})`);
    }

    if (checkpoint.state === 'failed') {
      await checkpointStore.archiveCheckpoint(paths.root, checkpoint);
      await checkpointStore.clearCheckpoint(paths.root, checkpoint.sessionId);
      console.log(`[${logPrefix}] Archived and cleared failed checkpoint (session: ${checkpoint.sessionId})`);
    }
  }

  async function resumeSession(checkpoint) {
    console.log(`[${logPrefix}] Attempting to resume session: ${checkpoint.sessionId}`);
    addActivity('action', `Resuming interrupted ${checkpoint.taskType} task`, {
      type: 'session-resume',
      sessionId: checkpoint.sessionId,
    });

    if (checkpoint.deliveryContext?.channelId) {
      await notifyRecovery(checkpoint, true);
    }

    // Phase 2 of EGRESS-PROVENANCE: register the active turn for the resumed
    // task so the future `reply` MCP tool can default-target replies. Recovery
    // does NOT re-enter /chat, so we have to wire the registry here directly.
    // checkpoint.deliveryContext is the only context recovery preserves; if it's
    // missing the resumed run can't deliver via the registry (reply tool will
    // refuse cleanly with `no-active-turn`). Step 1: registry populated, no
    // consumer yet — zero behavior change.
    let inboundRegistered = false;
    if (checkpoint.deliveryContext?.channelId) {
      try {
        const dctx = checkpoint.deliveryContext;
        // deliveryContext today carries `{ channel:'discord', channelId, messageId, username }`
        // (chat.js:783 hardcodes `channel:'discord'` — pre-existing quirk). For
        // recovered runs we have less info than at /chat entry; populate
        // best-effort and let the reply tool's source check decide whether to deliver.
        setActiveTurn({
          source: dctx.source || 'unknown',
          channelKind: dctx.channelKind || 'unknown',
          channelId: dctx.channelId,
          channel: dctx.channel,
          username: dctx.username,
          voiceMode: !!dctx.voiceMode,
          taskId: `recovery-resume:${checkpoint.sessionId}`,
        });
        inboundRegistered = true;
      } catch (e) {
        console.warn(`[${logPrefix}] setActiveTurn (recovery) failed (non-fatal): ${e.message}`);
      }
    }

    try {
      const sessionMessages = await sessionStore.getSessionMessages(paths.root, checkpoint.sessionId);
      if (sessionMessages.length === 0) {
        console.log(`[${logPrefix}] No session messages found, cannot resume`);
        return;
      }

      const recoveryPrompt = buildRecoveryPrompt(checkpoint, sessionMessages);

      let systemPrompt = '';
      try {
        systemPrompt = await loadSystemPrompt();
      } catch (e) {
        console.log(`[${logPrefix}] Could not load system prompt for recovery:`, e.message);
      }

      const fullPrompt = `${systemPrompt}

## Session Recovery

${recoveryPrompt}`;

      incrementActiveTask();

      const { result: output } = await runClaudeCode(fullPrompt, {
        model: getModelForTask(runtimeState.runtime(), checkpoint.taskType),
        cwd: paths.repo,
        taskType: checkpoint.taskType,
        agentRoot: paths.root,
        agentId,
        sessionId: checkpoint.sessionId,
        resumeSessionId: checkpoint.resumeSessionId || null,
        isResume: true,
        deliveryContext: checkpoint.deliveryContext,
      });

      decrementActiveTask();

      console.log(`[${logPrefix}] Session resumed successfully: ${trunc(output, 0, 100)}...`);
      addActivity('output', `Session resumed: ${trunc(output, 0, 200)}${(output || '').length > 200 ? '...' : ''}`, {
        type: 'session-resume-complete',
        sessionId: checkpoint.sessionId,
      });

      // Operator notification — short, trusted, says "this happened".
      // The agent's actual user-facing reply (if any) was delivered by
      // the agent's own explicit curl during the resumed run; recovery
      // does NOT forward the agent's transcript to user channels.
      // (Old `sendRecoveryResult` used to wrap and forward `output`,
      // which let scratchpad-shaped text leak into chat — see
      // explicit-send architecture decision.)
      await operatorNotifier.notifyRecoveryComplete({
        taskType: checkpoint.taskType,
        sessionId: checkpoint.sessionId,
        deliveryContext: checkpoint.deliveryContext,
      });
    } catch (error) {
      decrementActiveTask();
      console.error(`[${logPrefix}] Session resume failed:`, error.message);
      addActivity('error', `Session resume failed: ${error.message}`, {
        type: 'session-resume-error',
        sessionId: checkpoint.sessionId,
      });
    } finally {
      // Phase 2: clear the active-turn registry. Idempotent — safe even
      // if setActiveTurn was skipped (no deliveryContext) or threw above.
      if (inboundRegistered) clearActiveTurn();
    }
  }

  async function notifyRecovery(checkpoint, isResuming = false) {
    // Discord variant uses bold; Telegram + WhatsApp strip the markdown
    // (text-only platforms). Phase 1: route through egress.systemTemplate.
    const messageMd = isResuming
      ? `🔄 Resuming interrupted **${checkpoint.taskType}** task...\n` +
        `Task: "${checkpoint.promptSummary?.slice(0, 100)}..."`
      : `⚠️ I was interrupted while working on a **${checkpoint.taskType}** task.\n` +
        `Started: ${new Date(checkpoint.startedAt).toLocaleString()}\n` +
        `Task: "${checkpoint.promptSummary?.slice(0, 150)}..."`;
    const messagePlain = messageMd.replace(/\*\*/g, '');
    const templateId = isResuming ? 'recovery-checkpoint-resuming' : 'recovery-checkpoint-interrupted';

    try {
      if (discordChannel) {
        const r = await egress.systemTemplate({
          templateId, platform: 'discord',
          channelId: checkpoint.deliveryContext?.channelId || discordChannel,
          content: messageMd,
        });
        if (r.delivered) console.log(`[${logPrefix}] Sent recovery notification to Discord`);
        else console.error(`[${logPrefix}] Recovery notification failed (${r.httpStatus || r.errorCode})`);
      } else if (telegramBotUrl && process.env.OWNER_TELEGRAM_ID) {
        // ⚠ A.25: chatId required.
        await egress.systemTemplate({
          templateId, platform: 'telegram',
          channelId: process.env.OWNER_TELEGRAM_ID, content: messagePlain,
        });
        console.log(`[${logPrefix}] Sent recovery notification to Telegram`);
      } else if (whatsappBotUrl) {
        await egress.systemTemplate({
          templateId, platform: 'whatsapp', channelId: '', content: messagePlain,
        });
        console.log(`[${logPrefix}] Sent recovery notification to WhatsApp`);
      }
      addActivity('output', isResuming ? 'Notified: resuming task' : 'Notified: task interrupted', { type: 'recovery-notify' });
    } catch (e) {
      console.error(`[${logPrefix}] Failed to send recovery notification:`, e.message);
    }
  }

  // ── continuation engine ────────────────────────────────────────

  function formatDuration(ms) {
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
    const hours = Math.floor(ms / 3600000);
    const mins = Math.round((ms % 3600000) / 60000);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  function estimateRateLimitWait(error) {
    const msg = (error.message || '') + (error.stderr || '');

    const retryAfterMatch = msg.match(/retry.after[:\s]+(\d+)/i);
    if (retryAfterMatch) {
      const ms = parseInt(retryAfterMatch[1], 10) * 1000;
      return Math.min(ms, continuationConfig.rateLimit.maxWaitMs);
    }

    const tryAgainMatch = msg.match(/try again in (\d+)\s*(second|minute|hour)/i);
    if (tryAgainMatch) {
      const value = parseInt(tryAgainMatch[1], 10);
      const unit = tryAgainMatch[2].toLowerCase();
      let ms;
      if (unit.startsWith('second'))      ms = value * 1000;
      else if (unit.startsWith('minute')) ms = value * 60 * 1000;
      else                                ms = value * 60 * 60 * 1000;
      return Math.min(ms, continuationConfig.rateLimit.maxWaitMs);
    }

    return continuationConfig.rateLimit.defaultWaitMs;
  }

  function buildContinuationPrompt(attempt) {
    return `You were interrupted by a timeout. This is continuation attempt ${attempt}. ` +
      `Please review where you left off (check git status, recent file changes) and continue your work. ` +
      `Do NOT restart from scratch — pick up from where you stopped.`;
  }

  function buildMaxTurnsContinuationPrompt(attempt, maxAttempts) {
    return `You hit the turn limit for this session (continuation ${attempt}/${maxAttempts}). ` +
      `Review your progress so far and continue with the remaining work. ` +
      `If you have accomplished the core task, provide a final summary. ` +
      `If not, continue from where you left off. Do NOT restart from scratch.`;
  }

  function _continuationCooldownKey(type, deliveryContext) {
    const channelKey = deliveryContext?.channelId
      || deliveryContext?.channel
      || 'default';
    return `${type}:${channelKey}`;
  }

  // Phase 1 of EGRESS-PROVENANCE-PLAN-2026-05-06: continuation messages
  // route through the loopback chokepoint via egress.systemTemplate. Tag
  // each call with a templateId so the audit log distinguishes recovery
  // events by type.
  const TEMPLATE_BY_TYPE = {
    timeout:     'recovery-timeout',
    rate_limit:  'recovery-rate-limit',
    max_turns:   'recovery-max-turns',
    resuming:    'recovery-resuming',
    failed:      'recovery-failed',
  };

  async function notifyContinuation({ type, attempt, maxAttempts, waitMs, resumeAfter, message: customMessage, deliveryContext }) {
    let message = customMessage;

    if (!message) {
      if (type === 'timeout') {
        message = `⏱ Task timed out (60 min limit). Continuing automatically... (attempt ${attempt}/${maxAttempts})`;
      } else if (type === 'rate_limit') {
        const waitStr = formatDuration(waitMs);
        const etaStr = new Date(resumeAfter).toLocaleTimeString();
        message = `⚠️ Rate limited by AI provider. Task will resume automatically in ~${waitStr} (around ${etaStr}).`;
      } else if (type === 'max_turns') {
        message = `🔄 Hit turn limit — continuing automatically (${attempt}/${maxAttempts})`;
      } else if (type === 'resuming') {
        message = `🔄 Resuming task... (attempt ${attempt}/${maxAttempts})`;
      } else if (type === 'failed') {
        message = `❌ Task failed after ${attempt} attempts. ${customMessage || ''}`;
      }
    }

    if (!message) return;

    // Dedupe per-channel for rate_limit and timeout — the user only needs
    // to hear about it once per outage window. Other types (resuming, failed,
    // max_turns) are one-shot per task and don't need suppression.
    //
    // Note: this cooldown layer is per-(type,channel) over a 5-min window.
    // The chokepoint adds envelope-dedup over a 30-second window keyed by
    // content+channel hash. Different windows, different keys, no overlap —
    // both retained as defense in depth (cooldown stops type-spam; dedup
    // stops accidental double-fires within a single batch).
    if (type === 'rate_limit' || type === 'timeout') {
      const key = _continuationCooldownKey(type, deliveryContext);
      const now = Date.now();
      const expiresAt = _continuationNotifyCooldowns.get(key);
      if (expiresAt && now < expiresAt) {
        console.log(`[${logPrefix}] Suppressing ${type} notification for ${key} (cooldown active for ${Math.round((expiresAt - now) / 1000)}s more)`);
        return;
      }
      const cooldownMs = resumeAfter
        ? Math.max(60_000, Math.min(new Date(resumeAfter).getTime() - now, 6 * 3600 * 1000))
        : 5 * 60 * 1000;
      _continuationNotifyCooldowns.set(key, now + cooldownMs);
    }

    const templateId = TEMPLATE_BY_TYPE[type] || 'recovery-other';

    try {
      const channelId = deliveryContext?.channelId || discordChannel;
      if (channelId && discordBotUrl) {
        await egress.systemTemplate({
          templateId, platform: 'discord', channelId, content: message,
        });
      } else if (telegramBotUrl && process.env.OWNER_TELEGRAM_ID) {
        // ⚠ A.25: chatId required (server no longer falls back).
        // Recovery notifications target the operator — pass OWNER_TELEGRAM_ID
        // explicitly. If unset, skip rather than misroute.
        await egress.systemTemplate({
          templateId, platform: 'telegram', channelId: process.env.OWNER_TELEGRAM_ID, content: message,
        });
      } else if (whatsappBotUrl) {
        await egress.systemTemplate({
          templateId, platform: 'whatsapp', channelId: '', content: message,
        });
      }
    } catch (e) {
      console.error(`[${logPrefix}] Failed to send continuation notification:`, e.message);
    }
  }

  async function runWithContinuation({ prompt, runOptions, deliveryContext, maxContinuations: maxCont }) {
    const maxTimeoutAttempts = continuationConfig.timeout.enabled
      ? (maxCont || continuationConfig.timeout.maxAttempts) : 0;
    const maxRateLimitAttempts = continuationConfig.rateLimit.enabled
      ? continuationConfig.rateLimit.maxAttempts : 0;
    const maxTurnsContinuations = maxCont || maxContinuations;

    let continuationAttempt = 0;
    let maxTurnsContinuationAttempt = 0;
    let currentSessionId = runOptions.resumeSessionId || null;
    let currentPrompt = prompt;

    while (true) {
      try {
        const { result, sessionId, hitMaxTurns } = await runClaudeCode(currentPrompt, {
          ...runOptions,
          resumeSessionId: currentSessionId,
          skipDedup: continuationAttempt > 0 || maxTurnsContinuationAttempt > 0,
          isResume: continuationAttempt > 0 || maxTurnsContinuationAttempt > 0 || runOptions.isResume,
        });

        if (hitMaxTurns && sessionId && maxTurnsContinuationAttempt < maxTurnsContinuations) {
          maxTurnsContinuationAttempt++;
          currentSessionId = sessionId;
          currentPrompt = buildMaxTurnsContinuationPrompt(maxTurnsContinuationAttempt, maxTurnsContinuations);

          console.log(`[${logPrefix}] Max turns hit — continuing (${maxTurnsContinuationAttempt}/${maxTurnsContinuations}, session: ${sessionId.slice(0, 8)})`);
          addActivity('action', `Hit turn limit — continuing (${maxTurnsContinuationAttempt}/${maxTurnsContinuations})`, { type: 'continuation-max-turns' });

          await notifyContinuation({
            type: 'max_turns',
            attempt: maxTurnsContinuationAttempt,
            maxAttempts: maxTurnsContinuations,
            deliveryContext,
          });

          continue;
        }

        return { result, sessionId };
      } catch (error) {
        const reason = error.errorReason || classifyError(error);
        const failedSessionId = error.claudeSessionId || currentSessionId;

        // Timeout: immediate continuation with --resume
        if ((reason === ErrorReason.TIMEOUT || error.isTimeout) && failedSessionId && continuationAttempt < maxTimeoutAttempts) {
          continuationAttempt++;
          currentSessionId = failedSessionId;
          currentPrompt = buildContinuationPrompt(continuationAttempt);

          console.log(`[${logPrefix}] Timeout continuation attempt ${continuationAttempt}/${maxTimeoutAttempts} (session: ${failedSessionId.slice(0, 8)})`);
          addActivity('action', `Timeout — continuing (attempt ${continuationAttempt}/${maxTimeoutAttempts})`, { type: 'continuation-timeout' });

          await notifyContinuation({
            type: 'timeout',
            attempt: continuationAttempt,
            maxAttempts: maxTimeoutAttempts,
            deliveryContext,
          });

          continue;
        }

        // Empty output or context overflow: retry with fresh session —
        // BUT only when nothing useful has been delivered yet. With
        // explicit-send architecture (CLAUDE.md §11), exiting with no
        // `result` event is the EXPECTED success shape when the agent
        // delivered to the inbound channel via /telegram/send instead
        // of the stdout stream — the classifier can't tell that apart
        // from a stuck/dead run.
        //
        // Two cases:
        //   1) Explicit sends went to the INBOUND channel → user has
        //      a reply. Retrying would re-send (the Apr 2026 triple-
        //      reply bug). Skip retry, return synthetic success.
        //   2) Sends went only OFF-channel (e.g. agent forwarded to
        //      another contact's DM during delegation) → inbound user
        //      is still waiting. Retry IS appropriate; the chat
        //      handler's natural-text fallback needs fresh `result`
        //      content to deliver.
        if ((reason === 'EMPTY_OUTPUT' || reason === ErrorReason.EMPTY_OUTPUT || error.emptyOutput || reason === ErrorReason.CONTEXT_OVERFLOW) && continuationAttempt < 2) {
          const inboundChannelId = deliveryContext?.channelId || null;
          const inboundSends = (typeof getExplicitSendCount === 'function' && inboundChannelId)
            ? getExplicitSendCount(inboundChannelId)
            : 0;
          if (inboundSends > 0) {
            console.log(`[${logPrefix}] ${reason} — but ${inboundSends} explicit send(s) to inbound (${inboundChannelId}); treating as success, no retry`);
            addActivity('action', `${reason} — inbound already replied (${inboundSends} explicit send(s)), no retry`, { type: 'continuation-skip-retry-inbound-delivered' });
            // Synthetic success — chat handler sees empty result +
            // the explicit-send tally and skips the natural-text
            // fallback for that channel, so no double delivery.
            return { result: '', sessionId: failedSessionId };
          }

          continuationAttempt++;
          currentSessionId = null;
          currentPrompt = prompt;

          console.log(`[${logPrefix}] ${reason} — retrying with fresh session (attempt ${continuationAttempt})`);
          addActivity('action', `${reason} — retrying with fresh session (attempt ${continuationAttempt})`, { type: 'continuation-empty-output' });

          await sleep(1000);
          continue;
        }

        // Rate limit: deferred continuation
        if (reason === ErrorReason.RATE_LIMIT && continuationAttempt < maxRateLimitAttempts) {
          const waitMs = estimateRateLimitWait(error);
          const resumeAfter = new Date(Date.now() + waitMs);

          console.log(`[${logPrefix}] Rate limited — scheduling continuation in ${formatDuration(waitMs)} (resume after ${resumeAfter.toISOString()})`);
          addActivity('action', `Rate limited — continuation scheduled for ${resumeAfter.toISOString()}`, { type: 'continuation-rate-limit' });

          await continuationStore.writeContinuation(paths.root, {
            agentId,
            type: 'rate_limit',
            state: 'pending',
            resumeAfter: resumeAfter.toISOString(),
            claudeSessionId: failedSessionId,
            taskType: runOptions.taskType,
            model: runOptions.model,
            maxTurns: runOptions.maxTurns || 30,
            cwd: runOptions.cwd,
            prompt: prompt.slice(0, 500),
            promptFull: prompt,
            deliveryContext,
            attempt: continuationAttempt + 1,
            maxAttempts: maxRateLimitAttempts,
            originalError: error.message,
          });

          await notifyContinuation({
            type: 'rate_limit',
            waitMs,
            resumeAfter,
            deliveryContext,
          });

          // Mark error as scheduled so caller can return 202 instead of 500
          error.continuationScheduled = true;
          error.resumeAfter = resumeAfter.toISOString();
          throw error;
        }

        throw error;
      }
    }
  }

  async function scanContinuations() {
    try {
      const ready = await continuationStore.readReadyContinuations(paths.root);
      if (ready.length === 0) return;

      console.log(`[${logPrefix}] Found ${ready.length} continuation(s) ready to resume`);

      for (const cont of ready) {
        if (hasActiveTasks()) {
          console.log(`[${logPrefix}] Skipping continuation ${cont.id.slice(0, 8)} — agent busy (${runtimeState.activeTaskCount()} active)`);
          continue;
        }
        await executeContinuation(cont);
      }

      await continuationStore.cleanupOldContinuations(paths.root, continuationConfig.maxAge);
    } catch (e) {
      console.error(`[${logPrefix}] Continuation scan error:`, e.message);
    }
  }

  async function executeContinuation(cont) {
    console.log(`[${logPrefix}] Executing continuation ${cont.id.slice(0, 8)} (${cont.type}, attempt ${cont.attempt}/${cont.maxAttempts})`);
    addActivity('action', `Resuming ${cont.type} task (attempt ${cont.attempt})`, { type: 'continuation-resume', id: cont.id });

    await continuationStore.updateContinuation(paths.root, cont.id, { state: 'running' });

    await notifyContinuation({
      type: 'resuming',
      attempt: cont.attempt,
      maxAttempts: cont.maxAttempts,
      deliveryContext: cont.deliveryContext,
    });

    incrementActiveTask();

    try {
      const prompt = cont.claudeSessionId
        ? buildContinuationPrompt(cont.attempt)
        : cont.promptFull;

      const { result: output } = await runClaudeCode(prompt, {
        model: cont.model || runtimeState.runtime()?.model,
        maxTurns: cont.maxTurns || 30,
        cwd: cont.cwd || paths.repo,
        taskType: cont.taskType,
        agentRoot: paths.root,
        agentId,
        resumeSessionId: cont.claudeSessionId,
        isResume: !!cont.claudeSessionId,
        skipDedup: true,
        deliveryContext: cont.deliveryContext,
      });

      decrementActiveTask();
      await continuationStore.clearContinuation(paths.root, cont.id);

      // Operator notification — same discipline as resumeSession above.
      // Agent's user-facing content (if any) was delivered via explicit
      // curl during the continuation run.
      await operatorNotifier.notifyRecoveryComplete({
        taskType: cont.taskType,
        sessionId: cont.claudeSessionId || null,
        deliveryContext: cont.deliveryContext,
      });

      addActivity('output', `Continuation completed: ${trunc(output, 0, 200)}${(output || '').length > 200 ? '...' : ''}`, { type: 'continuation-complete' });
      console.log(`[${logPrefix}] Continuation ${cont.id.slice(0, 8)} completed successfully`);
    } catch (error) {
      decrementActiveTask();
      const reason = error.errorReason || classifyError(error);

      if (reason === ErrorReason.RATE_LIMIT && cont.attempt < cont.maxAttempts) {
        const waitMs = estimateRateLimitWait(error);
        const resumeAfter = new Date(Date.now() + waitMs);

        await continuationStore.updateContinuation(paths.root, cont.id, {
          state: 'pending',
          attempt: cont.attempt + 1,
          resumeAfter: resumeAfter.toISOString(),
          claudeSessionId: error.claudeSessionId || cont.claudeSessionId,
          history: [...(cont.history || []), { attempt: cont.attempt, error: 'rate_limit', at: new Date().toISOString() }],
        });

        await notifyContinuation({ type: 'rate_limit', waitMs, resumeAfter, deliveryContext: cont.deliveryContext });
      } else if ((reason === ErrorReason.TIMEOUT || error.isTimeout) && cont.attempt < cont.maxAttempts) {
        await continuationStore.updateContinuation(paths.root, cont.id, {
          state: 'pending',
          attempt: cont.attempt + 1,
          resumeAfter: new Date().toISOString(),
          claudeSessionId: error.claudeSessionId || cont.claudeSessionId,
          history: [...(cont.history || []), { attempt: cont.attempt, error: 'timeout', at: new Date().toISOString() }],
        });
      } else {
        await continuationStore.updateContinuation(paths.root, cont.id, { state: 'failed', error: error.message });

        await notifyContinuation({
          type: 'failed',
          attempt: cont.attempt,
          maxAttempts: cont.maxAttempts,
          message: `❌ Task failed after ${cont.attempt} attempt(s): ${error.message.slice(0, 200)}`,
          deliveryContext: cont.deliveryContext,
        });

        console.error(`[${logPrefix}] Continuation ${cont.id.slice(0, 8)} failed permanently: ${error.message}`);
      }
    }
  }

  return {
    // checkpoint recovery
    buildRecoveryPrompt,
    recoverFromCheckpoint,
    processCheckpoint,
    resumeSession,
    notifyRecovery,
    // operator-facing recovery completion notification (replaces
    // the old sendRecoveryResult — exposed for tests + observability).
    notifyRecoveryComplete: operatorNotifier.notifyRecoveryComplete,
    // continuation engine
    formatDuration,
    estimateRateLimitWait,
    buildContinuationPrompt,
    buildMaxTurnsContinuationPrompt,
    notifyContinuation,
    runWithContinuation,
    scanContinuations,
    executeContinuation,
    // exposed for tests
    _continuationCooldownKey,
    _continuationNotifyCooldowns,
  };
}
