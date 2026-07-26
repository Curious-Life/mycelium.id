#!/usr/bin/env node
// verify-editor-autosave.mjs — the library document editor's save discipline (D-052).
//
// Drives portal-app/src/lib/editor/autosave.js — the REAL state machine
// LibraryView.svelte runs — against a scripted fake transport. Proves the four
// invariants that the intermittent save-error defect violated:
//
//   1. SINGLE-FLIGHT   never two writes in flight at once (the actual race:
//                      a debounce/⌘S/flush firing over an unfinished POST).
//   2. LAST-WRITE-WINS an edit made DURING a save is still persisted; the final
//                      write carries the newest text.
//   3. NEVER-THROWS    a failing/rejecting transport is absorbed and retried —
//                      it can never raise an error box at the writer.
//   4. NEVER-DISCARDS  a dirty buffer is never dropped: state stays 'unsaved'
//                      and a retry stays armed until it lands.
//   5. OWNERSHIP       when the buffer no longer belongs to the open document
//                      (getPersisted() === null) NO write is issued — this is
//                      what stops doc A's text being written over doc B.
//
// Also asserts the CSS fix for D-051 (styling bar flush with the text area) and
// that the transient-hiccup error box is gone from the autosave path.
//
// MUTATION-TESTED: 2026-07-26 — every mutation below was applied to the real
// source, the gate was run, and the named check was OBSERVED failing:
//   • removed `if (runner) return runner` (the single-flight join) in autosave.js
//       → REDs "single-flight: never two writes in flight" — observed 6 concurrent
//   • collapsed run()'s drain to a single `attempt()` (the maxPasses loop removed)
//       → REDs "last-write-wins: an edit made DURING a save is absorbed by the
//         SAME drain" — persisted stayed 'ab' while the buffer read 'abcd'
//       ⚠ NOTE: this mutation did NOT RED the first version of that check, which
//         called flush() twice — flush()'s own retry loop silently rescued the
//         edit, so the check was green for the wrong reason (M-001 pattern). The
//         check now drives the SCHEDULED path with the retry timer captured and
//         never fired, so run()'s drain is the only mechanism under test.
//   • deleted the try/catch in `attempt()` so a rejecting transport propagates
//       → REDs "never-throws: a rejecting transport does not escape"
//   • dropped the `armRetry()` call in the `finally` dirty branch
//       → REDs "never-discards: a failed save stays queued and lands on retry"
//   • removed the `if (persisted === null) return false` ownership check
//       → REDs "ownership: no write is issued for a foreign buffer" — observed
//         25 cross-document writes of doc A's text
//   • restored `padding-top` on `.editor-flush` in LibraryView.svelte
//       → REDs "D-051: .editor-flush zeroes padding-top"
//   • re-added a `toasts.error(...)` inside the autosaver `save:` transport
//       → REDs "D-052: no error box in the autosave transport"
//
// MUTATION-TESTED (WIRING checks): 2026-07-26 — added after an independent
// adversarial review got SIX component-side mutations past the first version of
// this gate. Each was re-applied to the real source and observed RED:
//   • deleted `editBufferPath = selectedDoc.path` from startEditing
//       → REDs "WIRING: startEditing pins the buffer to the open doc"
//   • deleted the `contentLoadedPath !== selectedDoc.path` early return from
//     startEditing (lets the '' list placeholder be edited → empty-doc overwrite)
//       → REDs "WIRING: startEditing refuses a doc whose content is not loaded"
//   • made startEditing always re-seed (`const resuming …; if (!resuming)` →
//     `if (true)`), clobbering an unsaved buffer with older persisted text
//       → REDs "WIRING: startEditing resumes a dirty buffer instead of re-seeding it"
//   • deleted `if (autosaver.isDirty()) return` from finishEditing
//       → REDs "WIRING: finishEditing does not leave edit mode while text is owed"
//   • deleted the rename re-pin `if (editBufferPath === oldPath) …`
//       → REDs "WIRING: the rename re-pins editBufferPath in lockstep"
//   • reverted the Back button to `closeOpenDoc()` with no guard
//       → REDs "WIRING: every leave path is guarded by canLeaveOpenDoc"
//   • changed the catch to `console.error(…, content, e)` (logs plaintext)
//       → REDs "WIRING: no user buffer text is ever logged"
//   • deleted `autosaver.dispose()` from onDestroy
//       → REDs "WIRING: onDestroy flushes AND disposes the autosaver"
//   • dropped `|| leaveRefused` from the saveStuck derivation
//       → REDs "WIRING: a stuck save offers an escape hatch (copy / discard)"
//   • deleted the `if (disposed) return` guard inside armRetry()
//       → REDs "WIRING: dispose() blocks a retry armed by a save still IN FLIGHT"
//       ⚠ NOTE: this mutation did NOT RED the first version of that check, which
//         called dispose() AFTER awaiting the flush — `cancelTimer()` alone killed
//         the already-armed timer, so the guard looked unnecessary. The check now
//         disposes while the save is still on the wire (the real onDestroy shape),
//         where only the `disposed` guard can stop the retry being re-armed.
//
// MUTATION-TESTED (round 3 — POLICY + STASH driven checks): 2026-07-26.
// A SECOND independent review got TEN component-side mutations past the WIRING
// checks above, because those checks pinned the SHAPE of each fix and not its
// BEHAVIOUR — worst of all, gutting `canLeaveOpenDoc` to `if (true) return true`
// restored the original fail-open blocker verbatim while the check that NAMES the
// guard stayed green, and the gate was green with a live blocker
// (`createNewDocument` could no longer be edited at all). The decisions therefore
// moved into edit-policy.js and are DRIVEN over truth tables.
// The mutations below were applied to the real source and the named check was
// OBSERVED failing (harness: scratchpad/mut-editor/*.py) — except n7, declared
// non-RED-by-design at the end of this block:
//   n1  bufferOwnsDoc stops enforcing contentLoadedPath  → POLICY bufferOwnsDoc
//   n2  canLeaveOpenDoc gutted to `if (true) return true` → WIRING canLeaveOpenDoc
//         derives its verdict from canLeaveDoc  ← the round-2 tautology, now caught
//   n3  closeOpenDoc stops clearing contentLoadedPath    → WIRING closeOpenDoc clears
//   n4  SAVE_STUCK_AFTER_FAILURES = 100000               → WIRING threshold reachable
//   n5  checkbox writer drops the load guard             → WIRING checkbox writer
//   n6  selectDoc drops autosaver.reset()                → WIRING selectDoc resets
//   n8  reset() reverted to the deduping setState()      → WIRING reset() notifies +
//         WIRING reset() actually re-notifies (driven)
//   n9  plaintext aliased via `const dbg = content`      → WIRING allowlisted log shape
//   n11 createNewDocument drops contentLoadedPath        → WIRING a created document is
//         marked loaded  ← the round-2 BLOCKER, now caught
//   n12 finishEditing keeps the buffer pinned when clean → WIRING finishEditing releases
//   n14 shouldResumeBuffer resumes a CLEAN buffer        → POLICY shouldResumeBuffer
//   n15 classifySaveResult calls 4xx transient           → POLICY classifySaveResult
//   (n13/n16/n17/n18 targeted the sessionStorage stash, which round 3 rejected and
//    removed — see the round-4 block above. Their checks went with it.)
//   n19 selectDoc writes the LIST-level loadError        → WIRING contentLoadedPath is
//         only set after a successful detail GET
//   n20 canEditDoc accepts an unloaded doc               → POLICY canEditDoc (+ n1's check)
//   n21 run() stops honouring `disposed`                 → WIRING a disposed autosaver
//         cannot be resurrected (driven)
//   n22 checkbox writer flushes instead of refusing      → WIRING checkbox writer
//
//   n7  dispose() drops cancelTimer()  → NO CHECK REDs, and that is CORRECT, not a
//         gap: run()'s `disposed` guard already blocks the write, so cancelTimer()
//         there is a second, redundant layer (CLAUDE.md §2) plus prompt timer
//         cleanup. Recorded rather than papered over — a mutation that cannot RED
//         must be declared, not quietly dropped from the list.

