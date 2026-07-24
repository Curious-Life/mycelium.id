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
	//
	// ── S11 (U1.1): the pre-app /setup + in-app welcome MODAL collapse into ONE
	// in-app WIZARD (OnboardingWizard). This controller still owns the SAME readiness
	// machinery + the post-generation rail (both heavily gated by verify:readiness —
	// do not change their semantics); it now renders the wizard where the modal was.
	import { onMount, onDestroy } from 'svelte';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { guidanceRestoredSignal } from '$lib/stores/onboarding-guidance.svelte';
	import { api } from '$lib/api';
	import { openExternal } from '$lib/open-external';
	import { navigationState } from '$lib/stores/navigation';
	import { chatMessages } from '$lib/stores/chat';
	import OnboardingWizard from './wizard/OnboardingWizard.svelte';

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
	// ── Recovery-key backup gate durability (U1.3) ───────────────────────────────
	// The wizard's Step 2 is unskippable, but it only renders while `wizardOpen` — which
	// keys on `welcomeSeen`, and welcomeSeen goes true the moment ANY message lands
	// (`data.total > 0`), which would retire the gate with the key un-backed-up. So we
	// force the wizard open on the durable EXPLICIT-false `recovery_key_backed_up` flag
	// (the server writes this at /setup create) AND `total === 0`. Keying on the EXPLICIT
	// false (not "!== true") is what stops an established / PRE-U1.3 vault (flag absent)
	// from being re-gated or having its key re-revealed on upgrade. See refresh().
	let recoveryGatePending = $state(false);

	// "See your mind" preview (filled once anything is imported)

	// Generate (the magic moment)
	// The reveal banner is for the moment generation COMPLETES this session — not a
	// permanent fixture. Existing users (generated already true at mount) never see it.
	let probedOllama = $state(false);

	// Decide synchronously from a localStorage hint so the opaque wizard backdrop is
	// painted on the FIRST frame (no flash of the app behind it). The async readiness
	// check below corrects this for the rare edge cases. Returning users (hint set)
	// never see a flicker. (Key name kept stable — it is the same "welcome seen" fact.)
	const WELCOME_SEEN_KEY = 'myc-welcome-seen';
	let wizardOpen = $state(browser ? !localStorage.getItem(WELCOME_SEEN_KEY) : false);
	function markWelcomeSeen() {
		welcomeSeen = true;
		wizardOpen = false;
		try { localStorage.setItem(WELCOME_SEEN_KEY, '1'); } catch { /* private mode */ }
		api('/portal/onboarding/welcome-seen', { method: 'POST' }).catch(() => {});
	}

	// The wizard finished (or the user chose "later") → stamp welcome-seen and land
	// on the mindscape — the empty-state invitation (Data · Intelligence · Connect)
	// is the first thing they should see. Each wizard step persists its OWN work
	// (handle / models / provider / name), so nothing is saved here.
	function finishWizard() {
		markWelcomeSeen();
		navigationState.setPrimaryView('mindscape');
		goto('/mindscape');
		// D-028. markWelcomeSeen() flips `welcomeSeen`, which is one of railVisible's three
		// conditions - so the rail appears IMMEDIATELY, rendering whatever this component
		// last read. But the wizard is exactly where the user just connected intelligence
		// and imported data, and nothing here re-read any of it: the only other caller of
		// refresh() is the 4s poll (pollTimer). So the rail showed pre-wizard state -
		// "connect an AI" still open, data not counted - until a poll happened to land,
		// which the operator saw as the screen "reloading" a moment after finishing setup
		// and only THEN showing data and intelligence as connected.
		//
		// Refresh on completion, so post-wizard state is EVALUATED at the moment it
		// changes rather than DISCOVERED by a later poll. Deliberately not awaited: the
		// navigation above must not wait on a readiness read, and refresh() is idempotent
		// and already reentrancy-safe against the poll.
		void refresh();
		// D-016 / QA7 U9 — once a model is connected, auto-open chat with the agent's
		// first message (introduces itself in the chosen name, shows HONEST awareness of
		// the vault, asks who the user is). Best-effort, non-blocking.
		void maybeGreetAndOpenChat();
	}

	// The onboarding first-message (D-016). Fires ONLY when a model is connected — the
	// server composes + persists the greeting ONCE (durable stamp), so a second finish is
	// a no-op. We open chat only on a FRESH send so we never re-pop it on a later run.
	async function maybeGreetAndOpenChat() {
		// "after a model connects" — read fresh so we don't miss a provider the 4s poll
		// (or the not-yet-settled refresh above) hasn't observed yet.
		let connected = hasProvider;
		if (!connected) {
			const r = await getJSON('/portal/readiness?slices=ai');
			connected = r?.ai?.connected === true;
		}
		if (!connected) return;
		try {
			// The server persists the greeting under `chat:<conversationId>` — the SAME
			// thread key ChatFloat loads — so history returns the greeting on open.
			const conversationId = chatMessages.getConversationId();
			const res = await api('/portal/onboarding/greeting', {
				method: 'POST', body: JSON.stringify({ conversationId }),
			});
			if (!res.ok) return;
			const d = await res.json().catch(() => ({}));
			if (d?.sent === true) {
				await chatMessages.loadHistory(true);   // pull the just-persisted greeting
				navigationState.setChatOpen(true);       // open chat so it's the first thing seen
			}
		} catch { /* best-effort — chat is still reachable from the header toggle */ }
	}
	// A wizard step handed off to the full Import view (an explicit zip/json source).
	// Stamp welcome-seen so the wizard overlay closes, then navigate ONCE to /import
	// (the wizard no longer also calls finishWizard — that caused a double-navigation).
	function openImport() {
		markWelcomeSeen();
		navigationState.setPrimaryView('import');
		goto('/import');
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
			// ── Recovery-key gate (U1.3), EXPLICIT-false only ────────────────────────────
			// Gate iff the flag is EXPLICITLY `pending` (a U1.3 fresh vault, false) AND the
			// vault is empty. Two guards, each sufficient to EXCLUDE a false gate:
			//   • `pending === true` — never fires for a PRE-U1.3 vault (flag absent) or a
			//     backed-up one, so an established key is NEVER re-revealed on upgrade.
			//   • `total === 0` — Step 2 is unskippable before Step 3/4, so any vault with
			//     data has necessarily already passed it; a populated vault is never gated.
			// Only fetch when the vault is empty (a populated vault is never pending). Read
			// FRESH each poll so backup (flag → true) clears the gate with no finish-race.
			// A read error biases AWAY from gating (no forced reveal); a genuinely fresh
			// vault recovers next poll (the explicit false is durable, key is Keychain-safe).
			const total0 = Number(r.data?.total ?? 0) === 0;
			if (total0) {
				const rk = await getJSON('/portal/onboarding/recovery-key-status');
				recoveryGatePending = rk?.pending === true;
			} else {
				recoveryGatePending = false;
			}
			// Correct the first-frame localStorage guess (line ~64): if the BACKEND
			// already knows the welcome was seen/dismissed, close the backdrop even
			// when client localStorage is empty — e.g. a populated vault loaded on a
			// fresh dev-server origin (new vite port) where localStorage resets.
			// Without this the welcome wrongly re-shows over an existing vault. But the
			// recovery-key gate WINS: an un-backed-up fresh vault stays open regardless.
			if (recoveryGatePending) wizardOpen = true;
			else if (welcomeSeen || dismissed) wizardOpen = false;
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
	// QA6-P1 #3: this used to POST the LEGACY /auth/claude/import, whose only outcome on
	// a machine without a readable Claude Code credential is a raw ClaudeImportError
	// string ("No Claude subscription access token found in the credentials file.") —
	// a wall. It dead-ended even though the browser flow, which works on a box with no
	// `claude` CLI at all, already existed. It now runs the SAME ladder as Settings:
	// /auth/claude/connect probes every credential store and, when nothing usable is
	// found, hands back the real reason plus a PKCE URL — which we present INLINE with
	// the manual paste, automatically. Auto-detect failure degrades TOWARD the working
	// path instead of terminating on it.
	let subWebUrl = $state<string | null>(null);
	let subWebReason = $state<string | null>(null);
	let subCode = $state('');
	let subOpenFailed = $state(false);
	let subUrlCopied = $state(false);
	// Same discipline as AISettings: a Tauri webview can swallow a _blank navigation, so
	// the URL is always on screen and a failed open() says so out loud.
	async function openSubSignIn() {
		if (!subWebUrl) return;
		subOpenFailed = false;
		// D-010: openExternal tries the native opener plugin (the real system browser)
		// before window.open, which the Tauri webview swallows — see open-external.ts.
		if (!(await openExternal(subWebUrl))) subOpenFailed = true;
	}
	async function copySubUrl() {
		if (!subWebUrl) return;
		try { await navigator.clipboard.writeText(subWebUrl); subUrlCopied = true; setTimeout(() => { subUrlCopied = false; }, 1600); }
		catch { /* the URL is selectable right there */ }
	}
	async function connectSub() {
		if (!subAck) return;
		subConnecting = true;
		subError = '';
		subWebUrl = null; subWebReason = null; subOpenFailed = false;
		try {
			const res = await api('/portal/auth/claude/connect', { method: 'POST', body: JSON.stringify({ acknowledgeToS: true }) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok || !d.ok) {
				subError = d.error || 'Could not connect — open AI settings to finish.';
			} else if (d.connected) {
				hasProvider = true;
				activeProviderLabel = 'Claude Pro/Max';
				subOpen = false;
			} else if (d.url) {
				// Nothing usable on this device. NOT an error — the next step, shown here.
				subWebUrl = d.url;
				subWebReason = d.reason || null;
			} else {
				subError = d.detail || 'Could not start the browser sign-in — open AI settings to finish.';
			}
		} catch {
			subError = 'Could not connect — open AI settings to finish.';
		} finally {
			subConnecting = false;
		}
	}
	// Step 2 of the ladder: paste the code back. Mirrors AISettings.finishSubWeb —
	// the server consumes the pending PKCE flow BEFORE exchanging, so any failure has
	// burned the verifier; drop back to step 1 rather than leaving a dead link.
	async function finishSubWeb() {
		if (!subCode.trim()) return;
		subConnecting = true;
		subError = '';
		try {
			const res = await api('/portal/auth/claude/code', { method: 'POST', body: JSON.stringify({ acknowledgeToS: true, code: subCode.trim() }) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok || !d.ok) throw new Error(d.error || 'Could not complete the connection');
			hasProvider = true;
			activeProviderLabel = 'Claude Pro/Max';
			subOpen = false; subWebUrl = null; subCode = '';
		} catch (e: any) {
			subError = e?.message || 'Could not complete the connection';
			subWebUrl = null; subCode = '';
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
		// open for a genuinely fresh, unseen, undismissed vault OR whenever the recovery
		// key still isn't backed up (the unskippable Step-2 gate must not be escapable).
		wizardOpen = recoveryGatePending || (!welcomeSeen && !dismissed);
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

{#if wizardOpen}
	<!-- The unified in-app onboarding wizard (S11) — REPLACES the legacy welcome
	     modal. Hero → Step 1 handle → [Step 2 recovery key, U1.3 security PR] →
	     Step 3 intelligence → Step 4 import. Each step persists its own work;
	     finishWizard stamps welcome-seen + lands on the mindscape. -->
	<OnboardingWizard onFinish={finishWizard} onOpenImport={openImport} />
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
				{:else if !subWebUrl}
					<label class="sub-ack">
						<input type="checkbox" bind:checked={subAck} />
						<span>Use my existing Claude login. Automated use of a Pro/Max plan may be subject to Anthropic’s Terms.</span>
					</label>
					<button class="btn-primary sm" disabled={!subAck || subConnecting} onclick={connectSub}>
						{subConnecting ? 'Connecting…' : 'Connect'}
					</button>
				{:else}
					<!-- Auto-detect found nothing usable → the MANUAL path, inline, with the
					     real reason. This is what replaced the dead-end error string. -->
					<p class="step-hint">
						{#if subWebReason === 'declined'}macOS blocked access to your saved Claude login — you’re signed in, but we can’t read it. Sign in through your browser instead:
						{:else if subWebReason === 'wrong_scope'}The login on this device is an admin setup-token, not a subscription sign-in. Sign in through your browser:
						{:else if subWebReason === 'expired'}Your Claude session couldn’t be renewed. Sign in again:
						{:else}No Claude login found on this device. Sign in through your browser:
						{/if}
					</p>
					<div class="sub-web-actions">
						<button class="btn-primary sm" onclick={openSubSignIn}>Open Claude sign-in ↗</button>
						<button class="btn-skip" onclick={copySubUrl}>{subUrlCopied ? '✓ Link copied' : 'Copy link'}</button>
					</div>
					{#if subOpenFailed}<p class="step-err">Couldn’t open a browser window from here. Copy the link below and paste it into your browser.</p>{/if}
					<div class="sub-url"><code>{subWebUrl}</code></div>
					<p class="step-hint">Approve it, then paste the code Claude gives you:</p>
					<input class="sub-code" placeholder="Paste the code from Claude" bind:value={subCode} autocomplete="off" spellcheck="false"
						onkeydown={(e) => { if (e.key === 'Enter' && subCode.trim()) finishSubWeb(); }} />
					<button class="btn-primary sm" disabled={!subCode.trim() || subConnecting} onclick={finishSubWeb}>
						{subConnecting ? 'Connecting…' : 'Finish connecting'}
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

<!-- The "Your mycelium is ready" reveal popup was REMOVED entirely (D-033): it was inert —
     clicking it did nothing — so the operator's call was to remove it rather than wire it up.
     It never lived in this file; the rail's pollGenerate() (deleted earlier) was its only
     writer, and the block last lived in MindscapeView, which is where the removal landed. -->

<style>
	/* The welcome/hero + step surface now lives in OnboardingWizard.svelte (S11).
	   This file keeps ONLY the post-generation guide rail. */

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

	/* Ladder step 2 (manual paste) — the inline fallback for a failed auto-detect. */
	.sub-web-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; margin-left: 1.85rem; }
	.sub-url {
		margin: 0.35rem 0 0.4rem 1.85rem; max-width: 22rem; overflow-x: auto;
		padding: 0.3rem 0.45rem; border-radius: 6px; background: rgba(0,0,0,0.25);
	}
	.sub-url code {
		font-family: var(--font-mono, monospace); font-size: 0.6rem; white-space: nowrap;
		color: var(--color-text-secondary, #9898a3); user-select: all;
	}
	.sub-code {
		display: block; margin: 0.25rem 0 0.45rem 1.85rem; max-width: 22rem; width: 100%;
		padding: 0.4rem 0.55rem; border-radius: 6px; font-size: 0.72rem;
		border: 1px solid var(--color-border, rgba(255,255,255,0.12));
		background: var(--color-elevated, rgba(255,255,255,0.05));
		color: var(--color-text-primary, #eee); font-family: var(--font-mono, monospace);
	}

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

	@keyframes slideUp {
		from { opacity: 0; transform: translateY(18px) scale(0.98); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}

	@media (max-width: 520px) {
		.rail { right: 0.75rem; bottom: 0.75rem; left: 0.75rem; width: auto; }
	}
</style>
