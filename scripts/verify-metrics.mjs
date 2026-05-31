// Metrics-domain proof (Wave 2): boot the real server, connect a real MCP
// client over an in-memory transport pair, and check the metrics tool domain
// end to end against an EMPTY vault. PASS/FAIL ledger; exits 0 only on full GO.
//
// Mirrors scripts/verify-mcp.mjs (same boot() + InMemoryTransport pattern).
//
//   M1. metrics domain registered — its four tools appear in tools/list
//   M2. every metrics tool exposes a plain JSON-Schema inputSchema (type:object)
//   M3. getHarmonicState on an EMPTY db returns text (no crash, no isError)
//   M4. that empty-window text carries the CONTRACTS refusal copy (honest copy,
//       not a stub) — proves the unblocked contracts module is wired through
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { boot } from '../src/index.js';
import { CONTRACTS } from '../src/metrics/contracts.js';

const DB = 'data/verify-metrics.db';
const KCV = 'data/verify-metrics-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');

// getFlowFeatures + getShape were folded into getHarmonicState(detail:'flow'|'shape').
const METRICS_TOOLS = ['getHarmonicState', 'getMetricSeries'];

const ledger = [];
const rec = (name, pass, detail) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
new Database(DB).exec(readFileSync('migrations/0001_init.sql', 'utf8'));

const userHex = hex(), systemHex = hex();
// Fresh vault: migration creates the schema but no metrics rows are written,
// so every window is empty — exactly the refusal path we want to exercise.
const { server, db, close, tools } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex });

// connect a real MCP client over an in-memory transport pair
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'verify-metrics-client', version: '0.0.0' }, { capabilities: {} });
await Promise.all([server.connect(serverT), client.connect(clientT)]);

// M1: metrics tools present in tools/list (over the wire)
const listed = await client.listTools();
const names = listed.tools.map((t) => t.name);
const present = METRICS_TOOLS.filter((n) => names.includes(n));
rec('M1. metrics domain registered + tools in tools/list',
  present.length === METRICS_TOOLS.length && !names.includes('getFlowFeatures') && !names.includes('getShape'),
  `saw ${present.join(', ')}; folded tools absent: ${!names.includes('getFlowFeatures') && !names.includes('getShape')}`);

// M2: every metrics tool has a JSON-Schema object inputSchema (not Zod)
const metricsTools = listed.tools.filter((t) => METRICS_TOOLS.includes(t.name));
const schemaOk = metricsTools.length === METRICS_TOOLS.length
  && metricsTools.every((t) => t.inputSchema && t.inputSchema.type === 'object');
rec('M2. all metrics tools expose JSON-Schema inputSchema (type: object)', schemaOk,
  metricsTools.map((t) => `${t.name}:${t.inputSchema?.type}`).join(', '));

// M3: getHarmonicState against an EMPTY db returns text, no crash, no isError
let res, text = '', notError = false;
try {
  res = await client.callTool({ name: 'getHarmonicState', arguments: {} });
  text = res?.content?.[0]?.text || '';
  notError = res?.isError !== true && res?.content?.[0]?.type === 'text';
} catch (e) {
  text = `THREW: ${e.message}`;
}
rec('M3. getHarmonicState on empty db returns text (no crash, no isError)',
  notError && text.length > 0,
  `isError=${res?.isError === true} text.len=${text.length}`);

// M4: the returned text is the honest CONTRACTS refusal copy (not a stub)
const expected = CONTRACTS.information_harmonic_amplitude.refusal_mode;
rec('M4. empty-window text carries the CONTRACTS refusal copy',
  expected.length > 0 && text.includes(expected),
  `contains refusal_mode: ${text.includes(expected)}`);

// M5: the folded detail modes ('flow'/'shape') still work (capability preserved)
let foldOk = false, foldDetail = '';
try {
  const flow = await client.callTool({ name: 'getHarmonicState', arguments: { detail: 'flow' } });
  const shape = await client.callTool({ name: 'getHarmonicState', arguments: { detail: 'shape' } });
  const fText = flow?.content?.[0]?.text || '', sText = shape?.content?.[0]?.text || '';
  // empty vault → both return their honest refusal copy, no crash
  foldOk = flow?.isError !== true && shape?.isError !== true
    && fText.includes(CONTRACTS.bigram_flow_features.refusal_mode)
    && sText.includes(CONTRACTS.topology_persistence_entropy.refusal_mode);
  foldDetail = `flow refusal=${fText.includes(CONTRACTS.bigram_flow_features.refusal_mode)} shape refusal=${sText.includes(CONTRACTS.topology_persistence_entropy.refusal_mode)}`;
} catch (e) { foldDetail = `THREW: ${e.message}`; }
rec('M5. getHarmonicState detail:flow/shape preserve the folded capabilities', foldOk, foldDetail);

await client.close();
close();
db; // referenced

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — metrics domain boots, lists tools, refuses empty windows honestly' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
