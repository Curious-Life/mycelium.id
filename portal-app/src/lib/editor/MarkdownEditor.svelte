<script lang="ts">
	/**
	 * Svelte 5 wrapper around a CodeMirror 6 EditorView. Mounts via $effect in
	 * the established imperative-widget pattern (mirrors mountLiveIframe in
	 * LibraryView: bind:this + create-in-$effect + return disposer). Writes the
	 * buffer back to Svelte state through the update listener — NOT bind:value,
	 * which CM6 can't use.
	 *
	 * Markdown is the literal buffer; `value` round-trips byte-for-byte.
	 */
	import { untrack } from 'svelte';
	import { EditorView, keymap } from '@codemirror/view';
	import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
	import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
	import { markdown } from '@codemirror/lang-markdown';
	import { GFM } from '@lezer/markdown';
	import { markdownLivePreview } from './markdownLivePreview';
	import { sanctuaryTheme } from './editorTheme';

	let {
		value = '',
		onChange,
		onSave,
		placeholder: _placeholder = '',
	}: {
		value?: string;
		onChange?: (next: string) => void;
		onSave?: () => void;
		placeholder?: string;
	} = $props();

	let host = $state<HTMLDivElement | null>(null);
	let view: EditorView | null = null;
	// Guards the external-value→editor sync from echoing the editor's own edits
	// back through onChange (which would fight the cursor). Seeded inside the
	// mount effect so it tracks the live `value`, not just its initial snapshot.
	let lastEmitted = '';

	$effect(() => {
		if (!host) return;
		// Mount depends ONLY on `host` — read `value` untracked so a keystroke
		// (which updates `value` via onChange) doesn't re-run this and remount
		// the editor. External value changes are handled by the reconcile effect.
		const initial = untrack(() => value);
		view?.destroy();
		const startState = EditorState.create({
			doc: initial,
			extensions: [
				history(),
				// ⌘S flushes the autosave now instead of opening the browser's
				// save dialog. Highest precedence so it wins over defaults.
				keymap.of([
					{ key: 'Mod-s', preventDefault: true, run: () => { onSave?.(); return true; } },
					{ key: 'Mod-b', preventDefault: true, run: () => { applyFormat('bold'); return true; } },
					{ key: 'Mod-i', preventDefault: true, run: () => { applyFormat('italic'); return true; } },
					{ key: 'Mod-k', preventDefault: true, run: () => { applyFormat('link'); return true; } },
				]),
				keymap.of([...defaultKeymap, ...historyKeymap]),
				markdown({ extensions: [GFM] }),
				markdownLivePreview,
				sanctuaryTheme,
				EditorView.lineWrapping,
				EditorView.updateListener.of((u) => {
					if (!u.docChanged) return;
					const next = u.state.doc.toString();
					lastEmitted = next;
					onChange?.(next);
				}),
			],
		});
		view = new EditorView({ state: startState, parent: host });
		lastEmitted = initial;
		return () => {
			view?.destroy();
			view = null;
		};
	});

	// External value change (e.g. agent rewrite when not editing) → reconcile
	// into the doc without destroying cursor/scroll, and only when it actually
	// differs from what the editor last emitted.
	$effect(() => {
		const incoming = value;
		if (!view) return;
		if (incoming === lastEmitted) return;
		const current = view.state.doc.toString();
		if (incoming === current) return;
		view.dispatch({
			changes: { from: 0, to: current.length, insert: incoming },
			annotations: [Transaction.addToHistory.of(false)],
		});
		lastEmitted = incoming;
	});

	export function focus() {
		view?.focus();
	}

	// ── Formatting API (toolbar + shortcuts) ──────────────────────────────
	// All edits go through the CM buffer, so they round-trip as literal markdown.

	function wrapSelection(before: string, after: string) {
		if (!view) return;
		const tr = view.state.changeByRange((range) => {
			const text = view!.state.sliceDoc(range.from, range.to);
			const insert = before + text + after;
			// Empty selection → place the cursor between the markers; otherwise
			// keep the original text selected (re-wrappable).
			const anchor = range.from + before.length;
			const head = anchor + text.length;
			return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(anchor, head) };
		});
		view.dispatch(tr);
		view.focus();
	}

	function wrapLink() {
		if (!view) return;
		const tr = view.state.changeByRange((range) => {
			const text = view!.state.sliceDoc(range.from, range.to) || 'text';
			const insert = `[${text}](url)`;
			// Select the "url" placeholder so the user can type it immediately.
			const urlStart = range.from + 1 + text.length + 2;
			return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.range(urlStart, urlStart + 3) };
		});
		view.dispatch(tr);
		view.focus();
	}

	// Toggle a line-level prefix (heading / bullet / quote / task) on every line
	// the selection touches. Removing a heading also clears a different heading
	// level so the buttons feel like a toggle, not an accretion.
	function toggleLinePrefix(prefix: string, group: 'heading' | 'plain' = 'plain') {
		if (!view) return;
		const { state } = view;
		const from = state.doc.lineAt(state.selection.main.from).number;
		const to = state.doc.lineAt(state.selection.main.to).number;
		const changes: { from: number; to?: number; insert: string }[] = [];
		for (let n = from; n <= to; n++) {
			const line = state.doc.line(n);
			if (line.text.startsWith(prefix)) {
				changes.push({ from: line.from, to: line.from + prefix.length, insert: '' });
			} else {
				let cut = 0;
				if (group === 'heading') {
					const m = line.text.match(/^#{1,6}\s/); // strip any existing heading first
					if (m) cut = m[0].length;
				}
				changes.push({ from: line.from, to: line.from + cut, insert: prefix });
			}
		}
		view.dispatch({ changes });
		view.focus();
	}

	export function applyFormat(kind: string) {
		switch (kind) {
			case 'bold': return wrapSelection('**', '**');
			case 'italic': return wrapSelection('*', '*');
			case 'code': return wrapSelection('`', '`');
			case 'strike': return wrapSelection('~~', '~~');
			case 'link': return wrapLink();
			case 'h1': return toggleLinePrefix('# ', 'heading');
			case 'h2': return toggleLinePrefix('## ', 'heading');
			case 'h3': return toggleLinePrefix('### ', 'heading');
			case 'bullet': return toggleLinePrefix('- ');
			case 'number': return toggleLinePrefix('1. ');
			case 'check': return toggleLinePrefix('- [ ] ');
			case 'quote': return toggleLinePrefix('> ');
		}
	}
</script>

<div bind:this={host} class="md-editor" role="textbox" aria-multiline="true" tabindex="0"></div>

<style>
	.md-editor {
		width: 100%;
		min-height: 60vh;
	}
	.md-editor :global(.cm-editor) {
		background: transparent;
	}
</style>
