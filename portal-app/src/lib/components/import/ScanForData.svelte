<script lang="ts">
	// ScanForData — the dynamic counterpart to the static SourceCatalog. One button,
	// "Scan this Mac for data", asks the local backend what's on disk (Obsidian
	// vaults, Claude Code sessions — presence/counts/dates only, never content) and
	// offers one-click import of each. Claude Code gets a clean/full toggle. Used in
	// both onboarding (MindscapeInvite) and Streams → Sources (ImportView).
	import { onDestroy } from 'svelte';
	import { scanSources, importDetected, startLocalSweep, pollLocalSweep, cancelLocalSweep,
		startImportRun, pollImportRun, cancelImportRun,
		AGENT_MODE_SOURCES, ASYNC_RUN_SOURCES, type DetectedSource, type SweepProgress } from '$lib/import/detect';
	import { SOURCE_CATALOG } from '$lib/import/catalog';

	let { compact = false, onImported = () => {} }: { compact?: boolean; onImported?: () => void } = $props();

	// Catalog lookup so a detected source reuses its brand logo/colour/name.
	const CAT = Object.fromEntries(SOURCE_CATALOG.map((s) => [s.id, s]));
	const colored = (logo: string, color: string) => logo.replace(/="C"/g, `="${color}"`);

	type Phase = 'idle' | 'scanning' | 'done' | 'error';
	let phase = $state<Phase>('idle');
	let scanErr = $state('');
	let found = $state<DetectedSource[]>([]);
	// Broad-sweep roots macOS is blocking (TCC). Lets the empty state say "grant
	// access & re-scan" instead of a dead "nothing found" — the first-scan-empty
	// bug where readdir EPERM was swallowed as empty (ON-5).
	let blocked = $state<string[]>([]);

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
	// How many files the CURRENT selection covers. The row's headline `s.count` is the
	// all-category total; using it as the progress denominator (as this component used
	// to) made a documents-only import read as "N of ~18,700" — indistinguishable from
	// importing everything, which is exactly what the user reported seeing (D-070).
	function selectedCount(s: DetectedSource): number {
		const on = new Set(selectedCats(s));
		return (s.categories ?? []).reduce((a, c) => a + (on.has(c.key) ? c.count : 0), 0);
	}
	// Human names for the selected categories, so the result line states what was
	// allowed in rather than only how many rows landed.
	function catNames(s: DetectedSource, keys: string[]): string {
		const byKey = new Map<string, string>((s.categories ?? []).map((c) => [c.key as string, c.label.replace(/ &.*/, '').toLowerCase()]));
		const names = keys.map((k) => byKey.get(k) ?? k);
		if (names.length <= 1) return names[0] ?? '';
		return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
	}
	// Nothing ticked ⇒ nothing to import. Fail-closed at the first surface too: the
	// server rejects an empty selection, but the user should never get that far.
	const nothingSelected = (s: DetectedSource) => s.source === 'local-files' && !!s.categories?.length && selectedCats(s).length === 0;
	// A strict subset is the case worth spelling out; "everything only" reads wrong.
	const isSubset = (s: DetectedSource, keys: string[]) => !!s.categories?.length && keys.length < s.categories.length;

	async function scan() {
		phase = 'scanning'; scanErr = '';
		try {
			const r = await scanSources();
			found = r.sources;
			blocked = r.blocked;
			phase = 'done';
			// A finished run's "✓ Done" must not survive a re-scan: it permanently disables
			// Import (`r.ok && r.msg` below), so a user who re-scanned to pick a different
			// selection was locked out for the session.
			result = {};
			void adoptRunningSweep();
		} catch (e: any) {
			scanErr = e?.message || 'Scan failed.'; phase = 'error';
		}
	}

	// ── An import that was ALREADY RUNNING when we mounted ───────────────────────────
	// A sweep OUTLIVES this component: it is a detached server job, so a reload or a
	// navigate-away-and-back mounts a fresh row with `busy` empty and no Cancel button.
	// That was survivable while a re-click silently re-attached; it is NOT survivable now
	// that a re-click with a DIFFERENT selection is refused (409) — the user would be told
	// to cancel an import with nothing on screen to cancel.
	//
	// ⚠️ IT IS NOT THIS ROW'S IMPORT, AND MUST NEVER BORROW THIS ROW'S CHIPS. The first
	// attempt at this fed the adopted job through `runSweep`, which computes every label
	// from `selectedCats()` — so a foreign documents-only job rendered against the chips'
	// all-category total ("Importing… 120 of ~18,700", the exact string U4 exists to
	// forbid), and worse, an all-four job under documents-only chips ended as a bare
	// "Imported 9698 items. ✓ Done": a user who deselected Photos was told their import
	// succeeded while photos were being ingested. That is the reported defect again, as a
	// UI-reporting bug (round-2 review, CRITICAL 1).
	//
	// So the adopted job gets its OWN state, its OWN timer and its OWN labels, all driven
	// by what the SERVER says it is allowed to import (`categories`, `total`). It never
	// writes `result`, never fires `onImported` (the user did not start it), and never
	// leaves a terminal "✓ Done" behind — when it ends, the row simply becomes usable.
	let adopted = $state<SweepProgress | null>(null);
	let adoptTimer: ReturnType<typeof setTimeout> | null = null;
	let adopting = false;
	onDestroy(() => { if (adoptTimer) clearTimeout(adoptTimer); });

	async function adoptRunningSweep() {
		// `importable` is the predicate the ROW renders on — adopting something with no row
		// would poll invisibly. And one in-flight adopt at a time: `adopting` is set before
		// the first await, so two racing adopts cannot both arm `adoptTimer` and orphan one.
		if (adopted || adopting || busy['local-files']) return;
		if (!importable.some((x) => x.source === 'local-files')) return;
		adopting = true;
		try {
			let p: SweepProgress;
			try { p = await pollLocalSweep(); } catch { return; }
			if (p.status !== 'running') return;
			adopted = p;
			const tick = async () => {
				try { adopted = await pollLocalSweep(); } catch { /* keep the last snapshot */ }
				if (adopted && adopted.status === 'running') adoptTimer = setTimeout(tick, 1200);
				else adopted = null; // terminal → drop it; the row goes back to normal
			};
			adoptTimer = setTimeout(tick, 1200);
		} finally { adopting = false; }
	}

	async function stopAdopted() {
		try { await cancelLocalSweep(); } catch { /* best-effort */ }
		try { adopted = await pollLocalSweep(); } catch { /* keep */ }
		if (adopted?.status !== 'running') { if (adoptTimer) clearTimeout(adoptTimer); adopted = null; }
	}

	// Labels for the adopted job — from the SERVER's enforced selection, never the chips.
	function adoptedScope(s: DetectedSource): string {
		const keys = adopted?.categories ?? [];
		if (!keys.length) return '';
		return `${catNames(s, keys)}${isSubset(s, keys) ? ' only' : ''}`;
	}
	function adoptedLabel(s: DetectedSource): string {
		if (!adopted) return '';
		const denom = adopted.total || adopted.processed || 0;
		const pct = denom ? Math.min(100, Math.round((adopted.processed / denom) * 100)) : 0;
		const scope = adoptedScope(s);
		return `An import you started earlier is still running${scope ? ` — ${scope}` : ''} · `
			+ `${adopted.processed.toLocaleString()} of ~${denom.toLocaleString()} (${pct}%)`;
	}
	function adoptedPct(): number {
		if (!adopted) return 0;
		const denom = adopted.total || adopted.processed || 1;
		return Math.min(100, Math.round((adopted.processed / denom) * 100));
	}

	// A readable list of the blocked folders for the permission hint.
	const blockedLabel = $derived(
		blocked.length === 0 ? ''
			: blocked.length === 1 ? blocked[0]
			: blocked.length === 2 ? `${blocked[0]} and ${blocked[1]}`
			: `${blocked.slice(0, -1).join(', ')} and ${blocked[blocked.length - 1]}`,
	);

	// The broad local-files sweep runs as an async background job — live progress here.
	let sweep = $state<SweepProgress | null>(null);
	let sweepTimer: ReturnType<typeof setTimeout> | null = null;
	onDestroy(() => { if (sweepTimer) clearTimeout(sweepTimer); });

	async function runImport(s: DetectedSource) {
		// Fail-closed first surface: an empty selection is never sent as "no opinion".
		if (nothingSelected(s)) {
			result = { ...result, [s.source]: { ok: false, msg: 'Nothing selected — pick at least one kind of file to import.' } };
			return;
		}
		// Async-job sources (the broad sweep + registry `run` sources like the
		// recent-export bundle) share ONE progress-polled loop; the rest are a
		// one-shot blocking POST via importDetected.
		if (s.source === 'local-files') return runSweep(s, () => startLocalSweep(selectedCats(s)), pollLocalSweep);
		if (ASYNC_RUN_SOURCES.has(s.source)) return runSweep(s, () => startImportRun(s.source, { dirPath: s.path }), pollImportRun);
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

	// Start an async import job, then poll progress until terminal. Shared by the
	// broad local-files sweep and the registry `run` sources (recent-export).
	async function runSweep(s: DetectedSource, start: () => Promise<SweepProgress>, poll: () => Promise<SweepProgress>) {
		busy = { ...busy, [s.source]: true };
		result = { ...result, [s.source]: { ok: true, msg: '' } };
		try {
			sweep = await start();
			await new Promise<void>((resolve) => {
				const tick = async () => {
					try { sweep = await poll(); } catch { /* keep last snapshot */ }
					if (sweep && sweep.status === 'running') sweepTimer = setTimeout(tick, 1200);
					else resolve();
				};
				sweepTimer = setTimeout(tick, 800);
			});
			const d = sweep;
			if (d?.status === 'error') {
				result = { ...result, [s.source]: { ok: false, msg: d.error || 'Import failed.' } };
			} else {
				const stopped = d?.status === 'cancelled';
				const n = d?.imported ?? 0;
				const extra = d?.deduped ? ` · ${d.deduped} already in vault` : '';
				// Name the categories the SERVER enforced (it echoes them back), so the user
				// can SEE their deselection held instead of inferring it from a count (D-070).
				const enforced = d?.categories?.length && isSubset(s, d.categories) ? ` · ${catNames(s, d.categories)} only` : '';
				result = { ...result, [s.source]: { ok: true, msg: `${stopped ? 'Stopped —' : 'Imported'} ${n} item${n === 1 ? '' : 's'}${extra}${enforced}.` } };
				// Only a run that actually brought something in is an import completion. Every
				// other caller of this callback guards on a nonzero count; this one did not, so
				// a cancelled-at-zero sweep still told onboarding "your data is in".
				if (n > 0 || (d?.deduped ?? 0) > 0) onImported();
			}
		} catch (e: any) {
			const msg = e?.message || 'Import failed.';
			result = { ...result, [s.source]: { ok: false, msg } };
			// A 409 says another selection is already importing and must be cancelled first.
			// Belt-and-braces with the post-scan adopt: if the job started in the window
			// between the scan and this click, adopt it NOW so the Cancel it names exists.
			// Deferred to a microtask so it lands AFTER the `finally` below resets the row.
			// adoptRunningSweep never writes `result`, so this 409 message SURVIVES. The first
			// version routed the adopt through runSweep, which reset the message to '' before
			// the user could read the instruction it gave them (round-2 review, CRITICAL 1).
			if (s.source === 'local-files' && /already running/i.test(msg)) {
				queueMicrotask(() => { void adoptRunningSweep(); });
			}
		} finally {
			busy = { ...busy, [s.source]: false };
			sweep = null;
		}
	}

	async function stopSweep() {
		// Cancel whichever async job is live (only one runs at a time). Both calls
		// are best-effort; the idle one is a no-op.
		try { sweep = await cancelLocalSweep(); } catch { /* best-effort */ }
		try { await cancelImportRun(); } catch { /* best-effort */ }
	}

	// "N of ~M" for the sweep. The denominator counts ONLY the selected categories
	// (D-070): it used to be `Math.max(s.count, …)` — the ALL-category total — so a
	// documents-only run reported against every photo, video and audio file on the
	// machine and read as "it imported everything anyway". A progress bar that
	// denominates by data the user refused is a lie about scope even when the
	// importer behaves.
	function sweepDenom(s: DetectedSource): number {
		const picked = selectedCount(s) || (s.categories?.length ? 0 : s.count || 0);
		return Math.max(picked, sweep?.total || 0);
	}
	function sweepLabel(s: DetectedSource): string {
		if (!sweep) return '';
		const denom = sweepDenom(s) || sweep.processed;
		const pct = denom ? Math.min(100, Math.round((sweep.processed / denom) * 100)) : 0;
		return `Importing… ${sweep.processed.toLocaleString()} of ~${denom.toLocaleString()} (${pct}%) · ${sweep.imported.toLocaleString()} added`;
	}
	function sweepPct(s: DetectedSource): number {
		if (!sweep) return 0;
		const denom = sweepDenom(s) || sweep.processed || 1;
		return Math.min(100, Math.round((sweep.processed / denom) * 100));
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
		<!-- ⚠️ "— nothing leaves your device." was REMOVED here for the same reason it was removed
		     from the onboarding consent line (D-069). It was true of the SCAN (detect returns
		     counts and dates only, never content) but it sits directly above the IMPORT button,
		     and imported content is read by the chat agent — which is a cloud model whenever one
		     is selected. An absolute privacy claim next to the action that breaks it is the
		     defect, not a technicality. This is a DELETION of the absolute clause, the same
		     operation the operator approved for ImportStep; no new claim was invented, and any
		     replacement wording is the operator's to write. -->
		<p class="scan-sub">Obsidian, Claude Code, Hermes, OpenClaw &amp; your files — found locally on this Mac.</p>
		{#if phase === 'error'}<p class="scan-err">{scanErr}</p>{/if}
	{:else}
		{#if importable.length === 0}
			{#if blocked.length}
				<!-- macOS blocked the sweep roots (TCC) — the scan couldn't actually
				     look, so this is NOT "no data" (ON-5). Guide the grant + re-scan. -->
				<p class="scan-empty">macOS is blocking access to your {blockedLabel} folder{blocked.length === 1 ? '' : 's'}, so the scan couldn't look there.</p>
				<p class="scan-sub">Click <strong>Allow</strong> if macOS prompts you — or grant access in System Settings → Privacy &amp; Security → Files and Folders — then scan again.</p>
			{:else}
				<p class="scan-empty">No importable data found on this Mac.</p>
			{/if}
			<button class="scan-link" onclick={scan}>Scan again</button>
		{:else}
			{#if blocked.length}
				<!-- Found some sources, but macOS is still blocking a sweep root, so
				     loose files there may be missing (ON-5, partial access). -->
				<p class="scan-sub">macOS is blocking your {blockedLabel} folder{blocked.length === 1 ? '' : 's'} — grant access (System Settings → Privacy &amp; Security → Files and Folders) and scan again to include files there.</p>
			{/if}
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
											aria-pressed={cats[`${s.source}:${c.key}`] !== false}
											onclick={() => (cats = { ...cats, [`${s.source}:${c.key}`]: cats[`${s.source}:${c.key}`] === false })}>
											{c.label.replace(/ &.*/, '')} · {c.count}
										</button>
									{/each}
								</div>
								<!-- State the scope the user actually chose, next to the choice. The row
								     headline above is the all-category total and does not move when a
								     category is switched off (D-070). -->
								<!-- Suppressed while an earlier job runs: no import can be started from
								     here until it finishes, so a "Will import …" promise would be a
								     forward-looking claim next to a live job with a different scope. -->
								{#if !(s.source === 'local-files' && adopted)}
									<span class="mode-hint">{nothingSelected(s)
										? 'Nothing selected — nothing will be imported.'
										: `Will import ${selectedCount(s).toLocaleString()} file${selectedCount(s) === 1 ? '' : 's'} · ${catNames(s, selectedCats(s))}${isSubset(s, selectedCats(s)) ? ' only' : ''}`}</span>
								{/if}
							{/if}
							{#if s.source === 'local-files' && busy[s.source] && sweep}
								<span class="res prog">{sweepLabel(s)}</span>
								<div class="bar"><div class="bar-fill" style="width:{sweepPct(s)}%"></div></div>
							{:else if s.source === 'local-files' && adopted}
								<!-- A job the user started EARLIER (before this mount). Every number and
								     name here comes from the SERVER's own record of that job, never from
								     the chips above — the chips describe what a NEW import would do. -->
								<span class="res prog">{adoptedLabel(s)}</span>
								<div class="bar"><div class="bar-fill" style="width:{adoptedPct()}%"></div></div>
							{:else if r && r.msg}<span class="res" class:bad={!r.ok}>{r.msg}</span>{/if}
						</div>
						{#if s.source === 'local-files' && busy[s.source]}
							<button class="imp-btn cancel" onclick={stopSweep}>Cancel</button>
						{:else if s.source === 'local-files' && adopted}
							<button class="imp-btn cancel" onclick={stopAdopted}>Cancel</button>
						{:else}
							<!-- Disabled with NOTHING selected: an empty selection must never be
							     sendable, because a request that carries no consent is the exact
							     shape the server used to answer with "then import everything".
							     Also disabled while an EARLIER job runs: the server would 409 a
							     different selection, so offering the click would only produce an
							     error the user can do nothing useful with. -->
							<button class="imp-btn" onclick={() => runImport(s)} disabled={busy[s.source] || nothingSelected(s) || (r && r.ok && !!r.msg)}>
								{#if busy[s.source]}Importing…{:else if r && r.ok && r.msg}✓ Done{:else}Import{/if}
							</button>
						{/if}
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
	.imp-btn.cancel { background: transparent; border: 1px solid var(--color-accent-coral, #f87171); color: var(--color-accent-coral, #f87171); }
	.res.prog { color: var(--color-text-secondary); }
	.bar { margin-top: 0.3rem; height: 4px; border-radius: 3px; background: var(--glass-border); overflow: hidden; }
	.bar-fill { height: 100%; background: var(--color-accent-aurum, #e5b84c); transition: width 0.4s ease; }
</style>
