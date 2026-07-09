// src/inference/claude-config-dir.js — an ISOLATED Claude Code credential store for the app.
//
// THE PROBLEM this solves: Claude Code (the `claude` CLI) authenticates from the machine's
// ~/.claude login (a file on Linux, the Keychain on macOS). The app's native harness ALSO
// re-reads that same live token. So both follow whatever account the machine's `claude` is
// signed into — which may NOT be the subscription the user connected in the app. If the
// machine is signed into a personal account whose org disabled subscription access, EVERY
// agent turn (portal + channels, CLI + native) fails with the wrong account.
//
// THE FIX: give the app its OWN Claude credential directory (CLAUDE_CONFIG_DIR), seeded with
// the subscription creds the app captured at connect-time. `claude` spawned with
// CLAUDE_CONFIG_DIR reads/refreshes creds from THERE — fully isolated from the user's personal
// ~/.claude (verified: an empty CLAUDE_CONFIG_DIR makes claude report "Not logged in" rather
// than falling back to the Keychain). Claude Code keeps the token refreshed in that dir, so we
// stay ToS-clean (we never mint/refresh tokens ourselves — #10).
//
// SECURITY (§1/§4): the credentials file is 0600 in the app's own dataDir; we never log the
// token. Seeding only happens from the app's already-stored subscription row.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import { dataDir } from '../paths.js';
import { isTokenExpired } from './claude-oauth.js';
import { resolveClaudeBin } from './claude-bin.js';

const execFileAsync = promisify(execFile);

/** The app's isolated Claude config dir (env override wins). `<dataDir>/claude-config`. */
export function claudeConfigDir({ env = process.env } = {}) {
  if (env.MYCELIUM_CLAUDE_CONFIG_DIR) return env.MYCELIUM_CLAUDE_CONFIG_DIR;
  return join(dataDir({ env }), 'claude-config');
}

/** Path to the credentials file `claude` reads/writes inside the isolated dir. */
export function claudeConfigCredsPath(opts = {}) {
  return join(claudeConfigDir(opts), '.credentials.json');
}

/**
 * Seed the isolated dir with the connected subscription's creds so `claude --config-dir` auths
 * as THAT account. Idempotent + non-clobbering: if the dir ALREADY holds a token (claude has
 * been refreshing its own copy), we leave it — writing our older stored token back would undo a
 * refresh. Returns true when the dir ends up with a usable token, false when there's nothing to
 * seed (no stored token).
 *
 * @param {{claudeOAuthToken?:string, accessToken?:string, refreshToken?:string|null, expiresAt?:number|null, scopes?:string[]}|null} creds
 *        the app's stored subscription credentials (db.providers.get(...).credentials, parsed)
 */
export function seedClaudeConfigDir(creds, { env = process.env } = {}) {
  const token = creds?.claudeOAuthToken || creds?.accessToken || creds?.claudeAiOauth?.accessToken;
  const dir = claudeConfigDir({ env });
  const credsPath = join(dir, '.credentials.json');
  // Already seeded/refreshed → don't clobber claude's (possibly fresher) token.
  try {
    if (existsSync(credsPath)) {
      const cur = JSON.parse(readFileSync(credsPath, 'utf8'));
      if (typeof cur?.claudeAiOauth?.accessToken === 'string' && cur.claudeAiOauth.accessToken) return true;
    }
  } catch { /* unreadable/corrupt → re-seed below */ }
  if (!token) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = {
      claudeAiOauth: {
        accessToken: token,
        refreshToken: creds.refreshToken || null,
        expiresAt: Number.isFinite(creds.expiresAt) ? creds.expiresAt : null,
        scopes: Array.isArray(creds.scopes) && creds.scopes.length ? creds.scopes.map(String) : ['user:inference', 'user:profile'],
      },
    };
    writeFileSync(credsPath, JSON.stringify(payload), { mode: 0o600 });
    return true;
  } catch { return false; }
}

/**
 * Read the CURRENT access token from the isolated dir (claude keeps it refreshed there). The
 * native harness uses this so IT also authenticates as the connected subscription rather than
 * the machine's ~/.claude login. Null when the dir has no token yet.
 */
export function readClaudeConfigDirToken({ env = process.env } = {}) {
  try {
    const t = JSON.parse(readFileSync(claudeConfigCredsPath({ env }), 'utf8'))?.claudeAiOauth?.accessToken;
    return (typeof t === 'string' && t) ? t : null;
  } catch { return null; }
}

