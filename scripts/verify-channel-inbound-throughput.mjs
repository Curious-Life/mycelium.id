// verify:channel-inbound-throughput — MED-4: heavy media contextualization must
// NOT block the poller, and a per-sender flood must DEGRADE to a placeholder
// (never drop an owner message). Pure DI (no network); a deferred "gate" promise
// makes the media stage controllably slow. Asserts:
//   media-queue.js (unit):
//     - submit accepts up to the bound; pending() tracks queued+running; idle() drains
//     - over the bound → reject 'queue-full' (checked BEFORE the bucket — no token spent)
//     - non-owner over senderMax → reject 'rate-limited'; OWNER is exempt
//   inbound.js (integration with the queue wired):
//     - I1: a media submit returns immediately (capture not yet done; pending===1)
//     - I2 (headline): a subsequent owner DM is captured + turned WHILE media is still pending
//     - I3: after the gate resolves + idle(), the media message is captured (attachmentId + content)
//     - I4: a throttled non-owner media DEGRADES — captured w/ placeholder, turn runs, extraction NOT called
//     - I5: owner media is never throttled (all accepted, extracted)
//     - I6: unauthorized media is never submitted, never captured (stage never runs)
// PASS/FAIL ledger; exit 1 on any fail.
import { createInboundHandler } from '../packages/channel-daemon/inbound.js';
import { createMediaQueue } from '../packages/channel-daemon/media-queue.js';
import { normalizeUpdate } from '../packages/channel-daemon/transport/normalize.js';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };

const OWNER = '111';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// A normalized owner photo (media-bearing). `from`/`chat` overridable for non-owner.
const photoMsg = (id, { from = OWNER, chat = OWNER, caption = 'look' } = {}) => normalizeUpdate({
  update_id: id,
  message: { message_id: 600 + id, date: 1717600000, chat: { id: Number(chat), type: 'private' }, from: { id: Number(from), username: 'u' }, caption, photo: [{ file_id: `pf${id}`, file_unique_id: `pu${id}`, file_size: 500 }] },
});
const textMsg = (id, { from = OWNER, chat = OWNER } = {}) => normalizeUpdate({
  update_id: id,
  message: { message_id: 600 + id, date: 1717600000, chat: { id: Number(chat), type: 'private' }, from: { id: Number(from), username: 'u' }, text: 'urgent owner note' },
});

// ── media-queue.js unit ───────────────────────────────────────────────────────
// Q1 (bound, isolated from the bucket via owner-exempt jobs):
{
  const gate = deferred();
  const q = createMediaQueue({ maxPending: 2, senderMax: 99, senderWindowMs: 60_000 });
  const ran = [];
  const slow = (id) => () => { ran.push(id); return gate.promise; };
  const a = q.submit({ fromId: OWNER, owner: true, run: slow('a') });
  const b = q.submit({ fromId: OWNER, owner: true, run: slow('b') });
  rec('Q1. submit accepts up to the bound; pending tracks queued+running', a.accepted && b.accepted && q.pending() === 2, `pending=${q.pending()}`);
  const c = q.submit({ fromId: OWNER, owner: true, run: slow('c') });
  rec('Q2. at the bound → reject queue-full (never enqueued)', !c.accepted && c.reason === 'queue-full' && q.pending() === 2, `reason=${c.reason} pending=${q.pending()}`);
  gate.resolve();
  await q.idle();
  rec('Q3. idle() drains; jobs ran serially in FIFO order; rejected job never ran', q.pending() === 0 && ran.join(',') === 'a,b', `ran=${ran.join(',')} pending=${q.pending()}`);
}

// Q4 (per-sender throttle + owner exemption, isolated from the bound):
{
  const q = createMediaQueue({ maxPending: 99, senderMax: 2, senderWindowMs: 60_000 });
  const noop = () => sleep(1);
  const d1 = q.submit({ fromId: '5', owner: false, run: noop });
  const d2 = q.submit({ fromId: '5', owner: false, run: noop });
  const d3 = q.submit({ fromId: '5', owner: false, run: noop });
  rec('Q4. non-owner over senderMax → reject rate-limited', d1.accepted && d2.accepted && !d3.accepted && d3.reason === 'rate-limited', `d=[${d1.accepted},${d2.accepted},${d3.accepted}/${d3.reason}]`);
  // a DIFFERENT sender has its own budget; OWNER is exempt entirely
  const other = q.submit({ fromId: '6', owner: false, run: noop });
  const own = q.submit({ fromId: OWNER, owner: true, run: noop });
  rec('Q5. bucket is per-sender; owner is exempt', other.accepted && own.accepted, `other=${other.accepted} owner=${own.accepted}`);
  await q.idle();
}

