// turnstile.js — Cloudflare Turnstile bot-gate for the control-plane (O2 / SEC-4).
//
// The ed25519 signature is NOT a bot barrier (a bot signs with a throwaway key —
// see ratelimit.js), so the human-proof gate is Turnstile on /v1/challenge: a
// bot can't get a nonce (and therefore can't provision) without solving it. The
// SECRET lives ONLY in the control-plane env (MYC_TURNSTILE_SECRET, the
// MYC_DNS_TOKEN pattern — never on the Mac, never in the registry, never logged);
// the public SITEKEY is embedded in the app widget. Verification is single-side:
// the widget yields a token, we siteverify it once, the resulting nonce carries
// the proof forward to /v1/provision (so we never double-verify a single-use token).
//
// OPT-IN + FAIL-CLOSED. Disabled by default (no secret, no mock) so self-hosters
// and the hermetic tests don't require Cloudflare; when enabled, a missing/bad/
// unverifiable token is rejected. Never throws.
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * @param {{ secret?:string, mock?:boolean, fetch?:Function, siteverifyUrl?:string }} opts
 * @returns {{ enabled:boolean, verify:(token:string, remoteip?:string)=>Promise<boolean> }}
 */
export function createTurnstileVerifier({ secret, mock = false, fetch: fetchImpl, siteverifyUrl = SITEVERIFY_URL } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const enabled = mock || !!secret;
  return {
    enabled,
    async verify(token, remoteip) {
      if (!enabled) return true;                          // opt-in: gate off → pass through
      if (typeof token !== 'string' || token.length === 0) return false; // fail-closed
      if (mock) return token === 'mock-pass';             // hermetic deterministic path
      try {
        const body = new URLSearchParams({ secret, response: token });
        if (remoteip) body.set('remoteip', String(remoteip));
        const res = await doFetch(siteverifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });
        const data = await res.json().catch(() => ({}));
        return data?.success === true;                    // fail-closed on any non-success
      } catch {
        return false;                                     // network/parse error → reject
      }
    },
  };
}
