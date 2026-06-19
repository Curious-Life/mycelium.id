// src/remote/config.js — persisted remote-access config + the stable OAuth
// signing secret. The operational layer the OAuth server (src/server-http.js +
// src/auth.js) needs to survive restarts without env vars.
//
// THREE stores, split by sensitivity (see docs/REMOTE-CONNECT-DESIGN-2026-06-02.md):
//   1. remote.json (<dataDir>/remote.json) — NON-secret config: publicBaseUrl,
//      remoteEnabled, operatorEmail. Plaintext JSON, mirroring the kcv.json
//      precedent (paths.js). Safe to read/show; nothing here unlocks anything.
//   2. auth.db (mycelium_app_secret table) — the better-auth SIGNING SECRET,
//      generated ONCE and reused. Design pivot (v3): it lives WITH the session
//      tokens it signs (auth.db already holds sessions + the operator password
//      hash), so storing it there adds no blast radius — and unlike the Keychain
//      it is testable + portable (point MYCELIUM_AUTH_DB at a temp file). The
//      VAULT master key stays Keychain-only and is never touched here.
//   3. operator PASSWORD — NOT stored by us. setOperatorPassword() hands it to
//      better-auth, which hashes it into auth.db. We persist only operatorEmail.
//
// Precedence everywhere: explicit env var > persisted store > default/generate.
// Never logs a secret value (CLAUDE.md §1) — only booleans/counts.
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { remoteConfigPath, authDbPath } from '../paths.js';

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const DEFAULT_EMAIL = 'operator@mycelium.local';

// Normalize a configured base URL → a parseable http(s) URL, or '' (FAIL SOFT).
// Prepends https:// when no scheme is present; returns '' for anything that
// won't parse. A scheme-less / garbage `publicBaseUrl` in remote.json used to
// flow into betterAuth({ baseURL }) and CRASH boot (better-auth throws on an
// invalid URL). Normalizing here guarantees readRemoteConfig() never yields a
// value that can crash the server — at worst remote stays effectively off.
function normalizeBaseUrl(value) {
  const v = clean(value);
  if (!v) return '';
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  try { return new URL(withScheme).href.replace(/\/$/, ''); } catch { return ''; }
}

// Managed-endpoint defaults — mycelium operates these; a full-control user
// overrides relayAddr/acmeDnsServer/controlPlaneUrl to a self-hosted instance.
// "Managed" is just mycelium running the same open-source stack.
// The control-plane API edge is published on :8443 by design — frps owns :443
// on the managed box for tenant SNI-passthrough, so the Caddy edge that fronts
// /v1/* (provision/challenge/handle/release) listens on :8443 (see
// mycelium-managed/relay/deploy/Caddyfile.edge). Pointing at :443 lands on frps,
// which serves no cert for connect.mycelium.id → TLS "unrecognized_name", so
// every availability check failed and the claim UI showed "taken". Verified
// 2026-06-15: :8443 returns a valid LE cert + working /v1/challenge + /v1/handle.
// Override via MYCELIUM_CONTROL_PLANE / remote.json for a self-hosted plane.
const DEFAULT_CONTROL_PLANE = 'https://connect.mycelium.id:8443';
const DEFAULT_ACME_DNS = 'https://acme-dns.mycelium.id';
const REMOTE_MODES = new Set(['off', 'managed', 'own-relay', 'direct']);

// A safe public hostname (FQDN): lowercase labels + dots + hyphens — NO spaces,
// CRLF, quotes, or braces. Untrusted control-plane/host values flow into env +
// rendered config files, so they MUST be validated before persist/render
// (config-injection / OAuth-baseURL-poisoning defense).
const SAFE_HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))+$/i;
export function isSafeHostname(h) { return typeof h === 'string' && SAFE_HOST.test(h); }
const SAFE_RELAY = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/i; // host[:port]
// A Matrix MXID (@localpart:server.name). The localpart/server grammar is
// permissive on purpose — the homeserver is authoritative; we only reject the
// obviously-malformed (no `@`, no `:`, whitespace) before it lands in did.json
// (which a peer fetches) and the config file. Mirrors did.js's advertise regex.
const SAFE_MXID = /^@[^:\s]+:[^\s/]+$/;
export function isSafeMxid(v) { return typeof v === 'string' && SAFE_MXID.test(v); }

