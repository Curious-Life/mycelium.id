import { writable } from 'svelte/store';
import { browser } from '$app/environment';

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'mycelium-theme';

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
			}
			set(theme);
		},

		toggle: () => {
			update(current => {
				const next = current === 'dark' ? 'light' : 'dark';
				if (browser) {
					localStorage.setItem(STORAGE_KEY, next);
					document.documentElement.setAttribute('data-theme', next);
				}
				return next;
			});
		},

		initialize: () => {
			if (!browser) return;
			const theme = getInitialTheme();
			document.documentElement.setAttribute('data-theme', theme);
			set(theme);

			const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
			const handleChange = (e: MediaQueryListEvent) => {
				const stored = localStorage.getItem(STORAGE_KEY);
				if (!stored) {
					const newTheme = e.matches ? 'light' : 'dark';
					document.documentElement.setAttribute('data-theme', newTheme);
					set(newTheme);
				}
			};
			mediaQuery.addEventListener('change', handleChange);
			return () => mediaQuery.removeEventListener('change', handleChange);
		},
	};
}

export const theme = createThemeStore();
