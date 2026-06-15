// Verify — mycelium-full-export importer (path-based, NDJSON bundle off disk).
// Builds a synthetic decrypted bundle dir + POSTs /portal/import/full-export.
//
//   F1 tables land           db/<table>.ndjson rows imported (messages, people, clustering_points)
//   F2 denied tables skipped  db/audit_log.ndjson NOT imported (DENY)
//   F3 768d → searchable      embeddings/messages.768d → embedding_768 set, nlp_processed=1, decrypts back
//   F4 256d → mindscape       clustering_points.nomic_embedding set + decrypts
//   F5 attachments            db row + encrypted MYCB blob on disk
//   F6 agent mind docs        agents/**/*.md → document; .next/ build-junk skipped
//   F7 encrypted at rest      message marker absent from raw db; decrypts back
//   F8 report doc             imports/full-export-report-* persisted + decrypts
//   F9 idempotent             re-import → 0 new rows
//   F10 bad format            wrong manifest.format → 400
import crypto from 'node:crypto';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

const DB = 'data/verify-fxi.db';
const KCV = 'data/verify-fxi-kcv.json';
const UPLOADS = 'data/verify-fxi-uploads';
process.env.MYCELIUM_UPLOADS_ROOT = UPLOADS;
process.env.MYCELIUM_DISABLE_EMBED = '1';

const { applyMigrations } = await import('../src/db/migrate.js');
const { startRestServer } = await import('../src/server-rest.js');
const { importMasterKey, decrypt } = await import('../src/crypto/crypto-local.js');
const { decryptVector } = await import('../src/search/ann/decode.js');

const hex = () => crypto.randomBytes(32).toString('hex');
const USER_HEX = hex();
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const MARKER = 'full-export-plaintext-marker-xyz';
const ATT_BYTES = Buffer.from('full-export-attachment-binary-marker');
const VEC768 = new Float32Array(768).map((_, i) => Math.fround(Math.cos(i + 1)));
const VEC256 = new Float32Array(256).map((_, i) => Math.fround(Math.sin(i + 1)));

