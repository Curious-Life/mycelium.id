<script lang="ts">
	// MindscapeInvite — the empty-vault invitation AND the in-window onboarding.
	// Three ethereal actions (Data · Intelligence · Connect); clicking one
	// transforms THIS panel into a minimal inline step (with Back), so setup
	// happens right here over the living 3D map — never a page jump.
	import { api } from '$lib/api';
	import { generate, fmtSeconds, retry as retryGenerate } from '$lib/generate';
	import ImportField from '$lib/components/import/ImportField.svelte';
	import ScanForData from '$lib/components/import/ScanForData.svelte';
	import SourceCatalog from '$lib/components/import/SourceCatalog.svelte';
	import { importCompletedSignal } from '$lib/stores/onboarding-data.svelte';
	import IntelligenceScreen from '$lib/components/settings/IntelligenceScreen.svelte';
	import AISettings from '$lib/components/settings/AISettings.svelte';
	import TelegramConnect from '$lib/components/channels/TelegramConnect.svelte';
	// The canonical pipeline overview (PIPELINE-TRANSPARENCY-DESIGN §"Module shape"). It subscribes
	// to the shared `pipeline` store, which the WRAPPING MindscapeView feeds from its existing
	// readiness poll (loadGenerated) — so this surface adds NO new poll/voice of its own.
	// ⚠️ Unit 5 DECISION (the two-voice unification): PipelineStatus is the canonical STAGE overview.
	// The gen-status banner below is NOT folded away, and that is deliberate, not incomplete: the
	// FROZEN gate verify:generate-phase (D2e/D2f/D2g/D2h) MOUNTS this component and asserts `.gen-status`
	// renders ALL SIX generate phases + the retryable-error Retry + the row alignment, with
	// PipelineStatus STUBBED INERT (mount-generate-render.mjs:201,382). Removing or gutting the banner
	// reds that frozen contract. So the banner stays, scoped to the ONE thing PipelineStatus (fed by
	// the readiness slice, which never emits the generate store's error text) structurally cannot show
	// — the generate store's own outcome/Retry. True single-voice unification would require relaxing
	// that frozen gate, which is out of Unit 5's scope. The built-map/rail ~4s overlap IS closed (the
	// pipeline store is now live on both surfaces — see MindscapeView's poll $effect).
	import PipelineStatus from '$lib/components/mindscape/PipelineStatus.svelte';

	let showCatalog = $state(false); // "see what you can bring in" disclosure

	let { displayName = null, onImported = () => {} }: { displayName?: string | null; onImported?: () => void } = $props();

	type Step = 'home' | 'data' | 'intelligence' | 'connect';
	let step = $state<Step>('home');

	// ── The server's facts, not this session's memory ───────────────────────────
	// ⚠️ `dataDone`/`aiDone`/`connectDone` USED TO BE session-local `$state(false)`, set
	// only by this component's own success handlers. So every check reset on reload
	// (operator's ask #2 — "resets upon reload"): a user who imported 70k messages
	// yesterday reopened the app and was told to import. The flags were a memory of THIS
	// TAB'S ACTIONS, being rendered as a claim about THE VAULT. Those are different facts,
	// and only one of them is true after F5.
	//
	// They now derive from `/portal/readiness` — the one readiness model (design §3.2).
	// A check now means "the vault has this", which is what the check always claimed.
	type Readiness = {
		// ⚠️ WIRE CONTRACT: `data` carries NO `unknown` marker — readiness.js strips it before
		// the response (`delete out.data.unknown`, readiness.js get()). The wire-visible signal
		// for "the data count FAILED" is `canGenerate.reason === 'unknown'`, emitted whenever
		// the `data` slice is requested. Keying the §3.2a latch off `data.unknown` was dead
		// code against the real server (found by driving the wire shape, 2026-07-17).
		// `evidence.unknown` IS surfaced — only data's marker is stripped.
		data?: { total: number };
		canGenerate?: { ok: boolean; reason: string | null };
		evidence?: {
			sources: { source: string; count: number }[];
			dateRange: { yearStart: number | null; yearEnd: number | null };
			conversationCount: number;
			peopleCount: number;
			unknown?: boolean;
		};
		ai?: { connected: boolean };
		channel?: { connected: boolean };
	};
	let readiness = $state<Readiness | null>(null);
	// ⚠️ FIRST-PAINT "not connected" FLASH (QA R4-11). `readiness` starts null, so dataDone/aiDone/
	// connectDone are ALL false on the very first render — the stepper paints "1 · 2 · 3" (every step
	// incomplete) before the async /readiness fetch resolves, then completed steps flip to ✓. A user
	// who connected an AI or linked a channel yesterday sees a wrong "nothing done" for a beat, then a
	// flip. `readyLoaded` gates that: until the FIRST loadReadiness() resolves (ok OR fail — a resolved
	// failure is still "we now know as much as we can, hold last-good") the stepper shows a neutral
	// checking placeholder instead of a definitive-incomplete number, so completed steps reveal as ✓
	// with no flip. It never goes back to false — subsequent polls only refine a known state.
	let readyLoaded = $state(false);

	// `evidence` is OPT-IN (readiness.js) — three unindexed aggregates. Name it once, at
	// mount and after an import; NEVER poll it (design PIVOT 2).
	const SLICES = 'data,evidence,ai,channel';
	let inFlight = false;
	async function loadReadiness() {
		// In-flight dedupe: a refresh while one is running re-ARMS the debounce instead of
		// stacking a duplicate fetch (and instead of dropping the update — a signal that
		// arrives mid-flight still lands, one debounce later).
		if (inFlight) { scheduleRefresh(); return; }
		inFlight = true;
		try {
			const r = await api(`/portal/readiness?slices=${SLICES}`);
			// ⚠️ §3.2a — ASSIGN ONLY ON A GOOD READ. A failed read (network throw OR !ok) leaves
			// `readiness` untouched, so a nonzero display is NEVER regressed to "no data" by a
			// blip. This is the hold-the-last-known-answer contract; the re-reads below lean on it.
			if (r.ok) {
				const next: Readiness = await r.json();
				// ⚠️ AND THE FACT, NOT JUST THE TRANSPORT. When the backlog read throws
				// (SQLITE_BUSY mid-import is the common case) the server answers a 200 whose
				// `data` is zeros and whose `canGenerate.reason` is 'unknown' — the `unknown`
				// marker itself never reaches the wire (see the type's WIRE CONTRACT note).
				// 'unknown' is "I could not look", never "it is empty" — so it must not
				// overwrite a known fact. Latch data (and its canGenerate) to the last
				// known-good value; evidence keeps its own surfaced marker.
				if (next?.canGenerate?.reason === 'unknown' && readiness?.data) {
					next.data = readiness.data;
					next.canGenerate = readiness.canGenerate ?? next.canGenerate;
				}
				if (next?.evidence?.unknown && readiness?.evidence && !readiness.evidence.unknown) next.evidence = readiness.evidence;
				readiness = next;
			}
		} catch { /* leave the last good answer; a failed read must not un-tick a true check */ }
		finally { inFlight = false; readyLoaded = true; }   // first resolution (ok or fail) ends the checking placeholder
	}
	$effect(() => { if (readiness === null) void loadReadiness(); });

	// ── Learn about data from ANY import path — not just this component's uploader ──────────────
	// The invite used to read readiness once on mount, then only after ITS OWN import; a drop over
	// the map (<ImportDropZone>) or an import on the Import page (<ImportView>) never reached it, so
	// it kept saying "no data uploaded" over a full vault. Two cheap, event-driven re-reads close
	// that gap WITHOUT a poll (design PIVOT 2 — never an interval on readiness):
	//   1. the cross-component import-completed signal (emitted by every import success path), and
	//   2. window focus (an import that finished while the app was backgrounded).
	// A failed re-read holds the last answer (§3.2a, above).
	//
	// ⚠️ DEBOUNCED, DEDUPED, AND FOCUS IS A CHANGE-PROBE. The evidence slice is 3 unindexed
	// aggregates + the people count (~4 uncached queries); the invite is mounted for the vault's
	// whole pre-generate life, and focus events come in flurries (cmd-tab, mission control). So:
	//   • every trigger goes through a trailing debounce (REFRESH_DEBOUNCE_MS) + in-flight dedupe;
	//   • focus does NOT re-read evidence blindly — it probes ONLY the cheap SWR-cached `data`
	//     slice and fetches the full slices only when the total actually MOVED. A focus flurry
	//     over an unchanged vault costs exactly one cached COUNT read, zero aggregate scans.
	const REFRESH_DEBOUNCE_MS = 1000;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	function scheduleRefresh() {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => { refreshTimer = null; void loadReadiness(); }, REFRESH_DEBOUNCE_MS);
	}
	let probeTimer: ReturnType<typeof setTimeout> | null = null;
	let probing = false;
	function scheduleFocusProbe() {
		if (probeTimer) clearTimeout(probeTimer);
		probeTimer = setTimeout(() => { probeTimer = null; void focusProbe(); }, REFRESH_DEBOUNCE_MS);
	}
	async function focusProbe() {
		if (probing || inFlight) return;   // a full refresh in flight already answers this
		probing = true;
		try {
			const r = await api('/portal/readiness?slices=data');   // SWR-cached COUNT — the cheap read
			if (r.ok) {
				const d: Readiness = await r.json();
				// Only a KNOWN total that differs from what we're showing warrants the full
				// (evidence-carrying) refresh. `unknown` claims nothing — hold (§3.2a). The
				// failure signal is canGenerate.reason (the wire strips data.unknown).
				if (d?.data && d.canGenerate?.reason !== 'unknown' && d.data.total !== (readiness?.data?.total ?? null)) void loadReadiness();
			}
		} catch { /* hold */ }
		finally { probing = false; }
	}
	$effect(() => {
		// Read the signal UNCONDITIONALLY so this effect tracks it (a gated read would not
		// subscribe). Skip the mount value (0) — the null-effect above owns the first load.
		const sig = importCompletedSignal();
		if (sig > 0) scheduleRefresh();
	});
	$effect(() => {
		if (typeof window === 'undefined') return;
		const onFocus = () => scheduleFocusProbe();
		window.addEventListener('focus', onFocus);
		return () => {
			window.removeEventListener('focus', onFocus);
			if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
			if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
		};
	});

	// ⚠️ `unknown` is NOT `false`. A count that FAILED must not report an empty vault
	// (design §3.2a — the live preflight bug where a catch left total=0 and the next line
	// told an owner with 70k messages to "import some conversations first"). While the
	// read is unknown we claim nothing: no tick, and no "you have no data" either.
	const dataDone = $derived(!!readiness?.data && readiness?.canGenerate?.reason !== 'unknown' && readiness.data.total > 0);
	// ⚠️ `unknown` WITH NOTHING TO HOLD — the fresh-machine case. §3.2a latches a KNOWN-good
	// count across a later `unknown`, but the FIRST read on a new box can itself be `unknown`
	// (a SQLCipher scan failure) with no prior value to hold. Then dataDone is false — and the
	// old `{:else}` was the empty-state "Bring your world in", so a vault we simply COULD NOT
	// READ was rendered as a vault the user never filled. That is the same "unknown ≠ empty"
	// bug the store's count-cap fixes, on the readiness surface. `dataUnknown` splits it out so
	// the Data step can say "couldn't read your vault — Retry" instead of impersonating empty.
	// It is true ONLY when we hold no known count: once a good read lands (or is latched),
	// canGenerate.reason is not 'unknown' and dataDone owns the render.
	const dataUnknown = $derived(readiness?.canGenerate?.reason === 'unknown' && !dataDone);
	const aiDone = $derived(readiness?.ai?.connected === true);
	const connectDone = $derived(readiness?.channel?.connected === true);

	// Compact progress stepper (Data · Intelligence · Connect), shown above every
	// step so completed + remaining are always legible at a glance.
	const progressSteps = $derived([
		{ key: 'data' as Step, label: 'Data', done: dataDone },
		{ key: 'intelligence' as Step, label: 'Intelligence', done: aiDone },
		{ key: 'connect' as Step, label: 'Connect', done: connectDone },
	]);

	// ── The evidence card — the operator's ask #3 ────────────────────────────────
	// "847 messages · 2019–2024 · 3 sources · 61 conversations · 12 people" — proof we
	// perceived what you gave us. Aggregates only; never an excerpt (CLAUDE.md §1).
	const evidenceBits = $derived.by(() => {
		const e = readiness?.evidence;
		const total = readiness?.data?.total ?? 0;
		if (!e || e.unknown || !total) return [];
		const bits: string[] = [`${total.toLocaleString()} messages`];
		const { yearStart, yearEnd } = e.dateRange;
		if (yearStart) bits.push(yearStart === yearEnd ? `${yearStart}` : `${yearStart}–${yearEnd ?? yearStart}`);
		if (e.sources.length) bits.push(`${e.sources.length} ${e.sources.length === 1 ? 'source' : 'sources'}`);
		if (e.conversationCount) bits.push(`${e.conversationCount.toLocaleString()} conversations`);
		if (e.peopleCount) bits.push(`${e.peopleCount.toLocaleString()} people`);
		return bits;
	});

	// What the Data step SHOWS once the vault has data. The rich `evidence` slice can be `unknown`
	// (a swallowed aggregate read) even when `data` is known — and in that case we must STILL show
	// how much rather than falling back to the empty-state copy (§3.2a: data known ⇒ never "no
	// data"). So the display is evidenceBits when we have them, else the bare count we always know.
	const dataTotal = $derived(readiness?.data?.total ?? 0);
	const evidenceDisplay = $derived(
		evidenceBits.length ? evidenceBits : (dataDone ? [`${dataTotal.toLocaleString()} messages`] : []),
	);

	// ── Data ───────────────────────────────────────────────────────────────────
	// One uploader (ImportField) handles everything: ChatGPT/Claude/vault zips,
	// loose .md/.txt/.pdf notes, AND a folder of markdown — routed under the hood.
	let importMsg = $state('');
	let importErr = $state('');
	function onImportResult(r: { imported: number; detail: string }) {
		importErr = '';
		importMsg = r.imported ? `Imported ${r.detail}.` : 'Imported.';
		void loadReadiness();   // the tick + the evidence card are the VAULT's answer, not this handler's
		onImported();
	}
	function onImportError(e: string) { importErr = e || 'Import failed.'; importMsg = ''; }

	// ── Intelligence ─────────────────────────────────────────────────────────────
	// Deleted: ~130 lines that hand-rolled a FOURTH "connect an AI" (its own hardware
	// recommender, preset chips, cloud form, pull-and-use). It is now <IntelligenceScreen
	// compact /> — THE component Settings renders (§3.11 "ONE component, two hosts").
	//
	// ⚠️ This was not tidiness. The deleted lane had NO §4g limit: `JURIS` labelled
	// `us-standard` with an amber "US" pill and offered it for everything, so onboarding
	// could hand a cold user a config where narrate is sensitive, the provider is US, and
	// the router then REFUSES the call (router.js: sensitive && /^us/ && !sensitiveUsExempt)
	// — descriptions silently never run, with no surface saying why. The screen a new user
	// actually sees was the one missing the guarantee.
	//
	// Caller audit before deleting: all 23 symbols (hwRec/presets/chosen/pullAndUse/
	// connectCloud/FIT/JURIS/…) were private to this step — zero references outside it.
	// ── Connect ──────────────────────────────────────────────────────────────────
	// Telegram now goes through the shared <TelegramConnect> primitive (design D1:
	// PUT /portal/channels only + D2 message-first pairing). Discord stays inline.
	let dcToken = $state('');
	let cBusy = $state(''); let cErr = $state('');
	async function saveDiscord() {
		if (!dcToken.trim()) return;
		cBusy = 'dc'; cErr = '';
		try {
			// One primitive for channel keys too: PUT /portal/channels (enables + reloads).
			await api('/portal/channels', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, discord: { token: dcToken.trim() } }) });
			dcToken = ''; void loadReadiness();
		} catch { cErr = 'Could not save Discord.'; }
		finally { cBusy = ''; }
	}
