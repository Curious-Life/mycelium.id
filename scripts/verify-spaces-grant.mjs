// verify:spaces-grant — regression gate for the shared-spaces authorization anchor
// db.connections.resolveSharedGrant (BU2, shared-spaces redesign 2026-06-30).
//
// Proves the two fail-closed fixes that close the audit's HIGH revocation leak and
// the mutable-identity gap, against a REAL in-memory SQLite DB (CI-safe):
//   D10 — a SPACE only serves while it EXISTS as a live users(type='space') row;
//         a soft-deleted space (type='space_deleted') STOPS serving to old grantees
//         (the cryptographic floor — holds even if a revoke announce was lost).
//   D6  — SPACE serves/mutations bind to the peer's stable remote_did; the mutable
//         verifiedHost fallback is NOT honored for spaces, and a missing did fails closed.
//
// Adversarial coverage: #2 revoked-grant, #3 deleted-space (the HIGH regression),
// #6 did/handle spoof — from docs/SHARED-SPACES-DESIGN-2026-06-30.md §6.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createConnectionsNamespace } from '../src/db/connections.js';

let pass = 0, fail = 0;
const rec = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n      ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

// S0 (BU1) — transit fail-closed: space content carries vault excerpts, so
// /portal/spaces must ride the encrypted portal channel (SENSITIVE_PREFIXES),
// never plain HTTPS. Source guard (CI-safe; the channel-down refusal is the
// deploy-time WebKit smoke).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const secureFetch = readFileSync(join(ROOT, 'portal-app/src/lib/secure-fetch.ts'), 'utf8');
const prefixes = secureFetch.slice(secureFetch.indexOf('SENSITIVE_PREFIXES'), secureFetch.indexOf('isSensitivePath'));
rec(/['"]\/portal\/spaces['"]/.test(prefixes) && /['"]\/portal\/inbound-shares['"]/.test(prefixes),
  'S0. /portal/spaces + /portal/inbound-shares are in SENSITIVE_PREFIXES (encrypted channel, not plain HTTPS)');

// Minimal schema covering only what resolveSharedGrant reads.
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE users (id TEXT PRIMARY KEY, type TEXT);
  CREATE TABLE connections (
    id TEXT PRIMARY KEY, user_a TEXT, user_b TEXT, status TEXT,
    remote_did TEXT, remote_instance TEXT, accepted_at INTEGER
  );
  CREATE TABLE space_access (space_id TEXT, user_id TEXT, role TEXT, revoked_at INTEGER);
`);

// A d1Query adapter over real SQLite (resolveSharedGrant only SELECTs).
const d1Query = async (sql, params = []) => ({ results: db.prepare(sql).all(...(params || [])) });
const conns = createConnectionsNamespace({ d1Query, fetch: async () => { throw new Error('no net'); }, lookup: async () => null });

const OWNER = 'u-owner';        // the local box serving content (toUserId)
const PEER = 'u-peer';          // the granted remote member
const PEER_DID = 'did:web:peer.example';
const PEER_HOST = 'peer.example';
const SPACE = 'space-1';

const seed = () => {
  db.exec('DELETE FROM users; DELETE FROM connections; DELETE FROM space_access;');
  db.prepare(`INSERT INTO users (id,type) VALUES (?,?)`).run(SPACE, 'space');
  db.prepare(`INSERT INTO connections (id,user_a,user_b,status,remote_did,remote_instance,accepted_at) VALUES (?,?,?,?,?,?,?)`)
    .run('c1', OWNER, PEER, 'accepted', PEER_DID, PEER_HOST, 1000);
  db.prepare(`INSERT INTO space_access (space_id,user_id,role,revoked_at) VALUES (?,?,?,?)`)
    .run(SPACE, PEER, 'member', null);
};
const grant = (over = {}) => conns.resolveSharedGrant({
  fromDid: PEER_DID, verifiedHost: PEER_HOST, toUserId: OWNER, kind: 'space', ref: SPACE, ...over,
});

// G1 — baseline: live space + live grant + matching did → GRANTED.
seed();
rec((await grant()).granted === true, 'G1. live space + live grant + matching did → granted');

// G2 (D10, the HIGH leak / adversarial #3): soft-delete the space → STOP serving.
seed();
db.prepare(`UPDATE users SET type='space_deleted' WHERE id=?`).run(SPACE);
rec((await grant()).granted === false, 'G2. soft-deleted space (type=space_deleted) → NOT granted (revocation floor)');

// G3 (adversarial #2): revoked grant → NOT granted.
seed();
db.prepare(`UPDATE space_access SET revoked_at=? WHERE space_id=? AND user_id=?`).run(2000, SPACE, PEER);
rec((await grant()).granted === false, 'G3. revoked grant (revoked_at set) → NOT granted');

// G4 (D6 / adversarial #6): a peer whose did does NOT match (host-only match attempt)
// must NOT be authorized for a space — the host fallback is rejected for spaces.
seed();
rec((await grant({ fromDid: 'did:web:attacker.example' })).granted === false,
  'G4. wrong did (host matches but did does not) → NOT granted (D6: no host fallback for spaces)');

// G5 (D6): a space op with NO presented did fails closed.
seed();
rec((await grant({ fromDid: undefined })).granted === false, 'G5. space op with no did → fail-closed NOT granted');

// G6 (D6 negative-control): the SAME host-only scenario IS still honored for a
// non-space kind (context) — proves we only tightened spaces, not everything.
seed();
db.exec(`CREATE TABLE IF NOT EXISTS sharing_contexts (id TEXT, user_id TEXT, is_private INTEGER);
         CREATE TABLE IF NOT EXISTS context_grants (context_id TEXT, connection_id TEXT);`);
db.prepare(`INSERT INTO sharing_contexts (id,user_id,is_private) VALUES (?,?,?)`).run('ctx-1', OWNER, 0);
db.prepare(`INSERT INTO context_grants (context_id,connection_id) VALUES (?,?)`).run('ctx-1', 'c1');
const ctxHostOnly = await conns.resolveSharedGrant({ fromDid: undefined, verifiedHost: PEER_HOST, toUserId: OWNER, kind: 'context', ref: 'ctx-1' });
rec(ctxHostOnly.granted === true, 'G6. context kind still honors the host fallback (only spaces were tightened)');

// G7 (adversarial #1): an unknown peer (no accepted connection) → NOT granted.
seed();
db.exec('DELETE FROM connections;');
rec((await grant()).granted === false, 'G7. unknown peer (no accepted connection) → NOT granted');

// G8 (decision #6 / review converge): a LEGACY connection (remote_did NULL) with a
// valid space grant, peer presenting a matching did → still fail-closed (NOT granted),
// but the denial is LOGGED (not silent) so operators can run the 0018 backfill.
seed();
db.prepare(`UPDATE connections SET remote_did=NULL WHERE id=?`).run('c1');
const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => warnings.push(a.join(' '));
let legacyDenied;
try { legacyDenied = (await grant()).granted === false; } finally { console.warn = origWarn; }
rec(legacyDenied && warnings.some((w) => /lacks a bound remote_did/.test(w)),
  'G8. legacy NULL-remote_did grant → NOT granted AND logged (decision #6, not silent)',
  `denied=${legacyDenied} logged=${warnings.length > 0}`);

db.close();
console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail === 0
  ? 'VERDICT: GO — resolveSharedGrant fail-closed: deleted-space + revoked + did-bound (D6/D10)'
  : 'VERDICT: NO-GO — see FAIL rows');
process.exit(fail === 0 ? 0 : 1);
