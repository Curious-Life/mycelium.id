#!/usr/bin/env node
// verify-e2e-transport.mjs — Phase 2b gate (the E2E-reachability design §2.2).
//
// Drives the box E2E transport over a real HTTP server with the Node E2E-session as
// the phone. The loopback dispatch is a stub that EMULATES the box's own gate
// (device-token authz + revocation); the router enforces the control-surface path block.
//
//   T1 handshake with a live token → sid + msg2, phone finalizes the session
//   T2 rpc round-trips a REAL portal response, SEALED (relay sees ciphertext)
//   T3 the dispatch forwards the device-token Bearer + X-Forwarded-For (networked)
//   T4 a non-portal path (/api/v1/account) is BLOCKED (403) — control surfaces unreachable
//   T5 handshake with an unknown token → 401
//   T6 a REVOKED token → rpc dispatch returns 401 (gate re-checks every request)
//   T7 the wire (frame) carries no plaintext path/token

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import crypto from 'node:crypto';
import express from 'express';
import { createIdentity } from '../src/identity/identity.js';
import { createE2ERouter } from '../src/portal-e2e.js';
import { initClient, sealClientAuth, finalizeClient } from '../src/crypto/e2e-session.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(Boolean(p)); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); };
const j = (r) => r.json();

// fake device-token store: one live token, revocable.
function fakeTokens() {
  const live = new Set();
  return { add: (t) => live.add(t), revoke: (t) => live.delete(t), matchSync: (t) => (live.has(t) ? 'owner' : null) };
}

