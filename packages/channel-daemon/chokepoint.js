/**
 * Telegram egress chokepoint (Phase 0).
 *
 * This is the ONLY path agent text reaches a Telegram chat — "explicit-send
 * only" (CLAUDE.md §11). The `reply` MCP tool (src/tools/reply.js) POSTs here
 * with `x-egress-provenance: agent-explicit`; cross-channel curls hit the same
 * handler. The agent's raw model output is never delivered by any other route.
 *
 * Distilled from the canonical packages/server/lib/send-handler.js
 * (reference/egress/send-handler.js): single-platform, single-user, and with
 * every cross-process/multi-tenant dep replaced by an injected function so the
 * gate sequence is verifiable without network or a running vault.
 *
 * Gate order (every send passes all of them, in this order):
 *   1. content present
 *   2. fail-closed routing (chatId required — no env default targets, A.25)
 *   3. trivial-content block ("test", "...", wake-cycle noise)
 *   4. provenance classification (strict-loopback header check)
 *   5. channel authority (registry-backed; fail-closed; `trusted` bypasses)
 *   6. envelope dedup (collapse identical resends within the TTL)
 *   7. Telegram API call
 *   8. egress audit (hash only) + outbound persist
 *
 * Audit NEVER carries plaintext — only sha256(content) + length (CLAUDE.md §1).
 */
import crypto from 'node:crypto';

/** chatId starting with '-' is a group/supergroup; everything else is a DM. */
function inferKind(chatId) {
  return String(chatId).startsWith('-') ? 'telegram-group' : 'telegram';
}

/** Strict loopback: loopback socket AND no proxy header (Caddy would add one). */
function isStrictLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  const fwd = (req.headers || {})['x-forwarded-for'];
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && !fwd;
}

/** Redact a body to a short, length-tagged preview — never log full content. */
function preview(text) {
  const s = String(text);
  const head = s.slice(0, 12).replace(/\s+/g, ' ');
  return `«${head}${s.length > 12 ? '…' : ''}»(${s.length})`;
}

/**
 * @param {object} deps
 * @param {(a:{chatId:any,text:string,replyToMessageId?:any})=>Promise<{sent:number,total:number,httpStatus:number}>} deps.sendToTelegram
 * @param {(entry:object)=>any} deps.recordEgress              fire-and-forget; soft-fail
 * @param {(args:object)=>any} deps.persistOutbound            fire-and-forget; soft-fail
 * @param {(a:{kind:string,id:any})=>Promise<{allowed:boolean,reason?:string}>} deps.checkAuthority
 * @param {{isDuplicate:(t:any,c:string)=>boolean, mark:(t:any,c:string)=>void}} deps.dedup
 * @param {()=>object|null} deps.getActiveTurn
 * @param {string} [deps.agentId]
 * @param {string} [deps.logPrefix]
 */
