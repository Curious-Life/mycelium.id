import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
// Gate: batched incremental search-index writes (D-148).
//
// The defect, profiled live 2026-08-22 on the operator's 67k vault: every
// captured message cost ONE encrypted-WAL transaction (delete-then-insert via
// backend.add) — decaying to ~14 docs/min at corpus scale (spike strategy A),
// so any ingest burst ground the serving thread for hours (88% self-time in
// add()). noteUpsert/noteVector now coalesce ≤25ms windows (cap 128) into ONE
// transaction via the idempotent bulkAdd / bulkVectors.
//
// The metric IS the defect: this gate counts raw.transaction() invocations.
// Reverting the batching turns I1/I6 red (500 upserts → 500 transactions).
//
// The security half: deletes are NEVER queued, and a delete PURGES pending
// writes for its ids — a batch flushing after a forget must not RESURRECT
// forgotten content into the index (I3/I4; delete-cascade calls
// helpers.backend.delete directly, which carries the same guard).
//
// Fixture-only (:memory:), throwaway data, no vault. Never logs row text.
//
// MUTATION-TESTED: noteUpsert bypassed the queue (pre-D-148 per-doc backend.add) → I1a RED (tx=500)
// MUTATION-TESTED: purgePending removed from exposedBackend.delete → I3 RED
//   (the pending upsert flushed AFTER the delete — forgotten content resurrected)
// MUTATION-TESTED: noteDelete deferred its backend.delete by 50ms (queued delete) → I4 RED
//   (doc still present immediately after the awaited noteDelete)
// MUTATION-TESTED: flush used per-doc noteVector instead of bulkVectors → I6a RED (tx=200)
// All four reverted; gate GREEN on restored code (9 pass).

import Database from 'better-sqlite3';
import { createSearchHelpers } from '../src/search/index.js';

