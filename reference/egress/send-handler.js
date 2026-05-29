/**
 * Cross-platform send-handler factory (Phase 0a-3).
 *
 * Consolidates the gate sequence shared by every /<platform>/send route.
 * Today's three routes (telegram, discord, whatsapp) collapse to factory
 * registrations; tomorrow's matrix route lands as a fourth registration
 * with two extra gates (room encryption, allowlist) wired through the
 * named hooks below.
 *
 * Why a factory: 96% of every /send route is identical (worker-secret
 * check → kill switch → assertDeliverable → outbound emit → trivial-
 * content gate → fail-closed routing → channel authority → envelope
 * dedup → trackExplicitSend → addActivity → apicall → persist + emit
 * delivered). The 4% that varies is shaped consistently as named hooks.
 * The structural guarantee — that every gate applies uniformly to
 * every transport — is worth more than the LoC savings.
 *
 * Design exercise validated against all four shapes:
 * docs/architecture/MATRIX-SEND-DESIGN.md.
 *
 * The factory is invoked inside createBotsRouter so it can capture the
 * router's deps via the `routerCtx` parameter — no need to thread 10+
 * deps through each call site.
 *
 * @typedef {object} RouterContext
 * @property {(req: any, res: any) => boolean} requireWorkerSecret
 * @property {{ hookBus: () => any }} runtimeState
 * @property {(type: string, msg: string, meta?: object) => void} addActivity
 * @property {(channelId?: string) => void} trackExplicitSend
 * @property {(args: object) => Promise<{id: string, kind: string, record?: object} | null>} enforceChannelAuthority
 * @property {(args: object) => Promise<boolean>} checkEnvelopeDedup
 * @property {(args: object) => void} persistOutboundIfPossible
 * @property {string} AGENT_ID
 * @property {string} logPrefix
 *
 * @typedef {object} GateError
 * @property {number} status   — HTTP status to return
 * @property {object} body     — JSON body to send
 *
 * @typedef {object} RouteConfig
 * @property {string} platform                — PLATFORMS enum value
 * @property {string} contentField            — request body field with the message text
 * @property {string[]} allowedKinds          — kinds the route accepts (passed to enforceChannelAuthority)
 * @property {(req: any) => string|null} resolveProvidedId
 * @property {(providedId: string) => string} inferKind
 * @property {{error: string, hint: string}} failClosedRouting
 * @property {(req: any) => Promise<{error?: GateError}|undefined>} [preFlight]      — e.g. WhatsApp BOT_URL check
 * @property {(req: any) => object} [outboundEmitExtras]                              — extra fields for message.outbound
 * @property {(args: {req: any, auth: any}) => Promise<{error?: GateError}|undefined>} [encryptionGate]   — Matrix-only
 * @property {(args: {req: any, auth: any}) => Promise<{error?: GateError}|undefined>} [allowlistGate]    — Matrix-only
 * @property {(args: {req: any, auth: any}) => Promise<{error?: GateError, state?: any}|undefined>} [preApiGate]  — Discord rate-limit
 * @property {(args: {target: string, kind: string, content: string, req: any, gateState?: any, ctx: RouterContext}) => Promise<object>} apiCall
 * @property {(args: {result: any, req: any, auth: any, ctx: RouterContext}) => Promise<{voiceExtras?: object, persistArgs?: object, emitExtras?: object}|null>} [postSendHook]
 * @property {(args: {result: any, gateState: any, voiceExtras: object, auth: any}) => object} [formatSuccess]
 * @property {(err: any) => {status: number, body: object, partial?: boolean, partialOutboundArgs?: object, emitExtras?: object}} [classifyError]
 * @property {(auth: any) => string} [logTargetTag]                                   — formatted id for log lines
 * @property {{send: string, suppressed: string, blocked: string, deduped: string, failed: string}} activityTypes
 */

import { assertDeliverable } from '@mycelium/core/tokens.js';
import { canonicalChannelId } from '@mycelium/core/channel-id.js';
import { redactText } from '@mycelium/core/log-redact.js';
import { isPlatformDisabled, emitOutbound } from '@mycelium/core/extensions/platforms.js';
import { recordEgress } from './egress-audit.js';
import { getActiveTurn } from './inbound-context.js';

/**
 * Map a route platform + auth/inferred kind to the audit channel_kind.
 * Telegram groups need '-' chatId disambiguation; everything else is 1:1.
 */
