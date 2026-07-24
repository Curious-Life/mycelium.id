// verify:illuminate-naming — the cluster-NAMING job (DISTILLATION-SURFACE-DESIGN §3a/§8 unit 1).
//
// WHY THIS EXISTS: pipeline/describe-clusters.js is the ONLY writer of realm/territory
// name+essence, and it was reachable only INSIDE Generate's step 3/16 — which the
// /mycelium/generate debounce skips whenever topology exists. So on any vault with a map, an
// unnamed realm could NEVER be named, and "Illuminate" (wired to generate) was a dead button
// (§2/§3). This gate proves the missing trigger: startClusterNamingJob spawns describe-clusters
// in gap-fill mode, NAMES the unnamed (incl. placeholders — D10), PRESERVES real names, is
// idempotent, refuses honestly with no inference when no model is approved (consent), and
// classifies a failed pass as a content-free feed error.
//
// METHOD: like verify:describe-gating, drive the REAL child (node describe-clusters.js) with the
// EXACT env the job sets (MYCELIUM_DESCRIBE_PRESERVE=1) against a stub Ollama, and count the
// INFERENCE CALLS — the assertion is behavioral, not a source grep. The job WRAPPER is driven
// directly (startClusterNamingJob) with a fake capture/sleeper script to pin its env allowlist +
// PRESERVE flag + single-flight. Every check is falsified by mutating the source (see the PR).
import Database from 'better-sqlite3';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { reportChild } from './lib/child-stderr.mjs';
import { stripCommentsFor } from './lib/strip-comments.mjs';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { join } from 'node:path';
import { boot } from '../src/index.js';
import { startRestServer } from '../src/server-rest.js';
import { applyMigrations } from '../src/db/migrate.js';
import { startClusterNamingJob, _resetClusterNaming } from '../src/jobs.js';
import { setSessionKeys, clearSessionKeys } from '../src/account/session-keys.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const U = 'local-user';
const SECRET = 'MUSHROOMSECRET_do_not_leak';      // seeded into message content; must never reach the feed
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dataDir = 'data';
mkdirSync(dataDir, { recursive: true });

// ── Stub Ollama: native /api/chat, counts calls, returns a name. `reply` may be a function of
//    the request count so a later run can return a DIFFERENT name (proves no re-narration). ──
let calls = 0;
function makeStub(reply, { failStatus = 0 } = {}) {
  return createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (/\/api\/show$/.test(req.url || '')) { res.end('{}'); return; }   // model-profile probe — not a narration call
      calls += 1;
      if (failStatus) { res.statusCode = failStatus; res.end('{"error":"boom"}'); return; }
      res.end(JSON.stringify({ message: { content: typeof reply === 'function' ? reply(calls) : reply } }));
    });
  });
}
async function listen(server, port = 0) { await new Promise((r) => server.listen(port, '127.0.0.1', r)); return server.address().port; }

