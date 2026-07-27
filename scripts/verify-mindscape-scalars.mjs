// verify:mindscape-scalars — REGRESSION GUARD for the SEC-3 "decrypted scalar →
// .toFixed() crash" bug (found 2026-06-05 on a real vault). territory_profiles'
// current_vitality / coherence / energy were ENCRYPTED at rest (SEC-3) and decrypt
// to STRINGS; the mindscape territories/territory/explore/time formatters called
// .toFixed() on them directly, throwing "toFixed is not a function" — but ONLY
// once a real encrypted vitality exists, which the empty-vault verify:mindscape
// never seeded. This gate seeds territory_profiles rows WITH encrypted scalars and
// asserts all four views render (no throw) and surface a numeric vitality.
//
// Post SQLCipher-collapse (2026-06-19) NEW writes store these as plain REALs, but
// the guard still bites: a pre-collapse vault carries envelope rows until the
// `content.territory_profiles_scalars` backfill runs, and the read path decrypts
// them opportunistically → STRING → formatter. The seed therefore writes the
// envelope directly (see the seed block) rather than relying on the adapter.
//
// PRE-FIX: territories/territory/explore/time throw → FAIL. POST-FIX (vf() coerce
// in src/tools/topology-tools.js): all render → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { encrypt, getMasterKey } from '../src/crypto/crypto-local.js';

const DB = 'data/verify-mindscape-scalars.db', KCV = 'data/verify-mindscape-scalars-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, handlers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const isEnvelope = (v) => { if (typeof v !== 'string') return false; try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); } catch { return false; } };
const centroid = (seed) => JSON.stringify(new Array(256).fill(0).map((_, i) => Math.sin((i + 1) * (seed + 1) * 0.013)));

// Open the Tier-2 gate (clustering_points.total > 0).
await db.rawQuery(
  `INSERT INTO clustering_points (id, user_id, source_type, source_id, content, territory_id, landscape_x, landscape_y) VALUES (?,?,?,?,?,?,?,?)`,
  ['cp1', U, 'message', 'seed', 'x', 1, 0.1, 0.2]);

// Seed two territories WITH the SEC-3 scalars (current_vitality / coherence /
// energy → encrypted by the adapter on write; current_phase stays a plaintext
// enum). centroid_256 lets the explore/gaps path resolve neighbors.
const TERRS = [
  { tid: 1, realm: 10, theme: 100, mc: 49, vit: 0.61, phase: 'active', coh: 0.8, en: 0.37 },
  { tid: 2, realm: 11, theme: 101, mc: 28, vit: 0.25, phase: 'sparse', coh: 0.4, en: 0.05 },
];
for (const t of TERRS) {
  await db.rawQuery(
    `INSERT INTO territory_profiles
       (id, user_id, territory_id, realm_id, semantic_theme_id, name, message_count,
        current_vitality, current_phase, coherence, energy, centroid_256, is_catchall, dissolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,NULL)`,
    [`tp-${t.tid}`, U, t.tid, t.realm, t.theme, `Territory ${t.tid}`, t.mc,
      t.vit, t.phase, t.coh, t.en, centroid(t.tid)]);
}
await db.rawQuery(
  `INSERT INTO territory_cofire (id, user_id, territory_a, territory_b, cofire_immediate, cofire_session, cofire_daily, cofire_weekly) VALUES (?,?,?,?,?,?,?,?)`,
  [`${U}:1:2`, U, 1, 2, 0.5, 0.6, 1.2, 0.9]);

