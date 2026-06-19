// src/db/reflections.js — the per-cycle reflection record ("day card") DAL (Context Engine).
//
// A dated, queryable digest of each cycle's reflective read — for categorizing days + tracing
// red threads. summary/themes/day_type/body are encrypted at rest (ENCRYPTED_FIELDS.
// reflection_records); cycle/day are plaintext keys. The d1 adapter encrypts on write +
// decrypts on read, so the DAL passes/receives plaintext (themes is a JSON array string).
const CYCLES = new Set(['morning', 'reflection', 'evening', 'triage', 'integration', 'weekly', 'adhoc']);

export function createReflectionsNamespace(deps) {
  if (!deps) throw new TypeError('createReflectionsNamespace: deps required');
  const { d1Query, randomUUID, now } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createReflectionsNamespace: d1Query required');
  if (typeof randomUUID !== 'function') throw new TypeError('createReflectionsNamespace: randomUUID required');
  const iso = typeof now === 'function' ? now : () => new Date().toISOString();
  const rows = (res) => (Array.isArray(res) ? res : res?.results || []);

  function toRecord(r) {
    if (!r) return null;
    let themes = [];
    try { themes = r.themes ? JSON.parse(r.themes) : []; } catch { themes = []; }
    return { id: r.id, cycle: r.cycle, day: r.day, summary: r.summary || '', themes, dayType: r.day_type || null, body: r.body || null, createdAt: r.created_at };
  }

  return {
    /** Insert a reflection record. content cols (summary/themes/day_type/body) auto-encrypt. */
    async record(userId, { cycle, day, summary, themes, dayType = null, body = null, scope = 'personal' } = {}) {
      const id = randomUUID();
      const c = CYCLES.has(cycle) ? cycle : 'adhoc';
      const d = (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) ? day : iso().slice(0, 10);
      const t = Array.isArray(themes) && themes.length ? JSON.stringify(themes) : null;
      await d1Query(
        `INSERT INTO reflection_records (id, user_id, cycle, day, summary, themes, day_type, body, scope, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [id, userId, c, d, summary ?? null, t, dayType ?? null, body ?? null, scope, iso()],
      );
      return id;
    },

    /** Recent records, newest first — the look-back feed. */
    async recent(userId, { limit = 30 } = {}) {
      const res = await d1Query(
        `SELECT * FROM reflection_records WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
        [userId, Math.min(Math.max(Number(limit) || 30, 1), 500)],
      );
      return rows(res).map(toRecord);
    },

    /** Records across a day range (inclusive) — for the timeline / red-thread trace. */
    async listRange(userId, { start, end, limit = 365 } = {}) {
      const res = await d1Query(
        `SELECT * FROM reflection_records
           WHERE user_id = ? AND day >= ? AND day <= ?
           ORDER BY day DESC, created_at DESC LIMIT ?`,
        [userId, String(start), String(end), Math.min(Math.max(Number(limit) || 365, 1), 2000)],
      );
      return rows(res).map(toRecord);
    },
  };
}

export default createReflectionsNamespace;
