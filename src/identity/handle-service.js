// src/identity/handle-service.js — THE ONE WRITER of the vault's handle.
//
// WHY THIS EXISTS ("handle" used to be three concepts wearing one word):
//   (a) FEDERATION IDENTITY — the first label of remote.json's `publicHost`. This
//       is what signs (src/index.js), what WebFinger/did.json publish
//       (src/federation/handlers.js), what outbound `from_handle` carries
//       (src/db/connections.js selfHandle()), and what the control plane holds.
//   (b) PROFILE LABEL — `user_profiles.handle`, which `PUT /portal/profile` used to
//       write with a bare UPDATE that touched nothing else. Setting your handle
//       there was COSMETIC: no claim, no DNS, no did:web, no WebFinger. The Profile
//       screen then rendered `<handle>.mycelium.id` for a host that did not exist.
//   (c) THE "reach it over the internet" ADDRESS — `POST /remote/connect-managed`,
//       which wrote (a) and never told (b), so the two stores silently diverged.
//
// THE RULE NOW:
//   publicHost is the SINGLE SOURCE OF TRUTH. handle === firstLabel(publicHost).
//   `user_profiles.handle` is a DERIVED MIRROR, written only by this module, kept
//   for the existing readers (local connection resolution, public profile page).
//   Nothing else may write either store.
//
// SET-ONCE SCOPE (deliberate): claiming a handle you don't have yet is supported.
//   RENAMING an already-claimed handle is NOT — the signing identity is bound to
//   did:web:<publicHost> at boot and every peer that has connected stored that DID.
//   A rename needs a DID-rotation migration (announce + re-key + peer re-pin) that
//   is deferred pending an operator decision. setHandle() refuses it LOUDLY rather
//   than shipping a half-rename that orphans every existing connection.
//
// RESTART: the signing identity is built once at boot (src/index.js:104-108), so a
//   successful claim returns `restartRequired: true`. We say so honestly rather
//   than pretending the new identity is live.

import {
  readRemoteConfig, writeRemoteConfig, setRemoteSecret,
  isSafeHostname, operatorUserExists,
} from '../remote/config.js';
import { buildClaim } from '../remote/managed-claim.js';
import { materializeRemoteConfigs } from '../remote/runtime.js';
import { dataDir } from '../paths.js';
import { isValidHandle } from './identity.js';

/** The ONE reserved-handle list. Collapses the two divergent lists that used to
 *  live at portal-compat.js (13 names) and db/profiles.js (25 names) — their
 *  UNION, so neither surface got looser. Keep in sync with the control plane's
 *  own reservations (it is the final authority; this is fast-fail + defence in
 *  depth). Names that would shadow a portal route or a system subdomain. */
export const RESERVED_HANDLES = new Set([
  // subdomain-conflicting
  'www', 'cdn', 'api', 'admin', 'app', 'mycelium', 'status', 'docs',
  'share', 'mail', 'static', 'public', 'auth', 'id', 'well-known',
  // portal-route conflicting
  'support', 'system', 'vault', 'login', 'signup', 'profile',
  'settings', 'help', 'about', 'discover', 'connections',
]);

export const HANDLE_HINT = '2–32 chars: a–z, 0–9, and dashes (no leading/trailing dash)';