// Operator-password weakness check. This single password is the gate between a
// public URL and the vault, so beyond the ≥12-char floor we reject the obviously
// guessable. Deliberately LENIENT — it must never reject a real passphrase, only
// catch repetition, all-digit PINs, and common-word prefixes. Returns a reason
// string (for the error/UI) or null when acceptable.
export function passwordWeakness(p) {
  if (typeof p !== 'string') return 'required';
  if (new Set(p).size < 5) return 'too repetitive — use more distinct characters';
  if (/^\d+$/.test(p)) return 'all digits — add letters and symbols';
  if (/(.)\1{4,}/.test(p)) return 'avoid long runs of one character';
  if (/^(password|qwerty|letmein|mycelium|changeme|iloveyou|welcome|admin)/i.test(p)) return 'starts with a common, guessable word';
  return null;
}

// Harden auth.db: dir 0700, file 0600. It holds the better-auth signing secret,
// the operator password hash, AND the relay/acme-dns secrets — all plaintext.
// SQLite's default file mode is 0644 (world-readable). Best-effort.
function hardenDbPerms(dbp) {
  try { chmodSync(dirname(dbp), 0o700); } catch { /* */ }
  try { chmodSync(dbp, 0o600); } catch { /* */ }
}

function readFileJson(p) {
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { return {}; }
}

/**
 * Resolve the effective remote config. env wins (parity with the rest of the
 * config surface), then remote.json, then defaults.
 * @returns {{ publicBaseUrl:string, remoteEnabled:boolean, operatorEmail:string }}
 */
export function readRemoteConfig({ env = process.env } = {}) {
  const file = readFileJson(remoteConfigPath({ env }));
  const remoteMode = clean(env.MYCELIUM_REMOTE_MODE) || clean(file.remoteMode) || 'off';
  const publicHost = clean(env.MYCELIUM_PUBLIC_HOST) || clean(file.publicHost) || '';
  return {
    // publicBaseUrl derives from publicHost when not set explicitly, so the
    // managed/own-relay flows only need to persist the host.
    publicBaseUrl:
      normalizeBaseUrl(env.MYCELIUM_BASE_URL) || normalizeBaseUrl(file.publicBaseUrl)
        || (publicHost ? `https://${publicHost}` : ''),
    operatorEmail: clean(env.MYCELIUM_USER_EMAIL) || clean(file.operatorEmail) || DEFAULT_EMAIL,
    remoteEnabled: env.MYCELIUM_REMOTE_ENABLED === '1' || file.remoteEnabled === true,
    // Hardening: require a passkey (WebAuthn) for WEB sign-in (opt-in, default off).
    // Enforced ONLY when a passkey is actually enrolled (passkeyEnrolled()) so it can
    // never lock out during bootstrap; auto-disabled on a publicHost change (a passkey
    // is bound to the host's rpID — see writeRemoteConfig). Desktop loopback + the
    // recovery key are independent escapes and always work.
    requirePasskeyForWeb: env.MYCELIUM_REQUIRE_PASSKEY_WEB === '1' || file.requirePasskeyForWeb === true,
    remoteMode: REMOTE_MODES.has(remoteMode) ? remoteMode : 'off',
    publicHost,
    relayAddr: clean(env.MYCELIUM_RELAY_ADDR) || clean(file.relayAddr) || '',
    acmeDnsServer: clean(env.MYCELIUM_ACME_DNS) || clean(file.acmeDnsServer) || DEFAULT_ACME_DNS,
    controlPlaneUrl: clean(env.MYCELIUM_CONTROL_PLANE) || clean(file.controlPlaneUrl) || DEFAULT_CONTROL_PLANE,
    // Phase B Tier-1 Matrix (NON-secret): the shared homeserver URL + this box's
    // MXID. The access TOKEN is a secret and lives in auth.db (matrixConfig()
    // below), never here. Both empty until a homeserver is configured → Matrix
    // stays inert.
    matrixHomeserver: clean(env.MYCELIUM_MATRIX_HS) || clean(file.matrixHomeserver) || '',
    matrixUserId: clean(env.MYCELIUM_MATRIX_USER) || clean(file.matrixUserId) || '',
    // Connection presence (online/offline dot). `paused` = appear offline to ALL
    // connections (master kill-switch; default false = sharing active, per-connection
    // control lives on connections.presence_share). `activeWindowMin` = minutes of
    // client inactivity before "offline" (default 5).
    presence: {
      paused: file.presence?.paused === true,
      activeWindowMin: Number(file.presence?.activeWindowMin) > 0 ? Number(file.presence.activeWindowMin) : 5,
    },
  };
}

