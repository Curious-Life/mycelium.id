<!-- AgentCard — the one card shell every section on the Agents page wears, so the
     page reads as a single surface instead of three styling idioms. -->
<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		title,
		hint = null,
		aside = null,
		loading = false,
		children,
	} = $props<{
		title: string;
		hint?: string | null;
		aside?: Snippet | null;
		loading?: boolean;
		children?: Snippet;
	}>();
</script>

<section class="card">
	<div class="head">
		<h2>{title}</h2>
		{#if aside}<div class="aside">{@render aside()}</div>{/if}
	</div>
	{#if hint}<p class="hint">{hint}</p>{/if}
	{#if loading}
		<div class="skeleton" aria-hidden="true">
			<span></span><span></span><span></span>
		</div>
	{:else}
		{@render children?.()}
	{/if}
</section>

<style>
	.card {
		border: 1px solid var(--color-border);
		border-radius: 14px;
		background: var(--color-surface);
		padding: 0.95rem 1.05rem 1.05rem;
	}
	.head { display: flex; align-items: center; gap: 0.6rem; }
	h2 {
		margin: 0;
		font-size: 0.68rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--color-text-tertiary);
	}
	.aside { margin-left: auto; display: flex; align-items: center; gap: 0.4rem; }
	.hint {
		margin: 0.4rem 0 0;
		font-size: 0.72rem;
		line-height: 1.5;
		color: var(--color-text-tertiary);
	}
	.skeleton { display: flex; flex-direction: column; gap: 0.5rem; margin-top: 0.8rem; }
	.skeleton span {
		height: 0.85rem;
		border-radius: 5px;
		background: var(--color-elevated);
		animation: shimmer 1.4s var(--ease-in-out) infinite;
	}
	.skeleton span:nth-child(2) { width: 78%; animation-delay: 0.12s; }
	.skeleton span:nth-child(3) { width: 54%; animation-delay: 0.24s; }
	@keyframes shimmer { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
	@media (prefers-reduced-motion: reduce) { .skeleton span { animation: none; } }
</style>
