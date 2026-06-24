// verify:harness-channel-compaction — cross-turn compaction wiring (src/agent/history.js
// hydrateHistoryBlock) over a REAL booted vault (for the encrypted summary store). Spec §5.2/§6.
//   H1 small history → rendered verbatim, NO summarize call (cheap path)
//   H2 over-budget history → summarize called; block carries the SUMMARY, not all raw turns
//   H3 the summary persists in conversation_summaries, ENCRYPTED at rest
//   H4 a stored prior summary is loaded + handed to the summarizer to UPDATE (anti-thrash)
//   H5 summarizer failure → fail-through (still returns a block, no throw)
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { hydrateHistoryBlock } from '../src/agent/history.js';

const DB = 'data/verify-harness-channel-compaction.db', KCV = 'data/verify-harness-channel-compaction-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const CONV = 'channel:telegram:cmp';
const H = db.harness;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const rawRead = (sql, p = []) => { const d = new Database(DB, { readonly: true }); try { return d.prepare(sql).get(...p); } finally { d.close(); } };

const getSummary = (u, c) => H.getSummary(u, c);
const putSummary = (rec) => H.putSummary(rec);

// ── H1 cheap path: small history, no summarize ──
{
  let called = 0;
  const summarize = async () => { called += 1; return 'SUMMARY'; };
  const block = await hydrateHistoryBlock({
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }],
    contextWindow: 8192, maxOutputTokens: 1024, summarize, getSummary, putSummary, conversationId: CONV, userId: U,
  });
  rec('H1 small history rendered verbatim, no summarize call', called === 0 && /Conversation so far/.test(block) && block.includes('hi') && block.includes('hello'), `called=${called}`);
}

// Build a long history that exceeds a small window so compaction triggers.
const long = [];
for (let i = 0; i < 40; i++) long.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}: ` + 'lorem ipsum dolor sit amet '.repeat(20) + (i === 3 ? 'UNIQUE-OLD-FACT-XYZ' : '') });

// ── H2 over-budget → summarize, block carries the summary ──
let summarizeUserSeen = null;
{
  const summarize = async (sys, usr) => { summarizeUserSeen = usr; return '## Goal\nUser chatting\n## Done\nmany turns SENSITIVE-SUMMARY-CMP\n## Key Context\nUNIQUE-OLD-FACT-XYZ noted'; };
  const block = await hydrateHistoryBlock({
    history: long, contextWindow: 2000, maxOutputTokens: 512, summarize, getSummary, putSummary, conversationId: CONV, userId: U,
  });
  rec('H2 over-budget triggered compaction (summary present in block)', /Earlier conversation \(summarized\)/.test(block) && block.includes('SENSITIVE-SUMMARY-CMP'));
  rec('H2 not every raw old turn is in the block (middle summarized)', !block.includes('turn 0:') , 'turn 0 should be summarized away');
}

// ── H3 summary persisted + encrypted ──
{
  const got = await H.getSummary(U, CONV);
  rec('H3 summary stored in conversation_summaries', !!got && got.summary.includes('SENSITIVE-SUMMARY-CMP'));
  const raw = rawRead('SELECT summary FROM conversation_summaries WHERE conversation_id = ?', [CONV]);
  // SQLCipher collapse (Stage B/C cut 4): conversation_summaries.summary is now
  // PLAINTEXT-in-cipher — at-rest = whole-file SQLCipher (verify:at-rest).
  rec('H3 summary PLAINTEXT-in-cipher (collapse cut 4; at-rest = whole-file SQLCipher, verify:at-rest)', !!raw?.summary && String(raw.summary).includes('SENSITIVE-SUMMARY-CMP'));
}

// ── H4 prior summary loaded + handed to summarizer (UPDATE, not restart) ──
{
  let userArg = null;
  const summarize = async (sys, usr) => { userArg = usr; return '## Done\nupdated summary'; };
  await hydrateHistoryBlock({
    history: long, contextWindow: 2000, maxOutputTokens: 512, summarize, getSummary, putSummary, conversationId: CONV, userId: U,
  });
  rec('H4 stored prior summary handed to summarizer for update', typeof userArg === 'string' && userArg.includes('SENSITIVE-SUMMARY-CMP') && /PRESERVE its facts/.test(userArg));
}

// ── H5 summarizer failure → fail-through ──
{
  let threw = false;
  let block = '';
  try {
    block = await hydrateHistoryBlock({
      history: long, contextWindow: 2000, maxOutputTokens: 512,
      summarize: async () => { throw new Error('model down'); },
      getSummary, putSummary, conversationId: CONV, userId: U,
    });
  } catch { threw = true; }
  rec('H5 summarizer failure does not throw (fail-through, block still returned)', !threw && typeof block === 'string' && block.length > 0);
}

await close?.();
const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — cross-turn compaction: cheap-path (no call when it fits) · summarize-on-overflow · encrypted summary store · prefer-stored-summary update · fail-through' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
