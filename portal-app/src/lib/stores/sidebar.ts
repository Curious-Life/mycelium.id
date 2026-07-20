import { writable } from 'svelte/store';
import { browser } from '$app/environment';

/**
 * Shared sidebar-column width — the SINGLE source of truth for how wide the
 * sidebar column is, read by BOTH the Sidebar panel AND the Header's left cell
 * (R4-SHELLCHROME). The header splits into a left cell (hamburger, width of the
 * sidebar column) and a right cell (tabs, over the content); the left cell's
 * right border must line up with the sidebar's `border-r` to read as one
 * continuous vertical divider from the very top down. That only holds if both
 * elements are sized off the SAME value — including live, while the user drags
 * the resize handle — so the width lives here, not as Sidebar-local state.
 *
 * Persisted to localStorage (same key + clamp the Sidebar used before) so the
 * chosen width survives reloads.
 */
const KEY = 'mycelium-sidebar-width';
export const SIDEBAR_WIDTH_DEFAULT = 256;
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 400;

function initialWidth(): number {
	if (!browser) return SIDEBAR_WIDTH_DEFAULT;
	try {
		const saved = localStorage.getItem(KEY);
		if (saved) {
			const parsed = parseInt(saved, 10);
			if (parsed >= SIDEBAR_WIDTH_MIN && parsed <= SIDEBAR_WIDTH_MAX) return parsed;
		}
	} catch {
		/* private mode / storage disabled — fall through to the default */
	}
	return SIDEBAR_WIDTH_DEFAULT;
}

export const sidebarWidth = writable<number>(initialWidth());

if (browser) {
	sidebarWidth.subscribe((w) => {
		try {
			localStorage.setItem(KEY, String(w));
		} catch {
			/* ignore — non-persisted width is a cosmetic-only degradation */
		}
	});
}
