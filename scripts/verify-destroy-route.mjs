// verify:destroy-route — the recovery-key-gated POST /account/destroy
// (src/account/destroy-route.js). Drives every gate + the happy path over HTTP
// with injected fakes (no real Keychain/vault). Uses the REAL destroyVault engine
// against a temp dir.
//
//   E1 wrong phrase → 400, nothing wiped
//   E2 wrong recovery key → 403, nothing wiped, keychain NOT called
//   E3 missing recovery key → 403
//   E4 non-loopback → 403
//   E5 correct phrase + key → 200 ok, dir wiped, keychain called, relaunchRequired
//   E6 fail-closed: readMaster returns null/throws → 403 (never destroy on indeterminate key)
//   E7 HANDLE PRE-FLIGHT (QA P0.7): a managed handle that will NOT release → 409
//      with NOTHING deleted (the vault is still intact, so the user can retry
//      while the signing key still exists)
//   E8 force:true proceeds but REPORTS THE TRUTH — relayRevoked:false + the reason
//   E9 a release that SUCCEEDS reports relayRevoked:true; "no managed handle"
//      (applicable:false) never blocks and is never rendered as released
//   E10 connector-revoke outcome is reported per-connector, not assumed
//   E12 an unreadable connector set (vault never opened) is reported as a
//       FAILURE, never as a clean zero — review F3
//   E11 the hook receives the GATED master key, so a PRE-BOOT release can be
//       signed at all (env.ENCRYPTION_MASTER_KEY is set only by boot(), while
//       this route is mounted always) — review F1
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import express from 'express';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { destroyRouter, DESTROY_PHRASE } from '../src/account/destroy-route.js';
import { connectorsUnavailable } from '../src/connectors/index.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const ROOT = join(process.cwd(), 'data', 'verify-destroy-route');
const DATA = join(ROOT, 'appdata');
const MASTER = 'a'.repeat(64);
const seed = () => { rmSync(ROOT, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true }); for (const n of ['mycelium.db', 'kcv.json', 'auth.db']) writeFileSync(join(DATA, n), 'x'); };

let keychainCalls = 0;
let loopbackOk = true;
let masterProvider = () => MASTER;
// The handle-release hook NEVER THROWS by contract — its RETURN VALUE is the
// only outcome signal, so the gate drives it through every shape.
let releaseOutcome = { applicable: false, released: false, reason: 'not-managed' };
let releaseCalls = 0;
let releaseSawMaster = null; // what the route handed the hook (F1: must be the gated key)
let connectorOutcome = { attempted: 0, revoked: [], failed: [] };
const mkApp = () => {
  const app = express();
  app.use('/api/v1/account', destroyRouter({
    isTrustedLoopback: () => loopbackOk,
    readMaster: () => masterProvider(),
    dataDir: () => DATA,
    extraRoots: () => [],
    deleteKeychain: () => { keychainCalls += 1; },
    readPulledModels: async () => ['llama3:8b'],
    deleteOllamaModels: async (tags) => ({ removed: tags, failed: [] }),
    revokeRelay: async (masterHex) => { releaseCalls += 1; releaseSawMaster = masterHex; return releaseOutcome; },
    revokeConnectors: async () => connectorOutcome,
  }));
  return app;
};

