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
	import { api } from '$lib/api';
	import { navigationState } from '$lib/stores/navigation';
	import MyceliumCanvas from './MyceliumCanvas.svelte';

	type StepKey = 'import' | 'connect-ai' | 'generate';

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

	// "See your mind" preview (filled once anything is imported)
	let preview = $state<{
		messageCount: number;
		dateRange: { yearStart: number | null; yearEnd: number | null };
		sources: { source: string; count: number }[];
		sourceCount: number;
		conversationCount: number;
		peopleCount: number;
	} | null>(null);

	// Generate (the magic moment)
	let generating = $state(false);
	let generateLabel = $state('');
	let generateError = $state('');
	let generateJobId = $state<string | null>(null);
	// The reveal banner is for the moment generation COMPLETES this session — not a
	// permanent fixture. Existing users (generated already true at mount) never see it.
	let justGenerated = $state(false);
	let probedOllama = $state(false);

	let welcomeOpen = $state(false);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	// The first incomplete step drives the rail's emphasis + auto-advance.
	const activeStep = $derived<StepKey>(
		messageCount === 0 ? 'import' : !hasProvider ? 'connect-ai' : 'generate'
	);
	// Show the rail only once there's data to act on — the EMPTY vault is owned by
	// the mindscape invitation (3 ethereal actions), so the rail would just clutter
	// it. After import it returns to nudge Connect-AI → Generate.
	const railVisible = $derived(!loading && !dismissed && welcomeSeen && !generated && messageCount > 0);

	async function getJSON(path: string): Promise<any | null> {
		try {
			const res = await api(path);
			if (!res.ok) return null;
			return await res.json();
		} catch {
			return null;
		}
	}

	async function refresh() {
		const [status, providers, mind] = await Promise.all([
			getJSON('/portal/onboarding/status'),
			getJSON('/portal/providers'),
			getJSON('/portal/mindscape'),
		]);

		if (status) {
			dismissed = !!status.dismissed;
			welcomeSeen = !status.showWelcome; // showWelcome is true only on an unseen empty vault
			const d = status.steps?.data ?? {};
			messageCount = Number(d.messageCount ?? 0);
			embedded = Number(d.enrichedCount ?? 0);
			pending = Number(d.enrichmentPending ?? 0);
		}
		if (providers?.providers) {
			const active = providers.providers.find((p: any) => p.is_active) ?? providers.providers[0];
			hasProvider = providers.providers.length > 0;
			activeProviderLabel = active ? (active.label || active.provider) : null;
		}
		generated = Array.isArray(mind?.nodes) && mind.nodes.length > 0;

		// Lazy-load the heavier probes only when their step is near.
		if (messageCount > 0 && !preview) loadPreview();
		if (messageCount > 0 && !hasProvider && !probedOllama) probeOllama();

		loading = false;
	}

	async function loadPreview() {
		const p = await getJSON('/portal/import/preview');
		if (p?.ok || typeof p?.messageCount === 'number') preview = p;
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
	async function beginFlow() {
		welcomeOpen = false;
		welcomeSeen = true;
		try {
			await api('/portal/onboarding/welcome-seen', { method: 'POST' });
		} catch {
			/* non-blocking */
		}
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
		goto('/settings');
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

	// ── Generate (Step 5): trigger + poll, gated reveal ────────────────────────
	async function generate() {
		generateError = '';
		generating = true;
		generateLabel = 'Starting…';
		try {
			const res = await api('/portal/mycelium/generate', { method: 'POST' });
			const d = await res.json().catch(() => ({}));
			if (!res.ok) {
				generateError = d.error || 'Could not start — try again shortly.';
				generating = false;
				return;
			}
			generateJobId = d.jobId ?? null;
			pollGenerate();
		} catch {
			generateError = 'Generation is unavailable right now.';
			generating = false;
		}
	}

	async function pollGenerate() {
		if (!generateJobId) return;
		const job = await getJSON(`/portal/mycelium/generate/status/${generateJobId}`);
		if (!job) return;
		generateLabel = job.stageLabel || job.status || 'Working…';
		if (job.status === 'done' || job.status === 'complete' || job.status === 'completed') {
			generating = false;
			generateJobId = null;
			justGenerated = true; // earns the reveal banner (this session only)
			await refresh(); // generated flips true once nodes exist → rail hides, reveal CTA shows
		} else if (job.status === 'error' || job.status === 'failed') {
			generating = false;
			generateError = job.error || 'Generation failed — try again.';
			generateJobId = null;
		}
	}

	function exploreMind() {
		navigationState.setPrimaryView('mindscape');
		goto('/mindscape');
	}

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
		// Open the welcome only for a genuinely fresh, unseen, undismissed vault.
		if (!welcomeSeen && !dismissed) welcomeOpen = true;
		// Light polling keeps the rail honest as embedding/generation progress.
		pollTimer = setInterval(() => {
			if (generating) pollGenerate();
			else if (railVisible) refresh();
		}, 4000);
	});

	onDestroy(() => {
		if (pollTimer) clearInterval(pollTimer);
	});
</script>