/**
 * Merge a patch into remote.json (atomic write). Only the three known,
 * NON-secret keys are accepted — never write a secret here.
 */
export function writeRemoteConfig(patch = {}, { env = process.env } = {}) {
  const p = remoteConfigPath({ env });
  const next = { v: 1, ...readFileJson(p) };
  if (typeof patch.publicBaseUrl === 'string') {
    const u = patch.publicBaseUrl.trim();
    // Reject a malformed URL at write time (clear UI error) + store it normalized
    // (scheme-prefixed) so a later read can never crash boot — see normalizeBaseUrl.
    if (u !== '' && !normalizeBaseUrl(u)) throw new Error('invalid publicBaseUrl');
    next.publicBaseUrl = u === '' ? '' : normalizeBaseUrl(u);
  }
  if (typeof patch.operatorEmail === 'string') next.operatorEmail = patch.operatorEmail.trim();
  if (typeof patch.remoteEnabled === 'boolean') next.remoteEnabled = patch.remoteEnabled;
  // Require-passkey-for-web (hardening, opt-in). Enforced only when a passkey is
  // enrolled (see passkeyEnrolled / the server guards), so writing `true` with no
  // passkey is harmless until one exists.
  if (typeof patch.requirePasskeyForWeb === 'boolean') next.requirePasskeyForWeb = patch.requirePasskeyForWeb;
  // Transport keys (all NON-secret — secrets go in auth.db via setRemoteSecret).
  if (typeof patch.remoteMode === 'string' && REMOTE_MODES.has(patch.remoteMode)) next.remoteMode = patch.remoteMode;
  if (typeof patch.publicHost === 'string') {
    const h = patch.publicHost.trim();
    if (h !== '' && !isSafeHostname(h)) throw new Error('invalid publicHost');
    // A WebAuthn passkey is bound to the host's rpID, so CHANGING the host orphans
    // every enrolled passkey. Auto-disable the passkey-for-web requirement on a real
    // host change so a rename/disconnect can never lock the owner out of the web
    // (they re-enroll on the new host, then re-enable). Same-value writes don't trip it.
    if (h !== (next.publicHost || '') && next.requirePasskeyForWeb) next.requirePasskeyForWeb = false;
    next.publicHost = h;
  }
  if (typeof patch.relayAddr === 'string') {
    const a = patch.relayAddr.trim();
    if (a !== '' && !SAFE_RELAY.test(a)) throw new Error('invalid relayAddr');
    next.relayAddr = a;
  }
  if (typeof patch.acmeDnsServer === 'string') next.acmeDnsServer = patch.acmeDnsServer.trim();
  if (typeof patch.controlPlaneUrl === 'string') next.controlPlaneUrl = patch.controlPlaneUrl.trim();
  // Matrix (NON-secret): homeserver must be an https URL (it is fetched + rendered);
  // the MXID is validated before it lands in the peer-fetched did.json.
  if (typeof patch.matrixHomeserver === 'string') {
    const u = patch.matrixHomeserver.trim();
    if (u !== '' && !/^https:\/\/[^\s]+$/i.test(u)) throw new Error('invalid matrixHomeserver (https URL required)');
    next.matrixHomeserver = u;
  }
  if (typeof patch.matrixUserId === 'string') {
    const m = patch.matrixUserId.trim();
    if (m !== '' && !isSafeMxid(m)) throw new Error('invalid matrixUserId (expected @user:server)');
    next.matrixUserId = m;
  }
  // Presence (NON-secret): global pause + active window. Merge into the existing
  // object so a partial patch (just `paused`) doesn't drop activeWindowMin.
  if (patch.presence && typeof patch.presence === 'object') {
    const cur = (next.presence && typeof next.presence === 'object') ? next.presence : {};
    const merged = { ...cur };
    if (typeof patch.presence.paused === 'boolean') merged.paused = patch.presence.paused;
    if (patch.presence.activeWindowMin !== undefined) {
      const n = Number(patch.presence.activeWindowMin);
      if (!Number.isFinite(n) || n <= 0 || n > 1440) throw new Error('invalid presence.activeWindowMin');
      merged.activeWindowMin = n;
    }
    next.presence = merged;
  }
  mkdirSync(dirname(p), { recursive: true });
  try { chmodSync(dirname(p), 0o700); } catch { /* */ }
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, p); // atomic replace
  return next;
}

