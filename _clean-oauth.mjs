// Clear accumulated OAuth + session state (stale DCR clients, access tokens,
// consents) + verification, so a fresh client gets a clean flow. KEEPS user +
// account (the operator password just set), jwks (token signing keys),
// mycelium_remote_secret (relay token/acme creds), mycelium_app_secret.
import Database from 'better-sqlite3';
const db = new Database(process.argv[2]);
db.pragma('foreign_keys = OFF');
const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
const clear = tables.filter((t) => /^oauth/i.test(t) || t === 'session' || t === 'verification');
for (const t of clear) console.log(`  cleared ${t}: ${db.prepare(`delete from ${t}`).run().changes}`);
console.log(`  kept: ${tables.filter((t) => !clear.includes(t)).join(', ')}`);
db.close();
