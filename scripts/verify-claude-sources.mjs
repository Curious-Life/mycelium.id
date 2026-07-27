// verify:claude-sources — the ordered credential probe (src/inference/claude-sources.js).
// Guards the connect ladder's "automatic first" half.
//
//   S1 ⭐ NAMESPACED keychain item alone is FOUND  ← the "worked on one device but not
//         another" bug: claude namespaces by config dir; the old fetch read only the
//         unsuffixed name and reported "no login" on a signed-in machine.
//   S2    DEFAULT (unsuffixed) keychain item is found
//   S3 ⭐ DECLINED ≠ ABSENT — access denied must NOT be reported as "no login"
//   S4    truly absent → 'absent'
//   S5    setup-token artifact (no user:inference) → 'wrong_scope' + scopesSeen
//   S6    found-but-EXPIRED → status 'found' + expired:true (caller refreshes, no prompt)
//   S7    precedence: prefers a NON-EXPIRED credential over an expired one
//   S8    sanctioned CLAUDE_CODE_OAUTH_TOKEN env is honored
//   S9 🔒 no token value ever appears in the returned status/error surface
//
// Pure + injected (execImpl/readImpl) — never touches a real Keychain or CLI.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { probeClaudeCredential, SOURCE_KINDS, DEFAULT_KEYCHAIN_SERVICE } from '../src/inference/claude-sources.js';
import { claudeKeychainService } from '../src/inference/claude-config-dir.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const SECRET = 'sk-ant-oat-SUPERSECRET-do-not-leak';
const ENV = { MYCELIUM_DATA_DIR: '/tmp/verify-claude-sources-data' };
const blob = (over = {}) => JSON.stringify({
  claudeAiOauth: { accessToken: SECRET, refreshToken: 'rt-1', expiresAt: Date.now() + 3600e3, scopes: ['user:inference', 'user:profile'], ...over },
});
const NS_SERVICE = claudeKeychainService({ env: ENV });
// no files anywhere unless a test says so
const noFiles = async () => { throw new Error('ENOENT'); };
// build an execImpl that only "has" the named services
const kc = (map) => async (_bin, args) => {
  const svc = args[args.indexOf('-s') + 1];
  if (Object.prototype.hasOwnProperty.call(map, svc)) {
    const v = map[svc];
    if (v === 'DECLINE') { const e = new Error('User interaction is not allowed.'); e.code = 51; throw e; }
    return { stdout: v };
  }
  const e = new Error('The specified item could not be found in the keychain.'); e.code = 44; throw e;
};

