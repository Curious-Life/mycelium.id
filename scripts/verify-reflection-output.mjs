// scripts/verify-reflection-output.mjs — the cycle deliver/skip finalizer gate (C1).
//
// Pure, no vault. Locks the decision that reaches the person: the reserved NO_REPLY
// sentinel (however wrapped) never leaks, truncated fragments never deliver, self-
// referential "system status" meta-reports are suppressed, and delivery is idempotent.
// The four real production samples (2026-07-05..07) are asserted directly.

import './lib/gate-stdout.mjs'; // MUST be first: flushes VERDICT on a piped stdout
import {
  isSkipSentinel, looksLikeMetaReport, finalizeCycleOutput, cycleDeliveryId,
} from '../src/agent/cycle-output.js';

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`PASS  ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`FAIL  ${label}${extra ? '  ' + extra : ''}`); }
};

// ── isSkipSentinel: every wrapping the model has produced must count as skip ──
for (const s of [
  'NO_REPLY', 'no_reply', '  NO_REPLY  ', '**NO_REPLY**', '> NO_REPLY', '`NO_REPLY`',
  '"NO_REPLY"', '- NO_REPLY', 'NO_REPLY.', 'NO_REPLY\n\nNo data was found today.',
  '**NO_REPLY**.   No data streams were found from yesterday', 'NO REPLY', 'no-reply',
  '', '   ', '\n\n',
]) ok(isSkipSentinel(s), `skip sentinel recognised: ${JSON.stringify(s).slice(0, 48)}`);

// A real check-in must NOT be read as a skip.
for (const s of [
  'Good morning — I noticed you shipped the index fix.',
  'Yesterday was interesting — entirely consumed by one thing. Five messages, all repair.',
  'You mentioned the Warsaw trip; how did the drive go?',
]) ok(!isSkipSentinel(s), `real message deliverable: ${s.slice(0, 40)}`);

// ── looksLikeMetaReport: the plumbing-report class is suppressed ──
ok(looksLikeMetaReport('**System Status:** ⚠️ **NO_DATA_FOUND**. The requested data streams (getDailyMessages, searchMindscape) are returning empty results'), 'meta: system-status report');
ok(looksLikeMetaReport('Morning. Yesterday was a weird one — my pipes were dry. getDailyMessages and searchMindscape both came back empty'), 'meta: tool-name leak');
ok(!looksLikeMetaReport('Yesterday was interesting — entirely consumed by one thing. Five messages, all repair. Not much else moved.'), 'good check-in is not meta');
ok(!looksLikeMetaReport('You seemed heads-down on the release yesterday — did the deploy land cleanly?'), 'warm check-in is not meta');
// Review §2: natural words ("mindscape", "pipeline") must NOT false-positive a real message.
ok(!looksLikeMetaReport('I looked at your mindscape and the data pipeline you built is really taking shape.'), 'natural "mindscape"+"pipeline" is NOT meta (review §2)');
ok(!looksLikeMetaReport('Your pipeline for the launch looked solid; how did the mindscape mapping feel?'), 'natural pipeline/mindscape check-in delivers (review §2)');

// ── finalizeCycleOutput: end-to-end decisions, incl. the 4 live samples ──
const chat = { output_target: 'chat', id: 't1', next_run: '2026-07-05T05:00:00Z' };
const internal = { output_target: 'none', id: 't2', next_run: '2026-07-05T00:00:00Z' };

// The two production leaks — both must SKIP now.
ok(finalizeCycleOutput({ text: '**System Status:** ⚠️ **NO_DATA_FOUND**. The requested data streams (`getDailyMessages`, `searchMindscape`) are returning empty results' }, chat).action === 'skip', 'LIVE 07-05 morning meta-report → skip');
ok(finalizeCycleOutput({ text: '**NO_REPLY**.   No data streams were found from yesterday or today.' }, chat).action === 'skip', 'LIVE 07-05 weekly wrapped-NO_REPLY → skip');
// The good one delivers.
ok(finalizeCycleOutput({ text: 'Yesterday was interesting — entirely consumed by one thing. Five messages, all repair.' }, chat).action === 'deliver', 'LIVE 07-07 grounded check-in → deliver');

// Truncation and empties.
ok(finalizeCycleOutput({ text: 'I noticed you', truncated: true }, chat).status === 'skipped-truncated', 'truncated fragment → skip');
ok(finalizeCycleOutput({ text: '' }, chat).action === 'skip', 'empty → skip');
ok(finalizeCycleOutput({ text: '   ' }, chat).action === 'skip', 'whitespace → skip');

// Pre-turn skip statuses carry through.
ok(finalizeCycleOutput({ skipped: 'no-model' }, chat).status === 'skipped-no-model', 'no-model status');
ok(finalizeCycleOutput({ skipped: 'model-incapable' }, chat).status === 'skipped-model-incapable', 'model-incapable status');
ok(finalizeCycleOutput({ skipped: 'quiet' }, chat).status === 'skipped-quiet', 'quiet status');

// Internal cycles never deliver but are a clean 'done'.
ok(finalizeCycleOutput({ text: 'consolidated model.md' }, internal).action === 'skip' && finalizeCycleOutput({ text: 'x' }, internal).status === 'done', 'internal cycle → done, no deliver');

// A genuine message on a chat cycle delivers with status done.
{
  const d = finalizeCycleOutput({ text: 'You shipped the reflection fix — how does it feel?' }, chat);
  ok(d.action === 'deliver' && d.status === 'done' && d.text, 'chat check-in → deliver/done');
}

// ── idempotent delivery id ──
ok(cycleDeliveryId(chat) === cycleDeliveryId(chat), 'delivery id stable for same fire');
ok(cycleDeliveryId(chat) !== cycleDeliveryId({ ...chat, next_run: '2026-07-06T05:00:00Z' }), 'delivery id differs across fires');

// ── quiet-day gate (C2) ──
{
  const { hasEnoughActivity } = await import('../src/agent/cycle-activity.js');
  const mkDb = (n) => ({ messages: { countInRange: async () => n } });
  const morning = { minActivity: 5, activityWindow: 'yesterday' };
  ok((await hasEnoughActivity(mkDb(2), 'u', morning, { tz: 'America/New_York' })).enough === false, 'quiet day (<5 msgs) → gate skips');
  ok((await hasEnoughActivity(mkDb(9), 'u', morning, { tz: 'America/New_York' })).enough === true, 'active day (≥5 msgs) → gate runs');
  ok((await hasEnoughActivity(mkDb(0), 'u', {}, {})).enough === true, 'internal cycle (no minActivity) → always runs');
  ok((await hasEnoughActivity({ messages: { countInRange: async () => { throw new Error('x'); } } }, 'u', morning, {})).enough === true, 'count error → fail-open (never blocks a cycle)');
}

// ── custom-persona detection (C5 + review §6: robust to a constant change) ──
{
  const { resolveCustomPersona } = await import('../src/skills/store.js');
  const { REFLECTION_PERSONA } = await import('../src/agent/cycle-prompts.js');
  const doc = (content, cAt, uAt) => ({ documents: { get: async () => ({ content, created_at: cAt, updated_at: uAt }) } });
  const t0 = '2026-07-01T00:00:00Z', t1 = '2026-07-02T00:00:00Z';
  // seeded, untouched (updated≈created, content==default) → NOT custom
  ok((await resolveCustomPersona(doc(REFLECTION_PERSONA, t0, t0), 'u')) === null, 'seeded untouched persona → not custom (chat unchanged)');
  // edited after seed + differs → custom (steers chat)
  ok((await resolveCustomPersona(doc('Be playful and brief with me.', t0, t1), 'u')) === 'Be playful and brief with me.', 'edited persona → custom (steers chat)');
  // FOOTGUN: constant changed so old-seed content != new default, but never edited → still NOT custom
  ok((await resolveCustomPersona(doc('OLD DEFAULT PERSONA TEXT that no longer matches the constant', t0, t0), 'u')) === null, 'constant-change on an untouched doc does NOT flip chat (review §6)');
  // no doc → null
  ok((await resolveCustomPersona({ documents: { get: async () => null } }, 'u')) === null, 'no persona doc → not custom');
}

// ── capability probe (C3) shape ──
{
  const { resolveTaskCapability } = await import('../src/inference/capability.js');
  // No provider configured → not configured, not capable (cycles will skip 'no-model').
  const r = await resolveTaskCapability({ users: { getSettings: async () => ({}) }, providers: { getActive: async () => null } }, 'u', 'reflection');
  ok(r.configured === false && r.toolsCapable === false, 'no provider → configured:false, toolsCapable:false');
}

console.log(`\n${pass} pass · ${fail} fail`);
console.log(fail ? 'VERDICT: NO-GO' : 'VERDICT: GO');
process.exit(fail ? 1 : 0);
