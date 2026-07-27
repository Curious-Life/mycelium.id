// Verify the DURABLE mind-root relocation migration
// (the mind-root durability-migration design).
//
// The agent's on-disk mind tree used to default to <cwd>/data/mind/mind — in the
// packaged app that is INSIDE the update-replaceable app bundle, so an update
// orphaned the identity capsule. migrateMindRootIfLegacy() moves any pre-existing
// legacy tree to the durable <dataDir>/mind (paths.js mindDir()). This gate proves
// the move is byte-only + decrypt-safe, idempotent, crash-resumable, fail-closed,
// never clobbers a newer capsule, and that the destroy wipe now gets an ABSOLUTE
// mind root. Ends with a VERDICT line; exits non-zero on any FAIL.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import * as realFs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { migrateMindRootIfLegacy } from '../src/mindfiles/migrate-root.js';
// mindDestroyRoots is the SINGLE SOURCE OF TRUTH the REAL destroy route
// (server-rest.js extraRoots) also calls — so asserting against it here (no boot
// needed) means dropping a root from the real wipe REDs this gate (case 12).
import { mindAgentRoot, mindDir, legacyMindDir, mindDestroyRoots } from '../src/paths.js';
import { createMindFiles } from '../src/mindfiles/mind-files.js';

const ledger = [];
const rec = (name, pass, detail) => { ledger.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };

// A fresh (cwd=bundle, dataDir=app_data_dir) sandbox per case; MYCELIUM_AGENT_ROOT unset.
function sandbox() {
  const base = realFs.mkdtempSync(path.join(os.tmpdir(), 'mindmig-'));
  const cwd = path.join(base, 'app');
  const dataDir = path.join(base, 'appdata');
  realFs.mkdirSync(cwd, { recursive: true });
  realFs.mkdirSync(dataDir, { recursive: true });
  const env = { MYCELIUM_DATA_DIR: dataDir };
  return { base, cwd, dataDir, env, legacy: legacyMindDir({ cwd }), dest: mindDir({ env, cwd }) };
}
const seed = (dir, name, bytes) => { realFs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); realFs.writeFileSync(path.join(dir, name), Buffer.from(bytes), { mode: 0o600 }); };
const entriesOf = (dir) => { try { return realFs.readdirSync(dir).sort(); } catch { return null; } };
// A delegating fs whose named methods hit real fs, with per-case overrides.
const USED = ['statSync', 'readdirSync', 'mkdirSync', 'existsSync', 'renameSync', 'cpSync', 'rmSync', 'rmdirSync', 'openSync', 'fsyncSync', 'closeSync'];
function mkFs(overrides = {}) { const o = {}; for (const m of USED) o[m] = (...a) => realFs[m](...a); return Object.assign(o, overrides); }
const EXDEV = () => Object.assign(new Error('cross-device'), { code: 'EXDEV' });

