// better-auth instance for the single-user MCP OAuth 2.1 surface.
//
// Verified against spike/oauth (RESULT.md = GO; better-auth@1.6.12):
//   - mcp() plugin provides OAuth 2.1 + DCR + PKCE; discovery advertises the
//     real endpoints under /api/auth/mcp/*.
//   - oidcConfig: allowDynamicClientRegistration, requirePKCE, storeClientSecret 'plain'.
//   - getMigrations(auth.options).runMigrations() creates the tables in-process.
//   - better-auth enforces an Origin header → trustedOrigins must list baseURL.
//
// Single-user: emailAndPassword with ONE operator account, seeded from env.
// The auth database is SEPARATE from the encrypted vault and stores no vault
// plaintext — only OAuth/session rows. The vault's two hex keys never touch
// this file.
import Database from 'better-sqlite3';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { authDbPath } from './paths.js';
import { readRemoteConfig, resolveAuthSecret } from './remote/config.js';
import { betterAuth } from 'better-auth';
import { mcp, jwt } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { getMigrations } from 'better-auth/db/migration';

/**
 * Create (but do not migrate/seed) the better-auth instance.
 * @param {object} [opts]
 * @param {string} [opts.baseURL]  e.g. http://localhost:4711
 * @param {string} [opts.secret]   signing secret (32+ random chars)
 * @param {string} [opts.dbPath]   sqlite path; ':memory:' for tests
 */
export function createAuth(opts = {}) {
  // baseURL: explicit opt > MYCELIUM_BASE_URL > persisted remote.json > localhost
  // (readRemoteConfig folds in the env-var precedence). For a remote connector
  // this MUST be the public HTTPS (tunnel) URL — every OAuth metadata/resource
  // field derives from it.
  let baseURL =
    opts.baseURL || readRemoteConfig().publicBaseUrl || 'http://localhost:4711';
  // Defence in depth: readRemoteConfig() now normalizes publicBaseUrl, but an
  // explicit opts.baseURL could still be malformed. better-auth throws on a
  // scheme-less/invalid URL and crashes boot — guard + fail soft to loopback.
  try { new URL(baseURL); } catch {
    console.warn(`[mycelium] auth: invalid baseURL ${JSON.stringify(baseURL)} — falling back to http://localhost:4711`);
    baseURL = 'http://localhost:4711';
  }
  // Signing secret: explicit opt > MYCELIUM_AUTH_SECRET > a stable secret
  // persisted in auth.db (generated once). resolveAuthSecret never returns empty,
  // so the old "must set MYCELIUM_AUTH_SECRET" boot friction is gone; the guard
  // below stays as defence in depth. A changed secret invalidates issued tokens
  // by design (the deliberate "revoke all" action).
  const secret = opts.secret || resolveAuthSecret();
  if (!secret) {
    throw new Error('Could not resolve an auth signing secret.');
  }
  const dbPath = opts.dbPath || authDbPath();

  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const database = new Database(dbPath);
  // Enforce foreign keys (better-sqlite3 defaults them OFF). The OAuth tables use
  // `on delete cascade`; without enforcement, deleting a user ORPHANS its oauth
  // token rows (userId → dead row), and the next token INSERT/refresh then fails
  // the FK constraint → `POST /token` 500 → the client never gets a token. (This
  // is exactly the breakage manual FK-OFF reset scripts caused — 2026-06-04.)
  database.pragma('foreign_keys = ON');
  // Harden: auth.db holds the operator password hash, the signing secret, and the
  // relay/acme-dns secrets — keep it owner-only (sqlite defaults to 0644).
  if (dbPath !== ':memory:') { try { chmodSync(dbPath, 0o600); } catch { /* best-effort */ } }

  const auth = betterAuth({
    baseURL,
    secret,
    database,
    emailAndPassword: { enabled: true },
    // Session lifetime (hardening). These sessions are ONLY used for NETWORKED
    // (web/relay) access — the desktop loopback path is "always signed in" via the
    // auth shim and never holds a better-auth session — so a short window costs
    // desktop nothing and bounds the blast radius of a stolen/forgotten web cookie.
    // expiresIn acts as an IDLE timeout (a session unused this long expires);
    // updateAge slides it on active use. Overridable via MYCELIUM_SESSION_TTL_HOURS;
    // default 24h idle, hourly slide.
    session: {
      expiresIn: Math.max(1, Number(process.env.MYCELIUM_SESSION_TTL_HOURS) || 24) * 60 * 60,
      updateAge: 60 * 60,
    },
    // better-auth rejects auth POSTs whose Origin is not trusted (CSRF guard).
    // Claude's connector callbacks originate from claude.ai / claude.com, so
    // trust them alongside our own base URL (validated end-to-end in the Phase-4
    // smoke — see docs/REMOTE-CONNECT-DESIGN-2026-06-02.md).
    trustedOrigins: [baseURL, 'https://claude.ai', 'https://claude.com'],
    plugins: [
      // The mcp() plugin's discovery hardcodes jwks_uri = <baseURL>/api/auth/mcp/jwks
      // and (with useJWTPlugin) signs tokens RS256. Without the jwt plugin that URL
      // 404s and clients (Claude) can't validate the token → "Authorization failed".
      // Serve the JWKS at the EXACT advertised path so discovery resolves.
      jwt({ jwks: { jwksPath: '/mcp/jwks' } }),
      // Passkey (WebAuthn) authentication — Phase 5.3. The OFFICIAL @better-auth
      // plugin (separate package, not in core better-auth). It issues NATIVE
      // better-auth sessions, so the portal auth gate (require-vault-auth.js)
      // accepts passkey logins with no change. rpID/origin are PER-BOX: in relay
      // mode baseURL is https://<handle>.mycelium.id, so a credential is bound to
      // that subdomain. Auth-only — V1 vault keys live server-side, so NO PRF/URK.
      // Enrollment requires an existing session (operator-password login first).
      passkey({
        rpID: (() => { try { return new URL(baseURL).hostname; } catch { return 'localhost'; } })(),
        rpName: 'Mycelium',
        origin: baseURL,
        // "Last used" tracking for the Settings passkey panel. better-auth's
        // passkey schema has NO last-used field (only `counter`, a WebAuthn
        // sign-count many authenticators pin at 0). This hook runs AFTER the
        // plugin has already verified the assertion — it cannot influence that
        // verification; it only reads the credentialID of an ALREADY-authenticated
        // passkey and stamps a timestamp — so it can never weaken an auth check.
        // Best-effort: wrapped, never throws (a failed stamp must not break
        // sign-in). `clientData.id` === the stored credentialID (verify looks the
        // row up by it; register stores credentialID = credential.id). The column
        // is added by ensurePasskeyLastUsedColumn() after migrations run.
        authentication: {
          afterVerification: async ({ clientData }) => {
            try {
              const credId = clientData?.id;
              if (typeof credId === 'string' && credId) {
                database
                  .prepare('UPDATE passkey SET last_used_at = ? WHERE credentialID = ?')
                  .run(new Date().toISOString(), credId);
              }
            } catch { /* best-effort — never block sign-in on a telemetry write */ }
          },
        },
      }),
      mcp({
        loginPage: '/login',
        resource: `${baseURL}/mcp`,
        // Top-level `metadata` overrides the authorization-server discovery
        // document (better-auth mcp/index.mjs:69 spreads `...options?.metadata`
        // over the defaults at :39). Drop `openid` so Claude won't request an
        // id_token — Claude requests only advertised scopes, and better-auth
        // emits an unverifiable HS256 id_token only when `openid` is requested
        // (a known connector choke point). The hand-built PRM (server-http.js)
        // is likewise openid-free; Sentry/Linear/Notion/GitHub advertise none.
        metadata: { scopes_supported: ['profile', 'email', 'offline_access'] },
        oidcConfig: {
          allowDynamicClientRegistration: true,
          requirePKCE: true,
          storeClientSecret: 'plain',
          useJWTPlugin: true,
        },
      }),
    ],
  });

  return { auth, baseURL, database };
}

