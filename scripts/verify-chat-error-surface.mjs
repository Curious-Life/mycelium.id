// verify:chat-error-surface — D-020. A provider error must REACH THE USER on the transport the
// portal actually uses, instead of rendering as an empty bubble with a stuck spinner.
//
// Operator's report: "i am now getting empty ai responses via the portal, without any error
// message or anything like that, just empy message... when i close and reload the chat, it shows
// me the error messages, but it didnt send them through initially."
//
// The server was never at fault: src/portal-chat.js:596-606 classifies the upstream status and
// emits a specific message, then a `done`. ChatFloat's `case 'error'` rendered it ONLY when the
// turn had already produced text and THREW otherwise — i.e. in the one case the branch exists for
// (a 401 produces no text at all). On the secure-channel transport that throw ran inside the
// WebSocket frame handler, where secure-channel.ts:132-138 swallowed it: the pending request never
// settled, runSend's own catch never ran, and the bubble stayed empty and spinning forever.
//
// THIS GATE IS A MOUNT, NOT A REGEX. The defect is a render + control-flow bug; a source regex
// over ChatFloat.svelte passes with the render dead-coded, the component never mounted, or the
// error event never reaching the handler ([[render-must-be-mounted-not-grepped]], and the header of
// portal-app/test/mount-pipeline-status.mjs). portal-app/test/mount-chat-error.mjs mounts the REAL
// component, drives a REAL send over the REAL secure-channel dispatch, and reads the rendered
// bubble. portal-app/test/drive-channel-onchunk.mjs drives the transport's second defence layer
// directly, because with layer 1 fixed no mount can reach it.
//
//   E1  EMPTY TURN — an error with NO prior text renders VISIBLY in the assistant bubble, carrying
//       the server's own classified message. The operator's exact case.
//   E2  EMPTY TURN — the turn ENDS: no streaming indicator, no "thinking" row, and the transport
//       has no unsettled request left. The stuck spinner is gone.
//   E3  EMPTY TURN — the error is rendered by the IN-STREAM error handler (the `*Error: …*` form
//       ChatView also uses, which lands as an <em>), not by runSend's outer transport-failure
//       catch. This is the check that isolates LAYER 1 from layer 2's rescue.
//   E4  MIDSTREAM — text first, then an error: BOTH survive (the path that always worked).
//   E5  MIDSTREAM — that turn also ends cleanly (no spinner, nothing pending).
//   T1  TRANSPORT — an onChunk that throws SETTLES the pending request (rejects) instead of
//       hanging, so the caller's own error handling gets to run. Layer 2.
//   T2  TRANSPORT — settling it also releases the entry and its 5-minute timer (no leak), and the
//       throw does not escape into the frame handler.
//   E-CTRL  the harness can SEE ABSENCE — a sentinel never present, while the genuine render is,
//       so every "must NOT" above is non-vacuous.
//
// ── MUTATION RECORD (/gate-teeth: a gate is not evidence until you have watched it fail) ────────
// Snapshots taken with `cp` before each mutation and restored from them; the tree was re-run GREEN
// after every restore.
//
// MUTATION-TESTED: ChatFloat.svelte `case 'error'` reverted to the pre-fix `if (content) {…} else
//   { throw new Error(event.message) }` — layer 1 only, layer 2 left in place → E3 REDs
//   (assistantEmText empty: the message is painted by runSend's outer catch as a plain
//   `Error: …`, not by the in-stream handler). E1/E2 stay GREEN — and that is the honest,
//   verified result, not an oversight: layer 2 converts the escaping throw into a rejection, so
//   defence-in-depth still gets *an* error to the user. E3 is the check with teeth for layer 1.
// MUTATION-TESTED: BOTH layers reverted together (ChatFloat's `case 'error'` throw AND
//   secure-channel.ts's `req.onChunk(data)` try/catch) — the pre-fix product → E1, E2 and E-CTRL
//   RED. The operator's symptom reproduced verbatim: assistantText "" (an empty assistant bubble
//   with no error at all) and the swallowed throw recorded in escapedFrameErrors. Observed and
//   worth recording: streamingIndicators and pendingAfter stayed 0 in THIS sequence, because the
//   server's `done` + the stream-end frame still arrive after the error and settle the request —
//   so E2 reds on its escapedFrameErrors assertion, not on the spinner ones. The spinner
//   assertions are regression guards for the stuck-spinner half of the report (a turn where no
//   stream-end follows); they were NOT what red here.
// MUTATION-TESTED: secure-channel.ts:272-278 try/catch removed (bare `req.onChunk(data)`) — layer
//   2 only, ChatFloat left fixed → T1 and T2 both RED (settled null = the promise hung,
//   pendingAfter 1 = the entry and its 5-minute timer leaked, and the throw escaped into the frame
//   handler). E1-E5 stay GREEN, which is the point of the separate driver: with layer 1 fixed
//   ChatFloat's onChunk never throws, so no mount can reach layer 2.
//
// A green verdict claims EXACTLY this, and nothing more: with a provider error arriving over the
// secure-channel transport — with or without prior text — the mounted ChatFloat renders the
// server's classified message in a visible, non-spinning assistant bubble, and a throwing stream
// consumer settles its request instead of hanging. It does NOT claim the server classifies the
// status correctly (verify:chat / verify-portal-chat.mjs), that the Noise handshake or the
// encrypted socket work (verify:e2e-transport), that ChatView's duplicate copy of this handler is
// exercised, or anything about the plain-HTTPS transport, which never showed this symptom.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

