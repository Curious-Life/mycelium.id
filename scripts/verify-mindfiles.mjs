// Verify the MIND-FILES subsystem + documents/internal tool domains.
//
// Boots the real server via boot(), connects a real MCP Client over an
// in-memory transport, asserts the new tools appear in tools/list, and
// exercises real round-trips:
//   - writeMindFileWhole -> readMindFile          (internal domain + mind-files)
//   - flagForDiscussion  -> readMindFile           (append semantics)
//   - saveDocument       -> getDocument            (documents domain + adapter)
//   - updateDocument mirror -> readMindFile        (MIND_MIRRORS side effect)
//   - ciphertext-at-rest on documents.content      (defense-in-depth)
//
// Ends with a VERDICT line and exits non-zero on any failure.
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const STAMP = Date.now();
const DB = `data/verify-mindfiles-${STAMP}.db`;
const KCV = `data/verify-mindfiles-${STAMP}-kcv.json`;
const AGENT_ROOT = `data/verify-mindfiles-${STAMP}-agent`;
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (name, pass, detail) => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};
const text = (res) => res?.content?.[0]?.text ?? '';

function cleanup() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
  try { rmSync(AGENT_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
}

cleanup();
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const userHex = hex(), systemHex = hex();
process.env.MYCELIUM_AGENT_ROOT = AGENT_ROOT;
// boot() pins ENCRYPTION_MASTER_KEY = userHex authoritatively; clear any stale
// value first so a prior import in this process can't shadow it.
delete process.env.ENCRYPTION_MASTER_KEY;

const { server, close, tools } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex });

// M1: the new tools are registered.
const names = new Set(tools.map((t) => t.name));
const expected = ['saveDocument', 'getDocument', 'listDocuments', 'updateDocument',
  'readMindFile', 'writeMindFileWhole', 'flagForDiscussion', 'updateInternalModel'];
const missing = expected.filter((n) => !names.has(n));
rec('M1. documents + internal tools registered', missing.length === 0,
  missing.length === 0 ? `all present: ${expected.join(', ')}` : `MISSING: ${missing.join(', ')}`);

// M2: every tool exposes a JSON-Schema object inputSchema.
const schemaOk = tools.every((t) => t.inputSchema && t.inputSchema.type === 'object');
rec('M2. all tools expose JSON-Schema inputSchema', schemaOk,
  schemaOk ? 'every tool.inputSchema.type === "object"' : 'a tool is missing a JSON-Schema');

// Connect a real MCP client over an in-memory transport pair.
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'verify-mindfiles', version: '0.0.0' }, { capabilities: {} });
await Promise.all([server.connect(serverT), client.connect(clientT)]);

// M3: client sees the new tools over the wire.
const listed = await client.listTools();
const wireNames = listed.tools.map((t) => t.name);
const wireMissing = expected.filter((n) => !wireNames.includes(n));
rec('M3. client tools/list returns the new tools', wireMissing.length === 0,
  `client saw ${wireNames.length} tools; missing=[${wireMissing.join(', ')}]`);

// M4: mind-file round-trip (writeMindFileWhole -> readMindFile).
let m4 = false, m4d = '';
try {
  const BODY = 'reflection: the vault holds.\nline two.';
  const w = await client.callTool({ name: 'writeMindFileWhole', arguments: { filename: 'model.md', content: BODY } });
  const r = await client.callTool({ name: 'readMindFile', arguments: { filename: 'model.md' } });
  m4 = !w.isError && text(r) === BODY;
  m4d = `write isError=${!!w.isError}; read exact-match=${text(r) === BODY} (${text(r).length} chars)`;
} catch (e) { m4d = `THREW: ${e.message}`; }
rec('M4. writeMindFileWhole -> readMindFile round-trips (encrypted at rest)', m4, m4d);

// M5: flagForDiscussion appends to flagged.md, readable afterwards.
let m5 = false, m5d = '';
try {
  await client.callTool({ name: 'flagForDiscussion', arguments: { topic: 'topology drift', context: 'M2 entropy moved' } });
  const r = await client.callTool({ name: 'readMindFile', arguments: { filename: 'flagged.md' } });
  m5 = /topology drift/.test(text(r));
  m5d = `flagged.md contains the topic=${/topology drift/.test(text(r))}`;
} catch (e) { m5d = `THREW: ${e.message}`; }
rec('M5. flagForDiscussion appends to flagged.md', m5, m5d);

// M6: document round-trip (saveDocument -> getDocument) through the adapter.
let m6 = false, m6d = '';
const DOC_BODY = 'Sarah is a longtime collaborator. Met in 2019.';
try {
  const sv = await client.callTool({ name: 'saveDocument', arguments: { path: 'people/sarah', content: DOC_BODY, title: 'Sarah' } });
  const gt = await client.callTool({ name: 'getDocument', arguments: { path: 'people/sarah' } });
  m6 = !sv.isError && text(gt).includes(DOC_BODY) && text(gt).includes('Sarah');
  m6d = `save='${text(sv).slice(0, 50)}'; get-includes-body=${text(gt).includes(DOC_BODY)}`;
} catch (e) { m6d = `THREW: ${e.message}`; }
rec('M6. saveDocument -> getDocument round-trips through the encrypting adapter', m6, m6d);

// M7: ciphertext-at-rest — the raw documents.content column is an envelope.
let m7 = false, m7d = '';
try {
  const probe = new Database(DB, { readonly: true });
  const row = probe.prepare('SELECT content FROM documents WHERE user_id = ? AND path = ?')
    .get('local-user', 'people/sarah');
  probe.close();
  const leaks = typeof row?.content === 'string' && row.content.includes(DOC_BODY);
  m7 = !!row && !leaks;
  m7d = `raw row present=${!!row}; leaks-plaintext=${leaks}`;
} catch (e) { m7d = `THREW: ${e.message}`; }
rec('M7. document content is ciphertext at rest (no plaintext leak)', m7, m7d);

// M8: mirror side effect — updateDocument on a MIND_MIRRORS path writes the
// mirror mind-file. 'internal/reflection_log' -> 'reflections.md'.
let m8 = false, m8d = '';
try {
  await client.callTool({ name: 'updateDocument', arguments: { path: 'internal/reflection_log', entry: 'mirrored note', entryType: 'note', confidence: 'medium' } });
  const r = await client.callTool({ name: 'readMindFile', arguments: { filename: 'reflections.md' } });
  m8 = /mirrored note/.test(text(r));
  m8d = `reflections.md mirror contains the entry=${/mirrored note/.test(text(r))}`;
} catch (e) { m8d = `THREW: ${e.message}`; }
rec('M8. updateDocument mirrors MIND_MIRRORS paths to mind-files', m8, m8d);

await client.close();
close();
cleanup();

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — mind-files + documents/internal domains boot, list, and round-trip' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
