// Best-effort RELEASE of a managed handle + its relay/DID registration on the
// control plane: challenge → signed 'release' claim → POST /v1/release. Extracted
// from the /disconnect flow (src/remote/router.js) so destroy-vault can reuse it
// (locked decision #3 — revoke server-side too). NEVER throws: a network failure
// must not block a local wipe (design: fail-open on the network).
//
// HONEST OUTCOME (QA P0.7). The return value is the ONLY signal — callers used to
// treat "did not throw" as success and reported a freed handle while it was still
// squatted on the control plane. So the shape is explicit:
//   { applicable, released, reason }
//     applicable=false → there is NOTHING to release: this vault has NO managed
//       handle (self-hosted / own-relay / direct / remote off). NOT a failure, and
//       NOT a success — render it as "no managed handle", never as "released".
//     applicable=true, released=false → a REAL failure. The name is still taken.
//     applicable=true, released=true  → the control plane hard-deleted the row.
// `reason` is always a short machine tag (never a URL, key, or claim body).
//
// APPLICABILITY IS A PROPERTY OF THE CONFIG, NOT OF OUR ABILITY TO ACT (review F1).
// The first cut classified `no-master-key` / `untrusted-control-plane` as
// applicable:false, which re-shipped the P0.7 bug in the MOST LIKELY destroy path:
// ENCRYPTION_MASTER_KEY is set only inside boot() (src/index.js), but the destroy
// route is mounted ALWAYS, pre-boot (server-rest.js) and gates on readUserMaster()
// straight from the Keychain. So a managed user factory-resetting an UNBOOTED or
// BROKEN vault — the most common reason to reset at all — saw an empty env, got
// applicable:false, and was silently told nothing while the handle stayed squatted.
// readRemoteConfig() is FILE-backed and works pre-boot, so the code always knows
// whether a managed handle exists. The rule is therefore:
//     applicable  ⟺  remoteMode === 'managed' AND publicHost is set
// Everything else is a reason we could not release an EXISTING handle ⇒ blocking.
//
// The caller may pass `masterHex` explicitly (the destroy route hands over the key
// that just passed the recovery-key gate) so the release also WORKS pre-boot
// instead of merely reporting honestly that it couldn't.
//
// RETRY: bounded, INSIDE this call, because a release claim must be signed with
// the master key — after a destroy the Keychain is gone and the claim can never
// be produced again. There is no such thing as a post-destroy retry; the only
// retry that can exist is this one, before the wipe.
//
// TIMEOUT: every fetch carries an AbortSignal (review F2). undici's default
// headers timeout is 300s, and the bounded retry runs the pair up to 3× — so on a
// BLACKHOLED network (captive portal, dropped SYN: precisely "the user is
// offline", the case this whole design exists for) an unbounded release would
// hang the destroy request for ~15 minutes with no cancel, instead of returning
// the 409 the flow depends on.

import { readRemoteConfig, remoteConfigParseState } from './config.js';
import { buildClaim } from './managed-claim.js';
// ONE derivation of handle-from-publicHost (src/identity/handle-service.js).
import { firstLabel } from '../identity/handle-service.js';

const isHttpsOrLocal = (u) => /^https:\/\//i.test(u) || /(?:127\.0\.0\.1|localhost)/.test(u);

/** Per-request network timeout. Short: this runs on the destroy critical path. */
export const RELEASE_FETCH_TIMEOUT_MS = 8000;

/** Reasons that mean "this vault has NO managed handle" rather than "release failed". */
export const NOT_APPLICABLE_REASONS = Object.freeze(['not-managed', 'no-public-host']);

/**
 * BLOCKING failures that are nonetheless deterministic — a retry cannot change
 * them, so the bounded retry short-circuits. These are still `applicable:true`
 * (a handle exists and is still taken); they just aren't worth re-dialling.
 */
const NON_RETRYABLE_REASONS = new Set(['no-master-key', 'untrusted-control-plane', 'remote-config-unreadable']);

