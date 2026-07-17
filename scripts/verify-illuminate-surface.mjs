// verify:illuminate-surface — the Illuminate RUN SURFACE (INTELLIGENCE-SCREEN-REDESIGN
// 2026-07-17, Part II): GET /portal/mycelium/naming-status + the naming card's lifecycle
// (BEFORE / DURING / AFTER / EMPTY / EDGE) in MindscapeDetail. Implements the doc's IL1-IL8.
//
//   IL1  one owner for percent named — the route counts with the PIPELINE'S OWN placeholder
//        predicate (shared module pipeline/lib/naming-facts.js): a seeded `Realm 7` AND a
//        seeded `Territory 3` (the wider form the portal's display regex does not know) both
//        count as UNNAMED; a missing profile row counts as unnamed; counts track DB mutations.
//   IL2  the bound is served, labeled, never summed — forecast = unnamed × the served
//        perUnitTokenBound (= the module's own derivation); the card renders THE WIRE'S number
//        with "up to ~" (an inconsistent fixture pair proves no client-side multiply).
//   IL3  the refusal is pre-empted — narrator.ready:false ⇒ the CTA is REPLACED by the muted
//        choice line; clicking every button in the card produces ZERO name-clusters POSTs.
//   IL4  DURING renders the owner — the card's numbers strictly track the activity store's
//        describe:name row (two distinct row states, n≥2 — identity, not plausibility); the
//        percent-named bar does NOT tick mid-run.
//   IL5  partial completion is visible — a done run leaving k>0 placeholders renders
//        "k couldn't be named · Try again", and Try again re-POSTs.
//   IL6  structured refusals render — busy ⇒ DURING; disk_low ⇒ the free-up-N-GB line
//        (CONTROL: running ⇒ DURING — each arm driven separately, the two-guards lesson).
//   IL7  live region — ONE persistent [aria-live] node, mounted EMPTY before any milestone,
//        same node across milestones (never inserted-with-text), no per-tick announcements.
//   IL8  content-free card — a distinctive vault name appears in the LIST (control) and in NO
//        card state's subtree. Server half: the naming-status body carries no seeded name.
//
// METHOD: the server half drives the REAL route over a REAL booted vault (startRestServer,
// like verify:portal-mindscape); the card half MOUNTS the component (real Svelte + jsdom +
// the REAL activity store — portal-app/test/mount-illuminate-card.mjs), because a source
// regex cannot prove reachability (mount-generate-render's M4 lesson). Every clause was
// falsified by mutating the source — see the PR's falsification table.
import crypto from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrate.js';
import { startRestServer } from '../src/server-rest.js';
import { isPlaceholderName, perUnitTokenBound } from '../pipeline/lib/naming-facts.js';

