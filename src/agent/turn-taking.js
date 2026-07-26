// src/agent/turn-taking.js — WHO GETS THE NEXT TURN, and WHO HOLDS THE FLOOR (D-063).
//
// The defect: "the bot auto-continues its own actions instead of waiting for the human to
// act — it doesn't leave room for the person to respond in time." Sweep (the agent
// turn-taking design, D-063) found no follow-up timer, no
// keep-going loop, no message-table poller and no channel echo. What it found instead was
// that the runtime had NO REPRESENTATION of either
//   (a) where a turn's trigger came from, or
//   (b) whether the agent is currently waiting for an answer it just asked for.
// Without (a) the agent's own output could arm its own next turn; without (b) a scheduled
// check-in could land on top of a question the person had not answered yet.
//
// THE INVARIANT this module owns:
//   An agent turn is triggered by an inbound human message, or by an explicit
//   user-initiated action — NEVER by the agent's own prior output. And an
//   agent-INITIATED message is never delivered while the agent is still awaiting an
//   answer it just solicited.
//
// Rule 1 (self-arming) is enforced at grant time here + at runtime via the scheduler's
// beforeToolCall guard. Rule 2 (the floor) is enforced pre-turn and again pre-deliver in
// scheduler.js — the second read closes a real race (a greeting that lands mid-turn).
//
// BOUNDARY — what is deliberately still allowed (see §3 of the design note):
//   • the onboarding intro + question (one deterministic message, human-initiated);
//   • a single logical reply spanning several messages WITHIN one human-triggered turn;
//   • mid-turn narration interleaved with tool calls;
//   • replying to a genuine user message — always. Neither rule can mute a reply.
//
// SECURITY (CLAUDE.md §1): this reads message CONTENT to decide whether the last agent
// message asked something. It returns booleans + an age and NEVER logs, echoes or stores
// any part of that content. §3 fail-closed: an unreadable floor HOLDS the delivery.

/**
 * Tools whose ONLY effect is to create a FUTURE agent turn. Granting one of these to a
 * turn that no human started is precisely the self-triggering loop D-063 describes:
 * schedule_task defaults output_target to 'chat' (src/tools/schedule-tasks.js:78) and its
 * enabled_tools may name schedule_task itself (:39) — an unbounded agent→agent chain that
 * speaks to the person on every link.
 *
 * NOT included: list_my_schedules / cancel_task (they read or REMOVE a trigger), and
 * updateCycle (chat-only, and it can only retune a cycle the human already enabled).
 */
export const SELF_ARMING_TOOLS = new Set(['schedule_task']);

/**
 * The message sources that make up the in-app conversation between this person and their
 * agent — the ONE surface where both the first-contact greeting (source 'portal-chat',
 * src/portal-chat.js:271) and the scheduler's check-ins (source 'scheduler',
 * src/server-rest.js:798) land. Channel surfaces are deliberately excluded: every channel
 * turn is human-triggered, so it needs no floor, and a group thread contains other people.
 */
export const FLOOR_SOURCES = Object.freeze(['portal-chat', 'scheduler']);

/**
 * How long an unanswered solicited question holds the floor.
 *
 * THIS BOUND IS THE ANTI-DEADLOCK DECISION, not a rounding. A person who never answers
 * must not permanently mute their agent, so the hold has a ceiling; the complaint is about
 * "room to respond in time", not about silence forever. 6h is chosen so the 12h
 * morning→evening cadence is never blocked by an unanswered morning question, while
 * anything proactive in the same sitting is. Any inbound human message releases it
 * immediately — the window is only the ceiling.
 */
export const DEFAULT_HOLD_MS = Number(process.env.MYCELIUM_AWAIT_REPLY_HOLD_MS) || 6 * 60 * 60 * 1000;

/** How many recent rows to read when resolving the floor. The read is SOURCE-FILTERED in
 *  SQL (see readFloorState), so this window can be tight: only the newest row decides. It
 *  must NOT be relied on to "absorb" interleaved rows from other surfaces — that was a
 *  fail-OPEN on a busy vault (independent review, 2026-07-26). */
const FLOOR_READ_LIMIT = 5;

/** Tolerance for clock skew when deciding that a row is dated in the FUTURE. */
const FUTURE_SKEW_MS = 60_000;

