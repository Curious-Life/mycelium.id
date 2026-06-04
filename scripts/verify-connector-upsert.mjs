// Verify — content-aware upsert (Tier 1, docs/DESIGN-connector-content-upsert-2026-06-04.md).
// No network. Proves captureMessage's insert / no-op / update(+re-enrich)
// contract; that an update re-enriches (nlp_processed=0, embedding_768 NULL,
// clustering_points dropped) while staying ENCRYPTED at rest (content) with a
// PLAINTEXT content_hash; that forgotten rows are never resurrected; that an
// Obsidian re-import edit UPDATES the same memory (no duplicate); and the
// scheduler's `updated` tally + idle-backoff.
//
//   U0 connectorDueAt   idle-backoff math (pure): 1×, 2×, 16×, clamp
//   U1 created          new id → created; content_hash set+PLAINTEXT; content ENCRYPTED; queued (nlp=0)
//   U2 unchanged        same id+content → deduped; NOT re-enriched (nlp/embedding kept)
//   U3 changed          same id, new content → updated + re-enrich (nlp=0, emb NULL, clusters dropped); new content encrypted; hash updated
//   U4 forgotten        redacted row → changed re-capture does NOT resurrect (content stays NULL)
//   U5 obsidian edit    re-import edited note → memoriesUpdated:1, single memory row, content reflects edit
//   U6 scheduler        runSync tallies updated; empty pull bumps idleStreak; run log recorded
//
// PASS/FAIL ledger + VERDICT + EXIT=<code>.

import crypto from 'node:crypto';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { captureMessage } from '../src/ingest/capture.js';
import { importObsidianVault } from '../src/ingest/obsidian-import.js';
import { createConnectorRunner, registerAdapter, connectorDueAt } from '../src/connectors/index.js';

const DB = 'data/verify-connector-upsert.db';
const KCV = 'data/verify-connector-upsert-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

