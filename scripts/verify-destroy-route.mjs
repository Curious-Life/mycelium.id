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
import express from 'express';
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { destroyRouter, DESTROY_PHRASE } from '../src/account/destroy-route.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const ROOT = join(process.cwd(), 'data', 'verify-destroy-route');
const DATA = join(ROOT, 'appdata');
const MASTER = 'a'.repeat(64);
const seed = () => { rmSync(ROOT, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true }); for (const n of ['mycelium.db', 'kcv.json', 'auth.db']) writeFileSync(join(DATA, n), 'x'); };

let keychainCalls = 0;
let loopbackOk = true;
let masterProvider = () => MASTER;
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

// E5 happy path (destructive — last)
seed(); keychainCalls = 0;
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
