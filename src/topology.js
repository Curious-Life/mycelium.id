/**
 * Topology formatters — pure functions turning topology row arrays into
 * Markdown fragments for the MCP tool surface.
 *
 * BUILD-NEW (V1): the canonical repo carried these alongside the topology MCP
 * tools but they were not in reference/. They are derived from the exact row
 * shapes produced by the db.topology namespace (src/db/topology.js) and the
 * topologyHelpers fetchers (src/topology/helpers.js), and consumed by
 * src/tools/topology-tools.js.
 *
 * Contract: every formatter takes an array (or D1 `{ results }` wrapper) and
 * returns a STRING. An empty/zero-row input returns '' so callers can render
 * an honest "none found" message — never throws on empty.
 */

/** Normalize either a bare array or a D1 `{ results }` wrapper to an array. */
function rows(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.results)) return data.results;
  return [];
}

function num(v, digits = 3) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : '?';
}

/** Co-firing partners: {territory_id, name, message_count, cofire_strength}. */
export function formatCoFiring(data) {
  const list = rows(data);
  if (!list.length) return '';
  return list
    .map(r => `- **${r.name || `T${r.territory_id}`}** (T${r.territory_id}) · strength ${num(r.cofire_strength)} · ${r.message_count ?? 0} msgs`)
    .join('\n');
}

/** Gaps: {territory_id, name, message_count, semantic_similarity, gap_score}. */
export function formatGaps(data) {
  const list = rows(data);
  if (!list.length) return '';
  return list
    .map(r => `- **${r.name || `T${r.territory_id}`}** (T${r.territory_id}) · similarity ${num(r.semantic_similarity)} · gap ${num(r.gap_score)} · ${r.message_count ?? 0} msgs`)
    .join('\n');
}

/** Cluster walk: {territory_id, name, message_count, depth, path_strength}. */
export function formatCluster(data) {
  const list = rows(data);
  if (!list.length) return '';
  return list
    .map(r => `- **${r.name || `T${r.territory_id}`}** (T${r.territory_id}) · depth ${r.depth ?? 1} · path ${num(r.path_strength)} · ${r.message_count ?? 0} msgs`)
    .join('\n');
}

/** Orphans: {territory_id, name, essence, message_count, connection_count}. */
export function formatOrphans(data) {
  const list = rows(data);
  if (!list.length) return '';
  return list
    .map(r => {
      const ess = r.essence ? ` — ${String(r.essence).slice(0, 120)}` : '';
      return `- **${r.name || `T${r.territory_id}`}** (T${r.territory_id}) · ${r.message_count ?? 0} msgs · ${r.connection_count ?? 0} connections${ess}`;
    })
    .join('\n');
}

/** Bridges: {territory_id, name, connection_count, connected_realms, total_cofire_strength}. */
export function formatBridges(data) {
  const list = rows(data);
  if (!list.length) return '';
  return list
    .map(r => `- **${r.name || `T${r.territory_id}`}** (T${r.territory_id}) · ${r.connection_count ?? 0} connections across ${r.connected_realms ?? 0} realms · total ${num(r.total_cofire_strength)}`)
    .join('\n');
}
