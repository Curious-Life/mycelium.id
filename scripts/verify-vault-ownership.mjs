// scripts/verify-vault-ownership.mjs — "app closed ⇒ nobody writes".
//
// Every check here runs REAL SEPARATE PROCESSES against the PRODUCT'S OWN functions. That
// is not decoration. Four of seven adversarial review rounds on the predecessor branch
// found the same class — the fixture did not exercise what the product does: it died before
// reaching the branch it named, or blanked a flag the app always sets, or built the artefact
// the product was supposed to build, or simulated both ends of a chain and asserted the join
// nowhere. A lease is a CROSS-PROCESS claim; a single-process test of one would be that
// mistake in its purest form.
//
// So: the owner is a child process, the challenger is a different child process, and the
// kill is a real SIGKILL. Nothing here stubs the lease.
// MUTATION-TESTED: 2026-07-29 — every mutation grep'd back off disk AND `node --check`ed
// before its result was believed. Two earlier attempts were discarded for exactly that
// reason: one was a SyntaxError that reddened 30 checks for the wrong reason, and one
// silently never applied. RE-RUN after assertVaultOwnership was deleted, because a record
// citing a function that no longer exists is a record of nothing:
//   claim always returns owner ................... A2,A4,A5,A7,A8,A9,A11,A12,A13 RED (8/9)
//   probe folds UNKNOWN → FREE (the fail-open) ... A5 RED only          (16/1)
//   getDb's claim removed ........................ A11 RED only         (16/1)
//   the child-role branch is bypassed ............ A9 RED only          (11/1)
//   child role enforced WITHOUT a family token ... A14 RED only         (16/1)
//   ONE of jobs.js's four child marks removed .... A10 RED only         (11/1)
//   a different family may inherit ............... A4 RED only          (8/1)
//   a garbage lease file is not repaired ......... A6 RED only          (8/1)
//   metadata publish back to best-effort ......... A2,A7,A8,A11,A13 RED (10/5)
//   openLockFile back to better-sqlite3's default `timeout: 5000` → A15 RED only (18/1)
//   the inheritor's takeover retry disarmed ...... A16 RED only         (18/1)
// Round 6 (measured on a dedicated harness, not through the gate — the gate cannot see
// either of these, which is the point):
//   removing the MID-CLAIM retry → 2/40 correct owner+inheritor pairs and 18/40 with BOTH
//     siblings refused, vs 40/40 with it. That is the app's own launch path.
//
// ⚠️ A SECOND SURVIVOR, RECORDED. Serialising the garbage-lease repair behind an O_EXCL
// guard is a mechanism-level fix for the double-owner race an independent review measured
// (two owners 1/48; A12 RED ~1 run in 3 UNDER LOAD). I could not reproduce it here:
// 0/60 double owners WITHOUT the serialisation, and 8/8 green gate runs. So the fix
// addresses the mechanism they described, and its EFFECT is unmeasured on this machine.
// Recorded rather than claimed, exactly like the inode re-check above — if A12 ever goes
// RED again, this note is the starting point, not a reason to assume it cannot.
// The one-check-each separation is the evidence that these are independent guarantees
// and not one assertion wearing several names.
//
// ⚠️ ONE MUTATION SURVIVED, AND IT IS RECORDED RATHER THAN DRESSED UP.
//   removing the inode re-check in claimVaultOwnership → A12 still GREEN.
// An independent review measured 11/40 racing claims producing TWO OWNERS of one vault
// against an earlier revision. After the metadata publish became fail-the-claim, neither I
// (0/40, 2 racers) nor a second reviewer (0/60, 3 racers) could reproduce it. So A12
// asserts the OUTCOME — never two owners — and the outcome holds; it does NOT discriminate
// the mechanism, and the re-check itself compares two stats of the PATH rather than the
// handle (better-sqlite3 exposes no fd), so it narrows the window rather than closing it.
// Kept as defence-in-depth whose value is unproven, and said so in both places, so nobody
// later reads A12 as proof that dropping it is safe. It is not proof of that.
import './lib/gate-stdout.mjs';   // MUST be the first line of code — setBlocking only affects LATER writes
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const LEASE = join(REPO, 'src/db/vault-lease.js');

