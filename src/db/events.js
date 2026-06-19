/**
 * Events namespace — append-only agent_events stream.
 *
 * Fire-and-forget insertion only. The caller never awaits and errors
 * are swallowed with a .catch — event loss is preferable to blocking
 * the hot path.
 *
 * @typedef {object} EventsNamespaceDeps
 * @property {(sql: string, params: any[]) => Promise<any>} d1Query
 */

export function createEventsNamespace(deps) {
  if (!deps) throw new TypeError('createEventsNamespace: deps required');
  const { d1Query } = deps;
  if (typeof d1Query !== 'function') {
    throw new TypeError('createEventsNamespace: d1Query required');
  }

  return {
    insert(event) {
      const cols = Object.keys(event).join(', ');
      const placeholders = Object.keys(event).map(() => '?').join(', ');
      d1Query(
        `INSERT INTO agent_events (${cols}) VALUES (${placeholders})`,
        Object.values(event),
      ).catch(() => {});
    },
  };
}
