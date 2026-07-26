// verify:agent-turn-taking — D-063. THE AGENT YIELDS THE TURN.
//
// The defect: "the bot auto-continues its own actions instead of waiting for the human to
// act — it doesn't leave room for the person to respond in time." (QA8/QA9 First contact.)
// Design: the agent turn-taking design (D-063).
//
// THE INVARIANT UNDER TEST: an agent turn is triggered by an inbound human message, or by
// an explicit user-initiated action — NEVER by the agent's own prior output. And an
// agent-INITIATED message is never delivered while the agent is awaiting an answer it just
// solicited.
//
// Everything below drives REAL product code: the REAL MCP registry (buildDomains +
// collectTools), the REAL grant chokepoint (autonomyTools), the REAL hook bus
// (createAgentHooks + fireBeforeToolCall), the REAL run-turn `call` closure, and the REAL
// scheduler (createScheduler + tickOnce) over a REAL booted vault with the REAL
// captureMessage writer and the REAL onboarding greeting composer. No string-matching of
// source, no assertions about comments.
//
// Each floor check STATES ITS OWN PRECONDITION (clearFloor + an asserted heldNow), because
// the first draft's F3 and F6 passed on state an earlier check had left behind.
//
//   ── Rule 1 · no self-arming (a turn no human started cannot arm the agent's next turn)
//   S1  the REAL registry: schedule_task IS granted on a human-triggered turn (capability kept)
//   S2  …and is STRIPPED on a turn no human started, even when explicitly named; and the flag
//       itself is fail-CLOSED for every non-`true` value, not merely defaulted by its callers
//   S3  end-to-end through the REAL runAgentTurn `call` closure: a scheduler-shaped turn that
//       tries to call schedule_task is REFUSED and writes NO scheduled_tasks row
//   S3b …while the same turn, human-triggered, DOES arm a task (non-vacuity)
//   S4  runtime layer 2 (the guard): the REAL hook bus blocks schedule_task, allows a read
//       tool, and still composes the MYCELIUM_AUTONOMOUS_TOOL_DENY denylist
//   S5  runtime layer 2 (the WIRING): the hook bag createScheduler itself built blocks it
//   S6  the CHANNEL router really passes humanTriggered:true — the one production site that
//       GRANTS self-arming (an owner DM's "remind me tomorrow" must keep working)
//
//   ── Rule 2 · yield the floor (no agent-initiated message over an unanswered question)
//   F0  control / non-vacuity: on an empty vault a due 'chat' task DOES deliver
//   F1  after the REAL onboarding greeting (intro + question), a due 'chat' task delivers
//       NOTHING — status skipped-awaiting-reply — and the turn is never even attempted
//   F3  another AGENT question does NOT release the floor (only a human does)
//   F3b a 'scheduler'-authored question holds the floor ON ITS OWN (no portal-chat row)
//   F3c 40 newer rows from another surface do not bury the floor (the read is source-filtered
//       in SQL — an unfiltered "newest N" fails OPEN on a busy vault)
//   F3d a FUTURE-dated row cannot mute the agent (created_at is caller-supplied)
//   F2  an inbound HUMAN message releases a floor asserted HELD → the same task delivers
//   F4  layer 2 closes the race: a question that lands DURING the turn still suppresses
//   F5  the hold is time-bounded (anti-deadlock), and the bound is a real argument
//   F5b a HELD one-off fire is DEFERRED, not consumed — and delivers after the person replies
//   F6  'none' / 'channel:*' are never held (they reach nobody) while a 'chat' task in the
//       SAME tick IS held — so the target filter is not a blanket off-switch
//   F7  fail-closed: an unreadable floor holds, with the DISTINCT skipped-floor-unknown
//   F8  units: endsWithQuestion + floorState polarity (structural, not string-matched)
//
// ── MANDATORY MUTATION RECORD (/gate-teeth) — every mutation below was RUN against this
//    gate, observed RED on exactly the checks named, then restored. The suite returns GREEN
//    on the restored tree (re-confirmed after the last restore).
//
// MUTATION-TESTED: filterSelfArming (src/agent/turn-taking.js) → `return list;` — the
//   pre-fix behaviour, self-arming always granted → S2, BOTH S3 rows and (in the draft that
//   had it) the grant check RED; the S3 row count went 0 → 1, i.e. the agent armed its own
//   next turn. S1 and S3b stayed GREEN, which is the point — they pin the capability that
//   must SURVIVE for owner DMs.
// MUTATION-TESTED: filterSelfArming's guard → `if (humanTriggered !== false)` (undefined and
//   null pass through — a fail-OPEN of the primitive) → ONLY the `S2 filterSelfArming is
//   fail-CLOSED for every non-true flag` row REDs. Recorded because this mutation left an
//   earlier draft of this gate entirely GREEN: both call sites default the flag, so nothing
//   but a direct probe of the primitive can pin its polarity.
// MUTATION-TESTED: the runtime deny inside selfArmingDenyGuard (the SELF_ARMING_TOOLS
//   branch) deleted → the two S4 rows about blocking RED (and S5's block row); the
//   env-denylist composition rows stayed GREEN, so the responsibilities are pinned separately.
// MUTATION-TESTED: src/agent/scheduler.js reverted to `toolGuard: autonomousToolGuard()` —
//   the runtime layer UNWIRED while the guard function itself stays perfect → S5's block row
//   REDs, and ONLY it. Recorded because with the gate asserting a locally-built guard only,
//   this exact mutation left it fully GREEN (independent review, 2026-07-26) — the M-001
//   pattern. `_hooks` exists as a seam so the WIRING is what gets pinned.
// MUTATION-TESTED: `humanTriggered: true` deleted from src/agent/channel-turn.js → S6's first
//   row REDs (the owner's "remind me tomorrow" silently stops working). Also previously GREEN
//   before S6 existed.
// MUTATION-TESTED: BOTH floor layers in src/agent/scheduler.js runTask deleted (the
//   pre-turn `if (proactiveTargetsPerson(task))` block AND the pre-deliver
//   holdProactiveDelivery) — i.e. the D-063 defect itself restored → F1 (all three rows),
//   F3, F4 (both) and F7 (both) RED. F0/F2/F5/F6/F8 stayed GREEN.
// MUTATION-TESTED: only the PRE-TURN layer deleted → exactly one row REDs, `F1 …the turn
//   was never even attempted`. Everything else stays GREEN because the pre-deliver layer
//   still suppresses. Recorded deliberately: it is the evidence that the two layers have
//   DIFFERENT jobs (layer 1 spends no tokens; layer 2 guards the delivery) and that neither
//   is decoration — remove both and F1's suppression itself REDs (mutation above).
// MUTATION-TESTED: only the PRE-DELIVER layer deleted → exactly the two F4 rows RED (the
//   mid-turn greeting is talked over); F1/F2/F3 stay GREEN.
// MUTATION-TESTED: shouldHoldProactive → `return !!state?.awaitingAnswer` (window ignored)
//   → F5 and the F8 shouldHoldProactive row RED, proving the anti-deadlock bound is
//   load-bearing and not a comment.
// MUTATION-TESTED: holdProactiveDelivery's catch → `return { hold: false, status: null }`
//   (fail-OPEN) → both F7 rows RED (suppression and the distinct status).
// MUTATION-TESTED: endsWithQuestion → `return false` → the F1 precondition + all three F1
//   rows, F3, both F4 rows and two F8 rows RED. F0/F2/F5/F6 stayed GREEN.
// MUTATION-TESTED: `sources: [...FLOOR_SOURCES]` removed from readFloorState (an unfiltered
//   "newest N of everything" read) → F3c and the F5 holdMs row RED. This is the busy-vault
//   fail-OPEN an independent review found: 40 rows from another surface buried the question.
// MUTATION-TESTED: FLOOR_SOURCES → `['portal-chat']` (drop 'scheduler') → F3b REDs, and ONLY
//   it. Recorded because F3 alone did NOT catch this — it inherits F1's portal-chat greeting,
//   so its own scheduler-authored message was inert. F3b removes that borrowed state.
// MUTATION-TESTED: the `if (at > now + FUTURE_SKEW_MS) continue;` drop in floorState removed
//   → F3d and both future-dated F8 rows RED — a single row stamped a year ahead muted every
//   proactive message and no human reply could release it.
// MUTATION-TESTED: floorState's `at > latest.at` → `at < latest.at` (oldest wins) → both F4
//   rows, the second F5b row and two F8 rows RED.
// MUTATION-TESTED: proactiveTargetsPerson → `return false` (the floor never consulted) → 13
//   rows RED across F1/F3/F3b/F3c/F4/F6/F7.
// MUTATION-TESTED: `holdFire(task, …)` → `advance(task, …)` in both scheduler hold paths →
//   both F5b rows RED: the held one-off reminder was marked `completed`, undelivered and never
//   retried. That was a REAL defect in the first draft of this fix, found by independent
//   review, and F5b exists because of it.
import Database from 'better-sqlite3';
import { rmSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import express from 'express';
import crypto from 'node:crypto';
import { boot } from '../src/index.js';
import { applyMigrations } from '../src/db/migrate.js';
import { buildDomains, collectTools } from '../src/mcp.js';
import { autonomyTools } from '../src/agent/autonomy-tools.js';
import { createScheduler } from '../src/agent/scheduler.js';
import { createChannelTurnRouter } from '../src/agent/channel-turn.js';
import { runAgentTurn } from '../src/agent/run-turn.js';
import { createAgentHooks, autonomousToolGuard, fireBeforeToolCall } from '../src/agent/hooks.js';
import { captureMessage } from '../src/ingest/capture.js';
import { composeOnboardingGreeting } from '../src/portal-chat.js';
import {
  endsWithQuestion, floorState, shouldHoldProactive, proactiveTargetsPerson,
  selfArmingDenyGuard, holdProactiveDelivery, filterSelfArming, FLOOR_SOURCES, DEFAULT_HOLD_MS,
} from '../src/agent/turn-taking.js';

const DB = 'data/verify-agent-turn-taking.db', KCV = 'data/verify-agent-turn-taking-kcv.json';
for (const f of [DB, KCV, `${DB}-shm`, `${DB}-wal`]) { try { rmSync(f); } catch {} }
mkdirSync('data', { recursive: true });
applyMigrations(new Database(DB));
const { db, close } = await boot({ dbPath: DB, kcvPath: KCV, userHex: crypto.randomBytes(32).toString('hex'), systemHex: crypto.randomBytes(32).toString('hex'), embedder: null });
const U = 'local-user';
const H = db.harness;

const ledger = [];
const rec = (n, ok, d = '') => { ledger.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '\n      ' + d : ''}`); };
const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();
const has = (arr, n) => (arr || []).some((t) => t.name === n);

// The REAL registry, exactly as boot builds it.
delete process.env.AGENT_URL;
const { domains } = buildDomains({ db, userId: U });
const { tools, handlers } = collectTools(domains);

// A chat-surface message, written through the REAL capture chokepoint (same funnel the
// greeting and the scheduler's deliveries use).
let seq = 0;
const say = (role, content, { source = 'portal-chat', at = 0 } = {}) => captureMessage(db, {
  id: `ttk-${role}-${seq++}`, userId: U, role, content, source, messageType: 'chat',
  conversationId: 'chat:ttk', createdAt: iso(at),
}, undefined);

// ════════════════════════════════ Rule 1 — no self-arming ════════════════════════════════

// ── S1/S2 the grant chokepoint, over the REAL registry ──
{
  const human = autonomyTools(tools, ['schedule_task'], { humanTriggered: true });
  rec('S1 schedule_task IS granted on a HUMAN-triggered turn (owner-DM capability kept)',
    has(human, 'schedule_task') && has(human, 'getContext'));
  const auto = autonomyTools(tools, ['schedule_task']);
  rec('S2 schedule_task STRIPPED on a turn no human started, even when named',
    !has(auto, 'schedule_task') && has(auto, 'getContext'), `granted=${auto.length}`);
  // The FLAG ITSELF must be fail-closed, not merely defaulted by its callers. `humanTriggered
  // !== false` (letting undefined/null through) passes every other check in this gate because
  // both call sites default it — so only a direct probe of the primitive can pin the polarity.
  const strippedFor = (flag) => !filterSelfArming(['schedule_task'], { humanTriggered: flag }).includes('schedule_task');
  rec('S2 filterSelfArming is fail-CLOSED for every non-true flag (undefined · null · "true" · 1 · {})',
    strippedFor(undefined) && strippedFor(null) && strippedFor('true') && strippedFor(1) && strippedFor({})
    && !strippedFor(true));
}

