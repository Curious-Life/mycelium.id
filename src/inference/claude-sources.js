// Where a Claude subscription credential can live — ONE ordered probe over EVERY
// known store, with an honest, discriminated result.
// Design: docs/CLAUDE-SUBSCRIPTION-DESIGN-2026-07-15.md §3.2 (the connect ladder).
//
// WHY THIS EXISTS (the "worked on one device but not another" bug):
// `claude` NAMESPACES its macOS Keychain item by config dir —
//   default  ~/.claude        -> "Claude Code-credentials"
//   isolated <dir>            -> "Claude Code-credentials-<first 8 hex of sha256(dir)>"
// (this repo documents that rule in claude-config-dir.js:claudeKeychainService).
// The old automatic fetch (claude-oauth.js) read ONLY the unsuffixed name, so a
// machine whose CLI used an isolated config dir reported "no login" while being
// perfectly signed in. Deterministic, not flaky. We probe ALL of them.
//
// ALSO: on macOS the CLI keeps creds in the Keychain and `~/.claude/.credentials.json`
// is usually ABSENT — so the Keychain is the real source, not the file.
//
// HONESTY: the old code collapsed "Keychain access DECLINED" into "no login"
// (claude-oauth.js: `catch { return null; }`), telling a signed-in user to sign in.
// We distinguish absent / declined / wrong_scope so the UI can act correctly and
// the connect ladder can fall through to the web flow for the right reasons.
//
// SECURITY: a token value is NEVER logged, echoed, or returned in an error. Only
// the SOURCE KIND and status travel outward.

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeConfigCredsPath, claudeKeychainService } from './claude-config-dir.js';

const execFileAsync = promisify(execFile);

/** The scope a real subscription login carries; `claude setup-token` artifacts lack it. */
export const REQUIRED_SCOPE = 'user:inference';

/** The default (non-namespaced) Keychain item — `claude` with the default ~/.claude dir. */
export const DEFAULT_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Ordered source kinds. Order = precedence when several hold a credential. */
export const SOURCE_KINDS = Object.freeze([
  'config-dir-file',      // <dataDir>/claude-config/.credentials.json — our own seeded store
  'keychain-namespaced',  // Claude Code-credentials-<hash> — claude's live store for our isolated dir
  'keychain-default',     // Claude Code-credentials — claude's live store for the DEFAULT ~/.claude dir
  'cli-file',             // ~/.claude/.credentials.json — Linux / headless / exported login
  'env-token',            // CLAUDE_CODE_OAUTH_TOKEN — the only DOCUMENTED/sanctioned surface
]);

/** Normalize a `claudeAiOauth` blob → creds, or null. Never throws. */
function normalize(raw) {
  let o;
  try { o = JSON.parse(String(raw || '').trim())?.claudeAiOauth; } catch { return null; }
  const token = (typeof o?.accessToken === 'string' && o.accessToken) ? o.accessToken : null;
  if (!token) return null;
  return {
    claudeOAuthToken: token,
    refreshToken: (typeof o.refreshToken === 'string' && o.refreshToken) ? o.refreshToken : null,
    expiresAt: Number.isFinite(o.expiresAt) ? o.expiresAt : null,
    scopes: Array.isArray(o.scopes) ? o.scopes.map(String) : [],
  };
}

/**
 * Read one Keychain generic-password item.
 * @returns {Promise<{state:'found'|'absent'|'declined', raw?:string}>}
 *   `absent`   — the item genuinely isn't there (security exit 44 / "could not be found")
 *   `declined` — the item may exist but access was denied/cancelled (user interaction blocked,
 *                or a GUI-launched process with no Keychain session). NOT the same as absent.
 */
