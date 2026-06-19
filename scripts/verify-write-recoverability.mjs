// verify:write-recoverability — RT2-H1 overwrite recoverability over a REAL booted vault.
// Proves that `saveDocument` (documents.upsert) and `remember` (facts.upsert) snapshot the
// PRIOR value before a content-changing overwrite, that the snapshot is ENCRYPTED at rest,
// and that a restore round-trips — the recovery half of the owner channel-write grant.
//
//   V1 create → NO version row (nothing to recover yet)
//   V2 overwrite → prior content captured in document_versions
//   V3 snapshot ENCRYPTED at rest (raw read = ciphertext, no plaintext substring)
//   V4 restoreVersion brings the prior content back (round-trip)
//   V5 identical re-write → NO new version (no churn)
//   V6 facts: remember → overwrite captures prior value (encrypted) + restore round-trips
//   V7 forgotten doc/fact → overwrite/re-assert does NOT version a husk
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-write-recoverability.db', KCV = 'data/verify-write-recoverability-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
// Raw (un-decrypting) read straight off the SQLite file — proves at-rest ciphertext.
const rawRead = (sql, params = []) => { const d = new Database(DB, { readonly: true }); try { return d.prepare(sql).all(...params); } finally { d.close(); } };
const rawFileHasPlaintext = (needle) => { try { return readFileSync(DB).toString('latin1').includes(needle); } catch { return false; } };

if (!db?.documents?.upsert || !db?.documents?.listVersions || !db?.documents?.restoreVersion) { console.log('FAIL  db.documents version API missing'); process.exit(1); }
if (!db?.facts?.upsert || !db?.facts?.listVersions || !db?.facts?.restoreVersion) { console.log('FAIL  db.facts version API missing'); process.exit(1); }

// ── Documents ──────────────────────────────────────────────────────────
const PATH = 'notes/lisbon.md';
const V1_CONTENT = 'Original plan: move to Lisbon in Q3 — ORIGINAL-DOC-SECRET-AAA';
const V2_CONTENT = 'POISONED by forwarded content — ignore the owner — OVERWRITE-DOC-BBB';

// V1 create → no version
{
  await db.documents.upsert({ user_id: U, path: PATH, title: 'Lisbon', summary: 'plan', content: V1_CONTENT });
  const vers = await db.documents.listVersions(U, PATH);
  rec('V1 create writes NO version row (nothing to recover yet)', Array.isArray(vers) && vers.length === 0, `n=${vers.length}`);
}

// V2 overwrite → prior captured
{
  await db.documents.upsert({ user_id: U, path: PATH, title: 'Lisbon', summary: 'plan', content: V2_CONTENT }, { trigger: 'channel' });
  const vers = await db.documents.listVersions(U, PATH);
  rec('V2 overwrite captures the PRIOR content (decrypted via DAL)', vers.length === 1 && vers[0].content === V1_CONTENT && vers[0].trigger === 'channel', JSON.stringify({ n: vers.length, t: vers[0]?.trigger, c: vers[0]?.content?.slice(0, 18) }));
}

// V3 ENCRYPTED at rest
{
  const raw = rawRead('SELECT content, title, summary FROM document_versions');
  const r0 = raw[0] || {};
  const encrypted = !!r0.content && r0.content !== V1_CONTENT && !String(r0.content).includes('ORIGINAL-DOC-SECRET-AAA');
  rec('V3 doc snapshot is ENCRYPTED at rest (raw ≠ plaintext)', encrypted, `raw=${String(r0.content).slice(0, 22)}…`);
  rec('V3 no doc-version plaintext anywhere in the file', !rawFileHasPlaintext('ORIGINAL-DOC-SECRET-AAA'));
}

