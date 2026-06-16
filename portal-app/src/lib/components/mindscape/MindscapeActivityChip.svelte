<script lang="ts">
	// MindscapeActivityChip — a glassy, minimal status indicator that floats in the
	// top-right while the pipeline works (embedding → mapping → describing), so the
	// empty-state never blocks. Reads the shared generate store AND the unified
	// activity feed (per-item background jobs like AI describe/chronicle, with a live
	// ETA). A live background job takes the chip — it's the most granular signal.
	import { onMount } from 'svelte';
	import { generate, start as startGen, fmtSeconds } from '$lib/generate';
	import { activity, startActivityPolling, fmtEta } from '$lib/stores/activity';

	onMount(() => startActivityPolling());

	// Minimize (spec #20): the chip floats over the mindscape, so it must be
	// collapsible. Minimizing keeps the work running (state untouched) and shrinks
	// the chip to its pulsing dot — clicking the dot re-expands it.
	let minimized = $state(false);

	const phase = $derived($generate.phase);
	const job = $derived($activity.active[0] ?? null); // lead background job (e.g. describe)
	const showJob = $derived(!!job && phase !== 'error');
	const genVisible = $derived(phase === 'embedding' || phase === 'starting' || phase === 'running' || phase === 'error' || phase === 'done');
	const visible = $derived(genVisible || !!job);

	const pct = $derived.by(() => {
		if (showJob && job) return job.total > 0 ? Math.round((job.done / job.total) * 100) : 6;
		const g = $generate;
		if (phase === 'embedding') return g.total > 0 ? Math.round((g.embedded / g.total) * 100) : 4;
		if (phase === 'running') return Math.round((g.step / Math.max(1, g.totalSteps)) * 100);
		if (phase === 'done') return 100;
		return 6;
	});

	const label = $derived.by(() => {
		if (showJob && job) return job.total > 0 ? `${job.stage} · ${job.done}/${job.total}` : job.stage;
		const g = $generate;
		switch (phase) {
			case 'embedding': return `Weaving your world · ${g.embedded.toLocaleString()}/${g.total.toLocaleString()}`;
			case 'starting': return 'Starting…';
			case 'running': return g.stageLabel || 'Mapping your mind…';
			case 'done': return 'Your mind is mapped';
			case 'error': return 'Mapping hit a snag';
			default: return '';
		}
	});

	const sub = $derived.by(() => {
		if (showJob && job) return fmtEta(job.etaSeconds) ? `${fmtEta(job.etaSeconds)} left` : '';
		if (phase === 'running' && $generate.etaSeconds != null) return `~${fmtSeconds($generate.etaSeconds)} left`;
		return '';
	});
</script>

{#if visible}
	{#if minimized}
		<!-- Collapsed: just the pulsing dot. Click to re-expand. State is preserved
		     (the pipeline keeps running); this only hides the panel. -->
		<button class="chip-mini" onclick={() => (minimized = false)} title={label} aria-label="Show activity: {label}">
			<span class="dot mini" class:spin={showJob || (phase !== 'error' && phase !== 'done')}></span>
		</button>
	{:else}
		<div class="chip" class:error={phase === 'error' && !showJob} class:done={phase === 'done' && !showJob} role="status" aria-live="polite">
			<span class="dot" class:spin={showJob || (phase !== 'error' && phase !== 'done')}></span>
			<div class="body">
				<span class="label">{label}</span>
				<span class="controls">
					{#if phase === 'error' && !showJob}
						<button class="retry" onclick={() => startGen()}>Retry</button>
					{:else if sub}
						<span class="sub">{sub}</span>
					{/if}
					<button class="min-btn" aria-label="Minimize" title="Minimize" onclick={() => (minimized = true)}>
						<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12" /></svg>
					</button>
				</span>
			</div>
			{#if !(phase === 'error' && !showJob)}
				<div class="bar"><div class="fill" style="width: {Math.max(4, pct)}%"></div></div>
			{/if}
		</div>
	{/if}
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
	.controls { display: inline-flex; align-items: center; gap: 0.4rem; flex-shrink: 0; }
	.min-btn {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.1rem; height: 1.1rem; padding: 0; border: none; border-radius: 5px;
		background: none; color: var(--color-text-tertiary); cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease;
	}
	.min-btn:hover { background: var(--glass-input-border); color: var(--color-text-primary); }

	/* Collapsed state — a single pulsing dot the user can click to re-expand. */
	.chip-mini {
		position: absolute;
		top: 1rem; right: 1rem;
		z-index: 40;
		width: 26px; height: 26px;
		display: inline-flex; align-items: center; justify-content: center;
		padding: 0; border-radius: 50%;
		background: var(--glass-panel-bg);
		backdrop-filter: blur(20px) saturate(140%);
		-webkit-backdrop-filter: blur(20px) saturate(140%);
		border: 1px solid var(--glass-border);
		box-shadow: var(--shadow-md);
		cursor: pointer;
		animation: floatIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.dot.mini { position: static; }
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
