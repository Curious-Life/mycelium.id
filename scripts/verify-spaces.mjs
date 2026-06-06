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

  // Seed bob as a real local user so the members JOIN renders a name.
  await db._base.d1Query(`INSERT INTO users (id, display_name, type) VALUES ('bob', 'Bob', 'human')`, []);

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
  rec('owner grants bob member access', (await call(owner.port, 'POST', `/portal/spaces/${sid}/shares`, { granteeId: 'bob', role: 'member' })).status === 200);
  rec('bob appears in members', (await call(owner.port, 'GET', `/portal/spaces/${sid}/members`)).json.members.some((m) => m.user_id === 'bob'));
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

  owner.server.close(); bob.server.close(); intruder.server.close(); close?.();
  rmSync(dir, { recursive: true, force: true });

  const pass = ledger.every(Boolean);
  console.log(`\n${'='.repeat(64)}\nVERDICT: ${pass ? 'GO' : 'NO-GO'} — ${ledger.filter(Boolean).length}/${ledger.length} checks passed\n${'='.repeat(64)}\n`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('verify:spaces crashed:', e); process.exit(2); });
