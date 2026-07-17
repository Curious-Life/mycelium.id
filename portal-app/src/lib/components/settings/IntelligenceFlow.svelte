<!--
	The Intelligence pane as a FLOW (docs/INTELLIGENCE-SCREEN-REDESIGN-2026-07-17.md Part I).

	Two top states, chosen by one fact with opposite polarity (§4.0 / A5):
	  STATE A (first run)  — no on-box approval AND no provider: one pre-suggested bundle,
	                         one confirm, the total stated (P4/P5), no pre-consent checkmarks
	                         (W5), disk headroom stated + pre-checked (W4). Conversation is an
	                         inline connect chip and Voice a muted later-unlock — the
	                         executability rule (§4.1a W2/W3): the tap delivers everything it
	                         claims, and nothing it can't.
	  STATE B (returning)  — one compact summary card: per-function rows + a passive
	                         "needs you" line (§5, Q2: nothing pulses), and the W6 gap-fill
	                         (`Finish setting up · N GB`) when ≥2 recommended functions are
	                         unset — the same orchestrator, scoped to what's missing.

	Everything else lives behind ONE Customize disclosure (§3.1), default CLOSED (Q1):
	Assignment (IntelligenceScreen — the one assignment surface, P2) · Connect & manage
	(AISettings, demoted, P3) · Voice (VoiceSection, #209) · Engine (EngineSelector).

	FRESHNESS + COST (W7, the C1 contract): while mounted this polls exactly ONE readiness
	slice — `models` — at the popover's 4s cadence. `models` is already on C1's POLLED list
	(it is the popover's own slice; SYNC, in-memory, zero DB touches), so this adds ZERO new
	slices and ZERO new pollers. If you ever add a slice to this poll, it joins
	verify-readiness.mjs C1's POLLED list IN THE SAME CHANGE. taskModels/providers are
	refreshed on gestures only (mount · apply · customize close), never polled.

	DOWNLOADS (§4.2): apply writes the assignments server-side (the ONE write path); the
	downloads then start through the routes that already own them — the labeling model via
	POST /portal/hardware/pull (installs the Ollama runtime first, SSE progress), whisper via
	POST /portal/transcription/download (persists the choice itself). No parallel pull path;
	the drainer's #206 backoff + the trigger route stay the retry authority.

	A11y (P8): ONE persistent visually-hidden aria-live region whose textContent is updated —
	never an element inserted already-containing-text (#204 round 3). Choices are not alerts:
	`no_model`/unset render muted, never red (§8.2).

	§1 ZERO-PLAINTEXT: every string here is a constant, a count, a size, or a model/provider
	identifier. No vault content can reach this surface.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import IntelligenceScreen from './IntelligenceScreen.svelte';
	import AISettings from './AISettings.svelte';
	import VoiceSection from './VoiceSection.svelte';
	import EngineSelector from './EngineSelector.svelte';

	type BundleRow = {
		key: string; model?: string; presetId?: string; runs: string; included?: boolean;
		installed?: boolean; assigned?: boolean; downloadGb?: number; needsRuntime?: boolean;
		connected?: boolean; providerId?: number | null; providerLabel?: string | null;
	};
	type Bundle = {
		hardware: { cpuName: string | null; arch: string | null; platform: string | null; totalRamGb: number | null };
		rows: BundleRow[]; totalDownloadGb: number;
		disk: { freeGb: number | null; ok: boolean; shortfallGb: number };
		adjacent: { conversation: { subscriptionConnected: boolean; providerId: number | null; assigned: boolean } };
	};
	type Health = { status: string; message: string | null; model: string | null; progress: { pct: number } | null };
	type Provider = { id: number; label: string | null; provider: string; auth_type?: string; is_active: number; last_used_at?: string | null; on_this_device?: boolean; jurisdiction?: string };
	type Fn = { key: string; label: string; tasks: string[]; kind: string };

	let bundle = $state<Bundle | null>(null);
	let functions = $state<Fn[]>([]);
	let taskModels = $state<Record<string, { model?: string; providerId?: number }>>({});
	let providers = $state<Provider[]>([]);
	let models = $state<Record<string, Health>>({});
	let tts = $state<any>(null);
	let loaded = $state(false);
	let loadErr = $state(false);
	// ⚠️ EMPTINESS IS NOT A FAILED READ. STATE A claims "you have never set anything up" — a
	// claim earned only by REAL reads that returned empty. A transient 500 on /providers must
	// not render the first-run card over a configured vault (the onboarding-status lesson:
	// emptiness is a property of the data, never of the error path). factsKnown gates A.
	let factsKnown = $state(false);

	// ── the ONE persistent live region's text (P8). Updated, never re-inserted. ──
	let announce = $state('');

	let customizeOpen = $state(false);
	let applying = $state(false);
	let applyErr = $state<string | null>(null);
	// Local SSE pull progress (the labeling model started by THIS tap). The models slice
	// carries the drainer's own pulls; this covers the /hardware/pull stream we opened.
	let pullPct = $state<number | null>(null);
	let pullErr = $state<string | null>(null);

	// ── STATE A ⟺ STATE B: one fact, opposite polarity (§4.0, gate A5) ─────────────────────
	const anyAssignment = $derived(Object.keys(taskModels || {}).length > 0);
	const anyProvider = $derived(providers.length > 0);
	// A needs factsKnown (a verified emptiness) AND a bundle to propose; B needs only the
	// positive evidence — a configured vault may render its summary even if one read blipped.
	const stateA = $derived(loaded && !loadErr && factsKnown && !!bundle && !anyAssignment && !anyProvider);
	const stateB = $derived(loaded && !loadErr && (anyAssignment || anyProvider));

	// Human copy for the bundle rows (W1: outcome first; ids demoted). Copy only — the ROWS
	// come from the served bundle; an unknown key simply doesn't render a proposal.
	const OUTCOMES: Record<string, string> = {
		understanding: 'Understand my messages',
		search: 'Search my memory',
		transcription: 'Hear audio',
		descriptions: 'Describe my mindscape',
	};
	const machineNoun = $derived(bundle?.hardware?.platform === 'darwin' ? 'Mac' : 'computer');
	const RUNS: Record<string, string> = { 'on-device': 'on this Mac', 'eu-cloud': 'EU cloud' };
	const runsLabel = (r: BundleRow) => (r.runs === 'on-device' ? `on this ${machineNoun}` : RUNS[r.runs] || r.runs);
	const hwLabel = $derived.by(() => {
		const h = bundle?.hardware;
		if (!h) return '';
		const chip = (h.cpuName || '').replace(/^Apple\s+/, '') || 'your machine';
		return h.totalRamGb ? `${chip}, ${h.totalRamGb} GB` : chip;
	});
	const modelNoun = (r: BundleRow) =>
		r.included ? 'included'
		: r.key === 'transcription' ? `Whisper (${r.model})`
		: r.key === 'descriptions' ? (r.providerLabel || 'Regolo (EU)')
		: r.model || '';

	// ── health: the same worse-of rule the assignment screen uses (§5 rows) ─────────────────
	const HEALTH_OF: Record<string, string[]> = {
		understanding: ['labeler', 'enricher'],
		search: ['embedder'],
		transcription: ['transcriber'],
	};
	const RANK: Record<string, number> = {
		ok: 0, unknown: 1, loading: 2, downloading: 3, paused: 4,
		no_model: 5, deps_missing: 6, unavailable: 7, down: 8, error: 9,
	};
	function healthFor(key: string): Health | null {
		const keys = HEALTH_OF[key];
		if (!keys) return null;
		const hs = keys.map((k) => models[k]).filter(Boolean) as Health[];
		if (!hs.length) return null;
		return hs.reduce((worst, h) => ((RANK[h.status] ?? 1) > (RANK[worst.status] ?? 1) ? h : worst), hs[0]);
	}
	// A CHOICE is not a fault (§8.2): unset/paused → 'choice' (muted); genuine faults → 'bad'.
	const dotClass = (status: string | null | undefined) =>
		!status || ['no_model', 'paused', 'unknown'].includes(status) ? 'choice'
		: ['downloading', 'loading'].includes(status) ? 'busy'
		: ['unavailable', 'down', 'error', 'deps_missing'].includes(status) ? 'bad' : 'ok';

	// The active provider — backend getActive() mirrored (most-recently-used is_active row).
	const active = $derived(
		[...providers].filter((p) => p.is_active)
			.sort((a, b) => (b.last_used_at || '').localeCompare(a.last_used_at || ''))[0] ?? null,
	);
	const providerName = (id: number | null | undefined) => {
		const p = providers.find((x) => x.id === id);
		if (!p) return null;
		const prov = String(p.provider || '').toLowerCase();
		if (prov === 'anthropic' || prov === 'claude') return String(p.auth_type || '').toLowerCase() === 'oauth' ? 'Claude subscription' : 'Claude API';
		return p.label || p.provider;
	};

	// ── STATE B summary rows — from the served spine + the same facts the screen loads ──────
	type SummaryRow = { key: string; label: string; what: string; status: string | null; cls: string; unset: boolean };
	const summaryRows = $derived.by<SummaryRow[]>(() => functions.map((f) => {
		const h = healthFor(f.key);
		if (f.key === 'conversation') {
			const name = providerName(taskModels.chat?.providerId) || (active ? `${providerName(active.id)}` : null);
			return { key: f.key, label: 'Conversation', what: name || 'not set up', status: name ? 'ok' : null, cls: name ? 'ok' : 'choice', unset: !name };
		}
		if (f.kind === 'bundled') return { key: f.key, label: f.label, what: 'included', status: h?.status ?? 'ok', cls: dotClass(h?.status ?? 'ok'), unset: false };
		if (f.key === 'understanding') {
			const m = taskModels.categorize?.model;
			const what = m ? `${m} (on this ${machineNoun})` : 'not set up';
			return { key: f.key, label: f.label, what, status: h?.status ?? null, cls: m ? dotClass(h?.status) : 'choice', unset: !m };
		}
		if (f.key === 'descriptions') {
			const name = providerName(taskModels.narrate?.providerId);
			return { key: f.key, label: 'Descriptions', what: name || 'not set up', status: name ? 'ok' : null, cls: name ? 'ok' : 'choice', unset: !name };
		}
		if (f.key === 'transcription') {
			const st = h?.status;
			const on = st === 'ok' && h?.model;
			const what = on ? `${h.model} (on this ${machineNoun})` : st === 'downloading' ? `downloading ${h?.progress?.pct ?? 0}%` : 'not set up';
			return { key: f.key, label: 'Transcription', what, status: st ?? null, cls: on ? 'ok' : dotClass(st), unset: !on && st !== 'downloading' };
		}
		if (f.key === 'voice') {
			const phase = tts?.qwen?.model?.phase;
			const on = phase === 'ready';
			const what = on ? `Qwen3-TTS · ready` : phase === 'downloading' ? `downloading ${tts?.qwen?.model?.progress ?? 0}%` : 'not set up';
			return { key: f.key, label: 'Voice', what, status: phase ?? null, cls: on ? 'ok' : phase === 'downloading' ? 'busy' : 'choice', unset: !on && phase !== 'downloading' };
		}
		return { key: f.key, label: f.label, what: '—', status: null, cls: 'choice', unset: false };
	}));

	// ── W6: the gap-fill — recommended functions still unset, sized from the bundle ─────────
	const GAP_KEYS = ['understanding', 'transcription', 'descriptions'];
	const gapRows = $derived((bundle?.rows || []).filter((r) => GAP_KEYS.includes(r.key) && !r.assigned));
	const gapGb = $derived(Math.round(gapRows.reduce((s, r) => s + (r.downloadGb || 0), 0) * 10) / 10);
	// The single most important "needs you" (§5): a genuine fault first, else the gap.
	const faultRow = $derived(summaryRows.find((r) => r.cls === 'bad'));
	const firstUnset = $derived(summaryRows.find((r) => r.unset));

	async function loadFacts() {
		try {
			// null = the read FAILED (unknown), never "empty" — see factsKnown above.
			const [bd, tm, pv, ts] = await Promise.all([
				api('/portal/intelligence/bundle').then((r) => (r.ok ? r.json() : null)).catch(() => null),
				api('/portal/providers/task-models').then((r) => (r.ok ? r.json() : null)).catch(() => null),
				api('/portal/providers').then((r) => (r.ok ? r.json() : null)).catch(() => null),
				api('/portal/settings/tts').then((r) => (r.ok ? r.json() : null)).catch(() => null),
			]);
			if (bd?.ok) bundle = bd;
			if (tm && typeof tm.taskModels === 'object') taskModels = tm.taskModels || {};
			if (pv && Array.isArray(pv.providers)) providers = pv.providers;
			// The COLD claim is earned only when BOTH deciding reads really answered.
			factsKnown = Boolean(tm && typeof tm.taskModels === 'object' && pv && Array.isArray(pv.providers));
			// Nothing readable at all and nothing held from before ⇒ the honest error line —
			// never a fake first-run card from a hardcoded taxonomy (§7).
			loadErr = !factsKnown && !anyAssignment && !anyProvider;
			if (ts) tts = ts;
		} finally { loaded = true; }
	}
	async function loadSpine() {
		try {
			const pr = await api('/portal/providers/presets').then((r) => r.json());
			functions = pr.functions || [];
		} catch { /* summary renders from what it has; the assignment screen is the loud one */ }
	}
	async function loadModels() {
		try {
			const r = await api('/portal/readiness?slices=models');
			if (r.ok) models = (await r.json())?.models || {};
		} catch { /* hold the last snapshot */ }
	}

	// The one-tap confirm (§4.2) — and the W6 gap-fill (same orchestrator, scoped).
	async function applyBundle(scope: string[] | null) {
		if (applying) return;
		applying = true; applyErr = null; pullErr = null;
		try {
			const r = await api('/portal/intelligence/bundle/apply', {
				method: 'POST',
				body: JSON.stringify(scope ? { functions: scope } : {}),
			});
			const j = await r.json().catch(() => ({}));
			if (!r.ok) {
				if (j?.error === 'disk_low') {
					applyErr = `Not enough free space — free up ${j.shortfallGb ?? '?'} GB, then try again.`;
					announce = 'Setup refused: not enough disk space.';
				} else {
					applyErr = 'Could not set things up. Try again in a moment.';
					announce = 'Setup failed.';
				}
				return;
			}
			const started = (j.downloads || []).length;
			announce = started
				? `Setting up — ${started} download${started === 1 ? '' : 's'} started in the background.`
				: 'Set up — nothing needed downloading.';
			// Start each download through its OWN route (§4.2.2) — never a new path.
			for (const d of j.downloads || []) {
				if (d.route === '/portal/hardware/pull') void startLabelPull(d.model);
				else if (d.route === '/portal/transcription/download') void startWhisper(d.model);
			}
			await loadFacts();      // the pane flips to STATE B by FACT, not by flag (§4.2.3)
			await loadModels();
		} catch {
			applyErr = 'Could not set things up. Try again in a moment.';
			announce = 'Setup failed.';
		} finally { applying = false; }
	}

	// The labeling-model download — the EXISTING SSE route (installs Ollama first). Approval
	// was already written by apply; this only moves the bytes and reports progress.
	async function startLabelPull(name: string) {
		pullPct = 0;
		try {
			const res = await api('/portal/hardware/pull', { method: 'POST', body: JSON.stringify({ name }) });
			if (!res.body) throw new Error('no stream');
			const reader = res.body.getReader();
			const dec = new TextDecoder();
			let buf = '';
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				let nl: number;
				while ((nl = buf.indexOf('\n')) >= 0) {
					const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
					if (!line.startsWith('data: ')) continue;
					const payload = line.slice(6);
					if (payload === '[DONE]') continue;
					let ev: any; try { ev = JSON.parse(payload); } catch { continue; }
					if (ev.done) {
						if (!ev.ok) throw new Error(ev.error || 'pull failed');
						pullPct = 100;
						announce = 'Understanding is ready.';
					} else if (ev.total) {
						pullPct = Math.min(100, Math.round((ev.completed / ev.total) * 100));
					}
				}
			}
		} catch {
			// The drainer's #206 backoff + the models slice own the retry story from here;
			// this local line just stops claiming progress it isn't making.
			pullErr = 'Download interrupted — it will retry, or use Try again in Customize.';
			announce = 'A model download was interrupted.';
		} finally {
			void loadModels();
			setTimeout(() => { pullPct = null; }, 4000);
		}
	}
	async function startWhisper(model: string) {
		try { await api('/portal/transcription/download', { method: 'POST', body: JSON.stringify({ model }) }); }
		catch { /* the transcription row's own health reports it */ }
	}

	function openCustomize(anchor?: string) {
		customizeOpen = true;
		if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
	}
	function toggleCustomize() {
		customizeOpen = !customizeOpen;
		// Assignment writes happen inside Customize — re-read the summary's facts on close so
		// the card above cannot go stale the way the two-writer pane did (SettingsView's old
		// confession comment; the E6 stale-display bug, closed by refresh-on-gesture).
		if (!customizeOpen) { void loadFacts(); void loadModels(); }
	}

	onMount(() => {
		void loadSpine();
		void loadFacts();
		void loadModels();
		// W7: the summary must stay true while visible — the popover's own slice at the
		// popover's own cadence (models ∈ C1 POLLED; SYNC, zero DB). Mount-to-unmount only.
		// ⚠️ HONEST SCOPE: this interval runs in BOTH states, not just the returning summary —
		// STATE A pays the same 4s models poll. Priced and acceptable (in-memory healths on
		// C1's POLLED list, zero DB touches), but it is a poll; do not claim otherwise
		// (review of this PR, 2026-07-17). Gating it on stateB would need an $effect-managed
		// interval across the A→B flip — deliberate simplicity over that edge.
		const t = setInterval(loadModels, 4000);
		return () => clearInterval(t);
	});
</script>

<!-- P8: ONE persistent live region; its TEXT changes, the element never re-inserts. -->
<div class="sr-live" aria-live="polite">{announce}</div>

{#if !loaded}
	<p class="muted">Loading…</p>
{:else if loadErr}
	<!-- §7: the flow does NOT render a fake bundle from a hardcoded taxonomy. -->
	<p class="muted">Could not load your intelligence settings.</p>
{:else if stateA}
	<!-- ══ STATE A — first run: one pre-suggested bundle, one confirm (§4.1) ══ -->
	<section class="card flow-a" data-state="A">
		<h2>Give Mycelium a brain</h2>
		<p class="lead">We looked at your {machineNoun} ({hwLabel}). Here’s what we suggest — one tap sets it all up.</p>

		<div class="rows">
			{#each (bundle?.rows || []) as r (r.key)}
				{#if OUTCOMES[r.key]}
					<div class="row">
						<!-- W5: NO pre-consent checkmark — rows are plain until applied. -->
						<span class="outcome">{OUTCOMES[r.key]}</span>
						<span class="runs">{runsLabel(r)}</span>
						<span class="model">{modelNoun(r)}</span>
					</div>
				{/if}
			{/each}
		</div>

		<div class="confirm">
			<button class="go" disabled={applying || !(bundle?.disk?.ok ?? true)} onclick={() => applyBundle(null)}>
				{applying ? 'Setting up…' : `Set everything up · ${bundle?.totalDownloadGb ?? '?'} GB`}
			</button>
			<button class="customize-link" onclick={() => openCustomize()}>Customize →</button>
		</div>
		{#if bundle?.disk && !bundle.disk.ok}
			<!-- W4: refuse BEFORE bytes — and say how much. -->
			<p class="disk-warn">Not enough free space — free up {bundle.disk.shortfallGb} GB first.</p>
		{:else if bundle?.disk?.freeGb != null}
			<p class="fine">You have {bundle.disk.freeGb} GB free. Downloads run in the background — you can keep using the app.</p>
		{/if}
		{#if applyErr}<p class="disk-warn">{applyErr}</p>{/if}

		<hr class="rule" />
		<!-- §4.1a W2: Conversation = inline connect chip (an OAuth hop no tap can do). -->
		<div class="chip-row">
			<span class="chip-copy">Converse — connect your Claude account</span>
			<button class="chip-btn" onclick={() => openCustomize('connect-manage')}>Connect</button>
		</div>
		<!-- §4.1a W3: Voice is a later-unlock while the render seam is stubbed (501). -->
		<p class="voice-later">Give it a voice — after setup, on the character page.</p>
	</section>
{:else if stateB}
	<!-- ══ STATE B — returning: one compact summary (§5) ══ -->
	<section class="card flow-b" data-state="B">
		<header class="b-head">
			<h2>Your intelligence</h2>
			<button class="customize-link" onclick={toggleCustomize}>{customizeOpen ? 'Close' : 'Customize'} →</button>
		</header>
		<div class="rows">
			{#each summaryRows as r (r.key)}
				<div class="srow" class:unset={r.unset}>
					<span class="slabel">{r.label}</span>
					<span class="swhat">{r.what}</span>
					<span class="dot {r.cls}" title={r.status || ''} aria-hidden="true"></span>
				</div>
			{/each}
		</div>
		{#if pullPct != null}
			<p class="fine">Downloading the labeling model… {pullPct}%</p>
		{/if}
		{#if pullErr}<p class="fine">{pullErr}</p>{/if}

		<!-- Q2: PASSIVE — one muted line + a quiet button. Nothing pulses, nothing badges. -->
		{#if faultRow}
			<p class="needs bad-line">1 thing needs you: {faultRow.label} isn’t working.
				<button class="quiet" onclick={() => openCustomize('assignment')}>Open</button></p>
		{:else if gapRows.length >= 2}
			<p class="needs">Finish what’s missing in one tap:
				<button class="quiet gap" disabled={applying} onclick={() => applyBundle(gapRows.map((r) => r.key))}>
					{applying ? 'Setting up…' : `Finish setting up · ${gapGb} GB`}
				</button></p>
		{:else if firstUnset}
			<p class="needs">1 thing needs you: {firstUnset.label} isn’t set up.
				<button class="quiet" onclick={() => openCustomize(firstUnset.key === 'voice' ? 'voice-character' : firstUnset.key === 'conversation' ? 'connect-manage' : 'assignment')}>Set up</button></p>
		{/if}
		{#if applyErr}<p class="disk-warn">{applyErr}</p>{/if}
	</section>
{/if}

<!-- ══ CUSTOMIZE — one disclosure, shared by A and B (§3.1). Default CLOSED (Q1). ══ -->
{#if loaded && !loadErr}
	<div class="customize-wrap">
		{#if !customizeOpen && stateB}
			<!-- The B card carries its own Customize control; nothing else renders here. -->
		{:else if !customizeOpen}
			<button class="customize-link lone" onclick={() => openCustomize()}>Customize →</button>
		{/if}
		{#if customizeOpen}
			<section id="assignment" class="cust-sec">
				<h3>Assignment — which model does each job</h3>
				<IntelligenceScreen />
			</section>
			<section id="connect-manage" class="cust-sec">
				<h3>Connect &amp; manage providers</h3>
				<AISettings />
			</section>
			<section id="voice-character" class="cust-sec">
				<h3>Voice</h3>
				<VoiceSection />
				<p class="fine">A voice becomes your agent’s character — described, heard and locked on the per-agent page.</p>
			</section>
			<section id="engine" class="cust-sec">
				<h3>Engine</h3>
				<EngineSelector />
			</section>
		{/if}
	</div>
{/if}

<style>
	/* P8: visually hidden, never display:none (display:none silences AT). */
	.sr-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }
	.card { display: flex; flex-direction: column; gap: 0.6rem; padding: 1rem 1.1rem; border-radius: 14px; background: rgba(255,255,255,0.025); border: 1px solid rgba(255,255,255,0.08); }
	h2 { margin: 0; font-size: 0.95rem; font-weight: 500; color: var(--color-text-primary); }
	h3 { margin: 0 0 0.5rem; font-size: 0.72rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-tertiary); }
	.lead { margin: 0; font-size: 0.8rem; color: var(--color-text-secondary); }
	.muted { color: var(--color-text-tertiary); font-size: 0.82rem; }
	.fine { margin: 0; font-size: 0.72rem; color: var(--color-text-tertiary); }
	.rows { display: flex; flex-direction: column; gap: 0.35rem; }
	/* W1: outcome · where it runs · model id (demoted type). */
	.row { display: grid; grid-template-columns: 1fr auto auto; gap: 0.75rem; align-items: baseline; padding: 0.25rem 0; }
	.outcome { font-size: 0.84rem; color: var(--color-text-primary); }
	.runs { font-size: 0.72rem; color: var(--color-text-secondary); }
	.model { font-size: 0.7rem; font-family: var(--font-mono, monospace); color: var(--color-text-tertiary); }
	.confirm { display: flex; align-items: center; gap: 0.9rem; margin-top: 0.35rem; }
	.go { font-size: 0.8rem; padding: 0.5rem 1.05rem; border-radius: 9px; border: none; background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c; font-weight: 500; cursor: pointer; font-family: inherit; }
	.go:disabled { opacity: 0.5; cursor: default; }
	.customize-link { background: none; border: none; padding: 0; font: inherit; font-size: 0.76rem; color: var(--color-accent-teal, #14b8a6); cursor: pointer; }
	.customize-link.lone { align-self: flex-start; margin-top: 0.6rem; }
	.disk-warn { margin: 0; font-size: 0.74rem; color: #f87171; }
	.rule { border: none; border-top: 1px dashed rgba(255,255,255,0.12); margin: 0.4rem 0 0.1rem; }
	.chip-row { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
	.chip-copy { font-size: 0.78rem; color: var(--color-text-secondary); }
	.chip-btn { font-size: 0.72rem; padding: 0.3rem 0.7rem; border-radius: 8px; border: 1px solid var(--color-border, rgba(255,255,255,0.14)); background: none; color: var(--color-text-primary); cursor: pointer; font-family: inherit; }
	.voice-later { margin: 0; font-size: 0.72rem; color: var(--color-text-tertiary); }
	/* STATE B */
	.b-head { display: flex; align-items: baseline; justify-content: space-between; gap: 0.6rem; }
	.srow { display: grid; grid-template-columns: 9.5rem 1fr auto; gap: 0.6rem; align-items: baseline; padding: 0.2rem 0; }
	.slabel { font-size: 0.8rem; color: var(--color-text-primary); }
	.swhat { font-size: 0.74rem; color: var(--color-text-secondary); }
	.srow.unset .swhat { color: var(--color-text-tertiary); }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--color-border, #444); justify-self: end; align-self: center; }
	.dot.ok { background: #4ade80; }
	.dot.busy { background: #60a5fa; }
	/* §8.2: a choice is NOT red. */
	.dot.choice { background: var(--color-border, #555); }
	.dot.bad { background: #f87171; }
	.needs { margin: 0.25rem 0 0; font-size: 0.74rem; color: var(--color-text-tertiary); display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
	.needs.bad-line { color: #f87171; }
	.quiet { font-size: 0.72rem; padding: 0.25rem 0.65rem; border-radius: 8px; border: 1px solid var(--color-border, rgba(255,255,255,0.14)); background: none; color: var(--color-text-secondary); cursor: pointer; font-family: inherit; }
	.quiet:disabled { opacity: 0.5; cursor: default; }
	.customize-wrap { display: flex; flex-direction: column; gap: 0.9rem; margin-top: 0.9rem; }
	.cust-sec { padding-top: 0.4rem; border-top: 1px solid rgba(255,255,255,0.07); }
</style>
