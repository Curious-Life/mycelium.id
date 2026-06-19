<script lang="ts">
	// SourceCatalog — "what you can bring into Mycelium", icons-first, minimal text.
	// One component for both onboarding (expandable) and Streams → Sources. Honest
	// status grouping (Upload now / Connect / Coming soon); click a tile to reveal
	// how to get that data; a docs link for the full guide. Data: $lib/import/catalog.
	import { SOURCE_CATALOG, STATUS_LABEL, DOCS_URL, type ImportStatus, type SourceEntry } from '$lib/import/catalog';

	let { compact = false }: { compact?: boolean } = $props();

	let expandedId = $state<string | null>(null);
	const toggle = (id: string) => { expandedId = expandedId === id ? null : id; };

	// Swap the `"C"` colour sentinel in a logo for the entry's brand hue.
	const colored = (logo: string, color: string) => logo.replace(/="C"/g, `="${color}"`);

	const ORDER: ImportStatus[] = ['upload', 'connect', 'soon'];
	const groups = ORDER
		.map((status) => ({ status, items: SOURCE_CATALOG.filter((s) => s.status === status) }))
		.filter((g) => g.items.length > 0);
</script>

<div class="catalog" class:compact>
	{#each groups as g (g.status)}
		<div class="group">
			<span class="group-label">
				<span class="dot" class:upload={g.status === 'upload'} class:connect={g.status === 'connect'} class:soon={g.status === 'soon'}></span>
				{STATUS_LABEL[g.status]}
			</span>
			<div class="grid">
				{#each g.items as s (s.id)}
					<button
						class="tile"
						class:open={expandedId === s.id}
						class:soon={s.status === 'soon'}
						title={s.name}
						aria-expanded={expandedId === s.id}
						onclick={() => toggle(s.id)}
					>
						<span class="logo" style="--brand:{s.color}">{@html colored(s.logo, s.color)}</span>
						<span class="name">{s.name}</span>
					</button>
				{/each}
			</div>
			{#each g.items as s (s.id)}
				{#if expandedId === s.id}
					<div class="detail">
						<span class="detail-logo" style="--brand:{s.color}">{@html colored(s.logo, s.color)}</span>
						<div class="detail-text">
							<span class="detail-name">{s.name} <em class="detail-status">· {STATUS_LABEL[s.status]}</em></span>
							<span class="detail-blurb">{s.blurb}</span>
							<span class="detail-howto">{s.howto}</span>
						</div>
					</div>
				{/if}
			{/each}
		</div>
	{/each}

	<a class="docs-link" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
		See the full guide — how to export from each source →
	</a>
</div>

<style>
	.catalog { display: flex; flex-direction: column; gap: 1rem; }
	.group { display: flex; flex-direction: column; gap: 0.5rem; }
	.group-label {
		display: inline-flex; align-items: center; gap: 0.4rem;
		font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase;
		color: var(--color-text-tertiary);
	}
	.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-text-tertiary); }
	.dot.upload { background: var(--color-accent-jade); }
	.dot.connect { background: var(--color-accent); }
	.dot.soon { background: var(--color-text-tertiary); }

	.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 0.5rem; }
	.compact .grid { grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); }

	.tile {
		display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
		padding: 0.75rem 0.4rem; cursor: pointer; font-family: inherit;
		background: var(--glass-card-bg); border: 1px solid var(--glass-border); border-radius: 11px;
		color: var(--color-text-secondary);
		transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
	}
	.tile:hover { transform: translateY(-2px); border-color: rgba(229, 184, 76, 0.4); background: var(--glass-card-hover); }
	.tile.open { border-color: rgba(229, 184, 76, 0.55); background: var(--glass-card-hover); }
	.tile.soon { opacity: 0.62; }
	.tile.soon:hover { opacity: 0.85; }
	.logo { width: 26px; height: 26px; display: inline-flex; }
	.logo :global(svg) { width: 100%; height: 100%; }
	.name { font-size: 0.68rem; color: var(--color-text-primary); text-align: center; line-height: 1.2; }

	.detail {
		display: flex; align-items: flex-start; gap: 0.7rem;
		padding: 0.7rem 0.85rem; border-radius: 10px;
		background: var(--glass-card-bg); border: 1px solid var(--glass-border);
	}
	.detail-logo { width: 22px; height: 22px; flex-shrink: 0; display: inline-flex; }
	.detail-logo :global(svg) { width: 100%; height: 100%; }
	.detail-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
	.detail-name { font-size: 0.78rem; font-weight: 600; color: var(--color-text-primary); }
	.detail-status { font-weight: 400; font-style: normal; color: var(--color-text-tertiary); font-size: 0.7rem; }
	.detail-blurb { font-size: 0.72rem; color: var(--color-text-secondary); }
	.detail-howto { font-size: 0.7rem; color: var(--color-text-tertiary); line-height: 1.45; }

	.docs-link {
		font-size: 0.72rem; color: var(--color-accent-aurum); text-decoration: none; align-self: flex-start;
	}
	.docs-link:hover { text-decoration: underline; }
</style>
