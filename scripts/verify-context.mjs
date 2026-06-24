// getContext (D5 preamble) verifier. Proves the entry-point tool lists, returns
// a briefing, and — critically — surfaces an item written via flagForDiscussion
// (the round-trip that makes flagForDiscussion meaningful).
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-context.db';
const KCV = 'data/verify-context-kcv.json';
const MIND = 'data/verify-context-mind';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (n, pass, d) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
try { rmSync(MIND, { recursive: true }); } catch {}
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const userHex = hex(), systemHex = hex();
// Isolate mind files for this run (boot binds agentRoot at construction).
process.env.MYCELIUM_AGENT_ROOT = MIND;
const { server, close, tools } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex });

// X1: getContext registered
const ctx = tools.find((t) => t.name === 'getContext');
rec('X1. getContext is registered + JSON-Schema', !!ctx && ctx.inputSchema?.type === 'object',
  ctx ? `present; ${tools.length} tools total` : 'MISSING');

const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'verify-context', version: '0' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);

// X2: getContext returns a briefing with the time header
const r1 = await client.callTool({ name: 'getContext', arguments: {} });
const t1 = r1.content?.[0]?.text || '';
rec('X2. getContext returns a briefing (date/time header present)',
  r1.content?.[0]?.type === 'text' && /Current time:/.test(t1),
  `len=${t1.length} startsWith="${t1.slice(0, 40)}"`);

// X3: the D5 promise — flagForDiscussion -> getContext surfaces it
const marker = `STRESS-TEST-FLAG-${Date.now()}`;
await client.callTool({ name: 'flagForDiscussion', arguments: { topic: marker, context: 'verify e2e' } });
const r2 = await client.callTool({ name: 'getContext', arguments: {} });
const t2 = r2.content?.[0]?.text || '';
rec('X3. flagForDiscussion item surfaces in getContext (the D5 round-trip)',
  t2.includes(marker) && /FLAGGED FOR DISCUSSION/.test(t2),
  t2.includes(marker) ? 'flagged item present under FLAGGED FOR DISCUSSION' : 'flagged item NOT surfaced (BAD)');

// X4: section filtering works (include:['mind'] omits the messages section)
const r3 = await client.callTool({ name: 'getContext', arguments: { include: ['mind'] } });
const t3 = r3.content?.[0]?.text || '';
rec('X4. include filter scopes sections', !/RECENT MESSAGES/.test(t3) && /Current time:/.test(t3),
  `mind-only briefing len=${t3.length}, no RECENT MESSAGES section`);

await client.close();
close();

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — getContext preamble boots, briefs, and surfaces flagged items (D5)' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
