// verify:describe-gating — description management (DESCRIBE-MANAGEMENT-DESIGN-2026-06-11).
// Proves the naming pass's input-signature gate end-to-end with REAL child runs of
// pipeline/describe-clusters.js against a stub Ollama (/api/chat) so narration is
// deterministic and the INFERENCE CALL COUNT is the assertion:
//   G1 first run narrates (calls=2: realm+territory), writes names + describe_input_hash
//   G2 unchanged data → 0 calls (hash skip); realm counts still refreshed
//   G3 new message → signature changes → re-narrates; hash updated
//   G4 model DEAD + named cluster → clobber guard: name preserved (no placeholder)
//   G5 model DEAD + unnamed cluster → placeholder, hash NULL → model back → retried
//   G6 hash plaintext (64-hex) at rest; name ciphertext at rest
//   G7 cluster.py chronicle inheritance: statements present + SQL simulation
//      (copies ciphertext story to chronicle-less successor; never overwrites)
//   G8 jobs.js wiring: search refresh + chronicle single-flight present
// PASS/FAIL ledger; VERDICT GO/NO-GO.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';

const DB = 'data/verify-describe-gating.db', KCV = 'data/verify-describe-gating-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };

const userHex = crypto.randomBytes(32).toString('hex');
const systemHex = crypto.randomBytes(32).toString('hex');
const U = 'local-user';

// ── Stub Ollama: native /api/chat, counts calls, returns valid describe JSON. ──
let calls = 0;
// Drain the request body BEFORE responding — with keep-alive, unread body bytes
// poison the next request on the socket (first call answers, second wedges).
const ollamaStub = (reply) => (req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    // /api/show = the model-profile probe (num_ctx sizing in createNarrator), NOT a
    // narration call — don't count it; answer benignly so resolveModelProfile fails
    // soft to the registry. Only /api/chat requests are narration calls.
    if (/\/api\/show$/.test(req.url || '')) { res.end('{}'); return; }
    calls += 1;
    res.end(JSON.stringify({ message: { content: reply } }));
  });
};
const stub = createServer(ollamaStub('{"name":"Stub Cluster","essence":"a stubbed essence"}'));
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const PORT = stub.address().port;

// ── Seed vault: realm 0 / territory 1 with 2 messages; active stub provider. ──
{
  const d0 = new Database(DB);
  applyMigrations(d0);
  d0.close();
}
let { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null });
const msg = (id, content, ts) => db.rawQuery(
  `INSERT INTO messages (id, user_id, content, created_at) VALUES (?, ?, ?, ?)`, [id, U, content, ts]);
const cp = (mid, realm, terr) => db.rawQuery(
  `INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id)
   VALUES (?, ?, 'message', ?, ?, ?)`, [`cp-${mid}`, U, mid, realm, terr]);
await msg('m1', 'thinking about mushrooms', '2026-06-01T10:00:00Z'); await cp('m1', 0, 1);
await msg('m2', 'mycelium networks are wild', '2026-06-02T10:00:00Z'); await cp('m2', 0, 1);
const provId = await db.providers.create(U, { provider: 'custom', label: 'stub', authType: 'api_key', baseUrl: `http://127.0.0.1:${PORT}/v1` });
await db.providers.setActive(provId, U);
close();

