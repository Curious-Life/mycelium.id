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
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { remoteConfigPath, authDbPath } from '../paths.js';

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const DEFAULT_EMAIL = 'operator@mycelium.local';

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
  return {
    publicBaseUrl: clean(env.MYCELIUM_BASE_URL) || clean(file.publicBaseUrl) || '',
    operatorEmail: clean(env.MYCELIUM_USER_EMAIL) || clean(file.operatorEmail) || DEFAULT_EMAIL,
    remoteEnabled: env.MYCELIUM_REMOTE_ENABLED === '1' || file.remoteEnabled === true,
  };
}

/**
 * Merge a patch into remote.json (atomic write). Only the three known,
 * NON-secret keys are accepted — never write a secret here.
 */
export function writeRemoteConfig(patch = {}, { env = process.env } = {}) {
  const p = remoteConfigPath({ env });
  const next = { v: 1, ...readFileJson(p) };
  if (typeof patch.publicBaseUrl === 'string') next.publicBaseUrl = patch.publicBaseUrl.trim();
  if (typeof patch.operatorEmail === 'string') next.operatorEmail = patch.operatorEmail.trim();
  if (typeof patch.remoteEnabled === 'boolean') next.remoteEnabled = patch.remoteEnabled;
  mkdirSync(dirname(p), { recursive: true });
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
 * Set (first-time) the operator account password — the OAuth authorize gate.
 * We never store the plaintext; a transient better-auth instance over the SAME
 * auth.db hashes + persists it (idempotent on an existing user). Persists the
 * non-secret operatorEmail to remote.json. Enforces a ≥12-char floor (it is the
 * ONLY gate between a reachable URL and the vault's tools).
 *
 * NOTE: changing an EXISTING password is deferred to Phase 2 (needs better-auth's
 * update API; signUpEmail is idempotent-no-op on an existing user).
 *
 * @param {{ email?:string, password:string, env?:object }} args
 */
export async function setOperatorPassword({ email, password, env = process.env } = {}) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('operator password must be at least 12 characters');
  }
  const e = clean(email) || readRemoteConfig({ env }).operatorEmail;
  // Dynamic import breaks the auth.js <-> config.js cycle (auth.js imports
  // resolveAuthSecret/readRemoteConfig from here at load time).
  const { createAuth, migrateAuth, ensureOperatorUser } = await import('../auth.js');
  const { auth } = createAuth({});
  await migrateAuth(auth);
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
