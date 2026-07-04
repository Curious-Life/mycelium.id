// Best-effort RELEASE of a managed handle + its relay/DID registration on the
// control plane: challenge → signed 'release' claim → POST /v1/release. Extracted
// from the /disconnect flow (src/remote/router.js) so destroy-vault can reuse it
// (locked decision #3 — revoke server-side too). NEVER throws: a network failure
// must not block a local wipe (design: fail-open on the network). Returns
// {released, reason?}. Injectable fetch for tests.

import { readRemoteConfig } from './config.js';
import { buildClaim } from './managed-claim.js';

const isHttpsOrLocal = (u) => /^https:\/\//i.test(u) || /(?:127\.0\.0\.1|localhost)/.test(u);

export async function releaseManagedHandle({ env = process.env, fetch = globalThis.fetch, log = () => {} } = {}) {
  try {
    const rc = readRemoteConfig({ env });
    const masterHex = env.ENCRYPTION_MASTER_KEY;
    const base = String(rc.controlPlaneUrl || '').replace(/\/$/, '');
    // Only a MANAGED handle has something to release, and only over a trusted base.
    if (rc.remoteMode !== 'managed' || !rc.publicHost || !masterHex || !isHttpsOrLocal(base)) {
      return { released: false, reason: 'not-managed-or-unconfigured' };
    }
    const handle = rc.publicHost.split('.')[0];
    const chRes = await fetch(`${base}/v1/challenge`);
    if (!chRes.ok) return { released: false, reason: 'challenge-failed' };
    const { nonce } = await chRes.json();
    const claim = buildClaim({ action: 'release', handle, nonce, masterHex });
    const relRes = await fetch(`${base}/v1/release`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim),
    });
    log('[destroy] relay handle release attempted');
    return { released: !!relRes.ok, reason: relRes.ok ? undefined : `release-${relRes.status}` };
  } catch (e) {
    return { released: false, reason: String(e?.code || e?.message || e).slice(0, 80) };
  }
}