export function createTelegramChokepoint(deps) {
  const {
    sendToTelegram, recordEgress, persistOutbound, checkAuthority, dedup,
    getActiveTurn, agentId = 'personal-agent', logPrefix = 'channel-daemon',
  } = deps || {};
  if (typeof sendToTelegram !== 'function') throw new TypeError('chokepoint: sendToTelegram required');
  if (typeof checkAuthority !== 'function') throw new TypeError('chokepoint: checkAuthority required');
  if (typeof getActiveTurn !== 'function') throw new TypeError('chokepoint: getActiveTurn required');
  if (!dedup || typeof dedup.isDuplicate !== 'function') throw new TypeError('chokepoint: dedup required');

  const audit = typeof recordEgress === 'function' ? recordEgress : () => {};
  const persist = typeof persistOutbound === 'function' ? persistOutbound : () => {};

  return async function telegramSendHandler(req, res) {
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text : '';
    const { chatId, replyToMessageId, sourceKind, sourceId, trusted, crossChannelReason } = body;

    // 1. content present
    if (!text) return res.status(400).json({ ok: false, error: 'text required' });

    // 2. fail-closed routing — no silent env-default targets (A.25 leak lesson)
    if (chatId == null || chatId === '') {
      return res.status(400).json({ ok: false, error: 'chatId required', hint: 'no default route — specify the target chat' });
    }

    // 3. trivial-content block — wake-cycle noise ("test", "...", emoji-only)
    const stripped = text.replace(/[\s.…!?,;:'"*_`#\-]+/g, '').trim();
    if (stripped.length < 8) {
      console.warn(`[${logPrefix}] telegram send blocked (trivial): ${preview(text)}`);
      return res.json({ ok: true, blocked: true, reason: 'Message too short or trivial' });
    }

    // 4. provenance — agent-explicit only when the header rides a strict-loopback
    //    socket. `trusted` (ops/recovery) classifies as system-template + bypasses
    //    the authority gate, matching the canonical handler.
    const headerProv = (req.headers || {})['x-egress-provenance'];
    const loopback = isStrictLoopback(req);
    const isAgentExplicit = headerProv === 'agent-explicit' && loopback;
    const provenanceKind = trusted
      ? 'system-template'
      : (isAgentExplicit ? 'agent-explicit-via-tool' : 'agent-explicit-via-curl');

    const kind = inferKind(chatId);
    const contentHash = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const contentLength = text.length;

    // Resolve inbound context (reply-tool body first, else the active-turn registry).
    const turn = getActiveTurn();
    const inboundKind = sourceKind || turn?.channelKind || null;
    const inboundId = sourceId || turn?.channelId || null;
    const crossChannel = inboundId != null && String(inboundId) !== String(chatId);

    const baseAudit = {
      agentId, provenanceKind, sourceModule: 'channel-daemon.telegram',
      channelKind: kind, channelId: String(chatId),
      inboundKind, inboundId: inboundId != null ? String(inboundId) : null,
      crossChannel, crossChannelReason: crossChannel ? (crossChannelReason || null) : null,
      contentHash, contentLength,
    };

    // 5. channel authority — fail-closed. `trusted` bypasses (ops/recovery).
    if (!trusted) {
      const auth = await checkAuthority({ kind, id: chatId });
      if (!auth?.allowed) {
        console.warn(`[${logPrefix}] telegram send denied by channel authority (${auth?.reason || 'unknown'}) → ${preview(text)}`);
        audit({ ...baseAudit, decision: 'denied', reason: `channel-authority:${auth?.reason || 'denied'}` });
        return res.status(403).json({ ok: false, error: 'channel-authority-denied', reason: auth?.reason || null });
      }
    }

    // 6. envelope dedup — identical (target, content) within the TTL is one send.
    if (dedup.isDuplicate(chatId, text)) {
      console.log(`[${logPrefix}] telegram send deduped (identical within window) → ${preview(text)}`);
      audit({ ...baseAudit, decision: 'allowed', reason: 'envelope-dedup', delivered: false });
      return res.json({ ok: true, deduped: true });
    }

    // 7. + 8. send → audit + persist
    try {
      const result = await sendToTelegram({ chatId, text, replyToMessageId });
      dedup.mark(chatId, text);
      console.log(`[${logPrefix}] telegram delivered (${result.sent}/${result.total}) → ${preview(text)}`);

      audit({ ...baseAudit, decision: 'allowed', reason: isAgentExplicit ? 'reply-tool' : (trusted ? 'trusted' : 'cross-source'), delivered: true, httpStatus: result.httpStatus });
      persist({
        userId: undefined, // vault fills its own owner; REST route injects userId
        id: undefined,
        content: text, role: 'assistant', source: kind === 'telegram-group' ? 'telegram-group' : 'telegram',
        conversationId: String(chatId),
        metadata: { channelId: String(chatId), origin: 'explicit-send', provenanceKind, ...(replyToMessageId != null ? { inReplyTo: String(replyToMessageId) } : {}) },
      });

      return res.json({ ok: true, delivered: true, sent: result.sent, total: result.total });
    } catch (err) {
      const httpStatus = err?.httpStatus ?? 502;
      const partial = !!err?.partial;
      console.error(`[${logPrefix}] telegram send ${partial ? 'PARTIAL' : 'FAILED'} (status ${httpStatus}) → ${preview(text)}`);
      audit({ ...baseAudit, decision: 'allowed', reason: `apicall-failed:${partial ? 'partial' : (err?.message?.slice(0, 60) || 'unknown')}`, delivered: partial, httpStatus });
      if (partial) {
        dedup.mark(chatId, text);
        persist({ content: text, role: 'assistant', source: kind === 'telegram-group' ? 'telegram-group' : 'telegram', conversationId: String(chatId), metadata: { channelId: String(chatId), origin: 'explicit-send', partial: true } });
      }
      return res.status(partial ? 207 : (httpStatus >= 400 ? httpStatus : 502)).json({ ok: false, error: partial ? 'partial-delivery' : 'send-failed', sent: err?.sent ?? 0 });
    }
  };
}
