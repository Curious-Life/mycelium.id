<script lang="ts">
	/**
	 * ContractsHover — on-demand overlay surfacing a metric family's
	 * presentation contract: science-honesty footnote + the
	 * "agent_must_not_say" negative constraints. Designed to sit next
	 * to a metric card's title so the operator can audit what the
	 * portal is allowed to claim about this metric.
	 *
	 * Lazy: contract is fetched the first time the user opens the
	 * popover. Failure-quiet — if the contract endpoint errors, the
	 * popover renders a neutral "contract unavailable" line so the
	 * card still shows its value (per design D-WS-1 edge-case rule).
	 *
	 * @see client.ts fetchContract
	 */

	import { fetchContract, type ContractResponse, type MetricFamily } from './client.ts';

	interface Props {
		family: MetricFamily;
	}
	const { family }: Props = $props();

	let open = $state(false);
	let loading = $state(false);
	let loadFailed = $state(false);
	let contract = $state<ContractResponse | null>(null);

	async function ensureLoaded() {
		if (contract || loading) return;
		loading = true;
		try {
			contract = await fetchContract(family);
		} catch {
			loadFailed = true;
		} finally {
			loading = false;
		}
	}

	function toggle() {
		open = !open;
		if (open) ensureLoaded();
	}

	function close() {
		open = false;
	}
</script>

<span class="hover-root">
	<button
		type="button"
		class="trigger"
		aria-expanded={open}
		aria-label="Show science-honesty contract for {family}"
		onclick={toggle}
	>
		ⓘ
	</button>

	{#if open}
		<div class="overlay" role="dialog" aria-label="Presentation contract">
			<div class="overlay-head">
				<h4>How this metric should be read</h4>
				<button type="button" class="close" aria-label="Close" onclick={close}>×</button>
			</div>

			{#if loading}
				<p class="muted">Loading contract…</p>
			{:else if loadFailed}
				<p class="muted">Contract unavailable. The metric value is still honest; the contextual disclaimer just hasn't loaded.</p>
			{:else if contract}
				<p class="footnote">{contract.contract.science_honesty_footnote}</p>

				{#if contract.contract.agent_must_not_say.length > 0}
					<h5>What the agent must not say</h5>
					<ul class="must-not">
						{#each contract.contract.agent_must_not_say as item (item)}
							<li>{item}</li>
						{/each}
					</ul>
				{/if}

				<p class="cite">
					{contract.spec_ref} · contract {contract.contract_version}
				</p>
			{/if}
		</div>
	{/if}
</span>

<style>
	.hover-root {
		position: relative;
		display: inline-block;
	}
	.trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.1rem;
		height: 1.1rem;
		padding: 0;
		font-size: 0.85rem;
		line-height: 1;
		border: 1px solid #2a2f3a;
		border-radius: 50%;
		background: transparent;
		color: #94a3b8;
		cursor: pointer;
	}
	.trigger:hover {
		color: #cbd5e1;
		border-color: #475569;
	}
	.overlay {
		position: absolute;
		z-index: 50;
		top: 1.6rem;
		left: 0;
		min-width: 320px;
		max-width: 440px;
		padding: 0.9rem 1rem;
		background: #11131a;
		border: 1px solid #2a2f3a;
		border-radius: 8px;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		color: #cbd5e1;
		font-size: 0.82rem;
		line-height: 1.45;
	}
	.overlay-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
	}
	.overlay h4 {
		margin: 0;
		font-size: 0.85rem;
		color: #f1f5f9;
	}
	.close {
		background: transparent;
		border: none;
		color: #94a3b8;
		font-size: 1rem;
		cursor: pointer;
		padding: 0 0.2rem;
	}
	.close:hover {
		color: #cbd5e1;
	}
	.overlay h5 {
		margin: 0.7rem 0 0.3rem 0;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #94a3b8;
	}
	.footnote {
		margin: 0;
		color: #cbd5e1;
	}
	.must-not {
		list-style: disc;
		padding-left: 1.1rem;
		margin: 0;
		color: #94a3b8;
	}
	.must-not li {
		margin-bottom: 0.2rem;
	}
	.cite {
		margin: 0.7rem 0 0 0;
		padding-top: 0.5rem;
		border-top: 1px solid #1c1f28;
		font-size: 0.7rem;
		color: #64748b;
		font-family: ui-monospace, monospace;
	}
	.muted {
		margin: 0;
		color: #94a3b8;
		font-style: italic;
	}
</style>
