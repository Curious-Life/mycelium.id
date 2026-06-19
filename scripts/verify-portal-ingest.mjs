// scripts/verify-portal-ingest.mjs — owner push-ingestion (Apple data → stream).
//
// POST /api/v1/portal/ingest runs each event through captureMessage (the one
// ingestion boundary), so Apple data lands in the stream like every other source.
// Asserts (networked simulated via X-Forwarded-For, same as the other gates):
//   A. networked + valid Bearer + events → captured
//   B. re-send identical events → deduped (idempotent re-sync)
//   C. networked + no Bearer → 401 (owner-gated, fail-closed)
//   D. loopback → captured (desktop unaffected)
//   E. missing events[] → 400
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); } else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); } };

const STATIC_BEARER = crypto.randomBytes(24).toString('hex');
process.env.MYCELIUM_DISABLE_EMBED = '1';
process.env.MYCELIUM_MCP_BEARER = STATIC_BEARER;
const DATA = mkdtempSync(join(tmpdir(), 'myc-ingest-'));
const hex = () => crypto.randomBytes(32).toString('hex');
const NET = '9.9.9.9';
const PATH = '/api/v1/portal/ingest';

let server = null;
try {
  const { startRestServer } = await import('../src/server-rest.js');
  server = await startRestServer({ dbPath: join(DATA, 'd.db'), kcvPath: join(DATA, 'd.kcv'), userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const base = server.url;
  const post = (body, { xff = null, bearer = null } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (xff) headers['x-forwarded-for'] = xff;
    if (bearer) headers['authorization'] = `Bearer ${bearer}`;
    return fetch(`${base}${PATH}`, { method: 'POST', headers, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  };

  const events = [
    { source: 'apple-health', content: 'Sleep 7h12m · HRV 58ms · steps 8,431 · resting HR 54', createdAt: '2026-06-15T08:00:00Z', id: 'apple-health:2026-06-15' },
    { source: 'apple-health', content: 'Sleep 6h40m · HRV 49ms · steps 11,002 · resting HR 56', createdAt: '2026-06-16T08:00:00Z', id: 'apple-health:2026-06-16' },
  ];

  // C. networked, no bearer → 401
  const c = await post({ events }, { xff: NET });
  ok(c.status === 401, 'C. networked, no Bearer → 401', `(${c.status})`);

  // A. networked + bearer → captured 2
  const a = await post({ events }, { xff: NET, bearer: STATIC_BEARER });
  ok(a.status === 200 && a.body.captured === 2, 'A. networked + Bearer → captured 2', JSON.stringify(a.body));

  // B. re-send identical → deduped (idempotent)
  const b = await post({ events }, { xff: NET, bearer: STATIC_BEARER });
  ok(b.status === 200 && b.body.deduped === 2 && b.body.captured === 0, 'B. re-send → deduped 2 (idempotent)', JSON.stringify(b.body));

  // D. loopback → captured
  const d = await post({ events: [{ source: 'apple-calendar', content: 'Lunch with Sam — 12:30, Cafe', id: 'apple-cal:evt1' }] }, { bearer: STATIC_BEARER });
  ok(d.status === 200 && d.body.captured === 1, 'D. loopback + Bearer → captured 1', JSON.stringify(d.body));

  // E. missing events[] → 400
  const e = await post({ nope: true }, { xff: NET, bearer: STATIC_BEARER });
  ok(e.status === 400, 'E. missing events[] → 400', `(${e.status})`);
} catch (err) {
  ok(false, `boot/integration failed: ${String(err?.message || err).slice(0, 200)}`);
} finally {
  try { await server?.close?.(); } catch { /* */ }
  rmSync(DATA, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO'); process.exit(0);
