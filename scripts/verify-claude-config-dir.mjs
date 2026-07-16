// verify:claude-config-dir — the ISOLATED Claude Code credential store (src/inference/
// claude-config-dir.js) + its wiring into the CLI spawn. Proves the app can run `claude` as
// the CONNECTED subscription account, decoupled from the machine's ~/.claude login.
//   CD1 seed writes the claudeAiOauth shape at <dir>/.credentials.json (0600)
//   CD2 readClaudeConfigDirToken round-trips the token
//   CD3 re-seed does NOT clobber an existing token (claude owns the refresh in that dir)
//   CD4 no token → no file (nothing to seed)
//   CD5 the CLI loop injects CLAUDE_CONFIG_DIR into the spawned child's env when configDir set
//   CD6 no configDir → CLAUDE_CONFIG_DIR is NOT forced (machine default preserved)
import { seedClaudeConfigDir, readClaudeConfigDirToken, claudeConfigCredsPath,
  claudeKeychainService, readClaudeConfigDirLiveToken, refreshClaudeConfigDirToken,
  startProactiveTokenRefresh, stopProactiveTokenRefresh, claudeSpawnEnv,
  _resetClaudeRefreshForTests } from '../src/inference/claude-config-dir.js';
import { createClaudeCliLoop } from '../src/agent/loop-claude-cli.js';
import { rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

process.env.MYCELIUM_CLAUDE_CONFIG_DIR = '/tmp/verify-myc-cfg';
const clean = () => rmSync('/tmp/verify-myc-cfg', { recursive: true, force: true });
clean();

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// CD1 + CD2
rec('CD1 seed writes creds', seedClaudeConfigDir({ claudeOAuthToken: 'sk-ant-oat-A', refreshToken: 'rt', expiresAt: 42, scopes: ['user:inference'] }) === true && existsSync(claudeConfigCredsPath()));
{
  const j = JSON.parse(readFileSync(claudeConfigCredsPath(), 'utf8'));
  rec('CD1 shape = claudeAiOauth.{accessToken,refreshToken,expiresAt,scopes}', j.claudeAiOauth?.accessToken === 'sk-ant-oat-A' && j.claudeAiOauth?.refreshToken === 'rt' && j.claudeAiOauth?.expiresAt === 42 && Array.isArray(j.claudeAiOauth?.scopes));
  const mode = statSync(claudeConfigCredsPath()).mode & 0o777;
  rec('CD1 creds file is 0600 (owner-only)', mode === 0o600, `mode=${mode.toString(8)}`);
}
rec('CD2 readClaudeConfigDirToken round-trips', readClaudeConfigDirToken() === 'sk-ant-oat-A');
// CD3 non-clobber
seedClaudeConfigDir({ claudeOAuthToken: 'sk-ant-oat-NEWER' });
rec('CD3 re-seed does NOT clobber (claude owns refresh in the dir)', readClaudeConfigDirToken() === 'sk-ant-oat-A');
// CD4 nothing to seed
clean();
rec('CD4 no token → false + no file', seedClaudeConfigDir({}) === false && !existsSync(claudeConfigCredsPath()) && readClaudeConfigDirToken() === null);

// CD5 / CD6 — CLI spawn env
const mkChild = () => ({ stdout: { on() {} }, stderr: { on() {} }, stdin: { write() {}, end() {} }, on(ev, cb) { if (ev === 'close') setTimeout(() => cb(0), 5); }, kill() {} });
let env = null;
const spy = (bin, args, opts) => { env = opts.env; return mkChild(); };
await createClaudeCliLoop({ claudeBin: '/bin/true', restPort: 8787, configDir: '/tmp/cfg-x', writeConfigImpl: () => {}, cleanupImpl: () => {}, spawnImpl: spy }).run({ system: 's', userMessage: 'hi', send: () => {} });
rec('CD5 CLI spawn injects CLAUDE_CONFIG_DIR', env?.CLAUDE_CONFIG_DIR === '/tmp/cfg-x', String(env?.CLAUDE_CONFIG_DIR));
env = null;
await createClaudeCliLoop({ claudeBin: '/bin/true', restPort: 8787, writeConfigImpl: () => {}, cleanupImpl: () => {}, spawnImpl: spy }).run({ system: 's', userMessage: 'hi', send: () => {} });
rec('CD6 no configDir → not forced (machine default)', env?.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR);

// ── CD7-CD12: the LIVE token path (the 2026-07-07 fix: read where `claude` keeps the token
// fresh — the config-dir-namespaced macOS Keychain item — expiry-aware, with a ToS-clean refresh).
clean();
const DIR = process.env.MYCELIUM_CLAUDE_CONFIG_DIR; // '/tmp/verify-myc-cfg'
const H = createHash('sha256').update(DIR).digest('hex').slice(0, 8);
rec('CD7 keychain service = `Claude Code-credentials-<sha256(dir)[:8]>`', claudeKeychainService() === `Claude Code-credentials-${H}`, claudeKeychainService());

const now = 1_000_000_000_000;
const kcItem = (tok, expMsFromNow) => async () => ({ stdout: JSON.stringify({ claudeAiOauth: { accessToken: tok, expiresAt: now + expMsFromNow } }) });
const kcMiss = async () => { throw new Error('not found'); };

// CD8: darwin — a FRESH namespaced-keychain token wins over the (stale) seed file.
seedClaudeConfigDir({ claudeOAuthToken: 'sk-file-STALE', expiresAt: now - 9_000_000 }); // seed file expired
{
  const t = await readClaudeConfigDirLiveToken({ execImpl: kcItem('sk-kc-FRESH', 30 * 60_000), platform: 'darwin', now });
  rec('CD8 darwin: fresh namespaced-keychain token preferred over stale seed file', t === 'sk-kc-FRESH', String(t));
}
// CD9: darwin — keychain MISSING → falls back to the seed file token (when the file is still valid).
clean();
seedClaudeConfigDir({ claudeOAuthToken: 'sk-file-VALID', expiresAt: now + 60 * 60_000 });
{
  const t = await readClaudeConfigDirLiveToken({ execImpl: kcMiss, platform: 'darwin', now });
  rec('CD9 darwin: keychain miss → valid seed file token used', t === 'sk-file-VALID', String(t));
}
// CD10: ALL sources expired → null (never returns a token it knows is expired → caller refreshes/falls back).
clean();
seedClaudeConfigDir({ claudeOAuthToken: 'sk-file-EXP', expiresAt: now - 1 });
{
  const t = await readClaudeConfigDirLiveToken({ execImpl: kcItem('sk-kc-EXP', -1), platform: 'darwin', now });
  rec('CD10 all sources expired → null (no expired token sent)', t === null, String(t));
}
// CD11: non-darwin — keychain never read (execImpl untouched), only the file store consulted.
clean();
seedClaudeConfigDir({ claudeOAuthToken: 'sk-file-LINUX', expiresAt: now + 60 * 60_000 });
{
  let kcRead = false;
  const t = await readClaudeConfigDirLiveToken({ execImpl: async () => { kcRead = true; return { stdout: '{}' }; }, platform: 'linux', now });
  rec('CD11 non-darwin: keychain not consulted, file token used', t === 'sk-file-LINUX' && kcRead === false, `t=${t} kcRead=${kcRead}`);
}
// CD11b (fail-closed, C2): keychain token KNOWN-expired + a NULL-expiry seed → null (never return a
// token we can't prove fresh — that would re-introduce the stale-Bearer→401→qwen downgrade).
clean();
seedClaudeConfigDir({ claudeOAuthToken: 'sk-file-NULLEXP' }); // no expiresAt → null
{
  const t = await readClaudeConfigDirLiveToken({ execImpl: kcItem('sk-kc-EXP', -1), platform: 'darwin', now });
  rec('CD11b fail-closed: kc known-expired + null-expiry seed → null (no unprovable token)', t === null, `t=${t}`);
}
// CD11c: a null-expiry token alone is NOT usable (must have a known future expiry).
clean();
seedClaudeConfigDir({ claudeOAuthToken: 'sk-file-NULLONLY' });
{
  const t = await readClaudeConfigDirLiveToken({ execImpl: kcMiss, platform: 'darwin', now });
  rec('CD11c fail-closed: null-expiry-only → null', t === null, `t=${t}`);
}
// CD12: refresh spawns `claude` (ToS-clean, #10 — we never mint) with CLAUDE_CONFIG_DIR, then re-reads
// the refreshed token. Cooldown: an immediate second call within the window does NOT re-spawn.
clean();
{
  _resetClaudeRefreshForTests();
  let spawnEnv = null, spawnArgs = null, spawns = 0;
  // The spawn "refreshes" by writing a fresh token to the seed file, which the re-read then returns.
  const spawnImpl = async (bin, args, opts) => { spawns++; spawnArgs = args; spawnEnv = opts?.env; seedClaudeConfigDir({ claudeOAuthToken: 'sk-REFRESHED', expiresAt: now + 60 * 60_000 }); return { stdout: 'ok' }; };
  const t = await refreshClaudeConfigDirToken({ claudeBin: '/bin/claude', spawnImpl, platform: 'linux', now });
  const ai = spawnArgs.indexOf('--mcp-config');
  // Confinement (C3): strict MCP + EMPTY server + toolset restricted to mcp__mycelium__* (→ no
  // built-in Bash/Edit/Write/Read, matching loop-claude-cli.js), non-interactive single turn.
  const confined = Array.isArray(spawnArgs)
    && spawnArgs.includes('--strict-mcp-config')
    && spawnArgs[ai + 1] === '{"mcpServers":{}}'
    && spawnArgs[spawnArgs.indexOf('--tools') + 1] === 'mcp__mycelium__*'
    && spawnArgs[spawnArgs.indexOf('--allowedTools') + 1] === 'mcp__mycelium__*'
    && spawnArgs.includes('--max-turns');
  rec('CD12 refresh: spawns confined claude w/ CLAUDE_CONFIG_DIR, returns refreshed token', t === 'sk-REFRESHED' && spawnEnv?.CLAUDE_CONFIG_DIR === DIR && confined, `t=${t} spawns=${spawns} confined=${confined}`);
  const t2 = await refreshClaudeConfigDirToken({ claudeBin: '/bin/claude', spawnImpl, platform: 'linux', now: now + 1000 });
  rec('CD12 refresh cooldown: 2nd call within window does not re-spawn', spawns === 1 && t2 === null, `spawns=${spawns} t2=${t2}`);
  // No binary → null, no spawn.
  _resetClaudeRefreshForTests();
  let spawned2 = false;
  const t3 = await refreshClaudeConfigDirToken({ claudeBin: null, spawnImpl: async () => { spawned2 = true; return {}; }, platform: 'linux', now: now + 999_999 });
  rec('CD12 refresh: no claude binary → null (no spawn)', t3 === null && spawned2 === false, `t3=${t3} spawned=${spawned2}`);
}

// CD13: proactive keep-warm — refreshes shortly after boot + on the interval, so a channel turn
// never meets an expired token (the durability fix for the Telegram-only owner). Fail-soft + idempotent.
clean();
{
  let calls = 0; const reasons = [];
  const refreshImpl = async () => { calls++; return 'sk-KEEPWARM'; };
  const stop = startProactiveTokenRefresh({ intervalMs: 60_000, bootDelayMs: 10, refreshImpl, logger: (m) => reasons.push(m) });
  await new Promise((r) => setTimeout(r, 40));   // let the boot tick fire
  rec('CD13 proactive: boot tick refreshes the token', calls >= 1, `calls=${calls}`);
  rec('CD13 proactive: returns a stop function', typeof stop === 'function');
  stop(); stop();   // idempotent
  const after = calls;
  await new Promise((r) => setTimeout(r, 20));
  rec('CD13 proactive: stop() halts further ticks (idempotent)', calls === after, `after=${after} now=${calls}`);
  // A throwing refresh must NOT escape (fail-soft) — start, let it tick, no unhandled rejection.
  const stop2 = startProactiveTokenRefresh({ intervalMs: 60_000, bootDelayMs: 10, refreshImpl: async () => { throw new Error('boom'); } });
  await new Promise((r) => setTimeout(r, 30));
  rec('CD13 proactive: a throwing refresh is swallowed (fail-soft)', true);
  stop2();
}

// ── CD14: the Finder-launch auth fix (claudeSpawnEnv) — a Finder/Dock-launched macOS app has NO
// USER (launchd GUI session); `claude`'s macOS Keychain login lookup filters by account=$USER, so
// without it `claude` reports "Not logged in" → refresh + every CLI turn fail → silent local-model
// downgrade. claudeSpawnEnv injects USER/LOGNAME/HOME + strips SDK-delegation vars (deterministic
// standalone child) + drops ANTHROPIC_API_KEY (force subscription OAuth, not API-key billing).
{
  const fakeUser = () => ({ username: 'testlogin', homedir: '/home/testlogin' });
  // A Finder-like env: NO USER/LOGNAME, but carrying SDK-delegation + API-key vars.
  const finderish = {
    PATH: '/usr/bin', HOME: '/existing/home',
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH: '1',
    CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'parent-sid', CLAUDECODE: '1',
    ANTHROPIC_API_KEY: 'sk-ant-api-SHOULD-BE-DROPPED', OTHER: 'keepme',
  };
  const e = claudeSpawnEnv({ env: finderish, configDir: '/iso/cfg', userInfo: fakeUser });
  rec('CD14 injects USER/LOGNAME from os.userInfo (Finder launch has none)', e.USER === 'testlogin' && e.LOGNAME === 'testlogin', `USER=${e.USER} LOGNAME=${e.LOGNAME}`);
  rec('CD14 strips SDK-delegation vars (standalone child, no host-refresh delegation)',
    e.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH === undefined && e.CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH === undefined
    && e.CLAUDE_CODE_CHILD_SESSION === undefined && e.CLAUDE_CODE_SESSION_ID === undefined && e.CLAUDECODE === undefined);
  // Prefix-strip robustness (not an enumerated denylist): a HYPOTHETICAL future CLAUDE_CODE_* /
  // CLAUDE_AGENT_SDK* delegation var is ALSO stripped, so a new SDK version can't re-introduce
  // non-determinism — while CLAUDE_CONFIG_DIR (CODE≠CONFIG) is never caught.
  {
    const f = claudeSpawnEnv({ env: { CLAUDE_CODE_SDK_HAS_FUTURE_THING: '1', CLAUDE_AGENT_SDK_NEWFLAG: '1', CLAUDE_CONFIG_DIR: '/m/d' }, userInfo: fakeUser });
    rec('CD14 prefix-strips a FUTURE CLAUDE_CODE_*/CLAUDE_AGENT_SDK* var (denylist not enumerated)',
      f.CLAUDE_CODE_SDK_HAS_FUTURE_THING === undefined && f.CLAUDE_AGENT_SDK_NEWFLAG === undefined && f.CLAUDE_CONFIG_DIR === '/m/d');
  }
  rec('CD14 drops ANTHROPIC_API_KEY (force subscription OAuth, never API-key billing)', e.ANTHROPIC_API_KEY === undefined);
  rec('CD14 does NOT clobber an already-set HOME', e.HOME === '/existing/home', `HOME=${e.HOME}`);
  rec('CD14 preserves unrelated vars + forces CLAUDE_CONFIG_DIR when configDir set', e.OTHER === 'keepme' && e.CLAUDE_CONFIG_DIR === '/iso/cfg');
  // configDir null → CLAUDE_CONFIG_DIR left at the inherited value (machine default preserved).
  const e2 = claudeSpawnEnv({ env: { CLAUDE_CONFIG_DIR: '/machine/default' }, configDir: null, userInfo: fakeUser });
  rec('CD14 configDir null → CLAUDE_CONFIG_DIR preserved (machine default)', e2.CLAUDE_CONFIG_DIR === '/machine/default');
  // HOME injected from userInfo when the inherited env lacks it (Finder GUI session may still set it,
  // but a truly minimal env must not leave `claude` without a HOME).
  const e3 = claudeSpawnEnv({ env: { PATH: '/usr/bin' }, userInfo: fakeUser });
  rec('CD14 injects HOME from os.userInfo when absent', e3.HOME === '/home/testlogin');
  // getpwuid failure (userInfo throws) must be fail-soft — env returned, USER left as inherited.
  const e4 = claudeSpawnEnv({ env: { USER: 'inherited' }, userInfo: () => { throw new Error('getpwuid'); } });
  rec('CD14 userInfo throw → fail-soft (inherited USER kept, no crash)', e4.USER === 'inherited');
}
// CD14b: BOTH spawn sites actually route through claudeSpawnEnv (the fix can't be bypassed).
{
  // refresh site: the spawned `claude` env carries an injected USER + stripped delegation var.
  _resetClaudeRefreshForTests();
  let refreshEnv = null;
  const spawnImpl = async (bin, args, opts) => { refreshEnv = opts?.env; seedClaudeConfigDir({ claudeOAuthToken: 'sk-R', expiresAt: now + 3_600_000 }); return { stdout: 'ok' }; };
  await refreshClaudeConfigDirToken({ claudeBin: '/bin/claude', spawnImpl, platform: 'linux', now: now + 5_000_000 });
  rec('CD14b refresh spawn routes through claudeSpawnEnv (USER injected, no delegation var)',
    !!refreshEnv?.USER && refreshEnv?.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH === undefined && refreshEnv?.CLAUDE_CONFIG_DIR === DIR,
    `USER=${refreshEnv?.USER}`);
  clean();
  // CLI-harness site: same — spawned child env has USER + isolated CLAUDE_CONFIG_DIR, no delegation.
  let cliEnv = null;
  const cliSpy = (bin, args, opts) => { cliEnv = opts.env; return mkChild(); };
  await createClaudeCliLoop({ claudeBin: '/bin/true', restPort: 8787, configDir: '/tmp/cfg-cd14', writeConfigImpl: () => {}, cleanupImpl: () => {}, spawnImpl: cliSpy }).run({ system: 's', userMessage: 'hi', send: () => {} });
  rec('CD14b CLI-harness spawn routes through claudeSpawnEnv (USER injected, isolated dir)',
    !!cliEnv?.USER && cliEnv?.CLAUDE_CONFIG_DIR === '/tmp/cfg-cd14' && cliEnv?.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH === undefined,
    `USER=${cliEnv?.USER}`);
}

clean();
// ── CD15 ⭐ force:true replaces on an EXPLICIT connect (reconnect must take effect) ──
// Without this, reconnecting to a DIFFERENT account left the OLD token in the dir:
// the DB said account B while CLI/native turns kept authenticating as account A, so a
// revoked/wrong account went on serving turns.
{
  rmSync(claudeConfigCredsPath(), { force: true });
  seedClaudeConfigDir({ claudeOAuthToken: 'sk-ant-oat-OLD', refreshToken: 'rt-old', expiresAt: 1, scopes: ['user:inference'] });
  // default (boot re-seed) must NOT clobber — claude owns the refresh in that dir
  seedClaudeConfigDir({ claudeOAuthToken: 'sk-ant-oat-NEW', refreshToken: 'rt-new', expiresAt: 2, scopes: ['user:inference'] });
  const kept = JSON.parse(readFileSync(claudeConfigCredsPath(), 'utf8')).claudeAiOauth.accessToken;
  // explicit connect MUST replace
  seedClaudeConfigDir({ claudeOAuthToken: 'sk-ant-oat-NEW', refreshToken: 'rt-new', expiresAt: 2, scopes: ['user:inference'] }, { force: true });
  const forced = JSON.parse(readFileSync(claudeConfigCredsPath(), 'utf8')).claudeAiOauth.accessToken;
  rec('CD15 ⭐ default seed non-clobbering · force:true replaces (reconnect takes effect)',
    kept === 'sk-ant-oat-OLD' && forced === 'sk-ant-oat-NEW', `kept=${kept} forced=${forced}`);
}

// ── CD16 🔒 scopes are NEVER fabricated ──────────────────────────────────────────
// This used to default to ['user:inference','user:profile'] when empty — laundering a
// bare/admin token (e.g. `claude setup-token`, which specifically LACKS user:inference)
// into a "subscription" on disk. Write only what we actually have.
{
  rmSync(claudeConfigCredsPath(), { force: true });
  seedClaudeConfigDir({ claudeOAuthToken: 'sk-ant-oat-UNKNOWN', refreshToken: null, expiresAt: null, scopes: [] }, { force: true });
  const j = JSON.parse(readFileSync(claudeConfigCredsPath(), 'utf8'));
  rec('CD16 🔒 empty scopes stay empty — user:inference is never fabricated on disk',
    Array.isArray(j.claudeAiOauth.scopes) && j.claudeAiOauth.scopes.length === 0,
    `scopes=${JSON.stringify(j.claudeAiOauth.scopes)}`);
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — isolated claude config-dir: seeds connected-subscription creds · non-clobbering (force replaces) · no fabricated scopes · read round-trips · CLI spawns with CLAUDE_CONFIG_DIR' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