/**
 * The stable better-auth signing secret. env override wins (verify scripts +
 * power users); else read-or-generate-once from auth.db. A regenerated secret
 * invalidates all issued tokens — so we persist it and NEVER regenerate on a
 * normal boot. Returns 64-char hex.
 */
export function resolveAuthSecret({ env = process.env } = {}) {
  const fromEnv = clean(env.MYCELIUM_AUTH_SECRET);
  if (fromEnv) return fromEnv;
  const dbp = authDbPath({ env });
  // A :memory: auth db is itself ephemeral, so an ephemeral secret is correct.
  if (dbp === ':memory:') return randomBytes(32).toString('hex');
  mkdirSync(dirname(dbp), { recursive: true });
  const db = new Database(dbp);
  hardenDbPerms(dbp);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS mycelium_app_secret (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         secret TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
    const row = db.prepare('SELECT secret FROM mycelium_app_secret WHERE id = 1').get();
    if (row?.secret) return row.secret;
    const secret = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO mycelium_app_secret (id, secret) VALUES (1, ?)').run(secret);
    return secret;
  } finally {
    db.close();
  }
}

/**
 * The stable static MCP/gateway bearer for the :4711 surface — the token a local
 * harness or the memory-bridge hooks present as `Authorization: Bearer …`. env
 * override wins (MYCELIUM_MCP_BEARER — verify scripts + power users); else
 * read-or-generate-once from auth.db, so the self-hosted app ALWAYS has a stable
 * bearer with zero manual setup instead of being OAuth-only. Persisted + never
 * regenerated on a normal boot (a new value would 401 already-connected clients).
 * Retrieve it for the operator via the authed portal (GET /portal/mcp-bearer).
 * Returns 64-char hex. This is an API token (NOT the master key, CLAUDE.md §4) —
 * stored 0600 in auth.db beside the signing secret; local-primary single-user.
 */
