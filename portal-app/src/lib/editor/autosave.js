/**
 * Autosave drain — the single-flight save state machine behind the library
 * document editor (LibraryView.svelte).
 *
 * WHY THIS IS ITS OWN MODULE (D-052)
 * The old inline version could run OVERLAPPING writes to one document: the
 * debounce timer could elapse — or ⌘S / Done / unmount could flush — while a
 * previous save was still awaiting the network. Two racing writes meant one
 * could fail transiently, which surfaced to the user as a blocking error box,
 * and the buffer only re-saved on the NEXT keystroke. Extracting the machine
 * makes those invariants executable: `npm run verify:editor-autosave` drives
 * this file directly with a scripted fake transport, which is the only way the
 * "never overlaps" / "last write wins" / "never drops an edit" claims are
 * evidence rather than assertion.
 *
 * INVARIANTS (all exercised by the gate)
 *  1. SINGLE-FLIGHT — at most one `save()` is ever in flight. Callers arriving
 *     mid-save join the running drain instead of starting a second write.
 *  2. LAST WRITE WINS — every pass re-reads the buffer, so the final write
 *     carries the newest text. An edit made during a save is never left behind.
 *  3. NEVER THROWS — a rejected or failed `save()` is absorbed and retried with
 *     bounded backoff. Nothing here can raise an error box at the user.
 *  4. NEVER DISCARDS — while the buffer differs from what's persisted the state
 *     stays 'unsaved' and a retry stays armed. The machine has no path that
 *     drops a dirty buffer on the floor.
 *  5. OWNERSHIP — when the host reports `getPersisted() === null` the buffer no
 *     longer belongs to the open document, and NO write is issued. This is what
 *     stops a save scheduled for doc A landing on doc B after a switch.
 *
 * @typedef {'idle' | 'unsaved' | 'saving' | 'saved'} SaveState
 *
 * @typedef {object} AutosaveHost
 * @property {() => string} getBuffer   Text currently in the editor.
 * @property {() => string | null} getPersisted  Text last known persisted for
 *   the document the buffer belongs to, or `null` when the buffer does not
 *   belong to the open document (no doc open, mid-switch, discarded).
 * @property {(content: string) => Promise<boolean | 'permanent'>} save  Perform ONE
 *   write. Resolve `true` on success, `false` on a retryable failure, or the string
 *   `'permanent'` when the server will refuse this request however often it is
 *   resent (a 4xx that is not 408/429) — that stops the retry loop WITHOUT
 *   discarding the buffer. May reject; a rejection is treated exactly like `false`.
 * @property {(state: SaveState) => void} onState  Visible-state notifications.
 * @property {(consecutiveFailures: number) => void} [onFailures]  Optional. Called
 *   after every attempt with the consecutive-failure count (0 on success), so the
 *   host can surface sustained trouble. The machine never stops retrying.
 *
 * @typedef {object} AutosaveOptions
 * @property {number} [debounceMs]
 * @property {number} [maxBackoffMs]
 * @property {number} [maxPasses]
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 */

/**
 * @param {AutosaveHost} host
 * @param {AutosaveOptions} [options]
 */
