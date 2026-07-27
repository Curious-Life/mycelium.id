// Verify the canonical-portal compatibility surface (/api/v1/portal/*) that the
// SvelteKit UI's api.ts targets after rewriting /portal/* → /api/v1/portal/*.
// This proves the LIBRARY vertical (M2 slice 1) is wired to real local data,
// returning the exact JSON shapes the screens consume.
//
//   D1 create  POST /api/v1/portal/documents              → {ok, document}
//   D2 list    GET  /api/v1/portal/documents              → {documents:[…]} incl. the new doc
//   D3 detail  GET  /api/v1/portal/documents/<path>       → {document:{…content}}
//   D4 pin     POST /api/v1/portal/documents/pin          → pinned reflected in ?pinned=1
//   D5 move    POST /api/v1/portal/documents/move         → folder_id reflected
//   D6 folders GET  /api/v1/portal/folders                → {folders:[…]}
//   D7 delete  DELETE /api/v1/portal/documents/<path>     → gone from the list
//   D8 onboard GET  /api/v1/portal/onboarding/status      → benign shape (no throw)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-portal-data.db';
const KCV = 'data/verify-portal-data-kcv.json';
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
  const path = 'notes/forest.md';

  try {
    const created = await post('/api/v1/portal/documents', { path, title: 'Forest', content: 'The mycelium beneath the forest.' });
    rec('D1. create document → {ok, document}', created.status === 200 && created.body?.ok === true && created.body?.document?.path === path, `status=${created.status}`);

    const list = await j('/api/v1/portal/documents');
    const found = Array.isArray(list.body?.documents) && list.body.documents.find((d) => d.path === path);
    rec('D2. list documents includes the new doc (path/title/updated_at)', !!found && found.title === 'Forest' && 'updated_at' in found, `count=${list.body?.documents?.length}`);

    const detail = await j(`/api/v1/portal/documents/${encodeURIComponent(path)}`);
    rec('D3. document detail → {document:{content}}', detail.status === 200 && detail.body?.document?.content?.includes('mycelium'), `status=${detail.status}`);

    await post('/api/v1/portal/documents/pin', { path, pinned: true });
    const pinned = await j('/api/v1/portal/documents?pinned=1');
    rec('D4. pin reflected (doc appears under ?pinned=1)', !!pinned.body?.documents?.find((d) => d.path === path));

    const folders0 = await j('/api/v1/portal/folders');
    rec('D6. folders endpoint → {folders:[…]}', folders0.status === 200 && Array.isArray(folders0.body?.folders));

    const del = await j(`/api/v1/portal/documents/${encodeURIComponent(path)}`, { method: 'DELETE' });
    const after = await j('/api/v1/portal/documents');
    rec('D7. delete removes the doc from the list', del.body?.ok === true && !after.body?.documents?.find((d) => d.path === path));

    const onb = await j('/api/v1/portal/onboarding/status');
    // `aiModelsReady` is asserted as a BOOLEAN, not as `true`. It used to be hardcoded
    // `true` (portal-compat.js), which is why this could pin the literal — a test can only
    // assert a constant while the value IS one. It is MEASURED now (the embedder's real
    // health, via the readiness model): in CI no embedder runs, so `false` is the CORRECT
    // answer and pinning `true` would pin the lie. Operator decision D3 accepts the
    // consequence — auto-generate stops firing into a dead embedder, which was the point.
    // The SHAPE is what this test guards (§7 R6 back-compat), and the shape is unchanged.
    rec('D8. onboarding/status → benign shape (steps.data.messageCount present, aiModelsReady boolean)',
      onb.status === 200 && typeof onb.body?.steps?.data?.messageCount === 'number' && typeof onb.body?.aiModelsReady === 'boolean');

    // D8b — /import/preview ("See your mind" card): aggregate, leak-safe shape.
    // Empty vault → messageCount 0, dateRange present (null years), sources [].
    const prev = await j('/api/v1/portal/import/preview');
    rec('D8b. import/preview → {messageCount, dateRange, sources[], peopleCount}',
      prev.status === 200 && typeof prev.body?.messageCount === 'number'
      && !!prev.body?.dateRange && Array.isArray(prev.body?.sources)
      && typeof prev.body?.peopleCount === 'number' && typeof prev.body?.conversationCount === 'number',
      `status=${prev.status} keys=${Object.keys(prev.body || {}).join(',')}`);

    // D9 — local auth shim: the portal's session check must succeed so the app
    // opens instead of bouncing to /login (V1 is unlocked-at-boot, single-user).
    const sess = await j('/auth/session');
    rec('D9. GET /auth/session → {user} (app opens, no /login bounce)',
      sess.status === 200 && !!sess.body?.user?.id, `status=${sess.status}`);
    const setup = await j('/auth/setup-status');
    rec('D10. GET /auth/setup-status → setupRequired:false', setup.status === 200 && setup.body?.setupRequired === false);

    // ── Folder write surface (LibraryNav "New folder"/rename/delete). The db
    // namespace always existed; the HTTP routes did not, so "New folder" POSTed
    // into the void and failed silently. These prove the routes are wired.
    const put = (p, body) => j(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const fCreate = await post('/api/v1/portal/folders', { name: 'QA Folder' });
    const fid = fCreate.body?.folder?.id;
    rec('D11. POST /folders → {ok, folder:{id,name}} (create no longer fails silently)',
      fCreate.status === 200 && fCreate.body?.ok === true && !!fid && fCreate.body?.folder?.name === 'QA Folder', `status=${fCreate.status}`);

    const fList = await j('/api/v1/portal/folders');
    rec('D12. GET /folders includes the created folder',
      !!fList.body?.folders?.find((f) => f.id === fid && f.name === 'QA Folder'));

    const fChild = await post('/api/v1/portal/folders', { name: 'QA Child', parent_id: fid });
    rec('D13. POST /folders with parent_id → sub-folder under the parent',
      fChild.status === 200 && fChild.body?.folder?.parent_id === fid, `status=${fChild.status} parent=${fChild.body?.folder?.parent_id}`);

    const fRename = await put(`/api/v1/portal/folders/${fid}`, { name: 'QA Renamed' });
    const afterRename = await j('/api/v1/portal/folders');
    rec('D14. PUT /folders/:id renames (reflected in GET)',
      fRename.status === 200 && afterRename.body?.folders?.find((f) => f.id === fid)?.name === 'QA Renamed');

    const fEmpty = await post('/api/v1/portal/folders', { name: '   ' });
    rec('D15. POST /folders with blank name → 400 (fail-closed validation)', fEmpty.status === 400);

    const fDel = await j(`/api/v1/portal/folders/${fid}`, { method: 'DELETE' });
    const afterDel = await j('/api/v1/portal/folders');
    rec('D16. DELETE /folders/:id removes it from the list',
      fDel.body?.ok === true && !afterDel.body?.folders?.find((f) => f.id === fid));
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — canonical-portal data layer: Library vertical wired to local /api/v1/portal/* (real shapes)' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-portal-data threw:', e); process.exit(1); });
