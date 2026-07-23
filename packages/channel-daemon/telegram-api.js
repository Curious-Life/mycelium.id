/**
 * Thin Telegram Bot API wrapper — the ONE place that talks to api.telegram.org.
 * Phase 0 ships outbound only (sendMessage); the inbound poll/webhook listener
 * lands in Phase 1. Voice (TTS) is a Phase 3 post-send hook.
 *
 * Injectable `fetch` so the egress chokepoint can be verified deterministically
 * without network (the verify script passes a fake that records the call).
 *
 * The bot token is a secret: it is never logged, and it only ever appears in the
 * request URL to api.telegram.org over TLS.
 */
import { readFile } from 'node:fs/promises';
import { markdownToTelegramHtml, chunkMarkdown, normalizeThreadId, TELEGRAM_MAX_LEN } from './telegram-format.js';

// Bot API upload ceiling for a file sent as multipart: 50MB. We refuse a hair
// under it so a container/boundary overhead can't tip a "just legal" note over.
// (NOT the 20MB inbound getFile download limit — a separate constraint.)
export const MAX_VOICE_UPLOAD_BYTES = 48 * 1024 * 1024;

/**
 * @param {object} deps
 * @param {string} deps.botToken
 * @param {typeof fetch} [deps.fetch]
 * @param {number} [deps.timeoutMs]
 */
