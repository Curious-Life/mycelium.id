/**
 * One-time relocation of the agent's on-disk mind tree to a DURABLE location.
 *
 * The mind capsule (self.md loaded every turn, model.md, flagged.md, the mirror
 * docs, snapshots/, .authorship.json) used to default to <cwd>/data/mind/mind.
 * In the packaged app cwd is the code-signed, update-replaceable bundle
 * (resource_dir/app), so an app update orphaned/wiped the identity capsule. The
 * durable location is now <dataDir>/mind (paths.js mindDir(), under app_data_dir
 * exactly like mycelium.db). This helper moves any pre-existing legacy tree to the
 * new location.
 *
 * Properties (all load-bearing):
 *  - BYTE-ONLY. Files are moved verbatim, never decrypted/re-encrypted. Safe
 *    because mind-file scope is inferred from the RELATIVE `mind/<filename>`
 *    suffix + agent_id (crypto-local.js inferScope), NOT the absolute parent —
 *    so relocating the parent dir leaves decryptability unchanged. NEEDS NO KEY.
 *  - FAIL-CLOSED (data safety, not availability). A source entry is removed only
 *    AFTER its target is durably in place. Any error leaves the source intact under
 *    the legacy dir and returns { migrated:false } without aborting boot — DATA is
 *    never lost. Note the runtime resolvers now read the DURABLE dir, so after a
 *    failed/partial move the capsule may be empty or split until a later boot
 *    resumes (the whole tree is retried, idempotently); the data is safe in legacy
 *    the entire time. A pinned MYCELIUM_AGENT_ROOT disables the move entirely.
 *  - IDEMPOTENT + CRASH-RESUMABLE. Moves entry-by-entry, skipping any target that
 *    already exists (never clobbers a newer capsule). A crash mid-move leaves a
 *    partial split that the next boot finishes. Re-running after completion is a
 *    no-op (legacy gone → no-legacy-tree).
 *  - SERIALIZED. MUST be called while holding .vault-init.lock (initVaultStorage)
 *    so exactly one process performs the move; the exclusive lock is the only
 *    cross-process serialization point (the writer lock is single-family).
 *  - ZERO-LEAKAGE. Logs carry counts + the durable dir only — never file bodies
 *    or names (CLAUDE.md §1). Reason codes are content-free.
 *
 * MYCELIUM_AGENT_ROOT, when set, DISABLES the migration — the operator owns the
 * location (and the verify scripts pin it to a fixture we must not move).
 */
import nodeFs from 'node:fs';
import path from 'node:path';
import { mindDir, legacyMindDir } from '../paths.js';

const isTmp = (name) => name.endsWith('.tmp');

/** fsync one path (a file's BYTES, or a directory's entries) to stable storage. */
function fsyncPath(fs, p) {
  let fd;
  try { fd = fs.openSync(p, 'r'); fs.fsyncSync(fd); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/** best-effort directory fsync (persist a rename's directory entry across a crash).
 *  Directory fsync is platform-fragile (Windows rejects openSync on a dir), so a
 *  failure here is swallowed — it never risks FILE-DATA loss, only whether the
 *  rename replays after a crash; the file bytes are already durable at this point. */
function fsyncDir(fs, dir) {
  try { fsyncPath(fs, dir); } catch { /* not fatal — see moveEntry */ }
}

/**
 * Recursively flush a freshly-COPIED tree to stable storage BEFORE it is published
 * and the source removed: every regular file's BYTES (mandatory — a failure throws
 * so moveEntry keeps the source) and every directory's entries (best-effort), depth
 * first. Without the file-data fsync, a writable cross-volume target + true power
 * loss in the window right after the source unlink could leave the destination
 * present but holding zero/garbage bytes — the "most intimate data" silently lost.
 */
function fsyncCopiedTree(fs, p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) fsyncCopiedTree(fs, path.join(p, name));
    fsyncDir(fs, p);               // persist this dir's entries after its children
  } else {
    fsyncPath(fs, p);              // file BYTES MUST hit disk before the source unlink
  }
}

/**
 * Move one entry (file or subdir) src → tgt.
 *  - Same filesystem: a single atomic rename (preserves bytes + mode).
 *  - Cross-device (EXDEV): copy to a sibling temp → fsync the copied BYTES →
 *    atomic-rename the temp onto tgt → fsync tgt's PARENT DIR (persist the rename
 *    entry) → verify tgt exists → and ONLY THEN unlink the source. The ordering is
 *    load-bearing: the source is removed strictly AFTER the destination bytes AND
 *    the directory entry are durable and verified, so a crash in any window leaves
 *    the source intact (fail-closed — never source-gone + dest-unflushed).
 * Throws on any failure WITHOUT having removed src.
 */