let pass = 0; let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  [✓] ${name}`); }
  catch (e) { fail++; console.log(`  [✗] ${name}\n      ${String(e.message).split('\n').slice(0, 6).join('\n      ')}`); }
}

/**
 * Run a snippet in a REAL child process with a controlled environment.
 * MYCELIUM_DATA_DIR is how a temp vault becomes "the canonical vault" for that child —
 * paths.js:39 gives it precedence — so the canonical-only scoping is exercised for real
 * rather than mocked out.
 */
function runChild(body, { dataDir, env = {}, waitFor = null, timeoutMs = 15000 } = {}) {
  const file = join(dataDir, `child-${Math.abs(hash(body + JSON.stringify(env)))}.mjs`);
  writeFileSync(file, `import * as L from ${JSON.stringify(LEASE)};\n${body}\n`);
  const child = spawn(process.execPath, [file], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      MYCELIUM_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => {
    if (waitFor) {
      const check = () => { if (out.includes(waitFor)) resolve({ child, out, err, live: true, read: () => out }); };
      child.stdout.on('data', check);
      setTimeout(() => resolve({ child, out, err, live: true, timedOut: !out.includes(waitFor), read: () => out }), timeoutMs);
    } else {
      child.on('exit', (code) => resolve({ child, out, err, code, live: false }));
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    }
  });
  return done;
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `vo-${prefix}-`));
  return { dir, db: join(dir, 'mycelium.db') };
}

// A child that CLAIMS and then stays alive until killed.
const OWNER = `
const r = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
console.log('CLAIMED:' + r.role);
setInterval(() => {}, 1000);
`;
// A child that asks the PRODUCT's own question: may I open this vault, and as what?
// This used to call assertVaultOwnership — a function the product stopped calling and
// which is now deleted. A gate exercising an API the product does not use is the exact
// defect an adversarial review found twice on this branch, in both directions.
const ASKER = `
try {
  const r = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
  console.log('ALLOWED:' + r.role + ':' + r.reason);
} catch (e) { console.log('REFUSED:' + (e.code || 'no-code') + ':' + e.message.slice(0, 80)); }
`;

console.log('\n── vault ownership ───────────────────────────────────────────');

// ── A1. THE HONEST SCOPE OF LAYER A. ─────────────────────────────────────────────
// This row used to be titled "app closed (no lease) → a write-capable open is REFUSED"
// and it was FALSE OF THE PRODUCT: it called an assert-only API that getDb had stopped
// using, so it asserted a refusal nothing performed. An adversarial review caught it.
//
// What is actually true, and is the operator's O1 decision rather than an oversight: a
// STANDALONE process is an entry point — a headless self-host, `npm start`, a pipeline
// CLI, a verify gate — and it CLAIMS. Refusing it would break every one of those. What
// stops code that is not ours from opening a closed vault is the FILE-MODE layer, which
// is a separate unit; Layer A's job is orphaned children (A9) and second instances (A4).
//
// The row is kept, inverted, because the wrong version of it is the thing most likely to
// be reintroduced by someone reading the design doc's headline and not its threat model.
await t('A1. app closed + a STANDALONE process → it CLAIMS (O1), and Layer A does not pretend otherwise', async () => {
  const { dir } = fixture('a1');
  const r = await runChild(ASKER, { dataDir: dir });
  assert.match(r.out, /^ALLOWED:owner/m,
    `a standalone entry point must be able to take ownership of its own vault — refusing it `
    + `breaks headless self-host and the whole gate suite (got: ${r.out.trim() || r.err.trim().slice(0, 200)})`);
  rmSync(dir, { recursive: true, force: true });
});

// ── A2. …and the app's own children ARE allowed. ─────────────────────────────────
await t('A2. app running + same family → ALLOWED (the shipped app must still work)', async () => {
  const { dir } = fixture('a2');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a2' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, `precondition: the owner must actually claim (got ${owner.out.trim()}${owner.err.slice(0, 200)})`);
  const child = await runChild(ASKER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a2' } });
  assert.match(child.out, /^ALLOWED:inheritor/m, `a same-family child must inherit (got: ${child.out.trim()})`);
  // …and a STRANGER is refused while the app holds the vault. This is the half of the
  // operator's ask that Layer A really does deliver: two instances never share one vault.
  const stranger = await runChild(ASKER, { dataDir: dir });
  assert.match(stranger.out, /^REFUSED:vault_owned_elsewhere/m,
    `a foreign process must be refused while the app runs (got: ${stranger.out.trim()})`);
  owner.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── A3. THE BRICK-PROOF. ─────────────────────────────────────────────────────────
// This repo has shipped a permanent lockout from a stale lock THREE times (D-111, D-113,
// and the un-numbered zombie-lock brick). The lease is a KERNEL lock precisely so there is
// nothing to go stale: SIGKILL the holder — no exit handler, no cleanup, no `ps` — and the
// next claim must simply succeed.
await t('A3. SIGKILL the owner → the next claim succeeds, with NO cleanup step (no stale-lock brick)', async () => {
  const { dir } = fixture('a3');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a3' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, 'precondition: the owner must actually claim');
  owner.child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 400));
  let alive = true; try { process.kill(owner.child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'precondition: the SIGKILL must actually have landed');
  const next = await runChild(`
    const r = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
    console.log('CLAIMED:' + r.role); process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a3-new' } });
  assert.match(next.out, /CLAIMED:owner/,
    `a killed owner must leave NOTHING behind — a stale lease here is a permanent brick (got: ${next.out.trim()}${next.err.slice(0, 300)})`);
  rmSync(dir, { recursive: true, force: true });
});

