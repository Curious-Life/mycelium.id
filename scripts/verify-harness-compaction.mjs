// verify:harness-compaction — the auto-compaction algorithm (src/agent/compaction.js),
// pure (no provider/network). Proves every adopted pattern (spec §5.2):
//   K1 token estimate monotonic
//   K2 shouldCompact fires over threshold, not under
//   K3 pruneToolResults digests OLD tool results, keeps recent tail + non-tool verbatim
//   K4 partition: head=leading system, tail≤keepRecent, middle=rest
//   K5 compact happy path → [head, summaryMsg, ...tail]; structured prompt; savedRatio>0
//   K6 anti-thrash: two weak saves → skip summarize (no LLM call)
//   K7 fail-through: summarizer throws → compacted:false, pruned messages (no throw)
//   K8 prune-only: pruning alone gets under budget → no summarize call
//   K9 sanitizeOrphans drops a leading orphan tool message
//   K10 summary prompt is structured + temporally anchored
import {
  estimateMessagesTokens, shouldCompact, pruneToolResults, partition,
  sanitizeOrphans, buildSummaryUser, summaryCap, compact,
} from '../src/agent/compaction.js';

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const big = (n) => 'x'.repeat(n);

// ── K1 ──
{
  const a = estimateMessagesTokens([{ role: 'user', content: 'hi' }]);
  const b = estimateMessagesTokens([{ role: 'user', content: big(4000) }]);
  rec('K1 token estimate grows with content', b > a && a > 0, `${a} < ${b}`);
}

// ── K2 ──
{
  const small = [{ role: 'user', content: 'hi' }];
  const huge = [{ role: 'user', content: big(40000) }]; // ~10k tokens
  rec('K2 shouldCompact false under budget', shouldCompact({ messages: small, contextWindow: 32768, maxOutputTokens: 4096 }) === false);
  rec('K2 shouldCompact true over budget', shouldCompact({ messages: huge, contextWindow: 8192, maxOutputTokens: 1024 }) === true);
}

// ── K3 ──
{
  const msgs = [
    { role: 'user', content: 'do a search' },
    { role: 'assistant', content: 'searching' },
    { role: 'tool', name: 'searchMindscape', content: big(5000) },   // OLD, big → digested
    { role: 'assistant', content: 'here is the answer based on results' },
    { role: 'tool', name: 'recent', content: big(5000) },            // RECENT tail → verbatim
  ];
  const pruned = pruneToolResults(msgs, { keepRecentTokens: 2000 });
  const oldTool = pruned[2];
  rec('K3 old big tool result digested to a 1-liner', oldTool.content.startsWith('[tool:searchMindscape]') && oldTool.content.length < 200, oldTool.content.slice(0, 40));
  rec('K3 non-tool messages untouched', pruned[1].content === 'searching' && pruned[0].content === 'do a search');
  rec('K3 recent tail kept verbatim', pruned[4].content.length === 5000);
}

// ── K4 ──
{
  const msgs = [
    { role: 'system', content: 'sys preamble' },
    { role: 'user', content: big(4000) },
    { role: 'assistant', content: big(4000) },
    { role: 'user', content: 'recent question' },
  ];
  const { head, middle, tail } = partition(msgs, { keepRecentTokens: 200 });
  rec('K4 head is leading system msgs', head.length === 1 && head[0].role === 'system');
  rec('K4 tail is the recent verbatim slice', tail.length >= 1 && tail[tail.length - 1].content === 'recent question');
  rec('K4 middle is the summarizable rest', middle.length >= 1, `h=${head.length} m=${middle.length} t=${tail.length}`);
}

