/**
 * Health namespace — Apple Health daily summaries.
 *
 * All 21 health fields are encrypted at the column level via
 * auto-encrypt (scope='personal'). d1QueryAdmin is used so the
 * decrypted read path bypasses tenant WHERE-injection (rows are
 * already keyed on user_id).
 *
 * `getSummary` pulls a range + delegates to `computeHealthSummary` (a
 * pure computation helper injected from db-d1.js).
 *
 * @typedef {object} HealthNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1QueryAdmin
 * @property {(result: any) => any} firstRow
 * @property {(row: any) => any} parseHealthRow
 * @property {(rows: any[], today: string) => any} computeHealthSummary
 * @property {() => Date} [now] — test seam for updated_at + getSummary window
 */

export function createHealthNamespace(deps) {
  if (!deps) throw new TypeError('createHealthNamespace: deps required');
  const { d1QueryAdmin, firstRow, parseHealthRow, computeHealthSummary, now = () => new Date() } = deps;
  if (typeof d1QueryAdmin !== 'function')      throw new TypeError('createHealthNamespace: d1QueryAdmin required');
  if (typeof firstRow !== 'function')          throw new TypeError('createHealthNamespace: firstRow required');
  if (typeof parseHealthRow !== 'function')    throw new TypeError('createHealthNamespace: parseHealthRow required');
  if (typeof computeHealthSummary !== 'function') throw new TypeError('createHealthNamespace: computeHealthSummary required');

  const ns = {
    async syncDays(userId, days) {
      let synced = 0;
      for (const d of days) {
        const id = `${userId}:${d.date}`;
        await d1QueryAdmin(
          `INSERT OR REPLACE INTO health_daily
           (id, user_id, date,
            sleep_duration_min, sleep_in_bed_min, sleep_efficiency,
            sleep_deep_min, sleep_rem_min, sleep_core_min, sleep_awake_min,
            sleep_start, sleep_end,
            hrv_avg, hrv_sleep_avg, resting_hr,
            steps, active_energy_kcal, workout_count, workout_minutes, workout_types,
            mindful_minutes, source, scope, updated_at)
           VALUES (?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?, 'apple_health', 'personal', ?)`,
          [
            id, userId, d.date,
            d.sleep_duration_min ?? null, d.sleep_in_bed_min ?? null, d.sleep_efficiency ?? null,
            d.sleep_deep_min ?? null, d.sleep_rem_min ?? null, d.sleep_core_min ?? null, d.sleep_awake_min ?? null,
            d.sleep_start ?? null, d.sleep_end ?? null,
            d.hrv_avg ?? null, d.hrv_sleep_avg ?? null, d.resting_hr ?? null,
            d.steps ?? null, d.active_energy_kcal ?? null, d.workout_count ?? null, d.workout_minutes ?? null,
            d.workout_types ? JSON.stringify(d.workout_types) : null,
            d.mindful_minutes ?? null,
            now().toISOString(),
          ],
        );
        synced++;
      }
      return synced;
    },

    async getDay(userId, date) {
      const result = await d1QueryAdmin(
        `SELECT * FROM health_daily WHERE user_id = ? AND date = ?`,
        [userId, date],
      );
      return parseHealthRow(firstRow(result));
    },

    async getRange(userId, from, to) {
      const result = await d1QueryAdmin(
        `SELECT * FROM health_daily WHERE user_id = ? AND date >= ? AND date <= ? ORDER BY date`,
        [userId, from, to],
      );
      return (result.results || []).map(parseHealthRow);
    },

    async getSummary(userId, days = 7) {
      const to = now().toISOString().split('T')[0];
      const from = new Date(now().getTime() - days * 86400000).toISOString().split('T')[0];
      const rows = await ns.getRange(userId, from, to);
      return computeHealthSummary(rows, to);
    },
  };

  return ns;
}
