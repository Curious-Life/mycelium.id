// verify:invite-data — the invite LEARNS ABOUT DATA FROM ANY PATH, and never claims an empty
// vault over a full one (WS-A item 1d; §3.2a; design PIVOT 2).
//
// It MOUNTS the real MindscapeInvite.svelte (real Svelte compiler → real jsdom → real events) via
// portal-app/test/mount-invite-data.mjs and asserts on what it ACTUALLY RENDERED after the server
// fact is flipped and the real cross-component signal / window focus fires. Nothing here reads the
// component source — a source regex passes with the wiring commented out, wrapped in `if (false)`,
// or with the import deleted (proven this session: mount-onboarding-flow / mount-intelligence-screen).
//
// The property is LIVENESS + HONESTY:
//   G1  a fresh vault shows the empty-state invitation, no evidence counts.
//   G2  flip the server fact + fire the import-completed SIGNAL ⇒ the step re-renders with the
//       evidence COUNTS and drops the empty-state copy.
//   G2b same, driven by a window FOCUS event.
//   G3a CONTROL — the harness can SEE ABSENCE (a string not in the component is absent), while the
//       real FULL render is present (so the absence check is not vacuous).
//   G3b CONTROL — THE WIRE, NOT A POLL: flip the fact but fire NEITHER signal NOR focus ⇒ the
//       display does NOT change AND no extra readiness read happens (an interval would betray both).
//   G4  §3.2a — after a nonzero render, a FAILED readiness read must HOLD the last answer; the
//       evidence must NOT regress to the empty state.
//   G4b §3.2a, THE FACT NOT THE TRANSPORT — when the backlog read throws (SQLITE_BUSY
//       mid-import) the 200's data is bare zeros with canGenerate.reason === 'unknown' (the
//       wire STRIPS data.unknown — readiness.js get()). That answer must not regress a nonzero
//       display either: unknown is "could not look", never "empty".
//   G5  MED-1 cost — 5 focus events in 200ms collapse into EXACTLY ONE readiness request, and it
//       is the CHEAP change-probe (slices=data), never the evidence aggregates.
//   G6-G8 (mount-import-emitters.mjs) — every OTHER import door actually EMITS the signal:
//       ScanForData's onImported wiring in ImportView (its default is a NO-OP), the connector
//       "Sync now" success path (created>0, with a created=0 CONTROL), and ChatFloat's upload
//       path. Keep-alive panes never remount, so a missed emission is permanent.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const ledger = [];
const rec = (n, p, d = '') => { ledger.push(p); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? ` — ${d}` : ''}`); };
const t = (n, fn) => { try { fn(); rec(n, true); } catch (e) { rec(n, false, e?.message || String(e)); } };

const EMPTY_COPY = 'Bring your world in';
const FULL_COPY = 'Your mycelium is growing';
const SENTINEL = 'ZZZ_STRING_THE_COMPONENT_NEVER_CONTAINS';

// The distinctive COUNTS the FULL fixture must render — assert the NUMBERS, not "any text", so a
// blank or generic render cannot pass. (fixture: 847 messages · 2019–2024 · 2 sources · 61 · 12)
const COUNTS = ['847 messages', '2019–2024', '2 sources', '61 conversations', '12 people'];
const hasCounts = (s) => COUNTS.every((c) => s.includes(c));

function run(probe, harness = 'test/mount-invite-data.mjs') {
  // `--conditions browser` is REQUIRED (svelte's server build throws lifecycle_function_unavailable).
  const line = execFileSync('node', ['--conditions', 'browser', harness],
    { cwd: 'portal-app', encoding: 'utf8', timeout: 120000, env: { ...process.env, PROBE: probe } })
    .trim().split('\n').pop();
  const o = JSON.parse(line);
  if (!o.ok) throw new Error(`probe ${probe} did not mount: ${String(o.error).slice(0, 300)}`);
  return o;
}

const EMITTERS = 'test/mount-import-emitters.mjs';
let empty, signal, focus, absence, silent, flurry, hold, unknown, focusunknown, scan, sync, chat;
try {
  empty = run('empty');
  signal = run('signal');
  focus = run('focus');
  absence = run('control-absence');
  silent = run('control-silent');
  flurry = run('flurry');
  hold = run('hold');
  unknown = run('unknown');
  focusunknown = run('focusunknown');
  scan = run('scan', EMITTERS);
  sync = run('sync', EMITTERS);
  chat = run('chat', EMITTERS);
} catch (e) {
  console.log(`FAIL  M0. the invite MOUNTS and every probe runs — ${String(e?.message || e).slice(0, 300)}`);
  console.log('\nVERDICT: NO-GO — a probe failed to run  EXIT=1');
  process.exit(1);
}
rec('M0. the invite + the emitter views mount and all twelve probes run', true);

t('G1. a fresh vault (total=0) shows the empty-state invitation, no evidence counts', () => {
  assert.ok(empty.text.includes(EMPTY_COPY), `expected the empty-state copy "${EMPTY_COPY}". Got: ${empty.text}`);
  assert.ok(!empty.text.includes(FULL_COPY), 'the "growing" copy must NOT show over an empty vault');
  assert.ok(!empty.text.includes('847'), 'no evidence count may render over an empty vault');
  // One read on mount, and only one — the Data step must not POLL (design PIVOT 2).
  assert.equal(empty.readsCount, 1, `the invite must read readiness ONCE on mount, not poll. Got ${empty.readsCount} reads`);
});

t('G2. ⭐ flip the fact + fire the import-completed SIGNAL ⇒ the evidence COUNTS render, empty copy drops', () => {
  assert.ok(signal.before.includes(EMPTY_COPY) && !hasCounts(signal.before),
    'before the signal the panel must show the empty state (it mounted over an empty vault)');
  assert.ok(hasCounts(signal.after),
    `after the signal the evidence COUNTS must render (${COUNTS.join(' · ')}). Got: ${signal.after}`);
  assert.ok(signal.after.includes(FULL_COPY), 'and the non-empty heading must show');
  assert.ok(!signal.after.includes(EMPTY_COPY),
    'and the empty-state "Bring your world in" copy must be GONE — it is a full vault now (§3.2a / operator ask)');
  // Exactly ONE extra read, provoked by the signal — event-driven, not a poll.
  assert.equal(signal.readsAfter, signal.readsBefore + 1,
    `the signal must provoke exactly one re-read. Got before=${signal.readsBefore} after=${signal.readsAfter}`);
});

t('G2b. ⭐ …and a window FOCUS event does the same (import finished while backgrounded)', () => {
  assert.ok(focus.before.includes(EMPTY_COPY) && !hasCounts(focus.before), 'before focus: empty state');
  assert.ok(hasCounts(focus.after), `after focus the evidence COUNTS must render. Got: ${focus.after}`);
  assert.ok(focus.after.includes(FULL_COPY) && !focus.after.includes(EMPTY_COPY), 'heading swapped, empty copy gone');
  // Focus is a TWO-STEP read: the cheap slices=data change-probe first, then — because the
  // total moved — the full evidence refresh. Exactly two, in that order (MED-1's cost shape).
  assert.equal(focus.readsAfter, focus.readsBefore + 2,
    `focus over a CHANGED vault = probe + full refresh = exactly 2 reads. Got before=${focus.readsBefore} after=${focus.readsAfter} paths=${JSON.stringify(focus.paths)}`);
  const newPaths = focus.paths.slice(focus.readsBefore);
  assert.match(newPaths[0], /slices=data(&|$)/, `the FIRST focus read must be the cheap change-probe. Got: ${newPaths[0]}`);
  assert.match(newPaths[1], /slices=data,evidence/, `the SECOND (total moved) must be the full refresh. Got: ${newPaths[1]}`);
});

t('G3a. CONTROL — the harness sees ABSENCE (a string not in the component is absent), and the real render is present', () => {
  // If this "absence" test could pass on a blank page, every "must NOT contain" assertion above
  // would be worthless. So: the sentinel is absent AND the genuine FULL render is present.
  assert.ok(!absence.text.includes(SENTINEL), 'a string the component never contains must be reported ABSENT');
  assert.ok(hasCounts(absence.text), 'and the genuine FULL evidence must be present — otherwise absence is vacuous');
});

t('G3b. ⭐ CONTROL — THE WIRE, NOT A POLL: flip the fact with NO signal and NO focus ⇒ no update, no extra read', () => {
  // This is the assertion that proves the re-read is SIGNAL-DRIVEN. If the invite polled readiness,
  // flipping the fact and waiting would update the display (and burn a read) with no event at all —
  // exactly the PIVOT 2 cost the design forbids. It must NOT.
  assert.equal(silent.after, silent.before,
    'with no signal and no focus, flipping the server fact must NOT change the display (a change would mean it polls)');
  assert.ok(silent.after.includes(EMPTY_COPY) && !silent.after.includes('847'),
    'the empty state must persist — nothing told the panel the vault changed');
  assert.equal(silent.readsAfter, silent.readsBefore,
    `and NO extra readiness read may happen without an event. Got before=${silent.readsBefore} after=${silent.readsAfter}`);
});

t('G4. ⭐ §3.2a — a FAILED readiness read HOLDS the last answer; a nonzero display never regresses to "no data"', () => {
  assert.ok(hasCounts(hold.beforeFail), `precondition: the evidence must be showing first. Got: ${hold.beforeFail}`);
  assert.ok(hasCounts(hold.afterFail),
    `after the readiness read FAILS, the evidence COUNTS must STILL show — a blip must not regress a full vault to empty. Got: ${hold.afterFail}`);
  assert.ok(hold.afterFail.includes(FULL_COPY) && !hold.afterFail.includes(EMPTY_COPY),
    'and it must NOT fall back to the empty-state "Bring your world in" copy on a failed read');
});

t('G4b. ⭐ §3.2a, THE FACT — a 200 whose data slice FAILED (canGenerate.reason=unknown, no data.unknown on the wire) must not regress the display either', () => {
  // readiness.js answers this shape from data()'s catch (SQLITE_BUSY mid-import is the common
  // case): the TRANSPORT succeeded, the SLICE failed. G4 alone would let this through — the
  // hold guarded !r.ok/throw, and a slice hiccup flipped dataDone false over a full vault.
  assert.ok(hasCounts(unknown.beforeUnknown), `precondition: the evidence must be showing first. Got: ${unknown.beforeUnknown}`);
  assert.equal(unknown.readsTotal, 3,
    `the unknown answer must actually have been FETCHED (mount + 2 signals = 3 reads) — otherwise this gate asserts nothing. Got ${unknown.readsTotal}`);
  assert.ok(hasCounts(unknown.afterUnknown),
    `after a 200-with-unknown the evidence COUNTS must STILL show — unknown is "could not look", never "empty". Got: ${unknown.afterUnknown}`);
  assert.ok(unknown.afterUnknown.includes(FULL_COPY) && !unknown.afterUnknown.includes(EMPTY_COPY),
    'and the empty-state copy must NOT come back over a slice hiccup');
});

t('G4c. §3.2a on the PROBE PATH — a focus during a wire-unknown costs ONE cheap probe, buys NO full refresh, and holds the display', () => {
  // The change-probe reads slices=data; on a failed slice the wire is bare zeros +
  // canGenerate.reason 'unknown'. 'unknown' claims nothing — so the probe must NOT treat
  // total:0 as a KNOWN change (0 !== 847) and buy the full evidence refresh. The dead-marker
  // keying (data.unknown, which the wire never carries) does exactly that: one full aggregate
  // read per focus for the whole outage. The latch still holds the DISPLAY either way — this
  // clause pins the read ECONOMY, which is where that regression actually costs.
  assert.ok(hasCounts(focusunknown.beforeUnknown), `precondition: the evidence must be showing first. Got: ${focusunknown.beforeUnknown}`);
  assert.equal(focusunknown.readsAfter - focusunknown.readsBefore, 1,
    `a focus during a wire-unknown must cost EXACTLY the cheap probe read — a second read means the probe bought a full refresh off zeros it should not trust. Got ${focusunknown.readsAfter - focusunknown.readsBefore} (paths: ${JSON.stringify(focusunknown.paths)})`);
  assert.match(focusunknown.paths[focusunknown.paths.length - 1], /slices=data(&|$)/,
    `the one read must be the cheap change-probe. Got: ${JSON.stringify(focusunknown.paths)}`);
  assert.ok(hasCounts(focusunknown.afterUnknown) && !focusunknown.afterUnknown.includes(EMPTY_COPY),
    `and the display must hold the counts. Got: ${focusunknown.afterUnknown}`);
});

t('G5. ⭐ MED-1 — a focus FLURRY (5 events / 200ms) collapses to EXACTLY ONE read, and it is the CHEAP probe', () => {
  assert.equal(flurry.readsAfter - flurry.readsBefore, 1,
    `5 rapid focus events must debounce into ONE readiness request. Got ${flurry.readsAfter - flurry.readsBefore} (paths: ${JSON.stringify(flurry.paths)})`);
  assert.equal(flurry.paths.length, 1, `exactly one post-mount request expected. Got: ${JSON.stringify(flurry.paths)}`);
  assert.match(flurry.paths[0], /slices=data(&|$)/,
    `an UNCHANGED vault must cost only the SWR-cached data COUNT — never the evidence aggregates. Got: ${flurry.paths[0]}`);
  assert.ok(flurry.after.includes(EMPTY_COPY), 'and the display stays in the (correct) empty state — nothing changed');
});

t('G6. ⭐ ImportView wires ScanForData.onImported to the signal (the default is a NO-OP)', () => {
  // ScanForData's own success path calls onImported — but its DEFAULT is a no-op, and ImportView
  // mounted it BARE, so a one-click Obsidian import told nobody. The probe's ScanForData stand-in
  // invokes its onImported prop; the REAL store's counter must move.
  assert.equal(scan.bumpAfterMount, 1,
    `ScanForData's onImported must reach signalImportCompleted — got bump=${scan.bumpAfterMount} (0 means the prop is not passed and the wire is dead)`);
});