async function main() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  const raw = new Database(DB); applyMigrations(raw); raw.close();

  // ── U0 connectorDueAt backoff math (pure, no server) ──
  const base = 1000;
  const t = '2026-01-01T00:00:00.000Z';
  const L = Date.parse(t);
  const due = (idleStreak) => connectorDueAt({ lastSyncAt: t, idleStreak }, base);
  rec('U0. connectorDueAt backoff (0→1×, 1→2×, 4→16×, 9→clamp 16×)',
    due(0) === L + base && due(1) === L + base * 2 && due(4) === L + base * 16 && due(9) === L + base * 16,
    `0→${due(0) - L} 1→${due(1) - L} 4→${due(4) - L} 9→${due(9) - L}`);

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { db } = srv;
  const uid = 'local-user';
  const enq = () => {};
  const q1 = async (sql, p = []) => (await db.rawQuery(sql, p)).results?.[0] ?? null;
  // At-rest scan covers the main db file AND the -wal (writes may not be checkpointed).
  const bytes = () => { let b = readFileSync(DB); try { b = Buffer.concat([b, readFileSync(`${DB}-wal`)]); } catch {} return b; };
  const fileHas = (s) => bytes().includes(Buffer.from(s));

  try {
    const ID = 'gmail:upsert-1';
    const C1 = 'UPSERT-MARKER-CONTENT-ONE body alpha';
    const C2 = 'UPSERT-MARKER-CONTENT-TWO body bravo CHANGED';
    const META = 'UPSERT-METADATA-MARKER-secret-subject';

    // ── U1 created ──
    const r1 = await captureMessage(db, { userId: uid, content: C1, source: 'gmail', messageType: 'email', id: ID, metadata: { subject: META } }, enq);
    const row1 = await q1('SELECT content, content_hash, nlp_processed, metadata FROM messages WHERE id = ? AND user_id = ?', [ID, uid]);
    rec('U1. new id → created; hash set+plaintext; content+metadata encrypted; queued',
      r1.deduped === false && r1.updated === false
      && row1?.content === C1 && row1?.content_hash === sha(C1) && row1?.nlp_processed === 0
      && /UPSERT-METADATA-MARKER/.test(row1?.metadata || '')
      && !fileHas(C1) && !fileHas(META) && fileHas(sha(C1)),
      `created=${!r1.deduped} hash=${row1?.content_hash?.slice(0, 8)}… contentLeak=${fileHas(C1)} metaLeak=${fileHas(META)} hashPlaintext=${fileHas(sha(C1))} nlp=${row1?.nlp_processed}`);

    // simulate an already-enriched message: mark processed + embedding + a mindscape point
    await db.rawQuery('UPDATE messages SET nlp_processed = 1, embedding_768 = ? WHERE id = ? AND user_id = ?', ['[0.1,0.2,0.3]', ID, uid]);
    await db.rawQuery('INSERT INTO clustering_points (id, user_id, source_type, source_id, content) VALUES (?,?,?,?,?)', [crypto.randomUUID(), uid, 'message', ID, C1]);

    // ── U2 unchanged → deduped, NOT re-enriched ──
    const r2 = await captureMessage(db, { userId: uid, content: C1, source: 'gmail', messageType: 'email', id: ID }, enq);
    const row2 = await q1('SELECT nlp_processed, embedding_768 FROM messages WHERE id = ? AND user_id = ?', [ID, uid]);
    rec('U2. unchanged re-capture → deduped, NOT re-enriched',
      r2.deduped === true && r2.updated === false && row2?.nlp_processed === 1 && row2?.embedding_768 !== null,
      `deduped=${r2.deduped} updated=${r2.updated} nlp=${row2?.nlp_processed} embeddingKept=${row2?.embedding_768 !== null}`);

    // ── U3 changed → updated + re-enrich; metadata PRESERVED (not wiped) ──
    // Re-capture with NO metadata: the prior metadata must survive (conditional write).
    const r3 = await captureMessage(db, { userId: uid, content: C2, source: 'gmail', messageType: 'email', id: ID }, enq);
    const row3 = await q1('SELECT content, content_hash, nlp_processed, embedding_768, metadata FROM messages WHERE id = ? AND user_id = ?', [ID, uid]);
    const cp3 = await q1('SELECT COUNT(*) AS c FROM clustering_points WHERE user_id = ? AND source_id = ?', [uid, ID]);
    rec('U3. changed → updated + re-enrich (nlp=0, emb NULL, clusters dropped); metadata preserved; new content encrypted',
      r3.updated === true && r3.deduped === false
      && row3?.content === C2 && row3?.content_hash === sha(C2)
      && row3?.nlp_processed === 0 && row3?.embedding_768 === null && cp3?.c === 0
      && /UPSERT-METADATA-MARKER/.test(row3?.metadata || '')
      && !fileHas(C2) && fileHas(sha(C2)) && !fileHas(META),
      `updated=${r3.updated} nlp=${row3?.nlp_processed} emb=${row3?.embedding_768} clusters=${cp3?.c} metaPreserved=${/UPSERT-METADATA-MARKER/.test(row3?.metadata || '')} newContentLeak=${fileHas(C2)}`);

    // ── U4 forgotten not resurrected ──
    const FID = 'gmail:forget-1';
    await captureMessage(db, { userId: uid, content: 'to be forgotten', source: 'gmail', messageType: 'email', id: FID }, enq);
    await db.messages.redact(FID, uid); // content NULL + forgotten_at set
    const r4 = await captureMessage(db, { userId: uid, content: 'resurrection attempt', source: 'gmail', messageType: 'email', id: FID }, enq);
    const row4 = await q1('SELECT content, content_hash, forgotten_at FROM messages WHERE id = ? AND user_id = ?', [FID, uid]);
    rec('U4. forgotten row not resurrected',
      r4.updated === false && row4?.content === null && row4?.content_hash === null && row4?.forgotten_at !== null,
      `updated=${r4.updated} content=${row4?.content} hash=${row4?.content_hash} forgotten=${!!row4?.forgotten_at}`);

    // ── U5 obsidian path-stable edit → update, not duplicate ──
    const note = (body) => [{ relPath: 'Notes/Idea.md', content: body }];
    const o1 = await importObsidianVault(db, { userId: uid, files: note('# Idea\n\nOBSIDIAN-MARK first'), vaultName: 'MyVault', enqueueEnrichment: enq });
    const o2 = await importObsidianVault(db, { userId: uid, files: note('# Idea\n\nOBSIDIAN-MARK first'), vaultName: 'MyVault', enqueueEnrichment: enq });
    const o3 = await importObsidianVault(db, { userId: uid, files: note('# Idea\n\nOBSIDIAN-MARK SECOND edited'), vaultName: 'MyVault', enqueueEnrichment: enq });
    const memId = 'obsidian:MyVault/Notes/Idea';
    const cnt = await q1('SELECT COUNT(*) AS c FROM messages WHERE user_id = ? AND id = ?', [uid, memId]);
    const memRow = await q1('SELECT content FROM messages WHERE id = ? AND user_id = ?', [memId, uid]);
    rec('U5. obsidian edit updates the same memory (no duplicate)',
      o1.memoriesCreated === 1 && o2.memoriesDeduped === 1 && o3.memoriesUpdated === 1 && o3.memoriesCreated === 0
      && cnt?.c === 1 && /SECOND edited/.test(memRow?.content || ''),
      `created=${o1.memoriesCreated} deduped=${o2.memoriesDeduped} updated=${o3.memoriesUpdated} rows=${cnt?.c} reflectsEdit=${/SECOND edited/.test(memRow?.content || '')}`);

    // ── U6 scheduler tallies updated + idle-backoff (stateful test adapter) ──
    let mode = 'v1';
    registerAdapter({
      id: 'upsert-test', label: 'Upsert Test', provider: 'test', oauth: null,
      async pull() {
        if (mode === 'empty') return { items: [], nextCursor: 'x' };
        return { items: [{ id: 'upsert-test:a', source: 'upsert-test', content: `# A\n\nSCHED body ${mode}`, messageType: 'connector' }], nextCursor: 'x' };
      },
    });
    const runner = createConnectorRunner({ db, userId: uid, enqueueEnrichment: enq });
    await runner.connect('upsert-test', {}); // non-oauth → connected
    const s1 = await runner.runSync('upsert-test');                                                         // created 1 → idle reset
    const s2 = await runner.runSync('upsert-test'); const st2 = await runner.store.getState('upsert-test'); // deduped-only → idle 1
    mode = 'v2';
    const s3 = await runner.runSync('upsert-test'); const st3 = await runner.store.getState('upsert-test'); // updated → idle reset 0
    mode = 'empty';
    const s4 = await runner.runSync('upsert-test'); const st4 = await runner.store.getState('upsert-test'); // empty → idle 1
    const s5 = await runner.runSync('upsert-test'); const st5 = await runner.store.getState('upsert-test'); // empty → idle 2
    rec('U6. scheduler tally + net-new idle-backoff (deduped-only backs off; real change resets) + run log',
      s1.created === 1 && s2.deduped === 1 && st2?.idleStreak === 1
      && s3.updated === 1 && s3.created === 0 && st3?.idleStreak === 0
      && s4.pulled === 0 && st4?.idleStreak === 1 && st5?.idleStreak === 2
      && Array.isArray(st5?.recentRuns) && st5.recentRuns.length >= 3 && st5?.lastRun?.ok === true,
      `created=${s1.created} deduped=${s2.deduped}/idle${st2?.idleStreak} updated=${s3.updated}/idle${st3?.idleStreak} empty/idle${st4?.idleStreak}->${st5?.idleStreak} runs=${st5?.recentRuns?.length}`);

    // ── U7 obsidian legacy content-hash memory converges on re-import ──
    const lfiles = [{ relPath: 'Note.md', content: '# Legacy\n\nLEGACY-MARK unchanged' }];
    await importObsidianVault(db, { userId: uid, files: lfiles, vaultName: 'LegacyVault', enqueueEnrichment: enq });
    const stored = await q1('SELECT content FROM messages WHERE id = ? AND user_id = ?', ['obsidian:LegacyVault/Note', uid]);
    const legacyMemId = `obsidian:${sha(stored.content)}`;
    // simulate a pre-0007 import: a content-addressed memory + its mindscape point
    await captureMessage(db, { userId: uid, content: stored.content, source: 'obsidian', messageType: 'note', id: legacyMemId }, enq);
    await db.rawQuery('INSERT INTO clustering_points (id, user_id, source_type, source_id, content) VALUES (?,?,?,?,?)', [crypto.randomUUID(), uid, 'message', legacyMemId, stored.content]);
    const L2 = await importObsidianVault(db, { userId: uid, files: lfiles, vaultName: 'LegacyVault', enqueueEnrichment: enq });
    const legacyRow = await q1('SELECT content, forgotten_at FROM messages WHERE id = ? AND user_id = ?', [legacyMemId, uid]);
    const legacyCp = await q1('SELECT COUNT(*) AS c FROM clustering_points WHERE user_id = ? AND source_id = ?', [uid, legacyMemId]);
    rec('U7. obsidian legacy content-hash memory converged (redacted + point dropped) on re-import',
      L2.memoriesMigrated === 1 && legacyRow?.content === null && legacyRow?.forgotten_at !== null && legacyCp?.c === 0,
      `migrated=${L2.memoriesMigrated} legacyForgotten=${!!legacyRow?.forgotten_at} legacyPoints=${legacyCp?.c}`);

    // ── U8 per-connection daily budget gates the pull once spent + status surfaces it ──
    process.env.MYCELIUM_CONNECTOR_DAILY_ITEMS = '2';
    registerAdapter({
      id: 'budget-test', label: 'Budget Test', provider: 'test', oauth: null,
      async pull() { return { items: [{ id: 'budget-test:a', source: 'budget-test', content: '# B\n\nbudget body', messageType: 'connector' }], nextCursor: 'x' }; },
    });
    await runner.connect('budget-test', {});
    const ba = await runner.runSync('budget-test'); // pulled 1 → itemsToday 1
    const bb = await runner.runSync('budget-test'); // pulled 1 (deduped) → itemsToday 2
    const bc = await runner.runSync('budget-test'); // 2 >= 2 → skipped, pulled 0
    const stb = await runner.store.getState('budget-test');
    const bstat = (await runner.status()).find((x) => x.id === 'budget-test');
    delete process.env.MYCELIUM_CONNECTOR_DAILY_ITEMS;
    rec('U8. daily budget gates the pull once spent + status surfaces it',
      ba.pulled === 1 && bb.pulled === 1 && bc.skipped === 'daily_budget' && bc.pulled === 0
      && stb?.itemsToday === 2 && bstat?.itemsToday === 2 && bstat?.dailyItemLimit === 2,
      `a=${ba.pulled} b=${bb.pulled} c.skipped=${bc.skipped} itemsToday=${stb?.itemsToday} limit=${bstat?.dailyItemLimit}`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
  }

  const allPass = ledger.every(Boolean);
  console.log(`VERDICT: ${allPass ? 'GO — content-aware upsert: created/deduped/updated + re-enrich, encrypted-at-rest + plaintext hash, forgotten-safe, obsidian path-stable edit, scheduler tally + idle-backoff + daily budget' : 'NO-GO — see FAIL rows'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('verify-connector-upsert threw:', e); process.exit(1); });
