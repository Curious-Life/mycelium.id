<script lang="ts">
	/**
	 * HonestyBanner — surfaces a metric window's honesty state to the user.
	 *
	 * Renders one of four affordances depending on the classifier output:
	 *   refusal             → muted pill with the contract's refusal copy
	 *   computing_baseline  → amber pill: "honest but not yet calibrated"
	 *   low_sample          → amber pill: "Low sample (N=…) — advisory only"
	 *   available           → renders nothing (parent shows value plainly)
	 *
	 * Pure presentational — does NOT decide which state applies. The parent
	 * computes a `HonestyState` via `classifyHonesty` and passes it in.
	 *
	 * @see honesty.ts for the classifier
	 */

	import type { HonestyState } from './honesty.ts';

	interface Props {
		state: HonestyState;
	}
	const { state }: Props = $props();
</script>

{#if state.kind === 'refusal'}
	<div class="banner refusal" role="status">
		<span class="dot"></span>
		<span class="copy">{state.copy}</span>
	</div>
{:else if state.kind === 'computing_baseline'}
	<div class="banner baseline" role="status">
		<span class="dot"></span>
		<span class="copy">{state.copy}</span>
	</div>
{:else if state.kind === 'low_sample'}
	<div class="banner low-sample" role="status">
		<span class="dot"></span>
		<span class="copy">{state.copy}</span>
	</div>
{/if}

<style>
	.banner {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		padding: 0.35rem 0.7rem;
		border-radius: 999px;
		font-size: 0.78rem;
		line-height: 1.2;
		border: 1px solid currentColor;
		background: transparent;
	}
	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: currentColor;
		flex-shrink: 0;
	}
	.copy {
		color: var(--color-text-secondary, #cbd5e1);
	}
	/* Refusal — muted gray, suggests "not yet" not "broken". */
	.banner.refusal {
		color: #94a3b8;
	}
	.banner.refusal .copy {
		color: #94a3b8;
	}
	/* Computing baseline — amber, the "honest but warming" state. */
	.banner.baseline {
		color: #f59e0b;
	}
	.banner.baseline .copy {
		color: #cbd5e1;
	}
	/* Low sample — also amber, but distinct copy. */
	.banner.low-sample {
		color: #f59e0b;
	}
	.banner.low-sample .copy {
		color: #cbd5e1;
	}
</style>