// ── Live token for the NATIVE wire (the real bug fixed here) ─────────────────────────────────
// On macOS, `claude` invoked with CLAUDE_CONFIG_DIR=<dir> does NOT keep its refreshed OAuth token
// in <dir>/.credentials.json (that file is only our one-time seed) NOR in the global
// `Claude Code-credentials` Keychain item (the machine login). It stores/refreshes it in a
// CONFIG-DIR-NAMESPACED Keychain generic-password item: `Claude Code-credentials-<h>` where
// `<h>` = the first 8 hex chars of sha256(<dir>). (Verified against claude-cli 2.1.x on
// 2026-07-07: the namespaced item held a valid token → HTTP 200, while the seed file and the
// global item held stale tokens → HTTP 401.)
//
// The native harness previously read only the seed file (readClaudeConfigDirToken) — a token
// frozen at connect-time — so every native channel/harness turn sent an EXPIRED Bearer → 401 →
// the provider-fallback chain silently downgraded the turn to local/EU qwen while the activity
// feed still recorded `claude-opus-4-8`. readClaudeConfigDirLiveToken reads the namespaced item
// (where claude keeps the token fresh) and prefers a NON-EXPIRED token across sources.

/** The macOS Keychain service `claude` uses for an ISOLATED config dir:
 *  `Claude Code-credentials-<first 8 hex of sha256(configDir)>`. */
