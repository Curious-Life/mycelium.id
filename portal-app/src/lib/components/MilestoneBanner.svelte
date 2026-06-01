<script lang="ts">
	/**
	 * Milestone banner — global alert surface for Fisher trajectory milestones.
	 *
	 * Mounted in (app)/+layout.svelte so it shows on every authenticated portal
	 * page. Reads from /portal/trajectory/milestones (Phase 4 endpoint) and
	 * renders the newest active milestone's headline. Dismiss POSTs to
	 * /portal/trajectory/milestones/:id/dismiss and removes the row locally.
	 *
	 * If multiple milestones are active, rotates through them on a 12s timer.
	 *
	 * Failure-quiet: a Fisher pipeline outage just hides the banner.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { api } from '$lib/api';

	let milestones = $state<any[]>([]);
	let activeIdx = $state(0);
	let rotateTimer: ReturnType<typeof setInterval> | null = null;

	const ROTATE_MS = 12_000;
	const POLL_MS = 60_000; // refresh every minute (cheap query)

	let pollTimer: ReturnType<typeof setInterval> | null = null;

	async function fetchMilestones() {
		try {
			const res = await api('/portal/trajectory/milestones?limit=10');
			if (res.ok) {
				const j = await res.json();
				const next = j.milestones || [];
				// Don't reset activeIdx if the head of the list is unchanged.
				const headChanged = !milestones.length || milestones[0]?.id !== next[0]?.id;
				milestones = next;
				if (headChanged) activeIdx = 0;
			}
		} catch {
			/* silent — don't block the layout on a Fisher outage */
		}
	}

	function startRotation() {
		if (rotateTimer) clearInterval(rotateTimer);
		rotateTimer = setInterval(() => {
			if (milestones.length > 1) {
				activeIdx = (activeIdx + 1) % milestones.length;
			}
		}, ROTATE_MS);
	}

	async function dismiss(id: string) {
		try {
			await api(`/portal/trajectory/milestones/${id}/dismiss`, { method: 'POST' });
		} catch {
			/* silent */
		}
		// Remove locally regardless of network outcome — best-effort UX.
		milestones = milestones.filter((m) => m.id !== id);
		if (activeIdx >= milestones.length) activeIdx = 0;
	}

	onMount(() => {
		if (!browser) return;
		fetchMilestones();
		startRotation();
		pollTimer = setInterval(fetchMilestones, POLL_MS);
	});

	onDestroy(() => {
		if (rotateTimer) clearInterval(rotateTimer);
		if (pollTimer) clearInterval(pollTimer);
	});

	const active = $derived(milestones.length > 0 ? milestones[activeIdx] || milestones[0] : null);
</script>

{#if active}
	<div
		class="milestone-banner"
		role="status"
		aria-live="polite"
		data-rule={active.rule_type}
	>
		<a class="banner-link" href="/vitality" aria-label="View vitality details">
			<span class="banner-rule">{active.rule_type.replace(/_/g, ' ')}</span>
			<span class="banner-headline">{active.headline}</span>
		</a>
		{#if milestones.length > 1}
			<span class="banner-count" title="{milestones.length} active milestones">
				{activeIdx + 1}/{milestones.length}
			</span>
		{/if}
		<button
			class="banner-dismiss"
			onclick={() => dismiss(active.id)}
			aria-label="Dismiss milestone"
			title="Dismiss"
		>×</button>
	</div>
{/if}

<style>
	.milestone-banner {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 1rem;
		background: linear-gradient(90deg, rgba(229,184,76,0.08), rgba(229,184,76,0.02));
		border-bottom: 1px solid rgba(229,184,76,0.25);
		font-size: 0.8rem;
		flex-shrink: 0;
	}
	.banner-link {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex: 1;
		min-width: 0;
		text-decoration: none;
		color: var(--color-text-primary);
	}
	.banner-link:hover { color: var(--color-accent); }
	.banner-rule {
		font-size: 0.6rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--color-accent);
		padding: 0.15rem 0.5rem;
		border: 1px solid var(--color-accent);
		border-radius: 999px;
		flex-shrink: 0;
		white-space: nowrap;
	}
	.banner-headline {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.banner-count {
		font-family: var(--font-mono);
		font-size: 0.65rem;
		color: var(--color-text-tertiary);
		flex-shrink: 0;
	}
	.banner-dismiss {
		background: none;
		border: none;
		color: var(--color-text-tertiary);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 4px;
		flex-shrink: 0;
	}
	.banner-dismiss:hover { color: var(--color-text-primary); }

	/* Mobile: tighter banner, drop the count indicator if space-constrained. */
	@media (max-width: 640px) {
		.milestone-banner {
			padding: 0.4rem 0.6rem;
			font-size: 0.7rem;
			gap: 0.5rem;
		}
		.banner-rule {
			font-size: 0.55rem;
			padding: 0.1rem 0.4rem;
		}
		.banner-count { display: none; }
	}
</style>