/** Run better-auth migrations in-process. Idempotent. */
export async function migrateAuth(auth) {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

/**
 * Add the `last_used_at` column to better-auth's `passkey` table if missing.
 * better-auth's passkey schema (mergeSchema only renames, can't add fields) has
 * no last-used field, and its adapter's transformOutput drops non-schema columns
 * — so this app-local column is written by the passkey afterVerification hook and
 * read by the enriched-list endpoint (both in server-http.js), never via
 * better-auth's own list. Idempotent + best-effort: called after migrateAuth, so
 * the `passkey` table already exists; a duplicate-column error is swallowed.
 *
 * @param {import('better-sqlite3').Database} database  the auth.db handle from createAuth
 */
export function ensurePasskeyLastUsedColumn(database) {
  try {
    const cols = database.prepare('PRAGMA table_info(passkey)').all();
    if (!Array.isArray(cols) || cols.length === 0) return; // table not migrated yet
    if (cols.some((c) => c.name === 'last_used_at')) return; // already present
    database.exec('ALTER TABLE passkey ADD COLUMN last_used_at TEXT');
  } catch { /* best-effort — the panel simply shows "never used" if this fails */ }
}

/**
 * Ensure the single operator account exists. Credentials come from env/opts.
 * Idempotent — a duplicate sign-up is treated as success. Fail closed: never
 * create an account with an empty password.
 */
export async function ensureOperatorUser(auth, { email, password } = {}) {
  const e = email || process.env.MYCELIUM_USER_EMAIL || 'operator@mycelium.local';
  const p = password || process.env.MYCELIUM_USER_PASSWORD;
  if (!p) {
    throw new Error(
      'MYCELIUM_USER_PASSWORD is required to seed the operator account.',
    );
  }
  try {
    await auth.api.signUpEmail({ body: { email: e, password: p, name: 'Operator' } });
  } catch (err) {
    // Already exists → fine (idempotent). Anything else is a real failure.
    const msg = String(err?.message || err);
    if (!/exist|already|unique|duplicate/i.test(msg)) throw err;
  }
  return { email: e };
}
