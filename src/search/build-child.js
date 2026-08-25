// Parent-side spawner for the search-corpus build child (build-worker.mjs).
//
// The build must run OFF the serving process (the 2026-08-22 search-build
// off-process design): in-process it starves the event loop for minutes on a
// large SQLCipher vault and the connected agent loses its vault tools. This
// module owns the spawn: key material re-resolved from the session pin AT SPAWN
// and handed to the child only via its env OBJECT — never argv, never disk,
// never logged; the child env is an explicit ALLOWLIST (the src/jobs.js
// doctrine). The worker path is hardcoded — never built from request input.
//
// Fail-soft by contract: no pinned session keys (verify scripts, locked vault)
// → { ok:false, reason:'no-session-keys' } and the caller uses the in-process
// build path unchanged. This function never throws.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionKeys } from '../account/session-keys.js';
import { deriveDbKey } from '../account/keystore.js';
import { vaultIsEncrypted } from '../db/open.js';
import { registerCrashKillChild } from '../system/crash-reaper.js';
import { identityEnv } from '../spawn-env.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'build-worker.mjs');

/**
 * @param {object} o
 * @param {string} o.dbPath   the vault file (db._dbPath)
 * @param {string} [o.userId]
 * @param {boolean} [o.force] discard resume state — true rebuild (post-Generate)
 * @param {Function} [o.onProgress] receives { ev:'progress', source, added }
 * @returns {{ ok:boolean, reason?:string, promise?:Promise<object>, stop?:Function }}
 */
export function startBuildChild({ dbPath, userId = 'local-user', force = false, onProgress = null } = {}) {
  const keys = getSessionKeys();
  if (!keys?.userHex || !keys?.systemHex) return { ok: false, reason: 'no-session-keys' };
  if (!dbPath || dbPath === ':memory:') return { ok: false, reason: 'no-db-path' };

  let dbKeyHex = null;
  try { dbKeyHex = vaultIsEncrypted(dbPath) ? deriveDbKey(keys.userHex) : null; } catch { dbKeyHex = null; }

  let child;
  try {
    child = spawn(process.execPath, [WORKER], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...identityEnv(), // USER/LOGNAME/HOME when a Finder/launchd launch omits them
        LANG: process.env.LANG,
        USER_MASTER: keys.userHex,
        SYSTEM_KEY: keys.systemHex,
        MYCELIUM_DB: dbPath,
        MYCELIUM_USER_ID: userId,
        ...(dbKeyHex ? { MYCELIUM_DB_KEY: dbKeyHex } : {}),
        ...(force ? { MYCELIUM_SEARCH_BUILD_FORCE: '1' } : {}),
      },
    });
  } catch (e) {
    return { ok: false, reason: 'spawn-failed', message: String(e?.message || e) };
  }
  registerCrashKillChild(child, 'search-build'); // a crashed parent must reap the builder

  // Worker speaks JSON lines on stderr (counts/timings only). Bounded tail so a
  // misbehaving child can never grow this process's memory.
  let tail = '';
  let last = null;
  let buf = '';
  child.stderr?.on('data', (d) => {
    tail = (tail + d).slice(-2000);
    buf = (buf + d).slice(-65536);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try {
        const ev = JSON.parse(line);
        last = ev;
        if (ev.ev === 'progress') { try { onProgress?.(ev); } catch { /* observer only */ } }
      } catch { /* non-JSON stderr noise */ }
    }
  });
  child.stderr?.on('error', () => { /* pipe died — exit code still arrives */ });

  const promise = new Promise((resolve) => {
    child.on('error', (e) => resolve({ ok: false, reason: 'spawn-failed', message: String(e?.message || e) }));
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true, result: last && last.ev === 'done' ? last : null });
      else {
        resolve({
          ok: false,
          reason: `exit-${code}`,
          message: (last && last.ev === 'error' ? last.message : '') || tail.split('\n').filter(Boolean).pop() || '',
        });
      }
    });
  });

  return { ok: true, promise, stop: () => { try { child.kill('SIGTERM'); } catch { /* already gone */ } } };
}