// MUTATION-TESTED (round 4 — after a THIRD adversarial review): 2026-07-26.
// Round 3 found that the round-2 redesign moved the *predicates* into driven truth
// tables but left the *call sites* asserted by regex — so the same class of defect
// simply moved one level out. It restored the round-2 empty-document-overwrite
// blocker verbatim by passing `contentLoadedPath: selectedDoc.path` (a correct
// predicate asked a self-satisfying question) with the gate at 59/59 GO. It also
// proved two claims in this codebase's own prose were FALSE: a "permanent"
// rejection did not stop the retry (armRetry was unconditional), and a disposed
// machine still issued new writes (run() checked `disposed` only at entry, while
// the real onDestroy always has a save in flight). Both are now fixed and DRIVEN.
// Round 3 also rejected the sessionStorage unmount rescue outright — it wrote
// unsaved vault plaintext to unencrypted storage (CLAUDE.md §1) with no sweep on
// logout, and auto-saved the stash over newer server content on recovery. It was
// REMOVED rather than patched; the residual unmount-loss case is documented in
// LibraryView's onDestroy comment as a known limitation, no worse than before.
// All mutations below were applied to the real source and the named check OBSERVED
// failing (harness: scratchpad/mut-editor/*.py):
//   r1  canEditDoc called with contentLoadedPath: selectedDoc.path
//         → REDs "WIRING: startEditing defers the edit gate to canEditDoc" AND
//           "WIRING: policy call sites pass the real state"  ← the round-3 blocker
//   r2  bufferOwnsDoc called with contentLoadedPath: selectedDoc.path
//         → REDs the call-site check + "the write gate defers ... in BOTH layers"
//   r3  discardStuckEdit() body emptied (a dead Discard button)
//         → REDs "WIRING: a stuck save offers an escape hatch"
//   r4  the whole {:else if docLoadError} render branch deleted
//         → REDs "WIRING: the doc-scoped error branch exists ..."
//   r5  copyEditBufferToClipboard copies '' instead of editContent
//         → REDs "WIRING: copy/discard act on the real buffer"
//   r6  the drain loop stops re-checking `disposed`
//         → REDs "DRIVEN: a disposed machine stops mid-drain, not just at entry"
//   r7  armRetry re-arms after a permanent rejection
//         → REDs "DRIVEN: a permanent rejection actually STOPS the retry loop"
//   r8  the transport returns false instead of 'permanent'
//         → REDs "WIRING: the save transport reports permanent rejections"
//   r9  releaseEditBuffer leaves savePermanentlyRejected latched
//         → REDs "WIRING: finishEditing releases the buffer on a clean exit"
//   r10 re-introduces sessionStorage.setItem of the buffer
//         → REDs "WIRING: no unsaved buffer is written to browser storage"
//
//   n21 run() drops its ENTRY `disposed` check → NO CHECK REDs, and that is correct:
//         with the per-pass check added for r6, plus the guards in schedule() and
//         flush(), the entry check is now a redundant fourth layer. Declared here
//         for the same reason as n7 — a mutation that cannot RED must be stated,
//         not quietly dropped from the count.
//
// HONESTY NOTE on the counts above: the round-3 record said "all 21 mutations
// observed RED"; that was off by one because n7 is in the list and deliberately does
// NOT RED. Corrected here — of the mutations listed across all rounds, exactly two
// (n7, n21) are declared non-RED-by-design and every other one was observed RED.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const AUTOSAVE_JS = join(repo, 'portal-app/src/lib/editor/autosave.js');
const EDIT_POLICY_JS = join(repo, 'portal-app/src/lib/editor/edit-policy.js');
const LIBRARY_VIEW = join(repo, 'portal-app/src/lib/views/LibraryView.svelte');

const { createAutosaver } = await import(AUTOSAVE_JS);
const {
	canEditDoc,
	bufferOwnsDoc,
	shouldResumeBuffer,
	canLeaveDoc,
	isSaveStuck,
	classifySaveResult,
} = await import(EDIT_POLICY_JS);
/**
 * Strip `//` and block comments so an ORDERING assertion can't be satisfied (or
 * broken) by prose. A comment mentioning `startEditing()` above the real call was
 * enough to invert an index comparison while building this gate.
 * @param {string} src
 */
function stripComments(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Extract a function body by BRACE MATCHING from a declaration.
 * A lazy `[\s\S]*?\n\t\}` regex silently stops at the first nested block close, so
 * it can return a truncated body — and a truncated body makes an assertion about
 * code that IS present fail (or, worse, one about code that is absent pass).
 * @param {string} src
 * @param {string} declaration  e.g. 'async function selectDoc('
 */
function fnBody(src, declaration) {
	const start = src.indexOf(declaration);
	if (start === -1) return null;
	const open = src.indexOf('{', start);
	if (open === -1) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(start, i + 1);
		}
	}
	return null;
}

let failures = 0;
let passes = 0;

/** @param {string} name @param {() => Promise<void> | void} fn */
async function t(name, fn) {
	try {
		await fn();
		passes++;
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failures++;
		console.log(`  ✗ ${name}\n      ${e && e.message ? e.message : e}`);
	}
}

function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

function eq(actual, expected, msg) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	if (a !== b) throw new Error(`${msg}\n      expected: ${b}\n      actual:   ${a}`);
}

const tick = () => new Promise((r) => setImmediate(r));

/**
 * Build a host with an in-memory document + a controllable transport.
 * `plan` is consulted per write: 'ok' | 'fail' | 'throw' | a delay-ms number.
 */
function makeHost({ initial = '', latencyMs = 0 } = {}) {
	const host = {
		buffer: initial,
		persisted: initial,
		owned: true,
		writes: [],
		inFlight: 0,
		maxConcurrent: 0,
		/** @type {Array<'ok'|'fail'|'throw'>} */
		plan: [],
		states: [],
		getBuffer: () => host.buffer,
		getPersisted: () => (host.owned ? host.persisted : null),
		save: async (content) => {
			host.inFlight++;
			host.maxConcurrent = Math.max(host.maxConcurrent, host.inFlight);
			host.writes.push(content);
			try {
				if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
				else await tick();
				const verdict = host.plan.length ? host.plan.shift() : 'ok';
				if (verdict === 'throw') throw new Error('transport exploded');
				if (verdict === 'fail') return false;
				host.persisted = content;
				return true;
			} finally {
				host.inFlight--;
			}
		},
		onState: (s) => { host.states.push(s); },
	};
	return host;
}

console.log('\neditor autosave — single-flight save discipline (D-052)');

await t('single-flight: never two writes in flight, even under a burst of flushes', async () => {
	const host = makeHost({ initial: 'a', latencyMs: 5 });
	const saver = createAutosaver(host, { debounceMs: 1 });
	host.buffer = 'ab';
	// Six overlapping demands to save — exactly the shape of the real race
	// (debounce elapsing + ⌘S + Done + unmount all landing on one another).
	const all = [saver.flush(), saver.flush(), saver.flush(), saver.flush(), saver.flush(), saver.flush()];
	await Promise.all(all);
	eq(host.maxConcurrent, 1, 'two or more writes were in flight simultaneously');
	assert(host.writes.length >= 1, 'no write was issued at all');
});