// The message src/portal-chat.js:596-606 emits for an upstream 401/403, as the harness sends it.
const ERR_FRAGMENT = 'rejected the request';
const REMEDY_FRAGMENT = 'Settings';
const PARTIAL = 'Here is the first half of an answer';
const SENTINEL = 'ZZZ_STRING_CHATFLOAT_NEVER_CONTAINS';

function run(script, probe) {
  const env = { ...process.env, MYCELIUM_SKIP_WRITER_LOCK: '1' };
  if (probe) env.PROBE = probe;
  const line = execFileSync('node', ['--conditions', 'browser', `test/${script}`],
    { cwd: 'portal-app', encoding: 'utf8', timeout: 180000, env })
    .trim().split('\n').pop();
  const o = JSON.parse(line);
  if (!o.ok) throw new Error(`${script}${probe ? ` (${probe})` : ''} did not run: ${String(o.error).slice(0, 600)}`);
  return o;
}

let empty, mid, chan;
try {
  empty = run('mount-chat-error.mjs', 'emptyturn');
  mid = run('mount-chat-error.mjs', 'midstream');
  chan = run('drive-channel-onchunk.mjs');
} catch (e) {
  console.log(`FAIL  E0. the harnesses mount and every probe runs — ${String(e?.message || e).slice(0, 600)}`);
  console.log('\nVERDICT: NO-GO — a probe failed to run  EXIT=1');
  process.exit(1);
}
rec('E0. ChatFloat mounts, both probes drive a real send, and the transport driver runs', true);

t('E1. ⭐ EMPTY TURN — an error with NO prior text is VISIBLE in the assistant bubble', () => {
  assert.equal(empty.assistantCount, 1, 'the turn must produce exactly one assistant bubble');
  assert.ok(empty.assistantText.length > 0,
    'the assistant bubble is EMPTY — this is the operator\'s defect: a provider error rendered as an empty message');
  assert.ok(empty.assistantText.includes(ERR_FRAGMENT),
    `the bubble must carry the SERVER's classified message, not a generic one. Got: "${empty.assistantText}"`);
  assert.ok(empty.assistantText.includes(REMEDY_FRAGMENT),
    `and its remedy ("… in Settings → Intelligence"). Got: "${empty.assistantText}"`);
  assert.ok(empty.assistantVisible, 'rendered but HIDDEN is the same silence');
  assert.ok(empty.userText.includes('why is my key broken?'), 'the user bubble must still be there too');
});

t('E2. ⭐ EMPTY TURN — the turn ENDS: no spinner, no "thinking" row, nothing left pending', () => {
  assert.equal(empty.streamingIndicators, 0, 'the assistant bubble must stop showing the streaming indicator');
  assert.equal(empty.streamingIndicatorsAll, 0, 'and no streaming indicator anywhere');
  assert.equal(empty.thinkingRow, false, 'the whole-turn "thinking…" row must be gone (isLoading cleared)');
  assert.equal(empty.pendingAfter, 0,
    'the transport must have SETTLED the stream — a leftover pending request is the permanent spinner');
  assert.deepEqual(empty.escapedFrameErrors, [],
    'nothing may escape into the WebSocket frame handler (secure-channel.ts:132-138 swallows it and the request hangs)');
});

