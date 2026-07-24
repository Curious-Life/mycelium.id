// lib/nav/back-intent.ts — ONE coherent back semantics for the app-level back
// gesture (the macOS two-finger swipe; Header.svelte binds it).
//
// D-035: the mindscape keeps its OWN drill-down history (realms → themes →
// territories → territory-detail) in the `mindscapeState` store. That history is
// invisible to the workspace's VIEW-history back-stack (`workspace.back()`), which
// only records view/tab switches (openInActiveTab → recordNav). So a swipe while
// drilled into a territory used to pop the whole mindscape VIEW — leaving the
// mindscape entirely — instead of stepping back up its internal drill-down.
//
// The fix is a single coordinator: a back gesture walks the mindscape's internal
// drill-down FIRST (detail → territory → realm), and only once the mindscape is
// back at its top level (or is not the focused view) does it fall through to the
// workspace VIEW-history back. `mindscapeState.goBack()` returns `true` only when it
// actually stepped up a level, so "at top level" is exactly "goBack() returned
// false" — no separate predicate to drift out of sync.
//
// This does NOT change `workspace.back()` (the view-history back is untouched — its
// B1–B4 contract still holds); it only changes which back the GESTURE consumes.
import { get } from 'svelte/store';
import { workspace } from '$lib/workspace/store';
import { mindscapeState } from '$lib/stores/mindscape';
import { navigationState } from '$lib/stores/navigation';

export type BackConsumer = 'mindscape' | 'workspace' | null;

/**
 * Consume ONE back step for the app-level back gesture.
 *   • If the mindscape is the FOCUSED view and its drill-down can still step up,
 *     step it up (returns 'mindscape').
 *   • Otherwise pop the workspace VIEW history (returns 'workspace' if it popped,
 *     null if there was nothing to return to).
 *
 * The focus check (primaryView === 'mindscape') is what keeps the gesture from
 * hijacking a back when the mindscape is open in an unfocused split or not on
 * screen — in that case the drill-down is left untouched and the view-history back
 * runs as before.
 */
export function goBackIntent(): BackConsumer {
	const mindscapeFocused = get(navigationState).primaryView === 'mindscape';
	// goBack() returns true only if it stepped up a drill-down level; when the
	// mindscape is already at its top level it returns false and we fall through to
	// the workspace view-history back — the one place the gesture leaves the view.
	if (mindscapeFocused && mindscapeState.goBack()) {
		return 'mindscape';
	}
	return workspace.back() ? 'workspace' : null;
}