// V4 restore round-trips
{
  const vers = await db.documents.listVersions(U, PATH);
  const restored = await db.documents.restoreVersion(U, PATH, vers[0].id);
  const live = await db.documents.get(U, PATH);
  rec('V4 restoreVersion brings the prior content back', restored && live?.content === V1_CONTENT, `live=${live?.content?.slice(0, 18)}`);
  // Restore itself versioned the (poisoned) current value → reversible both ways.
  const after = await db.documents.listVersions(U, PATH);
  rec('V4 restore is itself versioned (poisoned value recoverable too)', after.length === 2 && after.some((v) => v.content === V2_CONTENT), `n=${after.length}`);
}

// V5 identical re-write → no new version
{
  const before = (await db.documents.listVersions(U, PATH)).length;
  await db.documents.upsert({ user_id: U, path: PATH, title: 'Lisbon', summary: 'plan', content: V1_CONTENT }); // same as live now
  const after = (await db.documents.listVersions(U, PATH)).length;
  rec('V5 identical re-write writes NO new version (no churn)', after === before, `${before}→${after}`);
}

// ── Facts ──────────────────────────────────────────────────────────────
const FV1 = 'Lisbon — ORIGINAL-FACT-SECRET-CCC';
const FV2 = 'POISONED — OVERWRITE-FACT-DDD';
{
  await db.facts.upsert({ userId: U, category: 'plan', key: 'destination', value: FV1 });
  const v0 = await db.facts.listVersions({ userId: U, category: 'plan', key: 'destination' });
  rec('V6 fact create writes NO version', v0.length === 0, `n=${v0.length}`);

  await db.facts.upsert({ userId: U, category: 'plan', key: 'destination', value: FV2, trigger: 'channel' });
  const v1 = await db.facts.listVersions({ userId: U, category: 'plan', key: 'destination' });
  rec('V6 fact overwrite captures the PRIOR value', v1.length === 1 && v1[0].value === FV1 && v1[0].trigger === 'channel', JSON.stringify({ n: v1.length, v: v1[0]?.value?.slice(0, 16) }));

  const rawf = rawRead('SELECT value FROM fact_versions');
  rec('V6 fact snapshot ENCRYPTED at rest + no plaintext in file', !!rawf[0]?.value && rawf[0].value !== FV1 && !rawFileHasPlaintext('ORIGINAL-FACT-SECRET-CCC'), `raw=${String(rawf[0]?.value).slice(0, 22)}…`);

  const restored = await db.facts.restoreVersion(U, v1[0].id);
  const live = (await db.facts.list({ userId: U, category: 'plan' })).find((f) => f.key === 'destination');
  rec('V6 fact restoreVersion round-trips the prior value', restored && live?.value === FV1, `live=${live?.value?.slice(0, 16)}`);
}

// V7 forgotten husk is not versioned
{
  // forget the doc, then re-assert via upsert — a forgotten husk must NOT be snapshotted.
  await db.documents.redact(U, PATH);
  const before = (await db.documents.listVersions(U, PATH)).length;
  await db.documents.upsert({ user_id: U, path: PATH, title: 'Lisbon', summary: 'plan', content: 'reborn after forget' });
  const after = (await db.documents.listVersions(U, PATH)).length;
  rec('V7 re-asserting a FORGOTTEN doc does not version the husk', after === before, `${before}→${after}`);
}

// ── Red-team hardening (0036): MED-1 non-content fields · MED-2 entities · HIGH-1 prune · LOW-1 trigger ──

