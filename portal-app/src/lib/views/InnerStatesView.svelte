<script lang="ts">
	// Inner States — validate the system's read of your inner-state axes (E2).
	// Flow: pick an axis → rate sampled time-windows (read your own words, slide
	// toward a pole) → once ≥20 ratings, run CVP → if it clears, the lean surfaces.
	// Backend: /api/v1/portal/labels/* (status·sample·save·run-cvp·leans).
	import { onMount } from 'svelte';
	import { apiGet, apiPost } from '$lib/api';

	type AxisStatus = { axis: string; cvp_status: string; measurable: boolean; loo_auc: number | null; labels: number };
	type StatusResp = { ok: boolean; anchorVersion: string | null; axes: AxisStatus[] };
	type Msg = { role: string; created_at: string; content: string };
	type Win = { window_end: string; era_id: string; granularity: string; window_start: string; message_count: number; messages: Msg[] };
	type SampleResp = { ok: boolean; anchorVersion: string | null; axis: string; windows: Win[] };
	type LeansResp = { ok: boolean; window_end: string | null; leans: { axis: string; value: number }[] };
	type RunResp = { ok: boolean; axis: string; status: string; n: number; reason: string };

	// [−pole, +pole] labels — matches src/metrics/contracts.js framing (kusala functional, edges softening).
	const POLES: Record<string, [string, string]> = {
		tone: ['unpleasant', 'pleasant'],
		charge: ['quiet', 'wired'],
		warmth: ['cut-off', 'close'],
		gatheredness: ['scattered', 'collected'],
		holding: ['gripping', 'letting-be'],
		noticing: ['caught up in it', 'stepped back'],
		edges: ['firmer-bounded', 'softer-edged'],
		kusala: ['toward grasping', 'toward ease']
	};
	const MIN_LABELS = 20;

	let status = $state<StatusResp | null>(null);
	let leans = $state<LeansResp | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let activeAxis = $state<string | null>(null);
	let sample = $state<Win[]>([]);
	let sampleLoading = $state(false);
	let ratings = $state<Record<string, number>>({});
	let saved = $state<Record<string, boolean>>({});
	let verdict = $state<RunResp | null>(null);
	let running = $state(false);

	async function loadStatus() {
		try {
			status = await apiGet<StatusResp>('/portal/labels/status');
			leans = await apiGet<LeansResp>('/portal/labels/leans');
		} catch (e) {
			error = (e as Error).message;
		}
	}
	onMount(async () => {
		loading = true;
		await loadStatus();
		loading = false;
	});

	const activeCount = $derived(status?.axes?.find((a) => a.axis === activeAxis)?.labels ?? 0);

	async function pickAxis(axis: string) {
		activeAxis = axis;
		verdict = null;
		sample = [];
		ratings = {};
		saved = {};
		await loadSample();
	}
	async function loadSample() {
		if (!activeAxis) return;
		sampleLoading = true;
		error = null;
		try {
			const r = await apiGet<SampleResp>('/portal/labels/sample', { axis: activeAxis, n: '6' });
			sample = r.windows ?? [];
		} catch (e) {
			error = (e as Error).message;
		} finally {
			sampleLoading = false;
		}
	}
	async function saveRating(w: Win, value: number) {
		if (!status?.anchorVersion || !activeAxis) return;
		ratings = { ...ratings, [w.window_end]: value };
		try {
			await apiPost('/portal/labels', {
				axis: activeAxis,
				anchorVersion: status.anchorVersion,
				windowEnd: w.window_end,
				granularity: w.granularity,
				eraId: w.era_id,
				target: value
			});
			saved = { ...saved, [w.window_end]: true };
			await loadStatus();
		} catch (e) {
			error = (e as Error).message;
		}
	}
	async function runCvp() {
		if (!activeAxis || !status?.anchorVersion) return;
		running = true;
		error = null;
		try {
			verdict = await apiPost<RunResp>('/portal/labels/run-cvp', {
				axis: activeAxis,
				anchorVersion: status.anchorVersion
			});
			await loadStatus();
		} catch (e) {
			error = (e as Error).message;
		} finally {
			running = false;
		}
	}
	function excerpt(w: Win): string {
		return (w.messages ?? []).map((m) => m.content).join('  ·  ').slice(0, 360);
	}
	function dayLabel(iso: string): string {
		return iso.slice(0, 10);
	}
</script>

