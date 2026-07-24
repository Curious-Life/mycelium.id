<script lang="ts">
	// Wizard Step 5 — Name your agent + connect a messenger (D-031 / QA7 U9).
	//
	// Two beats, in the operator's order:
	//   1. NAME the personal agent. The "How will you call…" prompt was previously
	//      misplaced inside Step 3 (IntelligenceStep) — it is relocated here and
	//      reworded to "How will you call your personal agent?" (operator, D-031).
	//      The save path is the SAME one the old Step-3 name beat used: PUT
	//      /portal/agent-identity → settings.agent.name (what ChatFloat reads).
	//   2. CONNECT Telegram/Discord — by REUSING the settings component verbatim.
	//
	// ⚠️ ANTI-FORK (operator, explicit): the channel-connect UI here MUST be the
	// SAME component/code/functionality that works in Settings. We render the
	// settings <ChannelsSection> directly — no second connect flow, no copy that
	// can drift out of parity with the one that works. verify:onboarding-structure
	// asserts this import + render is the settings component, not a fork.
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import ChannelsSection from '$lib/components/settings/ChannelsSection.svelte';

	let { onNext }: { onNext: () => void } = $props();

	// ── Name beat (name-only; personality lives on the character page) ───────────
	// The server default when unset — mirrors DEFAULT_AGENT_NAME (src/portal-chat.js).
	// Display-only heuristic: don't PREFILL the box with the placeholder default, so a
	// fresh vault shows "e.g. Aria" while a returning user sees the name they chose.
	const DEFAULT_AGENT_NAME = 'Mycelium';
	let agentName = $state('');
	let savedName = $state<string | null>(null); // last value we persisted (dedupe redundant PUTs)
	let advancing = $state(false);

	async function getJSON(path: string): Promise<any | null> {
		try { const r = await api(path); return r.ok ? await r.json() : null; } catch { return null; }
	}

	// The ONE save path — awaited, best-effort, idempotent. Called both eagerly (on
	// blur, so a header "Skip for later" that bypasses Continue still persists) and
	// again on Continue. `settings.agent.name` is what ChatFloat + the first-message
	// greeting read, so this is the whole naming fix.
	async function saveName() {
		const name = agentName.trim();
		if (!name || name === savedName) return;
		try {
			const res = await api('/portal/agent-identity', { method: 'PUT', body: JSON.stringify({ name }) });
			if (res.ok) savedName = name;
		} catch { /* best-effort — nameable later on the character page */ }
	}

	async function continueOn() {
		if (advancing) return;
		advancing = true;
		await saveName();
		onNext();
	}

	onMount(async () => {
		const identity = await getJSON('/portal/agent-identity');
		// Seed the box from the stored name so a returning user sees it (and a re-save
		// never blanks it). Skip the server default — a fresh vault keeps the placeholder.
		const stored = typeof identity?.name === 'string' ? identity.name.trim() : '';
		if (stored && stored !== DEFAULT_AGENT_NAME) { agentName = stored; savedName = stored; }
	});
</script>

<div class="step-body">
	<h1 class="title">Name your agent</h1>
	<!-- Copy: PROPOSAL for operator review (D-031, Q2). -->
	<p class="lede">Give your personal agent a name, and connect a messenger so you can talk to your mind from anywhere.</p>

	<!-- ── Beat 1 — name your agent (reworded + relocated from Step 3, D-031) ── -->
	<section class="sec name-beat">
		<label class="name-label" for="wiz-agent-name">How will you call your personal agent?</label>
		<input id="wiz-agent-name" class="name-input" type="text" maxlength="40" bind:value={agentName} onblur={saveName} placeholder="e.g. Aria" />
	</section>

	<!-- ── Beat 2 — connect Telegram/Discord (the SETTINGS component, verbatim) ── -->
	<!-- ⚠️ Do NOT replace this with a hand-rolled channel form. It is the exact
	     surface from Settings → Channels; forking it is the D-031 failure to avoid. -->
	<section class="sec channel-beat">
		<ChannelsSection />
	</section>

	<div class="footer">
		<button class="primary" disabled={advancing} onclick={continueOn}>{advancing ? 'Saving…' : 'Continue'}</button>
	</div>
</div>

<style>
	.step-body { display: flex; flex-direction: column; }
	.title { font-family: var(--font-serif, 'Geist', system-ui, sans-serif); font-size: 1.5rem; font-weight: 400; line-height: 1.15; letter-spacing: -0.015em; color: var(--color-text-primary); margin: 0 0 0.5rem; }
	.lede { font-size: 0.9rem; line-height: 1.5; color: var(--color-text-secondary); margin: 0 0 1.2rem; }
	.sec { margin-bottom: 1.3rem; }
	.name-beat { display: flex; flex-direction: column; gap: 0.4rem; }
	.name-label { font-size: 0.85rem; color: var(--color-text-primary); }
	.name-input { padding: 0.55rem 0.75rem; border-radius: 9px; border: 1px solid var(--glass-input-border, rgba(255,255,255,0.14)); background: var(--glass-input-bg, rgba(0,0,0,0.2)); color: var(--color-text-primary); font-family: inherit; font-size: 0.9rem; outline: none; max-width: 20rem; }
	.name-input:focus { border-color: var(--color-accent-aurum, #e5b84c); }
	/* The reused settings section brings its own `card` chrome; keep the wizard's
	   spacing consistent around it without restyling its internals. */
	.channel-beat :global(.card) { margin: 0; }
	.footer { margin-top: 0.6rem; }
	.primary { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.55rem 1.2rem; border-radius: 9px; border: none; background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c; font-family: inherit; font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: transform 0.15s ease, box-shadow 0.2s ease, opacity 0.15s ease; }
	.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(229,184,76,0.25); }
	.primary:disabled { opacity: 0.5; cursor: default; transform: none; box-shadow: none; }
</style>