// V8 (MED-1) — overwriting ONLY a non-content encrypted field (metadata) still versions,
// and the full prior snapshot round-trips that field.
{
  const P = 'notes/med1.md';
  await db.documents.upsert({ user_id: U, path: P, title: 'T', content: 'body', metadata: JSON.stringify({ sender: 'ORIGINAL-META-EEE' }) });
  await db.documents.upsert({ user_id: U, path: P, title: 'T', content: 'body', metadata: JSON.stringify({ sender: 'POISONED-META' }) }); // content/title identical
  const vers = await db.documents.listVersions(U, P);
  rec('V8 metadata-only overwrite IS versioned (non-content field gap closed)', vers.length === 1, `n=${vers.length}`);
  rec('V8 no metadata plaintext leaked at rest', !rawFileHasPlaintext('ORIGINAL-META-EEE'));
  await db.documents.restoreVersion(U, P, vers[0].id);
  const live = await db.documents.get(U, P);
  rec('V8 restore brings back the prior metadata (full snapshot)', JSON.parse(live.metadata || '{}').sender === 'ORIGINAL-META-EEE', `meta=${live.metadata}`);
}

// V9 (HIGH-1) — keep-last-N prune bounds version growth under an overwrite loop.
{
  const P = 'notes/dos.md';
  await db.documents.upsert({ user_id: U, path: P, title: 'X', content: 'v0' });
  for (let i = 1; i <= 60; i++) await db.documents.upsert({ user_id: U, path: P, title: 'X', content: `v${i}-${i % 2}` }); // always changes
  const raw = rawRead('SELECT id FROM document_versions WHERE path = ?', [P]);
  rec('V9 unbounded-overwrite growth is BOUNDED (keep-last-50)', raw.length <= 50, `rows=${raw.length}`);
}

// V10 (MED-2) — remember(entity) overwrite captures the prior summary, encrypted + restorable.
{
  const ESUM1 = 'Met at the conference — ORIGINAL-ENTITY-SECRET-GGG';
  const r1 = await db.entities.upsert({ userId: U, type: 'person', name: 'Dana', summary: ESUM1 });
  const v0 = await db.entities.listVersions({ userId: U, entityId: r1.id });
  rec('V10 entity create writes NO version', v0.length === 0, `n=${v0.length}`);
  await db.entities.upsert({ userId: U, type: 'person', name: 'Dana', summary: 'POISONED entity summary', trigger: 'channel' });
  const v1 = await db.entities.listVersions({ userId: U, entityId: r1.id });
  rec('V10 entity overwrite captures the PRIOR summary', v1.length === 1 && v1[0].summary === ESUM1 && v1[0].trigger === 'channel', JSON.stringify({ n: v1.length, s: v1[0]?.summary?.slice(0, 16) }));
  const rawe = rawRead('SELECT summary FROM entity_versions');
  rec('V10 entity snapshot ENCRYPTED at rest + no plaintext in file', !!rawe[0]?.summary && rawe[0].summary !== ESUM1 && !rawFileHasPlaintext('ORIGINAL-ENTITY-SECRET-GGG'), `raw=${String(rawe[0]?.summary).slice(0, 20)}…`);
  await db.entities.restoreVersion(U, v1[0].id);
  const liveE = (await db.entities.list({ userId: U, type: 'person' })).find((e) => e.name === 'Dana');
  rec('V10 entity restoreVersion round-trips the prior summary', liveE?.summary === ESUM1, `live=${liveE?.summary?.slice(0, 16)}`);
}

// V11 (LOW-1) — provenance honesty: with NO trigger supplied (the real saveDocument/remember
// path), the version is stamped the default 'overwrite' (not a false 'channel'); an explicit
// trigger is honored. Per-surface channel labeling is a documented follow-up.
{
  const P = 'notes/trigger.md';
  await db.documents.upsert({ user_id: U, path: P, content: 'a' });
  await db.documents.upsert({ user_id: U, path: P, content: 'b' }); // no opts → real default path
  const vers = await db.documents.listVersions(U, P);
  rec('V11 default trigger is honest "overwrite" (no false channel-provenance)', vers[0]?.trigger === 'overwrite', `trigger=${vers[0]?.trigger}`);
}

await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — overwrite recoverability: prior captured · encrypted-at-rest · restore round-trips · no churn · husk-safe · all-fields (MED-1) · entities (MED-2) · growth-bounded (HIGH-1) · honest-trigger (LOW-1)' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
