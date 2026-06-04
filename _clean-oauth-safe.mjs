// _clean-oauth-safe.mjs — SAFELY reset OAuth/session churn in auth.db with
// foreign keys ON, so cascades fire and NO orphaned rows are left behind.
//
// Deletes: oauthAccessToken, oauthConsent, oauthApplication, session
// KEEPS:   user, account, jwks, mycelium_app_secret, mycelium_remote_secret
//          (operator login, token-signing keys, relay/acme secrets all survive;
//           Claude simply re-registers on the next connect — expected/clean.)
//
// Run with the app STOPPED:
//   node _clean-oauth-safe.mjs "/Users/<you>/Library/Application Support/id.mycelium.app/auth.db"
//
// Replaces the old _reset-operator.mjs / _clean-oauth.mjs, which ran
// `pragma foreign_keys = OFF` then `DELETE FROM user` — so the cascade never
// fired and token rows were ORPHANED (userId → dead user), which made the next
// token INSERT/refresh fail the FK constraint → `POST /token` 500 → no token →
// the Claude connector died. (Root cause found 2026-06-04 via auth.db forensics.)
import Database from 'better-sqlite3';

const path = process.argv[2];
if (!path) {
  console.error('usage: node _clean-oauth-safe.mjs <auth.db path>');
  process.exit(2);
}

const db = new Database(path);
db.pragma('foreign_keys = ON');

const tables = new Set(
  db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name),
);
const countOrphans = () =>
  tables.has('oauthAccessToken') && tables.has('user')
    ? db
        .prepare(
          'select count(*) n from oauthAccessToken t left join user u on t.userId = u.id where u.id is null',
        )
        .get().n
    : 0;

const orphansBefore = countOrphans();

// Children before parents — works regardless of whether cascade is relied upon.
const order = ['oauthAccessToken', 'oauthConsent', 'oauthApplication', 'session'];
const run = db.transaction(() => {
  for (const t of order) {
    if (tables.has(t)) {
      const changes = db.prepare(`delete from ${t}`).run().changes;
      console.log(`  cleared ${t}: ${changes}`);
    }
  }
});
run();

const orphansAfter = countOrphans();
const users = tables.has('user') ? db.prepare('select count(*) n from user').get().n : -1;
console.log(`  users kept: ${users}`);
console.log(`  orphan accessTokens: ${orphansBefore} → ${orphansAfter}`);
console.log(`  kept tables: ${[...tables].filter((t) => !order.includes(t)).join(', ')}`);
db.close();

if (orphansAfter !== 0) {
  console.error('FAIL: orphaned token rows remain — do NOT start the app.');
  process.exit(1);
}
console.log('OK: clean OAuth slate; operator + signing keys + relay secrets preserved.');
