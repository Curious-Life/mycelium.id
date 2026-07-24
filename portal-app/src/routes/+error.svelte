<!--
	+error.svelte — D-023: a 404 (or any routing error) must NOT be a dead end.

	The operator's words: "when there is a 404 not found error, there should be a
	back to home button". Before this file existed the app had NO +error.svelte at
	all, so SvelteKit fell through to its built-in error page: a bare status line
	with no navigation, on a route the app's own shell never wraps. A user who
	mistyped a path — or followed a stale in-app link — was stranded with no way
	back except editing the URL bar.

	This is the QA6 bar applied literally: *every break has a named remedy the user
	can execute*. The remedy here is one button that goes home (/mindscape, the same
	destination the root route redirects to), plus a secondary "go back" for the
	stale-link case where history is the better answer.

	Theme-aware by construction: every colour is a semantic token from tokens.css,
	so it follows the `data-theme` attribute the theme store stamps on <html>
	(the same mechanism D-024 fixes on the character page). No hardcoded hex.
-->
<script lang="ts">
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	// The home destination — the SAME one src/routes/+page.svelte redirects to, so
	// "back to home" and opening the app fresh land in the same place.
	const HOME = '/mindscape';

	const status = $derived($page.status);
	const isNotFound = $derived(status === 404);

	// The error message is the framework's, never vault text — a 404 must not echo
	// a path back as rich content (CLAUDE.md §1: nothing user-derived rendered as
	// anything but plain text). Svelte escapes it; we additionally keep it short.
	const detail = $derived(($page.error?.message || '').slice(0, 200));

	function goHome() { goto(HOME); }
	function goBack() {
		// history.back() only helps when there IS somewhere to go back to. A direct
		// hit on a bad URL has no in-app history, so fall back to home rather than
		// leaving the click inert — a dead button is the defect we are fixing.
		if (typeof history !== 'undefined' && history.length > 1) history.back();
		else goHome();
	}
</script>

<svelte:head>
	<title>{isNotFound ? 'Page not found' : 'Something went wrong'} · Mycelium</title>
</svelte:head>

<div class="err-page" data-testid="error-page" data-status={status}>
	<div class="err-card" role="alert">
		<p class="err-status">{status}</p>
		<h1 class="err-title">
			{#if isNotFound}Page not found{:else}Something went wrong{/if}
		</h1>
		<p class="err-body">
			{#if isNotFound}
				That page isn’t part of your vault. It may have moved, or the link may be out of date.
			{:else}
				The app hit an error loading this page. Your vault is untouched — nothing was written.
			{/if}
		</p>
		{#if detail && !isNotFound}
			<p class="err-detail">{detail}</p>
		{/if}

		<!-- THE REMEDY (D-023). `data-testid` is the gate's handle on the button. -->
		<div class="err-actions">
			<button type="button" class="err-primary" data-testid="error-home" onclick={goHome}>
				Back to home
			</button>
			<button type="button" class="err-secondary" data-testid="error-back" onclick={goBack}>
				Go back
			</button>
		</div>
	</div>
</div>

<style>
	/* Every colour is a semantic token → the page follows data-theme automatically
	   (light and dark), which is the whole point of D-024's sibling fix. */
	.err-page {
		min-height: 100vh;
		display: flex; align-items: center; justify-content: center;
		padding: 2rem 1.25rem;
		background: var(--color-bg);
		color: var(--color-text-primary);
	}
	.err-card {
		width: 100%; max-width: 26rem; text-align: center;
		display: flex; flex-direction: column; gap: 0.6rem;
	}
	.err-status {
		margin: 0; font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.72rem; letter-spacing: 0.18em;
		color: var(--color-text-tertiary);
	}
	.err-title { margin: 0; font-size: 1.35rem; font-weight: 600; color: var(--color-text-emphasis); }
	.err-body { margin: 0; font-size: 0.85rem; line-height: 1.55; color: var(--color-text-secondary); }
	.err-detail {
		margin: 0.2rem 0 0; font-size: 0.72rem; line-height: 1.5;
		color: var(--color-text-tertiary); word-break: break-word;
	}
	.err-actions {
		display: flex; gap: 0.6rem; justify-content: center; flex-wrap: wrap;
		margin-top: 0.9rem;
	}
	.err-primary, .err-secondary {
		padding: 0.5rem 1.1rem; border-radius: 0.5rem;
		font: inherit; font-size: 0.82rem; font-weight: 500; cursor: pointer;
		transition: opacity 0.15s, border-color 0.15s, color 0.15s;
	}
	.err-primary {
		border: 1px solid transparent;
		background: var(--color-accent); color: var(--color-bg);
	}
	.err-primary:hover { opacity: 0.9; }
	.err-secondary {
		border: 1px solid var(--color-border);
		background: transparent; color: var(--color-text-secondary);
	}
	.err-secondary:hover { color: var(--color-text-primary); border-color: var(--color-accent); }
	.err-primary:focus-visible, .err-secondary:focus-visible {
		outline: 2px solid var(--color-focus-ring); outline-offset: 2px;
	}
</style>