function buildBundle(root, { format = 'mycelium-full-export' } = {}) {
  const pre = join(root, 'mycelium-full-export-2026-06-15');
  mkdirSync(join(pre, 'db'), { recursive: true });
  mkdirSync(join(pre, 'embeddings'), { recursive: true });
  mkdirSync(join(pre, 'attachments', 'att1'), { recursive: true });
  mkdirSync(join(pre, 'agents', 'personal', 'mind'), { recursive: true });
  mkdirSync(join(pre, 'agents', 'personal', 'frontend', '.next', 'server'), { recursive: true });
  writeFileSync(join(pre, 'manifest.json'), JSON.stringify({ format, version: 1, exportedAt: '2026-06-15T08:55:00.000Z', tables: {} }));
  const nd = (p, rows) => writeFileSync(join(pre, p), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  nd('db/messages.ndjson', [
    { id: 'fx_m1', role: 'user', content: MARKER, source: 'telegram', created_at: '2024-02-02T00:00:00.000Z', nlp_processed: 1 },
    { id: 'fx_m2', role: 'assistant', content: 'a reply', source: 'telegram', created_at: '2024-02-02T00:01:00.000Z' },
  ]);
  nd('db/people.ndjson', [{ id: 'fx_p1', name: 'Grace Hopper', email: 'grace@example.com' }]);
  // FK-ordering case: contact_territories (FK contact_id→people) sorts BEFORE
  // 'people' alphabetically, so it's imported first — must still land (FK
  // enforcement deferred during the restore).
  nd('db/contact_territories.ndjson', [{ id: 'fx_ct1', user_id: 'martin', contact_id: 'fx_p1', territory_id: 3, strength: 0.9 }]);
  nd('db/audit_log.ndjson', [{ id: 'fx_audit1', action: 'should_not_import' }]); // DENY
  nd('db/clustering_points.ndjson', [{ id: 'fx_cp1', source_type: 'message', source_id: 'fx_m1', territory_id: 3 }]);
  nd('db/attachments.ndjson', [{ id: 'att1', file_name: 'note.txt', file_type: 'text/plain', file_size: ATT_BYTES.length }]);
  nd('embeddings/messages.768d.ndjson', [{ id: 'fx_m1', dim: 768, vector_b64: Buffer.from(VEC768.buffer).toString('base64') }]);
  nd('embeddings/clustering_points.256d.ndjson', [{ id: 'fx_cp1', dim: 256, vector_hex: Buffer.from(VEC256.buffer).toString('hex') }]);
  writeFileSync(join(pre, 'attachments', 'att1', 'note.txt'), ATT_BYTES);
  writeFileSync(join(pre, 'agents', 'personal', 'mind', 'note.md'), 'agent mind note — continuity');
  writeFileSync(join(pre, 'agents', 'personal', 'frontend', '.next', 'server', 'pages-manifest.json'), '{"junk":true}');
  return root; // POST the parent; resolveRoot finds the wrapper subdir
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
  try { rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* */ }
  mkdirSync('data', { recursive: true });
  new Database(DB).close(); applyMigrations(new Database(DB));
  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: USER_HEX, systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url } = srv; const uid = 'local-user';
  const post = async (dirPath) => { const r = await fetch(`${url}/api/v1/portal/import/full-export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dirPath }) }); let b = null; try { b = await r.json(); } catch { /* */ } return { status: r.status, body: b }; };

  const work = mkdirSync(join(tmpdir(), `fxi-${process.pid}`), { recursive: true }) || join(tmpdir(), `fxi-${process.pid}`);
  try {
    const dir = buildBundle(join(tmpdir(), `fxi-${process.pid}`));
    const r1 = await post(dir);
    rec('F0 import → 200', r1.status === 200 && r1.body?.ok === true, `status=${r1.status} imported=${r1.body?.imported}`);

    const raw = new Database(DB, { readonly: true });
    const cnt = (sql, ...a) => { try { return raw.prepare(sql).get(...a); } catch { return null; } };

    rec('F1 tables land (messages/people/clustering_points)',
      cnt("SELECT COUNT(*) n FROM messages WHERE id IN ('fx_m1','fx_m2')")?.n === 2
      && cnt("SELECT COUNT(*) n FROM people WHERE id='fx_p1'")?.n === 1
      && cnt("SELECT COUNT(*) n FROM clustering_points WHERE id='fx_cp1'")?.n === 1);

    rec('F2 denied table (audit_log) NOT imported', cnt("SELECT COUNT(*) n FROM audit_log WHERE id='fx_audit1'")?.n === 0);

    rec('F1b FK-ordered child lands (contact_territories before people, FK deferred)',
      cnt("SELECT COUNT(*) n FROM contact_territories WHERE id='fx_ct1'")?.n === 1);

    const m1 = cnt("SELECT embedding_768, nlp_processed FROM messages WHERE id='fx_m1'");
    let v768 = null; try { v768 = await decryptVector(String(m1?.embedding_768 || ''), await importMasterKey(USER_HEX), null, 768); } catch { /* */ }
    rec('F3 768d → embedding_768 set, nlp_processed=1, decrypts to original',
      Boolean(m1?.embedding_768) && Number(m1?.nlp_processed) === 1 && v768 && Math.abs(v768[0] - VEC768[0]) < 1e-5 && Math.abs(v768[767] - VEC768[767]) < 1e-5,
      `nlp=${m1?.nlp_processed}`);

    const cp = cnt("SELECT nomic_embedding FROM clustering_points WHERE id='fx_cp1'");
    let v256 = null; try { v256 = await decryptVector(String(cp?.nomic_embedding || ''), await importMasterKey(USER_HEX), null, 256); } catch { /* */ }
    rec('F4 256d → nomic_embedding set + decrypts', v256 && Math.abs(v256[0] - VEC256[0]) < 1e-5);

    const att = cnt("SELECT local_path FROM attachments WHERE id='att1'");
    let blobOk = false;
    if (att?.local_path && existsSync(join(UPLOADS, att.local_path))) { const b = readFileSync(join(UPLOADS, att.local_path)); blobOk = b.subarray(0, 4).toString('latin1') === 'MYCB' && !b.includes(ATT_BYTES); }
    rec('F5 attachment row + encrypted MYCB blob', Boolean(att?.local_path) && blobOk);

    const adoc = cnt("SELECT content FROM documents WHERE path='agents/personal/mind/note.md'");
    const junk = cnt("SELECT COUNT(*) n FROM documents WHERE path LIKE '%.next%'");
    rec('F6 agent mind doc imported; .next build-junk skipped', Boolean(adoc) && junk?.n === 0);

    const dbBytes = readFileSync(DB);
    let mPlain = null; try { mPlain = await decrypt(String(cnt("SELECT content FROM messages WHERE id='fx_m1'")?.content || ''), await importMasterKey(USER_HEX)); } catch { /* */ }
    rec('F7 message encrypted at rest + decrypts to marker', !dbBytes.includes(Buffer.from(MARKER)) && mPlain === MARKER);

    const rep = cnt("SELECT content FROM documents WHERE path LIKE 'imports/full-export-report-%'");
    let repParsed = null; try { repParsed = JSON.parse(await decrypt(String(rep?.content || ''), await importMasterKey(USER_HEX))); } catch { /* */ }
    rec('F8 report doc persisted + decrypts', repParsed?.kind === 'mycelium-full-export' && repParsed?.totals?.imported > 0, `path=${r1.body?.reportPath}`);
    raw.close();

    const before = new Database(DB, { readonly: true }).prepare('SELECT COUNT(*) n FROM messages').get().n;
    const r2 = await post(dir);
    const after = new Database(DB, { readonly: true }).prepare('SELECT COUNT(*) n FROM messages').get().n;
    rec('F9 idempotent re-import (no new rows)', r2.status === 200 && before === after, `rows ${before}→${after}`);

    // F10 bad format
    const badDir = join(tmpdir(), `fxi-bad-${process.pid}`); buildBundle(badDir, { format: 'not-a-full-export' });
    const r3 = await post(badDir);
    rec('F10 wrong manifest format → 400', r3.status === 400, `status=${r3.status}`);
    try { rmSync(badDir, { recursive: true, force: true }); } catch { /* */ }
  } finally {
    await new Promise((r) => srv.server.close(r)); srv.close?.();
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch { /* */ } }
    try { rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(join(tmpdir(), `fxi-${process.pid}`), { recursive: true, force: true }); } catch { /* */ }
  }
  const fails = ledger.filter((p) => !p).length;
  console.log(`\n${ledger.length - fails} passed, ${fails} failed`);
  console.log(fails ? 'VERDICT: NO-GO' : 'VERDICT: GO — mycelium-full-export importer (NDJSON tables, 768d/256d re-encrypt, attachments, agent docs, denied-table skip, encrypted-at-rest, idempotent)');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e?.stack || e); process.exit(1); });
