/**
 * Platform-agnostic egress chokepoint core (the canonical send-handler shape).
 *
 * This is the ONE path agent text reaches ANY channel — "explicit-send only"
 * (CLAUDE.md §11). The `reply` MCP tool POSTs here; cross-channel curls hit the
 * same handler. The gate sequence is identical across platforms; everything
 * platform-specific is supplied by `adapter`. Telegram + Discord register
 * adapters; the gates (authority, dedup, rate-limit, audit, voice) are shared.
 *
 * Gate order (every send passes all, in order):
 *   1. content present                    5. channel authority (fail-closed)
 *   2. fail-closed routing (target req)   6. envelope dedup
 *   3. trivial-content block              6b. rate limit
 *   4. provenance (strict-loopback)       7. send → 8. audit (hash only) + persist [+ voice]
 *
 * Audit NEVER carries plaintext — only sha256(content) + length (CLAUDE.md §1).
 *
 * @typedef {object} Adapter
 * @property {string} platform                       'telegram' | 'discord'
 * @property {string} contentField                   body field with the text ('text' | 'content')
 * @property {string} targetField                    body field with the target id ('chatId' | 'channelId')
 * @property {string} sourceModule                   audit source_module tag
 * @property {(targetId:any)=>string} inferKind      → registry/source kind (also the message `source`)
 * @property {(a:{target:any,content:string,replyToMessageId?:any})=>Promise<{sent:number,total:number,httpStatus:number}>} send
 */
import crypto from 'node:crypto';

function isStrictLoopback(req) {
  const ip = req.socket?.remoteAddress || '';
  const fwd = (req.headers || {})['x-forwarded-for'];
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && !fwd;
}

function preview(text) {
  const s = String(text);
  return `«${s.slice(0, 12).replace(/\s+/g, ' ')}${s.length > 12 ? '…' : ''}»(${s.length})`;
}

/**
 * @param {object} deps
 * @param {Adapter} deps.adapter
 * @param {(entry:object)=>any} [deps.recordEgress]
 * @param {(args:object)=>any} [deps.persistOutbound]
 * @param {(a:{kind:string,id:any})=>Promise<{allowed:boolean,reason?:string}>} deps.checkAuthority
 * @param {{isDuplicate:Function, mark:Function}} deps.dedup
 * @param {{take:(t:any)=>{allowed:boolean,retryAfterMs:number}}} [deps.rateLimit]
 * @param {{deliver:(a:object)=>Promise<{voiceSent:number,voiceTotal:number}>}} [deps.voicePipeline]
 * @param {()=>object|null} deps.getActiveTurn
 * @param {string} [deps.agentId]
 * @param {string} [deps.logPrefix]
 */
