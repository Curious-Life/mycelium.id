// verify:entitlement — the control-plane relay-billing entitlement layer (O3).
// Hermetic: a tmp better-sqlite3 registry, no network, no Stripe. Proves the
// primitives the Stripe webhook (O4) writes and the relay-hook gate (O6) reads.
//   E1 setEntitlement upsert + getEntitlement round-trip (customer id + paid_until)
//   E2 isEntitled honours paid_until and the grace window (future/past/within/after)
//   E3 isEntitled is keyed via the handle's owning public_key (the join works)
//   E4 RELEASE + RECLAIM PRESERVES the subscription (the whole reason for a
//      separate table) — and a renamed handle (release old, claim new) keeps it
//   E5 reservation holds: setHold marks a placeholder; sweepExpiredHolds frees
//      ONLY expired UNPAID placeholders, NEVER a finalized/live handle
//   E6 clearEntitlement lapses paid_until but retains stripe_customer_id
//   E7 fail-closed: unknown handle / no entitlement row → isEntitled false
import os from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import crypto from 'node:crypto';
import { openRegistry } from '../mycelium-managed/src/registry.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const DB = join(os.tmpdir(), `myc-ent-${process.pid}.db`);
rmSync(DB, { force: true });
const reg = openRegistry(DB);
const pk = () => crypto.randomBytes(32).toString('base64url'); // stand-in ed25519 pubkey

try {
  const NOW = 1_000_000_000_000; // fixed clock
  const DAY = 86_400_000;

  // E1 — upsert + read
  const keyA = pk();
  reg.claim({ handle: 'alice', publicKey: keyA });
  reg.finalize({ handle: 'alice', frpsToken: 'tok-a', acmeSubdomain: 'sub-a' });
  reg.setEntitlement({ publicKey: keyA, stripeCustomerId: 'cus_A', paidUntil: NOW + 30 * DAY });
  const e1 = reg.getEntitlement(keyA);
  rec('E1. setEntitlement upsert + getEntitlement round-trip',
    e1 && e1.stripe_customer_id === 'cus_A' && e1.paid_until === NOW + 30 * DAY,
    `cus=${e1?.stripe_customer_id} paid_until=${e1?.paid_until}`);

  // upsert again with null customer id must NOT wipe the stored one (COALESCE)
  reg.setEntitlement({ publicKey: keyA, paidUntil: NOW + 60 * DAY });
  const e1b = reg.getEntitlement(keyA);
  rec('E1b. re-upsert with null customer id keeps the prior customer id (COALESCE)',
    e1b.stripe_customer_id === 'cus_A' && e1b.paid_until === NOW + 60 * DAY,
    `cus=${e1b.stripe_customer_id} paid_until=${e1b.paid_until}`);

  // E2 — paid_until + grace semantics
  reg.setEntitlement({ publicKey: keyA, paidUntil: NOW });        // lapses exactly at NOW
  const future = reg.isEntitled('alice', NOW - DAY, 0);           // before paid_until → true
  const pastNoGrace = reg.isEntitled('alice', NOW + DAY, 0);      // after, no grace → false
  const withinGrace = reg.isEntitled('alice', NOW + DAY, 3 * DAY);// after, within grace → true
  const afterGrace = reg.isEntitled('alice', NOW + 4 * DAY, 3 * DAY); // past grace → false
  rec('E2. isEntitled honours paid_until + grace window',
    future && !pastNoGrace && withinGrace && !afterGrace,
    `future=${future} pastNoGrace=${pastNoGrace} withinGrace=${withinGrace} afterGrace=${afterGrace}`);

  // E3 — the handle→public_key→entitlement join
  reg.setEntitlement({ publicKey: keyA, paidUntil: NOW + 30 * DAY });
  rec('E3. isEntitled resolves via the handle\'s owning public_key',
    reg.isEntitled('alice', NOW, 0) === true, `entitled=${reg.isEntitled('alice', NOW, 0)}`);

  // E4 — THE LOAD-BEARING ONE: release + reclaim (and rename) preserves the sub
  reg.release({ handle: 'alice', publicKey: keyA });
  const handleGone = reg.get('alice') === undefined;
  const entStillThere = !!reg.getEntitlement(keyA);
  reg.claim({ handle: 'alice', publicKey: keyA });               // re-claim same name
  reg.finalize({ handle: 'alice', frpsToken: 'tok-a2', acmeSubdomain: 'sub-a2' });
  const keptOnReclaim = reg.isEntitled('alice', NOW, 0);
  reg.claim({ handle: 'alice-2', publicKey: keyA });             // OR a renamed handle
  reg.finalize({ handle: 'alice-2', frpsToken: 'tok-a3', acmeSubdomain: 'sub-a3' });
  const keptOnRename = reg.isEntitled('alice-2', NOW, 0);
  rec('E4. release+reclaim (and rename) PRESERVES the subscription',
    handleGone && entStillThere && keptOnReclaim && keptOnRename,
    `handleGone=${handleGone} entSurvived=${entStillThere} reclaim=${keptOnReclaim} rename=${keptOnRename}`);

  // E5 — reservation hold sweeper: frees expired UNPAID placeholders only
  const keyB = pk();
  reg.claim({ handle: 'bob', publicKey: keyB });                 // placeholder (no token)
  reg.setHold('bob', NOW - 1);                                   // already expired
  const keyC = pk();
  reg.claim({ handle: 'carol', publicKey: keyC });               // placeholder
  reg.setHold('carol', NOW + DAY);                               // still held
  // setHold must REFUSE to mark a finalized handle (alice is live)
  reg.setHold('alice', NOW - 1);
  const aliceHold = reg.get('alice').hold_expires_at;
  const freed = reg.sweepExpiredHolds(NOW);
  rec('E5. sweepExpiredHolds frees ONLY expired unpaid placeholders, never live handles',
    freed === 1 && reg.get('bob') === undefined && !!reg.get('carol') && !!reg.get('alice') && aliceHold == null,
    `freed=${freed} bobGone=${reg.get('bob') === undefined} carolKept=${!!reg.get('carol')} aliceLive=${!!reg.get('alice')} aliceHold=${aliceHold}`);

  // E6 — clearEntitlement lapses but keeps the customer id
  reg.clearEntitlement(keyA);
  const e6 = reg.getEntitlement(keyA);
  rec('E6. clearEntitlement zeros paid_until, retains stripe_customer_id',
    e6.paid_until === 0 && e6.stripe_customer_id === 'cus_A' && reg.isEntitled('alice', NOW, 0) === false,
    `paid_until=${e6.paid_until} cus=${e6.stripe_customer_id} entitled=${reg.isEntitled('alice', NOW, 0)}`);

  // E7 — fail-closed on missing data
  const noHandle = reg.isEntitled('nobody', NOW, DAY);
  reg.claim({ handle: 'dave', publicKey: pk() });               // handle but no entitlement row
  reg.finalize({ handle: 'dave', frpsToken: 'tok-d', acmeSubdomain: 'sub-d' });
  const noEnt = reg.isEntitled('dave', NOW, DAY);
  rec('E7. fail-closed: unknown handle or no entitlement → not entitled',
    noHandle === false && noEnt === false, `unknownHandle=${noHandle} noEntitlement=${noEnt}`);
} finally {
  reg.close();
  rmSync(DB, { force: true });
}

const ok = ledger.every(Boolean);
console.log('\n================================================================');
console.log(ok
  ? 'VERDICT: GO — entitlement is keyed by public_key, survives release, fails closed; holds sweep safely'
  : 'VERDICT: NO-GO — entitlement layer failed');
console.log('================================================================');
process.exit(ok ? 0 : 1);