await t('last-write-wins: an edit made DURING a save is absorbed by the SAME drain', async () => {
	// Isolates run()'s drain loop. The retry timer is captured but never fired,
	// and flush() is not used — so the drain loop is the ONLY mechanism that can
	// persist text typed while the first POST was on the wire. Without this
	// isolation flush()'s own retry loop masks the drain and the check passes for
	// the wrong reason (observed while building this gate).
	const host = makeHost({ initial: 'a', latencyMs: 5 });
	/** @type {null | (() => void)} */ let armed = null;
	const saver = createAutosaver(host, {
		debounceMs: 1,
		setTimer: (fn) => { armed = fn; return 1; },
		clearTimer: () => { armed = null; },
	});
	host.buffer = 'ab';
	saver.schedule();
	assert(armed, 'schedule() did not arm the debounce timer');
	armed(); // debounce elapses → the drain starts
	await tick();
	host.buffer = 'abcd'; // typed while the POST is in flight
	await new Promise((r) => setTimeout(r, 60));
	eq(host.persisted, 'abcd', 'the mid-save edit was not absorbed by the drain — it would need a retry to survive');
});

await t('last-write-wins: the buffer eventually converges with no external prompting', async () => {
	const host = makeHost({ initial: 'a', latencyMs: 5 });
	const saver = createAutosaver(host, { debounceMs: 2 });
	host.buffer = 'ab';
	const p = saver.flush();
	await tick();
	host.buffer = 'abcd';
	await p;
	// No further flush(): the machine must land the tail edit on its own.
	await new Promise((r) => setTimeout(r, 80));
	eq(host.persisted, 'abcd', 'the newest text was not persisted — an edit was dropped');
	eq(host.buffer, host.persisted, 'buffer and persisted diverged');
	assert(!saver.isDirty(), 'still dirty after convergence');
});

await t('last-write-wins: rapid successive edits all converge (no lost keystroke)', async () => {
	const host = makeHost({ initial: '', latencyMs: 2 });
	const saver = createAutosaver(host, { debounceMs: 1 });
	let text = '';
	for (let i = 0; i < 12; i++) {
		text += String.fromCharCode(97 + i);
		host.buffer = text;
		void saver.flush(); // hammer, as continuous typing does
		await tick();
	}
	// Settle.
	for (let i = 0; i < 8; i++) { await saver.flush(); await tick(); }
	eq(host.persisted, text, 'final text not persisted after a rapid-edit burst');
	assert(host.maxConcurrent === 1, `overlapping writes during burst: ${host.maxConcurrent}`);
});

await t('never-throws: a rejecting transport does not escape to the caller', async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 1 });
	host.buffer = 'ab';
	host.plan = ['throw'];
	let threw = null;
	try { await saver.flush(); } catch (e) { threw = e; }
	assert(threw === null, `flush() threw — this is what raised the error box: ${threw && threw.message}`);
});

await t('never-throws: a failing transport does not escape to the caller', async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 1 });
	host.buffer = 'ab';
	host.plan = ['fail'];
	let threw = null;
	try { await saver.flush(); } catch (e) { threw = e; }
	assert(threw === null, 'flush() threw on a non-ok response');
});

await t('never-discards: a failed save stays queued and lands on the retry', async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 2 });
	host.buffer = 'ab';
	host.plan = ['fail', 'fail']; // two hiccups, then the transport recovers
	await saver.flush();
	assert(saver.isDirty(), 'buffer reported clean after a failed save — the edit was dropped');
	eq(saver.state, 'unsaved', `state after a failed save should be 'unsaved', got '${saver.state}'`);
	// Let the armed retry (with backoff) run to completion.
	await new Promise((r) => setTimeout(r, 120));
	eq(host.persisted, 'ab', 'the retry never persisted the buffer');
	assert(!saver.isDirty(), 'still dirty after a successful retry');
});

await t("never-discards: state reads 'unsaved' the whole time text is owed", async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 2 });
	host.buffer = 'ab';
	host.plan = ['fail'];
	await saver.flush();
	// While dirty, the user-visible state must never claim 'saved'.
	assert(saver.isDirty(), 'precondition: expected a dirty buffer');
	assert(saver.state !== 'saved', "state claimed 'saved' while the buffer was still dirty");
	assert(saver.state !== 'idle', "state fell back to 'idle' — the whisper would hide the risk");
});

await t('ownership: no write is issued for a buffer that left its document', async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 1 });
	host.buffer = 'doc-A text';
	host.owned = false; // the user switched documents — buffer is foreign now
	await saver.flush();
	eq(host.writes, [], 'a write was issued for a buffer that no longer owns the open doc');
	assert(!saver.isDirty(), 'a foreign buffer must not report dirty');
});

await t('ownership: a switch mid-save cannot redirect the in-flight write', async () => {
	const host = makeHost({ initial: 'a', latencyMs: 5 });
	const saver = createAutosaver(host, { debounceMs: 1 });
	host.buffer = 'doc-A text';
	const p = saver.flush();
	await tick();
	host.owned = false; // switch lands while the POST is on the wire
	await p;
	eq(host.writes, ['doc-A text'], 'the in-flight write was redirected or duplicated after a doc switch');
});

await t('clean buffer: no redundant write, and a prior saved state is preserved', async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 1 });
	host.buffer = 'ab';
	await saver.flush();
	eq(saver.state, 'saved', 'precondition: expected saved after a successful flush');
	const before = host.writes.length;
	// A second flush with nothing new (Done pressed right after autosave landed)
	// must be a no-op — no redundant POST, and the whisper must not regress.
	await saver.flush();
	eq(host.writes.length, before, 'issued a write for a buffer identical to what is persisted');
	eq(saver.state, 'saved', `a no-op flush regressed the state to '${saver.state}'`);
});

await t('schedule() debounces, then persists', async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 5 });
	host.buffer = 'ab';
	saver.schedule();
	eq(saver.state, 'unsaved', 'a keystroke should immediately read as unsaved');
	eq(host.writes, [], 'schedule() wrote before the debounce elapsed');
	await new Promise((r) => setTimeout(r, 40));
	eq(host.persisted, 'ab', 'the debounced save never landed');
	eq(saver.state, 'saved', `expected 'saved' after the debounce, got '${saver.state}'`);
});

await t('cancel() is the only discard, and only after an explicit user discard', async () => {
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 5 });
	host.buffer = 'ab';
	saver.schedule();
	saver.cancel();
	host.owned = false; // discard unpins the buffer, as discardEditAndReload does
	await new Promise((r) => setTimeout(r, 30));
	eq(host.writes, [], 'a cancelled + unpinned buffer was still written');
	eq(saver.state, 'idle', `expected 'idle' after cancel, got '${saver.state}'`);
});

console.log('\nlibrary editor UI — styling bar + error box');

const view = readFileSync(LIBRARY_VIEW, 'utf8');

await t('D-051: .editor-flush zeroes padding-top so the styling bar sits flush', async () => {
	const m = view.match(/\.editor-flush\s*\{([^}]*)\}/);
	assert(m, '.editor-flush rule not found in LibraryView.svelte');
	const body = m[1];
	assert(
		/padding-top:\s*0\s*;/.test(body),
		'.editor-flush must set `padding-top: 0` — without it the sticky formatting ' +
		'toolbar is clamped below the scrollport top and text shows through the gap',
	);
});