export function createAutosaver(host, options = {}) {
	const debounceMs = options.debounceMs ?? 800;
	const maxBackoffMs = options.maxBackoffMs ?? 10_000;
	// Passes per drain. Bounds continuous typing so the drain can't pin the
	// event loop; whatever is still dirty is picked up by the re-armed timer.
	const maxPasses = options.maxPasses ?? 5;
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = options.clearTimer ?? ((h) => clearTimeout(/** @type {any} */ (h)));

	/** @type {unknown} */ let timer = null;
	/** @type {Promise<void> | null} */ let runner = null;
	let failures = 0;
	let disposed = false;
	let permanentlyRejected = false;
	/** @type {SaveState} */ let state = 'idle';

	/** @param {SaveState} next */
	function setState(next) {
		if (state === next) return;
		state = next;
		host.onState(next);
	}

	/** Is there text owed to the server for the document the buffer belongs to? */
	function isDirty() {
		const persisted = host.getPersisted();
		if (persisted === null) return false; // buffer isn't the open doc's — invariant 5
		return host.getBuffer() !== persisted;
	}

	function cancelTimer() {
		if (timer !== null) { clearTimer(timer); timer = null; }
	}

	function armRetry() {
		cancelTimer();
		// A permanent rejection (4xx that is not 408/429) will be refused however often
		// we resend, so stop. This is NOT a discard — the buffer is kept, the state
		// stays 'unsaved', and the host surfaces the escape hatch. Retrying anyway
		// would re-transmit the user's plaintext every 10s to an endpoint that has
		// already refused it. A fresh keystroke clears the flag via schedule().
		if (permanentlyRejected) return;
		// Once disposed (the host component unmounted) NO new timer may be armed: an
		// orphaned retry closes over the dead component's buffer and would later
		// write that stale text over whatever a freshly-mounted view has since
		// saved. Any request already on the wire is unaffected and still completes.
		if (disposed) return;
		const delay = failures > 0
			? Math.min(debounceMs * 2 ** (failures - 1), maxBackoffMs)
			: debounceMs;
		timer = setTimer(() => { timer = null; void run(); }, delay);
	}

	/**
	 * One write of the buffer as it stands right now. Never throws.
	 * @returns {Promise<'ok' | 'transient' | 'permanent'>}
	 */
	async function attempt() {
		const content = host.getBuffer();
		setState('saving');
		/** @type {'ok' | 'transient' | 'permanent'} */
		let outcome = 'transient';
		try {
			const res = await host.save(content);
			// `true`/`false` keep the simple boolean contract; the string 'permanent'
			// lets a host say "the server will refuse this forever, stop resending".
			if (res === true) outcome = 'ok';
			else if (res === 'permanent') outcome = 'permanent';
			else outcome = 'transient';
		} catch {
			outcome = 'transient'; // invariant 3 — a throwing transport is a failed attempt, not an error box
		}
		if (outcome === 'ok') failures = 0;
		else failures++;
		permanentlyRejected = outcome === 'permanent';
		// Let the host react to sustained trouble (e.g. offer an escape hatch).
		host.onFailures?.(failures);
		return outcome;
	}

	/**
	 * Drain the buffer. Single-flight: concurrent callers share one runner.
	 * Resolves when the buffer is persisted, or when an attempt failed and a
	 * retry has been re-armed.
	 * @returns {Promise<void>}
	 */
	function run() {
		cancelTimer();
		// A disposed machine must never start a NEW write. Otherwise it can be
		// resurrected into exactly the orphan write dispose() exists to prevent —
		// reachable because Svelte runs a parent's onDestroy BEFORE its children are
		// destroyed, so a child editor can still emit a final onChange after dispose.
		if (disposed) return Promise.resolve();
		if (runner) return runner; // invariant 1 — join, never start a second write
		if (!isDirty()) {
			if (host.getPersisted() !== null) setState('saved');
			return Promise.resolve();
		}
		runner = (async () => {
			try {
				for (let pass = 0; pass < maxPasses; pass++) {
					// Re-checked EVERY pass, not just at entry. onDestroy's shape is
					// `void flushSave(); dispose();` — so a save is always in flight when
					// dispose() lands, and Svelte destroys child components AFTER the
					// parent's onDestroy, so a child editor's final onChange can still
					// mutate the buffer. Without this the running drain issues a brand-new
					// POST from a dead component, which is the orphan write dispose()
					// exists to prevent.
					if (disposed) return;
					if (!isDirty()) return;
					// Re-reads the buffer every pass → invariant 2.
					const outcome = await attempt();
					if (outcome !== 'ok') return; // `finally` decides whether to re-arm
				}
			} finally {
				runner = null;
				if (isDirty()) {
					setState('unsaved'); // invariant 4 — stays visible, stays queued
					armRetry();
				} else if (host.getPersisted() !== null) {
					setState('saved');
				}
			}
		})();
		return runner;
	}

	return {
		/** Current visible save state. */
		get state() { return state; },
		/** Number of consecutive failed attempts (0 once one succeeds). */
		get failures() { return failures; },
		/** True when the last attempt was refused in a way retrying cannot fix. */
		get permanentlyRejected() { return permanentlyRejected; },
		isDirty,

		/** A keystroke landed — debounce a save and drop any failure backoff. */
		schedule() {
			if (disposed) return; // see run() — a dead machine takes no new work
			setState('unsaved');
			failures = 0;
			permanentlyRejected = false; // a fresh edit is a different request — try again
			host.onFailures?.(0);
			cancelTimer();
			timer = setTimer(() => { timer = null; void run(); }, debounceMs);
		},

		/**
		 * Immediate drain — Done, ⌘S, doc switch, unmount. Skips the debounce and
		 * keeps going until the buffer is persisted. `host.save()` is INVOKED
		 * synchronously (before the first await suspends) so a flush fired during
		 * teardown captures the right buffer; whether the underlying request leaves
		 * synchronously is the host's business. Stops after a failed attempt, leaving
		 * the retry armed, rather than spinning.
		 * @returns {Promise<void>}
		 */
		async flush() {
			for (let pass = 0; pass < maxPasses; pass++) {
				if (disposed) return;
				if (!isDirty()) return;
				await run();
				if (failures > 0) return; // attempt failed; retry is armed (or refused as permanent)
			}
		},

		/**
		 * Abandon the buffer — an EXPLICIT user discard only (e.g. "reload the
		 * agent's version"). Never call this to merely close a doc; that path must
		 * flush first, or the edits are gone.
		 */
		cancel() {
			cancelTimer();
			failures = 0;
			permanentlyRejected = false;
			host.onFailures?.(0);
			setState('idle');
		},

		/**
		 * Return to a neutral state when the host rebinds the buffer to a different
		 * document (or reopens a clean one). Distinct from `cancel()` only in intent
		 * — both drop the timer — but callers must NOT poke the host's own state
		 * variable directly: `setState` dedups on the current value, so a display
		 * forced to 'idle' behind the machine's back wedges every later transition
		 * into a silent no-op and the whisper stays hidden while text is owed.
		 */
		reset() {
			cancelTimer();
			failures = 0;
			permanentlyRejected = false;
			host.onFailures?.(0);
			state = 'idle';
			host.onState('idle');
		},

		/**
		 * The host is going away for good. Prevents any FURTHER retry from being
		 * armed (an orphaned timer would write a dead component's stale buffer over
		 * newer content) without disturbing a request already in flight.
		 */
		dispose() {
			disposed = true;
			cancelTimer();
		},
	};
}
