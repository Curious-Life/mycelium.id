/**
 * Chat domain router (Phase 10 PR 4).
 *
 * Owns the 9 chat-surface endpoints:
 *   POST /chat                                     — Discord/Telegram/agent-to-agent, queued
 *   POST /chat/stream, /portal/chat/stream         — SSE streaming for portal
 *   POST /think                                    — autonomous wake cycle
 *   POST /research                                 — 3-phase research pipeline
 *   GET  /queue, POST /queue/clear, POST /cancel   — lane management
 *   GET  /continuations                            — diagnostic listing
 *
 * Dependency injection:
 *   The factory takes a flat `deps` object. agent-server.js constructs every
 *   service/helper at module scope and hands them in. That keeps the router
 *   pure and testable, while letting the heavier infrastructure (continuation
 *   runtime, Discord/Telegram helpers) stay at module scope where other
 *   endpoints (WebSocket chat, /discord/send, /collab/send, etc.) also need it.
 *
 * Stage 1 (this commit) wires the 5 simple handlers: /queue, /queue/clear,
 * /cancel, /continuations, /research. /think, /chat, /chat/stream follow in
 * subsequent stages within this PR.
 */

import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

import { getTimeout } from '@mycelium/core/timeouts.js';
import { redactId } from '@mycelium/core/log-redact.js';
import { enqueue, getLaneInfo, clearLane, cancelActive, drainMatching } from '@mycelium/core/lanes.js';
import { readAllContinuations } from '@mycelium/core/continuation.js';
import { assembleContext } from '@mycelium/core/context-assembly.js';
import { getModelForTask } from '@mycelium/core/runtime.js';
import {
  loadSessionMetadata,
  updateSessionMapping,
  getSessionForThread,
  getContextSummary,
  clearSessionMapping,
} from '@mycelium/core/session-store.js';
import { log as eventLog } from '@mycelium/core/events.js';
import { getAgentConfig, getAgentNames } from '@mycelium/core/agent-config.js';
import { isSilentReply, parseTriage, assertDeliverable } from '@mycelium/core/tokens.js';
import { SOURCES, isValidSource, buildDiscordSource } from '@mycelium/core/message-sources.js';
import { formatChannelList, createPromptBuilders, buildTriagePrompt } from '../chat/prompt-builders.js';
import { loadSpaceContext, buildSpaceSystemPrompt } from '../chat/space-chat.js';
import { setSseHeaders, createSseWriter } from '../chat/stream-events.js';
import { composePrompt } from '../chat/compose.js';
import * as S from '../chat/prompt-sections.js';
import { spawnEnvOverride } from '@mycelium/core/claude-config.js';
import { recordEgress } from '../lib/egress-audit.js';
import { setActiveTurn, clearActiveTurn } from '../lib/inbound-context.js';

/**
 * Map a chat-handler `source` value to a channel-registry-style `channelKind`.
 * Used by the active-turn registry (Phase 2 of EGRESS-PROVENANCE). Best-effort
 * mapping; refined over time as the channel registry's KNOWN_KINDS evolves.
 *
 * Telegram is the trickiest: source='telegram' may be a DM or a group depending
 * on the chatId sign — disambiguate via the chatId prefix (groups start with '-').
 */
function deriveChannelKind(source, channelId, inboundChatId) {
  if (source === 'discord') return 'discord-channel';
  if (source === 'telegram-group') return 'telegram-group';
  if (source === 'telegram') {
    const id = String(inboundChatId || channelId || '');
    return id.startsWith('-') ? 'telegram-group' : 'telegram-dm';
  }
  if (source === 'whatsapp') return 'whatsapp-jid';
  if (source === 'portal') return 'portal-session';
  return source || 'unknown';
}

/**
 * @typedef {object} CreateChatRouterDeps
 * @property {object} runtimeState
 * @property {() => object|null} tryGetDb
 * @property {(type: string, msg: string, meta?: object) => void} addActivity
 * @property {object} paths
 * @property {object} config                       — { AGENT_ID, LOG_PREFIX, MAX_TURNS, PORT, ... }
 * @property {(req: any, res: any) => boolean}     requireWorkerSecret
 * @property {(req: any) => Promise<object|null>}  authenticatePortalRequest
 * @property {(req: any, res: any, key: string, max?: number) => boolean} checkRateLimit
 * @property {(err: any, fallback?: string) => string} safeError
 */

/**
 * Build the chat router. Called from createApp(deps).
 *
 * @param {CreateChatRouterDeps} deps
 * @returns {import('express').Router}
 */