const env = { ...process.env, USER_MASTER: userHex, SYSTEM_KEY: systemHex, MYCELIUM_DB: DB, MYCELIUM_USER_ID: U };
// ASYNC spawn, not spawnSync: the stub Ollama lives in THIS process — spawnSync
// blocks the event loop, the stub can never answer the child, and every run
// wedges to the kill timeout (cost one debugging round; don't repeat it).
const runDescribe = () => new Promise((resolve) => {
  const child = spawn('node', ['pipeline/describe-clusters.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120_000);
  child.on('close', (status) => { clearTimeout(t); resolve({ status, stderr }); });
  child.on('error', () => { clearTimeout(t); resolve({ status: -1, stderr }); });
});

const reopen = async () => { const b = await boot({ dbPath: DB, kcvPath: KCV, userHex, systemHex, embedder: null }); db = b.db; close = b.close; };
const row = async (sql, p) => ((await db.rawQuery(sql, p)).results || [])[0];

// ── G1: first run narrates + writes hashes ──
calls = 0;
const r1 = await runDescribe();
await reopen();
const realm1 = await row(`SELECT name, describe_input_hash, message_count FROM realms WHERE user_id = ? AND realm_id = 0`, [U]);
const terr1 = await row(`SELECT name, describe_input_hash FROM territory_profiles WHERE user_id = ? AND territory_id = 1`, [U]);
rec('G1. first run: exit 0, 2 narration calls, names + input hashes written',
  r1.status === 0 && calls === 2 && realm1?.name === 'Stub Cluster' && terr1?.name === 'Stub Cluster'
  && /^[0-9a-f]{64}$/.test(realm1?.describe_input_hash || '') && /^[0-9a-f]{64}$/.test(terr1?.describe_input_hash || ''),
  `exit=${r1.status} calls=${calls} realmHash=${(realm1?.describe_input_hash || '').slice(0, 8)}…`);

// ── G2: unchanged data → zero calls; counts still refreshed on the skip path ──
await db.rawQuery(`UPDATE realms SET message_count = 999, territory_count = 999 WHERE user_id = ? AND realm_id = 0`, [U]);
close();
calls = 0;
const r2 = await runDescribe();
await reopen();
const realm2 = await row(`SELECT message_count, territory_count FROM realms WHERE user_id = ? AND realm_id = 0`, [U]);
rec('G2. unchanged input: 0 narration calls (hash skip); realm counts re-derived (999→real)',
  r2.status === 0 && calls === 0 && Number(realm2?.message_count) === 2 && Number(realm2?.territory_count) === 1,
  `calls=${calls} mc=${realm2?.message_count} tc=${realm2?.territory_count}`);

// ── G3: new message → signature drift → re-narrates ──
await msg('m3', 'fresh thought lands', '2026-06-03T10:00:00Z'); await cp('m3', 0, 1);
close();
calls = 0;
const r3 = await runDescribe();
await reopen();
const realm3 = await row(`SELECT describe_input_hash FROM realms WHERE user_id = ? AND realm_id = 0`, [U]);
rec('G3. content changed: signature differs → re-narrated (2 calls), hash rotated',
  r3.status === 0 && calls === 2 && realm3?.describe_input_hash !== realm1?.describe_input_hash,
  `calls=${calls}`);

// ── G4+G5 seed: a brand-new unnamed cluster, then kill the model ──
await msg('m4', 'entirely new region', '2026-06-04T10:00:00Z'); await cp('m4', 7, 9);
close();
stub.close();
const r4 = await runDescribe();
await reopen();
const realm4 = await row(`SELECT name FROM realms WHERE user_id = ? AND realm_id = 0`, [U]);
const realm7 = await row(`SELECT name, describe_input_hash FROM realms WHERE user_id = ? AND realm_id = 7`, [U]);
rec('G4. model dead: named realm keeps its real name (no placeholder clobber)',
  r4.status === 0 && realm4?.name === 'Stub Cluster', `name=${realm4?.name}`);
rec('G5a. model dead: unnamed realm gets placeholder with NULL hash (retry-eligible)',
  realm7?.name === 'Realm 7' && realm7?.describe_input_hash == null,
  `name=${realm7?.name} hash=${realm7?.describe_input_hash}`);

// Model back → ONLY the placeholder retries; new-message clusters re-sig anyway.
calls = 0;
const stub2 = createServer(ollamaStub('{"name":"Recovered Name","essence":"recovered"}'));
await new Promise((r) => stub2.listen(PORT, '127.0.0.1', r)); // same port — provider row unchanged
close();
const r5 = await runDescribe();
await reopen();
const realm7b = await row(`SELECT name, describe_input_hash FROM realms WHERE user_id = ? AND realm_id = 7`, [U]);
rec('G5b. model recovered: placeholder retried + renamed, hash now written; named clusters skipped',
  r5.status === 0 && realm7b?.name === 'Recovered Name' && /^[0-9a-f]{64}$/.test(realm7b?.describe_input_hash || '') && calls === 2,
  `name=${realm7b?.name} calls=${calls} (1 realm + 1 territory of the new region)`);

// ── G6: hash plaintext; realm name PLAINTEXT-in-cipher (SQLCipher collapse cut 1)
// — the narrated name is no longer field-encrypted; at-rest confidentiality is
// whole-file SQLCipher (verify:at-rest). describe_input_hash stays plaintext
// 64-hex (the gating key). Assert the name is stored plaintext (not a wrapped-DEK
// envelope), proving the stop-write worked. ──
close();
const raw = new Database(DB, { readonly: true });
const rawRealm = raw.prepare(`SELECT name, describe_input_hash FROM realms WHERE realm_id = 0`).get();
raw.close();
const isEnvelope = (v) => { if (typeof v !== 'string' || v.length < 20 || !v.startsWith('ey')) return false; try { const o = JSON.parse(Buffer.from(v, 'base64').toString('utf8')); return !!(o.v && o.s && o.iv && o.ct && o.dk); } catch { return false; } };
rec('G6. describe_input_hash plaintext 64-hex; realm name PLAINTEXT-in-cipher (collapse: narrative not field-encrypted)',
  /^[0-9a-f]{64}$/.test(rawRealm?.describe_input_hash || '') && typeof rawRealm?.name === 'string'
  && !isEnvelope(rawRealm.name),
  `hash=${(rawRealm?.describe_input_hash || '').slice(0, 8)}… name=${rawRealm?.name}`);

// ── G7: cluster.py chronicle inheritance — statements present + SQL simulation ──
const py = readFileSync('pipeline/cluster.py', 'utf8');
const hasGuardedSelect = py.includes('AND description_version IS NOT NULL');
const hasGuardedUpdate = py.includes('AND description_version IS NULL');
const hasColList = py.includes("_CHRONICLE_COLS");
rec('G7a. cluster.py carries the guarded inheritance statements this gate mirrors',
  hasGuardedSelect && hasGuardedUpdate && hasColList);

await reopen();
// Dissolved predecessor T100 WITH chronicle; successor T200 without; bystander T300 with its OWN chronicle.
await db.rawQuery(`INSERT INTO territory_profiles (user_id, territory_id, name, story_birth, description_version, point_count_at_description, dissolved_at) VALUES (?, 100, ?, ?, ?, 42, '2026-06-11')`, [U, 'Old Land', 'born of long walks', 'chronicle-v1']);
await db.rawQuery(`INSERT INTO territory_profiles (user_id, territory_id, name) VALUES (?, 200, ?)`, [U, 'New Land']);
await db.rawQuery(`INSERT INTO territory_profiles (user_id, territory_id, name, story_birth, description_version) VALUES (?, 300, ?, ?, ?)`, [U, 'Own Land', 'its own story', 'chronicle-v1']);
const COLS = ['story_birth', 'description_version', 'point_count_at_description'];
const simulateInherit = async (oldId, newId) => {
  const pred = ((await db.rawQuery(
    `SELECT ${COLS.join(', ')} FROM territory_profiles WHERE territory_id = ? AND user_id = ? AND description_version IS NOT NULL`, [oldId, U])).results || [])[0];
  if (!pred) return;
  // mirror cluster.py: write the STORED values back verbatim — but here we read
  // through the adapter (decrypted), so re-encryption happens on write; the
  // Python path copies ciphertext verbatim. Both end decryptable — G7b asserts that.
  await db.rawQuery(
    `UPDATE territory_profiles SET ${COLS.map((c) => `${c} = ?`).join(', ')} WHERE territory_id = ? AND user_id = ? AND description_version IS NULL`,
    [...COLS.map((c) => pred[c]), newId, U]);
};
await simulateInherit(100, 200);
await simulateInherit(100, 300); // must NOT overwrite T300's own chronicle
const t200 = await row(`SELECT story_birth, description_version, point_count_at_description FROM territory_profiles WHERE user_id = ? AND territory_id = 200`, [U]);
const t300 = await row(`SELECT story_birth FROM territory_profiles WHERE user_id = ? AND territory_id = 300`, [U]);
rec('G7b. successor without chronicle inherits story+version+pcad; own chronicle never overwritten',
  t200?.story_birth === 'born of long walks' && t200?.description_version === 'chronicle-v1' && Number(t200?.point_count_at_description) === 42
  && t300?.story_birth === 'its own story',
  `t200.story=${t200?.story_birth} t300.story=${t300?.story_birth}`);
close();

// ── G8: jobs.js wiring (behavioral coverage lives in verify:generate) ──
const jobs = readFileSync('src/jobs.js', 'utf8');
rec('G8. jobs.js: search refresh on Generate + chronicle completion; chronicle single-flight',
  jobs.includes('refreshSearchIndex()') && jobs.includes('getMindSearch()?.rebuild()') && jobs.includes('chronicleChildRunning'));

stub2.close();
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — describe gating: skip-unchanged, clobber-proof, retry-on-placeholder, inheritance' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
