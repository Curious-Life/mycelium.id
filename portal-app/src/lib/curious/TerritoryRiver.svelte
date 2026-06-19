<script lang="ts">
	// Territory River — how your topics change over time. The reliable spine of the
	// Curious Life page: two time-synced tracks sharing one x-axis —
	//   Track 1: the topic stream — anchor (persistent) territories as named bands,
	//            their weekly activation share stacked; the faint top band is "other".
	//   Track 2: the count of active territories per week (area + line).
	// Plus toggleable novelty overlays (text gzip + path LZ76) on track 2.
	// Built from robust counts/shares only — does NOT lean on Fisher velocity.
	// Hand-rolled SVG (no WebGL / no chart lib) for WKWebView safety.
	type Any = Record<string, any>;
	let { data = null }: { data: Any | null } = $props();

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
	const T1 = MT, H1 = 192;                       // stream track
	const T2 = T1 + H1 + GAP, H2 = H - MB - T2;    // active-count track

	let showCount = $state(true);
	let showText = $state(false);
	let showPath = $state(false);

	const weeks = $derived<Any[]>(data?.weeks ?? []);
	const anchors = $derived<Any[]>(data?.anchors ?? []);
	const n = $derived(weeks.length);
	const x = (i: number) => (n <= 1 ? ML : ML + (i / (n - 1)) * PW);

	// Stream: cumulative stacked shares per week (bottom → top), then an "other" band.
	const stacks = $derived.by(() => {
		if (!n || !anchors.length) return [];
		return weeks.map((_, i) => {
			let cum = 0;
			const tops = anchors.map((a) => { cum += Math.max(0, Number(a.series?.[i]) || 0); return cum; });
			return { tops, sum: cum };
		});
	});
	const yShare = (c: number) => T1 + H1 * (1 - Math.max(0, Math.min(1, c)));

	// Build a polygon path for anchor band b (between cumulative b-1 and b).
	function bandPath(b: number): string {
		if (!stacks.length) return '';
		const top: string[] = []; const bot: string[] = [];
		for (let i = 0; i < n; i++) {
			const upper = stacks[i].tops[b];
			const lower = b === 0 ? 0 : stacks[i].tops[b - 1];
			top.push(`${x(i).toFixed(1)},${yShare(upper).toFixed(1)}`);
			bot.push(`${x(i).toFixed(1)},${yShare(lower).toFixed(1)}`);
		}
		return `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;
	}
	// "Other" band — from the anchors' sum up to 1.0.
	const otherPath = $derived.by(() => {
		if (!stacks.length) return '';
		const top: string[] = []; const bot: string[] = [];
		for (let i = 0; i < n; i++) {
			top.push(`${x(i).toFixed(1)},${yShare(1).toFixed(1)}`);
			bot.push(`${x(i).toFixed(1)},${yShare(stacks[i].sum).toFixed(1)}`);
		}
		return `M${top.join(' L')} L${bot.reverse().join(' L')} Z`;
	});

	// Active-territory count track.
	const counts = $derived(weeks.map((w) => Number(w.active_count) || 0));
	const maxCount = $derived(Math.max(1, ...counts));
	const yCount = (c: number) => T2 + H2 * (1 - c / maxCount);
	const countLine = $derived(counts.map((c, i) => `${x(i).toFixed(1)},${yCount(c).toFixed(1)}`).join(' L'));
	const countArea = $derived(
		counts.length ? `M${x(0).toFixed(1)},${(T2 + H2).toFixed(1)} L${countLine} L${x(n - 1).toFixed(1)},${(T2 + H2).toFixed(1)} Z` : '',
	);

	// Novelty overlays (0–1) drawn on track 2 by date, mapped onto the week axis.
	const dateIndex = $derived.by(() => {
		const m: Record<string, number> = {};
		weeks.forEach((w, i) => { m[w.end] = i; });
		return m;
	});
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

	// Year ticks for the x-axis.
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
</script>

{#if hasData}
	<div class="river">
		<div class="legend">
			{#each anchors as a, b}
				<span class="lg-item"><i style="background:{ACCENTS[b % ACCENTS.length]}"></i>{a.name}{#if !a.named}<em> (unnamed)</em>{/if}</span>
			{/each}
			<span class="lg-item other"><i></i>other</span>
		</div>

		<svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="Territory activation over time, with active-territory count and novelty overlays">
			<!-- stream track: anchor bands -->
			{#each anchors as _a, b}
				<path d={bandPath(b)} fill={ACCENTS[b % ACCENTS.length]} fill-opacity="0.62" stroke="none" />
			{/each}
			<path d={otherPath} fill="var(--color-text-tertiary)" fill-opacity="0.12" stroke="none" />

			<!-- track labels -->
			<text x={ML} y={T1 + 12} class="trk">topics — anchor activation share</text>
			<text x={ML} y={T2 - 4} class="trk">active territories / week (peak {maxCount})</text>

			<!-- active-count track -->
			<path d={countArea} fill="var(--color-accent-jade)" fill-opacity="0.10" stroke="none" />
			{#if showCount}<path d={`M${countLine}`} fill="none" stroke="var(--color-accent-jade)" stroke-width="1.4" />{/if}

			<!-- novelty overlays -->
			{#if textLine}<path d={textLine} fill="none" stroke="var(--color-accent-coral)" stroke-width="1.2" stroke-dasharray="4 3" />{/if}
			{#if pathLine}<path d={pathLine} fill="none" stroke="var(--color-accent-amethyst)" stroke-width="1.2" stroke-dasharray="2 2" />{/if}

			<!-- x-axis year ticks -->
			{#each ticks as t}
				<line x1={x(t.i)} y1={H - MB} x2={x(t.i)} y2={H - MB + 4} stroke="var(--color-border)" stroke-width="1" />
				<text x={x(t.i)} y={H - MB + 15} class="xt">{t.label}</text>
			{/each}
		</svg>

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
	.river svg { width: 100%; height: auto; display: block; }
	.legend { display: flex; flex-wrap: wrap; gap: 0.4rem 0.9rem; font-size: 0.72rem; color: var(--color-text-secondary); }
	.lg-item { display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap; max-width: 14rem; overflow: hidden; text-overflow: ellipsis; }
	.lg-item i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
	.lg-item.other i { background: var(--color-text-tertiary); opacity: 0.4; }
	.lg-item em { color: var(--color-text-tertiary); font-style: normal; }
	.trk { fill: var(--color-text-tertiary); font-size: 9px; letter-spacing: 0.04em; text-transform: uppercase; }
	.xt { fill: var(--color-text-tertiary); font-size: 9px; text-anchor: middle; }
	.toggles { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.toggles button { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; padding: 0.25rem 0.6rem; border-radius: var(--radius-full); border: 1px solid var(--color-border); background: transparent; color: var(--color-text-tertiary); cursor: pointer; transition: color var(--duration-fast), border-color var(--duration-fast); }
	.toggles button.on { color: var(--color-text-emphasis); border-color: var(--color-text-tertiary); }
	.toggles button i { width: 9px; height: 9px; border-radius: 2px; flex: none; }
	.toggles button i.dash { border-radius: 0; height: 0; border-top: 2px dashed; width: 12px; }
	.toggles button i.dash.coral { border-color: var(--color-accent-coral); }
	.toggles button i.dash.amethyst { border-color: var(--color-accent-amethyst); }
	.river-empty { padding: 1.5rem; border: 1px dashed var(--color-border); border-radius: var(--radius-lg); text-align: center; }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; line-height: 1.5; max-width: 34rem; margin: 0 auto; }
</style>
