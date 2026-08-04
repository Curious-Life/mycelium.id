#!/usr/bin/env node
// verify:backlog-quiescence — D-132 fast-half proof: the polled backlog numbers
// are NEVER recomputed by a poll on a write-quiescent vault. The SWR caches
// (v0.1.16) bounded the scan rate, but every TTL expiry still re-ran a
// multi-second SQLCipher full-table decrypt with NOTHING written — an idle
// 67k-message vault burned a core in bursts forever, purely from the activity
// feed polling @2.5s. Now every messages write bumps a generation; a poll only
// rescans when the generation moved, or when the 15-min reconcile floor expires
// (drift insurance for a writer the net misses — staleness bounded, never
// forever-wrong).
//
// Driven with an injected d1Query (counts real scan executions) and injected
// clock — the REAL createMessagesNamespace code runs, not a copy.
//
// MUTATION-TESTED: (D-132, 2026-08-04) the write-quiescent short-circuit removed
// from embedBacklogCached (the gen-unchanged serve line deleted — pure-TTL
// behaviour, the pre-fix state) → Q2, Q2b and Q4b RED (a poll after TTL expiry
// with zero writes re-scans, every expiry) while Q1/Q3/Q4/Q5/Q6 stay GREEN.
// Restored → GO.
// MUTATION-TESTED: (D-132, 2026-08-04) bumpBacklogGen() dropped from
// updateMetadata (one writer stops invalidating) → Q3 and Q5 RED (a poll after
// that write serves the stale value and never rescans) and the Q7 wiring pin
// naming updateMetadata RED. Restored → GO.
// MUTATION-TESTED: (D-132, 2026-08-04) BACKLOG_RECONCILE_FLOOR_MS raised to
// Infinity (quiescent serve-forever — a missed writer would show wrong numbers
// until the next real write, the QA P1-C staleness class) → Q4 and Q4b RED (no
// reconcile rescan at t+16min) while Q2/Q3/Q5/Q6 stay GREEN. Restored → GO.
// MUTATION-TESTED: (D-132, 2026-08-04) the `cached.value.total > 0` clause
// removed from embedBacklogCached's quiescent short-circuit (a total:0 snapshot
// starts quiescing — the P1-C false-empty would survive up to the 15-min floor
// after a dynamic-SQL import) → Q8 RED while all other checks stay GREEN.
// Restored → GO. (verify-enrich-backlog-parity's P1-C row also covers the
// TTL half of this behaviour on a real vault fixture.)
// MUTATION-TESTED: (D-132 round-1 review, 2026-08-04) 'updateMetadata' removed
// from BACKLOG_WRITE_METHODS (one writer unwrapped) → Q3, Q5 and the Q7 list
// pin RED. Restored → GO.
// MUTATION-TESTED: (D-132 round-1 review, 2026-08-04) the wrapper regressed to
// bump-BEFORE the awaited write (the stale-capture race the round-1 review
// found: a scan starting inside the write's await window captures the new gen
// while reading pre-write data, then quiesces stale) → the Q7 'finally after
// await' pin REDs. (The race itself needs a held write to drive; the static
// pin is the tractable tooth and is comment-proof.) Restored → GO.
// MUTATION-TESTED: (D-132 round-1 review H3, 2026-08-04) `total > 0` dropped
// from categoriesBacklogCached ALONE → Q8b(categories) RED while the embed
// checks stay GREEN — the per-cache coverage the round-1 gate review demanded.
// Restored → GO.
import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import { readFileSync } from 'node:fs';
import { createMessagesNamespace } from '../src/db/messages.js';

const ledger = [];
let allPass = true;
function check(name, cond) {
  const ok = !!cond;
  allPass = allPass && ok;
  ledger.push(`[${ok ? '✓' : '✗'}] ${name}`);
}

