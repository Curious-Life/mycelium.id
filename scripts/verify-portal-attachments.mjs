// verify:portal-attachments — the Media library surface (/api/v1/portal/attachments).
// Real temp vault + real encrypted blobs; proves list shape/filter/search over
// DECRYPTED fields, byte round-trip with no-store, cross-user 404s, patch, delete.
process.env.MYCELIUM_UPLOADS_ROOT = 'data/verify-pattach-uploads';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { portalAttachmentsRouter, mediaTypeOf } from '../src/portal-attachments.js';
import { uploadAttachment } from '../src/ingest/upload.js';
import { isEncrypted } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-pattach.db';
const KCV = 'data/verify-pattach-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync('data/verify-pattach-uploads', { recursive: true }); } catch { /* */ }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'local-user';

const app = express();
app.use('/api/v1/portal', portalAttachmentsRouter({ db, userId }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/v1/portal`;

// fixtures: a photo (with description), a voice note (with transcript), a pdf
const png = await uploadAttachment(db, { userId, bytes: Buffer.from('PNGBYTES-cat'), fileName: 'cat.jpg', fileType: 'image/jpeg' });
await db.attachments.update(png.attachmentId, { description: 'a tabby cat on a desk' });
const ogg = await uploadAttachment(db, { userId, bytes: Buffer.from('OGGBYTES'), fileName: 'note.ogg', fileType: 'audio/ogg' });
await db.attachments.update(ogg.attachmentId, { transcript: 'water the plants' });
const pdf = await uploadAttachment(db, { userId, bytes: Buffer.from('%PDF-1.4 fake'), fileName: 'doc.pdf', fileType: 'application/pdf' });
const alien = await db.attachments.insert({ user_id: 'someone-else', file_name: 'alien.jpg', file_type: 'image/jpeg', file_size: 1, local_path: 'someone-else/x.enc' });

// L1: list shape + type mapping + url
{
  const r = await fetch(`${base}/attachments?limit=50`).then((x) => x.json());
  const img = r.attachments.find((a) => a.id === png.attachmentId);
  rec('L1. list: total, kind mapping, url, decrypted description',
    r.total === 3 && img?.type === 'image' && img?.url === `/api/v1/portal/attachments/${png.attachmentId}/file`
    && img?.description === 'a tabby cat on a desk' && mediaTypeOf('audio/ogg') === 'voice',
    `total=${r.total} type=${img?.type}`);
  rec('L2. cross-user rows excluded from list', !r.attachments.some((a) => a.id === alien.id));
}

// L3: type filter + search over decrypted fields
{
  const voice = await fetch(`${base}/attachments?type=voice`).then((x) => x.json());
  const found = await fetch(`${base}/attachments?search=tabby`).then((x) => x.json());
  const none = await fetch(`${base}/attachments?search=zebra`).then((x) => x.json());
  rec('L3. type filter + search on decrypted description',
    voice.total === 1 && voice.attachments[0].id === ogg.attachmentId
    && found.total === 1 && found.attachments[0].id === png.attachmentId && none.total === 0,
    `voice=${voice.total} tabby=${found.total} zebra=${none.total}`);
}

// L4: file serve — decrypted bytes round-trip + headers
{
  const r = await fetch(`${base}/attachments/${png.attachmentId}/file`);
  const body = Buffer.from(await r.arrayBuffer());
  rec('L4. serve: decrypted bytes + content-type + no-store',
    r.status === 200 && body.toString() === 'PNGBYTES-cat' && r.headers.get('content-type').startsWith('image/jpeg')
    && r.headers.get('cache-control') === 'no-store', `ct=${r.headers.get('content-type')}`);
}

// L5: cross-user serve/patch/delete → 404
{
  const s = await fetch(`${base}/attachments/${alien.id}/file`);
  const p = await fetch(`${base}/attachments/${alien.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"description":"x"}' });
  const d = await fetch(`${base}/attachments/${alien.id}`, { method: 'DELETE' });
  rec('L5. cross-user serve/patch/delete all 404', s.status === 404 && p.status === 404 && d.status === 404, `${s.status}/${p.status}/${d.status}`);
}

// L6: patch description → stored ENCRYPTED, readable back decrypted
{
  await fetch(`${base}/attachments/${pdf.attachmentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"description":"quarterly report"}' });
  const raw = new Database(DB, { readonly: true });
  const rawDesc = raw.prepare('SELECT description FROM attachments WHERE id = ?').get(pdf.attachmentId)?.description;
  raw.close();
  const r = await fetch(`${base}/attachments?search=quarterly`).then((x) => x.json());
  rec('L6. patched description encrypted at rest + searchable decrypted', isEncrypted(rawDesc) && r.total === 1, `enc=${isEncrypted(rawDesc)}`);
}

// L7: delete removes the row AND the blob file
{
  const row = await db.attachments.getById(ogg.attachmentId);
  const blobPath = join('data/verify-pattach-uploads', row.local_path);
  const d = await fetch(`${base}/attachments/${ogg.attachmentId}`, { method: 'DELETE' });
  const after = await db.attachments.getById(ogg.attachmentId);
  rec('L7. delete: row gone + blob unlinked', d.status === 200 && !after && !existsSync(blobPath), `blobGone=${!existsSync(blobPath)}`);
}

server.close();
close();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
console.log(`VERDICT: ${passed === ledger.length ? 'GO' : 'NO-GO'}`);
process.exit(passed === ledger.length ? 0 : 1);
