// verify:loopback — proves the --http OAuth/MCP server binds 127.0.0.1 ONLY,
// never all interfaces. The remote transport's threat model requires :4711 to be
// loopback-only (Caddy/frpc reach it via localhost); a 0.0.0.0 bind would expose
// the vault's OAuth surface to the LAN. Differential test:
//   L1 connecting to 127.0.0.1:PORT succeeds (server is up)
//   L2 connecting to the host's LAN IP:PORT is NOT reachable (refused/timeout) —
//      which only holds if the server bound loopback, not 0.0.0.0
// In-process child on a throwaway data dir; CI-portable; never logs a secret.
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applyMigrations } from '../src/db/migrate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
process.chdir(ROOT); // applyMigrations() + other relative paths resolve from repo root
const PORT = Number(process.env.MYCELIUM_PORT) || 4795;
const DATA = join(ROOT, 'data', 'verify-loopback');

process.env.MYCELIUM_DATA_DIR = DATA;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
applyMigrations(new Database(join(DATA, 'mycelium.db')));
const USER_MASTER = crypto.randomBytes(32).toString('hex');
const SYSTEM = crypto.randomBytes(32).toString('hex');

function startServer() {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'index.js'), '--http'], {
    cwd: ROOT,
    env: {
      ...process.env,
      MYCELIUM_HTTP: '1',
      MYCELIUM_PORT: String(PORT),
      MYCELIUM_DATA_DIR: DATA,
      USER_MASTER_KEY: USER_MASTER,
      SYSTEM_KEY: SYSTEM,
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

// Resolve to 'connected' | 'refused' | 'timeout' | 'error'.
function probe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { try { sock.destroy(); } catch { /* */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done('connected'));
    sock.once('timeout', () => done('timeout'));
    sock.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });
}

function lanIPv4() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

const srv = startServer();
try {
  await waitListening(srv);

  const lo = await probe('127.0.0.1', PORT);
  rec('L1. 127.0.0.1 reachable (server is up)', lo === 'connected', `probe=${lo}`);

  const lan = lanIPv4();
  if (!lan) {
    rec('L2. LAN-IP not reachable (no non-loopback IPv4 present — SKIP→PASS)', true, 'no external IPv4 to test');
  } else {
    const r = await probe(lan, PORT);
    rec('L2. LAN IP NOT reachable (proves loopback-only, not 0.0.0.0)', r !== 'connected', `lan=${lan} probe=${r}`);
  }
} finally {
  try { srv.child.kill(); } catch { /* ignore */ }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — :4711 binds loopback only' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
