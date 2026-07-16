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
	//   'tts'          → its own catalog        (recommend = null — no eval has picked a winner)
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import OnboxTaskSelect from './OnboxTaskSelect.svelte';
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
	type Health = { status: string; message: string | null; model: string | null; progress: { pct: number } | null };

	let { compact = false }: { compact?: boolean } = $props();

	let functions = $state<Fn[]>([]);
	let taskModels = $state<Record<string, { model?: string; providerId?: number }>>({});
	let providers = $state<Provider[]>([]);
	let models = $state<Record<string, Health>>({});
	let installedLocal = $state<string[]>([]);
	let busy = $state<string | null>(null);
	let err = $state<string | null>(null);
	let showAll = $state<Record<string, boolean>>({});
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

	// The model currently approved for a function = its FIRST task's setting. Safe because
	// F6/F6b pin that a function's tasks are kind-homogeneous and Understanding is exactly
	// ONBOX_TASKS — so its two tasks always carry the same model (the route writes them together).
	const approvedOf = (f: Fn) => (f.tasks.length ? (taskModels[f.tasks[0]]?.model || '') : '');

	// Locals the user could pick INSTEAD of the recommendation. The recommendation has its own
	// option inside OnboxTaskSelect, so it is excluded here or it renders twice.
	const localOptions = (f: Fn) => {
		const set = new Set(installedLocal);
		const cur = approvedOf(f);
		if (cur) set.add(cur);
		if (f.recommend) set.delete(f.recommend);
		return [...set];
	};

	// ⚠️ §4g — the ONE place "full flexibility" yields, and it must not be cosmetic.
	// `narrate` is §4g-sensitive (src/inference/sensitivity.js), so the router REFUSES a US
	// provider for it and falls back to EU/on-device. Offering a US model here would be a
	// silent lie: the user picks it, and something else runs. So an eu-or-local function is
	// offered ONLY eu-zdr/local providers, with the reason stated.
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
		const [tm, pv, rd, ex] = await Promise.all([
			api('/portal/providers/task-models').then((r) => r.json()).catch(() => ({})),
			api('/portal/providers').then((r) => r.json()).catch(() => ({})),
			api('/portal/readiness?slices=models').then((r) => r.json()).catch(() => ({})),
			api('/portal/providers/sensitive-subscription').then((r) => r.json()).catch(() => ({})),
		]);
		taskModels = tm.taskModels || {};
		providers = pv.providers || [];
		models = rd.models || {};
		// SEED: if the user flipped the toggle while these four calls were in flight, their
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
			if (r.ok) taskModels = (await r.json()).taskModels || {};
			else err = 'That model could not be saved.';
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
			if (r.ok) taskModels = (await r.json()).taskModels || {};
			else err = 'That model could not be saved.';
		} catch { err = 'That model could not be saved.'; }
		finally { busy = null; }
	}

	onMount(load);
</script>