async function readKeychainItem(service, { execImpl = execFileAsync, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { state: 'absent' };
  try {
    const { stdout } = await execImpl('security', ['find-generic-password', '-s', service, '-w'], { timeout: 5000 });
    const raw = String(stdout || '').trim();
    return raw ? { state: 'found', raw } : { state: 'absent' };
  } catch (e) {
    // `security` exits 44 with "could not be found" when the item does not exist.
    // Anything else (access denied, interaction not allowed, user cancelled) is a
    // DECLINE — the credential may well be there and we must not claim "no login".
    const msg = String(e?.stderr || e?.message || '');
    const code = e?.code;
    if (code === 44 || /could not be found/i.test(msg)) return { state: 'absent' };
    return { state: 'declined' };
  }
}

/** Read a credentials JSON file. Never throws. */
async function readCredFile(path, readImpl) {
  try { return await (readImpl ? readImpl(path) : readFile(path, 'utf8')); } catch { return null; }
}

/**
 * Probe EVERY known credential store, in order, and report honestly.
 *
 * Never throws. Never logs or returns a token value.
 *
 * @returns {Promise<{
 *   status: 'found'|'absent'|'declined'|'wrong_scope',
 *   creds?: {claudeOAuthToken:string, refreshToken:string|null, expiresAt:number|null, scopes:string[]},
 *   source?: string,          // which SOURCE_KIND supplied it
 *   expired?: boolean,        // found-but-expired (caller refreshes rather than prompting)
 *   declinedSources?: string[],// sources that denied access (⇒ actionable, not "no login")
 *   scopesSeen?: string[],     // for wrong_scope: what we actually got (non-secret)
 * }>}
 */
export async function probeClaudeCredential({
  env = process.env, execImpl, readImpl, platform = process.platform, now = Date.now(),
} = {}) {
  const declinedSources = [];
  const candidates = [];   // {source, creds}
  let sawWrongScope = null;

  const consider = (source, raw) => {
    const creds = normalize(raw);
    if (!creds) return;
    if (!creds.scopes.includes(REQUIRED_SCOPE)) {
      // A `claude setup-token` admin artifact — real credential, wrong kind. Remember it
      // so we can EXPLAIN the fall-through to the web prompt instead of dead-ending.
      if (!sawWrongScope) sawWrongScope = { source, scopesSeen: creds.scopes };
      return;
    }
    candidates.push({ source, creds });
  };

  // 1. our own seeded store
  consider('config-dir-file', await readCredFile(claudeConfigCredsPath({ env }), readImpl));

  // 2 + 3. the Keychain items — namespaced (our isolated dir) AND default (~/.claude).
  //        Probing BOTH is the fix for the device-to-device bug.
  for (const [kind, service] of [
    ['keychain-namespaced', claudeKeychainService({ env })],
    ['keychain-default', DEFAULT_KEYCHAIN_SERVICE],
  ]) {
    const r = await readKeychainItem(service, { execImpl, platform });
    if (r.state === 'declined') { declinedSources.push(kind); continue; }
    if (r.state === 'found') consider(kind, r.raw);
  }

  // 4. the CLI's file store (Linux/headless; usually absent on macOS)
  consider('cli-file', await readCredFile(join(homedir(), '.claude', '.credentials.json'), readImpl));

  // 5. the sanctioned env token (CLAUDE_CODE_OAUTH_TOKEN). A BARE token — no blob, so
  //    no scopes and no expiry are knowable here.
  //    We must NOT fabricate `user:inference`: this env var is produced by
  //    `claude setup-token`, which is exactly the admin artifact the other two rungs
  //    reject (claude-oauth.js / exchangeCode's scope guard). Asserting the scope
  //    would let a setup-token persist as a subscription — two paths guarding and one
  //    lying. Report scopes as UNKNOWN (empty) and let the API be the arbiter; a real
  //    rejection then surfaces loudly at turn time rather than being pre-blessed here.
  const envTok = typeof env.CLAUDE_CODE_OAUTH_TOKEN === 'string' ? env.CLAUDE_CODE_OAUTH_TOKEN.trim() : '';
  if (envTok) {
    candidates.push({
      source: 'env-token',
      scopeUnknown: true,
      creds: { claudeOAuthToken: envTok, refreshToken: null, expiresAt: null, scopes: [] },
    });
  }

  if (candidates.length) {
    // Prefer a NON-EXPIRED credential; among those, SOURCE PRECEDENCE decides — expiry is
    // only a tiebreak WITHIN a source.
    //
    // Ordering by expiry alone was a real bug: the machine's own `claude` CLI refreshes its
    // login continuously, so `keychain-default` (the MACHINE account) almost always carries a
    // LATER expiry than our seeded `config-dir-file`, whose expiry is frozen at connect time.
    // Sorting by expiry therefore picked the machine login over the subscription the user
    // deliberately connected — and persistSubscription would then overwrite the connected
    // account with it. That is exactly the failure the isolated config dir exists to cure
    // (the app authenticating as the machine's account instead of the connected one).
    // SOURCE_KINDS order encodes intent: our own store and our isolated-dir keychain item
    // outrank the machine's default login.
    const rank = (s) => { const i = SOURCE_KINDS.indexOf(s); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    const live = candidates.filter((c) => c.creds.expiresAt == null || c.creds.expiresAt > now);
    const pick = (live.length ? live : candidates)
      .slice()
      .sort((a, b) => rank(a.source) - rank(b.source) || (b.creds.expiresAt ?? 0) - (a.creds.expiresAt ?? 0))[0];
    const expired = pick.creds.expiresAt != null && pick.creds.expiresAt <= now;
    return {
      status: 'found', creds: pick.creds, source: pick.source, expired, declinedSources,
      // true ⇒ we could not verify user:inference (bare env token). The caller must not
      // present this as a proven subscription; the API decides at turn time.
      ...(pick.scopeUnknown ? { scopeUnknown: true } : {}),
    };
  }

  // A real credential existed but was the wrong kind → say so; the ladder falls through
  // to the web prompt WITH a reason instead of a dead end.
  if (sawWrongScope) return { status: 'wrong_scope', source: sawWrongScope.source, scopesSeen: sawWrongScope.scopesSeen, declinedSources };

  // Access was denied somewhere → the user is likely signed in; do NOT claim "no login".
  if (declinedSources.length) return { status: 'declined', declinedSources };

  return { status: 'absent', declinedSources };
}