async function main() {
  const box = createIdentity({ masterHex: 'a'.repeat(64) });
  const tokens = fakeTokens();
  const TOKEN = crypto.randomBytes(32).toString('hex');
  tokens.add(TOKEN);

  // Stub loopback dispatch: emulate the gate (device-token check) + return a portal payload.
  let lastReq = null;
  const stubFetch = async (url, opts) => {
    const path = url.replace(/^http:\/\/127\.0\.0\.1:\d+/, '');
    const bearer = /^Bearer (.+)$/.exec(opts.headers.authorization || '')?.[1];
    lastReq = { path, method: opts.method, headers: opts.headers, body: opts.body };
    if (!tokens.matchSync(bearer)) return { status: 401, text: async () => '{"error":"unauthorized"}' };
    return { status: 200, text: async () => JSON.stringify({ agents: [{ id: 'me' }] }) };
  };

  const { router } = createE2ERouter({ db: { deviceTokens: tokens }, identity: box, restPort: 9999, fetchImpl: stubFetch });
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // --- phone helper: full handshake against the box, returns a live client session + sid
  async function handshake(token) {
    const st = initClient(box.keyAgreementPublicKeyB64);
    const { msg1, cnonce } = sealClientAuth(st, token);
    const r = await fetch(`${base}/e2e/handshake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg1 }) });
    if (r.status !== 200) return { status: r.status };
    const { sid, msg2 } = await r.json();
    const session = finalizeClient(st, cnonce, msg2);
    return { status: 200, sid, session };
  }
  const rpc = async (sid, session, envelope) => {
    const frame = session.seal(JSON.stringify(envelope));
    const r = await fetch(`${base}/e2e/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sid, frame }) });
    const body = await r.json();
    return { status: r.status, body, frame };
  };

  try {
    // T1 — handshake
    const hs = await handshake(TOKEN);
    rec('T1 handshake with a live token → session established', hs.status === 200 && Boolean(hs.sid && hs.session));

    // T2/T3 — rpc round-trips a real portal response, sealed; dispatch forwards auth
    const out = await rpc(hs.sid, hs.session, { method: 'GET', path: '/api/v1/portal/agents' });
    const resp = out.status === 200 ? JSON.parse(hs.session.open(out.body.frame).toString('utf8')) : null;
    rec('T2 rpc round-trips the sealed portal response', resp?.status === 200 && JSON.parse(resp.body)?.agents?.[0]?.id === 'me');
    rec('T3 dispatch forwarded device-token Bearer + X-Forwarded-For (networked)',
      lastReq?.headers?.authorization === `Bearer ${TOKEN}` && lastReq?.headers?.['x-forwarded-for'] === '127.0.0.1' && lastReq?.path === '/api/v1/portal/agents');

    // T4 — control surface blocked at the router (never dispatched)
    lastReq = null;
    const ctrl = await rpc(hs.sid, hs.session, { method: 'POST', path: '/api/v1/account/destroy' });
    const ctrlResp = JSON.parse(hs.session.open(ctrl.body.frame).toString('utf8'));
    rec('T4 a non-portal path is blocked (403) and never dispatched', ctrlResp.status === 403 && lastReq === null);

    // T4b — %2e%2e / .. traversal that normalizes to a control surface is BLOCKED
    // (raw-string checks miss this; the resolved pathname must be under /portal).
    lastReq = null;
    const trav = await rpc(hs.sid, hs.session, { method: 'POST', path: '/api/v1/portal/%2e%2e/account/destroy' });
    const travResp = JSON.parse(hs.session.open(trav.body.frame).toString('utf8'));
    rec('T4b %2e%2e traversal to a control surface is blocked (normalized path check)', travResp.status === 403 && lastReq === null);
    // T4c — an absolute URL cannot redirect the dispatch off-box (SSRF)
    lastReq = null;
    const ssrf = await rpc(hs.sid, hs.session, { method: 'GET', path: 'http://evil.example/api/v1/portal/x' });
    const ssrfResp = JSON.parse(hs.session.open(ssrf.body.frame).toString('utf8'));
    rec('T4c an absolute-URL path cannot escape to another host (SSRF blocked)', ssrfResp.status === 403 && lastReq === null);
    // T4d — the loopback-only pairing CEREMONY (/api/v1/portal/pair/*) is under the
    // portal prefix but must be UNREACHABLE over E2E (second, independent layer on top
    // of its isTrustedLoopback guard — CLAUDE.md §2). Assert BOTH the lowercase path AND
    // a MIXED-CASE variant are blocked + never dispatched: Express routes case-
    // insensitively, so a case-sensitive deny would let `/PAIR/` through to the handler.
    for (const p of ['/api/v1/portal/pair/approve', '/api/v1/portal/PAIR/approve']) {
      lastReq = null;
      const cer = await rpc(hs.sid, hs.session, { method: 'POST', path: p });
      const cerResp = JSON.parse(hs.session.open(cer.body.frame).toString('utf8'));
      rec(`T4d pairing ceremony ${p} is blocked (403) and never dispatched`, cerResp.status === 403 && lastReq === null);
    }

    // T5 — unknown token → handshake 401
    const bad = await handshake(crypto.randomBytes(32).toString('hex'));
    rec('T5 handshake with an unknown token → 401', bad.status === 401);

    // T6 — revoke mid-session → the NEXT rpc dispatch 401s (gate re-checks)
    tokens.revoke(TOKEN);
    const afterRevoke = await rpc(hs.sid, hs.session, { method: 'GET', path: '/api/v1/portal/agents' });
    const revResp = JSON.parse(hs.session.open(afterRevoke.body.frame).toString('utf8'));
    rec('T6 a revoked token → dispatch 401 (revocation honored per rpc)', revResp.status === 401);

    // T7 — confidentiality: the rpc frame carries no plaintext path/token
    const wire = JSON.stringify(out.frame);
    rec('T7 the sealed frame carries no plaintext path/token', !wire.includes('/api/v1/portal/agents') && !wire.includes(TOKEN));
  } finally {
    server.close();
  }

  const allPass = ledger.length > 0 && ledger.every(Boolean);
  console.log('\n' + '='.repeat(66));
  console.log(`VERDICT: ${allPass ? 'GO — E2E transport: handshake-authed sessions, sealed REST round-trip, device-token authz + revocation reused, control surfaces unreachable, confidential' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
  console.log('='.repeat(66));
  process.exit(allPass ? 0 : 1);
}
main().catch((e) => { console.error('verify-e2e-transport threw:', e); process.exit(1); });