export function resolveMcpBearer({ env = process.env } = {}) {
  const fromEnv = clean(env.MYCELIUM_MCP_BEARER);
  if (fromEnv) return fromEnv;
  const dbp = authDbPath({ env });
  if (dbp === ':memory:') return randomBytes(32).toString('hex');
  mkdirSync(dirname(dbp), { recursive: true });
  const db = new Database(dbp);
  hardenDbPerms(dbp);
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS mycelium_mcp_bearer (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         bearer TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`,
    );
    const row = db.prepare('SELECT bearer FROM mycelium_mcp_bearer WHERE id = 1').get();
    if (row?.bearer) return row.bearer;
    const bearer = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO mycelium_mcp_bearer (id, bearer) VALUES (1, ?)').run(bearer);
    return bearer;
  } finally {
    db.close();
  }
}

// ── Remote-transport secret store ────────────────────────────────────────────
// Credentials RECEIVED from a control-plane (the FRP relay token, the acme-dns
// creds) live in auth.db — NEVER remote.json (which is plaintext, non-secret),
// mirroring resolveAuthSecret. Never logged (CLAUDE.md §1). A :memory: auth.db
// has no persistent store (tests pass it explicitly).
function remoteSecretDb({ env = process.env } = {}) {
  const dbp = authDbPath({ env });
  if (dbp === ':memory:') return null;
  mkdirSync(dirname(dbp), { recursive: true });
  const db = new Database(dbp);
  hardenDbPerms(dbp);
  db.exec(
    `CREATE TABLE IF NOT EXISTS mycelium_remote_secret (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  return db;
}

export function setRemoteSecret(key, value, { env = process.env } = {}) {
  if (typeof key !== 'string' || !key) throw new Error('remote secret: key required');
  if (typeof value !== 'string' || !value) throw new Error('remote secret: value required');
  const db = remoteSecretDb({ env });
  if (!db) throw new Error('remote secret: auth.db is :memory: (no persistent store)');
  try {
    db.prepare(
      `INSERT INTO mycelium_remote_secret (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  } finally {
    db.close();
  }
}

export function getRemoteSecret(key, { env = process.env } = {}) {
  const db = remoteSecretDb({ env });
  if (!db) return null;
  try {
    const row = db.prepare('SELECT value FROM mycelium_remote_secret WHERE key = ?').get(key);
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

// Storage key for the Matrix access token in the remote-secret store (auth.db).
export const MATRIX_TOKEN_KEY = 'matrix_access_token';

/**
 * The effective Matrix client config, or `null` when not fully configured.
 * This is the ONE "is Matrix wired?" gate the boot path and did.json advertise
 * consult — every Matrix op stays an inert no-op until this returns non-null.
 * Non-secret host/MXID come from remote.json (or env); the access token comes
 * from auth.db (or MYCELIUM_MATRIX_TOKEN for verify scripts). Never logs the
 * token (CLAUDE.md §1).
 * @returns {{ homeserver:string, userId:string, accessToken:string }|null}
 */
export function matrixConfig({ env = process.env } = {}) {
  const c = readRemoteConfig({ env });
  const homeserver = c.matrixHomeserver;
  const userId = c.matrixUserId;
  if (!homeserver || !userId || !isSafeMxid(userId)) return null;
  if (!/^https:\/\/[^\s]+$/i.test(homeserver)) return null;
  const accessToken = clean(env.MYCELIUM_MATRIX_TOKEN) || getRemoteSecret(MATRIX_TOKEN_KEY, { env });
  if (!accessToken) return null;
  return { homeserver, userId, accessToken };
}

/**
 * Set (first-time) the operator account password — the OAuth authorize gate.
 * We never store the plaintext; a transient better-auth instance over the SAME
 * auth.db hashes + persists it (idempotent on an existing user). Persists the
 * non-secret operatorEmail to remote.json. Enforces a ≥12-char floor (it is the
 * ONLY gate between a reachable URL and the vault's tools).
 *
 * Changing an EXISTING password works via delete-then-recreate (better-auth's
 * signUpEmail is a no-op on an existing user). foreign_keys = ON so the delete
 * CASCADES to the user's oauth tokens/clients/consents/sessions — no orphans.
 * Rotating the operator password intentionally invalidates existing connector
 * grants; clients re-authorize on the next connect.
 *
 * @param {{ email?:string, password:string, env?:object }} args
 */
export async function setOperatorPassword({ email, password, env = process.env } = {}) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('operator password must be at least 12 characters');
  }
  const weak = passwordWeakness(password);
  if (weak) throw new Error(`operator password is weak: ${weak}`);
  const e = clean(email) || readRemoteConfig({ env }).operatorEmail;
  // Dynamic import breaks the auth.js <-> config.js cycle (auth.js imports
  // resolveAuthSecret/readRemoteConfig from here at load time).
  const { createAuth, migrateAuth, ensureOperatorUser } = await import('../auth.js');
  const { auth, database } = createAuth({});
  await migrateAuth(auth);
  // signUpEmail is a no-op for an EXISTING user, so a password change = delete
  // then recreate. foreign_keys = ON makes the delete CASCADE to the user's
  // oauth tokens/clients/consents/sessions (a FK-OFF delete would orphan them and
  // later break token issuance). Rotating the password invalidates existing
  // connector grants by design — clients re-authorize on the next connect.
  try {
    database.pragma('foreign_keys = ON');
    database.prepare('DELETE FROM user WHERE email = ?').run(e);
  } catch { /* user table not migrated yet on first run — ensureOperatorUser creates it */ }
  await ensureOperatorUser(auth, { email: e, password });
  writeRemoteConfig({ operatorEmail: e }, { env });
  return { email: e };
}

/**
 * Best-effort: does a better-auth operator user exist yet (i.e. is a password
 * set)? For the Settings status panel. Never throws.
 */
export function operatorUserExists({ env = process.env } = {}) {
  const dbp = authDbPath({ env });
  if (dbp === ':memory:' || !existsSync(dbp)) return false;
  const email = readRemoteConfig({ env }).operatorEmail;
  const db = new Database(dbp, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM user WHERE email = ?').get(email);
    return Number(row?.n || 0) > 0;
  } catch {
    return false; // table not migrated yet
  } finally {
    db.close();
  }
}

/**
 * Best-effort: is at least one WebAuthn passkey enrolled? Gates the
 * require-passkey-for-web policy (so it stays INERT until a passkey exists — no
 * bootstrap lockout) and the Settings toggle (only enableable once enrolled).
 * Reads auth.db read-only (mirrors operatorUserExists — :4711 is the single
 * writer; a readonly handle adds no contention). Never throws.
 */
export function passkeyEnrolled({ env = process.env } = {}) {
  const dbp = authDbPath({ env });
  if (dbp === ':memory:' || !existsSync(dbp)) return false;
  const db = new Database(dbp, { readonly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM passkey').get();
    return Number(row?.n || 0) > 0;
  } catch {
    return false; // passkey table not migrated yet
  } finally {
    db.close();
  }
}