/**
 * Strip the self-arming tools unless this turn was started BY A HUMAN.
 *
 * FAIL-CLOSED: `humanTriggered` must be explicitly `true`. A caller that forgets to pass
 * it gets the safe answer (no self-arming), which is why the flag is opt-IN and not
 * opt-out — the dangerous direction must require a deliberate statement.
 *
 * @param {string[]} names            the gated tool names a turn opted into
 * @param {{humanTriggered?:boolean}} [ctx]
 * @returns {string[]} names minus the self-arming set (unchanged when human-triggered)
 */
export function filterSelfArming(names, { humanTriggered = false } = {}) {
  const list = Array.isArray(names) ? names : [];
  if (humanTriggered === true) return list;
  return list.filter((n) => !SELF_ARMING_TOOLS.has(n));
}

/**
 * Layer 2 for Rule 1: a runtime per-call deny predicate for AUTONOMOUS surfaces, shaped
 * for createAgentHooks({ toolGuard }) (src/agent/hooks.js:99-104) — return a string reason
 * to BLOCK, falsy to allow. Composes with an existing guard (e.g. the
 * MYCELIUM_AUTONOMOUS_TOOL_DENY env denylist) instead of replacing it.
 *
 * Always returns a function, so the scheduler always has this layer wired — unlike
 * autonomousToolGuard(), which returns undefined when its env var is unset (hooks.js:85).
 *
 * @param {((name:string,args?:object,surface?:string)=>(string|boolean))} [next] delegate
 * @returns {(name:string,args?:object,surface?:string)=>(string|false)}
 */
export function selfArmingDenyGuard(next) {
  return (name, args, surface) => {
    if (SELF_ARMING_TOOLS.has(name)) {
      return `tool '${name}' cannot be used by a turn no human started (turn-taking: no self-arming)`;
    }
    if (typeof next === 'function') {
      let verdict;
      try { verdict = next(name, args, surface); }
      catch { return 'guard-error'; }   // a throwing delegate fails CLOSED, like hooks.js:120
      if (verdict) return typeof verdict === 'string' ? verdict : 'blocked-by-policy';
    }
    return false;
  };
}

/**
 * Does this text end by asking the person something?
 *
 * Narrow ON PURPOSE. A false negative fails toward TODAY'S behaviour (the message is
 * delivered) — never toward silence — so the conservative reading is the safe one. Looks
 * only at the last non-empty line, with trailing markdown/quote/bracket noise stripped, so
 * `**…who are you?**` and `…who are you?"` both count while a question buried mid-message
 * followed by a conclusion does not.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function endsWithQuestion(text) {
  const t = typeof text === 'string' ? text : '';
  if (!t.trim()) return false;
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const stripped = last.replace(/[*_~`"'”’)\]\s]+$/u, '');
  return /[?？]$/.test(stripped);
}

/**
 * Who holds the floor, from a list of recent messages. PURE.
 *
 * `heldByAgent` is purely structural — the newest conversational message is the agent's and
 * no human message is newer. No string matching is involved in deciding whose turn it is;
 * endsWithQuestion only refines "did they ask something".
 *
 * @param {Array<{role?:string, source?:string, content?:string, created_at?:string}>} rows
 *        any order; newest wins (created_at is plaintext ISO-Z — migrations/0001_init.sql:25)
 * @param {{now?:number, sources?:string[]}} [opts]
 * @returns {{heldByAgent:boolean, awaitingAnswer:boolean, ageMs:number, lastRole:(string|null)}}
 */
export function floorState(rows, { now = Date.now(), sources = FLOOR_SOURCES } = {}) {
  const allow = new Set(sources);
  let latest = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !allow.has(String(r.source || ''))) continue;
    const at = Date.parse(r.created_at || '');
    if (!Number.isFinite(at)) continue;
    // ⚠️ A ROW DATED IN THE FUTURE IS NOT EVIDENCE ABOUT THE PRESENT CONVERSATION — DROP IT.
    // `created_at` is caller-supplied on several write paths, including the captureMessage
    // MCP tool, which takes role + source + createdAt from the model (src/tools/ingest.js:29-36)
    // and is in BOTH the chat grant (tool-domains.js 'messages') and the owner-DM write set.
    // Without this a single row stamped a year ahead stays "latest" forever: a real human
    // reply written now would never release the floor, and `ageMs` would never leave 0, so
    // the bounded window could not expire either — a PERMANENT MUTE of every proactive
    // message, reachable by clock skew on an import and steerable by a prompt injection
    // (independent review, 2026-07-26). Clamping the age would have fixed neither half; only
    // dropping the row restores real ordering.
    if (at > now + FUTURE_SKEW_MS) continue;
    if (!latest || at > latest.at) latest = { at, role: String(r.role || ''), content: typeof r.content === 'string' ? r.content : '' };
  }
  if (!latest) return { heldByAgent: false, awaitingAnswer: false, ageMs: Infinity, lastRole: null };
  const heldByAgent = latest.role === 'assistant';
  return {
    heldByAgent,
    awaitingAnswer: heldByAgent && endsWithQuestion(latest.content),
    ageMs: Math.max(0, now - latest.at),
    lastRole: latest.role,
  };
}

