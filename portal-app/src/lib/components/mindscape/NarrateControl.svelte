<script lang="ts">
	// NarrateControl — Phase 3 UI for the agent narration walk. Start / pause / resume /
	// cancel + live progress, bound to the REST lifecycle (src/jobs.js + narration_runs):
	//   POST /portal/mycelium/narrate {scope,provider}  → { runId, status }
	//   POST /portal/mycelium/narrate/{pause,resume,cancel} {runId}
	//   GET  /portal/mycelium/narrate/status[?runId]     → { run }
	// Privacy: the run's provider is surfaced; a cloud provider is flagged ("content
	// leaves this machine"). Content-free progress (counts + a generic stage only).
	import { onMount, onDestroy } from 'svelte';
	import { apiGet, apiPost } from '$lib/api';

	type Run = {
		run_id: string; status: 'running' | 'paused' | 'done' | 'canceled' | 'error';
		described: number; reflected: number; skipped: number; total: number;
		provider: string | null; current_kind: string | null; current_id: number | null; error?: string | null;
	};

	let run = $state<Run | null>(null);
	let busy = $state(false);
	let poll: ReturnType<typeof setInterval> | null = null;

	// Coverage rollup (% described, per level) + the SAFE "describe more" control.
	// describe-more spawns describe-chronicles.js as a CHILD (POST /mycelium/describe-more) —
	// NOT the in-process narration walk above — so it never pegs the event loop. We poll
	// /mindscape/coverage so the % visibly climbs while a pass runs.
	type Coverage = { overall: { avgPercent: number }, territories: { total: number; described: number; fullyDescribed: number; avgPercent: number }, themes: { total: number; avgPercent: number }, realms: { total: number; avgPercent: number } };
	let coverage = $state<Coverage | null>(null);
	let describing = $state(false);
	let covPoll: ReturnType<typeof setInterval> | null = null;
	let covTimeout: ReturnType<typeof setTimeout> | null = null;

	async function refreshCoverage() {
		try { coverage = await apiGet<Coverage>('/portal/mindscape/coverage'); } catch { /* transient */ }
	}
	async function describeMore() {
		describing = true;
		try {
			await apiPost('/portal/mycelium/describe-more', {});
			if (covPoll) clearInterval(covPoll);
			covPoll = setInterval(refreshCoverage, 4000);
			if (covTimeout) clearTimeout(covTimeout);
			covTimeout = setTimeout(() => { if (covPoll) { clearInterval(covPoll); covPoll = null; } describing = false; refreshCoverage(); }, 90_000);
		} catch { describing = false; }
	}

	const isLocal = (p: string | null) => !p || /local|ollama|on-?box|127\.0\.0\.1/i.test(p);
	const active = $derived(run?.status === 'running' || run?.status === 'paused');
	const doneCount = $derived(run ? run.described + run.reflected + run.skipped : 0);
	const pct = $derived(run && run.total > 0 ? Math.min(100, Math.round((100 * doneCount) / run.total)) : 0);

	async function refresh() {
		try {
			const r = await apiGet<{ run: Run | null }>('/portal/mycelium/narrate/status');
			run = r?.run ?? null;
			if (run && (run.status === 'done' || run.status === 'canceled' || run.status === 'error')) stopPoll();
		} catch { /* transient */ }
	}
	function startPoll() { stopPoll(); poll = setInterval(refresh, 2500); }
	function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

	async function start() {
		busy = true;
		try {
			const r = await apiPost<{ runId?: string }>('/portal/mycelium/narrate', { scope: 'all' });
			if (r?.runId) { await refresh(); startPoll(); }
		} catch { /* surfaced via status */ } finally { busy = false; }
	}
	async function control(action: 'pause' | 'resume' | 'cancel') {
		if (!run) return; busy = true;
		try { await apiPost(`/portal/mycelium/narrate/${action}`, { runId: run.run_id }); await refresh(); if (run?.status === 'running') startPoll(); }
		catch { /* */ } finally { busy = false; }
	}

	onMount(() => { refresh(); refreshCoverage(); });
	onDestroy(() => { stopPoll(); if (covPoll) clearInterval(covPoll); if (covTimeout) clearTimeout(covTimeout); });
</script>

