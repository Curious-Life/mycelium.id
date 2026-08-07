// scripts/verify-vault-lease-race.mjs — the double-owner race, closed and PROVEN closed (D-138).
//
// WHY THIS GATE EXISTS, SEPARATELY FROM verify:vault-ownership
// -----------------------------------------------------------
// A12 in verify-vault-ownership.mjs used to assert a PROBABILISTIC outcome: "0 double-owners
// across 16 races". That row went RED ~1/16 on byte-identical code — on BOTH dev-main and the
// public-release CI (v0.1.17) — because a probability is not a fact about a commit. It flaked
// the release path (D-138). A gate that a green build cannot rely on is not a gate.
//
// The fix (src/db/vault-lease.js repairLockFile) made the garbage-lease repair INODE-STABLE:
// it truncates the lease file in place (O_CREAT|O_TRUNC) instead of unlink+recreate. The entire
// double-owner mechanism was "two claimants end up locking two DIFFERENT inodes of one lease";
// with the inode invariant, every claimant contends on the SAME inode's BEGIN EXCLUSIVE, which
// SQLite serialises across processes. So the guarantee is now MECHANISM-level, and this gate
// asserts the MECHANISM deterministically instead of sampling an outcome:
//
//   R1  a garbage-lease repair PRESERVES the inode (single run, deterministic) — THE property
//       that makes two owners impossible, and the gate's real proof. Mutation: unlink+recreate → REDs.
//   R2  a HELD lease is inode-stable under a second claimant, and the second is refused. Note the
//       lease file is CONTENT-FREE (0 bytes even while held — it exists only to be locked), so a
//       redundant truncate of a held lease is a harmless no-op (nothing to zero, inode + fcntl lock
//       intact); R2 is a defence-in-depth invariant, and its inode check shares teeth with R1.
//   R3  the forced race, SAFETY only: N claimants forced (via the test barrier) into the repair
//       window together NEVER produce two owners (`owners <= 1`). A non-flaky end-to-end BACKSTOP,
//       NOT the proof — its regression RED is probabilistic (see mutation 2); R1 is the proof. It
//       asserts `<= 1` (not `=== 1`) on purpose: requiring a winner adds a LIVENESS demand that a
//       slow child under CI load can miss, which would flake — exactly the D-138 class.
//   R6  the app's OWN launch path: same-family claimants forced into the race are never REFUSED
//       with `vault_not_owned` (the guard-loser liveness bug the safety fix introduced — D-138
//       review D1). Also catches total breakage (nobody can claim) that R3's `<= 1` passes.
//   R5  the test barrier is a NO-OP when its env var is unset (the shipped condition) — so the
//       seam cannot affect a real claim.
//
// MUTATION-TESTED: 2026-08-05 — each mutation applied to src/db/vault-lease.js, watched, restored.
//   (1) repairLockFile's `writeFileSync(lockPath,'')` reverted to `unlinkSync(lockPath)` (the
//       inode-changing repair): R1 RED EVERY run — observed inode 67106884 → 67106887, and A12 in
//       verify:vault-ownership RED "only". The deterministic record that gives the gate teeth.
//   (2) the FULL pre-D-138 mechanism (unlink AND the lockLooksRepaired re-check removed): R1 RED
//       every run; the PROBE measured 11/24 double-owner trials (matching the historical 11/40),
//       but R3's trials passed on the runs watched — CONFIRMING a forced-race outcome check is a
//       PROBABILISTIC regression detector (exactly the flake D-138 is about). So R1, not R3, is the proof.
//   (3) openLockFile's repair path reverted to `repairLockFile(); return new Database()` with no
//       revalidation (the D1 liveness bug): R6 RED — 23 `vault_not_owned` refusals in 20 same-family
//       trials pre-fix vs 0 with the repair-then-revalidate loop. R6 is the record for the D1 fix.
//   (4) leaseTestBarrier's dir defaulted to MYCELIUM_DATA_DIR (seam leaks into a real claim): a
//       normal claim BLOCKED >6.5 s and wrote a stray `reached-saw-garbage-*` file → R5 RED on
//       both its assertions. Confirms the seam is inert only because its env var is unset.
//   R4 is a precondition FOLDED INTO R3/R6 (the barrier engaged in >= 1 trial), not a product
//   mutation — it guards against passing without racing (the M-001 "green because nothing ran"
//   trap). It is `>= 1`, not `=== TRIALS`, so a slow spawn under load cannot RED it (a flake the
//   `=== TRIALS` form would have carried — the D-138 lesson applied to the gate itself).
import './lib/gate-stdout.mjs';   // MUST be first: flushes VERDICT on a piped stdout
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
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