const DB = 'data/verify-illuminate-surface.db';
const KCV = 'data/verify-illuminate-surface-kcv.json';
const hex = () => crypto.randomBytes(32).toString('hex');
const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `\n      ${d}` : ''}`); };
const U = 'local-user';
const BOUND = perUnitTokenBound();   // the module's own derivation — the route must serve THIS

// Distinctive seeded names — must never appear in a naming-status body (§1 / IL8 server half).
const NAME_REALM = 'Alpha Quadrant SECRETXYZ';
const NAME_TERR = 'Terra Nova SECRETXYZ';

async function serverPart() {
  for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  mkdirSync('data', { recursive: true });
  { const raw = new Database(DB); applyMigrations(raw); raw.close(); }

  const srv = await startRestServer({ dbPath: DB, kcvPath: KCV, userHex: hex(), systemHex: hex(), port: 0, host: '127.0.0.1', portalMode: 'legacy' });
  const { url, db } = srv;
  const j = async (p) => { const r = await fetch(`${url}/api/v1/portal${p}`); let b = null; try { b = await r.json(); } catch {} return { status: r.status, body: b }; };
  try {
    const q = (sql, p = []) => db.rawQuery(sql, p);
    // The EXACT universe the naming job walks: DISTINCT realm ids + DISTINCT territory ids
    // from clustering_points (describe-clusters.js). Three realms (one really named, one
    // `Realm 7` placeholder WITH a row, one with NO row at all), two territories (one named,
    // one `Territory 3` placeholder — the form only the pipeline's predicate knows).
    const cp = async (id, realm, terr) => q(
      `INSERT INTO clustering_points (id, user_id, source_type, source_id, realm_id, territory_id) VALUES (?,?, 'message', ?, ?, ?)`,
      [id, U, `m-${id}`, realm, terr],
    );
    await cp('cp1', 0, 1); await cp('cp2', 7, 3); await cp('cp3', 9, null);
    await q(`INSERT INTO realms (user_id, realm_id, name, essence, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))`, [U, 0, NAME_REALM, 'e']);
    await q(`INSERT INTO realms (user_id, realm_id, name, essence, describe_input_hash, created_at, updated_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))`, [U, 7, 'Realm 7', '', 'a'.repeat(64)]);
    await q(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))`, [U, 1, 0, NAME_TERR]);
    await q(`INSERT INTO territory_profiles (user_id, territory_id, realm_id, name, created_at, updated_at) VALUES (?,?,?,?,datetime('now'),datetime('now'))`, [U, 3, 7, 'Territory 3']);

    // ── IL1: counts via the pipeline's predicate over the job's universe ──
    const s1 = await j('/mycelium/naming-status');
    const a1 = s1.body?.areas || {};
    rec('IL1a. ⭐ the route counts with the PIPELINE\'s predicate: `Realm 7` + `Territory 3` + a missing row are all UNNAMED',
      s1.status === 200 && a1.total === 5 && a1.named === 2 && a1.unnamed === 3,
      `status=${s1.status} areas=${JSON.stringify(a1)} (expected total 5, named 2, unnamed 3 — a divergent predicate like name IS NOT NULL reads 4 named)`);
    // Self-test of the fixture's teeth: the SHARED predicate really does call these unnamed,
    // and a name-presence predicate really would disagree (n≥2 in both directions).
    rec('IL1b. the shared predicate itself: placeholders unnamed, real names named (the fixture has teeth)',
      isPlaceholderName('Realm 7') && isPlaceholderName('Territory 3') && !isPlaceholderName(NAME_REALM) && !isPlaceholderName(NAME_TERR));

    // ── IL2 (server): the bound is the module's own, expected = unnamed × bound ──
    const f1 = s1.body?.forecast || {};
    rec('IL2a. ⭐ forecast is SERVED from the shared module: perUnitTokenBound = the module\'s derivation, expected = unnamed × bound',
      f1.perUnitTokenBound === BOUND && f1.expectedTokensBound === 3 * BOUND,
      `bound=${f1.perUnitTokenBound} (module says ${BOUND}) expected=${f1.expectedTokensBound}`);

    // ── narrator authority: nothing configured ⇒ ready:false (the IL3 precondition is real) ──
    const n1 = s1.body?.narrator || {};
    rec('IL3a. no provider + no approved on-box model ⇒ narrator.ready:false (the served refusal the card pre-empts)',
      n1.ready === false, `narrator=${JSON.stringify(n1)}`);

    // Activate a LOCAL provider row (loopback base — never dialed) with its own model pick.
    const provId = await db.providers.create(U, { provider: 'custom', label: 'Stub Ollama', authType: 'api_key', model: 'qwen-test', baseUrl: 'http://127.0.0.1:1/v1' });
    await db.providers.setActive(provId, U);
    const s2 = await j('/mycelium/naming-status');
    const n2 = s2.body?.narrator || {};
    rec('IL3b. an active loopback provider ⇒ ready:true, local:true, jurisdiction \'local\', the row\'s own model — the §4g authority, served',
      n2.ready === true && n2.local === true && n2.jurisdiction === 'local' && n2.model === 'qwen-test' && n2.label === 'Stub Ollama',
      `narrator=${JSON.stringify(n2)}`);

    // ── IL1 control (n≥2): counts track the DB, not the fixture accident ──
    await q(`UPDATE realms SET name = 'Now Really Named' WHERE user_id = ? AND realm_id = 7`, [U]);
    await q(`UPDATE territory_profiles SET name = 'Also Named Now' WHERE user_id = ? AND territory_id = 3`, [U]);
    const s3 = await j('/mycelium/naming-status');
    const a3 = s3.body?.areas || {};
    rec('IL1c. naming the placeholders moves the count (5/4/1) — the route reads the vault, not a cache',
      a3.total === 5 && a3.named === 4 && a3.unnamed === 1 && s3.body?.forecast?.expectedTokensBound === 1 * BOUND,
      `areas=${JSON.stringify(a3)} expected=${s3.body?.forecast?.expectedTokensBound}`);

    // ── IL8 (server half): the body is counts + identifiers — never a seeded name ──
    const blob = JSON.stringify(s1.body) + JSON.stringify(s2.body) + JSON.stringify(s3.body);
    rec('IL8a. ⭐ naming-status is content-free: no seeded realm/territory name in any response',
      !blob.includes('SECRETXYZ') && !blob.includes('Now Really Named'), `bodies=${blob.slice(0, 120)}…`);
  } finally {
    srv.server.close(); try { srv.close?.(); } catch {}
    for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
  }
}

