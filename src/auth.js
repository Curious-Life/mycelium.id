// better-auth instance for the single-user MCP OAuth 2.1 surface.
//
// Verified against the OAuth spike (verdict GO; better-auth@1.6.12):
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
import { mkdirSync, existsSync, chmodSync, renameSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';
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
/** Is this a SQLite structural-damage error? (auth.db is plaintext — no cipher case.) */
function isAuthDbCorrupt(err) {
  const c = String(err?.code || '');
  return c === 'SQLITE_CORRUPT' || c.startsWith('SQLITE_CORRUPT_') || c === 'SQLITE_NOTADB'
    || /database disk image is malformed|file is not a database/i.test(String(err?.message || ''));
}

/**
 * Make auth.db usable, self-healing past structural damage. Runs BEFORE anything else
 * touches the file (see the order note in createAuth).
 *
 * Quarantines rather than deletes: the file holds the signing secret, the relay/acme-dns
 * secrets and the MCP bearer, and a human may want to salvage one by hand. Recreation
 * costs a re-pair and re-connect, which is why healing beats refusing — refusing takes the
 * remote surface down permanently for a file we can rebuild.
 *
 * @param {string} dbPath
 * @returns {boolean} true if a damaged file was quarantined
 */
/** Sleep synchronously. healAuthDbIfCorrupt runs before anything is async. */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no SAB */ }
}

