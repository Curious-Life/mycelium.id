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
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { authDbPath } from './paths.js';
import { readRemoteConfig, resolveAuthSecret } from './remote/config.js';
import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
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
  const baseURL =
    opts.baseURL || readRemoteConfig().publicBaseUrl || 'http://localhost:4711';
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

  const auth = betterAuth({
    baseURL,
    secret,
    database,
    emailAndPassword: { enabled: true },
    // better-auth rejects auth POSTs whose Origin is not trusted (CSRF guard).
    // Claude's connector callbacks originate from claude.ai / claude.com, so
    // trust them alongside our own base URL (validated end-to-end in the Phase-4
    // smoke — see docs/REMOTE-CONNECT-DESIGN-2026-06-02.md).
    trustedOrigins: [baseURL, 'https://claude.ai', 'https://claude.com'],
    plugins: [
      mcp({
        loginPage: '/login',
        resource: `${baseURL}/mcp`,
        oidcConfig: {
          allowDynamicClientRegistration: true,
          requirePKCE: true,
          storeClientSecret: 'plain',
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
