import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'mycelium-theme';

// The app background for the CURRENT theme, straight from the live stylesheet
// (tokens.css --color-bg). Deliberately READ rather than duplicated: the native strip
// must equal the app background exactly, and a second copy of the palette here would
// drift the moment tokens.css changes. Safe to call right after the data-theme
// attribute flips — getComputedStyle forces a style recalc, so the value returned is
// already the NEW theme's. Returns null if it isn't a plain hex (the shape Tauri's
// Color parses); callers fall back rather than send something unparseable.
const FALLBACK_BG: Record<Theme, string> = { dark: '#0A0A0C', light: '#FAF8F5' };
function appBackgroundHex(): string | null {
	const v = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim();
	return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

// Match the native macOS window chrome (the title-bar strip with the traffic-light
// buttons + drag area) to the in-app theme. Without this, the NSWindow follows the OS
// appearance, so a dark app on a light-mode Mac left a WHITE title-bar strip above a
// dark UI. Tauri v2's `set_theme` sets the NSWindow appearance → the strip follows.
//
// Appearance alone is not enough for a SEAMLESS strip, though: it only picks the
// system's dark/light chrome (a mid grey), never the app's own #0A0A0C. The window is
// built with TitleBarStyle::Transparent (main.rs), which makes macOS paint the strip
// with the WINDOW'S background colour — so we set that too, and the strip becomes the
// app background exactly. Two calls, two jobs: set_theme = traffic-light glyphs +
// native menus, set_background_color = the strip's fill.
//
// Raw invoke because the webview is a remote origin with no bundled @tauri-apps/api
// (same pattern as the drag strip's `plugin:window|start_dragging`); a no-op outside
// Tauri or if the bridge/permission is absent. `value` is the payload arg both
// window-plugin setters take (tauri-2.11.2/src/window/plugin.rs:39-48).
function syncWindowChrome(theme: Theme) {
	if (!browser) return;
	try {
		const invoke = (window as any).__TAURI_INTERNALS__?.invoke;
		if (!invoke) return;
		invoke('plugin:window|set_theme', { label: 'main', value: theme });
		// Fall back to the literal rather than skipping: on a cold initialize() the
		// stylesheet may not have resolved yet, and skipping would strand the strip on
		// the previous theme's colour — worse than a one-frame-late correct one.
		invoke('plugin:window|set_background_color', { label: 'main', value: appBackgroundHex() ?? FALLBACK_BG[theme] });
	} catch { /* not in Tauri / API shape differs */ }
}

function getInitialTheme(): Theme {
	if (!browser) return 'dark';
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'light' || stored === 'dark') return stored;
	// Dark on first load by default (brand is the dark, starry surface). The OS
	// preference is intentionally NOT consulted — a remembered toggle still wins.
	return 'dark';
}

function createThemeStore() {
	const { subscribe, set, update } = writable<Theme>(getInitialTheme());

	return {
		subscribe,

		setTheme: (theme: Theme) => {
			if (browser) {
				localStorage.setItem(STORAGE_KEY, theme);
				document.documentElement.setAttribute('data-theme', theme);
				syncWindowChrome(theme);
			}
			set(theme);
		},

		toggle: () => {
			update(current => {
				const next = current === 'dark' ? 'light' : 'dark';
				if (browser) {
					localStorage.setItem(STORAGE_KEY, next);
					document.documentElement.setAttribute('data-theme', next);
					syncWindowChrome(next);
				}
				return next;
			});
		},

		initialize: () => {
			if (!browser) return;
			const theme = getInitialTheme();
			document.documentElement.setAttribute('data-theme', theme);
			syncWindowChrome(theme);
			set(theme);

			const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
			const handleChange = (e: MediaQueryListEvent) => {
				const stored = localStorage.getItem(STORAGE_KEY);
				if (!stored) {
					const newTheme = e.matches ? 'light' : 'dark';
					document.documentElement.setAttribute('data-theme', newTheme);
					syncWindowChrome(newTheme);
					set(newTheme);
				}
			};
			mediaQuery.addEventListener('change', handleChange);
			return () => mediaQuery.removeEventListener('change', handleChange);
		},
	};
}

export const theme = createThemeStore();