// ── S3/S3b end-to-end through the REAL runAgentTurn `call` closure ──
// A fake loop stands in for the model: it invokes the very `call` closure run-turn built
// (the real grant check at run-turn.js) with a real schedule_task request, and reports the
// tool defs run-turn actually granted. Everything else — provider resolution, budgeting,
// the grant — is the product's own code path.
{
  const pid = await db.providers.create(U, { provider: 'anthropic', label: 'Anthropic', authType: 'api_key', credentials: JSON.stringify({ apiKey: 'sk-test' }), model: 'claude-x' });
  await db.providers.setActive(pid, U);

  const drive = async ({ humanTriggered }) => {
    let out = null; let granted = [];
    const fakeLoop = {
      run: async ({ tools: granted_, call }) => {
        granted = granted_ || [];
        out = await call('schedule_task', { prompt: 'ping the person again', schedule: 'interval:30m' });
        return { text: '', toolsUsed: [] };
      },
    };
    const before = (await H.listTasks(U)).length;
    await runAgentTurn(
      { db, userId: U, tools, handlers, loop: fakeLoop, fetchImpl: async () => { throw new Error('no-net'); } },
      { userMessage: 'x', enabledTools: ['schedule_task'], localTools: true, humanTriggered },
    );
    const after = (await H.listTasks(U)).length;
    return { out: String(out || ''), granted, created: after - before };
  };

  const auto = await drive({ humanTriggered: false });
  rec('S3 a scheduler-shaped turn calling schedule_task is REFUSED by the real call closure',
    /not available to this turn/i.test(auto.out) && !has(auto.granted, 'schedule_task'), auto.out.slice(0, 70));
  rec('S3 …and NO scheduled_tasks row was armed by the agent\'s own turn',
    auto.created === 0, `created=${auto.created}`);

  const human = await drive({ humanTriggered: true });
  rec('S3b non-vacuity: the SAME turn, human-triggered, DOES arm a task',
    /Scheduled/.test(human.out) && human.created === 1, `${human.out.slice(0, 50)} created=${human.created}`);

  // Leave no armed task behind — it would be due and would perturb the Rule-2 checks.
  for (const t of await H.listTasks(U)) { if (t.created_by === 'agent') await H.setTaskStatus(U, t.id, 'cancelled'); }
}

