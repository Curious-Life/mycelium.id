<script lang="ts">
	// Territory River — how your topics change over time. The reliable spine of the
	// Curious Life page: two time-synced tracks sharing one x-axis —
	//   Track 1: the topic stream — anchor (persistent) territories as named bands,
	//            their weekly activation share stacked; the faint top band is "other".
	//            Each band carries its current standing: anchor / active / dormant.
	//   Track 2: the count of active territories per week (area + line).
	// Plus toggleable novelty overlays (text gzip + path LZ76) and hover-to-inspect.
	// Built from robust counts/shares only — does NOT lean on Fisher velocity.
	// Hand-rolled SVG (no WebGL / no chart lib) for WKWebView safety.
	type Any = Record<string, any>;
	let { data = null, hoverDate = $bindable<string | null>(null) }: { data: Any | null; hoverDate?: string | null } = $props();

	const ACCENTS = [
		'var(--color-accent-jade)', 'var(--color-accent)', 'var(--color-accent-amethyst)',
		'var(--color-accent-aurum)', 'var(--color-accent-coral)', 'var(--color-accent-teal)',
		'var(--color-accent-rose)',
	];

	// Layout (viewBox units).
	const W = 1000, H = 360;
	const ML = 6, MR = 6, MT = 8, MB = 26;
	const GAP = 18;
	const PW = W - ML - MR;
	const T1 = MT, H1 = 192;
	const T2 = T1 + H1 + GAP, H2 = H - MB - T2;

	let showCount = $state(true);
	let showText = $state(false);
	let showPath = $state(false);
	// hoverIdx derives from the shared hoverDate (defined after dateIndex) so the
	// cursor stays in sync with the other graphs on the page.

	const weeks = $derived<Any[]>(data?.weeks ?? []);
	// Merge anchors that share a NAME. Re-clustering across eras can produce several
	// distinct territory ids the describe step named identically (e.g. three
	// "Sovereign Inquiry Lifelines"), which showed up as duplicate legend rows + bands.
	// Collapse them into one topic: sum the per-week series, keep the strongest
	// standing (anchor > active > dormant). One band + one legend row per named topic.
	const STATUS_RANK: Record<string, number> = { anchor: 3, active: 2, dormant: 1, unknown: 0 };
	const anchors = $derived.by<Any[]>(() => {
		const raw = data?.anchors ?? [];
		const byName = new Map<string, Any>();
		for (const a of raw) {
			const key = a.name ?? `#${a.territory_id}`;
			const ex = byName.get(key);
			if (!ex) {
				byName.set(key, { ...a, series: [...(a.series ?? [])] });
			} else {
				const s = ex.series, add = a.series ?? [];
				for (let i = 0; i < Math.max(s.length, add.length); i++) s[i] = (Number(s[i]) || 0) + (Number(add[i]) || 0);
				if ((STATUS_RANK[a.status] ?? 0) > (STATUS_RANK[ex.status] ?? 0)) ex.status = a.status;
				ex.named = ex.named || a.named;
			}
		}
		return [...byName.values()];
	});
	const n = $derived(weeks.length);
	const x = (i: number) => (n <= 1 ? ML : ML + (i / (n - 1)) * PW);

	// dormant bands render fainter so the river shows standing, not just share.
	// Solid-ish fills (+ a hairline separator between bands, drawn below) so the
	// STACK reads as stacked area, not translucent overlapping ribbons.
	const bandOpacity = (a: Any) => (a.status === 'dormant' ? 0.4 : 0.82);

	// Per-week 100%-normalised stack: each anchor's band is its SHARE OF THAT WEEK'S
	// anchor activity, so the coloured layers fill the whole track and visibly stack
	// on top of one another (rather than a thin cluster hugging the baseline with a
	// dominant faint "other" above). `raw` keeps the un-normalised weekly total so a
	// week with no anchor activity renders empty instead of a fake full stack.
	const stacks = $derived.by(() => {
		if (!n || !anchors.length) return [];
		return weeks.map((_, i) => {
			const vals = anchors.map((a) => Math.max(0, Number(a.series?.[i]) || 0));
			const raw = vals.reduce((s, v) => s + v, 0);
			const norm = raw > 0 ? raw : 1;
			let cum = 0;
			const tops = vals.map((v) => { cum += v / norm; return cum; });
			return { tops, sum: raw > 0 ? 1 : 0, raw };
		});
	});
	const yShare = (c: number) => T1 + H1 * (1 - Math.max(0, Math.min(1, c)));

	function bandPath(b: number): string {
		if (!stacks.length) return '';
		const top: string[] = []; const bot: string[] = [];
		for (let i = 0; i < n; i++) {
			top.push(`${x(i).toFixed(1)},${yShare(stacks[i].tops[b]).toFixed(1)}`);
			bot.push(`${x(i).toFixed(1)},${yShare(b === 0 ? 0 : stacks[i].tops[b - 1]).toFixed(1)}`);
		}
		return `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;
	}
	const otherPath = $derived.by(() => {
		if (!stacks.length) return '';
		const top: string[] = []; const bot: string[] = [];
		for (let i = 0; i < n; i++) {
			top.push(`${x(i).toFixed(1)},${yShare(1).toFixed(1)}`);
			bot.push(`${x(i).toFixed(1)},${yShare(stacks[i].sum).toFixed(1)}`);
		}
		return `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;
	});

	const counts = $derived(weeks.map((w) => Number(w.active_count) || 0));
	const maxCount = $derived(Math.max(1, ...counts));
	const yCount = (c: number) => T2 + H2 * (1 - c / maxCount);
	const countLine = $derived(counts.map((c, i) => `${x(i).toFixed(1)},${yCount(c).toFixed(1)}`).join(' L'));
	const countArea = $derived(
		counts.length ? `M${x(0).toFixed(1)},${(T2 + H2).toFixed(1)} L${countLine} L${x(n - 1).toFixed(1)},${(T2 + H2).toFixed(1)} Z` : '',
	);

	const dateIndex = $derived.by(() => {
		const m: Record<string, number> = {};
		weeks.forEach((w, i) => { m[w.end] = i; });
		return m;
	});
	const hoverIdx = $derived(hoverDate != null && dateIndex[hoverDate] != null ? dateIndex[hoverDate] : null);
	function noveltyLine(series: Any[]): string {
		if (!series?.length) return '';
		const pts: string[] = [];
		for (const p of series) {
			const i = dateIndex[p.end];
			if (i == null || p.value == null) continue;
			const v = Math.max(0, Math.min(1, Number(p.value)));
			pts.push(`${x(i).toFixed(1)},${(T2 + H2 * (1 - v)).toFixed(1)}`);
		}
		return pts.length ? `M${pts.join(' L')}` : '';
	}
	const textLine = $derived(showText ? noveltyLine(data?.novelty?.text ?? []) : '');
	const pathLine = $derived(showPath ? noveltyLine(data?.novelty?.path ?? []) : '');

	const ticks = $derived.by(() => {
		const out: { i: number; label: string }[] = [];
		let lastYear = '';
		weeks.forEach((w, i) => {
			const y = String(w.end || '').slice(0, 4);
			if (y && y !== lastYear) { out.push({ i, label: y }); lastYear = y; }
		});
		return out;
	});
	const hasData = $derived(n > 1 && anchors.length > 0);

	// Hover-to-inspect: map cursor x to a week index; build a small per-week readout.
	function onMove(e: PointerEvent) {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / (rect.width || 1)));
		hoverDate = weeks[Math.round(frac * (n - 1))]?.end ?? null;
	}
	const hoverWeek = $derived(hoverIdx != null && weeks[hoverIdx] ? weeks[hoverIdx] : null);
	const hoverTop = $derived.by(() => {
		if (hoverIdx == null) return [];
		const raw = anchors.map((a, b) => ({ name: a.name, status: a.status, val: Math.max(0, Number(a.series?.[hoverIdx!]) || 0), color: ACCENTS[b % ACCENTS.length] }));
		const total = raw.reduce((s, t) => s + t.val, 0) || 1;
		// share = fraction of THIS WEEK's anchor activity (matches the normalised stack),
		// sorted most-active first, named. Show up to 8 so the tooltip lists real names.
		return raw
			.map((t) => ({ ...t, share: t.val / total }))
			.filter((t) => t.val > 0.0001)
			.sort((a, b) => b.share - a.share)
			.slice(0, 8);
	});
	const STATUS_LABEL: Record<string, string> = { anchor: 'anchor', active: 'active', dormant: 'dormant', unknown: '' };
