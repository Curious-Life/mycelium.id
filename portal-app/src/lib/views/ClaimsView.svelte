<script lang="ts">
	// ClaimsView — the durable person-level claims the system has formed
	// (PersonaTree adoption), with a confidence-over-time chart per claim. Reads
	// the owner-gated /portal/claims/* endpoints; TimeSeries breaks the line on
	// null windows (honest gaps). See docs/PERSONA-CLAIMS-DESIGN-2026-06-06.md §3.9.
	import { onMount } from 'svelte';
	import { navigationState } from '$lib/stores/navigation';
	import { apiGet } from '$lib/api';
	import TimeSeries from '$lib/curious/TimeSeries.svelte';

	type Claim = { id: string; claim_type: string; content: string; confidence: number | null; support_count: number };
	type Point = { window_end: string; confidence: number | null; delta_kind: string | null; evidence_count: number | null };

	let claims = $state<Claim[]>([]);
	let loading = $state(true);
	let selectedId = $state<string | null>(null);
	let granularity = $state<'day' | 'week' | 'month' | 'quarter'>('week');
	let series = $state<Point[]>([]);
	let seriesLoading = $state(false);

	const GRANS: Array<typeof granularity> = ['day', 'week', 'month', 'quarter'];
	const TYPE_ORDER = ['boundary', 'value', 'principle', 'identity', 'personality'];
	const TYPE_LABEL: Record<string, string> = {
		boundary: 'Boundaries', value: 'Values', principle: 'Principles', identity: 'Identity', personality: 'Personality',
	};
	const DELTA_LABEL: Record<string, string> = {
		new: 'new', strengthened: '↑ stronger', weakened: '↓ weaker', contradicted: '⚠ contradicted', stable: 'stable', retired: 'retired',
	};

	const selected = $derived(claims.find((c) => c.id === selectedId) ?? null);
	const grouped = $derived(
		TYPE_ORDER
			.map((t) => ({ type: t, items: claims.filter((c) => c.claim_type === t) }))
			.filter((g) => g.items.length),
	);
	const points = $derived(series.map((s) => s.confidence));
	const labels = $derived(series.map((s) => s.window_end.slice(0, 10)));
	const latestDelta = $derived(series.length ? series[series.length - 1].delta_kind : null);

	async function loadSeries() {
		if (!selectedId) { series = []; return; }
		seriesLoading = true;
		const r = await apiGet<{ series: Point[] }>(`/portal/claims/series?claim_id=${encodeURIComponent(selectedId)}&granularity=${granularity}`).catch(() => null);
		series = r?.series ?? [];
		seriesLoading = false;
	}

	function select(id: string) { selectedId = selectedId === id ? null : id; loadSeries(); }
	function setGran(g: typeof granularity) { granularity = g; loadSeries(); }

	onMount(async () => {
		navigationState.setPrimaryView?.('claims');
		const r = await apiGet<{ claims: Claim[] }>('/portal/claims/current').catch(() => null);
		claims = r?.claims ?? [];
		loading = false;
	});
</script>

