<script lang="ts">
	// MindscapeActivityChip — a glassy, minimal status indicator that floats in the
	// top-right while the pipeline works (embedding → mapping), so the empty-state
	// never blocks. Reads the shared generate store; offers a quiet retry on error.
	import { generate, start as startGen, fmtSeconds } from '$lib/generate';

	const phase = $derived($generate.phase);
	const visible = $derived(phase === 'embedding' || phase === 'starting' || phase === 'running' || phase === 'error' || phase === 'done');

	const pct = $derived.by(() => {
		const g = $generate;
		if (phase === 'embedding') return g.total > 0 ? Math.round((g.embedded / g.total) * 100) : 4;
		if (phase === 'running') return Math.round((g.step / Math.max(1, g.totalSteps)) * 100);
		if (phase === 'done') return 100;
		return 6;
	});

	const label = $derived.by(() => {
		const g = $generate;
		switch (phase) {
			case 'embedding': return `Reading your world · ${g.embedded.toLocaleString()}/${g.total.toLocaleString()}`;
			case 'starting': return 'Starting…';
			case 'running': return g.stageLabel || 'Mapping your mind…';
			case 'done': return 'Your mind is mapped';
			case 'error': return 'Mapping hit a snag';
			default: return '';
		}
	});
</script>

{#if visible}
	<div class="chip" class:error={phase === 'error'} class:done={phase === 'done'} role="status" aria-live="polite">
		<span class="dot" class:spin={phase !== 'error' && phase !== 'done'}></span>
		<div class="body">
			<span class="label">{label}</span>
			{#if phase === 'error'}
				<button class="retry" onclick={() => startGen()}>Retry</button>
			{:else if phase === 'running' && $generate.etaSeconds != null}
				<span class="sub">~{fmtSeconds($generate.etaSeconds)} left</span>
			{/if}
		</div>
		{#if phase !== 'error'}
			<div class="bar"><div class="fill" style="width: {Math.max(4, pct)}%"></div></div>
		{/if}
	</div>
{/if}

<style>
	.chip {
		position: absolute;
		top: 1rem;
		right: 1rem;
		z-index: 40;
		min-width: 220px;
		max-width: 300px;
		padding: 0.6rem 0.8rem 0.7rem;
		background: var(--glass-panel-bg);
		backdrop-filter: blur(20px) saturate(140%);
		-webkit-backdrop-filter: blur(20px) saturate(140%);
		border: 1px solid var(--glass-border);
		border-radius: 12px;
		box-shadow: var(--shadow-md);
		/* Float in organically — drift up + in from the corner, settle gently. */
		animation: floatIn 0.55s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.chip.error { border-color: rgba(248, 113, 113, 0.35); }
	.chip.done { border-color: rgba(74, 222, 128, 0.35); }
	.body { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
	.dot {
		position: absolute;
		top: 0.7rem; left: 0.8rem;
		width: 7px; height: 7px; border-radius: 50%;
		background: var(--color-accent-aurum, #e5b84c);
	}
	.chip.error .dot { background: #f87171; }
	.chip.done .dot { background: #4ade80; }
	.dot.spin { animation: pulse 1.4s ease-in-out infinite; }
	.label {
		display: block;
		margin-left: 1rem;
		font-size: 0.76rem;
		color: var(--color-text-primary);
		line-height: 1.3;
	}
	.sub { font-size: 0.66rem; color: var(--color-text-tertiary); white-space: nowrap; }
	.retry {
		background: none; border: 1px solid rgba(248, 113, 113, 0.4); color: #f87171;
		font-size: 0.66rem; padding: 2px 8px; border-radius: 6px; cursor: pointer; font-family: inherit;
	}
	.retry:hover { background: rgba(248, 113, 113, 0.1); }
	.bar { height: 3px; border-radius: 2px; background: var(--glass-input-border); overflow: hidden; margin: 0.5rem 0 0 1rem; }
	.fill { height: 100%; background: var(--color-accent-aurum, #e5b84c); border-radius: 2px; transition: width 0.6s ease; }
	.chip.done .fill { background: #4ade80; }

	@keyframes floatIn {
		from { opacity: 0; transform: translate(14px, 10px) scale(0.96); }
		to { opacity: 1; transform: translate(0, 0) scale(1); }
	}
	@keyframes pulse {
		0%, 100% { opacity: 0.4; transform: scale(0.8); }
		50% { opacity: 1; transform: scale(1.15); }
	}
</style>
