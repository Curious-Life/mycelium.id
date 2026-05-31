// better-auth instance for Mycelium's remote (HTTP) transport.
//
// Single-user, self-hosted cognitive vault. The OAuth 2.1 surface exists so MCP
// clients (Claude Desktop / mobile) can connect over HTTPS with a Bearer token
// instead of stdio.
//
// VERIFIED DESIGN (spike/oauth/RESULT.md + node_modules read, this Wave):
//   - There is NO `oAuthProvider()` API. The real surface is the `mcp()` plugin
//     (wraps oidcProvider with MCP defaults) + helpers `withMcpAuth`,
//     `oAuthDiscoveryMetadata`, `oAuthProtectedResourceMetadata`.
//   - The mcp plugin self-advertises endpoints under /api/auth/mcp/* (register /
//     authorize / token) — confirmed live against better-auth@1.6.12.
//   - oidcConfig: allowDynamicClientRegistration + requirePKCE + plain secret
//     storage (single-user; clients register dynamically via DCR; PKCE S256).
//   - Migrations run in-process via getMigrations(auth.options).runMigrations().
//   - better-auth enforces an Origin check on mutating requests => baseURL must
//     be a trusted origin (fail closed otherwise).
//
// Factory + DI: createAuth(opts) -> { auth, db, runMigrations }. The HTTP server
// owns when migrations run and when the instance is wired into Express. The auth
// sqlite file is SEPARATE from the encrypted vault DB — it holds only
// user/session/oauth tables, never vault plaintext.
import { betterAuth } from 'better-auth';
import { mcp } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import Database from 'better-sqlite3';

/**
 * Build the better-auth instance.
 *
 * @param {object} opts
 * @param {string}   opts.baseURL          Public base URL (e.g. https://x.mycelium.id).
 * @param {string}   opts.authDbPath       Path to the better-auth sqlite DB.
 * @param {string}  [opts.authSecret]      better-auth signing secret.
 * @param {string[]}[opts.trustedOrigins]  Extra trusted origins beyond baseURL.
 * @returns {{ auth: ReturnType<typeof betterAuth>, db: import('better-sqlite3').Database, runMigrations: () => Promise<void> }}
 */
export function createAuth({ baseURL, authDbPath, authSecret, trustedOrigins = [] } = {}) {
  if (!baseURL) throw new Error('createAuth: baseURL is required');
  if (!authDbPath) throw new Error('createAuth: authDbPath is required');

  const origins = Array.from(new Set([baseURL, ...trustedOrigins]));
  const db = new Database(authDbPath);

  const auth = betterAuth({
    baseURL,
    secret: authSecret,
    database: db,
    emailAndPassword: { enabled: true },
    trustedOrigins: origins,
    plugins: [
      mcp({
        loginPage: '/login',
        oidcConfig: {
          allowDynamicClientRegistration: true,
          requirePKCE: true,
          storeClientSecret: 'plain',
        },
      }),
    ],
  });

  async function runMigrations() {
    const { runMigrations: run } = await getMigrations(auth.options);
    await run();
  }

  return { auth, db, runMigrations };
}
