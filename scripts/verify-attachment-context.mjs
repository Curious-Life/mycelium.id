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

// A7: corrupt pdf → fail-soft null (unpdf cannot parse 8 junk bytes)
{
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: Buffer.from('%PDF-1.4'), fileName: 'doc.pdf', fileType: 'application/pdf' });
  const r = await call({ attachmentId });
  rec('A7. corrupt pdf → ok:true contextText:null (fail-soft, kind=file)',
    r.status === 200 && r.body?.contextText === null && r.body?.kind === 'file', `kind=${r.body?.kind}`);
}

// A9: REAL pdf → text extracted via unpdf + stored encrypted in description
{
  // assemble a minimal valid PDF with correct xref offsets
  const mk = () => {
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      null, // content stream, built below
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    const stream = 'BT /F1 24 Tf 72 700 Td (Hello vault PDF) Tj ET';
    objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    let out = '%PDF-1.4\n';
    const offsets = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  };
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: mk(), fileName: 'hello.pdf', fileType: 'application/pdf' });
  const r = await call({ attachmentId });
  const raw = rawCol(attachmentId, 'description');
  rec('A9. real pdf → text extracted (unpdf) + stored encrypted',
    r.status === 200 && /Hello vault PDF/.test(r.body?.contextText || '') && isEncrypted(raw),
    `ctx="${(r.body?.contextText || '').slice(0, 40)}" enc=${isEncrypted(raw)}`);
}

// A10: REAL docx (minimal OOXML zip) → text extracted via mammoth
{
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Water the docx plants</w:t></w:r></w:p></w:body></w:document>');
  const docxBytes = await zip.generateAsync({ type: 'nodebuffer' });
  const { attachmentId } = await uploadAttachment(db, { userId, bytes: docxBytes, fileName: 'todo.docx', fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const r = await call({ attachmentId });
  rec('A10. real docx → text extracted (mammoth)',
    r.status === 200 && /Water the docx plants/.test(r.body?.contextText || ''),
    `ctx="${(r.body?.contextText || '').slice(0, 40)}"`);
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