</script>

<!-- ⚠️ THE PIPELINE'S VOICE ON AN EMPTY VAULT. MindscapeView auto-starts generate the moment
     data exists (:93) — but <MindscapeDetail/>, where the outcome was rendered, lives INSIDE
     `{#if points.length > 0}` (MindscapeView:459) and is NOT MOUNTED on a fresh vault. So on
     the FIRST RUN — the most common path — a 409 ("Only 12 of 500 conversations are ready")
     or a 503 set a phase that nothing on screen could show. The embedding branch was dead in
     its own motivating case (independent re-review MED-1, 2026-07-16).
     The header activity chip cannot cover it either: up-to-date/error/embedding all return
     with NO jobId, so no `mycelium_generate` job row is ever created for it to read.
     The invite IS mounted here, unconditionally — so it speaks. §3.7 wanted Generate in the
     invite anyway ("it's a pre-generation act"); this is that, scoped to its voice.
     ⚠️ DENY-BY-DEFAULT ON THE PHASE — `!== 'idle'`, never a list. This guard was an ENUMERATION
     twice, and both times the enumeration was the bug:
       · v1 listed embedding/running/error, omitting `up-to-date` because "topology_exists cannot
         be true of a vault with no points" — false (see the note on that branch).
       · v2 added `up-to-date` and omitted `done`/`starting`, excused as "transient". Also false.
         `done` fires MindscapeView:105's `mindscapeState.load()` — THE SAME CALL whose catch
         (mindscape.ts:486) leaves `points: []`. If it fails: points stays [] ⇒ this component
         stays mounted ⇒ phase `done` ⇒ nothing renders ⇒ resetGen() at :107 → `idle` → silent
         FOREVER. And `done` is the FIRST-RUN HAPPY PATH: the invite is mounted for the whole
         fresh-vault run (embedding → running → done), so the user watches progress and then
         watches it vanish, with no map and no error. `starting` persists for as long as the POST
         takes — unbounded if the server hangs.
     Each time, the excuse was an unverified reachability argument ("cannot happen", "transient")
     protecting an unrendered phase — and each time the failure case refuted it. So the guard no
     longer takes a position on reachability at all: EVERY non-idle phase renders, and the final
     `{:else}` is a DEFAULT arm, so a phase added to GenPhase later cannot be silently omitted
     from this surface. `idle` is the only state with nothing to say.
     The rule is design §5.4: a phase the store can hold and this surface cannot show is SILENCE,
     which is the bug. An enumeration is a PROJECTION of that rule; `!== 'idle'` IS the rule. -->
{#if $generate.phase !== 'idle'}
	<div class="gen-status" class:err={$generate.phase === 'error'}>
		{#if $generate.phase === 'error'}
			<span class="gen-dot err"></span>
			<span>{$generate.error}</span>
			<!-- A retryable error (the capped `unknown` scan failure) offers a way FORWARD — never a
			     dead end. `unknown` is "could not look", so re-attempting is the honest next move;
			     the terminal errors (import first, embedder deps missing) leave retryable false and
			     show no button, because Retry cannot help them. -->
			{#if $generate.retryable}
				<button class="gen-retry" onclick={retryGenerate}>Retry</button>
			{/if}
		{:else if $generate.phase === 'up-to-date'}
			<!-- ⚠️ `up-to-date` IS REACHABLE HERE, and the reasoning that said otherwise was wrong.
			     I gated this block for embedding/running/error and wrote that 'skipped' could never
			     reach the invite because it means topology_exists, "which cannot be true of a vault
			     with no points". That conflates TWO different point counts:
			       · the route skips iff the SERVER has clustering_points > 0 (portal-mindscape.js:627)
			       · this invite mounts iff the CLIENT has msState.points.length === 0 (MindscapeView:502)
			     They diverge: mindscape.ts:486's catch leaves `points: []` + `loading: false` on ANY
			     load failure while the server's topology still exists. `hasImportedData` then comes
			     from messageCount, NOT points (MindscapeView:31), so the auto-gen effect (:94) fires
			     → 200 skipped → 'up-to-date' → this block → nothing. A user with a fully built map
			     sees the import screen and SILENCE. That is the original bug, on the exact surface
			     MED-1 flagged, kept alive by a gate comment that called it intentional.
			     Terminal state ⇒ a settled dot, not the pulsing one. (Independent review of #194.) -->
			<span class="gen-dot done"></span>
			<span>{$generate.message || 'Your map is already built.'}</span>
		{:else if $generate.phase === 'done'}
			<!-- TERMINAL, and on the fresh-vault HAPPY PATH. Normally MindscapeView:105 reloads and
			     this component unmounts before it matters — but that reload is the one that can
			     leave `points: []`, and then this line is the only thing standing between the user
			     and silence. It must not imply work: settled dot, no ETA.
			     ⚠️ NO `|| $generate.stageLabel` HERE, deliberately. generate.ts:115 sets
			     stageLabel:'Complete' UNCONDITIONALLY on done and `message` is always '' by then,
			     so `message || stageLabel || 'Your map is ready.'` made the authored copy DEAD CODE
			     and showed the user the bare internal marker "Complete" — in exactly the scenario
			     this arm exists for. A fallback chain routed through an internal label never
			     reaches its own last arm. D2e's EXPECT table forbids it. -->
			<span class="gen-dot done"></span>
			<span>{$generate.message || 'Your map is ready.'}</span>
		{:else}
			<!-- ⚠️ THE DEFAULT ARM — embedding, running, starting, and any phase added later.
			     Deliberately NOT a list: a new GenPhase must land here and say "Working…" rather
			     than fall through to nothing. Omission is what this whole block is a fix for. -->
			<span class="gen-dot"></span>
			<span>
				{$generate.message || $generate.stageLabel || 'Working…'}
				{#if $generate.etaSeconds != null}· ~{fmtSeconds($generate.etaSeconds)} left{/if}
			</span>
		{/if}
	</div>
{/if}

<!-- ⚠️ THE PIPELINE OVERVIEW ON A FRESH VAULT. The surface that makes the WHOLE pipeline visible
     while the invite is up — every stage (incl. describe + measure, and `overall` incl.
     error/up-to-date) renders here, filling the gaps the single gen-status line above cannot. It
     reads the canonical `pipeline` store, fed by MindscapeView's existing poll — no new voice. -->
<PipelineStatus />

<!-- Progress: Data · Intelligence · Connect — completed (✓) vs remaining. -->
<div class="onb-steps" aria-label="Onboarding progress">
	{#each progressSteps as s, i (s.key)}
		<button
			class="onb-step"
			class:done={readyLoaded && s.done}
			class:current={step === s.key}
			class:checking={!readyLoaded}
			onclick={() => (step = s.key)}
		>
			<!-- Until the first readiness read resolves, show a neutral placeholder — never a
			     definitive "incomplete" number that then flips to ✓ (QA R4-11 first-paint flash). -->
			<span class="onb-bubble">{#if !readyLoaded}<span class="onb-bubble-loading" aria-hidden="true"></span>{:else if s.done}✓{:else}{i + 1}{/if}</span>
			<span class="onb-step-label">{s.label}</span>
		</button>
		{#if i < progressSteps.length - 1}
			<span class="onb-connector" class:done={readyLoaded && s.done}></span>
		{/if}
	{/each}
</div>

{#if step === 'home'}
	<p class="invite-eyebrow">{#if displayName}Welcome, {displayName}{:else}Welcome{/if}</p>
	<h2 class="welcome-title invite-title">Grow your mycelium</h2>
	<p class="welcome-subtitle invite-subtitle">Three steps to begin.</p>
	<div class="invite-actions">
		<button class="invite-card" class:done={dataDone} onclick={() => (step = 'data')}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
			<span class="invite-name">Data{#if dataDone}<span class="invite-check">✓</span>{/if}</span>
			<span class="invite-hint">Bring your world in</span>
		</button>
		<button class="invite-card" class:done={aiDone} onclick={() => (step = 'intelligence')}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>
			<span class="invite-name">Intelligence{#if aiDone}<span class="invite-check">✓</span>{/if}</span>
			<span class="invite-hint">Connect an AI</span>
		</button>
		<button class="invite-card" class:done={connectDone} onclick={() => (step = 'connect')}>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v12H5.2L4 17.2z"/></svg>
			<span class="invite-name">Connect{#if connectDone}<span class="invite-check">✓</span>{/if}</span>
			<span class="invite-hint">Link a messenger</span>
		</button>
	</div>
{:else}
	<button class="invite-back" onclick={() => (step = 'home')}>← Back</button>

	{#if step === 'data'}
		{#if dataDone}
			<!-- The vault HAS data — imported here, on the Import page, OR dropped over the map.
			     Show the EVIDENCE (how much + what kind) and an "Add more" affordance; NEVER the
			     empty-state "bring your world in" copy (operator ask + §3.2a: it is not empty, and
			     a later failed read must not regress this back to the empty state — see
			     loadReadiness's hold-the-last-answer contract). -->
			<h2 class="welcome-title invite-title">Your mycelium is growing</h2>
			<p class="welcome-subtitle">Here’s what’s taken root so far. Add more any time — new exports, notes, or files all weave into the same map.</p>
			<!-- The evidence card (ask #3): proof we perceived what you gave us. evidenceDisplay is
			     the rich aggregates when known, else the bare count we always have once data exists —
			     so an `unknown` evidence read still shows HOW MUCH, never a "0 sources" impersonation. -->
			{#if evidenceDisplay.length}
				<div class="evidence">
					<span class="evidence-title">In your vault</span>
					<p class="evidence-line">{evidenceDisplay.join(' · ')}</p>
				</div>
			{/if}
			<ImportField
				accept="*"
				multiple
				folder
				label="Add more — another export, notes, or files"
				onResult={onImportResult}
				onError={onImportError}
			/>
		{:else if dataUnknown}
			<!-- ⚠️ WE COULD NOT READ THE VAULT — NOT "it is empty". The readiness count came back
			     `unknown` (a scan failure) and we hold no prior known-good value to fall back on (the
			     fresh-machine case). Showing the empty-state "Bring your world in" here would tell a
			     user with a full vault that they never imported anything — the exact §3.2a lie. So we
			     say so honestly and offer Retry, which re-reads readiness; we do NOT claim empty and
			     do NOT hang. If the vault really is empty the server answers reason:'no_messages'
			     (not 'unknown'), which lands in the {:else} below. -->
			<h2 class="welcome-title invite-title">Couldn’t read your vault just yet</h2>
			<p class="welcome-subtitle">We had trouble reading what’s already in your vault — this is usually temporary. Try again in a moment, or import more below.</p>
			<button class="invite-btn sm" onclick={() => void loadReadiness()}>Retry</button>
			<ImportField
				accept="*"
				multiple
				folder
				label="Drop an export, notes, or files — or choose"
				onResult={onImportResult}
				onError={onImportError}
			/>
		{:else}
			<h2 class="welcome-title invite-title">Bring your world in</h2>
			<p class="welcome-subtitle">Your conversations, journals, transcripts — anything that holds your thinking. Drop a ChatGPT/Claude export, loose notes (.md, .txt, .pdf), or a whole folder. Encrypted on import.</p>
			<ImportField
				accept="*"
				multiple
				folder
				label="Drop an export, notes, or files — or choose"
				onResult={onImportResult}
				onError={onImportError}
			/>
		{/if}
		{#if importMsg}<p class="invite-ok">{importMsg} Your map is forming.</p>{/if}
		{#if importErr}<p class="invite-err">{importErr}</p>{/if}

		<!-- Find local data already on this Mac (Obsidian, Claude Code) → one-click import. -->
		<div class="scan-wrap"><ScanForData onImported={() => { void loadReadiness(); onImported(); }} /></div>

		<button class="catalog-toggle" class:open={showCatalog} onclick={() => (showCatalog = !showCatalog)} aria-expanded={showCatalog}>
			<span class="catalog-chevron">{showCatalog ? '▾' : '▸'}</span>
			See everything you can bring in
		</button>
		{#if showCatalog}
			<div class="catalog-wrap"><SourceCatalog compact /></div>
		{/if}
	{:else if step === 'intelligence'}
		<h2 class="welcome-title invite-title">Choose your intelligence</h2>
		<!-- ⚠️ THE SAME COMPONENT Settings renders (§3.11) — not a copy of it. This step used to
		     hand-roll a FOURTH "connect an AI": its own recommender, its own preset chips, its own
		     cloud form. It had no §4g limit at all — it offered US providers for every function with
		     an amber "US" pill, so onboarding could hand a cold user a config where the router then
		     silently refuses to narrate (sensitive && /^us/ && !exempt). One component means the
		     limit, the recommendation and the reason can never again reach Settings and miss the
		     surface a new user actually sees. -->
		<IntelligenceScreen compact />

		<!-- ⚠️ THE PAIR, exactly as SettingsView mounts it (:739 + :761) — and mounting only the
		     screen was a REAL REGRESSION an independent review caught in this very commit.
		     IntelligenceScreen owns ASSIGNMENT (which model does what — its only writes are
		     /providers/task-models); AISettings owns the CONNECT LADDER (POST /providers/models,
		     the #133 Claude flow). The screen issues NO provider-creating POST, and
		     `readiness.ai.connected` is "an ACTIVE PROVIDER ROW exists" (readiness.js:265-273).
		     So with the screen alone: four of six rows read "Connect one under 'Connect an AI'
		     below" pointing at a section that did not exist here, nothing could create a provider,
		     and the Intelligence tick could NEVER go green.
		     The screen's own comment says the connect flow arriving here "is E/E2's job" — this IS
		     E, and I mounted the host without the ladder. Worse: the stated reason for the swap was
		     that the old lane let you pick a US provider the router then refuses, so narrate never
		     ran — and mounting the screen alone left narrate never running because NOTHING could be
		     configured. Deleting the capability is not fixing the bug. §3.7's v3 pivot names this
		     class exactly: collapsing must not leave the user with no surface at all. -->
		<AISettings />
	{:else if step === 'connect'}
		<h2 class="welcome-title invite-title">Link a messenger</h2>
		<p class="welcome-subtitle">Talk to your mind from Telegram or Discord. Optional — you can do this later.</p>
		<p class="invite-label">Telegram — paste your bot token from <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>, then message the bot to link it</p>
		<div class="invite-row invite-tg">
			<TelegramConnect compact onconnected={() => { void loadReadiness(); }} />
		</div>
		<p class="invite-label">Discord — bot token from <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers</a></p>
		<div class="invite-row">
			<input type="text" bind:value={dcToken} placeholder="bot token" autocomplete="off" data-1p-ignore />
			<button class="invite-btn sm" disabled={!dcToken || cBusy === 'dc'} onclick={saveDiscord}>{cBusy === 'dc' ? '…' : 'Save'}</button>
		</div>
		{#if connectDone}<p class="invite-ok">Linked ✓</p>{/if}
		{#if cErr}<p class="invite-err">{cErr}</p>{/if}
	{/if}
{/if}

<style>
	/* The pipeline's voice on an empty vault — see the block comment above. */
	/* ⚠️ align-items:flex-start, NOT center. The message wraps to multiple lines (a stall/error
	   sentence, or "…N / M ready"), and with center the 6px dot floated against the whole block's
	   vertical middle — visibly detached from the first line of text (the live-test misalignment).
	   Top-aligning the row and nudging the dot down by ~the first line's half-height pins it to
	   the first line for one- AND multi-line messages. */
	.gen-status {
		display: flex; align-items: flex-start; gap: 0.5rem;
		margin-bottom: 1rem; padding: 0.5rem 0.7rem; border-radius: 8px;
		border: 1px solid var(--glass-border); background: var(--glass-card-bg);
		font-size: 0.7rem; color: var(--color-text-secondary); line-height: 1.4;
	}
	.gen-status.err { border-color: rgba(248, 113, 113, 0.35); color: var(--color-accent-coral, #f87171); }
	.gen-dot {
		width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
		/* Center the dot on the FIRST line: (line-box 0.7rem×1.4 − 6px dot) / 2 ≈ 0.3rem. */
		margin-top: 0.3rem;
		background: var(--color-accent-aurum, #e5b84c); animation: gen-pulse 1.6s ease-in-out infinite;
	}
	/* Retry sits inline at the end of the status row; align it to the first text line too. */
	.gen-retry {
		margin-top: -0.1rem; margin-left: auto; flex-shrink: 0; padding: 0.15rem 0.55rem;
		border-radius: 6px; border: 1px solid var(--glass-border); background: var(--glass-card-bg);
		color: var(--color-text-primary); font-family: inherit; font-size: 0.68rem; cursor: pointer;
	}
	.gen-retry:hover { border-color: var(--color-accent-aurum, #e5b84c); }
	.gen-dot.err { background: var(--color-accent-coral, #f87171); animation: none; }
	/* `up-to-date` is TERMINAL — nothing is in flight, so the dot must not imply work.
	   jade = the design system's green (tokens.css:39/:132); the fallback matches its dark value,
	   the same convention .gen-dot.err uses for coral. ⚠️ I first wrote `--color-accent-sage`,
	   which does not exist anywhere in this codebase — an invented token silently falls back to
	   its hardcoded hex and stops tracking the light/dark themes, which is a bug CSS never
	   reports. Only tokens defined in tokens.css. */
	.gen-dot.done { background: var(--color-accent-jade, #4ade80); animation: none; }
	@keyframes gen-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }

	/* ── Progress stepper ───────────────────────────────────────────────────── */
	/* margin-top separates the stepper from the <PipelineStatus/> block directly above it (QA R4-12 —
	   the two blocks were flush); matches the stepper's own 1.5rem bottom gap for a balanced band. */
	.onb-steps { display: flex; align-items: center; gap: 0; margin-top: 1.5rem; margin-bottom: 1.5rem; }
	.onb-step {
		display: inline-flex; align-items: center; gap: 0.4rem; flex-shrink: 0;
		background: none; border: none; padding: 0; cursor: pointer; font-family: inherit;
	}
	.onb-bubble {
		display: inline-flex; align-items: center; justify-content: center;
		width: 1.4rem; height: 1.4rem; border-radius: 50%;
		font-size: 0.64rem; font-family: var(--font-mono, monospace);
		border: 1px solid var(--glass-border); background: var(--glass-card-bg);
		color: var(--color-text-tertiary); transition: all 0.2s ease;
	}
	.onb-step.done .onb-bubble { background: var(--color-accent-jade); color: var(--color-bg); border-color: transparent; }
	.onb-step.current .onb-bubble { border-color: var(--color-accent-aurum); color: var(--color-accent-aurum); }
	/* Readiness not yet read — a soft pulsing placeholder, NOT a definitive "1/2/3 incomplete" (R4-11). */
	.onb-step.checking .onb-bubble { border-color: var(--glass-border); }
	.onb-bubble-loading {
		width: 0.5rem; height: 0.5rem; border-radius: 50%;
		background: var(--color-text-tertiary); opacity: 0.5;
		animation: onb-bubble-pulse 1.6s ease-in-out infinite;
	}
	@keyframes onb-bubble-pulse { 0%, 100% { opacity: 0.25; } 50% { opacity: 0.6; } }
	.onb-step-label { font-size: 0.68rem; color: var(--color-text-tertiary); transition: color 0.2s ease; }
	.onb-step.done .onb-step-label { color: var(--color-text-secondary); }
	.onb-step.current .onb-step-label { color: var(--color-text-primary); }
	.onb-connector { flex: 1; min-width: 0.85rem; height: 1px; margin: 0 0.5rem; background: var(--glass-border); }
	.onb-connector.done { background: var(--color-accent-jade); opacity: 0.45; }

	.invite-eyebrow {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.62rem; letter-spacing: 0.18em; text-transform: uppercase;
		color: var(--color-accent-aurum, #e5b84c); margin-bottom: 0.7rem;
	}
	.invite-title { font-size: 1.5rem; font-weight: 400; letter-spacing: -0.01em; margin-bottom: 0.6rem; }
	/* Subtitle styled here (component-scoped) + a generous gap below so the cards
	   sit proportionally above the panel's bottom padding. */
	.invite-subtitle { font-size: 0.85rem; color: var(--color-text-secondary); line-height: 1.6; margin: 0 0 1.25rem; }
	.invite-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin-top: 0; }
	.invite-card {
		display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
		padding: 1.1rem 0.75rem; background: var(--glass-card-bg);
		border: 1px solid var(--glass-border); border-radius: 12px;
		color: var(--color-text-primary); cursor: pointer; text-align: center;
		transition: transform 0.18s ease, border-color 0.18s ease, background 0.18s ease;
	}
	.invite-card:hover { transform: translateY(-2px); border-color: rgba(229, 184, 76, 0.4); background: var(--glass-card-hover); }
	.invite-card.done { border-color: rgba(74, 222, 128, 0.4); }
	.invite-card svg { width: 22px; height: 22px; color: var(--color-accent-aurum, #e5b84c); opacity: 0.9; }
	.invite-name { font-size: 0.86rem; font-weight: 500; }
	.invite-check { margin-left: 0.4rem; color: var(--color-accent-jade); font-weight: 600; }
	.invite-hint { font-size: 0.7rem; color: var(--color-text-secondary); line-height: 1.35; }

	.invite-back {
		background: none; border: none; color: var(--color-text-secondary);
		font-size: 0.75rem; cursor: pointer; padding: 0; margin-bottom: 0.75rem;
	}
	.invite-back:hover { color: var(--color-text-primary); }
	/* The Intelligence lane's styles left with its markup — ~100 lines for a recommender,
	   preset chips and a cloud form that <IntelligenceScreen> now owns. The compiler named
	   all 44 orphaned selectors; they are deleted rather than left to rot. */

	.invite-row { display: flex; gap: 0.5rem; margin-top: 0.4rem; }
	.invite-row input {
		flex: 1; padding: 0.5rem 0.65rem; border-radius: 7px; font-size: 0.78rem;
		border: 1px solid var(--glass-input-border); background: var(--glass-input-bg);
		color: var(--color-text-primary); font-family: var(--font-mono, monospace);
	}
	.invite-row input::placeholder { color: var(--color-text-tertiary); }
	.invite-btn {
		margin-top: 0.5rem; padding: 0.5rem 1.1rem; border-radius: 8px; border: none;
		background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c;
		font-size: 0.8rem; font-weight: 500; cursor: pointer; font-family: inherit;
	}
	.invite-btn.sm { margin-top: 0; padding: 0.5rem 0.9rem; font-size: 0.75rem; white-space: nowrap; }
	.invite-btn:disabled { opacity: 0.5; cursor: default; }
	.invite-label { font-size: 0.7rem; color: var(--color-text-tertiary); margin: 0.8rem 0 0.2rem; line-height: 1.4; }
	.invite-label a { color: var(--color-accent-aurum, #e5b84c); }
	.invite-ok { font-size: 0.74rem; color: #4ade80; margin-top: 0.5rem; }
	.invite-err { font-size: 0.74rem; color: #f87171; margin-top: 0.5rem; }
	/* ── The evidence card ("In your vault") ─────────────────────────────────── */
	.evidence {
		margin-top: 0.9rem; padding: 0.65rem 0.8rem; border-radius: 10px;
		border: 1px solid rgba(74, 222, 128, 0.28); background: rgba(74, 222, 128, 0.05);
	}
	.evidence-title {
		display: block; font-family: var(--font-mono, monospace);
		font-size: 0.56rem; letter-spacing: 0.14em; text-transform: uppercase;
		color: var(--color-accent-jade); margin-bottom: 0.3rem;
	}
	.evidence-line { font-size: 0.76rem; color: var(--color-text-secondary); line-height: 1.5; margin: 0; }

	/* Local-data scan ("Scan this Mac") sits between the uploader and the catalog. */
	.scan-wrap { margin-top: 0.9rem; }
	/* "See everything you can bring in" disclosure → expands the source catalog. */
	.catalog-toggle {
		display: inline-flex; align-items: center; gap: 0.4rem; margin-top: 0.9rem;
		background: none; border: none; padding: 0; cursor: pointer; font-family: inherit;
		font-size: 0.78rem; color: var(--color-accent-aurum, #e5b84c);
	}
	.catalog-toggle:hover { text-decoration: underline; }
	.catalog-chevron { font-size: 0.7rem; opacity: 0.85; }
	.catalog-wrap { margin-top: 0.75rem; animation: cat-fade 0.15s ease-out; }
	@keyframes cat-fade { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
	@media (max-width: 520px) { .invite-actions { grid-template-columns: 1fr; } }
</style>