function moveEntry(fs, src, tgt) {
  try {
    fs.renameSync(src, tgt);           // atomic, preserves bytes + mode
    return;
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err; // only fall back on cross-device
  }
  // Cross-device: copy to a sibling temp, flush, publish atomically, verify, unlink.
  // Temp name is DETERMINISTIC (not pid-keyed) so a retry after a crashed prior
  // attempt — under the exclusive .vault-init.lock, so never a concurrent writer —
  // removes the stale partial before re-copying, leaving no orphan in the durable dir.
  const tmp = `${tgt}.migrating`;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* clean slate */ }
  fs.cpSync(src, tmp, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
  fsyncCopiedTree(fs, tmp);            // 1. copied BYTES durable BEFORE we publish
  fs.renameSync(tmp, tgt);             // 2. atomic publish on the destination fs
  fsyncDir(fs, path.dirname(tgt));     // 3. persist the rename's directory entry
  if (!fs.existsSync(tgt)) throw new Error('mind-migrate: destination vanished after publish'); // 4. verify durable
  fs.rmSync(src, { recursive: true, force: true }); // 5. source gone ONLY after verified durable publish
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, fs?: typeof nodeFs, log?: (m:string)=>void }} [opts]
 * @returns {{ migrated: boolean, moved: number, skipped: number, from?: string, to?: string, reason?: string, error?: string }}
 */
export function migrateMindRootIfLegacy({ env = process.env, cwd = process.cwd(), fs = nodeFs, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};

  // 1. Operator pin → never move; they own the path (and verify fixtures live here).
  const pinned = typeof env.MYCELIUM_AGENT_ROOT === 'string' && env.MYCELIUM_AGENT_ROOT.trim();
  if (pinned) return { migrated: false, moved: 0, skipped: 0, reason: 'agent-root-pinned' };

  const dest = mindDir({ env, cwd });
  const legacy = legacyMindDir({ cwd });

  // 2. Self-move guard — legacy already IS the durable dir.
  if (path.resolve(legacy) === path.resolve(dest)) {
    return { migrated: false, moved: 0, skipped: 0, reason: 'already-durable' };
  }

  // 3. Nothing to move: no legacy dir, or only stale *.tmp inside it.
  let entries;
  try {
    if (!fs.statSync(legacy).isDirectory()) return { migrated: false, moved: 0, skipped: 0, reason: 'no-legacy-tree' };
    entries = fs.readdirSync(legacy).filter((n) => !isTmp(n));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { migrated: false, moved: 0, skipped: 0, reason: 'no-legacy-tree' };
    // Unreadable legacy (EACCES on a read-only translocated bundle, etc.): fail-closed no-op.
    return { migrated: false, moved: 0, skipped: 0, reason: 'legacy-unreadable', error: err && err.code };
  }
  if (entries.length === 0) return { migrated: false, moved: 0, skipped: 0, reason: 'no-legacy-tree' };

  // 4. Move each entry into dest. Skip (never clobber) a target that already
  //    exists — a newer capsule or a resumed partial move. Remove source per
  //    entry only after its target lands (moveEntry is itself fail-closed).
  let moved = 0;
  let skipped = 0;
  try {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of entries) {
      const src = path.join(legacy, name);
      const tgt = path.join(dest, name);
      if (fs.existsSync(tgt)) { skipped += 1; continue; }
      moveEntry(fs, src, tgt);
      moved += 1;
    }
    // Best-effort: drop stale *.tmp and remove the legacy leaf if fully drained.
    try {
      for (const name of fs.readdirSync(legacy).filter(isTmp)) fs.rmSync(path.join(legacy, name), { force: true });
    } catch { /* ignore */ }
    try { if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy); } catch { /* leftover skips retained on purpose */ }
  } catch (err) {
    // Fail-closed: whatever moved is durably in dest; the rest stays in legacy for
    // the next boot to finish. Boot proceeds either way.
    say(`[mycelium] mind: relocation interrupted after ${moved} file(s) — will resume next boot`);
    return { migrated: moved > 0, moved, skipped, from: legacy, to: dest, reason: 'error', error: err && (err.code || err.name) };
  }

  if (skipped > 0) {
    say(`[mycelium] mind: relocated ${moved} file(s) to durable dataDir/mind; ${skipped} left in legacy (target already present)`);
  } else if (moved > 0) {
    say(`[mycelium] mind: relocated ${moved} file(s) to durable dataDir/mind`);
  }
  return { migrated: moved > 0, moved, skipped, from: legacy, to: dest, reason: moved > 0 ? 'migrated' : 'nothing-moved' };
}
