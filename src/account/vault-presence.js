// src/account/vault-presence.js — the ONE answer to "does a vault live here?".
//
// D-080 (P0, data loss, 2026-07-27). Every layer that could have refused was
// asking a different question, and all of them asked it of the WRONG FILE:
// src/server-rest.js and src/account/router.js both tested existsSync(kcv.json)
// — a sidecar VERIFIER — and concluded "no vault yet" when it was missing. The
// vault itself, mycelium.db, was never consulted. A vault whose sidecar is gone
// (a hand-copied data dir, a cleared Keychain, a restore that landed only the
// db, a partial wipe) therefore read as "brand new machine" and the boot fell
// through to setup mode.
//
// THE RULE: a vault is present if EITHER artifact is present. The db is the
// data; the kcv is the proof of which key opens it. Losing either one is a
// damaged vault to be recovered, never an empty machine to be initialised.
// Asking about only one of them is what cost a vault — so nothing in this
// codebase should call existsSync() on a vault artifact directly again; call
// this instead.
import { existsSync } from 'node:fs';

/**
 * @param {{ dbPath?: string, kcvPath?: string }} paths
 * @returns {{ db: boolean, kcv: boolean, any: boolean }}
 *   db  — mycelium.db is on disk (the DATA; irreplaceable)
 *   kcv — kcv.json is on disk (the key-check verifier; proves which key opens it)
 *   any — anything at all lives here, so this is NOT a fresh machine
 */
export function vaultPresence({ dbPath, kcvPath } = {}) {
  const db = Boolean(dbPath) && existsSync(dbPath);
  const kcv = Boolean(kcvPath) && existsSync(kcvPath);
  return { db, kcv, any: db || kcv };
}

/**
 * The operator-facing sentence for a vault that is here but will not open. It
 * names the real cause and the real recovery — never "not set up yet", which is
 * the lie that ended in an empty vault. Carries NO key material (CLAUDE.md §1).
 */
export function unopenableVaultMessage({ dbPath, kcvPath, reason } = {}) {
  const { db, kcv } = vaultPresence({ dbPath, kcvPath });
  const what = db && kcv ? 'A vault exists here' : db ? 'A vault exists here (its kcv.json verifier is missing)' : 'A vault key-verifier exists here (its mycelium.db is missing)';
  return [
    `RECOVERY MODE: ${what} that this key cannot open${reason ? ` (${reason})` : ''}.`,
    `  vault: ${dbPath || '(unset)'}`,
    '  Nothing has been created, moved or overwritten, and nothing will be.',
    '  This is almost always a key problem, not a data problem — the data is still there.',
    '  To recover: unlock this vault with its own 64-character recovery key, or restore a',
    '  .myvault backup over this directory. To start a genuinely NEW vault instead, move',
    '  this directory aside first — Mycelium will not do that for you.',
  ].join('\n');
}

export default vaultPresence;
