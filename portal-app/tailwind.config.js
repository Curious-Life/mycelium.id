import typography from '@tailwindcss/typography';

/**
 * Tailwind config — reconstructed for the V1 self-hosted port. The canonical
 * portal's app.css uses @tailwind directives + semantic utilities
 * (text-primary, bg-surface, text-aurum, rounded-lg…) that map onto the
 * design-system CSS variables in src/lib/styles/tokens.css. We map the same
 * names here so utilities resolve to the live (theme-aware) CSS vars — light/
 * dark switches by flipping [data-theme] without rebuilding classes.
 *
 * @type {import('tailwindcss').Config}
 */
export default {
	darkMode: ['selector', '[data-theme="dark"]'],
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				// Surfaces
				bg: 'var(--color-bg)',
				surface: 'var(--color-surface)',
				elevated: 'var(--color-elevated)',
				border: 'var(--color-border)',
				// Text (semantic)
				primary: 'var(--color-text-primary)',
				secondary: 'var(--color-text-secondary)',
				tertiary: 'var(--color-text-tertiary)',
				emphasis: 'var(--color-text-emphasis)',
				// Accents — sourced from RGB channel triplets in tokens.css so the
				// utilities support Tailwind's /opacity modifier (bg-aurum/10,
				// from-azure/5, border-coral/30). Plain `var(--color-accent)` here
				// breaks the modifier — rgb(<full-color> / α) is invalid CSS — which
				// silently dropped every accent/N tint across ~15 components.
				// (Design system from the design-system branch, ported to portal-app.)
				accent: 'rgb(var(--color-accent-rgb) / <alpha-value>)',
				azure: 'rgb(var(--color-accent-rgb) / <alpha-value>)',
				aurum: 'rgb(var(--color-accent-aurum-rgb) / <alpha-value>)',
				amethyst: 'rgb(var(--color-accent-amethyst-rgb) / <alpha-value>)',
				coral: 'rgb(var(--color-accent-coral-rgb) / <alpha-value>)',
				jade: 'rgb(var(--color-accent-jade-rgb) / <alpha-value>)',
			},
			fontFamily: {
				sans: ['Geist', 'system-ui', 'sans-serif'],
				serif: ['Geist', 'system-ui', 'sans-serif'],
				mono: ['JetBrains Mono', 'monospace'],
			},
			borderRadius: {
				sm: '4px',
				md: '8px',
				lg: '16px',
				xl: '24px',
				full: '9999px',
			},
			boxShadow: {
				sm: 'var(--shadow-sm)',
				md: 'var(--shadow-md)',
				lg: 'var(--shadow-lg)',
				xl: 'var(--shadow-lg)',
			},
			transitionTimingFunction: {
				out: 'cubic-bezier(0.0, 0.0, 0.2, 1)',
				'in-out': 'cubic-bezier(0.4, 0.0, 0.2, 1)',
				bounce: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
			},
		},
	},
	plugins: [typography],
};