await t('D-051: the formatting toolbar is still sticky to the top of the text area', async () => {
	assert(
		/sticky top-0[^>]*>\s*\{#if !isHtmlDoc/.test(view) || /class="sticky top-0[^"]*"/.test(view),
		'the formatting toolbar lost its `sticky top-0` — the fix depends on it',
	);
});

await t('D-052: no error box in the autosave transport', async () => {
	// Isolate the autosaver host literal and assert it raises no toast.
	const start = view.indexOf('const autosaver = createAutosaver(');
	assert(start !== -1, 'createAutosaver(...) host not found in LibraryView.svelte');
	const end = view.indexOf('const scheduleAutosave', start);
	assert(end > start, 'could not delimit the autosaver host block');
	const block = view.slice(start, end);
	assert(
		!/toasts\.(error|warn)/.test(block),
		'the autosave transport raises a toast — a transient save hiccup must never ' +
		'throw an error box at the writer (D-052)',
	);
});

await t("D-052: the header whisper surfaces 'Unsaved' as well as saving/saved", async () => {
	assert(/saveState === 'unsaved' \? 'Unsaved'/.test(view), "the header does not render an 'Unsaved' state");
	assert(/'idle' \| 'unsaved' \| 'saving' \| 'saved'/.test(view), 'saveState is missing the unsaved member');
});

// ── Edit-session POLICY, driven ───────────────────────────────────────
// Round-2 review got TEN component-side mutations past the shape-only checks
// below — most damningly, gutting `canLeaveOpenDoc` to `if (true) return true`
// restored the original fail-open blocker verbatim while the check that NAMES the
// guard stayed green, because it only counted textual references. The decisions
// therefore live in edit-policy.js now and are EXECUTED here over full truth
// tables. The shape checks that follow only assert the component defers to them.

console.log('\nedit-session policy — driven decision tables');

await t('POLICY canEditDoc: refuses until the open doc\'s content is actually loaded', async () => {
	// The empty-document-overwrite blocker: a list row carries no content, so the
	// buffer would seed from '' and the first save would wipe the real text.
	eq(canEditDoc({ contentLoadedPath: 'a', openPath: 'a' }), true, 'loaded doc must be editable');
	eq(canEditDoc({ contentLoadedPath: null, openPath: 'a' }), false, 'placeholder (never loaded) must NOT be editable');
	eq(canEditDoc({ contentLoadedPath: 'b', openPath: 'a' }), false, 'content loaded for ANOTHER doc must NOT be editable');
	eq(canEditDoc({ contentLoadedPath: 'a', openPath: null }), false, 'no open doc → not editable');
	eq(canEditDoc({ contentLoadedPath: 'a', openPath: undefined }), false, 'undefined open path → not editable');
});

await t('POLICY bufferOwnsDoc: the write gate refuses foreign and unloaded buffers', async () => {
	eq(bufferOwnsDoc({ editBufferPath: 'a', openPath: 'a', contentLoadedPath: 'a' }), true, 'own doc, loaded → may write');
	eq(bufferOwnsDoc({ editBufferPath: 'a', openPath: 'b', contentLoadedPath: 'b' }), false, 'buffer for doc A must never write to doc B');
	eq(bufferOwnsDoc({ editBufferPath: 'a', openPath: 'a', contentLoadedPath: null }), false, 'unloaded content → must not write (placeholder overwrite)');
	eq(bufferOwnsDoc({ editBufferPath: null, openPath: 'a', contentLoadedPath: 'a' }), false, 'no pinned buffer → nothing to write');
});

await t('POLICY shouldResumeBuffer: resumes only a buffer still OWED for this doc', async () => {
	eq(shouldResumeBuffer({ editBufferPath: 'a', openPath: 'a', dirty: true }), true,
		're-entering with unsaved text must RESUME, not re-seed (re-seeding loses the edit)');
	// The round-2 clobber: a CLEAN/released buffer must never be resumed, or text
	// predating an agent rewrite gets written back over the agent's work.
	eq(shouldResumeBuffer({ editBufferPath: 'a', openPath: 'a', dirty: false }), false,
		'a clean buffer must NOT be resumed — it can predate an agent rewrite');
	eq(shouldResumeBuffer({ editBufferPath: 'b', openPath: 'a', dirty: true }), false, "another doc's buffer must never be resumed");
	eq(shouldResumeBuffer({ editBufferPath: null, openPath: 'a', dirty: true }), false, 'no buffer → nothing to resume');
});

await t('POLICY canLeaveDoc: fails CLOSED while text is still owed', async () => {
	eq(canLeaveDoc({ editing: false, dirtyAfterFlush: false }), true, 'not editing → free to leave');
	eq(canLeaveDoc({ editing: false, dirtyAfterFlush: true }), true, 'not editing → the buffer is not ours to guard');
	eq(canLeaveDoc({ editing: true, dirtyAfterFlush: false }), true, 'flush landed → free to leave');
	// THE blocker this whole guard exists for. `if (true) return true` must fail here.
	eq(canLeaveDoc({ editing: true, dirtyAfterFlush: true }), false,
		'editing with unpersisted text MUST refuse the close — leaving unpins the buffer ' +
		'and turns the armed retry into a no-op, which is a silent loss');
});

await t('POLICY isSaveStuck: latched, and not starvable by typing', async () => {
	eq(isSaveStuck({ failures: 0, threshold: 3, leaveRefused: false }), false, 'healthy → no hatch');
	eq(isSaveStuck({ failures: 3, threshold: 3, leaveRefused: false }), true, 'threshold reached → hatch');
	eq(isSaveStuck({ failures: 9, threshold: 3, leaveRefused: false }), true, 'past threshold → hatch');
	// Typing zeroes `failures` on every keystroke, so the count alone is starvable:
	// a refused exit must latch the hatch on regardless of the count.
	eq(isSaveStuck({ failures: 0, threshold: 3, leaveRefused: true }), true,
		'a refused leave must show the hatch even at zero failures — otherwise typing ' +
		'starves it and the refusal becomes a door with no handle');
	eq(isSaveStuck({ failures: 2, threshold: 3, leaveRefused: true }), true, 'latched trumps a sub-threshold count');
});

await t('POLICY classifySaveResult: a permanent 4xx is not retried forever', async () => {
	eq(classifySaveResult({ ok: true, status: 200 }), 'ok', '2xx → ok');
	eq(classifySaveResult({ ok: false, status: 0 }), 'transient', 'no response (network) → transient');
	eq(classifySaveResult({ ok: false, status: undefined }), 'transient', 'missing status → transient');
	eq(classifySaveResult({ ok: false, status: 500 }), 'transient', '5xx → transient, keep retrying');
	eq(classifySaveResult({ ok: false, status: 503 }), 'transient', '503 → transient');
	eq(classifySaveResult({ ok: false, status: 408 }), 'transient', '408 explicitly invites a retry');
	eq(classifySaveResult({ ok: false, status: 429 }), 'transient', '429 explicitly invites a retry');
	eq(classifySaveResult({ ok: false, status: 400 }), 'permanent', '400 will be refused forever — stop resending plaintext');
	eq(classifySaveResult({ ok: false, status: 413 }), 'permanent', '413 payload-too-large is permanent');
	eq(classifySaveResult({ ok: false, status: 403 }), 'permanent', '403 is permanent');
});

// ── Component WIRING ──────────────────────────────────────────────────
// With the decisions driven above, these checks assert the component DEFERS to
// them rather than re-deriving the logic inline (where it could be mutated back
// to fail-open without any driven test noticing).

await t('WIRING: startEditing pins the buffer to the open doc', async () => {
	const m = view.match(/function startEditing\(\)\s*\{[\s\S]*?\n\t\}/);
	assert(m, 'startEditing() not found');
	assert(
		/editBufferPath = selectedDoc\.path/.test(m[0]),
		'startEditing() must pin `editBufferPath` — without the pin getPersisted() ' +
		'returns null forever and NOTHING is ever saved again',
	);
});

await t('WIRING: startEditing defers the edit gate to canEditDoc', async () => {
	const m = view.match(/function startEditing\(\)\s*\{[\s\S]*?\n\t\}/);
	assert(m, 'startEditing() not found');
	assert(
		/if \(!canEditDoc\(\{ contentLoadedPath, openPath: selectedDoc\.path \}\)\) return/.test(m[0]),
		'startEditing() must gate on EXACTLY canEditDoc({ contentLoadedPath, openPath: ' +
		'selectedDoc.path }). Round-3 review restored the empty-document-overwrite ' +
		'blocker by passing `contentLoadedPath: selectedDoc.path` — a correct predicate ' +
		'asked the wrong question — while a looser regex stayed green.',
	);
});

await t('WIRING: policy call sites pass the real state, not self-satisfying arguments', async () => {
	// The predicates are driven over truth tables; this pins the ARGUMENTS so a
	// tautological call (comparing a value with itself) cannot slip through.
	const src = stripComments(view);
	const calls = src.match(/(canEditDoc|bufferOwnsDoc|shouldResumeBuffer|canLeaveDoc|isSaveStuck)\(\{[^}]*\}\)/g) || [];
	assert(calls.length >= 5, `expected the policy predicates to be used, found ${calls.length} call(s)`);
	const offenders = [];
	for (const call of calls) {
		// contentLoadedPath must be the real state variable, never re-derived from the
		// open doc (which would make canEditDoc/bufferOwnsDoc always true).
		if (/contentLoadedPath:\s*(?!contentLoadedPath\b)/.test(call)) offenders.push(call);
		// editBufferPath likewise.
		if (/editBufferPath:\s*(?!editBufferPath\b)/.test(call)) offenders.push(call);
		// dirty/dirtyAfterFlush must come from the machine, not a literal.
		if (/(dirty|dirtyAfterFlush):\s*(true|false)\b/.test(call)) offenders.push(call);
		if (/editing:\s*(true|false)\b/.test(call)) offenders.push(call);
	}
	eq(offenders, [], 'a policy predicate is called with a self-satisfying or hard-coded argument — the predicate is correct but is being asked the wrong question');
});