/** One attempt. Never throws. Returns { applicable, released, reason? }. */
async function attemptRelease({ env, fetch, log, masterHex, timeoutMs }) {
  // `applicable` is decided BEFORE the try so even an unexpected throw while
  // reading config cannot downgrade a managed handle to "nothing to release".
  let applicable = true;
  try {
    const rc = readRemoteConfig({ env });
    // The master key: explicit (pre-boot destroy hands us the gated key) else the
    // env fallback boot() populates. NEVER logged.
    const master = masterHex || env.ENCRYPTION_MASTER_KEY;
    const base = String(rc.controlPlaneUrl || '').replace(/\/$/, '');

    // FAIL CLOSED on a corrupt remote.json (review round-3, FIX 2). readRemoteConfig
    // fails SOFT — a torn/truncated file parses to `{}` → remoteMode:'off' → the
    // "not-managed" verdict below → destroy proceeds with ZERO network calls and a
    // real managed handle stays squatted, silently defeating the P0.7 honesty
    // contract in a disk-corruption scenario. A file that EXISTS but does not parse
    // is NOT proof of "no managed handle" — treat it as a blocking, still-managed
    // handle. (An ABSENT file is the legitimate not-managed case and flows through.)
    if (remoteConfigParseState({ env }) === 'corrupt') {
      return { applicable: true, released: false, reason: 'remote-config-unreadable' };
    }

    // Is there a managed handle AT ALL? Only these two say "nothing to release".
    if (rc.remoteMode !== 'managed') return { applicable: false, released: false, reason: 'not-managed' };
    if (!rc.publicHost) return { applicable: false, released: false, reason: 'no-public-host' };

    // From here a handle EXISTS. Every remaining failure is a real failure —
    // the name stays taken and the caller must treat it as blocking.
    if (!master) return { applicable: true, released: false, reason: 'no-master-key' };
    if (!isHttpsOrLocal(base)) return { applicable: true, released: false, reason: 'untrusted-control-plane' };

    // ONE derivation of handle-from-publicHost (#324): firstLabel() replaces the
    // ad-hoc `.split('.')[0]` so the release claim signs the SAME handle the rest
    // of the system uses. Runs only after publicHost is confirmed present above.
    const handle = firstLabel(rc.publicHost);
    const signal = () => AbortSignal.timeout(timeoutMs);
    const chRes = await fetch(`${base}/v1/challenge`, { signal: signal() });
    if (!chRes.ok) return { applicable: true, released: false, reason: 'challenge-failed' };
    const { nonce } = await chRes.json();
    const claim = buildClaim({ action: 'release', handle, nonce, masterHex: master });
    const relRes = await fetch(`${base}/v1/release`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(claim), signal: signal(),
    });
    log('[destroy] relay handle release attempted');
    return { applicable: true, released: !!relRes.ok, reason: relRes.ok ? undefined : `release-${relRes.status}` };
  } catch (e) {
    // Fail CLOSED: applicable stays true, so the caller keeps treating the handle
    // as still taken. A timeout surfaces as its own reason so the UI can say
    // "we couldn't reach the control plane" rather than a generic failure.
    const isAbort = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return {
      applicable,
      released: false,
      reason: isAbort ? 'release-timeout' : String(e?.code || e?.message || e).slice(0, 80),
    };
  }
}

/**
 * Release the managed handle, retrying a transient failure a bounded number of
 * times. NEVER throws.
 * @param {object} [o]
 * @param {NodeJS.ProcessEnv} [o.env]
 * @param {Function} [o.fetch]
 * @param {(m:string)=>void} [o.log]
 * @param {string|null} [o.masterHex] the 64-hex master to sign the release claim.
 *        The destroy route passes the key that just cleared the recovery-key gate,
 *        so the release works PRE-BOOT (env.ENCRYPTION_MASTER_KEY is set only by
 *        boot()). Never logged, never echoed.
 * @param {number} [o.timeoutMs] per-request network timeout (default 8s)
 * @param {number} [o.attempts]  total attempts (default 3; <1 coerced to 1)
 * @param {number} [o.retryDelayMs] backoff base (default 400ms; 0 in tests)
 * @param {(ms:number)=>Promise<void>} [o.sleep] injectable delay
 * @returns {Promise<{applicable:boolean, released:boolean, reason?:string, attempts:number}>}
 */
export async function releaseManagedHandle({
  env = process.env, fetch = globalThis.fetch, log = () => {},
  masterHex = null, timeoutMs = RELEASE_FETCH_TIMEOUT_MS,
  attempts = 3, retryDelayMs = 400,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const max = Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1;
  let last = { applicable: true, released: false, reason: 'not-attempted' };
  for (let i = 1; i <= max; i += 1) {
    last = await attemptRelease({ env, fetch, log, masterHex, timeoutMs });
    // Done on success, on "nothing to release", and on a DETERMINISTIC config
    // verdict — retrying any of those just burns the budget (and, on the destroy
    // critical path, the user's time). Only transient/network failures retry.
    if (last.released || !last.applicable || NON_RETRYABLE_REASONS.has(last.reason)) {
      return { ...last, attempts: i };
    }
    if (i < max && retryDelayMs > 0) await sleep(retryDelayMs * i);
  }
  return { ...last, attempts: max };
}
