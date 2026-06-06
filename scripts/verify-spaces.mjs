// scripts/verify-spaces.mjs — Spaces (Phase A) verify gate.
//
// Boots a REAL vault (getDb + better-sqlite3) and the REAL portalCompatRouter,
// then drives the spaces REST surface over loopback for three principals (owner,
// a granted member "bob", an "intruder"). Proves the default-private access
// model is fail-closed: a non-member sees 404, a granted member gets in, revoke
// locks them back out. Prints a [✓]/[✗] ledger + VERDICT.

import Database from 'better-sqlite3';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb } from '../src/db/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { importMasterKey } from '../src/crypto/crypto-local.js';
import { portalCompatRouter } from '../src/portal-compat.js';

const ledger = [];
const rec = (name, pass, detail = '') => { ledger.push(pass); console.log(`${pass ? '[✓]' : '[✗]'} ${name}${detail ? ` — ${detail}` : ''}`); };

function mountAs(db, userId) {
  const app = express();
  app.use('/api/v1/portal', portalCompatRouter({ db, userId }));
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
async function call(port, method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function main() {
  console.log('\n=== verify:spaces — default-private shareable folders (Phase A) ===\n');
  const dir = mkdtempSync(join(tmpdir(), 'myc-spaces-'));
  applyMigrations(new Database(join(dir, 'v.db')));
  const userKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const systemKey = await importMasterKey(crypto.randomBytes(32).toString('hex'));
  const { db, close } = getDb({ dbPath: join(dir, 'v.db'), userKey, systemKey });

  await db._base.d1Query(`INSERT INTO users (id, display_name, type) VALUES ('owner', 'Owner', 'human')`, []);
  // Seed bob as a real local user + profile + an ACCEPTED connection to owner,
  // so the share grant (which now requires an accepted connection) succeeds.
  await db._base.d1Query(`INSERT INTO users (id, display_name, type) VALUES ('bob', 'Bob', 'human')`, []);
  await db._base.d1Query(`INSERT INTO user_profiles (user_id, handle, display_name, member_since) VALUES ('bob', 'bob', 'Bob', datetime('now'))`, []);
  await db._base.d1Query(`INSERT INTO connections (id, user_a, user_b, initiated_by, status, accepted_at, created_at) VALUES ('conn-ob', 'bob', 'owner', 'bob', 'accepted', datetime('now'), datetime('now'))`, []);
  // Seed a tiny mindscape cluster hierarchy (Realm → Theme → Territory) for the
  // cluster-sharing checks.
  await db._base.d1Query(`INSERT INTO realms (id, realm_id, user_id, name, essence, territory_count) VALUES ('r1', 1, 'owner', 'Systems', 'how things connect', 2)`, []);
  await db._base.d1Query(`INSERT INTO semantic_themes (id, realm_id, semantic_theme_id, user_id, name, essence, territory_count) VALUES ('th1', 1, 10, 'owner', 'Distributed', 'spread out', 1)`, []);
  await db._base.d1Query(`INSERT INTO territory_profiles (territory_id, user_id, realm_id, semantic_theme_id, name, essence) VALUES (100, 'owner', 1, 10, 'Consensus', 'agreement protocols')`, []);

  const owner = await mountAs(db, 'owner');
  const bob = await mountAs(db, 'bob');
  const intruder = await mountAs(db, 'intruder');

  // create
  const created = await call(owner.port, 'POST', '/portal/spaces', { name: 'Research', essence: 'shared notes' });
  const sid = created.json?.id;
  rec('owner creates a space (auto-creator)', created.status === 200 && !!sid && created.json.role === 'creator');
  rec('space appears in owner list', (await call(owner.port, 'GET', '/portal/spaces')).json.spaces.some((s) => s.id === sid));

  // default-deny: a non-member cannot even see it exists
  rec('intruder GET space → 404 (default-private, fail closed)', (await call(intruder.port, 'GET', `/portal/spaces/${sid}`)).status === 404);
  rec('intruder cannot add knowledge → 404', (await call(intruder.port, 'POST', `/portal/spaces/${sid}/knowledge`, { content: 'sneaky' })).status === 404);

  // folders + contents + knowledge (owner)
  const room = await call(owner.port, 'POST', `/portal/spaces/${sid}/rooms`, { name: 'Papers' });
  rec('owner creates a nested folder (room)', room.status === 200 && !!room.json.id);
  rec('owner lists rooms', (await call(owner.port, 'GET', `/portal/spaces/${sid}/rooms`)).json.rooms.length === 1);
  rec('owner seeds a document into the folder', (await call(owner.port, 'POST', `/portal/spaces/${sid}/rooms/${room.json.id}/seed-doc`, { documentPath: 'notes/x.md' })).status === 200);
  await call(owner.port, 'POST', `/portal/spaces/${sid}/knowledge`, { content: 'a shared insight' });
  rec('owner adds + lists knowledge', (await call(owner.port, 'GET', `/portal/spaces/${sid}/knowledge`)).json.entries.length === 1);

  // share with bob (grant)
  rec('sharing with a NON-connection is rejected (defense-in-depth)', (await call(owner.port, 'POST', `/portal/spaces/${sid}/shares`, { granteeId: 'stranger', role: 'member' })).status === 400);
  rec('owner grants bob (an accepted connection) member access', (await call(owner.port, 'POST', `/portal/spaces/${sid}/shares`, { granteeId: 'bob', role: 'member' })).status === 200);
  rec('bob appears in members', (await call(owner.port, 'GET', `/portal/spaces/${sid}/members`)).json.members.some((m) => m.user_id === 'bob'));
  // management hub: the shared-with-connection view surfaces this grant
  const sw = await call(owner.port, 'GET', `/portal/connections/conn-ob/shared`);
  rec('management: /connections/:id/shared lists the space shared with bob', sw.json.peer_id === 'bob' && sw.json.spaces.some((s) => s.id === sid));
  rec('granted bob can now read the space', (await call(bob.port, 'GET', `/portal/spaces/${sid}`)).status === 200);
  rec('member bob CANNOT delete the space (needs creator) → 404', (await call(bob.port, 'DELETE', `/portal/spaces/${sid}`)).status === 404);
  rec('intruder STILL 404 after the grant to bob', (await call(intruder.port, 'GET', `/portal/spaces/${sid}`)).status === 404);

  // revoke → bob locked back out
  rec('owner revokes bob', (await call(owner.port, 'DELETE', `/portal/spaces/${sid}/shares/bob`)).status === 200);
  rec('revoked bob → 404 again (fail closed)', (await call(bob.port, 'GET', `/portal/spaces/${sid}`)).status === 404);

  // ── contexts (the "Work Self" granular territory-sharing model) ──────────
  const ctxList = await call(owner.port, 'GET', '/portal/contexts');
  rec('contexts: GET seeds the 4 defaults (incl. a private one)', ctxList.json.contexts.length >= 4 && ctxList.json.contexts.some((c) => c.is_private));
  const ctx = await call(owner.port, 'POST', '/portal/contexts', { name: 'Research Self' });
  const cid = ctx.json?.id;
  rec('contexts: owner creates a context', ctx.status === 200 && !!cid);
  rec('contexts: add a territory to it', (await call(owner.port, 'POST', `/portal/contexts/${cid}/territories/42`)).status === 200);
  rec('contexts: territory appears', (await call(owner.port, 'GET', `/portal/contexts/${cid}/territories`)).json.territories.some((t) => String(t.territory_id) === '42'));
  rec('contexts: intruder cannot mutate someone else’s context → 404 (ownership guard)', (await call(intruder.port, 'POST', `/portal/contexts/${cid}/territories/99`)).status === 404);
  rec('contexts: owner deletes the context', (await call(owner.port, 'DELETE', `/portal/contexts/${cid}`)).status === 200);

  // ── share a cluster at a level (realm / theme / territory) or documents ──
  const hier = await call(owner.port, 'GET', '/portal/spaces/cluster-hierarchy');
  rec('cluster: hierarchy returns Realm→Theme', hier.json.realms?.[0]?.name === 'Systems' && hier.json.realms[0].themes?.[0]?.name === 'Distributed');
  rec('cluster: share a whole REALM into the space', (await call(owner.port, 'POST', `/portal/spaces/${sid}/seed-cluster`, { level: 'realm', realm_id: 1 })).json?.members >= 1);
  rec('cluster: share a THEME', (await call(owner.port, 'POST', `/portal/spaces/${sid}/seed-cluster`, { level: 'theme', realm_id: 1, semantic_theme_id: 10 })).status === 200);
  rec('cluster: share a single TERRITORY', (await call(owner.port, 'POST', `/portal/spaces/${sid}/seed-cluster`, { level: 'territory', territory_id: 100 })).status === 200);
  rec('cluster: invalid level → 400', (await call(owner.port, 'POST', `/portal/spaces/${sid}/seed-cluster`, { level: 'galaxy' })).status === 400);
  rec('cluster: a non-member cannot share into the space → 404', (await call(intruder.port, 'POST', `/portal/spaces/${sid}/seed-cluster`, { level: 'realm', realm_id: 1 })).status === 404);
  const kn = await call(owner.port, 'GET', `/portal/spaces/${sid}/knowledge`);
  rec('cluster: shared clusters appear as knowledge entries', kn.json.entries.some((e) => e.source_type === 'realm') && kn.json.entries.some((e) => e.source_type === 'theme'));

  // ── Phase B foundation: real-sqlite round-trips of the new substrate ─────
  await db.spaceMatrixRooms.bind(sid, '!room:hs.example', 'owner');
  rec('phase-b: space⇄Megolm-room binding round-trips', (await db.spaceMatrixRooms.get(sid))?.room_id === '!room:hs.example');
  await db.identityChannels.upsert({ channel_kind: 'matrix', channel_value: '@owner:hs.example', owner_user_id: 'owner' });
  await db.identityChannels.bindToUser('matrix', '@owner:hs.example', 'owner');
  rec('phase-b: MXID binds via identity_channels', (await db.identityChannels.getByChannel('matrix', '@owner:hs.example'))?.owner_user_id === 'owner');

  owner.server.close(); bob.server.close(); intruder.server.close(); close?.();
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.every(Boolean);
  console.log(`\n${'='.repeat(64)}\nVERDICT: ${pass ? 'GO' : 'NO-GO'} — ${ledger.filter(Boolean).length}/${ledger.length} checks passed\n${'='.repeat(64)}\n`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('verify:spaces crashed:', e); process.exit(2); });
