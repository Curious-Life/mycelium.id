// src/channels/pairing-store.js — pending Telegram pairing requests, in the vault.
//
// Connection flow (design D2): when a DM arrives while no owner is bound yet, the
// daemon asks the vault to mint a short pairing CODE and replies it to the user;
// the owner then approves that code in the app, which binds OWNER_TELEGRAM_ID to
// the sender. This removes the fragile "find + paste your numeric Telegram id"
// step and its silent-failure traps.
//
// Stored as ONE JSON blob in secrets['TELEGRAM_PAIRING_PENDING'] — encrypted at
// rest like every secret (strictly better than the reference impl's plain JSON).
// Single-user, so a handful of TTL-bounded entries; no table/migration needed.
import crypto from 'node:crypto';

export const PAIRING_KEY = 'TELEGRAM_PAIRING_PENDING';
const TTL_MS = 10 * 60_000;   // a code is valid for 10 minutes
const CAP = 3;                // at most 3 pending at once (abuse bound, per design R2)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0 O 1 I

function mintCode() {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`; // e.g. ABCD-EFGH
}
const normalize = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** @param {{ db: { secrets: { get:Function, set:Function } } }} deps */
export function createPairingStore({ db }) {
  if (!db?.secrets?.get || !db?.secrets?.set) throw new TypeError('createPairingStore: db.secrets required');

  async function read(userId) {
    let list = [];
    try { const raw = await db.secrets.get(userId, PAIRING_KEY); if (raw) list = JSON.parse(raw); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    const now = Date.now();
    // Drop expired on every read (self-cleaning; no cron).
    return list.filter((r) => r && typeof r.createdAt === 'number' && now - r.createdAt < TTL_MS);
  }
  async function write(userId, list) {
    await db.secrets.set(userId, { key: PAIRING_KEY, value: JSON.stringify(list), scope: 'personal', description: 'telegram pairing (pending)' });
  }

  return {
    /**
     * Create a pending request for a sender; returns the code to show them.
     * IDEMPOTENT per sender: a sender who re-DMs while their code is still valid
     * gets the SAME code back (not a fresh one). This makes the outbound pairing
     * reply identical text, so the egress chokepoint's envelope-dedup collapses a
     * re-DM flood into one delivery — the trusted reply bypasses rate-limit, so
     * this is the flood bound (a spamming stranger can't make the bot spray).
     */
    async upsert(userId, { platform = 'telegram', senderId, senderName, chatId }) {
      if (!senderId) throw new Error('pairing upsert: senderId required');
      let list = await read(userId);                                        // read() already drops expired
      const existing = list.find((r) => String(r.senderId) === String(senderId));
      if (existing) return { code: existing.code };                         // same sender, same (still-valid) code
      if (list.length >= CAP) list = list.slice(-(CAP - 1));                // keep newest, bounded (abuse cap R2)
      const code = mintCode();
      list.push({ code, platform, senderId: String(senderId), senderName: senderName || null, chatId: String(chatId ?? senderId), createdAt: Date.now() });
      await write(userId, list);
      return { code };
    },
    /** Non-secret view for the app: code + who + when (never the raw sender id). */
    async list(userId) {
      return (await read(userId)).map(({ code, platform, senderName, createdAt }) => ({ code, platform, senderName, createdAt }));
    },
    /** Approve by code → { senderId } to bind as owner, and remove it. Null if no match/expired. */
    async approve(userId, code) {
      const want = normalize(code);
      if (!want) return null;
      const list = await read(userId);
      const match = list.find((r) => normalize(r.code) === want);
      if (!match) return null;
      await write(userId, list.filter((r) => r !== match));
      return { senderId: match.senderId };
    },
    async clear(userId) { await write(userId, []); },
    _consts: { KEY: PAIRING_KEY, TTL_MS, CAP },
  };
}
