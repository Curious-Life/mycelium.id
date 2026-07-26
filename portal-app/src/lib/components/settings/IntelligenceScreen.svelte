<script lang="ts">
	// THE Intelligence screen — organized by FUNCTION (design §3.11), not by provider.
	//
	// ⚠️ ONE component, meant for TWO hosts: Settings → Intelligence AND the onboarding
	// Intelligence step. Map §5.2 found THREE implementations of "connect an AI" (AISettings /
	// the onboarding rail / MindscapeInvite), each with different capability and different bugs
	// — the rail's Claude path was the LEGACY dead-end #133 had already fixed in Settings, and
	// the surface a cold user actually saw had no Claude option at all. One component means a
	// recommendation can never again reach one surface and not the other. E/E2 mount it in
	// onboarding; this slice mounts it in Settings.
	//
	// ⚠️ THE TAXONOMY IS SERVED, NEVER HARDCODED. `functions` comes from
	// GET /portal/providers/presets (src/inference/role-models.js INTELLIGENCE_FUNCTIONS). That
	// is the whole point of the spine: a badge here CANNOT diverge from the model that actually
	// runs (verify:intelligence-functions F3 pins recommend == labelingRecommendedModel(); P10b
	// pins that the list reaches this client intact). Hardcoding a row would re-create §5.2.
	//
	// `kind` is the discriminator for `recommend`'s polymorphic namespace — this mapping was
	// implicit until the component landed, so it is written down once, here:
	//   'provider'     → a provider ladder      (recommend = a preset/subscription id)
	//   'local'        → an on-box model NAME   (recommend = e.g. 'qwen3.5:4b')
	//   'cloud-eu-zdr' → a cloud preset id      (recommend = e.g. 'regolo')  — §4g-limited
	//   'bundled'      → nothing to choose      (recommend = the model that ships in the app)
	//   'whisper'      → its own catalog+route  (recommend = 'by-ram' sentinel)
	//   'tts'          → its own catalog        (recommend = the Qwen3-TTS variant that WON the live listening test, 2026-07-15)
	import { onMount, onDestroy } from 'svelte';
	import { api } from '$lib/api';

	// "Try again" for an unreachable local-model state: clears the pull backoff and kicks a drain
	// cycle (POST /portal/enrichment/trigger), then RE-FETCHES health so the row tells the truth.
	// ⚠️ THE RE-FETCH IS THE FEATURE, not polish. An earlier version of this screen loaded health
	// exactly ONCE (onMount): the retry would WORK in the background while the row kept saying
	// "not reachable" with a Try again button, and the user's only honest reading was "the retry
	// is broken" (independent review MED, 2026-07-17). Two refreshes (~2s and ~6s) bracket the
	// likely recovery: the trigger's cycle needs a moment to list/pull before health flips.
	// The while-unsettled poll below now also covers the long tail (a MULTI-GB pull no longer
	// freezes at a ~6s snapshot — the row tracks it live until it settles).
	let retryBusy = $state(false);
	async function retryHealth() {
		if (retryBusy) return;
		retryBusy = true;
		try { await api('/portal/enrichment/trigger', { method: 'POST' }); } catch { /* the health row shows the state */ }
		// After each bracket refresh, hand off to the while-unsettled poll: a retry that turns
		// into a pull ('downloading') stays live instead of freezing at the ~6s snapshot.
		setTimeout(async () => { await load(); maybePollModels(); retryBusy = false; }, 2000);
		setTimeout(() => { void load().then(maybePollModels); }, 6000);
	}
	import OnboxTaskSelect from './OnboxTaskSelect.svelte';
	// Voice's rail, folded under the Voice function row (Phase 3 de-dup) — the exact sibling of
	// TranscriptionSetup under the whisper row. Was a separate Customize section + a pointer note.
	import VoiceSection from './VoiceSection.svelte';
	// Engine folded into the Conversation function row (2026-07-19) — the engine only governs agent
	// turns (chat, harness, reflection), which ARE Conversation's tasks, so "how a turn runs" is an
	// attribute of that function, not a separate Customize section. Was a standalone Engine tab.
	import EngineSelector from './EngineSelector.svelte';
	// The whisper download rail — moved here from AISettings (Part I §9): the rail renders
	// under the Transcription FUNCTION row, so the assignment and its machinery share a home.
	// Its own catalog + route, unchanged (§3.10d "no third catalog").
	import TranscriptionSetup from './TranscriptionSetup.svelte';
	// ⚠️ SHARED, not a local snapshot. The §4g toggle lives in AISettings — mounted as a SIBLING
	// IN THIS SAME PANE — and this screen PRINTS the guarantee that depends on it. Reading it
	// once at onMount meant flipping the toggle twenty lines below left this copy claiming
	// "…stay in the EU or on your device" while the router already sent narrate to us-standard.
	// The display IS the promise here, so the state must be single-copy (independent review ×3).
	import { sensitiveExempt, seedSensitiveExempt } from '$lib/stores/sensitive-exempt.svelte';

	type Fn = {
		key: string; label: string; sub: string;
		tasks: string[]; kind: string; jurisdiction: string;
		recommend: string | null; why: string;
	};
	// `jurisdiction` is the SERVER's classification (publicRow). Never re-derive it here.
	type Provider = { id: number; label: string; provider: string; is_active: number; base_url?: string; jurisdiction?: string; auth_type?: string };
	type Health = { status: string; message: string | null; detail?: string | null; model: string | null; progress: { pct: number } | null };
	// A hardware-recommender catalog row (GET /portal/hardware/recommend → recommendations[]).
	// The SAME shape AISettings uses in the Providers tab — read, never re-derived here.
	type Rec = { name: string; bestFor?: string; estimatedGb?: number; fitLevel?: string; installed?: boolean; recommended?: boolean; ageMonths?: number | null };

	let { compact = false }: { compact?: boolean } = $props();

	let functions = $state<Fn[]>([]);
	let taskModels = $state<Record<string, { model?: string; providerId?: number }>>({});
	// ── D-075: what will ACTUALLY run, served by the RESOLVER ────────────────────────────────
	// `taskModels` is only the user's EXPLICIT assignments. This screen used to highlight from
	// it alone, so when the system auto-selected a provider (a connected subscription becoming
	// the active provider — D-029/#360 deliberately does NOT write taskModels) chat and
	// narration were already running on it while this screen showed nothing selected.
	//
	// The fix is NOT "also check the active provider here" — that is a second copy of the
	// selection rule, and a second copy is what diverged. GET /portal/providers/effective-models
	// runs `resolveEffectiveAssignment` (src/inference/resolve.js) — the SAME function
	// `resolveInferenceConfigForTask` runs at inference time — and this screen renders its
	// answer. Display only: the endpoint is read-only, and WRITES below still key on
	// `taskModels`, so rendering an auto-selection can never turn it into a stored explicit one.
	type Effective = { source: 'explicit' | 'active' | 'none'; providerId: number | null; model: string | null };
	// ⚠️ `null` means WE HAVE NO ANSWER — it is NOT the same as "the resolver says nothing runs",
	// and collapsing the two is a defect this screen has now had twice. The first version stored
	// `{}` on a failed read, so `effectiveOf()` returned null either way: on any failure of the
	// (soft) effective-models read, every button lost `isRunning` while `isPinned` stayed true, so
	// a provider that was pinned AND running fine rendered amber, tagged "chosen · not running",
	// claiming a fault that did not exist — in the one screen whose whole purpose is not lying
	// about what runs. Worse, the obvious response (click the amber button) sends providerId:null
	// and DELETES the pin. A network blip must not manufacture a fault, and must never turn into a
	// click-to-delete affordance (independent review ×2, HIGH).
	let effective = $state<Record<string, Effective> | null>(null);
	// Have we ever successfully learned what runs? Drives the honest third state below.
	const effectiveKnown = $derived(effective !== null);
	let providers = $state<Provider[]>([]);
	let models = $state<Record<string, Health>>({});
	// The full local catalog (GET /portal/hardware/recommend → recommendations). One read feeds
	// BOTH surfaces below: `installedLocal` (the OnboxTaskSelect "other installed models" branch —
	// R4-6, previously dead: this state was declared and never assigned) AND the optional
	// "search all models" advanced disclosure (R4-5). It is the SAME source the Providers tab uses
	// (AISettings hwRec), so the two lists can never diverge.
	let catalog = $state<Rec[]>([]);
	let installedLocal = $state<string[]>([]);
	// The advanced "search all models" disclosure — HIDDEN by default (per function key), so a
	// normal user sees only the curated OnboxTaskSelect; an advanced user expands to search the
	// full 300+ catalog. Curated-first, full-catalog only when a query is typed (the AISettings
	// pattern — never dump 300 models on someone who just wants the recommendation).
	let advancedOpen = $state<Record<string, boolean>>({});
	let modelQuery = $state('');
	const RECENCY_MONTHS = 12;
	const catalogMatches = $derived.by(() => {
		const q = modelQuery.trim().toLowerCase();
		if (q) return catalog.filter((m) => m.name.toLowerCase().includes(q) || (m.bestFor || '').toLowerCase().includes(q));
		return catalog.filter((m) => m.recommended || m.ageMonths == null || (m.ageMonths ?? 99) <= RECENCY_MONTHS);
	});
	let busy = $state<string | null>(null);
	let err = $state<string | null>(null);
	// §4g's opt-in (settings.allowSubscriptionSensitive) — part of the router's rule, so part of
	// this screen's rule (see offerable()). Read from the SHARED store so a flip in AISettings
	// re-renders this guarantee immediately.
	const subscriptionExempt = $derived(sensitiveExempt.allowed);
	// ⚠️ AND WHETHER WE KNOW IT YET. `allowed` starts false, so an UNREAD flag is indistinguishable
	// from "opted out" — the screen would print "…stay in the EU or on your device" on an EXEMPT
	// vault. Transient on first paint; PERMANENT when the read soft-fails (a 503 or an {ok:false}
	// body meant the value was never set at all). A guarantee you have not verified must not be
	// printed (independent review ×4, 2026-07-16). The store carried this flag for exactly this
	// purpose and nothing read it — the fix was written and never wired.
	const exemptKnown = $derived(sensitiveExempt.loaded);

	// Which health member reports on a function. Understanding owns TWO tasks, so it has TWO
	// health members (labeler + enricher, both from #164/M) — and it must show the WORSE of
	// them: one approval sets both, so if either is unhealthy the function is not working, and
	// reporting only the labeler would hide exactly the dormancy this round exists to end.
	const HEALTH_OF: Record<string, string[]> = {
		understanding: ['labeler', 'enricher'],
		search: ['embedder'],
		transcription: ['transcriber'],
	};
	const RANK: Record<string, number> = {
		ok: 0, unknown: 1, loading: 2, downloading: 3, paused: 4,
		no_model: 5, deps_missing: 6, unavailable: 7, down: 8, error: 9,
	};
	function healthFor(f: Fn): Health | null {
		const keys = HEALTH_OF[f.key];
		if (!keys) return null;
		const hs = keys.map((k) => models[k]).filter(Boolean) as Health[];
		if (!hs.length) return null;
		return hs.reduce((worst, h) => ((RANK[h.status] ?? 1) > (RANK[worst.status] ?? 1) ? h : worst), hs[0]);
	}
	// The status DOT's colour class — a CHOICE (no_model / paused / unset) is muted, never red;
	// genuine faults are red. Mirrors the flow summary's §8.2 rule.
	const dotClass = (status: string | null | undefined) =>
		!status || ['no_model', 'paused', 'unknown'].includes(status) ? 'choice'
		: ['downloading', 'loading'].includes(status) ? 'busy'
		: ['unavailable', 'down', 'error', 'deps_missing'].includes(status) ? 'bad' : 'ok';

	// The model currently approved for a function = its FIRST task's setting. Safe because
	// F6/F6b pin that a function's tasks are kind-homogeneous and Understanding is exactly
	// ONBOX_TASKS — so its two tasks always carry the same model (the route writes them together).
	const approvedOf = (f: Fn) => (f.tasks.length ? (taskModels[f.tasks[0]]?.model || '') : '');
	// The EFFECTIVE selection for a function = its first task's, from the resolver (D-075).
	// Same first-task rule as approvedOf, for the same F6/F6b reason (a function's tasks are
	// kind-homogeneous and the route writes them together).
	const effectiveOf = (f: Fn): Effective | null => (f.tasks.length ? (effective?.[f.tasks[0]] ?? null) : null);

	// ── LIVE HEALTH after a write (the stale-badge fix, 2026-07-18) ──────────────────────────
	// THE BUG: this screen read `/portal/readiness?slices=models` ONCE in onMount, and
	// approve()/assign() never refetched — so picking a model for Understanding left the badge
	// saying "No labeling model approved" FOREVER (until remount). The write path was always
	// correct (PUT fans out to both tasks — verify-task-models M8); the DISPLAY was a
	// mount-time snapshot. The operator read that as "selecting the model doesn't work".
	//
	// THE FIX, in two parts (the TranscriptionSetup maybePoll pattern, same 2s interval):
	//   1. refetchModels() immediately after a successful write;
	//   2. a poll that runs ONLY while some reported health is UNSETTLED, and stops the moment
	//      everything settles. Unsettled means:
	//        • mid-transition (`downloading`/`loading`/`unknown`) — the busy states; or
	//        • the report LAGS a setting this screen wrote: the drainer re-reads settings on its
	//          ~15s cycle, so right after an approval the slice still says `no_model` (and after
	//          an un-approval still says `ok`). Only `kind==='local'` rows can lag — cloud
	//          assignments have no drainer between the setting and the report.
	//
	// COST — priced, not assumed (the gates-assert-shape-never-cost lesson):
	//   • server: the models slice is SYNC, in-memory supervisor reads — ZERO DB touches per hit
	//     (src/readiness.js `models()` + its get(): "Both are SYNC … never a DB hit"); `models`
	//     is on verify-readiness C1's POLLED allowlist, which asserts exactly that.
	//   • client: the poll EXISTS only while unsettled. Steady state = zero requests. The lag
	//     wait is additionally CAPPED (LAG_TICK_CAP ≈ 6 drainer cycles) so a drainer that never
	//     reports (stopped process) cannot buy an eternal poll; a genuine download keeps the
	//     poll alive for its own duration, exactly like TranscriptionSetup's busy poll.
	// The intelligence-screen gate pins both properties: a refetch after approve, and ZERO
	// further fetches across two windows once the fixture settles.
	const MODELS_POLL_MS = 2000;
	const LAG_TICK_CAP = 45;   // 45 × 2s = 90s ≈ six 15s drainer cycles
	let modelsPoll: ReturnType<typeof setInterval> | null = null;
	let lagTicks = 0;

	async function refetchModels() {
		try {
			const r = await api('/portal/readiness?slices=models');
			if (r.ok) models = (await r.json())?.models || {};
		} catch { /* hold the last snapshot; the poll (if running) retries */ }
	}

	// D-075: after ANY write that can change what runs, re-ask the RESOLVER. Deriving the new
	// highlight from the write's own response would be the second copy of the rule again — and it
	// would be wrong for the case that matters most: CLEARING an assignment hands the task back to
	// the active provider, and only the resolver knows which row that is.
	async function refetchEffective() {
		try {
			const r = await api('/portal/providers/effective-models');
			if (r.ok) {
				const j = await r.json();
				// Same rule as load(): a malformed body is UNKNOWN, never "nothing runs".
				if (j && typeof j.effective === 'object' && j.effective) effective = j.effective;
			}
		} catch { /* hold the last answer — never recompute it locally, never downgrade to {} */ }
	}

	function pollVerdict(): 'busy' | 'lag' | 'settled' {
		let lag = false;
		for (const f of functions) {
			const keys = HEALTH_OF[f.key];
			if (!keys) continue;
			const approved = approvedOf(f);
			for (const k of keys) {
				const h = models[k];
				if (!h) continue;
				if (h.status === 'downloading' || h.status === 'loading') return 'busy';
				if (h.status === 'unknown') lag = true;
				else if (f.kind === 'local' && approved && h.status === 'no_model') lag = true;
				else if (f.kind === 'local' && !approved && h.status === 'ok') lag = true;
			}
		}
		return lag ? 'lag' : 'settled';
	}

	function stopModelsPoll() {
		if (modelsPoll) { clearInterval(modelsPoll); modelsPoll = null; }
		lagTicks = 0;
	}
	function maybePollModels() {
		if (pollVerdict() === 'settled') { stopModelsPoll(); return; }
		if (!modelsPoll) { lagTicks = 0; modelsPoll = setInterval(modelsPollTick, MODELS_POLL_MS); }
	}
	async function modelsPollTick() {
		const v = pollVerdict();
		if (v === 'settled') { stopModelsPoll(); return; }
		if (v === 'busy') lagTicks = 0;                                  // visible progress → keep tracking
		else if (++lagTicks > LAG_TICK_CAP) { stopModelsPoll(); return; } // lag never resolved → bounded stop
		await refetchModels();
		if (pollVerdict() === 'settled') stopModelsPoll();               // stop the tick it settles — no idle extra
	}
	onDestroy(stopModelsPoll);

	// Locals the user could pick INSTEAD of the recommendation. The recommendation has its own
	// option inside OnboxTaskSelect, so it is excluded here or it renders twice.
	const localOptions = (f: Fn) => {
		const set = new Set(installedLocal);
		const cur = approvedOf(f);
		if (cur) set.add(cur);
		if (f.recommend) set.delete(f.recommend);
		return [...set];
	};

	// ⚠️ §4g — the generic filter for an 'eu-or-local' function. DORMANT as of 2026-07-19: no
	// function carries that jurisdiction anymore. `narrate` (Descriptions) was the last one, and
	// the operator lifted its limit — Descriptions is now jurisdiction 'any' (role-models.js), so
	// the guard below (`f.jurisdiction !== 'eu-or-local' ⇒ return providers`) short-circuits and
	// every provider is offered. This code is KEPT, not deleted: if a future task rejoins
	// SENSITIVE_TASKS and its function is marked 'eu-or-local', the router refuses a US provider
	// for it and offering one here would be a silent lie — so the filter (and the copy below) must
	// stay in step with the router. It is generic infrastructure, not narrate-specific.
	//
	// When it DOES apply: the router REFUSES a US provider for a sensitive task and falls back to
	// EU/on-device, so an eu-or-local function is offered ONLY eu-zdr/local providers, with the
	// reason stated.
	//
	// ⚠️ `p.jurisdiction` COMES FROM THE SERVER (publicRow → presets.js jurisdictionForBaseUrl,
	// the same function the router trusts). This code does NOT classify. The first version did
	// — with an unanchored regex over base_url — and it re-introduced, verbatim, the
	// anti-pattern presets.js:40-49 documents deleting: `https://localhost.attacker.io/v1` read
	// as LOCAL. 9 of 13 URLs disagreed with the server; it offered US lookalikes to a
	// §4g-limited function AND hid genuine EU/local providers behind a reason that was false for
	// them (independent review, 2026-07-16). If you need a jurisdiction, ASK THE SERVER.
	//
	// ⚠️ AND THE RULE IS NOT `jurisdiction` ALONE. The router's real condition is
	//     sensitive && /^us/.test(jurisdiction) && !cfg.sensitiveUsExempt      (router.js)
	// — a US provider IS allowed for a sensitive task when it is the user's OWN Claude
	// SUBSCRIPTION and they explicitly opted in (resolve.js applySensitiveExempt; never a plain
	// US API key). Filtering on jurisdiction alone made this screen print "…stay in the EU or on
	// your device" over a vault where narrate DEMONSTRABLY ran on us-standard — a FALSE PRIVACY
	// STATEMENT, which is the §3.11d silent-lie class inverted (independent review ×2).
	//   Two earlier comments here each claimed some gate made this filter equivalent to the
	//   router. Both were false. The screen is equivalent because it implements BOTH CLAUSES and
	//   S4c drives the exempt configuration — not because a comment says so.
	const offerable = (f: Fn) => {
		if (f.jurisdiction !== 'eu-or-local') return providers;
		return providers.filter((p) =>
			p.jurisdiction === 'eu-zdr' || p.jurisdiction === 'local'
			// The exemption is subscription-only, exactly as the router applies it.
			// ⚠️ NOT strictly coextensive, and the gap is worth knowing: the router keys on
			// `providerName === 'claude_subscription'` (resolve.js), which mapRowToConfig derives
			// from `token && !baseUrl`; this keys on auth_type. They coincide because
			// persistSubscription is the ONLY writer of 'oauth' — a property of the WRITERS, not
			// of this filter. Mutating a base_url onto the oauth row, or the setup_token demote,
			// separates them. BOTH directions fail CLOSED (router refuses / screen under-offers),
			// so this is recorded, not defended here (independent review ×3, 2026-07-16).
			|| (subscriptionExempt && String(p.auth_type || '').toLowerCase() === 'oauth'));
	};

	let loaded = $state(false);
	async function load() {
		err = null;
		// ⚠️ The SPINE is load-bearing — without it there is no screen, so its failure must be
		// LOUD. An earlier version .catch()'d every fetch to {}, so Promise.all never rejected,
		// the outer catch was unreachable, and a dead server rendered "Loading…" FOREVER
		// (independent review, 2026-07-16). The secondary reads stay soft: a screen that can
		// still show you your functions and let you choose is better than a blank error because
		// one health probe hiccuped.
		try {
			const pr = await api('/portal/providers/presets').then((r) => r.json());
			functions = pr.functions || [];
			if (!functions.length) throw new Error('no functions served');
		} catch {
			err = 'Could not load your intelligence settings.';
			loaded = true;
			return;
		}
		const [tm, ef, pv, rd, ex, hw] = await Promise.all([
			api('/portal/providers/task-models').then((r) => r.json()).catch(() => ({})),
			// D-075: the resolver's answer. Soft like the other secondary reads — a failure must not
			// blank the screen. But it must resolve to UNKNOWN, never to "nothing runs": see the
			// `effective` declaration. A failed read leaves `effective` null and the row says so.
			// It must NEVER be reconstructed from taskModels here.
			api('/portal/providers/effective-models').then((r) => (r.ok ? r.json() : null)).catch(() => null),
			api('/portal/providers').then((r) => r.json()).catch(() => ({})),
			api('/portal/readiness?slices=models').then((r) => r.json()).catch(() => ({})),
			api('/portal/providers/sensitive-subscription').then((r) => r.json()).catch(() => ({})),
			// The local catalog + installed flags — soft (a slow/absent hardware probe must not
			// blank the screen). Feeds installedLocal (the OnboxTaskSelect options) + the search.
			api('/portal/hardware/recommend').then((r) => r.json()).catch(() => ({})),
		]);
		taskModels = tm.taskModels || {};
		// Only a well-formed answer counts as knowing. Anything else stays UNKNOWN.
		effective = (ef && typeof ef.effective === 'object' && ef.effective) ? ef.effective : null;
		providers = pv.providers || [];
		models = rd.models || {};
		// R4-6: populate installedLocal from the recommender's `.installed` flag (the existing
		// source — no new readiness invented), so localOptions() surfaces every installed local
		// model as a choice. R4-5: keep the full list for the advanced search disclosure.
		const recs: Rec[] = Array.isArray(hw?.recommendations) ? hw.recommendations : [];
		catalog = recs;
		installedLocal = recs.filter((m) => m.installed).map((m) => m.name);
		// SEED: if the user flipped the toggle while these parallel calls were in flight, their
		// choice must win over this stale read (independent review ×4).
		if (ex && typeof ex.allowed === 'boolean') seedSensitiveExempt(ex.allowed);
		loaded = true;
	}

	// APPROVE BY FUNCTION — one call writes every task the function owns, atomically.
	// NOT per-task: Understanding = {categorize, enrich}, and approving one while leaving the
	// other unset is precisely how L2 enrichment sat silently dead (M's re-review). The route
	// fans out and validates up-front so a function can never half-apply (gate M8 in
	// verify-task-models.mjs).
	async function approve(f: Fn, model: string) {
		busy = f.key;
		try {
			const r = await api('/portal/providers/task-models', {
				method: 'PUT',
				body: JSON.stringify({ function: f.key, model }),
			});
			if (r.ok) {
				taskModels = (await r.json()).taskModels || {};
				// LIVE HEALTH: the badge must reflect this approval, not the mount snapshot
				// (see the poll block above). Refetch now, then poll while unsettled.
				await refetchModels();
				await refetchEffective();
				maybePollModels();
			} else err = 'That model could not be saved.';
		} catch { err = 'That model could not be saved.'; }
		finally { busy = null; }
	}

	// Assign a PROVIDER to a cloud function. Separate from approve() because the route keys on
	// providerId for cloud tasks and on `model` for on-box ones — and conflating them is exactly
	// how the first version broke: every provider button called approve(f, '') with no
	// providerId, so the route's `providerId == null → delete taskModels[t]` branch CLEARED the
	// assignment. Two different buttons produced byte-identical bodies, and no gate drove them
	// (S2 only exercised the on-box <select> — 4 of 6 rows had no coverage on their write path;
	// independent review, 2026-07-16).
	async function assign(f: Fn, providerId: number | null) {
		busy = f.key;
		try {
			const r = await api('/portal/providers/task-models', {
				method: 'PUT',
				body: JSON.stringify({ function: f.key, providerId }),
			});
			if (r.ok) {
				taskModels = (await r.json()).taskModels || {};
				// Same live-health rule as approve(). A cloud assignment cannot LAG (no drainer
				// between setting and report), but refetching keeps one code path and the poll's
				// verdict decides for itself — settled ⇒ it never starts.
				await refetchModels();
				// …and the highlight: assigning OR clearing changes the effective selection.
				await refetchEffective();
				maybePollModels();
			} else err = 'That model could not be saved.';
		} catch { err = 'That model could not be saved.'; }
		finally { busy = null; }
	}

	onMount(() => {
		// After the first load, start the poll ONLY if something is already unsettled (e.g. the
		// screen mounted mid-download) — a settled vault starts no timer at all.
		void load().then(maybePollModels);
	});