export function createTelegramApi({ botToken, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!botToken || typeof botToken !== 'string') throw new TypeError('createTelegramApi: botToken required');
  if (typeof fetchImpl !== 'function') throw new TypeError('createTelegramApi: fetch required');

  const base = `https://api.telegram.org/bot${botToken}`;

  return {
    /**
     * Long-poll for updates. Returns the raw `result` array from getUpdates.
     * `offset` is `last update_id + 1` (confirms + clears prior updates).
     * `timeout` is the server-side long-poll hold (seconds) — the AbortSignal
     * is set a few seconds beyond it so the hold returns naturally.
     * Throws on non-2xx / network error so the poll loop can back off.
     * @param {object} a
     * @param {number} [a.offset]
     * @param {number} [a.timeout]   long-poll seconds (default 30)
     */
    async getUpdates({ offset, timeout = 30, forceClose = false } = {}) {
      const headers = { 'Content-Type': 'application/json' };
      // After a 409 (another poller held the same token), the poller asks for a
      // FRESH TCP socket on the next call. Reusing the keep-alive socket makes
      // Telegram keep terminating the "old" getUpdates in a tight conflict loop
      // (mirrors openclaw's polling-session transport-dirty reset, issue #69787).
      if (forceClose) headers.Connection = 'close';
      const res = await fetchImpl(`${base}/getUpdates`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          timeout,
          ...(offset != null ? { offset } : {}),
          allowed_updates: ['message'],
        }),
        signal: AbortSignal.timeout((timeout + 10) * 1000),
      });
      if (!res.ok) {
        // 409 = another getUpdates is running for this bot token. Tag it so the
        // poller can surface the real cause + reset the socket (not just back off).
        const err = new Error(`telegram getUpdates http ${res.status}`);
        if (res.status === 409) err.code = 'conflict';
        throw err;
      }
      const body = await res.json();
      if (!body.ok) throw new Error(`telegram getUpdates not ok: ${body.description || 'unknown'}`);
      return Array.isArray(body.result) ? body.result : [];
    },

    /** Validate the token + identify the bot. Returns { id, username }. */
    async getMe() {
      const res = await fetchImpl(`${base}/getMe`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`telegram getMe http ${res.status}`);
      const body = await res.json();
      if (!body.ok) throw new Error('telegram getMe not ok');
      return { id: body.result?.id, username: body.result?.username };
    },

    /**
     * Download an inbound file's bytes (Bot API caps getFile at 20MB).
     * Two-step per the API: getFile(file_id) → file_path, then GET the binary
     * from the file endpoint. Returns a Buffer (MEMORY ONLY — the daemon never
     * writes media to disk; bytes go straight to the vault over loopback).
     * `maxBytes` re-checks the size the server reports (the descriptor's
     * file_size is advisory) and guards the actual body length too.
     * @param {object} a
     * @param {string} a.fileId
     * @param {number} [a.maxBytes]
     */
    async getFile({ fileId, maxBytes = 20 * 1024 * 1024 }) {
      const res = await fetchImpl(`${base}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`telegram getFile http ${res.status}`);
      const body = await res.json();
      if (!body.ok || !body.result?.file_path) throw new Error('telegram getFile not ok');
      const size = body.result.file_size;
      if (typeof size === 'number' && size > maxBytes) {
        const err = new Error('telegram file exceeds maxBytes');
        err.code = 'FILE_TOO_LARGE';
        throw err;
      }
      const dl = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${body.result.file_path}`, {
        signal: AbortSignal.timeout(timeoutMs * 6), // a 20MB body needs longer than a JSON call
      });
      if (!dl.ok) throw new Error(`telegram file download http ${dl.status}`);
      // Reject by advertised length BEFORE buffering the whole body into RAM —
      // the descriptor file_size can be absent/lying; this bounds the allocation.
      const clen = Number(dl.headers.get('content-length'));
      if (Number.isFinite(clen) && clen > maxBytes) {
        const err = new Error('telegram file exceeds maxBytes');
        err.code = 'FILE_TOO_LARGE';
        throw err;
      }
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.length > maxBytes) {
        const err = new Error('telegram file exceeds maxBytes');
        err.code = 'FILE_TOO_LARGE';
        throw err;
      }
      return buf;
    },

    /**
     * Send a text message, FORMATTED for Telegram (R2-TGFORMAT). The agent emits
     * natural markdown; the egress converter adapts it to Telegram HTML here — the
     * single send chokepoint — never via the model prompt. Each chunk is sent with
     * `parse_mode:'HTML'`; on a Telegram 400 (a construct HTML still rejects) the
     * SAME chunk is retried as the ORIGINAL plaintext, so a reply is never lost.
     *
     * `message_thread_id` (R3-TGTHREAD) routes the reply into a forum topic; it is
     * set on every chunk. Chunks bodies that expand past 4096. Resolves
     * { sent, total, httpStatus } on full or partial success; throws an Error
     * carrying { httpStatus, partial, sent } when delivery fails.
     * @param {object} a
     * @param {string|number} a.chatId
     * @param {string} a.text
     * @param {string|number} [a.replyToMessageId]
     * @param {string|number} [a.messageThreadId]   forum topic id (Bot API 6.3+)
     */
    async sendMessage({ chatId, text, replyToMessageId, messageThreadId }) {
      // Chunk the MARKDOWN first (boundary-safe, fence-balanced), then convert each
      // chunk INDEPENDENTLY so an HTML tag can never straddle two messages.
      const chunks = chunkMarkdown(text);
      const threadId = normalizeThreadId(messageThreadId);
      let sent = 0;
      let lastStatus = 0;

      const post = (body) => fetchImpl(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      for (let i = 0; i < chunks.length; i++) {
        const raw = chunks[i];
        const html = markdownToTelegramHtml(raw);
        const common = {
          chat_id: chatId,
          ...(threadId != null ? { message_thread_id: threadId } : {}),
          // reply-to only on the first chunk. `reply_parameters` is the current
          // API (Bot API 7.0+); `reply_to_message_id` is deprecated.
          ...(replyToMessageId != null && i === 0 ? { reply_parameters: { message_id: Number(replyToMessageId) } } : {}),
        };
        // Prefer formatted HTML; if the converted body somehow overflows the hard
        // cap, send the (shorter) plaintext chunk instead of a doomed 400.
        const useHtml = html && html.length <= TELEGRAM_MAX_LEN;
        let res;
        try {
          res = useHtml
            ? await post({ ...common, text: html, parse_mode: 'HTML' })
            : await post({ ...common, text: raw.slice(0, TELEGRAM_MAX_LEN) });
        } catch (e) {
          const err = new Error(`telegram sendMessage network error: ${e.message}`);
          err.httpStatus = 0; err.partial = sent > 0; err.sent = sent;
          throw err;
        }
        // Formatting rejected (400) → retry this chunk as plain text so the message
        // is never lost (mirrors reference/bots/telegram-bot.js:298).
        if (useHtml && res.status === 400) {
          try {
            res = await post({ ...common, text: raw.slice(0, TELEGRAM_MAX_LEN) });
          } catch (e) {
            const err = new Error(`telegram sendMessage network error: ${e.message}`);
            err.httpStatus = 0; err.partial = sent > 0; err.sent = sent;
            throw err;
          }
        }
        lastStatus = res.status;
        if (!res.ok) {
          const err = new Error(`telegram sendMessage http ${res.status}`);
          err.httpStatus = res.status; err.partial = sent > 0; err.sent = sent;
          throw err;
        }
        sent++;
      }
      return { sent, total: chunks.length, httpStatus: lastStatus || 200 };
    },

    /**
     * Presence signal — Telegram "typing…" chat action. Expires server-side
     * after ~5s, so callers keep it alive with an interval while a turn runs
     * (presence.js). Fire-and-forget by contract: a failed presence ping must
     * never affect a turn, so every failure path resolves false (mirrors the
     * canonical packages/core/telegram-api.js sendChatAction).
     * @param {object} a
     * @param {string|number} a.chatId
     * @param {string} [a.action]
     */
    async sendChatAction({ chatId, action = 'typing' }) {
      try {
        const res = await fetchImpl(`${base}/sendChatAction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, action }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      } catch {
        return false;
      }
    },

    /**
     * Send a voice note (OGG/OPUS). Multipart upload over fetch — no Grammy.
     * @param {object} a
     * @param {string|number} a.chatId
     * @param {string} a.filePath        path to the remuxed .ogg (from the TTS module)
     * @param {string|number} [a.replyToMessageId]
     * @param {string|number} [a.messageThreadId]   forum topic id (Bot API 6.3+)
     */
    async sendVoice({ chatId, filePath, replyToMessageId, messageThreadId }) {
      const bytes = await readFile(filePath);
      // OUTBOUND cap — a different constraint from the 20MB inbound `getFile`
      // download limit: the Bot API accepts at most 50MB per uploaded file. Refuse
      // BEFORE the upload with a code the voice pipeline can report honestly,
      // instead of burning a multi-minute POST for a guaranteed 413.
      if (bytes.length > MAX_VOICE_UPLOAD_BYTES) {
        const err = new Error(`telegram sendVoice payload too large (${bytes.length}B > ${MAX_VOICE_UPLOAD_BYTES}B)`);
        err.code = 'voice-too-large';
        throw err;
      }
      const form = new FormData();
      form.append('chat_id', String(chatId));
      // Route the voice note into the same forum topic as the turn (R3-TGTHREAD).
      const threadId = normalizeThreadId(messageThreadId);
      if (threadId != null) form.append('message_thread_id', String(threadId));
      form.append('voice', new Blob([bytes], { type: 'audio/ogg' }), 'voice.ogg');
      // reply_parameters (current API) as a JSON-encoded multipart field.
      if (replyToMessageId != null) form.append('reply_parameters', JSON.stringify({ message_id: Number(replyToMessageId) }));
      const res = await fetchImpl(`${base}/sendVoice`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs * 3), // uploads run longer than text
      });
      if (!res.ok) {
        const err = new Error(`telegram sendVoice http ${res.status}`);
        err.httpStatus = res.status;
        throw err;
      }
      return { httpStatus: res.status };
    },
  };
}
