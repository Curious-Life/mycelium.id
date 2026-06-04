import Database from 'better-sqlite3';
const db = new Database(process.argv[2], { readonly: true });
const tables = db.prepare("select name from sqlite_master where type='table'").all().map(r=>r.name);
const tok = tables.filter(t=>/oauth.*token|access.*token|jwks/i.test(t));
console.log('oauth/token tables:', tok.join(', ') || '(none)');
const dec = (j) => { try { const p=j.split('.'); if(p.length!==3) return null; return JSON.parse(Buffer.from(p[1],'base64url').toString()); } catch { return null; } };
for (const t of tok) {
  let rows; try { rows = db.prepare(`select * from "${t}" order by rowid desc limit 3`).all(); } catch { continue; }
  for (const r of rows) {
    for (const [k,v] of Object.entries(r)) {
      if (typeof v==='string') { const p=dec(v); if(p) console.log(`\n[${t}.${k}] JWT claims:`, JSON.stringify({aud:p.aud, iss:p.iss, sub:p.sub, scope:p.scope, exp:p.exp})); }
    }
  }
}
db.close();
