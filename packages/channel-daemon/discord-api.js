/**
 * Thin Discord REST wrapper — the egress side (sending). Raw fetch, no discord.js
 * (the library is only needed for the inbound gateway WS). Verified against the
 * Discord API v10 (depth sweep 2026-06-06):
 *   - send: POST /channels/{id}/messages  { content, message_reference }
 *   - voice: same endpoint, multipart, flags=8192 (IS_VOICE_MESSAGE) + an
 *     attachment carrying duration_secs + waveform (the proven canonical path).
 * Bot token never logged; only sent as `Authorization: Bot <token>` over TLS.
 */
const DISCORD_MAX_LEN = 2000; // per-message content cap
const FLAG_IS_VOICE_MESSAGE = 1 << 13; // 8192

export function createDiscordApi({ botToken, fetch: fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
  if (!botToken || typeof botToken !== 'string') throw new TypeError('createDiscordApi: botToken required');
  if (typeof fetchImpl !== 'function') throw new TypeError('createDiscordApi: fetch required');
  const base = 'https://discord.com/api/v10';
  const auth = { Authorization: `Bot ${botToken}` };

  function chunk(text) {
    if (text.length <= DISCORD_MAX_LEN) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > DISCORD_MAX_LEN) {
      let cut = rest.lastIndexOf('\n', DISCORD_MAX_LEN);
      if (cut < DISCORD_MAX_LEN * 0.5) cut = DISCORD_MAX_LEN;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^\n/, '');
    }
    if (rest) parts.push(rest);
    return parts;
  }

  return {
    /** Validate the token + identify the bot. Returns { id, username }. */
    async getMe() {
      const res = await fetchImpl(`${base}/users/@me`, { headers: auth, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`discord users/@me http ${res.status}`);
      const b = await res.json();
      return { id: b.id, username: b.username };
    },

    /**
     * Send a text message to a channel. Chunks over 2000 chars; reply-to (via
     * message_reference) only on the first chunk. Throws { httpStatus, partial, sent }.
     */
    async sendMessage({ channelId, content, replyToMessageId }) {
      const chunks = chunk(content);
      let sent = 0;
      let lastStatus = 0;
      for (let i = 0; i < chunks.length; i++) {
        const body = {
          content: chunks[i],
          ...(replyToMessageId != null && i === 0 ? { message_reference: { message_id: String(replyToMessageId), fail_if_not_exists: false } } : {}),
        };
        let res;
        try {
          res = await fetchImpl(`${base}/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          const err = new Error(`discord send network error: ${e.message}`);
          err.httpStatus = 0; err.partial = sent > 0; err.sent = sent; throw err;
        }
        lastStatus = res.status;
        if (!res.ok) {
          const err = new Error(`discord send http ${res.status}`);
          err.httpStatus = res.status; err.partial = sent > 0; err.sent = sent; throw err;
        }
        sent++;
      }
      return { sent, total: chunks.length, httpStatus: lastStatus || 200 };
    },

    /**
     * Send a voice message (audio note) — multipart with the IS_VOICE_MESSAGE
     * flag + an attachment carrying duration_secs + waveform. `audio` is a Buffer
     * of OGG/Opus (from synthesizeForDiscord). Throws { httpStatus } on failure.
     */
    async sendVoice({ channelId, audio, waveform, durationSecs, replyToMessageId }) {
      const payload = {
        content: '',
        flags: FLAG_IS_VOICE_MESSAGE,
        attachments: [{ id: '0', filename: 'voice.ogg', duration_secs: durationSecs, waveform }],
        ...(replyToMessageId != null ? { message_reference: { message_id: String(replyToMessageId), fail_if_not_exists: false } } : {}),
      };
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', new Blob([audio], { type: 'audio/ogg' }), 'voice.ogg');
      const res = await fetchImpl(`${base}/channels/${channelId}/messages`, {
        method: 'POST', headers: auth, body: form, signal: AbortSignal.timeout(timeoutMs * 3),
      });
      if (!res.ok) { const err = new Error(`discord sendVoice http ${res.status}`); err.httpStatus = res.status; throw err; }
      return { httpStatus: res.status };
    },
  };
}