await t('WIRING: startEditing defers the resume decision to shouldResumeBuffer', async () => {
	const m = view.match(/function startEditing\(\)\s*\{[\s\S]*?\n\t\}/);
	assert(m, 'startEditing() not found');
	assert(
		/const resuming = shouldResumeBuffer\(\{/.test(m[0]) && /if \(!resuming\)/.test(m[0]),
		'the resume/re-seed choice must come from shouldResumeBuffer(...): re-seeding a ' +
		'DIRTY buffer loses the user\'s edit, and resuming a CLEAN one can write text ' +
		'predating an agent rewrite back over the agent\'s work',
	);
});

await t('WIRING: the write gate defers to bufferOwnsDoc in BOTH layers', async () => {
	// getPersisted() is the primary gate; the `save:` transport re-checks as the
	// defence-in-depth second layer (CLAUDE.md §2). Round-2 review deleted the
	// contentLoadedPath check from getPersisted() and the gate stayed green.
	const host = view.match(/const autosaver = createAutosaver\(\{[\s\S]*?\n\t\}\);/);
	assert(host, 'createAutosaver(...) host not found');
	const calls = host[0].match(/bufferOwnsDoc\(\{/g) || [];
	assert(
		calls.length >= 2,
		`both getPersisted() and save() must gate on bufferOwnsDoc(...) — found ${calls.length}. ` +
		'One layer only means a single mutation removes the ownership + load enforcement.',
	);
	assert(/getPersisted: \(\) => \{[\s\S]*?bufferOwnsDoc\(\{/.test(host[0]), 'getPersisted() must gate on bufferOwnsDoc');
	const args = host[0].match(/bufferOwnsDoc\(\{[^}]*\}\)/g) || [];
	for (const a of args) {
		assert(/contentLoadedPath\b/.test(a) && !/contentLoadedPath:\s*(?!contentLoadedPath\b)/.test(a),
			`bufferOwnsDoc is called with a substituted contentLoadedPath — ${a}`);
		assert(/editBufferPath\b/.test(a) && !/editBufferPath:\s*(?!editBufferPath\b)/.test(a),
			`bufferOwnsDoc is called with a substituted editBufferPath — ${a}`);
	}
});

await t('WIRING: a created document is marked loaded so it can be edited', async () => {
	// Round-2 BLOCKER: createNewDocument set selectedDoc + called startEditing() but
	// never set contentLoadedPath, so the new load gate refused and the user landed
	// on a read-only empty doc with a disabled Edit button.
	// Comment-stripped: a comment mentioning startEditing() would otherwise satisfy
	// (or invert) the ordering comparison below.
	const body = fnBody(stripComments(view), 'async function createNewDocument(');
	assert(body, 'createNewDocument() not found');
	const setIdx = body.indexOf('contentLoadedPath = created.path');
	const editIdx = body.indexOf('startEditing()');
	assert(setIdx !== -1, 'createNewDocument() must set contentLoadedPath — the create response IS authoritative content, and without it startEditing() refuses and the new doc cannot be edited at all');
	assert(editIdx !== -1 && setIdx < editIdx, 'contentLoadedPath must be set BEFORE startEditing()');
});

await t('WIRING: every authoritative content load sets contentLoadedPath', async () => {
	// Keeps the invariant true by construction rather than by reachability argument.
	const reload = view.match(/async function reloadCurrentDoc\(\)[\s\S]*?\n\t\}/);
	assert(reload, 'reloadCurrentDoc() not found');
	assert(
		/contentLoadedPath = selectedDoc\.path/.test(reload[0]),
		'reloadCurrentDoc() fetches authoritative content and must set contentLoadedPath',
	);
});

await t('WIRING: contentLoadedPath is only set after a successful detail GET', async () => {
	const body = fnBody(view, 'async function selectDoc(');
	assert(body, 'selectDoc() not found');
	assert(/contentLoadedPath = null/.test(body), 'selectDoc must clear contentLoadedPath up front');
	const okIdx = body.indexOf('if (res.ok)');
	const setIdx = body.indexOf('contentLoadedPath = doc.path');
	assert(okIdx !== -1 && setIdx > okIdx, 'contentLoadedPath must be set INSIDE the res.ok branch only');
	assert(
		/\}\s*else\s*\{[\s\S]*?docLoadError =/.test(body),
		'a failed detail GET must be surfaced via the DOC-SCOPED docLoadError — silently ' +
		'keeping the empty placeholder is what allows an empty-document overwrite, and the ' +
		'list-level loadError would wrongly replace the whole library',
	);
	assert(
		!/\bloadError = /.test(body),
		'selectDoc must not write the LIST-level loadError for a single document failure — ' +
		'that banner replaces the entire library and its retry reloads the wrong thing',
	);
});

await t('WIRING: finishEditing does not leave edit mode while text is owed', async () => {
	const body = fnBody(view, 'async function finishEditing(');
	assert(body, 'finishEditing() not found');
	const dirtyIdx = body.indexOf('if (autosaver.isDirty())');
	const exitIdx = body.indexOf('editing = false');
	assert(dirtyIdx !== -1, 'finishEditing() must check dirtiness after the flush');
	assert(exitIdx > dirtyIdx, 'the dirtiness check must GUARD the exit, not follow it');
	assert(
		/if \(autosaver\.isDirty\(\)\) \{[\s\S]*?return;/.test(body),
		'finishEditing() must RETURN while text is owed. Leaving hides the "Unsaved" ' +
		'whisper (it lives inside {#if editing}) and the next close unpins ' +
		'editBufferPath, turning the armed retry into a permanent no-op',
	);
});

await t('WIRING: the rename re-pins editBufferPath in lockstep with the new path', async () => {
	assert(
		/if \(editBufferPath === oldPath\) editBufferPath = newPath/.test(view),
		'commitChangeLink must re-pin editBufferPath to the new path — otherwise ' +
		'isDirty() sees buffer(old) != open(new) and silently refuses every later save',
	);
});

await t('WIRING: onDestroy flushes AND disposes the autosaver', async () => {
	const m = view.match(/onDestroy\(\(\) => \{[\s\S]*?\n\t\}\);/);
	assert(m, 'onDestroy() not found');
	assert(/flushSave\(\)/.test(m[0]), 'onDestroy must flush — otherwise unmount loses the buffer');
	assert(
		/autosaver\.dispose\(\)/.test(m[0]),
		'onDestroy must dispose the autosaver — an orphaned retry timer keeps firing ' +
		'from a destroyed component and can overwrite newer text saved by a remount',
	);
});

await t('WIRING: dispose() blocks a retry armed by a save still IN FLIGHT', async () => {
	// This is the real onDestroy shape: `void flushSave(); autosaver.dispose();`.
	// The flush is still on the wire when dispose() runs, so its `finally` arms the
	// retry AFTER the timer was cancelled — cancelTimer() alone cannot stop it, only
	// the `disposed` guard inside armRetry() can. (An earlier version of this check
	// disposed AFTER awaiting the flush, so cancelTimer() covered it and removing the
	// guard left the check green — green for the wrong reason.)
	const host = makeHost({ initial: 'a', latencyMs: 10 });
	const saver = createAutosaver(host, { debounceMs: 2 });
	host.buffer = 'ab';
	host.plan = ['fail', 'fail', 'fail', 'fail'];
	const inFlight = saver.flush(); // do NOT await — mirrors onDestroy
	saver.dispose();
	await inFlight;
	assert(saver.isDirty(), 'precondition: expected a dirty buffer after a failed save');
	const before = host.writes.length;
	await new Promise((r) => setTimeout(r, 150));
	eq(host.writes.length, before, 'a retry fired after dispose() — that is the orphaned-timer write that can overwrite newer text');
});

await t('WIRING: a disposed autosaver cannot be resurrected by a late schedule()', async () => {
	// Svelte runs a parent's onDestroy BEFORE its children are destroyed, so a child
	// editor can emit a final onChange after dispose(). Without `disposed` guarding
	// schedule()/run(), that write goes out from a dead component — the exact orphan
	// write dispose() exists to prevent.
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 2 });
	saver.dispose();
	host.buffer = 'text from a destroyed component';
	saver.schedule();
	await new Promise((r) => setTimeout(r, 60));
	eq(host.writes, [], 'a disposed autosaver still wrote — schedule()/run() must honour `disposed`');
	await saver.flush();
	eq(host.writes, [], 'flush() on a disposed autosaver still wrote');
});

await t('WIRING: an ALREADY-armed retry produces no write after dispose()', async () => {
	// A timer armed by schedule() before teardown must not produce a write. TWO
	// independent layers stop it (CLAUDE.md §2): dispose()'s cancelTimer(), and the
	// `disposed` guard inside run(). HONESTY NOTE: because either layer suffices,
	// deleting cancelTimer() from dispose() alone does NOT RED this check — that
	// mutation was applied and observed still GREEN. cancelTimer() there is
	// defence-in-depth (and prompt timer cleanup), not independently provable. The
	// load-bearing layer is run()'s guard, covered by the check above.
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 5 });
	host.buffer = 'ab';
	saver.schedule(); // arms a timer
	saver.dispose();
	await new Promise((r) => setTimeout(r, 60));
	eq(host.writes, [], 'an armed timer produced a write after dispose()');
});

await t('WIRING: closeOpenDoc clears the load marker with the pin', async () => {
	// contentLoadedPath must move in lockstep with editBufferPath. Left behind, the
	// NEXT document opened at the same path would look pre-loaded before its GET.
	const body = fnBody(view, 'function closeOpenDoc(');
	assert(body, 'closeOpenDoc() not found');
	assert(/editBufferPath = null/.test(body), 'closeOpenDoc must unpin the buffer');
	assert(
		/contentLoadedPath = null/.test(body),
		'closeOpenDoc must also clear contentLoadedPath — the load marker and the pin ' +
		'must move together or a later doc can appear loaded when it is not',
	);
	assert(/autosaver\.reset\(\)/.test(body), 'closeOpenDoc must reset the autosaver so no state leaks to the next doc');
});

await t('WIRING: selectDoc resets the autosaver when rebinding to a new doc', async () => {
	const body = fnBody(view, 'async function selectDoc(');
	assert(body, 'selectDoc() not found');
	assert(
		/autosaver\.reset\(\)/.test(body),
		'selectDoc must reset the autosaver — carrying the previous doc\'s failure count ' +
		'and visible state into a new document misreports its save state',
	);
	assert(/leaveRefused = false/.test(body), 'selectDoc must clear the latched escape-hatch flag');
	assert(/savePermanentlyRejected = false/.test(body), 'selectDoc must clear the permanent-rejection flag');
});

await t('WIRING: canLeaveOpenDoc derives its verdict from canLeaveDoc, not inline', async () => {
	// THE tautology round-2 exposed: the old check counted `canLeaveOpenDoc()`
	// references, so gutting the function body to `if (true) return true` restored the
	// original fail-open blocker verbatim and the gate stayed green. The verdict now
	// comes from the driven policy fn, and this asserts the delegation.
	const m = view.match(/async function canLeaveOpenDoc\(\)[\s\S]*?\n\t\}/);
	assert(m, 'canLeaveOpenDoc() not found');
	const body = m[0];
	assert(/await flushSave\(\)/.test(body), 'canLeaveOpenDoc() must flush before deciding');
	assert(
		/if \(canLeaveDoc\(\{[^}]*dirtyAfterFlush: autosaver\.isDirty\(\)[^}]*\}\)\) return true/.test(body),
		'the leave verdict must come from canLeaveDoc({ editing, dirtyAfterFlush }) — an ' +
		'inline `return true` here is the original silent-loss blocker and no shape check ' +
		'that merely NAMES this function can catch it',
	);
	assert(/return false/.test(body), 'canLeaveOpenDoc() must be able to refuse');
	assert(/leaveRefused = true/.test(body), 'a refusal must latch the escape hatch on');
});