</script>

<div class="intel" class:compact>
	{#if err}<p class="err">{err}</p>{/if}

	{#each functions as f (f.key)}
		{@const health = healthFor(f)}
		{@const approved = approvedOf(f)}
		<section class="fn">
			<!-- One uniform row per job: status dot · name + one-line outcome + reason · control.
			     The old per-row "Show all models" disclosure is gone (the select already lists every
			     local; cloud points to the Providers tab). -->
			<div class="fn-row">
				<span class="dot {dotClass(health?.status)}" title={health?.status || ''} aria-hidden="true"></span>
				<div class="fn-id">
					<div class="fn-title"><strong>{f.label}</strong><span class="sub">{f.sub}</span></div>
					<!-- Recommendation-FIRST, with the reason (§3.11c) — one quiet line. -->
					<p class="why">{f.why}</p>
				</div>
				<div class="fn-ctl">
					{#if f.kind === 'bundled'}
						<!-- ⚠️ NOT a choice (§3.10d-c): the embedder ships INSIDE the app — no picker,
						     no rail. Dressing it as consent is the dishonesty §3.10 removes. -->
						<span class="included">Included · {f.recommend}</span>
					{:else if f.kind === 'local' && f.recommend}
						<OnboxTaskSelect
							value={approved}
							recModel={f.recommend}
							options={localOptions(f)}
							disabled={busy === f.key}
							onpick={(m) => approve(f, m)}
						/>
					{/if}
					{#if health && health.status !== 'ok'}
						<!-- Honest states, not a spinner (§3.5): `no_model`/`paused` are CHOICES, shown
						     muted, never an error. `ok` is carried by the green dot; only
						     attention-worthy states print text. -->
						<span class="health {health.status}">
							{#if health.status === 'downloading' && health.progress}
								Downloading… {health.progress.pct}%
							{:else}{health.message || health.status}{/if}
						</span>
						<!-- ONLY 'unavailable' — the drainer's vocabulary, where the trigger route can
						     act. The embedder's error/down come from a different subsystem (review LOW,
						     2026-07-17). -->
						{#if health.status === 'unavailable'}
							<button class="retry-btn" onclick={retryHealth} disabled={retryBusy}
								title={health.detail ? `Last error: ${health.detail}` : 'Retry now'}
							>{retryBusy ? 'Retrying…' : 'Try again'}</button>
						{/if}
					{/if}
				</div>
			</div>

			{#if f.kind === 'whisper'}
				<!-- The whisper rail lives HERE (Part I §9) — under the function it assigns. -->
				<div class="fn-extra"><TranscriptionSetup /></div>

			{:else if f.kind === 'tts'}
				<!-- Voice's OWN rail (TTS catalog + variant picker + preview, #209) folded under the
				     Voice row — the symmetry with the whisper row (Phase 3 de-dup). Same VoiceSection
				     component, mounted once, not a re-implementation (§3.10d). -->
				<div class="fn-extra"><VoiceSection /></div>

			{:else if f.kind === 'local' && f.recommend && f.tasks.length > 1}
				<!-- Say it plainly: one approval covers both tasks. -->
				<p class="note fn-extra">One choice covers labels and entities.</p>

			{:else if f.kind !== 'bundled' && f.kind !== 'local' && f.kind !== 'tts'}
				<div class="providers fn-extra">
					<!-- ⚠️ §4g DORMANT (2026-07-19): no function is 'eu-or-local' anymore — narrate's
					     limit was lifted, so offerable() returns ALL providers and these guarded
					     branches never fire. KEPT as generic infra: if a task rejoins SENSITIVE_TASKS
					     and its function is 'eu-or-local', the router refusal and this filter+copy
					     must agree (§3.11d). See role-models.js + offerable() above. -->
					{#if f.jurisdiction === 'eu-or-local' && !exemptKnown && offerable(f).length === 0}
						<p class="limit">
							Descriptions analyse your personal themes. Checking where they’re allowed to run…
						</p>
					{:else if offerable(f).length === 0}
						<!-- `recommend` is a PRESET id; these buttons list CONFIGURED rows — a vault with
						     none reads the reason and has nothing to click. Point to the connect flow. -->
						<p class="note">
							{#if f.jurisdiction === 'eu-or-local'}Connect an EU or on-device model in the Providers tab.
							{:else}Connect one in the Providers tab.{/if}
						</p>
					{:else}
						{@const eff = effectiveOf(f)}
						{@const explicitId = taskModels[f.tasks[0]]?.providerId}
						{#each offerable(f) as p (p.id)}
							<!-- ⚠️ D-075 — TWO DIFFERENT QUESTIONS, deliberately answered by two different
							     sources, and collapsing them is the bug this fixes:
							       DISPLAY (`class:on`) — what will ACTUALLY run: the RESOLVER's answer
							         (`effective`), which includes the provider the system auto-selected.
							         This used to read `taskModels[…]?.providerId`, so an auto-selected
							         subscription ran chat + narration while this row showed nothing chosen.
							       WRITE (`onclick`) — still keyed on the EXPLICIT assignment. A click on an
							         AUTO-selected provider must PIN it (an explicit choice the user is now
							         making), not clear a setting that was never written. Keying the toggle on
							         the effective value would send providerId:null → delete → a no-op that
							         leaves the button lit, which reads as a dead control.
							     Displaying the effective selection NEVER writes it: nothing here mutates.
							     ⚠️ AND THEY CAN DISAGREE IN BOTH DIRECTIONS. `resolveEffectiveAssignment` falls
							     through to the active provider when the PINNED row is unresolvable (deleted, or
							     status='pending' — which a vault import plants and `applyTaskModelWrite` does not
							     refuse). Keying the highlight on `eff` alone therefore rendered the user's own pin
							     UNLIT, and since the toggle keys on the pin, clicking it CLEARED the setting
							     silently — the pre-fix bug in mirror image (independent review, MED). So a pin that
							     is not running gets its own visible state ("chosen · not running"): the user can see
							     what they chose, see that it isn't what runs, and un-pin deliberately. -->
							{@const isRunning = effectiveKnown && eff?.providerId === p.id}
							{@const isPinned = explicitId === p.id}
							<!-- FOUR states, because "what did you choose", "what runs", and "do we know what
							     runs" are three different questions:
							       pinned + running        → solid "in use"
							       running, not pinned     → dashed "in use · auto" (the system chose it)
							       pinned, NOT running     → amber "chosen · not running" (a real mismatch)
							       pinned, run UNKNOWN     → solid "chosen" — the choice is a FACT we hold
							                                  locally; only the run-state is unknown, so we
							                                  show the choice and claim nothing about running.
							     The amber fault state is gated on `effectiveKnown` for exactly that reason. -->
							<button
								class="pick" class:on={isRunning || (!effectiveKnown && isPinned)}
								class:auto={isRunning && eff?.source === 'active'} class:pinned={isPinned}
								disabled={busy === f.key}
								title={!effectiveKnown ? (isPinned ? 'Chosen for this job — we could not check what is running right now' : '')
									: isPinned && !isRunning ? 'Chosen for this job, but it cannot run — this job falls back to your active provider'
										: isRunning ? (eff?.source === 'active' ? 'In use — your active provider (nothing pinned for this job)' : 'Chosen for this job')
											: ''}
								onclick={() => assign(f, isPinned ? null : p.id)}
							>{p.label}{#if !effectiveKnown}{#if isPinned}<span class="pick-tag">chosen</span>{/if}{:else if isPinned && !isRunning}<span class="pick-tag">chosen · not running</span>{:else if isRunning}<span class="pick-tag">{eff?.source === 'active' ? 'in use · auto' : 'in use'}</span>{/if}</button>
						{/each}
					{/if}
					<!-- H1: an unknown run-state is STATED, never implied by an absent highlight. -->
					{#if !effectiveKnown && offerable(f).length}
						<p class="note unknown-run">Couldn’t check which model is running right now.</p>
					{/if}
					{#if f.jurisdiction === 'eu-or-local' && exemptKnown}
						<!-- ⚠️ THE COPY MUST MATCH THE CONFIGURATION (dormant now, but kept in step with
						     the router for any future 'eu-or-local' function — independent review ×2). -->
						{#if subscriptionExempt}
							<p class="limit">
								Descriptions analyse your personal themes. They stay in the EU or on your
								device — <strong>except</strong> your Claude subscription, which you’ve
								allowed for sensitive work in “Connect an AI”. Other US models aren’t
								offered here.
							</p>
						{:else}
							<p class="limit">
								Descriptions analyse your personal themes, so they stay in the EU or on your
								device. Models outside that aren’t offered here.
							</p>
						{/if}
					{/if}
				</div>
			{/if}

			{#if f.kind === 'local' && f.recommend}
				<!-- R4-5: the OPTIONAL "search all models" advanced disclosure — hidden for normal
				     users (the curated OnboxTaskSelect above is the default + prominent choice), opt-in
				     for advanced users. Reveals a search over the FULL local catalog (the same
				     recommendations list + curated-first pattern the Providers tab uses), so a power
				     user can approve any local model without leaving the Functions surface. Approving
				     rides the SAME approve() write path as the select — no second consent mechanism. -->
				<!-- ⚠️ The toggle label MUST NOT contain the word "Search": verify:intelligence-screen
				     S5 does sections.find(/Search/) to locate the BUNDLED embedder row, and this local
				     row renders BEFORE it — a "Search…" label here would steal that match and make the
				     Labeling <select> read as a control on the (control-free) Search row. "Show all
				     models" is also the operator's own name for the disclosure e84b8def dropped. -->
				<div class="fn-extra advanced">
					<button class="adv-toggle" type="button" aria-expanded={!!advancedOpen[f.key]}
						onclick={() => (advancedOpen = { ...advancedOpen, [f.key]: !advancedOpen[f.key] })}
					>{advancedOpen[f.key] ? '▾' : '▸'} Show all models</button>
					{#if advancedOpen[f.key]}
						<input class="adv-search" type="text" bind:value={modelQuery}
							placeholder="Search all models…" autocomplete="off" />
						<div class="adv-list">
							{#each catalogMatches as m (m.name)}
								<button class="adv-row" type="button" class:on={approved === m.name}
									disabled={busy === f.key} onclick={() => approve(f, m.name)}>
									<span class="adv-name">{m.name}</span>
									{#if m.recommended}<span class="adv-tag rec">recommended</span>{/if}
									{#if m.installed}<span class="adv-tag ins">installed</span>{/if}
									{#if m.estimatedGb}<span class="adv-size">~{m.estimatedGb}GB</span>{/if}
								</button>
							{:else}
								<p class="note">{modelQuery ? `No models match “${modelQuery}”.` : 'No local models detected yet.'}</p>
							{/each}
						</div>
					{/if}
				</div>
			{/if}

			{#if f.key === 'conversation'}
				<!-- Engine folded into Conversation (2026-07-19): it governs agent turns (chat,
				     harness, reflection) = this function's tasks. Was a standalone Engine tab. -->
				<div class="fn-extra"><EngineSelector /></div>
			{/if}
		</section>
	{/each}

	{#if !functions.length && !err && !loaded}<p class="note">Loading…</p>{/if}
</div>

<style>
	/* Rows are separated by one hairline each — a calm list, not stacked cards. */
	.intel { display: flex; flex-direction: column; }
	.intel.compact { gap: 0; }
	.fn { display: flex; flex-direction: column; padding: 0.05rem 0; }
	.fn + .fn { border-top: 1px solid rgba(255,255,255,0.05); }
	/* The uniform header line: dot · (name + outcome + why) · control. */
	.fn-row { display: flex; align-items: flex-start; gap: 0.6rem; padding: 0.7rem 0.1rem; }
	.dot { flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; margin-top: 0.42rem;
		background: var(--color-border, #555); }
	/* §8.2 — a choice is muted, never red. */
	.dot.ok { background: var(--color-accent-jade, #4ade80); }
	.dot.busy { background: #60a5fa; }
	.dot.choice { background: var(--color-border, #555); }
	.dot.bad { background: var(--color-accent-coral, #f87171); }
	.fn-id { flex: 1; min-width: 0; }
	.fn-title { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
	.fn-title strong { font-size: 0.9rem; font-weight: 500; color: var(--color-text-primary); }
	.sub { color: var(--color-text-tertiary, #888); font-size: 0.78rem; }
	.why { color: var(--color-text-tertiary, #888); font-size: 0.76rem; line-height: 1.4; margin: 0.15rem 0 0; }
	.fn-ctl { flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem; padding-top: 0.1rem; }
	.included { font-size: 0.78rem; color: var(--color-text-tertiary, #888); white-space: nowrap; }
	.fn-extra { margin: 0 0 0.55rem 1.3rem; }
	.note, .limit { color: var(--color-text-tertiary, #888); font-size: 0.76rem; line-height: 1.45; margin: 0.1rem 0 0; }
	.err { color: #f87171; font-size: 0.85em; margin-bottom: 0.5rem; }
	.health { font-size: 0.72rem; text-align: right; }
	.health.no_model, .health.paused, .health.unknown { color: var(--color-text-tertiary, #888); }
	.health.downloading, .health.loading { color: #60a5fa; }
	.health.unavailable, .health.down, .health.error { color: #f87171; }
	.retry-btn { font-size: 0.72rem; padding: 0.1rem 0.5rem; border: 1px solid var(--color-border); border-radius: 6px; background: transparent; color: var(--color-text-secondary); cursor: pointer; }
	.retry-btn:hover { color: var(--color-text-primary); border-color: var(--color-text-tertiary); }
	.retry-btn:disabled { opacity: 0.5; cursor: default; }
	.providers { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
	.pick { font: inherit; font-size: 0.8rem; padding: 0.25rem 0.6rem; border-radius: 7px;
		border: 1px solid var(--color-border, currentColor); background: transparent;
		color: var(--color-text-secondary); cursor: pointer; }
	.pick:hover { border-color: var(--color-text-tertiary); color: var(--color-text-primary); }
	.pick.on { background: var(--color-accent-teal, #14b8a6); border-color: var(--color-accent-teal, #14b8a6); color: #000; }
	/* D-075: AUTO (the active provider, nothing pinned) reads as selected — because it IS what
	   runs — but visibly weaker than a deliberate pick, so "the system chose this" and "I chose
	   this" are not the same picture. Outlined rather than filled; the tag carries the word. */
	.pick.on.auto { background: transparent; color: var(--color-accent-teal, #14b8a6); border-style: dashed; }
	/* PINNED but NOT running — the user's choice cannot serve this job. Amber: it is an
	   actionable mismatch (the pinned provider needs activating, or the pin needs clearing),
	   not a fault and not a working selection. */
	.pick.pinned:not(.on) { border-color: var(--color-accent-amber, #f59e0b); color: var(--color-accent-amber, #f59e0b); border-style: dashed; }
	.pick-tag { margin-left: 0.4rem; font-size: 0.66rem; opacity: 0.85; }
	/* Unknown ≠ broken: muted, like every other honest not-yet-known state on this screen. */
	.unknown-run { opacity: 0.75; }

	/* The optional "search all models" advanced disclosure (R4-5) — a quiet, opt-in door. */
	.advanced { display: flex; flex-direction: column; gap: 0.4rem; }
	.adv-toggle { align-self: flex-start; font: inherit; font-size: 0.72rem; padding: 0.1rem 0; border: none;
		background: none; color: var(--color-text-tertiary, #888); cursor: pointer; }
	.adv-toggle:hover { color: var(--color-text-secondary); }
	.adv-search { width: 100%; max-width: 24rem; padding: 0.35rem 0.55rem; border-radius: 7px; font: inherit;
		font-size: 0.76rem; border: 1px solid var(--color-border, rgba(255,255,255,0.12));
		background: var(--color-surface-2, rgba(255,255,255,0.04)); color: var(--color-text-primary); }
	.adv-search::placeholder { color: var(--color-text-tertiary, #888); }
	.adv-search:focus { outline: none; border-color: var(--color-accent-teal, #14b8a6); }
	.adv-list { display: flex; flex-direction: column; gap: 3px; max-height: 16rem; overflow-y: auto; max-width: 24rem; }
	.adv-row { display: flex; align-items: center; gap: 0.45rem; width: 100%; text-align: left; font: inherit;
		font-size: 0.76rem; padding: 0.35rem 0.5rem; border-radius: 7px; border: 1px solid transparent;
		background: rgba(255,255,255,0.03); color: var(--color-text-secondary); cursor: pointer; }
	.adv-row:hover { border-color: var(--color-border); color: var(--color-text-primary); }
	.adv-row.on { border-color: var(--color-accent-teal, #14b8a6); color: var(--color-text-primary); }
	.adv-row:disabled { opacity: 0.5; cursor: default; }
	.adv-name { font-family: var(--font-mono, monospace); flex-shrink: 0; }
	.adv-tag { font-size: 0.6rem; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
	.adv-tag.rec { background: rgba(229,184,76,0.16); color: var(--color-accent-aurum, #e5b84c); }
	.adv-tag.ins { background: rgba(74,222,128,0.14); color: #6ee7a8; }
	.adv-size { margin-left: auto; font-size: 0.68rem; color: var(--color-text-tertiary, #888); flex-shrink: 0; }
</style>