function auditChannelKind(platform, kind, channelId) {
  if (platform === 'telegram') {
    if (kind === 'telegram-group') return 'telegram-group';
    if (channelId != null && String(channelId).startsWith('-')) return 'telegram-group';
    return 'telegram';
  }
  if (kind) return kind;
  return platform;
}

/**
 * Build an Express handler for a /send route.
 *
 * @param {RouterContext} routerCtx
 * @param {RouteConfig} route
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createSendHandler(routerCtx, route) {
  if (!routerCtx) throw new TypeError('createSendHandler: routerCtx required');
  if (!route?.platform) throw new TypeError('createSendHandler: route.platform required');
  if (!route.contentField) throw new TypeError('createSendHandler: route.contentField required');
  if (typeof route.apiCall !== 'function') throw new TypeError('createSendHandler: route.apiCall required');
  if (!route.activityTypes) throw new TypeError('createSendHandler: route.activityTypes required');

  return async function sendHandler(req, res) {
    const ctx = routerCtx;
    const { platform, contentField } = route;

    // 1. requireWorkerSecret — loopback-only auth gate (every send route
    //    is called from the agent's own processes via WORKER_SECRET).
    if (!ctx.requireWorkerSecret(req, res)) return;

    // 2. kill switch — operator emergency-disable, restart-to-flip.
    if (isPlatformDisabled(platform)) {
      return res.status(503).json({
        error: 'platform-disabled',
        hint: `${platform.toUpperCase()}_DISABLED is set; flip env + restart to re-enable.`,
      });
    }

    // 3. preFlight — optional, e.g. WhatsApp's WHATSAPP_BOT_URL check.
    if (route.preFlight) {
      const pf = await route.preFlight(req);
      if (pf?.error) return res.status(pf.error.status).json(pf.error.body);
    }

    // 4. content presence
    const content = req.body[contentField];
    if (!content) {
      return res.status(400).json({ error: `${contentField} required` });
    }

    const { trusted, sourceKind, sourceId, targetName, crossChannelReason } = req.body;

    // Phase 2 step 4-5 of EGRESS-PROVENANCE / channel-context isolation:
    // resolve inbound channel from req.body (reply MCP tool path) OR fall
    // back to the active-turn registry (curl path, where the caller didn't
    // know to set sourceKind/sourceId). Autonomous endpoints (/think,
    // /chat/stream, /portal/chat/stream, /chat/triage, scheduler) leave
    // the registry empty by design — see inbound-context.js:15-17. In
    // that case effectiveSource{Kind,Id} stay null and crossChannel = 0.
    // crossChannel fires ONLY when inbound IS set AND differs from target.
    const _activeTurn = getActiveTurn();
    const effectiveSourceKind = sourceKind || _activeTurn?.channelKind || null;
    const effectiveSourceId   = sourceId   || _activeTurn?.channelId   || null;

    // 4b. system-template provenance detection (Phase 1 of egress-provenance
    //     refactor). The `x-egress-provenance: system-template` header is
    //     honored ONLY when the request comes from a strict-loopback socket
    //     (loopback IP AND no x-forwarded-for). Caddy-proxied requests adding
    //     X-Forwarded-For fall through to the agent-explicit path even if the
    //     header is present. See docs/EGRESS-PROVENANCE-PHASE1-DESIGN-2026-05-06
    //     §2 for the threat model.
    //
    //     When isSystemTemplate is true:
    //       - channel-authority gate is bypassed (operator channels aren't
    //         always in the registry; bypass preserves today's delivery)
    //       - trackExplicitSend is skipped (system messages don't count toward
    //         the per-task counter that drives the chat fallback decision)
    //       - persistOutboundIfPossible records origin: 'system-template' so
    //         the assistant row is distinguishable in chat history
    //       - emitOutbound + audit row classify with provenanceKind:
    //         'system-template' and templateId from the x-egress-template-id
    //         header
    //     All other gates (assertDeliverable, dedup, persist, hook bus, audit)
    //     apply normally.
    const socketIp = req.socket?.remoteAddress || '';
    const headers = req.headers || {};
    const isStrictLoopback =
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(socketIp)
      && !headers['x-forwarded-for'];
    const isSystemTemplate =
      headers['x-egress-provenance'] === 'system-template'
      && isStrictLoopback;
    // Phase 2: third provenance class. Set by `egress.agentExplicit` (the
    // reply MCP tool's HTTP layer) so the audit row is classified as
    // `agent-explicit-via-tool` rather than `agent-explicit-via-curl`. The
    // `trackExplicitSend` gate below (`!isSystemTemplate`) still fires the
    // counter — that's how Phase 2 closes most of the leak class without
    // deleting the chat fallback (the counter increments → fallback's "if
    // zero explicit sends" check sees > 0 → fallback skips).
    const isAgentExplicit =
      headers['x-egress-provenance'] === 'agent-explicit'
      && isStrictLoopback;
    const templateId = isSystemTemplate
      ? (headers['x-egress-template-id'] || null)
      : null;
    // Audit + hook-bus provenance: header-driven when present, falls back to
    // the legacy `trusted` flag classification (Phase 4 retires `trusted`).
    const provenanceKind = (isSystemTemplate || trusted)
      ? 'system-template'
      : isAgentExplicit
        ? 'agent-explicit-via-tool'
        : 'agent-explicit-via-curl';

    // 5. assertDeliverable — egress backstop. Trusted callers (recovery,
    //    ops alerts) bypass via `{trusted: true}`. The egress chokepoint
    //    is the *only* path agent text reaches a channel under explicit-
    //    send (CLAUDE.md Principle 11). System-template messages pass this
    //    gate naturally — they don't match silent-reply patterns.
    const gate = assertDeliverable(content, { trusted: !!trusted });
    if (!gate.deliver) {
      const preview = redactText(content);
      console.warn(`[${ctx.logPrefix}] ${platform} send suppressed by egress gate (${gate.reason}): ${preview}`);
      ctx.addActivity('warning', `${platform} send suppressed (${gate.reason}): ${preview}`,
        { type: route.activityTypes.suppressed, reason: gate.reason });
      // Phase 0 audit: record the suppression with the proposed target id (if
      // any) — auth not yet resolved at this gate, so use the request hint.
      const provId = route.resolveProvidedId(req);
      const _xChan = effectiveSourceId != null && provId != null
        && String(effectiveSourceId) !== String(provId) ? 1 : 0;
      recordEgress({
        provenanceKind,
        templateId,
        sourceModule: 'send-handler',
        channelKind: auditChannelKind(platform, provId ? route.inferKind(provId) : null, provId),
        channelId: provId || '',
        inboundKind: effectiveSourceKind,
        inboundId:   effectiveSourceId,
        crossChannel: !!_xChan,
        crossChannelReason: _xChan ? crossChannelReason || null : null,
        content,
        decision: 'denied',
        reason: `assertDeliverable:${gate.reason}`,
      });
      return res.json({ ok: true, suppressed: true, reason: gate.reason });
    }
    if (trusted) console.log(`[${ctx.logPrefix}] ${platform} send: trusted-bypass on egress gate`);

    // 6. outbound emit — fires BEFORE further gates so observability
    //    captures send intent at the chokepoint, even when subsequent
    //    gates deny.
    //
    //    Phase 1: payload now carries `provenanceKind` + `templateId` so
    //    extension subscribers can distinguish system-template from agent-
    //    explicit traffic. `trusted` retained for backward compat with
    //    existing subscribers (Phase 4 retires it alongside the body flag).
    emitOutbound(ctx.runtimeState.hookBus(), 'message.outbound', {
      platform,
      text_preview: redactText(content),
      timestamp: new Date().toISOString(),
      role: 'assistant',
      agent_id: process.env.AGENT_ID || '',
      source_kind: sourceKind || null,
      source_id: sourceId || null,
      trusted: !!trusted,
      provenanceKind,
      templateId,
      ...(route.outboundEmitExtras ? route.outboundEmitExtras(req) : {}),
    });

    // 7. trivial-content gate — block "test", "...", etc. that
    //    autonomous wake cycles sometimes emit.
    const stripped = String(content).replace(/[\s.…!?,;:'"*_`#\-]+/g, '').trim();
    if (stripped.length < 8) {
      const preview = redactText(content);
      console.warn(`[${ctx.logPrefix}] ${platform} send blocked (trivial content): ${preview}`);
      ctx.addActivity('warning', `${platform} send blocked (trivial): ${preview}`,
        { type: route.activityTypes.blocked });
      return res.json({ ok: true, blocked: true, reason: 'Message too short or trivial' });
    }

    // 8. fail-closed routing — caller must specify the target. No env
    //    fallbacks (A.25 lesson — silent default routes are leak surfaces).
    const providedId = route.resolveProvidedId(req);
    if (!providedId && !targetName) {
      return res.status(400).json(route.failClosedRouting);
    }

    // 9. channel authority — registry-backed canSendTo decision.
    //    `trusted: true` flags this as autonomous (wake cycle / recovery).
    //
    //    Phase 1: when isSystemTemplate, the registry gate is bypassed —
    //    operator channels (Discord ops, OWNER_TELEGRAM_ID DM) aren't
    //    auto-registered today, and bypassing here preserves today's
    //    delivery contract for system-template traffic. The audit log
    //    captures source_module + templateId, so any extension forging
    //    the header would surface in the audit.
    const inferredKind = providedId ? route.inferKind(providedId) : null;
    let auth;
    if (isSystemTemplate) {
      auth = {
        kind: inferredKind || route.allowedKinds[0],
        id: providedId,
        code: 'system-template-bypass',
      };
    } else {
      auth = await ctx.enforceChannelAuthority({
        req, res,
        kind: inferredKind,
        allowedKinds: route.allowedKinds,
        providedId, targetName, sourceKind, sourceId,
        isAutonomous: !!trusted,
      });
      if (!auth) return; // response already written by enforceChannelAuthority
    }

    // 10a. encryption gate (Matrix-only — refuses to deliver to a room
    //      without m.room.encryption. Defense in depth on top of the
    //      mandatory-Megolm room-creation invariant).
    if (route.encryptionGate) {
      const eg = await route.encryptionGate({ req, auth });
      if (eg?.error) return res.status(eg.error.status).json(eg.error.body);
    }
    // 10b. allowlist / bond gate (Matrix-only — peer-agent rooms require
    //      either an operator-managed allowlist row, or a valid bond VC
    //      once SOCIAL-PROTOCOL Phase 2 ships).
    if (route.allowlistGate) {
      const ag = await route.allowlistGate({ req, auth });
      if (ag?.error) return res.status(ag.error.status).json(ag.error.body);
    }
    // 10c. preApiGate (Discord rate-limit — state-machine check that
    //      blocks the send if the per-hour / per-day budget is exhausted).
    let gateState = null;
    if (route.preApiGate) {
      const pag = await route.preApiGate({ req, auth });
      if (pag?.error) return res.status(pag.error.status).json(pag.error.body);
      gateState = pag?.state || null;
    }

    // 11. envelope dedup — cross-process guard against double-send.
    //     Trusted callers bypass.
    if (await ctx.checkEnvelopeDedup({
      res, platform, kind: auth.kind, id: auth.id,
      content, trusted, addActivityType: route.activityTypes.deduped,
    })) return;

    // 12. tracking + activity log
    //
    //     Phase 1: skip trackExplicitSend for system-template messages.
    //     The per-channel counter drives the chat fallback's "if zero
    //     explicit sends" decision — incrementing on system messages
    //     would suppress legitimate fallback fires. (Acceptable in Phase
    //     3 when the fallback is deleted, NOT in Phase 1.) Activity log
    //     still records the action; audit log captures the send.
    if (!isSystemTemplate) {
      ctx.trackExplicitSend(canonicalChannelId(auth.kind, auth.id));
    }
    ctx.addActivity('action', `Sending message to ${platform}: ${redactText(content)}`,
      { type: route.activityTypes.send });

    const previewText = redactText(content);
    const targetTag = route.logTargetTag ? route.logTargetTag(auth) : String(auth.id);

    // 13. apicall + success / error path
    try {
      const result = await route.apiCall({
        target: auth.id, kind: auth.kind, content, req, gateState, ctx,
      });

      console.log(`[${ctx.logPrefix}] Message sent to ${platform} (${targetTag}, ${result?.sent ?? 1}/${result?.total ?? 1} chunks): ${previewText}`);

      // postSendHook — runs after the text send, before the response is
      // composed. Used for telegram voice synthesis (failure-tolerant —
      // text was already delivered, voice failure is logged not thrown).
      let voiceExtras = {};
      let postPersistArgs = {};
      let postEmitExtras = {};
      if (route.postSendHook) {
        try {
          const post = await route.postSendHook({ result, req, auth, ctx });
          if (post) {
            voiceExtras = post.voiceExtras || {};
            postPersistArgs = post.persistArgs || {};
            postEmitExtras = post.emitExtras || {};
          }
        } catch (postErr) {
          console.error(`[${ctx.logPrefix}] ${platform} postSendHook failed (text was delivered): ${postErr.message}`);
          ctx.addActivity('warning', `${platform} post-send hook failed: ${postErr.message.slice(0, 80)}`,
            { type: `${platform}-post-send-failed` });
        }
      }

      // Persist the outbound row to D1 so it shows up in next session's
      // history. Source is keyed by chatId so cross-channel history
      // search can find it. Fire-and-forget — never block delivery on
      // storage.
      //
      // Phase 1: pass origin: 'system-template' for header-tagged sends so
      // chat-history search/recall can filter system messages from agent
      // replies. Default 'explicit-send' applies when origin is undefined.
      ctx.persistOutboundIfPossible({
        platform,
        chatId: auth.id,
        text: content,
        ...(isSystemTemplate ? { origin: 'system-template' } : {}),
        ...(result?.sent != null ? { sent: result.sent } : {}),
        ...(result?.total != null ? { total: result.total } : {}),
        ...postPersistArgs,
      });

      emitOutbound(ctx.runtimeState.hookBus(), 'message.outbound.delivered', {
        platform,
        chat_id: String(auth.id),
        sent: result?.sent ?? 1,
        total: result?.total ?? 1,
        text_preview: previewText,
        timestamp: new Date().toISOString(),
        ...postEmitExtras,
      });

      // Phase 0 audit: successful delivery through the chokepoint.
      // Phase 1: provenanceKind + templateId are header-driven when present.
      // Phase 2 step 4-5: inboundKind/inboundId/crossChannel close the
      // channel-context audit gap. See CHANNEL-CONTEXT-ISOLATION-DESIGN.
      const _xChan = effectiveSourceId != null && auth?.id != null
        && String(effectiveSourceId) !== String(auth.id) ? 1 : 0;
      recordEgress({
        provenanceKind,
        templateId,
        sourceModule: 'send-handler',
        channelKind: auditChannelKind(platform, auth.kind, auth.id),
        channelId: auth.id,
        inboundKind: effectiveSourceKind,
        inboundId:   effectiveSourceId,
        crossChannel: !!_xChan,
        crossChannelReason: _xChan ? crossChannelReason || null : null,
        content,
        decision: 'allowed',
        reason: auth.code || 'cross-source',
        delivered: true,
      });

      const successBody = route.formatSuccess
        ? route.formatSuccess({ result, gateState, voiceExtras, auth })
        : { ok: true, ...result, ...voiceExtras };
      res.json(successBody);
    } catch (err) {
      const classified = route.classifyError
        ? route.classifyError(err)
        : { status: 502, body: { ok: false, error: err.message } };

      console.error(`[${ctx.logPrefix}] ${platform} send ${classified.partial ? 'PARTIAL' : 'FAILED'} (${targetTag}): ${err.message}`);
      ctx.addActivity('error', `${platform} send ${classified.partial ? 'partial' : 'failed'}: ${err.message}`,
        { type: route.activityTypes.failed, partial: !!classified.partial });

      emitOutbound(ctx.runtimeState.hookBus(), 'message.outbound.failed', {
        platform,
        chat_id: String(auth.id),
        partial_success: !!classified.partial,
        error: err.message,
        text_preview: previewText,
        timestamp: new Date().toISOString(),
        ...(classified.emitExtras || {}),
      });

      // Persist partial-success outbound (telegram-only today). Caller
      // asked us to send; partial delivery still constitutes "the agent
      // reached the user" for some chunks; lose-it-all would be worse.
      if (classified.partial && classified.partialOutboundArgs) {
        ctx.persistOutboundIfPossible({
          platform,
          chatId: auth.id,
          text: content,
          partial: true,
          ...classified.partialOutboundArgs,
        });
      }

      // Phase 0 audit: failed (or partial) delivery through the chokepoint.
      // Partial counts as delivered=true with httpStatus from the classified
      // error so we can distinguish "nothing reached the user" from "some
      // chunks did". `auth` is available here because this catch is downstream
      // of the channel-authority gate.
      // Phase 1: provenanceKind + templateId are header-driven when present.
      // Phase 2 step 4-5: inboundKind/inboundId/crossChannel.
      const _xChanErr = effectiveSourceId != null && auth?.id != null
        && String(effectiveSourceId) !== String(auth.id) ? 1 : 0;
      recordEgress({
        provenanceKind,
        templateId,
        sourceModule: 'send-handler',
        channelKind: auditChannelKind(platform, auth.kind, auth.id),
        channelId: auth.id,
        inboundKind: effectiveSourceKind,
        inboundId:   effectiveSourceId,
        crossChannel: !!_xChanErr,
        crossChannelReason: _xChanErr ? crossChannelReason || null : null,
        content,
        decision: 'allowed',
        reason: `apicall-failed:${classified.partial ? 'partial' : err.message?.slice(0, 80) || 'unknown'}`,
        delivered: !!classified.partial,
        httpStatus: classified.status,
      });

      res.status(classified.status).json(classified.body);
    }
  };
}
