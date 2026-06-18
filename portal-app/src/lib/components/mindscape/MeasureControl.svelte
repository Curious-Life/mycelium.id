<script lang="ts">
	// MeasureControl — refresh the analysis/measurement layer on the EXISTING mindscape
	// (no re-cluster, no narration), bound to the measure-only backend:
	//   POST /portal/mycelium/measure                 → { jobId, status }
	//   GET  /portal/mycelium/generate/status/:jobId   → { status, step, totalSteps, stageLabel, error }
	// Non-destructive + kill-switch-exempt, so this stays available even while Generate
	// is locked. Refreshes vitality/phase, co-firing, neighbours, coherence, fisher, etc.
	import { onDestroy } from 'svelte';
	import { apiGet, apiPost } from '$lib/api';

	type Status = { status: 'running' | 'done' | 'error' | 'canceled'; step: number; totalSteps: number; stageLabel?: string; error?: string | null };

	let jobId = $state<string | null>(null);
	let st = $state<Status | null>(null);
	let busy = $state(false);
	let poll: ReturnType<typeof setInterval> | null = null;

	const running = $derived(st?.status === 'running');
	const pct = $derived(st && st.totalSteps > 0 ? Math.min(100, Math.round((100 * st.step) / st.totalSteps)) : 0);

	function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
	async function refresh() {
		if (!jobId) return;
		try {
			st = await apiGet<Status>(`/portal/mycelium/generate/status/${jobId}`);
			if (st && st.status !== 'running') stopPoll();
		} catch { /* transient */ }
	}
	async function start() {
		busy = true;
		try {
			const r = await apiPost<{ jobId?: string; status?: string }>('/portal/mycelium/measure', {});
			if (r?.jobId) { jobId = r.jobId; st = { status: 'running', step: 0, totalSteps: 16, stageLabel: 'Refreshing analysis' }; stopPoll(); poll = setInterval(refresh, 2500); }
		} catch { /* surfaced via status */ } finally { busy = false; }
	}

	onDestroy(stopPoll);
</script>

<div class="measure">
	<div class="row">
		<span class="title">Refresh analysis</span>
		{#if st}<span class="status status-{st.status}">{st.status}</span>{/if}
	</div>
	<p class="hint">Recompute vitality, co-firing, coherence &amp; movement on the current map — no re-cluster, no renaming.</p>
	{#if running}
		<div class="bar"><div class="fill" style="width:{pct}%"></div></div>
		<div class="step">{st?.stageLabel || 'Working'} · step {st?.step}/{st?.totalSteps}</div>
	{:else if st?.status === 'error'}
		<div class="err">{st.error || 'failed'}</div>
	{/if}
	<div class="actions">
		<button onclick={start} disabled={busy || running}>{running ? 'Refreshing…' : 'Refresh analysis'}</button>
	</div>
</div>

<style>
	.measure { display: flex; flex-direction: column; gap: 0.45rem; padding: 0.75rem; border: 1px solid rgba(255,255,255,0.08); border-radius: var(--radius-md, 10px); background: rgba(255,255,255,0.03); }
	.row { display: flex; align-items: center; justify-content: space-between; }
	.title { font-weight: 600; font-size: 0.9rem; color: var(--color-text-primary); }
	.hint { margin: 0; font-size: 0.7rem; color: var(--color-text-tertiary); line-height: 1.35; }
	.status { font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 999px; text-transform: capitalize; }
	.status-running { color: #4ade80; background: rgba(74,222,128,0.12); }
	.status-done { color: #7DB6D9; background: rgba(125,182,217,0.15); }
	.status-error, .status-canceled { color: #94a3b8; background: rgba(148,163,184,0.12); }
	.bar { height: 5px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
	.fill { height: 100%; background: var(--color-accent, #E5B84C); transition: width 0.4s ease; }
	.step { font-size: 0.72rem; color: var(--color-text-secondary); }
	.err { font-size: 0.7rem; color: #f87171; }
	.actions { display: flex; gap: 0.5rem; }
	button { font-size: 0.8rem; padding: 0.35rem 0.9rem; border-radius: var(--radius-full, 999px); border: 1px solid var(--color-accent, #E5B84C); background: var(--color-accent, #E5B84C); color: var(--color-bg, #111); cursor: pointer; }
	button:disabled { opacity: 0.5; cursor: default; }
</style>
