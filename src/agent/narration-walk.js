// src/agent/narration-walk.js — the agent narration walk (Phase 2).
//
// Drives the native harness (runAgentTurn) over an ordered worklist (each realm's
// territories, then the realm) on ONE conversationId — so the harness's
// conversation_summaries accumulates the running understanding, and realm essence
// is synthesized AFTER (and from the awareness built by) its territory passes.
//
// Each turn gets the entity's Context Capsule (getEntityContext / narrate-context) as
// the userMessage and a temporally-explicit WALK LEDGER in systemExtra — "so far you
// described X (through 2026-05), Y …; now at Z, new span 2026-03→06" — so the agent's
// retained awareness is named + dated, not just free text. The agent calls
// describeEntity (gated; opted in here) to write.
//
// `runTurn` is injectable (defaults to runAgentTurn) so the walk is testable without a
// live model. Coverage-aware: a named entity with no new content is skipped (fold-not-
// replace). Never logs content (CLAUDE.md §1).
import { runAgentTurn } from './run-turn.js';
import { buildContextCapsule, renderCapsule } from '../../pipeline/lib/narrate-context.js';
import { loadMembers, getSeenIds } from '../../pipeline/lib/narrate-sample.js';

const WALK_SYSTEM = [
  'You are exploring and describing regions of the user\'s mind, one area at a time.',
  'For the current area, read its context, then call describeEntity with a 2-4 word name',
  'and a one-sentence essence that FOLDS the new period into what was already understood',
  '(keep what still holds; note what changed). Carry forward what you learned from the',
  'areas you already described — a realm\'s essence should reflect the territories within it.',
].join(' ');

const TABLE = { realm: 'realms', territory: 'territory_profiles', theme: 'semantic_themes' };
const COL = { realm: 'realm_id', territory: 'territory_id', theme: 'theme_id' };
const day = (s) => (s ? String(s).slice(0, 10) : '?');

async function territoriesOf(query, userId, realmId) {
  const rows = await query(
    `SELECT DISTINCT territory_id FROM clustering_points
      WHERE user_id = ? AND realm_id = ? AND territory_id IS NOT NULL ORDER BY territory_id`,
    [userId, realmId]).catch(() => []);
  return rows.map((r) => ({ kind: 'territory', id: r.territory_id, realm_id: realmId }));
}

/** Ordered worklist for a scope: territories THEN their realm (realm synthesizes last). */
async function buildWorklist(query, userId, scope) {
  if (scope && scope.territory_id != null) return [{ kind: 'territory', id: scope.territory_id }];
  if (scope && scope.realm_id != null) {
    return [...await territoriesOf(query, userId, scope.realm_id), { kind: 'realm', id: scope.realm_id }];
  }
  const realms = await query(
    `SELECT DISTINCT realm_id FROM clustering_points WHERE user_id = ? AND realm_id IS NOT NULL ORDER BY realm_id`,
    [userId]).catch(() => []);
  const out = [];
  for (const { realm_id } of realms) {
    out.push(...await territoriesOf(query, userId, realm_id));
    out.push({ kind: 'realm', id: realm_id });
  }
  return out;
}

async function capsuleFor(query, db, userId, item) {
  const col = COL[item.kind];
  const members = await loadMembers(query, userId, col, item.id).catch(() => []);
  const seenIds = item.kind === 'territory' ? await getSeenIds(query, userId, item.id).catch(() => new Set()) : null;
  const [stored] = await query(
    `SELECT name, essence, described_period_start, described_period_end FROM ${TABLE[item.kind]} WHERE user_id = ? AND ${col} = ?`,
    [userId, item.id]).catch(() => []);
  const capsule = await buildContextCapsule({ query, db, userId, kind: item.kind, id: item.id, members, seenIds, stored });
  return { capsule, stored: stored || null };
}

/** The temporally-explicit ledger restated each turn (named + dated provenance). */
function renderLedger(ledger, item, capsule) {
  const done = ledger.length
    ? `So far you have described: ${ledger.map((e) => `"${e.name || e.id}"${e.through ? ` (through ${day(e.through)})` : ''}`).join(', ')}.`
    : 'This is the first area in this walk.';
  const ns = capsule.temporal.newRange;
  const here = capsule.identity.name ? `"${capsule.identity.name}"` : `${item.kind} ${item.id}`;
  const now = `You are now at ${here} (${item.kind})${ns ? `; its new content spans ${day(ns.start)} → ${day(ns.end)}` : ''}.`;
  return `${done}\n${now}`;
}

/**
 * Run a narration walk.
 * @param {object} deps  { db, userId, tools, handlers, loop, fetchImpl?, signal?, runTurn? }
 * @param {object} opts  { runId, scope?: 'all'|{realm_id}|{territory_id}, onProgress?, log? }
 * @returns {Promise<{described,skipped,total,conversationId,ledger}>}
 */
export async function runNarrationWalk(deps, opts = {}) {
  const { db, userId, tools = [], handlers = {}, loop, fetchImpl, signal, runTurn = runAgentTurn } = deps;
  const { runId, scope = 'all', onProgress, log = () => {} } = opts;
  if (!runId) throw new Error('runNarrationWalk: runId required');
  const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => (Array.isArray(r) ? r : r.results || []));
  const conversationId = `narration-walk:${runId}`;

  const worklist = await buildWorklist(query, userId, scope);
  const ledger = [];
  let described = 0, skipped = 0;

  for (const item of worklist) {
    if (signal?.aborted) { log('walk aborted'); break; }
    const { capsule } = await capsuleFor(query, db, userId, item);

    // Coverage-aware skip: already named AND nothing new to fold → leave it (fold-not-replace).
    const nothingNew = !capsule.temporal.newRange || capsule.temporal.newRange.points === 0;
    if (capsule.identity.name && nothingNew) { skipped += 1; await onProgress?.({ described, skipped, total: worklist.length, item, skipped: true }); continue; }

    const userMessage = `${renderCapsule(capsule)}\n\nDescribe this ${item.kind} now: call describeEntity with {kind:"${item.kind}", id:${JSON.stringify(item.id)}, name, essence}.`;
    const systemExtra = `${WALK_SYSTEM}\n\n${renderLedger(ledger, item, capsule)}`;
    // One conversation across the whole walk → conversation_summaries accumulates the
    // running understanding; a non-empty history triggers the summarized-preamble path.
    const history = ledger.length ? [{ role: 'assistant', content: `Described ${ledger[ledger.length - 1].name || 'the prior area'}.` }] : [];

    await runTurn(
      { db, userId, tools, handlers, loop, fetchImpl, signal },
      { userMessage, systemExtra, enabledTools: ['describeEntity', 'getEntityContext'], conversationId, history, localTools: true },
    );

    // Read back what was written so the ledger carries the real name + covered span.
    const [row] = await query(
      `SELECT name, described_period_end FROM ${TABLE[item.kind]} WHERE user_id = ? AND ${COL[item.kind]} = ?`,
      [userId, item.id]).catch(() => []);
    ledger.push({ kind: item.kind, id: item.id, name: row?.name || capsule.identity.name || null, through: row?.described_period_end || capsule.temporal.newRange?.end || null });
    described += 1;
    await onProgress?.({ described, skipped, total: worklist.length, item, name: row?.name });
  }

  return { described, skipped, total: worklist.length, conversationId, ledger };
}

export default runNarrationWalk;
