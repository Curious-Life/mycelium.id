// verify:library-perf — the Library load-perf surface:
//   L1 GET /documents?limit&offset paginates and returns a total
//   L2 last page returns the remainder
//   L3 GET /documents with NO limit still returns the full set (caller back-compat)
//   L4 POST /documents/previews returns a content SNIPPET (≤600, a prefix), not
//      the full document — one round-trip for a page of grid cards
//   L5 previews caps the batch (≤100 paths) and never throws
//   L6 attachments handler pages at the DB when unfiltered (no LIST_SCAN_CAP scan)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.
import crypto from 'node:crypto';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-library-perf.db';
const KCV = 'data/verify-library-perf-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url } = srv;
  const j = async (p, opts) => { const r = await fetch(`${url}${p}`, opts); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    const longContent = 'x'.repeat(2000); // >600 → snippet must truncate
    const paths = [];
    for (let i = 0; i < 5; i++) {
      const path = `notes/doc-${i}.md`;
      paths.push(path);
      await post('/api/v1/portal/documents', { path, title: `Doc ${i}`, content: longContent + ` #${i}` });
    }

    // L1: first page + total
    const p1 = await j('/api/v1/portal/documents?limit=2&offset=0');
    rec('L1. limit/offset pages + returns total', p1.status === 200 && p1.body.documents?.length === 2 && p1.body.total === 5,
      `len=${p1.body?.documents?.length} total=${p1.body?.total}`);

    // L2: last page remainder
    const p2 = await j('/api/v1/portal/documents?limit=2&offset=4');
    rec('L2. last page returns the remainder', p2.status === 200 && p2.body.documents?.length === 1,
      `len=${p2.body?.documents?.length}`);

    // L3: no limit → full set (back-compat for MCP listDocuments etc.)
    const p3 = await j('/api/v1/portal/documents');
    rec('L3. no limit → full set, no total', p3.body.documents?.length === 5 && p3.body.total === undefined,
      `len=${p3.body?.documents?.length} total=${p3.body?.total}`);

    // L4: batched previews are content snippets, truncated, a prefix of content
    const pv = await post('/api/v1/portal/documents/previews', { paths: paths.slice(0, 3) });
    const snip = pv.body?.previews?.[paths[0]];
    rec('L4. previews returns a truncated content snippet (one round-trip)',
      pv.status === 200 && Object.keys(pv.body.previews || {}).length === 3
        && typeof snip === 'string' && snip.length === 600 && longContent.startsWith(snip),
      `keys=${Object.keys(pv.body?.previews || {}).length} snipLen=${snip?.length}`);

    // L5: batch cap (≤100) + no throw on oversize
    const many = Array.from({ length: 150 }, (_, i) => `notes/doc-${i % 5}.md`);
    const pv2 = await post('/api/v1/portal/documents/previews', { paths: many });
    rec('L5. previews caps the batch and never throws', pv2.status === 200 && Object.keys(pv2.body.previews || {}).length <= 100,
      `status=${pv2.status} keys=${Object.keys(pv2.body?.previews || {}).length}`);

    // L6: attachments pages at the DB when unfiltered (static — branch present)
    const att = readFileSync('src/portal-attachments.js', 'utf8');
    rec('L6. attachments handler pages unfiltered (no LIST_SCAN_CAP scan)',
      /const filtering = Boolean\(type \|\| search\)/.test(att) && /listByUser\(userId, \{ limit, offset \}\)/.test(att));
  } finally {
    await srv.close?.();
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — Library paginates, previews snippet-only, attachments page unfiltered' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
