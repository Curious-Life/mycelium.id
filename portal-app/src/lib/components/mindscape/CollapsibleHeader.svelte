<script lang="ts">
	/**
	 * CollapsibleHeader — THE one expand/collapse header in the mindscape rail (D-067).
	 *
	 * THE DEFECT: the pipeline-status card's disclosure was a lone 0.6rem caret glyph pinned to
	 * the right edge (`button.pipe-toggle`, ~10×10 CSS px). The operator: "only a small dot is
	 * clickable to collapse the pipeline status; the whole section should be clickable like the
	 * live process indicator."
	 *
	 * THE PATTERN, taken from the live process indicator rather than invented here:
	 * `StatusPopover.svelte`'s vault-pill (`.vault-pill`, :320-343) makes the ENTIRE summary line
	 * one `<button>` carrying `aria-expanded`, with the caret as a decorative `aria-hidden` span
	 * INSIDE it. The caret is a hint, never the hit target. This component is that markup,
	 * extracted once so the rail cannot grow a second, divergent notion of "collapse".
	 *
	 * ⚠️ HEADER, NOT WHOLE CARD — deliberate, and the reason this is a header component rather
	 * than a wrapper. The pipeline card's body carries real controls (`button.pipe-action`,
	 * `button.pipe-ctrl` pause/restart). A button wrapped around the whole card would (a) nest
	 * interactive elements, which is invalid HTML and collapses keyboard semantics, and (b)
	 * swallow or double-fire clicks aimed at those controls. The hit target is the full width of
	 * the header row — which is what "the whole section" means for a disclosure — and stops
	 * exactly where the section's own controls begin.
	 *
	 * `extraClass` is a SELECTOR HOOK, not styling: Svelte scopes a parent's CSS to the parent's
	 * own markup, so a class passed in here carries no parent rules. Parents pass the class names
	 * their gates/harnesses query (`.pipe-overall`, `.pipe-toggle`) and style the CONTENT they
	 * pass as children, which stays inside their own scope.
	 */
	import type { Snippet } from 'svelte';

	let {
		expanded = $bindable(false),
		label,
		testid,
		extraClass = '',
		children,
	}: {
		/** Two-way: the parent owns the state so it can force-open on an unsettled/urgent state. */
		expanded?: boolean;
		/** Bare noun phrase — the `title` hint ("Show <label>" / "Hide <label>"). NOT an aria-label; see below. */
		label: string;
		testid?: string;
		/** Selector hook for gates/harnesses. Not a styling channel (see above). */
		extraClass?: string;
		children: Snippet;
	} = $props();
</script>

<!--
	⚠️ NO `aria-label` HERE — deliberate, and it was a real bug for one review round.
	`aria-label` is name-from-author: it REPLACES the element's contents in the accessible name.
	Putting "Show pipeline stages" on this button therefore *deleted* "Your pipeline is up to date."
	from what a screen reader announces — and, because `.pipe` carries `role="status"`, from the
	live-region text as well. The whole point of D-067 is that the status line and the control are
	now one element; an aria-label makes them one element that no longer says the status.
	The precedent does it correctly: `StatusPopover.svelte`'s `.vault-pill` has NO aria-label — its
	name is its content, plus a `title` hint. This mirrors that exactly. `aria-expanded` already
	conveys collapsed/expanded to AT, so no verb is needed in the name.
-->
<button
	type="button"
	class="collapsible-header {extraClass}"
	data-testid={testid}
	data-collapsible-header="1"
	aria-expanded={expanded}
	title={expanded ? `Hide ${label}` : `Show ${label}`}
	onclick={() => (expanded = !expanded)}
>
	<span class="ch-body">{@render children()}</span>
	<span class="ch-caret" aria-hidden="true">{expanded ? '▴' : '▾'}</span>
</button>

<style>
	/* The hit area IS the row: full width, its own padding, no inherited button chrome.
	   `width: 100%` + `display: flex` is what turns "a caret you must hit" into "the header". */
	.collapsible-header {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		/* A comfortable target even when the label is one short line (WCAG 2.5.8 is 24px). */
		min-height: 1.6rem;
	}
	.collapsible-header:hover .ch-caret {
		color: var(--color-text-secondary);
	}
	.collapsible-header:focus-visible {
		outline: 2px solid var(--color-accent-aurum, #e5b84c);
		outline-offset: 2px;
		border-radius: 6px;
	}
	.ch-body {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		flex: 1;
		min-width: 0;
	}
	/* Decorative only — `aria-hidden` in the markup, and never the hit target. */
	.ch-caret {
		flex-shrink: 0;
		margin-left: auto;
		font-size: 0.6rem;
		line-height: 1;
		color: var(--color-text-tertiary);
	}
</style>