<div class="narrate">
	<div class="row">
		<span class="title">Narrate the map</span>
		{#if run}
			<span class="status status-{run.status}">{run.status}</span>
		{/if}
	</div>

	{#if run && (active || run.status === 'done')}
		<div class="bar"><div class="fill" style="width:{pct}%"></div></div>
		<div class="counts">
			{doneCount}/{run.total} · {run.described} described · {run.reflected} reflected · {run.skipped} skipped
		</div>
		{#if run.provider}
			<div class="provider {isLocal(run.provider) ? 'local' : 'cloud'}">
				{isLocal(run.provider) ? `on-box · ${run.provider}` : `⚠ cloud · ${run.provider} — content leaves this machine`}
			</div>
		{/if}
		{#if run.error}<div class="err">{run.error}</div>{/if}
	{/if}

	{#if coverage}
		<div class="coverage">
			<div class="cov-head">
				<span class="cov-title">Description coverage</span>
				<span class="cov-overall">{coverage.overall.avgPercent}%</span>
			</div>
			<div class="bar"><div class="fill cov" style="width:{coverage.overall.avgPercent}%"></div></div>
			<div class="cov-detail">
				territories {coverage.territories.fullyDescribed}/{coverage.territories.total} full · {coverage.territories.avgPercent}% avg ·
				themes {coverage.themes.avgPercent}% · realms {coverage.realms.avgPercent}%
			</div>
			<div class="actions">
				<button onclick={describeMore} disabled={describing}>{describing ? 'Describing…' : 'Describe more'}</button>
			</div>
			<div class="cov-note">Folds in undescribed content (runs in the background; safe to keep using the app).</div>
		</div>
	{/if}

	<div class="actions">
		{#if !active}
			<button onclick={start} disabled={busy}>Narrate</button>
		{:else if run?.status === 'running'}
			<button onclick={() => control('pause')} disabled={busy}>Pause</button>
			<button class="ghost" onclick={() => control('cancel')} disabled={busy}>Cancel</button>
		{:else if run?.status === 'paused'}
			<button onclick={() => control('resume')} disabled={busy}>Resume</button>
			<button class="ghost" onclick={() => control('cancel')} disabled={busy}>Cancel</button>
		{/if}
	</div>
</div>

<style>
	.narrate { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; border: 1px solid rgba(255,255,255,0.08); border-radius: var(--radius-md, 10px); background: rgba(255,255,255,0.03); }
	.row { display: flex; align-items: center; justify-content: space-between; }
	.title { font-weight: 600; font-size: 0.9rem; color: var(--color-text-primary); }
	.status { font-size: 0.7rem; padding: 0.1rem 0.5rem; border-radius: 999px; text-transform: capitalize; }
	.status-running { color: #4ade80; background: rgba(74,222,128,0.12); }
	.status-paused { color: #E5B84C; background: rgba(229,184,76,0.15); }
	.status-done { color: #7DB6D9; background: rgba(125,182,217,0.15); }
	.status-canceled, .status-error { color: #94a3b8; background: rgba(148,163,184,0.12); }
	.bar { height: 5px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
	.fill { height: 100%; background: var(--color-accent, #E5B84C); transition: width 0.4s ease; }
	.counts { font-size: 0.72rem; color: var(--color-text-secondary); }
	.provider { font-size: 0.68rem; }
	.provider.local { color: var(--color-text-tertiary); }
	.provider.cloud { color: #E5B84C; }
	.err { font-size: 0.7rem; color: #f87171; }
	.actions { display: flex; gap: 0.5rem; }
	button { font-size: 0.8rem; padding: 0.35rem 0.9rem; border-radius: var(--radius-full, 999px); border: 1px solid var(--color-accent, #E5B84C); background: var(--color-accent, #E5B84C); color: var(--color-bg, #111); cursor: pointer; }
	button.ghost { background: transparent; color: var(--color-text-secondary); border-color: rgba(255,255,255,0.15); }
	button:disabled { opacity: 0.5; cursor: default; }
	.coverage { display: flex; flex-direction: column; gap: 0.4rem; padding-bottom: 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.06); }
	.cov-head { display: flex; align-items: center; justify-content: space-between; }
	.cov-title { font-size: 0.82rem; font-weight: 600; color: var(--color-text-primary); }
	.cov-overall { font-size: 0.82rem; font-weight: 600; color: var(--color-accent, #E5B84C); }
	.fill.cov { background: #7DB6D9; }
	.cov-detail { font-size: 0.7rem; color: var(--color-text-secondary); }
	.cov-note { font-size: 0.66rem; color: var(--color-text-tertiary); }
</style>
