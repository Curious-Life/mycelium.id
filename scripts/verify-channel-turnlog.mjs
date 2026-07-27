#!/usr/bin/env node
// verify:channel-turnlog — U2: the persistent per-turn log actually lands in the
// packaged app.
//
// The bug: packages/channel-daemon resolveTurnLogPath() falls back to
// MYCELIUM_DATA_DIR / MYCELIUM_VAULT_DIR / MYCELIUM_STATE_DIR — but the
// supervisor's keyless childEnv allowlist carries NONE of them, so in production
// the L3b turn log was console-only (INERT). Fix: the supervisor derives the
// FILE path from the server's own data-dir resolution (src/paths.js) and passes
// it as MYCELIUM_CHANNEL_TURN_LOG; the daemon mkdirs its parent.
//
// Asserts:
//   T1  channelTurnLogPath derives <dataDir>/logs/channel-turns.jsonl (VALUE, fixture env)
//   T2  the REAL spawn path (startChannelSupervisor with injected spawn) passes that
//       exact VALUE in the child env — and the env stays keyless/dataless
//   T3  daemon resolveTurnLogPath(explicit) ensures the parent dir exists
//   T4  leak-safety: a driven turn writes ONE line whose key set is exactly the
//       allowed metadata set, and a canary message content NEVER reaches the file
// PASS/FAIL ledger; exit 0 only on full GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { channelTurnLogPath, startChannelSupervisor, _resetChannelSupervisor } from '../src/channels/supervisor.js';
import { resolveTurnLogPath } from '../packages/channel-daemon/index.js';
import { createLane } from '../packages/channel-daemon/agent/lane.js';

const ledger = [];
let allPass = true;
const check = (n, c, d = '') => { const ok = !!c; allPass = allPass && ok; ledger.push(`[${ok ? '✓' : '✗'}] ${n}${d ? ` — ${d}` : ''}`); };
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const FIX = join(process.cwd(), 'data', 'verify-channel-turnlog-fixture');
try { rmSync(FIX, { recursive: true, force: true }); } catch { /* */ }
mkdirSync(FIX, { recursive: true });

try {
  // T1: pure derivation — the VALUE, from a fixture data dir.
  const expected = join(FIX, 'logs', 'channel-turns.jsonl');
  check('T1. channelTurnLogPath = <dataDir>/logs/channel-turns.jsonl',
    channelTurnLogPath({ env: { MYCELIUM_DATA_DIR: FIX } }) === expected, channelTurnLogPath({ env: { MYCELIUM_DATA_DIR: FIX } }));

  // T2: the REAL spawn-env builder, driven through the real supervisor spawn path.
  const savedDataDir = process.env.MYCELIUM_DATA_DIR;
  process.env.MYCELIUM_DATA_DIR = FIX; // the server's own data-dir resolution (paths.js)
  try {
    _resetChannelSupervisor();
    const calls = [];
    const fakeSpawn = (cmd, args, opts) => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      calls.push({ cmd, args, opts, child });
      return child;
    };
    const db = { secrets: { get: async (_u, k) => (k === 'CHANNEL_ENABLED' ? '1' : null), has: async (_u, k) => k === 'TELEGRAM_BOT_TOKEN' } };
    startChannelSupervisor({ db, userId: 'u', restPort: 8787, spawn: fakeSpawn, fetch: async () => { throw new Error('ECONNREFUSED'); }, log: () => {}, channelTurnToken: 'tok' });
    await settle();
    const env = calls[0]?.opts?.env || {};
    check('T2a. daemon spawned with MYCELIUM_CHANNEL_TURN_LOG = the derived VALUE',
      calls.length === 1 && env.MYCELIUM_CHANNEL_TURN_LOG === expected, `got=${env.MYCELIUM_CHANNEL_TURN_LOG}`);
    // Still keyless AND dataless: the fix passes the file path, never the data dir / keys.
    const keyish = ['MYCELIUM_KEY_SOURCE', 'USER_MASTER', 'SYSTEM_KEY', 'MYCELIUM_USER_HEX', 'MYCELIUM_SYSTEM_HEX', 'MYCELIUM_DATA_DIR', 'MYCELIUM_VAULT_DIR', 'MYCELIUM_STATE_DIR'];
    check('T2b. child env stays keyless + dataless', keyish.every((k) => !(k in env)));
    _resetChannelSupervisor();
  } finally {
    if (savedDataDir === undefined) delete process.env.MYCELIUM_DATA_DIR; else process.env.MYCELIUM_DATA_DIR = savedDataDir;
  }

  // T3: the daemon side ensures the explicit path's parent dir exists (the
  // supervisor passes a logs/ dir that may not exist on first boot).
  const savedTurnLog = process.env.MYCELIUM_CHANNEL_TURN_LOG;
  process.env.MYCELIUM_CHANNEL_TURN_LOG = expected;
  let resolved;
  try { resolved = resolveTurnLogPath(); }
  finally { if (savedTurnLog === undefined) delete process.env.MYCELIUM_CHANNEL_TURN_LOG; else process.env.MYCELIUM_CHANNEL_TURN_LOG = savedTurnLog; }
  check('T3. resolveTurnLogPath(explicit) returns the path AND mkdirs its parent',
    resolved === expected && existsSync(join(FIX, 'logs')), `resolved=${resolved}`);

  // T4: leak-safety — drive a REAL lane turn with a canary in the message content
  // and a scripted auth outcome; assert the written line is metadata-only.
  const CANARY = 'CANARY-VAULT-CONTENT-8f3a2b-DO-NOT-PERSIST';
  const runtime = { label: 'gate', async runTurn() { return { delivered: false, usedReplyTool: false, reason: 'auth', degraded: true }; } };
  const lane = createLane({ runtime, turnLogPath: resolved });
  lane.runTurn({ source: 'telegram', channelKind: 'telegram', channelId: '111', userId: '111', senderRole: 'owner' }, { content: CANARY });
  await lane.idle();
  const lines = readFileSync(resolved, 'utf8').trim().split('\n');
  const rec = JSON.parse(lines[lines.length - 1]);
  const ALLOWED = ['at', 'chatId', 'verdict', 'durationMs', 'senderId', 'reason', 'model', 'harvested', 'degraded', 'error', 'source', 'ok'];
  const EXPECT_KEYS = ['at', 'chatId', 'verdict', 'durationMs', 'senderId', 'reason', 'degraded', 'source', 'ok']; // this exact scripted outcome
  const keys = Object.keys(rec).sort();
  check('T4a. one line written; key set is EXACTLY the expected metadata set',
    lines.length === 1 && keys.join(',') === [...EXPECT_KEYS].sort().join(','), `keys=${keys.join(',')}`);
  check('T4b. every key is in the metadata allowlist', keys.every((k) => ALLOWED.includes(k)));
  check('T4c. the canary message content NEVER reaches the log file', !readFileSync(resolved, 'utf8').includes(CANARY));
  check('T4d. the outcome itself is honest (no-reply / auth / not ok)', rec.verdict === 'no-reply' && rec.reason === 'auth' && rec.ok === false);
} catch (e) {
  check(`fatal: ${e?.stack?.split('\n')[0] || e}`, false);
} finally {
  try { rmSync(FIX, { recursive: true, force: true }); } catch { /* */ }
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
