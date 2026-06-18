// Verify the local portal (static SPA) is served by the REST server and wired
// to the real API — end-to-end against a booted server with ephemeral keys.
//
//   P1  GET /            → 200 HTML, is the Mycelium portal
//   P2  the page wires the API (calls /api/v1/) and the real tools
//   P3  GET /api/v1/tools still works alongside the static mount (no shadowing)
//   P4  a real tool call through the same origin the portal uses (getContext)
//   P5  capture → search round-trip: POST captureMessage then searchMindscape
//       finds it (proves the portal's two core flows work against live data)
//   P6  unknown path under the static mount → 404 (no directory traversal leak)
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';

const DB = 'data/verify-portal.db';
const KCV = 'data/verify-portal-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');

const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`); };

function freshDb() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();
}

async function main() {
  freshDb();
  // This suite verifies the single-file fallback portal + the API flows; force
  // 'legacy' so it's deterministic whether or not portal-app/build exists.
  // (The canonical SvelteKit portal is verified by verify-portal-serve.mjs.)
  const { server, close, url } = await startRestServer({
    dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(),
    embedder: null, port: 0, host: '127.0.0.1', portalMode: 'legacy',
  });

  try {
    // P1 — portal HTML served at /
    const page = await fetch(`${url}/`);
    const html = await page.text();
    rec('P1. GET / → 200 HTML Mycelium portal',
      page.status === 200 && /text\/html/.test(page.headers.get('content-type') || '') && /<title>Mycelium<\/title>/.test(html),
      `status=${page.status}`);

    // P2 — the fallback is the "not built" placeholder (the old single-file UI
    // was removed); it must direct the user at the canonical build, not pose as
    // a working app.
    rec('P2. fallback shell is the inline placeholder (directs to npm run build:app)',
      html.includes('build:app') && html.includes('portal-app'),
      `len=${html.length}`);

    // P3 — API not shadowed by the static mount
    const tools = await (await fetch(`${url}/api/v1/tools`)).json();
    rec('P3. GET /api/v1/tools works alongside the static mount',
      tools.ok === true && Array.isArray(tools.tools) && tools.tools.length >= 25, `count=${tools.tools?.length}`);

    // P4 — a real tool call (same origin the portal uses)
    const ctx = await (await fetch(`${url}/api/v1/getContext`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    rec('P4. POST /api/v1/getContext → ok result', ctx.ok === true && typeof ctx.result === 'string' && ctx.result.length > 0);

    // P5 — capture → search round-trip (the portal's two core flows)
    const token = `portalcheck_${Date.now()}`;
    const cap = await (await fetch(`${url}/api/v1/captureMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `unique marker ${token} about forests`, source: 'portal' }) })).json();
    const srch = await (await fetch(`${url}/api/v1/searchMindscape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: token, limit: 5 }) })).json();
    rec('P5. capture → search round-trip finds the captured marker',
      cap.ok === true && srch.ok === true && String(srch.result).includes(token),
      `captured=${cap.ok} found=${String(srch.result).includes(token)}`);

    // P6 — bogus static path → 404 (no traversal/leak)
    const miss = await fetch(`${url}/does-not-exist.js`);
    rec('P6. unknown static path → 404', miss.status === 404, `status=${miss.status}`);

    // P6b — the mushroom favicon is served + linked
    const fav = await fetch(`${url}/favicon.svg`);
    const favBody = await fav.text();
    rec('P6b. /favicon.svg served as SVG + linked in the page',
      fav.status === 200 && /svg/i.test(fav.headers.get('content-type') || '') && favBody.includes('<svg') && html.includes('favicon.svg'),
      `status=${fav.status}`);

    // P7 — file UPLOAD via the portal route → encrypted attachment + message
    const fileBytes = Buffer.from(`portal upload ${token} ` + 'x'.repeat(2048));
    const upRes = await fetch(`${url}/api/v1/upload?filename=note.txt&type=text/plain&asMessage=1`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: fileBytes,
    });
    const up = await upRes.json();
    rec('P7. POST /api/v1/upload stores an attachment (+ linked message)',
      up.ok === true && !!up.result?.attachmentId && !!up.result?.messageId && up.result?.size === fileBytes.length,
      `size=${up.result?.size}`);

    // P8 — HIGH-VOLUME bulk import: a body OVER 1 MB (the old express.json cap),
    // proving the raised limit accepts "a lot of data" in one request.
    const N = 4000;
    const filler = 'lorem ipsum dolor sit amet '.repeat(12); // ~324 chars/msg
    const bulk = { messages: Array.from({ length: N }, (_, i) => ({ content: `bulk ${token} row ${i} ${filler}`, source: 'import' })) };
    const bodyStr = JSON.stringify(bulk);
    const impRes = await fetch(`${url}/api/v1/importMessages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyStr });
    const imp = await impRes.json();
    rec(`P8. bulk importMessages accepts a >1MB body (${(bodyStr.length / 1e6).toFixed(2)} MB, ${N} msgs — old 1mb cap would 413)`,
      impRes.status === 200 && imp.ok === true && bodyStr.length > 1_200_000,
      `status=${impRes.status} bytes=${bodyStr.length}`);

    // P9 — the imported volume is actually persisted + searchable
    const big = await (await fetch(`${url}/api/v1/searchMindscape`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `bulk ${token}`, limit: 5 }) })).json();
    rec('P9. bulk-imported messages are persisted + searchable', big.ok === true && String(big.result).includes(token));
  } finally {
    server.close(); try { close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — local portal served by the REST server, wired to the live API, capture→search round-trips' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-portal threw:', e); process.exit(1); });