const ledger = [];
const rec = (name, pass, detail = '') => {
  ledger.push(pass);
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture() {
  const raw = new Database(':memory:');
  let txCount = 0;
  const origTx = raw.transaction.bind(raw);
  raw.transaction = (fn) => { txCount++; return origTx(fn); };
  const db = {
    _sqliteSearch: raw,
    rawQuery: (s, p = []) => { try { return { results: raw.prepare(s).all(...p) }; } catch { return { results: [] }; } },
  };
  const sh = createSearchHelpers({ db, userId: 'u1', searchBackend: 'sqlite' });
  sh.backend.markCorpusBuilt(); // steady state — no lazy full build interference
  return { raw, sh, tx: () => txCount, resetTx: () => { txCount = 0; } };
}
const docCount = (raw) => raw.prepare('SELECT COUNT(*) AS c FROM doc_meta').get().c;
const vecCount = (raw) => raw.prepare('SELECT COUNT(*) AS c FROM vec_docs_768').get().c;
const hasDoc = (raw, id) => raw.prepare('SELECT COUNT(*) AS c FROM doc_meta WHERE id = ?').get(id).c === 1;
const vec = (seed) => { const v = new Float32Array(768); let s = seed >>> 0; for (let i = 0; i < 768; i++) { s = (s * 1664525 + 1013904223) >>> 0; v[i] = (s / 4294967296) * 2 - 1; } return v; };

async function main() {
  // ── I1: 500 fire-and-forget upserts → a handful of transactions, all indexed ─
  {
    const { raw, sh, tx, resetTx } = fixture();
    resetTx();
    const waits = [];
    for (let i = 0; i < 500; i++) waits.push(sh.noteUpsert({ id: `b${i}`, text: `burst note ${i}`, ts: 1700000000 + i }));
    await Promise.all(waits);
    rec('I1a burst of 500 upserts commits in ≤10 transactions (was 500)', tx() >= 1 && tx() <= 10, `tx=${tx()}`);
    rec('I1b all 500 indexed after the writers settle', docCount(raw) === 500, `count=${docCount(raw)}`);
    raw.close();
  }

  // ── I2: same-id coalescing — last write wins, one row ────────────────────────
  {
    const { raw, sh } = fixture();
    const p1 = sh.noteUpsert({ id: 'dup', text: 'first version', ts: 1700000000 });
    const p2 = sh.noteUpsert({ id: 'dup', text: 'second version kayak', ts: 1700000001 });
    await Promise.all([p1, p2]);
    const { hits } = await sh.backend.query({ text: 'kayak', topK: 5 });
    rec('I2 same-window same-id upserts coalesce; last text wins', docCount(raw) === 1 && hits.some((h) => h.id === 'dup'), `count=${docCount(raw)} hits=${hits.length}`);
    raw.close();
  }

  // ── I3: THE resurrection guard — delete purges a PENDING upsert ──────────────
  {
    const { raw, sh } = fixture();
    sh.noteUpsert({ id: 'ghost', text: 'content that was forgotten', ts: 1700000000 }); // NOT awaited — still pending
    await sh.backend.delete({ ids: ['ghost'] }); // the delete-cascade path (direct backend.delete)
    await sleep(80); // let any pending window flush
    rec('I3 delete purges a pending upsert — no post-forget resurrection', !hasDoc(raw, 'ghost'));
    raw.close();
  }

  // ── I4: deletes are immediate, never queued ──────────────────────────────────
  {
    const { raw, sh } = fixture();
    await sh.noteUpsert({ id: 'gone', text: 'to be removed', ts: 1700000000 });
    await sh.noteDelete(['gone']); // must evict NOW — no flush window involved
    rec('I4 noteDelete evicts immediately (fail-closed, F7 semantics)', !hasDoc(raw, 'gone'));
    raw.close();
  }

  // ── I5: read-your-write — a single awaited upsert is searchable on resolve ───
  {
    const { raw, sh } = fixture();
    await sh.noteUpsert({ id: 'ryw', text: 'kayaking on alpine rivers', ts: 1700000000 });
    const { hits } = await sh.backend.query({ text: 'kayaking alpine', topK: 5 });
    rec('I5 awaited noteUpsert is searchable immediately after resolve (SQ14 contract)', hits.some((h) => h.id === 'ryw'), `hits=${hits.length}`);
    raw.close();
  }

  // ── I6: enrichment vectors batch too; vector lands for a same-window upsert ──
  {
    const { raw, sh, tx, resetTx } = fixture();
    for (let i = 0; i < 200; i++) await sh.noteUpsert({ id: `v${i}`, text: `doc ${i}`, ts: 1700000000 + i });
    resetTx();
    const settles = [];
    for (let i = 0; i < 200; i++) settles.push(sh.noteVector(`v${i}`, vec(i)));
    await Promise.all(settles.filter(Boolean));
    rec('I6a 200 enrichment vectors commit in ≤6 transactions (was 200)', tx() >= 1 && tx() <= 6, `tx=${tx()}`);
    rec('I6b all 200 vectors present', vecCount(raw) === 200, `count=${vecCount(raw)}`);
    // upsert + vector for the SAME id in one window: both land, vector wins.
    const pu = sh.noteUpsert({ id: 'uv', text: 'text and vector together', ts: 1700000300 });
    const pv = sh.noteVector('uv', vec(999));
    await Promise.all([pu, pv].filter(Boolean));
    const uvVec = raw.prepare('SELECT COUNT(*) AS c FROM vec_docs_768 WHERE id = ?').get('uv').c;
    rec('I6c same-window upsert+vector: doc indexed AND vector applied', hasDoc(raw, 'uv') && uvVec === 1, `vec=${uvVec}`);
    raw.close();
  }

  const passed = ledger.filter(Boolean).length;
  const failed = ledger.length - passed;
  console.log('================================================================');
  console.log(`VERDICT: ${failed === 0 ? 'GO' : 'NO-GO'} — batched incremental index writes (${passed} pass, ${failed} fail)  EXIT=${failed === 0 ? 0 : 1}`);
  console.log('================================================================');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('GATE CRASHED:', e); process.exit(1); });
