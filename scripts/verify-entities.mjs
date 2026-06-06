// verify:entities — Context Bank Phase 3. Boots the real MCP server and drives
// remember(kind:'entity') + the `link` verb + entity reads on a LOCAL vault,
// asserting: name ENCRYPTED at rest, app-layer dedup (name is non-deterministically
// encrypted), pinned-only getContext PEOPLE (sensitive excluded), link + dossier,
// forget soft-redacts (name nulled, links dropped, husk + audit hash-only), and
// NLP-promotion (threshold-gated, source='nlp', never clobbers a user entity).
// PASS/FAIL ledger.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-entities.db', KCV = 'data/verify-entities-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const { db, close, tools, handlers } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const U = 'local-user';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const rawDb = new Database(DB, { readonly: true });
const rawName = (id) => rawDb.prepare('SELECT name FROM entities WHERE id = ?').get(id)?.name ?? null;
function looksEncrypted(value) {
  if (typeof value !== 'string' || value.length < 20) return false;
  try { const o = JSON.parse(Buffer.from(value, 'base64').toString('utf8')); return !!(o.iv && o.ct && o.dk); }
  catch { return false; }
}

const names = tools.map((t) => t.name);
rec('EN1. remember + link registered; total tools = 28', names.includes('remember') && names.includes('link') && tools.length === 28, `${tools.length} tools`);

// ── remember an entity ──
const out1 = await handlers.remember({ kind: 'entity', entityType: 'person', name: 'Alice Rivera', summary: 'my sister in Berlin', pinned: true });
rec('EN2. remember(entity) reports created', /Remembered: person "Alice Rivera"/.test(out1), out1);

const alice = (await db.entities.list({ userId: U })).find((e) => e.name === 'Alice Rivera');
rec('EN3. entity stored + decrypts transparently', alice?.type === 'person' && alice?.summary === 'my sister in Berlin', `name=${alice?.name}`);
rec('EN4. name ENCRYPTED at rest (envelope, not plaintext)', (() => { const r = rawName(alice.id); return r !== 'Alice Rivera' && !String(r).includes('Rivera') && looksEncrypted(r); })(), `raw=${String(rawName(alice.id)).slice(0, 36)}…`);

// ── app-layer dedup (name is encrypted; UNIQUE impossible) ──
await handlers.remember({ kind: 'entity', entityType: 'person', name: 'alice rivera', summary: 'updated note' });
const aliceRows = (await db.entities.list({ userId: U })).filter((e) => (e.name || '').toLowerCase() === 'alice rivera');
rec('EN5. case-insensitive dedup (one row, summary updated)', aliceRows.length === 1 && aliceRows[0].summary === 'updated note', `rows=${aliceRows.length} summary=${aliceRows[0]?.summary}`);

// ── getContext PEOPLE: pinned-only, sensitive excluded ──
await handlers.remember({ kind: 'entity', entityType: 'person', name: 'Carl Unpinned' }); // not pinned
await handlers.remember({ kind: 'entity', entityType: 'person', name: 'Dana Secret', pinned: true, sensitive: true });
const ctx = await handlers.getContext({ include: ['people'] });
rec('EN6. pinned entity surfaces in getContext PEOPLE', ctx.includes('PEOPLE & PROJECTS') && ctx.includes('Alice Rivera'), `hasPeople=${ctx.includes('PEOPLE & PROJECTS')}`);
rec('EN7. non-pinned entity NOT in getContext (pinned-only)', !ctx.includes('Carl Unpinned'), `leaked=${ctx.includes('Carl Unpinned')}`);
rec('EN8. pinned-but-sensitive entity EXCLUDED from getContext', !ctx.includes('Dana Secret'), `leaked=${ctx.includes('Dana Secret')}`);

