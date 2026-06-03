import { createAuth, ensureOperatorUser } from './src/auth.js';
const pw = process.argv[2];
const { auth, database } = createAuth();          // MYCELIUM_DATA_DIR → live db + secret + baseURL
database.pragma('busy_timeout = 8000');
database.pragma('foreign_keys = OFF');
const cleared = {};
for (const t of ['session', 'account', 'verification', 'user']) {
  try { cleared[t] = database.prepare(`delete from ${t}`).run().changes; } catch (e) { cleared[t] = 'ERR ' + e.message; }
}
await ensureOperatorUser(auth, { email: 'operator@mycelium.local', password: pw });
console.log('reset + recreated operator@mycelium.local; cleared =', JSON.stringify(cleared));
process.exit(0);
