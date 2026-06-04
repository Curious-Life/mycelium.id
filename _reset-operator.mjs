// Reset ONLY the better-auth operator identity (user/account/session/verification)
// in auth.db, so the app's Settings → Remote Access can set a fresh password.
// KEEPS mycelium_remote_secret (relay token + acme creds), mycelium_app_secret
// (OAuth signing secret), and the DCR client tables — so the tunnel/cert and
// Claude's registration survive; only the login password is reset.
import Database from 'better-sqlite3';
const db = new Database(process.argv[2]);
db.pragma('foreign_keys = OFF');
const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
for (const t of ['session', 'account', 'verification', 'user']) {
  if (tables.includes(t)) console.log(`  cleared ${t}: ${db.prepare(`delete from ${t}`).run().changes}`);
}
const users = tables.includes('user') ? db.prepare('select count(*) AS n from user').get().n : -1;
console.log(`  users remaining: ${users}`);
console.log(`  kept: ${tables.filter((t) => /remote_secret|app_secret|oauth/i.test(t)).join(', ') || '(none)'}`);
db.close();