/** Probe auth.db on a FRESH connection. @returns {Error|null} the error, or null if healthy. */
function probeAuthDb(dbPath) {
  let db = null;
  try {
    db = new Database(dbPath, { readonly: true });
    db.prepare('SELECT count(*) FROM sqlite_master').get(); // open succeeds on a damaged
    return null;                                            // file; the first statement fails
  } catch (err) {
    return err;
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

// A concurrent writer can make a read-only probe misread TRANSIENTLY, and the app spawns
// two auth-touching siblings by design. Long enough for a checkpoint to finish.
const AUTH_SETTLE_MS = 3000;

/**
 * @param {string} dbPath
 * @param {boolean} allowSettle  false for request-path callers — see the note below.
 */
function healAuthDbIfCorrupt(dbPath, allowSettle = true) {
  if (!dbPath || dbPath === ':memory:' || !existsSync(dbPath)) return false;
  // Only ever heal a regular FILE. A directory (or socket, or device) at the db path reads
  // as SQLITE_NOTADB — indistinguishable from a damaged database by error code alone — and
  // the destructive branch would then rename someone's DIRECTORY aside and invent a fresh
  // db in its place. That is a configuration mistake to surface, not damage to repair.
  try { if (!statSync(dbPath).isFile()) return false; } catch { return false; }
  {
    const first = probeAuthDb(dbPath);
    if (!first) return false;
    if (!isAuthDbCorrupt(first)) return false; // a lock/permission problem is not damage

    // CONFIRM ON A SECOND LOOK BEFORE DOING SOMETHING IRREVERSIBLE. One observation is
    // not enough here: quarantining rotates the better-auth signing secret plus the relay
    // and acme-dns secrets and the MCP bearer, which invalidates every OAuth token and
    // every paired device. src/db/vault-integrity-check.mjs already learned that a
    // concurrent boot-time write makes a read-only probe read as damage transiently — and
    // there the action is only an advisory marker. A destructive action needs a HIGHER
    // bar than an advisory one, not the same one. Adversarial review, 2026-07-28.
    // THE SETTLE IS A BOOT-PATH COST, NOT A REQUEST-PATH ONE. sleepSync is Atomics.wait:
    // it blocks the whole event loop, and createAuth is also reached from
    // src/remote/config.js:434 (setOperatorPassword) via the HTTP route in
    // src/remote/router.js — where a 3s stall would freeze every concurrent request.
    // A request-path caller therefore does not settle; it declines to act instead, which
    // is the fail-safe direction: the next boot heals it.
    if (!allowSettle) {
      console.error(`[auth] auth.db read as damaged (${first.code || 'SQLITE_CORRUPT'}) on a request path — NOT quarantining here; it will be re-checked and healed at the next start.`);
      return false;
    }
    sleepSync(AUTH_SETTLE_MS);
    const second = probeAuthDb(dbPath);
    if (!second || !isAuthDbCorrupt(second)) {
      console.error(`[auth] auth.db read as damaged (${first.code || 'SQLITE_CORRUPT'}) but verified clean ${AUTH_SETTLE_MS}ms later on a fresh connection — treating the first read as transient (a concurrent write), NOT quarantining.`);
      return false;
    }
    const err = second;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${dbPath}.corrupt-${stamp}`;
    let moved = 0;
    try {
      // Move the whole triple as a UNIT: a stale -wal beside a fresh file is replayed into
      // it on the next open — the mechanism src/db/wal-guard.js exists for.
      for (const sfx of ['', '-wal', '-shm']) {
        if (existsSync(dbPath + sfx)) { renameSync(dbPath + sfx, aside + sfx); moved++; }
      }
    } catch (e) {
      throw new Error(`auth.db is corrupt (${err.code}) and could not be quarantined (${e.message}) — refusing to write over it`);
    }
    // A SIBLING GOT THERE FIRST. Both processes can observe the same damage; the loser
    // finds nothing left to move. Returning true then would claim a quarantine it did not
    // perform, and both would go on to mint a fresh db and a fresh signing secret.
    if (moved === 0) {
      console.error('[auth] auth.db was already quarantined by another process — standing down.');
      return false;
    }
    console.error(
      `[auth] auth.db was structurally damaged (${err.code || 'SQLITE_CORRUPT'}) and has been set aside as `
      + `${basename(aside)} — nothing was deleted. A fresh one will be created. Your VAULT AND ITS DATA ARE `
      + `UNAFFECTED and the desktop app keeps working; what you will need to redo is remote access: re-pair any `
      + `phones, re-connect the MCP client, and re-enter the operator password if you use networked access.`,
    );
    return true;
  }
}

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
  // ORDER IS LOAD-BEARING: resolveAuthSecret() reads the signing secret out of auth.db
  // itself (src/remote/config.js), so it throws SQLITE_CORRUPT before any heal placed
  // after it can run. Caught by testing the heal end-to-end rather than trusting it.
  // Resolve the path, make the file usable, and only then ask it for anything.
  const dbPath = opts.dbPath || authDbPath();
  if (dbPath !== ':memory:') {
    const dir = dirname(dbPath);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    // opts.settleOnDamage === false means a request-path caller: do not block the loop.
    healAuthDbIfCorrupt(dbPath, opts.settleOnDamage !== false);
  }

  const secret = opts.secret || resolveAuthSecret();
  if (!secret) {
    throw new Error('Could not resolve an auth signing secret.');
  }
  // auth.db is REGENERABLE-WITH-FRICTION, and that decides its whole durability story.
  //
  // Measured, not assumed (2026-07-28): with auth.db fully corrupt the DESKTOP app boots
  // and serves normally — portal 200, /account/status 200, no auth error. `createAuth` is
  // reached only from server-http.js (the :4711 remote/OAuth surface) and remote/config.js;
  // the desktop path is the auth shim, which authenticates from loopback trust plus
  // device-sessions stored INSIDE the vault. So a damaged auth.db costs the REMOTE surface,
  // never access to your own data — the opposite of the vault, where damage is unrecoverable
  // and therefore earns the fail-stop latch, snapshots and the WAL guard.
  //
  // Giving this file that same machinery would be three more layers protecting a re-pair.
  // The right pattern is the one already used for the regenerable search index
  // (src/search/sqlite/sidecar.js): detect, QUARANTINE (never delete — it may hold the only
  // copy of a secret worth recovering by hand), recreate, and say plainly what must be
  // redone. Without this, a corrupt auth.db throws on the first pragma below, takes the
  // remote surface down with an opaque SQLITE_CORRUPT, and never heals — because nothing
  // recreates the file. @see the vault-durability architecture design.
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
    // smoke — see the remote-connect design).
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
