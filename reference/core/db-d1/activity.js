/**
 * Activity namespace — desktop activity_sessions aggregates.
 *
 * Every query excludes `com.apple.loginwindow` (idle lock screen) and
 * agent_id defaults to 'personal-agent' if the caller omits it. All
 * reads are read-only aggregations — no writes except syncSessions.
 *
 * @typedef {object} ActivityNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

export function createActivityNamespace(deps) {
  if (!deps) throw new TypeError('createActivityNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') throw new TypeError('createActivityNamespace: d1Query required');

  return {
    async syncSessions(sessions) {
      for (const s of sessions) {
        await d1Query(
          `INSERT OR REPLACE INTO activity_sessions
           (id, agent_id, app_bundle, app_name, window_title, url, category,
            productivity, started_at, ended_at, duration_s, idle, date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            s.id, s.agent_id || 'personal-agent',
            s.app_bundle, s.app_name, s.window_title || null,
            s.url || null, s.category || 'other', s.productivity || 50,
            s.started_at, s.ended_at, s.duration_s || 0,
            s.idle || 0, s.date,
          ],
        );
      }
      return sessions.length;
    },

    async getSessions(agentId, { date, from, to, category, limit = 200 } = {}) {
      let sql = `SELECT * FROM activity_sessions WHERE agent_id = ? AND app_bundle != 'com.apple.loginwindow'`;
      const params = [agentId || 'personal-agent'];
      if (date)     { sql += ` AND date = ?`;           params.push(date); }
      if (from)     { sql += ` AND started_at >= ?`;    params.push(from); }
      if (to)       { sql += ` AND started_at <= ?`;    params.push(to); }
      if (category) { sql += ` AND category = ?`;       params.push(category); }
      sql += ` ORDER BY started_at DESC LIMIT ?`;
      params.push(limit);
      const result = await d1Query(sql, params);
      return result.results || [];
    },

    async getTopApps(agentId, { date, from, to, limit = 10 } = {}) {
      let where = `agent_id = ? AND idle = 0 AND app_bundle != 'com.apple.loginwindow'`;
      const params = [agentId || 'personal-agent'];
      if (date) { where += ` AND date = ?`;  params.push(date); }
      if (from) { where += ` AND date >= ?`; params.push(from); }
      if (to)   { where += ` AND date <= ?`; params.push(to); }
      params.push(limit);
      const result = await d1Query(
        `SELECT app_name, app_bundle, category, SUM(duration_s) as total_s, COUNT(*) as sessions
         FROM activity_sessions WHERE ${where}
         GROUP BY app_bundle ORDER BY total_s DESC LIMIT ?`,
        params,
      );
      return result.results || [];
    },

    async getTopDomains(agentId, { date, from, to, limit = 15 } = {}) {
      let where = `agent_id = ? AND idle = 0 AND app_bundle != 'com.apple.loginwindow' AND url IS NOT NULL AND url != ''`;
      const params = [agentId || 'personal-agent'];
      if (date) { where += ` AND date = ?`;  params.push(date); }
      if (from) { where += ` AND date >= ?`; params.push(from); }
      if (to)   { where += ` AND date <= ?`; params.push(to); }
      params.push(limit);
      const result = await d1Query(
        `SELECT
           REPLACE(REPLACE(
             SUBSTR(url, 1, CASE WHEN INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/') > 0
               THEN INSTR(url, '://') + 2 + INSTR(SUBSTR(url, INSTR(url, '://') + 3), '/')
               ELSE LENGTH(url) END
           ), 'https://', ''), 'http://', '') as domain,
           category, SUM(duration_s) as total_s, COUNT(*) as sessions, AVG(productivity) as productivity_avg
         FROM activity_sessions WHERE ${where}
         GROUP BY domain ORDER BY total_s DESC LIMIT ?`,
        params,
      );
      return result.results || [];
    },

    async getCategoryBreakdown(agentId, { date, from, to } = {}) {
      let where = `agent_id = ? AND app_bundle != 'com.apple.loginwindow'`;
      const params = [agentId || 'personal-agent'];
      if (date) { where += ` AND date = ?`;  params.push(date); }
      if (from) { where += ` AND date >= ?`; params.push(from); }
      if (to)   { where += ` AND date <= ?`; params.push(to); }
      const result = await d1Query(
        `SELECT category, SUM(duration_s) as total_s, COUNT(*) as sessions,
                AVG(productivity) as productivity_avg
         FROM activity_sessions WHERE ${where}
         GROUP BY category ORDER BY total_s DESC`,
        params,
      );
      return result.results || [];
    },

    async getDailySummary(agentId, { from, to } = {}) {
      let sql = `SELECT date, SUM(duration_s) as total_s, SUM(CASE WHEN idle = 0 THEN duration_s ELSE 0 END) as active_s,
                        SUM(CASE WHEN idle = 1 THEN duration_s ELSE 0 END) as idle_s,
                        AVG(CASE WHEN idle = 0 THEN productivity END) as productivity_avg,
                        COUNT(*) as sessions
                 FROM activity_sessions WHERE agent_id = ? AND app_bundle != 'com.apple.loginwindow'`;
      const params = [agentId || 'personal-agent'];
      if (from) { sql += ` AND date >= ?`; params.push(from); }
      if (to)   { sql += ` AND date <= ?`; params.push(to); }
      sql += ` GROUP BY date ORDER BY date DESC`;
      const result = await d1Query(sql, params);
      return result.results || [];
    },
  };
}
