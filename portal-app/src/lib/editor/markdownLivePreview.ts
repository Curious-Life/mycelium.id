/**
 * Live-preview decorations for CodeMirror 6 + Lezer markdown.
 *
 * The buffer is ALWAYS literal markdown — decorations are display-only, so
 * `view.state.doc.toString()` is byte-identical to what was typed/loaded. We
 * never mutate the document, which is what makes this engine safe for a vault
 * where an AI agent writes the same markdown (no doc-model re-serialization).
 *
 * Two moves per syntactic construct:
 *   1. hide the syntax markers (`**`, `#`, `>`, backticks, link URL) with a
 *      `Decoration.replace` — UNLESS the cursor/selection is inside the node,
 *      in which case the markers reveal so you can edit them.
 *   2. apply a formatting class to the content range (bold, heading size, …).
 */
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { type Range } from '@codemirror/state';

const hideMark = Decoration.replace({});

// Interactive task checkbox — replaces the `[ ]` / `[x]` source marker. Clicking
// toggles the marker in the buffer (which flows through onChange → autosave). The
// document stays literal markdown; this is display + a source edit, never a model.
class TaskCheckboxWidget extends WidgetType {
	constructor(readonly checked: boolean, readonly from: number, readonly to: number) { super(); }
	eq(other: TaskCheckboxWidget) { return other.checked === this.checked && other.from === this.from; }
	toDOM(view: EditorView): HTMLElement {
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.checked = this.checked;
		box.className = 'cm-md-task';
		box.setAttribute('aria-label', 'Toggle task');
		// mousedown preventDefault keeps the editor selection from collapsing onto
		// the widget; click toggles the underlying `[ ]`/`[x]`.
		box.addEventListener('mousedown', (e) => e.preventDefault());
		box.addEventListener('click', (e) => {
			e.preventDefault();
			view.dispatch({ changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' } });
		});
		return box;
	}
	ignoreEvent() { return false; }
}

const fmt = {
	strong: Decoration.mark({ class: 'cm-md-strong' }),
	em: Decoration.mark({ class: 'cm-md-em' }),
	strike: Decoration.mark({ class: 'cm-md-strike' }),
	code: Decoration.mark({ class: 'cm-md-code' }),
	link: Decoration.mark({ class: 'cm-md-link' }),
	h1: Decoration.mark({ class: 'cm-md-h1' }),
	h2: Decoration.mark({ class: 'cm-md-h2' }),
	h3: Decoration.mark({ class: 'cm-md-h3' }),
	h4: Decoration.mark({ class: 'cm-md-h4' }),
};
const quoteLine = Decoration.line({ class: 'cm-md-quote-line' });

const HEADING_FMT: Record<string, typeof fmt.h1> = {
	ATXHeading1: fmt.h1,
	ATXHeading2: fmt.h2,
	ATXHeading3: fmt.h3,
	ATXHeading4: fmt.h4,
	ATXHeading5: fmt.h4,
	ATXHeading6: fmt.h4,
};

function buildDecorations(view: EditorView): DecorationSet {
	const marks: Range<Decoration>[] = [];
	const lineDecos: Range<Decoration>[] = [];
	const sel = view.state.selection;

	// A node is "active" (markers revealed) when any selection range touches it.
	const active = (from: number, to: number) =>
		sel.ranges.some((r) => r.from <= to && r.to >= from);

	for (const { from, to } of view.visibleRanges) {
		syntaxTree(view.state).iterate({
			from,
			to,
			enter: (node) => {
				const name = node.name;

				if (HEADING_FMT[name]) {
					marks.push(HEADING_FMT[name].range(node.from, node.to));
					return;
				}
				if (name === 'HeaderMark') {
					// `#` markers — hide (plus the trailing space) unless editing the line.
					if (!active(node.from - 1, node.to + 1)) {
						const end = Math.min(node.to + 1, view.state.doc.length);
						marks.push(hideMark.range(node.from, end));
					}
					return;
				}
				if (name === 'StrongEmphasis') { marks.push(fmt.strong.range(node.from, node.to)); return; }
				if (name === 'Emphasis') { marks.push(fmt.em.range(node.from, node.to)); return; }
				if (name === 'Strikethrough') { marks.push(fmt.strike.range(node.from, node.to)); return; }
				if (name === 'InlineCode') { marks.push(fmt.code.range(node.from, node.to)); return; }
				if (name === 'EmphasisMark' || name === 'StrikethroughMark' || name === 'CodeMark') {
					const parent = node.node.parent;
					if (parent && !active(parent.from, parent.to)) marks.push(hideMark.range(node.from, node.to));
					return;
				}
				if (name === 'Blockquote') {
					const line = view.state.doc.lineAt(node.from);
					lineDecos.push(quoteLine.range(line.from));
					return;
				}
				if (name === 'QuoteMark') {
					if (!active(node.from, node.to + 1)) {
						const end = Math.min(node.to + 1, view.state.doc.length);
						marks.push(hideMark.range(node.from, end));
					}
					return;
				}
				if (name === 'TaskMarker') {
					// `[ ]` / `[x]` → an interactive checkbox (always shown, even
					// with the cursor on the line — toggling is by click).
					const text = view.state.doc.sliceString(node.from, node.to);
					const checked = /\[[xX]\]/.test(text);
					marks.push(
						Decoration.replace({ widget: new TaskCheckboxWidget(checked, node.from, node.to) }).range(node.from, node.to),
					);
					return;
				}
				if (name === 'ListMark') {
					// Hide the bullet only for task items — the checkbox stands in
					// for it. Plain-list bullets are left as-is.
					const parent = node.node.parent;
					if (parent && parent.name === 'ListItem' && parent.getChild('Task')) {
						const end = Math.min(node.to + 1, view.state.doc.length);
						marks.push(hideMark.range(node.from, end));
					}
					return;
				}
				if (name === 'Link') { marks.push(fmt.link.range(node.from, node.to)); return; }
				if (name === 'LinkMark') {
					const parent = node.node.parent;
					if (parent && !active(parent.from, parent.to)) marks.push(hideMark.range(node.from, node.to));
					return;
				}
				if (name === 'URL') {
					const parent = node.node.parent;
					if (parent && parent.name === 'Link' && !active(parent.from, parent.to)) {
						marks.push(hideMark.range(node.from, node.to));
					}
					return;
				}
			},
		});
	}

	// RangeSet requires ascending order; line decorations sort before marks at
	// the same position (startSide), so merge into one sorted array.
	const all = [...lineDecos, ...marks].sort(
		(a, b) => a.from - b.from || a.value.startSide - b.value.startSide,
	);
	return Decoration.set(all, true);
}

export const markdownLivePreview = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildDecorations(view);
		}
		update(u: ViewUpdate) {
			if (u.docChanged || u.selectionSet || u.viewportChanged) {
				this.decorations = buildDecorations(u.view);
			}
		}
	},
	{ decorations: (v) => v.decorations },
);
