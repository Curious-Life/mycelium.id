/**
 * Canonical channel-id formatting — the single function the codebase
 * uses to convert `(kind, id)` to the synthetic key that round-trips
 * through `metadata.channelId` in the messages table and through the
 * explicit-send tracker in `state-machine.js`.
 *
 * Why synthetic keys for telegram only:
 *
 *   - Discord channel IDs are globally unique snowflakes. Raw id is
 *     unambiguous: `'1467949922530885881'`.
 *   - Telegram chat IDs collide between DMs and groups (positive vs
 *     negative integers, but treated separately in the persistence
 *     layer). The chat handler stores `metadata.channelId` as
 *     `telegram-group_<id>` for groups so a query for "messages in
 *     this DM" doesn't accidentally include group rows. We mirror
 *     that synthesis here so the explicit-send tracker keys match
 *     the inbound channel id stored on the row.
 *
 *   - Any other transport (whatsapp, portal) uses raw ids — same shape
 *     for inbound + outbound, no synthesis needed.
 *
 * Returns null when id is missing/empty so callers can distinguish
 * "no channel context" from "channel context is the empty string".
 *
 * @param {string|null|undefined} kind  — 'telegram' | 'telegram-group' | 'discord' | 'whatsapp' | 'portal' | …
 * @param {string|number|null|undefined} id
 * @returns {string|null}
 */
export function canonicalChannelId(kind, id) {
  if (id == null || id === '') return null;
  const idStr = String(id);
  if (!idStr.trim()) return null;
  if (kind === 'telegram' || kind === 'telegram-group') {
    return `${kind}_${idStr}`;
  }
  return idStr;
}

/**
 * Inverse: parse a canonical channel id back to its components.
 * Returns `{ kind, id }` or null if the input is malformed.
 *
 * @param {string|null|undefined} canonical
 * @returns {{ kind: string, id: string }|null}
 */
export function parseChannelId(canonical) {
  if (!canonical || typeof canonical !== 'string') return null;
  const idx = canonical.indexOf('_');
  if (idx <= 0) {
    // No prefix — discord/whatsapp/portal style raw id.
    return { kind: 'unknown', id: canonical };
  }
  const kind = canonical.slice(0, idx);
  const id = canonical.slice(idx + 1);
  if (kind === 'telegram' || kind === 'telegram-group') {
    return id ? { kind, id } : null;
  }
  return { kind: 'unknown', id: canonical };
}