// ── S4 runtime layer 2: the REAL hook bus ──
{
  const hooks = createAgentHooks({ db, userId: U, source: 'scheduler', toolGuard: selfArmingDenyGuard(autonomousToolGuard()) });
  const blocked = await fireBeforeToolCall(hooks, { name: 'schedule_task', args: {}, surface: 'scheduler' });
  const allowed = await fireBeforeToolCall(hooks, { name: 'searchMindscape', args: {}, surface: 'scheduler' });
  rec('S4 the real hook bus BLOCKS schedule_task on the scheduler surface', blocked?.block === true, blocked?.reason || '');
  rec('S4 …and still ALLOWS a read tool (not a blanket deny)', allowed === undefined);

  process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY = 'searchMindscape';
  const composed = createAgentHooks({ db, userId: U, source: 'scheduler', toolGuard: selfArmingDenyGuard(autonomousToolGuard()) });
  const envBlocked = await fireBeforeToolCall(composed, { name: 'searchMindscape', args: {}, surface: 'scheduler' });
  const stillBlocked = await fireBeforeToolCall(composed, { name: 'schedule_task', args: {}, surface: 'scheduler' });
  delete process.env.MYCELIUM_AUTONOMOUS_TOOL_DENY;
  rec('S4 the env denylist still composes (not replaced by the new guard)', envBlocked?.block === true);
  rec('S4 …and the self-arming deny survives alongside it', stillBlocked?.block === true);
}

