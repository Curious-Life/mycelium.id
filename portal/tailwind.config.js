import defaultTheme from 'tailwindcss/defaultTheme';

/** @type {import('tailwindcss').Config} */
export default {
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			colors: {
				bg: 'var(--color-bg)',
				surface: 'var(--color-surface)',
				elevated: 'var(--color-elevated)',
				border: 'var(--color-border)',
				'text-primary': 'var(--color-text-primary)',
				'text-secondary': 'var(--color-text-secondary)',
				'text-tertiary': 'var(--color-text-tertiary)',
				'text-emphasis': 'var(--color-text-emphasis)',
				accent: 'var(--color-accent)',
				'void': '#0A0A0C',
				'obsidian': '#141417',
				'slate': '#1E1E23',
				'ash': '#2A2A32',
				'mist': '#6B6B75',
				'stone': '#9898A3',
				'pearl': '#E8E8EC',
				'ivory': '#FFFFFF',
				'cream': '#FAF8F5',
				'linen': '#F5F3EE',
				'sand': '#EBE8E2',
				'pebble': '#DCD8D0',
				'fog': '#A8A29E',
				'granite': '#625D58',
				'charcoal': '#44403C',
				'ink': '#1C1917',
				'aurum': 'var(--color-accent-aurum)',
				'azure': 'var(--color-accent)',
				'amethyst': 'var(--color-accent-amethyst)',
				'coral': 'var(--color-accent-coral)',
				'jade': 'var(--color-accent-jade)',
			},
			fontFamily: {
				sans: ['var(--font-sans)', ...defaultTheme.fontFamily.sans],
				serif: ['var(--font-serif)', ...defaultTheme.fontFamily.serif],
				mono: ['var(--font-mono)', ...defaultTheme.fontFamily.mono],
			},
			fontSize: {
				'display-xl': ['4rem', { lineHeight: '1.1', fontWeight: '400' }],
				'display-lg': ['3rem', { lineHeight: '1.15', fontWeight: '400' }],
				'display-md': ['2.25rem', { lineHeight: '1.2', fontWeight: '400' }],
			},
			spacing: {
				'18': '4.5rem',
				'22': '5.5rem',
			},
			borderRadius: {
				'4xl': '2rem',
				'sm': 'var(--radius-sm)',
				'md': 'var(--radius-md)',
				'lg': 'var(--radius-lg)',
				'xl': 'var(--radius-xl)',
			},
			boxShadow: {
				'sm': 'var(--shadow-sm)',
				'md': 'var(--shadow-md)',
				'lg': 'var(--shadow-lg)',
				'soft': '0 1px 2px rgba(39, 39, 39, 0.05)',
				'medium': '0 4px 12px rgba(39, 39, 39, 0.08)',
				'elevated': '0 12px 32px rgba(39, 39, 39, 0.12)',
			},
			transitionDuration: {
				'fast': 'var(--duration-fast)',
				'normal': 'var(--duration-normal)',
				'slow': 'var(--duration-slow)',
			},
			transitionTimingFunction: {
				'out': 'var(--ease-out)',
				'in-out': 'var(--ease-in-out)',
				'bounce': 'var(--ease-bounce)',
			},
		},
	},
	plugins: [
		require('@tailwindcss/typography'),
	],
};
