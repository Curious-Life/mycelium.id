/**
 * Operator notifications — short, system-authored messages that surface
 * lifecycle events to the human operating this agent.
 *
 * Distinct from agent messages (composed by the model during a Claude
 * Code run) which take a separate path. These two categories must stay
 * separate:
 *
 *   - **Agent messages**  — composed by the agent during a run, sent
 *                           only via explicit curl to a bots `/send`
 *                           route. Free-form output is never delivered
 *                           except through this explicit path.
 *   - **System messages** — composed here, in code, by the operator's
 *                           own infrastructure. Always short, routed
 *                           through `egress.systemTemplate` which sets
 *                           the `x-egress-provenance: system-template`
 *                           header on the loopback chokepoint POST.
 *
 * Routing precedence (preserved from pre-Phase-1):
 *   1. Discord channel (DISCORD_BOT_URL set) → operator's Discord channel
 *      OR explicit `channelIdOverride` (matches the existing
 *      `notifyContinuation` precedent for non-recovery notifications).
 *   2. Telegram (TELEGRAM_BOT_URL set AND `OWNER_TELEGRAM_ID` set) →
 *      operator's Telegram DM.
 *   3. WhatsApp (WHATSAPP_BOT_URL set) → fall through.
 *   4. Otherwise: skip silently. Logged for observability.
 *
 * Phase 1 of EGRESS-PROVENANCE-PLAN-2026-05-06:
 *   - Routing through Layer A (chokepoint) instead of Layer B (bot
 *     subprocess) — every text crossing to a person-visible channel
 *     passes through one gate.
 *   - HTTP construction moved to egress.systemTemplate. This factory's
 *     `discordBotUrl` / `telegramBotUrl` / `whatsappBotUrl` deps are now
 *     truthy-check availability flags, not URL builders.
 *   - Origin-side audit emissions removed. The chokepoint is the single
 *     source of audit truth.
 *
 * @typedef {object} OperatorNotifierDeps
 * @property {string} agentId
 * @property {string} logPrefix
 * @property {string|null} [discordChannel]    — env DISCORD_CHANNEL (operator's ops channel id)
 * @property {string|null} [discordBotUrl]     — env DISCORD_BOT_URL (availability flag only)
 * @property {string|null} [telegramBotUrl]    — env TELEGRAM_BOT_URL (availability flag only)
 * @property {string|null} [whatsappBotUrl]    — env WHATSAPP_BOT_URL (availability flag only)
 * @property {object} [egress]                 — test seam: { systemTemplate } override
 *                                                (defaults to the singleton in lib/egress.js)
 */

import * as defaultEgress from './egress.js';

