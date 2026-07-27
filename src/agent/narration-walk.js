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
  'You are exploring the regions of the user\'s mind, one area at a time, deciding for each',
  'whether its description needs to change. Read the area\'s context. If the new content',
  'meaningfully changes your understanding, call describeEntity with a 2-4 word name and a',
  'one-sentence essence that FOLDS the new period into what was already understood (keep what',
  'still holds; note what changed). If the new content does NOT change the picture, do not',
  'call describeEntity — just reflect and move on, leaving the description as it is. Carry',
  'forward what you learn — a realm\'s essence should reflect the territories within it.',
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
 * @returns {Promise<{described,reflected,skipped,failed,total,conversationId,ledger}>}
 *   `failed` = turns that produced nothing (errored, or refused by §4g). NEVER folded into
 *   `reflected` — that conflation made a run where nothing ran report success.
 */
export async function runNarrationWalk(deps, opts = {}) {
  const { db, userId, tools = [], handlers = {}, loop, fetchImpl, signal, runTurn = runAgentTurn, hooks } = deps;
  const { runId, scope = 'all', onProgress, log = () => {}, skipIds = null, shouldStop = null } = opts;
  if (!runId) throw new Error('runNarrationWalk: runId required');
  const query = (sql, p = []) => db.rawQuery(sql, p).then((r) => (Array.isArray(r) ? r : r.results || []));
  const conversationId = `narration-walk:${runId}`;
  const done = skipIds instanceof Set ? skipIds : new Set(Array.isArray(skipIds) ? skipIds : []);
  const keyOf = (item) => `${item.kind}:${item.id}`;

  const worklist = await buildWorklist(query, userId, scope);
  const ledger = [];
  let described = 0, reflected = 0, skipped = 0, failed = 0;
  let stopped = false;

  for (const item of worklist) {
    if (signal?.aborted) { log('walk aborted'); stopped = true; break; }
    // Pause/cancel: stop cleanly BEFORE the next entity (never mid-write). The job
    // flips narration_runs.status; shouldStop() reads it. done_ids is the checkpoint.
    if (typeof shouldStop === 'function' && await shouldStop()) { log('walk paused/canceled'); stopped = true; break; }
    if (done.has(keyOf(item))) { continue; } // resume: already completed in a prior segment
    const { capsule } = await capsuleFor(query, db, userId, item);

    // Coverage-aware skip: already named AND nothing new to fold → leave it (fold-not-replace).
    const nothingNew = !capsule.temporal.newRange || capsule.temporal.newRange.points === 0;
    if (capsule.identity.name && nothingNew) { skipped += 1; done.add(keyOf(item)); await onProgress?.({ described, reflected, skipped, failed, total: worklist.length, item, doneKey: keyOf(item), skipped: true }); continue; }

    const userMessage = `${renderCapsule(capsule)}\n\nConsider this ${item.kind}. If its description should change, call describeEntity with {kind:"${item.kind}", id:${JSON.stringify(item.id)}, name, essence}. If nothing new is worth adding, leave it unchanged and say so briefly.`;
    const systemExtra = `${WALK_SYSTEM}\n\n${renderLedger(ledger, item, capsule)}`;
    // One conversation across the whole walk → conversation_summaries accumulates the
    // running understanding; a non-empty history triggers the summarized-preamble path.
    const history = ledger.length ? [{ role: 'assistant', content: `Described ${ledger[ledger.length - 1].name || 'the prior area'}.` }] : [];

    const res = await runTurn(
      { db, userId, tools, handlers, loop, fetchImpl, signal, hooks },
      // inferenceTask:'narrate' — honor the user's per-task model choice for narration
      // (Settings → Intelligence → Narration). Without it, run-turn defaults to 'harness'
      // and narration silently ignored the narrate assignment.
      // writeTrusted: describeEntity is a vault write (it sets name/essence + the chronicle), and
      // the grant now requires an explicit answer. TRUE here is legitimate and narrow: the
      // enabledTools above are an in-repo literal, not model output, so nothing the model says
      // can widen this turn's capability.
      { userMessage, systemExtra, enabledTools: ['describeEntity', 'getEntityContext'], conversationId, history, localTools: true, inferenceTask: 'narrate', writeTrusted: true },
    );
    // Did the agent actually write, or reflect-and-leave? (toolsUsed from the turn.)
    const wrote = Array.isArray(res?.toolsUsed) && res.toolsUsed.includes('describeEntity');

    // ── Where did this turn's content GO? (the NarrateControl sovereignty badge) ──────
    // Reported for every turn that DIALLED A WIRE — including a FAILED one. loop.js keeps
    // text that streamed before an error, and an error can land mid-request: the prompt was
    // already sent. So "the turn failed" does NOT mean "nothing left the machine", and
    // reporting this only on the success path would under-count egress on exactly the flaky
    // runs where a cloud fallback is most likely.
    // `skipped` is the one case where NO wire ran (§4g refusal / no model) — nothing to say.
    const wire = res?.skipped ? null : {
      wireRan: true,
      // true | false | null(unknown — see loop.js actualOnThisDevice). Never defaulted.
      onThisDevice: res?.actualOnThisDevice ?? null,
      wireJurisdiction: res?.actualJurisdiction ?? null,
    };

    // ⚠️ A TURN THAT PRODUCED NOTHING IS NOT A REFLECTION.
    //
    // `if (wrote) described++; else reflected++` (below) cannot tell "the agent read this area
    // and chose not to rewrite it" — a real, valuable outcome — from "the turn never happened".
    // So a run in which NOTHING ran reported SUCCESS. Three review rounds hit this; the first
    // two fixes only changed its SHAPE:
    //     {skipped:'no-model'} → {text:''} → {text:'', lastErr:'Ollama unreachable'}
    // …each still counted as a reflection.
    //
    // THE MISTAKE, twice: keying on WHETHER A MODEL WAS CONFIGURED. `loop.run` NEVER THROWS
    // (loop.js) — it swallows the failure into `lastErr` and returns `{text:''}` — so an
    // APPROVED-but-unreachable model (Ollama not running: the NORMAL state of a fresh box)
    // sailed straight past a `res.skipped` check. Key on what the turn PRODUCED. The signal
    // was already on the return value and was being discarded (independent review, 2026-07-16,
    // reproduced against the real loop).
    //
    // Three honest outcomes, and they must not share a bucket:
    //   described — it wrote
    //   reflected — it answered and chose not to write   ← only with actual text
    //   failed    — it produced nothing / errored / was refused (§4g)
    // `skipped` stays what it already meant: the coverage-aware "nothing new to say" above.
    const said = typeof res?.text === 'string' && res.text.trim() !== '';
    const producedNothing = !wrote && !said;
    // ⚠️ NOT `|| res.lastErr`. A first draft tested it FIRST, and that over-corrected into the
    // MIRROR of the bug: loop.js DELIBERATELY keeps text that streamed before an error ("Once
    // any text streams, keep it — no retry"), so a mid-stream ECONNRESET returns a REAL
    // description alongside lastErr — and a turn that already called describeEntity has
    // COMMITTED ITS WRITE. Both were being counted failed ⇒ a flaky wire made a walk that
    // narrated everything report `error`, and withheld the checkpoint so the resume re-did
    // finished work. A false error is not better than a false success.
    // It was also REDUNDANT: a dead wire returns `{text:'', toolsUsed:[]}`, which
    // `producedNothing` already catches. When the review removed the clause NOTHING went red —
    // which is how we knew nothing pinned it. That is no longer the case: W9/W10 in
    // verify:narration-walk now fail if you add it back, which is the whole point of writing
    // them (independent review, 2026-07-16).
    // Trust loop.js's own judgment: it decided this turn produced something.
    if (res?.skipped || producedNothing) {
      const why = res?.skipped || (res?.lastErr ? 'turn-failed' : 'produced-nothing');
      failed += 1;
      // NOT done.add(): a turn that never ran must stay on the worklist, or the resume
      // checkpoint (jobs.js done_ids) records it as handled and the retry skips it forever.
      ledger.push({ kind: item.kind, id: item.id, name: capsule.identity.name || null, through: null, changed: false, failed: why });
      await onProgress?.({ described, reflected, skipped, failed, total: worklist.length, item, doneKey: null, failedReason: why, ...wire });
      continue;
    }

    // Read back the current state so the ledger carries the real name + covered span
    // (whether it changed or not — awareness still accrues for the next turn).
    const [row] = await query(
      `SELECT name, described_period_end FROM ${TABLE[item.kind]} WHERE user_id = ? AND ${COL[item.kind]} = ?`,
      [userId, item.id]).catch(() => []);
    ledger.push({ kind: item.kind, id: item.id, name: row?.name || capsule.identity.name || null, through: row?.described_period_end || capsule.temporal.newRange?.end || null, changed: wrote });
    if (wrote) described += 1; else reflected += 1;
    done.add(keyOf(item));
    await onProgress?.({ described, reflected, skipped, failed, total: worklist.length, item, name: row?.name, changed: wrote, doneKey: keyOf(item), ...wire });
  }

  return { described, reflected, skipped, failed, total: worklist.length, conversationId, ledger, stopped, doneKeys: [...done] };
}

export default runNarrationWalk;