<div class="claims">
	<header>
		<h1>What it's learned about you</h1>
		<p class="sub">Durable claims grounded in your interaction history. Each is an interpretation, not a certainty — pick one to see how its confidence moved over time.</p>
	</header>

	{#if loading}
		<p class="muted">Loading…</p>
	{:else if !claims.length}
		<div class="empty">
			<p>No claims yet.</p>
			<p class="muted">Claims form as the system discovers patterns across your history over time. This needs a local model — pull one in Settings → Intelligence, then run Generate.</p>
		</div>
	{:else}
		<div class="layout">
			<div class="list">
				{#each grouped as group (group.type)}
					<section class="group">
						<h2>{TYPE_LABEL[group.type] ?? group.type}</h2>
						{#each group.items as c (c.id)}
							<button class="claim" class:active={c.id === selectedId} onclick={() => select(c.id)}>
								<div class="claim-text">{c.content}</div>
								<div class="claim-meta">
									<span class="bar" style={`--p:${Math.round((c.confidence ?? 0) * 100)}%`}></span>
									<span class="pct">{c.confidence == null ? '—' : Math.round(c.confidence * 100) + '%'}</span>
									<span class="muted">· {c.support_count} ev</span>
								</div>
							</button>
						{/each}
					</section>
				{/each}
			</div>

			<div class="detail">
				{#if !selected}
					<p class="muted">Select a claim to see its trajectory.</p>
				{:else}
					<div class="detail-head">
						<div class="badge">{selected.claim_type}</div>
						<div class="detail-content">{selected.content}</div>
						{#if latestDelta}<span class="delta delta-{latestDelta}">{DELTA_LABEL[latestDelta] ?? latestDelta}</span>{/if}
					</div>
					<div class="grans">
						{#each GRANS as g}
							<button class="gran" class:on={g === granularity} onclick={() => setGran(g)}>{g}</button>
						{/each}
					</div>
					{#if seriesLoading}
						<p class="muted">Loading trajectory…</p>
					{:else if series.length < 2}
						<p class="muted">Not enough {granularity} history yet — a trend appears once discovery runs across more {granularity} windows. (Current confidence {selected.confidence == null ? '—' : Math.round(selected.confidence * 100) + '%'}.)</p>
					{:else}
						<TimeSeries {points} {labels} height={180} yMin={0} yMax={1} format={(v) => Math.round(v * 100) + '%'} />
						<p class="muted small">Confidence over {series.length} {granularity} windows. Gaps = windows with no evidence.</p>
					{/if}
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.claims { padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
	header h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
	.sub { color: var(--color-text-muted, #888); margin: 0 0 1.25rem; max-width: 60ch; }
	.muted { color: var(--color-text-muted, #888); }
	.small { font-size: 0.8rem; }
	.empty { padding: 2rem; border: 1px dashed var(--color-border, #333); border-radius: 12px; text-align: center; }
	.layout { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.2fr); gap: 1.5rem; align-items: start; }
	@media (max-width: 760px) { .layout { grid-template-columns: 1fr; } }
	.group { margin-bottom: 1.25rem; }
	.group h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted, #888); margin: 0 0 0.5rem; }
	.claim { display: block; width: 100%; text-align: left; background: var(--color-surface, #1a1a1a); border: 1px solid var(--color-border, #2a2a2a); border-radius: 10px; padding: 0.7rem 0.85rem; margin-bottom: 0.5rem; cursor: pointer; transition: border-color 0.15s; }
	.claim:hover { border-color: var(--color-accent, #6a8); }
	.claim.active { border-color: var(--color-accent, #6a8); box-shadow: 0 0 0 1px var(--color-accent, #6a8); }
	.claim-text { font-size: 0.92rem; line-height: 1.35; margin-bottom: 0.5rem; }
	.claim-meta { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; }
	.bar { flex: 1; height: 5px; border-radius: 3px; background: linear-gradient(to right, var(--color-accent, #6a8) var(--p), var(--color-border, #2a2a2a) var(--p)); }
	.pct { font-variant-numeric: tabular-nums; }
	.detail { position: sticky; top: 1rem; background: var(--color-surface, #1a1a1a); border: 1px solid var(--color-border, #2a2a2a); border-radius: 12px; padding: 1.1rem; min-height: 140px; }
	.detail-head { display: flex; align-items: flex-start; gap: 0.6rem; flex-wrap: wrap; margin-bottom: 0.9rem; }
	.badge { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; background: var(--color-accent, #6a8); color: #000; padding: 0.15rem 0.5rem; border-radius: 999px; }
	.detail-content { flex: 1 1 200px; font-size: 1rem; line-height: 1.4; }
	.delta { font-size: 0.72rem; padding: 0.15rem 0.45rem; border-radius: 999px; border: 1px solid var(--color-border, #2a2a2a); }
	.delta-strengthened { color: #5cba6a; border-color: #5cba6a; }
	.delta-weakened, .delta-contradicted { color: #d08a4a; border-color: #d08a4a; }
	.grans { display: flex; gap: 0.4rem; margin-bottom: 0.9rem; }
	.gran { font-size: 0.78rem; padding: 0.25rem 0.6rem; border-radius: 999px; border: 1px solid var(--color-border, #2a2a2a); background: transparent; color: var(--color-text-muted, #888); cursor: pointer; text-transform: capitalize; }
	.gran.on { color: var(--color-accent, #6a8); border-color: var(--color-accent, #6a8); }
</style>
