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
  const baseURL =
    opts.baseURL || process.env.MYCELIUM_BASE_URL || 'http://localhost:4711';
  const secret = opts.secret || process.env.MYCELIUM_AUTH_SECRET;
  if (!secret) {
    // Fail closed: a signing secret is mandatory. Refuse to boot without one.
    throw new Error(
      'MYCELIUM_AUTH_SECRET is required to start the OAuth server (32+ random chars).',
    );
  }
  const dbPath = opts.dbPath || process.env.MYCELIUM_AUTH_DB || 'data/auth.db';

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
    trustedOrigins: [baseURL],
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
