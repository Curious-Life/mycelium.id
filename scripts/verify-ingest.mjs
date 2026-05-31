// captureMessage choke-point verifier (ingestion Step 2). Proves:
//   I1 captureMessage tool registered + a real save round-trips into messages
//   I2 ciphertext-at-rest — the raw content column is an envelope, not plaintext
//   I3 idempotency — same id twice => one row, second is deduped
//   I4 fail-closed — a write with no/invalid content path is rejected
//   I5 queued — the saved row has nlp_processed = 0 (enrichment work queue)
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { isEncrypted } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-ingest.db';
const KCV = 'data/verify-ingest-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (n, pass, d) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${n}\n      ${d}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const userHex = hex(), systemHex = hex();
const { server, db, close, tools } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex });

// I1: tool registered + a real capture round-trips
const has = tools.find((t) => t.name === 'captureMessage');
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'verify-ingest', version: '0' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);

const marker = `INGEST-${Date.now()}`;
const r1 = await client.callTool({ name: 'captureMessage', arguments: { content: marker, source: 'verify' } });
const r1text = r1.content?.[0]?.text || '';
// confirm it landed: read it back via the message stream
const rows = await db.messages.selectRecent('local-user', { limit: 5, scope: 'personal' });
const found = rows.find((m) => m.content === marker);
rec('I1. captureMessage tool registered + save round-trips into messages',
  !!has && /Captured/.test(r1text) && !!found,
  `tool=${!!has} reply="${r1text.slice(0, 40)}" foundInStream=${!!found}`);

// I2: ciphertext-at-rest — raw content column is an envelope
const savedId = found?.id;
{
  const raw = new Database(DB, { readonly: true });
  const rawContent = raw.prepare('SELECT content FROM messages WHERE id = ?').get(savedId)?.content;
  raw.close();
  rec('I2. ciphertext-at-rest (raw content column is an envelope, not plaintext)',
    isEncrypted(rawContent) && rawContent !== marker,
    `isEncrypted=${isEncrypted(rawContent)} leaks=${rawContent === marker}`);
}

// I3: idempotency — same id twice => one row
const fixedId = crypto.randomUUID();
await client.callTool({ name: 'captureMessage', arguments: { content: 'dup-test', id: fixedId } });
const dup = await client.callTool({ name: 'captureMessage', arguments: { content: 'dup-test', id: fixedId } });
const dupText = dup.content?.[0]?.text || '';
const cnt = new Database(DB, { readonly: true });
const n = cnt.prepare('SELECT COUNT(*) c FROM messages WHERE id = ?').get(fixedId).c;
cnt.close();
rec('I3. idempotency — same id twice => one row', n === 1 && /Already captured/.test(dupText),
  `rowCount=${n} secondReply="${dupText.slice(0, 40)}"`);

// I4: empty content rejected (choke-point validation)
const empty = await client.callTool({ name: 'captureMessage', arguments: { content: '   ' } });
const emptyText = empty.content?.[0]?.text || '';
rec('I4. empty content rejected', /Error|required/i.test(emptyText), `reply="${emptyText.slice(0, 40)}"`);

// I5: saved row is queued for enrichment (nlp_processed = 0)
{
  const q = new Database(DB, { readonly: true });
  const np = q.prepare('SELECT nlp_processed FROM messages WHERE id = ?').get(savedId)?.nlp_processed;
  q.close();
  rec('I5. saved message queued for enrichment (nlp_processed = 0)', np === 0, `nlp_processed=${np}`);
}

await client.close();
close();

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — captureMessage choke-point saves, encrypts, dedupes, queues' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
