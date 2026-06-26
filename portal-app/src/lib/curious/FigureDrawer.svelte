<script lang="ts">
	// Kindred-mind detail — slides in when you click a figure in the resonance section.
	// Shows the figure's profile (their realms → topics + cognitive signature) and WHERE YOU
	// RESONATE (your territory ↔ their realm). Matching runs server-side; the response carries
	// names + affinities + public figure data only — no centroid ever reaches the client.
	import Drawer from '$lib/components/Drawer.svelte';
	import Ring from '$lib/curious/Ring.svelte';
	import { apiGet } from '$lib/api';

	type Any = Record<string, any>;
	let { open = false, name = '', accent = 'amethyst', seedAffinity = null, onClose = () => {} }:
		{ open?: boolean; name?: string; accent?: string; seedAffinity?: number | null; onClose?: () => void } = $props();

	const ACCENT: Record<string, string> = {
		jade: 'var(--color-accent-jade)', azure: 'var(--color-accent)', amethyst: 'var(--color-accent-amethyst)',
		aurum: 'var(--color-accent-aurum)', coral: 'var(--color-accent-coral)', teal: 'var(--color-accent-teal)', rose: 'var(--color-accent-rose)',
	};
	const accentColor = $derived(ACCENT[accent] ?? ACCENT.amethyst);
	const COG_LABEL: Record<string, string> = {
		integrative_complexity: 'Integrative', abstraction_level: 'Abstraction', epistemic_breadth: 'Breadth',
		systematic_rigor: 'Rigor', creative_latitude: 'Creativity', metacognitive_awareness: 'Metacognition',
		agency: 'Agency', emotional_register: 'Emotion',
	};

	let data = $state<Any | null>(null);
	let loading = $state(false);
	let failed = $state(false);
	let lastKey = '';

	$effect(() => {
		if (open && name && name !== lastKey) {
			lastKey = name; loading = true; failed = false; data = null;
			apiGet<Any>(`/portal/curious/resonance/figure?name=${encodeURIComponent(name)}`)
				.then((d) => { data = d?.available ? d : null; failed = !d?.available; loading = false; })
				.catch(() => { failed = true; loading = false; });
		}
		if (!open) lastKey = '';
	});

	const ring = $derived(seedAffinity ?? data?.affinity ?? null);
	const lifespan = $derived(data ? [data.birth_year, data.death_year].filter((y: Any) => y != null).join('–') : '');
	const metaLine = $derived(data ? [lifespan, data.region, data.primary_domain || data.domain].filter(Boolean).join(' · ') : '');
	const cogDims = $derived(data?.cognitive ? Object.entries(data.cognitive as Record<string, number>).sort((a, b) => b[1] - a[1]) : []);
</script>

