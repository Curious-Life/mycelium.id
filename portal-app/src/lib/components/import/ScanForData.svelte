<script lang="ts">
	// ScanForData — the dynamic counterpart to the static SourceCatalog. One button,
	// "Scan this Mac for data", asks the local backend what's on disk (Obsidian
	// vaults, Claude Code sessions — presence/counts/dates only, never content) and
	// offers one-click import of each. Claude Code gets a clean/full toggle. Used in
	// both onboarding (MindscapeInvite) and Streams → Sources (ImportView).
	import { scanSources, importDetected, AGENT_MODE_SOURCES, type DetectedSource } from '$lib/import/detect';
	import { SOURCE_CATALOG } from '$lib/import/catalog';

	let { compact = false, onImported = () => {} }: { compact?: boolean; onImported?: () => void } = $props();

	// Catalog lookup so a detected source reuses its brand logo/colour/name.
	const CAT = Object.fromEntries(SOURCE_CATALOG.map((s) => [s.id, s]));
	const colored = (logo: string, color: string) => logo.replace(/="C"/g, `="${color}"`);

	type Phase = 'idle' | 'scanning' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let scanErr = $state('');
	let found = $state<DetectedSource[]>([]);

	// Per-source UI state, keyed by source id.
	let mode = $state<Record<string, 'clean' | 'full'>>({});
	let busy = $state<Record<string, boolean>>({});
	let result = $state<Record<string, { ok: boolean; msg: string }>>({});
	// local-files: which categories to bring in (default = all detected).
	let cats = $state<Record<string, boolean>>({});

	const importable = $derived(found.filter((s) => s.found && s.importable));

	// Selected category keys for the local-files sweep (default any not toggled off).
	function selectedCats(s: DetectedSource): string[] {
		return (s.categories ?? []).map((c) => c.key).filter((k) => cats[`${s.source}:${k}`] !== false);
	}

	async function scan() {
		phase = 'scanning'; scanErr = '';
		try {
			found = await scanSources();
			phase = 'done';
		} catch (e: any) {
			scanErr = e?.message || 'Scan failed.'; phase = 'error';
		}
	}

	async function runImport(s: DetectedSource) {
		busy = { ...busy, [s.source]: true };
		result = { ...result, [s.source]: { ok: true, msg: '' } };
		try {
			const r = await importDetected(s, { mode: mode[s.source] ?? 'clean', categories: selectedCats(s) });
			const extra = r.skipped ? ` · ${r.skipped} already in vault` : '';
			result = { ...result, [s.source]: { ok: true, msg: `Imported ${r.detail}${extra}.` } };
			onImported();
		} catch (e: any) {
			result = { ...result, [s.source]: { ok: false, msg: e?.message || 'Import failed.' } };
		} finally {
			busy = { ...busy, [s.source]: false };
		}
	}

	function rangeLabel(s: DetectedSource): string {
		const [a, b] = s.dateRange ?? [];
		if (!a && !b) return '';
		const ya = a?.slice(0, 4), yb = b?.slice(0, 4);
		return ya && yb ? (ya === yb ? ya : `${ya}–${yb}`) : (ya || yb || '');
	}
</script>