</script>

{#if hasData}
	<div class="river">
		<div class="legend">
			{#each anchors as a, b}
				<span class="lg-item" class:faded={a.status === 'dormant'}>
					<i style="background:{ACCENTS[b % ACCENTS.length]};opacity:{a.status === 'dormant' ? 0.4 : 1}"></i>
					<span class="lg-name">{a.name}{#if !a.named}<em> (unnamed)</em>{/if}</span>
					{#if STATUS_LABEL[a.status]}<span class="st st-{a.status}">{STATUS_LABEL[a.status]}</span>{/if}
				</span>
			{/each}
			<span class="lg-item other"><i></i>other</span>
		</div>

		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div class="plot" onpointermove={onMove} onpointerleave={() => (hoverDate = null)}>
			<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="Territory activation over time, with active-territory count and novelty overlays">
				{#each anchors as a, b}
					<path d={bandPath(b)} fill={ACCENTS[b % ACCENTS.length]} fill-opacity={bandOpacity(a)} stroke="var(--color-bg)" stroke-width="0.6" stroke-opacity="0.55" vector-effect="non-scaling-stroke" />
				{/each}
				<path d={otherPath} fill="var(--color-text-tertiary)" fill-opacity="0.1" stroke="none" />

				<text x={ML} y={T1 + 12} class="trk">topics — share of weekly anchor activity (stacked to 100%)</text>
				<text x={ML} y={T2 - 4} class="trk">active territories / week (peak {maxCount})</text>

				<path d={countArea} fill="var(--color-accent-jade)" fill-opacity="0.10" stroke="none" />
				{#if showCount}<path d={`M${countLine}`} fill="none" stroke="var(--color-accent-jade)" stroke-width="1.4" />{/if}

				{#if textLine}<path d={textLine} fill="none" stroke="var(--color-accent-coral)" stroke-width="1.2" stroke-dasharray="4 3" />{/if}
				{#if pathLine}<path d={pathLine} fill="none" stroke="var(--color-accent-amethyst)" stroke-width="1.2" stroke-dasharray="2 2" />{/if}

				{#if hoverIdx != null}
					<line x1={x(hoverIdx)} y1={T1} x2={x(hoverIdx)} y2={T2 + H2} stroke="var(--color-text-emphasis)" stroke-width="1" stroke-opacity="0.5" />
				{/if}

				{#each ticks as t}
					<line x1={x(t.i)} y1={H - MB} x2={x(t.i)} y2={H - MB + 4} stroke="var(--color-border)" stroke-width="1" />
					<text x={x(t.i)} y={H - MB + 15} class="xt">{t.label}</text>
				{/each}
			</svg>

			{#if hoverWeek}
				{@const frac = hoverIdx! / Math.max(1, n - 1)}
				<div class="tip" class:flip={frac > 0.6} style="left:{(frac * 100).toFixed(1)}%;">
					<div class="tip-h">{hoverWeek.end} · {hoverWeek.active_count ?? '—'} active territories</div>
					{#each hoverTop as t}
						<div class="tip-row"><i style="background:{t.color}"></i><span class="tip-n">{t.name}</span><span class="tip-v">{Math.round(t.share * 100)}%</span></div>
					{/each}
					{#if !hoverTop.length}<div class="tip-row muted">no anchor topics active</div>{/if}
				</div>
			{/if}
		</div>

		<div class="toggles">
			<button class:on={showCount} onclick={() => (showCount = !showCount)}><i style="background:var(--color-accent-jade)"></i>active count</button>
			<button class:on={showText} onclick={() => (showText = !showText)}><i class="dash coral"></i>text novelty</button>
			<button class:on={showPath} onclick={() => (showPath = !showPath)}><i class="dash amethyst"></i>path novelty</button>
		</div>
	</div>
{:else}
	<div class="river-empty">
		<p class="muted">Your topic river forms once a few weeks of activity are mapped. It draws from the territory-activation trajectory — the most reliable layer we have.</p>
	</div>
{/if}

<style>
	.river { display: flex; flex-direction: column; gap: 0.5rem; }
	.plot { position: relative; }
	.plot svg { width: 100%; height: auto; display: block; }
	.legend { display: flex; flex-wrap: wrap; gap: 0.4rem 0.9rem; font-size: 0.72rem; color: var(--color-text-secondary); }
	.lg-item { display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap; max-width: 16rem; }
	.lg-item.faded { opacity: 0.65; }
	.lg-item i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
	.lg-name { overflow: hidden; text-overflow: ellipsis; }
	.lg-item.other i { background: var(--color-text-tertiary); opacity: 0.4; }
	.lg-item em { color: var(--color-text-tertiary); font-style: normal; }
	.st { font-size: 0.56rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.06rem 0.34rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); flex: none; }
	.st-anchor { color: var(--color-accent-aurum); border-color: rgb(var(--color-accent-aurum-rgb) / 0.4); }
	.st-active { color: var(--color-accent-jade); border-color: rgb(var(--color-accent-jade-rgb) / 0.4); }
	.st-dormant { color: var(--color-text-tertiary); }
	.trk { fill: var(--color-text-tertiary); font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase; }
	.xt { fill: var(--color-text-tertiary); font-size: 9px; text-anchor: middle; }
	.toggles { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.toggles button { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; padding: 0.25rem 0.6rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); background: transparent; color: var(--color-text-tertiary); cursor: pointer; transition: color var(--duration-fast), border-color var(--duration-fast); }
	.toggles button.on { color: var(--color-text-emphasis); border-color: var(--color-text-tertiary); }
	.toggles button i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
	.toggles button i.dash { border-radius: 0; height: 0; border-top: 2px dashed; width: 12px; }
	.toggles button i.dash.coral { border-color: var(--color-accent-coral); }
	.toggles button i.dash.amethyst { border-color: var(--color-accent-amethyst); }
	.tip { position: absolute; top: 0; transform: translateX(12px); pointer-events: none; background: var(--color-elevated); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.5rem 0.6rem; font-size: 0.72rem; min-width: 11rem; max-width: 16rem; box-shadow: 0 8px 24px rgb(0 0 0 / 0.35); z-index: 2; }
	/* Edge-aware: near the right edge, anchor the tooltip to the LEFT of the cursor
	   so it stays inside the chart (and the app window) instead of overflowing. */
	.tip.flip { transform: translateX(calc(-100% - 12px)); }
	.tip-h { color: var(--color-text-emphasis); font-weight: 600; margin-bottom: 0.35rem; }
	.tip-row { display: flex; align-items: center; gap: 0.4rem; padding: 0.1rem 0; }
	.tip-row i { width: 8px; height: 8px; border-radius: 2px; flex: none; }
	.tip-n { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-text-secondary); }
	.tip-v { color: var(--color-text-emphasis); font-variant-numeric: tabular-nums; }
	.tip-row.muted { color: var(--color-text-tertiary); }
	.river-empty { padding: 1.5rem; border: 1px dashed var(--color-border); border-radius: var(--radius-lg); text-align: center; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; line-height: 1.5; max-width: 34rem; margin: 0 auto; }
</style>
