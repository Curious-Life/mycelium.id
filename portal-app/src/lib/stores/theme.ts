import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'mycelium-theme';

// Match the native macOS window chrome (the title-bar strip with the traffic-light
// buttons + drag area) to the in-app theme. Without this, the NSWindow follows the OS
// appearance, so a dark app on a light-mode Mac left a WHITE title-bar strip above a
// dark UI. Tauri v2's `set_theme` sets the NSWindow appearance → the strip follows.
// Raw invoke because the webview is a remote origin with no bundled @tauri-apps/api
// (same pattern as the drag strip's `plugin:window|start_dragging`); a no-op outside
// Tauri or if the bridge/permission is absent. `value` is 'light' | 'dark' verbatim.
function syncWindowTheme(theme: Theme) {
	if (!browser) return;
	try {
		(window as any).__TAURI_INTERNALS__?.invoke?.('plugin:window|set_theme', { label: 'main', value: theme });
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
				syncWindowTheme(theme);
			}
			set(theme);
		},

		toggle: () => {
			update(current => {
				const next = current === 'dark' ? 'light' : 'dark';
				if (browser) {
					localStorage.setItem(STORAGE_KEY, next);
					document.documentElement.setAttribute('data-theme', next);
					syncWindowTheme(next);
				}
				return next;
			});
		},

		initialize: () => {
			if (!browser) return;
			const theme = getInitialTheme();
			document.documentElement.setAttribute('data-theme', theme);
			syncWindowTheme(theme);
			set(theme);

			const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
			const handleChange = (e: MediaQueryListEvent) => {
				const stored = localStorage.getItem(STORAGE_KEY);
				if (!stored) {
					const newTheme = e.matches ? 'light' : 'dark';
					document.documentElement.setAttribute('data-theme', newTheme);
					syncWindowTheme(newTheme);
					set(newTheme);
				}
			};
			mediaQuery.addEventListener('change', handleChange);
			return () => mediaQuery.removeEventListener('change', handleChange);
		},
	};
}

export const theme = createThemeStore();
