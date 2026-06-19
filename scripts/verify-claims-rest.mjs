// verify:claims-rest — proves the Persona-Claims portal bridge surfaces claims +
// their confidence trajectory to the HUMAN over HTTP without leaking ciphertext.
// Seeds a vault with crypto.randomBytes keys (NEVER a real keychain), writes
// claims + snapshots THROUGH the booted encrypting adapter, starts the REST
// server, then asserts /claims/current + /claims/series return 200 with real
// values, an UNAUTH (forwarded) request is rejected (fail-closed), and NO
// response body leaks a wrapped-DEK envelope. PASS/FAIL ledger; exit 0 iff all pass.
import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { fromConfidence } from '../src/claims/confidence.js';

const DB = 'data/verify-claims-rest.db', KCV = 'data/verify-claims-rest-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

function looksLikeCiphertext(s) {
  if (typeof s !== 'string' || s.length < 24) return false;
  if (/"ct"\s*:/.test(s) && /"dk"\s*:/.test(s) && /"iv"\s*:/.test(s)) return true;
  for (const tok of s.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || []) {
    try {
      const dec = Buffer.from(tok, 'base64').toString('utf8');
      if (dec.startsWith('{') && /"v"\s*:/.test(dec) && /"ct"\s*:/.test(dec) && /"dk"\s*:/.test(dec)) return true;
    } catch { /* not base64 */ }
  }
  return false;
}

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const U = 'local-user';
  const P = (p) => `/api/v1/portal${p}`;
  const bodies = [];
  const j = async (p, opts = {}) => {
    const r = await fetch(`${url}${p}`, opts);
    const text = await r.text();
    bodies.push({ p, text });
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };

  try {
    // Seed a claim + two weekly snapshots through the encrypting adapter.
    await db.claims.upsert({
      id: 'pc1', userId: U, claimType: 'boundary', content: 'The user has a severe peanut allergy.',
      confidenceLogodds: fromConfidence(0.8), decayClass: 'boundary',
      support: { messages: ['m1', 'm2'], territories: [] }, contentHash: 'h1',
      status: 'active', lastEvidenceAt: '2026-06-05T00:00:00Z',
    });
    for (const [end, conf, delta] of [['2026-05-31T00:00:00Z', 0.6, 'new'], ['2026-06-07T00:00:00Z', 0.8, 'strengthened']]) {
      await db.claims.writeSnapshot({ userId: U, claimId: 'pc1', windowStart: '2026-05-25T00:00:00Z',
        windowEnd: end, granularity: 'week', confidenceLogodds: fromConfidence(conf),
        content: 'The user has a severe peanut allergy.', evidenceCount: 2, deltaKind: delta });
    }

    // C1. /claims/current returns the claim, decrypted, with a confidence.
    const cur = await j(P('/claims/current'));
    const c0 = cur.body?.claims?.[0];
    rec('C1. GET /claims/current returns the claim decrypted with confidence',
      cur.status === 200 && c0 && /peanut allergy/.test(c0.content) && c0.claim_type === 'boundary'
        && typeof c0.confidence === 'number' && Math.abs(c0.confidence - 0.8) < 0.02 && c0.support_count === 2,
      c0 ? `type=${c0.claim_type} conf=${c0.confidence?.toFixed?.(3)} support=${c0.support_count}` : `status=${cur.status}`);

    // C2. /claims/series returns the weekly trajectory ASC with deltas.
    const ser = await j(P('/claims/series?claim_id=pc1&granularity=week'));
    const s = ser.body?.series || [];
    rec('C2. GET /claims/series returns the ASC weekly trajectory with deltas',
      ser.status === 200 && s.length === 2 && s[0].window_end < s[1].window_end
        && s[1].delta_kind === 'strengthened' && Math.abs(s[1].confidence - 0.8) < 0.02,
      `n=${s.length} last=${s[s.length - 1]?.delta_kind} conf=${s[s.length - 1]?.confidence?.toFixed?.(3)}`);

    // C3. validation: bad granularity → 400; unknown claim → 404.
    const bad = await j(P('/claims/series?claim_id=pc1&granularity=fortnight'));
    const missing = await j(P('/claims/series?claim_id=nope&granularity=week'));
    rec('C3. invalid granularity → 400, unknown claim → 404',
      bad.status === 400 && missing.status === 404, `bad=${bad.status} missing=${missing.status}`);

    // C4. fail-closed: a forwarded (non-loopback) request is rejected.
    const unauth = await j(P('/claims/current'), { headers: { 'x-forwarded-for': '8.8.8.8' } });
    rec('C4. forwarded request rejected (401, fail-closed)', unauth.status === 401, `status=${unauth.status}`);

    // C5. NO response body leaks a wrapped-DEK envelope.
    const leak = bodies.find((b) => looksLikeCiphertext(b.text));
    rec('C5. no response body leaks ciphertext (wrapped-DEK envelope)', !leak, leak ? `LEAK at ${leak.p}` : 'clean');
  } finally {
    try { await srv.close?.(); } catch {}
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  }

  const allPass = ledger.every(Boolean);
  console.log('\n' + '='.repeat(64));
  console.log(`VERDICT: ${allPass ? 'GO — claims portal bridge surfaces claims + trajectory; fail-closed; no ciphertext leak' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(64));
  process.exit(allPass ? 0 : 1);
}
main();
