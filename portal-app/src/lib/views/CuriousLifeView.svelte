<script lang="ts">
	// Curious Life — the human-facing analytics surface. An Apple-Health-style
	// overview of the cognitive-measurement plane: high-level summary cards you can
	// tap to explore. Honest by construction — sparse / low-confidence signals say
	// so rather than fabricating a number.
	//
	// Aesthetic: pure-CSS atmosphere (drifting radial gradients), no WebGL / no
	// backdrop-filter (both misbehave in the desktop WKWebView — see app.css
	// `html.is-tauri`). All charts are hand-rolled SVG.
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { navigationState } from '$lib/stores/navigation';
	import { apiGet } from '$lib/api';
	import Ring from '$lib/curious/Ring.svelte';
	import Spark from '$lib/curious/Spark.svelte';

	type Any = Record<string, any>;

	let loading = $state(true);
	let active = $state<string | null>(null); // null = overview, else pillar key

	let vitality = $state<Any | null>(null);
	let audit = $state<Any | null>(null);
	let movement = $state<Any | null>(null); // trajectory/summary.summary
	let current = $state<Any | null>(null); // trajectory/current.current
	let milestones = $state<Any[]>([]);
	let trajectory = $state<Any[]>([]); // weekly_step rows
	let rhythm = $state<Any | null>(null); // metrics/window (theta)

	const fmt = (v: any, d = 2) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toFixed(d));
	const pct = (v: any) => (v == null ? '—' : `${Math.round(Number(v) * 100)}%`);
	const cap = (s: any) => (typeof s === 'string' && s ? s[0].toUpperCase() + s.slice(1) : '—');

	onMount(async () => {
		navigationState.setPrimaryView('curious-life');
		const g = (p: string) => apiGet<Any>(p).catch(() => null);
		const [v, a, m, c, ms, tr, rh] = await Promise.all([
			g('/portal/vitality/snapshot'),
			g('/portal/vitality/audit'),
			g('/portal/trajectory/summary?period=quarter&level=realm'),
			g('/portal/trajectory/current?level=realm'),
			g('/portal/trajectory/milestones'),
			g('/portal/trajectory?level=realm&window_type=weekly_step&limit=200'),
			g('/portal/metrics/window?granularity=theta'),
		]);
		vitality = v;
		audit = a?.audit ?? null;
		movement = m?.summary ?? null;
		current = c?.current ?? null;
		milestones = ms?.milestones ?? [];
		trajectory = tr?.trajectory ?? [];
		rhythm = rh ?? null;
		loading = false;
	});

	// ── Derived headlines ────────────────────────────────────────────────────
	const vSummary = $derived(vitality?.summary ?? null);
	const phaseOrder = ['anchor', 'active', 'sparse'];
	const phaseColor: Record<string, string> = {
		anchor: 'var(--color-accent-aurum)',
		active: 'var(--color-accent-jade)',
		sparse: 'var(--color-text-tertiary)',
	};
	const territories = $derived(
		[...(vitality?.territories ?? [])].sort((a, b) => (b.vitality ?? 0) - (a.vitality ?? 0)),
	);
	const velocities = $derived(trajectory.map((r) => Number(r.fisher_velocity) || 0));
	const moveLowConf = $derived(Boolean(current?.low_confidence ?? movement == null));
	const rhythmValues = $derived(rhythm?.values ?? {});
	const rhythmHasSignal = $derived(
		Object.values(rhythmValues).some((v) => v != null && Number(v) !== 0),
	);

	function openMindscape() {
		navigationState.setPrimaryView('mindscape');
		goto('/mindscape');
	}

	const pillars = [
		{ key: 'vitality', label: 'Vitality', accent: 'jade', tagline: 'How alive your territories are' },
		{ key: 'movement', label: 'Movement', accent: 'azure', tagline: 'How your mind is moving' },
		{ key: 'rhythm', label: 'Rhythm', accent: 'amethyst', tagline: 'The cadence of your thinking' },
		{ key: 'mindscape', label: 'Mindscape', accent: 'aurum', tagline: 'The shape of your inner world' },
		{ key: 'milestones', label: 'Milestones', accent: 'coral', tagline: 'Moments your mind turned' },
	];
	const accentVar: Record<string, string> = {
		jade: 'var(--color-accent-jade)',
		azure: 'var(--color-accent)',
		amethyst: 'var(--color-accent-amethyst)',
		aurum: 'var(--color-accent-aurum)',
		coral: 'var(--color-accent-coral)',
	};
	const accentRgb: Record<string, string> = {
		jade: 'var(--color-accent-jade-rgb)',
		azure: 'var(--color-accent-rgb)',
		amethyst: 'var(--color-accent-amethyst-rgb)',
		aurum: 'var(--color-accent-aurum-rgb)',
		coral: 'var(--color-accent-coral-rgb)',
	};
