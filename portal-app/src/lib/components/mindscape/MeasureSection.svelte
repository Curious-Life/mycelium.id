<script lang="ts">
	/**
	 * MeasureSection — the `measure` stage: its CONTROL and its RESULT, in one section.
	 *
	 * THE DEFECT (operator, QA9 2026-07-27): "refresh analysis and measurement health should be
	 * in one section, and right now it got stuck in loading."
	 *
	 * They were two sibling sections in the rail — MeasureControl ("Refresh analysis", which runs
	 * run-clustering.sh steps 4-16) and MeasurementHealthSection (the per-family freshness those
	 * same steps write). A button and the thing the button produces, presented as unrelated
	 * neighbours, so nothing on screen said that pressing one changed the other.
	 *
	 * ⚠️ THIS IS NOT A MERGE FOR TIDINESS. It falls out of the layout rule the sprint design
	 * locks (the pipeline-sprint design Part 4.1): **a section is a STAGE; its controls
	 * are that stage's verbs; its status is that stage's outcome.** Under that rule these two
	 * were never two things. The same rule retires MapFreshness into the `cluster` row and folds
	 * the describe surfaces together — this is the first cut, not a one-off.
	 *
	 * WHAT IS DELIBERATELY *NOT* MERGED: the run CONTROL stays always-visible while the per-family
	 * detail is collapsible. Collapsing a control would hide the remedy — the same
	 * fail-open-to-visible property D-025 protects on the pipeline card, where an unsettled
	 * pipeline renders no toggle at all. You may hide the DIAGNOSIS; you may never hide the FIX.
	 *
	 * ⚠️ The detail defaults OPEN when a family is failing or quarantined. A section that
	 * remembers "collapsed" while something breaks underneath it is a surface that hides a
	 * problem, which is exactly what D-025 exists to prevent one card over.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { apiGet, apiPost, isTimeout } from '$lib/api';
	import CollapsibleHeader from './CollapsibleHeader.svelte';

	// ── The RUN (was MeasureControl) ───────────────────────────────────────────
	// POST /portal/mycelium/measure → { jobId }; poll the shared generate status route.
	// Non-destructive + kill-switch-exempt, so it stays available while Generate is locked.
	type Status = { status: 'running' | 'done' | 'error' | 'canceled'; step: number; totalSteps: number; stageLabel?: string; error?: string | null; stalled?: boolean };
	let jobId = $state<string | null>(null);
	let st = $state<Status | null>(null);
	let busy = $state(false);
	let poll: ReturnType<typeof setInterval> | null = null;

	const running = $derived(st?.status === 'running');
	const pct = $derived(st && st.totalSteps > 0 ? Math.min(100, Math.round((100 * st.step) / st.totalSteps)) : 0);

	function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
	async function refreshRun() {
		if (!jobId) return;
		try {
			st = await apiGet<Status>(`/portal/mycelium/generate/status/${jobId}`);
			if (st && st.status !== 'running') { stopPoll(); void loadHealth(); }   // the run wrote the metrics — re-read them
		} catch { /* transient; the next tick retries */ }
	}
	async function start() {
		busy = true;
		try {
			const r = await apiPost<{ jobId?: string }>('/portal/mycelium/measure', {});
			if (r?.jobId) {
				jobId = r.jobId;
				st = { status: 'running', step: 0, totalSteps: 16, stageLabel: 'Refreshing analysis' };
				stopPoll(); poll = setInterval(refreshRun, 2500);
			}
		} catch { /* surfaced via status */ } finally { busy = false; }
	}

	// ── The RESULT (was MeasurementHealthSection) ──────────────────────────────
	type Family = {
		table: string | null; stage: string | null; verdict: string | null;
		last_write: string | null; last_success_at: string | null; last_failure_reason: string | null;
		consecutive_failures: number; quarantined: boolean;
	};
	type Health = { families: Family[]; summary: { total: number; fresh: number; stale: number; failing: number; quarantined: number } };

	let data = $state<Health | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	// A deadline expiry is its OWN state, not an error: the read did not fail, it did not answer.
	// Before api() carried a deadline this surface sat on "Loading…" forever — the operator's
	// "got stuck in loading".
	let stalledRead = $state(false);

	async function loadHealth() {
		loading = true; error = null; stalledRead = false;
		try {
			data = await apiGet<Health>('/portal/measurement-health');
		} catch (e) {
			if (isTimeout(e)) stalledRead = true;
			else error = e instanceof Error ? e.message : 'Failed to load measurement health';
		} finally { loading = false; }
	}
	onMount(loadHealth);
	onDestroy(stopPoll);

	// ── Freshness, in the header ───────────────────────────────────────────────
	// The operator asked for "a freshness indicator in the main pipeline health section". The
	// honest summary is the WORST state present, never an average: one quarantined family is the
	// thing worth knowing, and averaging it away is how a broken metric becomes invisible.
	const needsAttention = $derived((data?.summary?.quarantined ?? 0) > 0 || (data?.summary?.failing ?? 0) > 0);
	const summaryLine = $derived.by(() => {
		if (running) return `Refreshing… step ${st?.step ?? 0}/${st?.totalSteps ?? 16}`;
		if (loading) return 'Checking your measurements…';
		if (stalledRead) return 'Taking longer than usual';
		if (error) return 'Couldn’t read measurement health';
		const s = data?.summary;
		if (!s) return 'No measurements yet';
		if (s.quarantined > 0) return `${s.quarantined} measurement${s.quarantined === 1 ? '' : 's'} need attention`;
		if (s.failing > 0) return `${s.failing} measurement${s.failing === 1 ? '' : 's'} failing`;
		if (s.stale > 0) return `${s.fresh} up to date · ${s.stale} stale`;
		return `${s.fresh} measurement${s.fresh === 1 ? '' : 's'} up to date`;
	});

	// Collapsed by default; forced OPEN whenever something needs attention (see the header note).
	let userExpanded = $state(false);
	const expanded = $derived(needsAttention || userExpanded);

	function when(iso: string | null): string {
		if (!iso) return '—';
		const t = Date.parse(iso);
		return Number.isFinite(t) ? new Date(t).toLocaleString() : '—';
	}
	function dot(f: Family): string {
		if (f.quarantined || f.consecutive_failures > 0) return 'var(--color-danger, #ef4444)';
		if (f.verdict === 'fresh') return 'var(--color-success, #22c55e)';
		if (f.verdict === 'stale') return 'var(--color-warning, #f59e0b)';
		return 'var(--color-text-tertiary, #9ca3af)';
	}
	const label = (f: Family) => (f.stage || f.table || 'stage').replace(/[-_]/g, ' ');
	function statusText(f: Family): string {
		if (f.quarantined) return 'Quarantined — failing repeatedly';
		if (f.consecutive_failures > 0) return `Failed ${f.consecutive_failures}× — last computed ${when(f.last_success_at)}`;
		if (f.verdict === 'fresh') return `Up to date · computed ${when(f.last_write || f.last_success_at)}`;
		if (f.verdict === 'stale') return `Stale · last ${when(f.last_write || f.last_success_at)}`;
		if (f.verdict === 'empty') return 'Not computed yet';
		return when(f.last_success_at);
	}
