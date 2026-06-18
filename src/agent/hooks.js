// src/agent/hooks.js — lifecycle hook bus for the native agent engine (Phase 5, G1).
// Design: docs/HOOK-BUS-DESIGN-2026-06-18.md
//
// Mycelium has no event-emitter/registry; its hook idiom is dependency-injected sinks
// (onEgress/onUsage/onStall). This extends that idiom with a small typed `AgentHooks`
// bag — ONE function per event — fired at two layers:
//   • streamTurn (harness.js):        beforeToolCall (BLOCKING) + afterToolCall (observe)
//   • hydrateHistoryBlock (history.js): beforeCompaction + afterCompaction (observe)
// Default (no hooks) is byte-for-byte the prior behavior — every fire-site no-ops.
//
// SECURITY (§1/§2/§3):
//   • beforeToolCall is the FIRST runtime per-call gate (grant-time autonomyTools is an
//     orthogonal, earlier layer). It FAILS CLOSED: a throw or timeout BLOCKS the call.
//     A security gate that fails open is not a gate.
//   • Observer hooks (afterToolCall / before+afterCompaction) FAIL OPEN — they can never
//     break or stall a turn (fire-and-forget, errors swallowed), exactly like onEgress.
//   • Hook payloads carry PLAINTEXT {args, output} — a guard MUST read args to decide.
//     This is a first-party-only trust boundary: built-in hooks log tool NAMES + the
//     decision ONLY, never args/output. A hook that must serialize should redactDeep.

/**
 * @typedef {object} AgentHooks
 * @property {(e:{name:string,args:object,surface?:string})=>Promise<{block?:boolean,reason?:string}|void>|{block?:boolean,reason?:string}|void} [beforeToolCall]
 *   BLOCKING · fail-CLOSED · timed. Return `{block:true,reason}` to deny; falsy = allow.
 * @property {(e:{name:string,args:object,output:string,isError:boolean,durationMs?:number})=>void|Promise<void>} [afterToolCall]   observe · fail-OPEN
 * @property {(e:{messages:Array,contextWindow:number,maxOutputTokens:number,conversationId?:string})=>void|Promise<void>} [beforeCompaction] observe · fail-OPEN
 * @property {(e:{summary?:string,compacted:boolean,savedRatio?:number,conversationId?:string})=>void|Promise<void>} [afterCompaction] observe · fail-OPEN
 */

// Read per-call (not a module-load constant) so tests + operators can tune it live.
const hookTimeoutMs = () => Number(process.env.MYCELIUM_HOOK_TIMEOUT_MS) || 15000;

class HookTimeout extends Error {}

function withTimeout(value, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new HookTimeout('hook-timeout')), ms); });
  return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(t));
}

/**
 * Fire the BLOCKING beforeToolCall hook. FAIL-CLOSED: a throw, timeout, or any non-clean
 * result blocks. Missing hook → allow.
 * @param {AgentHooks|undefined} hooks
 * @param {{name:string,args:object,surface?:string}} evt
 * @returns {Promise<{block:boolean,reason?:string}|undefined>}  undefined = allow.
 */
export async function fireBeforeToolCall(hooks, evt) {
  const fn = hooks?.beforeToolCall;
  if (typeof fn !== 'function') return undefined;
  try {
    const res = await withTimeout(fn(evt), hookTimeoutMs());
    if (res && res.block) return { block: true, reason: typeof res.reason === 'string' ? res.reason : 'policy' };
    return undefined; // allow
  } catch (e) {
    // Fail CLOSED: a crashing or hung guard blocks, never allows.
    return { block: true, reason: e instanceof HookTimeout ? 'hook-timeout' : 'hook-error' };
  }
}

/**
 * Fire an observer hook. FAIL-OPEN, fire-and-forget. Returns a promise that NEVER rejects,
 * so the harness can ignore it (no unhandled rejection) while a test may await it.
 */
function fireObserver(fn, evt, logger, label) {
  if (typeof fn !== 'function') return Promise.resolve();
  return Promise.resolve()
    .then(() => fn(evt))
    .then(() => {}, (e) => { try { logger?.(`hook ${label} failed: ${e?.message || 'error'}`); } catch { /* noop */ } });
}

export function fireAfterToolCall(hooks, evt, logger) { return fireObserver(hooks?.afterToolCall, evt, logger, 'afterToolCall'); }
export function fireBeforeCompaction(hooks, evt, logger) { return fireObserver(hooks?.beforeCompaction, evt, logger, 'beforeCompaction'); }
export function fireAfterCompaction(hooks, evt, logger) { return fireObserver(hooks?.afterCompaction, evt, logger, 'afterCompaction'); }

/**
 * The default runtime tool guard for AUTONOMOUS surfaces: a denylist read from
 * MYCELIUM_AUTONOMOUS_TOOL_DENY (comma-separated tool names). Returns `undefined` when
 * unset/empty → no guard wired → behavior unchanged. Defense-in-depth layered UNDER the
 * grant-time autonomyTools allowlist. NOT applied to interactive chat (the user-operator).
 * @returns {((name:string)=>(string|false))|undefined}
 */
export function autonomousToolGuard() {
  const deny = new Set((process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (!deny.size) return undefined;
  return (name) => (deny.has(name) ? `tool '${name}' denied by MYCELIUM_AUTONOMOUS_TOOL_DENY` : false);
}

/**
 * Build the standard AgentHooks for a surface. Returns `undefined` when nothing is wired
 * (so the default path stays byte-for-byte unchanged). The first built-in consumer is a
 * runtime tool guard — a defense-in-depth deny predicate layered UNDER the grant-time
 * allowlist (autonomyTools). It audits NAME + decision only, never args (§1).
 *
 * @param {object} a
 * @param {object}   [a.db]        for db.audit.log (tool-guard decisions; name only)
 * @param {string}   [a.userId]
 * @param {string}   [a.source]    surface label ('scheduler'|'channel'|'narration'|'chat')
 * @param {(name:string,args:object,surface?:string)=>(boolean|string)} [a.toolGuard]
 *        runtime deny predicate — return a string reason or `true` to BLOCK; falsy = allow.
 * @returns {AgentHooks|undefined}
 */
export function createAgentHooks({ db, userId, source, toolGuard } = {}) {
  if (typeof toolGuard !== 'function') return undefined; // nothing to wire → unchanged path
  const audit = (name, decision, reason) => {
    try {
      db?.audit?.log?.({
        action: 'tool-guard',
        userId,
        resourceType: source || 'agent',
        resourceId: name, // tool name only — NEVER args (§1)
        details: { decision, reason: reason || null },
      });
    } catch { /* audit must never break the turn */ }
  };
  return {
    beforeToolCall: ({ name, args, surface }) => {
      let verdict;
      try { verdict = toolGuard(name, args, surface); }
      catch { verdict = 'guard-error'; } // a throwing guard fails CLOSED (block)
      if (verdict) {
        const reason = typeof verdict === 'string' ? verdict : 'blocked-by-policy';
        audit(name, 'blocked', reason);
        return { block: true, reason };
      }
      return undefined; // allow (allows are not audited — keep the log signal clean)
    },
  };
}

export default { fireBeforeToolCall, fireAfterToolCall, fireBeforeCompaction, fireAfterCompaction, createAgentHooks, autonomousToolGuard };