// ── The card half: mount per scenario (real component, real stores, jsdom) ──
function probe(scenario) {
  return new Promise((resolve) => {
    const child = spawn('node', ['--conditions', 'browser', 'test/mount-illuminate-card.mjs'],
      { cwd: 'portal-app', env: { ...process.env, PROBE: scenario }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 120_000);
    child.on('close', () => {
      clearTimeout(t);
      const lines = out.trim().split('\n').filter(Boolean);
      let r = null; try { r = JSON.parse(lines[lines.length - 1]); } catch {}
      resolve(r || { ok: false, scenario, error: `no JSON (stderr: ${err.slice(-300)})` });
    });
  });
}

async function cardPart() {
  const scenarios = ['before', 'before-wire', 'before-cloud', 'choice', 'empty', 'fallback', 'during', 'after-success', 'after-partial', 'busy', 'running', 'disk_low'];
  const R = {};
  for (const s of scenarios) R[s] = await probe(s);
  const okAll = scenarios.every((s) => R[s]?.ok);
  rec('M0. every mount probe ran (real compile + mount, no throw)', okAll,
    scenarios.filter((s) => !R[s]?.ok).map((s) => `${s}: ${R[s]?.error}`).join(' | ').slice(0, 400));
  if (!okAll) return R;

  const b = R.before;
  rec('IL-B. BEFORE: counts, bar, the three disclosures, the CTA — and NO duration claim pre-start',
    b.hasCard && b.ctaCount === 1
    && b.cardText.includes('12 of your 40 areas still have placeholder names')
    && b.cardText.includes('28 named · 70%')
    && b.cardText.includes('qwen3.5:4b on this Mac — nothing leaves')
    && b.cardText.includes('Uses up to ~52k tokens, free on your hardware')
    && b.cardText.includes('Keeps every name you already have')
    && b.cardText.includes('Name 12 areas')
    && b.cardText.includes('a real time estimate appears once it starts')
    && !/left\b/.test(b.cardText) && b.allNamedLine === '',
    `card="${b.cardText.slice(0, 160)}…"`);

  rec('IL2b. ⭐ the token line renders THE WIRE\'s number (inconsistent fixture: a client-side unnamed×bound would say ~52k)',
    R['before-wire'].cardText.includes('up to ~987k tokens') && !R['before-wire'].cardText.includes('~52k'),
    `card="${R['before-wire'].cardText.slice(0, 140)}"`);

  rec('IL-B2. cloud narrator renders the served jurisdiction ("via Regolo (EU)") + plan attribution — never client-derived',
    R['before-cloud'].cardText.includes('Runs via Regolo (EU) — your approved provider')
    && R['before-cloud'].cardText.includes('on your Regolo plan'),
    `card="${R['before-cloud'].cardText.slice(0, 160)}"`);

  const c = R.choice;
  rec('IL3c. ⭐ narrator not ready ⇒ CTA REPLACED by the muted choice line; clicking EVERY card button POSTs nothing',
    c.hasCard && c.ctaCount === 0 && c.postCalls === 0 && c.choiceMuted && c.gotoCalls >= 1
    && c.cardText.includes('No model is set up to name your areas') && c.cardText.includes('Choose a model'),
    `cta=${c.ctaCount} posts=${c.postCalls} muted=${c.choiceMuted} card="${c.cardText}"`);

  const e = R.empty;
  rec('IL-E. EMPTY: all named ⇒ NO card, NO CTA, one muted line (BEFORE/EMPTY are one fact, opposite signs)',
    !e.hasCard && e.ctaCount === 0 && e.allNamedLine === '40 areas · all named',
    `hasCard=${e.hasCard} line="${e.allNamedLine}"`);

  rec('IL-F. naming-status down ⇒ the capability SURVIVES (fallback CTA on the client predicate; no fake counts, no fake "all named")',
    !R.fallback.hasCard && R.fallback.ctaCount === 1 && R.fallback.allNamedLine === '',
    `cta=${R.fallback.ctaCount} line="${R.fallback.allNamedLine}"`);

  const d = R.during;
  rec('IL4a. ⭐ DURING renders the feed row (7 of 12 · ~3m left · aria-valuenow=7) — the owner\'s numbers',
    d.snap1.text.includes('7 of 12') && d.snap1.text.includes('~3m left') && d.snap1.valuenow === '7'
    && d.snap1.text.includes('Started') && d.snap1.text.includes('qwen3.5:4b on this Mac'),
    `snap1="${d.snap1.text}"`);
  rec('IL4b. ⭐ identity, n≥2: moving the OWNER\'s row moves the render (9 of 12, valuenow=9; 7-state gone)',
    d.snap2.text.includes('9 of 12') && d.snap2.valuenow === '9' && !d.snap2.text.includes('7 of 12'),
    `snap2="${d.snap2.text}"`);
  rec('IL4c. the percent-NAMED bar does not tick mid-run (no "named ·"/"70%" inside the DURING card — R4: one owner per number)',
    !d.snap1.text.includes('named ·') && !d.snap1.text.includes('70%') && !d.snap2.text.includes('named ·'),
    `snap1="${d.snap1.text.slice(0, 100)}"`);
  rec('IL7a. no per-tick announcements: the live region text is unchanged across a step advance',
    d.snap1.live === d.snap2.live, `live1="${d.snap1.live}" live2="${d.snap2.live}"`);

  const asucc = R['after-success'];
  rec('IL-A. AFTER success: "Named 12 areas just now", the announcement fires once, the reward is the RE-RENDERED list (+wash)',
    asucc.cardText === 'Named 12 areas just now' && asucc.liveText === 'Named 12 areas'
    && asucc.listText.includes('Morning Reflections') && asucc.washCount >= 1,
    `card="${asucc.cardText}" live="${asucc.liveText}" wash=${asucc.washCount}`);

  const ap = R['after-partial'];
  rec('IL5. ⭐ partial: "Named 9 areas — 3 couldn’t be named · Try again", and Try again RE-POSTS (gap-fill = the remainder)',
    ap.cardText.includes('Named 9 areas — 3 couldn’t be named') && ap.hadTryAgain && ap.rePosted
    && ap.liveText === '3 areas couldn’t be named' && /running|Starting/i.test(ap.textAfterRetry),
    `card="${ap.cardText}" rePosted=${ap.rePosted} afterRetry="${ap.textAfterRetry}"`);

  rec('IL6a. busy ⇒ the DURING view (the truth is "it\'s running", not "you were refused") + the server\'s note',
    R.busy.cardText.includes('● running') && R.busy.cardText.includes('A naming pass is already running.'),
    `card="${R.busy.cardText}"`);
  rec('IL6b. CONTROL: running ⇒ DURING too (each response arm driven separately — the two-guards lesson)',
    R.running.cardText.includes('● running') && R.running.postCalls === 1, `card="${R.running.cardText}"`);
  rec('IL6c. disk_low ⇒ the card STAYS actionable: BEFORE + "free up ~4 GB, then try again." (structured detail, no dead-end)',
    R.disk_low.ctaCount === 1 && !R.disk_low.cardText.includes('● running')
    && R.disk_low.cardText.includes('free up ~4 GB, then try again'),
    `card="${R.disk_low.cardText.slice(-120)}"`);

  rec('IL7b. ⭐ ONE persistent live region in EVERY state: mounted EMPTY before any milestone, same node after (never inserted-with-text)',
    scenarios.every((s) => R[s].liveCount === 1 && R[s].liveExistedAtMountEmpty && R[s].liveSameNode),
    scenarios.map((s) => `${s}:${R[s].liveCount}/${R[s].liveExistedAtMountEmpty}/${R[s].liveSameNode}`).join(' '));

  rec('IL8b. ⭐ content-free card in EVERY state — the distinctive vault name renders in the LIST (control) and NEVER in the card',
    scenarios.every((s) => R[s].secretInCard === false)
    && ['before', 'choice', 'during', 'busy', 'disk_low', 'empty', 'after-success'].every((s) => R[s].secretInList === true),
    scenarios.map((s) => `${s}:card=${R[s].secretInCard},list=${R[s].secretInList}`).join(' '));
  return R;
}

await serverPart();
await cardPart();

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(72));
console.log(`VERDICT: ${allPass ? 'GO — the Illuminate run surface: one predicate, served bound, owner-rendered progress, every state a next step, content-free' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(72));
process.exit(allPass ? 0 : 1);