// ── A4. Two app instances must not share one vault. ──────────────────────────────
await t('A4. a DIFFERENT family cannot claim a vault another instance owns', async () => {
  const { dir } = fixture('a4');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a4-one' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, 'precondition: the owner must actually claim');
  const other = await runChild(`
    try {
      const r = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
      console.log('CLAIMED:' + r.role);
    } catch (e) { console.log('THREW:' + (e.code || 'no-code')); }
    process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a4-two' } });
  assert.match(other.out, /THREW:vault_owned_elsewhere/,
    `a second instance must be refused, not silently share the vault (got: ${other.out.trim()})`);
  owner.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── A5. "COULD NOT TELL" MUST REFUSE. ────────────────────────────────────────────
// writer-lock.js has SIX branches that resolve an unanswerable probe to "allowed"
// (:103, :109, :125, :128, :184, :146). Every one is a place the guard silently switches
// itself off. The lease's third state exists so that cannot happen here.
await t('A5. an UNPROBEABLE lease REFUSES (no fail-open third state)', async () => {
  const { dir } = fixture('a5');
  // A directory where the lease file belongs: every open answers EISDIR/CANTOPEN, so the
  // probe genuinely cannot tell — without us stubbing the probe.
  mkdirSync(join(dir, '.vault-ownership'), { recursive: true });
  const r = await runChild(`
    const p = L.probeVaultOwnership(process.env.MYCELIUM_DATA_DIR + '/mycelium.db');
    console.log('PROBE:' + p.state);
    ${ASKER}
  `, { dataDir: dir });
  assert.match(r.out, /PROBE:UNKNOWN/, `precondition: the probe must actually be unable to tell (got: ${r.out.trim()})`);
  assert.match(r.out, /^REFUSED:vault_not_owned/m, `and an unknowable lease must REFUSE (got: ${r.out.trim()})`);
  rmSync(dir, { recursive: true, force: true });
});

// ── A6. A GARBAGE LEASE FILE MUST NOT BE A BRICK. ────────────────────────────────
// The counterweight to A5. The lease file holds no data — it exists only to be locked —
// so a truncated or garbage one must be recreated, not treated as a permanent refusal.
// D-112 was exactly this shape: a marker that outlived what it described, with no
// in-product escape.
await t('A6. a GARBAGE lease file is repaired on claim, not treated as a lockout', async () => {
  const { dir } = fixture('a6');
  writeFileSync(join(dir, '.vault-ownership'), 'not a database at all');
  const r = await runChild(`
    const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
    console.log('CLAIMED:' + x.role); process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a6' } });
  assert.match(r.out, /CLAIMED:owner/,
    `a corrupt lease file must be recreated — refusing forever would be a guard-made brick (got: ${r.out.trim()}${r.err.slice(0, 300)})`);
  rmSync(dir, { recursive: true, force: true });
});

// ── A7. THE SIBLING CASE THE SHIPPED APP DEPENDS ON. ─────────────────────────────
// main.rs:650 and :795 spawn TWO node entry points with the SAME family token. Exactly one
// wins the lock; the other must proceed as an inheritor. If it threw, every launch of the
// real app would fail — so this check is the difference between a guard and an outage.
await t('A7. a second SAME-FAMILY entry point becomes an inheritor, not a failure', async () => {
  const { dir } = fixture('a7');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a7' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, 'precondition: the first sibling must claim');
  const sib = await runChild(`
    const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
    console.log('CLAIMED:' + x.role); process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a7' } });
  assert.match(sib.out, /CLAIMED:inheritor/,
    `the app's second sibling must inherit, not fail (got: ${sib.out.trim()}${sib.err.slice(0, 300)})`);
  owner.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── A8/A9. THE COMPUTE PIPELINE — the case the handoff called "a hole the width of
// the whole compute pipeline". A spawned child may BORROW the app's lease and must never
// take one. Without A9 a pipeline stage outliving its app would find the lease free,
// claim it, and keep writing — the guard handing the vault to the process it exists to stop.
await t('A8. a spawned child of a LIVE app inherits (the pipeline keeps working)', async () => {
  const { dir } = fixture('a8');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a8' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, 'precondition: the app must be running');
  const kid = await runChild(`
    const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
    console.log('CLAIMED:' + x.role); process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a8', MYCELIUM_VAULT_ROLE: 'child' } });
  assert.match(kid.out, /CLAIMED:inheritor/,
    `a pipeline child of a live app must keep working (got: ${kid.out.trim()}${kid.err.slice(0, 300)})`);
  owner.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

await t('A9. a spawned child whose app DIED is refused — it must not claim the vault', async () => {
  const { dir } = fixture('a9');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a9' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, 'precondition: the app must have been running');
  owner.child.kill('SIGKILL');           // the app crashes mid-job
  await new Promise((r) => setTimeout(r, 400));
  let alive = true; try { process.kill(owner.child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'precondition: the app must actually be gone');
  const orphan = await runChild(`
    try {
      const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' });
      console.log('CLAIMED:' + x.role);
    } catch (e) { console.log('THREW:' + (e.code || 'no-code')); }
    process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a9', MYCELIUM_VAULT_ROLE: 'child' } });
  assert.match(orphan.out, /THREW:vault_not_owned/,
    `an orphaned child must STOP, not take ownership of the vault it was borrowing (got: ${orphan.out.trim()})`);
  rmSync(dir, { recursive: true, force: true });
});

// The mark must actually be ON the children the product spawns, or A8/A9 test a label
// nothing wears. Asserted against the product's own file, at every spawn site.
// ── A14. THE ASYMMETRY. A child marked `child` whose PARENT NEVER HELD A LEASE. ──
// isCanonicalVault() is environment-relative — resolveDbPath() reads MYCELIUM_DB — and
// jobs.js ALWAYS hands MYCELIUM_DB to the children it spawns. So a parent that never set
// it sees its vault as non-canonical and skips claiming, while its child sees the SAME
// FILE as canonical and hunts for a lease nobody took. That refused the cluster-naming
// child, nothing got named, and the UI fell back to "Territory {id}" — the exact symptom
// verify:illuminate-naming exists to catch, which is how this was found.
//
// A9 covers the case WITH a token (a real orphan, refused). This covers the case WITHOUT
// one; the two together are what make the mark sound rather than merely present.
await t('A14. a child whose parent never held a lease (no family token) is NOT refused', async () => {
  const { dir } = fixture('a14');
  const r = await runChild(`
    try { const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' }); console.log('CLAIMED:' + x.role); }
    catch (e) { console.log('THREW:' + (e.code || 'no-code')); }
    process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_ROLE: 'child' } });   // role, but NO family token
  assert.match(r.out, /CLAIMED:owner/,
    'a child with no lease to inherit has nothing that can have died — refusing it strands '
    + `every job whose parent opened a vault it did not consider canonical (got: ${r.out.trim()}${r.err.slice(0, 300)})`);
  rmSync(dir, { recursive: true, force: true });
});

await t('A10. jobs.js marks EVERY spawned child with the role (the label is really applied)', async () => {
  const jobs = await import('node:fs').then((fs) => fs.readFileSync(join(REPO, 'src/jobs.js'), 'utf8'));
  const roles = (jobs.match(/MYCELIUM_VAULT_ROLE: 'child'/g) || []).length;
  const families = (jobs.match(/MYCELIUM_VAULT_FAMILY: process\.env\.MYCELIUM_VAULT_FAMILY/g) || []).length;
  assert.ok(families > 0, 'precondition: jobs.js must forward the family token somewhere');
  assert.equal(roles, families,
    `every child that inherits the family token must also be marked as a child `
    + `(${families} spawn sites forward the token, ${roles} are marked) — an unmarked one could claim the vault`);
});

// ══ THROUGH THE PRODUCT'S OWN DOOR ════════════════════════════════════════════════
// Everything above calls the lease API directly. An adversarial review showed why that is
// not enough: at the time, claimVaultOwnership was called only from boot(), and every
// pipeline child opens the vault through getDb and explicitly NOT boot()
// (pipeline/discover-claims.mjs:100, describe-chronicles.js:454, describe-clusters.js:133
// all say so in as many words). assertVaultOwnership had ZERO product callers. The gate was
// green, the role mark was decorative, and a marked child with a dead app's family token
// wrote 25 rows into the canonical vault. A11 goes through getDb — the door the product
// actually uses — so the enforcement cannot be absent and still pass.
await t('A11. an orphaned child calling the PRODUCT\'s getDb writes NOTHING (not the lease API — getDb)', async () => {
  const { dir } = fixture('a11');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a11' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, 'precondition: the app must have been running');

  // While the app LIVES, the same child must succeed — otherwise "it wrote nothing" below
  // could mean the fixture never worked at all. This is the positive precondition.
  // A WRITE-CAPABLE OPEN through the product's own door. getDb is where every pipeline
  // child enters, so a refusal here is a refusal of the write itself — the handle never
  // exists. No DDL: this fixture's vault has no schema (it was never booted), and the point
  // is the OPEN, not what could be done with it afterwards.
  const WRITER = `
    import { getDb } from ${JSON.stringify(join(REPO, 'src/db/index.js'))};
    import { unlock } from ${JSON.stringify(join(REPO, 'src/crypto/keys.js'))};
    const dbPath = process.env.MYCELIUM_DATA_DIR + '/mycelium.db';
    try {
      const { userKey, systemKey } = await unlock({ userHex: 'c'.repeat(64), systemHex: 'd'.repeat(64), kcvPath: dbPath + '.kcv', dbPath });
      const { close } = getDb({ dbPath, userKey, systemKey });
      console.log('OPENED:write-capable');
      close();
    } catch (e) { console.log('BLOCKED:' + (e.code || 'no-code') + ':' + String(e.message).slice(0, 90)); }
    process.exit(0);
  `;
  const live = await runChild(WRITER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a11', MYCELIUM_VAULT_ROLE: 'child', MYCELIUM_AT_REST: '', MYCELIUM_KEY_SOURCE: 'env', MYCELIUM_DISABLE_EMBED: '1' }, timeoutMs: 60000 });
  assert.match(live.out, /^OPENED:write-capable/m,
    `precondition: while the app LIVES this child must be able to write, or the check below proves nothing (got: ${live.out.trim()}${live.err.slice(-300)})`);

  owner.child.kill('SIGKILL');                 // the app dies mid-job
  await new Promise((r) => setTimeout(r, 400));
  let alive = true; try { process.kill(owner.child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'precondition: the app must actually be gone');

  const orphan = await runChild(WRITER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a11', MYCELIUM_VAULT_ROLE: 'child', MYCELIUM_AT_REST: '', MYCELIUM_KEY_SOURCE: 'env', MYCELIUM_DISABLE_EMBED: '1' }, timeoutMs: 60000 });
  assert.match(orphan.out, /^BLOCKED:vault_not_owned/m,
    `an orphaned child must be refused AT getDb — the door it actually uses (got: ${orphan.out.trim()}${orphan.err.slice(-300)})`);
  rmSync(dir, { recursive: true, force: true });
});

// ── A12. TWO OWNERS OF ONE VAULT. A4 ∧ A6, which neither tests alone. ────────────
// openLockFile repairs a garbage lease by unlink + recreate. Two claimants racing that
// repair each unlink the other's fresh inode and take BEGIN EXCLUSIVE on a DIFFERENT file:
// both "own" the vault. Reproduced by adversarial review at 11/40 before the inode
// re-check. A4 and A6 each pass alone; it is the COMBINATION that failed — the same
// unhandled-combination class the marker truth table exists to prevent.
await t('A12. racing claims on a GARBAGE lease never produce two owners (A4 ∧ A6)', async () => {
  let owners = 0; let trials = 0; let sawRepair = false;
  for (let i = 0; i < 16; i++) {
    const { dir } = fixture(`a12-${i}`);
    writeFileSync(join(dir, '.vault-ownership'), 'not a database at all');  // A6's exact fixture
    // A START BARRIER, because without one this check does not test what it claims.
    // The repair window is unlink→create: microseconds. Two children spawned back to back
    // miss it almost every time, and with the inode re-check MUTATED OUT the check still
    // passed 15/15 — a survivor, i.e. the guarantee was untested. Both children now spin
    // until a `go` file appears, so they enter the window together.
    const CLAIM = `
      import { existsSync } from 'node:fs';
      const go = process.env.MYCELIUM_DATA_DIR + '/go';
      while (!existsSync(go)) { /* spin — a timer would deschedule us out of the window */ }
      try { const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' }); console.log('R:' + x.role); }
      catch (e) { console.log('R:threw:' + (e.code || 'no-code')); }
      setInterval(() => {}, 1000);
    `;
    const pending = [
      runChild(CLAIM, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: `fam-a12-${i}-one` }, waitFor: 'R:', timeoutMs: 8000 }),
      runChild(CLAIM, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: `fam-a12-${i}-two` }, waitFor: 'R:', timeoutMs: 8000 }),
    ];
    await new Promise((r) => setTimeout(r, 300));      // let both reach the spin
    writeFileSync(join(dir, 'go'), '1');               // …and release them together
    const [a, b] = await Promise.all(pending);
    const n = [a.out, b.out].filter((o) => /R:owner/.test(o)).length;
    if (n > 0) sawRepair = true;
    if (n > 1) owners++;
    trials++;
    for (const c of [a.child, b.child]) { try { c.kill('SIGKILL'); } catch { /* */ } }
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(sawRepair, `precondition: at least one claim must have SUCCEEDED, or this loop proves nothing (${trials} trials)`);
  assert.equal(owners, 0,
    `${owners}/${trials} races produced TWO owners of one vault — the lease's central guarantee`);
});

// ── A13. THE DATA DIR IS UNWRITABLE. Brick #4, refused honestly. ─────────────────
// The holder metadata used to be a best-effort write. When it failed, the owner held the
// lock while advertising nothing, so the app's SECOND sibling was told to "quit" a pid that
// does not exist — on every launch, forever. Now a failed publish fails the CLAIM, with a
// message that names the real problem and the escape hatch.
await t('A13. an unwritable data dir fails the claim with an honest, escapable error (not a silent half-owner)', async () => {
  const { dir } = fixture('a13');
  const r = await runChild(`
    const fs = await import('node:fs');
    const p = L.leasePaths(process.env.MYCELIUM_DATA_DIR + '/mycelium.db');
    // Make the metadata unpublishable without making the lock file unopenable: a DIRECTORY
    // at the metadata path defeats both writeFileSync and rename, and nothing else.
    fs.mkdirSync(p.meta, { recursive: true });
    try { const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' }); console.log('CLAIMED:' + x.role); }
    catch (e) { console.log('THREW:' + (e.code || 'no-code') + ':' + String(e.message).replace(/\\s+/g, ' ')); }
    process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a13' } });
  assert.match(r.out, /THREW:vault_not_owned/,
    `an owner that cannot advertise itself must not become one (got: ${r.out.trim()}${r.err.slice(0, 300)})`);
  assert.match(r.out, /MYCELIUM_SKIP_VAULT_LEASE=1/,
    'and the error must name the escape hatch — a refusal with no way out is the brick, not the guard');
  rmSync(dir, { recursive: true, force: true });
});

// ── A15. A CLAIM AGAINST A HELD LEASE MUST BE FAST. ─────────────────────────────
// Nobody asked what the guard COSTS until round 5. better-sqlite3 defaults to
// `timeout: 5000`, and openLockFile's `SELECT 1` takes a SHARED lock — so against a live
// holder it BLOCKED for the full 5 s before throwing, with the `busy_timeout = 0` this
// design rests on applied only afterwards by the caller. boot() claims twice, and
// src/server-http.js calls boot() PER MCP SESSION, so every remote `initialize` was an
// 11-second handshake — decided by a startup race between the two siblings in main.rs.
//
// The gate could not see it because `runChild`'s 15 s timeout absorbed the stall, and five
// existing rows were silently paying it. This row makes the COST an assertion.
await t('A15. claiming against a HELD lease returns fast (no 5 s busy-block)', async () => {
  const { dir } = fixture('a15');
  const owner = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a15' }, waitFor: 'CLAIMED:' });
  assert.match(owner.out, /CLAIMED:owner/, 'precondition: the owner must actually hold the lease');
  const r = await runChild(`
    const t0 = Date.now();
    try { L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' }); }
    catch { /* refused is fine — we are timing the REFUSAL */ }
    console.log('MS:' + (Date.now() - t0));
    process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a15-other' } });
  const ms = Number((/MS:(\d+)/.exec(r.out) || [])[1]);
  assert.ok(Number.isFinite(ms), `precondition: the child must report a duration (got: ${r.out.trim()})`);
  assert.ok(ms < 1500,
    `a claim against a held lease took ${ms} ms — the busy-block is back, and boot() pays it twice per process `
    + '(and once per MCP session on the remote surface)');
  owner.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── A16. THE SURVIVING SIBLING MUST TAKE THE VAULT OVER. ────────────────────────
// The lease is held by ONE process. The app spawns two siblings with the same family
// token; one wins, the other inherits and holds nothing. If the OWNER dies and the
// inheritor survives, the vault went ownerless and NOTHING re-claimed it — boot() runs once
// per process. Measured before the fix: pipeline children were then refused with "The app
// was closed or crashed while this job was running" while the app was demonstrably running.
//
// A9 covers the orphan case with NO surviving process. This is the two-sibling case that
// the `inheritor` role exists for, and it was untested.
await t('A16. the owner dies, the surviving SIBLING takes over, and children work again', async () => {
  const { dir } = fixture('a16');
  const a = await runChild(OWNER, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a16' }, waitFor: 'CLAIMED:' });
  assert.match(a.out, /CLAIMED:owner/, 'precondition: sibling A must own the lease');
  const b = await runChild(`
    const r = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db', log: (m) => console.log('LOG:' + m) });
    console.log('CLAIMED:' + r.role);
    setInterval(() => {}, 1000);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a16' }, waitFor: 'CLAIMED:' });
  assert.match(b.out, /CLAIMED:inheritor/, `precondition: sibling B must start as an inheritor (got: ${b.out.trim()})`);

  a.child.kill('SIGKILL');                       // the owner crashes; B keeps serving
  await new Promise((r) => setTimeout(r, 400));
  let alive = true; try { process.kill(a.child.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'precondition: the owner must actually be gone');

  // B's takeover retry runs on a 5 s unref'd interval — allow two ticks plus slack.
  await new Promise((r) => setTimeout(r, 12000));
  // b.out is a SNAPSHOT taken when waitFor resolved; b.read() is the live buffer. A
  // long-lived child's later output is otherwise invisible, which reads as the product
  // failing when it is the fixture not looking.
  assert.match(b.read(), /taken over by pid/,
    `the surviving sibling must claim the ownerless vault (B said: ${b.read().trim().slice(-300)})`);

  // …and the consequence that actually matters: pipeline children work again.
  const kid = await runChild(`
    try { const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' }); console.log('CLAIMED:' + x.role); }
    catch (e) { console.log('THREW:' + (e.code || 'no-code')); }
    process.exit(0);
  `, { dataDir: dir, env: { MYCELIUM_VAULT_FAMILY: 'fam-a16', MYCELIUM_VAULT_ROLE: 'child' } });
  assert.match(kid.out, /CLAIMED:inheritor/,
    `a pipeline child must be allowed again once the survivor owns the vault — otherwise the whole compute pipeline dies while the UI is healthy (got: ${kid.out.trim()})`);
  b.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── D1. FIXTURES ARE UNTOUCHED. ──────────────────────────────────────────────────
// The lease is scoped to the CANONICAL vault, exactly as writer-lock.js:182-185 scopes
// itself. That scoping is what lets ~104 verify gates keep pointing MYCELIUM_DB at temp
// fixtures with no changes and NO seventh MYCELIUM_SKIP_* hatch — which the handoff called
// out as the wrong shape. If this check ever fails, the whole suite is about to.
await t('D1. a NON-canonical (fixture) vault is unaffected — no new escape hatch needed', async () => {
  const { dir } = fixture('d1');
  const elsewhere = mkdtempSync(join(tmpdir(), 'vo-d1-other-'));
  const r = await runChild(`
    const p = ${JSON.stringify(join(elsewhere, 'mycelium.db'))};
    console.log('CANONICAL:' + L.isCanonicalVault(p));
    const x = L.claimVaultOwnership({ dbPath: p });
    console.log('ALLOWED:' + x.reason);
  `, { dataDir: dir });
  assert.match(r.out, /CANONICAL:false/, `a fixture must not read as canonical (got: ${r.out.trim()})`);
  assert.match(r.out, /ALLOWED:not the canonical vault/,
    `a fixture vault must pass without a lease (got: ${r.out.trim()}${r.err.slice(0, 200)})`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

// ── D3. THE CASE D1 DOES NOT COVER, AND THE ONE THAT ACTUALLY BROKE THE SUITE. ───
// resolveDbPath() READS MYCELIUM_DB (paths.js:53), so a gate that points MYCELIUM_DB at a
// temp file makes that file THE CANONICAL VAULT for that process. D1 above uses a fixture
// reached by a DIFFERENT path than MYCELIUM_DB, so it proves the non-canonical branch and
// nothing about the population — which is gates and pipeline CLIs whose fixture IS
// canonical. That gap is why verify:at-rest crashed and verify:realm-prune lost five
// checks: both open a canonical fixture through getDb without going through boot().
//
// This is the fifth instance of "the fixture did not exercise what the product does" on
// this work, and the first one that was mine twice over — in the product AND in the check
// that was supposed to catch it.
await t('D3. a CANONICAL fixture (MYCELIUM_DB points at it) opens through getDb without an app', async () => {
  const { dir } = fixture('d3');
  const r = await runChild(`
    import { getDb } from ${JSON.stringify(join(REPO, 'src/db/index.js'))};
    import { unlock } from ${JSON.stringify(join(REPO, 'src/crypto/keys.js'))};
    const dbPath = process.env.MYCELIUM_DB;
    console.log('CANONICAL:' + L.isCanonicalVault(dbPath));
    try {
      const { userKey, systemKey } = await unlock({ userHex: 'c'.repeat(64), systemHex: 'd'.repeat(64), kcvPath: dbPath + '.kcv', dbPath });
      const { close } = getDb({ dbPath, userKey, systemKey });
      console.log('OPENED:ok'); close();
    } catch (e) { console.log('BLOCKED:' + (e.code || 'no-code') + ':' + String(e.message).slice(0, 100)); }
    process.exit(0);
  `, {
    dataDir: dir,
    env: { MYCELIUM_DB: join(dir, 'mycelium.db'), MYCELIUM_AT_REST: '', MYCELIUM_KEY_SOURCE: 'env', MYCELIUM_DISABLE_EMBED: '1' },
    timeoutMs: 60000,
  });
  assert.match(r.out, /CANONICAL:true/,
    `precondition: setting MYCELIUM_DB must make the fixture canonical, or this row tests the wrong branch (got: ${r.out.trim()})`);
  assert.match(r.out, /OPENED:ok/,
    `a gate or pipeline CLI opening its OWN canonical fixture must not be refused — it is an entry point, so it claims (got: ${r.out.trim()}${r.err.slice(-300)})`);
  rmSync(dir, { recursive: true, force: true });
});

// ── D2. The documented recovery escape actually works. ───────────────────────────
await t('D2. MYCELIUM_SKIP_VAULT_LEASE=1 lets recovery tooling through', async () => {
  const { dir } = fixture('d2');
  const r = await runChild(ASKER, { dataDir: dir, env: { MYCELIUM_SKIP_VAULT_LEASE: '1' } });
  assert.match(r.out, /^ALLOWED:/m, `the documented escape must work, or repair tooling is locked out (got: ${r.out.trim()})`);
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nVERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