// Re-assert the LEGACY at-rest shape. Until the SQLCipher collapse (2026-06-19)
// the adapter encrypted these scalars on write, and this gate leaned on that. Post
// collapse ENCRYPTED_FIELDS.territory_profiles is [] (only `secrets` is still
// field-encrypted), so the adapter stores them as plain REALs and the seed above
// no longer reproduces anything — S1–S4 would pass vacuously on plain numbers.
//
// The crash path is NOT gone: a pre-collapse vault still holds envelope rows until
// the `content.territory_profiles_scalars` backfill (src/portal-mindscape.js:69)
// runs, and autoDecryptResults() decrypts opportunistically on isEncrypted() —
// NOT off ENCRYPTED_FIELDS — so those rows still decrypt to STRINGS on read and
// still reach the formatters. vf() remains the only thing between an un-backfilled
// vault and "toFixed is not a function". So seed the envelope DIRECTLY, exactly as
// a legacy vault carries it, instead of relying on an adapter that no longer does.
{
  const masterKey = await getMasterKey();
  // userId MUST be null — that is what the real writer passed (src/adapter/d1.js:85:
  // `autoEncryptParams(sql, params, scope, userKey, null, …)`), and a non-null userId
  // would derive a per-user key and stamp a v2 envelope (crypto-local.js:1136-1138).
  // A legacy vault holds v1, so seeding v2 would reproduce a shape no writer ever
  // wrote — the gate must mirror production, not merely resemble it.
  for (const t of TERRS) {
    const [vit, coh, en] = await Promise.all([
      encrypt(String(t.vit), 'personal', masterKey, null),
      encrypt(String(t.coh), 'personal', masterKey, null),
      encrypt(String(t.en), 'personal', masterKey, null),
    ]);
    // Raw better-sqlite3 write: post-collapse the adapter would store these verbatim
    // anyway, and we need the envelope to land exactly as the legacy writer left it.
    const w = new Database(DB);
    w.prepare(`UPDATE territory_profiles SET current_vitality=?, coherence=?, energy=? WHERE user_id=? AND territory_id=?`)
      .run(vit, coh, en, U, t.tid);
    w.close();
  }
}

// Bug-condition guard: the seed MUST have stored current_vitality as ciphertext,
// else this test isn't reproducing the crash path.
const raw = new Database(DB, { readonly: true });
const rawProf = raw.prepare(`SELECT current_vitality, coherence, energy, current_phase FROM territory_profiles WHERE user_id=? AND territory_id=1`).get(U);
raw.close();
rec('S0. seed stored current_vitality/coherence/energy as envelopes (SEC-3 bug condition reproduced)',
  rawProf && isEnvelope(rawProf.current_vitality) && isEnvelope(rawProf.coherence) && isEnvelope(rawProf.energy) && !isEnvelope(rawProf.current_phase),
  rawProf ? `vit_enc=${isEnvelope(rawProf.current_vitality)} coh_enc=${isEnvelope(rawProf.coherence)} en_enc=${isEnvelope(rawProf.energy)} phase=${rawProf.current_phase}` : 'no profile');

// The four views that crashed. Each must (a) not throw, (b) return non-empty text,
// (c) render a numeric vitality digit (proves the decrypted string was coerced,
// not passed raw to .toFixed()). '?' would also be non-crash, but a real value is
// present, so a digit must appear.
const call = async (label, args, mustMatch) => {
  let out, threw = null;
  try { out = await handlers.mindscape(args); } catch (e) { threw = e.message; }
  const ok = !threw && typeof out === 'string' && out.length > 0 && mustMatch.test(out);
  rec(label, ok, threw ? `THREW: ${threw}` : `→ "${String(out).replace(/\n/g, ' ').slice(0, 72)}…"`);
};
await call('S1. view:territories renders (no toFixed crash) + numeric vitality', { view: 'territories' }, /\b0\.\d/);
await call('S2. view:territory renders identity vitality/coherence/energy (no crash)', { view: 'territory', territory: 1 }, /\b0\.\d/);
await call('S3. view:explore renders focus-territory vitality label (no crash)', { view: 'explore', territory: 1 }, /\b0\.\d|active/);
await call('S4. view:time renders state vitality (no crash)', { view: 'time', territory: 1 }, /\b0\.\d|active/);

close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — mindscape views coerce SEC-3 scalars before formatting (no .toFixed crash)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
