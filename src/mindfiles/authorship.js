/**
 * Authorship provenance for mind files — the V12 guardrail (design §5.6).
 *
 * The agent may rewrite self.md UNPROMPTED overnight (integration cycle Phase
 * 3.6). Without provenance the operator can't tell "I wrote this" from "the agent
 * rewrote who it is while I slept" — that is drift, not a feature. This records
 * WHO last wrote each mind file so the character page can show authorship.
 *
 * ── SECURITY (the load-bearing property) ────────────────────────────────────
 * The author is derived from the ENTRY POINT, never from a tool/HTTP payload:
 * the agent tool-path hardcodes 'agent'; the operator character-page REST path
 * hardcodes 'operator'. An agent CANNOT claim it was the operator — there is no
 * author argument it can set. recordWrite() REFUSES an unknown author
 * (fail-closed) so a future caller that forgets attribution cannot silently
 * create unattributed history.
 *
 * Stored as an encrypted sidecar (mind/.authorship.json) through writeMindFile —
 * the same AES-256-GCM at-rest envelope as every other mind file, so provenance
 * is never plaintext on disk. It is not a .md, so it stays invisible to
 * listSnapshots and the per-turn context loader.
 *
 * ⚠️ The sidecar is a DOTFILE and the agent tool layer (src/tools/internal.js)
 * refuses dotfile writes — so the agent cannot overwrite provenance through its
 * ordinary writeMindFileWhole/editMindFile tools (adversarial-review Finding 1,
 * 2026-07-18: the module-internal self-exclusion below was NOT enough; the write
 * path the agent controls needed the guard). This module reaches the primitive
 * directly, so it can still maintain the sidecar.
 *
 * Each entry also carries a HASH of the content it attributes. The character page
 * compares it to the live self.md so silent staleness (a content write whose
 * provenance write failed — Finding 2) is DETECTABLE, never a silent wrong claim.
 */
import { createHash } from 'node:crypto';

// Dotfile ⇒ reserved: the agent tool layer rejects dotfile writes, closing the
// provenance-forgery path. Keep the leading '.'.
const SIDECAR = '.authorship.json';
export const MIND_AUTHORS = Object.freeze(['agent', 'operator']);
const AUTHOR_SET = new Set(MIND_AUTHORS);

/** Stable content fingerprint for staleness detection (not a security boundary). */
export function contentHash(content) {
  return createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex');
}

/**
 * @param {object} deps
 * @param {(filename: string) => Promise<string|null>} deps.readMindFile
 * @param {(filename: string, content: string) => Promise<void>} deps.writeMindFile
 * @param {() => string} [deps.now]  injectable clock (ISO string); defaults to wall clock
 */
export function createAuthorship(deps) {
  if (!deps) throw new TypeError('createAuthorship: deps required');
  const { readMindFile, writeMindFile } = deps;
  if (typeof readMindFile !== 'function')  throw new TypeError('createAuthorship: readMindFile required');
  if (typeof writeMindFile !== 'function') throw new TypeError('createAuthorship: writeMindFile required');
  const clock = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();

  async function readAll() {
    const raw = await readMindFile(SIDECAR).catch(() => null);
    if (!raw) return {};
    try {
      const o = JSON.parse(raw);
      return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch {
      return {}; // corrupt sidecar → treat as empty, never throw into the write path
    }
  }

  /**
   * Record that `author` wrote `filename`. Best-effort caller contract: callers
   * wrap this so a sidecar hiccup never blocks the real write. Throws ONLY on a
   * programming error (unknown author) — that is a fail-closed refusal, not an
   * I/O failure, and must surface in tests.
   */
  async function recordWrite(filename, author, content) {
    const name = String(filename || '').trim();
    if (!name || name === SIDECAR) return;      // never attribute the sidecar itself
    if (!AUTHOR_SET.has(author)) {
      throw new Error(`authorship: refusing unknown author "${author}" (fail-closed)`);
    }
    const all = await readAll();
    all[name] = { author, at: clock(), hash: content != null ? contentHash(content) : null };
    await writeMindFile(SIDECAR, JSON.stringify(all, null, 2));
  }

  /**
   * @returns {Promise<{author:'agent'|'operator', at:string|null, hash:string|null}|null>}
   * `hash` is the fingerprint of the content this attribution was recorded for —
   * a caller that has the live content can detect staleness (hash mismatch).
   */
  async function getAuthorship(filename) {
    const name = String(filename || '').trim();
    if (!name || name === SIDECAR) return null;
    const all = await readAll();
    const e = all[name];
    return (e && AUTHOR_SET.has(e.author)) ? { author: e.author, at: e.at || null, hash: e.hash || null } : null;
  }

  return { recordWrite, getAuthorship, SIDECAR };
}
