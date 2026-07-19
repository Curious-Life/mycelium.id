<script lang="ts">
	// §3.8 — the Header status popover: the central account-status location (D5, D10, D11).
	//
	// Three surfaces answer three questions (design §3.8): the invite asks "what do I do
	// next?", the rail asks "what's still missing?", and THIS is the only one that reports
	// FAILURE rather than progress — "what state is my account in, what's broken?" It is
	// reachable from every view, always available, and it NEVER honors `dismissed`
	// (§3.7b: dismissing is "stop nudging me", not "lie to me").
	//
	// DATA SOURCES, and what each costs:
	//   • stores/activity — the feed (@2.5s, ref-counted, already running for the orb).
	//     Carries the live progress rows (embed/categorize/enrich/import/model-pull) with
	//     counts + measured ETAs. Zero new pollers for progress.
	//   • GET /portal/readiness?slices=data,tags,processing,models,ai,mindscape — polled
	//     @4s WHILE THE POPOVER IS OPEN ONLY (this component mounts on open, unmounts on
	//     close). Every polled slice rides an SWR cache, a memo, or an in-memory health
	//     read — gate C1 in verify-readiness.mjs counts the DB touches of exactly this
	//     slice set on a repeat poll and fails anything un-allowlisted. If you add a slice
	//     HERE, add it to C1's POLLED list IN THE SAME CHANGE (that list is the popover's
	//     cost contract; `evidence` is opt-in/not-pollable and must never join this list).
	//   • GET /portal/readiness?slices=evidence — ONCE per open, never on the tick. Three
	//     unindexed aggregates over plaintext columns: fine per user gesture (the invite
	//     fetches it per mount), forbidden on a poll (readiness.js E1).
	//   • GET /portal/system/keep-awake — ONCE per open, never on the tick. It runs the
	//     pmset subprocess (src/portal-system.js detectOnAC — §3.9 R5); a subprocess per
	//     tick would be the C1 cost class one layer down.
	//
	// §3.2a EVERYWHERE: a failed read renders as an honest absence ("—") or HOLDS the last
	// known answer — never a fabricated zero, and a transport blip must never regress a
	// previously-rendered nonzero (mergeHold below). `unknown` flags come from the server;
	// the `data` slice signals its failure via canGenerate.reason === 'unknown' (readiness
	// strips data.unknown before the wire).
	//
	// ZERO PLAINTEXT (CLAUDE.md §1): every string here is a content-free constant; every
	// value is a count, a model/provider identifier, a year, or a timestamp. No message
	// content, no source names (the Data row shows how MANY sources, not which), no error
	// internals (failure reasons stay server-side; we render fixed copy).
	import { onMount } from 'svelte';
	import {
		activity,
		startActivityPolling,
		fmtEta,
		fmtAgo,
		fmtBytes,
		statusLabel,
	} from '$lib/stores/activity';
	import { api, apiPost } from '$lib/api';

	let { pollMs = 4000 }: { pollMs?: number } = $props();

	const POLL_SLICES = 'data,tags,processing,models,ai,mindscape';

	// The last-known merged readiness snapshot. Null until the first successful read —
	// rows render "—" (honest absence), never zeros we did not earn.
	let r = $state<any>(null);
	// Once-per-open extras (never polled — see the cost notes above).
	let evidenceInfo = $state<any>(null);
	let power = $state<{ active: boolean; onAC: boolean | null } | null>(null);

	// ── §3.2a: hold the last known answer through an unknown ─────────────────────
	// Each slice that can carry `unknown:true` keeps its previous value instead of
	// regressing. `processing` is split: paused/pausedAt are LIVE facts (never unknown —
	// take them fresh so the reminder reflects the click the user just made), while a
	// failed `waiting` count holds the previous count rather than showing "0 waiting"
	// over a paused, half-processed vault.
	function mergeHold(prev: any, next: any): any {
		if (!next) return prev;
		const out: any = { ...next };
		// `waitingKnown` is OURS, not the server's: true iff the count came from a
		// non-unknown read, or was held from one. A first read that is already unknown
		// stays waitingKnown:false — the row then says "Paused by you" with NO number,
		// because a 0 we never counted is a claim we did not earn.
		if (next.processing) {
			const np: any = { ...next.processing, waitingKnown: next.processing.unknown !== true };
			if (!np.waitingKnown && prev?.processing?.waitingKnown) {
				np.waiting = prev.processing.waiting; // hold the last known count — never regress to 0
				np.waitingKnown = true;
			}
			out.processing = np;
		}
		if (!prev) return out;
		if (next.canGenerate?.reason === 'unknown' && prev.data) {
			out.data = prev.data;
			out.canGenerate = prev.canGenerate ?? next.canGenerate;
		}
		if (next.tags?.unknown && prev.tags) out.tags = prev.tags;
		if (next.ai?.unknown && prev.ai) out.ai = prev.ai;
		if (next.mindscape?.unknown && prev.mindscape) out.mindscape = prev.mindscape;
		return out;
	}

	async function refresh() {
		try {
			const res = await api(`/portal/readiness?slices=${POLL_SLICES}`);
			if (!res.ok) return; // hold the last snapshot — a 500 is not an empty vault
			r = mergeHold(r, await res.json());
		} catch {
			/* hold the last snapshot (§3.2a) */
		}
	}

	async function loadEvidence() {
		try {
			const res = await api('/portal/readiness?slices=evidence');
			if (!res.ok) return;
			const d = await res.json();
			// unknown ⇒ leave null: the Data row simply omits sources/years rather than
			// claiming "0 sources" off a failed aggregate.
			if (d?.evidence && d.evidence.unknown !== true) evidenceInfo = d.evidence;
		} catch {
			/* absence, not zeros */
		}
	}

	async function loadPower() {
		try {
			const res = await api('/portal/system/keep-awake');
			if (!res.ok) return;
			const d = await res.json();
			power = { active: d?.active === true, onAC: typeof d?.onAC === 'boolean' ? d.onAC : null };
		} catch {
			/* onAC:null renders nothing — unknown is an absence, not a state */
		}
	}

	onMount(() => {
		const stopActivity = startActivityPolling();
		void refresh();
		void loadEvidence();
		void loadPower();
		const t = setInterval(refresh, pollMs);
		return () => {
			clearInterval(t);
			stopActivity();
		};
	});

	// ── Resume (the D13 reminder's one control) ──────────────────────────────────
	// The failure must be visible: the server refuses a pause/resume it cannot persist
	// (portal-compat.js), and that contract is only honest if the user learns the click
	// did nothing.
	let resumeBusy = $state(false);
	let resumeError = $state<string | null>(null);
	async function resumeProcessing() {
		if (resumeBusy) return;
		resumeBusy = true;
		resumeError = null;
		try {
			await apiPost('/portal/enrichment/processing/resume', {});
			await refresh();
		} catch {
			resumeError = "Couldn't resume — try again.";
		}
		resumeBusy = false;
	}

	// Stop/Resume on the live feed rows (moved here with the panel from Header — §3.9/R3).
	let categorizeBusy = $state(false);
	let processingError = $state<string | null>(null);
	async function toggleCategorize(paused: boolean) {
		if (categorizeBusy) return;
		categorizeBusy = true;
		processingError = null;
		try {
			await apiPost(
				paused ? '/portal/enrichment/processing/resume' : '/portal/enrichment/processing/pause',
				{},
			);
		} catch {
			processingError = paused ? "Couldn't resume — try again." : "Couldn't pause — try again.";
		}
		categorizeBusy = false;
	}

	const active = $derived($activity.active);
	const recent = $derived($activity.recent);
	const busy = $derived(active.length > 0);

	// Deterministic thousands separators (a locale-dependent format would make the
	// mounted gates flaky across machines).
	const NUM = new Intl.NumberFormat('en-US');
	const fmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '' : NUM.format(n));

	// ── Row values (all derived; every branch is a content-free constant) ─────────
	const d = $derived(r?.data ?? null);
	const dataKnown = $derived(!!d && r?.canGenerate?.reason !== 'unknown');
	const tags = $derived(r?.tags ?? null); // mergeHold already held it through unknowns; labelingLine re-checks .unknown
	const proc = $derived(r?.processing ?? null);
	const models = $derived(r?.models ?? null);
	const embedRow = $derived(active.find((j) => j.kind === 'embed') ?? null);

	const embedderStatus = $derived(models?.embedder?.status ?? 'unknown');
	const embeddingLine = $derived.by(() => {
		if (proc?.paused) return 'Paused';
		if (embedderStatus === 'down' || embedderStatus === 'error')
			return 'Paused — the embedding service isn’t running';
		if (embedderStatus === 'loading') return 'Starting…';
		if (!dataKnown) return '—';
		if ((d?.pending ?? 0) > 0) {
			const eta = embedRow ? fmtEta(embedRow.etaSeconds) : '';
			return `Embedding · ${fmt(d.embedded)} / ${fmt(d.total)}${eta ? ` · ${eta} left` : ''}`;
		}
		return `Up to date · ${fmt(d?.embedded ?? 0)} embedded`;
	});

	// ── R4 DECISION (recorded; see also the PR body) ─────────────────────────────
	// The model-pull progress signal has exactly ONE owner: the activity feed's
	// `model-pull` row (published by the drainer since §3.10e/#206, byte-accurate,
	// rendered in "Working now" below with fmtBytes + the shared ETA machinery it
	// inherits from R1). The Labeling STATUS row here states the STATE ONLY — the
	// drainer's own constant ("Downloading qwen3.5:4b…"), never a second percent.
	// Both lines share this one panel, so duplicating the percent inches apart would
	// be two owners for one number — the drift class §3.2 exists to end. If a future
	// change wants a percent here, it must MOVE it, not copy it.
	const labelingLine = $derived.by(() => {
		const h = models?.labeler;
		if (!h || h.status === 'unknown') return h?.message ?? '—';
		if (h.status === 'ok') {
			if (tags && !tags.unknown && (tags.total ?? 0) > 0)
				return `Sorting · ${fmt(tags.tagged)} / ${fmt(tags.total)}${h.model ? ` · ${h.model}` : ''}`;
			return h.message ?? `Labeling with ${h.model ?? 'the local model'}.`;
		}
		return h.message ?? '—'; // no_model / downloading / paused / unavailable — the drainer's honest constants
	});

	const enricherLine = $derived.by(() => {
		const h = models?.enricher;
		if (!h) return '—';
		return h.message ?? '—';
	});

	const transcriberLine = $derived.by(() => {
		const h = models?.transcriber;
		if (!h || h.status === 'unknown' || h.status === 'no_model') return 'Not set up';
		if (h.status === 'ok') return `${h.model ?? 'Ready'} · ready`;
		return h.message ?? '—';
	});

	const aiLine = $derived.by(() => {
		if (!r?.ai) return '—';
		if (r.ai.connected) return `${r.ai.activeProvider ?? 'Connected'} · connected`;
		return 'No AI connected';
	});

	const mindscapeLine = $derived.by(() => {
		const m = r?.mindscape;
		if (!m) return '—';
		if (m.generated) return `Generated · ${fmt(m.pointCount)} points`;
		if (m.unknown) return '—';
		return 'Not generated yet';
	});

	const dataLine = $derived.by(() => {
		if (!dataKnown) return '—';
		if ((d?.total ?? 0) === 0) return 'No data yet';
		let line = `${fmt(d.total)} messages`;
		if (evidenceInfo) {
			const n = Array.isArray(evidenceInfo.sources) ? evidenceInfo.sources.length : 0;
			if (n > 0) line += ` · ${n} ${n === 1 ? 'source' : 'sources'}`;
			const { yearStart, yearEnd } = evidenceInfo.dateRange ?? {};
			if (yearStart && yearEnd) line += ` · ${yearStart === yearEnd ? yearStart : `${yearStart}–${yearEnd}`}`;
		}
		return line;
	});
