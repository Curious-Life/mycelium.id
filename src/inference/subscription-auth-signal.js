// src/inference/subscription-auth-signal.js — is the Claude SUBSCRIPTION credential actually
// USABLE, by evidence rather than by existence — and for WHICH surface?
//
// WHY THIS EXISTS (diagnosed live, 2026-07-18): the Intelligence surface said
// "Claude subscription · connected" while the stored OAuth credential had been
// expired-beyond-refresh for FOUR DAYS — every native request 401'd, and the proactive
// refresher logged "claude token proactive refresh unavailable" on every tick. "Connected"
// was derived from stored-creds-EXIST, not from the credential WORKING. A status that cannot
// go red is not a status; it is decoration.
//
// TWO SURFACES, TWO CREDENTIAL PATHS — a single boolean is wrong for one of them
// (operator, same day: "the claude token shows as dead, but the chat still works"):
//   • 'native' — the native wire (channel turns, native chat) sends a Bearer token read from
//     the app's isolated CLAUDE_CONFIG_DIR / the stored subscription row (resolve.js). The
//     proactive refresher exercises exactly this store, so refresh outcomes are 'native'
//     evidence, alongside native-loop turn outcomes.
//   • 'cli'    — the Claude Code engine spawns `claude`, which authenticates from its OWN
//     store: the isolated dir when the seed succeeded, but the MACHINE's ~/.claude login when
//     it did not (resolve-harness.js:53-59 fail-soft: "configDir stays null → claude uses its
//     default (machine) login"). We cannot observe which store the child used, so refresh
//     outcomes must neither vouch for nor damn this surface: 'cli' validity derives from CLI
//     turn outcomes ONLY. No evidence ⇒ 'unknown', which never claims "connected".
//
// THE MODEL — evidence timestamps, nothing else:
//   • refresh outcomes  — refreshClaudeConfigDirToken (claude-config-dir.js) records every
//     REAL attempt (its cooldown short-circuit records nothing: "an attempt ran recently" is
//     not evidence about the credential).
//   • turn outcomes     — the native loop (src/agent/loop.js) for SUBSCRIPTION-backed turns
//     (providerName === 'claude_subscription'): success when the provider answered, failure
//     on classifyProviderError reason 'auth' (the loop's non-fallback 401/403 break). The CLI
//     engine (src/agent/loop-claude-cli.js) records with surface:'cli' — success on a clean
//     result, failure when stderr / an is_error result matches its auth-error envelope (the
//     SESSION_ERR_RE discipline: never matched against the model's text stream).
//
// THE DERIVATION — FAIL-CLOSED honesty (CLAUDE.md §3), per surface: 'ok' requires POSITIVE
// evidence STRICTLY NEWER than the newest failure. A tie or an absence never reads healthy:
//   no creds            → 'not_connected'
//   no evidence at all  → 'unknown'   (cold boot; the ~5s proactive boot refresh settles 'native')
//   newest ok > newest failure → 'ok'
//   otherwise           → 'needs_reconnect'
//
// ZERO TOKEN MATERIAL (§1/§4): this module stores epoch-millisecond numbers. No token, no
// error body, no account identity ever enters it. The wire surface (GET
// /portal/auth/claude/status `validity`) carries the enums only.
//
// §4g NOTE: STATUS DISPLAY only. Nothing here feeds provider selection, jurisdiction
// classification, or the sensitivity router — no derivation below has an inference-path caller.

let _lastRefreshOkAt = null;       // epoch ms — last refresh that yielded a live token
let _lastRefreshFailAt = null;     // epoch ms — last refresh attempt that could not
const _turn = {
  native: { okAt: null, failAt: null },   // native-wire subscription turns
  cli: { okAt: null, failAt: null },      // Claude Code engine turns
};

/** A refresh attempt finished. `ok` = it produced a live token. Timestamps only. */
export function recordSubscriptionRefreshOutcome(ok, now = Date.now()) {
  if (ok) _lastRefreshOkAt = now; else _lastRefreshFailAt = now;
}

/**
 * A SUBSCRIPTION-backed turn finished on `surface`. `ok` = the provider answered;
 * false = auth-rejected. Unknown surfaces are dropped rather than misfiled: evidence
 * recorded under the wrong surface would be exactly the cross-surface lie this split ends.
 */
export function recordSubscriptionTurnOutcome(ok, { surface = 'native', now = Date.now() } = {}) {
  const s = _turn[surface];
  if (!s) return;
  if (ok) s.okAt = now; else s.failAt = now;
}

/** Test seam — gates drive the matrix from a known-cold state. */
export function _resetSubscriptionAuthSignalForTests() {
  _lastRefreshOkAt = null; _lastRefreshFailAt = null;
  _turn.native.okAt = null; _turn.native.failAt = null;
  _turn.cli.okAt = null; _turn.cli.failAt = null;
}

/**
 * PURE single-surface derivation — the truth table, driveable by a gate with no module state.
 * @param {{credsPresent:boolean, okAt?:number|null, failAt?:number|null}} s
 *        okAt/failAt: the newest positive / newest failure evidence for ONE surface.
 * @returns {'not_connected'|'ok'|'needs_reconnect'|'unknown'}
 */
export function deriveSubscriptionValidity({ credsPresent, okAt = null, failAt = null } = {}) {
  if (!credsPresent) return 'not_connected';
  const ok = Number(okAt) || 0;
  const fail = Number(failAt) || 0;
  if (!ok && !fail) return 'unknown';
  // STRICTLY newer — a tie is not positive evidence that postdates the failure, and the
  // fail-closed reading of "we cannot order them" is "do not claim it works".
  if (ok > fail) return 'ok';
  return 'needs_reconnect';
}

const newest = (...ts) => Math.max(...ts.map((t) => Number(t) || 0)) || null;

/**
 * The module-state projection the status route reads: one enum per surface.
 * @returns {{native:string, cli:string}}
 */
export function getSubscriptionAuthValidity({ credsPresent } = {}) {
  const present = Boolean(credsPresent);
  return {
    // The native wire reads the isolated-dir/stored token — the store the refresher exercises.
    native: deriveSubscriptionValidity({
      credsPresent: present,
      okAt: newest(_lastRefreshOkAt, _turn.native.okAt),
      failAt: newest(_lastRefreshFailAt, _turn.native.failAt),
    }),
    // The CLI child may have authenticated from the MACHINE login (seed fail-soft), so only
    // its own turns testify here — refresh evidence deliberately excluded (header).
    cli: deriveSubscriptionValidity({
      credsPresent: present,
      okAt: _turn.cli.okAt,
      failAt: _turn.cli.failAt,
    }),
  };
}
