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

const TELEGRAM_MAX_LEN = 4096; // Telegram hard cap per message.

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

  /** Split a long body on paragraph/line boundaries so each chunk ≤ 4096. */
  function chunk(text) {
    if (text.length <= TELEGRAM_MAX_LEN) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > TELEGRAM_MAX_LEN) {
      let cut = rest.lastIndexOf('\n', TELEGRAM_MAX_LEN);
      if (cut < TELEGRAM_MAX_LEN * 0.5) cut = TELEGRAM_MAX_LEN; // no good boundary → hard cut
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest) parts.push(rest);
    return parts;
  }

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
    async getUpdates({ offset, timeout = 30 } = {}) {
      const res = await fetchImpl(`${base}/getUpdates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeout,
          ...(offset != null ? { offset } : {}),
          allowed_updates: ['message'],
        }),
        signal: AbortSignal.timeout((timeout + 10) * 1000),
      });
      if (!res.ok) throw new Error(`telegram getUpdates http ${res.status}`);
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
      const buf = Buffer.from(await dl.arrayBuffer());
      if (buf.length > maxBytes) {
        const err = new Error('telegram file exceeds maxBytes');
        err.code = 'FILE_TOO_LARGE';
        throw err;
      }
      return buf;
    },

    /**
     * Send a text message. Chunks bodies over 4096 chars. Resolves
     * { sent, total, httpStatus } on full or partial success; throws an Error
     * carrying { httpStatus, partial, sent } when delivery fails.
     * @param {object} a
     * @param {string|number} a.chatId
     * @param {string} a.text
     * @param {string|number} [a.replyToMessageId]
     */
    async sendMessage({ chatId, text, replyToMessageId }) {
      const chunks = chunk(text);
      let sent = 0;
      let lastStatus = 0;
      for (let i = 0; i < chunks.length; i++) {
        const body = {
          chat_id: chatId,
          text: chunks[i],
          // reply-to only on the first chunk. `reply_parameters` is the current
          // API (Bot API 7.0+); `reply_to_message_id` is deprecated.
          ...(replyToMessageId != null && i === 0 ? { reply_parameters: { message_id: Number(replyToMessageId) } } : {}),
        };
        let res;
        try {
          res = await fetchImpl(`${base}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          const err = new Error(`telegram sendMessage network error: ${e.message}`);
          err.httpStatus = 0; err.partial = sent > 0; err.sent = sent;
          throw err;
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
     * Send a voice note (OGG/OPUS). Multipart upload over fetch — no Grammy.
     * @param {object} a
     * @param {string|number} a.chatId
     * @param {string} a.filePath        path to the remuxed .ogg (from the TTS module)
     * @param {string|number} [a.replyToMessageId]
     */
    async sendVoice({ chatId, filePath, replyToMessageId }) {
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append('chat_id', String(chatId));
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
