<script lang="ts">
	// OnboardingWizard — the unified in-app onboarding wizard (S11, U1.1 + U1.3).
	// Replaces the legacy welcome MODAL with a stepped, guided-never-gated flow:
	//
	//   Welcome / hero  →  Step 1 Claim your handle  →  Step 2 recovery key (GATE)
	//                   →  Step 3 Connect intelligence  →  Step 4 Bring your world in
	//
	// ── Entry (U1.3). A FRESH vault is created SILENTLY at the hero: /setup shows the
	// hero, "Get started" fires POST /api/v1/account/setup (mints the key, completeBoot
	// opens the vault) and navigates into the app shell — where THIS wizard resumes at
	// Step 1 (the hero was already shown at /setup, so a fresh vault skips it here).
	// Loopback is "always signed in" (auth shim — auth.js:76) so there is NO login step.
	//
	// ── Step 2 is the ONE unskippable step (a lost key = an unrecoverable vault). It is
	// gated on the DURABLE `recovery_key_backed_up` flag: until that flag is set the
	// wizard opens straight onto the forced gate on every relaunch, and there is NO path
	// out of the wizard (no hero "later", no skip) that does not pass through it. See
	// RecoveryKeyStep.svelte for the reveal + the strict pass condition.
	//
	// Skip is per step (guided, never gated) — EXCEPT Step 2. A skipped step resurfaces
	// later (the onboarding rail carries the AI/channel steps post-generation; handle +
	// import stay reachable from their settings surfaces + the mindscape invite).
	import { onMount } from 'svelte';
	import { api } from '$lib/api';
	import MyceliumCanvas from '../MyceliumCanvas.svelte';
	import HandleStep from './HandleStep.svelte';
	import RecoveryKeyStep from './RecoveryKeyStep.svelte';
	import IntelligenceStep from './IntelligenceStep.svelte';
	import ImportStep from './ImportStep.svelte';

	let { onFinish, onOpenImport }: { onFinish: () => void; onOpenImport: (source?: string) => void } = $props();

	// The full locked flow. `of` = 4 so the indicator reads the design's numbering.
	const STEPS = [1, 2, 3, 4] as const;
	const TOTAL = 4;

	type Stage = 'boot' | 'hero' | (typeof STEPS)[number];
	// 'boot' until we know whether the recovery key is already backed up — the
	// hero-vs-gate decision is security-load-bearing, so never render either until the
	// flag has been read (default fail-closed: NOT backed up ⇒ force the gate).
	let stage = $state<Stage>('boot');
	// `pending` = the recovery key is EXPLICITLY not-yet-backed-up (a U1.3 fresh vault).
	// This is the ONLY state that forces the Step-2 reveal. A backed-up vault OR a PRE-U1.3
	// vault (flag absent) is NOT pending — Step 2 confirms-and-continues without re-revealing
	// the key (fixing the over-gate/re-reveal regression on upgrade).
	let pending = $state(false);

	onMount(async () => {
		// Read the tri-state backup flag. Only an EXPLICIT `pending` forces the reveal;
		// on ANY failure we bias AWAY from revealing (pending stays false) so an established
		// / pre-U1.3 key is never re-revealed. A genuinely fresh vault is separately kept in
		// the gate by OnboardingFlow (pending && total===0) and recovers on the next poll.
		try {
			const res = await api('/portal/onboarding/recovery-key-status');
			const data = res.ok ? await res.json().catch(() => ({})) : {};
			pending = data.pending === true;
		} catch { pending = false; }
		// Pending fresh vault: the hero was shown at /setup, so resume at Step 1 — the flow
		// then FORCES Step 2 before Step 3/4/finish are reachable. Otherwise show the hero;
		// if Step 2 is reached (via a skip), it confirms-and-continues, never re-reveals.
		stage = pending ? STEPS[0] : 'hero';
	});

	function start() { stage = STEPS[0]; }

	function indexOfStage(): number {
		return STEPS.indexOf(stage as (typeof STEPS)[number]);
	}
	// Advance to the next built step; past the last one, finish the wizard.
	function advance() {
		const i = indexOfStage();
		if (i < 0 || i >= STEPS.length - 1) { onFinish(); return; }
		stage = STEPS[i + 1];
	}
	// "Skip for later" = advance without completing. The skipped work resurfaces
	// later: the post-generation rail carries the AI/channel steps; handle + import
	// stay reachable from the mindscape invite + their settings surfaces.
	const skip = advance;

	function handleOpenImport(source?: string) {
		// Explicit zip/json sources live on the full Import view — hand off there
		// directly. onOpenImport ALSO closes the wizard (stamps welcome-seen), so we
		// must NOT also call onFinish(): that navigated to /mindscape first and the
		// /import goto immediately overrode it (a wasted double-navigation).
		onOpenImport(source);
	}