t('G7. ⭐ connector "Sync now" emits when items were CREATED — and NOT on an idle sync', () => {
  assert.ok(sync.foundSyncButton, 'the connected-connector fixture must render its "Sync now" button');
  assert.equal(sync.bumpAfterSync - sync.bumpAfterMount, 1,
    `a sync with created=3 must emit exactly once. Got ${sync.bumpAfterSync - sync.bumpAfterMount}`);
  // CONTROL — created=0 must NOT emit: an idle re-sync is not an import, and emitting on it
  // would turn every routine sync into a readiness refresh (the cost MED-1 just removed).
  assert.equal(sync.bumpAfterIdleSync, sync.bumpAfterSync,
    `created=0 must not emit. Got ${sync.bumpAfterIdleSync - sync.bumpAfterSync} extra emission(s)`);
});

t('G8. ⭐ ChatFloat\'s upload path emits — a file dropped into chat is an import too', () => {
  assert.ok(chat.foundFileInput, 'ChatFloat must render its file input');
  assert.equal(chat.uploads, 1, `the change event must actually drive uploadFiles → chunkedUpload. Got ${chat.uploads} uploads`);
  assert.equal(chat.bumpAfterUpload - chat.bumpAfterMount, 1,
    `a successful upload (importResult present) must emit exactly once. Got ${chat.bumpAfterUpload - chat.bumpAfterMount}`);
});

const allPass = ledger.every(Boolean);
console.log('\n' + '='.repeat(64));
console.log(`VERDICT: ${allPass ? 'GO — the invite learns about data from the signal, focus, scan, sync and chat paths; renders the evidence counts; never polls (debounced, probe-first); and holds a nonzero display across a failed read AND a 200-with-unknown' : 'NO-GO — see FAIL rows'}  EXIT=${allPass ? 0 : 1}`);
console.log('='.repeat(64));
process.exit(allPass ? 0 : 1);