{#if welcomeOpen}
	<div class="backdrop" role="dialog" aria-modal="true" aria-labelledby="onb-welcome-title">
		<!-- The hero mycelium animation grows across the whole backdrop, behind the glass. -->
		<MyceliumCanvas />
		<div class="welcome">
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
				<div class="welcome-actions">
					<button class="btn-skip" onclick={() => { welcomeOpen = false; welcomeSeen = true; api('/portal/onboarding/welcome-seen', { method: 'POST' }).catch(() => {}); }}>
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

		<!-- Step: Import -->
		<div class="step" class:active={activeStep === 'import'} class:done={messageCount > 0}>
			<div class="step-head">
				<span class="check">{messageCount > 0 ? '✓' : '1'}</span>
				<span class="step-name">Bring your world in</span>
			</div>
			{#if messageCount === 0}
				<p class="step-hint">Conversations, journals, transcripts — anything that holds your thinking.</p>
				<button class="btn-primary sm" onclick={goImport}>Import →</button>
			{:else if preview}
				<!-- "See your mind" evidence card — self-insight, not surveillance -->
				<div class="see-card">
					<div class="see-line"><strong>{preview.messageCount.toLocaleString()}</strong> messages</div>
					<div class="see-meta">
						{#if preview.dateRange?.yearStart && preview.dateRange?.yearEnd}
							{preview.dateRange.yearStart}–{preview.dateRange.yearEnd}
						{/if}
						{#if preview.sources?.length}· {preview.sourceCount} {preview.sourceCount === 1 ? 'source' : 'sources'}{/if}
						{#if preview.peopleCount > 0}· {preview.peopleCount} people{/if}
					</div>
				</div>
			{:else}
				<p class="step-hint">{messageCount.toLocaleString()} imported.</p>
			{/if}
		</div>

		<!-- Step: Connect AI -->
		<div class="step" class:active={activeStep === 'connect-ai'} class:done={hasProvider} class:pending={messageCount === 0}>
			<div class="step-head">
				<span class="check">{hasProvider ? '✓' : '2'}</span>
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
					<p class="step-hint">Choose your intelligence — local or a cloud key.</p>
					<button class="btn-primary sm" onclick={goConnectAI}>Choose AI →</button>
				{/if}
				{#if connectError}<p class="step-err">{connectError}</p>{/if}
			{/if}
		</div>

		<!-- Step: Generate -->
		<div class="step" class:active={activeStep === 'generate'} class:pending={!hasProvider || messageCount === 0}>
			<div class="step-head">
				<span class="check">3</span>
				<span class="step-name">Watch your mind take shape</span>
			</div>
			{#if activeStep === 'generate'}
				{#if generating}
					<p class="step-hint">{generateLabel}</p>
					<div class="bar"><div class="bar-fill"></div></div>
				{:else}
					<p class="step-hint">Map your territories, themes, and realms.</p>
					<button class="btn-primary sm" onclick={generate}>Generate my mycelium</button>
					{#if generateError}<p class="step-err">{generateError}</p>{/if}
				{/if}
			{/if}
		</div>
	</div>
{/if}

{#if justGenerated && generated && !dismissed}
	<!-- Gated reveal: the moment generation completes THIS session (real nodes
	     exist). Existing users with an already-built mindscape never see it. -->
	<div class="reveal" role="status">
		<span>Your mycelium is ready.</span>
		<button class="btn-primary sm" onclick={exploreMind}>Explore your mind →</button>
		<button class="rail-x" aria-label="Dismiss" onclick={dismiss}>×</button>
	</div>
{/if}

<style>
	/* ── Welcome modal ─────────────────────────────────────────────────────── */
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: #0a0a0c; /* the mycelium canvas fills this; card floats over it */
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
		background: rgba(12, 12, 16, 0.55);
		backdrop-filter: blur(22px) saturate(140%);
		-webkit-backdrop-filter: blur(22px) saturate(140%);
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 16px;
		overflow: hidden;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(229, 184, 76, 0.06);
		animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.welcome-body {
		padding: 1.5rem 2.25rem 1.75rem;
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
	.step.pending .step-name {
		color: var(--color-text-secondary, #9898a3);
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
	.see-card {
		margin: 0.5rem 0 0.4rem 1.85rem;
		padding: 0.6rem 0.75rem;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: 9px;
	}
	.see-line {
		font-size: 0.9rem;
		color: var(--color-text-primary);
	}
	.see-meta {
		font-size: 0.72rem;
		color: var(--color-text-secondary, #9898a3);
		margin-top: 0.2rem;
	}
	.bar {
		height: 4px;
		border-radius: 3px;
		background: var(--color-border);
		overflow: hidden;
		margin: 0.4rem 0 0 1.85rem;
	}
	.bar-fill {
		height: 100%;
		width: 40%;
		background: var(--color-accent-aurum);
		border-radius: 3px;
		animation: indeterminate 1.4s ease-in-out infinite;
	}

	/* ── Gated reveal ──────────────────────────────────────────────────────── */
	.reveal {
		position: fixed;
		right: 1.25rem;
		bottom: 1.25rem;
		z-index: 910;
		display: flex;
		align-items: center;
		gap: 0.75rem;
		background: var(--color-elevated);
		border: 1px solid var(--color-accent-aurum);
		border-radius: 12px;
		padding: 0.7rem 0.9rem;
		box-shadow: 0 16px 44px rgba(0, 0, 0, 0.42), 0 0 0 1px rgba(229, 184, 76, 0.12);
		font-size: 0.85rem;
		color: var(--color-text-primary);
		animation: slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1);
	}

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
