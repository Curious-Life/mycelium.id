// Verify INTEGRATION — the whole journey against ONE booted server, to catch
// gaps the per-phase verifies miss: the three /api/v1/portal routers coexisting,
// the SPA + API routing order, and import→timeline→profile→onboarding flowing
// together. Plus adversarial edge cases on the import surface.
//
// SPA checks run only when the canonical portal is built (graceful SKIP in CI,
// which runs `npm ci && npm run verify` without portal:build). The API journey
// runs always (root deps include jszip).
//
//   G1 SPA + API coexist     GET / (SPA shell) · GET /api/v1/tools (JSON)   [build-gated]
//   G2 journey               import Claude zip → onboarding flips → messages → profile → mindscape
//   G3 raw upload unaffected  POST /api/v1/upload (raw) still 200
//   E1 empty/zero export      zip with conversations.json=[] → 400 (no crash)
//   E2 malformed archive      truncated/garbage bytes → 400 safe error
//   E3 incomplete chunks      /upload/complete missing a chunk → 400
//   E4 out-of-order chunks    chunks sent 1-then-0 → still assembles + parses
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.join(HERE, '..', 'portal-app', 'build', '200.html');
const DB = 'data/verify-integration.db';
const KCV = 'data/verify-integration-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const skip = (n) => console.log(`[~] SKIP ${n}`);

async function claudeZip(marker) {
  // Unique uuids per call: messages dedup on `claude-<uuid>`, so reusing ids
  // across fixtures would (correctly) dedup a later import to 0 — give each its own.
  const u = crypto.randomUUID();
  const zip = new JSZip();
  zip.file('conversations.json', JSON.stringify([{
    uuid: u, name: 'Conv', chat_messages: [
      { uuid: `${u}-1`, sender: 'human', text: marker, created_at: '2026-01-01' },
      { uuid: `${u}-2`, sender: 'assistant', text: 'reply', created_at: '2026-01-01' },
    ],
  }]));
  return zip.generateAsync({ type: 'nodebuffer' });
}
async function emptyConvZip() {
  const zip = new JSZip(); zip.file('conversations.json', '[]');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const haveBuild = existsSync(BUILD);
  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: haveBuild ? 'canonical' : 'legacy' });
  const { url } = srv;
  const j = async (p, opts) => { const r = await fetch(`${url}${p}`, opts); let b = null, t = null; try { t = await r.text(); b = JSON.parse(t); } catch {} return { status: r.status, body: b, text: t }; };
  const M = (p) => `/api/v1/portal${p}`;
  const postZip = (p, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf]), 'e.zip'); return fetch(`${url}${M(p)}`, { method: 'POST', body: fd }); };

  try {
    // ── G1 SPA + API coexist (build-gated) ──
    if (haveBuild) {
      const root = await j('/');
      const tools = await j('/api/v1/tools');
      rec('G1. canonical SPA served at / + API routed first',
        root.status === 200 && /_app|svelte-kit/i.test(root.text || '') && tools.status === 200 && tools.body?.ok === true,
        `root=${root.status} tools=${tools.status}`);
    } else { skip('G1. SPA (portal not built)'); }

    // ── G2 the journey ──
    const onbBefore = await j(M('/onboarding/status'));
    const importRes = await (await postZip('/upload', await claudeZip('integration-marker'))).json().catch(() => ({}));
    const onbAfter = await j(M('/onboarding/status'));
    const msgs = await j(M('/messages'));
    const prof = await j(M('/profile'));
    const mind = await j(M('/mindscape'));
    const journeyOk = onbBefore.body?.showWelcome === true
      && importRes.importResult?.type === 'claude' && importRes.importResult?.imported === 2
      && onbAfter.body?.showWelcome === false
      && msgs.body?.messages?.length === 2 && msgs.body.messages.some((m) => m.content === 'integration-marker')
      && prof.body?.profile?.message_count === 2
      && mind.status === 200 && Array.isArray(mind.body?.nodes);
    rec('G2. journey: welcome→import→timeline→profile→mindscape', journeyOk,
      `welcomeBefore=${onbBefore.body?.showWelcome} imported=${importRes.importResult?.imported} welcomeAfter=${onbAfter.body?.showWelcome} msgs=${msgs.body?.messages?.length} profileCount=${prof.body?.profile?.message_count}`);

    // ── G3 raw upload still works alongside the multipart router ──
    const rawUp = await j('/api/v1/upload?filename=x.txt', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('raw bytes') });
    rec('G3. raw /api/v1/upload unaffected by the multipart router', rawUp.status === 200 && rawUp.body?.ok === true, `status=${rawUp.status}`);

    // ── E1 empty conversations.json → 400, no crash ──
    const e1 = await postZip('/upload', await emptyConvZip());
    const e1b = await e1.json().catch(() => ({}));
    rec('E1. empty export ([] conversations) → 400 safe', e1.status === 400 && typeof e1b.error === 'string', `status=${e1.status}`);

    // ── E2 garbage (not a zip) → 400 ──
    const e2 = await postZip('/upload', Buffer.from('garbage-not-a-zip'));
    rec('E2. malformed archive → 400 safe', e2.status === 400);

    // ── E3 incomplete chunks → 400 ──
    {
      const buf = await claudeZip('chunk-marker');
      const fd = new FormData();
      fd.append('chunk', new Blob([buf.subarray(0, 10)])); fd.append('uploadId', 'up_inc1'); fd.append('index', '0'); fd.append('filename', 'e.zip');
      await fetch(`${url}${M('/upload/chunk')}`, { method: 'POST', body: fd });
      const comp = await fetch(`${url}${M('/upload/complete')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: 'up_inc1', totalChunks: 2 }) });
      rec('E3. incomplete upload (missing chunk) → 400', comp.status === 400, `status=${comp.status}`);
    }

    // ── E4 out-of-order chunks still assemble ──
    {
      const buf = await claudeZip('ooo-marker');
      const mid = Math.floor(buf.length / 2);
      const parts = [buf.subarray(0, mid), buf.subarray(mid)];
      const id = 'up_ooo1';
      // send index 1 first, then 0
      for (const i of [1, 0]) {
        const fd = new FormData();
        fd.append('chunk', new Blob([parts[i]])); fd.append('uploadId', id); fd.append('index', String(i)); fd.append('filename', 'e.zip');
        await fetch(`${url}${M('/upload/chunk')}`, { method: 'POST', body: fd });
      }
      const comp = await fetch(`${url}${M('/upload/complete')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: id, totalChunks: 2 }) });
      const cb = await comp.json().catch(() => ({}));
      rec('E4. out-of-order chunks assemble + parse', comp.status === 200 && cb.importResult?.type === 'claude' && cb.importResult?.imported === 2, `status=${comp.status} imported=${cb.importResult?.imported}`);
    }
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — integration: SPA+API coexist, full journey flows, import edge cases handled' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-integration threw:', e); process.exit(1); });
