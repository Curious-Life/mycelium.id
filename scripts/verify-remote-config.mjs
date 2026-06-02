// verify:remote-config — proves Phase 1 of remote-connect: the OAuth server can
// boot from PERSISTED config (no env), so a non-technical user never types a
// secret. Asserts:
//   RC1 remote.json round-trips; env override wins
//   RC2 the signing secret is generated once + STABLE across calls (auth.db)
//   RC3 setOperatorPassword creates an operator user + persists operatorEmail
//   RC4 a <12-char password is rejected (the gate must be strong)
//   RC5 a spawned `--http` server (NO env secret/baseURL/password) reflects the
//       PERSISTED publicBaseUrl in its OAuth metadata, and 401s unauthenticated
//   RC6 the persisted password gates sign-in (right→200, wrong→401)
//
// Everything is in-process + a child server on a throwaway data dir — no real
// Keychain, no network, CI-portable. PASS/FAIL ledger; exit 0 only on full GO.
// Never logs a secret value (CLAUDE.md §1).
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyMigrations } from '../src/db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const PORT = Number(process.env.MYCELIUM_PORT) || 4793;
const BASE = `http://localhost:${PORT}`;
const DATA = join(ROOT, 'data', 'verify-remote-config');
const EMAIL = 'verify-remote@example.com';
const PASSWORD = 'verify-remote-pw-123456'; // ≥12

// Pin the data dir BEFORE importing config.js so all path resolution agrees.
process.env.MYCELIUM_DATA_DIR = DATA;
delete process.env.MYCELIUM_AUTH_SECRET; // force the persisted path
delete process.env.MYCELIUM_BASE_URL;
delete process.env.MYCELIUM_USER_PASSWORD;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

// Fresh data dir + a migrated throwaway vault (the child --http server boots it).
rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
applyMigrations(new Database(join(DATA, 'mycelium.db')));
const USER_MASTER = crypto.randomBytes(32).toString('hex');
const SYSTEM = crypto.randomBytes(32).toString('hex');

const cfg = await import('../src/remote/config.js');

// RC1 — remote.json round-trip + env override precedence.
cfg.writeRemoteConfig({ publicBaseUrl: BASE, operatorEmail: EMAIL, remoteEnabled: true });
const rc = cfg.readRemoteConfig();
const override = cfg.readRemoteConfig({ env: { MYCELIUM_BASE_URL: 'https://override.example' } });
rec('RC1. remote.json round-trips + env override wins',
  rc.publicBaseUrl === BASE && rc.operatorEmail === EMAIL && rc.remoteEnabled === true
  && override.publicBaseUrl === 'https://override.example',
  `file=${rc.publicBaseUrl} enabled=${rc.remoteEnabled} override=${override.publicBaseUrl}`);

// RC2 — signing secret generated once + stable.
const s1 = cfg.resolveAuthSecret();
const s2 = cfg.resolveAuthSecret();
rec('RC2. auth secret generated once + stable across calls',
  typeof s1 === 'string' && /^[0-9a-f]{64}$/.test(s1) && s1 === s2,
  `len=${s1?.length} stable=${s1 === s2}`);

// RC3 — set the operator password (the gate); user created, email persisted.
await cfg.setOperatorPassword({ email: EMAIL, password: PASSWORD });
rec('RC3. setOperatorPassword creates operator user + persists email',
  cfg.operatorUserExists() === true && cfg.readRemoteConfig().operatorEmail === EMAIL,
  `userExists=${cfg.operatorUserExists()} email=${cfg.readRemoteConfig().operatorEmail}`);

// RC4 — weak password rejected.
let weakRejected = false;
try { await cfg.setOperatorPassword({ email: EMAIL, password: 'short' }); }
catch { weakRejected = true; }
rec('RC4. password <12 chars rejected', weakRejected, `rejected=${weakRejected}`);

// ── Spawn the --http server from PERSISTED config (no secret/baseURL/pw env) ──
function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), '--http'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MYCELIUM_HTTP: '1',
      MYCELIUM_PORT: String(PORT),
      MYCELIUM_DATA_DIR: DATA,        // auth.db + remote.json + vault all here
      USER_MASTER_KEY: USER_MASTER,   // vault unlock (auth is separate)
      SYSTEM_KEY: SYSTEM,
      // deliberately NO MYCELIUM_AUTH_SECRET / MYCELIUM_BASE_URL / MYCELIUM_USER_PASSWORD
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, out: () => out };
}

async function waitListening({ child, out }) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (/listening on/i.test(out())) return;
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${out()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${out()}`);
}

const srv = startServer();
try {
  await waitListening(srv);

  // RC5 — OAuth metadata reflects the PERSISTED base URL (proves config flows in).
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  const prmOk = String(prm.resource || '').startsWith(BASE);
  const asmOk = JSON.stringify(asm).includes(BASE);
  const unauth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  rec('RC5. metadata reflects persisted publicBaseUrl + /mcp is 401 unauth',
    prmOk && asmOk && unauth.status === 401,
    `resource=${prm.resource} asm~base=${asmOk} unauth=${unauth.status}`);

  // RC6 — the persisted password gates sign-in (right→ok, wrong→reject).
  const good = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const bad = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: EMAIL, password: 'wrong-password-000' }),
  });
  rec('RC6. persisted password gates sign-in (right=2xx, wrong=4xx)',
    good.status >= 200 && good.status < 300 && bad.status >= 400,
    `right=${good.status} wrong=${bad.status}`);
} finally {
  try { srv.child.kill(); } catch { /* ignore */ }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — OAuth server boots from persisted config; secret stable; gate enforced' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