</script>

<div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
	<!-- The living mycelium grows across the whole backdrop, behind the glass panel. -->
	<MyceliumCanvas />

	<div class="panel">
		{#if stage === 'boot'}
			<div class="hero">
				<p class="hero-sub">Preparing…</p>
			</div>
		{:else if stage === 'hero'}
			<div class="hero">
				<div class="eyebrow">Welcome</div>
				<h1 id="wiz-title" class="hero-title">See your mind take shape</h1>
				<p class="hero-sub">Private, encrypted, on your device.</p>
				<button class="primary lg" onclick={start}>
					Get started
					<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
				</button>
				<!-- Guided, never GATED: an escape hatch (the old modal's "Later"). Steps
				     resurface later. -->
				<button class="later" onclick={onFinish}>I'll set up later</button>
			</div>
		{:else}
			<header class="wiz-head">
				<span class="step-indicator">Step {stage} of {TOTAL}</span>
				<!-- ⛔ NO skip on Step 2 — the one unskippable data-loss gate. -->
				{#if stage !== 2}
					<button class="skip" onclick={skip}>Skip for later</button>
				{/if}
			</header>

			<div class="wiz-content">
				{#if stage === 1}
					<HandleStep onNext={advance} />
				{:else if stage === 2}
					<!-- The ONE unskippable gate. Reveals ONLY for a pending (fresh) vault; an
					     established / pre-U1.3 vault confirms-and-continues without re-revealing.
					     onNext advances ONLY after the durable flag is set (fail-closed). -->
					<RecoveryKeyStep onNext={advance} alreadyBackedUp={!pending} />
				{:else if stage === 3}
					<IntelligenceStep onNext={advance} />
				{:else if stage === 4}
					<ImportStep onNext={advance} onOpenImport={handleOpenImport} />
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.backdrop {
		position: fixed; inset: 0; z-index: 1000;
		background: var(--color-bg);
		display: flex; align-items: center; justify-content: center;
		padding: 1.5rem; animation: fadeIn 0.35s ease-out; overflow-y: auto;
	}
	.panel {
		position: relative; z-index: 1;
		width: 100%; max-width: 540px; margin: auto;
		background: var(--glass-panel-bg); backdrop-filter: blur(22px) saturate(140%);
		-webkit-backdrop-filter: blur(22px) saturate(140%);
		border: 1px solid var(--glass-border); border-radius: 18px;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(229, 184, 76, 0.06);
		animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1);
		padding: 1.9rem 2.1rem 2rem;
	}
	/* ── Hero ── */
	.hero { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 1.5rem 0.5rem 1rem; }
	.eyebrow { font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 0.62rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--color-accent-aurum); margin-bottom: 0.8rem; }
	.hero-title { font-family: var(--font-serif, 'Geist', system-ui, sans-serif); font-size: 2rem; font-weight: 400; line-height: 1.12; letter-spacing: -0.02em; color: var(--color-text-primary); margin: 0 0 0.7rem; }
	.hero-sub { font-size: 0.98rem; color: var(--color-text-secondary); margin: 0 0 1.9rem; }
	.later { margin-top: 1rem; background: none; border: none; font-family: inherit; font-size: 0.78rem; color: var(--color-text-tertiary); cursor: pointer; }
	.later:hover { color: var(--color-text-secondary); }
	/* ── Step chrome ── */
	.wiz-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
	.step-indicator { font-family: var(--font-mono, monospace); font-size: 0.68rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-accent-aurum); }
	.skip { background: none; border: none; padding: 0.3rem 0.4rem; font-family: inherit; font-size: 0.78rem; color: var(--color-text-tertiary); cursor: pointer; border-radius: 6px; }
	.skip:hover { color: var(--color-text-secondary); }
	.wiz-content { display: flex; flex-direction: column; }
	.primary { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1.3rem; border-radius: 9px; border: none; background: var(--color-accent-aurum, #e5b84c); color: #0a0a0c; font-family: inherit; font-size: 0.88rem; font-weight: 500; cursor: pointer; transition: transform 0.15s ease, box-shadow 0.2s ease; }
	.primary.lg { padding: 0.7rem 1.6rem; font-size: 0.95rem; }
	.primary:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(229, 184, 76, 0.25); }
	@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
	@keyframes slideUp { from { opacity: 0; transform: translateY(18px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
	@media (max-width: 540px) { .panel { padding: 1.4rem 1.4rem 1.6rem; } .hero-title { font-size: 1.6rem; } }
</style>
