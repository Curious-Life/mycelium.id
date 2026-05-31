// MCP-server proof (Wave 1, milestone 2): boot the real server, connect a real
// MCP client over an in-memory transport pair, and drive tools/list + a
// tools/call round-trip. PASS/FAIL ledger; exits 0 only on full GO.
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { boot } from '../src/index.js';

const DB = 'data/verify-mcp.db';
const KCV = 'data/verify-mcp-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (name, pass, detail) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
new Database(DB).exec(readFileSync('migrations/0001_init.sql', 'utf8'));

const userHex = hex(), systemHex = hex();
const { server, db, close, tools, deferred } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex });

// C1: server boots + registers tools
rec('C1. server boots, tools registered', tools.length > 0,
  `${tools.length} tools registered, ${deferred.length} deferred`);

// C2: every registered tool has JSON-Schema inputSchema (not Zod) + a handler
const schemaOk = tools.every((t) => t.inputSchema && t.inputSchema.type === 'object');
rec('C2. all tools expose JSON-Schema inputSchema', schemaOk,
  schemaOk ? 'every tool.inputSchema.type === "object"' : 'a tool is missing a JSON-Schema');

// connect a real MCP client over an in-memory transport pair
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'verify-client', version: '0.0.0' }, { capabilities: {} });
await Promise.all([server.connect(serverT), client.connect(clientT)]);

// C3: tools/list over the wire
const listed = await client.listTools();
rec('C3. client tools/list returns the registered tools', listed.tools.length === tools.length,
  `client saw ${listed.tools.length} tools (expected ${tools.length}): ${listed.tools.map((t) => t.name).join(', ')}`);

// C4: tools/call round-trip — seed a task, then call createTask + getDailyMessages
let callOk = false, detail = '';
try {
  const made = await client.callTool({ name: 'createTask', arguments: { content: 'verify e2e task' } });
  const text = made.content?.[0]?.text || '';
  // result must be a wrapped text content envelope (string -> content)
  callOk = made.content?.[0]?.type === 'text' && typeof text === 'string' && text.length > 0;
  detail = `createTask -> content[0].type='${made.content?.[0]?.type}' text='${text.slice(0, 60)}'`;
} catch (e) {
  detail = `THREW: ${e.message}`;
}
rec('C4. tools/call returns a wrapped text content envelope', callOk, detail);

// C4b: createTask -> listTasks round-trip (tasks are no longer write-only)
let listOk = false, listDetail = '';
try {
  const marker = `LIST-TASK-${Date.now()}`;
  await client.callTool({ name: 'createTask', arguments: { content: marker } });
  const listed = await client.callTool({ name: 'listTasks', arguments: {} });
  const ltext = listed.content?.[0]?.text || '';
  listOk = ltext.includes(marker);
  listDetail = `listTasks ${listOk ? 'surfaced' : 'MISSED'} the created task; head="${ltext.slice(0, 50)}"`;
} catch (e) { listDetail = `THREW: ${e.message}`; }
rec('C4b. createTask -> listTasks round-trip', listOk, listDetail);

// C5: unknown tool is handled (isError), not a crash
let unknownOk = false;
try {
  const r = await client.callTool({ name: 'no_such_tool', arguments: {} });
  unknownOk = r.isError === true;
} catch { unknownOk = false; }
rec('C5. unknown tool returns isError (no crash)', unknownOk, unknownOk ? 'isError=true' : 'did not flag error');

await client.close();
close();
db; // referenced

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — MCP server boots, lists tools, and answers tools/call' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
