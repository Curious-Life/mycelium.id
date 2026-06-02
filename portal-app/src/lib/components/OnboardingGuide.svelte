<script lang="ts">
	import { browser } from '$app/environment';
	import { onDestroy } from 'svelte';
	import { api } from '$lib/api';

	type StepState = {
		done: boolean;
		provider?: string | null;
		label?: string | null;
		messageCount?: number;
		documentCount?: number;
		enrichedCount?: number;
		enrichmentPending?: number;
		channels?: string[];
	};

	type OnboardingStatus = {
		show: boolean;
		showWelcome: boolean;
		dismissed: boolean;
		allStepsDone: boolean;
		steps: {
			ai: StepState;
			data: StepState;
			messaging: StepState;
		};
		mycelium: {
			generated: boolean;
			territoryPointCount: number;
		};
		aiModelsReady: boolean;
	};

	type JobStatus = {
		id: string;
		status: 'running' | 'done' | 'error' | 'abandoned';
		step: number;
		totalSteps: number;
		stageLabel: string;
		error: string | null;
	};

	let { onDismiss = () => {} }: { onDismiss?: () => void } = $props();

	// --- State ---
	let status = $state<OnboardingStatus | null>(null);
	let loading = $state(true);
	let collapsed = $state(false);
	let activeSection = $state<'ai' | 'data' | 'messaging' | 'generate' | null>(null);
	let errorMsg = $state('');

	// Mycelium generation job state
	let generateJobId = $state<string | null>(null);
	let generateJob = $state<JobStatus | null>(null);
	let generateCooldownSec = $state(0);

	// Enrichment job state (bulk pipeline)
	let enrichmentJobId = $state<string | null>(null);
	let enrichmentJob = $state<JobStatus | null>(null);
	let enrichmentLastCount = $state(0);
	let enrichmentLastTime = $state(0);

	// AI connection sub-state
	let claudeAuthLoading = $state(false);
	let claudeAuthUrl = $state('');
	let claudeAuthCode = $state('');
	let claudeAuthError = $state('');

	// OpenAI device code flow
	let openaiLoading = $state(false);
	let openaiSessionId = $state('');
	let openaiUserCode = $state('');
	let openaiVerifyUrl = $state('');
	let openaiError = $state('');
	let openaiPollTimer: ReturnType<typeof setTimeout> | null = null;

	// Messaging sub-state
	let telegramTokenInput = $state('');
	let telegramIdInput = $state('');
	let discordTokenInput = $state('');
	let integrationSaving = $state(false);
	let integrationSavedTag = $state<string | null>(null);

	// --- Polling ---
	// Adaptive cadence:
	//   fast (3s): any step in progress OR mycelium generation running
	//   normal (15s): idle but onboarding not done
	//   slow (60s): all done, waiting for dismiss
	// Pauses entirely when tab hidden.
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let tabVisible = $state(true);

	function pollCadenceMs(): number {
		if (generateJob?.status === 'running') return 3000;
		if (enrichmentJob?.status === 'running') return 3000;
		if (!status) return 5000;
		if (status.allStepsDone) return 60_000;
		if (status.steps.data.enrichmentPending && status.steps.data.enrichmentPending > 0) return 5000;
		return 15_000;
	}

	async function fetchStatus() {
		try {
			const res = await api('/portal/onboarding/status');
			if (!res.ok) {
				if (res.status === 401) {
					stopPolling();
					return;
				}
				throw new Error(`Status ${res.status}`);
			}
			const data = (await res.json()) as OnboardingStatus;
			status = data;
			loading = false;

			// Auto-detect running enrichment job (e.g., after page reload)
			if (!enrichmentJobId && (data.steps.data.enrichmentPending ?? 0) > 0) {
				try {
					const sRes = await api('/portal/enrichment/status');
					if (sRes.ok) {
						const sData = await sRes.json();
						if (sData.activeJob?.id && sData.activeJob?.status === 'running') {
							enrichmentJobId = sData.activeJob.id;
							enrichmentLastTime = Date.now();
						}
					}
				} catch { /* non-fatal */ }
			}
		} catch (err: any) {
			loading = false;
		}
	}

	async function pollLoop() {
		if (!browser || !tabVisible) return;
		await fetchStatus();
		if (enrichmentJobId) {
			await fetchEnrichmentJob();
		}
		if (generateJobId) {
			await fetchJobStatus();
		}
		if (generateCooldownSec > 0) {
			generateCooldownSec = Math.max(0, generateCooldownSec - Math.ceil(pollCadenceMs() / 1000));
		}
		pollTimer = setTimeout(pollLoop, pollCadenceMs());
	}

	function startPolling() {
		if (pollTimer) return;
		pollLoop();
	}
	function stopPolling() {
		if (pollTimer) {
			clearTimeout(pollTimer);
			pollTimer = null;
		}
	}

	function handleVisibility() {
		tabVisible = !document.hidden;
		if (tabVisible) {
			// Immediate refresh on tab focus
			fetchStatus();
			startPolling();
		} else {
			stopPolling();
		}
	}

	$effect(() => {
		if (!browser) return;
		document.addEventListener('visibilitychange', handleVisibility);
		startPolling();
		return () => {
			document.removeEventListener('visibilitychange', handleVisibility);
			stopPolling();
		};
	});

	onDestroy(() => {
		stopPolling();
		if (openaiPollTimer) clearTimeout(openaiPollTimer);
	});

	// --- Step 1: AI Connection ---

	async function connectOpenAI() {
		openaiLoading = true;
		openaiError = '';
		try {
			const res = await api('/portal/auth/openai', { method: 'POST' });
			if (!res.ok) throw new Error('Failed to start OpenAI login');
			const data = await res.json();
			openaiSessionId = data.sessionId;
			openaiUserCode = data.userCode;
			openaiVerifyUrl = data.verificationUri;
			window.open(data.verificationUri, '_blank');
			pollOpenAI();
		} catch (e: any) {
			openaiError = e.message || 'Connection failed';
		}
		openaiLoading = false;
	}

	async function pollOpenAI() {
		if (!openaiSessionId) return;
		try {
			const res = await api(`/portal/auth/openai/poll/${openaiSessionId}`);
			if (!res.ok) { openaiSessionId = ''; return; }
			const data = await res.json();
			if (data.status === 'done') {
				openaiSessionId = '';
				openaiUserCode = '';
				openaiVerifyUrl = '';
				await fetchStatus();
				activeSection = null;
				return;
			}
			if (data.status === 'expired') {
				openaiError = 'Login expired — try again';
				openaiSessionId = '';
				return;
			}
			if (data.status === 'error') {
				openaiError = data.message || 'Login failed';
				openaiSessionId = '';
				return;
			}
		} catch { /* retry */ }
		openaiPollTimer = setTimeout(pollOpenAI, 5000);
	}

	async function connectClaude() {
		claudeAuthLoading = true;
		claudeAuthError = '';
		claudeAuthUrl = '';
		try {
			const res = await api('/portal/auth/claude', { method: 'POST' });
			if (!res.ok) throw new Error('Failed to start auth');
			const data = await res.json();
			if (data.url) {
				claudeAuthUrl = data.url;
				window.open(data.url, '_blank');
			} else {
				throw new Error('No auth URL returned');
			}
		} catch (e: any) {
			claudeAuthError = e.message || 'Connection failed';
		}
		claudeAuthLoading = false;
	}

	async function submitClaudeCode() {
		claudeAuthLoading = true;
		claudeAuthError = '';
		try {
			const res = await api('/portal/auth/claude/code', {
				method: 'POST',
				body: JSON.stringify({ code: claudeAuthCode.trim() }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(data.error || 'Failed to authenticate');
			claudeAuthUrl = '';
			claudeAuthCode = '';
			// Refresh status immediately
			await fetchStatus();
			activeSection = null;
			// Auto-open chat if agent sent a welcome greeting
			if (data.greeting) {
				const { navigationState } = await import('$lib/stores/navigation');
				setTimeout(() => navigationState.setChatOpen(true), 600);
			}
		} catch (e: any) {
			claudeAuthError = e.message || 'Authentication failed';
		}
		claudeAuthLoading = false;
	}

	// --- Step 3: Messaging ---
	async function saveIntegration(key: string, value: string, scope: string, tag: string) {
		integrationSaving = true;
		integrationSavedTag = null;
		try {
			const res = await api('/portal/settings/secret', {
				method: 'PUT',
				body: JSON.stringify({ key, value: value.trim(), scope }),
			});
			if (!res.ok) throw new Error('Failed to save');
			integrationSavedTag = tag;
			setTimeout(() => {
				integrationSavedTag = null;
			}, 3000);
			if (tag === 'telegram') { telegramTokenInput = ''; telegramIdInput = ''; }
			if (tag === 'discord') discordTokenInput = '';
			await fetchStatus();
		} catch {
			/* swallow — show would need a toast */
		}
		integrationSaving = false;
	}

	// --- Enrichment pipeline ---
	async function startEnrichment() {
		errorMsg = '';
		try {
			const res = await api('/portal/enrichment/trigger', { method: 'POST' });
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				if (data.status === 'already_running' && data.jobId) {
					enrichmentJobId = data.jobId;
					return;
				}
				throw new Error(data.error || 'Failed to start');
			}
			const data = await res.json();
			if (data.jobId) {
				enrichmentJobId = data.jobId;
				enrichmentJob = { id: data.jobId, status: 'running', step: 0, totalSteps: 2, stageLabel: 'Starting…', error: null };
				enrichmentLastCount = 0;
				enrichmentLastTime = Date.now();
				stopPolling();
				startPolling();
			}
		} catch (e: any) {
			errorMsg = e.message || 'Failed to start enrichment';
		}
	}

	async function fetchEnrichmentJob() {
		if (!enrichmentJobId) return;
		try {
			const res = await api(`/portal/enrichment/progress/${enrichmentJobId}`);
			if (!res.ok) { enrichmentJobId = null; return; }
			const data = await res.json();
			enrichmentJob = data;
			if (data.status === 'done' || data.status === 'error' || data.status === 'abandoned') {
				await fetchStatus();
				setTimeout(() => { enrichmentJobId = null; enrichmentJob = null; }, 5000);
			}
		} catch { /* retry next poll */ }
	}

	// Parse "Embedding: 5,432 / 20,000" from stageLabel
	const enrichmentParsed = $derived.by(() => {
		if (!enrichmentJob?.stageLabel) return null;
		const match = enrichmentJob.stageLabel.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
		if (!match) return null;
		const current = parseInt(match[1].replace(/,/g, ''), 10);
		const total = parseInt(match[2].replace(/,/g, ''), 10);
		return { current, total, percent: total > 0 ? Math.round((current / total) * 100) : 0 };
	});

	const enrichmentSpeed = $derived.by(() => {
		if (!enrichmentParsed || !enrichmentLastTime) return 0;
		const elapsed = (Date.now() - enrichmentLastTime) / 1000 / 60;
		if (elapsed < 0.1) return 0;
		return Math.round((enrichmentParsed.current - enrichmentLastCount) / elapsed);
	});

	const enrichmentEta = $derived.by(() => {
		if (!enrichmentParsed || enrichmentSpeed <= 0) return null;
		const remaining = enrichmentParsed.total - enrichmentParsed.current;
		const minutes = Math.round(remaining / enrichmentSpeed);
		if (minutes < 1) return 'less than a minute';
		if (minutes < 60) return `${minutes} min`;
		return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	});

	// --- Step 4: Generate Mycelium ---
	async function startGenerate() {
		errorMsg = '';
		try {
			const res = await api('/portal/mycelium/generate', { method: 'POST' });
			if (res.ok) {
				const data = await res.json();
				generateJobId = data.jobId;
				generateJob = { id: data.jobId, status: 'running', step: 0, totalSteps: 5, stageLabel: 'Starting…', error: null };
				stopPolling();
				startPolling();
				return;
			}
			const body = await res.json().catch(() => ({} as any));
			if (res.status === 409) {
				// The common "clicked too early" case: not enough embedded yet. Show the
				// server's actionable message and AUTO-RETRY — this is NOT a failure.
				errorMsg = body.error || 'Your conversations are still being processed — generation will start automatically.';
				setTimeout(() => { if (!generateJobId) startGenerate(); }, 4000);
				return;
			}
			// 503 / other — surface the REAL reason (keys/pipeline not ready, etc.).
			errorMsg = body.error || 'Couldn’t start generation. Please try again in a moment.';
		} catch (e: any) {
			errorMsg = e?.message || 'Couldn’t reach the server.';
		}
	}

	async function fetchJobStatus() {
		if (!generateJobId) return;
		try {
			const res = await api(`/portal/mycelium/generate/status/${generateJobId}`);
			if (!res.ok) {
				if (res.status === 404) generateJobId = null;
				return;
			}
			generateJob = (await res.json()) as JobStatus;
			if (generateJob.status === 'done') {
				// Done — refresh onboarding status so territory count updates
				await fetchStatus();
				// Keep the "done" state visible for a moment before clearing
				setTimeout(() => {
					generateJobId = null;
					generateJob = null;
				}, 4000);
			} else if (generateJob.status === 'error' || generateJob.status === 'abandoned') {
				errorMsg = generateJob.error || 'Generation failed';
			}
		} catch {
			/* swallow — next poll will retry */
		}
	}

	// --- Dismiss ---
	async function dismiss() {
		try {
			await api('/portal/onboarding/dismiss', { method: 'POST' });
			status = null;
			stopPolling();
			onDismiss();
		} catch {
			/* swallow */
		}
	}

	function toggleSection(section: typeof activeSection) {
		activeSection = activeSection === section ? null : section;
	}

	// Derived
	const completedCount = $derived(
		status ? (+status.steps.ai.done) + (+status.steps.data.done) + (+status.steps.messaging.done) : 0
	);
	const showCard = $derived(status !== null && status.show);
	const showGenerateButton = $derived(
		status !== null && status.allStepsDone && !status.mycelium.generated && !generateJob
	);
	const enrichmentProgress = $derived.by(() => {
		if (!status?.steps.data) return null;
		const { messageCount = 0, enrichedCount = 0 } = status.steps.data;
		if (messageCount === 0) return null;
		return {
			current: enrichedCount,
			total: messageCount,
			percent: Math.round((enrichedCount / messageCount) * 100),
		};
	});
</script>

{#if showCard}
	<div class="guide" class:collapsed>
		<!-- Header -->
		<button class="guide-header" onclick={() => (collapsed = !collapsed)} aria-expanded={!collapsed}>
			<div class="header-icon">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
					<path d="M12 2L12 22 M2 12 L22 12 M5 5 L19 19 M19 5 L5 19" opacity="0.4"/>
					<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>
				</svg>
			</div>
			<div class="header-text">
				<div class="header-title">Grow your Mycelium</div>
				<div class="header-sub">
					{#if status?.allStepsDone}
						Ready to grow &mdash; press the button
					{:else}
						{completedCount} of 3 steps complete
					{/if}
				</div>
			</div>
			<div class="header-progress" aria-hidden="true">
				{#each Array(3) as _, i}
					<span class="progress-dot" class:done={i < completedCount}></span>
				{/each}
			</div>
			<div class="header-toggle" aria-hidden="true">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
					{#if collapsed}
						<polyline points="6 9 12 15 18 9"/>
					{:else}
						<polyline points="18 15 12 9 6 15"/>
					{/if}
				</svg>
			</div>
		</button>

		{#if !collapsed}
			<div class="guide-body">
				<!-- Step 1: Connect AI -->
				<div class="step" class:done={status?.steps.ai.done}>
					<button
						class="step-row"
						onclick={() => toggleSection('ai')}
					>
						<div class="step-check">
							{#if status?.steps.ai.done}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
							{:else}
								<span class="step-num">1</span>
							{/if}
						</div>
						<div class="step-text">
							<div class="step-name">Connect your mind to an AI</div>
							<div class="step-desc">
								{#if status?.steps.ai.done}
									{status.steps.ai.label || status.steps.ai.provider || 'Connected'}
								{:else}
									Claude or another model &mdash; your agent's voice
								{/if}
							</div>
						</div>
						<div class="step-arrow">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({activeSection === 'ai' ? '180deg' : '0deg'}); transition: transform 0.2s;">
								<polyline points="6 9 12 15 18 9" />
							</svg>
						</div>
					</button>

					{#if activeSection === 'ai' && !status?.steps.ai.done}
						<div class="step-expand">
							{#if openaiUserCode}
								<!-- OpenAI device code flow: waiting for user to enter code -->
								<p class="expand-hint">A new tab opened. Enter this code when prompted:</p>
								<div class="device-code-display">
									<span class="device-code">{openaiUserCode}</span>
								</div>
								<p class="expand-hint subtle">Waiting for you to complete login...</p>
								{#if openaiError}
									<p class="expand-error">{openaiError}</p>
								{/if}
							{:else if claudeAuthUrl}
								<p class="expand-hint">A new tab opened. Sign in, copy the code, paste it here.</p>
								<div class="input-row">
									<input
										type="text"
										bind:value={claudeAuthCode}
										placeholder="Paste the code"
										autocomplete="off"
										data-1p-ignore
									/>
									<button
										class="btn-save"
										disabled={!claudeAuthCode || claudeAuthLoading}
										onclick={submitClaudeCode}
									>
										{claudeAuthLoading ? '...' : 'Connect'}
									</button>
								</div>
							{:else}
								<p class="expand-hint">Connect your AI subscription to power your agents.</p>
								<div class="ai-options">
									<button class="btn-primary-inline" disabled={claudeAuthLoading} onclick={connectClaude}>
										{claudeAuthLoading ? 'Starting…' : 'Connect with Claude'}
									</button>
									<button class="btn-primary-inline openai" disabled={openaiLoading} onclick={connectOpenAI}>
										{openaiLoading ? 'Starting…' : 'Connect with ChatGPT'}
									</button>
								</div>
								<p class="expand-hint subtle">ChatGPT requires <a href="https://chatgpt.com/settings/security" target="_blank" rel="noopener">device code auth</a> enabled in your account settings.</p>
							{/if}
							{#if claudeAuthError}
								<p class="expand-error">{claudeAuthError}</p>
							{/if}
							{#if openaiError && !openaiUserCode}
								<p class="expand-error">{openaiError}</p>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Step 2: Upload data -->
				<div class="step" class:done={status?.steps.data.done}>
					<button class="step-row" onclick={() => toggleSection('data')}>
						<div class="step-check">
							{#if status?.steps.data.done}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
							{:else}
								<span class="step-num">2</span>
							{/if}
						</div>
						<div class="step-text">
							<div class="step-name">Bring your past with you</div>
							<div class="step-desc">
								{#if status?.steps.data.done && status.steps.data.messageCount}
									{status.steps.data.messageCount.toLocaleString()} messages in your vault
								{:else if (status?.steps.data.messageCount || 0) > 0}
									{status!.steps.data.messageCount!.toLocaleString()} messages &mdash; keep going
								{:else}
									Import your conversations and notes
								{/if}
							</div>
						</div>
						<div class="step-arrow">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({activeSection === 'data' ? '180deg' : '0deg'}); transition: transform 0.2s;">
								<polyline points="6 9 12 15 18 9" />
							</svg>
						</div>
					</button>

					{#if activeSection === 'data'}
						<div class="step-expand">
							<p class="expand-hint">Bring in what you've already written elsewhere. Your Mycelium grows from what you feed it.</p>
							<div class="sources-grid">
								<div class="source">Claude</div>
								<div class="source">ChatGPT</div>
								<div class="source">Obsidian</div>
								<div class="source">LinkedIn</div>
							</div>
							<a href="/import" class="btn-primary-inline">Go to Import →</a>

							{#if enrichmentJob?.status === 'running' && enrichmentParsed}
								<!-- Active bulk enrichment pipeline -->
								<div class="enrichment">
									<div class="enrichment-phase">
										{enrichmentJob.step === 0 ? 'Embedding your thoughts' : 'Tagging with topics'}
									</div>
									<div class="enrichment-bar">
										<div class="enrichment-fill" style="width: {enrichmentParsed.percent}%"></div>
									</div>
									<div class="enrichment-stats">
										<span><strong>{enrichmentParsed.current.toLocaleString()}</strong> / {enrichmentParsed.total.toLocaleString()}</span>
										{#if enrichmentSpeed > 0}
											<span class="enrichment-meta">{enrichmentSpeed} msg/min</span>
										{/if}
										{#if enrichmentEta}
											<span class="enrichment-meta">~{enrichmentEta}</span>
										{/if}
									</div>
									{#if enrichmentJob.step === 0}
										<div class="enrichment-hint">You can close this &mdash; we'll email you when it's ready</div>
									{:else}
										<div class="enrichment-hint">Your mindscape is ready &mdash; tagging runs in the background</div>
									{/if}
								</div>
							{:else if enrichmentJob?.status === 'done'}
								<div class="enrichment">
									<div class="enrichment-phase">Enrichment complete</div>
									<div class="enrichment-bar"><div class="enrichment-fill" style="width: 100%"></div></div>
								</div>
							{:else if enrichmentProgress && enrichmentProgress.current < enrichmentProgress.total}
								<!-- Idle but pending messages — offer to start -->
								<div class="enrichment">
									<div class="enrichment-label">
										{(enrichmentProgress.total - enrichmentProgress.current).toLocaleString()} messages waiting to be processed
									</div>
									<button class="btn-primary-inline" onclick={startEnrichment}>Start processing</button>
								</div>
							{:else if enrichmentProgress && enrichmentProgress.current >= enrichmentProgress.total && enrichmentProgress.total > 0}
								<div class="enrichment">
									<div class="enrichment-phase">All {enrichmentProgress.total.toLocaleString()} messages enriched</div>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<!-- Step 3: Messaging -->
				<div class="step" class:done={status?.steps.messaging.done}>
					<button class="step-row" onclick={() => toggleSection('messaging')}>
						<div class="step-check">
							{#if status?.steps.messaging.done}
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
							{:else}
								<span class="step-num">3</span>
							{/if}
						</div>
						<div class="step-text">
							<div class="step-name">Let your agent reach you</div>
							<div class="step-desc">
								{#if status?.steps.messaging.done && status.steps.messaging.channels?.length}
									{status.steps.messaging.channels.join(', ')}
								{:else}
									Telegram or Discord &mdash; talk to your agent anywhere
								{/if}
							</div>
						</div>
						<div class="step-arrow">
							<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="transform: rotate({activeSection === 'messaging' ? '180deg' : '0deg'}); transition: transform 0.2s;">
								<polyline points="6 9 12 15 18 9" />
							</svg>
						</div>
					</button>

					{#if activeSection === 'messaging'}
						<div class="step-expand">
							<p class="expand-hint">Set one up now, or come back later.</p>

							<div class="sub-title">Telegram</div>
							<p class="expand-hint-small">
								Open <a href="https://t.me/BotFather" target="_blank" rel="noopener">@BotFather</a>, send <code>/newbot</code>, paste the token below.
							</p>
							<div class="input-row">
								<input type="text" bind:value={telegramTokenInput} placeholder="bot token: 123456:ABC-DEF..." autocomplete="off" data-1p-ignore />
							</div>
							<p class="expand-hint-small" style="margin-top: 0.5rem;">
								Your Telegram user ID — send <code>/start</code> to <a href="https://t.me/userinfobot" target="_blank" rel="noopener">@userinfobot</a> to find it.
							</p>
							<div class="input-row">
								<input type="text" bind:value={telegramIdInput} placeholder="your user id: 123456789" autocomplete="off" data-1p-ignore />
								<button
									class="btn-save"
									disabled={!telegramTokenInput || !telegramIdInput || integrationSaving}
									onclick={async () => {
										integrationSaving = true;
										try {
											await api('/portal/settings/secret', { method: 'PUT', body: JSON.stringify({ key: 'OWNER_TELEGRAM_ID', value: telegramIdInput.trim(), scope: 'personal' }) });
											await saveIntegration('TELEGRAM_BOT_TOKEN', telegramTokenInput, 'personal', 'telegram');
										} catch { integrationSaving = false; }
									}}
								>
									{integrationSaving ? '...' : integrationSavedTag === 'telegram' ? '✓' : 'Save'}
								</button>
							</div>

							<div class="sub-title" style="margin-top: 1rem;">Discord</div>
							<p class="expand-hint-small">
								Open <a href="https://discord.com/developers/applications" target="_blank" rel="noopener">discord.com/developers</a> → New Application → Bot → Reset Token.
							</p>
							<div class="input-row">
								<input type="text" bind:value={discordTokenInput} placeholder="Bot token..." autocomplete="off" data-1p-ignore />
								<button
									class="btn-save"
									disabled={!discordTokenInput || integrationSaving}
									onclick={() => saveIntegration('DISCORD_BOT_TOKEN', discordTokenInput, 'org', 'discord')}
								>
									{integrationSaving ? '...' : integrationSavedTag === 'discord' ? '✓' : 'Save'}
								</button>
							</div>
						</div>
					{/if}
				</div>

				<!-- Step 4: Generate (appears only when all 3 above are done) -->
				{#if status?.allStepsDone}
					<div class="step generate-step" class:done={status.mycelium.generated}>
						<div class="step-row static">
							<div class="step-check ready">
								{#if generateJob?.status === 'done' || status.mycelium.generated}
									<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
								{:else}
									<span class="step-num">★</span>
								{/if}
							</div>
							<div class="step-text">
								<div class="step-name">Grow your Mycelium</div>
								<div class="step-desc">
									{#if generateJob?.status === 'running'}
										{generateJob.stageLabel} &middot; step {generateJob.step} of {generateJob.totalSteps}
									{:else if generateJob?.status === 'done' || status.mycelium.generated}
										Alive with {(status.mycelium.territoryPointCount || 0).toLocaleString()} points
									{:else}
										Weave everything into a living map
									{/if}
								</div>
							</div>
						</div>

						{#if generateJob?.status === 'running'}
							<div class="generate-progress">
								<div class="generate-bar">
									<div
										class="generate-fill"
										style="width: {(generateJob.step / generateJob.totalSteps) * 100}%"
									></div>
								</div>
								<div class="generate-stages">
									{#each Array(generateJob.totalSteps) as _, i}
										<span class="generate-dot" class:done={i < generateJob.step} class:active={i === generateJob.step - 1}></span>
									{/each}
								</div>
								<p class="generate-hint">This takes a few minutes. You can close this — it'll keep running.</p>
							</div>
						{:else if showGenerateButton && status?.aiModelsReady === false}
							<p class="generate-hint" style="color: var(--color-text-secondary);">AI models are downloading on your server. Generation will be available shortly.</p>
						{:else if showGenerateButton}
							<button class="btn-grow" onclick={startGenerate} disabled={generateCooldownSec > 0}>
								{#if generateCooldownSec > 0}
									Wait {Math.ceil(generateCooldownSec / 60)} min
								{:else}
									Grow now →
								{/if}
							</button>
						{/if}

						{#if errorMsg}
							<p class="expand-error">{errorMsg}</p>
						{/if}
					</div>
				{/if}
			</div>

			<div class="guide-footer">
				<button class="btn-dismiss" onclick={dismiss}>
					Dismiss
				</button>
			</div>
		{/if}
	</div>
{/if}

<style>
	.guide {
		position: fixed;
		bottom: 1.5rem;
		right: 1.5rem;
		z-index: 90;
		width: 360px;
		max-width: calc(100vw - 2rem);
		max-height: calc(100vh - 3rem);
		background: var(--color-elevated);
		border: 1px solid var(--color-border);
		border-radius: 14px;
		box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(229, 184, 76, 0.08);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		animation: slideIn 0.5s cubic-bezier(0.16, 1, 0.3, 1);
	}
	.guide.collapsed {
		width: 300px;
	}

	.guide-header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.9rem 1rem;
		background: none;
		border: none;
		border-bottom: 1px solid var(--color-border);
		cursor: pointer;
		font-family: inherit;
		color: inherit;
		text-align: left;
		transition: background 0.2s ease;
	}
	.guide.collapsed .guide-header {
		border-bottom: none;
	}
	.guide-header:hover {
		background: rgba(255, 255, 255, 0.02);
	}

	.header-icon {
		width: 32px;
		height: 32px;
		border-radius: 8px;
		background: rgba(229, 184, 76, 0.1);
		border: 1px solid rgba(229, 184, 76, 0.25);
		color: var(--color-accent-aurum);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.header-text {
		flex: 1;
		min-width: 0;
	}
	.header-title {
		font-family: var(--font-serif, 'Geist', system-ui, sans-serif);
		font-size: 0.92rem;
		font-weight: 500;
		color: var(--color-text-primary);
		line-height: 1.2;
	}
	.header-sub {
		font-size: 0.72rem;
		color: var(--color-text-tertiary, #9898A3);
		margin-top: 2px;
	}

	.header-progress {
		display: flex;
		gap: 4px;
		flex-shrink: 0;
	}
	.progress-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--color-border);
		transition: background 0.3s ease;
	}
	.progress-dot.done {
		background: var(--color-accent-aurum);
	}

	.header-toggle {
		color: var(--color-text-tertiary, #9898A3);
		flex-shrink: 0;
	}

	.guide-body {
		flex: 1;
		overflow-y: auto;
		padding: 0.5rem;
	}

	.step {
		border-radius: 8px;
		transition: background 0.2s ease;
	}
	.step + .step {
		margin-top: 2px;
	}
	.step.done {
		opacity: 0.65;
	}

	.step-row {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		width: 100%;
		padding: 0.7rem 0.75rem;
		background: none;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-family: inherit;
		color: inherit;
		text-align: left;
		transition: background 0.2s ease;
	}
	.step-row:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.03);
	}
	.step-row:disabled {
		cursor: default;
	}
	.step-row.static {
		cursor: default;
	}

	.step-check {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		background: var(--color-bg);
		border: 1.5px solid var(--color-border);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: all 0.3s ease;
	}
	.step.done .step-check {
		background: var(--color-accent-aurum);
		border-color: var(--color-accent-aurum);
		color: var(--color-bg);
	}
	.step-check.ready {
		background: rgba(229, 184, 76, 0.15);
		border-color: var(--color-accent-aurum);
		color: var(--color-accent-aurum);
	}
	.step-num {
		font-size: 0.72rem;
		font-weight: 600;
		color: var(--color-text-tertiary, #9898A3);
		font-family: var(--font-mono, monospace);
	}

	.step-text {
		flex: 1;
		min-width: 0;
	}
	.step-name {
		font-size: 0.82rem;
		font-weight: 500;
		color: var(--color-text-primary);
		line-height: 1.3;
	}
	.step-desc {
		font-size: 0.68rem;
		color: var(--color-text-tertiary, #9898A3);
		margin-top: 2px;
	}

	.step-arrow {
		font-size: 0.7rem;
		color: var(--color-text-tertiary, #9898A3);
		flex-shrink: 0;
	}

	.step-expand {
		padding: 0.2rem 0.85rem 0.85rem 2.6rem;
		font-size: 0.76rem;
	}

	.expand-hint {
		font-size: 0.74rem;
		color: var(--color-text-tertiary, #9898A3);
		line-height: 1.5;
		margin-bottom: 0.6rem;
	}
	.expand-hint-small {
		font-size: 0.7rem;
		color: var(--color-text-tertiary, #9898A3);
		line-height: 1.5;
		margin-bottom: 0.4rem;
	}
	.expand-hint :global(a),
	.expand-hint-small :global(a) {
		color: var(--color-accent-aurum);
	}
	.expand-hint-small :global(code) {
		font-family: var(--font-mono, monospace);
		font-size: 0.68rem;
		background: var(--color-bg);
		padding: 1px 5px;
		border-radius: 3px;
	}
	.expand-error {
		font-size: 0.7rem;
		color: #f87171;
		margin-top: 0.5rem;
	}

	.sub-title {
		font-size: 0.7rem;
		font-weight: 600;
		color: var(--color-text-primary);
		margin-bottom: 0.35rem;
	}

	.input-row {
		display: flex;
		gap: 0.4rem;
	}
	.input-row input {
		flex: 1;
		padding: 0.4rem 0.6rem;
		font-size: 0.72rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 6px;
		color: var(--color-text-primary);
		font-family: var(--font-mono, monospace);
		outline: none;
		min-width: 0;
	}
	.input-row input:focus {
		border-color: var(--color-accent-aurum);
	}

	.btn-save,
	.btn-primary-inline {
		padding: 0.4rem 0.9rem;
		background: var(--color-accent-aurum);
		color: var(--color-bg);
		border: none;
		border-radius: 6px;
		font-size: 0.72rem;
		font-weight: 500;
		cursor: pointer;
		font-family: inherit;
		white-space: nowrap;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.3rem;
		transition: transform 0.15s ease;
	}
	.btn-save:hover:not(:disabled),
	.btn-primary-inline:hover {
		transform: translateY(-1px);
	}
	.btn-save:disabled {
		opacity: 0.5;
		cursor: default;
		transform: none;
	}
	.btn-primary-inline {
		margin-top: 0.2rem;
	}
	.btn-primary-inline.openai {
		background: rgba(255, 255, 255, 0.08);
		color: var(--color-text-primary);
		border: 1px solid var(--color-border);
	}
	.btn-primary-inline.openai:hover {
		background: rgba(255, 255, 255, 0.12);
		border-color: var(--color-text-secondary);
	}
	.ai-options {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.expand-hint.subtle {
		font-size: 0.62rem;
		color: var(--color-text-tertiary);
		margin-top: 0.4rem;
	}
	.expand-hint.subtle :global(a) {
		color: var(--color-accent-aurum);
	}
	.device-code-display {
		display: flex;
		justify-content: center;
		padding: 0.75rem;
		margin: 0.5rem 0;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 8px;
	}
	.device-code {
		font-family: var(--font-mono);
		font-size: 1.2rem;
		font-weight: 600;
		letter-spacing: 0.15em;
		color: var(--color-accent-aurum);
	}

	.sources-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 4px;
		margin-bottom: 0.75rem;
	}
	.source {
		font-size: 0.7rem;
		padding: 0.35rem 0.6rem;
		background: var(--color-bg);
		border: 1px solid var(--color-border);
		border-radius: 5px;
		color: var(--color-text-secondary, #c4c4cc);
		text-align: center;
	}

	.enrichment {
		margin-top: 0.9rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--color-border);
	}
	.enrichment-label {
		font-size: 0.7rem;
		color: var(--color-text-secondary, #c4c4cc);
		margin-bottom: 0.4rem;
	}
	.enrichment-phase {
		font-size: 0.72rem;
		font-weight: 500;
		color: var(--color-text-primary, #e0e0e4);
		margin-bottom: 0.4rem;
	}
	.enrichment-stats {
		display: flex;
		gap: 0.75rem;
		font-size: 0.68rem;
		color: var(--color-text-secondary, #c4c4cc);
		margin-bottom: 0.3rem;
	}
	.enrichment-stats strong {
		color: var(--color-accent-aurum);
	}
	.enrichment-meta {
		color: var(--color-text-tertiary, #9898A3);
	}
	.enrichment-bar {
		height: 4px;
		background: var(--color-bg);
		border-radius: 2px;
		overflow: hidden;
		margin-bottom: 0.35rem;
	}
	.enrichment-fill {
		height: 100%;
		background: linear-gradient(90deg, #E5B84C, #D4A23C);
		transition: width 0.5s ease;
	}
	.enrichment-hint {
		font-size: 0.65rem;
		color: var(--color-text-tertiary, #9898A3);
	}

	.generate-step {
		margin-top: 6px;
		padding-top: 6px;
		border-top: 1px solid var(--color-border);
	}

	.btn-grow {
		margin: 0.6rem 0.75rem 0.85rem 2.6rem;
		padding: 0.55rem 1.1rem;
		background: linear-gradient(135deg, var(--color-accent-aurum), #D4A23C);
		color: var(--color-bg);
		border: none;
		border-radius: 8px;
		font-size: 0.8rem;
		font-weight: 600;
		cursor: pointer;
		font-family: inherit;
		transition: transform 0.2s ease, box-shadow 0.2s ease;
		box-shadow: 0 4px 16px rgba(229, 184, 76, 0.2);
	}
	.btn-grow:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 6px 20px rgba(229, 184, 76, 0.35);
	}
	.btn-grow:disabled {
		opacity: 0.6;
		cursor: default;
		transform: none;
	}

	.generate-progress {
		padding: 0.4rem 0.85rem 0.85rem 2.6rem;
	}
	.generate-bar {
		height: 5px;
		background: var(--color-bg);
		border-radius: 3px;
		overflow: hidden;
		margin-bottom: 0.5rem;
	}
	.generate-fill {
		height: 100%;
		background: linear-gradient(90deg, #E5B84C, #D4A23C);
		transition: width 0.8s ease;
	}
	.generate-stages {
		display: flex;
		gap: 4px;
		margin-bottom: 0.5rem;
	}
	.generate-dot {
		flex: 1;
		height: 3px;
		background: var(--color-border);
		border-radius: 2px;
		transition: all 0.3s ease;
	}
	.generate-dot.done {
		background: var(--color-accent-aurum);
	}
	.generate-dot.active {
		background: var(--color-accent-aurum);
		animation: pulse 1.5s ease-in-out infinite;
	}
	.generate-hint {
		font-size: 0.66rem;
		color: var(--color-text-tertiary, #9898A3);
		line-height: 1.4;
	}

	.guide-footer {
		padding: 0.6rem 1rem 0.75rem;
		border-top: 1px solid var(--color-border);
		display: flex;
		justify-content: flex-end;
	}
	.btn-dismiss {
		background: none;
		border: none;
		color: var(--color-text-tertiary, #9898A3);
		font-family: inherit;
		font-size: 0.7rem;
		cursor: pointer;
		padding: 4px 8px;
		border-radius: 4px;
		transition: color 0.2s ease;
	}
	.btn-dismiss:hover {
		color: var(--color-text-primary);
	}

	@keyframes slideIn {
		from {
			opacity: 0;
			transform: translateY(20px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@keyframes pulse {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	@media (max-width: 640px) {
		.guide {
			bottom: 1rem;
			right: 1rem;
			left: 1rem;
			width: auto;
		}
		.guide.collapsed {
			width: auto;
		}
	}
</style>