export function claudeKeychainService({ env = process.env } = {}) {
  const hash = createHash('sha256').update(claudeConfigDir({ env })).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

/** Read {token, expiresAt} from the config-dir-namespaced macOS Keychain item (claude's live
 *  store). Null on non-darwin / not-found / access-declined / malformed. Never logs the token. */
async function readNamespacedKeychain({ env = process.env, execImpl = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return null;
  try {
    const { stdout } = await execImpl('security', ['find-generic-password', '-s', claudeKeychainService({ env }), '-w'], { timeout: 5000 });
    const o = JSON.parse(String(stdout || '').trim())?.claudeAiOauth;
    const token = (typeof o?.accessToken === 'string' && o.accessToken) ? o.accessToken : null;
    return token ? { token, expiresAt: Number.isFinite(o.expiresAt) ? o.expiresAt : null } : null;
  } catch { return null; }
}

/** Read {token, expiresAt} from the seeded <dir>/.credentials.json (Linux store / initial seed). */
function readCredsFileWithExpiry({ env = process.env } = {}) {
  try {
    const o = JSON.parse(readFileSync(claudeConfigCredsPath({ env }), 'utf8'))?.claudeAiOauth;
    const token = (typeof o?.accessToken === 'string' && o.accessToken) ? o.accessToken : null;
    return token ? { token, expiresAt: Number.isFinite(o.expiresAt) ? o.expiresAt : null } : null;
  } catch { return null; }
}

/**
 * The CURRENT, valid subscription access token from wherever `claude` actually keeps it fresh for
 * this isolated config dir — the config-dir-namespaced macOS Keychain item first (claude's live
 * store), then the seed file. Prefers a NON-EXPIRED token; among candidates, the latest-expiring.
 * Returns null when no non-expired token is available (the caller then refreshes or falls back to
 * the machine login / DB-stored token — never sends a token this function knows is expired).
 * @returns {Promise<string|null>}
 */
export async function readClaudeConfigDirLiveToken({ env = process.env, execImpl, platform = process.platform, now = Date.now() } = {}) {
  const cands = [];
  const kc = await readNamespacedKeychain({ env, execImpl, platform });
  if (kc) cands.push(kc);
  const file = readCredsFileWithExpiry({ env });
  if (file) cands.push(file);
  // Fail-closed: accept only a token with a KNOWN, future expiry. A null/unknown expiry (the
  // seed file when connect-time creds lacked expiresAt) is a token frozen at connect-time we can't
  // prove fresh — returning it would re-introduce the stale-Bearer→401→qwen-downgrade this fixes.
  // Rejecting it (→ null) makes the caller refresh via `claude`, which writes a real future expiry.
  const valid = cands.filter((c) => Number.isFinite(c.expiresAt) && !isTokenExpired(c.expiresAt, now));
  if (!valid.length) return null;
  valid.sort((a, b) => b.expiresAt - a.expiresAt); // freshest (latest-expiring) wins
  return valid[0].token;
}

// ── Spawn environment for `claude` (the 2026-07-08 Finder-launch auth fix) ───────────────────
// ROOT CAUSE (proven 2026-07-08): on macOS `claude` reads its OAuth credential from a Keychain
// generic-password item whose `account` attribute == process.env.USER (verified: acct="<login>";
// `env -i HOME=.. PATH=.. CLAUDE_CONFIG_DIR=.. claude -p ok` → "Not logged in", and adding USER=
// <login> → "ok"). A Finder/Dock-launched .app runs in the launchd GUI session, which does NOT
// export USER/LOGNAME (verified: every GUI-launched process — Dock, Activity Monitor, … — has an
// empty USER). The app spawns `claude` with `{ ...process.env }`, so the child inherits that
// USER-less env → `claude` can't find its Keychain login → "Not logged in" → token refresh AND
// every CLI-harness turn fail → the subscription path silently degrades to a local model. When the
// app was instead launched FROM a Claude Code session (dev), it inherited the shell's USER (and the
// SDK's delegation vars), so the bug was INVISIBLE in dev — the confound that masked it for sessions.
//
// THE FIX: inject USER/LOGNAME/HOME from os.userInfo() (getpwuid on the effective uid — the real
// login, not the inherited env), and STRIP the Claude Code / Agent-SDK context vars so `claude` is a
// standalone CLI (its own OAuth refresh via the stored refreshToken) rather than a delegated SDK
// child that expects a parent host to refresh. Stripping also makes the spawn DETERMINISTIC: a
// Finder launch and a dev CC-session launch produce the same child env, so a green dev test can no
// longer hide a broken prod path. ANTHROPIC_API_KEY is dropped so `claude` always authenticates via
// the connected subscription (OAuth), never API-key billing.

// Claude Code / Agent-SDK context vars injected into a session; stripped from the spawned `claude`.
// PREFIX-matched (not an enumerated denylist) so a FUTURE SDK version adding a new CLAUDE_CODE_* /
// CLAUDE_AGENT_SDK* delegation flag can't silently pass through and re-introduce the "delegated
// child, don't-refresh-own-token" non-determinism this fix removes. `CLAUDE_CONFIG_DIR` does NOT
// share these prefixes (CODE ≠ CONFIG), so the isolated-store pointer is never caught here.
const SDK_CONTEXT_ENV_PREFIXES = ['CLAUDE_CODE_', 'CLAUDE_AGENT_SDK'];
// Context vars that don't share those prefixes.
const SDK_CONTEXT_ENV_EXACT = new Set(['CLAUDECODE', 'AI_AGENT', 'CLAUDE_EFFORT']);
/** True if `key` is a Claude-Code / Agent-SDK context var to strip from a spawned `claude`. */
function isSdkContextVar(key) {
  return SDK_CONTEXT_ENV_EXACT.has(key) || SDK_CONTEXT_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Build the environment for spawning `claude` — with the isolated config dir + the identity vars
 * `claude` needs to find its macOS Keychain login. THE single place both spawn sites (token refresh
 * here, and the CLI-harness turn in loop-claude-cli.js) build their child env, so the fix can't drift
 * between them. See the section header for the root cause.
 *
 * @param {{env?:object, configDir?:string|null, userInfo?:()=>{username?:string,homedir?:string}}} [opts]
 *   configDir — when set, forces CLAUDE_CONFIG_DIR (the isolated store); when null, the caller's
 *   CLAUDE_CONFIG_DIR (usually unset → machine default) is preserved. userInfo is injectable for tests.
 * @returns {object} the child env
 */
export function claudeSpawnEnv({ env = process.env, configDir = null, userInfo = () => os.userInfo() } = {}) {
  const out = { ...env };
  for (const k of Object.keys(out)) { if (isSdkContextVar(k)) delete out[k]; }
  delete out.ANTHROPIC_API_KEY; // force subscription (OAuth) auth — never API-key billing
  let ui = null;
  try { ui = userInfo(); } catch { ui = null; } // getpwuid failed (rare) → leave USER/HOME as inherited
  // USER/LOGNAME set from the EFFECTIVE-uid login (os.userInfo → getpwuid) — this is the account
  // `claude`'s macOS Keychain lookup filters on, so it's authoritative even when the inherited env
  // has no USER (Finder launch) or a divergent one (e.g. `sudo -E`, euid≠env USER).
  if (ui && typeof ui.username === 'string' && ui.username) { out.USER = ui.username; out.LOGNAME = ui.username; }
  if (ui && typeof ui.homedir === 'string' && ui.homedir && !out.HOME) out.HOME = ui.homedir;
  if (configDir) out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

// ── ToS-clean refresh (#10: we never mint/refresh tokens ourselves — `claude` does) ─────────────
// When the isolated dir's token has lapsed (e.g. an owner who only uses Telegram, so no CLI turn
// has run to refresh it within the ~8h token life), spawn `claude` briefly so IT refreshes its own
// token in the namespaced store, then re-read. Single-flight + cooldown so a burst of turns causes
// at most one spawn; fail-soft (resolves null on any error). Empty MCP + a trivial prompt: this
// touches only OAuth + a tiny inference call, never the vault.
let _refreshInFlight = null;
let _lastRefreshAt = 0;
const REFRESH_COOLDOWN_MS = 60_000;

export function _resetClaudeRefreshForTests() { _refreshInFlight = null; _lastRefreshAt = 0; }

/**
 * @returns {Promise<string|null>} the freshly-refreshed token, or null if refresh is unavailable.
 */
export async function refreshClaudeConfigDirToken({ env = process.env, now = Date.now(), claudeBin, spawnImpl = execFileAsync, platform = process.platform } = {}) {
  if (_refreshInFlight) return _refreshInFlight;
  if (now - _lastRefreshAt < REFRESH_COOLDOWN_MS) return null; // don't hammer `claude` when it keeps failing
  _lastRefreshAt = now;
  _refreshInFlight = (async () => {
    try {
      const bin = claudeBin !== undefined ? claudeBin : resolveClaudeBin({ env });
      if (!bin) return null;
      const dir = claudeConfigDir({ env });
      // `claude -p` is non-interactive and exits after one turn, refreshing its token en route.
      // Confinement mirrors loop-claude-cli.js: empty MCP + `--strict-mcp-config` (ignore the
      // account connectors) + `--tools mcp__mycelium__*` against an empty server → an EMPTY toolset
      // (strips built-in Bash/Edit/Write/Read — `--strict-mcp-config` alone does NOT, per that
      // module's live spike). The prompt is a fixed 'ok' with no tool need, so the child does a
      // pure OAuth-refresh + trivial inference and can touch neither the vault nor the host.
      await spawnImpl(bin, [
        '-p', 'ok',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--tools', 'mcp__mycelium__*', '--allowedTools', 'mcp__mycelium__*',
        '--max-turns', '1',
      ], {
        // claudeSpawnEnv injects USER/LOGNAME (absent in a Finder/Dock launch → `claude` can't find
        // its Keychain login → refresh no-ops) + strips SDK-delegation vars so `claude` refreshes its
        // OWN token here rather than delegating to a (nonexistent) parent host. See the section header.
        env: claudeSpawnEnv({ env, configDir: dir }), timeout: 30_000, maxBuffer: 1 << 20,
      });
      return await readClaudeConfigDirLiveToken({ env, platform, now });
    } catch { return null; }
    finally { _refreshInFlight = null; }
  })();
  return _refreshInFlight;
}

// ── Proactive keep-warm (durability) ─────────────────────────────────────────────────────────
// The subscription token lives ~8h. An owner who ONLY uses Telegram/Discord (never a CLI chat)
// never triggers the on-demand refresh, so the token lapses; the FIRST channel turn after expiry
// then races the 6s refresh and falls back to a slow LOCAL model (verified live 2026-07-07:
// model=qwen3.5:4b, 101s, degraded). Keep it warm: refresh shortly after boot, then on an interval
// SHORTER than the token life, so a channel turn never meets an expired token. Idempotent (single
// timer), fail-soft (never throws), unref'd (never holds the process open).
let _proactiveTimer = null;
const PROACTIVE_REFRESH_MS = Number(process.env.MYCELIUM_TOKEN_REFRESH_MS) || 6 * 60 * 60 * 1000; // 6h < ~8h life

/** Stop the proactive keep-warm timer (idempotent). */
export function stopProactiveTokenRefresh() {
  if (_proactiveTimer) { clearInterval(_proactiveTimer); _proactiveTimer = null; }
}

/**
 * Start a background timer that keeps the isolated config-dir subscription token fresh, so a
 * channel/native turn never hits an expired token (→ silent fallback to a local model).
 * Refreshes ~5s after boot (covers a token that was already stale at startup) and every
 * `intervalMs` thereafter. Returns the stop function. No-op wiring is safe: fail-soft throughout.
 * @param {{env?:object, intervalMs?:number, logger?:(m:string)=>void}} [opts]
 */
export function startProactiveTokenRefresh({ env = process.env, intervalMs = PROACTIVE_REFRESH_MS, bootDelayMs = 5_000, logger = () => {}, refreshImpl = refreshClaudeConfigDirToken } = {}) {
  stopProactiveTokenRefresh();
  const tick = async (reason) => {
    try {
      const t = await refreshImpl({ env });
      logger(t ? `claude token proactively refreshed (${reason})` : `claude token proactive refresh unavailable (${reason})`);
    } catch { /* fail-soft: a refresh failure must never destabilize the app */ }
  };
  const boot = setTimeout(() => { tick('boot'); }, bootDelayMs);
  boot.unref?.();
  _proactiveTimer = setInterval(() => { tick('interval'); }, Math.max(60_000, intervalMs));
  _proactiveTimer.unref?.();
  return stopProactiveTokenRefresh;
}

export default claudeConfigDir;