// ── Case 1: clean install → no legacy, no-op, no orphan dir ──────────────────
{
  const s = sandbox();
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd });
  const noDest = !realFs.existsSync(s.dest);
  rec('1. clean install → no-op (no-legacy-tree), no orphan', r.reason === 'no-legacy-tree' && !r.migrated && noDest,
    `reason=${r.reason} migrated=${r.migrated} destAbsent=${noDest}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 2: legacy present → moved + STILL DECRYPTS through readMindFile (A4) ─
{
  const s = sandbox();
  process.env.ENCRYPTION_MASTER_KEY = crypto.randomBytes(32).toString('hex');
  // Write real MIND-magic ciphertext into the legacy location via the same helper
  // the runtime uses. agentRoot=<cwd>/data/mind ⇒ files land at <cwd>/data/mind/mind.
  const legacyWrapper = path.join(s.cwd, 'data', 'mind');
  const mkLegacy = createMindFiles({ agentRoot: legacyWrapper, agentId: 'personal-agent', fs: fsp, path });
  await mkLegacy.writeMindFile('self.md', 'PLAINTEXT-SELF-CAPSULE');
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd });
  const movedToDurable = realFs.existsSync(path.join(s.dest, 'self.md')) && !realFs.existsSync(s.legacy);
  // Read back through a helper pointed at the DURABLE root — proves scope survives the move.
  const mkNew = createMindFiles({ agentRoot: mindAgentRoot({ env: s.env, cwd: s.cwd }), agentId: 'personal-agent', fs: fsp, path });
  const got = await mkNew.readMindFile('self.md');
  rec('2. legacy moved to durable dir AND decrypts post-move (A4)', r.migrated && movedToDurable && got === 'PLAINTEXT-SELF-CAPSULE',
    `migrated=${r.migrated} moved=${movedToDurable} decrypted="${got}"`);
  delete process.env.ENCRYPTION_MASTER_KEY;
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 3: idempotent — a second run is a no-op ─────────────────────────────
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDx');
  const r1 = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd });
  const before = entriesOf(s.dest);
  const r2 = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd });
  const after = entriesOf(s.dest);
  rec('3. idempotent second run is a no-op', r1.migrated && !r2.migrated && r2.reason === 'no-legacy-tree' && JSON.stringify(before) === JSON.stringify(after),
    `run1=${r1.reason} run2=${r2.reason} destStable=${JSON.stringify(before) === JSON.stringify(after)}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 4: destination already populated → refuse (never clobber), retain ───
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDlegacy');
  seed(s.dest, 'self.md', 'MINDnewer');    // a newer capsule already at the durable dir
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd });
  const destUntouched = realFs.readFileSync(path.join(s.dest, 'self.md')).toString() === 'MINDnewer';
  const legacyRetained = realFs.existsSync(path.join(s.legacy, 'self.md'));
  rec('4. dest populated → skip, never clobber, legacy retained', !r.migrated && r.skipped === 1 && destUntouched && legacyRetained,
    `migrated=${r.migrated} skipped=${r.skipped} destKept=${destUntouched} legacyKept=${legacyRetained}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 5: MYCELIUM_AGENT_ROOT pinned → skip entirely ───────────────────────
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDx');
  const r = migrateMindRootIfLegacy({ env: { ...s.env, MYCELIUM_AGENT_ROOT: '/pinned/root' }, cwd: s.cwd });
  const legacyKept = realFs.existsSync(path.join(s.legacy, 'self.md'));
  rec('5. MYCELIUM_AGENT_ROOT pinned → skip, fixture untouched', !r.migrated && r.reason === 'agent-root-pinned' && legacyKept,
    `reason=${r.reason} legacyKept=${legacyKept}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 6: cross-device (EXDEV) fallback → copy, 0o600, source removed after ─
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDcross');
  // Force EXDEV on the initial legacy→dest rename only; let the internal temp
  // publish (src ends with '.migrating') proceed so the copy-fallback can finish.
  const fs = mkFs({ renameSync: (a, b) => { if (!String(a).endsWith('.migrating')) throw EXDEV(); return realFs.renameSync(a, b); } });
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd, fs });
  const atDest = realFs.existsSync(path.join(s.dest, 'self.md'));
  const mode = atDest ? (realFs.statSync(path.join(s.dest, 'self.md')).mode & 0o777) : 0;
  const sourceGone = !realFs.existsSync(path.join(s.legacy, 'self.md'));
  const noTmpLeft = entriesOf(s.dest).every((n) => !n.includes('.migrating-'));
  rec('6. EXDEV → copy-fallback, mode 0600, source removed after publish', r.migrated && atDest && mode === 0o600 && sourceGone && noTmpLeft,
    `migrated=${r.migrated} atDest=${atDest} mode=${mode.toString(8)} sourceGone=${sourceGone} noTmp=${noTmpLeft}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 7: fail-closed — a copy error mid-run keeps the source ──────────────
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDfail');
  const fs = mkFs({ renameSync: () => { throw EXDEV(); }, cpSync: () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); } });
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd, fs });
  const sourceKept = realFs.existsSync(path.join(s.legacy, 'self.md'));
  rec('7. fail-closed on copy error → source retained, boot proceeds', !r.migrated && r.reason === 'error' && sourceKept,
    `reason=${r.reason} error=${r.error} sourceKept=${sourceKept}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 8: snapshots subtree moves intact ───────────────────────────────────
{
  const s = sandbox();
  seed(s.legacy, path.join('snapshots', 'self.md', '2026-07-20.md'), 'MINDsnap');
  seed(s.legacy, 'model.md', 'MINDmodel');
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd });
  const snapOk = realFs.existsSync(path.join(s.dest, 'snapshots', 'self.md', '2026-07-20.md'));
  rec('8. nested snapshots/ subtree relocates intact', r.migrated && snapOk,
    `migrated=${r.migrated} snapshotAtDest=${snapOk}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 9: stale *.tmp is NOT carried ───────────────────────────────────────
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDreal');
  seed(s.legacy, 'self.md.tmp', 'half-written');
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd });
  const tmpAbsent = !realFs.existsSync(path.join(s.dest, 'self.md.tmp'));
  const realMoved = realFs.existsSync(path.join(s.dest, 'self.md'));
  rec('9. stale *.tmp excluded from the move', r.migrated && realMoved && tmpAbsent,
    `realMoved=${realMoved} tmpCarried=${!tmpAbsent}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 10: dev topology where dest is the PARENT of legacy ─────────────────
// dataDir=<cwd>/data ⇒ dest=<cwd>/data/mind, legacy=<cwd>/data/mind/mind.
{
  const base = realFs.mkdtempSync(path.join(os.tmpdir(), 'mindmig-dev-'));
  const cwd = path.join(base, 'repo');
  realFs.mkdirSync(cwd, { recursive: true });
  const env = {};                                  // no MYCELIUM_DATA_DIR ⇒ dataDir=<cwd>/data
  const dest = mindDir({ env, cwd });              // <cwd>/data/mind
  const legacy = legacyMindDir({ cwd });           // <cwd>/data/mind/mind
  const nested = path.resolve(dest) === path.resolve(path.dirname(legacy));
  seed(legacy, 'self.md', 'MINDdev');
  const r = migrateMindRootIfLegacy({ env, cwd });
  const atDest = realFs.existsSync(path.join(dest, 'self.md'));
  const legacyLeafGone = !realFs.existsSync(legacy);
  const destKept = realFs.existsSync(dest);
  rec('10. dev nesting (dest is legacy parent) → files up-leveled, leaf removed', nested && r.migrated && atDest && legacyLeafGone && destKept,
    `nested=${nested} migrated=${r.migrated} atDest=${atDest} leafGone=${legacyLeafGone} destKept=${destKept}`);
  realFs.rmSync(base, { recursive: true, force: true });
}

// ── Case 11: mindDir() is ALWAYS absolute for the destroy wipe (incl. a RELATIVE
//    MYCELIUM_AGENT_ROOT override — review 3A: a relative override must not re-open
//    the isAbsolute-skip hole). ────────────────────────────────────────────────
{
  const absDataDir = path.isAbsolute(mindDir({ env: { MYCELIUM_DATA_DIR: '/var/app' } }));
  const absAbsOverride = path.isAbsolute(mindDir({ env: { MYCELIUM_AGENT_ROOT: '/pinned' } }));
  const absRelOverride = path.isAbsolute(mindDir({ env: { MYCELIUM_AGENT_ROOT: 'rel/dir' }, cwd: '/home/u' }));
  rec('11. mindDir() absolute for destroy (dataDir + absolute AND relative override)', absDataDir && absAbsOverride && absRelOverride,
    `dataDir=${absDataDir} absOverride=${absAbsOverride} relOverride=${absRelOverride}`);
}

// ── Case 12: the REAL destroy roots cover BOTH the durable AND the legacy dir
//    (review 3B: residue in legacy must not survive a factory reset). Asserts the
//    SHARED mindDestroyRoots() that server-rest.js extraRoots() calls — dropping a
//    root from the real wipe REDs this. ─────────────────────────────────────────
{
  const roots = mindDestroyRoots({ env: { MYCELIUM_DATA_DIR: '/var/app' }, cwd: '/bundle/app' });
  const hasDurable = roots.some((r) => r === path.join('/var/app', 'mind'));
  const hasLegacy = roots.some((r) => r === path.join('/bundle/app', 'data', 'mind', 'mind'));
  const allAbs = roots.every((r) => path.isAbsolute(r));
  rec('12. destroy wipes both durable + legacy mind dirs, all absolute', hasDurable && hasLegacy && allAbs && roots.length === 2,
    `durable=${hasDurable} legacy=${hasLegacy} allAbs=${allAbs} count=${roots.length}`);
}

// ── Case 13: the source is unlinked STRICTLY AFTER the post-publish verify. Force
//    EXDEV (drive the copy path) and lie that the published target is absent exactly
//    at the verify — moveEntry must throw and leave the SOURCE intact (never source-
//    gone + dest-unverified). Mutation guard: moving rmSync(src) before the
//    existsSync(tgt) verify makes the source vanish here → this case REDs. ─────────
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDverify');
  const tgt = path.join(s.dest, 'self.md');
  const fs = mkFs({
    // EXDEV on the outer legacy→dest rename only (let the inner temp publish run).
    renameSync: (a, b) => { if (!String(a).endsWith('.migrating')) throw EXDEV(); return realFs.renameSync(a, b); },
    // The published target reports absent AT THE VERIFY (and at the pre-move
    // no-clobber probe, so the move still proceeds) → the durability check fails.
    existsSync: (p) => (path.resolve(p) === path.resolve(tgt) ? false : realFs.existsSync(p)),
  });
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd, fs });
  const sourceKept = realFs.existsSync(path.join(s.legacy, 'self.md'));
  rec('13. unlink strictly AFTER durable-verify → forced verify-fail keeps source', !r.migrated && r.reason === 'error' && sourceKept,
    `reason=${r.reason} sourceKept=${sourceKept}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

// ── Case 14: EXDEV durability ORDER — the copied file's BYTES are fsync'd, and the
//    parent dir is fsync'd after the publish rename, BEFORE the source is unlinked.
//    Locks the fail-closed sequence: fsync(tmp bytes) → rename(tmp→tgt) → fsync(dir)
//    → rm(src). Mutation guards: dropping fsyncCopiedTree (no '.migrating' file
//    fsync) or moving fsyncDir before the rename or removing it REDs this case. ────
{
  const s = sandbox();
  seed(s.legacy, 'self.md', 'MINDorder');
  const tgt = path.join(s.dest, 'self.md');
  const srcFile = path.join(s.legacy, 'self.md');
  const order = [];               // sequence of [op, path]
  const fdPath = new Map();       // fd → the path it was opened on
  const fs = mkFs({
    renameSync: (a, b) => {
      if (!String(a).endsWith('.migrating')) throw EXDEV();   // EXDEV on the outer move
      order.push(['rename', String(a)]); return realFs.renameSync(a, b);
    },
    openSync: (p, ...rest) => { const fd = realFs.openSync(p, ...rest); fdPath.set(fd, String(p)); return fd; },
    fsyncSync: (fd) => { order.push(['fsync', fdPath.get(fd)]); return realFs.fsyncSync(fd); },
    rmSync: (p, ...rest) => { order.push(['rm', String(p)]); return realFs.rmSync(p, ...rest); },
  });
  const r = migrateMindRootIfLegacy({ env: s.env, cwd: s.cwd, fs });
  const idx = (pred) => order.findIndex(pred);
  const iFileFsync = idx(([op, p]) => op === 'fsync' && String(p).endsWith('.migrating'));  // tmp BYTES
  const iRename    = idx(([op, p]) => op === 'rename' && String(p).endsWith('.migrating')); // publish
  const iDirFsync  = idx(([op, p]) => op === 'fsync' && path.resolve(p) === path.resolve(s.dest)); // parent dir
  const iSrcRm     = idx(([op, p]) => op === 'rm' && path.resolve(p) === path.resolve(srcFile)); // unlink source
  const ordered = iFileFsync >= 0 && iRename >= 0 && iDirFsync >= 0 && iSrcRm >= 0 &&
                  iFileFsync < iRename && iRename < iDirFsync && iDirFsync < iSrcRm;
  rec('14. EXDEV durability order: fsync(bytes) → rename → fsync(dir) → rm(src)', r.migrated && ordered,
    `fileFsync=${iFileFsync} rename=${iRename} dirFsync=${iDirFsync} srcRm=${iSrcRm}`);
  realFs.rmSync(s.base, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(64));
const allPass = ledger.every(Boolean);
console.log(`VERDICT: ${allPass ? 'GO — durable mind-root migration: byte-safe, idempotent, fail-closed, no-clobber' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
