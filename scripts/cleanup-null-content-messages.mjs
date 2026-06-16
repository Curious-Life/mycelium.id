// scripts/cleanup-null-content-messages.mjs — one-time hygiene for the dead
// content-NULL message rows that a pre-guard full-export import left behind
// (PIPELINE-INTEGRITY design §P1.4). These rows have no content, no attachment,
// no embedding, and aren't user-forgotten — so they can never embed/cluster/
// search and just sit as permanently-pending pipeline rows (the stuck "N
// remaining" backlog). We TOMBSTONE them (set forgotten_at — reversible, audit-
// logged, excluded everywhere by the existing `forgotten_at IS NULL` filters)
// rather than hard-delete.
//
// Fail-CLOSED safety: only ever touches rows that are ALL of:
//   content NULL/empty · forgotten_at NULL · attachment_id NULL/empty ·
//   embedding_768 NULL · NOT referenced by any clustering_point.
// Content-bearing, forgotten, attached, embedded, or clustered rows are NEVER
// touched. DRY-RUN by default; pass --apply to write.
//
// Usage:
//   MYCELIUM_DB=<vault.db> [MYCELIUM_USER_ID=local-user] node scripts/cleanup-null-content-messages.mjs            # dry-run
//   MYCELIUM_DB=<vault.db> node scripts/cleanup-null-content-messages.mjs --apply                                  # tombstone
import { getDb } from '../src/db/index.js';
import { loadKey } from '../src/crypto/keys.js';
import { resolveKeys } from '../src/crypto/key-source.js';

const USER_ID = process.env.MYCELIUM_USER_ID || 'local-user';
const DB_PATH = process.env.MYCELIUM_DB;
const APPLY = process.argv.includes('--apply');

if (!DB_PATH) { console.error('Set MYCELIUM_DB to the target vault db.'); process.exit(1); }

// The fail-closed predicate — the ONLY rows this script will ever consider.
const DEAD_PREDICATE = `
  user_id = ?
  AND (content IS NULL OR content = '')
  AND forgotten_at IS NULL
  AND embedding_768 IS NULL
  AND (attachment_id IS NULL OR attachment_id = '')
`;

async function run() {
  const { userHex, systemHex } = resolveKeys();
  const userKey = await loadKey(userHex);
  const systemKey = await loadKey(systemHex);
  const { db, close } = getDb({ dbPath: DB_PATH, userKey, systemKey, scope: 'personal' });

  console.log(`\n=== cleanup null-content messages ${APPLY ? '(APPLY)' : '(DRY RUN)'} ===`);
  console.log(`  DB:   ${DB_PATH}`);
  console.log(`  user: ${USER_ID}\n`);

  // Candidate dead rows (structural columns only — never decrypts; content is null anyway).
  const cand = (await db.rawQuery(
    `SELECT id, source, created_at FROM messages WHERE ${DEAD_PREDICATE} ORDER BY created_at ASC`,
    [USER_ID],
  )).results || [];

  if (cand.length === 0) {
    console.log('  No dead content-NULL rows found. Nothing to do.');
    close();
    console.log('\nVERDICT: GO — vault clean.');
    return;
  }

  // Belt-and-suspenders: exclude any row referenced by a clustering_point (A8 —
  // embedding-NULL rows can't be clustered, but verify rather than assume).
  const safe = [];
  let clusteredSkipped = 0;
  for (const r of cand) {
    const ref = (await db.rawQuery(
      `SELECT 1 FROM clustering_points WHERE user_id = ? AND source_type = 'message' AND source_id = ? LIMIT 1`,
      [USER_ID, r.id],
    )).results || [];
    if (ref.length) { clusteredSkipped++; continue; }
    safe.push(r);
  }

  const bySource = {};
  for (const r of safe) bySource[r.source || '(none)'] = (bySource[r.source || '(none)'] || 0) + 1;

  console.log(`  candidates (dead predicate): ${cand.length}`);
  console.log(`  excluded — referenced by a cluster: ${clusteredSkipped}`);
  console.log(`  → safe to tombstone: ${safe.length}`);
  console.log(`  by source: ${JSON.stringify(bySource)}`);
  console.log(`  oldest: ${safe[0]?.created_at}  newest: ${safe[safe.length - 1]?.created_at}`);
  console.log(`  sample ids: ${safe.slice(0, 5).map((r) => r.id).join(', ')}${safe.length > 5 ? ' …' : ''}`);

  if (!APPLY) {
    close();
    console.log('\n(dry run — nothing written. Re-run with --apply to tombstone the rows above.)');
    console.log(`VERDICT: REVIEW — ${safe.length} dead rows would be tombstoned.`);
    return;
  }

  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  let done = 0;
  for (const r of safe) {
    try {
      await db.rawQuery(`UPDATE messages SET forgotten_at = ? WHERE id = ? AND user_id = ?`, [now, r.id, USER_ID]);
      try { await db.audit?.log?.({ action: 'cleanup-null-content', userId: USER_ID, resourceType: 'messages', resourceId: r.id, details: { source: r.source, created_at: r.created_at, reason: 'content-null dead pipeline row' } }); } catch { /* audit best-effort */ }
      done++;
    } catch (e) { console.error(`  failed on ${r.id}: ${e?.message}`); }
  }
  close();
  console.log(`\n  tombstoned: ${done}/${safe.length}`);
  console.log(`VERDICT: ${done === safe.length ? 'GO' : 'REVIEW'} — ${done} dead rows tombstoned (reversible: clear forgotten_at to restore).`);
}

run().catch((e) => { console.error(e); process.exit(1); });
