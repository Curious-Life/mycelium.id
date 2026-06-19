// Verify — Obsidian vault images & embeds (the broken-links fix).
// Drives the browser `files` transport (notes as text + assets as base64) and
// asserts vault media lands as ENCRYPTED attachments with note embeds rewritten
// to the portal attachment URL — document copy only; memory keeps the original.
//
//   I1 assets land         2 referenced images → encrypted blobs (MYCB) + rows;
//                          byte-duplicate shares ONE blob (blobsReused)
//   I2 embeds rewritten    ![[wiki]] + ![md](rel) → /api/v1/portal/attachments/<id>/file;
//                          missing target LEFT INTACT + counted unresolved
//   I3 memory unrewritten  the mindscape copy keeps ![[photo.png]] (no URLs in embeddings)
//   I4 encrypted at rest   image bytes + note text absent from db file + blob files
//   I5 idempotent          re-import → assets deduped, zero new blobs, doc still renders
//   I6 traversal           ../evil.png asset rejected (unsafe_path), nothing stored
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import crypto from 'node:crypto';
import { rmSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const DB = 'data/verify-obs-img.db';
const KCV = 'data/verify-obs-img-kcv.json';
const UPLOADS = 'data/verify-obs-img-uploads';
process.env.MYCELIUM_UPLOADS_ROOT = UPLOADS;
process.env.MYCELIUM_DISABLE_EMBED = '1';

const { applyMigrations } = await import('../src/db/migrate.js');
const { startRestServer } = await import('../src/server-rest.js');
const { importMasterKey, decrypt } = await import('../src/crypto/crypto-local.js');

const hex = () => crypto.randomBytes(32).toString('hex');
const USER_HEX = hex();
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const IMG_BYTES = Buffer.from('fake-png-binary-marker-bytes-0123456789-not-in-plaintext');
const NOTE_TEXT = 'a note that embeds vault media and must render after import';

function vaultFiles() {
  return [
    { relPath: 'notes/idea.md', content: `# Idea\n\n${NOTE_TEXT}\n\n![[photo.png]]\n\n![inline](../assets/inline.png)\n\n![[missing.png]]\n`, mtime: '2024-05-01T00:00:00.000Z' },
    { relPath: 'photo.png', contentBase64: IMG_BYTES.toString('base64'), mtime: '2024-05-01T00:00:00.000Z' },
    { relPath: 'assets/inline.png', contentBase64: IMG_BYTES.toString('base64'), mtime: '2024-05-01T00:00:00.000Z' }, // same bytes → shared blob
    { relPath: '../evil.png', contentBase64: IMG_BYTES.toString('base64') }, // traversal → rejected
  ];
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
  try { rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* */ }
  mkdirSync('data', { recursive: true });
  const raw0 = new Database(DB); applyMigrations(raw0); raw0.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: USER_HEX, systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const uid = 'local-user';
  const post = async (body) => {
    const r = await fetch(`${url}/api/v1/portal/import/obsidian`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let j = null; try { j = await r.json(); } catch { /* */ }
    return { status: r.status, body: j };
  };
  const blobFiles = () => (existsSync(UPLOADS) ? readdirSync(UPLOADS, { recursive: true }).filter((f) => String(f).endsWith('.enc')) : []);

  try {
    const r1 = await post({ files: vaultFiles(), vaultName: 'ImgVault' });
    const s1 = r1.body || {};

    // ── I1: assets land, byte-duplicate shares one blob, traversal rejected ──
    rec('I1 assets imported (2) + byte-dup shares one blob + traversal skipped',
      r1.status === 200 && s1.assets?.imported === 2 && s1.assets?.blobsReused === 1
      && blobFiles().length === 1 && s1.assets?.skipped === 1
      && (s1.errors || []).some((e) => e.error === 'unsafe_path'),
      `imported=${s1.assets?.imported} reused=${s1.assets?.blobsReused} onDisk=${blobFiles().length} skipped=${s1.assets?.skipped}`);

    // ── I2: embeds rewritten in the DOCUMENT; missing target intact ─────────
    const doc = await db.documents.get(uid, 'import/obsidian/ImgVault/notes/idea');
    const content = String(doc?.content || '');
    const urls = [...content.matchAll(/\/api\/v1\/portal\/attachments\/([a-f0-9]{32})\/file/g)].map((m) => m[1]);
    rec('I2 wiki + markdown embeds → attachment URLs; missing left intact + counted',
      urls.length === 2 && content.includes('![[missing.png]]') && !content.includes('![[photo.png]]')
      && s1.refs?.rewritten === 2 && s1.refs?.unresolved === 1,
      `urls=${urls.length} rewritten=${s1.refs?.rewritten} unresolved=${s1.refs?.unresolved}`);

    const raw = new Database(DB, { readonly: true });
    // attachment rows behind those URLs are real + linked to one shared blob
    const rows = urls.map((id) => raw.prepare('SELECT id, local_path, file_type FROM attachments WHERE id = ?').get(id)).filter(Boolean);
    rec('I2b both attachment rows exist, image/png, sharing one local_path',
      rows.length === 2 && rows[0].local_path === rows[1].local_path && rows.every((r) => r.file_type === 'image/png'),
      `rows=${rows.length} shared=${rows[0]?.local_path === rows[1]?.local_path}`);

    // ── I3: the MEMORY copy keeps the original text (no URLs in embeddings) ──
    // SQLCipher collapse (Stage B/C cut 4): messages.content is plaintext-in-cipher →
    // read it directly (no field-decrypt). at-rest = whole-file SQLCipher (verify:at-rest;
    // I4 below proves the marker is absent from the keyed file bytes).
    const mem = raw.prepare("SELECT content FROM messages WHERE id = 'obsidian:ImgVault/notes/idea'").get();
    const memPlain = String(mem?.content || '');
    rec('I3 memory copy unrewritten (keeps ![[photo.png]], no attachment URLs; plaintext-in-cipher)',
      Boolean(memPlain) && memPlain.includes('![[photo.png]]') && !memPlain.includes('/api/v1/portal/attachments/'),
      `hasWiki=${memPlain?.includes('![[photo.png]]')}`);

    // ── I4: encrypted at rest — image bytes + note text nowhere in plaintext ─
    const dbBytes = readFileSync(DB);
    const blobPath = join(UPLOADS, rows[0].local_path);
    const blobBytes = readFileSync(blobPath);
    rec('I4 image bytes + note text encrypted at rest (db + MYCB blob)',
      !dbBytes.includes(IMG_BYTES) && !dbBytes.includes(Buffer.from(NOTE_TEXT))
      && blobBytes.subarray(0, 4).toString('latin1') === 'MYCB' && !blobBytes.includes(IMG_BYTES),
      `magic=${blobBytes.subarray(0, 4).toString('latin1')}`);

    // ── I5: idempotent re-import — deduped, zero new blobs, doc still renders ─
    const before = blobFiles().length;
    const r2 = await post({ files: vaultFiles(), vaultName: 'ImgVault' });
    const s2 = r2.body || {};
    const doc2 = await db.documents.get(uid, 'import/obsidian/ImgVault/notes/idea');
    rec('I5 re-import: assets deduped, no new blobs, embeds still render',
      r2.status === 200 && s2.assets?.deduped === 2 && s2.assets?.imported === 0
      && blobFiles().length === before
      && [...String(doc2?.content || '').matchAll(/attachments\/[a-f0-9]{32}\/file/g)].length === 2,
      `deduped=${s2.assets?.deduped} blobs ${before}→${blobFiles().length}`);

    raw.close();
  } finally {
    await new Promise((r) => srv.server.close(r)); srv.close?.();
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
    try { rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* */ }
  }

  const fails = ledger.filter((p) => !p).length;
  console.log(`\n${ledger.length - fails} passed, ${fails} failed`);
  console.log(fails
    ? 'VERDICT: NO-GO'
    : 'VERDICT: GO — Obsidian images: encrypted assets, rewritten embeds, clean memory copy, idempotent re-import');
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