</script>

<section class="measure" data-testid="measure-section" data-attention={needsAttention ? '1' : '0'}>
	<!-- The freshness summary IS the disclosure — the same whole-row hit target the pipeline card
	     and the live process indicator use (D-067). -->
	<CollapsibleHeader bind:expanded={userExpanded} label="measurement detail" testid="measure-toggle" extraClass="ms-header">
		<span class="ms-dot" class:warn={needsAttention} class:busy={running}></span>
		<span class="ms-title">Analysis</span>
		<span class="ms-summary">{summaryLine}</span>
	</CollapsibleHeader>

	<!-- THE CONTROL IS NEVER COLLAPSED. Hiding a remedy behind a disclosure is the failure
	     D-025 guards on the pipeline card; the diagnosis may hide, the fix may not. -->
	{#if running}
		<div class="ms-bar" role="progressbar" aria-label="Refreshing analysis" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}>
			<div class="ms-bar-fill" style="width: {pct}%"></div>
		</div>
		<p class="ms-note">{st?.stageLabel || 'Working'} · step {st?.step}/{st?.totalSteps}</p>
		{#if st?.stalled}<p class="ms-note warn">Taking longer than usual on this step — still working.</p>{/if}
	{:else}
		<div class="ms-actions">
			<button class="ms-btn" onclick={start} disabled={busy}>Refresh analysis</button>
			{#if st?.status === 'done'}<span class="ms-ok">✓ Refreshed</span>{/if}
			{#if st?.status === 'error'}<span class="ms-err">{st.error || 'Refresh failed'}</span>{/if}
		</div>
		<p class="ms-hint">Recomputes vitality, co-firing, coherence &amp; movement on the current map — no re-cluster, no renaming.</p>
	{/if}

	{#if expanded}
		{#if loading}
			<p class="ms-note">Loading…</p>
		{:else if stalledRead}
			<p class="ms-note">This is taking longer than usual — your vault may be busy.
				<button class="ms-link" onclick={loadHealth}>Try again</button></p>
		{:else if error}
			<p class="ms-note err">{error}</p>
		{:else if data && data.families.length}
			<div class="ms-families">
				{#each data.families as f (f.stage ?? f.table)}
					<div class="ms-family">
						<span class="ms-fdot" style="background: {dot(f)}"></span>
						<div class="ms-fbody">
							<span class="ms-fname">{label(f)}</span>
							<span class="ms-fstatus">{statusText(f)}</span>
							{#if f.last_failure_reason && (f.quarantined || f.consecutive_failures > 0)}
								<span class="ms-freason">{f.last_failure_reason}</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<p class="ms-note">No measurements yet — run “Refresh analysis”.</p>
		{/if}
	{/if}
</section>

<style>
	.measure { display: flex; flex-direction: column; gap: 0.45rem; padding: 0.7rem 0.8rem;
		border-radius: 10px; border: 1px solid var(--glass-border); background: var(--glass-card-bg); }
	.measure[data-attention='1'] { border-color: color-mix(in srgb, var(--color-accent-coral, #f87171) 45%, transparent); }
	.ms-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--color-accent-jade, #4ade80); }
	.ms-dot.warn { background: var(--color-accent-coral, #f87171); }
	.ms-dot.busy { background: var(--color-accent-aurum, #e5b84c); animation: ms-pulse 1.6s ease-in-out infinite; }
	@keyframes ms-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
	.ms-title { font-size: 0.76rem; color: var(--color-text-primary); }
	.ms-summary { font-size: 0.7rem; color: var(--color-text-secondary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ms-hint { margin: 0; font-size: 0.68rem; color: var(--color-text-tertiary); line-height: 1.35; }
	.ms-note { margin: 0; font-size: 0.7rem; color: var(--color-text-secondary); line-height: 1.35; }
	.ms-note.warn { color: var(--color-accent-aurum, #e5b84c); }
	.ms-note.err, .ms-err { color: var(--color-accent-coral, #f87171); font-size: 0.7rem; }
	.ms-ok { font-size: 0.7rem; color: var(--color-accent-jade, #4ade80); }
	.ms-bar { height: 4px; border-radius: 2px; overflow: hidden; background: var(--glass-border); }
	.ms-bar-fill { height: 100%; background: var(--color-accent-aurum, #e5b84c); transition: width 0.4s ease; }
	.ms-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
	.ms-btn { padding: 0.25rem 0.7rem; border-radius: 999px; border: 1px solid var(--color-accent-aurum, #e5b84c);
		background: transparent; color: var(--color-text-primary); font: inherit; font-size: 0.72rem; cursor: pointer; }
	.ms-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--color-accent-aurum, #e5b84c) 14%, transparent); }
	.ms-btn:disabled { opacity: 0.5; cursor: default; }
	.ms-link { background: none; border: 0; padding: 0; font: inherit; color: inherit; text-decoration: underline; cursor: pointer; }
	.ms-families { display: flex; flex-direction: column; gap: 0.3rem; }
	.ms-family { display: flex; align-items: flex-start; gap: 0.5rem; padding: 0.3rem 0.4rem; border-radius: 6px;
		background: var(--color-surface-2, rgba(255, 255, 255, 0.04)); }
	.ms-fdot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; margin-top: 0.3rem; }
	.ms-fbody { display: flex; flex-direction: column; min-width: 0; }
	.ms-fname { font-size: 0.72rem; color: var(--color-text-primary); text-transform: capitalize; }
	.ms-fstatus { font-size: 0.66rem; color: var(--color-text-secondary); }
	.ms-freason { font-size: 0.62rem; font-family: var(--font-mono, monospace); color: var(--color-accent-coral, #f87171); }
</style>
