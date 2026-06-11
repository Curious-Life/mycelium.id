/**
 * Inbound handler (Phase 1) — what happens when a normalized Telegram message
 * arrives. The poller calls this once per message.
 *
 * Pipeline:
 *   0. commands — an owner `/command` (e.g. /allow) is handled as control-plane
 *      and never captured or turned. Non-owner commands are swallowed.
 *   1. authorize — owner DM, or an authorized group (Phase 3 group binding).
 *      Fail-closed: anything else is dropped (logged, not delivered, not captured).
 *   2. captureMessage — funnel the inbound through the vault's built choke-point
 *      over REST (auto-encrypted at rest, id-deduped). id = tg-<msgId>-<chatId>
 *      so a getUpdates replay is idempotent.
 *   3. runTurn(turnCtx, msg) — the agent turn. Phase 1 injects a stub that just
 *      sets the active-turn registry (so a human can exercise the egress
 *      chokepoint against a live inbound); Phase 2 replaces it with the real
 *      single-user lane: setActiveTurn → agent turn (uses the reply tool) →
 *      clearActiveTurn in finally.
 *
 * Everything is soft-fail: a capture or turn error is logged and the loop
 * continues — one bad message never stalls the poller.
 */

/** Short, length-tagged preview — never log full inbound content. */
function preview(text) {
  const s = String(text || '');
  return `«${s.slice(0, 12).replace(/\s+/g, ' ')}${s.length > 12 ? '…' : ''}»(${s.length})`;
}

/** Honest, non-leaky placeholder for media we declined to extract under load. */
function degradedMediaLine(msg) {
  const kind = msg.media?.kind || 'media';
  return `[${kind} received — skipped under load; not processed]`;
}

/**
 * @param {object} deps
 * @param {{captureMessage:(args:object)=>Promise<any>}} deps.vault
 * @param {string} deps.ownerTelegramId
 * @param {(turnCtx:object, msg:object)=>Promise<void>|void} deps.runTurn
 * @param {{isCommand:(c:string)=>boolean, handle:(msg:object)=>Promise<boolean>}} [deps.commands]
 * @param {(groupId:string)=>Promise<boolean>} [deps.isGroupAuthorized]  group binding lookup
 * @param {(msg:object)=>Promise<{attachmentId:string|null, contextLine:string}>} [deps.contextualizeMedia]
 *        media stage (media.js) — wired only when the platform supports downloads
 * @param {{start:(turnCtx:object)=>(()=>void)|null}} [deps.presence]
 *        typing indicator (presence.js) — covers the PRE-TURN phases (media
 *        download/vision/transcription + coalesce window), which for images and
 *        voice notes are the longest part; the lane's own presence covers the
 *        model turn itself. Only wired when two-way replies are on.
 * @param {{submit:(a:{fromId:any,owner:boolean,run:()=>Promise<any>})=>{accepted:boolean,reason?:string}}} [deps.mediaQueue]
 *        bounded serial worker (media-queue.js) — when wired, the minutes-long
 *        media stage is OFFLOADED so the poller is never blocked (MED-4). On a
 *        rejected submit (queue-full / rate-limited) the message DEGRADES to a
 *        placeholder, captured + turned inline — never dropped. When ABSENT the
 *        media stage runs inline (legacy/capture-only path; unit tests rely on it).
 * @param {string} [deps.logPrefix]
 */