export function createSendHandler(deps) {
  const {
    adapter, recordEgress, persistOutbound, checkAuthority, dedup,
    rateLimit, voicePipeline, getActiveTurn, agentId = 'personal-agent', logPrefix = 'channel-daemon',
  } = deps || {};
  if (!adapter || typeof adapter.send !== 'function') throw new TypeError('send-handler: adapter.send required');
  if (!adapter.contentField || !adapter.targetField) throw new TypeError('send-handler: adapter content/target fields required');
  if (typeof checkAuthority !== 'function') throw new TypeError('send-handler: checkAuthority required');
  if (typeof getActiveTurn !== 'function') throw new TypeError('send-handler: getActiveTurn required');
  if (!dedup || typeof dedup.isDuplicate !== 'function') throw new TypeError('send-handler: dedup required');

  const { platform, contentField, targetField, sourceModule, inferKind } = adapter;
  const audit = typeof recordEgress === 'function' ? recordEgress : () => {};
  const persist = typeof persistOutbound === 'function' ? persistOutbound : () => {};

  return async function sendHandler(req, res) {
    const body = req.body || {};
    const content = typeof body[contentField] === 'string' ? body[contentField] : '';
    const target = body[targetField];
    const { replyToMessageId, sourceKind, sourceId, trusted, crossChannelReason, voice } = body;

    // 1. content present
    if (!content) return res.status(400).json({ ok: false, error: `${contentField} required` });

    // 2. fail-closed routing — no silent env-default targets (A.25 leak lesson)
    if (target == null || target === '') {
      return res.status(400).json({ ok: false, error: `${targetField} required`, hint: 'no default route — specify the target' });
    }

    // 3. trivial-content block
    const stripped = content.replace(/[\s.…!?,;:'"*_`#\-]+/g, '').trim();
    if (stripped.length < 8) {
      console.warn(`[${logPrefix}] ${platform} send blocked (trivial): ${preview(content)}`);
      return res.json({ ok: true, blocked: true, reason: 'Message too short or trivial' });
    }

    // 4. provenance
    const headerProv = (req.headers || {})['x-egress-provenance'];
    const isAgentExplicit = headerProv === 'agent-explicit' && isStrictLoopback(req);
    const provenanceKind = trusted ? 'system-template' : (isAgentExplicit ? 'agent-explicit-via-tool' : 'agent-explicit-via-curl');

    const kind = inferKind(target);
    const contentHash = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
    const turn = getActiveTurn();
    const inboundKind = sourceKind || turn?.channelKind || null;
    const inboundId = sourceId || turn?.channelId || null;
    const crossChannel = inboundId != null && String(inboundId) !== String(target);

    const baseAudit = {
      agentId, provenanceKind, sourceModule,
      channelKind: kind, channelId: String(target),
      inboundKind, inboundId: inboundId != null ? String(inboundId) : null,
      crossChannel, crossChannelReason: crossChannel ? (crossChannelReason || null) : null,
      contentHash, contentLength: content.length,
    };

    // 5. channel authority — fail-closed; `trusted` bypasses.
    if (!trusted) {
      const a = await checkAuthority({ kind, id: target });
      if (!a?.allowed) {
        console.warn(`[${logPrefix}] ${platform} send denied by channel authority (${a?.reason || 'unknown'}) → ${preview(content)}`);
        audit({ ...baseAudit, decision: 'denied', reason: `channel-authority:${a?.reason || 'denied'}` });
        return res.status(403).json({ ok: false, error: 'channel-authority-denied', reason: a?.reason || null });
      }
    }

    // 6. envelope dedup
    if (dedup.isDuplicate(target, content)) {
      console.log(`[${logPrefix}] ${platform} send deduped → ${preview(content)}`);
      audit({ ...baseAudit, decision: 'allowed', reason: 'envelope-dedup', delivered: false });
      return res.json({ ok: true, deduped: true });
    }

    // 6b. rate limit — after dedup so a collapsed resend doesn't consume budget.
    if (rateLimit && !trusted) {
      const rl = rateLimit.take(target);
      if (!rl.allowed) {
        console.warn(`[${logPrefix}] ${platform} send rate-limited (retry ${rl.retryAfterMs}ms) → ${preview(content)}`);
        audit({ ...baseAudit, decision: 'denied', reason: 'rate-limited' });
        return res.status(429).json({ ok: false, error: 'rate-limited', retryAfterMs: rl.retryAfterMs });
      }
    }

    // 7. + 8. send → audit + persist [+ voice]
    try {
      const result = await adapter.send({ target, content, replyToMessageId });
      dedup.mark(target, content);
      console.log(`[${logPrefix}] ${platform} delivered (${result.sent}/${result.total}) → ${preview(content)}`);

      audit({ ...baseAudit, decision: 'allowed', reason: isAgentExplicit ? 'reply-tool' : (trusted ? 'trusted' : 'cross-source'), delivered: true, httpStatus: result.httpStatus });
      persist({
        content, role: 'assistant', source: kind,
        conversationId: String(target),
        metadata: { channelId: String(target), origin: 'explicit-send', provenanceKind, ...(replyToMessageId != null ? { inReplyTo: String(replyToMessageId) } : {}) },
      });

      let voiceResult = null;
      if (voice && voicePipeline) {
        try { voiceResult = await voicePipeline.deliver({ target, text: content, replyToMessageId }); }
        catch (e) { console.error(`[${logPrefix}] voice pipeline threw (text delivered): ${e.message}`); }
      }

      return res.json({
        ok: true, delivered: true, sent: result.sent, total: result.total,
        ...(voiceResult ? { voiceSent: voiceResult.voiceSent, voiceTotal: voiceResult.voiceTotal } : {}),
      });
    } catch (err) {
      const httpStatus = err?.httpStatus ?? 502;
      const partial = !!err?.partial;
      console.error(`[${logPrefix}] ${platform} send ${partial ? 'PARTIAL' : 'FAILED'} (status ${httpStatus}) → ${preview(content)}`);
      audit({ ...baseAudit, decision: 'allowed', reason: `apicall-failed:${partial ? 'partial' : (err?.message?.slice(0, 60) || 'unknown')}`, delivered: partial, httpStatus });
      if (partial) {
        dedup.mark(target, content);
        persist({ content, role: 'assistant', source: kind, conversationId: String(target), metadata: { channelId: String(target), origin: 'explicit-send', partial: true } });
      }
      return res.status(partial ? 207 : (httpStatus >= 400 ? httpStatus : 502)).json({ ok: false, error: partial ? 'partial-delivery' : 'send-failed', sent: err?.sent ?? 0 });
    }
  };
}
