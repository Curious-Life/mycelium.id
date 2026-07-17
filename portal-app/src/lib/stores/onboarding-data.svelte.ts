// The import-completed signal — any import path emits it, MindscapeInvite listens.
//
// ⚠️ WHY THIS EXISTS. MindscapeInvite reads the cheap readiness slices ONCE on mount, and
// then only re-reads after ITS OWN uploader succeeds. But data lands in the vault from other
// doors: <ImportView> (the Import page), and <ImportDropZone> (the app-wide drop overlay, which
// accepts a file dropped ANYWHERE over the window). Neither touches MindscapeInvite. So a user
// who dropped a 70k-message export over the map — while the invite panel sat open beside it —
// kept being told "no data uploaded" over a full vault, because the panel never learned the
// server fact had changed. The check was a memory of THIS COMPONENT'S uploads, rendered as a
// claim about THE VAULT. Those are different facts (this is the §3.7/§3.2a family: the display
// out-lives the fact it was computed from).
//
// The fix is a SIGNAL, not a poll. The import completion paths call signalImportCompleted();
// MindscapeInvite re-reads the cached `data,evidence` slices in an $effect. Those slices are
// the cheap reads (readiness.js: data = an SWR-cached COUNT, evidence = OPT-IN aggregates named
// once); the invite is ALSO re-read on window focus, for imports that finished while the app
// was backgrounded.
//
// ⚠️ NOT BY POLLING. PIVOT 2 (design): `/import/preview` must NEVER be polled, and the pure
// `/onboarding/status` route must never be polled either. An interval that re-reads readiness
// every N seconds would resurrect exactly the cost PIVOT 2 killed, on every open invite panel,
// forever — to catch an import that happens rarely. A signal costs nothing until it fires, and
// window-focus costs nothing until the user comes back. So: focus + signal, never a timer.
let bump = $state(0);

/** Called by every import-completion path AFTER the server confirms the import landed. */
export function signalImportCompleted(): void {
	bump += 1;
}

/** MindscapeInvite reads this in an $effect; any change means "re-read the readiness slices". */
export function importCompletedSignal(): number {
	return bump;
}
