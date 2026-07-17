<script lang="ts">
	// OnboardingFlow — the single, linear onboarding controller (v2).
	//
	// Collapses the three overlapping legacy surfaces (WelcomeModal 4-step +
	// OnboardingGuide checklist + the empty-mindscape ConnectionsChecklist) into
	// ONE state machine over the real backend:
	//   /portal/onboarding/status   → seen? dismissed? messageCount
	//   /portal/import/preview      → the "See your mind" evidence card
	//   /portal/providers           → AI connected? (auto-activated on add)
	//   /portal/hardware/recommend  → Ollama up + installed models (one-tap local)
	//   /mindscape                  → generated? (node count) → end the flow
	//
	// Account custody (Create/Unlock/Restore — design Step 1) happens at the
	// /setup + /unlock ROUTES before the app shell mounts, so this in-app flow
	// owns Steps 2–5: Welcome → Import → Connect AI → Generate.
	//
	// Honors onboarding_dismissed_at: once dismissed, never shows again.
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { guidanceRestoredSignal } from '$lib/stores/onboarding-guidance.svelte';
	import { api } from '$lib/api';
	import { navigationState } from '$lib/stores/navigation';
	import MyceliumCanvas from './MyceliumCanvas.svelte';

	type StepKey = 'connect-ai' | 'messenger';   // §3.7a: 'import'/'generate' are the INVITE's, pre-generation

	let loading = $state(true);
	let dismissed = $state(false);
	let welcomeSeen = $state(false);
	let messageCount = $state(0);
	let embedded = $state(0);
	let pending = $state(0);
	let hasProvider = $state(false);
	let activeProviderLabel = $state<string | null>(null);
	let ollamaUp = $state(false);
	let ollamaModels = $state<string[]>([]);
	let generated = $state(false);
	let channelConnected = $state(false);

	// "See your mind" preview (filled once anything is imported)

	// Generate (the magic moment)
	// The reveal banner is for the moment generation COMPLETES this session — not a
	// permanent fixture. Existing users (generated already true at mount) never see it.
	let probedOllama = $state(false);

	// Agent identity (spec #4) — name + personality, set here in onboarding and
	// changeable later in Settings → Intelligence. Saved on "Let's grow".
	let agentName = $state('');
	let agentPersonality = $state('friendly');
	const PERSONALITY_OPTS = [
		{ id: 'friendly', label: 'Friendly' },
		{ id: 'formal', label: 'Formal' },
		{ id: 'concise', label: 'Concise' },
		{ id: 'creative', label: 'Creative' },
	];
	async function saveAgentIdentity() {
		if (!agentName.trim() && agentPersonality === 'friendly') return; // nothing chosen
		try {
			await api('/portal/agent-identity', { method: 'PUT', body: JSON.stringify({ name: agentName.trim(), personality: agentPersonality }) });
		} catch { /* best-effort — they can set it in Settings */ }
	}

	// Handle — claim your public name (optional; set here or later in Settings →
	// Profile). DNS-safe rule mirrors identity.js for the live availability hint; the
	// server is the authority on save. Only a confirmed-free, valid handle is saved.
	let handleInput = $state('');
	let handleState = $state<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
	let handleTimer: ReturnType<typeof setTimeout> | null = null;
	const HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
	function onHandleInput() {
		handleState = 'idle';
		if (handleTimer) clearTimeout(handleTimer);
		const h = handleInput.trim().toLowerCase();
		if (!h) return;
		if (!HANDLE_RE.test(h)) { handleState = 'invalid'; return; }
		handleState = 'checking';
		handleTimer = setTimeout(async () => {
			const d = await getJSON(`/portal/profile/handle/check?handle=${encodeURIComponent(h)}`);
			handleState = d ? (d.available ? 'available' : 'taken') : 'idle';
		}, 400);
	}
	async function saveHandleIfAny() {
		const h = handleInput.trim().toLowerCase();
		if (!h || handleState !== 'available') return;
		try { await api('/portal/profile', { method: 'PUT', body: JSON.stringify({ handle: h }) }); }
		catch { /* best-effort — set it later in Profile */ }
	}

	// Decide synchronously from a localStorage hint so the opaque Welcome backdrop
	// is painted on the FIRST frame (no flash of the app behind it). The async
	// /status check below corrects this for the rare edge cases. Returning users
	// (hint set) never see a flicker.
	const WELCOME_SEEN_KEY = 'myc-welcome-seen';
	let welcomeOpen = $state(browser ? !localStorage.getItem(WELCOME_SEEN_KEY) : false);
	function markWelcomeSeen() {
		welcomeSeen = true;
		welcomeOpen = false;
		try { localStorage.setItem(WELCOME_SEEN_KEY, '1'); } catch { /* private mode */ }
		api('/portal/onboarding/welcome-seen', { method: 'POST' }).catch(() => {});
	}

	// The welcome modal must always be escapable (spec #2): ESC, a click on the
	// backdrop outside the card, and an explicit × all dismiss it — same as "Later".
	function onWelcomeKeydown(e: KeyboardEvent) {
		if (welcomeOpen && e.key === 'Escape') {
			e.preventDefault();
			markWelcomeSeen();
		}
	}
	function onBackdropClick(e: MouseEvent) {
		// Only a click on the backdrop itself (not the card) closes — never swallow
		// clicks on the welcome content.
		if (!(e.target as HTMLElement)?.closest('.welcome')) markWelcomeSeen();
	}
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	// ── The un-dismiss signal (§3.7b) ────────────────────────────────────────────
	// ⚠️ The poll below CANNOT do this job: `else if (railVisible) refresh()` and
	// `railVisible` requires `!dismissed`, so once dismissed the only re-read of `dismissed`
	// never runs again. Restoring guidance wrote the DB and changed nothing on screen until
	// the app restarted (independent review HIGH-1). This component is in the PERSISTENT
	// layout — navigation cannot remount it — so it must be TOLD.
	// Guarded on a real change: an $effect reading the signal must not refresh on mount.
	let lastSignal = $state(guidanceRestoredSignal());
	$effect(() => {
		const s = guidanceRestoredSignal();
		if (s !== lastSignal) { lastSignal = s; void refresh(); }
	});

	// The first incomplete step drives the rail's emphasis + auto-advance.
	// ⚠️ 'generate' is GONE from this rail: the rail now only shows AFTER generation, so a
	// Generate step here would be unreachable UI — dead code shown to users. Generate moved to
	// the invite (§3.7), which is also where `generate.ts` lives; the rail's own startGenerate
	// was a hand-rolled copy with NO 409 branch (map §5.2a), so deleting it retires the
	// duplicate rather than relocating it.
	const activeStep = $derived<StepKey>(!hasProvider ? 'connect-ai' : 'messenger');
	// ── §3.7a — the rail is the NUDGE, and it lives AFTER generation ─────────────
	// ⚠️ THIS INVERTS THE RAIL. It used to show on `!generated && messageCount > 0` — i.e.
	// BEFORE the map exists — to nudge Connect-AI → Generate. But the invite owns everything
	// pre-generation (Generate moved there: it is a pre-generation act), and the rail's job is
	// "you're not finished": the AI or the messenger is still missing.
	//
	// The point is not tidiness. Today the invite hides on `points.length === 0` and the rail on
	// `!generated` — TWO DIFFERENT MEASUREMENTS of the same idea, both true through the middle of
	// onboarding ⇒ BOTH ON SCREEN AT ONCE (map §5.1). Now both pivot on ONE fact with OPPOSITE
	// polarity:
	//     invite:  !readiness.mindscape.generated
	//     rail:     readiness.mindscape.generated && (!ai.connected || !channel.connected)
	// `generated` is true xor false ⇒ they CANNOT render together. Not by careful coordination —
	// by construction. That is a stronger guarantee than deleting one of them.
	const railVisible = $derived(
		!loading && !dismissed && welcomeSeen
		&& generated                                    // ⚠️ was !generated — the inversion
		&& (!hasProvider || !channelConnected),         // "not finished" — the only thing it says now
	);

	async function getJSON(path: string): Promise<any | null> {
		try {
			const res = await api(path);
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	}

	// ── ONE fact, ONE call (§3.2 / §3.7a) ────────────────────────────────────────
	// Was THREE fetches every 4s: /onboarding/status + /portal/providers + /portal/mindscape.
	//
	// ⚠️ AND ONE OF THEM FULL-SCANNED THE VAULT. /onboarding/status's first line is
	// `await embedCounts()` = `db.messages.embedBacklog()` — the PURE multi-second SQLCipher
	// decrypt. The rail polls @4s and `railVisible` requires messageCount > 0, so it ran that
	// scan every 4 seconds EXACTLY WHEN THE TABLE IS BIG. embedCounts justifies its purity with
	// "these compat endpoints are not the hot pollers" and "by the time the table is large
	// onboarding is long done" — both false of the rail, which IS onboarding and only polls once
	// data exists. That is PIVOT 2's sin ("/import/preview must never be polled — it already hung
	// the app at boot once") on a different route. readiness.data rides embedBacklogCached, so
	// delegating fixes it as a consequence, not as a separate patch.
	//
	// ⚠️ AND /portal/mindscape returns full NODES to answer a boolean. readiness.mindscape is a
	// cheap COUNT — the ONE definition of "generated" that §3.2 exists to serve, and that neither
	// this rail nor the invite read (map §5.1: three answers ⇒ both surfaces on screen at once).
	const SLICES = 'data,ai,channel,mindscape,onboarding';
	async function refresh() {
		const r = await getJSON(`/portal/readiness?slices=${SLICES}`);

		if (r) {
			dismissed = !!r.onboarding?.dismissed;
			// ⚠️ EXACT, not approximate. The rail's welcomeSeen was `!status.showWelcome`, and
			// showWelcome is `!seen && total === 0` (portal-compat.js:1159) ⇒ welcomeSeen is
			// `welcome_shown_at || total > 0`. readiness.onboarding.welcomeSeen is ONLY
			// `Boolean(welcome_shown_at)` — swapping it naively RESURFACES the welcome backdrop on
			// a populated vault whose welcome was never stamped. Reconstruct the real predicate.
			welcomeSeen = !!r.onboarding?.welcomeSeen || Number(r.data?.total ?? 0) > 0;
			// Correct the first-frame localStorage guess (line ~64): if the BACKEND
			// already knows the welcome was seen/dismissed, close the backdrop even
			// when client localStorage is empty — e.g. a populated vault loaded on a
			// fresh dev-server origin (new vite port) where localStorage resets.
			// Without this the welcome wrongly re-shows over an existing vault.
			if (welcomeSeen || dismissed) welcomeOpen = false;
			messageCount = Number(r.data?.total ?? 0);
			embedded = Number(r.data?.embedded ?? 0);
			pending = Number(r.data?.pending ?? 0);
			// ⚠️ `ai.connected` means an ACTIVE PROVIDER ROW exists. This used to be
			// `providers.length > 0` — so an ALL-INACTIVE list read as "connected", which is
			// §2.8 #6, the exact bug readiness was built to end and that R4b gates. The rail
			// never migrated; it has been running the old bug this whole time.
			hasProvider = r.ai?.connected === true;
			activeProviderLabel = r.ai?.activeProvider ?? null;
			channelConnected = r.channel?.connected === true;   // §3.7a's gate needs it; the rail had NO channel awareness
			// ⚠️ `unknown` is NOT `false`. readiness.mindscape's catch used to return
			// {generated:false} with no flag while the route still 200'd — so a transient
			// getNoiseStats hiccup (WAL/lock contention: this repo's most-documented failure class)
			// read as "no map", railVisible went false, and the poll above could never recover it.
			// A load failure is not an empty vault (§3.2a) — hold the last known answer.
			if (r.mindscape?.unknown !== true) generated = r.mindscape?.generated === true;
		}

		// Lazy-load the heavier probes only when their step is near.
		// ⚠️ loadPreview() DELETED. `preview` was written and rendered NOWHERE — its only reader,
		// `.see-card`, left with the Import step (which is the invite's now). It fetched
		// /portal/import/preview = the PURE embedBacklog scan PLUS three unindexed aggregates, and
		// that route fails CLOSED (500) on evidence.unknown, so `preview` stayed null and it re-fired
		// every 4s. HIGH-3's deadlock used to mask it (the poll barely ran); un-gating the poll
		// PROMOTED a dead fetch to a hot pure-scan loop — my fix made someone else's latent bug live,
		// which is why it stopped being separable (independent review MED-8, 2026-07-16).
		if (messageCount > 0 && !hasProvider && !probedOllama) probeOllama();

		loading = false;
	}


	async function probeOllama() {
		probedOllama = true;
		const h = await getJSON('/portal/hardware/recommend');
		if (!h) return;
		ollamaUp = !!h.ollamaUp;
		ollamaModels = Array.isArray(h.recommendations)
			? h.recommendations.filter((m: any) => m.installed).map((m: any) => m.name)
			: [];
	}

	// ── Welcome (Step 2): one breath, then into the flow ───────────────────────
	function beginFlow() {
		saveAgentIdentity(); // persist the chosen name/personality (best-effort)
		saveHandleIfAny();   // claim the handle if one was entered + confirmed free
		markWelcomeSeen();
		// Land on the mindscape — the empty-state invitation (Data · Intelligence ·
		// Connect) is the first thing they should see, not an abrupt jump elsewhere.
		navigationState.setPrimaryView('mindscape');
		goto('/mindscape');
	}

	function goImport() {
		goto('/import');
	}

	function goConnectAI() {
		navigationState.setPrimaryView('settings');
		goto('/settings?tab=intelligence');
	}

	function goChannels() {
		navigationState.setPrimaryView('settings');
		goto('/settings?tab=channels');
	}

	// One-tap: add the local Ollama provider and auto-activate (backend sets the
	// first provider active). Model stays visible — never a silent fallback.
	let connectingLocal = $state(false);
	let connectError = $state('');
	async function useLocalAI() {
		const model = ollamaModels[0];
		if (!model) {
			goConnectAI();
			return;
		}
		connectingLocal = true;
		connectError = '';
		try {
			const res = await api('/portal/providers', {
				method: 'POST',
				body: JSON.stringify({ provider: 'custom', label: `Local · ${model}`, base_url: 'http://127.0.0.1:11434/v1', model_preference: model }),
			});
			const d = await res.json().catch(() => ({}));
			if (!res.ok || !d.ok) {
				connectError = 'Could not connect local AI — open AI settings to finish.';
			} else {
				hasProvider = true;
				activeProviderLabel = `Local · ${model}`;
			}
		} catch {
			connectError = 'Could not connect local AI — open AI settings to finish.';
		} finally {
			connectingLocal = false;
		}
	}

	// One-tap: connect the user's Claude Pro/Max subscription (imports their existing
	// Claude Code login — never mints a token). The import is fail-closed: it requires
	// acknowledgeToS:true (automated use of a subscription may violate Anthropic's ToS),
	// so we surface a one-line acknowledgment before connecting. Same flow as
	// Settings → Intelligence → "Your Claude subscription".
	let subOpen = $state(false);
	let subAck = $state(false);
	let subConnecting = $state(false);
	let subError = $state('');
	async function connectSub() {
		if (!subAck) return;
		subConnecting = true;
		subError = '';
		try {
			const res = await api('/portal/auth/claude/import', { method: 'POST', body: JSON.stringify({ acknowledgeToS: true }) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok || !d.ok) {
				subError = d.error || 'Could not connect — make sure you are logged in to Claude Code, or add a key in AI settings.';
			} else {
				hasProvider = true;
				activeProviderLabel = 'Claude Pro/Max';
				subOpen = false;
			}
		} catch {
			subError = 'Could not connect — open AI settings to finish.';
		} finally {
			subConnecting = false;
		}
	}

	// ── Generate (Step 5): trigger + poll, gated reveal ────────────────────────

	// generate() + pollGenerate() DELETED (§3.7a). They were the rail's hand-rolled Generate —
	// a duplicate of generate.ts with NO 409 branch (map §5.2a), so clicking before embedding
	// finished surfaced a raw error where generate.ts shows "processing N/M" and auto-starts.
	// The rail now only appears AFTER generation, so this was unreachable UI as well as a
	// duplicate. Generate lives in the invite, on the shared lifecycle.

	async function dismiss() {
		dismissed = true;
		try {
			await api('/portal/onboarding/dismiss', { method: 'POST' });
		} catch {
			/* best-effort */
		}
	}

	onMount(async () => {
		if (!browser) return;
		await refresh();
		// Reconcile the optimistic (localStorage) decision with the server truth:
		// open only for a genuinely fresh, unseen, undismissed vault; otherwise close.
		welcomeOpen = !welcomeSeen && !dismissed;
		if (welcomeSeen) { try { localStorage.setItem(WELCOME_SEEN_KEY, '1'); } catch { /* */ } }
		// Light polling keeps the rail honest as embedding/generation progress.
		pollTimer = setInterval(() => {
			// ⚠️ NEVER GATE THE POLL ON A FACT THE POLL MUST LEARN. This read `if (railVisible)`,
			// and railVisible now requires `generated` — so the ONLY code that can notice
			// `generated` flipped false→true was gated on it already being true. Result: import →
			// generate → the map appears → the invite vanishes → NO RAIL, for the life of the page.
			// The rail was unreachable in the exact session it exists for, and only a reload
			// surfaced it (OnboardingFlow lives in the persistent layout).
			// This is map §5.1a VERBATIM with `generated` substituted for `messageCount` — a
			// documented deadlock I recreated while inverting the gate. On main the gate was
			// `!generated`: true at mount, so the deadlock was benign. Making it POSITIVE turned
			// "appears late" into "never appears". It is also the same shape as E3's dismissed bug,
			// named in my own comment ~230 lines up ("the one path that can clear the flag is gated
			// on the flag") — third instance (independent review HIGH-3, 2026-07-16).
			// ⇒ Poll on what does NOT move: onboarding is live and not dismissed. One CACHED
			// readiness call (§3.2b), so polling while hidden costs a cache read, not a scan.
			if (!dismissed && welcomeSeen) refresh();
		}, 4000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});
</script>

<svelte:window onkeydown={onWelcomeKeydown} />

{#if welcomeOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="onb-welcome-title" tabindex="-1" onclick={onBackdropClick}>
		<!-- The hero mycelium animation grows across the whole backdrop, behind the glass. -->
		<MyceliumCanvas />
		<div class="welcome">
			<button class="welcome-close" aria-label="Close" onclick={markWelcomeSeen}>
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					<line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>
			<div class="welcome-body">
				<div class="eyebrow">Welcome</div>
				<h1 id="onb-welcome-title" class="title">See your mind take shape</h1>
				<p class="lede">
					Mycelium turns your conversations into a living map of your mind. Private,
					encrypted, on your device.
				</p>
				<ol class="preview-steps">
					<li><span class="n">1</span> Bring your world in</li>
					<li><span class="n">2</span> Connect an AI</li>
					<li><span class="n">3</span> Watch your mind take shape</li>
				</ol>
				<div class="name-field">
					<input class="name-input" type="text" maxlength="40" bind:value={agentName} placeholder="Name your assistant (e.g. Aria)" aria-label="Assistant name" />
					<select class="persona-select" bind:value={agentPersonality} aria-label="Personality">
						{#each PERSONALITY_OPTS as o}<option value={o.id}>{o.label}</option>{/each}
					</select>
				</div>
				<div class="name-field">
					<input class="name-input" type="text" maxlength="32" bind:value={handleInput} oninput={onHandleInput}
						placeholder="@ claim your handle (optional)" aria-label="Handle"
						autocomplete="off" autocapitalize="off" spellcheck="false" />
					{#if handleState !== 'idle'}
						<span class="handle-hint {handleState === 'available' ? 'ok' : handleState === 'checking' ? '' : 'bad'}">
							{handleState === 'checking' ? 'checking…' : handleState === 'available' ? 'available ✓' : handleState === 'taken' ? 'taken' : 'a–z, 0–9, dashes'}
						</span>
					{/if}
				</div>
				<div class="welcome-actions">
					<button class="btn-skip" onclick={markWelcomeSeen}>
						Later
					</button>
					<button class="btn-primary" onclick={beginFlow}>
						Let's grow your mycelium
						<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
							<line x1="5" y1="12" x2="19" y2="12" />
							<polyline points="12 5 19 12 12 19" />
						</svg>
					</button>
				</div>
			</div>
		</div>
	</div>
{/if}

{#if railVisible}
	<div class="rail" role="region" aria-label="Onboarding">
		<div class="rail-head">
			<span class="rail-title">Grow your mycelium</span>
			<button class="rail-x" aria-label="Dismiss onboarding" onclick={dismiss}>×</button>
		</div>

		<!-- Step: Connect AI -->
		<div class="step" class:active={activeStep === 'connect-ai'} class:done={hasProvider}>
			<div class="step-head">
				<span class="check">{hasProvider ? '✓' : '1'}</span>
				<span class="step-name">Connect an AI</span>
			</div>
			{#if hasProvider}
				<p class="step-hint">Using <strong>{activeProviderLabel}</strong></p>
			{:else if activeStep === 'connect-ai'}
				{#if ollamaUp && ollamaModels.length}
					<p class="step-hint">Local AI detected · runs on your device.</p>
					<button class="btn-primary sm" disabled={connectingLocal} onclick={useLocalAI}>
						{connectingLocal ? 'Connecting…' : `Use local AI · ${ollamaModels[0]}`}
					</button>
				{:else}
					<p class="step-hint">Choose your intelligence — subscription, local, or a cloud key.</p>
				{/if}

				<!-- Claude subscription — use your existing Claude login, no key to paste. -->
				{#if !subOpen}
					<button class="btn-primary sm sub-connect" onclick={() => { subOpen = true; subError = ''; }}>✦ Use your Claude subscription</button>
				{:else}
					<label class="sub-ack">
						<input type="checkbox" bind:checked={subAck} />
						<span>Use my existing Claude login. Automated use of a Pro/Max plan may be subject to Anthropic’s Terms.</span>
					</label>
					<button class="btn-primary sm" disabled={!subAck || subConnecting} onclick={connectSub}>
						{subConnecting ? 'Connecting…' : 'Connect'}
					</button>
				{/if}
				{#if subError}<p class="step-err">{subError}</p>{/if}

				<button class="btn-skip" onclick={goConnectAI}>More options →</button>
				{#if connectError}<p class="step-err">{connectError}</p>{/if}
			{/if}
		</div>

		<!-- ⚠️ THE STEP THAT ALMOST DIDN'T SHIP. I added the 'messenger' StepKey, `channelConnected`,
		     the gate term AND the X1 row — and no markup. So at (generated, ai, !channel) the rail
		     rendered as a titled panel with ONE ticked step and no action but ×: it could not say
		     what was missing (independent review HIGH-1, 2026-07-16). And X1 asserted only
		     `railRendered === true`, which a bare <div> satisfies — so my own gate BLESSED the
		     empty rail.
		     This is the case the whole design pivots on. §3.7's v3 pivot kept the rail precisely
		     because "deleting it would leave a user who generated early with no surface at all
		     telling them their AI or channel was never connected", and §0 row 8: "the rail is what
		     carries [messenger] past generation." Without this step the rail carries nothing. -->
		<div class="step" class:active={activeStep === 'messenger'} class:done={channelConnected}>
			<div class="step-head">
				<span class="check">{channelConnected ? '✓' : '2'}</span>
				<span class="step-name">Link a messenger</span>
			</div>
			{#if channelConnected}
				<p class="step-hint">Connected — talk to your mind from Telegram or Discord.</p>
			{:else if activeStep === 'messenger'}
				<p class="step-hint">Optional — talk to your mind from Telegram or Discord.</p>
				<button class="btn-primary sm" onclick={goChannels}>Link a messenger →</button>
			{/if}
		</div>

	</div>
{/if}

<!-- The "Your mycelium is ready" reveal MOVED to MindscapeView (§3.7a). It was gated on
     `justGenerated`, written ONLY by the rail's pollGenerate() — which this increment deletes,
     since Generate is a pre-generation act and belongs to the invite. Leaving the block here
     would be dead code: the rail requires `generated`, so it can never watch the false→true
     flip. MindscapeView already reacts to `phase === 'done'` and genuinely sees the moment. -->

<style>
	/* ── Welcome modal ─────────────────────────────────────────────────────── */
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: var(--color-bg); /* the mycelium canvas fills this; card floats over it */
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
		animation: fadeIn 0.35s ease-out;
	}
	.welcome {
		position: relative;
		z-index: 1;
		max-width: 480px;
		width: 100%;
		/* Glass — the living mycelium breathes through the panel + around its edges. */
		background: var(--glass-panel-bg);
		backdrop-filter: blur(22px) saturate(140%);
		-webkit-backdrop-filter: blur(22px) saturate(140%);
		border: 1px solid var(--glass-border);
		border-radius: 16px;
		overflow: hidden;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(229, 184, 76, 0.06);
		animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.welcome-body {
		padding: 1.5rem 2.25rem 1.75rem;
	}
	.welcome-close {
		position: absolute;
		top: 0.75rem;
		right: 0.75rem;
		z-index: 2;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		height: 1.9rem;
		border: none;
		border-radius: 8px;
		background: transparent;
		color: var(--color-text-secondary, #9898a3);
		cursor: pointer;
		transition: background 0.15s ease, color 0.15s ease;
	}
	.welcome-close:hover {
		background: var(--color-elevated, rgba(255, 255, 255, 0.06));
		color: var(--color-text-primary);
	}
	.eyebrow {
		font-family: var(--font-mono, 'JetBrains Mono', monospace);
		font-size: 0.62rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-accent-aurum);
		margin-bottom: 0.6rem;
	}
	.title {
		font-family: var(--font-serif, 'Geist', system-ui, sans-serif);
		font-size: 1.6rem;
		font-weight: 400;
		line-height: 1.15;
		letter-spacing: -0.015em;
		color: var(--color-text-primary);
		margin: 0 0 0.85rem;
	}
	.lede {
		font-size: 0.92rem;
		line-height: 1.6;
		color: var(--color-text-secondary, #9898a3);
		margin: 0 0 1.1rem;
	}
	.preview-steps {
		list-style: none;
		margin: 0 0 1.5rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.55rem;
	}
	.preview-steps li {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		font-size: 0.88rem;
		color: var(--color-text-primary);
	}
	.preview-steps .n {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.4rem;
		height: 1.4rem;
		border-radius: 50%;
		font-size: 0.72rem;
		font-family: var(--font-mono, monospace);
		background: rgba(229, 184, 76, 0.14);
		color: var(--color-accent-aurum);
	}
	.welcome-actions {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.name-field {
		display: flex;
		gap: 0.5rem;
		margin: 0 0 1.25rem;
	}
	.name-input {
		flex: 1;
		min-width: 0;
		padding: 0.55rem 0.7rem;
		font-size: 0.85rem;
		font-family: inherit;
		color: var(--color-text-primary);
		background: var(--glass-input-bg, rgba(0, 0, 0, 0.25));
		border: 1px solid var(--glass-input-border, rgba(255, 255, 255, 0.12));
		border-radius: 9px;
		outline: none;
	}
	.name-input:focus { border-color: var(--color-accent-aurum, #e5b84c); }
	.name-input::placeholder { color: var(--color-text-tertiary, #9898a3); }
	.handle-hint { align-self: center; font-size: 0.72rem; white-space: nowrap; color: var(--color-text-tertiary, #9898a3); }
	.handle-hint.ok { color: var(--color-accent-aurum, #e5b84c); }
	.handle-hint.bad { color: var(--color-coral, #e5736b); }
	.persona-select {
		flex-shrink: 0;
		padding: 0.55rem 0.6rem;
		font-size: 0.82rem;
		font-family: inherit;
		color: var(--color-text-primary);
		background: var(--glass-input-bg, rgba(0, 0, 0, 0.25));
		border: 1px solid var(--glass-input-border, rgba(255, 255, 255, 0.12));
		border-radius: 9px;
		outline: none;
	}
	.persona-select:focus { border-color: var(--color-accent-aurum, #e5b84c); }

	/* ── Guide rail ────────────────────────────────────────────────────────── */
	.rail {
		position: fixed;
		right: 1.25rem;
		bottom: 1.25rem;
		z-index: 900;
		width: 320px;
		max-width: calc(100vw - 2rem);
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 14px;
		padding: 0.9rem 1rem 1rem;
		box-shadow: 0 16px 44px rgba(0, 0, 0, 0.42);
		animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.rail-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 0.6rem;
	}
	.rail-title {
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--color-text-primary);
	}
	.rail-x {
		background: none;
		border: none;
		color: var(--color-text-secondary, #9898a3);
		font-size: 1.1rem;
		line-height: 1;
		cursor: pointer;
		padding: 0 0.25rem;
	}
	.rail-x:hover {
		color: var(--color-text-primary);
	}
	.step {
		padding: 0.65rem 0;
		border-top: 1px solid var(--color-border);
		opacity: 0.7;
	}
	.step.active {
		opacity: 1;
	}
	.step.done {
		opacity: 0.85;
	}
	.step-head {
		display: flex;
		align-items: center;
		gap: 0.55rem;
	}
	.check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.3rem;
		height: 1.3rem;
		border-radius: 50%;
		font-size: 0.7rem;
		font-family: var(--font-mono, monospace);
		border: 1px solid var(--color-border);
		color: var(--color-text-secondary, #9898a3);
	}
	.step.done .check {
		background: var(--color-accent-aurum);
		color: var(--color-bg);
		border-color: transparent;
	}
	.step.active .check {
		border-color: var(--color-accent-aurum);
		color: var(--color-accent-aurum);
	}
	.step-name {
		font-size: 0.85rem;
		color: var(--color-text-primary);
	}
	.step-hint {
		font-size: 0.76rem;
		line-height: 1.45;
		color: var(--color-text-secondary, #9898a3);
		margin: 0.45rem 0 0.55rem 1.85rem;
	}
	.step-err {
		font-size: 0.74rem;
		color: #f87171;
		margin: 0.4rem 0 0 1.85rem;
	}
	.sub-connect { margin-left: 1.85rem; }
	.sub-ack {
		display: flex; align-items: flex-start; gap: 0.45rem;
		margin: 0.35rem 0 0.5rem 1.85rem; max-width: 22rem;
		font-size: 0.72rem; line-height: 1.4;
		color: var(--color-text-secondary, #9898a3); cursor: pointer;
	}
	.sub-ack input { margin-top: 0.15rem; accent-color: var(--color-accent-aurum); flex-shrink: 0; }

	/* ── Gated reveal ──────────────────────────────────────────────────────── */

	/* ── Buttons (shared with the welcome modal vocabulary) ────────────────── */
	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.6rem 1.2rem;
		background: var(--color-accent-aurum);
		color: var(--color-bg);
		border: none;
		border-radius: 8px;
		font-family: inherit;
		font-size: 0.85rem;
		font-weight: 500;
		cursor: pointer;
		transition: transform 0.15s ease, box-shadow 0.2s ease;
	}
	.btn-primary.sm {
		padding: 0.4rem 0.85rem;
		font-size: 0.78rem;
		margin-left: 1.85rem;
	}
	.btn-primary:hover {
		transform: translateY(-1px);
		box-shadow: 0 6px 20px rgba(229, 184, 76, 0.25);
	}
	.btn-primary:disabled {
		opacity: 0.6;
		cursor: default;
		transform: none;
		box-shadow: none;
	}
	.btn-skip {
		background: none;
		border: none;
		color: var(--color-text-secondary, #9898a3);
		padding: 0.55rem 1.1rem;
		border-radius: 8px;
		font-family: inherit;
		font-size: 0.82rem;
		cursor: pointer;
	}
	.btn-skip:hover {
		color: var(--color-text-primary);
	}

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	@keyframes slideUp {
		from { opacity: 0; transform: translateY(18px) scale(0.98); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
	@keyframes indeterminate {
		0% { transform: translateX(-100%); }
		100% { transform: translateX(320%); }
	}

	@media (max-width: 520px) {
		.welcome-body { padding: 1.25rem 1.5rem 1.5rem; }
		.title { font-size: 1.35rem; }
		.rail { right: 0.75rem; bottom: 0.75rem; left: 0.75rem; width: auto; }
	}
</style>