export function createInboundHandler({ vault, ownerTelegramId, runTurn, commands, isGroupAuthorized, checkChannelAccess, contextualizeMedia, presence, mediaQueue, logPrefix = 'channel-daemon' }) {
  if (!vault?.captureMessage) throw new TypeError('createInboundHandler: vault.captureMessage required');
  if (typeof runTurn !== 'function') throw new TypeError('createInboundHandler: runTurn required');

  /** Owner DM authorization. */
  function isOwnerDM(msg) {
    if (msg.channelKind === 'telegram-group') return false;
    if (!ownerTelegramId) return false;                      // fail-closed: no owner configured
    // In a DM the chat.id equals the user id; accept either the chat or the sender.
    return String(msg.chatId) === String(ownerTelegramId) || String(msg.fromId) === String(ownerTelegramId);
  }

  async function isAuthorized(msg) {
    if (msg.channelKind === 'telegram-group') {
      // Groups: authorized iff bound via /allow (telegram_groups, fail-closed)…
      if (typeof isGroupAuthorized !== 'function') return false;
      let authorized; try { authorized = await isGroupAuthorized(msg.chatId); } catch { return false; }
      if (!authorized) return false;
      // …AND the sender passes the channel's access policy (owner|allowlist|open).
      if (typeof checkChannelAccess === 'function') {
        try { return !!(await checkChannelAccess(msg.channelKind, msg.chatId, msg.fromId)).respond; } catch { return false; }
      }
      return true; // no policy resolver wired → behave as before (open)
    }
    return isOwnerDM(msg);
  }

  /**
   * The "tail" of inbound handling: pre-turn presence → (optional) media stage →
   * capture → agent turn. Factored out of handleInbound so it can run EITHER
   * inline (text, capture-only, or the legacy no-queue media path) OR on the
   * media-queue worker (MED-4 offload) without changing what the vault stores.
   * @param {object} msg
   * @param {{extract:boolean}} opts  run the (slow) media stage before capture
   */
  async function processMessage(msg, { extract }) {
    // Typing presence for the PRE-TURN phases (DM-gated inside presence.js):
    // for an image / voice note the media stage below can run for minutes —
    // the user should see "typing…" from the moment we start processing, not
    // only once the model turn starts. Stopped in the finally; the lane starts
    // its own presence when the turn actually executes.
    let stopPresence = null;
    try {
      stopPresence = presence?.start?.({ channelKind: msg.channelKind, channelId: msg.chatId }) || null;
    } catch { /* presence must never affect inbound handling */ }

    try {
      // 1a. media stage — BEFORE capture/turn so the derived text rides
      //     msg.content (the only coalescer-safe carrier). Fail-soft by
      //     contract: contextualizeMedia never throws. (Authorization already
      //     passed in handleInbound — unauthorized media is never downloaded.)
      let attachmentId = null;
      if (extract) {
        const r = await contextualizeMedia(msg);
        attachmentId = r?.attachmentId || null;
        if (r?.contextLine) msg.content = msg.content ? `${msg.content}\n${r.contextLine}` : r.contextLine;
      }

      const senderRole = String(msg.fromId) === String(ownerTelegramId) ? 'owner' : 'other';

      // 1b. capture the inbound (idempotent on id; auto-encrypted at rest).
      try {
        await vault.captureMessage({
          id: `tg-${msg.messageId}-${msg.chatId}`,
          content: msg.content,
          role: 'user',
          source: msg.source,
          conversationId: msg.chatId,
          ...(msg.dateEpoch != null ? { createdAt: msg.dateEpoch } : {}),
          ...(attachmentId ? { attachmentId } : {}),
          metadata: {
            channelId: msg.chatId,
            sender: msg.fromName || msg.username || msg.fromId,
            senderRole,
            ...(msg.username ? { username: msg.username } : {}),
            ...(msg.chatTitle ? { chatTitle: msg.chatTitle } : {}),
            ...(msg.replyToMessageId ? { replyTo: msg.replyToMessageId } : {}),
            ...(msg.media ? { mediaKind: msg.media.kind, ...(msg.media.fileUniqueId ? { fileUniqueId: msg.media.fileUniqueId } : {}) } : {}),
          },
        });
      } catch (e) {
        console.error(`[${logPrefix}] inbound capture failed (chat=${msg.chatId}): ${e.message}`);
        // continue — still try the turn; the vault may be momentarily busy.
      }

      // 2. hand to the agent turn. turnCtx is exactly the ActiveTurnContext the
      //    egress chokepoint + reply tool resolve against.
      const turnCtx = {
        source: msg.source,
        channelKind: msg.channelKind,
        channelId: msg.chatId,
        inboundMessageId: msg.messageId,
        username: msg.username || undefined,
        userId: msg.fromId || undefined,
        voiceMode: msg.voiceMode || undefined,
      };
      try {
        await runTurn(turnCtx, msg);
      } catch (e) {
        console.error(`[${logPrefix}] inbound turn failed (chat=${msg.chatId}): ${e.message}`);
      }
    } finally {
      // Hand off to the lane's presence: runTurn enqueues and returns, so this
      // stops the pre-turn indicator; the lane re-fires it for the turn itself.
      try { stopPresence?.(); } catch { /* never throw from cleanup */ }
    }
  }

  return async function handleInbound(msg) {
    if (!msg) return;

    // 0. owner control-plane commands (/allow, /disallow, …) — handled inline,
    //    never queued, captured, or turned. So /disallow works even mid-flood.
    if (commands && msg.content && commands.isCommand(msg.content)) {
      try { if (await commands.handle(msg)) return; } catch (e) { console.error(`[${logPrefix}] command failed: ${e.message}`); return; }
    }

    // 1. authorize (fail-closed) BEFORE any download/offload — media of
    //    unauthorized chats is never fetched.
    if (!(await isAuthorized(msg))) {
      console.warn(`[${logPrefix}] inbound dropped (unauthorized ${msg.channelKind} chat=${msg.chatId}) ${preview(msg.content)}`);
      return;
    }
    const hasMedia = Boolean(msg.media && typeof contextualizeMedia === 'function');
    if (!msg.content && !hasMedia) {
      // sticker / unsupported media without caption — skip (no placeholder noise).
      console.log(`[${logPrefix}] inbound skipped (no text${msg.voiceMode ? '; voice note' : ''}) chat=${msg.chatId}`);
      return;
    }

    // 2. heavy media path (MED-4): when a media queue is wired, OFFLOAD the
    //    minutes-long media stage so handleInbound returns immediately and the
    //    poller keeps ingesting (owner DMs + commands are never stalled). On a
    //    rejected submit, DEGRADE to a placeholder — captured + turned inline,
    //    never dropped. Without a queue (capture-only / unit tests) media runs
    //    inline exactly as before.
    if (hasMedia && mediaQueue) {
      const owner = String(msg.fromId) === String(ownerTelegramId);
      const decision = mediaQueue.submit({ fromId: msg.fromId, owner, run: () => processMessage(msg, { extract: true }) });
      if (decision.accepted) return; // offloaded — worker drains in the background
      const line = degradedMediaLine(msg);
      msg.content = msg.content ? `${msg.content}\n${line}` : line;
      console.warn(`[${logPrefix}] media degraded (${decision.reason}) chat=${msg.chatId} from=${msg.fromId} — captured without extraction`);
      await processMessage(msg, { extract: false });
      return;
    }

    // 3. text, or media with no queue wired — inline (fast for text; legacy for media).
    await processMessage(msg, { extract: hasMedia });
  };
}