const server = mkApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/account`;
const post = (b) => fetch(base + '/destroy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const dirAlive = () => existsSync(DATA) && readdirSync(DATA).length > 0;

// E1 wrong phrase
seed(); keychainCalls = 0;
let r = await post({ recoveryKey: MASTER, phrase: 'nope' });
rec('E1 wrong phrase → 400, nothing wiped', r.status === 400 && dirAlive() && keychainCalls === 0, `status=${r.status}`);

// E2 wrong key
seed(); keychainCalls = 0;
r = await post({ recoveryKey: 'b'.repeat(64), phrase: DESTROY_PHRASE });
rec('E2 wrong recovery key → 403, nothing wiped, keychain untouched', r.status === 403 && dirAlive() && keychainCalls === 0, `status=${r.status}`);

// E3 missing key
seed(); keychainCalls = 0;
r = await post({ phrase: DESTROY_PHRASE });
rec('E3 missing recovery key → 403', r.status === 403 && dirAlive() && keychainCalls === 0);

// E4 non-loopback
seed(); keychainCalls = 0; loopbackOk = false;
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
rec('E4 non-loopback → 403', r.status === 403 && dirAlive() && keychainCalls === 0, `status=${r.status}`);
loopbackOk = true;

// E6 fail-closed on indeterminate master (do BEFORE the destructive E5)
seed(); keychainCalls = 0; masterProvider = () => { throw new Error('keychain unavailable'); };
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
const e6a = r.status === 403 && dirAlive() && keychainCalls === 0;
masterProvider = () => null;
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
const e6b = r.status === 403 && dirAlive();
rec('E6 fail-closed: readMaster throws OR null → 403, never destroys', e6a && e6b);
masterProvider = () => MASTER;

// E7 handle pre-flight: a managed handle that will NOT release halts the destroy
// BEFORE anything is deleted (the signing key still exists ⇒ a retry can work).
seed(); keychainCalls = 0; releaseCalls = 0;
releaseOutcome = { applicable: true, released: false, reason: 'release-503' };
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
rec('E7 managed handle fails to release → 409, NOTHING deleted, keychain untouched, reason carried',
  r.status === 409 && r.body.ok === false && dirAlive() && keychainCalls === 0
  && r.body.canForce === true && r.body.handleRelease?.released === false && r.body.handleRelease?.reason === 'release-503',
  `status=${r.status} body=${JSON.stringify(r.body)}`);

// E8 force:true proceeds — but must REPORT THE TRUTH, never a freed handle.
seed(); keychainCalls = 0; releaseCalls = 0;
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE, force: true });
const forcedWiped = existsSync(DATA) && readdirSync(DATA).length === 0;
rec('E8 force → destroys, but relayRevoked:false + reason (never claims a freed handle)',
  r.status === 200 && r.body.ok === true && forcedWiped && keychainCalls === 1
  && r.body.relayRevoked === false && r.body.handleRelease?.released === false && r.body.handleRelease?.reason === 'release-503'
  // ONE network release for the whole destroy — the engine reuses the pre-flight outcome.
  && releaseCalls === 1,
  `status=${r.status} releaseCalls=${releaseCalls} body=${JSON.stringify(r.body)}`);

// E9 not-applicable (self-hosted / remote off) never blocks and never reads as released.
seed(); keychainCalls = 0; releaseCalls = 0;
releaseOutcome = { applicable: false, released: false, reason: 'not-managed' };
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
const naOk = r.status === 200 && r.body.relayRevoked === false && r.body.handleRelease?.applicable === false;
seed(); keychainCalls = 0; releaseCalls = 0;
releaseOutcome = { applicable: true, released: true };
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
const okOk = r.status === 200 && r.body.relayRevoked === true && r.body.handleRelease?.released === true;
rec('E9 "no managed handle" → proceeds, relayRevoked:false; a real release → relayRevoked:true', naOk && okOk);

// E10 connector revoke outcome reported per-connector, never assumed.
seed(); keychainCalls = 0;
connectorOutcome = { attempted: 2, revoked: ['gmail'], failed: [{ id: 'notion', reason: 'ETIMEDOUT' }] };
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
rec('E10 connector revoke: attempted/revoked counts + the STILL-LIVE grant reported by id',
  r.status === 200 && r.body.connectors?.attempted === 2 && r.body.connectors?.revoked === 1
  && r.body.connectors?.failed?.length === 1 && r.body.connectors.failed[0].id === 'notion',
  JSON.stringify(r.body.connectors));
connectorOutcome = { attempted: 0, revoked: [], failed: [] };

// E12 an UNREADABLE connector set (vault never opened — destroy is mounted
// pre-boot) surfaces as a reported FAILURE, not the clean zero it resembles.
seed(); keychainCalls = 0;
connectorOutcome = connectorsUnavailable();
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
rec('E12 vault-not-open → connectors reported as FAILED with a reason (never a silent "0 connectors")',
  r.status === 200 && r.body.connectors?.revoked === 0
  && r.body.connectors?.failed?.length === 1 && r.body.connectors.failed[0].reason === 'vault-not-open',
  JSON.stringify(r.body.connectors));
connectorOutcome = { attempted: 0, revoked: [], failed: [] };

// E11 the release hook is handed the master that just cleared the recovery gate.
// Without this, a managed user destroying an UNBOOTED vault cannot sign the
// release claim at all (env.ENCRYPTION_MASTER_KEY is populated only by boot()).
seed(); keychainCalls = 0; releaseSawMaster = null;
releaseOutcome = { applicable: false, released: false, reason: 'not-managed' };
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
rec('E11 revokeRelay receives the GATED master key (pre-boot release can be signed)',
  r.status === 200 && releaseSawMaster === MASTER, `sawMaster=${releaseSawMaster === MASTER}`);

// E5 happy path (destructive — last)
seed(); keychainCalls = 0;
releaseOutcome = { applicable: false, released: false, reason: 'not-managed' };
r = await post({ recoveryKey: MASTER, phrase: DESTROY_PHRASE });
const wiped = existsSync(DATA) && readdirSync(DATA).length === 0;
rec('E5 correct phrase+key → 200 ok, dir wiped, keychain deleted, relaunchRequired',
  r.status === 200 && r.body.ok === true && wiped && keychainCalls === 1 && r.body.keychainDeleted === true && r.body.relaunchRequired === true && r.body.ollamaRemoved === 1,
  `status=${r.status} body=${JSON.stringify(r.body)}`);

server.close();
rmSync(ROOT, { recursive: true, force: true });
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — destroy route: loopback + recovery-key + phrase gated, fail-closed');
