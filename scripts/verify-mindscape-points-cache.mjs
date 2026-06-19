// scripts/verify-mindscape-points-cache.mjs — the durable points-cache + /points
// endpoint gate (Mindscape progressive load).
//
// The fix: split the Mindscape cache so the EXPENSIVE 3D geometry (getPoints — the
// 70k-row scan, ~234 ms) lives in a DURABLE cache that narrative/chronicle busts
// do NOT drop, and serve it from a new GET /mindscape/points so the frontend paints
// visuals first. Proves, in two parts:
//
//  PART A — cache module semantics (the heart of the fix), unit-level:
//   A1 a 2nd getMindscapePointsCached call is served from cache (compute runs once)
//   A2 bustMindscape (NARRATIVE) does NOT drop the points — they stay warm
//   A3 bustMindscapePoints (POINT change) DOES drop them — next call recomputes
//   A4 the full cache (getMindscapeCached) is dropped by BOTH bust kinds
//
//  PART B — endpoint + parity on a born-ENCRYPTED seeded vault:
//   B1 GET /mindscape/points → { nodes, meta }, nodes count == seeded points
//   B2 GET /mindscape nodes are IDENTICAL to /points nodes (one projection)
//      and the text panels (territories) + point-derived decor (centroids,
//      activity) are present — the split changed no surfaced data
//   B3 §7: the /points payload carries zero content/ciphertext
import Database from 'better-sqlite3';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';
import { portalMindscapeRouter } from '../src/portal-mindscape.js';
import {
  getMindscapeCached, getMindscapePointsCached, bustMindscape, bustMindscapePoints,
} from '../src/mindscape-cache.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? '[✓]' : '[✗]'} ${n}${d ? ` — ${d}` : ''}`); };
const NOW = Date.parse('2026-06-17T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400000;

async function main() {
  console.log('\n=== verify:mindscape-points-cache — durable points cache + /points endpoint ===\n');

  // ── PART A — cache semantics (no DB needed) ────────────────────────────────
  const U = 'owner';
  let pc = 0, fc = 0;
  const pCompute = async () => { pc++; return { nodes: [{ data: { n: pc } }], meta: { total: pc } }; };
  const fCompute = async () => { fc++; return { full: fc }; };

  await getMindscapePointsCached(U, pCompute);
  await getMindscapePointsCached(U, pCompute);
  rec('A1. points cache serves 2nd call from cache (compute once)', pc === 1, `computes=${pc}`);

  bustMindscape(U);                              // NARRATIVE bust
  await getMindscapePointsCached(U, pCompute);
  rec('A2. bustMindscape (narrative) does NOT drop points — geometry stays warm', pc === 1, `computes=${pc}`);

  bustMindscapePoints(U);                        // POINT bust
  await getMindscapePointsCached(U, pCompute);
  rec('A3. bustMindscapePoints (point change) DROPS points — recomputes', pc === 2, `computes=${pc}`);

  await getMindscapeCached(U, fCompute);         // prime full cache
  await getMindscapeCached(U, fCompute);
  rec('A4a. full cache serves 2nd call from cache', fc === 1, `computes=${fc}`);
  bustMindscape(U);
  await getMindscapeCached(U, fCompute);
  rec('A4b. full cache dropped by narrative bust', fc === 2, `computes=${fc}`);
  bustMindscapePoints(U);
  await getMindscapeCached(U, fCompute);
  rec('A4c. full cache also dropped by point bust', fc === 3, `computes=${fc}`);

  // ── PART B — endpoint + parity on an encrypted vault ───────────────────────
  const dir = mkdtempSync(join(tmpdir(), 'myc-mind-points-'));
  const dbPath = join(dir, 'v.db');
  const dbKeyHex = crypto.randomBytes(32).toString('hex');
  const born = new Database(dbPath);
  born.pragma(`cipher='sqlcipher'`); born.pragma(`key="x'${dbKeyHex}'"`);
  applyMigrations(born); born.close();
  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath, userKey, systemKey, dbKeyHex });
  const W = 'owner';
  const q = (sql, params = []) => db._base.d1Query(sql, params);

  try {
    await q(`INSERT INTO users (id, display_name, type) VALUES ('owner', 'Owner', 'human')`);
    const NPTS = 400;
    for (let i = 0; i < NPTS; i++) {
      const terr = i % 5, realm = terr % 2;
      await q(`INSERT INTO clustering_points
        (id, user_id, source_id, territory_id, theme_id, realm_id, landscape_x, landscape_y, landscape_z, source_type, created_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'message', ?)`,
        [`p${i}`, W, `s${i}`, terr, i % 10, realm, (i % 50) / 5, (i % 33) / 3, (i % 20) / 2, iso(NOW - (i % 60) * DAY)]);
    }
    // Encrypted territory text — must come back as decrypted strings in /mindscape.
    for (let t = 0; t < 5; t++) {
      await q(`INSERT INTO territory_profiles (id, user_id, territory_id, realm_id, name, essence, message_count, current_phase, is_anchored)
               VALUES (?,?,?,?,?,?,?, 'active', 0)`,
        [`tp${t}`, W, t, t % 2, `Territory ${t}`, `secret essence ${t}`, 80]);
    }

    bustMindscapePoints(W); // start cold for this user
    const app = express();
    app.use('/api/v1/portal', portalMindscapeRouter({ db, userId: W, dbPath }));
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const get = async (p) => (await fetch(`http://127.0.0.1:${port}/api/v1/portal${p}`)).json();

    const pts = await get('/mindscape/points');
    rec('B1. GET /mindscape/points → { nodes, meta } with all points',
      Array.isArray(pts.nodes) && pts.nodes.length === NPTS && pts.meta?.total === NPTS,
      `nodes=${pts.nodes?.length} total=${pts.meta?.total}`);

    const full = await get('/mindscape');
    const nodesMatch = JSON.stringify(full.nodes) === JSON.stringify(pts.nodes);
    const terr0 = full.territories?.['0'];
    const decorOk = terr0 && terr0.essence === 'secret essence 0' && terr0.centroid && Array.isArray(terr0.activity);
    rec('B2. /mindscape nodes IDENTICAL to /points; text + point-derived decor present',
      nodesMatch && decorOk && full.meta?.total === NPTS,
      `nodesMatch=${nodesMatch} essence="${terr0?.essence}" centroid=${!!terr0?.centroid}`);

    const pjson = JSON.stringify(pts);
    rec('B3. §7 — /points payload has no content/ciphertext',
      !/"(content|essence|title|ct|iv|wrappedDek|embedding)"/.test(pjson) && !pjson.includes('secret essence'));

    server.close();
  } finally {
    close?.();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — points cache durable across narrative busts; /points serves geometry; full parity preserved' : 'NO-GO — see [✗] rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error('FAIL harness error:', e?.stack || e); process.exit(1); });
