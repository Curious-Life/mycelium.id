<script lang="ts">
	// Character Resonance — the self-knowledge mirror. Shows the historical /
	// literary / mythic figures a user's cognitive profile is *reminiscent of*:
	// headline matches, constellation affinity, by-area ("different rooms"), and
	// a resonance timeline (archetype evolution). See docs/CHARACTER-RESONANCE-DESIGN.md.
	// Pure lib calls (deterministic, client-safe) over the 2,000-figure atlas.
	// Hand-rolled markup (WKWebView-safe). Honesty: "reminiscent of", never "you are".
	import {
		resonanceMatch,
		resonanceByConstellation,
		matchAreas,
		matchTimeline,
		type UserProfile,
		type Domain,
	} from './characterResonance';

	let {
		profile = null,
		areaProfiles = null,
		timeline = null,
		topN = 5,
	}: {
		/** The user's overall cognitive profile (8 dims required). */
		profile?: UserProfile | null;
		/** One profile per life-area (e.g. realm name → profile) for the "rooms" view. */
		areaProfiles?: Record<string, UserProfile> | null;
		/** Ordered {label, profile} per time-window for the evolution view. */
		timeline?: { label: string; profile: UserProfile }[] | null;
		topN?: number;
	} = $props();

	const DOMAIN_COLOR: Record<Domain, string> = {
		Architects: 'var(--color-accent)',
		Seekers: 'var(--color-accent-amethyst)',
		Builders: 'var(--color-accent-aurum)',
		Weavers: 'var(--color-accent-jade)',
	};

	const matches = $derived(profile ? resonanceMatch(profile, { topN }) : []);
	const affinity = $derived(profile ? resonanceByConstellation(profile).slice(0, 6) : []);
	const areas = $derived(areaProfiles ? matchAreas(areaProfiles, { topN: 1 }) : []);
	const trajectory = $derived(timeline && timeline.length > 1 ? matchTimeline(timeline, { topN: 1 }) : null);

	/** "openness.ideas" → "ideas"; "systematic_rigor" → "systematic rigor". */
	function axisLabel(a: string): string {
		return a.split('.').pop()!.replace(/_/g, ' ');
	}
	function yrs(f: { birth_year: number | null; death_year: number | null; era: string }): string {
		if (f.birth_year == null) return f.era;
		const b = f.birth_year < 0 ? `${-f.birth_year} BCE` : `${f.birth_year}`;
		const d = f.death_year == null ? '' : f.death_year < 0 ? `–${-f.death_year} BCE` : `–${f.death_year}`;
		return `${b}${d}`;
	}
</script>