/**
 * Should an agent-INITIATED message be held right now? PURE.
 * Only ever true while a solicited answer is outstanding AND still fresh (DEFAULT_HOLD_MS).
 * @param {{awaitingAnswer?:boolean, ageMs?:number}} state
 * @param {{holdMs?:number}} [opts]
 */
export function shouldHoldProactive(state, { holdMs = DEFAULT_HOLD_MS } = {}) {
  if (!state?.awaitingAnswer) return false;
  const age = Number(state.ageMs);
  if (!Number.isFinite(age)) return false;
  return age < holdMs;
}

/**
 * Does this scheduled task's output actually reach the person? Mirrors schedulerDeliver
 * (src/server-rest.js:783): 'none' writes nothing and 'channel:*' is dropped, so neither
 * can talk over anybody. Everything else ('chat', 'conversation:<id>') is delivered.
 * @param {{output_target?:string}} task
 */
export function proactiveTargetsPerson(task) {
  const target = String(task?.output_target || 'none');
  if (target === 'none') return false;
  if (target.startsWith('channel:')) return false;
  return true;
}

/**
 * Read the live floor state from the vault. Fails SOFT here (throws are handled by the
 * caller, holdProactiveDelivery, which fails CLOSED).
 * @param {object} db      keyed db namespace (needs db.messages.selectRecent)
 * @param {string} userId
 */
export async function readFloorState(db, userId, { now = Date.now(), limit = FLOOR_READ_LIMIT } = {}) {
  const rows = await db.messages.selectRecent(userId, {
    limit,
    // Filter in SQL, not in JS. An unfiltered "newest N" is the newest N of EVERYTHING, so a
    // channel burst or an import pushes the in-app conversation out of the window and the
    // floor silently reads as free — fail-OPEN in the one function that must fail closed.
    sources: [...FLOOR_SOURCES],
    // 'all' = no scope predicate. Without it selectRecent falls back to the process-wide
    // AGENT_SCOPES allowlist (src/db/messages.js:1044-1053), so a restrictive deployment
    // would hide the person's own chat rows from the floor read and, again, fail OPEN. Turn
    // order is not a data-access question: nothing here is surfaced, returned or logged —
    // the result is three booleans and an age (CLAUDE.md §1).
    scope: 'all',
  });
  return floorState(rows, { now });
}

/**
 * THE decision a proactive sender asks: may I speak?
 *
 * @returns {Promise<{hold:boolean, status:(string|null)}>}
 *   hold=false ⇒ speak. hold=true ⇒ skip, and `status` is what to record:
 *     'skipped-awaiting-reply' — a real, observed hold (the agent asked something).
 *     'skipped-floor-unknown'  — the floor could not be read; §3 fail-closed. Kept DISTINCT
 *                                so a broken read is never mistaken for a real hold.
 */
export async function holdProactiveDelivery(db, userId, { now = Date.now(), holdMs = DEFAULT_HOLD_MS } = {}) {
  let state;
  try { state = await readFloorState(db, userId, { now }); }
  catch { return { hold: true, status: 'skipped-floor-unknown' }; }
  if (shouldHoldProactive(state, { holdMs })) return { hold: true, status: 'skipped-awaiting-reply' };
  return { hold: false, status: null };
}

export default {
  SELF_ARMING_TOOLS, FLOOR_SOURCES, DEFAULT_HOLD_MS,
  filterSelfArming, selfArmingDenyGuard, endsWithQuestion,
  floorState, shouldHoldProactive, proactiveTargetsPerson,
  readFloorState, holdProactiveDelivery,
};