// ── link + dossier ──
const lk = await handlers.link({ entity: 'Mycelium', entityType: 'project', type: 'message', id: 'm-123' });
rec('EN9. link find-or-creates entity + links the item', /Linked project "Mycelium" to message m-123/.test(lk), lk);
const lk2 = await handlers.link({ entity: 'Mycelium', entityType: 'project', type: 'message', id: 'm-123' });
rec('EN10. link is idempotent (already linked)', /already linked/.test(lk2), lk2);
const dossier = await handlers.searchMindscape({ scope: 'entities', query: 'Mycelium' });
rec('EN11. scope:entities dossier shows the linked item', dossier.includes('project: Mycelium') && dossier.includes('message:m-123'), dossier.split('\n').slice(0, 2).join(' / '));

// ── forget an entity (soft-redact + links dropped) ──
const fOut = await handlers.forget({ type: 'entity', id: alice.id });
rec('EN12. forget reports success', /Forgotten: entity/.test(fOut), fOut);
const husk = rawDb.prepare('SELECT name, forgotten_at, type FROM entities WHERE id = ?').get(alice.id);
rec('EN13. name nulled + forgotten_at stamped; husk (id/type) persists', rawName(alice.id) == null && !!husk?.forgotten_at && husk?.type === 'person', `name=${rawName(alice.id)} forgotten=${!!husk?.forgotten_at}`);
const ctx2 = await handlers.searchMindscape({ scope: 'entities', query: 'Alice' });
rec('EN14. forgotten entity gone from listing', !ctx2.includes('Alice Rivera'), `present=${ctx2.includes('Alice Rivera')}`);
let evs = [];
try { evs = await db.audit.recent({ eventType: 'forget' }); } catch {}
const ev = evs.find((e) => e.method === alice.id);
rec('EN15. forget audited with hash, NO plaintext name', !!ev && /[0-9a-f]{64}/.test(ev.details || '') && !(ev.details || '').includes('Rivera') && ev.endpoint === 'entity', `details=${ev?.details}`);

// ── NLP promotion (seed messages.entities as enrichment would) ──
// "Acme Corp" appears in 3 messages (>= threshold), "Onceword" in 1 (< threshold).
await db.messages.insert([
  { id: 'em1', user_id: U, role: 'user', content: 'a', scope: 'personal', created_at: '2026-06-02T10:00:00.000Z', entities: JSON.stringify({ proper: ['Acme Corp'] }) },
  { id: 'em2', user_id: U, role: 'user', content: 'b', scope: 'personal', created_at: '2026-06-02T10:01:00.000Z', entities: JSON.stringify({ proper: ['Acme Corp', 'Onceword'] }) },
  { id: 'em3', user_id: U, role: 'user', content: 'c', scope: 'personal', created_at: '2026-06-02T10:02:00.000Z', entities: JSON.stringify({ proper: ['Acme Corp'] }) },
]);
// A pre-existing USER-curated entity at the SAME (type,name) the promoter will hit.
await db.entities.upsert({ userId: U, type: 'proper', name: 'Acme Corp', summary: 'user-owned note', source: 'user' });
const promo = await db.entities.promoteFromMessages({ userId: U, minMentions: 3 });
rec('EN16. promote: frequent proper noun promoted, rare skipped', promo.promoted === 1 && promo.skipped >= 1, JSON.stringify(promo));
const acme = (await db.entities.list({ userId: U, type: 'proper' })).find((e) => e.name === 'Acme Corp');
rec('EN17. promote MERGES into the user entity (no downgrade; summary kept; mentions bumped)', acme?.source === 'user' && acme?.summary === 'user-owned note' && acme?.mention_count === 3, `source=${acme?.source} summary=${acme?.summary} mentions=${acme?.mention_count}`);

// ── fail-closed ──
let noName = false;
try { await handlers.remember({ kind: 'entity', entityType: 'person', name: '  ' }); } catch { noName = true; }
rec('EN18. remember(entity) without name fails closed', noName, noName ? 'threw' : 'did NOT throw');
let noEntity = false;
try { await handlers.link({ type: 'message', id: 'x' }); } catch { noEntity = true; }
rec('EN19. link without entity fails closed', noEntity, noEntity ? 'threw' : 'did NOT throw');

rawDb.close();
close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — entities: encrypted-at-rest, app-dedup, pinned-gated, linked/dossier, forgotten, NLP-promoted (no-clobber)' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
