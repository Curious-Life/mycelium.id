<!--
	Engine (harness) selector — the FUNCTIONAL native ↔ Claude Code switch.
	"Which engine runs your chat agent": Mycelium native (default; runs on your
	configured providers) or Claude Code (runs your agent on your Claude
	subscription). Persists settings.harnessMode via GET/PUT /portal/providers/harness.
	The Claude Code option is enabled ONLY when a subscription is connected AND the
	`claude` binary is installed — otherwise it's shown disabled with an honest reason,
	so the choice never silently no-ops (the runtime resolver also fails safe to native).
	See docs/HARNESS-CLI-DESIGN-2026-07-02.md.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { api } from '$lib/api';

	let mode = $state<'native' | 'cli'>('native');
	let subscriptionConnected = $state(false);
	let claudeAvailable = $state(false);
	let engineReady = $state(false);   // is the cli engine actually wired (C2 shipped)?
	let busy = $state<'native' | 'cli' | null>(null);
	let loaded = $state(false);

	// Claude Code is selectable only when the engine is shipped AND both gates pass.
	// The reason is ordered most-fundamental-first so the card never implies it's
	// usable when it isn't (engine not shipped ⇒ "coming soon", never "Ready").
	const cliEligible = $derived(engineReady && subscriptionConnected && claudeAvailable);
	const cliReason = $derived(
		!engineReady ? 'Coming soon'
			: !subscriptionConnected ? 'Connect your Claude subscription below'
			: !claudeAvailable ? 'Install Claude Code: npm i -g @anthropic-ai/claude-code'
			: '',
	);

	async function load() {
		try {
			const r = await api('/portal/providers/harness');
			if (r.ok) {
				const j = await r.json();
				mode = j.harnessMode === 'cli' ? 'cli' : 'native';
				subscriptionConnected = j.subscriptionConnected === true;
				claudeAvailable = j.claudeAvailable === true;
				engineReady = j.engineReady === true;
			}
		} catch { /* leave defaults (native) */ }
		finally { loaded = true; }
	}

	async function pick(next: 'native' | 'cli') {
		if (next === mode) return;
		if (next === 'cli' && !cliEligible) return;
		busy = next;
		const prev = mode;
		mode = next;                       // optimistic
		try {
			const r = await api('/portal/providers/harness', { method: 'PUT', body: JSON.stringify({ harnessMode: next }) });
			if (r.ok) { mode = (await r.json()).harnessMode === 'cli' ? 'cli' : 'native'; }
			else mode = prev;
		} catch { mode = prev; }
		finally { busy = null; }
	}

	onMount(load);
</script>

<div class="engine">
	<div class="engine-head">
		<span class="engine-title">Engine</span>
		<span class="engine-sub">Which engine runs your chat agent.</span>
	</div>
	<div class="engine-cards" role="radiogroup" aria-label="Agent engine">
		<button
			class="engine-card"
			class:sel={mode === 'native'}
			role="radio"
			aria-checked={mode === 'native'}
			disabled={busy !== null}
			onclick={() => pick('native')}
		>
			<span class="ec-top"><span class="ec-name">Mycelium</span>{#if mode === 'native'}<span class="ec-tick">✓</span>{/if}</span>
			<span class="ec-blurb">Native engine. Runs on the models &amp; providers you configure below.</span>
			<span class="ec-tag">Default · always available</span>
		</button>

		<button
			class="engine-card"
			class:sel={mode === 'cli'}
			class:disabled={!cliEligible}
			role="radio"
			aria-checked={mode === 'cli'}
			disabled={busy !== null || !cliEligible}
			title={!cliEligible ? cliReason : undefined}
			onclick={() => pick('cli')}
		>
			<span class="ec-top"><span class="ec-name">Claude Code</span>{#if mode === 'cli'}<span class="ec-tick">✓</span>{/if}</span>
			<span class="ec-blurb">Runs your agent on your Claude Pro/Max subscription, with your vault as its tools.</span>
			{#if cliEligible}
				<span class="ec-tag ok">Ready</span>
			{:else if loaded}
				<span class="ec-tag muted">{cliReason}</span>
			{/if}
		</button>
	</div>
</div>

<style>
	.engine { margin-bottom: 1.1rem; }
	.engine-head { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.5rem; }
	.engine-title { font-size: 0.9rem; font-weight: 600; color: var(--color-text-primary); }
	.engine-sub { font-size: 0.7rem; color: var(--color-text-tertiary); }
	.engine-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
	@media (max-width: 560px) { .engine-cards { grid-template-columns: 1fr; } }
	.engine-card {
		display: flex; flex-direction: column; gap: 0.3rem; text-align: left;
		padding: 0.75rem 0.85rem; border-radius: 13px; cursor: pointer;
		background: var(--color-surface, rgba(255,255,255,0.03));
		border: 1px solid var(--color-border, rgba(255,255,255,0.1));
		transition: border-color 0.15s, background 0.15s;
		font-family: inherit;
	}
	.engine-card:hover:not(:disabled) { border-color: var(--color-accent, #e5b84c); }
	.engine-card.sel { border-color: var(--color-accent, #e5b84c); background: var(--color-elevated, rgba(255,255,255,0.06)); }
	.engine-card.disabled { opacity: 0.55; cursor: not-allowed; }
	.engine-card:disabled { cursor: default; }
	.ec-top { display: flex; align-items: center; justify-content: space-between; }
	.ec-name { font-size: 0.82rem; font-weight: 600; color: var(--color-text-primary); }
	.ec-tick { font-size: 0.75rem; color: var(--color-accent, #e5b84c); }
	.ec-blurb { font-size: 0.68rem; color: var(--color-text-secondary); line-height: 1.4; }
	.ec-tag { font-size: 0.62rem; color: var(--color-text-tertiary); margin-top: 0.15rem; }
	.ec-tag.ok { color: #6ee7a8; }
	.ec-tag.muted { color: var(--color-text-tertiary); }
</style>
