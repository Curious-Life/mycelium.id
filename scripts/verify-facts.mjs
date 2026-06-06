// verify:facts — Context Bank Phase 2. Boots the real MCP server and drives the
// `remember` verb + facts read paths on a LOCAL vault, asserting: value is
// ENCRYPTED at rest, the fact surfaces in getContext + searchMindscape(facts),
// re-remember supersedes in place (UNIQUE), sensitive is excluded from getContext
// but present in the explicit listing, forget soft-redacts (value nulled, husk +
// audit hash-only), and bad input fails closed. PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-facts.db', KCV = 'data/verify-facts-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, tools, handlers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

// Raw read that BYPASSES the auto-decrypt adapter — proves encryption at rest.
const rawDb = new Database(DB, { readonly: true });
const rawValue = (id) => rawDb.prepare('SELECT value FROM facts WHERE id = ?').get(id)?.value ?? null;
function looksEncrypted(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  try { const o = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); return !!(o.iv && o.ct && o.dk); }
  catch { return false; }
}

const names = tools.map((t) => t.name);
rec('FA1. remember registered; total tools = 31', names.includes('remember') && tools.length === 31, `${tools.length} tools`);

// ── remember a fact ──
const PLAIN = 'oat flat white';
const out1 = await handlers.remember({ category: 'preferences', key: 'coffee', value: PLAIN });
rec('FA2. remember reports created', /Remembered: preferences\/coffee/.test(out1), out1);

const row = (await db.facts.list({ userId: U }))[0];
rec('FA3. fact stored + decrypts transparently', row?.category === 'preferences' && row?.key === 'coffee' && row?.value === PLAIN, `value=${row?.value}`);

const raw = rawValue(row.id);
rec('FA4. value ENCRYPTED at rest (envelope, not plaintext)', raw !== PLAIN && !String(raw).includes('flat white') && looksEncrypted(raw), `raw=${String(raw).slice(0, 40)}…`);

// ── surfaces in reads ──
const ctx = await handlers.getContext({});
rec('FA5. fact surfaces in getContext FACTS section', ctx.includes('FACTS YOU KNOW') && ctx.includes('preferences/coffee') && ctx.includes(PLAIN), `hasFacts=${ctx.includes('FACTS YOU KNOW')}`);

const listed = await handlers.searchMindscape({ scope: 'facts' });
rec('FA6. fact surfaces in searchMindscape({scope:"facts"})', /## Facts/.test(listed) && listed.includes('preferences/coffee'), listed.split('\n')[0]);

// ── supersede in place (UNIQUE on category/key) ──
await handlers.remember({ category: 'preferences', key: 'coffee', value: 'cortado' });
const all = await db.facts.list({ userId: U });
const coffee = all.filter((f) => f.category === 'preferences' && f.key === 'coffee');
rec('FA7. re-remember supersedes in place (one row, new value)', coffee.length === 1 && coffee[0].value === 'cortado', `rows=${coffee.length} value=${coffee[0]?.value}`);

// ── sensitive: excluded from getContext, present in explicit listing ──
await handlers.remember({ category: 'health', key: 'therapist', value: 'Dr. Quietname', sensitive: true });
const ctx2 = await handlers.getContext({});
rec('FA8. sensitive fact EXCLUDED from getContext (proactive)', !ctx2.includes('Dr. Quietname') && !ctx2.includes('health/therapist'), `leaked=${ctx2.includes('Dr. Quietname')}`);
const listed2 = await handlers.searchMindscape({ scope: 'facts' });
rec('FA9. sensitive fact PRESENT in explicit scope:"facts" listing', listed2.includes('health/therapist') && listed2.includes('🔒'), `hasLock=${listed2.includes('🔒')}`);

// ── mark a fact pinned ──
const factId = all.find((f) => f.key === 'coffee').id;
const mk = await handlers.mark({ type: 'fact', id: factId, pinned: true });
rec('FA10. mark pins a fact', /pinned/.test(mk), mk);
const ctx3 = await handlers.getContext({ include: ['facts'] });
rec('FA11. pinned fact shows 📌 in getContext', ctx3.includes('📌') && ctx3.includes('preferences/coffee'), `hasPin=${ctx3.includes('📌')}`);

// ── forget a fact (soft-redact) ──
const fOut = await handlers.forget({ type: 'fact', id: factId });
rec('FA12. forget reports success', /Forgotten: fact/.test(fOut), fOut);
const rawAfter = rawValue(factId);
const husk = rawDb.prepare('SELECT id, value, forgotten_at, category, key FROM facts WHERE id = ?').get(factId);
rec('FA13. value nulled + forgotten_at stamped; husk (id/category/key) persists', rawAfter == null && !!husk?.forgotten_at && husk?.category === 'preferences' && husk?.key === 'coffee', `value=${rawAfter} forgotten=${!!husk?.forgotten_at}`);
const ctx4 = await handlers.getContext({ include: ['facts'] });
rec('FA14. forgotten fact gone from getContext + listing', !ctx4.includes('preferences/coffee') && !(await handlers.searchMindscape({ scope: 'facts' })).includes('preferences/coffee'), `inCtx=${ctx4.includes('preferences/coffee')}`);

// ── forget audit: hash only, no plaintext ──
let events = [];
try { events = await db.audit.recent({ eventType: 'forget' }); } catch {}
const ev = events.find((e) => e.method === factId);
const det = ev?.details || '';
rec('FA15. forget audited with hash, NO plaintext value', !!ev && /[0-9a-f]{64}/.test(det) && !det.includes('cortado') && ev.endpoint === 'fact', `details=${det}`);

// ── fail-closed ──
let badValue = false;
try { await handlers.remember({ category: 'x', key: 'y', value: '   ' }); } catch { badValue = true; }
rec('FA16. empty value fails closed', badValue, badValue ? 'threw' : 'did NOT throw');
let badKind = false;
try { await handlers.remember({ kind: 'nonsense', category: 'x', key: 'y', value: 'z' }); } catch { badKind = true; }
rec('FA17. unknown kind fails closed', badKind, badKind ? 'threw' : 'did NOT throw');

rawDb.close();
close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — facts: encrypted-at-rest, surfaced, superseded, sensitive-gated, forgotten (audit hash-only)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
