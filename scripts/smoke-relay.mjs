// scripts/smoke-relay.mjs — LIVE relay smoke. From ONE box, validate that the DEPLOYED relay's
// /v1/queue/* endpoints are reachable AND the queue claim-auth works, via a self
// enqueue → pull → ack round-trip. Run this BEFORE committing two machines to a full offline-
// connect test — it catches the common deploy problems (relay not on current mycelium-managed,
// edge not routing /v1/queue/*, handle/key mismatch, entitlement) cheaply.
//
//   MYC_SMOKE_RELAY  = https://connect.mycelium.id:8443   (the relay / control-plane base URL)
//   MYC_SMOKE_HANDLE = your provisioned FEDERATION handle (the <handle> in <handle>.mycelium.id)
//   MYC_SMOKE_MASTER = the box's 64-char hex master key (the identity is derived from it)
//
//   node scripts/smoke-relay.mjs
import crypto from 'node:crypto';
import { createIdentity } from '../src/identity/identity.js';
import { createRelayQueueClient } from '../src/federation/relay-queue-client.js';

const relay = process.env.MYC_SMOKE_RELAY;
const handle = process.env.MYC_SMOKE_HANDLE;
const master = process.env.MYC_SMOKE_MASTER;
if (!relay || !handle || !master) {
  console.error('Set MYC_SMOKE_RELAY (https://…:8443), MYC_SMOKE_HANDLE (your handle), MYC_SMOKE_MASTER (64-char hex master key).');
  process.exit(2);
}

const id = createIdentity({ masterHex: master, handle });
const client = createRelayQueueClient({ relayBaseUrl: relay, handle, publicKeyB64: id.publicKeyB64, sign: (b) => id.sign(b) });
const marker = `SMOKE-${crypto.randomUUID()}`;
const ledger = [];
const step = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); };

try {
  console.log(`relay=${relay}  handle=${handle}  pubkey=${id.publicKeyB64.slice(0, 12)}…`);
  const e = await client.enqueue(handle, marker); // recipient = self; unauthenticated enqueue
  step('enqueue → 200 (/v1/queue/enqueue reachable)', !!e.id, `id=${e.id}`);
  const pulled = await client.pull();             // claim-authed pull (proves key matches the registry)
  const found = pulled.find((p) => p.envelope === marker);
  step('pull returns our envelope (queue-pull claim auth OK)', !!found, `count=${pulled.length}`);
  if (found) { const a = await client.ack([found.id]); step('ack → deletes it (queue-ack OK)', (a.acked || 0) >= 1, `acked=${a.acked}`); }
} catch (err) { step('round-trip', false, String(err && err.message || err)); }

const ok = ledger.every(Boolean);
console.log('\n' + (ok
  ? 'SMOKE OK — the relay queue is reachable and auth works from this box. Safe to run the two-box test.'
  : 'SMOKE FAILED — likely: relay not redeployed to current mycelium-managed (no /v1/queue/*), the public edge is not routing /v1/queue/*, the handle/master do not match the provisioned registry key, or billing entitlement is required.'));
process.exit(ok ? 0 : 1);
