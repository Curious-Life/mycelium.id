// verify:destroy-paths — a factory reset must wipe the EFFECTIVE artifact paths,
// not a bare dataDir() (QA P0.6, "path overrides survive a factory reset").
//
// src/paths.js lets every artifact be relocated INDEPENDENTLY of dataDir via a
// per-item env override. Before this gate, destroyVault wiped dataDir()'s
// contents only, so a relocated vault / PASSKEY store / uploads tree / KCV /
// passphrase seal / remote config survived the reset WHILE THE KEYCHAIN WAS
// DESTROYED AROUND IT — the user was told everything was gone.
//
//   P1  relocatedArtifactPaths() lists EVERY override that points outside dataDir
//   P2  …and lists NOTHING in a default install (all artifacts live under dataDir)
//   P3  an override pointing INSIDE dataDir is omitted (the dir wipe covers it)
//   P4  a relocated MYCELIUM_DB drags its whole file family (-wal/-shm + the
//       .search.db sidecar and ITS wal/shm) — the sidecar rule matches sidecar.js
//   P5  destroyExtraRoots() = mindDestroyRoots() ∪ relocatedArtifactPaths()
//   P6  END-TO-END: destroyVault with those extraRoots actually DELETES a
//       relocated auth.db (passkeys) + uploads tree living outside dataDir
//   P7  ':memory:' is dropped (nothing on disk); a RELATIVE override is wiped at
//       the same absolute path the app actually opens
//   P8  a hostile/mis-set override ($HOME, '/Users') is REFUSED by the engine and
//       RECORDED — never silently skipped, never recursed
//
// Pure fs against an ABSOLUTE temp dir; no vault boot; no network.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { mkdirSync, rmSync, existsSync, writeFileSync, readdirSync, symlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { relocatedArtifactPaths, destroyExtraRoots, mindDestroyRoots, vaultFileFamily, authDbPath } from '../src/paths.js';
import { destroyVault, isSafeDestroyRoot } from '../src/account/destroy.js';
import { sidecarPath } from '../src/search/sqlite/sidecar.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };

const ROOT = join(process.cwd(), 'data', 'verify-destroy-paths');
const DATA = join(ROOT, 'appdata');
const ELSEWHERE = join(ROOT, 'elsewhere');
rmSync(ROOT, { recursive: true, force: true });

// Every per-item override, pointed OUTSIDE dataDir.
const relocated = {
  MYCELIUM_DATA_DIR: DATA,
  MYCELIUM_DB: join(ELSEWHERE, 'vault', 'mycelium.db'),
  MYCELIUM_KCV: join(ELSEWHERE, 'keys', 'kcv.json'),
  MYCELIUM_AUTH_DB: join(ELSEWHERE, 'auth', 'auth.db'),          // PASSKEYS
  MYCELIUM_UPLOADS_ROOT: join(ELSEWHERE, 'blobs'),
  MYCELIUM_VAULT_LOCK: join(ELSEWHERE, 'seal', 'vault-lock.json'),
  MYCELIUM_REMOTE_CONFIG: join(ELSEWHERE, 'cfg', 'remote.json'),
  MYCELIUM_VOICE_SAMPLES_ROOT: join(ELSEWHERE, 'voice'),
};
const CWD = join(ROOT, 'cwd');

// ── P1 every relocated override is listed ────────────────────────────────────
const listed = relocatedArtifactPaths({ env: relocated, cwd: CWD });
const missing = Object.entries(relocated)
  .filter(([k]) => k !== 'MYCELIUM_DATA_DIR')
  .filter(([, v]) => !listed.includes(v))
  .map(([k]) => k);
rec('P1 every relocated artifact (db, KCV, PASSKEY auth.db, uploads, lock, remote.json, voice) is listed',
  missing.length === 0, missing.length ? `MISSING: ${missing.join(', ')}` : `${listed.length} paths`);

// ── P2 default install lists nothing ─────────────────────────────────────────
const def = relocatedArtifactPaths({ env: { MYCELIUM_DATA_DIR: DATA }, cwd: CWD });
rec('P2 default install (no overrides) → no extra roots', def.length === 0, JSON.stringify(def));

// ── P3 an override INSIDE dataDir is omitted (dir wipe covers it) ────────────
const inside = relocatedArtifactPaths({ env: { MYCELIUM_DATA_DIR: DATA, MYCELIUM_AUTH_DB: join(DATA, 'sub', 'auth.db') }, cwd: CWD });
rec('P3 override pointing INSIDE dataDir is omitted (recursive dir wipe covers it)', inside.length === 0, JSON.stringify(inside));

