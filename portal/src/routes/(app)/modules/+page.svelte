<script lang="ts">
	import { goto } from '$app/navigation';
	import { navigationState } from '$lib/stores/navigation';

	interface Module {
		id: string;
		name: string;
		desc: string;
		status: 'active' | 'coming_soon';
		href: string;
		icon: string;
		features: string[];
	}

	const modules: Module[] = [
		{
			id: 'wealth',
			name: 'Wealth',
			desc: 'Portfolio tracking, transactions, performance analysis across stocks, crypto, and real assets.',
			status: 'active',
			href: '/wealth',
			icon: 'wealth',
			features: ['Multi-portfolio management', 'Transaction history', 'Performance snapshots', 'Watchlists & alerts'],
		},
		{
			id: 'intel',
			name: 'Intel',
			desc: 'Geopolitical intelligence, prediction markets, strategic analysis, and situation reports.',
			status: 'active',
			href: '/intel',
			icon: 'intel',
			features: ['Situation reports', 'Prediction markets', 'Strategic map', 'Signal monitoring'],
		},
		{
			id: 'health',
			name: 'Health',
			desc: 'Apple Health integration — sleep, HRV, activity, and wellness trends synced from your devices.',
			status: 'coming_soon',
			href: '',
			icon: 'health',
			features: ['Sleep analysis', 'HRV tracking', 'Activity metrics', 'Wellness trends'],
		},
		{
			id: 'publishing',
			name: 'Publishing',
			desc: 'Write, edit, and publish content with AI assistance. Blog posts, newsletters, and long-form.',
			status: 'coming_soon',
			href: '',
			icon: 'publishing',
			features: ['AI-assisted writing', 'Newsletter drafts', 'Content calendar', 'Publishing pipeline'],
		},
	];

	function openModule(mod: Module) {
		if (mod.status !== 'active') return;
		navigationState.setPrimaryView(mod.id as any);
		goto(mod.href);
	}
</script>

<svelte:head>
	<title>Modules - Mycelium</title>
</svelte:head>

<div class="max-w-2xl mx-auto px-8 py-8">
	<h1 class="text-xl font-medium text-[var(--color-text-emphasis)] mb-1">Modules</h1>
	<p class="text-sm text-[var(--color-text-secondary)] mb-8">Extend your vault with specialized capabilities</p>

	<div class="grid gap-4">
		{#each modules as mod}
			<button
				class="module-card"
				class:active={mod.status === 'active'}
				class:coming={mod.status === 'coming_soon'}
				onclick={() => openModule(mod)}
				disabled={mod.status === 'coming_soon'}
			>
				<div class="module-header">
					<div class="module-icon">
						{#if mod.icon === 'wealth'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
							</svg>
						{:else if mod.icon === 'intel'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.73-3.56" />
							</svg>
						{:else if mod.icon === 'health'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
							</svg>
						{:else if mod.icon === 'publishing'}
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
							</svg>
						{/if}
					</div>
					<div class="module-title-row">
						<h2 class="module-name">{mod.name}</h2>
						{#if mod.status === 'active'}
							<span class="badge active">Active</span>
						{:else}
							<span class="badge coming">Coming soon</span>
						{/if}
					</div>
				</div>
				<p class="module-desc">{mod.desc}</p>
				<div class="module-features">
					{#each mod.features as feature}
						<span class="feature-tag">{feature}</span>
					{/each}
				</div>
				{#if mod.status === 'active'}
					<div class="module-action">Open {mod.name} &rarr;</div>
				{/if}
			</button>
		{/each}
	</div>
</div>

<style>
	.module-card {
		display: block;
		width: 100%;
		text-align: left;
		padding: 1.25rem;
		border-radius: var(--radius-lg, 12px);
		border: 1px solid var(--color-border);
		background: var(--color-surface);
		transition: border-color 0.15s, background 0.15s;
	}
	.module-card.active {
		cursor: pointer;
	}
	.module-card.active:hover {
		border-color: var(--color-accent-aurum, #E5B84C);
		background: var(--color-elevated);
	}
	.module-card.coming {
		opacity: 0.6;
		cursor: default;
	}

	.module-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}
	.module-icon {
		width: 2rem;
		height: 2rem;
		padding: 0.35rem;
		border-radius: var(--radius-md, 8px);
		background: var(--color-elevated);
		color: var(--color-text-secondary);
		flex-shrink: 0;
	}
	.module-card.active .module-icon {
		background: var(--color-accent-aurum, #E5B84C);
		color: var(--color-bg);
	}
	.module-icon :global(svg) {
		width: 100%;
		height: 100%;
	}
	.module-title-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.module-name {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--color-text-emphasis);
	}
	.badge {
		font-size: 0.6rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
	}
	.badge.active {
		background: var(--color-accent-jade, #10B981);
		color: #fff;
	}
	.badge.coming {
		background: var(--color-elevated);
		color: var(--color-text-tertiary);
	}

	.module-desc {
		font-size: 0.8rem;
		color: var(--color-text-secondary);
		line-height: 1.5;
		margin-bottom: 0.75rem;
	}

	.module-features {
		display: flex;
		flex-wrap: wrap;
		gap: 0.35rem;
		margin-bottom: 0.5rem;
	}
	.feature-tag {
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		background: var(--color-elevated);
		padding: 0.2rem 0.5rem;
		border-radius: 999px;
	}

	.module-action {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--color-accent-aurum, #E5B84C);
		margin-top: 0.25rem;
	}
</style>
