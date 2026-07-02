// verify:harness-registry — the agent-engine resolver (src/agent/resolve-harness.js)
// + binary discovery (src/inference/claude-bin.js). Pure unit (no vault boot). The
// resolver ALWAYS returns a working loop and NEVER throws; 'cli' is granted only when
// every gate passes, else it fails safe to native with a reason the UI can surface.
//   R1 default (no setting)                       → native, no reason
//   R2 harnessMode:'native'                        → native
//   R3 cli + no binary                             → native, reason 'no-binary'
//   R4 cli + binary + no subscription row          → native, reason 'no-subscription'
//   R5 cli + binary + subscription connected       → native, reason 'cli-unavailable' (C1: cli engine not shipped)
//   R6 getSettings throws                          → native (fail-safe), no reason
//   R7 cli + binary + subscription but no restPort → native, reason 'no-port' (never a bad MCP URL)
//   R8 cli + subscription eligible is ORTHOGONAL to the chat provider (a non-sub chat
//      provider does NOT block cli when an oauth row exists) — matches the UI gate
//   B1 CLAUDE_BIN override wins  ·  B2 PATH scan finds it  ·  B3 none → null
import { resolveHarness } from '../src/agent/resolve-harness.js';
import { resolveClaudeBin } from '../src/inference/claude-bin.js';

const ledger = [];
const rec = (label, cond, detail = '') => { ledger.push(!!cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  — ' + detail}`); };

const harness = { streamTurn: async () => ({}) };            // createAgentLoop only needs streamTurn
const deps = { harness, logger: () => {}, restPort: 8787 };
// db seam: getSettings + providers.list (the resolver detects a connected subscription
// via an auth_type='oauth' row — ORTHOGONAL to the active chat provider).
const OAUTH_ROW = { id: 1, auth_type: 'oauth', model_preference: 'claude-opus-4-8' };
const mkDb = (settings, providerRows = []) => ({
  users: { getSettings: async () => settings },
  providers: { list: async () => providerRows },
});
const SUB = { providerName: 'claude_subscription', cloudModel: 'claude-opus-4-8' };
const LOCAL = { providerName: 'custom', baseUrl: 'http://127.0.0.1:11434/v1' };  // chat routed elsewhere

{ const r = await resolveHarness({ db: mkDb({}), userId: 'u', provider: SUB, deps }); rec('R1 default → native', r.mode === 'native' && !r.reason && typeof r.loop?.run === 'function', JSON.stringify(r)); }
{ const r = await resolveHarness({ db: mkDb({ harnessMode: 'native' }), userId: 'u', provider: SUB, deps }); rec('R2 native mode → native', r.mode === 'native' && typeof r.loop?.run === 'function'); }
{ const r = await resolveHarness({ db: mkDb({ harnessMode: 'cli' }, [OAUTH_ROW]), userId: 'u', provider: SUB, deps, claudeBin: null }); rec('R3 cli + no binary → native/no-binary', r.mode === 'native' && r.reason === 'no-binary', JSON.stringify(r)); }
{ const r = await resolveHarness({ db: mkDb({ harnessMode: 'cli' }, []), userId: 'u', provider: SUB, deps, claudeBin: '/x/claude' }); rec('R4 cli + binary + no oauth row → native/no-subscription', r.mode === 'native' && r.reason === 'no-subscription', JSON.stringify(r)); }
{ const r = await resolveHarness({ db: mkDb({ harnessMode: 'cli' }, [OAUTH_ROW]), userId: 'u', provider: SUB, deps, claudeBin: '/x/claude' }); rec('R5 cli + binary + subscription → CLI (engine enabled)', r.mode === 'cli' && typeof r.loop?.run === 'function', JSON.stringify(r)); }
{ const throwDb = { users: { getSettings: async () => { throw new Error('boom'); } } }; const r = await resolveHarness({ db: throwDb, userId: 'u', provider: SUB, deps }); rec('R6 getSettings throws → native fail-safe', r.mode === 'native' && !r.reason, JSON.stringify(r)); }
{ const r = await resolveHarness({ db: mkDb({ harnessMode: 'cli' }, [OAUTH_ROW]), userId: 'u', provider: SUB, deps: { harness, logger: () => {} /* no restPort */ }, claudeBin: '/x/claude' }); rec('R7 cli + binary + sub + no restPort → native/no-port', r.mode === 'native' && r.reason === 'no-port', JSON.stringify(r)); }
{ const r = await resolveHarness({ db: mkDb({ harnessMode: 'cli' }, [OAUTH_ROW]), userId: 'u', provider: LOCAL, deps, claudeBin: '/x/claude' }); rec('R8 eligibility orthogonal to chat provider (local chat provider + oauth row → CLI)', r.mode === 'cli' && typeof r.loop?.run === 'function', JSON.stringify(r)); }

{ const b = resolveClaudeBin({ existsSync: (p) => p === '/custom/claude', env: { CLAUDE_BIN: '/custom/claude', PATH: '' } }); rec('B1 CLAUDE_BIN override', b === '/custom/claude', String(b)); }
{ const b = resolveClaudeBin({ existsSync: (p) => p === '/usr/bin/claude', env: { PATH: '/usr/bin:/bin' } }); rec('B2 PATH scan', b === '/usr/bin/claude', String(b)); }
{ const b = resolveClaudeBin({ existsSync: () => false, env: { PATH: '/nope' } }); rec('B3 none → null', b === null, String(b)); }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — harness resolver: native default · fail-safe on every cli-ineligibility path · binary discovery' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