// Q6 (queue-full is checked BEFORE the bucket → a full-queue reject spends no token):
{
  const gate = deferred();
  const q = createMediaQueue({ maxPending: 1, senderMax: 1, senderWindowMs: 60_000 });
  // hold the only slot with an owner-exempt slow job
  q.submit({ fromId: OWNER, owner: true, run: () => gate.promise });
  // non-owner '7' hits queue-full (slot taken) — must be reason 'queue-full', NOT 'rate-limited'
  const full = q.submit({ fromId: '7', owner: false, run: () => sleep(1) });
  gate.resolve();
  await q.idle();
  // '7' still has its single token (the queue-full reject didn't spend it): now admits
  const after = q.submit({ fromId: '7', owner: false, run: () => sleep(1) });
  rec('Q6. queue-full checked before bucket → rejected submit spends no sender token', full.reason === 'queue-full' && after.accepted, `full=${full.reason} after=${after.accepted}`);
  await q.idle();
}

// ── controllable-window refill (own queue with injected now) ──────────────────
{
  let t = 0; const now = () => t;
  const q = createMediaQueue({ maxPending: 99, senderMax: 1, senderWindowMs: 1000, now });
  const a = q.submit({ fromId: '8', owner: false, run: () => sleep(1) });
  const b = q.submit({ fromId: '8', owner: false, run: () => sleep(1) }); // throttled (same window)
  t += 1001;                                                              // roll the window
  const c = q.submit({ fromId: '8', owner: false, run: () => sleep(1) }); // refilled
  rec('Q7. sender bucket refills after the window rolls', a.accepted && !b.accepted && c.accepted, `a=${a.accepted} b=${b.accepted} c=${c.accepted}`);
  await q.idle();
}

// ── inbound integration: offload + degrade ────────────────────────────────────
// `groupOpen` wires the group-authorization deps so a NON-owner sender in an
// authorized-open group is accepted (the realistic flood source).
function mkHandler({ stage, queue, groupOpen = false } = {}) {
  const captures = [];
  const turns = [];
  const vault = { captureMessage: async (a) => { captures.push(a); return { id: a.id }; } };
  const handle = createInboundHandler({
    vault, ownerTelegramId: OWNER,
    runTurn: (ctx, m) => { turns.push({ chat: ctx.channelId, content: m.content }); },
    contextualizeMedia: stage,
    mediaQueue: queue,
    ...(groupOpen ? { isGroupAuthorized: async () => true, checkChannelAccess: async () => ({ respond: true }) } : {}),
  });
  return { handle, captures, turns };
}

// A normalized group photo from a non-owner member (the flood source).
const groupPhoto = (id, from = '222') => normalizeUpdate({
  update_id: id,
  message: { message_id: 600 + id, date: 1717600000, chat: { id: -100, type: 'supergroup', title: 'Grp' }, from: { id: Number(from), username: 'member' }, caption: 'pic', photo: [{ file_id: `gf${id}`, file_unique_id: `gu${id}`, file_size: 500 }] },
});

// I1–I3: a blocked media job must not stall a later owner DM.
{
  const gate = deferred();
  let stageCalls = 0;
  const stage = async (msg) => { stageCalls++; await gate.promise; return { attachmentId: `att-${msg.messageId}`, contextLine: '[Image attached — a tabby cat]' }; };
  const queue = createMediaQueue({ maxPending: 8, senderMax: 8, senderWindowMs: 60_000 });
  const { handle, captures, turns } = mkHandler({ stage, queue });

  await handle(photoMsg(1));               // owner media — should offload + return immediately
  // give the worker a tick to START the stage (it's now blocked on the gate)
  await sleep(5);
  rec('I1. media submit returns immediately (stage started, capture NOT yet done)',
    stageCalls === 1 && queue.pending() === 1 && captures.length === 0, `stageCalls=${stageCalls} pending=${queue.pending()} caps=${captures.length}`);

  await handle(textMsg(2));                // a LATER owner DM — must be handled inline NOW
  rec('I2. HEADLINE: a later owner DM is captured + turned while media is still pending',
    captures.length === 1 && captures[0].content === 'urgent owner note' && turns.length === 1 && turns[0].content === 'urgent owner note',
    `caps=${captures.length} turns=${turns.length} (gate still closed)`);

  gate.resolve();
  await queue.idle();
  const mediaCap = captures.find((c) => c.id === `tg-601-${OWNER}`);
  rec('I3. media completes after drain: captured with attachmentId + augmented content',
    !!mediaCap && mediaCap.attachmentId === 'att-601' && mediaCap.content === 'look\n[Image attached — a tabby cat]' && turns.length === 2,
    `mediaCap=${!!mediaCap} att=${mediaCap?.attachmentId}`);
}