// ── S1 ⭐ namespaced-only → FOUND (the device-to-device bug) ─────────────────────
{
  const r = await probeClaudeCredential({ env: ENV, platform: 'darwin', readImpl: noFiles, execImpl: kc({ [NS_SERVICE]: blob() }) });
  rec('S1 ⭐ namespaced-ONLY keychain item is found (the one-device-yes-one-no bug)',
    r.status === 'found' && r.source === 'keychain-namespaced' && r.creds.claudeOAuthToken === SECRET,
    `status=${r.status} source=${r.source}`);
}
// ── S2 default-only → FOUND ──────────────────────────────────────────────────────
{
  const r = await probeClaudeCredential({ env: ENV, platform: 'darwin', readImpl: noFiles, execImpl: kc({ [DEFAULT_KEYCHAIN_SERVICE]: blob() }) });
  rec('S2 default (unsuffixed) keychain item is found', r.status === 'found' && r.source === 'keychain-default');
}
// ── S3 ⭐ declined ≠ absent ───────────────────────────────────────────────────────
{
  const r = await probeClaudeCredential({ env: ENV, platform: 'darwin', readImpl: noFiles, execImpl: kc({ [NS_SERVICE]: 'DECLINE', [DEFAULT_KEYCHAIN_SERVICE]: 'DECLINE' }) });
  rec('S3 ⭐ Keychain DECLINED reports "declined", never "absent"/no-login',
    r.status === 'declined' && r.declinedSources.includes('keychain-namespaced'),
    `status=${r.status} declined=${JSON.stringify(r.declinedSources)}`);
}
// ── S4 absent ────────────────────────────────────────────────────────────────────
{
  const r = await probeClaudeCredential({ env: { ...ENV }, platform: 'darwin', readImpl: noFiles, execImpl: kc({}) });
  rec('S4 nothing anywhere → absent (the new-device case → web prompt)', r.status === 'absent');
}
// ── S5 wrong scope (setup-token artifact) ────────────────────────────────────────
{
  const r = await probeClaudeCredential({ env: ENV, platform: 'darwin', readImpl: noFiles,
    execImpl: kc({ [NS_SERVICE]: blob({ scopes: ['org:create_api_key'] }) }) });
  rec('S5 setup-token artifact → wrong_scope (+ scopesSeen), not a dead end',
    r.status === 'wrong_scope' && Array.isArray(r.scopesSeen) && !r.scopesSeen.includes('user:inference'),
    `status=${r.status} scopesSeen=${JSON.stringify(r.scopesSeen)}`);
}
// ── S6 expired → found + expired (refresh, don't prompt) ─────────────────────────
{
  const r = await probeClaudeCredential({ env: ENV, platform: 'darwin', readImpl: noFiles,
    execImpl: kc({ [NS_SERVICE]: blob({ expiresAt: Date.now() - 1000 }) }) });
  rec('S6 found-but-expired → found + expired:true (caller refreshes, no prompt)',
    r.status === 'found' && r.expired === true);
}
// ── S7 precedence: non-expired wins ──────────────────────────────────────────────
{
  const fresh = Date.now() + 7200e3;
  const r = await probeClaudeCredential({ env: ENV, platform: 'darwin', readImpl: noFiles,
    execImpl: kc({ [NS_SERVICE]: blob({ expiresAt: Date.now() - 1000, accessToken: 'stale' }), [DEFAULT_KEYCHAIN_SERVICE]: blob({ expiresAt: fresh }) }) });
  rec('S7 prefers the NON-EXPIRED credential across sources',
    r.status === 'found' && r.expired === false && r.creds.claudeOAuthToken === SECRET,
    `source=${r.source} expired=${r.expired}`);
}
// ── S7b ⭐ SOURCE PRECEDENCE beats a later expiry (the connected account wins) ────
// The machine's own `claude` CLI refreshes continuously, so keychain-default (the
// MACHINE login) almost always has a LATER expiry than our seeded config-dir-file
// (frozen at connect). Sorting by expiry alone picked the MACHINE account over the
// subscription the user deliberately connected — and connect would then overwrite the
// connected account with it. Both are LIVE here; precedence must decide, not expiry.
{
  const B = JSON.stringify({ claudeAiOauth: { accessToken: 'TOKEN-CONNECTED-B', refreshToken: 'rb', expiresAt: Date.now() + 60_000, scopes: ['user:inference'] } });
  const A = JSON.stringify({ claudeAiOauth: { accessToken: 'TOKEN-MACHINE-A', refreshToken: 'ra', expiresAt: Date.now() + 900_000, scopes: ['user:inference'] } });
  const r = await probeClaudeCredential({
    env: ENV, platform: 'darwin',
    readImpl: async (p) => (String(p).includes('claude-config') ? B : (() => { throw new Error('ENOENT'); })()),
    execImpl: kc({ [DEFAULT_KEYCHAIN_SERVICE]: A }),   // machine login, later expiry
  });
  rec('S7b ⭐ our connected store outranks the machine login even when the machine expiry is later',
    r.status === 'found' && r.source === 'config-dir-file' && r.creds.claudeOAuthToken === 'TOKEN-CONNECTED-B',
    `source=${r.source} token=${r.creds?.claudeOAuthToken}`);
}

// ── S8 sanctioned env token — honored, but its scope is NOT fabricated ───────────
// A bare CLAUDE_CODE_OAUTH_TOKEN comes from `claude setup-token` — the very artifact
// the other rungs reject. Asserting user:inference here would let a setup-token
// persist as a subscription (two paths guarding, one lying). Report scopes UNKNOWN.
{
  const r = await probeClaudeCredential({ env: { ...ENV, CLAUDE_CODE_OAUTH_TOKEN: 'env-tok' }, platform: 'darwin', readImpl: noFiles, execImpl: kc({}) });
  rec('S8 env token honored but scope NOT fabricated (scopeUnknown, empty scopes)',
    r.status === 'found' && r.source === 'env-token' && r.creds.claudeOAuthToken === 'env-tok' &&
    r.scopeUnknown === true && r.creds.scopes.length === 0,
    `scopeUnknown=${r.scopeUnknown} scopes=${JSON.stringify(r.creds.scopes)}`);
}
// ── S9 🔒 no secret leaks into the reported surface ───────────────────────────────
{
  const r = await probeClaudeCredential({ env: ENV, platform: 'darwin', readImpl: noFiles, execImpl: kc({ [NS_SERVICE]: blob() }) });
  const surface = JSON.stringify({ status: r.status, source: r.source, expired: r.expired, declinedSources: r.declinedSources, scopesSeen: r.scopesSeen });
  rec('S9 🔒 status surface carries no token value', !surface.includes(SECRET), `surface=${surface}`);
}
// ── S10 non-darwin skips keychain cleanly ────────────────────────────────────────
{
  const r = await probeClaudeCredential({ env: ENV, platform: 'linux', readImpl: noFiles, execImpl: kc({ [NS_SERVICE]: blob() }) });
  rec('S10 non-darwin → keychain skipped, reports absent (file/env are the stores there)', r.status === 'absent');
}

rec('S11 SOURCE_KINDS documents all five stores', SOURCE_KINDS.length === 5 && SOURCE_KINDS.includes('keychain-namespaced') && SOURCE_KINDS.includes('env-token'));

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — credential probe: all stores, namespaced item found, declined≠absent, no leak');