function harness({ total = 10 } = {}) {
  let t = 1_000_000; // injected clock (ms)
  const totals = { value: total };
  const scans = { messages: 0 };
  let hold = null; // when set, the next scan awaits it (Q5's in-flight window)
  const d1Query = async (sql) => {
    if (/FROM messages/.test(sql) && /COUNT\(\*\)/.test(sql)) {
      scans.messages += 1;
      if (hold) { const h = hold; hold = null; await h; }
      const total = totals.value;
      return { results: [{ total, embedded: 0, pending: 0, gave_up: 0, tagged: 0, blocked_on_embed: 0, unembeddable: 0, done: 0, ...(total === 10 ? { embedded: 5, tagged: 5, done: 5 } : {}) }] };
    }
    return { results: [], meta: { changes: 1 } };
  };
  const db = createMessagesNamespace({
    d1Query,
    d1Batch: async (stmts) => stmts.map(() => ({ results: [] })),
    firstRow: (r) => (r?.results || [])[0] ?? null,
    now: () => t,
  });
  return {
    db, scans, tick: (ms) => { t += ms; },
    holdNextScan: () => { let release; hold = new Promise((r) => { release = r; }); return release; },
  };
}

try {
  // Q1: cold poll scans once; a poll inside the TTL serves the cache.
  {
    const { db, scans } = harness();
    await db.embedBacklogCached('u');
    await db.embedBacklogCached('u');
    check('Q1 cold poll → exactly one scan; fresh poll → cached', scans.messages === 1);
  }

  // Q2: THE FIX — TTL expired, zero writes → NO rescan (write-quiescent serve).
  {
    const { db, scans, tick } = harness();
    await db.embedBacklogCached('u');
    tick(61_000); // settled TTL is 60s — expired
    const v = await db.embedBacklogCached('u');
    check('Q2 TTL expired + write-quiescent → poll does NOT rescan (the idle-vault burst class)', scans.messages === 1 && v.total === 10);
    tick(61_000);
    await db.embedBacklogCached('u');
    check('Q2b …and stays quiescent across further expiries', scans.messages === 1);
  }

  // Q3: a write bumps the generation → the next TTL-expired poll rescans.
  {
    const { db, scans, tick } = harness();
    await db.embedBacklogCached('u');
    tick(61_000);
    await db.updateMetadata('id1', 'u', { a: 1 }); // a REAL write method, not noteBacklogWrite
    await db.embedBacklogCached('u');
    // the rescan is kicked in the background (SWR) — settle the microtask
    await new Promise((r) => setImmediate(r));
    check('Q3 a messages write → next expired poll rescans', scans.messages === 2);
  }

  // Q4: reconcile floor — quiescent forever still rescans once per 15 min.
  {
    const { db, scans, tick } = harness();
    await db.embedBacklogCached('u');
    tick(16 * 60_000); // past the 15-min floor, no writes
    await db.embedBacklogCached('u');
    await new Promise((r) => setImmediate(r));
    check('Q4 reconcile floor: quiescent vault still rescans once after 15 min (drift insurance)', scans.messages === 2);
    tick(61_000); // TTL expired again, still quiescent, floor not yet re-reached
    await db.embedBacklogCached('u');
    check('Q4b …then returns to quiescence', scans.messages === 2);
  }

  // Q5: a write RACING an in-flight scan invalidates its result conservatively —
  // the scan stores the generation captured at its START, so a write landing
  // mid-scan makes the stored snapshot already-stale and the next expired poll
  // rescans instead of trusting it.
  {
    const { db, scans, tick, holdNextScan } = harness();
    await db.embedBacklogCached('u');              // scan 1 (gen 0)
    await db.updateMetadata('id1', 'u', { a: 1 }); // gen 1
    tick(61_000);
    const release = holdNextScan();
    const p = db.embedBacklogCached('u');          // serves stale, kicks scan 2 (captures gen 1) — held in flight
    await db.updateMetadata('id2', 'u', { a: 2 }); // gen 2 lands DURING scan 2
    release();
    await p; await new Promise((r) => setImmediate(r)); // scan 2 stored with gen 1 (pre-race)
    tick(61_000);
    await db.embedBacklogCached('u');              // stored gen 1 ≠ live gen 2 → scan 3
    await new Promise((r) => setImmediate(r));
    check('Q5 write racing an in-flight scan → next expired poll rescans (gen captured at scan START)', scans.messages === 3);
  }

  // Q6: the categories + nlp caches share the same quiescence contract.
  {
    const { db, scans, tick } = harness();
    await db.categoriesBacklogCached('u');
    await db.nlpBacklogCached('u');
    tick(61_000);
    await db.categoriesBacklogCached('u');
    await db.nlpBacklogCached('u');
    check('Q6 categories + nlp caches: quiescent → no rescan', scans.messages === 2);
    await db.updateCategories('id1', 'u', { domain: 'd' });
    tick(61_000);
    await db.categoriesBacklogCached('u');
    await db.nlpBacklogCached('u');
    await new Promise((r) => setImmediate(r));
    check('Q6b …and both rescan after a write', scans.messages === 4);
  }

  // Q8: a total:0 snapshot NEVER quiesces — it is the transient pre-import
  // state (QA P1-C) and import writers can be dynamic-SQL the generation net
  // does not see; an empty-table scan is cheap. Quiescence is a big-vault
  // optimization only.
  {
    const { db, scans, tick } = harness({ total: 0 });
    await db.embedBacklogCached('u');   // caches {total:0}
    tick(9_000);                        // past the 8s transient TTL, zero method-writes
    await db.embedBacklogCached('u');
    await new Promise((r) => setImmediate(r));
    check('Q8 total:0 snapshot keeps revalidating despite write-quiescence (P1-C)', scans.messages === 2);
  }

  // Q8b/Q4c (round-1 gate review H3): the floor + total:0 rules hold on ALL
  // THREE caches, not just embed — dropping either from categories/nlp alone
  // used to pass.
  {
    const kinds = [
      ['categories', (db) => db.categoriesBacklogCached('u')],
      ['nlp', (db) => db.nlpBacklogCached('u')],
    ];
    for (const [name, poll] of kinds) {
      {
        const { db, scans, tick } = harness();
        await poll(db);
        tick(16 * 60_000);
        await poll(db);
        await new Promise((r) => setImmediate(r));
        check(`Q4c reconcile floor holds for ${name} cache`, scans.messages === 2);
      }
      {
        const { db, scans, tick } = harness({ total: 0 });
        await poll(db);
        tick(61_000);
        await poll(db);
        await new Promise((r) => setImmediate(r));
        check(`Q8b total:0 never quiesces for ${name} cache`, scans.messages === 2);
      }
    }
  }

  // Q7: static wiring pins — every write method bumps; the out-of-namespace raw
  // writers call noteBacklogWrite. (Q1–Q6 prove the machinery; this names the
  // sites so a silent drop REDs by name.)
  {
    const src = readFileSync('src/db/messages.js', 'utf8');
    // Round-1 review: the bump moved AFTER the write (finally-wrapped at the API
    // boundary) — bump-before let a scan racing the write's await window quiesce
    // on stale numbers. The pins now assert (a) every write method is in the
    // wrapped list, (b) the wrapper bumps in a finally AFTER awaiting, (c) the
    // return object actually passes through wrapBacklogWriters. Comment-proof:
    // matched on non-comment lines only.
    const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const writeMethods = ['insert', 'updateMetadata', 'updateEnrichment', 'markForReembed',
      'resetEnrichmentGiveUps', 'updateNlp', 'updateCategories', 'restampLegacyCategories',
      'redact', 'deleteIds', 'setSalience', 'insertIgnore', 'updateContent',
      'backfillContentHash', 'adoptOrphanChatHistory'];
    for (const m of writeMethods) {
      check(`Q7 wiring: messages.${m} in BACKLOG_WRITE_METHODS`, new RegExp(`BACKLOG_WRITE_METHODS = \\[[^\\]]*'${m}'`, 's').test(code));
    }
    check('Q7 wiring: wrapper bumps AFTER the awaited write (finally)',
      /finally \{ bumpBacklogGen\(\); \}/.test(code) && /await fn\.apply\(this, a\)/.test(code));
    check('Q7 wiring: the API is returned through wrapBacklogWriters', /return wrapBacklogWriters\(\{/.test(code));
    const noComments = (p) => readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    check('Q7 wiring: drainer selfHeal/reclaim call noteBacklogWrite (non-comment lines)',
      (noComments('src/enrich/drainer.js').match(/noteBacklogWrite\?\.\(\)/g) || []).length >= 2);
    check('Q7 wiring: full-export-import restore + vector pass call noteBacklogWrite (non-comment lines)',
      (noComments('src/ingest/full-export-import.js').match(/noteBacklogWrite\?\.\(\)/g) || []).length >= 2);
  }
} catch (e) {
  check(`fatal: ${e?.message || e}`, false);
}

console.log(ledger.join('\n'));
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'}  EXIT=${allPass ? 0 : 1}`);
process.exit(allPass ? 0 : 1);