{#if !profile}
	<div class="cr-empty">
		<p class="muted">Your figure resonances form once enough of your thinking is mapped — the people across history and story whose minds move like yours.</p>
	</div>
{:else}
	<div class="cr">
		<!-- Headline: top figure matches -->
		<section class="cr-head">
			<h3 class="cr-title">Reminiscent of</h3>
			<p class="cr-sub muted">Figures whose cognitive profile resonates with yours — a mirror, not a verdict.</p>
			<div class="cards">
				{#each matches as m}
					<article class="card" style="--accent:{DOMAIN_COLOR[m.figure.domain]};">
						<div class="card-top">
							<span class="card-name">{m.figure.name}</span>
							<span class="card-aff">{m.affinity}%</span>
						</div>
						<div class="card-meta">{m.figure.constellation} · {yrs(m.figure)} · {m.figure.region}</div>
						<div class="card-drivers">
							{#each m.drivers as d}
								<span class="chip">{axisLabel(d.axis)}</span>
							{/each}
						</div>
					</article>
				{/each}
			</div>
		</section>

		<!-- Constellation affinity -->
		{#if affinity.length}
			<section class="cr-block">
				<h4 class="cr-h4">Your archetype affinity</h4>
				<div class="bars">
					{#each affinity as a}
						<div class="bar-row">
							<span class="bar-label">{a.constellation.replace('The ', '')}</span>
							<div class="bar-track">
								<div class="bar-fill" style="width:{a.affinity}%;background:{DOMAIN_COLOR[a.domain]};"></div>
							</div>
							<span class="bar-val">{a.affinity}%</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- By-area: different selves in different rooms -->
		{#if areas.length}
			<section class="cr-block">
				<h4 class="cr-h4">Across your life-areas</h4>
				<div class="area-grid">
					{#each areas as a}
						<div class="area">
							<div class="area-name muted">{a.area}</div>
							{#if a.top[0]}
								<div class="area-fig">{a.top[0].figure.name}</div>
								<div class="area-con">{a.dominantConstellation.replace('The ', '')} · {a.top[0].affinity}%</div>
							{:else}
								<div class="area-con muted">—</div>
							{/if}
						</div>
					{/each}
				</div>
			</section>
		{/if}

		<!-- Timeline: resonance evolution -->
		{#if trajectory}
			<section class="cr-block">
				<h4 class="cr-h4">How your resonance has moved</h4>
				{#if trajectory.drift.changed}
					<p class="cr-drift muted">
						From <strong>{trajectory.drift.from.replace('The ', '')}</strong>
						toward <strong>{trajectory.drift.to.replace('The ', '')}</strong> — descriptive movement, not progress.
					</p>
				{:else}
					<p class="cr-drift muted">Steady around <strong>{trajectory.drift.to.replace('The ', '')}</strong>.</p>
				{/if}
				<div class="stream">
					{#each trajectory.windows as w}
						<div class="stream-cell" title="{w.label}: {w.top[0]?.figure.name ?? ''}">
							<div class="stream-chip" style="background:{DOMAIN_COLOR[w.dominantDomain]};"></div>
							<span class="stream-con">{w.dominantConstellation.replace('The ', '')}</span>
							<span class="stream-label muted">{w.label}</span>
						</div>
					{/each}
				</div>
			</section>
		{/if}
	</div>
{/if}

<style>
	.cr { display: flex; flex-direction: column; gap: 1.4rem; }
	.cr-title { font-size: 1.05rem; font-weight: 600; color: var(--color-text-emphasis); margin: 0; letter-spacing: -0.02em; }
	.cr-sub { margin: 0.15rem 0 0.75rem; font-size: 0.8rem; }
	.cr-h4 { font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-text-tertiary); margin: 0 0 0.6rem; }
	.muted { color: var(--color-text-tertiary); }

	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.6rem; }
	.card { border: 1px solid var(--color-border); border-left: 3px solid var(--accent); border-radius: var(--radius-md); padding: 0.65rem 0.75rem; background: var(--color-elevated); display: flex; flex-direction: column; gap: 0.4rem; }
	.card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
	.card-name { font-weight: 600; color: var(--color-text-emphasis); letter-spacing: -0.01em; }
	.card-aff { font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 600; font-size: 0.9rem; }
	.card-meta { font-size: 0.72rem; color: var(--color-text-secondary); }
	.card-drivers { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.1rem; }
	.chip { font-size: 0.64rem; padding: 0.1rem 0.4rem; border-radius: 999px; background: rgb(255 255 255 / 0.05); color: var(--color-text-secondary); white-space: nowrap; }

	.bars { display: flex; flex-direction: column; gap: 0.35rem; }
	.bar-row { display: grid; grid-template-columns: 8.5rem 1fr 2.6rem; align-items: center; gap: 0.5rem; }
	.bar-label { font-size: 0.78rem; color: var(--color-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.bar-track { height: 8px; background: rgb(255 255 255 / 0.06); border-radius: 999px; overflow: hidden; }
	.bar-fill { height: 100%; border-radius: 999px; transition: width 0.7s var(--ease-out); }
	.bar-val { font-size: 0.72rem; font-variant-numeric: tabular-nums; color: var(--color-text-tertiary); text-align: right; }

	.area-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.5rem; }
	.area { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.55rem 0.65rem; }
	.area-name { font-size: 0.66rem; letter-spacing: 0.08em; text-transform: uppercase; }
	.area-fig { font-weight: 600; color: var(--color-text-emphasis); margin-top: 0.2rem; }
	.area-con { font-size: 0.72rem; color: var(--color-text-secondary); }

	.cr-drift { font-size: 0.8rem; margin: 0 0 0.6rem; }
	.cr-drift strong { color: var(--color-text-emphasis); font-weight: 600; }
	.stream { display: flex; flex-wrap: wrap; gap: 0.4rem; }
	.stream-cell { display: flex; flex-direction: column; align-items: center; gap: 0.2rem; min-width: 4.5rem; }
	.stream-chip { width: 100%; height: 6px; border-radius: 999px; }
	.stream-con { font-size: 0.72rem; color: var(--color-text-secondary); }
	.stream-label { font-size: 0.62rem; }

	.cr-empty { padding: 1.2rem; border: 1px dashed var(--color-border); border-radius: var(--radius-md); text-align: center; }
	.cr-empty .muted { font-size: 0.82rem; line-height: 1.5; }
</style>