// ── S5 the SCHEDULER'S OWN hook bag, as the product wired it ──
// Not a locally-built guard: this fires the REAL `hooks` object createScheduler constructed
// (`_hooks`, a test seam beside the existing `_lane`). An earlier draft of this gate asserted
// only a hand-built guard — and unwiring the scheduler left the gate fully GREEN
// (independent review, 2026-07-26). This is what pins the WIRING.
{
  const probe = createScheduler({ db, userId: U, tools, handlers, deliver: async () => {}, logger: () => {} });
  const blocked = await fireBeforeToolCall(probe._hooks, { name: 'schedule_task', args: {}, surface: 'scheduler' });
  const allowed = await fireBeforeToolCall(probe._hooks, { name: 'searchMindscape', args: {}, surface: 'scheduler' });
  probe.stop();
  rec('S5 the SCHEDULER-BUILT hook bag blocks schedule_task (the wiring, not just the guard)',
    blocked?.block === true, blocked?.reason || 'NOT BLOCKED');
  rec('S5 …and that same wired bag still allows a read tool', allowed === undefined);
}

// ── S6 the CHANNEL router passes humanTriggered — the one production site that GRANTS it ──
// Drives the REAL createChannelTurnRouter over a real HTTP request from loopback with a valid
// daemon token (an owner 1:1 DM ⇒ owner-trusted), capturing the opts it hands the turn.
// Without this, deleting `humanTriggered: true` from channel-turn.js silently kills the
// owner's "remind me tomorrow" and the gate stays green (independent review, 2026-07-26).
{
  let seen = null;
  const TOKEN = 'ttk-channel-turn-secret';
  const app = express();
  app.use(createChannelTurnRouter({
    db, userId: U, tools: [], handlers: {}, expectedToken: TOKEN, logger: () => {},
    runTurn: async (opts) => { seen = opts; return { text: 'ok', toolsUsed: ['reply'] }; },
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/internal/agent/channel-turn`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mycelium-channel-turn-token': TOKEN },
    body: JSON.stringify({ userMessage: 'remind me tomorrow', source: 'telegram', isDirect: true, senderRole: 'owner' }),
  });
  await res.json().catch(() => ({}));
  await new Promise((r) => server.close(r));
  rec('S6 an inbound owner DM reaches the turn as humanTriggered:true (self-arming stays possible)',
    seen !== null && seen.humanTriggered === true, `humanTriggered=${seen?.humanTriggered}`);
  rec('S6 …and that turn really does carry the self-arming grant',
    Array.isArray(seen?.enabledTools) && seen.enabledTools.includes('schedule_task'));
}

// ════════════════════════════════ Rule 2 — yield the floor ═══════════════════════════════

// One REAL scheduler with a stubbed turn-executor + delivery spy: this proves the
// orchestration decision (speak / hold), not inference.
const calls = [];
const delivered = [];
let stub = async () => ({ text: 'CHECK-IN' });
const sched = createScheduler({
  db, userId: U, tools: [], handlers: {},
  runTurn: async (task) => { calls.push(task.id); return stub(task); },
  deliver: async (task, text) => { delivered.push({ id: task.id, text }); },
  logger: () => {},
});
const dueChatTask = (name) => H.createTask(U, { name, prompt: 'p', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'chat' });
const lastStatus = async (id) => (await H.getTask(U, id)).last_status;
const countFor = (id) => calls.filter((x) => x === id).length;
const deliveredFor = (id) => delivered.filter((d) => d.id === id).length;
// Wipe the conversational surface so each floor check STATES its own precondition instead of
// inheriting one. Without this the checks pass on state an earlier check happened to leave —
// which is exactly how the first draft's F3 and F6 became vacuous (independent review).
const clearFloor = async () => {
  const rows = await db.messages.selectRecent(U, { limit: 1000, sources: [...FLOOR_SOURCES], scope: 'all' });
  if (rows.length) await db.messages.deleteIds(rows.map((r) => r.id), U);
  const left = await db.messages.selectRecent(U, { limit: 10, sources: [...FLOOR_SOURCES], scope: 'all' });
  if (left.length) throw new Error(`clearFloor left ${left.length} row(s) — later checks would be vacuous`);
};
// Is the floor held RIGHT NOW, by the same read the product uses? Used to assert each
// check's precondition, so "runs normally while held" cannot pass on a free floor.
const heldNow = async () => (await holdProactiveDelivery(db, U)).hold === true;

// ── F0 control: an empty vault has no floor → the check-in delivers ──
{
  const id = await dueChatTask('f0');
  stub = async () => ({ text: 'GOOD-MORNING' });
  await sched.tickOnce();
  rec('F0 control/non-vacuity: with no prior conversation the due chat task DELIVERS',
    deliveredFor(id) === 1 && await lastStatus(id) === 'done', `delivered=${deliveredFor(id)}`);
}

// ── F1 the REAL first-contact greeting holds the floor ──
{
  const greeting = composeOnboardingGreeting({ name: 'Mya', messageCount: 0, territoryCount: 0 });
  rec('F1 precondition: the shipped onboarding greeting ends by asking the person something',
    endsWithQuestion(greeting));
  await say('assistant', greeting);                    // exactly what POST /onboarding/greeting persists
  const id = await dueChatTask('f1');
  stub = async () => ({ text: 'THIS-MUST-NOT-BE-SENT' });
  await sched.tickOnce();
  rec('F1 after the greeting no agent-initiated message is emitted',
    deliveredFor(id) === 0, `delivered=${deliveredFor(id)}`);
  rec('F1 …recorded as skipped-awaiting-reply', await lastStatus(id) === 'skipped-awaiting-reply', await lastStatus(id));
  rec('F1 …and the turn was never even attempted (no tokens spent)', countFor(id) === 0, `calls=${countFor(id)}`);
}

// ── F3 another AGENT question does not release the floor (checked before F2 flips it) ──
{
  await say('assistant', 'One more thing — what should I call you?', { source: 'scheduler' });
  const id = await dueChatTask('f3');
  await sched.tickOnce();
  rec('F3 a further AGENT question does NOT release the floor',
    deliveredFor(id) === 0 && await lastStatus(id) === 'skipped-awaiting-reply', await lastStatus(id));
}

// ── F3b a SCHEDULER-authored question holds the floor ON ITS OWN ──
// F3 passes on state F1 already established, so it cannot tell whether 'scheduler' is in
// FLOOR_SOURCES: drop that source and the gate stayed green (independent review). Here the
// scheduler's own check-in is the ONLY conversational row, so the check is load-bearing —
// otherwise one check-in ending in a question is talked over by the next one.
{
  await clearFloor();
  await say('assistant', 'How did the clinic call go?', { source: 'scheduler' });
  const id = await dueChatTask('f3b');
  stub = async () => ({ text: 'MUST-NOT-TALK-OVER-MY-OWN-QUESTION' });
  await sched.tickOnce();
  rec("F3b a 'scheduler'-authored question holds the floor with no portal-chat row present",
    deliveredFor(id) === 0 && await lastStatus(id) === 'skipped-awaiting-reply', await lastStatus(id));
}

// ── F3c the floor read is EXACT, not "the newest N rows of everything" ──
// Bury the agent's question under far more than FLOOR_READ_LIMIT rows from other surfaces.
// An unfiltered read finds no conversational row → reads the floor as FREE → talks over the
// person. This is the busy-vault fail-open an independent review found.
{
  await clearFloor();
  await say('assistant', 'Which of those should I start with?');
  for (let i = 0; i < 40; i++) await say('user', `unrelated channel traffic ${i}`, { source: 'telegram' });
  const id = await dueChatTask('f3c');
  stub = async () => ({ text: 'BURIED-BUT-STILL-HELD' });
  await sched.tickOnce();
  rec('F3c 40 newer rows from another surface do NOT bury the floor (source-filtered read)',
    deliveredFor(id) === 0 && await lastStatus(id) === 'skipped-awaiting-reply', await lastStatus(id));
}

// ── F3d a row dated in the FUTURE cannot mute the agent ──
// created_at is caller-supplied on several write paths (the captureMessage MCP tool takes
// role + source + createdAt from the model). A single future-stamped question would otherwise
// stay "latest" forever: no human reply could release it and the bounded window could never
// expire — a permanent mute of every proactive message.
{
  await clearFloor();
  await say('assistant', 'Am I muted forever?', { at: 365 * 24 * 60 * 60 * 1000 });   // a year ahead
  await say('user', 'no, here I am');                                                  // a REAL reply, now
  const id = await dueChatTask('f3d');
  stub = async () => ({ text: 'STILL-SPEAKING' });
  await sched.tickOnce();
  rec('F3d a future-dated agent question is ignored — a real human reply still releases the floor',
    deliveredFor(id) === 1 && await lastStatus(id) === 'done', `delivered=${deliveredFor(id)} last=${await lastStatus(id)}`);
}

// ── F2 an inbound HUMAN message releases it ──
// States its own precondition: the floor is asserted HELD first, so "it delivers" is evidence
// about the human message and not about an already-free floor.
{
  await clearFloor();
  await say('assistant', 'And who are you?');
  const wasHeld = await heldNow();
  await say('user', "I'm Martin.");
  const id = await dueChatTask('f2');
  stub = async () => ({ text: 'NICE-TO-MEET-YOU' });
  await sched.tickOnce();
  rec('F2 an inbound human message releases a HELD floor → the check-in delivers',
    wasHeld && deliveredFor(id) === 1 && await lastStatus(id) === 'done', `wasHeld=${wasHeld} delivered=${deliveredFor(id)}`);
}

// ── F4 the pre-deliver layer closes the mid-turn race ──
// Floor is FREE when the tick starts (F2 left a human message newest). The turn itself
// persists a question — as finishing onboarding mid-tick would — and the delivery must
// still be suppressed. This can only pass via the second (pre-deliver) floor read.
{
  const id = await dueChatTask('f4');
  stub = async () => {
    await say('assistant', 'Before I answer — is now a good time?');
    return { text: 'RACED-MESSAGE' };
  };
  await sched.tickOnce();
  rec('F4 a question that lands DURING the turn still suppresses the delivery (layer 2)',
    deliveredFor(id) === 0 && countFor(id) === 1, `delivered=${deliveredFor(id)} calls=${countFor(id)}`);
  rec('F4 …recorded as skipped-awaiting-reply', await lastStatus(id) === 'skipped-awaiting-reply', await lastStatus(id));
}

// ── F5 the hold is time-bounded (anti-deadlock) ──
{
  await clearFloor();
  // The ONLY conversational row is an unanswered question older than the window: a person who
  // never answers must not permanently mute their agent.
  await say('assistant', 'Still curious — who are you?', { at: -(DEFAULT_HOLD_MS + 60_000) });
  const id = await dueChatTask('f5');
  stub = async () => ({ text: 'LATER-CHECKIN' });
  await sched.tickOnce();
  rec('F5 a STALE unanswered question does not hold (bounded — never a permanent mute)',
    deliveredFor(id) === 1 && await lastStatus(id) === 'done', `delivered=${deliveredFor(id)} last=${await lastStatus(id)}`);
  // …and the bound is an ARGUMENT, not a constant baked past its caller: the same fresh
  // question holds or not purely by the window it is judged against.
  await clearFloor();
  await say('assistant', 'Fresh question — ready?', { at: -5000 });   // 5s old
  const tight = await holdProactiveDelivery(db, U, { holdMs: 1000 });
  const wide = await holdProactiveDelivery(db, U, { holdMs: DEFAULT_HOLD_MS });
  rec('F5 holdProactiveDelivery honours an explicit holdMs (1s window ⇒ free, default ⇒ held)',
    tight.hold === false && wide.hold === true, `tight=${tight.hold} wide=${wide.hold}`);
}

// ── F5b a HELD one-off fire is DEFERRED, never consumed ──
// advance() marks a spent 'once' schedule COMPLETED, so holding an owner reminder ("remind me
// at 15:00 to call the clinic") would DESTROY it — completed, undelivered, never retried
// (independent review, 2026-07-26). It must be re-armed instead.
{
  await clearFloor();
  await say('assistant', 'Quick one — shall I book it?');
  const id = await H.createTask(U, { name: 'f5b-once', prompt: 'call the clinic', schedule: 'once', scheduledAt: iso(-5000), nextRun: iso(-1000), outputTarget: 'chat' });
  stub = async () => ({ text: 'REMINDER' });
  await sched.tickOnce();
  const t = await H.getTask(U, id);
  rec('F5b a held one-off is NOT completed and keeps a FUTURE next_run (deferred, not lost)',
    deliveredFor(id) === 0 && t.status === 'active' && !!t.next_run && t.next_run > iso(),
    JSON.stringify({ status: t.status, next_run: t.next_run, last: t.last_status }));
  // …and once the person replies, that same deferred reminder does fire.
  await say('user', 'yes please');
  await H.updateTask(U, id, { next_run: iso(-1000) });
  await sched.tickOnce();
  rec('F5b …and it DELIVERS once the person replies (the promise was kept)',
    deliveredFor(id) === 1, `delivered=${deliveredFor(id)}`);
}

// ── F6 targets that reach nobody are never held ──
{
  await clearFloor();
  await say('assistant', 'And what are you working on?');
  const wasHeld = await heldNow();
  rec('F6 precondition asserted: the floor IS held for this tick', wasHeld);
  const idNone = await H.createTask(U, { name: 'f6-none', prompt: 'p', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'none' });
  const idCh = await H.createTask(U, { name: 'f6-ch', prompt: 'p', schedule: 'interval:30m', nextRun: iso(-1000), outputTarget: 'channel:telegram' });
  const idChat = await dueChatTask('f6-chat');
  stub = async () => ({ text: 'INTERNAL' });
  await sched.tickOnce();
  rec("F6 output_target 'none' runs normally while the floor is held",
    wasHeld && countFor(idNone) === 1 && await lastStatus(idNone) === 'done', `last=${await lastStatus(idNone)}`);
  rec("F6 output_target 'channel:*' runs normally while the floor is held",
    wasHeld && countFor(idCh) === 1 && await lastStatus(idCh) === 'done', `last=${await lastStatus(idCh)}`);
  rec('F6 …while a person-targeting task in the SAME tick IS held (the filter is not a blanket off-switch)',
    deliveredFor(idChat) === 0 && await lastStatus(idChat) === 'skipped-awaiting-reply', await lastStatus(idChat));
  rec('F6 proactiveTargetsPerson: chat/conversation yes; none/channel no',
    proactiveTargetsPerson({ output_target: 'chat' })
    && proactiveTargetsPerson({ output_target: 'conversation:chat:x' })
    && !proactiveTargetsPerson({ output_target: 'none' })
    && !proactiveTargetsPerson({ output_target: 'channel:telegram' })
    && !proactiveTargetsPerson({}));
}

// ── F7 fail-closed: an unreadable floor HOLDS, with a DISTINCT status ──
// The floor is deliberately FREE here (a human message is newest), so the only reason this
// task can be held is the read failure itself.
{
  await clearFloor();
  await say('user', 'the floor is mine');
  rec('F7 precondition asserted: the floor is FREE before the read is broken', !(await heldNow()));
  const real = db.messages.selectRecent;
  db.messages.selectRecent = async () => { throw new Error('floor-read-boom'); };
  const id = await dueChatTask('f7');
  stub = async () => ({ text: 'MUST-NOT-SEND' });
  await sched.tickOnce();
  db.messages.selectRecent = real;
  rec('F7 an unreadable floor HOLDS the delivery (fail-closed)', deliveredFor(id) === 0, `delivered=${deliveredFor(id)}`);
  rec('F7 …under the DISTINCT status skipped-floor-unknown (never confused with a real hold)',
    await lastStatus(id) === 'skipped-floor-unknown', await lastStatus(id));
}

// ── F8 units: whose turn it is, structurally ──
{
  rec('F8 endsWithQuestion: plain / markdown-wrapped / quoted question',
    endsWithQuestion('who are you?') && endsWithQuestion('**who are you?**') && endsWithQuestion('he said "who are you?"'));
  rec('F8 endsWithQuestion: a statement, an empty string, and a question followed by a conclusion are NOT',
    !endsWithQuestion('I saved that for you.') && !endsWithQuestion('') && !endsWithQuestion('Shall I?\nI already did it.'));
  const now = Date.now();
  const row = (role, content, source, ms) => ({ role, content, source, created_at: new Date(now - ms).toISOString() });
  rec('F8 floorState: newest agent question ⇒ heldByAgent + awaitingAnswer',
    (() => { const s = floorState([row('user', 'hi', 'portal-chat', 5000), row('assistant', 'who are you?', 'portal-chat', 1000)], { now }); return s.heldByAgent && s.awaitingAnswer; })());
  rec('F8 floorState: a NEWER human message releases it (order, not content)',
    (() => { const s = floorState([row('assistant', 'who are you?', 'portal-chat', 5000), row('user', 'Martin', 'portal-chat', 1000)], { now }); return !s.heldByAgent && !s.awaitingAnswer && s.lastRole === 'user'; })());
  rec('F8 floorState: non-conversational sources are ignored (an import cannot hold the floor)',
    (() => { const s = floorState([row('assistant', 'who are you?', 'whatsapp', 1000)], { now }); return !s.heldByAgent && s.lastRole === null; })());
  rec('F8 floorState: a FUTURE-dated row is dropped, so a real reply still wins the floor',
    (() => { const s = floorState([row('assistant', 'muted?', 'portal-chat', -3600_000), row('user', 'no', 'portal-chat', 1000)], { now }); return !s.heldByAgent && s.lastRole === 'user'; })());
  rec('F8 floorState: a future-dated row alone leaves the floor FREE (never an unexpiring hold)',
    (() => { const s = floorState([row('assistant', 'muted?', 'portal-chat', -3600_000)], { now }); return !s.heldByAgent && !s.awaitingAnswer && s.lastRole === null; })());
  rec('F8 shouldHoldProactive: fresh question holds; stale does not; no question never holds',
    shouldHoldProactive({ awaitingAnswer: true, ageMs: 60_000 })
    && !shouldHoldProactive({ awaitingAnswer: true, ageMs: DEFAULT_HOLD_MS + 1 })
    && !shouldHoldProactive({ awaitingAnswer: false, ageMs: 0 })
    && !shouldHoldProactive(null));
}

sched.stop();
try { await close(); } catch { /* */ }

const allPass = ledger.every(Boolean);
console.log('='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO' : 'NO-GO'} — turn-taking: no self-arming (grant + runtime) · the agent yields the floor after asking (pre-turn + pre-deliver) · bounded, human-released, fail-closed  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
