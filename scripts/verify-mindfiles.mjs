// Mind-files + documents/internal surface verifier: boot the real server,
// connect a real MCP Client over an in-memory transport pair, and prove the new
// tool domains are registered and round-trip end-to-end:
//   - internal:  writeMindFileWhole -> readMindFile (encrypted on disk)
//   - documents: saveDocument -> getDocument (encrypted in SQLite + mirrored)
//
// Mirrors scripts/verify-mcp.mjs ledger style: PASS/FAIL lines + final VERDICT.
import Database from 'better-sqlite3';
import { readFileSync, rmSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { boot } from '../src/index.js';

const ledger = [];
const rec = (name, pass, detail) => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};
const textOf = (res) => res?.content?.[0]?.text ?? '';

// Hermetic temp workspace: temp DB + KCV + mind-files root. Nothing real touched.
const tmp = path.join(os.tmpdir(), `mycelium-mindfiles-${crypto.randomBytes(6).toString('hex')}`);
mkdirSync(tmp, { recursive: true });
const DB = path.join(tmp, 'mindfiles.db');
const KCV = path.join(tmp, 'kcv.json');
const MIND_ROOT = path.join(tmp, 'mind');
// createMindFiles places files at <MIND_FILES_ROOT>/<agentId>/mind/<filename>.
const MODEL_ON_DISK = path.join(MIND_ROOT, 'personal-agent', 'mind', 'model.md');

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
process.env.MIND_FILES_ROOT = MIND_ROOT;

// boot() opens the DB but does not migrate — seed the schema first.
new Database(DB).exec(readFileSync('migrations/0001_init.sql', 'utf8'));

const { server, close, tools, deferred } = await boot({
  dbPath: DB, kcvPath: KCV, userHex, systemHex,
});

// D1: server boots with the two new domains registered.
rec('D1. server boots, tools registered', tools.length > 0,
  `${tools.length} tools registered, ${deferred.length} deferred`);

// D2: the new documents + internal tools appear in the surface.
const names = new Set(tools.map((t) => t.name));
const expected = ['saveDocument', 'getDocument', 'listDocuments', 'updateDocument',
  'readMindFile', 'writeMindFileWhole', 'editMindFile', 'snapshotMindFile',
  'updateInternalModel', 'flagForDiscussion'];
const missing = expected.filter((n) => !names.has(n));
rec('D2. documents + internal tools registered', missing.length === 0,
  missing.length === 0 ? `all ${expected.length} present` : `missing: ${missing.join(', ')}`);

// D3: documents + internal are no longer in the deferred set.
const stillDeferred = deferred.filter((d) => /documents|internal/.test(d));
rec('D3. documents + internal moved out of deferred', stillDeferred.length === 0,
  stillDeferred.length === 0 ? 'neither deferred' : `still deferred: ${stillDeferred.join(', ')}`);

// Connect a real MCP client over an in-memory transport pair.
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'verify-mindfiles', version: '0.0.0' }, { capabilities: {} });
await Promise.all([server.connect(serverT), client.connect(clientT)]);

// D4: every tool exposes a JSON-Schema inputSchema; client sees the full set.
const listed = await client.listTools();
const schemaOk = listed.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object');
rec('D4. tools/list returns JSON-Schema tools', schemaOk && listed.tools.length === tools.length,
  `client saw ${listed.tools.length} tools; schema.type==='object' for all: ${schemaOk}`);

// D5: internal round-trip — writeMindFileWhole then readMindFile (exact content).
// Capture the encrypted on-disk bytes immediately after the write (known path)
// so D6's at-rest assertion has no dependency on later steps.
let d5 = false, d5detail = '';
let modelDiskBytes = null;
try {
  const wrote = await client.callTool({
    name: 'writeMindFileWhole',
    arguments: { filename: 'model.md', content: 'hello vault' },
  });
  const wroteJson = JSON.parse(textOf(wrote));
  try { modelDiskBytes = await readFile(MODEL_ON_DISK); } catch { /* captured below as failure */ }
  const read = await client.callTool({
    name: 'readMindFile', arguments: { filename: 'model.md' },
  });
  d5 = wroteJson.ok === true && textOf(read) === 'hello vault';
  d5detail = `write.ok=${wroteJson.ok} read='${textOf(read).slice(0, 40)}'`;
} catch (e) { d5detail = `THREW: ${e.message}`; }
rec('D5. writeMindFileWhole -> readMindFile round-trip', d5, d5detail);

