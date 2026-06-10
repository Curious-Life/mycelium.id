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

// I6: importMessages bulk-creates, idempotent ids
const batchId = `BATCH-${Date.now()}`;
const batch = [
  { content: 'import one', id: `${batchId}-1`, source: 'telegram', metadata: { sender: 'A' } },
  { content: 'import two', id: `${batchId}-2`, source: 'telegram', timestamp: '2026-01-01T00:00:00Z' },
  { content: '', id: `${batchId}-3` }, // empty → skipped (missing content)
];
const imp1 = await client.callTool({ name: 'importMessages', arguments: { messages: batch } });
const imp1text = imp1.content?.[0]?.text || '';
{
  const q = new Database(DB, { readonly: true });
  const c = q.prepare("SELECT COUNT(*) c FROM messages WHERE id LIKE ?").get(`${batchId}-%`).c;
  q.close();
  rec('I6. importMessages bulk-creates (2 new, 1 empty skipped)',
    c === 2 && /2 new/.test(imp1text), `rows=${c} reply="${imp1text.slice(0, 60)}"`);
}

// I7: re-importing the same batch is idempotent (0 new, all duplicates)
const imp2 = await client.callTool({ name: 'importMessages', arguments: { messages: batch } });
const imp2text = imp2.content?.[0]?.text || '';
{
  const q = new Database(DB, { readonly: true });
  const c = q.prepare("SELECT COUNT(*) c FROM messages WHERE id LIKE ?").get(`${batchId}-%`).c;
  q.close();
  rec('I7. re-import is idempotent (no new rows, dupes detected)',
    c === 2 && /0 new/.test(imp2text) && /2 duplicates/.test(imp2text),
    `rows=${c} reply="${imp2text.slice(0, 60)}"`);
}

// I8-I10: channel-relay passthrough — metadata, createdAt, attachmentId reach the
// row (2026-06-10 live bug: the handler dropped them; every telegram message had
// metadata NULL and sender/chatTitle/replyTo context was silently lost).
const relayId = `RELAY-${Date.now()}`;
await client.callTool({ name: 'captureMessage', arguments: {
  content: 'relay passthrough test', id: relayId, source: 'telegram',
  metadata: { sender: 'Marius', senderRole: 'owner', chatTitle: 'Shared Group' },
  createdAt: 1781000000, // epoch seconds → normalized ISO
  attachmentId: 'att-relay-1',
} });
{
  // db.rawQuery rides d1Query → ENCRYPTED_FIELDS auto-decrypt on SELECT.
  const sel = await db.rawQuery('SELECT metadata FROM messages WHERE id = ?', [relayId]);
  const decrypted = sel?.results?.[0]?.metadata ?? sel?.[0]?.metadata ?? null;
  let meta = null;
  try { meta = typeof decrypted === 'string' ? JSON.parse(decrypted) : decrypted; } catch { /* */ }
  rec('I8. metadata passthrough — sender/chatTitle survive to the (encrypted) row',
    meta?.sender === 'Marius' && meta?.chatTitle === 'Shared Group',
    `metadata=${JSON.stringify(meta || null).slice(0, 60)}`);

  const q = new Database(DB, { readonly: true });
  const raw = q.prepare('SELECT created_at, attachment_id, metadata FROM messages WHERE id = ?').get(relayId);
  q.close();
  rec('I9. createdAt passthrough — epoch seconds land as the original ISO time',
    String(raw?.created_at || '') === new Date(1781000000 * 1000).toISOString(),
    `created_at=${raw?.created_at}`);
  rec('I10. attachmentId passthrough + raw metadata column is ciphertext',
    raw?.attachment_id === 'att-relay-1' && isEncrypted(raw?.metadata),
    `attachment_id=${raw?.attachment_id} metaEncrypted=${isEncrypted(raw?.metadata)}`);
}

await client.close();
close();

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — captureMessage + importMessages: save, encrypt, dedupe, queue, bulk-import' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
