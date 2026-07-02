/**
 * CodeMirror 6 theme for the writing sanctuary — mapped to Mycelium design
 * tokens so the editor is visually identical to the read-only `.doc-content`
 * viewer (read/write parity). The surface IS the page: no boxed panel, a
 * narrow editorial measure, generous line-height, an editorial serif body.
 */
import { EditorView } from '@codemirror/view';

export const sanctuaryTheme = EditorView.theme(
	{
		'&': {
			color: 'var(--color-text-primary)',
			backgroundColor: 'transparent',
			fontSize: '17px',
		},
		'.cm-scroller': {
			fontFamily: 'var(--font-serif)',
			lineHeight: '1.72',
			overflow: 'visible',
		},
		'.cm-content': {
			caretColor: 'var(--color-accent-aurum)',
			padding: '0',
			maxWidth: '42rem',
			margin: '0 auto',
		},
		'&.cm-focused': { outline: 'none' },
		'.cm-cursor, .cm-dropCursor': {
			borderLeftColor: 'var(--color-accent-aurum)',
			borderLeftWidth: '2px',
		},
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
			backgroundColor: 'rgba(91, 159, 232, 0.22)',
		},
		'.cm-line': { padding: '0' },

		'.cm-md-h1': { fontSize: '1.9em', fontWeight: '500', color: 'var(--color-text-emphasis)', lineHeight: '1.25' },
		'.cm-md-h2': { fontSize: '1.45em', fontWeight: '500', color: 'var(--color-text-emphasis)', lineHeight: '1.3' },
		'.cm-md-h3': { fontSize: '1.2em', fontWeight: '500', color: 'var(--color-text-primary)' },
		'.cm-md-h4': { fontSize: '1.05em', fontWeight: '500', color: 'var(--color-text-primary)' },
		'.cm-md-strong': { fontWeight: '600', color: 'var(--color-text-emphasis)' },
		'.cm-md-em': { fontStyle: 'italic' },
		'.cm-md-strike': { textDecoration: 'line-through', color: 'var(--color-text-tertiary)' },
		'.cm-md-code': {
			fontFamily: 'var(--font-mono)',
			fontSize: '0.85em',
			padding: '0.12em 0.4em',
			borderRadius: '0.25rem',
			backgroundColor: 'var(--color-elevated)',
			border: '1px solid var(--color-border)',
		},
		'.cm-md-link': { color: 'var(--color-accent)', textDecoration: 'none' },
		'.cm-md-task': {
			verticalAlign: 'middle',
			marginRight: '0.15em',
			width: '1.05em',
			height: '1.05em',
			accentColor: 'var(--color-accent)',
			cursor: 'pointer',
		},
		'.cm-md-quote-line': {
			borderLeft: '2px solid var(--color-accent-aurum)',
			paddingLeft: '1rem',
			color: 'var(--color-text-secondary)',
			fontStyle: 'italic',
		},
	},
	{ dark: true },
);