<Drawer {open} {onClose} title="Kindred mind">
	{#if loading}
		<p class="fd-muted">Reading their mind…</p>
	{:else if !data}
		<p class="fd-muted">{failed ? 'This figure’s portrait isn’t available yet.' : 'Select a figure to see how you resonate.'}</p>
	{:else}
		<header class="fd-head">
			{#if ring != null}<Ring value={ring} max={100} size={58} stroke={6} color={accentColor} center={`${ring}`} sub="match" />{/if}
			<div class="fd-id">
				<div class="fd-name">{data.name}</div>
				{#if metaLine}<div class="fd-meta">{metaLine}</div>{/if}
				<div class="fd-chips">
					{#if data.constellation}<span class="fd-chip" style="--c:{accentColor}">{data.constellation.replace('The ', '')}</span>{/if}
					{#if data.sourcing}<span class="fd-chip fd-chip-soft">{data.sourcing}</span>{/if}
				</div>
			</div>
		</header>

		{#if data.overlap?.length}
			<section class="fd-sec fd-resonance" style="--c:{accentColor}">
				<h4 class="fd-h">Where you resonate</h4>
				{#each data.overlap as o}
					<div class="fd-pair">
						<div class="fd-pair-t"><span class="fd-yours">{o.yourTerritory}</span><span class="fd-arrow">↔</span><span class="fd-theirs">{o.theirRealm}</span></div>
						<div class="fd-bar"><span style="width:{o.affinity}%"></span></div>
					</div>
				{/each}
			</section>
		{:else}
			<section class="fd-sec"><h4 class="fd-h">Where you resonate</h4><p class="fd-muted sm">As more of your map forms, your resonance with this figure will surface here.</p></section>
		{/if}

		{#if data.realms?.length}
			<section class="fd-sec">
				<h4 class="fd-h">Their mind</h4>
				{#each data.realms as r}
					<div class="fd-realm">
						<div class="fd-realm-h"><span class="fd-realm-name">{r.name}</span>{#if r.lean}<span class="fd-lean" class:inner={r.lean === 'inner'}>{r.lean}</span>{/if}</div>
						{#if r.essence}<p class="fd-essence">{r.essence}</p>{/if}
						{#if r.territories?.length}<div class="fd-terrs">{#each r.territories as t}<span class="fd-terr">{t}</span>{/each}</div>{/if}
					</div>
				{/each}
			</section>
		{/if}

		{#if cogDims.length}
			<section class="fd-sec">
				<h4 class="fd-h">Cognitive signature</h4>
				<div class="fd-cog">
					{#each cogDims as [k, v]}
						<div class="fd-cog-row"><span class="fd-cog-l">{COG_LABEL[k] ?? k}</span><div class="fd-cog-bar"><span style="width:{Math.round(v * 100)}%"></span></div></div>
					{/each}
				</div>
			</section>
		{/if}

		<p class="fd-foot">Reminiscent of, not identity — resonances in how you both range across ideas, never a claim about who you are.</p>
	{/if}
</Drawer>

<style>
	.fd-muted { color: var(--color-text-secondary); }
	.fd-muted.sm { font-size: 0.82rem; }
	.fd-head { display: flex; gap: 0.9rem; align-items: center; }
	.fd-head :global(.ring-wrap) { flex: none; }
	.fd-id { min-width: 0; }
	.fd-name { font-size: 1.3rem; font-weight: 600; color: var(--color-text-emphasis); letter-spacing: -0.01em; line-height: 1.15; }
	.fd-meta { font-size: 0.82rem; color: var(--color-text-secondary); margin-top: 0.15rem; }
	.fd-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.5rem; }
	.fd-chip { font-size: 0.72rem; padding: 0.12rem 0.55rem; border-radius: 999px; color: var(--c, var(--color-accent-amethyst)); border: 1px solid color-mix(in srgb, var(--c, var(--color-accent-amethyst)) 40%, transparent); }
	.fd-chip-soft { color: var(--color-text-tertiary); border-color: var(--color-border); }

	.fd-sec { margin-top: 1.4rem; }
	.fd-h { font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); margin: 0 0 0.7rem; }
	.fd-resonance { padding: 0.9rem; border-radius: var(--radius-md); background: color-mix(in srgb, var(--c) 7%, var(--color-elevated)); }
	.fd-resonance .fd-h { color: color-mix(in srgb, var(--c) 70%, var(--color-text-secondary)); }
	.fd-pair { margin-bottom: 0.7rem; }
	.fd-pair:last-child { margin-bottom: 0; }
	.fd-pair-t { font-size: 0.84rem; color: var(--color-text-primary); display: flex; gap: 0.4rem; align-items: baseline; flex-wrap: wrap; }
	.fd-yours { color: var(--color-text-emphasis); }
	.fd-arrow { color: var(--color-text-tertiary); }
	.fd-theirs { color: var(--color-text-secondary); }
	.fd-bar { height: 5px; border-radius: 3px; background: var(--color-border); margin-top: 0.32rem; overflow: hidden; }
	.fd-bar > span { display: block; height: 100%; border-radius: 3px; background: var(--c); }

	.fd-realm { padding: 0.6rem 0; border-top: 1px solid var(--color-border); }
	.fd-realm:first-of-type { border-top: none; padding-top: 0; }
	.fd-realm-h { display: flex; align-items: center; gap: 0.5rem; }
	.fd-realm-name { font-size: 0.9rem; font-weight: 600; color: var(--color-text-emphasis); }
	.fd-lean { font-size: 0.64rem; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--color-border); color: var(--color-text-tertiary); text-transform: lowercase; }
	.fd-lean.inner { background: color-mix(in srgb, var(--color-accent-amethyst) 18%, transparent); color: var(--color-accent-amethyst); }
	.fd-essence { font-size: 0.8rem; line-height: 1.5; color: var(--color-text-secondary); margin: 0.3rem 0 0; }
	.fd-terrs { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.45rem; }
	.fd-terr { font-size: 0.72rem; padding: 0.15rem 0.5rem; border-radius: var(--radius-md); border: 1px solid var(--color-border); color: var(--color-text-secondary); }

	.fd-cog { display: grid; grid-template-columns: 1fr 1fr; gap: 0.45rem 1rem; }
	.fd-cog-row { display: flex; align-items: center; gap: 0.5rem; }
	.fd-cog-l { font-size: 0.76rem; color: var(--color-text-secondary); width: 5.4rem; flex: none; }
	.fd-cog-bar { flex: 1; height: 4px; border-radius: 3px; background: var(--color-border); overflow: hidden; }
	.fd-cog-bar > span { display: block; height: 100%; background: var(--color-text-tertiary); border-radius: 3px; }

	.fd-foot { font-size: 0.72rem; line-height: 1.5; color: var(--color-text-tertiary); margin: 1.5rem 0 0; padding-top: 0.9rem; border-top: 1px solid var(--color-border); }
</style>