</script>

<svelte:head><title>Curious Life · Mycelium</title></svelte:head>

<div class="curious">
	<div class="aurora" aria-hidden="true">
		<span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span>
	</div>

	<div class="inner">
		{#if !active}
			<!-- ── OVERVIEW ─────────────────────────────────────────────────── -->
			<header class="hero">
				<p class="overline">Curious Life</p>
				<h1 class="title">Where your mind stands today.</h1>
				<p class="lede">A living read of how your thinking moves, gathers, and grows — drawn from your own conversations.</p>
			</header>

			{#if loading}
				<div class="grid">
					{#each pillars as _}<div class="card skeleton"></div>{/each}
				</div>
			{:else}
				<div class="grid">
					<!-- VITALITY -->
					<button class="card" style="--rgb:{accentRgb.jade};" onclick={() => (active = 'vitality')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.jade}"></span><span class="ctitle">Vitality</span><span class="chev">›</span></div>
						<div class="card-body two">
							<Ring value={vSummary?.avg_vitality ?? 0} max={1} color={accentVar.jade}
								center={fmt(vSummary?.avg_vitality, 2)} sub="avg" size={84} />
							<div class="col">
								<div class="big">{vSummary?.territory_count ?? '—'} <span class="unit">territories</span></div>
								<div class="phasebar">
									{#each phaseOrder as ph}
										{@const n = vSummary?.phases?.[ph] ?? 0}
										{#if n > 0}<span class="seg" style="flex:{n};background:{phaseColor[ph]}" title="{n} {ph}"></span>{/if}
									{/each}
								</div>
								<div class="legend">
									{#each phaseOrder as ph}
										{#if (vSummary?.phases?.[ph] ?? 0) > 0}
											<span><i style="background:{phaseColor[ph]}"></i>{vSummary.phases[ph]} {ph}</span>
										{/if}
									{/each}
								</div>
							</div>
						</div>
						<p class="tagline">How alive your territories are</p>
					</button>

					<!-- MOVEMENT -->
					<button class="card" style="--rgb:{accentRgb.azure};" onclick={() => (active = 'movement')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.azure}"></span><span class="ctitle">Movement</span>{#if moveLowConf}<span class="lc">early signal</span>{/if}<span class="chev">›</span></div>
						<div class="card-body">
							<div class="phase-badge" style="--rgb:{accentRgb.azure}">{cap(current?.phase ?? movement?.phase)}</div>
							<div class="spark-row"><Spark points={velocities} color={accentVar.azure} width={150} height={42} /></div>
							<div class="ministats">
								<span><b>{fmt(movement?.exploration_ratio, 2)}</b> exploration</span>
								<span><b>{fmt(movement?.avg_velocity, 3)}</b> velocity</span>
							</div>
						</div>
						<p class="tagline">How your mind is moving</p>
					</button>

					<!-- RHYTHM -->
					<button class="card" style="--rgb:{accentRgb.amethyst};" onclick={() => (active = 'rhythm')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.amethyst}"></span><span class="ctitle">Rhythm</span>{#if !rhythmHasSignal}<span class="lc">gathering</span>{/if}<span class="chev">›</span></div>
						<div class="card-body">
							{#if rhythmHasSignal}
								<div class="bands">
									{#each ['gamma', 'beta', 'alpha', 'theta', 'delta'] as band}
										{@const v = Number(rhythmValues[`harmonic_amplitude_${band}_k1`]) || 0}
										<div class="band"><span class="bandbar" style="height:{Math.min(100, v * 600)}%;background:{accentVar.amethyst}"></span></div>
									{/each}
								</div>
								<p class="muted">Harmonic signature across timescales</p>
							{:else}
								<div class="empty-rhythm">
									<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 12h3l2-6 4 14 3-10 2 4h4" /></svg>
									<p class="muted">Your rhythm sharpens as you keep capturing. A few more active days and the bands light up.</p>
								</div>
							{/if}
						</div>
						<p class="tagline">The cadence of your thinking</p>
					</button>

					<!-- MINDSCAPE -->
					<button class="card" style="--rgb:{accentRgb.aurum};" onclick={() => (active = 'mindscape')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.aurum}"></span><span class="ctitle">Mindscape</span><span class="chev">›</span></div>
						<div class="card-body">
							<div class="big">{audit?.total_territories ?? '—'} <span class="unit">territories</span></div>
							<div class="ministats wrap">
								<span><b>{audit?.total_connections ?? '—'}</b> links</span>
								<span><b>{fmt(audit?.m2_entropy, 2)}</b> spread</span>
								<span><b>{audit?.orphan_count ?? 0}</b> orphans</span>
								<span><b>{audit?.bridge_count ?? 0}</b> bridges</span>
							</div>
						</div>
						<p class="tagline">The shape of your inner world</p>
					</button>

					<!-- MILESTONES -->
					<button class="card wide" style="--rgb:{accentRgb.coral};" onclick={() => (active = 'milestones')}>
						<div class="card-head"><span class="dot" style="background:{accentVar.coral}"></span><span class="ctitle">Milestones</span><span class="count">{milestones.length}</span><span class="chev">›</span></div>
						<div class="card-body">
							{#if milestones.length}
								<p class="headline">{milestones[0].headline}</p>
								<p class="muted">{(milestones[0].window_start ?? '').slice(0, 10)} · {milestones.length} moment{milestones.length > 1 ? 's' : ''} your mind turned</p>
							{:else}
								<p class="muted">No turning points detected yet — they appear when your focus shifts decisively.</p>
							{/if}
						</div>
						<p class="tagline">Moments your mind turned</p>
					</button>
				</div>

				<p class="footnote">Computed from {vSummary?.territory_count ?? 0} territories across your conversations. Signals marked “early” / “gathering” are advisory until more data accrues.</p>
			{/if}
		{:else}
			<!-- ── DETAIL ───────────────────────────────────────────────────── -->
			{@const p = pillars.find((x) => x.key === active)!}
			<button class="back" onclick={() => (active = null)}>
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6" /></svg>
				Overview
			</button>
			<header class="detail-head" style="--rgb:{accentRgb[p.accent]}">
				<span class="dot lg" style="background:{accentVar[p.accent]}"></span>
				<div><h1>{p.label}</h1><p>{p.tagline}</p></div>
			</header>

			{#if active === 'vitality'}
				<div class="detail-grid">
					<div class="panel center-panel">
						<Ring value={vSummary?.avg_vitality ?? 0} max={1} color={accentVar.jade} center={fmt(vSummary?.avg_vitality, 2)} sub="avg vitality" size={120} stroke={11} />
						<div class="phase-counts">
							{#each phaseOrder as ph}
								<div class="pc"><span class="pc-n" style="color:{phaseColor[ph]}">{vSummary?.phases?.[ph] ?? 0}</span><span class="pc-l">{ph}</span></div>
							{/each}
						</div>
					</div>
					<div class="panel">
						<h3>Territories by vitality</h3>
						<ul class="terr-list">
							{#each territories.slice(0, 16) as t}
								<li>
									<span class="t-phase" style="background:{phaseColor[t.phase] ?? 'var(--color-text-tertiary)'}"></span>
									<span class="t-id">Territory {t.territory_id}</span>
									<span class="t-bar"><span style="width:{Math.round((t.vitality ?? 0) * 100)}%;background:{phaseColor[t.phase] ?? 'var(--color-text-tertiary)'}"></span></span>
									<span class="t-val">{fmt(t.vitality, 2)}</span>
								</li>
							{/each}
						</ul>
					</div>
				</div>

			{:else if active === 'movement'}
				<div class="detail-grid one">
					<div class="panel">
						<div class="row-between">
							<div><div class="phase-badge lg" style="--rgb:{accentRgb.azure}">{cap(current?.phase)}</div>{#if current?.phase_recent && current.phase_recent !== current.phase}<span class="muted sm">recently {current.phase_recent}</span>{/if}</div>
							{#if moveLowConf}<span class="lc">early signal · advisory</span>{/if}
						</div>
						<div class="big-spark"><Spark points={velocities} color={accentVar.azure} width={680} height={120} /></div>
						<p class="muted sm">Movement velocity across {trajectory.length} weekly windows — how far your attention's center of mass travelled each week.</p>
					</div>
					<div class="stat-row">
						<div class="stat"><span class="s-v">{fmt(movement?.exploration_ratio, 2)}</span><span class="s-l">exploration ratio</span></div>
						<div class="stat"><span class="s-v">{fmt(movement?.avg_velocity, 3)}</span><span class="s-l">avg velocity</span></div>
						<div class="stat"><span class="s-v">{movement?.peak_velocity?.date ?? '—'}</span><span class="s-l">peak day</span></div>
						<div class="stat"><span class="s-v">{movement?.window_count ?? '—'}</span><span class="s-l">windows</span></div>
					</div>
				</div>

			{:else if active === 'rhythm'}
				<div class="panel">
					{#if rhythmHasSignal}
						<h3>Harmonic amplitude across timescales</h3>
						<div class="bands lg">
							{#each ['gamma', 'beta', 'alpha', 'theta', 'delta'] as band}
								{@const v = Number(rhythmValues[`harmonic_amplitude_${band}_k1`]) || 0}
								<div class="band"><span class="bandbar" style="height:{Math.min(100, v * 600)}%;background:{accentVar.amethyst}"></span><span class="band-l">{band}</span></div>
							{/each}
						</div>
						<p class="muted sm">Bands are temporal aggregation scales, not EEG frequencies — gamma = per-message, delta = monthly.</p>
					{:else}
						<div class="empty-lg">
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2 12h4l2.5-7 4.5 16 3-12 2 3h4" /></svg>
							<h3>Your rhythm is still forming</h3>
							<p class="muted">The harmonic signature reads the cadence of your thinking across days and weeks. It needs a denser stretch of activity to resolve. Keep capturing — it sharpens with use.</p>
						</div>
					{/if}
				</div>

			{:else if active === 'mindscape'}
				<div class="stat-row four">
					<div class="stat"><span class="s-v">{audit?.total_territories ?? '—'}</span><span class="s-l">territories</span></div>
					<div class="stat"><span class="s-v">{audit?.total_connections ?? '—'}</span><span class="s-l">connections</span></div>
					<div class="stat"><span class="s-v">{fmt(audit?.m2_entropy, 2)}</span><span class="s-l">spread (M2 entropy)</span></div>
					<div class="stat"><span class="s-v">{fmt(audit?.degree_gini, 2)}</span><span class="s-l">concentration (Gini)</span></div>
					<div class="stat"><span class="s-v">{audit?.orphan_count ?? 0}</span><span class="s-l">orphans</span></div>
					<div class="stat"><span class="s-v">{audit?.bridge_count ?? 0}</span><span class="s-l">bridges</span></div>
				</div>
				<div class="panel cta-panel">
					<div><h3>Walk your mindscape</h3><p class="muted">See your territories laid out in space — what clusters, what bridges, what drifts alone.</p></div>
					<button class="cta" onclick={openMindscape}>Open the 3D map <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></svg></button>
				</div>

			{:else if active === 'milestones'}
				<div class="panel">
					{#if milestones.length}
						<ul class="mile-list">
							{#each milestones as m}
								<li>
									<span class="m-node" style="background:{accentVar.coral}"></span>
									<div class="m-body">
										<p class="m-head">{m.headline}</p>
										<p class="muted sm">{(m.window_start ?? '').slice(0, 10)} · {m.rule_type?.replace('_', ' ')}{#if m.phase_from} · {m.phase_from} → {m.phase_to}{/if}</p>
									</div>
								</li>
							{/each}
						</ul>
					{:else}
						<div class="empty-lg"><h3>No turning points yet</h3><p class="muted">Milestones mark the weeks your focus shifted decisively — a phase change, or an unusually fast move. They surface as your story accrues.</p></div>
					{/if}
				</div>
			{/if}
		{/if}
	</div>
</div>

<style>
	.curious { position: relative; height: 100%; overflow-y: auto; overflow-x: hidden; background: var(--color-bg); color: var(--color-text-primary); }
	.aurora { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; }
	.blob { position: absolute; width: 56vmax; height: 56vmax; border-radius: 50%; opacity: 0.4; will-change: transform; }
	.b1 { top: -24vmax; left: -16vmax; background: radial-gradient(circle, rgb(var(--color-accent-rgb) / 0.16), transparent 60%); animation: drift1 38s ease-in-out infinite; }
	.b2 { bottom: -28vmax; right: -18vmax; background: radial-gradient(circle, rgb(var(--color-accent-amethyst-rgb) / 0.16), transparent 60%); animation: drift2 46s ease-in-out infinite; }
	.b3 { top: 24%; left: 40%; width: 40vmax; height: 40vmax; background: radial-gradient(circle, rgb(var(--color-accent-aurum-rgb) / 0.10), transparent 62%); animation: drift3 54s ease-in-out infinite; }

	.inner { position: relative; z-index: 1; max-width: 64rem; margin: 0 auto; padding: clamp(2rem, 5vh, 3.5rem) clamp(1.1rem, 4vw, 2.5rem) 4rem; }

	.hero { text-align: center; max-width: 40rem; margin: 0 auto clamp(2rem, 4vh, 3rem); }
	.overline { font-family: var(--font-mono); font-size: 0.68rem; letter-spacing: 0.4em; text-transform: uppercase; color: var(--color-accent-aurum); margin-bottom: 1rem; }
	.title { font-size: clamp(1.9rem, 4.5vw, 3rem); line-height: 1.06; letter-spacing: -0.025em; font-weight: 600; background: linear-gradient(112deg, var(--color-text-emphasis) 22%, var(--color-accent-aurum) 70%, var(--color-accent-amethyst) 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
	.lede { margin-top: 1rem; font-size: clamp(0.95rem, 1.4vw, 1.1rem); line-height: 1.6; color: var(--color-text-secondary); }

	/* ── Overview grid ── */
	.grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: clamp(0.8rem, 1.6vw, 1.1rem); }
	.card.wide { grid-column: 1 / -1; }
	.card {
		position: relative; text-align: left; display: flex; flex-direction: column; gap: 0.85rem;
		padding: 1.25rem 1.35rem 1.1rem; border-radius: var(--radius-lg);
		background: linear-gradient(160deg, rgb(var(--rgb) / 0.07), var(--color-surface) 62%);
		border: 1px solid var(--color-border); cursor: pointer; color: inherit;
		transition: transform var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
	}
	.card:hover { transform: translateY(-2px); border-color: rgb(var(--rgb) / 0.5); box-shadow: 0 12px 32px rgb(var(--rgb) / 0.12); }
	.card:focus-visible { outline: 2px solid rgb(var(--rgb) / 0.8); outline-offset: 2px; }
	.card.skeleton { min-height: 168px; cursor: default; animation: pulse 1.5s ease-in-out infinite; }
	.card.skeleton:hover { transform: none; box-shadow: none; border-color: var(--color-border); }

	.card-head { display: flex; align-items: center; gap: 0.55rem; }
	.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; box-shadow: 0 0 10px currentColor; }
	.dot.lg { width: 12px; height: 12px; }
	.ctitle { font-size: 0.92rem; font-weight: 600; letter-spacing: -0.01em; color: var(--color-text-emphasis); }
	.chev { margin-left: auto; color: var(--color-text-tertiary); font-size: 1.2rem; line-height: 1; }
	.count, .lc { font-size: 0.62rem; font-weight: 600; letter-spacing: 0.05em; }
	.count { margin-left: auto; padding: 0.1rem 0.5rem; border-radius: var(--radius-full); background: rgb(var(--rgb) / 0.16); color: var(--color-text-emphasis); }
	.card-head .count + .chev { margin-left: 0.4rem; }
	.lc { margin-left: auto; text-transform: uppercase; color: var(--color-text-tertiary); padding: 0.12rem 0.5rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); }
	.card-head .lc + .chev { margin-left: 0.4rem; }

	.card-body { display: flex; flex-direction: column; gap: 0.6rem; min-height: 92px; }
	.card-body.two { flex-direction: row; align-items: center; gap: 1.1rem; }
	.col { display: flex; flex-direction: column; gap: 0.5rem; flex: 1; }
	.big { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.03em; color: var(--color-text-emphasis); }
	.big .unit { font-size: 0.8rem; font-weight: 400; color: var(--color-text-tertiary); letter-spacing: 0; }
	.tagline { font-size: 0.78rem; color: var(--color-text-tertiary); margin-top: auto; }

	.phasebar { display: flex; height: 9px; border-radius: var(--radius-full); overflow: hidden; gap: 2px; }
	.seg { display: block; border-radius: 2px; }
	.legend { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.72rem; color: var(--color-text-secondary); }
	.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 0.35rem; vertical-align: middle; }

	.phase-badge { align-self: flex-start; padding: 0.3rem 0.8rem; border-radius: var(--radius-full); font-size: 0.85rem; font-weight: 600; color: var(--color-text-emphasis); background: rgb(var(--rgb) / 0.16); border: 1px solid rgb(var(--rgb) / 0.4); }
	.phase-badge.lg { font-size: 1.1rem; padding: 0.4rem 1rem; }
	.spark-row { padding: 0.2rem 0; }
	.ministats { display: flex; gap: 1.1rem; font-size: 0.78rem; color: var(--color-text-secondary); }
	.ministats.wrap { flex-wrap: wrap; gap: 0.5rem 1.1rem; }
	.ministats b { color: var(--color-text-emphasis); font-weight: 600; }

	.bands { display: flex; align-items: flex-end; gap: 6px; height: 56px; }
	.band { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 4px; }
	.bandbar { width: 100%; max-width: 22px; border-radius: 3px 3px 0 0; min-height: 3px; transition: height 0.6s var(--ease-out); }
	.bands.lg { height: 140px; }
	.band-l { font-size: 0.6rem; color: var(--color-text-tertiary); text-transform: uppercase; letter-spacing: 0.05em; }
	.empty-rhythm { display: flex; align-items: center; gap: 0.8rem; color: var(--color-text-tertiary); }
	.empty-rhythm svg { width: 2rem; height: 2rem; flex: none; opacity: 0.6; }

	.headline { font-size: 1.05rem; font-weight: 500; color: var(--color-text-primary); line-height: 1.4; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; line-height: 1.5; }
	.muted.sm { font-size: 0.76rem; }
	.footnote { margin-top: 1.5rem; text-align: center; font-size: 0.72rem; color: var(--color-text-tertiary); }

	/* ── Detail ── */
	.back { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.4rem 0.7rem 0.4rem 0.45rem; margin-bottom: 1.2rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); background: var(--color-surface); color: var(--color-text-secondary); font-size: 0.82rem; cursor: pointer; transition: border-color var(--duration-fast), color var(--duration-fast); }
	.back:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
	.back svg { width: 1rem; height: 1rem; }
	.detail-head { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 1.5rem; }
	.detail-head h1 { font-size: 1.8rem; font-weight: 600; letter-spacing: -0.02em; }
	.detail-head p { color: var(--color-text-tertiary); font-size: 0.88rem; margin-top: 0.15rem; }

	.detail-grid { display: grid; grid-template-columns: 1fr 1.5fr; gap: 1rem; }
	.detail-grid.one { grid-template-columns: 1fr; }
	.panel { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: 1.4rem; }
	.panel h3 { font-size: 0.95rem; font-weight: 600; margin-bottom: 1rem; color: var(--color-text-emphasis); }
	.center-panel { display: flex; flex-direction: column; align-items: center; gap: 1.4rem; justify-content: center; }
	.phase-counts { display: flex; gap: 1.5rem; }
	.pc { text-align: center; } .pc-n { display: block; font-size: 1.6rem; font-weight: 600; } .pc-l { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-tertiary); }

	.terr-list { display: flex; flex-direction: column; gap: 0.5rem; }
	.terr-list li { display: grid; grid-template-columns: 10px 1fr 1fr auto; align-items: center; gap: 0.7rem; font-size: 0.82rem; }
	.t-phase { width: 8px; height: 8px; border-radius: 50%; }
	.t-id { color: var(--color-text-secondary); white-space: nowrap; }
	.t-bar { height: 6px; border-radius: var(--radius-full); background: rgb(255 255 255 / 0.06); overflow: hidden; }
	.t-bar span { display: block; height: 100%; border-radius: var(--radius-full); }
	.t-val { font-variant-numeric: tabular-nums; color: var(--color-text-emphasis); font-weight: 500; }

	.row-between { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
	.big-spark { margin: 0.5rem 0 0.8rem; }
	.stat-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.7rem; margin-top: 1rem; }
	.stat-row.four { grid-template-columns: repeat(3, 1fr); }
	.stat { background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.9rem 1rem; text-align: center; }
	.s-v { display: block; font-size: 1.3rem; font-weight: 600; letter-spacing: -0.02em; color: var(--color-text-emphasis); font-variant-numeric: tabular-nums; }
	.s-l { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-tertiary); margin-top: 0.2rem; display: block; }

	.cta-panel { display: flex; align-items: center; justify-content: space-between; gap: 1.5rem; margin-top: 1rem; }
	.cta { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.7rem 1.3rem; border-radius: var(--radius-full); border: 1px solid rgb(var(--color-accent-aurum-rgb) / 0.4); background: rgb(var(--color-accent-aurum-rgb) / 0.12); color: var(--color-text-emphasis); font-size: 0.88rem; font-weight: 500; cursor: pointer; white-space: nowrap; transition: transform var(--duration-fast), border-color var(--duration-fast); }
	.cta:hover { transform: translateY(-1px); border-color: rgb(var(--color-accent-aurum-rgb) / 0.7); }
	.cta svg { width: 1rem; height: 1rem; }

	.mile-list { display: flex; flex-direction: column; gap: 0; }
	.mile-list li { display: grid; grid-template-columns: 14px 1fr; gap: 0.9rem; padding: 0.7rem 0; position: relative; }
	.mile-list li:not(:last-child)::before { content: ''; position: absolute; left: 6px; top: 1.4rem; bottom: -0.2rem; width: 1px; background: var(--color-border); }
	.m-node { width: 11px; height: 11px; border-radius: 50%; margin-top: 0.3rem; box-shadow: 0 0 10px currentColor; z-index: 1; }
	.m-head { font-size: 0.95rem; font-weight: 500; color: var(--color-text-primary); }

	.empty-lg { text-align: center; padding: 2rem 1rem; }
	.empty-lg svg { width: 3rem; height: 3rem; color: var(--color-accent-amethyst); opacity: 0.5; margin-bottom: 1rem; }
	.empty-lg h3 { font-size: 1.1rem; margin-bottom: 0.6rem; }
	.empty-lg p { max-width: 30rem; margin: 0 auto; }

	@keyframes drift1 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(6vmax,4vmax) scale(1.08); } }
	@keyframes drift2 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-5vmax,-3vmax) scale(1.1); } }
	@keyframes drift3 { 0%,100% { transform: translate(0,0) scale(1); } 50% { transform: translate(-4vmax,5vmax) scale(0.92); } }
	@keyframes pulse { 0%,100% { opacity: 0.5; } 50% { opacity: 0.8; } }

	@media (max-width: 760px) {
		.grid { grid-template-columns: 1fr; }
		.detail-grid { grid-template-columns: 1fr; }
		.stat-row, .stat-row.four { grid-template-columns: repeat(2, 1fr); }
	}
	@media (prefers-reduced-motion: reduce) { .blob { animation: none; } .card.skeleton { animation: none; } }
</style>