// I4a: queue-full → DEGRADE inline (owner media, single slot held by a slow job).
{
  const blocker = deferred();
  let stageCalls = 0;
  const slowStage = async () => { stageCalls++; await blocker.promise; return { attachmentId: 'att-slow', contextLine: '[slow]' }; };
  const queue = createMediaQueue({ maxPending: 1, senderMax: 8, senderWindowMs: 60_000 });
  const { handle, captures, turns } = mkHandler({ stage: slowStage, queue });
  await handle(photoMsg(10));               // owner media → fills the single slot (accepted)
  await sleep(5);
  await handle(photoMsg(11));               // owner media → queue-full → DEGRADE inline
  const degraded = captures.find((c) => c.id === `tg-611-${OWNER}`);
  rec('I4a. queue-full → DEGRADED inline (placeholder captured, turn runs, extraction skipped)',
    !!degraded && /skipped under load/.test(degraded.content) && degraded.attachmentId === undefined
      && turns.some((t) => /skipped under load/.test(t.content)) && stageCalls === 1,
    `content="${degraded?.content}" stageCalls=${stageCalls}`);
  blocker.resolve();
  await queue.idle();
}

// I4b: non-owner group flood → per-sender throttle DEGRADES (never drops).
{
  let stageCalls = 0;
  const stage = async (msg) => { stageCalls++; return { attachmentId: `att-${msg.messageId}`, contextLine: '[Image attached — x]' }; };
  const queue = createMediaQueue({ maxPending: 16, senderMax: 1, senderWindowMs: 60_000 }); // 1 extraction/window per sender
  const { handle, captures, turns } = mkHandler({ stage, queue, groupOpen: true });
  await handle(groupPhoto(40));             // 1st non-owner media → admitted (extracted)
  await handle(groupPhoto(41));             // 2nd → throttled → DEGRADE inline
  await handle(groupPhoto(42));             // 3rd → throttled → DEGRADE inline
  await queue.idle();
  const degraded = captures.filter((c) => /skipped under load/.test(c.content));
  rec('I4b. non-owner flood throttled → degrade (3 captured, only 1 extracted, never dropped)',
    captures.length === 3 && stageCalls === 1 && degraded.length === 2 && turns.length === 3,
    `caps=${captures.length} extracted=${stageCalls} degraded=${degraded.length}`);
}

// I5: owner media is never throttled (all accepted + extracted, none degraded).
{
  const stage = async (msg) => ({ attachmentId: `att-${msg.messageId}`, contextLine: '[img]' });
  const queue = createMediaQueue({ maxPending: 16, senderMax: 1, senderWindowMs: 60_000 }); // tiny bucket
  const { handle, captures } = mkHandler({ stage, queue });
  for (let i = 20; i < 25; i++) await handle(photoMsg(i)); // 5 owner photos
  await queue.idle();
  const degradedCount = captures.filter((c) => /skipped under load/.test(c.content)).length;
  rec('I5. owner media never throttled (5 accepted + extracted, 0 degraded)',
    captures.length === 5 && degradedCount === 0 && captures.every((c) => c.content === 'look\n[img]'),
    `caps=${captures.length} degraded=${degradedCount}`);
}

// I6: authorization still precedes the offload — unauthorized media never submitted.
{
  let stageCalls = 0;
  const stage = async () => { stageCalls++; return { attachmentId: 'att', contextLine: 'x' }; };
  const queue = createMediaQueue({ maxPending: 8, senderMax: 8, senderWindowMs: 60_000 });
  const { handle, captures } = mkHandler({ stage, queue });
  await handle(photoMsg(30, { from: '999', chat: '999' })); // unauthorized DM
  await queue.idle();
  rec('I6. unauthorized media → never submitted, never captured (stage never runs)',
    stageCalls === 0 && captures.length === 0 && queue.pending() === 0, `stageCalls=${stageCalls} caps=${captures.length}`);
}

const passed = ledger.filter(Boolean).length;
console.log(`\n${passed}/${ledger.length} checks passed`);
if (passed !== ledger.length) { console.log('VERDICT: NO-GO'); process.exit(1); }
console.log('VERDICT: GO');