/** Typed error so both HTTP surfaces map failures identically (no bespoke strings). */
export class HandleError extends Error {
  constructor(message, { code = 'invalid_handle', status = 400, extra = {} } = {}) {
    super(message);
    this.name = 'HandleError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

export const normalizeHandle = (raw) => String(raw ?? '').trim().toLowerCase();

/** The first DNS label of a host — the ONE derivation of handle-from-publicHost.
 *  Every caller must use this rather than re-splitting on '.' locally.
 *
 *  DELIBERATELY LITERAL — it does NOT fold case. publicHost is canonicalized to
 *  lowercase at its single write point (remote/config.js writeRemoteConfig), so a
 *  host that is still mixed-case is one this build never wrote: a hand-edited or
 *  legacy remote.json. Folding case HERE would hand such a vault a valid federation
 *  handle it never had before — booting a signing identity and serving did.json for
 *  a config that previously fail-closed. Non-canonical in ⇒ label that fails
 *  isValidHandle ⇒ currentHandle() null ⇒ federation stays closed (CLAUDE.md §3). */
export function firstLabel(host) {
  const h = String(host || '').trim();
  if (!h) return null;
  const label = h.split('.')[0];
  return label || null;
}

/** Validate against the SHARED rule (identity.js isValidHandle) + the ONE reserved
 *  list. Never weakened: isValidHandle is the DNS-safe rule that guarantees the
 *  handle can actually be a <handle>.mycelium.id subdomain / did:web label. */
export function validateHandle(raw) {
  const h = normalizeHandle(raw);
  if (!isValidHandle(h)) return { ok: false, handle: h, reason: HANDLE_HINT };
  if (RESERVED_HANDLES.has(h)) return { ok: false, handle: h, reason: 'that handle is reserved' };
  return { ok: true, handle: h };
}

/** THE authoritative read: the vault's live federation handle, or null.
 *  Derived from publicHost — never from user_profiles. */
export function currentHandle({ env = process.env } = {}) {
  const label = firstLabel(readRemoteConfig({ env }).publicHost);
  return label && isValidHandle(label) ? label : null;
}

/** A handle the user has picked but that is NOT yet claimed (no publicHost).
 *  Stored in remote.json next to publicHost so there is still only ONE store —
 *  it is an INTENT, never an identity: federation stays fail-closed until the
 *  claim lands. */
export function pendingHandle({ env = process.env } = {}) {
  const d = readRemoteConfig({ env }).desiredHandle;
  return d && isValidHandle(d) ? d : null;
}

const isHttpsOrLocal = (u) => {
  try { const x = new URL(u); return x.protocol === 'https:' || x.hostname === 'localhost' || x.hostname === '127.0.0.1'; }
  catch { return false; }
};
const isSafeCred = (v) => typeof v === 'string' && /^[\x21-\x7e]{1,512}$/.test(v) && !/["'`{}\\]/.test(v);
const SAFE_RELAY = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i;

async function cpFetch(fetchImpl, url, opts, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetchImpl(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}

function controlPlaneBase(env) {
  const base = String(readRemoteConfig({ env }).controlPlaneUrl || '').replace(/\/$/, '');
  if (!isHttpsOrLocal(base)) throw new HandleError('control plane URL must be https', { code: 'bad_control_plane', status: 400 });
  return base;
}

/**
 * Can this vault actually CLAIM right now? The claim provisions a public address,
 * so it needs the operator password (the only auth gate on that address) and the
 * in-process master key (to sign the claim).
 */
export function canProvision({ env = process.env } = {}) {
  if (!env.ENCRYPTION_MASTER_KEY) return { ok: false, reason: 'vault is locked — finish setup first', code: 'vault_locked', status: 503 };
  if (!operatorUserExists()) return { ok: false, reason: 'set a password for remote access first (Settings → Connections)', code: 'no_operator_password', status: 400 };
  return { ok: true };
}

/**
 * Availability against the CONTROL PLANE — the only authority that can answer.
 * The old check queried the LOCAL user_profiles table, which in a single-user
 * vault is vacuously "available" for every name, so onboarding promised handles
 * the relay then rejected with a 409.
 * FAIL CLOSED: an unreachable control plane returns available:false with a
 * distinguishable reason, never an optimistic yes.
 */
export async function checkAvailability(raw, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const v = validateHandle(raw);
  if (!v.ok) return { available: false, reason: v.reason };
  // Already ours → "available" to us (lets the UI show your own handle as fine).
  if (currentHandle({ env }) === v.handle) return { available: true, mine: true };
  let base;
  try { base = controlPlaneBase(env); } catch (e) { return { available: false, reason: e.message, unreachable: true }; }
  try {
    const r = await cpFetch(fetchImpl, `${base}/v1/handle/${encodeURIComponent(v.handle)}`);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { available: false, reason: data?.error || 'that handle is taken' };
    // D-124: `=== true`, never `!== false`. A 200 whose body lacks/garbles `available`
    // must read UNAVAILABLE — the docstring above says FAIL CLOSED and for the
    // malformed-200 case this line was the one fail-OPEN reading of it: a control-plane
    // shape change would have reported every handle as free.
    if (data?.available !== true) return { available: false, reason: data?.reason || 'the control plane gave no availability answer', unreachable: data?.available === undefined ? true : undefined };
    return { available: true, reason: data?.reason };
  } catch {
    return { available: false, reason: "couldn't reach the control plane to check", unreachable: true };
  }
}

/** Write the DERIVED handle into user_profiles so the existing readers (local
 *  connection resolution, public profile page) stay correct. Best-effort by
 *  design: the mirror is a cache, never the authority — a mirror failure must not
 *  fail a claim that already succeeded on the control plane. */
export async function mirrorProfileHandle(db, userId, handle) {
  if (!db?.rawQuery || !userId || !handle) return false;
  try {
    await db.rawQuery(
      `INSERT INTO user_profiles (user_id, handle, member_since, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET handle = excluded.handle, updated_at = datetime('now')`,
      [userId, handle],
    );
    return true;
  } catch { return false; }
}

/**
 * THE ONE SETTER. Every surface that sets a handle goes through here:
 *   - PUT /portal/profile            (Profile screen, onboarding HandleStep)
 *   - POST /api/v1/remote/connect-managed  (Settings → Connections)
 *
 * @param {object} o
 * @param {string} o.handle
 * @param {string} [o.turnstileToken]  bot-check token from the connect widget
 * @param {boolean} [o.requireProvision=false]  true = the caller INSISTS on a live
 *        claim (Settings → Connections). false = a claim is attempted, and if the
 *        vault cannot provision yet the handle is recorded as an explicit,
 *        surfaced INTENT (`claimed:false` + reason) — never as a silent success.
 * @param {(handle:string)=>any} [o.mirror]  writes the derived user_profiles mirror
 * @returns {Promise<{ok:true, handle:string, claimed:boolean, host:string|null,
 *                     connectorUrl?:string, restartRequired:boolean, reason?:string}>}
 */
export async function setHandle({
  handle,
  turnstileToken = '',
  requireProvision = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  mirror = null,
} = {}) {
  const v = validateHandle(handle);
  if (!v.ok) throw new HandleError(`invalid handle (${v.reason})`, { code: 'invalid_handle', status: 400 });
  const h = v.handle;

  // SET-ONCE gates on the AUTHORITATIVE STORE — publicHost being non-empty — and
  // NOT on currentHandle(). currentHandle() is firstLabel(publicHost) *filtered
  // through isValidHandle*, so it is null for any configured host whose first label
  // is not a valid handle (own-domain vaults: `a.example.com`, `my_box.example.org`,
  // a legacy mixed-case host). Gating on it let those vaults fall straight through
  // to a LIVE CLAIM that OVERWROTE publicHost — silently rotating
  // did:web:a.example.com → did:web:attacker.mycelium.id, flipping remoteMode to
  // 'managed', and orphaning every peer that had pinned the old DID. Reachable from
  // `PUT /portal/profile`. The store, not its derived projection, is the gate.
  const rc = readRemoteConfig({ env });
  const configuredHost = rc.publicHost;
  const live = currentHandle({ env });
  if (configuredHost) {
    if (live === h) {
      // Idempotent: re-setting the handle you already have is a no-op success. Still
      // re-mirror, so a profile row that drifted converges.
      if (mirror) await mirror(h);
      // Echo the ACTUAL configured host — never a synthesized `<handle>.mycelium.id`.
      // An own-domain vault at vault.example.com whose first label happens to equal
      // the submitted handle must not be told it holds a managed address.
      return {
        ok: true, handle: h, claimed: true, host: configuredHost,
        connectorUrl: `https://${configuredHost}/mcp`,
        managed: rc.remoteMode === 'managed',
        restartRequired: false, unchanged: true,
      };
    }
    // SET-ONCE. See the header: a rename orphans did:web:<publicHost> for every
    // peer that already connected. Refuse loudly; do not half-rename.
    throw new HandleError(
      `your address is already ${configuredHost} — changing a handle that peers already know isn't supported yet`,
      { code: 'rename_unsupported', status: 409 },
    );
  }

  const prov = canProvision({ env });
  if (!prov.ok) {
    if (requireProvision) throw new HandleError(prov.reason, { code: prov.code, status: prov.status });
    // Cannot claim yet (typical during onboarding: no operator password). Verify
    // the name is actually free, then record the INTENT and say so plainly. The
    // caller MUST surface claimed:false — this is not a silent success.
    const avail = await checkAvailability(h, { env, fetchImpl });
    if (!avail.available) {
      throw new HandleError(avail.reason || 'that handle is taken', {
        code: avail.unreachable ? 'control_plane_unreachable' : 'already_claimed',
        status: avail.unreachable ? 502 : 409,
      });
    }
    writeRemoteConfig({ desiredHandle: h }, { env });
    return { ok: true, handle: h, claimed: false, host: null, restartRequired: false, reason: prov.reason };
  }

  // ── Live claim against the control plane ──────────────────────────────────
  // (Extracted verbatim in behaviour from remote/router.js's connect-managed, so
  //  both surfaces now run the SAME provisioning code.)
  const base = controlPlaneBase(env);
  const masterHex = env.ENCRYPTION_MASTER_KEY;
  let data;
  try {
    const chUrl = turnstileToken ? `${base}/v1/challenge?cf_turnstile=${encodeURIComponent(turnstileToken)}` : `${base}/v1/challenge`;
    const chRes = await cpFetch(fetchImpl, chUrl);
    if (!chRes.ok) throw new Error(chRes.status === 403 ? 'bot check failed' : 'challenge failed');
    const { nonce } = await chRes.json();
    const claim = buildClaim({ action: 'provision', handle: h, nonce, masterHex }); // throws on invalid handle
    const pvRes = await cpFetch(fetchImpl, `${base}/v1/provision`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim),
    });
    data = await pvRes.json().catch(() => ({}));
    // Reserve-then-pay (O5): the plane held the handle and wants payment. Surface
    // the Stripe URL so the UI can open it. Validate https — the response is
    // untrusted and we never hand a non-https URL to a browser.
    if (pvRes.status === 402) {
      const checkoutUrl = typeof data?.checkoutUrl === 'string' ? data.checkoutUrl : '';
      if (!/^https:\/\//i.test(checkoutUrl)) throw new HandleError('control plane returned an invalid checkout URL', { code: 'bad_response', status: 502 });
      throw new HandleError('subscription required', { code: 'payment_required', status: 402, extra: { checkoutUrl } });
    }
    if (!pvRes.ok) {
      throw new HandleError(data?.error || 'provision failed', {
        code: pvRes.status === 409 ? 'already_claimed' : 'provision_failed',
        status: pvRes.status === 409 ? 409 : 400,
      });
    }
  } catch (err) {
    if (err instanceof HandleError) throw err;
    const caller = /invalid handle|nonce|bot check/i.test(String(err?.message || ''));
    throw new HandleError(caller ? err.message : 'could not reach the control plane', {
      code: caller ? 'invalid_handle' : 'control_plane_unreachable',
      status: caller ? 400 : 502,
    });
  }

  // VALIDATE the untrusted control-plane response before it touches config/env:
  // the host must be THIS handle's own subdomain; creds must be injection-safe.
  const { host, relayAddr, relayToken, acmeDns } = data || {};
  const acmeServer = acmeDns && (acmeDns.serverUrl || acmeDns.server_url);
  if (!isSafeHostname(host) || !host.startsWith(`${h}.`)
    || !SAFE_RELAY.test(String(relayAddr || ''))
    || !isSafeCred(relayToken)
    || !acmeDns || !isSafeCred(acmeDns.username) || !isSafeCred(acmeDns.password) || !isSafeCred(acmeDns.subdomain)
    || !isHttpsOrLocal(acmeServer)) {
    throw new HandleError('control plane returned an invalid response', { code: 'bad_response', status: 502 });
  }

  // Persist locally. If THIS fails the handle is already provisioned (nonce
  // consumed) — report distinctly so the user retries, not "unreachable".
  try {
    const creds = { username: acmeDns.username, password: acmeDns.password, subdomain: acmeDns.subdomain, serverUrl: acmeServer };
    setRemoteSecret('relayToken', relayToken);
    setRemoteSecret('acmeDns', JSON.stringify(creds));
    writeRemoteConfig({ remoteMode: 'managed', publicHost: host, relayAddr, desiredHandle: h }, { env });
    materializeRemoteConfigs({ dataDir: dataDir(), config: readRemoteConfig({ env }), relayToken, acmeDns: creds });
  } catch {
    throw new HandleError('address provisioned, but saving locally failed — restart the app and try again', { code: 'local_persist_failed', status: 500 });
  }

  // Mirror LAST: the derived profile label follows the authoritative store.
  if (mirror) await mirror(firstLabel(host));

  // The signing identity is built at boot → the new did:web is not live until a
  // restart. Say so; never imply federation works before it does.
  return { ok: true, handle: firstLabel(host), claimed: true, host, connectorUrl: `https://${host}/mcp`, restartRequired: true };
}
