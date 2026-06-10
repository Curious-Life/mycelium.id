// verify:attachment-context — the loopback extraction route (step 3 of
// docs/CHANNEL-INBOUND-MEDIA-DESIGN-2026-06-10.md). Real temp vault + REAL
// encrypted blob round-trip (putBlob → getBlob); the models are faked (DI seam)
// so the gate runs without Ollama. Proves:
//   A1 image → caption returned + stored ENCRYPTED in attachments.description
//   A2 audio → transcript returned + stored ENCRYPTED in attachments.transcript
//   A3 text file → decoded content returned, big files truncated
//   A4 unknown attachment → 404
//   A5 cross-user attachment → 404 (no existence leak)
//   A6 no capable model (extractor null) → ok:true contextText:null
//   A7 binary 'file' kind (pdf) → ok:true contextText:null (honest, step-5 scope)
//   A8 blob read failure → 200 ok:false-free fail-soft (extraction-error)
process.env.MYCELIUM_UPLOADS_ROOT = 'data/verify-attctx-uploads';
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { internalRouter } from '../src/internal-router.js';
import { uploadAttachment } from '../src/ingest/upload.js';
import { isEncrypted } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-attctx.db';
const KCV = 'data/verify-attctx-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
try { rmSync('data/verify-attctx-uploads', { recursive: true }); } catch { /* */ }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));

const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex() });
const userId = 'local-user';

// Fakes: describe/transcribe controllable per-case; getBlob stays REAL.
let captionResult = 'a red square on white';
let transcriptResult = 'hello mycelium remind me to water the plants';
const enrich = {
  describeImage: async ({ bytes }) => (Buffer.isBuffer(bytes) ? captionResult : null),
  transcribeAudio: async ({ bytes }) => (Buffer.isBuffer(bytes) ? transcriptResult : null),
};

const app = express();
app.use(internalRouter({ db, userId, enrich }));
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (body) => {
  const res = await fetch(`${base}/api/v1/internal/attachment-context`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rawCol = (id, col) => {
  const q = new Database(DB, { readonly: true });
  const v = q.prepare(`SELECT ${col} c FROM attachments WHERE id = ?`).get(id)?.c;
  q.close();
  return v;
};

// A1: image → caption + encrypted description
{
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('PNGBYTES'), fileName: 'square.png', fileType: 'image/png' });
  const r = await call({ attachmentId });
  const raw = rawCol(attachmentId, 'description');
  rec('A1. image → caption returned + description stored encrypted',
    r.status === 200 && r.body?.contextText === captionResult && isEncrypted(raw) && raw !== captionResult,
    `ctx="${r.body?.contextText}" enc=${isEncrypted(raw)}`);
}

// A2: audio → transcript + encrypted transcript column
{
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('OGGBYTES'), fileName: 'note.ogg', fileType: 'audio/ogg' });
  const r = await call({ attachmentId, kind: 'voice' });
  const raw = rawCol(attachmentId, 'transcript');
  rec('A2. voice → transcript returned + transcript stored encrypted',
    r.status === 200 && r.body?.contextText === transcriptResult && isEncrypted(raw),
    `ctx="${(r.body?.contextText || '').slice(0, 30)}…" enc=${isEncrypted(raw)}`);
}

// A3: text file → decoded inline; oversize truncated
{
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('# Notes\nwater the plants'), fileName: 'notes.md', fileType: 'text/markdown' });
  const r = await call({ attachmentId });
  rec('A3a. markdown → decoded text returned', r.body?.contextText === '# Notes\nwater the plants', `ctx="${r.body?.contextText}"`);

  const big = 'x'.repeat(9000);
  const { attachmentId: bigId } = await uploadAttachment(db, { userId, bytes: Buffer.from(big), fileName: 'big.txt', fileType: 'text/plain' });
  const rb = await call({ attachmentId: bigId });
  rec('A3b. oversize text truncated with marker',
    (rb.body?.contextText || '').length < 9000 && /truncated/.test(rb.body?.contextText || ''),
    `len=${(rb.body?.contextText || '').length}`);
}

// A4: unknown id → 404
{
  const r = await call({ attachmentId: 'no-such-id' });
  rec('A4. unknown attachment → 404', r.status === 404);
}

// A5: cross-user attachment → 404 (no existence leak)
{
  const inserted = await db.attachments.insert({ user_id: 'someone-else', file_name: 'x.png', file_type: 'image/png', file_size: 1, local_path: 'someone-else/x.enc' });
  const r = await call({ attachmentId: inserted.id });
  rec('A5. cross-user attachment → 404 (no leak)', r.status === 404);
}

// A6: extractor returns null (no capable model) → ok:true, contextText:null
{
  captionResult = null;
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('PNG2'), fileName: 'p2.png', fileType: 'image/png' });
  const r = await call({ attachmentId });
  const raw = rawCol(attachmentId, 'description');
  rec('A6. no capable model → ok:true contextText:null, nothing stored',
    r.status === 200 && r.body?.ok === true && r.body?.contextText === null && raw == null,
    `ctx=${r.body?.contextText} desc=${raw}`);
  captionResult = 'a red square on white';
}

// A7: binary file (pdf) → honest null (extraction is step-5 scope)
{
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('%PDF-1.4'), fileName: 'doc.pdf', fileType: 'application/pdf' });
  const r = await call({ attachmentId });
  rec('A7. pdf (binary) → ok:true contextText:null kind=file',
    r.status === 200 && r.body?.contextText === null && r.body?.kind === 'file', `kind=${r.body?.kind}`);
}

// A8: blob read failure → fail-soft 200 (daemon falls back to placeholder)
{
  const inserted = await db.attachments.insert({ user_id: userId, file_name: 'gone.png', file_type: 'image/png', file_size: 1, local_path: `${userId}/does-not-exist.enc` });
  const r = await call({ attachmentId: inserted.id });
  rec('A8. blob read failure → 200 fail-soft (reason extraction-error)',
    r.status === 200 && r.body?.contextText === null && r.body?.reason === 'extraction-error', `reason=${r.body?.reason}`);
}

server.close();
close();
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
console.log(`VERDICT: ${passed === ledger.length ? 'GO' : 'NO-GO'}`);
process.exit(passed === ledger.length ? 0 : 1);