t('E3. ⭐ EMPTY TURN — the IN-STREAM error handler rendered it, not the transport-failure catch', () => {
  // The fix renders `*Error: …*` (matching ChatView's copy), which marked turns into an <em>.
  // runSend's outer catch renders a PLAIN `Error: …`. Distinguishing them is what isolates layer 1:
  // with layer 2 in place, a re-broken ChatFloat still shows *an* error via the outer catch, and a
  // text-only assertion would sit green over the reintroduced defect.
  assert.ok(empty.assistantEmText.length > 0,
    'the error must be rendered by ChatFloat\'s `case \'error\'` (the *Error: …* form). An empty <em> means the '
    + 'handler threw and runSend\'s outer catch painted it instead — layer 1 is broken, and only layer 2 is holding');
  assert.ok(empty.assistantEmText.includes(ERR_FRAGMENT),
    `and it must carry the server's message. Got: "${empty.assistantEmText}"`);
});

t('E4. MIDSTREAM — text first, then an error: BOTH survive (the path that always worked)', () => {
  assert.ok(mid.assistantText.includes(PARTIAL),
    `the partial answer must NOT be discarded by the error. Got: "${mid.assistantText}"`);
  assert.ok(mid.assistantText.includes(ERR_FRAGMENT),
    `and the error must be appended to it. Got: "${mid.assistantText}"`);
  assert.ok(mid.assistantText.indexOf(PARTIAL) < mid.assistantText.indexOf(ERR_FRAGMENT),
    'the error belongs AFTER the text it interrupted');
  assert.ok(mid.assistantEmText.includes(ERR_FRAGMENT), 'rendered by the same in-stream handler');
});

t('E5. MIDSTREAM — that turn ends cleanly too (no spinner, nothing pending)', () => {
  assert.equal(mid.streamingIndicatorsAll, 0, 'no streaming indicator may survive the error');
  assert.equal(mid.pendingAfter, 0, 'the stream must be settled');
  assert.deepEqual(mid.escapedFrameErrors, [], 'nothing may escape into the frame handler');
});

t('T1. ⭐ TRANSPORT — a throwing onChunk SETTLES its request (rejects) instead of hanging', () => {
  assert.equal(chan.chunksSeen, 1, 'the chunk must actually reach the consumer callback');
  assert.equal(chan.settled, 'rejected',
    `a throwing onChunk must REJECT the requestStream promise so the caller's own catch runs. `
    + `Got: ${chan.settled === null ? 'HUNG — the promise never settled (the D-020 silent hang)' : chan.settled}`);
  assert.ok(String(chan.rejectedWith).includes('consumer callback blew up'),
    `the rejection must carry the consumer's own error, not a substitute. Got: "${chan.rejectedWith}"`);
});

t('T2. TRANSPORT — settling releases the pending entry + its timer, and nothing escapes the handler', () => {
  assert.equal(chan.pendingAfter, 0,
    'the pending entry (and its 5-minute stream timeout) must be released — otherwise the request leaks');
  assert.deepEqual(chan.escapedFrameErrors, [],
    'the throw must NOT escape handlePayload — the real onmessage only console.errors it and the request hangs');
});

t('E-CTRL. the harness sees ABSENCE (a sentinel that is never present) AND the genuine render is', () => {
  // If "absence" could pass on a blank page, every "must NOT" above would be vacuous.
  assert.ok(!empty.bodyText.includes(SENTINEL), 'a string the component never contains must be reported ABSENT');
  assert.ok(empty.bodyText.includes(ERR_FRAGMENT) && empty.assistantCount === 1,
    'and the genuine render (the error, in a real assistant bubble) must be present');
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — a provider error reaches the user on the secure-channel transport: rendered visibly in the assistant bubble with or without prior text, the turn ends (no spinner, nothing pending), and a throwing stream consumer settles its request instead of hanging' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