await t('WIRING: every leave path routes through the guard', async () => {
	const guards = view.match(/canLeaveOpenDoc\(\)/g) || [];
	assert(
		guards.length >= 4, // definition + back button + selectDoc + folder effect
		`expected the leave-guard at every close path, found ${guards.length} reference(s)`,
	);
	assert(
		/onclick=\{async \(\) => \{ if \(!\(await canLeaveOpenDoc\(\)\)\) return; closeOpenDoc\(\)/.test(view),
		'the Back button must await canLeaveOpenDoc() and abort the close when it fails',
	);
	assert(view.match(/aria-label="Back to library"/), 'Back button not found');
	assert(
		/if \(await canLeaveOpenDoc\(\)\) closeOpenDoc\(\)/.test(view),
		'the folder-change effect must go through canLeaveOpenDoc() — a fire-and-forget ' +
		'flush there cancels the armed backoff retry and then unpins the buffer, losing it',
	);
	const sel = view.match(/async function selectDoc\([\s\S]*?\n\t\}/);
	assert(sel && /if \(!\(await canLeaveOpenDoc\(\)\)\) return/.test(sel[0]),
		'selectDoc() must abort the switch when the outgoing buffer could not be saved');
});




await t('WIRING: reset() notifies the host instead of relying on setState dedup', async () => {
	// Round-2 mutation: reverting reset() to `setState('idle')` restores the
	// whisper-wedge (setState early-returns when the value already matches, so a
	// display forced to 'idle' behind the machine's back never updates again).
	const src = readFileSync(AUTOSAVE_JS, 'utf8');
	const m = src.match(/reset\(\) \{[\s\S]*?\n\t\t\}/);
	assert(m, 'autosave.js reset() not found');
	assert(
		/host\.onState\('idle'\)/.test(m[0]),
		'reset() must notify the host directly — going through setState() lets the dedup ' +
		'swallow the notification and wedge the whisper hidden while text is owed',
	);
	assert(/host\.onFailures\?\.\(0\)/.test(m[0]), 'reset() must clear the host failure mirror too');
});

await t('WIRING: reset() actually re-notifies a host already showing idle', async () => {
	// Driven counterpart to the check above.
	const host = makeHost({ initial: 'a' });
	const saver = createAutosaver(host, { debounceMs: 5 });
	host.states.length = 0;
	saver.reset();
	eq(host.states, ['idle'], 'reset() must push a state to the host even when it is already idle internally');
});

await t('WIRING: the stuck threshold is actually reachable', async () => {
	// Round-2 mutation: SAVE_STUCK_AFTER_FAILURES = 100000 makes the hatch
	// unreachable while every shape check still passes.
	const m = view.match(/const SAVE_STUCK_AFTER_FAILURES = (\d+)/);
	assert(m, 'SAVE_STUCK_AFTER_FAILURES not found');
	const threshold = Number(m[1]);
	assert(
		threshold >= 1 && threshold <= 10,
		`the stuck threshold is ${threshold} — outside 1..10 the escape hatch is effectively ` +
		'unreachable, which puts the user back in a document they cannot leave',
	);
	assert(
		/isSaveStuck\(\{/.test(view),
		'saveStuck must be derived via isSaveStuck(...) so its truth table is driven',
	);
});

await t('WIRING: the checkbox writer respects single-flight and checks res.ok', async () => {
	const m = view.match(/async function handleReadOnlyCheckboxClick\([\s\S]*?\n\t\}/);
	assert(m, 'handleReadOnlyCheckboxClick() not found');
	const body = m[0];
	assert(
		/checkboxWriteInFlight/.test(body),
		'the checkbox write is the one POST outside the autosaver; it needs its own ' +
		'in-flight guard so it cannot run twice concurrently',
	);
	// It must REFUSE while the editor owes text, not flush first: the pending buffer
	// may predate content the server has since gained (an agent rewrite), so flushing
	// would write stale text and then apply the toggle on top of it.
	assert(
		/if \(autosaver\.isDirty\(\)\) return/.test(body),
		'the checkbox writer must REFUSE while the editor still owes text (not flush ' +
		'first) — flushing a stale buffer replaces a newer document and then toggles a ' +
		'checkbox that was never in the text that got written',
	);
	assert(
		!/await flushSave\(\)/.test(body),
		'the checkbox writer must not flush the editor buffer — see above',
	);
	assert(
		/contentLoadedPath !== selectedDoc\.path\) return/.test(body),
		'the checkbox writer must refuse an unloaded placeholder too',
	);
	assert(
		/if \(!res\.ok\)/.test(body),
		'the checkbox write must check res.ok — ignoring it leaves the tick showing a ' +
		'state the vault never stored (fail-open)',
	);
	assert(
		/selectedDoc = \{ \.\.\.selectedDoc, content: before \}/.test(body),
		'a failed checkbox write must roll the optimistic toggle back',
	);
});

await t('WIRING: finishEditing releases the buffer on a clean exit', async () => {
	// Round-2 MAJOR: leaving editBufferPath pinned + editContent populated after a
	// clean Done made a stale buffer look authoritative. An agent rewrite then landed
	// via SSE, isDirty() flipped true against the agent's content, and both the resume
	// shortcut and the checkbox path would write our stale text back over their work.
	const m = view.match(/async function finishEditing\(\)\s*\{[\s\S]*?\n\t\}/);
	assert(m, 'finishEditing() not found');
	const body = m[0];
	assert(/if \(autosaver\.isDirty\(\)\)/.test(body), 'finishEditing must not exit while text is owed');
	assert(
		/releaseEditBuffer\(\)/.test(body),
		'a clean exit must release the buffer (unpin + clear) — a retained buffer can ' +
		'later overwrite an agent rewrite',
	);
	assert(
		/toasts\.error\(/.test(body),
		'a refused Done must say something — the whisper already read "Unsaved", so ' +
		'nothing changes on screen and the button reads as broken',
	);
	const rel = fnBody(view, 'function releaseEditBuffer(');
	assert(rel, 'releaseEditBuffer() not found');
	assert(/editBufferPath = null/.test(rel) && /editContent = ''/.test(rel),
		'releaseEditBuffer must clear BOTH the pin and the buffer text');
	assert(/autosaver\.reset\(\)/.test(rel), 'releaseEditBuffer must reset the machine');
	assert(/leaveRefused = false/.test(rel) && /savePermanentlyRejected = false/.test(rel),
		'releaseEditBuffer must clear BOTH latched escape-hatch triggers. Left set, ' +
		'`saveStuck` stays true and the one-click Discard button renders next to ' +
		'"Unsaved" on every keystroke of a perfectly healthy save (round-3 F7)');
});

await t('DRIVEN: a permanent rejection actually STOPS the retry loop', async () => {
	// Round-3 finding F4: the component set a `savePermanentlyRejected` flag but the
	// machine never saw it, so armRetry() kept re-POSTing the user's plaintext every
	// 10s forever to an endpoint that had already refused it. The claim was false.
	const host = makeHost({ initial: 'a' });
	host.save = async (content) => {
		host.writes.push(content);
		await tick();
		return 'permanent'; // e.g. 400 / 413 / 403
	};
	const saver = createAutosaver(host, { debounceMs: 2 });
	host.buffer = 'ab';
	await saver.flush();
	const after = host.writes.length;
	eq(after, 1, 'expected exactly one attempt before the permanent verdict');
	await new Promise((r) => setTimeout(r, 200));
	eq(host.writes.length, after, 'the machine kept retrying a PERMANENTLY rejected write — the plaintext is resubmitted forever');
	// ...but it must NOT be a discard.
	assert(saver.isDirty(), 'a permanent rejection must keep the buffer — it is not a discard');
	eq(saver.state, 'unsaved', `state must stay 'unsaved', got '${saver.state}'`);
	assert(saver.permanentlyRejected, 'the machine should expose the permanent-rejection state');
});

await t('DRIVEN: a fresh keystroke clears the permanent rejection and retries', async () => {
	const host = makeHost({ initial: 'a' });
	let verdict = 'permanent';
	host.save = async (content) => {
		host.writes.push(content);
		await tick();
		if (verdict === 'permanent') return 'permanent';
		host.persisted = content;
		return true;
	};
	const saver = createAutosaver(host, { debounceMs: 2 });
	host.buffer = 'ab';
	await saver.flush();
	assert(saver.permanentlyRejected, 'precondition: expected a permanent rejection');
	verdict = 'ok';
	host.buffer = 'abc';
	saver.schedule(); // the user edits — a different request, worth trying again
	assert(!saver.permanentlyRejected, 'a keystroke must clear the permanent-rejection latch');
	await new Promise((r) => setTimeout(r, 60));
	eq(host.persisted, 'abc', 'the edited buffer should save once the rejection latch is cleared');
});

await t('DRIVEN: a disposed machine stops mid-drain, not just at entry', async () => {
	// Round-3 finding F3: run() checked `disposed` only on entry, so the drain loop
	// kept issuing NEW writes after dispose(). onDestroy is `flushSave(); dispose();`
	// so a save is ALWAYS in flight when dispose lands, and Svelte destroys children
	// after the parent — a child editor's final onChange fed the running drain.
	const host = makeHost({ initial: 'a', latencyMs: 10 });
	const saver = createAutosaver(host, { debounceMs: 2 });
	host.buffer = 'my paragraph';
	const inFlight = saver.flush(); // not awaited — the real onDestroy shape
	saver.dispose();
	// The child editor's last keystroke lands while the drain is still running.
	host.buffer = 'my paragraph + the very last keystrokes';
	await inFlight;
	await new Promise((r) => setTimeout(r, 80));
	eq(host.writes, ['my paragraph'],
		'a disposed machine issued a NEW write from its drain loop — that orphan can land ' +
		'after a remounted view has saved and overwrite the newer text');
});

await t('WIRING: the save transport reports permanent rejections to the machine', async () => {
	const host = view.match(/const autosaver = createAutosaver\(\{[\s\S]*?\n\t\}\);/);
	assert(host, 'createAutosaver(...) host not found');
	const body = host[0];
	assert(/classifySaveResult\(\{ ok: res\.ok, status: res\.status \}\)/.test(body),
		'the save transport must classify the response via classifySaveResult(...)');
	assert(/return 'permanent';/.test(body),
		"the transport must RETURN 'permanent' — merely setting a component flag leaves " +
		'the machine retrying forever (round-3 F4)');
	assert(/savePermanentlyRejected = true/.test(body), 'the component must latch the hatch on');
});


await t('WIRING: the doc-scoped error branch exists and does not shadow the editor', async () => {
	// Round-3 F5: deleting the whole {:else if docLoadError} branch stayed green.
	assert(/\{:else if docLoadError\}/.test(view),
		'the doc-scoped error branch was removed — a failed document GET would fall ' +
		'through to the read-only viewer showing an EMPTY document as if it were real');
	const loadingIdx = view.indexOf('{#if loadingDoc}');
	const errIdx = view.indexOf('{:else if docLoadError}');
	const editIdx = view.indexOf('{:else if editing}');
	assert(loadingIdx !== -1 && errIdx > loadingIdx && editIdx > errIdx,
		'the branch order must be loading → docLoadError → editing, so an unreadable ' +
		'document can never render as an editable empty one');
	// ...and it must be cleared by every authoritative load, or a recovered doc stays stuck.
	const reload = fnBody(view, 'async function reloadCurrentDoc(');
	assert(reload && /docLoadError = null/.test(reload), 'reloadCurrentDoc must clear docLoadError');
	assert(/docLoadError = null/.test(fnBody(view, 'async function selectDoc(') || ''), 'selectDoc must clear docLoadError up front');
});

await t('WIRING: copy/discard act on the real buffer', async () => {
	// Round-3 F5: copying '' instead of editContent stayed green — a dead escape hatch.
	const copy = fnBody(view, 'async function copyEditBufferToClipboard(');
	assert(copy, 'copyEditBufferToClipboard() not found');
	assert(/writeText\(editContent\)/.test(copy),
		'Copy text must copy editContent — copying anything else makes the only ' +
		'take-your-text-with-you affordance a lie');
});

await t('WIRING: no unsaved buffer is written to browser storage', async () => {
	// A sessionStorage rescue for the unmount case was built and REMOVED: it put
	// unsaved vault plaintext in unencrypted storage (CLAUDE.md §1) with no sweep on
	// logout, and auto-saved it back over newer server content on recovery. This
	// keeps that door shut — any future rescue must be encrypted, swept on lock, and
	// must ASK before writing.
	const offenders = [];
	for (const m of view.matchAll(/\b(localStorage|sessionStorage)\.setItem\(([^)]*)\)/g)) {
		if (/editContent|buffer|content/i.test(m[2])) offenders.push(m[0].slice(0, 70));
	}
	eq(offenders, [], 'the editor buffer is being written to browser storage — unsaved vault plaintext must never go to unencrypted at-rest storage');
});

await t('WIRING: the save paths log only an allowlisted error shape', async () => {
	// The buffer is the user's most intimate plaintext (CLAUDE.md §1). A name-based
	// denylist was defeated in round-2 review by `const dbg = content`, so this is an
	// ALLOWLIST: inside the save/write functions, a console call may pass only a
	// literal message plus a narrow error expression — never a bare identifier that
	// could hold document text.
	const zones = [];
	for (const re of [
		/const autosaver = createAutosaver\(\{[\s\S]*?\n\t\}\);/,
		/async function handleReadOnlyCheckboxClick\([\s\S]*?\n\t\}/,
	]) {
		const m = view.match(re);
		if (m) zones.push(m[0]);
	}
	assert(zones.length === 2, 'could not delimit both write paths for the log audit');
	const ALLOWED_ARG = /^(e|err|error)( instanceof Error \? \1\.message : \1|\.message)$/;
	const offenders = [];
	for (const zone of zones) {
		const re = /console\.(log|warn|error|info|debug)\(\s*('[^']*'|"[^"]*"|`[^`]*`)\s*(?:,\s*([^;]*?)\s*)?\);/g;
		let m;
		while ((m = re.exec(zone)) !== null) {
			const extra = (m[3] || '').trim();
			if (extra && !ALLOWED_ARG.test(extra)) offenders.push(extra.slice(0, 60));
		}
		// A console call whose FIRST argument isn't a literal is rejected outright.
		const loose = zone.match(/console\.(log|warn|error|info|debug)\(\s*[^'"`]/g) || [];
		for (const l of loose) offenders.push(l.trim());
	}
	eq(offenders, [], 'a console call in a save path passes something other than a literal message + an Error — document plaintext must never be logged');
});

await t('WIRING: no document content is logged anywhere in the view', async () => {
	// Belt to the allowlist's braces: a direct denylist for the obvious names.
	const offenders = [];
	const re = /console\.(log|warn|error|info|debug)\(([^;]*?)\);/g;
	let m;
	while ((m = re.exec(view)) !== null) {
		const args = m[2];
		if (/\b(content|editContent|updated|buffer)\b/.test(args)) {
			offenders.push(view.slice(0, m.index).split('\n').length);
		}
	}
	eq(offenders, [], `console call logs document content at line(s) ${offenders.join(', ')} — never log plaintext`);
});

await t('WIRING: a stuck save offers an escape hatch (copy / discard)', async () => {
	assert(/const saveStuck = \$derived/.test(view), 'saveStuck not derived from the failure count');
	const discard = fnBody(view, 'function discardStuckEdit(');
	assert(discard, 'no explicit discard affordance for a stuck save');
	for (const req of ['editBufferPath = null', 'autosaver.cancel()', "editContent = ''", 'editing = false']) {
		assert(discard.includes(req), `discardStuckEdit() must ${req} — an empty Discard button is a dead control`);
	}
	assert(/savePermanentlyRejected = false/.test(discard),
		'discardStuckEdit() must clear the permanent-rejection latch, or the Discard button ' +
		'keeps rendering during perfectly healthy typing afterwards (round-3 F7)');
	assert(/copyEditBufferToClipboard/.test(view), 'no way to copy an unsaved buffer out');
	assert(
		/\{#if saveState === 'unsaved' && saveStuck\}/.test(view),
		'the escape hatch must render when a save is stuck — refusing to close a doc ' +
		'without one traps the user in it',
	);
	// The failure COUNT alone is not sufficient: schedule() zeroes it on every
	// keystroke, so a user typing steadily on a dead connection can be refused an
	// exit while never accumulating enough failures to reveal the hatch. A refused
	// leave must therefore reveal it directly.
	const derived = view.match(/const saveStuck = \$derived\([\s\S]*?\}\)\);/);
	assert(derived, 'the saveStuck derivation was not found');
	assert(
		/leaveRefused: leaveRefused \|\| savePermanentlyRejected/.test(derived[0]),
		'saveStuck must honour the LATCHED triggers (a refused leave and a permanent ' +
		'rejection) — the failure count alone is starvable because schedule() zeroes it ' +
		'on every keystroke, so a refused leave could otherwise show no way out',
	);
	const refusal = fnBody(view, 'async function canLeaveOpenDoc(');
	assert(refusal, 'canLeaveOpenDoc() not found');
	assert(
		/leaveRefused = true/.test(refusal),
		'`leaveRefused` must be set inside canLeaveOpenDoc(), at the moment of refusal',
	);
});

await t('D-052: every doc-close path goes through the flush/ownership guards', async () => {
	// A bare `selectedDoc = null` outside closeOpenDoc() would strand a pinned
	// buffer and silently drop the edit.
	const offenders = [];
	const re = /selectedDoc = null/g;
	let m;
	while ((m = re.exec(view)) !== null) {
		const line = view.slice(0, m.index).split('\n').length;
		const context = view.slice(Math.max(0, m.index - 400), m.index);
		if (!/function closeOpenDoc\(\)\s*\{[^}]*$/.test(context)) offenders.push(line);
	}
	eq(offenders, [], `\`selectedDoc = null\` outside closeOpenDoc() at line(s) ${offenders.join(', ')} — every close must unpin editBufferPath too`);
});

const total = passes + failures;
console.log(`\n${passes}/${total} checks passed`);
if (failures > 0) {
	console.log('VERDICT: NO-GO');
	process.exit(1);
}
console.log('VERDICT: GO');