<div class="scan" class:compact>
	{#if phase === 'idle' || phase === 'scanning' || phase === 'error'}
		<button class="scan-btn" onclick={scan} disabled={phase === 'scanning'}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>
			{phase === 'scanning' ? 'Scanning this Mac…' : 'Scan this Mac for data'}
		</button>
		<p class="scan-sub">Obsidian, Claude Code, Hermes, OpenClaw &amp; your files — found locally, nothing leaves your device.</p>
		{#if phase === 'error'}<p class="scan-err">{scanErr}</p>{/if}
	{:else}
		{#if importable.length === 0}
			<p class="scan-empty">No importable data found on this Mac.</p>
			<button class="scan-link" onclick={scan}>Scan again</button>
		{:else}
			<div class="rows">
				{#each importable as s (s.source)}
					{@const cat = CAT[s.source]}
					{@const r = result[s.source]}
					<div class="row">
						{#if cat}<span class="logo" style="--brand:{cat.color}">{@html colored(cat.logo, cat.color)}</span>{/if}
						<div class="meta">
							<span class="title">{cat?.name ?? s.source}</span>
							<span class="sub">{s.count} {s.unit}{rangeLabel(s) ? ` · ${rangeLabel(s)}` : ''}{s.persona ? ' · persona' : ''}{s.notes ? ` · ${s.notes} memory ${s.notes === 1 ? 'doc' : 'docs'}` : ''}</span>
							{#if AGENT_MODE_SOURCES.has(s.source)}
								<div class="modes" role="group" aria-label="Import mode">
									<button class="seg" class:on={(mode[s.source] ?? 'clean') === 'clean'} onclick={() => (mode = { ...mode, [s.source]: 'clean' })}>Clean</button>
									<button class="seg" class:on={mode[s.source] === 'full'} onclick={() => (mode = { ...mode, [s.source]: 'full' })}>Full</button>
									<span class="mode-hint">{(mode[s.source] ?? 'clean') === 'clean' ? 'conversations only' : 'every tool call too'}</span>
								</div>
							{/if}
							{#if s.source === 'local-files' && s.categories?.length}
								<div class="modes" role="group" aria-label="What to import">
									{#each s.categories as c (c.key)}
										<button class="seg" class:on={cats[`${s.source}:${c.key}`] !== false}
											onclick={() => (cats = { ...cats, [`${s.source}:${c.key}`]: cats[`${s.source}:${c.key}`] === false })}>
											{c.label.replace(/ &.*/, '')} · {c.count}
										</button>
									{/each}
								</div>
							{/if}
							{#if r && r.msg}<span class="res" class:bad={!r.ok}>{r.msg}</span>{/if}
						</div>
						<button class="imp-btn" onclick={() => runImport(s)} disabled={busy[s.source] || (r && r.ok && !!r.msg)}>
							{#if busy[s.source]}Importing…{:else if r && r.ok && r.msg}✓ Done{:else}Import{/if}
						</button>
					</div>
				{/each}
			</div>
			<button class="scan-link" onclick={scan}>Scan again</button>
		{/if}
	{/if}
</div>

<style>
	.scan { display: flex; flex-direction: column; gap: 0.6rem; }
	.scan-btn {
		display: inline-flex; align-items: center; gap: 0.5rem; align-self: flex-start;
		padding: 0.5rem 0.95rem; border-radius: 9px; cursor: pointer; font-family: inherit;
		font-size: 0.8rem; font-weight: 500;
		background: var(--glass-card-bg); border: 1px solid rgba(229, 184, 76, 0.4);
		color: var(--color-accent-aurum, #e5b84c);
		transition: border-color 0.15s, background 0.15s;
	}
	.scan-btn:hover:not(:disabled) { background: var(--glass-card-hover); border-color: rgba(229, 184, 76, 0.6); }
	.scan-btn:disabled { opacity: 0.65; cursor: default; }
	.scan-btn svg { width: 16px; height: 16px; }
	.scan-sub { font-size: 0.68rem; color: var(--color-text-tertiary); margin: 0; line-height: 1.4; }
	.scan-empty { font-size: 0.74rem; color: var(--color-text-secondary); margin: 0; }
	.scan-err { font-size: 0.72rem; color: var(--color-accent-coral, #f87171); margin: 0; }
	.scan-link {
		align-self: flex-start; background: none; border: none; padding: 0; cursor: pointer;
		font-family: inherit; font-size: 0.7rem; color: var(--color-accent-aurum, #e5b84c);
	}
	.scan-link:hover { text-decoration: underline; }

	.rows { display: flex; flex-direction: column; gap: 0.5rem; }
	.row {
		display: flex; align-items: flex-start; gap: 0.7rem;
		padding: 0.65rem 0.8rem; border-radius: 10px;
		background: var(--glass-card-bg); border: 1px solid var(--glass-border);
	}
	.logo { width: 24px; height: 24px; flex-shrink: 0; display: inline-flex; margin-top: 1px; }
	.logo :global(svg) { width: 100%; height: 100%; }
	.meta { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; flex: 1; }
	.title { font-size: 0.8rem; font-weight: 600; color: var(--color-text-primary); }
	.sub { font-size: 0.68rem; color: var(--color-text-tertiary); }
	.modes { display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; flex-wrap: wrap; }
	.seg {
		font-size: 0.64rem; padding: 2px 9px; border-radius: 7px; cursor: pointer; font-family: inherit;
		background: transparent; border: 1px solid var(--glass-border); color: var(--color-text-secondary);
	}
	.seg.on { border-color: rgba(229, 184, 76, 0.5); background: rgba(229, 184, 76, 0.08); color: var(--color-accent-aurum, #e5b84c); }
	.mode-hint { font-size: 0.62rem; color: var(--color-text-tertiary); }
	.res { font-size: 0.68rem; color: var(--color-accent-jade, #4ade80); margin-top: 0.1rem; }
	.res.bad { color: var(--color-accent-coral, #f87171); }
	.imp-btn {
		flex-shrink: 0; align-self: center; padding: 4px 13px; border-radius: 8px; cursor: pointer; font-family: inherit;
		font-size: 0.72rem; font-weight: 500; white-space: nowrap;
		background: var(--color-accent-aurum, #e5b84c); border: none; color: #0a0a0c;
	}
	.imp-btn:hover:not(:disabled) { opacity: 0.9; }
	.imp-btn:disabled { opacity: 0.5; cursor: default; }
</style>