// ── P4 relocated db drags its whole sqlite/sidecar family ────────────────────
const db = relocated.MYCELIUM_DB;
const family = vaultFileFamily(db);
const familyCovered = family.every((f) => listed.includes(f));
// The sidecar rule must MATCH the real sidecar resolver (they are duplicated so
// paths.js stays a dependency-free leaf).
const sidecarAgrees = family.includes(sidecarPath(db));
rec('P4 relocated MYCELIUM_DB drags -wal/-shm + .search.db (+its wal/shm); sidecar rule matches sidecar.js',
  familyCovered && sidecarAgrees, `family=${family.length} sidecarAgrees=${sidecarAgrees}`);

// ── P5 destroyExtraRoots is the union ────────────────────────────────────────
const roots = destroyExtraRoots({ env: relocated, cwd: CWD });
const minds = mindDestroyRoots({ env: relocated, cwd: CWD });
rec('P5 destroyExtraRoots = mindDestroyRoots ∪ relocatedArtifactPaths',
  minds.every((m) => roots.includes(m)) && listed.every((p) => roots.includes(p)),
  `roots=${roots.length} minds=${minds.length} relocated=${listed.length}`);

// ── P6 END-TO-END: the engine actually deletes them ──────────────────────────
function seed() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'inside.db'), 'x');
  for (const p of [relocated.MYCELIUM_DB, relocated.MYCELIUM_KCV, relocated.MYCELIUM_AUTH_DB, relocated.MYCELIUM_VAULT_LOCK, relocated.MYCELIUM_REMOTE_CONFIG]) {
    mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'SENSITIVE');
  }
  writeFileSync(`${relocated.MYCELIUM_DB}-wal`, 'WAL');
  writeFileSync(sidecarPath(relocated.MYCELIUM_DB), 'INDEX');
  for (const d of [relocated.MYCELIUM_UPLOADS_ROOT, relocated.MYCELIUM_VOICE_SAMPLES_ROOT]) {
    mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'blob.enc'), 'ENC');
  }
}
seed();
let keychainLast = false;
const survivors = () => [
  relocated.MYCELIUM_DB, `${relocated.MYCELIUM_DB}-wal`, sidecarPath(relocated.MYCELIUM_DB),
  relocated.MYCELIUM_KCV, relocated.MYCELIUM_AUTH_DB, relocated.MYCELIUM_VAULT_LOCK,
  relocated.MYCELIUM_REMOTE_CONFIG, relocated.MYCELIUM_UPLOADS_ROOT, relocated.MYCELIUM_VOICE_SAMPLES_ROOT,
].filter((p) => existsSync(p));
const r6 = await destroyVault({
  dataDir: DATA,
  extraRoots: destroyExtraRoots({ env: relocated, cwd: CWD }),
  deleteKeychain: () => { keychainLast = survivors().length === 0 && readdirSync(DATA).length === 0; },
});
const left = survivors();
rec('P6 END-TO-END: relocated vault/PASSKEY-db/KCV/uploads/seal/remote/voice all wiped, keys still LAST',
  left.length === 0 && keychainLast && r6.failed.length === 0,
  left.length ? `SURVIVED: ${left.map((p) => p.replace(ROOT, '…')).join(', ')}` : `keychainLast=${keychainLast} failed=${JSON.stringify(r6.failed)}`);

// ── P7 ':memory:' drops out; a RELATIVE override still resolves to the exact
//    absolute file the app opens (paths.js `under` → path.resolve) and is wiped.
const p7env = { MYCELIUM_DATA_DIR: DATA, MYCELIUM_DB: ':memory:', MYCELIUM_AUTH_DB: 'rel/auth.db' };
const p7 = relocatedArtifactPaths({ env: p7env, cwd: CWD });
const memoryDropped = !p7.some((p) => p.includes(':memory:'));
const relResolved = p7.includes(authDbPath({ env: p7env }));
rec('P7 ":memory:" drops out; a RELATIVE override is wiped at the SAME absolute path the app opens',
  memoryDropped && relResolved && p7.length === 1, JSON.stringify(p7));

// ── P8 hostile override refused + recorded ───────────────────────────────────
// The PREDICATE is unit-tested against the real dangerous values; the ENGINE is
// only ever handed values that stay harmless even if the guard is mutated away
// (a non-existent one-segment path). Never hand $HOME or '/' to a recursive rm
// in a test — a mutation run would then destroy the developer's machine.
const home = os.homedir();
const predicateOk = isSafeDestroyRoot(home) === false
  && isSafeDestroyRoot('/Users') === false
  && isSafeDestroyRoot('/') === false
  && isSafeDestroyRoot('') === false
  && isSafeDestroyRoot('relative/path') === false
  && isSafeDestroyRoot(join(ELSEWHERE, 'blobs')) === true;
seed();
const r8 = await destroyVault({
  dataDir: DATA,
  extraRoots: ['/mycelium-verify-nonexistent-oneseg', '', 'relative/path'],
  deleteKeychain: () => {},
});
const refused = r8.failed.filter((f) => f.error === 'unsafe-extra-root-skipped').length;
rec('P8 predicate refuses $HOME / "/Users" / "/" / relative; engine RECORDS every refusal, never recurses',
  predicateOk && refused === 3,
  `predicateOk=${predicateOk} refused=${refused} failed=${JSON.stringify(r8.failed)}`);