// ── Run describe-clusters.js as a CHILD with the EXACT env the naming job sets (PRESERVE=1). ──
function runNamingChild(dbPath, userHex, systemHex, { clean = false } = {}) {
  const env = {
    ...(clean ? { PATH: process.env.PATH, HOME: process.env.HOME } : process.env),
    USER_MASTER: userHex, SYSTEM_KEY: systemHex, MYCELIUM_DB: dbPath, MYCELIUM_USER_ID: U,
    MYCELIUM_DESCRIBE_PRESERVE: '1',   // ← what startClusterNamingJob sets (gap-fill)
  };
  if (clean) { delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY; delete env.INFERENCE_BASE_URL; }
  return new Promise((resolve) => {
    const child = spawn('node', ['pipeline/describe-clusters.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120_000);
    let fired = false;
    const done = (status) => { if (fired) return; fired = true; clearTimeout(t); reportChild('describe-clusters.js', status, stderr); resolve({ status, stderr }); };
    child.on('close', done);
    child.on('error', () => done(-1));
  });
}

// =====================================================================================
// PART A — SEMANTICS: names the unnamed (D10) · preserves real names · idempotent
// =====================================================================================
const DBA = `${dataDir}/verify-illuminate-naming-A.db`, KCVA = `${dataDir}/verify-illuminate-naming-A-kcv.json`;
for (const f of [DBA, KCVA, `${DBA}-shm`, `${DBA}-wal`]) { try { rmSync(f); } catch {} }
const uA = crypto.randomBytes(32).toString('hex'), sA = crypto.randomBytes(32).toString('hex');
{ const d = new Database(DBA); applyMigrations(d); d.close(); }
const stubA = makeStub((n) => n <= 100 ? '{"name":"Stub Cluster","essence":"a stubbed essence"}' : '{}');
const portA = await listen(stubA);
{
  const { db, close } = await boot({ dbPath: DBA, kcvPath: KCVA, userHex: uA, systemHex: sA, embedder: null });
  const q = (sql, p = []) => db.rawQuery(sql, p);
  const seed = async (mid, content, realm, terr, ts) => {
    await q(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`, [mid, U, content, ts]);
    await q(`INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id) VALUES (?,?,'message',?,?,?)`, [`cp-${mid}`, U, mid, realm, terr]);
  };
  await seed('a1', `${SECRET} reflecting on realm zero`, 0, 1, '2026-06-01T10:00:00Z');
  await seed('a2', `${SECRET} more about realm zero`, 0, 1, '2026-06-02T10:00:00Z');
  await seed('a3', `${SECRET} a lone thought in realm seven`, 7, 9, '2026-06-03T10:00:00Z');
  const provId = await db.providers.create(U, { provider: 'custom', label: 'stub', authType: 'api_key', model: 'stub-model', baseUrl: `http://127.0.0.1:${portA}/v1` });
  await db.providers.setActive(provId, U);
  close();
}
// Run 1: bootstrap — everything unnamed → all narrated (real names + hashes).
await runNamingChild(DBA, uA, sA);
// Turn realm 7's REAL name back into a PLACEHOLDER while KEEPING its (matching) input hash — the
// exact D10 adversarial fixture: a placeholder that carries a hash equal to the current signature.
{
  const { db, close } = await boot({ dbPath: DBA, kcvPath: KCVA, userHex: uA, systemHex: sA, embedder: null });
  await db.rawQuery(`UPDATE realms SET name='Realm 7' WHERE user_id=? AND realm_id=7`, [U]);
  const r0 = ((await db.rawQuery(`SELECT name, describe_input_hash FROM realms WHERE user_id=? AND realm_id=0`, [U])).results || [])[0];
  const r7 = ((await db.rawQuery(`SELECT name, describe_input_hash FROM realms WHERE user_id=? AND realm_id=7`, [U])).results || [])[0];
  rec('SETUP. run-1 named both realms; realm 7 reverted to placeholder with its matching hash kept',
    r0?.name === 'Stub Cluster' && r7?.name === 'Realm 7' && /^[0-9a-f]{64}$/.test(r7?.describe_input_hash || ''),
    `r0=${r0?.name} r7=${r7?.name} r7hash=${(r7?.describe_input_hash || '').slice(0, 8)}…`);
  close();
}
// Swap the stub so run-2 returns a DIFFERENT name — anything re-narrated becomes "Recovered Name".
stubA.close();
const stubA2 = makeStub((n) => n <= 100 ? '{"name":"Recovered Name","essence":"recovered"}' : '{}');
await listen(stubA2, portA);
calls = 0;
await runNamingChild(DBA, uA, sA);      // run 2: the naming pass
const run2Calls = calls;
{
  const { db, close } = await boot({ dbPath: DBA, kcvPath: KCVA, userHex: uA, systemHex: sA, embedder: null });
  const r0 = ((await db.rawQuery(`SELECT name FROM realms WHERE user_id=? AND realm_id=0`, [U])).results || [])[0];
  const r7 = ((await db.rawQuery(`SELECT name, describe_input_hash FROM realms WHERE user_id=? AND realm_id=7`, [U])).results || [])[0];
  rec('N1. ⭐ D10: a PLACEHOLDER realm with a MATCHING hash is RE-NAMED (not skipped)',
    r7?.name === 'Recovered Name' && /^[0-9a-f]{64}$/.test(r7?.describe_input_hash || ''),
    `realm7 name=${r7?.name} (was "Realm 7"; a namer that skips its placeholders is the same silent no-op one layer down)`);
  rec('N2. a REAL name with a matching hash is PRESERVED (untouched — never re-narrated)',
    r0?.name === 'Stub Cluster',
    `realm0 name=${r0?.name} (run-2 stub returns "Recovered Name"; unchanged ⇒ it was not re-narrated)`);
  rec('N3. the pass narrated ONLY the placeholder — real names cost 0 inference calls',
    run2Calls === 1, `run-2 inference calls=${run2Calls} (expected 1: realm 7 only)`);
  close();
}
// Run 3: idempotence — everything is now really named with matching hashes → 0 calls.
calls = 0;
await runNamingChild(DBA, uA, sA);
rec('N4. idempotent: a second naming pass over a fully-named vault runs NO inference', calls === 0, `run-3 calls=${calls}`);
stubA2.close();

// =====================================================================================
// PART B — CONSENT: no approved model ⇒ refuse honestly, ZERO inference, content-free feed error
// =====================================================================================
const DBB = `${dataDir}/verify-illuminate-naming-B.db`, KCVB = `${dataDir}/verify-illuminate-naming-B-kcv.json`;
for (const f of [DBB, KCVB, `${DBB}-shm`, `${DBB}-wal`]) { try { rmSync(f); } catch {} }
const uB = crypto.randomBytes(32).toString('hex'), sB = crypto.randomBytes(32).toString('hex');
{ const d = new Database(DBB); applyMigrations(d); d.close(); }
const stubB = makeStub('{"name":"SHOULD NOT RUN","essence":"x"}');   // present ONLY to catch an unexpected call
await listen(stubB);
{
  const { db, close } = await boot({ dbPath: DBB, kcvPath: KCVB, userHex: uB, systemHex: sB, embedder: null });
  await db.rawQuery(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`, ['b1', U, `${SECRET} private thought`, '2026-06-01T10:00:00Z']);
  await db.rawQuery(`INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id) VALUES (?,?,'message',?,?,?)`, ['cp-b1', U, 'b1', 0, 1]);
  close();   // NO provider created, NO on-box model approved ⇒ createNarrator must refuse
}
calls = 0;
await runNamingChild(DBB, uB, sB, { clean: true });   // clean env: no cloud keys ⇒ nothing to fall back to
{
  const { db, close } = await boot({ dbPath: DBB, kcvPath: KCVB, userHex: uB, systemHex: sB, embedder: null });
  const feed = ((await db.rawQuery(`SELECT status, stage_label, error FROM background_jobs WHERE user_id=? AND kind='describe:name' ORDER BY started_at DESC LIMIT 1`, [U])).results || [])[0];
  const blob = `${feed?.stage_label || ''} ${feed?.error || ''}`;
  rec('N5. consent: no approved model ⇒ ZERO inference calls (the classifier never ran)', calls === 0, `stub /api/chat calls=${calls}`);
  rec('N5b. …and it REFUSES honestly — a describe:name feed row ends `error` with an actionable, content-free reason',
    feed?.status === 'error' && /approve|Intelligence/i.test(feed?.error || '') && !blob.includes(SECRET) && !/realm\s+\d+/i.test(blob),
    `status=${feed?.status} stage=${feed?.stage_label} error=${(feed?.error || '').slice(0, 60)}…`);
  close();
}
stubB.close();

// =====================================================================================
// PART C — FAILURE CLASSIFICATION: a failing pipeline ⇒ content-free `error` feed row
// =====================================================================================
const DBC = `${dataDir}/verify-illuminate-naming-C.db`, KCVC = `${dataDir}/verify-illuminate-naming-C-kcv.json`;
for (const f of [DBC, KCVC, `${DBC}-shm`, `${DBC}-wal`]) { try { rmSync(f); } catch {} }
const uC = crypto.randomBytes(32).toString('hex'), sC = crypto.randomBytes(32).toString('hex');
{ const d = new Database(DBC); applyMigrations(d); d.close(); }
const stubC = makeStub('{}', { failStatus: 500 });   // every /api/chat 500s ⇒ narrator.infer throws ⇒ describe() returns null for all
const portC = await listen(stubC);
{
  const { db, close } = await boot({ dbPath: DBC, kcvPath: KCVC, userHex: uC, systemHex: sC, embedder: null });
  await db.rawQuery(`INSERT INTO messages (id, user_id, content, created_at) VALUES (?,?,?,?)`, ['c1', U, `${SECRET} a thought`, '2026-06-01T10:00:00Z']);
  await db.rawQuery(`INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id) VALUES (?,?,'message',?,?,?)`, ['cp-c1', U, 'c1', 0, 1]);
  const provId = await db.providers.create(U, { provider: 'custom', label: 'stub', authType: 'api_key', model: 'stub-model', baseUrl: `http://127.0.0.1:${portC}/v1` });
  await db.providers.setActive(provId, U);
  close();
}
await runNamingChild(DBC, uC, sC);
{
  const { db, close } = await boot({ dbPath: DBC, kcvPath: KCVC, userHex: uC, systemHex: sC, embedder: null });
  const feed = ((await db.rawQuery(`SELECT status, stage_label, error FROM background_jobs WHERE user_id=? AND kind='describe:name' ORDER BY started_at DESC LIMIT 1`, [U])).results || [])[0];
  const r0 = ((await db.rawQuery(`SELECT name FROM realms WHERE user_id=? AND realm_id=0`, [U])).results || [])[0];
  const blob = `${feed?.stage_label || ''} ${feed?.error || ''}`;
  rec('N6. ⭐ every narration failed ⇒ the describe:name feed row is `error`, CONTENT-FREE (no message text, no realm name)',
    feed?.status === 'error' && !blob.includes(SECRET) && !new RegExp(SECRET).test(feed?.stage_label || ''),
    `status=${feed?.status} stage=${feed?.stage_label} error=${JSON.stringify(feed?.error)} realm0=${r0?.name}`);
  close();
}
stubC.close();

// =====================================================================================
// PART W — the JOB WRAPPER: env allowlist + PRESERVE flag + single-flight (driven directly)
// =====================================================================================
const DBW = `${dataDir}/verify-illuminate-naming-W.db`;
for (const f of [DBW, `${DBW}.capture.json`]) { try { rmSync(f); } catch {} }
writeFileSync(DBW, 'x');   // a real file so the disk guard (assertVaultDiskHeadroom) resolves
const capScript = path.resolve(`${dataDir}/verify-illuminate-naming-capture.mjs`);
writeFileSync(capScript, `import { writeFileSync } from 'node:fs';
const e = process.env;
writeFileSync(e.MYCELIUM_DB + '.capture.json', JSON.stringify({
  preserve: e.MYCELIUM_DESCRIBE_PRESERVE ?? null,
  hasUserKey: !!e.USER_MASTER, hasSysKey: !!e.SYSTEM_KEY,
  db: e.MYCELIUM_DB ?? null, user: e.MYCELIUM_USER_ID ?? null,
  leakedAmbient: e.MYCELIUM_GATE_AMBIENT ?? null,   // must be null: the childEnv is an ALLOWLIST
}));
`);
const sleepScript = path.resolve(`${dataDir}/verify-illuminate-naming-sleep.mjs`);
writeFileSync(sleepScript, `setTimeout(() => process.exit(0), 400);\n`);

const uW = crypto.randomBytes(32).toString('hex'), sW = crypto.randomBytes(32).toString('hex');
setSessionKeys({ userHex: uW, systemHex: sW });     // so getSessionKeys() supplies the child keys
process.env.MYCELIUM_GATE_AMBIENT = 'leak-me';       // an ambient var that must NOT reach the child

// W1 — env allowlist + PRESERVE flag
_resetClusterNaming();
process.env.MYCELIUM_NAMING_SCRIPT = capScript;
const w1 = startClusterNamingJob({ dbPath: DBW, userId: U });
for (let i = 0; i < 50 && !existsSync(`${DBW}.capture.json`); i++) await sleep(40);
let cap = {};
try { cap = JSON.parse(readFileSync(`${DBW}.capture.json`, 'utf8')); } catch {}
rec('W1. the job spawns with PRESERVE=1, both re-resolved keys in the child env, and an ALLOWLIST (no ambient leak)',
  w1?.pid != null && cap.preserve === '1' && cap.hasUserKey === true && cap.hasSysKey === true && cap.db === DBW && cap.user === U && cap.leakedAmbient === null,
  `pid=${w1?.pid} preserve=${cap.preserve} keys=${cap.hasUserKey}/${cap.hasSysKey} ambientLeak=${JSON.stringify(cap.leakedAmbient)}`);

// W2 — single-flight: a 2nd start while the first child runs is rejected; clears after it exits
_resetClusterNaming();
process.env.MYCELIUM_NAMING_SCRIPT = sleepScript;
const first = startClusterNamingJob({ dbPath: DBW, userId: U });
const second = startClusterNamingJob({ dbPath: DBW, userId: U });   // should be rejected (latch held)
rec('W2a. single-flight: a 2nd start while a naming pass runs is rejected (pid null)',
  first?.pid != null && second?.pid == null, `first.pid=${first?.pid} second.pid=${second?.pid}`);
await sleep(900);   // the sleeper (400ms) has exited → the close handler cleared the latch
const third = startClusterNamingJob({ dbPath: DBW, userId: U });
rec('W2b. …and the latch CLEARS on close — a later pass can start', third?.pid != null, `third.pid=${third?.pid}`);
await sleep(600);   // let the third sleeper exit cleanly

clearSessionKeys();
delete process.env.MYCELIUM_GATE_AMBIENT; delete process.env.MYCELIUM_NAMING_SCRIPT;

// =====================================================================================
// PART S — SOURCE wiring: the route calls the job; the button POSTs it, not generate
// =====================================================================================
{
  const routeSrc = readFileSync('src/portal-mindscape.js', 'utf8');
  rec('S1. POST /mycelium/name-clusters is registered and calls startClusterNamingJob',
    /router\.post\(\s*['"]\/mycelium\/name-clusters['"]/.test(routeSrc) && /startClusterNamingJob\(/.test(routeSrc));

  // The button wiring (§3a "Illuminate → this, not generate"). SOURCE assert with comments stripped
  // as REGIONS (a block-comment line survives a prefix filter) — the same honest reach as
  // verify:generate-phase D2: it catches a repoint/deletion, not an open set of dead-coding.
  const MD = 'portal-app/src/lib/components/mindscape/MindscapeDetail.svelte';
  const raw = readFileSync(MD, 'utf8');
  // ONE lexical stripper (scripts/lib/strip-comments.mjs), not a regex chain: the chain
  // could not tell a comment from a string, so prose could satisfy a positive assert
  // (`"x"// …` survived it) and a `/*` inside a string could DELETE live code and satisfy
  // a negative one (S3 below is exactly that shape). Gated by verify:strip-comments.
  const code = stripCommentsFor(MD, raw);
  // NB: apiPost carries a TS generic here (apiPost<{…}>(…)) — match the route string + the fn,
  // not `apiPost(`. The only name-clusters POST in this file is illuminateRealms (describeTerritory
  // posts describe-more), so the string presence pins the wiring.
  rec('S2. Illuminate POSTs /mycelium/name-clusters',
    /['"]\/portal\/mycelium\/name-clusters['"]/.test(code) && /function illuminateRealms/.test(code) && /illuminateRealms[\s\S]{0,400}name-clusters/.test(code));
  rec('S3. …and NO LONGER calls generate — the whole "does nothing" bug (its render condition was the route\'s skip condition)',
    !/startGenerate/.test(code) && !/illuminateRealms\(\)\s*\{\s*void start/.test(code),
    'illuminate must not drive generate; generate re-clusters and its debounce skips whenever topology exists');
}

// =====================================================================================
// PART D — D-004 ↻1: the OTHER naming path must not be starved by the Generate debounce
// =====================================================================================
// This gate's own header states the mechanism: describe-clusters.js is the ONLY writer of
// realm/territory name+essence, and inside Generate it is step 3/16 — the step the debounce
// skipped. Part W/S above proved the ESCAPE HATCH (/mycelium/name-clusters) works. This part
// proves the PRIMARY path is reachable again, which is the operator's symptom 3 verbatim:
//   "the cluster names dont show, they say territory 2 etc.... not the actual name"
// Territory {id} / Realm {id} is the NULL-name fallback (src/portal-measurement.js:1133) —
// the names were never WRITTEN, because the only writer sat behind a skip with no staleness
// condition.
//
// BEHAVIOURAL, end to end: a real REST server, a STALE map (many embedded messages, few
// mapped points), a clustering script standing in for the pipeline that runs the REAL
// describe-clusters.js child against a stub model — then assert the realm ACTUALLY GOT A
// NAME. A source grep would not have caught this; the pre-fix predicate REDs it.
//
// MUTATION-TESTED:
//   // MUTATION-TESTED: src/portal-mindscape.js skip predicate reverted to the pre-fix
//   //   `COUNT(clustering_points) > 0` (no staleness condition) → D1 REDs ("generate was
//   //   SKIPPED on a stale map") and D2 REDs ("realm still unnamed") — i.e. the naming
//   //   starvation is observed as an unnamed realm, not merely as a route status.
{
  const DBD = `${dataDir}/verify-illuminate-naming-D.db`, KCVD = `${dataDir}/verify-illuminate-naming-D-kcv.json`;
  for (const f of [DBD, KCVD, `${DBD}-shm`, `${DBD}-wal`]) { try { rmSync(f); } catch {} }
  const uD = crypto.randomBytes(32).toString('hex'), sD = crypto.randomBytes(32).toString('hex');
  { const d = new Database(DBD); applyMigrations(d); d.close(); }
  const stubD = makeStub('{"name":"Named By Generate","essence":"written by step 3/16"}');
  const portD = await listen(stubD);

  const EMBEDDED_D = 60;   // the vault
  const MAPPED_D = 4;      // …and the fraction of it that is on the map ⇒ STALE
  {
    const { db, close } = await boot({ dbPath: DBD, kcvPath: KCVD, userHex: uD, systemHex: sD, embedder: null });
    for (let i = 0; i < EMBEDDED_D; i++) {
      await db.rawQuery(`INSERT INTO messages (id, user_id, content, created_at, embedding_768, nlp_processed) VALUES (?,?,?,?,?,1)`,
        [`d${i}`, U, `${SECRET} a thought numbered ${i}`, '2026-06-01T10:00:00Z', Buffer.alloc(16, 1)]);
    }
    for (let i = 0; i < MAPPED_D; i++) {
      await db.rawQuery(`INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id, landscape_x, landscape_y, landscape_z) VALUES (?,?,'message',?,?,?,?,?,?)`,
        [`cp-d${i}`, U, `d${i}`, 0, 1, i * 0.1, i * 0.2, i * 0.3]);
    }
    const provId = await db.providers.create(U, { provider: 'custom', label: 'stub', authType: 'api_key', model: 'stub-model', baseUrl: `http://127.0.0.1:${portD}/v1` });
    await db.providers.setActive(provId, U);
    close();
  }

  // The clustering script stand-in: Generate's naming step, and nothing else.
  const genScript = path.resolve(`${dataDir}/verify-illuminate-naming-generate.sh`);
  writeFileSync(genScript, '#!/bin/bash\necho "Step 3/16: Describing clusters"\nexec node pipeline/describe-clusters.js\n');
  const prevScript = process.env.MYCELIUM_CLUSTER_SCRIPT;
  const prevStats = existsSync(join(dataDir, 'generate-stats.json')) ? readFileSync(join(dataDir, 'generate-stats.json'), 'utf8') : null;
  try { rmSync(join(dataDir, 'generate-stats.json')); } catch {}   // no baseline ⇒ the fallback path
  process.env.MYCELIUM_CLUSTER_SCRIPT = genScript;

  const srvD = await startRestServer({ dbPath: DBD, kcvPath: KCVD, userHex: uD, systemHex: sD, port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  try {
    const post = await fetch(`${srvD.url}/api/v1/portal/mycelium/generate`, { method: 'POST' });
    const body = await post.json().catch(() => ({}));
    rec(`D1. ⭐ a STALE map (${EMBEDDED_D} embedded / ${MAPPED_D} mapped) does NOT skip Generate — the naming step is reachable`,
      body?.status !== 'skipped' && Boolean(body?.jobId),
      `status=${body?.status} reason=${body?.reason ?? '—'} jobId=${body?.jobId ?? 'null'}`);

    for (let i = 0; i < 150; i++) {
      const st = await (await fetch(`${srvD.url}/api/v1/portal/mycelium/generate/status/${body?.jobId}`)).json().catch(() => ({}));
      if (st?.status && st.status !== 'running') break;
      await sleep(200);
    }
    const { db, close } = await boot({ dbPath: DBD, kcvPath: KCVD, userHex: uD, systemHex: sD, embedder: null });
    const r0 = ((await db.rawQuery(`SELECT name FROM realms WHERE user_id=? AND realm_id=0`, [U])).results || [])[0];
    const t1 = ((await db.rawQuery(`SELECT name FROM territory_profiles WHERE user_id=? AND territory_id=1`, [U])).results || [])[0];
    close();
    rec('D2. ⭐ …and the run ACTUALLY NAMED the clusters — no more "Territory 2" / "Realm 0" placeholders',
      r0?.name === 'Named By Generate' && t1?.name === 'Named By Generate',
      `realm0=${JSON.stringify(r0?.name)} territory1=${JSON.stringify(t1?.name)} (null ⇒ the UI renders the "Territory {id}" fallback — the reported symptom)`);
  } finally {
    srvD.server.close(); try { srvD.close?.(); } catch {}
    stubD.close();
    if (prevScript === undefined) delete process.env.MYCELIUM_CLUSTER_SCRIPT; else process.env.MYCELIUM_CLUSTER_SCRIPT = prevScript;
    if (prevStats != null) { try { writeFileSync(join(dataDir, 'generate-stats.json'), prevStats); } catch {} } else { try { rmSync(join(dataDir, 'generate-stats.json')); } catch {} }
    for (const f of [DBD, KCVD, `${DBD}-shm`, `${DBD}-wal`, genScript]) { try { rmSync(f); } catch {} }
  }
}

// ── cleanup ──
for (const f of [DBA, KCVA, `${DBA}-shm`, `${DBA}-wal`, DBB, KCVB, `${DBB}-shm`, `${DBB}-wal`,
  DBC, KCVC, `${DBC}-shm`, `${DBC}-wal`, DBW, `${DBW}.capture.json`, capScript, sleepScript]) { try { rmSync(f); } catch {} }

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(72));
console.log(`VERDICT: ${allPass ? 'GO — cluster naming has a reachable trigger: names the unnamed (D10), preserves real names, idempotent, consent-honest, failure-classified' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
