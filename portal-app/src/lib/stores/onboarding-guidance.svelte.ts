// The un-dismiss signal (§3.7b) — Settings writes it, OnboardingFlow listens.
//
// ⚠️ WHY THIS EXISTS. `POST /onboarding/reset` clears `onboarding_dismissed_at` and Settings
// then said "Setup guidance restored." — truthfully about the DATABASE and falsely about the
// SCREEN. The rail never came back until the app was RESTARTED, because:
//
//   OnboardingFlow.svelte:356 →  else if (railVisible) refresh();
//   OnboardingFlow.svelte:151 →  railVisible = … && !dismissed && …
//
// The only code path that can re-read `dismissed` is GATED ON `!dismissed`. Once dismissed, it
// never runs again — the flag is unclearable in-session by construction. And `<OnboardingFlow/>`
// lives in the PERSISTENT app layout, so navigating Settings → Mindscape cannot remount it
// (the workspace shell focuses tabs; pages don't re-render). `onMount → refresh()` fires once
// per full page load, and a Tauri desktop app has no reload affordance.
//
// So a toggle that wrote correctly, reported honestly, and DID NOTHING the user could see —
// the third instance of "representable ≠ shown" in this build, in a shape my own gate could not
// catch: U2 asks "did we claim success when the write FAILED?" Here the write SUCCEEDS and the
// UI still lies (independent review HIGH-1, 2026-07-16).
//
// ⚠️ AND NOT BY UN-GATING THE POLL. `else refresh()` would fix it and issue 3 fetches every 4s,
// forever, on every dismissed vault — a permanent background cost to undo a click nobody may
// ever make. A signal costs nothing until it fires.
let bump = $state(0);

/** Settings calls this after a SUCCESSFUL reset — never before the server confirms. */
export function signalGuidanceRestored() {
	bump += 1;
}

/** OnboardingFlow reads this in an $effect; any change means "re-read `dismissed` now". */
export function guidanceRestoredSignal(): number {
	return bump;
}