// ── K5 happy path ──
{
  let calledWith = null;
  const summarize = async (sys, user, cap) => { calledWith = { sys, user, cap }; return '## Goal\nShip the harness\n## Done\nSteps 1-2'; };
  const msgs = [
    { role: 'system', content: 'sys' },
    ...Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: big(3000) })),
    { role: 'user', content: 'latest' },
  ];
  const r = await compact({ messages: msgs, contextWindow: 8192, maxOutputTokens: 1024, summarize, dateStr: '2026-06-17' });
  rec('K5 compacted', r.compacted === true && typeof r.summary === 'string', JSON.stringify({ c: r.compacted, saved: r.savedRatio?.toFixed(2) }));
  rec('K5 result = head + summary + tail (system summary block present)', r.messages.some((m) => m.role === 'system' && m.content.startsWith('[Earlier conversation compacted]')));
  rec('K5 saved tokens (result smaller than input)', r.savedRatio > 0 && estimateMessagesTokens(r.messages) < estimateMessagesTokens(msgs));
  rec('K5 summarizer got the output cap hint', calledWith?.cap === summaryCap(8192));
}

// ── K6 anti-thrash ──
{
  let called = false;
  const summarize = async () => { called = true; return 'x'; };
  const msgs = [{ role: 'system', content: 'sys' }, ...Array.from({ length: 12 }, () => ({ role: 'user', content: big(3000) }))];
  const r = await compact({ messages: msgs, contextWindow: 8192, maxOutputTokens: 1024, summarize, thrashHistory: [0.05, 0.03] });
  rec('K6 anti-thrash skipped the summarize call', called === false && r.skippedThrash === true);
}

// ── K7 fail-through ──
{
  const summarize = async () => { throw new Error('provider down'); };
  const msgs = [{ role: 'system', content: 'sys' }, ...Array.from({ length: 12 }, () => ({ role: 'user', content: big(3000) }))];
  let threw = false; let r;
  try { r = await compact({ messages: msgs, contextWindow: 8192, maxOutputTokens: 1024, summarize }); } catch { threw = true; }
  rec('K7 summarizer failure does not throw', threw === false && r.compacted === false && r.error === true);
  rec('K7 returns usable (pruned) messages on failure', Array.isArray(r.messages) && r.messages.length > 0);
}

// ── K8 prune-only ──
{
  let called = false;
  const summarize = async () => { called = true; return 'x'; };
  // Big OLD tool results that prune away; small everything else → under budget after prune.
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'a' },
    { role: 'tool', name: 't', content: big(20000) },
    { role: 'tool', name: 't', content: big(20000) },
    { role: 'user', content: 'recent' },
  ];
  const r = await compact({ messages: msgs, contextWindow: 32768, maxOutputTokens: 4096, summarize, keepRecentTokens: 200 });
  rec('K8 prune-only path avoided the LLM summarize call', called === false && r.viaPruneOnly === true, JSON.stringify({ called, prune: r.viaPruneOnly }));
}

// ── K9 sanitizeOrphans ──
{
  const out = sanitizeOrphans([
    { role: 'tool', name: 'x', content: 'orphan' },     // leading orphan → dropped
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
    { role: 'tool', name: 'y', content: 'valid' },      // has preceding assistant → kept
  ]);
  rec('K9 leading orphan tool dropped, valid tool kept', out.length === 3 && out[0].role === 'user' && out[2].role === 'tool');
}

// ── K10 prompt shape ──
{
  const u = buildSummaryUser([{ role: 'user', content: 'I want to move to Lisbon' }], 'PRIOR SUMMARY', { dateStr: '2026-06-17' });
  rec('K10 structured sections present', /## Goal/.test(u) && /## Done/.test(u) && /## Key Context/.test(u));
  rec('K10 temporal anchoring present', /TEMPORAL ANCHORING: today is 2026-06-17/.test(u));
  rec('K10 iterative update preserves prior summary', /PRESERVE its facts/.test(u) && u.includes('PRIOR SUMMARY'));
}

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — compaction: threshold · windowed · tool-prune · structured summary · anti-thrash · orphan-safe · fail-through' : 'NO-GO — see FAIL rows'}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
