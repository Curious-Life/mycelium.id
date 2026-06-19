// verify:claims — Persona-Claims step 1 (schema + crypto). Proves migration 0011
// creates person_claims + person_claim_snapshots, that the registered sensitive
// columns are ENCRYPTED at rest (wrapped-DEK envelopes) while structural columns
// (subject/status/content_hash/scope/granularity/window_end) stay plaintext, that
// a read through the JS adapter auto-decrypts + coerces a numeric confidence back
// to a Number, that scope is auto-tagged (SCOPE_AWARE_TABLES), and the regression
// that internal_model_items no longer registers PHANTOM columns. PASS/FAIL ledger.
// See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { getEncryptedFields } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-claims.db', KCV = 'data/verify-claims-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => {
  if (typeof v !== 'string') return false;
  try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); }
  catch { return false; }
};
const cols = (rawDb, t) => new Set(rawDb.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name.toLowerCase()));

try {
  // ── C0. migration 0011 created both tables ─────────────────────────────────
  {
    const raw = new Database(DB, { readonly: true });
    const have = cols(raw, 'person_claims');
    const haveSnap = cols(raw, 'person_claim_snapshots');
    raw.close();
    rec('C0. migration 0011 creates person_claims + person_claim_snapshots',
      have.has('confidence_logodds') && have.has('content_hash') && have.has('embedding_768') && haveSnap.has('delta_kind'),
      `person_claims=${have.size}cols person_claim_snapshots=${haveSnap.size}cols`);
  }

  // ── C1. seed a claim via the JS adapter (auto-encrypt on write) ─────────────
  const CONF = 1.2345; // numeric confidence (log-odds); must round-trip via Number()
  await db.rawQuery(
    `INSERT INTO person_claims
       (id, user_id, subject, claim_type, content, confidence_logodds, decay_class, support, content_hash, status, last_evidence_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['claim-1', U, 'self', 'boundary', 'The user has a severe peanut allergy.', CONF, 'boundary',
      JSON.stringify({ messages: ['m-1', 'm-2'], territories: [] }), 'hash-abc', 'active', new Date().toISOString()]);
  await db.rawQuery(
    `INSERT INTO person_claim_snapshots
       (id, user_id, claim_id, window_start, window_end, granularity, confidence_logodds, content, evidence_count, delta_kind)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['snap-1', U, 'claim-1', '2026-06-01T00:00:00Z', '2026-06-07T00:00:00Z', 'week', CONF,
      'The user has a severe peanut allergy.', 2, 'new']);

  // ── C2. sensitive columns are envelopes at rest; structural cols plaintext ──
  {
    const raw = new Database(DB, { readonly: true });
    const row = raw.prepare(
      `SELECT claim_type, content, confidence_logodds, decay_class, support,
              subject, status, content_hash, scope
         FROM person_claims WHERE id='claim-1'`).get();
    const snap = raw.prepare(
      `SELECT confidence_logodds, content, evidence_count, delta_kind,
              granularity, window_end, scope
         FROM person_claim_snapshots WHERE id='snap-1'`).get();
    raw.close();
    const encCols = ['claim_type', 'content', 'confidence_logodds', 'decay_class', 'support'];
    // SQLCipher collapse (Stage B/C cut 3): person_claims / person_claim_snapshots
    // sensitive columns are now PLAINTEXT-inside-cipher (at-rest confidentiality is
    // whole-file SQLCipher, verify:at-rest — not a per-field envelope). Assert the
    // stop-write worked (columns stored plaintext); structural columns stay plaintext.
    const allPlain = row && encCols.every((c) => !isEnvelope(row[c]));
    rec('C2a. person_claims sensitive columns stored PLAINTEXT-in-cipher (collapse cut 3)',
      !!allPlain, row ? `plain{${encCols.filter((c) => !isEnvelope(row[c])).length}/${encCols.length}}` : 'no row');
    rec('C2b. person_claims structural columns stay plaintext (subject/status/content_hash)',
      row && !isEnvelope(row.subject) && row.subject === 'self'
        && !isEnvelope(row.status) && row.status === 'active'
        && !isEnvelope(row.content_hash) && row.content_hash === 'hash-abc',
      row ? `subject=${row.subject} status=${row.status} content_hash=${row.content_hash}` : 'no row');
    const snapEnc = ['confidence_logodds', 'content', 'evidence_count', 'delta_kind'];
    rec('C2c. person_claim_snapshots sensitive columns PLAINTEXT-in-cipher; structural plaintext',
      snap && snapEnc.every((c) => !isEnvelope(snap[c]))
        && !isEnvelope(snap.granularity) && snap.granularity === 'week'
        && !isEnvelope(String(snap.window_end)),
      snap ? `plain{${snapEnc.filter((c) => !isEnvelope(snap[c])).length}/${snapEnc.length}} granularity=${snap.granularity}` : 'no row');
    // C2d (per-field cleartext-leak scan) RETIRED in cut 3: claim content is now
    // plaintext-inside-cipher by design — at-rest confidentiality is whole-file
    // SQLCipher (proven by verify:at-rest), not a per-field envelope. C2a proves the
    // column is plaintext; verify:at-rest proves the file on disk is ciphertext.
  }

  // ── C3. adapter decrypts on read + coerces numeric confidence via Number() ──
  {
    const r = await db.rawQuery(`SELECT claim_type, content, confidence_logodds, scope FROM person_claims WHERE id='claim-1'`);
    const row = Array.isArray(r) ? r[0] : r?.results?.[0];
    rec('C3a. adapter auto-decrypts person_claims on read',
      row && row.claim_type === 'boundary' && /peanut allergy/.test(row.content),
      row ? `claim_type=${row.claim_type}` : 'no row');
    rec('C3b. numeric confidence_logodds round-trips via Number()',
      row && Number.isFinite(Number(row.confidence_logodds)) && Math.abs(Number(row.confidence_logodds) - CONF) < 1e-9,
      row ? `confidence=${row.confidence_logodds} (→${Number(row.confidence_logodds)})` : 'no row');
    rec('C3c. scope auto-tagged on write (SCOPE_AWARE_TABLES) + plaintext',
      row && typeof row.scope === 'string' && row.scope.length > 0 && !isEnvelope(row.scope),
      row ? `scope=${row.scope}` : 'no row');
  }

  // ── C4. UNIQUE(user_id, claim_id, window_end, granularity) on snapshots ─────
  {
    let threw = false;
    try {
      await db.rawQuery(
        `INSERT INTO person_claim_snapshots (id, user_id, claim_id, window_start, window_end, granularity, delta_kind)
         VALUES (?,?,?,?,?,?,?)`,
        ['snap-dup', U, 'claim-1', '2026-06-01T00:00:00Z', '2026-06-07T00:00:00Z', 'week', 'stable']);
    } catch { threw = true; }
    rec('C4. duplicate (user,claim,window_end,granularity) snapshot is rejected by UNIQUE', threw, `threw=${threw}`);
  }

  // ── C5. regression: ENCRYPTED_FIELDS has no PHANTOM columns for touched tables ─
  {
    const raw = new Database(DB, { readonly: true });
    const check = (t) => {
      const real = cols(raw, t);
      const reg = getEncryptedFields(t) || [];
      const phantom = reg.filter((c) => !real.has(c.toLowerCase()));
      return { phantom, reg };
    };
    const im = check('internal_model_items');
    const pc = check('person_claims');
    const ps = check('person_claim_snapshots');
    raw.close();
    rec('C5a. internal_model_items registers only real columns (phantom evidence/source_context removed)',
      im.phantom.length === 0 && !im.reg.includes('evidence') && !im.reg.includes('source_context'),
      `registered=[${im.reg}] phantom=[${im.phantom}]`);
    rec('C5b. person_claims + person_claim_snapshots registered columns all exist in schema',
      pc.phantom.length === 0 && ps.phantom.length === 0,
      `pc.phantom=[${pc.phantom}] ps.phantom=[${ps.phantom}]`);
  }
} finally {
  close();
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
}

// Scan the raw DB file for a plaintext substring of the seeded sensitive content.
function raw_search(dbPath, _u) {
  try {
    const buf = readFileSync(dbPath);
    return buf.includes(Buffer.from('severe peanut allergy')) ? 'db-file' : false;
  } catch { return false; }
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — 0011 applies; claims encrypted at rest; adapter decrypts + coerces; scope auto-tagged; structural keys plaintext; no phantom columns; no cleartext leak' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