<div class="intel" class:compact>
	{#if err}<p class="err">{err}</p>{/if}

	{#each functions as f (f.key)}
		{@const health = healthFor(f)}
		{@const approved = approvedOf(f)}
		<section class="fn">
			<header>
				<div class="title">
					<strong>{f.label}</strong>
					<span class="sub">{f.sub}</span>
				</div>
				{#if health}
					<!-- Honest states, not a spinner. `no_model` and `paused` are CHOICES the user
					     made (§3.5) — they render as status, never as an error. -->
					<span class="health {health.status}">
						{#if health.status === 'downloading' && health.progress}
							Downloading… {health.progress.pct}%
						{:else}{health.message || health.status}{/if}
					</span>
				{/if}
			</header>

			<!-- Recommendation-FIRST, with the reason (§3.11c). Not a 302-model dump: the
			     recommendation carries WHY it is the recommendation, and everything else lives
			     behind a disclosure. -->
			<p class="why">{f.why}</p>

			{#if f.kind === 'bundled'}
				<!-- ⚠️ NOT a choice, and it must never be dressed as one (§3.10d-c). The embedder
				     ships INSIDE the app: it cannot be declined, cannot be downloaded, has no
				     rail. A card with a pre-ticked box would present a non-choice as consent —
				     the same dishonesty §3.10 exists to remove. F8 pins that it owns no task, so
				     it is structurally unapprovable, not merely un-drawn. -->
				<p class="included">Included · {f.recommend} — runs on your device</p>

			{:else if f.kind === 'local' && f.recommend}
				<OnboxTaskSelect
					value={approved}
					recModel={f.recommend}
					options={localOptions(f)}
					disabled={busy === f.key}
					onpick={(m) => approve(f, m)}
				/>
				{#if f.tasks.length > 1}
					<!-- Say it plainly: one approval covers both tasks. The user should not have to
					     infer that labels and entities travel together. -->
					<p class="note">One choice covers labels and entities.</p>
				{/if}

			{:else if f.kind === 'whisper' || f.kind === 'tts'}
				<!-- These have their OWN rails (whisper's download route + catalog; the TTS
				     catalog). §3.10d: no third catalog — compose what exists rather than
				     re-implement it here. -->
				<p class="note">Set up under {f.kind === 'whisper' ? 'Transcription' : 'Voice'} below.</p>

			{:else}
				<div class="providers">
					{#if f.jurisdiction === 'eu-or-local' && !exemptKnown && offerable(f).length === 0}
						<!-- ⚠️ SUPPRESS ONLY THE FALSE THING — not the whole row.
						     A filtered list is NOT an assertion about §4g: while the flag is unknown
						     the list is exactly {eu-zdr, local}, and the router allows EVERY one of
						     those for narrate REGARDLESS of the exemption (its rule refuses only
						     us-* AND not-exempt). The exemption only ever ADDS the subscription; it
						     never removes an EU/local provider. So showing that list is a sound
						     UNDER-approximation — fail-closed, and useful.
						     The ONE false thing is the dead-end below: "Connect an EU or on-device
						     model" is a lie to an exempt vault whose subscription would qualify. So
						     that — and only that — is what an unverified flag suppresses.
						     An earlier version removed the entire list and pinned that into the gate.
						     It cost real capability (a 503 froze this row forever: no buttons, no
						     assignment shown, no retry) and the "Checking…" spinner asserted work in
						     flight when nothing was — this component's own §3.5 rule is "honest
						     states, not a spinner". Trading a false claim for a dead row is not a
						     fix (independent review ×6, 2026-07-16). -->
						<p class="limit">
							Descriptions analyse your personal themes. Checking where they’re allowed to run…
						</p>
					{:else if offerable(f).length === 0}
						<!-- ⚠️ `recommend` here is a PRESET id (e.g. 'claude_subscription'), while these
						     buttons list CONFIGURED provider rows — so a vault with none can read the
						     reason and have nothing to click. Recommendation-FIRST only half-holds for
						     cloud functions until the CONNECT flow lives here too, which is E/E2's job
						     (it owns the #133 ladder). Say where to go rather than dead-end them
						     (independent review, 2026-07-16). -->
						<p class="note">
							{#if f.jurisdiction === 'eu-or-local'}Connect an EU or on-device model under “Connect an AI” below.
							{:else}Connect one under “Connect an AI” below.{/if}
						</p>
					{:else}
						{#each offerable(f) as p (p.id)}
							<button
								class="pick" class:on={taskModels[f.tasks[0]]?.providerId === p.id}
								disabled={busy === f.key}
								onclick={() => assign(f, taskModels[f.tasks[0]]?.providerId === p.id ? null : p.id)}
							>{p.label}</button>
						{/each}
					{/if}
					{#if f.jurisdiction === 'eu-or-local' && exemptKnown}
						<!-- State the limit AND its reason. §3.11d: offering a choice the system will
						     override is worse than not offering it — but hiding options with no
						     explanation is its own dishonesty. -->
						<!-- ⚠️ THE COPY MUST MATCH THE CONFIGURATION, not the default. Claiming
						     "stays in the EU or on your device" while the subscription exemption is
						     ON is a FALSE PRIVACY STATEMENT — the router really does send narrate to
						     the US then (independent review ×2, 2026-07-16). -->
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

			{#if f.kind !== 'bundled' && f.kind !== 'whisper' && f.kind !== 'tts'}
				<button class="disclose" onclick={() => (showAll[f.key] = !showAll[f.key])}>
					{showAll[f.key] ? 'Hide other models' : 'Show all models →'}
				</button>
				{#if showAll[f.key]}
					<!-- The disclosure, not the front door (§3.11c). QA item 11's "raw dump" becomes
					     a thing you opt into, so recommended stays a DEFAULT rather than a CAGE. -->
					<p class="note">
						{#if f.kind === 'local'}Any installed local model can be chosen above.
						{:else}Connect another provider under “Connect an AI”.{/if}
					</p>
				{/if}
			{/if}
		</section>
	{/each}

	{#if !functions.length && !err && !loaded}<p class="note">Loading…</p>{/if}
</div>

<style>
	.intel { display: flex; flex-direction: column; gap: 1.25rem; }
	.intel.compact { gap: 0.75rem; }
	.fn { display: flex; flex-direction: column; gap: 0.4rem; }
	header { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; }
	.title { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
	.sub { color: var(--color-text-muted, #888); font-size: 0.85em; }
	.why { color: var(--color-text-muted, #888); font-size: 0.85em; margin: 0; }
	.note, .limit { color: var(--color-text-muted, #888); font-size: 0.8em; margin: 0.15rem 0 0; }
	.included { font-size: 0.9em; margin: 0; }
	.err { color: #f87171; font-size: 0.85em; }
	.health { font-size: 0.75em; padding: 0.1rem 0.4rem; border-radius: 999px; background: var(--color-surface-2, #2222); }
	/* A CHOICE is not a fault: no_model/paused must not read as red. */
	.health.ok { color: #4ade80; }
	.health.no_model, .health.paused, .health.unknown { color: var(--color-text-muted, #888); }
	.health.downloading, .health.loading { color: #60a5fa; }
	.health.unavailable, .health.down, .health.error { color: #f87171; }
	.providers { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }
	.pick { font: inherit; font-size: 0.85em; padding: 0.2rem 0.5rem; border-radius: 6px;
		border: 1px solid var(--color-border, currentColor); background: transparent; cursor: pointer; }
	.pick.on { background: var(--color-accent-teal, #14b8a6); color: #000; }
	.disclose { align-self: flex-start; font: inherit; font-size: 0.8em; background: none;
		border: none; padding: 0; color: var(--color-accent-teal, #14b8a6); cursor: pointer; }
</style>
