// tests/federation-integration.test.js — END-TO-END Tier-0 against the REAL stack:
// boot() (real getDb/better-sqlite3 vault + identity + federation tools) and the
// REAL express router, driving a signed connect that persists to the actual DB.
//
// Skips cleanly when better-sqlite3/express aren't installed, so dependency-light
// environments still pass; CI (deps installed) runs it for real.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let HAVE_DEPS = true;
let Database, express, boot, applyMigrations, createFederationRouter, createIdentity, buildDidDocument, canonicalize;
try {
  ({ default: Database } = await import('better-sqlite3'));
  ({ default: express } = await import('express'));
  ({ boot } = await import('../src/index.js'));
  ({ applyMigrations } = await import('../src/db/migrate.js'));
  ({ createFederationRouter } = await import('../src/federation/router.js'));
  ({ createIdentity } = await import('../src/identity/identity.js'));
  ({ buildDidDocument } = await import('../src/federation/did.js'));
  ({ canonicalize } = await import('../src/federation/sign.js'));
} catch { HAVE_DEPS = false; }

describe('federation integration (real boot + express + sqlite)', { skip: !HAVE_DEPS ? 'better-sqlite3/express not installed' : false }, () => {
  let dir, booted, server, port, prevHost;
  const BOB = createIdentity({ masterHex: 'b'.repeat(64), handle: 'bob' });
  const BOB_HOST = 'bob.mycelium.id';
  // shim: alice's box resolves bob's did:web by serving bob's real did doc
  const fetchShim = async (url, init) => {
    assert.equal(init.redirect, 'manual');
    if (url === `https://${BOB_HOST}/.well-known/did.json`) {
      return { ok: true, status: 200, async json() { return buildDidDocument(BOB_HOST, BOB.publicKeyB64); } };
    }
    return { ok: false, status: 404, async json() { return {}; } };
  };

  before(async () => {
    prevHost = process.env.MYCELIUM_PUBLIC_HOST;
    process.env.MYCELIUM_PUBLIC_HOST = 'alice.mycelium.id'; // → identity handle "alice", did:web host
    dir = mkdtempSync(join(tmpdir(), 'myc-fed-'));
    const dbPath = join(dir, 'vault.db');
    applyMigrations(new Database(dbPath));
    const hex = () => crypto.randomBytes(32).toString('hex');
    booted = await boot({ dbPath, kcvPath: join(dir, 'kcv.json'), userHex: hex(), systemHex: hex(), embedder: null });

    const app = express();
    app.use(express.json());
    app.use(createFederationRouter({
      db: booted.db, userId: booted.userId, identity: booted.identity,
      getHost: () => 'alice.mycelium.id', getHandle: () => 'alice', fetch: fetchShim,
    }));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });

  after(() => {
    try { server?.close(); } catch {}
    try { booted?.close?.(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
    if (prevHost === undefined) delete process.env.MYCELIUM_PUBLIC_HOST; else process.env.MYCELIUM_PUBLIC_HOST = prevHost;
  });

  it('boot() registers the 3 federation tools and an identity bound to the public host', () => {
    const names = booted.tools.map((t) => t.name);
    for (const t of ['requestConnection', 'listConnectionRequests', 'respondToConnectionRequest']) assert.ok(names.includes(t), `missing tool ${t}`);
    assert.equal(booted.identity.handle, 'alice');
    assert.equal(booted.publicHost, 'alice.mycelium.id');
  });

  it('serves did.json over real express with the booted identity key', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/.well-known/did.json`);
    assert.equal(r.status, 200);
    const doc = await r.json();
    assert.equal(doc.id, 'did:web:alice.mycelium.id');
    const { fromMultibase } = await import('../src/federation/did.js');
    assert.equal(fromMultibase(doc.verificationMethod[0].publicKeyMultibase), booted.identity.publicKeyB64);
  });

  it('accepts a signed connect and persists a pending connection in the real vault', async () => {
    const payload = {
      $type: 'social.mycelium.connect-request.v1',
      from_handle: 'bob', from_instance: BOB_HOST, from_did: `did:web:${BOB_HOST}`,
      to_handle: 'alice', nonce: crypto.randomUUID(), ts: Date.now(),
      profile: { signature: 'thinks in graphs' },
    };
    const body = canonicalize(payload);
    const r = await fetch(`http://127.0.0.1:${port}/federation/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myc-did': `did:web:${BOB_HOST}`, 'x-myc-sig': BOB.sign(body) },
      body,
    });
    assert.equal(r.status, 202);

    // The pending connection is queryable through the real namespace + the raw DB.
    const pend = await booted.db.connections.pending(booted.userId);
    assert.ok(pend.some((c) => c.remote_user_handle === 'bob' || c.display_name === `bob@${BOB_HOST}`), 'bob appears in pending()');
    const prof = await booted.db.rawQuery(`SELECT user_id, display_name FROM user_profiles WHERE user_id = ?`, [`did:web:${BOB_HOST}`]);
    assert.equal(prof.results?.[0]?.display_name, `bob@${BOB_HOST}`);
  });

  it('completes the handshake: a signed connect-response flips a pending sent row to accepted', async () => {
    // simulate that we (alice) earlier requested bob → a local pending "sent" row
    const cid = crypto.randomUUID();
    await booted.db.rawQuery(
      `INSERT INTO connections (id, user_a, user_b, initiated_by, status, remote_instance, remote_user_handle, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
      [cid, booted.userId, `bob@${BOB_HOST}`, booted.userId, BOB_HOST, 'bob'],
    );
    const payload = {
      $type: 'social.mycelium.connect-response.v1',
      from_handle: 'bob', from_instance: BOB_HOST, from_did: `did:web:${BOB_HOST}`,
      to_handle: 'alice', action: 'accept', nonce: crypto.randomUUID(), ts: Date.now(),
      profile: { signature: 'thinks in graphs' },
    };
    const body = canonicalize(payload);
    const r = await fetch(`http://127.0.0.1:${port}/federation/connect-response`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myc-did': `did:web:${BOB_HOST}`, 'x-myc-sig': BOB.sign(body) },
      body,
    });
    assert.equal(r.status, 202);
    const row = await booted.db.rawQuery(`SELECT status FROM connections WHERE id = ?`, [cid]);
    assert.equal(row.results[0].status, 'accepted');
    const list = await booted.db.connections.list(booted.userId);
    assert.ok(list.some((c) => c.id === cid), 'now appears in connections list');
  });

  it('rejects a tampered connect end-to-end (fail closed, 401)', async () => {
    const payload = { $type: 'social.mycelium.connect-request.v1', from_handle: 'bob', from_instance: BOB_HOST, from_did: `did:web:${BOB_HOST}`, to_handle: 'alice', nonce: crypto.randomUUID(), ts: Date.now(), profile: {} };
    const sig = BOB.sign(canonicalize(payload));
    payload.to_handle = 'mallory';
    const r = await fetch(`http://127.0.0.1:${port}/federation/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myc-did': `did:web:${BOB_HOST}`, 'x-myc-sig': sig },
      body: canonicalize(payload),
    });
    assert.equal(r.status, 401);
  });
});