export function createOperatorNotifier(deps) {
  if (!deps) throw new TypeError('createOperatorNotifier: deps required');
  const {
    agentId, logPrefix,
    discordChannel = null, discordBotUrl = null,
    telegramBotUrl = null, whatsappBotUrl = null,
    egress = defaultEgress,
  } = deps;

  if (typeof agentId !== 'string')   throw new TypeError('createOperatorNotifier: agentId required');
  if (typeof logPrefix !== 'string') throw new TypeError('createOperatorNotifier: logPrefix required');
  if (typeof egress?.systemTemplate !== 'function') {
    throw new TypeError('createOperatorNotifier: egress.systemTemplate required');
  }

  /**
   * Send a short system-authored message to the operator's preferred
   * channel via the loopback chokepoint. Returns true on delivery, false
   * if no channel was configured or delivery failed.
   *
   * @param {string} message - the formatted system message; should be
   *                           short (≤200 chars) and self-contained
   * @param {object} [opts]
   * @param {string} [opts.channelIdOverride] - explicit Discord channel
   *                                            for this notification
   *                                            (defaults to the env
   *                                            channelId)
   * @param {string} [opts.templateId]        - audit + hook-bus tag
   * @returns {Promise<boolean>}
   */
  async function send(message, opts = {}) {
    const { channelIdOverride, templateId = 'agent-egress.send' } = opts;
    if (!message || typeof message !== 'string') {
      console.warn(`[${logPrefix}] operator-notifier.send: empty message, skipping`);
      return false;
    }

    const discordTarget = channelIdOverride || discordChannel;
    if (discordTarget && discordBotUrl) {
      const r = await egress.systemTemplate({
        templateId, platform: 'discord', channelId: discordTarget, content: message,
      });
      if (!r.delivered && r.httpStatus != null) {
        console.warn(`[${logPrefix}] operator-notifier: Discord send returned ${r.httpStatus}`);
      } else if (!r.delivered) {
        console.warn(`[${logPrefix}] operator-notifier: Discord send failed (${r.errorCode || 'unknown'})`);
      }
      return r.delivered;
    }

    const ownerTelegramId = process.env.OWNER_TELEGRAM_ID;
    if (telegramBotUrl && ownerTelegramId) {
      const r = await egress.systemTemplate({
        templateId, platform: 'telegram', channelId: ownerTelegramId, content: message,
      });
      if (!r.delivered && r.httpStatus != null) {
        console.warn(`[${logPrefix}] operator-notifier: Telegram send returned ${r.httpStatus}`);
      } else if (!r.delivered) {
        console.warn(`[${logPrefix}] operator-notifier: Telegram send failed (${r.errorCode || 'unknown'})`);
      }
      return r.delivered;
    }

    if (whatsappBotUrl) {
      const r = await egress.systemTemplate({
        templateId, platform: 'whatsapp', channelId: '', content: message,
      });
      if (!r.delivered && r.httpStatus != null) {
        console.warn(`[${logPrefix}] operator-notifier: WhatsApp send returned ${r.httpStatus}`);
      } else if (!r.delivered) {
        console.warn(`[${logPrefix}] operator-notifier: WhatsApp send failed (${r.errorCode || 'unknown'})`);
      }
      return r.delivered;
    }

    console.log(`[${logPrefix}] operator-notifier: no channel configured, skipping: "${message.slice(0, 80)}"`);
    return false;
  }

  /**
   * Recovery completed — notify the operator that an interrupted task
   * was resumed and finished. The agent's actual output, if relevant,
   * is delivered separately by the agent's own explicit curl during
   * the resumed run; this is purely an operations notification.
   *
   * @param {object} info
   * @param {string} info.taskType  - canonical task type, e.g. 'morningBrief'
   * @param {string} [info.sessionId]
   * @param {object} [info.deliveryContext] - if a Discord channelId is
   *                                          present, deliver there
   *                                          instead of the operator DM
   *                                          (preserves existing
   *                                          notifyContinuation routing)
   * @returns {Promise<boolean>}
   */
  async function notifyRecoveryComplete(info) {
    const taskType = info?.taskType || 'task';
    const message = `✅ Task \`${taskType}\` resumed and completed`;
    return send(message, {
      channelIdOverride: info?.deliveryContext?.channelId,
      templateId: 'recovery-complete',
    });
  }

  /**
   * Map an inbound channel kind (as set on `req.body.source` in chat.js
   * — values like 'telegram', 'telegram-group', 'discord', 'whatsapp')
   * to the platform name accepted by `egress.systemTemplate`.
   *
   * Returns null when the kind isn't a recognised messaging platform
   * (e.g. 'unknown' from chat.js's fallback) — in that case the caller
   * should fall through to the operator-notifier `send()` path.
   */
  function _inboundKindToPlatform(kind) {
    if (!kind || typeof kind !== 'string') return null;
    const k = kind.toLowerCase();
    if (k.startsWith('telegram')) return 'telegram';
    if (k.startsWith('discord'))  return 'discord';
    if (k.startsWith('whatsapp')) return 'whatsapp';
    return null;
  }

  /**
   * Tell the user about artifacts the agent published during a chat
   * turn. Bundled per-turn (≤ 5 lines, "and N more" suffix), system-
   * authored. Used by chat.js at task-end when the agent created files
   * but didn't explicitly send them — e.g. Ada's research case where
   * 5 .md files landed in the library and the user was never told.
   *
   * **Phase G of CHANNEL-CONTEXT-ISOLATION-DESIGN-2026-05-28** — the
   * pre-2026-05-28 implementation passed `channelId` as `channelIdOverride`
   * to `send()`, which hardcodes `platform: 'discord'`. For telegram-
   * originated turns the artifact-summary fired as a Discord send with
   * `channelId='telegram_<id>'`, which discord.js silently dropped on
   * snowflake validation — user never saw "📄 I wrote N documents".
   * CLAUDE.md §12 violation. Phase G routes the summary back through
   * the SAME platform as the inbound, via `egress.systemTemplate`
   * directly (bypassing `send()`'s Discord-first precedence). The
   * operator-notifier path remains for genuinely operator-targeted
   * notifications (recovery-complete, fallback-skipped, etc.).
   *
   * @param {{kind: string, id: string}|null|string} inboundChannel
   *        Object with `kind` (e.g. 'telegram', 'telegram-group',
   *        'discord', 'whatsapp') and `id`. For backward compatibility
   *        with existing callers, accepts a plain string (treated as the
   *        channel id with unknown kind → fall through to operator path).
   * @param {Array<{path: string, title: string, filename?: string}>} artifacts
   * @returns {Promise<boolean>}
   */
  async function notifyArtifactsCreated(inboundChannel, artifacts) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return false;

    // Accept legacy `(channelId, artifacts)` shape as `{kind: null, id: channelId}`.
    const inb = (typeof inboundChannel === 'string' || inboundChannel == null)
      ? { kind: null, id: inboundChannel }
      : inboundChannel;
    if (!inb.id) return false;

    const MAX_LINES = 5;
    const head = artifacts.slice(0, MAX_LINES);
    const more = artifacts.length > MAX_LINES
      ? `\n_…and ${artifacts.length - MAX_LINES} more in the library._`
      : '';
    const lines = head.map(a => {
      const display = a.title || a.filename || a.path || 'document';
      return `• \`${a.path || display}\``;
    });
    const message =
      `📄 I wrote ${artifacts.length} document${artifacts.length === 1 ? '' : 's'} during this task:\n` +
      lines.join('\n') +
      more +
      `\n\n_View in your library._`;

    const platform = _inboundKindToPlatform(inb.kind);
    if (platform) {
      // Route the summary back through the SAME platform as the inbound
      // — telegram inbound → telegram-send, discord inbound → discord-send,
      // etc. This is the Phase G fix: the user sees the artifact summary
      // on the channel they used to talk to the agent, not on a fixed
      // operator notification channel.
      const r = await egress.systemTemplate({
        templateId: 'artifacts-summary',
        platform,
        channelId: String(inb.id),
        content: message,
      });
      if (!r.delivered && r.httpStatus != null) {
        console.warn(`[${logPrefix}] notifyArtifactsCreated: ${platform} send returned ${r.httpStatus}`);
      } else if (!r.delivered) {
        console.warn(`[${logPrefix}] notifyArtifactsCreated: ${platform} send failed (${r.errorCode || 'unknown'})`);
      }
      return r.delivered;
    }

    // Unknown inbound kind (legacy callers; chat.js's 'unknown' fallback).
    // Fall through to the operator-notifier path — preserves prior behavior
    // for cases where we genuinely don't know the inbound platform.
    return send(message, {
      channelIdOverride: inb.id,
      templateId: 'artifacts-summary',
    });
  }

  // ── Phase 3 of EGRESS-PROVENANCE: operator-diagnostic for missed-explicit-send ──
  //
  // When an agent produces text in `result.response` but doesn't explicit-send
  // (no curl, no reply tool call), the previous behavior was to auto-deliver
  // the scratchpad via deliverNaturalReplyFallback — the May 2026 monologue
  // leak. Phase 3 removes auto-delivery; this notifier surfaces the event to
  // the operator instead. User gets nothing; operator sees a short,
  // privacy-safe summary so the case can be investigated without reading
  // raw scratchpad content.
  //
  // Per-channel dedup: 60-second window prevents notification spam if an
  // agent skips reply repeatedly for the same inbound channel. The window
  // resets if a different channel skips, or after 60s elapse.
  const _recentSkippedAt = new Map(); // canonical-channel-id → epoch-ms
  const SKIP_DEDUP_WINDOW_MS = 60_000;

  function _shouldDedup(channelKey) {
    const now = Date.now();
    const last = _recentSkippedAt.get(channelKey);
    if (last && now - last < SKIP_DEDUP_WINDOW_MS) return true;
    _recentSkippedAt.set(channelKey, now);
    // Periodic cleanup — keep the map from growing unbounded if many distinct
    // channels skip rarely. Walk the map any time it has > 100 entries.
    if (_recentSkippedAt.size > 100) {
      for (const [k, ts] of _recentSkippedAt.entries()) {
        if (now - ts >= SKIP_DEDUP_WINDOW_MS) _recentSkippedAt.delete(k);
      }
    }
    return false;
  }

  /**
   * Privacy-safe redaction: hash an id to a 6-char prefix. Stable per
   * tenant lifetime, not reversible. Mirrors the redactId pattern in
   * packages/core/log-redact.js but kept inline here to avoid a cross-
   * package import for one tiny helper.
   */
  async function _redactId(value, prefix = '') {
    if (value == null || value === '') return '<unset>';
    const enc = new TextEncoder().encode(`mycelium-redact:${String(value)}`);
    const buf = await crypto.subtle.digest('SHA-256', enc);
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `${prefix}${hex.slice(0, 6)}`;
  }

  /**
   * Phase-out gate: defaults OFF. The diagnostic was added in response
   * to the May 7 missed-reply incident, but its underlying cause (reply
   * tool deferred under MCP listing-budget pressure) was attacked
   * structurally by the caadd92 retirement (51 → 36 tools). Most fires
   * surface legitimate "no_reply with scratchpad orientation" turns,
   * not real misses. Operator can re-enable with EGRESS_FALLBACK_DIAGNOSTIC=on
   * to keep visibility while the 2026-05-14 measurement gate runs.
   */
  function _diagnosticEnabled() {
    const v = (process.env.EGRESS_FALLBACK_DIAGNOSTIC || '').toLowerCase();
    return v === 'on' || v === '1' || v === 'true';
  }

  /**
   * Notify operator that an agent finished a /chat turn without
   * explicit-sending — i.e., produced text in scratchpad but called
   * neither curl nor the reply MCP tool. Replaces the deleted
   * deliverNaturalReplyFallback auto-delivery.
   *
   * @param {object} info
   * @param {string} info.inboundChannelKind  e.g. 'telegram-dm', 'discord-channel', 'whatsapp-jid', 'telegram-group'
   * @param {string} info.inboundChannelId    raw channel/chat ID; redacted in the message
   * @param {number} info.scratchpadBytes     count, not content
   * @param {string} [info.taskId]            optional audit correlation id
   * @returns {Promise<boolean>} true if delivered, false if dedup'd, disabled, or no channel configured
   *
   * Privacy: the agent's scratchpad text is NEVER included in the operator
   * notification — only its byte length. The whole point of explicit-send
   * is that scratchpad stays internal; including a "preview" of it (even
   * 80 chars) leaked the same content this architecture was built to gate.
   */
  async function notifyFallbackSkipped(info) {
    if (!_diagnosticEnabled()) return false;
    if (!info || typeof info !== 'object') return false;
    const { inboundChannelKind, inboundChannelId, scratchpadBytes } = info;
    if (!inboundChannelId) return false;

    const dedupKey = `chat-fallback-skipped:${inboundChannelId}`;
    if (_shouldDedup(dedupKey)) {
      console.log(`[${logPrefix}] notifyFallbackSkipped: deduped (within 60s window) for ${inboundChannelKind || 'unknown'}`);
      return false;
    }

    const redactedId = await _redactId(inboundChannelId, `${inboundChannelKind || 'channel'}-`);
    const message =
      `⚠ Agent skipped explicit-send for inbound \`${redactedId}\` — ${scratchpadBytes || 0} bytes scratchpad discarded.`;

    return send(message, { templateId: 'chat-fallback-skipped' });
  }

  /**
   * Variant for the recovery code path (proactiveSendFallback's old surface).
   * Same shape, distinct templateId for audit distinguishability so operator
   * can tell whether a missed-send happened mid-/chat or during recovery.
   *
   * Currently unused in production (proactiveSendFallback was already dead
   * code at delete time — no active call sites), but kept for symmetry and
   * future-proofing the recovery audit narrative.
   */
  async function notifyRecoveryFallbackSkipped(info) {
    if (!_diagnosticEnabled()) return false;
    if (!info || typeof info !== 'object') return false;
    const { inboundChannelKind, inboundChannelId, scratchpadBytes } = info;
    if (!inboundChannelId) return false;

    const dedupKey = `recovery-fallback-skipped:${inboundChannelId}`;
    if (_shouldDedup(dedupKey)) return false;

    const redactedId = await _redactId(inboundChannelId, `${inboundChannelKind || 'channel'}-`);
    const message =
      `⚠ Recovery resume produced text without explicit-send for \`${redactedId}\` — ${scratchpadBytes || 0} bytes discarded.`;

    return send(message, { templateId: 'recovery-fallback-skipped' });
  }

  return { send, notifyRecoveryComplete, notifyArtifactsCreated, notifyFallbackSkipped, notifyRecoveryFallbackSkipped };
}