const inodeOf = (p) => { try { return statSync(p).ino; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A claimant in a REAL separate process — a lease is a cross-process claim, so a single-process
// test of one would be the exact defect the vault-ownership header warns about.
function claimChild(dir, { env = {}, waitFor = 'R:', barrier = null } = {}) {
  const file = join(dir, `claim-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, `
    import * as L from ${JSON.stringify(LEASE)};
    try { const x = L.claimVaultOwnership({ dbPath: process.env.MYCELIUM_DATA_DIR + '/mycelium.db' }); console.log('R:' + x.role); }
    catch (e) { console.log('R:threw:' + (e.code || 'no-code')); }
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [file], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, MYCELIUM_DATA_DIR: dir,
      ...(barrier ? { MYCELIUM_VAULT_LEASE_TEST_BARRIER: barrier } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const reached = () => out.includes(waitFor);
  const settled = new Promise((resolve) => {
    const check = () => { if (reached()) resolve(); };
    child.stdout.on('data', check);
    setTimeout(resolve, 8000);
  });
  return { child, settled, read: () => out, readErr: () => err };
}

function seedGarbage(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `vlr-${prefix}-`));
  writeFileSync(join(dir, '.vault-ownership'), 'not a database at all');   // the A6 fixture
  return { dir, lock: join(dir, '.vault-ownership') };
}

console.log('\n── vault-lease double-owner race (D-138) ─────────────────────');

// ── R1. THE DETERMINISTIC MECHANISM. Repair preserves the inode. ─────────────────────────
// This is the property that makes two owners impossible, and it holds on EVERY run — no
// sampling. Positive preconditions guard the "green because nothing ran" trap: the file must
// really be garbage first, and the claim must really have repaired-and-owned it.
await t('R1. a garbage-lease repair PRESERVES the inode (the mechanism that forbids two owners)', async () => {
  const { dir, lock } = seedGarbage('r1');
  const inoBefore = inodeOf(lock);
  assert.ok(inoBefore !== null, 'precondition: the garbage lease file must exist before the claim');
  const owner = claimChild(dir, { env: { MYCELIUM_VAULT_FAMILY: 'fam-r1' } });
  await owner.settled;
  assert.match(owner.read(), /R:owner/,
    `precondition: the claim must repair the garbage lease and OWN it, or nothing was exercised (got: ${owner.read().trim()}${owner.readErr().slice(0, 200)})`);
  const inoAfter = inodeOf(lock);
  assert.equal(inoAfter, inoBefore,
    `the repair changed the lease inode (${inoBefore} → ${inoAfter}) — that is the unlink+recreate mechanism `
    + 'that lets two claimants lock two different inodes of one vault (D-138). Repair must be IN PLACE.');
  owner.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── R2. A HELD lease is inode-stable, and a stranger is refused. ─────────────────────────
// Truncate-in-place is only safe because a HELD file never looks like garbage (it answers
// SQLITE_BUSY, not SQLITE_NOTADB), so the repair path never fires against a live owner. This
// pins that: while an owner holds the lease, a second family's claim is refused AND the owner's
// inode is untouched.
await t('R2. a HELD lease keeps its inode and refuses a different family (never truncated under its owner)', async () => {
  const { dir, lock } = seedGarbage('r2');
  const owner = claimChild(dir, { env: { MYCELIUM_VAULT_FAMILY: 'fam-r2-owner' } });
  await owner.settled;
  assert.match(owner.read(), /R:owner/, `precondition: the owner must hold the lease (got: ${owner.read().trim()})`);
  const inoHeld = inodeOf(lock);
  const stranger = claimChild(dir, { env: { MYCELIUM_VAULT_FAMILY: 'fam-r2-stranger' } });
  await stranger.settled;
  assert.match(stranger.read(), /R:threw:vault_owned_elsewhere/,
    `a second family must be refused while the lease is held (got: ${stranger.read().trim()})`);
  assert.equal(inodeOf(lock), inoHeld,
    `the held lease's inode changed under a second claimant (${inoHeld} → ${inodeOf(lock)}) — a live owner was nearly truncated out`);
  owner.child.kill('SIGKILL'); stranger.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// ── R3/R4. THE RACE ITSELF, FORCED — asserting the SAFETY property, never two owners. ────
// The test barrier holds every claimant at 'saw-garbage' (each has opened the garbage lease
// and is about to repair), then releases them together — so the repair window is genuinely
// contended EVERY trial, not ~1/16 by luck. R4 (folded in) asserts the barrier engaged, so
// this cannot pass by never racing.
//
// ⚠️ THIS ASSERTS `owners <= 1` (NEVER TWO), NOT `owners === 1`, AND THAT IS THE POINT OF
// D-138. "Never two owners" is the SAFETY guarantee; "exactly one" would additionally demand
// LIVENESS (a winner within the timeout), which a slow child under CI load can miss — turning
// this row into the very flake D-138 is about. So a starved trial (owners 0) passes here and
// the DETERMINISTIC winner-exists property is R1's job; two owners is the only failure. This
// is a cross-process end-to-end backstop for R1's mechanism proof, not the proof itself —
// its regression RED is probabilistic (the probe quantifies the rate), R1's is certain.
await t('R3. N claimants forced into the repair window together NEVER produce two owners', async () => {
  const N = 6; const TRIALS = 8;
  let barrierEngagedTrials = 0;
  for (let i = 0; i < TRIALS; i++) {
    const { dir } = seedGarbage(`r3-${i}`);
    const barrier = join(dir, 'barrier'); mkdirSync(barrier);
    const kids = [];
    for (let k = 0; k < N; k++) kids.push(claimChild(dir, { env: { MYCELIUM_VAULT_FAMILY: `fam-r3-${i}-${k}` }, barrier }));
    // wait until all N announce they reached the critical section, then release together
    const deadline = Date.now() + 15000;
    while (readdirSync(barrier).filter((f) => f.startsWith('reached-saw-garbage-')).length < N && Date.now() < deadline) await sleep(15);
    const reachedN = readdirSync(barrier).filter((f) => f.startsWith('reached-saw-garbage-')).length;
    if (reachedN === N) barrierEngagedTrials++;
    writeFileSync(join(barrier, 'release-saw-garbage'), '1');
    await Promise.all(kids.map((k) => k.settled));
    const owners = kids.filter((k) => /R:owner/.test(k.read())).length;
    assert.ok(owners <= 1,
      `trial ${i}: ${owners} owners of one vault under a forced repair race — two owners is the double-owner race (D-138) resurfacing`);
    for (const k of kids) { try { k.child.kill('SIGKILL'); } catch { /* */ } }
    rmSync(dir, { recursive: true, force: true });
  }
  // R4, folded in: the barrier must have engaged in AT LEAST ONE trial, or R3's "never two"
  // says nothing (the M-001 "green because nothing ran" trap). It is DELIBERATELY not
  // `=== TRIALS`: requiring every trial to win the spawn-race within the deadline would make
  // this gate RED on correct code under CI load — reintroducing the very D-138 flake class in
  // the precondition. One genuinely-forced trial proves the race is exercised; the rest still
  // assert `owners <= 1` regardless of whether the barrier fully engaged.
  assert.ok(barrierEngagedTrials >= 1,
    `the forced-race barrier engaged in 0/${TRIALS} trials — all N never entered the window together in any trial, so the race was never exercised`);
});

// ── R6. THE APP'S OWN LAUNCH PATH: same-family claimants are never REFUSED. ──────────────
// The safety fix (inode-stable repair) traded one bug for a LIVENESS bug: a guard-loser got a
// still-garbage handle back from openLockFile, so claimVaultOwnership's BEGIN EXCLUSIVE threw
// SQLITE_NOTADB and REFUSED with `vault_not_owned` — turning away the app's OWN second sibling
// on a garbage-lease launch (measured pre-fix: 23 refusals in 20 same-family trials). The fix
// makes openLockFile repair-then-REVALIDATE-then-retry. This row forces the same-family race and
// asserts ZERO `vault_not_owned` refusals. It also catches a TOTAL-BREAKAGE regression (nobody
// can claim) that R3's safety-only `owners <= 1` passes through.
//
// It counts ONLY `vault_not_owned` (the D1 signal from a garbage handle), NOT the rare pre-existing
// mid-claim `vault_owned_elsewhere` window — so it targets D1 precisely and does not flake on an
// unrelated race. With inode-stable repair the inode-mismatch source of `vault_not_owned` cannot
// fire, so a green here means the garbage-handle path is genuinely closed.
await t('R6. same-family claimants forced into the repair window are never REFUSED (the app launch path)', async () => {
  const N = 6; const TRIALS = 6;
  let vaultNotOwned = 0; let sawOwner = false; let engaged = 0;
  for (let i = 0; i < TRIALS; i++) {
    const { dir } = seedGarbage(`r6-${i}`);
    const barrier = join(dir, 'barrier'); mkdirSync(barrier);
    const fam = `fam-r6-${i}`;                                  // SAME family = the app's sibling launch
    const kids = [];
    for (let k = 0; k < N; k++) kids.push(claimChild(dir, { env: { MYCELIUM_VAULT_FAMILY: fam }, barrier }));
    const deadline = Date.now() + 15000;
    while (readdirSync(barrier).filter((f) => f.startsWith('reached-saw-garbage-')).length < N && Date.now() < deadline) await sleep(15);
    if (readdirSync(barrier).filter((f) => f.startsWith('reached-saw-garbage-')).length === N) engaged++;
    writeFileSync(join(barrier, 'release-saw-garbage'), '1');
    await Promise.all(kids.map((k) => k.settled));
    for (const k of kids) {
      if (/R:owner/.test(k.read())) sawOwner = true;
      if (/R:threw:vault_not_owned/.test(k.read())) vaultNotOwned++;
    }
    for (const k of kids) { try { k.child.kill('SIGKILL'); } catch { /* */ } }
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(engaged >= 1, `the barrier engaged in 0/${TRIALS} trials — the same-family race was never genuinely forced`);
  assert.ok(sawOwner, 'no claimant ever became owner across any trial — total breakage (nobody can claim the vault)');
  assert.equal(vaultNotOwned, 0,
    `${vaultNotOwned} same-family claimant(s) were REFUSED with vault_not_owned on a garbage-lease launch race — `
    + `the app's own second sibling is turned away (D-138 review D1). A guard-loser must revalidate/retry, not `
    + 'hand back a garbage handle that BEGIN EXCLUSIVE then refuses.');
});

// ── R5. THE SEAM IS INERT IN PRODUCTION. ─────────────────────────────────────────────────
// leaseTestBarrier must be a strict no-op unless MYCELIUM_VAULT_LEASE_TEST_BARRIER is set. A
// normal claim (no barrier env) must complete promptly and leave no barrier artefacts anywhere.
await t('R5. the test barrier is a NO-OP when its env var is unset (the shipped condition)', async () => {
  const { dir } = seedGarbage('r5');
  const t0 = Date.now();
  const owner = claimChild(dir, { env: { MYCELIUM_VAULT_FAMILY: 'fam-r5' } });   // NO barrier passed
  await owner.settled;
  const ms = Date.now() - t0;
  assert.match(owner.read(), /R:owner/, `precondition: the claim must succeed with no barrier armed (got: ${owner.read().trim()})`);
  assert.ok(ms < 6000, `an unarmed claim took ${ms} ms — the seam must not block when its env var is unset`);
  const stray = readdirSync(dir).filter((f) => f.startsWith('reached-') || f.startsWith('release-'));
  assert.equal(stray.length, 0, `the seam wrote barrier artefacts (${stray.join(', ')}) with no env var set — it is not inert`);
  owner.child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

console.log(`\nVERDICT: ${fail === 0 ? 'GO' : 'NO-GO'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
