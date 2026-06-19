#!/usr/bin/env node
// Channel-daemon SUPERVISION proof — the gap no other verify-channel-* gate
// covers: that the app actually STARTS/STOPS the daemon and that the daemon can
// reach the app's loopback MCP endpoint (incl. the `reply` egress tool). Two
// parts:
//   A. supervisor logic (injected spawn/db/fetch — no real process or token):
//      enable-gating, keyless child env, adopt-vs-spawn, reload/stop.
//   B. the loopback MCP endpoint over a real vault: initialize + tools/list shows
//      `reply` when AGENT_URL is set; a non-loopback request is refused (403).
// PASS/FAIL ledger; exits 0 only on full GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { startChannelSupervisor, _resetChannelSupervisor, getChannelHealth } from '../src/channels/supervisor.js';
import { applyMigrations } from '../src/db/migrate.js';

const ledger = [];
let allPass = true;
function check(name, cond) {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}`);
}
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// ── Fakes ─────────────────────────────────────────────────────────────────────
function fakeDb(secrets) {
  return { secrets: {
    get: async (_u, k) => (k in secrets ? secrets[k] : null),
    has: async (_u, k) => Boolean(secrets[k]),
  } };
}
function fakeSpawn() {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child._killed = true; };
    calls.push({ cmd, args, opts, child });
    return child;
  };
  fn.calls = calls;
  return fn;
}
const probeFail = async () => { throw new Error('ECONNREFUSED'); };
const probeOk = async () => ({ ok: true });

try {
  // ── Part A1: disabled → no spawn ────────────────────────────────────────────
  {
    _resetChannelSupervisor();
    const spawn = fakeSpawn();
    startChannelSupervisor({ db: fakeDb({ CHANNEL_ENABLED: '0', TELEGRAM_BOT_TOKEN: 'x' }), userId: 'u', spawn, fetch: probeFail, log: () => {} });
    await settle();
    check('disabled → daemon NOT spawned', spawn.calls.length === 0);
    check('disabled → health=disabled', getChannelHealth().status === 'disabled');
    _resetChannelSupervisor();
  }

  // ── Part A2: enabled+token, no existing daemon → spawn with keyless env ──────
  {
    _resetChannelSupervisor();
    const spawn = fakeSpawn();
    startChannelSupervisor({ db: fakeDb({ CHANNEL_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'tok' }), userId: 'u', restPort: 8787, spawn, fetch: probeFail, log: () => {} });
    await settle();
    check('enabled+token → daemon spawned once', spawn.calls.length === 1);
    const c = spawn.calls[0] || { args: [], opts: { env: {} } };
    check('spawns packages/channel-daemon/index.js', String(c.args?.[0]).includes('packages/channel-daemon/index.js'));
    const env = c.opts?.env || {};
    check('child env → MYCELIUM_API_URL loopback', env.MYCELIUM_API_URL === 'http://127.0.0.1:8787');
    check('child env → MYCELIUM_MCP_URL = /internal/mcp', env.MYCELIUM_MCP_URL === 'http://127.0.0.1:8787/internal/mcp');
    check('child env → CHANNEL_MCP_MODE=http', env.CHANNEL_MCP_MODE === 'http');
    // SECURITY: keyless — no vault key material ever flows to the daemon.
    const keyish = ['MYCELIUM_KEY_SOURCE', 'USER_MASTER', 'SYSTEM_KEY', 'MYCELIUM_USER_HEX', 'MYCELIUM_SYSTEM_HEX', 'MYCELIUM_DATA_DIR'];
    check('child env carries NO vault keys (keyless)', keyish.every((k) => !(k in env)));
    _resetChannelSupervisor();
  }

  // ── Part A3: existing healthy daemon → adopt (no spawn) ──────────────────────
  {
    _resetChannelSupervisor();
    const spawn = fakeSpawn();
    startChannelSupervisor({ db: fakeDb({ CHANNEL_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'tok' }), userId: 'u', spawn, fetch: probeOk, log: () => {} });
    await settle();
    check('existing daemon → adopted, NOT re-spawned', spawn.calls.length === 0);
    check('adopted → health=ok', getChannelHealth().status === 'ok');
    _resetChannelSupervisor();
  }

  // ── Part A4: reload() restarts; stop() kills ────────────────────────────────
  {
    _resetChannelSupervisor();
    const spawn = fakeSpawn();
    const sup = startChannelSupervisor({ db: fakeDb({ CHANNEL_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'tok' }), userId: 'u', spawn, fetch: probeFail, log: () => {} });
    await settle();
    const first = spawn.calls[0]?.child;
    sup.reload();
    await settle();
    check('reload() kills the running daemon', first?._killed === true);
    check('reload() respawns (config picked up)', spawn.calls.length === 2);
    const second = spawn.calls[1]?.child;
    sup.stop();
    check('stop() kills the daemon', second?._killed === true);
    _resetChannelSupervisor();
  }

  // ── Part B: loopback MCP endpoint over a real vault ─────────────────────────
  // Force AGENT_URL so boot() wires `reply` even though the gate injects keys.
  process.env.AGENT_URL = 'http://127.0.0.1:3010';
  const { startRestServer } = await import('../src/server-rest.js');
  const DB = 'data/verify-channel-supervisor.db';
  const KCV = 'data/verify-channel-supervisor-kcv.json';
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  applyMigrations(new Database(DB));
  const hex = () => crypto.randomBytes(32).toString('hex');
  const started = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1' });
  const { url } = started;

  const mcpHeaders = (extra = {}) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra });
  const initBody = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gate', version: '0' } } };

  // loopback initialize → 200 + session id
  const initRes = await fetch(`${url}/internal/mcp`, { method: 'POST', headers: mcpHeaders(), body: JSON.stringify(initBody) });
  check('loopback /internal/mcp initialize → 200', initRes.status === 200);
  const sid = initRes.headers.get('mcp-session-id');
  check('initialize returns a session id', !!sid);

  // tools/list → reply present
  const listRes = await fetch(`${url}/internal/mcp`, { method: 'POST', headers: mcpHeaders({ 'mcp-session-id': sid }), body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
  const raw = await listRes.text();
  let tools = [];
  for (const line of raw.split('\n')) {
    const s = line.replace(/^data:\s*/, '').trim();
    if (!s) continue;
    try { const j = JSON.parse(s); if (j?.result?.tools) tools = j.result.tools.map((t) => t.name); } catch {}
  }
  check('tools/list returns tools', tools.length > 0);
  check('reply tool advertised (AGENT_URL wired)', tools.includes('reply'));

  // non-loopback (proxied) → 403, fail closed
  const proxRes = await fetch(`${url}/internal/mcp`, { method: 'POST', headers: mcpHeaders({ 'x-forwarded-for': '1.2.3.4' }), body: JSON.stringify(initBody) });
  check('proxied (X-Forwarded-For) request → 403', proxRes.status === 403);

  try { started.server.close(); } catch {}
  try { started.close?.(); } catch {}
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
} catch (e) {
  check(`fatal: ${e?.message || e}`, false);
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