</script>

<!-- ── Status — the §3.8 rows. Reports state whether or not onboarding was dismissed. ── -->
<div class="status-section" data-testid="status-rows">
	<div class="px-2.5 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Status</div>

	<div class="status-row">
		<span class="row-label">Vault</span>
		<span class="row-value">Encrypted · open</span>
	</div>

	<div class="status-row">
		<span class="row-label">Data</span>
		<span class="row-value">{dataLine}</span>
	</div>
	{#if dataKnown && (d?.unprocessable ?? 0) > 0}
		<div class="row-sub warn">{fmt(d.unprocessable)} couldn’t be processed</div>
	{/if}

	<!-- The D13 reminder: the ONE row that is not a failure — the user's own choice,
	     held honestly. Persistent while paused, non-dismissible, survives restart
	     (pausedAt is the durable settings stamp), and offers the only thing that
	     restarts it. A held (unknown) count renders the LAST KNOWN number — never 0. -->
	{#if proc?.paused}
		<div class="status-row" data-testid="processing-row">
			<span class="row-label">Processing</span>
			<span class="row-value warn">
				Paused by you{#if proc.waitingKnown}&nbsp;— {fmt(proc.waiting)} messages waiting{/if}
			</span>
			<button class="row-action" onclick={resumeProcessing} disabled={resumeBusy}
				title="Resume processing your messages">Resume</button>
		</div>
		{#if proc.pausedAt}
			<div class="row-sub">paused {fmtAgo(proc.pausedAt)}</div>
		{/if}
		{#if resumeError}
			<div class="row-sub warn">{resumeError}</div>
		{/if}
	{/if}

	<div class="status-row">
		<span class="row-label">Embedding</span>
		<span class="row-value">{embeddingLine}</span>
	</div>
	{#if power?.active}
		<div class="row-sub">Keeping your Mac awake</div>
	{/if}
	{#if power?.onAC === false}
		<div class="row-sub">On battery</div>
	{/if}

	<div class="status-row">
		<span class="row-label">Labeling</span>
		<span class="row-value">{labelingLine}</span>
	</div>

	<div class="status-row">
		<span class="row-label">Understanding</span>
		<span class="row-value">{enricherLine}</span>
	</div>

	<div class="status-row">
		<span class="row-label">Transcription</span>
		<span class="row-value">{transcriberLine}</span>
	</div>

	<div class="status-row">
		<span class="row-label">Intelligence</span>
		<span class="row-value">{aiLine}</span>
	</div>

	<div class="status-row">
		<span class="row-label">Mindscape</span>
		<span class="row-value">{mindscapeLine}</span>
	</div>
	{#if r?.mindscape?.generated && proc?.paused}
		<div class="row-sub warn">Won’t update while processing is paused</div>
	{/if}
</div>

<!-- ── Working now / Recently — the live feed (moved intact from Header) ── -->
{#if busy}
	<div class="px-2.5 pt-1 pb-0.5 text-[9px] uppercase tracking-wider text-[var(--color-text-tertiary)]">Working now</div>
	{#each active as j (j.id)}
		<div class="px-2.5 py-1.5 text-[11px]">
			<div class="flex items-center gap-2">
				<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {j.stalled ? 'bg-[var(--color-warning,#f59e0b)]' : 'bg-[#34d399]'}"></span>
				<span class="text-[var(--color-text-primary)] truncate">{j.stage}</span>
				{#if j.total > 0}
					<!-- model-pull's done/total are BYTES (ollama's own units) — render them as
					     sizes ("1.2 GB / 3.4 GB"), not ten-digit raw counts. Everything else
					     counts items. -->
					<span class="text-[var(--color-text-tertiary)] flex-shrink-0"
						>{j.kind === 'model-pull' ? `${fmtBytes(j.done)} / ${fmtBytes(j.total)}` : `${j.done}/${j.total}`}</span>
				{/if}
				{#if j.stalled}<span class="ml-auto text-[var(--color-warning,#f59e0b)] flex-shrink-0 whitespace-nowrap">taking longer…</span>
				{:else if fmtEta(j.etaSeconds)}<span class="ml-auto text-[#34d399] flex-shrink-0">{fmtEta(j.etaSeconds)} left</span>{/if}
				<!-- ONE control, BOTH on-box rows (§3.9/R3). It used to sit only on 'categorize',
				     which was honest while the flag gated L1 alone. Now the same flag stops the
				     embed drain — so a vault whose tagging is caught up (no categorize row) but
				     whose embedding is still burning would show the churn with NO way to stop
				     it: exactly the complaint §3.9 exists to answer. -->
				{#if j.kind === 'categorize' || j.kind === 'embed'}
					<button
						class="ml-auto flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--color-text-tertiary)] disabled:opacity-50"
						onclick={() => toggleCategorize(j.status === 'paused')}
						disabled={categorizeBusy}
						title={j.status === 'paused' ? 'Resume processing your messages' : 'Stop processing on this computer (you can resume anytime)'}
					>{j.status === 'paused' ? 'Resume' : 'Stop'}</button>
				{/if}
			</div>
			<!-- The persist failed ⇒ the click did NOT take effect. Say so: the server refuses
			     to apply a pause it cannot remember, and a silent no-op would be the same lie
			     as an unhonored pause. -->
			{#if processingError && (j.kind === 'categorize' || j.kind === 'embed')}
				<div class="pl-3.5 mt-0.5 text-[10px] text-[var(--color-warning,#f59e0b)]">{processingError}</div>
			{/if}
			{#if j.model || j.process}
				<!-- what model is working + what process it's running -->
				<div class="flex items-center gap-1.5 pl-3.5 mt-0.5 text-[10px] text-[var(--color-text-tertiary)] truncate">
					{#if j.model}<span class="font-mono text-[var(--color-text-secondary)]">{j.model}</span>{/if}
					{#if j.model && j.process}<span class="opacity-40">·</span>{/if}
					{#if j.process}<span>{j.process}</span>{/if}
				</div>
			{/if}
		</div>
	{/each}
{/if}

{#if recent.length}
	<div class="px-2.5 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wider text-[var(--color-text-tertiary)]">{busy ? 'Recently' : 'Last activity'}</div>
	{#each recent.slice(0, 6) as j (j.id + (j.finishedAt ?? ''))}
		<div class="px-2.5 py-1.5 text-[11px]">
			<div class="flex items-center gap-2">
				<span class="w-1.5 h-1.5 rounded-full flex-shrink-0 {j.status === 'error' ? 'bg-[#f87171]' : j.status === 'abandoned' ? 'bg-[var(--color-text-tertiary)]' : 'bg-[#34d399]'}"></span>
				<span class="text-[var(--color-text-secondary)] truncate">{j.stage}</span>
				{#if j.model}<span class="font-mono text-[10px] text-[var(--color-text-tertiary)] truncate flex-shrink min-w-0" title="Model used">{j.model}</span>{/if}
				<span class="ml-auto flex-shrink-0 {j.status === 'error' ? 'text-[#f87171]' : 'text-[var(--color-text-tertiary)]'}">{statusLabel(j.status)} · {fmtAgo(j.finishedAt)}</span>
			</div>
			<!-- A failed model download is otherwise a DEAD END: the feed row is content-free by
			     contract (activity-feed.js §SECURITY — no error text, no paths), so it can only say
			     "Failed". Point the owner at where the REASON actually lives — the Labeling /
			     Understanding rows at the top of this same popover, which now carry the classified,
			     actionable cause (drainer.js faultMessage). A pointer, never the reason itself. -->
			{#if j.kind === 'model-pull' && j.status === 'error'}
				<div data-testid="modelpull-fault-hint" class="pl-3.5 mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">See the model status above for why · Settings → Intelligence for details</div>
			{/if}
		</div>
	{/each}
{:else if !busy}
	<div class="px-2.5 py-2 text-[11px] text-[var(--color-text-tertiary)]">No activity yet — your vault is idle.</div>
{/if}

<style>
	.status-section {
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 0.375rem;
		margin-bottom: 0.25rem;
	}
	.status-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		padding: 0.22rem 0.625rem;
		font-size: 11px;
	}
	.row-label {
		flex-shrink: 0;
		width: 5.2rem;
		color: var(--color-text-tertiary);
	}
	.row-value {
		color: var(--color-text-primary);
		min-width: 0;
	}
	.row-value.warn {
		color: var(--color-warning, #f59e0b);
	}
	.row-sub {
		padding: 0 0.625rem 0.15rem calc(5.2rem + 1.125rem);
		font-size: 10px;
		color: var(--color-text-tertiary);
	}
	.row-sub.warn {
		color: var(--color-warning, #f59e0b);
	}
	.row-action {
		margin-left: auto;
		flex-shrink: 0;
		border: 1px solid var(--color-border);
		border-radius: 0.25rem;
		padding: 0.1rem 0.4rem;
		font-size: 10px;
		color: var(--color-text-secondary);
	}
	.row-action:hover {
		color: var(--color-text-primary);
		border-color: var(--color-text-tertiary);
	}
	.row-action:disabled {
		opacity: 0.5;
	}
</style>