<div class="inner-states">
	<header>
		<h1>Inner States</h1>
		<p class="lede">
			A read on the language of your inner states — leaning, never a verdict. Nothing shows here
			until you teach it: rate {MIN_LABELS}+ moments on an axis, then validate. If your ratings
			match the geometry, that axis starts surfacing.
		</p>
	</header>

	{#if error}
		<div class="banner err">{error}</div>
	{/if}

	{#if loading}
		<div class="muted">Loading…</div>
	{:else if !status?.anchorVersion}
		<!-- Axes not computed yet: there's no anchor version, so nothing to teach or
		     surface. Show an honest "not ready" state rather than empty scaffolding. -->
		<section class="empty-state">
			<h2>Not ready yet</h2>
			<p class="muted">
				Inner States reads the language of your moods and modes — but only once your vault
				has been analyzed enough to place them. Nothing has been computed yet, so there's
				nothing to validate. As more of your writing is processed, the axes will appear here
				for you to teach and confirm.
			</p>
		</section>
	{:else}
		<!-- Validated leans (only CVP-passed axes appear) -->
		<section class="leans">
			<h2>Your leans</h2>
			{#if leans?.leans?.length}
				<div class="lean-grid">
					{#each leans.leans as l (l.axis)}
						{@const pole = POLES[l.axis] ?? ['−', '+']}
						<div class="lean-chip">
							<span class="axis">{l.axis}</span>
							<span class="dir">leans {l.value >= 0 ? pole[1] : pole[0]}</span>
							<span class="val">{l.value >= 0 ? '+' : ''}{l.value.toFixed(2)}</span>
						</div>
					{/each}
				</div>
			{:else}
				<p class="muted">No axes validated yet — rate some moments below to teach the first one.</p>
			{/if}
		</section>

		<!-- Axes to validate -->
		<section class="axes">
			<h2>Axes</h2>
			<div class="axis-grid">
				{#each status?.axes ?? [] as a (a.axis)}
					{@const pole = POLES[a.axis] ?? ['−', '+']}
					<button
						class="axis-card"
						class:active={activeAxis === a.axis}
						class:passed={a.cvp_status === 'pass'}
						disabled={!a.measurable}
						onclick={() => pickAxis(a.axis)}
					>
						<span class="name">{a.axis}</span>
						<span class="poles">{pole[0]} ↔ {pole[1]}</span>
						<span class="meta">
							{#if !a.measurable}not measurable{:else if a.cvp_status === 'pass'}✓ validated{:else}{a.labels}/{MIN_LABELS} rated{/if}
						</span>
					</button>
				{/each}
			</div>
		</section>

		<!-- Labeling panel -->
		{#if activeAxis}
			{@const pole = POLES[activeAxis] ?? ['−', '+']}
			<section class="label-panel">
				<div class="panel-head">
					<h2>Rate “{activeAxis}” — <span class="poles">{pole[0]} ↔ {pole[1]}</span></h2>
					<span class="count">{activeCount}/{MIN_LABELS} rated</span>
				</div>
				<p class="muted">
					Read each moment and slide toward whichever pole it felt like. Rate honestly from your own
					memory — don't guess what the system “wants”.
				</p>

				{#if sampleLoading}
					<div class="muted">Loading moments…</div>
				{:else if !sample.length}
					<div class="muted">No more unrated moments at this scale.</div>
				{:else}
					<div class="windows">
						{#each sample as w (w.window_end)}
							<div class="window">
								<div class="w-head">
									<span class="w-date">{dayLabel(w.window_end)}</span>
									<span class="w-count muted">{w.message_count} messages</span>
									{#if saved[w.window_end]}<span class="w-saved">saved ✓</span>{/if}
								</div>
								<div class="w-text">{excerpt(w) || '(no readable text in this window)'}</div>
								<div class="w-slider">
									<span class="pole-l">{pole[0]}</span>
									<input
										type="range" min="-1" max="1" step="0.1"
										value={ratings[w.window_end] ?? 0}
										onchange={(e) => saveRating(w, parseFloat((e.currentTarget as HTMLInputElement).value))}
									/>
									<span class="pole-r">{pole[1]}</span>
								</div>
							</div>
						{/each}
					</div>
					<button class="more" onclick={loadSample}>Load more moments</button>
				{/if}

				<div class="validate">
					<button
						class="run"
						disabled={running || activeCount < MIN_LABELS}
						onclick={runCvp}
					>
						{running ? 'Validating…' : `Validate “${activeAxis}”`}
					</button>
					{#if activeCount < MIN_LABELS}
						<span class="muted">Rate {MIN_LABELS - activeCount} more to validate.</span>
					{/if}
					{#if verdict}
						<span class="verdict" class:pass={verdict.status === 'pass'}>
							{verdict.status === 'pass'
								? `✓ Validated on ${verdict.n} ratings — it will start surfacing.`
								: `Not validated (${verdict.status}): ${verdict.reason}`}
						</span>
					{/if}
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	.inner-states { max-width: 760px; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
	h1 { font-size: 1.5rem; font-weight: 600; margin: 0 0 0.25rem; }
	h2 { font-size: 1rem; font-weight: 600; margin: 1.5rem 0 0.5rem; }
	.lede { color: var(--color-text-secondary); line-height: 1.6; margin: 0 0 0.5rem; }
	.muted { color: var(--color-text-tertiary); font-size: 0.9rem; }
	.banner.err {
		background: var(--color-background-danger, #fcebeb); color: var(--color-text-danger, #a32d2d);
		border-radius: 8px; padding: 0.6rem 0.8rem; margin: 0.5rem 0; font-size: 0.9rem;
	}
	.lean-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
	.lean-chip {
		display: inline-flex; align-items: baseline; gap: 0.4rem;
		background: var(--color-background-secondary); border: 1px solid var(--color-border-tertiary);
		border-radius: 999px; padding: 0.3rem 0.7rem;
	}
	.lean-chip .axis { font-weight: 600; }
	.lean-chip .dir { color: var(--color-text-secondary); font-size: 0.9rem; }
	.lean-chip .val { color: var(--color-text-tertiary); font-variant-numeric: tabular-nums; }
	.axis-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.6rem; }
	.axis-card {
		display: flex; flex-direction: column; gap: 0.2rem; text-align: left;
		background: var(--color-background-secondary); border: 1px solid var(--color-border-tertiary);
		border-radius: 10px; padding: 0.7rem 0.8rem; cursor: pointer; color: inherit;
	}
	.axis-card:hover:not(:disabled) { border-color: var(--color-border-secondary); }
	.axis-card.active { border-color: var(--color-border-primary); }
	.axis-card.passed { border-color: var(--color-border-success, #1d9e75); }
	.axis-card:disabled { opacity: 0.45; cursor: default; }
	.axis-card .name { font-weight: 600; text-transform: capitalize; }
	.axis-card .poles { color: var(--color-text-secondary); font-size: 0.8rem; }
	.axis-card .meta { color: var(--color-text-tertiary); font-size: 0.78rem; }
	.label-panel { margin-top: 1.5rem; border-top: 1px solid var(--color-border-tertiary); padding-top: 1rem; }
	.panel-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; }
	.panel-head .poles { color: var(--color-text-secondary); font-weight: 400; font-size: 0.9rem; }
	.count { color: var(--color-text-tertiary); font-size: 0.85rem; white-space: nowrap; }
	.windows { display: flex; flex-direction: column; gap: 0.8rem; margin: 0.8rem 0; }
	.window { background: var(--color-background-secondary); border: 1px solid var(--color-border-tertiary); border-radius: 10px; padding: 0.8rem; }
	.w-head { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.82rem; }
	.w-date { font-weight: 600; }
	.w-saved { color: var(--color-text-success, #1d9e75); margin-left: auto; }
	.w-text { color: var(--color-text-secondary); font-size: 0.9rem; line-height: 1.5; margin: 0.5rem 0 0.7rem; }
	.w-slider { display: flex; align-items: center; gap: 0.6rem; }
	.w-slider input { flex: 1; }
	.w-slider .pole-l, .w-slider .pole-r { font-size: 0.78rem; color: var(--color-text-tertiary); white-space: nowrap; }
	.more { background: none; border: 1px solid var(--color-border-tertiary); border-radius: 8px; padding: 0.4rem 0.8rem; cursor: pointer; color: var(--color-text-secondary); }
	.validate { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; margin-top: 1rem; }
	.run {
		background: var(--color-text-primary); color: var(--color-background-primary);
		border: none; border-radius: 8px; padding: 0.5rem 1rem; font-weight: 600; cursor: pointer;
	}
	.run:disabled { opacity: 0.4; cursor: default; }
	.verdict { font-size: 0.9rem; color: var(--color-text-secondary); }
	.verdict.pass { color: var(--color-text-success, #1d9e75); }
</style>
