// The §4g subscription exemption (settings.allowSubscriptionSensitive), shared by every
// component that DISPLAYS or CHANGES it.
//
// ⚠️ WHY THIS EXISTS — it is a privacy correctness fix, not tidiness. The toggle lives in
// AISettings; the Intelligence screen PRINTS the guarantee that depends on it; SettingsView
// mounts both as SIBLINGS IN ONE PANE. When each read the value independently at onMount, you
// could flip the toggle ON in one component and the other — twenty lines up the same page,
// never remounted — would keep printing "Descriptions … stay in the EU or on your device"
// while the router was already sending narrate to us-standard. A FALSE PRIVACY STATEMENT, one
// scroll away, with no navigation (independent review ×3, 2026-07-16).
//
// The lesson that generalises: "the server is the source of truth, so a stale display is ugly
// but harmless" is TRUE of a model picker and FALSE here — because HERE THE DISPLAY IS THE
// PROMISE. State that a privacy claim is computed from must be single-copy, or the claim rots
// silently. If you add another consumer of this flag, read it from HERE.
//
// A module-level rune: one value, every reader reactive, no subscribe/unsubscribe ceremony.
// True once the USER changed it here (a PUT returned). A load may seed or refresh; only this
// blocks a load from overwriting.
let authoritative = false;

export const sensitiveExempt = $state({
	/** settings.allowSubscriptionSensitive — the router's `sensitiveUsExempt` input. */
	allowed: false,
	/** false until the first successful read; consumers should not claim anything before then. */
	loaded: false,
});

/**
 * AUTHORITATIVE — the user just changed it (a PUT returned). Always wins.
 */
export function setSensitiveExempt(allowed: boolean) {
	sensitiveExempt.allowed = allowed === true;
	sensitiveExempt.loaded = true;
	authoritative = true;
}

/**
 * A LOAD-TIME read. Never clobbers a value we already have.
 *
 * ⚠️ Both components fetch this at mount, and the Intelligence screen's fetch resolves after a
 * four-call Promise.all — so a user who flips the toggle DURING that window had their choice
 * overwritten by the in-flight GET, and the screen reverted to the opt-in-OFF privacy claim
 * while the server said `allowed=true` (independent review ×4, 2026-07-16). A load may SEED the
 * value; only a write may CHANGE it.
 */
export function seedSensitiveExempt(allowed: boolean) {
	// Only a WRITE is authoritative. Keying this on `loaded` instead made the FIRST seed
	// permanent for the document: re-entering the pane re-runs load(), but the seed no-op'd, so
	// a value that went stale (another tab flipped it) could never refresh — the same "the
	// display IS the promise" bug at a wider scope (independent review ×6, 2026-07-16).
	// A later load may refresh a seeded value; nothing may overwrite the user's own flip.
	if (authoritative) return;
	sensitiveExempt.allowed = allowed === true;
	sensitiveExempt.loaded = true;
}