// D6: the on-disk mind-file is encrypted at rest — MIND magic present, plaintext
// absent from the raw bytes captured in D5.
let d6 = false, d6detail = '';
if (!modelDiskBytes) {
  d6detail = `no bytes read from ${MODEL_ON_DISK}`;
} else {
  const hasMagic = modelDiskBytes.subarray(0, 4).toString('latin1') === 'MIND';
  const leaks = modelDiskBytes.toString('utf8').includes('hello vault');
  d6 = hasMagic && !leaks;
  d6detail = `bytes=${modelDiskBytes.length} MIND-magic=${hasMagic} plaintext-leak=${leaks}`;
}
rec('D6. mind-file encrypted at rest (no plaintext leak)', d6, d6detail);

// D7: flagForDiscussion appends to flagged.md (topic + context persisted).
let d7 = false, d7detail = '';
try {
  const flagged = await client.callTool({
    name: 'flagForDiscussion',
    arguments: { topic: 'revisit the plan', context: 'priorities shifted' },
  });
  const flagFile = await client.callTool({
    name: 'readMindFile', arguments: { filename: 'flagged.md' },
  });
  const body = textOf(flagFile);
  d7 = textOf(flagged).includes('revisit the plan')
    && body.includes('revisit the plan') && body.includes('priorities shifted');
  d7detail = `confirm='${textOf(flagged).slice(0, 40)}' fileHasBoth=${body.includes('revisit the plan') && body.includes('priorities shifted')}`;
} catch (e) { d7detail = `THREW: ${e.message}`; }
rec('D7. flagForDiscussion persists to flagged.md', d7, d7detail);

// D8: documents round-trip — saveDocument then getDocument (title + content).
let d8 = false, d8detail = '';
try {
  const saved = await client.callTool({
    name: 'saveDocument',
    arguments: { path: 'notes/idea', title: 'Big Idea', content: '# secret body' },
  });
  const got = await client.callTool({
    name: 'getDocument', arguments: { path: 'notes/idea' },
  });
  const gotText = textOf(got);
  d8 = /Created|Updated/.test(textOf(saved))
    && gotText.includes('Big Idea') && gotText.includes('# secret body');
  d8detail = `save='${textOf(saved).slice(0, 40)}' get-has-title+body=${gotText.includes('Big Idea') && gotText.includes('# secret body')}`;
} catch (e) { d8detail = `THREW: ${e.message}`; }
rec('D8. saveDocument -> getDocument round-trip', d8, d8detail);

// D9: document is ciphertext-at-rest in SQLite (content column not plaintext).
let d9 = false, d9detail = '';
try {
  const raw = new Database(DB, { readonly: true })
    .prepare('SELECT content FROM documents WHERE path = ?').get('notes/idea');
  const leaks = typeof raw?.content === 'string' && raw.content.includes('# secret body');
  d9 = raw != null && !leaks;
  d9detail = `row-present=${raw != null}, plaintext-leak=${leaks}`;
} catch (e) { d9detail = `THREW: ${e.message}`; }
rec('D9. document encrypted at rest in SQLite', d9, d9detail);

// D10: saveDocument mirrors a MIND_MIRRORS path into mind-files.
// 'internal/reflection_log' -> 'reflections.md'.
let d10 = false, d10detail = '';
try {
  await client.callTool({
    name: 'saveDocument',
    arguments: { path: 'internal/reflection_log', title: 'Reflections', content: 'mirror me' },
  });
  const mirror = await client.callTool({
    name: 'readMindFile', arguments: { filename: 'reflections.md' },
  });
  d10 = textOf(mirror) === 'mirror me';
  d10detail = `mirror='${textOf(mirror).slice(0, 40)}'`;
} catch (e) { d10detail = `THREW: ${e.message}`; }
rec('D10. MIND_MIRRORS path mirrored to mind-files', d10, d10detail);

await client.close();
close?.();
try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — mind-files subsystem + documents/internal tools round-trip end-to-end' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