export function createChatRouter(deps) {
  if (!deps) throw new TypeError('createChatRouter: deps required');
  const {
    runtimeState,
    tryGetDb,
    addActivity,
    paths,
    config,
    requireWorkerSecret,
    safeError,
    // Helpers that live at module scope in agent-server.js (used by other
    // endpoints too — WebSocket chat, /discord/send, /collab/send). Injected
    // so the router stays pure and testable.
    loadSystemPrompt,
    getWakeCycles,
    formatWakeCycleDocs,
    getWarRoomContext,
    getIntelContext,
    hasActiveTasks,
    incrementActiveTask,
    decrementActiveTask,
    trunc,
    runWithContinuation,
    // /chat additional deps (stage 3)
    loadState,
    saveState,
    resetCountersIfNeeded,
    getDiscordChannels,
    getAgentDisplayNameForUser,
    getAgentPersonality,
    getAgentDisplayName,
    buildTeamDirectory,
    // formatChannelList, getFileSendingInstructions, getCollabInstructions now live in this file (PR 4b)
    scanAgentFilesForDocuments,
    // PR 4.5: end-of-turn artifact notification primitives.
    // notifyArtifactsCreated — system-authored channel message
    //   summarising files the agent published during the turn.
    // takeArtifacts — atomic read-and-clear of the per-task buffer
    //   keyed by `taskId` (channelId-based for chat turns).
    // Both optional — chat falls back to fire-and-forget scan when
    // missing (e.g. tests that don't exercise notification path).
    notifyArtifactsCreated,
    // Phase 3 of EGRESS-PROVENANCE (May 2026): operator-diagnostic for
    // missed-explicit-send. Replaces deliverNaturalReplyFallback
    // auto-delivery (deleted) — when the agent produces text but doesn't
    // call reply/curl, fire a privacy-safe notification to the operator
    // instead of leaking scratchpad to the user. Optional dep — tests that
    // don't exercise the diagnostic path may pass null/undefined.
    notifyFallbackSkipped,
    takeArtifacts,
    addTask,
    storeMessages,
    // ⚠ Persistence contract — the split helpers persist user + assistant
    // independently so an inbound survives even when the agent's reply is
    // suppressed (explicit-sends, NO_REPLY triage, partial delivery). All
    // three are hard-asserted below: a missing dep crashes router boot
    // instead of silently routing /chat into the void (closes A.22).
    // See docs/architecture/MESSAGE-PERSISTENCE.md.
    storeUserMessage,
    storeAssistantMessage,
    storeSyntheticMessage,
    resetExplicitSends,
    getExplicitSendCount,
    // Stage 4: /chat/stream deps
    checkRateLimit,
    authenticatePortalRequest,
    refreshOpenAIToken,
    streamOpenAICodex,
    streamOpenAIChat,
    // Channel Authority Registry — feeds the "Authorised Channels"
    // section into every prompt so the agent always knows which channels
    // it may target by name (and the curl pattern), regardless of which
    // surface the inbound came from. Optional: pre-registry tests don't
    // construct the registry; rendering quietly omits the section when
    // unwired.
    getChannelRegistry,
    log,
  } = deps;

  if (!runtimeState)                                 throw new TypeError('createChatRouter: runtimeState required');
  if (typeof tryGetDb !== 'function')                throw new TypeError('createChatRouter: tryGetDb required');
  if (typeof addActivity !== 'function')             throw new TypeError('createChatRouter: addActivity required');
  if (!paths?.root)                                  throw new TypeError('createChatRouter: paths required');
  if (!config?.AGENT_ID)                             throw new TypeError('createChatRouter: config.AGENT_ID required');
  if (typeof requireWorkerSecret !== 'function')     throw new TypeError('createChatRouter: requireWorkerSecret required');
  if (typeof safeError !== 'function')               throw new TypeError('createChatRouter: safeError required');
  // Persistence contract — fail loud, never silently skip. Closes A.22.
  if (typeof storeMessages !== 'function')           throw new TypeError('createChatRouter: storeMessages required');
  if (typeof storeUserMessage !== 'function')        throw new TypeError('createChatRouter: storeUserMessage required');
  if (typeof storeAssistantMessage !== 'function')   throw new TypeError('createChatRouter: storeAssistantMessage required');
  if (typeof storeSyntheticMessage !== 'function')   throw new TypeError('createChatRouter: storeSyntheticMessage required');

  const { AGENT_ID, LOG_PREFIX, PORT, CLAUDE_BIN, AGENT_REGISTRY } = config;
  const logger = log || console;
  const logPrefix = LOG_PREFIX || AGENT_ID;

  // Prompt-builder helpers (file-sending + collab instructions) extracted
  // to chat/prompt-builders.js in PR 14B.1. Factory-injected because the
  // templates close over PORT + AGENT_ID.
  const { buildFileSendingInstructions, buildCollabInstructions } = createPromptBuilders({
    port: PORT,
    agentId: AGENT_ID,
    getAgentNames,
  });
  // Maintain the old names as aliases so the rest of the file can stay
  // unchanged (minimizes diff surface — each caller is a one-liner that
  // doesn't benefit from renaming).
  const getFileSendingInstructions = buildFileSendingInstructions;
  const getCollabInstructions = buildCollabInstructions;

  // Lazy getters for env URLs — these const bindings live late in
  // agent-server.js but the values are just process.env reads with
  // fallbacks, so we mirror the logic inline.
  const telegramBotUrl = () => process.env.TELEGRAM_BOT_URL || 'http://localhost:3003';
  const whatsappBotUrl = () => process.env.WHATSAPP_BOT_URL;
  const discordChannel = () => process.env.DISCORD_CHANNEL || process.env.DISCORD_COMPANY_CHANNEL;

  // deliverNaturalReplyFallback DELETED in Phase 3 of EGRESS-PROVENANCE
  // (commit 2026-05-07). The function used to auto-deliver result.response
  // to the inbound channel when the agent skipped explicit-send — the
  // monologue-leak class. Replaced with notifyFallbackSkipped (operator-
  // diagnostic, see ~line 1175). User no longer receives leaked scratchpad;
  // operator gets a privacy-safe summary of the missed-send event.
  // See docs/EGRESS-PROVENANCE-PHASE3-DESIGN-2026-05-07.md.

  /**
   * Render the Channel Authority block for the prompt: the registry's
   * "Authorised Channels" listing (label + id + members + autonomous
   * flag) PLUS the canonical curl pattern using `targetName` so the
   * agent has a working command to copy. Loopback (127.0.0.1) is
   * trusted by requireWorkerSecret so no auth header is needed.
   *
   * Returned as a single markdown string (or '' when no registry).
   */
  function buildChannelAuthorityPrompt() {
    const reg = typeof getChannelRegistry === 'function' ? getChannelRegistry() : null;
    if (!reg) return '';
    const listing = reg.listForPrompt({ max: 30, memberCap: 10 });
    return `${listing}

When asked to send to a channel **other than the one you're replying in**,
use \`targetName\` (the bracketed label above). The server resolves the
name to an id and validates against the registry — unknown names return
404, fabricated chat ids return 403.

Telegram (group or DM):
\`\`\`bash
curl -X POST http://localhost:${PORT}/telegram/send -H "Content-Type: application/json" \\
  -d '{"targetName":"<Label from list above>","text":"Your message here"}'
\`\`\`

Discord:
\`\`\`bash
curl -X POST http://localhost:${PORT}/discord/send -H "Content-Type: application/json" \\
  -d '{"targetName":"<#channel-name>","content":"Your message here"}'
\`\`\`

If unsure which channel the user means, **ASK** — never iterate ids,
never guess. Multiple channels with similar names → server returns 409
with candidates; ask the user which one.`;
  }

  const router = Router();

  // ── Source + metadata helpers ─────────────────────────────────────
  //
  // A /chat call arrives from a bot (Telegram/Discord/WhatsApp), the
  // portal proxy, or an inter-agent collab. Every transport sets req.body
  // differently. resolveChatSource normalises that into one of the
  // canonical SOURCES values. buildChatMetadata captures the rest of the
  // provenance into a MessageMetadata blob (encrypted at rest by the
  // db-d1 layer). See docs/architecture/MESSAGE-PERSISTENCE.md.

  function resolveChatSource(req) {
    const body = req.body || {};
    const raw = body.source;
    // Caller-supplied source wins if valid.
    if (raw && isValidSource(raw)) return raw;
    // If caller said 'discord' but gave a channelId, build the canonical form.
    if (raw === 'discord' && body.channelId) return buildDiscordSource(body.channelId);
    // Bare channel field implies legacy Discord callers — synthesise.
    if (!raw && body.channel) return buildDiscordSource(body.channelId);
    // Fallback: portal. The /chat handler is the universal endpoint and
    // the portal chat-proxy is the most common silent path.
    return SOURCES.PORTAL;
  }

  function buildChatMetadata(req, extras = {}) {
    const body = req.body || {};
    const md = {
      origin: 'natural-reply',
    };
    if (body.channelId)   md.channelId = String(body.channelId);
    if (body.channel)     md.channel = String(body.channel);
    if (body.username)    md.fromName = String(body.username);
    // body.userId here is the agent-server contract: the user the message
    // is "for" — typically the operator's UUID. Platform sender id, when
    // available, lives under fromId so we never lose the original sender
    // when a bot relays on someone's behalf.
    if (body.fromId != null)    md.fromId = body.fromId;
    if (body.messageId != null) md.messageId = body.messageId;
    if (body.spaceId)     md.spaceId = String(body.spaceId);
    if (body.dedupeNonce) md.dedupeNonce = String(body.dedupeNonce);
    if (body.channelId)   md.threadKey = `${resolveChatSource(req)}_${body.channelId}`;
    return Object.assign(md, extras);
  }

  // In-flight dedupe — second layer of defence against retry storms.
  //
  // The lane queue + drainMatching already coalesce retries that arrive
  // BEFORE the primary request starts running. But a retry that arrives
  // AFTER `drainMatching` has already executed on the primary will sit
  // in the queue and run as its own task once the primary completes,
  // producing a duplicate agent call with byte-identical output (same
  // session, same prompt, LLM temperature 0).
  //
  // This map tracks `dedupeNonce` values currently being processed.
  // A second request with the same nonce short-circuits to noReply=true
  // so the bot stays silent. Entries are cleared in a `finally` block
  // below and retained for a short post-completion grace window via
  // runner.js's `wasRecentlyCompleted` (5-min hash log).
  const inFlightDedupeNonces = new Set();

  // ── Lane management: queue, queue/clear, cancel ──────────────────────

  router.get('/queue', (_req, res) => {
    const info = getLaneInfo(`agent:${AGENT_ID}`);
    res.json(info || { processing: false, active: null, queueLength: 0, queued: [] });
  });

  router.post('/queue/clear', (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    const laneId = `agent:${AGENT_ID}`;
    const cleared = clearLane(laneId);
    console.log(`[${logPrefix}] Queue cleared via API: ${cleared} tasks dropped`);
    res.json({ cleared });
  });

  router.post('/cancel', (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    const laneId = `agent:${AGENT_ID}`;
    const cancelled = cancelActive(laneId);
    const cleared = clearLane(laneId);
    console.log(`[${logPrefix}] Cancel via API: active=${cancelled}, queueCleared=${cleared}`);
    res.json({ cancelled, queueCleared: cleared });
  });

  // ── Continuations diagnostic ─────────────────────────────────────────

  router.get('/continuations', async (_req, res) => {
    try {
      const all = await readAllContinuations(paths.root);
      const summary = {
        total: all.length,
        pending: all.filter(c => c.state === 'pending').length,
        running: all.filter(c => c.state === 'running').length,
        completed: all.filter(c => c.state === 'completed').length,
        failed: all.filter(c => c.state === 'failed').length,
      };
      res.json({ summary, continuations: all });
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  // ── Research: 3-phase pipeline (plan → search → synthesize) ──────────

  router.post('/research', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;
    const { query, planModel, searchModel, synthesisModel } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    const { runResearchPipeline } = await import('@mycelium/core/research-pipeline.js');

    addActivity('action', `Research pipeline started: ${query.slice(0, 80)}...`, { type: 'research-start' });

    try {
      const { result, phases } = await runResearchPipeline(query, {
        cwd: paths.repo,
        planModel,
        searchModel,
        synthesisModel,
        onPhase: (phase, detail) => {
          addActivity('status', `Research [${phase}]: ${detail}`, { type: 'research-phase' });
        },
      });

      addActivity('output', `Research complete: ${result?.length || 0} chars`, { type: 'research-complete' });
      res.json({ result, phases });
    } catch (err) {
      console.error(`[${logPrefix}] Research pipeline error:`, err.message);
      res.status(500).json({ error: 'Research pipeline failed' });
    }
  });

  // ── /chat: main chat endpoint (Discord, Telegram, inter-agent, Portal proxy) ──

  router.post('/chat', async (req, res) => {
    // Use socket address (not req.ip — req.ip respects X-Forwarded-For which is
    // spoofable). Direct localhost socket connections skip auth; everything else
    // (including proxied requests via Caddy) requires the worker secret.
    if (!requireWorkerSecret(req, res)) return;

    const MAX_TURNS = config.MAX_TURNS;
    const requestTime = new Date(); // capture arrival time for message timestamps
    const {
      channel, username, userId, history, channelId, messageId,
      taskType: requestedTaskType, sourceAgent,
      priority: taskPriority, context: taskContext, dedupeNonce,
      // Explicit-send architecture: bots pass the actual platform IDs
      // here so the prompt can pre-fill the agent's curl. These supersede
      // the synthetic channelId for telegram (which is a synthetic key
      // like `telegram_12345`, NOT the real chatId).
      inboundChatId,        // real telegram/whatsapp chatId
      inboundMessageId,     // for telegram-group reply-to (preferred over messageId)
      voiceMode,            // true if the inbound was voice → prompt suggests voice:true on the curl
      attachmentId,         // bot-created attachment row to link to the stored user message
    } = req.body;
    // Accept both 'prompt' (Discord bot) and 'message' (Telegram bot, Portal chat-proxy)
    const prompt = req.body.prompt || req.body.message;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }

    // In-flight dedupe: refuse a second request with the same nonce.
    // Bot retries reuse the same `tg:${messageId}` nonce, so this catches
    // the "primary already drained the queue, retry runs as its own task"
    // path that lanes.js coalescing doesn't cover. Release happens in a
    // `finally` further down so every exit path clears the set.
    if (dedupeNonce && inFlightDedupeNonces.has(dedupeNonce)) {
      console.log(`[${logPrefix}] Duplicate in-flight dedupeNonce=${dedupeNonce} — returning suppressed-duplicate`);
      return res.json({
        response: '',
        noReply: true,
        suppressedAsDuplicate: true,
        reason: 'inflight-nonce',
      });
    }

    // Use taskType from request if provided (e.g. 'research' for collab), otherwise default to 'chat'
    const taskType = requestedTaskType || 'chat';

    // Hook emit: `message.inbound`. Fire-and-forget — we never await
    // because a hook subprocess can legitimately take seconds. The
    // hook bus itself is bulletproof (all error paths resolve with
    // ok:false), so no exception can bubble up from here. Payload is
    // the raw message shape; redaction per hook's manifest.reads is
    // applied inside the bus before dispatch. Fields we stage here
    // include identifiers the bus will strip unless explicitly declared.
    runtimeState.hookBus()?.emit('message.inbound', {
      text: prompt,
      role: 'user',
      timestamp: requestTime.toISOString(),
      user_id: userId || process.env.USER_ID || '',
      agent_id: process.env.AGENT_ID || '',
      source: req.body.source || (channel ? `discord_${channelId}` : 'unknown'),
      channel: channel || null,
      channel_id: channelId || null,
      message_id: messageId || null,
      task_type: taskType,
    });

    // Space chat: if spaceId is provided, use Space context instead of personal.
    // Space prompt assembly lives in ../chat/space-chat.js (shared with /chat/stream).
    const spaceId = req.body.spaceId;
    if (spaceId) {
      try {
        const db = tryGetDb();
        const callerId = req.body.userId || process.env.USER_ID;
        if (!db?.spaces) return res.status(503).json({ error: 'Database not available' });

        const ctx = await loadSpaceContext({ db, spaceId });
        if (!ctx) return res.status(404).json({ error: 'Space not found' });
        const { space, knowledge } = ctx;

        const spacePrompt = buildSpaceSystemPrompt({
          space, knowledge, variant: 'chat',
          tail: { username: req.body.username, prompt },
        });

        console.log(`[${logPrefix}] Space chat: ${space.display_name} (${spaceId}), source=${req.body.source || 'unknown'}`);

        // NOTE: `runClaude` is referenced here but was never defined at module
        // scope in agent-server.js — this branch has always thrown at runtime.
        // Preserved as-is during PR 4 extraction; a follow-up PR should either
        // delete this branch or implement the missing helper.
        const claudeResponse = await runClaude(spacePrompt, 'chat', { // eslint-disable-line no-undef
          channelId: req.body.channelId,
          userId: callerId,
          source: req.body.source || 'telegram-group',
        });

        // A.24 fix: write rows with the actual speaker's user_id, with
        // spaceId in metadata. Previous code stored user_id = spaceId,
        // which made these messages invisible to normal user-scoped
        // Timeline queries (`WHERE user_id = ?` against the human's
        // UUID returned nothing). Membership-based readers can still
        // recover space messages via metadata.spaceId + space_access.
        const spaceUserId = callerId;
        if (!spaceUserId) {
          // Fail loud rather than silently storing under spaceId again.
          return res.status(400).json({ error: 'userId required for space chat persistence' });
        }
        const spaceSource = (req.body.source && isValidSource(req.body.source))
          ? req.body.source
          : SOURCES.SPACE;
        const spaceMeta = buildChatMetadata(req, { origin: 'natural-reply', spaceId });
        await storeMessages(
          spaceUserId,           // human's user_id; spaceId lives in metadata
          spaceSource,
          prompt,
          claudeResponse,
          new Date(),
          spaceMeta,
        );

        return res.json({ response: claudeResponse });
      } catch (e) {
        console.error(`[${logPrefix}] Space chat failed:`, e.message);
        return res.status(500).json({ error: 'Space chat failed' });
      }
    }

    // Record human message for autonomous timing
    let state = await loadState();
    state = resetCountersIfNeeded(state);
    state.lastHumanMessageTime = new Date().toISOString();
    await saveState(state);

    // Load system prompt, context, and heartbeat (consciousness state)
    let systemPrompt = '';
    let context = '';
    let heartbeat = '';
    const wakeCycles = await getWakeCycles();
    try {
      systemPrompt = await loadSystemPrompt();
      context = await fs.readFile(paths.knowledge.context, 'utf-8').catch(() => '');
      // Load HEARTBEAT.md from repo - this is the agent's memory of autonomous work
      heartbeat = await fs.readFile(path.join(paths.repo, 'HEARTBEAT.md'), 'utf-8').catch(() => '');
    } catch (e) {
      console.log(`[${logPrefix}] Could not load prompts:`, e.message);
    }

    // Assemble rich context for personal agent (mind files, pinned docs, cross-channel history)
    const memoryScope = process.env.MEMORY_SCOPE || 'company';
    let assembledContext = '';
    try {
      const chatSource = req.body.source || (channel ? 'discord' : '');
      assembledContext = await assembleContext(paths.root, req.body.userId || process.env.USER_ID || '', {
        scope: memoryScope,
        source: chatSource,
        agentId: AGENT_ID,
      });
    } catch (e) {
      console.log(`[${logPrefix}] Context assembly failed (non-fatal):`, e.message);
    }

    // Pre-assembly: fetch data for the prompt sections
    const discordChannels = await getDiscordChannels();
    const chatUserIdLookup = req.body.userId || process.env.USER_ID || '';
    const db = tryGetDb();
    const agentName = await getAgentDisplayNameForUser(AGENT_ID, chatUserIdLookup, db);
    const agentPersonality = await getAgentPersonality(AGENT_ID, chatUserIdLookup, db);
    const teamDirectory = await buildTeamDirectory();

    // Compose the full prompt from pure section builders (see ../chat/prompt-sections.js).
    // Section order mirrors the historical template exactly.
    const fullPrompt = composePrompt([
      S.identitySection({ agentName, agentId: AGENT_ID, personality: agentPersonality }),
      S.systemPromptSection(systemPrompt),
      S.extensionsSection(runtimeState.extensions()),
      S.teamDirectorySection(teamDirectory),
      S.heartbeatSection(heartbeat),
      S.companyContextSection({
        context, assembledContext,
        warRoom: getWarRoomContext(),
        intel: getIntelContext(),
      }),
      S.historySection({ history, agentName }),
      S.currentMessageSection({ username, userId, channel, channelId, messageId, prompt }),
      S.interAgentSection({
        sourceAgent, priority: taskPriority, context: taskContext,
        getDisplayName: getAgentDisplayName,
      }),
      S.fileSendingSection(getFileSendingInstructions(req.body.source || (channel ? 'discord' : ''), channelId, messageId)),
      S.collabSection(getCollabInstructions(channelId)),
      S.channelsSection([formatChannelList(discordChannels), buildChannelAuthorityPrompt()].filter(Boolean).join('\n\n')),
      S.wakeCyclesSection(formatWakeCycleDocs(wakeCycles)),
      S.responseNotesSection({
        variant: 'chat',
        sourceAgent,
        port: PORT,
        inboundSource: req.body.source || (channel ? 'discord' : ''),
        inboundChatId: inboundChatId || null,
        inboundChannelId: channelId || null,
        inboundMessageId: inboundMessageId != null ? inboundMessageId : (messageId != null ? messageId : null),
        voiceMode: !!voiceMode,
      }),
    ]);

    // Privacy: username + channel name are PII (human first names + group
    // titles). Log redacted user/channel ids only. addActivity goes to
    // the operator activity feed, same audience.
    console.log(`[${logPrefix}] Chat from ${redactId(username, 'u-')} in ${redactId(channelId || channel, 'c-')} (${taskType}): ${prompt.length} chars`);
    addActivity('action', `Received message in ${redactId(channelId || channel, 'c-')}`, { type: 'chat-inbound' });
    addActivity('thought', `Processing: ${prompt.length} chars`, { type: 'processing' });

    // Serialize through the lane queue — prevents concurrent /chat calls from racing
    const laneId = `agent:${AGENT_ID}`;
    const abortController = new AbortController();
    const taskMetadata = {
      username: username || 'Unknown', channel: channel || 'unknown', channelId, taskType,
      abortController, coalesceKey: channelId, userMessage: prompt,
    };

    if (dedupeNonce) inFlightDedupeNonces.add(dedupeNonce);

    try {
      const result = await enqueue(laneId, async () => {
        incrementActiveTask();
        try {
          // Phase 2 of EGRESS-PROVENANCE: register the active turn so the
          // future `reply` MCP tool (Phase 2 step 4) can default-target replies
          // to the inbound channel. Lane serialization (laneId='agent:...') guarantees
          // at most one active turn per agent; overwrite-on-entry catches any
          // missed cleanup from a prior turn that crashed pre-finally.
          //
          // Step 1 (this commit): registry populated, no consumer yet — zero
          // behavior change. The reply tool wiring lands in Step 4.
          if (channelId) {
            try {
              const turnSource = req.body.source || (channel ? 'discord' : 'unknown');
              setActiveTurn({
                source: turnSource,
                channelKind: deriveChannelKind(turnSource, channelId, inboundChatId),
                channelId: inboundChatId || channelId,
                channel,
                username,
                userId,
                inboundMessageId,
                voiceMode: !!voiceMode,
                taskId: `chat-turn:${channelId}:${requestTime.getTime()}`,
              });
            } catch (e) {
              console.warn(`[${logPrefix}] setActiveTurn failed (non-fatal): ${e.message}`);
            }
          }

          // Look up existing Claude Code session for this thread/channel
          // Use source prefix (telegram, portal, discord) instead of hardcoding discord_
          const chatSource = req.body.source || (channel ? 'discord' : 'chat');
          const threadKey = channelId ? `${chatSource}_${channelId}` : `chat_${Date.now()}`;
          let existingSessionId = channelId ? await getSessionForThread(paths.root, threadKey) : null;

          // Note: We used to proactively compact at 200k tokens, but this caused more issues than it solved.
          // Claude's native context management handles overflow gracefully with automatic compaction.
          // Manual compaction only happens on actual CONTEXT_OVERFLOW errors (see error handling below).

          // If a previous session was compacted (context overflow), include the summary
          // so the fresh session has continuity. The summary is cleared once a new valid session starts.
          let promptWithContext = fullPrompt;
          if (!existingSessionId && channelId) {
            const contextSummary = await getContextSummary(paths.root, threadKey);
            if (contextSummary) {
              promptWithContext = `${fullPrompt}\n\n---\n# Previous Session Context (compacted)\n${contextSummary}\n---`;
              console.log(`[${logPrefix}] Including compacted context from previous session overflow`);
            }
          }

          // Coalesce queued messages from the same channel into a single prompt
          // This avoids N separate Claude invocations when the user sends rapid messages
          const coalescedEntries = channelId
            ? drainMatching(laneId, m => m.coalesceKey === channelId && m !== taskMetadata)
            : [];

          if (coalescedEntries.length > 0) {
            const extraMessages = coalescedEntries.map(e =>
              `[${e.metadata.username}]: ${e.metadata.userMessage}`
            ).join('\n');
            promptWithContext += `\n\n---\n## Additional messages (sent while you were processing the previous request)\n${extraMessages}\n---`;
            console.log(`[${logPrefix}] Coalesced ${coalescedEntries.length} queued messages from #${channel}`);
          }

          // Select model based on task type (think=opus, chat=sonnet, spawn=haiku)
          const chatModel = getModelForTask(runtimeState.runtime(), taskType);
          runtimeState.recordModelUse(chatModel);
          addActivity('action', `Starting Claude Code execution (model: ${chatModel}, maxTurns: ${MAX_TURNS}${existingSessionId ? ', resuming session' : ', new session'}${coalescedEntries.length > 0 ? `, +${coalescedEntries.length} coalesced` : ''})`, { type: 'claude-start', model: chatModel });

          const chatDeliveryContext = { channel: 'discord', channelId, messageId, username, voiceMode: !!voiceMode };
          let output = '', claudeSessionId;
          resetExplicitSends();
          try {
            ({ result: output, sessionId: claudeSessionId } = await runWithContinuation({
              prompt: promptWithContext,
              runOptions: {
                model: chatModel,
                maxTurns: MAX_TURNS,
                cwd: paths.repo,
                taskType,
                agentRoot: paths.root,
                agentId: AGENT_ID,
                resumeSessionId: existingSessionId,
                deliveryContext: chatDeliveryContext,
                dedupeNonce,
                signal: abortController.signal,
                onActivity: (type, data) => {
                  if (type === 'tool_start') addActivity('action', `Tool: ${data.tool}`, { type: 'tool-start', tool: data.tool });
                  else if (type === 'tool_complete') addActivity('action', `Tool completed: ${data.tool}`, { type: 'tool-complete', tool: data.tool });
                  else if (type === 'thinking_start') addActivity('thought', 'Thinking...', { type: 'thinking' });
                },
              },
              deliveryContext: chatDeliveryContext,
            }));
          } catch (resumeError) {
            // If continuation was scheduled (rate limit), propagate to caller for 202 response
            if (resumeError.continuationScheduled) throw resumeError;

            // If resume failed, retry with a fresh session
            if (existingSessionId && !resumeError.continuationScheduled) {
              // Surface stderr + exitCode + signal so the next Claude CLI failure
              // mode is diagnosable. resumeError.message often falls back to the
              // generic "Claude Code exited with code 1" when stderr is empty
              // (silent_exit class). Mirroring stream-chat's diagnostic shape at
              // chat.js:1928. See docs/MYA-RESUME-FAILURE-DESIGN-2026-05-06.md.
              const _stderr = (resumeError.stderr || '').slice(0, 500);
              console.log(
                `[${logPrefix}] Resume failed: exitCode=${resumeError.exitCode ?? 'n/a'} ` +
                `signal=${resumeError.signal || 'none'} ` +
                `msg="${(resumeError.message || '').slice(0, 200)}" ` +
                `stderr="${_stderr || '(empty)'}". Retrying with new session.`
              );
              await clearSessionMapping(paths.root, threadKey);
              ({ result: output, sessionId: claudeSessionId } = await runWithContinuation({
                prompt: promptWithContext,
                runOptions: {
                  model: chatModel,
                  cwd: paths.repo,
                  taskType,
                  agentRoot: paths.root,
                  agentId: AGENT_ID,
                  resumeSessionId: null,
                  deliveryContext: chatDeliveryContext,
                  dedupeNonce,
                  onActivity: (type, data) => {
                    if (type === 'tool_start') addActivity('action', `Tool: ${data.tool}`, { type: 'tool-start', tool: data.tool });
                    else if (type === 'tool_complete') addActivity('action', `Tool completed: ${data.tool}`, { type: 'tool-complete', tool: data.tool });
                    else if (type === 'thinking_start') addActivity('thought', 'Thinking...', { type: 'thinking' });
                  },
                },
                deliveryContext: chatDeliveryContext,
              }));
            } else {
              throw resumeError;
            }
          }

          // Store Claude Code session ID for future --resume calls
          // Track estimated tokens (~4 chars per token) for context overflow detection
          const estimatedNewTokens = Math.ceil((promptWithContext.length + (output?.length || 0)) / 4);
          if (claudeSessionId && channelId) {
            await updateSessionMapping(paths.root, threadKey, claudeSessionId, {
              channelName: channel || null,
              addTokens: estimatedNewTokens,
            });
          }

          // Detect context overflow: compact the session and retry with a fresh one.
          // Catches: "context overflow", "prompt too long", "prompt is too long", "context limit exceeded", etc.
          const contextOverflowPattern = /context (window |limit )?(ran out|overflow|exceeded|full|limit reached)|ran out of context|out of context|prompt (is )?too (long|large)|token limit/i;
          let compacted = false;
          if (contextOverflowPattern.test(output) && channelId) {
            console.log(`[${logPrefix}] Context overflow detected — compacting session and retrying`);
            addActivity('action', 'Context overflow detected — compacting and retrying with fresh session', { type: 'compaction' });

            const summary = trunc(output, 0, 3000);
            await updateSessionMapping(paths.root, threadKey, null, {
              channelName: channel || null,
              contextSummary: `[Previous session ran out of context — here's your last response for continuity]\n\n${summary}`,
            });

            const contextSummary = await getContextSummary(paths.root, threadKey);
            const compactedPrompt = contextSummary
              ? `${fullPrompt}\n\n---\n# Previous Session Context (compacted)\n${contextSummary}\n---`
              : fullPrompt;

            ({ result: output, sessionId: claudeSessionId } = await runWithContinuation({
              prompt: compactedPrompt,
              runOptions: {
                model: chatModel,
                cwd: paths.repo,
                taskType,
                agentRoot: paths.root,
                agentId: AGENT_ID,
                resumeSessionId: null,
                skipDedup: true,
                deliveryContext: chatDeliveryContext,
              },
              deliveryContext: chatDeliveryContext,
            }));

            if (claudeSessionId && channelId) {
              await updateSessionMapping(paths.root, threadKey, claudeSessionId, {
                channelName: channel || null,
              });
            }

            compacted = true;
            console.log(`[${logPrefix}] Compaction retry succeeded — fresh session started`);
            addActivity('output', 'Compaction retry complete — fresh session active', { type: 'compaction-complete' });
          }

          console.log(`[${logPrefix}] Response: ${trunc(output, 0, 100)}...`);
          addActivity('output', `Claude response (${(output || '').length} chars): ${trunc(output, 0, 200)}${(output || '').length > 200 ? '...' : ''}`, { type: 'claude-response' });

          // Check if agent committed to a task
          const taskMatch = output.match(/^TASK:\s*(.+?)(?:\n|$)/m);
          let taskId = null;

          if (taskMatch) {
            const taskDescription = taskMatch[1].trim();
            console.log(`[${logPrefix}] Agent committed to task: ${taskDescription}`);

            taskId = await addTask({
              type: 'research',
              description: taskDescription,
              requestedBy: username,
              channel: channel,
              context: { originalMessage: prompt, history: history?.slice(-5) },
              priority: 'normal'
            });
          }

          const cleanResponse = output.replace(/^TASK:[^\n]*\n?/m, '').trim();
          let noReply = isSilentReply(cleanResponse);

          // Channel-aware meta-report suppression.
          //
          // Suppress only when the agent already replied to THIS inbound
          // channel during execution. Sends to sibling channels (e.g.
          // delegating to oneself in #agent-collab) MUST NOT suppress
          // the user-facing reply — that was the Apr 2026 Ada incident:
          // agent delegated to herself, the user's #research stayed
          // silent, the substantive natural-text summary was discarded
          // because the global counter saw "any send happened".
          //
          // We log inboundSends + offChannelSends separately so Captain
          // Hook can detect the pattern (off-channel sends with zero
          // inbound replies = potential silent-user incident).
          const inboundChannelId = channelId || null;
          const inboundSends     = inboundChannelId ? getExplicitSendCount(inboundChannelId) : 0;
          const totalSends       = getExplicitSendCount();
          const offChannelSends  = totalSends - inboundSends;
          if (inboundSends > 0 && !noReply && cleanResponse) {
            console.log(`[${logPrefix}] Agent sent ${inboundSends} explicit message(s) to inbound channel — suppressing meta-report (${offChannelSends} off-channel)`);
            addActivity('status', `Suppressed meta-report (${inboundSends} inbound + ${offChannelSends} off-channel sends)`, { type: 'meta-report-suppressed' });
            noReply = true;
          } else if (offChannelSends > 0 && !noReply && cleanResponse) {
            // Agent worked but never replied to the user's channel.
            // Deliver the natural text. This used to be silently
            // dropped under the global counter.
            console.log(`[${logPrefix}] Agent sent ${offChannelSends} off-channel message(s) but 0 to inbound — delivering natural text as reply`);
            addActivity('status', `Delivering natural text (off-channel sends: ${offChannelSends})`, { type: 'meta-report-delivered-off-channel' });
          }

          // Guard: if response is empty and not a deliberate NO_REPLY, log a warning
          // This shouldn't happen after the runner fix, but provides a safety net
          if (!cleanResponse && !noReply) {
            console.warn(`[${logPrefix}] Empty response from Claude Code (not NO_REPLY) — this may indicate a silent failure`);
            addActivity('warning', 'Empty response from Claude Code (not NO_REPLY)', { type: 'empty-response' });
          }

          // Resolve coalesced entries with noReply=true.
          //
          // Each coalesced entry is a separate HTTP /chat call whose payload
          // was folded into THIS primary's prompt (see coalesceKey above).
          // If we hand them the full response, every one of their bot fetches
          // will deliver the same text — producing N duplicate messages in
          // the target channel (this is the "Mya sends 4 identical replies"
          // bug from the retry + queue-coalesce path).
          //
          // The primary fetch (this request's res.json at the bottom of the
          // handler) is the single source of delivery. Coalesced entries
          // stay silent so the user sees exactly one reply covering all
          // queued fragments.
          for (const entry of coalescedEntries) {
            entry.resolve({
              response: '',
              noReply: true,
              coalesced: true,
              suppressedAsDuplicate: true,
              taskCreated: !!taskId,
              taskId,
            });
          }

          return {
            response: noReply ? '' : cleanResponse,
            noReply,
            compacted,
            coalesced: coalescedEntries.length,
            taskCreated: !!taskId,
            taskId
          };
        } finally {
          // Phase 2: clear the active-turn registry. Idempotent — safe even
          // if setActiveTurn was skipped (no channelId) or threw above.
          clearActiveTurn();
          decrementActiveTask();
        }
      }, taskMetadata);

      // Store messages in D1 for cross-channel search.
      //
      // Persistence is split: the user inbound is ALWAYS stored when we
      // have a userId+prompt, regardless of how the agent chose to
      // respond. The agent's natural reply is stored only when it
      // actually emitted text (not NO_REPLY, not suppressed by
      // explicit-send count). This fixes the Apr 2026 cross-channel-leak incident
      // where DMs were misrouted because explicit /telegram/send
      // calls forced noReply=true and the legacy single dual-insert
      // dropped both rows together.
      //
      // Agent-initiated /telegram/send, /discord/send, /whatsapp/send
      // calls persist their own outbound rows (see persistOutboundIfPossible
      // in routes/bots.js), so explicit-send content is preserved on
      // its own track.
      const chatUserId = process.env.USER_ID || req.body.userId;
      const chatSource = resolveChatSource(req);
      const chatMetadata = buildChatMetadata(req);
      if (chatUserId && prompt) {
        // User inbound is ALWAYS stored — same as before. The agent's
        // outbound rows are stored by persistOutboundIfPossible in
        // routes/bots.js when the agent explicitly curls a send route.
        storeUserMessage(
          chatUserId, chatSource, prompt, requestTime, chatMetadata,
          attachmentId ? { attachmentId } : undefined,
        );
      }

      // Scan for agent-written files. Now correlated with the chat turn
      // via a synthetic taskId so PR 4.5's end-of-turn notification can
      // pull artifacts from the per-task buffer and post a system-
      // authored summary to the inbound channel.
      //
      // Fire-and-forget the WHOLE chain: the chat response goes back to
      // the bot immediately, the scanner + notification run in the
      // background. Bot was already updated by the time the user sees
      // the artifact summary line — desired UX (the user gets the
      // agent's reply, then a "📄 I wrote N documents" follow-up).
      const inboundChannel = channelId
        ? { kind: req.body.source || (channel ? 'discord' : 'unknown'), id: channelId }
        : null;
      const turnTaskId = inboundChannel
        ? `chat-turn:${inboundChannel.id}:${requestTime.getTime()}`
        : null;

      scanAgentFilesForDocuments({ taskId: turnTaskId, inboundChannel })
        .then(async (scanResult) => {
          if (!turnTaskId || !scanResult || scanResult.published === 0) return;
          if (typeof takeArtifacts !== 'function') return;
          if (typeof notifyArtifactsCreated !== 'function') return;

          // Drain the buffer atomically — even if a duplicate task
          // somehow runs (it shouldn't, the taskId is timestamp-keyed),
          // it'll see the empty buffer and emit nothing.
          const artifacts = takeArtifacts(turnTaskId);
          if (!artifacts.length) return;

          // Skip the system notification when the agent already replied
          // to THIS inbound channel — natural-text response already
          // mentioned (or should have mentioned) the files. Captain Hook
          // can detect the pattern via artifact.published vs
          // meta-report-suppressed activity events.
          const inboundSendCount = inboundChannel?.id
            ? getExplicitSendCount(inboundChannel.id)
            : 0;
          if (inboundSendCount > 0) {
            console.log(`[${logPrefix}] Artifact notification skipped — agent sent ${inboundSendCount} message(s) to inbound channel`);
            return;
          }

          try {
            // Phase G of CHANNEL-CONTEXT-ISOLATION-DESIGN-2026-05-28: pass the
            // full {kind, id} so the summary routes back via the same platform
            // as the inbound (telegram → /telegram/send, etc.) instead of
            // being forced through the Discord-first operator-notifier path.
            await notifyArtifactsCreated(inboundChannel, artifacts);
          } catch (err) {
            console.error(`[${logPrefix}] notifyArtifactsCreated failed:`, err.message);
          }
        })
        .catch(err => {
          console.error(`[${logPrefix}] Post-chat file scan failed:`, err.message);
        });

      // PR 5.7: system-authored natural-text fallback for inbound channel.
      //
      // Under explicit-send architecture (CLAUDE.md §11), the bot
      // discards `data.response` from /chat — the only path for
      // user-facing replies is the agent calling /telegram/send /
      // /discord/send / /whatsapp/send during its run. When the agent
      // forgets (e.g. produces a final summary like "Noted — flagged
      // your reminder" without an explicit send), the user gets
      // nothing. The chat handler has long *decided* to deliver the
      // natural text in this case (see "delivering natural text as
      // reply" log line above) but the decision was a no-op — the
      // fallback never actually shipped.
      //
      // This block is the structural backstop: when inbound got 0
      // explicit sends AND the agent produced non-empty result text,
      // the chat handler ITSELF dispatches the text via the same
      // egress chokepoint, marked `trusted: true` so it bypasses the
      // explicit-send invariant (system-authored, not agent free-form).
      // Same primitive used by agent-egress.notifyArtifactsCreated and
      // recovery.notifyContinuation — this is just one more
      // system-message kind.
      const inboundChannelId = channelId || null;
      const inboundSendsAfter = inboundChannelId
        ? getExplicitSendCount(inboundChannelId)
        : 0;
      const fallbackText = (!result?.noReply && result?.response) ? String(result.response).trim() : '';
      if (fallbackText && inboundSendsAfter === 0) {
        const inboundSource = (req.body && req.body.source) || (channel ? 'discord' : 'telegram');
        // Phase 3 of EGRESS-PROVENANCE (May 2026): the previous behavior
        // was to auto-deliver fallbackText to the inbound channel — the
        // monologue-leak class. Now we surface the event to the operator
        // and DROP the user-visible delivery. The user gets nothing
        // (instead of a leaked scratchpad); the operator gets a short,
        // privacy-safe summary so the case can be triaged.
        //
        // Skipped for inter-agent (sourceAgent) — collab scratchpad is
        // reasoning trace, not user-bound. Operator doesn't need a ping.
        if (typeof notifyFallbackSkipped === 'function' && !sourceAgent) {
          const inboundChannelKind = deriveChannelKind(
            inboundSource,
            inboundChannelId,
            req.body?.inboundChatId,
          );
          const targetChannelId = req.body?.inboundChatId || inboundChannelId;
          notifyFallbackSkipped({
            inboundChannelKind,
            inboundChannelId: targetChannelId,
            scratchpadBytes: fallbackText.length,
          }).catch((err) => {
            console.warn(`[${logPrefix}] notifyFallbackSkipped failed (non-fatal): ${err.message}`);
          });
        }
      }

      // Explicit-send architecture: the agent's free-form text is
      // scratchpad — never delivered. To reply, the agent curls
      // `/telegram/send`, `/discord/send`, or `/whatsapp/send` during
      // its run; those routes are the only egress chokepoint. They
      // emit `message.outbound` (relocated here from chat.js), persist
      // outbound rows, and gate via assertDeliverable.
      //
      // The HTTP response carries diagnostics only — never the agent's
      // free-form text — so legacy bot consumers cannot accidentally
      // re-deliver scratchpad as a chat message. Bots stopped reading
      // `data.response` as part of the same shift.
      const sanitizedResponse = {
        noReply: true,
        explicitSends: typeof getExplicitSendCount === 'function' ? getExplicitSendCount() : 0,
        status: 'completed',
        taskCreated: !!result?.taskCreated,
        ...(result?.taskId ? { taskId: result.taskId } : {}),
      };

      if (res.writableEnded || res.destroyed) {
        // Connection was severed before we could respond — nothing to
        // proactively deliver. The agent's curls already either succeeded
        // (persisted on their own) or failed (logged + hooked). No
        // free-form fallback under explicit-send.
        console.warn(`[${logPrefix}] Response connection closed before delivery (sanitized response not sent)`);
      } else {
        res.json(sanitizedResponse);
      }
    } catch (error) {
      console.error(`[${logPrefix}] Chat error:`, error.message);
      eventLog.error('chat', error);

      // Rate limit continuation was scheduled — return 202 Accepted with ETA
      if (error.continuationScheduled) {
        return res.status(202).json({
          status: 'continuation_scheduled',
          message: 'Task rate-limited. Will resume automatically.',
          resumeAfter: error.resumeAfter,
        });
      }

      res.status(500).json({ error: safeError(error, 'Chat processing failed') });
    } finally {
      if (dedupeNonce) inFlightDedupeNonces.delete(dedupeNonce);
    }
  });

  // ── /chat/triage: REPLY/NO_REPLY decision before /chat ──
  //
  // The structural fix for monologue leaks in group chats. A bot calls
  // /chat/triage FIRST for unaddressed group messages. Server runs Claude
  // Code with the same agent / same context / same tools as a normal
  // /chat call, but the prompt's terminal section is triageSection — the
  // agent thinks freely, then commits to REPLY or NO_REPLY on the last
  // line. Server reads ONLY that last line; everything else is
  // discarded server-side and never reaches a channel.
  //
  // Bot flow:
  //   group message + not directly addressed:
  //     POST /chat/triage      (no typing indicator yet)
  //       NO_REPLY → silent return, nothing emitted
  //       REPLY    → start typing → POST /chat → deliver
  //   DM, @mention, reply-to, collab-thread continuation:
  //     skip triage, POST /chat directly (existing behavior)
  //
  // Why a separate endpoint rather than a flag on /chat:
  //   - Decoupled session state (triage uses a fresh Claude session;
  //     /chat keeps its own session continuity for the thread)
  //   - Independent timeout (triage capped at 5 min)
  //   - Independent observability (separate hook events, separate logs)
  //   - Bot fallback is trivial (try/catch on 404 → call /chat directly,
  //     for backwards compat during rollout)
  router.post('/chat/triage', async (req, res) => {
    if (!requireWorkerSecret(req, res)) return;

    const requestTime = new Date();
    const { channel, username, userId, history, channelId, messageId, sourceAgent, priority: taskPriority, context: taskContext } = req.body;
    const prompt = req.body.prompt || req.body.message;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }

    // Triage doesn't participate in /chat's dedupe — the bot calls triage
    // first, then /chat with the same nonce if REPLY. The /chat handler
    // owns the in-flight nonce lifecycle for the inbound message.

    // Resolve persistence context BEFORE running Claude — we want a row
    // in the DB even if Claude crashes mid-flight (closes A.23). The row
    // is updated post-decision with triageDecision metadata via
    // db.messages.updateMetadata. Two writes, durable.
    const triageUserId = userId || process.env.USER_ID || '';
    const triageSource = resolveChatSource(req);
    const initialTriageMetadata = buildChatMetadata(req, {
      origin: 'natural-reply',
      // silentTriage starts true; flipped to false if decision === REPLY.
      // This is a reader-friendly guarantee: if you see silentTriage:true
      // in the row, you know the message went through triage and the
      // agent chose not to reply.
      silentTriage: true,
    });

    let triageRowId = null;
    if (triageUserId && prompt) {
      try {
        const persisted = await storeUserMessage(
          triageUserId, triageSource, prompt, requestTime, initialTriageMetadata,
        );
        triageRowId = persisted?.id || null;
      } catch (err) {
        // Helper itself never throws (it catches + emits hook), but
        // belt-and-suspenders — never let a persistence hiccup block
        // the triage decision path.
        console.error(`[${logPrefix}] Triage initial persist failed:`, err.message);
      }
    }

    runtimeState.hookBus()?.emit('message.inbound', {
      text: prompt,
      role: 'user',
      timestamp: requestTime.toISOString(),
      user_id: triageUserId,
      agent_id: process.env.AGENT_ID || '',
      source: triageSource,
      channel: channel || null,
      channel_id: channelId || null,
      message_id: messageId || null,
      task_type: 'triage',
    });

    // Helper to update the persisted row's metadata once the decision
    // is known. Called from every exit path (REPLY, NO_REPLY, error).
    async function _finalizeTriageMetadata(decision, reason) {
      if (!triageRowId) return;
      if (!triageUserId) return; // can't satisfy Worker user_id guard
      try {
        const finalMd = {
          ...initialTriageMetadata,
          triageDecision: decision,
          triageReason: reason,
          silentTriage: decision !== 'REPLY',
        };
        const dbRef = tryGetDb();
        if (dbRef?.messages?.updateMetadata) {
          await dbRef.messages.updateMetadata(triageRowId, triageUserId, finalMd);
        }
      } catch (err) {
        console.error(`[${logPrefix}] Triage metadata update failed:`, err.message);
      }
    }

    try {
      // Triage is a binary REPLY/NO_REPLY decision. It does NOT need the
      // full chat context (file-sending instructions, mindscape state,
      // wake cycles, team directory, extensions, system prompt). The
      // legacy "same context as /chat" approach made the prompt 380KB+
      // for some inbounds (audio transcripts, group history) and timed
      // out at 5 min, dropping persistence with it. See A.30/triage
      // bloat investigation, 2026-04-27.
      const chatUserIdLookup = req.body.userId || process.env.USER_ID || '';
      const db = tryGetDb();
      const agentName = await getAgentDisplayNameForUser(AGENT_ID, chatUserIdLookup, db);
      const agentPersonality = await getAgentPersonality(AGENT_ID, chatUserIdLookup, db);

      const triagePrompt = buildTriagePrompt({
        agentName,
        agentId: AGENT_ID,
        personality: agentPersonality,
        history,
        currentMessage: { username, userId, channel, channelId, messageId, prompt },
      });

      console.log(`[${logPrefix}] Triage from ${redactId(username, 'u-')} in ${redactId(channelId || channel, 'c-')}: ${prompt.length} chars (prompt ${triagePrompt.length} chars)`);
      addActivity('action', `Triage: ${username} in #${channel}`, { type: 'triage-start', username, channel });

      // Triage runs OUTSIDE the lane queue. It's a non-blocking decision
      // call — if /chat is mid-flight for this thread, we still want a
      // fast triage decision rather than queuing behind it. Concurrent
      // Claude subprocesses for the same agent are fine; sessions are
      // per-thread and triage uses a fresh session anyway (no resume).
      const triageModel = getModelForTask(runtimeState.runtime(), 'triage');
      runtimeState.recordModelUse(triageModel);

      // Fail-closed timeout: 90s ceiling. Haiku on a slim prompt
      // typically completes in 1–5s; anything past 90s means the
      // process is wedged. Old 5-min cap was sized for opus + 380KB
      // prompts and produced silent persistence drops on timeout.
      const TRIAGE_TIMEOUT_MS = 90 * 1000;
      const abortController = new AbortController();
      const timeoutHandle = setTimeout(() => {
        console.warn(`[${logPrefix}] Triage timeout (${TRIAGE_TIMEOUT_MS}ms) — fail-closed NO_REPLY`);
        abortController.abort();
      }, TRIAGE_TIMEOUT_MS);

      let output = '';
      try {
        ({ result: output } = await runWithContinuation({
          prompt: triagePrompt,
          runOptions: {
            model: triageModel,
            cwd: paths.repo,
            taskType: 'triage',
            agentRoot: paths.root,
            agentId: AGENT_ID,
            // Fresh session — triage's reasoning must NOT pollute the
            // thread's reply session continuity.
            resumeSessionId: null,
            skipDedup: true,
            signal: abortController.signal,
          },
        }));
      } catch (runError) {
        clearTimeout(timeoutHandle);
        // Any error during triage → fail closed.
        console.warn(`[${logPrefix}] Triage error — fail-closed NO_REPLY: ${runError.message}`);
        addActivity('warning', `Triage failed: ${runError.message}`, { type: 'triage-error' });
        await _finalizeTriageMetadata('NO_REPLY', 'error');
        runtimeState.hookBus()?.emit('message.triage_decided', {
          decision: 'NO_REPLY',
          reason: 'error',
          error: runError.message,
          timestamp: new Date().toISOString(),
          user_id: triageUserId,
          agent_id: process.env.AGENT_ID || '',
          source: triageSource,
          channel: channel || null,
          channel_id: channelId || null,
          message_id: messageId || null,
        });
        return res.json({ decision: 'NO_REPLY', reason: 'error' });
      }
      clearTimeout(timeoutHandle);

      const { triage } = parseTriage(output);

      // Fail closed: anything other than an explicit REPLY → silent.
      // Logged for observability so we can spot drift if the model
      // stops emitting clean markers.
      const decision = triage === 'REPLY' ? 'REPLY' : 'NO_REPLY';
      const parseReason = triage === null ? 'malformed-marker' : (triage === 'REPLY' ? 'agent-decided-reply' : 'agent-decided-silent');

      console.log(`[${logPrefix}] Triage decision: ${decision} (${parseReason}, ${output.length} chars output)`);
      addActivity('output', `Triage decision: ${decision} (${parseReason})`, { type: 'triage-decision', decision });

      await _finalizeTriageMetadata(decision, parseReason);

      runtimeState.hookBus()?.emit('message.triage_decided', {
        decision,
        reason: parseReason,
        timestamp: new Date().toISOString(),
        user_id: triageUserId,
        agent_id: process.env.AGENT_ID || '',
        source: triageSource,
        channel: channel || null,
        channel_id: channelId || null,
        message_id: messageId || null,
      });

      return res.json({ decision, reason: parseReason });
    } catch (error) {
      console.error(`[${logPrefix}] Triage error (outer):`, error.message);
      eventLog.error('triage', error);
      // Outer error: also fail closed. Best-effort metadata finalize.
      await _finalizeTriageMetadata('NO_REPLY', 'outer-error');
      return res.json({ decision: 'NO_REPLY', reason: 'outer-error', error: safeError(error, 'Triage failed') });
    }
  });

  // ── /chat/stream + /portal/chat/stream: SSE streaming for portal ──
  //
  // SSE event shape is a production contract. The portal depends on:
  //   stream_start, keepalive, thinking_start, thinking_delta, thinking_end,
  //   tool_start, tool_complete, text_delta, usage, done, error
  // Every event writes JSON in the form `data: {...}\n\n`. Do not change
  // field names or shapes without coordinating with the portal.

  router.post(['/chat/stream', '/portal/chat/stream'], async (req, res) => {
    if (typeof checkRateLimit !== 'function')          throw new TypeError('createChatRouter: checkRateLimit required for /chat/stream');
    if (typeof authenticatePortalRequest !== 'function') throw new TypeError('createChatRouter: authenticatePortalRequest required for /chat/stream');

    const MAX_TURNS = config.MAX_TURNS;

    if (!checkRateLimit(req, res, 'chat-stream', 20)) return;
    // Auth: portal cookie for /portal/chat/stream, worker secret for /chat/stream
    const isPortalRoute = req.path.startsWith('/portal/');
    if (isPortalRoute) {
      const user = await authenticatePortalRequest(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized' });
      if (!req.body.userId) req.body.userId = user.id;
      // authenticatePortalRequest returns camelCase `displayName` (per
      // packages/core/auth/passkey.js:validateSession). The previous
      // snake_case lookup silently returned undefined and fell through
      // to user.id, causing the chat UI to label user messages with
      // the raw UUID instead of the operator's name. Accept both for
      // belt-and-braces against future shape drift.
      if (!req.body.username) req.body.username = user.displayName || user.display_name || user.id;
      if (!req.body.source) req.body.source = 'portal';
    } else {
      if (!requireWorkerSecret(req, res)) return;
    }

    // Space chat: if spaceId is provided, swap system prompt for space context.
    // Prompt assembly lives in ../chat/space-chat.js (shared with /chat).
    const spaceId = req.body.spaceId;
    if (spaceId) {
      try {
        const db = tryGetDb();
        const user = isPortalRoute ? await authenticatePortalRequest(req) : null;
        const callerId = req.body.userId || user?.id;
        if (!callerId) { return res.status(401).json({ error: 'Unauthorized' }); }

        // Access control
        const role = await db.spaces.getRole(spaceId, callerId);
        if (!role) { return res.status(403).json({ error: 'Not a member of this space' }); }

        const ctx = await loadSpaceContext({ db, spaceId });
        if (!ctx) { return res.status(404).json({ error: 'Space not found' }); }
        const { space, knowledge } = ctx;

        // Get or create conversation
        const conv = await db.spaceConversations.getOrCreate(spaceId, callerId);

        const spaceSystemPrompt = buildSpaceSystemPrompt({
          space, knowledge, variant: 'chat-stream',
        });

        // Override the request to use space context (read downstream)
        req.body._spaceSystemPrompt = spaceSystemPrompt;
        req.body._spaceId = spaceId;
        req.body._spaceConversationId = conv.id;
        req.body._spaceName = space.name;
        // A.24 fix: thread the resolved caller (the human) to the writer
        // so the row's user_id is the speaker, not the space.
        req.body.userId = callerId;

        // Update activity
        await db.spaceConversations.incrementCount(spaceId, callerId);
        await db.spaceAccess.updateLastActive(spaceId, callerId);
      } catch (e) {
        console.error(`[${logPrefix}] Space context failed:`, e.message);
        if (!res.headersSent) return res.status(500).json({ error: 'Space context assembly failed' });
      }
    }

    // Proxy to a different agent if requested (portal agent-switching)
    const targetAgentId = req.body.agentId;
    if (targetAgentId && targetAgentId !== AGENT_ID && AGENT_REGISTRY?.[targetAgentId]) {
      const target = AGENT_REGISTRY[targetAgentId];
      try {
        const proxyRes = await fetch(`http://localhost:${target.port}/chat/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(300_000),
        });
        setSseHeaders(res);
        res.status(proxyRes.status);
        // Pipe SSE stream from target agent back to portal
        const reader = proxyRes.body?.getReader();
        if (!reader) return res.end();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        req.on('close', () => reader.cancel());
        await pump();
      } catch (err) {
        if (!res.headersSent) {
          res.status(502).json({ error: safeError(err, 'Could not reach agent') });
        }
      }
      return;
    }

    const requestTime = new Date(); // capture arrival time for message timestamps
    const { channel, username, userId, channelId, attachmentContext } = req.body;
    const rawPrompt = req.body.prompt || req.body.message;
    if (!rawPrompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }
    // If portal sent attachment context (processed file descriptions), prepend to prompt
    const prompt = attachmentContext ? `${attachmentContext}\n\n${rawPrompt}` : rawPrompt;
    const taskType = req.body.taskType || 'chat';

    // Hook emit: `message.inbound` — fires before SSE setup so hooks see every
    // stream request regardless of which provider (OpenAI or Claude) serves it.
    // Fire-and-forget; payload shape matches /chat for a stable hook contract.
    // message_id is null because stream requests don't carry one.
    runtimeState.hookBus()?.emit('message.inbound', {
      text: prompt,
      role: 'user',
      timestamp: requestTime.toISOString(),
      user_id: userId || process.env.USER_ID || '',
      agent_id: process.env.AGENT_ID || '',
      source: req.body.source || 'portal',
      channel: channel || null,
      channel_id: channelId || null,
      message_id: null,
      task_type: taskType,
    });

    // SSE setup — headers + writer live in ../chat/stream-events.js
    setSseHeaders(res);
    const sse = createSseWriter(res);
    const sendSSE = sse.send;

    sendSSE({ type: 'stream_start', streamIndex: 0 });

    // Build prompt (same as /chat)
    let systemPrompt = '';
    let context = '';
    let heartbeat = '';
    let wakeCycles = [];

    if (req.body._spaceSystemPrompt) {
      console.log(`[${logPrefix}] Space chat: ${req.body._spaceName} (${req.body._spaceId}), spaceCtx=${req.body._spaceSystemPrompt.length} chars`);
    }
    try {
      systemPrompt = await loadSystemPrompt();
      wakeCycles = await getWakeCycles();
      context = await fs.readFile(paths.knowledge.context, 'utf-8').catch(() => '');
      heartbeat = await fs.readFile(path.join(paths.repo, 'HEARTBEAT.md'), 'utf-8').catch(() => '');
    } catch (e) {
      console.log(`[${logPrefix}] Could not load prompts:`, e.message);
    }

    const memoryScope = process.env.MEMORY_SCOPE || 'company';
    let assembledContext = '';
    try {
      const chatSource = req.body.source || (channel ? 'discord' : '');
      assembledContext = await assembleContext(paths.root, req.body.userId || process.env.USER_ID || '', {
        scope: memoryScope,
        source: chatSource,
        agentId: AGENT_ID,
      });
    } catch (e) {
      console.log(`[${logPrefix}] Context assembly failed (non-fatal):`, e.message);
    }

    const discordChannels = await getDiscordChannels();
    const teamDirectory = await buildTeamDirectory();

    // /chat/stream prompt: like /chat but no identity preamble, no history,
    // no inter-agent section, short response-notes variant. Space context is
    // inserted when /chat/stream's spaceId branch populated req.body._space*.
    const fullPrompt = composePrompt([
      S.systemPromptSection(systemPrompt),
      S.extensionsSection(runtimeState.extensions()),
      S.teamDirectorySection(teamDirectory),
      S.heartbeatSection(heartbeat),
      S.companyContextSection({
        context, assembledContext,
        warRoom: getWarRoomContext(),
        intel: getIntelContext(),
      }),
      S.spaceContextSection({
        name: req.body._spaceName,
        systemPrompt: req.body._spaceSystemPrompt,
      }),
      S.currentMessageSection({
        username, userId,
        channel: channel || 'portal',
        channelId, prompt,
      }),
      S.fileSendingSection(getFileSendingInstructions(req.body.source || 'portal', channelId)),
      S.collabSection(getCollabInstructions()),
      S.channelsSection([formatChannelList(discordChannels), buildChannelAuthorityPrompt()].filter(Boolean).join('\n\n')),
      S.wakeCyclesSection(formatWakeCycleDocs(wakeCycles)),
      S.responseNotesSection({ variant: 'chat-stream' }),
    ]);

    console.log(`[${logPrefix}] Stream chat from ${username || 'portal'}: ${prompt.length} chars`);
    console.log(`[${logPrefix}] Context budget: system=${systemPrompt.length}, context=${context.length}, heartbeat=${heartbeat.length}, assembled=${assembledContext.length}, teamDir=${teamDirectory.length}, prompt=${prompt.length}, total=${fullPrompt.length}`);
    addActivity('action', `Streaming chat from ${username || 'portal'}`, { type: 'stream-chat' });

    // ── Provider routing: check if user has an active OpenAI provider ──
    if (isPortalRoute) {
      const db = tryGetDb();
      if (db?.providers) {
        try {
          const openaiProvider = await db.providers.getActive(req.body.userId, 'openai');
          if (openaiProvider?.credentials && openaiProvider.status === 'active') {
            let creds;
            try {
              const { decrypt } = await import('@mycelium/core/crypto-local.js');
              creds = JSON.parse(decrypt(openaiProvider.credentials));
            } catch {
              try { creds = JSON.parse(openaiProvider.credentials); } catch { creds = null; }
            }

            if (creds) {
              // Refresh token if expiring within 5 minutes
              if (creds.expiresAt && creds.expiresAt < Date.now() + 5 * 60 * 1000 && creds.refreshToken) {
                try { creds = await refreshOpenAIToken(db, openaiProvider, req.body.userId, creds); } catch (e) {
                  console.error(`[${logPrefix}] OpenAI token refresh failed, falling back to Claude:`, e.message);
                  creds = null;
                }
              }
            }

            if (creds?.accessToken || creds?.api_key) {
              console.log(`[${logPrefix}] Routing chat to OpenAI (${openaiProvider.auth_type})`);
              try {
                let fullContent;
                if (openaiProvider.auth_type === 'oauth') {
                  fullContent = await streamOpenAICodex(res, sendSSE, creds, fullPrompt, prompt, openaiProvider.model_preference);
                } else {
                  fullContent = await streamOpenAIChat(res, sendSSE, creds.api_key, openaiProvider.base_url, fullPrompt, prompt, openaiProvider.model_preference);
                }

                // Store assistant response — contract-conformant: metadata
                // captures provider, model, transport. User inbound is
                // persisted by the upstream caller (portal-ws or chat-proxy);
                // this branch only emits the assistant row.
                if (fullContent && req.body.userId) {
                  const streamSource = resolveChatSource(req);
                  const streamMd = buildChatMetadata(req, {
                    origin: 'natural-reply',
                    delivery: 'sent',
                    extra: {
                      provider: 'openai',
                      authType: openaiProvider.auth_type,
                      model: openaiProvider.model_preference,
                    },
                  });
                  await storeAssistantMessage(
                    req.body.userId, streamSource, fullContent, new Date(), streamMd,
                  );
                }
                // Update last_used_at
                await db.providers.update(openaiProvider.id, req.body.userId, { last_used_at: new Date().toISOString() });

                // Hook emit: `message.outbound` (OpenAI path). Mirrors the Claude-path
                // emit below so hooks observe replies regardless of which provider
                // served the stream.
                if (fullContent) {
                  runtimeState.hookBus()?.emit('message.outbound', {
                    text: fullContent,
                    role: 'assistant',
                    timestamp: new Date().toISOString(),
                    user_id: req.body.userId || '',
                    agent_id: process.env.AGENT_ID || '',
                    source: req.body.source || 'portal',
                    channel: channel || null,
                    channel_id: channelId || null,
                    message_id: null,
                    task_type: taskType,
                  });
                }

                sendSSE({ type: 'done' });
                res.end();
                return;
              } catch (e) {
                console.error(`[${logPrefix}] OpenAI stream failed:`, e.message);
                if (!res.headersSent) {
                  sendSSE({ type: 'error', message: 'OpenAI request failed — falling back to Claude' });
                }
                // Fall through to Claude CLI
              }
            }
          }
        } catch (e) {
          console.error(`[${logPrefix}] Provider check failed (non-fatal):`, e.message);
        }
      }
    }

    const laneId = `agent:${AGENT_ID}`;

    try {
      await enqueue(laneId, async () => {
        incrementActiveTask();
        try {
          const streamSource = req.body.source || 'portal';
          const threadKey = channelId ? `${streamSource}_${channelId}` : `portal_${userId || Date.now()}`;
          let existingSessionId = channelId || userId
            ? await getSessionForThread(paths.root, threadKey)
            : null;

          // Note: Proactive compaction removed - rely on Claude's native context management.

          let promptWithContext = fullPrompt;
          if (!existingSessionId && (channelId || userId)) {
            const contextSummary = await getContextSummary(paths.root, threadKey);
            if (contextSummary) {
              promptWithContext = `${fullPrompt}\n\n---\n# Previous Session Context (compacted)\n${contextSummary}\n---`;
            }
          }

          return new Promise((resolve, reject) => {
            const args = [
              '--print',
              '--output-format', 'stream-json',
              '--verbose',
              '--include-partial-messages',
              '--model', getModelForTask(runtimeState.runtime(), taskType),
              '--max-turns', String(MAX_TURNS),
            ];

            if (existingSessionId) {
              args.push('--resume', existingSessionId);
            }

            args.push('--dangerously-skip-permissions');
            // NOTE: prompt passed via stdin to avoid E2BIG / MAX_ARG_STRLEN limit

            // Per-agent CLAUDE_CONFIG_DIR resolution — see
            // packages/core/claude-config.js. Cache-empty falls through to
            // process.env (PR 1 behavior); PR 2b populates the cache.
            const claudeSpawnedAt = Date.now();
            const claude = spawn(CLAUDE_BIN, args, {
              cwd: paths.repo,
              env: {
                ...process.env,
                HOME: process.env.HOME || '/home/claude',
                ...spawnEnvOverride(AGENT_ID),
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            });

            // Write prompt to stdin (avoids E2BIG with large prompts >128KB)
            claude.stdin.on('error', (err) => {
              console.error(`[${logPrefix}] Stream stdin error: ${err.message}`);
            });
            claude.stdin.write(promptWithContext);
            claude.stdin.end();
            console.log(`[${logPrefix}] Stream prompt written to stdin: ${promptWithContext.length} chars`);

            let sessionId = null;
            let fullOutput = '';
            let stderrBuffer = '';
            const toolsUsed = [];
            let buffer = '';
            let currentBlockType = null;
            let currentToolName = null;
            let inputTokens = 0;
            let outputTokens = 0;

            // Keepalive to prevent proxy/nginx timeouts
            const keepaliveTimer = setInterval(() => {
              sendSSE({ type: 'keepalive' });
            }, 15000);

            // Timeout
            const timeout = getTimeout('chat');
            const timeoutTimer = setTimeout(() => {
              claude.kill('SIGINT');
              sendSSE({ type: 'error', message: 'Request timed out' });
            }, timeout);

            claude.stdout.on('data', (data) => {
              buffer += data.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const data = JSON.parse(line);

                  // Capture session_id from any event
                  if (data.session_id) sessionId = data.session_id;

                  if (data.type === 'stream_event' && data.event) {
                    const ev = data.event;

                    if (ev.type === 'content_block_start') {
                      if (ev.content_block?.type === 'text') {
                        currentBlockType = 'text';
                      } else if (ev.content_block?.type === 'thinking') {
                        currentBlockType = 'thinking';
                        sendSSE({ type: 'thinking_start' });
                      } else if (ev.content_block?.type === 'tool_use') {
                        currentBlockType = 'tool_use';
                        currentToolName = ev.content_block.name;
                        toolsUsed.push(ev.content_block.name);
                        sendSSE({ type: 'tool_start', name: ev.content_block.name, input: {} });
                      }
                    } else if (ev.type === 'content_block_delta') {
                      if (ev.delta?.type === 'text_delta') {
                        fullOutput += ev.delta.text;
                        sendSSE({ type: 'text_delta', content: ev.delta.text });
                      } else if (ev.delta?.type === 'thinking_delta') {
                        sendSSE({ type: 'thinking_delta', content: ev.delta.thinking });
                      }
                    } else if (ev.type === 'content_block_stop') {
                      if (currentBlockType === 'thinking') {
                        sendSSE({ type: 'thinking_end', signature: '' });
                      } else if (currentBlockType === 'tool_use') {
                        sendSSE({ type: 'tool_complete', name: currentToolName || 'unknown' });
                      }
                      currentBlockType = null;
                      currentToolName = null;
                    } else if (ev.type === 'message_delta') {
                      if (ev.usage) {
                        inputTokens = ev.usage.input_tokens || inputTokens;
                        outputTokens = ev.usage.output_tokens || outputTokens;
                      }
                    }
                  } else if (data.type === 'result') {
                    sessionId = data.session_id || sessionId;
                    if (!fullOutput && data.result) fullOutput = data.result;
                  }
                } catch {}
              }
            });

            claude.stderr.on('data', (data) => {
              const text = data.toString();
              stderrBuffer += text;
              console.error(`[${logPrefix}] Stream stderr: ${text.slice(0, 200)}`);
            });

            claude.on('close', async (code, signal) => {
              const exitedAt = Date.now();
              const durationMs = exitedAt - (claudeSpawnedAt || exitedAt);
              console.log(`[${logPrefix}] Stream Claude exited code=${code} signal=${signal || 'none'} duration_ms=${durationMs} output=${fullOutput.length} chars stderr=${(stderrBuffer || '').length} chars session=${sessionId || 'none'}`);
              clearInterval(keepaliveTimer);
              clearTimeout(timeoutTimer);

              // Diagnostic dump on silent failure. When the CLI exits non-zero
              // with no output AND no stderr, we have nothing to debug from
              // stdout/stderr alone — write the prompt + args + run metadata
              // to /tmp so post-mortem can inspect the exact bytes that
              // caused the failure. Mode 0600, never world-readable. Files
              // accumulate; manual cleanup expected (this is a diagnostic
              // affordance, not a feature).
              //
              // Two files per failure: <ts>-<pid>.json (metadata, head/tail)
              // for fast triage, and <ts>-<pid>.prompt (full bytes) for
              // exact replay. The full-prompt file is what lets us pipe
              // back into claude CLI and reproduce locally.
              const isSilentFailure = code !== 0
                && fullOutput.length === 0
                && (stderrBuffer || '').length === 0;
              let dumpPath = null;
              if (isSilentFailure) {
                try {
                  const dumpDir = '/tmp/mycelium-chat-fail';
                  const fsp = await import('fs/promises');
                  const cryptoMod = await import('crypto');
                  await fsp.mkdir(dumpDir, { recursive: true, mode: 0o700 });
                  dumpPath = `${dumpDir}/${exitedAt}-${process.pid}.json`;
                  const promptPath = `${dumpDir}/${exitedAt}-${process.pid}.prompt`;
                  const meta = {
                    ts: new Date(exitedAt).toISOString(),
                    pid: process.pid,
                    agentId: AGENT_ID,
                    threadKey,
                    code,
                    signal,
                    duration_ms: durationMs,
                    args,
                    promptBytes: promptWithContext.length,
                    promptSha256First8: cryptoMod.createHash('sha256').update(promptWithContext).digest('hex').slice(0, 16),
                    existingSessionIdProvided: !!existingSessionId,
                    cliEmittedSessionId: sessionId || null,
                    promptHead: promptWithContext.slice(0, 4000),
                    promptTail: promptWithContext.slice(-4000),
                    promptFile: promptPath,
                  };
                  await Promise.all([
                    fsp.writeFile(dumpPath, JSON.stringify(meta, null, 2), { mode: 0o600 }),
                    fsp.writeFile(promptPath, promptWithContext, { mode: 0o600 }),
                  ]);
                  console.error(`[${logPrefix}] Stream silent-failure diagnostic dumped: meta=${dumpPath} prompt=${promptPath} (${promptWithContext.length} bytes)`);
                } catch (dumpErr) {
                  console.error(`[${logPrefix}] Diagnostic dump failed: ${dumpErr.message}`);
                }
              }
              if (code !== 0) {
                console.error(`[${logPrefix}] Stream Claude error exit: code=${code} signal=${signal || 'none'} stderr_head="${(stderrBuffer || '').slice(0, 500)}" args=${args.join(' ')}`);
              }

              // Failure classification:
              //   resume_failed — --resume was used AND empty output AND code !== 0.
              //                   Likely stale session_id server-side. Clear mapping
              //                   so next attempt starts fresh.
              //   cli_error     — code !== 0 with stderr or partial output.
              //   silent_exit   — code !== 0 with NO stderr AND no output. Mystery;
              //                   diagnostic dump captures the prompt for post-mortem.
              //   ok            — code === 0 with output.
              let failureCode = 'ok';
              if (code !== 0 && existingSessionId && fullOutput.length === 0) {
                failureCode = 'resume_failed';
              } else if (isSilentFailure) {
                failureCode = 'silent_exit';
              } else if (code !== 0) {
                failureCode = 'cli_error';
              }

              if (failureCode === 'resume_failed') {
                console.warn(`[${logPrefix}] Stream resume failed for thread=${threadKey} sessionId=${existingSessionId} — clearing mapping so next attempt is fresh`);
                await clearSessionMapping(paths.root, threadKey).catch(err => {
                  console.error(`[${logPrefix}] clearSessionMapping failed: ${err.message}`);
                });
              }

              // SSE error: surface a reason code so the UI can show informed
              // copy and the operator (via browser console / network tab) can
              // correlate with logs. dumpPath lets ops jump straight to the
              // captured prompt for silent-exit cases.
              if (code !== 0 && fullOutput.length < 50) {
                const errorMsg = (() => {
                  if (failureCode === 'resume_failed') return 'Session expired — please send your message again.';
                  if (failureCode === 'silent_exit') return 'Claude exited silently. Diagnostic dump captured for review.';
                  return (fullOutput.trim() || (stderrBuffer || '').slice(0, 200) || 'Claude process exited with an error');
                })();
                sendSSE({
                  type: 'error',
                  message: errorMsg,
                  reason: failureCode,
                  exit_code: code,
                  signal: signal || null,
                  duration_ms: durationMs,
                  dump_path: dumpPath,
                });
              }

              // Update session mapping with token estimate. CRITICAL: only
              // persist on success — Claude CLI emits a session_id at init
              // even when it later exits non-zero (no successful turn ever
              // happened on the server side). Persisting that session_id
              // sends every retry into a stale-resume loop because --resume
              // against a never-actually-established session fails. Same
              // guard as storeMessages below: code===0 AND non-empty output.
              if (code === 0 && fullOutput.trim() && sessionId && (channelId || userId)) {
                const estimatedNewTokens = Math.ceil((promptWithContext.length + (fullOutput?.length || 0)) / 4);
                await updateSessionMapping(paths.root, threadKey, sessionId, {
                  channelName: channel || 'portal',
                  addTokens: estimatedNewTokens,
                }).catch(() => {});
              }

              // A.24 fix: store under the human's user_id always; spaceId
              // moves into metadata so Timeline (which filters by user_id)
              // surfaces space messages alongside DM/portal/etc.
              const isSpaceStream = !!req.body._spaceId;
              const chatUserId = req.body.userId || process.env.USER_ID;
              const chatSource = isSpaceStream
                ? SOURCES.SPACE
                : (resolveChatSource(req));
              if (chatUserId && fullOutput.trim() && code === 0) {
                const streamMd = buildChatMetadata(req, {
                  origin: 'natural-reply',
                  delivery: 'sent',
                  extra: { transport: 'stream', provider: 'claude' },
                });
                if (isSpaceStream) streamMd.spaceId = req.body._spaceId;
                // Split into user + assistant so the inbound persists even if
                // the reply later turns out to be empty (matches /chat semantics).
                storeMessages(
                  chatUserId, chatSource, prompt, fullOutput.trim(), requestTime, streamMd,
                ).catch(err => {
                  console.error(`[${logPrefix}] Message storage failed:`, err.message);
                });
              }

              // Hook emit: `message.outbound` (Claude path). Fires once per reply
              // after the stream finishes — NOT per text_delta. Hooks see "a message
              // went by" not a token-level feed. Guarded on successful completion
              // with non-empty output to match the storeMessages guard above.
              //
              // Egress backstop: gate the hook emit through assertDeliverable.
              // The SSE stream itself is portal-facing (owner-only) and already
              // delivered token-by-token; we don't redact it here. But hooks
              // can forward to other surfaces (audit logs, downstream agents),
              // so we drop the emit when the output is monologue/silent.
              const streamOut = fullOutput.trim();
              if (streamOut && code === 0) {
                const streamGate = assertDeliverable(streamOut);
                if (streamGate.deliver) {
                  runtimeState.hookBus()?.emit('message.outbound', {
                    text: streamOut,
                    role: 'assistant',
                    timestamp: new Date().toISOString(),
                    user_id: chatUserId || '',
                    agent_id: process.env.AGENT_ID || '',
                    source: chatSource,
                    channel: channel || null,
                    channel_id: channelId || null,
                    message_id: null,
                    task_type: taskType,
                  });
                } else {
                  console.warn(`[${logPrefix}] /chat/stream message.outbound suppressed by egress gate (${streamGate.reason})`);
                }
              }

              // Scan for agent-written files after think response
              scanAgentFilesForDocuments().catch(err => {
                console.error(`[${logPrefix}] Post-think file scan failed:`, err.message);
              });

              if (inputTokens || outputTokens) {
                sendSSE({ type: 'usage', inputTokens, outputTokens, thinkingTokens: 0 });
              }
              sse.done({ toolsUsed, thinkingEnabled: false });
              res.end();
              resolve({ sessionId });
            });

            claude.on('error', (err) => {
              clearInterval(keepaliveTimer);
              clearTimeout(timeoutTimer);
              sendSSE({ type: 'error', message: err.message });
              res.end();
              reject(err);
            });

            // Client disconnect
            req.on('close', () => {
              clearInterval(keepaliveTimer);
              clearTimeout(timeoutTimer);
              claude.kill('SIGINT');
            });
          });
        } finally {
          decrementActiveTask();
        }
      });
    } catch (err) {
      console.error(`[${logPrefix}] Stream error:`, err.message);
      sendSSE({ type: 'error', message: err.message });
      res.end();
    }
  });

  // ── /think: autonomous wake cycle ───────────────────────────────────

  router.post('/think', async (req, res) => {
    if (typeof hasActiveTasks !== 'function')            throw new TypeError('createChatRouter: hasActiveTasks required for /think');
    if (typeof incrementActiveTask !== 'function')       throw new TypeError('createChatRouter: incrementActiveTask required for /think');
    if (typeof decrementActiveTask !== 'function')       throw new TypeError('createChatRouter: decrementActiveTask required for /think');
    if (typeof loadSystemPrompt !== 'function')          throw new TypeError('createChatRouter: loadSystemPrompt required for /think');
    if (typeof getWakeCycles !== 'function')             throw new TypeError('createChatRouter: getWakeCycles required for /think');
    if (typeof formatWakeCycleDocs !== 'function')       throw new TypeError('createChatRouter: formatWakeCycleDocs required for /think');
    if (typeof getWarRoomContext !== 'function')         throw new TypeError('createChatRouter: getWarRoomContext required for /think');
    if (typeof getIntelContext !== 'function')           throw new TypeError('createChatRouter: getIntelContext required for /think');
    if (typeof runWithContinuation !== 'function')       throw new TypeError('createChatRouter: runWithContinuation required for /think');
    if (typeof trunc !== 'function')                     throw new TypeError('createChatRouter: trunc required for /think');

    if (!requireWorkerSecret(req, res)) return;
    const { prompt, maxTurns: requestedMaxTurns, async: asyncMode } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt required' });
    }

    // Queue-aware heartbeat skip: don't start autonomous work if already processing
    if (hasActiveTasks()) {
      const n = runtimeState.activeTaskCount();
      console.log(`[${logPrefix}] Skipping think - ${n} task(s) in progress`);
      addActivity('status', `Skipped autonomous wake (${n} active tasks)`, { type: 'think-skipped' });
      return res.json({ skipped: true, reason: 'task-in-progress', activeTasks: n });
    }

    // Async mode: respond 202 immediately, process in background.
    // Prevents HTTP timeout for long-running think cycles (Node.js undici
    // drops idle connections after 5 min headersTimeout).
    if (asyncMode) {
      console.log(`[${logPrefix}] Autonomous think request (async)`);
      res.status(202).json({ accepted: true, message: 'Think started (async)' });
      // Fall through — the rest of the handler runs in the background
    } else {
      console.log(`[${logPrefix}] Autonomous think request`);
    }

    eventLog.wakeStart(AGENT_ID, 'think_endpoint');
    addActivity('status', 'Autonomous awakening triggered', { type: 'think-start' });
    addActivity('thought', `Think prompt: ${prompt.length} chars`, { type: 'think' });

    // Hook emit: `message.inbound` for autonomous think cycles. source='autonomous'
    // signals "no external channel." Fires only when we've committed to running
    // (past the task-in-progress skip), so skips are not treated as messages.
    runtimeState.hookBus()?.emit('message.inbound', {
      text: prompt,
      role: 'user',
      timestamp: new Date().toISOString(),
      user_id: process.env.USER_ID || '',
      agent_id: process.env.AGENT_ID || '',
      source: 'autonomous',
      channel: null,
      channel_id: null,
      message_id: null,
      task_type: 'think',
    });

    incrementActiveTask();

    // Load system context using standardized paths
    let systemPrompt = '';
    try {
      systemPrompt = await loadSystemPrompt();
      addActivity('action', 'Loaded system prompt', { type: 'file-read', file: 'system.md' });
    } catch (e) {
      console.log(`[${logPrefix}] Could not load system prompt:`, e.message);
      addActivity('error', `Failed to load system prompt: ${e.message}`, { type: 'file-read' });
    }
    const wakeCycles = await getWakeCycles();

    // Assemble rich context for think cycles (mind files, recent messages)
    const thinkMemoryScope = process.env.MEMORY_SCOPE || 'company';
    let thinkContext = '';
    try {
      thinkContext = await assembleContext(paths.root, process.env.USER_ID || '', {
        scope: thinkMemoryScope,
        source: 'autonomous',
        agentId: AGENT_ID,
        maxRecentMessages: 30,
      });
      // Log context assembly stats for debugging
      const contextLines = thinkContext.split('\n').length;
      const hasMessages = thinkContext.includes('# RECENT MESSAGES') || thinkContext.includes('# MESSAGE SUMMARY');
      const hasModel = thinkContext.includes('# YOUR INTERNAL MODEL');
      const hasVessel = thinkContext.includes('# VESSEL PRACTICE LOG');
      console.log(`[${logPrefix}] Think context assembled: ${contextLines} lines, messages=${hasMessages}, model=${hasModel}, vessel=${hasVessel}, db=${!!tryGetDb()}`);
      addActivity('action', `Context assembled: ${contextLines} lines, messages=${hasMessages}`, { type: 'context-assembly' });
    } catch (e) {
      console.log(`[${logPrefix}] Context assembly failed for think (non-fatal):`, e.message);
      addActivity('error', `Context assembly failed: ${e.message}`, { type: 'context-assembly-error' });
    }

    const DISCORD_CHANNEL = discordChannel();
    const TELEGRAM_BOT_URL = telegramBotUrl();
    const WHATSAPP_BOT_URL = whatsappBotUrl();

    // Note: let (not const) — energy injection below may append to this prompt.
    // thinkContext is pre-assembled context (mind + messages); treated as the
    // "company context" slot here since /think has no separate heartbeat flow.
    let fullPrompt = composePrompt([
      S.systemPromptSection(systemPrompt),
      S.extensionsSection(runtimeState.extensions()),
      S.companyContextSection({
        assembledContext: thinkContext,
        warRoom: getWarRoomContext(),
        intel: getIntelContext(),
      }),
      S.autonomousAwakeningSection(),
      S.autonomousMessagingSection({
        port: PORT,
        agentId: AGENT_ID,
        discordChannel: DISCORD_CHANNEL,
        telegramBotUrl: TELEGRAM_BOT_URL,
        whatsappBotUrl: WHATSAPP_BOT_URL,
        getAgentConfig,
        // A.25: inline OWNER_TELEGRAM_ID so the agent has the chatId
        // literal in its prompt — the server no longer silently falls
        // back when chatId is omitted.
        ownerTelegramId: process.env.OWNER_TELEGRAM_ID || null,
      }),
      S.wakeCyclesSection(formatWakeCycleDocs(wakeCycles)),
      prompt, // the think prompt itself — raw, no section wrapper
    ]);

    try {
      // Use runClaudeCode from lib/runner.js with think timeout and checkpoint persistence
      // Use paths.repo so Claude Code can edit the git repository
      // Think cycles get a fresh session (new perspective each awakening)
      addActivity('action', 'Starting Claude Code for autonomous thinking', { type: 'claude-start', taskType: 'think' });

      // Inject energy state into autonomous prompt.
      // Opt-in: only runs when ENERGY_ENABLED=1 to avoid silent behavior changes.
      if (process.env.ENERGY_ENABLED === '1') {
        try {
          const { getEnergyState, getAgentEnergyState } = await import('@mycelium/core/energy-state.js');
          const agentEnergy = await getAgentEnergyState(AGENT_ID);
          const globalEnergy = await getEnergyState();
          let energyCtx = `\n## Energy State\nYour energy level: **${agentEnergy.level}** (${agentEnergy.pctUsed}% of daily budget used, ${agentEnergy.runsToday} runs today)\n`;
          energyCtx += `System energy: **${globalEnergy.global.level}** (burn rate: ${globalEnergy.global.burnRate} tokens/hour)\n`;
          if (agentEnergy.level === 'low') energyCtx += `**Conservation mode**: Prefer shorter responses, skip non-essential tool calls.\n`;
          if (agentEnergy.level === 'critical') energyCtx += `**CRITICAL**: Minimize token usage. Only essential actions.\n`;
          if (agentEnergy.level === 'abundant') energyCtx += `Energy is abundant. You may explore deeper, spawn sub-tasks, or do proactive research.\n`;
          fullPrompt += energyCtx;
        } catch (err) {
          // Log but do not fail — energy is advisory, not load-bearing.
          console.warn(`[${logPrefix}] Energy injection skipped: ${err.message}`);
        }
      }

      // If triggered by delegation callback, resume the agent's active session
      const trigger = req.body.trigger;
      let resumeSessionId = null;
      if (trigger === 'task-queue' || trigger === 'delegation-callback') {
        const meta = await loadSessionMetadata(paths.root);
        resumeSessionId = meta?.activeSession || null;
      }

      const thinkDeliveryContext = { channel: 'discord', channelId: DISCORD_CHANNEL };
      const thinkModel = getModelForTask(runtimeState.runtime(), 'think');
      runtimeState.recordModelUse(thinkModel);
      const thinkAbortController = new AbortController();
      addActivity('action', `Starting Claude Code for autonomous thinking (model: ${thinkModel})`, { type: 'claude-start', taskType: 'think', model: thinkModel });

      const { result: output, sessionId: claudeSessionId } = await runWithContinuation({
        prompt: fullPrompt,
        runOptions: {
          model: thinkModel,
          maxTurns: requestedMaxTurns || 50,
          cwd: paths.repo,
          taskType: 'think',
          agentRoot: paths.root,
          agentId: AGENT_ID,
          resumeSessionId,
          deliveryContext: thinkDeliveryContext,
          signal: thinkAbortController.signal,
          onActivity: (type, data) => {
            if (type === 'tool_start') addActivity('action', `Tool: ${data.tool}`, { type: 'tool-start', tool: data.tool });
            else if (type === 'tool_complete') addActivity('action', `Tool completed: ${data.tool}`, { type: 'tool-complete', tool: data.tool });
            else if (type === 'thinking_start') addActivity('thought', 'Thinking...', { type: 'thinking' });
          },
        },
        deliveryContext: thinkDeliveryContext,
      });

      // Store as active session if this was a new session
      if (claudeSessionId && !resumeSessionId) {
        await updateSessionMapping(paths.root, 'activeSession', claudeSessionId);
      }

      decrementActiveTask();
      eventLog.wakeComplete(AGENT_ID, output);
      addActivity('output', `Think completed: ${trunc(output, 0, 300)}${(output || '').length > 300 ? '...' : ''}`, { type: 'think-result' });

      // Explicit-send architecture: /think output is scratchpad. The agent
      // sends user-facing messages by curling /telegram/send / /discord/send
      // / /whatsapp/send during the run. Those routes are the egress
      // chokepoint — they emit `message.outbound`, gate via assertDeliverable,
      // persist outbound rows, and validate the channel authority.
      //
      // The HTTP response carries diagnostics only — never the agent's
      // free-form text — so schedulers and recovery callers cannot
      // accidentally re-deliver scratchpad as a chat message.
      const thinkSanitized = {
        noReply: true,
        explicitSends: typeof getExplicitSendCount === 'function' ? getExplicitSendCount() : 0,
        status: 'completed',
      };

      if (!asyncMode) res.json(thinkSanitized);
    } catch (error) {
      decrementActiveTask();
      console.error(`[${logPrefix}] Think error:`, error.message);
      eventLog.wakeError(AGENT_ID, error);
      addActivity('error', error.message, { type: 'think' });

      // Rate limit continuation was scheduled — return 202 Accepted with ETA
      if (!asyncMode && error.continuationScheduled) {
        return res.status(202).json({
          status: 'continuation_scheduled',
          message: 'Task rate-limited. Will resume automatically.',
          resumeAfter: error.resumeAfter,
        });
      }

      if (!asyncMode) res.status(500).json({ error: safeError(error) });
    }
  });

  return router;
}