// ── P9 case-insensitive-FS / firmlink / symlink ALIAS of $HOME is refused ─────
// (review round-3, CRITICAL). String equality against $HOME is bypassed by any
// spelling that resolves to the same inode: a lowercased path on case-insensitive
// APFS, a /System/Volumes/Data firmlink, or a plain symlink. The guard must
// canonicalize (device+inode) and REFUSE every alias. This is PREDICATE-ONLY —
// exactly like P8, an aliased $HOME is NEVER handed to the recursive rm, because a
// mutation run (revert to string-equality) would then wipe the real home dir.
//
// The load-bearing assertion is cross-platform: a real dir stood up as "home"
// plus a SYMLINK to it. string-equality passes the symlink (distinct string);
// the inode/realpath guard refuses it. This reds on both macOS and Linux CI when
// the guard is reverted. The macOS-only literal spellings (/users, firmlink) are
// asserted only where they actually alias (darwin), since on a case-SENSITIVE FS
// they are genuinely different, non-existent paths and correctly allowed.
{
  const homeReal = join(ROOT, 'home', 'operator');
  mkdirSync(homeReal, { recursive: true });
  const homeAlias = join(ROOT, 'home-alias');           // symlink → homeReal (same inode)
  symlinkSync(homeReal, homeAlias);
  const insideAlias = join(ROOT, 'inside-alias');       // symlink → a dir INSIDE home (safe)
  const safeChild = join(homeReal, 'vault');
  mkdirSync(safeChild, { recursive: true });
  symlinkSync(safeChild, insideAlias);

  // Cross-platform: the symlinked $HOME must be REFUSED (aliases the same inode);
  // a symlink to a dir INSIDE $HOME is a legitimate target and stays allowed.
  const symlinkRefused = isSafeDestroyRoot(homeAlias, { home: homeReal }) === false;
  const childAllowed = isSafeDestroyRoot(insideAlias, { home: homeReal }) === true;

  // Platform-specific literal spellings that alias the REAL $HOME only on a
  // case-insensitive / firmlinked filesystem (darwin). Skipped elsewhere.
  let literalAliasesRefused = true;
  if (process.platform === 'darwin') {
    const realHome = os.homedir();                                  // e.g. /Users/alice
    const lowered = realHome.replace(/^\/Users\//, '/users/');       // case-variant → same inode
    const firmlink = join('/System/Volumes/Data', realHome.replace(/^\//, '')); // firmlink → same inode
    const usersAlias = '/users';                                     // case-variant of /Users
    for (const alias of [lowered, firmlink, usersAlias]) {
      if (isSafeDestroyRoot(alias) !== false) { literalAliasesRefused = false; break; }
    }
  }

  rec('P9 a case-insensitive / firmlink / symlink ALIAS of $HOME (or /Users) is REFUSED (canonical dev+inode guard, not string ===)',
    symlinkRefused && childAllowed && literalAliasesRefused,
    `symlinkRefused=${symlinkRefused} childAllowed=${childAllowed} literalAliasesRefused=${literalAliasesRefused} platform=${process.platform}`);
}

// ── P10 an UNRESOLVABLE candidate (non-ENOENT stat error) is FAIL-CLOSED ──────
// isSafeDestroyRoot promises: only a genuinely-absent leaf (ENOENT) stays wipeable;
// ANY other stat error (EACCES/ELOOP/…) → REFUSED, because a path we cannot
// canonicalize cannot be proven not to alias a forbidden root. Before this, the
// non-ENOENT arm of the catch was UNTESTED: flipping it to fail-open (`return true`)
// reddened no case (P8/P9 feed only absent paths and clean symlinks). A self-referential
// symlink makes statSync throw ELOOP — the one candidate that exercises the catch's
// else-branch. PREDICATE-ONLY: like P8/P9, an unresolvable path is NEVER handed to the
// recursive rm. Mutation: flip the non-ENOENT catch to `return true` → this reds.
{
  const loopDir = join(ROOT, 'loopdir');
  mkdirSync(loopDir, { recursive: true });
  const loop = join(loopDir, 'loop');                 // loop → itself
  try { symlinkSync(loop, loop); } catch { /* already present from a prior run */ }
  let statCode = null;
  try { statSync(loop); } catch (e) { statCode = e?.code; } // sanity: statSync really throws here
  const refused = isSafeDestroyRoot(loop) === false;
  rec('P10 an unresolvable candidate (symlink-loop → ELOOP) is REFUSED — fail-closed on any non-ENOENT stat error',
    refused && statCode && statCode !== 'ENOENT',
    `refused=${refused} statCode=${statCode}`);
}

rmSync(ROOT, { recursive: true, force: true });
const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO — factory reset wipes the EFFECTIVE artifact paths, not a bare dataDir');
